/**
 * H. 지지직.
 *
 * 용량 통제가 이 카테고리의 설계 제약이다
 *
 * 지지직은 매 프레임 노이즈가 달라진다. APNG 도 GIF 도 앞 프레임과의 차이만 저장하는데,
 * 화면 전체가 매번 바뀌면 델타 압축 효율이 0 에 수렴한다. 4초짜리 글리치 하나가
 * 같은 길이의 페이드보다 열 배 무거워지는 이유가 이것이다.
 *
 * 그래서 세 가지를 프리셋 정의에 못박는다.
 *   1. 노이즈 홀드 프레임 기본 2  -> 바뀌는 프레임이 절반으로 준다
 *   2. 권장 fps 기본 20          -> 같은 초당 프레임이 5장 줄어든다
 *   3. 짧은 기본 지속시간         -> 표의 400~1600ms 를 그대로 쓴다
 * 셋을 곱하면 25fps 무홀드 대비 대략 3분의 1 이다.
 *
 * 본체는 이펙트다
 *
 * 지지직은 본질적으로 픽셀 처리다. RGB 분리도 블록 깨짐도 스캔라인도 트랜스폼으로는
 * 흉내조차 안 된다. 그래서 이 카테고리는 PresetEmission.effects 가 본체이고,
 * 프레임 전체가 함께 움직이는 성분(화면 밀림, 폭발 충격, 테이프 흔들림)만 Modifier 로
 * 함께 낸다. 트랙은 한 종도 내지 않는다.
 *
 * 이펙트 id 와 파라미터 key 는 effects/atoms 카탈로그의 EffectDef 를 그대로 쓴다.
 * 없는 key 를 넣으면 resolveEffectParams 가 조용히 버려서 "적용했는데 아무 일도
 * 안 일어남" 이 된다. 그 사고를 막는 것이 motionsFGHI 테스트의 레지스트리 대조다.
 */

import type { EffectInstance, Modifier } from '@/core/types.ts'
import type { MotionPreset, ParamSpec, PresetEmission, PresetNotice } from '@/motions/types.ts'
import { EFFECT_MACRO_BY_ID, expandMacro } from '@/effects/macros.ts'
import {
  clamp,
  effectSeed,
  emitDuration,
  flashNotice,
  gainOf,
  limitCycles,
  limitFlashCount,
  loopFor,
  makeEffect,
  num,
  pulseParamTrack,
  resolveSpan,
  str,
} from './shared.ts'
import { axisSeed, makeModifier, snapToHold } from './shake.ts'

// ---------------------------------------------------------------------------
// 카테고리 공통
// ---------------------------------------------------------------------------

/** 지지직 계열 공통 용량 통제 값. 프리셋마다 다시 적지 않는다. */
export const GLITCH_FPS = 20
export const GLITCH_HOLD = 2

/** 모든 지지직 프리셋이 공유하는 홀드 노브. 기본값은 반드시 GLITCH_HOLD 다. */
function holdParam(): ParamSpec {
  return {
    key: 'hold',
    label: '노이즈 유지',
    type: 'number',
    min: 1,
    max: 4,
    step: 1,
    unit: '프레임',
    default: GLITCH_HOLD,
  }
}

function readHold(params: Record<string, number | string | boolean>): number {
  return clamp(Math.round(num(params, 'hold', GLITCH_HOLD)), 1, 4)
}

function needsEffect(message: string): PresetNotice {
  return { code: 'needsEffect', message }
}

/**
 * 점멸 상한은 지지직만의 규칙이 아니라 카탈로그 공통 규칙이라 shared.ts 로 올렸다
 * (깜빡임도 같은 상한을 받는다). 여기서는 이름만 다시 내보낸다.
 */
export { limitFlashCount } from './shared.ts'

/**
 * 매크로가 낸 인스턴스의 숫자 파라미터 하나에 계수를 곱한다.
 * 트랙으로 저장된 파라미터는 건드리지 않는다. 매크로는 숫자만 내므로 실제로는
 * 항상 숫자 경로를 탄다. 범위는 이펙트 스펙과 같은 값으로 여기서 미리 자른다.
 */
function scaleEffectParam(
  instance: EffectInstance,
  key: string,
  factor: number,
  lo: number,
  hi: number,
): void {
  const v = instance.params[key]
  if (typeof v !== 'number' || !Number.isFinite(v)) return
  instance.params[key] = clamp(v * factor, lo, hi)
}

