/**
 * 담기 솔버: 원본이 프레임 밖으로 나가 잘리지 않게 배율을 낮춘다.
 *
 * 채우기(오버스캔)의 거울상이다. 채우기는 캔버스가 비지 않게 이미지를 키우고,
 * 담기는 오브제가 잘리지 않게 이미지를 줄인다. 둘은 같은 레이어에 동시에 걸 수 없다.
 *
 * 이 파일의 핵심은 마지막 검사다. 카탈로그 56종을 전부 적용해 보고 **한 프레임도**
 * 프레임 밖으로 나가지 않는지 본다. 프리셋 하나가 조용히 깨져도 사용자가 그것을
 * 고르기 전까지 아무도 모르는 종류의 코드이기 때문이다.
 */

import { describe, expect, it } from 'vitest'

import { createEmptyProject, createImageLayer, createStaticTrack, resetIdCounter } from '@/core/factory.ts'
import { resolveComposition } from '@/core/evaluate.ts'
import { isContainTarget, solveLayerContain, solveOverscan } from '@/core/overscan.ts'
import { buildLayerMatrix } from '@/core/transform.ts'
import type { AssetRef, FrameFit, Layer, MotionProject } from '@/core/types.ts'
import { MOTION_PRESETS } from '@/motions/registry.ts'
import { buildPreviewDoc } from '@/motions/apply.ts'

const SIZE = 500

function setup(imageW = SIZE, imageH = SIZE): { doc: MotionProject; layer: Layer } {
  resetIdCounter()
  const doc = createEmptyProject()
  doc.canvas.w = SIZE
  doc.canvas.h = SIZE
  doc.timeline.durationFrames = 30

  const asset: AssetRef = {
    id: 'a1', name: 'img', storeKey: 'k', naturalW: imageW, naturalH: imageH, hasAlpha: true,
  }
  doc.assets = [asset]
  const layer = createImageLayer(asset, 0)
  doc.layers = [layer]
  return { doc, layer }
}

/** 변환된 이미지 사각형이 캔버스 밖으로 나간 최대 px. 음수면 여백이 있다는 뜻이다. */
function overflowPx(doc: MotionProject, resolved: ReturnType<typeof resolveComposition>[number]): number {
  const m = buildLayerMatrix(
    resolved.transform, resolved.fit, doc.canvas.w, doc.canvas.h,
    doc.assets[0]!.naturalW, doc.assets[0]!.naturalH,
  )
  const halfW = doc.canvas.w / 2
  const halfH = doc.canvas.h / 2
  let out = -Infinity
  for (const [u, v] of [[0, 0], [1, 0], [0, 1], [1, 1]] as [number, number][]) {
    const x = m[0]! * u + m[3]! * v + m[6]!
    const y = m[1]! * u + m[4]! * v + m[7]!
    out = Math.max(out, Math.abs(x) - halfW, Math.abs(y) - halfH)
  }
  return out
}

describe('담기 대상 판정', () => {
  it('이미지 레이어의 기본값은 담기다', () => {
    const { layer } = setup()
    expect(layer.keepInside).toBe(true)
    expect(layer.fillsCanvas).toBe(false)
    expect(isContainTarget(layer)).toBe(true)
  })

  it('채우기가 켜져 있으면 담기는 비켜선다', () => {
    const { layer } = setup()
    layer.fillsCanvas = true
    expect(isContainTarget(layer)).toBe(false)
  })

  it('일부러 프레임 밖으로 나가는 모션에는 개입하지 않는다', () => {
    const { layer } = setup()
    layer.motionExitsFrame = true
    expect(isContainTarget(layer)).toBe(false)
  })

  it('숨긴 레이어는 계산하지 않는다', () => {
    const { layer } = setup()
    layer.visible = false
    expect(isContainTarget(layer)).toBe(false)
  })
})

