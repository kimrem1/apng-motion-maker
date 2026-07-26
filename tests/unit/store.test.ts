/**
 * 문서 스토어와 실행취소.
 *
 * 스토어는 지금까지 브라우저에서만 확인해 왔다. undo 스택은 immer 패치로 굴러가고
 * coalesce 병합까지 있어서 회귀가 조용히 들어오기 쉬운 곳이다.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { getTrack, isAnimated, readStaticValue, useDocumentStore } from '@/state/document.ts'
import { createEmptyProject, createImageLayer, resetIdCounter } from '@/core/factory.ts'
import type { AssetRef, MotionProject } from '@/core/types.ts'

function baseDoc(): MotionProject {
  resetIdCounter()
  const d = createEmptyProject()
  const ref: AssetRef = {
    id: 'a1', name: 'x', storeKey: 'k', naturalW: 200, naturalH: 200, hasAlpha: true,
  }
  d.assets.push(ref)
  d.layers.push(createImageLayer(ref, 0))
  return d
}

const s = () => useDocumentStore.getState()

let L = ''

beforeEach(() => {
  const d = baseDoc()
  s().replaceDocument(d)
  L = d.layers[0]!.id
})

describe('실행취소 기본', () => {
  it('한 번의 변경이 한 칸이다', () => {
    expect(s().past).toHaveLength(0)
    s().setLayerFit(L, 'contain')
    expect(s().past).toHaveLength(1)
    s().undo()
    expect(s().doc.layers[0]!.fit).toBe('cover')
    expect(s().past).toHaveLength(0)
    expect(s().future).toHaveLength(1)
  })

  it('값이 그대로면 스택을 먹지 않는다', () => {
    s().setLayerFit(L, 'cover') // 이미 cover 다
    expect(s().past).toHaveLength(0)
  })

  it('redo 가 정확히 되돌린다', () => {
    s().setLayerName(L, 'zzz')
    const after = JSON.stringify(s().doc)
    s().undo()
    s().redo()
    expect(JSON.stringify(s().doc)).toBe(after)
    expect(s().future).toHaveLength(0)
  })

  it('undo 후 새 편집은 future 를 비운다', () => {
    s().setLayerFit(L, 'contain')
    s().undo()
    expect(s().future).toHaveLength(1)
    s().setLayerFit(L, 'fill')
    expect(s().future).toHaveLength(0)
  })
})

describe('coalesce 병합', () => {
  it('같은 키의 연속 편집이 한 칸으로 합쳐진다', () => {
    s().setValueAtFrame(L, 'translateX', 0, 0)
    s().clearHistory()
    const snap = JSON.stringify(s().doc)

    // 드래그처럼 같은 프레임을 연속으로 고친다
    s().setValueAtFrame(L, 'translateX', 10, 5)
    s().setValueAtFrame(L, 'translateX', 10, 15)
    s().setValueAtFrame(L, 'translateX', 10, 25)
    expect(s().past).toHaveLength(1)

    // 병합된 커맨드 하나를 되돌리면 처음 상태로 정확히 돌아가야 한다
    s().undo()
    expect(JSON.stringify(s().doc)).toBe(snap)
  })

  it('병합된 커맨드를 redo 하면 마지막 값이 나온다', () => {
    s().setValueAtFrame(L, 'translateX', 0, 0)
    s().clearHistory()
    s().setValueAtFrame(L, 'translateX', 10, 5)
    s().setValueAtFrame(L, 'translateX', 10, 25)
    s().undo()
    s().redo()
    const keys = getTrack(s().doc.layers[0]!, 'translateX')!.keys
    expect(keys.find((k) => k.f === 10)?.v).toBe(25)
  })

  it('키프레임 드래그 전체가 한 칸이다', () => {
    s().setValueAtFrame(L, 'translateX', 0, 0)
    s().setValueAtFrame(L, 'translateX', 30, 100)
    s().clearHistory()
    const before = getTrack(s().doc.layers[0]!, 'translateX')!.keys.map((k) => k.f)

    // 30 -> 40 을 한 프레임씩 끈다
    for (let f = 30; f < 40; f += 1) s().moveKeyframe(L, 'translateX', f, f + 1)
    expect(s().past).toHaveLength(1)

    s().undo()
    expect(getTrack(s().doc.layers[0]!, 'translateX')!.keys.map((k) => k.f)).toEqual(before)
  })

  it('다른 키는 합쳐지지 않는다', () => {
    s().clearHistory()
    s().setValueAtFrame(L, 'translateX', 10, 10)
    s().setValueAtFrame(L, 'translateY', 10, 10)
    expect(s().past).toHaveLength(2)
  })
})

describe('애니메이션 상태', () => {
  it('스톱워치를 켜면 키가 하나여도 애니메이션이다', () => {
    // 이걸 키 개수로만 판정하면 스톱워치가 아무 일도 하지 않는다
    s().toggleAnimated(L, 'scale', 0)
    const layer = s().doc.layers[0]!
    expect(getTrack(layer, 'scale')!.keys).toHaveLength(1)
    expect(isAnimated(layer, 'scale')).toBe(true)
  })

  it('켠 뒤 다른 프레임에서 값을 바꾸면 키가 생긴다', () => {
    s().toggleAnimated(L, 'scale', 0)
    const layer = s().doc.layers[0]!
    if (isAnimated(layer, 'scale')) s().setValueAtFrame(L, 'scale', 12, 1.5)
    else s().setStaticValue(L, 'scale', 1.5)

    const keys = getTrack(s().doc.layers[0]!, 'scale')!.keys
    expect(keys).toHaveLength(2)
    expect(keys.map((k) => k.f)).toEqual([0, 12])
  })

  it('끄면 현재 프레임 값으로 굳는다', () => {
    s().setValueAtFrame(L, 'rotate', 0, 0)
    s().setValueAtFrame(L, 'rotate', 20, 100)
    const mid = readStaticValue(s().doc.layers[0]!, 'rotate', 10)

    s().toggleAnimated(L, 'rotate', 10)
    const track = getTrack(s().doc.layers[0]!, 'rotate')!
    expect(track.keys).toHaveLength(1)
    expect(track.keys[0]!.v).toBeCloseTo(mid, 6)
    expect(isAnimated(s().doc.layers[0]!, 'rotate')).toBe(false)
  })
})

describe('키프레임 편집', () => {
  it('같은 프레임으로는 옮기지 않는다', () => {
    s().setValueAtFrame(L, 'translateX', 0, 0)
    s().setValueAtFrame(L, 'translateX', 10, 50)
    s().moveKeyframe(L, 'translateX', 0, 10)
    // 충돌하면 무시된다. 두 키가 같은 프레임에 있으면 평가가 0 나눗셈을 만난다.
    expect(getTrack(s().doc.layers[0]!, 'translateX')!.keys.map((k) => k.f)).toEqual([0, 10])
  })

  it('마지막 키는 지우지 않는다', () => {
    s().setValueAtFrame(L, 'translateX', 5, 1)
    s().removeKeyframe(L, 'translateX', 5)
    expect(getTrack(s().doc.layers[0]!, 'translateX')!.keys).toHaveLength(1)
  })

  it('이징 프리셋 id 가 키에 남는다', () => {
    s().setValueAtFrame(L, 'scale', 0, 1)
    s().setValueAtFrame(L, 'scale', 20, 2)
    s().setKeyframeEasing(L, 'scale', 0, 'easeOutBounce')
    expect(getTrack(s().doc.layers[0]!, 'scale')!.keys[0]!.easingPreset).toBe('easeOutBounce')
  })

  it('핸들을 직접 만지면 프리셋 표시가 풀린다', () => {
    s().setValueAtFrame(L, 'scale', 0, 1)
    s().setValueAtFrame(L, 'scale', 20, 2)
    s().setKeyframeEasing(L, 'scale', 0, 'easeOutBounce')
    s().setKeyframeHandles(L, 'scale', 0, { out: { x: 0.5, y: 0.5 } })
    const key = getTrack(s().doc.layers[0]!, 'scale')!.keys[0]!
    expect(key.easingPreset).toBeUndefined()
    expect(key.out).toEqual({ x: 0.5, y: 0.5 })
  })
})

describe('레이어 관계', () => {
  it('순환 부모 지정을 막는다', () => {
    const ref = s().doc.assets[0]!
    const b = createImageLayer(ref, 1)
    s().replaceDocument({ ...s().doc, layers: [...s().doc.layers, b] })

    s().setLayerParent(b.id, L)
    expect(s().doc.layers.find((l) => l.id === b.id)!.parentId).toBe(L)

    // L 의 부모를 b 로 두면 순환이다
    s().setLayerParent(L, b.id)
    expect(s().doc.layers.find((l) => l.id === L)!.parentId).toBeNull()
  })

  it('자기 자신을 부모로 두지 않는다', () => {
    s().setLayerParent(L, L)
    expect(s().doc.layers[0]!.parentId).toBeNull()
  })

  it('깊이감은 0~3 으로 클램프된다', () => {
    s().setLayerParallax(L, 99)
    expect(s().doc.layers[0]!.parallaxFactor).toBe(3)
    s().setLayerParallax(L, -5)
    expect(s().doc.layers[0]!.parallaxFactor).toBe(0)
  })
})

describe('이펙트', () => {
  it('추가하면 시드가 0 이 아니다', () => {
    const id = s().addEffect(L, 'glitch.rgbShift', { amount: 6 })
    expect(id).toBeTruthy()
    const fx = s().doc.layers[0]!.effects[0]!
    expect(fx.seed).toBeGreaterThan(0)
    expect(fx.enabled).toBe(true)
    expect(fx.params.amount).toBe(6)
  })

  it('같은 조작이 같은 시드를 만든다 (결정론)', () => {
    const first = s().addEffect(L, 'glitch.slice', {})
    const seedA = s().doc.layers[0]!.effects[0]!.seed
    s().removeEffect(L, first!)

    const d = baseDoc()
    s().replaceDocument(d)
    s().addEffect(d.layers[0]!.id, 'glitch.slice', {})
    const seedB = s().doc.layers[0]!.effects[0]!.seed
    expect(seedB).toBe(seedA)
  })

  it('NaN 파라미터는 무시한다', () => {
    const id = s().addEffect(L, 'fx.grain', { strength: 0.5 })!
    s().setEffectParam(L, id, 'strength', Number.NaN)
    expect(s().doc.layers[0]!.effects[0]!.params.strength).toBe(0.5)
  })

  it('순서를 바꾼다', () => {
    const a = s().addEffect(L, 'fx.grain', {})!
    s().addEffect(L, 'fx.vignette', {})
    s().reorderEffect(L, a, 1)
    expect(s().doc.layers[0]!.effects.map((e) => e.type)).toEqual(['fx.vignette', 'fx.grain'])
  })

  it('홀드 프레임은 1~12 로 클램프된다', () => {
    const id = s().addEffect(L, 'boil.warp', {})!
    s().setEffectHold(L, id, 0)
    expect(s().doc.layers[0]!.effects[0]!.holdFrames).toBe(1)
    s().setEffectHold(L, id, 99)
    expect(s().doc.layers[0]!.effects[0]!.holdFrames).toBe(12)
  })
})

describe('프리셋 적용', () => {
  it('한 번 적용이 한 칸이고 presetRef 가 남는다', () => {
    s().clearHistory()
    s().applyPresetTracks({
      layerId: L,
      presetId: 'zoom.pop',
      tracks: [
        { id: '', prop: 'scale', unit: 'ratio', keys: [
          { f: 0, v: 0.86, interp: 'bezier' },
          { f: 12, v: 1, interp: 'bezier' },
        ] },
      ],
      modifiers: [],
      macro: { speed: 1, strength: 0.5 },
    })
    expect(s().past).toHaveLength(1)
    expect(s().doc.presetRef?.id).toBe('zoom.pop')
    expect(s().doc.presetRef?.props).toEqual(['scale'])
  })

  it('다음 프리셋이 이전 프리셋의 트랙을 걷어낸다', () => {
    s().applyPresetTracks({
      layerId: L, presetId: 'zoom.pop',
      tracks: [
        { id: '', prop: 'scale', unit: 'ratio', keys: [{ f: 0, v: 1, interp: 'bezier' }] },
        { id: '', prop: 'opacity', unit: 'ratio', keys: [{ f: 0, v: 1, interp: 'bezier' }] },
      ],
      modifiers: [], macro: { speed: 1, strength: 0.5 },
    })
    s().applyPresetTracks({
      layerId: L, presetId: 'rotate.spin360',
      tracks: [{ id: '', prop: 'rotate', unit: 'deg', keys: [{ f: 0, v: 0, interp: 'linear' }] }],
      modifiers: [], macro: { speed: 1, strength: 0.5 },
    })
    // 크기와 투명도가 남으면 두 모션이 겹쳐 재생된다
    expect(s().doc.layers[0]!.tracks.map((t) => t.prop)).toEqual(['rotate'])
  })

  it('사용자가 직접 만든 트랙은 살아남는다', () => {
    s().setStaticValue(L, 'skewX', 5)
    s().applyPresetTracks({
      layerId: L, presetId: 'zoom.pop',
      tracks: [{ id: '', prop: 'scale', unit: 'ratio', keys: [{ f: 0, v: 1, interp: 'bezier' }] }],
      modifiers: [], macro: { speed: 1, strength: 0.5 },
    })
    expect(s().doc.layers[0]!.tracks.map((t) => t.prop).sort()).toEqual(['scale', 'skewX'])
  })
})

describe('프리셋 이펙트 소유권', () => {
  const fx = (id: string, type: string) => ({
    id, type, enabled: true, seed: 1, holdFrames: 1, requiresHistory: false, params: {},
  })

  it('다음 프리셋이 이전 프리셋의 이펙트를 걷어낸다', () => {
    s().applyPresetTracks({
      layerId: L, presetId: 'boil.hand', tracks: [], modifiers: [],
      effects: [fx('x1', 'boil.warp')], macro: { speed: 1, strength: 0.5 },
    })
    expect(s().doc.layers[0]!.effects.map((e) => e.type)).toEqual(['boil.warp'])

    // 흔들기는 이펙트를 정의하지 않는다(undefined). 앞의 워프가 남으면 안 된다.
    s().applyPresetTracks({
      layerId: L, presetId: 'shake.camera', tracks: [], modifiers: [],
      macro: { speed: 1, strength: 0.5 },
    })
    expect(s().doc.layers[0]!.effects).toHaveLength(0)
  })

  it('사용자가 직접 추가한 이펙트는 살아남는다', () => {
    const mine = s().addEffect(L, 'fx.grain', { strength: 0.4 })!
    s().applyPresetTracks({
      layerId: L, presetId: 'glitch.slice', tracks: [], modifiers: [],
      effects: [fx('p1', 'glitch.slice')], macro: { speed: 1, strength: 0.5 },
    })
    expect(s().doc.layers[0]!.effects.map((e) => e.type).sort()).toEqual(['fx.grain', 'glitch.slice'])

    s().applyPresetTracks({
      layerId: L, presetId: 'shake.camera', tracks: [], modifiers: [],
      macro: { speed: 1, strength: 0.5 },
    })
    const left = s().doc.layers[0]!.effects
    expect(left).toHaveLength(1)
    expect(left[0]!.id).toBe(mine)
  })

  it('presetRef 에 소유한 이펙트 id 가 남는다', () => {
    s().applyPresetTracks({
      layerId: L, presetId: 'glitch.vhs', tracks: [], modifiers: [],
      effects: [fx('v1', 'glitch.rgbShift'), fx('v2', 'fx.scanline')],
      macro: { speed: 1, strength: 0.5 },
    })
    expect(s().doc.presetRef?.effectIds).toEqual(['v1', 'v2'])
  })
})
