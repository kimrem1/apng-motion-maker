/**
 * 앱 셸.
 *
 * 드롭은 특정 영역이 아니라 앱 루트 전체에서 받는다. 화면 어디에 떨어뜨려도
 * 이미지가 들어와야 온보딩 흐름이 끊기지 않는다.
 * 그래서 useImageDrop 은 여기 한 곳에서만 호출한다. 두 번 걸면 붙여넣기 한 번에
 * 이미지가 두 장 들어온다.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'

import { useImageDrop } from '@/imageprep/useImageDrop.ts'
import { startAutosave } from '@/state/persistence.ts'
import { collectBundle, openProjectFromFile, restoreBundle, saveProjectToFile, suggestProjectName } from '@/project/io.ts'
import { PreviewCanvas } from '@/ui/canvas/PreviewCanvas.tsx'
import { TransportBar } from '@/ui/canvas/TransportBar.tsx'
import { ExportDialog } from '@/ui/export/ExportDialog.tsx'
import { Inspector } from '@/ui/inspector/Inspector.tsx'
import { ErrorBoundary } from '@/ui/shell/ErrorBoundary.tsx'
import { LeftDock } from '@/ui/shell/LeftDock.tsx'
import { RecoveryBanner } from '@/ui/shell/RecoveryBanner.tsx'
import { StatusBar } from '@/ui/shell/StatusBar.tsx'
import { Toolbar } from '@/ui/shell/Toolbar.tsx'
import { CommandPalette } from '@/ui/shortcuts/CommandPalette.tsx'
import { ShortcutHelp } from '@/ui/shortcuts/ShortcutHelp.tsx'
import { setCommandHost } from '@/ui/shortcuts/registry.ts'
import { useShortcuts } from '@/ui/shortcuts/useShortcuts.ts'
import { Timeline } from '@/ui/timeline/Timeline.tsx'
import { LiveRegion } from '@/ui/a11y/LiveRegion.tsx'
import { SkipLinks } from '@/ui/a11y/SkipLinks.tsx'

import './tokens.css'
import './app.css'

/** 아직 이미지가 없을 때 스테이지에 띄우는 안내. */
function EmptyStage() {
  return (
    <div className="mm-empty">
      <p className="mm-empty-title">이미지를 끌어다 놓으세요</p>
      <p className="mm-empty-sub">Ctrl+V 로 붙여넣거나 왼쪽 [이미지 추가] 버튼을 눌러도 됩니다.</p>
    </div>
  )
}

// ---------------------------------------------------------------------------
// 타임라인 도크 높이
// ---------------------------------------------------------------------------

const TIMELINE_H_KEY = 'mm.timelineDock.height'
/** 이보다 낮으면 클립 줄 한두 개도 못 보여 준다. */
const TIMELINE_MIN_H = 140
/** 미리보기 몫으로 남겨 두는 높이. 이게 없으면 도크가 미리보기를 0 으로 밀어낸다. */
const KEEP_VIEWPORT = 200
/** 화살표 한 번의 이동량. Shift 를 누르면 3배다. */
const TIMELINE_STEP_PX = 16

function readStoredDockHeight(): number | null {
  try {
    const raw = window.localStorage.getItem(TIMELINE_H_KEY)
    if (raw === null) return null
    const n = Number(raw)
    return Number.isFinite(n) && n >= TIMELINE_MIN_H ? n : null
  } catch {
    // 프라이빗 모드에서 막힐 수 있다. 기본값으로 연다.
    return null
  }
}

function writeStoredDockHeight(px: number | null): void {
  try {
    if (px === null) window.localStorage.removeItem(TIMELINE_H_KEY)
    else window.localStorage.setItem(TIMELINE_H_KEY, String(Math.round(px)))
  } catch {
    // 저장에 실패해도 이번 세션 동안은 그대로 쓴다.
  }
}

