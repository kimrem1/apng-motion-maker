/**
 * 속도 / 값 그래프 에디터.
 *
 * 타임라인 영역을 대체하는 하단 시트다. 별도 창을 띄우지 않는다.
 * 기본 탭은 속도다. 사용자가 손대는 감각은 "빠르기"지 "값"이 아니기 때문이다.
 *
 * 저장되는 것은 값 그래프의 핸들 하나뿐이다. 속도 그래프는 파생 뷰이며,
 * 변환은 반드시 easing/curve.ts 의 segmentSpeed / speedToHandles 를 거친다.
 * 여기서 직접 계산하면 값 그래프와 속도 그래프가 조용히 어긋난다.
 *
 * 프레임 틱은 장식이 아니다. 현재 fps 에서 실제로 샘플되는 지점을 곡선 위에
 * 찍어 어디가 성기게 잡히는지 보여준다. 모션블러 없는 부드러움 문제의 절반이
 * 이 오버레이 하나로 해결된다.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'

import type { Handle, Keyframe, TrackProp } from '@/core/types.ts'
import {
  clamp01,
  formatCubicBezier,
  getBezierEasing,
  parseCubicBezier,
} from '@/easing/bezier.ts'
import {
  DEFAULT_IN,
  DEFAULT_OUT,
  displacementBudget,
  segmentSpeed,
  speedToHandles,
  STEP_ALLOWANCE,
} from '@/easing/curve.ts'
import { createSpringEasing } from '@/easing/spring.ts'
import { CHIP_PRESETS } from '@/easing/presets.ts'
import { getTrack, useDocumentStore } from '@/state/document.ts'
import { useTimelineUiStore, type GraphTab } from '@/state/timelineUi.ts'
import { useUiStore } from '@/state/ui.ts'
import {
  PROP_LABELS,
  drawControlArm,
  drawFrameTicks,
  drawGraphBackground,
  drawGraphPlayhead,
  drawGuideLine,
  drawHandlePoint,
  drawPolyline,
  frameToX,
  hitRadius,
  prepareCanvas,
  readTheme,
  valueToY,
  withinRadius,
  xToFrame,
  yToValue,
  type PlotRect,
  type TimeAxis,
  type ValueAxis,
} from './timelineDraw.ts'

// 플롯 여백. 왼쪽은 기준선 라벨(-0.35 / 1.35)이 들어갈 만큼 넓어야 한다.
const PAD_L = 46
const PAD_R = 18
const PAD_T = 18
const PAD_B = 26

/** 곡선 샘플 수. 화면 폭보다 촘촘하면 낭비다. */
const CURVE_SAMPLES = 192

/** y 뷰포트 기본값. 오버슈트가 잘리지 않게 위아래로 여유를 둔다. */
const BASE_Y_MIN = -0.35
const BASE_Y_MAX = 1.35

/** 핸들 x 스냅 후보. */
const SNAP_X = [0, 0.25, 1 / 3, 0.5, 2 / 3, 0.75, 1]
const SNAP_PX = 6

const ALLOWANCE_OPTIONS: readonly { value: keyof typeof STEP_ALLOWANCE; label: string }[] = [
  { value: 'sharpEdge', label: '선명한 엣지 (8px)' },
  { value: 'soft', label: '부드러운 요소 (16px)' },
  { value: 'text', label: '글자 (6px)' },
]

