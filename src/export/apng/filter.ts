/**
 * PNG 스캔라인 필터 (RGBA8 전용).
 *
 * 필터는 압축 전 전처리다. 이게 파일 크기를 좌우한다.
 * 각 행마다 None/Sub/Up/Average/Paeth 5종을 모두 계산하고
 * "부호 있는 바이트로 본 절대값 합"이 최소인 것을 고른다 (libpng 표준 휴리스틱).
 *
 * 출력은 행마다 [filterType, ...filteredBytes] 이며 총 height * (1 + width*4) 바이트다.
 */

/** RGBA8 의 픽셀당 바이트 수. Sub/Average/Paeth 에서 왼쪽 이웃 거리로 쓴다. */
export const BYTES_PER_PIXEL = 4

export const FILTER_NONE = 0
export const FILTER_SUB = 1
export const FILTER_UP = 2
export const FILTER_AVERAGE = 3
export const FILTER_PAETH = 4

/**
 * Paeth predictor (PNG 사양 6.6).
 * a = 왼쪽, b = 위, c = 왼쪽 위. 동점일 때의 우선순위 a > b > c 를 지켜야 한다.
 */
export function paethPredictor(a: number, b: number, c: number): number {
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

/**
 * RGBA8 픽셀 버퍼를 PNG 필터링된 스캔라인 스트림으로 바꾼다.
 * rgba 는 straight alpha 그대로 쓴다. 프리멀티플라이 해제 같은 변환은 하지 않는다.
 */
export function filterScanlines(rgba: Uint8Array, width: number, height: number): Uint8Array {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`width/height 가 잘못됐다: ${width}x${height}`)
  }
  const bpp = BYTES_PER_PIXEL
  const rowBytes = width * bpp
  const needed = rowBytes * height
  if (rgba.length < needed) {
    throw new Error(`RGBA 버퍼가 짧다: ${rgba.length} < ${needed}`)
  }

  const out = new Uint8Array(height * (rowBytes + 1))

  // 후보 5종 버퍼는 한 번만 할당하고 행마다 재사용한다.
  const cNone = new Uint8Array(rowBytes)
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
      const x = rgba[rowStart + i]!
      const a = i >= bpp ? rgba[rowStart + i - bpp]! : 0
      const b = hasUp ? rgba[upStart + i]! : 0
      const c = hasUp && i >= bpp ? rgba[upStart + i - bpp]! : 0

      const fNone = x
      const fSub = (x - a) & 0xff
      const fUp = (x - b) & 0xff
      const fAvg = (x - ((a + b) >> 1)) & 0xff
      const fPaeth = (x - paethPredictor(a, b, c)) & 0xff

      cNone[i] = fNone
      cSub[i] = fSub
      cUp[i] = fUp
      cAvg[i] = fAvg
      cPaeth[i] = fPaeth

      sNone += absSigned(fNone)
      sSub += absSigned(fSub)
      sUp += absSigned(fUp)
      sAvg += absSigned(fAvg)
      sPaeth += absSigned(fPaeth)
    }

    // 동점이면 낮은 필터 번호를 고른다 (None 이 디코딩이 가장 싸다).
    let best = FILTER_NONE
    let bestSum = sNone
    if (sSub < bestSum) {
      best = FILTER_SUB
      bestSum = sSub
    }
    if (sUp < bestSum) {
      best = FILTER_UP
      bestSum = sUp
    }
    if (sAvg < bestSum) {
      best = FILTER_AVERAGE
      bestSum = sAvg
    }
    if (sPaeth < bestSum) {
      best = FILTER_PAETH
      bestSum = sPaeth
    }

    out[outAt++] = best
    switch (best) {
      case FILTER_SUB:
        out.set(cSub, outAt)
        break
      case FILTER_UP:
        out.set(cUp, outAt)
        break
      case FILTER_AVERAGE:
        out.set(cAvg, outAt)
        break
      case FILTER_PAETH:
        out.set(cPaeth, outAt)
        break
      case FILTER_NONE:
      default:
        out.set(cNone, outAt)
        break
    }
    outAt += rowBytes
  }

  return out
}
