/**
 * 루프 설정이 파일까지 그대로 전달되는지.
 *
 * mapLoop 단위 테스트가 없어서 "한 번만 재생" GIF 가 무한 반복 파일로 나가는 버그를
 * 아무도 잡지 못했다. 네 모드 전부를 인코더 왕복까지 검사한다.
 */

import { describe, expect, it } from 'vitest'

import { mapLoop, needsStreamingExport } from '@/export/pipeline.ts'
import { encodeGif } from '@/export/gif/encoder.ts'
import { parseGifHeader } from '@/export/gif/parse.ts'
import { encodeApng } from '@/export/apng/encoder.ts'
import { parseChunks } from '@/export/apng/chunks.ts'
import type { LoopSpec } from '@/core/types.ts'

const loop = (patch: Partial<LoopSpec>): LoopSpec => ({
  mode: 'loop',
  count: 0,
  holdMs: 0,
  dedupeBoundaryFrame: true,
  ...patch,
})

/** 4x4 단색 프레임. 인코더 왕복만 보면 되므로 내용은 중요하지 않다. */
function frame(v: number): Uint8Array {
  const rgba = new Uint8Array(4 * 4 * 4)
  for (let i = 0; i < rgba.length; i += 4) {
    rgba[i] = v
    rgba[i + 1] = 40
    rgba[i + 2] = 200
    rgba[i + 3] = 255
  }
  return rgba
}

function readApngNumPlays(bytes: Uint8Array): number {
  const acTL = parseChunks(bytes).find((c) => c.type === 'acTL')
  if (!acTL) throw new Error('acTL 청크가 없다')
  return new DataView(acTL.data.buffer, acTL.data.byteOffset, acTL.data.byteLength).getUint32(4)
}

describe('mapLoop', () => {
  it('무한 반복', () => {
    expect(mapLoop(loop({ mode: 'loop', count: 0 }))).toEqual({ apngNumPlays: 0, gifLoopCount: 0, webpLoopCount: 0 })
  })

  it('N회 반복', () => {
    // GIF NETSCAPE 는 '추가 반복 횟수'다. 3회 재생 = 추가 2회 (Chrome 실측).
    expect(mapLoop(loop({ mode: 'loop', count: 3 }))).toEqual({ apngNumPlays: 3, gifLoopCount: 2, webpLoopCount: 3 })
  })

  it('한 번만 재생은 GIF 에서 1 이다 (-1 이 아니다)', () => {
    // -1 을 넘기면 encodeGif 가 음수를 무한으로 해석해 정반대 파일이 나온다.
    expect(mapLoop(loop({ mode: 'once' }))).toEqual({ apngNumPlays: 1, gifLoopCount: 1, webpLoopCount: 1 })
  })

  it('왕복도 지정한 횟수를 지킨다', () => {
    // 프레임 배열이 이미 2N-2 로 왕복 한 번이므로 count 가 곧 왕복 횟수다.
    expect(mapLoop(loop({ mode: 'pingPong', count: 3 }))).toEqual({
      apngNumPlays: 3,
      gifLoopCount: 2,
      webpLoopCount: 3,
    })
    expect(mapLoop(loop({ mode: 'pingPong', count: 0 }))).toEqual({
      apngNumPlays: 0,
      gifLoopCount: 0,
      webpLoopCount: 0,
    })
  })

  it('loopWithHold 도 count 를 그대로 쓴다', () => {
    expect(mapLoop(loop({ mode: 'loopWithHold', count: 2 }))).toEqual({
      apngNumPlays: 2,
      gifLoopCount: 1,
      webpLoopCount: 2,
    })
  })
})

describe('루프 왕복 검증 (mapLoop -> 인코더 -> 재파싱)', () => {
  const modes: Array<{ label: string; spec: LoopSpec; gifExpect: number | null; apngExpect: number }> = [
    { label: '무한', spec: loop({ mode: 'loop', count: 0 }), gifExpect: 0, apngExpect: 0 },
    { label: '3회', spec: loop({ mode: 'loop', count: 3 }), gifExpect: 2, apngExpect: 3 },
    // 1회는 NETSCAPE 확장을 아예 쓰지 않는다. 파서가 null 을 돌려주는 것이 정상이다.
    { label: '한 번만', spec: loop({ mode: 'once' }), gifExpect: null, apngExpect: 1 },
    { label: '왕복 2회', spec: loop({ mode: 'pingPong', count: 2 }), gifExpect: null, apngExpect: 2 },
  ]

  for (const m of modes) {
    it(`${m.label}: GIF`, async () => {
      const mapping = mapLoop(m.spec)
      const bytes = await encodeGif(
        [{ rgba: frame(10), delayMs: 50 }, { rgba: frame(200), delayMs: 50 }],
        { width: 4, height: 4, loopCount: mapping.gifLoopCount, maxColors: 8, transparent: false, dither: 0 },
      )
      expect(parseGifHeader(bytes).loopCount).toBe(m.gifExpect)
    })

    it(`${m.label}: APNG`, async () => {
      const mapping = mapLoop(m.spec)
      const bytes = await encodeApng(
        [
          { rgba: frame(10), delayNum: 1, delayDen: 20 },
          { rgba: frame(200), delayNum: 1, delayDen: 20 },
        ],
        { width: 4, height: 4, numPlays: mapping.apngNumPlays },
      )
      expect(readApngNumPlays(bytes)).toBe(m.apngExpect)
    })
  }

  it('같은 설정에서 두 포맷의 재생 횟수가 일치한다', async () => {
    // once 를 GIF 로 내보내면 무한 반복이던 버그가 여기서 잡힌다.
    const mapping = mapLoop(loop({ mode: 'once' }))
    expect(mapping.apngNumPlays).toBe(1)
    const gif = await encodeGif([{ rgba: frame(10), delayMs: 50 }], {
      width: 4, height: 4, loopCount: mapping.gifLoopCount, maxColors: 8, transparent: false, dither: 0,
    })
    // NETSCAPE 확장이 없다 = 1회 재생. 0(무한)이 아니어야 한다.
    expect(parseGifHeader(gif).loopCount).not.toBe(0)
  })
})

describe('메모리 라우팅', () => {
  // 예산을 넘는 설정은 이제 실패가 아니라 스트리밍 경로로 간다.
  it('2048px 왕복 120프레임은 스트리밍으로 간다', () => {
    // 2N-2 = 238프레임 x 2048 x 2048 x 4 = 약 4GB
    expect(needsStreamingExport(238, 2048, 2048)).toBe(true)
  })

  it('1080px 왕복 238프레임(약 1.1GB)도 스트리밍으로 간다', () => {
    // 예전 상한이 막던 대표 사례다. 이제 만들 수 있어야 한다.
    expect(needsStreamingExport(238, 1080, 1080)).toBe(true)
  })

  it('512px 30프레임은 통짜 경로다 (APNG 팔레트 최적화 유지)', () => {
    expect(needsStreamingExport(30, 512, 512)).toBe(false)
  })

  it('1080px 120프레임은 통짜 경로다 (14.A3 상한)', () => {
    expect(needsStreamingExport(120, 1080, 1080)).toBe(false)
  })
})