// ---------------------------------------------------------------------------
// H1. RGB 분리
// ---------------------------------------------------------------------------

const glitchRgbShift: MotionPreset = {
  id: 'glitch.rgbShift',
  label: '색 어긋남',
  hint: '빨강과 파랑이 서로 어긋나며 인쇄 사고처럼 보인다.',
  category: 'glitch',
  tags: ['glitch', 'color'],
  loopSafe: 'seamless',
  overscan: 'auto',
  easy: true,
  size: 'normal',
  defaultDurationMs: 600,
  recommendedFps: GLITCH_FPS,
  noiseHoldFrames: GLITCH_HOLD,
  params: [
    { key: 'amount', label: '어긋나는 정도', type: 'number', min: 1, max: 24, step: 1, unit: 'px', default: 6 },
    { key: 'angle', label: '어긋나는 방향', type: 'number', min: 0, max: 359, step: 15, unit: '도', default: 0 },
    { key: 'radial', label: '바깥으로 퍼짐', type: 'number', min: 0, max: 100, step: 5, unit: '%', default: 40 },
    { key: 'cycles', label: '반복 횟수', type: 'number', min: 1, max: 6, step: 1, unit: '회', default: 3 },
    holdParam(),
  ],
  emit(ctx): PresetEmission {
    const hold = readHold(ctx.params)
    const span = snapToHold(resolveSpan(ctx, 600), hold)
    const gain = gainOf(ctx.strength)
    const peak = clamp(num(ctx.params, 'amount', 6) * gain, 0, 40)

    /*
     * 시간축은 진폭이 만든다.
     *
     * glitch.rgbShift 의 유니폼은 프레임에 의존하지 않는다(destroy.ts). 그래서
     * amount 를 상수로 내면 전 프레임이 완전히 같은 그림이 되고, '반복 횟수' 노브는
     * 아무 데도 닿지 않는 죽은 파라미터가 된다. amount 를 트랙으로 내서 한 주기에
     * cycles 회 왕복시킨다 (EffectParam = number | Track).
     *
     * 바닥을 0 이 아니라 최고치의 20% 로 둔다. 0 까지 내려가면 어긋남이 완전히
     * 사라지는 프레임이 생겨 '색 어긋남' 이 아니라 '깜빡임' 으로 읽힌다.
     * 마지막 키가 span 에 오고 값이 첫 키와 같아 이음새도 닫힌다.
     */
    const cycles = limitCycles(span, num(ctx.params, 'cycles', 3), 2, 2)

    // 진폭 6px, 각도 0, 방사형 계수 0.4.
    // 슬라이더는 퍼센트로 보여 주고 셰이더에는 계수로 넘긴다.
    const effects: EffectInstance[] = [
      makeEffect({
        id: 'fx.grs.shift',
        type: 'glitch.rgbShift',
        seed: effectSeed(ctx, 'glitch.rgbShift', 'shift'),
        holdFrames: hold,
        params: {
          amount: pulseParamTrack({
            id: 'fx.grs.shift.amount',
            span,
            cycles,
            lo: peak * 0.2,
            hi: peak,
          }),
          angle: clamp(num(ctx.params, 'angle', 0), 0, 360),
          radial: clamp(num(ctx.params, 'radial', 40) / 100, 0, 2),
          // 0 = 실루엣 유지. 1 은 투명 배경 밖으로 프린지를 흘린다.
          fringe: 0,
        },
      }),
    ]

    return {
      tracks: [],
      modifiers: [],
      effects,
      durationFrames: emitDuration(span, []),
      suggestedLoop: loopFor('seamless'),
      suggestedFps: GLITCH_FPS,
      notices: [needsEffect('색 어긋남은 이펙트 스택의 색 분리 효과가 그립니다. 적용하면 자동으로 추가됩니다.')],
    }
  },
}

// ---------------------------------------------------------------------------
// H2. 화면 밀림
// ---------------------------------------------------------------------------

/**
 * 가로줄 단위로 잘려 밀린다.
 * 줄마다 다른 양으로 미는 것은 이펙트 몫이고, 화면 전체가 함께 튀는 성분만 여기서 낸다.
 * 홀드 클럭에 물린 가로 노이즈라 매 프레임이 아니라 두 프레임마다 툭 밀린다.
 */
