/**
 * 이미지 다듬기 패널.
 *
 * 흰 배경 JPG 를 넣은 사용자가 여기서 투명 스티커를 만든다.
 * 배경 제거 파라미터는 전부 미리보기로 즉시 확인하고, 확인이 끝난 뒤에만
 * [적용] 으로 실제 에셋을 교체한다. 슬라이더가 곧바로 원본을 갈아엎으면
 * 되돌릴 방법이 없다.
 *
 * 미리보기 배경 스위처는 장식이 아니라 14.A1 의 릴리즈 게이트다.
 * 체커보드 위에서는 흰 테두리가 안 보이고, 흰 배경 위에서는 검은 테두리가
 * 안 보인다. 둘 다 볼 수 있어야 디스필이 됐는지 판단할 수 있다.
 *
 * --- 문서 스토어에 필요한 액션 (아직 없음) ---
 * 지금은 assetRegistry.set 으로 픽셀만 바꾼다. 문서의 AssetRef 는 그대로다.
 * 배경 제거만 하면 크기가 안 변해서 문제가 없지만, **크롭은 크기를 바꾼다.**
 * 그러면 AssetRef.naturalW / naturalH 가 실제 픽셀과 어긋나고,
 * overscan.ts 의 requiredScaleAt 이 틀린 원본 크기로 s_min 을 계산한다.
 * 결과적으로 회전/이동 프리셋에서 캔버스 모서리가 비는 사고가 난다.
 * 그래서 크기가 바뀌면 경고를 띄운다. 필요한 액션은 반환 보고서에 적었다.
 */

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  // DOM 의 MouseEvent 와 이름이 겹친다. 별칭으로 구분한다.
  type MouseEvent as ReactMouseEvent,
} from 'react'

import type { AssetRef } from '@/core/types.ts'
import { toErrorMessage } from '@/imageprep/decode.ts'
import {
  PREP_BITMAP_OPTIONS,
  cloneBitmap,
  estimateTolerance,
  pickKeyColorFromCorners,
  readPixels,
  removeBackground,
  type BgRemoveOptions,
} from '@/imageprep/bgRemove.ts'
import {
  ASPECT_PRESETS,
  autoTrimAlpha,
  cropBitmap,
  fitRectToAspect,
  type CropRect,
} from '@/imageprep/crop.ts'
import { assetRegistry } from '@/state/assets.ts'
import { useDocumentStore } from '@/state/document.ts'
import { useUiStore } from '@/state/ui.ts'

import './prep.css'

/** 미리보기 긴 변. 슬라이더를 끌 때마다 전체 해상도를 돌리면 손가락보다 느려진다. */
const PREVIEW_MAX = 320
/** 슬라이더 디바운스. --dur-fast 와 같은 값이다. */
const PREVIEW_DEBOUNCE_MS = 140

const FEATHER_MAX = 8

type PreviewBg = 'checker' | 'white' | 'black' | 'gray'

const BACKGROUNDS: readonly { id: PreviewBg; label: string }[] = [
  { id: 'checker', label: '체커' },
  { id: 'white', label: '흰' },
  { id: 'black', label: '검' },
  { id: 'gray', label: '회' },
]

// ---------------------------------------------------------------------------
// 원본 보관소
// ---------------------------------------------------------------------------

/**
 * 원본 비트맵 보관소.
 *
 * **어디에 보관하는가**: 이 모듈의 모듈 스코프 Map 이다. 문서 스토어에 넣으면
 * undo 스택이 픽셀을 붙잡아 수백 MB 가 되고, assetRegistry 에
 * 넣으면 id 가 하나뿐이라 원본과 처리 결과를 동시에 들 수 없다.
 *
 * 반드시 **사본**을 보관한다. assetRegistry.set 은 교체되는 이전 비트맵을
 * close 하므로, 원본 인스턴스를 그대로 들고 있으면 첫 [적용] 순간 우리 원본이
 * 닫혀서 되돌리기가 영원히 불가능해진다.
 *
 * IndexedDB 영속화가 들어오면 이 Map 은 그쪽으로 옮겨간다. 새로고침하면
 * 원본이 사라지므로 지금은 세션 동안만 되돌릴 수 있다.
 */
