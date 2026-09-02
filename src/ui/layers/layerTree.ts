/**
 * 레이어 목록의 트리 계산. DOM 을 모르는 순수 함수만 둔다.
 *
 * 왜 패널에서 떼어냈는가
 *
 * 두 가지가 손으로 확인하기 어렵다. 폴더가 접혔을 때 어떤 행이 보이는가, 그리고
 * 끌어다 놓은 자리가 문서 배열의 몇 번인가. 둘 다 인덱스 산술이라 한 칸만 틀려도
 * 조용히 엉뚱한 폴더로 들어간다. 순수 함수로 두면 테스트가 잡는다.
 *
 * 두 좌표계
 *
 *   문서 배열 : z 오름차순. 0 이 맨 뒤(가장 먼저 그려짐).
 *   목록 표시 : 위가 앞. 문서 배열을 뒤집은 것이되, 폴더는 **머리행이 식구들 위**다.
 *
 * 폴더 머리행이 위라는 것이 이 파일의 핵심이다. 문서 배열은 폴더가 식구보다 앞
 * (더 뒤쪽 z)이라, 그냥 뒤집으면 머리행이 식구들 **아래**로 내려간다. 포토샵과
 * 피그마를 쓴 사람은 예외 없이 반대를 기대하고, 실제로 그래서 "폴더가 고장 났다"
 * 로 읽혔다. 그리는 순서는 문서 배열이 정하므로 여기서 뒤집어도 그림은 그대로다.
 */

import { MAX_FOLDER_DEPTH } from '@/core/group.ts'
import type { Layer } from '@/core/types.ts'

export interface LayerRow {
  layer: Layer
  /** 폴더 중첩 깊이. 들여쓰기가 이 값만 쓴다. */
  depth: number
  /** 폴더면 안에 든 레이어 수(몇 겹이든). 폴더가 아니면 0. */
  childCount: number
  /** 이 행이 접힌 폴더인가. */
  collapsed: boolean
}

/** 이 레이어가 폴더인가. */
function isFolder(layer: Layer): boolean {
  return layer.type === 'group'
}

/**
 * 목록에 그릴 행들. 위가 앞이고, 접힌 폴더의 식구는 아예 나오지 않는다.
 *
 * 없는 폴더나 자기 자신을 가리키는 folderId 는 최상위로 본다. 문서 스토어의
 * normalizeFolderOrder 와 같은 판정이라 화면과 배열이 갈라지지 않는다.
 */
export function buildLayerRows(
  layers: readonly Layer[],
  collapsed: ReadonlySet<string>,
): LayerRow[] {
  const folderIds = new Set(layers.filter(isFolder).map((l) => l.id))
  const childrenOf = new Map<string, Layer[]>()
  const roots: Layer[] = []

  for (const layer of layers) {
    const parent = layer.folderId
    if (parent === undefined || parent === layer.id || !folderIds.has(parent)) {
      roots.push(layer)
      continue
    }
    const list = childrenOf.get(parent)
    if (list) list.push(layer)
    else childrenOf.set(parent, [layer])
  }

  /** 몇 겹이든 이 폴더 안에 든 레이어 수. */
  const countIn = (id: string, depth: number): number => {
    if (depth > MAX_FOLDER_DEPTH) return 0
    const kids = childrenOf.get(id) ?? []
    let n = kids.length
    for (const kid of kids) n += countIn(kid.id, depth + 1)
    return n
  }

  const rows: LayerRow[] = []
  const seen = new Set<Layer>()

  const emit = (layer: Layer, depth: number): void => {
    if (seen.has(layer) || depth > MAX_FOLDER_DEPTH) return
    seen.add(layer)

    const folder = isFolder(layer)
    const shut = folder && collapsed.has(layer.id)
    rows.push({
      layer,
      depth,
      childCount: folder ? countIn(layer.id, 0) : 0,
      collapsed: shut,
    })
    if (!folder || shut) return
    // 식구도 위가 앞이다. 문서 배열이 z 오름차순이므로 뒤에서부터 낸다.
    const kids = childrenOf.get(layer.id) ?? []
    for (let i = kids.length - 1; i >= 0; i -= 1) emit(kids[i]!, depth + 1)
  }

  for (let i = roots.length - 1; i >= 0; i -= 1) emit(roots[i]!, 0)
  return rows
}

