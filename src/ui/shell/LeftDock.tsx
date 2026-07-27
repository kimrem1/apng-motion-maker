/**
 * PRO 좌측 도크. 레이어 패널과 모션 프리셋을 세로로 쌓고 그 사이에 높이 조절 손잡이를 둔다.
 *
 * 높이를 CSS 한 값(max-height: 45%)으로 고정하면 어느 문서에서도 맞지 않는다.
 * 레이어가 20장이면 목록이 세 줄만 보이고, 반대로 크게 박아 두면 프리셋 갤러리가
 * 사라진다. 문서마다 정답이 달라서 사용자가 직접 정하게 한다.
 *
 * 규칙 세 가지.
 *   1. 손대기 전에는 지금까지의 동작 그대로다. 내용만큼 차지하고 45% 에서 멈춘다.
 *      손잡이를 한 번이라도 움직인 뒤에야 고정 높이(is-resized)로 전환한다.
 *   2. 값은 px 로 localStorage 에 남긴다. 문서가 아니므로 프로젝트 파일에 넣지 않고
 *      실행취소 대상도 아니다.
 *   3. 창을 줄여 도크가 짧아지면 저장값이 프리셋 갤러리를 밀어내므로 다시 가둔다.
 *      ResizeObserver 가 그 일을 한다.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'

import { LayerPanel } from '@/ui/layers/LayerPanel.tsx'
import { PresetGallery } from '@/ui/presets/PresetGallery.tsx'

const STORAGE_KEY = 'mm.leftDock.layerHeight'

/** 이보다 작으면 레이어 행 하나도 못 보여 준다. */
const MIN_H = 96
/** 아래 프리셋 갤러리에 최소한 남겨 두는 높이. 이게 없으면 갤러리가 0이 된다. */
const KEEP_BELOW = 140
/** 화살표 한 번의 이동량. Shift 를 누르면 3배다. */
const STEP_PX = 16

function readStored(): number | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (raw === null) return null
    const n = Number(raw)
    return Number.isFinite(n) && n >= MIN_H ? n : null
  } catch {
    // 프라이빗 모드에서 막힐 수 있다. 기본 높이로 연다.
    return null
  }
}

function writeStored(px: number | null): void {
  try {
    if (px === null) window.localStorage.removeItem(STORAGE_KEY)
    else window.localStorage.setItem(STORAGE_KEY, String(Math.round(px)))
  } catch {
    // 저장에 실패해도 이번 세션 동안은 그대로 쓴다.
  }
}

