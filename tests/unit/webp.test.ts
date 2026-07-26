import { describe, expect, it } from 'vitest'

import {
  assertQuality01,
  buildAnim,
  buildAnmf,
  buildVp8x,
  clampFrameDurationMs,
  hasTransparency,
  isWebpSupported,
  MAX_FRAME_DURATION_MS,
  MIN_FRAME_DURATION_MS,
  muxAnimatedWebp,
  planFrameDurations,
  type StaticWebpSource,
  type WebpWarning,
} from '@/export/webp/encoder.ts'
import {
  ALPH_FOURCC,
  buildVp8lHeader,
  parseStaticWebp,
  parseVp8Header,
  parseVp8lHeader,
  parseWebp,
  VP8_FOURCC,
  VP8L_FOURCC,
  VP8X_FLAG_ALPHA,
  VP8X_FLAG_ANIMATION,
} from '@/export/webp/parse.ts'
import {
  buildRiff,
  concatBytes,
  findChunk,
  parseRiff,
  readChunks,
  readUint24LE,
  UINT24_MAX,
  writeChunk,
  writeUint24LE,
} from '@/export/webp/riff.ts'

// ---------------------------------------------------------------------------
// 테스트용 정지 WebP 조립
// ---------------------------------------------------------------------------

/**
 * 1x1 무손실 비트스트림.
 *
 * 5바이트 VP8L 헤더 뒤에 심플 허프만 코드만 쓰는 최소 이미지 스트림을 이어 붙였다.
 * 비트는 바이트 안에서 LSB 부터 채운다.
 *   transform=0(1) / color cache=0(1) / meta huffman=0(1)
 *   녹 빨 파 알파 각각 [simple=1, num_symbols-1=0, 8bit=1, 심볼 8비트]
 *   거리 [simple=1, num_symbols-1=0, 8bit=0, 심볼 1비트]
 * 심볼은 순서대로 green=0x00, red=0xff, blue=0x00, alpha=0xff 다.
 *
 * **먹서와 파서는 이 본문을 열어 보지 않는다.** 앞 5바이트 헤더에서 크기와 알파
 * 비트만 읽고 나머지는 불투명한 바이트열로 다룬다. 이 테스트가 검증하는 것도
 * RIFF 먹싱과 헤더 왕복이지 픽셀 디코딩이 아니다.
 */
const VP8L_1X1_BODY: Uint8Array = new Uint8Array([0x28, 0x40, 0xff, 0x0b, 0xd0, 0xff, 0x00])

/** 무손실 정지 WebP. 단순 컨테이너(VP8L 단독)다. */
function makeLosslessStatic(width: number, height: number, hasAlpha: boolean): Uint8Array {
  const data = concatBytes([buildVp8lHeader(width, height, hasAlpha), VP8L_1X1_BODY])
  return buildRiff([writeChunk(VP8L_FOURCC, data)])
}

/**
 * 손실 VP8 키 프레임 헤더 10바이트 + 본문.
 * frame tag 는 키 프레임(최하위 비트 0), show_frame=1, first_part_size=4 로 잡았다.
 */
function makeVp8Bitstream(width: number, height: number, bodyLength: number): Uint8Array {
  const out = new Uint8Array(10 + bodyLength)
  const tag = (1 << 4) | (4 << 5) // key_frame=0, version=0, show_frame=1
  out[0] = tag & 0xff
  out[1] = (tag >>> 8) & 0xff
  out[2] = (tag >>> 16) & 0xff
  out[3] = 0x9d
  out[4] = 0x01
  out[5] = 0x2a
  out[6] = width & 0xff
  out[7] = (width >>> 8) & 0x3f
  out[8] = height & 0xff
  out[9] = (height >>> 8) & 0x3f
  for (let i = 0; i < bodyLength; i += 1) out[10 + i] = (i * 7 + 1) & 0xff
  return out
}

/** 손실 + 알파 정지 WebP. 확장 컨테이너(VP8X + ALPH + VP8 )다. */
function makeLossyStatic(width: number, height: number, hasAlpha: boolean, bodyLength = 3): Uint8Array {
  const bitstream = writeChunk(VP8_FOURCC, makeVp8Bitstream(width, height, bodyLength))
  if (!hasAlpha) return buildRiff([bitstream])

  // ALPH 페이로드를 홀수 길이로 둬 패딩 경로를 지나게 한다.
  const alph = writeChunk(ALPH_FOURCC, new Uint8Array([0x00, 0x11, 0x22]))
  return buildRiff([buildVp8x(width, height, true, false), alph, bitstream])
}

