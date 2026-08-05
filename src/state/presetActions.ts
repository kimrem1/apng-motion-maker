/**
 * 프리셋을 문서에 심는 액션과 미리보기 오버라이드.
 *
 * 적용은 document.ts 의 applyPresetTracks 한 번으로 끝낸다. 키를 하나씩 심으면
 * 프리셋 한 번에 실행취소가 열 칸 넘게 쌓이고, 모디파이어와 트랙의 단위 / 합성
 * 규칙을 지정할 방법도 없다. replaceDocument 는 past/future 를 비우므로 쓰지 않는다.
 * 프리셋 하나 눌렀다고 그때까지의 실행취소가 통째로 날아가면 안 된다.
 */

import type { MotionProject } from '@/core/types.ts'
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
// 적용 결과
// ---------------------------------------------------------------------------

export interface PresetApplyReport {
  ok: boolean
  presetId: string
  layerId: string | null
  /** 실패했을 때 사용자에게 보여줄 한국어 문장. 성공하면 null 이다. */
  message: string | null
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
    // 확정 적용(applyPresetToDocument)의 shouldFollowLoopSuggestion 과 같은 규칙이다.
    if (!isFirstApply || !shouldFollowLoopSuggestion(doc)) delete result.suggestedLoop
    return withPresetApplied(doc, layerId, result)
  } catch {
    return null
  }
}

/**
 * 프리셋의 반복 제안을 따라도 되는가.
 *
 * 첫 적용 전에 사용자가 반복 라디오를 이미 만졌다면(공장 기본값 'loop' 가 아니면)
 * 그 선택이 이긴다. "사용자가 고른 반복을 덮으면 조정값을 날린다" 는 아래 규칙을
 * 첫 적용이라고 예외로 두면, '한 번만' 을 먼저 고르고 프리셋을 누른 사용자의
 * 선택이 소리 없이 뒤집힌다.
 */
function shouldFollowLoopSuggestion(doc: MotionProject): boolean {
  return doc.timeline.loop.mode === 'loop'
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
  const layerId = resolveTargetLayerId()
  if (!layerId) {
    return {
      ok: false,
      presetId,
      layerId: null,
      message: '먼저 이미지나 도형을 넣어 주세요.',
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
    return { ok: false, presetId, layerId, message: attempt.message }
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
    // 반복 방식은 공통 노브다. 프리셋을 갈아탄다고 사용자가 고른 반복을 덮으면
    // 조정값을 날린다. 제안은 첫 적용, 그것도 사용자가 반복을 아직 안 만졌을 때만
    // 따른다 (shouldFollowLoopSuggestion).
    ...(result.suggestedLoop && isFirstApply && shouldFollowLoopSuggestion(store.doc)
      ? { loopMode: result.suggestedLoop }
      : {}),
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
    /*
     * 가리기와 원근은 조건부로 넘기지 않는다.
     *
     * 이펙트와 반대다. 이 둘은 프리셋에서 파생된 사실이므로 값이 없으면 "지우라"는
     * 뜻이고, 스토어가 그렇게 처리한다. 여기서 키를 빼면 앞 프리셋이 걸어 둔
     * 경계선이 다음 프리셋에도 그대로 남아 그림이 계속 잘린다.
     */
    reveal: result.reveal,
    charAnim: result.charAnim,
    perspective: result.perspective,
    // 기준점도 같은 규칙이다. 값이 없으면 "한가운데로 되돌리라" 는 뜻이다.
    anchor: result.anchor,
    macro: { speed: presetUi.speed, strength: presetUi.strength },
  })

  presetUi.markApplied(presetId)
  presetUi.pushRecent(presetId)
  clearPreview()

  return { ok: true, presetId, layerId, message: null }
}


/**
 * 지금 걸린 프리셋을 걷어낸다. 같은 카드를 한 번 더 누르는 경로다.
 *
 * 프리셋이 심은 것만 지운다. 사용자가 인스펙터에서 직접 만든 트랙과 이펙트는
 * 살아남는다. 규칙은 프리셋을 갈아탈 때와 한 글자도 다르지 않다 (motions/merge.ts).
 */
