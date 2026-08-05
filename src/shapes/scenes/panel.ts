/**
 * 패널.
 *
 * 레퍼런스 영상에서 되풀이되는 "화면을 칸으로 나눠 차례로 여는" 문법이다.
 * 연출(stage) 묶음과 다른 점은 칸이 격자를 이룬다는 것이고, 그래서 순서를
 * 대각선으로 흘려야 리듬이 산다. 한 줄씩 여닫으면 엘리베이터 문처럼 보인다.
 *
 * 네 세트가 서로 다른 축을 하나씩 맡는다.
 *   격자 패널 열림 : 칸이 가운데부터 갈라지며 열린다      (면)
 *   모여서 격자로  : 흩어진 점이 제자리를 찾아 앉는다      (점)
 *   문과 빛줄기    : 양쪽 문이 열리고 빛이 쓸고 지나간다   (빛)
 *   귀퉁이 괄호    : 네 귀퉁이의 ㄱ 자가 그려지며 조인다   (선)
 *
 * 세트는 폴더에 담겨 들어간다(state/shapeActions.ts). 그래서 여기서 레이어를 열
 * 몇 장 만들어도 목록은 한 줄이고, 그 한 줄에 모션을 걸면 통째로 움직인다.
 */

import { createRevealSpec } from '@/core/reveal.ts'
import { createShapeSpec, shiftColor, withAlpha } from '@/core/shape.ts'
import type { SceneLayer, ShapeScene } from '../types.ts'
import { fixed, gain, pick, slot, stops, timingOf, track } from '../shared.ts'

/**
 * 대각선 순서. 왼쪽 위에서 오른쪽 아래로 흐른다.
 *
 * 격자에서 순번을 행 우선(r * cols + c)으로 매기면 한 줄이 다 열린 뒤 다음 줄이
 * 열려서 블라인드처럼 보인다. 행과 열을 더하면 대각선 띠가 되어 훨씬 자연스럽다.
 */
function diagonalRank(r: number, c: number): number {
  return r + c
}

