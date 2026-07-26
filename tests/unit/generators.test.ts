/**
 * 절차형 모디파이어.
 *
 * 두 가지만 보면 된다. 결정론과 심리스 루프다.
 * 이게 깨지면 흔들림이 프레임마다 달라지거나 반복 지점에서 딸꾹질한다.
 */

import { describe, expect, it } from 'vitest'

import { evalModifier, fbmLoop, modifierPeak } from '@/motions/generators.ts'
import type { Modifier } from '@/core/types.ts'

const mod = (patch: Partial<Modifier>): Modifier => ({
  id: 'm1',
  type: 'loopNoise',
  target: 'translateX',
  blendOp: 'add',
  seed: 1337,
  amplitude: 10,
  cycles: 2,
  octaves: 2,
  persistence: 0.5,
  lacunarity: 2,
  holdFrames: 1,
  decay: 0,
  ...patch,
})

const ctx = (frame: number, durationFrames = 30) => ({
  frame,
  durationFrames,
  projectSeed: 0x4d4d,
  nodeId: 'layer1',
})

describe('fbmLoop', () => {
  it('t=0 과 t=1 이 같은 값이다 (원 경로)', () => {
    for (const seed of [1, 12345, 0xabcdef]) {
      expect(fbmLoop(seed, 0, 2, 0.5, 2)).toBeCloseTo(fbmLoop(seed, 1, 2, 0.5, 2), 12)
    }
  })

  it('이음새에 꺾임이 없다', () => {
    // 원 경로 샘플링이라 수학적으로는 C-무한이다. 꺾임이 있다면 2차 차분이
    // 그 지점에서만 튄다. 한쪽 기울기끼리 비교하면 곡률 때문에 생기는
    // 유한차분 오차를 불연속으로 오해하게 된다.
    const seed = 4242
    const h = 1e-3
    const f = (t: number): number => fbmLoop(seed, ((t % 1) + 1) % 1, 2, 0.5, 2)
    const secondDiff = (t: number): number => Math.abs(f(t + h) - 2 * f(t) + f(t - h))

    const atSeam = secondDiff(0)
    const elsewhere: number[] = []
    for (let t = 0.05; t < 0.95; t += 0.01) elsewhere.push(secondDiff(t))
    const typical = elsewhere.reduce((a, b) => a + b, 0) / elsewhere.length

    // 이음새의 2차 차분이 다른 곳의 평균과 같은 자릿수면 꺾임이 없는 것이다.
    expect(atSeam).toBeLessThan(typical * 8 + 1e-9)
  })

  it('[-1, 1] 을 넘지 않는다', () => {
    for (const seed of [7, 99, 100000]) {
      for (let t = 0; t < 1; t += 0.002) {
        const v = fbmLoop(seed, t, 4, 0.5, 2)
        expect(v).toBeGreaterThanOrEqual(-1.0001)
        expect(v).toBeLessThanOrEqual(1.0001)
      }
    }
  })

  it('상수가 아니다', () => {
    const values = new Set<number>()
    for (let t = 0; t < 1; t += 0.01) values.add(Number(fbmLoop(555, t, 2, 0.5, 2).toFixed(6)))
    expect(values.size).toBeGreaterThan(50)
  })

  it('시드가 다르면 패턴이 다르다', () => {
    const a = Array.from({ length: 50 }, (_, i) => fbmLoop(1, i / 50, 2, 0.5, 2))
    const b = Array.from({ length: 50 }, (_, i) => fbmLoop(2, i / 50, 2, 0.5, 2))
    expect(a).not.toEqual(b)
  })
})

describe('evalModifier 결정론', () => {
  it('같은 프레임을 몇 번 물어봐도 같은 값이다', () => {
    const m = mod({})
    for (const f of [0, 7, 13, 29]) {
      expect(evalModifier(m, ctx(f))).toBe(evalModifier(m, ctx(f)))
    }
  })

  it('무작위 순서로 평가해도 순차 평가와 같다', () => {
    const m = mod({})
    const seq = Array.from({ length: 30 }, (_, f) => evalModifier(m, ctx(f)))
    for (const f of [17, 3, 29, 0, 22, 8]) {
      expect(evalModifier(m, ctx(f))).toBe(seq[f])
    }
  })

  it('모디파이어 id 가 다르면 값이 다르다', () => {
    const a = evalModifier(mod({ id: 'ma' }), ctx(5))
    const b = evalModifier(mod({ id: 'mb' }), ctx(5))
    expect(a).not.toBe(b)
  })
})

