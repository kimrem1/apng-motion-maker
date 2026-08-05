/**
 * 단색 배경 제거.
 *
 * 이 제품의 주 용도는 투명 배경 스티커다. 그런데 사용자가 가진 소재는
 * 대부분 흰 배경 JPG 다. 여기가 없으면 제품이 "투명 PNG 를 갖춰 오라"고 요구하는
 * 셈이 되고, 그 순간 3클릭 온보딩이 무너진다.
 *
 * 이 파일은 DOM 을 쓴다 (core/ easing/ 규칙과 다르다). 대신 결정론 계약은 지킨다.
 *   - createImageBitmap 옵션은 PREP_BITMAP_OPTIONS 로 고정한다.
 *   - Math.random / Date.now 를 쓰지 않는다. 같은 입력이면 같은 픽셀이 나온다.
 *   - 원본 ImageBitmap 은 절대 변형하지 않고 닫지도 않는다. 항상 새 비트맵을 만든다.
 *
 * 처리 순서가 품질을 결정한다. 이 순서를 바꾸면 결과가 나빠진다.
 *   1. 키 알파  : 색 거리 -> 알파 (얇은 소프트 밴드로 계단 방지)
 *   2. 연결 판정: contiguous 면 모서리에서 flood fill 로 "지울 영역"을 한정
 *   3. 디스필   : 배경색이 섞여 들어간 가장자리 색을 역산해서 뺀다
 *   4. 페더     : 알파에만 거리 기반 그라데이션
 *   5. 색 번짐  : 완전 투명 픽셀의 RGB 를 이웃 색으로 채운다
 *
 * 3번을 4번 뒤로 옮기면 안 된다. 디스필은 "배경이 얼마나 섞였는가"를 알파로 역산하는데
 * 페더가 알파를 이미 깎아 놓으면 그 비율이 거짓이 된다.
 */

// ---------------------------------------------------------------------------
// 상수
// ---------------------------------------------------------------------------

/**
 * 결정론 계약. decode.ts 와 같은 고정 옵션이다.
 * imageOrientation 은 넣지 않는다. ImageData / 캔버스 소스에는 EXIF 가 없다.
 */
export const PREP_BITMAP_OPTIONS: ImageBitmapOptions = {
  colorSpaceConversion: 'none',
  premultiplyAlpha: 'none',
}

/**
 * 크로마 축 가중치. 제곱 항에 곱하므로 선형으로는 sqrt(2.5) = 1.58 배다.
 * 이 값을 올리면 "밝기만 다른 색"이 더 잘 살아남고, 내리면 RGB 유클리드에 가까워진다.
 */
const CHROMA_GAIN = 2.5

/** Cb = (B - Y) * 0.5 / (1 - 0.114), Cr = (R - Y) * 0.5 / (1 - 0.299) */
const CB_K = 0.5 / 0.886
const CR_K = 0.5 / 0.701

/**
 * 소프트 밴드. tolerance 를 넘어선 뒤 얼마 만에 완전 불투명이 되는가.
 * 0 으로 두면 JPEG 의 안티에일리어싱된 경계가 계단으로 잘려 가장자리가 톱니가 된다.
 */
const SOFT_BAND_RATIO = 0.35
const SOFT_BAND_MIN = 0.02

/**
 * 디스필 역산의 분모 하한.
 * F = (C - (1-a)K) / a 는 a 가 0 에 가까울수록 노이즈를 증폭한다. 하한을 두면
 * 결과가 폭주하는 대신 보정량이 줄어든다. 어차피 그 픽셀은 거의 투명이라 눈에 안 띈다.
 */
const DESPILL_MIN_ALPHA = 0.08

/**
 * 경계 알파 재추정의 국소 기준 반경과 확장 링 수.
 *
 * 반경을 키우면 더 진한 이웃을 기준으로 삼아 경계가 과하게 투명해진다.
 * 링은 "실제로 알파가 깎인 픽셀"에서만 다음 링으로 번지므로 순수 전경에
 * 닿으면 저절로 멈춘다. 합성 테스트(2px 안티에일리어싱 원)에서 4 를 넘기면
 * 결과가 더 이상 변하지 않았다. 그래서 4 다.
 */
const EDGE_RADIUS = 2
const EDGE_RINGS = 4

