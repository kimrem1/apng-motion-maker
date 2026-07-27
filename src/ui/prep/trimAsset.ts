/**
 * 원클릭 여백 제거.
 *
 * EASY 모드에는 인스펙터가 없다. PRO 의 [이미지 다듬기] 패널에만 자르기를 두면
 * EASY 사용자는 여백을 영원히 못 지운다. 그래서 파라미터가 하나도 없는 버전을
 * 여기 따로 둔다. 배경 제거는 건드리지 않고 **이미 여백인 것만** 잘라낸다.
 *
 * PrepPanel 의 [적용] 과 같은 규칙 두 가지를 지킨다.
 *   1. 픽셀 교체(assetRegistry.set)와 문서 반영(updateAssetPrep)을 반드시 함께 한다.
 *      픽셀만 바꾸면 AssetRef.naturalW/H 가 실제와 어긋나 오버스캔이 틀린 원본
 *      크기로 계산하고, 회전/이동 프리셋에서 캔버스 모서리가 빈다.
 *   2. 캔버스를 같이 줄인다. 에셋만 자르고 캔버스를 두면 잘라낸 여백이 그대로
 *      프레임의 빈 공간이 되어 결과 파일에 실린다. 사용자 눈에는 아무 일도
 *      안 일어난 것과 같다.
 */

import { cloneBitmap } from '@/imageprep/bgRemove.ts'
import { probeAlpha } from '@/imageprep/alphaProbe.ts'
import { autoTrimContent, cropBitmap } from '@/imageprep/crop.ts'
import { assetRegistry } from '@/state/assets.ts'
import { useDocumentStore } from '@/state/document.ts'

import { ensurePrepOriginal } from './prepOriginals.ts'

export interface CanvasSize {
  w: number
  h: number
}

export interface TrimMarginsResult {
  /** 실제로 잘렸는가. false 면 여백이 없었다는 뜻이다. */
  trimmed: boolean
  width: number
  height: number
  /**
   * 자르기 전 캔버스 크기. 되돌릴 때 이 값으로 되돌린다.
   *
   * updateAssetPrep 은 일부러 히스토리에 쌓지 않는다(픽셀과 어긋나기 때문에).
   * 그래서 Ctrl+Z 로는 픽셀이 안 돌아온다. 되돌리기 경로를 따로 줘야 한다.
   */
  previousCanvas: CanvasSize
}

/**
 * 에셋의 빈 여백을 잘라내고 캔버스를 거기에 맞춘다.
 *
 * 되돌리기는 PrepPanel 의 [되돌리기] 와 같은 보관소를 쓰므로, EASY 에서 자른 뒤
 * PRO 로 넘어가도 원본으로 돌아갈 수 있다.
 */
export async function trimAssetMargins(
  assetId: string,
  options: { fitCanvas?: boolean } = {},
): Promise<TrimMarginsResult> {
  const fitCanvas = options.fitCanvas ?? true
  const original = await ensurePrepOriginal(assetId)
  const before = useDocumentStore.getState().doc.canvas
  const previousCanvas: CanvasSize = { w: before.w, h: before.h }

  const rect = await autoTrimContent(original)
  if (rect.w >= original.width && rect.h >= original.height) {
    return {
      trimmed: false,
      width: original.width,
      height: original.height,
      previousCanvas,
    }
  }

  const cropped = await cropBitmap(original, rect)
  const hasAlpha = probeAlpha(cropped)
  assetRegistry.set(assetId, cropped)

  const store = useDocumentStore.getState()
  store.updateAssetPrep(assetId, {
    width: cropped.width,
    height: cropped.height,
    hasAlpha,
    prep: {
      crop: [Math.round(rect.x), Math.round(rect.y), cropped.width, cropped.height],
    },
  })
  if (fitCanvas) store.setCanvasSize(cropped.width, cropped.height)

  return { trimmed: true, width: cropped.width, height: cropped.height, previousCanvas }
}

/** 다듬기 전 원본 픽셀로 되돌린다. 캔버스 크기를 주면 그것도 같이 되돌린다. */
export async function restoreAssetOriginal(
  assetId: string,
  canvas?: CanvasSize,
): Promise<void> {
  const original = await ensurePrepOriginal(assetId)
  const hasAlpha = probeAlpha(original)
  // 보관본 자체를 넘기면 다음 교체에서 레지스트리가 우리 원본을 닫아 버린다.
  assetRegistry.set(assetId, await cloneBitmap(original))

  const store = useDocumentStore.getState()
  store.updateAssetPrep(assetId, {
    width: original.width,
    height: original.height,
    hasAlpha,
  })
  if (canvas) store.setCanvasSize(canvas.w, canvas.h)
}
