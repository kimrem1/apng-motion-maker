/**
 * 타임라인 / 그래프 에디터의 캔버스 그리기와 좌표 변환.
 *
 * React 를 모르는 순수 모듈이다. 상호작용 로직과 분리해 두면 그리기만 따로
 * 테스트할 수 있고, 타임라인과 그래프가 같은 좌표 규칙을 공유하게 된다.
 *
 * 색은 전부 CSS 변수에서 읽는다. 캔버스에 색을 박아 두면 토큰을 고쳤을 때
 * 화면에서 여기만 예전 색으로 남는다.
 *
 * 타임라인과 접근성 트리는 반드시 여기 있는 같은 모델에서 파생시킨다.
 * 두 곳에서 따로 계산하면 곧 어긋난다.
 */

import { layerRange } from '@/core/cuts.ts'
import type {
  Interp,
  Keyframe,
  Layer,
  LayerType,
  LoopMode,
  TimelineConfig,
  TrackProp,
  TrackUnit,
} from '@/core/types.ts'
import type { LayerRow } from '@/ui/layers/layerTree.ts'

// ---------------------------------------------------------------------------
// 좌표 변환
// ---------------------------------------------------------------------------

/** 시간축. 그래프 에디터는 pxPerFrame 에 플롯 폭을 넣어 0~1 정규화 축으로 쓴다. */
export interface TimeAxis {
  /** 그리기 영역의 좌측 원점 (CSS px) */
  originX: number
  /** 1 프레임당 CSS px */
  pxPerFrame: number
  /** 좌측 끝에 보이는 프레임 */
  scrollFrame: number
}

export function frameToX(frame: number, axis: TimeAxis): number {
  return axis.originX + (frame - axis.scrollFrame) * axis.pxPerFrame
}

export function xToFrame(x: number, axis: TimeAxis): number {
  if (axis.pxPerFrame === 0) return axis.scrollFrame
  return axis.scrollFrame + (x - axis.originX) / axis.pxPerFrame
}

/** 값축. 위가 큰 값이다. */
export interface ValueAxis {
  top: number
  height: number
  min: number
  max: number
}

export function valueToY(value: number, axis: ValueAxis): number {
  const span = axis.max - axis.min
  if (span === 0) return axis.top + axis.height / 2
  return axis.top + axis.height * (1 - (value - axis.min) / span)
}

export function yToValue(y: number, axis: ValueAxis): number {
  if (axis.height === 0) return axis.min
  const span = axis.max - axis.min
  return axis.min + (1 - (y - axis.top) / axis.height) * span
}

/** 제곱거리 비교. 히트 테스트는 sqrt 를 부르지 않는다. */
export function withinRadius(
  x: number,
  y: number,
  px: number,
  py: number,
  radius: number,
): boolean {
  const dx = x - px
  const dy = y - py
  return dx * dx + dy * dy <= radius * radius
}

/** 포인터 종류별 히트 반경. */
export function hitRadius(pointerType: string): number {
  return pointerType === 'touch' ? 18 : 10
}

// ---------------------------------------------------------------------------
// 테마
// ---------------------------------------------------------------------------

const THEME_VARS = {
  bg: '--bg',
  surface: '--surface',
  surfaceRaised: '--surface-raised',
  surfaceHover: '--surface-hover',
  border: '--border',
  borderStrong: '--border-strong',
  text: '--text',
  textMuted: '--text-muted',
  textFaint: '--text-faint',
  accent: '--accent',
  accentSoft: '--accent-soft',
  danger: '--danger',
  warn: '--warn',
  focus: '--focus',
  fontUi: '--font-ui',
  fontMono: '--font-mono',
} as const

export type TimelineTheme = Record<keyof typeof THEME_VARS, string>

/** CSS 변수를 못 읽는 환경(테스트 등)에서 쓰는 값. tokens.css 와 같은 값이어야 한다. */
const THEME_FALLBACK: TimelineTheme = {
  bg: '#000000',
  surface: '#0a0a0a',
  surfaceRaised: '#141414',
  surfaceHover: '#1e1e1e',
  border: '#2e2e2e',
  borderStrong: '#6e6e6e',
  text: '#f2f2f2',
  textMuted: '#b4b4b4',
  textFaint: '#949494',
  accent: '#e8e8e8',
  accentSoft: 'rgba(255, 255, 255, 0.14)',
  danger: '#ffffff',
  warn: '#d9d9d9',
  focus: '#ffffff',
  fontUi: 'system-ui, sans-serif',
  fontMono: 'ui-monospace, monospace',
}

/** 캔버스가 놓인 위치에서 상속된 CSS 변수를 읽는다. */
export function readTheme(el: Element | null): TimelineTheme {
  if (!el || typeof getComputedStyle !== 'function') return THEME_FALLBACK
  const cs = getComputedStyle(el)
  const out: Record<string, string> = {}
  for (const key of Object.keys(THEME_VARS) as (keyof typeof THEME_VARS)[]) {
    const value = cs.getPropertyValue(THEME_VARS[key]).trim()
    out[key] = value === '' ? THEME_FALLBACK[key] : value
  }
  return out as TimelineTheme
}

/**
 * 드로잉 버퍼를 devicePixelRatio 로 맞추고 CSS px 좌표계를 돌려준다.
 * 이걸 안 하면 1px 선이 흐려지고 텍스트가 뭉갠다.
 */
export function prepareCanvas(
  canvas: HTMLCanvasElement,
  cssW: number,
  cssH: number,
): CanvasRenderingContext2D | null {
  const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1))
  const w = Math.max(1, Math.round(cssW * dpr))
  const h = Math.max(1, Math.round(cssH * dpr))
  if (canvas.width !== w) canvas.width = w
  if (canvas.height !== h) canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, cssW, cssH)
  return ctx
}

// ---------------------------------------------------------------------------
// 모델 (타임라인 캔버스와 접근성 트리의 단일 데이터 소스)
// ---------------------------------------------------------------------------

export interface TrackRow {
  prop: TrackProp
  /** 사용자에게 보이는 이름 */
  label: string
  unit: TrackUnit
  keys: readonly Keyframe[]
}

export interface TimelineModel {
  layerId: string
  layerName: string
  fps: number
  durationFrames: number
  rows: TrackRow[]
}

