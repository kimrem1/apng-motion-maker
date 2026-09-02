/**
 * 파티클 레이어의 문서 통합.
 *
 * 엔진 자체(입자 생성 / 결정론)는 particles.test.ts 가 지킨다. 여기서는
 * 문서에 얹혔을 때의 계약을 지킨다.
 *   1. 저장 -> 열기 왕복이 JSON 을 한 글자도 바꾸지 않는다.
 *   2. 파티클이 아닌 레이어의 particle 키, 깨진 spec 은 조용히 지워진다.
 *   3. 시간 매핑은 문서 반복 이음새를 만들지 않는다 (정수 루프).
 */

import { beforeEach, describe, expect, it } from 'vitest'

import {
  createEmptyProject,
  createImageLayer,
  createParticleLayer,
  resetIdCounter,
} from '@/core/factory.ts'
import type { AssetRef, MotionProject } from '@/core/types.ts'
import { defaultParticleSpec } from '@/particles/config.ts'
import { particleLoops, particlePhase } from '@/particles/frames.ts'
import { migrateProject } from '@/project/migrate.ts'
import { useDocumentStore } from '@/state/document.ts'

const s = () => useDocumentStore.getState()

function baseDoc(): MotionProject {
  resetIdCounter()
  const doc = createEmptyProject()
  doc.canvas.w = 500
  doc.canvas.h = 500
  doc.timeline.durationFrames = 24
  return doc
}

beforeEach(() => resetIdCounter())

describe('파티클 레이어 저장 파일', () => {
  it('왕복에서 JSON 이 한 글자도 바뀌지 않는다', () => {
    const before = baseDoc()
    before.layers.push(createParticleLayer(defaultParticleSpec('snow'), '눈', 0))
    const { doc, warnings } = migrateProject(JSON.parse(JSON.stringify(before)) as unknown)
    expect(warnings).toEqual([])
    expect(JSON.stringify(doc)).toBe(JSON.stringify(before))
  })

  it('12개 효과 전부 왕복이 안정적이다', () => {
    for (const effect of ['rain', 'snow', 'dust', 'flare', 'sparkle', 'petal', 'fog', 'firefly', 'bokeh', 'ripple', 'caustic', 'bloom'] as const) {
      const before = baseDoc()
      before.layers.push(createParticleLayer(defaultParticleSpec(effect), effect, 0))
      const { doc } = migrateProject(JSON.parse(JSON.stringify(before)) as unknown)
      expect(JSON.stringify(doc), effect).toBe(JSON.stringify(before))
    }
  })

  it('파티클이 아닌 레이어의 particle 키는 지운다', () => {
    const before = baseDoc()
    const ref: AssetRef = {
      id: 'a1', name: 'x', storeKey: 'k', naturalW: 100, naturalH: 100, hasAlpha: true,
    }
    before.assets.push(ref)
    before.layers.push(createImageLayer(ref, 0))
    ;(before.layers[0] as unknown as Record<string, unknown>)['particle'] =
      defaultParticleSpec('snow')
    const { doc } = migrateProject(JSON.parse(JSON.stringify(before)) as unknown)
    expect(doc.layers[0]).not.toHaveProperty('particle')
  })

  it('깨진 spec 은 기본값으로 되살린다', () => {
    const before = baseDoc()
    before.layers.push(createParticleLayer(defaultParticleSpec('rain'), '비', 0))
    ;(before.layers[0]!.particle as unknown as Record<string, unknown>)['count'] = -50
    const { doc } = migrateProject(JSON.parse(JSON.stringify(before)) as unknown)
    // 비의 개수 하한(4)으로 조인다. 음수 개수는 그리는 도중에 터진다.
    expect(doc.layers[0]!.particle!.count).toBeGreaterThanOrEqual(4)
  })

  it('spec 이 아예 없거나 문자열이어도 기본값으로 되살리고 경고를 낸다', () => {
    // spec 없는 파티클 레이어는 그리지도 못하고 고칠 UI 도 없는 죽은 줄이 된다.
    for (const bad of [undefined, 'snow']) {
      const before = baseDoc()
      before.layers.push(createParticleLayer(defaultParticleSpec('snow'), '눈', 0))
      const rawLayer = before.layers[0] as unknown as Record<string, unknown>
      if (bad === undefined) delete rawLayer['particle']
      else rawLayer['particle'] = bad
      const { doc, warnings } = migrateProject(JSON.parse(JSON.stringify(before)) as unknown)
      expect(doc.layers[0]!.particle).toBeTruthy()
      expect(doc.layers[0]!.particle!.effect).toBe('snow')
      expect(warnings.length).toBeGreaterThan(0)
    }
  })
})

describe('파티클 스토어', () => {
  beforeEach(() => {
    s().replaceDocument(baseDoc())
  })

  it('추가와 spec 변경이 각각 실행취소 한 칸이다', () => {
    const { layerId } = s().addParticle({ name: '눈', spec: defaultParticleSpec('snow') })
    expect(s().doc.layers[0]!.type).toBe('particle')
    const depth = s().past.length
    s().setParticleSpec(layerId, { ...s().doc.layers[0]!.particle!, count: 42 })
    expect(s().doc.layers[0]!.particle!.count).toBe(42)
    expect(s().past.length).toBe(depth + 1)
    s().undo()
    expect(s().doc.layers[0]!.particle!.count).toBe(900)
  })

  it('spec 은 언제나 정규화되어 저장된다', () => {
    const { layerId } = s().addParticle({ name: '눈', spec: defaultParticleSpec('snow') })
    s().setParticleSpec(layerId, { ...s().doc.layers[0]!.particle!, speed: 99 })
    expect(s().doc.layers[0]!.particle!.speed).toBe(3)
  })

  it('값이 같으면 실행취소 칸을 만들지 않는다', () => {
    // 같은 빠른 스타일을 두 번 눌러도 Ctrl+Z 가 빈 칸을 먹으면 안 된다.
    const { layerId } = s().addParticle({ name: '눈', spec: defaultParticleSpec('snow') })
    const depth = s().past.length
    s().setParticleSpec(layerId, { ...s().doc.layers[0]!.particle! })
    expect(s().past.length).toBe(depth)
  })
})

describe('파티클 시간 매핑', () => {
  it('루프 수는 항상 1 이상의 정수다', () => {
    for (const speed of [0.25, 0.5, 0.77, 1, 1.3, 2, 3]) {
      const loops = particleLoops({ speed }, 24, 20)
      expect(Number.isInteger(loops)).toBe(true)
      expect(loops).toBeGreaterThanOrEqual(1)
    }
  })

  it('문서 끝 프레임의 다음은 정확히 t=0 이다 (반복 이음새 없음)', () => {
    for (const speed of [0.25, 1, 2.4, 3]) {
      // 프레임 durationFrames 는 반복에서 프레임 0 과 같은 자리다.
      const t = particlePhase({ speed }, 24, 24, 20)
      expect(t).toBeCloseTo(0, 9)
    }
  })

  it('t 는 프레임을 따라 단조 증가한다 (한 루프 안에서)', () => {
    const loops = particleLoops({ speed: 1 }, 24, 20)
    const per = 24 / loops
    let prev = -1
    for (let f = 0; f < per; f += 1) {
      const t = particlePhase({ speed: 1 }, f, 24, 20)
      expect(t).toBeGreaterThan(prev)
      prev = t
    }
  })
})
