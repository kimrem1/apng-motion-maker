/**
 * 캔버스에서 레이어를 끌어 옮기는 계산.
 *
 * DOM 을 모른다. 화면 좌표를 캔버스 좌표로 바꾸는 일까지만 StageOverlay 가 하고,
 * 여기서는 네 가지만 순수 함수로 답한다.
 *
 *   1. 지금 누른 자리에 어떤 레이어가 있는가
 *   2. 무엇을 옮겨야 하는가 (레이어인가 폴더인가, 몇 장인가)
 *   3. 그 레이어의 "배치점" 은 캔버스 어디인가, 그리고 그 반대
 *   4. 끈 거리를 격자에 어떻게 붙이는가
 *
 * 넷 다 좌표 산술이라 눈으로는 확인할 수 없다. 폴더가 돌아가 있으면 한 부호만
 * 틀려도 그림이 손과 반대로 간다. 그래서 패널이 아니라 이 파일에 둔다.
 *
 * 배치점이란 무엇인가
 *
 * 레이어의 이동 값(translate)에 캔버스 중심을 더한 점이다. 기준점이 한가운데인
 * 기본 상태에서는 그림의 한가운데와 정확히 같은 자리다(transform.ts
 * buildLayerMatrix 주석의 보정 항이 서로 지운다). 격자에 붙이는 것도, 끈 거리를
 * 되돌리는 것도 전부 이 점 하나로 한다. 그림의 실제 외곽(회전/원근이 걸린 사각형)
 * 으로 붙이면 회전을 조금 주는 순간 붙는 자리가 같이 돌아간다.
 */

import type {
  CompositionSnapshot,
  Layer,
  MotionProject,
  ResolvedLayer,
} from '@/core/types.ts'
import { resolveComposition } from '@/core/evaluate.ts'
import { unitScale } from '@/core/evaluate.ts'
import { buildFolderMatrices, folderChain } from '@/core/group.ts'
import { solveOverscan, type OverscanMap } from '@/core/overscan.ts'
import { layerIntrinsicSize } from '@/core/shape.ts'
import {
  buildLayerMatrix,
  mat3InvertAffine,
  mat3Multiply,
  mat3ProjectPoint,
  type Mat3,
} from '@/core/transform.ts'
import { evalTrack } from '@/easing/curve.ts'

export interface StagePoint {
  x: number
  y: number
}

export type AssetSize = (assetId: string) => { width: number; height: number } | undefined

export interface StageShape {
  layerId: string
  /** 캔버스 좌상단 기준 픽셀. 좌상 -> 우상 -> 우하 -> 좌하 순서다. */
  quad: StagePoint[]
  locked: boolean
}

export interface StageScene {
  /** 위에 그려진 것이 앞이다. 히트 판정이 이 순서로 훑는다. */
  shapes: StageShape[]
  /** 폴더마다 조상까지 누적된 매트릭스. 렌더러가 쓰는 것과 같은 것이다. */
  folders: ReadonlyMap<string, Mat3>
}

// ---------------------------------------------------------------------------
// 장면
// ---------------------------------------------------------------------------

/**
 * 담기 / 채우기 보정. 문서 하나에 한 번만 푼다.
 *
 * solveOverscan 은 레이어마다 240 샘플을 평가한다. 드래그는 포인터 이벤트마다
 * 문서를 새로 만들므로 그때마다 다시 풀면 손이 끊긴다. 렌더러도 같은 이유로
 * 문서 신원으로 캐시한다 (renderer/index.ts). 여기서도 같은 규칙을 쓴다.
 *
 * 보정을 아예 빼면 안 된다. `잘리지 않게 담기` 를 켠 레이어는 화면에서 실제로
 * 작게 그려지는데, 보정 없이 잰 사각형은 그보다 크다. 그림 밖의 빈 곳을 눌러도
 * 잡히고, 외곽선이 그림보다 크게 그려진다.
 */
const overscanCache = new WeakMap<CompositionSnapshot, OverscanMap>()