/**
 * 레이어 한 장이 언제 보이는가. 타임라인 위층(전체 표시)의 한 줄이다.
 *
 * 트랙 행과 왜 다른 모델인가
 *
 * 트랙 행은 "고른 레이어 하나의 속성이 어떻게 변하는가" 이고, 클립 행은 "이 문서에
 * 무엇이 언제 있는가" 다. 눈 깜빡임처럼 그림 세 장을 딱딱 바꿔 끼우는 편집은
 * 두 번째 질문만 한다. 그림마다 트랙을 하나도 만들지 않고 구간만 나누기 때문이다.
 *
 * 순서는 레이어 패널과 같다(위가 앞). 두 목록이 다른 순서로 보이면 어느 줄이
 * 어느 그림인지 눈으로 못 잇는다.
 */
export interface ClipRow {
  layerId: string
  name: string
  type: LayerType
  /** 폴더 중첩 깊이. 머리 열의 들여쓰기가 이 값을 쓴다. */
  depth: number
  isFolder: boolean
  visible: boolean
  locked: boolean
  /** 아래 모양으로 잘리는 레이어인가. 클립 바에 표식을 남긴다. */
  clipped: boolean
  /** 첫 프레임. */
  start: number
  /** 마지막 프레임. 포함이다. */
  end: number
  /**
   * 문서에 구간이 적혀 있는가.
   *
   * 거짓이면 [0, 끝] 을 그리되 "전체" 로 표시한다. 구간을 한 번도 손대지 않은
   * 레이어와 우연히 전 구간으로 맞춰 둔 레이어는 다르다. 앞의 것은 길이를 바꾸면
   * 따라 늘어나고 뒤의 것은 그 자리에 남는다.
   */
  explicit: boolean
  inFade: number
  outFade: number
  /** 이 레이어의 모든 트랙 키 프레임. 중복 없이 오름차순이다. */
  keyFrames: number[]
}

/**
 * 레이어 목록을 클립 행으로 옮긴다.
 *
 * rows 는 레이어 패널이 쓰는 것과 같은 계산 결과여야 한다(ui/layers/layerTree.ts).
 * 여기서 다시 접힘과 순서를 계산하면 두 패널이 곧 어긋난다.
 */
export function buildClipRows(rows: readonly LayerRow[], durationFrames: number): ClipRow[] {
  return rows.map((row) => {
    const layer = row.layer
    const range = layerRange(layer, durationFrames)
    const frames = new Set<number>()
    for (const track of layer.tracks) {
      // 키가 하나뿐인 트랙은 시간에 따라 변하지 않는다. 점을 찍으면 거짓말이 된다.
      if (track.keys.length <= 1) continue
      for (const key of track.keys) frames.add(key.f)
    }
    return {
      layerId: layer.id,
      name: layer.name,
      type: layer.type,
      depth: row.depth,
      isFolder: layer.type === 'group',
      visible: layer.visible,
      locked: layer.locked,
      clipped: layer.clipToBelow === true,
      start: range.start,
      end: range.end,
      explicit: range.explicit,
      inFade: typeof layer.inFade === 'number' && layer.inFade > 0 ? Math.round(layer.inFade) : 0,
      outFade:
        typeof layer.outFade === 'number' && layer.outFade > 0 ? Math.round(layer.outFade) : 0,
      keyFrames: [...frames].sort((a, b) => a - b),
    }
  })
}

/** 낭독기가 읽을 클립 한 줄. */
export function describeClip(row: ClipRow, fps: number): string {
  const parts = [row.isFolder ? `폴더 ${row.name}` : row.name]
  if (row.explicit) {
    const sec = ((row.end - row.start + 1) / Math.max(1, fps)).toFixed(2)
    parts.push(`구간 ${row.start}부터 ${row.end}까지, ${row.end - row.start + 1}프레임, ${sec}초`)
  } else {
    parts.push('구간 없음, 처음부터 끝까지 보임')
  }
  if (row.inFade > 0) parts.push(`서서히 나타남 ${row.inFade}프레임`)
  if (row.outFade > 0) parts.push(`서서히 사라짐 ${row.outFade}프레임`)
  if (row.clipped) parts.push('아래 모양으로 잘림')
  if (!row.visible) parts.push('숨김')
  if (row.locked) parts.push('잠김')
  if (row.keyFrames.length > 0) parts.push(`키프레임 ${row.keyFrames.length}개`)
  return parts.join(', ')
}

/** 인스펙터와 같은 순서로 늘어놓는다. 위아래로 눈이 튀지 않게. */
const ROW_ORDER: readonly TrackProp[] = [
  'translateX',
  'translateY',
  'scale',
  'scaleX',
  'scaleY',
  'rotate',
  'rotateX',
  'rotateY',
  'skewX',
  'skewY',
  'opacity',
  'blur',
  'reveal',
  'charIn',
  'anchorX',
  'anchorY',
]

export const PROP_LABELS: Record<TrackProp, string> = {
  translateX: '가로 위치',
  translateY: '세로 위치',
  scale: '크기',
  scaleX: '가로 크기',
  scaleY: '세로 크기',
  rotate: '회전',
  rotateX: '가로축 회전',
  rotateY: '세로축 회전',
  skewX: '가로 기울임',
  skewY: '세로 기울임',
  opacity: '불투명도',
  blur: '흐림',
  reveal: '가리기',
  charIn: '글자 등장',
  anchorX: '기준점 가로',
  anchorY: '기준점 세로',
}

export const INTERP_LABELS: Record<Interp, string> = {
  bezier: '베지어',
  linear: '선형',
  hold: '홀드',
  spring: '스프링',
  samples: '샘플',
}

/**
 * 트랙을 타임라인에 띄울지 판정한다.
 *
 * 키가 2개 이상이면 당연히 띄운다. 키가 하나뿐이어도 스톱워치를 켠 직후라면
 * (armed) 띄워야 한다. 안 그러면 스톱워치를 켠 뒤 아무 일도 안 일어난 것처럼 보인다.
 */
export function buildTimelineModel(
  layer: Layer,
  timeline: TimelineConfig,
  armedProps: ReadonlySet<TrackProp>,
): TimelineModel {
  const rows: TrackRow[] = []
  for (const prop of ROW_ORDER) {
    const track = layer.tracks.find((t) => t.prop === prop)
    if (!track) continue
    if (track.keys.length <= 1 && !armedProps.has(prop)) continue
    rows.push({
      prop,
      label: PROP_LABELS[prop],
      unit: track.unit,
      keys: track.keys,
    })
  }
  return {
    layerId: layer.id,
    layerName: layer.name,
    fps: timeline.fps,
    durationFrames: timeline.durationFrames,
    rows,
  }
}

const round = (v: number, digits: number): number => {
  const f = 10 ** digits
  return Math.round(v * f) / f
}

