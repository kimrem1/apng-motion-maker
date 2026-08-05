/**
 * 프로젝트 파일 저장/열기와 세션 연결.
 *
 * format.ts 는 바이트만 다루고, 여기서 브라우저와 앱 상태에 붙인다.
 * showSaveFilePicker / showOpenFilePicker 가 있으면 쓰고, 없으면 <a download> 와
 * <input type=file> 로 내려간다.
 */

import { assetRegistry } from '@/state/assets.ts'
import { useDocumentStore } from '@/state/document.ts'
import { advanceIdCounter, maxIdOrdinal } from '@/core/factory.ts'
import { bitmapFromImageData, bleedEdgeColors, readPixels } from '@/imageprep/bgRemove.ts'
import type { MotionProject } from '@/core/types.ts'
// 패널이 아니라 비트맵 보관소다. React 도 DOM 패널도 참조하지 않는다.
import { clearPrepOriginals } from '@/ui/prep/prepOriginals.ts'

import {
  PROJECT_EXT,
  PROJECT_MIME,
  ensureProjectExtension,
  readProjectBundle,
  serializeProject,
  type ProjectBundle,
  type ReadProjectResult,
} from './format.ts'

// ---------------------------------------------------------------------------
// 파일 피커 타입
// ---------------------------------------------------------------------------

// showSaveFilePicker / showOpenFilePicker 는 아직 표준 lib.dom 에 없다. 쓰는 부분만 좁게 선언한다.
interface FilePickerAccept {
  description?: string
  accept: Record<string, string[]>
}

type SaveFilePicker = (options: {
  suggestedName?: string
  types?: FilePickerAccept[]
}) => Promise<FileSystemFileHandle>

type OpenFilePicker = (options: {
  types?: FilePickerAccept[]
  multiple?: boolean
  excludeAcceptAllOption?: boolean
}) => Promise<FileSystemFileHandle[]>

interface PickerWindow {
  showSaveFilePicker?: SaveFilePicker
  showOpenFilePicker?: OpenFilePicker
}

const PICKER_TYPES: FilePickerAccept[] = [
  { description: '모션 메이커 프로젝트', accept: { [PROJECT_MIME]: [`.${PROJECT_EXT}`] } },
]

/** 사용자가 창을 닫은 것은 실패가 아니다. */
function isAbort(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || err.name === 'NotAllowedError')
}

/**
 * Blob 은 SharedArrayBuffer 위의 뷰를 받지 않는다고 선언되어 있고, Uint8Array 의 버퍼
 * 종류는 타입만 봐서는 알 수 없다. 우리 바이트는 언제나 일반 ArrayBuffer 다.
 */
function toBlobPart(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer
}

// ---------------------------------------------------------------------------
// 픽셀 <-> PNG
// ---------------------------------------------------------------------------

/**
 * 디코드 옵션. imageprep/decode.ts 와 같은 값이어야 한다.
 * 색공간 변환과 프리멀티플라이를 브라우저 기본값에 맡기면 같은 파일이 환경마다
 * 다른 픽셀이 되고, 미리보기와 내보내기가 어긋난다. 결정론의 전제다.
 */
const BITMAP_OPTIONS: ImageBitmapOptions = {
  colorSpaceConversion: 'none',
  premultiplyAlpha: 'none',
  imageOrientation: 'from-image',
}

/**
 * 비트맵을 PNG 바이트로.
 *
 * **알려진 손실이 둘 있다.** 2D 캔버스 백킹 스토어가 premultiplied 8비트이기 때문이다.
 *
 *   1. 반투명 픽셀의 RGB 정밀도가 조금 깎인다 (a=0.1 이면 사실상 4비트 색).
 *   2. 알파 0 픽셀의 RGB 는 통째로 0 이 된다. 이쪽이 눈에 보이는 손실이다.
 *      배경 제거가 심어 둔 색 번짐 방지(bgRemove.ts bleedEdgeColors)가 저장 한 번에
 *      취소되고, 다시 연 그림을 축소/회전하면 어두운 테두리가 생긴다.
 *
 * 2번은 여는 쪽에서 같은 계산을 다시 돌려 되살린다(healTransparentColors).
 * 1번을 없애려면 원본 파일 바이트를 들고 있거나 WebGL 로 읽어야 하는데, 지금
 * 파이프라인은 디코드 후 비트맵만 남긴다.
 */
