/**
 * 「그림 갈아끼우기」 버튼.
 *
 * 모션은 그대로 두고 그 레이어의 그림만 바꾼다. 만들어 둔 움직임을 템플릿처럼
 * 재사용하는 흐름의 유일한 조작이다.
 *
 * 컴포넌트를 따로 두는 이유는 두 곳에서 같은 버튼이 필요하기 때문이다. PRO 의
 * 레이어 목록(줄마다 하나)과 EASY 의 오른쪽 패널(고른 오브제 하나)이다. 파일 입력을
 * 각자 두면 숨김 방식과 오류 문구가 반드시 갈린다. AddLayerMenu 와 같은 이유다.
 *
 * input[type=file] 은 display:none 으로 숨기지 않는다. 그렇게 숨긴 입력은 일부
 * 브라우저에서 click() 이 무시된다 (AddLayerMenu 머리주석).
 */

import { useEffect, useRef, useState, type ReactNode } from 'react'

import { importImageFile, isSupportedImageFile, toErrorMessage } from '@/imageprep/index.ts'
import { useDocumentStore } from '@/state/document.ts'

export const IMAGE_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif,image/bmp,image/avif'

function IconSwapImage() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect
        x="2.2"
        y="3.2"
        width="11.6"
        height="9.6"
        rx="1.4"
        stroke="currentColor"
        strokeWidth="1.3"
      />
      <path
        d="M4.4 11.2l2.6-3 1.8 2 1.3-1.4 1.5 2.4"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="10.4" cy="5.9" r="1" fill="currentColor" />
    </svg>
  )
}

export interface ReplaceImageButtonProps {
  layerId: string
  /** 이미지 레이어가 아니거나 잠겼으면 눌리지 않는다. */
  disabled?: boolean
  /** 아이콘만 쓰는 자리(레이어 줄)와 글자를 쓰는 자리(EASY)가 갈린다. */
  label?: string
  className?: string
  icon?: ReactNode
  title?: string
  /** 실패 문구를 바깥 배너로 올리고 싶을 때. 없으면 버튼 아래에 직접 적는다. */
  onError?(message: string): void
  onReplaced?(assetId: string): void
}

export function ReplaceImageButton({
  layerId,
  disabled = false,
  label,
  className = 'mm-icon-btn',
  icon,
  title = '그림만 갈아끼우기. 움직임과 효과는 그대로 남습니다.',
  onError,
  onReplaced,
}: ReplaceImageButtonProps) {
  const replaceLayerImage = useDocumentStore((s) => s.replaceLayerImage)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const aliveRef = useRef(true)

  // 디코드가 끝나기 전에 줄이 사라질 수 있다. 그때 setState 를 부르면 경고가 뜬다.
  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  function fail(message: string): void {
    if (onError) onError(message)
    else setError(message)
  }

  async function handleFile(file: File | undefined): Promise<void> {
    // 값 비우기는 맨 앞에서 한다. 중간에 실패해도 같은 파일을 다시 고를 수 있어야 한다.
    if (inputRef.current) inputRef.current.value = ''
    if (!file) return
    if (!isSupportedImageFile(file)) {
      fail(`${file.name || '파일'}: 지원하지 않는 형식입니다.`)
      return
    }

    setBusy(true)
    setError(null)
    try {
      const imported = await importImageFile(file)
      const result = replaceLayerImage(layerId, {
        name: imported.name,
        bitmap: imported.bitmap,
        hasAlpha: imported.hasAlpha,
      })
      if (!aliveRef.current) return
      if (!result) {
        fail('이 레이어에는 갈아끼울 그림이 없습니다.')
        return
      }
      if (imported.warning) fail(imported.warning)
      onReplaced?.(result.assetId)
    } catch (err) {
      if (aliveRef.current) fail(`${file.name || '이미지'}: ${toErrorMessage(err)}`)
    } finally {
      if (aliveRef.current) setBusy(false)
    }
  }

  return (
    <>
      <button
        type="button"
        className={className}
        disabled={disabled || busy}
        tabIndex={className.includes('mm-icon-btn') ? -1 : undefined}
        title={title}
        aria-label={label ? undefined : title}
        onClick={(e) => {
          // 레이어 줄 안에 있을 때 줄 선택까지 함께 발화하지 않게 한다.
          e.stopPropagation()
          inputRef.current?.click()
        }}
      >
        {icon ?? <IconSwapImage />}
        {label}
      </button>
      <input
        ref={inputRef}
        type="file"
        className="mm-visually-hidden"
        accept={IMAGE_ACCEPT}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => {
          void handleFile(e.target.files?.[0])
        }}
      />
      {error ? (
        <p className="mm-error" role="alert">
          {error}
        </p>
      ) : null}
    </>
  )
}
