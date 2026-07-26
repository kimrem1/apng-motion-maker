/**
 * 레이어 패널.
 *
 * 목록은 **위가 앞**이다. 문서 배열은 z 오름차순(0 이 맨 뒤)이라 뒤집어 그린다.
 * 포토샵/피그마를 쓴 사람은 예외 없이 그렇게 기대한다.
 *
 * 재정렬은 HTML5 드래그를 쓰지 않는다. dragImage 를 브라우저가 마음대로 그리고,
 * dragover 좌표가 200ms 단위로 끊겨 들어와 손가락보다 늦게 따라온다.
 * pointer 이벤트 + setPointerCapture 로 직접 구현한다.
 *
 * 접근성 메모:
 *   ul[role=listbox] / li[role=option] 이고 화살표로 이동한다.
 *   행 안의 아이콘 버튼은 tabIndex=-1 이다. 레이어 10개면 Tab 이 40번 걸리기 때문이다.
 *   대신 행에서 키로 전부 조작할 수 있다.
 *     Space 가시성, L 잠금, Enter/F2 이름 편집, Delete 삭제, Alt+상하 순서 이동
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

import type { BlendMode, Layer } from '@/core/types.ts'
import { assetRegistry } from '@/state/assets.ts'
import { useDocumentStore } from '@/state/document.ts'
import { useLayerUiStore, type LayerSelectMode } from '@/state/layerUi.ts'
import { useUiStore } from '@/state/ui.ts'
import { AddLayerMenu } from './AddLayerMenu.tsx'
import { BLEND_OPTIONS, moveLayerTo, setLayerBlend } from './layerDocActions.ts'
import './layers.css'

/** 썸네일 캔버스의 실제 픽셀. CSS 는 32px 이므로 2배 해상도다. */
const THUMB_PX = 64

/** 이 거리를 넘어야 드래그로 친다. 손 떨림으로 순서가 바뀌면 안 된다. */
const DRAG_THRESHOLD_PX = 4

// ---------------------------------------------------------------------------
// 아이콘
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// 썸네일
// ---------------------------------------------------------------------------

/** 에셋 비트맵을 작은 캔버스에 contain 으로 그린다. 리비전이 바뀌면 다시 그린다. */
export function LayerThumb({ assetId, name }: { assetId: string | null; name: string }) {
  const revision = useSyncExternalStore(assetRegistry.subscribe, assetRegistry.getRevision)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    ctx.clearRect(0, 0, canvas.width, canvas.height)
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
  }, [assetId, revision])

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
  /** 삽입 경계. 0 = 맨 위, n = 맨 아래 */
  boundary: number
  active: boolean
}

/** 렌더에 필요한 만큼만 뽑은 사본 */
interface DragView {
  layerId: string
  boundary: number
  active: boolean
}

// ---------------------------------------------------------------------------

