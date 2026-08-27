/**
 * 문서 스토어와 실행취소.
 *
 * 스토어는 지금까지 브라우저에서만 확인해 왔다. undo 스택은 immer 패치로 굴러가고
 * coalesce 병합까지 있어서 회귀가 조용히 들어오기 쉬운 곳이다.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { charInSpanOf, getTrack, isAnimated, readStaticValue, useDocumentStore } from '@/state/document.ts'
import { assetRegistry } from '@/state/assets.ts'
import { createEmptyProject, createImageLayer, resetIdCounter } from '@/core/factory.ts'
import { createShapeSpec } from '@/core/shape.ts'
import { MOTION_REPEAT_MAX, type AssetRef, type MotionProject } from '@/core/types.ts'
import { ALL_MOTION_PARTS } from '@/motions/transfer.ts'

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
    expect(s().doc.layers[0]!.fit).toBe('none')
    expect(s().past).toHaveLength(0)
    expect(s().future).toHaveLength(1)
  })

  it('값이 그대로면 스택을 먹지 않는다', () => {
    s().setLayerFit(L, 'none') // 이미 none(원본 크기) 이다
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

  it('여러 키를 한 번에 지우면 실행취소도 한 칸이다', () => {
    // 하나씩 지우면 키 다섯 개 삭제가 Ctrl+Z 다섯 번이 된다 (removeLayers 와 같은 이유).
    for (const f of [0, 5, 10, 15, 20]) s().setValueAtFrame(L, 'translateX', f, f)
    s().clearHistory()
    s().removeKeyframes([
      { layerId: L, prop: 'translateX', frame: 5 },
      { layerId: L, prop: 'translateX', frame: 10 },
      { layerId: L, prop: 'translateX', frame: 15 },
    ])
    expect(getTrack(s().doc.layers[0]!, 'translateX')!.keys.map((k) => k.f)).toEqual([0, 20])
    expect(s().past).toHaveLength(1)
    s().undo()
    expect(getTrack(s().doc.layers[0]!, 'translateX')!.keys).toHaveLength(5)
  })

  it('일괄 삭제도 트랙의 마지막 키는 남긴다', () => {
    s().setValueAtFrame(L, 'translateX', 0, 0)
    s().setValueAtFrame(L, 'translateX', 10, 1)
    s().removeKeyframes([
      { layerId: L, prop: 'translateX', frame: 0 },
      { layerId: L, prop: 'translateX', frame: 10 },
    ])
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

describe('모션 옮기기', () => {
  /** 레이어를 한 장 더 만들고 그 id 를 돌려준다. */
  function addLayer(n: number): string {
    const ref: AssetRef = {
      id: `a${n}`,
      name: `x${n}`,
      storeKey: `k${n}`,
      naturalW: 100,
      naturalH: 100,
      hasAlpha: true,
    }
    s().replaceDocument({
      ...s().doc,
      assets: [...s().doc.assets, ref],
      layers: [...s().doc.layers, createImageLayer(ref, n)],
    })
    return s().doc.layers[s().doc.layers.length - 1]!.id
  }

  /** 첫 레이어에 옮길 거리를 만들어 둔다. */
  function seedMotion(): void {
    s().applyPresetTracks({
      layerId: L,
      presetId: 'zoom.pop',
      tracks: [
        {
          id: '',
          prop: 'scale',
          unit: 'ratio',
          keys: [
            { f: 0, v: 0.8, interp: 'bezier' },
            { f: 12, v: 1, interp: 'bezier' },
          ],
        },
      ],
      modifiers: [],
      macro: { speed: 1, strength: 0.5 },
    })
    s().addEffect(L, 'fx.grain', { strength: 0.4 })
    s().setLayerMotionRepeat(L, 3)
  }

  const find = (id: string) => s().doc.layers.find((l) => l.id === id)!

  it('움직임과 효과가 대상에 생기고 원본에도 남는다', () => {
    const B = addLayer(2)
    seedMotion()
    const report = s().transferMotion({
      fromLayerId: L,
      toLayerIds: [B],
      parts: ALL_MOTION_PARTS,
    })
    expect(report.moved).toBe(1)

    expect(find(B).tracks.map((t) => t.prop)).toEqual(find(L).tracks.map((t) => t.prop))
    expect(find(B).effects.map((e) => e.type)).toEqual(find(L).effects.map((e) => e.type))
    expect(find(B).motionRepeat).toBe(3)
    // 원본은 그대로다. 복사이지 이동이 아니다.
    expect(find(L).tracks).toHaveLength(1)
    expect(find(L).effects).toHaveLength(1)
  })

  it('트랙과 이펙트 id 를 새로 발급한다', () => {
    const B = addLayer(2)
    seedMotion()
    s().transferMotion({ fromLayerId: L, toLayerIds: [B], parts: ALL_MOTION_PARTS })
    expect(find(B).tracks[0]!.id).not.toBe(find(L).tracks[0]!.id)
    expect(find(B).effects[0]!.id).not.toBe(find(L).effects[0]!.id)
  })

  it('시드는 그대로 따라간다', () => {
    const B = addLayer(2)
    seedMotion()
    s().transferMotion({ fromLayerId: L, toLayerIds: [B], parts: ALL_MOTION_PARTS })
    // 패턴이 달라지면 "같은 모션" 이 아니다.
    expect(find(B).effects[0]!.seed).toBe(find(L).effects[0]!.seed)
  })

  it('여러 레이어에 보내도 실행취소 한 칸이다', () => {
    const B = addLayer(2)
    const C = addLayer(3)
    seedMotion()
    s().clearHistory()
    s().transferMotion({ fromLayerId: L, toLayerIds: [B, C], parts: ALL_MOTION_PARTS })
    expect(s().past).toHaveLength(1)
    expect(find(B).tracks).toHaveLength(1)
    expect(find(C).tracks).toHaveLength(1)
  })

  it('자기 자신에게 보내면 아무 일도 하지 않는다', () => {
    seedMotion()
    s().clearHistory()
    const report = s().transferMotion({
      fromLayerId: L,
      toLayerIds: [L],
      parts: ALL_MOTION_PARTS,
    })
    expect(report.moved).toBe(0)
    expect(s().past).toHaveLength(0)
  })

  it('잠긴 레이어는 건너뛴다', () => {
    const B = addLayer(2)
    seedMotion()
    s().setLayerFlag(B, 'locked', true)
    const report = s().transferMotion({
      fromLayerId: L,
      toLayerIds: [B],
      parts: ALL_MOTION_PARTS,
    })
    expect(report.moved).toBe(0)
    expect(report.skipped).toBe(1)
    expect(find(B).tracks).toHaveLength(0)
  })

  it('갈래를 고르면 그 갈래만 간다', () => {
    const B = addLayer(2)
    seedMotion()
    s().transferMotion({
      fromLayerId: L,
      toLayerIds: [B],
      parts: { tracks: false, effects: true, shaping: false },
    })
    expect(find(B).effects).toHaveLength(1)
    expect(find(B).tracks).toHaveLength(0)
  })

  it('이름과 맞춤과 구간은 따라가지 않는다', () => {
    const B = addLayer(2)
    seedMotion()
    s().setLayerFit(L, 'contain')
    s().setLayerRange([B], { inFrame: 3, outFrame: 9 })
    const name = find(B).name
    const fit = find(B).fit
    s().transferMotion({ fromLayerId: L, toLayerIds: [B], parts: ALL_MOTION_PARTS })
    expect(find(B).name).toBe(name)
    expect(find(B).fit).toBe(fit)
    expect(find(B).inFrame).toBe(3)
    expect(find(B).outFrame).toBe(9)
  })

  it('담기 배율은 대상에서 지운다', () => {
    const B = addLayer(2)
    seedMotion()
    s().transferMotion({ fromLayerId: L, toLayerIds: [B], parts: ALL_MOTION_PARTS })
    expect('containScale' in find(B)).toBe(false)
  })

  it('옮기기는 원본에서 빼고 presetRef 도 지운다', () => {
    const B = addLayer(2)
    seedMotion()
    expect(s().doc.presetRef?.layerId).toBe(L)
    s().transferMotion({
      fromLayerId: L,
      toLayerIds: [B],
      parts: ALL_MOTION_PARTS,
      move: true,
    })
    expect(find(L).tracks).toHaveLength(0)
    expect(find(L).effects).toHaveLength(0)
    expect('motionRepeat' in find(L)).toBe(false)
    expect(s().doc.presetRef).toBeUndefined()
    expect(find(B).tracks).toHaveLength(1)
  })

  it('옮길 것이 없으면 대상의 모션을 지우지 않는다', () => {
    const B = addLayer(2)
    // 원본은 비어 있고 대상에만 모션이 있다.
    s().applyPresetTracks({
      layerId: B,
      presetId: 'zoom.pop',
      tracks: [
        { id: '', prop: 'scale', unit: 'ratio', keys: [{ f: 0, v: 1, interp: 'bezier' }] },
      ],
      modifiers: [],
      macro: { speed: 1, strength: 0.5 },
    })
    const report = s().transferMotion({
      fromLayerId: L,
      toLayerIds: [B],
      parts: ALL_MOTION_PARTS,
    })
    expect(report.moved).toBe(0)
    expect(find(B).tracks).toHaveLength(1)
  })

  it('대상이 프리셋 레이어면 presetRef 를 지운다 (복사)', () => {
    // 전송이 대상의 갈래를 통째로 대체했는데 presetRef 가 남으면, EASY 슬라이더를
    // 스치는 재적용이 옛 프리셋 모션을 전송 결과 위에 도로 심는다.
    const B = addLayer(2)
    seedMotion()
    // B 에도 프리셋을 적용해 presetRef 소유를 B 로 넘긴다.
    s().applyPresetTracks({
      layerId: B,
      presetId: 'zoom.pop',
      tracks: [
        { id: '', prop: 'scale', unit: 'ratio', keys: [{ f: 0, v: 1, interp: 'bezier' }] },
      ],
      modifiers: [],
      macro: { speed: 1, strength: 0.5 },
    })
    expect(s().doc.presetRef?.layerId).toBe(B)
    s().transferMotion({ fromLayerId: L, toLayerIds: [B], parts: ALL_MOTION_PARTS })
    expect(s().doc.presetRef).toBeUndefined()
  })

  it('대상이 프리셋 레이어면 presetRef 를 지운다 (이동)', () => {
    const B = addLayer(2)
    seedMotion()
    s().applyPresetTracks({
      layerId: B,
      presetId: 'zoom.pop',
      tracks: [
        { id: '', prop: 'scale', unit: 'ratio', keys: [{ f: 0, v: 1, interp: 'bezier' }] },
      ],
      modifiers: [],
      macro: { speed: 1, strength: 0.5 },
    })
    s().transferMotion({ fromLayerId: L, toLayerIds: [B], parts: ALL_MOTION_PARTS, move: true })
    expect(s().doc.presetRef).toBeUndefined()
  })

  it('기준점·원근만 있는 모션도 가리기 갈래로 보낼 수 있다', () => {
    // bundleIsEmpty 가 reveal/charAnim 만 보면 '경첩 열리며 등장' 처럼 기준점과
    // 원근만 심는 모션이 "보낼 것이 없습니다" 로 부당하게 막힌다.
    const B = addLayer(2)
    s().setLayerAnchor(L, 0.5, 0)
    s().setLayerPerspective(L, 8)
    const report = s().transferMotion({
      fromLayerId: L,
      toLayerIds: [B],
      parts: { tracks: false, effects: false, shaping: true },
    })
    expect(report.moved).toBe(1)
    expect(find(B).anchor).toEqual([0.5, 0])
    expect(find(B).perspective).toBe(8)
  })
})

