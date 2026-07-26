/**
 * F. 흔들기. 6종 전부.
 *
 * A~E 와 결정적으로 다른 점이 하나 있다. **흔들기는 키프레임을 내지 않는다.**
 * 흔들림을 키로 찍으면 두 가지가 동시에 망가진다.
 *   1. 25fps 800ms 짜리 흔들림 하나가 키를 20개 넘게 만든다. 그래프 에디터가 못 쓰게 된다.
 *   2. 사용자가 위치를 잡아 둔 레이어에 프리셋을 걸면 그 위치가 0 으로 덮인다.
 * 그래서 흔들기는 Modifier 만 낸다. 모디파이어는 트랙 결합이 끝난 값 **위에** 더해지므로
 * 사용자가 잡아 둔 위치와 다른 프리셋의 움직임이 그대로 살아 있다 (evaluate.ts 의 결합 순서).
 *
 * 이음새 없는 루프의 근거는 두 가지다.
 *   - loopNoise 는 원 경로 샘플링이라 t=0 과 t=1 이 같은 점이다 (generators.fbmLoop).
 *   - sine 은 cycles 를 정수로 강제하면 값도 기울기도 이어진다.
 * 엔벨로프까지 닫혀 있어야 하므로 심리스 프리셋은 감쇠가 아니라 **부풀었다 잦아드는**
 * 포락선을 쓴다. 1회 재생인 shake.impact 만 0 으로 떨어지는 감쇠를 쓴다.
 * 감쇠 없는 등진폭 흔들림은 즉시 싸구려로 보인다.
 */

import {
  FRAMES_MAX,
  type CompositeOp,
  type Keyframe,
  type Modifier,
  type ModifierTarget,
  type ModifierType,
} from '@/core/types.ts'
import type { MotionPreset, PresetEmission } from '@/motions/types.ts'
import { buildKeys, clamp, clamp01, emitDuration, gainOf, lastFrame, loopFor, num, resolveSpan } from './shared.ts'

// ---------------------------------------------------------------------------
// 공용 헬퍼 (G, H, I 카테고리도 그대로 쓴다)
// ---------------------------------------------------------------------------

export interface ModifierInit {
  /** 한 프리셋 안에서 유일해야 한다. 생성기가 이 id 로 노이즈를 다시 섞는다. */
  id: string
  type: ModifierType
  target: ModifierTarget
  amplitude: number
  /** sine 은 정수 주기, loopNoise 는 노이즈 반지름으로 쓴다. */
  cycles: number
  seed?: number
  octaves?: number
  persistence?: number
  lacunarity?: number
  holdFrames?: number
  decay?: number
  blendOp?: CompositeOp
  envelope?: Keyframe[]
}

/**
 * Modifier 는 필수 필드가 많다. 프리셋마다 12개를 적으면 값이 아니라 잡음이 보인다.
 * 기본값은 "부드러운 2옥타브 노이즈, 홀드 없음, 더하기 합성" 이다.
 */
export function makeModifier(init: ModifierInit): Modifier {
  const m: Modifier = {
    id: init.id,
    type: init.type,
    target: init.target,
    blendOp: init.blendOp ?? 'add',
    seed: init.seed ?? 1,
    amplitude: init.amplitude,
    cycles: init.cycles,
    octaves: init.octaves ?? 2,
    persistence: init.persistence ?? 0.5,
    lacunarity: init.lacunarity ?? 2,
    holdFrames: Math.max(1, Math.round(init.holdFrames ?? 1)),
    decay: init.decay ?? 6,
  }
  if (init.envelope && init.envelope.length > 0) m.envelope = init.envelope
  return m
}

/**
 * 닫힌 포락선. low 에서 시작해 가운데서 1 이 되고 다시 low 로 돌아온다.
 *
 * 흔들림의 세기가 한 주기 안에서 부풀었다 잦아든다. 값이 시작으로 돌아오므로
 * 무한 반복에서도 이음새가 생기지 않는다. 감쇠(1 -> 0)를 심리스 프리셋에 쓰면
 * 매 사이클 시작에서 진폭이 툭 살아나 그 지점이 그대로 이음새로 보인다.
 */
export function swellEnvelope(span: number, low: number): Keyframe[] {
  const lo = clamp01(low)
  const mid = Math.max(1, Math.round(span / 2))
  return buildKeys([{ f: 0, v: lo }, { f: mid, v: 1 }, { f: span, v: lo }], 'easeInOutCubic')
}