const glitchSlice: MotionPreset = {
  id: 'glitch.slice',
  label: '화면 밀림',
  hint: '가로로 잘린 조각들이 제멋대로 밀려난다.',
  category: 'glitch',
  tags: ['glitch', 'move'],
  loopSafe: 'seamless',
  overscan: 'required',
  easy: true,
  size: 'heavy',
  defaultDurationMs: 500,
  recommendedFps: GLITCH_FPS,
  noiseHoldFrames: GLITCH_HOLD,
  params: [
    { key: 'slices', label: '조각 수', type: 'number', min: 3, max: 40, step: 1, unit: '개', default: 12 },
    { key: 'amount', label: '밀리는 정도', type: 'number', min: 2, max: 80, step: 2, unit: 'px', default: 24 },
    { key: 'density', label: '밀리는 빈도', type: 'number', min: 5, max: 100, step: 5, unit: '%', default: 40 },
    holdParam(),
  ],
  emit(ctx): PresetEmission {
    const hold = readHold(ctx.params)
    const span = snapToHold(resolveSpan(ctx, 500), hold)
    const gain = gainOf(ctx.strength)
    const amount = clamp(num(ctx.params, 'amount', 24) * gain, 1, 120)

    // 화면 전체가 함께 튀는 성분. 조각별 밀림의 4분의 1 정도가 자연스럽다.
    const modifiers: Modifier[] = [
      makeModifier({
        id: 'mo.gs.x',
        type: 'loopNoise',
        target: 'translateX',
        amplitude: amount * 0.25,
        cycles: 8,
        octaves: 1,
        holdFrames: hold,
        seed: axisSeed(30),
      }),
    ]

    // 슬라이스 12, 최대 24px, 확률 0.4, 채움 wrap.
    // fill 2(반대쪽에서 감기)는 투명 배경에서 조각이 사라지지 않게 해 준다.
    const effects: EffectInstance[] = [
      makeEffect({
        id: 'fx.gs.slice',
        type: 'glitch.slice',
        seed: effectSeed(ctx, 'glitch.slice', 'slice'),
        holdFrames: hold,
        params: {
          slices: clamp(Math.round(num(ctx.params, 'slices', 12)), 2, 64),
          maxOffset: clamp(amount, 0, 200),
          probability: clamp(num(ctx.params, 'density', 40) / 100, 0, 1),
          fill: 2,
          axis: 0,
          // 롤은 0 이다. 0 이 아니면 밀림이 아니라 흐름으로 읽힌다.
          rollCycles: 0,
        },
      }),
    ]

    return {
      tracks: [],
      modifiers,
      effects,
      durationFrames: emitDuration(span, []),
      suggestedLoop: loopFor('seamless'),
      suggestedFps: GLITCH_FPS,
      notices: [needsEffect('조각마다 다르게 밀리는 모습은 이펙트 스택의 조각 밀림 효과가 그립니다.')],
    }
  },
}

// ---------------------------------------------------------------------------
// H3. 블록 깨짐
// ---------------------------------------------------------------------------

const glitchBlock: MotionPreset = {
  id: 'glitch.block',
  label: '블록 깨짐',
  hint: '네모난 덩어리들이 어긋나고 색이 뒤집힌다.',
  category: 'glitch',
  tags: ['glitch'],
  loopSafe: 'seamless',
  overscan: 'auto',
  easy: false,
  size: 'heavy',
  defaultDurationMs: 400,
  recommendedFps: GLITCH_FPS,
  noiseHoldFrames: GLITCH_HOLD,
  params: [
    { key: 'block', label: '덩어리 크기', type: 'number', min: 4, max: 96, step: 4, unit: 'px', default: 24 },
    { key: 'density', label: '깨지는 양', type: 'number', min: 1, max: 40, step: 1, unit: '%', default: 6 },
    { key: 'jitter', label: '어긋나는 정도', type: 'number', min: 2, max: 60, step: 2, unit: 'px', default: 12 },
    holdParam(),
  ],
  emit(ctx): PresetEmission {
    const hold = readHold(ctx.params)
    const span = snapToHold(resolveSpan(ctx, 400), hold)
    const gain = gainOf(ctx.strength)

    // 블록 24px, 밀도 0.06, 지터 12px, 3단 중첩.
    const size = clamp(Math.round(num(ctx.params, 'block', 24)), 4, 128)
    // 셰이더의 jitter 는 px 가 아니라 블록 크기 배수다 (destroy.ts: j = r * jitter * cell).
    // 그래서 px 를 블록 크기로 나눈다. 기본값 12px / 24px = 0.5 가 표의 지터 12px 다.
    const jitterPx = clamp(num(ctx.params, 'jitter', 12) * gain, 0, 120)
    const effects: EffectInstance[] = [
      makeEffect({
        id: 'fx.gbk.block',
        type: 'glitch.block',
        seed: effectSeed(ctx, 'glitch.block', 'block'),
        holdFrames: hold,
        params: {
          size,
          tiers: 3,
          density: clamp((num(ctx.params, 'density', 6) / 100) * gain, 0, 1),
          jitter: clamp(jitterPx / size, 0, 2),
          swap: 0.2,
          invert: 0.05,
        },
      }),
    ]

    return {
      tracks: [],
      modifiers: [],
      effects,
      durationFrames: emitDuration(span, []),
      suggestedLoop: loopFor('seamless'),
      suggestedFps: GLITCH_FPS,
      notices: [needsEffect('덩어리가 깨지는 모습은 이펙트 스택의 블록 어긋남 효과가 그립니다.')],
    }
  },
}

