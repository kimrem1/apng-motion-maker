/**
 * Penner 닫힌 수식.
 *
 * 흔히 인용되는 cubic-bezier 근사 상수는 출처가 불분명하다.
 * 그래서 평가는 이 닫힌 수식을 정본으로 쓰고, 베지어는 CSS 내보내기와
 * 그래프 에디터 표시용으로만 둔다. 두 표현의 오차는 테스트로 감시한다.
 *
 * 전부 [0,1] -> 실수. back / elastic 은 의도적으로 [0,1] 을 벗어난다.
 */

const C1 = 1.70158
const C2 = C1 * 1.525
const C3 = C1 + 1
const C4 = (2 * Math.PI) / 3
const C5 = (2 * Math.PI) / 4.5

const N1 = 7.5625
const D1 = 2.75

export type EasingFn = (t: number) => number

export const linear: EasingFn = (t) => t

// --- quad / cubic / quart / quint -------------------------------------------

const power =
  (n: number) =>
  (t: number): number =>
    Math.pow(t, n)

const powerOut =
  (n: number) =>
  (t: number): number =>
    1 - Math.pow(1 - t, n)

const powerInOut =
  (n: number) =>
  (t: number): number =>
    t < 0.5 ? Math.pow(2, n - 1) * Math.pow(t, n) : 1 - Math.pow(-2 * t + 2, n) / 2

// --- expo -------------------------------------------------------------------

export const easeInExpo: EasingFn = (t) => (t === 0 ? 0 : Math.pow(2, 10 * t - 10))
export const easeOutExpo: EasingFn = (t) => (t === 1 ? 1 : 1 - Math.pow(2, -10 * t))
export const easeInOutExpo: EasingFn = (t) =>
  t === 0 ? 0 : t === 1 ? 1 : t < 0.5 ? Math.pow(2, 20 * t - 10) / 2 : (2 - Math.pow(2, -20 * t + 10)) / 2

// --- circ -------------------------------------------------------------------

export const easeInCirc: EasingFn = (t) => 1 - Math.sqrt(1 - t * t)
export const easeOutCirc: EasingFn = (t) => Math.sqrt(1 - (t - 1) * (t - 1))
export const easeInOutCirc: EasingFn = (t) =>
  t < 0.5
    ? (1 - Math.sqrt(1 - 4 * t * t)) / 2
    : (Math.sqrt(1 - (-2 * t + 2) * (-2 * t + 2)) + 1) / 2

// --- back (오버슈트) --------------------------------------------------------

export const easeInBack: EasingFn = (t) => C3 * t * t * t - C1 * t * t
export const easeOutBack: EasingFn = (t) => 1 + C3 * Math.pow(t - 1, 3) + C1 * Math.pow(t - 1, 2)
export const easeInOutBack: EasingFn = (t) =>
  t < 0.5
    ? (Math.pow(2 * t, 2) * ((C2 + 1) * 2 * t - C2)) / 2
    : (Math.pow(2 * t - 2, 2) * ((C2 + 1) * (t * 2 - 2) + C2) + 2) / 2

// --- elastic ----------------------------------------------------------------

export const easeInElastic: EasingFn = (t) =>
  t === 0 ? 0 : t === 1 ? 1 : -Math.pow(2, 10 * t - 10) * Math.sin((t * 10 - 10.75) * C4)
export const easeOutElastic: EasingFn = (t) =>
  t === 0 ? 0 : t === 1 ? 1 : Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * C4) + 1
export const easeInOutElastic: EasingFn = (t) =>
  t === 0
    ? 0
    : t === 1
      ? 1
      : t < 0.5
        ? -(Math.pow(2, 20 * t - 10) * Math.sin((20 * t - 11.125) * C5)) / 2
        : (Math.pow(2, -20 * t + 10) * Math.sin((20 * t - 11.125) * C5)) / 2 + 1

// --- bounce -----------------------------------------------------------------

export const easeOutBounce: EasingFn = (t) => {
  if (t < 1 / D1) return N1 * t * t
  if (t < 2 / D1) {
    const u = t - 1.5 / D1
    return N1 * u * u + 0.75
  }
  if (t < 2.5 / D1) {
    const u = t - 2.25 / D1
    return N1 * u * u + 0.9375
  }
  const u = t - 2.625 / D1
  return N1 * u * u + 0.984375
}
export const easeInBounce: EasingFn = (t) => 1 - easeOutBounce(1 - t)
export const easeInOutBounce: EasingFn = (t) =>
  t < 0.5 ? (1 - easeOutBounce(1 - 2 * t)) / 2 : (1 + easeOutBounce(2 * t - 1)) / 2

// --- steps ------------------------------------------------------------------

export type StepJump = 'start' | 'end' | 'none' | 'both'

/** CSS steps() 와 같은 의미. 자글자글/스톱모션 룩에 쓴다. */
export function createSteps(count: number, jump: StepJump = 'end'): EasingFn {
  const n = Math.max(1, Math.floor(count))
  return (t: number): number => {
    const clamped = t < 0 ? 0 : t > 1 ? 1 : t
    let step = Math.floor(clamped * n)
    if (jump === 'start' || jump === 'both') step += 1
    const denom = jump === 'none' ? n - 1 : jump === 'both' ? n + 1 : n
    if (denom <= 0) return clamped
    const v = step / denom
    return v < 0 ? 0 : v > 1 ? 1 : v
  }
}

/**
 * 사인 반주기. 양끝이 가장 부드러운 대칭 곡선이다.
 *
 * 프리셋 코드가 이미 이 이름을 쓰고 있었는데 표에 없어서, 모르는 id 로 떨어져
 * 조용히 기본 베지어가 심겼다 (presets.ts easeInOutSine 주석).
 */
function easeInOutSine(t: number): number {
  return -(Math.cos(Math.PI * t) - 1) / 2
}

// --- 이름 -> 함수 -----------------------------------------------------------

export const PENNER: Record<string, EasingFn> = {
  linear,
  easeInQuad: power(2),
  easeOutQuad: powerOut(2),
  easeInOutQuad: powerInOut(2),
  easeInCubic: power(3),
  easeOutCubic: powerOut(3),
  easeInOutCubic: powerInOut(3),
  easeInQuart: power(4),
  easeOutQuart: powerOut(4),
  easeInOutQuart: powerInOut(4),
  easeInQuint: power(5),
  easeOutQuint: powerOut(5),
  easeInOutQuint: powerInOut(5),
  easeInOutSine,
  easeInExpo,
  easeOutExpo,
  easeInOutExpo,
  easeInCirc,
  easeOutCirc,
  easeInOutCirc,
  easeInBack,
  easeOutBack,
  easeInOutBack,
  easeInElastic,
  easeOutElastic,
  easeInOutElastic,
  easeInBounce,
  easeOutBounce,
  easeInOutBounce,
}

export type PennerName = keyof typeof PENNER
