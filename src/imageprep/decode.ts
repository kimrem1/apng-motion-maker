/**
 * 이미지 파일 디코드.
 *
 * createImageBitmap 의 옵션을 고정하는 것이 결정론의 전제다.
 * 색공간 변환/프리멀티플라이/EXIF 회전을 브라우저 기본값에 맡기면 같은 파일이라도
 * 환경에 따라 픽셀이 달라지고, 미리보기와 내보내기 결과가 어긋난다.
 */

import { CANVAS_MAX } from '@/core/types.ts'

import { maxTextureSize } from './gpuLimit.ts'

/** 지원 확장자. 이 목록 밖은 디코드 시도조차 하지 않는다. */
export const SUPPORTED_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif'] as const

export type SupportedExtension = (typeof SUPPORTED_EXTENSIONS)[number]

/** MIME 만 있는 경우(클립보드 붙여넣기)를 위한 역매핑. */
const MIME_TO_EXT: Record<string, SupportedExtension> = {
  'image/png': 'png',
  'image/apng': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
  'image/x-ms-bmp': 'bmp',
  'image/x-windows-bmp': 'bmp',
  'image/avif': 'avif',
}

/**
 * 포맷상 알파 채널을 가질 수 있는 확장자.
 * JPEG 는 알파가 없으므로 픽셀 검사를 건너뛴다 (큰 사진에서 유의미한 절약).
 * BMP 는 32비트일 때 알파를 가질 수 있어 검사 대상에 넣는다.
 */
const ALPHA_CAPABLE = new Set<SupportedExtension>(['png', 'webp', 'gif', 'bmp', 'avif'])

/**
 * 축소 상한의 절대 천장. 캔버스 상한의 두 배다.
 *
 * 기기가 16384 를 받아 준다고 해서 16384px 사진을 그대로 들고 있을 이유는 없다.
 * 두 배로 잡는 이유는 크롭 때문이다. 절반 영역을 잘라내도 캔버스 상한만 한
 * 해상도가 남는다. 그 위는 메모리만 먹고 결과에 기여하지 않는다.
 * (CANVAS_MAX 가 2048 이던 시절의 상한 4096 과 같은 비율이다.)
 *
 * 대가는 메모리다. 8000x8000 원본은 텍스처 256MB 에, 다듬기 보관본까지 더해진다.
 * 그래서 천장을 여기서 한 번 더 누른다.
 */
const LONG_SIDE_CEILING = CANVAS_MAX * 2

/**
 * 이 길이를 넘으면 축소해서 불러온다.
 *
 * 기기의 MAX_TEXTURE_SIZE 를 넘으면 텍스처 업로드가 실패하므로 상한은 실측값을
 * 따른다. 상한을 상수로 박으면 4000px 캔버스에 쓸 큰 사진을 임포트 시점에 이미
 * 뭉개 놓고 그 뒤에 크롭을 하게 된다.
 */
function maxLongSide(): number {
  return Math.min(LONG_SIDE_CEILING, maxTextureSize())
}

/** 결정론을 위한 고정 옵션. 절대 바꾸지 마라. */
const BITMAP_OPTIONS: ImageBitmapOptions = {
  colorSpaceConversion: 'none',
  premultiplyAlpha: 'none',
  imageOrientation: 'from-image',
}

export interface DecodedImage {
  bitmap: ImageBitmap
  /** 포맷 기준 1차 판정. 실제 픽셀 검사는 probeAlpha 가 맡는다. */
  hasAlpha: boolean
  name: string
  /** 디코드는 성공했지만 사용자에게 알릴 내용이 있을 때만 채워진다. */
  warning?: string
}

/** unknown 을 안전하게 사람이 읽을 문자열로 바꾼다. */
export function toErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  return String(err)
}

function extensionFromName(name: string): string | null {
  const dot = name.lastIndexOf('.')
  if (dot < 0 || dot === name.length - 1) return null
  return name.slice(dot + 1).toLowerCase()
}

function isSupportedExtension(ext: string | null): ext is SupportedExtension {
  if (!ext) return false
  return (SUPPORTED_EXTENSIONS as readonly string[]).includes(ext)
}

interface ResolvedSource {
  ext: SupportedExtension
  name: string
}

/**
 * 확장자와 MIME 을 함께 본다.
 * 확장자가 우선이지만, 클립보드에서 온 Blob 은 이름이 없으므로 MIME 으로 되돌아간다.
 */
function resolveSource(file: File | Blob): ResolvedSource | null {
  const rawName = file instanceof File ? file.name : ''
  const byName = rawName ? extensionFromName(rawName) : null
  if (isSupportedExtension(byName)) {
    return { ext: byName, name: rawName }
  }

  const mime = (file.type || '').toLowerCase()
  const byMime = MIME_TO_EXT[mime]
  if (byMime) {
    return { ext: byMime, name: rawName || `붙여넣은 이미지.${byMime}` }
  }
  return null
}