/**
 * 투명 픽셀 RGB 채우기 반복 횟수.
 * 텍스처 이중선형 보간은 알파와 RGB 를 따로 섞는다. 투명 픽셀에 흰색이 남아 있으면
 * 축소/회전할 때 그 흰색이 가장자리로 스며 나온다. 2회면 보간 반경을 덮는다.
 */
const BLEED_PASSES = 2

/** 거리 변환의 "아직 안 정해짐" 값. Infinity 를 쓰면 나눗셈에서 NaN 이 난다. */
const EDT_INF = 1e20

// ---------------------------------------------------------------------------
// 색 거리
// ---------------------------------------------------------------------------

export interface Ycc {
  /** 0~1 */
  y: number
  /** -0.5~0.5 */
  cb: number
  /** -0.5~0.5 */
  cr: number
}

/** BT.601 YCbCr. 입력은 0~255, 출력은 위 주석의 범위다. */
export function rgbToYcc(r: number, g: number, b: number): Ycc {
  const y = (0.299 * r + 0.587 * g + 0.114 * b) / 255
  return { y, cb: (b / 255 - y) * CB_K, cr: (r / 255 - y) * CR_K }
}

/**
 * 색 거리. RGB 유클리드가 아니라 YCbCr 크로마 거리 + 휘도 가중을 쓴다.
 *
 * RGB 유클리드를 버린 이유는 두 가지다.
 *   1. 세 채널을 같은 무게로 더하면 "밝기만 다른 색"과 "색상이 다른 색"이 구별되지
 *      않는다. 흰 배경 위의 밝은 회색 옷은 남아야 하고, 초록 배경 위의 밝은 초록
 *      반사는 지워져야 하는데 RGB 거리로는 두 경우가 비슷하게 나온다.
 *   2. 사람 눈의 밝기 민감도는 채널마다 다르다. 초록의 1 단계와 파랑의 1 단계는
 *      체감 차이가 5배 넘게 난다. 0.299 / 0.587 / 0.114 가 그 가중치다.
 *
 * 정규화는 흰색-검정 거리가 정확히 1 이 되도록 맞췄다 (dY=1, dC=0 -> 1).
 * 크로마가 크게 어긋나면 1 을 넘을 수 있어 마지막에 1 로 클램프한다.
 * 따라서 tolerance 1 은 "전부 지운다"를 뜻한다.
 */
export function colorDistance(
  r: number,
  g: number,
  b: number,
  key: readonly [number, number, number],
): number {
  const a = rgbToYcc(r, g, b)
  const k = rgbToYcc(key[0], key[1], key[2])
  const dy = a.y - k.y
  const dcb = a.cb - k.cb
  const dcr = a.cr - k.cr
  const d = Math.sqrt(dy * dy + CHROMA_GAIN * (dcb * dcb + dcr * dcr))
  return d > 1 ? 1 : d
}

// ---------------------------------------------------------------------------
// 캔버스 왕복
// ---------------------------------------------------------------------------

/**
 * OffscreenCanvas 와 HTMLCanvasElement 의 2D 컨텍스트가 공통으로 만족하는 최소 인터페이스.
 * 유니온으로 두면 오버로드 해석이 꼬여서 구조적 타입으로 좁힌다 (alphaProbe.ts 와 같은 방식).
 */
interface Pixels2d {
  drawImage(image: ImageBitmap, dx: number, dy: number): void
  getImageData(sx: number, sy: number, sw: number, sh: number): ImageData
  putImageData(data: ImageData, dx: number, dy: number): void
}

interface Surface {
  ctx: Pixels2d
  canvas: OffscreenCanvas | HTMLCanvasElement
}

function createSurface(w: number, h: number): Surface | null {
  // willReadFrequently 는 GPU 왕복 대신 CPU 백킹을 쓰게 해 getImageData 를 빠르게 한다.
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(w, h)
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (ctx) return { ctx, canvas }
  }
  if (typeof document === 'undefined') return null

  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  return ctx ? { ctx, canvas } : null
}

/**
 * 비트맵의 픽셀을 straight alpha 로 읽는다.
 *
 * 알려진 손실: 2D 캔버스 백킹 스토어는 premultiplied 8비트다. 이미 알파가 있는
 * 이미지를 여기 통과시키면 반투명 영역의 RGB 정밀도가 조금 깎인다 (a=0.1 이면
 * 사실상 4비트 색). 흰 배경 JPG (전부 불투명) 에서는 손실이 없다.
 * 완전 무손실이 필요해지면 WebGL 리드백으로 바꿔야 하는데, 전처리는 일회성
 * 작업이라 그 복잡도를 지금 살 이유가 없다.
 */
