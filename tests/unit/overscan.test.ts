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
import { buildLayerMatrix, identityTransform } from '@/core/transform.ts'
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

/**
 * 렌더러와 같은 매트릭스로 이미지 사각형을 만들어 캔버스 네 꼭짓점이 전부 그 안에
 * 들어오는지 본다(볼록 사각형 점-내부 판정).
 *
 * 일부러 솔버의 식을 재사용하지 않는다. 판정이 솔버 내부 식을 빌리면 솔버가 틀릴 때
 * 판정도 같이 틀린다. 여기서는 buildLayerMatrix 의 투영 결과만 쓰므로, 솔버가 어떤
 * 식으로 풀었든 이 판정을 통과해야만 "캔버스가 찬다" 고 말할 수 있다.
 */
function coversCanvas(
  t: ResolvedTransform,
  fit: Layer['fit'],
  canvasW: number,
  canvasH: number,
  imageW: number,
  imageH: number,
): boolean {
  const m = buildLayerMatrix(t, fit, canvasW, canvasH, imageW, imageH)
  // 이미지 꼭짓점을 둘레 순서로 투영한다. 변(외적) 판정이 순서를 전제한다.
  const px: number[] = []
  const py: number[] = []
  for (const [u, v] of [[0, 0], [1, 0], [1, 1], [0, 1]] as [number, number][]) {
    const w = m[2]! * u + m[5]! * v + m[8]!
    if (!(w > 0)) return false
    px.push((m[0]! * u + m[3]! * v + m[6]!) / w)
    py.push((m[1]! * u + m[4]! * v + m[7]!) / w)
  }
  // 감김 방향(부호 있는 넓이)을 곱해 두면 뒤집힌 배율에서도 판정이 뒤집히지 않는다.
  let area2 = 0
  for (let i = 0; i < 4; i += 1) {
    const j = (i + 1) % 4
    area2 += px[i]! * py[j]! - py[i]! * px[j]!
  }
  const sign = area2 > 0 ? 1 : -1
  for (const [qx, qy] of [
    [-canvasW / 2, -canvasH / 2],
    [canvasW / 2, -canvasH / 2],
    [canvasW / 2, canvasH / 2],
    [-canvasW / 2, canvasH / 2],
  ] as [number, number][]) {
    for (let i = 0; i < 4; i += 1) {
      const j = (i + 1) % 4
      const ex = px[j]! - px[i]!
      const ey = py[j]! - py[i]!
      const cross = sign * (ex * (qy - py[i]!) - ey * (qx - px[i]!))
      // cross / |변| = 변에서 점까지의 부호 있는 거리다. 매트릭스가 Float32 라
      // 경계에 정확히 닿는 해에서 반올림이 생기므로 0.01px 여유를 둔다.
      if (cross < -0.01 * Math.hypot(ex, ey)) return false
    }
  }
  return true
}

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

