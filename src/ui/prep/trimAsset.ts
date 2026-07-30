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
import { autoTrimContent, cropBitmap, roundRect, type CropRect } from '@/imageprep/crop.ts'
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
  /** 잘라낸 원본 픽셀 크기. */
  width: number
  height: number
  /** 자른 뒤의 캔버스 크기. 표시 배율이 1 이 아니면 위의 픽셀 크기와 다르다. */
  canvas: CanvasSize
  /**
   * 자르기 전 캔버스 크기. 되돌릴 때 이 값으로 되돌린다.
   *
   * updateAssetPrep 은 일부러 히스토리에 쌓지 않는다(픽셀과 어긋나기 때문에).
   * 그래서 Ctrl+Z 로는 픽셀이 안 돌아온다. 되돌리기 경로를 따로 줘야 한다.
   */
  previousCanvas: CanvasSize
}

/**
 * 자른 결과에 맞출 캔버스 크기.
 *
 * 잘라낸 픽셀 크기를 그대로 쓰면 안 된다. 사용자가 크기(해상도)를 낮춰 둔 상태라면
 * 그림은 원본 픽셀이 아니라 그 배율로 그려지고 있다 (Layer.baseScale). 그때
 * 원본 크기로 캔버스를 잡으면 잘라낸 그림이 프레임의 일부만 채우고 나머지가 빈다.
 *
 * 배율이 1 이면(대부분) 잘라낸 크기 그대로다. 이 함수가 하는 일은 "해상도를
 * 낮춰 둔 사람의 선택을 자르기가 조용히 되돌리지 않게" 하는 것뿐이다.
 */
export function canvasForCrop(assetId: string, width: number, height: number): CanvasSize {
  const layer = useDocumentStore.getState().doc.layers.find((l) => l.assetId === assetId)
  const raw = layer?.baseScale
  // baseScale 은 fit 이 '원본 크기'인 레이어에만 붙는다. 나머지는 fit 기준 배율이
  // 이미 캔버스를 따라가므로 여기서 곱하면 두 번 적용된다.
  const k = typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : 1
  return { w: Math.max(1, Math.round(width * k)), h: Math.max(1, Math.round(height * k)) }
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
      canvas: previousCanvas,
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
  const canvas = canvasForCrop(assetId, cropped.width, cropped.height)
  // 원본 픽셀 자체가 작아졌다. 그림도 이미 그만큼 줄었으므로 표시 배율은 건드리지 않는다.
  if (fitCanvas) store.setCanvasSize(canvas.w, canvas.h)

  return {
    trimmed: true,
    width: cropped.width,
    height: cropped.height,
    canvas: fitCanvas ? canvas : previousCanvas,
    previousCanvas,
  }
}

/**
 * 사용자가 직접 정한 영역으로 자른다.
 *
 * trimAssetMargins 와 같은 두 규칙(픽셀+문서 동시 갱신, 캔버스 맞추기)을 따르되
 * 영역만 밖에서 받는다. 자동 여백 찾기와 직접 자르기가 서로 다른 경로로
 * 문서를 건드리면, 한쪽만 고쳤을 때 나머지 한쪽에서 오버스캔이 옛 크기를 쓴다.
 *
 * 자를 영역은 **다듬기 보관본(원본) 좌표계**다. 매번 원본에서 다시 자르므로
 * 여러 번 자르면서 화질이 겹쳐 나빠지지 않고, 되돌리기도 한 번에 끝난다.
 */
export async function cropAssetTo(
  assetId: string,
  rect: CropRect,
  options: { fitCanvas?: boolean } = {},
): Promise<TrimMarginsResult> {
  const fitCanvas = options.fitCanvas ?? true
  const original = await ensurePrepOriginal(assetId)
  const before = useDocumentStore.getState().doc.canvas
  const previousCanvas: CanvasSize = { w: before.w, h: before.h }

  const safe = roundRect(rect, original.width, original.height)
  const cropped = await cropBitmap(original, safe)
  const hasAlpha = probeAlpha(cropped)
  assetRegistry.set(assetId, cropped)

  const store = useDocumentStore.getState()
  store.updateAssetPrep(assetId, {
    width: cropped.width,
    height: cropped.height,
    hasAlpha,
    prep: { crop: [safe.x, safe.y, cropped.width, cropped.height] },
  })
  const canvas = canvasForCrop(assetId, cropped.width, cropped.height)
  // 원본 픽셀 자체가 작아졌다. 그림은 이미 그만큼 줄었으므로 표시 배율은 건드리지 않는다.
  if (fitCanvas) store.setCanvasSize(canvas.w, canvas.h)

  return {
    trimmed: cropped.width !== original.width || cropped.height !== original.height,
    width: cropped.width,
    height: cropped.height,
    canvas: fitCanvas ? canvas : previousCanvas,
    previousCanvas,
  }
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
