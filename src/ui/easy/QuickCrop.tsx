/**
 * 자유 자르기 다이얼로그.
 *
 * EASY 에는 인스펙터가 없어서 자르기 경로가 [빈 여백 잘라내기] 하나뿐이었다.
 * 그 버튼은 "이미 여백인 곳"만 찾는다. 얼굴만 남기고 싶다거나 정사각형으로
 * 맞추고 싶다는 요구는 그것으로 풀 수 없다. 여기서 영역을 직접 끌어 정한다.
 *
 * 비율은 기본이 자유다. 원하는 모양이 이미 있는 사람이 비율 칩을 누른다.
 * 그 반대로 두면(1:1 기본) 자유롭게 자르려는 사람이 매번 잠금을 풀어야 한다.
 *
 * 자르기 규칙 자체는 PRO 의 이미지 다듬기와 같은 순수 함수(imageprep/crop.ts)와
 * 같은 적용 경로(prep/trimAsset.ts)를 쓴다. 규칙이 두 벌이 되면 EASY 에서 자른
 * 것과 PRO 에서 자른 것이 다른 결과를 낸다.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react'

import { PREP_BITMAP_OPTIONS, cloneBitmap } from '@/imageprep/bgRemove.ts'
import {
  ASPECT_PRESETS,
  CROP_HANDLES,
  CROP_MIN_SIZE,
  applyCropDrag,
  fitRectToAspect,
  roundRect,
  type CropHandle,
  type CropRect,
} from '@/imageprep/crop.ts'
import { toErrorMessage } from '@/imageprep/decode.ts'
import { NumberField } from '@/ui/widgets/Field.tsx'
import { cropAssetTo, restoreAssetOriginal, type CanvasSize } from '@/ui/prep/trimAsset.ts'
import { ensurePrepBase } from '@/ui/prep/prepOriginals.ts'

// 모달 껍데기(mm-modal-*)는 내보내기 화면과 같은 스타일을 쓴다. 여기서만 따로
// 정의하면 두 다이얼로그의 여백과 그림자가 서서히 갈라진다.
import '@/ui/export/export.css'
import '@/ui/prep/prep.css'

/** 미리보기 긴 변. 크게 잡을수록 1px 단위로 끌기 쉽다. */
const PREVIEW_MAX = 720

/** 핸들을 잡았다고 볼 반경(화면 픽셀). 손가락으로도 잡을 수 있어야 한다. */
const HANDLE_GRAB_PX = 12
/** 이만큼 움직이기 전에는 드래그로 보지 않는다. 클릭이 상자를 만들면 안 된다. */
const DRAG_SLOP_PX = 3

interface DragState {
  mode: 'create' | 'edit'
  handle: CropHandle
  start: CropRect | null
  ox: number
  oy: number
  moved: boolean
}

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v)

export interface QuickCropProps {
  open: boolean
  assetId: string
  onClose(): void
  /** 적용이나 되돌리기가 끝나면 부른다. EASY 가 상태 문구로 보여 준다. */
  onDone(message: string): void
}

