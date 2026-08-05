/**
 * APNG 무손실 팔레트화.
 *
 * PNG color type 3 은 픽셀당 1바이트 인덱스 + PLTE(RGB 3바이트/색) + tRNS(알파 1바이트/색)
 * 다. RGBA(color type 6) 대비 픽셀 데이터가 1/4 이라 파일이 보통 3~4배 작아진다.
 * 벡터풍 스티커, 플랫 컬러, 로고 애니메이션은 거의 다 256색 안에 들어간다.
 *
 * 원칙: 자동으로는 무손실인 경우만 낮춘다.
 *
 * 고유색이 256개 이하면 색을 하나도 건드리지 않고 인덱스로 옮길 수 있다. 이건 순수한
 * 이득이라 사용자에게 물을 것이 없다.
 *
 * 257색 이상이면 여기서 null 을 돌려주고 호출자가 RGBA 를 그대로 쓴다. 미디언컷이나
 * k-means 로 색을 줄이면 파일은 더 줄지만 화질이 떨어진다. 손실 변환은 사용자가
 * 고르게 해야 한다. 내보내기 대화상자에 노출되지 않은 화질 저하를 인코더가 몰래
 * 결정하면 안 된다. (GIF 는 포맷 자체가 256색이라 사정이 다르다. 거기서는
 * export/gif/dither.ts 가 maxColors 를 UI 로 받는다.)
 *
 * 애니메이션이라 팔레트는 전 프레임 공통이어야 한다. PLTE 는 파일에 하나뿐이다.
 * 그래서 buildGlobalPalette 가 모든 프레임의 색을 한꺼번에 모은다.
 *
 * window / document 를 import 하지 않으므로 워커에서 그대로 돈다.
 */

/** PLTE 최대 항목 수. 인덱스가 1바이트라 256이다. */
export const MAX_PALETTE_COLORS = 256

/** RGBA8 픽셀당 바이트 수. */
const BPP = 4

/** 인덱스 이미지의 픽셀당 바이트 수 (bit depth 8, color type 3). */
const INDEX_BPP = 1

export interface PaletteResult {
  /** 픽셀당 1바이트 인덱스. 길이는 픽셀 수와 같다. */
  indices: Uint8Array
  /** PLTE 데이터 그대로. RGB 3바이트씩 이어 붙인 것. */
  palette: Uint8Array
  /** tRNS 데이터 그대로. 앞쪽 n개 항목의 알파. 전부 불투명이면 null. */
  trns: Uint8Array | null
}

export interface GlobalPalette {
  /** PLTE 데이터. 길이 = size * 3 */
  palette: Uint8Array
  /** tRNS 데이터. 전부 불투명이면 null. */
  trns: Uint8Array | null
  /** packed RGBA -> 팔레트 인덱스. packRgba 로 만든 키를 쓴다. */
  lookup: Map<number, number>
  /** (0,0,0,0) 의 인덱스. 없으면 -1. OVER 델타에서 "안 바뀐 픽셀" 을 쓸 때 필요하다. */
  transparentIndex: number
  /** 색 개수. */
  size: number
}

/** RGBA 를 uint32 키 하나로 묶는다. r<<24 | g<<16 | b<<8 | a. */
export function packRgba(r: number, g: number, b: number, a: number): number {
  return ((r << 24) | (g << 16) | (b << 8) | a) >>> 0
}

function assertRgbaLength(rgba: Uint8Array): number {
  if (rgba.length % BPP !== 0) {
    throw new Error(`RGBA 버퍼 길이가 4의 배수가 아니다: ${rgba.length}`)
  }
  return rgba.length / BPP
}

/**
 * 프레임들의 고유색을 등장 순서대로 모은다. 256개를 넘는 순간 null 로 빠진다.
 * 조기 탈출이 없으면 512x512x24 에서 수백만 개짜리 Set 을 만들게 된다.
 */
