/**
 * 이징 프리셋이 문서에 심긴 뒤에도 원래 곡선을 유지하는지.
 *
 * bounce 와 elastic 은 베지어 핸들 4개로 표현할 수 없다. 프리셋의 표시용 근사치만
 * 저장하면 back 과 완전히 같은 곡선이 되어 "탱탱볼" 이 튕기지 않는다.
 */

import { describe, expect, it } from 'vitest'

import { evalSegment } from '@/easing/curve.ts'
import { EASING_PRESET_BY_ID, presetEasing } from '@/easing/presets.ts'
import type { Keyframe } from '@/core/types.ts'

function segment(presetId: string): [Keyframe, Keyframe] {
  const preset = EASING_PRESET_BY_ID.get(presetId)!
  const a: Keyframe = {
    f: 0,
    v: 0,
    interp: preset.interp,
    easingPreset: presetId,
    ...(preset.handles ? { out: { ...preset.handles.out } } : {}),
    ...(preset.spring ? { spring: { ...preset.spring } } : {}),
  }
  const b: Keyframe = {
    f: 100,
    v: 100,
    interp: preset.interp,
    ...(preset.handles ? { in: { ...preset.handles.in } } : {}),
  }
  return [a, b]
}

function sample(presetId: string): number[] {
  const [a, b] = segment(presetId)
  return [0.1, 0.25, 0.5, 0.75, 0.9].map((p) => Number(evalSegment(a, b, p).toFixed(4)))
}

describe('프리셋 곡선 보존', () => {
  it('bounce / elastic / back 이 서로 다른 곡선이다', () => {
    const bounce = sample('easeOutBounce')
    const elastic = sample('easeOutElastic')
    const back = sample('easeOutBack')

    expect(bounce).not.toEqual(back)
    expect(elastic).not.toEqual(back)
    expect(bounce).not.toEqual(elastic)
  })

  it('탱탱볼은 실제로 튕긴다 (단조 증가가 아니다)', () => {
    const [a, b] = segment('easeOutBounce')
    const values: number[] = []
    for (let p = 0; p <= 1; p += 0.01) values.push(evalSegment(a, b, p))

    // 튕김이 있으면 어딘가에서 값이 내려간다
    let descents = 0
    for (let i = 1; i < values.length; i++) {
      if (values[i]! < values[i - 1]! - 1e-9) descents += 1
    }
    expect(descents).toBeGreaterThan(0)
  })

  it('고무줄은 목표를 넘었다가 되돌아온다', () => {
    const [a, b] = segment('easeOutElastic')
    let max = 0
    for (let p = 0; p <= 1; p += 0.005) max = Math.max(max, evalSegment(a, b, p))
    expect(max).toBeGreaterThan(100)
  })

  it('정본과 evalSegment 결과가 일치한다', () => {
    for (const id of ['easeOutBounce', 'easeOutElastic']) {
      const preset = EASING_PRESET_BY_ID.get(id)!
      const fn = presetEasing(preset)
      const [a, b] = segment(id)
      for (const p of [0.13, 0.37, 0.61, 0.88]) {
        expect(evalSegment(a, b, p), `${id} @ ${p}`).toBeCloseTo(fn(p) * 100, 6)
      }
    }
  })

  it('양끝은 정확히 시작값과 끝값이다', () => {
    for (const id of EASING_PRESET_BY_ID.keys()) {
      const [a, b] = segment(id)
      expect(evalSegment(a, b, 0), `${id} @ 0`).toBeCloseTo(0, 6)
      if (a.interp === 'hold') continue
      expect(evalSegment(a, b, 1), `${id} @ 1`).toBeCloseTo(100, 6)
    }
  })

  it('핸들을 직접 만지면 프리셋 강제가 풀린다', () => {
    // easingPreset 이 없는 키는 순수 베지어로 평가된다.
    const [a, b] = segment('easeOutBounce')
    const edited: Keyframe = { ...a, out: { x: 0.5, y: 0.5 } }
    delete edited.easingPreset

    const bounced = evalSegment(a, b, 0.4)
    const plain = evalSegment(edited, b, 0.4)
    expect(plain).not.toBeCloseTo(bounced, 3)
  })
})

describe('스프링 캐시', () => {
  it('같은 스펙을 반복 평가해도 결과가 같다', () => {
    const [a, b] = segment('springSoft')
    const first = [0.2, 0.5, 0.8].map((p) => evalSegment(a, b, p))
    const second = [0.2, 0.5, 0.8].map((p) => evalSegment(a, b, p))
    expect(second).toEqual(first)
  })

  it('캐시가 있어도 스펙이 다르면 다른 곡선이다', () => {
    const soft = sample('springSoft')
    const bouncy = sample('springBouncy')
    expect(soft).not.toEqual(bouncy)
  })

  it('반복 평가가 충분히 빠르다', () => {
    // 캐시가 없으면 평가마다 최대 2400회 적분을 돈다.
    const [a, b] = segment('springBouncy')
    evalSegment(a, b, 0.5) // 워밍업
    const t0 = Date.now()
    for (let i = 0; i < 2000; i++) evalSegment(a, b, (i % 100) / 100)
    expect(Date.now() - t0).toBeLessThan(200)
  })
})
