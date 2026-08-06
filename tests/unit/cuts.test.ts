/**
 * 컷 편집.
 *
 * 여기서 지키는 것은 네 가지다.
 *   1. 컷이 없는 문서의 그림은 한 점도 바뀌지 않는다.
 *   2. 총 길이 = 컷 길이의 합 - 겹침의 합.
 *   3. 구간 밖 레이어는 그려지지 않고, 겹침 구간에서는 앞뒤가 서로 섞인다.
 *   4. 컷 문서가 저장 -> 열기 왕복에서 한 글자도 달라지지 않는다.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import {
  CUT_FRAMES_MIN,
  cutAtFrame,
  cutRanges,
  cutsTotalFrames,
  layerTimeGate,
  normalizeCut,
} from '@/core/cuts.ts'
import { resolveComposition } from '@/core/evaluate.ts'
import { createEmptyProject, createImageLayer, resetIdCounter } from '@/core/factory.ts'
import type { AssetRef, CutSpec, MotionProject } from '@/core/types.ts'
import { migrateProject } from '@/project/migrate.ts'
import { useDocumentStore } from '@/state/document.ts'
import { useLayerUiStore } from '@/state/layerUi.ts'
import { addCut, assignToCut, cutRangesOf, cutsOf, removeCut, setCutCross } from '@/state/cutActions.ts'

const s = () => useDocumentStore.getState()

function docWithLayers(count: number): MotionProject {
  resetIdCounter()
  const doc = createEmptyProject()
  const ref: AssetRef = {
    id: 'a1', name: 'x', storeKey: 'k', naturalW: 100, naturalH: 100, hasAlpha: true,
  }
  doc.assets.push(ref)
  for (let i = 0; i < count; i += 1) doc.layers.push(createImageLayer(ref, i))
  return doc
}

const cut = (id: string, frames: number, crossFrames = 0): CutSpec => ({
  id,
  name: id,
  frames,
  crossFrames,
})

describe('cutRanges', () => {
  it('컷을 순서대로 이어 붙인다', () => {
    const ranges = cutRanges([cut('a', 10), cut('b', 10)])
    expect(ranges.map((r) => [r.start, r.end])).toEqual([
      [0, 9],
      [10, 19],
    ])
    expect(cutsTotalFrames([cut('a', 10), cut('b', 10)])).toBe(20)
  })

  it('겹침만큼 뒤 컷이 앞으로 당겨진다', () => {
    const cuts = [cut('a', 10), cut('b', 10, 4)]
    const ranges = cutRanges(cuts)
    expect(ranges[1]!.start).toBe(6)
    expect(cutsTotalFrames(cuts)).toBe(16)
  })

  it('첫 컷의 겹침은 무시한다', () => {
    expect(cutRanges([cut('a', 10, 5)])[0]!.start).toBe(0)
  })

  it('겹침이 컷 길이를 넘어도 컷이 사라지지 않는다', () => {
    const ranges = cutRanges([cut('a', 10), cut('b', 5, 99)])
    expect(ranges[1]!.end).toBeGreaterThan(ranges[1]!.start)
  })

  it('겹침 구간에서는 뒤 컷이 이긴다', () => {
    const cuts = [cut('a', 10), cut('b', 10, 4)]
    // 6~9 는 두 컷이 겹친다. 전환이 뒤쪽으로 가므로 뒤 컷을 답한다.
    expect(cutAtFrame(cuts, 7)?.id).toBe('b')
    expect(cutAtFrame(cuts, 3)?.id).toBe('a')
    expect(cutAtFrame(cuts, 999)).toBeNull()
  })

  it('망가진 값도 그릴 수 있는 컷이 된다', () => {
    const c = normalizeCut({ frames: -5, crossFrames: 999 }, 0)
    expect(c.frames).toBe(CUT_FRAMES_MIN)
    expect(c.crossFrames).toBeLessThan(c.frames)
    expect(c.id.length).toBeGreaterThan(0)
  })
})

describe('layerTimeGate', () => {
  it('구간이 없으면 언제나 보인다', () => {
    expect(layerTimeGate({}, 0)).toBe(1)
    expect(layerTimeGate({}, 9999)).toBe(1)
  })

  it('구간 밖은 0 이다', () => {
    const range = { inFrame: 10, outFrame: 20 }
    expect(layerTimeGate(range, 9)).toBe(0)
    expect(layerTimeGate(range, 21)).toBe(0)
    expect(layerTimeGate(range, 10)).toBe(1)
    expect(layerTimeGate(range, 20)).toBe(1)
  })

  it('들어오는 페이드는 첫 프레임부터 0 보다 크다', () => {
    // 첫 프레임이 0 이면 컷 전환에서 한 프레임이 통째로 빈다.
    const range = { inFrame: 10, outFrame: 20, inFade: 4 }
    expect(layerTimeGate(range, 10)).toBeGreaterThan(0)
    expect(layerTimeGate(range, 10)).toBeLessThan(1)
    expect(layerTimeGate(range, 14)).toBe(1)
  })

  it('나가는 페이드는 마지막 프레임에서 가장 옅다', () => {
    const range = { inFrame: 0, outFrame: 20, outFade: 4 }
    expect(layerTimeGate(range, 20)).toBeLessThan(layerTimeGate(range, 18))
    expect(layerTimeGate(range, 20)).toBeGreaterThan(0)
    expect(layerTimeGate(range, 10)).toBe(1)
  })

  it('페이드는 단조롭게 오르내린다', () => {
    const range = { inFrame: 0, outFrame: 20, inFade: 5, outFade: 5 }
    for (let f = 0; f < 5; f += 1) {
      expect(layerTimeGate(range, f)).toBeLessThanOrEqual(layerTimeGate(range, f + 1))
    }
    for (let f = 16; f < 20; f += 1) {
      expect(layerTimeGate(range, f)).toBeGreaterThanOrEqual(layerTimeGate(range, f + 1))
    }
  })
})

describe('구간이 렌더 결과에 반영된다', () => {
  it('구간 밖 레이어는 그려지지 않는다', () => {
    const doc = docWithLayers(2)
    doc.layers[0]!.inFrame = 0
    doc.layers[0]!.outFrame = 9
    doc.layers[1]!.inFrame = 10
    doc.layers[1]!.outFrame = 19

    const first = resolveComposition(doc, 5)
    expect(first.filter((l) => l.visible).map((l) => l.layerId)).toEqual([doc.layers[0]!.id])

    const second = resolveComposition(doc, 15)
    expect(second.filter((l) => l.visible).map((l) => l.layerId)).toEqual([doc.layers[1]!.id])
  })

  it('겹침 구간에서는 둘 다 반투명하게 보인다', () => {
    const doc = docWithLayers(2)
    doc.layers[0]!.inFrame = 0
    doc.layers[0]!.outFrame = 12
    doc.layers[0]!.outFade = 4
    doc.layers[1]!.inFrame = 9
    doc.layers[1]!.outFrame = 20
    doc.layers[1]!.inFade = 4

    const mid = resolveComposition(doc, 11)
    const visible = mid.filter((l) => l.visible)
    expect(visible).toHaveLength(2)
    for (const layer of visible) {
      expect(layer.transform.opacity).toBeGreaterThan(0)
      expect(layer.transform.opacity).toBeLessThan(1)
    }
  })

  it('구간이 없는 문서는 지금까지와 똑같다', () => {
    const doc = docWithLayers(2)
    const resolved = resolveComposition(doc, 7)
    expect(resolved.every((l) => l.visible)).toBe(true)
    expect(resolved.every((l) => l.transform.opacity === 1)).toBe(true)
  })
})

describe('컷 액션', () => {
  beforeEach(() => {
    s().replaceDocument(docWithLayers(2))
    useLayerUiStore.getState().setSelectedLayerIds([], null)
  })

  it('컷이 없는 문서도 한 컷으로 보인다', () => {
    expect(cutsOf(s().doc)).toHaveLength(1)
    expect(s().doc.cuts).toBeUndefined()
  })

  it('컷을 더하면 길이가 늘어난다', () => {
    const before = s().doc.timeline.durationFrames
    addCut()
    expect(s().doc.cuts).toHaveLength(2)
    expect(s().doc.timeline.durationFrames).toBeGreaterThan(before)
  })

  it('컷 하나만 남으면 목록을 지운다', () => {
    addCut()
    const [, second] = cutRangesOf(s().doc)
    removeCut(second!.id)
    expect(s().doc.cuts).toBeUndefined()
  })

  it('컷 추가와 길이 변경이 실행취소 한 칸이다', () => {
    const frames = s().doc.timeline.durationFrames
    addCut()
    s().undo()
    expect(s().doc.cuts).toBeUndefined()
    expect(s().doc.timeline.durationFrames).toBe(frames)
  })

  it('고른 레이어를 컷 범위로 넣는다', () => {
    addCut()
    const ranges = cutRangesOf(s().doc)
    const layerId = s().doc.layers[0]!.id
    useLayerUiStore.getState().setSelectedLayerIds([layerId], layerId)

    const moved = assignToCut(ranges[1]!.id)
    expect(moved).toBe(1)
    const layer = s().doc.layers.find((l) => l.id === layerId)!
    expect(layer.inFrame).toBe(ranges[1]!.start)
    expect(layer.outFrame).toBe(ranges[1]!.end)
  })

  it('겹침이 그대로 전환 시간이 된다', () => {
    addCut()
    const ranges = cutRangesOf(s().doc)
    setCutCross(ranges[1]!.id, 5)

    const fresh = cutRangesOf(s().doc)
    const layerId = s().doc.layers[0]!.id
    useLayerUiStore.getState().setSelectedLayerIds([layerId], layerId)
    assignToCut(fresh[1]!.id)

    expect(s().doc.layers.find((l) => l.id === layerId)!.inFade).toBe(5)
  })
})

describe('컷 저장 왕복', () => {
  it('한 글자도 달라지지 않는다', () => {
    const before = docWithLayers(2)
    before.cuts = [cut('c1', 10), cut('c2', 12, 3)]
    before.timeline.durationFrames = cutsTotalFrames(before.cuts)
    before.layers[0]!.inFrame = 0
    before.layers[0]!.outFrame = 9
    before.layers[0]!.outFade = 3
    before.layers[1]!.inFrame = 7
    before.layers[1]!.outFrame = 18
    before.layers[1]!.inFade = 3

    const { doc, warnings } = migrateProject(JSON.parse(JSON.stringify(before)) as unknown)
    expect(warnings).toEqual([])
    expect(JSON.stringify(doc)).toBe(JSON.stringify(before))
  })

  it('컷 하나짜리 목록은 지운다', () => {
    const before = docWithLayers(1) as unknown as Record<string, unknown>
    before['cuts'] = [cut('only', 10)]
    const { doc } = migrateProject(JSON.parse(JSON.stringify(before)) as unknown)
    expect(doc.cuts).toBeUndefined()
  })

  it('망가진 구간 값은 버린다', () => {
    const before = docWithLayers(1) as unknown as Record<string, unknown>
    const layers = before['layers'] as Record<string, unknown>[]
    layers[0]!['inFrame'] = 'soon'
    layers[0]!['outFade'] = NaN
    const { doc } = migrateProject(JSON.parse(JSON.stringify(before)) as unknown)
    expect(doc.layers[0]).not.toHaveProperty('inFrame')
    expect(doc.layers[0]).not.toHaveProperty('outFade')
  })
})

/**
 * 첫 컷의 겹침은 무시된다. 앞에 겹칠 것이 없다.
 *
 * 컷 패널이 이 규칙을 우회해 doc.cuts[i].crossFrames 원본을 그대로 보여 주고
 * 있었다. 겹침 5 를 넣어 둔 컷을 맨 위로 올리면 화면에는 5 로 남는데 구간 계산과
 * 배정은 0 으로 돌았고, 첫 컷의 그 칸은 비활성이라 되돌릴 수단도 없었다.
 * 화면이 읽어야 할 값은 언제나 cutRanges 가 내놓는 쪽이다.
 */
describe('첫 컷의 겹침', () => {
  it('맨 앞 컷은 겹침이 0 으로 계산된다', () => {
    const ranges = cutRanges([cut('a', 10, 5), cut('b', 10, 5)])
    expect(ranges[0]!.crossFrames).toBe(0)
    expect(ranges[1]!.crossFrames).toBe(5)
    // 첫 컷은 0 프레임에서 시작한다. 겹침이 살아 있으면 음수로 당겨진다.
    expect(ranges[0]!.start).toBe(0)
  })

  it('순서를 바꿔도 맨 앞이 된 컷의 겹침이 0 이다', () => {
    const moved = cutRanges([cut('b', 10, 5), cut('a', 10, 0)])
    expect(moved[0]!.crossFrames).toBe(0)
    expect(moved[0]!.start).toBe(0)
  })
})
