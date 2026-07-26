/**
 * APNG 크기 최적화 검증.
 *
 * 프레임 차분 사각형 + dispose/blend 선택 + 무손실 팔레트화.
 *
 * 이 파일의 핵심은 마지막 "무손실 왕복" 블록이다. 차분을 켠 결과를 **직접 디코드해서**
 * 원본 프레임과 픽셀 단위로 맞춰 본다. 언필터, inflate, 팔레트 확장, 사각형 합성까지
 * 인코더를 참조하지 않고 PNG/APNG 사양대로 다시 구현했다. 인코더의 헬퍼를 빌려 쓰면
 * 같은 실수를 두 번 해도 테스트가 통과해 버린다.
 *
 * 합성은 APNG 사양의 정수 합성식을 그대로 쓰는 "엄격한" 해석과, 흔한 구현인
 * "fg.alpha 가 0 이면 배경을 그대로 둔다" 해석 **양쪽으로 모두** 돌린다. 알파 0 픽셀의
 * RGB 를 다루는 방식이 디코더마다 갈리기 때문이다. 두 해석에서 같은 그림이 나와야
 * 어느 뷰어에서도 같게 보인다.
 */

import { describe, expect, it } from 'vitest'

import { parseChunks, readUint16BE, readUint32BE, type PngChunk } from '@/export/apng/chunks.ts'
import {
  changedRect,
  cropFrame,
  cropFrameOverDelta,
  pickBlendOp,
  type FrameRect,
} from '@/export/apng/diff.ts'
import {
  buildGlobalPalette,
  mapToIndices,
  packRgba,
  quantize,
  MAX_PALETTE_COLORS,
} from '@/export/apng/quantize.ts'
import { encodeApng, type ApngFrame } from '@/export/apng/encoder.ts'

const hasDecompression = typeof DecompressionStream !== 'undefined'

// ---------------------------------------------------------------------------
// 이미지 유틸
// ---------------------------------------------------------------------------

function blank(width: number, height: number): Uint8Array {
  return new Uint8Array(width * height * 4)
}

function setPixel(
  rgba: Uint8Array,
  width: number,
  x: number,
  y: number,
  color: [number, number, number, number],
): void {
  const at = (y * width + x) * 4
  rgba[at] = color[0]
  rgba[at + 1] = color[1]
  rgba[at + 2] = color[2]
  rgba[at + 3] = color[3]
}

function getPixel(rgba: Uint8Array, width: number, x: number, y: number): number[] {
  const at = (y * width + x) * 4
  return [rgba[at]!, rgba[at + 1]!, rgba[at + 2]!, rgba[at + 3]!]
}

function fillRect(
  rgba: Uint8Array,
  width: number,
  rect: FrameRect,
  color: [number, number, number, number],
): void {
  for (let y = rect.y; y < rect.y + rect.h; y++) {
    for (let x = rect.x; x < rect.x + rect.w; x++) setPixel(rgba, width, x, y, color)
  }
}

function expectBytesEqual(actual: Uint8Array, expected: Uint8Array, label = ''): void {
  expect(actual.length, `${label} 길이`).toBe(expected.length)
  for (let i = 0; i < expected.length; i++) {
    if (actual[i] !== expected[i]) {
      throw new Error(`${label} 바이트 ${i} 불일치: ${actual[i]} != ${expected[i]}`)
    }
  }
}

// ---------------------------------------------------------------------------
// 독립 APNG 디코더 (사양대로 다시 구현. 인코더 헬퍼를 쓰지 않는다)
// ---------------------------------------------------------------------------

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

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  if (pb <= pc) return b
  return c
}

