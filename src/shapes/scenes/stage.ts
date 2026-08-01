/**
 * 연출.
 *
 * 앞의 여섯 묶음이 "도형 하나가 어떻게 움직이는가" 였다면 이쪽은 **화면 하나를 어떻게
 * 여는가** 다. 양문이 열리고, 슬랫이 쌓이고, 살이 하나씩 돋고, 카드가 격자로 채워진다.
 * 방송 자막과 컷인에서 늘 보는 그 구성들이다.
 *
 * 두 가지 새 재료를 쓴다. 둘 다 이 묶음을 위해 엔진에 들어간 것이다.
 *
 *   - **가리기.** 도형은 제자리에 있고 경계선만 지나간다 (core/types.ts RevealSpec).
 *     시계 모양을 테두리만 남긴 도형에 걸면 **선이 그려지는** 모양이 나온다.
 *     예전에는 이걸 흉내내려고 부채꼴을 여러 장 겹쳐야 했다.
 *   - **새 도형 세 종.** 방사살 / 눈금 / 별빛. 살 스무 개를 rect 스무 장으로 만들면
 *     레이어 패널이 잠기고 파일도 그만큼 커진다.
 *
 * 규칙은 다른 묶음과 같다. Math.random / Date.now 를 쓰지 않고, 색은 ctx.color 에서
 * 계열을 만들고, 세기는 크기에만 속도는 시간에만 작용한다.
 *
 * 여기에 하나가 더 붙는다. **모든 레이어가 주기 끝에서 보이지 않는 상태로 돌아가야
 * 한다.** 이 묶음은 전부 loop 이고, 재생기는 마지막 프레임 다음에 0 프레임을 잇는다.
 * 다 그려진 채로 끝나는 레이어가 하나라도 있으면 그 자리에서 화면이 한 번 튄다.
 * 가리기 트랙을 0 으로 되돌리든 투명도를 0 으로 내리든, 끝은 반드시 비어 있어야 한다.
 */

import { createRevealSpec } from '@/core/reveal.ts'
import { createShapeSpec, shiftColor, withAlpha } from '@/core/shape.ts'
import type { SceneLayer, ShapeScene } from '../types.ts'
import { fixed, gain, pick, slot, stops, timingOf, track } from '../shared.ts'

/** 되돌아오지 않는 모션이 끝나는 자리. */
function lastFrame(span: number): number {
  return Math.max(1, span - 1)
}

/**
 * 열렸다 닫히는 가리기 트랙.
 *
 * **반드시 0 으로 돌아와야 한다.** 이 묶음은 전부 loop 이고 재생기는 마지막 프레임
 * 다음에 0 프레임을 잇는다(core/time.ts). 다 드러난 채로 끝나면 그 자리에서 화면이
 * 튀고, 제품의 이음새 검사기(core/loopSeam.ts)가 사용자에게 경고를 띄운다.
 * 투명도가 이미 0 이라 눈에 안 보이더라도 마찬가지다.
 *
 * frames 는 [열기 시작, 열기 끝, 닫기 시작, 닫기 끝] 네 개다.
 * 진행률은 언제나 등속이다. 가속을 넣으면 경계선이 화면 가운데서 멈칫한다.
 */
function revealTrack(frames: readonly [number, number, number, number]) {
  return track(
    'reveal',
    'ratio',
    [
      { f: frames[0], v: 0, ease: 'linear' },
      { f: frames[1], v: 1, ease: 'hold' },
      { f: frames[2], v: 1, ease: 'linear' },
      { f: frames[3], v: 0 },
    ],
    'linear',
  )
}