export function LeftDock() {
  const dockRef = useRef<HTMLDivElement | null>(null)
  const [height, setHeight] = useState<number | null>(() => readStored())
  /** 상태를 읽는 최신 사본. 포인터 핸들러가 옛 값을 보지 않게 한다. */
  const heightRef = useRef<number | null>(height)
  const dragRef = useRef<{ pointerId: number; startY: number; startH: number } | null>(null)

  /** 화면에 실제로 나온 높이와 지금 허용되는 최대값. 손잡이의 aria 값에 쓴다. */
  const [shownH, setShownH] = useState(MIN_H)
  const [maxH, setMaxH] = useState(MIN_H)

  const apply = useCallback((px: number | null): void => {
    heightRef.current = px
    setHeight(px)
  }, [])

  /** 도크 안에 들어가는 값으로 가둔다. */
  const clampToDock = useCallback((px: number): number => {
    const dock = dockRef.current
    const limit = dock ? Math.max(MIN_H, dock.clientHeight - KEEP_BELOW) : Number.POSITIVE_INFINITY
    return Math.max(MIN_H, Math.min(px, limit))
  }, [])

  // 도크나 패널 크기가 바뀔 때마다 표시값을 맞추고, 저장값이 도크를 넘치면 줄인다.
  // window resize 만 듣지 않는 이유는 인스펙터 접힘 같은 레이아웃 변화도 잡아야 하기 때문이다.
  useEffect(() => {
    const dock = dockRef.current
    const panel = dock?.querySelector<HTMLElement>('.mm-lyr-panel')
    if (!dock || !panel) return
    if (typeof ResizeObserver === 'undefined') return

    const sync = (): void => {
      const limit = Math.max(MIN_H, dock.clientHeight - KEEP_BELOW)
      setMaxH(limit)
      setShownH(Math.round(panel.getBoundingClientRect().height))
      const h = heightRef.current
      // 조건이 있으므로 되먹임 루프가 되지 않는다. 한 번 가둬 두면 다음 관측은 조용하다.
      if (h !== null && h > limit) apply(limit)
    }

    const observer = new ResizeObserver(sync)
    observer.observe(dock)
    observer.observe(panel)
    sync()
    return () => observer.disconnect()
  }, [apply])

  /** 드래그와 키보드가 출발점으로 삼는 지금 높이. 아직 손대지 않았으면 실측값이다. */
  const currentHeight = useCallback((): number => {
    return heightRef.current ?? shownH
  }, [shownH])

  const commit = useCallback(
    (px: number | null): void => {
      apply(px)
      writeStored(px)
    },
    [apply],
  )

  function onPointerDown(e: ReactPointerEvent<HTMLDivElement>): void {
    if (e.button !== 0) return
    e.preventDefault()
    dragRef.current = { pointerId: e.pointerId, startY: e.clientY, startH: currentHeight() }
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      // 캡처를 못 잡아도 드래그는 계속된다.
    }
  }

  function onPointerMove(e: ReactPointerEvent<HTMLDivElement>): void {
    const drag = dragRef.current
    if (!drag || e.pointerId !== drag.pointerId) return
    // 저장은 손을 뗄 때 한 번만 한다. localStorage 쓰기는 동기라 프레임마다 부르면 끊긴다.
    apply(clampToDock(drag.startH + (e.clientY - drag.startY)))
  }

  function endDrag(e: ReactPointerEvent<HTMLDivElement>): void {
    const drag = dragRef.current
    if (!drag || e.pointerId !== drag.pointerId) return
    dragRef.current = null
    try {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId)
      }
    } catch {
      // 이미 놓았다.
    }
    writeStored(heightRef.current)
  }

  function onKeyDown(e: ReactKeyboardEvent<HTMLDivElement>): void {
    const step = STEP_PX * (e.shiftKey ? 3 : 1)
    let next: number
    if (e.key === 'ArrowDown') next = currentHeight() + step
    else if (e.key === 'ArrowUp') next = currentHeight() - step
    else if (e.key === 'Home') next = MIN_H
    else if (e.key === 'End') next = maxH
    else if (e.key === 'Enter' || e.key === 'Escape') {
      // 기본값으로 되돌린다. 더블클릭과 같은 동작이다.
      e.preventDefault()
      commit(null)
      return
    } else return

    e.preventDefault()
    commit(clampToDock(next))
  }

  const style = height === null ? undefined : ({ '--mm-layer-h': `${Math.round(height)}px` } as CSSProperties)

  return (
    <div
      ref={dockRef}
      className={height === null ? 'mm-app-source mm-left-dock' : 'mm-app-source mm-left-dock is-resized'}
      style={style}
    >
      <LayerPanel />

      {/*
        role="separator" 에 tabIndex 를 주면 창 분할 손잡이가 된다.
        마우스가 없어도 화살표로 같은 조작이 되어야 한다.
      */}
      <div
        className="mm-dock-resizer"
        role="separator"
        aria-orientation="horizontal"
        aria-label="레이어 창 높이 조절"
        aria-valuenow={Math.round(height ?? shownH)}
        aria-valuemin={MIN_H}
        aria-valuemax={Math.round(maxH)}
        aria-valuetext={`레이어 창 높이 ${Math.round(height ?? shownH)}픽셀`}
        tabIndex={0}
        title="끌어서 레이어 창 높이를 바꿉니다. 두 번 누르면 기본 높이로 돌아갑니다."
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={() => commit(null)}
        onKeyDown={onKeyDown}
      >
        <span className="mm-dock-resizer-grip" aria-hidden="true" />
      </div>

      <PresetGallery />
    </div>
  )
}

export default LeftDock