/** 화면 낭독기가 읽을 값 표현. 기호 대신 단어를 쓴다. */
export function formatPropValue(prop: TrackProp, value: number): string {
  switch (prop) {
    case 'scale':
    case 'scaleX':
    case 'scaleY':
    case 'opacity':
    case 'reveal':
      return `${round(value * 100, 1)}퍼센트`
    case 'rotate':
    case 'rotateX':
    case 'rotateY':
    case 'skewX':
    case 'skewY':
      return `${round(value, 2)}도`
    case 'translateX':
    case 'translateY':
    case 'blur':
      return `${round(value, 2)}픽셀`
    default:
      return `${round(value, 3)}`
  }
}

export function describeTrack(row: TrackRow): string {
  return `${row.label} 트랙, 키프레임 ${row.keys.length}개`
}

/** 낭독기가 읽을 문장 형식을 만든다. */
export function describeKeyframe(row: TrackRow, index: number): string {
  const key = row.keys[index]
  if (!key) return `${row.label} 트랙, 키프레임 없음`
  return [
    `${row.label} 트랙`,
    `키프레임 ${row.keys.length}개 중 ${index + 1}번째`,
    `프레임 ${key.f}`,
    `값 ${formatPropValue(row.prop, key.v)}`,
    `보간 ${INTERP_LABELS[key.interp]}`,
  ].join(', ')
}

// ---------------------------------------------------------------------------
// 키프레임 마커 모양
// ---------------------------------------------------------------------------

/**
 * 마커 모양이 보간 타입을 나타낸다.
 * 밝기만으로 구분하면 저대비 화면에서 타입을 읽을 수 없다.
 */
export type KeyShape = 'diamond' | 'circle' | 'square' | 'star' | 'triangle'

export function shapeForInterp(interp: Interp): KeyShape {
  switch (interp) {
    case 'linear':
      return 'circle'
    case 'hold':
      return 'square'
    case 'spring':
      return 'star'
    case 'samples':
      return 'triangle'
    case 'bezier':
    default:
      return 'diamond'
  }
}

/** 경로만 만든다. 채우기와 선은 호출자가 정한다. */
export function keyShapePath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  shape: KeyShape,
  r: number,
): void {
  ctx.beginPath()
  switch (shape) {
    case 'circle':
      ctx.arc(x, y, r * 0.92, 0, Math.PI * 2)
      break
    case 'square': {
      const s = r * 0.86
      ctx.rect(x - s, y - s, s * 2, s * 2)
      break
    }
    case 'triangle':
      ctx.moveTo(x, y - r)
      ctx.lineTo(x + r * 0.95, y + r * 0.75)
      ctx.lineTo(x - r * 0.95, y + r * 0.75)
      ctx.closePath()
      break
    case 'star': {
      const inner = r * 0.46
      for (let i = 0; i < 10; i++) {
        const rad = i % 2 === 0 ? r : inner
        // -90도에서 시작해야 별 꼭짓점이 위를 본다.
        const a = -Math.PI / 2 + (i * Math.PI) / 5
        const px = x + Math.cos(a) * rad
        const py = y + Math.sin(a) * rad
        if (i === 0) ctx.moveTo(px, py)
        else ctx.lineTo(px, py)
      }
      ctx.closePath()
      break
    }
    case 'diamond':
    default:
      ctx.moveTo(x, y - r)
      ctx.lineTo(x + r, y)
      ctx.lineTo(x, y + r)
      ctx.lineTo(x - r, y)
      ctx.closePath()
      break
  }
}

// ---------------------------------------------------------------------------
// 격자 간격
// ---------------------------------------------------------------------------

const STEP_CHOICES: readonly number[] = [1, 2, 5, 10, 15, 20, 30, 60, 120]
const STEP_MAX = 120

/** 화면에서 minPx 이상 벌어지는 가장 촘촘한 프레임 간격. */
export function chooseGridStep(pxPerFrame: number, minPx: number): number {
  for (const s of STEP_CHOICES) {
    if (s * pxPerFrame >= minPx) return s
  }
  return STEP_MAX
}

// ---------------------------------------------------------------------------
// 타임라인 기하 / 히트 테스트
// ---------------------------------------------------------------------------

/**
 * 타임라인은 두 층이다.
 *
 *   눈금자 | 클립 (문서의 모든 레이어) | 구분 머리 | 속성 트랙 (고른 레이어 하나)
 *
 * 층이 둘이므로 세로 좌표를 계산하는 곳이 여기 한 군데뿐이어야 한다. 캔버스와
 * 왼쪽 머리 열이 각자 더하기 시작하면 두 열이 한 픽셀씩 어긋나고, 그 순간
 * "이름은 A 인데 눌리는 것은 B" 가 된다.
 */
export interface TimelineGeometry {
  rulerH: number
  /** 속성 트랙 한 줄 높이 */
  rowH: number
  /** 클립 한 줄 높이. 안에 막대를 그려야 해서 트랙보다 조금 높다. */
  clipRowH: number
  clipCount: number
  /** 두 층 사이 구분 머리. 속성 행이 없으면 자리를 차지하지 않는다. */
  sectionH: number
  trackCount: number
  axis: TimeAxis
}

/** 클립 층이 끝나는 y. 구분 머리가 시작하는 자리이기도 하다. */
export function clipBottomY(geo: TimelineGeometry): number {
  return geo.rulerH + geo.clipCount * geo.clipRowH
}

/** 속성 층의 첫 줄이 시작하는 y. */
export function tracksTopY(geo: TimelineGeometry): number {
  return clipBottomY(geo) + (geo.trackCount > 0 ? geo.sectionH : 0)
}

/** 내용 전체 높이. 스크롤 영역의 minHeight 가 이 값이다. */
export function timelineContentH(geo: TimelineGeometry): number {
  return tracksTopY(geo) + geo.trackCount * geo.rowH
}

export function clipRowYTop(index: number, geo: TimelineGeometry): number {
  return geo.rulerH + index * geo.clipRowH
}

export function clipRowIndexAtY(y: number, geo: TimelineGeometry): number {
  if (y < geo.rulerH) return -1
  const i = Math.floor((y - geo.rulerH) / geo.clipRowH)
  return i >= 0 && i < geo.clipCount ? i : -1
}

export function rowYCenter(index: number, geo: TimelineGeometry): number {
  return tracksTopY(geo) + index * geo.rowH + geo.rowH / 2
}

export function rowIndexAtY(y: number, geo: TimelineGeometry, rowCount: number): number {
  const top = tracksTopY(geo)
  if (y < top) return -1
  const i = Math.floor((y - top) / geo.rowH)
  return i >= 0 && i < rowCount ? i : -1
}

