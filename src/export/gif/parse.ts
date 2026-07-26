// 검증용 최소 GIF 파서. 테스트에서만 쓴다. 프로덕션 디코더가 아니다.
// 인터레이스, Plain Text 확장, 로컬 팔레트 없는 프레임 등은 우리가 만드는
// 파일에 나오지 않으므로 최소한만 다룬다.

export interface GifHeaderInfo {
  /** 'GIF87a' | 'GIF89a' */
  version: string
  width: number
  height: number
  /** NETSCAPE2.0 확장의 반복 값. 확장이 없으면 null. 0 은 무한. */
  loopCount: number | null
  frameCount: number
  /** Graphic Control Extension 마다 하나. 단위는 1/100초. */
  delaysCentis: number[]
}

export interface GifFrameInfo {
  x: number
  y: number
  width: number
  height: number
  delayCentis: number
  disposal: number
  transparent: boolean
  transparentIndex: number
  /** 이 프레임에 적용되는 팔레트 (로컬이 있으면 로컬, 없으면 글로벌). */
  palette: number[][]
  /** width * height 개의 팔레트 인덱스. */
  indices: Uint8Array
}

export interface GifFileInfo extends GifHeaderInfo {
  globalPalette: number[][]
  frames: GifFrameInfo[]
}

const EXT_INTRODUCER = 0x21
const IMAGE_SEPARATOR = 0x2c
const TRAILER = 0x3b
const LABEL_GCE = 0xf9
const LABEL_APP = 0xff

/** 헤더 + 루프 카운트 + 프레임 수 + 딜레이만 뽑는다. */
export function parseGifHeader(bytes: Uint8Array): GifHeaderInfo {
  const file = parseGif(bytes, false)
  return {
    version: file.version,
    width: file.width,
    height: file.height,
    loopCount: file.loopCount,
    frameCount: file.frameCount,
    delaysCentis: file.delaysCentis,
  }
}

/** 프레임 픽셀 인덱스까지 디코딩한다 (LZW 포함). */
export function parseGifFrames(bytes: Uint8Array): GifFileInfo {
  return parseGif(bytes, true)
}

function parseGif(bytes: Uint8Array, decodePixels: boolean): GifFileInfo {
  if (bytes.length < 13) throw new Error('parseGif: 파일이 너무 짧다')

  const version = readAscii(bytes, 0, 6)
  if (!version.startsWith('GIF')) {
    throw new Error(`parseGif: GIF 시그니처가 아니다 (${version})`)
  }

  let p = 6
  const width = readU16(bytes, p)
  const height = readU16(bytes, p + 2)
  const packed = at(bytes, p + 4)
  p += 7 // width(2) height(2) packed(1) bgIndex(1) aspect(1)

  let globalPalette: number[][] = []
  if ((packed & 0x80) !== 0) {
    const size = 1 << ((packed & 0x07) + 1)
    globalPalette = readColorTable(bytes, p, size)
    p += size * 3
  }

  let loopCount: number | null = null
  const delaysCentis: number[] = []
  const frames: GifFrameInfo[] = []

  // 직전 GCE 상태. 이미지 디스크립터를 만나면 소비한다.
  let pendingDelay = 0
  let pendingDisposal = 0
  let pendingTransparent = false
  let pendingTransparentIndex = 0

  while (p < bytes.length) {
    const marker = at(bytes, p)

    if (marker === TRAILER) break

    if (marker === EXT_INTRODUCER) {
      const label = at(bytes, p + 1)
      p += 2

      if (label === LABEL_GCE) {
        const blockSize = at(bytes, p)
        const gcePacked = at(bytes, p + 1)
        pendingDisposal = (gcePacked >> 2) & 0x07
        pendingTransparent = (gcePacked & 0x01) === 1
        pendingDelay = readU16(bytes, p + 2)
        pendingTransparentIndex = at(bytes, p + 4)
        delaysCentis.push(pendingDelay)
        p += 1 + blockSize
        p = skipSubBlocks(bytes, p)
        continue
      }

      if (label === LABEL_APP) {
        const blockSize = at(bytes, p)
        const id = readAscii(bytes, p + 1, blockSize)
        p += 1 + blockSize
        if (id === 'NETSCAPE2.0') {
          // 서브블록: [size=3][1][loopLo][loopHi] ... [0]
          let q = p
          while (q < bytes.length) {
            const size = at(bytes, q)
            if (size === 0) {
              q += 1
              break
            }
            if (size >= 3 && at(bytes, q + 1) === 1) {
              loopCount = readU16(bytes, q + 2)
            }
            q += 1 + size
          }
          p = q
        } else {
          p = skipSubBlocks(bytes, p)
        }
        continue
      }

      // 그 외 확장(주석, Plain Text 등)은 통째로 건너뛴다.
      p = skipSubBlocks(bytes, p)
      continue
    }

    if (marker === IMAGE_SEPARATOR) {
      p += 1
      const fx = readU16(bytes, p)
      const fy = readU16(bytes, p + 2)
      const fw = readU16(bytes, p + 4)
      const fh = readU16(bytes, p + 6)
      const imgPacked = at(bytes, p + 8)
      p += 9

      let palette = globalPalette
      if ((imgPacked & 0x80) !== 0) {
        const size = 1 << ((imgPacked & 0x07) + 1)
        palette = readColorTable(bytes, p, size)
        p += size * 3
      }

      const minCodeSize = at(bytes, p)
      p += 1
      const dataStart = p
      p = skipSubBlocks(bytes, p)

      let indices: Uint8Array = new Uint8Array(0)
      if (decodePixels) {
        const lzw = collectSubBlocks(bytes, dataStart)
        indices = lzwDecode(minCodeSize, lzw, fw * fh)
      }

      frames.push({
        x: fx,
        y: fy,
        width: fw,
        height: fh,
        delayCentis: pendingDelay,
        disposal: pendingDisposal,
        transparent: pendingTransparent,
        transparentIndex: pendingTransparentIndex,
        palette,
        indices,
      })

      pendingDelay = 0
      pendingDisposal = 0
      pendingTransparent = false
      pendingTransparentIndex = 0
      continue
    }

    throw new Error(`parseGif: 알 수 없는 블록 0x${marker.toString(16)} (offset ${p})`)
  }

  return {
    version,
    width,
    height,
    loopCount,
    frameCount: frames.length,
    delaysCentis,
    globalPalette,
    frames,
  }
}

