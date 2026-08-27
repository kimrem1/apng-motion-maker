/**
 * 목표 용량 맞추기.
 *
 * 여기서 지켜야 하는 계약은 셋이다.
 *   1) 조정 순서가 해상도 -> 프레임 -> 색상 이어야 한다. 순서가 뒤집히면
 *      사용자가 가장 먼저 잃는 것이 "부드러움" 이 되어 결과가 뚝뚝 끊긴다
 *   2) 목표를 못 맞추면 조용히 성공한 척하지 않는다 (achieved=false + 이유)
 *   3) 이미 목표 안이면 아무것도 건드리지 않는다. 이유 없이 품질을 깎지 않는다
 *
 * 실제 인코딩 대신 measure 를 주입한다. 픽셀 수 x 프레임 수 x 색상 계수의
 * 단순 모델이면 사다리 탐색 로직을 검사하는 데 충분하다.
 */

import { describe, expect, it } from 'vitest'

import { GIF_COLOR_CHOICES } from '@/core/types.ts'
import { MAX_COLOR_CHOICES } from '@/ui/export/exportSettings.ts'
import type { ExportSettings } from '@/export/pipeline.ts'
import {
  buildSizeLadder,
  DEFAULT_MAX_ATTEMPTS,
  MAX_LADDER_RUNGS,
  planForTargetSize,
  type SizeCandidate,
  type SizeMeasure,
} from '@/export/targetSize.ts'

function settings(patch: Partial<ExportSettings> = {}): ExportSettings {
  return {
    format: 'gif',
    width: 512,
    height: 512,
    maxColors: 256,
    transparent: true,
    dither: 1,
    quality: 0.82,
    lossless: false,
    rotate: 0,
    flip: 'none',
    freeze: 0,
    degrain: false,
    ...patch,
  }
}

function baseCandidate(patch: Partial<ExportSettings> = {}): SizeCandidate {
  return { settings: settings(patch), durationFrames: 60, fps: 30 }
}

/**
 * 바이트 모델. 면적 x 프레임 수 x 색상 계수 x 디더 계수.
 * 실제 인코더의 거동을 흉내 내는 것이 아니라 **단조 감소**만 보장하면 된다.
 */
function fakeMeasure(bytesPerUnit = 1): SizeMeasure {
  return async (c: SizeCandidate) => {
    const area = c.settings.width * c.settings.height
    const colorFactor = Math.log2(Math.max(2, c.settings.maxColors)) / 8
    const ditherFactor = 1 + c.settings.dither * 0.15
    return area * c.durationFrames * colorFactor * ditherFactor * bytesPerUnit
  }
}

/** 사다리 칸이 base 대비 어떤 축을 건드렸는지. */
function touched(base: SizeCandidate, c: SizeCandidate) {
  return {
    freeze: c.settings.freeze !== base.settings.freeze,
    width: c.settings.width !== base.settings.width,
    frames: c.fps !== base.fps || c.durationFrames !== base.durationFrames,
    quality: c.settings.quality !== base.settings.quality,
    colors: c.settings.maxColors !== base.settings.maxColors,
    dither: c.settings.dither !== base.settings.dither,
  }
}

