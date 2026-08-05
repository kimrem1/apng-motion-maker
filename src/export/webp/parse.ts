/**
 * WebP 파서.
 *
 * 두 가지 일을 한다.
 *
 * 1. 정지 WebP 해체. `convertToBlob({type:'image/webp'})` 가 돌려준 파일에서
 *    VP8 / VP8L 비트스트림과 ALPH 청크를 꺼낸다. 인코더가 ANMF 로 감쌀 재료다.
 *    이 경로만 프로덕션에서 쓴다.
 * 2. 애니메이션 WebP 검사. VP8X / ANIM / ANMF 를 읽어 루프 카운트와 프레임 지연을
 *    되돌려 준다. 테스트의 왕복 검증용이며 픽셀을 디코딩하지 않는다.
 *
 * DOM 을 참조하지 않는다. 순수 함수뿐이라 Node 에서 그대로 돈다.
 */

import {
  findChunk,
  parseRiff,
  readChunks,
  readUint16LE,
  readUint24LE,
  readUint32LE,
  type RiffChunk,
} from './riff.ts'

// ---------------------------------------------------------------------------
// 상수
// ---------------------------------------------------------------------------

/** 손실 비트스트림 fourCC. 4글자를 채우려고 뒤에 공백이 붙는다. 이걸 빼먹으면 못 찾는다. */
export const VP8_FOURCC = 'VP8 '
/** 무손실 비트스트림 fourCC. */
export const VP8L_FOURCC = 'VP8L'
/** 손실 비트스트림에 딸리는 알파 평면 청크. */
export const ALPH_FOURCC = 'ALPH'
export const VP8X_FOURCC = 'VP8X'
export const ANIM_FOURCC = 'ANIM'
export const ANMF_FOURCC = 'ANMF'

/** VP8X 플래그 바이트. 첫 바이트의 MSB 부터 Rsv Rsv I L E X A R 순이다. */
export const VP8X_FLAG_ICC = 0x20
export const VP8X_FLAG_ALPHA = 0x10
export const VP8X_FLAG_EXIF = 0x08
export const VP8X_FLAG_XMP = 0x04
export const VP8X_FLAG_ANIMATION = 0x02

/**
 * ANMF flags 바이트. 하위 2비트만 쓴다.
 * bit 1 (B) = 블렌딩 방법. 1 이면 블렌딩하지 않고 사각형을 덮어쓴다.
 * bit 0 (D) = 폐기 방법. 1 이면 표시 후 사각형을 배경색으로 지운다.
 */
export const ANMF_FLAG_BLEND_NONE = 0x02
export const ANMF_FLAG_DISPOSE_BACKGROUND = 0x01

/** VP8 / VP8L 이 담을 수 있는 최대 변 길이. 폭 필드가 14비트다. */
export const WEBP_MAX_DIMENSION = 16383

// ---------------------------------------------------------------------------
// 비트스트림 헤더
// ---------------------------------------------------------------------------

export interface Vp8HeaderInfo {
  width: number
  height: number
}

/**
 * VP8(손실) 키 프레임 헤더.
 *   frame tag(3, LE) + 시작 코드 9d 01 2a(3) + width(2, LE) + height(2, LE)
 * width / height 는 하위 14비트가 크기, 상위 2비트가 스케일이다.
 */
export function parseVp8Header(data: Uint8Array): Vp8HeaderInfo {
  if (data.length < 10) {
    throw new Error(`VP8: 헤더 10바이트가 안 된다 (${data.length})`)
  }
  const tag = readUint24LE(data, 0)
  // 최하위 비트가 0 이면 키 프레임이다. 정지 WebP 는 항상 키 프레임 하나다.
  if ((tag & 1) !== 0) {
    throw new Error('VP8: 키 프레임이 아니다')
  }
  if (data[3] !== 0x9d || data[4] !== 0x01 || data[5] !== 0x2a) {
    throw new Error('VP8: 시작 코드 9d 01 2a 가 아니다')
  }
  return {
    width: readUint16LE(data, 6) & 0x3fff,
    height: readUint16LE(data, 8) & 0x3fff,
  }
}

