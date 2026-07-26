/**
 * 프리뷰 스테이지.
 *
 * 캔버스의 드로잉 버퍼는 항상 내보내기 해상도다(useRenderer.ts). 여기서는 표시 크기만
 * CSS 로 계산한다. 축소는 하되 확대는 하지 않는다(zoom 이 'fit' 일 때).
 *
 * 체커보드는 테마와 무관하게 중립 회색 2톤 고정이다.
 * 다크에서 검은 체커보드를 쓰면 어두운 이미지의 투명 영역이 안 보인다.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react'

import { useDocumentStore } from '@/state/document.ts'
import { useUiStore } from '@/state/ui.ts'
import { useRenderer } from './useRenderer.ts'

const PREVIEW_CSS = `
.preview {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  height: 100%;
  background: var(--bg);
}

.preview__stage {
  display: flex;
  flex: 1;
  min-height: 0;
  padding: var(--sp-5);
  overflow: auto;
}

/* margin auto 로 가운데를 잡는다. align-items:center 는 넘칠 때 위쪽이 잘린다. */
.preview__frame {
  flex: none;
  margin: auto;
  box-shadow: var(--shadow-2);
  background-color: var(--checker-a);
  background-image: repeating-conic-gradient(
    var(--checker-b) 0% 25%,
    var(--checker-a) 0% 50%
  );
  background-size: 16px 16px;
}

.preview__notice {
  margin: auto;
  display: flex;
  flex-direction: column;
  gap: var(--sp-4);
  max-width: 460px;
  padding: var(--sp-6);
  text-align: center;
}

.preview__notice-title {
  font-size: var(--fs-lg);
  font-weight: 600;
  color: var(--text);
}

.preview__notice-body {
  color: var(--text-muted);
}

.preview__notice-detail {
  color: var(--text-faint);
  font-size: var(--fs-xs);
}

.preview__empty {
  margin: auto;
  display: flex;
  min-width: 0;
}

.preview__bar {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  padding: var(--sp-2) var(--sp-4);
  border-top: 1px solid var(--border);
  background: var(--surface);
  color: var(--text-muted);
  font-size: var(--fs-xs);
}

.preview__size {
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
  color: var(--text);
}

.preview__scale {
  font-variant-numeric: tabular-nums;
}

.preview__zoom {
  display: flex;
  gap: var(--sp-1);
  margin-left: auto;
}

.preview__zoom .mm-btn {
  min-height: 24px;
  padding: 0 var(--sp-3);
  font-size: var(--fs-xs);
}

.preview__zoom .mm-btn[aria-pressed='true'] {
  background: var(--accent-soft);
  border-color: var(--accent);
  color: var(--text);
}
`

export interface PreviewCanvasProps {
  /** 이미지가 하나도 없을 때 캔버스 대신 보여줄 노드. App 이 드롭존을 주입한다. */
  emptyState?: ReactNode
}

export function PreviewCanvas({ emptyState }: PreviewCanvasProps): ReactNode {
  const canvasW = useDocumentStore((s) => s.doc.canvas.w)
  const canvasH = useDocumentStore((s) => s.doc.canvas.h)
  const layerCount = useDocumentStore((s) => s.doc.layers.length)

  const zoom = useUiStore((s) => s.zoom)
  const setZoom = useUiStore((s) => s.setZoom)
  const rendererError = useUiStore((s) => s.rendererError)

  const { hostRef } = useRenderer()

  const stageRef = useRef<HTMLDivElement | null>(null)
  const [stageW, setStageW] = useState(0)
  const [stageH, setStageH] = useState(0)

  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect
      if (!rect) return
      setStageW(rect.width)
      setStageH(rect.height)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // 'fit' 은 축소만 한다. 1 을 넘기지 않는다.
  const measured = stageW > 0 && stageH > 0
  const fitScale = measured ? Math.min(1, stageW / canvasW, stageH / canvasH) : 1
  const scale = zoom === 'fit' ? fitScale : zoom
  const dispW = Math.max(1, Math.round(canvasW * scale))
  const dispH = Math.max(1, Math.round(canvasH * scale))

  let content: ReactNode
  if (rendererError) {
    content = (
      <div className="preview__notice" role="alert">
        <p className="preview__notice-title">이 브라우저에서는 실행할 수 없습니다</p>
        <p className="preview__notice-body">
          이 도구는 그림을 그리는 데 WebGL2 를 사용합니다. 지금 브라우저에서는 WebGL2 를 쓸 수
          없습니다. 최신 버전의 Chrome, Edge, Firefox, Safari 에서 열어주세요.
        </p>
        <p className="preview__notice-detail">{rendererError}</p>
      </div>
    )
  } else if (layerCount === 0) {
    content = (
      <div className="preview__empty">
        {emptyState ?? (
          <div className="preview__notice">
            <p className="preview__notice-title">이미지를 여기에 끌어다 놓으세요</p>
            <p className="preview__notice-body">
              PNG, JPG, WebP, GIF 를 올릴 수 있습니다. 붙여넣기(Ctrl+V)도 됩니다.
            </p>
          </div>
        )}
      </div>
    )
  } else {
    content = (
      <div
        ref={hostRef}
        className="preview__frame"
        style={{ width: `${dispW}px`, height: `${dispH}px` }}
      />
    )
  }

  return (
    <div className="preview">
      <style href="mm-preview-canvas" precedence="default">
        {PREVIEW_CSS}
      </style>

      <div className="preview__stage" ref={stageRef}>
        {content}
      </div>

      <div className="preview__bar">
        <span className="preview__size">
          {canvasW} x {canvasH}
        </span>
        <span className="preview__scale">{Math.round(scale * 100)}%</span>

        <div className="preview__zoom" role="group" aria-label="화면 배율">
          <button
            type="button"
            className="mm-btn"
            aria-pressed={zoom === 'fit'}
            onClick={() => setZoom('fit')}
          >
            맞춤
          </button>
          <button
            type="button"
            className="mm-btn"
            aria-pressed={zoom === 0.5}
            onClick={() => setZoom(0.5)}
          >
            50%
          </button>
          <button
            type="button"
            className="mm-btn"
            aria-pressed={zoom === 1}
            onClick={() => setZoom(1)}
          >
            100%
          </button>
        </div>
      </div>
    </div>
  )
}
