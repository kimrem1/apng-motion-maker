/**
 * 캔버스에서 끌어 옮기기와 격자 스냅.
 *
 * 이 파일이 잡아야 하는 것은 전부 좌표 산술이다. 화면에서는 "그림이 손을 안 따라온다"
 * 라는 한 가지 증상으로만 보이고, 원인은 부호 하나이거나 역행렬을 안 곱한 것이거나
 * 단위를 안 되돌린 것이다. 셋 다 재현 조건을 찾기 전에는 눈으로 못 짚는다.
 *
 * 특히 세 가지를 못 박아 둔다.
 *   1. 배치점과 이동 값의 왕복. 폴더가 돌아가고 확대되어 있어도 되돌아와야 한다.
 *   2. 격자는 잡은 레이어 하나에만 붙는다. 여러 장을 함께 끌면 간격이 유지된다.
 *   3. 트랙의 단위는 드래그로 바뀌지 않는다. 사진 훑기 프리셋이 낸
 *      percentOfCanvas 트랙이 px 로 갈아끼워지면 캔버스 크기 대응이 조용히 사라진다.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { createEmptyProject, createFolderLayer, createImageLayer, createShapeLayer, createStaticTrack, resetIdCounter } from '@/core/factory.ts'
import { createShapeSpec } from '@/core/shape.ts'
import { buildGroupMatrix, identityTransform, mat3InvertAffine, mat3ProjectPoint } from '@/core/transform.ts'
import type { AssetRef, Layer, MotionProject } from '@/core/types.ts'
import { getTrack, useDocumentStore } from '@/state/document.ts'
import {
  buildStageScene,
  dragMove,
  dragUnits,
  pickLayerAt,
  placePointOf,
  pointInQuad,
  readTranslatePx,
  snapToGrid,
  translateForPlace,
} from '@/ui/canvas/stageDrag.ts'

const ASSET: AssetRef = {
  id: 'a1', name: '그림', storeKey: 'k1', naturalW: 200, naturalH: 100, hasAlpha: true,
}

const sizeOf = (id: string) => (id === ASSET.id ? { width: 200, height: 100 } : undefined)

function baseDoc(): MotionProject {
  resetIdCounter()
  const doc = createEmptyProject()
  doc.assets.push(ASSET)
  return doc
}

/** 원본 크기 그대로 앉은 이미지 레이어. 캔버스는 512x512 다. */
function imageLayer(doc: MotionProject, z = 0): Layer {
  const layer = createImageLayer(ASSET, z)
  doc.layers.push(layer)
  return layer
}

function setTranslate(layer: Layer, x: number, y: number): void {
  layer.tracks.push(createStaticTrack('translateX', 'px', x))
  layer.tracks.push(createStaticTrack('translateY', 'px', y))
}

function sceneOf(doc: MotionProject, frame = 0) {
  return buildStageScene(doc, frame, sizeOf)
}

// ---------------------------------------------------------------------------
// 매트릭스 되돌리기
// ---------------------------------------------------------------------------

