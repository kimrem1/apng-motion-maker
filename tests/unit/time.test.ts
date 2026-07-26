import { describe, expect, it } from 'vitest'

import {
  exportFrameIndices,
  fpsToGifCentis,
  isGifExactFps,
  playheadFrame,
  secToFrame,
  snapDurationMs,
} from '@/core/time.ts'

describe('secToFrame', () => {
  it('연속 시간에서 정수 프레임을 유도한다', () => {
    expect(secToFrame(0, 25)).toBe(0)
    expect(secToFrame(0.039, 25)).toBe(0)
    expect(secToFrame(0.04, 25)).toBe(1)
    expect(secToFrame(1, 25)).toBe(25)
  })
})

describe('isGifExactFps', () => {
  it('100/N 인 fps 만 GIF 에서 정확하다', () => {
    expect(isGifExactFps(10)).toBe(true)
    expect(isGifExactFps(12.5)).toBe(true)
    expect(isGifExactFps(20)).toBe(true)
    expect(isGifExactFps(25)).toBe(true)
    expect(isGifExactFps(50)).toBe(true)
    expect(isGifExactFps(24)).toBe(false)
    expect(isGifExactFps(30)).toBe(false)
  })

  it('센티초 변환', () => {
    expect(fpsToGifCentis(25)).toBe(4)
    expect(fpsToGifCentis(20)).toBe(5)
  })
})

describe('snapDurationMs', () => {
  it('프레임 격자에 스냅한다', () => {
    expect(snapDurationMs(1000, 25)).toBeCloseTo(1000, 6)
    // 25fps 에서 한 프레임은 40ms. 1010ms 는 1000ms 로 내려간다.
    expect(snapDurationMs(1010, 25)).toBeCloseTo(1000, 6)
    expect(snapDurationMs(1030, 25)).toBeCloseTo(1040, 6)
  })
})

describe('playheadFrame', () => {
  it('loop 는 durationFrames 로 나머지 연산한다', () => {
    expect(playheadFrame(0, 0, 25, 30, 'loop')).toBe(0)
    expect(playheadFrame(1200, 0, 25, 30, 'loop')).toBe(0) // 30프레임 = 1200ms
    expect(playheadFrame(1240, 0, 25, 30, 'loop')).toBe(1)
  })

  it('once 는 마지막 프레임에서 멈춘다', () => {
    expect(playheadFrame(100000, 0, 25, 30, 'once')).toBe(29)
  })

  it('pingPong 은 2N-2 주기로 왕복한다', () => {
    const fps = 25
    const n = 5 // 주기 8
    const at = (frameCount: number) => playheadFrame((frameCount / fps) * 1000, 0, fps, n, 'pingPong')
    expect([0, 1, 2, 3, 4, 5, 6, 7, 8].map(at)).toEqual([0, 1, 2, 3, 4, 3, 2, 1, 0])
  })

  it('절대 시간 기준이라 누적 드리프트가 없다', () => {
    // 같은 시각을 몇 번 물어봐도 같은 프레임이 나온다
    const a = playheadFrame(3333, 0, 30, 60, 'loop')
    const b = playheadFrame(3333, 0, 30, 60, 'loop')
    expect(a).toBe(b)
  })
})

describe('exportFrameIndices', () => {
  it('loop 는 N 프레임을 그대로 낸다', () => {
    expect(exportFrameIndices(4, 'loop', true)).toEqual([0, 1, 2, 3])
  })

  it('pingPong 은 양끝 중복을 빼고 2N-2 프레임을 낸다', () => {
    const frames = exportFrameIndices(5, 'pingPong', true)
    expect(frames).toEqual([0, 1, 2, 3, 4, 3, 2, 1])
    expect(frames).toHaveLength(2 * 5 - 2)
  })

  it('중복 제거를 끄면 2N 이 된다', () => {
    expect(exportFrameIndices(3, 'pingPong', false)).toHaveLength(6)
  })
})