/** PNG 사양 6.3 언필터. bpp 를 인자로 받아 인덱스(1)와 RGBA(4) 를 모두 다룬다. */
function unfilter(filtered: Uint8Array, width: number, height: number, bpp: number): Uint8Array {
  const rowBytes = width * bpp
  expect(filtered.length, '언필터 입력 길이').toBe(height * (rowBytes + 1))

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

interface RawFrame {
  rect: FrameRect
  delayNum: number
  delayDen: number
  disposeOp: number
  blendOp: number
  /** 사각형 크기의 RGBA (팔레트면 이미 확장된 것) */
  rgba: Uint8Array
}

interface DecodedApng {
  width: number
  height: number
  bitDepth: number
  colorType: number
  numFrames: number
  numPlays: number
  paletteSize: number
  trnsLength: number
  raw: RawFrame[]
}

function chunksOf(chunks: PngChunk[], type: string): PngChunk[] {
  return chunks.filter((c) => c.type === type)
}

function joinChunks(parts: Uint8Array[]): Uint8Array {
  let total = 0
  for (const p of parts) total += p.length
  const out = new Uint8Array(total)
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

async function decodeApng(png: Uint8Array): Promise<DecodedApng> {
  const chunks = parseChunks(png)

  const ihdr = chunks[0]!
  expect(ihdr.type).toBe('IHDR')
  const width = readUint32BE(ihdr.data, 0)
  const height = readUint32BE(ihdr.data, 4)
  const bitDepth = ihdr.data[8]!
  const colorType = ihdr.data[9]!

  const actlChunks = chunksOf(chunks, 'acTL')
  expect(actlChunks).toHaveLength(1)
  const numFrames = readUint32BE(actlChunks[0]!.data, 0)
  const numPlays = readUint32BE(actlChunks[0]!.data, 4)

  const plteChunks = chunksOf(chunks, 'PLTE')
  const trnsChunks = chunksOf(chunks, 'tRNS')
  let palette: Uint8Array | null = null
  let trns: Uint8Array | null = null
  if (colorType === 3) {
    expect(plteChunks, 'color type 3 인데 PLTE 가 없다').toHaveLength(1)
    palette = plteChunks[0]!.data
    expect(palette.length % 3, 'PLTE 는 3의 배수여야 한다').toBe(0)
    expect(palette.length / 3).toBeLessThanOrEqual(MAX_PALETTE_COLORS)
    if (trnsChunks.length > 0) {
      trns = trnsChunks[0]!.data
      expect(trns.length).toBeLessThanOrEqual(palette.length / 3)
    }
    // PLTE / tRNS 는 첫 IDAT 앞에 있어야 한다.
    const idatAt = chunks.findIndex((c) => c.type === 'IDAT')
    expect(chunks.indexOf(plteChunks[0]!)).toBeLessThan(idatAt)
    if (trns) expect(chunks.indexOf(trnsChunks[0]!)).toBeLessThan(idatAt)
  } else {
    expect(plteChunks, 'RGBA 인데 PLTE 가 있다').toHaveLength(0)
    expect(trnsChunks, 'RGBA 인데 tRNS 가 있다').toHaveLength(0)
  }

  // fcTL 하나 + 뒤따르는 IDAT/fdAT 들이 프레임 하나다.
  interface Pending {
    rect: FrameRect
    delayNum: number
    delayDen: number
    disposeOp: number
    blendOp: number
    parts: Uint8Array[]
  }
  const pendings: Pending[] = []
  let current: Pending | null = null
  for (const chunk of chunks) {
    if (chunk.type === 'fcTL') {
      expect(chunk.length, 'fcTL 은 26바이트').toBe(26)
      current = {
        rect: {
          w: readUint32BE(chunk.data, 4),
          h: readUint32BE(chunk.data, 8),
          x: readUint32BE(chunk.data, 12),
          y: readUint32BE(chunk.data, 16),
        },
        delayNum: readUint16BE(chunk.data, 20),
        delayDen: readUint16BE(chunk.data, 22),
        disposeOp: chunk.data[24]!,
        blendOp: chunk.data[25]!,
        parts: [],
      }
      pendings.push(current)
      continue
    }
    if (chunk.type === 'IDAT') {
      expect(current, 'IDAT 앞에 fcTL 이 있어야 한다').not.toBeNull()
      current!.parts.push(chunk.data)
      continue
    }
    if (chunk.type === 'fdAT') {
      expect(current, 'fdAT 앞에 fcTL 이 있어야 한다').not.toBeNull()
      current!.parts.push(chunk.data.subarray(4))
    }
  }

  const raw: RawFrame[] = []
  for (const p of pendings) {
    const bpp = colorType === 3 ? 1 : 4
    const pixels = unfilter(await inflateZlib(joinChunks(p.parts)), p.rect.w, p.rect.h, bpp)

    let rgba: Uint8Array
    if (colorType === 3 && palette) {
      rgba = new Uint8Array(p.rect.w * p.rect.h * 4)
      for (let i = 0; i < pixels.length; i++) {
        const idx = pixels[i]!
        expect(idx, '팔레트 범위를 넘는 인덱스').toBeLessThan(palette.length / 3)
        rgba[i * 4] = palette[idx * 3]!
        rgba[i * 4 + 1] = palette[idx * 3 + 1]!
        rgba[i * 4 + 2] = palette[idx * 3 + 2]!
        rgba[i * 4 + 3] = trns && idx < trns.length ? trns[idx]! : 255
      }
    } else {
      rgba = pixels
    }

    raw.push({
      rect: p.rect,
      delayNum: p.delayNum,
      delayDen: p.delayDen,
      disposeOp: p.disposeOp,
      blendOp: p.blendOp,
      rgba,
    })
  }

  return {
    width,
    height,
    bitDepth,
    colorType,
    numFrames,
    numPlays,
    paletteSize: palette ? palette.length / 3 : 0,
    trnsLength: trns ? trns.length : 0,
    raw,
  }
}

/**
 * 출력 버퍼 합성. APNG 사양의 렌더링 규칙을 그대로 따른다.
 *
 * strict=true  : 사양의 정수 합성식을 그대로 쓴다. 분모가 0 이면 (0,0,0,0).
 * strict=false : "fg.alpha 가 0 이면 배경을 그대로 둔다" 는 흔한 구현.
 */
function composite(decoded: DecodedApng, strict: boolean): Uint8Array[] {
  const { width, height } = decoded
  const buffer = new Uint8Array(width * height * 4)
  const out: Uint8Array[] = []

  for (const frame of decoded.raw) {
    const before = frame.disposeOp === 2 ? buffer.slice() : null

    const rowBytes = width * 4
    for (let y = 0; y < frame.rect.h; y++) {
      let d = (frame.rect.y + y) * rowBytes + frame.rect.x * 4
      let s = y * frame.rect.w * 4
      for (let x = 0; x < frame.rect.w; x++, d += 4, s += 4) {
        const sr = frame.rgba[s]!
        const sg = frame.rgba[s + 1]!
        const sb = frame.rgba[s + 2]!
        const sa = frame.rgba[s + 3]!

        if (frame.blendOp === 0) {
          buffer[d] = sr
          buffer[d + 1] = sg
          buffer[d + 2] = sb
          buffer[d + 3] = sa
          continue
        }

        if (!strict && sa === 0) continue

        const da = buffer[d + 3]!
        const u = sa * 255
        const v = (255 - sa) * da
        const al = u + v
        if (al === 0) {
          buffer[d] = 0
          buffer[d + 1] = 0
          buffer[d + 2] = 0
          buffer[d + 3] = 0
          continue
        }
        buffer[d] = Math.round((sr * u + buffer[d]! * v) / al)
        buffer[d + 1] = Math.round((sg * u + buffer[d + 1]! * v) / al)
        buffer[d + 2] = Math.round((sb * u + buffer[d + 2]! * v) / al)
        buffer[d + 3] = Math.round(al / 255)
      }
    }

    out.push(buffer.slice())

    if (frame.disposeOp === 1) {
      for (let y = 0; y < frame.rect.h; y++) {
        const d = (frame.rect.y + y) * rowBytes + frame.rect.x * 4
        buffer.fill(0, d, d + frame.rect.w * 4)
      }
    } else if (frame.disposeOp === 2 && before) {
      buffer.set(before)
    }
  }

  return out
}

// ---------------------------------------------------------------------------
// changedRect
// ---------------------------------------------------------------------------

describe('changedRect', () => {
  const W = 8
  const H = 6

  it('완전히 같으면 null', () => {
    const a = blank(W, H)
    fillRect(a, W, { x: 1, y: 1, w: 4, h: 3 }, [10, 20, 30, 255])
    const b = a.slice()
    expect(changedRect(a, b, W, H)).toBeNull()
  })

  it('한 픽셀만 다르면 1x1 사각형', () => {
    const a = blank(W, H)
    const b = a.slice()
    setPixel(b, W, 3, 2, [1, 2, 3, 4])
    expect(changedRect(a, b, W, H)).toEqual({ x: 3, y: 2, w: 1, h: 1 })
  })

  it('알파 한 바이트만 달라도 잡는다', () => {
    const a = blank(W, H)
    fillRect(a, W, { x: 0, y: 0, w: W, h: H }, [9, 9, 9, 255])
    const b = a.slice()
    b[(2 * W + 5) * 4 + 3] = 254
    expect(changedRect(a, b, W, H)).toEqual({ x: 5, y: 2, w: 1, h: 1 })
  })

  it('전부 다르면 전체 사각형', () => {
    const a = blank(W, H)
    const b = new Uint8Array(W * H * 4).fill(7)
    expect(changedRect(a, b, W, H)).toEqual({ x: 0, y: 0, w: W, h: H })
  })

  it('네 모서리만 달라도 전체 사각형이 된다', () => {
    const a = blank(W, H)
    const b = a.slice()
    setPixel(b, W, 0, 0, [1, 1, 1, 1])
    setPixel(b, W, W - 1, 0, [1, 1, 1, 1])
    setPixel(b, W, 0, H - 1, [1, 1, 1, 1])
    setPixel(b, W, W - 1, H - 1, [1, 1, 1, 1])
    expect(changedRect(a, b, W, H)).toEqual({ x: 0, y: 0, w: W, h: H })
  })

  it('오른쪽 아래 모서리 한 픽셀', () => {
    const a = blank(W, H)
    const b = a.slice()
    setPixel(b, W, W - 1, H - 1, [5, 5, 5, 5])
    expect(changedRect(a, b, W, H)).toEqual({ x: W - 1, y: H - 1, w: 1, h: 1 })
  })

  it('흩어진 두 점을 감싸는 최소 사각형', () => {
    const a = blank(W, H)
    const b = a.slice()
    setPixel(b, W, 2, 1, [1, 0, 0, 255])
    setPixel(b, W, 5, 4, [0, 1, 0, 255])
    expect(changedRect(a, b, W, H)).toEqual({ x: 2, y: 1, w: 4, h: 4 })
  })

  it('1x1 프레임도 다룬다', () => {
    const a = new Uint8Array([0, 0, 0, 0])
    const b = new Uint8Array([1, 0, 0, 0])
    expect(changedRect(a, a.slice(), 1, 1)).toBeNull()
    expect(changedRect(a, b, 1, 1)).toEqual({ x: 0, y: 0, w: 1, h: 1 })
  })

  it('버퍼 길이가 맞지 않으면 던진다', () => {
    expect(() => changedRect(blank(W, H), new Uint8Array(4), W, H)).toThrow()
    expect(() => changedRect(blank(W, H), blank(W, H), 0, H)).toThrow()
  })
})

// ---------------------------------------------------------------------------
// cropFrame
// ---------------------------------------------------------------------------

describe('cropFrame', () => {
  const W = 9
  const H = 7

  function gradient(): Uint8Array {
    const rgba = new Uint8Array(W * H * 4)
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        setPixel(rgba, W, x, y, [x * 11, y * 13, (x * y) & 0xff, (x + y) & 0xff])
      }
    }
    return rgba
  }

  it('잘라낸 사각형이 원본의 같은 위치와 픽셀 단위로 같다', () => {
    const src = gradient()
    const rect: FrameRect = { x: 2, y: 3, w: 5, h: 4 }
    const cropped = cropFrame(src, W, rect)
    expect(cropped.length).toBe(rect.w * rect.h * 4)
    for (let y = 0; y < rect.h; y++) {
      for (let x = 0; x < rect.w; x++) {
        expect(getPixel(cropped, rect.w, x, y)).toEqual(getPixel(src, W, rect.x + x, rect.y + y))
      }
    }
  })

  it('전체 사각형을 자르면 원본 그대로다', () => {
    const src = gradient()
    expectBytesEqual(cropFrame(src, W, { x: 0, y: 0, w: W, h: H }), src)
  })

  it('왕복: 잘라 붙이면 원본이 복원된다', () => {
    const src = gradient()
    const rect: FrameRect = { x: 1, y: 2, w: 4, h: 3 }
    const cropped = cropFrame(src, W, rect)
    const restored = src.slice()
    // 사각형을 지운 뒤 다시 붙인다.
    fillRect(restored, W, rect, [0, 0, 0, 0])
    for (let y = 0; y < rect.h; y++) {
      for (let x = 0; x < rect.w; x++) {
        const p = getPixel(cropped, rect.w, x, y)
        setPixel(restored, W, rect.x + x, rect.y + y, [p[0]!, p[1]!, p[2]!, p[3]!])
      }
    }
    expectBytesEqual(restored, src)
  })

  it('사각형이 프레임을 벗어나면 던진다', () => {
    const src = gradient()
    expect(() => cropFrame(src, W, { x: 8, y: 0, w: 2, h: 1 })).toThrow()
    expect(() => cropFrame(src, W, { x: 0, y: 6, w: 1, h: 2 })).toThrow()
    expect(() => cropFrame(src, W, { x: -1, y: 0, w: 1, h: 1 })).toThrow()
    expect(() => cropFrame(src, W, { x: 0, y: 0, w: 0, h: 1 })).toThrow()
  })
})

