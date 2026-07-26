/**
 * 프리셋을 문서에 심는 액션과 미리보기 오버라이드.
 *
 * document.ts 는 이 담당의 파일이 아니므로 새 액션을 넣지 않았다. 대신 기존 액션을
 * 조합한다. 트랙을 통째로 갈아끼울 때 replaceDocument 를 쓰면 안 된다. 그 액션은
 * past/future 를 비우기 때문에 프리셋 하나 눌렀다고 그때까지의 실행취소가 통째로
 * 날아간다. 그래서 setValueAtFrame 으로 새 키를 먼저 심고 남은 옛 키를
 * removeKeyframe 으로 지우는 순서를 쓴다. 순서를 뒤집으면 키가 0개인 순간이 생겨
 * removeKeyframe 이 (마지막 한 개는 지우지 않는 규칙 때문에) 조용히 실패한다.
 *
 * 이 방식의 한계는 아래 PresetApplyReport 주석에 적어 두었다. 통합 담당이 document.ts 에
 * applyPresetTracks 액션이 들어와 그 제약들은 사라졌다.
 */

import type { MotionProject, TrackProp } from '@/core/types.ts'
import { useDocumentStore } from '@/state/document.ts'
import { usePresetUiStore } from '@/state/presetUi.ts'
import { useUiStore } from '@/state/ui.ts'
import {
  applyPresetWithFps,
  finalFps,
  carryOverParams,
  withPresetApplied,
  type PresetApplyArgs,
  type PresetApplyResult,
} from '@/motions/apply.ts'

// ---------------------------------------------------------------------------
// 알려진 한계 (통합 담당용)
// ---------------------------------------------------------------------------

/**
 * 기존 액션 조합으로 옮기지 못하는 것들. UI 는 이 값을 배너로 알린다.
 *
 *   modifiers   흔들림/자글자글. document.ts 에 모디파이어를 쓰는 액션이 없다.
 *   composite   트랙의 합성 규칙(add/multiply)을 지정할 방법이 없다.
 *   unit        setValueAtFrame 은 TRACK_DEFAULTS 의 단위로 트랙을 만든다.
 *               px 계열은 여기서 환산해 넣지만 계열이 다르면 환산이 불가능하다.
 *   spring      스프링 파라미터를 그대로 넣을 수 없어 이징 프리셋으로 근사한다.
 *   presetRef   doc.presetRef 를 쓰는 액션이 없다. EASY 모드의 dirty 배지가 못 뜬다.
 *   history     키 하나당 실행취소 한 칸이 쌓인다. Ctrl+Z 를 여러 번 눌러야 한다.
 */
export interface PresetApplyReport {
  ok: boolean
  presetId: string
  layerId: string | null
  /** 실패했거나 일부만 적용됐을 때 사용자에게 보여줄 한국어 문장. */
  message: string | null
  skipped: {
    modifiers: number
    springKeys: number
    composite: TrackProp[]
    unit: TrackProp[]
  }
}

function emptySkipped(): PresetApplyReport['skipped'] {
  return { modifiers: 0, springKeys: 0, composite: [], unit: [] }
}

// ---------------------------------------------------------------------------
// 프리셋 고유 파라미터 보관
// ---------------------------------------------------------------------------

/**
 * PRO 의 파라미터 편집기가 들어오면 여기에 쌓인다. 지금은 프리셋 교체 규칙을
 * 실제로 강제하기 위한 보관소다. 강도/속도는 여기 들어오지 않는다. 그 둘은
 * presetUi 스토어의 공통 노브이고 프리셋을 갈아타도 유지된다.
 */
let presetParams: Record<string, unknown> = {}

export function getPresetParams(): Readonly<Record<string, unknown>> {
  return presetParams
}

export function setPresetParam(key: string, value: unknown): void {
  presetParams = { ...presetParams, [key]: value }
}

// ---------------------------------------------------------------------------
// 미리보기 오버라이드
// ---------------------------------------------------------------------------

