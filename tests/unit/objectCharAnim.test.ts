/**
 * 등장 모션을 이미지와 도형에도 건다.
 *
 * 오브제는 **글자가 한 개짜리 글 상자**로 계산된다. 규칙이 한 벌이라는 것이 이
 * 기능의 전부이고, 그래서 여기서 지키는 것도 네 가지뿐이다.
 *
 *   1. 이름이 가리키는 쪽에서 출발한다. 글자든 오브제든 같은 쪽이다.
 *   2. 진행률 1 에서는 한 픽셀도 움직이지 않는다. 등장이 끝나면 흔적이 없어야 한다.
 *   3. 글자 레이어는 여기서 아무 일도 하지 않는다. 렌더러가 글자마다 따로 건다.
 *   4. 이동 거리는 **자기 크기** 배수다. 캔버스 크기가 아니다.
 */

import { describe, expect, it } from 'vitest'

import { createCharAnimSpec } from '@/core/charAnim.ts'
import { resolveComposition } from '@/core/evaluate.ts'
import {
  createEmptyProject,
  createImageLayer,
  createShapeLayer,
  createStaticTrack,
  createTextLayer,
  resetIdCounter,
} from '@/core/factory.ts'
import { normalizeShapeSpec } from '@/core/shape.ts'
import { createTextSpec } from '@/core/text.ts'
import type { AssetRef, CharInMode, Layer, MotionProject } from '@/core/types.ts'
import { buildPreviewDoc } from '@/motions/apply.ts'
import { MOTION_PRESETS } from '@/motions/registry.ts'

/** 캔버스 500x500, 원본 500x500. 기준 배율이 1 이라 눈으로 검산할 수 있다. */
const SIZE = 500

function imageDoc(naturalW = SIZE, naturalH = SIZE): { doc: MotionProject; layer: Layer } {
  resetIdCounter()
  const doc = createEmptyProject()
  doc.canvas.w = SIZE
  doc.canvas.h = SIZE
  const asset: AssetRef = {
    id: 'a1',
    name: 'x',
    storeKey: 'k',
    naturalW,
    naturalH,
    hasAlpha: true,
  }
  doc.assets.push(asset)
  const layer = createImageLayer(asset, 0)
  doc.layers.push(layer)
  return { doc, layer }
}

/** 진행률을 못 박는다. 트랙 하나면 상수다. */
function pinProgress(layer: Layer, value: number): void {
  layer.tracks = [createStaticTrack('charIn', 'ratio', value)]
}

function transformAt(doc: MotionProject, progress: number) {
  pinProgress(doc.layers[0]!, progress)
  return resolveComposition(doc, 0)[0]!.transform
}

