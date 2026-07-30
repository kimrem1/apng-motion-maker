/**
 * 내보내기 다이얼로그.
 *
 * 1차 선택은 포맷이 아니라 **용도**다. 용도가 포맷 + 크기 + fps + 용량 상한을 함께
 * 결정하므로 GIF 의 1비트 투명 같은 제약이 "설명" 이 아니라 "선택지 배제" 가 된다.
 *
 * 두 번째 1급 컨트롤은 **목표 용량 맞추기**다. 사용자는 해상도 / 프레임 수 /
 * 색상 수 / 압축 파라미터가 서로 어떻게 작용하는지 모른다. "2MB 이하로" 를 누르면
 * 도구가 영향이 큰 순서로 조정하고, **무엇을 얼마나 희생했는지 조정 전후로 나란히** 보여준다.
 *
 * 진행 표시는 모달을 하나 더 띄우지 않는다. 내보내기 버튼 자체가 프로그레스로 변한다.
 * 결과 확인도 같은 모달 안에서 본문만 바뀐다.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  // DOM 의 KeyboardEvent 와 이름이 겹친다. 아래에서 둘 다 쓴다.
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react'

import { CANVAS_MAX, CANVAS_MIN, FPS_CHOICES, FRAMES_MAX } from '@/core/types.ts'
import { isGifExactFps } from '@/core/time.ts'
import { exportFrames, type ExportFormat, type ExportSettings } from '@/export/pipeline.ts'
import {
  estimateExportSize,
  formatBytes,
  formatEstimate,
  type SizeEstimate,
} from '@/export/estimate.ts'
import { planForTargetSize } from '@/export/targetSize.ts'
import { isWebpSupported } from '@/export/webp/encoder.ts'
import { useDocumentStore } from '@/state/document.ts'
import { getActiveRenderer } from '@/ui/canvas/rendererHandle.ts'
import { NumberField, SelectField, ToggleField } from '@/ui/widgets/Field.tsx'
import { BrowserSupport } from './BrowserSupport.tsx'
import { ResultPanel } from './ResultPanel.tsx'
import { useExport } from './useExport.ts'
import {
  DEFAULT_PURPOSE_ID,
  EXPORT_PURPOSES,
  MAX_COLOR_CHOICES,
  PURPOSE_BY_ID,
  SLOW_EXPORT_SEC,
  SPEC_CHECKED_AT,
  SPEC_NOTE,
  WEBP_QUALITY_DEFAULT,
  WEBP_QUALITY_MIN,
  WEIGHT_LABELS,
  estimateDurationSec,
  fitWithin,
  formatDuration,
  settingsForPurpose,
  type ExportPurpose,
  type ExportPurposeId,
} from './exportSettings.ts'

import './export.css'

/** 용량 추정은 8프레임을 실제로 인코딩한다. 설정을 만질 때마다 돌면 다이얼로그가 버벅인다. */
const ESTIMATE_DEBOUNCE_MS = 300

/** tabindex="-1" 은 전부 제외한다. 저장 폴백용 숨은 앵커가 트랩에 잡히면 안 된다. */
const FOCUSABLE =
  'a[href]:not([tabindex="-1"]), button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

const MB = 1024 * 1024

/** 목표 용량 입력 기본값(MB). 메신저 프리셋 상한과 같은 값이다. */
const DEFAULT_TARGET_MB = 2

const FORMAT_OPTIONS: readonly {
  value: ExportFormat
  label: string
  hint: string
}[] = [
  { value: 'apng', label: 'APNG', hint: '반투명 그대로' },
  { value: 'webp', label: 'WebP', hint: '반투명 그대로, 가장 작음' },
  { value: 'gif', label: 'GIF', hint: '어디서나 열림' },
]

/**
 * 목표 용량 계획기가 돌려주는 changes 를 화면용 줄로 바꾼다.
 *
 * unknown 을 받는 이유는 계획기가 문자열 목록을 주든 {label, from, to} 목록을 주든
 * UI 가 깨지지 않게 하기 위해서다. 여기서 형태를 흡수해 두면 계획기 쪽 표현이 바뀌어도
 * 다이얼로그를 고칠 일이 없다.
 */
interface ChangeLine {
  label: string
  from: string
  to: string
  text: string
}