export interface Vp8lHeaderInfo {
  width: number
  height: number
  /** 헤더의 alpha_is_used 비트. ALPH 청크 없이 알파를 담는다. */
  hasAlpha: boolean
}

/**
 * VP8L(무손실) 헤더 5바이트.
 *   signature 0x2f(8) + width-1(14) + height-1(14) + alpha_is_used(1) + version(3)
 * 비트는 바이트 안에서 LSB 부터 채워지므로 4바이트를 리틀엔디언 uint32 로 읽고 잘라 쓴다.
 */
export function parseVp8lHeader(data: Uint8Array): Vp8lHeaderInfo {
  if (data.length < 5) {
    throw new Error(`VP8L: 헤더 5바이트가 안 된다 (${data.length})`)
  }
  if (data[0] !== 0x2f) {
    throw new Error(`VP8L: 시그니처 0x2f 가 아니다 (0x${(data[0] ?? 0).toString(16)})`)
  }
  const bits = readUint32LE(data, 1)
  const version = (bits >>> 29) & 0x07
  if (version !== 0) {
    throw new Error(`VP8L: 알 수 없는 버전 ${version}`)
  }
  return {
    width: (bits & 0x3fff) + 1,
    height: ((bits >>> 14) & 0x3fff) + 1,
    hasAlpha: ((bits >>> 28) & 1) === 1,
  }
}

/**
 * VP8L 헤더 5바이트를 만든다.
 * 테스트가 최소 비트스트림을 조립할 때와, 값 왕복을 확인할 때 쓴다.
 */
export function buildVp8lHeader(width: number, height: number, hasAlpha: boolean): Uint8Array {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > WEBP_MAX_DIMENSION ||
    height > WEBP_MAX_DIMENSION
  ) {
    throw new Error(`VP8L: 크기는 1..${WEBP_MAX_DIMENSION} 이어야 한다 (${width}x${height})`)
  }
  const out = new Uint8Array(5)
  out[0] = 0x2f
  // width-1(14) | height-1(14) << 14 | alpha << 28 | version(0) << 29
  const bits = ((width - 1) | ((height - 1) << 14) | ((hasAlpha ? 1 : 0) << 28)) >>> 0
  out[1] = bits & 0xff
  out[2] = (bits >>> 8) & 0xff
  out[3] = (bits >>> 16) & 0xff
  out[4] = (bits >>> 24) & 0xff
  return out
}

// ---------------------------------------------------------------------------
// 정지 WebP 해체
// ---------------------------------------------------------------------------

export type WebpBitstreamFourCC = typeof VP8_FOURCC | typeof VP8L_FOURCC

export interface StaticWebpImage {
  width: number
  height: number
  hasAlpha: boolean
  /** 'VP8 ' 또는 'VP8L' */
  bitstreamFourCC: WebpBitstreamFourCC
  /** 비트스트림 페이로드. 원본 버퍼의 subarray 다. */
  bitstream: Uint8Array
  /**
   * 손실 + 알파일 때만 있는 알파 평면.
   * 무손실(VP8L)은 알파를 비트스트림 안에 담으므로 항상 null 이다.
   * **이 둘을 구분하지 않으면 투명 스티커의 알파가 통째로 사라진다.**
   */
  alph: Uint8Array | null
  /** VP8X 확장 컨테이너였는가 */
  extended: boolean
}

/**
 * 정지 WebP 파일 하나를 ANMF 에 넣을 재료로 분해한다.
 * 브라우저가 단순 컨테이너(VP8/VP8L 단독)를 주든 확장 컨테이너(VP8X+ALPH+VP8)를 주든
 * 똑같이 처리한다. 어느 쪽을 주는지는 브라우저와 버전에 달렸으므로 가정하지 않는다.
 */
