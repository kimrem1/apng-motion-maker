/**
 * [이미지 추가] 버튼의 실체.
 *
 * input[type=file] 은 스타일을 못 입히고 브라우저마다 모양이 다르다. 숨겨 두고
 * 버튼이 클릭을 위임한다. 숨김은 display:none 이 아니라 mm-visually-hidden 이다.
 * display:none 인 입력은 일부 브라우저에서 click() 이 무시된다.
 *
 * 여러 장은 순서대로 처리한다. Promise.all 로 병렬로 돌리면 디코드가 빨리 끝난
 * 파일이 먼저 레이어가 되어 쌓이는 순서가 사용자가 고른 순서와 어긋난다.
 * 실패는 그때그때 알리지 않고 모아서 마지막에 한 번에 보고한다. 10장 중 3장이
 * 실패했다고 알림을 3번 띄우면 그냥 화가 난다.
 */

import { useRef, useState, type ReactNode } from 'react'

import { importImageFile, isSupportedImageFile, toErrorMessage } from '@/imageprep/index.ts'
import { useDocumentStore } from '@/state/document.ts'
import { useLayerUiStore } from '@/state/layerUi.ts'

function IconPlus() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M8 3.25v9.5M3.25 8h9.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}

export interface AddLayerMenuProps {
  /** 버튼 문구. 기본은 "이미지 추가". */
  label?: string
  /** 버튼에 덧붙일 클래스. 기본은 mm-btn mm-btn-block. */
  className?: string
  /** 아이콘을 갈아끼우고 싶을 때. */
  icon?: ReactNode
  /** 성공한 레이어 id 목록을 알린다. 온보딩 흐름이 다음 단계로 넘어갈 때 쓴다. */
  onImported?(layerIds: string[]): void
}

export function AddLayerMenu({
  label = '이미지 추가',
  className = 'mm-btn mm-btn-block',
  icon,
  onImported,
}: AddLayerMenuProps) {
  const addImage = useDocumentStore((s) => s.addImage)
  const setSelectedLayerIds = useLayerUiStore((s) => s.setSelectedLayerIds)

  const inputRef = useRef<HTMLInputElement | null>(null)
  const [busy, setBusy] = useState(false)
  const [errors, setErrors] = useState<string[]>([])
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)

  async function handleFiles(fileList: FileList | null): Promise<void> {
    const files = fileList ? Array.from(fileList) : []
    // 값 비우기는 맨 앞에서 한다. 중간에 예외가 나도 같은 파일을 다시 고를 수 있어야 한다.
    if (inputRef.current) inputRef.current.value = ''
    if (files.length === 0) return

    setBusy(true)
    setErrors([])
    setProgress({ done: 0, total: files.length })

    const failures: string[] = []
    const added: string[] = []

    for (let i = 0; i < files.length; i += 1) {
      const file = files[i]
      if (!file) continue
      const shown = file.name || '파일'

      if (!isSupportedImageFile(file)) {
        failures.push(`${shown}: 지원하지 않는 형식입니다.`)
        setProgress({ done: i + 1, total: files.length })
        continue
      }

      try {
        const imported = await importImageFile(file)
        const { layerId } = addImage({
          name: imported.name,
          bitmap: imported.bitmap,
          hasAlpha: imported.hasAlpha,
        })
        added.push(layerId)
        if (imported.warning) failures.push(`${shown}: ${imported.warning}`)
      } catch (err) {
        failures.push(`${shown}: ${toErrorMessage(err)}`)
      }
      setProgress({ done: i + 1, total: files.length })
    }

    // 방금 넣은 것들을 선택 상태로 만든다. 인스펙터가 바로 그 레이어를 가리켜야 한다.
    // 마지막 한 장이 미러 대상이다(useUiStore.selectedLayerId).
    if (added.length > 0) {
      setSelectedLayerIds(added, added[added.length - 1] ?? null)
      onImported?.(added)
    }

    setBusy(false)
    setProgress(null)
    setErrors(failures)
  }

  const busyLabel =
    progress && progress.total > 1 ? `불러오는 중 ${progress.done}/${progress.total}` : '불러오는 중'

  return (
    <div className="mm-lyr-add">
      <button
        type="button"
        className={className}
        disabled={busy}
        onClick={() => inputRef.current?.click()}
      >
        {icon ?? <IconPlus />}
        {busy ? busyLabel : label}
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

      {errors.length > 0 ? (
        <div className="mm-lyr-errors" role="alert">
          <p className="mm-lyr-errors-head">{errors.length}개를 넣지 못했습니다.</p>
          <ul>
            {errors.map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
          <button type="button" className="mm-lyr-errors-close" onClick={() => setErrors([])}>
            닫기
          </button>
        </div>
      ) : null}
    </div>
  )
}

export default AddLayerMenu