export async function bitmapToPng(bitmap: ImageBitmap): Promise<Uint8Array> {
  const blob = await bitmapToPngBlob(bitmap)
  return new Uint8Array(await blob.arrayBuffer())
}

async function bitmapToPngBlob(bitmap: ImageBitmap): Promise<Blob> {
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
    const ctx = canvas.getContext('2d', { alpha: true })
    if (ctx) {
      ctx.drawImage(bitmap, 0, 0)
      return await canvas.convertToBlob({ type: 'image/png' })
    }
  }

  // OffscreenCanvas 가 없는 환경(구형 사파리)용 폴백.
  const canvas = document.createElement('canvas')
  canvas.width = bitmap.width
  canvas.height = bitmap.height
  const ctx = canvas.getContext('2d', { alpha: true })
  if (!ctx) throw new Error('이미지를 저장할 수 없습니다. 캔버스를 만들지 못했습니다.')
  ctx.drawImage(bitmap, 0, 0)

  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, 'image/png')
  })
  if (!blob) throw new Error('이미지를 PNG 로 바꾸지 못했습니다.')
  return blob
}

export async function pngToBitmap(bytes: Uint8Array): Promise<ImageBitmap> {
  const blob = new Blob([toBlobPart(bytes)], { type: 'image/png' })
  return await createImageBitmap(blob, BITMAP_OPTIONS)
}

/**
 * 배경을 지운 그림의 **투명 픽셀 색을 되살린다.**
 *
 * 저장 경로가 그 값을 지운다. bitmapToPngBlob 은 2D 캔버스를 거치는데 그 백킹
 * 스토어는 premultiplied 8비트라, 알파 0 픽셀의 RGB 는 구조적으로 0 이 된다
 * (bgRemove.ts readPixels 주석이 같은 사실을 적어 두었다). 그래서 배경 제거가
 * 심어 둔 색 번짐 방지(bleedEdgeColors)가 저장 한 번에 취소되고, 다시 연 그림에
 * 축소나 회전을 걸면 GPU 이중선형 보간이 그 검정을 가장자리로 끌어와 어두운
 * 테두리가 생긴다.
 *
 * 원래 값을 복원할 수는 없다. 대신 **같은 계산을 다시 돌린다.** bleedEdgeColors 는
 * 이웃한 불투명 픽셀에서 색을 채우는 순수 함수이므로, 저장 전에 돌렸든 지금
 * 돌리든 같은 결과가 나온다.
 *
 * 배경을 지운 적이 있는 에셋에만 돌린다. 전부 불투명한 그림에는 할 일이 없고
 * (bleedEdgeColors 가 곧바로 빠져나온다), 픽셀을 한 번 읽는 비용만 남기 때문이다.
 */
async function healTransparentColors(bitmap: ImageBitmap): Promise<ImageBitmap> {
  try {
    const image = readPixels(bitmap)
    bleedEdgeColors(image.data, image.width, image.height)
    return await bitmapFromImageData(image)
  } catch {
    // 픽셀을 못 읽는 환경이면 그냥 원본을 쓴다. 가장자리가 조금 어두울 뿐이다.
    return bitmap
  }
}

// ---------------------------------------------------------------------------
// 세션 <-> 번들
// ---------------------------------------------------------------------------

/** 현재 문서와 에셋 픽셀을 한 덩어리로 모은다. */
export async function collectBundle(): Promise<ProjectBundle> {
  const doc = useDocumentStore.getState().doc
  const assets = new Map<string, Uint8Array>()

  // 문서의 에셋 순서대로 넣는다. 같은 문서가 항상 같은 파일이 되도록.
  for (const ref of doc.assets) {
    const bitmap = assetRegistry.get(ref.id)
    if (!bitmap) continue
    assets.set(ref.id, await bitmapToPng(bitmap))
  }
  return { doc, assets }
}

export interface ApplyBundleResult {
  /** 픽셀을 복원하지 못한 에셋. 해당 레이어는 비어 보인다. */
  missingAssetIds: string[]
}

