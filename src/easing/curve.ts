/**
 * 키프레임 트랙 평가와 값/속도 그래프 변환.
 *
 * 저장되는 것은 값 그래프의 핸들 하나뿐이다. 속도 그래프는 파생 뷰다.
 * 값 그래프의 양 끝점이 고정되어 있으므로 속도 곡선 아래 면적이 자동으로 dv 와
 * 일치한다. 즉 속도 그래프에서 무엇을 드래그해도 총 이동량이 어긋나지 않으며,
 * 별도의 면적 보정 로직이 필요 없다.
 */

import type { Handle, Keyframe, Track } from '@/core/types.ts'
import { bezierTForX, getBezierEasing, splitCubic, type Point } from './bezier.ts'
import { getSpringEasing } from './spring.ts'
import { EASING_PRESET_BY_ID } from './presets.ts'

/**
 * 프리셋의 평가 정본. 베지어로 표현 가능한 프리셋은 여기서 undefined 를 돌려주고
 * 아래의 일반 베지어 경로를 타게 둔다. 그래야 사용자가 핸들을 손댄 뒤에도
 * 그 편집이 반영된다.
 */
function canonicalEasing(presetId: string): ((t: number) => number) | undefined {
  const preset = EASING_PRESET_BY_ID.get(presetId)
  if (!preset) return undefined
  if (preset.interp === 'spring' && preset.spring) return getSpringEasing(preset.spring)
  // 베지어 근사와 실제 곡선이 크게 다른 것들만 정본으로 강제한다.
  if (!preset.canonical) return undefined
  if (!EXACT_ONLY.has(presetId)) return undefined
  return preset.canonical
}

/**
 * 베지어 4개 핸들로는 근사조차 안 되는 프리셋.
 * 나머지는 핸들 편집을 존중해야 하므로 정본을 강제하지 않는다.
 */
const EXACT_ONLY = new Set(['easeOutBounce', 'easeInBounce', 'easeInOutBounce', 'easeOutElastic', 'easeInElastic', 'easeInOutElastic'])

/** 핸들 기본값. AE 의 기본 영향력과 비슷한 지점이다. */
export const DEFAULT_OUT: Handle = { x: 0.33, y: 0 }
export const DEFAULT_IN: Handle = { x: 0.67, y: 1 }

/** 속도가 발산하지 않게 하는 하한. 표시할 때는 Infinity 대신 "즉시" 라고 쓴다. */
const MIN_INFLUENCE = 1e-3

function outHandle(k: Keyframe): Handle {
  return k.out ?? DEFAULT_OUT
}

function inHandle(k: Keyframe): Handle {
  return k.in ?? DEFAULT_IN
}

/**
 * 한 세그먼트를 평가한다. p 는 [0,1] 로 정규화된 세그먼트 내 진행도다.
 */
export function evalSegment(a: Keyframe, b: Keyframe, p: number): number {
  const dv = b.v - a.v

  // 프리셋에 정본 함수가 있으면 그것이 우선이다. bounce / elastic 은 베지어 핸들로
  // 표현할 수 없어서 핸들만 보면 back 과 구별되지 않는다.
  if (a.easingPreset && a.interp !== 'hold') {
    const canonical = canonicalEasing(a.easingPreset)
    if (canonical) return a.v + dv * canonical(p)
  }

  switch (a.interp) {
    case 'hold':
      return a.v

    case 'linear':
      return a.v + dv * p

    case 'spring': {
      if (!a.spring) return a.v + dv * p
      const ease = getSpringEasing(a.spring)
      return a.v + dv * ease(p)
    }

    case 'samples':
      // 파라메트릭이 정본이고 샘플 배열은 캐시일 뿐이다.
      // 캐시가 없으면 선형으로 떨어진다.
      return a.v + dv * p

    case 'bezier':
    default: {
      const o = outHandle(a)
      const i = inHandle(b)
      const ease = getBezierEasing(o.x, o.y, i.x, i.y)
      return a.v + dv * ease(p)
    }
  }
}

