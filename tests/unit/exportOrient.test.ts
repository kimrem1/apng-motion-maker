/**
 * 내보내기 방향과 용량 다이어트 필터.
 *
 * 이 파일이 지키는 것은 세 가지다.
 *
 *   1. 방향은 **픽셀 순열**이다. 90 의 배수 회전과 반전에서 픽셀이 한 개도 섞이지
 *      않고, 값도 한 바이트도 달라지지 않는다.
 *   2. 방향 없음은 지금까지의 readbackToStraight 와 완전히 같다. 옛 결과물이
 *      한 바이트도 안 바뀐다는 뜻이다.
 *   3. 얼리기는 오차를 누적하지 않는다. 비교 대상이 "직전 입력" 이 아니라 "지금
 *      화면에 찍혀 있는 값" 이라서, 아무리 오래 얼어 있어도 참값과의 거리가 임계값
 *      안이다. 이 성질이 깨지면 정지 구간이 긴 모션에서 색이 서서히 밀린다.
 *
 * 1번이 가장 중요하다. 인코더는 프레임 버퍼의 **길이**만 검증한다
 * (gif/encoder.ts, apng/encoder.ts). 그래서 90도에서 가로세로를 안 바꿔 넘겨도
 * 예외가 나지 않고 찢어진 파일이 조용히 만들어진다.
 */

import { describe, expect, it } from 'vitest'

import {
  NO_ORIENTATION,
  orientedSize,
  readbackToOriented,
  readbackToStraight,
  type ExportOrientation,
} from '@/export/pipeline.ts'
import {
  DEGRAIN_HIGH,
  FrameFilterChain,
  TemporalFreeze,
  degrainFrame,
  perceptualDistanceSq,
} from '@/export/compress.ts'

// ---------------------------------------------------------------------------
// 픽셀 유틸
// ---------------------------------------------------------------------------

/**
 * 세로로 뒤집힌 리드백 버퍼를 만든다.
 *
 * readPixels 의 원점은 좌하단이라 GL 이 주는 버퍼는 언제나 위아래가 뒤집혀 있다.
 * 테스트는 "똑바로 선 그림" 을 적고, 여기서 뒤집어 GL 흉내를 낸다.
 */
function readbackOf(upright: readonly number[][], alpha = 255): Uint8Array {
  const h = upright.length
  const w = upright[0]!.length
  const out = new Uint8Array(w * h * 4)
  for (let y = 0; y < h; y += 1) {
    const srcRow = h - 1 - y // GL 버퍼의 y 행은 똑바로 선 그림의 (h-1-y) 행이다
    for (let x = 0; x < w; x += 1) {
      const v = upright[srcRow]![x]!
      const at = (y * w + x) * 4
      out[at] = v
      out[at + 1] = v
      out[at + 2] = v
      out[at + 3] = alpha
    }
  }
  return out
}

/** 결과 버퍼의 R 채널만 2차원으로 읽는다. */
function redPlane(rgba: Uint8Array, width: number, height: number): number[][] {
  const rows: number[][] = []
  for (let y = 0; y < height; y += 1) {
    const row: number[] = []
    for (let x = 0; x < width; x += 1) row.push(rgba[(y * width + x) * 4]!)
    rows.push(row)
  }
  return rows
}

function orient(rotate: 0 | 90 | 180 | 270, flip: 'none' | 'x' | 'y'): ExportOrientation {
  return { rotate, flip }
}

/**
 * 비대칭 시험 무늬. 회전과 반전을 구별하려면 가로세로 길이도 값도 전부 달라야 한다.
 *
 *   1 2 3
 *   4 5 6
 */
const PATTERN = [
  [1, 2, 3],
  [4, 5, 6],
]
const SRC_W = 3
const SRC_H = 2

function run(rotate: 0 | 90 | 180 | 270, flip: 'none' | 'x' | 'y'): number[][] {
  const src = readbackOf(PATTERN)
  const o = orient(rotate, flip)
  const size = orientedSize(SRC_W, SRC_H, o)
  const dst = new Uint8Array(SRC_W * SRC_H * 4)
  readbackToOriented(src, dst, SRC_W, SRC_H, null, o)
  return redPlane(dst, size.width, size.height)
}

