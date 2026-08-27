/**
 * EASY 모드 화면.
 *
 * 좌: 프리셋 갤러리 / 중앙: 캔버스 / 우: 빠른 설정.
 * 타임라인이 없다. 인스펙터도 없다. 그게 EASY 다.
 *
 * EASY 와 PRO 의 관계
 *
 * 두 모드는 같은 문서를 본다. EASY 는 PRO 데이터의 축약 뷰일 뿐 별도 저장 포맷이
 * 아니다. 그래서 이 화면은 자기만의 상태를 만들지 않고 useDocumentStore 와
 * usePresetUiStore 를 그대로 읽고 쓴다.
 *
 *   EASY -> PRO   항상 무손실. 프리셋이 만든 키프레임이 그대로 펼쳐진다.
 *   PRO -> EASY   표현 불가한 편집이 있으면(presetRef.dirty) 배너 + 슬라이더 비활성 +
 *                 [프리셋으로 리셋]. 절대 데이터를 버리지 않는다.
 *
 * 강도/속도 슬라이더는 presetUi 의 공통 노브를 움직이면서 실시간으로 현재
 * 프리셋을 다시 적용한다 (reapplyAppliedPresetSoon, 140ms 간격). 매 onChange 마다
 * 통째로 적용하면 emit + 담기 솔버가 입력 주기로 돌아 드래그가 버벅이므로 짧게
 * 묶고, 손을 떼는 순간(commitMacroNow) 마지막 값을 확정한다. applyPresetTracks 의
 * coalesce(500ms) 덕에 드래그 한 번이 실행취소 한 칸이다.
 *
 * dirty 일 때는 속도까지 잠근다. 프리셋 재적용은 프리셋이 소유한 트랙을 갈아끼우므로
 * PRO 에서 손본 값이 사라진다. 강도만 잠그는 선택지도 있지만,
 * "절대 데이터를 버리지 마라" 가 더 강한 요구다. 되돌릴 길은 [프리셋으로 리셋] 하나뿐이고
 * 그 버튼은 사용자가 직접 눌러야 한다.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  CANVAS_MAX,
  FRAMES_MAX,
  MOTION_REPEAT_MAX,
  type BackgroundType,
  type LoopMode,
} from '@/core/types.ts'
import { importImageFile, toErrorMessage } from '@/imageprep/index.ts'
import { EASY_PRESETS } from '@/motions/registry.ts'
import { ALL_MOTION_PARTS } from '@/motions/transfer.ts'
import { baselineFps, baselineSec, fpsForDuration } from '@/motions/apply.ts'
import { useDocumentStore } from '@/state/document.ts'
import {
  applyPresetToDocument,
  commitMacroNow,
  reapplyAppliedPresetSoon,
  resolveTargetLayerId,
} from '@/state/presetActions.ts'
import { useLayerUiStore } from '@/state/layerUi.ts'
import { MAX_COMPARE, usePresetUiStore } from '@/state/presetUi.ts'
import { SPEED_STEP, formatDurationSec, pFromSpeed, speedFromP } from '@/state/speedScale.ts'
import { useUiStore } from '@/state/ui.ts'
import { PreviewCanvas } from '@/ui/canvas/PreviewCanvas.tsx'
import { ExportDialog } from '@/ui/export/ExportDialog.tsx'
import { CreatorTabs } from '@/ui/shapes/CreatorTabs.tsx'
import { FRAME_FIT_OPTIONS, frameFitOf, setFrameFit } from '@/ui/layers/layerDocActions.ts'
import { ReplaceImageButton } from '@/ui/layers/ReplaceImageButton.tsx'
import { AnchorGrid, anchorLabelOf } from '@/ui/widgets/AnchorGrid.tsx'
import {
  restoreAssetOriginal,
  trimAssetMargins,
  type CanvasSize,
} from '@/ui/prep/trimAsset.ts'

import { Onboarding } from './Onboarding.tsx'
import { QuickCrop } from './QuickCrop.tsx'
import { QuickExport } from './QuickExport.tsx'

import './easy.css'

// ---------------------------------------------------------------------------
// 선택지
// ---------------------------------------------------------------------------

/**
 * 긴 변 기준. EASY 는 숫자를 고민하게 만들지 않는다.
 *
 * 1024 위로는 간격을 크게 벌린다. 2000 과 2048 을 나란히 보여 줘 봐야 고를 근거가
 * 없다. 큰 값은 인쇄나 대형 배경처럼 목적이 분명한 사람만 고른다.
 * CANVAS_MAX 를 넘는 항목은 아래에서 걸러진다.
 */
const SIZE_CHOICES = [256, 384, 512, 768, 1024, 1536, 2048, 3000, 4000] as const

/** 이 크기를 넘으면 만드는 데 오래 걸리고 파일도 커진다. 고르기 전에 알린다. */
const HEAVY_SIZE_PX = 1536

/** 기본 내보내기(투명 스티커)의 긴 변 상한. 이 위로는 줄여서 나간다. */
const STICKER_MAX_PX = 512

