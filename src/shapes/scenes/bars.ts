/**
 * 소리 그래프.
 *
 * 음악 플레이어의 막대처럼 여러 개가 시간차를 두고 오르내린다. 막대마다 최대 높이와
 * 주기와 위상을 다르게 주는 것이 전부다. 셋이 모두 같으면 파도가 아니라 벽이 된다.
 *
 * 막대는 **아래에서 자란다.** 기준점을 [0.5, 1] 로 두면 크기 변화가 아래 모서리를
 * 축으로 돈다. 기준점은 축일 뿐이라 그림이 놓이는 자리는 그대로다(core/transform.ts).
 */

import { createShapeSpec, withAlpha } from '@/core/shape.ts'
import type { SceneLayer, ShapeScene } from '../types.ts'
import { atRatio, clamp, cycle, fixed, gain, pick, slot, timingOf, wave } from '../shared.ts'

/** 막대마다 다른 최대 높이. 표를 순환해서 쓴다. */
const HEIGHTS = [0.62, 1, 0.45, 0.85, 0.55, 0.95, 0.5, 0.75]
/** 막대마다 다른 출발 위상. 규칙적이면 파도가 기계처럼 보인다. */
const PHASES = [0, 0.42, 0.17, 0.68, 0.31, 0.86, 0.55, 0.09]
/** 한 주기 안에서 몇 번 오르내리는가. 정수여야 이음새가 닫힌다. */
const BEATS = [1, 2, 1, 2, 3, 1, 2, 1]

