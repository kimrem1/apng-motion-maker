/**
 * 화면 전환.
 *
 * 화면을 가리며 지나가는 것들이다. 다른 세트와 규칙이 하나 다르다.
 *
 * 되돌아오는 구간을 화면 밖에서 끝낸다. 왼쪽에서 오른쪽으로 지나간 띠가 다음
 * 반복을 위해 왼쪽으로 돌아가려면 화면을 거꾸로 한 번 더 지나야 하는데, 그러면
 * 전환이 아니라 왕복이 된다. 그래서 마지막 키를 마지막 출력 프레임(span - 1)에 두고
 * 되돌아가는 일 자체를 없앤다. 반복하면 화면 밖에서 다시 나타난다.
 */

import { createShapeSpec, withAlpha } from '@/core/shape.ts'
import type { SceneLayer, ShapeScene } from '../types.ts'
import { atRatio, fixed, gain, stops, timingOf, track } from '../shared.ts'

/** 마지막 출력 프레임. 되돌아오지 않는 모션은 여기서 끝난다. */
function lastFrame(span: number): number {
  return Math.max(1, span - 1)
}

export const WIPE_SCENES: ShapeScene[] = [
  {
    id: 'wipe.circle',
    label: '원형 전환',
    hint: '동그라미가 화면을 덮었다가 다시 열립니다.',
    group: 'wipe',
    covers: true,
    defaultDurationMs: 1600,
    emit(ctx) {
      const { span, fps } = timingOf(ctx, this.defaultDurationMs)
      const base = Math.min(ctx.canvasW, ctx.canvasH)
      // 대각선을 덮어야 모서리까지 빈 곳이 없다.
      const need = Math.hypot(ctx.canvasW, ctx.canvasH) / base

      const at = stops(span, [0, 0.42, 0.58, 1])
      return {
        layers: [
          {
            name: '원형 전환',
            shape: createShapeSpec('circle', {
              color: withAlpha(ctx.color, 1),
              width: base,
              height: base,
            }),
            tracks: [
              track(
                'scale',
                'ratio',
                [
                  { f: at[0]!, v: 0.001, ease: 'easeInOutQuart' },
                  { f: at[1]!, v: need * 1.05, ease: 'linear' },
                  { f: at[2]!, v: need * 1.05, ease: 'easeInOutQuart' },
                  { f: at[3]!, v: 0.001 },
                ],
                'easeInOutQuart',
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
    id: 'wipe.bands',
    label: '띠 전환',
    hint: '넓은 띠들이 시간차를 두고 화면을 쓸고 지나갑니다.',
    group: 'wipe',
    covers: true,
    defaultDurationMs: 1400,
    emit(ctx) {
      const { span, fps } = timingOf(ctx, this.defaultDurationMs)
      const count = 5
      const bandH = Math.ceil(ctx.canvasH / count) + 2
      const end = lastFrame(span)

      const layers: SceneLayer[] = []
      for (let i = 0; i < count; i += 1) {
        const at = stops(end, [0, (0.3 * i) / count, 1])
        layers.push({
          name: `띠 ${i + 1}`,
          shape: createShapeSpec('rect', {
            color: withAlpha(ctx.color, 1),
            width: Math.round(ctx.canvasW * 1.4),
            height: bandH,
            cornerRadius: 0,
          }),
          tracks: [
            fixed('translateY', 'percentOfCanvas', atRatio((i + 0.5) / count)),
            track(
              'translateX',
              'percentOfCanvas',
              [
                { f: at[0]!, v: -130, ease: 'hold' },
                { f: at[1]!, v: -130, ease: 'easeInOutQuart' },
                { f: at[2]!, v: 130 },
              ],
              'easeInOutQuart',
            ),
          ],
        })
      }
      return { layers, durationFrames: span, loopMode: 'loop', fps }
    },
  },

  {
    id: 'wipe.shutter',
    label: '셔터',
    hint: '세로 판들이 차례로 내려와 화면을 덮습니다.',
    group: 'wipe',
    covers: true,
    defaultDurationMs: 1500,
    emit(ctx) {
      const { span, fps } = timingOf(ctx, this.defaultDurationMs)
      const count = 6
      const panelW = Math.ceil(ctx.canvasW / count) + 2

      const layers: SceneLayer[] = []
      for (let i = 0; i < count; i += 1) {
        const delay = (0.23 * i) / count
        /*
         * 닫고 나서 다시 열어야 반복이 성립한다. 닫은 채로 끝나면 다음 바퀴 첫
         * 프레임에서 화면이 한 번에 열려 번쩍인다. 마지막에서 두 번째 자리에서
         * 완전히 열려야 하므로 stops 로 프레임을 확보한다.
         */
        const at = stops(span, [0, delay, 0.46 + delay, 0.66 + delay, (span - 1) / span, 1])
        layers.push({
          name: `셔터 ${i + 1}`,
          // 위 모서리를 축으로 자란다.
          anchor: [0.5, 0],
          shape: createShapeSpec('rect', {
            color: withAlpha(ctx.color, 1),
            width: panelW,
            height: ctx.canvasH,
            cornerRadius: 0,
          }),
          tracks: [
            fixed('translateX', 'percentOfCanvas', atRatio((i + 0.5) / count)),
            track(
              'scaleY',
              'ratio',
              [
                { f: at[0]!, v: 0.001, ease: 'hold' },
                { f: at[1]!, v: 0.001, ease: 'easeOutQuint' },
                { f: at[2]!, v: 1, ease: 'hold' },
                { f: at[3]!, v: 1, ease: 'easeInExpo' },
                { f: at[4]!, v: 0.001, ease: 'hold' },
                { f: at[5]!, v: 0.001 },
              ],
              'easeOutQuint',
            ),
          ],
        })
      }
      return { layers, durationFrames: span, loopMode: 'loop', fps }
    },
  },

  {
    id: 'wipe.diagonal',
    label: '대각선 쓸기',
    hint: '기울어진 판이 비스듬히 화면을 가로지릅니다.',
    group: 'wipe',
    covers: true,
    defaultDurationMs: 1200,
    emit(ctx) {
      const { span, fps } = timingOf(ctx, this.defaultDurationMs)
      const g = gain(ctx.strength)
      const end = lastFrame(span)
      const long = Math.round(Math.hypot(ctx.canvasW, ctx.canvasH) * 1.3)

      return {
        layers: [
          {
            name: '대각선 판',
            shape: createShapeSpec('rect', {
              color: withAlpha(ctx.color, 1),
              width: Math.round(long * 0.9),
              height: long,
              cornerRadius: 0,
            }),
            tracks: [
              fixed('rotate', 'deg', -22),
              track(
                'translateX',
                'percentOfCanvas',
                [
                  { f: 0, v: -150 * g, ease: 'easeInOutQuart' },
                  { f: end, v: 150 * g },
                ],
                'easeInOutQuart',
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
]
