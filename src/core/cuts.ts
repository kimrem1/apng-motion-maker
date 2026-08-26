/**
 * 컷의 값 규칙.
 *
 * 컷은 별도 문서가 아니라 한 타임라인 위의 구간이다
 *
 * 컷마다 문서를 따로 두면 렌더러 / 오버스캔 / 내보내기 / 그래프 에디터가 전부
 * "지금 어느 문서인가" 를 알아야 한다. 대신 컷을 시간 구간으로 두면 엔진은
 * 아무것도 몰라도 되고, 컷에 넣는다는 것은 레이어의 구간을 그 범위로 맞추는 일이 된다.
 *
 * 총 길이 = 컷 길이의 합 - 겹침의 합. 겹침(crossFrames)이 곧 전환 시간이다.
 *
 * DOM 도 WebGL 도 참조하지 않는다.
 */

import type { CutSpec, Layer, MotionProject } from './types.ts'
import { FRAMES_MAX } from './types.ts'

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v)

/** 컷 하나의 최소 길이. 두 프레임은 있어야 시작과 끝이 구별된다. */
export const CUT_FRAMES_MIN = 2

export interface CutRange {
  id: string
  name: string
  /** 첫 프레임. */
  start: number
  /** 마지막 프레임. 포함이다. */
  end: number
  /** 앞 컷과 겹치는 프레임 수. */
  crossFrames: number
  index: number
}

