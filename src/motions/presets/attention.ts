/**
 * D. 시선 끌기.
 *
 * 사인 파형은 모디파이어가 아니라 키프레임으로 심는다. 오버스캔 솔버가 모디파이어를
 * 이론적 최대 진폭으로만 보수적으로 잡기 때문이다. 사인의 4분점에 키를 놓고 양끝
 * 감속 이징으로 잇는 편이 같은 그림을 내면서 사용자가 곡선을 이어서 손댈 수 있다.
 */

import type { MotionPreset, PresetEmission } from '@/motions/types.ts'
import {
  buildKeys,
  clamp,
  clamp01,
  emitDuration,
  flashNotice,
  gainOf,
  lastFrame,
  limitCycles,
  limitFlashCount,
  loopFor,
  num,
  resolveSpan,
  spread,
  str,
  track,
} from './shared.ts'

/**
 * 두근두근.
 * 기준 배율을 1.02 로 올려 두고 그 위에서만 오르내린다. k 가 1 아래로 내려가지 않아
 * 캔버스를 채워야 하는 레이어에서도 솔버가 개입하지 않는다.
 */
const zoomPulse: MotionPreset = {
  id: 'zoom.pulse',
  label: '두근두근',
  hint: '숨 쉬듯 커졌다 작아지기를 반복한다.',
  category: 'attention',
  tags: ['scale'],
  loopSafe: 'seamless',
  overscan: 'auto',
  easy: true,
  size: 'light',
  defaultDurationMs: 1200,
  params: [
    { key: 'amount', label: '커지는 정도', type: 'number', min: 1, max: 20, step: 1, unit: '%', default: 5 },
    { key: 'cycles', label: '반복 횟수', type: 'number', min: 1, max: 4, step: 1, unit: '회', default: 1 },
  ],
  emit(ctx): PresetEmission {
    const span = resolveSpan(ctx, 1200)
    const end = lastFrame(span, 'seamless')
    const base = 1.02
    const amp = clamp(num(ctx.params, 'amount', 5) * gainOf(ctx.strength), 0.5, 25) / 100
    const cycles = limitCycles(end, num(ctx.params, 'cycles', 1), 2, 2)

    const frames = spread(end, cycles * 2)
    const points = frames.map((f, i) => ({ f, v: i % 2 === 0 ? base : base + amp }))

    const tracks = [track('scale', 'ratio', buildKeys(points, 'easeInOutCubic'))]
    return { tracks, durationFrames: emitDuration(span, tracks), suggestedLoop: loopFor('seamless') }
  },
}

/** 펀치 줌. 크게 튀었다가 살짝 큰 상태로 정착한다. 비트에 맞추는 강조용이다. */
const zoomPunch: MotionPreset = {
  id: 'zoom.punch',
  label: '펀치 줌',
  hint: '한 번 확 커졌다가 조금 큰 상태로 앉는다.',
  category: 'attention',
  tags: ['scale'],
  loopSafe: 'once',
  overscan: 'auto',
  easy: true,
  size: 'light',
  defaultDurationMs: 550,
  params: [
    { key: 'peak', label: '튀는 크기', type: 'number', min: 4, max: 40, step: 1, unit: '%', default: 18 },
    { key: 'settle', label: '남는 크기', type: 'number', min: 0, max: 20, step: 1, unit: '%', default: 4 },
  ],
  emit(ctx): PresetEmission {
    const span = resolveSpan(ctx, 550)
    const end = lastFrame(span, 'once')
    const gain = gainOf(ctx.strength)
    const peak = clamp(num(ctx.params, 'peak', 18) * gain, 2, 50) / 100
    const settle = clamp(num(ctx.params, 'settle', 4) * gain, 0, 25) / 100
    const hit = clamp(Math.round(end * 0.35), 1, Math.max(1, end - 1))

    const tracks = [
      track(
        'scale',
        'ratio',
        buildKeys([{ f: 0, v: 1 }, { f: hit, v: 1 + peak }, { f: end, v: 1 + settle }], 'easeOutQuint'),
      ),
    ]
    return { tracks, durationFrames: emitDuration(span, tracks), suggestedLoop: loopFor('once') }
  },
}

/**
 * 말랑 눌리기.
 * 가로가 늘면 세로가 줄어드는 역위상이 젤리 같은 느낌을 만든다.
 * 한쪽 축이 1 아래로 내려가는 순간이 있어 캔버스를 채우려면 약간의 여유 배율이 필요하다.
 */
