/**
 * 레이어 패널.
 *
 * 목록은 위가 앞이다. 문서 배열은 z 오름차순(0 이 맨 뒤)이라 뒤집어 그린다.
 * 포토샵/피그마를 쓴 사람은 예외 없이 그렇게 기대한다.
 *
 * 폴더는 머리행이 식구들 **위**에 오고 접을 수 있다. 그 계산은 layerTree.ts 가
 * 전부 한다. 여기서 다시 적으면 눈에 보이는 자리와 끌어다 놓은 자리가 갈라진다.
 *
 * 재정렬은 HTML5 드래그를 쓰지 않는다. dragImage 를 브라우저가 마음대로 그리고,
 * dragover 좌표가 200ms 단위로 끊겨 들어와 손가락보다 늦게 따라온다.
 * pointer 이벤트 + setPointerCapture 로 직접 구현한다.
 *
 * 접근성 메모:
 *   ul[role=listbox] / li[role=option] 이고 화살표로 이동한다.
 *   행 안의 아이콘 버튼은 tabIndex=-1 이다. 레이어 10개면 Tab 이 40번 걸리기 때문이다.
 *   대신 행에서 키로 전부 조작할 수 있다.
 *     Space 가시성, L 잠금, C 아래 모양으로 자르기, Enter/F2 이름 편집, Delete 삭제,
 *     Alt+상하 순서 이동,
 *     좌우 화살표로 폴더 접기/펴기
 *   합성 모드만 키보드로 못 바꾸는데, 그건 인스펙터의 LayerProperties 가 담당한다.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'

import type { BlendMode, Layer, ShapeSpec } from '@/core/types.ts'
import { toHex6 } from '@/core/shape.ts'
import { assetRegistry } from '@/state/assets.ts'
import { useDocumentStore, withFolderContents } from '@/state/document.ts'
import { useLayerUiStore, type LayerSelectMode } from '@/state/layerUi.ts'
import { useUiStore } from '@/state/ui.ts'
import { addSingleShape } from '@/state/shapeActions.ts'
import { AddLayerMenu } from './AddLayerMenu.tsx'
import { ReplaceImageButton } from './ReplaceImageButton.tsx'
import {
  timelineDropCancel,
  timelineDropCommit,
  timelineDropHover,
} from '@/ui/timeline/timelineDrop.ts'
import { BLEND_OPTIONS, moveLayerTo, setLayerBlend, setLayerClip } from './layerDocActions.ts'
import { buildLayerRows, dropTarget } from './layerTree.ts'
import './layers.css'

/** 썸네일 캔버스의 실제 픽셀. CSS 는 32px 이므로 2배 해상도다. */
const THUMB_PX = 64

/** 이 거리를 넘어야 드래그로 친다. 손 떨림으로 순서가 바뀌면 안 된다. */
const DRAG_THRESHOLD_PX = 4

// ---------------------------------------------------------------------------
// 아이콘
// ---------------------------------------------------------------------------

function IconShape() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="2.2" y="2.2" width="7.6" height="7.6" rx="1.6" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="10.4" cy="10.4" r="3.4" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  )
}

function IconGrip() {
  return (
    <svg width="10" height="16" viewBox="0 0 10 16" fill="currentColor" aria-hidden="true">
      <circle cx="3" cy="4" r="1.1" />
      <circle cx="7" cy="4" r="1.1" />
      <circle cx="3" cy="8" r="1.1" />
      <circle cx="7" cy="8" r="1.1" />
      <circle cx="3" cy="12" r="1.1" />
      <circle cx="7" cy="12" r="1.1" />
    </svg>
  )
}

function IconEye({ open }: { open: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M1.5 8S3.9 3.75 8 3.75 14.5 8 14.5 8 12.1 12.25 8 12.25 1.5 8 1.5 8Z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <circle cx="8" cy="8" r="2" stroke="currentColor" strokeWidth="1.3" />
      {open ? null : (
        <path d="M2.5 13.5L13.5 2.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      )}
    </svg>
  )
}

function IconLock({ locked }: { locked: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect
        x="3.25"
        y="7"
        width="9.5"
        height="6.5"
        rx="1.2"
        stroke="currentColor"
        strokeWidth="1.3"
      />
      <path
        d={locked ? 'M5.5 7V5.2a2.5 2.5 0 0 1 5 0V7' : 'M5.5 7V5.2a2.5 2.5 0 0 1 4.9-.6'}
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  )
}

function IconTrash() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M2.75 4.25h10.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <path
        d="M4.5 4.25l.6 8.05c.03.4.36.7.75.7h4.3c.39 0 .72-.3.75-.7l.6-8.05"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <path
        d="M6.25 4.25V3.2c0-.39.31-.7.7-.7h2.1c.39 0 .7.31.7.7v1.05"
        stroke="currentColor"
        strokeWidth="1.3"
      />
    </svg>
  )
}