// ---------------------------------------------------------------------------
// H4. 스캔라인
// ---------------------------------------------------------------------------

/**
 * 가로줄이 화면을 훑고 지나간다.
 * 롤 속도는 반드시 정수다. 한 주기 동안 줄무늬가 정확히 정수 개만큼 흘러야
 * 마지막 프레임과 첫 프레임의 줄 위치가 같아진다.
 */
const glitchScanline: MotionPreset = {
  id: 'glitch.scanline',
  label: '주사선',
  hint: '옛날 모니터처럼 가로줄이 깔리고 천천히 흐른다.',
  category: 'glitch',
  tags: ['glitch'],
  loopSafe: 'seamless',
  overscan: 'auto',
  easy: false,
  size: 'light',
  defaultDurationMs: 1200,
  recommendedFps: GLITCH_FPS,
  noiseHoldFrames: 1,
  params: [
    { key: 'lineH', label: '줄 두께', type: 'number', min: 1, max: 8, step: 1, unit: 'px', default: 2 },
    { key: 'opacity', label: '줄 진하기', type: 'number', min: 5, max: 60, step: 1, unit: '%', default: 18 },
    { key: 'roll', label: '흐르는 속도', type: 'number', min: 0, max: 4, step: 1, unit: '칸', default: 1 },
  ],
  emit(ctx): PresetEmission {
    // 스캔라인은 노이즈가 아니라 규칙적인 무늬라 홀드가 필요 없다.
    // 정지 화면 위에서는 프레임 간 차이도 거의 없어 용량 부담이 가장 작다.
    const span = resolveSpan(ctx, 1200)
    const gain = gainOf(ctx.strength)

    // 라인 2px, 불투명도 0.18, 롤 속도 1 (정수 필수).
    // 이 프리셋의 진폭 축은 줄 진하기다. 세기를 여기 태우지 않으면 슬라이더가
    // 아무 일도 하지 않는 프리셋이 하나 생긴다.
    // rollCycles 가 정수라야 한 주기에 줄무늬가 정확히 정수 개만큼 흘러 이음새가 없다.
    const effects: EffectInstance[] = [
      makeEffect({
        id: 'fx.gsc.scanline',
        type: 'fx.scanline',
        seed: effectSeed(ctx, 'glitch.scanline', 'scanline'),
        holdFrames: 1,
        params: {
          height: clamp(Math.round(num(ctx.params, 'lineH', 2)), 1, 32),
          opacity: clamp((num(ctx.params, 'opacity', 18) / 100) * gain, 0, 1),
          softness: 0.25,
          rollCycles: clamp(Math.round(num(ctx.params, 'roll', 1)), -16, 16),
          // 인터레이스는 짝수 프레임 수를 요구한다. 여기서 켜면 길이 제약이 하나 는다.
          interlace: 0,
        },
      }),
    ]

    return {
      tracks: [],
      modifiers: [],
      effects,
      durationFrames: emitDuration(span, []),
      suggestedLoop: loopFor('seamless'),
      suggestedFps: GLITCH_FPS,
      notices: [needsEffect('가로줄 무늬는 이펙트 스택의 주사선 효과가 그립니다.')],
    }
  },
}