export interface KeyHit {
  prop: TrackProp
  frame: number
  index: number
  rowIndex: number
}

/**
 * 가장 가까운 키프레임을 찾는다. 행을 먼저 좁히지 않고 반경 안의 후보 중
 * 최소 제곱거리를 고른다. 행 경계에 걸친 마커도 잡힌다.
 */
export function hitTestKey(
  model: TimelineModel,
  geo: TimelineGeometry,
  x: number,
  y: number,
  radius: number,
): KeyHit | null {
  let best: KeyHit | null = null
  let bestDist = radius * radius
  for (let r = 0; r < model.rows.length; r++) {
    const row = model.rows[r]
    if (!row) continue
    const cy = rowYCenter(r, geo)
    const dy = y - cy
    if (Math.abs(dy) > radius) continue
    for (let i = 0; i < row.keys.length; i++) {
      const key = row.keys[i]
      if (!key) continue
      const dx = x - frameToX(key.f, geo.axis)
      const d = dx * dx + dy * dy
      if (d <= bestDist) {
        bestDist = d
        best = { prop: row.prop, frame: key.f, index: i, rowIndex: r }
      }
    }
  }
  return best
}

// ---------------------------------------------------------------------------
// 클립 히트 테스트
// ---------------------------------------------------------------------------

/** 클립 막대의 위아래 여백. 줄과 막대 사이가 붙으면 어디까지가 한 줄인지 안 보인다. */
export const CLIP_BAR_PAD = 4

/** 막대 양끝에서 "길이 조절" 로 잡히는 폭. 손가락은 더 넓게 잡아야 한다. */
export const CLIP_EDGE_PX = 7

export type ClipPart = 'body' | 'start' | 'end'

export interface ClipHit {
  rowIndex: number
  layerId: string
  part: ClipPart
}

export function clipBarRect(
  row: ClipRow,
  index: number,
  geo: TimelineGeometry,
): { x0: number; x1: number; y: number; h: number } {
  const y = clipRowYTop(index, geo) + CLIP_BAR_PAD
  const h = Math.max(6, geo.clipRowH - CLIP_BAR_PAD * 2)
  // 끝 프레임은 포함이다. 그 프레임도 한 칸을 차지하므로 오른쪽 끝은 end + 1 이다.
  return { x0: frameToX(row.start, geo.axis), x1: frameToX(row.end + 1, geo.axis), y, h }
}

/**
 * 클립 막대를 집는다.
 *
 * 양끝은 길이 조절, 가운데는 통째로 이동이다. 막대가 아주 짧으면 양끝이 서로를
 * 먹어 가운데가 사라진다. 그래서 잡는 폭을 막대 폭의 1/3 로도 한 번 더 묶는다.
 */
export function hitTestClip(
  rows: readonly ClipRow[],
  geo: TimelineGeometry,
  x: number,
  y: number,
  edgePx = CLIP_EDGE_PX,
): ClipHit | null {
  const index = clipRowIndexAtY(y, geo)
  if (index < 0) return null
  const row = rows[index]
  if (!row) return null

  const { x0, x1 } = clipBarRect(row, index, geo)
  // 세로는 줄 전체를 받는다. 막대 여백까지 죽은 자리로 두면 잡기가 까다로워진다.
  if (x < x0 - edgePx || x > x1 + edgePx) return null

  const edge = Math.min(edgePx, Math.max(2, (x1 - x0) / 3))
  if (x <= x0 + edge) return { rowIndex: index, layerId: row.layerId, part: 'start' }
  if (x >= x1 - edge) return { rowIndex: index, layerId: row.layerId, part: 'end' }
  return { rowIndex: index, layerId: row.layerId, part: 'body' }
}

/**
 * 클립 막대를 끈 결과.
 *
 * 순수 함수로 빼 둔 이유는 이 계산이 손맛의 전부이기 때문이다. 통째로 옮길 때
 * 여러 장의 간격이 유지되는가, 끝에 닿으면 전부가 함께 멈추는가, 양끝을 안쪽으로
 * 밀어도 뒤집히지 않는가. 셋 다 컴포넌트 안에 두면 손으로만 확인할 수 있다.
 *
 * 통째로 옮길 때는 델타 하나를 "전부가 구간 안에 남는 범위" 로 묶은 뒤 모두에게
 * 같은 값을 더한다. 장마다 따로 자르면 끝에 닿은 것만 멈추고 나머지는 계속 가서
 * 간격이 무너진다.
 */
export function resolveClipDrag(
  part: ClipPart,
  items: readonly { layerId: string; start: number; end: number }[],
  delta: number,
  lastFrame: number,
): { layerId: string; inFrame: number; outFrame: number }[] {
  if (items.length === 0) return []
  const clip = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v)

  if (part === 'body') {
    const minStart = Math.min(...items.map((i) => i.start))
    const maxEnd = Math.max(...items.map((i) => i.end))
    const d = clip(delta, -minStart, lastFrame - maxEnd)
    return items.map((i) => ({ layerId: i.layerId, inFrame: i.start + d, outFrame: i.end + d }))
  }

  if (part === 'start') {
    return items.map((i) => ({
      layerId: i.layerId,
      // 시작이 끝을 넘지 않게 묶는다. 한 프레임짜리 구간까지는 허용한다.
      inFrame: clip(i.start + delta, 0, i.end),
      outFrame: i.end,
    }))
  }

  return items.map((i) => ({
    layerId: i.layerId,
    inFrame: i.start,
    outFrame: clip(i.end + delta, i.start, lastFrame),
  }))
}

// ---------------------------------------------------------------------------
// 타임라인 그리기
// ---------------------------------------------------------------------------

export interface TimelineDrawOptions {
  theme: TimelineTheme
  width: number
  height: number
  geo: TimelineGeometry
  fps: number
  durationFrames: number
  /** 위층. 문서의 모든 레이어가 언제 보이는가. */
  clips: readonly ClipRow[]
  /** 아래층. 고른 레이어의 속성 트랙. 없으면 층 자체를 그리지 않는다. */
  model: TimelineModel | null
  playhead: number
  /** `${prop}:${frame}` 집합 */
  selected: ReadonlySet<string>
  hovered: string | null
  /** 지금 고른 레이어들. 클립 막대의 테가 여기서 갈린다. */
  selectedLayerIds: ReadonlySet<string>
  hoveredLayerId: string | null
  /** 레이어 패널에서 끌어오는 중일 때 놓일 자리. 없으면 null 이다. */
  drop: { layerId: string; start: number; end: number } | null
  loopMode: LoopMode
  /**
   * 세로 스크롤 오프셋 (CSS px).
   *
   * 캔버스는 내용 전체 높이라서 스크롤하면 눈금자가 함께 밀려 올라간다.
   * 눈금자만 이 값만큼 내려 그려, 스크롤해도 화면 위에 붙어 있는 것처럼 보이게
   * 한다. 히트 테스트(Timeline.tsx)도 반드시 같은 값으로 눈금자 영역을 판정해야
   * 한다. 생략하면 0 이고, 그때의 그림은 예전과 같다.
   */
  scrollY?: number
}

