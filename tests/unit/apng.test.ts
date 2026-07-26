import { describe, expect, it } from 'vitest'

import {
  chunkCrcOk,
  parseChunks,
  PNG_SIGNATURE,
  readUint16BE,
  readUint32BE,
  writeChunk,
  type PngChunk,
} from '@/export/apng/chunks.ts'
import { crc32 } from '@/export/apng/crc32.ts'
import { adler32, hasNativeDeflate, zlibDeflate, zlibStored } from '@/export/apng/deflate.ts'
import { BYTES_PER_PIXEL, filterScanlines } from '@/export/apng/filter.ts'
import { encodeApng, type ApngFrame } from '@/export/apng/encoder.ts'

// ---------------------------------------------------------------------------
// 테스트 유틸. 인코더와 독립적으로 구현해야 검증이 의미가 있다.
// ---------------------------------------------------------------------------

const hasDecompression = typeof DecompressionStream !== 'undefined'

function ascii(text: string): Uint8Array {
  const out = new Uint8Array(text.length)
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i)
  return out
}

/** 원본 언필터. filter.ts 를 참조하지 않고 PNG 사양대로 다시 쓴다. */
function paeth(a: number, b: number, c: number): number {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  if (pb <= pc) return b
  return c
}

function unfilterScanlines(filtered: Uint8Array, width: number, height: number): Uint8Array {
  const bpp = BYTES_PER_PIXEL
  const rowBytes = width * bpp
  expect(filtered.length).toBe(height * (rowBytes + 1))

  const out = new Uint8Array(rowBytes * height)
  let p = 0
  for (let y = 0; y < height; y++) {
    const filterType = filtered[p]!
    p += 1
    const rowStart = y * rowBytes
    for (let i = 0; i < rowBytes; i++) {
      const x = filtered[p + i]!
      const a = i >= bpp ? out[rowStart + i - bpp]! : 0
      const b = y > 0 ? out[rowStart - rowBytes + i]! : 0
      const c = y > 0 && i >= bpp ? out[rowStart - rowBytes + i - bpp]! : 0
      let v: number
      switch (filterType) {
        case 0:
          v = x
          break
        case 1:
          v = x + a
          break
        case 2:
          v = x + b
          break
        case 3:
          v = x + ((a + b) >> 1)
          break
        case 4:
          v = x + paeth(a, b, c)
          break
        default:
          throw new Error(`알 수 없는 필터 타입 ${filterType}`)
      }
      out[rowStart + i] = v & 0xff
    }
    p += rowBytes
  }
  return out
}

function filterTypesOf(filtered: Uint8Array, width: number, height: number): number[] {
  const stride = width * BYTES_PER_PIXEL + 1
  const types: number[] = []
  for (let y = 0; y < height; y++) types.push(filtered[y * stride]!)
  return types
}

/** 결정론적 테스트 이미지. Math.random 을 쓰지 않는다. */
function makeImage(width: number, height: number, seed: number): Uint8Array {
  const rgba = new Uint8Array(width * height * 4)
  let at = 0
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const inBox = x >= seed % Math.max(1, width) && y >= seed % Math.max(1, height)
      rgba[at++] = (x * 7 + seed * 13) & 0xff
      rgba[at++] = (y * 11 + seed * 29) & 0xff
      rgba[at++] = (x * y + seed) & 0xff
      rgba[at++] = inBox ? 0xff : 0x40
    }
  }
  return rgba
}

function expectBytesEqual(actual: Uint8Array, expected: Uint8Array): void {
  expect(actual.length).toBe(expected.length)
  for (let i = 0; i < expected.length; i++) {
    if (actual[i] !== expected[i]) {
      throw new Error(`바이트 ${i} 불일치: ${actual[i]} != ${expected[i]}`)
    }
  }
}

async function inflateZlib(data: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream('deflate')
  const writer = ds.writable.getWriter()
  const reader = ds.readable.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  const pump = (async () => {
    for (;;) {
      const result = await reader.read()
      if (result.done) break
      const chunk = result.value as Uint8Array
      chunks.push(chunk)
      total += chunk.length
    }
  })()
  await writer.write(data as unknown as ArrayBufferView<ArrayBuffer>)
  await writer.close()
  await pump
  const out = new Uint8Array(total)
  let at = 0
  for (const chunk of chunks) {
    out.set(chunk, at)
    at += chunk.length
  }
  return out
}

