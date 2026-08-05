/**
 * 레이어 폴더.
 *
 * 지키는 것은 다섯 가지다.
 *   1. 폴더가 없는 문서의 그림은 한 점도 바뀌지 않는다.
 *   2. 폴더의 움직임과 안쪽 레이어의 움직임이 **함께** 보인다.
 *   3. 목록에서 폴더 식구는 폴더 바로 뒤에 붙어 있는다. 순서가 곧 그리는 순서다.
 *   4. 폴더를 지우면 안에 든 것도 함께 지워지고, 실행취소 한 칸으로 전부 돌아온다.
 *   5. 순환은 어떤 경로로도 만들어지지 않는다.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { resolveComposition } from '@/core/evaluate.ts'
import {
  createEmptyProject,
  createFolderLayer,
  createImageLayer,
  createStaticTrack,
  resetIdCounter,
} from '@/core/factory.ts'
import { buildFolderMatrices, folderChain } from '@/core/group.ts'
import { solveLayerContain } from '@/core/overscan.ts'
import { buildGroupMatrix, buildLayerMatrix, mat3Multiply } from '@/core/transform.ts'
import type { AssetRef, Layer, MotionProject } from '@/core/types.ts'
import { migrateProject } from '@/project/migrate.ts'
import { useDocumentStore } from '@/state/document.ts'
import { buildLayerRows, dropTarget } from '@/ui/layers/layerTree.ts'

const SIZE = 500
const s = () => useDocumentStore.getState()

function baseDoc(imageCount = 2): MotionProject {
  resetIdCounter()
  const doc = createEmptyProject()
  doc.canvas.w = SIZE
  doc.canvas.h = SIZE
  const ref: AssetRef = {
    id: 'a1', name: 'x', storeKey: 'k', naturalW: 100, naturalH: 100, hasAlpha: true,
  }
  doc.assets.push(ref)
  for (let i = 0; i < imageCount; i += 1) doc.layers.push(createImageLayer(ref, i))
  return doc
}

/** 유닛 사각형의 한 점을 캔버스 픽셀로 옮긴다. */
function project(m: Float32Array, u: number, v: number): [number, number] {
  const w = m[2]! * u + m[5]! * v + m[8]!
  return [
    (m[0]! * u + m[3]! * v + m[6]!) / w,
    (m[1]! * u + m[4]! * v + m[7]!) / w,
  ]
}

/** 폴더까지 얹은 레이어의 화면 위치. 렌더러가 하는 계산과 같다. */
function screenPos(doc: MotionProject, layerId: string, frame: number): [number, number] {
  const resolved = resolveComposition(doc, frame)
  const layer = resolved.find((l) => l.layerId === layerId)!
  const folders = buildFolderMatrices(resolved, doc.canvas.w, doc.canvas.h)
  const m = buildLayerMatrix(layer.transform, layer.fit, doc.canvas.w, doc.canvas.h, 100, 100)
  const group = layer.folderId ? folders.get(layer.folderId) : undefined
  if (group) mat3Multiply(group, m, m)
  return project(m, 0.5, 0.5)
}