export function stageOverscan(doc: CompositionSnapshot, assetSize: AssetSize): OverscanMap {
  const cached = overscanCache.get(doc)
  if (cached) return cached
  const solved = solveOverscan(doc, assetSize)
  overscanCache.set(doc, solved)
  return solved
}

/** 원본 크기가 없는 레이어(솔리드)는 캔버스를 채운다고 본다. evaluate.ts 와 같은 규칙이다. */
function sizeOf(
  layer: Pick<ResolvedLayer, 'assetId' | 'shape' | 'text'>,
  doc: CompositionSnapshot,
  assetSize: AssetSize,
): { width: number; height: number } {
  const intrinsic = layerIntrinsicSize(layer, assetSize)
  if (!intrinsic || intrinsic.width <= 0 || intrinsic.height <= 0) {
    return { width: doc.canvas.w, height: doc.canvas.h }
  }
  return intrinsic
}

/**
 * 한 프레임에서 각 레이어가 화면에서 차지하는 사각형.
 *
 * 매트릭스를 여기서 다시 유도하지 않고 렌더러와 같은 함수(buildLayerMatrix +
 * 폴더 매트릭스)를 부른다. 자리를 두 벌로 계산하면 회전이나 원근이 걸린 레이어에서만
 * 클릭이 어긋나고, 그건 재현 조건을 찾기 전에는 원인을 못 짚는 종류의 버그다.
 */
export function buildStageScene(
  doc: CompositionSnapshot,
  frame: number,
  assetSize: AssetSize,
  overscan?: OverscanMap,
): StageScene {
  const resolved = resolveComposition(doc, frame, overscan)
  const folders = buildFolderMatrices(resolved, doc.canvas.w, doc.canvas.h)
  const lockedIds = new Set(doc.layers.filter((l) => l.locked).map((l) => l.id))

  const halfW = doc.canvas.w / 2
  const halfH = doc.canvas.h / 2
  const corners: [number, number][] = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ]

  const shapes: StageShape[] = []
  // resolveComposition 이 z 오름차순으로 준다. 뒤에서부터 담아 앞이 먼저 오게 한다.
  for (let i = resolved.length - 1; i >= 0; i -= 1) {
    const layer = resolved[i]!
    // 폴더는 아무것도 그리지 않는다. 폴더를 옮기는 길은 선택을 통해 열린다 (dragUnits).
    if (layer.isFolder) continue
    if (!layer.visible || layer.transform.opacity <= 0) continue

    const size = sizeOf(layer, doc, assetSize)
    const m = buildLayerMatrix(
      layer.transform,
      layer.fit,
      doc.canvas.w,
      doc.canvas.h,
      size.width,
      size.height,
    )
    const group = layer.folderId ? folders.get(layer.folderId) : undefined
    if (group) mat3Multiply(group, m, m)

    const quad: StagePoint[] = []
    for (const [u, v] of corners) {
      const p = mat3ProjectPoint(m, u, v)
      // 꼭짓점 하나가 카메라 뒤로 넘어갔다. 화면에 온전한 사각형이 없다.
      if (!p) break
      quad.push({ x: p.x + halfW, y: p.y + halfH })
    }
    if (quad.length !== 4) continue

    shapes.push({ layerId: layer.layerId, quad, locked: lockedIds.has(layer.layerId) })
  }

  return { shapes, folders }
}

/**
 * 볼록 사각형 안에 점이 있는가.
 *
 * 네 변의 외적 부호가 한쪽으로 모이면 안이다. 어파인이든 원근이든 유닛 사각형의
 * 상은 볼록하므로 이 판정이 그대로 성립한다.
 */
export function pointInQuad(quad: readonly StagePoint[], x: number, y: number): boolean {
  if (quad.length < 3) return false
  let positive = false
  let negative = false
  for (let i = 0; i < quad.length; i += 1) {
    const a = quad[i]!
    const b = quad[(i + 1) % quad.length]!
    const cross = (b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x)
    if (cross > 1e-9) positive = true
    else if (cross < -1e-9) negative = true
    if (positive && negative) return false
  }
  return true
}