function collectColors(frames: readonly Uint8Array[]): number[] | null {
  const seen = new Set<number>()
  const order: number[] = []

  for (const rgba of frames) {
    assertRgbaLength(rgba)
    // 같은 색이 연달아 오는 경우가 압도적으로 많다. 직전 값과 같으면 Set 조회를 건너뛴다.
    let last = -1
    for (let at = 0; at < rgba.length; at += BPP) {
      const key = packRgba(rgba[at]!, rgba[at + 1]!, rgba[at + 2]!, rgba[at + 3]!)
      if (key === last) continue
      last = key
      if (seen.has(key)) continue
      if (seen.size >= MAX_PALETTE_COLORS) return null
      seen.add(key)
      order.push(key)
    }
  }
  return order
}

/**
 * 여러 프레임이 공유할 팔레트를 만든다. 합쳐 256색을 넘으면 null.
 *
 * 알파가 있는 색을 앞으로 정렬한다. tRNS 는 "팔레트 앞에서부터 n개" 의 알파만 적는
 * 구조라, 반투명 색을 앞으로 모으면 tRNS 가 짧아진다. 완전 불투명만 있으면 tRNS 자체를
 * 생략한다. 정렬은 알파 오름차순 + 안정 정렬이라 같은 입력에 항상 같은 팔레트가 나온다.
 */
export function buildGlobalPalette(frames: readonly Uint8Array[]): GlobalPalette | null {
  if (frames.length === 0) return null

  const order = collectColors(frames)
  if (order === null || order.length === 0) return null

  // Array.prototype.sort 는 ES2019 부터 안정 정렬이 보장된다. 결정론이 유지된다.
  const sorted = order.slice().sort((a, b) => (a & 0xff) - (b & 0xff))

  const size = sorted.length
  const palette = new Uint8Array(size * 3)
  const alphas = new Uint8Array(size)
  const lookup = new Map<number, number>()
  let trnsLength = 0
  let transparentIndex = -1

  for (let i = 0; i < size; i++) {
    const key = sorted[i]!
    palette[i * 3] = (key >>> 24) & 0xff
    palette[i * 3 + 1] = (key >>> 16) & 0xff
    palette[i * 3 + 2] = (key >>> 8) & 0xff
    const a = key & 0xff
    alphas[i] = a
    if (a < 255) trnsLength = i + 1
    if (key === 0) transparentIndex = i
    lookup.set(key, i)
  }

  return {
    palette,
    trns: trnsLength > 0 ? alphas.slice(0, trnsLength) : null,
    lookup,
    transparentIndex,
    size,
  }
}

/**
 * RGBA 를 팔레트 인덱스로 옮긴다. 팔레트에 없는 색이 있으면 던진다.
 * (조용히 가까운 색으로 붙이면 그게 바로 몰래 하는 손실 변환이다.)
 */
export function mapToIndices(rgba: Uint8Array, lookup: ReadonlyMap<number, number>): Uint8Array {
  const count = assertRgbaLength(rgba)
  const out = new Uint8Array(count)

  let lastKey = -1
  let lastIndex = 0
  for (let i = 0, at = 0; i < count; i++, at += BPP) {
    const key = packRgba(rgba[at]!, rgba[at + 1]!, rgba[at + 2]!, rgba[at + 3]!)
    if (key !== lastKey) {
      const index = lookup.get(key)
      if (index === undefined) {
        throw new Error(`팔레트에 없는 색이다: 0x${key.toString(16).padStart(8, '0')}`)
      }
      lastKey = key
      lastIndex = index
    }
    out[i] = lastIndex
  }
  return out
}

/**
 * 단일 이미지 무손실 팔레트화. 고유색이 256개를 넘으면 null.
 * 호출자는 null 이면 RGBA 를 그대로 쓴다.
 */
export function quantize(rgba: Uint8Array): PaletteResult | null {
  const global = buildGlobalPalette([rgba])
  if (global === null) return null
  return {
    indices: mapToIndices(rgba, global.lookup),
    palette: global.palette,
    trns: global.trns,
  }
}