describe('solveLayerContain', () => {
  it('움직임이 없으면 손대지 않는다', () => {
    const { doc, layer } = setup()
    expect(solveLayerContain(doc, layer, SIZE, SIZE).correction).toBe(1)
  })

  it('45도 회전한 정사각형은 대각선만큼 줄어든다', () => {
    const { doc, layer } = setup()
    layer.tracks = [createStaticTrack('rotate', 'deg', 45)]
    // 한 변 1 인 정사각형의 대각선은 √2 다. 프레임에 담으려면 1/√2 로 줄여야 한다.
    const need = solveLayerContain(doc, layer, SIZE, SIZE)
    expect(need.correction).toBeCloseTo(Math.SQRT1_2 * 0.995, 3)
  })

  it('90도 회전은 정사각형에서 아무 영향이 없다', () => {
    const { doc, layer } = setup()
    layer.tracks = [createStaticTrack('rotate', 'deg', 90)]
    expect(solveLayerContain(doc, layer, SIZE, SIZE).correction).toBe(1)
  })

  it('이동한 만큼 더 줄인다', () => {
    const { doc, layer } = setup()
    layer.tracks = [createStaticTrack('translateX', 'px', 50)]
    // 오른쪽 끝이 250 + 50 = 300 에 있다. 250 안에 넣으려면 폭을 400 으로 줄여야
    // 오른쪽 끝이 50 + 200 = 250 이 된다. 즉 0.8 이다.
    const need = solveLayerContain(doc, layer, SIZE, SIZE)
    expect(need.correction).toBeCloseTo(0.8 * 0.995, 4)
  })

  it('확대는 프레임에 딱 맞을 때까지만 허용한다', () => {
    const { doc, layer } = setup()
    layer.tracks = [createStaticTrack('scale', 'ratio', 1.5)]
    const need = solveLayerContain(doc, layer, SIZE, SIZE)
    expect(need.correction).toBeCloseTo((1 / 1.5) * 0.995, 4)
  })

  it('축소만 하는 모션은 손대지 않는다', () => {
    const { doc, layer } = setup()
    layer.tracks = [createStaticTrack('scale', 'ratio', 0.6)]
    expect(solveLayerContain(doc, layer, SIZE, SIZE).correction).toBe(1)
  })

  it('흔들림 모디파이어의 진폭도 반영한다', () => {
    const { doc, layer } = setup()
    layer.modifiers = [{
      id: 'm1', type: 'sine', target: 'translateX', blendOp: 'add', seed: 1,
      amplitude: 40, cycles: 2, octaves: 1, persistence: 0.5, lacunarity: 2,
      holdFrames: 1, decay: 0,
    }]
    const need = solveLayerContain(doc, layer, SIZE, SIZE)
    // 트랙은 비어 있지만 모디파이어가 40px 를 흔든다. 오른쪽 끝이 250 안에 들어오려면
    // 폭이 (250 - 40) * 2 = 420 이어야 하므로 0.84 다.
    // 해결된 변환에 이미 들어 있는 흔들림 값에 최대 진폭을 또 더하면 0.68 로 떨어진다.
    expect(need.correction).toBeCloseTo(0.84 * 0.995, 2)
  })

  it('중심이 프레임을 벗어나면 하한에서 멈추고 잘림을 알린다', () => {
    const { doc, layer } = setup()
    layer.tracks = [createStaticTrack('translateX', 'px', 400)]
    const need = solveLayerContain(doc, layer, SIZE, SIZE)
    expect(need.correction).toBe(0.2)
    expect(need.clipped).toBe(true)
  })

  it('세로로 긴 원본은 세로 기준으로 담긴다', () => {
    // 500x1000 원본, 500x500 캔버스. fit 이 cover 라 기준 배율이 1.0 이고
    // 세로가 두 배로 넘친다. 담기가 절반으로 줄여야 한다.
    const { doc, layer } = setup(SIZE, SIZE * 2)
    const need = solveLayerContain(doc, layer, SIZE, SIZE * 2)
    expect(need.correction).toBeCloseTo(0.5 * 0.995, 4)
  })
})

