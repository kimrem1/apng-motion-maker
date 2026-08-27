/**
 * 하단 타임라인.
 *
 * 두 층이다
 *
 *   위 — 클립. 문서의 **모든** 레이어가 한 줄씩이고, 막대가 그 레이어가 보이는
 *        구간이다. 막대를 끌면 통째로 옮겨지고 양끝을 끌면 길이가 바뀐다.
 *        여기가 "있다 없다" 를 만드는 자리다. 눈 깜빡임처럼 그림 여러 장을 딱딱
 *        바꿔 끼우는 편집은 이 층만 쓴다.
 *   아래 — 속성. 지금 고른 레이어 하나의 트랙과 키프레임이다. 예전 타임라인이
 *        하던 일 그대로다.
 *
 * 왜 한 캔버스에 두 층인가
 *
 * 두 개의 스크롤 영역으로 나누면 시간축이 갈라진다. 위층을 확대했는데 아래층은
 * 그대로인 순간, 같은 세로선이 두 층에서 다른 프레임을 가리킨다. 재생 헤드도
 * 두 개가 된다. 층은 나뉘어도 시간축은 하나여야 한다.
 *
 * 트랙 영역은 Canvas 2D 다. 키프레임 하나마다 DOM 노드를 만들면 120프레임 x 여러
 * 트랙에서 노드가 수천 개가 되고, 그 순간 스크럽이 버벅인다. 대신 좌측 머리
 * 열만 DOM 으로 두어 이름과 버튼이 정상적으로 포커스를 받게 한다.
 *
 * Canvas 는 접근성 트리에 아무것도 남기지 않으므로 ClipAriaList 와
 * TimelineAriaTree 를 함께 렌더한다. 세 표현은 같은 모델에서 파생된다.
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
import { useLayerUiStore, type LayerSelectMode } from '@/state/layerUi.ts'
import {
  clearRanges,
  defaultRangeFrames,
  dropRangeAt,
  setRangeEnd,
  setRangeStart,
  splitSequential,
} from '@/state/rangeActions.ts'
import { useTimelineUiStore, type KeyRef } from '@/state/timelineUi.ts'
import { useUiStore } from '@/state/ui.ts'
import { buildLayerRows } from '@/ui/layers/layerTree.ts'
import { GraphEditor } from './GraphEditor.tsx'
import { ClipAriaList, TimelineAriaTree } from './TimelineAriaTree.tsx'
import { setTimelineDropHost } from './timelineDrop.ts'
import {
  buildClipRows,
  buildTimelineModel,
  chooseGridStep,
  clipBottomY,
  clipRowIndexAtY,
  drawTimeline,
  hitRadius,
  hitTestClip,
  hitTestKey,
  prepareCanvas,
  readTheme,
  resolveClipDrag,
  rowIndexAtY,
  selectionId,
  timelineContentH,
  xToFrame,
  type ClipPart,
  type ClipRow,
  type TimelineGeometry,
  type TimelineModel,
} from './timelineDraw.ts'

const HEADER_W = 156
const RULER_H = 30
const ROW_H = 24
/** 클립 줄은 안에 막대가 들어가므로 트랙 줄보다 조금 높다. */
const CLIP_ROW_H = 26
/** 두 층 사이의 구분 머리. */
const SECTION_H = 18
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
  flex-wrap: wrap;
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