function at(bytes: Uint8Array, i: number): number {
  const v = bytes[i]
  if (v === undefined) throw new Error(`parseGif: offset ${i} 가 파일 범위를 벗어났다`)
  return v
}

function readU16(bytes: Uint8Array, i: number): number {
  return at(bytes, i) | (at(bytes, i + 1) << 8)
}

function readAscii(bytes: Uint8Array, offset: number, length: number): string {
  let s = ''
  for (let i = 0; i < length; i += 1) s += String.fromCharCode(at(bytes, offset + i))
  return s
}

function readColorTable(bytes: Uint8Array, offset: number, size: number): number[][] {
  const out: number[][] = []
  for (let i = 0; i < size; i += 1) {
    const o = offset + i * 3
    out.push([at(bytes, o), at(bytes, o + 1), at(bytes, o + 2)])
  }
  return out
}

/** 서브블록 체인을 건너뛰고 종료 바이트(0) 다음 오프셋을 돌려준다. */
function skipSubBlocks(bytes: Uint8Array, offset: number): number {
  let p = offset
  while (p < bytes.length) {
    const size = at(bytes, p)
    p += 1
    if (size === 0) return p
    p += size
  }
  return p
}

/** 서브블록 체인의 페이로드를 하나로 이어붙인다. */
function collectSubBlocks(bytes: Uint8Array, offset: number): Uint8Array {
  const chunks: Uint8Array[] = []
  let p = offset
  let total = 0
  while (p < bytes.length) {
    const size = at(bytes, p)
    p += 1
    if (size === 0) break
    chunks.push(bytes.subarray(p, p + size))
    total += size
    p += size
  }
  const out = new Uint8Array(total)
  let w = 0
  for (const c of chunks) {
    out.set(c, w)
    w += c.length
  }
  return out
}

/**
 * GIF 가변 코드 폭 LZW 디코더.
 * 인터레이스는 지원하지 않는다 (우리 인코더는 인터레이스를 쓰지 않는다).
 */
function lzwDecode(minCodeSize: number, data: Uint8Array, pixelCount: number): Uint8Array {
  const MAX_CODES = 4096
  const clearCode = 1 << minCodeSize
  const eoiCode = clearCode + 1

  const prefix = new Int32Array(MAX_CODES)
  const suffix = new Uint8Array(MAX_CODES)
  const stack = new Uint8Array(MAX_CODES + 1)
  for (let i = 0; i < clearCode; i += 1) {
    prefix[i] = 0
    suffix[i] = i
  }

  const out = new Uint8Array(pixelCount)

  let codeSize = minCodeSize + 1
  let codeMask = (1 << codeSize) - 1
  let available = clearCode + 2
  let oldCode = -1
  let first = 0

  let bits = 0
  let datum = 0
  let ptr = 0
  let top = 0
  let outIdx = 0

  while (outIdx < pixelCount) {
    if (top === 0) {
      if (bits < codeSize) {
        if (ptr >= data.length) break
        datum |= (data[ptr] ?? 0) << bits
        ptr += 1
        bits += 8
        continue
      }

      let code = datum & codeMask
      datum >>= codeSize
      bits -= codeSize

      if (code === eoiCode) break

      if (code === clearCode) {
        codeSize = minCodeSize + 1
        codeMask = (1 << codeSize) - 1
        available = clearCode + 2
        oldCode = -1
        continue
      }

      if (oldCode === -1) {
        stack[top] = suffix[code] ?? 0
        top += 1
        oldCode = code
        first = code
        continue
      }

      const inCode = code
      if (code >= available) {
        stack[top] = first
        top += 1
        code = oldCode
      }
      while (code >= clearCode) {
        stack[top] = suffix[code] ?? 0
        top += 1
        code = prefix[code] ?? 0
      }
      first = suffix[code] ?? 0
      stack[top] = first
      top += 1

      if (available < MAX_CODES) {
        prefix[available] = oldCode
        suffix[available] = first
        available += 1
        if ((available & codeMask) === 0 && available < MAX_CODES) {
          codeSize += 1
          codeMask += available
        }
      }
      oldCode = inCode
    }

    top -= 1
    out[outIdx] = stack[top] ?? 0
    outIdx += 1
  }

  return out
}