describe('resolveComposition 통합', () => {
  it('1 보다 작은 보정도 배율 채널에 곱해진다', () => {
    const { doc } = setup()
    doc.layers[0]!.tracks = [createStaticTrack('scale', 'ratio', 2)]
    const map = solveOverscan(doc, () => ({ width: SIZE, height: SIZE }))
    const after = resolveComposition(doc, 0, map)
    // 원래 배율 2 에 보정 0.5 가 곱해져 1 근처로 내려온다.
    expect(after[0]!.transform.scaleX).toBeCloseTo(2 * 0.5 * 0.995, 3)
    expect(after[0]!.transform.scaleY).toBeCloseTo(after[0]!.transform.scaleX, 9)
  })

  it('담기 레이어에는 채우기 보정이 걸리지 않는다', () => {
    const { doc } = setup(600, 600)
    doc.layers[0]!.tracks = [createStaticTrack('translateX', 'px', 60)]
    const map = solveOverscan(doc, () => ({ width: 600, height: 600 }))
    expect(map.get(doc.layers[0]!.id)!.mode).toBe('contain')
    expect(map.get(doc.layers[0]!.id)!.correction).toBeLessThan(1)
  })
})

describe('카탈로그 전체 회귀', () => {
  /**
   * 프리셋 하나를 적용한 문서에서 전 프레임을 훑어 가장 많이 삐져나간 px 를 잰다.
   * 출력 프레임만 본다. 실제로 저장되는 그림이 그것이기 때문이다.
   */
  function worstOverflow(presetId: string): number {
    const { doc: base } = setup()
    const layerId = base.layers[0]!.id
    const doc = buildPreviewDoc({
      doc: base, layerId, presetId, strength: 0.5, speed: 1, params: {},
    })
    const map = solveOverscan(doc, () => ({ width: SIZE, height: SIZE }))
    let worst = -Infinity
    for (let f = 0; f < doc.timeline.durationFrames; f += 1) {
      for (const resolved of resolveComposition(doc, f, map)) {
        if (!resolved.assetId) continue
        worst = Math.max(worst, overflowPx(doc, resolved))
      }
    }
    return worst
  }

  const exiting = MOTION_PRESETS.filter((p) => p.overscan === 'allowEmpty').map((p) => p.id)

  it('프레임 밖으로 나가는 프리셋은 세 종뿐이다', () => {
    // 이 목록이 늘면 담기에서 빠지는 프리셋이 늘었다는 뜻이다. 의도한 것인지
    // 확인하고 여기를 고쳐야 한다.
    expect(exiting.sort()).toEqual(['combo.slideFadeGlitch', 'slide.inFade', 'slide.outFade'])
  })

  for (const preset of MOTION_PRESETS) {
    if (exiting.includes(preset.id)) continue
    it(`${preset.id} 는 원본을 자르지 않는다`, () => {
      // 0 이면 가장자리에 정확히 닿은 것이다. 서브픽셀 오차만 허용한다.
      expect(worstOverflow(preset.id)).toBeLessThanOrEqual(0.01)
    })
  }

  it('일부러 나가는 프리셋은 실제로 프레임을 벗어난다', () => {
    // 담기가 이쪽까지 잡으면 슬라이드 사라짐이 가장자리에 붙어 멈춘다.
    for (const id of exiting) expect(worstOverflow(id)).toBeGreaterThan(1)
  })
})

/**
 * 세기 슬라이더가 화면에서 실제로 움직임을 바꾸는가.
 *
 * 담기를 지금 세기로 매번 다시 풀면 안 된다. 담기는 "안 잘리는 선에서 최대한 크게" 를
 * 구하므로 모션의 극단이 항상 프레임에 딱 맞고, 세기를 올려도 그림이 훑는 범위가
 * 그대로다. 한쪽으로만 가는 프리셋에서는 오히려 줄어든다.
 * 그래서 기준값을 세기 1.0 에서 한 번만 재고 그 값을 고정한다.
 */
