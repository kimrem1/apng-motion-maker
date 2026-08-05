/**
 * 도형 세트 구현이 공유하는 순수 헬퍼.
 *
 * 새 보간 로직을 만들지 않는다. 키프레임 만들기와 이징 적용은 모션 프리셋과
 * 같은 함수(motions/presets/shared.ts)를 쓴다. 두 벌이 되면 같은 이징 이름이
 * 두 곳에서 다른 곡선을 그린다.
 *
 * Math.random / Date.now 는 쓰지 않는다. 같은 입력이면 언제나 같은 장면이어야
 * 카드 미리보기와 실제 삽입 결과가 일치한다.
 */

import { FRAMES_MAX, SPEED_MAX, SPEED_MIN, type Track, type TrackProp, type TrackUnit } from '@/core/types.ts'
import { buildKeys, clamp, clamp01, type KeyPoint } from '@/motions/presets/shared.ts'
import { fpsForDuration } from '@/motions/apply.ts'
import type { SceneContext } from './types.ts'

export { clamp, clamp01 }

/** 세기를 크기 배수로 옮긴다. 0.5 에서 정확히 1.0 이다. 모션 프리셋과 같은 규칙이다. */
export function gain(strength: number): number {
  return 0.35 + 1.3 * clamp01(strength)
}

export interface Timing {
  /** 이 세트의 **한 주기**가 쓸 프레임 수. */
  span: number
  /** 그 길이를 담기 위해 확정된 fps. */
  fps: number
  /**
   * 그 주기를 몇 번 이어 붙일 것인가. 이미 만들어 둔 타임라인에 맞출 때만 1 보다 크다.
   *
   * 세트 구현은 이 값을 쓰지 않는다. 한 주기만 만들면 되고, 이어 붙이는 일은
   * registry.ts 의 buildShapeScene 이 한다. 세트마다 반복을 손으로 짜면 43벌이 된다.
   */
  reps: number
}

/**
 * 한 장면이 쓰는 키 개수의 상한.
 *
 * 프레임 수가 키 개수보다 적으면 정수 프레임 격자에 키를 나란히 놓을 수 없다.
 * buildKeys 는 겹친 키를 뒤로 한 칸씩 미는데, 그러면 마지막 키가 프레임 밖으로
 * 밀려나 화면에 안 나온다. 셔터가 닫힌 채로 끝나고 테두리가 남은 채로 끝나는
 * 사고가 그것이다. 그래서 프레임 수의 하한을 여기로 잡는다.
 */
const MAX_STOPS = 6

/**
 * 재생 시간을 프레임 수로 바꾼다.
 *
 * 시간으로 계산하고 마지막에만 프레임으로 바꾼다. 느린 속도에서는 fps 도 함께
 * 내려야 프레임 상한(120) 안에서 시간이 늘어난다. 두 계산을 분리하면 속도를 낮췄는데
 * 길이가 늘지 않는다.
 *
 * 이미 만들어 둔 타임라인이 있으면(fitFrames) 그 길이에 맞춘다. 배경 장식을 얹었다고
 * 사용자가 만들어 둔 5초짜리 모션이 1.2초로 잘리면 안 된다.
 *
 * 그때도 속도는 살아 있어야 한다. 예전에는 fitFrames 를 그대로 span 으로 썼고, 그러면
 * 속도 노브가 아무 일도 하지 않아 화면에서 잠겨 있었다. 게다가 2초짜리 파동 하나를
 * 문서 길이만큼 늘여 버려서 세트가 설계된 템포를 잃었다.
 *
 * 그래서 fit 에서도 속도로 **한 주기**를 구하고, 그 주기를 문서 길이 안에 몇 번
 * 넣을지(reps)를 함께 낸다. 지키는 규칙은 셋이다.
 *
 *   1. 속도 1 에서는 문서 길이가 변하지 않는다. 세트를 얹었다는 이유만으로
 *      남이 맞춰 둔 타임라인이 길어지거나 짧아지면 안 된다.
 *   2. 속도를 올리면 같은 길이 안에서 주기가 잘게 쪼개진다.
 *   3. 한 주기도 다 못 담을 만큼 느려지면, 그때만 문서를 늘린다. 여기서 길이를
 *      묶어 두면 슬라이더 왼쪽 절반이 죽는다. 줄이지는 않으므로 남의 모션은
 *      아무것도 잃지 않는다.
 *
 * 늘린 길이가 다음 기준선이 되면 속도를 되돌려도 안 돌아오므로, 기준선은 세트를
 * 처음 넣을 때 값을 기억해 쓴다 (state/shapeUi.ts AppliedScene.fitFrames).
 */