export function readPixels(source: ImageBitmap): ImageData {
  const surface = createSurface(source.width, source.height)
  if (!surface) throw new Error('이 브라우저에서는 이미지 픽셀을 읽을 수 없습니다.')
  surface.ctx.drawImage(source, 0, 0)
  return surface.ctx.getImageData(0, 0, source.width, source.height)
}

/** ImageData -> ImageBitmap. 고정 옵션을 지키는 유일한 통로다. */
export async function bitmapFromImageData(image: ImageData): Promise<ImageBitmap> {
  try {
    // ImageData 를 직접 넘기면 캔버스 premultiply 왕복이 한 번 줄어든다.
    return await createImageBitmap(image, PREP_BITMAP_OPTIONS)
  } catch {
    const surface = createSurface(image.width, image.height)
    if (!surface) throw new Error('이 브라우저에서는 처리한 이미지를 만들 수 없습니다.')
    surface.ctx.putImageData(image, 0, 0)
    return await createImageBitmap(surface.canvas, PREP_BITMAP_OPTIONS)
  }
}

/** 원본을 건드리지 않고 독립된 사본을 만든다. 원본 보관용. */
export async function cloneBitmap(source: ImageBitmap): Promise<ImageBitmap> {
  return await createImageBitmap(source, PREP_BITMAP_OPTIONS)
}

// ---------------------------------------------------------------------------
// 연결 영역 (flood fill)
// ---------------------------------------------------------------------------

/**
 * 네 모서리에서 시작해 "지워질 픽셀"만 따라간다. 4방향 연결.
 *
 * 재귀를 쓰지 않는다. 1000x1000 단색 배경이면 깊이가 수십만이 되어 즉시
 * 스택 오버플로가 난다. 명시적 Int32Array 스택을 쓴다. 각 픽셀은 push 시점에
 * 방문 표시를 하므로 스택에 최대 한 번만 들어간다. 따라서 크기는 픽셀 수면 충분하다.
 */
function floodFromCorners(
  keyAlpha: Uint8Array,
  data: Uint8ClampedArray,
  w: number,
  h: number,
): Uint8Array {
  const n = w * h
  const region = new Uint8Array(n)
  const stack = new Int32Array(n)
  let sp = 0

  const push = (i: number): void => {
    if (region[i] === 1) return
    const srcA = data[i * 4 + 3]!
    // 알파가 원본보다 줄어든 픽셀만 "배경 후보"다. 완전 배경(0)뿐 아니라
    // 반투명하게 깎인 경계 픽셀도 포함해야 소프트 엣지가 이어진다.
    // 이미 완전 투명한 픽셀은 지울 것이 없지만 통로로는 열어 둔다. 막으면
    // 투명 테두리가 있는 PNG 에서 모서리 시드가 갇혀 아무것도 못 지운다.
    if (srcA !== 0 && keyAlpha[i]! >= srcA) return
    region[i] = 1
    stack[sp] = i
    sp += 1
  }

  push(0)
  push(w - 1)
  push((h - 1) * w)
  push(n - 1)

  while (sp > 0) {
    sp -= 1
    const i = stack[sp]!
    const x = i % w
    const y = (i - x) / w
    if (x > 0) push(i - 1)
    if (x < w - 1) push(i + 1)
    if (y > 0) push(i - w)
    if (y < h - 1) push(i + w)
  }

  return region
}

// ---------------------------------------------------------------------------
// 경계 알파 재추정
// ---------------------------------------------------------------------------

