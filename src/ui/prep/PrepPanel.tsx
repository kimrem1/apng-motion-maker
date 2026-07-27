/**
 * 이미지 다듬기 패널.
 *
 * 흰 배경 JPG 를 넣은 사용자가 여기서 투명 스티커를 만든다.
 * 배경 제거 파라미터는 전부 미리보기로 즉시 확인하고, 확인이 끝난 뒤에만
 * [적용] 으로 실제 에셋을 교체한다. 슬라이더가 곧바로 원본을 갈아엎으면
 * 되돌릴 방법이 없다.
 *
 * 미리보기 배경 스위처는 장식이 아니라 14.A1 의 릴리즈 게이트다.
 * 체커보드 위에서는 흰 테두리가 안 보이고, 흰 배경 위에서는 검은 테두리가
 * 안 보인다. 둘 다 볼 수 있어야 디스필이 됐는지 판단할 수 있다.
 *
 * 적용/되돌리기는 픽셀 교체(assetRegistry.set)와 문서 반영(updateAssetPrep)을
 * 반드시 함께 한다. 픽셀만 바꾸면 AssetRef.naturalW/H 가 실제와 어긋나
 * overscan.ts 의 requiredScaleAt 이 틀린 원본 크기로 s_min 을 계산하고,
 * 회전/이동 프리셋에서 캔버스 모서리가 비는 사고가 난다. hasAlpha 도 같이
 * 갱신해야 배경을 지운 JPG 의 투명도가 내보내기에서 살아남는다.
 */

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  // DOM 의 MouseEvent / PointerEvent 와 이름이 겹친다. 별칭으로 구분한다.
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'

import type { AssetPrep, AssetRef } from '@/core/types.ts'
import { probeAlpha } from '@/imageprep/alphaProbe.ts'
import { toErrorMessage } from '@/imageprep/decode.ts'
import {
  PREP_BITMAP_OPTIONS,
  cloneBitmap,
  estimateTolerance,
  pickKeyColorFromCorners,
  readPixels,
  removeBackground,
  type BgRemoveOptions,
} from '@/imageprep/bgRemove.ts'
import {
  ASPECT_PRESETS,
  CROP_HANDLES,
  CROP_MIN_SIZE,
  applyCropDrag,
  autoTrimContent,
  cropBitmap,
  fitRectToAspect,
  roundRect,
  type CropHandle,
  type CropRect,
} from '@/imageprep/crop.ts'
import { assetRegistry } from '@/state/assets.ts'
import { useDocumentStore } from '@/state/document.ts'
import { useUiStore } from '@/state/ui.ts'
import { NumberField } from '@/ui/widgets/Field.tsx'
import { ensurePrepOriginal } from './prepOriginals.ts'

import './prep.css'

export { ensurePrepOriginal, releasePrepOriginal } from './prepOriginals.ts'

/** 미리보기 긴 변. 슬라이더를 끌 때마다 전체 해상도를 돌리면 손가락보다 느려진다. */
const PREVIEW_MAX = 320
/** 슬라이더 디바운스. --dur-fast 와 같은 값이다. */
const PREVIEW_DEBOUNCE_MS = 140

const FEATHER_MAX = 8

/** 크롭 핸들을 잡았다고 볼 반경(화면 픽셀). 손가락으로도 잡을 수 있어야 한다. */
const HANDLE_GRAB_PX = 12
/** 이만큼(화면 픽셀) 움직이기 전에는 드래그로 보지 않는다. 클릭이 상자를 만들면 안 된다. */
const DRAG_SLOP_PX = 3

/** 진행 중인 크롭 드래그. 렌더마다 새로 만들면 안 되므로 ref 에 둔다. */
interface CropDragState {
  mode: 'create' | 'edit'
  handle: CropHandle
  /** edit 일 때 드래그 시작 시점의 상자. create 면 null. */
  start: CropRect | null
  ox: number
  oy: number
  moved: boolean
}

type PreviewBg = 'checker' | 'white' | 'black' | 'gray'

const BACKGROUNDS: readonly { id: PreviewBg; label: string }[] = [
  { id: 'checker', label: '체커' },
  { id: 'white', label: '흰' },
  { id: 'black', label: '검' },
  { id: 'gray', label: '회' },
]

// ---------------------------------------------------------------------------
// 작은 유틸
// ---------------------------------------------------------------------------

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v)

function toHex(color: readonly [number, number, number]): string {
  const part = (v: number): string =>
    clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')
  return `#${part(color[0])}${part(color[1])}${part(color[2])}`
}