export const STAGE_SCENES: ShapeScene[] = [
  {
    id: 'stage.doors',
    label: '양문 열림',
    hint: '가운데 판이 좌우로 갈라지며 뒤에 있던 판이 드러납니다.',
    group: 'stage',
    defaultDurationMs: 1800,
    emit(ctx) {
      const { span, fps } = timingOf(ctx, this.defaultDurationMs)
      const g = gain(ctx.strength)
      const cardW = Math.round(ctx.canvasW * 0.52)
      const cardH = Math.round(ctx.canvasH * 0.62)
      const doorW = Math.round(cardW / 2)
      // 문이 밀려나는 거리. 세기가 이 값을 정한다.
      const travel = Math.min(60, 26 * g)

      const at = stops(span, [0, 0.2, 0.62, 0.82, 1])
      const layers: SceneLayer[] = [
        {
          name: '드러나는 판',
          shape: createShapeSpec('rect', {
            color: withAlpha(shiftColor(ctx.color, -0.55), 1),
            width: cardW,
            height: cardH,
            cornerRadius: 6,
          }),
          reveal: createRevealSpec('splitX', { softness: 0.03 }),
          tracks: [
            revealTrack([at[1]!, at[2]!, at[3]!, at[4]!]),
            track(
              'opacity',
              'ratio',
              [
                { f: at[0]!, v: 0, ease: 'hold' },
                { f: at[1]!, v: 1, ease: 'hold' },
                { f: at[3]!, v: 1, ease: 'easeInExpo' },
                { f: at[4]!, v: 0 },
              ],
              'linear',
            ),
          ],
        },
      ]

      for (const side of [-1, 1] as const) {
        layers.push({
          name: side < 0 ? '왼쪽 문' : '오른쪽 문',
          shape: createShapeSpec('rect', {
            color: withAlpha(ctx.color, 1),
            width: doorW,
            height: cardH,
            cornerRadius: 4,
          }),
          tracks: [
            track(
              'translateX',
              'percentOfCanvas',
              [
                { f: at[0]!, v: ((doorW / 2) / ctx.canvasW) * 100 * side, ease: 'hold' },
                { f: at[1]!, v: ((doorW / 2) / ctx.canvasW) * 100 * side, ease: 'easeInOutQuart' },
                { f: at[2]!, v: (((doorW / 2) / ctx.canvasW) * 100 + travel) * side, ease: 'hold' },
                { f: at[3]!, v: (((doorW / 2) / ctx.canvasW) * 100 + travel) * side, ease: 'easeInExpo' },
                { f: at[4]!, v: ((doorW / 2) / ctx.canvasW) * 100 * side },
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
    id: 'stage.slats',
    label: '가로 슬랫 쌓기',
    hint: '가로 막대가 가운데부터 차례로 벌어지며 쌓입니다.',
    group: 'stage',
    defaultDurationMs: 1900,
    emit(ctx) {
      const { span, fps } = timingOf(ctx, this.defaultDurationMs)
      const g = gain(ctx.strength)
      const count = 7
      const barH = Math.max(2, Math.round((ctx.canvasH * 0.5) / (count * 1.8)))
      const barW = Math.round(Math.min(ctx.canvasW * 1.6, ctx.canvasW * (0.5 + 0.35 * g)))
      const gapY = barH * 1.9

      const layers: SceneLayer[] = []
      for (let i = 0; i < count; i += 1) {
        // 가운데에서 바깥으로 퍼진다. 위에서 아래로 순서대로 쌓으면 블라인드가 되고,
        // 가운데부터 벌어져야 "펼쳐진다" 로 읽힌다.
        const rank = Math.abs(i - (count - 1) / 2)
        const delay = 0.06 * rank
        const at = stops(span, [0, delay, 0.34 + delay, 0.74, 0.86, 1])
        layers.push({
          name: `막대 ${i + 1}`,
          shape: createShapeSpec('rect', {
            color: withAlpha(shiftColor(ctx.color, i % 2 === 0 ? 0 : -0.25), 1),
            width: barW,
            height: barH,
            cornerRadius: 0,
          }),
          tracks: [
            fixed('translateY', 'percentOfCanvas', ((i - (count - 1) / 2) * gapY * 100) / ctx.canvasH),
            track(
              'scaleX',
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
    id: 'stage.pinwheel',
    label: '바람개비 살',
    hint: '둘레가 그려진 뒤 살이 시계 방향으로 하나씩 돋습니다.',
    group: 'stage',
    defaultDurationMs: 2400,
    emit(ctx) {
      const { span, fps } = timingOf(ctx, this.defaultDurationMs)
      const g = gain(ctx.strength)
      const size = Math.round(Math.min(ctx.canvasW, ctx.canvasH) * Math.min(0.86, 0.5 * g))
      const at = stops(span, [0, 0.34, 0.72, 0.88, 1])

      return {
        layers: [
          {
            name: '둘레',
            shape: createShapeSpec('circle', {
              color: withAlpha(ctx.color, 0.85),
              width: size,
              height: size,
              strokeWidth: Math.max(1, Math.round(size * 0.008)),
            }),
            reveal: createRevealSpec('clock', { softness: 0.01 }),
            tracks: [
              revealTrack([at[0]!, at[1]!, at[3]!, at[4]!]),
            ],
          },
          {
            name: '살',
            shape: createShapeSpec('burst', {
              color: withAlpha(ctx.color, 1),
              width: Math.round(size * 0.94),
              height: Math.round(size * 0.94),
              points: 18,
              innerRatio: 0.12,
              strokeWidth: Math.max(1, Math.round(size * 0.01)),
            }),
            reveal: createRevealSpec('clock', { softness: 0.005 }),
            tracks: [
              revealTrack([at[1]!, at[2]!, at[3]!, at[4]!]),
              track(
                'opacity',
                'ratio',
                [
                  { f: at[0]!, v: 0, ease: 'hold' },
                  { f: at[1]!, v: 1, ease: 'hold' },
                  { f: at[3]!, v: 1, ease: 'easeInExpo' },
                  { f: at[4]!, v: 0 },
                ],
                'linear',
              ),
            ],
          },
          {
            name: '가운데 점',
            shape: createShapeSpec('circle', {
              color: withAlpha(shiftColor(ctx.color, 0.4), 1),
              width: Math.max(3, Math.round(size * 0.05)),
              height: Math.max(3, Math.round(size * 0.05)),
            }),
            tracks: [
              track(
                'scale',
                'ratio',
                [
                  { f: at[0]!, v: 0.001, ease: 'easeOutQuint' },
                  { f: at[1]!, v: 1, ease: 'hold' },
                  { f: at[3]!, v: 1, ease: 'easeInExpo' },
                  { f: at[4]!, v: 0.001 },
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
    id: 'stage.dotline',
    label: '점에서 선으로',
    hint: '점 하나가 점선으로 늘어난 뒤 판이 좌우로 열립니다.',
    group: 'stage',
    defaultDurationMs: 2200,
    emit(ctx) {
      const { span, fps } = timingOf(ctx, this.defaultDurationMs)
      const g = gain(ctx.strength)
      const lineW = Math.round(ctx.canvasW * Math.min(0.9, 0.55 * g))
      const dot = Math.max(4, Math.round(ctx.canvasH * 0.035))
      const panelW = Math.round(lineW * 0.42)
      const panelH = Math.round(ctx.canvasH * 0.44)
      const at = stops(span, [0, 0.16, 0.4, 0.68, 0.86, 1])

      return {
        layers: [
          {
            name: '점',
            shape: createShapeSpec('circle', {
              color: withAlpha(shiftColor(ctx.color, 0.5), 1),
              width: dot,
              height: dot,
            }),
            tracks: [
              track(
                'scale',
                'ratio',
                [
                  { f: at[0]!, v: 0.001, ease: 'easeOutQuint' },
                  { f: at[1]!, v: 1.3, ease: 'easeInOutQuart' },
                  { f: at[2]!, v: 0.55, ease: 'hold' },
                  { f: at[4]!, v: 0.55, ease: 'easeInExpo' },
                  { f: at[5]!, v: 0.001 },
                ],
                'easeOutQuint',
              ),
            ],
          },
          {
            name: '점선',
            shape: createShapeSpec('ticks', {
              color: withAlpha(ctx.color, 0.9),
              width: lineW,
              height: Math.max(2, Math.round(dot * 0.42)),
              points: 13,
              innerRatio: 0.42,
              cornerRadius: 8,
            }),
            reveal: createRevealSpec('splitX', { softness: 0.02 }),
            tracks: [
              revealTrack([at[1]!, at[2]!, at[4]!, at[5]!]),
              track(
                'opacity',
                'ratio',
                [
                  { f: at[0]!, v: 0, ease: 'hold' },
                  { f: at[1]!, v: 1, ease: 'hold' },
                  { f: at[4]!, v: 1, ease: 'easeInExpo' },
                  { f: at[5]!, v: 0 },
                ],
                'linear',
              ),
            ],
          },
          ...([-1, 1] as const).map<SceneLayer>((side) => ({
            name: side < 0 ? '왼쪽 판' : '오른쪽 판',
            anchor: [side < 0 ? 1 : 0, 0.5],
            shape: createShapeSpec('rect', {
              color: withAlpha(shiftColor(ctx.color, -0.35), 1),
              width: panelW,
              height: panelH,
              cornerRadius: 3,
            }),
            tracks: [
              fixed('translateX', 'percentOfCanvas', ((panelW / 2 + 2) / ctx.canvasW) * 100 * side),
              track(
                'scaleX',
                'ratio',
                [
                  { f: at[0]!, v: 0.001, ease: 'hold' },
                  { f: at[2]!, v: 0.001, ease: 'easeOutQuint' },
                  { f: at[3]!, v: 1, ease: 'hold' },
                  { f: at[4]!, v: 1, ease: 'easeInExpo' },
                  { f: at[5]!, v: 0.001 },
                ],
                'easeOutQuint',
              ),
            ],
          })),
        ],
        durationFrames: span,
        loopMode: 'loop',
        fps,
      }
    },
  },

  {
    id: 'stage.hud',
    label: '조준선',
    hint: '위아래 호가 그려지고 가운데에 십자와 원이 잡힙니다.',
    group: 'stage',
    defaultDurationMs: 2200,
    emit(ctx) {
      const { span, fps } = timingOf(ctx, this.defaultDurationMs)
      const g = gain(ctx.strength)
      const base = Math.round(Math.min(ctx.canvasW, ctx.canvasH) * Math.min(0.9, 0.56 * g))
      const at = stops(span, [0, 0.36, 0.62, 0.86, 1])
      const stroke = Math.max(1, Math.round(base * 0.006))

      const arcs: SceneLayer[] = ([0, 180] as const).map((deg, i) => ({
        name: i === 0 ? '위쪽 호' : '아래쪽 호',
        shape: createShapeSpec('arc', {
          color: withAlpha(ctx.color, 0.9),
          width: base,
          height: base,
          strokeWidth: stroke,
          sweepDeg: 120,
        }),
        reveal: createRevealSpec('clock', { softness: 0.01, angle: deg - 60 }),
        tracks: [
          fixed('rotate', 'deg', deg),
          revealTrack([at[0]!, at[1]!, at[3]!, at[4]!]),
        ],
      }))

      return {
        layers: [
          ...arcs,
          {
            name: '눈금 띠',
            shape: createShapeSpec('ticks', {
              color: withAlpha(ctx.color, 0.55),
              width: Math.round(base * 0.9),
              height: Math.max(2, Math.round(base * 0.03)),
              points: 21,
              innerRatio: 0.2,
            }),
            reveal: createRevealSpec('splitX', { softness: 0.05 }),
            tracks: [
              fixed('translateY', 'percentOfCanvas', ((base * 0.34) / ctx.canvasH) * 100),
              revealTrack([at[1]!, at[2]!, at[3]!, at[4]!]),
            ],
          },
          {
            name: '가운데 원',
            shape: createShapeSpec('circle', {
              color: withAlpha(ctx.color, 1),
              width: Math.round(base * 0.22),
              height: Math.round(base * 0.22),
              strokeWidth: stroke,
            }),
            tracks: [
              track(
                'scale',
                'ratio',
                [
                  { f: at[1]!, v: 0.001, ease: 'easeOutQuint' },
                  { f: at[2]!, v: 1, ease: 'hold' },
                  { f: at[3]!, v: 1, ease: 'easeInExpo' },
                  { f: at[4]!, v: 0.001 },
                ],
                'easeOutQuint',
              ),
            ],
          },
          {
            name: '십자',
            shape: createShapeSpec('cross', {
              color: withAlpha(shiftColor(ctx.color, 0.45), 1),
              width: Math.round(base * 0.14),
              height: Math.round(base * 0.14),
              innerRatio: 0.06,
            }),
            tracks: [
              track(
                'opacity',
                'ratio',
                [
                  { f: at[1]!, v: 0, ease: 'easeOutQuint' },
                  { f: at[2]!, v: 1, ease: 'hold' },
                  { f: at[3]!, v: 1, ease: 'easeInExpo' },
                  { f: at[4]!, v: 0 },
                ],
                'linear',
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
    id: 'stage.filmstrip',
    label: '카드 흘러가기',
    hint: '카드가 옆으로 흘러 들어와 나란히 멈춥니다.',
    group: 'stage',
    defaultDurationMs: 2000,
    emit(ctx) {
      const { span, fps } = timingOf(ctx, this.defaultDurationMs)
      const g = gain(ctx.strength)
      const count = 5
      const cardW = Math.round((ctx.canvasW * 0.86) / count) - 4
      const cardH = Math.round(ctx.canvasH * 0.46)
      const start = Math.min(140, 55 * g)
      const end = lastFrame(span)

      const layers: SceneLayer[] = []
      for (let i = 0; i < count; i += 1) {
        const delay = 0.07 * i
        // 마지막 두 자리는 사라지는 구간이다. 자리에 멈춘 채로 끝나면 다음 바퀴
        // 첫 프레임에서 카드 다섯 장이 한꺼번에 화면 밖으로 순간이동한다.
        const at = stops(end, [0, delay, 0.52 + delay, 0.84, 1])
        const home = slot(i, count, 0.86) * 100
        layers.push({
          name: `카드 ${i + 1}`,
          shape: createShapeSpec('rect', {
            color: withAlpha(shiftColor(ctx.color, pick([0, -0.22, -0.42, -0.22, 0.15], i)), 1),
            width: Math.max(2, cardW),
            height: cardH,
            cornerRadius: 3,
          }),
          reveal: createRevealSpec('down', { softness: 0.18 }),
          tracks: [
            track(
              'translateX',
              'percentOfCanvas',
              [
                { f: at[0]!, v: home + start, ease: 'hold' },
                { f: at[1]!, v: home + start, ease: 'easeOutQuint' },
                { f: at[2]!, v: home, ease: 'hold' },
                { f: at[3]!, v: home, ease: 'easeInExpo' },
                { f: at[4]!, v: home + start },
              ],
              'easeOutQuint',
            ),
            revealTrack([at[1]!, at[2]!, at[3]!, at[4]!]),
          ],
        })
      }
      return { layers, durationFrames: span, loopMode: 'loop', fps }
    },
  },

  {
    id: 'stage.rays',
    label: '빛 커튼',
    hint: '가운데에서 뻗은 빛살이 천천히 돌며 밝아졌다 사그라듭니다.',
    group: 'stage',
    defaultDurationMs: 3200,
    emit(ctx) {
      const { span, fps } = timingOf(ctx, this.defaultDurationMs)
      const g = gain(ctx.strength)
      // 빛살은 화면 밖까지 뻗어야 커튼으로 읽힌다. 다만 캔버스의 두 배를 넘기면
      // 도형 크기 상한(4000px)에 닿기 쉬우므로 거기서 끊는다.
      const size = Math.round(
        Math.min(
          Math.hypot(ctx.canvasW, ctx.canvasH) * Math.min(1.4, 0.75 * g),
          ctx.canvasW * 1.9,
          ctx.canvasH * 1.9,
        ),
      )
      const at = stops(span, [0, 0.3, 0.62, 1])

      return {
        layers: [
          {
            name: '빛살',
            shape: createShapeSpec('burst', {
              color: withAlpha(shiftColor(ctx.color, 0.35), 0.35),
              width: size,
              height: size,
              points: 24,
              innerRatio: 0.02,
              strokeWidth: Math.max(2, Math.round(size * 0.012)),
            }),
            blend: 'screen',
            tracks: [
              /*
               * 한 방향으로만 돌리면 주기 끝에서 각도가 첫 값으로 돌아오지 않는다.
               * 살 24개라 15도마다 같은 그림이지만 이음새 검사기는 그걸 모르고,
               * 무엇보다 사용자가 살 개수를 바꾸는 순간 진짜로 튄다. 왕복이 안전하다.
               */
              track(
                'rotate',
                'deg',
                [
                  { f: at[0]!, v: 0, ease: 'easeInOutQuart' },
                  { f: at[2]!, v: 14, ease: 'easeInOutQuart' },
                  { f: at[3]!, v: 0 },
                ],
                'easeInOutQuart',
              ),
              track(
                'opacity',
                'ratio',
                [
                  { f: at[0]!, v: 0, ease: 'easeInOutQuart' },
                  { f: at[1]!, v: 1, ease: 'easeInOutQuart' },
                  { f: at[2]!, v: 0.55, ease: 'easeInOutQuart' },
                  { f: at[3]!, v: 0 },
                ],
                'easeInOutQuart',
              ),
            ],
          },
          {
            name: '가운데 빛',
            shape: createShapeSpec('circle', {
              color: withAlpha(shiftColor(ctx.color, 0.7), 0.5),
              width: Math.round(size * 0.16),
              height: Math.round(size * 0.16),
            }),
            blend: 'screen',
            tracks: [
              track(
                'scale',
                'ratio',
                [
                  { f: at[0]!, v: 0.3, ease: 'easeInOutQuart' },
                  { f: at[1]!, v: 1, ease: 'easeInOutQuart' },
                  { f: at[3]!, v: 0.3 },
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
    id: 'stage.sparkles',
    label: '별빛 터지기',
    hint: '뾰족한 별빛이 시간차를 두고 반짝 나타났다 사라집니다.',
    group: 'stage',
    defaultDurationMs: 2000,
    emit(ctx) {
      const { span, fps } = timingOf(ctx, this.defaultDurationMs)
      const g = gain(ctx.strength)
      const count = 6
      const base = Math.round(Math.min(ctx.canvasW, ctx.canvasH) * Math.min(0.5, 0.16 * g))
      const xs = [-0.3, 0.26, -0.12, 0.34, 0.04, -0.36]
      const ys = [-0.24, -0.3, 0.18, 0.1, -0.05, 0.3]

      const layers: SceneLayer[] = []
      for (let i = 0; i < count; i += 1) {
        const delay = (0.72 * i) / count
        const at = stops(span, [0, delay, delay + 0.14, delay + 0.28, 1])
        const scale = 0.55 + 0.45 * ((i % 3) / 2)
        layers.push({
          name: `별빛 ${i + 1}`,
          shape: createShapeSpec('sparkle', {
            color: withAlpha(shiftColor(ctx.color, i % 2 === 0 ? 0.35 : 0), 1),
            width: Math.max(4, Math.round(base * scale)),
            height: Math.max(4, Math.round(base * scale)),
            points: i % 2 === 0 ? 4 : 6,
            innerRatio: 0.22,
          }),
          tracks: [
            fixed('translateX', 'percentOfCanvas', pick(xs, i) * 100),
            fixed('translateY', 'percentOfCanvas', pick(ys, i) * 100),
            track(
              'scale',
              'ratio',
              [
                { f: at[0]!, v: 0.001, ease: 'hold' },
                { f: at[1]!, v: 0.001, ease: 'easeOutQuint' },
                { f: at[2]!, v: 1, ease: 'easeInExpo' },
                { f: at[3]!, v: 0.001, ease: 'hold' },
                { f: at[4]!, v: 0.001 },
              ],
              'easeOutQuint',
            ),
            /*
             * 반짝이는 동안만 돈다. 주기 끝에서 첫 각도로 돌아와야 반복에서 튀지 않는다.
             * 크기가 0 인 구간이라 되돌아가는 것은 화면에 보이지 않는다.
             */
            track(
              'rotate',
              'deg',
              [
                { f: at[0]!, v: -20, ease: 'hold' },
                { f: at[1]!, v: -20, ease: 'linear' },
                { f: at[3]!, v: 20, ease: 'hold' },
                { f: at[4]!, v: -20 },
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
    id: 'stage.cards',
    label: '격자 카드',
    hint: '카드가 격자를 채우며 위에서 아래로 한 장씩 드러납니다.',
    group: 'stage',
    defaultDurationMs: 2400,
    emit(ctx) {
      const { span, fps } = timingOf(ctx, this.defaultDurationMs)
      const g = gain(ctx.strength)
      const cols = 3
      const rows = 2
      const spread = Math.min(0.94, 0.62 * g)
      const cardW = Math.round((ctx.canvasW * spread) / cols) - 3
      const cardH = Math.round((ctx.canvasH * spread) / rows) - 3

      const layers: SceneLayer[] = []
      for (let r = 0; r < rows; r += 1) {
        for (let c = 0; c < cols; c += 1) {
          const i = r * cols + c
          const delay = 0.055 * i
          const at = stops(span, [0, delay, 0.38 + delay, 0.84, 1])
          layers.push({
            name: `카드 ${i + 1}`,
            shape: createShapeSpec('rect', {
              color: withAlpha(shiftColor(ctx.color, pick([0, -0.3, -0.5], i)), 1),
              width: Math.max(2, cardW),
              height: Math.max(2, cardH),
              cornerRadius: 2,
            }),
            reveal: createRevealSpec('down', { softness: 0.06 }),
            tracks: [
              fixed('translateX', 'percentOfCanvas', slot(c, cols, spread) * 100),
              fixed('translateY', 'percentOfCanvas', slot(r, rows, spread) * 100),
              revealTrack([at[1]!, at[2]!, at[3]!, at[4]!]),
              track(
                'opacity',
                'ratio',
                [
                  { f: at[0]!, v: 0, ease: 'hold' },
                  { f: at[1]!, v: 1, ease: 'hold' },
                  { f: at[3]!, v: 1, ease: 'easeInExpo' },
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
    id: 'stage.frameDraw',
    label: '네모 테두리 그려지기',
    hint: '네모 테두리가 열두 시부터 한 바퀴 돌며 그려집니다.',
    group: 'stage',
    defaultDurationMs: 2400,
    emit(ctx) {
      const { span, fps } = timingOf(ctx, this.defaultDurationMs)
      const g = gain(ctx.strength)
      const w = Math.round(ctx.canvasW * Math.min(0.94, 0.6 * g))
      const h = Math.round(ctx.canvasH * Math.min(0.94, 0.42 * g))
      const at = stops(span, [0, 0.46, 0.72, 0.92, 1])

      return {
        layers: [
          {
            name: '테두리',
            shape: createShapeSpec('rect', {
              color: withAlpha(ctx.color, 1),
              width: w,
              height: h,
              strokeWidth: Math.max(1, Math.round(Math.min(w, h) * 0.012)),
              cornerRadius: 0,
            }),
            // 시계 모양은 테두리만 남긴 도형에서 "선이 그려지는" 모양이 된다.
            reveal: createRevealSpec('clock', { softness: 0.006 }),
            tracks: [
              track(
                'reveal',
                'ratio',
                [
                  { f: at[0]!, v: 0, ease: 'linear' },
                  { f: at[1]!, v: 1, ease: 'linear' },
                  { f: at[3]!, v: 1, ease: 'linear' },
                  { f: at[4]!, v: 0 },
                ],
                'linear',
              ),
            ],
          },
          {
            name: '모서리 눈금',
            shape: createShapeSpec('ticks', {
              color: withAlpha(shiftColor(ctx.color, 0.4), 0.85),
              width: Math.round(w * 0.5),
              height: Math.max(2, Math.round(h * 0.03)),
              points: 9,
              innerRatio: 0.3,
            }),
            tracks: [
              fixed('translateY', 'percentOfCanvas', ((h / 2 + h * 0.06) / ctx.canvasH) * 100),
              track(
                'opacity',
                'ratio',
                [
                  { f: at[0]!, v: 0, ease: 'hold' },
                  { f: at[1]!, v: 0, ease: 'easeOutQuint' },
                  { f: at[2]!, v: 1, ease: 'hold' },
                  { f: at[3]!, v: 1, ease: 'easeInExpo' },
                  { f: at[4]!, v: 0 },
                ],
                'linear',
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