const prepOriginals = new Map<string, ImageBitmap>()

export async function ensurePrepOriginal(assetId: string): Promise<ImageBitmap> {
  const kept = prepOriginals.get(assetId)
  if (kept) return kept

  const current = assetRegistry.get(assetId)
  if (!current) throw new Error('이 이미지의 픽셀을 찾지 못했습니다.')

  const copy = await cloneBitmap(current)
  // await 사이에 다른 호출이 먼저 넣었을 수 있다. 먼저 들어간 쪽을 정본으로 둔다.
  const raced = prepOriginals.get(assetId)
  if (raced) {
    copy.close()
    return raced
  }
  prepOriginals.set(assetId, copy)
  return copy
}

/** 레이어를 지울 때 호출자가 정리할 수 있게 열어 둔다. */
export function releasePrepOriginal(assetId: string): void {
  const kept = prepOriginals.get(assetId)
  if (!kept) return
  kept.close()
  prepOriginals.delete(assetId)
}

// ---------------------------------------------------------------------------
// 작은 유틸
// ---------------------------------------------------------------------------

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v)

function toHex(color: readonly [number, number, number]): string {
  const part = (v: number): string =>
    clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')
  return `#${part(color[0])}${part(color[1])}${part(color[2])}`
}

function fromHex(hex: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return null
  const n = parseInt(m[1]!, 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

interface PrepSettings {
  enabled: boolean
  keyColor: [number, number, number]
  tolerance: number
  featherPx: number
  contiguous: boolean
}

function toOptions(s: PrepSettings): BgRemoveOptions {
  return {
    keyColor: [s.keyColor[0], s.keyColor[1], s.keyColor[2]],
    tolerance: s.tolerance,
    featherPx: s.featherPx,
    contiguous: s.contiguous,
  }
}

function IconDropper() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M10.4 2.6a1.6 1.6 0 0 1 2.3 2.3l-1 1 .7.7-1.1 1.1-2.9-2.9L9.5 3.7l.7.7 .2-.2Z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      <path
        d="M8.4 6.5 3.6 11.3c-.2.2-.3.4-.3.7v1.1c0 .3.2.5.5.5h1.1c.3 0 .5-.1.7-.3l4.8-4.8"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  )
}

// ---------------------------------------------------------------------------
// 슬라이더
// ---------------------------------------------------------------------------

interface RangeRowProps {
  label: string
  value: number
  min: number
  max: number
  step: number
  display: string
  disabled?: boolean
  onChange(next: number): void
}

