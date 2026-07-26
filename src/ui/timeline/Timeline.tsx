/**
 * 하단 타임라인.
 *
 * 트랙 영역은 Canvas 2D 다. 키프레임 하나마다 DOM 노드를 만들면 120프레임 x 여러
 * 트랙에서 노드가 수천 개가 되고, 그 순간 스크럽이 버벅인다. 대신 좌측 트랙
 * 헤더만 DOM 으로 두어 이름과 버튼이 정상적으로 포커스를 받게 한다.
 *
 * Canvas 는 접근성 트리에 아무것도 남기지 않으므로 TimelineAriaTree 를 함께
 * 렌더한다. 두 표현은 같은 TimelineModel 하나에서 파생된다.
 *
 * 그래프 에디터가 열리면 이 영역을 통째로 대체한다. 별도 창을 띄우지 않는다.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'

import type { TrackProp } from '@/core/types.ts'
import { useDocumentStore } from '@/state/document.ts'
import { useTimelineUiStore, type KeyRef } from '@/state/timelineUi.ts'
import { useUiStore } from '@/state/ui.ts'
import { GraphEditor } from './GraphEditor.tsx'
import { TimelineAriaTree } from './TimelineAriaTree.tsx'
import {
  buildTimelineModel,
  chooseGridStep,
  drawTimeline,
  hitRadius,
  hitTestKey,
  prepareCanvas,
  readTheme,
  rowIndexAtY,
  selectionId,
  xToFrame,
  type TimelineGeometry,
  type TimelineModel,
} from './timelineDraw.ts'

const HEADER_W = 156
const RULER_H = 30
const ROW_H = 24
/** 재생 헤드나 이웃 키에 달라붙는 거리. */
const SNAP_PX = 6

const TIMELINE_CSS = `
.tl {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  height: 100%;
  border-top: 1px solid var(--border);
  background: var(--surface);
}

.tl:focus {
  outline: none;
}

.tl__bar {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: var(--sp-2) var(--sp-3);
  border-bottom: 1px solid var(--border);
}

.tl__bar .mm-btn {
  min-height: 24px;
  padding: 0 var(--sp-3);
  font-size: var(--fs-xs);
}

.tl__bar .mm-btn[aria-pressed='true'] {
  border-color: var(--accent);
  background: var(--accent-soft);
}

.tl__title {
  min-width: 0;
  overflow: hidden;
  color: var(--text-muted);
  font-size: var(--fs-xs);
  font-weight: 600;
  letter-spacing: 0.06em;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-transform: uppercase;
}

.tl__frame {
  font-family: var(--font-mono);
  font-size: var(--fs-xs);
  font-variant-numeric: tabular-nums;
  color: var(--text);
}

.tl__spacer {
  margin-left: auto;
}

.tl__main {
  position: relative;
  display: flex;
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  scrollbar-width: thin;
}

.tl__head {
  flex: none;
  width: ${HEADER_W}px;
  border-right: 1px solid var(--border);
  background: var(--surface);
}

.tl__head-top {
  display: flex;
  align-items: center;
  height: ${RULER_H}px;
  padding: 0 var(--sp-3);
  border-bottom: 1px solid var(--border);
  background: var(--surface-raised);
  color: var(--text);
  font-size: var(--fs-xs);
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tl__row {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  width: 100%;
  height: ${ROW_H}px;
  padding: 0 var(--sp-2) 0 var(--sp-3);
  border: 0;
  border-bottom: 1px solid var(--border);
  background: transparent;
  color: var(--text-muted);
  font-size: var(--fs-xs);
  text-align: left;
}

.tl__row:hover {
  background: var(--surface-hover);
  color: var(--text);
}

/* 선택된 트랙은 배경 + 좌측 마커 두 가지로 표시한다. */
.tl__row[aria-pressed='true'] {
  background: var(--accent-soft);
  color: var(--text);
  box-shadow: inset 3px 0 0 0 var(--accent);
}

.tl__row-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tl__row-count {
  flex: none;
  color: var(--text-faint);
  font-family: var(--font-mono);
}

.tl__body {
  position: relative;
  flex: 1;
  min-width: 0;
}

.tl__body canvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  touch-action: none;
  cursor: default;
}

.tl__empty {
  display: flex;
  flex: 1;
  align-items: center;
  justify-content: center;
  padding: var(--sp-5);
  color: var(--text-faint);
  font-size: var(--fs-sm);
  text-align: center;
}
`

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