/**
 * 아래 모양으로 자르기 표식.
 *
 * 포토샵의 클리핑 마스크와 같은 모양이다. 꺾쇠가 아래를 가리키고, 그 아래가
 * 밑판이라는 뜻이다. 켜지면 채워진다.
 */
function IconClip({ on }: { on: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M4 4.5h8"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeDasharray={on ? undefined : '2 2'}
      />
      <path d="M6.4 7.2 8 9l1.6-1.8" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <rect
        x="3.25"
        y="10"
        width="9.5"
        height="3.5"
        rx="1"
        stroke="currentColor"
        strokeWidth="1.3"
        fill={on ? 'currentColor' : 'none'}
      />
    </svg>
  )
}

function IconFolder() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path
        d="M2.5 5.25c0-.69.56-1.25 1.25-1.25h3.1c.4 0 .77.19 1 .51l.79 1.09h6.11c.69 0 1.25.56 1.25 1.25v7.4c0 .69-.56 1.25-1.25 1.25H3.75c-.69 0-1.25-.56-1.25-1.25V5.25z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** 폴더를 접고 펴는 삼각형. 펼침이 아래를 가리킨다. */
function IconCaret({ open }: { open: boolean }) {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor" aria-hidden="true">
      <path d={open ? 'M1 3h8L5 8z' : 'M3 1v8l5-4z'} />
    </svg>
  )
}

// ---------------------------------------------------------------------------
// 썸네일
// ---------------------------------------------------------------------------

/**
 * 도형 레이어의 썸네일.
 *
 * 렌더러의 SDF 를 그대로 옮기지 않는다. 32px 안에서는 어차피 구별이 안 되고,
 * 여기서 필요한 것은 "몇 번째가 그 도형인가" 뿐이다. 종류와 색만 맞춘다.
 */
function paintShapeThumb(ctx: CanvasRenderingContext2D, shape: ShapeSpec, size: number): void {
  const cx = size / 2
  const cy = size / 2
  const r = size * 0.38
  ctx.fillStyle = toHex6(shape.color)
  ctx.strokeStyle = toHex6(shape.color)
  ctx.lineWidth = Math.max(1.5, size * 0.09)
  ctx.beginPath()

  const radial = (n: number, inner: number): void => {
    const steps = inner < 1 ? n * 2 : n
    for (let i = 0; i < steps; i += 1) {
      const a = (i / steps) * Math.PI * 2 - Math.PI / 2
      const rr = inner < 1 && i % 2 === 1 ? r * inner : r
      const x = cx + Math.cos(a) * rr
      const y = cy + Math.sin(a) * rr
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    ctx.closePath()
  }

  switch (shape.kind) {
    case 'circle':
      ctx.ellipse(cx, cy, r, r * (shape.height / Math.max(1, shape.width)), 0, 0, Math.PI * 2)
      break
    case 'triangle':
      radial(3, 1)
      break
    case 'polygon':
      radial(shape.points, 1)
      break
    case 'star':
      radial(shape.points, shape.innerRatio)
      break
    case 'cross': {
      const t = r * 0.36
      ctx.rect(cx - r, cy - t, r * 2, t * 2)
      ctx.rect(cx - t, cy - r, t * 2, r * 2)
      break
    }
    case 'arc': {
      const half = ((shape.sweepDeg / 2) * Math.PI) / 180
      ctx.moveTo(cx, cy)
      ctx.arc(cx, cy, r, -Math.PI / 2 - half, -Math.PI / 2 + half)
      ctx.closePath()
      break
    }
    case 'rect':
    default: {
      const rad = Math.min(r * 0.9, (shape.cornerRadius / Math.max(1, shape.width)) * size)
      ctx.roundRect(cx - r, cy - r, r * 2, r * 2, rad)
      break
    }
  }

  if (shape.strokeWidth > 0) ctx.stroke()
  else ctx.fill()
}

/** 에셋 비트맵을 작은 캔버스에 contain 으로 그린다. 리비전이 바뀌면 다시 그린다. */
export function LayerThumb({
  assetId,
  shape,
  name,
}: {
  assetId: string | null
  shape?: ShapeSpec
  name: string
}) {
  const revision = useSyncExternalStore(assetRegistry.subscribe, assetRegistry.getRevision)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    ctx.clearRect(0, 0, canvas.width, canvas.height)
    if (shape) {
      paintShapeThumb(ctx, shape, canvas.width)
      return
    }
    if (!assetId) return
    const bitmap = assetRegistry.get(assetId)
    if (!bitmap) return

    const scale = Math.min(canvas.width / bitmap.width, canvas.height / bitmap.height)
    const w = Math.max(1, Math.round(bitmap.width * scale))
    const h = Math.max(1, Math.round(bitmap.height * scale))
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(
      bitmap,
      Math.round((canvas.width - w) / 2),
      Math.round((canvas.height - h) / 2),
      w,
      h,
    )
    // revision 은 비트맵 교체 감지용이다. 값 자체는 쓰지 않는다.
  }, [assetId, shape, revision])

  return (
    <canvas
      ref={canvasRef}
      className="mm-lyr-thumb mm-checker"
      width={THUMB_PX}
      height={THUMB_PX}
      role="img"
      aria-label={`${name} 썸네일`}
    />
  )
}

