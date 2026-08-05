/**
 * 캔버스 위에 얹히는 격자와 드래그.
 *
 * 그림은 WebGL 캔버스가 그리고, 이 컴포넌트는 그 위에 투명한 판 한 장을 덮는다.
 * 판이 하는 일은 두 가지다. 격자와 선택 외곽선을 그리고, 포인터를 받아 레이어를
 * 옮긴다. 계산은 전부 stageDrag.ts 의 순수 함수가 한다.
 *
 * 왜 렌더러가 아니라 DOM 인가
 *
 * 격자와 외곽선은 결과물에 한 픽셀도 나가면 안 된다. 렌더러에 그리면 "프리뷰 =
 * 결과물" 약속을 지키기 위해 내보내기 경로에서 다시 빼야 하고, 그 분기가 생기는
 * 순간 두 경로가 갈라진다. DOM 에 두면 그런 분기가 애초에 없다.
 *
 * 재생 중에는 외곽선을 그리지 않는다. 그리려면 프레임마다 전체 컴포지션을 다시
 * 풀어야 하는데, 그 비용을 캔버스가 아니라 보조선이 가져가는 것은 손해다.
 * 이동은 재생 중에도 된다. 옮기는 것은 기준 위치이지 지금 보이는 자리가 아니다.
 */

