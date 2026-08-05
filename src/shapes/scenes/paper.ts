/**
 * 종이와 띠.
 *
 * 레퍼런스에서 되풀이되는 "납작한 것이 여러 장 움직이는" 문법이다. 패널(panel.ts)이
 * 화면을 칸으로 나누는 쪽이라면 이쪽은 낱장이 각자 움직이는 쪽이다.
 *
 *   카드 부채꼴  : 카드가 날아와 부채꼴로 펼쳐진다        (낱장)
 *   병풍 열림    : 세로 판이 경첩을 축으로 차례로 펴진다  (접힘)
 *   사선 테이프  : 빗금 띠가 화면을 가로질러 지나간다     (전환)
 *   흐르는 띠    : 빗금 띠가 이음새 없이 계속 흐른다      (반복)
 *
 * 빗금은 왜 ticks 인가
 *
 * 경고 테이프의 빗금을 도형 여러 장으로 만들면 열 몇 장이 더 생긴다. `ticks` 도형은
 * 한 장으로 일정 간격의 막대열을 그린다(core/renderer/shaders/shape.ts sdTicks).
 * 한 칸의 폭이 정확히 width / points 라, 그 폭만큼 밀면 이음새 없이 흐른다.
 * 흐르는 띠가 성립하는 근거가 이 숫자 하나다.
 */

import { createShapeSpec, shiftColor, withAlpha } from '@/core/shape.ts'
import type { SceneLayer, ShapeScene } from '../types.ts'
import { atRatio, fixed, gain, pct, pick, stops, timingOf, track } from '../shared.ts'

/**
 * 빗금 띠 한 장의 치수.
 *
 * 화면 대각선보다 길어야 한다. 기울여 놓으면 가로 폭만으로는 모자라서 띠 끝이
 * 화면 안에서 보인다. 칸 수는 폭에 비례해 잡아야 어느 캔버스에서도 빗금 간격이
 * 비슷해 보인다.
 */
function tapeSize(canvasW: number, canvasH: number, thickness: number): {
  width: number
  height: number
  cells: number
} {
  const width = Math.round(Math.hypot(canvasW, canvasH) * 1.5)
  const height = Math.max(6, Math.round(canvasH * thickness))
  // 한 칸이 띠 두께의 1.1 배쯤 되게. 빗금이 45도로 보이는 비율이다.
  const cells = Math.max(4, Math.round(width / Math.max(4, height * 1.1)))
  return { width, height, cells }
}