export function selectionId(prop: TrackProp, frame: number): string {
  return `${prop}:${frame}`
}

const LOOP_LABELS: Record<LoopMode, string> = {
  once: '한 번만',
  loop: '반복 구간',
  pingPong: '왕복 구간',
  loopWithHold: '반복 + 멈춤',
}

function line(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number): void {
  ctx.beginPath()
  ctx.moveTo(x0, y0)
  ctx.lineTo(x1, y1)
  ctx.stroke()
}

/**
 * 모서리가 둥근 사각형 경로.
 *
 * ctx.roundRect 를 쓰지 않는다. 사파리 16 미만에 없고, 그리기 테스트가 쓰는 가짜
 * 컨텍스트에도 없다. 경로 명령 네 개면 되는 일에 지원 여부를 걸 이유가 없다.
 */
function barPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  radius: number,
): void {
  const r = Math.max(0, Math.min(radius, w / 2, h / 2))
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.lineTo(x + w - r, y)
  ctx.arcTo(x + w, y, x + w, y + r, r)
  ctx.lineTo(x + w, y + h - r)
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r)
  ctx.lineTo(x + r, y + h)
  ctx.arcTo(x, y + h, x, y + h - r, r)
  ctx.lineTo(x, y + r)
  ctx.arcTo(x, y, x + r, y, r)
  ctx.closePath()
}

/**
 * 클립 한 줄.
 *
 * 구간이 없는 레이어는 속이 빈 점선 띠다. "처음부터 끝까지 보인다" 와 "전 구간으로
 * 맞춰 두었다" 를 눈으로 갈라야 하기 때문이다. 앞의 것은 길이를 바꾸면 따라 늘어난다.
 *
 * 색 하나에 기대지 않는다. 숨긴 레이어는 흐리게 + 빗금, 잘리는 레이어는 왼쪽에
 * 꺾쇠, 고른 레이어는 굵은 테다. 무채색 화면에서 밝기만으로는 세 상태를 못 가른다.
 */
function drawClipRow(
  ctx: CanvasRenderingContext2D,
  o: TimelineDrawOptions,
  row: ClipRow,
  index: number,
): void {
  const { theme, width, geo } = o
  const y0 = clipRowYTop(index, geo)
  const bar = clipBarRect(row, index, geo)

  if (index % 2 === 1) {
    ctx.fillStyle = theme.surfaceRaised
    ctx.globalAlpha = 0.5
    ctx.fillRect(0, y0, width, geo.clipRowH)
    ctx.globalAlpha = 1
  }
  ctx.strokeStyle = theme.border
  ctx.lineWidth = 1
  line(ctx, 0, y0 + geo.clipRowH - 0.5, width, y0 + geo.clipRowH - 0.5)

  const selected = o.selectedLayerIds.has(row.layerId)
  const hovered = o.hoveredLayerId === row.layerId
  // 화면 밖까지 좌표를 늘리면 arcTo 가 큰 수를 받는다. 보이는 만큼만 자른다.
  const x0 = Math.max(-8, bar.x0)
  const x1 = Math.min(width + 8, bar.x1)
  if (x1 <= x0) return
  /*
   * 최소 폭 2px.
   *
   * 한 프레임짜리 구간을 축소해 놓으면 폭이 1px 아래로 내려간다. 그대로 그리면
   * 둥근 모서리 경로가 뒤집혀 아무것도 안 보이고, 사용자는 구간이 사라진 줄 안다.
   * 히트 테스트는 실제 좌표를 쓰므로(clipBarRect) 잡는 자리는 달라지지 않는다.
   */
  const w = Math.max(2, x1 - x0)

  if (!row.explicit) {
    ctx.globalAlpha = row.visible ? 0.55 : 0.25
    ctx.strokeStyle = selected ? theme.accent : theme.borderStrong
    ctx.lineWidth = selected ? 2 : 1
    ctx.setLineDash([5, 4])
    barPath(ctx, x0 + 0.5, bar.y + 0.5, w - 1, bar.h - 1, 3)
    ctx.stroke()
    ctx.setLineDash([])
    ctx.globalAlpha = 1
  } else {
    ctx.globalAlpha = row.visible ? 1 : 0.4
    barPath(ctx, x0, bar.y, w, bar.h, 3)
    ctx.fillStyle = row.isFolder ? theme.surfaceHover : theme.accentSoft
    ctx.fill()

    /*
     * 페이드는 막대 안쪽을 바탕색으로 깎아 삼각형을 만든다.
     *
     * 그라디언트를 쓰지 않는 이유는 이 캔버스가 CSS 변수에서 읽은 색 문자열만
     * 다루기 때문이다. 삼각형이면 색 하나로 끝나고, 무엇보다 "여기서부터
     * 서서히" 라는 사실이 모양으로 남는다. 페이드 0 이 기본이라 딱딱 전환하는
     * 편집에서는 이 그림이 아예 나오지 않는다.
     */
    const fadeShade = (fromFrame: number, toFrame: number, fromLeft: boolean): void => {
      const fx = frameToX(fromFrame, geo.axis)
      const tx = frameToX(toFrame, geo.axis)
      if (Math.abs(tx - fx) < 1) return
      ctx.save()
      barPath(ctx, x0, bar.y, w, bar.h, 3)
      ctx.clip()
      ctx.beginPath()
      if (fromLeft) {
        ctx.moveTo(fx, bar.y)
        ctx.lineTo(tx, bar.y)
        ctx.lineTo(fx, bar.y + bar.h)
      } else {
        ctx.moveTo(fx, bar.y)
        ctx.lineTo(tx, bar.y)
        ctx.lineTo(tx, bar.y + bar.h)
      }
      ctx.closePath()
      ctx.fillStyle = theme.surface
      ctx.globalAlpha = 0.85
      ctx.fill()
      ctx.restore()
    }
    if (row.inFade > 0) fadeShade(row.start, row.start + row.inFade, true)
    if (row.outFade > 0) fadeShade(row.end + 1 - row.outFade, row.end + 1, false)

    if (!row.visible) {
      // 빗금. 흐리게만 두면 다른 흐린 상태와 구별되지 않는다.
      ctx.save()
      barPath(ctx, x0, bar.y, w, bar.h, 3)
      ctx.clip()
      ctx.strokeStyle = theme.textFaint
      ctx.lineWidth = 1
      for (let hx = x0 - bar.h; hx < x1 + bar.h; hx += 6) {
        line(ctx, hx, bar.y + bar.h, hx + bar.h, bar.y)
      }
      ctx.restore()
    }

    // 키프레임 눈금. 이 레이어가 구간 안에서 실제로 움직이는 지점이다.
    for (const f of row.keyFrames) {
      const kx = frameToX(f, geo.axis)
      if (kx < x0 + 1 || kx > x1 - 1) continue
      ctx.strokeStyle = theme.text
      ctx.lineWidth = 1
      line(ctx, Math.round(kx) + 0.5, bar.y + 2, Math.round(kx) + 0.5, bar.y + bar.h - 2)
    }

    barPath(ctx, x0 + 0.5, bar.y + 0.5, w - 1, bar.h - 1, 3)
    ctx.strokeStyle = selected ? theme.accent : hovered ? theme.text : theme.borderStrong
    ctx.lineWidth = selected ? 2 : 1
    ctx.stroke()
    ctx.globalAlpha = 1
  }

  // 잡는 자리. 커서가 올라간 줄에서만 낸다. 늘 그리면 짧은 막대가 손잡이로 덮인다.
  // 잠긴 줄에는 내지 않는다. 잡을 수 없는 자리에 손잡이를 그리면 고장으로 읽힌다.
  if (hovered && !row.locked && w > 14) {
    ctx.strokeStyle = theme.text
    ctx.lineWidth = 2
    line(ctx, x0 + 2.5, bar.y + 3, x0 + 2.5, bar.y + bar.h - 3)
    line(ctx, x1 - 2.5, bar.y + 3, x1 - 2.5, bar.y + bar.h - 3)
  }

  // 이름. 막대가 좁으면 아예 쓰지 않는다. 반쯤 잘린 글자는 읽는 데 방해만 된다.
  const label = `${row.clipped ? '⌐ ' : ''}${row.name}${row.explicit ? '' : ' · 전체'}`
  if (w > 40) {
    ctx.save()
    barPath(ctx, x0 + 3, bar.y, w - 6, bar.h, 3)
    ctx.clip()
    ctx.font = `${row.isFolder ? '600 ' : ''}10px ${theme.fontUi}`
    ctx.fillStyle = row.visible ? theme.text : theme.textFaint
    ctx.textBaseline = 'middle'
    ctx.textAlign = 'left'
    ctx.fillText(label, x0 + 5, bar.y + bar.h / 2)
    ctx.restore()
  }
}

