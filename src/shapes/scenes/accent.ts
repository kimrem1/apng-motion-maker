/**
 * 강조.
 *
 * 시선을 한 곳에 붙잡는 짧은 동작들이다. 세 가지를 지킨다.
 *
 *   1. 한 번에 하나만 움직인다. 강조가 둘이면 강조가 아니다.
 *   2. 되돌아온다. 밑줄은 그어졌다 지워지고, 팡 터진 조각은 사라진다.
 *      끝난 자리에 무언가 남아 있으면 반복 재생에서 화면이 점점 지저분해진다.
 *   3. 쫀득하게. 등속으로 커지는 것은 도형이 아니라 도표로 보인다.
 *      popBack / easeOutBack 처럼 살짝 지나쳤다 돌아오는 이징을 쓴다.
 */

import { createShapeSpec, withAlpha } from '@/core/shape.ts'
import type { SceneLayer, ShapeScene } from '../types.ts'
import { atRatio, cycle, bell, fixed, gain, keysOf, pick, stops, timingOf, track } from '../shared.ts'

/** 반짝임이 놓일 자리. */
const SPARK_SPOTS: readonly [number, number][] = [
  [0.32, 0.32],
  [0.68, 0.42],
  [0.5, 0.7],
]

/** 팡 터질 때 조각이 날아가는 각도(도). */
const BURST_ANGLES = [90, 150, 210, 270, 330, 30]