/**
 * 인덱스 이미지용 PNG 스캔라인 필터.
 *
 * filter.ts 는 RGBA 전용(bpp=4)이라 인덱스(bpp=1)에 쓸 수 없다. 알고리즘은 같다.
 * 행마다 None/Sub/Up/Average/Paeth 5종을 계산하고 부호 있는 절대값 합이 최소인 것을 고른다.
 *
 * bit depth 는 8 로 고정한다. 16색 이하면 4비트로 더 줄일 수 있지만, 사각형 오프셋이
 * 홀수일 때 행 패킹이 깨져 차분과 맞물리기가 까다롭다. 이득 대비 위험이 크다.
 */
export function filterIndexed(indices: Uint8Array, width: number, height: number): Uint8Array {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`width/height 가 잘못됐다: ${width}x${height}`)
  }
  const rowBytes = width * INDEX_BPP
  if (indices.length < rowBytes * height) {
    throw new Error(`인덱스 버퍼가 짧다: ${indices.length} < ${rowBytes * height}`)
  }

  const out = new Uint8Array(height * (rowBytes + 1))
  const cSub = new Uint8Array(rowBytes)
  const cUp = new Uint8Array(rowBytes)
  const cAvg = new Uint8Array(rowBytes)
  const cPaeth = new Uint8Array(rowBytes)

  let outAt = 0
  for (let y = 0; y < height; y++) {
    const rowStart = y * rowBytes
    const upStart = rowStart - rowBytes
    const hasUp = y > 0

    let sNone = 0
    let sSub = 0
    let sUp = 0
    let sAvg = 0
    let sPaeth = 0

    for (let i = 0; i < rowBytes; i++) {
      const x = indices[rowStart + i]!
      const a = i >= INDEX_BPP ? indices[rowStart + i - INDEX_BPP]! : 0
      const b = hasUp ? indices[upStart + i]! : 0
      const c = hasUp && i >= INDEX_BPP ? indices[upStart + i - INDEX_BPP]! : 0

      const fSub = (x - a) & 0xff
      const fUp = (x - b) & 0xff
      const fAvg = (x - ((a + b) >> 1)) & 0xff
      const fPaeth = (x - paeth(a, b, c)) & 0xff

      cSub[i] = fSub
      cUp[i] = fUp
      cAvg[i] = fAvg
      cPaeth[i] = fPaeth

      sNone += absSigned(x)
      sSub += absSigned(fSub)
      sUp += absSigned(fUp)
      sAvg += absSigned(fAvg)
      sPaeth += absSigned(fPaeth)
    }

    // 동점이면 낮은 필터 번호를 고른다.
    let best = 0
    let bestSum = sNone
    if (sSub < bestSum) {
      best = 1
      bestSum = sSub
    }
    if (sUp < bestSum) {
      best = 2
      bestSum = sUp
    }
    if (sAvg < bestSum) {
      best = 3
      bestSum = sAvg
    }
    if (sPaeth < bestSum) {
      best = 4
      bestSum = sPaeth
    }

    out[outAt++] = best
    switch (best) {
      case 1:
        out.set(cSub, outAt)
        break
      case 2:
        out.set(cUp, outAt)
        break
      case 3:
        out.set(cAvg, outAt)
        break
      case 4:
        out.set(cPaeth, outAt)
        break
      default:
        out.set(indices.subarray(rowStart, rowStart + rowBytes), outAt)
        break
    }
    outAt += rowBytes
  }

  return out
}

/** Paeth predictor (PNG 사양 6.6). 동점 우선순위 a > b > c 를 지킨다. */
function paeth(a: number, b: number, c: number): number {
  const p = a + b - c
  const pa = p > a ? p - a : a - p
  const pb = p > b ? p - b : b - p
  const pc = p > c ? p - c : c - p
  if (pa <= pb && pa <= pc) return a
  if (pb <= pc) return b
  return c
}

/** 필터 출력 바이트를 부호 있는 값으로 보고 절대값을 낸다. */
function absSigned(v: number): number {
  return v < 128 ? v : 256 - v
}