describe('세기 반응', () => {
  /** 전 프레임에 걸쳐 그림이 차지한 가로 구간과, 그림 자체의 최대 폭. */
  function measure(presetId: string, strength: number) {
    const { doc: base } = setup()
    const doc = buildPreviewDoc({
      doc: base, layerId: base.layers[0]!.id, presetId, strength, speed: 1, params: {},
    })
    const map = solveOverscan(doc, () => ({ width: SIZE, height: SIZE }))
    let unionLo = Infinity, unionHi = -Infinity, widest = 0
    for (let f = 0; f < doc.timeline.durationFrames; f += 1) {
      for (const L of resolveComposition(doc, f, map)) {
        if (!L.assetId) continue
        const m = buildLayerMatrix(L.transform, L.fit, doc.canvas.w, doc.canvas.h, SIZE, SIZE)
        let lo = Infinity, hi = -Infinity
        for (const [u, v] of [[0, 0], [1, 0], [0, 1], [1, 1]] as [number, number][]) {
          const x = m[0]! * u + m[3]! * v + m[6]!
          lo = Math.min(lo, x); hi = Math.max(hi, x)
        }
        unionLo = Math.min(unionLo, lo); unionHi = Math.max(unionHi, hi)
        widest = Math.max(widest, hi - lo)
      }
    }
    return { sweep: unionHi - unionLo, widest }
  }

  /** 세기가 진폭을 바꾸는 프리셋. 페이드 계열은 세기와 무관하므로 뺀다. */
  const RESPONSIVE = [
    'slide.left', 'slide.panLR', 'slide.diagonal', 'slide.drift',
    'zoom.slowIn', 'zoom.slowOut', 'zoom.upIn', 'rotate.cw', 'rotate.sway',
    'kb.classic', 'kb.random', 'shake.camera', 'skew.shear',
  ]

  for (const id of RESPONSIVE) {
    it(`${id} 는 세기를 올리면 더 크게 움직인다`, () => {
      const lo = measure(id, 0.1)
      const mid = measure(id, 0.5)
      const hi = measure(id, 0.9)
      // 단조 증가여야 한다. 예전에는 slide 계열이 480 -> 458 -> 436 으로 거꾸로 갔다.
      expect(mid.sweep).toBeGreaterThan(lo.sweep)
      expect(hi.sweep).toBeGreaterThan(mid.sweep)
    })

    it(`${id} 는 세기를 바꿔도 그림 크기가 그대로다`, () => {
      // 슬라이더를 끌 때 그림이 출렁이면 무엇이 바뀌는지 읽을 수 없다.
      const lo = measure(id, 0.1)
      const hi = measure(id, 0.9)
      // 배율이 바뀌는 프리셋(줌)은 최대 폭이 커지므로 작아지지만 않으면 된다.
      expect(hi.widest).toBeGreaterThanOrEqual(lo.widest - 0.5)
    })
  }

  it('기준값은 세기와 무관하게 같다', () => {
    const a = buildPreviewDoc({
      doc: setup().doc, layerId: 'l1', presetId: 'slide.left', strength: 0.1, speed: 1, params: {},
    })
    const b = buildPreviewDoc({
      doc: setup().doc, layerId: 'l1', presetId: 'slide.left', strength: 0.9, speed: 1, params: {},
    })
    expect(a.layers[0]!.containScale).toBeDefined()
    expect(a.layers[0]!.containScale).toBeCloseTo(b.layers[0]!.containScale!, 9)
  })

  it('기준값은 하한 아래로 내려가지 않는다', () => {
    // 한 점으로 파고드는 사진 훑기는 세기 1.0 기준이면 33% 까지 내려간다.
    // 그 크기로는 스티커가 스티커로 보이지 않는다.
    for (const id of MOTION_PRESETS.map((p) => p.id)) {
      const doc = buildPreviewDoc({
        doc: setup().doc, layerId: 'l1', presetId: id, strength: 0.5, speed: 1, params: {},
      })
      const ref = doc.layers[0]!.containScale
      if (ref !== undefined) expect(ref).toBeGreaterThanOrEqual(0.6)
    }
  })

  it('기준값보다 크게 손본 레이어는 문서 기반 계산이 이긴다', () => {
    // 기준값만 믿으면 PRO 에서 키프레임을 프리셋 최대치보다 크게 늘렸을 때 잘린다.
    const { doc, layer } = setup()
    layer.containScale = 0.95
    layer.tracks = [createStaticTrack('translateX', 'px', 150)]
    const map = solveOverscan(doc, () => ({ width: SIZE, height: SIZE }))
    const need = map.get(layer.id)!
    expect(need.mode).toBe('contain')
    // 150px 밀렸으면 (250-150)/250 = 0.4 여야 한다. 0.95 를 쓰면 잘린다.
    expect(need.correction).toBeCloseTo(0.4 * 0.995, 3)
  })
})

