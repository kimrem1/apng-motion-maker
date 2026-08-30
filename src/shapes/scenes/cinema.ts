/**
 * 영상 느낌.
 *
 * 애니메이션 엔딩 영상을 프레임 단위로 뜯어 그 **움직임의 문법**을 옮긴 여섯 세트다.
 * 참고 화면에서 실제로 관찰한 것들이고, 세트마다 그중 무엇을 쓰는지 적어 둔다.
 *
 *   1. 잉크는 원이 아니라 **올챙이꼴**이다. 머리 방울 뒤로 꼬리가 늘어졌다 줄어든다.
 *      방울 사이에는 가는 실 가닥이 걸려 있다.
 *   2. 빠른 것은 초점이 나가 있다. 큰 덩어리 곁에 더 크고 옅은 **헤일로**를 겹치면
 *      렌즈 블러의 부드러운 가장자리가 흉내난다.
 *   3. 사건은 한 프레임에 확 나타나 대여섯 프레임에 걸쳐 잦아든다. 내내 움직이면
 *      사건이 아니라 끓는 것이다. 주기의 앞머리에 몰고 뒤는 비워 둔다.
 *   4. 손그림은 2~3프레임 단위로 **툭툭 바뀐다**. 계단(hold) 키에 지터 표를 얹으면
 *      그 손맛이 난다 (stepTrack).
 *   5. 떠다니는 것은 한 배음 사인이 아니다. 배음 두 개를 섞으면(harmonic) 규칙이
 *      읽히지 않으면서도 주기가 정확히 닫힌다.
 *
 * 다른 장면 파일과 같은 규칙을 지킨다. 순수 함수, 표 기반 결정론, 닫힌 주기
 * (이어 붙이기와 무한 반복에서 이음새가 없다). Math.random 은 쓰지 않는다.
 */

import type { Track, TrackProp, TrackUnit } from '@/core/types.ts'
import { createShapeSpec, shiftColor, withAlpha } from '@/core/shape.ts'
import type { SceneLayer, ShapeScene } from '../types.ts'
import {
  atRatio,
  clamp,
  clamp01,
  cycle,
  easeIn,
  easeOut,
  fixed,
  gain,
  pick,
  timingOf,
  track,
} from '../shared.ts'

// ---------------------------------------------------------------------------
// 이 파일만의 헬퍼
// ---------------------------------------------------------------------------

const rad = (deg: number): number => (deg * Math.PI) / 180

/**
 * 배음 두 개를 섞은 닫힌 흔들림. [-1, 1] 근처.
 *
 * 정수 배음만 쓰므로 x=0 과 x=1 에서 값이 정확히 같다. 두 배음의 위상을 다르게
 * 주면 어느 지점에서도 규칙이 읽히지 않는다. 참고 영상의 부유물이 이렇게 떠다닌다.
 */
function harm(x: number, p1: number, p2: number, mix = 0.45): number {
  return (Math.sin((x + p1) * Math.PI * 2) + mix * Math.sin((x + p2) * Math.PI * 4)) / (1 + mix)
}

/** [from, to] 구간에서 1 -> 0 으로 잦아드는 문. 구간 밖은 0 이다. */
function fadeGate(x: number, from: number, to: number): number {
  if (x <= from) return 1
  if (x >= to) return 0
  return 1 - (x - from) / (to - from)
}

/**
 * 계단 지터 트랙. 손그림이 2~3프레임 단위로 툭툭 바뀌는 질감이다.
 *
 * hold 이징이라 값이 다음 키까지 붙잡혀 있다 한 번에 바뀐다. 마지막 키는 첫 값으로
 * 되돌아와 무한 반복과 이어 붙이기에서 이음새가 없다. 프레임이 모자라면 표를
 * 건너뛰며 뽑아, 키가 재생 구간 밖으로 밀리지 않게 한다.
 */
function stepTrack(args: {
  prop: TrackProp
  unit: TrackUnit
  span: number
  /** 지터 표. [-1, 1] 근처의 값들. */
  table: readonly number[]
  base: number
  amp: number
}): Track {
  const steps = Math.max(2, Math.min(args.table.length, Math.floor(args.span / 2)))
  const points = []
  for (let k = 0; k <= steps; k += 1) {
    const v = args.base + args.amp * (k === steps ? args.table[0]! : pick(args.table, k, 0))
    points.push({ f: Math.round((args.span * k) / steps), v, ease: 'hold' })
  }
  return track(args.prop, args.unit, points, 'hold')
}

// ---------------------------------------------------------------------------
// 표. Math.random 대신 여기서 뽑는다.
// ---------------------------------------------------------------------------

/** 잉크 방울: [각도(도), 크기 배수, 사거리 배수, 처짐 배수, 감속 지수] */
const INK_DROPS: readonly [number, number, number, number, number][] = [
  [18, 1.0, 1.05, 0.7, 3.4],
  [63, 0.62, 1.3, 0.4, 4.2],
  [131, 1.25, 0.85, 1.0, 2.8],
  [201, 0.78, 1.15, 0.5, 3.8],
  [258, 0.55, 1.4, 0.3, 4.6],
  [317, 0.92, 0.95, 0.8, 3.1],
]
/** 스플랫: [x, y(비율 좌표), 크기 배수, 살 수, 터지는 지연] */
const INK_SPLATS: readonly [number, number, number, number, number][] = [
  [0.34, 0.4, 1, 5, 0.02],
  [0.68, 0.62, 0.72, 6, 0.07],
]
/** 실 가닥: [각도, 길이 배수, 위치 반경 배수] */
const INK_STRANDS: readonly [number, number, number][] = [
  [40, 1, 0.5],
  [150, 1.35, 0.62],
  [282, 0.8, 0.44],
]
/** 계단 지터 표. 손으로 그린 듯 불규칙해야 해서 등차가 아니다. */
const JITTER = [0.3, -0.75, 0.9, -0.2, 0.55, -1, 0.1, 0.7, -0.5, 1, -0.85, 0.45]

