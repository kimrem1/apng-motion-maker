/**
 * 글자 하나하나가 들어오는 규칙.
 *
 * reveal.ts 와 같은 구조다. **모양만 여기서 정하고 진행률은 `charIn` 트랙이 민다.**
 * 한 덩어리로 두면 프리셋이 트랙을 갈아끼울 때마다 방향까지 새로 정해져서, 세기
 * 슬라이더를 움직이는 것만으로 글자가 다른 쪽에서 들어온다.
 *
 * DOM 도 WebGL 도 참조하지 않는다. 렌더러는 여기서 나온 숫자를 매트릭스에 넣기만 한다.
 */

import { CHAR_IN_MODE_LIST, type CharAnimSpec, type CharInMode, type CharOrder } from './types.ts'

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v)

export const CHAR_IN_LABELS: Record<CharInMode, string> = {
  none: '없음',
  left: '왼쪽에서',
  right: '오른쪽에서',
  up: '위에서',
  down: '아래에서',
  sides: '좌우 번갈아',
  updown: '위아래 번갈아',
  scatter: '제각각 흩어져서',
  zoom: '멀리서 다가오며',
  shrink: '커다랗게 작아지며',
  drop: '위에서 떨어지며',
  spin: '돌면서',
  flip: '뒤집히며',
  typewriter: '타자기',
  fade: '차례로 흐리게',
  wave: '물결치듯',
}

export const CHAR_ORDER_LABELS: Record<CharOrder, string> = {
  forward: '앞에서부터',
  backward: '뒤에서부터',
  center: '가운데에서 바깥으로',
  edges: '양끝에서 가운데로',
  random: '무작위',
}

export const CHAR_ANIM_LIMITS = {
  stagger: { min: 0, max: 1 },
  distance: { min: 0, max: 8 },
  rotate: { min: -1440, max: 1440 },
  scale: { min: 0, max: 12 },
} as const

const ORDERS: readonly CharOrder[] = ['forward', 'backward', 'center', 'edges', 'random']

/** 기본 글자 등장. 모양만 정하고 진행률은 트랙이 민다. */
export function createCharAnimSpec(
  mode: CharInMode,
  overrides: Partial<CharAnimSpec> = {},
): CharAnimSpec {
  return normalizeCharAnimSpec({
    mode,
    stagger: 0.5,
    distance: 1.2,
    rotate: 0,
    scale: 1,
    order: 'forward',
    seed: 1,
    ...overrides,
  })
}

