/**
 * E. 사진 훑기. 4종 전부.
 *
 * 이 카테고리는 scale / translate 를 직접 만들지 않고 **뷰포트 rect 두 개**로 정의한다
 * rect 가 이미지 경계 안에 있으면 그 순간 캔버스가 100% 찬다는 것이
 * 오버스캔 부등식과 정확히 동치라서 솔버를 돌릴 필요가 없다.
 *
 * 대신 조건이 하나 붙는다. 오버슈트 이징을 쓰면 중간 rect 가 경계를 벗어난다.
 * 그래서 이 카테고리는 non-overshoot 이징만 쓴다. 켄번즈의 미감과도 일치한다.
 *
 * "켄번즈", "패럴랙스" 같은 용어는 UI 에 노출하지 않는다.
 */

import { hashSeed, mulberry32 } from '@/core/rng.ts'
import type { MotionPreset, PresetEmission, PresetNotice } from '@/motions/types.ts'
import {
  buildKeys,
  clamp,
  constTrack,
  emitDuration,
  gainOf,
  kenBurnsTracks,
  lastFrame,
  loopFor,
  num,
  resolveSpan,
  spread,
  track,
  type ViewRect,
} from './shared.ts'

/** 천천히 훑기. 시작은 전체, 끝은 살짝 당긴 자리다. */
const kbClassic: MotionPreset = {
  id: 'kb.classic',
  label: '천천히 훑기',
  hint: '사진 전체에서 시작해 천천히 한쪽으로 다가간다.',
  category: 'kenburns',
  tags: ['kenburns', 'scale', 'move'],
  loopSafe: 'pingPongOnly',
  overscan: 'auto',
  easy: true,
  size: 'normal',
  defaultDurationMs: 4000,
  params: [
    { key: 'zoom', label: '다가가는 정도', type: 'number', min: 2, max: 40, step: 1, unit: '%', default: 18 },
    { key: 'panX', label: '좌우 이동', type: 'number', min: -20, max: 20, step: 1, unit: '%', default: -5 },
    { key: 'panY', label: '상하 이동', type: 'number', min: -20, max: 20, step: 1, unit: '%', default: -2 },
  ],
  emit(ctx): PresetEmission {
    const span = resolveSpan(ctx, 4000)
    const end = lastFrame(span, 'pingPongOnly')
    const gain = gainOf(ctx.strength)

    const from: ViewRect = { cx: 0.5, cy: 0.5, w: 1 }
    const to: ViewRect = {
      cx: 0.5 + (num(ctx.params, 'panX', -5) / 100) * gain,
      cy: 0.5 + (num(ctx.params, 'panY', -2) / 100) * gain,
      w: clamp(1 - (num(ctx.params, 'zoom', 18) / 100) * gain, 0.3, 1),
    }

    const tracks = kenBurnsTracks(from, to, end, 'easeInOutCubic')
    return { tracks, durationFrames: emitDuration(span, tracks), suggestedLoop: loopFor('pingPongOnly') }
  },
}

/**
 * 무작위 훑기.
 * 무작위지만 결정론이다. 같은 시드는 항상 같은 훑기를 만든다.
 * 렌더 경로에서 Math.random 은 금지다.
 */
const kbRandom: MotionPreset = {
  id: 'kb.random',
  label: '무작위 훑기',
  hint: '매번 다른 방향으로 훑는다. 같은 설정이면 항상 같은 결과가 나온다.',
  category: 'kenburns',
  tags: ['kenburns', 'scale', 'move'],
  loopSafe: 'pingPongOnly',
  overscan: 'auto',
  easy: false,
  size: 'normal',
  defaultDurationMs: 4000,
  params: [
    { key: 'zoom', label: '다가가는 정도', type: 'number', min: 2, max: 40, step: 1, unit: '%', default: 22 },
    { key: 'pan', label: '이동 범위', type: 'number', min: 0, max: 20, step: 1, unit: '%', default: 12 },
  ],
  emit(ctx): PresetEmission {
    const span = resolveSpan(ctx, 4000)
    const end = lastFrame(span, 'pingPongOnly')
    const gain = gainOf(ctx.strength)
    const rnd = mulberry32(hashSeed(ctx.seed >>> 0, 'kb.random', 0))

    const zoom = clamp((num(ctx.params, 'zoom', 22) / 100) * gain, 0.02, 0.7)
    const pan = clamp((num(ctx.params, 'pan', 12) / 100) * gain, 0, 0.3)

    // 좁은 rect 의 폭. 0.55~1.0 배로 흔들어 매번 다른 세기가 나오게 한다.
    const near = clamp(1 - zoom * (0.55 + 0.45 * rnd()), 0.3, 0.98)
    const zoomIn = rnd() < 0.5
    const dirX = rnd() < 0.5 ? 1 : -1
    const dirY = rnd() < 0.5 ? 1 : -1
    const offX = pan * (0.3 + 0.7 * rnd()) * 0.5 * dirX
    const offY = pan * (0.3 + 0.7 * rnd()) * 0.5 * dirY

    const wide: ViewRect = { cx: 0.5 - offX, cy: 0.5 - offY, w: 1 }
    const tight: ViewRect = { cx: 0.5 + offX, cy: 0.5 + offY, w: near }

    const tracks = zoomIn
      ? kenBurnsTracks(wide, tight, end, 'easeInOutCubic')
      : kenBurnsTracks(tight, wide, end, 'easeInOutCubic')

    return { tracks, durationFrames: emitDuration(span, tracks), suggestedLoop: loopFor('pingPongOnly') }
  },
}

