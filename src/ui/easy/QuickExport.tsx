/**
 * EASY 의 세 번째 클릭.
 *
 * 다이얼로그를 띄우지 않는다. 3번째 클릭에 다이얼로그를 두면 실제 클릭이 4~5회가
 * 되고 3클릭 온보딩이라는 약속이 깨진다. 기본값(투명 스티커 = APNG, 512px)으로 곧바로
 * 인코딩하고, 진행률은 새 모달이 아니라 버튼 자체가 보여준다.
 *
 * 고급 옵션은 "다른 설정으로" 링크와 결과 확인 패널로 밀어낸다.
 *
 * 결과 확인 패널은 선택 사항이 아니다. 다운로드가 끝이면 사용자는 검증을
 * 못 한다. ResultPanel 이 만들어진 Blob 을 img 에 물려 브라우저가 실제로 재생하게 한다.
 *
 * useExport 에서 쓰는 것은 busy / progress / result / error / start / cancel / reset
 * 이 전부다.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react'

import { FPS_CHOICES, FRAMES_MAX } from '@/core/types.ts'
import { exportFrames, type ExportSettings } from '@/export/pipeline.ts'
import { useDocumentStore } from '@/state/document.ts'
import { ResultPanel } from '@/ui/export/ResultPanel.tsx'
import { useExport } from '@/ui/export/useExport.ts'
import {
  DEFAULT_PURPOSE_ID,
  EXPORT_PURPOSES,
  PURPOSE_BY_ID,
  estimateDurationSec,
  formatDuration,
  settingsForPurpose,
} from '@/ui/export/exportSettings.ts'

import '@/ui/export/export.css'
import './easy.css'

/**
 * EASY 의 기본 용도는 투명 배경 스티커다.
 * 반투명 가장자리를 그대로 남기는 것이 이 제품의 강점이고, 그것을 기본값으로 두지 않으면
 * 대부분의 사용자가 강점을 한 번도 보지 못한 채 GIF 를 받아 간다.
 */
const STICKER = PURPOSE_BY_ID.get(DEFAULT_PURPOSE_ID) ?? EXPORT_PURPOSES[0]!

/** tabindex="-1" 은 전부 제외한다. 저장 폴백용 숨은 앵커가 트랩에 잡히면 안 된다. */
const FOCUSABLE =
  'a[href]:not([tabindex="-1"]), button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

function IconClose() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}

export interface QuickExportProps {
  /** "다른 설정으로". 전체 내보내기 다이얼로그를 여는 것은 호출자의 몫이다. */
  onOpenSettings(): void
}