export function drawTimeline(ctx: CanvasRenderingContext2D, o: TimelineDrawOptions): void {
  const { theme, width, height, geo, model } = o
  const { axis, rulerH, rowH } = geo
  const duration = Math.max(1, o.durationFrames)
  const trackRows = model?.rows ?? []
  const scrollY = Math.max(0, o.scrollY ?? 0)

  ctx.clearRect(0, 0, width, height)
  ctx.fillStyle = theme.surface
  ctx.fillRect(0, 0, width, height)

  // 구간 밖은 어둡게 눕힌다. 어디까지가 결과물인지 한눈에 보여야 한다.
  const endX = frameToX(duration, axis)
  if (endX < width) {
    ctx.fillStyle = theme.bg
    ctx.fillRect(endX, 0, width - endX, height)
  }

  const gridStep = chooseGridStep(axis.pxPerFrame, 8)
  const labelStep = chooseGridStep(axis.pxPerFrame, 52)

  // 세로 격자
  ctx.lineWidth = 1
  const firstGrid = Math.max(0, Math.floor(axis.scrollFrame / gridStep) * gridStep)
  for (let f = firstGrid; f <= duration; f += gridStep) {
    const x = Math.round(frameToX(f, axis)) + 0.5
    if (x < -1) continue
    if (x > width + 1) break
    ctx.strokeStyle = f % labelStep === 0 ? theme.borderStrong : theme.border
    line(ctx, x, rulerH, x, height)
  }

  // 초 단위 눈금. fps 가 12.5 처럼 정수가 아니어도 초는 정확히 찍힌다.
  const totalSec = duration / Math.max(1, o.fps)
  const secStep = totalSec > 6 ? 1 : totalSec > 2 ? 0.5 : 0.25
  ctx.strokeStyle = theme.borderStrong
  for (let s = 0; s <= totalSec + 1e-6; s += secStep) {
    const x = Math.round(frameToX(s * o.fps, axis)) + 0.5
    if (x < -1 || x > width + 1) continue
    line(ctx, x, 0, x, height)
  }

  // ---- 위층: 클립 (문서의 모든 레이어) ----
  for (let c = 0; c < o.clips.length; c++) {
    const clip = o.clips[c]
    if (clip) drawClipRow(ctx, o, clip, c)
  }

  if (o.clips.length === 0) {
    ctx.font = `12px ${theme.fontUi}`
    ctx.fillStyle = theme.textFaint
    ctx.textAlign = 'center'
    ctx.fillText('이미지나 도형을 넣으면 여기에 줄이 생깁니다', width / 2, rulerH + 20)
    ctx.textAlign = 'left'
  }

  /*
   * 끌어다 놓을 자리.
   *
   * 레이어 패널에서 끌어오는 중일 때만 나온다. 놓기 전에 결과를 보여 주지 않으면
   * 손을 떼고 나서야 어디에 앉았는지 알게 된다.
   */
  if (o.drop) {
    const at = o.clips.findIndex((c) => c.layerId === o.drop!.layerId)
    if (at >= 0) {
      const y = clipRowYTop(at, geo) + CLIP_BAR_PAD
      const h = Math.max(6, geo.clipRowH - CLIP_BAR_PAD * 2)
      const dx0 = frameToX(o.drop.start, axis)
      const dx1 = frameToX(o.drop.end + 1, axis)
      ctx.strokeStyle = theme.focus
      ctx.lineWidth = 2
      ctx.setLineDash([4, 3])
      barPath(ctx, dx0, y, Math.max(2, dx1 - dx0), h, 3)
      ctx.stroke()
      ctx.setLineDash([])
    }
  }

  // ---- 층 사이 구분 머리 ----
  if (trackRows.length > 0 && geo.sectionH > 0) {
    const sy = clipBottomY(geo)
    ctx.fillStyle = theme.surfaceRaised
    ctx.fillRect(0, sy, width, geo.sectionH)
    ctx.strokeStyle = theme.borderStrong
    ctx.lineWidth = 1
    line(ctx, 0, sy + 0.5, width, sy + 0.5)
    line(ctx, 0, sy + geo.sectionH - 0.5, width, sy + geo.sectionH - 0.5)
    ctx.font = `600 9px ${theme.fontUi}`
    ctx.fillStyle = theme.textMuted
    ctx.textBaseline = 'middle'
    ctx.textAlign = 'left'
    ctx.fillText(
      model ? `속성 · ${model.layerName}` : '속성',
      6,
      sy + geo.sectionH / 2,
    )
  }

  // ---- 아래층: 고른 레이어의 속성 트랙 ----
  if (model && trackRows.length === 0) {
    ctx.font = `12px ${theme.fontUi}`
    ctx.fillStyle = theme.textFaint
    ctx.textAlign = 'center'
    ctx.fillText(
      '인스펙터의 스톱워치를 눌러 속성에 애니메이션을 켜세요',
      width / 2,
      Math.min(height - 12, clipBottomY(geo) + 16),
    )
    ctx.textAlign = 'left'
  }

  const trackTop = tracksTopY(geo)
  for (let r = 0; r < trackRows.length; r++) {
    const row = trackRows[r]
    if (!row) continue
    const y0 = trackTop + r * rowH
    const cy = y0 + rowH / 2

    if (r % 2 === 1) {
      ctx.fillStyle = theme.surfaceRaised
      ctx.globalAlpha = 0.5
      ctx.fillRect(0, y0, width, rowH)
      ctx.globalAlpha = 1
    }
    ctx.strokeStyle = theme.border
    ctx.lineWidth = 1
    line(ctx, 0, y0 + rowH - 0.5, width, y0 + rowH - 0.5)

    // 세그먼트 바. 홀드 구간은 점선으로 그려 모양만으로 구분되게 한다.
    for (let i = 0; i < row.keys.length - 1; i++) {
      const a = row.keys[i]
      const b = row.keys[i + 1]
      if (!a || !b) continue
      const x0 = frameToX(a.f, axis)
      const x1 = frameToX(b.f, axis)
      if (x1 < 0 || x0 > width) continue
      ctx.strokeStyle = theme.accent
      ctx.globalAlpha = 0.55
      ctx.lineWidth = 3
      if (a.interp === 'hold') ctx.setLineDash([3, 3])
      line(ctx, x0, cy, x1, cy)
      ctx.setLineDash([])
      ctx.globalAlpha = 1
    }

    // 키프레임 마커
    for (let i = 0; i < row.keys.length; i++) {
      const key = row.keys[i]
      if (!key) continue
      const x = frameToX(key.f, axis)
      if (x < -12 || x > width + 12) continue
      const id = selectionId(row.prop, key.f)
      const isSelected = o.selected.has(id)
      const isHovered = o.hovered === id
      const shape = shapeForInterp(key.interp)
      const r0 = isSelected ? 6.5 : 5.5

      /*
       * 선택은 크기 + 어두운 테 + 바깥 링 세 가지로 표시한다.
       *
       * 선택된 키의 테를 바탕색으로 칠하는 것이 요령이다. 채움과 바깥 링이 둘 다
       * 밝은 무채색이라, 그 사이에 어두운 선이 없으면 둘이 한 덩어리로 뭉쳐
       * 그냥 큰 점 하나로 보인다.
       */
      if (isSelected) {
        keyShapePath(ctx, x, cy, shape, r0 + 3.5)
        ctx.strokeStyle = theme.focus
        ctx.lineWidth = 1.5
        ctx.stroke()
      }

      keyShapePath(ctx, x, cy, shape, r0)
      ctx.fillStyle = isSelected ? theme.accent : isHovered ? theme.surfaceHover : theme.surfaceRaised
      ctx.fill()
      ctx.strokeStyle = isSelected ? theme.bg : theme.borderStrong
      ctx.lineWidth = isSelected ? 2.25 : 1.5
      ctx.stroke()
    }
  }

  /*
   * ---- 눈금자 ----
   *
   * 내용(클립 / 트랙)을 전부 그린 뒤, 스크롤 오프셋만큼 내린 자리에 덮어 그린다.
   * 그래야 세로로 스크롤해도 눈금자가 항상 보이는 영역의 맨 위에 남고, 그 밑을
   * 지나가는 줄들은 눈금자 밑으로 사라진다. scrollY 0 이면 예전 자리 그대로다.
   */
  ctx.save()
  ctx.translate(0, scrollY)

  ctx.fillStyle = theme.surfaceRaised
  ctx.fillRect(0, 0, width, rulerH)
  ctx.strokeStyle = theme.border
  ctx.lineWidth = 1
  line(ctx, 0, rulerH - 0.5, width, rulerH - 0.5)

  ctx.textBaseline = 'middle'
  ctx.textAlign = 'left'
  ctx.font = `600 10px ${theme.fontUi}`
  ctx.fillStyle = theme.textMuted
  for (let s = 0; s <= totalSec + 1e-6; s += secStep) {
    const x = frameToX(s * o.fps, axis)
    if (x < -20 || x > width + 20) continue
    const label = secStep < 1 ? `${round(s, 2)}s` : `${round(s, 0)}s`
    ctx.fillText(label, x + 3, 9)
  }

  ctx.font = `10px ${theme.fontMono}`
  ctx.fillStyle = theme.textFaint
  for (let f = firstGrid; f <= duration; f += labelStep) {
    const x = frameToX(f, axis)
    if (x < -20) continue
    if (x > width + 20) break
    ctx.fillText(String(f), x + 3, rulerH - 9)
  }

  // 반복 구간 표시. 눈금자 아래쪽에 얇은 띠와 양끝 브래킷을 둔다.
  const loopY = rulerH - 3.5
  const loopX0 = Math.max(0, frameToX(0, axis))
  const loopX1 = Math.min(width, endX)
  if (loopX1 > loopX0) {
    ctx.strokeStyle = theme.accent
    ctx.lineWidth = 2
    line(ctx, loopX0, loopY, loopX1, loopY)
    line(ctx, loopX0 + 1, loopY - 4, loopX0 + 1, loopY + 2)
    line(ctx, loopX1 - 1, loopY - 4, loopX1 - 1, loopY + 2)
    ctx.lineWidth = 1
    if (loopX1 - loopX0 > 120) {
      ctx.font = `600 9px ${theme.fontUi}`
      ctx.fillStyle = theme.accent
      ctx.textAlign = 'center'
      ctx.fillText(LOOP_LABELS[o.loopMode], (loopX0 + loopX1) / 2, rulerH - 9)
      ctx.textAlign = 'left'
    }
  }

  ctx.restore()

  // 재생 헤드. 화면 높이를 가로지르는 선이라 점으로 찍히는 키와 모양부터 다르다.
  // 깃발(삼각형)은 눈금자에 붙는 표식이므로 눈금자와 같이 스크롤을 따라 내린다.
  const px = Math.round(frameToX(o.playhead, axis)) + 0.5
  if (px >= -1 && px <= width + 1) {
    ctx.strokeStyle = theme.warn
    ctx.lineWidth = 1
    line(ctx, px, 0, px, height)
    ctx.fillStyle = theme.warn
    ctx.beginPath()
    ctx.moveTo(px - 5, scrollY)
    ctx.lineTo(px + 5, scrollY)
    ctx.lineTo(px, scrollY + 8)
    ctx.closePath()
    ctx.fill()
  }
}