export function timingOf(ctx: SceneContext, defaultMs: number): Timing {
  const speed = clamp(Number.isFinite(ctx.speed) && ctx.speed > 0 ? ctx.speed : 1, SPEED_MIN, SPEED_MAX)

  if (ctx.fitFrames !== undefined && ctx.fitFrames >= 2) {
    const total = clamp(Math.round(ctx.fitFrames), MAX_STOPS, FRAMES_MAX)
    // fps 는 문서 것을 그대로 쓴다. 여기서 내리면 남의 모션까지 함께 느려진다.
    const fps = ctx.fps > 0 ? ctx.fps : 25
    /*
     * 속도 1 에서 이 문서가 세트를 몇 번 담는가. 이것이 기준이다.
     *
     * 주기가 문서보다 길면 0.x 가 나오는데 1 로 올린다. 그 세트는 문서 길이에
     * 맞춰 한 번만 도는 것이 속도 1 이다. 여기서 늘려 버리면 규칙 1 이 깨진다.
     */
    const natural = Math.max(MAX_STOPS, Math.round((defaultMs / 1000) * fps))
    const repsAt1 = Math.max(1, Math.round(total / natural))
    const want = repsAt1 * speed

    if (want < 1) {
      // 한 주기도 다 못 담는다. 문서를 늘린다.
      const span = clamp(Math.round(total / want), MAX_STOPS, FRAMES_MAX)
      return { span, fps, reps: 1 }
    }
    // 주기 하나가 MAX_STOPS 보다 짧아지면 키를 정수 프레임에 못 놓는다.
    const reps = clamp(Math.round(want), 1, Math.max(1, Math.floor(total / MAX_STOPS)))
    return { span: clamp(Math.round(total / reps), MAX_STOPS, FRAMES_MAX), fps, reps }
  }

  const sec = defaultMs / 1000 / speed
  const fps = fpsForDuration(sec, ctx.fps > 0 ? ctx.fps : 25)
  return { span: clamp(Math.round(sec * fps), MAX_STOPS, FRAMES_MAX), fps, reps: 1 }
}

/**
 * 키를 놓을 정수 프레임들. 반드시 오름차순이고 마지막이 span 을 넘지 않는다.
 *
 * ratios 는 0~1 의 비율이고 오름차순이어야 한다. 반올림 때문에 겹치면 앞에서부터
 * 한 칸씩 밀고, 그러다 끝을 넘으면 뒤에서부터 되밀어 마지막이 정확히 제자리에
 * 오게 한다. 앞으로만 밀면 짧은 장면에서 마지막 키가 프레임 밖으로 나가 영영
 * 평가되지 않는다 (셔터가 닫힌 채로 끝나던 사고).
 */
export function stops(span: number, ratios: readonly number[]): number[] {
  const total = Math.max(2, Math.round(span))
  const out: number[] = []
  for (let i = 0; i < ratios.length; i += 1) {
    let f = Math.round(total * clamp01(ratios[i] ?? 0))
    const prev = out[i - 1]
    if (prev !== undefined && f <= prev) f = prev + 1
    out.push(f)
  }
  // 뒤에서부터 되민다. 마지막 항목은 요청한 자리(보통 span)를 넘지 않는다.
  let ceiling = Math.min(out[out.length - 1] ?? total, total)
  for (let i = out.length - 1; i >= 0; i -= 1) {
    const f = Math.min(out[i] ?? 0, ceiling)
    out[i] = f
    ceiling = f - 1
  }
  return out
}