/** 파편: [x, y, 크기, 종횡비, 흔들림 반경, 위상1, 위상2] */
const DEBRIS: readonly [number, number, number, number, number, number, number][] = [
  [0.11, 0.14, 1.0, 0.55, 1.0, 0.0, 0.37],
  [0.86, 0.1, 0.55, 1.3, 1.5, 0.21, 0.72],
  [0.07, 0.52, 1.3, 0.8, 0.65, 0.43, 0.11],
  [0.93, 0.45, 0.7, 0.45, 1.25, 0.64, 0.9],
  [0.16, 0.87, 1.1, 1.15, 0.9, 0.08, 0.55],
  [0.81, 0.9, 0.5, 0.7, 1.4, 0.31, 0.18],
  [0.36, 0.06, 0.85, 0.35, 1.1, 0.52, 0.83],
  [0.63, 0.95, 1.2, 0.9, 0.75, 0.77, 0.29],
  [0.04, 0.3, 0.6, 1.2, 1.3, 0.9, 0.62],
  [0.95, 0.72, 0.95, 0.6, 1.0, 0.15, 0.48],
  [0.27, 0.96, 0.65, 1.4, 1.2, 0.69, 0.04],
]

const DRIP_X = [0.09, 0.24, 0.38, 0.55, 0.72, 0.9]
const DRIP_DELAY = [0, 0.41, 0.63, 0.17, 0.82, 0.33]
const DRIP_WIDTH = [1, 0.55, 1.35, 0.75, 1.1, 0.65]
const DRIP_LENGTH = [1, 0.6, 1.25, 0.8, 1.1, 0.7]
/** 방울이 갈라져 나오는 줄기 번호. */
const DROP_STEM = [1, 3, 5]

/** 불씨: [각도, 크기, 사거리, 처짐] */
const SPARKS: readonly [number, number, number, number][] = [
  [16, 1, 1.1, 0.5],
  [58, 0.6, 1.35, 0.25],
  [104, 0.85, 0.9, 0.7],
  [147, 0.55, 1.2, 0.45],
  [196, 1.15, 0.8, 0.9],
  [242, 0.7, 1.3, 0.35],
  [289, 0.9, 1.0, 0.6],
  [334, 0.5, 1.45, 0.2],
]

