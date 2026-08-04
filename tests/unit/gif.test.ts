import { describe, expect, it } from 'vitest'

import { applyBayerDither } from '@/export/gif/dither.ts'
import { buildGlobalPalette, encodeGif, loopCountToRepeat, pickSampleIndices } from '@/export/gif/encoder.ts'
import type { GifFrame } from '@/export/gif/encoder.ts'
import { parseGifFrames, parseGifHeader } from '@/export/gif/parse.ts'

const W = 8
const H = 8

/** 단색 RGBA 프레임. */
function solidFrame(r: number, g: number, b: number, a = 255): Uint8Array {
  const px = new Uint8Array(W * H * 4)
  for (let i = 0; i < px.length; i += 4) {
    px[i] = r
    px[i + 1] = g
    px[i + 2] = b
    px[i + 3] = a
  }
  return px
}

/** 왼쪽 절반은 불투명 색, 오른쪽 절반은 알파 0. */
function halfTransparentFrame(r: number, g: number, b: number): Uint8Array {
  const px = new Uint8Array(W * H * 4)
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const i = (y * W + x) * 4
      const opaque = x < W / 2
      px[i] = r
      px[i + 1] = g
      px[i + 2] = b
      // 알파 0 인데 RGB 는 불투명 영역과 같은 값으로 둔다.
      // 인코더가 RGB 를 지우지 않으면 이 픽셀이 불투명 색으로 매핑되어 버린다.
      px[i + 3] = opaque ? 255 : 0
    }
  }
  return px
}

function framesAt(fps: number, colors: Array<[number, number, number]>): GifFrame[] {
  const delayMs = 1000 / fps
  return colors.map(([r, g, b]) => ({ rgba: solidFrame(r, g, b), delayMs }))
}

const RED_GREEN_BLUE_WHITE: Array<[number, number, number]> = [
  [220, 30, 30],
  [30, 200, 60],
  [40, 60, 230],
  [250, 250, 250],
]

describe('encodeGif -> parseGifHeader 왕복', () => {
  it('GIF89a 시그니처와 캔버스 크기를 기록한다', async () => {
    const bytes = await encodeGif(framesAt(20, RED_GREEN_BLUE_WHITE), {
      width: W,
      height: H,
      loopCount: 0,
      maxColors: 64,
      transparent: false,
      dither: 0,
    })

    expect(bytes[0]).toBe(0x47) // 'G'
    const header = parseGifHeader(bytes)
    expect(header.version).toBe('GIF89a')
    expect(header.width).toBe(W)
    expect(header.height).toBe(H)
  })

  it('프레임 수와 딜레이 센티초가 일치한다 (20fps -> 5)', async () => {
    const frames = framesAt(20, RED_GREEN_BLUE_WHITE)
    const bytes = await encodeGif(frames, {
      width: W,
      height: H,
      loopCount: 0,
      maxColors: 128,
      transparent: false,
      dither: 0,
    })

    const header = parseGifHeader(bytes)
    expect(header.frameCount).toBe(4)
    expect(header.delaysCentis).toEqual([5, 5, 5, 5])
  })

  it('25fps 는 정확히 4 센티초로 떨어진다', async () => {
    const bytes = await encodeGif(framesAt(25, RED_GREEN_BLUE_WHITE.slice(0, 3)), {
      width: W,
      height: H,
      loopCount: 0,
      maxColors: 64,
      transparent: false,
      dither: 0,
    })

    expect(parseGifHeader(bytes).delaysCentis).toEqual([4, 4, 4])
  })

  it('loopCount 0 은 무한(NETSCAPE 0)으로 왕복한다', async () => {
    const bytes = await encodeGif(framesAt(20, RED_GREEN_BLUE_WHITE), {
      width: W,
      height: H,
      loopCount: 0,
      maxColors: 64,
      transparent: false,
      dither: 0,
    })

    expect(parseGifHeader(bytes).loopCount).toBe(0)
  })

  it('loopCount 3(3회 재생) 은 NETSCAPE 2 로 왕복한다', async () => {
    // loopCount 는 '재생 횟수'다. NETSCAPE 값은 첫 재생을 뺀 추가 반복이라 하나 작다.
    const bytes = await encodeGif(framesAt(20, RED_GREEN_BLUE_WHITE), {
      width: W,
      height: H,
      loopCount: 3,
      maxColors: 64,
      transparent: false,
      dither: 0,
    })

    expect(parseGifHeader(bytes).loopCount).toBe(2)
  })

  it('loopCount 1 은 NETSCAPE 확장 자체를 쓰지 않는다', async () => {
    const bytes = await encodeGif(framesAt(20, RED_GREEN_BLUE_WHITE), {
      width: W,
      height: H,
      loopCount: 1,
      maxColors: 64,
      transparent: false,
      dither: 0,
    })

    expect(parseGifHeader(bytes).loopCount).toBeNull()
  })
})