/*
 * 호버/포커스 중에는 캔버스가 임시 문서를 그린다. 문서 스토어를 건드리지 않으므로
 * 탐색이 파괴적이지 않다.
 *
 * React Context 대신 모듈 스코프 레지스트리를 쓴다. 이유는 rendererHandle.ts 와
 * 같다. 프리뷰 캔버스는 리렌더를 최대한 피해야 하는 컴포넌트다.
 *
 * !! 통합 필요: ui/canvas/useRenderer.ts 가 이 값을 읽어야 미리보기가 화면에 뜬다.
 *    docRef.current = getPreviewDoc() ?? doc  로 바꾸고
 *    subscribePreviewDoc(() => { dirtyRef.current = true; requestRender() }) 를 건다.
 *    그 한 줄이 붙기 전까지는 카드 썸네일만 프리셋을 보여 준다.
 */

let previewDoc: MotionProject | null = null
let previewRevision = 0
const previewListeners = new Set<() => void>()

export function getPreviewDoc(): MotionProject | null {
  return previewDoc
}

/** useSyncExternalStore 용. 스냅샷이 객체면 매번 새 참조가 되어 무한 루프가 난다. */
export function getPreviewRevision(): number {
  return previewRevision
}

export function subscribePreviewDoc(listener: () => void): () => void {
  previewListeners.add(listener)
  return () => {
    previewListeners.delete(listener)
  }
}

function setPreviewDoc(doc: MotionProject | null): void {
  if (previewDoc === doc) return
  previewDoc = doc
  previewRevision += 1
  for (const listener of previewListeners) listener()
}

// ---------------------------------------------------------------------------
// 대상 레이어
// ---------------------------------------------------------------------------

/** 선택된 레이어가 없으면 맨 아래 레이어에 건다. 이미지 한 장 흐름에서 선택을 요구하면 안 된다. */
export function resolveTargetLayerId(): string | null {
  const selected = useUiStore.getState().selectedLayerId
  const layers = useDocumentStore.getState().doc.layers
  if (selected && layers.some((l) => l.id === selected)) return selected
  return layers[0]?.id ?? null
}

/**
 * 프리셋이 적용된 임시 문서. 호버 미리보기와 카드 썸네일이 같은 함수를 쓴다.
 * 계산에 실패하면(레이어 없음, 모르는 프리셋) null 이다. 던지지 않는다.
 * 호버 한 번에 예외가 올라오면 갤러리 전체가 죽는다.
 */
export function buildPresetDoc(presetId: string): MotionProject | null {
  const layerId = resolveTargetLayerId()
  if (!layerId) return null

  const { strength, speed, appliedId } = usePresetUiStore.getState()
  const doc = useDocumentStore.getState().doc
  try {
    // 반복 모드와 권장 fps 는 첫 적용에서만 따른다. 확정 적용과 같은 규칙을 써야
    // 미리보기에서 본 것과 눌렀을 때 나오는 것이 같다.
    const isFirstApply = appliedId === null
    const result = applyPresetWithFps(
      { doc, layerId, presetId, strength, speed, params: presetParams },
      isFirstApply,
    )
    if (!isFirstApply) delete result.suggestedLoop
    return withPresetApplied(doc, layerId, result)
  } catch {
    return null
  }
}

/** 호버/포커스 시작. presetId 가 null 이면 미리보기를 끈다. */
export function previewPreset(presetId: string | null): void {
  if (!presetId) {
    setPreviewDoc(null)
    return
  }
  setPreviewDoc(buildPresetDoc(presetId))
}

export function clearPreview(): void {
  setPreviewDoc(null)
}

// ---------------------------------------------------------------------------
// 단위 환산
// ---------------------------------------------------------------------------



// ---------------------------------------------------------------------------
// 확정 적용
// ---------------------------------------------------------------------------


/**
 * 계산 실패를 예외 대신 값으로 돌려준다.
 * try 블록 안에서만 대입하면 이후 코드에서 확정 대입 분석이 걸린다.
 */
function safeApply(
  args: PresetApplyArgs,
  allowFps: boolean,
): { ok: true; value: PresetApplyResult } | { ok: false; message: string } {
  try {
    return { ok: true, value: applyPresetWithFps(args, allowFps) }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : '모션을 적용하지 못했습니다.' }
  }
}

/**
 * 프리셋을 문서에 확정 적용한다. 클릭(또는 Enter)에서만 부른다.
 * 호버는 previewPreset 을 쓴다. 탐색이 문서를 바꾸면 안 된다.
 */