import {
  useCallback,
  useMemo,
  useRef,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react'

import type { Mat3 } from '@/core/transform.ts'
import { useDocumentStore } from '@/state/document.ts'
import { useLayerUiStore } from '@/state/layerUi.ts'
import { useUiStore } from '@/state/ui.ts'
import {
  buildStageScene,
  dragMove,
  dragUnits,
  pickLayerAt,
  placePointOf,
  stageOverscan,
  translateForPlace,
  type DragStart,
  type StagePoint,
} from './stageDrag.ts'

const STAGE_CSS = `
.stage-overlay {
  position: absolute;
  inset: 0;
  touch-action: none;
  cursor: default;
}

/*
 * 격자선은 흰 실선 옆에 검은 실선을 나란히 둔다.
 *
 * 무채색 한 벌만 쓰는 UI 규칙(tokens.css)이 여기서도 그대로인데, 격자가 얹히는
 * 바탕은 UI 가 아니라 사용자의 그림이다. 한 톤만 쓰면 흰 그림에서는 흰 선이,
 * 검은 그림에서는 검은 선이 통째로 사라진다. 두 톤을 붙여 두면 어느 그림에서도
 * 둘 중 하나는 보인다.
 */
.stage-grid {
  position: absolute;
  inset: 0;
  pointer-events: none;
  background-image:
    repeating-linear-gradient(
      to right,
      rgba(255, 255, 255, 0.5) 0 1px,
      rgba(0, 0, 0, 0.4) 1px 2px,
      transparent 2px var(--stage-major)
    ),
    repeating-linear-gradient(
      to bottom,
      rgba(255, 255, 255, 0.5) 0 1px,
      rgba(0, 0, 0, 0.4) 1px 2px,
      transparent 2px var(--stage-major)
    ),
    repeating-linear-gradient(
      to right,
      rgba(255, 255, 255, 0.26) 0 1px,
      rgba(0, 0, 0, 0.2) 1px 2px,
      transparent 2px var(--stage-cell)
    ),
    repeating-linear-gradient(
      to bottom,
      rgba(255, 255, 255, 0.26) 0 1px,
      rgba(0, 0, 0, 0.2) 1px 2px,
      transparent 2px var(--stage-cell)
    );
}

.stage-marks {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
  overflow: visible;
}

/* 외곽선도 두 톤이다. 굵은 검정 위에 가는 흰 파선을 얹는다. */
.stage-mark-under {
  fill: none;
  stroke: rgba(0, 0, 0, 0.65);
  stroke-width: 3;
}

.stage-mark-over {
  fill: none;
  stroke: #ffffff;
  stroke-width: 1.25;
  stroke-dasharray: 5 4;
}
`

/** 이만큼 움직이기 전에는 드래그로 보지 않는다. 클릭 한 번이 위치를 바꾸면 안 된다. */
const DRAG_SLOP_PX = 3

/** 칸이 이보다 촘촘하면 격자를 그리지 않는다. 선이 붙어 회색 판이 된다. */
const MIN_CELL_PX = 5

/** 굵은 선의 간격. 몇 칸마다 한 줄인가. */
const MAJOR_EVERY = 4

interface DragSession {
  pointerId: number
  /** 이 드래그가 쓰는 프레임. 도중에 재생헤드가 움직여도 바뀌지 않는다. */
  frame: number
  /** 누른 자리(캔버스 픽셀). */
  originX: number
  originY: number
  starts: DragStart[]
  folders: ReadonlyMap<string, Mat3>
  moved: boolean
}

export interface StageOverlayProps {
  /** 표시 배율. 캔버스 픽셀 하나가 화면 픽셀 몇 개인가. */
  scale: number
}

export function StageOverlay({ scale }: StageOverlayProps) {
  const doc = useDocumentStore((s) => s.doc)
  const gridOn = useUiStore((s) => s.gridOn)
  const gridSize = useUiStore((s) => s.gridSize)
  const playing = useUiStore((s) => s.playing)
  const frame = useUiStore((s) => s.playheadFrame)
  const selected = useLayerUiStore((s) => s.selectedLayerIds)

  const dragRef = useRef<DragSession | null>(null)

  const assetSize = useCallback(
    (assetId: string) => {
      const asset = doc.assets.find((a) => a.id === assetId)
      return asset ? { width: asset.naturalW, height: asset.naturalH } : undefined
    },
    [doc],
  )

  /** 선택한 것들의 외곽선. 폴더를 골랐으면 그 안에 든 레이어 전부를 두른다. */
  const outlines = useMemo(() => {
    if (playing || selected.length === 0) return []
    const chosen = new Set(selected)
    const folderIds = new Set(
      doc.layers.filter((l) => l.type === 'group' && chosen.has(l.id)).map((l) => l.id),
    )
    const wanted = new Set(selected)
    if (folderIds.size > 0) {
      for (const layer of doc.layers) {
        let cursor = layer.folderId
        const seen = new Set<string>()
        while (cursor && !seen.has(cursor)) {
          seen.add(cursor)
          if (folderIds.has(cursor)) {
            wanted.add(layer.id)
            break
          }
          cursor = doc.layers.find((l) => l.id === cursor)?.folderId
        }
      }
    }

    const scene = buildStageScene(doc, frame, assetSize, stageOverscan(doc, assetSize))
    return scene.shapes
      .filter((shape) => wanted.has(shape.layerId))
      .map((shape) => ({
        layerId: shape.layerId,
        points: shape.quad.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' '),
      }))
  }, [doc, frame, playing, selected, assetSize])

  const toCanvas = (e: ReactPointerEvent<HTMLDivElement>): StagePoint => {
    const box = e.currentTarget.getBoundingClientRect()
    const k = scale > 0 ? scale : 1
    return { x: (e.clientX - box.left) / k, y: (e.clientY - box.top) / k }
  }

  /** 지금 문서와 지금 프레임으로 장면을 다시 만든다. 드래그 중에는 부르지 않는다. */
  const sceneNow = (at: number) => {
    const current = useDocumentStore.getState().doc
    return buildStageScene(current, at, assetSize, stageOverscan(current, assetSize))
  }

  function handlePointerDown(e: ReactPointerEvent<HTMLDivElement>): void {
    if (e.button !== 0) return

    const ui = useUiStore.getState()
    // 스크럽과 같은 관습이다. 편집이 시작되면 재생을 멈추고 그 프레임에 못 박는다.
    // 멈추지 않으면 드래그 도중 재생헤드가 흘러 키가 여러 프레임에 흩어진다.
    const at = Math.round(ui.playheadFrame)
    if (ui.playing) ui.setPlaying(false)

    const point = toCanvas(e)
    const scene = sceneNow(at)
    const hitId = pickLayerAt(scene, point.x, point.y)
    if (!hitId) return

    const current = useDocumentStore.getState().doc
    const layers = current.layers
    const layerUi = useLayerUiStore.getState()
    const units = dragUnits({
      layers,
      hitId,
      selected: layerUi.selectedLayerIds,
      solo: e.altKey,
    })
    if (units.length === 0) return

    // 고르지 않은 것을 잡았으면 선택도 그쪽으로 옮긴다. 잡은 것과 인스펙터가
    // 다른 레이어를 보고 있으면 무엇을 옮기는지 알 수 없다.
    if (units.length === 1 && units[0] === hitId && !layerUi.selectedLayerIds.includes(hitId)) {
      layerUi.select(hitId, 'replace', layers.map((l) => l.id))
    }

    const byId = new Map(layers.map((l) => [l.id, l]))
    const starts: DragStart[] = []
    for (const id of units) {
      const layer = byId.get(id)
      if (!layer) continue
      starts.push({ layerId: id, place: placePointOf(current, layer, at, scene.folders) })
    }
    if (starts.length === 0) return

    dragRef.current = {
      pointerId: e.pointerId,
      frame: at,
      originX: point.x,
      originY: point.y,
      starts,
      folders: scene.folders,
      moved: false,
    }

    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      /* 캡처 없이 진행한다 */
    }
    e.currentTarget.style.cursor = 'grabbing'
    e.preventDefault()
  }

  function handlePointerMove(e: ReactPointerEvent<HTMLDivElement>): void {
    const drag = dragRef.current
    const point = toCanvas(e)

    if (!drag) {
      // 잡을 수 있는 자리인지 커서로만 알린다. 상태로 올리면 마우스를 움직일
      // 때마다 이 컴포넌트가 다시 그려진다.
      const scene = sceneNow(Math.round(useUiStore.getState().playheadFrame))
      e.currentTarget.style.cursor = pickLayerAt(scene, point.x, point.y) ? 'move' : 'default'
      return
    }
    if (drag.pointerId !== e.pointerId) return

    const dx = point.x - drag.originX
    const dy = point.y - drag.originY
    const k = scale > 0 ? scale : 1
    if (!drag.moved && Math.hypot(dx, dy) * k < DRAG_SLOP_PX) return
    drag.moved = true

    commit(drag, dx, dy)
  }

  function handlePointerUp(e: ReactPointerEvent<HTMLDivElement>): void {
    const drag = dragRef.current
    dragRef.current = null
    try {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId)
      }
    } catch {
      /* 이미 놓았다 */
    }
    e.currentTarget.style.cursor = drag ? 'move' : 'default'
  }

  /**
   * 끈 거리를 문서에 쓴다.
   *
   * 배치점으로 옮긴 뒤 다시 레이어의 이동 값으로 되돌리는 두 단계를 거친다.
   * 화면에서 잰 거리를 그대로 더하면 폴더가 돌아가 있을 때 그림이 손과 다른
   * 방향으로 간다 (stageDrag.ts translateForPlace).
   */
  function commit(drag: DragSession, dx: number, dy: number): void {
    const ui = useUiStore.getState()
    const grid = ui.gridOn ? ui.gridSize : 0
    const next = dragMove({ starts: drag.starts, dx, dy, grid })

    const current = useDocumentStore.getState().doc
    const byId = new Map(current.layers.map((l) => [l.id, l]))
    const moves: { layerId: string; x: number; y: number }[] = []
    for (const item of next) {
      const layer = byId.get(item.layerId)
      if (!layer) continue
      const value = translateForPlace(current, layer, item.place, drag.folders)
      if (!value) continue
      moves.push({ layerId: item.layerId, x: value.x, y: value.y })
    }
    if (moves.length > 0) useDocumentStore.getState().setLayerTranslate(moves, drag.frame)
  }

  const cell = gridSize * (scale > 0 ? scale : 1)
  const showGrid = gridOn && cell >= MIN_CELL_PX

  return (
    <div
      className="stage-overlay"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
    >
      <style href="mm-stage-overlay" precedence="default">
        {STAGE_CSS}
      </style>

      {showGrid ? (
        <div
          className="stage-grid"
          aria-hidden="true"
          style={
            {
              '--stage-cell': `${cell}px`,
              '--stage-major': `${cell * MAJOR_EVERY}px`,
            } as CSSProperties
          }
        />
      ) : null}

      {outlines.length > 0 ? (
        <svg
          className="stage-marks"
          viewBox={`0 0 ${doc.canvas.w} ${doc.canvas.h}`}
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          {outlines.map((outline) => (
            <polygon key={`u-${outline.layerId}`} className="stage-mark-under" points={outline.points} vectorEffect="non-scaling-stroke" />
          ))}
          {outlines.map((outline) => (
            <polygon key={`o-${outline.layerId}`} className="stage-mark-over" points={outline.points} vectorEffect="non-scaling-stroke" />
          ))}
        </svg>
      ) : null}
    </div>
  )
}

export default StageOverlay
