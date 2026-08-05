/**
 * 가리기(와이프)의 값 규칙.
 *
 * shape.ts 와 같은 자리다. 렌더러 / 스토어 / 마이그레이션 / 프리셋 / UI 가 **모두
 * 여기를 거친다.** 규칙이 두 벌이 되면 저장했다 열었을 때 경계선이 다른 자리에서 선다.
 *
 * DOM 도 WebGL 도 참조하지 않는다.
 */

import {
  REVEAL_MODE_LIST,
  REVEAL_SLATS_MAX,
  REVEAL_SLATS_MIN,
  type RevealMode,
  type RevealSpec,
} from './types.ts'

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v)

/** 사용자에게 보이는 이름. 인스펙터와 프리셋 안내가 같이 쓴다. */
export const REVEAL_MODE_LABELS: Record<RevealMode, string> = {
  none: '없음',
  left: '왼쪽에서',
  right: '오른쪽에서',
  up: '위에서',
  down: '아래에서',
  splitX: '가운데에서 좌우로',
  splitY: '가운데에서 위아래로',
  iris: '가운데에서 원으로',
  clock: '시계 방향으로',
  blinds: '블라인드',
  ink: '잉크처럼 번지며',
  fan: '부채처럼 펼쳐지며',
}

/** u_revealMode 로 넘기는 코드. REVEAL_MODE_LIST 의 순서와 같아야 한다. */
export const REVEAL_MODE_CODE: Record<RevealMode, number> = {
  none: 0,
  left: 1,
  right: 2,
  up: 3,
  down: 4,
  splitX: 5,
  splitY: 6,
  iris: 7,
  clock: 8,
  blinds: 9,
  ink: 10,
  fan: 11,
}

/**
 * 칸 수 슬라이더가 이 모양에서 무엇을 뜻하는가.
 *
 * 저장되는 값은 `slats` 하나다. 블라인드에서는 칸 수이고 잉크에서는 얼룩의 잘기다.
 * 값을 두 벌로 나누면 모양을 갈아탈 때마다 한쪽이 기본값으로 되돌아간다.
 */
export const REVEAL_SLATS_LABELS: Partial<Record<RevealMode, string>> = {
  blinds: '칸 수',
  ink: '얼룩 잘기',
}

export const REVEAL_LIMITS = {
  softness: { min: 0, max: 1 },
  slats: { min: REVEAL_SLATS_MIN, max: REVEAL_SLATS_MAX },
  angle: { min: -360, max: 360 },
} as const

/** 기본 가리기. 모양만 정하고 진행률은 `reveal` 트랙이 민다. */
export function createRevealSpec(
  mode: RevealMode,
  overrides: Partial<RevealSpec> = {},
): RevealSpec {
  return normalizeRevealSpec({
    mode,
    // 경계가 칼같이 끊기면 도형에서는 계단이 보인다. 아주 얇게 흐려 두는 편이 낫다.
    softness: 0.06,
    slats: 8,
    angle: 0,
    invert: false,
    ...overrides,
  })
}

/** 어떤 값이 들어와도 그릴 수 있는 가리기로 만든다. 던지지 않는다. */
export function normalizeRevealSpec(raw: Partial<RevealSpec> & { mode?: unknown }): RevealSpec {
  const mode = REVEAL_MODE_LIST.includes(raw.mode as RevealMode) ? (raw.mode as RevealMode) : 'none'
  const num = (v: unknown, fallback: number, lo: number, hi: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? clamp(v, lo, hi) : fallback

  return {
    mode,
    softness: num(raw.softness, 0.06, REVEAL_LIMITS.softness.min, REVEAL_LIMITS.softness.max),
    slats: Math.round(num(raw.slats, 8, REVEAL_LIMITS.slats.min, REVEAL_LIMITS.slats.max)),
    angle: num(raw.angle, 0, REVEAL_LIMITS.angle.min, REVEAL_LIMITS.angle.max),
    invert: raw.invert === true,
  }
}

/**
 * 이 가리기가 실제로 무언가를 가리는가.
 *
 * 'none' 이면 렌더러가 유니폼조차 만지지 않는다. 옛 문서에서 비용이 정확히 0 이어야
 * 하기 때문이다.
 */
export function revealIsActive(spec: RevealSpec | undefined): spec is RevealSpec {
  return spec !== undefined && spec.mode !== 'none'
}
