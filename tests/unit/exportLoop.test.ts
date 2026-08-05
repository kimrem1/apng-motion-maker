/**
 * 루프 설정이 파일까지 그대로 전달되는지.
 *
 * mapLoop 단위 테스트가 없어서 "한 번만 재생" GIF 가 무한 반복 파일로 나가는 버그를
 * 아무도 잡지 못했다. 네 모드 전부를 인코더 왕복까지 검사한다.
 */

import { describe, expect, it } from 'vitest'

import { mapLoop, needsStreamingExport, resolveMatte } from '@/export/pipeline.ts'
import { encodeGif, loopCountToRepeat } from '@/export/gif/encoder.ts'
import { parseGifHeader } from '@/export/gif/parse.ts'
import { encodeApng } from '@/export/apng/encoder.ts'
import { parseChunks } from '@/export/apng/chunks.ts'
import { loopSentence } from '@/ui/export/BrowserSupport.tsx'
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
    // 세 채널 모두 '재생 횟수'다. NETSCAPE 의 '추가 반복' 변환은 loopCountToRepeat 이 한다.
    expect(mapLoop(loop({ mode: 'loop', count: 3 }))).toEqual({ apngNumPlays: 3, gifLoopCount: 3, webpLoopCount: 3 })
  })

  it('한 번만 재생은 GIF 에서 1 이다 (-1 이 아니다)', () => {
    // -1 을 넘기면 encodeGif 가 음수를 무한으로 해석해 정반대 파일이 나온다.
    expect(mapLoop(loop({ mode: 'once' }))).toEqual({ apngNumPlays: 1, gifLoopCount: 1, webpLoopCount: 1 })
  })

  it('왕복도 지정한 횟수를 지킨다', () => {
    // 프레임 배열이 이미 2N-2 로 왕복 한 번이므로 count 가 곧 왕복 횟수다.
    expect(mapLoop(loop({ mode: 'pingPong', count: 3 }))).toEqual({
      apngNumPlays: 3,
      gifLoopCount: 3,
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
      gifLoopCount: 2,
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
    // 2회 재생 = NETSCAPE 1. 여기가 null 이면 GIF 만 1회로 깎인 것이다.
    { label: '왕복 2회', spec: loop({ mode: 'pingPong', count: 2 }), gifExpect: 1, apngExpect: 2 },
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

  it('반복 2회가 GIF 에서만 1회로 깎이지 않는다', async () => {
    // 값 1 이 "1회 재생" 과 "2회 재생" 두 뜻을 갖던 시절의 회귀 방지.
    const mapping = mapLoop(loop({ mode: 'loop', count: 2 }))
    expect(mapping.apngNumPlays).toBe(2)
    const gif = await encodeGif(
      [{ rgba: frame(10), delayMs: 50 }, { rgba: frame(200), delayMs: 50 }],
      { width: 4, height: 4, loopCount: mapping.gifLoopCount, maxColors: 8, transparent: false, dither: 0 },
    )
    // NETSCAPE 1 = 첫 재생 + 추가 1회 = 총 2회. null(확장 없음)이면 1회로 끝난다.
    expect(parseGifHeader(gif).loopCount).toBe(1)
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

/**
 * 알파를 못 담는(또는 담지 않기로 한) 출력의 배경색.
 *
 * '투명 배경 유지' 토글의 정책은 두 곳에 있다. 여기(resolveMatte)와 다이얼로그의
 * disabled 조건이다. 둘이 갈리면 눌리기만 하고 아무 효과도 없는 컨트롤이 생긴다.
 * 실제로 WebP 가 그랬다. 형식만 보고 통과시켜 사용자의 선택을 아예 안 읽었다.
 */
describe('투명 배경 유지', () => {
  const doc = { canvas: { background: { matteColor: '#ff8800' } } } as never
  const settings = (format: string, transparent: boolean) =>
    ({ format, transparent } as never)

  it('APNG 는 토글과 무관하게 언제나 알파를 담는다', () => {
    // 다이얼로그도 APNG 에서는 토글을 잠근다. 여기가 그 근거다.
    expect(resolveMatte(doc, settings('apng', true))).toBeNull()
    expect(resolveMatte(doc, settings('apng', false))).toBeNull()
  })

  it('WebP 와 GIF 는 토글을 따른다', () => {
    for (const format of ['webp', 'gif']) {
      expect(resolveMatte(doc, settings(format, true)), format).toBeNull()
      expect(resolveMatte(doc, settings(format, false)), format).toEqual([255, 136, 0])
    }
  })
})

/**
 * 브라우저 진단의 반복 횟수 판정.
 *
 * 두 포맷이 파일에 적는 숫자의 뜻이 다르다. APNG 의 num_plays 는 총 재생 횟수이고,
 * GIF 의 NETSCAPE 값에는 앱이 count-1(추가 반복 횟수)을 적는다. 그래서 "이 브라우저가
 * 앱과 같은 해석을 하는가" 의 기준값이 한 칸 다르다. 예전에는 APNG 기준을 GIF 에도
 * 그대로 써서 정상 동작하는 크롬을 결함으로 보고했다.
 */
describe('반복 횟수 해석 진단', () => {
  const PROBE = 3

  /** 진단 파일에 실제로 기록되는 원시값. 두 포맷 다 PROBE 가 되도록 맞춰 부른다. */
  it('진단 파일에 적히는 값이 두 포맷 모두 PROBE 다', () => {
    // GIF 는 encodeGif 에 PROBE+1 을 넘겨야 NETSCAPE 에 PROBE 가 적힌다.
    expect(loopCountToRepeat(PROBE + 1)).toBe(PROBE)
  })

  it('앱과 같은 해석을 하는 브라우저는 ok 다', () => {
    /*
     * GIF: 앱이 NETSCAPE 에 count-1 을 적으므로, 그 값을 '추가 반복' 으로 읽는
     * 브라우저가 앱과 같은 해석이다. 그러면 repetitionCount 는 적힌 값 그대로다.
     */
    expect(loopSentence('gif', PROBE, PROBE).verdict).toBe('ok')
    // APNG: num_plays 는 총 재생 횟수다. 같은 해석이면 추가 반복은 하나 적다.
    expect(loopSentence('apng', PROBE, PROBE - 1).verdict).toBe('ok')
  })

  it('반대 해석이면 warn 이고 어긋나는 방향을 알려 준다', () => {
    const gif = loopSentence('gif', PROBE, PROBE - 1)
    expect(gif.verdict).toBe('warn')
    expect(gif.headline).toContain('한 번 적게')

    const apng = loopSentence('apng', PROBE, PROBE)
    expect(apng.verdict).toBe('warn')
    expect(apng.headline).toContain('한 번 더')
  })

  it('두 해석 중 어느 쪽도 아니면 판정을 미룬다', () => {
    expect(loopSentence('gif', PROBE, 0).verdict).toBe('unknown')
    expect(loopSentence('apng', PROBE, 9).verdict).toBe('unknown')
    expect(loopSentence('gif', PROBE, Number.POSITIVE_INFINITY).verdict).toBe('warn')
  })

  /** 판정 기준이 실제 인코더 매핑과 어긋나지 않는지 되짚는다. */
  it('사용자가 N번을 고르면 같은 해석의 브라우저에서 정확히 N번 재생된다', () => {
    for (const count of [2, 3, 5]) {
      const mapping = mapLoop(loop({ mode: 'loop', count }))
      // GIF: 적히는 값 + 첫 재생 = N
      expect(loopCountToRepeat(mapping.gifLoopCount) + 1).toBe(count)
      // APNG: 적히는 값이 곧 N
      expect(mapping.apngNumPlays).toBe(count)
    }
  })
})
