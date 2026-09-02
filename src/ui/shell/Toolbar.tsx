/**
 * 상단 툴바.
 *
 * 단축키는 여기서 바인딩하지 않는다. ui/shortcuts 레지스트리 한 곳에서만 잡는다.
 */

import { useDocumentStore } from '@/state/document.ts'
import { SKIP_TARGET_IDS } from '@/ui/a11y/SkipLinks.tsx'
import { getCommandHost } from '@/ui/shortcuts/registry.ts'


function IconMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <rect x="1.5" y="1.5" width="15" height="15" rx="4" stroke="currentColor" strokeWidth="1.5" />
      <path d="M5.5 12.5V5.5l3.5 4 3.5-4v7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function IconUndo() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M6 4L2.5 7.5 6 11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M2.5 7.5h6.75A3.75 3.75 0 0 1 13 11.25v0" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

function IconRedo() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M10 4l3.5 3.5L10 11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M13.5 7.5H6.75A3.75 3.75 0 0 0 3 11.25v0" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

function IconExport() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M8 2v8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M4.75 6.75L8 10l3.25-3.25" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M2.75 11.5v1.25c0 .41.34.75.75.75h9c.41 0 .75-.34.75-.75V11.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

function IconOpen() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M2 4.25c0-.41.34-.75.75-.75h3.4l1.2 1.5h5.9c.41 0 .75.34.75.75v6.5c0 .41-.34.75-.75.75H2.75a.75.75 0 0 1-.75-.75v-8Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
    </svg>
  )
}

function IconSave() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M3 2.75h7.5L13 5.25v8c0 .41-.34.75-.75.75h-9a.75.75 0 0 1-.75-.75v-9.75c0-.41.34-.75.75-.75Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <path d="M5 2.75v3.5h5v-3.5M4.75 10.5h6.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  )
}

export interface ToolbarProps {
  onExport(): void
}

export function Toolbar({ onExport }: ToolbarProps) {
  const undo = useDocumentStore((s) => s.undo)
  const redo = useDocumentStore((s) => s.redo)
  const canUndo = useDocumentStore((s) => s.past.length > 0)
  const canRedo = useDocumentStore((s) => s.future.length > 0)
  const lastLabel = useDocumentStore((s) => s.past[s.past.length - 1]?.label)
  const nextLabel = useDocumentStore((s) => s.future[0]?.label)

  // Ctrl+Z / Ctrl+Shift+Z 는 ui/shortcuts 레지스트리가 잡는다.
  // 여기서 또 바인딩하면 한 번 눌러 두 번 실행되어 실행취소가 두 칸씩 건너뛴다.

  return (
    <header className="mm-toolbar mm-app-toolbar">
      <div className="mm-toolbar-left">
        <span className="mm-brand">
          <span className="mm-brand-mark">
            <IconMark />
          </span>
          MOTION MAKER
        </span>
        <span className="mm-divider" aria-hidden="true" />
        <button
          type="button"
          className="mm-icon-btn"
          disabled={!canUndo}
          onClick={undo}
          title={canUndo ? `실행 취소: ${lastLabel} (Ctrl+Z)` : '되돌릴 작업이 없습니다'}
          aria-label={canUndo ? `실행 취소: ${lastLabel}` : '실행 취소, 되돌릴 작업이 없습니다'}
        >
          <IconUndo />
        </button>
        <button
          type="button"
          className="mm-icon-btn"
          disabled={!canRedo}
          onClick={redo}
          title={canRedo ? `다시 실행: ${nextLabel} (Ctrl+Shift+Z)` : '다시 실행할 작업이 없습니다'}
          aria-label={canRedo ? `다시 실행: ${nextLabel}` : '다시 실행, 다시 실행할 작업이 없습니다'}
        >
          <IconRedo />
        </button>
      </div>

      <div className="mm-toolbar-right">
        <button
          type="button"
          className="mm-icon-btn"
          onClick={() => getCommandHost().openFile?.()}
          title="프로젝트 열기 (Ctrl+O)"
          aria-label="프로젝트 열기"
        >
          <IconOpen />
        </button>
        <button
          type="button"
          className="mm-icon-btn"
          onClick={() => getCommandHost().saveProject?.()}
          title="프로젝트 저장 (Ctrl+S)"
          aria-label="프로젝트 저장"
        >
          <IconSave />
        </button>
        <span className="mm-divider" aria-hidden="true" />
        <button
          type="button"
          id={SKIP_TARGET_IDS.export}
          className="mm-btn mm-btn-primary"
          onClick={onExport}
          title="내보내기 (Ctrl+E)"
        >
          <IconExport />
          내보내기
        </button>
      </div>
    </header>
  )
}

export default Toolbar
