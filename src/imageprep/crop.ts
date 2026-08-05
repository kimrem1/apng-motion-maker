/**
 * 크롭.
 *
 * 좌표계 규칙이 두 층으로 나뉜다. 섞으면 1px 씩 어긋난다.
 *   - fitRectToAspect 는 연속 좌표(실수)로 계산한다. 정수로 반올림하면 비율이
 *     정확히 맞지 않는다. 100 폭의 3:4 는 높이 133.33 이고, 133 으로 반올림하는
 *     순간 비율이 0.7519 가 된다.
 *   - cropBitmap 만 정수 픽셀로 확정한다. 실제 자르기는 정수여야 하기 때문이다.
 *
 * AssetPrep.crop 은 [x, y, w, h] 를 자연 크기 픽셀로 저장한다(core/types.ts).
 * 이 파일의 CropRect 가 그 값과 같은 좌표계다.
 */

import {
  PREP_BITMAP_OPTIONS,
  bitmapFromImageData,
  colorDistance,
  readPixels,
} from './bgRemove.ts'

export interface CropRect {
  x: number
  y: number
  w: number
  h: number
}

export interface AspectPreset {
  id: string
  label: string
  /** w / h. null 이면 비율을 강제하지 않는다. */
  ratio: number | null
}

/**
 * 비율 프리셋. 값은 가로/세로다.
 * 스티커 용도라 1:1 을 첫 고정 비율로 둔다. 4:5 와 9:16 은 각각 피드와 스토리다.
 */
export const ASPECT_PRESETS: readonly AspectPreset[] = [
  { id: 'free', label: '자유', ratio: null },
  { id: '1:1', label: '1:1', ratio: 1 },
  { id: '4:5', label: '4:5', ratio: 4 / 5 },
  { id: '3:4', label: '3:4', ratio: 3 / 4 },
  { id: '16:9', label: '16:9', ratio: 16 / 9 },
  { id: '9:16', label: '9:16', ratio: 9 / 16 },
]

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v)

/** 실제로 자를 수 있는 정수 사각형으로 확정한다. 비트맵 밖으로 나가지 않는다. */
function toPixelRect(rect: CropRect, w: number, h: number): CropRect {
  const x = clamp(Math.round(rect.x), 0, Math.max(0, w - 1))
  const y = clamp(Math.round(rect.y), 0, Math.max(0, h - 1))
  const rw = clamp(Math.round(rect.w), 1, w - x)
  const rh = clamp(Math.round(rect.h), 1, h - y)
  return { x, y, w: rw, h: rh }
}

/**
 * 잘라낸 새 ImageBitmap 을 만든다. 원본은 변형하지 않고 닫지도 않는다.
 *
 * createImageBitmap 의 크롭 오버로드를 먼저 쓴다. 픽셀을 CPU 로 내렸다 올리지
 * 않으므로 정밀도 손실이 없다. 이 오버로드는 사각형이 소스 밖으로 나가면 그
 * 부분을 투명으로 채우는데, toPixelRect 가 미리 클램프해서 그럴 일이 없다.
 */
export async function cropBitmap(source: ImageBitmap, rect: CropRect): Promise<ImageBitmap> {
  const w = source.width
  const h = source.height
  if (w === 0 || h === 0) throw new Error('이미지 크기가 0이라 자를 수 없습니다.')

  const r = toPixelRect(rect, w, h)

  try {
    return await createImageBitmap(source, r.x, r.y, r.w, r.h, PREP_BITMAP_OPTIONS)
  } catch {
    // 크롭 오버로드를 거부하는 브라우저용 폴백. 픽셀을 직접 옮긴다.
    const src = readPixels(source)
    const out = new ImageData(r.w, r.h)
    for (let y = 0; y < r.h; y += 1) {
      const from = ((y + r.y) * w + r.x) * 4
      out.data.set(src.data.subarray(from, from + r.w * 4), y * r.w * 4)
    }
    return await bitmapFromImageData(out)
  }
}

