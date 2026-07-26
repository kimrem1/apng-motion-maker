/**
 * B. 사라짐.
 *
 * 4종 중 combo.slideFadeGlitch 는 화면 밀림 이펙트가 있어야 성립해서 combo.ts 에 있다.
 * 사라지는 모션은 끝에서 확 빠져나가는 easeInExpo 계열이 기본이다.
 */

import type { MotionPreset, PresetEmission } from '@/motions/types.ts'
import {
  DIRECTION_OPTIONS,
  buildKeys,
  clamp,
  clamp01,
  directionVector,
  emitDuration,
  gainOf,
  lastFrame,
  loopFor,
  num,
  resolveSpan,
  str,
  track,
} from './shared.ts'

/** 서서히 사라지기. 사용자가 명시한 페이드 항목이다. */
const fadeOut: MotionPreset = {
  id: 'fade.out',
  label: '서서히 사라지기',
  hint: '천천히 흐려지다 마지막에 확 빠진다.',
  category: 'disappear',
  tags: ['fade'],
  loopSafe: 'once',
  overscan: 'auto',
  easy: false,
  size: 'light',
  defaultDurationMs: 600,
  params: [
    { key: 'hold', label: '버티는 시간', type: 'number', min: 0, max: 60, step: 1, unit: '%', default: 0 },
  ],
  emit(ctx): PresetEmission {
    const span = resolveSpan(ctx, 600)
    const end = lastFrame(span, 'once')
    const hold = clamp(Math.round((num(ctx.params, 'hold', 0) / 100) * end), 0, Math.max(0, end - 1))

    const points = hold > 0
      ? [{ f: 0, v: 1 }, { f: hold, v: 1 }, { f: end, v: 0 }]
      : [{ f: 0, v: 1 }, { f: end, v: 0 }]
    const tracks = [track('opacity', 'ratio', buildKeys(points, 'easeInExpo'))]

    return { tracks, durationFrames: emitDuration(span, tracks), suggestedLoop: loopFor('once') }
  },
}

/**
 * 밀려나며 사라지기. 사용자가 명시한 슬라이드 + 페이드아웃 항목이다.
 * 화면 밖으로 나가는 것이 의도이므로 오버스캔 솔버를 끈다.
 */
const slideOutFade: MotionPreset = {
  id: 'slide.outFade',
  label: '밀려나며 사라지기',
  hint: '한쪽으로 미끄러져 나가며 흐려진다.',
  category: 'disappear',
  tags: ['move', 'fade'],
  loopSafe: 'once',
  overscan: 'allowEmpty',
  easy: true,
  size: 'light',
  defaultDurationMs: 700,
  params: [
    { key: 'direction', label: '나가는 방향', type: 'select', options: DIRECTION_OPTIONS, default: 'left' },
    { key: 'distance', label: '이동 거리', type: 'number', min: 2, max: 40, step: 1, unit: '%', default: 12 },
  ],
  emit(ctx): PresetEmission {
    const span = resolveSpan(ctx, 700)
    const end = lastFrame(span, 'once')
    const gain = gainOf(ctx.strength)
    const dir = directionVector(str(ctx.params, 'direction', 'left'))
    const distance = clamp(num(ctx.params, 'distance', 12) * gain, 1, 60) * dir.sign

    // 투명도는 3.5할 지점부터 떨어뜨린다. 처음부터 흐려지면 어디로 갔는지 안 보인다.
    const fadeStart = clamp(Math.round(end * 0.35), 1, Math.max(1, end - 1))

    const tracks = [
      track(dir.prop, 'percentOfCanvas', buildKeys([{ f: 0, v: 0 }, { f: end, v: distance }], 'easeInExpo')),
      track('opacity', 'ratio', buildKeys([{ f: 0, v: 1 }, { f: fadeStart, v: 1 }, { f: end, v: 0 }], 'easeInExpo')),
    ]

    return { tracks, durationFrames: emitDuration(span, tracks), suggestedLoop: loopFor('once') }
  },
}

/**
 * 색으로 덮으며 전환.
 * 덮는 색은 캔버스 배경색을 그대로 쓴다. 레이어를 한 장 더 만들지 않는 편이
 * 되돌리기와 레이어 목록을 깔끔하게 유지한다. 색을 따로 고르는 기능은 배경 설정에 있다.
 */
const fadeDip: MotionPreset = {
  id: 'fade.dip',
  label: '색으로 덮으며 전환',
  hint: '중간에 배경색으로 한 번 잠겼다가 돌아온다.',
  category: 'disappear',
  tags: ['fade'],
  loopSafe: 'once',
  overscan: 'auto',
  easy: false,
  size: 'light',
  defaultDurationMs: 900,
  params: [
    { key: 'at', label: '잠기는 시점', type: 'number', min: 20, max: 80, step: 1, unit: '%', default: 50 },
    { key: 'depth', label: '잠기는 깊이', type: 'number', min: 20, max: 100, step: 1, unit: '%', default: 100 },
  ],
  emit(ctx): PresetEmission {
    const span = resolveSpan(ctx, 900)
    const end = lastFrame(span, 'once')
    const gain = gainOf(ctx.strength)
    const at = clamp(Math.round((num(ctx.params, 'at', 50) / 100) * end), 1, Math.max(1, end - 1))
    const depth = clamp01((num(ctx.params, 'depth', 100) / 100) * gain)

    const tracks = [
      track(
        'opacity',
        'ratio',
        buildKeys([{ f: 0, v: 1 }, { f: at, v: clamp01(1 - depth) }, { f: end, v: 1 }], 'easeInOutQuart'),
      ),
    ]
    return { tracks, durationFrames: emitDuration(span, tracks), suggestedLoop: loopFor('once') }
  },
}

export const DISAPPEAR_PRESETS: MotionPreset[] = [fadeOut, slideOutFade, fadeDip]
