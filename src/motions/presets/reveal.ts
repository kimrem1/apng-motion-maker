/**
 * 걷어내기와 입체 뒤집기.
 *
 * 두 가지 새 축을 쓴다. 지금까지의 프리셋은 전부 "그림 전체를 옮기고 키우고 흐리게"
 * 였는데, 모션그래픽에서 가장 흔한 두 가지는 그게 아니다.
 *
 *   1. **가리기.** 그림은 제자리에 가만히 있고 경계선만 지나간다. 양문이 열리고,
 *      블라인드가 젖혀지고, 시계바늘이 한 바퀴 도는 것이 전부 이것이다.
 *      진행률은 `reveal` 트랙이 밀고, 어느 모양으로 지나갈지는 emit 이 내는
 *      `reveal` 필드가 정한다 (core/types.ts RevealSpec).
 *   2. **입체 뒤집기.** 카드가 돌아가고 종이가 펼쳐진다. rotateX / rotateY 트랙과
 *      원근 거리로 만든다 (core/transform.ts mat3Perspective).
 *
 * 카테고리를 새로 만들지 않았다. 사용자가 찾는 자리는 "가리기" 가 아니라 "등장" 이다.
 *
 * ---------------------------------------------------------------------------
 * 입체 프리셋의 오버스캔 정책이 allowEmpty 인 이유
 * ---------------------------------------------------------------------------
 * 카드를 90도 가까이 돌리면 화면에 닿는 폭이 cos 만큼 줄어들어 캔버스가 빈다.
 * **그것이 이 모션의 정의다.** 그런데 required 로 두면 채우기 솔버가 그 빈 곳을
 * 메우려고 배율을 올리는데, cos(82도) = 0.14 이라 원본을 일곱 배로 확대한다.
 * 한 바퀴 도는 프리셋은 90도를 지나며 스무 배까지 간다. "카드를 뒤집었더니 그림이
 * 통째로 뭉개졌다" 가 그 결과다. 솔버가 비켜서는 편이 언제나 낫다.
 *
 * 세기(strength)는 언제나 **움직임의 크기**에만 작용한다. 가리기 계열에서는 경계선의
 * 부드러움과 겹쳐 흐르는 투명도가, 뒤집기 계열에서는 회전 각도가 그 자리다.
 * 진행률 자체를 세기로 줄이면 "세기를 낮췄더니 그림이 절반만 드러난 채로 끝난다" 가 된다.
 */

import { createRevealSpec } from '@/core/reveal.ts'
import type { RevealMode } from '@/core/types.ts'
import type { MotionPreset, PresetEmission } from '@/motions/types.ts'
import {
  bool,
  buildKeys,
  clamp,
  emitDuration,
  gainOf,
  lastFrame,
  loopFor,
  num,
  resolveSpan,
  str,
  track,
} from './shared.ts'

// ---------------------------------------------------------------------------
// 공통
// ---------------------------------------------------------------------------

/** 걷어내는 방향. directionVector 와 값 이름을 맞춰 두면 사용자가 두 번 배우지 않는다. */
const WIPE_OPTIONS = [
  { value: 'left', label: '왼쪽에서' },
  { value: 'right', label: '오른쪽에서' },
  { value: 'up', label: '위에서' },
  { value: 'down', label: '아래에서' },
]

const SPLIT_OPTIONS = [
  { value: 'splitX', label: '좌우로' },
  { value: 'splitY', label: '위아래로' },
]

/** 문자열 파라미터를 가리기 모양으로. 모르는 값이면 폴백을 쓴다. */
function wipeMode(raw: string, fallback: RevealMode): RevealMode {
  switch (raw) {
    case 'left':
      return 'left'
    case 'right':
      return 'right'
    case 'up':
      return 'up'
    case 'down':
      return 'down'
    case 'splitX':
      return 'splitX'
    case 'splitY':
      return 'splitY'
    default:
      return fallback
  }
}

/**
 * 세기가 정하는 경계선의 부드러움.
 *
 * 세기를 올릴수록 **날카로워진다.** 부드러운 경계는 "천천히 스며드는" 느낌이라
 * 약한 쪽에 어울리고, 세게 밀었을 때 칼로 그은 듯 끊기는 편이 시원하다.
 */
function edgeSoftness(strength: number, base: number): number {
  return clamp(base * (1.6 - gainOf(strength) * 0.55), 0.01, 1)
}

/**
 * 가리기 프리셋의 트랙 한 벌.
 *
 * ---------------------------------------------------------------------------
 * 세기는 왜 배율에 걸리나
 * ---------------------------------------------------------------------------
 * 진행률은 언제나 0 에서 1 까지 간다. 세기로 진행률을 줄이면 "세기를 낮췄더니
 * 그림이 절반만 드러난 채로 끝난다" 가 된다. 그래서 세기는 **함께 안착하는 배율**에
 * 건다. 경계선이 지나가는 동안 그림이 아주 살짝 큰 상태에서 제자리 크기로
 * 내려앉는다. 실제 모션그래픽에서도 걷어내기 단독보다 이쪽이 훨씬 흔하다.
 *
 * 배율은 언제나 1 이상이다. 1 아래로 내려가면 채우기 레이어에서 가장자리가 비어
 * 오버스캔 솔버가 개입해야 하고, 그러면 걷어내기가 그림 크기를 바꾸는 모션이 된다.
 */
