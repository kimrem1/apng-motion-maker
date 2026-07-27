/**
 * 오버스캔 솔버.
 *
 * 9.5 의 500px 캔버스 / 600px 원본 예시를 그대로 케이스로 쓴다.
 * 이 값들은 실제 WebGL 렌더러에서 픽셀 판독으로도 확인했다.
 */

import { describe, expect, it } from 'vitest'

import {
  diagnose,
  isSolverTarget,
  modifierHeadroom,
  requiredScaleAt,
  sampleFrames,
  solveLayerOverscan,
  solveOverscan,
} from '@/core/overscan.ts'
import { resolveComposition } from '@/core/evaluate.ts'
import { createEmptyProject, createImageLayer, createStaticTrack, resetIdCounter } from '@/core/factory.ts'
import { identityTransform } from '@/core/transform.ts'
import type { AssetRef, Layer, MotionProject, ResolvedTransform } from '@/core/types.ts'

function setup(): { doc: MotionProject; layer: Layer } {
  resetIdCounter()
  const doc = createEmptyProject()
  doc.canvas.w = 500
  doc.canvas.h = 500
  doc.timeline.durationFrames = 30

  const asset: AssetRef = {
    id: 'a1', name: 'img', storeKey: 'k', naturalW: 600, naturalH: 600, hasAlpha: true,
  }
  doc.assets = [asset]
  const layer = createImageLayer(asset, 0)
  // 이 파일은 채우기 솔버를 본다. 레이어 기본값은 '원본 크기 그대로'(fit: none,
  // 담기/채우기 모두 꺼짐)라서 명시적으로 채우기로 돌린다. fit 까지 바꿔야 한다.
  // isSolverTarget 이 fit 이 cover / fill 일 때만 솔버를 돌리기 때문이다.
  // 담기 솔버는 contain.test.ts 가 따로 본다.
  layer.fit = 'cover'
  layer.fillsCanvas = true
  layer.keepInside = false
  doc.layers = [layer]
  return { doc, layer }
}

const tf = (patch: Partial<ResolvedTransform>): ResolvedTransform => ({ ...identityTransform(), ...patch })

describe('requiredScaleAt', () => {
  it('모션이 없으면 캔버스/이미지 비율 그대로다', () => {
    // s_min = 500 / 600 = 0.8333
    expect(requiredScaleAt(500, 500, 600, 600, tf({}))).toBeCloseTo(500 / 600, 9)
  })

  it('9.5 경우 C: 좌우 이동 30px 이면 s_min = 560/600', () => {
    const s = requiredScaleAt(500, 500, 600, 600, tf({ translateX: 30 }))
    expect(s).toBeCloseTo(560 / 600, 9)
    // k_required = 0.9333 / 0.8333 = 1.12
    expect(s / (500 / 600)).toBeCloseTo(1.12, 6)
  })

  it('9.5 경우 C 확장: 이동 60px(12%) 이면 원본이 부족해진다', () => {
    const s = requiredScaleAt(500, 500, 600, 600, tf({ translateX: 60 }))
    expect(s).toBeCloseTo(620 / 600, 9)
    expect(s).toBeGreaterThan(1) // s > 1 이면 업스케일
    expect(s / (500 / 600)).toBeCloseTo(1.24, 6)
  })

  it('9.5 경우 D: 회전 6도 이면 k_required = 1.099', () => {
    const s = requiredScaleAt(500, 500, 600, 600, tf({ rotate: 6 }))
    // W' = 500*cos6 + 500*sin6 = 549.5
    expect(s * 600).toBeCloseTo(549.5, 0)
    expect(s / (500 / 600)).toBeCloseTo(1.099, 2)
    expect(s).toBeLessThan(1) // 600px 원본으로 충분
  })

  it('9.5 경우 E: 회전 45도 이면 k_required = 1.414', () => {
    const s = requiredScaleAt(500, 500, 600, 600, tf({ rotate: 45 }))
    // W' = 500 * (cos45 + sin45) = 707.1
    expect(s * 600).toBeCloseTo(707.1, 0)
    expect(s / (500 / 600)).toBeCloseTo(1.4142, 3)
    expect(s).toBeGreaterThan(1) // 원본 부족
  })

  it('회전 90도는 폭과 높이를 맞바꾼다', () => {
    const s0 = requiredScaleAt(400, 800, 600, 600, tf({}))
    const s90 = requiredScaleAt(400, 800, 600, 600, tf({ rotate: 90 }))
    expect(s90).toBeCloseTo(s0, 9)
  })

  it('회전과 이동이 함께 있으면 로컬 좌표계로 옮긴 이동량을 쓴다', () => {
    // 45도에서 (30, 30) 이동은 로컬 x 축으로 42.4px 한 방향에 몰린다
    const s = requiredScaleAt(500, 500, 600, 600, tf({ rotate: 45, translateX: 30, translateY: 30 }))
    const expected = (500 * Math.SQRT2 + 2 * Math.hypot(30, 30)) / 600
    expect(s).toBeCloseTo(expected, 6)
  })

  it('skew 는 보수적으로 더 크게 잡는다', () => {
    const none = requiredScaleAt(500, 500, 600, 600, tf({}))
    const skewed = requiredScaleAt(500, 500, 600, 600, tf({ skewX: 10 }))
    expect(skewed).toBeGreaterThan(none)
  })
})

