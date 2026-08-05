/**
 * 절차형 모디파이어 생성기.
 *
 * 흔들림과 자글자글은 키프레임으로 찍을 수 없다. 반대로 등장 모션을 절차형으로 만들면
 * 다듬을 수 없다. 그래서 문서 모델이 둘을 나눠 갖는다.
 *
 * 두 가지가 이 파일의 전부다.
 *
 * 1. 결정론. 같은 (seed, frame) 이면 언제나 같은 값이다. 프레임 간 누산이 없어
 *    무작위 순서로 seek 해도 결과가 같다.
 * 2. 심리스 루프. 노이즈를 원 경로로 샘플링하고 sine 은 정수 주기를 강제한다.
 *    t=0 과 t=1 이 같은 값, 같은 기울기여야 무한 반복에서 이음새가 안 보인다.
 *
 * 외부 노이즈 라이브러리를 쓰지 않는다. 원 경로 샘플링이 필요한데 그 래핑 성질은
 * 구현에 의존하므로, 직접 만든 값 노이즈로 성질을 보장하는 편이 확실하다.
 */

import type { Modifier } from '@/core/types.ts'
import { effectiveFrame, hashSeed } from '@/core/rng.ts'
import { evalTrack } from '@/easing/curve.ts'

/** 정수 격자점의 의사난수. [-1, 1] */
function gradient2(seed: number, ix: number, iy: number): number {
  let h = (seed ^ Math.imul(ix, 0x27d4eb2d) ^ Math.imul(iy, 0x165667b1)) >>> 0
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39) >>> 0
  h ^= h >>> 15
  return (h >>> 0) / 2147483648 - 1
}

/** 5차 스무스스텝. 2차 도함수까지 연속이라 이음새에서 기울기가 튀지 않는다. */
function smootherstep(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10)
}

/** 2D 값 노이즈. [-1, 1] */
function valueNoise2(seed: number, x: number, y: number): number {
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const fx = smootherstep(x - x0)
  const fy = smootherstep(y - y0)

  const n00 = gradient2(seed, x0, y0)
  const n10 = gradient2(seed, x0 + 1, y0)
  const n01 = gradient2(seed, x0, y0 + 1)
  const n11 = gradient2(seed, x0 + 1, y0 + 1)

  const a = n00 + (n10 - n00) * fx
  const b = n01 + (n11 - n01) * fx
  return a + (b - a) * fy
}

/**
 * 원 경로 노이즈. t 는 [0,1) 이고 t=0 과 t=1 이 정확히 같은 점을 가리킨다.
 * 반지름이 곧 특성 주파수다. 크면 한 바퀴 도는 동안 더 많은 굴곡을 지난다.
 */
function loopNoise1(seed: number, t: number, radius: number): number {
  const a = t * Math.PI * 2
  return valueNoise2(seed, Math.cos(a) * radius + 128.5, Math.sin(a) * radius + 128.5)
}

/** 옥타브를 겹친다. 반환값은 [-1, 1] 근처로 정규화된다. */
export function fbmLoop(
  seed: number,
  t: number,
  octaves: number,
  persistence: number,
  lacunarity: number,
  baseRadius = 2,
): number {
  let sum = 0
  let amp = 1
  let norm = 0
  let radius = baseRadius
  const n = Math.max(1, Math.min(4, Math.floor(octaves)))

  for (let i = 0; i < n; i += 1) {
    sum += loopNoise1(seed + i * 0x9e37, t, radius) * amp
    norm += amp
    amp *= persistence
    radius *= lacunarity
  }
  return norm > 0 ? sum / norm : 0
}

/**
 * spring 임펄스가 실제로 내는 최대 절댓값. 진폭 1 기준이다.
 *
 * 파형은 sin(2πp)·e^(-d·p) 이고 봉우리는 도함수가 0 인 곳,
 * 즉 tan(2πp) = 2π/d 를 푼 p* 에 있다. 감쇠가 셀수록 봉우리가 앞으로 당겨지면서
 * 낮아진다. d=10 이면 0.22 까지 내려간다.
 *
 * 이 값이 필요한 데는 두 곳이고 둘 다 같은 이유다. 타격 프리셋은 "28px 만큼
 * 밀린다" 를 약속하므로 진폭을 이 값으로 나눠 심어야 하고, 담기 솔버는 그렇게
 * 심은 진폭이 실제로는 그만큼 움직이지 않는다는 것을 알아야 한다. 한쪽만 알면
 * 화면이 약속보다 덜 움직이거나 그림이 이유 없이 작아진다.
 */
export function springPeak(decay: number): number {
  const d = Math.max(0.001, decay || 4)
  const p = Math.atan((Math.PI * 2) / d) / (Math.PI * 2)
  return Math.sin(p * Math.PI * 2) * Math.exp(-d * p)
}

