/**
 * 글자 하나하나가 들어오는 규칙.
 *
 * reveal.ts 와 같은 구조다. 모양만 여기서 정하고 진행률은 `charIn` 트랙이 민다.
 * 한 덩어리로 두면 프리셋이 트랙을 갈아끼울 때마다 방향까지 새로 정해져서, 세기
 * 슬라이더를 움직이는 것만으로 글자가 다른 쪽에서 들어온다.
 *
 * DOM 도 WebGL 도 참조하지 않는다. 렌더러는 여기서 나온 숫자를 매트릭스에 넣기만 한다.
 */

import {
  CHAR_EASE_LIST,
  CHAR_IN_MODE_LIST,
  type CharAnimSpec,
  type CharEase,
  type CharInMode,
  type CharOrder,
} from './types.ts'
import { PENNER } from '@/easing/penner.ts'

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
  fade: '차례로 밝아지기',
  wave: '물결치듯',
  scramble: '글자 굴리며 확정',
}

/**
 * 오브제(이미지 / 도형) 하나에 걸었을 때의 이름.
 *
 * 같은 규칙인데 부르는 말이 달라야 한다. 오브제는 글자가 하나뿐이라 '차례로' 나
 * '한 글자씩' 같은 말이 거짓말이 된다.
 */
const OBJECT_LABEL_OVERRIDES: Partial<Record<CharInMode, string>> = {
  scatter: '무작위 방향에서',
  zoom: '멀리서 다가오며',
  shrink: '커다랗게 작아지며',
  drop: '위에서 떨어지며',
  typewriter: '딱 나타나기',
  fade: '서서히 밝아지기',
}

export function charInLabel(mode: CharInMode, forText: boolean): string {
  if (forText) return CHAR_IN_LABELS[mode]
  return OBJECT_LABEL_OVERRIDES[mode] ?? CHAR_IN_LABELS[mode]
}

/**
 * 오브제에서 고를 수 있는 모양.
 *
 * 'sides' / 'updown' / 'wave' 는 글자 순번이 홀수냐 짝수냐로 방향을 가른다.
 * 오브제는 언제나 0 번이라 셋 다 한쪽 방향으로 고정되어, 이미 있는 항목과
 * 똑같이 움직이면서 이름만 다른 유령 선택지가 된다. 그래서 목록에서 뺀다.
 *
 * 'scramble' 은 다른 이유로 뺀다. 굴릴 글자를 같은 글 상자에서 빌려 오는데
 * 오브제는 칸이 하나뿐이라 언제나 자기 자신을 빌린다. 아무 일도 일어나지 않는다.
 */
export const CHAR_IN_OBJECT_MODES: readonly CharInMode[] = CHAR_IN_MODE_LIST.filter(
  (mode) => mode !== 'sides' && mode !== 'updown' && mode !== 'wave' && mode !== 'scramble',
)

export const CHAR_ORDER_LABELS: Record<CharOrder, string> = {
  forward: '앞에서부터',
  backward: '뒤에서부터',
  center: '가운데에서 바깥으로',
  edges: '양끝에서 가운데로',
  random: '무작위',
}

export const CHAR_EASE_LABELS: Record<CharEase, string> = {
  linear: '일정하게',
  soft: '부드럽게 감속',
  out: '날아와 멈추기',
  snap: '탁 꽂히기',
  back: '살짝 지나쳤다 돌아오기',
  elastic: '탱탱하게 흔들리기',
  bounce: '통통 튀기',
}

/**
 * 글자 하나가 제자리까지 가는 곡선.
 *
 * back / elastic 은 일부러 1 을 넘는다. 그 오버슈트가 곧 쫀득함이다.
 * 넘어간 값은 charTransformAt 이 "목표를 지나친 상태" 로 그대로 그린다.
 * 어느 곡선이든 f(0) = 0, f(1) = 1 이라 양끝 계약은 그대로다.
 */
