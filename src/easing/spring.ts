/**
 * 스프링 이징.
 *
 * 감쇠비 zeta 로 세 가지 해가 갈린다. 수치 적분 대신 해석해를 쓴다.
 * 프레임 순서와 무관하게 같은 t 에서 같은 값이 나와야 하기 때문이다
 * 결정론 계약상 프레임 간 캐리오버 상태를 두지 않는다.
 */

import type { SpringSpec } from '@/core/types.ts'

export interface SpringParams {
  stiffness: number
  damping: number
  mass: number
  /** 초기 속도 */
  velocity: number
  from: number
  to: number
}

/** 정착 판정 임계. env 기준과 실측 기준 둘 다 쓴다. */
const SETTLE_EPS = 0.001
const SETTLE_VELOCITY_EPS = 0.01
const PROBE_DT = 1 / 240
const PROBE_HOLD_FRAMES = 8
const MAX_SETTLE_SEC = 10

/**
 * 시각 파라미터(체감 시간 + 탄성)를 물리 파라미터로 바꾼다.
 * bounce = 1 - zeta 이므로 bounce 0 이 임계 감쇠다.
 */
export function visualToPhysical(visualDuration: number, bounce: number, mass = 1): {
  stiffness: number
  damping: number
  mass: number
} {
  const duration = Math.max(0.01, visualDuration)
  const root = (2 * Math.PI) / (duration * 1.2)
  const stiffness = root * root * mass
  const zeta = Math.min(1, Math.max(0.05, 1 - bounce))
  const damping = 2 * zeta * Math.sqrt(stiffness * mass)
  return { stiffness, damping, mass }
}

export function springFromSpec(spec: SpringSpec): SpringParams {
  const base =
    spec.mode === 'visual'
      ? visualToPhysical(spec.visualDuration, spec.bounce, spec.mass)
      : { stiffness: spec.stiffness, damping: spec.damping, mass: spec.mass }
  return { ...base, velocity: 0, from: 0, to: 1 }
}

/** 감쇠비 */
export function dampingRatio(p: Pick<SpringParams, 'stiffness' | 'damping' | 'mass'>): number {
  return p.damping / (2 * Math.sqrt(p.stiffness * p.mass))
}

/**
 * 시각 t(초)에서의 변위. 감쇠비에 따라 세 분기로 갈린다.
 */
export function springValueAt(p: SpringParams, t: number): number {
  if (t <= 0) return p.from
  const omega0 = Math.sqrt(p.stiffness / p.mass)
  const zeta = dampingRatio(p)
  const delta = p.to - p.from
  const v0 = p.velocity

  if (Math.abs(zeta - 1) < 1e-6) {
    // 임계 감쇠
    const e = Math.exp(-omega0 * t)
    return p.to - e * (delta + (v0 + omega0 * delta) * t)
  }

  if (zeta < 1) {
    // 감쇠 진동. 오버슈트가 생기는 구간이다.
    const omegaD = omega0 * Math.sqrt(1 - zeta * zeta)
    const e = Math.exp(-zeta * omega0 * t)
    return (
      p.to -
      e * (((v0 + zeta * omega0 * delta) / omegaD) * Math.sin(omegaD * t) + delta * Math.cos(omegaD * t))
    )
  }

  // 과감쇠. sinh/cosh 가 t 가 커지면 폭주하므로 지수부를 클램프한다.
  const omegaD = omega0 * Math.sqrt(zeta * zeta - 1)
  const f = Math.min(omegaD * t, 300)
  const e = Math.exp(-zeta * omega0 * t)
  return p.to - (e * ((v0 + zeta * omega0 * delta) * Math.sinh(f) + omegaD * delta * Math.cosh(f))) / omegaD
}

export function springVelocityAt(p: SpringParams, t: number, dt = 1e-4): number {
  return (springValueAt(p, t + dt) - springValueAt(p, t)) / dt
}

/**
 * 정착 시간. 포락선 기준과 실측 기준 중 작은 쪽을 쓴다.
 * 포락선만 쓰면 진동이 끝났는데도 꼬리를 길게 잡고,
 * 실측만 쓰면 영점 교차에서 우연히 조건이 맞아 너무 일찍 끊는다.
 */