export function normalizeCut(raw: Partial<CutSpec> & { id?: unknown }, index: number): CutSpec {
  const num = (v: unknown, fallback: number, lo: number, hi: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? clamp(Math.round(v), lo, hi) : fallback
  const frames = num(raw.frames, 25, CUT_FRAMES_MIN, FRAMES_MAX)
  return {
    id: typeof raw.id === 'string' && raw.id.length > 0 ? raw.id : `cut${index + 1}`,
    name: typeof raw.name === 'string' && raw.name.length > 0 ? raw.name : `컷 ${index + 1}`,
    frames,
    // 겹침이 컷 길이를 넘으면 컷이 사라진다. 한 프레임은 남긴다.
    crossFrames: num(raw.crossFrames, 0, 0, Math.max(0, frames - 1)),
  }
}

/**
 * 컷 목록을 실제 프레임 구간으로 편다.
 *
 * 첫 컷의 겹침은 무시한다. 앞에 겹칠 것이 없다.
 */
export function cutRanges(cuts: readonly CutSpec[]): CutRange[] {
  const out: CutRange[] = []
  let cursor = 0
  for (let i = 0; i < cuts.length; i += 1) {
    const cut = cuts[i]!
    const cross = i === 0 ? 0 : Math.min(cut.crossFrames, Math.max(0, cut.frames - 1))
    const start = Math.max(0, cursor - cross)
    const end = start + Math.max(CUT_FRAMES_MIN, cut.frames) - 1
    out.push({ id: cut.id, name: cut.name, start, end, crossFrames: cross, index: i })
    cursor = end + 1
  }
  return out
}

/** 컷 전부를 이어 붙인 총 길이(프레임). 컷이 없으면 0 이다. */
export function cutsTotalFrames(cuts: readonly CutSpec[]): number {
  const ranges = cutRanges(cuts)
  const last = ranges[ranges.length - 1]
  return last ? clamp(last.end + 1, CUT_FRAMES_MIN, FRAMES_MAX) : 0
}

/** 이 프레임이 속한 컷. 겹침 구간에서는 **뒤 컷**이 이긴다(전환이 그쪽으로 간다). */
export function cutAtFrame(cuts: readonly CutSpec[], frame: number): CutRange | null {
  const ranges = cutRanges(cuts)
  for (let i = ranges.length - 1; i >= 0; i -= 1) {
    const r = ranges[i]!
    if (frame >= r.start && frame <= r.end) return r
  }
  return null
}

/**
 * 이 레이어가 지금 프레임에서 얼마나 보이는가. 0 이면 아예 안 그린다.
 *
 * 구간이 없으면 언제나 1 이다. **옛 문서의 픽셀은 한 점도 바뀌지 않는다.**
 * 페이드는 구간 안쪽으로만 먹는다. 밖으로 번지면 앞 컷의 끝을 침범한다.
 */
export function layerTimeGate(
  layer: Pick<Layer, 'inFrame' | 'outFrame' | 'inFade' | 'outFade'>,
  frame: number,
): number {
  const hasIn = typeof layer.inFrame === 'number' && Number.isFinite(layer.inFrame)
  const hasOut = typeof layer.outFrame === 'number' && Number.isFinite(layer.outFrame)
  if (!hasIn && !hasOut) return 1

  const start = hasIn ? Math.round(layer.inFrame!) : Number.NEGATIVE_INFINITY
  const end = hasOut ? Math.round(layer.outFrame!) : Number.POSITIVE_INFINITY
  if (frame < start || frame > end) return 0

  let gate = 1

  const inFade = typeof layer.inFade === 'number' && layer.inFade > 0 ? Math.round(layer.inFade) : 0
  if (hasIn && inFade > 0) {
    // 첫 프레임이 0 이 되면 컷 전환에서 한 프레임이 통째로 빈다. 1/(n+1) 부터 시작한다.
    const t = (frame - start + 1) / (inFade + 1)
    gate = Math.min(gate, clamp(t, 0, 1))
  }

  const outFade =
    typeof layer.outFade === 'number' && layer.outFade > 0 ? Math.round(layer.outFade) : 0
  if (hasOut && outFade > 0) {
    const t = (end - frame + 1) / (outFade + 1)
    gate = Math.min(gate, clamp(t, 0, 1))
  }

  return gate
}

/** 문서에 컷이 실제로 있는가. 빈 배열은 없는 것과 같다. */
export function hasCuts(doc: Pick<MotionProject, 'cuts'>): boolean {
  return Array.isArray(doc.cuts) && doc.cuts.length > 0
}

/**
 * 레이어가 보이는 구간을 프레임 두 개로 편다.
 *
 * 구간이 없는 레이어는 처음부터 끝까지 보인다. explicit 이 거짓이면 문서에 값이
 * 없다는 뜻이고, 화면은 그걸 "전체" 로 표시해야 한다. 그 구분이 없으면 구간을
 * 한 번도 손대지 않은 레이어와 우연히 전 구간으로 맞춰 둔 레이어가 같아 보인다.
 */
export function layerRange(
  layer: Pick<Layer, 'inFrame' | 'outFrame'>,
  durationFrames: number,
): { start: number; end: number; explicit: boolean } {
  const last = Math.max(0, Math.round(durationFrames) - 1)
  const hasIn = typeof layer.inFrame === 'number' && Number.isFinite(layer.inFrame)
  const hasOut = typeof layer.outFrame === 'number' && Number.isFinite(layer.outFrame)
  if (!hasIn && !hasOut) return { start: 0, end: last, explicit: false }
  const start = clamp(hasIn ? Math.round(layer.inFrame!) : 0, 0, last)
  const end = clamp(hasOut ? Math.round(layer.outFrame!) : last, start, last)
  return { start, end, explicit: true }
}

/**
 * 구간 하나를 count 토막으로 나눈다.
 *
 * 눈 깜빡임처럼 그림 여러 장을 딱딱 바꿔 끼울 때 쓴다. 토막끼리 한 프레임도
 * 겹치지 않고 사이도 비지 않아야 한다. 겹치면 두 장이 동시에 보이고, 비면 그
 * 프레임에 아무것도 없다.
 *
 * 나머지는 앞 토막부터 한 프레임씩 가져간다. 뒤에 몰아주면 마지막 그림만 길게
 * 남아 리듬이 끝에서 무너진다.
 *
 * 프레임 수가 토막 수보다 적으면 만들 수 있는 만큼만 돌려준다. 길이 0 짜리
 * 구간은 문서에 쓸 수 없기 때문이다. 호출부가 개수를 보고 알려야 한다.
 */
export function splitRange(
  count: number,
  start: number,
  end: number,
): { start: number; end: number }[] {
  const first = Math.max(0, Math.round(start))
  const last = Math.max(first, Math.round(end))
  const total = last - first + 1
  const n = Math.max(1, Math.min(Math.floor(count), total))
  const base = Math.floor(total / n)
  const extra = total % n

  const out: { start: number; end: number }[] = []
  let cursor = first
  for (let i = 0; i < n; i += 1) {
    const len = base + (i < extra ? 1 : 0)
    out.push({ start: cursor, end: cursor + len - 1 })
    cursor += len
  }
  return out
}