const CHAR_EASE_FN: Record<CharEase, (t: number) => number> = {
  linear: PENNER['linear']!,
  soft: PENNER['easeOutQuad']!,
  out: PENNER['easeOutQuint']!,
  snap: PENNER['easeOutExpo']!,
  back: PENNER['easeOutBack']!,
  elastic: PENNER['easeOutElastic']!,
  bounce: PENNER['easeOutBounce']!,
}

export const CHAR_ANIM_LIMITS = {
  stagger: { min: 0, max: 1 },
  jitter: { min: 0, max: 1 },
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
    // 기본값이 back 인 것이 이 기능의 성격을 정한다. 감속만 걸면 얌전하고 밋밋하다.
    ease: 'back',
    jitter: 0.15,
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
    ease: CHAR_EASE_LIST.includes(raw.ease as CharEase) ? (raw.ease as CharEase) : 'back',
    jitter: num(raw.jitter, 0.15, CHAR_ANIM_LIMITS.jitter.min, CHAR_ANIM_LIMITS.jitter.max),
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
 * 이 글자가 몇 번째로 들어오는가. 0 부터 count-1 까지다.
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
 * t = 0 이면 전부 0, t = 1 이면 전부 1 이다. 시간차를 아무리 크게 줘도 이 계약이
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

  /*
   * 흔들림. 글자마다 자기 구간을 조금씩 짧게 쓴다.
   *
   * 시작점은 흔들지 않는다. 시작을 당기면 앞 글자보다 먼저 출발하는 글자가
   * 생겨 순서가 무너지고, 늦추면 진행률 1 에서 도착하지 못하는 글자가 생긴다.
   * 구간을 줄이는 쪽은 그 글자가 먼저 도착할 뿐이라 양끝 계약이 그대로다.
   */
  const jitter = clamp(spec.jitter, 0, 1)
  const shrink = jitter > 0 ? 1 - jitter * 0.45 * hash01(spec.seed ^ 0x9e37, index) : 1
  const own = Math.max(1e-6, span * shrink)

  return clamp((g - start) / own, 0, 1)
}

/**
 * 곡선까지 먹인 글자 진행률. 렌더러가 쓰는 값이다.
 *
 * 왜 전체가 아니라 글자마다 거는가
 *
 * 이징을 전체 진행률에 한 번만 걸면, 각 글자는 그 곡선을 선형으로 잘라 쓴다.
 * 첫 글자는 가파른 앞부분을 받고 마지막 글자는 평평한 꼬리를 받아서, 글자 하나로
 * 보면 거의 등속이다. 그래서 아무리 센 곡선을 걸어도 밋밋하게 보였다.
 *
 * 시간차는 출발 시각만 밀고, 속도 곡선은 글자마다 따로 건다. 그래야 열 글자가
 * 전부 "날아와 탁 멈추는" 같은 리듬을 갖는다. 모션그래픽 도구의 stagger 가 전부
 * 이 방식이다.
 *
 * back / elastic 은 1 을 넘겨 돌려준다. 목표를 지나쳤다가 돌아오는 그 구간이
 * 쫀득함의 정체다. 양끝(0 과 1)은 어느 곡선이든 정확하다.
 */
export function charEasedProgress(
  spec: CharAnimSpec,
  index: number,
  count: number,
  t: number,
): number {
  const raw = charProgress(spec, index, count, t)
  if (raw <= 0) return 0
  if (raw >= 1) return 1
  return CHAR_EASE_FN[spec.ease](raw)
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
      // 화면 좌표는 y 가 아래로 향한다. 아래에서 오려면 +1 이다.
      // 여기가 한때 'drop' 과 한 줄로 묶여 있어 '아래에서' 가 '위에서' 와 똑같이
      // 움직였다. 두 모양은 출발 방향이 정반대라 절대 합칠 수 없다.
      return { x: 0, y: 1 }
    case 'drop':
      // 떨어지는 것이므로 위에서 출발한다.
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
      /*
       * 물결. '위아래 번갈아' 와 절대 같은 줄에 둘 수 없다.
       *
       * 여기가 한때 `index % 2` 로 updown 과 한 글자도 다르지 않았다. 이름은 물결인데
       * 그림은 지그재그였고, 두 항목이 이름만 다른 유령 선택지가 되어 있었다.
       *
       * 순번에 사인을 걸어 진폭까지 부드럽게 바뀌게 한다. 주기 6 이면 글자 여섯 개에
       * 굽이 하나가 들어와 줄 전체가 출렁이는 것으로 읽힌다. 반 칸(0.5) 밀어 두는
       * 것이 중요하다. 안 밀면 sin 이 정확히 0 이 되는 자리가 생겨서 그 글자만
       * 혼자 안 움직인다.
       */
      return { x: 0, y: -Math.sin(((index + 0.5) * Math.PI) / 3) }
    default:
      return { x: 0, y: 0 }
  }
}

