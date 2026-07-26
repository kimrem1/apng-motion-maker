/**
 * 타임라인 / 그래프 에디터 전용 UI 상태.
 *
 * 문서가 아니다. 저장되지 않고 undo 대상도 아니다.
 * useUiStore 와 분리한 이유는 재생 헤드처럼 초당 수십 번 바뀌는 값과
 * 타임라인 선택처럼 사용자 조작에만 바뀌는 값이 구독자를 공유하면
 * 재생 중에 타임라인 전체가 리렌더되기 때문이다.
 */

import { create } from 'zustand'

import type { MotionProject, TrackProp } from '@/core/types.ts'

/** 키프레임 하나를 가리키는 참조. frame 이 정본 좌표다. */
export interface KeyRef {
  layerId: string
  prop: TrackProp
  frame: number
}

export interface GraphTarget {
  layerId: string
  prop: TrackProp
}

export type GraphTab = 'value' | 'speed'

/** 1 = 전체 구간이 화면 폭에 딱 맞는 배율이다. 그 아래로는 줄이지 않는다. */
export const ZOOM_MIN = 1
export const ZOOM_MAX = 24

export function keyRefId(ref: KeyRef): string {
  return `${ref.layerId}|${ref.prop}|${ref.frame}`
}

/** 레이어 + 속성 조합 키. armed 집합과 그래프 대상 비교에 쓴다. */
export function propId(layerId: string, prop: TrackProp): string {
  return `${layerId}|${prop}`
}