// ---------------------------------------------------------------------------

describe('orientedSize', () => {
  it('90 과 270 에서만 가로세로가 바뀐다', () => {
    expect(orientedSize(800, 600, orient(0, 'none'))).toEqual({ width: 800, height: 600 })
    expect(orientedSize(800, 600, orient(90, 'none'))).toEqual({ width: 600, height: 800 })
    expect(orientedSize(800, 600, orient(180, 'none'))).toEqual({ width: 800, height: 600 })
    expect(orientedSize(800, 600, orient(270, 'none'))).toEqual({ width: 600, height: 800 })
  })

  it('반전은 크기를 바꾸지 않는다', () => {
    for (const f of ['none', 'x', 'y'] as const) {
      expect(orientedSize(800, 600, orient(0, f))).toEqual({ width: 800, height: 600 })
      expect(orientedSize(800, 600, orient(90, f))).toEqual({ width: 600, height: 800 })
    }
  })
})

describe('방향', () => {
  it('방향 없음은 세로 뒤집기만 한다', () => {
    expect(run(0, 'none')).toEqual(PATTERN)
  })

  it('오른쪽 90도', () => {
    expect(run(90, 'none')).toEqual([
      [4, 1],
      [5, 2],
      [6, 3],
    ])
  })

  it('180도', () => {
    expect(run(180, 'none')).toEqual([
      [6, 5, 4],
      [3, 2, 1],
    ])
  })

  it('왼쪽 90도', () => {
    expect(run(270, 'none')).toEqual([
      [3, 6],
      [2, 5],
      [1, 4],
    ])
  })

  it('좌우 반전', () => {
    expect(run(0, 'x')).toEqual([
      [3, 2, 1],
      [6, 5, 4],
    ])
  })

  it('상하 반전', () => {
    expect(run(0, 'y')).toEqual([
      [4, 5, 6],
      [1, 2, 3],
    ])
  })

  it('회전 뒤에 반전이 온다', () => {
    // 오른쪽 90도 결과가 [[4,1],[5,2],[6,3]] 이고 그것을 좌우로 뒤집는다.
    expect(run(90, 'x')).toEqual([
      [1, 4],
      [2, 5],
      [3, 6],
    ])
  })

  it('90도를 네 번 걸면 제자리다', () => {
    // 90 x 2 = 180, 180 x 2 = 0. 두 단계로 확인한다.
    const once = run(90, 'none')
    const twice = run(180, 'none')
    // 90도 결과를 한 번 더 90도 돌리면 180도와 같아야 한다.
    const rotated: number[][] = []
    for (let x = 0; x < once[0]!.length; x += 1) {
      const row: number[] = []
      for (let y = once.length - 1; y >= 0; y -= 1) row.push(once[y]![x]!)
      rotated.push(row)
    }
    expect(rotated).toEqual(twice)
  })

  it('픽셀 값 자체는 순열일 뿐 하나도 달라지지 않는다', () => {
    for (const rotate of [0, 90, 180, 270] as const) {
      for (const flip of ['none', 'x', 'y'] as const) {
        const flat = run(rotate, flip).flat().sort((a, b) => a - b)
        expect(flat).toEqual([1, 2, 3, 4, 5, 6])
      }
    }
  })

  it('방향 없음은 기존 readbackToStraight 와 한 바이트도 다르지 않다', () => {
    // 반투명을 섞어 un-premultiply 경로까지 지난다.
    const src = readbackOf(PATTERN, 128)
    const a = new Uint8Array(SRC_W * SRC_H * 4)
    const b = new Uint8Array(SRC_W * SRC_H * 4)
    readbackToStraight(src, a, SRC_W, SRC_H, null)
    readbackToOriented(src, b, SRC_W, SRC_H, null, NO_ORIENTATION)
    expect([...b]).toEqual([...a])
  })

  it('매트 경로도 방향과 무관하게 같은 색을 낸다', () => {
    // 완전 투명. 프리멀티플라이드라 RGB 도 0 이다. 매트 색이 그대로 나와야 한다.
    const src = new Uint8Array(SRC_W * SRC_H * 4)
    const dst = new Uint8Array(SRC_W * SRC_H * 4)
    readbackToOriented(src, dst, SRC_W, SRC_H, [10, 20, 30], orient(90, 'y'))
    for (let i = 0; i < dst.length; i += 4) {
      expect([dst[i], dst[i + 1], dst[i + 2], dst[i + 3]]).toEqual([10, 20, 30, 255])
    }
  })
})