/**
 * 문서를 교체하고 비트맵을 복원한다.
 *
 * 픽셀을 먼저 올리고 문서를 나중에 바꾼다. 순서를 뒤집으면 렌더러가 텍스처 없는
 * 문서를 한 프레임 그려서 화면이 한 번 깜빡인다.
 */
export async function applyBundle(bundle: ProjectBundle): Promise<ApplyBundleResult> {
  const missingAssetIds: string[] = []
  const decoded = new Map<string, ImageBitmap>()

  for (const ref of bundle.doc.assets) {
    const png = bundle.assets.get(ref.id)
    if (!png || png.length === 0) {
      missingAssetIds.push(ref.id)
      continue
    }
    try {
      const bitmap = await pngToBitmap(png)
      decoded.set(
        ref.id,
        ref.prep?.bgRemove?.enabled === true ? await healTransparentColors(bitmap) : bitmap,
      )
    } catch {
      missingAssetIds.push(ref.id)
    }
  }

  const previous = useDocumentStore.getState().doc
  for (const [id, bitmap] of decoded) assetRegistry.set(id, bitmap)

  reserveIdCounter(bundle.doc)
  useDocumentStore.getState().replaceDocument(bundle.doc)

  /*
   * 문서를 통째로 갈았다. 이전 문서의 다듬기 보관본은 id 가 같아도 다른 그림이다.
   *
   * 에셋 id 는 세션 카운터라 다른 파일에서도 첫 에셋이 'a1' 이다. 안 지우면 새로 연
   * 사진의 다듬기 미리보기에 이전 사진이 뜨고, [적용] 하는 순간 캔버스가 그 옛 사진으로
   * 바뀐다. 세션 내내 회수되지 않던 전체 해상도 사본도 여기서 함께 놓인다.
   */
  clearPrepOriginals()

  // 이전 문서에만 있던 픽셀을 놓아준다. 안 하면 파일을 열 때마다 메모리가 쌓인다.
  const keep = new Set(bundle.doc.assets.map((a) => a.id))
  for (const ref of previous.assets) {
    if (!keep.has(ref.id)) assetRegistry.delete(ref.id)
  }

  // 복원하지 못한 id 의 옛 픽셀도 버린다. id 만 같고 내용이 다른 그림이
  // 남아 있으면 빈 자리보다 나쁘다. 엉뚱한 이미지가 그려진다.
  for (const id of missingAssetIds) assetRegistry.delete(id)

  return { missingAssetIds }
}

export async function restoreBundle(bundle: ProjectBundle): Promise<void> {
  await applyBundle(bundle)
}

/**
 * 파일에서 온 id 와 앞으로 만들 id 가 겹치지 않게 카운터를 앞으로 감는다.
 *
 * nextId 는 세션 단위 단조 카운터라 새로 켠 탭에서 0 부터 시작한다. 'l3' 까지 쓴 파일을
 * 열고 레이어를 추가하면 다시 'l1' 이 나와 두 레이어가 같은 id 를 갖는다.
 * 그 뒤로는 조회가 엉뚱한 레이어를 집고 실행취소 패치가 어긋난다.
 */
function reserveIdCounter(doc: MotionProject): void {
  const ids: string[] = []
  const scan = (id: string | null | undefined): void => {
    if (id) ids.push(id)
  }

  for (const asset of doc.assets) scan(asset.id)
  for (const layer of doc.layers) {
    scan(layer.id)
    for (const track of layer.tracks) scan(track.id)
    for (const mod of layer.modifiers) scan(mod.id)
    for (const fx of layer.effects) scan(fx.id)
  }

  /*
   * 읽는 규칙과 감는 방법을 둘 다 core/factory.ts 에 맡긴다.
   *
   * 예전에는 여기서 정규식을 다시 적었고 그것이 틀렸다. `[a-z]+` 가 36진수 순번의
   * 앞 글자를 접두어로 먹어(순번 360 이 'a0' 이다) 최대치가 359 에서 멈췄다.
   * 그리고 카운터를 nextId('z') 로 한 칸씩 뽑아 가며 감았는데, 상한(10만)에 걸리면
   * 조용히 포기하는 데다 감는 방법이 이미 advanceIdCounter 로 있었다.
   *
   * 다 감기지 않으면 파일을 연 뒤 발급한 id 가 문서 안의 id 와 겹친다. 그러면
   * 조회가 엉뚱한 레이어를 집고, 다시 저장했다 열 때 migrate 가 중복 id 를 새로
   * 매기면서 folderId 가 가리키던 자리를 잃어 레이어가 폴더에서 튕겨 나온다.
   */
  advanceIdCounter(maxIdOrdinal(ids))
}

