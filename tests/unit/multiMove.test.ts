/**
 * 여러 장 한꺼번에 옮기기와 폴더 잠금 전파.
 *
 * 지키는 것은 다섯 가지다.
 *   1. 옮긴 뒤에도 고른 것들끼리의 앞뒤가 문서 순서 그대로다.
 *   2. 폴더와 그 식구를 함께 골라도 두 번 옮겨지지 않는다.
 *   3. 한 번의 이동이 실행취소 한 칸이다.
 *   4. 제자리에 놓으면 실행취소 칸이 생기지 않는다.
 *   5. 폴더를 잠그면 안의 모든 레이어가 잠기고, 풀면 함께 풀린다.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import {
  createEmptyProject,
  createFolderLayer,
  createImageLayer,
  resetIdCounter,
} from '@/core/factory.ts'
import type { AssetRef, MotionProject } from '@/core/types.ts'
import { useDocumentStore } from '@/state/document.ts'
import { buildLayerRows, dropTargetMulti } from '@/ui/layers/layerTree.ts'

const s = () => useDocumentStore.getState()

function baseDoc(imageCount = 4): MotionProject {
  resetIdCounter()
  const doc = createEmptyProject()
  doc.canvas.w = 500
  doc.canvas.h = 500
  const ref: AssetRef = {
    id: 'a1', name: 'x', storeKey: 'k', naturalW: 100, naturalH: 100, hasAlpha: true,
  }
  doc.assets.push(ref)
  for (let i = 0; i < imageCount; i += 1) {
    const layer = createImageLayer(ref, i)
    layer.name = `그림${i}`
    doc.layers.push(layer)
  }
  return doc
}

const names = () => s().doc.layers.map((l) => l.name)

beforeEach(() => {
  resetIdCounter()
})

describe('moveLayersTo', () => {
  beforeEach(() => {
    s().replaceDocument(baseDoc(4))
  })

  it('고른 것들이 한 덩어리로, 서로의 순서를 지키며 옮겨진다', () => {
    // 문서 순서: 그림0 그림1 그림2 그림3. 0 과 2 를 맨 뒤(배열 끝)로.
    const ids = s().doc.layers.map((l) => l.id)
    s().moveLayersTo([ids[2]!, ids[0]!], 2, null)
    expect(names()).toEqual(['그림1', '그림3', '그림0', '그림2'])
  })

  it('클릭 순서와 무관하게 문서 순서를 따른다', () => {
    const ids = s().doc.layers.map((l) => l.id)
    s().moveLayersTo([ids[0]!, ids[3]!, ids[1]!], 1, null)
    expect(names()).toEqual(['그림2', '그림0', '그림1', '그림3'])
  })

  it('한 번의 이동이 실행취소 한 칸이다', () => {
    const ids = s().doc.layers.map((l) => l.id)
    const depth = s().past.length
    s().moveLayersTo([ids[0]!, ids[1]!], 2, null)
    expect(s().past.length).toBe(depth + 1)
    s().undo()
    expect(names()).toEqual(['그림0', '그림1', '그림2', '그림3'])
  })

  it('제자리에 놓으면 실행취소 칸이 생기지 않는다', () => {
    const ids = s().doc.layers.map((l) => l.id)
    const depth = s().past.length
    s().moveLayersTo([ids[1]!, ids[2]!], 1)
    expect(s().past.length).toBe(depth)
  })

  it('폴더와 식구를 함께 골라도 폴더만 옮겨 두 번 옮기지 않는다', () => {
    const doc = baseDoc(2)
    const folder = createFolderLayer('폴더', 2)
    doc.layers.push(folder)
    doc.layers[0]!.folderId = folder.id
    s().replaceDocument(doc)

    const ids = s().doc.layers.map((l) => l.id)
    const folderId = ids[2]!
    const childId = ids[0]!
    // 폴더(와 그 안의 그림0)를 최상위 맨 앞으로.
    s().moveLayersTo([folderId, childId], 0, null)

    const after = s().doc.layers
    // normalizeFolderOrder 계약: 식구는 폴더 바로 뒤에 붙는다.
    const fi = after.findIndex((l) => l.id === folderId)
    expect(after[fi + 1]!.id).toBe(childId)
    expect(after[fi + 1]!.folderId).toBe(folderId)
  })

  it('잠긴 폴더에 넣으면 그 자리에서 잠긴다', () => {
    // 잠금 전파는 토글 순간에만 flag 를 쓴다. 나중에 들어온 레이어가
    // 전파를 못 받으면 잠근 폴더 안에서 그 장만 편집되는 구멍이 생긴다.
    const doc = baseDoc(1)
    const folder = createFolderLayer('폴더', 1)
    folder.locked = true
    doc.layers.push(folder)
    s().replaceDocument(doc)

    const ids = s().doc.layers.map((l) => l.id)
    s().moveLayersTo([ids[0]!], 2, ids[1]!)
    expect(s().doc.layers.find((l) => l.id === ids[0])!.locked).toBe(true)
  })

  it('folderId 를 지정하면 전부 그 폴더로 들어간다', () => {
    const doc = baseDoc(2)
    const folder = createFolderLayer('폴더', 2)
    doc.layers.push(folder)
    s().replaceDocument(doc)

    const ids = s().doc.layers.map((l) => l.id)
    s().moveLayersTo([ids[0]!, ids[1]!], 3, ids[2]!)
    const after = s().doc.layers
    expect(after.filter((l) => l.folderId === ids[2]).length).toBe(2)
  })
})

describe('dropTargetMulti', () => {
  it('옮겨 갈 행은 기준이 되지 않는다', () => {
    const doc = baseDoc(3)
    s().replaceDocument(doc)
    const layers = s().doc.layers
    const rows = buildLayerRows(layers, new Set())
    // 표시 순서(위가 앞): 그림2 그림1 그림0. 그림2 와 그림1 을 맨 아래로.
    const target = dropTargetMulti(layers, rows, [layers[2]!.id, layers[1]!.id], 3)
    expect(target).not.toBeNull()
    // 그림0 만 남은 배열에서 그 앞(z 아래)에 꽂힌다.
    expect(target!.index).toBe(0)
    expect(target!.folderId).toBeNull()
  })

  it('띄엄띄엄 고른 선택을 맨 위 블록 바로 아래에 놓아도 무시되지 않는다', () => {
    // 위쪽이 전부 옮기는 것뿐이라도, 아래쪽에 고른 장이 남아 있으면
    // 그 장들이 끌려 올라와야 한다. 한 장짜리 블록만 제자리 드롭으로 본다.
    const doc = baseDoc(5)
    s().replaceDocument(doc)
    const layers = s().doc.layers
    const rows = buildLayerRows(layers, new Set())
    // 표시 순서: 그림4 그림3 그림2 그림1 그림0. 그림4 와 그림2 를 그림4 바로 아래 경계에.
    const target = dropTargetMulti(layers, rows, [layers[4]!.id, layers[2]!.id], 1)
    expect(target).not.toBeNull()
    s().moveLayersTo([layers[4]!.id, layers[2]!.id], target!.index, target!.folderId)
    expect(names()).toEqual(['그림0', '그림1', '그림3', '그림2', '그림4'])
  })

  it('폴더를 자기 자손 안으로 넣으려 하면 거절한다', () => {
    const doc = baseDoc(1)
    const folder = createFolderLayer('폴더', 1)
    doc.layers.push(folder)
    doc.layers[0]!.folderId = folder.id
    s().replaceDocument(doc)
    const layers = s().doc.layers
    const rows = buildLayerRows(layers, new Set())
    // 표시 순서: 폴더, 그림0(식구). 경계 2 = 식구 바로 아래 = 폴더 안.
    const target = dropTargetMulti(layers, rows, [folder.id], 2)
    expect(target).toBeNull()
  })
})

describe('폴더 잠금 전파', () => {
  it('폴더를 잠그면 안의 모든 레이어가 잠기고, 풀면 함께 풀린다', () => {
    const doc = baseDoc(2)
    const outer = createFolderLayer('바깥', 2)
    const inner = createFolderLayer('안쪽', 3)
    doc.layers.push(outer, inner)
    inner.folderId = outer.id
    doc.layers[0]!.folderId = outer.id
    doc.layers[1]!.folderId = inner.id
    s().replaceDocument(doc)

    const outerId = outer.id
    s().setLayerFlag(outerId, 'locked', true)
    expect(s().doc.layers.every((l) => l.locked)).toBe(true)

    s().setLayerFlag(outerId, 'locked', false)
    expect(s().doc.layers.every((l) => !l.locked)).toBe(true)
  })

  it('잠금 전파도 실행취소 한 칸이다', () => {
    const doc = baseDoc(2)
    const folder = createFolderLayer('폴더', 2)
    doc.layers.push(folder)
    doc.layers[0]!.folderId = folder.id
    s().replaceDocument(doc)

    const depth = s().past.length
    s().setLayerFlag(folder.id, 'locked', true)
    expect(s().past.length).toBe(depth + 1)
    s().undo()
    expect(s().doc.layers.every((l) => !l.locked)).toBe(true)
  })

  it('폴더가 아닌 레이어의 잠금은 자기 한 장만 바꾼다', () => {
    s().replaceDocument(baseDoc(2))
    const ids = s().doc.layers.map((l) => l.id)
    s().setLayerFlag(ids[0]!, 'locked', true)
    expect(s().doc.layers[0]!.locked).toBe(true)
    expect(s().doc.layers[1]!.locked).toBe(false)
  })
})
