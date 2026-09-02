/**
 * 레이어 구간(있다 없다) 조작.
 *
 * 컷 패널의 cutActions.ts 와 같은 자리다. 저쪽은 "컷을 만들고 거기에 레이어를
 * 넣는다" 이고, 이쪽은 컷 없이 타임라인 위에서 직접 구간을 잡는 길이다.
 *
 * 왜 컷을 거치지 않는 길이 따로 필요한가
 *
 * 눈 깜빡임이 그 예다. 눈뜬 / 반눈 / 감은 그림 세 장을 몇 프레임씩 번갈아 보여
 * 주는 편집인데, 이걸 컷으로 만들면 컷이 세 개 생기고 타임라인 길이가 컷 길이의
 * 합으로 묶인다. 사용자가 원하는 것은 한 타임라인 위에서 그림만 바꿔 끼우는
 * 것이다. 구간은 원래 레이어의 필드이므로(core/types.ts inFrame/outFrame) 컷을
 * 만들지 않고도 그 일을 할 수 있다.
 *
 * 페이드는 여기서 만들지 않는다. 기본이 0 이라 구간 경계에서 딱 끊긴다
 * (core/cuts.ts layerTimeGate). 깜빡임은 서서히 바뀌면 안 된다.
 */

import { splitRange } from '@/core/cuts.ts'
import { useDocumentStore } from './document.ts'

/** 새 구간의 기본 길이. 전체의 1/4 이되 두 프레임 아래로는 내려가지 않는다. */
export function defaultRangeFrames(durationFrames: number): number {
  return Math.max(2, Math.round(durationFrames / 4))
}

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v)

/** 이 문서의 마지막 프레임 번호. */
function lastFrame(): number {
  return Math.max(0, useDocumentStore.getState().doc.timeline.durationFrames - 1)
}

/**
 * 시작 프레임을 정한다. 끝은 그대로 둔다.
 *
 * 구간이 아직 없는 레이어는 여기서 처음 생긴다. 끝은 문서 끝이 된다.
 */
export function setRangeStart(layerIds: readonly string[], frame: number): number {
  const store = useDocumentStore.getState()
  const last = lastFrame()
  const at = clamp(Math.round(frame), 0, last)
  const entries = layerIds
    .map((id) => {
      const layer = store.doc.layers.find((l) => l.id === id)
      if (!layer) return null
      const end = typeof layer.outFrame === 'number' ? Math.min(layer.outFrame, last) : last
      return { layerId: id, inFrame: at, outFrame: Math.max(at, end) }
    })
    .filter((e): e is { layerId: string; inFrame: number; outFrame: number } => e !== null)
  store.setLayerRanges(entries, '구간 시작 변경')
  return entries.length
}

/**
 * 끝 프레임을 정한다. 시작은 그대로 둔다.
 *
 * 재생헤드는 프레임 칸의 왼쪽 변에 서 있는 점이다. 시작은 그 점부터 보이고,
 * 끝은 그 점까지만 보인다. 그래서 저장되는 outFrame(포함)은 재생헤드 프레임의
 * 한 칸 앞이다. 재생헤드 프레임 자체를 넣으면 막대 오른끝이 재생헤드 선보다
 * 한 칸 뒤에 그려져, 시작 괄호와 끝 괄호가 서로 다른 자리에 맞는 것처럼 보인다.
 */
export function setRangeEnd(layerIds: readonly string[], frame: number): number {
  const store = useDocumentStore.getState()
  const last = lastFrame()
  const at = clamp(Math.round(frame), 0, last)
  /*
   * 구간은 한 프레임보다 짧아질 수 없다. 0 프레임에서 누르면 첫 칸 하나가 남는다.
   * 마지막 프레임에서 누르면 끝까지 다 넣는다. 재생헤드는 마지막 칸 너머로 갈 수
   * 없어서, 여기서도 한 칸을 빼면 마지막 프레임을 포함시킬 방법이 아예 없어진다.
   */
  const end = at >= last ? last : Math.max(0, at - 1)
  const entries = layerIds
    .map((id) => {
      const layer = store.doc.layers.find((l) => l.id === id)
      if (!layer) return null
      const start = typeof layer.inFrame === 'number' ? clamp(layer.inFrame, 0, last) : 0
      return { layerId: id, inFrame: Math.min(start, end), outFrame: end }
    })
    .filter((e): e is { layerId: string; inFrame: number; outFrame: number } => e !== null)
  store.setLayerRanges(entries, '구간 끝 변경')
  return entries.length
}

