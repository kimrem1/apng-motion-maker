/**
 * 프리셋을 문서에 앉히는 계산부 (motions/apply.ts).
 *
 * 여기서 감시하는 것은 셋이다. 셋 다 "화면에는 멀쩡히 뭔가 나오는" 종류의 결함이라
 * 눈으로는 잡히지 않는다.
 *
 *   1. 권장 fps 가 타임라인에 실제로 반영되는가
 *   2. 속도 슬라이더가 길이를 누적해서 나누지 않는가
 *   3. 호버 미리보기와 확정 적용이 같은 레이어를 만드는가
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { createEmptyProject, createImageLayer, resetIdCounter } from '@/core/factory.ts'
import type { AssetRef, EffectInstance, MotionProject } from '@/core/types.ts'
import { useDocumentStore } from '@/state/document.ts'
import {
  applyPresetToLayer,
  applyPresetWithFps,
  baselineSec,
  withPresetApplied,
} from '@/motions/apply.ts'

function baseDoc(): MotionProject {
  resetIdCounter()
  const doc = createEmptyProject()
  const ref: AssetRef = {
    id: 'a1', name: 'x', storeKey: 'k', naturalW: 400, naturalH: 400, hasAlpha: true,
  }
  doc.assets.push(ref)
  doc.layers.push(createImageLayer(ref, 0))
  return doc
}

let doc: MotionProject
let L = ''

beforeEach(() => {
  doc = baseDoc()
  L = doc.layers[0]!.id
})

const apply = (presetId: string, over: Partial<{ speed: number; strength: number; doc: MotionProject }> = {}) =>
  applyPresetToLayer({
    doc: over.doc ?? doc,
    layerId: L,
    presetId,
    strength: over.strength ?? 0.5,
    speed: over.speed ?? 1,
  })

// ---------------------------------------------------------------------------
// 권장 fps
// ---------------------------------------------------------------------------

describe('권장 fps', () => {
  it('지지직은 권장 fps 를 결과에 실어 보낸다', () => {
    // 이 값이 없으면 용량 통제 3축 중 fps 축이 통째로 빠진다. 글리치는 매 프레임
    // 노이즈가 달라 델타 압축이 0 에 수렴하므로 그 축이 가장 크게 듣는다.
    for (const id of ['glitch.rgbShift', 'glitch.slice', 'glitch.burst', 'glitch.vhs']) {
      expect(apply(id).suggestedFps, id).toBe(20)
    }
  })

  it('fps 를 권장하지 않는 프리셋은 필드를 만들지 않는다', () => {
    expect(apply('zoom.pop').suggestedFps).toBeUndefined()
  })

  it('첫 적용에서만 fps 를 바꾼다', () => {
    const args = { doc, layerId: L, presetId: 'glitch.slice', strength: 0.5, speed: 1 }
    expect(applyPresetWithFps(args, true).suggestedFps).toBe(20)
    // 재적용에서까지 따라가면 사용자가 맞춰 둔 fps 를 프리셋을 누를 때마다 덮는다.
    expect(applyPresetWithFps(args, false).suggestedFps).toBeUndefined()
  })

  it('바뀐 fps 기준으로 다시 계산한다', () => {
    // 폭발은 사건 구간을 80ms 로 잡는다. 25fps 로 재고 20fps 타임라인에 얹으면
    // 사건이 실제보다 길어진다. 두 번 계산하는 이유가 이것이다.
    const args = { doc, layerId: L, presetId: 'glitch.burst', strength: 0.5, speed: 1 }
    const at20 = applyPresetWithFps(args, true)
    const fps20 = { ...doc, timeline: { ...doc.timeline, fps: 20 } }
    const direct = applyPresetToLayer({ ...args, doc: fps20 })
    expect(at20.durationFrames).toBe(direct.durationFrames)
    const rangeOf = (fx: EffectInstance[]): (number | undefined)[] => fx.map((e) => e.range?.[1])
    expect(rangeOf(at20.effects ?? [])).toEqual(rangeOf(direct.effects ?? []))
  })

  it('미리보기 문서의 fps 도 함께 내려간다', () => {
    const result = applyPresetWithFps({ doc, layerId: L, presetId: 'glitch.slice', strength: 0.5, speed: 1 }, true)
    expect(withPresetApplied(doc, L, result).timeline.fps).toBe(20)
    // 재적용이면 현재 fps 를 유지한다.
    delete result.suggestedFps
    expect(withPresetApplied(doc, L, result).timeline.fps).toBe(doc.timeline.fps)
  })
})

// ---------------------------------------------------------------------------
// 속도 슬라이더
// ---------------------------------------------------------------------------

describe('속도 슬라이더가 길이를 누적하지 않는다', () => {
  /** 확정 적용이 하는 일 중 길이와 presetRef 만 흉내 낸다. */
  function commit(next: MotionProject, presetId: string, frames: number, speed: number): MotionProject {
    return {
      ...next,
      timeline: { ...next.timeline, durationFrames: frames },
      presetRef: { id: presetId, macro: { speed, strength: 0.5 }, dirty: false, props: [], effectIds: [] },
    }
  }

  it('같은 프리셋을 여러 번 눌러도 길이가 그대로다', () => {
    const speed = 1.5
    let current = doc
    const first = apply('zoom.slowIn', { speed, doc: current }).durationFrames
    current = commit(current, 'zoom.slowIn', first, speed)

    for (let i = 0; i < 4; i += 1) {
      const again = apply('zoom.slowIn', { speed, doc: current }).durationFrames
      expect(again, `${i + 1}번째 재적용`).toBe(first)
      current = commit(current, 'zoom.slowIn', again, speed)
    }
  })

  it('속도를 바꾸면 그 속도의 길이로 간다. 이전 속도가 곱해지지 않는다', () => {
    const base = apply('zoom.slowIn', { speed: 1 }).durationFrames

    // 속도 2 로 한 번 적용한 뒤
    const fast = apply('zoom.slowIn', { speed: 2 }).durationFrames
    const after = commit(doc, 'zoom.slowIn', fast, 2)

    // 속도 1 로 되돌리면 처음 길이로 돌아와야 한다.
    expect(apply('zoom.slowIn', { speed: 1, doc: after }).durationFrames).toBe(base)
    // 속도 2 를 다시 눌러도 절반에서 멈춘다.
    expect(apply('zoom.slowIn', { speed: 2, doc: after }).durationFrames).toBe(fast)
  })

  it('기준선이 없으면 지금 타임라인에서 초로 읽는다', () => {
    expect(baselineSec(doc)).toBeCloseTo(doc.timeline.durationFrames / doc.timeline.fps, 9)
  })

  it('기준선이 있으면 그 값이 진실이다', () => {
    // 프레임이 아니라 초로 들고 있어야 한다. 프레임은 상한에 잘리면 되돌아오지 않고,
    // fps 가 바뀌면 같은 프레임 수가 다른 시간을 뜻한다.
    const withRef: MotionProject = {
      ...doc,
      timeline: { ...doc.timeline, durationFrames: 120, fps: 10 },
      presetRef: { id: 'zoom.pop', macro: { speed: 0.1, strength: 0.5 }, dirty: false, baseSec: 1.2 },
    }
    expect(baselineSec(withRef)).toBeCloseTo(1.2, 9)
  })
})

