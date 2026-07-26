/**
 * G. 자글자글. 4종 전부.
 *
 * 핵심은 워프가 아니라 **홀드 클럭**이다.
 *   effFrame = floor(frame / hold) * hold
 * 25fps 로 부드럽게 흐르는 카메라 위에서 그림만 2컷, 3컷으로 잡히면 그 대비가
 * "움직이는 카메라 위에 손으로 그린" 느낌으로 읽힌다. 홀드를 빼면 아무리 예쁜
 * 노이즈를 써도 그냥 흐물거리는 이미지다.
 *
 * ---------------------------------------------------------------------------
 * 두 겹으로 낸다
 * ---------------------------------------------------------------------------
 * 이 카테고리의 완성형은 두 겹이다.
 *   1. 홀드 클럭에 물린 **미세 어파인** (위치 1px, 회전 0.3도, 배율 0.5% 안쪽) -> Modifier
 *   2. 홀드 클럭에 물린 **도메인 워프 픽셀 이펙트** (노이즈 워프, 엣지 가중, 종이 결)
 *      -> EffectInstance
 *
 * **두 겹의 홀드가 반드시 같아야 한다.** 어긋나면 그림은 3컷인데 결은 2컷으로 놀아서
 * 원인을 못 짚겠는 어색함만 남는다. 그래서 EffectInstance.holdFrames 와 이펙트 자체의
 * hold 파라미터, 모디파이어의 holdFrames 를 전부 같은 hold 로 채운다.
 *
 * boil.step 은 정의상 1번뿐이다. 이펙트를 정의하지 않으므로 effects 필드를 아예 내지
 * 않는다 (undefined = 기존 스택 유지. motions/types.ts 의 계약 참조).
 */

import type { EffectInstance, Modifier } from '@/core/types.ts'
import type { MotionPreset, PresetEmission, PresetNotice } from '@/motions/types.ts'
import {
  clamp,
  effectSeed,
  emitDuration,
  gainOf,
  loopFor,
  makeEffect,
  num,
  resolveSpan,
} from './shared.ts'
import { axisSeed, makeModifier, snapToHold } from './shake.ts'

/**
 * 미세 어파인 4축 (위치 x, y / 회전 / 배율).
 *
 * 네 축 모두 같은 홀드에 물린다. 하나라도 매 프레임 갱신되면 그 축이 부드럽게
 * 흘러 버려서 나머지 세 축의 계단이 "버그" 로 보인다. 홀드는 전부 같아야 한다.
 */
function affineJitter(
  prefix: string,
  hold: number,
  cycles: number,
  px: number,
  deg: number,
  scaleRatio: number,
): Modifier[] {
  const out: Modifier[] = [
    makeModifier({ id: `${prefix}.x`, type: 'loopNoise', target: 'translateX', amplitude: px, cycles, holdFrames: hold, octaves: 1, seed: axisSeed(20) }),
    makeModifier({ id: `${prefix}.y`, type: 'loopNoise', target: 'translateY', amplitude: px, cycles, holdFrames: hold, octaves: 1, seed: axisSeed(21) }),
  ]
  if (deg > 0) {
    out.push(makeModifier({ id: `${prefix}.r`, type: 'loopNoise', target: 'rotate', amplitude: deg, cycles, holdFrames: hold, octaves: 1, seed: axisSeed(22) }))
  }
  if (scaleRatio > 0) {
    out.push(makeModifier({ id: `${prefix}.s`, type: 'loopNoise', target: 'scale', amplitude: scaleRatio, cycles, holdFrames: hold, octaves: 1, seed: axisSeed(23) }))
  }
  return out
}

/** 픽셀 이펙트가 있어야 완성되는 프리셋의 안내. 원인이 아니라 처방을 말한다. */
function needsEffect(message: string): PresetNotice {
  return { code: 'needsEffect', message }
}

/** 홀드 때문에 길이를 맞춘 경우에만 알린다. 안 바뀌었으면 조용히 넘어간다. */
function snapNotice(before: number, after: number, hold: number): PresetNotice[] {
  if (before === after) return []
  return [
    {
      code: 'durationSnapped',
      message: `${hold}프레임씩 잡아 두는 움직임이라 전체 길이를 ${after}프레임으로 맞췄습니다. 그래야 마지막 컷이 잘리지 않고 반복됩니다.`,
    },
  ]
}

// ---------------------------------------------------------------------------
// G1. 손그림 자글자글
// ---------------------------------------------------------------------------

