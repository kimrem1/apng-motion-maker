/**
 * 자르기 상자의 순수 로직.
 *
 * prep.test.ts 가 alphaBounds / fitRectToAspect 를 고정한다. 여기서는 그 위에
 * 얹은 두 가지를 고정한다.
 *
 *   - contentBounds : 불투명 이미지의 단색 여백. 이게 없으면 JPG 에서
 *     [빈 여백 자동 제거] 가 아무 일도 하지 않는다.
 *   - applyCropDrag : 드래그로 상자를 만드는 모든 경로. 상자가 경계를 넘거나
 *     뒤집히는 사고는 손으로 재현하기 어렵고, 한 번 나면 잘린 결과가
 *     조용히 이상해진다.
 *
 * cropBitmap / autoTrimContent 는 createImageBitmap 과 2D 캔버스를 쓰므로
 * node 에서 못 돈다. 그 둘은 이 파일이 고정하는 순수 함수의 얇은 래퍼다.
 */

import { describe, expect, it } from 'vitest'

import {
  CROP_MIN_SIZE,
  SOLID_TRIM_TOLERANCE,
  applyCropDrag,
  contentBounds,
  pickBorderColor,
  roundRect,
  type CropHandle,
  type CropRect,
} from '@/imageprep/crop.ts'

// ---------------------------------------------------------------------------
// 픽셀 만들기
// ---------------------------------------------------------------------------

type Rgba = [number, number, number, number]

/** (x, y) -> RGBA 로 이미지를 만든다. */
function makeImage(w: number, h: number, at: (x: number, y: number) => Rgba): Uint8ClampedArray {
  const data = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const p = (y * w + x) * 4
      const [r, g, b, a] = at(x, y)
      data[p] = r
      data[p + 1] = g
      data[p + 2] = b
      data[p + 3] = a
    }
  }
  return data
}

const WHITE: Rgba = [255, 255, 255, 255]
const RED: Rgba = [220, 40, 40, 255]

/** 흰 배경 위에 사각형 하나. 전부 불투명하다(JPG 상황). */
function opaqueBox(w: number, h: number, box: CropRect): Uint8ClampedArray {
  return makeImage(w, h, (x, y) =>
    x >= box.x && x < box.x + box.w && y >= box.y && y < box.y + box.h ? RED : WHITE,
  )
}

// ---------------------------------------------------------------------------
// contentBounds
// ---------------------------------------------------------------------------

describe('pickBorderColor', () => {
  it('네 모서리가 같은 색이면 그 색을 고른다', () => {
    const data = opaqueBox(10, 10, { x: 3, y: 3, w: 4, h: 4 })
    expect(pickBorderColor(data, 10, 10)).toEqual([255, 255, 255])
  })

  it('한 모서리에 피사체가 걸쳐도 다수결로 배경을 고른다', () => {
    // 좌상단 구석만 빨강이다. 나머지 셋은 흰색이다.
    const data = opaqueBox(10, 10, { x: 0, y: 0, w: 3, h: 3 })
    expect(pickBorderColor(data, 10, 10)).toEqual([255, 255, 255])
  })

  it('모서리가 전부 다르면 배경이 없다고 본다', () => {
    const colors: Rgba[] = [
      [255, 0, 0, 255],
      [0, 255, 0, 255],
      [0, 0, 255, 255],
      [255, 255, 0, 255],
    ]
    const data = makeImage(4, 4, (x, y) => {
      if (x === 0 && y === 0) return colors[0]!
      if (x === 3 && y === 0) return colors[1]!
      if (x === 0 && y === 3) return colors[2]!
      if (x === 3 && y === 3) return colors[3]!
      return [128, 128, 128, 255]
    })
    expect(pickBorderColor(data, 4, 4)).toBeNull()
  })
})

