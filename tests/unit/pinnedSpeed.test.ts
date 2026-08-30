/**
 * 길이 못박기 (timeline.durationPinned).
 *
 * 트랜스포트 바에 90 을 넣어 뒀는데 모션 속도를 올렸다고 길이가 70 으로 바뀌면,
 * "이 길이를 지켜 달라" 는 선언이 속도 노브 하나에 무너진다. 여기서 지키는 계약은
 * 넷이다.
 *
 *   1. 길이를 직접 입력하면 못박힌다. 기계적 경로(pin: false)는 못박지 않는다.
 *   2. 못박은 문서에서는 **어떤 프리셋을 어떤 속도로 적용해도** 전체 프레임 수와
 *      fps 가 한 프레임도 안 바뀐다.
 *   3. 그래도 속도는 살아 있다. 이음새형은 그 길이 안에서 더 잘게 돌고,
 *      등장형은 더 일찍 끝난다.
 *   4. 같은 조작을 반복해도 결과가 흘러가지 않는다.
 */

import { describe, expect, it } from 'vitest'

import { createEmptyProject, createImageLayer, resetIdCounter } from '@/core/factory.ts'
import { SPEED_MIN, type AssetRef } from '@/core/types.ts'
import { MOTION_PRESETS } from '@/motions/registry.ts'
import { applyPresetToLayer } from '@/motions/apply.ts'
import { migrateProject } from '@/project/migrate.ts'
import { buildShapeScene, createSceneContext } from '@/shapes/registry.ts'
import { SHAPE_SCENES } from '@/shapes/registry.ts'
import { useDocumentStore } from '@/state/document.ts'
import { usePresetUiStore } from '@/state/presetUi.ts'
import { useUiStore } from '@/state/ui.ts'
import { applyPresetToDocument } from '@/state/presetActions.ts'

const SIZE = 500

function reset(): void {
  resetIdCounter()
  const doc = createEmptyProject()
  const asset: AssetRef = {
    id: 'a1', name: 'p.png', storeKey: 'm', naturalW: SIZE, naturalH: SIZE, hasAlpha: true,
  }
  doc.assets.push(asset)
  const layer = createImageLayer(asset, 0)
  doc.layers.push(layer)
  doc.canvas.w = SIZE
  doc.canvas.h = SIZE
  useDocumentStore.getState().replaceDocument(doc)
  useUiStore.setState({ selectedLayerId: layer.id })
  usePresetUiStore.setState({ appliedId: null, strength: 0.5, speed: 1 })
}

function applyAt(presetId: string, speed: number) {
  usePresetUiStore.getState().setSpeed(speed)
  applyPresetToDocument(presetId)
  const d = useDocumentStore.getState().doc
  return { frames: d.timeline.durationFrames, fps: d.timeline.fps }
}

describe('못박기 표시', () => {
  it('길이를 직접 입력하면 못박힌다', () => {
    reset()
    useDocumentStore.getState().setDurationFrames(90)
    expect(useDocumentStore.getState().doc.timeline.durationPinned).toBe(true)
  })

  it('기계적 경로(pin: false)는 못박지 않는다', () => {
    reset()
    useDocumentStore.getState().setDurationFrames(90, { pin: false })
    expect(useDocumentStore.getState().doc.timeline.durationPinned).toBeUndefined()
  })

  it('자물쇠 버튼으로 켜고 끈다. 끄면 키 자체가 사라진다', () => {
    reset()
    useDocumentStore.getState().setDurationPinned(true)
    expect(useDocumentStore.getState().doc.timeline.durationPinned).toBe(true)
    useDocumentStore.getState().setDurationPinned(false)
    expect('durationPinned' in useDocumentStore.getState().doc.timeline).toBe(false)
  })

  it('저장 파일을 왕복해도 표시가 살아남고, true 가 아닌 값은 걸러진다', () => {
    reset()
    useDocumentStore.getState().setDurationFrames(90)
    const doc = useDocumentStore.getState().doc

    const round = migrateProject(JSON.stringify(doc)).doc
    expect(round.timeline.durationPinned).toBe(true)

    const dirty = JSON.parse(JSON.stringify(doc)) as Record<string, unknown>
    ;(dirty.timeline as Record<string, unknown>).durationPinned = 'yes'
    const cleaned = migrateProject(JSON.stringify(dirty)).doc
    expect('durationPinned' in cleaned.timeline).toBe(false)
  })
})