export interface GeneratorContext {
  /** 정수 프레임 인덱스 */
  frame: number
  durationFrames: number
  /** 프로젝트 시드. 문서마다 다른 흔들림을 만든다. */
  projectSeed: number
  /** 모디파이어가 속한 노드 id. 같은 프레임에서도 모디파이어마다 다른 값이 나오게 한다. */
  nodeId: string
}

/**
 * 모디파이어 한 개의 값.
 * 반환값은 amplitude 가 곱해진 최종 값이고, blendOp 적용은 호출자가 한다.
 */
export function evalModifier(m: Modifier, ctx: GeneratorContext): number {
  const duration = Math.max(1, ctx.durationFrames)

  // 홀드 클럭. 자글자글이 2컷, 3컷으로 잡히는 근거다.
  const frame = effectiveFrame(ctx.frame, m.holdFrames)
  const t = (frame % duration) / duration

  const seed = hashSeed(ctx.projectSeed ^ m.seed, `${ctx.nodeId}:${m.id}`, 0)

  let raw: number
  switch (m.type) {
    case 'sine': {
      // 정수 주기여야 t=0 과 t=1 이 같은 값, 같은 기울기가 된다.
      const cycles = Math.max(1, Math.round(m.cycles))
      raw = Math.sin(t * Math.PI * 2 * cycles)
      break
    }

    case 'loopNoise': {
      const cycles = Math.max(0.25, m.cycles)
      raw = fbmLoop(seed, t, m.octaves, m.persistence, m.lacunarity, cycles)
      break
    }

    case 'eventBurst': {
      // 충격 후 감쇠. 사이클 수만큼 균등 배치하고 각 사건에서 지수 감쇠한다.
      const events = Math.max(1, Math.round(m.cycles))
      const decay = Math.max(0.001, m.decay || 6)
      let sum = 0
      for (let i = 0; i < events; i += 1) {
        // 이전 주기에서 넘어온 꼬리까지 더해야 t=0 에서 이음새가 없다.
        for (const wrap of [-1, 0]) {
          const start = i / events + wrap
          const dt = t - start
          if (dt < 0) continue
          sum += Math.sin(dt * Math.PI * 2 * events * 2) * Math.exp(-decay * dt * events)
        }
      }
      raw = sum
      break
    }

    case 'spring': {
      // 임펄스 응답. 사이클마다 한 번 튕긴다.
      const cycles = Math.max(1, Math.round(m.cycles))
      const phase = (t * cycles) % 1
      const decay = Math.max(0.001, m.decay || 4)
      raw = Math.sin(phase * Math.PI * 2) * Math.exp(-decay * phase)
      break
    }

    case 'audioEnvelope':
    default:
      // v2 예약. 지금은 아무 값도 내지 않는다.
      return 0
  }

  let value = raw * m.amplitude

  // 엔벨로프는 강도를 시간에 따라 조절한다. 감쇠 없는 등진폭 흔들림은
  // 즉시 싸구려로 보인다.
  if (m.envelope && m.envelope.length > 0) {
    const env = evalTrack({ id: `${m.id}:env`, prop: 'opacity', unit: 'ratio', keys: m.envelope }, ctx.frame)
    if (env !== undefined) value *= env
  }

  return value
}

/**
 * 모디파이어가 낼 수 있는 이론적 최대 절대값.
 * 오버스캔 솔버가 실측 대신 이 상한을 쓴다. 시드를 바꿀 때마다 배율이 달라지면
 * 사용자 눈에는 이유 없이 그림 크기가 흔들리는 것으로 보인다.
 */
export function modifierPeak(m: Modifier): number {
  if (m.type === 'audioEnvelope') return 0

  // fbmLoop 은 가중 평균을 정규화하므로 옥타브 수와 무관하게 [-1,1] 을 넘지 않는다.
  // sine 도 마찬가지다. eventBurst 만 사건이 겹쳐 1 을 넘을 수 있다.
  //
  // 흔히 쓰는 amplitude * Σoctave 는 정규화하지 않는 fBm 을 전제한 식이다.
  // 여기 구현은 정규화하므로 그 식을 쓰면 필요 이상으로 크게 잡힌다.
  // 오버스캔을 과하게 잡으면 원본을 더 확대해 화질이 손해다.
  //
  // spring 은 반대로 1 에 한참 못 미친다. 감쇠가 봉우리를 깎기 때문이다. 1 로 잡으면
  // 타격 프리셋을 건 그림이 실제 필요보다 다섯 배쯤 작아진다 (springPeak 주석).
  const shape =
    m.type === 'eventBurst' ? 1.5 : m.type === 'spring' ? springPeak(m.decay) : 1

  // 엔벨로프가 1 을 넘으면 그만큼 더 커진다.
  let envPeak = 1
  if (m.envelope && m.envelope.length > 0) {
    envPeak = Math.max(1, ...m.envelope.map((k) => Math.abs(k.v)))
  }

  return Math.abs(m.amplitude) * shape * envPeak
}