// ---------------------------------------------------------------------------
// 그래프 에디터 그리기 조각
// ---------------------------------------------------------------------------

export interface PlotRect {
  x: number
  y: number
  w: number
  h: number
}

export function drawGraphBackground(
  ctx: CanvasRenderingContext2D,
  theme: TimelineTheme,
  width: number,
  height: number,
  plot: PlotRect,
): void {
  ctx.clearRect(0, 0, width, height)
  ctx.fillStyle = theme.surface
  ctx.fillRect(0, 0, width, height)
  ctx.fillStyle = theme.bg
  ctx.fillRect(plot.x, plot.y, plot.w, plot.h)
  ctx.strokeStyle = theme.border
  ctx.lineWidth = 1
  ctx.strokeRect(plot.x + 0.5, plot.y + 0.5, plot.w - 1, plot.h - 1)
}

/**
 * 가로 기준선. 0선과 1선은 항상 얇게 그린다.
 * 오버슈트가 어디를 넘었는지 눈으로 재는 기준이 사라지면 그래프가 무의미해진다.
 */
export function drawGuideLine(
  ctx: CanvasRenderingContext2D,
  theme: TimelineTheme,
  plot: PlotRect,
  yAxis: ValueAxis,
  value: number,
  label: string,
  strong: boolean,
): void {
  const y = Math.round(valueToY(value, yAxis)) + 0.5
  if (y < plot.y || y > plot.y + plot.h) return
  ctx.strokeStyle = strong ? theme.borderStrong : theme.border
  ctx.lineWidth = 1
  if (!strong) ctx.setLineDash([2, 4])
  line(ctx, plot.x, y, plot.x + plot.w, y)
  ctx.setLineDash([])
  ctx.font = `10px ${theme.fontMono}`
  ctx.fillStyle = theme.textFaint
  ctx.textAlign = 'right'
  ctx.textBaseline = 'middle'
  ctx.fillText(label, plot.x - 6, y)
  ctx.textAlign = 'left'
}