/** 드롭/붙여넣기에서 이미지가 아닌 파일을 걸러낼 때 쓴다. 디코드는 하지 않는다. */
export function isSupportedImageFile(file: File | Blob): boolean {
  return resolveSource(file) !== null
}

function describeUnsupported(file: File | Blob): string {
  const rawName = file instanceof File ? file.name : ''
  const shown = extensionFromName(rawName) ?? file.type ?? ''
  const label = shown ? `'${shown}'` : '알 수 없는 형식'
  return `지원하지 않는 이미지 형식입니다: ${label}. PNG, JPG, WEBP, GIF, BMP, AVIF 만 사용할 수 있습니다.`
}

/**
 * 고정 옵션으로 디코드하고, 브라우저가 옵션 조합을 거부하면 옵션 없이 한 번 더 시도한다.
 * 폴백 경로에서는 결정론이 약해지지만(EXIF 회전/색공간이 브라우저 기본값을 탄다)
 * 임포트 자체가 실패하는 것보다는 낫다.
 */
async function createBitmap(blob: Blob): Promise<{ bitmap: ImageBitmap; fallback: boolean }> {
  try {
    return { bitmap: await createImageBitmap(blob, BITMAP_OPTIONS), fallback: false }
  } catch (first) {
    // 2단계 폴백. 알파 정책만은 양보하지 않는다.
    //
    // ImageBitmap 을 texImage2D 로 올릴 때 UNPACK_PREMULTIPLY_ALPHA_WEBGL 은 무시되고
    // 비트맵 생성 시점의 알파 상태가 그대로 쓰인다. 옵션 없이 만들면 premultiplyAlpha 가
    // 'default' 라 브라우저가 premultiplied 비트맵을 주고, 셰이더가 rgb * a 를 한 번 더
    // 곱해 반투명 영역이 어두워진다. 투명 스티커가 주 용도인 제품에서 이건 치명적이다.
    try {
      return { bitmap: await createImageBitmap(blob, { premultiplyAlpha: 'none' }), fallback: true }
    } catch {
      throw new Error(
        `이미지를 디코드하지 못했습니다. 파일이 손상되었거나 브라우저가 지원하지 않는 형식입니다. (${toErrorMessage(first)})`,
      )
    }
  }
}

/**
 * maxLongSide() 안쪽으로 줄인다.
 * resizeQuality 'high' 는 다운스케일 시 브라우저가 제대로 된 필터를 쓰게 한다.
 */
async function shrinkToLimit(bitmap: ImageBitmap): Promise<ImageBitmap> {
  const limit = maxLongSide()
  const long = Math.max(bitmap.width, bitmap.height)
  if (long <= limit) return bitmap

  const ratio = limit / long
  const w = Math.max(1, Math.round(bitmap.width * ratio))
  const h = Math.max(1, Math.round(bitmap.height * ratio))
  try {
    const resized = await createImageBitmap(bitmap, {
      ...BITMAP_OPTIONS,
      resizeWidth: w,
      resizeHeight: h,
      resizeQuality: 'high',
    })
    bitmap.close()
    return resized
  } catch {
    // 축소에 실패해도 원본으로 계속 간다. 업로드 단계에서 명시적으로 걸린다.
    return bitmap
  }
}

export async function decodeImageFile(file: File | Blob): Promise<DecodedImage> {
  const source = resolveSource(file)
  if (!source) throw new Error(describeUnsupported(file))

  if (file.size === 0) throw new Error('빈 파일입니다. 이미지 데이터가 없습니다.')

  const { bitmap: decoded, fallback } = await createBitmap(file)

  if (decoded.width === 0 || decoded.height === 0) {
    decoded.close()
    throw new Error('이미지 크기가 0입니다. 손상된 파일로 보입니다.')
  }

  const warnings: string[] = []
  const originalW = decoded.width
  const originalH = decoded.height

  const bitmap = await shrinkToLimit(decoded)
  if (bitmap.width !== originalW || bitmap.height !== originalH) {
    warnings.push(
      `이미지가 커서 ${bitmap.width}x${bitmap.height} 로 줄여서 불러왔습니다 (원본 ${originalW}x${originalH}).`,
    )
  }
  if (fallback) {
    warnings.push('브라우저가 표준 디코드 옵션을 거부해 일부 설정을 기본값으로 불러왔습니다. 색이나 회전이 원본과 다를 수 있습니다.')
  }

  return {
    bitmap,
    hasAlpha: ALPHA_CAPABLE.has(source.ext),
    name: source.name,
    warning: warnings.length > 0 ? warnings.join(' ') : undefined,
  }
}