export const PANEL_SCENES: ShapeScene[] = [
  {
    id: 'panel.gridOpen',
    label: '격자 패널 열림',
    hint: '화면을 여섯 칸으로 나눠 가운데부터 갈라지며 엽니다.',
    group: 'stage',
    defaultDurationMs: 2600,
    emit(ctx) {
      const { span, fps } = timingOf(ctx, this.defaultDurationMs)
      const g = gain(ctx.strength)
      const cols = 3
      const rows = 2
      const spread = Math.min(0.96, 0.66 * g)
      const cellW = Math.round((ctx.canvasW * spread) / cols) - 4
      const cellH = Math.round((ctx.canvasH * spread) / rows) - 4
      const maxRank = rows + cols - 2

      const layers: SceneLayer[] = []
      for (let r = 0; r < rows; r += 1) {
        for (let c = 0; c < cols; c += 1) {
          const i = r * cols + c
          // 대각선 띠 하나가 늦어지는 만큼. 전체의 3할 안에서 전부 출발한다.
          const delay = maxRank > 0 ? (diagonalRank(r, c) / maxRank) * 0.3 : 0
          const at = stops(span, [0, delay, delay + 0.34, 0.86, 1])

          layers.push({
            name: `패널 ${i + 1}`,
            shape: createShapeSpec('rect', {
              color: withAlpha(shiftColor(ctx.color, pick([0, -0.25, -0.45], i)), 1),
              width: Math.max(2, cellW),
              height: Math.max(2, cellH),
              cornerRadius: 2,
            }),
            /*
             * 가운데에서 좌우로 갈라진다. 진행률 0 이 완전히 가려진 상태이므로
             * 열림은 0 -> 1 이다. 칸마다 진행률 트랙만 다르고 모양은 같다.
             */
            reveal: createRevealSpec('splitX', { softness: 0.05 }),
            tracks: [
              fixed('translateX', 'percentOfCanvas', slot(c, cols, spread) * 100),
              fixed('translateY', 'percentOfCanvas', slot(r, rows, spread) * 100),
              track(
                'reveal',
                'ratio',
                [
                  { f: at[0]!, v: 0, ease: 'hold' },
                  { f: at[1]!, v: 0, ease: 'easeOutQuint' },
                  { f: at[2]!, v: 1, ease: 'hold' },
                  { f: at[3]!, v: 1, ease: 'easeInQuad' },
                  { f: at[4]!, v: 0 },
                ],
                'linear',
              ),
            ],
          })
        }
      }
      return { layers, durationFrames: span, loopMode: 'loop', fps }
    },
  },

  {
    id: 'panel.gather',
    label: '모여서 격자로',
    hint: '사방에 흩어진 점이 날아와 격자 자리에 하나씩 앉습니다.',
    group: 'stage',
    defaultDurationMs: 2400,
    emit(ctx) {
      const { span, fps } = timingOf(ctx, this.defaultDurationMs)
      const g = gain(ctx.strength)
      const cols = 4
      const rows = 3
      const spread = Math.min(0.9, 0.6 * g)
      const dot = Math.max(4, Math.round(Math.min(ctx.canvasW, ctx.canvasH) * 0.035))

      const layers: SceneLayer[] = []
      for (let r = 0; r < rows; r += 1) {
        for (let c = 0; c < cols; c += 1) {
          const i = r * cols + c
          const tx = slot(c, cols, spread) * 100
          const ty = slot(r, rows, spread) * 100

          /*
           * 출발 방향은 **제자리에서 바깥으로** 민 자리다. 무작위로 뽑으면 서로
           * 가로지르며 날아와 어지럽다. 자기 자리의 바깥쪽에서 곧게 들어오면
           * 격자가 스스로 조여드는 것처럼 보인다.
           */
          const away = 2.6
          const fromX = tx * away + (tx === 0 ? pick([-28, 28], i) : 0)
          const fromY = ty * away + (ty === 0 ? pick([28, -28], i) : 0)

          const delay = 0.03 * ((r * cols + c) % 7) + 0.02 * r
          const at = stops(span, [0, delay, delay + 0.4, 0.88, 1])

          layers.push({
            name: `점 ${i + 1}`,
            shape: createShapeSpec('circle', {
              color: withAlpha(shiftColor(ctx.color, pick([0, -0.2, -0.4, -0.1], i)), 1),
              width: dot,
              height: dot,
            }),
            /*
             * 끝에서 **출발 자리로 되돌아간다.**
             *
             * 자리를 잡은 채로 끝내면 반복할 때 점이 순간이동한다. 투명해진 뒤에
             * 되돌리므로 돌아가는 모습은 보이지 않고, 이음새만 사라진다.
             */
            tracks: [
              track(
                'translateX',
                'percentOfCanvas',
                [
                  { f: at[0]!, v: fromX, ease: 'hold' },
                  { f: at[1]!, v: fromX, ease: 'easeOutBack' },
                  { f: at[2]!, v: tx, ease: 'hold' },
                  { f: at[3]!, v: tx, ease: 'easeInQuad' },
                  { f: at[4]!, v: fromX },
                ],
                'linear',
              ),
              track(
                'translateY',
                'percentOfCanvas',
                [
                  { f: at[0]!, v: fromY, ease: 'hold' },
                  { f: at[1]!, v: fromY, ease: 'easeOutBack' },
                  { f: at[2]!, v: ty, ease: 'hold' },
                  { f: at[3]!, v: ty, ease: 'easeInQuad' },
                  { f: at[4]!, v: fromY },
                ],
                'linear',
              ),
              track(
                'opacity',
                'ratio',
                [
                  { f: at[0]!, v: 0, ease: 'hold' },
                  { f: at[1]!, v: 0, ease: 'easeOutQuad' },
                  { f: at[2]!, v: 1, ease: 'hold' },
                  { f: at[3]!, v: 1, ease: 'easeInQuad' },
                  { f: at[4]!, v: 0 },
                ],
                'linear',
              ),
            ],
          })
        }
      }
      return { layers, durationFrames: span, loopMode: 'loop', fps }
    },
  },

  {
    id: 'panel.doorLight',
    label: '문 열리며 빛줄기',
    hint: '양쪽 문이 갈라지고 그 틈에서 빛이 한 번 쓸고 지나갑니다.',
    group: 'stage',
    defaultDurationMs: 2200,
    emit(ctx) {
      const { span, fps } = timingOf(ctx, this.defaultDurationMs)
      const g = gain(ctx.strength)
      const half = Math.round(ctx.canvasW / 2) + 2
      const at = stops(span, [0, 0.16, 0.52, 0.8, 1])

      /** 문 한 짝. 부호가 여는 방향이다. */
      const door = (sign: -1 | 1, name: string): SceneLayer => ({
        name,
        shape: createShapeSpec('rect', {
          color: withAlpha(shiftColor(ctx.color, sign < 0 ? -0.2 : -0.35), 1),
          width: half,
          height: ctx.canvasH + 4,
        }),
        tracks: [
          track(
            'translateX',
            'percentOfCanvas',
            [
              // 닫힌 자리는 캔버스의 4분의 1 지점이다. 두 짝이 딱 맞물린다.
              { f: at[0]!, v: sign * 25, ease: 'hold' },
              { f: at[1]!, v: sign * 25, ease: 'easeInOutQuint' },
              { f: at[2]!, v: sign * 78, ease: 'hold' },
              { f: at[3]!, v: sign * 78, ease: 'easeInOutQuint' },
              { f: at[4]!, v: sign * 25 },
            ],
            'linear',
          ),
        ],
      })

      /*
       * 빛줄기는 문 **뒤**가 아니라 위에 얹는다. 문 사이로 새어 나오는 그림을
       * 만들려면 문보다 뒤에 둬야 맞지만, 투명 배경에서는 뒤에 둔 빛이 그냥
       * 화면 전체에 뜬다. 얇은 띠를 문 틈 자리에 겹쳐 지나가게 하는 편이
       * 배경이 무엇이든 같은 그림을 준다.
       */
      const beamW = Math.max(6, Math.round(ctx.canvasW * 0.06 * g))
      const beam: SceneLayer = {
        name: '빛줄기',
        shape: createShapeSpec('rect', {
          color: withAlpha(shiftColor(ctx.color, 0.55), 1),
          width: beamW,
          height: ctx.canvasH + 4,
        }),
        blend: 'screen',
        tracks: [
          track(
            'scaleX',
            'ratio',
            [
              { f: at[0]!, v: 0.2, ease: 'hold' },
              { f: at[1]!, v: 0.2, ease: 'easeOutQuint' },
              { f: at[2]!, v: 1, ease: 'easeInQuad' },
              { f: at[3]!, v: 0.2 },
            ],
            'linear',
          ),
          track(
            'opacity',
            'ratio',
            [
              { f: at[0]!, v: 0, ease: 'hold' },
              { f: at[1]!, v: 0, ease: 'easeOutQuad' },
              { f: at[2]!, v: 0.9, ease: 'easeInQuad' },
              { f: at[3]!, v: 0, ease: 'hold' },
              { f: at[4]!, v: 0 },
            ],
            'linear',
          ),
        ],
      }

      return {
        layers: [door(-1, '왼쪽 문'), door(1, '오른쪽 문'), beam],
        durationFrames: span,
        loopMode: 'loop',
        fps,
      }
    },
  },

  {
    id: 'panel.corners',
    label: '귀퉁이 괄호',
    hint: '네 귀퉁이의 ㄱ 자가 안쪽으로 조여들며 화면을 잡아 줍니다.',
    group: 'accent',
    defaultDurationMs: 2000,
    emit(ctx) {
      const { span, fps } = timingOf(ctx, this.defaultDurationMs)
      const g = gain(ctx.strength)
      const arm = Math.max(8, Math.round(Math.min(ctx.canvasW, ctx.canvasH) * 0.16))
      const thick = Math.max(2, Math.round(Math.min(ctx.canvasW, ctx.canvasH) * 0.014))
      // 멈춰 설 자리. 세기를 올리면 바깥으로 더 벌어진다.
      const restX = Math.min(46, 30 * g)
      const restY = Math.min(46, 30 * g)
      const at = stops(span, [0, 0.1, 0.46, 0.82, 1])

      const layers: SceneLayer[] = []
      const CORNERS: [number, number][] = [
        [-1, -1],
        [1, -1],
        [-1, 1],
        [1, 1],
      ]

      CORNERS.forEach(([sx, sy], i) => {
        const name = `괄호 ${i + 1}`
        /*
         * ㄱ 자 하나를 막대 두 개로 만든다. 십자(cross) 도형은 가운데가 이어져
         * 있어서 귀퉁이 모양이 안 나온다. 두 막대의 기준점을 귀퉁이에 두면
         * 자라나는 방향까지 저절로 맞는다.
         */
        const bar = (horizontal: boolean): SceneLayer => ({
          name: horizontal ? `${name} 가로` : `${name} 세로`,
          shape: createShapeSpec('rect', {
            color: withAlpha(ctx.color, 1),
            width: horizontal ? arm : thick,
            height: horizontal ? thick : arm,
          }),
          // 귀퉁이 쪽 끝을 축으로 삼는다. 그래야 안쪽으로 자란다.
          anchor: [sx < 0 ? 0 : 1, sy < 0 ? 0 : 1],
          tracks: [
            track(
              'translateX',
              'percentOfCanvas',
              [
                { f: at[0]!, v: sx * (restX + 14), ease: 'hold' },
                { f: at[1]!, v: sx * (restX + 14), ease: 'easeOutBack' },
                { f: at[2]!, v: sx * restX, ease: 'hold' },
                { f: at[3]!, v: sx * restX, ease: 'easeInQuad' },
                { f: at[4]!, v: sx * (restX + 14) },
              ],
              'linear',
            ),
            track(
              'translateY',
              'percentOfCanvas',
              [
                { f: at[0]!, v: sy * (restY + 14), ease: 'hold' },
                { f: at[1]!, v: sy * (restY + 14), ease: 'easeOutBack' },
                { f: at[2]!, v: sy * restY, ease: 'hold' },
                { f: at[3]!, v: sy * restY, ease: 'easeInQuad' },
                { f: at[4]!, v: sy * (restY + 14) },
              ],
              'linear',
            ),
            track(
              'opacity',
              'ratio',
              [
                { f: at[0]!, v: 0, ease: 'hold' },
                { f: at[1]!, v: 0, ease: 'easeOutQuad' },
                { f: at[2]!, v: 1, ease: 'hold' },
                { f: at[3]!, v: 1, ease: 'easeInQuad' },
                { f: at[4]!, v: 0 },
              ],
              'linear',
            ),
          ],
        })
        layers.push(bar(true), bar(false))
      })

      return { layers, durationFrames: span, loopMode: 'loop', fps }
    },
  },
]
