/**
 * C. 계속 움직이기. 10종 전부.
 *
 * 이동 거리 d 에서 필요한 배율은 k = 1 + 2d 다. 하지만 프리셋은 그 배율을 직접 심지 않는다.
 * 오버스캔 솔버가 결합이 끝난 뒤 같은 값을 스스로 유도하기 때문이다.
 * 프리셋이 미리 곱해 두면 다른 모션과 겹쳤을 때 두 번 곱해져 그림만 커진다.
 * UI 에는 "이동 거리"만 노출하고 배율은 끝까지 숨긴다.
 *
 * 무한 반복(loop)에서는 linear 이외의 단방향 이징을 쓰지 않는다. 매 사이클 시작마다
 * 급가속이 반복되어 싸구려로 보인다. 좌우/상하 왕복만 seamless 로 두고
 * 한 방향 이동은 왕복 전용으로 표시한다.
 */

import type { MotionPreset, PresetEmission } from '@/motions/types.ts'
import {
  DIRECTION_OPTIONS,
  buildKeys,
  clamp,
  directionVector,
  emitDuration,
  gainOf,
  lastFrame,
  loopFor,
  num,
  resolveSpan,
  spread,
  str,
  track,
} from './shared.ts'

/** 천천히 확대. 사용자가 명시한 항목이다. 전 구간 k >= 1 이라 솔버가 개입하지 않는다. */
const zoomSlowIn: MotionPreset = {
  id: 'zoom.slowIn',
  label: '천천히 확대',
  hint: '눈치채기 어려울 만큼 천천히 다가간다.',
  category: 'move',
  tags: ['scale'],
  loopSafe: 'pingPongOnly',
  overscan: 'auto',
  easy: true,
  size: 'normal',
  defaultDurationMs: 3000,
  params: [
    { key: 'amount', label: '확대 정도', type: 'number', min: 5, max: 60, step: 1, unit: '%', default: 20 },
  ],
  emit(ctx): PresetEmission {
    const span = resolveSpan(ctx, 3000)
    const end = lastFrame(span, 'pingPongOnly')
    const amount = clamp(num(ctx.params, 'amount', 20) * gainOf(ctx.strength), 2, 80) / 100
    const tracks = [
      track('scale', 'ratio', buildKeys([{ f: 0, v: 1 }, { f: end, v: 1 + amount }], 'easeInOutCubic')),
    ]
    return { tracks, durationFrames: emitDuration(span, tracks), suggestedLoop: loopFor('pingPongOnly') }
  },
}

/** 천천히 축소. 사용자가 명시한 항목이다. 확대의 시간 역순이라 화질 조건이 같다. */
const zoomSlowOut: MotionPreset = {
  id: 'zoom.slowOut',
  label: '천천히 축소',
  hint: '천천히 물러나며 전체를 보여준다.',
  category: 'move',
  tags: ['scale'],
  loopSafe: 'pingPongOnly',
  overscan: 'auto',
  easy: true,
  size: 'normal',
  defaultDurationMs: 3000,
  params: [
    { key: 'amount', label: '시작 확대 정도', type: 'number', min: 5, max: 60, step: 1, unit: '%', default: 20 },
  ],
  emit(ctx): PresetEmission {
    const span = resolveSpan(ctx, 3000)
    const end = lastFrame(span, 'pingPongOnly')
    const amount = clamp(num(ctx.params, 'amount', 20) * gainOf(ctx.strength), 2, 80) / 100
    const tracks = [
      track('scale', 'ratio', buildKeys([{ f: 0, v: 1 + amount }, { f: end, v: 1 }], 'easeInOutCubic')),
    ]
    return { tracks, durationFrames: emitDuration(span, tracks), suggestedLoop: loopFor('pingPongOnly') }
  },
}

/**
 * 좌우로 이동 / 상하로 이동. 사용자가 명시한 항목이다.
 * 한쪽 끝에서 시작해 반대 끝을 찍고 돌아오므로 첫 키와 끝 키의 값이 같다.
 * 양 끝에서 속도가 0 이라 값도 속도도 이어져 이음새가 보이지 않는다.
 */
function panPreset(
  id: string,
  label: string,
  hint: string,
  axis: 'x' | 'y',
  easy: boolean,
): MotionPreset {
  return {
    id,
    label,
    hint,
    category: 'move',
    tags: ['move'],
    loopSafe: 'seamless',
    overscan: 'required',
    easy,
    size: 'normal',
    defaultDurationMs: 2400,
    params: [
      { key: 'distance', label: '이동 거리', type: 'number', min: 1, max: 20, step: 1, unit: '%', default: 6 },
      { key: 'cycles', label: '왕복 횟수', type: 'number', min: 1, max: 4, step: 1, unit: '회', default: 1 },
    ],
    emit(ctx): PresetEmission {
      const span = resolveSpan(ctx, 2400)
      const end = lastFrame(span, 'seamless')
      const amp = clamp(num(ctx.params, 'distance', 6) * gainOf(ctx.strength), 0.5, 25)
      const cycles = clamp(Math.round(num(ctx.params, 'cycles', 1)), 1, 4)

      // 한 왕복 = 세그먼트 2개. 시작과 끝이 같은 쪽 끝점이라 값이 저절로 닫힌다.
      const frames = spread(end, cycles * 2)
      const points = frames.map((f, i) => ({ f, v: i % 2 === 0 ? -amp : amp }))

      const tracks = [
        track(axis === 'x' ? 'translateX' : 'translateY', 'percentOfCanvas', buildKeys(points, 'easeInOutQuart')),
      ]
      return { tracks, durationFrames: emitDuration(span, tracks), suggestedLoop: loopFor('seamless') }
    },
  }
}