export function parseStaticWebp(bytes: Uint8Array): StaticWebpImage {
  const { chunks } = parseRiff(bytes)

  if (findChunk(chunks, ANMF_FOURCC) !== null) {
    throw new Error('정지 WebP 를 기대했는데 애니메이션 WebP(ANMF)가 들어왔다')
  }

  const vp8x = findChunk(chunks, VP8X_FOURCC)
  const alph = findChunk(chunks, ALPH_FOURCC)
  const vp8l = findChunk(chunks, VP8L_FOURCC)
  const vp8 = findChunk(chunks, VP8_FOURCC)

  if (vp8l !== null) {
    const header = parseVp8lHeader(vp8l.data)
    return {
      width: header.width,
      height: header.height,
      // VP8X 가 알파를 선언했으면 그것도 인정한다. 둘 중 하나라도 켜져 있으면 알파가 있다.
      hasAlpha: header.hasAlpha || vp8xHasAlpha(vp8x),
      bitstreamFourCC: VP8L_FOURCC,
      bitstream: vp8l.data,
      alph: null,
      extended: vp8x !== null,
    }
  }

  if (vp8 !== null) {
    const header = parseVp8Header(vp8.data)
    return {
      width: header.width,
      height: header.height,
      hasAlpha: alph !== null || vp8xHasAlpha(vp8x),
      bitstreamFourCC: VP8_FOURCC,
      bitstream: vp8.data,
      alph: alph !== null ? alph.data : null,
      extended: vp8x !== null,
    }
  }

  const found = chunks.map((c) => c.fourCC).join(', ')
  throw new Error(`WebP 비트스트림(VP8 / VP8L)이 없다. 들어 있는 청크: [${found}]`)
}

function vp8xHasAlpha(vp8x: RiffChunk | null): boolean {
  if (vp8x === null || vp8x.data.length < 1) return false
  return ((vp8x.data[0] ?? 0) & VP8X_FLAG_ALPHA) !== 0
}

// ---------------------------------------------------------------------------
// 애니메이션 WebP 검사
// ---------------------------------------------------------------------------

export interface WebpFrameInfo {
  /** 캔버스 좌상단 기준 좌표. 파일에는 2픽셀 단위로 저장되므로 항상 짝수다. */
  x: number
  y: number
  width: number
  height: number
  durationMs: number
  /** true 면 사각형을 덮어쓴다(알파 블렌딩 없음). 투명 프레임에는 이쪽이 맞다. */
  blendNone: boolean
  /** true 면 표시 후 사각형을 배경색으로 지운다. */
  disposeBackground: boolean
  /** ANMF 안의 서브청크 fourCC. ['VP8L'] 또는 ['ALPH','VP8 '] 형태다. */
  subChunks: string[]
  hasAlpha: boolean
}

export interface WebpInfo {
  /** 캔버스 크기. VP8X 가 있으면 그 값, 없으면 비트스트림 헤더 값. */
  width: number
  height: number
  /** VP8X 의 ANIMATION 비트와 ANIM 청크가 모두 있는가 */
  animated: boolean
  /** ANIM 청크가 없으면 null. **0 은 무한 반복**이므로 null 과 구분해야 한다. */
  loopCount: number | null
  /** ANMF 개수. 정지 파일이면 1. */
  frameCount: number
  /** ANMF 마다 하나. 정지 파일이면 빈 배열. */
  durationsMs: number[]
  hasAlpha: boolean
  /** ANIM 의 배경색 [B, G, R, A]. ANIM 이 없으면 null. */
  backgroundBgra: [number, number, number, number] | null
  frames: WebpFrameInfo[]
}

/** ANMF 페이로드 고정부 길이. x(3) y(3) w-1(3) h-1(3) duration(3) flags(1). */
const ANMF_HEADER_BYTES = 16

/** VP8X 페이로드 길이. flags(1) + reserved(3) + w-1(3) + h-1(3). */
const VP8X_BYTES = 10

/** ANIM 페이로드 길이. background BGRA(4) + loop_count(2, LE). */
const ANIM_BYTES = 6

