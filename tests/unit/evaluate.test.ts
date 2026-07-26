import { describe, expect, it } from 'vitest'

import { evalTrackAt, resolveComposition, resolveLayerTransform } from '@/core/evaluate.ts'
import { createEmptyProject, createImageLayer, createStaticTrack, resetIdCounter } from '@/core/factory.ts'
import type { AssetRef, Track } from '@/core/types.ts'

function makeAsset(id: string): AssetRef {
  return { id, name: id, storeKey: `idb:asset:${id}`, naturalW: 600, naturalH: 600, hasAlpha: true }
}

describe('evalTrackAt', () => {
  it('키가 하나면 상수다', () => {
    const track = createStaticTrack('scale', 'ratio', 1.2)
    expect(evalTrackAt(track, 0)).toBe(1.2)
    expect(evalTrackAt(track, 99)).toBe(1.2)
  })

  it('구간 밖은 양끝 값으로 클램프한다', () => {
    const track: Track = {
      id: 't1',
      prop: 'scale',
      unit: 'ratio',
      keys: [
        { f: 10, v: 1.0, interp: 'linear' },
        { f: 20, v: 2.0, interp: 'linear' },
      ],
    }
    expect(evalTrackAt(track, 0)).toBe(1.0)
    expect(evalTrackAt(track, 30)).toBe(2.0)
  })

  it('linear 는 선형 보간이다', () => {
    const track: Track = {
      id: 't1',
      prop: 'scale',
      unit: 'ratio',
      keys: [
        { f: 0, v: 1.0, interp: 'linear' },
        { f: 10, v: 2.0, interp: 'linear' },
      ],
    }
    expect(evalTrackAt(track, 5)).toBeCloseTo(1.5, 10)
  })

  it('hold 는 다음 키까지 값을 붙잡는다', () => {
    const track: Track = {
      id: 't1',
      prop: 'scale',
      unit: 'ratio',
      keys: [
        { f: 0, v: 1.0, interp: 'hold' },
        { f: 10, v: 2.0, interp: 'hold' },
      ],
    }
    expect(evalTrackAt(track, 9)).toBe(1.0)
    expect(evalTrackAt(track, 10)).toBe(2.0)
  })
})

describe('채널 결합 규칙', () => {
  it('scale 은 곱하고 translate 는 더한다', () => {
    resetIdCounter()
    const doc = createEmptyProject()
    const layer = createImageLayer(makeAsset('a1'), 0)
    layer.tracks = [
      createStaticTrack('scale', 'ratio', 1.5),
      createStaticTrack('scaleX', 'ratio', 2.0),
      createStaticTrack('translateX', 'px', 10),
      createStaticTrack('rotate', 'deg', 15),
    ]
    // 같은 채널에 두 트랙을 걸어 결합을 확인한다
    layer.tracks.push(createStaticTrack('translateX', 'px', 5))

    const t = resolveLayerTransform(layer, 0, doc.canvas)
    expect(t.scaleY).toBeCloseTo(1.5, 10)
    expect(t.scaleX).toBeCloseTo(3.0, 10) // 1.5 * 2.0
    expect(t.translateX).toBeCloseTo(15, 10) // 10 + 5
    expect(t.rotate).toBeCloseTo(15, 10)
  })

  it('percentOfCanvas 단위는 캔버스 크기로 환산된다', () => {
    const doc = createEmptyProject()
    doc.canvas.w = 500
    doc.canvas.h = 400
    const layer = createImageLayer(makeAsset('a1'), 0)
    layer.tracks = [
      createStaticTrack('translateX', 'percentOfCanvas', 6),
      createStaticTrack('translateY', 'percentOfCanvas', 10),
    ]
    const t = resolveLayerTransform(layer, 0, doc.canvas)
    expect(t.translateX).toBeCloseTo(30, 10) // 500 * 0.06
    expect(t.translateY).toBeCloseTo(40, 10) // 400 * 0.10
  })

  it('트랙이 없으면 항등 변환이다', () => {
    const doc = createEmptyProject()
    const layer = createImageLayer(makeAsset('a1'), 0)
    const t = resolveLayerTransform(layer, 0, doc.canvas)
    expect(t.scaleX).toBe(1)
    expect(t.scaleY).toBe(1)
    expect(t.rotate).toBe(0)
    expect(t.opacity).toBe(1)
    expect(t.anchorX).toBe(0.5)
  })
})

describe('resolveComposition', () => {
  it('z 오름차순으로 정렬한다', () => {
    const doc = createEmptyProject()
    const a = createImageLayer(makeAsset('a1'), 2)
    const b = createImageLayer(makeAsset('a2'), 0)
    const c = createImageLayer(makeAsset('a3'), 1)
    doc.layers = [a, b, c]

    const resolved = resolveComposition(doc, 0)
    expect(resolved.map((l) => l.z)).toEqual([0, 1, 2])
    expect(resolved[0]!.layerId).toBe(b.id)
  })

  it('같은 문서와 같은 프레임이면 같은 결과다 (결정론)', () => {
    const doc = createEmptyProject()
    doc.layers = [createImageLayer(makeAsset('a1'), 0)]
    doc.layers[0]!.tracks = [createStaticTrack('rotate', 'deg', 7)]

    const first = resolveComposition(doc, 12)
    const second = resolveComposition(doc, 12)
    expect(JSON.stringify(first)).toBe(JSON.stringify(second))
  })
})