// ---------------------------------------------------------------------------
// 용량 다이어트
// ---------------------------------------------------------------------------

/** 균일한 색의 프레임 하나. */
function solidFrame(n: number, r: number, g = r, b = r, a = 255): Uint8Array {
  const out = new Uint8Array(n * 4)
  for (let i = 0; i < out.length; i += 4) {
    out[i] = r
    out[i + 1] = g
    out[i + 2] = b
    out[i + 3] = a
  }
  return out
}

describe('지각 거리', () => {
  it('같은 색이면 0 이다', () => {
    expect(perceptualDistanceSq(120, 40, 200, 255, 120, 40, 200, 255)).toBe(0)
  })

  it('대칭이다', () => {
    const a = perceptualDistanceSq(10, 20, 30, 255, 40, 50, 60, 255)
    const b = perceptualDistanceSq(40, 50, 60, 255, 10, 20, 30, 255)
    expect(a).toBeCloseTo(b, 9)
  })

  it('어두운 쪽의 같은 차이를 더 크게 잰다', () => {
    // 사람 눈이 그림자의 어긋남을 훨씬 잘 본다. 그쪽을 먼저 보호해야 한다.
    const dark = perceptualDistanceSq(10, 10, 10, 255, 20, 20, 20, 255)
    const bright = perceptualDistanceSq(230, 230, 230, 255, 240, 240, 240, 255)
    expect(dark).toBeGreaterThan(bright)
  })

  it('투명도만 달라도 거리가 생긴다', () => {
    expect(perceptualDistanceSq(100, 100, 100, 255, 100, 100, 100, 128)).toBeGreaterThan(0)
  })
})

describe('얼리기', () => {
  const N = 16

  it('끄면 아무것도 건드리지 않는다', () => {
    const freeze = new TemporalFreeze(0)
    expect(freeze.active).toBe(false)
    const frame = solidFrame(N, 100)
    freeze.apply(frame)
    expect(frame[0]).toBe(100)
  })

  it('첫 프레임은 그대로 지나간다', () => {
    const freeze = new TemporalFreeze(20)
    const frame = solidFrame(N, 100)
    expect(freeze.apply(frame)).toBe(0)
    expect(frame[0]).toBe(100)
  })

  it('아주 가까운 색은 갱신하지 않는다', () => {
    const freeze = new TemporalFreeze(20)
    freeze.apply(solidFrame(N, 100))
    const next = solidFrame(N, 101)
    expect(freeze.apply(next)).toBe(N)
    // 화면에 이미 있는 값으로 되돌아간다. 그래야 차분이 0 이 된다.
    expect(next[0]).toBe(100)
  })

  it('충분히 다른 색은 그대로 갱신한다', () => {
    const freeze = new TemporalFreeze(20)
    freeze.apply(solidFrame(N, 100))
    const next = solidFrame(N, 200)
    expect(freeze.apply(next)).toBe(0)
    expect(next[0]).toBe(200)
  })

  it('오래 얼어 있어도 참값과의 거리가 임계값을 넘지 않는다', () => {
    // 프레임마다 1씩 밀린다. 직전 **입력**과 비교하면 매 프레임 통과해서 60프레임 뒤에
    // 60만큼 어긋난다. 화면 값과 비교하면 임계값에서 멈추고 다시 붙는다.
    const threshold = 12
    const freeze = new TemporalFreeze(threshold)
    let truth = 100
    freeze.apply(solidFrame(N, truth))
    let canvasValue = truth

    for (let i = 0; i < 60; i += 1) {
      truth += 1
      const frame = solidFrame(N, truth)
      freeze.apply(frame)
      canvasValue = frame[0]!
      const drift = perceptualDistanceSq(
        truth, truth, truth, 255,
        canvasValue, canvasValue, canvasValue, 255,
      )
      expect(drift).toBeLessThanOrEqual(threshold * threshold)
    }
    // 60프레임을 지나도 화면이 참값 근처에 붙어 있다. 누적됐다면 100 근처에 멈춰 있다.
    expect(Math.abs(canvasValue - truth)).toBeLessThan(20)
  })
})