/** stops() 가 준 프레임과 값 목록을 짝지어 KeyPoint 로 만든다. */
export function keysOf(
  frames: readonly number[],
  values: readonly { v: number; ease?: string }[],
): KeyPoint[] {
  return values.map((item, i) => ({
    f: frames[i] ?? i,
    v: item.v,
    ...(item.ease ? { ease: item.ease } : {}),
  }))
}

/** 트랙 하나. id 는 문서에 심을 때 스토어가 다시 매긴다. */
export function track(prop: TrackProp, unit: TrackUnit, points: KeyPoint[], ease: string): Track {
  return { id: `sh.${prop}`, prop, unit, keys: buildKeys(points, ease) }
}

/** 움직이지 않는 값. 위치를 잡을 때 쓴다. */
export function fixed(prop: TrackProp, unit: TrackUnit, value: number): Track {
  return { id: `sh.${prop}`, prop, unit, keys: [{ f: 0, v: value, interp: 'bezier' }] }
}

/**
 * 한 주기 함수를 위상만 옮겨 깐다. 이 파일에서 가장 중요한 헬퍼다.
 *
 * 막대 일곱 개가 시간차를 두고 오르내리는 것도, 링 세 개가 차례로 퍼지는 것도,
 * 점들이 원을 도는 것도 전부 "같은 주기 함수 + 다른 위상" 이다. 위상을 표현할 방법이
 * 모디파이어에 없으므로(sine 은 t=0 에서 시작한다) 키프레임으로 편다.
 *
 * 마지막 키의 값이 첫 키와 정확히 같아 무한 반복에서 이음새가 보이지 않는다.
 *
 * **곡선은 이징이 아니라 at() 이 만든다.** 키 사이는 언제나 직선으로 잇는다.
 * 조각마다 가속 이징을 걸면 12조각이 12번 가속·감속해 계단처럼 보인다.
 */
export function cycle(args: {
  prop: TrackProp
  unit: TrackUnit
  span: number
  /** 0~1. 주기 안에서 어디부터 시작할 것인가. */
  phase: number
  /** x 는 0~1 주기 위치다. */
  at(x: number): number
  /** 한 주기를 몇 조각으로 자를 것인가. 프레임 수보다 잘게 자를 수는 없다. */
  steps?: number
}): Track {
  const span = Math.max(2, Math.round(args.span))
  const steps = Math.max(2, Math.min(Math.round(args.steps ?? 12), span))
  const phase = ((args.phase % 1) + 1) % 1

  const points: KeyPoint[] = []
  for (let k = 0; k <= steps; k += 1) {
    // 마지막은 첫 값을 그대로 되돌려 준다. (phase + 1) % 1 의 부동소수 오차조차
    // 두지 않는다. 이음새 검사는 값이 정확히 같기를 요구한다.
    const x = k === steps ? phase : (phase + k / steps) % 1
    points.push({ f: Math.round((span * k) / steps), v: args.at(x) })
  }
  return track(args.prop, args.unit, points, 'linear')
}

/**
 * 한쪽 끝에서 반대쪽 끝으로 끊임없이 흘러가는 값. 떨어지는 색종이가 이것이다.
 *
 * cycle 로는 안 된다. cycle 은 마지막에 첫 값으로 되돌리는데, 위치가 되돌아오면
 * 조각이 화면을 거슬러 올라간다. 그렇다고 그냥 한 방향으로만 흘리면 위상을 줄 수 없어
 * 모든 조각이 한 줄로 같이 떨어진다.
 *
 * 그래서 되돌아가는 순간을 **한 프레임에 몰아넣는다.** hold 이징이 끝 값을 붙잡고
 * 있다가 다음 키에서 한 번에 처음으로 튄다. from 과 to 가 둘 다 화면 밖이면 그 튐이
 * 보이지 않는다. 위상만 다르게 주면 조각들이 제각각 떨어진다.
 */