.tl__group {
  display: flex;
  align-items: center;
  gap: 2px;
  padding-left: var(--sp-2);
  border-left: 1px solid var(--border);
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

/* 층 구분 머리. 캔버스 쪽 SECTION_H 와 반드시 같은 높이여야 한다. */
.tl__sect {
  display: flex;
  align-items: center;
  height: ${SECTION_H}px;
  padding: 0 var(--sp-3);
  border-top: 1px solid var(--border-strong);
  border-bottom: 1px solid var(--border-strong);
  background: var(--surface-raised);
  color: var(--text-muted);
  font-size: 9px;
  font-weight: 600;
  letter-spacing: 0.06em;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-transform: uppercase;
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

.tl__clip {
  height: ${CLIP_ROW_H}px;
}

.tl__row:hover {
  background: var(--surface-hover);
  color: var(--text);
}

/* 선택된 줄은 배경 + 좌측 마커 두 가지로 표시한다. */
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

/* 숨긴 레이어는 클립 막대와 같은 규칙으로 흐리게 + 취소선이다. */
.tl__row.is-hidden .tl__row-name {
  color: var(--text-faint);
  text-decoration: line-through;
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

/*
 * 알림 줄. 비어 있어도 자리를 지운다.
 *
 * role=status 인 요소는 마운트되어 있어야 낭독기가 나중의 변화를 읽는다.
 * 조건부로 붙였다 떼면 붙는 순간의 문구를 놓친다. 그래서 비었을 때는 높이만 0 이다.
 */
.tl__notice {
  flex: none;
  margin: 0;
  overflow: hidden;
  color: var(--text-muted);
  font-size: var(--fs-xs);
  line-height: 1.4;
}

.tl__notice:not(:empty) {
  padding: var(--sp-1) var(--sp-3);
  border-top: 1px solid var(--border);
}
`

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

interface KeyDrag {
  kind: 'keys'
  pointerId: number
  startFrame: number
  items: { prop: TrackProp; orig: number; cur: number }[]
  applied: number
  /**
   * 이 드래그 한 번을 실행취소 한 칸으로 묶는 열쇠 (ClipDrag 와 같은 패턴).
   * moveKeyframe 의 기본 coalesce 는 속성 단위라, 여러 속성의 키를 함께 끌면
   * 스택에 A,B,A,B 로 번갈아 쌓여 병합이 전혀 안 된다.
   */
  key: string
}

interface ScrubDrag {
  kind: 'scrub'
  pointerId: number
}

interface ClipDrag {
  kind: 'clip'
  pointerId: number
  part: ClipPart
  /** 누른 지점의 프레임(소수). 델타 계산 기준이다. */
  startFrame: number
  /**
   * 아직 구간이 없는 줄을 누른 상태.
   *
   * 그 줄의 막대는 폭 전체라서 누르기만 해도 잡힌다. 누른 즉시 구간을 만들면
   * 줄을 골라 보려던 클릭이 매번 구간을 만들어 버린다. 실제로 한 프레임 이상
   * 움직였을 때만 만든다.
   */
  pending: boolean
  items: { layerId: string; start: number; end: number }[]
  applied: number
  /** 이 드래그 한 번을 실행취소 한 칸으로 묶는 열쇠. */
  key: string
}

type DragState = KeyDrag | ScrubDrag | ClipDrag

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
  const setLayerRanges = useDocumentStore((s) => s.setLayerRanges)

  const selectedLayerId = useUiStore((s) => s.selectedLayerId)
  const setPlayheadFrame = useUiStore((s) => s.setPlayheadFrame)
  const setPlaying = useUiStore((s) => s.setPlaying)

  const selectedLayerIds = useLayerUiStore((s) => s.selectedLayerIds)
  const collapsedFolderIds = useLayerUiStore((s) => s.collapsedFolderIds)
  const selectLayer = useLayerUiStore((s) => s.select)

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
  const duration = Math.max(1, timeline.durationFrames)

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

  /*
   * 클립 줄. 순서와 접힘은 레이어 패널이 쓰는 계산 그대로다.
   * 여기서 다시 계산하면 두 패널이 다른 순서로 보이고, 어느 줄이 어느 그림인지
   * 눈으로 이을 수 없게 된다.
   */
  const clips: ClipRow[] = useMemo(() => {
    const rows = buildLayerRows(layers, new Set(collapsedFolderIds))
    return buildClipRows(rows, duration)
  }, [layers, collapsedFolderIds, duration])

  const clipOrder = useMemo(() => clips.map((c) => c.layerId), [clips])

  /** 클립 막대의 테를 굵게 그릴 레이어들. 목록 선택과 인스펙터 선택을 합친다. */
  const activeLayerIds = useMemo(() => {
    const set = new Set(selectedLayerIds)
    if (selectedLayerId) set.add(selectedLayerId)
    return set
  }, [selectedLayerIds, selectedLayerId])

  /** 구간 명령이 대상으로 삼는 레이어들. 목록 순서를 따른다. */
  const rangeTargets = useMemo(
    () => clipOrder.filter((id) => activeLayerIds.has(id)),
    [clipOrder, activeLayerIds],
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
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })

  /*
   * 트랙 영역은 상태로 들고 있는다. ref 가 아니다.
   *
   * 이 영역은 레이어가 하나도 없을 때 아예 마운트되지 않는다. ref 로 두고 빈
   * 의존성으로 옵저버를 걸면, 마운트 시점에 ref 가 비어 있어서 옵저버가 한 번도
   * 붙지 않는다. 그러면 size 가 0 에 머물고 캔버스는 영원히 빈 채로 남는다.
   * 요소가 나타나고 사라질 때마다 다시 걸리도록 상태로 흘린다.
   */
  const [bodyEl, setBodyEl] = useState<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!bodyEl) return
    const ro = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect
      if (!rect) return
      setSize({ w: Math.round(rect.width), h: Math.round(rect.height) })
    })
    ro.observe(bodyEl)
    return () => ro.disconnect()
  }, [bodyEl])

  // zoom 1 = 전체 구간이 폭에 딱 맞는다. 그 아래로는 줄이지 않는다.
  const basePx = size.w > 0 ? size.w / duration : 8
  const pxPerFrame = Math.max(0.5, basePx * zoom)
  const visibleFrames = size.w > 0 ? size.w / pxPerFrame : duration
  const maxScroll = Math.max(0, duration - visibleFrames)
  const scroll = clamp(scrollFrame, 0, maxScroll)

  const trackCount = model?.rows.length ?? 0

  const geo: TimelineGeometry = useMemo(
    () => ({
      rulerH: RULER_H,
      rowH: ROW_H,
      clipRowH: CLIP_ROW_H,
      clipCount: clips.length,
      sectionH: SECTION_H,
      trackCount,
      axis: { originX: 0, pxPerFrame, scrollFrame: scroll },
    }),
    [pxPerFrame, scroll, clips.length, trackCount],
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
  const hoveredLayerRef = useRef<string | null>(null)
  const rafRef = useRef(0)
  const [drop, setDrop] = useState<{ layerId: string; start: number; end: number } | null>(null)

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas || size.w <= 0 || size.h <= 0) return
    const ctx = prepareCanvas(canvas, size.w, size.h)
    if (!ctx) return
    drawTimeline(ctx, {
      theme: readTheme(canvas),
      width: size.w,
      height: size.h,
      geo,
      fps: timeline.fps,
      durationFrames: duration,
      clips,
      model,
      playhead: playheadRef.current,
      selected: selectedSet,
      hovered: hoveredRef.current,
      selectedLayerIds: activeLayerIds,
      hoveredLayerId: hoveredLayerRef.current,
      drop,
      loopMode: timeline.loop.mode,
    })
  }, [
    geo,
    clips,
    model,
    selectedSet,
    activeLayerIds,
    drop,
    size.w,
    size.h,
    timeline.fps,
    timeline.loop.mode,
    duration,
  ])

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
    const el = bodyEl
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
  }, [pxPerFrame, bodyEl])

  // -------------------------------------------------------------------------
  // 레이어 패널에서 끌어다 놓기
  // -------------------------------------------------------------------------

  /*
   * 드롭 핸들러는 한 번만 건다. 그 안에서 읽어야 하는 값(기하, 줄 목록)은 매
   * 렌더마다 ref 로 흘려 둔다. 의존성에 넣어 다시 걸면 드래그 도중에 핸들러가
   * 바뀌어 hover 로 그려 둔 표시가 사라진다.
   */
  const geoRef = useRef(geo)
  const clipsRef = useRef(clips)
  const durationRef = useRef(duration)
  geoRef.current = geo
  clipsRef.current = clips
  durationRef.current = duration

  useEffect(() => {
    /** 뷰포트 좌표가 클립 층 안이면 그 프레임을, 아니면 null 을 준다. */
    const probe = (clientX: number, clientY: number, layerId: string) => {
      const canvas = canvasRef.current
      if (!canvas) return null
      const rect = canvas.getBoundingClientRect()
      const x = clientX - rect.left
      const y = clientY - rect.top
      if (x < 0 || x > rect.width) return null
      if (y < RULER_H || y >= clipBottomY(geoRef.current)) return null
      const index = clipsRef.current.findIndex((c) => c.layerId === layerId)
      if (index < 0) return null

      const row = clipsRef.current[index]!
      const last = Math.max(0, durationRef.current - 1)
      const span = row.explicit
        ? Math.max(1, row.end - row.start + 1)
        : defaultRangeFrames(durationRef.current)
      const start = clamp(
        Math.round(xToFrame(x, geoRef.current.axis)),
        0,
        Math.max(0, last - span + 1),
      )
      return { layerId, start, end: Math.min(last, start + span - 1) }
    }

    return setTimelineDropHost({
      hover(clientX, clientY, layerId) {
        const next = probe(clientX, clientY, layerId)
        setDrop((prev) => {
          if (!next) return prev === null ? prev : null
          if (prev && prev.layerId === next.layerId && prev.start === next.start) return prev
          return next
        })
        return next !== null
      },
      drop(clientX, clientY, layerId) {
        const next = probe(clientX, clientY, layerId)
        if (!next) return false
        return dropRangeAt(layerId, next.start)
      },
      cancel() {
        setDrop((prev) => (prev === null ? prev : null))
      },
    })
  }, [])

  // -------------------------------------------------------------------------
  // 포인터
  // -------------------------------------------------------------------------

  const dragRef = useRef<DragState | null>(null)
  const dragSeq = useRef(0)

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
  function deltaValid(items: KeyDrag['items'], delta: number): boolean {
    const byProp = new Map<TrackProp, KeyDrag['items']>()
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

  function applyDelta(drag: KeyDrag, delta: number): void {
    const layerId = layer?.id
    if (!layerId) return
    const byProp = new Map<TrackProp, KeyDrag['items']>()
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
        moveKeyframe(layerId, prop, it.cur, to, drag.key)
        remapSelection(layerId, prop, it.cur, to)
        it.cur = to
      }
    }
    drag.applied = delta
  }

  /** 클립 막대를 옮긴다. 값 규칙은 timelineDraw 의 resolveClipDrag 한 곳에만 있다. */
  function applyClipDelta(drag: ClipDrag, delta: number): void {
    const entries = resolveClipDrag(drag.part, drag.items, delta, duration - 1)
    if (entries.length === 0) return
    setLayerRanges(entries, '구간 변경', { coalesceKey: drag.key })
    drag.applied = delta
  }

  function scrubTo(rawFrame: number): void {
    setPlayheadFrame(clamp(Math.round(rawFrame), 0, duration - 1))
  }

  function beginScrub(e: ReactPointerEvent<HTMLCanvasElement>, x: number): void {
    setPlaying(false)
    dragRef.current = { kind: 'scrub', pointerId: e.pointerId }
    scrubTo(xToFrame(x, geo.axis))
  }

  function onPointerDown(e: ReactPointerEvent<HTMLCanvasElement>): void {
    const { x, y } = localPoint(e)
    const additive = e.shiftKey || e.ctrlKey || e.metaKey

    // 캔버스는 포커스를 못 받는다. Delete 같은 키가 먹으려면 컨테이너로 옮긴다.
    rootRef.current?.focus()
    e.currentTarget.setPointerCapture(e.pointerId)

    // --- 눈금자: 스크럽 ---
    if (y < RULER_H) {
      if (!additive) clearSelection()
      beginScrub(e, x)
      return
    }

    // --- 클립 층 ---
    if (y < clipBottomY(geo)) {
      const hit = hitTestClip(clips, geo, x, y, e.pointerType === 'touch' ? 12 : undefined)
      const rowIndex = clipRowIndexAtY(y, geo)
      const row = rowIndex >= 0 ? clips[rowIndex] : undefined
      if (!hit || !row) {
        beginScrub(e, x)
        return
      }

      const mode: LayerSelectMode = e.ctrlKey || e.metaKey ? 'toggle' : e.shiftKey ? 'range' : 'replace'
      const alreadyActive = activeLayerIds.has(row.layerId)
      // 이미 고른 여러 장을 함께 끌 수 있어야 한다. 그때는 선택을 건드리지 않는다.
      if (!(alreadyActive && !additive)) selectLayer(row.layerId, mode, clipOrder)

      // 잠긴 레이어는 옮기지 않는다. 고르는 것까지는 된다.
      if (row.locked) return

      const group =
        alreadyActive && rangeTargets.length > 1
          ? clips.filter((c) => activeLayerIds.has(c.layerId) && !c.locked)
          : [row]

      dragSeq.current += 1
      const explicitGroup = group.filter((c) => c.explicit)
      const pending = explicitGroup.length === 0 && hit.part === 'body'

      dragRef.current = {
        kind: 'clip',
        pointerId: e.pointerId,
        part: hit.part,
        startFrame: xToFrame(x, geo.axis),
        pending,
        // 양끝을 잡는 것은 구간이 없는 줄에서도 바로 뜻이 있다. 거기서 구간이 생긴다.
        items: (hit.part === 'body' && explicitGroup.length > 0 ? explicitGroup : group).map(
          (c) => ({ layerId: c.layerId, start: c.start, end: c.end }),
        ),
        applied: 0,
        key: `clipDrag:${dragSeq.current}`,
      }
      return
    }

    // --- 속성 층 ---
    if (!model) {
      beginScrub(e, x)
      return
    }
    const hit = hitTestKey(model, geo, x, y, hitRadius(e.pointerType))
    if (hit && layer) {
      const ref: KeyRef = { layerId: layer.id, prop: hit.prop, frame: hit.frame }
      const already = selectedSet.has(selectionId(hit.prop, hit.frame))
      if (additive) selectKey(ref, true)
      else if (!already) setSelection([ref])

      const base = additive || already ? useTimelineUiStore.getState().selectedKeys : [ref]
      const items = base
        .filter((k) => k.layerId === layer.id)
        .map((k) => ({ prop: k.prop, orig: k.frame, cur: k.frame }))
      dragSeq.current += 1
      dragRef.current = {
        kind: 'keys',
        pointerId: e.pointerId,
        startFrame: xToFrame(x, geo.axis),
        items,
        applied: 0,
        key: `kfdrag:${dragSeq.current}`,
      }
      return
    }

    // 빈 곳을 누르면 선택 해제 + 스크럽. 재생 중이면 멈춰야 손이 맞는다.
    if (!additive) clearSelection()
    beginScrub(e, x)
  }

  function onPointerMove(e: ReactPointerEvent<HTMLCanvasElement>): void {
    const { x, y } = localPoint(e)
    const drag = dragRef.current

    if (!drag) {
      let cursor = 'default'
      let keyId: string | null = null
      let layerHover: string | null = null

      if (y < RULER_H) {
        cursor = 'ew-resize'
      } else if (y < clipBottomY(geo)) {
        const hit = hitTestClip(clips, geo, x, y, e.pointerType === 'touch' ? 12 : undefined)
        if (hit) {
          layerHover = hit.layerId
          cursor = hit.part === 'body' ? 'grab' : 'ew-resize'
        }
      } else if (model) {
        const hit = hitTestKey(model, geo, x, y, hitRadius(e.pointerType))
        if (hit) {
          keyId = selectionId(hit.prop, hit.frame)
          cursor = 'grab'
        }
      }

      if (keyId !== hoveredRef.current || layerHover !== hoveredLayerRef.current) {
        hoveredRef.current = keyId
        hoveredLayerRef.current = layerHover
        requestDraw()
      }
      e.currentTarget.style.cursor = cursor
      return
    }
    if (drag.pointerId !== e.pointerId) return

    if (drag.kind === 'scrub') {
      scrubTo(xToFrame(x, geo.axis))
      return
    }

    const noSnap = e.ctrlKey || e.metaKey
    const raw = xToFrame(x, geo.axis) - drag.startFrame

    if (drag.kind === 'clip') {
      /*
       * 구간이 없던 줄. 실제로 움직였을 때 비로소 구간을 만든다.
       * 만든 자리를 새 기준으로 삼아야 이어지는 이동이 손을 따라온다.
       */
      if (drag.pending) {
        if (Math.abs(raw) < 1) return
        const last = duration - 1
        const span = Math.min(defaultRangeFrames(duration), last + 1)
        const start = clamp(
          Math.round(xToFrame(x, geo.axis)) - Math.floor(span / 2),
          0,
          Math.max(0, last - span + 1),
        )
        drag.items = drag.items.map((i) => ({
          layerId: i.layerId,
          start,
          end: Math.min(last, start + span - 1),
        }))
        drag.pending = false
        drag.startFrame = xToFrame(x, geo.axis)
        drag.applied = 0
        applyClipDelta(drag, 0)
        return
      }
      const delta = snapDelta(raw, noSnap)
      if (delta === drag.applied) return
      applyClipDelta(drag, delta)
      return
    }

    let delta = snapDelta(raw, noSnap)

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

  /**
   * 구간을 만들거나 지운다. 클립 줄의 더블클릭이다.
   *
   * 구간이 있으면 지우고(다시 처음부터 끝까지 보인다), 없으면 재생 헤드에서
   * 시작하는 기본 길이의 구간을 만든다. 있다 없다를 한 조작으로 오간다.
   */
  function toggleRange(row: ClipRow): void {
    if (row.explicit) {
      clearRanges([row.layerId])
      return
    }
    const last = duration - 1
    const span = Math.min(defaultRangeFrames(duration), last + 1)
    const start = clamp(playheadRef.current, 0, Math.max(0, last - span + 1))
    setLayerRanges(
      [{ layerId: row.layerId, inFrame: start, outFrame: Math.min(last, start + span - 1) }],
      '구간 만들기',
    )
  }

  function onDoubleClick(e: ReactMouseEvent<HTMLCanvasElement>): void {
    const { x, y } = localPoint(e)

    if (y >= RULER_H && y < clipBottomY(geo)) {
      const index = clipRowIndexAtY(y, geo)
      const row = index >= 0 ? clips[index] : undefined
      if (row && !row.locked) toggleRange(row)
      return
    }

    if (!model || !layer) return
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

  const [notice, setNotice] = useState<string | null>(null)

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

  function doSplit(): void {
    if (rangeTargets.length < 2) {
      setNotice('레이어를 두 장 이상 고르세요. Ctrl 클릭으로 여러 장을 고릅니다.')
      return
    }
    const made = splitSequential(rangeTargets)
    setNotice(
      made < rangeTargets.length
        ? `프레임이 모자라 ${made}장까지만 나눴습니다. 전체 길이를 늘리세요.`
        : `${made}장을 차례로 나눴습니다. 겹침 없이 딱 바뀝니다.`,
    )
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
      case '[':
        if (rangeTargets.length === 0) return
        e.preventDefault()
        setRangeStart(rangeTargets, playheadRef.current)
        return
      case ']':
        if (rangeTargets.length === 0) return
        e.preventDefault()
        setRangeEnd(rangeTargets, playheadRef.current)
        return
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
        // 화살표와 같은 이유로 먼저 멈춘다. 재생 중에는 useRenderer 의 구독이
        // 이 값을 버리고 100ms 안에 재생 루프의 publish 가 도로 덮어쓴다.
        setPlaying(false)
        setPlayheadFrame(0)
        return
      case 'End':
        e.preventDefault()
        setPlaying(false)
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

  if (clips.length === 0) {
    return (
      <div className="tl">
        <style href="mm-timeline" precedence="default">
          {TIMELINE_CSS}
        </style>
        <div className="tl__bar">
          <span className="tl__title">타임라인</span>
        </div>
        <p className="tl__empty">이미지나 도형을 넣으면 레이어가 여기에 줄로 나타납니다.</p>
      </div>
    )
  }

  const contentH = timelineContentH(geo)
  const hasRange = rangeTargets.some((id) => clips.find((c) => c.layerId === id)?.explicit)

  return (
    // Delete 나 화살표를 받으려면 컨테이너가 포커스를 가질 수 있어야 한다.
    // Tab 순서에는 넣지 않는다. 키보드 편집 경로는 접근성 트리 쪽이다.
    <div className="tl" ref={rootRef} tabIndex={-1} onKeyDown={onKeyDown}>
      <style href="mm-timeline" precedence="default">
        {TIMELINE_CSS}
      </style>

      <div className="tl__bar">
        <span className="tl__title">타임라인</span>
        <PlayheadReadout />

        <div className="tl__group" role="group" aria-label="구간">
          <button
            type="button"
            className="mm-btn"
            onClick={() => setRangeStart(rangeTargets, playheadRef.current)}
            disabled={rangeTargets.length === 0}
            title="고른 레이어가 재생 헤드에서 나타나기 시작합니다 ( [ )"
          >
            시작 [
          </button>
          <button
            type="button"
            className="mm-btn"
            onClick={() => setRangeEnd(rangeTargets, playheadRef.current)}
            disabled={rangeTargets.length === 0}
            title="고른 레이어가 재생 헤드까지만 보입니다 ( ] )"
          >
            끝 ]
          </button>
          <button
            type="button"
            className="mm-btn"
            onClick={doSplit}
            disabled={rangeTargets.length < 2}
            title="고른 레이어를 목록 순서대로 겹치지 않게 나눕니다. 눈 깜빡임처럼 그림을 딱딱 바꿔 끼울 때 씁니다."
          >
            차례로 나누기
          </button>
          <button
            type="button"
            className="mm-btn"
            onClick={() => clearRanges(rangeTargets)}
            disabled={!hasRange}
            title="구간을 지웁니다. 그 레이어는 다시 처음부터 끝까지 보입니다."
          >
            구간 해제
          </button>
        </div>

        <span className="tl__spacer" />

        <div className="tl__group" role="group" aria-label="키프레임">
          <button
            type="button"
            className="mm-btn"
            onClick={addAtPlayhead}
            disabled={trackCount === 0}
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
            disabled={trackCount === 0}
            title="속도 / 값 곡선을 편집합니다 (G)"
          >
            그래프
          </button>
        </div>

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
          <div className="tl__head-top">레이어</div>

          {clips.map((row) => (
            <button
              key={row.layerId}
              type="button"
              className={`tl__row tl__clip${row.visible ? '' : ' is-hidden'}`}
              style={{ paddingLeft: `${12 + Math.min(4, row.depth) * 10}px` }}
              aria-pressed={activeLayerIds.has(row.layerId)}
              title={
                row.explicit
                  ? `${row.name} · ${row.start}~${row.end} 프레임에만 보입니다`
                  : `${row.name} · 처음부터 끝까지 보입니다. 막대 양끝을 끌면 구간이 생깁니다.`
              }
              onClick={(e) => {
                const mode: LayerSelectMode =
                  e.ctrlKey || e.metaKey ? 'toggle' : e.shiftKey ? 'range' : 'replace'
                selectLayer(row.layerId, mode, clipOrder)
              }}
            >
              <span className="tl__row-name">{row.name}</span>
              <span className="tl__row-count" aria-hidden="true">
                {row.explicit ? `${row.start}-${row.end}` : '전체'}
              </span>
            </button>
          ))}

          {trackCount > 0 && model ? (
            <>
              <div className="tl__sect" title={`${model.layerName} 의 속성 트랙`}>
                속성 · {model.layerName}
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
                      if (!layer) return
                      setSelection(
                        row.keys.map((k) => ({ layerId: layer.id, prop: row.prop, frame: k.f })),
                      )
                    }}
                    onDoubleClick={() => {
                      if (layer) openGraph({ layerId: layer.id, prop: row.prop })
                    }}
                  >
                    <span className="tl__row-name">{row.label}</span>
                    <span className="tl__row-count" aria-hidden="true">
                      {row.keys.length}
                    </span>
                  </button>
                )
              })}
            </>
          ) : null}
        </div>

        <div className="tl__body" ref={setBodyEl} style={{ minHeight: `${contentH}px` }}>
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
        <ClipAriaList
          rows={clips}
          fps={timeline.fps}
          durationFrames={duration}
          selected={activeLayerIds}
          onSelect={(layerId, additive) =>
            selectLayer(layerId, additive ? 'toggle' : 'replace', clipOrder)
          }
          onSetRange={(layerId, start, end) => {
            setLayerRanges([{ layerId, inFrame: start, outFrame: end }], '구간 변경')
          }}
          onClearRange={(layerId) => clearRanges([layerId])}
          onGoToFrame={(frame) => {
            setPlaying(false)
            setPlayheadFrame(frame)
          }}
        />

        {model ? (
          <TimelineAriaTree
            model={model}
            selected={selectedSet}
            onSelectKey={(prop, frame, additive) =>
              layer ? selectKey({ layerId: layer.id, prop, frame }, additive) : undefined
            }
            onDeleteKey={(prop, frame) => {
              if (layer) removeKeyframe(layer.id, prop, frame)
            }}
            onMoveKey={(prop, from, to) => {
              // 대상 프레임이 차 있으면 문서 스토어가 이동을 거부한다. 그걸 모르고
              // remapSelection 을 부르면 선택이 옆 키를 가리키고, 다음 삭제가 그 키를 지운다.
              // 캔버스 드래그는 deltaValid 로 같은 검사를 이미 한다.
              if (!layer) return false
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
            onOpenGraph={(prop) => {
              if (layer) openGraph({ layerId: layer.id, prop })
            }}
          />
        ) : null}
      </div>

      <p className="tl__notice" role="status">
        {notice}
      </p>

      {/* 마커와 막대 모양의 뜻을 글로도 남긴다. 모양도 색도 못 읽는 경우가 있다. */}
      <p className="mm-visually-hidden">
        위층은 레이어마다 한 줄이고 막대가 그 레이어가 보이는 구간입니다. 막대를 끌면 통째로
        옮겨지고 양끝을 끌면 길이가 바뀝니다. 점선 막대는 구간이 없다는 뜻이라 처음부터 끝까지
        보입니다. 아래층 키프레임 마커 모양: 다이아몬드는 베지어, 원은 선형, 사각은 홀드, 별은
        스프링입니다.
      </p>
    </div>
  )
}

export default Timeline