describe('폴더 변환', () => {
  it('폴더가 없으면 옛 문서와 한 점도 다르지 않다', () => {
    const doc = baseDoc(1)
    doc.layers[0]!.tracks = [createStaticTrack('translateX', 'px', 40)]
    expect(screenPos(doc, doc.layers[0]!.id, 0)).toEqual([40, 0])
  })

  it('폴더의 이동과 안쪽의 이동이 더해진다', () => {
    const doc = baseDoc(1)
    const folder = createFolderLayer('폴더', 0)
    folder.tracks = [createStaticTrack('translateX', 'px', 100)]
    doc.layers.unshift(folder)
    doc.layers[1]!.folderId = folder.id
    doc.layers[1]!.tracks = [createStaticTrack('translateX', 'px', 30)]
    doc.layers.forEach((l, i) => { l.z = i })

    expect(screenPos(doc, doc.layers[1]!.id, 0)).toEqual([130, 0])
  })

  it('폴더의 배율은 안쪽의 위치까지 함께 줄인다', () => {
    /*
     * 이것이 폴더와 '깊이감(parentId)' 의 결정적 차이다. 깊이감은 이동만 물려받아
     * 배율을 줄여도 자식이 제자리에 남지만, 폴더는 좌표계째로 줄어든다.
     */
    const doc = baseDoc(1)
    const folder = createFolderLayer('폴더', 0)
    folder.tracks = [createStaticTrack('scale', 'ratio', 0.5)]
    doc.layers.unshift(folder)
    doc.layers[1]!.folderId = folder.id
    doc.layers[1]!.tracks = [createStaticTrack('translateX', 'px', 100)]
    doc.layers.forEach((l, i) => { l.z = i })

    expect(screenPos(doc, doc.layers[1]!.id, 0)).toEqual([50, 0])
  })

  it('폴더의 회전이 안쪽을 함께 돌린다', () => {
    const doc = baseDoc(1)
    const folder = createFolderLayer('폴더', 0)
    folder.tracks = [createStaticTrack('rotate', 'deg', 90)]
    doc.layers.unshift(folder)
    doc.layers[1]!.folderId = folder.id
    doc.layers[1]!.tracks = [createStaticTrack('translateX', 'px', 100)]
    doc.layers.forEach((l, i) => { l.z = i })

    // 오른쪽 100px 에 있던 것이 90도 돌면 아래쪽 100px 로 간다 (y 가 아래로 향한다).
    const [x, y] = screenPos(doc, doc.layers[1]!.id, 0)
    expect(x).toBeCloseTo(0, 4)
    expect(y).toBeCloseTo(100, 4)
  })

  it('폴더 두 겹이 바깥부터 차례로 얹힌다', () => {
    const doc = baseDoc(1)
    const outer = createFolderLayer('바깥', 0)
    outer.tracks = [createStaticTrack('scale', 'ratio', 2)]
    const inner = createFolderLayer('안쪽', 0)
    inner.folderId = outer.id
    inner.tracks = [createStaticTrack('translateX', 'px', 50)]
    doc.layers.unshift(inner)
    doc.layers.unshift(outer)
    doc.layers[2]!.folderId = inner.id
    doc.layers.forEach((l, i) => { l.z = i })

    // 안쪽 폴더가 50 을 밀고, 바깥 폴더가 그 좌표계를 두 배로 키운다.
    expect(screenPos(doc, doc.layers[2]!.id, 0)).toEqual([100, 0])
  })

  it('폴더의 투명도가 안쪽에 곱해진다', () => {
    const doc = baseDoc(1)
    const folder = createFolderLayer('폴더', 0)
    folder.tracks = [createStaticTrack('opacity', 'ratio', 0.5)]
    doc.layers.unshift(folder)
    doc.layers[1]!.folderId = folder.id
    doc.layers[1]!.tracks = [createStaticTrack('opacity', 'ratio', 0.5)]
    doc.layers.forEach((l, i) => { l.z = i })

    const resolved = resolveComposition(doc, 0)
    expect(resolved.find((l) => l.layerId === doc.layers[1]!.id)!.transform.opacity).toBeCloseTo(
      0.25,
      6,
    )
  })

  it('폴더를 숨기면 안쪽도 그려지지 않는다', () => {
    const doc = baseDoc(1)
    const folder = createFolderLayer('폴더', 0)
    folder.visible = false
    doc.layers.unshift(folder)
    doc.layers[1]!.folderId = folder.id
    doc.layers.forEach((l, i) => { l.z = i })

    const resolved = resolveComposition(doc, 0)
    expect(resolved.find((l) => l.layerId === doc.layers[1]!.id)!.visible).toBe(false)
  })

  it('폴더의 구간이 안쪽의 구간을 자른다', () => {
    const doc = baseDoc(1)
    const folder = createFolderLayer('폴더', 0)
    folder.inFrame = 10
    folder.outFrame = 20
    doc.layers.unshift(folder)
    doc.layers[1]!.folderId = folder.id
    doc.layers.forEach((l, i) => { l.z = i })

    const inside = resolveComposition(doc, 15).find((l) => l.layerId === doc.layers[1]!.id)!
    const outside = resolveComposition(doc, 25).find((l) => l.layerId === doc.layers[1]!.id)!
    expect(inside.visible).toBe(true)
    expect(outside.visible).toBe(false)
  })

  it('폴더는 아무것도 그리지 않는다', () => {
    const doc = baseDoc(0)
    doc.layers.push(createFolderLayer('폴더', 0))
    const resolved = resolveComposition(doc, 0)
    expect(resolved[0]!.isFolder).toBe(true)
    expect(resolved[0]!.assetId).toBeNull()
    expect(resolved[0]!.shape).toBeUndefined()
    expect(resolved[0]!.text).toBeUndefined()
  })
})

