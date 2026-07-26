/**
 * 하단 상태 표시줄.
 *
 * 여기 있는 값들은 전부 "지금 어디에 있고, 무엇을 만들고 있고, 잃을 것이 있는가" 다.
 * 조작하는 곳이 아니다. 그래서 버튼을 두지 않는다. 상태 표시줄에 버튼이 하나 생기면
 * 곧 다섯 개가 되고 툴바가 두 개인 앱이 된다.
 *
 * 밀도가 높아 글자가 작다. 그래서 색을 더 죽이면 안 된다.
 * 라벨과 값 모두 --text-muted 이상만 쓴다.
 *   --text-muted 대 --surface : 다크 8.2:1, 라이트 7.6:1
 *   --warn       대 --surface : 다크 10.2:1, 라이트 5.2:1
 * 전부 WCAG 2.2 AA 본문 기준(4.5:1)을 넘는다. --text-faint 는 글자에 쓰지 않는다.
 * 구분선(--border)만 그 아래 대비인데, 그건 장식이라 1.4.11 대상이 아니다.
 *
 * 낭독기: 이 줄 전체를 live 영역으로 만들지 않는다. 재생 중 프레임 숫자가 초당
 * 열 번 바뀌는데 그걸 전부 읽으면 낭독기가 다른 말을 할 수 없다. 평범한
 * <footer> 영역으로 두어 사용자가 원할 때 훑어 읽게 한다.
 * 다만 오버스캔 경고가 **새로 생기는 순간** 은 화면 밖 변화라서 한 번만 알린다.
 */

import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react'

import { diagnose, solveLayerOverscan } from '@/core/overscan.ts'
import { formatBytes } from '@/export/estimate.ts'
import { exportFrames } from '@/export/pipeline.ts'
import { useDocumentStore } from '@/state/document.ts'
import { getAutosaveStatus, subscribeAutosave } from '@/state/persistence.ts'
import { useUiStore } from '@/state/ui.ts'
import { announce, announceFailure } from '@/ui/a11y/announce.ts'

const STATUS_CSS = `
.mm-status {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  flex: 0 0 auto;
  height: 26px;
  padding: 0 var(--sp-4);
  border-top: 1px solid var(--border);
  background: var(--surface);
  color: var(--text-muted);
  font-size: var(--fs-xs);
  line-height: 1;
  white-space: nowrap;
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: none;
}

.mm-status::-webkit-scrollbar {
  display: none;
}

.mm-status__item {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-1);
  flex: none;
}

.mm-status__label {
  color: var(--text-muted);
}

.mm-status__value {
  color: var(--text);
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
}

.mm-status__sep {
  flex: none;
  width: 1px;
  height: 12px;
  background: var(--border);
}

.mm-status__spacer {
  flex: 1 1 auto;
  min-width: var(--sp-3);
}

/* 경고는 색만으로 구분하지 않는다. 왼쪽 겹선 + 굵기까지 함께 바꾼다. */
.mm-status__warn {
  flex: none;
  padding: 0 var(--sp-2);
  border-left: 4px double var(--warn);
  color: var(--warn);
  font-weight: 700;
}

.mm-status__save {
  flex: none;
  color: var(--text-muted);
}

.mm-status__save.is-none {
  border-left: 4px double var(--warn);
  padding-left: var(--sp-2);
  color: var(--warn);
  font-weight: 700;
}
`

// ---------------------------------------------------------------------------
// 어림 계산
// ---------------------------------------------------------------------------

/*
 * 실제 용량은 export/estimate.ts 가 8프레임을 진짜로 인코딩해서 잰다.
 * 그건 GL 을 쓰고 수백 ms 가 걸린다. 상태 표시줄이 그걸 계속 돌릴 수는 없다.
 *
 * 여기서는 산술만 한다. 정확도를 포기하는 대신 **자릿수** 를 맞춘다.
 * "이게 3MB 짜리인가 300KB 짜리인가" 만 알면 상태 표시줄의 몫은 끝난다.
 * 진짜 숫자는 내보내기 다이얼로그가 보여 준다. 그래서 문구에도 '대략' 을 붙이고,
 * ExportDialog 가 잰 값이 있으면 estimateBytes 로 받아서 그쪽을 우선한다.
 */

/** 첫 프레임은 전체 그림이라 압축이 덜 먹는다. */
const FIRST_FRAME_RATIO = 0.3
/** 이후 프레임은 앞 프레임과의 차이만 남는다. 움직임이 클수록 이 값이 커진다. */
const DELTA_FRAME_RATIO = 0.12

