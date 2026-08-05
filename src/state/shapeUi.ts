/**
 * 도형 패널의 화면 상태.
 *
 * 문서가 아니다. 저장되지 않고 실행취소 대상도 아니다. 문서 상태와 물리적으로 갈라
 * 두는 규칙은 state/document.ts 상단에 있다.
 *
 * lastScene 이 이 파일의 존재 이유다. 세기 슬라이더를 끌면 같은 세트를 계속 다시
 * 만드는데, 직전에 만든 레이어를 기억하지 않으면 드래그 한 번에 도형이 수십 장
 * 쌓인다. 문서에 넣지 않는 이유는 이것이 "방금 이 패널에서 한 일" 이라는 세션
 * 정보이기 때문이다. 파일을 다시 열면 그냥 도형 레이어일 뿐이다.
 */

import { create } from 'zustand'

import { DEFAULT_SHAPE_COLOR } from '@/shapes/registry.ts'
import type { ShapeSceneGroup } from '@/shapes/types.ts'

export type ShapeGroupFilter = ShapeSceneGroup | 'all'

export interface AppliedScene {
  sceneId: string
  layerIds: string[]
  /**
   * 넣은 직후 레이어들의 지문.
   *
   * 슬라이더를 끌면 세트를 통째로 다시 만드는데, 그 사이에 사용자가 도형을 손봤으면
   * 그 편집이 말없이 사라진다. 프리셋 쪽은 같은 문제를 presetRef.dirty 로 막는다
   * (state/presetActions.ts). 여기서는 문서에 필드를 늘리지 않고 세션 지문으로 판정한다.
   * 지문이 다르면 "내가 만든 그대로가 아니다" 이므로 다시 만들지 않는다.
   */
  signature: string
}

export type CreatorTab = 'motion' | 'shape' | 'text' | 'cut'

interface ShapeUiState {
  /** 왼쪽 도크에서 지금 보고 있는 도구. EASY 와 PRO 가 같은 값을 쓴다. */
  tab: CreatorTab
  group: ShapeGroupFilter
  color: string
  /** 0~1. 움직임의 크기. */
  strength: number
  /** SPEED_MIN~SPEED_MAX. 클수록 짧아진다. */
  speed: number
  applied: AppliedScene | null
  /**
   * 속도 유도 fps 의 천장.
   *
   * 느린 속도는 fps 를 함께 낮춰야 프레임 상한 안에서 길이가 늘어난다. 그런데 천장을
   * "지금 문서 fps" 로 잡으면 한 번 내려간 값이 영영 안 올라와, 속도를 되돌려도
   * 길이가 원래대로 돌아오지 않는다. 사용자가 직접 올린 fps 는 따라 올라가도록
   * 최댓값으로 갱신한다.
   */
  ceilFps: number | null

  setTab(tab: CreatorTab): void
  setGroup(group: ShapeGroupFilter): void
  setColor(color: string): void
  setStrength(v: number): void
  setSpeed(v: number): void
  setApplied(applied: AppliedScene | null): void
  raiseCeilFps(fps: number): number
  /**
   * 문서가 통째로 바뀌었다. 이 문서와 무관한 기억을 버린다.
   *
   * 레이어 id 는 세션 단조 카운터라 다른 문서의 레이어와 그대로 겹친다. 앞 문서에서
   * 만든 목록을 들고 있으면 새로 연 프로젝트의 남의 레이어를 지운다. fps 천장도
   * 문서마다 달라야 한다.
   */
  resetSession(): void
}

export const useShapeUiStore = create<ShapeUiState>()((set, get) => ({
  tab: 'motion',
  group: 'all',
  color: DEFAULT_SHAPE_COLOR,
  strength: 0.5,
  speed: 1,
  applied: null,
  ceilFps: null,

  setTab(tab) {
    set({ tab })
  },
  setGroup(group) {
    set({ group })
  },
  setColor(color) {
    set({ color })
  },
  setStrength(v) {
    set({ strength: Math.min(1, Math.max(0, v)) })
  },
  setSpeed(v) {
    set({ speed: v })
  },
  setApplied(applied) {
    set({ applied })
  },
  raiseCeilFps(fps) {
    const next = Math.max(fps, get().ceilFps ?? 0)
    if (next !== get().ceilFps) set({ ceilFps: next })
    return next
  },
  resetSession() {
    if (get().applied === null && get().ceilFps === null) return
    set({ applied: null, ceilFps: null })
  },
}))