describe('어파인 역행렬', () => {
  it('돌리고 늘인 매트릭스를 왕복해도 제자리다', () => {
    const t = identityTransform()
    t.rotate = 37
    t.scaleX = 1.8
    t.scaleY = 0.6
    t.translateX = 40
    t.translateY = -25
    const g = buildGroupMatrix(t, 512, 512)

    const inverse = mat3InvertAffine(g)
    expect(inverse).toBeDefined()

    for (const [x, y] of [[0, 0], [120, -80], [-33.5, 210]] as [number, number][]) {
      const forward = mat3ProjectPoint(g, x, y)!
      const back = mat3ProjectPoint(inverse!, forward.x, forward.y)!
      // Mat3 는 Float32Array 다. 소수 여섯 자리를 요구하면 정밀도에서 걸린다.
      expect(back.x).toBeCloseTo(x, 4)
      expect(back.y).toBeCloseTo(y, 4)
    }
  })

  it('배율이 0 인 매트릭스는 되돌릴 수 없다', () => {
    const t = identityTransform()
    t.scaleX = 0
    expect(mat3InvertAffine(buildGroupMatrix(t, 512, 512))).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 히트 판정
// ---------------------------------------------------------------------------

describe('무엇을 잡았는가', () => {
  it('사각형 안팎을 가른다', () => {
    const quad = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ]
    expect(pointInQuad(quad, 5, 5)).toBe(true)
    expect(pointInQuad(quad, 10.5, 5)).toBe(false)
    // 변 위는 안으로 본다. 가장자리를 정확히 눌렀을 때 아무것도 안 잡히면 고장으로 읽힌다.
    expect(pointInQuad(quad, 0, 5)).toBe(true)
  })

  it('점이나 선으로 붕괴한 사각형은 아무것도 잡지 않는다', () => {
    // pop-in 애니메이션의 scale 0 프레임에서 quad 가 한 점이 된다. 그때 모든 클릭을
    // 삼키면 보이지도 않는 레이어가 맨 위에서 아래 레이어 선택을 전부 막는다.
    const point = Array.from({ length: 4 }, () => ({ x: 5, y: 5 }))
    expect(pointInQuad(point, 5, 5)).toBe(false)
    expect(pointInQuad(point, 100, 100)).toBe(false)
    const line = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 0 },
      { x: 0, y: 0 },
    ]
    expect(pointInQuad(line, 5, 5)).toBe(false)
  })

  it('원본 크기 그대로면 캔버스 한가운데를 차지한다', () => {
    const doc = baseDoc()
    imageLayer(doc)
    const scene = sceneOf(doc)
    expect(scene.shapes).toHaveLength(1)
    // 200x100 이 512 캔버스 가운데에 앉는다. 좌상단이 (156, 206) 이다.
    expect(scene.shapes[0]!.quad[0]!.x).toBeCloseTo(156, 6)
    expect(scene.shapes[0]!.quad[0]!.y).toBeCloseTo(206, 6)
    expect(pickLayerAt(scene, 256, 256)).toBe(scene.shapes[0]!.layerId)
    expect(pickLayerAt(scene, 10, 10)).toBeNull()
  })

  it('겹치면 위에 그려진 것을 잡는다', () => {
    const doc = baseDoc()
    const under = imageLayer(doc, 0)
    const over = imageLayer(doc, 1)
    expect(pickLayerAt(sceneOf(doc), 256, 256)).toBe(over.id)
    expect(under.id).not.toBe(over.id)
  })

  it('잠긴 것은 건너뛰고 아래 것을 잡는다', () => {
    const doc = baseDoc()
    const under = imageLayer(doc, 0)
    const over = imageLayer(doc, 1)
    over.locked = true
    expect(pickLayerAt(sceneOf(doc), 256, 256)).toBe(under.id)
  })

  it('숨긴 것은 장면에 아예 없다', () => {
    const doc = baseDoc()
    const layer = imageLayer(doc)
    layer.visible = false
    expect(sceneOf(doc).shapes).toHaveLength(0)
  })

  it('폴더는 잡히지 않는다', () => {
    // 폴더는 그리지 않는다. 폴더를 옮기는 길은 선택을 통해서만 열린다.
    const doc = baseDoc()
    const folder = createFolderLayer('묶음', 0)
    doc.layers.push(folder)
    const layer = imageLayer(doc, 1)
    layer.folderId = folder.id
    const scene = sceneOf(doc)
    expect(scene.shapes.map((s) => s.layerId)).toEqual([layer.id])
  })

  it('이동 값만큼 옮겨간 자리에서 잡힌다', () => {
    const doc = baseDoc()
    const layer = imageLayer(doc)
    setTranslate(layer, 100, -60)
    const scene = sceneOf(doc)
    expect(pickLayerAt(scene, 256 + 100, 256 - 60)).toBe(layer.id)
    expect(pickLayerAt(scene, 256, 256)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 배치점
// ---------------------------------------------------------------------------

describe('배치점과 이동 값', () => {
  it('이동이 없으면 캔버스 한가운데다', () => {
    const doc = baseDoc()
    const layer = imageLayer(doc)
    const scene = sceneOf(doc)
    expect(placePointOf(doc, layer, 0, scene.folders)).toEqual({ x: 256, y: 256 })
  })

  it('percentOfCanvas 트랙도 픽셀로 읽는다', () => {
    const doc = baseDoc()
    const layer = imageLayer(doc)
    // 사진 훑기 프리셋이 내는 단위다. 10% 는 512 캔버스에서 51.2px 다.
    layer.tracks.push(createStaticTrack('translateX', 'percentOfCanvas', 10))
    expect(readTranslatePx(doc, layer, 0).x).toBeCloseTo(51.2, 9)
  })

  it('폴더가 돌아가 있어도 왕복하면 제자리다', () => {
    const doc = baseDoc()
    const folder = createFolderLayer('묶음', 0)
    folder.tracks.push(createStaticTrack('rotate', 'deg', 30))
    folder.tracks.push(createStaticTrack('scale', 'ratio', 1.5))
    folder.tracks.push(createStaticTrack('translateX', 'px', 70))
    doc.layers.push(folder)

    const layer = imageLayer(doc, 1)
    layer.folderId = folder.id
    setTranslate(layer, 25, -40)

    const scene = sceneOf(doc)
    const place = placePointOf(doc, layer, 0, scene.folders)
    // 폴더가 옮겨 놓았으므로 배치점은 자기 이동 값과 다르다.
    expect(place.x).not.toBeCloseTo(256 + 25, 3)

    const back = translateForPlace(doc, layer, place, scene.folders)!
    expect(back.x).toBeCloseTo(25, 4)
    expect(back.y).toBeCloseTo(-40, 4)
  })

  it('폴더 안에서 화면 기준으로 끈 만큼만 움직인다', () => {
    /*
     * 폴더가 1.5배로 확대되어 있으면 안쪽 레이어의 이동 값 1 이 화면에서는 1.5 다.
     * 되돌리지 않으면 손보다 1.5배 빨리 달아난다.
     */
    const doc = baseDoc()
    const folder = createFolderLayer('묶음', 0)
    folder.tracks.push(createStaticTrack('scale', 'ratio', 1.5))
    doc.layers.push(folder)
    const layer = imageLayer(doc, 1)
    layer.folderId = folder.id

    const scene = sceneOf(doc)
    const place = placePointOf(doc, layer, 0, scene.folders)
    const moved = translateForPlace(doc, layer, { x: place.x + 30, y: place.y }, scene.folders)!
    expect(moved.x).toBeCloseTo(20, 4)
  })
})

// ---------------------------------------------------------------------------
// 옮길 대상
// ---------------------------------------------------------------------------

describe('무엇을 옮기는가', () => {
  function nested() {
    const doc = baseDoc()
    const outer = createFolderLayer('바깥', 0)
    const inner = createFolderLayer('안쪽', 1)
    inner.folderId = outer.id
    doc.layers.push(outer, inner)
    const layer = imageLayer(doc, 2)
    layer.folderId = inner.id
    const other = imageLayer(doc, 3)
    return { doc, outer, inner, layer, other }
  }

  it('고르지 않은 것을 잡으면 그것 하나다', () => {
    const { doc, layer } = nested()
    expect(dragUnits({ layers: doc.layers, hitId: layer.id, selected: [], solo: false })).toEqual([layer.id])
  })

  it('담고 있는 폴더를 골라 뒀으면 폴더째 옮긴다', () => {
    const { doc, inner, layer } = nested()
    expect(
      dragUnits({ layers: doc.layers, hitId: layer.id, selected: [inner.id], solo: false }),
    ).toEqual([inner.id])
  })

  it('폴더가 여러 겹이면 가장 바깥을 옮긴다', () => {
    // 안쪽은 바깥이 옮기면 따라온다. 안쪽을 고르면 바깥이 제자리에 남는다.
    const { doc, outer, inner, layer } = nested()
    expect(
      dragUnits({ layers: doc.layers, hitId: layer.id, selected: [inner.id, outer.id], solo: false }),
    ).toEqual([outer.id])
  })

  it('Alt 는 폴더 규칙을 무시하고 잡은 레이어만 옮긴다', () => {
    const { doc, inner, layer } = nested()
    expect(
      dragUnits({ layers: doc.layers, hitId: layer.id, selected: [inner.id], solo: true }),
    ).toEqual([layer.id])
  })

  it('고른 것 중 하나를 잡으면 고른 것 전부가 함께 간다', () => {
    const { doc, layer, other } = nested()
    expect(
      dragUnits({ layers: doc.layers, hitId: layer.id, selected: [layer.id, other.id], solo: false }),
    ).toEqual([layer.id, other.id])
  })

  it('조상 폴더도 함께 골랐으면 자식은 목록에서 빠진다', () => {
    // 둘 다 옮기면 자식만 두 배로 간다.
    const { doc, outer, layer } = nested()
    expect(
      dragUnits({ layers: doc.layers, hitId: layer.id, selected: [outer.id, layer.id], solo: false }),
    ).toEqual([outer.id])
  })

  it('잠긴 것은 어느 규칙에서도 빠진다', () => {
    const { doc, layer, other } = nested()
    layer.locked = true
    expect(dragUnits({ layers: doc.layers, hitId: layer.id, selected: [], solo: false })).toEqual([])
    other.locked = true
    expect(
      dragUnits({ layers: doc.layers, hitId: layer.id, selected: [layer.id, other.id], solo: false }),
    ).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 격자
// ---------------------------------------------------------------------------

describe('격자 스냅', () => {
  it('가장 가까운 칸으로 붙는다', () => {
    expect(snapToGrid(37, 32)).toBe(32)
    expect(snapToGrid(50, 32)).toBe(64)
    expect(snapToGrid(-37, 32)).toBe(-32)
    // 칸이 없으면 그대로 둔다.
    expect(snapToGrid(37, 0)).toBe(37)
  })

  const starts = [
    { layerId: 'a', place: { x: 100, y: 100 } },
    { layerId: 'b', place: { x: 150, y: 130 } },
  ]

  it('격자가 꺼져 있으면 끈 거리가 그대로다', () => {
    const out = dragMove({ starts, dx: 13, dy: -7, grid: 0 })
    expect(out[0]!.place).toEqual({ x: 113, y: 93 })
    expect(out[1]!.place).toEqual({ x: 163, y: 123 })
  })

  it('격자가 켜지면 잡은 것만 칸에 붙는다', () => {
    // 잡은 것: 100 + 13 = 113 -> 128. 실제로 움직인 거리는 28 이다.
    const out = dragMove({ starts, dx: 13, dy: -7, grid: 32 })
    expect(out[0]!.place.x).toBe(128)
    expect(out[0]!.place.y).toBe(96)
    // 따라오는 것은 같은 거리를 간다. 붙이면 둘 사이 간격이 드래그 도중에 바뀐다.
    expect(out[1]!.place.x).toBe(150 + 28)
    expect(out[1]!.place.y).toBe(130 - 4)
  })

  it('여러 장을 함께 끌어도 간격이 유지된다', () => {
    const out = dragMove({ starts, dx: 41, dy: 41, grid: 16 })
    expect(out[1]!.place.x - out[0]!.place.x).toBe(50)
    expect(out[1]!.place.y - out[0]!.place.y).toBe(30)
  })
})

// ---------------------------------------------------------------------------
// 문서에 쓰기
// ---------------------------------------------------------------------------

describe('setLayerTranslate', () => {
  const s = () => useDocumentStore.getState()
  let doc: MotionProject
  let L = ''

  beforeEach(() => {
    doc = baseDoc()
    const layer = imageLayer(doc)
    L = layer.id
    s().replaceDocument(doc)
    s().clearHistory()
  })

  const layerNow = () => s().doc.layers.find((l) => l.id === L)!

  it('트랙이 없으면 만들고, 값은 픽셀 그대로다', () => {
    s().setLayerTranslate([{ layerId: L, x: 40, y: -12 }], 0)
    expect(getTrack(layerNow(), 'translateX')!.keys[0]!.v).toBeCloseTo(40, 9)
    expect(getTrack(layerNow(), 'translateY')!.keys[0]!.v).toBeCloseTo(-12, 9)
  })

  it('트랙의 단위를 지킨다', () => {
    // 스토어 안의 문서는 immer 가 얼려 두었다. 새 문서를 만들어 갈아 끼운다.
    const next = structuredClone(s().doc)
    next.layers.find((l) => l.id === L)!.tracks.push(
      createStaticTrack('translateX', 'percentOfCanvas', 0),
    )
    s().replaceDocument(next)

    s().setLayerTranslate([{ layerId: L, x: 51.2, y: 0 }], 0)
    const track = getTrack(layerNow(), 'translateX')!
    expect(track.unit).toBe('percentOfCanvas')
    // 51.2px 은 512 캔버스의 10% 다. 단위를 안 되돌리면 51.2 가 그대로 들어가
    // 화면에서는 다섯 배로 날아간다.
    expect(track.keys[0]!.v).toBeCloseTo(10, 9)
  })

  it('애니메이션 중이면 재생헤드에 키를 찍는다', () => {
    s().toggleAnimated(L, 'translateX', 0)
    s().setValueAtFrame(L, 'translateX', 10, 100)
    s().setLayerTranslate([{ layerId: L, x: 5, y: 0 }], 6)

    const keys = getTrack(layerNow(), 'translateX')!.keys
    expect(keys.map((k) => k.f)).toContain(6)
    expect(keys.find((k) => k.f === 6)!.v).toBeCloseTo(5, 9)
    // 다른 키는 그대로다. 첫 키만 고치면 손을 떼는 순간 원래 자리로 돌아간다.
    expect(keys.find((k) => k.f === 10)!.v).toBeCloseTo(100, 9)
  })

  it('잠긴 레이어는 움직이지 않는다', () => {
    s().setLayerFlag(L, 'locked', true)
    s().setLayerTranslate([{ layerId: L, x: 40, y: 40 }], 0)
    expect(getTrack(layerNow(), 'translateX')).toBeUndefined()
  })

  it('드래그 한 번이 실행취소 한 칸이다', () => {
    for (let i = 1; i <= 12; i += 1) s().setLayerTranslate([{ layerId: L, x: i, y: i }], 0)
    expect(s().past).toHaveLength(1)
    s().undo()
    expect(getTrack(layerNow(), 'translateX')).toBeUndefined()
  })

  it('여러 장을 함께 옮겨도 한 칸이다', () => {
    const next = structuredClone(s().doc)
    const second = createShapeLayer(createShapeSpec('circle'), '원', 1)
    next.layers.push(second)
    s().replaceDocument(next)
    s().clearHistory()

    for (let i = 1; i <= 5; i += 1) {
      s().setLayerTranslate(
        [{ layerId: L, x: i, y: 0 }, { layerId: second.id, x: i + 10, y: 0 }],
        0,
      )
    }
    expect(s().past).toHaveLength(1)
    expect(getTrack(s().doc.layers.find((l) => l.id === second.id)!, 'translateX')!.keys[0]!.v).toBe(15)
  })
})