// ---------------------------------------------------------------------------
// H5. 물결 왜곡
// ---------------------------------------------------------------------------

const glitchWave: MotionPreset = {
  id: 'glitch.wave',
  label: '물결 왜곡',
  hint: '화면이 물결처럼 굽이치며 흔들린다.',
  category: 'glitch',
  tags: ['glitch'],
  loopSafe: 'seamless',
  overscan: 'auto',
  easy: false,
  size: 'normal',
  defaultDurationMs: 1600,
  recommendedFps: GLITCH_FPS,
  noiseHoldFrames: 1,
  params: [
    { key: 'amount', label: '굽이치는 정도', type: 'number', min: 1, max: 40, step: 1, unit: 'px', default: 8 },
    { key: 'waves', label: '물결 수', type: 'number', min: 1, max: 8, step: 1, unit: '개', default: 3 },
    {
      key: 'axis',
      label: '물결 방향',
      type: 'select',
      options: [
        { value: 'y', label: '가로로 눕게' },
        { value: 'x', label: '세로로 서게' },
      ],
      default: 'y',
    },
    { key: 'cycles', label: '반복 횟수', type: 'number', min: 1, max: 4, step: 1, unit: '회', default: 1 },
  ],
  emit(ctx): PresetEmission {
    const span = resolveSpan(ctx, 1600)
    const gain = gainOf(ctx.strength)

    // 진폭 8px, 파 3개, 축 y, 주기 1.
    // 프리셋의 'y'(가로로 눕게)는 이펙트의 축 0(가로로 밀기 = 세로 방향 파)이다.
    const effects: EffectInstance[] = [
      makeEffect({
        id: 'fx.gw.wave',
        type: 'glitch.wave',
        seed: effectSeed(ctx, 'glitch.wave', 'wave'),
        holdFrames: 1,
        params: {
          amp: clamp(num(ctx.params, 'amount', 8) * gain, 0, 64),
          waves: clamp(Math.round(num(ctx.params, 'waves', 3)), 1, 16),
          axis: str(ctx.params, 'axis', 'y') === 'x' ? 1 : 0,
          cycles: clamp(Math.round(num(ctx.params, 'cycles', 1)), 1, 8),
          hold: 1,
        },
      }),
    ]

    return {
      tracks: [],
      modifiers: [],
      effects,
      durationFrames: emitDuration(span, []),
      suggestedLoop: loopFor('seamless'),
      suggestedFps: GLITCH_FPS,
      notices: [needsEffect('물결 왜곡은 이펙트 스택의 화면 일그러짐 효과가 그립니다.')],
    }
  },
}

// ---------------------------------------------------------------------------
// H6. 픽셀 소트
// ---------------------------------------------------------------------------

/**
 * 밝기 기준으로 픽셀이 줄줄 흘러내린다.
 *
 * 반복 횟수를 반드시 저장한다. 근사 이웃 스왑은 몇 번 돌렸느냐로
 * 결과가 완전히 달라져서, 저장하지 않으면 프리뷰와 내보내기가 다른 그림을 낸다.
 * 값이 시작으로 돌아오지 않으므로 왕복 재생에만 어울린다.
 */