const boilHand: MotionPreset = {
  id: 'boil.hand',
  label: '손그림 자글자글',
  hint: '손으로 여러 장 그린 것처럼 그림이 몇 프레임마다 미세하게 바뀐다.',
  category: 'boil',
  tags: ['boil', 'move', 'rotate'],
  loopSafe: 'seamless',
  overscan: 'required',
  easy: true,
  size: 'normal',
  defaultDurationMs: 600,
  noiseHoldFrames: 3,
  params: [
    { key: 'amount', label: '일렁이는 정도', type: 'number', min: 0.5, max: 6, step: 0.1, unit: 'px', default: 1.5 },
    { key: 'hold', label: '몇 프레임마다', type: 'number', min: 2, max: 6, step: 1, unit: '프레임', default: 3 },
    { key: 'states', label: '그림 장수', type: 'number', min: 2, max: 6, step: 1, unit: '장', default: 3 },
  ],
  emit(ctx): PresetEmission {
    const hold = clamp(Math.round(num(ctx.params, 'hold', 3)), 2, 6)
    const raw = resolveSpan(ctx, 600)
    const span = snapToHold(raw, hold)
    const gain = gainOf(ctx.strength)
    const px = clamp(num(ctx.params, 'amount', 1.5) * gain, 0.1, 10)
    // 그림 장수가 곧 노이즈 반지름이다. 크면 이웃한 컷끼리 더 크게 달라진다.
    const states = clamp(Math.round(num(ctx.params, 'states', 3)), 2, 6)

    const modifiers = affineJitter('mo.bh', hold, states, px, px * 0.2, 0.006 * gain)

    // 워프 진폭 1.5px, 스케일 0.006, 3상태 사이클, 홀드 3프레임.
    // 도메인 워프(swirl)가 등고선을 손그림처럼 구부린다. 옥타브를 올리는 것보다 싸다.
    const effects: EffectInstance[] = [
      makeEffect({
        id: 'fx.bh.warp',
        type: 'boil.warp',
        seed: effectSeed(ctx, 'boil.hand', 'warp'),
        holdFrames: hold,
        params: {
          amp: clamp(px, 0, 8),
          scale: 0.006,
          swirl: 0.5,
          octaves: 2,
          states,
          hold,
        },
      }),
    ]

    return {
      tracks: [],
      modifiers,
      effects,
      durationFrames: emitDuration(span, []),
      suggestedLoop: loopFor('seamless'),
      notices: [
        ...snapNotice(raw, span, hold),
        needsEffect('선이 일렁이는 느낌은 이펙트 스택의 일렁임 효과를 함께 켜야 완성됩니다.'),
      ],
    }
  },
}

// ---------------------------------------------------------------------------
// G2. 외곽선만 자글자글
// ---------------------------------------------------------------------------

/**
 * 안쪽은 가만히 두고 테두리만 떤다.
 *
 * 이건 어파인으로 흉내 낼 수 없다. 알파 SDF 의 임계값을 흔들거나 엣지 강도로
 * 워프를 가중해야 하고, 둘 다 픽셀 이펙트다. 그래도 카드가 아무 일도 안 하는 것보다
 * 낫기 때문에 아주 작은 어파인만 함께 낸다. 이펙트가 붙으면 이 어파인이
 * 테두리 떨림과 같은 홀드 클럭에 물려 한 몸으로 움직인다.
 */