export function applyPresetToDocument(presetId: string): PresetApplyReport {
  const skipped = emptySkipped()
  const layerId = resolveTargetLayerId()
  if (!layerId) {
    return {
      ok: false,
      presetId,
      layerId: null,
      message: '먼저 이미지를 넣어 주세요.',
      skipped,
    }
  }

  const presetUi = usePresetUiStore.getState()
  // 프리셋 교체 시 공통 노브는 유지하고 고유 파라미터만 리셋한다.
  presetParams = carryOverParams({
    fromPresetId: presetUi.appliedId,
    toPresetId: presetId,
    params: presetParams,
  })

  // 반복 모드도 권장 fps 도 첫 적용에서만 따른다.
  const isFirstApply = presetUi.appliedId === null

  const store = useDocumentStore.getState()
  const attempt = safeApply(
    {
      doc: store.doc,
      layerId,
      presetId,
      strength: presetUi.strength,
      speed: presetUi.speed,
      params: presetParams,
    },
    isFirstApply,
  )
  if (!attempt.ok) {
    return { ok: false, presetId, layerId, message: attempt.message, skipped }
  }
  const result = attempt.value

  // 프리셋 한 번 적용 = 실행취소 한 칸. 키를 하나씩 심으면 undo 가 10~20칸 쌓이고
  // 모디파이어와 track.unit / composite 를 지정할 방법이 없다.
  // applyPresetTracks 는 트랙을 그대로 넣으므로 단위 변환도 필요 없다.
  useDocumentStore.getState().applyPresetTracks({
    layerId,
    presetId,
    tracks: result.tracks,
    modifiers: result.modifiers,
    // 이펙트를 정의한 프리셋만 스택을 대체한다. 정의하지 않은 프리셋에 빈 배열을
    // 넘기면 사용자가 직접 쌓아 둔 이펙트가 프리셋을 갈아탈 때마다 날아간다.
    ...(result.effects ? { effects: result.effects } : {}),
    durationFrames: result.durationFrames,
    // 반복 방식은 공통 노브다. 프리셋을 갈아탄다고 사용자가 고른 반복을
    // 덮으면 조정값을 날린다. 첫 적용에서만 제안을 따르고, 이후 어긋남은 이음새 검사기가 잡는다.
    ...(result.suggestedLoop && isFirstApply ? { loopMode: result.suggestedLoop } : {}),
    /*
     * 권장 fps.
     * 지지직 8종은 매 프레임 노이즈가 달라 델타 압축이 사실상 0 이다. 25fps 로 두면
     * 같은 길이에서 파일이 그냥 커진다. 프레임 수만 조이고 fps 축이 빠지면 통제가 반쪽이다.
     * 같은 변경 안에서 처리하므로 실행취소는 한 칸이다.
     */
    /*
     * fps 는 두 곳에서 요구한다. 프리셋 권장(용량 통제)과 속도 유도(길이 확보)다.
     * 우선순위 규칙은 finalFps 한 곳에만 두고, 둘 중 낮은 쪽을 쓴다.
     */
    ...(finalFps(result, store.doc.timeline.fps) !== store.doc.timeline.fps
      ? { fps: finalFps(result, store.doc.timeline.fps) }
      : {}),
    allowExit: result.allowExit,
    baseSec: result.baseSec,
    baseFps: result.baseFps,
    ...(result.containScale !== undefined ? { containScale: result.containScale } : {}),
    macro: { speed: presetUi.speed, strength: presetUi.strength },
  })

  skipped.modifiers = result.modifiers.length

  presetUi.markApplied(presetId)
  presetUi.pushRecent(presetId)
  clearPreview()

  return {
    ok: true,
    presetId,
    layerId,
    message: describeSkipped(skipped),
    skipped,
  }
}


/** 일부만 적용됐을 때만 문장을 만든다. 문제가 없으면 null 이라 배너가 안 뜬다. */
function describeSkipped(skipped: PresetApplyReport['skipped']): string | null {
  const parts: string[] = []
  if (skipped.modifiers > 0) parts.push('흔들림 같은 절차형 움직임')
  if (skipped.unit.length > 0) parts.push('일부 이동 값')
  if (skipped.composite.length > 0) parts.push('일부 합성 규칙')
  if (skipped.springKeys > 0) parts.push('스프링 세부 설정')
  if (parts.length === 0) return null
  return `${parts.join(', ')}은(는) 아직 적용되지 않았습니다.`
}
