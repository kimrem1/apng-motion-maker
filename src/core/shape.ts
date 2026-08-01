/**
 * 도형 레이어의 값 규칙.
 *
 * 도형은 픽셀이 아니라 수식으로 그린다. 그래서 "원본 크기" 라는 개념이 없고,
 * 대신 ShapeSpec.width / height 가 그 자리를 대신한다. 이 파일은 그 값을 만들고
 * 가두는 규칙 한 벌이다. 렌더러 / 스토어 / 마이그레이션 / UI 가 **모두 여기를 거친다.**
 * 규칙이 두 벌이 되면 저장했다 열었을 때 도형 크기가 달라진다.
 *
 * DOM 도 WebGL 도 참조하지 않는다.
 */

import {
  SHAPE_KIND_LIST,
  SHAPE_SIZE_MAX,
  SHAPE_SIZE_MIN,
  type Layer,
  type ShapeKind,
  type ShapeSpec,
} from './types.ts'

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v)

/** 사용자에게 보이는 도형 이름. UI 세 곳(추가 메뉴 / 인스펙터 / 레이어 이름)이 같이 쓴다. */
export const SHAPE_KIND_LABELS: Record<ShapeKind, string> = {
  rect: '사각형',
  circle: '원',
  triangle: '삼각형',
  polygon: '다각형',
  star: '별',
  cross: '십자',
  arc: '부채꼴',
  burst: '방사살',
  ticks: '눈금',
  sparkle: '별빛',
}

/**
 * 파라미터 범위. 인스펙터의 입력 상자와 마이그레이션이 같은 표를 본다.
 *
 * points 상한이 12 에서 36 으로 올라간 것은 방사살과 눈금 때문이다. 살이 12개까지만
 * 되면 집중선도 자 눈금도 만들어지지 않는다. 옛 문서에는 12 를 넘는 값이 없으므로
 * 저장 / 열기 왕복이 달라지지 않는다.
 */
export const SHAPE_LIMITS = {
  strokeWidth: { min: 0, max: 400 },
  cornerRadius: { min: 0, max: 2000 },
  points: { min: 3, max: 36 },
  innerRatio: { min: 0.05, max: 0.95 },
  sweepDeg: { min: 5, max: 360 },
} as const

/**
 * 이 종류는 테두리 두께를 "테두리" 가 아니라 다른 뜻으로 쓴다.
 *
 * 방사살은 두께가 살 한 줄의 굵기다. 짧은 변의 절반이라는 상한(테두리가 도형을
 * 통째로 메우는 지점)이 여기서는 뜻이 없다. 살 굵기는 훨씬 자유롭게 열어 둔다.
 */
function strokeIsThickness(kind: ShapeKind): boolean {
  return kind === 'burst'
}

/** 종류별 기본 꼭짓점 / 개수. 없으면 6 이다. */
const DEFAULT_POINTS: Partial<Record<ShapeKind, number>> = {
  star: 5,
  burst: 12,
  ticks: 10,
  sparkle: 4,
}

/** 기본 도형. 색은 호출부가 정한다. */
export function createShapeSpec(kind: ShapeKind, overrides: Partial<ShapeSpec> = {}): ShapeSpec {
  return normalizeShapeSpec({
    kind,
    color: '#ffffffff',
    width: 240,
    height: 240,
    // 방사살은 두께가 0 이면 아무것도 안 보인다.
    strokeWidth: kind === 'burst' ? 6 : 0,
    cornerRadius: kind === 'rect' ? 24 : 0,
    points: DEFAULT_POINTS[kind] ?? 6,
    // 별빛은 뾰족할수록 별빛답고, 방사살은 가운데가 비어야 바람개비가 된다.
    innerRatio: kind === 'sparkle' ? 0.3 : kind === 'burst' ? 0.15 : 0.45,
    sweepDeg: 360,
    ...overrides,
  })
}

/**
 * 어떤 값이 들어와도 그릴 수 있는 도형으로 만든다.
 *
 * 저장된 파일과 손으로 만든 장면 정의가 같은 문을 통과한다. 던지지 않는다.
 */
