/**
 * 배경 장식.
 *
 * 주인공이 아니다. 그래서 세 가지가 다르다.
 *   투명도를 낮게 잡고, 크기를 작게 두고, 주기를 길게 잡는다.
 * 이미지 아래에 깔아 두면 그림이 정지 사진이어도 화면이 살아 있는 것처럼 보인다.
 */

import { createShapeSpec, withAlpha } from '@/core/shape.ts'
import type { SceneLayer, ShapeScene } from '../types.ts'
import { atRatio, clamp, cycle, fixed, gain, pick, stream, timingOf, track } from '../shared.ts'

/** 떠다니는 원의 자리와 크기 비율. */
const FLOAT_SPOTS: readonly [number, number, number][] = [
  [0.18, 0.26, 0.16],
  [0.74, 0.2, 0.1],
  [0.5, 0.5, 0.22],
  [0.28, 0.76, 0.13],
  [0.82, 0.7, 0.18],
]

/** 색종이가 떨어지기 시작하는 가로 위치. */
const CONFETTI_X = [0.12, 0.3, 0.46, 0.62, 0.78, 0.9, 0.2, 0.68]
/** 색종이마다 다른 출발 시각. 한 줄로 떨어지면 종이가 아니라 커튼이 된다. */
const CONFETTI_DELAY = [0, 0.42, 0.17, 0.66, 0.28, 0.83, 0.55, 0.09]

export const AMBIENT_SCENES: ShapeScene[] = [
  {
    id: 'ambient.float',
    label: '떠다니는 원',
    hint: '옅은 동그라미들이 천천히 흘러 다닙니다.',
    group: 'ambient',
    defaultDurationMs: 4000,
    emit(ctx) {
      const { span, fps } = timingOf(ctx, this.defaultDurationMs)
      const g = gain(ctx.strength)
      const base = Math.min(ctx.canvasW, ctx.canvasH)
      const drift = 5 * g

      const layers: SceneLayer[] = FLOAT_SPOTS.map((spot, i) => {
        const size = Math.round(base * spot[2])
        const phase = i / FLOAT_SPOTS.length
        const dir = i % 2 === 0 ? 1 : -1
        return {
          name: `떠다니는 원 ${i + 1}`,
          shape: createShapeSpec('circle', {
            color: withAlpha(ctx.color, 0.3),
            width: size,
            height: size,
          }),
          tracks: [
            cycle({
              prop: 'translateX',
              unit: 'percentOfCanvas',
              span,
              phase,
              at: (x) => atRatio(spot[0]) + Math.cos(x * Math.PI * 2) * drift * dir,
              steps: 12,
            }),
            cycle({
              prop: 'translateY',
              unit: 'percentOfCanvas',
              span,
              phase: phase + 0.25,
              at: (x) => atRatio(spot[1]) + Math.sin(x * Math.PI * 2) * drift,
              steps: 12,
            }),
            cycle({
              prop: 'scale',
              unit: 'ratio',
              span,
              phase,
              at: (x) => clamp(1 + 0.12 * g * Math.sin(x * Math.PI * 2), 0.2, 2),
              steps: 12,
            }),
          ],
        }
      })
      return { layers, durationFrames: span, loopMode: 'loop', fps }
    },
  },

  {
    id: 'ambient.confetti',
    label: '색종이',
    hint: '작은 조각들이 돌면서 위에서 아래로 떨어집니다.',
    group: 'ambient',
    defaultDurationMs: 3000,
    emit(ctx) {
      const { span, fps } = timingOf(ctx, this.defaultDurationMs)
      const g = gain(ctx.strength)
      const base = Math.min(ctx.canvasW, ctx.canvasH)
      const size = Math.max(4, Math.round(base * 0.05))
      const count = 8
      const end = Math.max(1, span - 1)

      const layers: SceneLayer[] = []
      for (let i = 0; i < count; i += 1) {
        const startX = pick(CONFETTI_X, i, 0.5)
        const delay = pick(CONFETTI_DELAY, i, 0)
        // 떨어지는 동안 좌우로 조금 흔들린다. 곧게 떨어지면 비처럼 보인다.
        const swayTo = atRatio(startX) + (i % 2 === 0 ? 6 : -6) * g
        layers.push({
          name: `색종이 ${i + 1}`,
          shape: createShapeSpec('rect', {
            color: withAlpha(ctx.color, 0.85),
            width: size,
            height: Math.round(size * 0.62),
            cornerRadius: Math.round(size * 0.12),
          }),
          tracks: [
            track(
              'translateX',
              'percentOfCanvas',
              [
                { f: 0, v: atRatio(startX), ease: 'easeInOutCubic' },
                { f: Math.round(end * 0.5), v: swayTo, ease: 'easeInOutCubic' },
                { f: end, v: atRatio(startX) },
              ],
              'easeInOutCubic',
            ),
            /*
             * 조각마다 주기의 다른 지점에서 시작한다. 되돌아가는 순간은 화면 위아래
             * 밖에서 한 프레임에 끝나므로 보이지 않는다. 이렇게 해야 반복 시작
             * 시점에도 화면에 조각이 남아 있다. 단순히 시작 위치만 어긋내면 첫
             * 프레임에 전부 화면 위에 모여 있어 한동안 아무것도 안 보인다.
             */
            stream({
              prop: 'translateY',
              unit: 'percentOfCanvas',
              span,
              phase: delay,
              from: -70,
              to: 90,
            }),
            track(
              'rotate',
              'deg',
              [
                { f: 0, v: 0, ease: 'linear' },
                { f: end, v: (i % 3 === 0 ? -1 : 1) * 360 },
              ],
              'linear',
            ),
          ],
        })
      }
      return { layers, durationFrames: span, loopMode: 'loop', fps }
    },
  },

  {
    id: 'ambient.grid',
    label: '격자 점멸',
    hint: '점들이 격자 위에서 차례로 깜빡입니다.',
    group: 'ambient',
    defaultDurationMs: 2400,
    emit(ctx) {
      const { span, fps } = timingOf(ctx, this.defaultDurationMs)
      const g = gain(ctx.strength)
      const base = Math.min(ctx.canvasW, ctx.canvasH)
      const dot = Math.max(3, Math.round(base * 0.055))
      const cols = 3
      const rows = 3

      const layers: SceneLayer[] = []
      for (let r = 0; r < rows; r += 1) {
        for (let c = 0; c < cols; c += 1) {
          const index = r * cols + c
          // 대각선 순서로 켜지면 격자가 물결처럼 보인다.
          const phase = ((r + c) % (rows + cols - 1)) / (rows + cols - 1)
          layers.push({
            name: `격자 ${index + 1}`,
            shape: createShapeSpec('circle', {
              color: withAlpha(ctx.color, 1),
              width: dot,
              height: dot,
            }),
            tracks: [
              fixed('translateX', 'percentOfCanvas', atRatio(0.3 + c * 0.2)),
              fixed('translateY', 'percentOfCanvas', atRatio(0.3 + r * 0.2)),
              cycle({
                prop: 'opacity',
                unit: 'ratio',
                span,
                phase,
                at: (x) => clamp(0.15 + 0.85 * Math.max(0, 1 - x * 2.5), 0, 1),
                steps: 12,
              }),
              cycle({
                prop: 'scale',
                unit: 'ratio',
                span,
                phase,
                at: (x) => clamp(0.7 + 0.5 * g * Math.max(0, 1 - x * 2.5), 0.2, 2),
                steps: 12,
              }),
            ],
          })
        }
      }
      return { layers, durationFrames: span, loopMode: 'loop', fps }
    },
  },
]
