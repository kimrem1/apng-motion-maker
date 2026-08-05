/**
 * 에러 바운더리.
 *
 * 렌더 중 예외 하나가 앱 전체를 흰 화면으로 만든다. 이 도구는 사용자가 몇십 분에
 * 걸쳐 만든 애니메이션을 들고 있다. 흰 화면은 곧 그걸 통째로 잃었다는 뜻이고,
 * 최악은 사용자가 그 사실을 모른 채 새로고침한다는 것이다.
 *
 * 그래서 이 화면이 하는 일은 사과가 아니라 다음 행동을 정확히 알려 주는 것이다.
 *   1. 작업이 아직 살아 있는지 없는지를 먼저 말한다.
 *   2. 가장 덜 파괴적인 복구 수단([다시 시도])을 맨 앞에 둔다.
 *   3. 새로고침은 잃을 것을 밝힌 뒤에만 제안한다.
 *
 * [다시 시도] 가 새로고침보다 나은 이유:
 * 문서 상태는 zustand 스토어에 있고 그건 React 트리 밖이다. 화면만 다시 그리면
 * 문서는 그대로 살아 있다. 새로고침은 그 스토어까지 버린다.
 *
 * WebGL 컨텍스트 손실은 여기서 다루지 않는다
 *
 * webglcontextlost 는 캔버스 DOM 이벤트지 React 렌더 예외가 아니다.
 * 에러 바운더리는 그 이벤트를 절대 볼 수 없다. 컨텍스트가 날아가도 React 는
 * 아무 일 없이 계속 렌더하고, 화면만 조용히 멈춘다. 그건 이 컴포넌트로 못 잡는다.
 *
 * 올바른 자리는 ui/canvas/useRenderer.ts 다.
 *   canvas.addEventListener('webglcontextlost', e => { e.preventDefault(); ... })
 *   canvas.addEventListener('webglcontextrestored', () => 리소스 재생성)
 * preventDefault 를 안 부르면 브라우저가 복구를 아예 시도하지 않는다.
 * 상태는 이미 있는 useUiStore.rendererError 로 올리면 PreviewCanvas 가 그린다.
 *
 * 다만 손실 직후 의 렌더 코드가 던지는 예외는 여기까지 올라온다.
 * 그 경우를 알아보고 문구를 바꾸도록 isContextLossError 를 둔다.
 */

import { Component, type ErrorInfo, type ReactNode } from 'react'

import { getAutosaveStatus } from '@/state/persistence.ts'
import { announceFailure } from '@/ui/a11y/announce.ts'

const BOUNDARY_CSS = `
.mm-boundary {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100dvh;
  padding: var(--sp-6);
  background: var(--bg);
}

.mm-boundary__card {
  display: flex;
  flex-direction: column;
  gap: var(--sp-4);
  width: min(620px, 100%);
  padding: var(--sp-6);
  border: 1px solid var(--border-strong);
  border-left: 6px double var(--danger);
  border-radius: var(--r-lg);
  background: var(--surface);
  box-shadow: var(--shadow-2);
}

.mm-boundary__title {
  color: var(--text);
  font-size: var(--fs-lg);
  font-weight: 700;
}

.mm-boundary__body {
  color: var(--text-muted);
  font-size: var(--fs-md);
  line-height: 1.6;
}

.mm-boundary__recovery {
  padding: var(--sp-4);
  border: 1px solid var(--border);
  border-left: 3px solid var(--accent);
  border-radius: var(--r-md);
  background: var(--surface-raised);
  color: var(--text);
  font-size: var(--fs-sm);
  line-height: 1.6;
}

.mm-boundary__recovery.is-warn {
  border-left-width: 6px;
  border-left-style: double;
  border-left-color: var(--warn);
}

.mm-boundary__actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-3);
}

.mm-boundary__details {
  font-size: var(--fs-sm);
}

.mm-boundary__details > summary {
  color: var(--text-muted);
  cursor: pointer;
}

.mm-boundary__pre {
  max-height: 220px;
  margin-top: var(--sp-3);
  padding: var(--sp-3);
  overflow: auto;
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  background: var(--bg);
  color: var(--text-muted);
  font-family: var(--font-mono);
  font-size: var(--fs-xs);
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
  scrollbar-width: thin;
}
`

/**
 * 컨텍스트 손실이 원인일 가능성이 높은 예외인가.
 * 문자열 판별이라 확실하지 않다. 문구를 부드럽게 바꾸는 데만 쓴다.
 */
export function isContextLossError(error: Error): boolean {
  const text = `${error.name} ${error.message}`.toLowerCase()
  return (
    text.includes('context lost') ||
    text.includes('contextlost') ||
    text.includes('webgl') ||
    text.includes('framebuffer')
  )
}

