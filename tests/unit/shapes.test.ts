/**
 * 도형 레이어와 도형 모션 세트.
 *
 * 여기서 지키는 것은 네 가지다.
 *   1. 카탈로그가 문서 계약을 어기지 않는다 (투명도 0~1, 배율 > 0, 프레임 오름차순).
 *   2. 같은 입력이면 같은 결과다. 카드에서 본 것과 실제 결과가 갈리면 안 된다.
 *   3. 도형 레이어가 저장 -> 열기 왕복에서 한 글자도 달라지지 않는다.
 *   4. 세트 하나를 넣는 것이 실행취소 한 칸이다.
 *
 * 셰이더는 브라우저 없이 컴파일할 수 없다. effectsRender.test.ts 와 같은 방식으로
 * 실제로 겪었던 컴파일 사고만 문자열 수준에서 막는다.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { createEmptyProject, createImageLayer, createShapeLayer, resetIdCounter } from '@/core/factory.ts'
import { SHAPE_LIMITS, createShapeSpec, layerIntrinsicSize, normalizeShapeSpec, shiftColor, toHex6, withAlpha } from '@/core/shape.ts'
import { resolveComposition } from '@/core/evaluate.ts'
import { solveOverscan } from '@/core/overscan.ts'
import { SHAPE_FS, SHAPE_KIND_CODE } from '@/core/renderer/shaders/shape.ts'
import {
  FRAMES_MAX,
  SHAPE_KIND_LIST,
  type AssetRef,
  type MotionProject,
  type ShapeSpec,
} from '@/core/types.ts'
import { evalTrack } from '@/easing/curve.ts'
import { migrateProject } from '@/project/migrate.ts'
import { buildShapeScene, createSceneContext, SHAPE_SCENES, SHAPE_SCENE_BY_ID } from '@/shapes/registry.ts'
import { stops } from '@/shapes/shared.ts'
import { SHAPE_GROUP_LABELS, SHAPE_GROUP_ORDER } from '@/shapes/types.ts'
import { applyPresetToLayer } from '@/motions/apply.ts'
import { useDocumentStore } from '@/state/document.ts'
import { applyShapeScene } from '@/state/shapeActions.ts'
import { useShapeUiStore } from '@/state/shapeUi.ts'

const s = () => useDocumentStore.getState()

function emptyDoc(): MotionProject {
  resetIdCounter()
  return createEmptyProject()
}

/** 세기를 올려도 크기가 달라지지 않는 세트. 화면을 덮는 것과 고정 굵기 장식들이다. */
const FIXED_AMPLITUDE = new Set([
  'wipe.circle',
  'wipe.bands',
  'wipe.shutter',
  'spin.ring',
  'accent.frame',
])

beforeEach(() => {
  s().replaceDocument(emptyDoc())
})

// ---------------------------------------------------------------------------
// 값 규칙
// ---------------------------------------------------------------------------