function sources(bytes: Uint8Array, durationsMs: readonly number[]): StaticWebpSource[] {
  return durationsMs.map((durationMs) => ({ bytes, durationMs }))
}

// ---------------------------------------------------------------------------
// RIFF
// ---------------------------------------------------------------------------

describe('riff', () => {
  it('짝수 길이 청크는 패딩 없이 8+n 바이트다', () => {
    const chunk = writeChunk('TEST', new Uint8Array([1, 2, 3, 4]))
    expect(chunk.length).toBe(12)
    const [parsed] = readChunks(chunk)
    expect(parsed?.fourCC).toBe('TEST')
    expect(parsed?.length).toBe(4)
    expect(Array.from(parsed?.data ?? [])).toEqual([1, 2, 3, 4])
  })

  it('홀수 길이 청크는 0 한 바이트로 패딩되지만 size 필드는 그대로다', () => {
    const chunk = writeChunk('ODD_', new Uint8Array([9, 8, 7]))
    // 8(헤더) + 3(데이터) + 1(패드)
    expect(chunk.length).toBe(12)
    expect(chunk[11]).toBe(0)

    const [parsed] = readChunks(chunk)
    expect(parsed?.length).toBe(3)
    expect(Array.from(parsed?.data ?? [])).toEqual([9, 8, 7])
  })

  it('홀수 청크 뒤의 청크가 밀리지 않는다', () => {
    const first = writeChunk('ODD_', new Uint8Array([1, 2, 3]))
    const second = writeChunk('NEXT', new Uint8Array([4, 5]))
    const chunks = readChunks(concatBytes([first, second]))

    expect(chunks.map((c) => c.fourCC)).toEqual(['ODD_', 'NEXT'])
    expect(Array.from(chunks[1]?.data ?? [])).toEqual([4, 5])
    // 두 번째 청크는 짝수 오프셋에서 시작해야 한다.
    expect((chunks[1]?.offset ?? -1) % 2).toBe(0)
  })

  it('buildRiff 왕복: 폼 타입, size 필드, 청크 순서', () => {
    const parts = [
      writeChunk('AAAA', new Uint8Array([1])),
      writeChunk('BBBB', new Uint8Array([2, 3, 4])),
      writeChunk('CCCC', new Uint8Array(0)),
    ]
    const file = buildRiff(parts)

    expect(String.fromCharCode(...file.subarray(0, 4))).toBe('RIFF')
    expect(String.fromCharCode(...file.subarray(8, 12))).toBe('WEBP')

    const riff = parseRiff(file)
    expect(riff.formType).toBe('WEBP')
    // size 필드 = 파일 전체 - 8
    expect(riff.declaredSize + 8).toBe(file.length)
    expect(riff.chunks.map((c) => c.fourCC)).toEqual(['AAAA', 'BBBB', 'CCCC'])
    expect(Array.from(riff.chunks[1]?.data ?? [])).toEqual([2, 3, 4])
    expect(riff.chunks[2]?.length).toBe(0)
  })

  it('parseRiff 는 시그니처 / 폼 타입 / 잘린 길이를 거부한다', () => {
    const good = buildRiff([writeChunk('AAAA', new Uint8Array([1, 2]))])

    const badSig = good.slice()
    badSig[0] = 0x52 + 1
    expect(() => parseRiff(badSig)).toThrow(/시그니처/)

    const badForm = good.slice()
    badForm[8] = 0x58
    expect(() => parseRiff(badForm)).toThrow(/폼 타입/)

    expect(() => parseRiff(good.subarray(0, good.length - 2))).toThrow(/버퍼를 넘는다/)
    expect(() => parseRiff(new Uint8Array(8))).toThrow(/12바이트/)
  })

  it('findChunk 는 없으면 null 을 준다', () => {
    const riff = parseRiff(buildRiff([writeChunk('AAAA', new Uint8Array(2))]))
    expect(findChunk(riff.chunks, 'AAAA')?.fourCC).toBe('AAAA')
    expect(findChunk(riff.chunks, 'ZZZZ')).toBeNull()
  })

  it('fourCC 는 정확히 4글자여야 한다', () => {
    expect(() => writeChunk('ABC', new Uint8Array(0))).toThrow(/4글자/)
    expect(() => writeChunk('ABCDE', new Uint8Array(0))).toThrow(/4글자/)
  })
})

