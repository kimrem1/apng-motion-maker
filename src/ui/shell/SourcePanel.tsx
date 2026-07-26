/**
 * 좌측 소스 패널.
 *
 * 이미지 목록과 레이어 목록은 같은 것이다.
 * 목록은 위가 위 레이어(z 큰 쪽)다. 문서 배열은 z 오름차순이므로 뒤집어 그린다.
 */

import { useEffect, useRef, useState, useSyncExternalStore } from 'react'

import { importImageFile, isSupportedImageFile, toErrorMessage } from '@/imageprep/index.ts'
import { assetRegistry } from '@/state/assets.ts'
import { useDocumentStore } from '@/state/document.ts'
import { useUiStore } from '@/state/ui.ts'

/** 썸네일 캔버스의 실제 픽셀 크기. CSS 는 36px 이므로 2배 해상도다. */
const THUMB_PX = 72

function IconEye({ open }: { open: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M1.5 8S3.9 3.75 8 3.75 14.5 8 14.5 8 12.1 12.25 8 12.25 1.5 8 1.5 8Z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <circle cx="8" cy="8" r="2" stroke="currentColor" strokeWidth="1.3" />
      {open ? null : (
        <path d="M2.5 13.5L13.5 2.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      )}
    </svg>
  )
}

function IconChevron({ up }: { up: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d={up ? 'M4 9.5L8 5.5l4 4' : 'M4 6.5L8 10.5l4-4'}
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function IconTrash() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M2.75 4.25h10.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <path
        d="M4.5 4.25l.6 8.05c.03.4.36.7.75.7h4.3c.39 0 .72-.3.75-.7l.6-8.05"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <path d="M6.25 4.25V3.2c0-.39.31-.7.7-.7h2.1c.39 0 .7.31.7.7v1.05" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  )
}

function IconPlus() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M8 3.25v9.5M3.25 8h9.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}

/** 에셋 비트맵을 작은 캔버스에 contain 으로 그린다. 리비전이 바뀌면 다시 그린다. */
function LayerThumb({ assetId, name }: { assetId: string | null; name: string }) {
  const revision = useSyncExternalStore(assetRegistry.subscribe, assetRegistry.getRevision)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    ctx.clearRect(0, 0, canvas.width, canvas.height)
    if (!assetId) return
    const bitmap = assetRegistry.get(assetId)
    if (!bitmap) return

    const scale = Math.min(canvas.width / bitmap.width, canvas.height / bitmap.height)
    const w = Math.max(1, Math.round(bitmap.width * scale))
    const h = Math.max(1, Math.round(bitmap.height * scale))
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(bitmap, Math.round((canvas.width - w) / 2), Math.round((canvas.height - h) / 2), w, h)
    // revision 은 비트맵 교체 감지용이다. 값 자체는 쓰지 않는다.
  }, [assetId, revision])

  return (
    <canvas
      ref={canvasRef}
      className="mm-thumb mm-checker"
      width={THUMB_PX}
      height={THUMB_PX}
      role="img"
      aria-label={`${name} 썸네일`}
    />
  )
}

