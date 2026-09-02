/**
 * 레이어 패널이 쓰는 문서 변경 어댑터.
 *
 * 원래 이 파일은 document.ts 에 액션이 없어서 immer 패치와 Command 스택을 직접
 * 복제하고 있었다. 히스토리 규칙이 두 곳에 존재하면 언젠가 갈라진다.
 * 이제 액션이 document.ts 에 있으므로 여기는 얇은 위임과 UI 상수만 남긴다.
 */

import type { BlendMode, FrameFit, Layer, MotionProject } from '@/core/types.ts'
import { useDocumentStore } from '@/state/document.ts'

/** parallaxFactor 의 UI 범위. 상한이 따로 없어 UI 에서 3 으로 끊는다. */
export const PARALLAX_MIN = 0
export const PARALLAX_MAX = 3

/**
 * 프레임 처리 선택지. EASY 와 PRO 가 같은 문구를 써야 해서 여기 둔다.
 *
 * 문구는 원리가 아니라 결과를 말한다. "오버스캔 솔버" 를 설명하면 아무도 못 고른다.
 * 각 항목의 hint 는 "무엇이 잘리고 무엇이 남는가" 한 가지만 말한다.
 */
export const FRAME_FIT_OPTIONS: readonly { value: FrameFit; label: string; hint: string }[] = [
  {
    value: 'contain',
    label: '잘리지 않게',
    hint: '움직임이 프레임을 벗어나면 그만큼 줄여서 담습니다. 스티커에 씁니다.',
  },
  {
    value: 'crop',
    label: '원본 크기 그대로',
    hint: '크기를 지키고 프레임 밖은 잘라냅니다. 확대가 프레임을 넘어가도 될 때 씁니다.',
  },
  {
    value: 'cover',
    label: '여백 없이 채우기',
    hint: '미리 키워 두어 어느 순간에도 빈 곳이 없습니다. 배경 사진을 훑는 모션에 씁니다.',
  },
]

/** 레이어의 두 불리언에서 현재 모드를 읽는다. */
export function frameFitOf(layer: Layer): FrameFit {
  if (layer.fillsCanvas) return 'cover'
  if (layer.keepInside) return 'contain'
  return 'crop'
}

export function setFrameFit(layerId: string, fit: FrameFit): void {
  useDocumentStore.getState().setFrameFit(layerId, fit)
}

/**
 * 합성 모드의 한국어 이름.
 * 레이어 행과 인스펙터가 같은 문구를 써야 해서 컴포넌트가 아니라 여기에 둔다.
 */
export const BLEND_OPTIONS: readonly { value: BlendMode; label: string }[] = [
  { value: 'normal', label: '보통' },
  { value: 'multiply', label: '곱하기' },
  { value: 'screen', label: '스크린' },
  { value: 'overlay', label: '오버레이' },
  { value: 'lighten', label: '밝게' },
  { value: 'darken', label: '어둡게' },
]

/** 순환 탐지 깊이 상한. evaluate.ts 의 MAX_PARENT_DEPTH 와 같은 뜻이다. */
const MAX_PARENT_DEPTH = 64

/**
 * 이 부모 지정이 순환을 만들지 않는가.
 * 스토어도 같은 검사를 하지만, UI 가 미리 알아야 셀렉트에서 불가능한 항목을 지울 수 있다.
 */
export function canParent(
  doc: MotionProject,
  layerId: string,
  parentId: string | null,
): boolean {
  if (!parentId) return true
  if (parentId === layerId) return false

  let cursor: string | null = parentId
  const seen = new Set<string>([layerId])
  let depth = 0
  while (cursor && depth < MAX_PARENT_DEPTH) {
    if (seen.has(cursor)) return false
    seen.add(cursor)
    cursor = doc.layers.find((l) => l.id === cursor)?.parentId ?? null
    depth += 1
  }
  return true
}

export function setLayerBlend(layerId: string, blend: BlendMode): void {
  useDocumentStore.getState().setLayerBlend(layerId, blend)
}

/** 아래 레이어 모양으로 자를지. 값 규칙은 스토어 한 곳에만 있다. */
export function setLayerClip(layerIds: string[], on: boolean): void {
  useDocumentStore.getState().setLayerClip(layerIds, on)
}

/** 레이어를 폴더에 넣거나 밖으로 꺼낸다. 값 규칙은 스토어 한 곳에만 있다. */
export function setLayerFolder(layerIds: string[], folderId: string | null): void {
  useDocumentStore.getState().setLayerFolder(layerIds, folderId)
}

export function setLayerParent(layerId: string, parentId: string | null): void {
  useDocumentStore.getState().setLayerParent(layerId, parentId)
}

export function setLayerParallax(layerId: string, factor: number): void {
  useDocumentStore.getState().setLayerParallax(layerId, factor)
}

/**
 * toIndex 는 문서 배열 인덱스(z 오름차순)다. 화면 순서가 아니다.
 * folderId 를 주면 소속을 그대로 쓴다. 생략하면 놓인 자리의 이웃을 보고 추측한다.
 */
export function moveLayerTo(
  layerId: string,
  toIndex: number,
  folderId?: string | null,
): void {
  useDocumentStore.getState().moveLayerTo(layerId, toIndex, folderId)
}

/**
 * 여러 장을 한 덩어리로 옮긴다. toIndex 는 옮길 레이어들을 뺀 배열 기준이다
 * (layerTree.ts dropTargetMulti 가 그 기준으로 계산한다).
 */
export function moveLayersTo(
  layerIds: readonly string[],
  toIndex: number,
  folderId?: string | null,
): void {
  useDocumentStore.getState().moveLayersTo(layerIds, toIndex, folderId)
}