describe('못박은 문서에서의 프리셋 적용', () => {
  it('전 프리셋 x 속도 4단에서 전체 프레임 수와 fps 가 한 프레임도 안 바뀐다', () => {
    const broke: string[] = []
    for (const p of MOTION_PRESETS) {
      for (const speed of [SPEED_MIN, 0.5, 1, 2]) {
        reset()
        useDocumentStore.getState().setFps(25)
        useDocumentStore.getState().setDurationFrames(90)
        const r = applyAt(p.id, speed)
        if (r.frames !== 90 || r.fps !== 25) {
          broke.push(`${p.id} x${speed} -> ${r.frames}f ${r.fps}fps`)
        }
      }
    }
    expect(broke).toEqual([])
  })

  it('90 에 못박고 속도를 빠르게 해도 90 그대로다 (버그 재현 경로)', () => {
    reset()
    applyAt('zoom.slowIn', 1)
    useDocumentStore.getState().setDurationFrames(90)
    const r = applyAt('zoom.slowIn', 1.5)
    expect(r.frames).toBe(90)
  })

  it('트랙 키는 전부 못박은 길이 안에 있고 오름차순이다', () => {
    for (const p of MOTION_PRESETS) {
      for (const speed of [0.5, 1, 2]) {
        reset()
        useDocumentStore.getState().setDurationFrames(80)
        applyAt(p.id, speed)
        const doc = useDocumentStore.getState().doc
        const layer = doc.layers[0]!
        for (const track of layer.tracks) {
          let prev = -1
          for (const key of track.keys) {
            const where = `${p.id} x${speed} ${track.prop}`
            expect(key.f, where).toBeGreaterThan(prev)
            expect(key.f, where).toBeLessThanOrEqual(80)
            prev = key.f
          }
        }
      }
    }
  })

  it('이음새형(모디파이어)은 속도를 올리면 같은 길이 안에서 박자가 빨라진다', () => {
    const doc = (() => {
      reset()
      useDocumentStore.getState().setDurationFrames(90)
      return useDocumentStore.getState().doc
    })()
    const layerId = doc.layers[0]!.id

    const at1 = applyPresetToLayer({ doc, layerId, presetId: 'shake.camera', strength: 0.5, speed: 1 })
    const at2 = applyPresetToLayer({ doc, layerId, presetId: 'shake.camera', strength: 0.5, speed: 2 })
    expect(at1.durationFrames).toBe(90)
    expect(at2.durationFrames).toBe(90)

    // 모디파이어는 문서 전체를 한 바퀴로 평가된다. 빠른 쪽이 주기 수를 더 갖는다.
    const cycles1 = at1.modifiers.reduce((n, m) => n + m.cycles, 0)
    const cycles2 = at2.modifiers.reduce((n, m) => n + m.cycles, 0)
    expect(at1.modifiers.length).toBeGreaterThan(0)
    expect(cycles2).toBeGreaterThan(cycles1)
  })

  it('이음새형(트랙)은 속도를 올리면 같은 길이 안에서 더 잘게 돈다', () => {
    reset()
    useDocumentStore.getState().setDurationFrames(90)
    const doc = useDocumentStore.getState().doc
    const layerId = doc.layers[0]!.id

    // 트랙을 실제로 내는 이음새 프리셋을 카탈로그에서 찾는다. 특정 id 에 못박으면
    // 프리셋 개편 때마다 이 테스트가 엉뚱한 이유로 깨진다.
    const sample = MOTION_PRESETS.find((p) => {
      if (p.loopSafe !== 'seamless') return false
      const r = applyPresetToLayer({ doc, layerId, presetId: p.id, strength: 0.5, speed: 1 })
      return r.tracks.some((t) => t.keys.length >= 3)
    })
    expect(sample).toBeDefined()

    const at1 = applyPresetToLayer({ doc, layerId, presetId: sample!.id, strength: 0.5, speed: 1 })
    const at2 = applyPresetToLayer({ doc, layerId, presetId: sample!.id, strength: 0.5, speed: 2 })
    const keys1 = at1.tracks.reduce((n, t) => n + t.keys.length, 0)
    const keys2 = at2.tracks.reduce((n, t) => n + t.keys.length, 0)
    expect(keys2).toBeGreaterThan(keys1)
  })

  it('등장형은 속도를 올리면 더 일찍 끝나고 남는 구간은 멈춘다', () => {
    reset()
    useDocumentStore.getState().setDurationFrames(90)
    const doc = useDocumentStore.getState().doc
    const layerId = doc.layers[0]!.id

    const lastMovingKey = (r: ReturnType<typeof applyPresetToLayer>): number =>
      Math.max(...r.tracks.map((t) => t.keys[t.keys.length - 1]?.f ?? 0))

    const slow = applyPresetToLayer({ doc, layerId, presetId: 'fade.in', strength: 0.5, speed: 0.5 })
    const fast = applyPresetToLayer({ doc, layerId, presetId: 'fade.in', strength: 0.5, speed: 2 })
    expect(slow.durationFrames).toBe(90)
    expect(fast.durationFrames).toBe(90)
    expect(lastMovingKey(fast)).toBeLessThan(lastMovingKey(slow))
  })

  it('같은 속도로 여러 번 적용해도 결과가 흘러가지 않는다', () => {
    reset()
    useDocumentStore.getState().setDurationFrames(90)
    const first = applyAt('shake.camera', 1.5)
    const tracks1 = JSON.stringify(useDocumentStore.getState().doc.layers[0]!.tracks.map((t) => t.keys))
    applyAt('shake.camera', 1.5)
    const second = applyAt('shake.camera', 1.5)
    const tracks2 = JSON.stringify(useDocumentStore.getState().doc.layers[0]!.tracks.map((t) => t.keys))
    expect(second).toEqual(first)
    expect(tracks2).toBe(tracks1)
  })

  it('속도를 왕복해도 길이는 못박은 값 그대로다', () => {
    reset()
    useDocumentStore.getState().setDurationFrames(90)
    applyAt('zoom.slowIn', 1)
    applyAt('zoom.slowIn', SPEED_MIN)
    applyAt('zoom.slowIn', 2)
    const r = applyAt('zoom.slowIn', 1)
    expect(r.frames).toBe(90)
  })

  it('못박기를 풀면 예전처럼 속도가 길이를 정한다', () => {
    reset()
    useDocumentStore.getState().setDurationFrames(90)
    applyAt('zoom.slowIn', 1)
    useDocumentStore.getState().setDurationPinned(false)
    const fast = applyAt('zoom.slowIn', 2)
    expect(fast.frames).toBeLessThan(90)
  })
})

describe('못박은 문서에서의 도형 세트', () => {
  it('hardFit 이면 아주 느린 속도에서도 길이를 늘리지 않는다', () => {
    for (const scene of SHAPE_SCENES) {
      for (const speed of [SPEED_MIN, 0.3, 1, 2]) {
        const out = buildShapeScene(
          scene.id,
          createSceneContext({ fitFrames: 40, fps: 25, speed, hardFit: true }),
        )
        expect(out?.durationFrames, `${scene.id} x${speed}`).toBe(40)
      }
    }
  })
})