describe('기준점(anchor) 회귀: 솔버는 렌더러의 회전축을 그대로 본다 (버그 1)', () => {
  it('기준점 (0.25, 0.25) + 회전 45도: 중심 가정(sqrt2)의 두 배가 필요하다', () => {
    const { doc, layer } = setup()
    layer.anchor = [0.25, 0.25]
    layer.tracks = [createStaticTrack('rotate', 'deg', 45)]
    const need = solveLayerOverscan(doc, layer, 600, 600, { marginRatio: 0 })

    /*
     * 기하 근거: cover 기준 배율에서 이미지는 캔버스와 같은 500px 정사각형이다.
     * 기준점 (0.25, 0.25) 는 화면 (-125, -125) 에 박힌 채 회전/배율의 축이 된다
     * (buildLayerMatrix: 기준점은 축이지 배치 원점이 아니다). 45도에서 가장 먼
     * 캔버스 꼭짓점 (250, -250) 은 축에서 로컬 -y 방향으로 353.55px 인데, 이미지가
     * 축의 그쪽으로 뻗는 길이는 0.25 x 500c = 125c 뿐이다. 353.55 / 125 = 2*sqrt2.
     * 회전이 이미지 중심을 돈다고 가정한 옛 식은 sqrt2 를 줘서 절반밖에 못 채웠다.
     */
    expect(need.correction).toBeCloseTo(2 * Math.SQRT2, 3)
    expect(need.clipped).toBe(false)

    // 판정: 보정을 실제로 곱한 변환이 전 프레임에서 캔버스를 덮는다.
    const map = new Map([[layer.id, need]])
    for (let f = 0; f < doc.timeline.durationFrames; f += 1) {
      const t = resolveComposition(doc, f, map)[0]!.transform
      expect(coversCanvas(t, layer.fit, 500, 500, 600, 600), `frame ${f}`).toBe(true)
    }

    // 대조: 옛 중심 가정 답(sqrt2)만 곱하면 여전히 빈다. 기대값 증가가 옳다는 증거다.
    const raw = resolveComposition(doc, 0)[0]!.transform
    expect(
      coversCanvas({ ...raw, scaleX: Math.SQRT2, scaleY: Math.SQRT2 }, layer.fit, 500, 500, 600, 600),
    ).toBe(false)
  })

  it('대조군: 중앙 기준점은 sqrt2 로 충분하고 실제로 덮인다', () => {
    const { doc, layer } = setup()
    layer.tracks = [createStaticTrack('rotate', 'deg', 45)]
    const need = solveLayerOverscan(doc, layer, 600, 600, { marginRatio: 0 })
    expect(need.correction).toBeCloseTo(Math.SQRT2, 3)
    expect(need.clipped).toBe(false)

    const map = new Map([[layer.id, need]])
    for (let f = 0; f < doc.timeline.durationFrames; f += 1) {
      const t = resolveComposition(doc, f, map)[0]!.transform
      expect(coversCanvas(t, layer.fit, 500, 500, 600, 600), `frame ${f}`).toBe(true)
    }
  })

  it('기준점 (0, 0) + 회전 45도는 어떤 배율로도 못 덮는다: clipped 로 알린다', () => {
    const { doc, layer } = setup()
    layer.anchor = [0, 0]
    layer.tracks = [createStaticTrack('rotate', 'deg', 45)]
    const need = solveLayerOverscan(doc, layer, 600, 600, { marginRatio: 0 })

    /*
     * 이 경우는 "보정 후 네 꼭짓점이 전부 덮인다" 가 기하적으로 성립할 수 없다.
     *
     * 기준점 (0, 0) 은 화면 (-250, -250), 즉 캔버스 왼쪽 위 꼭짓점에 정확히 박히고
     * (cover 배율 5/6 x 0.5 x 600 = 250px), 이미지는 그 점을 꼭짓점으로 하는 90도
     * 부채꼴로만 자란다. 45도 돌리면 부채꼴은 [45, 135]도 방향을 덮는데 캔버스는
     * 같은 꼭짓점에서 [0, 90]도 를 차지한다. 배율은 부채꼴의 반지름만 키울 뿐 벌어진
     * 각도를 못 바꾸므로 (250, -250) 쪽 꼭짓점은 영원히 빈다. 아래에서 배율 50 을
     * 곱해도 안 덮이는 것으로 이 불가능성을 직접 입증한다 (판정 근거).
     *
     * 그래서 솔버의 옳은 답은 "덮을 수 있는 방향까지만 채우고 clipped 로 알린다" 다.
     * 그 하한은 맞은편 꼭짓점 (250, 250) 이 주는 sqrt2 다. 옛 식은 같은 sqrt2 를
     * 주고도 아무 진단이 없어서 캔버스 꼭짓점이 약 500px 빈 채 조용히 내보내졌다
     * (버그 1 실측). 담기 솔버가 CONTAIN_MIN_SCALE 하한에 걸렸을 때 clipped 를
     * 켜는 것과 같은 처리다.
     */
    expect(need.clipped).toBe(true)
    expect(need.correction).toBeCloseTo(Math.SQRT2, 3)

    const raw = resolveComposition(doc, 0)[0]!.transform
    expect(coversCanvas({ ...raw, scaleX: 50, scaleY: 50 }, layer.fit, 500, 500, 600, 600)).toBe(false)
  })
})

describe('비정사각 원본 + 90도 초과 회전: probe 부호 접기 회귀 (버그 2)', () => {
  it('100x1000 원본, 회전 135도 + 이동 (100, -100) 에서 빈 띠가 없다', () => {
    const { doc, layer } = setup()
    doc.assets[0]!.naturalW = 100
    doc.assets[0]!.naturalH = 1000
    layer.tracks = [
      createStaticTrack('rotate', 'deg', 135),
      createStaticTrack('translateX', 'px', 100),
      createStaticTrack('translateY', 'px', -100),
    ]
    const need = solveLayerOverscan(doc, layer, 100, 1000, { marginRatio: 0 })

    /*
     * 기하 근거: cover 기준 배율 5 에서 이미지는 500 x 5000. 좁은 축(로컬 x,
     * 반폭 250c)이 지배한다. 캔버스 꼭짓점을 이미지 로컬로 되돌리면(-135도) 가장
     * 먼 것이 (-250, 250) - (100, -100) = (-350, 350) 으로 |x_local| = 700/sqrt2
     * = 494.97. 그래서 c = 494.97 / 250 = 1.9799 (절대 배율 9.899) 가 필요하다.
     *
     * 옛 probe 는 tx/ty/회전을 전부 절댓값으로 접었다. 135도에서 이동의 로컬 x
     * 성분은 tx*cos + ty*sin = (-100 - 100)/sqrt2 로 부호가 맞물려 커지는데,
     * (+100, +100, +135도) 로 접으면 두 항이 상쇄되어 0 이 된다. 그래서 회전만
     * 있을 때 값인 7.071 로 29% 과소 계산했고 그만큼 빈 띠가 남았다 (실측).
     */
    expect(need.correction).toBeCloseTo(1.9799, 3)
    expect(need.sRequired).toBeCloseTo(9.8995, 3)
    expect(need.clipped).toBe(false)

    // 판정: 보정을 실제로 곱한 변환이 전 프레임에서 캔버스를 덮는다.
    const map = new Map([[layer.id, need]])
    for (let f = 0; f < doc.timeline.durationFrames; f += 1) {
      const t = resolveComposition(doc, f, map)[0]!.transform
      expect(coversCanvas(t, layer.fit, 500, 500, 100, 1000), `frame ${f}`).toBe(true)
    }

    // 대조: 옛 probe 의 답(7.071 / 5)만 곱하면 여전히 빈 띠가 남는다.
    const raw = resolveComposition(doc, 0)[0]!.transform
    expect(
      coversCanvas({ ...raw, scaleX: 7.071 / 5, scaleY: 7.071 / 5 }, layer.fit, 500, 500, 100, 1000),
    ).toBe(false)
  })
})