export const BARS_SCENES: ShapeScene[] = [
  {
    id: 'bars.equalizer',
    label: '음악 막대',
    hint: '막대들이 음악에 맞춰 오르내리듯 움직입니다.',
    group: 'bars',
    defaultDurationMs: 1600,
    emit(ctx) {
      const { span, fps } = timingOf(ctx, this.defaultDurationMs)
      const g = gain(ctx.strength)
      const count = 7
      const barW = Math.max(4, Math.round((ctx.canvasW * 0.66) / count / 1.9))
      const barH = Math.max(8, Math.round(ctx.canvasH * 0.42))
      // 막대 아래 모서리가 이 높이에 오도록 중심을 올린다.
      const baseline = 0.78
      const centerY = baseline - barH / ctx.canvasH / 2

      const layers: SceneLayer[] = []
      for (let i = 0; i < count; i += 1) {
        const top = pick(HEIGHTS, i, 0.6)
        const beats = Math.max(1, Math.round(pick(BEATS, i, 1)))
        layers.push({
          name: `막대 ${i + 1}`,
          anchor: [0.5, 1],
          shape: createShapeSpec('rect', {
            color: withAlpha(ctx.color, 1),
            width: barW,
            height: barH,
            cornerRadius: Math.round(barW * 0.35),
          }),
          tracks: [
            fixed('translateX', 'percentOfCanvas', slot(i, count, 0.66) * 100),
            fixed('translateY', 'percentOfCanvas', atRatio(centerY)),
            cycle({
              prop: 'scaleY',
              unit: 'ratio',
              span,
              phase: pick(PHASES, i, 0),
              at: (x) => clamp(0.12 + top * g * (0.5 + 0.5 * wave(x * beats)), 0.04, 2.2),
              steps: 16,
            }),
          ],
        })
      }
      return { layers, durationFrames: span, loopMode: 'loop', fps }
    },
  },

  {
    id: 'bars.mirror',
    label: '대칭 파형',
    hint: '가운데 선을 기준으로 위아래가 함께 자라납니다.',
    group: 'bars',
    defaultDurationMs: 1800,
    emit(ctx) {
      const { span, fps } = timingOf(ctx, this.defaultDurationMs)
      const g = gain(ctx.strength)
      const count = 9
      const barW = Math.max(3, Math.round((ctx.canvasW * 0.74) / count / 2.1))
      const barH = Math.max(8, Math.round(ctx.canvasH * 0.4))

      const layers: SceneLayer[] = []
      for (let i = 0; i < count; i += 1) {
        // 가운데가 가장 크고 바깥으로 갈수록 낮아지는 종 모양 포락선.
        const fromCenter = Math.abs(i - (count - 1) / 2) / ((count - 1) / 2)
        const top = 0.35 + 0.65 * (1 - fromCenter * fromCenter)
        layers.push({
          name: `파형 ${i + 1}`,
          shape: createShapeSpec('rect', {
            color: withAlpha(ctx.color, 1),
            width: barW,
            height: barH,
            cornerRadius: Math.round(barW * 0.5),
          }),
          tracks: [
            fixed('translateX', 'percentOfCanvas', slot(i, count, 0.74) * 100),
            cycle({
              prop: 'scaleY',
              unit: 'ratio',
              span,
              phase: i / count,
              at: (x) => clamp(0.1 + top * g * (0.5 + 0.5 * wave(x)), 0.04, 2.2),
              steps: 16,
            }),
          ],
        })
      }
      return { layers, durationFrames: span, loopMode: 'loop', fps }
    },
  },

  {
    id: 'bars.wave',
    label: '물결 점',
    hint: '점들이 물결처럼 차례로 오르내립니다.',
    group: 'bars',
    defaultDurationMs: 1800,
    emit(ctx) {
      const { span, fps } = timingOf(ctx, this.defaultDurationMs)
      const g = gain(ctx.strength)
      const count = 9
      const dot = Math.max(4, Math.round((ctx.canvasW * 0.7) / count / 2.4))
      const amp = 12 * g

      const layers: SceneLayer[] = []
      for (let i = 0; i < count; i += 1) {
        const phase = i / count
        layers.push({
          name: `점 ${i + 1}`,
          shape: createShapeSpec('circle', {
            color: withAlpha(ctx.color, 1),
            width: dot,
            height: dot,
          }),
          tracks: [
            fixed('translateX', 'percentOfCanvas', slot(i, count, 0.7) * 100),
            cycle({
              prop: 'translateY',
              unit: 'percentOfCanvas',
              span,
              phase,
              at: (x) => wave(x) * amp,
              steps: 16,
            }),
            cycle({
              prop: 'opacity',
              unit: 'ratio',
              span,
              phase,
              at: (x) => 0.55 + 0.45 * (0.5 + 0.5 * wave(x)),
            }),
          ],
        })
      }
      return { layers, durationFrames: span, loopMode: 'loop', fps }
    },
  },

  {
    id: 'bars.loading',
    label: '기다리는 점',
    hint: '점 세 개가 차례로 부풀었다 가라앉습니다.',
    group: 'bars',
    defaultDurationMs: 1200,
    emit(ctx) {
      const { span, fps } = timingOf(ctx, this.defaultDurationMs)
      const g = gain(ctx.strength)
      const base = Math.min(ctx.canvasW, ctx.canvasH)
      const dot = Math.max(4, Math.round(base * 0.1))
      const count = 3

      const layers: SceneLayer[] = []
      for (let i = 0; i < count; i += 1) {
        const phase = i / count
        layers.push({
          name: `기다림 ${i + 1}`,
          shape: createShapeSpec('circle', {
            color: withAlpha(ctx.color, 1),
            width: dot,
            height: dot,
          }),
          tracks: [
            fixed('translateX', 'percentOfCanvas', slot(i, count, 0.34) * 100),
            cycle({
              prop: 'scale',
              unit: 'ratio',
              span,
              phase,
              // 한 점이 부풀어 있는 동안 나머지는 작게 눌려 있다.
              at: (x) => clamp(0.55 + 0.75 * g * Math.max(0, 1 - x * 3), 0.2, 2.4),
              steps: 12,
            }),
            cycle({
              prop: 'opacity',
              unit: 'ratio',
              span,
              phase,
              at: (x) => clamp(0.4 + 0.6 * Math.max(0, 1 - x * 3), 0, 1),
            }),
          ],
        })
      }
      return { layers, durationFrames: span, loopMode: 'loop', fps }
    },
  },
]