export function LayerPanel() {
  const layers = useDocumentStore((s) => s.doc.layers)
  const removeLayer = useDocumentStore((s) => s.removeLayer)
  const setLayerFlag = useDocumentStore((s) => s.setLayerFlag)
  const setLayerName = useDocumentStore((s) => s.setLayerName)

  const selectedIds = useLayerUiStore((s) => s.selectedLayerIds)
  const select = useLayerUiStore((s) => s.select)
  const setSelectedLayerIds = useLayerUiStore((s) => s.setSelectedLayerIds)
  const pruneLayerSelection = useLayerUiStore((s) => s.pruneLayerSelection)
  const uiSelectedId = useUiStore((s) => s.selectedLayerId)

  /** 로빙 tabindex 의 현재 대상. 선택과 별개다(Ctrl+화살표는 포커스만 옮긴다). */
  const [activeId, setActiveId] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draftName, setDraftName] = useState('')
  const [drag, setDrag] = useState<DragView | null>(null)

  const rowRefs = useRef(new Map<string, HTMLLIElement>())
  const dragRef = useRef<DragMeta | null>(null)

  // 위가 z 가 큰 레이어다. 문서 배열은 z 오름차순이라 뒤집는다.
  const display = useMemo(() => [...layers].reverse(), [layers])
  const orderedIds = useMemo(() => display.map((l) => l.id), [display])

  // 삭제된 레이어를 선택에서 걷어낸다.
  useEffect(() => {
    pruneLayerSelection(orderedIds)
  }, [orderedIds, pruneLayerSelection])

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

      // 시작 시점의 행 위치를 한 번만 잰다. 드래그 중에는 목록이 움직이지 않는다.
      const mids = orderedIds.map((id) => {
        const rect = rowRefs.current.get(id)?.getBoundingClientRect()
        return rect ? rect.top + rect.height / 2 : Number.POSITIVE_INFINITY
      })

      dragRef.current = {
        pointerId: e.pointerId,
        layerId,
        startY: e.clientY,
        fromDisplay,
        mids,
        boundary: fromDisplay,
        active: false,
      }
      e.currentTarget.setPointerCapture(e.pointerId)
      setDrag({ layerId, boundary: fromDisplay, active: false })
    },
    [orderedIds],
  )

  const onGripPointerMove = useCallback((e: ReactPointerEvent<HTMLElement>) => {
    const meta = dragRef.current
    if (!meta || e.pointerId !== meta.pointerId) return

    if (!meta.active && Math.abs(e.clientY - meta.startY) <= DRAG_THRESHOLD_PX) return
    meta.active = true

    // 중점을 지나친 행의 수가 곧 삽입 경계다.
    let boundary = 0
    for (const mid of meta.mids) {
      if (e.clientY > mid) boundary += 1
    }
    if (boundary === meta.boundary && drag?.active) return
    meta.boundary = boundary
    setDrag({ layerId: meta.layerId, boundary, active: true })
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
      if (!commit || !meta.active) return

      const total = orderedIds.length
      const from = meta.fromDisplay
      const boundary = meta.boundary
      // 자기 앞이나 자기 뒤 경계에 놓으면 제자리다.
      if (boundary === from || boundary === from + 1) return

      const toDisplay = boundary > from ? boundary - 1 : boundary
      // 표시 인덱스는 문서 인덱스의 역순이다.
      moveLayerTo(meta.layerId, total - 1 - toDisplay)
    },
    [orderedIds.length],
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
        // 순서 이동. 화면상 위로 = 문서 인덱스 증가.
        const toDisplay = Math.min(total - 1, Math.max(0, di + step))
        if (toDisplay !== di) moveLayerTo(layer.id, total - 1 - toDisplay)
        return
      }

      const next = orderedIds[Math.min(total - 1, Math.max(0, di + step))]
      if (!next) return
      if (e.shiftKey) select(next, 'range', orderedIds)
      else if (!e.ctrlKey && !e.metaKey) select(next, 'replace', orderedIds)
      focusRow(next)
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

    if (e.key === 'Enter' || e.key === 'F2') {
      e.preventDefault()
      beginRename(layer)
      return
    }

    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault()
      // 포커스가 사라지지 않도록 이웃으로 먼저 옮긴다.
      const neighbour = orderedIds[di + 1] ?? orderedIds[di - 1] ?? null
      removeLayer(layer.id)
      if (neighbour) {
        select(neighbour, 'replace', orderedIds)
        focusRow(neighbour)
      }
    }
  }

  // -------------------------------------------------------------------------

  const dragging = drag?.active === true
  const listClass = ['mm-lyr-list', dragging ? 'is-dragging mm-dragging' : ''].filter(Boolean).join(' ')
  // 지워진 레이어를 가리키고 있으면 목록에서 탭 진입점이 사라진다. 첫 행으로 되돌린다.
  const activeRowId =
    activeId && orderedIds.includes(activeId) ? activeId : (orderedIds[0] ?? null)

  return (
    <section className="mm-panel mm-lyr-panel" aria-label="레이어">
      <div className="mm-panel-head">
        <span>레이어</span>
        <span aria-hidden="true">{layers.length}</span>
      </div>

      <div className="mm-panel-body mm-scroll">
        {display.length === 0 ? (
          <p className="mm-lyr-empty">
            이미지를 끌어다 놓거나 Ctrl+V 로 붙여넣으세요.
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
            {display.map((layer, di) => {
              const selected = selectedIds.includes(layer.id)
              const isActive = activeRowId === layer.id
              const isEditing = editingId === layer.id
              const rowClass = [
                'mm-lyr-row',
                selected ? 'is-selected' : '',
                layer.visible ? '' : 'is-hidden',
                layer.locked ? 'is-locked' : '',
                dragging && drag?.layerId === layer.id ? 'is-dragging-row' : '',
                dragging && drag?.boundary === di ? 'is-drop-before' : '',
                dragging && drag?.boundary === display.length && di === display.length - 1
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
                  aria-selected={selected}
                  aria-label={`${layer.name}${layer.visible ? '' : ', 숨김'}${layer.locked ? ', 잠김' : ''}`}
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
                    title="끌어서 순서 바꾸기"
                    onPointerDown={(e) => onGripPointerDown(e, layer.id, di)}
                    onPointerMove={onGripPointerMove}
                    onPointerUp={(e) => endDrag(e, true)}
                    onPointerCancel={(e) => endDrag(e, false)}
                  >
                    <IconGrip />
                  </span>

                  <LayerThumb assetId={layer.assetId} name={layer.name} />

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
                    </span>
                  )}

                  <span className="mm-lyr-actions">
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
                      title="삭제"
                      aria-label={`${layer.name} 삭제`}
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

        {display.length > 0 ? (
          <p className="mm-lyr-help">
            Ctrl 클릭으로 여러 장, Shift 클릭으로 범위 선택. 왼쪽 손잡이를 끌면 순서가 바뀝니다.
          </p>
        ) : null}
      </div>

      <div className="mm-panel-foot">
        <AddLayerMenu />
      </div>
    </section>
  )
}

export default LayerPanel