describe('buildSizeLadder 조정 순서', () => {
  it('얼리기를 먼저 걸고, 그다음 해상도, 프레임, 색상, 마지막이 디더다', () => {
    const base = baseCandidate()
    const ladder = buildSizeLadder(base)

    expect(ladder.length).toBeGreaterThan(0)
    expect(ladder.length).toBeLessThanOrEqual(MAX_LADDER_RUNGS)

    // 각 축이 처음 등장하는 칸 번호
    const firstIndex = (key: 'freeze' | 'width' | 'frames' | 'colors' | 'dither'): number =>
      ladder.findIndex((c) => touched(base, c)[key])

    const freeze = firstIndex('freeze')
    const width = firstIndex('width')
    const frames = firstIndex('frames')
    const colors = firstIndex('colors')
    const dither = firstIndex('dither')

    // 얼리기가 맨 앞이다. 해상도도 프레임도 색상도 그대로 두는 유일한 축이다.
    expect(freeze).toBe(0)
    expect(width).toBeGreaterThan(freeze)
    expect(frames).toBeGreaterThan(width)
    expect(colors).toBeGreaterThan(frames)
    expect(dither).toBeGreaterThan(colors)
  })

  it('프레임을 건드리는 칸은 이미 해상도를 줄인 뒤다', () => {
    const base = baseCandidate()
    for (const rung of buildSizeLadder(base)) {
      const t = touched(base, rung)
      if (t.width) expect(t.freeze).toBe(true)
      if (t.frames) expect(t.width).toBe(true)
      if (t.colors) expect(t.frames).toBe(true)
      if (t.dither) expect(t.colors).toBe(true)
    }
  })

  it('WebP 는 색상 대신 화질 칸을 만든다', () => {
    const base = baseCandidate({ format: 'webp' })
    const ladder = buildSizeLadder(base)
    expect(ladder.some((c) => c.settings.quality < base.settings.quality)).toBe(true)
    for (const rung of ladder) {
      expect(rung.settings.maxColors).toBe(base.settings.maxColors)
      const t = touched(base, rung)
      if (t.quality) expect(t.frames).toBe(true)
    }
  })

  it('무손실 WebP 에는 화질 칸을 만들지 않는다', () => {
    const base = baseCandidate({ format: 'webp', lossless: true })
    for (const rung of buildSizeLadder(base)) {
      expect(rung.settings.quality).toBe(base.settings.quality)
    }
  })

  it('이미 센 얼리기를 골라 뒀으면 그 칸을 만들지 않는다', () => {
    const base = baseCandidate({ freeze: 40 })
    for (const rung of buildSizeLadder(base)) {
      expect(rung.settings.freeze).toBe(40)
    }
  })

  it('종횡비를 유지하고 하한 아래로 내려가지 않는다', () => {
    const base = { settings: settings({ width: 400, height: 200 }), durationFrames: 30, fps: 25 }
    for (const rung of buildSizeLadder(base, { minWidth: 200 })) {
      expect(rung.settings.width).toBeGreaterThanOrEqual(200)
      expect(rung.settings.height).toBe(Math.round(rung.settings.width / 2))
    }
  })

  it('fps 를 내려도 벽시계 길이를 유지한다', () => {
    const base = baseCandidate() // 60프레임 / 30fps = 2초
    const lowered = buildSizeLadder(base).filter((c) => c.fps !== base.fps)
    for (const rung of lowered) {
      expect(rung.durationFrames / rung.fps).toBeCloseTo(2, 5)
    }
  })

  it('APNG 는 팔레트 노브가 없으므로 색상/디더 칸을 만들지 않는다', () => {
    const base = baseCandidate({ format: 'apng' })
    for (const rung of buildSizeLadder(base)) {
      expect(rung.settings.maxColors).toBe(base.settings.maxColors)
      expect(rung.settings.dither).toBe(base.settings.dither)
    }
  })
})