export const PAPER_SCENES: ShapeScene[] = [
  {
    id: 'stage.cardFan',
    label: '카드 부채꼴',
    hint: '카드가 아래에서 날아와 부채꼴로 펼쳐진 뒤 다시 모입니다.',
    group: 'stage',
    defaultDurationMs: 2800,
    emit(ctx) {
      const { span, fps } = timingOf(ctx, this.defaultDurationMs)
      const g = gain(ctx.strength)
      const count = 5
      // 부채의 벌어짐. 세기가 이 각도를 정한다.
      const sweep = Math.min(70, 22 * g * count * 0.4)
      const cardW = Math.round(ctx.canvasW * 0.19)
      const cardH = Math.round(cardW * 1.45)
      // 부채꼴은 아래 한 점을 축으로 돈다. 카드를 그 위로 올려 두어야 손에 쥔 모양이 된다.
      const lift = ctx.canvasH * 0.1

      const layers: SceneLayer[] = []
      for (let i = 0; i < count; i += 1) {
        const mid = (count - 1) / 2
        const angle = ((i - mid) / Math.max(1, mid)) * sweep
        // 가운데 카드가 가장 높다. 부채를 쥐면 바깥 카드가 아래로 처진다.
        const drop = Math.abs(i - mid) / Math.max(1, mid)
        const y = -lift + drop * cardH * 0.12

        // 뒤에서부터 한 장씩 늦게 출발한다. 전체의 3할 안에서 다 나온다.
        const delay = (i / count) * 0.3
        const at = stops(span, [0, delay, delay + 0.34, 0.78, 1])

        layers.push({
          name: `카드 ${i + 1}`,
          shape: createShapeSpec('rect', {
            color: withAlpha(shiftColor(ctx.color, pick([0, -0.12, -0.24], i)), 1),
            width: cardW,
            height: cardH,
            cornerRadius: Math.max(2, Math.round(cardW * 0.09)),
          }),
          // 회전축이 카드 아래 끝이다. 한복판을 돌리면 부채가 아니라 바람개비가 된다.
          anchor: [0.5, 1],
          tracks: [
            fixed('translateX', 'percentOfCanvas', 0),
            track(
              'translateY',
              'percentOfCanvas',
              [
                // 화면 아래 밖에서 출발한다.
                { f: at[0]!, v: 70, ease: 'hold' },
                { f: at[1]!, v: 70, ease: 'easeOutQuint' },
                { f: at[2]!, v: pct(y / ctx.canvasH), ease: 'hold' },
                { f: at[3]!, v: pct(y / ctx.canvasH), ease: 'easeInQuad' },
                { f: at[4]!, v: 70 },
              ],
              'linear',
            ),
            track(
              'rotate',
              'deg',
              [
                { f: at[0]!, v: 0, ease: 'hold' },
                { f: at[1]!, v: 0, ease: 'easeOutBack' },
                { f: at[2]!, v: angle, ease: 'hold' },
                { f: at[3]!, v: angle, ease: 'easeInQuad' },
                { f: at[4]!, v: 0 },
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
      return { layers, durationFrames: span, loopMode: 'loop', fps }
    },
  },

  {
    id: 'stage.screen',
    label: '병풍 열림',
    hint: '세로 판이 경첩을 축으로 차례로 펴지며 열립니다.',
    group: 'stage',
    defaultDurationMs: 2600,
    emit(ctx) {
      const { span, fps } = timingOf(ctx, this.defaultDurationMs)
      const g = gain(ctx.strength)
      const panels = 4
      const spread = Math.min(0.96, 0.8 * g)
      const panelW = Math.round((ctx.canvasW * spread) / panels)
      const panelH = Math.round(ctx.canvasH * spread)
      /*
       * 접힌 각도. 90 도를 넘기지 않는다. 넘기면 판이 뒤집혀 이웃 판을 가로지른다.
       * 병풍은 접혀도 판끼리 겹치지 언제나 같은 쪽을 향한다.
       */
      const fold = Math.min(85, 60 * g)

      const layers: SceneLayer[] = []
      for (let i = 0; i < panels; i += 1) {
        /*
         * 경첩이 판마다 번갈아 붙는다. 그것이 병풍과 여닫이문의 차이다.
         * 한쪽으로만 접으면 두루마리가 말리는 모양이 된다.
         */
        const hingeRight = i % 2 === 1
        const delay = (i / panels) * 0.32
        const at = stops(span, [0, delay, delay + 0.36, 0.8, 1])
        const x = ((i + 0.5) / panels - 0.5) * spread

        layers.push({
          name: `병풍 ${i + 1}`,
          shape: createShapeSpec('rect', {
            color: withAlpha(shiftColor(ctx.color, pick([0, -0.18], i)), 1),
            width: Math.max(2, panelW - 2),
            height: Math.max(2, panelH),
            cornerRadius: 1,
          }),
          // 경첩이 달린 변이 회전축이다. 한복판을 돌리면 판이 제자리에서 비틀린다.
          anchor: [hingeRight ? 1 : 0, 0.5],
          tracks: [
            fixed('translateX', 'percentOfCanvas', pct(x)),
            fixed('translateY', 'percentOfCanvas', 0),
            track(
              'rotateY',
              'deg',
              [
                { f: at[0]!, v: hingeRight ? fold : -fold, ease: 'hold' },
                { f: at[1]!, v: hingeRight ? fold : -fold, ease: 'easeOutQuint' },
                { f: at[2]!, v: 0, ease: 'hold' },
                { f: at[3]!, v: 0, ease: 'easeInQuad' },
                { f: at[4]!, v: hingeRight ? fold : -fold },
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
      return { layers, durationFrames: span, loopMode: 'loop', fps }
    },
  },

  {
    id: 'wipe.tape',
    label: '사선 테이프',
    hint: '빗금 친 경고 테이프가 화면을 비스듬히 가로질러 지나갑니다.',
    group: 'wipe',
    covers: true,
    defaultDurationMs: 2000,
    emit(ctx) {
      const { span, fps } = timingOf(ctx, this.defaultDurationMs)
      const g = gain(ctx.strength)
      const tilt = 20
      const bands = 2
      const { width, height, cells } = tapeSize(ctx.canvasW, ctx.canvasH, Math.min(0.3, 0.13 * g))
      // 한쪽 끝에서 반대쪽 끝까지. 띠가 화면보다 길어 양끝 다 밖에 있다.
      const travel = 160

      const layers: SceneLayer[] = []
      for (let i = 0; i < bands; i += 1) {
        // 두 띠가 반대 방향으로 지나간다. 같은 방향이면 한 장이 두꺼워진 것으로 보인다.
        const dir = i === 0 ? 1 : -1
        const y = i === 0 ? -0.13 : 0.13
        const delay = i * 0.12
        const at = stops(span, [0, delay, delay + 0.5, delay + 0.62, 1])

        const slide = (v: number) => [
          { f: at[0]!, v: -travel * dir, ease: 'hold' },
          { f: at[1]!, v: -travel * dir, ease: 'easeInOutQuart' },
          { f: at[2]!, v: 0, ease: 'easeInOutQuart' },
          { f: at[3]!, v: v * dir, ease: 'linear' },
          { f: at[4]!, v: travel * dir },
        ]

        // 바탕 띠와 그 위의 빗금. 두 장이라 색이 두 겹으로 겹친다.
        layers.push({
          name: `테이프 ${i + 1}`,
          shape: createShapeSpec('rect', {
            color: withAlpha(shiftColor(ctx.color, i === 0 ? 0 : -0.2), 1),
            width,
            height,
            cornerRadius: 0,
          }),
          tracks: [
            fixed('translateY', 'percentOfCanvas', pct(y)),
            fixed('rotate', 'deg', -tilt * dir),
            track('translateX', 'percentOfCanvas', slide(40), 'linear'),
          ],
        })
        layers.push({
          name: `테이프 빗금 ${i + 1}`,
          shape: createShapeSpec('ticks', {
            color: withAlpha(shiftColor(ctx.color, -0.72), 0.92),
            width,
            height,
            points: cells,
            // 칸의 절반만 채운다. 빗금과 바탕이 같은 폭이라야 경고 테이프로 읽힌다.
            innerRatio: 0.5,
            cornerRadius: 0,
          }),
          tracks: [
            fixed('translateY', 'percentOfCanvas', pct(y)),
            fixed('rotate', 'deg', -tilt * dir),
            track('translateX', 'percentOfCanvas', slide(40), 'linear'),
          ],
        })
      }
      return { layers, durationFrames: span, loopMode: 'loop', fps }
    },
  },

  {
    id: 'bars.marquee',
    label: '흐르는 띠',
    hint: '빗금 띠가 한 방향으로 끝없이 흘러갑니다. 이음새가 없습니다.',
    group: 'bars',
    defaultDurationMs: 1600,
    emit(ctx) {
      const { span, fps } = timingOf(ctx, this.defaultDurationMs)
      const g = gain(ctx.strength)
      const height = Math.max(8, Math.round(ctx.canvasH * Math.min(0.22, 0.1 * g)))
      /*
       * 띠는 캔버스보다 넉넉히 길다. 정확히 한 칸만 밀 것이라, 남는 길이가 한 칸보다
       * 크기만 하면 흐르는 동안 어느 쪽 끝도 화면에 들어오지 않는다.
       */
      const width = Math.round(ctx.canvasW * 2)
      const cells = Math.max(6, Math.round(width / Math.max(6, height * 1.6)))
      /*
       * 이음새의 근거. 한 칸의 폭이 정확히 width / cells 이므로, 그만큼 밀면 빗금이
       * 이전 칸의 자리에 정확히 겹친다. 첫 프레임과 마지막 프레임의 그림이 같다.
       */
      const cellPct = pct(width / cells / ctx.canvasW)

      return {
        layers: [
          {
            name: '띠 바탕',
            shape: createShapeSpec('rect', {
              color: withAlpha(shiftColor(ctx.color, -0.1), 1),
              width,
              height,
              cornerRadius: 0,
            }),
            tracks: [
              fixed('translateX', 'percentOfCanvas', 0),
              fixed('translateY', 'percentOfCanvas', atRatio(0.5)),
            ],
          },
          {
            name: '띠 빗금',
            shape: createShapeSpec('ticks', {
              color: withAlpha(shiftColor(ctx.color, -0.75), 0.9),
              width,
              height,
              points: cells,
              innerRatio: 0.5,
              cornerRadius: 0,
            }),
            tracks: [
              // 등속이어야 흐름이 일정하다. 가속을 넣으면 매 주기 시작에서 멈칫한다.
              track(
                'translateX',
                'percentOfCanvas',
                [{ f: 0, v: 0 }, { f: span, v: -cellPct }],
                'linear',
              ),
              fixed('translateY', 'percentOfCanvas', atRatio(0.5)),
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