const glitchPixelSort: MotionPreset = {
  id: 'glitch.pixelSort',
  label: '픽셀 흘러내림',
  hint: '밝은 픽셀들이 한 방향으로 길게 흘러내린다.',
  category: 'glitch',
  tags: ['glitch'],
  loopSafe: 'pingPongOnly',
  overscan: 'auto',
  easy: false,
  size: 'normal',
  largeSource: true,
  defaultDurationMs: 800,
  recommendedFps: GLITCH_FPS,
  noiseHoldFrames: GLITCH_HOLD,
  params: [
    { key: 'threshold', label: '흘러내리는 기준', type: 'number', min: 10, max: 90, step: 5, unit: '%', default: 55 },
    { key: 'passes', label: '흘러내리는 길이', type: 'number', min: 4, max: 64, step: 4, unit: '단계', default: 24 },
    {
      key: 'axis',
      label: '흐르는 방향',
      type: 'select',
      options: [
        { value: 'y', label: '아래로' },
        { value: 'x', label: '옆으로' },
      ],
      default: 'y',
    },
    holdParam(),
  ],
  emit(ctx): PresetEmission {
    const hold = readHold(ctx.params)
    const span = snapToHold(resolveSpan(ctx, 800), hold)
    const gain = gainOf(ctx.strength)

    // 임계 0.55, 축 y, 반복 24회, 키 휘도.
    // iterations 는 반드시 문서에 저장한다. 근사 반복이라 횟수가 곧 결과 픽셀이고,
    // 기기 성능에 맞춰 조절하면 프리뷰와 내보내기가 다른 그림을 낸다.
    // 이 프리셋의 진폭 축은 흘러내린 길이, 즉 반복 횟수다. 세기를 여기 태운다.
    // 성능에 따라 바뀌는 것이 아니라 사용자가 고른 값에서 결정론적으로 유도된다.
    const effects: EffectInstance[] = [
      makeEffect({
        id: 'fx.gps.sort',
        type: 'glitch.pixelSort',
        seed: effectSeed(ctx, 'glitch.pixelSort', 'sort'),
        holdFrames: hold,
        params: {
          threshold: clamp(num(ctx.params, 'threshold', 55) / 100, 0, 1),
          key: 0,
          axis: str(ctx.params, 'axis', 'y') === 'x' ? 1 : 0,
          order: 0,
          iterations: clamp(Math.round(num(ctx.params, 'passes', 24) * gain), 1, 64),
        },
      }),
    ]

    return {
      tracks: [],
      modifiers: [],
      effects,
      durationFrames: emitDuration(span, []),
      suggestedLoop: loopFor('pingPongOnly'),
      suggestedFps: GLITCH_FPS,
      notices: [
        needsEffect('픽셀 흘러내림은 이펙트 스택의 픽셀 정렬 효과가 그립니다.'),
        {
          code: 'largeSourceRecommended',
          message: '흘러내리는 길이를 늘릴수록 처리가 무거워집니다. 미리보기가 느려지면 길이를 줄여 보세요.',
        },
      ],
    }
  },
}

// ---------------------------------------------------------------------------
// H7. 지지직 폭발
// ---------------------------------------------------------------------------

/**
 * 몇 번 크게 터지고 그때마다 화면이 흔들린다.
 *
 * eventBurst 는 사건을 한 주기에 균등 배치하고 각 사건에서 지수 감쇠하며,
 * 이전 주기에서 넘어온 꼬리까지 더한다 (generators.ts). 그래서 t=0 에서 이음새가 없다.
 * 사건 수는 WCAG 2.3.1 상한 안으로 자른다. 세기를 최대로 올려도 초당 3회를 넘지 않는다.
 */
