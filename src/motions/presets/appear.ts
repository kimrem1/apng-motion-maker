/**
 * A. 등장.
 *
 * combo.popGlitchIn 은 블록 깨짐 이펙트가 있어야 성립해서 combo.ts 에 있다. 반대로
 * combo.shineIn 은 여기 있다. 부품을 조합해 만드는 것이 아니라 트랙과 이펙트를 직접
 * 쓰기 때문이다. 두 파일의 경계는 카테고리가 아니라 만드는 방식이다.
 *
 * 등장 프리셋은 loopSafe 'once' 다 (이음새가 닫히지 않는다). 그래도 기본 제안은
 * 반복이다 (shared.ts 의 loopFor 참조). 반복하면 매 사이클 등장이 되풀이되는데,
 * 스티커에서는 그것이 기대 동작이고 '한 번만' 은 반복 라디오에서 고를 수 있다.
 */

import type { MotionPreset, PresetEmission } from '@/motions/types.ts'
import {
  DIRECTION_OPTIONS,
  bool,
  buildKeys,
  clamp,
  directionVector,
  effectSeed,
  emitDuration,
  gainOf,
  lastFrame,
  loopFor,
  makeEffect,
  num,
  paramTrack,
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

/**
 * 광택 내며 등장.
 *
 * 왜 빛줄기를 도형으로 얹지 않는가
 *
 * 도형 한 장을 위에 올리면 실루엣 밖으로 삐져나간다. 부채, 배지, 글자처럼 네모가
 * 아닌 것에서 곧바로 티가 난다. 잘라내려면 클리핑을 걸어야 하고 그러면 레이어가 두
 * 장이 된다. 이펙트는 알파를 손대지 않으므로 그려진 자리에만 광택이 앉는다
 * (effects/atoms/finish.ts 의 fx.shine).
 *
 * 왜 id 가 combo. 로 시작하는가
 *
 * 이 프리셋은 등장 트랙 과 이펙트를 함께 낸다. A~E 카테고리에서 이펙트까지 내는
 * 프리셋은 combo.popGlitchIn 부터 이 이름 규칙을 쓴다. 카테고리는 사용자가 찾는
 * 자리(등장)이고, id 접두사는 "본체가 트랙만이 아니다" 는 표식이다.
 *
 * 띠의 위치는 레이어 트랙으로 만들 수 없는 값이라 이펙트 파라미터에 건다.
 * paramTrack 이 그 목적으로 있는 헬퍼다.
 */
const shineIn: MotionPreset = {
  id: 'combo.shineIn',
  label: '광택 내며 등장',
  hint: '떠오르면서 밝은 띠가 사선으로 한 번 훑고 지나간다. 그려진 자리 안에서만 빛난다.',
  category: 'appear',
  tags: ['scale', 'fade', 'fx'],
  loopSafe: 'once',
  // 시작 배율이 1 아래다. 캔버스를 채우는 레이어에서는 솔버가 그 여유를 메워야 한다.
  overscan: 'required',
  easy: true,
  size: 'light',
  defaultDurationMs: 1100,
  params: [
    { key: 'angle', label: '기울기', type: 'number', min: 0, max: 360, step: 5, unit: '도', default: 20 },
    { key: 'width', label: '띠 폭', type: 'number', min: 5, max: 100, step: 5, unit: '%', default: 28 },
    {
      key: 'color',
      label: '빛 색',
      type: 'select',
      options: [
        { value: 'white', label: '흰빛' },
        { value: 'warm', label: '금빛' },
        { value: 'cool', label: '푸른빛' },
      ],
      default: 'white',
    },
  ],
  emit(ctx): PresetEmission {
    const span = resolveSpan(ctx, 1100)
    const end = lastFrame(span, 'once')
    const gain = gainOf(ctx.strength)

    // 등장은 얌전하게 둔다. 눈이 가야 할 곳은 지나가는 빛이다.
    const from = clamp(1 - 0.12 * gain, 0.6, 0.99)
    const fadeEnd = clamp(Math.round(end * 0.35), 1, end)
    /*
     * 광택은 등장이 거의 끝난 뒤에 지나간다. 같이 시작하면 아직 반투명한 그림 위를
     * 훑어서 빛이 보이지 않는다.
     */
    const shineFrom = clamp(Math.round(end * 0.35), 1, Math.max(1, end - 1))

    const tracks = [
      track('scale', 'ratio', buildKeys([{ f: 0, v: from }, { f: end, v: 1 }], 'easeOutBack')),
      track('opacity', 'ratio', buildKeys([{ f: 0, v: 0 }, { f: fadeEnd, v: 1 }], 'easeOutQuad')),
    ]

    const tint = str(ctx.params, 'color', 'white')
    const color = tint === 'warm' ? 0xffe6a8 : tint === 'cool' ? 0xcfe8ff : 0xffffff

    const effects = [
      makeEffect({
        id: 'shineIn',
        type: 'fx.shine',
        seed: effectSeed(ctx, 'combo.shineIn', 'band'),
        params: {
          color,
          angle: clamp(num(ctx.params, 'angle', 20), 0, 360),
          width: clamp(num(ctx.params, 'width', 28), 5, 100) / 100,
          sharp: 2,
          // 세기는 밝기에 건다. 위치를 세기로 줄이면 띠가 화면 밖에서 멈춘다.
          amount: clamp(0.5 + 0.45 * gain, 0.1, 1),
          pos: paramTrack(
            'shinePos',
            buildKeys(
              [{ f: 0, v: 0 }, { f: shineFrom, v: 0 }, { f: end, v: 1 }],
              'easeInOutSine',
            ),
          ),
        },
      }),
    ]

    return {
      tracks,
      effects,
      durationFrames: emitDuration(span, tracks),
      suggestedLoop: loopFor('once'),
    }
  },
}

export const APPEAR_PRESETS: MotionPreset[] = [
  zoomPop,
  fadeIn,
  slideInFade,
  zoomUpIn,
  zoomDownIn,
  shineIn,
]
