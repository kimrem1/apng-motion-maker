/**
 * 퍼지기.
 *
 * 한 점에서 시작해 바깥으로 번지는 것들이다. 전부 같은 뼈대를 쓴다.
 *   크기는 계속 커지고, 투명도는 봉우리를 그리며 사라진다.
 * 여러 장을 위상만 어긋나게 겹치면 끊임없이 번지는 파동이 된다.
 */

import { createShapeSpec, withAlpha } from '@/core/shape.ts'
import type { SceneLayer, ShapeScene } from '../types.ts'
import {
  atRatio,
  bell,
  clamp,
  cycle,
  easeOut,
  fixed,
  gain,
  pick,
  timingOf,
  track,
} from '../shared.ts'

/** 방울이 흩어질 자리. 캔버스 비율 좌표다. 난수를 쓰지 않는다. */
const BUBBLE_SPOTS: readonly [number, number][] = [
  [0.28, 0.34],
  [0.7, 0.28],
  [0.5, 0.55],
  [0.22, 0.68],
  [0.78, 0.7],
]

export const PULSE_SCENES: ShapeScene[] = [
  {
    id: 'pulse.ripple',
    label: '물결 파동',
    hint: '가운데에서 동그라미가 차례로 번져 나갑니다.',
    group: 'pulse',
    defaultDurationMs: 2000,
    emit(ctx) {
      const { span, fps } = timingOf(ctx, this.defaultDurationMs)
      const g = gain(ctx.strength)
      const base = Math.min(ctx.canvasW, ctx.canvasH)
      const size = Math.round(base * 0.34)
      const rings = 3

      const layers: SceneLayer[] = []
      for (let i = 0; i < rings; i += 1) {
        layers.push({
          name: `물결 ${i + 1}`,
          shape: createShapeSpec('circle', {
            color: withAlpha(ctx.color, 1),
            width: size,
            height: size,
            strokeWidth: Math.max(2, Math.round(base * 0.014)),
          }),
          tracks: [
            cycle({
              prop: 'scale',
              unit: 'ratio',
              span,
              phase: i / rings,
              at: (x) => 0.25 + 2.1 * g * easeOut(x, 2),
            }),
            cycle({
              prop: 'opacity',
              unit: 'ratio',
              span,
              phase: i / rings,
              at: (x) => 0.9 * bell(x, 0.14, 0.86),
            }),
          ],
        })
      }
      return { layers, durationFrames: span, loopMode: 'loop', fps }
    },
  },

  {
    id: 'pulse.beacon',
    label: '신호등',
    hint: '가운데 점이 뛰고 그 둘레로 신호가 퍼집니다.',
    group: 'pulse',
    defaultDurationMs: 1600,
    emit(ctx) {
      const { span, fps } = timingOf(ctx, this.defaultDurationMs)
      const g = gain(ctx.strength)
      const base = Math.min(ctx.canvasW, ctx.canvasH)
      const dot = Math.round(base * 0.16)

      const layers: SceneLayer[] = [
        {
          name: '신호 점',
          shape: createShapeSpec('circle', {
            color: withAlpha(ctx.color, 1),
            width: dot,
            height: dot,
          }),
          tracks: [
            cycle({
              prop: 'scale',
              unit: 'ratio',
              span,
              phase: 0,
              at: (x) => 1 + 0.18 * g * Math.max(0, 1 - x * 4),
            }),
          ],
        },
      ]

      for (let i = 0; i < 2; i += 1) {
        layers.unshift({
          name: `신호 파동 ${i + 1}`,
          shape: createShapeSpec('circle', {
            color: withAlpha(ctx.color, 1),
            width: dot,
            height: dot,
            strokeWidth: Math.max(2, Math.round(base * 0.012)),
          }),
          tracks: [
            cycle({
              prop: 'scale',
              unit: 'ratio',
              span,
              phase: i / 2,
              at: (x) => 1 + 3.4 * g * easeOut(x, 2),
            }),
            cycle({
              prop: 'opacity',
              unit: 'ratio',
              span,
              phase: i / 2,
              at: (x) => 0.75 * bell(x, 0.05, 0.85),
            }),
          ],
        })
      }
      return { layers, durationFrames: span, loopMode: 'loop', fps }
    },
  },

  {
    id: 'pulse.sonar',
    label: '레이더',
    hint: '부채꼴이 한 바퀴 돌면서 파동을 남깁니다.',
    group: 'pulse',
    defaultDurationMs: 2400,
    emit(ctx) {
      const { span, fps } = timingOf(ctx, this.defaultDurationMs)
      const g = gain(ctx.strength)
      const base = Math.min(ctx.canvasW, ctx.canvasH)
      const size = Math.round(base * 0.62)

      const layers: SceneLayer[] = [
        {
          name: '레이더 테두리',
          shape: createShapeSpec('circle', {
            color: withAlpha(ctx.color, 0.35),
            width: size,
            height: size,
            strokeWidth: Math.max(2, Math.round(base * 0.008)),
          }),
          tracks: [fixed('opacity', 'ratio', 1)],
        },
        {
          name: '레이더 빛',
          shape: createShapeSpec('arc', {
            color: withAlpha(ctx.color, 0.55),
            width: size,
            height: size,
            sweepDeg: 55,
          }),
          tracks: [
            /*
             * 회전만은 cycle 을 쓰지 않는다. cycle 은 마지막 키를 첫 값으로 되돌려
             * 이음새를 닫는데, 회전에서 그러면 마지막 조각에서 거꾸로 한 바퀴를
             * 되감는다. 360도는 0도와 같은 그림이므로 그냥 끝까지 늘려 두면 된다.
             */
            track('rotate', 'deg', [{ f: 0, v: 0 }, { f: span, v: 360 }], 'linear'),
          ],
        },
        {
          name: '레이더 파동',
          shape: createShapeSpec('circle', {
            color: withAlpha(ctx.color, 1),
            width: Math.round(size * 0.3),
            height: Math.round(size * 0.3),
            strokeWidth: Math.max(2, Math.round(base * 0.01)),
          }),
          tracks: [
            cycle({
              prop: 'scale',
              unit: 'ratio',
              span,
              phase: 0,
              at: (x) => 0.4 + 2.2 * g * easeOut(x, 2),
            }),
            cycle({
              prop: 'opacity',
              unit: 'ratio',
              span,
              phase: 0,
              at: (x) => 0.8 * bell(x, 0.08, 0.85),
            }),
          ],
        },
      ]
      return { layers, durationFrames: span, loopMode: 'loop', fps }
    },
  },

  {
    id: 'pulse.bubble',
    label: '방울 팝',
    hint: '동그라미들이 여기저기서 톡톡 터집니다.',
    group: 'pulse',
    defaultDurationMs: 1800,
    emit(ctx) {
      const { span, fps } = timingOf(ctx, this.defaultDurationMs)
      const g = gain(ctx.strength)
      const base = Math.min(ctx.canvasW, ctx.canvasH)
      const sizes = [0.16, 0.1, 0.2, 0.12, 0.14]

      const layers: SceneLayer[] = BUBBLE_SPOTS.map((spot, i) => {
        const size = Math.round(base * (pick(sizes, i, 0.14) || 0.14))
        const phase = i / BUBBLE_SPOTS.length
        return {
          name: `방울 ${i + 1}`,
          shape: createShapeSpec('circle', {
            color: withAlpha(ctx.color, 0.9),
            width: size,
            height: size,
          }),
          tracks: [
            fixed('translateX', 'percentOfCanvas', atRatio(spot[0])),
            fixed('translateY', 'percentOfCanvas', atRatio(spot[1])),
            cycle({
              prop: 'scale',
              unit: 'ratio',
              span,
              phase,
              // 부풀었다가 한 번에 사라진다. 세기가 크면 더 크게 부푼다.
              at: (x) => clamp(0.05 + 1.3 * g * easeOut(Math.min(1, x * 2.2), 3), 0.05, 3),
            }),
            cycle({
              prop: 'opacity',
              unit: 'ratio',
              span,
              phase,
              at: (x) => bell(x, 0.12, 0.6),
            }),
          ],
        }
      })
      return { layers, durationFrames: span, loopMode: 'loop', fps }
    },
  },
]