export function drawPolyline(
  ctx: CanvasRenderingContext2D,
  points: readonly (readonly [number, number])[],
  color: string,
  lineWidth: number,
  dash?: readonly number[],
): void {
  if (points.length < 2) return
  ctx.strokeStyle = color
  ctx.lineWidth = lineWidth
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  if (dash) ctx.setLineDash([...dash])
  ctx.beginPath()
  const first = points[0]
  if (!first) return
  ctx.moveTo(first[0], first[1])
  for (let i = 1; i < points.length; i++) {
    const p = points[i]
    if (!p) continue
    ctx.lineTo(p[0], p[1])
  }
  ctx.stroke()
  ctx.setLineDash([])
}

/** 제어 암. 핸들이 어느 키에 붙어 있는지 보여준다. */
export function drawControlArm(
  ctx: CanvasRenderingContext2D,
  theme: TimelineTheme,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): void {
  ctx.strokeStyle = theme.textFaint
  ctx.lineWidth = 1
  ctx.setLineDash([3, 3])
  line(ctx, x0, y0, x1, y1)
  ctx.setLineDash([])
}

export function drawHandlePoint(
  ctx: CanvasRenderingContext2D,
  theme: TimelineTheme,
  x: number,
  y: number,
  active: boolean,
): void {
  if (active) {
    ctx.beginPath()
    ctx.arc(x, y, 9, 0, Math.PI * 2)
    ctx.strokeStyle = theme.focus
    ctx.lineWidth = 1.5
    ctx.stroke()
  }
  ctx.beginPath()
  ctx.arc(x, y, active ? 6 : 5, 0, Math.PI * 2)
  ctx.fillStyle = active ? theme.accent : theme.surfaceRaised
  ctx.fill()
  // 잡은 손잡이의 테는 바탕색이다. 키프레임과 같은 이유다.
  ctx.strokeStyle = active ? theme.bg : theme.accent
  ctx.lineWidth = 2
  ctx.stroke()
}

/**
 * 프레임 틱.
 *
 * 현재 fps 로 실제 샘플되는 지점을 곡선 위에 찍는다. 어디가 성기게 샘플링되는지
 * 즉시 보이며, 모션블러 없는 부드러움 문제의 절반이 이것만으로 해결된다.
 * 빼면 안 되는 오버레이다.
 */
export function drawFrameTicks(
  ctx: CanvasRenderingContext2D,
  theme: TimelineTheme,
  plot: PlotRect,
  points: readonly (readonly [number, number])[],
): void {
  for (const p of points) {
    if (!p) continue
    const [x, y] = p
    ctx.strokeStyle = theme.border
    ctx.lineWidth = 1
    ctx.setLineDash([1, 3])
    line(ctx, x, plot.y + plot.h, x, y)
    ctx.setLineDash([])
    ctx.beginPath()
    ctx.arc(x, y, 2.6, 0, Math.PI * 2)
    ctx.fillStyle = theme.text
    ctx.fill()
  }
}

/** 그래프 위의 재생 헤드. 타임라인과 같은 색을 쓴다. */
export function drawGraphPlayhead(
  ctx: CanvasRenderingContext2D,
  theme: TimelineTheme,
  plot: PlotRect,
  x: number,
): void {
  if (x < plot.x || x > plot.x + plot.w) return
  const px = Math.round(x) + 0.5
  ctx.strokeStyle = theme.warn
  ctx.lineWidth = 1
  line(ctx, px, plot.y, px, plot.y + plot.h)
}