export function clearAppliedPreset(): PresetApplyReport {
  const presetId = usePresetUiStore.getState().appliedId
  const doc = useDocumentStore.getState().doc
  if (!presetId || !doc.presetRef) {
    return { ok: false, presetId: presetId ?? '', layerId: null, message: null }
  }

  const layerId = doc.presetRef.layerId ?? null
  useDocumentStore.getState().clearPreset()
  usePresetUiStore.getState().markApplied(null)
  presetParams = {}
  clearPreview()

  return { ok: true, presetId, layerId, message: '모션을 뺐습니다.' }
}

// ---------------------------------------------------------------------------
// 속도/세기 실시간 재적용
// ---------------------------------------------------------------------------

/**
 * 슬라이더 드래그 중 재적용 최소 간격 (트레일링 스로틀).
 *
 * 매 onChange 마다 적용하면 프리셋 emit + 담기 솔버(240 샘플)가 입력 주기로 돌아
 * 드래그가 버벅인다. 디바운스가 아니라 스로틀이어야 한다. 디바운스는 연속으로
 * 끄는 동안 타이머가 계속 리셋되어 손을 멈추기 전까지 한 번도 발화하지 않는다.
 * 스로틀은 마지막 적용 시각 기준으로 이 간격마다 발화해 드래그를 실시간으로 따라간다.
 *
 * 이 간격이 applyPresetTracks 의 coalesce 창(500ms)보다 짧으므로 연속 드래그의
 * 적용들은 실행취소 한 칸으로 합쳐진다. 드래그 중 손을 500ms 이상 완전히 멈췄다
 * 다시 끌면 새 칸이 생기는데, 이는 앱의 다른 드래그 컨트롤(키프레임 이동 등)과
 * 같은 coalesce 규칙이다.
 */
export const LIVE_REAPPLY_MS = 140

let liveTimer: ReturnType<typeof setTimeout> | null = null
/** 마지막 라이브 적용 시각. 스로틀 발화 간격의 기준점이다. */
let liveLastAppliedAt = 0
/**
 * 마지막 적용 이후 노브가 실제로 움직였는가.
 *
 * commitMacroNow 의 발화 조건이다. pointerup / keyup / blur 는 값 변경 없이도
 * 발생한다 (Tab 으로 슬라이더에 들어올 때의 keyup, 제자리 클릭, 포커스 이동).
 * "문서 macro != 노브" 를 조건으로 쓰면 undo 직후(macro 만 되돌아가고 노브는
 * 그대로인 상태)에 슬라이더를 스치기만 해도 재적용이 일어나 방금 한 실행취소를
 * 조용히 되감고 redo 스택까지 지운다. 그래서 "사용자가 노브를 움직였다" 는
 * 사실 자체를 들고 있어야 한다.
 */
let livePending = false

