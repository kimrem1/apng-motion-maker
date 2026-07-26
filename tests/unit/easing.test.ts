import { describe, expect, it } from 'vitest'

import {
  calcBezier,
  createBezierEasing,
  formatCubicBezier,
  getSlope,
  parseCubicBezier,
  splitCubic,
  type Point,
} from '@/easing/bezier.ts'
import {
  createSpringEasing,
  dampingRatio,
  settleTime,
  springFromSpec,
  springValueAt,
  visualToPhysical,
} from '@/easing/spring.ts'
import { PENNER, createSteps } from '@/easing/penner.ts'
import { EASING_PRESETS, presetEasing } from '@/easing/presets.ts'
import type { SpringSpec } from '@/core/types.ts'

describe('cubic bezier', () => {
  it('끝점은 정확히 0 과 1 이다', () => {
    const e = createBezierEasing(0.16, 1, 0.3, 1)
    expect(e(0)).toBe(0)
    expect(e(1)).toBe(1)
  })

  it('x 를 [0,1] 로 클램프하면 x(u) 가 단조 증가한다', () => {
    // dx/du >= 0 이 보장되어 역산 실패가 구조적으로 불가능해진다
    const cases: Array<[number, number]> = [
      [0, 0], [1, 1], [0.16, 0.3], [1, 0], [0, 1], [0.5, 0.5],
    ]
    for (const [x1, x2] of cases) {
      for (let u = 0; u <= 1; u += 0.01) {
        expect(getSlope(u, x1, x2)).toBeGreaterThanOrEqual(-1e-12)
      }
    }
  })

  it('이징 결과가 단조 증가한다 (오버슈트 없는 곡선)', () => {
    const e = createBezierEasing(0.65, 0, 0.35, 1)
    let prev = -Infinity
    for (let x = 0; x <= 1; x += 0.005) {
      const v = e(x)
      expect(v).toBeGreaterThanOrEqual(prev - 1e-9)
      prev = v
    }
  })

  it('오버슈트 곡선은 1 을 넘는다', () => {
    const e = createBezierEasing(0.34, 1.56, 0.64, 1)
    let max = 0
    for (let x = 0; x <= 1; x += 0.005) max = Math.max(max, e(x))
    expect(max).toBeGreaterThan(1.05)
  })

  it('linear 핸들은 항등 함수다', () => {
    const e = createBezierEasing(0.33, 0.33, 0.67, 0.67)
    for (let x = 0; x <= 1; x += 0.05) expect(e(x)).toBeCloseTo(x, 6)
  })

  it('역산 정확도: calcBezier(getTForX(x)) 가 x 를 복원한다', () => {
    const x1 = 0.16, x2 = 0.3
    const e = createBezierEasing(x1, x1, x2, x2) // y = x 로 두면 e(x) 가 곧 x 여야 한다
    for (let x = 0.01; x < 1; x += 0.01) {
      expect(e(x)).toBeCloseTo(x, 5)
    }
    // calcBezier 자체도 확인
    expect(calcBezier(0, x1, x2)).toBeCloseTo(0, 10)
    expect(calcBezier(1, x1, x2)).toBeCloseTo(1, 10)
  })

  it('CSS 문자열 왕복', () => {
    const parsed = parseCubicBezier('cubic-bezier(.22, 1, .36, 1)')
    expect(parsed).toEqual([0.22, 1, 0.36, 1])
    expect(parseCubicBezier('0.22,1,0.36,1')).toEqual([0.22, 1, 0.36, 1])
    expect(parseCubicBezier('망가진 문자열')).toBeNull()
    expect(formatCubicBezier(0.22, 1, 0.36, 1)).toBe('cubic-bezier(0.22, 1, 0.36, 1)')
    // x 는 클램프된다
    expect(parseCubicBezier('cubic-bezier(2, 1, -1, 1)')).toEqual([1, 1, 0, 1])
  })
})