export function stream(args: {
  prop: TrackProp
  unit: TrackUnit
  span: number
  /** 0~1. 이 조각이 주기의 어디쯤에서 시작하는가. */
  phase: number
  /** 화면 밖이어야 한다. */
  from: number
  /** 화면 밖이어야 한다. */
  to: number
}): Track {
  const span = Math.max(3, Math.round(args.span))
  const phase = ((args.phase % 1) + 1) % 1
  const lerp = (x: number): number => args.from + (args.to - args.from) * x

  // 위상이 0 이면 되돌아가는 지점이 곧 주기의 끝이다. 키 두 개로 충분하다.
  if (phase < 1 / span) {
    return track(
      args.prop,
      args.unit,
      [{ f: 0, v: args.from, ease: 'linear' }, { f: span, v: args.to }],
      'linear',
    )
  }

  const wrapAt = clamp(Math.round(span * (1 - phase)), 1, span - 2)
  return track(
    args.prop,
    args.unit,
    [
      { f: 0, v: lerp(phase), ease: 'linear' },
      { f: wrapAt, v: args.to, ease: 'hold' },
      { f: wrapAt + 1, v: args.from, ease: 'linear' },
      { f: span, v: lerp(phase) },
    ],
    'linear',
  )
}

/**
 * 나타났다 사라지는 봉우리.
 *
 * end 앞에서 이미 0 이 되는 것이 핵심이다. 퍼지는 링은 주기가 끝나면 크기를 처음으로
 * 되감아야 하는데, 그 되감기 구간에 투명도가 조금이라도 남아 있으면 "줄어드는 링"
 * 이 한 순간 보인다. end 를 1 보다 작게 두면 되감기가 완전히 투명한 구간에서 끝난다.
 */
export function bell(x: number, rise = 0.18, end = 0.88): number {
  if (x <= 0 || x >= end) return 0
  return x < rise ? x / rise : 1 - (x - rise) / (end - rise)
}

/** 사인 한 주기. [-1, 1] */
export function wave(x: number): number {
  return Math.sin(x * Math.PI * 2)
}

/** 빠르게 시작해 천천히 멈춘다. */
export function easeOut(x: number, power = 3): number {
  return 1 - Math.pow(1 - clamp01(x), power)
}

/** 천천히 시작해 빠르게 끝난다. */
export function easeIn(x: number, power = 3): number {
  return Math.pow(clamp01(x), power)
}

/** 양끝이 부드럽다. */
export function easeInOut(x: number): number {
  const t = clamp01(x)
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
}

/**
 * 캔버스 대비 비율을 퍼센트로. 이동 트랙의 단위는 percentOfCanvas 로 통일한다.
 *
 * px 로 두면 캔버스를 바꿀 때만 따라가고(스토어가 px 트랙을 민다), 자르기처럼
 * 캔버스만 줄어드는 경우에는 도형이 화면 밖으로 나간다. 퍼센트는 언제나 따라간다.
 */
export function pct(ratio: number): number {
  return ratio * 100
}

/**
 * n 개를 가로로 고르게 늘어놓았을 때 i 번째의 중심 위치(캔버스 폭 대비 -0.5~0.5).
 * 양 끝에 반 칸씩 여백이 남아 첫 항목과 마지막 항목이 프레임에 붙지 않는다.
 */
export function slot(i: number, n: number, spread = 1): number {
  const count = Math.max(1, n)
  return ((i + 0.5) / count - 0.5) * spread
}

/**
 * 화면 안의 비율 좌표(0~1, 왼쪽 위가 0)를 이동 트랙 값(percentOfCanvas)으로 바꾼다.
 * 캔버스 중앙이 원점이므로 0.5 를 뺀다.
 */
export function atRatio(ratio: number): number {
  return (ratio - 0.5) * 100
}

/**
 * 한 주기 안에서 조각마다 다른 값을 꺼내는 고정 표.
 *
 * Math.random 을 쓸 수 없고 써서도 안 된다. 같은 세트가 언제나 같은 배치여야
 * 카드 미리보기와 실제 결과가 같다. 표를 순환 참조해 항목 수와 무관하게 쓴다.
 */
export function pick(table: readonly number[], i: number, fallback = 0): number {
  if (table.length === 0) return fallback
  return table[((i % table.length) + table.length) % table.length] ?? fallback
}