function revealTracks(end: number, strength: number, fade: boolean, out: boolean) {
  const from = out ? 1 : 0
  const to = out ? 0 : 1
  const settle = clamp(0.05 * gainOf(strength), 0.005, 0.2)

  // 진행률은 등속이 정답이다. 가속을 넣으면 경계선이 화면 가운데서 멈칫한다.
  const tracks = [
    track('reveal', 'ratio', buildKeys([{ f: 0, v: from }, { f: end, v: to }], 'linear')),
    track(
      'scale',
      'ratio',
      buildKeys(
        out
          ? [{ f: 0, v: 1 }, { f: end, v: 1 + settle }]
          : [{ f: 0, v: 1 + settle }, { f: end, v: 1 }],
        'easeOutQuint',
      ),
    ),
  ]
  if (fade) {
    const cut = clamp(Math.round(end * 0.3), 1, end)
    const points = out
      ? [{ f: Math.max(0, end - cut), v: 1 }, { f: end, v: 0 }]
      : [{ f: 0, v: 0 }, { f: cut, v: 1 }]
    tracks.push(track('opacity', 'ratio', buildKeys(points, 'linear')))
  }
  return tracks
}

// ---------------------------------------------------------------------------
// A. 등장
// ---------------------------------------------------------------------------

const wipeIn: MotionPreset = {
  id: 'reveal.wipeIn',
  label: '걷어내며 등장',
  hint: '한쪽 끝에서 경계선이 지나가며 드러난다. 그림은 움직이지 않는다.',
  category: 'appear',
  tags: ['reveal'],
  loopSafe: 'once',
  overscan: 'auto',
  easy: true,
  size: 'light',
  defaultDurationMs: 700,
  params: [
    { key: 'direction', label: '지나가는 방향', type: 'select', options: WIPE_OPTIONS, default: 'left' },
    { key: 'edge', label: '경계 흐림', type: 'number', min: 0, max: 60, step: 1, unit: '%', default: 8 },
  ],
  emit(ctx): PresetEmission {
    const span = resolveSpan(ctx, 700)
    const end = lastFrame(span, 'once')
    const mode = wipeMode(str(ctx.params, 'direction', 'left'), 'left')
    const softness = edgeSoftness(ctx.strength, num(ctx.params, 'edge', 8) / 100)
    const tracks = revealTracks(end, ctx.strength, false, false)
    return {
      tracks,
      reveal: createRevealSpec(mode, { softness }),
      durationFrames: emitDuration(span, tracks),
      suggestedLoop: loopFor('once'),
    }
  },
}

const doorIn: MotionPreset = {
  id: 'reveal.doorIn',
  label: '양문 열리며 등장',
  hint: '가운데가 갈라지며 양쪽으로 열린다.',
  category: 'appear',
  tags: ['reveal'],
  loopSafe: 'once',
  overscan: 'auto',
  easy: true,
  size: 'light',
  defaultDurationMs: 800,
  params: [
    { key: 'axis', label: '열리는 방향', type: 'select', options: SPLIT_OPTIONS, default: 'splitX' },
    { key: 'edge', label: '경계 흐림', type: 'number', min: 0, max: 60, step: 1, unit: '%', default: 5 },
  ],
  emit(ctx): PresetEmission {
    const span = resolveSpan(ctx, 800)
    const end = lastFrame(span, 'once')
    const mode = wipeMode(str(ctx.params, 'axis', 'splitX'), 'splitX')
    const softness = edgeSoftness(ctx.strength, num(ctx.params, 'edge', 5) / 100)
    const tracks = revealTracks(end, ctx.strength, false, false)
    return {
      tracks,
      reveal: createRevealSpec(mode, { softness }),
      durationFrames: emitDuration(span, tracks),
      suggestedLoop: loopFor('once'),
    }
  },
}

const irisIn: MotionPreset = {
  id: 'reveal.irisIn',
  label: '원이 커지며 등장',
  hint: '가운데에서 동그란 구멍이 자라 화면을 채운다.',
  category: 'appear',
  tags: ['reveal'],
  loopSafe: 'once',
  overscan: 'auto',
  easy: false,
  size: 'light',
  defaultDurationMs: 800,
  params: [
    { key: 'edge', label: '경계 흐림', type: 'number', min: 0, max: 80, step: 1, unit: '%', default: 12 },
    { key: 'fade', label: '함께 또렷해지기', type: 'boolean', default: false },
  ],
  emit(ctx): PresetEmission {
    const span = resolveSpan(ctx, 800)
    const end = lastFrame(span, 'once')
    const softness = edgeSoftness(ctx.strength, num(ctx.params, 'edge', 12) / 100)
    const tracks = revealTracks(end, ctx.strength, bool(ctx.params, 'fade', false), false)
    return {
      tracks,
      reveal: createRevealSpec('iris', { softness }),
      durationFrames: emitDuration(span, tracks),
      suggestedLoop: loopFor('once'),
    }
  },
}

