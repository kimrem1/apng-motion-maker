/**
 * 속도 노브.
 *
 * 이 파일이 지키는 것은 다섯 가지다.
 *   1. 속도를 내리면 실제로 길어진다. 어느 지점부터 멈추지 않는다.
 *   2. 속도를 왕복하면 원래 길이로 돌아온다.
 *   3. 자동으로 고르는 fps 는 올라가지 않고, GIF 에서 정확한 값만 쓴다.
 *   4. 슬라이더 눈금 변환이 왕복해도 같은 값이다.
 *   5. **레이어 배수는 전체 길이와 초당 프레임을 건드리지 않는다.** 위의 넷은 전부
 *      전역 속도 노브의 계약이고, 이쪽은 그 반대편이다. 오브제 하나만 빠르게 하려고
 *      전역 노브를 끌면 화면의 모든 것이 함께 빨라지고 프레임 수까지 줄어든다.
 *
 * 1번과 2번은 실제로 깨져 있었다. 속도 클램프가 일곱 군데에 흩어져 있어 0.5 아래가
 * 통째로 무시됐고(56종 전부 x0.5 와 x0.05 가 같은 결과), 기준선을 프레임으로 되짚어
 * 왕복마다 길이가 줄었다.
 */

import { describe, expect, it } from 'vitest'

import { createEmptyProject, createImageLayer, resetIdCounter } from '@/core/factory.ts'
import {
  FRAMES_MAX,
  GIF_EXACT_FPS,
  MOTION_REPEAT_MAX,
  SPEED_MAX,
  SPEED_MIN,
  type AssetRef,
} from '@/core/types.ts'
import { effectiveRepeat, resolveLayerTransform } from '@/core/evaluate.ts'
import { MOTION_PRESETS } from '@/motions/registry.ts'
import { baselineFps, baselineSec, fpsForDuration } from '@/motions/apply.ts'
import { useDocumentStore } from '@/state/document.ts'
import { usePresetUiStore } from '@/state/presetUi.ts'
import { useUiStore } from '@/state/ui.ts'
import { applyPresetToDocument, commitMacroNow, reapplyAppliedPresetSoon } from '@/state/presetActions.ts'
import { SPEED_STEP, pFromSpeed, speedFromP, speedFromPSnapped } from '@/state/speedScale.ts'

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
  return {
    frames: d.timeline.durationFrames,
    fps: d.timeline.fps,
    sec: d.timeline.durationFrames / d.timeline.fps,
  }
}

describe('속도 눈금 변환', () => {
  it('왕복하면 같은 값이다', () => {
    for (const s of [SPEED_MIN, 0.2, 0.5, 1, 1.5, SPEED_MAX]) {
      expect(speedFromP(pFromSpeed(s))).toBeCloseTo(s, 9)
    }
  })

  it('양 끝과 보통 지점이 제자리에 있다', () => {
    expect(speedFromP(0)).toBeCloseTo(SPEED_MIN, 9)
    expect(speedFromP(1)).toBeCloseTo(SPEED_MAX, 9)
    // 느린 쪽이 트랙의 대부분을 차지해야 미세 조정이 된다.
    expect(pFromSpeed(1)).toBeGreaterThan(0.7)
  })

  it('한 칸은 어디서든 같은 비율이다', () => {
    // 로그 눈금의 목적이 이것이다. 선형이면 느린 쪽 한 칸이 빠른 쪽의 스무 배가 된다.
    const lo = speedFromP(SPEED_STEP) / speedFromP(0)
    const hi = speedFromP(1) / speedFromP(1 - SPEED_STEP)
    expect(lo).toBeCloseTo(hi, 6)
  })

  it('범위 밖 입력을 잘라 낸다', () => {
    expect(speedFromP(-1)).toBeCloseTo(SPEED_MIN, 9)
    expect(speedFromP(2)).toBeCloseTo(SPEED_MAX, 9)
    expect(pFromSpeed(0)).toBeCloseTo(pFromSpeed(1), 9)
    expect(pFromSpeed(Number.NaN)).toBeCloseTo(pFromSpeed(1), 9)
  })

  /**
   * 1배는 눈금 위의 정확한 자리가 아니다(p = 0.7686...). 손잡이를 가운데 둬도
   * 0.974 나 1.02 에서 멈춘다. "1배면 길이를 안 건드린다" 를 1 로 판정하는 쪽에서는
   * 그 몇 퍼센트가 규칙을 못 걸리게 한다 (도형 세트, shapes/shared.ts timingOf).
   */
  it('1배 자리에 걸림쇠가 있다', () => {
    const center = pFromSpeed(1)
    for (const p of [center, center - SPEED_STEP, center + SPEED_STEP]) {
      expect(speedFromPSnapped(p)).toBe(1)
    }
    // 걸림쇠는 한 칸 안쪽에서만 동작한다. 그 밖에서는 눈금 그대로다.
    for (const p of [0, 0.5, center - SPEED_STEP * 3, center + SPEED_STEP * 3, 1]) {
      expect(speedFromPSnapped(p)).toBeCloseTo(speedFromP(p), 9)
    }
  })
})