const GRAPH_CSS = `
.ge {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  height: 100%;
  border-top: 1px solid var(--border);
  background: var(--surface);
}

.ge__head {
  display: flex;
  align-items: center;
  gap: var(--sp-4);
  padding: var(--sp-2) var(--sp-4);
  border-bottom: 1px solid var(--border);
}

.ge__tabs {
  display: inline-flex;
  padding: 2px;
  border: 1px solid var(--border-strong);
  border-radius: var(--r-md);
  background: var(--bg);
}

.ge__tab {
  min-height: 24px;
  padding: 0 var(--sp-4);
  border: 1px solid transparent;
  border-radius: var(--r-sm);
  background: transparent;
  color: var(--text-muted);
  font-size: var(--fs-xs);
  font-weight: 700;
  letter-spacing: 0.04em;
}

.ge__tab[aria-pressed='true'] {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--text);
}

.ge__target {
  color: var(--text);
  font-size: var(--fs-sm);
  white-space: nowrap;
}

.ge__target b {
  color: var(--accent);
  font-weight: 600;
}

.ge__seg {
  display: flex;
  align-items: center;
  gap: var(--sp-1);
  color: var(--text-muted);
  font-size: var(--fs-xs);
  font-variant-numeric: tabular-nums;
}

.ge__spacer {
  margin-left: auto;
}

.ge__plot {
  position: relative;
  flex: 1;
  min-height: 120px;
}

.ge__plot canvas {
  width: 100%;
  height: 100%;
  touch-action: none;
  cursor: crosshair;
}

.ge__foot {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  padding: var(--sp-3) var(--sp-4);
  border-top: 1px solid var(--border);
}

.ge__chips {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-2);
}

.ge__chip {
  min-height: 24px;
  padding: 0 var(--sp-3);
  border: 1px solid var(--border-strong);
  border-radius: 999px;
  background: var(--surface-raised);
  color: var(--text-muted);
  font-size: var(--fs-xs);
}

.ge__chip:hover:not(:disabled) {
  border-color: var(--accent);
  color: var(--text);
}

/* 적용된 칩은 테두리 + 배경 + 접두 기호까지 바꾼다. 색 하나에 기대지 않는다. */
.ge__chip[aria-pressed='true'] {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--text);
  font-weight: 700;
}

.ge__row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--sp-3);
}

.ge__css {
  width: 260px;
  font-family: var(--font-mono);
  font-size: var(--fs-xs);
}

.ge__num {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-1);
  color: var(--text-faint);
  font-size: var(--fs-xs);
}

.ge__num input {
  width: 64px;
  font-family: var(--font-mono);
}

.ge__note {
  color: var(--text-faint);
  font-size: var(--fs-xs);
}

.ge__warn {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--sp-3);
  padding: var(--sp-2) var(--sp-3);
  border: 1px solid var(--warn);
  border-radius: var(--r-md);
  color: var(--text);
  font-size: var(--fs-xs);
  line-height: 1.5;
}

.ge__empty {
  display: flex;
  flex: 1;
  align-items: center;
  justify-content: center;
  padding: var(--sp-6);
  color: var(--text-faint);
  font-size: var(--fs-sm);
  text-align: center;
}
`

// ---------------------------------------------------------------------------
// 세그먼트 수학
// ---------------------------------------------------------------------------

/** 세그먼트의 정규화 이징. 값 = a.v + (b.v - a.v) * ease(p) 다. */
function segmentEase(a: Keyframe, b: Keyframe): (p: number) => number {
  switch (a.interp) {
    case 'hold':
      return () => 0
    case 'linear':
      return (p) => p
    case 'spring': {
      if (!a.spring) return (p) => p
      return createSpringEasing(a.spring)
    }
    case 'samples':
      return (p) => p
    case 'bezier':
    default: {
      const o = a.out ?? DEFAULT_OUT
      const i = b.in ?? DEFAULT_IN
      return getBezierEasing(o.x, o.y, i.x, i.y)
    }
  }
}

/** 정규화 속도. 1 이 평균 속도다. 중앙차분이면 끝점 편향이 생기지 않는다. */
function speedAt(ease: (p: number) => number, p: number): number {
  const h = 1 / 1024
  const lo = Math.max(0, p - h)
  const hi = Math.min(1, p + h)
  if (hi === lo) return 0
  return (ease(hi) - ease(lo)) / (hi - lo)
}

/** 핸들을 만질 수 있는 세그먼트인가. 스프링과 홀드는 곡선이 파라미터에서 나온다. */
function isEditable(a: Keyframe): boolean {
  return a.interp === 'bezier' || a.interp === 'linear' || a.interp === 'samples'
}

/**
 * 변위 예산에 쓸 이동 거리 추정.
 * 회전과 크기는 픽셀이 아니므로 캔버스 크기를 기준으로 화면상 이동량으로 바꾼다.
 */
