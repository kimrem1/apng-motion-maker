/**
 * 결정론 계약.
 *
 * "같은 (doc, t) 면 항상 같은 픽셀" 의 CPU 쪽 절반을 검증한다.
 * 평가 결과가 프레임 순서에 의존하면 내보내기와 프리뷰가 갈린다.
 * GPU 쪽 절반(셰이더 출력)은 브라우저에서 FBO 판독으로 확인한다.
 */

import { describe, expect, it } from 'vitest'

import { resolveComposition } from '@/core/evaluate.ts'
import { createEmptyProject, createImageLayer, resetIdCounter } from '@/core/factory.ts'
import { exportFrameIndices } from '@/core/time.ts'
import { hashSeed, mulberry32, effectiveFrame } from '@/core/rng.ts'
import type { AssetRef, MotionProject } from '@/core/types.ts'

function buildDoc(): MotionProject {
  resetIdCounter()
  const doc = createEmptyProject()
  doc.canvas.w = 400
  doc.canvas.h = 400
  doc.timeline.durationFrames = 40

  const asset: AssetRef = {
    id: 'a1',
    name: 'test',
    storeKey: 'k',
    naturalW: 600,
    naturalH: 600,
    hasAlpha: true,
  }
  doc.assets = [asset]

  const layer = createImageLayer(asset, 0)
  layer.tracks = [
    {
      id: 't1',
      prop: 'scale',
      unit: 'ratio',
      keys: [
        { f: 0, v: 1, interp: 'bezier', out: { x: 0.16, y: 1 } },
        { f: 20, v: 1.3, interp: 'spring', in: { x: 0.3, y: 1 }, spring: {
          mode: 'visual', stiffness: 100, damping: 10, mass: 1,
          visualDuration: 0.4, bounce: 0.4, fit: 'fitToDuration', bakeSamples: 129,
        } },
        { f: 39, v: 1, interp: 'bezier', in: { x: 0.4, y: 1 } },
      ],
    },
    {
      id: 't2',
      prop: 'rotate',
      unit: 'deg',
      keys: [
        { f: 0, v: 0, interp: 'linear' },
        { f: 39, v: 12, interp: 'linear' },
      ],
    },
  ]
  doc.layers = [layer]
  return doc
}

describe('평가 결정론', () => {
  it('무작위 순서로 평가해도 순차 평가와 결과가 같다', () => {
    const doc = buildDoc()
    const frames = Array.from({ length: doc.timeline.durationFrames }, (_, i) => i)

    const sequential = frames.map((f) => JSON.stringify(resolveComposition(doc, f)))

    // 고정 시드로 섞는다. 테스트 자체가 결정론적이어야 한다.
    const rng = mulberry32(0xc0ffee)
    const shuffled = [...frames]
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1))
      const tmp = shuffled[i]!
      shuffled[i] = shuffled[j]!
      shuffled[j] = tmp
    }

    for (const f of shuffled) {
      expect(JSON.stringify(resolveComposition(doc, f)), `frame ${f}`).toBe(sequential[f])
    }
  })

  it('같은 문서를 두 번 평가하면 바이트 단위로 같다', () => {
    const a = buildDoc()
    const b = buildDoc()
    for (let f = 0; f < 40; f++) {
      expect(JSON.stringify(resolveComposition(a, f))).toBe(JSON.stringify(resolveComposition(b, f)))
    }
  })

  it('내보내기 프레임 목록이 결정론적이다', () => {
    const first = exportFrameIndices(30, 'pingPong', true)
    const second = exportFrameIndices(30, 'pingPong', true)
    expect(first).toEqual(second)
    expect(first).toHaveLength(58)
  })
})

describe('시드 해시', () => {
  it('같은 입력이면 같은 시드다', () => {
    expect(hashSeed(1337, 'layer1', 5)).toBe(hashSeed(1337, 'layer1', 5))
  })

  it('프레임이 다르면 시드가 다르다', () => {
    const seeds = new Set<number>()
    for (let f = 0; f < 200; f++) seeds.add(hashSeed(1337, 'layer1', f))
    // 200개가 전부 달라야 흔들림 패턴이 프레임마다 갈린다
    expect(seeds.size).toBe(200)
  })

  it('노드가 다르면 시드가 다르다', () => {
    expect(hashSeed(1337, 'layerA', 5)).not.toBe(hashSeed(1337, 'layerB', 5))
  })

  it('mulberry32 는 [0,1) 범위이고 재현 가능하다', () => {
    const a = mulberry32(42)
    const b = mulberry32(42)
    for (let i = 0; i < 100; i++) {
      const v = a()
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
      expect(v).toBe(b())
    }
  })

  it('홀드 클럭이 N 프레임마다 같은 시드를 만든다', () => {
    // 자글자글이 2컷으로 잡히는 근거
    expect(effectiveFrame(0, 3)).toBe(0)
    expect(effectiveFrame(1, 3)).toBe(0)
    expect(effectiveFrame(2, 3)).toBe(0)
    expect(effectiveFrame(3, 3)).toBe(3)
    expect(effectiveFrame(7, 2)).toBe(6)
    expect(effectiveFrame(7, 1)).toBe(7)
  })
})
