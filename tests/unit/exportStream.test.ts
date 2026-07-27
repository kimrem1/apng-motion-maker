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
import { ESTIMATE_SAMPLE_COUNT, estimateSampleCount } from '@/export/estimate.ts'
import {
  GifStreamEncoder,
  buildPaletteFromFrames,
  encodeGif,
  pickSampleIndices,
  SAMPLE_FRAME_MAX,
} from '@/export/gif/encoder.ts'
import { paletteSampleCount } from '@/export/pipeline.ts'

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

  /*
   * drain 은 큰 파일에서 JS 힙을 지키는 장치다. 조각을 중간에 빼내도 이어붙인
   * 결과가 한 번에 만든 파일과 **바이트 단위로 같아야** 한다. 여기가 어긋나면
   * "700MB 를 넘는 내보내기만 파일이 깨진다" 는 최악의 버그가 된다.
   */
  it('drain 으로 흘려보낸 조각을 이어붙이면 finish 와 같다', async () => {
    const whole = await encodeApng(
      frames.map((rgba) => ({ rgba, delayNum: 1, delayDen: 25 })),
      { width: W, height: H, numPlays: 0, palette: false },
    )

    const stream = new ApngStreamEncoder(
      { width: W, height: H, numPlays: 0, frameCount: frames.length },
      null,
    )
    const parts: Uint8Array[] = []
    for (const rgba of frames) {
      await stream.addFrame({ rgba, delayNum: 1, delayDen: 25 })
      // 파이프라인이 프레임마다 하는 것과 같다.
      parts.push(...stream.drain())
    }
    parts.push(...stream.finishParts())

    const total = parts.reduce((n, p) => n + p.length, 0)
    const joined = new Uint8Array(total)
    let at = 0
    for (const p of parts) {
      joined.set(p, at)
      at += p.length
    }

    expect(joined).toEqual(whole)
  })

  it('drain 을 쓴 세션에서 finish 를 부르면 던진다', async () => {
    // 막지 않으면 앞부분이 빠진 파일이 조용히 나온다.
    const stream = new ApngStreamEncoder(
      { width: W, height: H, numPlays: 0, frameCount: 1 },
      null,
    )
    await stream.addFrame({ rgba: frame(0), delayNum: 1, delayDen: 25 })
    stream.drain()
    expect(() => stream.finish()).toThrow(/finishParts/)
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

// ---------------------------------------------------------------------------
// 표본 예산
// ---------------------------------------------------------------------------

/*
 * 4000px 상한을 열면서 생긴 자리다.
 *
 * GIF 팔레트는 대표 프레임을 이어붙인 버퍼에서 만든다. 장수를 16 으로 고정해
 * 두면 4000x4000 에서 표본만 1GB, 이어붙인 버퍼가 다시 1GB 다. 스트리밍으로
 * 아낀 메모리를 팔레트 준비 단계에서 그대로 토해 낸다.
 * 용량 추정도 같은 이유로 표본을 들고 있으므로 같은 규칙을 쓴다.
 */
describe('표본 장수 예산', () => {
  it('작은 캔버스에서는 최대 장수를 그대로 쓴다', () => {
    expect(paletteSampleCount(512, 512)).toBe(SAMPLE_FRAME_MAX)
    expect(estimateSampleCount(512, 512)).toBe(ESTIMATE_SAMPLE_COUNT)
  })

  it('4000px 에서는 장수를 줄인다', () => {
    expect(paletteSampleCount(4000, 4000)).toBeLessThan(SAMPLE_FRAME_MAX)
    expect(estimateSampleCount(4000, 4000)).toBeLessThan(ESTIMATE_SAMPLE_COUNT)
  })

  it('아무리 커도 2장 아래로는 내려가지 않는다', () => {
    // 1장이면 팔레트가 첫 프레임 하나로 정해지고, 추정은 프레임 간 차분을
    // 표본에서 볼 수 없게 된다. 둘 다 결과가 무의미해진다.
    expect(paletteSampleCount(100000, 100000)).toBe(2)
    expect(estimateSampleCount(100000, 100000)).toBe(2)
  })

  it('예산이 커질수록 장수가 줄지 않는다 (단조)', () => {
    let prev = SAMPLE_FRAME_MAX
    for (const side of [256, 512, 1024, 2048, 3000, 4000]) {
      const n = paletteSampleCount(side, side)
      expect(n).toBeLessThanOrEqual(prev)
      prev = n
    }
  })
})