export function QuickExport({ onOpenSettings }: QuickExportProps) {
  const doc = useDocumentStore((s) => s.doc)
  const setFps = useDocumentStore((s) => s.setFps)
  const setDurationFrames = useDocumentStore((s) => s.setDurationFrames)

  const { busy, progress, result, error, start, cancel, reset } = useExport()

  const cardRef = useRef<HTMLDivElement | null>(null)

  const settings = useMemo(
    () => settingsForPurpose(STICKER, doc.canvas.w, doc.canvas.h),
    [doc.canvas.w, doc.canvas.h],
  )

  const frameCount = useMemo(() => exportFrames(doc).length, [doc])
  const durationSec = estimateDurationSec(
    frameCount,
    settings.width,
    settings.height,
    settings.format,
  )

  const hasLayers = doc.layers.length > 0
  // 결과를 만든 뒤 문서가 바뀌었는가. immer 라 참조 비교로 충분하다.
  const stale = result !== null && result.sourceDoc !== doc
  const percent = progress ? Math.min(100, Math.max(0, Math.round(progress.done))) : 0

  // -------------------------------------------------------------------------
  // 결과 패널 (모달)
  // -------------------------------------------------------------------------

  useEffect(() => {
    if (!result) return
    cardRef.current?.focus()
  }, [result])

  useEffect(() => {
    if (!result) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      // 재인코딩 중에 Esc 로 닫히면 진행 중인 작업을 잃는다. 취소를 먼저 누르게 한다.
      if (busy) return
      reset()
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
    }
  }, [result, busy, reset])

  /** 최소 포커스 트랩. Tab 이 모달 밖으로 나가면 뒤 화면을 조작하게 된다. */
  const handleCardKeyDown = useCallback((e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Tab') return
    const card = e.currentTarget
    const items = [...card.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
      (el) => el.offsetParent !== null || el === document.activeElement,
    )
    if (items.length === 0) return
    const first = items[0]!
    const last = items[items.length - 1]!
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault()
      first.focus()
    }
  }, [])

  // -------------------------------------------------------------------------
  // 동작
  // -------------------------------------------------------------------------

  const handleExport = (): void => {
    void start(settings)
  }

  const handleReencode = (next: ExportSettings): void => {
    reset()
    void start(next)
  }

  const lowerFps = [...FPS_CHOICES].filter((f) => f < doc.timeline.fps).pop()

  /**
   * fps 를 낮추면 문서가 바뀐다(undo 대상).
   * 지속시간을 유지하려면 프레임 수도 같이 줄여야 한다. 안 그러면 애니메이션이 느려진다.
   */
  const handleLowerFps = (): void => {
    if (lowerFps === undefined || !result) return
    const scale = lowerFps / doc.timeline.fps
    const nextFrames = Math.min(
      FRAMES_MAX,
      Math.max(1, Math.round(doc.timeline.durationFrames * scale)),
    )
    setFps(lowerFps)
    // 파생된 길이 조정이다. 길이 못박기 표시를 남기면 이후 속도 노브가 잠긴다.
    setDurationFrames(nextFrames, { pin: false })
    const next = result.settings
    reset()
    void start(next)
  }

  const openSettings = (): void => {
    reset()
    onOpenSettings()
  }

  // -------------------------------------------------------------------------
  // 렌더
  // -------------------------------------------------------------------------

  return (
    <div className="mm-qexp">
      <button
        type="button"
        className={
          busy ? 'mm-btn mm-btn-primary mm-qexp-btn is-busy' : 'mm-btn mm-btn-primary mm-qexp-btn'
        }
        disabled={busy || !hasLayers}
        onClick={handleExport}
      >
        {busy ? (
          <span className="mm-qexp-fill" style={{ width: `${percent}%` }} aria-hidden="true" />
        ) : null}
        <span className="mm-qexp-label">
          {busy && progress
            ? `${progress.message} ${percent}%`
            : `내보내기 (${formatDuration(durationSec)})`}
        </span>
      </button>

      <div className="mm-qexp-meta">
        <span className="mm-qexp-facts">
          투명 배경 스티커 · {settings.width} x {settings.height} · {doc.timeline.fps}fps ·{' '}
          {frameCount}장
        </span>
        <button type="button" className="mm-easy-link" disabled={busy} onClick={openSettings}>
          다른 설정으로
        </button>
        {busy ? (
          <button type="button" className="mm-btn" onClick={cancel}>
            취소
          </button>
        ) : null}
      </div>

      {error ? (
        <p className="mm-error" role="alert">
          {error}
        </p>
      ) : null}

      {/* 진행 상황은 화면 낭독기에도 알린다. */}
      <p className="mm-visually-hidden" role="status">
        {busy && progress ? `${progress.message} ${percent}%` : ''}
      </p>

      {result ? (
        <div className="mm-modal-scrim" role="presentation">
          <div
            ref={cardRef}
            className="mm-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="mm-qexp-title"
            tabIndex={-1}
            onKeyDown={handleCardKeyDown}
          >
            <header className="mm-modal-head">
              <h2 id="mm-qexp-title" className="mm-modal-title">
                완성
              </h2>
              <button
                type="button"
                className="mm-icon-btn"
                aria-label="닫기"
                disabled={busy}
                onClick={reset}
              >
                <IconClose />
              </button>
            </header>

            <div className="mm-modal-body mm-scroll">
              <ResultPanel
                result={result}
                busy={busy}
                stale={stale}
                onRemake={() => {
                  reset()
                  void start(result.settings)
                }}
                onReencode={handleReencode}
                onLowerFps={handleLowerFps}
                canLowerFps={lowerFps !== undefined}
                lowerFpsLabel={
                  lowerFps === undefined
                    ? ''
                    : `${doc.timeline.fps}fps 를 ${lowerFps}fps 로 낮춰 다시 만듭니다`
                }
              />
            </div>

            <footer className="mm-modal-foot">
              <button type="button" className="mm-btn" disabled={busy} onClick={reset}>
                닫기
              </button>
              <button type="button" className="mm-btn" disabled={busy} onClick={openSettings}>
                다른 설정으로
              </button>
              {busy ? (
                <button type="button" className="mm-btn" onClick={cancel}>
                  취소
                </button>
              ) : null}
            </footer>
          </div>
        </div>
      ) : null}
    </div>
  )
}

export default QuickExport