describe('fps 자동 선택', () => {
  it('GIF 에서 정확한 값만 고른다', () => {
    // 12 / 15 / 24 / 30 은 100/N 이 정수가 아니라 재생 속도가 조용히 어긋난다.
    for (const sec of [0.5, 1.2, 3, 6, 9, 12]) {
      expect(GIF_EXACT_FPS as readonly number[]).toContain(fpsForDuration(sec, 50))
    }
  })

  it('천장을 넘지 않는다', () => {
    // "느리게" 를 요구했는데 fps 가 오르면 프레임 수와 파일 크기가 두 배가 된다.
    expect(fpsForDuration(0.5, 25)).toBeLessThanOrEqual(25)
    expect(fpsForDuration(0.1, 20)).toBeLessThanOrEqual(20)
    expect(fpsForDuration(1, 10)).toBeLessThanOrEqual(10)
  })

  it('프레임 상한 안에 담기는 가장 높은 값을 고른다', () => {
    // 25fps 로 4.8초가 정확히 120프레임이다. 그보다 길면 내려가야 한다.
    expect(fpsForDuration(4.8, 50)).toBe(25)
    expect(fpsForDuration(6, 50)).toBe(20)
    expect(fpsForDuration(9.6, 50)).toBe(12.5)
    expect(fpsForDuration(12, 50)).toBe(10)
  })

  it('어느 값으로도 안 담기면 가장 낮은 fps 로 버틴다', () => {
    // 12초가 이 제품의 상한이다. 그 위는 프레임 상한에서 잘린다.
    expect(fpsForDuration(30, 25)).toBe(10)
  })

  it('지금 fps 로 담기면 비정확 fps 라도 그대로 둔다', () => {
    // 24/30 은 GIF 정확값이 아니지만 사용자가 고른 값이다. 담기는데도 강등하면
    // 속도 1 로 프리셋을 적용하기만 해도 fps 가 소리 없이 바뀐다.
    expect(fpsForDuration(1.2, 30)).toBe(30)
    expect(fpsForDuration(2, 24)).toBe(24)
    expect(fpsForDuration(4, 15)).toBe(15)
    // 안 담기면 여전히 정확 사다리로 내려간다.
    expect(fpsForDuration(6, 30)).toBe(20)
  })

  it('30fps 문서에 속도 1 프리셋을 적용해도 fps 가 유지된다', () => {
    reset()
    useDocumentStore.getState().setFps(30)
    const r = applyAt('zoom.pop', 1)
    expect(r.fps).toBe(30)
  })
})

describe('기준선', () => {
  it('없으면 지금 타임라인에서 초로 읽는다', () => {
    reset()
    const doc = useDocumentStore.getState().doc
    expect(baselineSec(doc)).toBeCloseTo(doc.timeline.durationFrames / doc.timeline.fps, 9)
    expect(baselineFps(doc)).toBe(doc.timeline.fps)
  })

  it('적용하면 문서에 초와 fps 가 함께 남는다', () => {
    reset()
    applyAt('zoom.slowIn', 1)
    const ref = useDocumentStore.getState().doc.presetRef
    expect(ref?.baseSec).toBeGreaterThan(0)
    expect(ref?.baseFps).toBeGreaterThan(0)
  })

  it('속도를 바꿔도 기준선은 그대로다', () => {
    reset()
    applyAt('zoom.slowIn', 1)
    const first = useDocumentStore.getState().doc.presetRef?.baseSec
    applyAt('zoom.slowIn', 0.2)
    expect(useDocumentStore.getState().doc.presetRef?.baseSec).toBeCloseTo(first!, 9)
  })
})