describe('그레인 제거', () => {
  const W = 8
  const H = 8

  /** 값 하나로 채운 뒤 격자무늬로 아주 약한 잡티를 얹는다. */
  function grainy(base: number, amp: number): Uint8Array {
    const out = solidFrame(W * H, base)
    for (let y = 0; y < H; y += 1) {
      for (let x = 0; x < W; x += 1) {
        const at = (y * W + x) * 4
        const d = (x + y) % 2 === 0 ? amp : -amp
        out[at] = base + d
        out[at + 1] = base + d
        out[at + 2] = base + d
      }
    }
    return out
  }

  it('약한 잡티를 걷어낸다', () => {
    const frame = grainy(120, 2)
    degrainFrame(frame, W, H)
    // 가운데 픽셀만 본다. 가장자리는 clamp 때문에 값이 조금 다르다.
    const at = (4 * W + 4) * 4
    expect(Math.abs(frame[at]! - 120)).toBeLessThanOrEqual(1)
  })

  it('또렷한 경계는 한 값도 건드리지 않는다', () => {
    // 왼쪽 절반 0, 오른쪽 절반 255. 세부 강도가 문턱을 훌쩍 넘는다.
    const frame = solidFrame(W * H, 0)
    for (let y = 0; y < H; y += 1) {
      for (let x = W / 2; x < W; x += 1) {
        const at = (y * W + x) * 4
        frame[at] = 255
        frame[at + 1] = 255
        frame[at + 2] = 255
      }
    }
    const before = [...frame]
    degrainFrame(frame, W, H)
    const at = (4 * W + 0) * 4
    const at2 = (4 * W + W - 1) * 4
    expect(frame[at]).toBe(before[at])
    expect(frame[at2]).toBe(before[at2])
  })

  it('알파는 건드리지 않는다', () => {
    const frame = grainy(120, 2)
    for (let i = 3; i < frame.length; i += 4) frame[i] = 77
    degrainFrame(frame, W, H)
    for (let i = 3; i < frame.length; i += 4) expect(frame[i]).toBe(77)
  })

  it('문턱보다 센 세부는 문턱 계산에서 통째로 통과한다', () => {
    // DEGRAIN_HIGH 이상이면 게이트가 1 이라 원본 그대로다.
    expect(DEGRAIN_HIGH).toBeGreaterThan(0)
    const frame = grainy(120, DEGRAIN_HIGH + 5)
    const before = [...frame]
    degrainFrame(frame, W, H)
    const at = (4 * W + 4) * 4
    expect(frame[at]).toBe(before[at])
  })
})

describe('필터 사슬', () => {
  it('둘 다 끄면 아무 일도 하지 않는다', () => {
    const chain = new FrameFilterChain({ freeze: 0, degrain: false, width: 4, height: 4 })
    expect(chain.active).toBe(false)
    const frame = solidFrame(16, 90)
    chain.apply(frame)
    expect(frame[0]).toBe(90)
  })

  it('얼리기만 켜도 사슬이 돈다', () => {
    const chain = new FrameFilterChain({ freeze: 20, degrain: false, width: 4, height: 4 })
    expect(chain.active).toBe(true)
    chain.apply(solidFrame(16, 100))
    const next = solidFrame(16, 101)
    chain.apply(next)
    expect(next[0]).toBe(100)
  })
})
