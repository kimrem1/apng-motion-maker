/**
 * 속도 슬라이더의 눈금.
 *
 * 속도는 배수라서 슬라이더에 그대로 얹으면 안 된다. 0.1 ~ 2 를 선형으로 펴면
 * 트랙의 95% 가 "보통보다 느린" 구간에 들어가는 대신, 그 구간 안에서 한 칸이
 * 뜻하는 시간 차이가 자리마다 20배씩 달라진다. 손잡이를 왼쪽 끝 근처에서 1px
 * 움직이면 몇 초가 뛰고, 오른쪽에서는 아무 일도 안 일어난다.
 *
 * 로그 눈금이면 어디서든 **한 칸이 같은 비율**을 뜻한다. 미세 조정이 느린 쪽에서
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