// ---------------------------------------------------------------------------
// 미리보기 == 확정 적용
// ---------------------------------------------------------------------------

describe('미리보기와 확정 적용이 같은 레이어를 만든다 (motions/merge.ts)', () => {
  const s = () => useDocumentStore.getState()

  /** 확정 적용 경로를 그대로 태우고 결과 레이어를 돌려준다. */
  function commitToStore(presetId: string): MotionProject {
    const result = applyPresetToLayer({ doc: s().doc, layerId: L, presetId, strength: 0.5, speed: 1 })
    s().applyPresetTracks({
      layerId: L,
      presetId,
      tracks: result.tracks,
      modifiers: result.modifiers,
      ...(result.effects ? { effects: result.effects } : {}),
      durationFrames: result.durationFrames,
      macro: { speed: 1, strength: 0.5 },
    })
    return s().doc
  }

  /** 같은 문서에서 호버 미리보기를 만든다. */
  function preview(from: MotionProject, presetId: string): MotionProject {
    const result = applyPresetToLayer({ doc: from, layerId: L, presetId, strength: 0.5, speed: 1 })
    return withPresetApplied(from, L, result)
  }

  beforeEach(() => {
    s().replaceDocument(baseDoc())
    L = s().doc.layers[0]!.id
  })

  it('이펙트를 정의하지 않는 프리셋을 미리 보면 앞 프리셋의 이펙트가 남지 않는다', () => {
    /*
     * 이것이 갈렸던 자리다. 확정 적용은 presetRef.effectIds 로 앞 프리셋의 이펙트를
     * 걷어내는데 미리보기는 "이펙트를 정의하지 않으면 손대지 않는다" 였다. 그래서
     * 자글자글 다음에 흔들기를 미리 보면 워프가 그대로 남아 있다가, 누르는 순간
     * 사라졌다. 카드에서 본 것과 누른 결과가 다르면 탐색이 의미를 잃는다.
     */
    commitToStore('boil.hand')
    expect(s().doc.layers[0]!.effects.length).toBeGreaterThan(0)

    const previewed = preview(s().doc, 'shake.camera')
    const committed = commitToStore('shake.camera')

    expect(previewed.layers[0]!.effects.map((e) => e.id)).toEqual(
      committed.layers[0]!.effects.map((e) => e.id),
    )
    expect(previewed.layers[0]!.effects).toHaveLength(0)
  })

  it('사용자가 직접 쌓은 이펙트는 미리보기에서도 살아남는다', () => {
    const mine = s().addEffect(L, 'fx.grain', { strength: 0.4 })!
    commitToStore('boil.hand')

    const previewed = preview(s().doc, 'shake.camera')
    expect(previewed.layers[0]!.effects.map((e) => e.id)).toEqual([mine])
  })

  it('앞 프리셋이 만든 트랙도 같은 규칙으로 걷힌다', () => {
    commitToStore('zoom.pop')
    const previewed = preview(s().doc, 'rotate.spin360')
    const committed = commitToStore('rotate.spin360')

    const props = (d: MotionProject): string[] => d.layers[0]!.tracks.map((t) => t.prop).sort()
    expect(props(previewed)).toEqual(props(committed))
  })

  it('사용자가 직접 만든 트랙은 양쪽 모두에서 살아남는다', () => {
    s().setStaticValue(L, 'skewX', 5)
    const previewed = preview(s().doc, 'zoom.pop')
    const committed = commitToStore('zoom.pop')

    const props = (d: MotionProject): string[] => d.layers[0]!.tracks.map((t) => t.prop).sort()
    expect(props(previewed)).toContain('skewX')
    expect(props(previewed)).toEqual(props(committed))
  })

  /*
   * 켠 카드를 다시 눌러 끄는 길.
   *
   * 프리셋을 갈아탈 때와 **정확히 같은 규칙**을 써야 한다. 규칙을 따로 적으면 갈아탈
   * 때는 살아남던 사용자 편집이 끌 때만 사라진다.
   */
  it('해제하면 프리셋이 심은 것만 걷힌다', () => {
    const mine = s().addEffect(L, 'fx.grain', { strength: 0.4 })!
    s().setStaticValue(L, 'skewX', 5)
    commitToStore('boil.hand')
    expect(s().doc.presetRef).toBeDefined()
    expect(s().doc.layers[0]!.effects.length).toBeGreaterThan(1)

    s().clearPreset()

    const layer = s().doc.layers[0]!
    expect(s().doc.presetRef).toBeUndefined()
    // 사용자 것만 남는다.
    expect(layer.effects.map((e) => e.id)).toEqual([mine])
    expect(layer.tracks.map((t) => t.prop)).toContain('skewX')
  })

  it('해제하면 프리셋이 만든 트랙이 사라진다', () => {
    commitToStore('zoom.pop')
    const owned = s().doc.presetRef!.props ?? []
    expect(owned.length).toBeGreaterThan(0)

    s().clearPreset()
    const props = s().doc.layers[0]!.tracks.map((t) => t.prop)
    for (const prop of owned) expect(props).not.toContain(prop)
  })

  it('해제도 실행취소 한 칸이다', () => {
    commitToStore('zoom.pop')
    const before = s().past.length
    s().clearPreset()
    expect(s().past.length).toBe(before + 1)

    s().undo()
    expect(s().doc.presetRef?.id).toBe('zoom.pop')
  })

  it('걸린 프리셋이 없으면 해제가 아무 일도 하지 않는다', () => {
    const before = s().past.length
    s().clearPreset()
    expect(s().past.length).toBe(before)
  })
})

