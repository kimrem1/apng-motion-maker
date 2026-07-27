/**
 * 앱 셸.
 *
 * EASY 와 PRO 는 **같은 문서를 보는 두 개의 뷰**다. 동시에 마운트하지 않는다.
 * PreviewCanvas 가 두 개가 되면 WebGL2 컨텍스트가 두 개 생겨
 * "프리뷰 = 결과물" 약속이 깨진다.
 *
 * 드롭은 특정 영역이 아니라 앱 루트 전체에서 받는다. 화면 어디에 떨어뜨려도
 * 이미지가 들어와야 온보딩 흐름이 끊기지 않는다.
 * 그래서 useImageDrop 은 **여기 한 곳에서만** 호출한다. 두 번 걸면 붙여넣기 한 번에
 * 이미지가 두 장 들어온다.
 */

import { useEffect, useState } from 'react'

import { useImageDrop } from '@/imageprep/useImageDrop.ts'
import { useUiStore } from '@/state/ui.ts'
import { startAutosave } from '@/state/persistence.ts'
import { collectBundle, openProjectFromFile, restoreBundle, saveProjectToFile, suggestProjectName } from '@/project/io.ts'
import { PreviewCanvas } from '@/ui/canvas/PreviewCanvas.tsx'
import { TransportBar } from '@/ui/canvas/TransportBar.tsx'
import { EasyMode } from '@/ui/easy/EasyMode.tsx'
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

/** PRO 셸. 4분할 + 하단 타임라인. */
function ProShell() {
  return (
    <>
      {/* 좌측 열은 이미지(레이어)가 위, 모션 프리셋이 아래다. 사이의 손잡이로 높이를 나눈다. */}
      <LeftDock />

      <main className="mm-stage mm-app-stage" id="mm-main" aria-label="미리보기">
        <div className="mm-stage-viewport">
          <PreviewCanvas emptyState={<EmptyStage />} />
        </div>

        <RecoveryBanner />
        <TransportBar />

        <div className="mm-timeline-dock">
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
  const mode = useUiStore((s) => s.mode)

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
    <div
      className={isDragging ? 'mm-app mm-dragging' : 'mm-app'}
      data-mode={mode}
      {...bindDropTarget()}
    >
      <SkipLinks />
      <Toolbar onExport={() => setExportOpen(true)} />

      <ErrorBoundary>
        {mode === 'easy' ? (
          <EasyMode onOpenExportSettings={() => setExportOpen(true)} showHeader={false} />
        ) : (
          <ProShell />
        )}
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