/**
 * 배율을 따로 안 정했을 때(1) 쓰는 출발 배율.
 *
 * 1 을 그대로 쓰면 `1 + (1 - 1) * e` 가 언제나 1 이라 배율 계산이 통째로 항등이 된다.
 * 그러면 '멀리서 다가오며' 와 '커다랗게 작아지며' 가 둘 다 아무것도 안 움직이는
 * 페이드가 되어 서로 구별되지 않는다. spin 이 각도 0 을 360 으로 보는 것과 같은 규칙이다.
 */
const ZOOM_START_SCALE = 0.2
const SHRINK_START_SCALE = 3.5

/** 착지 충격의 세기. 세로로 이만큼 눌리고 가로로 그만큼 퍼진다. */
const DROP_SQUASH = 0.22

/**
 * 떨어져 바닥에 닿는 순간의 찌그러짐. 0 -> 1 -> 0 으로 한 번 지나간다.
 *
 * '위에서' 와 '위에서 떨어지며' 는 출발 방향이 같다. 방향만으로는 두 항목이 화면에서
 * 한 픽셀도 다르지 않다. 닿는 순간 한 번 눌렸다 펴지는 것이 '떨어졌다' 를 만든다.
 *
 * 원시 진행률로 잰다. 곡선을 먹인 값으로 재면 튕기는 곡선(bounce)이 1 을 여러 번
 * 넘나들며 찌그러짐이 깜빡인다.
 */
function dropSquash(raw: number): number {
  const land = (raw - 0.65) / 0.35
  if (land <= 0 || land >= 1) return 0
  return Math.sin(land * Math.PI)
}

/**
 * 글자 하나의 변형.
 *
 * @param p    곡선을 먹인 진행률. 1 을 넘을 수 있다(back / elastic 의 오버슈트).
 *             넘은 만큼 목표를 지나친 자리에 그린다. 그것이 쫀득함이다.
 * @param raw  곡선을 안 먹인 진행률. 투명도와 "다 들어왔는가" 판정이 이쪽을 쓴다.
 *             불투명도까지 튕기면 글자가 깜빡이는 것처럼 보인다.
 *             오버슈트가 있는 곡선(back / elastic)에서는 반드시 넘겨야 한다.
 *             생략하면 p 를 쓰는데, p 가 1 을 넘는 순간을 '끝났다' 로 보고 항등을
 *             돌려주어 오버슈트가 통째로 사라진다.
 *
 * p = 1 이면 언제나 항등이다. 어떤 모양을 골라도 다 들어온 뒤에는 배치가
 * layoutText 가 정한 자리와 정확히 같아야 한다. 그래야 정지 화면이 흔들리지 않는다.
 */
