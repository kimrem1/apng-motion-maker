/**
 * 이미지 입력 파이프라인 진입점.
 * 디코드 -> 알파 실측 -> 문서 스토어가 바로 받을 수 있는 형태로 합친다.
 */

import type { AddImageInput } from '@/state/document.ts'

import { probeAlpha } from './alphaProbe.ts'
import { decodeImageFile, isSupportedImageFile } from './decode.ts'

export type ImportedImage = AddImageInput & { warning?: string }

/** 이 결과를 그대로 useDocumentStore.getState().addImage 에 넘길 수 있다. */
export async function importImageFile(file: File): Promise<ImportedImage> {
  const decoded = await decodeImageFile(file)

  // 포맷상 알파가 불가능하면(JPEG) 픽셀 검사를 건너뛴다.
  const hasAlpha = decoded.hasAlpha ? probeAlpha(decoded.bitmap) : false

  return {
    name: decoded.name,
    bitmap: decoded.bitmap,
    hasAlpha,
    warning: decoded.warning,
  }
}

/**
 * 드롭/붙여넣기 페이로드에서 이미지 파일만 추린다.
 * items 와 files 를 모두 훑는다. 클립보드 붙여넣기는 files 가 비고 items 에만 들어오는
 * 브라우저가 있어서 한쪽만 보면 붙여넣기가 조용히 실패한다.
 */
export async function importFromDataTransfer(dt: DataTransfer): Promise<File[]> {
  const out: File[] = []
  const seen = new Set<string>()

  const push = (file: File | null): void => {
    if (!file) return
    if (!isSupportedImageFile(file)) return
    // items 와 files 에 같은 파일이 중복으로 들어오는 경우를 막는다.
    const key = `${file.name}|${file.size}|${file.lastModified}`
    if (seen.has(key)) return
    seen.add(key)
    out.push(file)
  }

  const items = dt.items
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i]
    if (!item || item.kind !== 'file') continue
    push(item.getAsFile())
  }

  const files = dt.files
  for (let i = 0; i < files.length; i += 1) {
    push(files.item(i))
  }

  return out
}

export { decodeImageFile, isSupportedImageFile, SUPPORTED_EXTENSIONS, toErrorMessage } from './decode.ts'
export type { DecodedImage } from './decode.ts'
export { probeAlpha } from './alphaProbe.ts'