describe('심리스 루프', () => {
  it('loopNoise 는 첫 프레임과 마지막+1 이 같다', () => {
    const m = mod({ type: 'loopNoise' })
    // 프레임 30 은 프레임 0 과 같은 위상이다 (durationFrames = 30)
    expect(evalModifier(m, ctx(30))).toBeCloseTo(evalModifier(m, ctx(0)), 12)
  })

  it('sine 은 정수 주기를 강제한다', () => {
    // 2.7 주기를 넣어도 3 으로 반올림되어 이음새가 남지 않는다
    const m = mod({ type: 'sine', cycles: 2.7 })
    expect(evalModifier(m, ctx(30))).toBeCloseTo(evalModifier(m, ctx(0)), 12)
  })

  it('sine 이 실제로 진동한다', () => {
    const m = mod({ type: 'sine', cycles: 1, amplitude: 10 })
    const values = Array.from({ length: 30 }, (_, f) => evalModifier(m, ctx(f)))
    expect(Math.max(...values)).toBeGreaterThan(9)
    expect(Math.min(...values)).toBeLessThan(-9)
  })

  it('eventBurst 도 이음새가 이어진다', () => {
    const m = mod({ type: 'eventBurst', cycles: 3, decay: 6, amplitude: 20 })
    expect(evalModifier(m, ctx(30))).toBeCloseTo(evalModifier(m, ctx(0)), 6)
  })
})

describe('홀드 클럭 (자글자글)', () => {
  it('holdFrames 만큼 같은 값을 유지한다', () => {
    const m = mod({ type: 'loopNoise', holdFrames: 3 })
    expect(evalModifier(m, ctx(0))).toBe(evalModifier(m, ctx(1)))
    expect(evalModifier(m, ctx(0))).toBe(evalModifier(m, ctx(2)))
    expect(evalModifier(m, ctx(3))).not.toBe(evalModifier(m, ctx(0)))
  })

  it('holdFrames 1 이면 매 프레임 바뀐다', () => {
    const m = mod({ type: 'loopNoise', holdFrames: 1 })
    expect(evalModifier(m, ctx(0))).not.toBe(evalModifier(m, ctx(1)))
  })
})

describe('엔벨로프', () => {
  it('강도를 시간에 따라 줄인다', () => {
    // 감쇠 없는 등진폭 흔들림은 즉시 싸구려로 보인다
    const m = mod({
      type: 'sine',
      cycles: 4,
      amplitude: 20,
      envelope: [
        { f: 0, v: 1, interp: 'linear' },
        { f: 29, v: 0, interp: 'linear' },
      ],
    })
    const early = Math.abs(evalModifier(m, ctx(2)))
    const late = Math.abs(evalModifier(m, ctx(27)))
    // 후반부 진폭이 훨씬 작아야 한다
    expect(late).toBeLessThan(early)
  })
})

describe('modifierPeak', () => {
  it('정규화된 생성기는 amplitude 가 곧 상한이다', () => {
    expect(modifierPeak(mod({ type: 'loopNoise', amplitude: 6 }))).toBeCloseTo(6, 9)
    expect(modifierPeak(mod({ type: 'sine', amplitude: 6 }))).toBeCloseTo(6, 9)
  })

  it('eventBurst 는 사건이 겹칠 수 있어 여유를 둔다', () => {
    expect(modifierPeak(mod({ type: 'eventBurst', amplitude: 6 }))).toBeGreaterThan(6)
  })

  it('실측 최대값이 상한을 넘지 않는다', () => {
    for (const type of ['loopNoise', 'sine', 'spring'] as const) {
      const m = mod({ type, amplitude: 10, cycles: 3 })
      const peak = modifierPeak(m)
      for (let f = 0; f < 60; f++) {
        expect(Math.abs(evalModifier(m, ctx(f, 60))), `${type} @ ${f}`).toBeLessThanOrEqual(peak + 1e-9)
      }
    }
  })
})
