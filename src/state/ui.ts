/**
 * UI 상태. 저장되지 않고 undo 대상도 아니다.
 * 문서 스토어와 절대 섞지 않는다.
 */

import { create } from 'zustand'

export type EditorMode = 'easy' | 'pro'

export type ZoomMode = 'fit' | number

interface UiState {
  mode: EditorMode
  selectedLayerId: string | null
  playing: boolean
  /** 스크럽 중 표시할 프레임. 재생 중에는 rAF 가 직접 계산한다. */
  playheadFrame: number
  zoom: ZoomMode
  /** 렌더러 초기화 실패 메시지. WebGL2 미지원 안내에 쓴다. */
  rendererError: string | null

  setMode(mode: EditorMode): void
  selectLayer(id: string | null): void
  setPlaying(playing: boolean): void
  togglePlaying(): void
  setPlayheadFrame(frame: number): void
  setZoom(zoom: ZoomMode): void
  setRendererError(message: string | null): void
}

export const useUiStore = create<UiState>()((set) => ({
  // 첫 방문은 무조건 EASY 다. 3클릭 온보딩이 이 제품의 핵심 약속이다.
  mode: 'easy',
  selectedLayerId: null,
  playing: true,
  playheadFrame: 0,
  zoom: 'fit',
  rendererError: null,

  setMode: (mode) => set({ mode }),
  selectLayer: (selectedLayerId) => set({ selectedLayerId }),
  setPlaying: (playing) => set({ playing }),
  togglePlaying: () => set((s) => ({ playing: !s.playing })),
  setPlayheadFrame: (playheadFrame) => set({ playheadFrame }),
  setZoom: (zoom) => set({ zoom }),
  setRendererError: (rendererError) => set({ rendererError }),
}))
