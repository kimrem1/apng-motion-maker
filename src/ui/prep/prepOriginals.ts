/**
 * 다듬기 전 원본 비트맵 보관소.
 *
 * **어디에 보관하는가**: 이 모듈의 모듈 스코프 Map 이다. 문서 스토어에 넣으면
 * undo 스택이 픽셀을 붙잡아 수백 MB 가 되고, assetRegistry 에 넣으면 id 가
 * 하나뿐이라 원본과 처리 결과를 동시에 들 수 없다.
 *
 * 반드시 **사본**을 보관한다. assetRegistry.set 은 교체되는 이전 비트맵을
 * close 하므로, 원본 인스턴스를 그대로 들고 있으면 첫 [적용] 순간 우리 원본이
 * 닫혀서 되돌리기가 영원히 불가능해진다.
 *
 * PrepPanel 안에 있던 것을 여기로 옮겼다. EASY 모드의 원클릭 여백 제거도 같은
 * 보관소를 써야 두 화면의 [되돌리기] 가 같은 원본을 가리킨다.
 *
 * IndexedDB 영속화가 들어오면 이 Map 은 그쪽으로 옮겨간다. 새로고침하면
 * 원본이 사라지므로 지금은 세션 동안만 되돌릴 수 있다.
 */

import { cloneBitmap } from '@/imageprep/bgRemove.ts'
import { assetRegistry } from '@/state/assets.ts'

const prepOriginals = new Map<string, ImageBitmap>()

export async function ensurePrepOriginal(assetId: string): Promise<ImageBitmap> {
  const kept = prepOriginals.get(assetId)
  if (kept) return kept

  const current = assetRegistry.get(assetId)
  if (!current) throw new Error('이 이미지의 픽셀을 찾지 못했습니다.')

  const copy = await cloneBitmap(current)
  // await 사이에 다른 호출이 먼저 넣었을 수 있다. 먼저 들어간 쪽을 정본으로 둔다.
  const raced = prepOriginals.get(assetId)
  if (raced) {
    copy.close()
    return raced
  }
  prepOriginals.set(assetId, copy)
  return copy
}

/** 레이어를 지울 때 호출자가 정리할 수 있게 열어 둔다. */
export function releasePrepOriginal(assetId: string): void {
  const kept = prepOriginals.get(assetId)
  if (!kept) return
  kept.close()
  prepOriginals.delete(assetId)
}