describe('contentBounds', () => {
  it('알파 여백을 먼저 쓴다', () => {
    const data = makeImage(8, 8, (x, y) =>
      x >= 2 && x <= 5 && y >= 1 && y <= 3 ? RED : [0, 0, 0, 0],
    )
    expect(contentBounds(data, 8, 8)).toEqual({ x: 2, y: 1, w: 4, h: 3 })
  })

  it('전부 불투명해도 단색 여백을 잘라낸다', () => {
    // 이 한 줄이 이번 패치의 핵심이다. alphaBounds 만으로는 전체 사각형이 나온다.
    const box: CropRect = { x: 3, y: 2, w: 4, h: 5 }
    const data = opaqueBox(12, 12, box)
    expect(contentBounds(data, 12, 12)).toEqual(box)
  })

  it('가장자리까지 그림이 차 있으면 전체를 돌려준다', () => {
    const data = opaqueBox(6, 6, { x: 0, y: 0, w: 6, h: 6 })
    expect(contentBounds(data, 6, 6)).toEqual({ x: 0, y: 0, w: 6, h: 6 })
  })

  it('전부 배경색이면 전체를 돌려준다', () => {
    // 0 크기를 돌려주면 호출자가 자르기에 실패한다.
    const data = makeImage(5, 4, () => WHITE)
    expect(contentBounds(data, 5, 4)).toEqual({ x: 0, y: 0, w: 5, h: 4 })
  })

  it('허용치 안의 압축 노이즈는 여백으로 본다', () => {
    // JPEG 흰 여백은 정확히 255 가 아니다. 249 정도의 흔들림은 여백이어야 한다.
    const noisy: Rgba = [250, 251, 249, 255]
    const data = makeImage(10, 10, (x, y) =>
      x >= 4 && x <= 6 && y >= 4 && y <= 6 ? RED : noisy,
    )
    expect(contentBounds(data, 10, 10)).toEqual({ x: 4, y: 4, w: 3, h: 3 })
  })

  it('허용치를 0 으로 주면 단색 판정을 끈다', () => {
    const data = opaqueBox(8, 8, { x: 2, y: 2, w: 3, h: 3 })
    expect(contentBounds(data, 8, 8, { colorTolerance: 0 })).toEqual({ x: 0, y: 0, w: 8, h: 8 })
  })

  it('반투명 스티커에서 투명 픽셀의 RGB 를 배경으로 오해하지 않는다', () => {
    // 투명 영역의 RGB 가 검정(0,0,0)이고 피사체에도 검정이 있는 경우.
    // 단색 판정이 먼저 돌면 피사체의 검은 부분까지 여백이 된다.
    const data = makeImage(10, 10, (x, y) => {
      const inside = x >= 3 && x <= 6 && y >= 3 && y <= 6
      if (!inside) return [0, 0, 0, 0]
      return x === 3 ? [0, 0, 0, 255] : RED
    })
    expect(contentBounds(data, 10, 10)).toEqual({ x: 3, y: 3, w: 4, h: 4 })
  })

  it('크기가 0 이면 전체 사각형을 돌려준다', () => {
    expect(contentBounds(new Uint8ClampedArray(0), 0, 0)).toEqual({ x: 0, y: 0, w: 0, h: 0 })
  })

  it('기본 허용치는 흰색과 아주 밝은 회색을 같은 색으로 본다', () => {
    // SOLID_TRIM_TOLERANCE 를 바꾸면 이 관계가 먼저 깨진다.
    expect(SOLID_TRIM_TOLERANCE).toBeGreaterThan(0)
    const data = makeImage(6, 6, (x, y) => (x === 3 && y === 3 ? [10, 10, 10, 255] : [252, 252, 252, 255]))
    expect(contentBounds(data, 6, 6)).toEqual({ x: 3, y: 3, w: 1, h: 1 })
  })
})

// ---------------------------------------------------------------------------
// 드래그
// ---------------------------------------------------------------------------

const BOUNDS: CropRect = { x: 0, y: 0, w: 200, h: 100 }

function contains(rect: CropRect, bounds: CropRect): boolean {
  const eps = 1e-9
  return (
    rect.x >= bounds.x - eps &&
    rect.y >= bounds.y - eps &&
    rect.x + rect.w <= bounds.x + bounds.w + eps &&
    rect.y + rect.h <= bounds.y + bounds.h + eps &&
    rect.w > 0 &&
    rect.h > 0
  )
}

const ALL_HANDLES: CropHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w', 'move']