describe('그림 갈아끼우기', () => {
  /** 크기를 정할 수 있는 가짜 비트맵. addImage 는 width / height 만 읽는다. */
  function fakeBitmap(w: number, h: number): ImageBitmap {
    return { width: w, height: h, close() {} } as unknown as ImageBitmap
  }

  /** 첫 레이어에 옮길 거리를 만들어 둔다. */
  function seedMotion(): void {
    s().applyPresetTracks({
      layerId: L,
      presetId: 'zoom.pop',
      tracks: [
        {
          id: '',
          prop: 'scale',
          unit: 'ratio',
          keys: [
            { f: 0, v: 0.8, interp: 'bezier' },
            { f: 12, v: 1, interp: 'bezier' },
          ],
        },
      ],
      modifiers: [],
      macro: { speed: 1, strength: 0.5 },
    })
    s().addEffect(L, 'fx.grain', { strength: 0.4 })
    s().setLayerMotionRepeat(L, 3)
  }

  const layer = () => s().doc.layers[0]!

  it('레이어 id 가 그대로라 모션이 한 개도 사라지지 않는다', () => {
    seedMotion()
    const before = {
      id: layer().id,
      tracks: JSON.stringify(layer().tracks),
      effects: JSON.stringify(layer().effects.map((e) => [e.type, e.seed])),
      repeat: layer().motionRepeat,
    }

    const out = s().replaceLayerImage(L, {
      name: 'new.png',
      bitmap: fakeBitmap(200, 200),
      hasAlpha: true,
    })

    expect(out).not.toBeNull()
    expect(layer().id).toBe(before.id)
    expect(JSON.stringify(layer().tracks)).toBe(before.tracks)
    expect(JSON.stringify(layer().effects.map((e) => [e.type, e.seed]))).toBe(before.effects)
    expect(layer().motionRepeat).toBe(before.repeat)
  })

  it('에셋만 새것으로 갈리고 옛 에셋은 사라진다', () => {
    const oldAssetId = layer().assetId
    const out = s().replaceLayerImage(L, {
      name: 'new.png',
      bitmap: fakeBitmap(200, 200),
      hasAlpha: true,
    })
    expect(layer().assetId).toBe(out?.assetId)
    expect(layer().assetId).not.toBe(oldAssetId)
    expect(s().doc.assets.map((a) => a.id)).toEqual([out?.assetId])
  })

  it('캔버스는 건드리지 않는다', () => {
    const before = { ...s().doc.canvas }
    s().replaceLayerImage(L, {
      name: 'huge.png',
      bitmap: fakeBitmap(3000, 3000),
      hasAlpha: true,
    })
    expect(s().doc.canvas.w).toBe(before.w)
    expect(s().doc.canvas.h).toBe(before.h)
  })

  it('원본 크기 맞춤이면 화면에서 차지하던 크기를 지킨다', () => {
    // 기본 에셋은 200x200 이다. 400x400 을 끼우면 배율이 절반이 되어야 같은 상자다.
    expect(layer().fit).toBe('none')
    s().replaceLayerImage(L, {
      name: 'big.png',
      bitmap: fakeBitmap(400, 400),
      hasAlpha: true,
    })
    expect(layer().baseScale).toBeCloseTo(0.5, 6)
  })

  it('가로세로가 달라도 긴 변으로 잰다', () => {
    s().replaceLayerImage(L, {
      name: 'wide.png',
      bitmap: fakeBitmap(800, 100),
      hasAlpha: true,
    })
    // 긴 변 800 이 200 이 되도록 0.25 배.
    expect(layer().baseScale).toBeCloseTo(0.25, 6)
  })

  it('맞춤이 크기를 정하는 경우에는 배율을 건드리지 않는다', () => {
    s().setLayerFit(L, 'cover')
    const before = layer().baseScale
    s().replaceLayerImage(L, {
      name: 'big.png',
      bitmap: fakeBitmap(400, 400),
      hasAlpha: true,
    })
    expect(layer().baseScale).toBe(before)
  })

  it('이름을 손댄 적이 없으면 새 파일 이름을 따른다', () => {
    s().replaceLayerImage(L, {
      name: 'cat2.png',
      bitmap: fakeBitmap(200, 200),
      hasAlpha: true,
    })
    expect(layer().name).toBe('cat2.png')
  })

  it('이름을 손댔으면 그 이름을 지키지 않는다', () => {
    s().setLayerName(L, '주인공')
    s().replaceLayerImage(L, {
      name: 'cat2.png',
      bitmap: fakeBitmap(200, 200),
      hasAlpha: true,
    })
    expect(layer().name).toBe('주인공')
  })

  it('실행취소 한 칸으로 옛 그림이 돌아온다', () => {
    const oldAssetId = layer().assetId
    s().clearHistory()
    s().replaceLayerImage(L, {
      name: 'new.png',
      bitmap: fakeBitmap(400, 400),
      hasAlpha: true,
    })
    expect(s().past).toHaveLength(1)
    s().undo()
    expect(layer().assetId).toBe(oldAssetId)
    expect(s().doc.assets.map((a) => a.id)).toEqual([oldAssetId])
  })

  it('이미지 레이어가 아니면 아무 일도 하지 않는다', () => {
    const { layerId } = s().addShape({ name: '사각형', shape: { kind: 'rect' } as never })
    s().clearHistory()
    const out = s().replaceLayerImage(layerId, {
      name: 'x.png',
      bitmap: fakeBitmap(100, 100),
      hasAlpha: true,
    })
    expect(out).toBeNull()
    expect(s().past).toHaveLength(0)
  })
})