interface DragState {
  kind: 'scrub' | 'keys'
  pointerId: number
  /** 눌린 지점의 프레임 (소수). 델타 계산 기준이다. */
  startFrame: number
  items: { prop: TrackProp; orig: number; cur: number }[]
  applied: number
}

/** 재생 헤드 숫자만 따로 구독한다. 재생 중 타임라인 전체가 리렌더되지 않게. */
function PlayheadReadout(): ReactNode {
  const frame = useUiStore((s) => s.playheadFrame)
  return <span className="tl__frame">f{frame}</span>
}

export function Timeline(): ReactNode {
  const layers = useDocumentStore((s) => s.doc.layers)
  const timeline = useDocumentStore((s) => s.doc.timeline)
  const addKeyframe = useDocumentStore((s) => s.addKeyframe)
  const removeKeyframe = useDocumentStore((s) => s.removeKeyframe)
  const moveKeyframe = useDocumentStore((s) => s.moveKeyframe)

  const selectedLayerId = useUiStore((s) => s.selectedLayerId)
  const setPlayheadFrame = useUiStore((s) => s.setPlayheadFrame)
  const setPlaying = useUiStore((s) => s.setPlaying)

  const selectedKeys = useTimelineUiStore((s) => s.selectedKeys)
  const setSelection = useTimelineUiStore((s) => s.setSelection)
  const selectKey = useTimelineUiStore((s) => s.selectKey)
  const clearSelection = useTimelineUiStore((s) => s.clearSelection)
  const remapSelection = useTimelineUiStore((s) => s.remapSelection)
  const armed = useTimelineUiStore((s) => s.armed)
  const zoom = useTimelineUiStore((s) => s.zoom)
  const setZoom = useTimelineUiStore((s) => s.setZoom)
  const zoomBy = useTimelineUiStore((s) => s.zoomBy)
  const scrollFrame = useTimelineUiStore((s) => s.scrollFrame)
  const snap = useTimelineUiStore((s) => s.snap)
  const toggleSnap = useTimelineUiStore((s) => s.toggleSnap)
  const graphOpen = useTimelineUiStore((s) => s.graphOpen)
  const graphTarget = useTimelineUiStore((s) => s.graphTarget)
  const openGraph = useTimelineUiStore((s) => s.openGraph)

  const layer = layers.find((l) => l.id === selectedLayerId) ?? null

  const armedProps = useMemo(() => {
    const set = new Set<TrackProp>()
    if (!layer) return set
    for (const id of armed) {
      const [lid, prop] = id.split('|')
      if (lid === layer.id && prop) set.add(prop as TrackProp)
    }
    return set
  }, [armed, layer])

  const model: TimelineModel | null = useMemo(
    () => (layer ? buildTimelineModel(layer, timeline, armedProps) : null),
    [layer, timeline, armedProps],
  )

  const selectedSet = useMemo(() => {
    const set = new Set<string>()
    if (!layer) return set
    for (const k of selectedKeys) {
      if (k.layerId === layer.id) set.add(selectionId(k.prop, k.frame))
    }
    return set
  }, [selectedKeys, layer])

  // -------------------------------------------------------------------------
  // 기하
  // -------------------------------------------------------------------------

  const rootRef = useRef<HTMLDivElement | null>(null)
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })

  // 트랙 영역은 model 이 있을 때만 마운트된다. 이 값이 바뀔 때 옵저버를 다시 건다.
  const hasModel = model !== null

  useEffect(() => {
    const el = bodyRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect
      if (!rect) return
      setSize({ w: Math.round(rect.width), h: Math.round(rect.height) })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [hasModel])

  const duration = Math.max(1, timeline.durationFrames)
  // zoom 1 = 전체 구간이 폭에 딱 맞는다. 그 아래로는 줄이지 않는다.
  const basePx = size.w > 0 ? size.w / duration : 8
  const pxPerFrame = Math.max(0.5, basePx * zoom)
  const visibleFrames = size.w > 0 ? size.w / pxPerFrame : duration
  const maxScroll = Math.max(0, duration - visibleFrames)
  const scroll = clamp(scrollFrame, 0, maxScroll)

  const geo: TimelineGeometry = useMemo(
    () => ({ rulerH: RULER_H, rowH: ROW_H, axis: { originX: 0, pxPerFrame, scrollFrame: scroll } }),
    [pxPerFrame, scroll],
  )

  // 스토어는 캔버스 폭을 모른다. 스크롤 상한을 계산할 재료를 여기서 넘긴다.
  // 이게 없으면 보이지 않는 스크롤이 무한히 쌓이고 확대하는 순간 맨 끝으로 튄다.
  useEffect(() => {
    useTimelineUiStore.getState().setViewport(visibleFrames, duration)
  }, [visibleFrames, duration])

  // 레이어나 키가 사라지면 남은 선택 / 스톱워치 / 그래프 대상을 문서 기준으로 턴다.
  // 삭제하는 쪽마다 정리를 넣으면 반드시 한 군데를 빠뜨린다.
  useEffect(() => {
    useTimelineUiStore.getState().pruneForDocument(useDocumentStore.getState().doc)
  }, [layers])

  // -------------------------------------------------------------------------
  // 그리기
  // -------------------------------------------------------------------------

  const playheadRef = useRef(useUiStore.getState().playheadFrame)
  const hoveredRef = useRef<string | null>(null)
  const rafRef = useRef(0)

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas || !model || size.w <= 0 || size.h <= 0) return
    const ctx = prepareCanvas(canvas, size.w, size.h)
    if (!ctx) return
    drawTimeline(ctx, {
      theme: readTheme(canvas),
      width: size.w,
      height: size.h,
      geo,
      model,
      playhead: playheadRef.current,
      selected: selectedSet,
      hovered: hoveredRef.current,
      loopMode: timeline.loop.mode,
    })
  }, [geo, model, selectedSet, size.w, size.h, timeline.loop.mode])

  const requestDraw = useCallback(() => {
    if (rafRef.current !== 0) return
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0
      draw()
    })
  }, [draw])

  useEffect(() => {
    requestDraw()
    return () => {
      if (rafRef.current !== 0) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = 0
      }
    }
  }, [requestDraw])

  // 재생 헤드는 초당 수십 번 바뀐다. 셀렉터로 구독하면 타임라인 전체가 그만큼
  // 리렌더된다. 구독만 걸고 캔버스만 다시 그린다.
  useEffect(() => {
    return useUiStore.subscribe((state, prev) => {
      if (state.playheadFrame === prev.playheadFrame) return
      playheadRef.current = state.playheadFrame
      requestDraw()
    })
  }, [requestDraw])

  // -------------------------------------------------------------------------
  // 휠 (Ctrl 줌 / 그 외 가로 이동)
  // -------------------------------------------------------------------------

  useEffect(() => {
    const el = bodyRef.current
    if (!el) return
    // React 는 wheel 을 passive 로 붙인다. 브라우저 확대를 막으려면 직접 건다.
    const onWheel = (e: WheelEvent): void => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault()
        // 커서 아래 프레임을 붙들고 확대한다. 손이 가리키던 자리를 잃으면 안 된다.
        const rect = el.getBoundingClientRect()
        const st = useTimelineUiStore.getState()
        const anchor = st.scrollFrame + (e.clientX - rect.left) / Math.max(0.5, pxPerFrame)
        st.zoomBy(e.deltaY < 0 ? 1.15 : 1 / 1.15, anchor)
        return
      }
      const dx = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.shiftKey ? e.deltaY : 0
      if (dx === 0) return
      e.preventDefault()
      const st = useTimelineUiStore.getState()
      st.setScrollFrame(st.scrollFrame + dx / Math.max(0.5, pxPerFrame))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [pxPerFrame, hasModel])

  // -------------------------------------------------------------------------
  // 포인터
  // -------------------------------------------------------------------------

  const dragRef = useRef<DragState | null>(null)

  function localPoint(e: {
    currentTarget: HTMLCanvasElement
    clientX: number
    clientY: number
  }): { x: number; y: number } {
    const rect = e.currentTarget.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }

  /** 문서에서 지금 이 순간의 키 프레임 목록을 읽는다. 드래그 중에는 model 이 낡는다. */
  function liveFrames(prop: TrackProp): number[] {
    const id = layer?.id
    if (!id) return []
    const doc = useDocumentStore.getState().doc
    const live = doc.layers.find((l) => l.id === id)
    const track = live?.tracks.find((t) => t.prop === prop)
    return track ? track.keys.map((k) => k.f) : []
  }

  /** 스냅. Ctrl 을 누르면 일시 해제되어 1프레임 단위가 된다. */
  function snapDelta(rawDelta: number, disabled: boolean): number {
    if (disabled || !snap) return Math.round(rawDelta)
    const step = chooseGridStep(pxPerFrame, 8)
    return Math.round(rawDelta / step) * step
  }

  /** 이 델타가 적용 가능한가. 같은 프레임에 두 키가 겹치면 평가가 0 나눗셈을 만난다. */
  function deltaValid(items: DragState['items'], delta: number): boolean {
    const byProp = new Map<TrackProp, DragState['items']>()
    for (const it of items) {
      const list = byProp.get(it.prop) ?? []
      list.push(it)
      byProp.set(it.prop, list)
    }
    for (const [prop, list] of byProp) {
      const moving = new Set(list.map((i) => i.cur))
      const statics = liveFrames(prop).filter((f) => !moving.has(f))
      const targets = list.map((i) => i.orig + delta)
      if (targets.some((t) => t < 0 || t > duration - 1)) return false
      if (new Set(targets).size !== targets.length) return false
      if (targets.some((t) => statics.includes(t))) return false
    }
    return true
  }

  function applyDelta(drag: DragState, delta: number): void {
    const layerId = layer?.id
    if (!layerId) return
    const byProp = new Map<TrackProp, DragState['items']>()
    for (const it of drag.items) {
      const list = byProp.get(it.prop) ?? []
      list.push(it)
      byProp.set(it.prop, list)
    }
    const rightward = delta > drag.applied
    for (const [prop, list] of byProp) {
      // 오른쪽으로 밀 때는 오른쪽 키부터 옮겨야 서로 밟지 않는다.
      const ordered = [...list].sort((p, q) => (rightward ? q.cur - p.cur : p.cur - q.cur))
      for (const it of ordered) {
        const to = it.orig + delta
        if (to === it.cur) continue
        moveKeyframe(layerId, prop, it.cur, to)
        remapSelection(layerId, prop, it.cur, to)
        it.cur = to
      }
    }
    drag.applied = delta
  }

  function scrubTo(rawFrame: number): void {
    setPlayheadFrame(clamp(Math.round(rawFrame), 0, duration - 1))
  }

  function onPointerDown(e: ReactPointerEvent<HTMLCanvasElement>): void {
    if (!model || !layer) return
    const { x, y } = localPoint(e)
    const additive = e.shiftKey || e.ctrlKey || e.metaKey
    const hit = y >= RULER_H ? hitTestKey(model, geo, x, y, hitRadius(e.pointerType)) : null

    // 캔버스는 포커스를 못 받는다. Delete 같은 키가 먹으려면 컨테이너로 옮긴다.
    rootRef.current?.focus()
    e.currentTarget.setPointerCapture(e.pointerId)

    if (hit) {
      const ref: KeyRef = { layerId: layer.id, prop: hit.prop, frame: hit.frame }
      const already = selectedSet.has(selectionId(hit.prop, hit.frame))
      if (additive) selectKey(ref, true)
      else if (!already) setSelection([ref])

      const base = additive || already ? useTimelineUiStore.getState().selectedKeys : [ref]
      const items = base
        .filter((k) => k.layerId === layer.id)
        .map((k) => ({ prop: k.prop, orig: k.frame, cur: k.frame }))
      dragRef.current = {
        kind: 'keys',
        pointerId: e.pointerId,
        startFrame: xToFrame(x, geo.axis),
        items,
        applied: 0,
      }
      return
    }

    // 빈 곳을 누르면 선택 해제 + 스크럽. 재생 중이면 멈춰야 손이 맞는다.
    if (!additive) clearSelection()
    setPlaying(false)
    dragRef.current = {
      kind: 'scrub',
      pointerId: e.pointerId,
      startFrame: xToFrame(x, geo.axis),
      items: [],
      applied: 0,
    }
    scrubTo(xToFrame(x, geo.axis))
  }

  function onPointerMove(e: ReactPointerEvent<HTMLCanvasElement>): void {
    if (!model) return
    const { x, y } = localPoint(e)
    const drag = dragRef.current

    if (!drag) {
      const hit = y >= RULER_H ? hitTestKey(model, geo, x, y, hitRadius(e.pointerType)) : null
      const id = hit ? selectionId(hit.prop, hit.frame) : null
      if (id !== hoveredRef.current) {
        hoveredRef.current = id
        e.currentTarget.style.cursor = hit ? 'grab' : y < RULER_H ? 'ew-resize' : 'default'
        requestDraw()
      }
      return
    }
    if (drag.pointerId !== e.pointerId) return

    if (drag.kind === 'scrub') {
      scrubTo(xToFrame(x, geo.axis))
      return
    }

    const noSnap = e.ctrlKey || e.metaKey
    let delta = snapDelta(xToFrame(x, geo.axis) - drag.startFrame, noSnap)

    // 재생 헤드에 달라붙는다. 키를 헤드에 정확히 맞추는 조작이 잦다.
    if (!noSnap && snap && drag.items.length === 1) {
      const only = drag.items[0]
      if (only) {
        const head = playheadRef.current
        if (Math.abs(only.orig + delta - head) * pxPerFrame <= SNAP_PX) delta = head - only.orig
      }
    }

    if (delta === drag.applied) return
    // 겹치거나 구간을 벗어나면 통과하는 가장 큰 델타까지만 민다.
    let d = delta
    const dir = Math.sign(d - drag.applied)
    while (d !== drag.applied && !deltaValid(drag.items, d)) d -= dir
    if (d === drag.applied) return
    applyDelta(drag, d)
  }

  function endDrag(e: ReactPointerEvent<HTMLCanvasElement>): void {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== e.pointerId) return
    dragRef.current = null
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
  }

  function onDoubleClick(e: ReactMouseEvent<HTMLCanvasElement>): void {
    if (!model || !layer) return
    const { x, y } = localPoint(e)
    const rowIndex = rowIndexAtY(y, geo, model.rows.length)
    if (rowIndex < 0) return
    const row = model.rows[rowIndex]
    if (!row) return
    const frame = clamp(Math.round(xToFrame(x, geo.axis)), 0, duration - 1)
    if (row.keys.some((k) => k.f === frame)) return
    addKeyframe(layer.id, row.prop, frame)
  }

  // -------------------------------------------------------------------------
  // 명령
  // -------------------------------------------------------------------------

  const targetProps = useMemo(() => {
    if (!layer || !model) return [] as TrackProp[]
    const fromSelection = [
      ...new Set(selectedKeys.filter((k) => k.layerId === layer.id).map((k) => k.prop)),
    ]
    return fromSelection.length > 0 ? fromSelection : model.rows.map((r) => r.prop)
  }, [layer, model, selectedKeys])

  function addAtPlayhead(): void {
    if (!layer) return
    const frame = clamp(playheadRef.current, 0, duration - 1)
    for (const prop of targetProps) addKeyframe(layer.id, prop, frame)
  }

  function deleteSelected(): void {
    if (!layer) return
    for (const k of selectedKeys) {
      if (k.layerId !== layer.id) continue
      removeKeyframe(k.layerId, k.prop, k.frame)
    }
    clearSelection()
  }

  /** 확대는 재생 헤드를 기준으로 한다. 헤드가 화면 밖이면 스토어가 중앙을 쓴다. */
  function zoomAtPlayhead(factor: number): void {
    zoomBy(factor, playheadRef.current)
  }

  function openGraphForSelection(): void {
    if (!layer || !model) return
    const prop = targetProps[0] ?? model.rows[0]?.prop
    if (!prop) return
    openGraph({ layerId: layer.id, prop })
  }

  function onKeyDown(e: ReactKeyboardEvent<HTMLDivElement>): void {
    // 입력 필드 안에서는 단일 문자 단축키를 죽인다.
    const target = e.target as HTMLElement
    const tag = target.tagName
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return

    switch (e.key) {
      case 'Delete':
      case 'Backspace':
        if (selectedKeys.length === 0) return
        e.preventDefault()
        deleteSelected()
        return
      case 'ArrowLeft':
        e.preventDefault()
        setPlaying(false)
        setPlayheadFrame(clamp(playheadRef.current - (e.shiftKey ? 10 : 1), 0, duration - 1))
        return
      case 'ArrowRight':
        e.preventDefault()
        setPlaying(false)
        setPlayheadFrame(clamp(playheadRef.current + (e.shiftKey ? 10 : 1), 0, duration - 1))
        return
      case 'Home':
        e.preventDefault()
        setPlayheadFrame(0)
        return
      case 'End':
        e.preventDefault()
        setPlayheadFrame(duration - 1)
        return
      default:
    }
  }

  // -------------------------------------------------------------------------
  // 렌더
  // -------------------------------------------------------------------------

  // 그래프 대상이 지금 선택된 레이어의 살아 있는 트랙일 때만 그래프로 대체한다.
  // 레이어를 바꾸거나 지운 뒤에도 대체가 유지되면 타임라인으로 돌아올 길이 없다.
  const graphUsable =
    graphOpen &&
    graphTarget !== null &&
    layer !== null &&
    graphTarget.layerId === layer.id &&
    layer.tracks.some((t) => t.prop === graphTarget.prop)

  if (graphUsable && graphTarget) {
    return <GraphEditor layerId={graphTarget.layerId} prop={graphTarget.prop} />
  }

  if (!layer || !model) {
    return (
      <div className="tl">
        <style href="mm-timeline" precedence="default">
          {TIMELINE_CSS}
        </style>
        <div className="tl__bar">
          <span className="tl__title">타임라인</span>
        </div>
        <p className="tl__empty">왼쪽에서 이미지를 선택하면 트랙이 여기에 나타납니다.</p>
      </div>
    )
  }

  const contentH = RULER_H + model.rows.length * ROW_H

  return (
    // Delete 나 화살표를 받으려면 컨테이너가 포커스를 가질 수 있어야 한다.
    // Tab 순서에는 넣지 않는다. 키보드 편집 경로는 접근성 트리 쪽이다.
    <div className="tl" ref={rootRef} tabIndex={-1} onKeyDown={onKeyDown}>
      <style href="mm-timeline" precedence="default">
        {TIMELINE_CSS}
      </style>

      <div className="tl__bar">
        <span className="tl__title">타임라인 · {layer.name}</span>
        <PlayheadReadout />

        <span className="tl__spacer" />

        <button
          type="button"
          className="mm-btn"
          onClick={addAtPlayhead}
          disabled={model.rows.length === 0}
          title="재생 헤드 위치에 키프레임을 추가합니다"
        >
          키 추가
        </button>
        <button
          type="button"
          className="mm-btn"
          onClick={deleteSelected}
          disabled={selectedKeys.length === 0}
        >
          키 삭제
        </button>
        <button
          type="button"
          className="mm-btn"
          onClick={openGraphForSelection}
          disabled={model.rows.length === 0}
          title="속도 / 값 곡선을 편집합니다 (G)"
        >
          그래프
        </button>

        <button
          type="button"
          className="mm-btn"
          aria-pressed={snap}
          onClick={toggleSnap}
          title="프레임 격자에 붙입니다. Ctrl 을 누르면 일시 해제됩니다."
        >
          스냅
        </button>

        <div role="group" aria-label="타임라인 확대">
          <button
            type="button"
            className="mm-btn"
            aria-label="축소"
            onClick={() => zoomAtPlayhead(1 / 1.4)}
          >
            -
          </button>
          <button type="button" className="mm-btn" onClick={() => setZoom(1)}>
            맞춤
          </button>
          <button
            type="button"
            className="mm-btn"
            aria-label="확대"
            onClick={() => zoomAtPlayhead(1.4)}
          >
            +
          </button>
        </div>
      </div>

      <div className="tl__main">
        <div className="tl__head" style={{ minHeight: `${contentH}px` }}>
          <div className="tl__head-top" title={layer.name}>
            {layer.name}
          </div>
          {model.rows.map((row) => {
            const rowSelected = row.keys.some((k) =>
              selectedSet.has(selectionId(row.prop, k.f)),
            )
            return (
              <button
                key={row.prop}
                type="button"
                className="tl__row"
                aria-pressed={rowSelected}
                title={`${row.label} 트랙의 키프레임 ${row.keys.length}개를 모두 선택합니다`}
                onClick={() => {
                  setSelection(
                    row.keys.map((k) => ({ layerId: layer.id, prop: row.prop, frame: k.f })),
                  )
                }}
                onDoubleClick={() => openGraph({ layerId: layer.id, prop: row.prop })}
              >
                <span className="tl__row-name">{row.label}</span>
                <span className="tl__row-count" aria-hidden="true">
                  {row.keys.length}
                </span>
              </button>
            )
          })}
        </div>

        <div className="tl__body" ref={bodyRef} style={{ minHeight: `${contentH}px` }}>
          <canvas
            ref={canvasRef}
            aria-hidden="true"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onDoubleClick={onDoubleClick}
          />
        </div>

        {/* Canvas 와 같은 모델에서 파생되는 키보드 편집 경로. */}
        <TimelineAriaTree
          model={model}
          selected={selectedSet}
          onSelectKey={(prop, frame, additive) =>
            selectKey({ layerId: layer.id, prop, frame }, additive)
          }
          onDeleteKey={(prop, frame) => {
            removeKeyframe(layer.id, prop, frame)
          }}
          onMoveKey={(prop, from, to) => {
            // 대상 프레임이 차 있으면 문서 스토어가 이동을 거부한다. 그걸 모르고
            // remapSelection 을 부르면 선택이 옆 키를 가리키고, 다음 삭제가 그 키를 지운다.
            // 캔버스 드래그는 deltaValid 로 같은 검사를 이미 한다.
            const frames = liveFrames(prop)
            if (!frames.includes(from) || frames.includes(to)) return false
            moveKeyframe(layer.id, prop, from, to)
            remapSelection(layer.id, prop, from, to)
            return true
          }}
          onGoToFrame={(frame) => {
            setPlaying(false)
            setPlayheadFrame(frame)
          }}
          onOpenGraph={(prop) => openGraph({ layerId: layer.id, prop })}
        />
      </div>

      {/* 마커 모양의 뜻을 글로도 남긴다. 모양도 색도 못 읽는 경우가 있다. */}
      <p className="mm-visually-hidden">
        키프레임 마커 모양: 다이아몬드는 베지어, 원은 선형, 사각은 홀드, 별은 스프링입니다.
      </p>
    </div>
  )
}

export default Timeline