/**
 * ancestorId 가 이 소속 사슬 위에 (몇 겹이든) 있는가.
 *
 * folderId 에서 위로 타고 올라가며 찾는다. 순환이 있어도 멈춘다.
 */
function hasAncestor(
  layers: readonly Layer[],
  ancestorId: string,
  folderId: string | undefined,
): boolean {
  let cursor = folderId
  const seen = new Set<string>()
  let depth = 0
  while (cursor && depth <= MAX_FOLDER_DEPTH) {
    if (cursor === ancestorId) return true
    if (seen.has(cursor)) return false
    seen.add(cursor)
    cursor = layers.find((l) => l.id === cursor)?.folderId
    depth += 1
  }
  return false
}

/**
 * 폴더 블록이 끝나는 자리. 식구까지 다 지난 다음 인덱스다.
 *
 * normalizeFolderOrder 가 식구를 폴더 바로 뒤에 붙여 두므로 앞에서부터 훑기만 하면 된다.
 */
function subtreeEnd(layers: readonly Layer[], start: number): number {
  const folder = layers[start]
  if (!folder) return start + 1
  let end = start + 1
  while (end < layers.length && hasAncestor(layers, folder.id, layers[end]!.folderId)) {
    end += 1
  }
  return end
}

export interface DropTarget {
  /** moveLayerTo 에 그대로 넘길 문서 인덱스. 옮길 레이어를 뺀 뒤 기준이다. */
  index: number
  /** 놓은 자리가 속한 폴더. 최상위면 null. */
  folderId: string | null
}

/**
 * 끌어다 놓은 경계를 문서 인덱스와 폴더 소속으로 옮긴다.
 *
 * boundary 는 0 부터 rows.length 까지다. b 는 "rows[b-1] 과 rows[b] 사이" 를 뜻한다.
 *
 * 기준은 **윗행**이다. 아랫행을 기준으로 잡으면 폴더의 마지막 식구 아래에 놓았을 때
 * 그 아래 이웃(다른 폴더의 머리행)을 따라가 엉뚱한 곳으로 들어간다.
 *
 *   윗행이 펼친 폴더      -> 그 폴더의 맨 앞자리로 들어간다 (머리행 바로 아래 = 폴더 안)
 *   그 외                 -> 윗행과 같은 폴더에, 윗행 바로 뒤쪽(z 가 하나 낮은 자리)
 *
 * 자기 자신과 자기 식구는 기준이 될 수 없다. 폴더를 자기 안으로 넣으면 사슬이 끊긴다.
 * 못 놓는 자리면 null 이다. 호출부는 아무것도 하지 않는다.
 */
export function dropTarget(
  layers: readonly Layer[],
  rows: readonly LayerRow[],
  movedId: string,
  boundary: number,
): DropTarget | null {
  return dropTargetMulti(layers, rows, [movedId], boundary)
}

/**
 * 여러 장을 한꺼번에 놓을 자리. 규칙은 dropTarget 과 같고 두 가지만 넓어진다.
 *
 *   - 기준 행을 찾을 때 옮기는 것 전부(와 그 식구)를 건너뛴다. 옮겨 갈 행을
 *     기준으로 잡으면 놓는 순간 기준이 사라진다.
 *   - 앞자리에서 빠지는 칸 수가 옮기는 장 수만큼 늘어난다.
 *
 * 폴더와 그 식구가 함께 선택되어 있으면 폴더만 옮긴다. 식구는 folderId 로 이미
 * 딸려 있어서 따로 옮기면 두 번 옮겨져 순서가 엉킨다. index 는 옮길 것들을 전부
 * 뺀 배열 기준이고, moveLayersTo 에 그대로 넘긴다.
 */