const boilEdge: MotionPreset = {
  id: 'boil.edge',
  label: '외곽선만 자글자글',
  hint: '안쪽은 그대로 두고 테두리만 손으로 그린 듯 떤다.',
  category: 'boil',
  tags: ['boil'],
  loopSafe: 'seamless',
  overscan: 'required',
  easy: false,
  size: 'normal',
  defaultDurationMs: 600,
  noiseHoldFrames: 3,
  params: [
    { key: 'amount', label: '테두리 떨림', type: 'number', min: 0.5, max: 8, step: 0.5, unit: 'px', default: 2 },
    { key: 'hold', label: '몇 프레임마다', type: 'number', min: 2, max: 6, step: 1, unit: '프레임', default: 3 },
  ],
  emit(ctx): PresetEmission {
    const hold = clamp(Math.round(num(ctx.params, 'hold', 3)), 2, 6)
    const raw = resolveSpan(ctx, 600)
    const span = snapToHold(raw, hold)
    const gain = gainOf(ctx.strength)
    const px = clamp(num(ctx.params, 'amount', 2) * gain, 0.1, 12)

    // 테두리 떨림의 3분의 1 만 어파인으로 낸다. 나머지는 이펙트 몫이다.
    const modifiers = affineJitter('mo.be', hold, 3, px * 0.3, 0, 0)

    // source 0 은 자동이다. 알파가 있으면 알파 경계를, 없으면 휘도 경계를 쓴다.
    // 어파인이 3분의 1 만 냈으므로 이펙트는 진폭 전체를 받는다.
    const effects: EffectInstance[] = [
      makeEffect({
        id: 'fx.be.edge',
        type: 'boil.edge',
        seed: effectSeed(ctx, 'boil.edge', 'edge'),
        holdFrames: hold,
        params: {
          amp: clamp(px, 0, 10),
          source: 0,
          states: 3,
          hold,
        },
      }),
    ]

    return {
      tracks: [],
      modifiers,
      effects,
      durationFrames: emitDuration(span, []),
      suggestedLoop: loopFor('seamless'),
      notices: [
        ...snapNotice(raw, span, hold),
        needsEffect('테두리만 떨게 하려면 이펙트 스택의 테두리 일렁임 효과가 필요합니다. 투명 배경 이미지에서 가장 잘 보입니다.'),
      ],
    }
  },
}

// ---------------------------------------------------------------------------
// G3. 종이 위 떨림
// ---------------------------------------------------------------------------

const boilPaper: MotionPreset = {
  id: 'boil.paper',
  label: '종이 위 떨림',
  hint: '종이에 그린 그림처럼 결이 비치고 잘게 떤다.',
  category: 'boil',
  tags: ['boil', 'move'],
  loopSafe: 'seamless',
  overscan: 'required',
  easy: false,
  size: 'normal',
  defaultDurationMs: 800,
  noiseHoldFrames: 3,
  params: [
    { key: 'amount', label: '떨리는 정도', type: 'number', min: 0.5, max: 5, step: 0.1, unit: 'px', default: 1 },
    { key: 'hold', label: '몇 프레임마다', type: 'number', min: 2, max: 6, step: 1, unit: '프레임', default: 3 },
    { key: 'grain', label: '결의 세기', type: 'number', min: 0, max: 100, step: 5, unit: '%', default: 35 },
  ],
  emit(ctx): PresetEmission {
    const hold = clamp(Math.round(num(ctx.params, 'hold', 3)), 2, 6)
    const raw = resolveSpan(ctx, 800)
    const span = snapToHold(raw, hold)
    const gain = gainOf(ctx.strength)
    const px = clamp(num(ctx.params, 'amount', 1) * gain, 0.1, 8)

    const modifiers = affineJitter('mo.bp', hold, 3, px, px * 0.15, 0)

    // 결의 세기는 0~100% 슬라이더다. 종이 결이 본체이고 입자는 그 절반만 얹는다.
    // 그레인까지 같은 홀드 클럭에 물려야 종이로 읽힌다. holdFrames 를 1 로 두면
    // 결이 매 프레임 새로 뽑혀 종이가 아니라 화면 잡음이 된다.
    const grain = clamp(num(ctx.params, 'grain', 35) / 100, 0, 1)
    const effects: EffectInstance[] = [
      makeEffect({
        id: 'fx.bp.warp',
        type: 'boil.warp',
        seed: effectSeed(ctx, 'boil.paper', 'warp'),
        holdFrames: hold,
        params: { amp: clamp(px, 0, 8), scale: 0.006, swirl: 0.35, octaves: 1, states: 3, hold },
      }),
      makeEffect({
        id: 'fx.bp.paper',
        type: 'fx.paper',
        seed: effectSeed(ctx, 'boil.paper', 'paper'),
        holdFrames: hold,
        // jitter 0 = 결이 제자리에 고정된다. 종이는 그림과 함께 기어다니지 않는다.
        params: { amount: grain, scale: 3, blend: 0, jitter: 0 },
      }),
      makeEffect({
        id: 'fx.bp.grain',
        type: 'fx.grain',
        seed: effectSeed(ctx, 'boil.paper', 'grain'),
        holdFrames: hold,
        params: { amount: clamp(grain * 0.5, 0, 1), size: 1, mono: 1, midtone: 1 },
      }),
    ]

    return {
      tracks: [],
      modifiers,
      effects,
      durationFrames: emitDuration(span, []),
      suggestedLoop: loopFor('seamless'),
      notices: [
        ...snapNotice(raw, span, hold),
        // 그레인이 매 프레임 새로 뽑히면 종이가 아니라 화면 잡음이 된다.
        // 결도 같은 홀드 클럭에 물려야 한다.
        needsEffect('종이 결과 입자는 이펙트 스택의 종이 질감과 입자 효과가 맡습니다. 떨림과 같은 박자로 맞춰집니다.'),
      ],
    }
  },
}