describe('도형 값 규칙', () => {
  it('종류 목록과 셰이더 코드가 짝이 맞는다', () => {
    for (const kind of SHAPE_KIND_LIST) {
      expect(typeof SHAPE_KIND_CODE[kind]).toBe('number')
    }
    // 코드가 겹치면 두 종류가 같은 그림이 된다.
    const codes = SHAPE_KIND_LIST.map((k) => SHAPE_KIND_CODE[k])
    expect(new Set(codes).size).toBe(SHAPE_KIND_LIST.length)
  })

  it('이상한 값이 들어와도 그릴 수 있는 도형이 된다', () => {
    const bad = normalizeShapeSpec({
      kind: 'nope' as never,
      color: '',
      width: Number.NaN,
      height: -50,
      strokeWidth: 9999,
      cornerRadius: 9999,
      points: 999,
      innerRatio: 5,
      sweepDeg: 0,
    })
    expect(bad.kind).toBe('rect')
    expect(bad.color).toBe('#ffffffff')
    expect(bad.width).toBeGreaterThan(0)
    expect(bad.height).toBeGreaterThan(0)
    expect(bad.points).toBeLessThanOrEqual(SHAPE_LIMITS.points.max)
    expect(bad.innerRatio).toBeLessThanOrEqual(0.95)
    expect(bad.sweepDeg).toBeGreaterThanOrEqual(5)
  })

  it('테두리 두께는 짧은 변의 절반을 넘지 않는다', () => {
    // 넘으면 도형이 통째로 메워져 "테두리를 굵게 했더니 채워졌다" 가 된다.
    const spec = normalizeShapeSpec({ kind: 'circle', width: 100, height: 40, strokeWidth: 400 })
    expect(spec.strokeWidth).toBeLessThanOrEqual(20)
  })

  it('색 헬퍼가 여덟 자리 hex 를 지킨다', () => {
    expect(toHex6('#abc')).toBe('#aabbcc')
    expect(toHex6('#11223344')).toBe('#112233')
    expect(withAlpha('#ff0000', 0.5)).toMatch(/^#ff0000[0-9a-f]{2}$/)
    expect(withAlpha('#ff0000', 1)).toBe('#ff0000ff')
    expect(shiftColor('#000000', 1)).toBe('#ffffffff')
    expect(shiftColor('#ffffff', -1)).toBe('#000000ff')
  })

  it('자연 크기는 도형이면 도형 크기, 이미지면 원본 픽셀이다', () => {
    const shape = createShapeSpec('circle', { width: 120, height: 80 })
    expect(layerIntrinsicSize({ assetId: null, shape }, () => undefined)).toEqual({
      width: 120,
      height: 80,
    })
    expect(
      layerIntrinsicSize({ assetId: 'a1' }, () => ({ width: 30, height: 40 })),
    ).toEqual({ width: 30, height: 40 })
    expect(layerIntrinsicSize({ assetId: null }, () => undefined)).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 카탈로그
// ---------------------------------------------------------------------------

describe('도형 세트 카탈로그', () => {
  it('서른네 종이고 id 가 겹치지 않는다', () => {
    expect(SHAPE_SCENES).toHaveLength(34)
    expect(SHAPE_SCENE_BY_ID.size).toBe(SHAPE_SCENES.length)
  })

  it('묶음마다 최소 세 종이 있고 순서 목록에 정확히 한 번씩 들어간다', () => {
    for (const group of SHAPE_GROUP_ORDER) {
      const list = SHAPE_SCENES.filter((scene) => scene.group === group)
      expect(list.length).toBeGreaterThanOrEqual(3)
    }
    expect(new Set(SHAPE_GROUP_ORDER).size).toBe(SHAPE_GROUP_ORDER.length)
    expect(SHAPE_GROUP_ORDER.length).toBe(Object.keys(SHAPE_GROUP_LABELS).length)
  })

  it('사용자에게 보이는 글에 내부 id 나 영문이 없다', () => {
    for (const scene of SHAPE_SCENES) {
      expect(scene.label.length).toBeGreaterThan(0)
      expect(scene.hint.length).toBeGreaterThan(0)
      expect(scene.label).not.toMatch(/[a-zA-Z.]/)
      expect(scene.hint).not.toContain(scene.id)
    }
    for (const label of Object.values(SHAPE_GROUP_LABELS)) {
      expect(label).not.toMatch(/[a-zA-Z]/)
    }
  })

  it('이름이 겹치지 않는다', () => {
    const labels = SHAPE_SCENES.map((scene) => scene.label)
    expect(new Set(labels).size).toBe(labels.length)
  })

  it.each([0.5, 1, 2])('만드는 값이 문서 계약을 지킨다 (속도 %s)', (speed) => {
    for (const scene of SHAPE_SCENES) {
      const out = buildShapeScene(scene.id, createSceneContext({ speed }))
      expect(out, scene.id).not.toBeNull()
      if (!out) continue

      expect(out.durationFrames, scene.id).toBeGreaterThanOrEqual(2)
      expect(out.durationFrames, scene.id).toBeLessThanOrEqual(FRAMES_MAX)
      expect(Number.isInteger(out.durationFrames), scene.id).toBe(true)
      expect(out.fps, scene.id).toBeGreaterThan(0)
      expect(out.layers.length, scene.id).toBeGreaterThanOrEqual(1)

      for (const layer of out.layers) {
        expect(layer.name.length, scene.id).toBeGreaterThan(0)
        expect(layer.shape.width, scene.id).toBeGreaterThan(0)
        expect(layer.shape.height, scene.id).toBeGreaterThan(0)
        expect(layer.tracks.length, scene.id).toBeGreaterThanOrEqual(1)

        const props = new Set<string>()
        for (const track of layer.tracks) {
          // 같은 속성이 둘이면 평가기가 둘 다 합성해 값이 두 배로 튄다.
          expect(props.has(track.prop), `${scene.id}:${track.prop}`).toBe(false)
          props.add(track.prop)

          expect(track.keys.length, scene.id).toBeGreaterThanOrEqual(1)
          let prev = -1
          for (const key of track.keys) {
            expect(Number.isInteger(key.f), `${scene.id}:${track.prop}`).toBe(true)
            expect(key.f, `${scene.id}:${track.prop}`).toBeGreaterThan(prev)
            expect(key.f, `${scene.id}:${track.prop}`).toBeLessThanOrEqual(out.durationFrames)
            expect(Number.isFinite(key.v), `${scene.id}:${track.prop}`).toBe(true)
            prev = key.f
          }

          if (track.prop === 'opacity') {
            for (const key of track.keys) {
              expect(key.v, scene.id).toBeGreaterThanOrEqual(0)
              expect(key.v, scene.id).toBeLessThanOrEqual(1)
            }
          }
          if (track.prop === 'scale' || track.prop === 'scaleX' || track.prop === 'scaleY') {
            for (const key of track.keys) expect(key.v, scene.id).toBeGreaterThan(0)
          }
        }
      }
    }
  })

  it('같은 입력이면 같은 결과다', () => {
    for (const scene of SHAPE_SCENES) {
      const a = buildShapeScene(scene.id, createSceneContext({ strength: 0.7, speed: 1.3 }))
      const b = buildShapeScene(scene.id, createSceneContext({ strength: 0.7, speed: 1.3 }))
      expect(a, scene.id).toEqual(b)
    }
  })

  it('속도를 올리면 짧아진다', () => {
    for (const scene of SHAPE_SCENES) {
      const fast = buildShapeScene(scene.id, createSceneContext({ speed: 2 }))
      const slow = buildShapeScene(scene.id, createSceneContext({ speed: 0.5 }))
      if (!fast || !slow) throw new Error(scene.id)
      // 프레임 수가 같아도 fps 가 다르면 시간이 다르다. 초로 잰다.
      expect(fast.durationFrames / fast.fps, scene.id).toBeLessThan(slow.durationFrames / slow.fps)
    }
  })

  it('가장 느린 속도에서도 프레임 상한을 넘지 않는다', () => {
    for (const scene of SHAPE_SCENES) {
      const out = buildShapeScene(scene.id, createSceneContext({ speed: 0.1 }))
      expect(out?.durationFrames ?? 0, scene.id).toBeLessThanOrEqual(FRAMES_MAX)
    }
  })

  it('세기 노브가 실제로 무언가를 바꾼다', () => {
    for (const scene of SHAPE_SCENES) {
      if (FIXED_AMPLITUDE.has(scene.id)) continue
      const weak = buildShapeScene(scene.id, createSceneContext({ strength: 0 }))
      const strong = buildShapeScene(scene.id, createSceneContext({ strength: 1 }))
      expect(JSON.stringify(weak), scene.id).not.toBe(JSON.stringify(strong))
    }
  })

  it('색 노브가 실제로 무언가를 바꾼다', () => {
    for (const scene of SHAPE_SCENES) {
      const a = buildShapeScene(scene.id, createSceneContext({ color: '#ff0000' }))
      const b = buildShapeScene(scene.id, createSceneContext({ color: '#00ff00' }))
      expect(JSON.stringify(a), scene.id).not.toBe(JSON.stringify(b))
    }
  })

  it('캔버스가 세로로 길어도 도형이 캔버스를 벗어날 만큼 커지지 않는다', () => {
    for (const scene of SHAPE_SCENES) {
      if (scene.covers) continue
      const out = buildShapeScene(scene.id, createSceneContext({ canvasW: 320, canvasH: 800 }))
      if (!out) throw new Error(scene.id)
      for (const layer of out.layers) {
        expect(layer.shape.width, scene.id).toBeLessThanOrEqual(320 * 2)
        expect(layer.shape.height, scene.id).toBeLessThanOrEqual(800 * 2)
      }
    }
  })

  it('모르는 세트는 조용히 null 이다', () => {
    expect(buildShapeScene('없는세트', createSceneContext())).toBeNull()
  })

  /**
   * 느린 fps + 빠른 속도 조합에서 프레임 수가 확 줄어든다. 그때 키가 서로 겹쳐
   * 뒤로 밀리면 마지막 키가 프레임 밖으로 나가 **영영 평가되지 않는다.**
   * 셔터가 닫힌 채로 끝나고 테두리가 남은 채로 끝나던 사고가 그것이다.
   */
  it('어떤 fps 와 속도에서도 키가 재생 구간 안에 있다', () => {
    for (const fps of [10, 12.5, 20, 25, 50]) {
      for (const speed of [0.5, 1, 1.5, 2]) {
        for (const scene of SHAPE_SCENES) {
          const out = buildShapeScene(scene.id, createSceneContext({ fps, speed }))
          if (!out) throw new Error(scene.id)
          const where = `${scene.id} fps=${fps} speed=${speed}`
          for (const layer of out.layers) {
            for (const track of layer.tracks) {
              const last = track.keys[track.keys.length - 1]
              expect(last, where).toBeDefined()
              expect(last!.f, `${where} ${track.prop}`).toBeLessThanOrEqual(out.durationFrames)
              let prev = -1
              for (const key of track.keys) {
                expect(key.f, `${where} ${track.prop}`).toBeGreaterThan(prev)
                prev = key.f
              }
            }
          }
        }
      }
    }
  })

  /**
   * 마지막 출력 프레임은 durationFrames - 1 이다. 사라지는 동작이 durationFrames 에서
   * 끝나면 실제로 그려지는 마지막 프레임에는 아직 절반쯤 남아 있고, 반복하는 순간
   * 그것이 뚝 끊긴다. 강조 세트는 전부 '나타났다 사라진다' 이므로 여기서 확인한다.
   */
  it('한 번 나타났다 사라지는 세트는 마지막 출력 프레임에서 처음 상태로 돌아와 있다', () => {
    /*
     * 주기형 세트(물결, 반짝임 등)는 여기 해당하지 않는다. 그쪽은 마지막 출력
     * 프레임이 주기의 한 칸 앞이라 값이 첫 프레임과 달라야 정상이다. 이 검사는
     * "나타났다가 완전히 사라진다" 를 약속한 한 번짜리 세트만 본다.
     */
    const ONE_SHOT = new Set([
      'accent.pop',
      'accent.underline',
      'accent.frame',
      'accent.burst',
      'wipe.circle',
      'wipe.shutter',
    ])
    for (const scene of SHAPE_SCENES) {
      if (!ONE_SHOT.has(scene.id)) continue
      const out = buildShapeScene(scene.id, createSceneContext())
      if (!out) throw new Error(scene.id)
      const last = out.durationFrames - 1

      for (const layer of out.layers) {
        for (const track of layer.tracks) {
          if (track.prop !== 'opacity' && track.prop !== 'scale' && track.prop !== 'scaleX' && track.prop !== 'scaleY') {
            continue
          }
          const first = evalTrack(track, 0) ?? 0
          const end = evalTrack(track, last) ?? 0
          // 진폭 대비 3% 안이면 눈에 안 보인다.
          const span = Math.max(...track.keys.map((k) => k.v)) - Math.min(...track.keys.map((k) => k.v))
          expect(Math.abs(end - first), `${scene.id} ${layer.name} ${track.prop}`).toBeLessThanOrEqual(
            Math.max(0.02, span * 0.03),
          )
        }
      }
    }
  })

  it('이미 만들어 둔 길이가 있으면 그 길이에 맞춘다', () => {
    for (const scene of SHAPE_SCENES) {
      const out = buildShapeScene(scene.id, createSceneContext({ fitFrames: 77, fps: 20 }))
      expect(out?.durationFrames, scene.id).toBe(77)
      expect(out?.fps, scene.id).toBe(20)
    }
  })
})

describe('키 프레임 배치 헬퍼', () => {
  it('오름차순이고 끝을 넘지 않는다', () => {
    expect(stops(10, [0, 0.5, 1])).toEqual([0, 5, 10])
    // 짧은 구간에서 겹쳐도 밀려서 끝을 넘지 않는다.
    const tight = stops(6, [0, 0.1, 0.15, 0.2, 0.9, 1])
    expect(tight).toEqual([...tight].sort((a, b) => a - b))
    expect(new Set(tight).size).toBe(tight.length)
    expect(tight[tight.length - 1]).toBeLessThanOrEqual(6)
  })

  it('끝 비율이 1 보다 작으면 그 자리를 넘지 않는다', () => {
    const out = stops(20, [0, 0.2, 0.5])
    expect(out[out.length - 1]).toBeLessThanOrEqual(10)
  })
})

// ---------------------------------------------------------------------------
// 문서 스토어
// ---------------------------------------------------------------------------

describe('도형 레이어 스토어', () => {
  it('도형 하나를 넣는 것이 실행취소 한 칸이다', () => {
    const { layerId } = s().addShape({ name: '네모', shape: createShapeSpec('rect') })
    expect(s().doc.layers).toHaveLength(1)
    expect(s().past).toHaveLength(1)

    const layer = s().doc.layers[0]!
    expect(layer.id).toBe(layerId)
    expect(layer.type).toBe('shape')
    expect(layer.assetId).toBeNull()
    expect(layer.fit).toBe('none')
    expect(layer.shape?.kind).toBe('rect')

    s().undo()
    expect(s().doc.layers).toHaveLength(0)
  })

  it('도형을 넣어도 캔버스 크기는 그대로다', () => {
    const before = { ...s().doc.canvas }
    s().addShape({ name: '큰 네모', shape: createShapeSpec('rect', { width: 3000, height: 3000 }) })
    expect(s().doc.canvas.w).toBe(before.w)
    expect(s().doc.canvas.h).toBe(before.h)
  })

  it('세트 한 벌이 실행취소 한 칸이다', () => {
    const out = buildShapeScene('pulse.ripple', createSceneContext())
    if (!out) throw new Error('emit 실패')

    const { layerIds } = s().addShapeScene({
      label: '물결 파동 넣기',
      layers: out.layers,
      durationFrames: out.durationFrames,
      loopMode: out.loopMode,
      fps: out.fps,
    })

    expect(layerIds.length).toBe(out.layers.length)
    expect(s().doc.layers).toHaveLength(out.layers.length)
    expect(s().past).toHaveLength(1)
    expect(s().doc.timeline.durationFrames).toBe(out.durationFrames)

    // 트랙 id 는 문서 안에서 유일해야 한다. 장면 정의는 같은 id 를 여러 장에 쓴다.
    const ids = s().doc.layers.flatMap((l) => l.tracks.map((t) => t.id))
    expect(new Set(ids).size).toBe(ids.length)

    s().undo()
    expect(s().doc.layers).toHaveLength(0)
  })

  it('같은 세트를 다시 넣으면 앞의 것을 갈아끼운다', () => {
    const out = buildShapeScene('bars.equalizer', createSceneContext())
    if (!out) throw new Error('emit 실패')

    const first = s().addShapeScene({
      label: '음악 막대 넣기',
      layers: out.layers,
      durationFrames: out.durationFrames,
      loopMode: out.loopMode,
      fps: out.fps,
    })
    const count = s().doc.layers.length

    s().addShapeScene({
      label: '음악 막대 넣기',
      layers: out.layers,
      durationFrames: out.durationFrames,
      loopMode: out.loopMode,
      fps: out.fps,
      replace: first.layerIds,
    })
    expect(s().doc.layers).toHaveLength(count)
    for (const id of first.layerIds) {
      expect(s().doc.layers.some((l) => l.id === id)).toBe(false)
    }
  })

  it('세트는 프리셋 참조를 건드리지 않는다', () => {
    const out = buildShapeScene('spin.square', createSceneContext())
    if (!out) throw new Error('emit 실패')
    expect(s().doc.presetRef).toBeUndefined()
    s().addShapeScene({
      label: '도는 사각 넣기',
      layers: out.layers,
      durationFrames: out.durationFrames,
      loopMode: out.loopMode,
      fps: out.fps,
    })
    expect(s().doc.presetRef).toBeUndefined()
  })

  it('도형 모양을 바꾸면 값이 범위 안으로 잘린다', () => {
    const { layerId } = s().addShape({ name: '별', shape: createShapeSpec('star') })
    s().setShapeSpec(layerId, { points: 99, innerRatio: -1 })
    const shape = s().doc.layers[0]!.shape as ShapeSpec
    expect(shape.points).toBe(SHAPE_LIMITS.points.max)
    expect(shape.innerRatio).toBeGreaterThan(0)
    expect(shape.kind).toBe('star')
  })

  it('도형 레이어를 지워도 에셋 목록이 흔들리지 않는다', () => {
    const { layerId } = s().addShape({ name: '원', shape: createShapeSpec('circle') })
    s().removeLayer(layerId)
    expect(s().doc.layers).toHaveLength(0)
    expect(s().doc.assets).toHaveLength(0)
  })

  it('반복 방식을 안 넘기면 사용자가 고른 값을 그대로 둔다', () => {
    s().setLoopMode('once')
    const out = buildShapeScene('pulse.ripple', createSceneContext())
    if (!out) throw new Error('emit 실패')
    s().addShapeScene({
      label: '물결 파동 넣기',
      layers: out.layers,
      durationFrames: out.durationFrames,
      fps: out.fps,
    })
    expect(s().doc.timeline.loop.mode).toBe('once')
  })

  it('세트는 프리셋의 fps 기준선을 건드리지 않는다', () => {
    // baseFps 는 "사용자가 고른 fps" 이고 속도 유도 fps 의 천장이다. 세트가 유도한
    // 값을 여기 넣으면 모션 속도를 되돌려도 원래 fps 로 못 돌아온다.
    s().setFps(25)
    const doc = { ...s().doc }
    doc.presetRef = { id: 'zoom.pop', macro: { speed: 1, strength: 0.5 }, dirty: false, baseFps: 25 }
    s().replaceDocument(doc)

    const out = buildShapeScene('bars.equalizer', createSceneContext({ speed: 0.2 }))
    if (!out) throw new Error('emit 실패')
    s().addShapeScene({
      label: '음악 막대 넣기',
      layers: out.layers,
      durationFrames: out.durationFrames,
      fps: out.fps,
    })
    expect(s().doc.presetRef?.baseFps).toBe(25)
  })

  it('한 번의 실행취소가 무한정 커지지 않는다', () => {
    // 슬라이더 드래그는 같은 coalesceKey 로 계속 들어온다. 병합만 하면 레이어
    // 사본이 한 칸에 수백 개 쌓인다. 상한을 넘으면 새 칸을 연다.
    const out = buildShapeScene('bars.mirror', createSceneContext())
    if (!out) throw new Error('emit 실패')
    let ids: string[] = []
    for (let i = 0; i < 40; i += 1) {
      const res = s().addShapeScene({
        label: '대칭 파형 넣기',
        layers: out.layers,
        durationFrames: out.durationFrames,
        fps: out.fps,
        replace: ids,
        coalesceKey: 'shapeScene:bars.mirror',
      })
      ids = res.layerIds
    }
    expect(s().past.length).toBeGreaterThan(1)
    for (const command of s().past) {
      expect(command.patches.length).toBeLessThanOrEqual(400)
    }
  })
})

// ---------------------------------------------------------------------------
// 세션 기억
// ---------------------------------------------------------------------------

describe('도형 세트 세션 기억', () => {
  beforeEach(() => {
    useShapeUiStore.setState({ applied: null, ceilFps: null, strength: 0.5, speed: 1 })
  })

  it('같은 세트를 다시 누르면 갈아끼우고, 손댄 뒤에는 갈아끼우지 않는다', () => {
    applyShapeScene('pulse.ripple')
    const first = useShapeUiStore.getState().applied
    expect(first?.layerIds).toHaveLength(3)
    expect(s().doc.layers).toHaveLength(3)

    applyShapeScene('pulse.ripple')
    expect(s().doc.layers).toHaveLength(3)

    // 손을 댄다. 이제 다시 만들면 그 편집이 사라지므로 라이브 재적용을 막아야 한다.
    const target = useShapeUiStore.getState().applied!.layerIds[0]!
    s().setShapeSpec(target, { color: '#ff0000ff' })

    const report = applyShapeScene('pulse.ripple', true)
    expect(report.ok).toBe(false)
    expect(useShapeUiStore.getState().applied).toBeNull()
    expect(s().doc.layers).toHaveLength(3)
    expect(s().doc.layers[0]!.shape?.color).toBe('#ff0000ff')
  })

  it('세트 레이어를 하나 지우면 나머지를 되살리지 않는다', () => {
    applyShapeScene('bars.loading')
    const ids = useShapeUiStore.getState().applied!.layerIds
    expect(ids).toHaveLength(3)
    s().removeLayer(ids[0]!)

    applyShapeScene('bars.loading', true)
    // 지운 한 장이 되살아나지 않는다. 남은 두 장도 그대로다.
    expect(s().doc.layers).toHaveLength(2)
  })

  it('다른 문서를 열면 앞 문서의 기억을 버린다', () => {
    applyShapeScene('pulse.ripple')
    const ids = useShapeUiStore.getState().applied!.layerIds
    expect(useShapeUiStore.getState().applied).not.toBeNull()

    /*
     * 레이어 id 는 세션 단조 카운터라 다른 문서와 그대로 겹친다. 기억을 안 버리면
     * 새로 연 프로젝트의 **남의 레이어**가 갈아끼우기 대상이 되어 지워진다.
     */
    const other = emptyDoc()
    const ref: AssetRef = {
      id: 'a1', name: 'x', storeKey: 'k', naturalW: 20, naturalH: 20, hasAlpha: true,
    }
    other.assets.push(ref)
    for (const id of ids) {
      const layer = createImageLayer(ref, other.layers.length)
      layer.id = id
      other.layers.push(layer)
    }
    s().replaceDocument(other)

    expect(useShapeUiStore.getState().applied).toBeNull()
    applyShapeScene('pulse.ripple')
    // 이미지 세 장은 그대로 있고 링 세 장이 위에 얹힌다.
    expect(s().doc.layers.filter((l) => l.type === 'image')).toHaveLength(3)
    expect(s().doc.layers.filter((l) => l.type === 'shape')).toHaveLength(3)
  })

  it('이미 만들어 둔 타임라인이 있으면 길이를 덮지 않는다', () => {
    const doc = emptyDoc()
    const ref: AssetRef = {
      id: 'a1', name: 'x', storeKey: 'k', naturalW: 20, naturalH: 20, hasAlpha: true,
    }
    doc.assets.push(ref)
    doc.layers.push(createImageLayer(ref, 0))
    doc.timeline.durationFrames = 96
    doc.timeline.fps = 20
    s().replaceDocument(doc)

    applyShapeScene('accent.sparkle')
    expect(s().doc.timeline.durationFrames).toBe(96)
    expect(s().doc.timeline.fps).toBe(20)
  })
})

// ---------------------------------------------------------------------------
// 렌더 경로
// ---------------------------------------------------------------------------

describe('도형과 렌더 경로', () => {
  it('평가 결과가 도형을 렌더러까지 실어 나른다', () => {
    const doc = emptyDoc()
    doc.layers.push(createShapeLayer(createShapeSpec('star'), '별', 0))
    doc.layers.push(createImageLayer(
      { id: 'a1', name: 'x', storeKey: 'k', naturalW: 10, naturalH: 10, hasAlpha: true } as AssetRef,
      1,
    ))

    const resolved = resolveComposition(doc, 0)
    expect(resolved[0]?.shape?.kind).toBe('star')
    // 이미지 레이어에는 키 자체가 없어야 한다.
    expect('shape' in (resolved[1] ?? {})).toBe(false)
  })

  it('오버스캔 솔버가 도형 크기를 안다', () => {
    const doc = emptyDoc()
    doc.canvas.w = 200
    doc.canvas.h = 200
    const layer = createShapeLayer(createShapeSpec('rect', { width: 400, height: 400 }), '네모', 0)
    layer.keepInside = true
    doc.layers.push(layer)

    const map = solveOverscan(doc, () => undefined)
    const need = map.get(layer.id)
    expect(need).toBeDefined()
    // 캔버스보다 두 배 큰 도형에 담기를 켜면 배율이 내려가야 한다.
    expect(need?.correction ?? 1).toBeLessThan(1)
  })

  it('도형 레이어에 모션 프리셋이 그대로 걸린다', () => {
    const doc = emptyDoc()
    const layer = createShapeLayer(createShapeSpec('circle'), '원', 0)
    doc.layers.push(layer)

    const result = applyPresetToLayer({
      doc,
      layerId: layer.id,
      presetId: 'zoom.pop',
      strength: 0.5,
      speed: 1,
    })
    expect(result.tracks.length).toBeGreaterThan(0)
    expect(result.durationFrames).toBeGreaterThanOrEqual(2)
  })
})

// ---------------------------------------------------------------------------
// 저장과 열기
// ---------------------------------------------------------------------------

describe('도형 레이어 왕복', () => {
  it('저장했다 열어도 문서가 한 글자도 달라지지 않는다', () => {
    const doc = emptyDoc()
    doc.layers.push(createShapeLayer(createShapeSpec('polygon', { points: 8 }), '팔각형', 0))

    const before = JSON.stringify(doc)
    const { doc: after, warnings } = migrateProject(JSON.parse(before))
    expect(JSON.stringify(after)).toBe(before)
    expect(warnings).toEqual([])
  })

  it('도형 종류가 이상하면 사각형으로 되돌린다', () => {
    const doc = emptyDoc()
    const layer = createShapeLayer(createShapeSpec('star'), '별', 0)
    doc.layers.push(layer)
    const raw = JSON.parse(JSON.stringify(doc)) as { layers: { shape: { kind: string } }[] }
    raw.layers[0]!.shape.kind = '???'

    const { doc: after } = migrateProject(raw)
    expect(after.layers[0]!.shape?.kind).toBe('rect')
    expect(after.layers[0]!.type).toBe('shape')
  })

  it('이미지 레이어에는 도형 키가 붙지 않는다', () => {
    const doc = emptyDoc()
    const ref: AssetRef = {
      id: 'a1', name: 'x', storeKey: 'k', naturalW: 20, naturalH: 20, hasAlpha: true,
    }
    doc.assets.push(ref)
    doc.layers.push(createImageLayer(ref, 0))

    const { doc: after } = migrateProject(JSON.parse(JSON.stringify(doc)))
    expect('shape' in after.layers[0]!).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 셰이더 정적 검사
// ---------------------------------------------------------------------------

describe('도형 셰이더', () => {
  /** GLSL ES 3.0 예약어. 변수 이름으로 쓰면 컴파일이 통째로 죽는다. */
  const RESERVED = [
    'active', 'asm', 'attribute', 'cast', 'class', 'common', 'enum', 'extern',
    'external', 'filter', 'fixed', 'goto', 'half', 'inline', 'input', 'interface',
    'long', 'namespace', 'noinline', 'output', 'partition', 'public', 'resource',
    'sample', 'short', 'sizeof', 'static', 'superp', 'template', 'this', 'typedef',
    'union', 'unsigned', 'using', 'varying', 'volatile',
  ]

  const source = SHAPE_FS.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ')

  it('예약어를 변수 이름으로 쓰지 않는다', () => {
    for (const word of RESERVED) {
      const re = new RegExp(`\\b(float|int|uint|bool|vec2|vec3|vec4|ivec2|mat2|mat3)\\s+${word}\\b`)
      expect(re.test(source), word).toBe(false)
    }
  })

  it('기기마다 결과가 달라지는 난수 관용구를 쓰지 않는다', () => {
    // fract(sin(...)) 는 GPU 마다 값이 달라 프리뷰와 내보내기가 갈린다.
    expect(/fract\s*\(\s*sin\s*\(/.test(source)).toBe(false)
  })

  it('premultiplied 로 출력한다', () => {
    // 이걸 어기면 프리뷰는 멀쩡한데 내보낸 파일에서만 반투명 가장자리 색이 뜬다.
    expect(source).toContain('fragColor = vec4(u_color.rgb * a, a)')
  })

  it('첫 줄이 버전 선언이다', () => {
    expect(SHAPE_FS.trimStart().startsWith('#version 300 es')).toBe(true)
  })

  it('유니폼 이름이 렌더러가 찾는 것과 같다', () => {
    for (const name of [
      'u_color', 'u_opacity', 'u_size', 'u_stroke', 'u_radius', 'u_inner', 'u_sweep',
      'u_kind', 'u_points', 'u_matrix',
    ]) {
      if (name === 'u_matrix') continue
      expect(source, name).toContain(`uniform`)
      expect(source, name).toContain(name)
    }
  })
})