describe('속도가 실제로 길이를 바꾼다', () => {
  for (const id of ['zoom.slowIn', 'slide.panLR', 'fade.in', 'shake.camera', 'glitch.slice']) {
    it(`${id} 는 느리게 할수록 길어진다`, () => {
      reset(); const fast = applyAt(id, 2).sec
      reset(); const normal = applyAt(id, 1).sec
      reset(); const slow = applyAt(id, 0.5).sec
      reset(); const slowest = applyAt(id, SPEED_MIN).sec

      expect(normal).toBeGreaterThan(fast)
      expect(slow).toBeGreaterThan(normal)
      // 예전에는 0.5 아래가 통째로 무시돼 여기서 같은 값이 나왔다.
      expect(slowest).toBeGreaterThan(slow)
    })
  }

  it('가장 느린 설정은 예전 최대치보다 훨씬 길다', () => {
    // 고치기 전에는 어떤 프리셋도 2.4초를 넘지 못했다.
    let longest = 0
    for (const p of MOTION_PRESETS) {
      reset()
      longest = Math.max(longest, applyAt(p.id, SPEED_MIN).sec)
    }
    expect(longest).toBeGreaterThan(10)
  })

  it('프레임 상한을 절대 넘지 않는다', () => {
    for (const p of MOTION_PRESETS) {
      reset()
      expect(applyAt(p.id, SPEED_MIN).frames).toBeLessThanOrEqual(FRAMES_MAX)
    }
  })
})

describe('속도 왕복', () => {
  it('56종 전부 원래 길이로 돌아온다', () => {
    // 기준선을 프레임으로 되짚으면 여기서 무너진다. 상한에 잘린 프레임은 곱셈으로
    // 되돌아오지 않고, fps 가 내려간 뒤에는 같은 프레임 수가 다른 시간을 뜻한다.
    const drifted: string[] = []
    for (const p of MOTION_PRESETS) {
      reset()
      const start = applyAt(p.id, 1).sec
      applyAt(p.id, SPEED_MIN)
      applyAt(p.id, SPEED_MAX)
      applyAt(p.id, 0.25)
      const end = applyAt(p.id, 1).sec
      if (Math.abs(start - end) > 1e-6) drifted.push(`${p.id} ${start.toFixed(3)} -> ${end.toFixed(3)}`)
    }
    expect(drifted).toEqual([])
  })

  it('같은 속도를 여러 번 눌러도 길이가 흘러가지 않는다', () => {
    reset()
    const once = applyAt('zoom.slowIn', 0.3).sec
    applyAt('zoom.slowIn', 0.3)
    expect(applyAt('zoom.slowIn', 0.3).sec).toBeCloseTo(once, 9)
  })
})

/**
 * 프리셋을 갈아탈 때의 기준선.
 *
 * 기준선(presetRef.baseSec)은 **그 프리셋의 것일 때만** 재사용해야 한다. id 를 안 보면
 * 한 문서에서 처음 누른 카드 하나가 이후 모든 프리셋의 길이를 지배하고,
 * MotionPreset.defaultDurationMs 가 문서당 한 번만 읽힌다.
 */
describe('프리셋 교체와 기준선', () => {
  it('다른 프리셋을 고르면 그 프리셋의 권장 길이를 쓴다', () => {
    reset()
    const slow = applyAt('kb.classic', 1)
    const pop = applyAt('zoom.pop', 1)

    const slowMs = MOTION_PRESETS.find((p) => p.id === 'kb.classic')?.defaultDurationMs ?? 0
    const popMs = MOTION_PRESETS.find((p) => p.id === 'zoom.pop')?.defaultDurationMs ?? 0
    expect(slowMs).toBeGreaterThan(popMs)

    // 앞 카드의 길이가 그대로 물려지면 두 값이 같아진다.
    expect(pop.sec).toBeLessThan(slow.sec)
    expect(pop.sec).toBeCloseTo(popMs / 1000, 1)
  })

  it('같은 프리셋을 다시 누르면 길이가 그대로다', () => {
    reset()
    const first = applyAt('zoom.pop', 1).frames
    expect(applyAt('zoom.pop', 1).frames).toBe(first)
  })

  it('손으로 넣은 길이를 세기 슬라이더가 되돌리지 않는다', () => {
    reset()
    applyAt('zoom.slowIn', 1)
    useDocumentStore.getState().setDurationFrames(90)
    expect(useDocumentStore.getState().doc.timeline.durationFrames).toBe(90)

    // 길이와 무관한 세기 노브만 움직여 재적용한다.
    usePresetUiStore.getState().setStrength(0.55)
    applyPresetToDocument('zoom.slowIn')

    // 홀드 스냅으로 한두 프레임은 움직일 수 있다. 옛 기준선(75)으로 돌아가면 실패다.
    expect(useDocumentStore.getState().doc.timeline.durationFrames).toBeGreaterThan(85)
  })
})