/**
 * 경계에 붙은 픽셀의 알파를 혼합 비율로 다시 구한다.
 *
 * 왜 필요한가. 색 거리는 혼합 비율에 정확히 비례한다.
 *   C = a*F + (1-a)*K  ->  C - K = a*(F - K)
 * YCbCr 은 RGB 의 선형 변환이고 거리는 노름이므로 d = a * |F - K| 다.
 * 즉 "순수 전경까지의 거리" |F-K| 를 알면 알파가 정확히 나온다.
 *
 * 임계값만 쓰면 이 관계를 통째로 버리게 된다. 흰 배경 위 빨강 피사체에서
 * 50% 섞인 경계 픽셀의 거리는 0.54 라 허용치(0.08)를 한참 넘고, 그대로
 * 완전 불투명이 된다. 디스필은 0<a<1 인 픽셀만 손대므로 걸리지도 않는다.
 * 결과는 1px 짜리 흰 테두리다. 투명 배경 스티커에서 가장 눈에 띄는 결함이다.
 *
 * 왜 전역 기준을 안 쓰는가. |F-K| 를 이미지 전체에서 하나로 잡으면 밝은
 * 피사체 영역이 통째로 반투명해진다(흰 배경 위 연분홍 옷). 그래서 대상은
 * 배경에 맞닿은 픽셀로 한정하고, 기준값은 반경 EDGE_RADIUS 안의 최대 거리로
 * 국소 추정한다. 섞인 픽셀의 거리는 언제나 순수 전경보다 작으므로 최대값이
 * 좋은 대용값이다. 피사체 안쪽은 이 패스가 아예 건드리지 않는다.
 *
 * 결정론: 한 링을 다 훑어 값을 모은 뒤 한꺼번에 쓴다. 훑는 도중에 쓰면
 * 순회 순서가 결과를 바꾼다.
 */
function refineEdges(
  keyAlpha: Uint8Array,
  dist: Uint8Array,
  data: Uint8ClampedArray,
  region: Uint8Array | null,
  w: number,
  h: number,
): void {
  const n = w * h
  const softened = new Uint8Array(n)
  const idx: number[] = []
  const val: number[] = []

  /** 이 픽셀이 "지워진 배경"인가. contiguous 면 연결 영역 안이어야 한다. */
  const isRemoved = (i: number): boolean =>
    keyAlpha[i]! < data[i * 4 + 3]! && (region === null || region[i] === 1)

  for (let ring = 0; ring < EDGE_RINGS; ring += 1) {
    idx.length = 0
    val.length = 0

    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const i = y * w + x
        if (softened[i] === 1) continue
        const srcA = data[i * 4 + 3]!
        const cur = keyAlpha[i]!
        // 이미 완전히 지워진 픽셀은 더 낮출 것이 없다.
        // 반대로 소프트 밴드에 걸린 픽셀은 반드시 포함해야 한다. 밴드가 준
        // 알파는 "거리를 밴드 폭으로 나눈 값"이라 혼합 비율과 무관하다.
        // 흰 배경의 9% 커버 픽셀이 알파 0.95 로 남는 사고가 여기서 난다.
        if (srcA === 0 || cur === 0) continue

        const near =
          (x > 0 && isRemoved(i - 1)) ||
          (x < w - 1 && isRemoved(i + 1)) ||
          (y > 0 && isRemoved(i - w)) ||
          (y < h - 1 && isRemoved(i + w))
        if (!near) continue

        let ref = dist[i]!
        const y0 = y > EDGE_RADIUS ? y - EDGE_RADIUS : 0
        const y1 = Math.min(h - 1, y + EDGE_RADIUS)
        const x0 = x > EDGE_RADIUS ? x - EDGE_RADIUS : 0
        const x1 = Math.min(w - 1, x + EDGE_RADIUS)
        for (let ny = y0; ny <= y1; ny += 1) {
          const row = ny * w
          for (let nx = x0; nx <= x1; nx += 1) {
            const d = dist[row + nx]!
            if (d > ref) ref = d
          }
        }
        if (ref === 0) continue

        const a = Math.round((srcA * dist[i]!) / ref)
        // 절대 키우지 않는다. 키우면 이미 지운 배경이 되살아난다.
        if (a >= cur) continue
        idx.push(i)
        val.push(a)
      }
    }

    // 이번 링에서 아무것도 안 깎였으면 다음 링도 볼 것이 없다.
    if (idx.length === 0) return
    for (let k = 0; k < idx.length; k += 1) {
      const i = idx[k]!
      keyAlpha[i] = val[k]!
      softened[i] = 1
      // 다음 단계가 이 픽셀도 처리하도록 연결 영역에 포함시킨다.
      if (region) region[i] = 1
    }
  }
}

// ---------------------------------------------------------------------------
// 거리 변환 (페더용)
// ---------------------------------------------------------------------------

/**
 * 1차원 제곱 거리 변환 (Felzenszwalb & Huttenlocher, 하한 포락선).
 * 포물선 하한 포락선을 훑어 O(n) 에 정확한 값을 낸다. 근사가 아니다.
 */