// ---------------------------------------------------------------------------
// 드래그 상태
// ---------------------------------------------------------------------------

/**
 * 마우스가 잡고 있는 동안만 사는 값. ref 에 둔다.
 * boundary 를 state 에만 두면 pointerup 핸들러가 옛 값을 본다.
 */
interface DragMeta {
  pointerId: number
  layerId: string
  startY: number
  /** 표시 순서 기준 원래 위치 */
  fromDisplay: number
  /** 표시 순서대로의 각 행 세로 중점 (드래그 시작 시점 측정값) */
  mids: number[]
  /** 목록의 스크롤 컨테이너. 드래그 중 스크롤되면 mids 가 낡는다. */
  scrollHost: Element | null
  /** 드래그 시작 시점의 scrollTop */
  startScroll: number
  /** 삽입 경계. 0 = 맨 위, n = 맨 아래 */
  boundary: number
  active: boolean
  /** 손이 타임라인 위로 갔는가. 그 순간 드래그의 뜻이 순서에서 구간으로 바뀜다. */
  overTimeline: boolean
}

/** 렌더에 필요한 만큼만 뽑은 사본 */
interface DragView {
  layerId: string
  boundary: number
  active: boolean
  overTimeline: boolean
}

// ---------------------------------------------------------------------------

export function LayerPanel() {
  const layers = useDocumentStore((s) => s.doc.layers)
  const removeLayer = useDocumentStore((s) => s.removeLayer)
  const setLayerFlag = useDocumentStore((s) => s.setLayerFlag)
  const setAllLayersFlag = useDocumentStore((s) => s.setAllLayersFlag)
  const setLayerName = useDocumentStore((s) => s.setLayerName)
  const addFolder = useDocumentStore((s) => s.addFolder)

  const selectedIds = useLayerUiStore((s) => s.selectedLayerIds)
  const select = useLayerUiStore((s) => s.select)
  const setSelectedLayerIds = useLayerUiStore((s) => s.setSelectedLayerIds)
  const pruneLayerSelection = useLayerUiStore((s) => s.pruneLayerSelection)
  const collapsedIds = useLayerUiStore((s) => s.collapsedFolderIds)
  const toggleFolderCollapsed = useLayerUiStore((s) => s.toggleFolderCollapsed)
  const uiSelectedId = useUiStore((s) => s.selectedLayerId)

  /** 로빙 tabindex 의 현재 대상. 선택과 별개다(Ctrl+화살표는 포커스만 옮긴다). */
  const [activeId, setActiveId] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draftName, setDraftName] = useState('')
  const [drag, setDrag] = useState<DragView | null>(null)

  const rowRefs = useRef(new Map<string, HTMLLIElement>())
  const dragRef = useRef<DragMeta | null>(null)

  /*
   * 목록에 그릴 행. 위가 앞이고 폴더 머리행이 식구들 **위**에 온다.
   *
   * 계산은 layerTree.ts 한 곳에만 둔다. 여기서 다시 적으면 화면과 드래그 계산이
   * 갈라져서, 눈에 보이는 자리와 실제로 놓이는 자리가 달라진다.
   */
  const collapsedSet = useMemo(() => new Set(collapsedIds), [collapsedIds])
  const rows = useMemo(() => buildLayerRows(layers, collapsedSet), [layers, collapsedSet])
  /** 화면에 실제로 있는 행의 id. 키보드 이동과 범위 선택이 이 순서를 쓴다. */
  const orderedIds = useMemo(() => rows.map((r) => r.layer.id), [rows])
  /** 접혀서 안 보이는 것까지 포함한 전부. 선택을 걷어낼 때는 이쪽으로 재야 한다. */
  const allIds = useMemo(() => layers.map((l) => l.id), [layers])

  // 삭제된 레이어를 선택에서 걷어낸다. 접혀서 안 보이는 것은 살아 있는 것이다.
  useEffect(() => {
    pruneLayerSelection(allIds)
  }, [allIds, pruneLayerSelection])

  /**
   * 밖에서(구 SourcePanel, 이미지 드롭, 프리셋 적용 등) useUiStore.selectedLayerId 만
   * 바꾼 경우를 받아 준다. layerUi 가 비어 있을 때만 받아들여 루프를 막는다.
   */
  useEffect(() => {
    if (selectedIds.length > 0) return
    if (!uiSelectedId) return
    if (!orderedIds.includes(uiSelectedId)) return
    setSelectedLayerIds([uiSelectedId], uiSelectedId)
  }, [uiSelectedId, selectedIds.length, orderedIds, setSelectedLayerIds])

  const focusRow = useCallback((id: string) => {
    setActiveId(id)
    // 목록은 이미 DOM 에 있으므로 다음 렌더를 기다릴 필요가 없다.
    rowRefs.current.get(id)?.focus()
  }, [])

  const pick = useCallback(
    (id: string, mode: LayerSelectMode) => {
      select(id, mode, orderedIds)
      setActiveId(id)
    },
    [select, orderedIds],
  )

  // -------------------------------------------------------------------------
  // 드래그 재정렬
  // -------------------------------------------------------------------------

  const onGripPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLElement>, layerId: string, fromDisplay: number) => {
      if (e.button !== 0) return
      e.preventDefault()
      e.stopPropagation()

      // 시작 시점의 행 위치를 한 번만 잰다. 뷰포트 좌표라 목록이 스크롤되면 낡는다.
      // 포인터 캡처는 휠을 막지 않으므로 그 차이를 onGripPointerMove 에서 보정한다.
      const mids = orderedIds.map((id) => {
        const rect = rowRefs.current.get(id)?.getBoundingClientRect()
        return rect ? rect.top + rect.height / 2 : Number.POSITIVE_INFINITY
      })
      const scrollHost = e.currentTarget.closest('.mm-scroll')

      dragRef.current = {
        pointerId: e.pointerId,
        layerId,
        startY: e.clientY,
        fromDisplay,
        mids,
        scrollHost,
        startScroll: scrollHost?.scrollTop ?? 0,
        boundary: fromDisplay,
        active: false,
        overTimeline: false,
      }
      e.currentTarget.setPointerCapture(e.pointerId)
      setDrag({ layerId, boundary: fromDisplay, active: false, overTimeline: false })
    },
    [orderedIds],
  )

  const onGripPointerMove = useCallback((e: ReactPointerEvent<HTMLElement>) => {
    const meta = dragRef.current
    if (!meta || e.pointerId !== meta.pointerId) return

    if (!meta.active && Math.abs(e.clientY - meta.startY) <= DRAG_THRESHOLD_PX) return
    meta.active = true

    /*
     * 타임라인 위인가.
     *
     * 위면 순서 바꾸기가 아니라 "이 프레임부터 보이게 놓기" 다. 손이 목록 밖으로
     * 나간 순간 뜻이 달라지는 것이고, 타임라인이 놓일 자리를 미리 그려 준다.
     * 판정과 미리보기를 타임라인 쪽에 맡기는 이유는 여기가 배율과 스크롤을
     * 모르기 때문이다 (ui/timeline/timelineDrop.ts).
     */
    const overTimeline = timelineDropHover(e.clientX, e.clientY, meta.layerId)
    if (overTimeline !== meta.overTimeline) {
      meta.overTimeline = overTimeline
      setDrag({ layerId: meta.layerId, boundary: meta.boundary, active: true, overTimeline })
    }
    if (overTimeline) return

    // 드래그 중 목록이 스크롤되면 mids(뷰포트 좌표)가 그만큼 낡는다. 커서를 되돌려 맞춘다.
    // 위 임계값 판정은 보정하지 않은 clientY 를 그대로 쓴다. 여기에 보정값을 쓰면
    // 마우스를 움직이지 않고 휠만 굴려도 드래그가 시작된다.
    const scrolled = (meta.scrollHost?.scrollTop ?? 0) - meta.startScroll
    const y = e.clientY + scrolled

    // 중점을 지나친 행의 수가 곧 삽입 경계다.
    let boundary = 0
    for (const mid of meta.mids) {
      if (y > mid) boundary += 1
    }
    if (boundary === meta.boundary && drag?.active) return
    meta.boundary = boundary
    setDrag({ layerId: meta.layerId, boundary, active: true, overTimeline: false })
  }, [drag?.active])

  const endDrag = useCallback(
    (e: ReactPointerEvent<HTMLElement>, commit: boolean) => {
      const meta = dragRef.current
      if (!meta || e.pointerId !== meta.pointerId) return
      dragRef.current = null
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId)
      }
      setDrag(null)
      if (!commit || !meta.active) {
        timelineDropCancel()
        return
      }

      // 타임라인 위에서 놓았으면 순서는 건드리지 않는다. 구간만 옮긴다.
      if (timelineDropCommit(e.clientX, e.clientY, meta.layerId)) return

      const from = meta.fromDisplay
      const boundary = meta.boundary
      // 자기 앞이나 자기 뒤 경계에 놓으면 제자리다.
      if (boundary === from || boundary === from + 1) return

      // 경계 번호를 문서 인덱스와 폴더 소속으로 옮기는 것은 layerTree 가 한다.
      const target = dropTarget(layers, rows, meta.layerId, boundary)
      if (!target) return
      moveLayerTo(meta.layerId, target.index, target.folderId)
    },
    [layers, rows],
  )

  // -------------------------------------------------------------------------
  // 이름 편집
  // -------------------------------------------------------------------------

  const beginRename = useCallback((layer: Layer) => {
    setEditingId(layer.id)
    setDraftName(layer.name)
  }, [])

  const commitRename = useCallback(() => {
    const id = editingId
    if (!id) return
    const name = draftName.trim()
    setEditingId(null)
    if (name.length > 0) setLayerName(id, name)
    rowRefs.current.get(id)?.focus()
  }, [editingId, draftName, setLayerName])

  const cancelRename = useCallback(() => {
    const id = editingId
    setEditingId(null)
    if (id) rowRefs.current.get(id)?.focus()
  }, [editingId])

  // -------------------------------------------------------------------------
  // 키보드
  // -------------------------------------------------------------------------

  function onRowKeyDown(e: ReactKeyboardEvent<HTMLLIElement>, layer: Layer, di: number): void {
    const total = orderedIds.length

    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const step = e.key === 'ArrowDown' ? 1 : -1

      if (e.altKey) {
        /*
         * 순서 이동. 드래그와 같은 규칙을 타야 하므로 경계 번호로 옮겨 계산한다.
         * 위로 한 칸 = 윗행 앞의 경계, 아래로 한 칸 = 아랫행 뒤의 경계다.
         */
        const boundary = step < 0 ? di - 1 : di + 2
        const target = dropTarget(layers, rows, layer.id, boundary)
        if (target) moveLayerTo(layer.id, target.index, target.folderId)
        return
      }

      const next = orderedIds[Math.min(total - 1, Math.max(0, di + step))]
      if (!next) return
      if (e.shiftKey) select(next, 'range', orderedIds)
      else if (!e.ctrlKey && !e.metaKey) select(next, 'replace', orderedIds)
      focusRow(next)
      return
    }

    /*
     * 폴더 접기/펴기. 트리 위젯의 표준 키다.
     * 폴더가 아닌 행에서는 아무 일도 하지 않는다. 가로 화살표로 할 다른 일이 없다.
     */
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      const row = rows[di]
      if (!row || layer.type !== 'group') return
      e.preventDefault()
      const wantOpen = e.key === 'ArrowRight'
      if (row.collapsed === wantOpen) toggleFolderCollapsed(layer.id)
      return
    }

    if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault()
      const next = e.key === 'Home' ? orderedIds[0] : orderedIds[total - 1]
      if (!next) return
      if (e.shiftKey) select(next, 'range', orderedIds)
      else select(next, 'replace', orderedIds)
      focusRow(next)
      return
    }

    if (e.key === ' ' || e.key === 'Spacebar') {
      e.preventDefault()
      setLayerFlag(layer.id, 'visible', !layer.visible)
      return
    }

    if (e.key === 'l' || e.key === 'L') {
      e.preventDefault()
      setLayerFlag(layer.id, 'locked', !layer.locked)
      return
    }

    // 아래 모양으로 자르기. 폴더에서도 같이 동작한다.
    if (e.key === 'c' || e.key === 'C') {
      e.preventDefault()
      setLayerClip([layer.id], layer.clipToBelow !== true)
      return
    }

    if (e.key === 'Enter' || e.key === 'F2') {
      e.preventDefault()
      beginRename(layer)
      return
    }

    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault()
      /*
       * 포커스가 사라지지 않도록 이웃으로 먼저 옮긴다.
       *
       * **함께 지워질 행은 이웃이 아니다.** 폴더를 지우면 그 안의 레이어도 같이
       * 지워지는데(document.ts withFolderContents), 펼친 폴더 바로 아래 행이 곧
       * 그 자식이다. 인접 인덱스만 보고 고르면 곧 언마운트될 li 에 focus() 를 걸어
       * 포커스가 body 로 빠지고, 선택도 죽은 id 라 정리가 비워 버린다. 이 코드의
       * 목적이 폴더에서만 정확히 반대로 동작했다.
       */
      const doomed = withFolderContents(layers, [layer.id])
      const survivor = (from: number, step: number): string | null => {
        for (let i = from; i >= 0 && i < orderedIds.length; i += step) {
          const id = orderedIds[i]
          if (id !== undefined && !doomed.has(id)) return id
        }
        return null
      }
      const neighbour = survivor(di + 1, 1) ?? survivor(di - 1, -1)

      removeLayer(layer.id)
      if (neighbour) {
        select(neighbour, 'replace', orderedIds.filter((id) => !doomed.has(id)))
        focusRow(neighbour)
      }
    }
  }

  // -------------------------------------------------------------------------

  // 타임라인 위로 나간 동안에는 목록의 삽입선을 지운다. 두 곳이 동시에 켜져
  // 있으면 손을 뗼 때까지 어느 쪽이 일어날지 알 수 없다.
  const dragging = drag?.active === true && drag.overTimeline !== true
  const listClass = ['mm-lyr-list', dragging ? 'is-dragging mm-dragging' : ''].filter(Boolean).join(' ')

  /*
   * 전체 토글의 판정.
   *
   * "하나라도 켜져 있으면 전부 끈다" 로 잡는다. 절반만 보이는 상태에서 버튼을 누르면
   * 무엇이 일어날지 눈으로 예측할 수 있어야 하는데, "전부 켜져 있을 때만 끈다" 로 하면
   * 섞인 상태에서 눌렀을 때 아무 일도 안 일어난 것처럼 보인다.
   */
  // 레이어가 없으면 "전부 켜져 있다" 쪽으로 읽는다. 버튼은 어차피 비활성인데,
  // 빈 목록에서 [전체 보이기] 라고 적혀 있으면 누를 것이 있는 줄 안다.
  const hasLayers = layers.length > 0
  const anyVisible = !hasLayers || layers.some((l) => l.visible)
  const anyUnlocked = !hasLayers || layers.some((l) => !l.locked)
  // 지워진 레이어를 가리키고 있으면 목록에서 탭 진입점이 사라진다. 첫 행으로 되돌린다.
  const activeRowId =
    activeId && orderedIds.includes(activeId) ? activeId : (orderedIds[0] ?? null)

  return (
    <section className="mm-panel mm-lyr-panel" aria-label="레이어">
      <div className="mm-panel-head">
        <span>레이어</span>

        <span className="mm-lyr-head-actions">
          {/*
            고른 레이어가 있으면 그것들을 담은 폴더를, 없으면 빈 폴더를 만든다.
            폴더는 그리는 것이 없고 자기 변환만 안쪽에 얹는다.
          */}
          <button
            type="button"
            className="mm-icon-btn"
            title={selectedIds.length > 0 ? '고른 레이어를 폴더로 묶기' : '빈 폴더 만들기'}
            aria-label={selectedIds.length > 0 ? '고른 레이어를 폴더로 묶기' : '빈 폴더 만들기'}
            onClick={() => {
              const { folderId } = addFolder({ layerIds: selectedIds })
              setSelectedLayerIds([folderId], folderId)
            }}
          >
            <IconFolder />
          </button>
          <button
            type="button"
            className="mm-icon-btn"
            disabled={!hasLayers}
            aria-pressed={hasLayers && !anyVisible}
            title={anyVisible ? '전체 숨기기' : '전체 보이기'}
            aria-label={anyVisible ? '레이어 전체 숨기기' : '레이어 전체 보이기'}
            onClick={() => setAllLayersFlag('visible', !anyVisible)}
          >
            <IconEye open={anyVisible} />
          </button>
          <button
            type="button"
            className="mm-icon-btn"
            disabled={!hasLayers}
            aria-pressed={hasLayers && !anyUnlocked}
            title={anyUnlocked ? '전체 잠그기' : '전체 잠금 풀기'}
            aria-label={anyUnlocked ? '레이어 전체 잠그기' : '레이어 전체 잠금 풀기'}
            onClick={() => setAllLayersFlag('locked', anyUnlocked)}
          >
            <IconLock locked={!anyUnlocked} />
          </button>
          <span className="mm-lyr-count" aria-hidden="true">
            {layers.length}
          </span>
        </span>
      </div>

      <div className="mm-panel-body mm-scroll">
        {rows.length === 0 ? (
          <p className="mm-lyr-empty">
            이미지를 끌어다 놓거나 Ctrl+V 로 붙여넣으세요. 아래 [도형 추가] 로 도형만 넣어도 됩니다.
            <br />
            아래 [이미지 추가] 로도 넣을 수 있어요.
          </p>
        ) : (
          <ul
            className={listClass}
            role="listbox"
            aria-multiselectable="true"
            aria-label="레이어 목록, 위가 앞쪽입니다"
          >
            {rows.map((row, di) => {
              const layer = row.layer
              const selected = selectedIds.includes(layer.id)
              const isActive = activeRowId === layer.id
              const isEditing = editingId === layer.id
              const isFolder = layer.type === 'group'
              const isClipped = layer.clipToBelow === true
              const motionRepeat = layer.motionRepeat ?? 1
              const rowClass = [
                'mm-lyr-row',
                isFolder ? 'is-folder' : '',
                isClipped ? 'is-clipped' : '',
                selected ? 'is-selected' : '',
                layer.visible ? '' : 'is-hidden',
                layer.locked ? 'is-locked' : '',
                dragging && drag?.layerId === layer.id ? 'is-dragging-row' : '',
                dragging && drag?.boundary === di ? 'is-drop-before' : '',
                dragging && drag?.boundary === rows.length && di === rows.length - 1
                  ? 'is-drop-after'
                  : '',
              ]
                .filter(Boolean)
                .join(' ')

              return (
                <li
                  key={layer.id}
                  ref={(el) => {
                    if (el) rowRefs.current.set(layer.id, el)
                    else rowRefs.current.delete(layer.id)
                  }}
                  className={rowClass}
                  role="option"
                  data-depth={Math.min(4, row.depth)}
                  aria-selected={selected}
                  aria-expanded={isFolder ? !row.collapsed : undefined}
                  aria-label={`${isFolder ? `폴더 ${layer.name}, ${row.childCount}장` : layer.name}${isClipped ? ', 아래 모양으로 잘림' : ''}${layer.visible ? '' : ', 숨김'}${layer.locked ? ', 잠김' : ''}`}
                  tabIndex={isActive ? 0 : -1}
                  onFocus={() => setActiveId(layer.id)}
                  onKeyDown={(e) => onRowKeyDown(e, layer, di)}
                  onClick={(e: ReactMouseEvent<HTMLLIElement>) => {
                    const mode: LayerSelectMode =
                      e.ctrlKey || e.metaKey ? 'toggle' : e.shiftKey ? 'range' : 'replace'
                    pick(layer.id, mode)
                  }}
                >
                  {/* 손잡이는 포인터 전용이다. 키보드는 행에서 Alt+상하로 옮긴다. */}
                  <span
                    className="mm-lyr-grip"
                    aria-hidden="true"
                    title="끌어서 순서 바꾸기. 타임라인 위에 놓으면 그 프레임부터 보입니다."
                    onPointerDown={(e) => onGripPointerDown(e, layer.id, di)}
                    onPointerMove={onGripPointerMove}
                    onPointerUp={(e) => endDrag(e, true)}
                    onPointerCancel={(e) => endDrag(e, false)}
                  >
                    <IconGrip />
                  </span>

                  {isFolder ? (
                    /*
                      폴더 아이콘 자리가 그대로 접기 버튼이다. 칸을 하나 더 만들면
                      행 격자가 밀려 썸네일과 이름이 폴더 행에서만 다른 자리에 온다.

                      접기가 있어야 폴더가 쓸모 있다. 도형 세트 하나가 도형을 스무
                      장까지 만드는데, 접을 수 없으면 묶어도 목록은 그대로 스무 줄이다.
                    */
                    <button
                      type="button"
                      className="mm-lyr-folder-toggle"
                      tabIndex={-1}
                      aria-label={`${layer.name} ${row.collapsed ? '펼치기' : '접기'}`}
                      title={row.collapsed ? '펼치기' : '접기'}
                      onClick={(e) => {
                        e.stopPropagation()
                        toggleFolderCollapsed(layer.id)
                      }}
                    >
                      <IconCaret open={!row.collapsed} />
                      <IconFolder />
                    </button>
                  ) : (
                    <LayerThumb assetId={layer.assetId} shape={layer.shape} name={layer.name} />
                  )}

                  {isEditing ? (
                    <input
                      className="mm-input mm-lyr-name-input"
                      type="text"
                      value={draftName}
                      autoFocus
                      aria-label={`${layer.name} 이름 바꾸기`}
                      onChange={(e) => setDraftName(e.target.value)}
                      onBlur={commitRename}
                      onClick={(e) => e.stopPropagation()}
                      onKeyDown={(e) => {
                        // 목록 단축키가 타이핑을 삼키지 않게 한다.
                        e.stopPropagation()
                        if (e.key === 'Enter') commitRename()
                        else if (e.key === 'Escape') cancelRename()
                      }}
                    />
                  ) : (
                    <span
                      className="mm-lyr-name"
                      title={`${layer.name} (더블클릭하면 이름을 바꿉니다)`}
                      onDoubleClick={(e) => {
                        e.stopPropagation()
                        beginRename(layer)
                      }}
                    >
                      {layer.name}
                      {isFolder ? (
                        <span className="mm-lyr-folder-count">{row.childCount}</span>
                      ) : null}
                      {/*
                        모션 배수.

                        타임라인에는 한 바퀴만 그려지므로(core/types.ts Layer.motionRepeat)
                        이 표시가 없으면 "왜 화면이 그래프보다 빨리 움직이지" 가 된다.
                        폴더 식구 수와 같은 자리를 쓴다.
                      */}
                      {motionRepeat > 1 ? (
                        <span className="mm-lyr-folder-count" title="이 레이어만 빠르게 돕니다">
                          {motionRepeat}배
                        </span>
                      ) : null}
                    </span>
                  )}

                  <span className="mm-lyr-actions">
                    {/*
                      그림만 갈아끼우기. 이미지 레이어에만 뜬다.

                      템플릿 흐름의 유일한 조작이라 목록 줄에 둔다. 인스펙터에만 두면
                      "어느 그림을 바꾸는가" 가 선택 상태에 숨어서, 여러 장을 차례로
                      갈아끼울 때 매번 고르고 스크롤해야 한다.
                    */}
                    {layer.type === 'image' ? (
                      <ReplaceImageButton
                        layerId={layer.id}
                        disabled={layer.locked}
                        title={
                          layer.locked
                            ? '잠긴 레이어입니다. 자물쇠를 풀면 바꿀 수 있습니다.'
                            : `${layer.name} 의 그림만 갈아끼우기. 움직임과 효과는 그대로 남습니다.`
                        }
                      />
                    ) : null}
                    <button
                      type="button"
                      className="mm-icon-btn"
                      tabIndex={-1}
                      aria-pressed={layer.visible}
                      title={layer.visible ? '숨기기' : '보이기'}
                      aria-label={`${layer.name} ${layer.visible ? '숨기기' : '보이기'}`}
                      onClick={(e) => {
                        e.stopPropagation()
                        setLayerFlag(layer.id, 'visible', !layer.visible)
                      }}
                    >
                      <IconEye open={layer.visible} />
                    </button>
                    <button
                      type="button"
                      className="mm-icon-btn"
                      tabIndex={-1}
                      aria-pressed={isClipped}
                      /*
                       * 폴더도 자를 수 있다. 폴더가 쟘리는 쪽이면 안에 든 그림
                       * 전체가 한 장처럼 잘린다 (core/clip.ts 머리주석). 엔진은 처음부터
                       * 그렇게 동작했는데 UI 가 폴더에서만 이 길을 막고 있었다.
                       */
                      title={isClipped ? '자르기 끄기' : '아래 모양으로 자르기 (C)'}
                      aria-label={`${layer.name} 아래 모양으로 자르기 ${isClipped ? '끄기' : '켜기'}`}
                      onClick={(e) => {
                        e.stopPropagation()
                        setLayerClip([layer.id], !isClipped)
                      }}
                    >
                      <IconClip on={isClipped} />
                    </button>
                    <button
                      type="button"
                      className="mm-icon-btn"
                      tabIndex={-1}
                      aria-pressed={layer.locked}
                      title={layer.locked ? '잠금 풀기' : '잠그기'}
                      aria-label={`${layer.name} ${layer.locked ? '잠금 풀기' : '잠그기'}`}
                      onClick={(e) => {
                        e.stopPropagation()
                        setLayerFlag(layer.id, 'locked', !layer.locked)
                      }}
                    >
                      <IconLock locked={layer.locked} />
                    </button>
                    <button
                      type="button"
                      className="mm-icon-btn is-danger"
                      tabIndex={-1}
                      /*
                       * 폴더는 안에 든 것까지 사라진다. 몇 장이 함께 지워지는지
                       * 누르기 전에 알려야 한다. 접혀 있으면 목록에 그 식구가
                       * 보이지도 않아서, 이 문구가 유일한 경고다.
                       */
                      title={isFolder && row.childCount > 0 ? `삭제 (안에 든 ${row.childCount}장도 함께)` : '삭제'}
                      aria-label={
                        isFolder && row.childCount > 0
                          ? `폴더 ${layer.name} 삭제, 안에 든 ${row.childCount}장도 함께 지워집니다`
                          : `${layer.name} 삭제`
                      }
                      onClick={(e) => {
                        e.stopPropagation()
                        removeLayer(layer.id)
                      }}
                    >
                      <IconTrash />
                    </button>
                  </span>

                  <select
                    className="mm-select mm-lyr-blend"
                    value={layer.blend}
                    tabIndex={-1}
                    aria-label={`${layer.name} 합성 모드`}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => setLayerBlend(layer.id, e.target.value as BlendMode)}
                  >
                    {BLEND_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </li>
              )
            })}
          </ul>
        )}

        {rows.length > 0 ? (
          <p className="mm-lyr-help">
            Ctrl 클릭으로 여러 장, Shift 클릭으로 범위 선택. 왼쪽 손잡이를 끌면 순서가 바뀝니다.
            손잡이를 아래 타임라인으로 끌고 가면 그 프레임부터만 보이게 놓입니다.
            폴더 앞 삼각형으로 접습니다.
          </p>
        ) : null}
      </div>

      <div className="mm-panel-foot">
        <AddLayerMenu />
        <button
          type="button"
          className="mm-btn mm-btn-block"
          title="사각형을 한 장 넣습니다. 종류와 색은 인스펙터에서 바꿉니다."
          onClick={() => addSingleShape('rect')}
        >
          <IconShape />
          도형 추가
        </button>
      </div>
    </section>
  )
}

export default LayerPanel