export function normalizeShapeSpec(raw: Partial<ShapeSpec> & { kind?: unknown }): ShapeSpec {
  const kind = SHAPE_KIND_LIST.includes(raw.kind as ShapeKind) ? (raw.kind as ShapeKind) : 'rect'
  const num = (v: unknown, fallback: number, lo: number, hi: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? clamp(v, lo, hi) : fallback

  const width = num(raw.width, 240, SHAPE_SIZE_MIN, SHAPE_SIZE_MAX)
  const height = num(raw.height, 240, SHAPE_SIZE_MIN, SHAPE_SIZE_MAX)

  return {
    kind,
    color: typeof raw.color === 'string' && raw.color.length > 0 ? raw.color : '#ffffffff',
    width,
    height,
    // 테두리는 안쪽으로 물린다. 짧은 변의 절반을 넘으면 도형이 통째로 메워져
    // "테두리를 두껍게 했더니 꽉 찬 도형이 됐다" 로 보인다. 거기서 끊는다.
    // 살 굵기로 쓰는 종류는 그 상한이 뜻이 없으므로 전체 상한만 건다.
    strokeWidth: num(
      raw.strokeWidth,
      strokeIsThickness(kind) ? 1 : 0,
      // 살 굵기는 0 이면 아무것도 안 보인다. 다른 종류에서 굵기 0(꽉 찬 도형)으로
      // 두었다가 종류만 방사살로 바꿨을 때 "넣었는데 화면에 없다" 가 되는 자리다.
      strokeIsThickness(kind) ? 1 : SHAPE_LIMITS.strokeWidth.min,
      strokeIsThickness(kind)
        ? SHAPE_LIMITS.strokeWidth.max
        : Math.min(SHAPE_LIMITS.strokeWidth.max, Math.min(width, height) / 2),
    ),
    cornerRadius: num(
      raw.cornerRadius,
      0,
      SHAPE_LIMITS.cornerRadius.min,
      Math.min(SHAPE_LIMITS.cornerRadius.max, Math.min(width, height) / 2),
    ),
    points: Math.round(num(raw.points, 6, SHAPE_LIMITS.points.min, SHAPE_LIMITS.points.max)),
    innerRatio: num(
      raw.innerRatio,
      0.45,
      SHAPE_LIMITS.innerRatio.min,
      SHAPE_LIMITS.innerRatio.max,
    ),
    sweepDeg: num(raw.sweepDeg, 360, SHAPE_LIMITS.sweepDeg.min, SHAPE_LIMITS.sweepDeg.max),
  }
}

/**
 * 이 레이어가 차지하는 자연 크기(px).
 *
 * 이미지면 원본 픽셀, 도형이면 ShapeSpec 의 크기다. **렌더러와 오버스캔 솔버가
 * 반드시 같은 값을 봐야 한다.** 어긋나면 솔버가 실제와 다른 배율을 풀어서,
 * 담기를 켠 도형이 이유 없이 작아지거나 잘린다.
 */
export function layerIntrinsicSize(
  layer: Pick<Layer, 'assetId' | 'shape'>,
  assetSize: (assetId: string) => { width: number; height: number } | undefined,
): { width: number; height: number } | undefined {
  if (layer.shape) return { width: layer.shape.width, height: layer.shape.height }
  if (!layer.assetId) return undefined
  return assetSize(layer.assetId)
}

// ---------------------------------------------------------------------------
// 색
// ---------------------------------------------------------------------------

/** `#rgb` / `#rrggbb` / `#rrggbbaa` 를 여섯 자리로 줄인다. `<input type=color>` 용. */
export function toHex6(color: string): string {
  const s = color.trim()
  if (/^#[0-9a-f]{3}$/i.test(s)) {
    const r = s[1] ?? '0'
    const g = s[2] ?? '0'
    const b = s[3] ?? '0'
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase()
  }
  if (/^#[0-9a-f]{6}$/i.test(s)) return s.toLowerCase()
  if (/^#[0-9a-f]{8}$/i.test(s)) return s.slice(0, 7).toLowerCase()
  return '#ffffff'
}

/** 색의 알파만 바꾼다. 장면 정의가 같은 색을 농도만 달리해 여러 장 쓸 때 쓴다. */
export function withAlpha(color: string, alpha: number): string {
  const a = Math.round(clamp(alpha, 0, 1) * 255)
  return `${toHex6(color)}${a.toString(16).padStart(2, '0')}`
}

/**
 * 색을 밝게(t > 0) 또는 어둡게(t < 0) 민다.
 *
 * 장면 하나가 색을 여러 장 써야 할 때 사용자에게 색을 여러 번 고르게 하지 않기
 * 위한 것이다. 색 하나에서 계열을 만든다.
 */
export function shiftColor(color: string, t: number, alpha = 1): string {
  const hex = toHex6(color)
  const mix = clamp(t, -1, 1)
  const channel = (i: number): number => {
    const v = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16)
    const target = mix >= 0 ? 255 : 0
    return Math.round(v + (target - v) * Math.abs(mix))
  }
  const out = [channel(0), channel(1), channel(2)]
    .map((v) => clamp(v, 0, 255).toString(16).padStart(2, '0'))
    .join('')
  return withAlpha(`#${out}`, alpha)
}