export function isKeySelected(selected: readonly KeyRef[], ref: KeyRef): boolean {
  return selected.some(
    (s) => s.layerId === ref.layerId && s.prop === ref.prop && s.frame === ref.frame,
  )
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

interface TimelineUiState {
  /** 선택된 키프레임들. 다중 선택을 전제로 항상 배열이다. */
  selectedKeys: KeyRef[]
  graphOpen: boolean
  graphTarget: GraphTarget | null
  /** 기본 탭은 속도다. */
  graphTab: GraphTab
  /** 1 = 전체 맞춤. 값이 클수록 확대다. */
  zoom: number
  /** 화면 왼쪽 끝에 오는 프레임 */
  scrollFrame: number
  /**
   * 지금 보이는 프레임 수. Timeline 이 폭과 배율로 계산해 알려준다.
   * 스토어는 캔버스 폭을 모르므로 이 값이 없으면 스크롤 상한을 구할 수 없다.
   */
  visibleFrames: number
  /** 문서 길이. setViewport 로 함께 들어온다. */
  durationFrames: number
  /** scrollFrame 의 상한. duration - visibleFrames 에서 나온다. */
  maxScrollFrame: number
  snap: boolean
  /**
   * 스톱워치를 켰지만 아직 키가 하나뿐인 속성 목록 (`layerId|prop`).
   *
   * 문서 스토어의 isAnimated 는 키가 2개 이상일 때만 true 다. 스톱워치를 켠
   * 직후에는 키가 하나뿐이라 이 집합이 없으면 버튼이 바로 꺼진 것처럼 보이고
   * 타임라인에도 트랙이 나타나지 않는다. 순수한 UI 의도 상태다.
   */
  armed: string[]

  selectKey(ref: KeyRef, additive?: boolean): void
  setSelection(refs: KeyRef[]): void
  clearSelection(): void
  removeFromSelection(ref: KeyRef): void
  /** 키를 옮긴 뒤 선택이 옛 프레임을 가리키지 않도록 갱신한다. */
  remapSelection(layerId: string, prop: TrackProp, fromFrame: number, toFrame: number): void

  openGraph(target: GraphTarget): void
  closeGraph(): void
  toggleGraph(target?: GraphTarget | null): void
  setGraphTab(tab: GraphTab): void

  setZoom(zoom: number): void
  /** anchorFrame 을 화면상 같은 자리에 붙들고 확대한다. 기본값은 화면 중앙이다. */
  zoomBy(factor: number, anchorFrame?: number): void
  setScrollFrame(frame: number): void
  /** Timeline 이 폭/배율로 계산한 뷰포트를 알려준다. 스크롤 상한이 여기서 나온다. */
  setViewport(visibleFrames: number, durationFrames: number): void
  setSnap(on: boolean): void
  toggleSnap(): void

  setArmed(layerId: string, prop: TrackProp, on: boolean): void

  /** 문서에 더 이상 없는 선택/스톱워치/그래프 대상을 지운다. */
  pruneForDocument(doc: MotionProject): void
}

/** 스크롤 상한. 전체가 화면에 들어오면 0 이다. */
function maxScrollOf(visibleFrames: number, durationFrames: number): number {
  return Math.max(0, durationFrames - visibleFrames)
}

function findTrackKeys(
  doc: MotionProject,
  layerId: string,
  prop: TrackProp,
): readonly number[] | null {
  const layer = doc.layers.find((l) => l.id === layerId)
  if (!layer) return null
  const track = layer.tracks.find((t) => t.prop === prop)
  if (!track) return null
  return track.keys.map((k) => k.f)
}

/**
 * 배율을 바꾸면서 화면 기준점을 붙들어 두는 패치.
 *
 * 확대는 보이는 구간을 좁힌다. scrollFrame 을 그대로 두면 보고 있던 지점이 화면
 * 밖으로 밀려나 "확대했더니 엉뚱한 데를 보고 있는" 상태가 된다.
 */
function zoomPatch(
  s: TimelineUiState,
  nextZoom: number,
  anchorFrame: number | undefined,
): Partial<TimelineUiState> {
  const ratio = nextZoom / s.zoom
  // 뷰포트를 아직 모르면 배율만 바꾼다. Timeline 이 곧 setViewport 로 알려 준다.
  if (s.visibleFrames <= 0 || !Number.isFinite(ratio) || ratio <= 0) return { zoom: nextZoom }

  const visibleFrames = s.visibleFrames / ratio
  const maxScrollFrame = maxScrollOf(visibleFrames, s.durationFrames)
  const center = s.scrollFrame + s.visibleFrames / 2
  // 기준점은 화면 안에 있어야 뜻이 있다. 밖이면 중앙을 쓴다.
  const raw = anchorFrame ?? center
  const anchor = raw >= s.scrollFrame && raw <= s.scrollFrame + s.visibleFrames ? raw : center
  const scrollFrame = clamp(anchor - (anchor - s.scrollFrame) / ratio, 0, maxScrollFrame)

  return { zoom: nextZoom, visibleFrames, maxScrollFrame, scrollFrame }
}

export const useTimelineUiStore = create<TimelineUiState>()((set) => ({
  selectedKeys: [],
  graphOpen: false,
  graphTarget: null,
  graphTab: 'speed',
  zoom: 1,
  scrollFrame: 0,
  visibleFrames: 0,
  durationFrames: 0,
  maxScrollFrame: 0,
  snap: true,
  armed: [],

  selectKey(ref, additive = false) {
    set((s) => {
      if (!additive) return { selectedKeys: [ref] }
      if (isKeySelected(s.selectedKeys, ref)) {
        return { selectedKeys: s.selectedKeys.filter((k) => keyRefId(k) !== keyRefId(ref)) }
      }
      return { selectedKeys: [...s.selectedKeys, ref] }
    })
  },

  setSelection(refs) {
    set({ selectedKeys: refs })
  },

  clearSelection() {
    set({ selectedKeys: [] })
  },

  removeFromSelection(ref) {
    set((s) => ({ selectedKeys: s.selectedKeys.filter((k) => keyRefId(k) !== keyRefId(ref)) }))
  },

  remapSelection(layerId, prop, fromFrame, toFrame) {
    set((s) => ({
      selectedKeys: s.selectedKeys.map((k) =>
        k.layerId === layerId && k.prop === prop && k.frame === fromFrame
          ? { ...k, frame: toFrame }
          : k,
      ),
    }))
  },

  openGraph(target) {
    set({ graphOpen: true, graphTarget: target })
  },

  closeGraph() {
    set({ graphOpen: false })
  },

  toggleGraph(target) {
    set((s) => {
      if (s.graphOpen) return { graphOpen: false }
      const next = target ?? s.graphTarget
      if (!next) return { graphOpen: false }
      return { graphOpen: true, graphTarget: next }
    })
  },

  setGraphTab(graphTab) {
    set({ graphTab })
  },

  setZoom(zoom) {
    set((s) => {
      const next = clamp(zoom, ZOOM_MIN, ZOOM_MAX)
      if (next === s.zoom) return {}
      return zoomPatch(s, next, undefined)
    })
  },

  zoomBy(factor, anchorFrame) {
    set((s) => {
      const next = clamp(s.zoom * factor, ZOOM_MIN, ZOOM_MAX)
      if (next === s.zoom) return {}
      return zoomPatch(s, next, anchorFrame)
    })
  },

  setScrollFrame(frame) {
    set((s) => ({ scrollFrame: clamp(frame, 0, s.maxScrollFrame) }))
  },

  setViewport(visibleFrames, durationFrames) {
    set((s) => {
      const maxScrollFrame = maxScrollOf(visibleFrames, durationFrames)
      const scrollFrame = clamp(s.scrollFrame, 0, maxScrollFrame)
      if (
        s.visibleFrames === visibleFrames &&
        s.durationFrames === durationFrames &&
        s.scrollFrame === scrollFrame
      ) {
        return {}
      }
      return { visibleFrames, durationFrames, maxScrollFrame, scrollFrame }
    })
  },

  setSnap(snap) {
    set({ snap })
  },

  toggleSnap() {
    set((s) => ({ snap: !s.snap }))
  },

  setArmed(layerId, prop, on) {
    const id = propId(layerId, prop)
    set((s) => {
      const has = s.armed.includes(id)
      if (on === has) return {}
      return { armed: on ? [...s.armed, id] : s.armed.filter((a) => a !== id) }
    })
  },

  /**
   * 레이어나 키를 지운 뒤 남은 UI 참조를 한 번에 털어낸다.
   *
   * 삭제하는 곳마다 정리를 넣으면 반드시 한 군데를 빠뜨린다. 문서가 정본이므로
   * 문서에 없는 것은 여기서 전부 지운다.
   */
  pruneForDocument(doc) {
    set((s) => {
      const patch: Partial<TimelineUiState> = {}

      const selectedKeys = s.selectedKeys.filter((k) => {
        const frames = findTrackKeys(doc, k.layerId, k.prop)
        return frames !== null && frames.includes(k.frame)
      })
      if (selectedKeys.length !== s.selectedKeys.length) patch.selectedKeys = selectedKeys

      const armed = s.armed.filter((id) => {
        const [layerId, prop] = id.split('|')
        if (!layerId || !prop) return false
        return findTrackKeys(doc, layerId, prop as TrackProp) !== null
      })
      if (armed.length !== s.armed.length) patch.armed = armed

      const target = s.graphTarget
      if (target && findTrackKeys(doc, target.layerId, target.prop) === null) {
        patch.graphTarget = null
        patch.graphOpen = false
      }

      return patch
    })
  },
}))