const blindsIn: MotionPreset = {
  id: 'reveal.blindsIn',
  label: '블라인드 젖히며 등장',
  hint: '가로 칸이 한꺼번에 젖혀지며 드러난다.',
  category: 'appear',
  tags: ['reveal'],
  loopSafe: 'once',
  overscan: 'auto',
  easy: false,
  size: 'light',
  defaultDurationMs: 800,
  params: [
    { key: 'slats', label: '칸 수', type: 'number', min: 2, max: 40, step: 1, default: 10 },
    { key: 'edge', label: '경계 흐림', type: 'number', min: 0, max: 60, step: 1, unit: '%', default: 6 },
  ],
  emit(ctx): PresetEmission {
    const span = resolveSpan(ctx, 800)
    const end = lastFrame(span, 'once')
    const slats = Math.round(clamp(num(ctx.params, 'slats', 10), 2, 40))
    const softness = edgeSoftness(ctx.strength, num(ctx.params, 'edge', 6) / 100)
    const tracks = revealTracks(end, ctx.strength, false, false)
    return {
      tracks,
      reveal: createRevealSpec('blinds', { slats, softness }),
      durationFrames: emitDuration(span, tracks),
      suggestedLoop: loopFor('once'),
    }
  },
}

/**
 * 카드 뒤집으며 등장.
 *
 * 뒷면 그림이 따로 없으므로 90도를 지나는 순간 얇은 선이 되었다가 다시 펴진다.
 * 시작 각도를 90도 바로 앞에 두는 이유가 그것이다. 정확히 90도에서 시작하면
 * 첫 프레임이 완전히 비어 "안 나온다" 로 읽힌다.
 */
const cardIn: MotionPreset = {
  id: 'flip3d.cardIn',
  label: '카드 뒤집으며 등장',
  hint: '세로축을 중심으로 돌아 정면으로 선다. 진짜 원근이 걸린다.',
  category: 'appear',
  tags: ['rotate3d'],
  loopSafe: 'once',
  overscan: 'allowEmpty',
  easy: true,
  size: 'normal',
  defaultDurationMs: 800,
  params: [
    { key: 'angle', label: '시작 각도', type: 'number', min: 30, max: 88, step: 1, unit: '도', default: 82 },
    { key: 'depth', label: '원근 세기', type: 'number', min: 1, max: 8, step: 0.5, default: 2.5 },
  ],
  emit(ctx): PresetEmission {
    const span = resolveSpan(ctx, 800)
    const end = lastFrame(span, 'once')
    const angle = clamp(num(ctx.params, 'angle', 82) * gainOf(ctx.strength), 10, 88)
    const fadeEnd = clamp(Math.round(end * 0.4), 1, end)

    const tracks = [
      track('rotateY', 'deg', buildKeys([{ f: 0, v: angle }, { f: end, v: 0 }], 'easeOutQuint')),
      track('opacity', 'ratio', buildKeys([{ f: 0, v: 0 }, { f: fadeEnd, v: 1 }], 'easeOutCirc')),
    ]
    return {
      tracks,
      // 값이 작을수록 원근이 세다. 노브는 반대로 읽히는 편이 자연스러우므로 뒤집는다.
      perspective: clamp(9.5 - num(ctx.params, 'depth', 2.5), 1.5, 8.5),
      durationFrames: emitDuration(span, tracks),
      suggestedLoop: loopFor('once'),
    }
  },
}

/**
 * 종이 펼치며 등장.
 *
 * 가로축으로 눕힌 상태에서 일어선다. 위쪽을 축으로 삼아야 "펼쳐진다" 로 읽히므로
 * 기준점을 옮기는 대신 회전과 세로 이동을 같이 건다. 기준점은 사용자가 인스펙터에서
 * 따로 쓰는 값이라 프리셋이 덮으면 안 된다.
 */
const unfoldIn: MotionPreset = {
  id: 'flip3d.unfoldIn',
  label: '종이 펼치며 등장',
  hint: '뒤로 누운 채 시작해 앞으로 일어선다.',
  category: 'appear',
  tags: ['rotate3d'],
  loopSafe: 'once',
  overscan: 'allowEmpty',
  easy: false,
  size: 'normal',
  defaultDurationMs: 900,
  params: [
    { key: 'angle', label: '눕는 각도', type: 'number', min: 20, max: 85, step: 1, unit: '도', default: 70 },
    { key: 'lift', label: '들리는 거리', type: 'number', min: 0, max: 20, step: 1, unit: '%', default: 6 },
  ],
  emit(ctx): PresetEmission {
    const span = resolveSpan(ctx, 900)
    const end = lastFrame(span, 'once')
    const gain = gainOf(ctx.strength)
    const angle = clamp(num(ctx.params, 'angle', 70) * gain, 10, 85)
    const lift = clamp(num(ctx.params, 'lift', 6) * gain, 0, 30)
    const fadeEnd = clamp(Math.round(end * 0.45), 1, end)

    const tracks = [
      track('rotateX', 'deg', buildKeys([{ f: 0, v: -angle }, { f: end, v: 0 }], 'easeOutQuint')),
      track(
        'translateY',
        'percentOfCanvas',
        buildKeys([{ f: 0, v: lift }, { f: end, v: 0 }], 'easeOutQuint'),
      ),
      track('opacity', 'ratio', buildKeys([{ f: 0, v: 0 }, { f: fadeEnd, v: 1 }], 'easeOutCirc')),
    ]
    return {
      tracks,
      perspective: 2.2,
      durationFrames: emitDuration(span, tracks),
      suggestedLoop: loopFor('once'),
    }
  },
}