// ---------------------------------------------------------------------------
// G5. 잔결 자글자글
// ---------------------------------------------------------------------------

/**
 * 면 전체가 잘게 떠는 자글자글.
 *
 * 나머지 넷과 다른 점은 **무엇이 움직이는가** 다. 손그림 자글자글은 그림 전체를
 * 미세 어파인으로 흔들어 "여러 장 그린" 느낌을 만든다. 그림은 통째로 움직이고
 * 표면은 가만히 있다. 이쪽은 반대다. 그림은 제자리에 두고 **표면만** 잘게 끓는다.
 *
 * 노이즈 스케일이 그 차이를 만든다. scale 은 픽셀 좌표에 곱해지므로 무늬 주기가
 * 1/scale 픽셀이다.
 *
 *   손그림 자글자글  scale 0.006  ->  주기 약 167px. 큰 덩어리가 느리게 일렁인다.
 *   잔결 자글자글    scale 0.035  ->  주기 약 29px.  잔물결이 면 전체에 깔린다.
 *
 * 그래서 어파인은 거의 0 으로 둔다. 잔결과 전체 흔들림이 겹치면 잔결이 묻힌다.
 * 진폭도 1px 아래다. 촘촘한 무늬를 크게 흔들면 자글자글이 아니라 뭉개짐이 된다.
 */
const boilFine: MotionPreset = {
  id: 'boil.fine',
  label: '잔결 자글자글',
  hint: '그림은 제자리에 두고 면 전체가 잘고 촘촘하게 끓는다.',
  category: 'boil',
  tags: ['boil'],
  loopSafe: 'seamless',
  overscan: 'required',
  easy: true,
  size: 'normal',
  defaultDurationMs: 600,
  noiseHoldFrames: 2,
  params: [
    { key: 'density', label: '촘촘한 정도', type: 'number', min: 10, max: 100, step: 5, unit: '%', default: 70 },
    { key: 'amount', label: '떨리는 정도', type: 'number', min: 0.2, max: 3, step: 0.1, unit: 'px', default: 0.8 },
    { key: 'hold', label: '몇 프레임마다', type: 'number', min: 1, max: 4, step: 1, unit: '프레임', default: 2 },
  ],
  emit(ctx): PresetEmission {
    const hold = clamp(Math.round(num(ctx.params, 'hold', 2)), 1, 4)
    const raw = resolveSpan(ctx, 600)
    const span = snapToHold(raw, hold)
    const gain = gainOf(ctx.strength)

    /*
     * 촘촘한 정도 0~100% 를 노이즈 스케일로 옮긴다.
     *
     * 상한은 이펙트 카탈로그의 0.05 가 아니라 0.045 로 잡는다. 0.05 는 주기가 20px 라
     * 512px 캔버스에서 무늬가 픽셀 격자와 맞물려 모아레가 뜬다. 하한 0.012 도
     * 손그림 자글자글(0.006)의 두 배라, 가장 성기게 둬도 "잔결" 로 읽힌다.
     */
    const density = clamp(num(ctx.params, 'density', 70) / 100, 0, 1)
    const scale = 0.012 + density * 0.033

    // 촘촘할수록 진폭을 줄인다. 주기가 29px 인 무늬를 3px 흔들면 이웃 골끼리 겹쳐
    // 무늬가 아니라 얼룩이 된다. 진폭은 주기의 1/10 을 넘지 않게 묶는다.
    const wanted = num(ctx.params, 'amount', 0.8) * gain
    const px = clamp(wanted, 0.1, 0.1 / scale)

    /*
     * 어파인은 진폭의 1/8 만 남긴다. 0 으로 두면 이펙트를 끈 사용자에게 카드가
     * 아무 일도 안 하는 것으로 보인다. 그렇다고 크게 주면 잔결이 통째로 묻힌다.
     * 회전과 배율은 아예 없다. 면이 끓는 데 그림이 기울 이유가 없다.
     */
    const modifiers = affineJitter('mo.bf', hold, 4, px * 0.125, 0, 0)

    const effects: EffectInstance[] = [
      makeEffect({
        id: 'fx.bf.warp',
        type: 'boil.warp',
        seed: effectSeed(ctx, 'boil.fine', 'warp'),
        holdFrames: hold,
        params: {
          amp: px,
          scale,
          // 도메인 워프는 낮게 둔다. 잔결에 크게 걸면 무늬가 소용돌이로 뭉친다.
          swirl: 0.2,
          octaves: 2,
          // 상태 수가 많을수록 이웃 컷끼리 덜 닮는다. 촘촘한 무늬는 그래야 끓어 보인다.
          states: 5,
          hold,
        },
      }),
    ]

    return {
      tracks: [],
      modifiers,
      effects,
      durationFrames: emitDuration(span, []),
      suggestedLoop: loopFor('seamless'),
      notices: [
        ...snapNotice(raw, span, hold),
        needsEffect('면이 끓는 느낌은 이펙트 스택의 일렁임 효과가 만듭니다. 끄면 아주 미세한 떨림만 남습니다.'),
      ],
    }
  },
}