// ---------------------------------------------------------------------------
// 24비트 정수
// ---------------------------------------------------------------------------

describe('uint24 리틀엔디언', () => {
  it('경계값 왕복', () => {
    const buf = new Uint8Array(3)
    for (const value of [0, 1, 255, 256, 65535, 65536, 0xfffffe, UINT24_MAX]) {
      writeUint24LE(buf, 0, value)
      expect(readUint24LE(buf, 0)).toBe(value)
    }
  })

  it('바이트 순서가 리틀엔디언이다', () => {
    const buf = new Uint8Array(3)
    writeUint24LE(buf, 0, 0x123456)
    expect(Array.from(buf)).toEqual([0x56, 0x34, 0x12])
  })

  it('오프셋을 지켜 쓴다', () => {
    const buf = new Uint8Array(8)
    writeUint24LE(buf, 2, UINT24_MAX)
    expect(Array.from(buf)).toEqual([0, 0, 0xff, 0xff, 0xff, 0, 0, 0])
    expect(readUint24LE(buf, 2)).toBe(UINT24_MAX)
  })

  it('범위를 벗어나면 던진다', () => {
    const buf = new Uint8Array(3)
    expect(() => writeUint24LE(buf, 0, -1)).toThrow()
    expect(() => writeUint24LE(buf, 0, UINT24_MAX + 1)).toThrow()
    expect(() => writeUint24LE(buf, 0, 1.5)).toThrow()
  })
})

// ---------------------------------------------------------------------------
// 비트스트림 헤더
// ---------------------------------------------------------------------------

describe('비트스트림 헤더', () => {
  it('VP8L 헤더 왕복', () => {
    for (const [w, h, alpha] of [
      [1, 1, true],
      [1, 1, false],
      [512, 512, true],
      [16383, 16383, true],
      [1920, 1080, false],
    ] as const) {
      const header = parseVp8lHeader(buildVp8lHeader(w, h, alpha))
      expect(header.width).toBe(w)
      expect(header.height).toBe(h)
      expect(header.hasAlpha).toBe(alpha)
    }
  })

  it('VP8L 시그니처가 아니면 던진다', () => {
    const bad = buildVp8lHeader(4, 4, true)
    bad[0] = 0x00
    expect(() => parseVp8lHeader(bad)).toThrow(/시그니처/)
  })

  it('VP8 손실 헤더에서 크기를 읽는다', () => {
    const header = parseVp8Header(makeVp8Bitstream(640, 480, 4))
    expect(header.width).toBe(640)
    expect(header.height).toBe(480)
  })

  it('VP8 시작 코드가 틀리면 던진다', () => {
    const bad = makeVp8Bitstream(8, 8, 2)
    bad[4] = 0x02
    expect(() => parseVp8Header(bad)).toThrow(/시작 코드/)
  })
})

// ---------------------------------------------------------------------------
// 정지 WebP 해체
// ---------------------------------------------------------------------------

describe('parseStaticWebp', () => {
  it('무손실 단순 컨테이너에서 VP8L 을 꺼낸다', () => {
    const still = parseStaticWebp(makeLosslessStatic(1, 1, true))
    expect(still.bitstreamFourCC).toBe(VP8L_FOURCC)
    expect(still.width).toBe(1)
    expect(still.height).toBe(1)
    expect(still.hasAlpha).toBe(true)
    expect(still.alph).toBeNull()
    expect(still.extended).toBe(false)
    // 헤더 5바이트 + 본문
    expect(still.bitstream.length).toBe(5 + VP8L_1X1_BODY.length)
  })

  it('무손실인데 알파 비트가 꺼져 있으면 hasAlpha 가 false 다', () => {
    expect(parseStaticWebp(makeLosslessStatic(2, 2, false)).hasAlpha).toBe(false)
  })

  it('손실 + ALPH 확장 컨테이너에서 알파 평면을 따로 꺼낸다', () => {
    const still = parseStaticWebp(makeLossyStatic(16, 16, true))
    expect(still.bitstreamFourCC).toBe(VP8_FOURCC)
    expect(still.hasAlpha).toBe(true)
    expect(still.alph).not.toBeNull()
    expect(Array.from(still.alph ?? [])).toEqual([0x00, 0x11, 0x22])
    expect(still.extended).toBe(true)
    expect(still.width).toBe(16)
    expect(still.height).toBe(16)
  })

  it('손실 단독 컨테이너는 알파가 없다', () => {
    const still = parseStaticWebp(makeLossyStatic(16, 16, false))
    expect(still.hasAlpha).toBe(false)
    expect(still.alph).toBeNull()
    expect(still.extended).toBe(false)
  })

  it('비트스트림이 없으면 던진다', () => {
    const file = buildRiff([writeChunk('JUNK', new Uint8Array(4))])
    expect(() => parseStaticWebp(file)).toThrow(/비트스트림/)
  })
})

