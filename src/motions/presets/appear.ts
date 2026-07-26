/**
 * A. 등장.
 *
 * 6종 중 combo.popGlitchIn 은 블록 깨짐 이펙트가 있어야 성립해서 combo.ts 에 있다.
 * 등장 프리셋은 전부 1회 재생이다. 무한 반복을 걸면 매 사이클 급가속이 반복된다.
 */

import type { MotionPreset, PresetEmission } from '@/motions/types.ts'
import {
  DIRECTION_OPTIONS,
  bool,
  buildKeys,
  clamp,
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

/**
 * 톡 튀며 등장.
 * 목표보다 살짝 넘었다가 돌아오는 오버슈트가 쫀득함의 정체다.
 * 오버슈트는 값 키프레임이 아니라 popBack 핸들(0.34, 1.25, 0.64, 1)에서 나온다.
 * 시작 구간의 k 가 1 미만이라 캔버스를 채워야 하는 레이어에서는 보정이 필요하다.
 */
const zoomPop: MotionPreset = {
  id: 'zoom.pop',
  label: '톡 튀며 등장',
  hint: '작게 시작해 살짝 넘쳤다가 제자리를 잡는다.',
  category: 'appear',
  tags: ['scale', 'fade'],
  loopSafe: 'once',
  overscan: 'required',
  easy: true,
  size: 'light',
  defaultDurationMs: 500,
  params: [
    { key: 'from', label: '시작 크기', type: 'number', min: 0.5, max: 0.98, step: 0.01, default: 0.86 },
    { key: 'fade', label: '흐리게 시작', type: 'boolean', default: true },
  ],
  emit(ctx): PresetEmission {
    const span = resolveSpan(ctx, 500)
    const end = lastFrame(span, 'once')
    const gain = gainOf(ctx.strength)
    const from = clamp(1 - (1 - num(ctx.params, 'from', 0.86)) * gain, 0.5, 0.98)

    const tracks = [track('scale', 'ratio', buildKeys([{ f: 0, v: from }, { f: end, v: 1 }], 'popBack'))]

    if (bool(ctx.params, 'fade', true)) {
      // 크기보다 투명도를 먼저 끝내야 튀는 순간이 또렷하게 보인다.
      const fadeEnd = clamp(Math.round(end * 0.5), 1, end)
      tracks.push(track('opacity', 'ratio', buildKeys([{ f: 0, v: 0 }, { f: fadeEnd, v: 1 }], 'easeOutCirc')))
    }

    return { tracks, durationFrames: emitDuration(span, tracks), suggestedLoop: loopFor('once') }
  },
}

/** 서서히 나타나기. 사용자가 명시한 페이드 항목이다. */
const fadeIn: MotionPreset = {
  id: 'fade.in',
  label: '서서히 나타나기',
  hint: '투명한 상태에서 천천히 드러난다.',
  category: 'appear',
  tags: ['fade'],
  loopSafe: 'once',
  overscan: 'auto',
  easy: true,
  size: 'light',
  defaultDurationMs: 600,
  params: [
    { key: 'delay', label: '시작 지연', type: 'number', min: 0, max: 50, step: 1, unit: '%', default: 0 },
  ],
  emit(ctx): PresetEmission {
    const span = resolveSpan(ctx, 600)
    const end = lastFrame(span, 'once')
    const delay = clamp(Math.round((num(ctx.params, 'delay', 0) / 100) * end), 0, Math.max(0, end - 1))

    const points = delay > 0
      ? [{ f: 0, v: 0 }, { f: delay, v: 0 }, { f: end, v: 1 }]
      : [{ f: 0, v: 0 }, { f: end, v: 1 }]
    const tracks = [track('opacity', 'ratio', buildKeys(points, 'easeOutCirc'))]

    return { tracks, durationFrames: emitDuration(span, tracks), suggestedLoop: loopFor('once') }
  },
}

/**
 * 밀려 들어오며 나타나기. 사용자가 명시한 슬라이드 + 페이드 항목이다.
 * 시작 순간에는 화면 밖에 있는 것이 의도라서 오버스캔 솔버를 끈다.
 */
const slideInFade: MotionPreset = {
  id: 'slide.inFade',
  label: '밀려 들어오며 나타나기',
  hint: '한쪽에서 미끄러져 들어오며 또렷해진다.',
  category: 'appear',
  tags: ['move', 'fade'],
  loopSafe: 'once',
  overscan: 'allowEmpty',
  easy: true,
  size: 'light',
  defaultDurationMs: 700,
  params: [
    { key: 'direction', label: '들어오는 방향', type: 'select', options: DIRECTION_OPTIONS, default: 'left' },
    { key: 'distance', label: '이동 거리', type: 'number', min: 2, max: 40, step: 1, unit: '%', default: 10 },
  ],
  emit(ctx): PresetEmission {
    const span = resolveSpan(ctx, 700)
    const end = lastFrame(span, 'once')
    const gain = gainOf(ctx.strength)
    const dir = directionVector(str(ctx.params, 'direction', 'left'))
    const distance = clamp(num(ctx.params, 'distance', 10) * gain, 1, 60) * dir.sign

    // 투명도는 6할 지점에서 끝낸다. 끝까지 흐리면 도착이 흐지부지해진다.
    const fadeEnd = clamp(Math.round(end * 0.6), 1, end)

    const tracks = [
      track(dir.prop, 'percentOfCanvas', buildKeys([{ f: 0, v: distance }, { f: end, v: 0 }], 'easeOutQuint')),
      track('opacity', 'ratio', buildKeys([{ f: 0, v: 0 }, { f: fadeEnd, v: 1 }], 'easeOutQuint')),
    ]

    return { tracks, durationFrames: emitDuration(span, tracks), suggestedLoop: loopFor('once') }
  },
}

/**
 * 커지며 등장. 사용자가 명시한 "축소에서 확대" 항목이다.
 * k 가 1 에서 출발해 커지기만 하므로 전 구간 안전하고 업스케일도 없다.
 */
const zoomUpIn: MotionPreset = {
  id: 'zoom.upIn',
  label: '커지며 등장',
  hint: '꽉 찬 상태에서 시작해 점점 커진다.',
  category: 'appear',
  tags: ['scale'],
  loopSafe: 'once',
  overscan: 'auto',
  easy: true,
  size: 'normal',
  defaultDurationMs: 900,
  params: [
    { key: 'amount', label: '커지는 정도', type: 'number', min: 5, max: 60, step: 1, unit: '%', default: 25 },
  ],
  emit(ctx): PresetEmission {
    const span = resolveSpan(ctx, 900)
    const end = lastFrame(span, 'once')
    const amount = clamp(num(ctx.params, 'amount', 25) * gainOf(ctx.strength), 2, 80) / 100

    const tracks = [
      track('scale', 'ratio', buildKeys([{ f: 0, v: 1 }, { f: end, v: 1 + amount }], 'easeOutExpo')),
    ]
    return { tracks, durationFrames: emitDuration(span, tracks), suggestedLoop: loopFor('once') }
  },
}

/** 작아지며 등장. 사용자가 명시한 "확대에서 축소" 항목이다. 경우 A 의 시간 역순이다. */
const zoomDownIn: MotionPreset = {
  id: 'zoom.downIn',
  label: '작아지며 등장',
  hint: '크게 시작해 꽉 찬 크기로 내려앉는다.',
  category: 'appear',
  tags: ['scale'],
  loopSafe: 'once',
  overscan: 'auto',
  easy: false,
  size: 'normal',
  defaultDurationMs: 900,
  params: [
    { key: 'amount', label: '시작 크기 차이', type: 'number', min: 5, max: 60, step: 1, unit: '%', default: 25 },
  ],
  emit(ctx): PresetEmission {
    const span = resolveSpan(ctx, 900)
    const end = lastFrame(span, 'once')
    const amount = clamp(num(ctx.params, 'amount', 25) * gainOf(ctx.strength), 2, 80) / 100

    const tracks = [
      track('scale', 'ratio', buildKeys([{ f: 0, v: 1 + amount }, { f: end, v: 1 }], 'easeOutExpo')),
    ]
    return { tracks, durationFrames: emitDuration(span, tracks), suggestedLoop: loopFor('once') }
  },
}

export const APPEAR_PRESETS: MotionPreset[] = [zoomPop, fadeIn, slideInFade, zoomUpIn, zoomDownIn]