/**
 * 재적용은 **프리셋이 실제로 얹힌 레이어에만** 한다.
 *
 * presetUi.appliedId 는 화면 상태라 문서와 따로 논다. Ctrl+Z 로 적용을 되감거나
 * 다른 프로젝트를 열면 doc.presetRef 만 사라지고 appliedId 는 남는다. 그 상태에서
 * 가드가 전부 `?.` 로 통과해, 슬라이더를 스치는 것만으로 앞 문서의 모션이 지금
 * 고른 레이어에 심겼다.
 */
describe('재적용 대상 가드', () => {
  const s = () => useDocumentStore.getState()

  it('실행취소로 프리셋이 사라지면 슬라이더가 아무 일도 하지 않는다', () => {
    reset()
    applyAt('zoom.pop', 1)
    expect(s().doc.presetRef).toBeDefined()
    expect(usePresetUiStore.getState().appliedId).toBe('zoom.pop')

    s().undo()
    expect(s().doc.presetRef).toBeUndefined()
    // 화면 상태는 그대로 남는다. 이것이 이 버그의 전제다.
    expect(usePresetUiStore.getState().appliedId).toBe('zoom.pop')

    const layersBefore = JSON.stringify(s().doc.layers)
    const pastBefore = s().past.length
    usePresetUiStore.getState().setSpeed(0.4)
    reapplyAppliedPresetSoon()
    expect(commitMacroNow()).toBeNull()
    expect(JSON.stringify(s().doc.layers)).toBe(layersBefore)
    expect(s().past.length).toBe(pastBefore)
  })

  it('다른 문서를 열어도 앞 문서의 프리셋이 따라오지 않는다', () => {
    reset()
    applyAt('slide.left', 1)
    expect(usePresetUiStore.getState().appliedId).toBe('slide.left')

    // presetRef 가 없는 새 문서. 옛 화면 상태만 남아 있다.
    const fresh = createEmptyProject()
    const asset: AssetRef = {
      id: 'b1', name: 'q.png', storeKey: 'n', naturalW: 100, naturalH: 100, hasAlpha: true,
    }
    fresh.assets.push(asset)
    fresh.layers.push(createImageLayer(asset, 0))
    s().replaceDocument(fresh)
    useUiStore.setState({ selectedLayerId: s().doc.layers[0]!.id })

    const before = JSON.stringify(s().doc.layers)
    usePresetUiStore.getState().setStrength(0.9)
    reapplyAppliedPresetSoon()
    expect(commitMacroNow()).toBeNull()
    expect(JSON.stringify(s().doc.layers)).toBe(before)
  })
})