function toChangeLine(raw: unknown): ChangeLine | null {
  if (typeof raw === 'string') {
    return raw.trim().length > 0 ? { label: '', from: '', to: '', text: raw } : null
  }
  if (raw !== null && typeof raw === 'object') {
    const o = raw as Record<string, unknown>
    const label = typeof o['label'] === 'string' ? o['label'] : ''
    const from = o['from'] === undefined || o['from'] === null ? '' : String(o['from'])
    const to = o['to'] === undefined || o['to'] === null ? '' : String(o['to'])
    if (label.length > 0 && from.length > 0 && to.length > 0) {
      return { label, from, to, text: `${label} ${from} -> ${to}` }
    }
    const text = [label, from, to].filter((s) => s.length > 0).join(' ')
    return text.length > 0 ? { label, from, to, text } : null
  }
  return null
}

type SizePlan = Awaited<ReturnType<typeof planForTargetSize>>

export interface ExportDialogProps {
  open: boolean
  onClose(): void
}

export function ExportDialog({ open, onClose }: ExportDialogProps) {
  const doc = useDocumentStore((s) => s.doc)

  const { ready, busy, progress, result, error, start, cancel, reset } = useExport()

  const [purposeId, setPurposeId] = useState<ExportPurposeId>(DEFAULT_PURPOSE_ID)
  const [custom, setCustom] = useState<ExportSettings>(() =>
    settingsForPurpose(
      PURPOSE_BY_ID.get(DEFAULT_PURPOSE_ID) ?? EXPORT_PURPOSES[0]!,
      doc.canvas.w,
      doc.canvas.h,
    ),
  )
  const [estimate, setEstimate] = useState<SizeEstimate | null>(null)
  const [estimating, setEstimating] = useState(false)

  // 목표 용량 맞추기
  const [targetOn, setTargetOn] = useState(false)
  const [targetMb, setTargetMb] = useState(DEFAULT_TARGET_MB)
  const [plan, setPlan] = useState<SizePlan | null>(null)
  const [planning, setPlanning] = useState(false)
  const [planError, setPlanError] = useState<string | null>(null)
  const planAbortRef = useRef<AbortController | null>(null)

  /**
   * 다이얼로그를 다시 열면 지난 결과를 버린다.
   *
   * 안 버리면 문서를 고친 뒤 다시 열었을 때 편집 전 결과가 그대로 뜨고
   * [저장] 이 낡은 파일을 저장한다. 렌더 중에 맞추므로 낡은 결과가 한 프레임도
   * 그려지지 않는다 (effect 로 하면 한 번 그려진 뒤에 사라진다).
   */
  const [lastOpen, setLastOpen] = useState(open)
  if (open !== lastOpen) {
    setLastOpen(open)
    if (open) reset()
  }

  const cardRef = useRef<HTMLDivElement | null>(null)

  const webpUsable = isWebpSupported()

  const purpose = PURPOSE_BY_ID.get(purposeId) ?? EXPORT_PURPOSES[0]!
  const isCustom = purpose.custom === true

  const baseSettings: ExportSettings = useMemo(
    () => (isCustom ? custom : settingsForPurpose(purpose, doc.canvas.w, doc.canvas.h)),
    [isCustom, custom, purpose, doc.canvas.w, doc.canvas.h],
  )
  const settingsKey = JSON.stringify(baseSettings)

  /**
   * 기준 설정이 바뀌면 계획은 즉시 버린다.
   *
   * 계획은 "지금 설정에서 이만큼 깎으면 목표에 든다" 는 상대적인 답이다.
   * 기준이 바뀐 뒤에도 남아 있으면 화면의 조정 전 열과 실제 기준이 어긋나
   * 사용자가 잘못된 비교를 보고 결정하게 된다.
   */
  const [lastSettingsKey, setLastSettingsKey] = useState(settingsKey)
  if (settingsKey !== lastSettingsKey) {
    setLastSettingsKey(settingsKey)
    if (plan) setPlan(null)
    if (planError) setPlanError(null)
  }

  /** 실제로 내보낼 설정. 계획을 적용했으면 계획 쪽이 이긴다. */
  const effective: ExportSettings = plan ? plan.settings : baseSettings

  const frameCount = useMemo(() => exportFrames(doc).length, [doc])
  const plannedFrameCount = useMemo(() => {
    if (!plan) return frameCount
    return exportFrames({
      ...doc,
      timeline: { ...doc.timeline, fps: plan.fps, durationFrames: plan.durationFrames },
    }).length
  }, [plan, doc, frameCount])

  const hasLayers = doc.layers.length > 0
  const durationSec = estimateDurationSec(
    plannedFrameCount,
    effective.width,
    effective.height,
    effective.format,
  )

  // -------------------------------------------------------------------------
  // 용량 추정
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (!open || busy || !ready || !hasLayers || result) return
    if (baseSettings.format === 'png-sequence') return

    let cancelled = false
    const controller = new AbortController()

    // 설정이 바뀌었는데 옛 숫자가 남아 있으면 그게 새 설정의 값인 줄 알게 된다.
    setEstimate(null)

    const timer = setTimeout(() => {
      const handle = getActiveRenderer()
      if (!handle) return
      setEstimating(true)
      estimateExportSize({
        doc,
        renderer: handle.renderer,
        assets: handle.getAssets(),
        settings: baseSettings,
        signal: controller.signal,
      })
        .then((next) => {
          if (!cancelled) setEstimate(next)
        })
        .catch(() => {
          // 추정 실패는 치명적이지 않다. 숫자를 감추고 계속 진행한다.
          if (!cancelled) setEstimate(null)
        })
        .finally(() => {
          if (!cancelled) setEstimating(false)
        })
    }, ESTIMATE_DEBOUNCE_MS)

    return () => {
      cancelled = true
      controller.abort()
      clearTimeout(timer)
      // 중단된 추정은 finally 의 cancelled 가드에 막혀 플래그를 못 내린다. 여기서 내린다.
      setEstimating(false)
    }
    // settings 객체는 매 렌더 새로 만들어진다. 참조가 아니라 settingsKey 로 값을 비교한다.
  }, [open, busy, ready, hasLayers, result, doc, baseSettings, settingsKey])

  // -------------------------------------------------------------------------
  // 모달 동작
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (!open) return
    cardRef.current?.focus()
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      // 내보내는 중에 Esc 로 닫히면 진행 중인 작업을 잃는다. 취소를 먼저 누르게 한다.
      if (busy) return
      onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
    }
  }, [open, busy, onClose])

  // 다이얼로그가 사라질 때 돌고 있던 계획 계산을 놓아 준다.
  useEffect(
    () => () => {
      planAbortRef.current?.abort()
    },
    [],
  )

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
    if (plan) {
      void start(plan.settings, {
        applyTimeline: { fps: plan.fps, durationFrames: plan.durationFrames },
      })
      return
    }
    void start(baseSettings)
  }

  /** 재인코딩. 설정만 바꾸므로 문서는 그대로다. */
  const handleReencode = (next: ExportSettings): void => {
    setPurposeId('custom')
    setCustom(next)
    setPlan(null)
    reset()
    void start(next)
  }

  const lowerFps = [...FPS_CHOICES].filter((f) => f < doc.timeline.fps).pop()

  /**
   * fps 를 낮추면 문서가 바뀐다(undo 대상).
   * 지속시간을 유지하려면 프레임 수도 같이 줄여야 한다. 안 그러면 애니메이션이 느려진다.
   * 문서 변경과 내보내기 시작은 useExport 안에서 한 덩어리로 처리한다.
   */
  const handleLowerFps = (): void => {
    if (lowerFps === undefined || !result) return
    const scale = lowerFps / doc.timeline.fps
    const nextFrames = Math.min(
      FRAMES_MAX,
      Math.max(1, Math.round(doc.timeline.durationFrames * scale)),
    )
    const next = result.settings
    reset()
    void start(next, { applyTimeline: { fps: lowerFps, durationFrames: nextFrames } })
  }

  const setLongestEdge = (px: number): void => {
    const clamped = Math.min(CANVAS_MAX, Math.max(CANVAS_MIN, Math.round(px)))
    const fitted = fitWithin(doc.canvas.w, doc.canvas.h, clamped)
    setCustom((prev) => ({ ...prev, ...fitted }))
  }

  /** 목표 용량 계획 실행. */
  const handlePlan = async (): Promise<void> => {
    const handle = getActiveRenderer()
    if (!handle) {
      setPlanError('미리보기가 아직 준비되지 않아 계산할 수 없습니다.')
      return
    }
    planAbortRef.current?.abort()
    const controller = new AbortController()
    planAbortRef.current = controller

    setPlanning(true)
    setPlanError(null)
    try {
      // 객체 리터럴을 바로 넘기지 않는다. 계획기 쪽 인자 타입이 늘어나도 여기가 안 깨진다.
      const planArgs = {
        doc,
        renderer: handle.renderer,
        assets: handle.getAssets(),
        settings: baseSettings,
        targetBytes: Math.max(1, Math.round(targetMb * MB)),
        signal: controller.signal,
      }
      const next = await planForTargetSize(planArgs)
      if (controller.signal.aborted) return
      setPlan(next)
    } catch (err) {
      if (controller.signal.aborted) return
      setPlanError(err instanceof Error ? err.message : '목표 용량을 맞추지 못했습니다.')
    } finally {
      if (planAbortRef.current === controller) planAbortRef.current = null
      setPlanning(false)
    }
  }

  if (!open) return null

  // -------------------------------------------------------------------------
  // 프리셋 가용성
  // -------------------------------------------------------------------------
  const purposeAvailable = (p: ExportPurpose): boolean =>
    p.available && (p.format !== 'webp' || webpUsable)

  const purposeReason = (p: ExportPurpose): string => {
    if (p.format === 'webp' && !webpUsable) {
      return '이 브라우저에서는 WebP 를 만들 수 없습니다. "메신저로 보내기"(GIF)를 대신 고르세요.'
    }
    return p.unavailableReason ?? '아직 준비 중입니다'
  }

  // -------------------------------------------------------------------------
  // 경고
  // -------------------------------------------------------------------------
  const isGif = effective.format === 'gif'
  const isWebp = effective.format === 'webp'
  const gifFpsInexact = isGif && !isGifExactFps(plan ? plan.fps : doc.timeline.fps)
  const fpsTooHigh = !isCustom && !plan && doc.timeline.fps > purpose.fps
  const overBudget =
    !plan && purpose.maxBytes > 0 && estimate !== null && estimate.maxBytes > purpose.maxBytes
  const slow = durationSec > SLOW_EXPORT_SEC

  // 결과를 만든 뒤 문서가 바뀌었는가. immer 라 참조 비교로 충분하다.
  const stale = result !== null && result.sourceDoc !== doc

  const percent = progress ? Math.min(100, Math.max(0, Math.round(progress.done))) : 0
  const longestEdge = Math.max(baseSettings.width, baseSettings.height)
  const quality = baseSettings.quality ?? WEBP_QUALITY_DEFAULT
  const lossless = baseSettings.lossless === true

  const changeLines = plan
    ? (plan.changes as unknown[]).map(toChangeLine).filter((c): c is ChangeLine => c !== null)
    : []

  /** 조정 전후 나란히 비교. changes 표현과 무관하게 우리가 직접 만든다. */
  const comparison: { label: string; before: string; after: string; same: boolean }[] = plan
    ? [
        {
          label: '크기',
          before: `${baseSettings.width} x ${baseSettings.height}`,
          after: `${plan.settings.width} x ${plan.settings.height}`,
          same:
            baseSettings.width === plan.settings.width &&
            baseSettings.height === plan.settings.height,
        },
        {
          label: '속도',
          before: `${doc.timeline.fps}fps`,
          after: `${plan.fps}fps`,
          same: doc.timeline.fps === plan.fps,
        },
        {
          label: '프레임',
          before: `${frameCount}장`,
          after: `${plannedFrameCount}장`,
          same: frameCount === plannedFrameCount,
        },
        {
          label: '색상',
          before: `${baseSettings.maxColors}색`,
          after: `${plan.settings.maxColors}색`,
          same:
            baseSettings.maxColors === plan.settings.maxColors ||
            plan.settings.format !== 'gif',
        },
        {
          label: '예상 용량',
          before: estimate ? formatEstimate(estimate) : '알 수 없음',
          after: formatBytes(plan.estimatedBytes),
          same: false,
        },
      ].filter((row) => !row.same || row.label === '예상 용량')
    : []

  return (
    <div className="mm-modal-scrim" role="presentation">
      <div
        ref={cardRef}
        className="mm-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="mm-export-title"
        tabIndex={-1}
        onKeyDown={handleCardKeyDown}
      >
        <header className="mm-modal-head">
          <h2 id="mm-export-title" className="mm-modal-title">
            {result ? '완성' : '내보내기'}
          </h2>
          <button
            type="button"
            className="mm-icon-btn"
            aria-label="닫기"
            disabled={busy}
            onClick={onClose}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
              <path
                d="M3 3l8 8M11 3l-8 8"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </header>

        <div className="mm-modal-body mm-scroll">
          {result ? (
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
          ) : (
            <>
              <fieldset className="mm-fieldset mm-section">
                <legend className="mm-section-title">어디에 쓰실 건가요?</legend>
                <div className="mm-purpose-list">
                  {EXPORT_PURPOSES.map((p) => {
                    const disabled = !purposeAvailable(p)
                    return (
                      <label
                        key={p.id}
                        className={disabled ? 'mm-purpose is-disabled' : 'mm-purpose'}
                        data-selected={purposeId === p.id}
                      >
                        <input
                          type="radio"
                          name="mm-export-purpose"
                          value={p.id}
                          checked={purposeId === p.id}
                          disabled={disabled || busy}
                          onChange={() => {
                            setPurposeId(p.id)
                            if (p.custom) {
                              setCustom(settingsForPurpose(p, doc.canvas.w, doc.canvas.h))
                            }
                          }}
                        />
                        <span className="mm-purpose-text">
                          <span className="mm-purpose-label">
                            {p.label}
                            {p.formatLabel ? (
                              <span className="mm-purpose-format">{p.formatLabel}</span>
                            ) : null}
                            {/* 용량 등급은 고르기 전에 기대를 맞추는 장치다. */}
                            {p.weight ? (
                              <span className="mm-purpose-weight" data-weight={p.weight}>
                                {WEIGHT_LABELS[p.weight]}
                              </span>
                            ) : null}
                          </span>
                          <span className="mm-purpose-desc">
                            {disabled ? purposeReason(p) : p.description}
                          </span>
                        </span>
                      </label>
                    )
                  })}
                </div>
                <p className="mm-note mm-spec-note">
                  {SPEC_NOTE} (규격 확인일 {SPEC_CHECKED_AT})
                </p>
              </fieldset>

              {isCustom ? (
                <section className="mm-section">
                  <h3 className="mm-section-title">세부 설정</h3>

                  <fieldset className="mm-fieldset">
                    <legend className="mm-field-label">파일 형식</legend>
                    <div className="mm-radio-row">
                      {FORMAT_OPTIONS.map((f) => {
                        const blocked = f.value === 'webp' && !webpUsable
                        return (
                          <label key={f.value} className="mm-radio">
                            <input
                              type="radio"
                              name="mm-export-format"
                              checked={baseSettings.format === f.value}
                              disabled={blocked || busy}
                              onChange={() => {
                                setCustom((prev) => ({ ...prev, format: f.value }))
                              }}
                            />
                            <span>
                              {f.label}
                              <span className="mm-purpose-desc">
                                {' '}
                                {blocked ? '이 브라우저에서는 만들 수 없습니다' : f.hint}
                              </span>
                            </span>
                          </label>
                        )
                      })}
                    </div>
                  </fieldset>

                  <div className="mm-stack mm-custom-grid">
                    <NumberField
                      label="긴 변 크기"
                      value={longestEdge}
                      min={CANVAS_MIN}
                      max={CANVAS_MAX}
                      step={16}
                      suffix="px"
                      disabled={busy}
                      onChange={setLongestEdge}
                    />

                    {baseSettings.format === 'gif' ? (
                      <SelectField
                        label="색상 수"
                        value={String(baseSettings.maxColors)}
                        options={MAX_COLOR_CHOICES.map((c) => ({
                          value: String(c),
                          label: `${c}색`,
                        }))}
                        disabled={busy}
                        hint="적을수록 파일이 작아지고 색 경계가 거칠어집니다."
                        onChange={(v) => {
                          setCustom((prev) => ({ ...prev, maxColors: Number(v) }))
                        }}
                      />
                    ) : null}

                    {baseSettings.format === 'gif' ? (
                      <div className="mm-field">
                        <label className="mm-field-label" htmlFor="mm-export-dither">
                          디더 세기
                        </label>
                        <input
                          id="mm-export-dither"
                          className="mm-range"
                          type="range"
                          min={0}
                          max={1}
                          step={0.1}
                          value={baseSettings.dither}
                          disabled={busy}
                          onChange={(e) => {
                            setCustom((prev) => ({ ...prev, dither: Number(e.target.value) }))
                          }}
                        />
                        <p className="mm-field-hint">
                          {baseSettings.dither === 0
                            ? '끔. 색 경계가 띠처럼 보일 수 있습니다.'
                            : `${Math.round(baseSettings.dither * 100)}%. 그라데이션이 부드러워지는 대신 파일이 커집니다.`}
                        </p>
                      </div>
                    ) : null}

                    {/* WebP 는 손실 압축 강도를 직접 정한다. 무손실이면 이 값은 무시된다. */}
                    {baseSettings.format === 'webp' ? (
                      <div className="mm-field">
                        <label className="mm-field-label" htmlFor="mm-export-quality">
                          화질
                        </label>
                        <input
                          id="mm-export-quality"
                          className="mm-range"
                          type="range"
                          min={WEBP_QUALITY_MIN}
                          max={1}
                          step={0.01}
                          value={quality}
                          disabled={busy || lossless}
                          onChange={(e) => {
                            setCustom((prev) => ({ ...prev, quality: Number(e.target.value) }))
                          }}
                        />
                        <p className="mm-field-hint">
                          {lossless
                            ? '무손실이 켜져 있어 이 값은 쓰이지 않습니다.'
                            : `${Math.round(quality * 100)}%. 낮추면 파일이 작아지는 대신 또렷한 가장자리에 얼룩이 생깁니다.`}
                        </p>
                      </div>
                    ) : null}

                    {baseSettings.format === 'webp' ? (
                      <ToggleField
                        label="무손실 (선과 단색이 많으면 오히려 더 작습니다)"
                        checked={lossless}
                        disabled={busy}
                        onChange={(v) => {
                          setCustom((prev) => ({ ...prev, lossless: v }))
                        }}
                        ariaLabel="WebP 무손실 압축"
                      />
                    ) : null}

                    {/* APNG 는 알파를 항상 그대로 담는다. 끌 수 있는 것처럼 보이면 안 된다. */}
                    <ToggleField
                      label={
                        baseSettings.format === 'apng'
                          ? '투명 배경 유지 (APNG 는 항상 유지)'
                          : '투명 배경 유지'
                      }
                      checked={baseSettings.format === 'apng' ? true : baseSettings.transparent}
                      disabled={busy || baseSettings.format === 'apng'}
                      onChange={(v) => {
                        setCustom((prev) => ({ ...prev, transparent: v }))
                      }}
                      ariaLabel="투명 배경 유지"
                    />
                  </div>
                </section>
              ) : null}

              {/* ------------------------------------------------------------
                목표 용량 맞추기. 4노브보다 위에 놓는 1급 컨트롤이다.
              ------------------------------------------------------------ */}
              <section className="mm-section mm-target">
                <h3 className="mm-section-title">용량 맞추기</h3>

                <div className="mm-target-row">
                  <label className="mm-target-toggle">
                    <input
                      className="mm-checkbox"
                      type="checkbox"
                      checked={targetOn}
                      disabled={busy}
                      onChange={(e) => {
                        setTargetOn(e.target.checked)
                        if (!e.target.checked) {
                          setPlan(null)
                          setPlanError(null)
                        }
                      }}
                    />
                    <span>이 크기 이하로 맞춰 주세요</span>
                  </label>

                  <span className="mm-input-wrap mm-target-input">
                    <input
                      className="mm-input"
                      type="number"
                      inputMode="decimal"
                      min={0.1}
                      max={64}
                      step={0.5}
                      value={targetMb}
                      disabled={busy || !targetOn}
                      aria-label="목표 용량 (MB)"
                      onChange={(e) => {
                        const v = Number(e.target.value)
                        if (Number.isFinite(v)) setTargetMb(v)
                      }}
                    />
                    <span className="mm-input-suffix" aria-hidden="true">
                      MB
                    </span>
                  </span>

                  <button
                    type="button"
                    className="mm-btn"
                    disabled={busy || !targetOn || planning || !ready || !hasLayers}
                    onClick={() => {
                      void handlePlan()
                    }}
                  >
                    {planning ? '맞추는 중' : '맞춰보기'}
                  </button>
                </div>

                {!plan && !planning ? (
                  <p className="mm-field-hint">
                    해상도, 프레임 수, 색상 수를 영향이 큰 순서로 자동 조정합니다. 무엇을 얼마나
                    줄였는지 그대로 보여드리고, 마음에 들 때만 적용합니다.
                  </p>
                ) : null}

                {planError ? (
                  <p className="mm-error" role="alert">
                    {planError}
                  </p>
                ) : null}

                {plan ? (
                  <div className="mm-plan" role="group" aria-label="조정 결과">
                    <p className={plan.achieved ? 'mm-callout' : 'mm-callout is-warn'}>
                      {plan.achieved
                        ? `${formatBytes(Math.round(targetMb * MB))} 이하로 맞췄습니다. 예상 ${formatBytes(plan.estimatedBytes)} 입니다.`
                        : `${formatBytes(Math.round(targetMb * MB))} 까지는 줄이지 못했습니다. 여기까지 줄여 예상 ${formatBytes(plan.estimatedBytes)} 입니다. 길이를 짧게 만들면 더 줄어듭니다.`}
                    </p>

                    {changeLines.length > 0 ? (
                      <ul className="mm-plan-changes">
                        {changeLines.map((c, i) => (
                          <li key={`${c.text}-${i}`}>{c.text}</li>
                        ))}
                      </ul>
                    ) : (
                      <p className="mm-field-hint">줄일 것이 없어 그대로 둡니다.</p>
                    )}

                    <table className="mm-plan-table">
                      <thead>
                        <tr>
                          <th scope="col">항목</th>
                          <th scope="col">조정 전</th>
                          <th scope="col">조정 후</th>
                        </tr>
                      </thead>
                      <tbody>
                        {comparison.map((row) => (
                          <tr key={row.label}>
                            <th scope="row">{row.label}</th>
                            <td>{row.before}</td>
                            <td className="mm-plan-after">{row.after}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>

                    <div className="mm-btn-row">
                      <button
                        type="button"
                        className="mm-btn"
                        disabled={busy}
                        onClick={() => {
                          setPlan(null)
                        }}
                      >
                        조정 취소
                      </button>
                    </div>
                    <p className="mm-field-hint">
                      아래 [내보내기] 를 누르면 조정 후 설정으로 만듭니다. 속도와 프레임 수 변경은
                      타임라인에도 반영되며 실행취소로 되돌릴 수 있습니다.
                    </p>
                  </div>
                ) : null}
              </section>

              <section className="mm-section">
                <h3 className="mm-section-title">예상 결과</h3>
                <dl className="mm-summary">
                  <div>
                    <dt>크기</dt>
                    <dd>
                      {effective.width} x {effective.height}
                    </dd>
                  </div>
                  <div>
                    <dt>프레임</dt>
                    <dd>
                      {plannedFrameCount}장 / {plan ? plan.fps : doc.timeline.fps}fps
                    </dd>
                  </div>
                  <div>
                    <dt>용량</dt>
                    <dd>
                      {plan
                        ? formatBytes(plan.estimatedBytes)
                        : estimating && !estimate
                          ? '재는 중'
                          : estimate
                            ? formatEstimate(estimate)
                            : '알 수 없음'}
                    </dd>
                  </div>
                  <div>
                    <dt>소요</dt>
                    <dd>{formatDuration(durationSec)}</dd>
                  </div>
                </dl>
                {!plan && estimate && !estimate.exact ? (
                  <p className="mm-note">
                    {estimate.sampledFrames}장만 실제로 만들어 본 어림값입니다. 움직임이 적으면 더
                    작게, 노이즈가 많으면 더 크게 나옵니다.
                  </p>
                ) : null}
              </section>

              <div className="mm-warn-list">
                {isGif ? (
                  <p className="mm-callout is-warn">
                    GIF 는 반투명을 담지 못합니다. 픽셀마다 완전히 보이거나 완전히 사라지므로
                    부드러운 가장자리가 계단처럼 보일 수 있습니다.
                  </p>
                ) : null}
                {gifFpsInexact ? (
                  <p className="mm-callout is-warn">
                    {plan ? plan.fps : doc.timeline.fps}fps 는 GIF 에서 정확히 표현되지 않습니다.
                    움직임이 아주 살짝 덜 부드러워집니다.
                  </p>
                ) : null}
                {isWebp ? (
                  <p className="mm-callout">
                    WebP 는 반투명을 그대로 담으면서 파일이 가장 작습니다. 다만 오래된 이미지
                    뷰어와 일부 메신저는 열지 못합니다. 아래 진단에서 이 브라우저의 지원 여부를
                    직접 확인할 수 있습니다.
                  </p>
                ) : null}
                {fpsTooHigh ? (
                  <p className="mm-callout">
                    이 용도는 {purpose.fps}fps 를 권장합니다. 지금은 {doc.timeline.fps}fps 입니다.
                  </p>
                ) : null}
                {overBudget ? (
                  <p className="mm-callout is-warn">
                    권장 용량 {formatBytes(purpose.maxBytes)} 를 넘을 수 있습니다. 위의 [용량
                    맞추기] 로 {(purpose.maxBytes / MB).toFixed(0)}MB 를 넣고 맞춰보세요.
                  </p>
                ) : null}
                {/*
                  5초를 넘길 작업은 **누르기 전에** 알린다.
                  누른 뒤 진행률로 알리는 것은 이미 늦었다.
                */}
                {slow ? (
                  <p className="mm-callout is-warn">
                    이 설정은 {formatDuration(durationSec)} 걸릴 수 있습니다. 만드는 동안 이 탭을
                    켜 두세요. 다른 탭으로 가면 브라우저가 속도를 낮춰 더 오래 걸립니다.
                  </p>
                ) : null}
                {!hasLayers ? (
                  <p className="mm-callout is-warn">내보낼 것이 없습니다. 이미지나 도형을 먼저 넣어 주세요.</p>
                ) : null}
                {!ready ? (
                  <p className="mm-callout is-warn">
                    미리보기가 준비되지 않아 내보낼 수 없습니다.
                  </p>
                ) : null}
              </div>

              {/* 부록의 미검증 항목을 이 브라우저에서 직접 재는 자리. */}
              <BrowserSupport />
            </>
          )}

          {error ? (
            <div className="mm-error" role="alert">
              <p>{error}</p>
              {/* 실패하면 대체 포맷을 먼저 제안한다. */}
              {isWebp ? (
                <div className="mm-btn-row">
                  <button
                    type="button"
                    className="mm-btn"
                    disabled={busy}
                    onClick={() => {
                      handleReencode({
                        ...effective,
                        format: 'gif',
                        maxColors: 128,
                        dither: 0.5,
                      })
                    }}
                  >
                    GIF 로 대신 만들기
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>

        <footer className="mm-modal-foot">
          {/* 진행 상황은 화면 낭독기에도 알린다. */}
          <p className="mm-visually-hidden" role="status">
            {busy && progress ? `${progress.message} ${percent}%` : ''}
          </p>

          {result ? (
            <button
              type="button"
              className="mm-btn"
              disabled={busy}
              onClick={() => {
                reset()
              }}
            >
              설정 바꾸기
            </button>
          ) : (
            <button type="button" className="mm-btn" disabled={busy} onClick={onClose}>
              닫기
            </button>
          )}

          {busy ? (
            <button type="button" className="mm-btn" onClick={cancel}>
              취소
            </button>
          ) : null}

          {/*
            결과를 보고 있을 때도 재인코딩 중이면 이 버튼이 남아 진행률을 보여준다.
            진행률 때문에 모달을 하나 더 띄우지 않는다.
          */}
          {result && !busy ? null : (
            <button
              type="button"
              className={
                busy
                  ? 'mm-btn mm-btn-primary mm-export-btn is-busy'
                  : 'mm-btn mm-btn-primary mm-export-btn'
              }
              disabled={busy || !ready || !hasLayers}
              title={slow ? `${formatDuration(durationSec)} 걸릴 수 있습니다` : undefined}
              onClick={handleExport}
            >
              {/* 채움 막대는 커스텀 프로퍼티가 아니라 실제 요소 폭으로 그린다. */}
              {busy ? (
                <span
                  className="mm-export-btn-fill"
                  style={{ width: `${percent}%` }}
                  aria-hidden="true"
                />
              ) : null}
              <span className="mm-export-btn-label">
                {busy && progress
                  ? `${progress.message} ${percent}%`
                  : plan
                    ? '조정 후 설정으로 내보내기'
                    : '내보내기'}
              </span>
            </button>
          )}
        </footer>
      </div>
    </div>
  )
}

export default ExportDialog