/**
 * 사각형을 정확한 비율로 맞춘다. 절대 bounds 를 벗어나지 않는다.
 *
 * 규칙은 세 가지다.
 *   1. 늘리지 않고 줄인다. 늘리면 경계를 넘기 쉽고, 넘은 뒤 다시 밀어 넣으면
 *      사용자가 지정한 영역이 통째로 이동해 버린다.
 *   2. 중심을 유지한다. 그래야 비율 버튼을 연달아 눌러도 피사체가 안 달아난다.
 *   3. 중심 유지가 경계를 넘기면 경계 안으로 민다. 크기는 이미 확정됐으므로
 *      미는 것만으로 항상 안에 들어간다.
 */
export function fitRectToAspect(rect: CropRect, ratio: number, bounds: CropRect): CropRect {
  const bw = Math.max(0, bounds.w)
  const bh = Math.max(0, bounds.h)
  if (bw === 0 || bh === 0) return { x: bounds.x, y: bounds.y, w: 0, h: 0 }
  if (!Number.isFinite(ratio) || ratio <= 0) {
    // 비율 강제 없음. 경계 안으로만 넣어 돌려준다.
    const w = clamp(rect.w, 0, bw)
    const h = clamp(rect.h, 0, bh)
    return {
      x: clamp(rect.x, bounds.x, bounds.x + bw - w),
      y: clamp(rect.y, bounds.y, bounds.y + bh - h),
      w,
      h,
    }
  }

  // 경계 안에 들어가는 최대 크기.
  const maxW = Math.min(bw, bh * ratio)
  const maxH = maxW / ratio

  let w: number
  let h: number
  if (!(rect.w > 0) || !(rect.h > 0)) {
    // 빈 사각형이 들어오면 경계 전체를 채우는 최대 크기로 시작한다.
    w = maxW
    h = maxH
  } else if (rect.w / rect.h > ratio) {
    // 지금이 더 넓다. 폭을 줄인다.
    h = rect.h
    w = h * ratio
  } else {
    h = rect.w / ratio
    w = rect.w
  }

  if (w > maxW) {
    w = maxW
    h = maxH
  }

  const cx = rect.x + rect.w / 2
  const cy = rect.y + rect.h / 2
  return {
    x: clamp(cx - w / 2, bounds.x, bounds.x + bw - w),
    y: clamp(cy - h / 2, bounds.y, bounds.y + bh - h),
    w,
    h,
  }
}

/**
 * 알파가 threshold 를 넘는 픽셀의 최소 경계 상자.
 * 순수 함수라 테스트가 가능하다. autoTrimAlpha 가 이걸 감싼다.
 *
 * 전부 투명하면 전체 사각형을 돌려준다. 빈 사각형을 돌려주면 호출자가
 * 0 크기로 자르려다 실패한다.
 */
export function alphaBounds(
  rgba: Uint8ClampedArray | Uint8Array,
  w: number,
  h: number,
  threshold = 8,
): CropRect {
  const full: CropRect = { x: 0, y: 0, w, h }
  if (w <= 0 || h <= 0) return full

  let minX = w
  let minY = h
  let maxX = -1
  let maxY = -1

  for (let y = 0; y < h; y += 1) {
    const row = y * w * 4
    for (let x = 0; x < w; x += 1) {
      if (rgba[row + x * 4 + 3]! <= threshold) continue
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }

  if (maxX < 0 || maxY < 0) return full
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 }
}

/**
 * 알파가 있는 이미지의 빈 여백을 찾는다. 스티커 제작의 핵심 동작이다.
 * 배경을 지운 뒤 이걸 돌리면 피사체에 딱 맞는 크롭이 나온다.
 *
 * threshold 는 0~255 알파 단위다. 기본값 8 은 페더가 남긴 거의 안 보이는
 * 꼬리를 여백으로 본다. 0 으로 두면 눈에 안 보이는 1/255 픽셀 하나 때문에
 * 아무것도 잘리지 않는다.
 *
 * 비동기 서명은 지금 필요해서가 아니라, 나중에 워커로 옮길 때 호출부를
 * 고치지 않기 위해서다.
 */
