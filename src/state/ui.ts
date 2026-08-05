/**
 * UI 상태. 저장되지 않고 undo 대상도 아니다.
 * 문서 스토어와 절대 섞지 않는다.
 */

import { create } from 'zustand'

export type EditorMode = 'easy' | 'pro'

export type ZoomMode = 'fit' | number

/**
 * 고를 수 있는 격자 칸 크기(캔버스 픽셀).
 *
 * 2의 거듭제곱만 둔다. 캔버스가 512 든 1024 든 정확히 나누어떨어져서, 격자를 켜고
 * 배치한 그림이 캔버스 한가운데와 가장자리에 딱 맞는다. 24 나 40 같은 값을 섞으면
 * 마지막 칸만 잘려 그 자리에 배치한 것이 가운데에서 미묘하게 어긋난다.
 */
export const GRID_SIZES = [8, 16, 32, 64] as const

interface UiState {
  mode: EditorMode
  selectedLayerId: string | null
  playing: boolean
  /** 스크럽 중 표시할 프레임. 재생 중에는 rAF 가 직접 계산한다. */
  playheadFrame: number
  zoom: ZoomMode
  /**
   * 격자를 보여 주는가. 켜져 있으면 캔버스에서 끌어 옮길 때 격자에 딱 붙는다.
   *
   * 문서가 아니라 화면 상태다. 격자는 결과물에 한 픽셀도 나오지 않고, 저장해 두면
   * 남의 프로젝트를 열었을 때 이유 없이 격자가 켜져 있게 된다.
   */
  gridOn: boolean
  /** 격자 한 칸(캔버스 픽셀). GRID_SIZES 안의 값이다. */
  gridSize: number
  /** 렌더러 초기화 실패 메시지. WebGL2 미지원 안내에 쓴다. */
  rendererError: string | null

  setMode(mode: EditorMode): void
  selectLayer(id: string | null): void
  setPlaying(playing: boolean): void
  togglePlaying(): void
  setPlayheadFrame(frame: number): void
  setZoom(zoom: ZoomMode): void
  toggleGrid(): void
  setGridOn(on: boolean): void
  setGridSize(size: number): void
  setRendererError(message: string | null): void
}

/** 목록에 없는 값이 들어와도 가장 가까운 칸으로 내려앉는다. */
function snapGridSize(size: number): number {
  if (!Number.isFinite(size)) return 32
  let best: number = GRID_SIZES[0]
  let gap = Infinity
  for (const choice of GRID_SIZES) {
    const d = Math.abs(choice - size)
    if (d < gap) {
      gap = d
      best = choice
    }
  }
  return best
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
  // 격자는 꺼진 채로 시작한다. 켠 채로 시작하면 격자를 쓸 생각이 없던 사람의
  // 첫 드래그가 말없이 32px 씩 튄다.
  gridOn: false,
  gridSize: 32,
  rendererError: null,

  setMode: (mode) => set({ mode }),
  selectLayer: (selectedLayerId) => set({ selectedLayerId }),
  setPlaying: (playing) => set({ playing }),
  togglePlaying: () => set((s) => ({ playing: !s.playing })),
  setPlayheadFrame: (playheadFrame) => set({ playheadFrame }),
  setZoom: (zoom) => set({ zoom }),
  toggleGrid: () => set((s) => ({ gridOn: !s.gridOn })),
  setGridOn: (gridOn) => set({ gridOn }),
  setGridSize: (size) => set({ gridSize: snapGridSize(size) }),
  setRendererError: (rendererError) => set({ rendererError }),
}))