function chunkOfType(chunks: PngChunk[], type: string): PngChunk {
  const found = chunks.find((c) => c.type === type)
  if (!found) throw new Error(`${type} 청크가 없다`)
  return found
}

function chunksOfType(chunks: PngChunk[], type: string): PngChunk[] {
  return chunks.filter((c) => c.type === type)
}

// ---------------------------------------------------------------------------
// CRC32
// ---------------------------------------------------------------------------

describe('crc32', () => {
  it('IEND 청크의 CRC 는 0xAE426082 다', () => {
    expect(crc32(ascii('IEND'))).toBe(0xae426082)
  })

  it('표준 체크값 "123456789" 은 0xCBF43926 이다', () => {
    expect(crc32(ascii('123456789'))).toBe(0xcbf43926)
  })

  it('빈 입력은 0 이다', () => {
    expect(crc32(new Uint8Array(0))).toBe(0)
  })

  it('start/length 로 구간을 지정할 수 있다', () => {
    const padded = ascii('xxIENDyy')
    expect(crc32(padded, 2, 4)).toBe(0xae426082)
  })

  it('IHDR 타입 문자열도 알려진 값과 맞는다', () => {
    // "IHDR" 4바이트만의 CRC. 자체 구현끼리 비교하지 않고 상수로 고정한다.
    expect(crc32(ascii('IHDR'))).toBe(0xa8a1ae0a)
  })
})

// ---------------------------------------------------------------------------
// 청크 라이터 / 파서
// ---------------------------------------------------------------------------

