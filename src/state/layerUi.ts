/**
 * 레이어 선택 상태.
 *
 * 문서가 아니다. 저장되지 않고 undo 대상도 아니다. useUiStore 와 분리한 이유는
 * useUiStore.selectedLayerId 가 단수라서 Ctrl/Shift 다중 선택을 담을 수 없기 때문이다.
 *
 * 정본과 미러의 관계 (확정)
 *   - 이 스토어의 selectedLayerIds 가 정본이다.
 *   - useUiStore.selectedLayerId 는 "마지막으로 고른 레이어 하나"를 미러링한다.
 *     인스펙터와 타임라인이 이미 그 필드를 읽고 있어서 끊으면 전부 고쳐야 한다.
 *   - 그래서 이 파일의 모든 액션은 상태를 바꾼 뒤 반드시 mirror() 를 부른다.
 *   - 반대 방향(useUiStore -> layerUi)은 자동으로 흐르지 않는다. 양방향 동기화는
 *     루프를 만든다. 대신 LayerPanel 이 "layerUi 선택이 비어 있을 때만"
 *     useUiStore.selectedLayerId 를 한 번 받아들인다.
 *   - 정리: 레이어를 고르는 새 코드는 useUiStore.selectLayer 를 직접 부르지 말고
 *     이 파일의 액션을 써라.
 */

import { create } from 'zustand'

import { useUiStore } from './ui.ts'

/** 클릭 수식자에 대응한다. replace = 맨 클릭, toggle = Ctrl, range = Shift. */
export type LayerSelectMode = 'replace' | 'toggle' | 'range'

export function isLayerSelected(selected: readonly string[], id: string): boolean {
  return selected.includes(id)
}

export function lastSelectedLayerId(selected: readonly string[]): string | null {
  return selected[selected.length - 1] ?? null
}

/** useUiStore 로 마지막 선택 하나를 흘려보낸다. 값이 같으면 쓰지 않는다(불필요한 리렌더 방지). */
function mirror(ids: readonly string[], primary: string | null): void {
  const next = primary ?? lastSelectedLayerId(ids)
  const ui = useUiStore.getState()
  if (ui.selectedLayerId !== next) ui.selectLayer(next)
}

interface LayerUiState {
  /** 정본 선택 집합. 순서는 "고른 순서" 가 아니라 호출자가 넘긴 순서를 따른다. */
  selectedLayerIds: string[]
  /**
   * 접어 둔 폴더.
   *
   * 문서가 아니라 화면 상태다. 저장하지 않고 실행취소도 타지 않는다. 접힘은 "지금
   * 보기 편한 상태" 이지 그림의 일부가 아니고, 문서 형식을 늘리면 옛 파일 마이그레이션
   * 까지 딸려 온다.
   *
   * 이것이 있어야 도형 세트가 쓸 만해진다. 세트 하나가 도형을 스무 장까지 만드는데,
   * 폴더로 묶어도 식구가 전부 펼쳐져 나오면 목록이 스무 줄 그대로다.
   */
  collapsedFolderIds: string[]
  /**
   * Shift 범위 선택의 기준점.
   * 인덱스가 아니라 id 로 들고 있어야 그 사이에 순서가 바뀌어도 엉뚱한 범위가 잡히지 않는다.
   */
  anchorLayerId: string | null

  /**
   * 한 레이어를 고른다.
   * orderedIds 는 화면에 보이는 순서(위가 앞)여야 한다. 범위 선택이 사용자가 본
   * 순서대로 잡혀야 하기 때문이다.
   */
  select(id: string, mode: LayerSelectMode, orderedIds: readonly string[]): void
  /** 선택 집합을 통째로 바꾼다. primary 를 주면 그것이 미러 대상이 된다. */
  setSelectedLayerIds(ids: readonly string[], primary?: string | null): void
  clearLayerSelection(): void
  /** 삭제된 레이어를 선택에서 걷어낸다. 변화가 없으면 아무것도 쓰지 않는다. */
  pruneLayerSelection(existingIds: readonly string[]): void