const glitchBurst: MotionPreset = {
  id: 'glitch.burst',
  label: '지지직 폭발',
  hint: '몇 번 크게 터지듯 화면이 무너졌다 돌아온다.',
  category: 'glitch',
  tags: ['glitch', 'move'],
  loopSafe: 'seamless',
  overscan: 'required',
  easy: true,
  size: 'heavy',
  flashWarning: true,
  defaultDurationMs: 900,
  recommendedFps: GLITCH_FPS,
  noiseHoldFrames: GLITCH_HOLD,
  params: [
    { key: 'events', label: '터지는 횟수', type: 'number', min: 1, max: 4, step: 1, unit: '회', default: 2 },
    { key: 'amount', label: '터지는 세기', type: 'number', min: 2, max: 40, step: 1, unit: 'px', default: 14 },
    holdParam(),
  ],
  emit(ctx): PresetEmission {
    const hold = readHold(ctx.params)
    const span = snapToHold(resolveSpan(ctx, 900), hold)
    const gain = gainOf(ctx.strength)
    const amount = clamp(num(ctx.params, 'amount', 14) * gain, 1, 80)
    const events = limitFlashCount(num(ctx.params, 'events', 2), span, ctx.fps)

    const modifiers: Modifier[] = [
      makeModifier({ id: 'mo.gb.x', type: 'eventBurst', target: 'translateX', amplitude: amount, cycles: events, decay: 6 }),
      makeModifier({ id: 'mo.gb.y', type: 'eventBurst', target: 'translateY', amplitude: amount * 0.6, cycles: events, decay: 8 }),
    ]

    /*
     * 사건마다 세 이펙트를 짧게 켠다.
     *
     * range 를 안 자르면 전 구간이 무너져 "폭발" 이 아니라 "고장" 이 된다. 사건은
     * eventBurst 와 같은 균등 배치를 쓰므로 화면이 튀는 순간과 픽셀이 무너지는 순간이
     * 정확히 맞는다. range 는 양끝 포함이다 (isEffectActiveAt).
     */
    const burstFrames = Math.max(1, Math.round((80 / 1000) * (ctx.fps > 0 ? ctx.fps : GLITCH_FPS)))
    const effects: EffectInstance[] = []
    for (let i = 0; i < events; i += 1) {
      const start = Math.round((span * i) / events)
      const end = Math.min(span - 1, start + burstFrames)
      const range: [number, number] = [start, end]
      effects.push(
        makeEffect({
          id: `fx.gb.s${i}`,
          type: 'glitch.slice',
          seed: effectSeed(ctx, 'glitch.burst', `slice:${i}`),
          holdFrames: hold,
          range,
          params: {
            slices: 16,
            maxOffset: clamp(amount, 0, 200),
            probability: 0.5,
            fill: 2,
            axis: 0,
            rollCycles: 0,
          },
        }),
        makeEffect({
          id: `fx.gb.b${i}`,
          type: 'glitch.block',
          seed: effectSeed(ctx, 'glitch.burst', `block:${i}`),
          holdFrames: hold,
          range,
          params: { size: 24, tiers: 3, density: 0.12, jitter: 0.5, swap: 0.3, invert: 0.08 },
        }),
        makeEffect({
          id: `fx.gb.r${i}`,
          type: 'glitch.rgbShift',
          seed: effectSeed(ctx, 'glitch.burst', `rgb:${i}`),
          holdFrames: hold,
          range,
          params: { amount: clamp(amount * 0.5, 0, 40), angle: 0, radial: 0.4, fringe: 0 },
        }),
      )
    }

    return {
      tracks: [],
      modifiers,
      effects,
      durationFrames: emitDuration(span, []),
      suggestedLoop: loopFor('seamless'),
      suggestedFps: GLITCH_FPS,
      notices: [
        flashNotice(),
        needsEffect('터질 때 화면이 무너지는 모습은 이펙트 스택의 조각 밀림과 색 분리 효과가 함께 그립니다.'),
      ],
    }
  },
}

// ---------------------------------------------------------------------------
// H8. 낡은 테이프 (매크로)
// ---------------------------------------------------------------------------

/**
 * 매크로 프리셋이다. 원자 이펙트 다섯을 한 번에 얹는다.
 *
 * 통짜 셰이더로 만들면 "스캔라인만 원한다" 를 맞출 수 없다.
 * 핵심은 크로마만 망가뜨리는 것이다. 밝기까지 함께 뭉개면 그냥 흐린 영상이 되고,
 * 색만 번지고 윤곽이 살아 있어야 테이프로 읽힌다.
 */
