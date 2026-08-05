/**
 * 비정상 종료 복구 배너.
 *
 * 모달이 아니다. 앱을 막아서는 안 된다. 복구는 선택이고, 무시하면 사용자는
 * 새 작업을 이어서 한다. 모달로 만들면 배너 하나 때문에 앱이 열리지 않는 것처럼 보인다.
 *
 * 스타일은 app.css 의 .mm-banner 를 그대로 쓴다. 이 배너에만 필요한 버튼 묶음만
 * 인라인으로 둔다.
 */

import { useEffect, useState } from 'react'

import { useDocumentStore } from '@/state/document.ts'
import { dismissRecovery, hasRecovery, restoreRecovery, type RecoveryInfo } from '@/state/persistence.ts'

function relativeTime(at: number): string {
  const diff = Math.max(0, Date.now() - at)
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return '방금 전'
  if (minutes < 60) return `${minutes}분 전`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}시간 전`
  return `${Math.floor(hours / 24)}일 전`
}

export function RecoveryBanner() {
  const [info, setInfo] = useState<RecoveryInfo | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  /**
   * 이미 이 세션에서 작업을 시작했으면 배너를 내린다.
   * 복구는 문서를 통째로 갈아 끼우므로, 방금 넣은 이미지를 날려 버릴 수 있다.
   */
  const hasWorkNow = useDocumentStore((s) => s.doc.layers.length > 0)

  useEffect(() => {
    let alive = true
    void hasRecovery().then((found) => {
      if (alive) setInfo(found)
    })
    return () => {
      alive = false
    }
  }, [])

  if (!info) return null
  if (hasWorkNow && !error) return null

  const onRestore = (): void => {
    setBusy(true)
    setError(null)
    // 배너가 안내한 그 스냅샷으로만 되돌린다. 그 사이 자동저장이 쌓은 빈 스냅샷을
    // 집으면 "레이어 5장" 이라고 알려 놓고 빈 문서로 덮어쓰게 된다.
    void restoreRecovery(info.id).then((ok) => {
      setBusy(false)
      if (ok) setInfo(null)
      else setError('작업을 복구하지 못했습니다. 저장된 데이터가 손상된 것 같습니다.')
    })
  }

  const onDismiss = (): void => {
    setInfo(null)
    void dismissRecovery()
  }

  return (
    <div className={error ? 'mm-banner is-error' : 'mm-banner'} role="status">
      <span className="mm-banner-text">
        {error ??
          `이전 작업이 남아 있습니다 (레이어 ${info.layerCount}장, ${relativeTime(info.at)}). 복구할까요?`}
      </span>
      <span style={{ display: 'flex', gap: 'var(--sp-2, 8px)', flexShrink: 0 }}>
        <button type="button" className="mm-btn mm-btn-primary" onClick={onRestore} disabled={busy}>
          {busy ? '복구 중' : '복구'}
        </button>
        <button type="button" className="mm-btn" onClick={onDismiss} disabled={busy}>
          무시
        </button>
      </span>
    </div>
  )
}

export default RecoveryBanner
