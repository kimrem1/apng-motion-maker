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
 * ---------------------------------------------------------------------------
 * 폴더도 자를 수 있고 폴더로 자를 수도 있다
 * ---------------------------------------------------------------------------
 * 폴더가 잘리는 쪽이면 **폴더 안의 그림 전체**가 한 장처럼 잘린다. 폴더가 밑판이면
 * **폴더 안의 그림 전체가 마스크**가 된다. 그래서 "도형 여러 장으로 만든 모양"
 * 안에만 사진을 채우는 것이 된다.
 *
 * 그래서 밑판은 **형제 중에서** 찾는다. 바로 앞 배열 원소가 아니다. 앞의 형제가
 * 폴더면 그 폴더의 식구들이 사이에 끼어 있는데, 그것들은 형제가 아니라 남의 집
 * 안이다. 건너뛰고 형제까지 내려가야 한다.
 *
 * 여러 장이 연달아 켜져 있으면 **전부 같은 밑판**을 쓴다. 위에서부터 물려받는
 * 것이 아니다. 포토샵의 클리핑 마스크와 같은 규칙이다.
 *
 * DOM 도 WebGL 도 참조하지 않는다. 렌더러는 여기서 나온 번호만 읽는다.
 */

import type { ResolvedLayer } from './types.ts'

/** 자르기에 참여하는 최소한의 정보. 테스트가 레이어 전체를 만들지 않아도 되게 한다. */
export interface ClipInput {
  /** ResolvedLayer 와 같은 이름이다. 렌더러가 배열을 그대로 넘길 수 있어야 한다. */
  layerId: string
  clipToBelow?: boolean
  folderId?: string
  isFolder?: boolean
  visible: boolean
}

/** 폴더 사슬을 타다 순환이나 깊이 상한을 만나면 멈춘다. */
const MAX_DEPTH = 16

/**
 * i 번이 folderIndex 번 폴더 안에 (몇 겹이든) 들어 있는가.
 */
function isInside(
  layers: readonly ClipInput[],
  indexById: ReadonlyMap<string, number>,
  i: number,
  folderIndex: number,
): boolean {
  const folderId = layers[folderIndex]!.layerId
  let cursor = layers[i]!.folderId
  for (let depth = 0; cursor !== undefined && depth < MAX_DEPTH; depth += 1) {
    if (cursor === folderId) return true
    const next = indexById.get(cursor)
    if (next === undefined) return false
    cursor = layers[next]!.folderId
  }
  return false
}

/**
 * 레이어마다 자기 덩어리의 마지막 번호.
 *
 * 폴더가 아니면 자기 자신이다. 폴더면 **안에 든 것의 끝**이다. 폴더 식구는 폴더
 * 바로 뒤에 붙어 있으므로(state/document.ts normalizeFolderOrder) 앞으로 훑기만
 * 하면 된다.
 */
export function subtreeEnds(layers: readonly ClipInput[]): number[] {
  const indexById = new Map(layers.map((l, i) => [l.layerId, i]))
  const out: number[] = layers.map((_, i) => i)

  for (let i = 0; i < layers.length; i += 1) {
    if (!layers[i]!.isFolder) continue
    let end = i
    for (let j = i + 1; j < layers.length; j += 1) {
      if (!isInside(layers, indexById, j, i)) break
      end = j
    }
    out[i] = end
  }
  return out
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
     * 아래로 내려가며 **형제**를 찾는다.
     *
     *   - 폴더 아이디가 같으면 형제다. 그것이 자르기를 켜 뒀으면 건너뛰고 더 내려간다.
     *     연달아 켜져 있으면 전부 같은 밑판을 쓰기 때문이다.
     *   - 폴더 아이디가 다르면 앞 형제(폴더)의 **안쪽**이다. 형제가 아니므로 건너뛴다.
     *   - 부모 폴더 자신을 만나면 이 집의 첫 자리라는 뜻이다. 더 내려가면 폴더 밖이
     *     되므로 멈춘다. 폴더 경계를 넘는 자르기는 만들지 않는다.
     */
    for (let j = i - 1; j >= 0; j -= 1) {
      const candidate = layers[j]!
      if (layer.folderId !== undefined && candidate.layerId === layer.folderId) break
      if (candidate.folderId !== layer.folderId) continue
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
  /** 밑판이 폴더면 그 안쪽의 마지막 번호. 아니면 base 와 같다. */
  baseEnd: number
  /** 밑판 위에 붙는 레이어 번호들. 그리는 순서다. */
  members: number[]
  /** 이 덩어리가 차지하는 마지막 번호. 렌더러는 여기까지 건너뛴다. */
  end: number
}

export function clipGroups(layers: readonly ClipInput[]): ClipGroup[] {
  const bases = clipBaseIndexes(layers)
  const ends = subtreeEnds(layers)
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
    .map(([base, members]) => ({
      base,
      baseEnd: ends[base] ?? base,
      members,
      // 마지막 식구의 덩어리 끝까지가 이 그룹의 범위다.
      end: Math.max(ends[base] ?? base, ...members.map((m) => ends[m] ?? m)),
    }))
    .sort((a, b) => a.base - b.base)
}

/** 이 문서에 자르기가 하나라도 있는가. 없으면 렌더러가 경로를 통째로 건너뛴다. */
export function hasClipping(layers: readonly ResolvedLayer[]): boolean {
  return layers.some((l) => l.clipToBelow === true && l.visible)
}
