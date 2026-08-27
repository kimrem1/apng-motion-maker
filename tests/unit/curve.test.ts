import { describe, expect, it } from 'vitest'

import {
  displacementBudget,
  evalSegment,
  evalTrack,
  insertKeyframe,
  realSpeed,
  segmentControlPoints,
  segmentSpeed,
  speedToHandles,
  STEP_ALLOWANCE,
} from '@/easing/curve.ts'
import type { Keyframe, SpringSpec, Track } from '@/core/types.ts'

const track = (keys: Keyframe[]): Track => ({ id: 't', prop: 'scale', unit: 'ratio', keys })

const springSpec: SpringSpec = {
  mode: 'visual',
  stiffness: 100,
  damping: 10,
  mass: 1,
  visualDuration: 0.4,
  bounce: 0.35,
  fit: 'fitToDuration',
  bakeSamples: 129,
}

describe('evalTrack', () => {
  it('베지어 세그먼트가 이징을 실제로 태운다', () => {
    const t = track([
      { f: 0, v: 0, interp: 'bezier', out: { x: 0.16, y: 1 } },
      { f: 10, v: 1, interp: 'bezier', in: { x: 0.3, y: 1 } },
    ])
    // easeOut 계열이므로 중간 지점에서 이미 절반을 훨씬 넘어야 한다
    const mid = evalTrack(t, 5)!
    expect(mid).toBeGreaterThan(0.8)
    expect(evalTrack(t, 0)).toBe(0)
    expect(evalTrack(t, 10)).toBe(1)
  })

  it('선형은 정확히 선형이다', () => {
    const t = track([
      { f: 0, v: 0, interp: 'linear' },
      { f: 10, v: 100, interp: 'linear' },
    ])
    expect(evalTrack(t, 5)).toBeCloseTo(50, 9)
    expect(evalTrack(t, 3)).toBeCloseTo(30, 9)
  })

  it('hold 는 다음 키 직전까지 값을 붙잡는다', () => {
    const t = track([
      { f: 0, v: 5, interp: 'hold' },
      { f: 10, v: 9, interp: 'hold' },
    ])
    expect(evalTrack(t, 9.99)).toBe(5)
    expect(evalTrack(t, 10)).toBe(9)
  })

  it('hold 중간 키의 값은 자기 프레임에 바로 나온다', () => {
    // 닫힌 구간 매칭이면 evalTrack(5) 가 앞 세그먼트의 hold 로 떨어져 1 이 나오고,
    // fade.flicker 처럼 hold 키를 쌓은 트랙의 값 전환이 전부 한 프레임 밀린다.
    const t = track([
      { f: 0, v: 1, interp: 'hold' },
      { f: 5, v: 0.3, interp: 'hold' },
      { f: 10, v: 1, interp: 'hold' },
    ])
    expect(evalTrack(t, 4)).toBe(1)
    expect(evalTrack(t, 5)).toBe(0.3)
    expect(evalTrack(t, 6)).toBe(0.3)
    expect(evalTrack(t, 10)).toBe(1)
  })

  it('스프링 세그먼트가 오버슈트한다', () => {
    const t = track([
      { f: 0, v: 0, interp: 'spring', spring: springSpec },
      { f: 30, v: 1, interp: 'spring' },
    ])
    let max = 0
    for (let f = 0; f <= 30; f += 0.25) max = Math.max(max, evalTrack(t, f)!)
    expect(max).toBeGreaterThan(1.0)
    expect(evalTrack(t, 30)).toBe(1)
  })

  it('구간 밖은 양끝으로 클램프한다', () => {
    const t = track([
      { f: 10, v: 2, interp: 'bezier' },
      { f: 20, v: 8, interp: 'bezier' },
    ])
    expect(evalTrack(t, 0)).toBe(2)
    expect(evalTrack(t, 999)).toBe(8)
  })

  it('키가 없으면 undefined', () => {
    expect(evalTrack(track([]), 0)).toBeUndefined()
  })

  it('세그먼트 진행도 0 과 1 은 정확히 양끝 값이다', () => {
    const a: Keyframe = { f: 0, v: 3, interp: 'bezier', out: { x: 0.34, y: 1.25 } }
    const b: Keyframe = { f: 10, v: 7, interp: 'bezier', in: { x: 0.64, y: 1 } }
    expect(evalSegment(a, b, 0)).toBe(3)
    expect(evalSegment(a, b, 1)).toBe(7)
  })
})