function edt1d(f: Float64Array, d: Float64Array, v: Int32Array, z: Float64Array, n: number): void {
  let k = 0
  v[0] = 0
  z[0] = -EDT_INF
  z[1] = EDT_INF

  for (let q = 1; q < n; q += 1) {
    const fq = f[q]! + q * q
    let vk = v[k]!
    let s = (fq - (f[vk]! + vk * vk)) / (2 * q - 2 * vk)
    while (k > 0 && s <= z[k]!) {
      k -= 1
      vk = v[k]!
      s = (fq - (f[vk]! + vk * vk)) / (2 * q - 2 * vk)
    }
    k += 1
    v[k] = q
    z[k] = s
    z[k + 1] = EDT_INF
  }

  k = 0
  for (let q = 0; q < n; q += 1) {
    while (z[k + 1]! < q) k += 1
    const vk = v[k]!
    const dq = q - vk
    d[q] = dq * dq + f[vk]!
  }
}

/**
 * 2차원 제곱 거리 변환. 열 -> 행 두 번 훑는다.
 * 챔퍼(3-4) 근사를 쓰면 대각선 오차가 최대 8% 라 페더 폭이 방향마다 달라진다.
 * 가장자리 품질이 이 기능의 존재 이유라 정확한 쪽을 택했다.
 */
function edt2d(grid: Float32Array, w: number, h: number): void {
  const maxDim = Math.max(w, h)
  const f = new Float64Array(maxDim)
  const d = new Float64Array(maxDim)
  const v = new Int32Array(maxDim)
  const z = new Float64Array(maxDim + 1)

  for (let x = 0; x < w; x += 1) {
    for (let y = 0; y < h; y += 1) f[y] = grid[y * w + x]!
    edt1d(f, d, v, z, h)
    for (let y = 0; y < h; y += 1) grid[y * w + x] = d[y]!
  }

  for (let y = 0; y < h; y += 1) {
    const row = y * w
    for (let x = 0; x < w; x += 1) f[x] = grid[row + x]!
    edt1d(f, d, v, z, w)
    for (let x = 0; x < w; x += 1) grid[row + x] = d[x]!
  }
}

/**
 * 알파 경계에 거리 기반 그라데이션을 넣는다.
 *
 * 단순 블러를 쓰면 안 된다. 블러는 커널이 닿는 모든 픽셀의 알파를 낮추므로
 * 피사체 안쪽까지 반투명해진다. 여기서는 "완전 투명 픽셀까지의 거리"만 보고
 * 그 거리가 featherPx 안쪽인 픽셀의 알파만 비례해서 낮춘다. 피사체 안쪽은
 * 거리가 크므로 절대 건드려지지 않는다.
 *
 * 안쪽으로만 깎는다. 바깥으로 번지게 하면 이미 지운 배경 픽셀이 되살아난다.
 * RGB 는 건드리지 않는다.
 */
function applyFeather(data: Uint8ClampedArray, w: number, h: number, featherPx: number): void {
  const n = w * h
  const grid = new Float32Array(n)
  let hasSeed = false

  for (let i = 0; i < n; i += 1) {
    if (data[i * 4 + 3]! === 0) {
      grid[i] = 0
      hasSeed = true
    } else {
      grid[i] = EDT_INF
    }
  }
  // 지워진 픽셀이 하나도 없으면 페더할 경계 자체가 없다.
  if (!hasSeed) return

  edt2d(grid, w, h)

  // 투명 픽셀에 딱 붙은 픽셀의 거리는 1 이다. featherPx=1 일 때 그 픽셀이
  // 절반쯤 투명해지도록 +1 을 둔다.
  const range = featherPx + 1
  for (let i = 0; i < n; i += 1) {
    const p = i * 4 + 3
    const a = data[p]!
    if (a === 0) continue
    const dist = Math.sqrt(grid[i]!)
    if (dist >= range) continue
    // Uint8ClampedArray 대입은 [0,255] 클램프 + 반올림을 언어 차원에서 보장한다.
    data[p] = a * (dist / range)
  }
}

// ---------------------------------------------------------------------------
// 투명 픽셀 색 채우기
// ---------------------------------------------------------------------------