export function dropTargetMulti(
  layers: readonly Layer[],
  rows: readonly LayerRow[],
  movedIds: readonly string[],
  boundary: number,
): DropTarget | null {
  if (layers.length === 0) return null
  const present = new Set(movedIds.filter((id) => layers.some((l) => l.id === id)))
  if (present.size === 0) return null
  // 조상이 함께 옮겨지는 것은 뺀다. 폴더가 움직이면 식구는 저절로 따라간다.
  const tops = layers.filter(
    (l) => present.has(l.id) && !folderChainHasAny(layers, l, present),
  )
  if (tops.length === 0) return null
  const topIds = new Set(tops.map((l) => l.id))

  const isMovedRow = (row: LayerRow): boolean =>
    topIds.has(row.layer.id) ||
    [...topIds].some((t) => hasAncestor(layers, t, row.layer.folderId))

  const start = Math.min(boundary, rows.length) - 1
  let i = start
  while (i >= 0 && isMovedRow(rows[i]!)) i -= 1

  let folderId: string | null
  let insertAt: number

  if (i < 0) {
    /*
     * 건너뛴 끝에 여기까지 왔다면 그 위에는 옮기는 것밖에 없다. 한 장짜리 블록이면
     * 자기 블록 사이에 놓은 것이라 아무 일도 아니다. 여러 장이 띄엄띄엄 골라져
     * 있을 때는 다르다. 아래쪽에 고른 장들이 위로 끌려 올라와야 하므로 맨 위
     * 삽입으로 흘려보낸다. 진짜 제자리 드롭은 moveLayersTo 의 결과 비교가 거른다.
     */
    if (i !== start && tops.length === 1) return null
    /*
     * 목록 맨 위. 최상위이고 z 가 가장 크다.
     *
     * 배열 끝 **다음** 자리를 가리킨다. 아래에서 자기 자리가 빠진 만큼 당기므로,
     * 여기서 length - 1 로 적으면 옮긴 뒤 끝자리가 어긋난다.
     */
    folderId = null
    insertAt = layers.length
  } else {
    const above = rows[i]!
    const at = layers.findIndex((l) => l.id === above.layer.id)
    if (at < 0) return null

    if (isFolder(above.layer) && !above.collapsed) {
      folderId = above.layer.id
      // 식구 전체를 지난 자리가 곧 '그 폴더에서 가장 앞' 이다.
      insertAt = subtreeEnd(layers, at)
    } else {
      folderId = above.layer.folderId ?? null
      // 윗행 블록의 앞자리. 접힌 폴더면 그 폴더 통째로의 뒤에 놓인다.
      insertAt = at
    }
  }

  // 자기 자신이나 자기 자손 안으로는 못 들어간다.
  if (folderId !== null) {
    for (const t of tops) {
      if (folderId === t.id || hasAncestor(layers, t.id, folderId)) return null
    }
  }

  // splice 로 빼낸 뒤 넣으므로, 앞자리에서 빠지는 만큼 당긴다.
  let removedBefore = 0
  for (let k = 0; k < insertAt && k < layers.length; k += 1) {
    if (topIds.has(layers[k]!.id)) removedBefore += 1
  }
  insertAt -= removedBefore
  const index = Math.max(0, Math.min(layers.length - tops.length, insertAt))

  if (tops.length === 1) {
    // 뺀 배열 기준의 제자리는 from 그대로다. 자기 앞자리들은 그대로이기 때문이다.
    const from = layers.findIndex((l) => l.id === tops[0]!.id)
    const sameFolder = (tops[0]!.folderId ?? null) === folderId
    if (index === from && sameFolder) return null
  }
  return { index, folderId }
}

/** 이 레이어의 소속 사슬 어딘가에 ids 중 하나가 있는가. */
function folderChainHasAny(
  layers: readonly Layer[],
  layer: Layer,
  ids: ReadonlySet<string>,
): boolean {
  let cursor = layer.folderId
  const seen = new Set<string>()
  let depth = 0
  while (cursor && depth <= MAX_FOLDER_DEPTH) {
    if (ids.has(cursor)) return true
    if (seen.has(cursor)) return false
    seen.add(cursor)
    cursor = layers.find((l) => l.id === cursor)?.folderId
    depth += 1
  }
  return false
}
