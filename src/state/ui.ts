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
  // 기본은 PRO 다. 레이어와 타임라인을 직접 만지는 것이 이 도구의 주 사용 방식이라,
  // 매번 EASY 에서 한 번 더 눌러 들어오는 것이 오히려 방해가 된다.
  // EASY 는 툴바의 세그먼트 토글로 언제든 갈 수 있고, 온보딩은 그쪽에 붙어 있다.
  mode: 'pro',
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