describe('시간축 최대화', () => {
  it('오버슈트 이징이 만드는 중간 최댓값을 잡는다', () => {
    // 키프레임 값만 보면 1.0 -> 1.2 지만, popBack 은 중간에 더 커진다.
    // 커지는 방향이라 캔버스는 안 비지만, 반대로 작아지는 오버슈트는 위험하다.
    const { doc, layer } = setup()
    layer.tracks = [
      {
        id: 't1', prop: 'scale', unit: 'ratio',
        keys: [
          { f: 0, v: 1.2, interp: 'bezier', out: { x: 0.34, y: 1.25 } },
          { f: 29, v: 1.0, interp: 'bezier', in: { x: 0.64, y: 1 } },
        ],
      },
    ]

    // 이 곡선은 목표(1.0) 아래로 언더슈트한다. 그 순간 캔버스가 빈다.
    const frames = sampleFrames(doc, layer, 240)
    expect(frames.length).toBeGreaterThan(240)

    const need = solveLayerOverscan(doc, layer, 600, 600)
    // 언더슈트가 1.0 아래로 내려가므로 보정이 붙어야 한다
    expect(need.correction).toBeGreaterThanOrEqual(1)
  })

  it('키프레임 시각과 출력 프레임 시각이 샘플에 포함된다', () => {
    const { doc, layer } = setup()
    layer.tracks = [
      {
        id: 't1', prop: 'rotate', unit: 'deg',
        keys: [
          { f: 0, v: 0, interp: 'linear' },
          { f: 7, v: 45, interp: 'linear' },
          { f: 29, v: 0, interp: 'linear' },
        ],
      },
    ]
    const frames = sampleFrames(doc, layer, 240)
    expect(frames).toContain(0)
    expect(frames).toContain(7)
    expect(frames).toContain(29)
    for (let f = 0; f <= 29; f++) expect(frames).toContain(f)
  })
})