// ---------------------------------------------------------------------------
// 청크 조립
// ---------------------------------------------------------------------------

describe('청크 조립', () => {
  it('VP8X 는 크기에서 1 을 뺀 값을 24비트로 담는다', () => {
    const chunk = buildVp8x(512, 384, true, true)
    const [parsed] = readChunks(chunk)
    expect(parsed?.fourCC).toBe('VP8X')
    expect(parsed?.length).toBe(10)

    const data = parsed?.data ?? new Uint8Array(0)
    expect((data[0] ?? 0) & VP8X_FLAG_ANIMATION).toBe(VP8X_FLAG_ANIMATION)
    expect((data[0] ?? 0) & VP8X_FLAG_ALPHA).toBe(VP8X_FLAG_ALPHA)
    expect(readUint24LE(data, 4)).toBe(511)
    expect(readUint24LE(data, 7)).toBe(383)
  })

  it('VP8X 플래그는 요청한 비트만 켠다', () => {
    const data = readChunks(buildVp8x(4, 4, false, true))[0]?.data ?? new Uint8Array(1)
    expect(data[0]).toBe(VP8X_FLAG_ANIMATION)
  })

  it('ANIM 은 배경 BGRA 4바이트 뒤에 loop_count 를 리틀엔디언 uint16 으로 담는다', () => {
    const data = readChunks(buildAnim(300, [1, 2, 3, 4]))[0]?.data ?? new Uint8Array(0)
    expect(Array.from(data.subarray(0, 4))).toEqual([1, 2, 3, 4])
    expect(Array.from(data.subarray(4, 6))).toEqual([300 & 0xff, 300 >>> 8])
  })

  it('ANIM 기본 배경은 완전 투명이다', () => {
    const data = readChunks(buildAnim(0))[0]?.data ?? new Uint8Array(0)
    expect(Array.from(data.subarray(0, 4))).toEqual([0, 0, 0, 0])
  })

  it('loopCount 가 uint16 범위를 넘으면 던진다', () => {
    expect(() => buildAnim(65536)).toThrow(/0\.\.65535/)
    expect(() => buildAnim(-1)).toThrow(/0\.\.65535/)
  })

  it('ANMF 좌표는 2픽셀 단위로 저장된다', () => {
    const chunk = buildAnmf({
      x: 4,
      y: 6,
      width: 10,
      height: 20,
      durationMs: 40,
      blendNone: true,
      disposeBackground: false,
      subChunks: [],
    })
    const data = readChunks(chunk)[0]?.data ?? new Uint8Array(0)
    expect(readUint24LE(data, 0)).toBe(2)
    expect(readUint24LE(data, 3)).toBe(3)
    expect(readUint24LE(data, 6)).toBe(9)
    expect(readUint24LE(data, 9)).toBe(19)
    expect(readUint24LE(data, 12)).toBe(40)
    expect(data[15]).toBe(0x02)
  })

  it('ANMF 좌표가 홀수면 던진다', () => {
    expect(() =>
      buildAnmf({
        x: 1,
        y: 0,
        width: 4,
        height: 4,
        durationMs: 40,
        blendNone: true,
        disposeBackground: false,
        subChunks: [],
      }),
    ).toThrow(/짝수/)
  })
})

// ---------------------------------------------------------------------------
// 지연 클램프
// ---------------------------------------------------------------------------