// ---------------------------------------------------------------------------
// B. 사라짐
// ---------------------------------------------------------------------------

const wipeOut: MotionPreset = {
  id: 'reveal.wipeOut',
  label: '걷어내며 사라짐',
  hint: '경계선이 지나가며 지워진다.',
  category: 'disappear',
  tags: ['reveal'],
  loopSafe: 'once',
  overscan: 'auto',
  easy: true,
  size: 'light',
  defaultDurationMs: 700,
  params: [
    { key: 'direction', label: '지나가는 방향', type: 'select', options: WIPE_OPTIONS, default: 'right' },
    { key: 'edge', label: '경계 흐림', type: 'number', min: 0, max: 60, step: 1, unit: '%', default: 8 },
  ],
  emit(ctx): PresetEmission {
    const span = resolveSpan(ctx, 700)
    const end = lastFrame(span, 'once')
    const mode = wipeMode(str(ctx.params, 'direction', 'right'), 'right')
    const softness = edgeSoftness(ctx.strength, num(ctx.params, 'edge', 8) / 100)
    const tracks = revealTracks(end, ctx.strength, false, true)
    return {
      tracks,
      reveal: createRevealSpec(mode, { softness }),
      durationFrames: emitDuration(span, tracks),
      suggestedLoop: loopFor('once'),
    }
  },
}

const doorOut: MotionPreset = {
  id: 'reveal.doorOut',
  label: '양문 닫히며 사라짐',
  hint: '양쪽에서 밀려 들어와 가운데에서 만난다.',
  category: 'disappear',
  tags: ['reveal'],
  loopSafe: 'once',
  overscan: 'auto',
  easy: false,
  size: 'light',
  defaultDurationMs: 800,
  params: [
    { key: 'axis', label: '닫히는 방향', type: 'select', options: SPLIT_OPTIONS, default: 'splitX' },
    { key: 'edge', label: '경계 흐림', type: 'number', min: 0, max: 60, step: 1, unit: '%', default: 5 },
  ],
  emit(ctx): PresetEmission {
    const span = resolveSpan(ctx, 800)
    const end = lastFrame(span, 'once')
    const mode = wipeMode(str(ctx.params, 'axis', 'splitX'), 'splitX')
    const softness = edgeSoftness(ctx.strength, num(ctx.params, 'edge', 5) / 100)
    const tracks = revealTracks(end, ctx.strength, false, true)
    return {
      tracks,
      reveal: createRevealSpec(mode, { softness }),
      durationFrames: emitDuration(span, tracks),
      suggestedLoop: loopFor('once'),
    }
  },
}

const irisOut: MotionPreset = {
  id: 'reveal.irisOut',
  label: '원이 줄며 사라짐',
  hint: '가장자리부터 조여들어 가운데 점으로 닫힌다.',
  category: 'disappear',
  tags: ['reveal'],
  loopSafe: 'once',
  overscan: 'auto',
  easy: false,
  size: 'light',
  defaultDurationMs: 800,
  params: [
    { key: 'edge', label: '경계 흐림', type: 'number', min: 0, max: 80, step: 1, unit: '%', default: 12 },
    { key: 'fade', label: '함께 흐려지기', type: 'boolean', default: false },
  ],
  emit(ctx): PresetEmission {
    const span = resolveSpan(ctx, 800)
    const end = lastFrame(span, 'once')
    const softness = edgeSoftness(ctx.strength, num(ctx.params, 'edge', 12) / 100)
    const tracks = revealTracks(end, ctx.strength, bool(ctx.params, 'fade', false), true)
    return {
      tracks,
      reveal: createRevealSpec('iris', { softness }),
      durationFrames: emitDuration(span, tracks),
      suggestedLoop: loopFor('once'),
    }
  },
}

const blindsOut: MotionPreset = {
  id: 'reveal.blindsOut',
  label: '블라인드 닫히며 사라짐',
  hint: '가로 칸이 한꺼번에 덮이며 지워진다.',
  category: 'disappear',
  tags: ['reveal'],
  loopSafe: 'once',
  overscan: 'auto',
  easy: false,
  size: 'light',
  defaultDurationMs: 800,
  params: [
    { key: 'slats', label: '칸 수', type: 'number', min: 2, max: 40, step: 1, default: 10 },
    { key: 'edge', label: '경계 흐림', type: 'number', min: 0, max: 60, step: 1, unit: '%', default: 6 },
  ],
  emit(ctx): PresetEmission {
    const span = resolveSpan(ctx, 800)
    const end = lastFrame(span, 'once')
    const slats = Math.round(clamp(num(ctx.params, 'slats', 10), 2, 40))
    const softness = edgeSoftness(ctx.strength, num(ctx.params, 'edge', 6) / 100)
    const tracks = revealTracks(end, ctx.strength, false, true)
    return {
      tracks,
      reveal: createRevealSpec('blinds', { slats, softness }),
      durationFrames: emitDuration(span, tracks),
      suggestedLoop: loopFor('once'),
    }
  },
}