const glitchVhs: MotionPreset = {
  id: 'glitch.vhs',
  label: '낡은 테이프',
  hint: '색이 번지고 화면이 흔들리는 낡은 테이프 느낌을 한 번에 얹는다.',
  category: 'glitch',
  tags: ['glitch', 'color'],
  loopSafe: 'seamless',
  overscan: 'required',
  easy: false,
  size: 'heavy',
  defaultDurationMs: 1200,
  recommendedFps: GLITCH_FPS,
  noiseHoldFrames: GLITCH_HOLD,
  params: [
    { key: 'chroma', label: '색 번짐', type: 'number', min: 0, max: 100, step: 5, unit: '%', default: 60 },
    { key: 'wobble', label: '테이프 흔들림', type: 'number', min: 0, max: 8, step: 0.5, unit: 'px', default: 1.5 },
    { key: 'band', label: '가로 띠', type: 'number', min: 0, max: 100, step: 5, unit: '%', default: 45 },
    holdParam(),
  ],
  emit(ctx): PresetEmission {
    const hold = readHold(ctx.params)
    const span = snapToHold(resolveSpan(ctx, 1200), hold)
    const gain = gainOf(ctx.strength)
    const wobble = clamp(num(ctx.params, 'wobble', 1.5) * gain, 0, 16)

    // 테이프 흔들림만 트랜스폼 성분이다. 세로로 미세하게 떨리고 가로로는 거의 안 움직인다.
    const modifiers: Modifier[] =
      wobble > 0
        ? [
            makeModifier({ id: 'mo.gv.y', type: 'loopNoise', target: 'translateY', amplitude: wobble, cycles: 5, octaves: 1, holdFrames: hold, seed: axisSeed(31) }),
            makeModifier({ id: 'mo.gv.x', type: 'loopNoise', target: 'translateX', amplitude: wobble * 0.3, cycles: 5, octaves: 1, holdFrames: hold, seed: axisSeed(32) }),
          ]
        : []

    /*
     * 매크로를 낱개 원자로 펼친다. 통짜 셰이더가 아니라 여섯 줄이 스택에 들어가므로
     * 사용자가 스캔라인만 지우는 것도, 그레인만 세게 올리는 것도 그대로 된다.
     *
     * makeId 는 순번이다. Math.random 을 쓰면 같은 조작이 다른 문서를 만든다.
     * vhs 매크로에는 optional 스텝이 없으므로 has 검사는 넘기지 않는다.
     */
    let n = 0
    const macro = EFFECT_MACRO_BY_ID.get('macro.vhs')
    const effects: EffectInstance[] = macro
      ? expandMacro(macro, {
          makeId: () => `fx.gv.${n++}`,
          strength: ctx.strength,
          baseSeed: effectSeed(ctx, 'glitch.vhs', 'macro'),
        })
      : []

    // 슬라이더 두 개를 매크로 위에 얹는다. 기본값(색 번짐 60%, 가로 띠 45%)에서
    // 계수가 정확히 1 이라 매크로가 정한 표 값이 그대로 나온다.
    const chromaK = clamp(num(ctx.params, 'chroma', 60) / 60, 0, 2)
    const bandK = clamp(num(ctx.params, 'band', 45) / 45, 0, 2)
    for (const e of effects) {
      // 용량 통제가 매크로의 스텝별 홀드보다 우선한다 (파일 상단). 홀드를 1 로 내리고
      // 싶으면 사용자가 '노이즈 유지' 노브를 1 로 두면 된다.
      e.holdFrames = hold
      if (e.type === 'glitch.chroma') {
        scaleEffectParam(e, 'blur', chromaK, 0, 40)
        scaleEffectParam(e, 'offset', chromaK, -20, 20)
        scaleEffectParam(e, 'noise', chromaK, 0, 1)
        scaleEffectParam(e, 'ghost', chromaK, 0, 1)
      }
      if (e.type === 'glitch.band') {
        scaleEffectParam(e, 'lift', bandK, 0, 1)
        scaleEffectParam(e, 'tearing', bandK, 0, 1)
        scaleEffectParam(e, 'noise', bandK, 0, 1)
      }
    }

    return {
      tracks: [],
      modifiers,
      effects,
      durationFrames: emitDuration(span, []),
      suggestedLoop: loopFor('seamless'),
      suggestedFps: GLITCH_FPS,
      notices: [
        needsEffect('색 번짐과 가로 띠는 이펙트 스택의 낡은 테이프 묶음이 그립니다. 낱개 효과로 나뉘어 들어가니 원하지 않는 것만 꺼도 됩니다.'),
      ],
    }
  },
}

/*
 * 이펙트 배선 요약 (실제로 emit 하는 것).
 * 모든 인스턴스의 holdFrames 는 프리셋이 계산한 hold 다. 여기가 용량 통제의 절반이다.
 *
 *   glitch.rgbShift  : glitch.rgbShift  { amount, angle, radial, fringe 0 }
 *   glitch.slice     : glitch.slice     { slices, maxOffset, probability, fill 2, axis, rollCycles }
 *   glitch.block     : glitch.block     { size, tiers 3, density, jitter, swap, invert }
 *   glitch.scanline  : fx.scanline      { height, opacity, softness, rollCycles(정수), interlace 0 }
 *   glitch.wave      : glitch.wave      { amp, waves, axis, cycles, hold }
 *   glitch.pixelSort : glitch.pixelSort { threshold, key, axis, order, iterations }
 *   glitch.burst     : 사건마다 glitch.slice + glitch.block + glitch.rgbShift 를 넣고
 *                      range 로 사건 구간(시작 ~ +80ms)만 켠다.
 *   glitch.vhs       : macro.vhs 를 expandMacro 로 펼친 여섯 원자.
 */

export const GLITCH_PRESETS: MotionPreset[] = [
  glitchRgbShift,
  glitchSlice,
  glitchBlock,
  glitchScanline,
  glitchWave,
  glitchPixelSort,
  glitchBurst,
  glitchVhs,
]
