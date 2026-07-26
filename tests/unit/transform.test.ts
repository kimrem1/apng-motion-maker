import { describe, expect, it } from 'vitest'

import {
  baseFitScale,
  buildLayerMatrix,
  canvasToClip,
  identityTransform,
  mat3Multiply,
  type Mat3,
} from '@/core/transform.ts'

/** 유닛 사각형 위 점 (u,v) 를 매트릭스로 옮긴다. */
function apply(m: Mat3, u: number, v: number): [number, number] {
  return [m[0]! * u + m[3]! * v + m[6]!, m[1]! * u + m[4]! * v + m[7]!]
}

describe('baseFitScale', () => {
  it('cover 는 캔버스를 최소로 덮는 배율을 준다', () => {
    // 500 캔버스 + 600 이미지 -> s0 = 0.8333
    const s = baseFitScale('cover', 500, 500, 600, 600)
    expect(s.sx).toBeCloseTo(500 / 600, 10)
    expect(s.sy).toBeCloseTo(500 / 600, 10)
  })

  it('가로로 긴 이미지에서 cover 는 세로를 기준으로 잡는다', () => {
    const s = baseFitScale('cover', 500, 500, 1000, 600)
    expect(s.sx).toBeCloseTo(500 / 600, 10)
  })

  it('contain 은 반대로 잡는다', () => {
    const s = baseFitScale('contain', 500, 500, 1000, 600)
    expect(s.sx).toBeCloseTo(500 / 1000, 10)
  })

  it('fill 은 축별로 다르게 늘린다', () => {
    const s = baseFitScale('fill', 500, 250, 1000, 1000)
    expect(s.sx).toBeCloseTo(0.5, 10)
    expect(s.sy).toBeCloseTo(0.25, 10)
  })
})

describe('buildLayerMatrix', () => {
  it('k = 1 이면 이미지가 캔버스를 정확히 덮는다', () => {
    const t = identityTransform()
    const m = buildLayerMatrix(t, 'cover', 500, 500, 600, 600)

    // 유닛 사각형 좌상단 -> 캔버스 중심 기준 (-250, -250)
    const tl = apply(m, 0, 0)
    const br = apply(m, 1, 1)
    expect(tl[0]).toBeCloseTo(-250, 6)
    expect(tl[1]).toBeCloseTo(-250, 6)
    expect(br[0]).toBeCloseTo(250, 6)
    expect(br[1]).toBeCloseTo(250, 6)
  })

  it('k = 1.2 확대는 600px 로 렌더되어 좌우 50px 씩 넘친다 (경우 A, t=T)', () => {
    const t = identityTransform()
    t.scaleX = 1.2
    t.scaleY = 1.2
    const m = buildLayerMatrix(t, 'cover', 500, 500, 600, 600)

    const tl = apply(m, 0, 0)
    const br = apply(m, 1, 1)
    expect(br[0] - tl[0]).toBeCloseTo(600, 6)
    expect(tl[0]).toBeCloseTo(-300, 6)
    expect(br[0]).toBeCloseTo(300, 6)
  })

  it('앵커를 좌상단으로 옮기면 그 점이 위치 원점이 된다', () => {
    const t = identityTransform()
    t.anchorX = 0
    t.anchorY = 0
    const m = buildLayerMatrix(t, 'cover', 500, 500, 600, 600)
    const tl = apply(m, 0, 0)
    expect(tl[0]).toBeCloseTo(0, 6)
    expect(tl[1]).toBeCloseTo(0, 6)
  })

  it('90도 회전은 가로와 세로를 맞바꾼다', () => {
    const t = identityTransform()
    t.rotate = 90
    const m = buildLayerMatrix(t, 'none', 500, 500, 400, 200)

    const tl = apply(m, 0, 0)
    const tr = apply(m, 1, 0)
    // 가로 변(길이 400)이 회전 후 세로 방향으로 간다
    expect(Math.abs(tr[0] - tl[0])).toBeCloseTo(0, 6)
    expect(Math.abs(tr[1] - tl[1])).toBeCloseTo(400, 6)
  })

  it('translate 는 캔버스 픽셀 단위로 그대로 더해진다', () => {
    const t = identityTransform()
    t.translateX = 30
    t.translateY = -10
    const m = buildLayerMatrix(t, 'cover', 500, 500, 600, 600)
    const center = apply(m, 0.5, 0.5)
    expect(center[0]).toBeCloseTo(30, 6)
    expect(center[1]).toBeCloseTo(-10, 6)
  })
})

describe('canvasToClip', () => {
  it('캔버스 중심은 NDC 원점, 우하단은 (1,-1) 이다', () => {
    const clip = canvasToClip(500, 500)
    const m = new Float32Array(9) as Mat3
    mat3Multiply(clip, buildLayerMatrix(identityTransform(), 'cover', 500, 500, 600, 600), m)

    const center = apply(m, 0.5, 0.5)
    expect(center[0]).toBeCloseTo(0, 6)
    expect(center[1]).toBeCloseTo(0, 6)

    const br = apply(m, 1, 1)
    expect(br[0]).toBeCloseTo(1, 6)
    // y 는 뒤집힌다
    expect(br[1]).toBeCloseTo(-1, 6)
  })
})