// ---------------------------------------------------------------------------
// pickBlendOp
// ---------------------------------------------------------------------------

describe('pickBlendOp', () => {
  const W = 4
  const H = 4
  const FULL: FrameRect = { x: 0, y: 0, w: W, h: H }

  function pair(
    prevColor: [number, number, number, number],
    curColor: [number, number, number, number],
  ): [Uint8Array, Uint8Array] {
    const prev = blank(W, H)
    const cur = blank(W, H)
    fillRect(prev, W, FULL, prevColor)
    fillRect(cur, W, FULL, curColor)
    return [prev, cur]
  }

  it('알파가 줄어들면 SOURCE 를 고른다', () => {
    const [prev, cur] = pair([200, 100, 50, 255], [200, 100, 50, 128])
    expect(pickBlendOp(prev, cur, FULL, W)).toBe(0)
  })

  it('반투명이 더 옅어지는 경우도 SOURCE', () => {
    const [prev, cur] = pair([10, 20, 30, 200], [10, 20, 30, 40])
    expect(pickBlendOp(prev, cur, FULL, W)).toBe(0)
  })

  it('알파가 늘어나도 합성값이 어긋나므로 SOURCE', () => {
    // OVER 는 100 -> 200 을 200 이 아니라 100 + 200*(1-100/255) 로 만든다.
    const [prev, cur] = pair([10, 20, 30, 100], [10, 20, 30, 200])
    expect(pickBlendOp(prev, cur, FULL, W)).toBe(0)
  })

  it('반투명이 그대로여도 누적되므로 SOURCE', () => {
    const [prev, cur] = pair([10, 20, 30, 128], [10, 20, 30, 128])
    expect(pickBlendOp(prev, cur, FULL, W)).toBe(0)
  })

  it('현재 프레임이 완전 불투명이면 OVER', () => {
    const [prev, cur] = pair([1, 2, 3, 60], [200, 100, 50, 255])
    expect(pickBlendOp(prev, cur, FULL, W)).toBe(1)
  })

  it('이전 프레임이 완전 투명이고 현재가 반투명이면 OVER', () => {
    const [prev, cur] = pair([0, 0, 0, 0], [200, 100, 50, 128])
    expect(pickBlendOp(prev, cur, FULL, W)).toBe(1)
  })

  it('양쪽 다 완전 투명 검정이면 OVER', () => {
    const [prev, cur] = pair([0, 0, 0, 0], [0, 0, 0, 0])
    expect(pickBlendOp(prev, cur, FULL, W)).toBe(1)
  })

  it('알파 0 인데 RGB 가 남아 있으면 해석이 갈리므로 SOURCE', () => {
    const [prev, cur] = pair([255, 255, 255, 0], [0, 0, 0, 0])
    expect(pickBlendOp(prev, cur, FULL, W)).toBe(0)
  })

  it('사각형 안의 한 픽셀만 어긋나도 SOURCE 로 떨어진다', () => {
    const prev = blank(W, H)
    const cur = blank(W, H)
    fillRect(cur, W, FULL, [9, 9, 9, 255])
    expect(pickBlendOp(prev, cur, FULL, W)).toBe(1)
    // 딱 한 픽셀만 반투명으로 만들고 배경도 반투명으로 둔다.
    setPixel(prev, W, 2, 2, [1, 1, 1, 90])
    setPixel(cur, W, 2, 2, [1, 1, 1, 60])
    expect(pickBlendOp(prev, cur, FULL, W)).toBe(0)
    // 그 픽셀을 사각형 밖으로 빼면 다시 OVER 다.
    expect(pickBlendOp(prev, cur, { x: 0, y: 0, w: 2, h: 2 }, W)).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// cropFrameOverDelta
// ---------------------------------------------------------------------------

describe('cropFrameOverDelta', () => {
  const W = 6
  const H = 4

  it('안 바뀐 픽셀을 완전 투명으로 누르고 바뀐 픽셀은 그대로 둔다', () => {
    const prev = blank(W, H)
    fillRect(prev, W, { x: 0, y: 0, w: W, h: H }, [10, 20, 30, 255])
    const cur = prev.slice()
    setPixel(cur, W, 2, 1, [200, 0, 0, 255])

    const rect: FrameRect = { x: 1, y: 1, w: 3, h: 2 }
    const delta = cropFrameOverDelta(prev, cur, W, rect)
    expect(getPixel(delta, rect.w, 1, 0)).toEqual([200, 0, 0, 255])
    expect(getPixel(delta, rect.w, 0, 0)).toEqual([0, 0, 0, 0])
    expect(getPixel(delta, rect.w, 2, 1)).toEqual([0, 0, 0, 0])
  })

  it('전부 바뀌면 cropFrame 과 같다', () => {
    const prev = blank(W, H)
    const cur = new Uint8Array(W * H * 4).fill(88)
    const rect: FrameRect = { x: 0, y: 0, w: W, h: H }
    expectBytesEqual(cropFrameOverDelta(prev, cur, W, rect), cropFrame(cur, W, rect))
  })
})

// ---------------------------------------------------------------------------
// quantize
// ---------------------------------------------------------------------------

describe('quantize', () => {
  it('색이 2개인 이미지는 팔레트로 떨어진다', () => {
    const rgba = blank(4, 2)
    fillRect(rgba, 4, { x: 0, y: 0, w: 4, h: 1 }, [255, 0, 0, 255])
    fillRect(rgba, 4, { x: 0, y: 1, w: 4, h: 1 }, [0, 0, 255, 255])

    const result = quantize(rgba)
    expect(result).not.toBeNull()
    expect(result!.palette.length / 3).toBe(2)
    expect(result!.indices.length).toBe(8)
    // 두 행이 서로 다른 인덱스를 쓴다.
    expect(result!.indices[0]).not.toBe(result!.indices[4])
    // 전부 불투명이라 tRNS 는 없다.
    expect(result!.trns).toBeNull()
  })

  it('256색은 되고 257색은 null 이다', () => {
    function image(colors: number): Uint8Array {
      const rgba = new Uint8Array(colors * 4)
      for (let i = 0; i < colors; i++) {
        rgba[i * 4] = i & 0xff
        rgba[i * 4 + 1] = (i >> 8) & 0xff
        rgba[i * 4 + 2] = 0
        rgba[i * 4 + 3] = 255
      }
      return rgba
    }
    const ok = quantize(image(256))
    expect(ok).not.toBeNull()
    expect(ok!.palette.length / 3).toBe(256)
    expect(quantize(image(257))).toBeNull()
  })

  it('tRNS 는 알파가 있는 색만큼만 실린다', () => {
    // 색 3개: 완전 투명, 반투명 초록, 불투명 빨강.
    const rgba = new Uint8Array([0, 0, 0, 0, 0, 255, 0, 128, 255, 0, 0, 255])
    const result = quantize(rgba)
    expect(result).not.toBeNull()
    expect(result!.palette.length / 3).toBe(3)
    // 알파 오름차순으로 정렬돼 tRNS 가 앞 2개만 덮는다.
    expect(Array.from(result!.trns!)).toEqual([0, 128])
    expect(Array.from(result!.palette)).toEqual([0, 0, 0, 0, 255, 0, 255, 0, 0])
    // 인덱스가 원래 색을 정확히 가리킨다.
    expect(Array.from(result!.indices)).toEqual([0, 1, 2])
  })

  it('알파 0 이지만 RGB 가 남은 색도 색 값을 잃지 않는다', () => {
    const rgba = new Uint8Array([255, 255, 255, 0, 10, 20, 30, 128])
    const result = quantize(rgba)!
    expect(result.palette.length / 3).toBe(2)
    // (255,255,255,0) 이 알파 0 이라 앞으로 온다.
    expect(Array.from(result.palette.subarray(0, 3))).toEqual([255, 255, 255])
    expect(Array.from(result.trns!)).toEqual([0, 128])
  })

  it('전부 불투명이면 tRNS 를 생략한다', () => {
    const rgba = new Uint8Array([1, 2, 3, 255, 4, 5, 6, 255])
    expect(quantize(rgba)!.trns).toBeNull()
  })

  it('buildGlobalPalette 는 프레임을 합쳐서 센다', () => {
    const a = new Uint8Array([1, 0, 0, 255, 2, 0, 0, 255])
    const b = new Uint8Array([3, 0, 0, 255, 4, 0, 0, 255])
    const pal = buildGlobalPalette([a, b])!
    expect(pal.size).toBe(4)
    expect(pal.transparentIndex).toBe(-1)
    expect(Array.from(mapToIndices(a, pal.lookup))).toEqual([0, 1])
    expect(Array.from(mapToIndices(b, pal.lookup))).toEqual([2, 3])
  })

  it('프레임을 합쳐 257색이 되면 null 이다', () => {
    const a = new Uint8Array(200 * 4)
    const b = new Uint8Array(57 * 4)
    for (let i = 0; i < 200; i++) {
      a[i * 4] = i
      a[i * 4 + 3] = 255
    }
    for (let i = 0; i < 57; i++) {
      b[i * 4] = i
      b[i * 4 + 1] = 1
      b[i * 4 + 3] = 255
    }
    // 200 + 57 = 257
    expect(buildGlobalPalette([a, b])).toBeNull()
    // 하나씩 보면 각각 256 이하라 통과한다. 전역 팔레트라 합쳐서 판정해야 한다.
    expect(buildGlobalPalette([a])).not.toBeNull()
    expect(buildGlobalPalette([b])).not.toBeNull()
  })

  it('완전 투명 검정이 있으면 transparentIndex 를 알려준다', () => {
    const rgba = new Uint8Array([0, 0, 0, 0, 9, 9, 9, 255])
    const pal = buildGlobalPalette([rgba])!
    expect(pal.transparentIndex).toBe(0)
    expect(pal.lookup.get(packRgba(0, 0, 0, 0))).toBe(0)
  })

  it('팔레트에 없는 색을 매핑하면 던진다', () => {
    const pal = buildGlobalPalette([new Uint8Array([1, 2, 3, 255])])!
    expect(() => mapToIndices(new Uint8Array([9, 9, 9, 255]), pal.lookup)).toThrow()
  })
})

// ---------------------------------------------------------------------------
// 인코더 구조: 차분 사각형 / 팔레트
// ---------------------------------------------------------------------------

const DELAY = { num: 1, den: 24 }

function toFrames(images: Uint8Array[]): ApngFrame[] {
  return images.map((rgba) => ({ rgba, delayNum: DELAY.num, delayDen: DELAY.den }))
}

/** 투명 배경 위를 움직이는 반투명 사각형. 스티커(14.A1) 를 흉내낸다. */
function movingSticker(width: number, height: number, count: number): Uint8Array[] {
  const out: Uint8Array[] = []
  for (let i = 0; i < count; i++) {
    const rgba = blank(width, height)
    const x = 1 + i
    fillRect(rgba, width, { x, y: 2, w: 4, h: 4 }, [200, 60, 30, 255])
    // 가장자리 반투명 (안티앨리어싱 흉내). 알파가 프레임마다 늘었다 줄었다 한다.
    fillRect(rgba, width, { x, y: 1, w: 4, h: 1 }, [200, 60, 30, 90])
    fillRect(rgba, width, { x, y: 6, w: 4, h: 1 }, [200, 60, 30, 160])
    out.push(rgba)
  }
  return out
}

describe('encodeApng 차분 사각형', () => {
  const W = 16
  const H = 12

  it('첫 프레임은 언제나 전체 크기다', async () => {
    const images = movingSticker(W, H, 3)
    const png = await encodeApng(toFrames(images), { width: W, height: H, numPlays: 0 })
    const decoded = await decodeApng(png)
    expect(decoded.raw[0]!.rect).toEqual({ x: 0, y: 0, w: W, h: H })
    expect(decoded.raw[0]!.blendOp).toBe(0)
    expect(decoded.raw[0]!.disposeOp).toBe(0)
  })

  it('국소 변경은 작은 사각형으로 줄어든다', async () => {
    const a = blank(W, H)
    fillRect(a, W, { x: 0, y: 0, w: W, h: H }, [30, 40, 50, 255])
    const b = a.slice()
    fillRect(b, W, { x: 5, y: 4, w: 3, h: 2 }, [200, 10, 10, 255])

    const png = await encodeApng(toFrames([a, b]), { width: W, height: H, numPlays: 0 })
    const decoded = await decodeApng(png)
    expect(decoded.raw[1]!.rect).toEqual({ x: 5, y: 4, w: 3, h: 2 })
  })

  it('변경이 없는 프레임은 1x1 더미 사각형이고 delay 는 유지된다', async () => {
    const a = blank(W, H)
    fillRect(a, W, { x: 2, y: 2, w: 6, h: 6 }, [1, 2, 3, 255])
    const frames: ApngFrame[] = [
      { rgba: a, delayNum: 1, delayDen: 24 },
      { rgba: a.slice(), delayNum: 5, delayDen: 100 },
      { rgba: a.slice(), delayNum: 7, delayDen: 100 },
    ]
    const png = await encodeApng(frames, { width: W, height: H, numPlays: 0 })
    const decoded = await decodeApng(png)

    expect(decoded.raw[1]!.rect).toEqual({ x: 0, y: 0, w: 1, h: 1 })
    expect(decoded.raw[2]!.rect).toEqual({ x: 0, y: 0, w: 1, h: 1 })
    expect(decoded.raw.map((f) => f.delayNum)).toEqual([1, 5, 7])
    expect(decoded.raw.map((f) => f.delayDen)).toEqual([24, 100, 100])
  })

  it('diff:false 면 모든 프레임이 전체 크기다', async () => {
    const images = movingSticker(W, H, 4)
    const png = await encodeApng(toFrames(images), {
      width: W,
      height: H,
      numPlays: 0,
      diff: false,
    })
    const decoded = await decodeApng(png)
    for (const frame of decoded.raw) {
      expect(frame.rect).toEqual({ x: 0, y: 0, w: W, h: H })
      expect(frame.blendOp).toBe(0)
    }
  })

  it('사각형을 잘라도 sequence_number 는 0부터 빠짐없이 증가한다', async () => {
    const a = blank(W, H)
    fillRect(a, W, { x: 3, y: 3, w: 4, h: 4 }, [7, 7, 7, 255])
    const images = [a, a.slice(), a.slice(), a.slice(), a.slice()]
    // 가운데 한 프레임만 살짝 바꿔서 더미와 실제 사각형을 섞는다.
    setPixel(images[2]!, W, 10, 10, [9, 9, 9, 255])

    const png = await encodeApng(toFrames(images), { width: W, height: H, numPlays: 0 })
    const seqs: number[] = []
    for (const chunk of parseChunks(png)) {
      if (chunk.type === 'fcTL' || chunk.type === 'fdAT') seqs.push(readUint32BE(chunk.data, 0))
    }
    expect(seqs).toEqual(Array.from({ length: 2 * images.length - 1 }, (_, i) => i))
  })

  it('반투명 가장자리가 움직이면 SOURCE 로 떨어진다', async () => {
    const images = movingSticker(W, H, 3)
    const png = await encodeApng(toFrames(images), { width: W, height: H, numPlays: 0 })
    const decoded = await decodeApng(png)
    // 알파가 줄어드는 픽셀이 생기므로 OVER 를 쓰면 안 된다.
    expect(decoded.raw.slice(1).every((f) => f.blendOp === 0)).toBe(true)
  })

  it('불투명 프레임끼리는 OVER 를 골라 델타를 쓴다', async () => {
    const a = blank(W, H)
    fillRect(a, W, { x: 0, y: 0, w: W, h: H }, [20, 30, 40, 255])
    const b = a.slice()
    // 넓게 흩어진 변경. 사각형은 커지지만 대부분의 픽셀은 그대로다.
    setPixel(b, W, 1, 1, [255, 0, 0, 255])
    setPixel(b, W, W - 2, H - 2, [0, 255, 0, 255])

    const png = await encodeApng(toFrames([a, b]), { width: W, height: H, numPlays: 0 })
    const decoded = await decodeApng(png)
    expect(decoded.raw[1]!.blendOp).toBe(1)
  })
})

describe('encodeApng 팔레트', () => {
  const W = 16
  const H = 12

  it('색이 적으면 color type 3 + PLTE + tRNS 로 내려간다', async () => {
    const images = movingSticker(W, H, 3)
    const png = await encodeApng(toFrames(images), { width: W, height: H, numPlays: 0 })
    const decoded = await decodeApng(png)
    expect(decoded.colorType).toBe(3)
    expect(decoded.bitDepth).toBe(8)
    // 완전 투명, 반투명 2종, 불투명 1종.
    expect(decoded.paletteSize).toBe(4)
    expect(decoded.trnsLength).toBe(3)
  })

  it('palette:false 면 RGBA 로 남는다', async () => {
    const images = movingSticker(W, H, 3)
    const png = await encodeApng(toFrames(images), {
      width: W,
      height: H,
      numPlays: 0,
      palette: false,
    })
    const decoded = await decodeApng(png)
    expect(decoded.colorType).toBe(6)
    expect(decoded.paletteSize).toBe(0)
  })

  it('257색이 넘으면 자동으로 RGBA 로 남는다 (손실 양자화를 하지 않는다)', async () => {
    const rgba = new Uint8Array(W * H * 4)
    for (let i = 0; i < W * H; i++) {
      rgba[i * 4] = i & 0xff
      rgba[i * 4 + 1] = (i * 3) & 0xff
      rgba[i * 4 + 2] = (i * 7) & 0xff
      rgba[i * 4 + 3] = 255
    }
    const second = rgba.slice()
    for (let i = 0; i < W * H; i++) second[i * 4 + 2] = (i * 11 + 1) & 0xff

    const png = await encodeApng(toFrames([rgba, second]), { width: W, height: H, numPlays: 0 })
    const decoded = await decodeApng(png)
    expect(decoded.colorType).toBe(6)
  })

  it('팔레트 경로에서도 알파 0 픽셀의 RGB 가 보존된다', async () => {
    // 흰색 + 알파 0. 프리멀티플라이였다면 RGB 가 0 으로 눌린다.
    const rgba = new Uint8Array([255, 255, 255, 0, 10, 20, 30, 128])
    const png = await encodeApng([{ rgba, delayNum: 1, delayDen: 24 }], {
      width: 2,
      height: 1,
      numPlays: 0,
    })
    const decoded = await decodeApng(png)
    expect(decoded.colorType).toBe(3)
    expectBytesEqual(decoded.raw[0]!.rgba, rgba, '팔레트 왕복')
  })
})

// ---------------------------------------------------------------------------
// 무손실 왕복 (이 파일에서 가장 중요한 검사)
// ---------------------------------------------------------------------------

interface Scenario {
  label: string
  width: number
  height: number
  images: Uint8Array[]
}

function makeScenarios(): Scenario[] {
  const scenarios: Scenario[] = []

  scenarios.push({
    label: '움직이는 반투명 스티커',
    width: 16,
    height: 12,
    images: movingSticker(16, 12, 6),
  })

  {
    // 정지 구간이 섞인 시퀀스. 1x1 더미 경로를 탄다.
    const W = 20
    const H = 14
    const base = blank(W, H)
    fillRect(base, W, { x: 3, y: 3, w: 8, h: 6 }, [12, 200, 90, 255])
    const images = [base, base.slice(), base.slice()]
    const moved = base.slice()
    fillRect(moved, W, { x: 3, y: 3, w: 8, h: 6 }, [0, 0, 0, 0])
    fillRect(moved, W, { x: 6, y: 5, w: 8, h: 6 }, [12, 200, 90, 255])
    images.push(moved, moved.slice(), moved.slice())
    scenarios.push({ label: '정지 구간이 섞인 시퀀스', width: W, height: H, images })
  }

  {
    // 알파가 커졌다 작아지는 페이드. OVER 를 잘못 고르면 여기서 무너진다.
    const W = 12
    const H = 8
    const images: Uint8Array[] = []
    for (const alpha of [0, 40, 120, 255, 120, 40, 0]) {
      const rgba = blank(W, H)
      fillRect(rgba, W, { x: 2, y: 1, w: 7, h: 5 }, [180, 30, 220, alpha])
      images.push(rgba)
    }
    scenarios.push({ label: '알파 페이드 인/아웃', width: W, height: H, images })
  }

  {
    // 256색을 넘겨 RGBA 경로로 떨어지는 그라디언트.
    const W = 24
    const H = 18
    const images: Uint8Array[] = []
    for (let i = 0; i < 4; i++) {
      const rgba = new Uint8Array(W * H * 4)
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          setPixel(rgba, W, x, y, [
            (x * 9 + i * 13) & 0xff,
            (y * 11 + i * 29) & 0xff,
            (x * y + i) & 0xff,
            (x + y + i) & 0xff,
          ])
        }
      }
      images.push(rgba)
    }
    scenarios.push({ label: '고유색이 많은 그라디언트', width: W, height: H, images })
  }

  {
    // 불투명 배경 위 국소 변경. OVER + 델타 경로를 탄다.
    const W = 20
    const H = 16
    const images: Uint8Array[] = []
    const base = blank(W, H)
    fillRect(base, W, { x: 0, y: 0, w: W, h: H }, [25, 25, 35, 255])
    for (let i = 0; i < 5; i++) {
      const rgba = base.slice()
      setPixel(rgba, W, 1 + i, 1, [255, 255, 0, 255])
      setPixel(rgba, W, W - 2 - i, H - 2, [0, 255, 255, 255])
      images.push(rgba)
    }
    scenarios.push({ label: '불투명 배경 위 점 두 개', width: W, height: H, images })
  }

  {
    // 완전히 사라졌다가 나타나는 스티커. 알파가 0 으로 떨어지는 경계.
    const W = 10
    const H = 10
    const on = blank(W, H)
    fillRect(on, W, { x: 2, y: 2, w: 6, h: 6 }, [255, 128, 0, 200])
    scenarios.push({
      label: '나타났다 사라지는 스티커',
      width: W,
      height: H,
      images: [blank(W, H), on, blank(W, H), on.slice(), blank(W, H)],
    })
  }

  {
    // 단일 프레임.
    const W = 5
    const H = 5
    const rgba = blank(W, H)
    fillRect(rgba, W, { x: 1, y: 1, w: 3, h: 3 }, [7, 8, 9, 77])
    scenarios.push({ label: '단일 프레임', width: W, height: H, images: [rgba] })
  }

  {
    // 1x1 캔버스.
    scenarios.push({
      label: '1x1 캔버스',
      width: 1,
      height: 1,
      images: [
        new Uint8Array([0, 0, 0, 0]),
        new Uint8Array([255, 0, 0, 255]),
        new Uint8Array([255, 0, 0, 255]),
        new Uint8Array([0, 0, 0, 0]),
      ],
    })
  }

  return scenarios
}

describe.skipIf(!hasDecompression)('encodeApng 무손실 왕복 (직접 디코드)', () => {
  const scenarios = makeScenarios()
  const options: Array<{ label: string; diff: boolean; palette: boolean }> = [
    { label: 'diff+palette', diff: true, palette: true },
    { label: 'diff only', diff: true, palette: false },
    { label: 'palette only', diff: false, palette: true },
    { label: 'none', diff: false, palette: false },
  ]

  for (const scenario of scenarios) {
    for (const opt of options) {
      it(`${scenario.label} / ${opt.label}`, async () => {
        const png = await encodeApng(toFrames(scenario.images), {
          width: scenario.width,
          height: scenario.height,
          numPlays: 0,
          diff: opt.diff,
          palette: opt.palette,
        })

        const decoded = await decodeApng(png)
        expect(decoded.width).toBe(scenario.width)
        expect(decoded.height).toBe(scenario.height)
        expect(decoded.numFrames).toBe(scenario.images.length)
        expect(decoded.raw).toHaveLength(scenario.images.length)

        // 사양의 정수 합성식과 흔한 "알파 0 이면 건너뛴다" 구현 양쪽에서 같아야 한다.
        for (const strict of [true, false]) {
          const composed = composite(decoded, strict)
          for (let i = 0; i < scenario.images.length; i++) {
            expectBytesEqual(
              composed[i]!,
              scenario.images[i]!,
              `${scenario.label}/${opt.label}/strict=${strict} 프레임 ${i}`,
            )
          }
        }
      })
    }
  }
})

// ---------------------------------------------------------------------------
// 실제로 작아지는가
// ---------------------------------------------------------------------------

describe('크기 최적화 효과', () => {
  /** 정지 구간이 긴 시퀀스. 24프레임 중 대부분이 이전과 같다. */
  function mostlyStatic(): { width: number; height: number; images: Uint8Array[] } {
    const width = 64
    const height = 64
    const base = new Uint8Array(width * height * 4)
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        setPixel(base, width, x, y, [(x * 4) & 0xff, (y * 4) & 0xff, 128, 255])
      }
    }
    const images: Uint8Array[] = []
    for (let i = 0; i < 24; i++) {
      const rgba = base.slice()
      // 4프레임에 한 번만 작은 점이 움직인다. 나머지는 완전히 동일하다.
      const step = Math.floor(i / 4)
      fillRect(rgba, width, { x: 4 + step * 6, y: 30, w: 4, h: 4 }, [255, 0, 0, 255])
      images.push(rgba)
    }
    return { width, height, images }
  }

  it('차분이 파일을 실제로 줄인다', async () => {
    const { width, height, images } = mostlyStatic()
    const withDiff = await encodeApng(toFrames(images), {
      width,
      height,
      numPlays: 0,
      diff: true,
      palette: false,
    })
    const withoutDiff = await encodeApng(toFrames(images), {
      width,
      height,
      numPlays: 0,
      diff: false,
      palette: false,
    })
    expect(withDiff.length).toBeLessThan(withoutDiff.length)
    // 정지 구간이 3/4 이라 절반 아래로 떨어져야 한다.
    expect(withDiff.length).toBeLessThan(withoutDiff.length / 2)
  })

  it('팔레트가 파일을 실제로 줄인다', async () => {
    const width = 32
    const height = 32
    const images: Uint8Array[] = []
    for (let i = 0; i < 8; i++) {
      const rgba = new Uint8Array(width * height * 4)
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          // 색 4가지만 쓴다. 무손실 팔레트 조건을 만족한다.
          const c = (x + y + i) % 4
          const colors: Array<[number, number, number, number]> = [
            [0, 0, 0, 0],
            [255, 0, 0, 255],
            [0, 255, 0, 255],
            [0, 0, 255, 128],
          ]
          setPixel(rgba, width, x, y, colors[c]!)
        }
      }
      images.push(rgba)
    }

    const withPalette = await encodeApng(toFrames(images), {
      width,
      height,
      numPlays: 0,
      diff: false,
      palette: true,
    })
    const withoutPalette = await encodeApng(toFrames(images), {
      width,
      height,
      numPlays: 0,
      diff: false,
      palette: false,
    })
    expect(withPalette.length).toBeLessThan(withoutPalette.length)
  })

  it('기본값(둘 다 켜짐)이 최적화를 끈 것보다 작다', async () => {
    const { width, height, images } = mostlyStatic()
    const optimized = await encodeApng(toFrames(images), { width, height, numPlays: 0 })
    const m2 = await encodeApng(toFrames(images), {
      width,
      height,
      numPlays: 0,
      diff: false,
      palette: false,
    })
    expect(optimized.length).toBeLessThan(m2.length)
  })

  it('같은 입력은 같은 바이트를 낸다 (결정론)', async () => {
    const images = movingSticker(16, 12, 5)
    const opts = { width: 16, height: 12, numPlays: 0 }
    const a = await encodeApng(toFrames(images), opts)
    const b = await encodeApng(toFrames(images), opts)
    expectBytesEqual(a, b)
  })
})