/** 그 자리의 맨 위 레이어. 잠긴 레이어는 건너뛴다(아래 것을 잡을 수 있어야 한다). */
export function pickLayerAt(scene: StageScene, x: number, y: number): string | null {
  for (const shape of scene.shapes) {
    if (shape.locked) continue
    if (pointInQuad(shape.quad, x, y)) return shape.layerId
  }
  return null
}

// ---------------------------------------------------------------------------
// 배치점
// ---------------------------------------------------------------------------

/** 이동 트랙의 현재 값을 캔버스 픽셀로 읽는다. 모디파이어와 부모 이동은 빼고 자기 값만 본다. */
export function readTranslatePx(
  doc: MotionProject,
  layer: Layer,
  frame: number,
): StagePoint {
  const read = (prop: 'translateX' | 'translateY'): number => {
    const track = layer.tracks.find((t) => t.prop === prop)
    if (!track) return 0
    const raw = evalTrack(track, frame)
    if (raw === undefined) return 0
    return raw * unitScale(prop, track.unit, doc.canvas)
  }
  return { x: read('translateX'), y: read('translateY') }
}

/**
 * 배치점. 캔버스 좌상단이 (0,0) 이다.
 *
 * 흔들림(모디파이어)은 일부러 뺀다. 흔들리는 그림을 끌 때 배치점까지 프레임마다
 * 튀면 손이 가만히 있어도 값이 계속 바뀐다. 사용자가 잡는 것은 흔들리기 전의 자리다.
 */
export function placePointOf(
  doc: MotionProject,
  layer: Layer,
  frame: number,
  folders: ReadonlyMap<string, Mat3>,
): StagePoint {
  const local = readTranslatePx(doc, layer, frame)
  const group = layer.folderId ? folders.get(layer.folderId) : undefined
  const moved = group ? mat3ProjectPoint(group, local.x, local.y) : local
  const p = moved ?? local
  return { x: p.x + doc.canvas.w / 2, y: p.y + doc.canvas.h / 2 }
}

/**
 * 배치점을 그 레이어의 이동 값(캔버스 픽셀)으로 되돌린다. placePointOf 의 역이다.
 *
 * 폴더가 돌아가 있거나 확대되어 있으면 화면에서 잰 거리를 그대로 쓸 수 없다.
 * 폴더 매트릭스는 언제나 어파인이라 역행렬이 닫힌 형태로 나온다. 배율이 0 인
 * 폴더(고무처럼 늘이기의 극단)만 되돌릴 수 없고, 그때는 아무것도 옮기지 않는다.
 */
export function translateForPlace(
  doc: MotionProject,
  layer: Layer,
  place: StagePoint,
  folders: ReadonlyMap<string, Mat3>,
): StagePoint | undefined {
  const centered = { x: place.x - doc.canvas.w / 2, y: place.y - doc.canvas.h / 2 }
  const group = layer.folderId ? folders.get(layer.folderId) : undefined
  if (!group) return centered
  const inverse = mat3InvertAffine(group)
  if (!inverse) return undefined
  return mat3ProjectPoint(inverse, centered.x, centered.y)
}

// ---------------------------------------------------------------------------
// 옮길 대상
// ---------------------------------------------------------------------------

export interface DragUnitsInput {
  layers: readonly Layer[]
  /** 캔버스에서 실제로 잡힌 레이어. */
  hitId: string
  /** 지금 고른 레이어들 (layerUi 의 정본). */
  selected: readonly string[]
  /** Alt 를 누른 채 끌었는가. 폴더 규칙을 무시하고 잡은 레이어 하나만 옮긴다. */
  solo: boolean
}