const cardOut: MotionPreset = {
  id: 'flip3d.cardOut',
  label: '카드 뒤집으며 사라짐',
  hint: '세로축을 중심으로 돌아 옆으로 눕는다.',
  category: 'disappear',
  tags: ['rotate3d'],
  loopSafe: 'once',
  overscan: 'allowEmpty',
  easy: true,
  size: 'normal',
  defaultDurationMs: 700,
  params: [
    { key: 'angle', label: '끝 각도', type: 'number', min: 30, max: 88, step: 1, unit: '도', default: 82 },
    { key: 'depth', label: '원근 세기', type: 'number', min: 1, max: 8, step: 0.5, default: 2.5 },
  ],
  emit(ctx): PresetEmission {
    const span = resolveSpan(ctx, 700)
    const end = lastFrame(span, 'once')
    const angle = clamp(num(ctx.params, 'angle', 82) * gainOf(ctx.strength), 10, 88)
    const fadeStart = clamp(Math.round(end * 0.5), 0, Math.max(0, end - 1))

    const tracks = [
      track('rotateY', 'deg', buildKeys([{ f: 0, v: 0 }, { f: end, v: -angle }], 'easeInExpo')),
      track('opacity', 'ratio', buildKeys([{ f: fadeStart, v: 1 }, { f: end, v: 0 }], 'easeInExpo')),
    ]
    return {
      tracks,
      perspective: clamp(9.5 - num(ctx.params, 'depth', 2.5), 1.5, 8.5),
      durationFrames: emitDuration(span, tracks),
      suggestedLoop: loopFor('once'),
    }
  },
}

// ---------------------------------------------------------------------------
// D. 시선 끌기
// ---------------------------------------------------------------------------

/**
 * 카드 한 바퀴.
 *
 * 360도는 0도와 같으므로 이음새가 닫힌다. 등속이어야 도는 속도가 일정하다.
 * 90도와 270도를 지나는 두 순간에 두께가 0 이 되는데, 그게 카드가 뒤집히는 모양이다.
 */
const cardTurn: MotionPreset = {
  id: 'flip3d.turn',
  label: '카드 한 바퀴',
  hint: '입체로 한 바퀴 돌아 제자리로 온다. 반복해도 이음새가 없다.',
  category: 'attention',
  tags: ['rotate3d'],
  loopSafe: 'seamless',
  overscan: 'allowEmpty',
  easy: true,
  size: 'normal',
  defaultDurationMs: 1600,
  params: [
    {
      key: 'axis',
      label: '도는 축',
      type: 'select',
      options: [
        { value: 'y', label: '세로축' },
        { value: 'x', label: '가로축' },
      ],
      default: 'y',
    },
    { key: 'depth', label: '원근 세기', type: 'number', min: 1, max: 8, step: 0.5, default: 2.5 },
  ],
  emit(ctx): PresetEmission {
    const span = resolveSpan(ctx, 1600)
    const end = lastFrame(span, 'seamless')
    const prop = str(ctx.params, 'axis', 'y') === 'x' ? 'rotateX' : 'rotateY'

    const tracks = [
      track(prop, 'deg', buildKeys([{ f: 0, v: 0 }, { f: end, v: 360 }], 'linear')),
    ]
    return {
      tracks,
      perspective: clamp(9.5 - num(ctx.params, 'depth', 2.5), 1.5, 8.5),
      durationFrames: emitDuration(span, tracks),
      suggestedLoop: loopFor('seamless'),
    }
  },
}