/** 어떤 값이 들어와도 그릴 수 있는 등장으로 만든다. 던지지 않는다. */
export function normalizeCharAnimSpec(
  raw: Partial<CharAnimSpec> & { mode?: unknown; order?: unknown },
): CharAnimSpec {
  const num = (v: unknown, fallback: number, lo: number, hi: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? clamp(v, lo, hi) : fallback

  return {
    mode: CHAR_IN_MODE_LIST.includes(raw.mode as CharInMode) ? (raw.mode as CharInMode) : 'none',
    stagger: num(raw.stagger, 0.5, CHAR_ANIM_LIMITS.stagger.min, CHAR_ANIM_LIMITS.stagger.max),
    distance: num(raw.distance, 1.2, CHAR_ANIM_LIMITS.distance.min, CHAR_ANIM_LIMITS.distance.max),
    rotate: num(raw.rotate, 0, CHAR_ANIM_LIMITS.rotate.min, CHAR_ANIM_LIMITS.rotate.max),
    scale: num(raw.scale, 1, CHAR_ANIM_LIMITS.scale.min, CHAR_ANIM_LIMITS.scale.max),
    order: ORDERS.includes(raw.order as CharOrder) ? (raw.order as CharOrder) : 'forward',
    seed: Math.round(num(raw.seed, 1, 0, 0xffff)),
  }
}

/** 이 등장이 실제로 무언가를 움직이는가. */
export function charAnimIsActive(spec: CharAnimSpec | undefined): spec is CharAnimSpec {
  return spec !== undefined && spec.mode !== 'none'
}

// ---------------------------------------------------------------------------
// 순서
// ---------------------------------------------------------------------------

/** 결정적 해시. 같은 시드 같은 순번이면 언제나 같은 값이다 (0~1). */
function hash01(seed: number, i: number): number {
  let h = (seed * 374761393 + i * 668265263) >>> 0
  h = (h ^ (h >>> 13)) >>> 0
  h = Math.imul(h, 1274126177) >>> 0
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

/**
 * 이 글자가 **몇 번째로** 들어오는가. 0 부터 count-1 까지다.
 *
 * 순번(order)과 다르다. 순번은 글에서의 자리이고 이것은 등장 차례다.
 * '뒤에서부터' 를 고르면 마지막 글자의 등장 차례가 0 이 된다.
 */
export function charRank(spec: CharAnimSpec, index: number, count: number): number {
  const n = Math.max(1, count)
  const i = clamp(index, 0, n - 1)

  switch (spec.order) {
    case 'backward':
      return n - 1 - i
    case 'center': {
      // 가운데가 0, 바깥으로 갈수록 커진다.
      const mid = (n - 1) / 2
      return Math.round(Math.abs(i - mid))
    }
    case 'edges': {
      const mid = (n - 1) / 2
      return Math.round(mid - Math.abs(i - mid))
    }
    case 'random': {
      /*
       * 해시 값으로 정렬한 순위다. 단순히 hash*n 을 쓰면 같은 차례가 겹쳐
       * 어떤 글자는 영영 안 들어온 것처럼 보인다. 순위는 반드시 순열이어야 한다.
       */
      const mine = hash01(spec.seed, i)
      let rank = 0
      for (let k = 0; k < n; k += 1) {
        if (k === i) continue
        const other = hash01(spec.seed, k)
        // 값이 같으면 인덱스로 가른다. 순열이 깨지지 않게 하는 안전장치다.
        if (other < mine || (other === mine && k < i)) rank += 1
      }
      return rank
    }
    case 'forward':
    default:
      return i
  }
}

/**
 * 이 글자의 진행률. 전체 진행률 t 를 글자별로 밀어 준다.
 *
 * **t = 0 이면 전부 0, t = 1 이면 전부 1 이다.** 시간차를 아무리 크게 줘도 이 계약이
 * 깨지면 안 된다. 마지막 글자가 1 에 도달하지 못하면 "다 들어왔는데 한 글자만
 * 비뚤어진 채 멈춰 있는" 그림이 나온다.
 */
export function charProgress(spec: CharAnimSpec, index: number, count: number, t: number): number {
  const n = Math.max(1, count)
  const g = clamp(t, 0, 1)
  /*
   * 양끝은 계산하지 않고 곧바로 답한다.
   *
   * span 과 start 는 1/n 꼴이라 이진 부동소수로 정확히 떨어지지 않는다. 시간차가
   * 최대일 때 마지막 글자의 (1 - 0.8) / 0.2 가 0.9999999999999998 이 되어, 다 들어온
   * 뒤에도 글자 하나가 눈에 띄게 비뚤어진 채 멈춘다. 계약을 산술에 맡기면 안 된다.
   */
  if (g <= 0) return 0
  if (g >= 1) return 1
  if (n === 1) return g

  const rank = charRank(spec, index, n)
  const maxRank = spec.order === 'center' || spec.order === 'edges' ? Math.floor((n - 1) / 2) : n - 1
  if (maxRank <= 0) return g

  const stagger = clamp(spec.stagger, 0, 1)
  // 전체 길이를 1 로 두고, 각 글자가 쓰는 구간 span 과 시작점을 나눈다.
  const span = 1 / (1 + stagger * maxRank)
  const start = rank * stagger * span
  return clamp((g - start) / span, 0, 1)
}

// ---------------------------------------------------------------------------
// 글자 하나의 변형
// ---------------------------------------------------------------------------

export interface CharTransform {
  /** 글자 크기 배수로 잰 이동량. 렌더러가 fontSize 를 곱한다. */
  tx: number
  ty: number
  /** 도 단위 회전. 글자 자기 중심을 축으로 돈다. */
  rotate: number
  /** 배율. 1 이 제자리다. */
  scale: number
  /** 가로로만 눌리는 배율. 뒤집기(flip)가 쓴다. */
  scaleX: number
  opacity: number
}

export const CHAR_IDENTITY: CharTransform = {
  tx: 0,
  ty: 0,
  rotate: 0,
  scale: 1,
  scaleX: 1,
  opacity: 1,
}

/** 각 글자가 어느 쪽에서 오는가. 단위 벡터다. */
function directionOf(spec: CharAnimSpec, index: number): { x: number; y: number } {
  switch (spec.mode) {
    case 'left':
      return { x: -1, y: 0 }
    case 'right':
      return { x: 1, y: 0 }
    case 'up':
      return { x: 0, y: -1 }
    case 'down':
    case 'drop':
      return { x: 0, y: -1 }
    case 'sides':
      return { x: index % 2 === 0 ? -1 : 1, y: 0 }
    case 'updown':
      return { x: 0, y: index % 2 === 0 ? -1 : 1 }
    case 'scatter': {
      // 글자마다 다른 방향에서 온다. 레퍼런스의 "글자가 사방에서 모이는" 그림이다.
      const a = hash01(spec.seed, index) * Math.PI * 2
      return { x: Math.cos(a), y: Math.sin(a) }
    }
    case 'wave':
      return { x: 0, y: index % 2 === 0 ? -1 : 1 }
    default:
      return { x: 0, y: 0 }
  }
}

/**
 * 글자 하나의 변형. p 는 그 글자의 진행률(0 = 아직, 1 = 제자리)이다.
 *
 * **p = 1 이면 언제나 항등이다.** 어떤 모양을 골라도 다 들어온 뒤에는 배치가
 * layoutText 가 정한 자리와 정확히 같아야 한다. 그래야 정지 화면이 흔들리지 않는다.
 */
export function charTransformAt(spec: CharAnimSpec, index: number, p: number): CharTransform {
  if (spec.mode === 'none') return CHAR_IDENTITY

  const t = clamp(p, 0, 1)
  // 남은 양. 1 이면 아직 출발점, 0 이면 도착했다.
  const e = 1 - t
  if (e <= 0) return CHAR_IDENTITY

  const dir = directionOf(spec, index)
  const dist = spec.distance * e

  let scale = 1
  let scaleX = 1
  let rotate = spec.rotate * e
  let opacity = t

  switch (spec.mode) {
    case 'zoom':
      // 멀리서 다가온다. spec.scale 이 1 보다 작으면 작게 시작한다.
      scale = 1 + (Math.max(0.01, spec.scale) - 1) * e
      break
    case 'shrink':
      // 커다랗게 시작해 제자리 크기로 줄어든다.
      scale = 1 + (Math.max(1, spec.scale) - 1) * e
      break
    case 'drop':
      // 떨어지는 느낌은 거리로 준다. 튕김은 트랙의 이징이 맡는다.
      scale = 1
      break
    case 'spin':
      // 회전 각도를 따로 안 정했으면 한 바퀴 돈다.
      rotate = (spec.rotate === 0 ? 360 : spec.rotate) * e
      break
    case 'flip':
      // 가로로 눌렸다 펴진다. 카드가 도는 느낌이다.
      scaleX = Math.cos((e * Math.PI) / 2)
      break
    case 'typewriter':
      // 움직이지 않는다. 그 자리에 딱 나타난다.
      opacity = t > 0 ? 1 : 0
      break
    case 'fade':
      opacity = t
      break
    default:
      break
  }

  // zoom / shrink 는 spec.scale 을 배율로 쓴다. 나머지는 사용자가 정한 값을 곱한다.
  if (spec.mode !== 'zoom' && spec.mode !== 'shrink' && spec.scale !== 1) {
    scale = 1 + (spec.scale - 1) * e
  }

  return {
    tx: dir.x * dist,
    ty: dir.y * dist,
    rotate,
    scale,
    scaleX,
    opacity: clamp(opacity, 0, 1),
  }
}
