/**
 * 이미지 전처리 순수 로직.
 *
 * 여기서 검증하는 것은 ImageBitmap 이 필요 없는 부분뿐이다.
 * removeBackground / cropBitmap / autoTrimAlpha / pickKeyColorFromCorners /
 * estimateTolerance 는 createImageBitmap 과 2D 캔버스를 쓰므로 node 환경에서
 * 돌지 않는다. 그 경로는 **브라우저 테스트로 미룬다.**
 * (jsdom 을 끌어와도 canvas 구현이 없어서 의미 있는 검증이 안 된다.)
 *
 * 대신 그 함수들의 판단 근거가 되는 순수 함수를 여기서 고정한다.
 *   - colorDistance : 키잉 품질 전체가 여기 달려 있다
 *   - fitRectToAspect : 비율과 경계 침범
 *   - alphaBounds : autoTrimAlpha 의 실제 계산부
 */

import { describe, expect, it } from 'vitest'

import { colorDistance, rgbToYcc } from '@/imageprep/bgRemove.ts'
import { ASPECT_PRESETS, alphaBounds, fitRectToAspect, type CropRect } from '@/imageprep/crop.ts'

// ---------------------------------------------------------------------------
// 색 거리
// ---------------------------------------------------------------------------

describe('rgbToYcc', () => {
  it('무채색의 크로마는 0 이다', () => {
    for (const v of [0, 64, 128, 200, 255]) {
      const c = rgbToYcc(v, v, v)
      expect(c.cb).toBeCloseTo(0, 12)
      expect(c.cr).toBeCloseTo(0, 12)
      expect(c.y).toBeCloseTo(v / 255, 6)
    }
  })

  it('순색의 크로마가 0.5 로 정규화된다', () => {
    // 이 두 값이 어긋나면 CB_K / CR_K 상수가 틀린 것이다.
    expect(rgbToYcc(0, 0, 255).cb).toBeCloseTo(0.5, 6)
    expect(rgbToYcc(255, 0, 0).cr).toBeCloseTo(0.5, 6)
  })
})

describe('colorDistance', () => {
  it('같은 색은 거리 0 이다', () => {
    expect(colorDistance(255, 255, 255, [255, 255, 255])).toBe(0)
    expect(colorDistance(0, 128, 64, [0, 128, 64])).toBe(0)
  })

  it('대칭이다', () => {
    expect(colorDistance(10, 200, 30, [240, 20, 90])).toBe(
      colorDistance(240, 20, 90, [10, 200, 30]),
    )
  })

  it('흰색과 검정의 거리가 1 이다', () => {
    // 정규화 기준점. 이 값이 바뀌면 tolerance 슬라이더의 의미가 통째로 바뀐다.
    expect(colorDistance(255, 255, 255, [0, 0, 0])).toBeCloseTo(1, 6)
    expect(colorDistance(0, 0, 0, [255, 255, 255])).toBeCloseTo(1, 6)
  })

  it('1 을 넘지 않는다', () => {
    // 파랑과 노랑은 크로마가 정반대라 원시 거리가 1.7 을 넘는다.
    expect(colorDistance(0, 0, 255, [255, 255, 0])).toBe(1)
  })

  it('밝기 차이보다 색상 차이에 더 크게 반응한다', () => {
    const key: [number, number, number] = [128, 128, 128]
    // 회색 계열. 밝기만 다르다.
    const gray = colorDistance(150, 150, 150, key)
    // 휘도는 거의 같고 색상만 다르다. RGB 유클리드로는 두 배 남짓 차이지만
    // 크로마 가중 거리에서는 세 배를 넘어야 한다.
    const colored = colorDistance(200, 100, 100, key)

    expect(gray).toBeGreaterThan(0)
    expect(colored).toBeGreaterThan(0.3)
    expect(colored).toBeGreaterThan(gray * 3)
  })

  it('밝기가 멀어질수록 커진다', () => {
    const key: [number, number, number] = [255, 255, 255]
    const near = colorDistance(245, 245, 245, key)
    const mid = colorDistance(180, 180, 180, key)
    const far = colorDistance(60, 60, 60, key)
    expect(near).toBeLessThan(mid)
    expect(mid).toBeLessThan(far)
    // 흰 배경에서 아주 밝은 회색은 기본 허용치(0.05 하한) 근처에 있어야 한다.
    expect(near).toBeLessThan(0.06)
  })
})

// ---------------------------------------------------------------------------
// 비율 맞춤
// ---------------------------------------------------------------------------

const BOUNDS: CropRect = { x: 0, y: 0, w: 200, h: 100 }

function contains(rect: CropRect, bounds: CropRect): boolean {
  const eps = 1e-9
  return (
    rect.x >= bounds.x - eps &&
    rect.y >= bounds.y - eps &&
    rect.x + rect.w <= bounds.x + bounds.w + eps &&
    rect.y + rect.h <= bounds.y + bounds.h + eps &&
    rect.w >= 0 &&
    rect.h >= 0
  )
}