/** 입체로 기울이기. 좌우와 위아래로 살짝 흔들려 종이가 떠 있는 것처럼 보인다. */
const sway3d: MotionPreset = {
  id: 'flip3d.sway',
  label: '입체로 기울이기',
  hint: '좌우와 위아래로 조금씩 기울어 떠 있는 느낌을 낸다.',
  category: 'attention',
  tags: ['rotate3d'],
  loopSafe: 'seamless',
  overscan: 'allowEmpty',
  easy: false,
  size: 'light',
  defaultDurationMs: 2400,
  params: [
    { key: 'angle', label: '기우는 각도', type: 'number', min: 2, max: 40, step: 1, unit: '도', default: 14 },
    { key: 'tiltY', label: '위아래 비율', type: 'number', min: 0, max: 100, step: 5, unit: '%', default: 50 },
  ],
  emit(ctx): PresetEmission {
    const span = resolveSpan(ctx, 2400)
    const end = lastFrame(span, 'seamless')
    const angle = clamp(num(ctx.params, 'angle', 14) * gainOf(ctx.strength), 1, 60)
    const ratio = clamp(num(ctx.params, 'tiltY', 50) / 100, 0, 1)

    const q = (n: number): number => clamp(Math.round((end * n) / 4), 1, end)
    // 가로축은 세로축보다 반 주기 늦게 간다. 두 축이 같은 위상이면 대각선으로만 흔들린다.
    const tracks = [
      track(
        'rotateY',
        'deg',
        buildKeys(
          [
            { f: 0, v: 0 },
            { f: q(1), v: angle },
            { f: q(2), v: 0 },
            { f: q(3), v: -angle },
            { f: end, v: 0 },
          ],
          'easeInOutCubic',
        ),
      ),
      track(
        'rotateX',
        'deg',
        buildKeys(
          [
            { f: 0, v: angle * ratio },
            { f: q(1), v: 0 },
            { f: q(2), v: -angle * ratio },
            { f: q(3), v: 0 },
            { f: end, v: angle * ratio },
          ],
          'easeInOutCubic',
        ),
      ),
    ]
    return {
      tracks,
      perspective: 3,
      durationFrames: emitDuration(span, tracks),
      suggestedLoop: loopFor('seamless'),
    }
  },
}

/**
 * 시계 방향으로 그리기.
 *
 * 테두리만 남긴 도형에 걸면 **선이 그려지는** 모양이 된다. 12시에서 시작해 한 바퀴
 * 돌아 그려지고, 잠깐 머물렀다 같은 방향으로 지워진다. 첫 값과 끝 값이 0 이라
 * 무한 반복에서 이음새가 없다.
 */
const clockDraw: MotionPreset = {
  id: 'reveal.clockDraw',
  label: '시계 방향으로 그리기',
  hint: '열두 시부터 한 바퀴 돌며 그려졌다가 같은 방향으로 지워진다.',
  category: 'attention',
  tags: ['reveal'],
  loopSafe: 'seamless',
  overscan: 'auto',
  easy: true,
  size: 'light',
  defaultDurationMs: 2000,
  params: [
    { key: 'hold', label: '머무는 시간', type: 'number', min: 0, max: 60, step: 5, unit: '%', default: 25 },
    { key: 'angle', label: '시작 각도', type: 'number', min: -180, max: 180, step: 15, unit: '도', default: 0 },
  ],
  emit(ctx): PresetEmission {
    const span = resolveSpan(ctx, 2000)
    const end = lastFrame(span, 'seamless')
    const hold = clamp(num(ctx.params, 'hold', 25) / 100, 0, 0.6)
    // 그리기 : 머무르기 : 지우기 = (1-hold)/2 : hold : (1-hold)/2
    const drawEnd = clamp(Math.round((end * (1 - hold)) / 2), 1, end - 2)
    const holdEnd = clamp(Math.round(end * ((1 - hold) / 2 + hold)), drawEnd + 1, end - 1)

    // 그려지는 동안 아주 조금 커졌다가 지워지며 돌아온다. 세기가 이 폭을 정한다.
    const breath = clamp(0.04 * gainOf(ctx.strength), 0.004, 0.16)
    const tracks = [
      track(
        'reveal',
        'ratio',
        buildKeys(
          [
            { f: 0, v: 0 },
            { f: drawEnd, v: 1 },
            { f: holdEnd, v: 1 },
            { f: end, v: 0 },
          ],
          'linear',
        ),
      ),
      track(
        'scale',
        'ratio',
        buildKeys(
          [
            { f: 0, v: 1 },
            { f: drawEnd, v: 1 + breath },
            { f: holdEnd, v: 1 + breath },
            { f: end, v: 1 },
          ],
          'easeInOutCubic',
        ),
      ),
    ]
    return {
      tracks,
      reveal: createRevealSpec('clock', {
        softness: edgeSoftness(ctx.strength, 0.04),
        angle: num(ctx.params, 'angle', 0),
      }),
      durationFrames: emitDuration(span, tracks),
      suggestedLoop: loopFor('seamless'),
    }
  },
}

/** 블라인드 여닫기. 가로 칸이 한 번 젖혀졌다 돌아온다. */
const blindsBlink: MotionPreset = {
  id: 'reveal.blindsBlink',
  label: '블라인드 여닫기',
  hint: '가로 칸이 젖혀졌다가 다시 덮인다.',
  category: 'attention',
  tags: ['reveal'],
  loopSafe: 'seamless',
  overscan: 'auto',
  easy: false,
  size: 'light',
  defaultDurationMs: 1800,
  params: [
    { key: 'slats', label: '칸 수', type: 'number', min: 2, max: 40, step: 1, default: 12 },
    { key: 'hold', label: '열려 있는 시간', type: 'number', min: 10, max: 70, step: 5, unit: '%', default: 40 },
  ],
  emit(ctx): PresetEmission {
    const span = resolveSpan(ctx, 1800)
    const end = lastFrame(span, 'seamless')
    const slats = Math.round(clamp(num(ctx.params, 'slats', 12), 2, 40))
    const hold = clamp(num(ctx.params, 'hold', 40) / 100, 0.1, 0.7)
    const openAt = clamp(Math.round((end * (1 - hold)) / 2), 1, end - 2)
    const closeAt = clamp(Math.round(end * ((1 - hold) / 2 + hold)), openAt + 1, end - 1)

    const breath = clamp(0.04 * gainOf(ctx.strength), 0.004, 0.16)
    const tracks = [
      track(
        'reveal',
        'ratio',
        buildKeys(
          [
            { f: 0, v: 0 },
            { f: openAt, v: 1 },
            { f: closeAt, v: 1 },
            { f: end, v: 0 },
          ],
          'easeInOutCubic',
        ),
      ),
      track(
        'scale',
        'ratio',
        buildKeys(
          [
            { f: 0, v: 1 },
            { f: openAt, v: 1 + breath },
            { f: closeAt, v: 1 + breath },
            { f: end, v: 1 },
          ],
          'easeInOutCubic',
        ),
      ),
    ]
    return {
      tracks,
      reveal: createRevealSpec('blinds', { slats, softness: edgeSoftness(ctx.strength, 0.05) }),
      durationFrames: emitDuration(span, tracks),
      suggestedLoop: loopFor('seamless'),
    }
  },
}