const zoomSquash: MotionPreset = {
  id: 'zoom.squash',
  label: '말랑 눌리기',
  hint: '가로세로가 번갈아 늘고 줄어 젤리처럼 보인다.',
  category: 'attention',
  tags: ['scale'],
  loopSafe: 'seamless',
  overscan: 'required',
  easy: false,
  size: 'light',
  defaultDurationMs: 700,
  params: [
    { key: 'amount', label: '눌리는 정도', type: 'number', min: 1, max: 20, step: 1, unit: '%', default: 8 },
    { key: 'cycles', label: '반복 횟수', type: 'number', min: 1, max: 4, step: 1, unit: '회', default: 2 },
  ],
  emit(ctx): PresetEmission {
    const span = resolveSpan(ctx, 700)
    const end = lastFrame(span, 'seamless')
    const amp = clamp(num(ctx.params, 'amount', 8) * gainOf(ctx.strength), 0.5, 25) / 100
    const cycles = limitCycles(end, num(ctx.params, 'cycles', 2), 4, 1)

    // 사인의 4분점: 0, +1, 0, -1 을 한 주기로 반복한다. 마지막 값이 첫 값과 같아 닫힌다.
    const frames = spread(end, cycles * 4)
    const wave = frames.map((_, i) => [0, 1, 0, -1][i % 4]!)

    const tracks = [
      track('scaleX', 'ratio', buildKeys(frames.map((f, i) => ({ f, v: 1 + amp * wave[i]! })), 'easeInOutCubic')),
      track('scaleY', 'ratio', buildKeys(frames.map((f, i) => ({ f, v: 1 - amp * wave[i]! })), 'easeInOutCubic')),
    ]
    return { tracks, durationFrames: emitDuration(span, tracks), suggestedLoop: loopFor('seamless') }
  },
}

/** 기울이기 2종. 사용자가 명시한 회전 항목이다. 회전은 네 모서리를 비우므로 여유 배율이 필수다. */
function tiltPreset(id: string, label: string, hint: string, sign: number): MotionPreset {
  return {
    id,
    label,
    hint,
    category: 'attention',
    tags: ['rotate'],
    loopSafe: 'pingPongOnly',
    overscan: 'required',
    easy: false,
    size: 'light',
    defaultDurationMs: 900,
    params: [
      { key: 'angle', label: '기울기', type: 'number', min: 1, max: 30, step: 1, unit: '도', default: 6 },
    ],
    emit(ctx): PresetEmission {
      const span = resolveSpan(ctx, 900)
      const end = lastFrame(span, 'pingPongOnly')
      const angle = clamp(num(ctx.params, 'angle', 6) * gainOf(ctx.strength), 0.5, 45) * sign

      const tracks = [
        track('rotate', 'deg', buildKeys([{ f: 0, v: 0 }, { f: end, v: angle }], 'easeOutExpo')),
      ]
      return { tracks, durationFrames: emitDuration(span, tracks), suggestedLoop: loopFor('pingPongOnly') }
    },
  }
}

const rotateCw = tiltPreset('rotate.cw', '시계로 기울기', '시계 방향으로 살짝 기운다.', 1)
const rotateCcw = tiltPreset('rotate.ccw', '반시계로 기울기', '반시계 방향으로 살짝 기운다.', -1)

/** 좌우로 갸웃. 양 끝을 오가므로 값도 속도도 이어진다. */
const rotateSway: MotionPreset = {
  id: 'rotate.sway',
  label: '좌우로 갸웃',
  hint: '고개를 갸웃하듯 좌우로 기울기를 반복한다.',
  category: 'attention',
  tags: ['rotate'],
  loopSafe: 'seamless',
  overscan: 'required',
  easy: true,
  size: 'light',
  defaultDurationMs: 2000,
  params: [
    { key: 'angle', label: '기울기', type: 'number', min: 1, max: 20, step: 1, unit: '도', default: 3 },
    { key: 'cycles', label: '왕복 횟수', type: 'number', min: 1, max: 4, step: 1, unit: '회', default: 1 },
  ],
  emit(ctx): PresetEmission {
    const span = resolveSpan(ctx, 2000)
    const end = lastFrame(span, 'seamless')
    const amp = clamp(num(ctx.params, 'angle', 3) * gainOf(ctx.strength), 0.5, 30)
    const cycles = limitCycles(end, num(ctx.params, 'cycles', 1), 2, 2)

    const frames = spread(end, cycles * 2)
    const points = frames.map((f, i) => ({ f, v: i % 2 === 0 ? -amp : amp }))

    const tracks = [track('rotate', 'deg', buildKeys(points, 'easeInOutCubic'))]
    return { tracks, durationFrames: emitDuration(span, tracks), suggestedLoop: loopFor('seamless') }
  },
}