/**
 * 완전 투명 픽셀의 RGB 를 이웃한 불투명 픽셀 색으로 채운다. 알파는 건드리지 않는다.
 *
 * 왜 필요한가. 이 파이프라인은 straight alpha 를 유지한다. GPU 이중선형
 * 보간은 RGB 와 A 를 독립적으로 섞으므로, 투명 픽셀에 흰색이 남아 있으면 축소나
 * 회전 시 그 흰색이 피사체 가장자리로 스며 나온다. 디스필로 없앤 흰 테두리가
 * 렌더 단계에서 되살아나는 셈이다.
 *
 * 결정론: 각 패스는 패스 시작 시점의 filled 스냅샷만 읽고, 그때 비어 있던
 * 픽셀에만 쓴다. 읽는 영역과 쓰는 영역이 겹치지 않으므로 순회 순서와 무관하게
 * 같은 결과가 나온다.
 */
export function bleedEdgeColors(data: Uint8ClampedArray, w: number, h: number): void {
  const n = w * h
  const filled = new Uint8Array(n)
  let hasEmpty = false
  let hasFilled = false

  for (let i = 0; i < n; i += 1) {
    if (data[i * 4 + 3]! > 0) {
      filled[i] = 1
      hasFilled = true
    } else {
      hasEmpty = true
    }
  }
  if (!hasEmpty || !hasFilled) return

  for (let pass = 0; pass < BLEED_PASSES; pass += 1) {
    const prev = filled.slice()
    let changed = false

    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const i = y * w + x
        if (prev[i] === 1) continue

        let r = 0
        let g = 0
        let b = 0
        let count = 0
        const y0 = y > 0 ? y - 1 : 0
        const y1 = y < h - 1 ? y + 1 : h - 1
        const x0 = x > 0 ? x - 1 : 0
        const x1 = x < w - 1 ? x + 1 : w - 1

        for (let ny = y0; ny <= y1; ny += 1) {
          for (let nx = x0; nx <= x1; nx += 1) {
            const j = ny * w + nx
            if (prev[j] !== 1) continue
            const q = j * 4
            r += data[q]!
            g += data[q + 1]!
            b += data[q + 2]!
            count += 1
          }
        }
        if (count === 0) continue

        const p = i * 4
        data[p] = r / count
        data[p + 1] = g / count
        data[p + 2] = b / count
        filled[i] = 1
        changed = true
      }
    }
    if (!changed) return
  }
}

// ---------------------------------------------------------------------------
// 본체
// ---------------------------------------------------------------------------

export interface BgRemoveOptions {
  /** 지울 배경색. 0~255. */
  keyColor: [number, number, number]
  /** 0~1. colorDistance 가 이 값 이하면 완전한 배경으로 본다. */
  tolerance: number
  /** 가장자리 부드럽게. 알파에만 적용한다. */
  featherPx: number
  /** 모서리에서 연결된 영역만 지운다. 피사체 안의 같은 색은 남긴다. */
  contiguous: boolean
}

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v)

function sanitizeChannel(v: number): number {
  if (!Number.isFinite(v)) return 0
  return clamp(Math.round(v), 0, 255)
}

/**
 * 배경을 지운 새 ImageBitmap 을 만든다. 원본은 변형하지 않고 닫지도 않는다.
 * 호출자가 원본과 결과의 수명을 모두 관리한다.
 */