/** loopWithHold 는 EASY 에 없다. PRO 에서 고른 값이면 라디오가 아무것도 안 고른 상태가 된다. */
const LOOP_OPTIONS: readonly { mode: LoopMode; label: string }[] = [
  { mode: 'once', label: '한 번만' },
  { mode: 'loop', label: '계속 반복' },
  { mode: 'pingPong', label: '갔다 왔다' },
]

type EasyBackground = 'alpha' | 'white' | 'black' | 'custom'

const WHITE = '#ffffffff'
const BLACK = '#000000ff'

const BACKGROUND_OPTIONS: readonly { value: EasyBackground; label: string }[] = [
  { value: 'alpha', label: '투명' },
  { value: 'white', label: '흰색' },
  { value: 'black', label: '검정' },
  { value: 'custom', label: '직접 고르기' },
]

/**
 * 문서의 배경을 EASY 의 4지선다로 되읽는다.
 * blurExtend / mirror 는 아직 어느 화면에서도 만들 수 없다(렌더러 미구현). 들어오면
 * '직접 고르기' 로 읽히지만 색을 바꾸기 전까지 문서 값은 그대로 남는다.
 */
function readBackground(type: BackgroundType, color: string): EasyBackground {
  if (type === 'alpha') return 'alpha'
  const c = color.toLowerCase()
  if (c === WHITE || c === '#ffffff') return 'white'
  if (c === BLACK || c === '#000000') return 'black'
  return 'custom'
}

// ---------------------------------------------------------------------------
// 아이콘
// ---------------------------------------------------------------------------

function IconReplay() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false">
      <path
        d="M13 8a5 5 0 1 1-1.6-3.66"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <path
        d="M13.2 2.4v2.9h-2.9"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function IconSwap() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false">
      <path d="M2.5 5.5h9l-2-2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M13.5 10.5h-9l2 2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

// ---------------------------------------------------------------------------
// EASY 모드
// ---------------------------------------------------------------------------

/**
 * EASY 의 배수 선택지.
 *
 * PRO 와 같은 목록이다 (ui/inspector/MotionTransferSection.tsx). 같은 값을 두 곳에
 * 적는 대신 목록 자체를 옮기지 않는 이유는, EASY 가 UI 컴포넌트를 서로 import 하지
 * 않는 구조라서다. 값이 일곱 개뿐이고 상한은 상수를 공유한다.
 */
const EASY_REPEAT_CHOICES = [1, 2, 3, 4, 6, 8, MOTION_REPEAT_MAX] as const

export interface EasyModeProps {
  /**
   * 상단 줄(이미지 바꾸기)을 EasyMode 가 직접 그릴지.
   * 셸 툴바를 위에 두는 통합이라면 false 로 준다. 기본은 true(단독 화면).
   */
  showHeader?: boolean
  /**
   * "다른 설정으로" 가 열 전체 내보내기 다이얼로그.
   * 주지 않으면 EasyMode 가 자기 것을 하나 들고 연다. App 이 이미 ExportDialog 를
   * 그리고 있다면 반드시 넘겨라. 두 개가 동시에 열리면 GL 예산을 나눠 쓴다.
   */
  onOpenExportSettings?: () => void
}