/** 편집 셸 본체. 4분할 + 하단 타임라인. 타임라인 위 손잡이로 도크 높이를 조절한다. */
function ProShell() {
  const stageRef = useRef<HTMLElement | null>(null)
  /** null 이면 손대기 전이다. CSS 기본 높이(app.css .mm-timeline-dock)를 그대로 쓴다. */
  const [dockH, setDockH] = useState<number | null>(() => readStoredDockHeight())
  const dockHRef = useRef<number | null>(dockH)
  const dragRef = useRef<{ pointerId: number; startY: number; startH: number } | null>(null)
  /** 실측 높이와 지금 허용되는 최대값. 손잡이의 aria 값에 쓴다. */
  const [shownH, setShownH] = useState(TIMELINE_MIN_H)
  const [maxH, setMaxH] = useState(TIMELINE_MIN_H)

  const apply = useCallback((px: number | null): void => {
    dockHRef.current = px
    setDockH(px)
  }, [])

  /** 스테이지 안에 들어가는 값으로 가둔다. 미리보기 몫은 남긴다. */
  const clampToStage = useCallback((px: number): number => {
    const stage = stageRef.current
    const limit = stage
      ? Math.max(TIMELINE_MIN_H, stage.clientHeight - KEEP_VIEWPORT)
      : Number.POSITIVE_INFINITY
    return Math.max(TIMELINE_MIN_H, Math.min(px, limit))
  }, [])

  // 창을 줄이면 저장된 높이가 미리보기를 밀어낸다. 다시 가두고 표시값도 맞춘다.
  useEffect(() => {
    const stage = stageRef.current
    const dock = stage?.querySelector<HTMLElement>('.mm-timeline-dock')
    if (!stage || !dock) return
    if (typeof ResizeObserver === 'undefined') return

    const sync = (): void => {
      const limit = Math.max(TIMELINE_MIN_H, stage.clientHeight - KEEP_VIEWPORT)
      setMaxH(limit)
      setShownH(Math.round(dock.getBoundingClientRect().height))
      const h = dockHRef.current
      // 조건이 있으므로 되먹임 루프가 되지 않는다.
      if (h !== null && h > limit) apply(limit)
    }

    const observer = new ResizeObserver(sync)
    observer.observe(stage)
    observer.observe(dock)
    sync()
    return () => observer.disconnect()
  }, [apply])

  const currentHeight = useCallback((): number => {
    return dockHRef.current ?? shownH
  }, [shownH])

  const commit = useCallback(
    (px: number | null): void => {
      apply(px)
      writeStoredDockHeight(px)
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
    // 위로 끌면 도크가 자란다. 저장은 손을 뗄 때 한 번만 한다.
    apply(clampToStage(drag.startH + (drag.startY - e.clientY)))
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
    writeStoredDockHeight(dockHRef.current)
  }

  function onKeyDown(e: ReactKeyboardEvent<HTMLDivElement>): void {
    const step = TIMELINE_STEP_PX * (e.shiftKey ? 3 : 1)
    let next: number
    if (e.key === 'ArrowUp') next = currentHeight() + step
    else if (e.key === 'ArrowDown') next = currentHeight() - step
    else if (e.key === 'Home') next = TIMELINE_MIN_H
    else if (e.key === 'End') next = maxH
    else if (e.key === 'Enter' || e.key === 'Escape') {
      // 기본 높이로 되돌린다. 더블클릭과 같은 동작이다.
      e.preventDefault()
      commit(null)
      return
    } else return

    e.preventDefault()
    commit(clampToStage(next))
  }

  return (
    <>
      {/* 좌측 열은 이미지(레이어)가 위, 모션 프리셋이 아래다. 사이의 손잡이로 높이를 나눈다. */}
      <LeftDock />

      <main ref={stageRef} className="mm-stage mm-app-stage" id="mm-main" aria-label="미리보기">
        <div className="mm-stage-viewport">
          <PreviewCanvas emptyState={<EmptyStage />} />
        </div>

        <RecoveryBanner />
        <TransportBar />

        {/*
          도크 밖(여기)에 두는 이유: Timeline 은 그래프 에디터나 빈 화면으로 바뀌어도
          도크 높이는 유지되어야 한다. 안에 넣으면 그 분기마다 손잡이가 사라진다.
        */}
        <div
          className="mm-timeline-resizer"
          role="separator"
          aria-orientation="horizontal"
          aria-label="타임라인 높이 조절"
          aria-valuenow={Math.round(dockH ?? shownH)}
          aria-valuemin={TIMELINE_MIN_H}
          aria-valuemax={Math.round(maxH)}
          aria-valuetext={`타임라인 높이 ${Math.round(dockH ?? shownH)}픽셀`}
          tabIndex={0}
          title="끌어서 타임라인 높이를 바꿉니다. 두 번 누르면 기본 높이로 돌아갑니다."
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onDoubleClick={() => commit(null)}
          onKeyDown={onKeyDown}
        >
          <span className="mm-dock-resizer-grip" aria-hidden="true" />
        </div>

        <div
          className="mm-timeline-dock"
          style={dockH !== null ? { height: `${Math.round(dockH)}px` } : undefined}
        >
          <Timeline />
        </div>
      </main>

      <Inspector />
      <StatusBar />
    </>
  )
}

export function App() {
  const { isDragging, busy, error, warning, clearMessages, bindDropTarget } = useImageDrop()
  const message = error ?? warning
  const [exportOpen, setExportOpen] = useState(false)
  const [autosaveError, setAutosaveError] = useState<string | null>(null)

  // 단축키는 앱 루트에서 한 번만 건다. 여러 곳에서 걸면 한 번 눌러 두 번 실행된다.
  useShortcuts()

  useEffect(() => {
    // 저장 실패를 조용히 넘기지 않는다.
    const stop = startAutosave({ onError: (msg) => setAutosaveError(msg) })
    return stop
  }, [])

  // 명령 핸들러 주입. 레지스트리가 DOM 과 문서 스토어를 모르게 두기 위한 통로다.
  useEffect(() => {
    return setCommandHost({
      openExport: () => setExportOpen(true),
      notify: (msg) => setAutosaveError(msg),
      saveProject: () => {
        void (async () => {
          try {
            await saveProjectToFile(await collectBundle(), suggestProjectName())
          } catch (err) {
            setAutosaveError(err instanceof Error ? err.message : '저장하지 못했습니다.')
          }
        })()
      },
      openFile: () => {
        void (async () => {
          try {
            const opened = await openProjectFromFile()
            if (!opened) return
            await restoreBundle(opened.bundle)
            if (opened.warnings.length > 0) setAutosaveError(opened.warnings.join(' / '))
          } catch (err) {
            setAutosaveError(err instanceof Error ? err.message : '파일을 열지 못했습니다.')
          }
        })()
      },
    })
  }, [])

  const banner = message ?? autosaveError

  return (
    // 드래그 중에는 트랜지션을 죽인다.
    <div className={isDragging ? 'mm-app mm-dragging' : 'mm-app'} {...bindDropTarget()}>
      <SkipLinks />
      <Toolbar onExport={() => setExportOpen(true)} />

      <ErrorBoundary>
        <ProShell />
      </ErrorBoundary>

      {banner ? (
        <div className={error ? 'mm-banner is-error mm-app-banner' : 'mm-banner mm-app-banner'} role="alert">
          <span className="mm-banner-text">{banner}</span>
          <button
            type="button"
            className="mm-btn"
            onClick={() => {
              clearMessages()
              setAutosaveError(null)
            }}
          >
            닫기
          </button>
        </div>
      ) : null}

      <ExportDialog open={exportOpen} onClose={() => setExportOpen(false)} />
      <CommandPalette />
      <ShortcutHelp />
      <LiveRegion />

      {isDragging ? (
        <div className="mm-dropzone">
          <p className="mm-dropzone-card" role="status">
            놓으면 이미지가 추가됩니다
          </p>
        </div>
      ) : null}

      {/* 진행 상황은 화면 낭독기에도 알린다. */}
      <p className="mm-visually-hidden" role="status">
        {busy ? '이미지를 불러오는 중입니다' : ''}
      </p>
    </div>
  )
}

export default App