/**
 * 한 바퀴 회전. 사용자가 명시한 회전 항목이다.
 *
 * 이징 잠금. linear 일 때만 C0(360도 = 0도)와 C1(등속)을 동시에 만족하는
 * 유일한 단방향 이음새 없는 프리셋이다. 이징을 걸면 매 바퀴 시작에서 급가속이 보인다.
 * 45도 부근이 최악이라 캔버스 대비 1.42배 여유가 필요하다.
 */
const rotateSpin360: MotionPreset = {
  id: 'rotate.spin360',
  label: '한 바퀴 회전',
  hint: '멈추지 않고 일정한 속도로 한 바퀴 돈다.',
  category: 'attention',
  tags: ['rotate'],
  loopSafe: 'seamless',
  overscan: 'required',
  easy: false,
  size: 'heavy',
  largeSource: true,
  defaultDurationMs: 2400,
  params: [
    {
      key: 'direction',
      label: '회전 방향',
      type: 'select',
      options: [
        { value: 'cw', label: '시계 방향' },
        { value: 'ccw', label: '반시계 방향' },
      ],
      default: 'cw',
    },
    { key: 'turns', label: '바퀴 수', type: 'number', min: 1, max: 4, step: 1, unit: '바퀴', default: 1 },
  ],
  emit(ctx): PresetEmission {
    const span = resolveSpan(ctx, 2400)
    const end = lastFrame(span, 'seamless')
    const sign = str(ctx.params, 'direction', 'cw') === 'ccw' ? -1 : 1
    const turns = clamp(Math.round(num(ctx.params, 'turns', 1)), 1, 4)

    // 이징 잠금. 여기서 linear 를 바꾸면 이음새가 즉시 깨진다.
    const tracks = [
      track('rotate', 'deg', buildKeys([{ f: 0, v: 0 }, { f: end, v: 360 * turns * sign }], 'linear')),
    ]
    return {
      tracks,
      durationFrames: emitDuration(span, tracks),
      suggestedLoop: loopFor('seamless'),
      notices: [
        { code: 'easingLocked', message: '이 움직임은 속도를 일정하게 유지해야 이음새가 보이지 않습니다.' },
        { code: 'largeSourceRecommended', message: '원본이 클수록 회전 중 가장자리가 또렷합니다.' },
      ],
    }
  },
}

/** 비스듬 워블. 기울기가 아니라 비틀림이라 종이 한 장이 흔들리는 느낌을 낸다. */
const skewShear: MotionPreset = {
  id: 'skew.shear',
  label: '비스듬 워블',
  hint: '평행사변형처럼 좌우로 비틀린다.',
  category: 'attention',
  tags: ['skew', 'rotate'],
  loopSafe: 'seamless',
  overscan: 'required',
  easy: false,
  size: 'light',
  defaultDurationMs: 1600,
  params: [
    { key: 'angle', label: '비틀림', type: 'number', min: 1, max: 20, step: 1, unit: '도', default: 4 },
    { key: 'cycles', label: '왕복 횟수', type: 'number', min: 1, max: 4, step: 1, unit: '회', default: 1 },
  ],
  emit(ctx): PresetEmission {
    const span = resolveSpan(ctx, 1600)
    const end = lastFrame(span, 'seamless')
    const amp = clamp(num(ctx.params, 'angle', 4) * gainOf(ctx.strength), 0.5, 30)
    const cycles = limitCycles(end, num(ctx.params, 'cycles', 1), 2, 2)

    const frames = spread(end, cycles * 2)
    const points = frames.map((f, i) => ({ f, v: i % 2 === 0 ? -amp : amp }))

    const tracks = [track('skewX', 'deg', buildKeys(points, 'easeInOutCubic'))]
    return { tracks, durationFrames: emitDuration(span, tracks), suggestedLoop: loopFor('seamless') }
  },
}