export async function autoTrimAlpha(source: ImageBitmap, threshold = 8): Promise<CropRect> {
  const image = readPixels(source)
  return alphaBounds(image.data, image.width, image.height, threshold)
}

// ---------------------------------------------------------------------------
// 단색 여백
// ---------------------------------------------------------------------------

/**
 * 단색 여백 판정의 기본 허용치. colorDistance 스케일(흰-검 = 1)이다.
 *
 * 0.06 은 JPEG 의 흰 여백에 낀 압축 노이즈를 같은 색으로 보되, 연한 회색 그림자는
 * 내용으로 남긴다. 크게 잡을수록 더 많이 잘리는데, 잘못 잘린 것은 되돌려도
 * 알아채기 어렵다. 덜 자르는 쪽이 안전하다.
 */
export const SOLID_TRIM_TOLERANCE = 0.06

export interface TrimOptions {
  /** 0~255. 이 값 이하의 알파는 여백이다. */
  alphaThreshold?: number
  /** 0~1. 모서리 색과 이 거리 이내면 여백으로 본다. 0 이면 단색 판정을 끈다. */
  colorTolerance?: number
}

/** 픽셀 하나를 읽는다. 범위 밖이면 null. */
function pixelAt(
  rgba: Uint8ClampedArray | Uint8Array,
  w: number,
  x: number,
  y: number,
): [number, number, number, number] | null {
  const p = (y * w + x) * 4
  const r = rgba[p]
  const g = rgba[p + 1]
  const b = rgba[p + 2]
  const a = rgba[p + 3]
  if (r === undefined || g === undefined || b === undefined || a === undefined) return null
  return [r, g, b, a]
}

/**
 * 네 모서리에서 배경색을 고른다.
 *
 * 하나(좌상단)만 쓰지 않는 이유는 사진의 왼쪽 위 구석에 피사체가 걸치는 경우가
 * 흔하기 때문이다. 서로 같은 색인 모서리가 가장 많은 후보를 배경으로 본다.
 * 동점이면 먼저 나온 쪽이 이긴다(결정론).
 *
 * 네 모서리가 전부 다르면 null 이다. 그런 그림에는 단색 여백이 없다.
 */
export function pickBorderColor(
  rgba: Uint8ClampedArray | Uint8Array,
  w: number,
  h: number,
  tolerance = SOLID_TRIM_TOLERANCE,
): [number, number, number] | null {
  if (w <= 0 || h <= 0) return null
  const corners = [
    pixelAt(rgba, w, 0, 0),
    pixelAt(rgba, w, w - 1, 0),
    pixelAt(rgba, w, 0, h - 1),
    pixelAt(rgba, w, w - 1, h - 1),
  ].filter((c): c is [number, number, number, number] => c !== null)
  if (corners.length === 0) return null

  let best: [number, number, number] | null = null
  let bestAgree = 0
  for (const c of corners) {
    const key: [number, number, number] = [c[0], c[1], c[2]]
    let agree = 0
    for (const other of corners) {
      if (colorDistance(other[0], other[1], other[2], key) <= tolerance) agree += 1
    }
    if (agree > bestAgree) {
      bestAgree = agree
      best = key
    }
  }
  // 자기 자신 하나만 동의하면 모서리가 전부 제각각이라는 뜻이다.
  return bestAgree >= 2 ? best : null
}

/**
 * 실제 내용이 들어 있는 최소 경계 상자.
 *
 * alphaBounds 만으로는 "빈 여백 자동 제거" 가 반쪽이다. 알파가 없는 JPG/불투명
 * PNG 에서는 전부 불투명이라 항상 전체 사각형이 나오고, 사용자 눈에는 버튼이
 * 아무 일도 안 하는 것으로 보인다. 그래서 두 단계로 판정한다.
 *
 *   1. 알파로 잘라 본다. 조금이라도 줄었으면 그 결과를 쓴다.
 *   2. 알파로 아무것도 못 줄였으면 모서리 색을 배경으로 보고 단색 여백을 잘라낸다.
 *
 * 순서가 중요하다. 반투명 스티커에서 단색 판정을 먼저 하면 완전 투명 픽셀들의
 * RGB(대개 0,0,0)를 배경색으로 잡아 피사체의 검은 부분까지 여백으로 본다.
 */