/**
 * 잉크 번지며 등장.
 *
 * 원이 커지는 것(irisIn)과 뼈대가 같고 경계만 들쭉날쭉하다. 그래서 별도 트랙 규칙이
 * 필요 없다. 얼룩 잘기는 `slats` 자리에 실린다 (core/reveal.ts REVEAL_SLATS_LABELS).
 *
 * 경계 흐림 기본값이 다른 걷어내기보다 크다. 잉크는 종이에 스며드는 것이라 칼로
 * 그은 경계가 나오면 얼룩이 아니라 조각난 도형으로 보인다.
 */
const inkIn: MotionPreset = {
  id: 'reveal.inkIn',
  label: '잉크 번지며 등장',
  hint: '가운데에서 얼룩이 번지듯 불규칙하게 드러난다.',
  category: 'appear',
  tags: ['reveal'],
  loopSafe: 'once',
  overscan: 'auto',
  easy: true,
  size: 'light',
  defaultDurationMs: 900,
  params: [
    { key: 'grain', label: '얼룩 잘기', type: 'number', min: 2, max: 40, step: 1, default: 12 },
    { key: 'edge', label: '경계 흐림', type: 'number', min: 0, max: 80, step: 1, unit: '%', default: 22 },
    { key: 'fade', label: '함께 또렷해지기', type: 'boolean', default: false },
  ],
  emit(ctx): PresetEmission {
    const span = resolveSpan(ctx, 900)
    const end = lastFrame(span, 'once')
    const slats = Math.round(clamp(num(ctx.params, 'grain', 12), 2, 40))
    const softness = edgeSoftness(ctx.strength, num(ctx.params, 'edge', 22) / 100)
    const tracks = revealTracks(end, ctx.strength, bool(ctx.params, 'fade', false), false)
    return {
      tracks,
      reveal: createRevealSpec('ink', { slats, softness }),
      durationFrames: emitDuration(span, tracks),
      suggestedLoop: loopFor('once'),
    }
  },
}

/**
 * 부채 펼치며 등장.
 *
 * 아래 변의 가운데를 축으로 왼쪽에서 오른쪽으로 열린다. 부채, 아치, 무지개처럼
 * **손잡이가 아래에 있는** 그림이 이 모양이다 (core/reveal.ts 의 fan 주석).
 *
 * 함께 걸리는 배율의 기준점을 아래 가운데로 옮긴다. 한복판을 기준으로 커지면
 * 펼쳐지는 동안 손잡이가 위아래로 흔들려서, 부채를 쥔 손이 떨리는 것처럼 보인다.
 */
const fanIn: MotionPreset = {
  id: 'reveal.fanIn',
  label: '부채 펼치며 등장',
  hint: '아래 가운데를 축으로 한쪽에서 반대쪽으로 펼쳐진다. 부채와 아치에 어울린다.',
  category: 'appear',
  tags: ['reveal'],
  loopSafe: 'once',
  overscan: 'auto',
  easy: true,
  size: 'light',
  defaultDurationMs: 850,
  params: [
    { key: 'edge', label: '경계 흐림', type: 'number', min: 0, max: 60, step: 1, unit: '%', default: 4 },
    { key: 'reverse', label: '반대쪽부터', type: 'boolean', default: false },
  ],
  emit(ctx): PresetEmission {
    const span = resolveSpan(ctx, 850)
    const end = lastFrame(span, 'once')
    const softness = edgeSoftness(ctx.strength, num(ctx.params, 'edge', 4) / 100)
    const tracks = revealTracks(end, ctx.strength, false, false)
    return {
      tracks,
      reveal: createRevealSpec('fan', {
        softness,
        invert: bool(ctx.params, 'reverse', false),
      }),
      anchor: [0.5, 1],
      durationFrames: emitDuration(span, tracks),
      suggestedLoop: loopFor('once'),
    }
  },
}

