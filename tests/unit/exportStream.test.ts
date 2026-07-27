/**
 * 스트리밍 인코딩 등가성.
 *
 * 통짜 경로(encodeApng / encodeGif)는 세션 인코더 위의 래퍼다. 이 계약이 깨지면
 * "예산을 넘는 큰 파일에서만 픽셀이 다르다" 는 재현하기 힘든 버그가 된다.
 * 그래서 같은 입력에 대해 두 경로의 **바이트가 완전히 같은지**를 검사한다.
 *
 * WebP 세션은 OffscreenCanvas 가 필요해 Node 에서 돌릴 수 없다.
 * 순수 먹싱(muxAnimatedWebp)은 webp.test.ts 가 검사한다.
 */

import { describe, expect, it } from 'vitest'

import { ApngStreamEncoder, encodeApng } from '@/export/apng/encoder.ts'
import {
  GifStreamEncoder,
  buildPaletteFromFrames,
  encodeGif,
  pickSampleIndices,
  SAMPLE_FRAME_MAX,
} from '@/export/gif/encoder.ts'

const W = 8
const H = 6

/** 프레임마다 조금씩 다른 그러데이션. 차분 사각형과 팔레트 경로를 모두 태운다. */
function frame(seed: number): Uint8Array {
  const rgba = new Uint8Array(W * H * 4)
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const p = (y * W + x) * 4
      rgba[p] = (x * 30 + seed * 40) % 256
      rgba[p + 1] = (y * 40) % 256
      rgba[p + 2] = 128
      rgba[p + 3] = x === 0 ? 0 : 255 // 투명 픽셀도 섞는다
    }
  }
  return rgba
}

const frames = [frame(0), frame(1), frame(1), frame(2)] // 정지 구간(중복 프레임) 포함

describe('APNG 스트리밍 등가성', () => {
  it('세션 경로가 encodeApng(palette:false) 와 바이트 단위로 같다', async () => {
    const whole = await encodeApng(
      frames.map((rgba) => ({ rgba, delayNum: 1, delayDen: 25 })),
      { width: W, height: H, numPlays: 0, palette: false },
    )

    const stream = new ApngStreamEncoder(
      { width: W, height: H, numPlays: 0, frameCount: frames.length },
      null,
    )
    for (const rgba of frames) {
      await stream.addFrame({ rgba, delayNum: 1, delayDen: 25 })
    }
    const streamed = stream.finish()

    expect(streamed).toEqual(whole)
  })

  it('선언한 프레임 수보다 모자라면 finish 가 던진다', async () => {
    const stream = new ApngStreamEncoder(
      { width: W, height: H, numPlays: 0, frameCount: 3 },
      null,
    )
    await stream.addFrame({ rgba: frame(0), delayNum: 1, delayDen: 25 })
    expect(() => stream.finish()).toThrow(/모자란다/)
  })

  it('선언한 프레임 수보다 많이 넣으면 addFrame 이 던진다', async () => {
    const stream = new ApngStreamEncoder(
      { width: W, height: H, numPlays: 0, frameCount: 1 },
      null,
    )
    await stream.addFrame({ rgba: frame(0), delayNum: 1, delayDen: 25 })
    await expect(
      stream.addFrame({ rgba: frame(1), delayNum: 1, delayDen: 25 }),
    ).rejects.toThrow(/많이/)
  })
})

describe('GIF 스트리밍 등가성', () => {
  for (const transparent of [false, true]) {
    it(`세션 경로가 encodeGif 와 바이트 단위로 같다 (transparent=${transparent})`, async () => {
      const opts = {
        width: W,
        height: H,
        loopCount: 0,
        maxColors: 64,
        transparent,
        dither: 0.5,
      }
      const whole = await encodeGif(
        frames.map((rgba) => ({ rgba, delayMs: 40 })),
        opts,
      )

      // 스트리밍 경로가 하는 것과 똑같이: 대표 프레임으로 팔레트를 먼저 만든다.
      const sampleIndices = pickSampleIndices(frames.length, SAMPLE_FRAME_MAX)
      const palette = buildPaletteFromFrames(
        sampleIndices.map((i) => frames[i]!),
        opts,
      )
      const stream = new GifStreamEncoder(
        { width: W, height: H, loopCount: 0, transparent, dither: 0.5 },
        palette,
      )
      for (const rgba of frames) {
        await stream.addFrame({ rgba, delayMs: 40 })
      }
      const streamed = stream.finish()

      expect(streamed).toEqual(whole)
    })
  }

  it('프레임 없이 finish 하면 던진다', () => {
    const palette = buildPaletteFromFrames([frame(0)], {
      width: W, height: H, maxColors: 16, transparent: false, dither: 0,
    })
    const stream = new GifStreamEncoder(
      { width: W, height: H, loopCount: 0, transparent: false, dither: 0 },
      palette,
    )
    expect(() => stream.finish()).toThrow(/하나도 없다/)
  })
})