/** 프레임 위치에서 트랙 값을 뽑는다. */
export function evalTrack(track: Track, frame: number): number | undefined {
  const keys = track.keys
  if (keys.length === 0) return undefined
  const first = keys[0]!
  if (keys.length === 1) return first.v
  if (frame <= first.f) return first.v
  const last = keys[keys.length - 1]!
  if (frame >= last.f) return last.v

  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i]!
    const b = keys[i + 1]!
    if (frame < a.f || frame > b.f) continue
    const span = b.f - a.f
    if (span <= 0) return b.v
    return evalSegment(a, b, (frame - a.f) / span)
  }
  return last.v
}

// ---------------------------------------------------------------------------
// 값 그래프 <-> 속도 그래프
// ---------------------------------------------------------------------------

export interface SegmentSpeed {
  /** 세그먼트 시작 속도(정규화) */
  outSpeed: number
  /** 세그먼트 끝 속도(정규화) */
  inSpeed: number
  /** AE 용어의 영향력 */
  outInfluence: number
  inInfluence: number
}

export function segmentSpeed(a: Keyframe, b: Keyframe): SegmentSpeed {
  const o = outHandle(a)
  const i = inHandle(b)
  const x1 = Math.max(MIN_INFLUENCE, o.x)
  const x2 = Math.min(1 - MIN_INFLUENCE, i.x)
  return {
    outSpeed: o.y / x1,
    inSpeed: (1 - i.y) / (1 - x2),
    outInfluence: x1,
    inInfluence: 1 - x2,
  }
}

/** 속도 그래프에서 드래그한 결과를 값 그래프 핸들로 되돌린다. */
export function speedToHandles(s: SegmentSpeed): { out: Handle; in: Handle } {
  const outInf = Math.max(MIN_INFLUENCE, Math.min(1, s.outInfluence))
  const inInf = Math.max(MIN_INFLUENCE, Math.min(1, s.inInfluence))
  return {
    out: { x: outInf, y: s.outSpeed * outInf },
    in: { x: 1 - inInf, y: 1 - s.inSpeed * inInf },
  }
}

/** 정규화 속도를 실단위(값/초)로 바꾼다. */
export function realSpeed(
  normalizedSpeed: number,
  deltaValue: number,
  deltaFrames: number,
  fps: number,
): number {
  if (deltaFrames === 0) return 0
  return (normalizedSpeed * deltaValue * fps) / deltaFrames
}

/** 세그먼트의 베지어 제어점 4개를 (프레임, 값) 좌표로 돌려준다. 그래프 렌더링용. */
export function segmentControlPoints(a: Keyframe, b: Keyframe): [Point, Point, Point, Point] {
  const df = b.f - a.f
  const dv = b.v - a.v
  const o = outHandle(a)
  const i = inHandle(b)
  return [
    [a.f, a.v],
    [a.f + o.x * df, a.v + o.y * dv],
    [b.f - (1 - i.x) * df, b.v - (1 - i.y) * dv],
    [b.f, b.v],
  ]
}

/**
 * 세그먼트 중간에 키프레임을 끼워 넣는다. 곡선 모양이 그대로 보존된다.
 *
 * 정규화 공간 [0,1]x[0,1] 에서 처리한다. 세그먼트 평가가 이미 그 공간에서
 * x -> t 역산을 거치기 때문이다.
 *
 * 흔한 함정: 분할 파라미터 t 와 x 좌표를 같은 것으로 두면 안 된다.
 * x(t) 는 t 에 대해 선형이 아니라서 엉뚱한 지점이 잘린다.
 */