describe('프레임 지연', () => {
  it(`${MIN_FRAME_DURATION_MS}ms 미만은 올린다`, () => {
    expect(clampFrameDurationMs(0)).toBe(MIN_FRAME_DURATION_MS)
    expect(clampFrameDurationMs(10)).toBe(MIN_FRAME_DURATION_MS)
    // 60fps = 16.67ms 는 Chrome 이 100ms 로 바꿔 버리므로 20ms 로 올린다.
    expect(clampFrameDurationMs(1000 / 60)).toBe(MIN_FRAME_DURATION_MS)
  })

  it('50fps 이하는 그대로 통과한다', () => {
    expect(clampFrameDurationMs(20)).toBe(20)
    expect(clampFrameDurationMs(1000 / 25)).toBe(40)
    expect(clampFrameDurationMs(1000 / 24)).toBe(42)
    expect(clampFrameDurationMs(1000 / 30)).toBe(33)
  })

  it('24비트 상한을 넘지 않는다', () => {
    expect(clampFrameDurationMs(MAX_FRAME_DURATION_MS + 1000)).toBe(MAX_FRAME_DURATION_MS)
  })

  it('planFrameDurations 는 클램프된 개수를 센다', () => {
    const plan = planFrameDurations([10, 40, 5, 40])
    expect(plan.durationsMs).toEqual([20, 40, 20, 40])
    expect(plan.clampedCount).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// 먹싱 왕복
// ---------------------------------------------------------------------------

describe('muxAnimatedWebp -> parseWebp 왕복', () => {
  const still = makeLosslessStatic(1, 1, true)

  it('무손실 프레임을 ANMF 로 묶고 되읽는다', () => {
    const bytes = muxAnimatedWebp(sources(still, [40, 40, 80]), {
      width: 1,
      height: 1,
      loopCount: 0,
    })
    const info = parseWebp(bytes)

    expect(info.animated).toBe(true)
    expect(info.width).toBe(1)
    expect(info.height).toBe(1)
    expect(info.frameCount).toBe(3)
    expect(info.durationsMs).toEqual([40, 40, 80])
    expect(info.hasAlpha).toBe(true)
    expect(info.backgroundBgra).toEqual([0, 0, 0, 0])
    expect(info.frames.map((f) => f.subChunks)).toEqual([['VP8L'], ['VP8L'], ['VP8L']])
  })

  it('청크 순서는 VP8X, ANIM, ANMF... 다', () => {
    const bytes = muxAnimatedWebp(sources(still, [40, 40]), { width: 1, height: 1, loopCount: 1 })
    const riff = parseRiff(bytes)
    expect(riff.chunks.map((c) => c.fourCC)).toEqual(['VP8X', 'ANIM', 'ANMF', 'ANMF'])
    // RIFF size 필드가 실제 길이와 맞고 전체가 짝수다.
    expect(riff.declaredSize + 8).toBe(bytes.length)
    expect(bytes.length % 2).toBe(0)
  })

  it('loopCount 왕복: 0 은 무한', () => {
    const bytes = muxAnimatedWebp(sources(still, [40]), { width: 1, height: 1, loopCount: 0 })
    expect(parseWebp(bytes).loopCount).toBe(0)
  })

  it('loopCount 왕복: 3회', () => {
    const bytes = muxAnimatedWebp(sources(still, [40]), { width: 1, height: 1, loopCount: 3 })
    expect(parseWebp(bytes).loopCount).toBe(3)
  })

  it('loopCount 왕복: uint16 상한', () => {
    const bytes = muxAnimatedWebp(sources(still, [40]), { width: 1, height: 1, loopCount: 65535 })
    expect(parseWebp(bytes).loopCount).toBe(65535)
  })

  it('모든 프레임이 블렌딩 없이 덮어쓴다 (투명 잔상 방지)', () => {
    const bytes = muxAnimatedWebp(sources(still, [40, 40]), { width: 1, height: 1, loopCount: 0 })
    for (const frame of parseWebp(bytes).frames) {
      expect(frame.blendNone).toBe(true)
      expect(frame.disposeBackground).toBe(false)
      expect(frame.x).toBe(0)
      expect(frame.y).toBe(0)
      expect(frame.width).toBe(1)
      expect(frame.height).toBe(1)
    }
  })

  it('손실 + ALPH 프레임은 ALPH 를 비트스트림 앞에 유지한다', () => {
    const lossy = makeLossyStatic(16, 16, true)
    const bytes = muxAnimatedWebp(sources(lossy, [40, 40]), {
      width: 16,
      height: 16,
      loopCount: 2,
    })
    const info = parseWebp(bytes)

    expect(info.frameCount).toBe(2)
    expect(info.hasAlpha).toBe(true)
    expect(info.frames.map((f) => f.subChunks)).toEqual([
      ['ALPH', 'VP8 '],
      ['ALPH', 'VP8 '],
    ])

    // ALPH(3바이트, 홀수)와 VP8 본문(13바이트, 홀수)의 패딩이 살아 있어야
    // 두 서브청크를 모두 되읽을 수 있다. 위 expect 가 그것을 증명한다.
    const [first] = info.frames
    expect(first?.width).toBe(16)
    expect(first?.height).toBe(16)
  })

  it('알파 없는 프레임만 있으면 VP8X 의 ALPHA 비트를 켜지 않는다', () => {
    const opaque = makeLosslessStatic(4, 4, false)
    const bytes = muxAnimatedWebp(sources(opaque, [40]), { width: 4, height: 4, loopCount: 0 })
    const vp8x = findChunk(parseRiff(bytes).chunks, 'VP8X')
    expect((vp8x?.data[0] ?? 0) & VP8X_FLAG_ALPHA).toBe(0)
    expect((vp8x?.data[0] ?? 0) & VP8X_FLAG_ANIMATION).toBe(VP8X_FLAG_ANIMATION)
    expect(parseWebp(bytes).hasAlpha).toBe(false)
  })

  it('20ms 미만 지연은 클램프하고 경고한다', () => {
    const warnings: WebpWarning[] = []
    const bytes = muxAnimatedWebp(sources(still, [16, 16, 40]), {
      width: 1,
      height: 1,
      loopCount: 0,
      onWarning: (w) => warnings.push(w),
    })

    expect(parseWebp(bytes).durationsMs).toEqual([20, 20, 40])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.code).toBe('duration-clamped')
    expect(warnings[0]?.count).toBe(2)
  })

  it('클램프가 없으면 경고도 없다', () => {
    const warnings: WebpWarning[] = []
    muxAnimatedWebp(sources(still, [40, 40]), {
      width: 1,
      height: 1,
      loopCount: 0,
      onWarning: (w) => warnings.push(w),
    })
    expect(warnings).toHaveLength(0)
  })

  it('프레임 크기가 캔버스와 다르면 던진다', () => {
    expect(() =>
      muxAnimatedWebp(sources(still, [40]), { width: 8, height: 8, loopCount: 0 }),
    ).toThrow(/크기가 캔버스와 다르다/)
  })

  it('프레임이 없으면 던진다', () => {
    expect(() => muxAnimatedWebp([], { width: 4, height: 4, loopCount: 0 })).toThrow(/프레임/)
  })

  it('캔버스 크기 상한을 넘으면 던진다', () => {
    expect(() =>
      muxAnimatedWebp(sources(still, [40]), { width: 16384, height: 4, loopCount: 0 }),
    ).toThrow(/16383/)
  })
})

// ---------------------------------------------------------------------------
// 잡동사니
// ---------------------------------------------------------------------------

describe('보조 함수', () => {
  it('hasTransparency 는 알파 255 미만 픽셀을 찾는다', () => {
    expect(hasTransparency(new Uint8Array([1, 2, 3, 255, 4, 5, 6, 255]))).toBe(false)
    expect(hasTransparency(new Uint8Array([1, 2, 3, 255, 4, 5, 6, 254]))).toBe(true)
    expect(hasTransparency(new Uint8Array(0))).toBe(false)
  })

  it('quality 는 0~1 스케일만 받는다', () => {
    expect(() => assertQuality01(0)).not.toThrow()
    expect(() => assertQuality01(0.82)).not.toThrow()
    expect(() => assertQuality01(1)).not.toThrow()
    // 0~100 스케일을 넘기면 조용히 최고 품질로 떨어지는 대신 즉시 터진다.
    expect(() => assertQuality01(82)).toThrow(/0~1/)
    expect(() => assertQuality01(-0.1)).toThrow(/0~1/)
    expect(() => assertQuality01(Number.NaN)).toThrow(/0~1/)
  })

  it('isWebpSupported 는 OffscreenCanvas 가 없는 Node 에서 false 다', () => {
    // 이 단정이 깨지면 인코딩 자체가 브라우저 전용이라는 전제가 무너진 것이다.
    expect(isWebpSupported()).toBe(typeof OffscreenCanvas !== 'undefined')
  })
})