/**
 * 소유권은 **그 프리셋이 얹힌 레이어**에서만 뜻이 있다 (motions/merge.ts ownershipFor).
 *
 * presetRef 는 문서에 하나뿐이라, 레이어 A 에 걸어 둔 프리셋의 소유권 목록으로
 * 레이어 B 를 병합하면 B 에서 사용자가 손으로 만든 것이 말없이 사라진다.
 */
describe('프리셋 소유권과 레이어', () => {
  const s = () => useDocumentStore.getState()

  function twoLayerDoc(): MotionProject {
    const d = baseDoc()
    const ref = d.assets[0]!
    d.layers.push(createImageLayer(ref, 1))
    return d
  }

  function commit(layerId: string, presetId: string): void {
    const result = applyPresetToLayer({ doc: s().doc, layerId, presetId, strength: 0.5, speed: 1 })
    s().applyPresetTracks({
      layerId,
      presetId,
      tracks: result.tracks,
      modifiers: result.modifiers,
      ...(result.effects ? { effects: result.effects } : {}),
      ...(result.anchor ? { anchor: result.anchor } : {}),
      durationFrames: result.durationFrames,
      macro: { speed: 1, strength: 0.5 },
    })
  }

  beforeEach(() => {
    s().replaceDocument(twoLayerDoc())
  })

  it('다른 레이어에 걸린 프리셋의 소유권으로 이 레이어의 수동 트랙을 지우지 않는다', () => {
    const [a, b] = s().doc.layers.map((l) => l.id) as [string, string]

    // A 에 회전 프리셋. presetRef.props 에 rotate 가 남는다.
    commit(a, 'rotate.spin360')
    expect(s().doc.presetRef?.props ?? []).toContain('rotate')
    expect(s().doc.presetRef?.layerId).toBe(a)

    // B 에는 사용자가 직접 회전 키를 찍는다.
    s().toggleAnimated(b, 'rotate', 0)
    s().setValueAtFrame(b, 'rotate', 10, 45)
    expect(s().doc.layers.find((l) => l.id === b)!.tracks.some((t) => t.prop === 'rotate')).toBe(true)

    // B 에 회전을 안 내는 프리셋을 얹는다. B 의 수동 회전은 살아 있어야 한다.
    commit(b, 'zoom.pop')
    const layerB = s().doc.layers.find((l) => l.id === b)!
    expect(layerB.tracks.map((t) => t.prop)).toContain('rotate')
  })

  it('미리보기도 같은 판단을 한다', () => {
    const [a, b] = s().doc.layers.map((l) => l.id) as [string, string]
    commit(a, 'rotate.spin360')
    s().toggleAnimated(b, 'rotate', 0)
    s().setValueAtFrame(b, 'rotate', 10, 45)

    const result = applyPresetToLayer({ doc: s().doc, layerId: b, presetId: 'zoom.pop', strength: 0.5, speed: 1 })
    const previewed = withPresetApplied(s().doc, b, result)
    expect(previewed.layers.find((l) => l.id === b)!.tracks.map((t) => t.prop)).toContain('rotate')
  })

  it('같은 레이어에 다시 얹을 때는 앞 프리셋의 트랙을 그대로 걷어낸다', () => {
    const [a] = s().doc.layers.map((l) => l.id) as [string, string]
    commit(a, 'rotate.spin360')
    commit(a, 'zoom.pop')
    // 소유권이 살아 있으므로 회전은 사라진다. 이 계약까지 깨면 모션이 겹쳐 재생된다.
    expect(s().doc.layers.find((l) => l.id === a)!.tracks.map((t) => t.prop)).not.toContain('rotate')
  })
})