describe('오브제 등장', () => {
  it('이름이 가리키는 쪽에서 출발한다', () => {
    // 글자 표(text.test.ts)와 **같은 표**여야 한다. 두 벌이 되는 순간 같은 이름의
    // 모션이 글자에서는 왼쪽에서, 이미지에서는 오른쪽에서 들어오게 된다.
    const EXPECTED: Partial<Record<CharInMode, [number, number]>> = {
      left: [-1, 0],
      right: [1, 0],
      up: [0, -1],
      down: [0, 1],
      drop: [0, -1],
    }

    for (const [mode, [ex, ey]] of Object.entries(EXPECTED) as [
      CharInMode,
      [number, number],
    ][]) {
      const { doc, layer } = imageDoc()
      layer.charAnim = createCharAnimSpec(mode, { distance: 1.5 })
      const t = transformAt(doc, 0)
      expect(Math.sign(t.translateX), `${mode} 가로`).toBe(ex)
      expect(Math.sign(t.translateY), `${mode} 세로`).toBe(ey)
    }
  })

  it('다 들어오면 한 픽셀도 어긋나지 않는다', () => {
    const { doc, layer } = imageDoc()
    layer.charAnim = createCharAnimSpec('scatter', { distance: 3, rotate: 720, scale: 4 })

    const t = transformAt(doc, 1)
    expect(t.translateX).toBe(0)
    expect(t.translateY).toBe(0)
    expect(t.rotate).toBe(0)
    expect(t.scaleX).toBe(1)
    expect(t.scaleY).toBe(1)
    expect(t.opacity).toBe(1)
  })

  it('이동 거리는 캔버스가 아니라 자기 크기의 배수다', () => {
    // 캔버스 500 에 원본 250 을 원본 크기(맞춤 없음)로 놓는다. 화면에서 250px 다.
    // 거리 2 면 250 * 2 = 500 이어야 한다. 캔버스로 재면 1000 이 나온다.
    const { doc, layer } = imageDoc(250, 250)
    layer.fit = 'none'
    layer.charAnim = createCharAnimSpec('left', { distance: 2 })

    expect(transformAt(doc, 0).translateX).toBeCloseTo(-500, 6)
  })

  it('큰 그림도 작은 그림도 제 몸만큼 밖에서 출발한다', () => {
    const small = imageDoc(100, 100)
    small.layer.fit = 'none'
    small.layer.charAnim = createCharAnimSpec('left', { distance: 1 })

    const big = imageDoc(400, 400)
    big.layer.fit = 'none'
    big.layer.charAnim = createCharAnimSpec('left', { distance: 1 })

    // 화면에서 차지하는 폭이 100 과 400 이므로 출발점도 그만큼 다르다.
    // 둘 다 "제 몸 하나만큼" 밖이라 어느 쪽도 저 멀리서 순간이동해 오지 않는다.
    expect(transformAt(small.doc, 0).translateX).toBeCloseTo(-100, 6)
    expect(transformAt(big.doc, 0).translateX).toBeCloseTo(-400, 6)
  })

  it('맞춤을 따라 실제로 그려지는 크기로 잰다', () => {
    // 캔버스 500 에 원본 250 을 '맞춤: 담기' 로 두면 화면에서는 500px 로 커진다.
    // 자는 원본 픽셀이 아니라 **화면에서 차지하는 크기**여야 한다.
    const { doc, layer } = imageDoc(250, 250)
    layer.fit = 'contain'
    layer.charAnim = createCharAnimSpec('left', { distance: 1 })

    expect(transformAt(doc, 0).translateX).toBeCloseTo(-500, 6)
  })

  it('도형에도 걸린다', () => {
    resetIdCounter()
    const doc = createEmptyProject()
    doc.canvas.w = SIZE
    doc.canvas.h = SIZE
    const shape = normalizeShapeSpec({ kind: 'rect', width: 200, height: 200 })
    const layer = createShapeLayer(shape, '사각형', 0)
    layer.charAnim = createCharAnimSpec('right', { distance: 1 })
    doc.layers.push(layer)

    expect(transformAt(doc, 0).translateX).toBeGreaterThan(0)
    expect(transformAt(doc, 1).translateX).toBe(0)
  })

  it('글자 레이어는 레이어 변환을 건드리지 않는다', () => {
    /*
     * 글자는 상자 **안에서** 글자마다 따로 움직인다(렌더러). 여기서도 걸면 두 번
     * 먹어서 상자째로 날아간다. 그래서 글 상자는 언제나 제자리다.
     */
    resetIdCounter()
    const doc = createEmptyProject()
    const layer = createTextLayer(createTextSpec({ content: '안녕하세요' }), '글자', 0)
    layer.charAnim = createCharAnimSpec('left', { distance: 3 })
    doc.layers.push(layer)

    const t = transformAt(doc, 0)
    expect(t.translateX).toBe(0)
    expect(t.translateY).toBe(0)
    expect(t.scaleX).toBe(1)
  })

  it('글자 등장 값은 글자 레이어에만 실려 나간다', () => {
    // 오브제는 이미 변환에 접혀 들어갔다. 렌더러에까지 실어 보내면 두 번 걸 여지가 생긴다.
    const { doc, layer } = imageDoc()
    layer.charAnim = createCharAnimSpec('left', { distance: 1 })
    pinProgress(layer, 0)
    expect(resolveComposition(doc, 0)[0]!.charAnim).toBeUndefined()
  })

  it('등장 모양이 없으면 옛 문서와 한 픽셀도 다르지 않다', () => {
    const { doc } = imageDoc()
    const t = transformAt(doc, 0.5)
    expect(t.translateX).toBe(0)
    expect(t.translateY).toBe(0)
    expect(t.scaleX).toBe(1)
    expect(t.opacity).toBe(1)
  })

  it('속도 곡선이 오브제에서도 등속이 아니다', () => {
    // 밋밋함의 정체는 등속이었다. 오브제에서도 같은 곡선이 걸려야 한다.
    const { doc, layer } = imageDoc()
    layer.charAnim = createCharAnimSpec('left', { distance: 2, ease: 'back' })

    const xs = [0, 0.25, 0.5, 0.75, 1].map((p) => transformAt(doc, p).translateX)
    const steps = xs.slice(1).map((x, i) => x - xs[i]!)
    const fastest = Math.max(...steps.map(Math.abs))
    const slowest = Math.min(...steps.map(Math.abs))
    expect(fastest / Math.max(slowest, 1e-9)).toBeGreaterThan(3)
  })

  it('살짝 지나쳤다 돌아온다', () => {
    // back 곡선은 목표를 넘어간다. 오브제에서도 그 오버슈트가 살아 있어야 쫀득하다.
    const { doc, layer } = imageDoc()
    layer.charAnim = createCharAnimSpec('left', { distance: 2, ease: 'back' })

    let overshoot = false
    for (let i = 1; i < 40; i += 1) {
      // 왼쪽에서 오므로 제자리(0)를 지나 오른쪽(+)으로 넘어가는 구간이 있어야 한다.
      if (transformAt(doc, i / 40).translateX > 0) overshoot = true
    }
    expect(overshoot).toBe(true)
  })
})