export function contentBounds(
  rgba: Uint8ClampedArray | Uint8Array,
  w: number,
  h: number,
  opts: TrimOptions = {},
): CropRect {
  const full: CropRect = { x: 0, y: 0, w, h }
  if (w <= 0 || h <= 0) return full

  const alphaThreshold = opts.alphaThreshold ?? 8
  const byAlpha = alphaBounds(rgba, w, h, alphaThreshold)
  if (byAlpha.w < w || byAlpha.h < h) return byAlpha

  const tolerance = opts.colorTolerance ?? SOLID_TRIM_TOLERANCE
  if (!(tolerance > 0)) return full
  const bg = pickBorderColor(rgba, w, h, tolerance)
  if (!bg) return full

  let minX = w
  let minY = h
  let maxX = -1
  let maxY = -1

  for (let y = 0; y < h; y += 1) {
    const row = y * w * 4
    for (let x = 0; x < w; x += 1) {
      const p = row + x * 4
      // 투명한 픽셀은 색과 무관하게 여백이다.
      if (rgba[p + 3]! <= alphaThreshold) continue
      if (colorDistance(rgba[p]!, rgba[p + 1]!, rgba[p + 2]!, bg) <= tolerance) continue
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }

  // 전부 배경색이면 자를 것이 없다. 0 크기를 돌려주면 호출자가 자르기에 실패한다.
  if (maxX < 0 || maxY < 0) return full
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 }
}

/**
 * 이미지에서 실제 내용의 경계를 찾는다. contentBounds 의 비트맵 래퍼다.
 * autoTrimAlpha 와 달리 불투명 이미지의 단색 여백도 잡는다.
 */
export async function autoTrimContent(
  source: ImageBitmap,
  opts: TrimOptions = {},
): Promise<CropRect> {
  const image = readPixels(source)
  return contentBounds(image.data, image.width, image.height, opts)
}

// ---------------------------------------------------------------------------
// 드래그 편집
// ---------------------------------------------------------------------------

/** 크롭 상자에서 잡을 수 있는 지점. move 는 상자 안쪽이다. */
export type CropHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'move'

export const CROP_HANDLES: readonly CropHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']

/** 크롭 상자의 최소 변 길이(자연 픽셀). 이보다 작으면 잡을 수도 없다. */
export const CROP_MIN_SIZE = 8

export interface CropDragArgs {
  /** 드래그를 시작한 순간의 사각형. 진행 중에는 바뀌지 않는다. */
  start: CropRect
  handle: CropHandle
  /** 시작점 기준 이동량. 자연 좌표계다. */
  dx: number
  dy: number
  bounds: CropRect
  /** w/h. null 이면 비율을 강제하지 않는다. */
  ratio: number | null
  min?: number
}

/**
 * 드래그 한 번을 사각형에 반영한다.
 *
 * 순수 함수다. 포인터 이벤트를 받지 않고 이동량만 받는다. 그래야 경계 조건을
 * 테스트로 고정할 수 있다. 크롭 상자가 경계를 넘거나 뒤집히는 사고는 전부
 * 여기서 막는다.
 *
 * 비율이 잠긴 상태의 규칙:
 *   - 모서리 핸들은 반대편 모서리를 고정하고 폭을 기준으로 높이를 만든다.
 *   - 위/아래 핸들은 높이가 기준이고, 좌/우 핸들은 폭이 기준이다. 이때 나머지
 *     축은 시작 사각형의 중심을 유지한 채 늘거나 준다.
 */