/** 한 점으로 다가가기. 목표점이 경계 밖이면 rect 제약이 자동으로 안쪽으로 당긴다. */
const kbZoomToPoint: MotionPreset = {
  id: 'kb.zoomToPoint',
  label: '한 점으로 다가가기',
  hint: '지정한 지점을 향해 곧게 파고든다.',
  category: 'kenburns',
  tags: ['kenburns', 'scale'],
  loopSafe: 'pingPongOnly',
  overscan: 'auto',
  easy: false,
  size: 'normal',
  defaultDurationMs: 2500,
  params: [
    { key: 'x', label: '목표 가로 위치', type: 'number', min: 0, max: 100, step: 1, unit: '%', default: 50 },
    { key: 'y', label: '목표 세로 위치', type: 'number', min: 0, max: 100, step: 1, unit: '%', default: 40 },
    { key: 'zoom', label: '다가가는 정도', type: 'number', min: 5, max: 70, step: 1, unit: '%', default: 40 },
  ],
  emit(ctx): PresetEmission {
    const span = resolveSpan(ctx, 2500)
    const end = lastFrame(span, 'pingPongOnly')
    const gain = gainOf(ctx.strength)

    const from: ViewRect = { cx: 0.5, cy: 0.5, w: 1 }
    const to: ViewRect = {
      cx: clamp(num(ctx.params, 'x', 50) / 100, 0, 1),
      cy: clamp(num(ctx.params, 'y', 40) / 100, 0, 1),
      w: clamp(1 - (num(ctx.params, 'zoom', 40) / 100) * gain, 0.3, 1),
    }

    const tracks = kenBurnsTracks(from, to, end, 'easeInOutQuart')
    return { tracks, durationFrames: emitDuration(span, tracks), suggestedLoop: loopFor('pingPongOnly') }
  },
}

/**
 * 깊이감 흔들기.
 * 레이어를 자동 복제하지 않는다. 선택된 두 장에 배경과 전경 역할을 배정한다.
 * 배경은 확대한 채로 크게 움직이고 전경은 반대 방향으로 조금만 움직인다.
 * 그 속도 차이가 깊이로 읽힌다. 캔버스를 채울 의무는 배경 레이어에만 있다.
 *
 * 배경 흐리기는 이펙트 쪽 담당이다. 없어도 시차만으로 깊이가 보인다.
 */
const parallaxDual: MotionPreset = {
  id: 'parallax.dual',
  label: '깊이감 흔들기',
  hint: '뒤쪽과 앞쪽이 서로 다르게 움직여 입체로 보인다.',
  category: 'kenburns',
  tags: ['kenburns', 'move'],
  loopSafe: 'seamless',
  overscan: 'auto',
  easy: false,
  size: 'normal',
  defaultDurationMs: 3000,
  params: [
    { key: 'distance', label: '이동 거리', type: 'number', min: 1, max: 20, step: 1, unit: '%', default: 6 },
    { key: 'depth', label: '앞뒤 차이', type: 'number', min: 5, max: 100, step: 5, unit: '%', default: 35 },
    { key: 'background', label: '뒤쪽 확대', type: 'number', min: 5, max: 60, step: 1, unit: '%', default: 25 },
  ],
  emit(ctx): PresetEmission {
    const span = resolveSpan(ctx, 3000)
    const end = lastFrame(span, 'seamless')
    const gain = gainOf(ctx.strength)

    const distance = clamp(num(ctx.params, 'distance', 6) * gain, 0.5, 25)
    const factor = clamp(num(ctx.params, 'depth', 35), 5, 100) / 100
    // 뒤쪽 확대량은 이동 거리가 요구하는 여유(k = 1 + 2d)보다 항상 크게 잡는다.
    // 그래야 배경 레이어가 스스로 캔버스를 채우고 솔버가 개입하지 않는다.
    const bgZoom = Math.max(
      clamp(num(ctx.params, 'background', 25) * gain, 5, 80) / 100,
      (2 * distance) / 100 + 0.02,
    )

    const frames = spread(end, 2)
    const pan = (amp: number) => frames.map((f, i) => ({ f, v: i % 2 === 0 ? -amp : amp }))

    const background = [
      constTrack('scale', 'ratio', 1 + bgZoom, end),
      track('translateX', 'percentOfCanvas', buildKeys(pan(distance), 'easeInOutQuart')),
    ]
    const foreground = [
      // 전경은 반대 방향으로 조금만 움직인다. 같은 방향이면 두 장이 한 장처럼 보인다.
      track('translateX', 'percentOfCanvas', buildKeys(pan(-distance * factor), 'easeInOutQuart')),
    ]

    const notices: PresetNotice[] = []
    if ((ctx.layerCount ?? 1) < 2) {
      notices.push({
        code: 'needsSecondLayer',
        message: '사진이 한 장이라 뒤쪽만 움직입니다. 앞쪽에 놓을 그림을 한 장 더 올려 보세요.',
      })
    }

    return {
      tracks: background,
      roles: [
        { role: 'background', tracks: background },
        { role: 'foreground', tracks: foreground },
      ],
      durationFrames: emitDuration(span, background),
      suggestedLoop: loopFor('seamless'),
      notices,
    }
  },
}

export const KENBURNS_PRESETS: MotionPreset[] = [kbClassic, kbRandom, kbZoomToPoint, parallaxDual]