describe('값 그래프 <-> 속도 그래프', () => {
  it('왕복 변환이 핸들을 보존한다', () => {
    const a: Keyframe = { f: 0, v: 0, interp: 'bezier', out: { x: 0.25, y: 0.6 } }
    const b: Keyframe = { f: 10, v: 1, interp: 'bezier', in: { x: 0.7, y: 0.9 } }

    const s = segmentSpeed(a, b)
    const back = speedToHandles(s)

    expect(back.out.x).toBeCloseTo(0.25, 9)
    expect(back.out.y).toBeCloseTo(0.6, 9)
    expect(back.in.x).toBeCloseTo(0.7, 9)
    expect(back.in.y).toBeCloseTo(0.9, 9)
  })

  it('속도 계산이 세그먼트 공식과 일치한다', () => {
    const a: Keyframe = { f: 0, v: 0, interp: 'bezier', out: { x: 0.16, y: 1 } }
    const b: Keyframe = { f: 10, v: 1, interp: 'bezier', in: { x: 0.3, y: 1 } }
    const s = segmentSpeed(a, b)
    // s_out = y1 / x1 = 1 / 0.16 = 6.25
    expect(s.outSpeed).toBeCloseTo(6.25, 6)
    // s_in = (1 - y2) / (1 - x2) = 0 / 0.7 = 0
    expect(s.inSpeed).toBeCloseTo(0, 9)
  })

  it('x1 = 0 이어도 발산하지 않는다', () => {
    const a: Keyframe = { f: 0, v: 0, interp: 'bezier', out: { x: 0, y: 0.5 } }
    const b: Keyframe = { f: 10, v: 1, interp: 'bezier', in: { x: 1, y: 0.5 } }
    const s = segmentSpeed(a, b)
    expect(Number.isFinite(s.outSpeed)).toBe(true)
    expect(Number.isFinite(s.inSpeed)).toBe(true)
  })

  it('실단위 속도 변환', () => {
    // 정규화 속도 1, 값 변화 100px, 10프레임, 25fps -> 250 px/s
    expect(realSpeed(1, 100, 10, 25)).toBeCloseTo(250, 9)
  })

  it('제어점이 (프레임, 값) 좌표로 나온다', () => {
    const a: Keyframe = { f: 0, v: 0, interp: 'bezier', out: { x: 0.5, y: 0.5 } }
    const b: Keyframe = { f: 10, v: 100, interp: 'bezier', in: { x: 0.5, y: 0.5 } }
    const [p0, p1, p2, p3] = segmentControlPoints(a, b)
    expect(p0).toEqual([0, 0])
    expect(p1).toEqual([5, 50])
    expect(p2).toEqual([5, 50])
    expect(p3).toEqual([10, 100])
  })
})