/** 1회 재생용 감쇠 포락선. 충격 직후가 가장 크고 끝에서 0 이다. */
export function decayEnvelope(span: number): Keyframe[] {
  return buildKeys([{ f: 0, v: 1 }, { f: Math.max(1, span), v: 0 }], 'easeOutExpo')
}

/**
 * 지속 프레임을 홀드의 배수로 맞춘다.
 *
 * effFrame = floor(frame/hold)*hold 이므로 totalFrames % holdFrames != 0 이면
 * 마지막 홀드 블록만 짧게 잘린다. 그 한 칸에서 노이즈 위상이 튀고, 그게 정확히
 * 루프가 끊기는 지점이 된다. 길이를 맞추는 편이 홀드를 바꾸는 것보다 티가 덜 난다.
 */
export function snapToHold(span: number, holdFrames: number): number {
  const hold = Math.max(1, Math.round(holdFrames))
  const raw = Math.round(span)
  if (hold <= 1) return clamp(raw, 2, FRAMES_MAX)
  const maxBlocks = Math.max(2, Math.floor(FRAMES_MAX / hold))
  const blocks = clamp(Math.round(raw / hold), 2, maxBlocks)
  return blocks * hold
}

/**
 * 모디파이어 시드.
 * Math.random 을 쓰면 같은 문서가 열 때마다 다르게 흔들린다.
 * 축마다 다른 상수를 주어 x 와 y 가 같은 곡선을 그리지 않게만 한다.
 */
export function axisSeed(index: number): number {
  return 101 + index * 8191
}

// ---------------------------------------------------------------------------
// F1. 카메라 흔들림
// ---------------------------------------------------------------------------

/**
 * 손에 든 카메라가 미세하게 떠는 느낌.
 * x, y, 회전 세 축에 서로 다른 시드의 원 경로 노이즈를 건다. 세 축이 독립이라
 * 규칙이 읽히지 않고, 각 축은 원 경로라 한 바퀴가 정확히 닫힌다.
 */
const shakeCamera: MotionPreset = {
  id: 'shake.camera',
  label: '카메라 흔들림',
  hint: '손에 든 카메라처럼 화면 전체가 자잘하게 떨린다.',
  category: 'shake',
  tags: ['move', 'rotate', 'shake'],
  loopSafe: 'seamless',
  overscan: 'required',
  easy: true,
  size: 'light',
  defaultDurationMs: 800,
  params: [
    { key: 'amount', label: '흔들리는 정도', type: 'number', min: 1, max: 30, step: 0.5, unit: 'px', default: 6 },
    { key: 'tilt', label: '기울림', type: 'number', min: 0, max: 5, step: 0.1, unit: '도', default: 0.8 },
    { key: 'cycles', label: '흔들림 빠르기', type: 'number', min: 1, max: 8, step: 1, unit: '단계', default: 4 },
  ],
  emit(ctx): PresetEmission {
    const span = resolveSpan(ctx, 800)
    const gain = gainOf(ctx.strength)
    const amp = clamp(num(ctx.params, 'amount', 6) * gain, 0.2, 60)
    const tilt = clamp(num(ctx.params, 'tilt', 0.8) * gain, 0, 12)
    const cycles = clamp(num(ctx.params, 'cycles', 4), 1, 8)
    const envelope = swellEnvelope(span, 0.45)

    const modifiers: Modifier[] = [
      makeModifier({ id: 'mo.cam.x', type: 'loopNoise', target: 'translateX', amplitude: amp, cycles, seed: axisSeed(0), envelope }),
      makeModifier({ id: 'mo.cam.y', type: 'loopNoise', target: 'translateY', amplitude: amp * 0.85, cycles, seed: axisSeed(1), envelope }),
      makeModifier({ id: 'mo.cam.r', type: 'loopNoise', target: 'rotate', amplitude: tilt, cycles, seed: axisSeed(2), envelope }),
    ]

    return { tracks: [], modifiers, durationFrames: emitDuration(span, []), suggestedLoop: loopFor('seamless') }
  },
}

// ---------------------------------------------------------------------------
// F2. 자글자글 떨림
// ---------------------------------------------------------------------------

/**
 * 카메라 흔들림에 홀드 클럭을 물린 것.
 * 값 자체는 같은 원 경로 노이즈인데 2프레임마다만 새로 뽑는다. 그 계단이
 * "부드럽게 흔들리는" 과 "자글자글 떠는" 을 가른다.
 */
