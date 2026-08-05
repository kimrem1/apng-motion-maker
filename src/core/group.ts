/**
 * 레이어 폴더.
 *
 * 폴더는 아무것도 그리지 않는 레이어다. 대신 자기 변환이 안에 있는 레이어의
 * 매트릭스 바깥에 곱해진다. 폴더에 모션 A 를 걸고 안의 그림에 모션 B 를 걸면 둘이
 * 함께 보인다. 애프터이펙트의 프리컴포지션과 같은 자리다.
 *
 * 왜 채널이 아니라 매트릭스인가
 *
 * 폴더의 이동/회전/배율을 안쪽 레이어의 트랙 값에 더해 버리면 훨씬 간단해 보인다.
 * 그런데 그 방식은 폴더의 가로세로 배율이 다르고 안쪽 레이어가 돌아가 있을 때
 * 틀린 그림을 낸다. 그 조합은 어떤 이동/회전/배율로도 못 만드는 기울임을 만들어
 * 내기 때문이다. 폴더에 "고무처럼 늘이기" 를 걸면 곧바로 드러난다.
 *
 * 매트릭스로 두면 그런 예외가 없고, 어파인이라 담기 솔버의 1차식 성질도 그대로다
 * (transform.ts buildGroupMatrix 주석).
 *
 * 그리는 순서
 *
 * 폴더는 목록의 순서를 바꾸지 않는다. 안에 든 레이어가 폴더 바로 뒤에 붙어 있게
 * 배열을 정리해 두므로(state/document.ts), z 로 정렬하기만 하면 한 폴더의 식구가
 * 저절로 붙어 있는다. 렌더러는 폴더의 존재를 몰라도 순서를 맞게 그린다.
 */

import { buildGroupMatrix, mat3Multiply, type Mat3 } from './transform.ts'
import type { Layer, ResolvedLayer } from './types.ts'

/**
 * 폴더 중첩 한계.
 *
 * 순환은 스토어와 마이그레이션이 막지만, 못 믿을 파일이 들어와도 렌더러가 멈추면
 * 안 된다. 여기서 잘라 낸다. 여덟 겹이면 사람이 만드는 어떤 문서에도 충분하다.
 */
export const MAX_FOLDER_DEPTH = 8

/** 이 레이어를 담고 있는 폴더들. 안쪽부터 바깥쪽 순서다. */
export function folderChain(
  layers: readonly Layer[],
  layer: Layer,
): Layer[] {
  const chain: Layer[] = []
  const seen = new Set<string>([layer.id])
  let cursor = layer.folderId

  while (cursor && chain.length < MAX_FOLDER_DEPTH) {
    if (seen.has(cursor)) break // 순환
    seen.add(cursor)
    const folder = layers.find((l) => l.id === cursor)
    if (!folder || folder.type !== 'group') break
    chain.push(folder)
    cursor = folder.folderId
  }
  return chain
}

/** 이 레이어가 폴더인가. 데이터에 한 곳에서만 물어본다. */
export function isFolderLayer(layer: Pick<Layer, 'type'>): boolean {
  return layer.type === 'group'
}

/** 폴더 안에 (몇 겹이든) 들어 있는 레이어들. */
export function layersInFolder(layers: readonly Layer[], folderId: string): Layer[] {
  return layers.filter((l) => folderChain(layers, l).some((f) => f.id === folderId))
}

/**
 * 폴더마다 누적 매트릭스를 만든다. 자기 조상까지 이미 곱해져 있다.
 *
 * 프레임마다 한 번만 만든다. 레이어마다 사슬을 다시 곱하면 깊이의 제곱이 된다.
 * 폴더가 아닌 레이어는 들어 있지 않다.
 */
export function buildFolderMatrices(
  resolved: readonly ResolvedLayer[],
  canvasW: number,
  canvasH: number,
): Map<string, Mat3> {
  const folders = resolved.filter((l) => l.isFolder)
  if (folders.length === 0) return new Map()

  const byId = new Map(folders.map((f) => [f.layerId, f]))
  const out = new Map<string, Mat3>()

  const resolveOne = (id: string, depth: number): Mat3 | undefined => {
    const cached = out.get(id)
    if (cached) return cached
    if (depth > MAX_FOLDER_DEPTH) return undefined

    const folder = byId.get(id)
    if (!folder) return undefined

    const own = buildGroupMatrix(folder.transform, canvasW, canvasH)
    const parentId = folder.folderId
    if (parentId && parentId !== id) {
      const parent = resolveOne(parentId, depth + 1)
      // 바깥 폴더가 왼쪽이다. 바깥이 먼저 좌표계를 정하고 안쪽이 그 안에서 움직인다.
      if (parent) mat3Multiply(parent, own, own)
    }
    out.set(id, own)
    return own
  }

  for (const folder of folders) resolveOne(folder.layerId, 0)
  return out
}

/**
 * 레이어 매트릭스에 폴더를 얹는다. 폴더가 없으면 아무 일도 하지 않는다.
 *
 * 렌더러와 오버스캔 솔버가 반드시 같은 함수를 써야 한다. 어긋나면 솔버가
 * 실제와 다른 자리를 재서, 폴더에 모션을 건 순간 안쪽 그림이 이유 없이 작아진다.
 */
export function applyFolderMatrix(
  matrix: Mat3,
  folderId: string | undefined,
  folders: ReadonlyMap<string, Mat3>,
): Mat3 {
  if (!folderId) return matrix
  const group = folders.get(folderId)
  if (!group) return matrix
  return mat3Multiply(group, matrix, matrix)
}