describe('담기 솔버가 폴더를 본다', () => {
  it('폴더가 크게 키우면 안쪽을 그만큼 더 줄인다', () => {
    /*
     * 솔버가 폴더를 못 보면 "이 그림은 이미 프레임 안에 있다" 고 답하고, 화면에서는
     * 폴더가 키운 만큼 잘린 그림이 나온다. 렌더러와 솔버가 같은 매트릭스를 봐야 한다.
     */
    const doc = baseDoc(1)
    const layer = doc.layers[0]!
    layer.fit = 'cover'
    layer.keepInside = true

    const alone = solveLayerContain(doc, layer, 100, 100).correction

    const folder = createFolderLayer('폴더', 0)
    folder.tracks = [createStaticTrack('scale', 'ratio', 2)]
    doc.layers.unshift(folder)
    doc.layers[1]!.folderId = folder.id
    doc.layers.forEach((l, i) => { l.z = i })

    const inside = solveLayerContain(doc, doc.layers[1]!, 100, 100).correction
    expect(inside).toBeLessThan(alone)
    // 폴더가 두 배로 키웠으니 절반으로 담아야 한다. 0.995 는 가장자리 안전 마진이다.
    expect(inside).toBeCloseTo(0.5 * 0.995, 4)
  })

  it('움직이지 않는 폴더는 아무것도 바꾸지 않는다', () => {
    const doc = baseDoc(1)
    const layer = doc.layers[0]!
    layer.fit = 'cover'
    layer.keepInside = true
    layer.tracks = [createStaticTrack('scale', 'ratio', 3)]
    const alone = solveLayerContain(doc, layer, 100, 100).correction

    const folder = createFolderLayer('폴더', 0)
    doc.layers.unshift(folder)
    doc.layers[1]!.folderId = folder.id
    doc.layers.forEach((l, i) => { l.z = i })

    expect(solveLayerContain(doc, doc.layers[1]!, 100, 100).correction).toBeCloseTo(alone, 9)
  })
})

describe('폴더 매트릭스', () => {
  it('기준점이 회전축이 된다', () => {
    const t = { ...resolveComposition(baseDoc(1), 0)[0]!.transform }
    t.rotate = 90
    t.anchorX = 0
    t.anchorY = 0

    const m = buildGroupMatrix(t, SIZE, SIZE)
    // 기준점 (0,0) 은 캔버스 왼쪽 위(-250,-250)다. 그 점은 돌아도 제자리다.
    const [x, y] = project(m, 0, 0)
    // 유닛 좌표가 아니라 캔버스 픽셀을 넣어야 하므로 직접 곱한다.
    void x
    void y
    const px = -250
    const py = -250
    const rx = m[0]! * px + m[3]! * py + m[6]!
    const ry = m[1]! * px + m[4]! * py + m[7]!
    expect(rx).toBeCloseTo(px, 3)
    expect(ry).toBeCloseTo(py, 3)
  })

  it('마지막 행이 항등이라 원근과 교환된다', () => {
    const t = { ...resolveComposition(baseDoc(1), 0)[0]!.transform }
    t.rotate = 33
    t.scaleX = 2
    t.translateX = 90
    const m = buildGroupMatrix(t, SIZE, SIZE)
    expect([m[2], m[5], m[8]]).toEqual([0, 0, 1])
  })
})

