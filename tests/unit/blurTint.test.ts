/**
 * 흐림 채널과 색 덧씌우기.
 *
 * 지키는 것은 다섯 가지다.
 *   1. 트랙이 없으면 blur 는 0, tint 는 실리지 않는다. 옛 문서의 픽셀이 바뀌지 않는다.
 *   2. blur 는 다른 채널처럼 키프레임으로 움직이고 음수로 내려가지 않는다.
 *   3. 폴더의 tint 는 안의 모든 레이어에 실리고, 자기 것이 있으면 자기 것이 이긴다.
 *   4. tint 양이 0 이면 키를 만들지 않는다 (JSON 왕복 결정론).
 *   5. 셰이더 세 벌 모두 tint 유니폼을 갖는다. 하나라도 빠지면 그 종류만 색이 안 바뀐다.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { resolveComposition, resolveLayerTransform } from '@/core/evaluate.ts'
import {
  createEmptyProject,
  createFolderLayer,
  createImageLayer,
  resetIdCounter,
  TRACK_DEFAULTS,
} from '@/core/factory.ts'
import { LAYER_FS } from '@/core/renderer/shaders/layer.ts'
import { SHAPE_FS } from '@/core/renderer/shaders/shape.ts'
import { TEXT_FS } from '@/core/renderer/shaders/text.ts'
import type { AssetRef, MotionProject } from '@/core/types.ts'
import { migrateProject } from '@/project/migrate.ts'
import { useDocumentStore } from '@/state/document.ts'

const s = () => useDocumentStore.getState()

function baseDoc(imageCount = 1): MotionProject {
  resetIdCounter()
  const doc = createEmptyProject()
  doc.canvas.w = 500
  doc.canvas.h = 500
  doc.timeline.durationFrames = 20
  const ref: AssetRef = {
    id: 'a1', name: 'x', storeKey: 'k', naturalW: 100, naturalH: 100, hasAlpha: true,
  }
  doc.assets.push(ref)
  for (let i = 0; i < imageCount; i += 1) doc.layers.push(createImageLayer(ref, i))
  return doc
}

beforeEach(() => resetIdCounter())

describe('흐림 채널', () => {
  it('트랙이 없으면 0 이다', () => {
    const doc = baseDoc()
    const t = resolveLayerTransform(doc.layers[0]!, 0, doc.canvas, 20)
    expect(t.blur).toBe(0)
  })

  it('키프레임을 따라 움직인다', () => {
    const doc = baseDoc()
    doc.layers[0]!.tracks = [
      {
        id: 't1',
        prop: 'blur',
        unit: 'px',
        keys: [
          { f: 0, v: 0, interp: 'linear' },
          { f: 10, v: 20, interp: 'linear' },
        ],
      },
    ]
    expect(resolveLayerTransform(doc.layers[0]!, 5, doc.canvas, 20).blur).toBeCloseTo(10, 6)
    // 트랙 구간 밖은 끝 값으로 붙잡힌다. "흐림을 일정 구간에서 멈추기" 가 이 성질이다.
    expect(resolveLayerTransform(doc.layers[0]!, 15, doc.canvas, 20).blur).toBeCloseTo(20, 6)
  })

  it('음수로 내려가지 않는다', () => {
    const doc = baseDoc()
    doc.layers[0]!.tracks = [
      { id: 't1', prop: 'blur', unit: 'px', keys: [{ f: 0, v: -8, interp: 'linear' }] },
    ]
    expect(resolveLayerTransform(doc.layers[0]!, 0, doc.canvas, 20).blur).toBe(0)
  })

  it('기본 단위 표에 들어 있다', () => {
    expect(TRACK_DEFAULTS.blur).toEqual({ unit: 'px', identity: 0 })
  })
})

describe('색 덧씌우기 평가', () => {
  it('없으면 실리지 않는다', () => {
    const doc = baseDoc()
    const resolved = resolveComposition(doc, 0)
    expect(resolved[0]).not.toHaveProperty('tint')
  })

  it('자기 tint 가 숫자로 풀려 실린다', () => {
    const doc = baseDoc()
    doc.layers[0]!.tint = { color: '#ff0000', amount: 0.5 }
    const resolved = resolveComposition(doc, 0)
    expect(resolved[0]!.tint).toEqual({ r: 1, g: 0, b: 0, amount: 0.5 })
  })

  it('폴더의 tint 를 안의 레이어가 물려받는다', () => {
    const doc = baseDoc(1)
    const folder = createFolderLayer('폴더', 0)
    folder.tint = { color: '#00ff00', amount: 1 }
    doc.layers.unshift(folder)
    doc.layers[1]!.folderId = folder.id
    doc.layers.forEach((l, i) => { l.z = i })

    const resolved = resolveComposition(doc, 0)
    const child = resolved.find((l) => l.layerId === doc.layers[1]!.id)!
    expect(child.tint).toEqual({ r: 0, g: 1, b: 0, amount: 1 })
  })

  it('자기 것이 있으면 폴더 것보다 이긴다', () => {
    const doc = baseDoc(1)
    const folder = createFolderLayer('폴더', 0)
    folder.tint = { color: '#00ff00', amount: 1 }
    doc.layers.unshift(folder)
    doc.layers[1]!.folderId = folder.id
    doc.layers[1]!.tint = { color: '#0000ff', amount: 0.25 }
    doc.layers.forEach((l, i) => { l.z = i })

    const resolved = resolveComposition(doc, 0)
    const child = resolved.find((l) => l.layerId === doc.layers[1]!.id)!
    expect(child.tint).toEqual({ r: 0, g: 0, b: 1, amount: 0.25 })
  })
})

describe('색 덧씌우기 스토어', () => {
  beforeEach(() => {
    s().replaceDocument(baseDoc())
  })

  it('양이 0 이거나 null 이면 키를 지운다', () => {
    const id = s().doc.layers[0]!.id
    s().setLayerTint(id, { color: '#ff0000', amount: 0.5 })
    expect(s().doc.layers[0]!.tint).toEqual({ color: '#ff0000', amount: 0.5 })
    s().setLayerTint(id, { color: '#ff0000', amount: 0 })
    expect('tint' in s().doc.layers[0]!).toBe(false)
    s().setLayerTint(id, { color: '#ff0000', amount: 0.5 })
    s().setLayerTint(id, null)
    expect('tint' in s().doc.layers[0]!).toBe(false)
  })

  it('양을 0..1 로 가둔다', () => {
    const id = s().doc.layers[0]!.id
    s().setLayerTint(id, { color: '#ff0000', amount: 3 })
    expect(s().doc.layers[0]!.tint!.amount).toBe(1)
  })
})

describe('색 덧씌우기 저장 파일', () => {
  it('값이 왕복에서 그대로 남는다', () => {
    const before = baseDoc()
    before.layers[0]!.tint = { color: '#a1b2c3', amount: 0.75 }
    const { doc, warnings } = migrateProject(JSON.parse(JSON.stringify(before)) as unknown)
    expect(warnings).toEqual([])
    expect(JSON.stringify(doc)).toBe(JSON.stringify(before))
  })

  it('깨진 값은 키째로 지운다', () => {
    for (const bad of [
      { color: 'red', amount: 0.5 },
      { color: '#ff0000', amount: 0 },
      { color: '#ff0000' },
      'tinted',
    ]) {
      const before = baseDoc() as unknown as Record<string, unknown>
      ;(before['layers'] as Record<string, unknown>[])[0]!['tint'] = bad
      const { doc } = migrateProject(JSON.parse(JSON.stringify(before)) as unknown)
      expect(doc.layers[0]).not.toHaveProperty('tint')
    }
  })
})

describe('셰이더 유니폼', () => {
  it('세 셰이더 모두 tint 유니폼을 선언한다', () => {
    for (const source of [LAYER_FS, SHAPE_FS, TEXT_FS]) {
      expect(source).toContain('uniform vec3 u_tintColor')
      expect(source).toContain('uniform float u_tintAmount')
    }
  })
})
