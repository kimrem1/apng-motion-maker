/**
 * 내보내기 크기와 캔버스 비율.
 *
 * 렌더러는 정점을 doc.canvas 픽셀로 만들고 그 결과를 settings.width x height 뷰포트에
 * 담는다. 두 비율이 어긋나면 그림이 그만큼 늘어난다. 대화상자가 닫혀 있어도 마운트된
 * 채라 `사용자 지정` 크기가 앱을 켠 순간의 캔버스로 굳는 사고가 실제로 있었다.
 */

import { describe, expect, it } from 'vitest'

import type { ExportSettings } from '@/export/pipeline.ts'
import {
  EXPORT_PURPOSES,
  fitSettingsToCanvas,
  fitWithin,
  settingsForPurpose,
} from '@/ui/export/exportSettings.ts'

function base(width: number, height: number): ExportSettings {
  return {
    format: 'apng',
    width,
    height,
    maxColors: 256,
    transparent: true,
    dither: 0,
    quality: 0.9,
    lossless: false,
    rotate: 0,
    flip: 'none',
    freeze: 0,
    degrain: false,
  }
}

const ratio = (s: { width: number; height: number }): number => s.width / s.height

describe('fitSettingsToCanvas', () => {
  it('캔버스 비율이 바뀌면 크기를 다시 맞춘다', () => {
    // 정사각 캔버스에서 잡아 둔 512x512 설정. 그 뒤 캔버스가 1000x600 이 되었다.
    const stale = base(512, 512)
    const fixed = fitSettingsToCanvas(stale, 1000, 600)

    expect(ratio(fixed)).toBeCloseTo(1000 / 600, 2)
    // 긴 변은 사용자가 고른 512 그대로다.
    expect(Math.max(fixed.width, fixed.height)).toBe(512)
  })

  it('비율이 이미 맞으면 같은 객체를 돌려준다', () => {
    const ok = base(512, 307)
    expect(fitSettingsToCanvas(ok, 1000, 600)).toBe(ok)
  })

  it('포맷과 색 설정은 건드리지 않는다', () => {
    const stale: ExportSettings = { ...base(400, 400), format: 'gif', maxColors: 64, dither: 0.5 }
    const fixed = fitSettingsToCanvas(stale, 800, 400)
    expect(fixed.format).toBe('gif')
    expect(fixed.maxColors).toBe(64)
    expect(fixed.dither).toBe(0.5)
  })

  it('캔버스보다 큰 긴 변은 확대하지 않는다', () => {
    // fitWithin 의 기존 규칙이다. 원본보다 크게 뽑지 않는다.
    const big = base(4000, 4000)
    const fixed = fitSettingsToCanvas(big, 300, 200)
    expect(fixed).toMatchObject({ width: 300, height: 200 })
  })

  it('망가진 값에는 손대지 않는다', () => {
    const broken = base(0, 0)
    expect(fitSettingsToCanvas(broken, 800, 600)).toBe(broken)
  })

  it('모든 용도 프리셋이 캔버스 비율을 지킨다', () => {
    for (const purpose of EXPORT_PURPOSES) {
      const s = settingsForPurpose(purpose, 1600, 900)
      // 반올림 오차만 허용한다.
      expect(Math.abs(ratio(s) - 16 / 9)).toBeLessThan(0.01)
    }
  })
})

describe('fitWithin', () => {
  it('긴 변을 상한에 맞추고 비율을 지킨다', () => {
    expect(fitWithin(1000, 500, 512)).toEqual({ width: 512, height: 256 })
    expect(fitWithin(500, 1000, 512)).toEqual({ width: 256, height: 512 })
  })
})
