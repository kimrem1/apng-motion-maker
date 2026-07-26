/**
 * cubic-bezier 이징.
 *
 * P0 = (0,0), P3 = (1,1) 고정. 사용자가 만지는 것은 P1 = (x1,y1), P2 = (x2,y2) 다.
 *
 * x 축은 [0,1] 로 클램프한다. 그러면
 *   dx/du = 3[x1(1-u)^2 + 2(x2-x1)u(1-u) + (1-x2)u^2] >= 0
 * 이 항상 성립해 x(u) 가 단조 증가하고, 역산 실패가 구조적으로 불가능해진다.
 * y 는 클램프하지 않는다. 오버슈트를 허용해야 쫀득한 모션이 나온다.
 *
 * 경로가 둘이다.
 *   - 편집 경로: LUT + 선형 보간. 초당 수천 번 불리고 오차 1e-4 면 충분하다.
 *   - 베이킹 경로: LUT 없이 정확 평가. 프레임 수만큼만 불린다.
 */

const NEWTON_ITERATIONS = 4
const NEWTON_MIN_SLOPE = 0.001
const SUBDIVISION_PRECISION = 1e-7
const SUBDIVISION_MAX_ITERATIONS = 10

/** 편집용 LUT 크기. 진동이 심한 곡선은 계산 쪽에서 크기를 올린다. */
const LUT_SIZE = 129

// Bernstein 전개 계수. calcBezier(t) = ((A t + B) t + C) t
function coefA(a1: number, a2: number): number {
  return 1 - 3 * a2 + 3 * a1
}
function coefB(a1: number, a2: number): number {
  return 3 * a2 - 6 * a1
}
function coefC(a1: number): number {
  return 3 * a1
}

export function calcBezier(t: number, a1: number, a2: number): number {
  return ((coefA(a1, a2) * t + coefB(a1, a2)) * t + coefC(a1)) * t
}

export function getSlope(t: number, a1: number, a2: number): number {
  return 3 * coefA(a1, a2) * t * t + 2 * coefB(a1, a2) * t + coefC(a1)
}

function newtonRaphson(x: number, guessT: number, x1: number, x2: number): number {
  let t = guessT
  for (let i = 0; i < NEWTON_ITERATIONS; i++) {
    const slope = getSlope(t, x1, x2)
    if (slope === 0) return t
    t -= (calcBezier(t, x1, x2) - x) / slope
  }
  return t
}

function binarySubdivide(x: number, lo: number, hi: number, x1: number, x2: number): number {
  let a = lo
  let b = hi
  let t = 0
  let value = 0
  let i = 0
  do {
    t = a + (b - a) / 2
    value = calcBezier(t, x1, x2) - x
    if (value > 0) b = t
    else a = t
    i += 1
  } while (Math.abs(value) > SUBDIVISION_PRECISION && i < SUBDIVISION_MAX_ITERATIONS)
  return t
}

export const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v)

export interface BezierEasing {
  (x: number): number
  readonly x1: number
  readonly y1: number
  readonly x2: number
  readonly y2: number
}

/**
 * 정확 평가용 이징 함수. LUT 를 쓰지 않는다.
 * 내보내기 프레임을 구울 때 이걸 쓴다.
 */
export function createBezierEasing(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): BezierEasing {
  const cx1 = clamp01(x1)
  const cx2 = clamp01(x2)

  // 항등 곡선이면 계산 자체를 건너뛴다.
  const linear = cx1 === y1 && cx2 === y2

  const sampleSize = needsDenseLut(y1, y2) ? LUT_SIZE * 2 - 1 : LUT_SIZE
  const step = 1 / (sampleSize - 1)
  const samples = new Float32Array(sampleSize)
  if (!linear) {
    for (let i = 0; i < sampleSize; i++) samples[i] = calcBezier(i * step, cx1, cx2)
  }

  function getTForX(x: number): number {
    // LUT 로 구간을 좁힌 뒤 뉴턴랩슨, 기울기가 죽으면 이분탐색으로 폴백한다.
    let interval = 0
    const last = sampleSize - 1
    while (interval !== last && samples[interval + 1]! <= x) interval += 1
    if (interval === last) interval = last - 1

    const start = samples[interval]!
    const end = samples[interval + 1]!
    const dist = (x - start) / (end - start)
    const guessT = (interval + dist) * step

    const initialSlope = getSlope(guessT, cx1, cx2)
    if (initialSlope >= NEWTON_MIN_SLOPE) return newtonRaphson(x, guessT, cx1, cx2)
    if (initialSlope === 0) return guessT
    return binarySubdivide(x, interval * step, (interval + 1) * step, cx1, cx2)
  }

  const fn = ((x: number): number => {
    if (linear) return x
    // 끝점은 하드코딩한다. 부동소수 오차로 마지막 프레임이 1 에 못 미치면
    // 루프 이음새가 눈에 띈다.
    if (x <= 0) return 0
    if (x >= 1) return 1
    return calcBezier(getTForX(x), y1, y2)
  }) as { (x: number): number; x1?: number; y1?: number; x2?: number; y2?: number }

  fn.x1 = cx1
  fn.y1 = y1
  fn.x2 = cx2
  fn.y2 = y2
  return fn as BezierEasing
}

