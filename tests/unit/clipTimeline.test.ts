/**
 * 전체 타임라인(클립 층)이 지켜야 하는 것.
 *
 * 여기서 붙잡는 계약은 세 가지다.
 *
 *   1. 구간 없는 레이어와 전 구간으로 맞춘 레이어는 다르다. (explicit)
 *   2. 여러 장을 차례로 나누면 한 프레임도 겹치지 않고 사이도 비지 않는다.
 *      눈 깜빡임이 이 성질 하나에 걸려 있다. 겹치면 두 장이 동시에 보이고,
 *      비면 그 프레임에 아무것도 없다.
 *   3. 두 층의 세로 좌표는 한 군데서만 나온다. 캔버스와 머리 열이 갈라지면
 *      "이름은 A 인데 눌리는 것은 B" 가 된다.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { layerRange, layerTimeGate, splitRange } from '@/core/cuts.ts'
import type { AssetRef, Layer, MotionProject } from '@/core/types.ts'
import { createEmptyProject, createImageLayer, resetIdCounter } from '@/core/factory.ts'
import { useDocumentStore } from '@/state/document.ts'
import {
  clearRanges,
  defaultRangeFrames,
  dropRangesAt,
  setRangeEnd,
  setRangeStart,
  splitSequential,
} from '@/state/rangeActions.ts'
import {
  buildClipRows,
  clipBarRect,
  clipBottomY,
  clipRowIndexAtY,
  hitTestClip,
  resolveClipDrag,
  rowIndexAtY,
  rowYCenter,
  timelineContentH,
  tracksTopY,
  type ClipRow,
  type TimelineGeometry,
} from '@/ui/timeline/timelineDraw.ts'
import type { LayerRow } from '@/ui/layers/layerTree.ts'

// ---------------------------------------------------------------------------

function geo(clipCount: number, trackCount: number): TimelineGeometry {
  return {
    rulerH: 30,
    rowH: 24,
    clipRowH: 26,
    clipCount,
    sectionH: 18,
    trackCount,
    axis: { originX: 0, pxPerFrame: 10, scrollFrame: 0 },
  }
}

const ASSET: AssetRef = {
  id: 'a1',
  name: 'x',
  storeKey: 'k',
  naturalW: 100,
  naturalH: 100,
  hasAlpha: true,
}

function makeLayer(name: string, z = 0): Layer {
  const layer = createImageLayer(ASSET, z)
  layer.name = name
  return layer
}

function rowOf(layer: Layer, depth = 0): LayerRow {
  return { layer, depth, childCount: 0, collapsed: false }
}

// ---------------------------------------------------------------------------

beforeEach(() => resetIdCounter())

describe('구간 펴기', () => {
  it('구간이 없으면 처음부터 끝까지이고 explicit 이 거짓이다', () => {
    expect(layerRange({}, 30)).toEqual({ start: 0, end: 29, explicit: false })
  })

  it('전 구간으로 맞춰 둔 레이어는 explicit 이 참이다', () => {
    // 같은 프레임을 가리켜도 뜻이 다르다. 길이를 늘리면 앞은 따라 늘어나고 뒤는 남는다.
    expect(layerRange({ inFrame: 0, outFrame: 29 }, 30)).toEqual({
      start: 0,
      end: 29,
      explicit: true,
    })
  })

  it('한쪽만 있으면 나머지는 문서 끝으로 채운다', () => {
    expect(layerRange({ inFrame: 5 }, 30)).toEqual({ start: 5, end: 29, explicit: true })
    expect(layerRange({ outFrame: 9 }, 30)).toEqual({ start: 0, end: 9, explicit: true })
  })

  it('문서 길이를 넘는 값은 안으로 접는다', () => {
    expect(layerRange({ inFrame: 100, outFrame: 200 }, 30)).toEqual({
      start: 29,
      end: 29,
      explicit: true,
    })
  })
})

describe('차례로 나누기', () => {
  it('토막이 이어 붙고 겹치지 않는다', () => {
    const blocks = splitRange(3, 0, 29)
    expect(blocks).toHaveLength(3)
    for (let i = 1; i < blocks.length; i += 1) {
      expect(blocks[i]!.start).toBe(blocks[i - 1]!.end + 1)
    }
    expect(blocks[0]!.start).toBe(0)
    expect(blocks[blocks.length - 1]!.end).toBe(29)
  })

  it('나머지는 앞 토막이 가져간다', () => {
    // 31 프레임을 셋으로 나누면 11 / 10 / 10 이다. 뒤에 몰면 끝만 길어져 리듬이 무너진다.
    const blocks = splitRange(3, 0, 30)
    expect(blocks.map((b) => b.end - b.start + 1)).toEqual([11, 10, 10])
  })

  it('세 장을 나누면 어느 프레임에서도 정확히 한 장만 보인다', () => {
    // 눈 깜빡임의 계약. 여기가 깨지면 두 장이 겹쳐 보이거나 빈 프레임이 생긴다.
    const blocks = splitRange(3, 0, 29)
    const layers = blocks.map((b) => ({ inFrame: b.start, outFrame: b.end }))
    for (let f = 0; f <= 29; f += 1) {
      const on = layers.filter((l) => layerTimeGate(l, f) > 0)
      expect(on, `frame ${f}`).toHaveLength(1)
      expect(layerTimeGate(on[0]!, f), `frame ${f} 은 딱 끊긴다`).toBe(1)
    }
  })

  it('프레임이 모자라면 만들 수 있는 만큼만 만든다', () => {
    // 길이 0 짜리 구간은 문서에 쓸 수 없다. 조용히 겹치게 두는 것보다 낫다.
    const blocks = splitRange(5, 0, 2)
    expect(blocks).toHaveLength(3)
    expect(blocks.map((b) => [b.start, b.end])).toEqual([
      [0, 0],
      [1, 1],
      [2, 2],
    ])
  })

  it('토막이 하나면 구간 전체다', () => {
    expect(splitRange(1, 4, 9)).toEqual([{ start: 4, end: 9 }])
  })
})

describe('클립 줄 만들기', () => {
  it('레이어 목록 순서와 깊이를 그대로 옮긴다', () => {
    const a = makeLayer('눈뜬', 0)
    const b = makeLayer('반눈', 1)
    const rows = buildClipRows([rowOf(a), rowOf(b, 1)], 30)
    expect(rows.map((r) => r.name)).toEqual(['눈뜬', '반눈'])
    expect(rows.map((r) => r.depth)).toEqual([0, 1])
  })

  it('키가 하나뿐인 트랙은 눈금을 찍지 않는다', () => {
    // 시간에 따라 변하지 않는 트랙이다. 점을 찍으면 거짓말이 된다.
    const layer = makeLayer('그림')
    layer.tracks = [
      { id: 't1', prop: 'opacity', unit: 'ratio', keys: [{ f: 0, v: 1, interp: 'linear' }] },
      {
        id: 't2',
        prop: 'scale',
        unit: 'ratio',
        keys: [
          { f: 0, v: 1, interp: 'linear' },
          { f: 10, v: 2, interp: 'linear' },
        ],
      },
    ]
    expect(buildClipRows([rowOf(layer)], 30)[0]!.keyFrames).toEqual([0, 10])
  })

  it('구간과 페이드를 그대로 읽는다', () => {
    const layer = makeLayer('그림')
    layer.inFrame = 4
    layer.outFrame = 12
    layer.inFade = 2
    const row = buildClipRows([rowOf(layer)], 30)[0]!
    expect([row.start, row.end, row.explicit, row.inFade, row.outFade]).toEqual([4, 12, true, 2, 0])
  })
})

describe('두 층의 세로 좌표', () => {
  it('속성 층은 클립 층과 구분 머리 아래에서 시작한다', () => {
    const g = geo(3, 2)
    expect(clipBottomY(g)).toBe(30 + 3 * 26)
    expect(tracksTopY(g)).toBe(30 + 3 * 26 + 18)
    expect(timelineContentH(g)).toBe(30 + 3 * 26 + 18 + 2 * 24)
  })

  it('속성 행이 없으면 구분 머리는 자리를 차지하지 않는다', () => {
    const g = geo(3, 0)
    expect(tracksTopY(g)).toBe(clipBottomY(g))
    expect(timelineContentH(g)).toBe(clipBottomY(g))
  })

  it('행 번호와 y 가 서로의 역이다', () => {
    const g = geo(3, 2)
    for (let i = 0; i < 3; i += 1) {
      // 줄 한가운데를 물어보면 그 줄이 나와야 한다.
      expect(clipRowIndexAtY(g.rulerH + i * g.clipRowH + g.clipRowH / 2, g)).toBe(i)
    }
    for (let i = 0; i < 2; i += 1) {
      expect(rowIndexAtY(rowYCenter(i, g), g, 2)).toBe(i)
    }
  })

  it('눈금자와 클립 층은 속성 행으로 잡히지 않는다', () => {
    const g = geo(3, 2)
    expect(rowIndexAtY(10, g, 2)).toBe(-1)
    expect(rowIndexAtY(clipBottomY(g) - 4, g, 2)).toBe(-1)
    expect(clipRowIndexAtY(10, g)).toBe(-1)
    expect(clipRowIndexAtY(clipBottomY(g) + 4, g)).toBe(-1)
  })
})

describe('클립 막대 집기', () => {
  const rows: ClipRow[] = [
    {
      layerId: 'L1',
      name: '그림',
      type: 'image',
      depth: 0,
      isFolder: false,
      visible: true,
      locked: false,
      clipped: false,
      start: 10,
      end: 19,
      explicit: true,
      inFade: 0,
      outFade: 0,
      keyFrames: [],
    },
  ]
  const g = geo(1, 0)
  const midY = g.rulerH + g.clipRowH / 2

  it('끝 프레임도 한 칸을 차지한다', () => {
    // 오른쪽 끝이 end 면 마지막 프레임이 폭 0 으로 사라진다.
    const rect = clipBarRect(rows[0]!, 0, g)
    expect(rect.x0).toBe(100)
    expect(rect.x1).toBe(200)
  })

  it('가운데는 이동, 양끝은 길이 조절이다', () => {
    expect(hitTestClip(rows, g, 150, midY)?.part).toBe('body')
    expect(hitTestClip(rows, g, 102, midY)?.part).toBe('start')
    expect(hitTestClip(rows, g, 198, midY)?.part).toBe('end')
  })

  it('막대 밖은 잡히지 않는다', () => {
    expect(hitTestClip(rows, g, 20, midY)).toBeNull()
    expect(hitTestClip(rows, g, 400, midY)).toBeNull()
  })

  it('짧은 막대도 가운데가 남는다', () => {
    // 양끝이 서로를 먹으면 통째로 옮길 방법이 사라진다.
    const tiny: ClipRow[] = [{ ...rows[0]!, start: 10, end: 11 }]
    const hit = hitTestClip(tiny, g, (100 + 120) / 2, midY)
    expect(hit?.part).toBe('body')
  })

  it('눈금자 높이에서는 아무것도 잡히지 않는다', () => {
    expect(hitTestClip(rows, g, 150, 5)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 문서 스토어
// ---------------------------------------------------------------------------

const s = () => useDocumentStore.getState()

function docWithLayers(count: number): MotionProject {
  resetIdCounter()
  const doc = createEmptyProject()
  doc.assets.push(ASSET)
  for (let i = 0; i < count; i += 1) doc.layers.push(createImageLayer(ASSET, i))
  return doc
}

describe('구간 쓰기', () => {
  beforeEach(() => {
    s().replaceDocument(docWithLayers(3))
    s().setDurationFrames(30)
  })

  it('장마다 다른 구간을 한 번에 쓴다', () => {
    const ids = s().doc.layers.map((l) => l.id)
    s().setLayerRanges(
      [
        { layerId: ids[0]!, inFrame: 0, outFrame: 9 },
        { layerId: ids[2]!, inFrame: 20, outFrame: 29 },
      ],
      '구간 변경',
    )
    const after = s().doc.layers
    expect([after[0]!.inFrame, after[0]!.outFrame]).toEqual([0, 9])
    // 목록에 없는 레이어는 손대지 않는다.
    expect(after[1]!.inFrame).toBeUndefined()
    expect([after[2]!.inFrame, after[2]!.outFrame]).toEqual([20, 29])
  })

  it('문서 길이를 넘는 값은 안으로 접는다', () => {
    const id = s().doc.layers[0]!.id
    s().setLayerRanges([{ layerId: id, inFrame: 25, outFrame: 999 }], '구간 변경')
    expect(s().doc.layers[0]!.outFrame).toBe(29)
  })

  it('구간보다 긴 페이드는 구간 안으로 접힌다', () => {
    // 접지 않으면 구간 전체가 반투명해져 "왜 흐릿하지" 가 된다.
    const id = s().doc.layers[0]!.id
    s().setLayerRange([id], { inFrame: 0, outFrame: 20, inFade: 10 })
    s().setLayerRanges([{ layerId: id, inFrame: 0, outFrame: 4 }], '구간 변경')
    expect(s().doc.layers[0]!.inFade).toBe(4)
  })

  it('clearFades 를 켜면 페이드가 사라진다', () => {
    const id = s().doc.layers[0]!.id
    s().setLayerRange([id], { inFrame: 0, outFrame: 20, inFade: 3, outFade: 3 })
    s().setLayerRanges([{ layerId: id, inFrame: 0, outFrame: 20 }], '구간 변경', {
      clearFades: true,
    })
    // 0 은 키 자체를 남기지 않는다. 남으면 저장 파일의 왕복 JSON 이 달라진다.
    expect('inFade' in s().doc.layers[0]!).toBe(false)
    expect('outFade' in s().doc.layers[0]!).toBe(false)
  })

  it('같은 열쇠로 이어 쓰면 실행취소 한 칸이다', () => {
    // 막대를 한 번 끄는 동안 히스토리가 스텝 수만큼 쌓이면 Ctrl+Z 를 수십 번 눌러야 한다.
    const id = s().doc.layers[0]!.id
    const before = s().past.length
    for (let i = 1; i <= 5; i += 1) {
      s().setLayerRanges([{ layerId: id, inFrame: i, outFrame: i + 9 }], '구간 변경', {
        coalesceKey: 'clipDrag:1',
      })
    }
    expect(s().past.length).toBe(before + 1)
    expect(s().doc.layers[0]!.inFrame).toBe(5)
    s().undo()
    expect(s().doc.layers[0]!.inFrame).toBeUndefined()
  })
})

describe('차례로 나누기 (스토어)', () => {
  beforeEach(() => {
    s().replaceDocument(docWithLayers(3))
    s().setDurationFrames(30)
  })

  it('눈뜬 / 반눈 / 감은 세 장이 겹치지 않게 나뉜다', () => {
    const ids = s().doc.layers.map((l) => l.id)
    expect(splitSequential(ids)).toBe(3)

    const layers = s().doc.layers
    expect(layers.map((l) => [l.inFrame, l.outFrame])).toEqual([
      [0, 9],
      [10, 19],
      [20, 29],
    ])
    for (let f = 0; f < 30; f += 1) {
      const on = layers.filter((l) => layerTimeGate(l, f) > 0)
      expect(on, `frame ${f}`).toHaveLength(1)
    }
  })

  it('페이드가 남아 있어도 지우고 나눈다', () => {
    // 깜빡임은 서서히 바뀌면 안 된다.
    const ids = s().doc.layers.map((l) => l.id)
    s().setLayerRange(ids, { inFrame: 0, outFrame: 29, inFade: 5, outFade: 5 })
    splitSequential(ids)
    for (const layer of s().doc.layers) {
      expect('inFade' in layer).toBe(false)
      expect('outFade' in layer).toBe(false)
    }
  })
})

describe('타임라인에 놓기', () => {
  beforeEach(() => {
    s().replaceDocument(docWithLayers(2))
    s().setDurationFrames(40)
  })

  it('구간이 없으면 기본 길이로 생긴다', () => {
    const id = s().doc.layers[0]!.id
    dropRangesAt([id], 8)
    const layer = s().doc.layers[0]!
    expect(layer.inFrame).toBe(8)
    expect(layer.outFrame! - layer.inFrame! + 1).toBe(defaultRangeFrames(40))
  })

  it('구간이 있으면 길이를 지키며 옮긴다', () => {
    // 여러 장을 차례로 놓는 동안 길이까지 달라지면 리듬이 어긋난다.
    const id = s().doc.layers[0]!.id
    s().setLayerRanges([{ layerId: id, inFrame: 0, outFrame: 5 }], '구간 변경')
    dropRangesAt([id], 20)
    expect([s().doc.layers[0]!.inFrame, s().doc.layers[0]!.outFrame]).toEqual([20, 25])
  })

  it('끝을 넘겨 놓아도 구간 전체가 안에 들어온다', () => {
    const id = s().doc.layers[0]!.id
    s().setLayerRanges([{ layerId: id, inFrame: 0, outFrame: 9 }], '구간 변경')
    dropRangesAt([id], 38)
    expect([s().doc.layers[0]!.inFrame, s().doc.layers[0]!.outFrame]).toEqual([30, 39])
  })

  it('여러 장을 한꺼번에 놓으면 각자 길이를 지키고 실행취소는 한 칸이다', () => {
    const ids = s().doc.layers.map((l) => l.id)
    s().setLayerRanges([{ layerId: ids[0]!, inFrame: 0, outFrame: 5 }], '구간 변경')
    const depth = s().past.length
    dropRangesAt(ids, 10)
    const [a, b] = s().doc.layers
    expect([a!.inFrame, a!.outFrame]).toEqual([10, 15])
    expect(b!.inFrame).toBe(10)
    expect(b!.outFrame! - b!.inFrame! + 1).toBe(defaultRangeFrames(40))
    expect(s().past.length).toBe(depth + 1)
  })
})

describe('구간 시작과 끝 맞추기', () => {
  beforeEach(() => {
    s().replaceDocument(docWithLayers(2))
    s().setDurationFrames(30)
  })

  it('시작만 정하면 끝은 문서 끝이다', () => {
    const id = s().doc.layers[0]!.id
    setRangeStart([id], 12)
    expect([s().doc.layers[0]!.inFrame, s().doc.layers[0]!.outFrame]).toEqual([12, 29])
  })

  it('끝만 정하면 시작은 0 이다', () => {
    const id = s().doc.layers[0]!.id
    // 재생헤드는 칸의 왼쪽 변이다. 12 에서 끝을 누르면 11 프레임까지만 보인다.
    setRangeEnd([id], 12)
    expect([s().doc.layers[0]!.inFrame, s().doc.layers[0]!.outFrame]).toEqual([0, 11])
  })

  it('0 프레임에서 끝을 눌러도 한 프레임은 남는다', () => {
    const id = s().doc.layers[0]!.id
    setRangeEnd([id], 0)
    expect([s().doc.layers[0]!.inFrame, s().doc.layers[0]!.outFrame]).toEqual([0, 0])
  })

  it('마지막 프레임에서 끝을 누르면 끝까지 다 들어간다', () => {
    // 재생헤드는 마지막 칸 너머로 못 간다. 여기서도 한 칸을 빼면
    // 마지막 프레임을 포함시킬 방법이 아예 없어진다.
    const id = s().doc.layers[0]!.id
    setRangeEnd([id], 29)
    expect(s().doc.layers[0]!.outFrame).toBe(29)
  })

  it('시작이 끝을 넘어가면 끝이 따라온다', () => {
    const id = s().doc.layers[0]!.id
    setRangeEnd([id], 5)
    setRangeStart([id], 20)
    expect([s().doc.layers[0]!.inFrame, s().doc.layers[0]!.outFrame]).toEqual([20, 20])
  })

  it('구간 해제는 키를 통째로 지운다', () => {
    const id = s().doc.layers[0]!.id
    setRangeStart([id], 5)
    clearRanges([id])
    expect('inFrame' in s().doc.layers[0]!).toBe(false)
    expect('outFrame' in s().doc.layers[0]!).toBe(false)
  })
})

describe('클립 막대 끌기', () => {
  const items = [
    { layerId: 'a', start: 0, end: 9 },
    { layerId: 'b', start: 20, end: 29 },
  ]

  it('통째로 옮기면 간격이 유지된다', () => {
    const out = resolveClipDrag('body', items, 3, 39)
    expect(out).toEqual([
      { layerId: 'a', inFrame: 3, outFrame: 12 },
      { layerId: 'b', inFrame: 23, outFrame: 32 },
    ])
  })

  it('한 장이 끝에 닿으면 전부가 함께 멈춘다', () => {
    // 장마다 따로 자르면 닿은 것만 서고 나머지는 계속 가서 간격이 무너진다.
    const out = resolveClipDrag('body', items, 100, 39)
    expect(out).toEqual([
      { layerId: 'a', inFrame: 10, outFrame: 19 },
      { layerId: 'b', inFrame: 30, outFrame: 39 },
    ])
  })

  it('왼쪽 끝에서도 함께 멈춘다', () => {
    const out = resolveClipDrag('body', items, -100, 39)
    expect(out[0]).toEqual({ layerId: 'a', inFrame: 0, outFrame: 9 })
    expect(out[1]).toEqual({ layerId: 'b', inFrame: 20, outFrame: 29 })
  })

  it('시작을 끌면 끝은 그대로다', () => {
    expect(resolveClipDrag('start', [items[0]!], 4, 39)).toEqual([
      { layerId: 'a', inFrame: 4, outFrame: 9 },
    ])
  })

  it('시작이 끝을 넘어가지 않는다', () => {
    // 넘어가면 구간이 뒤집혀 아무 프레임에서도 보이지 않는다.
    expect(resolveClipDrag('start', [items[0]!], 99, 39)).toEqual([
      { layerId: 'a', inFrame: 9, outFrame: 9 },
    ])
  })

  it('끝이 시작 앞으로 가지 않는다', () => {
    expect(resolveClipDrag('end', [items[0]!], -99, 39)).toEqual([
      { layerId: 'a', inFrame: 0, outFrame: 0 },
    ])
  })

  it('끝은 문서 마지막 프레임을 넘지 않는다', () => {
    expect(resolveClipDrag('end', [items[1]!], 99, 39)).toEqual([
      { layerId: 'b', inFrame: 20, outFrame: 39 },
    ])
  })

  it('빈 목록은 아무것도 쓰지 않는다', () => {
    expect(resolveClipDrag('body', [], 5, 39)).toEqual([])
  })
})