/** "12초 전" 같은 상대 시각. StatusBar 와 같은 규칙을 쓴다. */
function relativeTime(from: number, now: number): string {
  const sec = Math.max(0, Math.round((now - from) / 1000))
  if (sec < 60) return `${sec}초 전`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}분 전`
  return `${Math.floor(min / 60)}시간 전`
}

export interface ErrorBoundaryProps {
  children: ReactNode
  /**
   * 마지막 자동저장 시각 (epoch ms) 을 밖에서 정할 때만 준다.
   *
   * 주지 않으면 state/persistence.ts 의 상태를 그 자리에서 읽는다.
   * 이 컴포넌트는 클래스라 훅을 못 쓰지만, 애초에 오류 화면은 한 번만 그려지고
   * 그 뒤로 갱신될 필요가 없다. 구독 대신 그때 한 번 읽는 편이 정확하다.
   *
   * **저장된 적이 없으면 있는 척하지 않는다.** 있으면 복구를 안내하고,
   * 없으면 새로고침이 무엇을 지우는지 그대로 말한다.
   */
  savedAt?: number | null
  /** 사용자가 [다시 시도] 를 눌렀을 때. 프리뷰 재초기화 같은 정리를 붙일 자리다. */
  onReset?(): void
  /** 예외를 밖으로도 흘리고 싶을 때 (로깅 등). */
  onError?(error: Error, info: ErrorInfo): void
}

interface ErrorBoundaryState {
  error: Error | null
  componentStack: string
  /** 올리면 자식 트리가 통째로 새로 마운트된다. */
  attempt: number
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null, componentStack: '', attempt: 0 }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { error }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // 콘솔에는 항상 남긴다. 사용자가 캡처를 보내 줄 때 이게 유일한 단서다.
    console.error('[boundary] 렌더 중 예외', error, info.componentStack)
    this.setState({ componentStack: info.componentStack ?? '' })
    // 화면이 통째로 갈렸다. 낭독기에는 이 사실이 아무 신호도 없이 도착한다.
    announceFailure('문제가 생겨 화면을 표시하지 못했습니다. 다시 시도 버튼이 있습니다.')
    this.props.onError?.(error, info)
  }

  private handleRetry = (): void => {
    this.props.onReset?.()
    this.setState((prev) => ({ error: null, componentStack: '', attempt: prev.attempt + 1 }))
  }

  private handleReload = (): void => {
    window.location.reload()
  }

  override render(): ReactNode {
    const { error, componentStack, attempt } = this.state
    if (!error) {
      // key 를 바꿔야 [다시 시도] 가 "같은 상태로 다시 그리기" 가 아니라
      // "처음부터 다시 마운트" 가 된다. 그러지 않으면 같은 예외가 즉시 반복된다.
      return <ErrorBoundaryScope key={attempt}>{this.props.children}</ErrorBoundaryScope>
    }

    const autoAt = getAutosaveStatus().at
    const savedAt =
      this.props.savedAt !== undefined ? this.props.savedAt : autoAt > 0 ? autoAt : null
    const glLikely = isContextLossError(error)

    return (
      <div className="mm-boundary">
        <style href="mm-error-boundary" precedence="default">
          {BOUNDARY_CSS}
        </style>

        {/* role="alert" 로 즉시 읽힌다. 이 화면은 사용자가 찾아온 것이 아니다. */}
        <div className="mm-boundary__card" role="alert" aria-labelledby="mm-boundary-title">
          <h1 className="mm-boundary__title" id="mm-boundary-title">
            문제가 생겼습니다
          </h1>

          <p className="mm-boundary__body">
            {glLikely
              ? '그림을 그리는 장치와의 연결이 끊긴 것 같습니다. 그래픽 드라이버가 갱신되거나 다른 프로그램이 GPU 를 많이 쓸 때 생깁니다.'
              : '화면을 그리는 중에 예상하지 못한 오류가 났습니다.'}{' '}
            아래 [다시 시도] 를 먼저 눌러 보세요.
          </p>

          {/* 가장 중요한 정보를 가장 먼저. 내 작업이 남아 있는가. */}
          <p className={savedAt === null ? 'mm-boundary__recovery is-warn' : 'mm-boundary__recovery'}>
            {savedAt === null ? (
              <>
                <strong>아직 자동 저장되지 않았습니다.</strong> [다시 시도] 는 화면만 다시 그리므로
                지금 작업이 그대로 남습니다. 새로고침하면 지금까지 만든 것이 사라집니다. 되도록
                [다시 시도] 로 돌아간 뒤 내보내기부터 해 두세요.
              </>
            ) : (
              <>
                <strong>{relativeTime(savedAt, Date.now())}에 자동 저장되었습니다.</strong>{' '}
                [다시 시도] 로 돌아가면 지금 작업이 그대로 남습니다. 그래도 화면이 다시 깨지면
                새로고침하세요. 저장된 시점으로 되살립니다. 그 뒤의 편집은 사라집니다.
              </>
            )}
          </p>

          <div className="mm-boundary__actions">
            <button
              type="button"
              className="mm-btn mm-btn-primary"
              autoFocus
              onClick={this.handleRetry}
            >
              다시 시도
            </button>
            <button
              type="button"
              className="mm-btn"
              title={
                savedAt === null
                  ? '지금 작업이 사라집니다. [다시 시도] 를 먼저 눌러 보세요.'
                  : '자동 저장된 시점으로 되살립니다.'
              }
              onClick={this.handleReload}
            >
              새로고침
            </button>
          </div>

          {/* 에러 원문은 기본으로 접어 둔다. 펼치면 그대로 복사할 수 있다. */}
          <details className="mm-boundary__details">
            <summary>에러 내용 보기</summary>
            <pre className="mm-boundary__pre">
              {`${error.name}: ${error.message}`}
              {componentStack ? `\n${componentStack}` : ''}
            </pre>
          </details>
        </div>
      </div>
    )
  }
}

/**
 * key 를 붙이기 위한 껍데기. Fragment 에는 key 를 붙일 수 있지만
 * 이름이 있는 편이 React DevTools 에서 훨씬 읽기 쉽다.
 */
function ErrorBoundaryScope({ children }: { children: ReactNode }): ReactNode {
  return <>{children}</>
}

export default ErrorBoundary