export const ACCENT_SCENES: ShapeScene[] = [
  {
    id: 'accent.pop',
    label: '쫀득 팝',
    hint: '도형이 튕기듯 나타났다가 사라집니다.',
    group: 'accent',
    defaultDurationMs: 1200,
    emit(ctx) {
      const { span, fps } = timingOf(ctx, this.defaultDurationMs)
      const g = gain(ctx.strength)
      const base = Math.min(ctx.canvasW, ctx.canvasH)
      const size = Math.round(base * 0.34)
      // 커지기 -> 유지 -> 사라지기. 마지막에서 두 번째 자리에서 완전히 사라진다.
      const sc = stops(span, [0, 0.34, 0.62, (span - 1) / span, 1])
      const op = stops(span, [0, 0.16, 0.62, (span - 1) / span, 1])
      const rt = stops(span, [0, 0.4, 1])

      return {
        layers: [
          {
            name: '쫀득 도형',
            shape: createShapeSpec('rect', {
              color: withAlpha(ctx.color, 1),
              width: size,
              height: size,
              cornerRadius: Math.round(size * 0.24),
            }),
            tracks: [
              /*
               * 사라지는 동작은 마지막 출력 프레임(span - 1)에서 끝난다.
               *
               * span 에서 끝나게 두면 실제로 그려지는 마지막 프레임에는 아직 절반쯤
               * 남아 있고, 반복하는 순간 그것이 뚝 끊긴다. 이음새가 보이는 것은
               * 값이 안 닫혀서가 아니라 다 사라지기 전에 프레임이 끝나서다.
               */
              track(
                'scale',
                'ratio',
                [
                  { f: sc[0]!, v: 0.01, ease: 'popBack' },
                  { f: sc[1]!, v: 1, ease: 'hold' },
                  { f: sc[2]!, v: 1, ease: 'easeInExpo' },
                  { f: sc[3]!, v: 0.01, ease: 'hold' },
                  { f: sc[4]!, v: 0.01 },
                ],
                'popBack',
              ),
              track(
                'opacity',
                'ratio',
                [
                  { f: op[0]!, v: 0, ease: 'easeOutExpo' },
                  { f: op[1]!, v: 1, ease: 'hold' },
                  { f: op[2]!, v: 1, ease: 'easeInExpo' },
                  { f: op[3]!, v: 0, ease: 'hold' },
                  { f: op[4]!, v: 0 },
                ],
                'linear',
              ),
              track(
                'rotate',
                'deg',
                [
                  { f: rt[0]!, v: -18 * g, ease: 'easeOutBack' },
                  { f: rt[1]!, v: 0, ease: 'linear' },
                  { f: rt[2]!, v: 0 },
                ],
                'easeOutBack',
              ),
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
    id: 'accent.sparkle',
    label: '반짝임',
    hint: '십자 별들이 시간차를 두고 반짝입니다.',
    group: 'accent',
    defaultDurationMs: 1800,
    emit(ctx) {
      const { span, fps } = timingOf(ctx, this.defaultDurationMs)
      const g = gain(ctx.strength)
      const base = Math.min(ctx.canvasW, ctx.canvasH)
      const sizes = [0.22, 0.14, 0.18]

      const layers: SceneLayer[] = SPARK_SPOTS.map((spot, i) => {
        const size = Math.round(base * pick(sizes, i, 0.18))
        const phase = i / SPARK_SPOTS.length
        return {
          name: `반짝임 ${i + 1}`,
          shape: createShapeSpec('cross', {
            color: withAlpha(ctx.color, 1),
            width: size,
            height: size,
            innerRatio: 0.16,
            cornerRadius: Math.round(size * 0.08),
          }),
          tracks: [
            fixed('translateX', 'percentOfCanvas', atRatio(spot[0])),
            fixed('translateY', 'percentOfCanvas', atRatio(spot[1])),
            cycle({
              prop: 'scale',
              unit: 'ratio',
              span,
              phase,
              at: (x) => 0.15 + 1.1 * g * bell(x, 0.25, 0.7),
              steps: 12,
            }),
            cycle({
              prop: 'opacity',
              unit: 'ratio',
              span,
              phase,
              at: (x) => bell(x, 0.2, 0.72),
              steps: 12,
            }),
            cycle({
              prop: 'rotate',
              unit: 'deg',
              span,
              phase,
              at: (x) => 45 * bell(x, 0.3, 0.9),
              steps: 12,
            }),
          ],
        }
      })
      return { layers, durationFrames: span, loopMode: 'loop', fps }
    },
  },

  {
    id: 'accent.underline',
    label: '밑줄 긋기',
    hint: '선이 왼쪽에서 오른쪽으로 그어졌다 지워집니다.',
    group: 'accent',
    defaultDurationMs: 1600,
    emit(ctx) {
      const { span, fps } = timingOf(ctx, this.defaultDurationMs)
      const g = gain(ctx.strength)
      const w = Math.round(ctx.canvasW * 0.62 * Math.min(1.4, g))
      const h = Math.max(3, Math.round(Math.min(ctx.canvasW, ctx.canvasH) * 0.026))
      const line = stops(span, [0, 0.42, 0.68, (span - 1) / span, 1])

      return {
        layers: [
          {
            name: '밑줄',
            // 왼쪽 모서리를 축으로 자란다.
            anchor: [0, 0.5],
            shape: createShapeSpec('rect', {
              color: withAlpha(ctx.color, 1),
              width: w,
              height: h,
              cornerRadius: Math.round(h / 2),
            }),
            tracks: [
              fixed('translateY', 'percentOfCanvas', atRatio(0.62)),
              track(
                'scaleX',
                'ratio',
                [
                  { f: line[0]!, v: 0.001, ease: 'easeOutQuint' },
                  { f: line[1]!, v: 1, ease: 'hold' },
                  { f: line[2]!, v: 1, ease: 'easeInExpo' },
                  { f: line[3]!, v: 0.001, ease: 'hold' },
                  { f: line[4]!, v: 0.001 },
                ],
                'easeOutQuint',
              ),
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
    id: 'accent.frame',
    label: '테두리 그리기',
    hint: '네 변이 차례로 그려져 사각 테두리가 완성됩니다.',
    group: 'accent',
    defaultDurationMs: 2000,
    emit(ctx) {
      const { span, fps } = timingOf(ctx, this.defaultDurationMs)
      const thickness = Math.max(3, Math.round(Math.min(ctx.canvasW, ctx.canvasH) * 0.02))
      const boxW = Math.round(ctx.canvasW * 0.7)
      const boxH = Math.round(ctx.canvasH * 0.7)
      const color = withAlpha(ctx.color, 1)

      /** 변마다 자라는 축과 방향이 다르다. [기준점, 늘어나는 속성] */
      const sides: {
        name: string
        anchor: [number, number]
        prop: 'scaleX' | 'scaleY'
        w: number
        h: number
        x: number
        y: number
      }[] = [
        { name: '위', anchor: [0, 0.5], prop: 'scaleX', w: boxW, h: thickness, x: 0.5, y: 0.15 },
        { name: '오른쪽', anchor: [0.5, 0], prop: 'scaleY', w: thickness, h: boxH, x: 0.85, y: 0.5 },
        { name: '아래', anchor: [1, 0.5], prop: 'scaleX', w: boxW, h: thickness, x: 0.5, y: 0.85 },
        { name: '왼쪽', anchor: [0.5, 1], prop: 'scaleY', w: thickness, h: boxH, x: 0.15, y: 0.5 },
      ]

      const layers: SceneLayer[] = sides.map((side, i) => ({
        name: `테두리 ${side.name}`,
        anchor: side.anchor,
        shape: createShapeSpec('rect', {
          color,
          width: side.w,
          height: side.h,
          cornerRadius: 0,
        }),
        tracks: [
          fixed('translateX', 'percentOfCanvas', atRatio(side.x)),
          fixed('translateY', 'percentOfCanvas', atRatio(side.y)),
          track(
            side.prop,
            'ratio',
            // 네 변이 차례로 그려지고, 마지막에서 두 번째 자리에서 함께 사라진다.
            keysOf(stops(span, [0, i / 5, (i + 1) / 5, 0.82, (span - 1) / span, 1]), [
              { v: 0.001, ease: 'hold' },
              { v: 0.001, ease: 'easeOutQuint' },
              { v: 1, ease: 'hold' },
              { v: 1, ease: 'easeInExpo' },
              { v: 0.001, ease: 'hold' },
              { v: 0.001 },
            ]),
            'easeOutQuint',
          ),
        ],
      }))
      return { layers, durationFrames: span, loopMode: 'loop', fps }
    },
  },

  {
    id: 'accent.burst',
    label: '팡 터지기',
    hint: '조각들이 사방으로 튀어 나가며 사라집니다.',
    group: 'accent',
    defaultDurationMs: 1300,
    emit(ctx) {
      const { span, fps } = timingOf(ctx, this.defaultDurationMs)
      const g = gain(ctx.strength)
      const base = Math.min(ctx.canvasW, ctx.canvasH)
      const size = Math.round(base * 0.075)
      const reach = 0.34 * g
      const sc = stops(span, [0, 0.22, (span - 1) / span, 1])
      const op = stops(span, [0, 0.16, (span - 1) / span, 1])

      const layers: SceneLayer[] = BURST_ANGLES.map((deg, i) => {
        const rad = (deg * Math.PI) / 180
        const dx = Math.cos(rad) * reach * 100
        const dy = -Math.sin(rad) * reach * 100
        return {
          name: `조각 ${i + 1}`,
          shape: createShapeSpec('rect', {
            color: withAlpha(ctx.color, 1),
            width: size,
            height: size,
            cornerRadius: Math.round(size * 0.25),
          }),
          tracks: [
            track(
              'translateX',
              'percentOfCanvas',
              [{ f: 0, v: 0, ease: 'easeOutQuint' }, { f: span, v: dx }],
              'easeOutQuint',
            ),
            track(
              'translateY',
              'percentOfCanvas',
              [{ f: 0, v: 0, ease: 'easeOutQuint' }, { f: span, v: dy }],
              'easeOutQuint',
            ),
            track(
              'rotate',
              'deg',
              [{ f: 0, v: 0, ease: 'linear' }, { f: span, v: (i % 2 === 0 ? 1 : -1) * 180 }],
              'linear',
            ),
            /*
             * 조각은 **마지막 출력 프레임 전에** 완전히 사라져야 한다. span 에서
             * 끝내면 easeInExpo 가 끝에서야 급락하는 곡선이라 마지막 프레임에
             * 21% 쯤 남고, 반복할 때마다 조각 여섯 개가 한꺼번에 깜빡인다.
             */
            track(
              'scale',
              'ratio',
              [
                { f: sc[0]!, v: 0.01, ease: 'easeOutQuint' },
                { f: sc[1]!, v: 1, ease: 'easeInExpo' },
                { f: sc[2]!, v: 0.01, ease: 'hold' },
                { f: sc[3]!, v: 0.01 },
              ],
              'easeOutQuint',
            ),
            track(
              'opacity',
              'ratio',
              [
                { f: op[0]!, v: 0, ease: 'linear' },
                { f: op[1]!, v: 1, ease: 'easeInExpo' },
                { f: op[2]!, v: 0, ease: 'hold' },
                { f: op[3]!, v: 0 },
              ],
              'linear',
            ),
          ],
        }
      })
      return { layers, durationFrames: span, loopMode: 'loop', fps }
    },
  },
]