export function insertKeyframe(a: Keyframe, b: Keyframe, frame: number): {
  a: Keyframe
  mid: Keyframe
  b: Keyframe
} | null {
  const df = b.f - a.f
  const dv = b.v - a.v
  const midFrame = Math.round(frame)
  if (df <= 0 || midFrame <= a.f || midFrame >= b.f) return null

  // hold 는 곡선이 없으므로 값만 복제한다.
  if (a.interp === 'hold') {
    return {
      a: { ...a },
      mid: { f: midFrame, v: a.v, interp: 'hold' },
      b: { ...b },
    }
  }

  const o = outHandle(a)
  const i = inHandle(b)

  const px = (midFrame - a.f) / df
  const t = bezierTForX(px, o.x, i.x)

  const p0: Point = [0, 0]
  const p1: Point = [o.x, o.y]
  const p2: Point = [i.x, i.y]
  const p3: Point = [1, 1]
  const { left, right } = splitCubic(p0, p1, p2, p3, t)

  // 분할점. x 는 px 와 같아야 하고, y 가 새 키의 정규화 값이다.
  const my = left[3][1]

  // 값 변화가 없거나 분할점이 양끝과 같으면 정규화가 0 나눗셈이 된다.
  // 그때는 핸들을 기본값으로 두고 값만 심는다.
  const safe = (n: number, d: number, fallback: number): number =>
    Math.abs(d) < 1e-9 ? fallback : n / d

  const mid: Keyframe = {
    f: midFrame,
    v: a.v + dv * my,
    interp: 'bezier',
    in: { x: safe(left[2][0], px, DEFAULT_IN.x), y: safe(left[2][1], my, DEFAULT_IN.y) },
    out: {
      x: safe(right[1][0] - px, 1 - px, DEFAULT_OUT.x),
      y: safe(right[1][1] - my, 1 - my, DEFAULT_OUT.y),
    },
  }

  return {
    a: {
      ...a,
      out: { x: safe(left[1][0], px, DEFAULT_OUT.x), y: safe(left[1][1], my, DEFAULT_OUT.y) },
    },
    mid,
    b: {
      ...b,
      in: {
        x: safe(right[2][0] - px, 1 - px, DEFAULT_IN.x),
        y: safe(right[2][1] - my, 1 - my, DEFAULT_IN.y),
      },
    },
  }
}

/**
 * 프레임당 변위 예산 검증.
 *
 * 세련된 곡선일수록 초반에 프레임이 뭉친다. 예를 들어 cubic-bezier(0.16,1,0.3,1) 은
 * u=0 에서 기울기가 1/0.16 = 6.25 라 평균 속도의 6배가 앞쪽에 몰린다.
 * 하드 에러가 아니라 경고로만 다룬다.
 */
export interface DisplacementBudget {
  /** 곡선의 최대 정규화 속도 */
  maxNormalizedSpeed: number
  /** 실제 최대 픽셀 속도 (px/s) */
  maxPixelSpeed: number
  /** 프레임당 최대 변위 (px) */
  maxStepPx: number
  /** 허용치를 지키려면 필요한 fps */
  requiredFps: number
  exceeded: boolean
}

export function displacementBudget(
  ease: (t: number) => number,
  travelPx: number,
  durationSec: number,
  fps: number,
  allowedStepPx: number,
  samples = 128,
): DisplacementBudget {
  let maxSlope = 0
  const dt = 1 / samples
  for (let i = 0; i < samples; i++) {
    const t0 = i * dt
    const slope = Math.abs((ease(t0 + dt) - ease(t0)) / dt)
    if (slope > maxSlope) maxSlope = slope
  }
  const maxPixelSpeed = durationSec > 0 ? (maxSlope * travelPx) / durationSec : 0
  const maxStepPx = fps > 0 ? maxPixelSpeed / fps : 0
  const requiredFps = allowedStepPx > 0 ? maxPixelSpeed / allowedStepPx : 0
  return {
    maxNormalizedSpeed: maxSlope,
    maxPixelSpeed,
    maxStepPx,
    requiredFps,
    exceeded: maxStepPx > allowedStepPx,
  }
}

/** 허용 변위 기본값. */
export const STEP_ALLOWANCE = {
  sharpEdge: 8,
  soft: 16,
  text: 6,
} as const