describe('폴더 스토어', () => {
  beforeEach(() => {
    s().replaceDocument(baseDoc(3))
  })

  it('고른 레이어를 폴더로 묶는다', () => {
    const ids = s().doc.layers.slice(0, 2).map((l) => l.id)
    const { folderId } = s().addFolder({ name: '묶음', layerIds: ids })

    const doc = s().doc
    expect(doc.layers.find((l) => l.id === folderId)!.type).toBe('group')
    for (const id of ids) {
      expect(doc.layers.find((l) => l.id === id)!.folderId).toBe(folderId)
    }
  })

  it('폴더 식구가 폴더 바로 뒤에 붙는다', () => {
    const ids = s().doc.layers.slice(0, 2).map((l) => l.id)
    const { folderId } = s().addFolder({ layerIds: ids })

    const order = s().doc.layers.map((l) => l.id)
    const at = order.indexOf(folderId)
    expect(order.slice(at + 1, at + 3).sort()).toEqual([...ids].sort())
    // z 는 배열 순서와 언제나 같다. 렌더러가 이 값으로만 정렬한다.
    expect(s().doc.layers.map((l) => l.z)).toEqual([0, 1, 2, 3])
  })

  it('폴더를 지우면 안에 든 것도 함께 지워진다', () => {
    /*
     * 목록에서 한 줄로 보이는 것이 화면에서도 한 덩어리다. 그 한 줄을 지웠는데
     * 식구가 최상위로 흩어져 나오면 지운 것보다 늘어난 것처럼 보인다.
     * 접힌 폴더에서는 그 식구가 목록에 보이지도 않는다.
     */
    const all = s().doc.layers.map((l) => l.id)
    const { folderId } = s().addFolder({ layerIds: all.slice(0, 2) })
    s().removeLayer(folderId)

    // 폴더에 담지 않은 한 장만 남는다.
    expect(s().doc.layers.map((l) => l.id)).toEqual([all[2]])
  })

  it('몇 겹으로 중첩돼 있어도 따라 들어간다', () => {
    const ids = s().doc.layers.map((l) => l.id)
    const inner = s().addFolder({ layerIds: ids }).folderId
    const outer = s().addFolder({ layerIds: [inner] }).folderId

    s().removeLayer(outer)
    expect(s().doc.layers).toHaveLength(0)
  })

  it('폴더 밖의 레이어는 남는다', () => {
    const all = s().doc.layers.map((l) => l.id)
    const { folderId } = s().addFolder({ layerIds: [all[0]!] })

    s().removeLayer(folderId)
    expect(s().doc.layers.map((l) => l.id).sort()).toEqual([all[1]!, all[2]!].sort())
  })

  it('안에 든 그림의 에셋도 함께 걷힌다', () => {
    const ids = s().doc.layers.map((l) => l.id)
    const { folderId } = s().addFolder({ layerIds: ids })
    expect(s().doc.assets).toHaveLength(1)

    s().removeLayer(folderId)
    // 아무 레이어도 안 쓰는 에셋이 남으면 저장 파일에 쓰지 않는 픽셀이 딸려 간다.
    expect(s().doc.assets).toHaveLength(0)
  })

  it('폴더 삭제가 실행취소 한 칸이고 전부 돌아온다', () => {
    // 되돌릴 수 있다는 것이 "함께 지운다" 를 안전하게 만드는 근거다.
    const ids = s().doc.layers.map((l) => l.id)
    const { folderId } = s().addFolder({ layerIds: ids })
    const before = s().past.length

    s().removeLayer(folderId)
    expect(s().past.length).toBe(before + 1)

    s().undo()
    expect(s().doc.layers.map((l) => l.id).sort()).toEqual([folderId, ...ids].sort())
    expect(s().doc.assets).toHaveLength(1)
    for (const id of ids) {
      expect(s().doc.layers.find((l) => l.id === id)!.folderId).toBe(folderId)
    }
  })

  it('여러 장을 골라 지울 때도 폴더는 안까지 지운다', () => {
    const all = s().doc.layers.map((l) => l.id)
    const { folderId } = s().addFolder({ layerIds: [all[0]!] })

    s().removeLayers([folderId, all[1]!])
    expect(s().doc.layers.map((l) => l.id)).toEqual([all[2]])
  })

  it('자기 자손 안으로는 못 들어간다', () => {
    const inner = s().addFolder({ name: '안쪽' }).folderId
    const outer = s().addFolder({ name: '바깥', layerIds: [inner] }).folderId
    // 바깥을 안쪽에 넣으려는 시도. 성공하면 아무도 안 그려진다.
    s().setLayerFolder([outer], inner)
    expect(s().doc.layers.find((l) => l.id === outer)!.folderId).toBeUndefined()
  })

  it('폴더 만들기가 실행취소 한 칸이다', () => {
    const before = s().past.length
    const ids = s().doc.layers.map((l) => l.id)
    s().addFolder({ layerIds: ids })
    expect(s().past.length).toBe(before + 1)

    s().undo()
    expect(s().doc.layers).toHaveLength(3)
    expect(s().doc.layers.every((l) => l.folderId === undefined)).toBe(true)
  })

  it('폴더 안으로 끌어다 놓으면 그 폴더 소속이 된다', () => {
    const first = s().doc.layers[0]!.id
    const { folderId } = s().addFolder({ name: '묶음', layerIds: [first] })

    const outsider = s().doc.layers.find((l) => l.id !== first && l.type !== 'group')!.id
    const folderIndex = s().doc.layers.findIndex((l) => l.id === folderId)
    // 폴더 바로 뒤에 놓는다.
    s().moveLayerTo(outsider, folderIndex + 1)

    expect(s().doc.layers.find((l) => l.id === outsider)!.folderId).toBe(folderId)
  })

  it('폴더 밖으로 끌어내면 소속이 풀린다', () => {
    const ids = s().doc.layers.slice(0, 2).map((l) => l.id)
    s().addFolder({ name: '묶음', layerIds: ids })
    // 맨 아래(배열 0번)로 끌어내면 어떤 폴더보다도 뒤에 온다.
    s().moveLayerTo(ids[0]!, 0)
    expect(s().doc.layers.find((l) => l.id === ids[0])!.folderId).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 목록 트리
// ---------------------------------------------------------------------------

/**
 * 여기서 지키는 것은 두 가지다.
 *
 *   1. 폴더 머리행이 식구들 **위**에 온다. 문서 배열은 폴더가 식구보다 앞(더 뒤쪽 z)
 *      이라 그냥 뒤집으면 머리행이 아래로 내려간다. 포토샵을 쓴 사람은 예외 없이
 *      반대를 기대하고, 실제로 그래서 "폴더가 고장 났다" 로 읽혔다.
 *   2. 접으면 식구가 목록에서 사라지고, 그 상태에서 끌어다 놓아도 자리가 맞는다.
 *      도형 세트 하나가 스무 장까지 만드는데 접을 수 없으면 폴더가 쓸모없다.
 */
describe('레이어 목록 트리', () => {
  beforeEach(() => {
    s().replaceDocument(baseDoc(3))
  })

  /** 지금 문서의 행을 이름 대신 id 로 뽑는다. */
  const rowsOf = (collapsed: string[] = []): ReturnType<typeof buildLayerRows> =>
    buildLayerRows(s().doc.layers, new Set(collapsed))

  it('폴더 머리행이 식구들 위에 온다', () => {
    const ids = s().doc.layers.slice(0, 2).map((l) => l.id)
    const { folderId } = s().addFolder({ name: '묶음', layerIds: ids })

    const rows = rowsOf()
    const at = rows.findIndex((r) => r.layer.id === folderId)
    expect(at).toBeGreaterThanOrEqual(0)
    // 바로 다음 두 줄이 식구다. 위가 앞이므로 z 가 큰 쪽이 먼저 온다.
    expect(rows[at + 1]!.layer.id).toBe(ids[1])
    expect(rows[at + 2]!.layer.id).toBe(ids[0])
    expect(rows[at]!.depth).toBe(0)
    expect(rows[at + 1]!.depth).toBe(1)
    expect(rows[at]!.childCount).toBe(2)
  })

  it('접으면 식구가 목록에서 사라진다', () => {
    const ids = s().doc.layers.slice(0, 2).map((l) => l.id)
    const { folderId } = s().addFolder({ name: '묶음', layerIds: ids })

    const rows = rowsOf([folderId])
    expect(rows.map((r) => r.layer.id)).not.toContain(ids[0])
    expect(rows.map((r) => r.layer.id)).not.toContain(ids[1])
    // 머리행은 남고, 몇 장을 품고 있는지 셀 수 있어야 한다.
    const folderRow = rows.find((r) => r.layer.id === folderId)!
    expect(folderRow.collapsed).toBe(true)
    expect(folderRow.childCount).toBe(2)
  })

  it('펼친 폴더 머리행 바로 아래에 놓으면 그 폴더로 들어간다', () => {
    const first = s().doc.layers[0]!.id
    const { folderId } = s().addFolder({ name: '묶음', layerIds: [first] })
    const outsider = s().doc.layers.find((l) => l.id !== first && l.type !== 'group')!.id

    const rows = rowsOf()
    const at = rows.findIndex((r) => r.layer.id === folderId)
    const target = dropTarget(s().doc.layers, rows, outsider, at + 1)!
    expect(target.folderId).toBe(folderId)

    s().moveLayerTo(outsider, target.index, target.folderId)
    expect(s().doc.layers.find((l) => l.id === outsider)!.folderId).toBe(folderId)
  })

  it('접힌 폴더 위에 놓으면 폴더 안으로 빨려 들어가지 않는다', () => {
    /*
     * 이것이 접기가 없던 시절의 사고다. 놓은 자리의 아래 이웃만 보고 소속을 추측하면,
     * 접혀서 보이지도 않는 식구를 이웃으로 잡아 엉뚱한 폴더로 들어간다.
     */
    const inside = s().doc.layers.slice(0, 2).map((l) => l.id)
    const { folderId } = s().addFolder({ name: '묶음', layerIds: inside })
    const outsider = s().doc.layers.find((l) => !inside.includes(l.id) && l.type !== 'group')!.id

    const rows = rowsOf([folderId])
    const at = rows.findIndex((r) => r.layer.id === folderId)
    // 접힌 폴더 바로 아래 경계 = 폴더 통째로의 뒤. 최상위여야 한다.
    const target = dropTarget(s().doc.layers, rows, outsider, at + 1)!
    expect(target.folderId).toBeNull()

    s().moveLayerTo(outsider, target.index, target.folderId)
    expect(s().doc.layers.find((l) => l.id === outsider)!.folderId).toBeUndefined()
  })

  it('폴더를 자기 자손 안으로는 못 놓는다', () => {
    const inner = s().addFolder({ name: '안쪽' }).folderId
    const outer = s().addFolder({ name: '바깥', layerIds: [inner] }).folderId

    const rows = rowsOf()
    const at = rows.findIndex((r) => r.layer.id === inner)
    // 안쪽 폴더 머리행 바로 아래 = 안쪽 폴더 안. 바깥은 거기 못 들어간다.
    expect(dropTarget(s().doc.layers, rows, outer, at + 1)).toBeNull()
  })

  it('맨 위에 놓으면 최상위로 나온다', () => {
    const ids = s().doc.layers.slice(0, 2).map((l) => l.id)
    s().addFolder({ name: '묶음', layerIds: ids })

    const rows = rowsOf()
    const target = dropTarget(s().doc.layers, rows, ids[0]!, 0)!
    expect(target.folderId).toBeNull()

    s().moveLayerTo(ids[0]!, target.index, target.folderId)
    const doc = s().doc
    expect(doc.layers.find((l) => l.id === ids[0])!.folderId).toBeUndefined()
    // 맨 위 = z 가 가장 크다.
    expect(doc.layers[doc.layers.length - 1]!.id).toBe(ids[0])
  })

  it('접혀 있어도 모든 레이어가 정확히 한 번씩 나온다', () => {
    // 목록 계산이 레이어를 삼키거나 두 번 내면 그 자체가 데이터 손실로 보인다.
    const ids = s().doc.layers.slice(0, 2).map((l) => l.id)
    const { folderId } = s().addFolder({ name: '묶음', layerIds: ids })
    const all = s().doc.layers.map((l) => l.id)

    const open = rowsOf().map((r) => r.layer.id)
    expect([...open].sort()).toEqual([...all].sort())

    const shut = rowsOf([folderId]).map((r) => r.layer.id)
    expect(new Set(shut).size).toBe(shut.length)
    for (const id of shut) expect(all).toContain(id)
  })
})

describe('폴더 저장 왕복', () => {
  it('한 글자도 달라지지 않는다', () => {
    const before = baseDoc(2)
    const folder = createFolderLayer('폴더', 2)
    before.layers.push(folder)
    before.layers[0]!.folderId = folder.id

    const { doc, warnings } = migrateProject(JSON.parse(JSON.stringify(before)) as unknown)
    expect(warnings).toEqual([])
    expect(JSON.stringify(doc)).toBe(JSON.stringify(before))
  })

  it('없는 폴더를 가리키면 꺼낸다', () => {
    const before = baseDoc(1) as unknown as Record<string, unknown>
    ;(before['layers'] as Record<string, unknown>[])[0]!['folderId'] = '없는id'
    const { doc, warnings } = migrateProject(JSON.parse(JSON.stringify(before)) as unknown)
    expect(doc.layers[0]).not.toHaveProperty('folderId')
    expect(warnings.length).toBeGreaterThan(0)
  })

  it('폴더가 아닌 레이어를 가리키면 꺼낸다', () => {
    const before = baseDoc(2)
    before.layers[0]!.folderId = before.layers[1]!.id
    const { doc } = migrateProject(JSON.parse(JSON.stringify(before)) as unknown)
    expect(doc.layers[0]).not.toHaveProperty('folderId')
  })

  it('순환이면 고리를 끊는다', () => {
    /*
     * 전부 최상위로 만들 필요는 없다. **고리가 남지 않으면** 된다. 한쪽 연결만 끊으면
     * 나머지는 그대로 뜻이 통하는 담김 관계라서, 사용자가 만든 구조를 덜 부순다.
     */
    const before = baseDoc(0)
    const a = createFolderLayer('a', 0)
    const b = createFolderLayer('b', 1)
    a.folderId = b.id
    b.folderId = a.id
    before.layers.push(a, b)

    const { doc } = migrateProject(JSON.parse(JSON.stringify(before)) as unknown)
    for (const layer of doc.layers as Layer[]) {
      // 자기 사슬에 자기가 다시 나오면 순환이다.
      expect(folderChain(doc.layers, layer).some((f) => f.id === layer.id)).toBe(false)
    }
    // 사슬 길이가 상한 안에서 반드시 끝난다.
    expect(folderChain(doc.layers, doc.layers[1]!).length).toBeLessThanOrEqual(1)
  })
})

describe('폴더 사슬', () => {
  it('깊이 상한에서 멈춘다', () => {
    const doc = baseDoc(0)
    const folders: Layer[] = []
    for (let i = 0; i < 30; i += 1) {
      const f = createFolderLayer(`f${i}`, i)
      if (i > 0) f.folderId = folders[i - 1]!.id
      folders.push(f)
      doc.layers.push(f)
    }
    // 30 겹이어도 사슬은 상한에서 끊긴다. 무한 루프가 되면 렌더러가 멈춘다.
    expect(folderChain(doc.layers, folders[29]!).length).toBeLessThanOrEqual(8)
  })
})
