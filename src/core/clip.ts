/**
 * 레이어 클리핑.
 *
 * "아래 레이어 모양으로 자르기" 다. 켜면 이 레이어는 **바로 아래 레이어가 그린
 * 자리에만** 보인다. 사진을 글자 모양으로 자르거나, 무늬를 도형 안에만 채울 때 쓴다.
 *
 * ---------------------------------------------------------------------------
 * 무엇을 기준으로 자르는가
 * ---------------------------------------------------------------------------
 * 아래 레이어의 **알파**다. 색이 아니다. 그래서 반투명한 가장자리는 반투명하게
 * 잘리고, 글자의 안티에일리어싱이 그대로 살아난다.
 *
 * 기준이 되는 레이어(밑판)는 **같은 폴더 안에서** 찾는다. 폴더 경계를 넘어가면
 * 폴더를 접었다 펴는 것만으로 그림이 달라지고, 무엇보다 폴더 밖의 남의 레이어에
 * 의존하게 되어 순서를 한 칸 바꿀 때마다 결과가 튄다.
 *
 * 여러 장이 연달아 켜져 있으면 **전부 같은 밑판**을 쓴다. 위에서부터 차례로
 * 물려받는 것이 아니다. 포토샵의 클리핑 마스크와 같은 규칙이다.
 *
 * DOM 도 WebGL 도 참조하지 않는다. 렌더러는 여기서 나온 번호만 읽는다.
 */

import type { ResolvedLayer } from './types.ts'

/** 자르기에 참여하는 최소한의 정보. 테스트가 레이어 전체를 만들지 않아도 되게 한다. */
export interface ClipInput {
  clipToBelow?: boolean
  folderId?: string
  visible: boolean
}

/**
 * 레이어마다 밑판의 번호. 자르지 않는 레이어는 -1 이다.
 *
 * 입력은 **그리는 순서(z 오름차순)** 여야 한다. resolveComposition 이 그 순서로 준다.
 */
export function clipBaseIndexes(layers: readonly ClipInput[]): number[] {
  const out: number[] = new Array(layers.length).fill(-1)

  for (let i = 0; i < layers.length; i += 1) {
    const layer = layers[i]!
    if (layer.clipToBelow !== true) continue

    /*
     * 아래로 내려가며 밑판을 찾는다.
     *
     * 자르기가 켜진 레이어는 건너뛴다. 연달아 켜져 있으면 전부 같은 밑판을 쓴다.
     * 폴더가 다르면 거기서 멈춘다. 폴더 경계를 넘는 자르기는 만들지 않는다.
     */
    for (let j = i - 1; j >= 0; j -= 1) {
      const candidate = layers[j]!
      if (candidate.folderId !== layer.folderId) break
      if (candidate.clipToBelow === true) continue
      out[i] = j
      break
    }
  }
  return out
}

/**
 * 밑판과 그 위에 붙는 레이어들을 한 덩어리로 묶는다.
 *
 * 렌더러가 쓰는 형태다. 덩어리 하나가 오프스크린 한 장에 그려진 뒤 통째로
 * 누산기에 얹힌다. 자르기가 하나도 없으면 빈 배열이라 옛 문서의 비용이 0 이다.
 */
export interface ClipGroup {
  /** 밑판의 번호. */
  base: number
  /** 밑판 위에 붙는 레이어 번호들. 그리는 순서다. */
  members: number[]
}

export function clipGroups(layers: readonly ClipInput[]): ClipGroup[] {
  const bases = clipBaseIndexes(layers)
  const byBase = new Map<number, number[]>()

  for (let i = 0; i < bases.length; i += 1) {
    const base = bases[i]!
    if (base < 0) continue
    // 보이지 않는 레이어는 덩어리를 만들 이유가 없다. 밑판만 그대로 그려진다.
    if (!layers[i]!.visible) continue
    const list = byBase.get(base)
    if (list) list.push(i)
    else byBase.set(base, [i])
  }

  return [...byBase.entries()]
    .map(([base, members]) => ({ base, members }))
    .sort((a, b) => a.base - b.base)
}

/** 이 문서에 자르기가 하나라도 있는가. 없으면 렌더러가 경로를 통째로 건너뛴다. */
export function hasClipping(layers: readonly ResolvedLayer[]): boolean {
  return layers.some((l) => l.clipToBelow === true && l.visible)
}