function RangeRow({ label, value, min, max, step, display, disabled, onChange }: RangeRowProps) {
  const id = useId()
  return (
    <div className="mm-field">
      <label className="mm-field-label" htmlFor={id}>
        {label} <span className="mm-prep-value">{display}</span>
      </label>
      <input
        id={id}
        className="mm-prep-range"
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// 편집기 본체
// ---------------------------------------------------------------------------

function PrepEditor({ asset }: { asset: AssetRef }) {
  // 같은 화면에 편집기가 둘 이상 뜰 일은 없지만, id 를 고정 문자열로 박으면
  // 나중에 비교 뷰를 붙이는 순간 label 연결이 조용히 깨진다.
  const uid = useId()
  const [settings, setSettings] = useState<PrepSettings>(() => ({
    enabled: true,
    keyColor: [255, 255, 255],
    tolerance: 0.12,
    featherPx: 1,
    contiguous: true,
  }))
  const [natural, setNatural] = useState<{ w: number; h: number }>({
    w: asset.naturalW,
    h: asset.naturalH,
  })
  const [cropRect, setCropRect] = useState<CropRect | null>(null)
  const [aspectId, setAspectId] = useState('free')
  const [background, setBackground] = useState<PreviewBg>('checker')
  const [picking, setPicking] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [applied, setApplied] = useState<{ w: number; h: number } | null>(null)
  /** 미리보기 재그리기를 강제하는 값. 비트맵은 ref 에 있어서 상태 비교로는 안 잡힌다. */
  const [previewTick, setPreviewTick] = useState(0)
  /** 축소 원본이 준비된 시점. 이게 없으면 첫 계산이 원본을 못 잡고 그냥 지나간다. */
  const [sourceRev, setSourceRev] = useState(0)

  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  /** 미리보기용 축소 원본. */
  const previewSrcRef = useRef<ImageBitmap | null>(null)
  /** 스포이드가 읽는 축소 원본 픽셀. 처리 결과가 아니라 원본에서 뽑아야 한다. */
  const previewPixelsRef = useRef<ImageData | null>(null)
  /** 배경을 지운 미리보기 결과. */
  const previewOutRef = useRef<ImageBitmap | null>(null)

  const bumpPreview = useCallback((): void => {
    setPreviewTick((t) => t + 1)
  }, [])

  // StrictMode 는 이펙트를 두 번 돌린다. 정리(cleanup)에서 비트맵을 닫으면
  // 두 번째 실행이 이미 닫힌 비트맵을 잡는다. 그래서 "새로 만들 때 이전 것을
  // 닫는다"로 통일한다.
  const replacePreviewOut = useCallback(
    (next: ImageBitmap | null): void => {
      const prev = previewOutRef.current
      if (prev && prev !== next) prev.close()
      previewOutRef.current = next
      bumpPreview()
    },
    [bumpPreview],
  )

  // --- 원본 준비 + 자동 추정 -------------------------------------------------
  useEffect(() => {
    let alive = true
    setError(null)
    setApplied(null)
    setCropRect(null)
    setAspectId('free')

    void (async () => {
      try {
        const original = await ensurePrepOriginal(asset.id)
        if (!alive) return

        const long = Math.max(original.width, original.height)
        const scale = long > PREVIEW_MAX ? PREVIEW_MAX / long : 1
        const pw = Math.max(1, Math.round(original.width * scale))
        const ph = Math.max(1, Math.round(original.height * scale))
        const small =
          scale < 1
            ? await createImageBitmap(original, {
                ...PREP_BITMAP_OPTIONS,
                resizeWidth: pw,
                resizeHeight: ph,
                resizeQuality: 'high',
              })
            : await cloneBitmap(original)

        const prev = previewSrcRef.current
        if (prev) prev.close()
        previewSrcRef.current = small
        previewPixelsRef.current = readPixels(small)

        // 자동 추정은 축소본에서 한다. 전체 해상도로 해도 결과가 거의 같고,
        // 임포트 직후 UI 가 멈추는 쪽이 훨씬 나쁘다.
        const key = pickKeyColorFromCorners(small)
        const tolerance = estimateTolerance(small, key)

        if (!alive) return
        setNatural({ w: original.width, h: original.height })
        setSettings({ enabled: true, keyColor: key, tolerance, featherPx: 1, contiguous: true })
        replacePreviewOut(null)
        setSourceRev((v) => v + 1)
      } catch (err) {
        if (alive) setError(toErrorMessage(err))
      }
    })()

    return () => {
      alive = false
    }
  }, [asset.id, replacePreviewOut])

  // --- 미리보기 계산 ---------------------------------------------------------
  const { enabled, tolerance, featherPx, contiguous } = settings
  const keyKey = settings.keyColor.join(',')

  useEffect(() => {
    if (!enabled) {
      replacePreviewOut(null)
      return
    }
    let alive = true
    const timer = setTimeout(() => {
      const source = previewSrcRef.current
      if (!source) return
      // settings 는 deps 에 없지만 항상 최신이다. 이펙트 함수 자체가 매 렌더마다
      // 새로 만들어지고, deps(keyKey 등)가 바뀐 렌더의 함수가 실행되기 때문이다.
      const opts = toOptions(settings)
      void (async () => {
        try {
          const out = await removeBackground(source, opts)
          if (!alive) {
            out.close()
            return
          }
          replacePreviewOut(out)
        } catch (err) {
          if (alive) setError(toErrorMessage(err))
        }
      })()
    }, PREVIEW_DEBOUNCE_MS)

    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [enabled, keyKey, tolerance, featherPx, contiguous, sourceRev, replacePreviewOut])

  // --- 그리기 ---------------------------------------------------------------
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    // 처리 결과가 아직이면 원본을 보여준다. 계산 중 화면이 비면 깜빡임이 된다.
    const shown = (enabled ? previewOutRef.current : null) ?? previewSrcRef.current
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    if (!shown) {
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      return
    }
    if (canvas.width !== shown.width || canvas.height !== shown.height) {
      canvas.width = shown.width
      canvas.height = shown.height
    }
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    try {
      ctx.drawImage(shown, 0, 0)
    } catch {
      // 교체 경합으로 닫힌 비트맵을 잡은 경우다. 다음 tick 에 다시 그린다.
      return
    }

    if (!cropRect || natural.w === 0) return
    // 크롭 영역 표시. 바깥을 어둡게 덮지 않는다. 덮으면 알파 확인이 막힌다.
    const s = canvas.width / natural.w
    ctx.save()
    ctx.strokeStyle = '#3d7dff'
    ctx.lineWidth = 1
    ctx.setLineDash([4, 3])
    ctx.strokeRect(
      Math.round(cropRect.x * s) + 0.5,
      Math.round(cropRect.y * s) + 0.5,
      Math.max(1, Math.round(cropRect.w * s) - 1),
      Math.max(1, Math.round(cropRect.h * s) - 1),
    )
    ctx.restore()
  }, [previewTick, sourceRev, enabled, cropRect, natural.w, background])

  // --- 동작 -----------------------------------------------------------------

  function handlePick(e: ReactMouseEvent<HTMLCanvasElement>): void {
    if (!picking) return
    const canvas = e.currentTarget
    const pixels = previewPixelsRef.current
    if (!pixels) return
    const box = canvas.getBoundingClientRect()
    if (box.width === 0 || box.height === 0) return

    const x = Math.floor((e.clientX - box.left) * (canvas.width / box.width))
    const y = Math.floor((e.clientY - box.top) * (canvas.height / box.height))
    if (x < 0 || y < 0 || x >= pixels.width || y >= pixels.height) return

    const p = (y * pixels.width + x) * 4
    const d = pixels.data
    setSettings((s) => ({ ...s, keyColor: [d[p] ?? 0, d[p + 1] ?? 0, d[p + 2] ?? 0] }))
    // 한 번 찍으면 스포이드를 끈다. 켜 둔 채로 두면 다음 클릭이 사고를 낸다.
    setPicking(false)
  }

  async function withBusy(label: string, run: () => Promise<void>): Promise<void> {
    setBusy(label)
    setError(null)
    try {
      await run()
    } catch (err) {
      setError(toErrorMessage(err))
    } finally {
      setBusy(null)
    }
  }

  /** 전체 해상도 파이프라인. 배경 제거 -> 크롭 순서다. */
  async function buildResult(original: ImageBitmap): Promise<ImageBitmap> {
    let out: ImageBitmap | null = null
    if (settings.enabled) out = await removeBackground(original, toOptions(settings))
    if (cropRect) {
      const base = out ?? original
      const next = await cropBitmap(base, cropRect)
      if (out) out.close()
      out = next
    }
    // 아무 처리도 없으면 원본 보관본을 그대로 넘길 수 없다. 레지스트리가 닫아 버린다.
    return out ?? (await cloneBitmap(original))
  }

  function handleApply(): void {
    void withBusy('적용', async () => {
      const original = await ensurePrepOriginal(asset.id)
      const result = await buildResult(original)
      assetRegistry.set(asset.id, result)
      setApplied({ w: result.width, h: result.height })
    })
  }

  function handleRevert(): void {
    void withBusy('되돌리기', async () => {
      const original = await ensurePrepOriginal(asset.id)
      assetRegistry.set(asset.id, await cloneBitmap(original))
      setApplied(null)
    })
  }

  function handleAutoTrim(): void {
    void withBusy('여백 찾기', async () => {
      const original = await ensurePrepOriginal(asset.id)
      // 여백 판정은 알파로 한다. 배경 제거를 켠 상태면 그 결과에서 찾아야 맞다.
      let probe = original
      let temp: ImageBitmap | null = null
      if (settings.enabled) {
        temp = await removeBackground(original, toOptions(settings))
        probe = temp
      }
      const rect = await autoTrimAlpha(probe)
      if (temp) temp.close()
      setCropRect(rect)
      setAspectId('free')
    })
  }

  function handleAspect(id: string, ratio: number | null): void {
    setAspectId(id)
    if (ratio === null) return
    const bounds: CropRect = { x: 0, y: 0, w: natural.w, h: natural.h }
    setCropRect(fitRectToAspect(cropRect ?? bounds, ratio, bounds))
  }

  const sizeChanged =
    applied !== null && (applied.w !== asset.naturalW || applied.h !== asset.naturalH)
  const disabled = busy !== null

  return (
    <div className="mm-stack">
      {/* 미리보기 --------------------------------------------------------- */}
      <div className="mm-prep-preview">
        <div className="mm-prep-bgbar" role="group" aria-label="미리보기 배경">
          {BACKGROUNDS.map((bg) => (
            <button
              key={bg.id}
              type="button"
              className="mm-prep-chip"
              aria-pressed={background === bg.id}
              onClick={() => setBackground(bg.id)}
            >
              {bg.label}
            </button>
          ))}
        </div>

        <div
          className={
            background === 'checker' ? 'mm-prep-stage mm-checker' : 'mm-prep-stage'
          }
          data-bg={background}
        >
          <canvas
            ref={canvasRef}
            className={picking ? 'mm-prep-canvas is-picking' : 'mm-prep-canvas'}
            width={1}
            height={1}
            role="img"
            aria-label="배경 제거 미리보기"
            onClick={handlePick}
          />
        </div>

        <p className="mm-field-hint">
          흰 배경과 검은 배경을 번갈아 보세요. 흰 배경에서 검은 테두리가, 검은 배경에서 흰
          테두리가 보이면 허용치를 조금 올리세요.
        </p>
      </div>

      {/* 배경 제거 -------------------------------------------------------- */}
      <div className="mm-field mm-field-toggle">
        <input
          id={`${uid}-enabled`}
          className="mm-checkbox"
          type="checkbox"
          checked={settings.enabled}
          disabled={disabled}
          onChange={(e) => setSettings((s) => ({ ...s, enabled: e.target.checked }))}
        />
        <label className="mm-field-label" htmlFor={`${uid}-enabled`}>
          배경 지우기
        </label>
      </div>

      <div className="mm-field">
        <label className="mm-field-label" htmlFor={`${uid}-key`}>
          지울 색
        </label>
        <div className="mm-prep-key">
          <span
            className="mm-prep-swatch"
            style={{ background: toHex(settings.keyColor) }}
            aria-hidden="true"
          />
          {/* 스포이드를 못 쓰는 사용자를 위한 대체 입력이다. 키보드로도 색을 정할 수 있다. */}
          <input
            id={`${uid}-key`}
            className="mm-color"
            type="color"
            value={toHex(settings.keyColor)}
            disabled={!settings.enabled || disabled}
            aria-label="지울 배경색"
            onChange={(e) => {
              const rgb = fromHex(e.target.value)
              if (rgb) setSettings((s) => ({ ...s, keyColor: rgb }))
            }}
          />
          <button
            type="button"
            className="mm-btn"
            aria-pressed={picking}
            disabled={!settings.enabled || disabled}
            title="미리보기에서 지울 색을 클릭해 고릅니다"
            onClick={() => setPicking((v) => !v)}
          >
            <IconDropper />
            스포이드
          </button>
        </div>
      </div>

      <RangeRow
        label="허용치"
        value={Math.round(settings.tolerance * 100)}
        min={0}
        max={100}
        step={1}
        display={`${Math.round(settings.tolerance * 100)}%`}
        disabled={!settings.enabled || disabled}
        onChange={(v) => setSettings((s) => ({ ...s, tolerance: clamp(v / 100, 0, 1) }))}
      />

      <RangeRow
        label="가장자리 부드럽게"
        value={settings.featherPx}
        min={0}
        max={FEATHER_MAX}
        step={1}
        display={`${settings.featherPx}px`}
        disabled={!settings.enabled || disabled}
        onChange={(v) => setSettings((s) => ({ ...s, featherPx: clamp(v, 0, FEATHER_MAX) }))}
      />

      <div className="mm-field mm-field-toggle">
        <input
          id={`${uid}-contiguous`}
          className="mm-checkbox"
          type="checkbox"
          checked={settings.contiguous}
          disabled={!settings.enabled || disabled}
          onChange={(e) => setSettings((s) => ({ ...s, contiguous: e.target.checked }))}
        />
        <label className="mm-field-label" htmlFor={`${uid}-contiguous`}>
          모서리에서 연결된 부분만
        </label>
      </div>
      <p className="mm-field-hint">
        켜 두면 피사체 안쪽의 같은 색(예: 흰 눈동자)이 지워지지 않습니다.
      </p>

      {/* 크롭 ------------------------------------------------------------- */}
      <div className="mm-field">
        <span className="mm-field-label" id={`${uid}-aspect`}>
          비율
        </span>
        <div className="mm-prep-chips" role="group" aria-labelledby={`${uid}-aspect`}>
          {ASPECT_PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              className="mm-prep-chip"
              aria-pressed={aspectId === preset.id}
              disabled={disabled}
              onClick={() => handleAspect(preset.id, preset.ratio)}
            >
              {preset.label}
            </button>
          ))}
        </div>
      </div>

      <div className="mm-prep-actions">
        <button type="button" className="mm-btn" disabled={disabled} onClick={handleAutoTrim}>
          빈 여백 자동 제거
        </button>
        <button
          type="button"
          className="mm-btn"
          disabled={disabled || !cropRect}
          onClick={() => {
            setCropRect(null)
            setAspectId('free')
          }}
        >
          크롭 해제
        </button>
      </div>

      {cropRect ? (
        <p className="mm-field-hint">
          자를 영역 {Math.round(cropRect.w)} x {Math.round(cropRect.h)} (원본 {natural.w} x{' '}
          {natural.h})
        </p>
      ) : null}

      {/* 적용 ------------------------------------------------------------- */}
      <div className="mm-prep-actions">
        <button
          type="button"
          className="mm-btn mm-btn-primary"
          disabled={disabled}
          onClick={handleApply}
        >
          {busy === '적용' ? '적용 중' : '적용'}
        </button>
        <button type="button" className="mm-btn" disabled={disabled} onClick={handleRevert}>
          되돌리기
        </button>
      </div>

      {applied ? (
        <p className="mm-note">
          적용했습니다. {applied.w} x {applied.h}
        </p>
      ) : null}

      {sizeChanged ? (
        <p className="mm-prep-warn" role="alert">
          잘라낸 크기({applied?.w} x {applied?.h})가 문서에 기록된 원본 크기(
          {asset.naturalW} x {asset.naturalH})와 다릅니다. 문서에 크기를 반영하는 액션
          (updateAssetPrep)이 아직 없어 오버스캔 계산이 옛 크기를 씁니다. 회전이나 이동
          프리셋에서 캔버스 모서리가 빌 수 있습니다.
        </p>
      ) : null}

      {error ? (
        <p className="mm-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  )
}

// ---------------------------------------------------------------------------

/**
 * 선택된 레이어의 원본 이미지를 다듬는다.
 * 인스펙터 본문에 그대로 끼워 넣을 수 있는 섹션 형태다.
 */
export function PrepPanel() {
  const layers = useDocumentStore((s) => s.doc.layers)
  const assets = useDocumentStore((s) => s.doc.assets)
  const selectedLayerId = useUiStore((s) => s.selectedLayerId)

  const layer = layers.find((l) => l.id === selectedLayerId) ?? null
  const asset = layer?.assetId ? (assets.find((a) => a.id === layer.assetId) ?? null) : null

  return (
    <section className="mm-section" aria-labelledby="mm-sec-prep">
      <h2 className="mm-section-title" id="mm-sec-prep">
        이미지 다듬기
      </h2>
      {asset ? (
        // key 를 주면 에셋이 바뀔 때 상태가 통째로 초기화된다.
        <PrepEditor key={asset.id} asset={asset} />
      ) : (
        <p className="mm-note">이미지 레이어를 선택하면 배경 제거와 크롭을 쓸 수 있습니다.</p>
      )}
    </section>
  )
}

export default PrepPanel