describe('planForTargetSize', () => {
  it('이미 목표 안이면 아무것도 바꾸지 않는다', async () => {
    const base = baseCandidate()
    const measure = fakeMeasure()
    const current = await measure(base)

    const plan = await planForTargetSize({
      ...base,
      target: { maxBytes: current * 2 },
      measure,
    })

    expect(plan.achieved).toBe(true)
    expect(plan.changes).toEqual([])
    expect(plan.settings).toEqual(base.settings)
    expect(plan.fps).toBe(base.fps)
    expect(plan.durationFrames).toBe(base.durationFrames)
    // 확인 1회로 끝난다. 줄일 필요가 없으니 더 인코딩하지 않는다.
    expect(plan.attempts).toBe(1)
  })

  it('조금 넘치면 해상도만 줄인다', async () => {
    const base = baseCandidate()
    const measure = fakeMeasure()
    const current = await measure(base)

    const plan = await planForTargetSize({
      ...base,
      target: { maxBytes: current * 0.8 },
      measure,
    })

    expect(plan.achieved).toBe(true)
    const t = touched(base, plan)
    expect(t.width).toBe(true)
    expect(t.frames).toBe(false)
    expect(t.colors).toBe(false)
    expect(plan.changes.some((line) => line.includes('px'))).toBe(true)
  })

  it('많이 넘치면 해상도에 이어 프레임까지 줄인다', async () => {
    const base = baseCandidate()
    const measure = fakeMeasure()
    const current = await measure(base)

    const plan = await planForTargetSize({
      ...base,
      target: { maxBytes: current * 0.12 },
      measure,
    })

    expect(plan.achieved).toBe(true)
    const t = touched(base, plan)
    expect(t.width).toBe(true)
    expect(t.frames).toBe(true)
    expect(t.colors).toBe(false)
    // 무엇을 얼마나 희생했는지 반드시 남긴다
    expect(plan.changes.some((line) => line.includes('fps'))).toBe(true)
  })

  it('목표를 못 맞추면 achieved=false 이고 changes 가 비어 있지 않다', async () => {
    const base = baseCandidate()
    const plan = await planForTargetSize({
      ...base,
      target: { maxBytes: 10 }, // 어떤 설정으로도 불가능
      measure: fakeMeasure(),
    })

    expect(plan.achieved).toBe(false)
    expect(plan.changes.length).toBeGreaterThan(0)
    expect(plan.changes.at(-1)).toContain('맞추지 못했습니다')
    // 돌려주는 estimatedBytes 는 실제로 측정한 값이어야 한다.
    expect(plan.estimatedBytes).toBeGreaterThan(10)
  })

  it('줄일 여지가 전혀 없어도 이유를 남긴다', async () => {
    // 이미 하한이라 사다리가 비는 경우
    const base: SizeCandidate = {
      // 얼리기까지 이미 상한이라 어느 축으로도 더 갈 곳이 없다.
      settings: settings({ format: 'apng', width: 96, height: 96, freeze: 40 }),
      durationFrames: 20,
      fps: 10,
    }
    const plan = await planForTargetSize({
      ...base,
      target: { maxBytes: 1 },
      measure: fakeMeasure(),
      limits: { minWidth: 96, minFps: 10 },
    })

    expect(buildSizeLadder(base, { minWidth: 96, minFps: 10 })).toHaveLength(0)
    expect(plan.achieved).toBe(false)
    expect(plan.changes.length).toBeGreaterThan(0)
    expect(plan.settings).toEqual(base.settings)
  })

  it('실제 인코딩 횟수를 5회 이하로 제한한다', async () => {
    const base = baseCandidate()
    let calls = 0
    const inner = fakeMeasure()
    const measure: SizeMeasure = async (c) => {
      calls += 1
      return inner(c)
    }

    const plan = await planForTargetSize({
      ...base,
      target: { maxBytes: 10 },
      measure,
    })

    expect(calls).toBe(plan.attempts)
    expect(calls).toBeLessThanOrEqual(DEFAULT_MAX_ATTEMPTS)
  })

  it('maxAttempts 를 낮추면 그만큼만 시도한다', async () => {
    const base = baseCandidate()
    let calls = 0
    const inner = fakeMeasure()
    const measure: SizeMeasure = async (c) => {
      calls += 1
      return inner(c)
    }

    await planForTargetSize({
      ...base,
      target: { maxBytes: 10 },
      measure,
      limits: { maxAttempts: 2 },
    })

    expect(calls).toBe(2)
  })

  it('찾아낸 안은 사다리에서 가장 앞칸, 즉 희생이 가장 적은 칸이다', async () => {
    const base = baseCandidate()
    const measure = fakeMeasure()
    const ladder = buildSizeLadder(base)
    const target = { maxBytes: await measure(ladder[3]!) }

    const plan = await planForTargetSize({ ...base, target, measure })

    expect(plan.achieved).toBe(true)
    // 3번 칸이 정확히 목표와 같으므로 그보다 앞칸은 전부 초과다.
    expect(plan.settings.width).toBe(ladder[3]!.settings.width)
    expect(plan.fps).toBe(ladder[3]!.fps)
  })

  it('취소 신호가 오면 AbortError 로 끝난다', async () => {
    const base = baseCandidate()
    const controller = new AbortController()
    controller.abort()

    await expect(
      planForTargetSize({
        ...base,
        target: { maxBytes: 10 },
        measure: fakeMeasure(),
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' })
  })
})

/**
 * 용량 맞추기가 만드는 설정은 **화면에서 다시 고를 수 있어야 한다.**
 *
 * 사다리와 셀렉트가 허용 색상 수를 각자 들고 있었다. 사다리는 32 까지 내려가는데
 * 셀렉트 하한은 64 라, 용량을 맞춘 뒤 설정으로 돌아오면 색상 칸이 빈 값이 됐다.
 * 사용자는 그 값을 UI 로 되돌릴 수 없었다.
 */
describe('용량 맞추기 결과와 화면 선택지', () => {
  it('색상 사다리의 모든 칸이 화면 선택지 안에 있다', () => {
    for (const colors of GIF_COLOR_CHOICES) {
      expect(MAX_COLOR_CHOICES as readonly number[]).toContain(colors)
    }
  })

  it('사다리가 내는 색상 수가 전부 화면 선택지 안이다', () => {
    const rungs = buildSizeLadder(baseCandidate({ format: 'gif', maxColors: 256 }))
    const seen = new Set<number>()
    for (const rung of rungs) {
      const colors = rung.settings.maxColors
      if (typeof colors !== 'number') continue
      seen.add(colors)
      expect(MAX_COLOR_CHOICES as readonly number[], `${colors}색`).toContain(colors)
    }
    // 사다리가 실제로 색상을 내려 보긴 하는지도 확인한다. 안 그러면 검사가 공허하다.
    expect(seen.size).toBeGreaterThan(1)
  })
})