describe('applyCropDrag', () => {
  const start: CropRect = { x: 50, y: 25, w: 60, h: 40 }

  it('안쪽을 끌면 크기가 그대로 이동한다', () => {
    const out = applyCropDrag({ start, handle: 'move', dx: 10, dy: -5, bounds: BOUNDS, ratio: null })
    expect(out).toEqual({ x: 60, y: 20, w: 60, h: 40 })
  })

  it('이동은 경계에서 멈춘다. 크기는 안 줄어든다', () => {
    const out = applyCropDrag({
      start,
      handle: 'move',
      dx: 999,
      dy: 999,
      bounds: BOUNDS,
      ratio: null,
    })
    expect(out.w).toBe(60)
    expect(out.h).toBe(40)
    expect(out.x + out.w).toBe(BOUNDS.w)
    expect(out.y + out.h).toBe(BOUNDS.h)
  })

  it('모서리를 끌면 반대편이 고정된다', () => {
    const out = applyCropDrag({ start, handle: 'se', dx: 20, dy: 10, bounds: BOUNDS, ratio: null })
    expect(out).toEqual({ x: 50, y: 25, w: 80, h: 50 })
  })

  it('왼쪽 변을 끌면 오른쪽 끝이 그대로다', () => {
    const out = applyCropDrag({ start, handle: 'w', dx: -20, dy: 0, bounds: BOUNDS, ratio: null })
    expect(out.x).toBe(30)
    expect(out.x + out.w).toBe(110)
    expect(out.h).toBe(40)
  })

  it('상자를 뒤집을 수 없다', () => {
    // 오른쪽 변을 왼쪽 끝 너머로 끌어도 최소 크기에서 멈춘다.
    const out = applyCropDrag({
      start,
      handle: 'e',
      dx: -9999,
      dy: 0,
      bounds: BOUNDS,
      ratio: null,
    })
    expect(out.w).toBe(CROP_MIN_SIZE)
    expect(out.x).toBe(50)
  })

  it('어떤 핸들을 얼마나 끌어도 경계를 벗어나지 않는다', () => {
    const deltas = [-9999, -300, -37, -1, 0, 1, 37, 300, 9999]
    for (const handle of ALL_HANDLES) {
      for (const dx of deltas) {
        for (const dy of deltas) {
          const out = applyCropDrag({ start, handle, dx, dy, bounds: BOUNDS, ratio: null })
          expect(contains(out, BOUNDS)).toBe(true)
        }
      }
    }
  })

  it('비율을 잠그면 어떤 드래그에서도 비율이 유지된다', () => {
    const deltas = [-500, -60, -3, 3, 60, 500]
    for (const ratio of [1, 4 / 5, 16 / 9, 9 / 16]) {
      for (const handle of ALL_HANDLES) {
        if (handle === 'move') continue
        for (const dx of deltas) {
          for (const dy of deltas) {
            const out = applyCropDrag({ start, handle, dx, dy, bounds: BOUNDS, ratio })
            expect(contains(out, BOUNDS)).toBe(true)
            expect(out.w / out.h).toBeCloseTo(ratio, 9)
          }
        }
      }
    }
  })

  it('비율 잠금에서 모서리를 끌면 반대편 모서리가 고정된다', () => {
    const room: CropRect = { x: 50, y: 10, w: 60, h: 40 }
    const out = applyCropDrag({ start: room, handle: 'se', dx: 20, dy: 0, bounds: BOUNDS, ratio: 1 })
    expect(out.x).toBe(50)
    expect(out.y).toBe(10)
    expect(out.w).toBeCloseTo(80, 9)
    expect(out.h).toBeCloseTo(80, 9)
  })

  it('비율 잠금에서 모서리가 경계에 닿으면 거기서 멈춘다', () => {
    // start.y = 25 이므로 아래로는 75px 뿐이다. 정사각형은 75 를 넘을 수 없다.
    const out = applyCropDrag({ start, handle: 'se', dx: 20, dy: 0, bounds: BOUNDS, ratio: 1 })
    expect(out.w).toBeCloseTo(75, 9)
    expect(out.h).toBeCloseTo(75, 9)
    expect(out.y + out.h).toBeCloseTo(BOUNDS.h, 9)
  })

  it('비율 잠금에서 변을 끌면 반대 축은 중심을 지킨다', () => {
    const cy = start.y + start.h / 2
    const out = applyCropDrag({ start, handle: 'e', dx: 20, dy: 0, bounds: BOUNDS, ratio: 1 })
    expect(out.x).toBe(50)
    expect(out.w).toBeCloseTo(80, 9)
    expect(out.y + out.h / 2).toBeCloseTo(cy, 9)
  })

  it('빈 상자에서 시작하는 새 드래그가 상자를 만든다', () => {
    // 미리보기 빈 곳을 끌어서 새로 그리는 경로다.
    const out = applyCropDrag({
      start: { x: 80, y: 50, w: 0, h: 0 },
      handle: 'se',
      dx: 40,
      dy: 30,
      bounds: BOUNDS,
      ratio: null,
    })
    expect(out).toEqual({ x: 80, y: 50, w: 40, h: 30 })
  })

  it('왼쪽 위로 끄는 새 드래그도 같은 상자를 만든다', () => {
    const out = applyCropDrag({
      start: { x: 120, y: 80, w: 0, h: 0 },
      handle: 'nw',
      dx: -40,
      dy: -30,
      bounds: BOUNDS,
      ratio: null,
    })
    expect(out).toEqual({ x: 80, y: 50, w: 40, h: 30 })
  })

  it('경계가 비율보다 좁으면 들어가는 최대 크기로 줄인다', () => {
    // 200x100 안에서 9:16 은 세로가 기준이다.
    const out = applyCropDrag({
      start: { x: 0, y: 0, w: 10, h: 10 },
      handle: 'se',
      dx: 9999,
      dy: 9999,
      bounds: BOUNDS,
      ratio: 9 / 16,
    })
    expect(contains(out, BOUNDS)).toBe(true)
    expect(out.h).toBeCloseTo(100, 9)
    expect(out.w).toBeCloseTo(100 * (9 / 16), 9)
  })
})

describe('roundRect', () => {
  it('정수로 확정하고 이미지 밖으로 나가지 않는다', () => {
    expect(roundRect({ x: 2.4, y: 3.6, w: 10.2, h: 4.9 }, 20, 20)).toEqual({
      x: 2,
      y: 4,
      w: 10,
      h: 5,
    })
  })

  it('넘치는 사각형을 이미지 안으로 잘라 넣는다', () => {
    const out = roundRect({ x: 15, y: 15, w: 100, h: 100 }, 20, 20)
    expect(out.x + out.w).toBeLessThanOrEqual(20)
    expect(out.y + out.h).toBeLessThanOrEqual(20)
  })
})
