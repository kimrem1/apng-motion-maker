/**
 * 프리셋 갤러리의 UI 상태.
 *
 * 문서 상태와 물리적으로 분리한다. 여기 있는 값은 저장되지 않고 undo 대상도 아니다.
 * 검색어와 호버 대상이 undo 스택에 쌓이면 Ctrl+Z 가 아무 일도 안 하는 것처럼 보인다.
 *
 * 강도(strength)와 속도(speed)는 프리셋을 갈아타도 유지되는 공통 노브다
 * 프리셋 교체가 조정값을 날리면 안 된다. 그래서 프리셋별 파라미터와 달리
 * 이 스토어에 산다. 프리셋 고유 파라미터는 motions/apply.ts 가 교체 시점에 리셋한다.
 */

import { create } from 'zustand'

import { SPEED_DEFAULT, SPEED_MAX, SPEED_MIN } from '@/core/types.ts'
import type { MotionCategory } from '@/motions/types.ts'

/** 카테고리 칩. 'all' 은 필터 없음이다. */
export type PresetCategoryFilter = MotionCategory | 'all'

/** 동시 재생 카드 상한. */
export const MAX_COMPARE = 4

/** 최근 사용 목록 길이. 한 줄에 들어가는 만큼만 남긴다. */
export const MAX_RECENT = 8

export const STRENGTH_DEFAULT = 0.5

/*
 * 속도 범위는 core/types.ts 한 곳에만 있다. 여기서 다시 정의하면 같은 숫자가
 * 두 벌이 되고, 예전에 일곱 군데로 흩어져 있던 문제가 그대로 재발한다.
 * 옛 호출부가 이 모듈에서 가져다 쓰고 있어 재수출만 한다.
 */
export { SPEED_DEFAULT, SPEED_MAX, SPEED_MIN } from '@/core/types.ts'

interface PresetUiState {
  query: string
  category: PresetCategoryFilter
  /** 0 ~ 1. 프리셋 진폭 배율. */
  strength: number
  /** 0.5 ~ 2. 지속시간의 역수로 들어간다. */
  speed: number
  /** 호버 또는 포커스 중인 카드. 미리보기 재생 대상이다. */
  hoveredId: string | null
  /** 마지막으로 확정 적용된 프리셋. */
  appliedId: string | null
  favorites: string[]
  recent: string[]
  /** 비교 모드 대상. 최대 MAX_COMPARE 개. */
  compareIds: string[]

  setQuery(query: string): void
  setCategory(category: PresetCategoryFilter): void
  setStrength(strength: number): void
  setSpeed(speed: number): void
  hover(id: string | null): void
  /** null 이면 "지금 걸린 프리셋이 없다". 카드를 한 번 더 눌러 끄는 경로가 쓴다. */
  markApplied(id: string | null): void
  toggleFavorite(id: string): void
  pushRecent(id: string): void
  toggleCompare(id: string): void
  clearCompare(): void
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

export const usePresetUiStore = create<PresetUiState>()((set) => ({
  query: '',
  category: 'all',
  strength: STRENGTH_DEFAULT,
  speed: SPEED_DEFAULT,
  hoveredId: null,
  appliedId: null,
  favorites: [],
  recent: [],
  compareIds: [],

  setQuery: (query) => set({ query }),
  setCategory: (category) => set({ category }),
  // NaN 이 들어오면 슬라이더가 통제 불능이 된다. 입력 단계에서 막는다.
  setStrength: (strength) =>
    set({ strength: Number.isFinite(strength) ? clamp(strength, 0, 1) : STRENGTH_DEFAULT }),
  setSpeed: (speed) =>
    set({ speed: Number.isFinite(speed) ? clamp(speed, SPEED_MIN, SPEED_MAX) : SPEED_DEFAULT }),

  hover: (hoveredId) => set({ hoveredId }),
  markApplied: (appliedId) => set({ appliedId }),

  toggleFavorite: (id) =>
    set((s) => ({
      favorites: s.favorites.includes(id)
        ? s.favorites.filter((x) => x !== id)
        : [...s.favorites, id],
    })),

  // 이미 있으면 맨 앞으로 끌어올린다. 같은 프리셋이 목록에 두 번 보이면 안 된다.
  pushRecent: (id) =>
    set((s) => ({ recent: [id, ...s.recent.filter((x) => x !== id)].slice(0, MAX_RECENT) })),

  /**
   * 상한을 넘기면 가장 오래된 것을 밀어낸다.
   * 꽉 찼을 때 클릭을 무시하면 사용자에게는 버튼이 고장 난 것으로 보인다.
   */
  toggleCompare: (id) =>
    set((s) => {
      if (s.compareIds.includes(id)) {
        return { compareIds: s.compareIds.filter((x) => x !== id) }
      }
      const next = [...s.compareIds, id]
      return { compareIds: next.slice(Math.max(0, next.length - MAX_COMPARE)) }
    }),

  clearCompare: () => set({ compareIds: [] }),
}))