/**
 * x 좌표에 대응하는 베지어 파라미터 t 를 구한다.
 *
 * x(t) 는 t 에 대해 선형이 아니다. 곡선 위 특정 x 지점을 다룰 때
 * t = x 로 두면 엉뚱한 곳을 집는다. 키프레임 삽입이 대표적인 경우다.
 */
export function bezierTForX(x: number, x1: number, x2: number): number {
  const cx1 = clamp01(x1)
  const cx2 = clamp01(x2)
  if (x <= 0) return 0
  if (x >= 1) return 1

  // x 가 [0,1] 로 클램프되어 단조가 보장되므로 이분탐색이 항상 수렴한다.
  let t = binarySubdivide(x, 0, 1, cx1, cx2)
  // 뉴턴으로 정밀도를 올린다. 기울기가 죽은 구간이면 이분탐색 결과를 그대로 쓴다.
  if (getSlope(t, cx1, cx2) >= NEWTON_MIN_SLOPE) t = newtonRaphson(x, t, cx1, cx2)
  return t
}

/** elastic 처럼 y 가 크게 벗어나는 곡선은 LUT 를 촘촘히 잡는다. */
function needsDenseLut(y1: number, y2: number): boolean {
  return y1 < -0.2 || y1 > 1.2 || y2 < -0.2 || y2 > 1.2
}

/**
 * 편집 경로용 캐시. 핸들을 드래그하는 동안 같은 파라미터로 수천 번 불린다.
 * 파라미터 해시를 키로 LRU 를 돌린다.
 */
const CACHE_CAPACITY = 64
const cache = new Map<string, BezierEasing>()

export function getBezierEasing(x1: number, y1: number, x2: number, y2: number): BezierEasing {
  const key = `${x1},${y1},${x2},${y2}`
  const hit = cache.get(key)
  if (hit) {
    cache.delete(key)
    cache.set(key, hit)
    return hit
  }
  const created = createBezierEasing(x1, y1, x2, y2)
  cache.set(key, created)
  if (cache.size > CACHE_CAPACITY) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  return created
}

/** `cubic-bezier(.22, 1, .36, 1)` 같은 CSS 문자열을 파싱한다. */
export function parseCubicBezier(input: string): [number, number, number, number] | null {
  const m = /cubic-bezier\(([^)]+)\)/i.exec(input.trim())
  const body = m ? m[1]! : input.trim()
  const parts = body.split(',').map((s) => Number(s.trim()))
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null
  return [clamp01(parts[0]!), parts[1]!, clamp01(parts[2]!), parts[3]!]
}

export function formatCubicBezier(x1: number, y1: number, x2: number, y2: number): string {
  const f = (n: number): string => String(Number(n.toFixed(4)))
  return `cubic-bezier(${f(x1)}, ${f(y1)}, ${f(x2)}, ${f(y2)})`
}

/**
 * de Casteljau 분할.
 *
 * 곡선 위 u 지점에 키프레임을 끼워 넣을 때 모양을 보존한다.
 * 이걸 안 하면 키를 추가하는 순간 모션이 튀고 사용자가 도구를 못 믿게 된다.
 */
export type Point = [number, number]

export function splitCubic(
  p0: Point,
  p1: Point,
  p2: Point,
  p3: Point,
  u: number,
): { left: [Point, Point, Point, Point]; right: [Point, Point, Point, Point] } {
  const lerp = (a: Point, b: Point, t: number): Point => [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
  ]
  const a = lerp(p0, p1, u)
  const b = lerp(p1, p2, u)
  const c = lerp(p2, p3, u)
  const d = lerp(a, b, u)
  const e = lerp(b, c, u)
  const f = lerp(d, e, u)
  return { left: [p0, a, d, f], right: [f, e, c, p3] }
}