const shakeJitter: MotionPreset = {
  id: 'shake.jitter',
  label: '자글자글 떨림',
  hint: '몇 프레임마다 툭툭 끊기며 잘게 떤다.',
  category: 'shake',
  tags: ['move', 'rotate', 'shake'],
  loopSafe: 'seamless',
  overscan: 'required',
  easy: true,
  size: 'light',
  defaultDurationMs: 600,
  noiseHoldFrames: 2,
  params: [
    { key: 'amount', label: '떨리는 정도', type: 'number', min: 0.5, max: 12, step: 0.5, unit: 'px', default: 2.5 },
    { key: 'tilt', label: '기울림', type: 'number', min: 0, max: 3, step: 0.1, unit: '도', default: 0.4 },
    { key: 'hold', label: '몇 프레임마다', type: 'number', min: 1, max: 4, step: 1, unit: '프레임', default: 2 },
  ],
  emit(ctx): PresetEmission {
    const hold = clamp(Math.round(num(ctx.params, 'hold', 2)), 1, 4)
    const span = snapToHold(resolveSpan(ctx, 600), hold)
    const gain = gainOf(ctx.strength)
    const amp = clamp(num(ctx.params, 'amount', 2.5) * gain, 0.2, 24)
    const tilt = clamp(num(ctx.params, 'tilt', 0.4) * gain, 0, 8)
    const envelope = swellEnvelope(span, 0.5)

    const modifiers: Modifier[] = [
      makeModifier({ id: 'mo.jit.x', type: 'loopNoise', target: 'translateX', amplitude: amp, cycles: 6, holdFrames: hold, seed: axisSeed(3), envelope }),
      makeModifier({ id: 'mo.jit.y', type: 'loopNoise', target: 'translateY', amplitude: amp, cycles: 6, holdFrames: hold, seed: axisSeed(4), envelope }),
      makeModifier({ id: 'mo.jit.r', type: 'loopNoise', target: 'rotate', amplitude: tilt, cycles: 6, holdFrames: hold, seed: axisSeed(5), envelope }),
    ]

    return { tracks: [], modifiers, durationFrames: emitDuration(span, []), suggestedLoop: loopFor('seamless') }
  },
}

// ---------------------------------------------------------------------------
// F3. 크게 흔들
// ---------------------------------------------------------------------------

/**
 * 큰 폭으로 느리게 흔든다.
 *
 * x, y 에 90도 위상차를 준다. 원 궤도가 되어 가장 자연스럽다.
 * 그런데 Modifier 어휘에 위상 필드가 없다. sine 은 sin(2*pi*cycles*t) 하나뿐이라
 * 위상을 넣을 자리가 없고, 그걸 넣으려면 core/types.ts 의 Modifier 를 고쳐야 한다.
 *
 * 그래서 주기비 1:2 를 쓴다. x 가 한 번 오갈 때 y 가 두 번 오가면 궤적이 8자가 된다.
 * 두 주기 모두 정수라 이음새는 그대로 닫히고, 원 궤도보다 오히려 크게 흔들리는
 * 것으로 읽힌다. 위상 필드가 생기면 이 프리셋만 바꾸면 된다.
 */
const shakeWobble: MotionPreset = {
  id: 'shake.wobble',
  label: '크게 흔들',
  hint: '느리고 큰 폭으로 8자를 그리며 흔들린다.',
  category: 'shake',
  tags: ['move', 'rotate', 'shake'],
  loopSafe: 'seamless',
  overscan: 'required',
  easy: false,
  size: 'light',
  defaultDurationMs: 1600,
  params: [
    { key: 'amount', label: '흔들리는 정도', type: 'number', min: 2, max: 40, step: 1, unit: 'px', default: 10 },
    { key: 'tilt', label: '기울림', type: 'number', min: 0, max: 10, step: 0.5, unit: '도', default: 2 },
    { key: 'cycles', label: '왕복 횟수', type: 'number', min: 1, max: 4, step: 1, unit: '회', default: 1 },
  ],
  emit(ctx): PresetEmission {
    const span = resolveSpan(ctx, 1600)
    const gain = gainOf(ctx.strength)
    const amp = clamp(num(ctx.params, 'amount', 10) * gain, 0.5, 80)
    const tilt = clamp(num(ctx.params, 'tilt', 2) * gain, 0, 20)
    // 정수여야 t=0 과 t=1 의 값과 기울기가 함께 맞는다.
    const cycles = clamp(Math.round(num(ctx.params, 'cycles', 1)), 1, 4)
    const envelope = swellEnvelope(span, 0.6)

    const modifiers: Modifier[] = [
      makeModifier({ id: 'mo.wob.x', type: 'sine', target: 'translateX', amplitude: amp, cycles, envelope }),
      makeModifier({ id: 'mo.wob.y', type: 'sine', target: 'translateY', amplitude: amp * 0.6, cycles: cycles * 2, envelope }),
      makeModifier({ id: 'mo.wob.r', type: 'sine', target: 'rotate', amplitude: tilt, cycles, envelope }),
    ]

    return { tracks: [], modifiers, durationFrames: emitDuration(span, []), suggestedLoop: loopFor('seamless') }
  },
}