describe('de Casteljau 분할', () => {
  it('분할해도 곡선 위의 점이 그대로다', () => {
    const p0: Point = [0, 0]
    const p1: Point = [0.16, 1]
    const p2: Point = [0.3, 1]
    const p3: Point = [1, 1]

    const evalCubic = (a: Point, b: Point, c: Point, d: Point, t: number): Point => {
      const mt = 1 - t
      const w0 = mt * mt * mt
      const w1 = 3 * mt * mt * t
      const w2 = 3 * mt * t * t
      const w3 = t * t * t
      return [
        a[0] * w0 + b[0] * w1 + c[0] * w2 + d[0] * w3,
        a[1] * w0 + b[1] * w1 + c[1] * w2 + d[1] * w3,
      ]
    }

    const u = 0.37
    const { left, right } = splitCubic(p0, p1, p2, p3, u)

    // 왼쪽 조각의 t 는 원래 곡선의 t * u 에 대응한다
    for (let t = 0; t <= 1; t += 0.05) {
      const onLeft = evalCubic(left[0], left[1], left[2], left[3], t)
      const onFull = evalCubic(p0, p1, p2, p3, t * u)
      expect(onLeft[0]).toBeCloseTo(onFull[0], 9)
      expect(onLeft[1]).toBeCloseTo(onFull[1], 9)

      const onRight = evalCubic(right[0], right[1], right[2], right[3], t)
      const onFull2 = evalCubic(p0, p1, p2, p3, u + t * (1 - u))
      expect(onRight[0]).toBeCloseTo(onFull2[0], 9)
      expect(onRight[1]).toBeCloseTo(onFull2[1], 9)
    }
  })
})

describe('spring', () => {
  const spec = (bounce: number, visualDuration = 0.4): SpringSpec => ({
    mode: 'visual',
    stiffness: 100,
    damping: 10,
    mass: 1,
    visualDuration,
    bounce,
    fit: 'fitToDuration',
    bakeSamples: 129,
  })

  it('bounce = 1 - 감쇠비 관계가 성립한다', () => {
    const p = visualToPhysical(0.4, 0.3, 1)
    expect(dampingRatio({ ...p })).toBeCloseTo(0.7, 6)

    const critical = visualToPhysical(0.4, 0, 1)
    expect(dampingRatio({ ...critical })).toBeCloseTo(1, 6)
  })

  it('임계 감쇠는 오버슈트가 없다', () => {
    const p = springFromSpec(spec(0))
    let max = 0
    for (let t = 0; t < 3; t += 0.002) max = Math.max(max, springValueAt(p, t))
    expect(max).toBeLessThanOrEqual(1 + 1e-6)
  })

  it('bounce 가 크면 목표를 넘어선다', () => {
    const p = springFromSpec(spec(0.5))
    let max = 0
    for (let t = 0; t < 3; t += 0.002) max = Math.max(max, springValueAt(p, t))
    expect(max).toBeGreaterThan(1.02)
  })

  it('과감쇠에서도 발산하지 않는다', () => {
    const over: SpringSpec = { ...spec(0), mode: 'physical', stiffness: 100, damping: 60, mass: 1 }
    const p = springFromSpec(over)
    expect(dampingRatio(p)).toBeGreaterThan(1)
    for (let t = 0; t < 5; t += 0.01) {
      const v = springValueAt(p, t)
      expect(Number.isFinite(v)).toBe(true)
      expect(Math.abs(v)).toBeLessThan(10)
    }
  })

  it('정착 시간 뒤에는 목표에 도달해 있다', () => {
    const p = springFromSpec(spec(0.3))
    const t = settleTime(p)
    expect(t).toBeGreaterThan(0)
    expect(t).toBeLessThanOrEqual(10)
    expect(springValueAt(p, t)).toBeCloseTo(1, 2)
  })

  it('[0,1] 이징으로 구우면 끝점이 정확히 0 과 1 이다', () => {
    const e = createSpringEasing(spec(0.4))
    expect(e(0)).toBe(0)
    expect(e(1)).toBe(1)
    // 중간에 오버슈트가 살아 있어야 한다. 비례 스케일링을 하면 이게 뭉개진다.
    let max = 0
    for (let x = 0; x <= 1; x += 0.005) max = Math.max(max, e(x))
    expect(max).toBeGreaterThan(1.0)
  })

  it('같은 파라미터면 항상 같은 값이다 (결정론)', () => {
    const a = createSpringEasing(spec(0.35))
    const b = createSpringEasing(spec(0.35))
    for (let x = 0; x <= 1; x += 0.01) expect(a(x)).toBe(b(x))
  })
})