  /** 폴더 하나를 접거나 편다. */
  toggleFolderCollapsed(folderId: string): void
  /** 폴더의 접힘을 못 박는다. 도형 세트가 방금 만든 폴더를 접어 두는 데 쓴다. */
  setFolderCollapsed(folderId: string, collapsed: boolean): void
}

export const useLayerUiStore = create<LayerUiState>()((set, get) => ({
  selectedLayerIds: [],
  collapsedFolderIds: [],
  anchorLayerId: null,

  select(id, mode, orderedIds) {
    const state = get()

    if (mode === 'toggle') {
      const had = state.selectedLayerIds.includes(id)
      const ids = had
        ? state.selectedLayerIds.filter((x) => x !== id)
        : [...state.selectedLayerIds, id]
      // 해제한 경우 기준점은 그대로 둔다. 사용자가 Shift 로 이어서 넓힐 수 있어야 한다.
      const anchor = had ? state.anchorLayerId : id
      set({ selectedLayerIds: ids, anchorLayerId: anchor })
      mirror(ids, had ? lastSelectedLayerId(ids) : id)
      return
    }

    if (mode === 'range') {
      const anchor = state.anchorLayerId ?? lastSelectedLayerId(state.selectedLayerIds) ?? id
      const a = orderedIds.indexOf(anchor)
      const b = orderedIds.indexOf(id)
      if (a < 0 || b < 0) {
        set({ selectedLayerIds: [id], anchorLayerId: id })
        mirror([id], id)
        return
      }
      const lo = Math.min(a, b)
      const hi = Math.max(a, b)
      const ids = orderedIds.slice(lo, hi + 1)
      // 기준점은 유지한다. Shift 를 누른 채 계속 움직이면 범위가 늘었다 줄었다 해야 한다.
      set({ selectedLayerIds: ids, anchorLayerId: anchor })
      mirror(ids, id)
      return
    }

    set({ selectedLayerIds: [id], anchorLayerId: id })
    mirror([id], id)
  },

  setSelectedLayerIds(ids, primary) {
    const next = [...ids]
    set({ selectedLayerIds: next, anchorLayerId: primary ?? lastSelectedLayerId(next) })
    mirror(next, primary ?? null)
  },

  clearLayerSelection() {
    set({ selectedLayerIds: [], anchorLayerId: null })
    mirror([], null)
  },

  pruneLayerSelection(existingIds) {
    const state = get()
    const alive = new Set(existingIds)
    const ids = state.selectedLayerIds.filter((id) => alive.has(id))
    const anchor = state.anchorLayerId && alive.has(state.anchorLayerId) ? state.anchorLayerId : null
    /*
     * 접힘 기억도 같이 걷어낸다.
     *
     * 레이어 id 는 세션 단조 카운터라 다른 프로젝트의 폴더와 그대로 겹친다. 남겨 두면
     * 파일을 새로 열었을 때 아무 상관 없는 폴더가 접힌 채로 나타난다.
     */
    const folders = state.collapsedFolderIds.filter((id) => alive.has(id))
    const foldersChanged = folders.length !== state.collapsedFolderIds.length
    // 바뀐 게 없으면 조용히 나간다. 여기서 매번 set 하면 effect 가 무한 루프가 된다.
    if (
      ids.length === state.selectedLayerIds.length &&
      anchor === state.anchorLayerId &&
      !foldersChanged
    ) {
      return
    }
    set({
      selectedLayerIds: ids,
      anchorLayerId: anchor,
      ...(foldersChanged ? { collapsedFolderIds: folders } : {}),
    })
    mirror(ids, lastSelectedLayerId(ids))
  },

  toggleFolderCollapsed(folderId) {
    const list = get().collapsedFolderIds
    set({
      collapsedFolderIds: list.includes(folderId)
        ? list.filter((id) => id !== folderId)
        : [...list, folderId],
    })
  },

  setFolderCollapsed(folderId, collapsed) {
    const list = get().collapsedFolderIds
    const has = list.includes(folderId)
    if (has === collapsed) return
    set({
      collapsedFolderIds: collapsed ? [...list, folderId] : list.filter((id) => id !== folderId),
    })
  },
}))