/** 지금 재적용해도 되는가. 되면 프리셋 id, 아니면 null. */
function reapplyTargetId(): string | null {
  const id = usePresetUiStore.getState().appliedId
  if (!id) return null
  const doc = useDocumentStore.getState().doc
  /*
   * presetRef 가 없으면 이 문서에 얹힌 프리셋이 없다는 뜻이다. 재적용할 것이 없다.
   *
   * appliedId 는 화면 상태라 문서와 따로 논다. Ctrl+Z 로 적용을 되감거나 다른
   * 프로젝트를 열면 presetRef 만 사라지고 appliedId 는 남는다. 그 상태에서
   * 아래 검사들은 전부 `?.` 라 조용히 통과하고, 슬라이더를 스치는 것만으로 앞
   * 문서의 모션이 지금 고른 레이어에 심겼다. 가드가 통째로 죽어 있던 자리다.
   */
  if (!doc.presetRef) return null
  // PRO 에서 손본 문서에 재적용하면 그 편집이 조용히 사라진다.
  // 그 길은 [프리셋으로 리셋] 버튼 하나만 연다.
  if (doc.presetRef.dirty === true) return null

  /*
   * 재적용은 프리셋이 실제로 얹힌 레이어에만 한다.
   *
   * resolveTargetLayerId 는 "지금 고른 레이어" 를 돌려준다. 그래서 도형을 하나 넣어
   * 선택이 옮겨간 뒤 세기 슬라이더를 끌면, 이미지에 걸린 모션이 도형 위에 다시 심겨
   * 이미지는 멈추고 도형이 혼자 튀어오른다. presetRef.layerId 가 진실이다.
   *
   * props 로 역추적하던 옛 방식은 트랙을 내지 않는 프리셋(흔들기/자글자글/지지직
   * 19종)에서 props 가 빈 배열이라 검사 자체가 건너뛰어졌다.
   */
  const owner = doc.presetRef?.layerId
  if (owner !== undefined) {
    if (!doc.layers.some((l) => l.id === owner)) return null
    if (resolveTargetLayerId() !== owner) return null
    return id
  }

  // layerId 가 없는 옛 프로젝트만 props 로 근사한다.
  const props = doc.presetRef?.props
  if (props && props.length > 0) {
    const layerId = resolveTargetLayerId()
    const layer = layerId ? doc.layers.find((l) => l.id === layerId) : undefined
    if (!layer) return null
    const owned = new Set(layer.tracks.map((t) => t.prop))
    if (!props.every((prop) => owned.has(prop))) return null
  }
  return id
}

/**
 * 라이브 재적용 한 번. 적용이 hover 미리보기를 지우므로(clearPreview),
 * 아직 호버 중이면 새 문서 기준으로 미리보기를 다시 얹는다. 안 그러면 카드 위에
 * 마우스를 둔 채 슬라이더를 조정하는 순간 미리보기가 사라지고, mouseenter 가
 * 다시 오지 않아 카드를 떠났다 돌아오기 전까지 복구되지 않는다.
 */
function applyLive(id: string): PresetApplyReport {
  const report = applyPresetToDocument(id)
  const hovered = usePresetUiStore.getState().hoveredId
  if (hovered) previewPreset(hovered)
  return report
}

/**
 * 속도/세기 노브가 움직일 때 부른다. 스로틀 간격으로 현재 프리셋을 같은 노브
 * 값으로 다시 적용한다. 프리셋을 다시 클릭할 필요가 없다.
 */
export function reapplyAppliedPresetSoon(): void {
  if (reapplyTargetId() === null) return
  livePending = true
  if (liveTimer !== null) return // 이미 발화가 예약돼 있다. 리셋하지 않는다 (스로틀).
  const wait = Math.max(0, LIVE_REAPPLY_MS - (Date.now() - liveLastAppliedAt))
  liveTimer = setTimeout(() => {
    liveTimer = null
    liveLastAppliedAt = Date.now()
    const id = reapplyTargetId()
    if (!id || !livePending) return
    livePending = false
    applyLive(id)
  }, wait)
}

/**
 * 드래그가 끝났을 때(포인터업/키업/블러) 부른다. 대기 중인 재적용을 지금 확정한다.
 * 노브가 실제로 움직인 적이 없으면(livePending false) 아무것도 하지 않는다.
 */
export function commitMacroNow(): PresetApplyReport | null {
  if (liveTimer !== null) {
    clearTimeout(liveTimer)
    liveTimer = null
  }
  if (!livePending) return null
  const id = reapplyTargetId()
  if (!id) return null
  livePending = false
  // 마지막 스로틀 발화가 이미 최종 값을 적용했으면 문서가 노브와 같다. 그때는
  // 재적용해도 트랙 id 만 갈리는 무의미한 변경이 생기므로 건너뛴다.
  const macro = useDocumentStore.getState().doc.presetRef?.macro
  const ui = usePresetUiStore.getState()
  if (macro && macro.speed === ui.speed && macro.strength === ui.strength) return null
  liveLastAppliedAt = Date.now()
  return applyLive(id)
}

