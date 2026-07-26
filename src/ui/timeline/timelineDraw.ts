/**
 * 타임라인 / 그래프 에디터의 캔버스 그리기와 좌표 변환.
 *
 * React 를 모르는 순수 모듈이다. 상호작용 로직과 분리해 두면 그리기만 따로
 * 테스트할 수 있고, 타임라인과 그래프가 같은 좌표 규칙을 공유하게 된다.
 *
 * 색은 전부 CSS 변수에서 읽는다. 캔버스에 색을 하드코딩하면 라이트/다크
 * 전환 때 캔버스만 남아 떠 보인다.
 *
 * 타임라인과 접근성 트리는 반드시 여기 있는 같은 모델에서 파생시킨다.
 * 두 곳에서 따로 계산하면 곧 어긋난다.
 */

import type {
  Interp,
  Keyframe,
  Layer,
  LoopMode,
  TimelineConfig,
  TrackProp,
  TrackUnit,
} from '@/core/types.ts'

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

/** CSS 변수를 못 읽는 환경(테스트 등)에서 쓰는 값. 다크 토큰과 같다. */
const THEME_FALLBACK: TimelineTheme = {
  bg: '#0e0f13',
  surface: '#16181e',
  surfaceRaised: '#1c1f27',
  surfaceHover: '#232733',
  border: '#2a2f3a',
  borderStrong: '#3a4150',
  text: '#e9ebf2',
  textMuted: '#a8b0c2',
  textFaint: '#8b93a5',
  accent: '#3d7dff',
  accentSoft: 'rgba(61, 125, 255, 0.16)',
  danger: '#ff6b6b',
  warn: '#ffb648',
  focus: '#8ab4ff',
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

/** 인스펙터와 같은 순서로 늘어놓는다. 위아래로 눈이 튀지 않게. */
const ROW_ORDER: readonly TrackProp[] = [
  'translateX',
  'translateY',
  'scale',
  'scaleX',
  'scaleY',
  'rotate',
  'skewX',
  'skewY',
  'opacity',
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
  skewX: '가로 기울임',
  skewY: '세로 기울임',
  opacity: '불투명도',
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
      return `${round(value * 100, 1)}퍼센트`
    case 'rotate':
    case 'skewX':
    case 'skewY':
      return `${round(value, 2)}도`
    case 'translateX':
    case 'translateY':
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
 * 색만으로 구분하면 색각 이상 사용자가 타입을 읽을 수 없다.
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

export interface TimelineGeometry {
  rulerH: number
  rowH: number
  axis: TimeAxis
}

export function rowYCenter(index: number, geo: TimelineGeometry): number {
  return geo.rulerH + index * geo.rowH + geo.rowH / 2
}

export function rowIndexAtY(y: number, geo: TimelineGeometry, rowCount: number): number {
  if (y < geo.rulerH) return -1
  const i = Math.floor((y - geo.rulerH) / geo.rowH)
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
// 타임라인 그리기
// ---------------------------------------------------------------------------

export interface TimelineDrawOptions {
  theme: TimelineTheme
  width: number
  height: number
  geo: TimelineGeometry
  model: TimelineModel
  playhead: number
  /** `${prop}:${frame}` 집합 */
  selected: ReadonlySet<string>
  hovered: string | null
  loopMode: LoopMode
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

export function drawTimeline(ctx: CanvasRenderingContext2D, o: TimelineDrawOptions): void {
  const { theme, width, height, geo, model } = o
  const { axis, rulerH, rowH } = geo
  const duration = Math.max(1, model.durationFrames)

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
  const totalSec = duration / model.fps
  const secStep = totalSec > 6 ? 1 : totalSec > 2 ? 0.5 : 0.25
  ctx.strokeStyle = theme.borderStrong
  for (let s = 0; s <= totalSec + 1e-6; s += secStep) {
    const x = Math.round(frameToX(s * model.fps, axis)) + 0.5
    if (x < -1 || x > width + 1) continue
    line(ctx, x, 0, x, height)
  }

  // 눈금자
  ctx.fillStyle = theme.surfaceRaised
  ctx.fillRect(0, 0, width, rulerH)
  ctx.strokeStyle = theme.border
  line(ctx, 0, rulerH - 0.5, width, rulerH - 0.5)

  ctx.textBaseline = 'middle'
  ctx.textAlign = 'left'
  ctx.font = `600 10px ${theme.fontUi}`
  ctx.fillStyle = theme.textMuted
  for (let s = 0; s <= totalSec + 1e-6; s += secStep) {
    const x = frameToX(s * model.fps, axis)
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

  // 트랙 행
  if (model.rows.length === 0) {
    ctx.font = `12px ${theme.fontUi}`
    ctx.fillStyle = theme.textFaint
    ctx.textAlign = 'center'
    ctx.fillText(
      '인스펙터의 스톱워치를 눌러 속성에 애니메이션을 켜세요',
      width / 2,
      rulerH + (height - rulerH) / 2,
    )
    ctx.textAlign = 'left'
  }

  for (let r = 0; r < model.rows.length; r++) {
    const row = model.rows[r]
    if (!row) continue
    const y0 = rulerH + r * rowH
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

      // 선택은 색 + 두꺼운 외곽선 + 바깥 링까지 세 가지로 표시한다.
      if (isSelected) {
        keyShapePath(ctx, x, cy, shape, r0 + 3.5)
        ctx.strokeStyle = theme.focus
        ctx.lineWidth = 1.5
        ctx.stroke()
      }

      keyShapePath(ctx, x, cy, shape, r0)
      ctx.fillStyle = isSelected ? theme.accent : isHovered ? theme.surfaceHover : theme.surfaceRaised
      ctx.fill()
      ctx.strokeStyle = isSelected ? theme.text : theme.borderStrong
      ctx.lineWidth = isSelected ? 2.25 : 1.5
      ctx.stroke()
    }
  }

  // 재생 헤드. 선택(액센트)과 색이 겹치지 않게 경고색을 쓴다.
  const px = Math.round(frameToX(o.playhead, axis)) + 0.5
  if (px >= -1 && px <= width + 1) {
    ctx.strokeStyle = theme.warn
    ctx.lineWidth = 1
    line(ctx, px, 0, px, height)
    ctx.fillStyle = theme.warn
    ctx.beginPath()
    ctx.moveTo(px - 5, 0)
    ctx.lineTo(px + 5, 0)
    ctx.lineTo(px, 8)
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
  ctx.strokeStyle = active ? theme.text : theme.accent
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
