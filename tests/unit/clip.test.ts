/**
 * 레이어 클리핑.
 *
 * 지키는 것은 네 가지다.
 *   1. 자르기가 없는 문서는 한 점도 바뀌지 않는다.
 *   2. 밑판은 **같은 폴더 안에서** 찾는다. 폴더 경계를 넘지 않는다.
 *   3. 연달아 켜져 있으면 전부 같은 밑판을 쓴다. 위에서부터 물려받지 않는다.
 *   4. 저장 -> 열기 왕복에서 한 글자도 달라지지 않는다.
 */

import { describe, expect, it } from 'vitest'

import { clipBaseIndexes, clipGroups } from '@/core/clip.ts'
import { resolveComposition } from '@/core/evaluate.ts'
import { createEmptyProject, createImageLayer, resetIdCounter } from '@/core/factory.ts'
import type { AssetRef, MotionProject } from '@/core/types.ts'
import { migrateProject } from '@/project/migrate.ts'
import { useDocumentStore } from '@/state/document.ts'

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

/**
 * 검사용 레이어 한 장. id 는 자리 번호로 자동으로 매긴다.
 * 폴더면 isFolder 를 켜고, 그 안에 드는 레이어는 folderId 로 그 id 를 가리킨다.
 */
let seq = 0
const L = (
  clipToBelow?: boolean,
  folderId?: string,
  visible = true,
  isFolder = false,
) => ({
  layerId: `l${(seq += 1)}`,
  ...(clipToBelow === undefined ? {} : { clipToBelow }),
  ...(folderId === undefined ? {} : { folderId }),
  ...(isFolder ? { isFolder: true } : {}),
  visible,
})

/** 폴더 한 장. 뒤에 오는 식구가 이 id 를 folderId 로 쓴다. */
const F = (id: string, clipToBelow?: boolean, folderId?: string) => ({
  layerId: id,
  isFolder: true,
  ...(clipToBelow === undefined ? {} : { clipToBelow }),
  ...(folderId === undefined ? {} : { folderId }),
  visible: true,
})

describe('밑판 찾기', () => {
  it('자르지 않으면 밑판이 없다', () => {
    expect(clipBaseIndexes([L(), L(), L()])).toEqual([-1, -1, -1])
  })

  it('바로 아래를 밑판으로 쓴다', () => {
    expect(clipBaseIndexes([L(), L(true)])).toEqual([-1, 0])
  })

  it('맨 아래에서 켜면 밑판이 없다', () => {
    // 아래에 아무것도 없으면 자를 기준이 없다. 그냥 그려지는 편이 낫다.
    expect(clipBaseIndexes([L(true), L()])).toEqual([-1, -1])
  })

  it('연달아 켜면 전부 같은 밑판을 쓴다', () => {
    // 위에서부터 물려받는 것이 아니다. 포토샵의 클리핑 마스크와 같은 규칙이다.
    expect(clipBaseIndexes([L(), L(true), L(true), L(true)])).toEqual([-1, 0, 0, 0])
  })

  it('폴더 경계를 넘지 않는다', () => {
    // 1번은 폴더 f 안이고 0번은 밖이다. 폴더를 접었다 펴는 것만으로 그림이
    // 달라지면 안 되므로 여기서 멈춘다.
    expect(clipBaseIndexes([L(), L(true, 'f')])).toEqual([-1, -1])
  })

  it('같은 폴더 안에서는 찾는다', () => {
    expect(clipBaseIndexes([L(undefined, 'f'), L(true, 'f')])).toEqual([-1, 1 - 1])
  })

  it('덩어리는 밑판마다 하나다', () => {
    const groups = clipGroups([L(), L(true), L(true), L(), L(true)])
    expect(groups).toEqual([
      { base: 0, baseEnd: 0, members: [1, 2], end: 2 },
      { base: 3, baseEnd: 3, members: [4], end: 4 },
    ])
  })

  it('보이지 않는 레이어는 덩어리를 만들지 않는다', () => {
    expect(clipGroups([L(), L(true, undefined, false)])).toEqual([])
  })

  it('자르기가 없으면 덩어리도 없다', () => {
    expect(clipGroups([L(), L(), L()])).toEqual([])
  })
})