function fromHex(hex: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return null
  const n = parseInt(m[1]!, 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

interface PrepSettings {
  enabled: boolean
  keyColor: [number, number, number]
  tolerance: number
  featherPx: number
  contiguous: boolean
}

function toOptions(s: PrepSettings): BgRemoveOptions {
  return {
    keyColor: [s.keyColor[0], s.keyColor[1], s.keyColor[2]],
    tolerance: s.tolerance,
    featherPx: s.featherPx,
    contiguous: s.contiguous,
  }
}

function IconDropper() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M10.4 2.6a1.6 1.6 0 0 1 2.3 2.3l-1 1 .7.7-1.1 1.1-2.9-2.9L9.5 3.7l.7.7 .2-.2Z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      <path
        d="M8.4 6.5 3.6 11.3c-.2.2-.3.4-.3.7v1.1c0 .3.2.5.5.5h1.1c.3 0 .5-.1.7-.3l4.8-4.8"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  )
}

// ---------------------------------------------------------------------------
// 슬라이더
// ---------------------------------------------------------------------------

interface RangeRowProps {
  label: string
  value: number
  min: number
  max: number
  step: number
  display: string
  disabled?: boolean
  onChange(next: number): void
}

function RangeRow({ label, value, min, max, step, display, disabled, onChange }: RangeRowProps) {
  const id = useId()
  return (
    <div className="mm-field">
      <label className="mm-field-label" htmlFor={id}>
        {label} <span className="mm-prep-value">{display}</span>
      </label>
      <input
        id={id}
        className="mm-prep-range"
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// 편집기 본체
// ---------------------------------------------------------------------------

function PrepEditor({ asset }: { asset: AssetRef }) {
  // 같은 화면에 편집기가 둘 이상 뜰 일은 없지만, id 를 고정 문자열로 박으면
  // 나중에 비교 뷰를 붙이는 순간 label 연결이 조용히 깨진다.
  const uid = useId()
  // 배경 지우기는 꺼진 채로 시작한다. 이미 투명한 PNG 가 대부분인데 켜진 채로 열면
  // 자동 추정한 키 색이 피사체 일부를 물고 들어가, 사용자가 아무것도 안 했는데
  // 미리보기가 이미 망가져 보인다. 필요한 사람이 체크해서 켠다.
  const [settings, setSettings] = useState<PrepSettings>(() => ({
    enabled: false,
    keyColor: [255, 255, 255],
    tolerance: 0.12,
    featherPx: 1,
    contiguous: true,
  }))
  const [natural, setNatural] = useState<{ w: number; h: number }>({
    w: asset.naturalW,
    h: asset.naturalH,
  })
  const [cropRect, setCropRect] = useState<CropRect | null>(null)
  const [aspectId, setAspectId] = useState('free')
  const [background, setBackground] = useState<PreviewBg>('checker')
  const [picking, setPicking] = useState(false)
  /** 자른 크기에 캔버스를 맞출 것인가. 이게 꺼져 있으면 여백이 결과물에 그대로 남는다. */
  const [fitCanvas, setFitCanvas] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** 실패는 아니지만 알려야 하는 것. 빨간 에러로 띄우면 뭘 잘못한 줄 안다. */
  const [notice, setNotice] = useState<string | null>(null)
  const [applied, setApplied] = useState<{ w: number; h: number } | null>(null)
  /** 미리보기 재그리기를 강제하는 값. 비트맵은 ref 에 있어서 상태 비교로는 안 잡힌다. */
  const [previewTick, setPreviewTick] = useState(0)
  /** 축소 원본이 준비된 시점. 이게 없으면 첫 계산이 원본을 못 잡고 그냥 지나간다. */
  const [sourceRev, setSourceRev] = useState(0)

  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  /**
   * 크롭 적용 직전의 캔버스 크기. 되돌리기가 캔버스까지 원상복구하기 위해 기억한다.
   * 픽셀만 되돌리고 캔버스를 두면 원본이 잘린 프레임 안에 갇힌다.
   */
  const canvasBeforeRef = useRef<{ w: number; h: number } | null>(null)
  const dragRef = useRef<CropDragState | null>(null)
  /** 미리보기용 축소 원본. */
  const previewSrcRef = useRef<ImageBitmap | null>(null)
  /** 스포이드가 읽는 축소 원본 픽셀. 처리 결과가 아니라 원본에서 뽑아야 한다. */
  const previewPixelsRef = useRef<ImageData | null>(null)
  /** 배경을 지운 미리보기 결과. */
  const previewOutRef = useRef<ImageBitmap | null>(null)

  const bumpPreview = useCallback((): void => {
    setPreviewTick((t) => t + 1)
  }, [])

  // StrictMode 는 이펙트를 두 번 돌린다. 정리(cleanup)에서 비트맵을 닫으면
  // 두 번째 실행이 이미 닫힌 비트맵을 잡는다. 그래서 "새로 만들 때 이전 것을
  // 닫는다"로 통일한다.
  const replacePreviewOut = useCallback(
    (next: ImageBitmap | null): void => {
      const prev = previewOutRef.current
      if (prev && prev !== next) prev.close()
      previewOutRef.current = next
      bumpPreview()
    },
    [bumpPreview],
  )

  // --- 원본 준비 + 자동 추정 -------------------------------------------------
  useEffect(() => {
    let alive = true
    setError(null)
    setNotice(null)
    setApplied(null)
    setCropRect(null)
    setAspectId('free')
    canvasBeforeRef.current = null
    dragRef.current = null

    void (async () => {
      try {
        const original = await ensurePrepOriginal(asset.id)
        if (!alive) return

        const long = Math.max(original.width, original.height)
        const scale = long > PREVIEW_MAX ? PREVIEW_MAX / long : 1
        const pw = Math.max(1, Math.round(original.width * scale))
        const ph = Math.max(1, Math.round(original.height * scale))
        const small =
          scale < 1
            ? await createImageBitmap(original, {
                ...PREP_BITMAP_OPTIONS,
                resizeWidth: pw,
                resizeHeight: ph,
                resizeQuality: 'high',
              })
            : await cloneBitmap(original)

        const prev = previewSrcRef.current
        if (prev) prev.close()
        previewSrcRef.current = small
        previewPixelsRef.current = readPixels(small)

        // 자동 추정은 축소본에서 한다. 전체 해상도로 해도 결과가 거의 같고,
        // 임포트 직후 UI 가 멈추는 쪽이 훨씬 나쁘다.
        // 추정값은 꺼진 상태로 채워 둔다. 체크를 켜는 순간 바로 쓸 만한 값이 들어 있어야
        // 사용자가 색과 허용치를 처음부터 맞출 필요가 없다.
        const key = pickKeyColorFromCorners(small)
        const tolerance = estimateTolerance(small, key)

        if (!alive) return
        setNatural({ w: original.width, h: original.height })
        setSettings({ enabled: false, keyColor: key, tolerance, featherPx: 1, contiguous: true })
        replacePreviewOut(null)
        setSourceRev((v) => v + 1)
      } catch (err) {
        if (alive) setError(toErrorMessage(err))
      }
    })()

    return () => {
      alive = false
    }
  }, [asset.id, replacePreviewOut])

  // --- 미리보기 계산 ---------------------------------------------------------
  const { enabled, tolerance, featherPx, contiguous } = settings
  const keyKey = settings.keyColor.join(',')

  useEffect(() => {
    if (!enabled) {
      replacePreviewOut(null)
      return
    }
    let alive = true
    const timer = setTimeout(() => {
      const source = previewSrcRef.current
      if (!source) return
      // settings 는 deps 에 없지만 항상 최신이다. 이펙트 함수 자체가 매 렌더마다
      // 새로 만들어지고, deps(keyKey 등)가 바뀐 렌더의 함수가 실행되기 때문이다.
      const opts = toOptions(settings)
      void (async () => {
        try {
          const out = await removeBackground(source, opts)
          if (!alive) {
            out.close()
            return
          }
          replacePreviewOut(out)
        } catch (err) {
          if (alive) setError(toErrorMessage(err))
        }
      })()
    }, PREVIEW_DEBOUNCE_MS)

    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [enabled, keyKey, tolerance, featherPx, contiguous, sourceRev, replacePreviewOut])

  // --- 그리기 ---------------------------------------------------------------
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    // 처리 결과가 아직이면 원본을 보여준다. 계산 중 화면이 비면 깜빡임이 된다.
    const shown = (enabled ? previewOutRef.current : null) ?? previewSrcRef.current
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    if (!shown) {
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      return
    }
    if (canvas.width !== shown.width || canvas.height !== shown.height) {
      canvas.width = shown.width
      canvas.height = shown.height
    }
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    try {
      ctx.drawImage(shown, 0, 0)
    } catch {
      // 교체 경합으로 닫힌 비트맵을 잡은 경우다. 다음 tick 에 다시 그린다.
      return
    }

    // 크롭 상자는 캔버스에 그리지 않고 DOM 오버레이로 얹는다. 미리보기 캔버스는
    // 320px 짜리를 CSS 로 줄여 보여주므로, 여기에 그린 선과 핸들은 뭉개진다.
  }, [previewTick, sourceRev, enabled, background])

  // --- 크롭 드래그 -----------------------------------------------------------

  const ratio = ASPECT_PRESETS.find((p) => p.id === aspectId)?.ratio ?? null
  const bounds: CropRect = { x: 0, y: 0, w: natural.w, h: natural.h }

  /** 프레임 안의 포인터 위치를 자연 좌표로 바꾼다. */
  function toNatural(e: ReactPointerEvent<HTMLDivElement>): { x: number; y: number } | null {
    const box = e.currentTarget.getBoundingClientRect()
    if (box.width === 0 || box.height === 0 || natural.w === 0 || natural.h === 0) return null
    return {
      x: ((e.clientX - box.left) / box.width) * natural.w,
      y: ((e.clientY - box.top) / box.height) * natural.h,
    }
  }

  /**
   * 어느 핸들을 잡았는가.
   *
   * 판정은 **화면 픽셀**로 한다. 자연 좌표로 하면 4000px 원본에서는 허용 반경이
   * 40px 이 되어 상자 전체가 핸들이 되고, 300px 원본에서는 3px 이 되어 아무것도
   * 못 잡는다.
   */
  function hitHandle(
    rect: CropRect,
    at: { x: number; y: number },
    pxPerNatural: number,
  ): CropHandle | null {
    const grab = HANDLE_GRAB_PX / Math.max(1e-6, pxPerNatural)
    const nearL = Math.abs(at.x - rect.x) <= grab
    const nearR = Math.abs(at.x - (rect.x + rect.w)) <= grab
    const nearT = Math.abs(at.y - rect.y) <= grab
    const nearB = Math.abs(at.y - (rect.y + rect.h)) <= grab
    const insideX = at.x >= rect.x - grab && at.x <= rect.x + rect.w + grab
    const insideY = at.y >= rect.y - grab && at.y <= rect.y + rect.h + grab

    if (nearL && nearT) return 'nw'
    if (nearR && nearT) return 'ne'
    if (nearL && nearB) return 'sw'
    if (nearR && nearB) return 'se'
    if (nearL && insideY) return 'w'
    if (nearR && insideY) return 'e'
    if (nearT && insideX) return 'n'
    if (nearB && insideX) return 's'
    if (at.x > rect.x && at.x < rect.x + rect.w && at.y > rect.y && at.y < rect.y + rect.h) {
      return 'move'
    }
    return null
  }

  function handlePointerDown(e: ReactPointerEvent<HTMLDivElement>): void {
    // 스포이드가 켜져 있으면 클릭은 색 고르기다. 크롭이 가로채면 안 된다.
    if (picking || disabled || natural.w === 0) return
    const at = toNatural(e)
    if (!at) return
    const box = e.currentTarget.getBoundingClientRect()
    const pxPerNatural = box.width / natural.w

    const handle = cropRect ? hitHandle(cropRect, at, pxPerNatural) : null
    dragRef.current = handle
      ? { mode: 'edit', handle, start: cropRect!, ox: at.x, oy: at.y, moved: false }
      : { mode: 'create', handle: 'se', start: null, ox: at.x, oy: at.y, moved: false }

    // 캡처를 못 잡아도 드래그는 계속돼야 한다. 포인터가 이미 사라진 경우
    // (합성 이벤트, 일부 펜 입력) 브라우저가 던진다.
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      /* 캡처 없이 진행한다 */
    }
    e.preventDefault()
  }

  function handlePointerMove(e: ReactPointerEvent<HTMLDivElement>): void {
    const drag = dragRef.current
    if (!drag) return
    const at = toNatural(e)
    if (!at) return
    const dx = at.x - drag.ox
    const dy = at.y - drag.oy

    const box = e.currentTarget.getBoundingClientRect()
    const pxPerNatural = box.width / Math.max(1, natural.w)
    // 손 떨림으로 크롭이 생기지 않게 한다. 판정은 화면 픽셀이다.
    if (!drag.moved && Math.hypot(dx, dy) * pxPerNatural < DRAG_SLOP_PX) return
    drag.moved = true

    if (drag.mode === 'create') {
      // 끄는 방향으로 모서리를 정한다. 방향을 바꾸면 잡은 모서리도 따라 바뀐다.
      const handle = `${dy < 0 ? 'n' : 's'}${dx < 0 ? 'w' : 'e'}` as CropHandle
      setCropRect(
        applyCropDrag({
          start: { x: drag.ox, y: drag.oy, w: 0, h: 0 },
          handle,
          dx,
          dy,
          bounds,
          ratio,
        }),
      )
      return
    }

    setCropRect(applyCropDrag({ start: drag.start!, handle: drag.handle, dx, dy, bounds, ratio }))
  }

  function handlePointerUp(e: ReactPointerEvent<HTMLDivElement>): void {
    const drag = dragRef.current
    dragRef.current = null
    try {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId)
      }
    } catch {
      /* 이미 놓았다 */
    }
    if (!drag || !drag.moved) return
    // 드래그가 끝난 순간에만 정수로 확정한다. 진행 중에 반올림하면 상자가 덜덜 떤다.
    setCropRect((prev) => (prev ? roundRect(prev, natural.w, natural.h) : prev))
  }

  /** 숫자 입력으로 상자를 고친다. 키보드만 쓰는 사용자의 유일한 경로다. */
  function setCropField(key: 'x' | 'y' | 'w' | 'h', value: number): void {
    if (natural.w === 0) return
    const base = cropRect ?? { x: 0, y: 0, w: natural.w, h: natural.h }
    const next = { ...base, [key]: Math.round(value) }
    if (ratio !== null) {
      if (key === 'w') next.h = next.w / ratio
      else if (key === 'h') next.w = next.h * ratio
    }
    // 경계 밖으로 나가면 잘라 낸다. w/h 를 먼저 가둔 뒤 x/y 를 민다.
    next.w = clamp(next.w, CROP_MIN_SIZE, natural.w)
    next.h = clamp(next.h, CROP_MIN_SIZE, natural.h)
    next.x = clamp(next.x, 0, natural.w - next.w)
    next.y = clamp(next.y, 0, natural.h - next.h)
    setCropRect(roundRect(next, natural.w, natural.h))
  }

  // --- 동작 -----------------------------------------------------------------

  function handlePick(e: ReactMouseEvent<HTMLCanvasElement>): void {
    if (!picking) return
    const canvas = e.currentTarget
    const pixels = previewPixelsRef.current
    if (!pixels) return
    const box = canvas.getBoundingClientRect()
    if (box.width === 0 || box.height === 0) return

    const x = Math.floor((e.clientX - box.left) * (canvas.width / box.width))
    const y = Math.floor((e.clientY - box.top) * (canvas.height / box.height))
    if (x < 0 || y < 0 || x >= pixels.width || y >= pixels.height) return

    const p = (y * pixels.width + x) * 4
    const d = pixels.data
    setSettings((s) => ({ ...s, keyColor: [d[p] ?? 0, d[p + 1] ?? 0, d[p + 2] ?? 0] }))
    // 한 번 찍으면 스포이드를 끈다. 켜 둔 채로 두면 다음 클릭이 사고를 낸다.
    setPicking(false)
  }

  async function withBusy(label: string, run: () => Promise<void>): Promise<void> {
    setBusy(label)
    setError(null)
    setNotice(null)
    try {
      await run()
    } catch (err) {
      setError(toErrorMessage(err))
    } finally {
      setBusy(null)
    }
  }

  /** 전체 해상도 파이프라인. 배경 제거 -> 크롭 순서다. */
  async function buildResult(original: ImageBitmap): Promise<ImageBitmap> {
    let out: ImageBitmap | null = null
    if (settings.enabled) out = await removeBackground(original, toOptions(settings))
    if (cropRect) {
      const base = out ?? original
      const next = await cropBitmap(base, cropRect)
      if (out) out.close()
      out = next
    }
    // 아무 처리도 없으면 원본 보관본을 그대로 넘길 수 없다. 레지스트리가 닫아 버린다.
    return out ?? (await cloneBitmap(original))
  }

  /** 문서에 기록할 다듬기 파라미터. 아무 처리도 없으면 undefined 다. */
  function buildPrepRecord(): AssetPrep | undefined {
    const prep: AssetPrep = {}
    if (cropRect) {
      prep.crop = [
        Math.round(cropRect.x),
        Math.round(cropRect.y),
        Math.round(cropRect.w),
        Math.round(cropRect.h),
      ]
    }
    if (settings.enabled) {
      prep.bgRemove = {
        enabled: true,
        keyColor: toHex(settings.keyColor),
        tolerance: settings.tolerance,
        featherPx: settings.featherPx,
        contiguous: settings.contiguous,
      }
    }
    return prep.crop || prep.bgRemove ? prep : undefined
  }

  function handleApply(): void {
    void withBusy('적용', async () => {
      const original = await ensurePrepOriginal(asset.id)
      const result = await buildResult(original)
      // 알파는 실측한다. 배경 제거를 껐어도 크롭이 투명 영역을 잘라냈을 수 있다.
      const hasAlpha = probeAlpha(result)
      assetRegistry.set(asset.id, result)
      const store = useDocumentStore.getState()
      // 픽셀과 문서를 같은 동작 안에서 맞춘다. 어긋나면 오버스캔이 옛 크기를 쓴다.
      store.updateAssetPrep(asset.id, {
        width: result.width,
        height: result.height,
        hasAlpha,
        prep: buildPrepRecord(),
      })
      /*
       * 캔버스를 안 따라가면 크롭이 "안 되는" 것처럼 보인다.
       *
       * 에셋만 잘리고 캔버스가 원래 크기로 남으면, 잘라낸 여백이 그대로 프레임의
       * 빈 공간이 되어 결과 파일에 그대로 실린다. 사용자 눈에는 버튼을 눌렀는데
       * 아무것도 안 잘린 것과 구별되지 않는다. 그래서 기본으로 같이 맞춘다.
       */
      if (cropRect && fitCanvas) {
        const doc = store.doc
        canvasBeforeRef.current = { w: doc.canvas.w, h: doc.canvas.h }
        store.setCanvasSize(result.width, result.height)
      } else {
        canvasBeforeRef.current = null
      }
      setApplied({ w: result.width, h: result.height })
    })
  }

  function handleRevert(): void {
    void withBusy('되돌리기', async () => {
      const original = await ensurePrepOriginal(asset.id)
      const hasAlpha = probeAlpha(original)
      assetRegistry.set(asset.id, await cloneBitmap(original))
      const store = useDocumentStore.getState()
      store.updateAssetPrep(asset.id, {
        width: original.width,
        height: original.height,
        hasAlpha,
      })
      // 적용할 때 캔버스를 같이 바꿨으면 그것도 돌려놓는다.
      const before = canvasBeforeRef.current
      if (before) {
        store.setCanvasSize(before.w, before.h)
        canvasBeforeRef.current = null
      }
      setApplied(null)
    })
  }

  function handleAutoTrim(): void {
    void withBusy('여백 찾기', async () => {
      const original = await ensurePrepOriginal(asset.id)
      // 여백 판정은 알파를 먼저 본다. 배경 제거를 켠 상태면 그 결과에서 찾아야 맞다.
      let probe = original
      let temp: ImageBitmap | null = null
      if (settings.enabled) {
        temp = await removeBackground(original, toOptions(settings))
        probe = temp
      }
      // 알파로 못 줄이면 단색 여백을 잡는다. 불투명 JPG 에서 이게 없으면
      // 버튼이 아무 일도 안 하는 것처럼 보인다.
      const rect = await autoTrimContent(probe)
      if (temp) temp.close()
      if (rect.w >= natural.w && rect.h >= natural.h) {
        // 전체 사각형이면 자를 것이 없다. 그대로 상자를 씌우면 "됐다" 로 오해한다.
        setNotice('잘라낼 여백을 찾지 못했습니다. 가장자리까지 그림이 차 있습니다.')
        return
      }
      setCropRect(roundRect(rect, natural.w, natural.h))
      setAspectId('free')
      setNotice(null)
    })
  }

  function handleAspect(id: string, nextRatio: number | null): void {
    setAspectId(id)
    // '자유' 는 지금 상자를 그대로 둔다. 비율만 풀린다.
    if (nextRatio === null) return
    setCropRect(fitRectToAspect(cropRect ?? bounds, nextRatio, bounds))
  }

  const disabled = busy !== null

  return (
    <div className="mm-stack">
      {/* 미리보기 --------------------------------------------------------- */}
      <div className="mm-prep-preview">
        <div className="mm-prep-bgbar" role="group" aria-label="미리보기 배경">
          {BACKGROUNDS.map((bg) => (
            <button
              key={bg.id}
              type="button"
              className="mm-prep-chip"
              aria-pressed={background === bg.id}
              onClick={() => setBackground(bg.id)}
            >
              {bg.label}
            </button>
          ))}
        </div>

        <div
          className={
            background === 'checker' ? 'mm-prep-stage mm-checker' : 'mm-prep-stage'
          }
          data-bg={background}
        >
          {/*
            프레임이 포인터를 전부 받는다. 오버레이 자식은 pointer-events: none 이라
            핸들 위에서도 좌표 계산이 한 곳에서만 일어난다.
          */}
          <div
            className="mm-prep-frame"
            data-picking={picking}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerUp}
          >
            <canvas
              ref={canvasRef}
              className={picking ? 'mm-prep-canvas is-picking' : 'mm-prep-canvas'}
              width={1}
              height={1}
              role="img"
              aria-label="배경 제거 미리보기"
              onClick={handlePick}
            />
            {cropRect && natural.w > 0 && natural.h > 0 ? (
              <div
                className="mm-prep-crop"
                aria-hidden="true"
                style={{
                  left: `${(cropRect.x / natural.w) * 100}%`,
                  top: `${(cropRect.y / natural.h) * 100}%`,
                  width: `${(cropRect.w / natural.w) * 100}%`,
                  height: `${(cropRect.h / natural.h) * 100}%`,
                }}
              >
                <span className="mm-prep-crop-grid" />
                {CROP_HANDLES.map((h) => (
                  <span key={h} className="mm-prep-handle" data-handle={h} />
                ))}
              </div>
            ) : null}
          </div>
        </div>

        <p className="mm-field-hint">
          {picking
            ? '미리보기에서 지울 색을 클릭하세요.'
            : cropRect
              ? '상자 안쪽을 끌면 이동, 모서리와 변을 끌면 크기가 바뀝니다. 상자 밖에서 끌면 새로 그립니다.'
              : '미리보기 위를 끌어서 자를 영역을 직접 그릴 수 있습니다.'}
        </p>
        <p className="mm-field-hint">
          흰 배경과 검은 배경을 번갈아 보세요. 흰 배경에서 검은 테두리가, 검은 배경에서 흰
          테두리가 보이면 허용치를 조금 올리세요.
        </p>
      </div>

      {/* 배경 제거 -------------------------------------------------------- */}
      <div className="mm-field mm-field-toggle">
        <input
          id={`${uid}-enabled`}
          className="mm-checkbox"
          type="checkbox"
          checked={settings.enabled}
          disabled={disabled}
          onChange={(e) => setSettings((s) => ({ ...s, enabled: e.target.checked }))}
        />
        <label className="mm-field-label" htmlFor={`${uid}-enabled`}>
          배경 지우기
        </label>
      </div>

      <div className="mm-field">
        <label className="mm-field-label" htmlFor={`${uid}-key`}>
          지울 색
        </label>
        <div className="mm-prep-key">
          <span
            className="mm-prep-swatch"
            style={{ background: toHex(settings.keyColor) }}
            aria-hidden="true"
          />
          {/* 스포이드를 못 쓰는 사용자를 위한 대체 입력이다. 키보드로도 색을 정할 수 있다. */}
          <input
            id={`${uid}-key`}
            className="mm-color"
            type="color"
            value={toHex(settings.keyColor)}
            disabled={!settings.enabled || disabled}
            aria-label="지울 배경색"
            onChange={(e) => {
              const rgb = fromHex(e.target.value)
              if (rgb) setSettings((s) => ({ ...s, keyColor: rgb }))
            }}
          />
          <button
            type="button"
            className="mm-btn"
            aria-pressed={picking}
            disabled={!settings.enabled || disabled}
            title="미리보기에서 지울 색을 클릭해 고릅니다"
            onClick={() => setPicking((v) => !v)}
          >
            <IconDropper />
            스포이드
          </button>
        </div>
      </div>

      <RangeRow
        label="허용치"
        value={Math.round(settings.tolerance * 100)}
        min={0}
        max={100}
        step={1}
        display={`${Math.round(settings.tolerance * 100)}%`}
        disabled={!settings.enabled || disabled}
        onChange={(v) => setSettings((s) => ({ ...s, tolerance: clamp(v / 100, 0, 1) }))}
      />

      <RangeRow
        label="가장자리 부드럽게"
        value={settings.featherPx}
        min={0}
        max={FEATHER_MAX}
        step={1}
        display={`${settings.featherPx}px`}
        disabled={!settings.enabled || disabled}
        onChange={(v) => setSettings((s) => ({ ...s, featherPx: clamp(v, 0, FEATHER_MAX) }))}
      />

      <div className="mm-field mm-field-toggle">
        <input
          id={`${uid}-contiguous`}
          className="mm-checkbox"
          type="checkbox"
          checked={settings.contiguous}
          disabled={!settings.enabled || disabled}
          onChange={(e) => setSettings((s) => ({ ...s, contiguous: e.target.checked }))}
        />
        <label className="mm-field-label" htmlFor={`${uid}-contiguous`}>
          모서리에서 연결된 부분만
        </label>
      </div>
      <p className="mm-field-hint">
        켜 두면 피사체 안쪽의 같은 색(예: 흰 눈동자)이 지워지지 않습니다.
      </p>

      {/* 크롭 ------------------------------------------------------------- */}
      <h3 className="mm-section-subtitle">자르기</h3>

      <div className="mm-field">
        <span className="mm-field-label" id={`${uid}-aspect`}>
          비율
        </span>
        <div className="mm-prep-chips" role="group" aria-labelledby={`${uid}-aspect`}>
          {ASPECT_PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              className="mm-prep-chip"
              aria-pressed={aspectId === preset.id}
              disabled={disabled}
              onClick={() => handleAspect(preset.id, preset.ratio)}
            >
              {preset.label}
            </button>
          ))}
        </div>
      </div>

      <div className="mm-prep-actions">
        <button type="button" className="mm-btn" disabled={disabled} onClick={handleAutoTrim}>
          {busy === '여백 찾기' ? '찾는 중' : '빈 여백 자동 제거'}
        </button>
        <button
          type="button"
          className="mm-btn"
          disabled={disabled || natural.w === 0}
          onClick={() => {
            const full: CropRect = { x: 0, y: 0, w: natural.w, h: natural.h }
            setCropRect(ratio === null ? full : fitRectToAspect(full, ratio, full))
          }}
        >
          전체 선택
        </button>
        <button
          type="button"
          className="mm-btn"
          disabled={disabled || !cropRect}
          onClick={() => {
            setCropRect(null)
            setAspectId('free')
          }}
        >
          자르기 해제
        </button>
      </div>

      {/*
        숫자 입력은 장식이 아니다. 드래그는 마우스가 있어야 하고, 1px 단위로
        맞추는 것도 드래그로는 불가능하다. 키보드만 쓰는 사용자에게는 이게 유일한 길이다.
      */}
      <div className="mm-prep-cropnums">
        <NumberField
          label="X"
          value={cropRect ? Math.round(cropRect.x) : 0}
          min={0}
          max={Math.max(0, natural.w - CROP_MIN_SIZE)}
          step={1}
          disabled={disabled || !cropRect}
          onChange={(v) => setCropField('x', v)}
        />
        <NumberField
          label="Y"
          value={cropRect ? Math.round(cropRect.y) : 0}
          min={0}
          max={Math.max(0, natural.h - CROP_MIN_SIZE)}
          step={1}
          disabled={disabled || !cropRect}
          onChange={(v) => setCropField('y', v)}
        />
        <NumberField
          label="폭"
          value={cropRect ? Math.round(cropRect.w) : natural.w}
          min={CROP_MIN_SIZE}
          max={natural.w}
          step={1}
          disabled={disabled || !cropRect}
          onChange={(v) => setCropField('w', v)}
        />
        <NumberField
          label="높이"
          value={cropRect ? Math.round(cropRect.h) : natural.h}
          min={CROP_MIN_SIZE}
          max={natural.h}
          step={1}
          disabled={disabled || !cropRect}
          onChange={(v) => setCropField('h', v)}
        />
      </div>

      <div className="mm-field mm-field-toggle">
        <input
          id={`${uid}-fitcanvas`}
          className="mm-checkbox"
          type="checkbox"
          checked={fitCanvas}
          disabled={disabled}
          onChange={(e) => setFitCanvas(e.target.checked)}
        />
        <label className="mm-field-label" htmlFor={`${uid}-fitcanvas`}>
          캔버스도 자른 크기에 맞추기
        </label>
      </div>
      <p className="mm-field-hint">
        끄면 잘라낸 여백이 프레임의 빈 공간으로 남아 결과물 크기가 그대로입니다.
      </p>

      {cropRect ? (
        <p className="mm-field-hint">
          자를 영역 {Math.round(cropRect.w)} x {Math.round(cropRect.h)} (원본 {natural.w} x{' '}
          {natural.h})
        </p>
      ) : null}

      {/* 적용 ------------------------------------------------------------- */}
      <div className="mm-prep-actions">
        <button
          type="button"
          className="mm-btn mm-btn-primary"
          disabled={disabled}
          onClick={handleApply}
        >
          {busy === '적용' ? '적용 중' : '적용'}
        </button>
        <button type="button" className="mm-btn" disabled={disabled} onClick={handleRevert}>
          되돌리기
        </button>
      </div>

      {applied ? (
        <p className="mm-note">
          적용했습니다. {applied.w} x {applied.h}
          {canvasBeforeRef.current ? ' (캔버스도 이 크기로 맞췄습니다)' : ' (문서 크기에도 반영됨)'}
        </p>
      ) : null}

      {notice ? <p className="mm-note">{notice}</p> : null}

      {error ? (
        <p className="mm-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  )
}

// ---------------------------------------------------------------------------

/**
 * 선택된 레이어의 원본 이미지를 다듬는다.
 * 인스펙터 본문에 그대로 끼워 넣을 수 있는 섹션 형태다.
 */
export function PrepPanel() {
  const layers = useDocumentStore((s) => s.doc.layers)
  const assets = useDocumentStore((s) => s.doc.assets)
  const selectedLayerId = useUiStore((s) => s.selectedLayerId)

  const layer = layers.find((l) => l.id === selectedLayerId) ?? null
  const asset = layer?.assetId ? (assets.find((a) => a.id === layer.assetId) ?? null) : null

  return (
    <section className="mm-section" aria-labelledby="mm-sec-prep">
      <h2 className="mm-section-title" id="mm-sec-prep">
        이미지 다듬기
      </h2>
      {asset ? (
        // key 를 주면 에셋이 바뀔 때 상태가 통째로 초기화된다.
        <PrepEditor key={asset.id} asset={asset} />
      ) : (
        <p className="mm-note">이미지 레이어를 선택하면 배경 제거와 크롭을 쓸 수 있습니다.</p>
      )}
    </section>
  )
}

export default PrepPanel