describe('레이어별 모션 배수', () => {
  const s = () => useDocumentStore.getState()

  /** 배수를 건 레이어와 안 건 레이어를 한 문서에 둔다. */
  function twoLayers(): { fast: string; plain: string } {
    reset()
    const doc = s().doc
    const asset: AssetRef = {
      id: 'a2', name: 'q.png', storeKey: 'n', naturalW: SIZE, naturalH: SIZE, hasAlpha: true,
    }
    s().replaceDocument({
      ...doc,
      assets: [...doc.assets, asset],
      layers: [...doc.layers, createImageLayer(asset, 1)],
    })
    return { fast: s().doc.layers[0]!.id, plain: s().doc.layers[1]!.id }
  }

  it('배수를 걸어도 전체 길이와 초당 프레임이 그대로다', () => {
    const { fast } = twoLayers()
    applyAt('zoom.pulse', 1)
    const frames = s().doc.timeline.durationFrames
    const fps = s().doc.timeline.fps

    s().setLayerMotionRepeat(fast, 4)

    expect(s().doc.timeline.durationFrames).toBe(frames)
    expect(s().doc.timeline.fps).toBe(fps)
  })

  it('배수를 걸어도 다른 레이어의 트랙은 한 글자도 안 바뀐다', () => {
    const { fast, plain } = twoLayers()
    applyAt('zoom.pulse', 1)
    const before = JSON.stringify(s().doc.layers.find((l) => l.id === plain))

    s().setLayerMotionRepeat(fast, 3)

    expect(JSON.stringify(s().doc.layers.find((l) => l.id === plain))).toBe(before)
  })

  it('배수를 걸어도 자기 트랙의 키프레임은 그대로다', () => {
    const { fast } = twoLayers()
    applyAt('zoom.pulse', 1)
    const before = JSON.stringify(s().doc.layers.find((l) => l.id === fast)!.tracks)

    s().setLayerMotionRepeat(fast, 3)

    // 굽지 않고 값으로만 들고 있다. 그래서 1 로 되돌리는 것이 곧 원상복구다.
    expect(JSON.stringify(s().doc.layers.find((l) => l.id === fast)!.tracks)).toBe(before)
  })

  it('한 문서 길이 안에서 배수만큼 돈다', () => {
    const { fast } = twoLayers()
    applyAt('zoom.pulse', 1)
    s().setLayerMotionRepeat(fast, 2)

    const doc = s().doc
    const layer = doc.layers.find((l) => l.id === fast)!
    const total = doc.timeline.durationFrames
    const canvas = doc.canvas

    // 트랙이 없으면 아래 비교가 항상 참이라 아무것도 안 지킨다.
    expect(layer.tracks.length).toBeGreaterThan(0)
    // 실제로 움직이는 프리셋인지도 확인한다.
    expect(resolveLayerTransform(layer, 0, canvas, total).scaleX).not.toBeCloseTo(
      resolveLayerTransform(layer, Math.round(total / 4), canvas, total).scaleX,
      6,
    )

    // 주기 하나가 total/2 다. 그래서 f 와 f + total/2 의 그림이 같아야 한다.
    for (const f of [0, 1, 3, 5]) {
      const a = resolveLayerTransform(layer, f, canvas, total)
      const b = resolveLayerTransform(layer, f + total / 2, canvas, total)
      expect(b.scaleX).toBeCloseTo(a.scaleX, 6)
      expect(b.translateY).toBeCloseTo(a.translateY, 6)
    }
  })

  it('배수 1 은 배수를 안 건 것과 완전히 같다', () => {
    const { fast } = twoLayers()
    applyAt('zoom.pulse', 1)
    const doc = s().doc
    const layer = doc.layers.find((l) => l.id === fast)!
    const total = doc.timeline.durationFrames

    s().setLayerMotionRepeat(fast, 1)
    const after = s().doc.layers.find((l) => l.id === fast)!

    for (let f = 0; f <= total; f += 1) {
      expect(JSON.stringify(resolveLayerTransform(after, f, doc.canvas, total))).toBe(
        JSON.stringify(resolveLayerTransform(layer, f, doc.canvas, total)),
      )
    }
  })

  it('반복 지점에서 값이 이어진다', () => {
    const { fast } = twoLayers()
    applyAt('shake.wobble', 1)
    s().setLayerMotionRepeat(fast, 3)

    const doc = s().doc
    const layer = doc.layers.find((l) => l.id === fast)!
    const total = doc.timeline.durationFrames

    // 재생기는 frame % durationFrames 로 감는다 (core/time.ts). 그래서 심리스의
    // 조건은 프레임 total 의 그림이 프레임 0 과 같다는 것이다. 정수 배수만 허용하는
    // 이유가 이것이다. 배수가 정수가 아니면 마지막 주기가 잘려 여기서 값이 튄다.
    const head = resolveLayerTransform(layer, 0, doc.canvas, total)
    const tail = resolveLayerTransform(layer, total, doc.canvas, total)
    expect(tail.scaleX).toBeCloseTo(head.scaleX, 6)
    expect(tail.translateX).toBeCloseTo(head.translateX, 6)
    expect(tail.translateY).toBeCloseTo(head.translateY, 6)
    expect(tail.rotate).toBeCloseTo(head.rotate, 6)
  })

  it('배수를 걸어도 홀드 클럭은 문서 시간에 남는다', () => {
    // 홀드를 배수에 태우면 자글자글의 "2컷, 3컷" 이 배수를 따라 잘아지고,
    // durationFrames % hold 로 판정하는 홀드 정렬 검사가 거짓이 된다.
    const { fast } = twoLayers()
    applyAt('boil.fine', 1)
    const before = s().doc.layers.find((l) => l.id === fast)!.modifiers.map((m) => m.holdFrames)
    s().setLayerMotionRepeat(fast, 4)
    const after = s().doc.layers.find((l) => l.id === fast)!.modifiers.map((m) => m.holdFrames)
    expect(after).toEqual(before)
  })

  it('한 바퀴가 두 프레임 아래로 내려가지 않는다', () => {
    const { fast } = twoLayers()
    applyAt('zoom.pulse', 1)
    s().setDurationFrames(6)
    s().setLayerMotionRepeat(fast, MOTION_REPEAT_MAX)

    // 6프레임이면 최대 3배다. 문서에는 고른 값이 남고 실제로 도는 값만 조인다.
    const layer = s().doc.layers.find((l) => l.id === fast)!
    expect(layer.motionRepeat).toBe(MOTION_REPEAT_MAX)
    expect(effectiveRepeat(layer, 6)).toBe(3)
  })
})