describe('writeChunk / parseChunks', () => {
  it('IEND 청크는 사양의 12바이트와 정확히 일치한다', () => {
    const bytes = writeChunk('IEND', new Uint8Array(0))
    expectBytesEqual(
      bytes,
      new Uint8Array([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]),
    )
  })

  it('길이 필드는 데이터 길이이고 CRC 는 타입+데이터 범위다', () => {
    const data = new Uint8Array([1, 2, 3, 4, 5])
    const bytes = writeChunk('acTL', data)
    expect(bytes.length).toBe(12 + data.length)
    expect(readUint32BE(bytes, 0)).toBe(5)
    expect(readUint32BE(bytes, 12 - 4 + data.length)).toBe(crc32(bytes, 4, 4 + data.length))
  })

  it('타입이 4글자가 아니면 던진다', () => {
    expect(() => writeChunk('IEN', new Uint8Array(0))).toThrow()
    expect(() => writeChunk('IENDX', new Uint8Array(0))).toThrow()
  })

  it('시그니처가 아니면 파싱을 거부한다', () => {
    expect(() => parseChunks(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toThrow()
  })

  it('왕복: 쓴 청크를 그대로 되읽는다', () => {
    const a = writeChunk('IHDR', new Uint8Array([9, 8, 7]))
    const b = writeChunk('IEND', new Uint8Array(0))
    const png = new Uint8Array(PNG_SIGNATURE.length + a.length + b.length)
    png.set(PNG_SIGNATURE, 0)
    png.set(a, PNG_SIGNATURE.length)
    png.set(b, PNG_SIGNATURE.length + a.length)

    const chunks = parseChunks(png)
    expect(chunks.map((c) => c.type)).toEqual(['IHDR', 'IEND'])
    expect(chunks[0]!.length).toBe(3)
    expectBytesEqual(chunks[0]!.data, new Uint8Array([9, 8, 7]))
    expect(chunks.every((c) => chunkCrcOk(png, c))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 스캔라인 필터
// ---------------------------------------------------------------------------

describe('filterScanlines', () => {
  const sizes: Array<[number, number]> = [
    [1, 1],
    [1, 8],
    [8, 1],
    [7, 5],
    [16, 16],
    [37, 23],
  ]

  for (const [w, h] of sizes) {
    it(`${w}x${h} 왕복이 바이트 단위로 일치한다`, () => {
      const rgba = makeImage(w, h, 3)
      const filtered = filterScanlines(rgba, w, h)
      expect(filtered.length).toBe(h * (w * 4 + 1))
      expectBytesEqual(unfilterScanlines(filtered, w, h), rgba)
    })
  }

  it('필터 타입은 항상 0..4 다', () => {
    const filtered = filterScanlines(makeImage(20, 12, 7), 20, 12)
    for (const t of filterTypesOf(filtered, 20, 12)) {
      expect(t).toBeGreaterThanOrEqual(0)
      expect(t).toBeLessThanOrEqual(4)
    }
  })

  it('모든 행이 같으면 두 번째 행부터 Up(2) 을 고른다', () => {
    const w = 24
    const h = 5
    const rgba = new Uint8Array(w * h * 4)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const at = (y * w + x) * 4
        // 가로 그라디언트라 Sub 는 0 이 되지 않는다. Up 만 전부 0 이 된다.
        rgba[at] = x * 9
        rgba[at + 1] = 255 - x * 5
        rgba[at + 2] = x * x
        rgba[at + 3] = 255
      }
    }
    const types = filterTypesOf(filterScanlines(rgba, w, h), w, h)
    expect(types.slice(1)).toEqual([2, 2, 2, 2])
    expectBytesEqual(unfilterScanlines(filterScanlines(rgba, w, h), w, h), rgba)
  })

  it('완전 투명 단색은 None(0) 이 된다 (모든 후보 합이 0 이라 최저 번호 선택)', () => {
    const rgba = new Uint8Array(4 * 4 * 4) // 전부 0
    expect(filterTypesOf(filterScanlines(rgba, 4, 4), 4, 4)).toEqual([0, 0, 0, 0])
  })

  it('버퍼가 짧으면 던진다', () => {
    expect(() => filterScanlines(new Uint8Array(10), 4, 4)).toThrow()
  })

  it('Paeth 왕복은 대각 패턴에서도 깨지지 않는다', () => {
    const w = 33
    const h = 17
    const rgba = new Uint8Array(w * h * 4)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const at = (y * w + x) * 4
        const v = (x * 3 + y * 5) & 0xff
        rgba[at] = v
        rgba[at + 1] = (v * 2) & 0xff
        rgba[at + 2] = 255 - v
        rgba[at + 3] = (x ^ y) & 0xff
      }
    }
    expectBytesEqual(unfilterScanlines(filterScanlines(rgba, w, h), w, h), rgba)
  })
})

// ---------------------------------------------------------------------------
// deflate
// ---------------------------------------------------------------------------

describe('deflate', () => {
  it('adler32 알려진 값', () => {
    expect(adler32(new Uint8Array(0))).toBe(1)
    expect(adler32(ascii('Wikipedia'))).toBe(0x11e60398)
  })

  it('zlibStored 헤더는 0x78 0x01 이고 끝 4바이트는 adler32(BE) 다', () => {
    const data = ascii('hello apng')
    const out = zlibStored(data)
    expect(out[0]).toBe(0x78)
    expect(out[1]).toBe(0x01)
    expect(readUint32BE(out, out.length - 4)).toBe(adler32(data))
    // 헤더(2) + 블록헤더(5) + 데이터 + adler(4)
    expect(out.length).toBe(2 + 5 + data.length + 4)
    // BFINAL=1, BTYPE=00
    expect(out[2]).toBe(0x01)
    // LEN / NLEN (LE, 1의 보수)
    const len = out[3]! | (out[4]! << 8)
    const nlen = out[5]! | (out[6]! << 8)
    expect(len).toBe(data.length)
    expect(len ^ nlen).toBe(0xffff)
  })

  it('zlibStored 는 빈 입력도 유효한 스트림을 만든다', () => {
    const out = zlibStored(new Uint8Array(0))
    expect(out.length).toBe(2 + 5 + 0 + 4)
    expect(readUint32BE(out, out.length - 4)).toBe(1)
  })

  it('zlibStored 는 65535 를 넘으면 블록을 쪼갠다', () => {
    const data = new Uint8Array(200000)
    for (let i = 0; i < data.length; i++) data[i] = (i * 31) & 0xff
    const out = zlibStored(data)
    // ceil(200000/65535) = 4 블록
    expect(out.length).toBe(2 + 4 * 5 + data.length + 4)
  })

  it.skipIf(!hasDecompression)('zlibStored 를 실제 inflate 로 되돌릴 수 있다', async () => {
    const data = new Uint8Array(150000)
    for (let i = 0; i < data.length; i++) data[i] = (i * 17 + 5) & 0xff
    expectBytesEqual(await inflateZlib(zlibStored(data)), data)
  })

  it.skipIf(!hasDecompression)('zlibDeflate 왕복', async () => {
    const data = filterScanlines(makeImage(64, 64, 1), 64, 64)
    const compressed = await zlibDeflate(data)
    expectBytesEqual(await inflateZlib(compressed), data)
  })

  it('Node 22+ 에는 CompressionStream 이 있다', () => {
    expect(hasNativeDeflate()).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// APNG 인코더
// ---------------------------------------------------------------------------

const W = 12
const H = 9
const FRAME_COUNT = 4

function makeFrames(count: number, delayNum: number, delayDen: number): ApngFrame[] {
  return Array.from({ length: count }, (_, i) => ({
    rgba: makeImage(W, H, i + 1),
    delayNum,
    delayDen,
  }))
}

/** 파일 순서대로 fcTL / fdAT 의 sequence_number 를 모은다. */
function sequenceNumbers(chunks: PngChunk[]): number[] {
  const out: number[] = []
  for (const chunk of chunks) {
    if (chunk.type === 'fcTL' || chunk.type === 'fdAT') {
      out.push(readUint32BE(chunk.data, 0))
    }
  }
  return out
}

describe('encodeApng 구조', () => {
  it('시그니처와 청크 순서가 사양대로다', async () => {
    const png = await encodeApng(makeFrames(FRAME_COUNT, 1, 24), {
      width: W,
      height: H,
      numPlays: 0,
    })

    expectBytesEqual(png.subarray(0, 8), PNG_SIGNATURE)

    const chunks = parseChunks(png)
    const types = chunks.map((c) => c.type)
    expect(types[0]).toBe('IHDR')
    expect(types[1]).toBe('acTL')
    expect(types[2]).toBe('fcTL')
    expect(types[3]).toBe('IDAT')
    expect(types.slice(4, -1)).toEqual(['fcTL', 'fdAT', 'fcTL', 'fdAT', 'fcTL', 'fdAT'])
    expect(types[types.length - 1]).toBe('IEND')
  })

  it('모든 청크의 CRC 가 유효하다', async () => {
    const png = await encodeApng(makeFrames(3, 1, 30), { width: W, height: H, numPlays: 2 })
    for (const chunk of parseChunks(png)) {
      expect(chunkCrcOk(png, chunk), `${chunk.type} CRC`).toBe(true)
    }
  })

  it('IHDR 은 8비트 RGBA 다', async () => {
    // 고유색이 256개 이하면 무손실 팔레트(color type 3)로 떨어진다.
    // 이 테스트는 RGBA 경로를 보는 것이므로 팔레트를 끈다.
    // 팔레트 경로의 IHDR 은 apngDiff.test.ts 가 검사한다.
    const png = await encodeApng(makeFrames(2, 1, 25), {
      width: W,
      height: H,
      numPlays: 1,
      palette: false,
    })
    const ihdr = chunkOfType(parseChunks(png), 'IHDR')
    expect(ihdr.length).toBe(13)
    expect(readUint32BE(ihdr.data, 0)).toBe(W)
    expect(readUint32BE(ihdr.data, 4)).toBe(H)
    expect(ihdr.data[8]).toBe(8) // bit depth
    expect(ihdr.data[9]).toBe(6) // color type RGBA
    expect(ihdr.data[10]).toBe(0) // compression
    expect(ihdr.data[11]).toBe(0) // filter
    expect(ihdr.data[12]).toBe(0) // interlace
  })

  it('IEND 로 끝나고 데이터가 비어 있다', async () => {
    const png = await encodeApng(makeFrames(2, 1, 25), { width: W, height: H, numPlays: 0 })
    const chunks = parseChunks(png)
    const last = chunks[chunks.length - 1]!
    expect(last.type).toBe('IEND')
    expect(last.length).toBe(0)
    expect(last.offset + 12).toBe(png.length)
  })

  it('fcTL 개수 = 프레임 수, fdAT 개수 = 프레임 수 - 1, IDAT 은 1개', async () => {
    for (const count of [1, 2, 4, 7]) {
      const png = await encodeApng(makeFrames(count, 1, 24), {
        width: W,
        height: H,
        numPlays: 0,
      })
      const chunks = parseChunks(png)
      expect(chunksOfType(chunks, 'fcTL')).toHaveLength(count)
      expect(chunksOfType(chunks, 'fdAT')).toHaveLength(count - 1)
      expect(chunksOfType(chunks, 'IDAT')).toHaveLength(1)
    }
  })

  it('sequence_number 가 fcTL/fdAT 를 통틀어 0부터 빠짐없이 증가한다', async () => {
    for (const count of [1, 2, 5]) {
      const png = await encodeApng(makeFrames(count, 1, 30), {
        width: W,
        height: H,
        numPlays: 0,
      })
      const seqs = sequenceNumbers(parseChunks(png))
      expect(seqs).toHaveLength(2 * count - 1)
      expect(seqs).toEqual(Array.from({ length: 2 * count - 1 }, (_, i) => i))
    }
  })

  it('fcTL 은 26바이트이고 전체 프레임 사각형에 dispose=0 blend=0 이다', async () => {
    const png = await encodeApng(makeFrames(3, 1, 24), { width: W, height: H, numPlays: 0 })
    for (const fctl of chunksOfType(parseChunks(png), 'fcTL')) {
      expect(fctl.length).toBe(26)
      expect(readUint32BE(fctl.data, 4)).toBe(W)
      expect(readUint32BE(fctl.data, 8)).toBe(H)
      expect(readUint32BE(fctl.data, 12)).toBe(0) // x_offset
      expect(readUint32BE(fctl.data, 16)).toBe(0) // y_offset
      expect(fctl.data[24]).toBe(0) // dispose_op = NONE
      expect(fctl.data[25]).toBe(0) // blend_op = SOURCE
    }
  })
})

describe('encodeApng 루프 카운트 왕복', () => {
  for (const numPlays of [0, 1, 3]) {
    it(`numPlays=${numPlays} 가 acTL 에 그대로 실린다`, async () => {
      const count = 3
      const png = await encodeApng(makeFrames(count, 1, 24), {
        width: W,
        height: H,
        numPlays,
      })
      const actl = chunkOfType(parseChunks(png), 'acTL')
      expect(actl.length).toBe(8)
      expect(readUint32BE(actl.data, 0)).toBe(count) // num_frames
      expect(readUint32BE(actl.data, 4)).toBe(numPlays) // num_plays
    })
  }

  it('numPlays 가 음수거나 정수가 아니면 던진다', async () => {
    await expect(
      encodeApng(makeFrames(1, 1, 24), { width: W, height: H, numPlays: -1 }),
    ).rejects.toThrow()
    await expect(
      encodeApng(makeFrames(1, 1, 24), { width: W, height: H, numPlays: 1.5 }),
    ).rejects.toThrow()
  })
})

describe('encodeApng 딜레이', () => {
  it('delay_num/delay_den 을 반올림 없이 그대로 기록한다 (24fps 무손실)', async () => {
    const png = await encodeApng(makeFrames(3, 1, 24), { width: W, height: H, numPlays: 0 })
    for (const fctl of chunksOfType(parseChunks(png), 'fcTL')) {
      expect(readUint16BE(fctl.data, 20)).toBe(1)
      expect(readUint16BE(fctl.data, 22)).toBe(24)
    }
  })

  it('30fps 도 1/30 그대로다', async () => {
    const png = await encodeApng(makeFrames(2, 1, 30), { width: W, height: H, numPlays: 0 })
    const fctls = chunksOfType(parseChunks(png), 'fcTL')
    expect(fctls.map((c) => readUint16BE(c.data, 20))).toEqual([1, 1])
    expect(fctls.map((c) => readUint16BE(c.data, 22))).toEqual([30, 30])
  })

  it('프레임마다 다른 딜레이를 줄 수 있다', async () => {
    const frames: ApngFrame[] = [
      { rgba: makeImage(W, H, 1), delayNum: 1, delayDen: 24 },
      { rgba: makeImage(W, H, 2), delayNum: 7, delayDen: 100 },
      { rgba: makeImage(W, H, 3), delayNum: 0, delayDen: 1000 },
    ]
    const png = await encodeApng(frames, { width: W, height: H, numPlays: 0 })
    const fctls = chunksOfType(parseChunks(png), 'fcTL')
    expect(fctls.map((c) => readUint16BE(c.data, 20))).toEqual([1, 7, 0])
    expect(fctls.map((c) => readUint16BE(c.data, 22))).toEqual([24, 100, 1000])
  })

  it('uint16 을 넘는 딜레이는 던진다', async () => {
    const frames: ApngFrame[] = [{ rgba: makeImage(W, H, 1), delayNum: 1, delayDen: 70000 }]
    await expect(encodeApng(frames, { width: W, height: H, numPlays: 0 })).rejects.toThrow()
  })
})

describe('encodeApng 픽셀 왕복', () => {
  it.skipIf(!hasDecompression)('IDAT / fdAT 를 풀면 원본 RGBA 가 나온다', async () => {
    const frames = makeFrames(3, 1, 24)
    const png = await encodeApng(frames, { width: W, height: H, numPlays: 0 })
    const chunks = parseChunks(png)

    const idat = chunkOfType(chunks, 'IDAT')
    const first = unfilterScanlines(await inflateZlib(idat.data), W, H)
    expectBytesEqual(first, frames[0]!.rgba)

    const fdats = chunksOfType(chunks, 'fdAT')
    for (let i = 0; i < fdats.length; i++) {
      // fdAT 는 앞 4바이트가 sequence_number 다. 그 뒤가 zlib 스트림이다.
      const payload = fdats[i]!.data.subarray(4)
      const rgba = unfilterScanlines(await inflateZlib(payload), W, H)
      expectBytesEqual(rgba, frames[i + 1]!.rgba)
    }
  })

  it.skipIf(!hasDecompression)('알파는 straight 그대로 보존된다', async () => {
    const rgba = new Uint8Array(2 * 1 * 4)
    // 흰색 픽셀에 알파 0. 프리멀티플라이였다면 RGB 가 0 으로 눌린다.
    rgba.set([255, 255, 255, 0, 10, 20, 30, 128], 0)
    // 색이 2개뿐이라 기본값이면 팔레트로 떨어진다. 여기서는 RGBA 경로를 본다.
    // 팔레트 경로에서 (255,255,255,0) 이 PLTE+tRNS 로 보존되는지는 apngDiff.test.ts 가 본다.
    const png = await encodeApng([{ rgba, delayNum: 1, delayDen: 24 }], {
      width: 2,
      height: 1,
      numPlays: 0,
      palette: false,
    })
    const idat = chunkOfType(parseChunks(png), 'IDAT')
    expectBytesEqual(unfilterScanlines(await inflateZlib(idat.data), 2, 1), rgba)
  })

  it('같은 입력은 같은 바이트를 낸다 (결정론)', async () => {
    const opts = { width: W, height: H, numPlays: 3 }
    const a = await encodeApng(makeFrames(3, 1, 24), opts)
    const b = await encodeApng(makeFrames(3, 1, 24), opts)
    expectBytesEqual(a, b)
  })
})

describe('encodeApng 진행률과 취소', () => {
  it('프레임마다 onProgress 를 부른다', async () => {
    const calls: Array<[number, number]> = []
    await encodeApng(makeFrames(4, 1, 24), {
      width: W,
      height: H,
      numPlays: 0,
      onProgress: (done, total) => calls.push([done, total]),
    })
    expect(calls).toEqual([
      [1, 4],
      [2, 4],
      [3, 4],
      [4, 4],
    ])
  })

  it('이미 중단된 signal 이면 AbortError 로 거부한다', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      encodeApng(makeFrames(3, 1, 24), {
        width: W,
        height: H,
        numPlays: 0,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('중간에 중단하면 남은 프레임을 인코딩하지 않는다', async () => {
    const controller = new AbortController()
    let done = 0
    await expect(
      encodeApng(makeFrames(6, 1, 24), {
        width: W,
        height: H,
        numPlays: 0,
        signal: controller.signal,
        onProgress: (n) => {
          done = n
          if (n === 2) controller.abort()
        },
      }),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(done).toBe(2)
  })
})

describe('encodeApng 입력 검증', () => {
  it('프레임이 없으면 던진다', async () => {
    await expect(encodeApng([], { width: W, height: H, numPlays: 0 })).rejects.toThrow()
  })

  it('RGBA 길이가 캔버스와 다르면 던진다', async () => {
    const frames: ApngFrame[] = [{ rgba: new Uint8Array(10), delayNum: 1, delayDen: 24 }]
    await expect(encodeApng(frames, { width: W, height: H, numPlays: 0 })).rejects.toThrow()
  })

  it('크기가 0 이하면 던진다', async () => {
    await expect(
      encodeApng(makeFrames(1, 1, 24), { width: 0, height: H, numPlays: 0 }),
    ).rejects.toThrow()
  })
})