describe('Penner 수식', () => {
  it('전부 0 에서 0, 1 에서 1 이다', () => {
    for (const [name, fn] of Object.entries(PENNER)) {
      expect(fn(0), `${name}(0)`).toBeCloseTo(0, 6)
      expect(fn(1), `${name}(1)`).toBeCloseTo(1, 6)
    }
  })

  it('back 은 의도적으로 범위를 벗어난다', () => {
    expect(PENNER.easeInBack!(0.3)).toBeLessThan(0)
    let max = 0
    for (let t = 0; t <= 1; t += 0.01) max = Math.max(max, PENNER.easeOutBack!(t))
    expect(max).toBeGreaterThan(1.05)
  })

  it('easeOutBounce 는 단조가 아니지만 범위 안에 있다', () => {
    for (let t = 0; t <= 1; t += 0.005) {
      const v = PENNER.easeOutBounce!(t)
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThanOrEqual(1 + 1e-9)
    }
  })

  it('steps 는 계단을 만든다', () => {
    const s = createSteps(4, 'end')
    expect(s(0)).toBe(0)
    expect(s(0.24)).toBe(0)
    expect(s(0.26)).toBeCloseTo(0.25, 6)
    expect(s(0.99)).toBeCloseTo(0.75, 6)
    expect(s(1)).toBe(1)
  })
})

describe('프리셋', () => {
  it('모든 프리셋이 평가 가능하고 끝점이 맞다', () => {
    for (const p of EASING_PRESETS) {
      const fn = presetEasing(p)
      if (p.interp === 'hold') continue
      expect(fn(0), `${p.id}(0)`).toBeCloseTo(0, 5)
      expect(fn(1), `${p.id}(1)`).toBeCloseTo(1, 5)
    }
  })

  /**
   * 통용되는 cubic-bezier 상수가 Penner 수식과 얼마나 다른지는 확인된 바가 없다. 평가 정본은 Penner 이고 베지어는 표시용이므로
   * 오차 자체는 문제가 아니지만, 눈에 띄게 벌어지면 그래프가 실제 모션과 달라 보인다.
   * 감시만 하고 실패시키지는 않는다.
   */
  it('베지어 근사와 Penner 정본의 최대 오차를 기록한다', () => {
    const rows: Array<[string, number]> = []
    for (const p of EASING_PRESETS) {
      if (!p.canonical || !p.handles || p.interp !== 'bezier') continue
      const bez = createBezierEasing(p.handles.out.x, p.handles.out.y, p.handles.in.x, p.handles.in.y)
      let maxErr = 0
      for (let i = 0; i <= 128; i++) {
        const x = i / 128
        maxErr = Math.max(maxErr, Math.abs(bez(x) - p.canonical(x)))
      }
      rows.push([p.id, Number(maxErr.toFixed(4))])
    }
    expect(rows.length).toBeGreaterThan(0)
    // 어떤 프리셋도 완전히 딴판이면 안 된다. bounce/elastic 은 베지어로 표현 불가라 제외.
    for (const [id, err] of rows) {
      if (id.includes('Bounce') || id.includes('Elastic')) continue
      expect(err, `${id} 오차`).toBeLessThan(0.2)
    }
  })
})