describe('평가 결과', () => {
  it('자르기 값이 렌더러까지 실려 나간다', () => {
    const doc = docWithLayers(2)
    doc.layers[1]!.clipToBelow = true
    const resolved = resolveComposition(doc, 0)
    expect(resolved[0]!.clipToBelow).toBeUndefined()
    expect(resolved[1]!.clipToBelow).toBe(true)
  })

  it('자르기가 없으면 키 자체가 없다', () => {
    const resolved = resolveComposition(docWithLayers(2), 0)
    expect(resolved.every((l) => !('clipToBelow' in l))).toBe(true)
  })
})

describe('자르기 스토어', () => {
  it('켜고 끄면 필드가 생겼다 사라진다', () => {
    s().replaceDocument(docWithLayers(2))
    const id = s().doc.layers[1]!.id

    s().setLayerClip([id], true)
    expect(s().doc.layers[1]!.clipToBelow).toBe(true)

    s().setLayerClip([id], false)
    expect(s().doc.layers[1]).not.toHaveProperty('clipToBelow')
  })

  it('폴더에도 켜진다', () => {
    // 폴더가 잘리는 쪽이면 폴더 안의 그림 전체가 한 장처럼 잘린다.
    s().replaceDocument(docWithLayers(1))
    const { folderId } = s().addFolder({ name: '폴더' })
    s().setLayerClip([folderId], true)
    expect(s().doc.layers.find((l) => l.id === folderId)!.clipToBelow).toBe(true)
  })
})

describe('폴더와 자르기', () => {
  it('앞 형제가 폴더면 그 폴더가 밑판이다', () => {
    /*
     * 배열에서 바로 앞은 폴더의 **식구**다. 그것을 밑판으로 삼으면 도형 한 장만
     * 마스크가 되어, 여러 장으로 만든 모양의 일부만 남는다. 형제까지 내려가야 한다.
     */
    const bases = clipBaseIndexes([
      F('f1'),
      L(undefined, 'f1'),
      L(undefined, 'f1'),
      L(true),
    ])
    expect(bases).toEqual([-1, -1, -1, 0])
  })

  it('폴더가 잘리는 쪽이면 덩어리가 폴더 끝까지다', () => {
    const groups = clipGroups([L(), F('f1', true), L(undefined, 'f1'), L(undefined, 'f1')])
    expect(groups).toEqual([{ base: 0, baseEnd: 0, members: [1], end: 3 }])
  })

  it('밑판이 폴더면 그 안쪽 끝을 함께 알려 준다', () => {
    const groups = clipGroups([F('f1'), L(undefined, 'f1'), L(undefined, 'f1'), L(true)])
    expect(groups).toEqual([{ base: 0, baseEnd: 2, members: [3], end: 3 }])
  })

  it('폴더 안의 첫 자리에서 켜면 밑판이 없다', () => {
    // 밖으로 새어 나가면 폴더를 접었다 펴는 것만으로 그림이 달라진다.
    expect(clipBaseIndexes([L(), F('f1'), L(true, 'f1')])).toEqual([-1, -1, -1])
  })

  it('폴더 안에서도 형제끼리 자른다', () => {
    expect(clipBaseIndexes([F('f1'), L(undefined, 'f1'), L(true, 'f1')])).toEqual([-1, -1, 1])
  })
})

describe('자르기 저장 왕복', () => {
  it('한 글자도 달라지지 않는다', () => {
    const before = docWithLayers(2)
    before.layers[1]!.clipToBelow = true

    const { doc, warnings } = migrateProject(JSON.parse(JSON.stringify(before)) as unknown)
    expect(warnings).toEqual([])
    expect(JSON.stringify(doc)).toBe(JSON.stringify(before))
  })

  it('거짓은 지운다', () => {
    const before = docWithLayers(1) as unknown as Record<string, unknown>
    ;(before['layers'] as Record<string, unknown>[])[0]!['clipToBelow'] = false
    const { doc } = migrateProject(JSON.parse(JSON.stringify(before)) as unknown)
    expect(doc.layers[0]).not.toHaveProperty('clipToBelow')
  })

  it('망가진 값도 지운다', () => {
    const before = docWithLayers(1) as unknown as Record<string, unknown>
    ;(before['layers'] as Record<string, unknown>[])[0]!['clipToBelow'] = 'yes'
    const { doc } = migrateProject(JSON.parse(JSON.stringify(before)) as unknown)
    expect(doc.layers[0]).not.toHaveProperty('clipToBelow')
  })
})
