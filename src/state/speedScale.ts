/**
 * 속도 슬라이더의 눈금.
 *
 * 속도는 배수라서 슬라이더에 그대로 얹으면 안 된다. 0.1 ~ 2 를 선형으로 펴면
 * 트랙의 95% 가 "보통보다 느린" 구간에 들어가는 대신, 그 구간 안에서 한 칸이
 * 뜻하는 시간 차이가 자리마다 20배씩 달라진다. 손잡이를 왼쪽 끝 근처에서 1px
 * 움직이면 몇 초가 뛰고, 오른쪽에서는 아무 일도 안 일어난다.
 *
 * 로그 눈금이면 어디서든 한 칸이 같은 비율을 뜻한다. 미세 조정이 느린 쪽에서
 * 특히 필요하다는 요구가 이 선택의 이유다.
 *
 *   p = 0     -> 0.1배 (가장 느림)
 *   p = 0.769 -> 1배 (보통)
 *   p = 1     -> 2배 (가장 빠름)
 *
 * 진실은 speed 다. p 는 표시용 좌표일 뿐이라 저장하지 않는다. 저장된 프로젝트를
 * 열거나 PRO 에서 넘어올 때 손잡이 자리는 pFromSpeed 로 되찾는다.
 */

import { SPEED_MAX, SPEED_MIN } from '@/core/types.ts'

/** 슬라이더 한 칸. 1/200 이라 느린 쪽에서도 1% 단위로 잡힌다. */
export const SPEED_STEP = 0.005

const RATIO = SPEED_MAX / SPEED_MIN
const LOG_RATIO = Math.log(RATIO)

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

/** 슬라이더 위치 -> 속도 */
export function speedFromP(p: number): number {
  const t = clamp(Number.isFinite(p) ? p : 0, 0, 1)
  return SPEED_MIN * Math.exp(LOG_RATIO * t)
}

/**
 * 슬라이더 위치 -> 속도. 단, 1배 자리에 걸림쇠를 둔다.
 *
 * 1배는 눈금 위의 정확한 자리가 아니다(p = 0.7686...). 한 칸이 0.005 라 손잡이가
 * 아무리 가까이 가도 0.974 나 1.02 에서 멈춘다. 배수로 몇 퍼센트 차이는 눈에 안
 * 보이지만, "1배면 길이를 안 건드린다" 처럼 1을 경계로 삼는 규칙에서는 손잡이를
 * 가운데 둬도 규칙이 안 걸린다(도형 세트가 그렇다. shapes/shared.ts timingOf).
 *
 * 한 칸 안쪽이면 정확히 1로 붙인다. speedFromP 자체를 고치지는 않는다. 그쪽은
 * p 와 speed 를 왕복하는 순수 변환이라 스냅이 들어가면 왕복이 깨진다.
 */
export function speedFromPSnapped(p: number): number {
  const t = clamp(Number.isFinite(p) ? p : 0, 0, 1)
  // p 로 재고 speed 로 재지 않는다. speed 로 재면 exp/log 왕복 오차가 한 칸 경계에서
  // 걸림쇠를 놓친다.
  return Math.abs(t - pFromSpeed(1)) <= SPEED_STEP + 1e-9 ? 1 : speedFromP(t)
}

/** 속도 -> 슬라이더 위치 */
export function pFromSpeed(speed: number): number {
  if (!Number.isFinite(speed) || speed <= 0) return pFromSpeed(1)
  const s = clamp(speed, SPEED_MIN, SPEED_MAX)
  return clamp(Math.log(s / SPEED_MIN) / LOG_RATIO, 0, 1)
}

/**
 * 재생 시간을 사람이 읽는 문장으로.
 * 1초 미만은 소수 둘째 자리까지 본다. 0.3초와 0.35초는 눈에 띄게 다르다.
 */
export function formatDurationSec(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return '0초'
  if (sec < 1) return `${sec.toFixed(2)}초`
  if (sec < 10) return `${sec.toFixed(1)}초`
  return `${Math.round(sec)}초`
}