export function roughApngBytes(width: number, height: number, frameCount: number): number {
  const raw = Math.max(1, width) * Math.max(1, height) * 4
  const frames = Math.max(1, frameCount)
  return Math.round(raw * (FIRST_FRAME_RATIO + (frames - 1) * DELTA_FRAME_RATIO))
}

/** "12초 전" / "3분 전" / "2시간 전". ErrorBoundary 와 같은 규칙이다. */
export function relativeTime(from: number, now: number): string {
  const sec = Math.max(0, Math.round((now - from) / 1000))
  if (sec < 60) return `${sec}초 전`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}분 전`
  return `${Math.floor(min / 60)}시간 전`
}

/**
 * 오버스캔 진단을 도는 최대 레이어 수.
 * solveLayerOverscan 은 레이어마다 240 샘플을 돈다(overscan.ts). 문서가 바뀔 때만
 * 다시 계산하지만, 레이어가 수십 장이면 그 한 번도 눈에 보이게 멈춘다.
 * 상태 표시줄의 요약 한 줄 때문에 편집이 끊기면 안 된다.
 */
const OVERSCAN_LAYER_BUDGET = 12

// ---------------------------------------------------------------------------
// 조각들
// ---------------------------------------------------------------------------

/**
 * 재생 헤드만 따로 구독한다.
 *
 * 재생 중 이 값은 100ms 마다 바뀐다(useRenderer). 상태 표시줄 본체가 그때마다
 * 리렌더되면 오버스캔 useMemo 의 의존성 비교까지 초당 열 번씩 돈다.
 * Timeline 의 PlayheadReadout 과 같은 이유, 같은 방법이다.
 */
function FrameReadout({ total }: { total: number }): ReactNode {
  const frame = useUiStore((s) => s.playheadFrame)
  return (
    <span className="mm-status__item">
      <span className="mm-status__label">프레임</span>
      <span className="mm-status__value">
        {frame + 1}/{total}
      </span>
    </span>
  )
}

/** 저장 시각은 스스로 늙는다. 문서가 안 바뀌어도 글자는 계속 갱신되어야 한다. */
function SaveReadout({
  savedAt,
  saving,
  error,
}: {
  savedAt: number | null
  saving: boolean
  error: string | null
}): ReactNode {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (savedAt === null) return
    // 5초면 "3초 전" 과 "8초 전" 사이의 거짓말이 충분히 짧다.
    const timer = setInterval(() => setNow(Date.now()), 5000)
    return () => clearInterval(timer)
  }, [savedAt])

  // savedAt 이 바뀌면 다음 틱을 기다리지 않고 바로 맞춘다.
  useEffect(() => {
    setNow(Date.now())
  }, [savedAt])

  /*
   * 저장 실패는 조용히 지나가면 안 된다.
   * 상태 표시줄은 알리는 자리까지가 몫이다. .mmproj 내려받기 권유는
   * 전용 배너가 할 일이라 여기서 버튼을 만들지 않는다.
   */
  if (error !== null) {
    return (
      <span className="mm-status__save is-none" title={error}>
        저장 실패
      </span>
    )
  }

  if (saving) return <span className="mm-status__save">저장 중</span>

  if (savedAt === null) {
    // 아직 한 번도 저장되지 않았다. 저장된 척하지 않는다.
    return (
      <span
        className="mm-status__save is-none"
        title="아직 자동 저장된 적이 없습니다. 지금 탭을 닫으면 작업이 사라집니다."
      >
        저장 안 됨
      </span>
    )
  }

  return <span className="mm-status__save">{relativeTime(savedAt, now)} 저장</span>
}

// ---------------------------------------------------------------------------

export interface StatusBarProps {
  /**
   * 마지막 자동저장 시각 (epoch ms) 을 밖에서 정할 때만 준다.
   *
   * **주지 않으면 state/persistence.ts 를 직접 구독한다.** 그게 기본이다.
   * 부모가 같은 값을 한 번 더 들고 내려오면 두 값이 어긋나는 순간이 생기고,
   * 그때 화면은 "3초 전 저장" 이라 말하면서 실제로는 저장에 실패해 있다.
   * null 을 명시적으로 주면 "저장된 적 없음" 으로 강제한다(테스트용).
   */
  savedAt?: number | null
  /**
   * 내보내기 다이얼로그가 실제로 잰 용량 (바이트).
   * 있으면 어림 계산 대신 이 값을 쓴다.
   */
  estimateBytes?: number | null
}

export function StatusBar({ savedAt, estimateBytes = null }: StatusBarProps): ReactNode {
  const doc = useDocumentStore((s) => s.doc)

  // 자동저장 상태. persistence 가 useSyncExternalStore 규약으로 낸다.
  const autosave = useSyncExternalStore(subscribeAutosave, getAutosaveStatus, getAutosaveStatus)
  const overridden = savedAt !== undefined
  const effectiveSavedAt = overridden ? savedAt : autosave.at > 0 ? autosave.at : null
  const saveError = overridden ? null : autosave.state === 'error' ? autosave.message : null
  const saving = !overridden && autosave.state === 'saving'

  // 저장 실패는 화면 구석의 작은 글자로만 알리면 낭독기 사용자에게 도달하지 않는다.
  useEffect(() => {
    if (saveError === null) return
    announceFailure(`자동 저장에 실패했습니다. ${saveError}`)
  }, [saveError])

  const canvasW = doc.canvas.w
  const canvasH = doc.canvas.h
  const layerCount = doc.layers.length

  // 내보낼 실제 프레임 수. 왕복이나 경계 중복 제거 때문에 durationFrames 와 다르다.
  const frameCount = useMemo(() => exportFrames(doc).length, [doc])
  const totalFrames = Math.max(1, doc.timeline.durationFrames)

  const bytes = estimateBytes ?? roughApngBytes(canvasW, canvasH, frameCount)
  const approximate = estimateBytes === null

  /**
   * 오버스캔 경고 요약.
   * 원인이 아니라 개수만 말한다. 처방은 인스펙터의 레이어 관계 섹션에 있다.
   */
  const overscan = useMemo(() => {
    if (doc.layers.length > OVERSCAN_LAYER_BUDGET) return { warn: 0, notice: 0, skipped: true }
    let warn = 0
    let notice = 0
    for (const layer of doc.layers) {
      if (!layer.assetId) continue
      const asset = doc.assets.find((a) => a.id === layer.assetId)
      if (!asset) continue
      const need = solveLayerOverscan(doc, layer, asset.naturalW, asset.naturalH)
      const level = diagnose(need, Math.max(asset.naturalW, asset.naturalH)).level
      if (level === 'warn') warn += 1
      else if (level === 'notice') notice += 1
    }
    return { warn, notice, skipped: false }
  }, [doc])

  /**
   * 경고가 **새로 생긴** 순간만 알린다.
   * 이건 화면 밖 변화다. 프리셋을 하나 골랐더니 이미지가 흐려질 수 있다는 사실을
   * 낭독기 사용자는 알 방법이 없다.
   */
  useEffect(() => {
    if (overscan.warn <= 0) return
    announce(
      `${overscan.warn}개 이미지의 원본이 이 움직임에 비해 작습니다. 인스펙터의 레이어 관계에서 확인할 수 있습니다.`,
    )
  }, [overscan.warn])

  const warnLabel = overscan.skipped
    ? null
    : overscan.warn > 0
      ? `원본 작음 ${overscan.warn}`
      : overscan.notice > 0
        ? `가장자리 주의 ${overscan.notice}`
        : null

  return (
    <footer className="mm-status" aria-label="상태">
      <style href="mm-status-bar" precedence="default">
        {STATUS_CSS}
      </style>

      <FrameReadout total={totalFrames} />

      <span className="mm-status__sep" aria-hidden="true" />

      <span className="mm-status__item">
        <span className="mm-status__label">캔버스</span>
        <span className="mm-status__value">
          {canvasW}x{canvasH}
        </span>
      </span>

      <span className="mm-status__sep" aria-hidden="true" />

      <span className="mm-status__item">
        <span className="mm-status__label">레이어</span>
        <span className="mm-status__value">{layerCount}</span>
      </span>

      <span className="mm-status__sep" aria-hidden="true" />

      <span
        className="mm-status__item"
        title={
          approximate
            ? '가로x세로x프레임 수로 계산한 어림값입니다(APNG 기준). 정확한 값은 내보내기 화면에서 실제로 재 봅니다.'
            : '내보내기 화면에서 실제로 잰 값입니다.'
        }
      >
        <span className="mm-status__label">예상 용량</span>
        <span className="mm-status__value">
          {approximate ? '약 ' : ''}
          {formatBytes(bytes)}
        </span>
      </span>

      {warnLabel ? (
        <>
          <span className="mm-status__sep" aria-hidden="true" />
          <span className="mm-status__warn">{warnLabel}</span>
        </>
      ) : null}

      <span className="mm-status__spacer" />

      <SaveReadout savedAt={effectiveSavedAt} saving={saving} error={saveError} />
    </footer>
  )
}

export default StatusBar