describe('solveLayerOverscan', () => {
  it('9.5 경우 A: k 1.0 -> 1.2 확대는 솔버가 개입하지 않는다', () => {
    const { doc, layer } = setup()
    layer.tracks = [
      {
        id: 't1', prop: 'scale', unit: 'ratio',
        keys: [
          { f: 0, v: 1.0, interp: 'linear' },
          { f: 29, v: 1.2, interp: 'linear' },
        ],
      },
    ]
    const need = solveLayerOverscan(doc, layer, 600, 600)
    // 전 구간 k >= 1 이라 보정 불필요. 마진만큼만 아주 살짝 붙는다.
    expect(need.correction).toBeLessThan(1.01)
    expect(need.needsUpscale).toBe(false)
  })

  it('9.5 경우 E: 회전 45도는 k 1.414 를 요구한다', () => {
    const { doc, layer } = setup()
    layer.tracks = [createStaticTrack('rotate', 'deg', 45)]
    const need = solveLayerOverscan(doc, layer, 600, 600, { marginRatio: 0 })
    expect(need.kRequired).toBeCloseTo(1.4142, 3)
    expect(need.correction).toBeCloseTo(1.4142, 3)
    expect(need.needsUpscale).toBe(true)
    expect(need.recommendedSourcePx).toBe(Math.ceil(500 * need.kRequired))
  })

  it('이동 12% 는 k 1.24 를 요구한다 (9.5 경우 C)', () => {
    const { doc, layer } = setup()
    layer.tracks = [createStaticTrack('translateX', 'percentOfCanvas', 12)]
    const need = solveLayerOverscan(doc, layer, 600, 600, { marginRatio: 0 })
    expect(need.kRequired).toBeCloseTo(1.24, 4)
  })

  it('결합 이후에 풀어야 한다: 이동 + 회전이 겹치면 각각보다 커진다', () => {
    const { doc, layer } = setup()
    layer.tracks = [
      createStaticTrack('translateX', 'percentOfCanvas', 12),
      createStaticTrack('rotate', 'deg', 6),
    ]
    const both = solveLayerOverscan(doc, layer, 600, 600, { marginRatio: 0 })

    const moveOnly = setup()
    moveOnly.layer.tracks = [createStaticTrack('translateX', 'percentOfCanvas', 12)]
    const a = solveLayerOverscan(moveOnly.doc, moveOnly.layer, 600, 600, { marginRatio: 0 })

    const rotOnly = setup()
    rotOnly.layer.tracks = [createStaticTrack('rotate', 'deg', 6)]
    const b = solveLayerOverscan(rotOnly.doc, rotOnly.layer, 600, 600, { marginRatio: 0 })

    expect(both.kRequired).toBeGreaterThan(a.kRequired)
    expect(both.kRequired).toBeGreaterThan(b.kRequired)
  })

  it('fillsCanvas 가 false 면 대상이 아니다', () => {
    const { doc, layer } = setup()
    layer.fillsCanvas = false
    layer.tracks = [createStaticTrack('rotate', 'deg', 45)]
    const need = solveLayerOverscan(doc, layer, 600, 600)
    expect(need.correction).toBe(1)
  })

  it('contain 은 캔버스를 채울 의도가 아니므로 대상이 아니다', () => {
    const { layer } = setup()
    layer.fit = 'contain'
    expect(isSolverTarget(layer, 'autoFit')).toBe(false)
  })

  it('allowEmpty 정책은 솔버를 끈다 (슬라이드 아웃 프리셋용)', () => {
    const { doc, layer } = setup()
    layer.tracks = [createStaticTrack('rotate', 'deg', 45)]
    const need = solveLayerOverscan(doc, layer, 600, 600, { policy: 'allowEmpty' })
    expect(need.correction).toBe(1)
  })
})

describe('모디파이어 여유분', () => {
  it('정규화된 fBm 의 실제 상한을 잡는다', () => {
    const { layer } = setup()
    layer.modifiers = [
      {
        id: 'm1', type: 'loopNoise', target: 'translateX', blendOp: 'add', seed: 1,
        amplitude: 6, cycles: 3, octaves: 2, persistence: 0.5, lacunarity: 2,
        holdFrames: 1, decay: 0,
      },
    ]
    // 흔히 쓰는 amplitude * Σoctave (= 6 * 1.5 = 9) 는 정규화하지 않는 fBm 을 전제한다. generators.ts 의 fbmLoop 은 가중 평균을
    // 정규화하므로 옥타브 수와 무관하게 [-1,1] 을 넘지 않는다. 실제 상한은 6 이다.
    // 과하게 잡으면 원본을 더 확대해 화질이 손해다.
    expect(modifierHeadroom(layer).translate).toBeCloseTo(6, 9)
  })

  it('모디파이어가 없으면 0 이다', () => {
    const { layer } = setup()
    expect(modifierHeadroom(layer)).toEqual({ translate: 0, rotateDeg: 0 })
  })
})

