/**
 * 속도 노브.
 *
 * 이 파일이 지키는 것은 네 가지다.
 *   1. 속도를 내리면 실제로 길어진다. 어느 지점부터 멈추지 않는다.
 *   2. 속도를 왕복하면 원래 길이로 돌아온다.
 *   3. 자동으로 고르는 fps 는 올라가지 않고, GIF 에서 정확한 값만 쓴다.
 *   4. 슬라이더 눈금 변환이 왕복해도 같은 값이다.
 *
 * 1번과 2번은 실제로 깨져 있었다. 속도 클램프가 일곱 군데에 흩어져 있어 0.5 아래가
 * 통째로 무시됐고(56종 전부 x0.5 와 x0.05 가 같은 결과), 기준선을 프레임으로 되짚어
 * 왕복마다 길이가 줄었다.
 */

import { describe, expect, it } from 'vitest'

import { createEmptyProject, createImageLayer, resetIdCounter } from '@/core/factory.ts'
import { FRAMES_MAX, GIF_EXACT_FPS, SPEED_MAX, SPEED_MIN, type AssetRef } from '@/core/types.ts'
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