describe('키프레임 삽입 (de Casteljau)', () => {
  it('중간에 키를 넣어도 곡선 모양이 보존된다', () => {
    // 이게 깨지면 키를 추가하는 순간 모션이 튀고 사용자가 도구를 못 믿게 된다
    const a: Keyframe = { f: 0, v: 0, interp: 'bezier', out: { x: 0.16, y: 1 } }
    const b: Keyframe = { f: 40, v: 100, interp: 'bezier', in: { x: 0.3, y: 1 } }
    const before = track([a, b])

    const split = insertKeyframe(a, b, 16)
    expect(split).not.toBeNull()
    const after = track([split!.a, split!.mid, split!.b])

    for (let f = 0; f <= 40; f += 1) {
      const v0 = evalTrack(before, f)!
      const v1 = evalTrack(after, f)!
      // 정수 프레임에 삽입하면 곡선이 정확히 보존되어야 한다.
      expect(Math.abs(v1 - v0), `frame ${f}: ${v0} vs ${v1}`).toBeLessThan(1e-6)
    }
  })

  it('삽입된 키의 값이 원래 곡선 위에 있다', () => {
    const a: Keyframe = { f: 0, v: 10, interp: 'bezier', out: { x: 0.65, y: 0 } }
    const b: Keyframe = { f: 20, v: 50, interp: 'bezier', in: { x: 0.35, y: 1 } }
    const split = insertKeyframe(a, b, 10)!
    const original = evalTrack(track([a, b]), 10)!
    expect(split.mid.v).toBeCloseTo(original, 1)
  })

  it('구간 밖이면 null', () => {
    const a: Keyframe = { f: 0, v: 0, interp: 'bezier' }
    const b: Keyframe = { f: 10, v: 1, interp: 'bezier' }
    expect(insertKeyframe(a, b, 0)).toBeNull()
    expect(insertKeyframe(a, b, 10)).toBeNull()
    expect(insertKeyframe(a, b, 15)).toBeNull()
  })

  it('linear 세그먼트에 키를 넣어도 직선이 보존된다', () => {
    // 프리셋의 등속 트랙(rotate.spin360 등)은 키 하나만 끼워도 S-곡선이 되면
    // 이음새가 벌어진다. 삽입 키는 직선 위의 값이어야 하고 전 구간이 그대로여야 한다.
    const a: Keyframe = { f: 0, v: 0, interp: 'linear' }
    const b: Keyframe = { f: 40, v: 360, interp: 'linear' }
    const before = track([a, b])
    const split = insertKeyframe(a, b, 10)!
    expect(split.mid.v).toBeCloseTo(90, 9)
    expect(split.mid.interp).toBe('linear')
    const after = track([split.a, split.mid, split.b])
    for (let f = 0; f <= 40; f += 1) {
      expect(Math.abs(evalTrack(after, f)! - evalTrack(before, f)!), `frame ${f}`).toBeLessThan(1e-6)
    }
  })

  it('스프링 세그먼트에 넣은 키의 값이 정본 곡선 위에 있다', () => {
    const a: Keyframe = { f: 0, v: 0, interp: 'spring', spring: springSpec }
    const b: Keyframe = { f: 20, v: 100, interp: 'spring' }
    const original = evalTrack(track([a, b]), 7)!
    const split = insertKeyframe(a, b, 7)!
    expect(split.mid.v).toBeCloseTo(original, 6)
    // 정본이 하위 구간에 다시 적용되는 이중 왜곡이 없어야 한다.
    expect(split.a.spring).toBeUndefined()
    const after = track([split.a, split.mid, split.b])
    expect(evalTrack(after, 7)!).toBeCloseTo(original, 6)
  })

  it('정본 강제 프리셋(bounce) 세그먼트에 넣은 키의 값이 정본 곡선 위에 있다', () => {
    const a: Keyframe = { f: 0, v: 0, interp: 'bezier', easingPreset: 'easeOutBounce', out: { x: 0.34, y: 1.56 } }
    const b: Keyframe = { f: 30, v: 100, interp: 'bezier', in: { x: 0.64, y: 1 } }
    const original = evalTrack(track([a, b]), 11)!
    const split = insertKeyframe(a, b, 11)!
    expect(split.mid.v).toBeCloseTo(original, 6)
    expect(split.a.easingPreset).toBeUndefined()
  })
})

describe('프레임당 변위 예산', () => {
  it('앞쪽에 몰리는 곡선이 경고를 낸다', () => {
    // cubic-bezier(0.16, 1, 0.3, 1) 은 u=0 에서 기울기 6.25
    const ease = (t: number): number => {
      const e = 1 - Math.pow(2, -10 * t)
      return t === 1 ? 1 : e
    }
    const b = displacementBudget(ease, 400, 0.5, 25, STEP_ALLOWANCE.sharpEdge)
    expect(b.maxNormalizedSpeed).toBeGreaterThan(3)
    expect(b.exceeded).toBe(true)
    expect(b.requiredFps).toBeGreaterThan(25)
  })

  it('등속이고 느리면 통과한다', () => {
    const b = displacementBudget((t) => t, 100, 4, 25, STEP_ALLOWANCE.soft)
    expect(b.maxNormalizedSpeed).toBeCloseTo(1, 3)
    expect(b.maxStepPx).toBeCloseTo(1, 3)
    expect(b.exceeded).toBe(false)
  })
})