describe('fitRectToAspect', () => {
  it('요청한 비율을 정확히 만든다', () => {
    for (const preset of ASPECT_PRESETS) {
      if (preset.ratio === null) continue
      const out = fitRectToAspect({ x: 0, y: 0, w: 200, h: 100 }, preset.ratio, BOUNDS)
      expect(out.w / out.h).toBeCloseTo(preset.ratio, 9)
    }
  })

  it('어떤 입력에서도 경계를 벗어나지 않는다', () => {
    const bounds: CropRect = { x: 10, y: 20, w: 300, h: 180 }
    const rects: CropRect[] = [
      { x: 10, y: 20, w: 300, h: 180 },
      { x: 0, y: 0, w: 1000, h: 1000 },
      { x: 300, y: 190, w: 10, h: 10 },
      { x: -500, y: -500, w: 20, h: 900 },
      { x: 150, y: 100, w: 1, h: 1 },
    ]
    for (const preset of ASPECT_PRESETS) {
      if (preset.ratio === null) continue
      for (const rect of rects) {
        const out = fitRectToAspect(rect, preset.ratio, bounds)
        expect(contains(out, bounds)).toBe(true)
        expect(out.w / out.h).toBeCloseTo(preset.ratio, 9)
      }
    }
  })

  it('가로로 남는 사각형은 폭만 줄이고 중심을 지킨다', () => {
    const out = fitRectToAspect({ x: 0, y: 0, w: 200, h: 100 }, 1, BOUNDS)
    expect(out).toEqual({ x: 50, y: 0, w: 100, h: 100 })
  })

  it('세로로 남는 사각형은 높이만 줄인다', () => {
    // 1:2 사각형에 16:9 를 요청하면 폭이 기준이 된다.
    const out = fitRectToAspect({ x: 0, y: 0, w: 40, h: 80 }, 16 / 9, BOUNDS)
    expect(out.w).toBeCloseTo(40, 9)
    expect(out.h).toBeCloseTo(22.5, 9)
    expect(contains(out, BOUNDS)).toBe(true)
  })

  it('경계보다 큰 사각형은 경계 안 최대 크기로 줄인다', () => {
    const out = fitRectToAspect({ x: -50, y: -50, w: 400, h: 400 }, 1, BOUNDS)
    expect(out.w).toBeCloseTo(100, 9)
    expect(out.h).toBeCloseTo(100, 9)
    expect(contains(out, BOUNDS)).toBe(true)
  })

  it('빈 사각형은 경계 안 최대 크기가 된다', () => {
    const out = fitRectToAspect({ x: 0, y: 0, w: 0, h: 0 }, 1, BOUNDS)
    expect(out.w).toBeCloseTo(100, 9)
    expect(out.h).toBeCloseTo(100, 9)
    expect(contains(out, BOUNDS)).toBe(true)
  })

  it('비율이 유효하지 않으면 경계 안으로만 넣는다', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const out = fitRectToAspect({ x: 150, y: 60, w: 400, h: 400 }, bad, BOUNDS)
      expect(contains(out, BOUNDS)).toBe(true)
    }
  })

  it('경계가 0 이면 0 크기를 돌려준다', () => {
    const out = fitRectToAspect({ x: 0, y: 0, w: 10, h: 10 }, 1, { x: 5, y: 5, w: 0, h: 0 })
    expect(out).toEqual({ x: 5, y: 5, w: 0, h: 0 })
  })
})

// ---------------------------------------------------------------------------
// 알파 경계 상자
// ---------------------------------------------------------------------------

/** 알파만 지정해 RGBA 버퍼를 만든다. */
function makeAlpha(w: number, h: number, fill: (x: number, y: number) => number): Uint8ClampedArray {
  const data = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      data[(y * w + x) * 4 + 3] = fill(x, y)
    }
  }
  return data
}

describe('alphaBounds', () => {
  it('불투명한 영역의 최소 경계 상자를 찾는다', () => {
    const data = makeAlpha(8, 8, (x, y) => (x >= 3 && x <= 4 && y >= 2 && y <= 4 ? 255 : 0))
    expect(alphaBounds(data, 8, 8)).toEqual({ x: 3, y: 2, w: 2, h: 3 })
  })

  it('가장자리에 붙어 있어도 잘라내지 않는다', () => {
    const data = makeAlpha(4, 4, () => 255)
    expect(alphaBounds(data, 4, 4)).toEqual({ x: 0, y: 0, w: 4, h: 4 })
  })

  it('전부 투명하면 전체 사각형을 돌려준다', () => {
    // 빈 사각형을 돌려주면 호출자가 0 크기로 자르려다 실패한다.
    const data = makeAlpha(6, 5, () => 0)
    expect(alphaBounds(data, 6, 5)).toEqual({ x: 0, y: 0, w: 6, h: 5 })
  })

  it('threshold 이하의 알파는 여백으로 본다', () => {
    const data = makeAlpha(6, 6, (x, y) => (x === 1 && y === 1 ? 5 : 0))
    // 5 는 기본 threshold 8 을 넘지 못한다.
    expect(alphaBounds(data, 6, 6)).toEqual({ x: 0, y: 0, w: 6, h: 6 })
    // 임계값을 낮추면 잡힌다.
    expect(alphaBounds(data, 6, 6, 0)).toEqual({ x: 1, y: 1, w: 1, h: 1 })
  })

  it('픽셀 하나만 남아도 1x1 로 잡는다', () => {
    const data = makeAlpha(5, 5, (x, y) => (x === 4 && y === 0 ? 200 : 0))
    expect(alphaBounds(data, 5, 5)).toEqual({ x: 4, y: 0, w: 1, h: 1 })
  })

  it('크기가 0 이면 전체 사각형을 돌려준다', () => {
    expect(alphaBounds(new Uint8ClampedArray(0), 0, 0)).toEqual({ x: 0, y: 0, w: 0, h: 0 })
  })
})