export function parseWebp(bytes: Uint8Array): WebpInfo {
  const { chunks } = parseRiff(bytes)

  const vp8x = findChunk(chunks, VP8X_FOURCC)
  const anim = findChunk(chunks, ANIM_FOURCC)

  let width = 0
  let height = 0
  let hasAlpha = false
  let animationFlag = false

  if (vp8x !== null) {
    if (vp8x.data.length < VP8X_BYTES) {
      throw new Error(`VP8X: 페이로드가 ${VP8X_BYTES}바이트가 안 된다 (${vp8x.data.length})`)
    }
    const flags = vp8x.data[0] ?? 0
    hasAlpha = (flags & VP8X_FLAG_ALPHA) !== 0
    animationFlag = (flags & VP8X_FLAG_ANIMATION) !== 0
    width = readUint24LE(vp8x.data, 4) + 1
    height = readUint24LE(vp8x.data, 7) + 1
  }

  let loopCount: number | null = null
  let backgroundBgra: [number, number, number, number] | null = null
  if (anim !== null) {
    if (anim.data.length < ANIM_BYTES) {
      throw new Error(`ANIM: 페이로드가 ${ANIM_BYTES}바이트가 안 된다 (${anim.data.length})`)
    }
    backgroundBgra = [
      anim.data[0] ?? 0,
      anim.data[1] ?? 0,
      anim.data[2] ?? 0,
      anim.data[3] ?? 0,
    ]
    loopCount = readUint16LE(anim.data, 4)
  }

  const frames: WebpFrameInfo[] = []
  for (const chunk of chunks) {
    if (chunk.fourCC !== ANMF_FOURCC) continue
    frames.push(parseAnmf(chunk))
  }

  const animated = animationFlag && anim !== null && frames.length > 0

  if (!animated && frames.length === 0) {
    // 정지 파일. 비트스트림 헤더에서 크기와 알파를 읽는다.
    const still = parseStaticWebp(bytes)
    return {
      width: width > 0 ? width : still.width,
      height: height > 0 ? height : still.height,
      animated: false,
      loopCount,
      frameCount: 1,
      durationsMs: [],
      hasAlpha: hasAlpha || still.hasAlpha,
      backgroundBgra,
      frames: [],
    }
  }

  for (const frame of frames) {
    if (frame.hasAlpha) hasAlpha = true
  }

  return {
    width,
    height,
    animated,
    loopCount,
    frameCount: frames.length,
    durationsMs: frames.map((f) => f.durationMs),
    hasAlpha,
    backgroundBgra,
    frames,
  }
}

function parseAnmf(chunk: RiffChunk): WebpFrameInfo {
  const data = chunk.data
  if (data.length < ANMF_HEADER_BYTES) {
    throw new Error(`ANMF: 헤더 ${ANMF_HEADER_BYTES}바이트가 안 된다 (${data.length})`)
  }

  // 좌표만 2픽셀 단위다. 크기는 픽셀 단위 -1 이다. 이 비대칭이 먹싱 버그의 단골이다.
  const x = readUint24LE(data, 0) * 2
  const y = readUint24LE(data, 3) * 2
  const width = readUint24LE(data, 6) + 1
  const height = readUint24LE(data, 9) + 1
  const durationMs = readUint24LE(data, 12)
  const flags = data[15] ?? 0

  const subs = readChunks(data, ANMF_HEADER_BYTES, data.length)
  const subChunks = subs.map((c) => c.fourCC)

  let frameHasAlpha = subChunks.includes(ALPH_FOURCC)
  const lossless = subs.find((c) => c.fourCC === VP8L_FOURCC)
  if (lossless !== undefined) {
    frameHasAlpha = frameHasAlpha || parseVp8lHeader(lossless.data).hasAlpha
  }

  return {
    x,
    y,
    width,
    height,
    durationMs,
    blendNone: (flags & ANMF_FLAG_BLEND_NONE) !== 0,
    disposeBackground: (flags & ANMF_FLAG_DISPOSE_BACKGROUND) !== 0,
    subChunks,
    hasAlpha: frameHasAlpha,
  }
}