/**
 * 무엇을 옮길 것인가.
 *
 * 규칙을 선택에서 끌어내는 이유는, 그러지 않으면 "폴더째 옮기기" 를 위한 별도의
 * 모드 토글이 필요하기 때문이다. 폴더를 골라 둔 사람은 이미 폴더를 다루는 중이다.
 *
 *   1. Alt 를 눌렀으면 잡은 레이어 하나다. 폴더를 골라 둔 채로 안의 한 장만
 *      옮기고 싶을 때의 유일한 길이라 규칙보다 앞에 둔다.
 *   2. 잡은 레이어를 담고 있는 폴더가 선택되어 있으면 그 폴더다. 여러 겹이 함께
 *      선택되어 있으면 가장 바깥이다. 안쪽은 바깥이 옮기면 따라온다.
 *   3. 잡은 레이어가 이미 선택되어 있으면 고른 것 전부를 함께 옮긴다.
 *   4. 그 외에는 잡은 레이어 하나다. 호출부가 선택도 그쪽으로 옮긴다.
 *
 * 잠긴 것은 어느 규칙에서도 빠진다.
 */
export function dragUnits(input: DragUnitsInput): string[] {
  const { layers, hitId, selected, solo } = input
  const byId = new Map(layers.map((l) => [l.id, l]))
  const hit = byId.get(hitId)
  if (!hit) return []

  const alone = hit.locked ? [] : [hitId]
  if (solo) return alone

  const chain = folderChain(layers, hit)
  for (let i = chain.length - 1; i >= 0; i -= 1) {
    const folder = chain[i]!
    if (selected.includes(folder.id)) return folder.locked ? [] : [folder.id]
  }

  if (selected.includes(hitId)) {
    const chosen = new Set(selected)
    const units = selected.filter((id) => {
      const layer = byId.get(id)
      if (!layer || layer.locked) return false
      // 조상 폴더도 함께 골랐으면 그 폴더가 이미 옮긴다. 둘 다 옮기면 두 배로 간다.
      return !folderChain(layers, layer).some((f) => chosen.has(f.id))
    })
    return units.length > 0 ? units : alone
  }

  return alone
}

// ---------------------------------------------------------------------------
// 격자
// ---------------------------------------------------------------------------

/** 격자에 붙인 값. 칸이 0 이하면 그대로 둔다. */
export function snapToGrid(value: number, grid: number): number {
  if (!(grid > 0) || !Number.isFinite(value)) return value
  return Math.round(value / grid) * grid
}

export interface DragStart {
  layerId: string
  /** 누른 순간의 배치점. */
  place: StagePoint
}

export interface DragMoveInput {
  /** 첫 번째가 실제로 잡은 레이어다. 격자에 붙는 기준이 된다. */
  starts: readonly DragStart[]
  /** 누른 자리에서 지금까지 움직인 거리(캔버스 픽셀). */
  dx: number
  dy: number
  /** 격자 칸(캔버스 픽셀). 0 이하면 붙이지 않는다. */
  grid: number
}

/**
 * 끈 거리를 각 레이어의 새 배치점으로 옮긴다.
 *
 * 격자에 붙이는 것은 잡은 레이어 하나뿐이고 나머지는 그 레이어가 실제로 움직인
 * 만큼을 그대로 따라간다. 각자 붙이면 여러 장을 함께 끌 때 서로의 간격이 드래그
 * 도중에 계속 달라진다. 사용자가 맞춰 둔 배치가 옮기기만 해도 무너진다.
 */
export function dragMove(input: DragMoveInput): { layerId: string; place: StagePoint }[] {
  const primary = input.starts[0]
  if (!primary) return []

  let ax = input.dx
  let ay = input.dy
  if (input.grid > 0) {
    ax = snapToGrid(primary.place.x + input.dx, input.grid) - primary.place.x
    ay = snapToGrid(primary.place.y + input.dy, input.grid) - primary.place.y
  }

  return input.starts.map((start) => ({
    layerId: start.layerId,
    place: { x: start.place.x + ax, y: start.place.y + ay },
  }))
}