export async function removeBackground(
  source: ImageBitmap,
  opts: BgRemoveOptions,
): Promise<ImageBitmap> {
  const w = source.width
  const h = source.height
  if (w === 0 || h === 0) throw new Error('이미지 크기가 0이라 배경을 지울 수 없습니다.')

  const image = readPixels(source)
  const data = image.data
  const n = w * h

  const kr = sanitizeChannel(opts.keyColor[0])
  const kg = sanitizeChannel(opts.keyColor[1])
  const kb = sanitizeChannel(opts.keyColor[2])
  const tolerance = Number.isFinite(opts.tolerance) ? clamp(opts.tolerance, 0, 1) : 0
  const featherPx = Number.isFinite(opts.featherPx) ? Math.max(0, opts.featherPx) : 0
  const band = Math.max(SOFT_BAND_MIN, tolerance * SOFT_BAND_RATIO)

  // 키 색상의 YCbCr 은 픽셀마다 다시 구하지 않는다.
  const ky = (0.299 * kr + 0.587 * kg + 0.114 * kb) / 255
  const kcb = (kb / 255 - ky) * CB_K
  const kcr = (kr / 255 - ky) * CR_K

  // 1) 색 거리와 키 알파. 이 단계에서는 아직 픽셀에 쓰지 않는다.
  //    contiguous 판정과 경계 재추정에 "원본 알파"가 그대로 필요하기 때문이다.
  //    거리는 0~255 로 양자화해 둔다. 나중에 비율로만 쓰므로 1/255 정밀도면 넘친다.
  const keyAlpha = new Uint8Array(n)
  const dist = new Uint8Array(n)
  for (let i = 0; i < n; i += 1) {
    const p = i * 4
    const srcA = data[p + 3]!
    if (srcA === 0) continue

    const r = data[p]!
    const g = data[p + 1]!
    const b = data[p + 2]!
    const y = (0.299 * r + 0.587 * g + 0.114 * b) / 255
    const dy = y - ky
    const dcb = (b / 255 - y) * CB_K - kcb
    const dcr = (r / 255 - y) * CR_K - kcr
    const d = Math.sqrt(dy * dy + CHROMA_GAIN * (dcb * dcb + dcr * dcr))

    dist[i] = Math.round(clamp(d, 0, 1) * 255)
    keyAlpha[i] = Math.round(srcA * clamp((d - tolerance) / band, 0, 1))
  }

  // 2) 연결 영역. contiguous 가 꺼져 있으면 전체가 대상이다.
  const region = opts.contiguous ? floodFromCorners(keyAlpha, data, w, h) : null

  // 3) 경계 픽셀 알파 재추정
  refineEdges(keyAlpha, dist, data, region, w, h)

  // 4) 알파 적용 + 디스필.
  //
  //    관측색 C 는 전경 F 가 배경 K 위에 비율 m 으로 합성된 결과다.
  //      C = m*F + (1-m)*K   ->   F = (C - (1-m)*K) / m
  //    이 역산이 디스필이다. 안 하면 흰 배경을 지웠을 때 가장자리에 흰 테두리가
  //    그대로 남는다. 투명 스티커 품질의 핵심이 이 몇 줄이다.
  //
  //    m 은 절대 알파가 아니라 원본 알파 대비 남은 비율이다. 원본이 이미
  //    반투명한 픽셀(srcA=128)에서 절대 알파를 쓰면, 배경이 섞이지도 않은
  //    픽셀을 섞였다고 보고 색을 망가뜨린다.
  for (let i = 0; i < n; i += 1) {
    if (region && region[i] === 0) continue
    const p = i * 4
    const srcA = data[p + 3]!
    const a = keyAlpha[i]!
    data[p + 3] = a
    if (a === 0 || a >= srcA) continue

    const m = Math.max(a / srcA, DESPILL_MIN_ALPHA)
    const inv = 1 - m
    data[p] = (data[p]! - inv * kr) / m
    data[p + 1] = (data[p + 1]! - inv * kg) / m
    data[p + 2] = (data[p + 2]! - inv * kb) / m
  }

  // 5) 페더 (알파 전용)
  if (featherPx > 0) applyFeather(data, w, h, featherPx)

  // 6) 투명 픽셀 색 채우기
  bleedEdgeColors(data, w, h)

  return await bitmapFromImageData(image)
}

// ---------------------------------------------------------------------------
// 자동 추정
// ---------------------------------------------------------------------------

/** 모서리 패치 한 변의 길이 비율과 그 상하한. */
const CORNER_RATIO = 0.06
const CORNER_MIN = 4
const CORNER_MAX = 32

/** 채널별 중앙값. 평균은 피사체가 모서리에 걸치면 그쪽으로 끌려간다. */
function medianChannel(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = values.slice().sort((a, b) => a - b)
  const mid = sorted.length >> 1
  if (sorted.length % 2 === 1) return sorted[mid]!
  return Math.round((sorted[mid - 1]! + sorted[mid]!) / 2)
}

/**
 * 네 모서리에서 배경색을 고른다.
 *
 * 모서리마다 중앙값을 구한 뒤, 넷 중 나머지 셋과 가장 가까운 색을 고른다(메도이드).
 * 넷을 한꺼번에 평균/중앙값 내지 않는 이유는, 한 모서리에만 피사체가 걸쳐 있을 때
 * 그 색이 결과를 끌고 가기 때문이다. 메도이드는 이상치 하나를 통째로 버린다.
 */
