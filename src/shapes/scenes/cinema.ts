/**
 * 영상 느낌.
 *
 * 애니메이션 엔딩 영상에서 따온 여섯 가지 연출이다. 참고한 화면은 전부 같은 문법을
 * 쓴다. 주인공은 거의 멈춰 있고, **주변의 것들이 날아다닌다.** 잉크가 튀고, 파편이
 * 떠다니고, 선이 감아 돌고, 물감이 흘러내리고, 검은 덩어리가 앞을 휙 지나가고,
 * 임팩트 프레임이 한 순간 터진다.
 *
 * 그림을 그대로 베끼지 않는다. 베끼는 것은 **움직임의 문법**이다.
 *   - 같은 종류의 조각이라도 크기 / 위상 / 속도를 표로 흩뜨린다. 도장을 찍은 듯
 *     똑같으면 영상이 아니라 패턴으로 보인다.
 *   - 빠른 것은 잔상(에코 레이어)을 데리고 다닌다. 실제 영상의 모션 블러를
 *     레이어 두 장의 시간차로 흉내 낸다.
 *   - 한 순간짜리 사건(터짐, 튀김)은 주기의 앞머리에 몰아넣고 나머지는 비워 둔다.
 *     화면이 쉬는 구간이 있어야 사건이 사건으로 읽힌다.
 *
 * 다른 장면 파일과 같은 규칙을 지킨다. 순수 함수, 표 기반 결정론, cycle/stream 의
 * 닫힌 주기(이어 붙이기와 무한 반복에서 이음새가 없다).
 */

import { createShapeSpec, shiftColor, withAlpha } from '@/core/shape.ts'
import type { SceneLayer, ShapeScene } from '../types.ts'
import { atRatio, clamp, clamp01, cycle, easeOut, fixed, gain, pick, stream, timingOf, track } from '../shared.ts'

// ---------------------------------------------------------------------------
// 잉크 튀김
// ---------------------------------------------------------------------------

/** 잉크 방울이 날아가는 각도(도). 고르게 퍼지되 정확히 등간격은 피한다. */
const INK_ANGLES = [12, 57, 96, 148, 191, 235, 283, 322, 34, 260]
/** 방울마다 다른 크기 배수. */
const INK_SIZES = [1, 0.55, 0.8, 1.3, 0.65, 0.9, 1.15, 0.5, 0.72, 1.05]
/** 방울마다 다른 사거리 배수. */
const INK_REACH = [1, 1.25, 0.8, 1.1, 0.9, 1.35, 0.7, 1.2, 1.0, 0.85]

/** 도를 라디안으로. */
const rad = (deg: number): number => (deg * Math.PI) / 180

// ---------------------------------------------------------------------------
// 부유 파편
// ---------------------------------------------------------------------------

/**
 * 파편의 자리(0~1 비율 좌표). 가운데는 비워 둔다.
 * 이 세트는 주인공 **주변**을 채우는 것이고, 얼굴 위를 조각이 지나가면 장식이 아니라
 * 방해가 된다.
 */
const DEBRIS_SPOTS: readonly [number, number][] = [
  [0.12, 0.16], [0.85, 0.12], [0.08, 0.55], [0.92, 0.48],
  [0.18, 0.85], [0.8, 0.88], [0.35, 0.08], [0.65, 0.92],
  [0.05, 0.32], [0.94, 0.7], [0.28, 0.94], [0.72, 0.05],
]
const DEBRIS_SIZES = [1, 0.6, 1.35, 0.75, 1.1, 0.5, 0.9, 1.2, 0.65, 1.0, 0.8, 1.25]
/** 조각마다 다른 흔들림 반경 배수. */
const DEBRIS_DRIFT = [1, 1.4, 0.7, 1.2, 0.9, 1.5, 0.8, 1.1, 1.3, 0.6, 1.0, 1.25]

// ---------------------------------------------------------------------------
// 흘러내림
// ---------------------------------------------------------------------------