/** 경첩이 달린 변. 값 이름은 "어디가 고정되는가" 다. */
const HINGE_OPTIONS = [
  { value: 'top', label: '위쪽' },
  { value: 'bottom', label: '아래쪽' },
  { value: 'left', label: '왼쪽' },
  { value: 'right', label: '오른쪽' },
]

/**
 * 경첩이 달린 변에서 기준점과 회전축을 뽑는다.
 *
 * rotateX 는 **가로축**을 중심으로 돌므로 위아래 경첩이 쓰고, rotateY 는 세로축이라
 * 좌우 경첩이 쓴다. 부호는 "열리는 쪽이 앞으로 나온다" 로 맞춘다.
 */
function hingeOf(raw: string): {
  anchor: [number, number]
  prop: 'rotateX' | 'rotateY'
  sign: number
} {
  switch (raw) {
    case 'bottom':
      return { anchor: [0.5, 1], prop: 'rotateX', sign: -1 }
    case 'left':
      return { anchor: [0, 0.5], prop: 'rotateY', sign: -1 }
    case 'right':
      return { anchor: [1, 0.5], prop: 'rotateY', sign: 1 }
    case 'top':
    default:
      return { anchor: [0.5, 0], prop: 'rotateX', sign: 1 }
  }
}

/**
 * 경첩 열기.
 *
 * ---------------------------------------------------------------------------
 * '종이 펼치며 등장' 과 무엇이 다른가
 * ---------------------------------------------------------------------------
 * 저쪽은 **한복판**을 축으로 눕혔다 세우고, 어긋나는 자리를 세로 이동으로 어림해
 * 메운다. 이쪽은 기준점을 경첩이 달린 변으로 옮겨 **그 변이 한 픽셀도 움직이지
 * 않는다.** 봉투 뚜껑, 여닫이문, 병풍처럼 경첩이 눈에 보이는 그림에서는 이 차이가
 * 곧바로 드러난다. 원근이 걸리면 이동으로는 메울 수 없다. 각 점의 w 가 달라서
 * 원근 나눗셈 뒤에 어긋난 자리를 평행이동 하나로 되돌릴 수 없기 때문이다.
 *
 * 기준점을 프리셋이 옮긴다. 걷어낼 때 한가운데로 되돌아가는 규칙은
 * motions/merge.ts 의 mergePresetAnchor 가 정한다.
 */
const hingeIn: MotionPreset = {
  id: 'flip3d.hingeIn',
  label: '경첩 열리며 등장',
  hint: '한쪽 변이 고정된 채 문처럼 젖혀져 열린다. 봉투 뚜껑과 여닫이문이 이 모양이다.',
  category: 'appear',
  tags: ['rotate3d'],
  loopSafe: 'once',
  overscan: 'allowEmpty',
  easy: true,
  size: 'normal',
  defaultDurationMs: 900,
  params: [
    { key: 'hinge', label: '고정되는 변', type: 'select', options: HINGE_OPTIONS, default: 'top' },
    { key: 'angle', label: '젖혀지는 각도', type: 'number', min: 30, max: 120, step: 5, unit: '도', default: 100 },
    { key: 'depth', label: '원근 세기', type: 'number', min: 1, max: 8, step: 0.5, default: 3.5 },
  ],
  emit(ctx): PresetEmission {
    const span = resolveSpan(ctx, 900)
    const end = lastFrame(span, 'once')
    const hinge = hingeOf(str(ctx.params, 'hinge', 'top'))
    /*
     * 90 도를 넘겨 둔다. 정확히 90 도에서 시작하면 첫 프레임이 완전히 사라져
     * "안 나온다" 로 읽히고, 90 도에서 멈추면 문이 반쯤 열린 채 굳는다.
     * 넘긴 만큼 뒷면이 보이는 구간이 생기는데, 문이 젖혀지는 그림에서는 그것이 맞다.
     */
    const angle = clamp(num(ctx.params, 'angle', 100) * gainOf(ctx.strength), 20, 130)
    const fadeEnd = clamp(Math.round(end * 0.35), 1, end)

    const tracks = [
      track(
        hinge.prop,
        'deg',
        buildKeys([{ f: 0, v: hinge.sign * angle }, { f: end, v: 0 }], 'easeOutQuint'),
      ),
      track('opacity', 'ratio', buildKeys([{ f: 0, v: 0 }, { f: fadeEnd, v: 1 }], 'easeOutCirc')),
    ]
    return {
      tracks,
      anchor: hinge.anchor,
      // 값이 작을수록 원근이 세다. 노브는 반대로 읽히는 편이 자연스러우므로 뒤집는다.
      perspective: clamp(9.5 - num(ctx.params, 'depth', 3.5), 1.5, 8.5),
      durationFrames: emitDuration(span, tracks),
      suggestedLoop: loopFor('once'),
    }
  },
}

export const REVEAL_PRESETS: MotionPreset[] = [
  wipeIn,
  doorIn,
  irisIn,
  blindsIn,
  inkIn,
  fanIn,
  cardIn,
  unfoldIn,
  hingeIn,
  wipeOut,
  doorOut,
  irisOut,
  blindsOut,
  cardOut,
  cardTurn,
  sway3d,
  clockDraw,
  blindsBlink,
]