/** 구간을 지운다. 그 레이어는 다시 처음부터 끝까지 보인다. */
export function clearRanges(layerIds: readonly string[]): number {
  if (layerIds.length === 0) return 0
  useDocumentStore.getState().setLayerRange(layerIds, null)
  return layerIds.length
}

/**
 * 고른 레이어들을 순서대로 겹치지 않게 나눈다.
 *
 * 눈 깜빡임이 한 번에 되는 길이다. 눈뜬 / 반눈 / 감은 세 장을 고르고 부르면
 * 전체 구간이 삼등분되어 각자 자기 토막에만 있는다. 한 프레임도 겹치지 않으므로
 * 두 장이 동시에 보이는 프레임이 없고, 페이드도 만들지 않아 딱딱 넘어간다.
 *
 * 순서는 호출자가 넘긴 그대로다. 레이어 패널이 보이는 순서(위가 앞)로 넘기므로
 * 목록의 위가 먼저 나온다.
 *
 * 프레임이 모자라면 만들 수 있는 만큼만 만들고 그 수를 돌려준다. 길이 0 짜리
 * 구간은 문서에 쓸 수 없기 때문이다. 호출부가 그 수를 보고 사용자에게 알린다.
 */
export function splitSequential(
  layerIds: readonly string[],
  options?: { start?: number; end?: number },
): number {
  if (layerIds.length === 0) return 0
  const store = useDocumentStore.getState()
  const last = lastFrame()
  const start = clamp(Math.round(options?.start ?? 0), 0, last)
  const end = clamp(Math.round(options?.end ?? last), start, last)

  const blocks = splitRange(layerIds.length, start, end)
  const entries = blocks.map((block, i) => ({
    layerId: layerIds[i]!,
    inFrame: block.start,
    outFrame: block.end,
  }))
  // 페이드를 지우고 쓴다. 남아 있으면 경계가 물러진다. 깜빡임은 딱 끊겨야 한다.
  store.setLayerRanges(entries, '차례로 나누기', { clearFades: true })
  return entries.length
}

/**
 * 이 레이어들을 이 프레임에서 시작하게 놓는다. 레이어 패널에서 끌어다 놓는 길이다.
 *
 * 길이는 장마다 지금 구간의 길이를 그대로 쓴다. 구간이 없으면 기본 길이다. 끌어
 * 놓는 조작에서 길이까지 달라지면 여러 장을 차례로 놓는 동안 리듬이 어긋난다.
 * 여러 장을 한꺼번에 놓아도 실행취소는 한 칸이다.
 */
export function dropRangesAt(layerIds: readonly string[], frame: number): number {
  const store = useDocumentStore.getState()
  const last = lastFrame()
  const entries: { layerId: string; inFrame: number; outFrame: number }[] = []

  for (const layerId of layerIds) {
    const layer = store.doc.layers.find((l) => l.id === layerId)
    if (!layer) continue
    const hasRange =
      typeof layer.inFrame === 'number' &&
      typeof layer.outFrame === 'number' &&
      Number.isFinite(layer.inFrame) &&
      Number.isFinite(layer.outFrame)
    const span = hasRange
      ? Math.max(1, layer.outFrame! - layer.inFrame! + 1)
      : defaultRangeFrames(last + 1)
    const start = clamp(Math.round(frame), 0, Math.max(0, last - span + 1))
    entries.push({ layerId, inFrame: start, outFrame: Math.min(last, start + span - 1) })
  }

  if (entries.length === 0) return 0
  store.setLayerRanges(entries, '타임라인에 놓기')
  return entries.length
}