function estimateTravelPx(prop: TrackProp, dv: number, w: number, h: number): number {
  const d = Math.abs(dv)
  const halfDiag = Math.hypot(w, h) / 2
  switch (prop) {
    case 'translateX':
    case 'translateY':
      return d
    case 'scale':
    case 'scaleX':
    case 'scaleY':
      return d * Math.max(w, h) * 0.5
    case 'rotate':
    case 'rotateX':
    case 'rotateY':
    case 'skewX':
    case 'skewY':
      return ((d * Math.PI) / 180) * halfDiag
    case 'anchorX':
      return d * w
    case 'anchorY':
      return d * h
    case 'reveal':
      // 경계선이 지나간 거리다. 한 프레임에 반 장을 건너뛰면 뚝뚝 끊겨 보인다.
      return d * halfDiag
    case 'opacity':
    default:
      // 불투명도는 화면에서 움직이지 않는다. 변위 경고 대상이 아니다.
      return 0
  }
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t

const LINEAR_OUT: Handle = { x: 1 / 3, y: 1 / 3 }
const LINEAR_IN: Handle = { x: 2 / 3, y: 2 / 3 }

const near = (a: number, b: number, eps = 0.02): boolean => Math.abs(a - b) < eps

/**
 * 핸들 성분 입력. 편집 중에는 로컬 초안을 들고 있다가 유효할 때만 위로 올린다.
 * 제어 입력에 값을 바로 되꽂으면 "0." 을 치는 순간 커서가 튄다.
 */
function NumInput({
  label,
  value,
  min,
  max,
  onCommit,
}: {
  label: string
  value: number
  min?: number
  max?: number
  onCommit(next: number): void
}): ReactNode {
  const shown = String(Number(value.toFixed(3)))
  const [draft, setDraft] = useState(shown)
  const [editing, setEditing] = useState(false)
  const lastRef = useRef(shown)
  if (!editing && lastRef.current !== shown) {
    lastRef.current = shown
    if (draft !== shown) setDraft(shown)
  }
  return (
    <span className="ge__num">
      {label}
      <input
        className="mm-input"
        type="number"
        step={0.01}
        min={min}
        max={max}
        value={draft}
        aria-label={label}
        onFocus={() => setEditing(true)}
        onBlur={() => {
          setEditing(false)
          setDraft(shown)
          lastRef.current = shown
        }}
        onChange={(e) => {
          const raw = e.target.value
          setDraft(raw)
          if (raw.trim() === '') return
          const n = Number(raw)
          if (Number.isFinite(n)) onCommit(n)
        }}
      />
    </span>
  )
}

// ---------------------------------------------------------------------------

export interface GraphEditorProps {
  /** 생략하면 timelineUi 스토어의 graphTarget 을 쓴다. */
  layerId?: string
  prop?: TrackProp
}

export function GraphEditor({ layerId: layerIdProp, prop: propProp }: GraphEditorProps): ReactNode {
  const graphTarget = useTimelineUiStore((s) => s.graphTarget)
  const graphTab = useTimelineUiStore((s) => s.graphTab)
  const setGraphTab = useTimelineUiStore((s) => s.setGraphTab)
  const closeGraph = useTimelineUiStore((s) => s.closeGraph)
  const snap = useTimelineUiStore((s) => s.snap)
  const selectedKeys = useTimelineUiStore((s) => s.selectedKeys)

  const layerId = layerIdProp ?? graphTarget?.layerId ?? null
  const prop = propProp ?? graphTarget?.prop ?? null

  const layers = useDocumentStore((s) => s.doc.layers)
  const timeline = useDocumentStore((s) => s.doc.timeline)
  const canvasSize = useDocumentStore((s) => s.doc.canvas)
  const setKeyframeHandles = useDocumentStore((s) => s.setKeyframeHandles)
  const setKeyframeEasing = useDocumentStore((s) => s.setKeyframeEasing)
  const playhead = useUiStore((s) => s.playheadFrame)

  const layer = layers.find((l) => l.id === layerId) ?? null
  const track = layer && prop ? getTrack(layer, prop) : undefined
  const keys = track?.keys ?? []
  const segCount = Math.max(0, keys.length - 1)

  // 편집 대상 세그먼트. 선택된 키가 있으면 그 키로, 없으면 재생 헤드가 있는 구간으로.
  const [wantedSeg, setWantedSeg] = useState(0)
  const targetId = `${layerId ?? ''}|${prop ?? ''}`
  // null 로 시작해 첫 렌더에서도 자동 선택이 한 번 돈다.
  const lastTargetRef = useRef<string | null>(null)
  const autoSeg = useMemo(() => {
    if (segCount === 0) return 0
    const sel = selectedKeys.find((k) => k.layerId === layerId && k.prop === prop)
    if (sel) {
      const i = keys.findIndex((k) => k.f === sel.frame)
      if (i >= 0) return Math.min(segCount - 1, i)
    }
    for (let i = 0; i < segCount; i++) {
      const a = keys[i]
      const b = keys[i + 1]
      if (a && b && playhead >= a.f && playhead <= b.f) return i
    }
    return 0
    // playhead 는 의도적으로 뺀다. 재생 중에 편집 대상이 계속 바뀌면 못 만진다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layerId, prop, keys, segCount, selectedKeys])

  if (lastTargetRef.current !== targetId) {
    // 대상이 바뀌면 세그먼트 선택을 다시 잡는다. 렌더 중 ref 갱신은 안전하다.
    lastTargetRef.current = targetId
    if (wantedSeg !== autoSeg) setWantedSeg(autoSeg)
  }
  const segIndex = Math.min(Math.max(0, wantedSeg), Math.max(0, segCount - 1))

  const a = keys[segIndex]
  const b = keys[segIndex + 1]
  const ready = !!layer && !!prop && !!a && !!b && b.f > a.f

  const out: Handle = a?.out ?? DEFAULT_OUT
  const inH: Handle = b?.in ?? DEFAULT_IN

  const ease = useMemo(() => (a && b ? segmentEase(a, b) : (p: number) => p), [a, b])

  const [allowanceKey, setAllowanceKey] =
    useState<keyof typeof STEP_ALLOWANCE>('sharpEdge')

  const travelPx = prop && a && b ? estimateTravelPx(prop, b.v - a.v, canvasSize.w, canvasSize.h) : 0
  const durSec = a && b ? (b.f - a.f) / timeline.fps : 0
  const budget =
    ready && travelPx > 0 && durSec > 0
      ? displacementBudget(ease, travelPx, durSec, timeline.fps, STEP_ALLOWANCE[allowanceKey])
      : null

  // -------------------------------------------------------------------------
  // 캔버스
  // -------------------------------------------------------------------------

  const wrapRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [activeHandle, setActiveHandle] = useState<'out' | 'in' | null>(null)
  const dragRef = useRef<{ which: 'out' | 'in'; pointerId: number } | null>(null)

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect
      if (!rect) return
      setSize({ w: Math.round(rect.width), h: Math.round(rect.height) })
    })
    ro.observe(el)
    return () => ro.disconnect()
    // 플롯 div 는 ready 일 때만 마운트된다. ready 를 의존성에 넣지 않으면
    // 처음에 대상이 없던 경우 옵저버가 영영 붙지 않는다.
  }, [ready])

  const plot: PlotRect = {
    x: PAD_L,
    y: PAD_T,
    w: Math.max(1, size.w - PAD_L - PAD_R),
    h: Math.max(1, size.h - PAD_T - PAD_B),
  }
  const xAxis: TimeAxis = { originX: plot.x, pxPerFrame: plot.w, scrollFrame: 0 }

  /** 현재 탭이 그리는 함수. 값 탭은 이징 자체, 속도 탭은 그 도함수다. */
  const curveAt = useCallback(
    (p: number): number => (graphTab === 'value' ? ease(p) : speedAt(ease, p)),
    [ease, graphTab],
  )

  const samples = useMemo(() => {
    const arr: number[] = []
    for (let i = 0; i <= CURVE_SAMPLES; i++) arr.push(curveAt(i / CURVE_SAMPLES))
    return arr
  }, [curveAt])

  // 기본 뷰포트를 유지하되, 넘어가는 곡선이 있으면 그만큼만 넓힌다.
  let yMin = BASE_Y_MIN
  let yMax = BASE_Y_MAX
  for (const v of samples) {
    if (!Number.isFinite(v)) continue
    if (v < yMin) yMin = v - 0.05
    if (v > yMax) yMax = v + 0.05
  }
  const yAxis: ValueAxis = { top: plot.y, height: plot.h, min: yMin, max: yMax }

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas || size.w <= 0 || size.h <= 0) return
    const theme = readTheme(canvas)
    const ctx = prepareCanvas(canvas, size.w, size.h)
    if (!ctx) return

    drawGraphBackground(ctx, theme, size.w, size.h, plot)
    if (!ready || !a || !b) return

    // 0선과 1선은 항상 그린다.
    drawGuideLine(ctx, theme, plot, yAxis, 0, '0', true)
    drawGuideLine(ctx, theme, plot, yAxis, 1, '1', true)
    if (yMin < BASE_Y_MIN + 1e-6) drawGuideLine(ctx, theme, plot, yAxis, BASE_Y_MIN, '-0.35', false)
    if (yMax > BASE_Y_MAX - 1e-6) drawGuideLine(ctx, theme, plot, yAxis, BASE_Y_MAX, '1.35', false)

    // 곡선
    const pts: [number, number][] = []
    for (let i = 0; i < samples.length; i++) {
      const v = samples[i]
      if (v === undefined || !Number.isFinite(v)) continue
      pts.push([frameToX(i / CURVE_SAMPLES, xAxis), valueToY(v, yAxis)])
    }
    drawPolyline(ctx, pts, theme.accent, 2)

    // 홀드는 끝에서 값이 튄다. 그 점프를 점선으로 명시한다.
    if (a.interp === 'hold') {
      drawPolyline(
        ctx,
        [
          [frameToX(1, xAxis), valueToY(0, yAxis)],
          [frameToX(1, xAxis), valueToY(1, yAxis)],
        ],
        theme.accent,
        2,
        [4, 3],
      )
    }

    // 프레임 틱. 현재 fps 로 실제 샘플되는 지점이다.
    const df = b.f - a.f
    const ticks: [number, number][] = []
    for (let f = a.f; f <= b.f; f++) {
      const p = (f - a.f) / df
      const v = curveAt(p)
      if (!Number.isFinite(v)) continue
      ticks.push([frameToX(p, xAxis), valueToY(v, yAxis)])
    }
    drawFrameTicks(ctx, theme, plot, ticks)

    // 재생 헤드
    if (playhead >= a.f && playhead <= b.f) {
      drawGraphPlayhead(ctx, theme, plot, frameToX((playhead - a.f) / df, xAxis))
    }

    // 핸들
    if (!isEditable(a)) return
    if (graphTab === 'value') {
      const ox = frameToX(out.x, xAxis)
      const oy = valueToY(out.y, yAxis)
      const ix = frameToX(inH.x, xAxis)
      const iy = valueToY(inH.y, yAxis)
      drawControlArm(ctx, theme, frameToX(0, xAxis), valueToY(0, yAxis), ox, oy)
      drawControlArm(ctx, theme, frameToX(1, xAxis), valueToY(1, yAxis), ix, iy)
      drawHandlePoint(ctx, theme, ox, oy, activeHandle === 'out')
      drawHandlePoint(ctx, theme, ix, iy, activeHandle === 'in')
    } else {
      const s = segmentSpeed(a, b)
      const ox = frameToX(s.outInfluence, xAxis)
      const oy = valueToY(s.outSpeed, yAxis)
      const ix = frameToX(1 - s.inInfluence, xAxis)
      const iy = valueToY(s.inSpeed, yAxis)
      drawControlArm(ctx, theme, frameToX(0, xAxis), oy, ox, oy)
      drawControlArm(ctx, theme, frameToX(1, xAxis), iy, ix, iy)
      drawHandlePoint(ctx, theme, ox, oy, activeHandle === 'out')
      drawHandlePoint(ctx, theme, ix, iy, activeHandle === 'in')
    }
  }, [
    a,
    b,
    activeHandle,
    curveAt,
    graphTab,
    inH.x,
    inH.y,
    out.x,
    out.y,
    playhead,
    plot,
    ready,
    samples,
    size.w,
    size.h,
    xAxis,
    yAxis,
    yMax,
    yMin,
  ])

  useEffect(() => {
    const id = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(id)
  }, [draw])

  // -------------------------------------------------------------------------
  // 핸들 드래그
  // -------------------------------------------------------------------------

  function localPoint(e: ReactPointerEvent<HTMLCanvasElement>): { x: number; y: number } {
    const rect = e.currentTarget.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }

  function handlePositions(): { out: [number, number]; in: [number, number] } | null {
    if (!a || !b) return null
    if (graphTab === 'value') {
      return {
        out: [frameToX(out.x, xAxis), valueToY(out.y, yAxis)],
        in: [frameToX(inH.x, xAxis), valueToY(inH.y, yAxis)],
      }
    }
    const s = segmentSpeed(a, b)
    return {
      out: [frameToX(s.outInfluence, xAxis), valueToY(s.outSpeed, yAxis)],
      in: [frameToX(1 - s.inInfluence, xAxis), valueToY(s.inSpeed, yAxis)],
    }
  }

  /** 스냅은 x 축에만 건다. y 를 붙잡으면 오버슈트를 미세 조정할 수 없다. */
  function snapUnit(u: number, disabled: boolean): number {
    if (disabled || !snap || plot.w <= 0) return u
    const tol = SNAP_PX / plot.w
    for (const target of SNAP_X) {
      if (Math.abs(u - target) <= tol) return target
    }
    return u
  }

  function applyDrag(
    which: 'out' | 'in',
    u: number,
    v: number,
    mirror: boolean,
  ): void {
    if (!layerId || !prop || !a || !b) return

    if (graphTab === 'value') {
      const x = clamp01(u)
      if (which === 'out') {
        setKeyframeHandles(layerId, prop, a.f, { out: { x, y: v } })
        // Shift: 세그먼트 중심 대칭으로 반대편을 맞춘다. 두 탄젠트의 크기가
        // 같아지므로 C1 이 유지되고 곡선이 대칭 이징이 된다.
        if (mirror) setKeyframeHandles(layerId, prop, b.f, { in: { x: 1 - x, y: 1 - v } })
      } else {
        setKeyframeHandles(layerId, prop, b.f, { in: { x, y: v } })
        if (mirror) setKeyframeHandles(layerId, prop, a.f, { out: { x: 1 - x, y: 1 - v } })
      }
      return
    }

    // 속도 탭. 변환은 반드시 speedToHandles 를 거친다.
    const s = segmentSpeed(a, b)
    if (which === 'out') {
      const outInfluence = clamp01(u)
      const next = {
        outSpeed: v,
        outInfluence,
        inSpeed: mirror ? v : s.inSpeed,
        inInfluence: mirror ? outInfluence : s.inInfluence,
      }
      const h = speedToHandles(next)
      setKeyframeHandles(layerId, prop, a.f, { out: h.out })
      if (mirror) setKeyframeHandles(layerId, prop, b.f, { in: h.in })
    } else {
      const inInfluence = clamp01(1 - u)
      const next = {
        outSpeed: mirror ? v : s.outSpeed,
        outInfluence: mirror ? inInfluence : s.outInfluence,
        inSpeed: v,
        inInfluence,
      }
      const h = speedToHandles(next)
      setKeyframeHandles(layerId, prop, b.f, { in: h.in })
      if (mirror) setKeyframeHandles(layerId, prop, a.f, { out: h.out })
    }
  }

  function onPointerDown(e: ReactPointerEvent<HTMLCanvasElement>): void {
    if (!ready || !a || !isEditable(a)) return
    const pos = handlePositions()
    if (!pos) return
    const { x, y } = localPoint(e)
    const r = hitRadius(e.pointerType)

    const dOut = withinRadius(x, y, pos.out[0], pos.out[1], r)
    const dIn = withinRadius(x, y, pos.in[0], pos.in[1], r)
    let which: 'out' | 'in' | null = null
    if (dOut && dIn) {
      // 겹치면 더 가까운 쪽. 제곱거리 비교만 한다.
      const do2 = (x - pos.out[0]) ** 2 + (y - pos.out[1]) ** 2
      const di2 = (x - pos.in[0]) ** 2 + (y - pos.in[1]) ** 2
      which = do2 <= di2 ? 'out' : 'in'
    } else if (dOut) which = 'out'
    else if (dIn) which = 'in'
    if (!which) return

    e.preventDefault()
    dragRef.current = { which, pointerId: e.pointerId }
    setActiveHandle(which)
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  function onPointerMove(e: ReactPointerEvent<HTMLCanvasElement>): void {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== e.pointerId) return
    const { x, y } = localPoint(e)
    // Ctrl 은 스냅 일시 해제, Alt 는 탄젠트 분리(미러 금지) 다.
    const u = snapUnit(xToFrame(x, xAxis), e.ctrlKey || e.metaKey)
    const v = yToValue(y, yAxis)
    applyDrag(drag.which, u, v, e.shiftKey && !e.altKey)
  }

  function endDrag(e: ReactPointerEvent<HTMLCanvasElement>): void {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== e.pointerId) return
    dragRef.current = null
    setActiveHandle(null)
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
  }

  // -------------------------------------------------------------------------
  // 숫자 / CSS 입력
  // -------------------------------------------------------------------------

  const cssValue = formatCubicBezier(out.x, out.y, inH.x, inH.y)
  const [cssDraft, setCssDraft] = useState(cssValue)
  const [cssError, setCssError] = useState(false)
  const cssShownRef = useRef(cssValue)
  if (cssShownRef.current !== cssValue && document.activeElement?.id !== 'ge-css') {
    cssShownRef.current = cssValue
    if (cssDraft !== cssValue) setCssDraft(cssValue)
  }

  function commitCss(raw: string): void {
    if (!layerId || !prop || !a || !b) return
    const parsed = parseCubicBezier(raw)
    if (!parsed) {
      setCssError(true)
      return
    }
    setCssError(false)
    const [x1, y1, x2, y2] = parsed
    setKeyframeHandles(layerId, prop, a.f, { out: { x: x1, y: y1 } })
    setKeyframeHandles(layerId, prop, b.f, { in: { x: x2, y: y2 } })
  }

  function setHandleComponent(which: 'out' | 'in', axis: 'x' | 'y', value: number): void {
    if (!layerId || !prop || !a || !b) return
    if (which === 'out') {
      const next: Handle = { x: axis === 'x' ? clamp01(value) : out.x, y: axis === 'y' ? value : out.y }
      setKeyframeHandles(layerId, prop, a.f, { out: next })
    } else {
      const next: Handle = { x: axis === 'x' ? clamp01(value) : inH.x, y: axis === 'y' ? value : inH.y }
      setKeyframeHandles(layerId, prop, b.f, { in: next })
    }
  }

  /** 오버슈트를 걷어내 y 를 [0,1] 안으로 되돌린다. */
  function normalize(): void {
    if (!layerId || !prop || !a || !b) return
    setKeyframeHandles(layerId, prop, a.f, { out: { x: out.x, y: clamp01(out.y) } })
    setKeyframeHandles(layerId, prop, b.f, { in: { x: inH.x, y: clamp01(inH.y) } })
  }

  /**
   * 변위 예산 완화.
   * 하드 에러가 아니므로 곡선을 버리지 않고 선형 쪽으로 조금씩 당긴다.
   * 예산을 통과하는 첫 단계에서 멈춘다.
   */
  function relax(): void {
    if (!layerId || !prop || !a || !b || travelPx <= 0 || durSec <= 0) return
    for (let step = 1; step <= 5; step++) {
      const t = step * 0.2
      const no: Handle = { x: lerp(out.x, LINEAR_OUT.x, t), y: lerp(out.y, LINEAR_OUT.y, t) }
      const ni: Handle = { x: lerp(inH.x, LINEAR_IN.x, t), y: lerp(inH.y, LINEAR_IN.y, t) }
      const test = getBezierEasing(no.x, no.y, ni.x, ni.y)
      const bud = displacementBudget(
        test,
        travelPx,
        durSec,
        timeline.fps,
        STEP_ALLOWANCE[allowanceKey],
      )
      if (!bud.exceeded || step === 5) {
        setKeyframeHandles(layerId, prop, a.f, { out: no })
        setKeyframeHandles(layerId, prop, b.f, { in: ni })
        return
      }
    }
  }

  /** 어떤 칩이 지금 적용되어 있는지. 베지어는 핸들 근사 비교로 판정한다. */
  function chipActive(presetId: string): boolean {
    if (!a) return false
    const preset = CHIP_PRESETS.find((p) => p.id === presetId)
    if (!preset) return false
    if (preset.interp !== a.interp) return false
    if (preset.interp !== 'bezier') return true
    if (!preset.handles) return false
    return (
      near(preset.handles.out.x, out.x) &&
      near(preset.handles.out.y, out.y) &&
      near(preset.handles.in.x, inH.x) &&
      near(preset.handles.in.y, inH.y)
    )
  }

  // -------------------------------------------------------------------------
  // 렌더
  // -------------------------------------------------------------------------

  const targetLabel = layer && prop ? `${layer.name} > ${PROP_LABELS[prop]}` : '대상 없음'
  const speedNow = a && b ? segmentSpeed(a, b) : null
  const editable = !!a && isEditable(a)

  const summary =
    ready && speedNow
      ? `출발 속도 ${speedNow.outSpeed.toFixed(2)}, 도착 속도 ${speedNow.inSpeed.toFixed(2)}` +
        (budget
          ? `, 프레임당 최대 변위 ${budget.maxStepPx.toFixed(1)}픽셀, 권장 fps ${Math.ceil(budget.requiredFps)}`
          : '')
      : ''

  /**
   * 값 / 속도 전환. role="tab" 을 쓰지 않는다. 실제 패널이 aria-hidden 인 캔버스라
   * tab 과 tabpanel 관계를 만들 수 없고, 관계가 없는 tablist 는 낭독기에서 길을 잃는다.
   */
  function renderTabs(): ReactNode {
    const tab = (id: GraphTab, label: string): ReactNode => (
      <button
        type="button"
        className="ge__tab"
        aria-pressed={graphTab === id}
        onClick={() => setGraphTab(id)}
      >
        {label}
      </button>
    )
    return (
      <div className="ge__tabs" role="group" aria-label="그래프 종류">
        {tab('value', '값')}
        {tab('speed', '속도')}
      </div>
    )
  }

  return (
    <section className="ge" aria-label="그래프 에디터">
      <style href="mm-graph-editor" precedence="default">
        {GRAPH_CSS}
      </style>

      <div className="ge__head">
        {renderTabs()}
        <span className="ge__target">
          대상: <b>{targetLabel}</b>
        </span>

        {segCount > 1 ? (
          <span className="ge__seg">
            <button
              type="button"
              className="mm-icon-btn"
              aria-label="이전 구간"
              disabled={segIndex <= 0}
              onClick={() => setWantedSeg(segIndex - 1)}
            >
              &lt;
            </button>
            구간 {segIndex + 1}/{segCount}
            <button
              type="button"
              className="mm-icon-btn"
              aria-label="다음 구간"
              disabled={segIndex >= segCount - 1}
              onClick={() => setWantedSeg(segIndex + 1)}
            >
              &gt;
            </button>
          </span>
        ) : null}

        <span className="ge__spacer" />
        <button type="button" className="mm-btn" onClick={closeGraph}>
          닫기
        </button>
      </div>

      {!ready ? (
        <p className="ge__empty">
          곡선을 편집하려면 키프레임이 2개 이상 있는 속성을 고르세요. 타임라인에서 키를 선택한 뒤
          [그래프] 를 누르면 됩니다.
        </p>
      ) : (
        <>
          <div className="ge__plot" ref={wrapRef}>
            <canvas
              ref={canvasRef}
              aria-hidden="true"
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
            />
          </div>

          {/* 캔버스는 낭독기에 아무것도 남기지 않는다. 요약을 따로 준다. */}
          <p className="mm-visually-hidden" role="status">
            {summary}
          </p>

          <div className="ge__foot">
            <div className="ge__chips" role="group" aria-label="곡선 프리셋">
              {CHIP_PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  className="ge__chip"
                  aria-pressed={chipActive(preset.id)}
                  title={preset.hint}
                  onClick={() => {
                    if (layerId && prop && a) setKeyframeEasing(layerId, prop, a.f, preset.id)
                  }}
                >
                  {chipActive(preset.id) ? '* ' : ''}
                  {preset.label}
                </button>
              ))}
            </div>

            {editable ? (
              <div className="ge__row">
                <label className="ge__num" htmlFor="ge-css">
                  CSS
                </label>
                <input
                  id="ge-css"
                  className="mm-input ge__css"
                  type="text"
                  value={cssDraft}
                  spellCheck={false}
                  aria-invalid={cssError}
                  aria-label="cubic-bezier 값. CSS 에서 복사한 문자열을 붙여넣을 수 있습니다."
                  onChange={(e) => {
                    setCssDraft(e.target.value)
                    commitCss(e.target.value)
                  }}
                  onBlur={() => {
                    setCssDraft(cssValue)
                    setCssError(false)
                  }}
                />

                <NumInput
                  label="x1"
                  value={out.x}
                  min={0}
                  max={1}
                  onCommit={(n) => setHandleComponent('out', 'x', n)}
                />
                <NumInput label="y1" value={out.y} onCommit={(n) => setHandleComponent('out', 'y', n)} />
                <NumInput
                  label="x2"
                  value={inH.x}
                  min={0}
                  max={1}
                  onCommit={(n) => setHandleComponent('in', 'x', n)}
                />
                <NumInput label="y2" value={inH.y} onCommit={(n) => setHandleComponent('in', 'y', n)} />

                <button type="button" className="mm-btn" onClick={normalize}>
                  정규화
                </button>
              </div>
            ) : (
              <p className="ge__note">
                이 구간은 {a?.interp === 'spring' ? '스프링' : '홀드'} 보간입니다. 곡선이
                파라미터에서 나오므로 핸들을 직접 끌 수 없습니다. 위 칩으로 다른 곡선을 고르면
                핸들 편집이 열립니다.
              </p>
            )}

            <div className="ge__row">
              <label className="ge__num" htmlFor="ge-allow">
                변위 기준
              </label>
              <select
                id="ge-allow"
                className="mm-select"
                style={{ width: 'auto' }}
                value={allowanceKey}
                onChange={(e) => setAllowanceKey(e.target.value as keyof typeof STEP_ALLOWANCE)}
              >
                {ALLOWANCE_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
              <span className="ge__note">
                {budget
                  ? `프레임당 최대 ${budget.maxStepPx.toFixed(1)}px`
                  : '이 속성은 화면에서 움직이지 않아 변위 검사를 하지 않습니다'}
              </span>
            </div>

            {/* 하드 에러가 아니라 경고다. 막지 않고 알리고 고칠 길을 준다. */}
            {budget?.exceeded ? (
              <p className="ge__warn" role="status">
                <span>
                  이 곡선은 프레임 사이가 최대 {budget.maxStepPx.toFixed(1)}px 뜁니다. 허용치
                  {' '}
                  {STEP_ALLOWANCE[allowanceKey]}px 를 지키려면 {Math.ceil(budget.requiredFps)} fps
                  가 필요합니다. 지금 설정에서는 끊겨 보일 수 있습니다.
                </span>
                {editable ? (
                  <button type="button" className="mm-btn" onClick={relax}>
                    완화
                  </button>
                ) : null}
              </p>
            ) : null}

            {/* 오버슈트를 만지기 시작하면 값 탭으로 전환 힌트를 준다. */}
            {graphTab === 'speed' && (out.y < -0.001 || inH.y > 1.001 || out.y > 1.001) ? (
              <p className="ge__note">
                이 곡선은 목표값을 넘었다가 돌아옵니다. [값] 탭에서 보면 얼마나 넘는지 바로
                읽힙니다.
              </p>
            ) : null}

            <p className="ge__note">
              Shift 드래그로 반대편 핸들 미러, Alt 로 탄젠트 분리, Ctrl 로 스냅 일시 해제.
            </p>
          </div>
        </>
      )}
    </section>
  )
}

export default GraphEditor