describe('resolveComposition 통합', () => {
  it('보정 계수가 scale 채널에 곱해진다', () => {
    const { doc, layer } = setup()
    layer.tracks = [createStaticTrack('rotate', 'deg', 45)]

    const before = resolveComposition(doc, 0)
    expect(before[0]!.transform.scaleX).toBeCloseTo(1, 9)

    const map = solveOverscan(doc, () => ({ width: 600, height: 600 }))
    const after = resolveComposition(doc, 0, map)
    expect(after[0]!.transform.scaleX).toBeCloseTo(1.4142 * 1.005, 2)
    expect(after[0]!.transform.scaleY).toBeCloseTo(after[0]!.transform.scaleX, 9)
    // 회전은 건드리지 않는다
    expect(after[0]!.transform.rotate).toBe(45)
  })

  it('보정 후에는 전 구간에서 캔버스가 찬다', () => {
    const { doc, layer } = setup()
    layer.tracks = [
      {
        id: 't1', prop: 'rotate', unit: 'deg',
        keys: [
          { f: 0, v: 0, interp: 'linear' },
          { f: 29, v: 45, interp: 'linear' },
        ],
      },
      createStaticTrack('translateX', 'percentOfCanvas', 5),
    ]
    const map = solveOverscan(doc, () => ({ width: 600, height: 600 }))

    for (let f = 0; f <= 29; f++) {
      const [resolved] = resolveComposition(doc, f, map)
      const t = resolved!.transform
      const need = requiredScaleAt(500, 500, 600, 600, t)
      const actual = (500 / 600) * Math.min(t.scaleX, t.scaleY)
      expect(actual, `frame ${f}: 실제 ${actual} < 필요 ${need}`).toBeGreaterThanOrEqual(need - 1e-9)
    }
  })
})

describe('진단 문구', () => {
  it('원본이 충분하면 아무 말도 하지 않는다', () => {
    const { doc, layer } = setup()
    expect(diagnose(solveLayerOverscan(doc, layer, 600, 600), 600).level).toBe('ok')
  })

  it('크게 부족하면 배경 채우기를 제안한다', () => {
    const { doc, layer } = setup()
    layer.tracks = [createStaticTrack('rotate', 'deg', 45)]
    const need = solveLayerOverscan(doc, layer, 600, 600)
    const d = diagnose(need, 600)
    expect(d.level).toBe('warn')
    expect(d.suggestBackgroundFill).toBe(true)
    // 처방을 말한다. 배율 숫자를 들이밀지 않는다.
    expect(d.message).toContain('px 이상이면 좋습니다')
    expect(d.message).not.toContain('배율')
  })
})

describe('부모 이동 상속', () => {
  it('parallaxFactor 만큼 부모의 이동을 물려받는다', async () => {
    const { resolveLayerTransformWithParents } = await import('@/core/evaluate.ts')
    const { doc } = setup()
    const bg = doc.layers[0]!
    bg.tracks = [createStaticTrack('translateX', 'px', 100)]

    const fg = createImageLayer(doc.assets[0]!, 1)
    fg.parentId = bg.id
    fg.parallaxFactor = 0.35
    doc.layers.push(fg)

    const t = resolveLayerTransformWithParents(doc, fg, 0)
    expect(t.translateX).toBeCloseTo(35, 9)
  })

  it('순환 참조에서도 멈춘다', async () => {
    const { resolveLayerTransformWithParents } = await import('@/core/evaluate.ts')
    const { doc } = setup()
    const a = doc.layers[0]!
    const b = createImageLayer(doc.assets[0]!, 1)
    doc.layers.push(b)
    a.parentId = b.id
    b.parentId = a.id
    expect(() => resolveLayerTransformWithParents(doc, a, 0)).not.toThrow()
  })

  it('오버스캔 솔버가 물려받은 이동까지 본다', () => {
    const { doc } = setup()
    const bg = doc.layers[0]!
    bg.tracks = [createStaticTrack('translateX', 'percentOfCanvas', 12)]

    const fg = createImageLayer(doc.assets[0]!, 1)
    fg.parentId = bg.id
    fg.parallaxFactor = 1
    fg.fit = 'cover'
    fg.fillsCanvas = true
    doc.layers.push(fg)

    const need = solveLayerOverscan(doc, fg, 600, 600, { marginRatio: 0 })
    // 자기 트랙은 비었지만 부모가 12% 움직이므로 k 1.24 가 필요하다
    expect(need.kRequired).toBeCloseTo(1.24, 4)
  })
})
