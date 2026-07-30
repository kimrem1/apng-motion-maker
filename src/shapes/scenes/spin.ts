/**
 * 돌기.
 *
 * 회전만 있으면 금방 지루해진다. 그래서 전부 두 번째 축을 하나씩 더 얹었다.
 * 크기가 함께 뛰거나(도는 사각), 궤도를 돌거나(궤도 점), 눌렸다 펴진다(삼각 스핀).
 *
 * 회전 트랙은 0 에서 360 까지 곧게 늘린다. 360도는 0도와 같은 그림이라 이음새가
 * 저절로 닫히고, 중간을 되감을 필요가 없다.
 */

import { createShapeSpec, withAlpha } from '@/core/shape.ts'
import type { SceneLayer, ShapeScene } from '../types.ts'
import { clamp, cycle, fixed, gain, timingOf, track, wave } from '../shared.ts'

export const SPIN_SCENES: ShapeScene[] = [
  {
    id: 'spin.square',
    label: '도는 사각',
    hint: '네모가 한 바퀴 돌면서 크기가 함께 뜁니다.',
    group: 'spin',
    defaultDurationMs: 1600,
    emit(ctx) {
      const { span, fps } = timingOf(ctx, this.defaultDurationMs)
      const g = gain(ctx.strength)
      const base = Math.min(ctx.canvasW, ctx.canvasH)
      const size = Math.round(base * 0.34)

      return {
        layers: [
          {
            name: '도는 사각',
            shape: createShapeSpec('rect', {
              color: withAlpha(ctx.color, 1),
              width: size,
              height: size,
              cornerRadius: Math.round(size * 0.14),
            }),
            tracks: [
              track('rotate', 'deg', [{ f: 0, v: 0 }, { f: span, v: 360 }], 'linear'),
              cycle({
                prop: 'scale',
                unit: 'ratio',
                span,
                phase: 0,
                at: (x) => clamp(1 + 0.28 * g * wave(x * 2), 0.1, 3),
                steps: 12,
              }),
            ],
          },
        ],
        durationFrames: span,
        loopMode: 'loop',
        fps,
      }
    },
  },

  {
    id: 'spin.orbit',
    label: '궤도 점',
    hint: '점들이 가운데를 중심으로 원을 그리며 돕니다.',
    group: 'spin',
    defaultDurationMs: 2200,
    emit(ctx) {
      const { span, fps } = timingOf(ctx, this.defaultDurationMs)
      const g = gain(ctx.strength)
      const base = Math.min(ctx.canvasW, ctx.canvasH)
      const dot = Math.round(base * 0.09)
      const count = 3
      // 궤도 반지름. 캔버스 폭과 높이가 달라도 원이 되도록 짧은 변을 기준으로 잡고
      // 축마다 비율을 다시 나눈다.
      const radius = base * 0.28 * g
      const rx = (radius / ctx.canvasW) * 100
      const ry = (radius / ctx.canvasH) * 100

      const layers: SceneLayer[] = [
        {
          name: '궤도 선',
          shape: createShapeSpec('circle', {
            color: withAlpha(ctx.color, 0.25),
            width: Math.round(radius * 2),
            height: Math.round(radius * 2),
            strokeWidth: Math.max(1, Math.round(base * 0.005)),
          }),
          tracks: [fixed('opacity', 'ratio', 1)],
        },
      ]

      for (let i = 0; i < count; i += 1) {
        const phase = i / count
        layers.push({
          name: `궤도 점 ${i + 1}`,
          shape: createShapeSpec('circle', {
            color: withAlpha(ctx.color, 1),
            width: dot,
            height: dot,
          }),
          tracks: [
            cycle({
              prop: 'translateX',
              unit: 'percentOfCanvas',
              span,
              phase,
              at: (x) => Math.cos(x * Math.PI * 2) * rx,
              steps: 16,
            }),
            cycle({
              prop: 'translateY',
              unit: 'percentOfCanvas',
              span,
              phase,
              at: (x) => Math.sin(x * Math.PI * 2) * ry,
              steps: 16,
            }),
            cycle({
              prop: 'scale',
              unit: 'ratio',
              span,
              phase,
              // 아래쪽을 지날 때 조금 커진다. 평면인데도 깊이가 느껴진다.
              at: (x) => 0.85 + 0.3 * (0.5 + 0.5 * Math.sin(x * Math.PI * 2)),
              steps: 16,
            }),
          ],
        })
      }
      return { layers, durationFrames: span, loopMode: 'loop', fps }
    },
  },

  {
    id: 'spin.triangle',
    label: '삼각 스핀',
    hint: '삼각형이 돌면서 눌렸다 펴집니다.',
    group: 'spin',
    defaultDurationMs: 1800,
    emit(ctx) {
      const { span, fps } = timingOf(ctx, this.defaultDurationMs)
      const g = gain(ctx.strength)
      const base = Math.min(ctx.canvasW, ctx.canvasH)
      const size = Math.round(base * 0.36)

      return {
        layers: [
          {
            name: '삼각 스핀',
            shape: createShapeSpec('triangle', {
              color: withAlpha(ctx.color, 1),
              width: size,
              height: size,
            }),
            tracks: [
              track('rotate', 'deg', [{ f: 0, v: 0 }, { f: span, v: 360 }], 'linear'),
              cycle({
                prop: 'scaleX',
                unit: 'ratio',
                span,
                phase: 0,
                at: (x) => clamp(1 + 0.22 * g * wave(x * 2), 0.1, 3),
                steps: 12,
              }),
              cycle({
                prop: 'scaleY',
                unit: 'ratio',
                span,
                phase: 0,
                // 가로가 늘면 세로가 준다. 부피가 유지되는 것처럼 보인다.
                at: (x) => clamp(1 - 0.22 * g * wave(x * 2), 0.1, 3),
                steps: 12,
              }),
            ],
          },
        ],
        durationFrames: span,
        loopMode: 'loop',
        fps,
      }
    },
  },

  {
    id: 'spin.ring',
    label: '회전 링',
    hint: '고리 한 조각이 계속 돕니다. 기다리는 표시에 씁니다.',
    group: 'spin',
    defaultDurationMs: 1400,
    emit(ctx) {
      const { span, fps } = timingOf(ctx, this.defaultDurationMs)
      const base = Math.min(ctx.canvasW, ctx.canvasH)
      const size = Math.round(base * 0.36)
      const stroke = Math.max(3, Math.round(base * 0.026))

      return {
        layers: [
          {
            name: '링 바탕',
            shape: createShapeSpec('circle', {
              color: withAlpha(ctx.color, 0.22),
              width: size,
              height: size,
              strokeWidth: stroke,
            }),
            tracks: [fixed('opacity', 'ratio', 1)],
          },
          {
            name: '도는 조각',
            shape: createShapeSpec('arc', {
              color: withAlpha(ctx.color, 1),
              width: size,
              height: size,
              strokeWidth: stroke,
              sweepDeg: 110,
            }),
            tracks: [track('rotate', 'deg', [{ f: 0, v: 0 }, { f: span, v: 360 }], 'linear')],
          },
        ],
        durationFrames: span,
        loopMode: 'loop',
        fps,
      }
    },
  },
]
