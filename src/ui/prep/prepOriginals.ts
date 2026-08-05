/**
 * 다듬기 전 원본 비트맵 보관소.
 *
 * 어디에 보관하는가: 이 모듈의 모듈 스코프 Map 이다. 문서 스토어에 넣으면
 * undo 스택이 픽셀을 붙잡아 수백 MB 가 되고, assetRegistry 에 넣으면 id 가
 * 하나뿐이라 원본과 처리 결과를 동시에 들 수 없다.
 *
 * 반드시 사본을 보관한다. assetRegistry.set 은 교체되는 이전 비트맵을
 * close 하므로, 원본 인스턴스를 그대로 들고 있으면 첫 [적용] 순간 우리 원본이
 * 닫혀서 되돌리기가 영원히 불가능해진다.
 *
 * PrepPanel 안에 있던 것을 여기로 옮겼다. EASY 모드의 원클릭 여백 제거도 같은
 * 보관소를 써야 두 화면의 [되돌리기] 가 같은 원본을 가리킨다.
 *
 * 세 가지를 보관한다
 *
 *   original : 손대기 전 픽셀. [되돌리기] 의 목적지다.
 *   base     : 배경 제거까지 반영한 픽셀. 자르기의 소스다. 없으면 original.
 *   canvas   : original 을 보관한 순간의 캔버스 크기. [되돌리기] 가 여기로 되돌린다.
 *
 * base 가 따로 있어야 하는 이유. 자르기가 언제나 original 을 소스로 쓰면, PRO 에서
 * 배경을 지운 뒤 EASY 에서 여백을 한 번 자르는 것만으로 지웠던 배경이 되살아난다.
 * base 는 반드시 original 과 같은 크기여야 한다. 자르기 좌표계가 원본 기준이라
 * 크기가 달라지면 상자가 어긋난다. 그래서 크롭 전 단계에서만 등록한다.
 *
 * canvas 를 여기 두는 이유. 호출부(QuickCrop / EasyMode)가 각자 '직전 캔버스' 를
 * 들고 있으면 두 번 자를 때 픽셀은 원본까지 한 번에 되감기는데 캔버스는 한 단계만
 * 되감겨 그림이 프레임 밖으로 삐져나온다. 원본과 같은 수명으로 묶어야 둘이 맞는다.
 *
 * IndexedDB 영속화가 들어오면 이 Map 은 그쪽으로 옮겨간다. 새로고침하면
 * 원본이 사라지므로 지금은 세션 동안만 되돌릴 수 있다.
 */

import { cloneBitmap } from '@/imageprep/bgRemove.ts'
import { assetRegistry } from '@/state/assets.ts'
import { useDocumentStore } from '@/state/document.ts'

const prepOriginals = new Map<string, ImageBitmap>()
const prepBases = new Map<string, ImageBitmap>()
const prepCanvases = new Map<string, { w: number; h: number }>()

export async function ensurePrepOriginal(assetId: string): Promise<ImageBitmap> {
  const kept = prepOriginals.get(assetId)
  if (kept) return kept

  const current = assetRegistry.get(assetId)
  if (!current) throw new Error('이 이미지의 픽셀을 찾지 못했습니다.')

  // await 이전에 떠야 한다. 자르기가 캔버스를 줄인 뒤의 값이 들어가면 안 된다.
  const snap = useDocumentStore.getState().doc.canvas
  const canvasAtKeep = { w: snap.w, h: snap.h }

  const copy = await cloneBitmap(current)
  // await 사이에 다른 호출이 먼저 넣었을 수 있다. 먼저 들어간 쪽을 정본으로 둔다.
  const raced = prepOriginals.get(assetId)
  if (raced) {
    copy.close()
    return raced
  }
  prepOriginals.set(assetId, copy)
  prepCanvases.set(assetId, canvasAtKeep)
  return copy
}

/**
 * 배경 제거까지 반영한 베이스를 등록한다. null 이면 지운다.
 *
 * 넘기는 비트맵은 크롭 전 이어야 한다. 원본과 크기가 다르면 자르기 상자의
 * 좌표계가 어긋난다.
 */
export function setPrepBase(assetId: string, bitmap: ImageBitmap | null): void {
  const prev = prepBases.get(assetId)
  if (prev && prev !== bitmap) prev.close()
  if (bitmap) prepBases.set(assetId, bitmap)
  else prepBases.delete(assetId)
}

/** 자르기의 픽셀 소스. 베이스가 없으면 원본으로 떨어진다. */
export async function ensurePrepBase(assetId: string): Promise<ImageBitmap> {
  const base = prepBases.get(assetId)
  if (base) return base
  return ensurePrepOriginal(assetId)
}

/** 원본을 보관한 순간의 캔버스 크기. 되돌리기가 이 값으로 되돌린다. */
export function getPrepOriginalCanvas(assetId: string): { w: number; h: number } | null {
  return prepCanvases.get(assetId) ?? null
}

/** 레이어를 지울 때 호출자가 정리할 수 있게 열어 둔다. */
export function releasePrepOriginal(assetId: string): void {
  setPrepBase(assetId, null)
  prepCanvases.delete(assetId)
  const kept = prepOriginals.get(assetId)
  if (!kept) return
  kept.close()
  prepOriginals.delete(assetId)
}

/**
 * 보관본을 통째로 버린다. 문서를 갈아 끼울 때 쓴다.
 *
 * 에셋 id 는 세션 카운터라 다른 프로젝트 파일에서도 'a1' 이 나온다. 지우지 않으면
 * 새로 연 사진의 다듬기 미리보기에 이전 사진이 뜨고, [적용] 하는 순간 캔버스의
 * 그림이 그 옛 사진으로 바뀐다. 세션 누수도 이 한 곳에서 함께 막힌다.
 */
export function clearPrepOriginals(): void {
  for (const bmp of prepBases.values()) bmp.close()
  prepBases.clear()
  for (const bmp of prepOriginals.values()) bmp.close()
  prepOriginals.clear()
  prepCanvases.clear()
}
