/**
 * 드래그앤드롭 + 전역 붙여넣기(Ctrl+V) 훅.
 * 온보딩 첫 클릭이 여기라서, 실패해도 alert 로 흐름을 끊지 않고 상태로만 노출한다.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
// 전역 DragEvent 와 이름이 겹치므로 별칭을 쓴다.
import type { DragEvent as ReactDragEvent } from 'react'

import { useDocumentStore } from '@/state/document.ts'
import { useLayerUiStore } from '@/state/layerUi.ts'

import { importFromDataTransfer, importImageFile } from './index.ts'
import { toErrorMessage } from './decode.ts'

export interface DropTargetProps {
  onDragEnter(event: ReactDragEvent<HTMLElement>): void
  onDragOver(event: ReactDragEvent<HTMLElement>): void
  onDragLeave(event: ReactDragEvent<HTMLElement>): void
  onDrop(event: ReactDragEvent<HTMLElement>): void
}

export interface UseImageDropResult {
  /** 드롭 대상 위에 파일이 떠 있는 상태. 오버레이 표시에 쓴다. */
  isDragging: boolean
  /** 디코드/추가 진행 중. 여러 장이면 순차적으로 끝날 때까지 true. */
  busy: boolean
  /** 실패 메시지. 여러 장이면 줄바꿈으로 합쳐진다. */
  error: string | null
  /** 성공했지만 알릴 내용이 있을 때. 예: 초대형 이미지. */
  warning: string | null
  clearMessages(): void
  /** <div {...bindDropTarget()} /> 형태로 쓴다. */
  bindDropTarget(): DropTargetProps
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}

/**
 * 붙여넣기 순간 동기적으로 판단해야 한다.
 * await 뒤에 preventDefault 를 부르면 이미 늦어서 브라우저 기본 동작이 먼저 일어난다.
 */
function clipboardHasImage(dt: DataTransfer): boolean {
  const items = dt.items
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i]
    if (item && item.kind === 'file' && item.type.startsWith('image/')) return true
  }
  const files = dt.files
  for (let i = 0; i < files.length; i += 1) {
    const file = files.item(i)
    if (file && file.type.startsWith('image/')) return true
  }
  return false
}

export function useImageDrop(): UseImageDropResult {
  const [isDragging, setIsDragging] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [warning, setWarning] = useState<string | null>(null)

  const mountedRef = useRef(true)
  // dragenter/dragleave 는 자식 요소를 지날 때마다 발생한다. 깊이를 세지 않으면 오버레이가 깜빡인다.
  const depthRef = useRef(0)
  const draggingRef = useRef(false)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const setDragging = useCallback((next: boolean) => {
    if (draggingRef.current === next) return
    draggingRef.current = next
    setIsDragging(next)
  }, [])

  const processFiles = useCallback(async (files: File[]): Promise<void> => {
    if (files.length === 0) return

    setBusy(true)
    setError(null)
    setWarning(null)

    const errors: string[] = []
    const warnings: string[] = []

    // 순서대로 처리한다. 병렬로 돌리면 레이어 쌓이는 순서가 파일 순서와 어긋난다.
    for (const file of files) {
      try {
        const imported = await importImageFile(file)
        if (imported.warning) warnings.push(`${imported.name}: ${imported.warning}`)

        const { layerId } = useDocumentStore.getState().addImage({
          name: imported.name,
          bitmap: imported.bitmap,
          hasAlpha: imported.hasAlpha,
        })
        // 방금 넣은 레이어로 선택을 옮겨야 인스펙터가 바로 그 레이어를 가리킨다.
        // 선택의 정본은 layerUi 다. ui.selectLayer 만 부르면(미러만 갱신) 두 번째
        // 드롭부터 레이어 패널은 앞 장을, 인스펙터는 새 장을 가리켜 대상이 갈라진다.
        useLayerUiStore.getState().setSelectedLayerIds([layerId], layerId)
      } catch (err) {
        const label = file.name || '이미지'
        errors.push(`${label}: ${toErrorMessage(err)}`)
      }
    }

    // 처리 도중 언마운트되었으면 상태를 건드리지 않는다. 문서 변경은 이미 반영된 상태다.
    if (!mountedRef.current) return
    setBusy(false)
    setError(errors.length > 0 ? errors.join('\n') : null)
    setWarning(warnings.length > 0 ? warnings.join('\n') : null)
  }, [])

  // 전역 붙여넣기. 텍스트 입력 중에는 가로채지 않는다.
  useEffect(() => {
    const onPaste = (event: ClipboardEvent): void => {
      const dt = event.clipboardData
      if (!dt) return
      if (isEditableTarget(event.target)) return
      if (!clipboardHasImage(dt)) return

      event.preventDefault()
      void importFromDataTransfer(dt).then(processFiles)
    }

    window.addEventListener('paste', onPaste)
    return () => {
      window.removeEventListener('paste', onPaste)
    }
  }, [processFiles])

  // 드롭 대상 밖에 떨어뜨렸을 때 브라우저가 그 이미지로 이동해 작업이 날아가는 걸 막는다.
  useEffect(() => {
    const block = (event: DragEvent): void => {
      event.preventDefault()
    }
    window.addEventListener('dragover', block)
    window.addEventListener('drop', block)
    return () => {
      window.removeEventListener('dragover', block)
      window.removeEventListener('drop', block)
    }
  }, [])

  const bindDropTarget = useCallback((): DropTargetProps => {
    return {
      onDragEnter(event) {
        event.preventDefault()
        depthRef.current += 1
        setDragging(true)
      },
      onDragOver(event) {
        // preventDefault 를 매 dragover 마다 불러야 drop 이 발생한다.
        event.preventDefault()
        event.dataTransfer.dropEffect = 'copy'
        setDragging(true)
      },
      onDragLeave(event) {
        event.preventDefault()
        depthRef.current = Math.max(0, depthRef.current - 1)
        if (depthRef.current === 0) setDragging(false)
      },
      onDrop(event) {
        event.preventDefault()
        event.stopPropagation()
        depthRef.current = 0
        setDragging(false)
        void importFromDataTransfer(event.dataTransfer).then(processFiles)
      },
    }
  }, [processFiles, setDragging])

  const clearMessages = useCallback(() => {
    setError(null)
    setWarning(null)
  }, [])

  return { isDragging, busy, error, warning, clearMessages, bindDropTarget }
}