export function settleTime(p: SpringParams): number {
  const omega0 = Math.sqrt(p.stiffness / p.mass)
  const zeta = dampingRatio(p)

  const tEnv = zeta > 0 ? -Math.log(SETTLE_EPS) / (zeta * omega0) : MAX_SETTLE_SEC
  const limit = Math.min(MAX_SETTLE_SEC, Math.max(tEnv, 0.05))

  let hold = 0
  let tProbe = limit
  for (let t = 0; t <= limit; t += PROBE_DT) {
    const x = springValueAt(p, t)
    const v = springVelocityAt(p, t)
    if (Math.abs(x - p.to) < SETTLE_EPS && Math.abs(v) < SETTLE_VELOCITY_EPS) {
      hold += 1
      if (hold >= PROBE_HOLD_FRAMES) {
        tProbe = t
        break
      }
    } else {
      hold = 0
    }
  }

  return Math.min(tEnv, tProbe, MAX_SETTLE_SEC)
}

export interface SpringEasing {
  (p: number): number
  /** 이 스프링이 자연스럽게 정착하는 데 걸리는 시간(초) */
  readonly settleSec: number
}

/**
 * 스프링을 [0,1] -> 실수 이징으로 굽는다.
 *
 * 끝점은 비례 스케일링이 아니라 하드 설정이다. 전체를 스케일하면
 * 오버슈트 비율까지 같이 왜곡된다.
 */
export function createSpringEasing(spec: SpringSpec): SpringEasing {
  const p = springFromSpec(spec)
  const settle = settleTime(p)

  const fn = ((x: number): number => {
    if (x <= 0) return 0
    if (x >= 1) return 1
    return springValueAt(p, x * settle)
  }) as { (x: number): number; settleSec?: number }

  fn.settleSec = settle
  return fn as SpringEasing
}

/**
 * 스프링 이징 캐시.
 *
 * settleTime 은 최대 2400회 적분 루프를 돌고 회당 springValueAt 을 세 번 부른다.
 * 캐시 없이 evalSegment 안에서 매번 만들면 베지어 대비 80배 넘게 느려진다.
 * 24프레임 x 트랙 여러 개면 재생이 눈에 띄게 끊긴다.
 */
const SPRING_CACHE_CAPACITY = 32
const springCache = new Map<string, SpringEasing>()

function springKey(spec: SpringSpec): string {
  return spec.mode === 'visual'
    ? `v:${spec.visualDuration},${spec.bounce},${spec.mass},${spec.fit}`
    : `p:${spec.stiffness},${spec.damping},${spec.mass},${spec.fit}`
}

export function getSpringEasing(spec: SpringSpec): SpringEasing {
  const key = springKey(spec)
  const hit = springCache.get(key)
  if (hit) {
    springCache.delete(key)
    springCache.set(key, hit)
    return hit
  }
  const created = createSpringEasing(spec)
  springCache.set(key, created)
  if (springCache.size > SPRING_CACHE_CAPACITY) {
    const oldest = springCache.keys().next().value
    if (oldest !== undefined) springCache.delete(oldest)
  }
  return created
}

/**
 * fitToDuration: 지속시간 D 에 맞춰 스프링을 다시 조율한다.
 * zeta 가 보존되므로 오버슈트 비율은 그대로고 속도만 바뀐다.
 */
export function fitSpringToDuration(spec: SpringSpec, durationSec: number): SpringSpec {
  if (durationSec <= 0) return spec
  const p = springFromSpec(spec)
  const settle = settleTime(p)
  if (settle <= 0) return spec

  const zeta = dampingRatio(p)
  const omega0 = Math.sqrt(p.stiffness / p.mass)
  const omegaNew = omega0 * (settle / durationSec)
  const stiffness = omegaNew * omegaNew * p.mass
  const damping = 2 * zeta * Math.sqrt(stiffness * p.mass)

  return { ...spec, mode: 'physical', stiffness, damping, mass: p.mass }
}