export function EasyMode({ showHeader = true, onOpenExportSettings }: EasyModeProps) {
  const doc = useDocumentStore((s) => s.doc)
  const setLoopMode = useDocumentStore((s) => s.setLoopMode)
  const setCanvasSize = useDocumentStore((s) => s.setCanvasSize)
  const setLayerAnchor = useDocumentStore((s) => s.setLayerAnchor)
  const setLayerMotionRepeat = useDocumentStore((s) => s.setLayerMotionRepeat)
  const transferMotion = useDocumentStore((s) => s.transferMotion)
  const setBackgroundType = useDocumentStore((s) => s.setBackgroundType)
  const setBackgroundColor = useDocumentStore((s) => s.setBackgroundColor)

  const setMode = useUiStore((s) => s.setMode)

  const strength = usePresetUiStore((s) => s.strength)
  const speed = usePresetUiStore((s) => s.speed)
  const appliedId = usePresetUiStore((s) => s.appliedId)
  const compareIds = usePresetUiStore((s) => s.compareIds)
  const setStrength = usePresetUiStore((s) => s.setStrength)
  const setSpeed = usePresetUiStore((s) => s.setSpeed)
  const toggleCompare = usePresetUiStore((s) => s.toggleCompare)
  const clearCompare = usePresetUiStore((s) => s.clearCompare)

  const [notice, setNotice] = useState<string | null>(null)
  const [swapping, setSwapping] = useState(false)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [restartToken, setRestartToken] = useState(0)

  const fileRef = useRef<HTMLInputElement | null>(null)
  const aliveRef = useRef(true)

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  const hasImage = doc.layers.length > 0
  /*
   * 슬라이더 옆에 보여 줄 재생 시간.
   *
   * 문서의 durationFrames 를 그대로 읽으면 안 된다. 그 값은 손을 뗀 뒤에만 갱신되므로
   * 드래그하는 동안 숫자가 멈춰 있어 "안 먹는다" 로 읽힌다. 기준선에서 직접 계산해
   * 손잡이를 따라 즉시 움직이게 한다. 프레임 상한 때문에 fps 가 내려가는 것까지
   * 같은 함수로 반영해야 표시값과 결과가 갈리지 않는다.
   */
  const previewSec = useMemo(() => {
    const baseSec = baselineSec(doc)
    const target = baseSec / speed
    const fps = fpsForDuration(target, baselineFps(doc))
    return Math.min(FRAMES_MAX, Math.round(target * fps)) / fps
  }, [doc, speed])
  /** 더 느리게 내려도 길이가 안 늘어나는 지점인가. 사각지대를 숫자로 알린다. */
  const atSlowLimit = useMemo(() => {
    const baseSec = baselineSec(doc)
    const target = baseSec / speed
    const fps = fpsForDuration(target, baselineFps(doc))
    return Math.round(target * fps) >= FRAMES_MAX
  }, [doc, speed])
  // 프리셋을 적용하는 대상과 같은 레이어여야 한다. 둘이 갈라지면 슬라이더가 다른 그림을 건드린다.
  const targetLayerId = resolveTargetLayerId()
  const targetLayer = targetLayerId ? doc.layers.find((l) => l.id === targetLayerId) : undefined
  const frameFit = targetLayer ? frameFitOf(targetLayer) : 'contain'
  // 한 바퀴는 최소 두 프레임이다. 그보다 잘게 쪼개면 정수 프레임 격자에서 뭉개진다.
  const repeatCap = Math.floor(doc.timeline.durationFrames / 2)
  const presetRef = doc.presetRef
  const dirty = presetRef?.dirty === true

  // -------------------------------------------------------------------------
  // 문서 -> 공통 노브 동기화
  // -------------------------------------------------------------------------

  /*
   * 저장된 프로젝트를 열거나 PRO 에서 넘어오면 presetUi 는 초기값이고 문서에는 진짜
   * macro 가 들어 있다. 이때는 문서가 진실이다. 슬라이더가 0.5 를 가리키는데 실제
   * 모션이 다르면 사용자는 슬라이더를 한 번 흔들어야 하고 그 순간 모션이 튄다.
   */
  useEffect(() => {
    if (!presetRef) return
    const ui = usePresetUiStore.getState()
    if (ui.appliedId === presetRef.id) return
    ui.setStrength(presetRef.macro.strength)
    ui.setSpeed(presetRef.macro.speed)
    ui.markApplied(presetRef.id)
  }, [presetRef])

  /**
   * 슬라이더에서 손을 뗀 시점의 확정 커밋. 드래그 중에는 reapplyAppliedPresetSoon 이
   * 실시간으로 적용하고 있으므로, 여기는 대기 중인 재적용을 마지막 값으로 확정하는
   * 역할이다. 문서가 이미 노브와 같으면 아무것도 하지 않는다.
   */
  const commitMacro = useCallback(() => {
    const report = commitMacroNow()
    if (!report) return
    setNotice(report.ok ? report.message : (report.message ?? '모션을 다시 적용하지 못했습니다.'))
  }, [])

  // -------------------------------------------------------------------------
  // 다시 재생
  // -------------------------------------------------------------------------

  /*
   * 재생을 처음부터 다시 돌리려면 세 가지가 이 순서로 일어나야 한다.
   *   1. playing 을 내린다
   *   2. useRenderer 가 그 사실을 반영한다 (playingRef = false)
   *   3. playheadFrame 을 0 으로 되돌리고 다시 재생한다
   *
   * 한 함수 안에서 세 setter 를 연달아 부르면 2번이 일어나지 않는다. useRenderer 의
   * 스토어 구독이 playingRef 를 보고 스크럽을 무시하기 때문이다. 그래서 토큰을 하나
   * 올려 커밋을 한 번 강제하고, 그 다음 커밋의 이펙트에서 3번을 한다. 자식(PreviewCanvas)
   * 의 이펙트가 부모보다 먼저 도는 React 의 순서가 2번을 보장한다.
   */
  const replay = useCallback(() => {
    useUiStore.getState().setPlaying(false)
    setRestartToken((n) => n + 1)
  }, [])

  useEffect(() => {
    if (restartToken === 0) return
    const ui = useUiStore.getState()
    ui.setPlayheadFrame(0)
    ui.setPlaying(true)
  }, [restartToken])

  // -------------------------------------------------------------------------
  // 비교 모드
  // -------------------------------------------------------------------------

  const comparing = compareIds.length > 0

  const toggleCompareMode = useCallback(() => {
    if (usePresetUiStore.getState().compareIds.length > 0) {
      clearCompare()
      return
    }
    // 비어 있는 비교 모드는 고장 난 체크박스로 보인다. 지금 고른 것부터 채운다.
    const seed: string[] = []
    const applied = usePresetUiStore.getState().appliedId
    if (applied) seed.push(applied)
    for (const preset of EASY_PRESETS) {
      if (seed.length >= MAX_COMPARE) break
      if (!seed.includes(preset.id)) seed.push(preset.id)
    }
    for (const id of seed) toggleCompare(id)
  }, [clearCompare, toggleCompare])

  // -------------------------------------------------------------------------
  // 이미지 바꾸기
  // -------------------------------------------------------------------------

  /**
   * 기존 레이어를 먼저 지우고 새 이미지를 넣는다. 그래야 새 이미지가 첫 레이어가 되어
   * 캔버스가 그 비율을 따라간다. 순서를 뒤집으면 옛 이미지의 비율이 남는다.
   * 지운 뒤에는 고르고 있던 모션을 다시 얹는다. 이미지를 바꿨다고 모션까지 사라지면
   * 스티커 세트를 만드는 흐름이 매번 끊긴다.
   */
  const replaceImage = useCallback((file: File) => {
    setSwapping(true)
    setNotice(null)
    importImageFile(file)
      .then((imported) => {
        const store = useDocumentStore.getState()
        for (const layer of [...store.doc.layers]) {
          useDocumentStore.getState().removeLayer(layer.id)
        }
        const { layerId } = useDocumentStore.getState().addImage({
          name: imported.name,
          bitmap: imported.bitmap,
          hasAlpha: imported.hasAlpha,
        })
        // 선택의 정본은 layerUi 다 (state/layerUi.ts 머리말).
        useLayerUiStore.getState().setSelectedLayerIds([layerId], layerId)

        const applied = usePresetUiStore.getState().appliedId
        if (applied) applyPresetToDocument(applied)
        if (aliveRef.current && imported.warning) setNotice(imported.warning)
      })
      .catch((err: unknown) => {
        if (!aliveRef.current) return
        setNotice(`${file.name || '이미지'}: ${toErrorMessage(err)}`)
      })
      .finally(() => {
        if (aliveRef.current) setSwapping(false)
      })
  }, [])

  // -------------------------------------------------------------------------
  // 여백 잘라내기
  // -------------------------------------------------------------------------

  /**
   * 자르기 전 캔버스 크기. 되돌리기 버튼을 띄우는 조건이기도 하다.
   * updateAssetPrep 은 히스토리에 안 쌓이므로 Ctrl+Z 로는 픽셀이 안 돌아온다.
   */
  const [trimUndo, setTrimUndo] = useState<CanvasSize | null>(null)
  const [trimming, setTrimming] = useState(false)
  /** 자유 자르기 다이얼로그. 영역을 직접 끌어 정한다. */
  const [cropOpen, setCropOpen] = useState(false)

  const firstAssetId = doc.assets[0]?.id ?? null

  const handleTrim = useCallback(() => {
    const assetId = useDocumentStore.getState().doc.assets[0]?.id
    if (!assetId) return
    setTrimming(true)
    setNotice(null)
    trimAssetMargins(assetId)
      .then((result) => {
        if (!aliveRef.current) return
        if (!result.trimmed) {
          setNotice('잘라낼 여백을 찾지 못했습니다. 가장자리까지 그림이 차 있습니다.')
          return
        }
        setTrimUndo(result.previousCanvas)
        setNotice(`여백을 잘라 ${result.canvas.w} x ${result.canvas.h} 로 맞췄습니다.`)
      })
      .catch((err: unknown) => {
        if (aliveRef.current) setNotice(toErrorMessage(err))
      })
      .finally(() => {
        if (aliveRef.current) setTrimming(false)
      })
  }, [])

  const handleTrimUndo = useCallback(() => {
    const assetId = useDocumentStore.getState().doc.assets[0]?.id
    if (!assetId) return
    const canvas = trimUndo
    setTrimming(true)
    restoreAssetOriginal(assetId, canvas ?? undefined)
      .then(() => {
        if (!aliveRef.current) return
        setTrimUndo(null)
        setNotice('원래 이미지로 되돌렸습니다.')
      })
      .catch((err: unknown) => {
        if (aliveRef.current) setNotice(toErrorMessage(err))
      })
      .finally(() => {
        if (aliveRef.current) setTrimming(false)
      })
  }, [trimUndo])

  // -------------------------------------------------------------------------
  // 크기 / 배경
  // -------------------------------------------------------------------------

  const longestEdge = Math.max(doc.canvas.w, doc.canvas.h)

  const sizeOptions = useMemo(() => {
    const set = new Set<number>(SIZE_CHOICES.filter((n) => n <= CANVAS_MAX))
    // 지금 값이 목록에 없으면(PRO 에서 바꿨거나 이미지 비율 때문에) 그 값도 넣는다.
    // 안 넣으면 select 가 아무것도 안 고른 상태가 되어 값이 사라진 것처럼 보인다.
    set.add(longestEdge)
    return [...set].sort((a, b) => a - b)
  }, [longestEdge])

  const setLongestEdge = (next: number): void => {
    if (next === longestEdge || longestEdge <= 0) return
    const scale = next / longestEdge
    // 여기서 고르는 것은 결과물 해상도다. 그림도 같이 커지고 작아져야 한다.
    // 캔버스만 바꾸면 그림은 제자리에 남아 잘리거나 가운데 작게 뜬다.
    setCanvasSize(Math.round(doc.canvas.w * scale), Math.round(doc.canvas.h * scale), {
      scaleContent: true,
    })
  }

  /*
   * '직접 고르기' 는 문서에 남는 상태가 아니다.
   *
   * 배경은 문서에 type + color 두 값으로만 있고, 셀렉트의 값은 그것을 되읽은
   * 파생값이다(readBackground). 그런데 '직접 고르기' 를 골라도 색이 그대로면
   * 되읽기가 여전히 '흰색' 이나 '검정' 을 내서 셀렉트가 곧바로 튕겨 돌아왔다.
   * 쓰기와 읽기가 같은 4지선다를 다른 규칙으로 계산한 것이다.
   *
   * 그래서 "사용자가 직접 고르기를 눌렀다" 는 사실만 화면 상태로 들고 있는다.
   * 문서에는 아무것도 더 넣지 않는다. 다른 항목을 고르거나 투명으로 가면 놓는다.
   */
  const [pickingColor, setPickingColor] = useState(false)
  const colorInputRef = useRef<HTMLInputElement | null>(null)

  const documentBackground = readBackground(
    doc.canvas.background.type,
    doc.canvas.background.color,
  )
  const background: EasyBackground =
    pickingColor && documentBackground !== 'alpha' ? 'custom' : documentBackground

  const setBackground = (next: EasyBackground): void => {
    setPickingColor(next === 'custom')
    if (next === 'alpha') {
      setBackgroundType('alpha')
      return
    }
    setBackgroundType('solid')
    if (next === 'white') setBackgroundColor(WHITE)
    else if (next === 'black') setBackgroundColor(BLACK)
    // 고른 직후 바로 색을 집을 수 있게 한다. 이 항목의 목적이 그것 하나다.
    else colorInputRef.current?.click()
  }

  // -------------------------------------------------------------------------
  // 내보내기 설정 다이얼로그
  // -------------------------------------------------------------------------

  const openExportSettings = useCallback(() => {
    if (onOpenExportSettings) onOpenExportSettings()
    else setDialogOpen(true)
  }, [onOpenExportSettings])

  // -------------------------------------------------------------------------
  // STEP 0
  // -------------------------------------------------------------------------

  if (!hasImage) {
    return (
      <div className="mm-easy is-onboarding">
        <div className="mm-easy-center">
          <Onboarding />
        </div>
      </div>
    )
  }

  // -------------------------------------------------------------------------
  // STEP 1 / 2
  // -------------------------------------------------------------------------

  return (
    <div className="mm-easy">
      {showHeader ? (
        <div className="mm-easy-head">
          <button
            type="button"
            className="mm-btn"
            disabled={swapping}
            onClick={() => fileRef.current?.click()}
          >
            <IconSwap />
            이미지 바꾸기
          </button>
          <input
            ref={fileRef}
            type="file"
            className="mm-visually-hidden"
            accept="image/png,image/jpeg,image/webp,image/gif,image/bmp,image/avif"
            tabIndex={-1}
            aria-hidden="true"
            onChange={(e) => {
              const file = e.target.files?.[0]
              e.target.value = ''
              if (file) replaceImage(file)
            }}
          />
          <span className="mm-easy-head-spacer" />
          <span className="mm-easy-note">
            끌어다 놓거나 Ctrl+V 로 붙여넣어도 바뀝니다
          </span>
        </div>
      ) : null}

      {/* 좌: 모션 / 도형 탭. EASY 필터(16종 + 변형 더 보기)는 갤러리가 mode 를 보고 한다. */}
      <div className="mm-easy-left">
        <CreatorTabs />
      </div>

      {/* 중앙: 캔버스. 타임라인 없음. */}
      <div className="mm-easy-center">
        <div className="mm-easy-stage">
          <PreviewCanvas />
        </div>

        <div className="mm-easy-actions">
          <button type="button" className="mm-btn" onClick={replay}>
            <IconReplay />
            다시 재생
          </button>

          <label className="mm-easy-check">
            <input
              type="checkbox"
              className="mm-checkbox"
              checked={comparing}
              onChange={toggleCompareMode}
            />
            비교 모드 ({MAX_COMPARE}개)
          </label>
          <span className="mm-easy-check-hint">
            {comparing ? '왼쪽 목록 맨 위에서 함께 재생됩니다' : '여러 모션을 나란히 재생합니다'}
          </span>
        </div>

        <div className="mm-easy-export-dock">
          <QuickExport onOpenSettings={openExportSettings} />
        </div>
      </div>

      {/* 우: 빠른 설정 */}
      <aside className="mm-easy-right" aria-label="빠른 설정">
        <h2 className="mm-section-title">빠른 설정</h2>

        {dirty ? (
          <div className="mm-easy-banner" role="status">
            <span>
              세밀하게 손본 부분이 있어서 슬라이더로는 되돌릴 수 없습니다. 편집한 내용은 그대로
              남아 있습니다.
            </span>
            <button
              type="button"
              className="mm-btn"
              onClick={() => {
                const id = presetRef?.id
                if (!id) return
                const report = applyPresetToDocument(id)
                setNotice(
                  report.ok
                    ? '프리셋 기본값으로 되돌렸습니다. Ctrl+Z 로 취소할 수 있습니다.'
                    : (report.message ?? '되돌리지 못했습니다.'),
                )
              }}
            >
              프리셋으로 리셋
            </button>
          </div>
        ) : null}

        <div className="mm-easy-group">
          <label className="mm-field-label" htmlFor="mm-easy-speed">
            속도
          </label>
          <input
            id="mm-easy-speed"
            type="range"
            className="mm-easy-slider"
            /*
             * 손잡이 자리는 로그 눈금이다. 0.1 ~ 2 를 선형으로 펴면 왼쪽 끝에서
             * 1px 이 몇 초를 뛰고 오른쪽에서는 아무 일도 안 일어난다.
             * 진실은 speed 이고 p 는 표시용 좌표라 저장하지 않는다.
             */
            min={0}
            max={1}
            step={SPEED_STEP}
            value={pFromSpeed(speed)}
            disabled={dirty}
            aria-valuetext={`${formatDurationSec(previewSec)}, ${speed.toFixed(2)}배`}
            onChange={(e) => {
              setSpeed(speedFromP(Number(e.target.value)))
              // 프리셋을 다시 클릭하지 않아도 드래그를 따라 실시간 적용된다.
              reapplyAppliedPresetSoon()
            }}
            onPointerUp={commitMacro}
            onKeyUp={commitMacro}
            onBlur={commitMacro}
          />
          <div className="mm-easy-ends" aria-hidden="true">
            <span>느리게</span>
            <span>빠르게</span>
          </div>
          <p className="mm-easy-note" role="status">
            재생 시간 {formatDurationSec(previewSec)}
            {atSlowLimit ? ' (이 모션에서 낼 수 있는 가장 긴 길이입니다)' : ''}
          </p>
        </div>

        <div className="mm-easy-group">
          <label className="mm-field-label" htmlFor="mm-easy-strength">
            세기
          </label>
          <input
            id="mm-easy-strength"
            type="range"
            className="mm-easy-slider"
            min={0}
            max={1}
            step={0.05}
            value={strength}
            disabled={dirty}
            onChange={(e) => {
              setStrength(Number(e.target.value))
              reapplyAppliedPresetSoon()
            }}
            onPointerUp={commitMacro}
            onKeyUp={commitMacro}
            onBlur={commitMacro}
          />
          <div className="mm-easy-ends" aria-hidden="true">
            <span>약하게</span>
            <span>강하게</span>
          </div>
          {appliedId === null ? (
            <p className="mm-easy-note">왼쪽에서 움직임을 먼저 고르면 여기서 조절할 수 있어요.</p>
          ) : null}
        </div>

        {/*
          이 오브제만 빠르게.

          바로 위의 속도 슬라이더는 **전체 길이**를 바꾼다. 오브제 여럿을 올려 둔
          사람이 하나만 빠르게 하려고 그 슬라이더를 끌면 화면의 모든 것이 함께
          빨라지고 프레임 수까지 줄어든다. 이 노브는 길이도 초당 프레임도 건드리지
          않고 고른 오브제만 정수 배로 돌린다 (core/types.ts Layer.motionRepeat).

          PRO 인스펙터에만 두면 EASY 사용자는 이 구별을 영원히 못 만난다.
        */}
        {hasImage ? (
          <div className="mm-easy-group">
            <label className="mm-field-label" htmlFor="mm-easy-repeat">
              이 오브제만 빠르게
            </label>
            <select
              id="mm-easy-repeat"
              className="mm-select"
              value={String(targetLayer?.motionRepeat ?? 1)}
              disabled={targetLayerId === null || repeatCap < 2}
              onChange={(e) => {
                if (targetLayerId) setLayerMotionRepeat(targetLayerId, Number(e.target.value))
              }}
            >
              {EASY_REPEAT_CHOICES.filter((r) => r === 1 || r <= repeatCap).map((r) => (
                <option key={r} value={String(r)}>
                  {r === 1 ? '보통 (1배)' : `${r}배`}
                </option>
              ))}
            </select>
            <p className="mm-easy-note">
              {repeatCap < 2
                ? '전체 길이가 너무 짧아 더 쪼갤 수 없습니다.'
                : '전체 길이와 초당 프레임은 그대로 두고 고른 오브제만 빨라집니다. 위 속도 슬라이더는 전체 길이를 바꿉니다.'}
            </p>
          </div>
        ) : null}

        {/*
          그림만 갈아끼우기. 템플릿 흐름의 핵심이다.

          모션을 맞춰 둔 다음 그림만 바꿔 스티커 세트를 뽑는 것이 이 도구의 가장 잦은
          쓰임새다. 레이어를 새로 만들면 트랙과 이펙트가 딸려 사라지므로, assetId 만
          갈아끼운다 (state/document.ts replaceLayerImage).
        */}
        {hasImage && targetLayer?.type === 'image' ? (
          <div className="mm-easy-group">
            <span className="mm-field-label">그림 갈아끼우기</span>
            <ReplaceImageButton
              layerId={targetLayer.id}
              className="mm-btn"
              label="그림만 바꾸기"
              disabled={targetLayer.locked}
              onError={setNotice}
              onReplaced={() => setNotice('그림만 바꿨습니다. 움직임과 효과는 그대로입니다.')}
            />
            <p className="mm-easy-note">
              지금 고른 오브제의 그림만 바꿉니다. 움직임 · 효과 · 크기 · 자리는 그대로 남아서,
              같은 모션에 그림만 갈아끼워 스티커 세트를 만들 수 있습니다.
            </p>
          </div>
        ) : null}

        {/*
          같은 모션을 나머지 오브제에도.

          EASY 에서 가장 잦은 요구인데 인스펙터가 없어서 길이 없었다. 대상을 고르게
          하지 않고 "나머지 전부" 로 못 박는다. EASY 화면에는 레이어 목록이 없어서
          고르라고 해도 무엇이 무엇인지 알 방법이 없기 때문이다. 하나만 골라 보내는
          것은 PRO 인스펙터의 「모션 옮기기」 가 맡는다.
        */}
        {doc.layers.length >= 2 ? (
          <div className="mm-easy-group">
            <span className="mm-field-label">모션 옮기기</span>
            <button
              type="button"
              className="mm-btn"
              disabled={targetLayerId === null}
              onClick={() => {
                if (!targetLayerId) return
                const report = transferMotion({
                  fromLayerId: targetLayerId,
                  toLayerIds: doc.layers.map((l) => l.id),
                  parts: ALL_MOTION_PARTS,
                })
                setNotice(
                  report.moved > 0
                    ? `나머지 ${report.moved}개에 같은 모션을 넣었습니다. Ctrl+Z 로 되돌릴 수 있습니다.`
                    : '옮길 모션이 없습니다. 왼쪽에서 움직임을 먼저 고르세요.',
                )
              }}
            >
              지금 모션을 나머지 오브제에도
            </button>
            <p className="mm-easy-note">
              고른 오브제의 움직임 · 효과 · 가리기를 나머지 전부에 똑같이 넣습니다. 그림과 크기와
              자리는 그대로입니다.
            </p>
          </div>
        ) : null}

        {/*
          모션이 프레임을 벗어날 때 무엇을 지킬 것인가.
          PRO 인스펙터에만 두면 EASY 사용자는 영원히 못 찾는다. 스티커냐 배경 사진이냐로
          답이 갈리는 선택이고, 그 판단은 이미지를 넣는 순간 이미 끝나 있다.
        */}
        {hasImage ? (
          <fieldset className="mm-easy-group">
            <legend>프레임을 벗어나면</legend>
            {FRAME_FIT_OPTIONS.map((option) => (
              <label key={option.value} className="mm-easy-radio">
                <input
                  type="radio"
                  name="mm-easy-framefit"
                  checked={frameFit === option.value}
                  disabled={targetLayerId === null}
                  onChange={() => {
                    if (targetLayerId) setFrameFit(targetLayerId, option.value)
                  }}
                />
                {option.label}
              </label>
            ))}
            <p className="mm-easy-note">
              {FRAME_FIT_OPTIONS.find((o) => o.value === frameFit)?.hint}
            </p>
          </fieldset>
        ) : null}

        {/*
          모션 기준점. 회전과 확대가 도는 축이다.
          PRO 인스펙터에만 두면 EASY 사용자는 "왼쪽 위를 축으로 돌리기" 를 영원히 못 한다.
          기준점을 옮겨도 그림 자리는 캔버스 가운데 그대로다 (core/transform.ts).
        */}
        {hasImage ? (
          <div className="mm-easy-group">
            <span className="mm-field-label" id="mm-easy-anchor">
              모션 기준점
            </span>
            <AnchorGrid
              ax={targetLayer?.anchor[0] ?? 0.5}
              ay={targetLayer?.anchor[1] ?? 0.5}
              disabled={targetLayerId === null}
              labelledBy="mm-easy-anchor"
              onChange={(ax, ay) => {
                if (targetLayerId) setLayerAnchor(targetLayerId, ax, ay)
              }}
            />
            <p className="mm-easy-note">
              회전과 확대가 이 점을 축으로 돕니다. 지금은{' '}
              {anchorLabelOf(targetLayer?.anchor[0] ?? 0.5, targetLayer?.anchor[1] ?? 0.5)}. 그림이
              놓이는 자리는 바뀌지 않습니다.
            </p>
          </div>
        ) : null}

        <fieldset className="mm-easy-group">
          <legend>반복</legend>
          {LOOP_OPTIONS.map((option) => (
            <label key={option.mode} className="mm-easy-radio">
              <input
                type="radio"
                name="mm-easy-loop"
                checked={doc.timeline.loop.mode === option.mode}
                onChange={() => setLoopMode(option.mode)}
              />
              {option.label}
            </label>
          ))}
          {doc.timeline.loop.mode === 'loopWithHold' ? (
            <p className="mm-easy-note">
              지금은 PRO 에서 고른 반복(끝에서 잠깐 멈춤)입니다. 위에서 하나를 고르면 바뀝니다.
            </p>
          ) : null}
        </fieldset>

        <div className="mm-easy-group">
          <label className="mm-field-label" htmlFor="mm-easy-size">
            크기
          </label>
          <select
            id="mm-easy-size"
            className="mm-select"
            value={longestEdge}
            onChange={(e) => setLongestEdge(Number(e.target.value))}
          >
            {sizeOptions.map((n) => (
              <option key={n} value={n}>
                {n} px
              </option>
            ))}
          </select>
          <p className="mm-easy-note">
            지금 {doc.canvas.w} x {doc.canvas.h} 입니다.
            {longestEdge > STICKER_MAX_PX
              ? ` 기본 내보내기는 긴 변을 ${STICKER_MAX_PX}px 로 줄입니다. 원본 크기가 필요하면 [다른 설정으로] 를 쓰세요.`
              : ''}
          </p>
          {longestEdge > HEAVY_SIZE_PX ? (
            <p className="mm-easy-note">
              큰 크기입니다. 만드는 데 시간이 걸리고 파일도 커집니다. 만드는 동안 이 탭을
              켜 두세요.
            </p>
          ) : null}
        </div>

        {/*
          자르기를 PRO 인스펙터에만 두면 EASY 사용자는 여백을 영원히 못 지운다.
          파라미터 없는 원클릭만 여기 둔다. 영역을 직접 그리는 것은 PRO 몫이다.
        */}
        <div className="mm-easy-group">
          <span className="mm-field-label">자르기</span>
          <button
            type="button"
            className="mm-btn"
            disabled={!firstAssetId || trimming || swapping}
            onClick={handleTrim}
          >
            {trimming ? '자르는 중' : '빈 여백 잘라내기'}
          </button>
          <button
            type="button"
            className="mm-btn"
            disabled={!firstAssetId || trimming || swapping}
            onClick={() => setCropOpen(true)}
          >
            직접 자르기
          </button>
          {trimUndo ? (
            <button type="button" className="mm-btn" disabled={trimming} onClick={handleTrimUndo}>
              원래대로
            </button>
          ) : null}
          <p className="mm-easy-note">
            [빈 여백 잘라내기] 는 그림 둘레의 투명하거나 단색인 여백을 찾아 잘라냅니다.
            [직접 자르기] 는 남길 영역을 직접 끌어서 정합니다. 비율은 자유이고 1:1 같은
            고정 비율도 고를 수 있습니다. 어느 쪽이든 캔버스가 자른 크기에 맞춰집니다.
          </p>
        </div>

        <div className="mm-easy-group">
          <label className="mm-field-label" htmlFor="mm-easy-bg">
            배경
          </label>
          <select
            id="mm-easy-bg"
            className="mm-select"
            value={background}
            onChange={(e) => setBackground(e.target.value as EasyBackground)}
          >
            {BACKGROUND_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          {background !== 'alpha' ? (
            <input
              ref={colorInputRef}
              type="color"
              className="mm-color"
              aria-label="배경색"
              value={doc.canvas.background.color.slice(0, 7)}
              onChange={(e) => setBackgroundColor(`${e.target.value}ff`)}
            />
          ) : (
            <p className="mm-easy-note">투명하게 내보냅니다. 반투명 가장자리가 그대로 남습니다.</p>
          )}
        </div>

        {notice ? (
          <p className="mm-easy-status" role="status">
            {notice}
          </p>
        ) : null}

        <div className="mm-easy-pro">
          <button type="button" className="mm-easy-link" onClick={() => setMode('pro')}>
            PRO 에서 세밀 조정
          </button>
          <p className="mm-easy-note">
            지금 만든 것이 그대로 열립니다. 키프레임과 곡선을 직접 만질 수 있어요.
          </p>
        </div>
      </aside>

      {firstAssetId ? (
        <QuickCrop
          open={cropOpen}
          assetId={firstAssetId}
          onClose={() => setCropOpen(false)}
          onDone={setNotice}
        />
      ) : null}

      {/* 호출자가 다이얼로그를 쥐고 있지 않을 때만 자기 것을 그린다. */}
      {onOpenExportSettings ? null : (
        <ExportDialog open={dialogOpen} onClose={() => setDialogOpen(false)} />
      )}

      <p className="mm-visually-hidden" role="status">
        {swapping ? '이미지를 바꾸는 중입니다' : ''}
      </p>
    </div>
  )
}

export default EasyMode