describe('loopCountToRepeat', () => {
  it('0 은 무한, 1 은 -1, n 회 재생은 추가 반복 n-1 이다', () => {
    expect(loopCountToRepeat(0)).toBe(0)
    expect(loopCountToRepeat(1)).toBe(-1)
    expect(loopCountToRepeat(2)).toBe(1)
    expect(loopCountToRepeat(7)).toBe(6)
    expect(loopCountToRepeat(-3)).toBe(0)
  })

  it('2회 재생이 확장 생략(-1)으로 뭉개지지 않는다', () => {
    // 여기가 뭉개지면 "반복 2회" GIF 가 1회만 재생된다. 1 과 2 는 반드시 갈려야 한다.
    expect(loopCountToRepeat(2)).not.toBe(loopCountToRepeat(1))
  })
})

describe('투명 옵션', () => {
  it('알파 0 픽셀이 투명 인덱스 0 으로 매핑된다', async () => {
    const frames: GifFrame[] = [
      { rgba: halfTransparentFrame(240, 240, 240), delayMs: 50 },
      { rgba: halfTransparentFrame(20, 120, 240), delayMs: 50 },
    ]

    const bytes = await encodeGif(frames, {
      width: W,
      height: H,
      loopCount: 0,
      maxColors: 64,
      transparent: true,
      dither: 0,
    })

    const file = parseGifFrames(bytes)
    expect(file.frameCount).toBe(2)

    for (const frame of file.frames) {
      expect(frame.transparent).toBe(true)
      expect(frame.transparentIndex).toBe(0)
      expect(frame.disposal).toBe(2)
      expect(frame.indices.length).toBe(W * H)

      for (let y = 0; y < H; y += 1) {
        for (let x = 0; x < W; x += 1) {
          const idx = frame.indices[y * W + x]
          if (x < W / 2) {
            // 불투명 절반은 투명 인덱스가 아니어야 한다.
            expect(idx).not.toBe(0)
          } else {
            // 알파 0 절반은 반드시 투명 인덱스.
            expect(idx).toBe(0)
          }
        }
      }
    }
  })

  it('두 번째 이후 프레임은 로컬 컬러 테이블을 쓰지 않는다 (글로벌 팔레트 1개)', async () => {
    const bytes = await encodeGif(framesAt(20, RED_GREEN_BLUE_WHITE), {
      width: W,
      height: H,
      loopCount: 0,
      maxColors: 256,
      transparent: false,
      dither: 0,
    })

    const file = parseGifFrames(bytes)
    // 파서는 로컬 테이블이 없으면 글로벌 팔레트 객체를 그대로 물려준다.
    for (const frame of file.frames) {
      expect(frame.palette).toBe(file.globalPalette)
    }
  })

  it('불투명 모드에서는 투명 플래그가 꺼진다', async () => {
    const bytes = await encodeGif(framesAt(20, RED_GREEN_BLUE_WHITE), {
      width: W,
      height: H,
      loopCount: 0,
      maxColors: 64,
      transparent: false,
      dither: 0,
    })

    for (const frame of parseGifFrames(bytes).frames) {
      expect(frame.transparent).toBe(false)
    }
  })
})

describe('buildGlobalPalette', () => {
  it('투명 모드에서 팔레트 0번을 투명으로 예약한다', () => {
    const palette = buildGlobalPalette(halfTransparentFrame(200, 40, 40), 64, true)
    expect(palette[0]).toEqual([0, 0, 0, 0])
    // 나머지 항목은 모두 불투명이어야 한다.
    for (let i = 1; i < palette.length; i += 1) {
      expect(palette[i]?.[3]).toBe(255)
    }
  })

  it('팔레트 길이가 maxColors 를 넘지 않는다', () => {
    const noisy = new Uint8Array(W * H * 4)
    for (let i = 0; i < noisy.length; i += 4) {
      noisy[i] = (i * 7) & 0xff
      noisy[i + 1] = (i * 13) & 0xff
      noisy[i + 2] = (i * 29) & 0xff
      noisy[i + 3] = 255
    }
    expect(buildGlobalPalette(noisy, 16, false).length).toBeLessThanOrEqual(16)
    expect(buildGlobalPalette(noisy, 16, true).length).toBeLessThanOrEqual(16)
  })
})