const slidePanLR = panPreset('slide.panLR', '좌우로 이동', '왼쪽과 오른쪽을 천천히 오간다.', 'x', true)
const slidePanUD = panPreset('slide.panUD', '상하로 이동', '위아래를 천천히 오간다.', 'y', true)

/**
 * 한 방향 이동 4종. 사용자가 명시한 항목이다.
 * 끝 값이 시작으로 돌아오지 않으므로 왕복 재생에만 어울린다.
 */
function slidePreset(id: string, label: string, hint: string, direction: string): MotionPreset {
  return {
    id,
    label,
    hint,
    category: 'move',
    tags: ['move'],
    loopSafe: 'pingPongOnly',
    overscan: 'required',
    easy: false,
    size: 'light',
    defaultDurationMs: 800,
    params: [
      { key: 'distance', label: '이동 거리', type: 'number', min: 1, max: 25, step: 1, unit: '%', default: 8 },
    ],
    emit(ctx): PresetEmission {
      const span = resolveSpan(ctx, 800)
      const end = lastFrame(span, 'pingPongOnly')
      const dir = directionVector(direction)
      const distance = clamp(num(ctx.params, 'distance', 8) * gainOf(ctx.strength), 0.5, 30) * dir.sign

      const tracks = [
        track(dir.prop, 'percentOfCanvas', buildKeys([{ f: 0, v: 0 }, { f: end, v: distance }], 'easeOutExpo')),
      ]
      return { tracks, durationFrames: emitDuration(span, tracks), suggestedLoop: loopFor('pingPongOnly') }
    },
  }
}

const slideLeft = slidePreset('slide.left', '왼쪽으로 이동', '왼쪽으로 미끄러진다.', 'left')
const slideRight = slidePreset('slide.right', '오른쪽으로 이동', '오른쪽으로 미끄러진다.', 'right')
const slideUp = slidePreset('slide.up', '위로 이동', '위로 미끄러진다.', 'up')
const slideDown = slidePreset('slide.down', '아래로 이동', '아래로 미끄러진다.', 'down')

/** 대각선 흐름. 등속으로 흐르다 끝에서만 감속한다. */
const slideDiagonal: MotionPreset = {
  id: 'slide.diagonal',
  label: '대각선 흐름',
  hint: '비스듬히 흘러가다 끝에서 툭 멈춘다.',
  category: 'move',
  tags: ['move'],
  loopSafe: 'pingPongOnly',
  overscan: 'required',
  easy: false,
  size: 'normal',
  defaultDurationMs: 2000,
  params: [
    { key: 'dx', label: '좌우 거리', type: 'number', min: 0, max: 20, step: 1, unit: '%', default: 6 },
    { key: 'dy', label: '상하 거리', type: 'number', min: 0, max: 20, step: 1, unit: '%', default: 4 },
  ],
  emit(ctx): PresetEmission {
    const span = resolveSpan(ctx, 2000)
    const end = lastFrame(span, 'pingPongOnly')
    const gain = gainOf(ctx.strength)
    const dx = clamp(num(ctx.params, 'dx', 6) * gain, 0, 25)
    const dy = clamp(num(ctx.params, 'dy', 4) * gain, 0, 25)

    const tracks = [
      track('translateX', 'percentOfCanvas', buildKeys([{ f: 0, v: -dx }, { f: end, v: dx }], 'easeOutCirc')),
      track('translateY', 'percentOfCanvas', buildKeys([{ f: 0, v: -dy }, { f: end, v: dy }], 'easeOutCirc')),
    ]
    return { tracks, durationFrames: emitDuration(span, tracks), suggestedLoop: loopFor('pingPongOnly') }
  },
}

/** 관성 드리프트. 등속이라 왕복으로 이어붙여도 속도가 튀지 않는다. */
const slideDrift: MotionPreset = {
  id: 'slide.drift',
  label: '관성 드리프트',
  hint: '멈추지 않고 한쪽으로 계속 흘러간다.',
  category: 'move',
  tags: ['move'],
  loopSafe: 'pingPongOnly',
  overscan: 'required',
  easy: false,
  size: 'normal',
  defaultDurationMs: 4000,
  params: [
    { key: 'direction', label: '방향', type: 'select', options: DIRECTION_OPTIONS, default: 'right' },
    { key: 'distance', label: '이동 거리', type: 'number', min: 2, max: 30, step: 1, unit: '%', default: 14 },
  ],
  emit(ctx): PresetEmission {
    const span = resolveSpan(ctx, 4000)
    const end = lastFrame(span, 'pingPongOnly')
    const dir = directionVector(str(ctx.params, 'direction', 'right'))
    const distance = clamp(num(ctx.params, 'distance', 14) * gainOf(ctx.strength), 1, 35)

    // 시작과 끝을 반씩 나눠 가운데를 기준으로 흐르게 한다. 필요한 배율이 절반으로 준다.
    const half = distance / 2
    const tracks = [
      track(
        dir.prop,
        'percentOfCanvas',
        buildKeys([{ f: 0, v: -half * dir.sign }, { f: end, v: half * dir.sign }], 'linear'),
      ),
    ]
    return { tracks, durationFrames: emitDuration(span, tracks), suggestedLoop: loopFor('pingPongOnly') }
  },
}

export const MOVE_PRESETS: MotionPreset[] = [
  zoomSlowIn,
  zoomSlowOut,
  slidePanLR,
  slidePanUD,
  slideLeft,
  slideRight,
  slideUp,
  slideDown,
  slideDiagonal,
  slideDrift,
]
