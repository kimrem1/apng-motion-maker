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

import { SPEED_MAX, SPEED_MIN } from '@/core/types.ts'
import { DEFAULT_SHAPE_COLOR } from '@/shapes/registry.ts'
import type { ShapeSceneGroup } from '@/shapes/types.ts'

export type ShapeGroupFilter = ShapeSceneGroup | 'all'

export interface AppliedScene {
  sceneId: string
  layerIds: string[]
  /**
   * 이 세트를 처음 넣을 때 문서에 있던 길이(프레임). 맞출 것이 없었으면 null 이다.
   *
   * 슬라이더를 끌 때마다 지금 문서 길이를 다시 읽으면 안 된다. 아주 느린 속도에서는
   * 세트가 문서를 늘리는데(shapes/shared.ts timingOf), 그 늘어난 값이 다음 기준선이
   * 되면 속도를 1 로 되돌려도 길이가 안 돌아온다. 속도를 왕복할 때마다 문서가
   * 계속 길어지는 래칫이 된다. 기준선은 처음 한 번 정하고 고정한다.
   */
  fitFrames: number | null
  /**
   * 이 세트가 문서에 써 넣은 fps.
   *
   * 다음 재적용에서 문서 fps 가 이것과 다르면 그 사이 사용자가 직접 골랐다는 뜻이다.
   * 그때 천장(ceilFps)을 그 값으로 내린다. 안 내리면 천장이 영원히 안 낮아져서,
   * fps 를 10 으로 내려 둔 뒤 세기 슬라이더를 한 칸 움직이는 것만으로 fps 가 옛
   * 값으로 되돌아간다. 모션 프리셋 쪽은 document.ts setFps 가 presetRef.baseFps 를
   * 낮춰 같은 사고를 막는데, 도형 세트에는 대응하는 자리가 없었다.
   */
  fps: number
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

export type CreatorTab = 'motion' | 'shape' | 'text' | 'particle' | 'cut'

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
   * 천장을 이 값으로 **내린다.** 사용자가 fps 를 직접 골랐을 때만 부른다.
   * raiseCeilFps 는 최댓값만 잡으므로 내려가는 길이 따로 있어야 한다.
   */
  setCeilFps(fps: number): void
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
    // setStrength 와 같은 이유로 여기서 가둔다. 스토어에 범위 밖 값이 들어가면
    // 슬라이더 위치와 실제로 쓰이는 값(buildShapeScene 이 다시 자른다)이 갈린다.
    set({ speed: Number.isFinite(v) ? Math.min(SPEED_MAX, Math.max(SPEED_MIN, v)) : 1 })
  },
  setApplied(applied) {
    set({ applied })
  },
  raiseCeilFps(fps) {
    const next = Math.max(fps, get().ceilFps ?? 0)
    if (next !== get().ceilFps) set({ ceilFps: next })
    return next
  },
  setCeilFps(fps) {
    if (!Number.isFinite(fps) || fps <= 0) return
    if (get().ceilFps !== fps) set({ ceilFps: fps })
  },
  resetSession() {
    if (get().applied === null && get().ceilFps === null) return
    set({ applied: null, ceilFps: null })
  },
}))