/** 저장 창에 넣을 기본 이름. 첫 레이어 이름을 쓴다. */
export function suggestProjectName(doc: MotionProject = useDocumentStore.getState().doc): string {
  const first = doc.layers[0]?.name?.trim()
  const base = first && first.length > 0 ? first : '무제'
  // 파일 이름에 쓸 수 없는 문자만 걷어낸다.
  const safe = base.replace(/[\\/:*?"<>|]/g, '_').slice(0, 60)
  return ensureProjectExtension(safe)
}

// ---------------------------------------------------------------------------
// 저장
// ---------------------------------------------------------------------------

function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.rel = 'noopener'
  link.style.display = 'none'
  document.body.appendChild(link)
  link.click()
  link.remove()
  // 곧바로 해제하면 일부 브라우저에서 다운로드가 취소된다. 넉넉히 두고 놓아준다.
  window.setTimeout(() => {
    URL.revokeObjectURL(url)
  }, 10000)
}

/** 저장했으면 true, 사용자가 창을 닫았으면 false. 실패는 던진다. */
export async function saveProjectToFile(bundle: ProjectBundle, suggestedName: string): Promise<boolean> {
  const bytes = serializeProject(bundle)
  const name = ensureProjectExtension(suggestedName)
  const blob = new Blob([toBlobPart(bytes)], { type: PROJECT_MIME })

  const picker = (window as unknown as PickerWindow).showSaveFilePicker
  if (picker) {
    try {
      const handle = await picker({ suggestedName: name, types: PICKER_TYPES })
      const writable = await handle.createWritable()
      await writable.write(blob)
      await writable.close()
      return true
    } catch (err) {
      if (isAbort(err)) return false
      // 그 밖의 실패는 폴백으로 내려간다. 여기서 멈추면 저장할 방법이 사라진다.
    }
  }

  downloadBlob(blob, name)
  return true
}

// ---------------------------------------------------------------------------
// 열기
// ---------------------------------------------------------------------------

function pickWithInput(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = `.${PROJECT_EXT},application/zip`
    input.style.display = 'none'

    let settled = false
    const finish = (file: File | null): void => {
      if (settled) return
      settled = true
      window.removeEventListener('focus', onFocus)
      input.remove()
      resolve(file)
    }

    /**
     * cancel 이벤트가 없는 브라우저 대비.
     * 창이 다시 활성화됐는데도 파일이 없으면 사용자가 닫은 것이다.
     * 이 처리가 없으면 취소했을 때 Promise 가 영원히 안 끝난다.
     */
    function onFocus(): void {
      window.setTimeout(() => {
        if ((input.files?.length ?? 0) === 0) finish(null)
      }, 500)
    }

    input.addEventListener('change', () => {
      finish(input.files?.[0] ?? null)
    })
    input.addEventListener('cancel', () => {
      finish(null)
    })
    window.addEventListener('focus', onFocus)

    document.body.appendChild(input)
    input.click()
  })
}

/** 이미 손에 든 File 을 읽는다. .mmproj 드래그앤드롭이 이 경로를 쓴다. */
export async function readProjectFile(file: File): Promise<ReadProjectResult> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  return readProjectBundle(bytes)
}

/** 사용자가 창을 닫으면 null. 문서를 교체하지는 않는다. 호출부가 확인 후 restoreBundle 을 부른다. */
export async function openProjectFromFile(): Promise<ReadProjectResult | null> {
  const picker = (window as unknown as PickerWindow).showOpenFilePicker
  if (picker) {
    try {
      const handles = await picker({ types: PICKER_TYPES, multiple: false })
      const handle = handles[0]
      if (!handle) return null
      return await readProjectFile(await handle.getFile())
    } catch (err) {
      if (isAbort(err)) return null
      // 피커가 막힌 환경이면 input 폴백으로 내려간다.
    }
  }

  const file = await pickWithInput()
  if (!file) return null
  return await readProjectFile(file)
}