// ---------------------------------------------------------------------------
// G4. 2컷 스텝
// ---------------------------------------------------------------------------

/**
 * 홀드 클럭만으로 만드는 스톱모션 룩.
 * 이펙트가 필요 없는 유일한 자글자글이다. 미세 어파인 세 축이 2프레임마다 툭툭 바뀐다.
 */
const boilStep: MotionPreset = {
  id: 'boil.step',
  label: '2컷 스텝',
  hint: '두 프레임마다 한 컷씩 넘어가 스톱모션처럼 보인다.',
  category: 'boil',
  tags: ['boil', 'move', 'rotate', 'scale'],
  loopSafe: 'seamless',
  overscan: 'required',
  easy: false,
  size: 'light',
  defaultDurationMs: 500,
  noiseHoldFrames: 2,
  params: [
    { key: 'shift', label: '흔들리는 정도', type: 'number', min: 0.5, max: 6, step: 0.5, unit: 'px', default: 1 },
    { key: 'tilt', label: '기울림', type: 'number', min: 0, max: 3, step: 0.1, unit: '도', default: 0.3 },
    { key: 'hold', label: '몇 프레임마다', type: 'number', min: 2, max: 6, step: 1, unit: '프레임', default: 2 },
  ],
  emit(ctx): PresetEmission {
    const hold = clamp(Math.round(num(ctx.params, 'hold', 2)), 2, 6)
    const raw = resolveSpan(ctx, 500)
    const span = snapToHold(raw, hold)
    const gain = gainOf(ctx.strength)
    const px = clamp(num(ctx.params, 'shift', 1) * gain, 0.1, 10)
    const deg = clamp(num(ctx.params, 'tilt', 0.3) * gain, 0, 6)

    // 배율은 0.5% 다. 이보다 크면 스톱모션이 아니라 고장으로 보인다.
    const modifiers = affineJitter('mo.bs', hold, 4, px, deg, 0.005 * gain)

    return {
      tracks: [],
      modifiers,
      durationFrames: emitDuration(span, []),
      suggestedLoop: loopFor('seamless'),
      notices: snapNotice(raw, span, hold),
    }
  },
}

/*
 * 이펙트 배선 요약 (실제로 emit 하는 것).
 *
 *   boil.hand  : boil.warp { amp, scale 0.006, swirl 0.5, octaves 2, states, hold }
 *   boil.fine  : boil.warp { amp, scale 0.012~0.045, swirl 0.2, octaves 2, states 5, hold }
 *   boil.edge  : boil.edge { amp, source 0(자동), states 3, hold }
 *   boil.paper : boil.warp + fx.paper + fx.grain, 셋 다 holdFrames = hold
 *   boil.step  : 없음. 홀드 클럭만으로 완성이라 effects 필드를 내지 않는다.
 *
 * 파라미터 key 는 effects/atoms 카탈로그의 EffectDef.params 와 1:1 이다. 없는 key 는
 * 조용히 버려지므로 오타가 곧 "적용했는데 아무 일도 안 일어남" 이다. 테스트가
 * 레지스트리와 직접 대조한다 (tests/unit/motionsFGHI.test.ts).
 */

export const BOIL_PRESETS: MotionPreset[] = [boilHand, boilFine, boilEdge, boilPaper, boilStep]