export function charTransformAt(
  spec: CharAnimSpec,
  index: number,
  p: number,
  raw: number = p,
): CharTransform {
  if (spec.mode === 'none') return CHAR_IDENTITY

  /*
   * 다 들어왔는지는 원시 진행률로 판정한다.
   *
   * 곡선을 먹인 값으로 판정하면 안 된다. elastic 은 흔들리며 1 을 여러 번 지나가는데,
   * 그 순간마다 "끝났다" 로 보고 항등을 돌려주면 그 프레임만 불투명도가 1 로 튀어
   * 글자가 깜빡인다.
   */
  if (raw >= 1) return CHAR_IDENTITY

  // 오버슈트를 살리려면 자르면 안 된다. 다만 곡선이 폭주해도 화면을 덮지는 않게 한다.
  const t = clamp(p, -1, 2)
  // 남은 양. 1 이면 아직 출발점, 0 이면 도착, 음수면 목표를 지나쳤다.
  const e = 1 - t

  const dir = directionOf(spec, index)
  const dist = spec.distance * e
  const rawT = clamp(raw, 0, 1)

  /*
   * 불투명도는 자기 구간의 앞 45% 안에서 끝낸다.
   *
   * 위치와 같은 속도로 옅어지면 글자가 오래 흐릿하게 떠다녀 흐리멍덩해 보인다.
   * 빨리 또렷해진 뒤 위치만 마저 잡히는 편이 훨씬 또렷하고 빠르게 느껴진다.
   */
  const fadeIn = clamp(rawT / 0.45, 0, 1)

  let scale = 1
  let scaleX = 1
  let rotate = spec.rotate * e
  let opacity = fadeIn
  /** 착지 찌그러짐. 떨어지는 모양만 쓴다. 배율 계산이 다 끝난 뒤에 곱한다. */
  let squash = 0

  switch (spec.mode) {
    case 'zoom': {
      // 멀리서 다가온다. 배율을 안 정했으면 작은 점에서 시작한다.
      const from = spec.scale === 1 ? ZOOM_START_SCALE : Math.max(0.01, spec.scale)
      scale = 1 + (from - 1) * e
      break
    }
    case 'shrink': {
      // 커다랗게 시작해 제자리 크기로 줄어든다.
      const from = spec.scale === 1 ? SHRINK_START_SCALE : Math.max(1, spec.scale)
      scale = 1 + (from - 1) * e
      break
    }
    case 'drop':
      // 떨어지는 느낌은 거리로 주고, 바닥에 닿는 한 번의 찌그러짐으로 '위에서' 와 가른다.
      squash = dropSquash(rawT)
      break
    case 'spin':
      // 회전 각도를 따로 안 정했으면 한 바퀴 돈다.
      rotate = (spec.rotate === 0 ? 360 : spec.rotate) * e
      break
    case 'flip':
      // 가로로 눌렸다 펴진다. 카드가 도는 느낌이다.
      // 오버슈트에서 e 가 음수가 되면 cos 이 대칭이라 한 번 더 뒤집힌 것처럼 보인다.
      scaleX = Math.cos((Math.max(0, e) * Math.PI) / 2)
      break
    case 'typewriter':
      // 움직이지 않는다. 그 자리에 딱 나타난다.
      opacity = rawT > 0 ? 1 : 0
      break
    case 'fade':
      // 이쪽만 위치와 같은 속도로 옅어진다. 그것이 이 모양의 전부다.
      opacity = rawT
      break
    case 'scramble':
      /*
       * 움직이지 않는다. 자리에 앉은 채 그리는 칸만 바뀐다(charScrambleSlot).
       * 여기서 위치까지 흔들면 두 가지가 한꺼번에 일어나 글자가 읽히지 않는다.
       *
       * 투명도도 건드리지 않는다. 처음부터 온 줄이 보이는 것이 이 모양의 전부다.
       * 다른 등장은 글자가 차례로 나타나지만, 굴리기는 처음부터 줄 전체가 아무 글자로
       * 채워져 있다가 왼쪽부터 하나씩 제 글자로 확정된다. 시간차가 옅어짐에도 걸리면
       * 줄이 왼쪽부터 자라나는 것으로 보여서, 굴리는 그림이 통째로 사라진다.
       */
      opacity = 1
      break
    default:
      break
  }

  // zoom / shrink 는 spec.scale 을 배율로 쓴다. 나머지는 사용자가 정한 값을 곱한다.
  if (spec.mode !== 'zoom' && spec.mode !== 'shrink' && spec.scale !== 1) {
    scale = 1 + (spec.scale - 1) * e
  }

  /*
   * 찌그러짐은 맨 마지막에 곱한다. 위 배율 계산을 덮어쓰면 사용자가 정한 출발 배율이
   * 사라진다. 세로로 눌린 만큼 가로로 퍼져야 부피가 유지되는 것으로 보인다.
   */
  if (squash > 0) {
    const q = DROP_SQUASH * squash
    scale *= 1 - q
    scaleX *= (1 + q) / (1 - q)
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

/**
 * 굴러가는 동안 몇 번 글자가 바뀌는가.
 *
 * 프레임이 아니라 진행률을 나눈다. 프레임 수로 세면 fps 를 바꾸거나 속도를
 * 조절했을 때 내보낸 파일과 미리보기가 서로 다른 글자를 그린다. 진행률로 나누면
 * 어떤 길이에서도 같은 순서로 굴러간다.
 *
 * 10 이면 25fps 0.4초 구간에서 한 글자가 한 컷씩 잡힌다. 더 잘게 나누면 사람 눈에는
 * 그냥 뭉개진 얼룩이고, 더 성기면 굴러간다기보다 몇 번 깜빡인 것으로 보인다.
 */
const SCRAMBLE_STEPS = 10

/**
 * 이 글자가 지금 몇 번 칸을 빌려 그려야 하는가.
 *
 * -1 은 "빌리지 않는다" 는 뜻이다. 자기 칸을 그린다. 굴리기가 아닌 모든 모양과,
 * 굴리기라도 이미 확정된 글자가 -1 이다.
 *
 * @param raw 곡선을 안 먹인 글자 진행률. 곡선을 먹이면 back / elastic 이 1 을
 *            넘나들며 확정된 글자가 다시 굴러간다.
 */
export function charScrambleSlot(
  spec: CharAnimSpec,
  index: number,
  count: number,
  raw: number,
): number {
  if (spec.mode !== 'scramble') return -1
  // 빌릴 칸이 자기 하나뿐이면 굴릴 것이 없다.
  const n = Math.max(1, count)
  if (n < 2) return -1
  /*
   * 진행률 0 도 굴린다. 0 은 "아직 시작 안 함" 이 아니라 "아직 확정 안 됨" 이다.
   * 여기서 빼면 시간차 때문에 아직 차례가 안 온 뒷글자들이 처음부터 정답을 보여 준다.
   * 굴리기의 값어치는 답이 마지막에 드러나는 데 있다.
   */
  if (raw >= 1) return -1

  const step = Math.min(SCRAMBLE_STEPS - 1, Math.floor(raw * SCRAMBLE_STEPS))
  // 글자마다 다른 순서로 굴러야 한다. 안 그러면 온 줄이 한 몸처럼 같이 바뀐다.
  const h = hash01(spec.seed ^ 0x5bd1, index * 131 + step * 7919)
  const pick = Math.min(n - 1, Math.floor(h * n))
  /*
   * 자기 자신은 빌리지 않는다.
   *
   * 빌리면 확정되기 전에 정답이 잠깐 보인다. 그 한 컷 때문에 "굴리다 맞췄다" 가
   * 아니라 "깜빡였다" 로 읽힌다.
   */
  return pick === index ? (pick + 1) % n : pick
}

/**
 * 오브제(이미지 / 도형 / 솔리드) 하나에 건 등장.
 *
 * 글자가 한 개뿐인 글 상자와 완전히 같은 계산이다. 규칙을 한 벌만 두는 것이
 * 핵심이다. 두 벌이 되면 같은 이름의 모션이 글자에서는 왼쪽에서, 이미지에서는
 * 오른쪽에서 들어오는 사고가 난다.
 *
 * 글자가 하나면 시간차 / 순서 / 흔들림은 자동으로 무력해진다(charProgress 가
 * n === 1 을 곧바로 돌려준다). 그래서 오브제용 분기가 따로 필요 없다.
 *
 * @param t 진행률(`charIn` 트랙 값). 0 이 출발점, 1 이 제자리다.
 */
export function objectCharTransform(spec: CharAnimSpec, t: number): CharTransform {
  const raw = charProgress(spec, 0, 1, t)
  const eased = charEasedProgress(spec, 0, 1, t)
  return charTransformAt(spec, 0, eased, raw)
}