/**
 * 이름과 실제 방향이 맞는가.
 *
 * '아래에서' 가 '위에서' 와 똑같이 움직이던 버그는 **이름만 보고는 아무도 못 잡는
 * 종류**였다. 화면을 켜 놓고 두 개를 나란히 돌려 보기 전에는 티가 안 난다.
 * 그래서 이름에서 방향을 읽어 내 실제 그림과 대조한다. 이름을 바꾸면 여기가 깨진다.
 */
describe('프리셋 이름과 방향', () => {
  const TEXT_PRESETS = MOTION_PRESETS.filter((p) => p.category === 'text')

  /** 라벨에 적힌 출발 방향. 없으면 방향을 주장하지 않는 이름이다. */
  function claimedDirection(label: string): { x: number; y: number } | null {
    // '좌우에서 번갈아' 처럼 두 방향을 함께 말하는 이름은 한쪽을 주장하지 않는다.
    if (label.includes('번갈아')) return null
    if (label.includes('왼쪽에서')) return { x: -1, y: 0 }
    if (label.includes('오른쪽에서')) return { x: 1, y: 0 }
    if (label.includes('위에서')) return { x: 0, y: -1 }
    if (label.includes('아래에서')) return { x: 0, y: 1 }
    return null
  }

  it('글자 카테고리에 방향을 주장하는 이름이 남아 있다', () => {
    // 이름이 다 바뀌어 검사할 것이 없어지면 이 테스트가 조용히 통과한다. 그걸 막는다.
    expect(TEXT_PRESETS.filter((p) => claimedDirection(p.label)).length).toBeGreaterThanOrEqual(4)
  })

  for (const preset of TEXT_PRESETS) {
    const claim = claimedDirection(preset.label)
    if (!claim) continue

    it(`${preset.id} 는 이름대로 ${preset.label.slice(0, 5)} 온다`, () => {
      const { doc: base } = imageDoc()
      const doc = buildPreviewDoc({
        doc: base,
        layerId: base.layers[0]!.id,
        presetId: preset.id,
        strength: 0.5,
        speed: 1,
        params: {},
      })
      const t = resolveComposition(doc, 0)[0]!.transform
      expect(Math.sign(t.translateX), '가로').toBe(claim.x)
      expect(Math.sign(t.translateY), '세로').toBe(claim.y)
    })
  }

  it('글자 프리셋을 이미지에 걸면 실제로 움직인다', () => {
    // 예전에는 charIn 트랙을 이미지가 아무도 안 읽어서 아무 일도 일어나지 않았다.
    const { doc: base } = imageDoc()
    const doc = buildPreviewDoc({
      doc: base,
      layerId: base.layers[0]!.id,
      presetId: 'text.slideLeft',
      strength: 0.5,
      speed: 1,
      params: {},
    })
    const start = resolveComposition(doc, 0)[0]!.transform
    const end = resolveComposition(doc, doc.timeline.durationFrames - 1)[0]!.transform
    expect(start.translateX).toBeLessThan(-1)
    expect(end.translateX).toBe(0)
  })
})