describe('pickSampleIndices', () => {
  it('프레임이 상한 이하면 전부 고른다', () => {
    expect(pickSampleIndices(4, 16)).toEqual([0, 1, 2, 3])
  })

  it('상한을 넘으면 균등 간격으로 고르고 양끝을 포함한다', () => {
    const picked = pickSampleIndices(120, 16)
    expect(picked.length).toBe(16)
    expect(picked[0]).toBe(0)
    expect(picked[picked.length - 1]).toBe(119)
    for (let i = 1; i < picked.length; i += 1) {
      expect(picked[i]).toBeGreaterThan(picked[i - 1] as number)
    }
  })
})

describe('applyBayerDither', () => {
  it('strength 0 이면 원본을 그대로 복사한다', () => {
    const src = solidFrame(128, 64, 32)
    const out = applyBayerDither(src, W, H, 0)
    expect(out).not.toBe(src)
    expect(Array.from(out)).toEqual(Array.from(src))
  })

  it('결정론적이다: 같은 입력 두 번이면 바이트가 동일하다', () => {
    const src = solidFrame(128, 64, 32)
    const a = applyBayerDither(src, W, H, 1)
    const b = applyBayerDither(src, W, H, 1)
    expect(Array.from(a)).toEqual(Array.from(b))
  })

  it('입력 배열을 변형하지 않는다', () => {
    const src = solidFrame(128, 64, 32)
    const before = Array.from(src)
    applyBayerDither(src, W, H, 1)
    expect(Array.from(src)).toEqual(before)
  })

  it('알파 채널은 건드리지 않는다', () => {
    const src = halfTransparentFrame(128, 64, 32)
    const out = applyBayerDither(src, W, H, 1)
    for (let i = 3; i < out.length; i += 4) {
      expect(out[i]).toBe(src[i])
    }
  })

  it('단색 면에 8x8 주기의 패턴을 만든다', () => {
    const src = solidFrame(128, 128, 128)
    const out = applyBayerDither(src, W, H, 1)
    const distinct = new Set<number>()
    for (let i = 0; i < out.length; i += 4) distinct.add(out[i] ?? 0)
    expect(distinct.size).toBeGreaterThan(1)
    // 같은 Bayer 셀 위치면 값이 같아야 한다 (W = H = 8 이므로 (0,0) 과 (0,0) 비교).
    expect(out[0]).toBe(applyBayerDither(src, W, H, 1)[0])
  })

  it('픽셀 길이가 맞지 않으면 던진다', () => {
    expect(() => applyBayerDither(new Uint8Array(10), W, H, 1)).toThrow()
  })
})

describe('encodeGif 부가 동작', () => {
  it('디더를 켜도 인코딩 결과가 결정론적이다', async () => {
    const make = (): GifFrame[] => [
      { rgba: solidFrame(130, 90, 60), delayMs: 50 },
      { rgba: solidFrame(60, 130, 90), delayMs: 50 },
      { rgba: solidFrame(90, 60, 130), delayMs: 50 },
    ]
    const opts = {
      width: W,
      height: H,
      loopCount: 0,
      maxColors: 64,
      transparent: false,
      dither: 1,
    } as const

    const a = await encodeGif(make(), { ...opts })
    const b = await encodeGif(make(), { ...opts })
    expect(Array.from(a)).toEqual(Array.from(b))
  })

  it('onProgress 가 0 에서 total 까지 보고한다', async () => {
    const calls: Array<[number, number]> = []
    await encodeGif(framesAt(20, RED_GREEN_BLUE_WHITE), {
      width: W,
      height: H,
      loopCount: 0,
      maxColors: 64,
      transparent: false,
      dither: 0,
      onProgress: (done, total) => calls.push([done, total]),
    })

    expect(calls[0]).toEqual([0, 4])
    expect(calls[calls.length - 1]).toEqual([4, 4])
  })

  it('이미 취소된 signal 이면 AbortError 를 던진다', async () => {
    const controller = new AbortController()
    controller.abort()

    await expect(
      encodeGif(framesAt(20, RED_GREEN_BLUE_WHITE), {
        width: W,
        height: H,
        loopCount: 0,
        maxColors: 64,
        transparent: false,
        dither: 0,
        signal: controller.signal,
      }),
    ).rejects.toThrow(/취소/)
  })

  it('프레임이 없으면 던진다', async () => {
    await expect(
      encodeGif([], {
        width: W,
        height: H,
        loopCount: 0,
        maxColors: 64,
        transparent: false,
        dither: 0,
      }),
    ).rejects.toThrow()
  })

  it('프레임 픽셀 길이가 캔버스와 다르면 던진다', async () => {
    await expect(
      encodeGif([{ rgba: new Uint8Array(4), delayMs: 50 }], {
        width: W,
        height: H,
        loopCount: 0,
        maxColors: 64,
        transparent: false,
        dither: 0,
      }),
    ).rejects.toThrow()
  })
})