// ---------------------------------------------------------------------------
// F4. 손으로 든 느낌
// ---------------------------------------------------------------------------

/**
 * 저주파 큰 흔들림 위에 고주파 잔떨림을 얹는다.
 * 사람 손의 흔들림은 한 가지 주파수가 아니다. 큰 것만 있으면 배가 흔들리는 것 같고,
 * 작은 것만 있으면 기계가 떠는 것 같다. 둘을 겹쳐야 사람 손으로 읽힌다.
 */
const shakeHandheld: MotionPreset = {
  id: 'shake.handheld',
  label: '손으로 든 느낌',
  hint: '크게 흐르는 흔들림 위에 잔떨림이 겹친다.',
  category: 'shake',
  tags: ['move', 'rotate', 'shake'],
  loopSafe: 'seamless',
  overscan: 'required',
  easy: false,
  size: 'normal',
  defaultDurationMs: 2400,
  params: [
    { key: 'low', label: '크게 흐르는 정도', type: 'number', min: 1, max: 30, step: 0.5, unit: 'px', default: 8 },
    { key: 'high', label: '잔떨림 정도', type: 'number', min: 0, max: 8, step: 0.5, unit: 'px', default: 1.5 },
    { key: 'tilt', label: '기울림', type: 'number', min: 0, max: 4, step: 0.1, unit: '도', default: 0.6 },
  ],
  emit(ctx): PresetEmission {
    const span = resolveSpan(ctx, 2400)
    const gain = gainOf(ctx.strength)
    const low = clamp(num(ctx.params, 'low', 8) * gain, 0.2, 60)
    const high = clamp(num(ctx.params, 'high', 1.5) * gain, 0, 16)
    const tilt = clamp(num(ctx.params, 'tilt', 0.6) * gain, 0, 10)
    const envelope = swellEnvelope(span, 0.55)

    const modifiers: Modifier[] = [
      makeModifier({ id: 'mo.hh.lx', type: 'loopNoise', target: 'translateX', amplitude: low, cycles: 1, octaves: 2, seed: axisSeed(6), envelope }),
      makeModifier({ id: 'mo.hh.ly', type: 'loopNoise', target: 'translateY', amplitude: low * 0.8, cycles: 1, octaves: 2, seed: axisSeed(7), envelope }),
      makeModifier({ id: 'mo.hh.hx', type: 'loopNoise', target: 'translateX', amplitude: high, cycles: 6, octaves: 1, seed: axisSeed(8), envelope }),
      makeModifier({ id: 'mo.hh.hy', type: 'loopNoise', target: 'translateY', amplitude: high, cycles: 6, octaves: 1, seed: axisSeed(9), envelope }),
      makeModifier({ id: 'mo.hh.r', type: 'loopNoise', target: 'rotate', amplitude: tilt, cycles: 2, seed: axisSeed(10), envelope }),
    ]

    return { tracks: [], modifiers, durationFrames: emitDuration(span, []), suggestedLoop: loopFor('seamless') }
  },
}

// ---------------------------------------------------------------------------
// F5. 쿵 충격
// ---------------------------------------------------------------------------

/**
 * 한 번 세게 맞고 잦아든다.
 *
 * 노리는 식은 sine * exp(-decay * t) 다. sine 모디파이어에 감쇠 포락선을 걸어
 * 같은 모양을 만든다. eventBurst 타입을 쓸 수도 있지만 그쪽은 사건을 균등 배치해
 * 여러 번 때리는 모양이라 "한 방" 이 아니다.
 *
 * x 와 y 의 진동 수를 다르게 두어 대각선으로만 흔들리는 것을 피한다.
 */