export function applyCropDrag(args: CropDragArgs): CropRect {
  const { start, handle, dx, dy, bounds, ratio } = args
  const minSize = Math.max(1, args.min ?? CROP_MIN_SIZE)

  const bx0 = bounds.x
  const by0 = bounds.y
  const bx1 = bounds.x + Math.max(0, bounds.w)
  const by1 = bounds.y + Math.max(0, bounds.h)

  if (handle === 'move') {
    const w = Math.min(start.w, bx1 - bx0)
    const h = Math.min(start.h, by1 - by0)
    return {
      x: clamp(start.x + dx, bx0, bx1 - w),
      y: clamp(start.y + dy, by0, by1 - h),
      w,
      h,
    }
  }

  const west = handle === 'nw' || handle === 'w' || handle === 'sw'
  const east = handle === 'ne' || handle === 'e' || handle === 'se'
  const north = handle === 'nw' || handle === 'n' || handle === 'ne'
  const south = handle === 'sw' || handle === 's' || handle === 'se'

  let x0 = start.x
  let y0 = start.y
  let x1 = start.x + start.w
  let y1 = start.y + start.h

  if (west) x0 = clamp(start.x + dx, bx0, x1 - minSize)
  if (east) x1 = clamp(x1 + dx, x0 + minSize, bx1)
  if (north) y0 = clamp(start.y + dy, by0, y1 - minSize)
  if (south) y1 = clamp(y1 + dy, y0 + minSize, by1)

  const free: CropRect = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
  if (ratio === null || !Number.isFinite(ratio) || ratio <= 0) return free

  // --- 비율 잠금 -----------------------------------------------------------
  const corner = (west || east) && (north || south)

  if (corner) {
    // 반대편 모서리를 고정한다.
    const ax = west ? x1 : x0
    const ay = north ? y1 : y0
    const availW = west ? ax - bx0 : bx1 - ax
    const availH = north ? ay - by0 : by1 - ay

    let w = Math.min(free.w, availW, availH * ratio)
    if (w < minSize) w = Math.min(minSize, availW, availH * ratio)
    const h = w / ratio
    return {
      x: west ? ax - w : ax,
      y: north ? ay - h : ay,
      w,
      h,
    }
  }

  // 한 축만 잡은 핸들. 나머지 축은 시작 중심을 유지한다.
  if (north || south) {
    const ay = north ? y1 : y0
    const availH = north ? ay - by0 : by1 - ay
    const cx = start.x + start.w / 2
    // 중심을 지키면서 경계 안에 들어갈 수 있는 최대 폭.
    const maxW = Math.min(bx1 - bx0, 2 * Math.min(cx - bx0, bx1 - cx))
    let h = Math.min(free.h, availH, maxW / ratio)
    if (h < minSize) h = Math.min(minSize, availH, maxW / ratio)
    const w = h * ratio
    return {
      x: clamp(cx - w / 2, bx0, bx1 - w),
      y: north ? ay - h : ay,
      w,
      h,
    }
  }

  const ax = west ? x1 : x0
  const availW = west ? ax - bx0 : bx1 - ax
  const cy = start.y + start.h / 2
  const maxH = Math.min(by1 - by0, 2 * Math.min(cy - by0, by1 - cy))
  let w = Math.min(free.w, availW, maxH * ratio)
  if (w < minSize) w = Math.min(minSize, availW, maxH * ratio)
  const h = w / ratio
  return {
    x: west ? ax - w : ax,
    y: clamp(cy - h / 2, by0, by1 - h),
    w,
    h,
  }
}

/**
 * 정수 픽셀로 확정한다. 화면 표시와 문서 기록이 같은 값을 쓰게 만든다.
 * 원점이 (0,0) 인 이미지 좌표계 전용이다. 크롭 경계는 언제나 이미지 전체다.
 */
export function roundRect(rect: CropRect, naturalW: number, naturalH: number): CropRect {
  return toPixelRect(rect, Math.max(1, Math.round(naturalW)), Math.max(1, Math.round(naturalH)))
}