export function pickKeyColorFromCorners(source: ImageBitmap): [number, number, number] {
  const w = source.width
  const h = source.height
  if (w === 0 || h === 0) return [255, 255, 255]

  const image = readPixels(source)
  const data = image.data
  const size = clamp(Math.round(Math.min(w, h) * CORNER_RATIO), CORNER_MIN, CORNER_MAX)
  const sw = Math.min(size, w)
  const sh = Math.min(size, h)

  const origins: [number, number][] = [
    [0, 0],
    [w - sw, 0],
    [0, h - sh],
    [w - sw, h - sh],
  ]

  const colors: [number, number, number][] = []
  for (const [ox, oy] of origins) {
    const rs: number[] = []
    const gs: number[] = []
    const bs: number[] = []
    for (let y = oy; y < oy + sh; y += 1) {
      for (let x = ox; x < ox + sw; x += 1) {
        const p = (y * w + x) * 4
        // 이미 투명한 픽셀은 배경색 후보가 아니다.
        if (data[p + 3]! === 0) continue
        rs.push(data[p]!)
        gs.push(data[p + 1]!)
        bs.push(data[p + 2]!)
      }
    }
    if (rs.length === 0) continue
    colors.push([medianChannel(rs), medianChannel(gs), medianChannel(bs)])
  }

  // 모서리가 전부 투명하면 이미 배경이 없는 이미지다. 흰색을 기본값으로 준다.
  if (colors.length === 0) return [255, 255, 255]
  if (colors.length === 1) return colors[0]!

  let best = colors[0]!
  let bestScore = Number.POSITIVE_INFINITY
  for (const c of colors) {
    let score = 0
    for (const other of colors) score += colorDistance(c[0], c[1], c[2], other)
    if (score < bestScore) {
      bestScore = score
      best = c
    }
  }
  return best
}

/** 테두리 링 두께 비율과 표본 상한. 표본이 많아도 분위수는 거의 안 변한다. */
const RING_RATIO = 0.03
const RING_MIN_PX = 2
const SAMPLE_CAP = 20000

/** 균일 배경도 최소한 이만큼은 허용해야 JPEG 블록 노이즈를 넘긴다. */
const TOLERANCE_MIN = 0.05
const TOLERANCE_MAX = 0.6
/** 분위수에 곱하는 여유. 링에서 못 본 그라데이션 끝단까지 덮기 위한 값이다. */
const TOLERANCE_SLACK = 1.6
const TOLERANCE_FLOOR_ADD = 0.03

/**
 * 테두리 링의 색 분포에서 허용치를 추정한다.
 *
 * 링 픽셀의 키 색상까지의 거리를 모아 95 분위수를 본다. 완전 균일한 배경이면
 * 0 에 가깝고, JPEG 노이즈나 그라데이션이 있으면 커진다. 여기에 여유를 곱한다.
 * 95 분위수를 쓰는 이유는 링에 피사체가 조금 걸쳐 있어도(상위 5%) 그 값이
 * 추정을 망가뜨리지 않게 하기 위해서다.
 */
export function estimateTolerance(
  source: ImageBitmap,
  keyColor: [number, number, number],
): number {
  const w = source.width
  const h = source.height
  if (w === 0 || h === 0) return TOLERANCE_MIN

  const image = readPixels(source)
  const data = image.data
  const ring = Math.max(RING_MIN_PX, Math.round(Math.min(w, h) * RING_RATIO))

  const ringPixels = Math.max(1, w * h - Math.max(0, w - 2 * ring) * Math.max(0, h - 2 * ring))
  // 결정론적 간격 추출. 난수 표본은 같은 이미지에서 매번 다른 값을 낸다.
  const stride = Math.max(1, Math.ceil(ringPixels / SAMPLE_CAP))

  const distances: number[] = []
  let seen = 0
  for (let y = 0; y < h; y += 1) {
    const edgeRow = y < ring || y >= h - ring
    for (let x = 0; x < w; x += 1) {
      if (!edgeRow && x >= ring && x < w - ring) {
        // 안쪽은 통째로 건너뛴다.
        x = w - ring - 1
        continue
      }
      seen += 1
      if (seen % stride !== 0) continue
      const p = (y * w + x) * 4
      if (data[p + 3]! === 0) continue
      distances.push(colorDistance(data[p]!, data[p + 1]!, data[p + 2]!, keyColor))
    }
  }

  if (distances.length === 0) return TOLERANCE_MIN
  distances.sort((a, b) => a - b)
  const idx = Math.min(distances.length - 1, Math.floor(distances.length * 0.95))
  const p95 = distances[idx]!

  return clamp(p95 * TOLERANCE_SLACK + TOLERANCE_FLOOR_ADD, TOLERANCE_MIN, TOLERANCE_MAX)
}