const DRIP_X = [0.08, 0.21, 0.33, 0.45, 0.58, 0.71, 0.84, 0.94]
const DRIP_DELAY = [0, 0.37, 0.62, 0.14, 0.81, 0.48, 0.26, 0.7]
const DRIP_WIDTH = [1, 0.6, 1.4, 0.8, 1.15, 0.7, 1.25, 0.9]
const DRIP_LENGTH = [1, 0.65, 1.3, 0.85, 1.15, 0.75, 1.4, 0.95]
/** 방울이 떨어지기 시작하는 가로 자리. 줄기와 같은 표를 쓰되 절반만 쓴다. */
const DROP_X = [0.21, 0.58, 0.84, 0.33, 0.71]
const DROP_DELAY = [0.2, 0.55, 0.85, 0.4, 0.05]

// ---------------------------------------------------------------------------
// 임팩트 프레임
// ---------------------------------------------------------------------------

const SPARK_ANGLES = [25, 95, 160, 205, 275, 340]
const SPARK_SIZES = [1, 0.7, 1.2, 0.8, 1.1, 0.6]

export const CINEMA_SCENES: ShapeScene[] = [
  {
    id: 'cinema.inkBurst',
    label: '잉크 튀김',
    hint: '잉크 방울들이 가운데서 사방으로 확 튀고, 꼬리 방울이 따라갑니다.',
    group: 'cinema',
    defaultDurationMs: 2000,
    emit(ctx) {
      const { span, fps } = timingOf(ctx, this.defaultDurationMs)
      const g = gain(ctx.strength)
      const base = Math.min(ctx.canvasW, ctx.canvasH)

      /*
       * 사건은 주기의 앞 65% 에 몰아넣는다. 튀김 -> 감속 -> 소멸 뒤에 빈 구간이
       * 남아야 반복될 때 "또 튀었다" 로 읽힌다. 내내 움직이면 튀김이 아니라
       * 끓는 것으로 보인다.
       */
      const launch = (x: number): number => easeOut(clamp01(x / 0.62), 2.6)
      const fadeAt = (x: number, from: number, to: number): number =>
        x <= from ? 1 : x >= to ? 0 : 1 - (x - from) / (to - from)

      const layers: SceneLayer[] = []
      for (let i = 0; i < 10; i += 1) {
        const a = rad(pick(INK_ANGLES, i, 0))
        const size = Math.max(4, Math.round(base * 0.075 * pick(INK_SIZES, i, 1)))
        // 사거리는 세기가 정한다. 세기 0.5 에서 캔버스의 약 34% 를 날아간다.
        const reach = 34 * g * pick(INK_REACH, i, 1)
        layers.push({
          name: `잉크 방울 ${i + 1}`,
          shape: createShapeSpec('circle', {
            // 방울마다 명도를 조금씩 흔들어야 한 덩어리 먹물로 안 보인다.
            color: withAlpha(shiftColor(ctx.color, (i % 3) * 0.09 - 0.09), 0.95),
            width: size,
            height: size,
          }),
          tracks: [
            cycle({
              prop: 'translateX',
              unit: 'percentOfCanvas',
              span,
              phase: 0,
              at: (x) => Math.cos(a) * reach * launch(x),
              steps: 12,
            }),
            cycle({
              prop: 'translateY',
              unit: 'percentOfCanvas',
              span,
              phase: 0,
              at: (x) => Math.sin(a) * reach * launch(x),
              steps: 12,
            }),
            // 터질 때 부풀었다가 날아가며 줄어든다. 잉크가 공기에 흩어지는 인상이다.
            cycle({
              prop: 'scale',
              unit: 'ratio',
              span,
              phase: 0,
              at: (x) => clamp(0.35 + 0.95 * Math.min(1, x * 9) - 0.5 * launch(x), 0.2, 1.6),
              steps: 12,
            }),
            cycle({
              prop: 'opacity',
              unit: 'ratio',
              span,
              phase: 0,
              at: (x) => (x < 0.04 ? x / 0.04 : fadeAt(x, 0.42, 0.72)),
              steps: 16,
            }),
          ],
        })
      }

      // 꼬리 방울. 본 방울보다 늦게 출발해 더 멀리 가는 작은 점이 튀김의 속도감을 만든다.
      for (let i = 0; i < 6; i += 1) {
        const a = rad(pick(INK_ANGLES, i * 2 + 1, 0) + 9)
        const size = Math.max(3, Math.round(base * 0.028 * pick(INK_SIZES, i + 3, 1)))
        const reach = 46 * g * pick(INK_REACH, i + 5, 1)
        const shifted = (x: number): number => launch(clamp01((x - 0.07) / 0.93))
        layers.push({
          name: `잉크 꼬리 ${i + 1}`,
          shape: createShapeSpec('circle', {
            color: withAlpha(ctx.color, 0.8),
            width: size,
            height: size,
          }),
          tracks: [
            cycle({
              prop: 'translateX',
              unit: 'percentOfCanvas',
              span,
              phase: 0,
              at: (x) => Math.cos(a) * reach * shifted(x),
              steps: 12,
            }),
            cycle({
              prop: 'translateY',
              unit: 'percentOfCanvas',
              span,
              phase: 0,
              at: (x) => Math.sin(a) * reach * shifted(x),
              steps: 12,
            }),
            cycle({
              prop: 'opacity',
              unit: 'ratio',
              span,
              phase: 0,
              at: (x) => (x < 0.09 ? 0 : fadeAt(x, 0.35, 0.6)),
              steps: 16,
            }),
          ],
        })
      }
      return { layers, durationFrames: span, loopMode: 'loop', fps }
    },
  },

  {
    id: 'cinema.debrisFloat',
    label: '부유 파편',
    hint: '각진 조각들이 가장자리에서 천천히 떠다니며 돌아, 멈춘 그림에 공기가 생깁니다.',
    group: 'cinema',
    defaultDurationMs: 4600,
    emit(ctx) {
      const { span, fps } = timingOf(ctx, this.defaultDurationMs)
      const g = gain(ctx.strength)
      const base = Math.min(ctx.canvasW, ctx.canvasH)
      const kinds = ['triangle', 'rect', 'cross', 'polygon'] as const

      const layers: SceneLayer[] = DEBRIS_SPOTS.map((spot, i) => {
        const size = Math.max(4, Math.round(base * 0.05 * pick(DEBRIS_SIZES, i, 1)))
        const drift = 3.2 * g * pick(DEBRIS_DRIFT, i, 1)
        const phase = i / DEBRIS_SPOTS.length
        const dir = i % 2 === 0 ? 1 : -1
        const kind = kinds[i % kinds.length]!
        return {
          name: `파편 ${i + 1}`,
          shape: createShapeSpec(kind, {
            color: withAlpha(shiftColor(ctx.color, (i % 4) * 0.07 - 0.1), 0.62),
            width: size,
            // 정사각이면 도장으로 보인다. 조각마다 종횡비를 조금 흩뜨린다.
            height: Math.max(4, Math.round(size * (0.7 + 0.15 * (i % 3)))),
            ...(kind === 'rect' ? { cornerRadius: Math.round(size * 0.12) } : {}),
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
              phase: phase + 0.31,
              at: (x) => atRatio(spot[1]) + Math.sin(x * Math.PI * 2) * drift * 0.8,
              steps: 12,
            }),
            /*
             * 회전은 한 바퀴가 아니라 흔들림이다. 파편이 물에 뜬 것처럼 기울었다
             * 돌아온다. 한 바퀴를 돌리면 장식이 아니라 팽이가 된다.
             */
            cycle({
              prop: 'rotate',
              unit: 'deg',
              span,
              phase,
              at: (x) => (18 + 14 * pick(DEBRIS_DRIFT, i, 1)) * g * Math.sin(x * Math.PI * 2) * dir * 0.5,
              steps: 12,
            }),
            cycle({
              prop: 'scale',
              unit: 'ratio',
              span,
              phase: phase + 0.5,
              at: (x) => clamp(1 + 0.09 * g * Math.sin(x * Math.PI * 2), 0.2, 2),
              steps: 12,
            }),
          ],
        }
      })
      return { layers, durationFrames: span, loopMode: 'loop', fps }
    },
  },

  {
    id: 'cinema.swirlLines',
    label: '감아 도는 선',
    hint: '호 모양 선들이 화면 가운데를 서로 다른 속도로 감아 돕니다.',
    group: 'cinema',
    defaultDurationMs: 2600,
    emit(ctx) {
      const { span, fps } = timingOf(ctx, this.defaultDurationMs)
      const g = gain(ctx.strength)
      const base = Math.min(ctx.canvasW, ctx.canvasH)

      /** 호 하나와 그 잔상. [지름 배수, 쓸기 각도, 방향, 시작 각도, 두께 배수] */
      const arcs: readonly [number, number, number, number, number][] = [
        [0.62, 120, 1, 0, 1],
        [0.84, 95, -1, 140, 0.8],
        [1.06, 150, 1, 250, 1.2],
        [0.46, 80, -1, 60, 0.7],
      ]

      const layers: SceneLayer[] = []
      arcs.forEach(([mul, sweep, dir, start, thick], i) => {
        const dia = Math.round(base * mul)
        const stroke = Math.max(2, Math.round(base * 0.016 * thick))
        const phase = i / arcs.length
        /*
         * 본체와 잔상 두 장이 한 벌이다. 잔상은 몇 도 뒤에서 절반 투명도로 따라
         * 돈다. 실제 영상의 모션 블러가 남기는 꼬리를 레이어의 시간차로 흉내 낸다.
         */
        const echoes: readonly [string, number, number][] = [
          ['선', 0, 1],
          ['잔상', -16 * dir, 0.38],
        ]
        for (const [suffix, lag, alpha] of echoes) {
          layers.push({
            name: `감아 도는 ${suffix} ${i + 1}`,
            shape: createShapeSpec('arc', {
              color: withAlpha(shiftColor(ctx.color, i % 2 === 0 ? 0.08 : -0.06), alpha * 0.9),
              width: dia,
              height: dia,
              strokeWidth: stroke,
              sweepDeg: clamp(sweep, 5, 360),
            }),
            tracks: [
              /*
               * 한 바퀴는 정확히 span 에서 끝난다. 360도와 0도는 같은 그림이라
               * 이음새가 없고, span - 1 에 두면 마지막 프레임이 각도를 붙잡아
               * 주기마다 회전이 멈칫한다 (ambient.petals 의 규칙).
               */
              track(
                'rotate',
                'deg',
                [
                  { f: 0, v: start + lag, ease: 'linear' },
                  { f: span, v: start + lag + 360 * dir },
                ],
                'linear',
              ),
              // 숨쉬듯 밝아졌다 어두워진다. 상시 등속 회전만 있으면 기계 장치로 보인다.
              cycle({
                prop: 'opacity',
                unit: 'ratio',
                span,
                phase,
                at: (x) => clamp01(alpha * (0.55 + 0.45 * Math.sin(x * Math.PI * 2))),
                steps: 12,
              }),
              cycle({
                prop: 'scale',
                unit: 'ratio',
                span,
                phase: phase + 0.25,
                at: (x) => clamp(1 + 0.05 * g * Math.sin(x * Math.PI * 2), 0.2, 2),
                steps: 12,
              }),
            ],
          })
        }
      })
      return { layers, durationFrames: span, loopMode: 'loop', fps }
    },
  },

  {
    id: 'cinema.dripPaint',
    label: '흘러내림',
    hint: '위에서 물감 줄기가 자라며 흘러내리고, 방울이 똑똑 떨어집니다.',
    group: 'cinema',
    defaultDurationMs: 3600,
    emit(ctx) {
      const { span, fps } = timingOf(ctx, this.defaultDurationMs)
      const g = gain(ctx.strength)
      const base = Math.min(ctx.canvasW, ctx.canvasH)

      const layers: SceneLayer[] = []
      for (let i = 0; i < 8; i += 1) {
        const w = Math.max(4, Math.round(base * 0.042 * pick(DRIP_WIDTH, i, 1)))
        // 줄기 길이는 세기가 정한다. 세기 0.5 에서 화면의 약 38% 까지 내려온다.
        const h = Math.round(base * clamp(0.38 * g * pick(DRIP_LENGTH, i, 1), 0.1, 0.9))
        const delay = pick(DRIP_DELAY, i, 0)
        layers.push({
          name: `물감 줄기 ${i + 1}`,
          shape: createShapeSpec('rect', {
            color: withAlpha(shiftColor(ctx.color, (i % 3) * 0.08 - 0.08), 0.9),
            width: w,
            height: h,
            cornerRadius: Math.round(w / 2),
          }),
          // 줄기는 위 끝이 고정된 채 아래로 자라야 한다. 기준점을 위 변에 둔다.
          anchor: [0.5, 0],
          tracks: [
            fixed('translateX', 'percentOfCanvas', atRatio(pick(DRIP_X, i, 0.5))),
            // 기준점(위 끝)을 화면 위 변에 붙인다.
            fixed('translateY', 'percentOfCanvas', -50),
            /*
             * 자라기 -> 머물기 -> 사라지기가 한 주기다. 줄기마다 위상을 어긋내
             * 어떤 줄기는 자라는 중이고 어떤 줄기는 이미 길게 늘어져 있게 한다.
             * 참고 영상의 벽면이 정확히 이 상태다.
             */
            cycle({
              prop: 'scaleY',
              unit: 'ratio',
              span,
              phase: delay,
              at: (x) => clamp(0.12 + 0.88 * easeOut(clamp01(x / 0.7), 2.2), 0.1, 1),
              steps: 12,
            }),
            cycle({
              prop: 'opacity',
              unit: 'ratio',
              span,
              phase: delay,
              at: (x) => (x < 0.05 ? x / 0.05 : x < 0.78 ? 1 : x < 0.94 ? 1 - (x - 0.78) / 0.16 : 0),
              steps: 16,
            }),
          ],
        })
      }

      // 떨어지는 방울. 줄기 끝에서 화면 아래 밖으로 사라진다.
      for (let i = 0; i < 5; i += 1) {
        const size = Math.max(3, Math.round(base * 0.022 * pick(DRIP_WIDTH, i + 2, 1)))
        layers.push({
          name: `물감 방울 ${i + 1}`,
          shape: createShapeSpec('circle', {
            color: withAlpha(ctx.color, 0.85),
            width: size,
            height: Math.round(size * 1.25),
          }),
          tracks: [
            fixed('translateX', 'percentOfCanvas', atRatio(pick(DROP_X, i, 0.5))),
            /*
             * stream 이라야 한다. 위상이 다른 방울들이 제각각 떨어지고, 화면 밖에서
             * 제자리로 돌아가는 한 프레임이 보이지 않는다 (ambient.confetti 의 규칙).
             */
            stream({
              prop: 'translateY',
              unit: 'percentOfCanvas',
              span,
              phase: pick(DROP_DELAY, i, 0),
              from: -18,
              to: 75,
            }),
          ],
        })
      }
      return { layers, durationFrames: span, loopMode: 'loop', fps }
    },
  },

  {
    id: 'cinema.frontSweep',
    label: '앞을 휙 지나가기',
    hint: '커다란 덩어리가 화면 앞을 휙 쓸고 지나갑니다. 컷이 바뀌는 순간의 연출입니다.',
    group: 'cinema',
    defaultDurationMs: 1200,
    covers: true,
    emit(ctx) {
      const { span, fps } = timingOf(ctx, this.defaultDurationMs)
      const g = gain(ctx.strength)
      // 기울여 지나가므로 화면 대각선보다 커야 모서리가 비지 않는다.
      const w = Math.round(ctx.canvasW * 1.5)
      const h = Math.round(ctx.canvasH * 1.9)
      const tilt = -10 - 8 * g

      /** [이름, 폭 배수, 시간차, 투명도] 본체 뒤로 잔상 두 장이 따라간다. */
      const bands: readonly [string, number, number, number][] = [
        ['덩어리', 1, 0, 0.96],
        ['잔상 1', 0.34, 0.05, 0.5],
        ['잔상 2', 0.16, 0.1, 0.26],
      ]

      const layers: SceneLayer[] = bands.map(([name, mul, lag, alpha]) => ({
        name,
        shape: createShapeSpec('rect', {
          color: withAlpha(shiftColor(ctx.color, -0.12), alpha),
          width: Math.max(8, Math.round(w * mul)),
          height: h,
          cornerRadius: 0,
        }),
        tracks: [
          fixed('rotate', 'deg', tilt),
          /*
           * 화면 밖 왼쪽에서 화면 밖 오른쪽으로. 잔상은 위상을 조금 늦춰 본체
           * 뒤를 따라간다. 되돌아가는 순간은 양쪽 다 화면 밖이라 보이지 않는다.
           */
          stream({
            prop: 'translateX',
            unit: 'percentOfCanvas',
            span,
            phase: lag,
            from: -185,
            to: 185,
          }),
        ],
      }))
      return { layers, durationFrames: span, loopMode: 'loop', fps }
    },
  },

  {
    id: 'cinema.impactFrame',
    label: '임팩트 프레임',
    hint: '집중선과 링이 한 순간 팡 터졌다 사라집니다. 타격감을 주는 한 컷입니다.',
    group: 'cinema',
    defaultDurationMs: 1800,
    emit(ctx) {
      const { span, fps } = timingOf(ctx, this.defaultDurationMs)
      const g = gain(ctx.strength)
      const base = Math.min(ctx.canvasW, ctx.canvasH)

      /*
       * 사건은 주기의 앞 40% 에서 끝난다. 나머지는 빈 화면이다.
       *
       * 점멸 안전(WCAG 2.3.1): 한 주기에 사건이 한 번뿐이므로 초당 점멸 수는
       * 최대 속도(x2)에서도 speed / 1.8초 = 약 1.1회로 상한 3회를 넘지 않는다.
       * 이어 붙이기(reps)도 주기당 한 번이라는 사실을 바꾸지 않는다.
       */
      const gate = (x: number, from: number, to: number): number =>
        x <= from || x >= to ? 0 : 1 - (x - from) / (to - from)

      const layers: SceneLayer[] = [
        {
          name: '집중선',
          shape: createShapeSpec('burst', {
            color: withAlpha(ctx.color, 0.95),
            width: Math.round(base * 1.25),
            height: Math.round(base * 1.25),
            points: 14,
            strokeWidth: Math.max(2, Math.round(base * 0.012)),
            innerRatio: 0.55,
          }),
          tracks: [
            cycle({
              prop: 'opacity',
              unit: 'ratio',
              span,
              phase: 0,
              at: (x) => (x < 0.03 ? x / 0.03 : gate(x, 0.1, 0.3)),
              steps: 16,
            }),
            cycle({
              prop: 'scale',
              unit: 'ratio',
              span,
              phase: 0,
              at: (x) => clamp(0.72 + 0.5 * g * easeOut(clamp01(x / 0.3), 2.4), 0.2, 2),
              steps: 12,
            }),
            // 살이 살짝 돌아야 프레임마다 다른 집중선으로 보인다.
            cycle({
              prop: 'rotate',
              unit: 'deg',
              span,
              phase: 0,
              at: (x) => 14 * Math.sin(x * Math.PI * 2),
              steps: 12,
            }),
          ],
        },
        {
          name: '터짐 링',
          shape: createShapeSpec('circle', {
            color: withAlpha(shiftColor(ctx.color, 0.1), 0.9),
            width: Math.round(base * 0.9),
            height: Math.round(base * 0.9),
            strokeWidth: Math.max(2, Math.round(base * 0.02)),
          }),
          tracks: [
            cycle({
              prop: 'scale',
              unit: 'ratio',
              span,
              phase: 0,
              at: (x) => clamp(0.25 + 1.3 * g * easeOut(clamp01(x / 0.38), 2), 0.2, 2),
              steps: 12,
            }),
            cycle({
              prop: 'opacity',
              unit: 'ratio',
              span,
              phase: 0,
              at: (x) => (x < 0.02 ? x / 0.02 : gate(x, 0.06, 0.38)),
              steps: 16,
            }),
          ],
        },
        // 튀는 불씨. 잉크 튀김의 축소판이 임팩트의 파편 역할을 한다.
        ...SPARK_ANGLES.map((angle, i): SceneLayer => {
          const a = rad(angle)
          const size = Math.max(3, Math.round(base * 0.035 * pick(SPARK_SIZES, i, 1)))
          const reach = 38 * g * pick(INK_REACH, i, 1)
          const fly = (x: number): number => easeOut(clamp01(x / 0.42), 2.4)
          return {
            name: `불씨 ${i + 1}`,
            shape: createShapeSpec('sparkle', {
              color: withAlpha(ctx.color, 0.9),
              width: size,
              height: size,
              points: 4,
            }),
            tracks: [
              cycle({
                prop: 'translateX',
                unit: 'percentOfCanvas',
                span,
                phase: 0,
                at: (x) => Math.cos(a) * reach * fly(x),
                steps: 12,
              }),
              cycle({
                prop: 'translateY',
                unit: 'percentOfCanvas',
                span,
                phase: 0,
                at: (x) => Math.sin(a) * reach * fly(x),
                steps: 12,
              }),
              cycle({
                prop: 'opacity',
                unit: 'ratio',
                span,
                phase: 0,
                at: (x) => (x < 0.04 ? x / 0.04 : gate(x, 0.18, 0.42)),
                steps: 16,
              }),
            ],
          }
        }),
      ]
      return { layers, durationFrames: span, loopMode: 'loop', fps }
    },
  },
]
