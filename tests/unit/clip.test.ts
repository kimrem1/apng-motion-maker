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

import { clipBaseIndexes, clipGroups, subtreeEnds, type ClipInput } from '@/core/clip.ts'
import { renderStepsForRange, type PlanLayer } from '@/core/renderer/renderPlan.ts'
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

describe('렌더 절차', () => {
  /** 렌더러(renderer/index.ts)가 최상위 루프와 renderRange 에서 부르는 그대로다. */
  const steps = (layers: (ClipInput & PlanLayer)[], from = 0, to = layers.length - 1) => {
    const groups = clipGroups(layers)
    return renderStepsForRange(
      layers,
      new Map(groups.map((g) => [g.base, g])),
      subtreeEnds(layers),
      from,
      to,
    )
  }

  it('자르기가 없으면 레이어 단계뿐이다', () => {
    expect(steps([L(), L(), L()])).toEqual([
      { kind: 'layer', index: 0 },
      { kind: 'layer', index: 1 },
      { kind: 'layer', index: 2 },
    ])
  })

  it('덩어리 멤버와 그 폴더 식구는 밑판 차례에 끝난다', () => {
    // [X, F(자르기), F식구, F식구] — F 서브트리 전체가 덩어리 단계 하나에 들어간다.
    const got = steps([L(), F('f1', true), L(undefined, 'f1'), L(undefined, 'f1')])
    expect(got).toHaveLength(1)
    expect(got[0]!.kind).toBe('clipGroup')
  })

  it('자르기에 참여한 폴더 안의 중첩 자르기가 서브트리 절차에 나타난다', () => {
    /*
     * 버그였던 재현: 최상위 도형 X, 그 위 폴더 F(자르기 켬), F 안에 도형 A 와
     * A 를 밑판으로 자르는 이미지 B. 예전 서브트리 순회(renderRange)는 평면
     * 노멀 합성만 해서 B 가 A 모양으로 잘리지 않았다. 절차가 한 곳에 있으면
     * 서브트리에서도 안쪽 덩어리가 반드시 나온다.
     */
    const layers = [L(), F('f1', true), L(undefined, 'f1'), L(true, 'f1')]
    // 최상위: 바깥 덩어리 하나뿐이다.
    const top = steps(layers)
    expect(top).toHaveLength(1)
    expect(top[0]).toMatchObject({ kind: 'clipGroup', group: { base: 0, members: [1] } })
    // 폴더 서브트리(F 식구 범위): 안쪽 덩어리가 절차로 나온다.
    const sub = steps(layers, 2, 3)
    expect(sub).toHaveLength(1)
    expect(sub[0]).toMatchObject({ kind: 'clipGroup', group: { base: 2, members: [3] } })
  })

  it('밑판 폴더 안의 중첩 자르기도 나타난다', () => {
    // [F1, A, B(A를 자름), C(F1을 자름)] — 밑판이 폴더인 경우다.
    const layers = [F('f1'), L(undefined, 'f1'), L(true, 'f1'), L(true)]
    const top = steps(layers)
    expect(top).toHaveLength(1)
    expect(top[0]).toMatchObject({ kind: 'clipGroup', group: { base: 0, baseEnd: 2 } })
    const inner = steps(layers, 1, 2)
    expect(inner).toHaveLength(1)
    expect(inner[0]).toMatchObject({ kind: 'clipGroup', group: { base: 1, members: [2] } })
  })

  it('혼합 모드가 걸린 폴더는 서브트리를 한 장에 담는 단계가 된다', () => {
    const layers = [L(), { ...F('f1'), blend: 'multiply' }, L(undefined, 'f1'), L(undefined, 'f1')]
    expect(steps(layers)).toEqual([
      { kind: 'layer', index: 0 },
      { kind: 'folderBlend', index: 1, end: 3 },
    ])
  })

  it('노멀 폴더는 단계를 만들지 않고 식구가 각자 그려진다', () => {
    expect(steps([F('f1'), L(undefined, 'f1'), L(undefined, 'f1')])).toEqual([
      { kind: 'layer', index: 1 },
      { kind: 'layer', index: 2 },
    ])
  })

  it('밑판이 안 보여도 덩어리는 만들어진다', () => {
    /*
     * 밑판만 건너뛰면 멤버가 안 잘린 채 그대로 그려진다. 덩어리를 만들어
     * 빈 마스크에 깎이는 편이 맞다. 안 보이는 밑판에 잘리면 아무것도 안 보인다.
     */
    const got = steps([L(undefined, undefined, false), L(true)])
    expect(got).toHaveLength(1)
    expect(got[0]!.kind).toBe('clipGroup')
  })

  it('보이지 않는 레이어는 단계를 만들지 않는다', () => {
    expect(steps([L(), L(undefined, undefined, false)])).toEqual([{ kind: 'layer', index: 0 }])
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