export function SourcePanel() {
  const layers = useDocumentStore((s) => s.doc.layers)
  const addImage = useDocumentStore((s) => s.addImage)
  const removeLayer = useDocumentStore((s) => s.removeLayer)
  const reorderLayer = useDocumentStore((s) => s.reorderLayer)
  const setLayerFlag = useDocumentStore((s) => s.setLayerFlag)
  const selectedLayerId = useUiStore((s) => s.selectedLayerId)
  const selectLayer = useUiStore((s) => s.selectLayer)

  const inputRef = useRef<HTMLInputElement | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleFiles(fileList: FileList | null): Promise<void> {
    if (!fileList || fileList.length === 0) return
    setBusy(true)
    setError(null)

    const failures: string[] = []
    // 순서대로 처리한다. 병렬로 돌리면 레이어 쌓이는 순서가 파일 순서와 어긋난다.
    for (const file of Array.from(fileList)) {
      if (!isSupportedImageFile(file)) {
        failures.push(`${file.name || '파일'}: 지원하지 않는 형식입니다.`)
        continue
      }
      try {
        const imported = await importImageFile(file)
        const { layerId } = addImage({
          name: imported.name,
          bitmap: imported.bitmap,
          hasAlpha: imported.hasAlpha,
        })
        // 방금 넣은 레이어를 선택해야 인스펙터가 바로 그 레이어를 가리킨다.
        selectLayer(layerId)
      } catch (err) {
        failures.push(`${file.name || '이미지'}: ${toErrorMessage(err)}`)
      }
    }

    setBusy(false)
    setError(failures.length > 0 ? failures.join('\n') : null)
    // 같은 파일을 다시 고를 수 있도록 값을 비운다.
    if (inputRef.current) inputRef.current.value = ''
  }

  // 위가 z 가 큰 레이어다.
  const ordered = layers.map((layer, index) => ({ layer, index })).reverse()

  return (
    <section className="mm-panel mm-app-source" aria-label="이미지">
      <div className="mm-panel-head">
        <span>이미지</span>
        <span aria-hidden="true">{layers.length}</span>
      </div>

      <div className="mm-panel-body mm-scroll">
        {ordered.length === 0 ? (
          <p className="mm-empty-hint">이미지를 끌어다 놓거나 Ctrl+V 로 붙여넣으세요.</p>
        ) : (
          <ul className="mm-layer-list">
            {ordered.map(({ layer, index }) => {
              const selected = layer.id === selectedLayerId
              const isTop = index === layers.length - 1
              const isBottom = index === 0
              const itemClass = [
                'mm-layer-item',
                selected ? 'is-selected' : '',
                layer.visible ? '' : 'is-hidden',
              ]
                .filter(Boolean)
                .join(' ')

              return (
                <li key={layer.id} className={itemClass}>
                  <button
                    type="button"
                    className="mm-layer-main"
                    aria-pressed={selected}
                    onClick={() => selectLayer(layer.id)}
                  >
                    <LayerThumb assetId={layer.assetId} name={layer.name} />
                    <span className="mm-layer-name">{layer.name}</span>
                  </button>

                  <div className="mm-layer-actions">
                    <button
                      type="button"
                      className="mm-icon-btn"
                      aria-pressed={layer.visible}
                      title={layer.visible ? '숨기기' : '보이기'}
                      aria-label={`${layer.name} ${layer.visible ? '숨기기' : '보이기'}`}
                      onClick={() => setLayerFlag(layer.id, 'visible', !layer.visible)}
                    >
                      <IconEye open={layer.visible} />
                    </button>
                    <button
                      type="button"
                      className="mm-icon-btn"
                      disabled={isTop}
                      title="위로"
                      aria-label={`${layer.name} 위로 옮기기`}
                      onClick={() => reorderLayer(layer.id, 1)}
                    >
                      <IconChevron up />
                    </button>
                    <button
                      type="button"
                      className="mm-icon-btn"
                      disabled={isBottom}
                      title="아래로"
                      aria-label={`${layer.name} 아래로 옮기기`}
                      onClick={() => reorderLayer(layer.id, -1)}
                    >
                      <IconChevron up={false} />
                    </button>
                    <button
                      type="button"
                      className="mm-icon-btn is-danger"
                      title="삭제"
                      aria-label={`${layer.name} 삭제`}
                      onClick={() => {
                        removeLayer(layer.id)
                        if (selected) selectLayer(null)
                      }}
                    >
                      <IconTrash />
                    </button>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
        {error ? (
          <p className="mm-error" role="alert">
            {error}
          </p>
        ) : null}
      </div>

      <div className="mm-panel-foot">
        <button
          type="button"
          className="mm-btn mm-btn-block"
          disabled={busy}
          onClick={() => inputRef.current?.click()}
        >
          <IconPlus />
          {busy ? '불러오는 중' : '이미지 추가'}
        </button>
        {/* 숨긴 입력. 포커스는 위 버튼이 대표한다. */}
        <input
          ref={inputRef}
          className="mm-visually-hidden"
          type="file"
          accept="image/*"
          multiple
          tabIndex={-1}
          aria-hidden="true"
          onChange={(e) => {
            void handleFiles(e.target.files)
          }}
        />
      </div>
    </section>
  )
}

export default SourcePanel
