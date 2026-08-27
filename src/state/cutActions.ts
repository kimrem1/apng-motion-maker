/**
 * 컷 패널이 문서를 바꾸는 유일한 통로.
 *
 * shapeActions.ts / textActions.ts 와 같은 역할이다. 컷 하나를 더하거나 지우면
 * 타임라인 길이와 레이어 구간이 함께 움직여야 한다. 그 짝을 UI 가 조립하면
 * 어느 한쪽만 반영된 상태가 문서로 남는다.
 */

import { cutRanges, cutsTotalFrames, CUT_FRAMES_MIN, type CutRange } from '@/core/cuts.ts'
import { FRAMES_MAX, type CutSpec, type MotionProject } from '@/core/types.ts'
import { useDocumentStore } from './document.ts'
import { useLayerUiStore } from './layerUi.ts'

/** 컷이 없는 문서를 컷 하나짜리로 본다. UI 가 언제나 목록을 그릴 수 있게 한다. */
export function cutsOf(doc: MotionProject): CutSpec[] {
  if (Array.isArray(doc.cuts) && doc.cuts.length > 0) return doc.cuts
  return [{ id: 'cut1', name: '컷 1', frames: doc.timeline.durationFrames, crossFrames: 0 }]
}

export function cutRangesOf(doc: MotionProject): CutRange[] {
  return cutRanges(cutsOf(doc))
}

/** 새 컷의 기본 길이. 지금 컷들의 평균을 따른다. 갑자기 다른 길이가 끼면 리듬이 깨진다. */
function defaultFrames(cuts: readonly CutSpec[]): number {
  if (cuts.length === 0) return 25
  const sum = cuts.reduce((a, c) => a + c.frames, 0)
  return Math.max(CUT_FRAMES_MIN, Math.round(sum / cuts.length))
}

/**
 * 클램프 전 총 길이. cutsTotalFrames 는 FRAMES_MAX 로 잘라 돌려주므로 예산 검사에
 * 못 쓴다. 잘린 값과 비교하면 초과분이 안 보인다.
 */
function rawTotalFrames(cuts: readonly CutSpec[]): number {
  const ranges = cutRanges(cuts)
  const last = ranges[ranges.length - 1]
  return last ? last.end + 1 : 0
}

/**
 * 총 길이가 FRAMES_MAX 를 넘으면 끝 컷부터 줄여서 예산 안에 맞춘다.
 *
 * duration 은 FRAMES_MAX 로 잘리는데 컷 구간은 그대로 남으면, 뒤 컷이 재생도
 * 내보내기도 도달하지 않는 유령 구간이 되고 거기 넣은 레이어는 영영 안 보인다.
 * 컷 목록과 duration 이 항상 일치해야 한다는 불변식을 여기 한 곳에서 지킨다.
 */
function fitToBudget(next: CutSpec[]): CutSpec[] {
  let out = next
  for (let guard = out.length; guard >= 0; guard -= 1) {
    const overflow = rawTotalFrames(out) - FRAMES_MAX
    if (overflow <= 0) return out
    let idx = -1
    for (let i = out.length - 1; i >= 0; i -= 1) {
      if (out[i]!.frames > CUT_FRAMES_MIN) {
        idx = i
        break
      }
    }
    // 전부 최소 길이면 더 줄일 수 없다. (addCut 이 예산을 지키므로 UI 로는 못 온다)
    if (idx < 0) return out
    const c = out[idx]!
    const frames = Math.max(CUT_FRAMES_MIN, c.frames - overflow)
    out = out.map((x, i) =>
      i === idx ? { ...x, frames, crossFrames: Math.min(x.crossFrames, frames - 1) } : x,
    )
  }
  return out
}

/**
 * 컷 목록을 통째로 갈아 끼우고 타임라인 길이를 맞춘다.
 *
 * 길이를 따로 세팅하면 실행취소가 두 칸 쌓이고 그 사이에 길이만 바뀐 문서가 남는다.
 */
function writeCuts(label: string, next: CutSpec[], coalesceKey?: string): void {
  const fitted = fitToBudget(next)
  useDocumentStore.getState().setCuts(fitted, cutsTotalFrames(fitted), label, coalesceKey)
}

let cutIdSeq = 0

/**
 * 컷을 하나 더한다. 예산(FRAMES_MAX)에 안 담기면 null 을 돌려주고 아무것도 하지
 * 않는다. 호출부가 그 사실을 사용자에게 알려야 한다.
 */