describe('레이어 모션 배수', () => {
  it('1 이면 키를 만들지 않는다', () => {
    s().setLayerMotionRepeat(L, 1)
    expect('motionRepeat' in s().doc.layers[0]!).toBe(false)
  })

  it('올렸다 1 로 되돌리면 키가 사라진다', () => {
    s().setLayerMotionRepeat(L, 4)
    expect(s().doc.layers[0]!.motionRepeat).toBe(4)
    s().setLayerMotionRepeat(L, 1)
    expect('motionRepeat' in s().doc.layers[0]!).toBe(false)
  })

  it('범위 밖은 클램프한다', () => {
    s().setLayerMotionRepeat(L, 999)
    expect(s().doc.layers[0]!.motionRepeat).toBe(MOTION_REPEAT_MAX)
  })

  it('소수는 반올림한다', () => {
    s().setLayerMotionRepeat(L, 2.6)
    expect(s().doc.layers[0]!.motionRepeat).toBe(3)
  })

  it('실행취소로 되돌아간다', () => {
    s().clearHistory()
    s().setLayerMotionRepeat(L, 4)
    s().undo()
    expect('motionRepeat' in s().doc.layers[0]!).toBe(false)
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
    // 소유권은 문서가 아니라 레이어에 남는다. 문서에 한 벌만 두면 다른 레이어에
    // 프리셋을 얹는 순간 이 기록이 덮인다 (motions/merge.ts ownershipFor).
    expect(s().doc.layers[0]!.presetOwnership?.props).toEqual(['scale'])
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

  it('레이어의 소유권 기록에 이펙트 id 가 남는다', () => {
    s().applyPresetTracks({
      layerId: L, presetId: 'glitch.vhs', tracks: [], modifiers: [],
      effects: [fx('v1', 'glitch.rgbShift'), fx('v2', 'fx.scanline')],
      macro: { speed: 1, strength: 0.5 },
    })
    expect(s().doc.layers[0]!.presetOwnership?.effectIds).toEqual(['v1', 'v2'])
  })
})

describe('updateAssetPrep', () => {
  it('크기 / 알파 / prep 기록이 문서에 반영된다', () => {
    s().updateAssetPrep('a1', {
      width: 1602,
      height: 196,
      hasAlpha: true,
      prep: {
        crop: [100, 500, 1602, 196],
        bgRemove: { enabled: true, keyColor: '#ffffff', tolerance: 0.12, featherPx: 1 },
      },
    })
    const asset = s().doc.assets[0]!
    expect(asset.naturalW).toBe(1602)
    expect(asset.naturalH).toBe(196)
    expect(asset.hasAlpha).toBe(true)
    expect(asset.prep?.crop).toEqual([100, 500, 1602, 196])
    expect(asset.prep?.bgRemove?.keyColor).toBe('#ffffff')
  })

  it('prep 을 생략하면 기록을 지운다 (되돌리기)', () => {
    s().updateAssetPrep('a1', {
      width: 100, height: 50, hasAlpha: true, prep: { crop: [0, 0, 100, 50] },
    })
    s().updateAssetPrep('a1', { width: 200, height: 200, hasAlpha: true })
    const asset = s().doc.assets[0]!
    expect(asset.naturalW).toBe(200)
    expect(asset.prep).toBeUndefined()
  })

  it('실행취소 스택에 쌓이지 않는다 (픽셀은 undo 로 못 되돌리므로)', () => {
    s().updateAssetPrep('a1', { width: 100, height: 50, hasAlpha: false })
    expect(s().past).toHaveLength(0)
    // undo 를 눌러도 크기가 픽셀과 어긋나게 되돌아가지 않는다.
    s().undo()
    const asset = s().doc.assets[0]!
    expect(asset.naturalW).toBe(100)
    expect(asset.naturalH).toBe(50)
    expect(asset.hasAlpha).toBe(false)
  })

  it('이전 커맨드의 undo 는 크기 갱신을 건너뛰고 동작한다', () => {
    s().setLayerFit(L, 'contain')
    s().updateAssetPrep('a1', { width: 100, height: 50, hasAlpha: true })
    s().undo()
    expect(s().doc.layers[0]!.fit).toBe('none')
    // 크기 갱신은 살아남는다. 픽셀이 이미 100x50 이기 때문이다.
    expect(s().doc.assets[0]!.naturalW).toBe(100)
  })

  it('없는 에셋이면 문서를 건드리지 않는다', () => {
    const before = s().doc
    s().updateAssetPrep('ghost', { width: 10, height: 10, hasAlpha: true })
    expect(s().doc).toBe(before)
  })

  it('크기는 정수로 반올림되고 1 미만으로 내려가지 않는다', () => {
    s().updateAssetPrep('a1', { width: 0.2, height: 99.6, hasAlpha: true })
    const asset = s().doc.assets[0]!
    expect(asset.naturalW).toBe(1)
    expect(asset.naturalH).toBe(100)
  })
})

describe('히스토리와 에셋 재동기화', () => {
  const fakeBitmap = (w: number, h: number): ImageBitmap =>
    ({ width: w, height: h, close() {} }) as unknown as ImageBitmap

  it('redo 가 되살린 옛 에셋 스냅샷을 레지스트리 실측으로 되맞춘다', () => {
    const { assetId } = s().addImage({ name: 'x', bitmap: fakeBitmap(30, 30), hasAlpha: false })
    // 다듬기: 픽셀 교체 + 문서 반영 (updateAssetPrep 은 히스토리 밖)
    assetRegistry.set(assetId, fakeBitmap(100, 50))
    s().updateAssetPrep(assetId, { width: 100, height: 50, hasAlpha: true })

    s().undo() // 이미지 추가 취소
    s().redo() // add 패치는 30x30 스냅샷을 되살리지만 resync 가 실측으로 되맞춘다

    const asset = s().doc.assets.find((a) => a.id === assetId)!
    expect(asset.naturalW).toBe(100)
    expect(asset.naturalH).toBe(50)
    assetRegistry.delete(assetId)
  })

  it('레이어 삭제 undo 가 다른 에셋의 다듬기 갱신을 덮지 않는다 (splice 패치)', () => {
    const a = s().addImage({ name: 'a', bitmap: fakeBitmap(20, 20), hasAlpha: false })
    const b = s().addImage({ name: 'b', bitmap: fakeBitmap(20, 20), hasAlpha: false })
    s().removeLayer(b.layerId)

    assetRegistry.set(a.assetId, fakeBitmap(10, 5))
    s().updateAssetPrep(a.assetId, {
      width: 10, height: 5, hasAlpha: true, prep: { crop: [0, 0, 10, 5] },
    })

    s().undo() // 삭제 취소. filter 재대입이었다면 assets 전체 스냅샷이 a 를 되돌렸다.

    const asset = s().doc.assets.find((x) => x.id === a.assetId)!
    expect(asset.naturalW).toBe(10)
    expect(asset.naturalH).toBe(5)
    // resync 는 크기만 맞추고 prep 은 못 되살린다. splice 패치 덕에 애초에 안 덮인다.
    expect(asset.prep?.crop).toEqual([0, 0, 10, 5])

    assetRegistry.delete(a.assetId)
    assetRegistry.delete(b.assetId)
  })
})

/**
 * 캔버스는 맨 처음 넣은 이미지 크기로 고정된다.
 *
 * 첫 장이 액자를 정한 뒤에는 더 큰 이미지를 넣어도 캔버스가 따라 커지지 않는다.
 * 커지면 이미 잡아 둔 결과물 해상도가 통째로 바뀐다.
 */
describe('캔버스는 첫 이미지 크기로 고정', () => {
  const fakeBitmap = (w: number, h: number): ImageBitmap =>
    ({ width: w, height: h, close() {} }) as unknown as ImageBitmap

  it('첫 이미지가 캔버스를 정하고 더 큰 이미지가 와도 커지지 않는다', () => {
    resetIdCounter()
    s().replaceDocument(createEmptyProject())

    const a = s().addImage({ name: 'first.png', bitmap: fakeBitmap(300, 240), hasAlpha: true })
    expect(s().doc.canvas.w).toBe(300)
    expect(s().doc.canvas.h).toBe(240)

    const b = s().addImage({ name: 'big.png', bitmap: fakeBitmap(1600, 1200), hasAlpha: true })
    expect(s().doc.canvas.w).toBe(300)
    expect(s().doc.canvas.h).toBe(240)

    assetRegistry.delete(a.assetId)
    assetRegistry.delete(b.assetId)
  })

  it('도형을 먼저 만든 문서에서도 첫 이미지가 액자를 정한다', () => {
    resetIdCounter()
    s().replaceDocument(createEmptyProject())
    s().addShape({ name: '사각형', shape: createShapeSpec('rect') })
    expect(s().doc.canvas.w).toBe(512) // 도형은 기본 캔버스를 건드리지 않는다

    const a = s().addImage({ name: 'first.png', bitmap: fakeBitmap(640, 360), hasAlpha: true })
    expect(s().doc.canvas.w).toBe(640)
    expect(s().doc.canvas.h).toBe(360)

    assetRegistry.delete(a.assetId)
  })
})

/**
 * 캔버스 크기와 그림 크기.
 *
 * 해상도를 바꾸는 컨트롤은 그림도 같은 비율로 데려가야 한다. 캔버스만 줄이면
 * fit 이 '원본 크기'인 레이어가 제자리에 남아, 화면에서는 그림이 커지고 사방이
 * 잘린 것으로 보인다. 사용자가 고른 것은 해상도이지 확대가 아니다.
 */
describe('캔버스 크기와 내용 배율', () => {
  it('해상도를 줄이면 그림도 같은 비율로 줄어든다', () => {
    // 200x200 원본, 캔버스도 200x200 에서 시작한다.
    s().setCanvasSize(200, 200)
    s().setCanvasSize(100, 100, { scaleContent: true })
    expect(s().doc.canvas.w).toBe(100)
    expect(s().doc.layers[0]!.baseScale).toBeCloseTo(0.5, 9)
  })

  it('여러 번 바꾸면 누적된다', () => {
    s().setCanvasSize(200, 200)
    s().setCanvasSize(100, 100, { scaleContent: true })
    s().setCanvasSize(400, 400, { scaleContent: true })
    // 0.5 * 4 = 2. 원본 200px 이 400px 캔버스를 채운다.
    expect(s().doc.layers[0]!.baseScale).toBeCloseTo(2, 9)
  })

  it('자르기처럼 원본이 달라진 경우는 건드리지 않는다', () => {
    s().setCanvasSize(200, 200)
    s().setCanvasSize(120, 120)
    expect(s().doc.layers[0]!.baseScale).toBe(1)
  })

  it('한 축만 키우면 그림은 그대로다', () => {
    s().setCanvasSize(200, 200)
    s().setCanvasSize(200, 400, { scaleContent: true })
    // 세로만 넓혔다. 그림이 세로로 늘어나면 안 된다.
    expect(s().doc.layers[0]!.baseScale).toBe(1)
  })

  it('한 축만 줄이면 그 축에 맞춰 들어간다', () => {
    s().setCanvasSize(200, 200)
    s().setCanvasSize(100, 200, { scaleContent: true })
    expect(s().doc.layers[0]!.baseScale).toBeCloseTo(0.5, 9)
  })

  /**
   * A -> B -> A 는 언제나 제자리로 돌아와야 한다.
   *
   * 두 축 비율의 min 을 쓰던 때는 폭만 키웠다 되돌리는 것만으로 그림이 절반이 됐다.
   * 키울 때는 min 이 1 로 잘리고 줄일 때는 그대로 곱해지는 비대칭 래칫이었다.
   * 캔버스는 제자리인데 그림은 안 돌아오고, 폭을 다시 쳐도 복구되지 않았다.
   */
  it('한 축을 키웠다 되돌리면 그림이 제자리다', () => {
    s().setCanvasSize(200, 200)
    s().setStaticValue(L, 'translateX', 40)

    s().setCanvasSize(400, 200, { scaleContent: true })
    s().setCanvasSize(200, 200, { scaleContent: true })

    expect(s().doc.layers[0]!.baseScale).toBeCloseTo(1, 9)
    expect(readStaticValue(s().doc.layers[0]!, 'translateX')).toBeCloseTo(40, 9)
  })

  it('어느 순서로 왕복해도 제자리다', () => {
    s().setCanvasSize(200, 200)
    const before = s().doc.layers[0]!.baseScale

    for (const [w, h] of [[400, 200], [400, 400], [100, 400], [100, 100], [200, 200]] as const) {
      s().setCanvasSize(w, h, { scaleContent: true })
    }
    expect(s().doc.layers[0]!.baseScale).toBeCloseTo(before ?? 1, 9)
  })

  it('채우기/담기 레이어는 fit 이 이미 캔버스를 따라가므로 손대지 않는다', () => {
    s().setLayerFit(L, 'cover')
    s().setCanvasSize(200, 200)
    s().setCanvasSize(100, 100, { scaleContent: true })
    expect(s().doc.layers[0]!.baseScale).toBe(1)
  })
})

describe('캔버스 크기와 손으로 넣은 위치', () => {
  it('px 위치도 같은 비율로 따라간다', () => {
    s().setCanvasSize(200, 200)
    s().setStaticValue(L, 'translateX', 40)
    s().setCanvasSize(100, 100, { scaleContent: true })
    expect(readStaticValue(s().doc.layers[0]!, 'translateX')).toBeCloseTo(20, 9)
  })

  it('내용 배율을 안 켜면 위치도 그대로다', () => {
    s().setCanvasSize(200, 200)
    s().setStaticValue(L, 'translateX', 40)
    s().setCanvasSize(100, 100)
    expect(readStaticValue(s().doc.layers[0]!, 'translateX')).toBe(40)
  })
})

/**
 * 프리셋 소유권 표식.
 *
 * 재적용(세기/속도 슬라이더)이 어느 레이어를 건드릴지는 추측이 아니라 기록으로 정한다.
 * 트랙을 내지 않는 프리셋(흔들기/자글자글/지지직)은 props 가 비어 역추적이 불가능하다.
 */
describe('presetRef 기록', () => {
  it('트랙이 없어도 대상 레이어를 남긴다', () => {
    s().applyPresetTracks({
      layerId: L,
      presetId: 'shake.camera',
      tracks: [],
      modifiers: [],
      macro: { speed: 1, strength: 0.5 },
    })
    expect(s().doc.presetRef?.layerId).toBe(L)
    // 아무것도 소유하지 않으면 기록 키 자체를 만들지 않는다 (JSON 왕복 결정론).
    expect(s().doc.layers[0]!.presetOwnership).toBeUndefined()
  })

  it('기존 키 값만 바꿔도 손댄 것으로 표시한다', () => {
    s().applyPresetTracks({
      layerId: L,
      presetId: 'zoom.pop',
      tracks: [
        { id: '', prop: 'scale', unit: 'ratio', keys: [
          { f: 0, v: 0.86, interp: 'bezier' },
          { f: 10, v: 1, interp: 'bezier' },
        ] },
      ],
      modifiers: [],
      macro: { speed: 1, strength: 0.5 },
    })
    expect(s().doc.presetRef?.dirty).toBe(false)

    // 프리셋 트랙은 f:0 에 키가 있다. 기본 재생 헤드에서 고치면 '기존 키 갱신' 분기다.
    s().setValueAtFrame(L, 'scale', 0, 1.2)
    expect(s().doc.presetRef?.dirty).toBe(true)
  })

  /**
   * addKeyframe 은 두 갈래다. 두 키 **사이**면 de Casteljau 로 쪼개고, 구간 **밖**이면
   * 끝 값을 복제한다. 사이 분기가 조기 return 하느라 dirty 표시를 지나쳤다.
   * 그러면 EASY 에 '프리셋에서 벗어났습니다' 가 안 뜨고 슬라이더가 열린 채로 남아,
   * 조금만 끌어도 방금 찍은 키가 트랙째 갈아끼워지며 사라진다.
   */
  it('키를 어디에 찍든 손댄 것으로 표시한다', () => {
    for (const [where, frame] of [['두 키 사이', 5], ['구간 밖', 20]] as const) {
      s().applyPresetTracks({
        layerId: L,
        presetId: 'zoom.pop',
        tracks: [
          { id: '', prop: 'scale', unit: 'ratio', keys: [
            { f: 0, v: 0.86, interp: 'bezier' },
            { f: 10, v: 1, interp: 'bezier' },
          ] },
        ],
        modifiers: [],
        macro: { speed: 1, strength: 0.5 },
      })
      expect(s().doc.presetRef?.dirty, where).toBe(false)

      s().addKeyframe(L, 'scale', frame)
      expect(getTrack(s().doc.layers[0]!, 'scale')!.keys.some((k) => k.f === frame), where).toBe(true)
      expect(s().doc.presetRef?.dirty, where).toBe(true)
    }
  })

  /**
   * 스톱워치(toggleAnimated)도 트랙을 갈아엎는 PRO 편집이다. dirty 를 안 남기면
   * EASY 슬라이더를 스치는 재적용이 방금 정지시킨 애니메이션을 소리 없이 되살린다.
   */
  it('스톱워치로 끄거나 켜도 손댄 것으로 표시한다', () => {
    for (const [dir, times] of [['끄기', 1], ['켜기', 2]] as const) {
      s().applyPresetTracks({
        layerId: L,
        presetId: 'zoom.pop',
        tracks: [
          { id: '', prop: 'scale', unit: 'ratio', keys: [
            { f: 0, v: 0.86, interp: 'bezier' },
            { f: 10, v: 1, interp: 'bezier' },
          ] },
        ],
        modifiers: [],
        macro: { speed: 1, strength: 0.5 },
      })
      expect(s().doc.presetRef?.dirty, dir).toBe(false)
      // 켜기 방향은 먼저 꺼서 기존 트랙을 상수로 만든 뒤 다시 켠다.
      for (let i = 0; i < times; i += 1) s().toggleAnimated(L, 'scale', 0)
      expect(s().doc.presetRef?.dirty, dir).toBe(true)
    }
  })
})

/**
 * 등장 속도.
 *
 * 진행률 트랙의 시작과 길이가 곧 속도다. 길이를 줄이면 같은 모션이 빨라진다.
 * 속도 곡선은 이 트랙이 아니라 글자마다 charAnim.ease 가 걸므로, 여기 트랙은
 * 언제나 등속 0 -> 1 이어야 한다.
 */
describe('등장 속도', () => {
  it('모양을 고르면 타임라인 전체를 쓴다', () => {
    s().setLayerCharAnim(L, { mode: 'left' })
    const span = charInSpanOf(s().doc.layers[0]!, s().doc.timeline.durationFrames)
    expect(span.start).toBe(0)
    expect(span.frames).toBe(s().doc.timeline.durationFrames - 1)
  })

  it('길이를 줄이면 같은 프레임에서 더 많이 들어와 있다', () => {
    s().setLayerCharAnim(L, { mode: 'left' })
    const mid = Math.floor(s().doc.timeline.durationFrames / 2)
    const slow = readStaticValue(s().doc.layers[0]!, 'charIn', mid)

    s().setCharInSpan(L, 0, 4)
    const fast = readStaticValue(s().doc.layers[0]!, 'charIn', mid)
    expect(fast).toBeGreaterThan(slow)
    expect(fast).toBe(1)
  })

  it('시작을 미루면 그 전에는 출발점 그대로다', () => {
    s().setLayerCharAnim(L, { mode: 'left' })
    s().setCharInSpan(L, 10, 5)
    const layer = s().doc.layers[0]!
    expect(readStaticValue(layer, 'charIn', 9)).toBe(0)
    expect(readStaticValue(layer, 'charIn', 15)).toBe(1)
    expect(charInSpanOf(layer, s().doc.timeline.durationFrames)).toEqual({ start: 10, frames: 5 })
  })

  it('마지막 프레임을 넘어가지 않는다', () => {
    // 넘어가면 등장이 끝나지 않은 채로 파일이 끝난다.
    s().setLayerCharAnim(L, { mode: 'left' })
    s().setCharInSpan(L, 0, 99999)
    const last = s().doc.timeline.durationFrames - 1
    expect(readStaticValue(s().doc.layers[0]!, 'charIn', last)).toBe(1)
  })

  it('트랙은 등속으로 남는다', () => {
    s().setLayerCharAnim(L, { mode: 'left' })
    s().setCharInSpan(L, 0, 10)
    const track = getTrack(s().doc.layers[0]!, 'charIn')!
    expect(track.keys.map((k) => k.interp)).toEqual(['linear', 'linear'])
    // 절반 지점의 값이 정확히 절반이어야 등속이다.
    expect(readStaticValue(s().doc.layers[0]!, 'charIn', 5)).toBeCloseTo(0.5, 9)
  })

  it('등장 시간 변경도 실행취소 한 칸이다', () => {
    s().setLayerCharAnim(L, { mode: 'left' })
    const before = s().past.length
    s().setCharInSpan(L, 2, 6)
    expect(s().past.length).toBe(before + 1)
    s().undo()
    expect(charInSpanOf(s().doc.layers[0]!, s().doc.timeline.durationFrames).start).toBe(0)
  })
})