/**
 * 세 가지 프레임 처리.
 *
 * 스티커냐 배경 사진이냐로 답이 갈린다. 셋의 차이가 무너지면 사용자는 고를 이유를
 * 잃는다. 그래서 "무엇이 잘리고 무엇이 남는가" 를 각각 못박는다.
 */
describe('프레임 처리 세 가지', () => {
  /** 500px 캔버스에 500px 원본. 배율 1.2 로 확대하는 트랙 하나. */
  function zoomed(fit: FrameFit) {
    const { doc, layer } = setup()
    layer.keepInside = fit === 'contain'
    layer.fillsCanvas = fit === 'cover'
    layer.tracks = [createStaticTrack('scale', 'ratio', 1.2)]
    const map = solveOverscan(doc, () => ({ width: SIZE, height: SIZE }))
    const resolved = resolveComposition(doc, 0, map)[0]!
    const m = buildLayerMatrix(resolved.transform, resolved.fit, SIZE, SIZE, SIZE, SIZE)
    // 유닛 사각형 폭 = m[0] (회전/기울임이 없으므로 x 축 성분이 그대로 폭이다)
    return { 그림폭: m[0]!, 캔버스: doc.canvas.w }
  }

  it('잘리지 않게: 확대해도 프레임 안에 들어온다', () => {
    const r = zoomed('contain')
    expect(r.그림폭).toBeLessThanOrEqual(r.캔버스)
    expect(r.그림폭).toBeCloseTo(SIZE * 0.995, 0)
  })

  it('원본 크기 그대로: 확대분이 프레임 밖으로 나가고 캔버스는 그대로다', () => {
    const r = zoomed('crop')
    // 500px 원본이 1.2 배가 되어 600px. 캔버스는 500px 를 유지하므로 좌우 50px 씩 잘린다.
    expect(r.그림폭).toBeCloseTo(600, 6)
    expect(r.캔버스).toBe(500)
  })

  it('여백 없이 채우기: 확대는 그대로 두고 캔버스도 그대로다', () => {
    // 확대만 하는 모션은 캔버스를 비우지 않는다. 채우기 솔버가 더 키울 이유가 없다.
    const r = zoomed('cover')
    expect(r.그림폭).toBeGreaterThanOrEqual(600)
    expect(r.캔버스).toBe(500)
  })

  /** 좌우로 이동하는 트랙 하나. 전 프레임에서 캔버스가 비는 최대 px. */
  function slideGap(fit: FrameFit): number {
    const { doc, layer } = setup()
    layer.keepInside = fit === 'contain'
    layer.fillsCanvas = fit === 'cover'
    layer.tracks = [{
      id: 't1', prop: 'translateX', unit: 'px', animated: true,
      keys: [
        { f: 0, v: -60, interp: 'linear' },
        { f: 29, v: 60, interp: 'linear' },
      ],
    }]
    const map = solveOverscan(doc, () => ({ width: SIZE, height: SIZE }))
    const half = SIZE / 2
    let gap = 0
    for (let f = 0; f < doc.timeline.durationFrames; f += 1) {
      const resolved = resolveComposition(doc, f, map)[0]!
      const m = buildLayerMatrix(resolved.transform, resolved.fit, SIZE, SIZE, SIZE, SIZE)
      let lo = Infinity, hi = -Infinity
      for (const u of [0, 1]) {
        const x = m[0]! * u + m[6]!
        lo = Math.min(lo, x); hi = Math.max(hi, x)
      }
      // 왼쪽이나 오른쪽에 그림이 닿지 않은 만큼이 빈 곳이다.
      gap = Math.max(gap, lo - -half, half - hi)
    }
    return gap
  }

  it('이동에서 여백 없이 채우기만 빈 곳을 만들지 않는다', () => {
    // 배경 풍경이 천천히 흐르는 모션이 이쪽이다. 한쪽 끝에 빈 띠가 생기면 배경이 아니다.
    expect(slideGap('cover')).toBeLessThanOrEqual(0.01)
    // 나머지 둘은 빈다. 원본 크기 그대로는 이동한 만큼, 잘리지 않게는 줄인 만큼.
    expect(slideGap('crop')).toBeCloseTo(60, 0)
    expect(slideGap('contain')).toBeGreaterThan(0)
  })
})