export const CINEMA_SCENES: ShapeScene[] = [
  // -------------------------------------------------------------------------
  // 잉크 튀김
  // -------------------------------------------------------------------------
  {
    id: 'cinema.inkBurst',
    label: '잉크 튀김',
    hint: '올챙이꼴 잉크 방울이 꼬리를 끌며 확 튀고, 실 가닥과 스플랫이 남았다 잦아듭니다.',
    group: 'cinema',
    defaultDurationMs: 2200,
    emit(ctx) {
      const { span, fps } = timingOf(ctx, this.defaultDurationMs)
      const g = gain(ctx.strength)
      const base = Math.min(ctx.canvasW, ctx.canvasH)
      const layers: SceneLayer[] = []

      // 0) 헤일로. 터지는 순간의 초점 나간 충격파다. 크고 옅은 원이 확 부풀며 사라진다.
      layers.push({
        name: '잉크 충격파',
        shape: createShapeSpec('circle', {
          color: withAlpha(ctx.color, 0.2),
          width: Math.round(base * 0.5),
          height: Math.round(base * 0.44),
        }),
        tracks: [
          cycle({
            prop: 'scale',
            unit: 'ratio',
            span,
            phase: 0,
            at: (x) => clamp(0.4 + 1.4 * g * easeOut(clamp01(x / 0.3), 3), 0.2, 2),
            steps: 12,
          }),
          cycle({
            prop: 'opacity',
            unit: 'ratio',
            span,
            phase: 0,
            at: (x) => (x < 0.02 ? x / 0.02 : fadeGate(x, 0.05, 0.32)),
            steps: 16,
          }),
        ],
      })

      // 1) 방울 여섯. 머리 + 꼬리 두 장이 한 벌이다.
      INK_DROPS.forEach(([angleDeg, sizeMul, reachMul, droopMul, power], i) => {
        const a = rad(angleDeg)
        const size = Math.max(4, Math.round(base * 0.08 * sizeMul))
        const reach = 36 * g * reachMul
        const droop = 7 * g * droopMul
        /** 감속 비행. 두세 프레임에 대부분을 날고 나머지는 미끄러진다. */
        const fly = (x: number): number => easeOut(clamp01(x / 0.58), power)
        /** 꼬리는 조금 뒤처진 진행률을 따른다. 그 격차가 곧 꼬리 길이다. */
        const flyLag = (x: number): number => fly(Math.max(0, x - 0.05))
        const px = (p: number): number => Math.cos(a) * reach * p
        const py = (p: number): number => Math.sin(a) * reach * p + droop * p * p

        layers.push({
          name: `잉크 방울 ${i + 1}`,
          shape: createShapeSpec('circle', {
            color: withAlpha(shiftColor(ctx.color, (i % 3) * 0.08 - 0.08), 1),
            width: size,
            // 살짝 눌린 타원. 회전이 비행각이라 눌림이 언제나 비행 방향과 직각이다.
            height: Math.round(size * 0.82),
          }),
          tracks: [
            fixed('rotate', 'deg', angleDeg),
            cycle({ prop: 'translateX', unit: 'percentOfCanvas', span, phase: 0, at: (x) => px(fly(x)), steps: 14 }),
            cycle({ prop: 'translateY', unit: 'percentOfCanvas', span, phase: 0, at: (x) => py(fly(x)), steps: 14 }),
            /*
             * 늘었다 몽글하게 돌아온다. 출발 직후 비행 방향으로 1.8배까지 늘고,
             * 감쇠 진동을 두 번 거치며 1로 돌아온다. 이 출렁임이 물방울을 물방울로
             * 읽게 한다. 주기 끝은 투명이라 시작값과 달라도 이음새가 없다.
             */
            cycle({
              prop: 'scaleX',
              unit: 'ratio',
              span,
              phase: 0,
              at: (x) => clamp(1 + (0.35 + 0.75 * g) * Math.exp(-5 * x) * Math.cos(x * Math.PI * 5), 0.3, 2.6),
              steps: 14,
            }),
            cycle({
              prop: 'scaleY',
              unit: 'ratio',
              span,
              phase: 0,
              at: (x) => clamp(1 - 0.3 * Math.exp(-5 * x) * Math.cos(x * Math.PI * 5), 0.4, 1.6),
              steps: 14,
            }),
            cycle({
              prop: 'opacity',
              unit: 'ratio',
              span,
              phase: 0,
              at: (x) => (x < 0.03 ? x / 0.03 : fadeGate(x, 0.5, 0.78)),
              steps: 16,
            }),
          ],
        })

        layers.push({
          name: `잉크 꼬리 ${i + 1}`,
          shape: createShapeSpec('rect', {
            color: withAlpha(shiftColor(ctx.color, (i % 3) * 0.08 - 0.08), 0.92),
            width: Math.max(4, Math.round(size * 1.5)),
            height: Math.max(3, Math.round(size * 0.34)),
            cornerRadius: Math.round(size * 0.17),
          }),
          tracks: [
            fixed('rotate', 'deg', angleDeg),
            // 머리와 뒤처진 지점의 한가운데. 꼬리는 언제나 머리 뒤에 붙어 있다.
            cycle({
              prop: 'translateX',
              unit: 'percentOfCanvas',
              span,
              phase: 0,
              at: (x) => px((fly(x) + flyLag(x)) / 2),
              steps: 14,
            }),
            cycle({
              prop: 'translateY',
              unit: 'percentOfCanvas',
              span,
              phase: 0,
              at: (x) => py((fly(x) + flyLag(x)) / 2),
              steps: 14,
            }),
            // 격차가 크면 길게 늘고 따라잡으면 몽톡한 점으로 줄어든다.
            cycle({
              prop: 'scaleX',
              unit: 'ratio',
              span,
              phase: 0,
              at: (x) => clamp(0.3 + (fly(x) - flyLag(x)) * reach * 0.16, 0.2, 3.4),
              steps: 14,
            }),
            cycle({
              prop: 'opacity',
              unit: 'ratio',
              span,
              phase: 0,
              at: (x) => (x < 0.04 ? x / 0.04 : fadeGate(x, 0.38, 0.66)),
              steps: 16,
            }),
          ],
        })
      })

      // 2) 스플랫 둘. 살 달린 얼룩이 한 프레임에 확 나타나 잦아든다. 계단 지터가 손맛이다.
      INK_SPLATS.forEach(([sx, sy, sizeMul, points, delay], i) => {
        const size = Math.max(6, Math.round(base * 0.2 * sizeMul))
        layers.push({
          name: `잉크 스플랫 ${i + 1}`,
          shape: createShapeSpec('sparkle', {
            color: withAlpha(shiftColor(ctx.color, i === 0 ? 0.06 : -0.08), 0.96),
            width: size,
            height: Math.round(size * 0.9),
            // 살을 늘리고 안쪽 반지름을 올리면 뾰족한 별이 아니라 물결진 얼룩이 된다.
            points: points + 1,
            innerRatio: 0.55,
          }),
          tracks: [
            fixed('translateX', 'percentOfCanvas', atRatio(sx)),
            fixed('translateY', 'percentOfCanvas', atRatio(sy)),
            stepTrack({ prop: 'rotate', unit: 'deg', span, table: JITTER, base: i * 40, amp: 9 }),
            cycle({
              prop: 'scale',
              unit: 'ratio',
              span,
              phase: 0,
              at: (x) => {
                const u = clamp01((x - delay) / 0.1)
                // 확 부풀었다 아주 천천히 준다. 참고 영상의 스플랫이 이렇게 잦아든다.
                return clamp(0.2 + (0.9 + 0.4 * g) * easeOut(u, 4) * (1 - 0.35 * clamp01((x - delay) / 0.6)), 0.2, 2)
              },
              steps: 14,
            }),
            cycle({
              prop: 'opacity',
              unit: 'ratio',
              span,
              phase: 0,
              at: (x) => (x < delay ? 0 : x < delay + 0.04 ? (x - delay) / 0.04 : fadeGate(x, delay + 0.3, delay + 0.62)),
              steps: 16,
            }),
          ],
        })
      })

      // 3) 실 가닥 셋. 방울 사이에 걸린 가는 끈. 늘었다 이내 사라진다.
      INK_STRANDS.forEach(([angleDeg, lenMul, radiusMul], i) => {
        const a = rad(angleDeg)
        const len = Math.max(6, Math.round(base * 0.24 * lenMul))
        const r = 20 * g * radiusMul
        layers.push({
          name: `잉크 실 ${i + 1}`,
          shape: createShapeSpec('rect', {
            color: withAlpha(ctx.color, 0.8),
            width: len,
            height: Math.max(2, Math.round(base * 0.008)),
            cornerRadius: Math.round(base * 0.004),
          }),
          tracks: [
            fixed('rotate', 'deg', angleDeg + 12),
            cycle({
              prop: 'translateX',
              unit: 'percentOfCanvas',
              span,
              phase: 0,
              at: (x) => Math.cos(a) * r * easeOut(clamp01(x / 0.5), 3),
              steps: 12,
            }),
            cycle({
              prop: 'translateY',
              unit: 'percentOfCanvas',
              span,
              phase: 0,
              at: (x) => Math.sin(a) * r * easeOut(clamp01(x / 0.5), 3),
              steps: 12,
            }),
            cycle({
              prop: 'scaleX',
              unit: 'ratio',
              span,
              phase: 0,
              at: (x) => clamp(0.25 + 1.3 * easeOut(clamp01(x / 0.34), 2.6), 0.2, 2),
              steps: 12,
            }),
            cycle({
              prop: 'opacity',
              unit: 'ratio',
              span,
              phase: 0,
              at: (x) => (x < 0.05 ? x / 0.05 : fadeGate(x, 0.26, 0.52)),
              steps: 16,
            }),
          ],
        })
      })

      return { layers, durationFrames: span, loopMode: 'loop', fps }
    },
  },

  // -------------------------------------------------------------------------
  // 부유 파편
  // -------------------------------------------------------------------------
  {
    id: 'cinema.debrisFloat',
    label: '부유 파편',
    hint: '각진 조각들이 두 배음으로 불규칙하게 떠다니고, 옅은 큰 덩어리가 깊이를 만듭니다.',
    group: 'cinema',
    defaultDurationMs: 4600,
    emit(ctx) {
      const { span, fps } = timingOf(ctx, this.defaultDurationMs)
      const g = gain(ctx.strength)
      const base = Math.min(ctx.canvasW, ctx.canvasH)
      const kinds = ['sparkle', 'triangle', 'rect', 'polygon', 'cross'] as const
      const layers: SceneLayer[] = []

      // 0) 깊이용 큰 덩어리 둘. 초점 나간 이물감. 아주 옅고 아주 느리다.
      const BLOBS: readonly [number, number, number][] = [
        [0.18, 0.22, 0.5],
        [0.85, 0.78, 0.4],
      ]
      BLOBS.forEach(([bx, by, sizeMul], i) => {
        const size = Math.round(base * sizeMul)
        layers.push({
          name: `뿌연 덩어리 ${i + 1}`,
          shape: createShapeSpec('circle', {
            color: withAlpha(ctx.color, 0.13),
            width: size,
            height: Math.round(size * 0.86),
          }),
          tracks: [
            cycle({
              prop: 'translateX',
              unit: 'percentOfCanvas',
              span,
              phase: i * 0.5,
              at: (x) => atRatio(bx) + 2.4 * g * harm(x, i * 0.4, 0.7 + i * 0.2),
              steps: 12,
            }),
            cycle({
              prop: 'translateY',
              unit: 'percentOfCanvas',
              span,
              phase: i * 0.5 + 0.25,
              at: (x) => atRatio(by) + 2 * g * harm(x, 0.55 + i * 0.3, i * 0.6),
              steps: 12,
            }),
          ],
        })
      })

      // 1) 파편 열한 조각. 배음 둘을 섞은 떠다님이라 규칙이 읽히지 않는다.
      DEBRIS.forEach(([sx, sy, sizeMul, aspect, driftMul, p1, p2], i) => {
        const size = Math.max(4, Math.round(base * 0.055 * sizeMul))
        const drift = 3.4 * g * driftMul
        const kind = kinds[i % kinds.length]!
        const dir = i % 2 === 0 ? 1 : -1
        layers.push({
          name: `파편 ${i + 1}`,
          shape: createShapeSpec(kind, {
            // 깜빡임 트랙과 곱해지므로 여기가 옅으면 이중으로 옅어져 안 보인다.
            color: withAlpha(shiftColor(ctx.color, (i % 4) * 0.07 - 0.1), 0.85),
            width: size,
            height: Math.max(3, Math.round(size * aspect)),
            ...(kind === 'sparkle' ? { points: 3 + (i % 2), innerRatio: 0.24 } : {}),
            ...(kind === 'rect' ? { cornerRadius: Math.round(size * 0.1) } : {}),
          }),
          tracks: [
            cycle({
              prop: 'translateX',
              unit: 'percentOfCanvas',
              span,
              phase: p1,
              at: (x) => atRatio(sx) + drift * harm(x, p1, p2) * dir,
              steps: 14,
            }),
            cycle({
              prop: 'translateY',
              unit: 'percentOfCanvas',
              span,
              phase: p2,
              at: (x) => atRatio(sy) + drift * 0.8 * harm(x, p2 + 0.33, p1 + 0.61),
              steps: 14,
            }),
            // 물에 뜬 것처럼 기울었다 돌아온다. 진폭과 배음이 조각마다 다르다.
            cycle({
              prop: 'rotate',
              unit: 'deg',
              span,
              phase: p1,
              at: (x) => (14 + 22 * driftMul) * g * harm(x, p2, p1 + 0.5) * dir,
              steps: 14,
            }),
            cycle({
              prop: 'scale',
              unit: 'ratio',
              span,
              phase: p2,
              at: (x) => clamp(1 + 0.1 * g * harm(x, p1 + 0.21, p2 + 0.44), 0.2, 2),
              steps: 12,
            }),
            // 아주 옅은 깜빡임. 빛을 받는 각도가 바뀌는 인상이다.
            cycle({
              prop: 'opacity',
              unit: 'ratio',
              span,
              phase: p1 + 0.4,
              at: (x) => clamp01(0.74 + 0.16 * harm(x, p2 + 0.12, p1 + 0.77)),
              steps: 12,
            }),
          ],
        })
      })

      return { layers, durationFrames: span, loopMode: 'loop', fps }
    },
  },

  // -------------------------------------------------------------------------
  // 감아 도는 선
  // -------------------------------------------------------------------------
  {
    id: 'cinema.swirlLines',
    label: '감아 도는 선',
    hint: '붓으로 감은 듯한 호가 잔상을 끌며 돌고, 물감 조각이 궤도를 따라 맴돕니다.',
    group: 'cinema',
    defaultDurationMs: 2800,
    emit(ctx) {
      const { span, fps } = timingOf(ctx, this.defaultDurationMs)
      const g = gain(ctx.strength)
      const base = Math.min(ctx.canvasW, ctx.canvasH)
      const layers: SceneLayer[] = []

      /** [지름 배수, 쓸기 각도, 방향, 시작 각도, 두께 배수, 바퀴 수, 타원 눌림] */
      const arcs: readonly [number, number, number, number, number, number, number][] = [
        [0.6, 150, 1, 0, 1.1, 1, 0.93],
        [0.9, 95, -1, 140, 0.85, 1, 1.06],
        [1.16, 205, 1, 255, 1.3, 1, 0.96],
        [0.42, 70, -1, 60, 0.65, 2, 1.1],
      ]

      arcs.forEach(([mul, sweep, dir, start, thick, turns, squash], i) => {
        const dia = Math.round(base * mul)
        const stroke = Math.max(2, Math.round(base * 0.017 * thick))
        const phase = i / arcs.length
        /*
         * 본체와 잔상이 한 벌이다. 잔상은 몇 도 뒤에서 옅게 따라 돈다. 빠른 붓이
         * 남기는 블러 꼬리를 레이어의 시간차로 흉내 낸다.
         */
        const echoes: readonly [string, number, number, number][] = [
          ['선', 0, 1, 1],
          ['잔상', -22 * dir, 0.32, 1.03],
        ]
        for (const [suffix, lagDeg, alpha, echoScale] of echoes) {
          layers.push({
            name: `감아 도는 ${suffix} ${i + 1}`,
            shape: createShapeSpec('arc', {
              color: withAlpha(shiftColor(ctx.color, i % 2 === 0 ? 0.08 : -0.06), alpha * 0.9),
              width: Math.round(dia * echoScale),
              height: Math.round(dia * echoScale),
              strokeWidth: stroke,
              sweepDeg: clamp(sweep, 5, 360),
            }),
            tracks: [
              /*
               * 한 바퀴(또는 두 바퀴)는 정확히 span 에서 끝난다. 360의 배수와 0도는
               * 같은 그림이라 이음새가 없고, span - 1 에 두면 마지막 프레임이 각도를
               * 붙잡아 주기마다 멈칫한다 (ambient.petals 의 규칙).
               */
              track(
                'rotate',
                'deg',
                [
                  { f: 0, v: start + lagDeg, ease: 'linear' },
                  { f: span, v: start + lagDeg + 360 * turns * dir },
                ],
                'linear',
              ),
              /*
               * 축이 눌린 타원 궤도. 눌림 축이 도형과 함께 돌아서, 호가 도는 내내
               * 넓어졌다 좁아지며 손으로 감은 것처럼 흔들린다.
               */
              fixed('scaleX', 'ratio', squash),
              cycle({
                prop: 'scaleY',
                unit: 'ratio',
                span,
                phase,
                at: (x) => clamp((2 - squash) * (1 + 0.05 * g * harm(x, phase, phase + 0.3)), 0.2, 2),
                steps: 12,
              }),
              // 바닥을 높게 잡는다. 숨쉬되 옅어져 사라지는 순간은 없어야 한다.
              cycle({
                prop: 'opacity',
                unit: 'ratio',
                span,
                phase,
                at: (x) => clamp01(alpha * (0.74 + 0.26 * harm(x, phase + 0.5, phase))),
                steps: 12,
              }),
            ],
          })
        }
      })

      // 궤도를 따라 맴도는 물감 조각 넷. 선과 다른 반지름을 돌아 궤적을 겹으로 만든다.
      const FLECKS: readonly [number, number, number, number][] = [
        [0.24, 0, 1, 0.014],
        [0.37, 0.31, -1, 0.02],
        [0.5, 0.62, 1, 0.011],
        [0.31, 0.84, -1, 0.017],
      ]
      FLECKS.forEach(([radiusMul, phase, dir, sizeMul], i) => {
        const r = radiusMul * 100 * (0.8 + 0.2 * g)
        const size = Math.max(3, Math.round(base * sizeMul * (1 + g * 0.4)))
        layers.push({
          name: `물감 조각 ${i + 1}`,
          shape: createShapeSpec(i % 2 === 0 ? 'circle' : 'sparkle', {
            color: withAlpha(ctx.color, 0.85),
            width: size,
            height: size,
            ...(i % 2 === 1 ? { points: 4, innerRatio: 0.35 } : {}),
          }),
          tracks: [
            // 반지름이 배음으로 출렁여 완전한 원 궤도가 아니다.
            cycle({
              prop: 'translateX',
              unit: 'percentOfCanvas',
              span,
              phase,
              at: (x) => Math.cos((x * dir + phase) * Math.PI * 2) * r * (1 + 0.09 * harm(x, phase, phase + 0.4)),
              steps: 16,
            }),
            cycle({
              prop: 'translateY',
              unit: 'percentOfCanvas',
              span,
              phase,
              at: (x) => Math.sin((x * dir + phase) * Math.PI * 2) * r * 0.92 * (1 + 0.09 * harm(x, phase + 0.2, phase + 0.7)),
              steps: 16,
            }),
            cycle({
              prop: 'opacity',
              unit: 'ratio',
              span,
              phase,
              at: (x) => clamp01(0.65 + 0.25 * harm(x, phase + 0.1, phase + 0.6)),
              steps: 12,
            }),
          ],
        })
      })

      return { layers, durationFrames: span, loopMode: 'loop', fps }
    },
  },

  // -------------------------------------------------------------------------
  // 흘러내림
  // -------------------------------------------------------------------------
  {
    id: 'cinema.dripPaint',
    label: '흘러내림',
    hint: '위에 고인 물감이 몽글한 머리를 앞세워 흘러내리고, 방울이 갈라져 떨어집니다.',
    group: 'cinema',
    defaultDurationMs: 3800,
    emit(ctx) {
      const { span, fps } = timingOf(ctx, this.defaultDurationMs)
      const g = gain(ctx.strength)
      const base = Math.min(ctx.canvasW, ctx.canvasH)
      const layers: SceneLayer[] = []

      /**
       * 줄기의 자람. 단조롭게 자라되 중간중간 미세하게 멈칫한다.
       * 물감은 등속으로 흐르지 않는다. 뭉쳤다 터지며 내려온다.
       */
      const grow = (x: number, i: number): number => {
        const u = clamp01(x / 0.72)
        const wobble = 0.1 * (1 - u) * Math.sin(u * Math.PI * 6 + i * 1.7)
        return clamp(easeOut(u, 2.1) * (1 - wobble), 0.06, 1)
      }
      const dripAlpha = (x: number): number =>
        x < 0.05 ? x / 0.05 : x < 0.78 ? 1 : x < 0.94 ? 1 - (x - 0.78) / 0.16 : 0

      // 0) 위에 고인 물감 띠. 여기서 줄기가 자라 나온다. 배음으로 두께가 숨쉰다.
      layers.push({
        name: '고인 물감',
        shape: createShapeSpec('rect', {
          color: withAlpha(shiftColor(ctx.color, -0.05), 0.94),
          width: Math.round(ctx.canvasW * 1.04),
          height: Math.max(4, Math.round(base * 0.05)),
          cornerRadius: Math.max(2, Math.round(base * 0.02)),
        }),
        anchor: [0.5, 0],
        tracks: [
          fixed('translateY', 'percentOfCanvas', -51),
          cycle({
            prop: 'scaleY',
            unit: 'ratio',
            span,
            phase: 0,
            at: (x) => clamp(1 + 0.3 * g * (0.5 + 0.5 * harm(x, 0.1, 0.55)), 0.5, 2),
            steps: 12,
          }),
        ],
      })

      // 1) 줄기 여섯 + 몽글한 머리 여섯.
      DRIP_X.forEach((sx, i) => {
        const delay = pick(DRIP_DELAY, i, 0)
        const w = Math.max(4, Math.round(base * 0.038 * pick(DRIP_WIDTH, i, 1)))
        const h = Math.round(
          Math.min(ctx.canvasH * 0.86, base * clamp(0.42 * g * pick(DRIP_LENGTH, i, 1), 0.12, 0.86)),
        )
        /** 줄기 높이가 캔버스에서 차지하는 비율(%). 머리가 이 값으로 끝을 따라간다. */
        const hPct = (h / ctx.canvasH) * 100

        layers.push({
          name: `물감 줄기 ${i + 1}`,
          shape: createShapeSpec('rect', {
            color: withAlpha(shiftColor(ctx.color, (i % 3) * 0.07 - 0.07), 0.92),
            width: w,
            height: h,
            cornerRadius: Math.round(w / 2),
          }),
          anchor: [0.5, 0],
          tracks: [
            fixed('translateX', 'percentOfCanvas', atRatio(sx)),
            fixed('translateY', 'percentOfCanvas', -50),
            cycle({
              prop: 'scaleY',
              unit: 'ratio',
              span,
              phase: delay,
              at: (x) => grow(x, i),
              steps: 16,
            }),
            // 폭도 미세하게 출렁인다. 이게 없으면 줄기가 아니라 막대다.
            cycle({
              prop: 'scaleX',
              unit: 'ratio',
              span,
              phase: delay,
              at: (x) => clamp(1 + 0.12 * g * harm(x, i * 0.17, 0.5 + i * 0.11), 0.5, 1.6),
              steps: 12,
            }),
            cycle({
              prop: 'opacity',
              unit: 'ratio',
              span,
              phase: delay,
              at: dripAlpha,
              steps: 16,
            }),
          ],
        })

        layers.push({
          name: `물감 머리 ${i + 1}`,
          shape: createShapeSpec('circle', {
            color: withAlpha(shiftColor(ctx.color, (i % 3) * 0.07 - 0.07), 0.96),
            width: Math.max(5, Math.round(w * 1.9)),
            height: Math.max(4, Math.round(w * 1.5)),
          }),
          tracks: [
            fixed('translateX', 'percentOfCanvas', atRatio(sx)),
            // 줄기 끝을 정확히 따라간다. 줄기와 같은 grow 를 쓰므로 어긋나지 않는다.
            cycle({
              prop: 'translateY',
              unit: 'percentOfCanvas',
              span,
              phase: delay,
              at: (x) => -50 + hPct * grow(x, i),
              steps: 16,
            }),
            // 머리가 몽글몽글 숨쉰다. 표면장력에 매달린 방울의 출렁임이다.
            cycle({
              prop: 'scaleX',
              unit: 'ratio',
              span,
              phase: delay,
              at: (x) => clamp(1 + 0.16 * g * harm(x, i * 0.23, 0.4 + i * 0.13), 0.5, 1.8),
              steps: 12,
            }),
            cycle({
              prop: 'scaleY',
              unit: 'ratio',
              span,
              phase: delay,
              at: (x) => clamp(1 - 0.12 * g * harm(x, i * 0.23, 0.4 + i * 0.13), 0.4, 1.6),
              steps: 12,
            }),
            cycle({
              prop: 'opacity',
              unit: 'ratio',
              span,
              phase: delay,
              at: dripAlpha,
              steps: 16,
            }),
          ],
        })
      })

      // 2) 갈라져 떨어지는 방울 셋. 줄기 끝에서 태어나 화면 아래로 사라진다.
      DROP_STEM.forEach((stemIndex, i) => {
        const sx = pick(DRIP_X, stemIndex, 0.5)
        const delay = pick(DRIP_DELAY, stemIndex, 0)
        const w = Math.max(4, Math.round(base * 0.038 * pick(DRIP_WIDTH, stemIndex, 1)))
        const h = Math.round(
          Math.min(ctx.canvasH * 0.86, base * clamp(0.42 * g * pick(DRIP_LENGTH, stemIndex, 1), 0.12, 0.86)),
        )
        const birthY = -50 + (h / ctx.canvasH) * 100 * grow(0.6, stemIndex)
        const size = Math.max(3, Math.round(w * 0.8))
        layers.push({
          name: `떨어지는 방울 ${i + 1}`,
          shape: createShapeSpec('circle', {
            color: withAlpha(ctx.color, 0.92),
            width: size,
            height: Math.round(size * 1.35),
          }),
          tracks: [
            fixed('translateX', 'percentOfCanvas', atRatio(sx)),
            // 줄기 끝(x=0.6 시점의 위치)에서 출발해 가속하며 떨어진다.
            cycle({
              prop: 'translateY',
              unit: 'percentOfCanvas',
              span,
              phase: delay,
              at: (x) => birthY + (78 - birthY) * easeIn(clamp01((x - 0.6) / 0.3), 2.2),
              steps: 14,
            }),
            // 떨어지는 동안 세로로 길어진다. 속도가 모양이 된다.
            cycle({
              prop: 'scaleY',
              unit: 'ratio',
              span,
              phase: delay,
              at: (x) => clamp(1 + 1.1 * clamp01((x - 0.6) / 0.3), 0.5, 2.4),
              steps: 12,
            }),
            cycle({
              prop: 'opacity',
              unit: 'ratio',
              span,
              phase: delay,
              at: (x) => (x < 0.58 ? 0 : x < 0.62 ? (x - 0.58) / 0.04 : fadeGate(x, 0.82, 0.92)),
              steps: 16,
            }),
          ],
        })
      })

      return { layers, durationFrames: span, loopMode: 'loop', fps }
    },
  },

  // -------------------------------------------------------------------------
  // 앞을 휙 지나가기
  // -------------------------------------------------------------------------
  {
    id: 'cinema.frontSweep',
    label: '앞을 휙 지나가기',
    hint: '울퉁불퉁한 덩어리가 주기 대부분을 기다렸다 한 순간에 화면을 채찍처럼 쓸고 갑니다.',
    group: 'cinema',
    defaultDurationMs: 1400,
    covers: true,
    emit(ctx) {
      const { span, fps } = timingOf(ctx, this.defaultDurationMs)
      const g = gain(ctx.strength)
      const base = Math.min(ctx.canvasW, ctx.canvasH)
      const tilt = -9 - 9 * g
      const layers: SceneLayer[] = []

      /*
       * 휙의 핵심은 등속이 아니라는 것이다. 주기의 앞 20% 는 화면 밖에서 기다리고,
       * 다음 26% 에 화면 전체를 지나가고, 나머지는 반대편에서 쉰다. stream 의 등속
       * 이동으로는 이 채찍 같은 속도 곡선이 안 나온다.
       *
       * 키 배치: [대기 hold] -> [휙 easeInOutQuart] -> [대기 hold] -> 마지막 한
       * 프레임에 제자리로. 양끝이 모두 화면 밖이라 되돌아가는 순간은 보이지 않고,
       * 첫 키와 끝 키의 값이 같아 이어 붙이기에서도 이음새가 없다.
       */
      const whipTrack = (from: number, to: number, lagFrames: number): Track => {
        const p1 = clamp(Math.round(span * 0.2) + lagFrames, 1, span - 3)
        const p2 = clamp(Math.round(span * 0.46) + lagFrames, p1 + 1, span - 2)
        return track(
          'translateX',
          'percentOfCanvas',
          [
            { f: 0, v: from, ease: 'hold' },
            { f: p1, v: from, ease: 'easeInOutQuart' },
            { f: p2, v: to, ease: 'hold' },
            { f: span - 1, v: to, ease: 'linear' },
            { f: span, v: from },
          ],
          'linear',
        )
      }
      /** 휙이 지나가는 동안만 보이는 문. 값이 계단으로 켜졌다 꺼진다. */
      const whipGate = (peak: number, lagFrames: number): Track => {
        const p1 = clamp(Math.round(span * 0.2) + lagFrames, 1, span - 3)
        const p2 = clamp(Math.round(span * 0.48) + lagFrames, p1 + 1, span - 1)
        return track(
          'opacity',
          'ratio',
          [
            { f: 0, v: 0, ease: 'hold' },
            { f: p1, v: peak, ease: 'hold' },
            { f: p2, v: 0, ease: 'linear' },
            { f: span, v: 0 },
          ],
          'linear',
        )
      }

      // 0) 본체와 헤일로. 헤일로가 살짝 크고 옅어 초점 나간 가장자리를 만든다.
      const bodies: readonly [string, number, number, number][] = [
        ['덩어리', 1, 0.97, 0],
        ['덩어리 헤일로', 1.12, 0.3, 1],
      ]
      bodies.forEach(([name, sizeMul, alpha, lag]) => {
        layers.push({
          name,
          shape: createShapeSpec('rect', {
            color: withAlpha(shiftColor(ctx.color, -0.12), alpha),
            width: Math.round(ctx.canvasW * 1.35 * sizeMul),
            height: Math.round(ctx.canvasH * 1.9),
            cornerRadius: Math.round(base * 0.1),
          }),
          tracks: [fixed('rotate', 'deg', tilt), whipTrack(-195, 195, lag)],
        })
      })

      // 1) 앞머리 혹 셋. 밋밋한 직선 변이 울퉁불퉁한 유기체 앞머리가 된다.
      const LUMPS: readonly [number, number, number][] = [
        [0.52, -24, 74],
        [0.4, 6, 80],
        [0.3, 32, 70],
      ]
      LUMPS.forEach(([sizeMul, y, lead], i) => {
        const size = Math.round(base * sizeMul)
        layers.push({
          name: `앞머리 혹 ${i + 1}`,
          shape: createShapeSpec('circle', {
            color: withAlpha(shiftColor(ctx.color, -0.12), 0.97),
            width: size,
            height: Math.round(size * 0.9),
          }),
          tracks: [
            fixed('translateY', 'percentOfCanvas', y),
            // 본체보다 앞서 달린다. 값만 옮긴 같은 채찍 곡선이라 붙어 다닌다.
            whipTrack(-195 + lead, 195 + lead, i === 1 ? 0 : 1),
          ],
        })
      })

      // 2) 속도 줄 넷. 휙이 지나가는 그 순간에만 나타나는 길게 늘어난 획이다.
      const STREAKS: readonly [number, number][] = [
        [-34, 0],
        [-8, 1],
        [14, 0],
        [38, 2],
      ]
      STREAKS.forEach(([y, lag], i) => {
        layers.push({
          name: `속도 줄 ${i + 1}`,
          shape: createShapeSpec('rect', {
            color: withAlpha(ctx.color, 0.55),
            width: Math.round(ctx.canvasW * 0.55),
            height: Math.max(2, Math.round(base * 0.014)),
            cornerRadius: Math.max(1, Math.round(base * 0.007)),
          }),
          tracks: [
            fixed('rotate', 'deg', tilt),
            fixed('translateY', 'percentOfCanvas', y),
            whipTrack(-160 + (i % 2) * 30, 190, lag),
            whipGate(0.5 + 0.2 * (i % 2), lag),
          ],
        })
      })

      return { layers, durationFrames: span, loopMode: 'loop', fps }
    },
  },

  // -------------------------------------------------------------------------
  // 임팩트 프레임
  // -------------------------------------------------------------------------
  {
    id: 'cinema.impactFrame',
    label: '임팩트 프레임',
    hint: '집중선이 손그림처럼 떨며 터지고, 링 두 겹과 불씨가 포물선을 그리며 흩어집니다.',
    group: 'cinema',
    defaultDurationMs: 1800,
    emit(ctx) {
      const { span, fps } = timingOf(ctx, this.defaultDurationMs)
      const g = gain(ctx.strength)
      const base = Math.min(ctx.canvasW, ctx.canvasH)
      const layers: SceneLayer[] = []

      /*
       * 사건은 주기의 앞 45% 에서 끝난다. 나머지는 빈 화면이다.
       *
       * 점멸 안전(WCAG 2.3.1): 한 주기에 사건이 한 번뿐이므로 초당 점멸 수는
       * 최대 속도(x2)에서도 speed / 1.8초 = 약 1.1회로 상한 3회를 넘지 않는다.
       * 이어 붙이기(reps)도 주기당 한 번이라는 사실을 바꾸지 않는다.
       */

      // 0) 집중선 본체 + 헤일로. 본체는 계단 지터로 떤다. 손으로 다시 그린 프레임처럼.
      const bursts: readonly [string, number, number][] = [
        ['집중선', 1, 0.96],
        ['집중선 헤일로', 1.16, 0.22],
      ]
      bursts.forEach(([name, sizeMul, alpha], b) => {
        layers.push({
          name,
          shape: createShapeSpec('burst', {
            color: withAlpha(ctx.color, alpha),
            width: Math.round(base * 1.25 * sizeMul),
            height: Math.round(base * 1.25 * sizeMul),
            points: 14,
            strokeWidth: Math.max(2, Math.round(base * 0.012 * (b === 0 ? 1 : 1.8))),
            innerRatio: 0.55,
          }),
          tracks: [
            cycle({
              prop: 'opacity',
              unit: 'ratio',
              span,
              phase: 0,
              at: (x) => (x < 0.03 ? x / 0.03 : fadeGate(x, 0.12, 0.34)),
              steps: 16,
            }),
            cycle({
              prop: 'scale',
              unit: 'ratio',
              span,
              phase: 0,
              at: (x) => clamp(0.7 + 0.55 * g * easeOut(clamp01(x / 0.3), 2.6), 0.2, 2),
              steps: 12,
            }),
            // 본체만 떤다. 헤일로까지 같이 떨면 지터가 아니라 통째 회전으로 보인다.
            ...(b === 0
              ? [stepTrack({ prop: 'rotate', unit: 'deg', span, table: JITTER, base: 0, amp: 5 })]
              : [fixed('rotate', 'deg', 6)]),
          ],
        })
      })

      // 1) 링 두 겹. 굵고 빠른 링과 가늘고 느린 링이 겹으로 퍼진다.
      const rings: readonly [number, number, number, number, number][] = [
        [0.9, 0.02, 0, 0.34, 1],
        [0.7, 0.008, 0.06, 0.5, 0.55],
      ]
      rings.forEach(([sizeMul, strokeMul, delay, end, alpha], i) => {
        layers.push({
          name: `터짐 링 ${i + 1}`,
          shape: createShapeSpec('circle', {
            color: withAlpha(shiftColor(ctx.color, 0.1), 0.9 * alpha),
            width: Math.round(base * sizeMul),
            height: Math.round(base * sizeMul * 0.95),
            strokeWidth: Math.max(2, Math.round(base * strokeMul)),
          }),
          tracks: [
            cycle({
              prop: 'scale',
              unit: 'ratio',
              span,
              phase: 0,
              at: (x) => clamp(0.22 + (1.1 + 0.6 * g) * easeOut(clamp01((x - delay) / (end - delay)), 2), 0.2, 2),
              steps: 14,
            }),
            cycle({
              prop: 'opacity',
              unit: 'ratio',
              span,
              phase: 0,
              at: (x) =>
                x < delay ? 0 : x < delay + 0.03 ? (x - delay) / 0.03 : fadeGate(x, delay + 0.08, end),
              steps: 16,
            }),
          ],
        })
      })

      // 2) 불씨 여덟. 곧게 뻗지 않는다. 날아가다 아래로 처지는 포물선이다.
      SPARKS.forEach(([angleDeg, sizeMul, reachMul, droopMul], i) => {
        const a = rad(angleDeg)
        const size = Math.max(3, Math.round(base * 0.032 * sizeMul))
        const reach = 40 * g * reachMul
        const droop = 12 * g * droopMul
        const fly = (x: number): number => easeOut(clamp01(x / 0.44), 2.6)
        layers.push({
          name: `불씨 ${i + 1}`,
          shape: createShapeSpec('sparkle', {
            color: withAlpha(shiftColor(ctx.color, (i % 2) * 0.12 - 0.04), 0.92),
            width: size,
            height: Math.round(size * 1.2),
            points: 3 + (i % 2),
            innerRatio: 0.28,
          }),
          tracks: [
            fixed('rotate', 'deg', angleDeg + 90),
            cycle({
              prop: 'translateX',
              unit: 'percentOfCanvas',
              span,
              phase: 0,
              at: (x) => Math.cos(a) * reach * fly(x),
              steps: 14,
            }),
            cycle({
              prop: 'translateY',
              unit: 'percentOfCanvas',
              span,
              phase: 0,
              at: (x) => Math.sin(a) * reach * fly(x) + droop * fly(x) * fly(x),
              steps: 14,
            }),
            // 뻗을 때 늘었다가 힘이 빠지며 돌아온다.
            cycle({
              prop: 'scaleY',
              unit: 'ratio',
              span,
              phase: 0,
              at: (x) => clamp(1 + 1.4 * Math.exp(-6 * x), 0.4, 2.6),
              steps: 12,
            }),
            cycle({
              prop: 'opacity',
              unit: 'ratio',
              span,
              phase: 0,
              at: (x) => (x < 0.04 ? x / 0.04 : fadeGate(x, 0.2, 0.46)),
              steps: 16,
            }),
          ],
        })
      })

      // 3) 잔파편 셋. 중심 가까이에서 톡톡 튀는 십자 부스러기.
      const CHIPS: readonly [number, number, number][] = [
        [0.42, 0.35, 0.05],
        [0.6, 0.58, 0.1],
        [0.36, 0.62, 0.14],
      ]
      CHIPS.forEach(([sx, sy, delay], i) => {
        const size = Math.max(3, Math.round(base * 0.024 * (1 + 0.3 * (i % 2))))
        layers.push({
          name: `잔파편 ${i + 1}`,
          shape: createShapeSpec('cross', {
            color: withAlpha(ctx.color, 0.85),
            width: size,
            height: size,
          }),
          tracks: [
            fixed('translateX', 'percentOfCanvas', atRatio(sx)),
            fixed('translateY', 'percentOfCanvas', atRatio(sy)),
            stepTrack({ prop: 'rotate', unit: 'deg', span, table: JITTER, base: i * 30, amp: 24 }),
            cycle({
              prop: 'scale',
              unit: 'ratio',
              span,
              phase: 0,
              at: (x) =>
                clamp(0.3 + 0.9 * easeOut(clamp01((x - delay) / 0.12), 3), 0.2, 2),
              steps: 12,
            }),
            cycle({
              prop: 'opacity',
              unit: 'ratio',
              span,
              phase: 0,
              at: (x) =>
                x < delay ? 0 : x < delay + 0.03 ? (x - delay) / 0.03 : fadeGate(x, delay + 0.14, delay + 0.34),
              steps: 16,
            }),
          ],
        })
      })

      return { layers, durationFrames: span, loopMode: 'loop', fps }
    },
  },
]