const shakeImpact: MotionPreset = {
  id: 'shake.impact',
  label: '쿵 충격',
  hint: '한 번 세게 흔들린 뒤 빠르게 잦아든다.',
  category: 'shake',
  tags: ['move', 'rotate', 'shake'],
  loopSafe: 'once',
  overscan: 'required',
  easy: false,
  size: 'light',
  defaultDurationMs: 500,
  params: [
    { key: 'amount', label: '충격 크기', type: 'number', min: 4, max: 60, step: 1, unit: 'px', default: 20 },
    { key: 'cycles', label: '진동 횟수', type: 'number', min: 2, max: 10, step: 1, unit: '회', default: 5 },
    { key: 'tilt', label: '기울림', type: 'number', min: 0, max: 8, step: 0.5, unit: '도', default: 1.5 },
  ],
  emit(ctx): PresetEmission {
    const span = resolveSpan(ctx, 500)
    const end = lastFrame(span, 'once')
    const gain = gainOf(ctx.strength)
    const amp = clamp(num(ctx.params, 'amount', 20) * gain, 1, 120)
    const tilt = clamp(num(ctx.params, 'tilt', 1.5) * gain, 0, 16)
    const cycles = clamp(Math.round(num(ctx.params, 'cycles', 5)), 2, 10)
    const envelope = decayEnvelope(end)

    const modifiers: Modifier[] = [
      makeModifier({ id: 'mo.imp.y', type: 'sine', target: 'translateY', amplitude: amp, cycles, envelope }),
      makeModifier({ id: 'mo.imp.x', type: 'sine', target: 'translateX', amplitude: amp * 0.5, cycles: cycles + 1, envelope }),
      makeModifier({ id: 'mo.imp.r', type: 'sine', target: 'rotate', amplitude: tilt, cycles, envelope }),
    ]

    return { tracks: [], modifiers, durationFrames: emitDuration(span, []), suggestedLoop: loopFor('once') }
  },
}

// ---------------------------------------------------------------------------
// F6. 숨쉬기
// ---------------------------------------------------------------------------

/**
 * 아주 느린 상하 이동 + 같은 위상의 미세한 확대.
 * 두 축이 같은 위상이어야 "부푼다" 로 읽힌다. 위상이 어긋나면 그냥 떠다니는 것이 된다.
 *
 * 오버스캔 정책을 "자동" 으로 두고 싶지만, 3px 이동과 배율 -0.02 가 함께 있으면
 * 캔버스를 채우는 레이어에서 가장자리가 그만큼 빈다. 솔버가 1.5% 쯤 보정하면 끝나는
 * 문제라 정직하게 required 로 둔다.
 */
const shakeBreathe: MotionPreset = {
  id: 'shake.breathe',
  label: '숨쉬기',
  hint: '숨을 쉬듯 아주 느리게 부풀었다 가라앉는다.',
  category: 'shake',
  tags: ['move', 'scale', 'shake'],
  loopSafe: 'seamless',
  overscan: 'required',
  easy: false,
  size: 'light',
  defaultDurationMs: 3600,
  params: [
    { key: 'amount', label: '오르내리는 정도', type: 'number', min: 0.5, max: 12, step: 0.5, unit: 'px', default: 3 },
    { key: 'swell', label: '부푸는 정도', type: 'number', min: 0, max: 8, step: 0.5, unit: '%', default: 2 },
    { key: 'cycles', label: '호흡 횟수', type: 'number', min: 1, max: 4, step: 1, unit: '회', default: 1 },
  ],
  emit(ctx): PresetEmission {
    const span = resolveSpan(ctx, 3600)
    const gain = gainOf(ctx.strength)
    const amp = clamp(num(ctx.params, 'amount', 3) * gain, 0.2, 20)
    const swell = clamp(num(ctx.params, 'swell', 2) * gain, 0, 12) / 100
    const cycles = clamp(Math.round(num(ctx.params, 'cycles', 1)), 1, 4)
    const envelope = swellEnvelope(span, 0.8)

    const modifiers: Modifier[] = [
      makeModifier({ id: 'mo.brt.y', type: 'sine', target: 'translateY', amplitude: -amp, cycles, envelope }),
      makeModifier({ id: 'mo.brt.s', type: 'sine', target: 'scale', amplitude: swell, cycles, envelope }),
    ]

    return { tracks: [], modifiers, durationFrames: emitDuration(span, []), suggestedLoop: loopFor('seamless') }
  },
}

export const SHAKE_PRESETS: MotionPreset[] = [
  shakeCamera,
  shakeJitter,
  shakeWobble,
  shakeHandheld,
  shakeImpact,
  shakeBreathe,
]