export function QuickCrop({ open, assetId, onClose, onDone }: QuickCropProps) {
  const [natural, setNatural] = useState({ w: 0, h: 0 })
  const [cropRect, setCropRect] = useState<CropRect | null>(null)
  const [aspectId, setAspectId] = useState('free')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** 자르기 전 캔버스. 되돌리기가 캔버스까지 원상복구하는 데 쓴다. */
  const [undoCanvas, setUndoCanvas] = useState<CanvasSize | null>(null)

  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const dragRef = useRef<DragState | null>(null)
  const aliveRef = useRef(true)

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  // --- 원본 미리보기 ---------------------------------------------------------
  useEffect(() => {
    if (!open) return
    let alive = true
    setError(null)
    setCropRect(null)
    setAspectId('free')
    dragRef.current = null

    void (async () => {
      try {
        // 미리보기 소스는 실제 자르기 소스와 같아야 한다(cropAssetTo 도 베이스에서 자른다).
        // 원본을 보여 주면 배경을 지운 그림인데 미리보기에만 배경이 남는다.
        const original = await ensurePrepBase(assetId)
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

        if (!alive) {
          small.close()
          return
        }
        setNatural({ w: original.width, h: original.height })

        const canvas = canvasRef.current
        if (canvas) {
          canvas.width = small.width
          canvas.height = small.height
          const ctx = canvas.getContext('2d')
          if (ctx) {
            ctx.clearRect(0, 0, canvas.width, canvas.height)
            ctx.drawImage(small, 0, 0)
          }
        }
        small.close()
      } catch (err) {
        if (alive) setError(toErrorMessage(err))
      }
    })()

    return () => {
      alive = false
    }
  }, [open, assetId])

  // --- 드래그 ---------------------------------------------------------------

  const ratio = ASPECT_PRESETS.find((p) => p.id === aspectId)?.ratio ?? null
  const bounds: CropRect = { x: 0, y: 0, w: natural.w, h: natural.h }
  const disabled = busy !== null

  function toNatural(e: ReactPointerEvent<HTMLDivElement>): { x: number; y: number } | null {
    const box = e.currentTarget.getBoundingClientRect()
    if (box.width === 0 || box.height === 0 || natural.w === 0 || natural.h === 0) return null
    return {
      x: ((e.clientX - box.left) / box.width) * natural.w,
      y: ((e.clientY - box.top) / box.height) * natural.h,
    }
  }

  /** 판정은 화면 픽셀로 한다. 자연 좌표로 하면 원본 크기에 따라 반경이 요동친다. */
  function hitHandle(
    rect: CropRect,
    at: { x: number; y: number },
    pxPerNatural: number,
  ): CropHandle | null {
    const grab = HANDLE_GRAB_PX / Math.max(1e-6, pxPerNatural)
    const nearL = Math.abs(at.x - rect.x) <= grab
    const nearR = Math.abs(at.x - (rect.x + rect.w)) <= grab
    const nearT = Math.abs(at.y - rect.y) <= grab
    const nearB = Math.abs(at.y - (rect.y + rect.h)) <= grab
    const insideX = at.x >= rect.x - grab && at.x <= rect.x + rect.w + grab
    const insideY = at.y >= rect.y - grab && at.y <= rect.y + rect.h + grab

    if (nearL && nearT) return 'nw'
    if (nearR && nearT) return 'ne'
    if (nearL && nearB) return 'sw'
    if (nearR && nearB) return 'se'
    if (nearL && insideY) return 'w'
    if (nearR && insideY) return 'e'
    if (nearT && insideX) return 'n'
    if (nearB && insideX) return 's'
    if (at.x > rect.x && at.x < rect.x + rect.w && at.y > rect.y && at.y < rect.y + rect.h) {
      return 'move'
    }
    return null
  }

  function handlePointerDown(e: ReactPointerEvent<HTMLDivElement>): void {
    if (disabled || natural.w === 0) return
    const at = toNatural(e)
    if (!at) return
    const box = e.currentTarget.getBoundingClientRect()
    const pxPerNatural = box.width / natural.w

    const handle = cropRect ? hitHandle(cropRect, at, pxPerNatural) : null
    dragRef.current = handle
      ? { mode: 'edit', handle, start: cropRect!, ox: at.x, oy: at.y, moved: false }
      : { mode: 'create', handle: 'se', start: null, ox: at.x, oy: at.y, moved: false }

    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      /* 캡처 없이 진행한다 */
    }
    e.preventDefault()
  }

  function handlePointerMove(e: ReactPointerEvent<HTMLDivElement>): void {
    const drag = dragRef.current
    if (!drag) return
    const at = toNatural(e)
    if (!at) return
    const dx = at.x - drag.ox
    const dy = at.y - drag.oy

    const box = e.currentTarget.getBoundingClientRect()
    const pxPerNatural = box.width / Math.max(1, natural.w)
    if (!drag.moved && Math.hypot(dx, dy) * pxPerNatural < DRAG_SLOP_PX) return
    drag.moved = true

    if (drag.mode === 'create') {
      // 끄는 방향이 곧 잡은 모서리다.
      const handle = `${dy < 0 ? 'n' : 's'}${dx < 0 ? 'w' : 'e'}` as CropHandle
      setCropRect(
        applyCropDrag({
          start: { x: drag.ox, y: drag.oy, w: 0, h: 0 },
          handle,
          dx,
          dy,
          bounds,
          ratio,
        }),
      )
      return
    }

    setCropRect(applyCropDrag({ start: drag.start!, handle: drag.handle, dx, dy, bounds, ratio }))
  }

  function handlePointerUp(e: ReactPointerEvent<HTMLDivElement>): void {
    const drag = dragRef.current
    dragRef.current = null
    try {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId)
      }
    } catch {
      /* 이미 놓았다 */
    }
    if (!drag || !drag.moved) return
    // 드래그가 끝난 순간에만 정수로 확정한다. 진행 중에 반올림하면 상자가 덜덜 떤다.
    setCropRect((prev) => (prev ? roundRect(prev, natural.w, natural.h) : prev))
  }

  /** 숫자 입력. 마우스가 없거나 1px 단위로 맞춰야 하는 사용자의 경로다. */
  function setCropField(key: 'x' | 'y' | 'w' | 'h', value: number): void {
    if (natural.w === 0) return
    const base = cropRect ?? { x: 0, y: 0, w: natural.w, h: natural.h }
    const next = { ...base, [key]: Math.round(value) }

    if (ratio !== null) {
      /*
       * 비율을 지킨 채 경계 안으로 넣는 일은 fitRectToAspect 한 곳에서만 한다.
       *
       * 예전에는 여기서 반대 축을 계산한 다음 두 축을 **각각** 잘랐다. 클램프에
       * 걸린 쪽을 기준으로 반대편을 다시 계산하지 않아, 512 폭 이미지에 16:9 를
       * 걸고 폭 600 을 넣으면 512 x 337(비율 1.52)이 됐다. 칩은 16:9 로 눌린 채
       * 실제 영역만 비뚤어지고, 그대로 확정까지 갔다.
       */
      if (key === 'w') next.h = next.w / ratio
      else if (key === 'h') next.w = next.h * ratio
      setCropRect(roundRect(fitRectToAspect(next, ratio, bounds), natural.w, natural.h))
      return
    }

    next.w = clamp(next.w, CROP_MIN_SIZE, natural.w)
    next.h = clamp(next.h, CROP_MIN_SIZE, natural.h)
    next.x = clamp(next.x, 0, natural.w - next.w)
    next.y = clamp(next.y, 0, natural.h - next.h)
    setCropRect(roundRect(next, natural.w, natural.h))
  }

  function handleAspect(id: string, nextRatio: number | null): void {
    setAspectId(id)
    // '자유' 는 지금 상자를 그대로 둔다. 비율만 풀린다.
    if (nextRatio === null) return
    // 이미지 로드 전(natural 0)에는 bounds 가 0 크기라 {0,0,0,0} 상자가 생기고,
    // 그대로 [이 영역으로 자르기] 를 누르면 1x1 픽셀로 잘린다 ([전체 선택]과 같은 가드).
    if (natural.w === 0 || natural.h === 0) return
    setCropRect(fitRectToAspect(cropRect ?? bounds, nextRatio, bounds))
  }

  // --- 적용 -----------------------------------------------------------------

  const apply = useCallback(() => {
    const rect = cropRect
    if (!rect) return
    // 0 크기 상자가 어떤 경로로든 남아 있으면 1x1 로 잘리는 사고가 된다.
    if (rect.w < 1 || rect.h < 1) return
    setBusy('적용')
    setError(null)
    cropAssetTo(assetId, rect)
      .then((result) => {
        if (!aliveRef.current) return
        setUndoCanvas(result.previousCanvas)
        onDone(`${result.canvas.w} x ${result.canvas.h} 로 잘랐습니다.`)
        onClose()
      })
      .catch((err: unknown) => {
        if (aliveRef.current) setError(toErrorMessage(err))
      })
      .finally(() => {
        if (aliveRef.current) setBusy(null)
      })
  }, [assetId, cropRect, onClose, onDone])

  const revert = useCallback(() => {
    setBusy('되돌리기')
    setError(null)
    restoreAssetOriginal(assetId, undoCanvas ?? undefined)
      .then(() => {
        if (!aliveRef.current) return
        setUndoCanvas(null)
        setCropRect(null)
        onDone('원래 이미지로 되돌렸습니다.')
        onClose()
      })
      .catch((err: unknown) => {
        if (aliveRef.current) setError(toErrorMessage(err))
      })
      .finally(() => {
        if (aliveRef.current) setBusy(null)
      })
  }, [assetId, onClose, onDone, undoCanvas])

  if (!open) return null

  return (
    <div className="mm-modal-scrim" role="presentation">
      <div
        className="mm-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="mm-quickcrop-title"
        tabIndex={-1}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && !disabled) onClose()
        }}
      >
        <header className="mm-modal-head">
          <h2 id="mm-quickcrop-title" className="mm-modal-title">
            자르기
          </h2>
          <button
            type="button"
            className="mm-icon-btn"
            aria-label="닫기"
            disabled={disabled}
            onClick={onClose}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
              <path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
        </header>

        <div className="mm-modal-body mm-scroll">
          <div className="mm-prep-stage mm-checker">
            <div
              className="mm-prep-frame"
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerCancel={handlePointerUp}
            >
              <canvas
                ref={canvasRef}
                className="mm-prep-canvas"
                width={1}
                height={1}
                role="img"
                aria-label="자르기 미리보기"
              />
              {cropRect && natural.w > 0 && natural.h > 0 ? (
                <div
                  className="mm-prep-crop"
                  aria-hidden="true"
                  style={{
                    left: `${(cropRect.x / natural.w) * 100}%`,
                    top: `${(cropRect.y / natural.h) * 100}%`,
                    width: `${(cropRect.w / natural.w) * 100}%`,
                    height: `${(cropRect.h / natural.h) * 100}%`,
                  }}
                >
                  <span className="mm-prep-crop-grid" />
                  {CROP_HANDLES.map((h) => (
                    <span key={h} className="mm-prep-handle" data-handle={h} />
                  ))}
                </div>
              ) : null}
            </div>
          </div>

          <p className="mm-field-hint">
            {cropRect
              ? '상자 안쪽을 끌면 이동, 모서리와 변을 끌면 크기가 바뀝니다. 상자 밖에서 끌면 새로 그립니다.'
              : '그림 위를 끌어서 남길 영역을 정하세요. 비율은 자유입니다.'}
          </p>

          <div className="mm-field">
            <span className="mm-field-label" id="mm-quickcrop-aspect">
              비율
            </span>
            <div className="mm-prep-chips" role="group" aria-labelledby="mm-quickcrop-aspect">
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

          <div className="mm-prep-cropnums">
            <NumberField
              label="X"
              value={cropRect ? Math.round(cropRect.x) : 0}
              min={0}
              max={Math.max(0, natural.w - CROP_MIN_SIZE)}
              step={1}
              disabled={disabled || !cropRect}
              onChange={(v) => setCropField('x', v)}
            />
            <NumberField
              label="Y"
              value={cropRect ? Math.round(cropRect.y) : 0}
              min={0}
              max={Math.max(0, natural.h - CROP_MIN_SIZE)}
              step={1}
              disabled={disabled || !cropRect}
              onChange={(v) => setCropField('y', v)}
            />
            <NumberField
              label="폭"
              value={cropRect ? Math.round(cropRect.w) : natural.w}
              min={CROP_MIN_SIZE}
              max={Math.max(CROP_MIN_SIZE, natural.w)}
              step={1}
              disabled={disabled || !cropRect}
              onChange={(v) => setCropField('w', v)}
            />
            <NumberField
              label="높이"
              value={cropRect ? Math.round(cropRect.h) : natural.h}
              min={CROP_MIN_SIZE}
              max={Math.max(CROP_MIN_SIZE, natural.h)}
              step={1}
              disabled={disabled || !cropRect}
              onChange={(v) => setCropField('h', v)}
            />
          </div>

          <div className="mm-prep-actions">
            <button
              type="button"
              className="mm-btn"
              disabled={disabled || natural.w === 0}
              onClick={() => {
                const full: CropRect = { x: 0, y: 0, w: natural.w, h: natural.h }
                setCropRect(ratio === null ? full : fitRectToAspect(full, ratio, full))
              }}
            >
              전체 선택
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
              선택 해제
            </button>
            <button type="button" className="mm-btn" disabled={disabled} onClick={revert}>
              원본으로 되돌리기
            </button>
          </div>

          {cropRect ? (
            <p className="mm-field-hint">
              자를 영역 {Math.round(cropRect.w)} x {Math.round(cropRect.h)} (원본 {natural.w} x{' '}
              {natural.h}). 캔버스도 이 크기가 됩니다.
            </p>
          ) : null}

          {error ? (
            <p className="mm-error" role="alert">
              {error}
            </p>
          ) : null}
        </div>

        <footer className="mm-modal-foot">
          <button type="button" className="mm-btn" disabled={disabled} onClick={onClose}>
            취소
          </button>
          <button
            type="button"
            className="mm-btn mm-btn-primary"
            disabled={disabled || !cropRect}
            onClick={apply}
          >
            {busy === '적용' ? '자르는 중' : '이 영역으로 자르기'}
          </button>
        </footer>
      </div>
    </div>
  )
}

export default QuickCrop