export function addCut(): string | null {
  const doc = useDocumentStore.getState().doc
  const cuts = cutsOf(doc)
  const remaining = FRAMES_MAX - rawTotalFrames(cuts)
  if (remaining < CUT_FRAMES_MIN) return null
  // Date.now 만으로는 같은 밀리초의 연속 추가가 같은 id 를 받는다. 카운터를 병기한다.
  const id = `cut${Date.now().toString(36)}${(cutIdSeq++).toString(36)}`
  const next: CutSpec[] = [
    ...cuts,
    {
      id,
      name: `컷 ${cuts.length + 1}`,
      frames: Math.min(defaultFrames(cuts), remaining),
      crossFrames: 0,
    },
  ]
  writeCuts('컷 추가', next)
  return id
}

export function removeCut(cutId: string): void {
  const doc = useDocumentStore.getState().doc
  const cuts = cutsOf(doc)
  // 마지막 한 컷은 지우지 않는다. 컷이 0 개인 문서는 재생할 것이 없다.
  if (cuts.length <= 1) return
  writeCuts(
    '컷 삭제',
    cuts.filter((c) => c.id !== cutId),
  )
}

export function setCutFrames(cutId: string, frames: number): void {
  const doc = useDocumentStore.getState().doc
  const cuts = cutsOf(doc)
  const apply = (want: number): CutSpec[] =>
    cuts.map((c) => (c.id === cutId ? { ...c, frames: want } : c))
  let want = Math.max(CUT_FRAMES_MIN, Math.min(FRAMES_MAX, Math.round(frames)))
  // 예산 초과분은 지금 만지는 컷이 흡수한다. writeCuts 의 안전망에 맡기면
  // 1번 컷을 늘렸는데 마지막 컷이 줄어드는 이상한 일이 생긴다.
  const overflow = rawTotalFrames(apply(want)) - FRAMES_MAX
  if (overflow > 0) want = Math.max(CUT_FRAMES_MIN, want - overflow)
  writeCuts('컷 길이 변경', apply(want), `cutFrames:${cutId}`)
}

export function setCutCross(cutId: string, crossFrames: number): void {
  const doc = useDocumentStore.getState().doc
  const cuts = cutsOf(doc)
  const target = cuts.find((c) => c.id === cutId)
  if (!target) return
  const apply = (cross: number): CutSpec[] =>
    cuts.map((c) => (c.id === cutId ? { ...c, crossFrames: cross } : c))
  let want = Math.max(0, Math.min(target.frames - 1, Math.round(crossFrames)))
  // 겹침을 줄이면 총 길이가 늘어난다. 예산을 넘기면 겹침 하한을 올려 막는다.
  const overflow = rawTotalFrames(apply(want)) - FRAMES_MAX
  if (overflow > 0) want = Math.min(target.frames - 1, want + overflow)
  writeCuts('컷 전환 변경', apply(want), `cutCross:${cutId}`)
}

export function setCutName(cutId: string, name: string): void {
  const doc = useDocumentStore.getState().doc
  const next = cutsOf(doc).map((c) => (c.id === cutId ? { ...c, name } : c))
  writeCuts('컷 이름 변경', next, `cutName:${cutId}`)
}

export function moveCut(cutId: string, direction: -1 | 1): void {
  const doc = useDocumentStore.getState().doc
  const cuts = [...cutsOf(doc)]
  const from = cuts.findIndex((c) => c.id === cutId)
  const to = from + direction
  if (from < 0 || to < 0 || to >= cuts.length) return
  const [moved] = cuts.splice(from, 1)
  if (moved) cuts.splice(to, 0, moved)
  writeCuts('컷 순서 변경', cuts)
}

/**
 * 고른 레이어를 이 컷에 넣는다.
 *
 * 컷의 겹침이 그대로 전환 시간이 된다. 앞 컷과 겹치면 그만큼 서서히 나타나고,
 * 다음 컷이 나를 덮으면 그만큼 서서히 사라진다.
 */
export function assignToCut(cutId: string, layerIds?: readonly string[]): number {
  const store = useDocumentStore.getState()
  const doc = store.doc
  const ranges = cutRangesOf(doc)
  const index = ranges.findIndex((r) => r.id === cutId)
  const range = ranges[index]
  if (!range) return 0

  const ids =
    layerIds && layerIds.length > 0 ? layerIds : useLayerUiStore.getState().selectedLayerIds
  if (ids.length === 0) return 0

  // 다음 컷이 나를 덮는 만큼이 내 퇴장 시간이다.
  const outFade = ranges[index + 1]?.crossFrames ?? 0
  store.setLayerRange(ids, {
    inFrame: range.start,
    outFrame: range.end,
    inFade: range.crossFrames,
    outFade,
  })
  return ids.length
}

/** 구간을 지운다. 그 레이어는 다시 처음부터 끝까지 보인다. */
export function clearCutAssignment(layerIds?: readonly string[]): number {
  const store = useDocumentStore.getState()
  const ids =
    layerIds && layerIds.length > 0 ? layerIds : useLayerUiStore.getState().selectedLayerIds
  if (ids.length === 0) return 0
  store.setLayerRange(ids, null)
  return ids.length
}