/**
 * 깜빡임.
 * 홀드 보간으로 계단을 만든다. 한 계단이 2프레임보다 짧아지면 프레임 격자에서 뭉개지므로
 * 요청 주기가 프레임 예산을 넘으면 자동으로 낮춘다.
 *
 * 이 프리셋은 카탈로그에서 실제로 점멸을 만드는 둘 중 하나다(다른 하나는
 * glitch.burst). 그래서 두 가지를 지지직과 똑같이 적용한다.
 *   1. limitFlashCount 로 초당 3회 미만을 강제한다 (WCAG 2.3.1 일반 섬광 임계값).
 *      프레임 예산 상한(limitCycles)은 "보이는가" 를 보는 것이지 "안전한가" 를
 *      보는 것이 아니다. 25fps 800ms 에서 8회를 요청하면 그대로 통과한다.
 *   2. 상한 안이라도 flashWarning 안내를 낸다. 카드의 점멸 주의 배지가 이것을 읽는다.
 */
const fadeFlicker: MotionPreset = {
  id: 'fade.flicker',
  label: '깜빡임',
  hint: '형광등처럼 툭툭 끊기며 밝기가 바뀐다.',
  category: 'attention',
  tags: ['fade'],
  loopSafe: 'seamless',
  overscan: 'auto',
  easy: false,
  size: 'light',
  flashWarning: true,
  defaultDurationMs: 800,
  params: [
    { key: 'min', label: '어두워지는 정도', type: 'number', min: 0, max: 90, step: 5, unit: '%', default: 70 },
    { key: 'cycles', label: '깜빡임 횟수', type: 'number', min: 1, max: 12, step: 1, unit: '회', default: 8 },
  ],
  emit(ctx): PresetEmission {
    const span = resolveSpan(ctx, 800)
    const end = lastFrame(span, 'seamless')
    const depth = clamp01((num(ctx.params, 'min', 70) / 100) * gainOf(ctx.strength))
    const low = clamp01(1 - depth)
    // 두 상한을 모두 받는다. 프레임 예산(뭉개짐)과 초당 3회(안전)는 다른 축이다.
    const budget = limitCycles(end, num(ctx.params, 'cycles', 8), 2, 2)
    const cycles = limitFlashCount(budget, span, ctx.fps)

    const frames = spread(end, cycles * 2)
    const points = frames.map((f, i) => ({ f, v: i % 2 === 0 ? 1 : low }))

    const tracks = [track('opacity', 'ratio', buildKeys(points, 'hold'))]
    return {
      tracks,
      durationFrames: emitDuration(span, tracks),
      suggestedLoop: loopFor('seamless'),
      notices: [flashNotice()],
    }
  },
}

/** 나타났다 사라졌다. 사용자가 명시한 페이드 항목이다. 양 끝이 모두 0 이라 그대로 반복된다. */
const fadeInOut: MotionPreset = {
  id: 'fade.inOut',
  label: '나타났다 사라졌다',
  hint: '나타나 잠시 머물다 다시 사라지기를 반복한다.',
  category: 'attention',
  tags: ['fade'],
  loopSafe: 'seamless',
  overscan: 'auto',
  easy: false,
  size: 'light',
  defaultDurationMs: 2000,
  params: [
    { key: 'hold', label: '머무는 시간', type: 'number', min: 20, max: 90, step: 5, unit: '%', default: 70 },
  ],
  emit(ctx): PresetEmission {
    const span = resolveSpan(ctx, 2000)
    const end = lastFrame(span, 'seamless')
    const hold = clamp(num(ctx.params, 'hold', 70), 10, 90) / 100
    const edge = (1 - hold) / 2

    const inF = clamp(Math.round(end * edge), 1, Math.max(1, end - 2))
    const outF = clamp(Math.round(end * (1 - edge)), inF + 1, Math.max(inF + 1, end - 1))

    const tracks = [
      track(
        'opacity',
        'ratio',
        buildKeys([{ f: 0, v: 0 }, { f: inF, v: 1 }, { f: outF, v: 1 }, { f: end, v: 0 }], 'easeInOutCubic'),
      ),
    ]
    return { tracks, durationFrames: emitDuration(span, tracks), suggestedLoop: loopFor('seamless') }
  },
}

export const ATTENTION_PRESETS: MotionPreset[] = [
  zoomPulse,
  zoomPunch,
  zoomSquash,
  rotateCw,
  rotateCcw,
  rotateSway,
  rotateSpin360,
  skewShear,
  fadeFlicker,
  fadeInOut,
]
