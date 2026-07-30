/**
 * 문서 상태와 실행취소.
 *
 * 문서 상태와 UI 상태를 물리적으로 분리한다. 문서만 저장되고, 문서만 undo 대상이다.
 * 모든 변경은 mutateDoc 하나를 거친다. 그래야 immer 패치로 undo 스택이 공짜로 나온다.
 * 스냅샷을 쌓지 않으므로 스택이 커져도 메모리가 선형으로 늘지 않는다.
 *
 * 에셋 픽셀은 절대 문서에 넣지 않는다. 넣으면 undo 스택이 수백 MB 가 된다.
 */

import { create } from 'zustand'
import { applyPatches, enablePatches, produce, produceWithPatches, type Patch } from 'immer'

import {
  CANVAS_MAX,
  CANVAS_MIN,
  FPS_CHOICES,
  FRAMES_MAX,
  type AssetPrep,
  type AssetRef,
  type BackgroundType,
  type BlendMode,
  type FitMode,
  type FrameFit,
  type Handle,
  type EffectInstance,
  type Keyframe,
  type Modifier,
  type Layer,
  type LoopMode,
  type MotionProject,
  type Track,
  type TrackProp,
} from '@/core/types.ts'
import {
  TRACK_DEFAULTS,
  createEmptyProject,
  createImageLayer,
  createStaticTrack,
  nextId,
} from '@/core/factory.ts'
import { evalTrack, insertKeyframe } from '@/easing/curve.ts'
import { EASING_PRESET_BY_ID } from '@/easing/presets.ts'
import { mergePresetEffects, mergePresetTracks, ownershipOf } from '@/motions/merge.ts'
import { probeAlpha } from '@/imageprep/alphaProbe.ts'
import { assetRegistry } from './assets.ts'

enablePatches()

/** 스택 상한. 200 엔트리 또는 누적 8MB 다. */
const HISTORY_LIMIT = 200
/** 같은 coalesceKey 가 이 시간 안에 다시 오면 하나로 합친다. */
const COALESCE_MS = 500

export interface Command {
  id: string
  label: string
  timestamp: number
  patches: Patch[]
  inversePatches: Patch[]
  coalesceKey?: string
}

export interface AddImageInput {
  name: string
  bitmap: ImageBitmap
  hasAlpha: boolean
}

interface DocumentState {
  doc: MotionProject
  past: Command[]
  future: Command[]

  undo(): void
  redo(): void
  clearHistory(): void

  addImage(input: AddImageInput): { assetId: string; layerId: string }
  removeLayer(layerId: string): void
  reorderLayer(layerId: string, direction: -1 | 1): void

  /**
   * 이미지 다듬기(배경 제거 / 크롭) 결과를 문서에 반영한다.
   *
   * 픽셀 교체(assetRegistry.set)만 하면 AssetRef.naturalW/H 가 실제 픽셀과 어긋나
   * 오버스캔 솔버가 옛 크기로 s_min 을 계산한다. 회전/이동 프리셋에서 캔버스
   * 모서리가 비는 사고가 그것이다. 픽셀을 바꾼 쪽이 반드시 이 액션을 함께 부른다.
   *
   * hasAlpha 도 여기서 갱신한다. 흰 배경 JPG 는 임포트 시 알파 없음으로 기록되는데,
   * 배경 제거가 알파를 만든 뒤에도 그대로면 내보내기가 투명도를 버린다.
   *
   * **실행취소 스택에 쌓지 않는다.** 픽셀(assetRegistry)은 undo 로 되돌릴 수 없으므로
   * 이 숫자들만 되돌아가면 문서-픽셀 불일치가 다시 생기고, 자동저장이 그 불일치
   * 상태를 그대로 영구화한다. 다듬기를 되돌리는 정본 경로는 패널의 [되돌리기]다.
   */
  updateAssetPrep(
    assetId: string,
    args: { width: number; height: number; hasAlpha: boolean; prep?: AssetPrep },
  ): void

  setLayerFlag(layerId: string, key: 'visible' | 'locked', value: boolean): void
  /**
   * 모든 레이어의 표시/잠금을 한 번에 바꾼다.
   *
   * setLayerFlag 를 레이어 수만큼 부르면 안 된다. 20장짜리 문서에서 [전체 숨기기] 한
   * 번이 undo 20칸을 먹고, Ctrl+Z 를 스무 번 눌러야 원래대로 돌아온다.
   * 한 번의 변경으로 묶어 한 칸이 되게 한다.
   */
  setAllLayersFlag(key: 'visible' | 'locked', value: boolean): void
  /**
   * 프레임을 벗어날 때의 처리 방식.
   * 두 불리언을 따로 켜면 실행취소가 두 칸 쌓이고 그 사이에 둘 다 켜진 상태가 생긴다.
   */
  setFrameFit(layerId: string, fit: FrameFit): void
  setLayerFit(layerId: string, fit: FitMode): void
  setLayerAnchor(layerId: string, ax: number, ay: number): void
  setLayerName(layerId: string, name: string): void
  setLayerBlend(layerId: string, blend: BlendMode): void
  /** 순환이 생기는 지정은 무시한다. */
  setLayerParent(layerId: string, parentId: string | null): void
  setLayerParallax(layerId: string, factor: number): void
  /** toIndex 는 문서 배열 인덱스(z 오름차순)다. */
  moveLayerTo(layerId: string, toIndex: number): void

  /**
   * 모션 프리셋을 통째로 심는다.
   *
   * 키를 하나씩 넣으면 프리셋 한 번 적용에 undo 가 10~20칸 쌓이고,
   * 모디파이어와 track.unit / composite 를 지정할 방법이 없다. 한 번의 변경으로 묶는다.
   */
  applyPresetTracks(args: {
    layerId: string
    presetId: string
    /** 같은 prop 의 기존 트랙을 대체한다. 프리셋이 건드리지 않는 prop 은 유지된다. */
    tracks: Track[]
    /** layer.modifiers 를 통째로 대체한다. */
    modifiers: Modifier[]
    /** 지정하면 layer.effects 를 통째로 대체한다. 생략하면 기존 이펙트를 유지한다. */
    effects?: EffectInstance[]
    durationFrames?: number
    loopMode?: LoopMode
    /** 지정하면 타임라인 fps 도 같이 바꾼다. 글리치의 용량 통제에 쓴다. */
    fps?: number
    /** 이 프리셋은 일부러 프레임 밖으로 나간다. 담기 솔버가 비켜서야 한다. */
    allowExit?: boolean
    /** 세기 최대치 기준 담기 배율. 없으면 문서에서 직접 푼다. */
    containScale?: number
    /** 속도 1 기준 재생 시간(초). 속도 노브의 기준선이다. */
    baseSec?: number
    /** 속도 1 기준 fps. 속도 유도 fps 의 천장이다. */
    baseFps?: number
    macro: { speed: number; strength: number }
  }): void

  /**
   * 이펙트를 추가한다.
   * 기본 파라미터는 호출자가 레지스트리에서 뽑아 넘긴다. 문서 스토어가 이펙트
   * 레지스트리를 알 필요가 없고, 알면 core 가 UI 쪽 데이터에 묶인다.
   */
  addEffect(layerId: string, type: string, defaults: Record<string, number>): string | null
  removeEffect(layerId: string, effectId: string): void
  setEffectEnabled(layerId: string, effectId: string, enabled: boolean): void
  setEffectParam(layerId: string, effectId: string, key: string, value: number): void
  setEffectSeed(layerId: string, effectId: string, seed: number): void
  setEffectHold(layerId: string, effectId: string, holdFrames: number): void
  reorderEffect(layerId: string, effectId: string, direction: -1 | 1): void

  /** 애니메이션되지 않은 속성의 값을 바꾼다. 키가 하나뿐일 때 쓴다. */
  setStaticValue(layerId: string, prop: TrackProp, value: number): void
  /** 지정 프레임에 키프레임을 만들거나 갱신한다. */
  setValueAtFrame(layerId: string, prop: TrackProp, frame: number, value: number): void

  /** 속성의 애니메이션을 켜고 끈다. 켜면 현재 값으로 첫 키가 생긴다. */
  toggleAnimated(layerId: string, prop: TrackProp, frame: number): void
  addKeyframe(layerId: string, prop: TrackProp, frame: number): void
  removeKeyframe(layerId: string, prop: TrackProp, frame: number): void
  moveKeyframe(layerId: string, prop: TrackProp, fromFrame: number, toFrame: number): void
  setKeyframeEasing(layerId: string, prop: TrackProp, frame: number, presetId: string): void
  setKeyframeHandles(
    layerId: string,
    prop: TrackProp,
    frame: number,
    handles: { out?: Handle; in?: Handle },
  ): void

  /**
   * 캔버스 크기를 바꾼다.
   *
   * scaleContent 는 **해상도를 바꾸는 컨트롤만** 켠다 (EASY 의 크기, 인스펙터의
   * 폭/높이). 그때는 그림도 같은 비율로 따라가야 한다. 켜지 않으면 fit 이
   * '원본 크기'인 레이어가 제자리에 남아, 캔버스를 줄인 만큼 그림이 커 보이고
   * 사방이 잘린다 (Layer.baseScale 주석).
   *
   * 자르기 / 여백 제거처럼 **원본 픽셀 자체가 달라져서** 캔버스가 따라가는 경우는
   * 끈 채로 부른다. 그림은 이미 그만큼 작아져 있으므로 또 줄이면 두 번 줄어든다.
   */
  setCanvasSize(w: number, h: number, options?: { scaleContent?: boolean }): void
  setBackgroundType(type: BackgroundType): void
  setBackgroundColor(color: string): void
  setFps(fps: number): void
  setDurationFrames(frames: number): void
  setLoopMode(mode: LoopMode): void
  setLoopCount(count: number): void

  replaceDocument(doc: MotionProject): void
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

/**
 * fps 를 선택 목록의 값으로 맞춘다.
 *
 * 목록에 12.5 가 있어서 정수로 반올림하면 안 된다. 13 은 어느 셀렉트에도 없고,
 * GIF 지연 격자(100/N)에서도 벗어나 재생 속도가 조용히 어긋난다.
 */
function snapFps(fps: number): number {
  if (!Number.isFinite(fps) || fps <= 0) return 25
  let best: number = FPS_CHOICES[0]
  let gap = Infinity
  for (const choice of FPS_CHOICES) {
    const d = Math.abs(choice - fps)
    if (d < gap) { gap = d; best = choice }
  }
  return best
}

function findLayer(doc: MotionProject, layerId: string): Layer | undefined {
  return doc.layers.find((l) => l.id === layerId)
}

function findTrack(layer: Layer, prop: TrackProp): Track | undefined {
  return layer.tracks.find((t) => t.prop === prop)
}

function findEffect(
  doc: MotionProject,
  layerId: string,
  effectId: string,
): EffectInstance | undefined {
  return findLayer(doc, layerId)?.effects.find((e) => e.id === effectId)
}

/** 이펙트 시드 유도용. crypto 를 쓰지 않는 이유는 같은 조작이 같은 문서를 만들어야 하기 때문이다. */
function hashOf(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** 인스펙터가 현재 값을 읽을 때 쓴다. 트랙이 없으면 항등값이다. */
export function readStaticValue(layer: Layer, prop: TrackProp, frame = 0): number {
  const track = findTrack(layer, prop)
  if (!track) return TRACK_DEFAULTS[prop].identity
  return evalTrack(track, frame) ?? TRACK_DEFAULTS[prop].identity
}

/**
 * 이 속성이 애니메이션 상태인가.
 *
 * 키 개수로만 판정하면 안 된다. 스톱워치를 켜 첫 키를 찍은 직후에는 키가 하나뿐인데,
 * 그때 인스펙터가 "애니메이션 아님" 으로 보고 상수 경로를 타면 재생헤드를 옮겨 값을 바꿔도
 * 키가 생기지 않는다. 사용자 눈에는 스톱워치가 아무 일도 안 하는 것으로 보인다.
 */
export function isAnimated(layer: Layer, prop: TrackProp): boolean {
  const track = findTrack(layer, prop)
  if (!track) return false
  return track.animated === true || track.keys.length > 1
}

export function getTrack(layer: Layer, prop: TrackProp): Track | undefined {
  return findTrack(layer, prop)
}

/** 키를 프레임 오름차순으로 유지한다. 평가기가 정렬을 전제한다. */
function sortKeys(track: Track): void {
  track.keys.sort((a, b) => a.f - b.f)
}

/**
 * undo/redo 가 복원한 에셋 정보를 레지스트리의 실제 픽셀과 다시 맞춘다.
 *
 * 픽셀(assetRegistry)은 히스토리 밖이라 패치가 못 되돌린다. 그런데 일부 패치는
 * 에셋 객체의 값 스냅샷을 들고 있어(addImage 의 push 패치가 대표), undo/redo 가
 * 다듬기 이전의 naturalW/H / hasAlpha 를 되살릴 수 있다. 그대로 두면 오버스캔이
 * 옛 크기로 계산되는 그 병이 재발하므로, 히스토리 이동 직후 항상 실측으로 되맞춘다.
 *
 * 크기가 어긋난 에셋만 손댄다. 그때 hasAlpha 도 probeAlpha 로 재실측한다
 * (256px 축소 표본이라 에셋당 1ms 수준). 크기가 같은 desync(배경 제거만 한 경우)는
 * 여기서 못 잡지만, hasAlpha 는 내보내기 픽셀에 영향이 없는 참고 정보라 손해가 작다.
 * prep 기록까지는 복원하지 못하지만 prep 은 아직 소비자가 없는 정보성 필드다.
 */
function resyncAssetRefs(doc: MotionProject): MotionProject {
  return produce(doc, (d) => {
    for (const asset of d.assets) {
      const bitmap = assetRegistry.get(asset.id)
      if (!bitmap) continue
      if (asset.naturalW === bitmap.width && asset.naturalH === bitmap.height) continue
      asset.naturalW = bitmap.width
      asset.naturalH = bitmap.height
      asset.hasAlpha = probeAlpha(bitmap)
    }
  })
}

/**
 * PRO 에서 손을 댔다는 표시.
 *
 * 이게 없으면 EASY 의 "프리셋에서 벗어났습니다" 배너가 영원히 안 뜨고,
 * 세기 슬라이더가 사용자의 수동 편집을 조용히 덮어쓴다.
 */
function markPresetDirty(doc: MotionProject): void {
  if (doc.presetRef && !doc.presetRef.dirty) doc.presetRef.dirty = true
}

export const useDocumentStore = create<DocumentState>()((set, get) => {
  /**
   * 문서를 바꾸는 유일한 통로.
   * 패치가 비면 히스토리에 아무것도 쌓지 않는다. 값이 같은데 undo 가 한 칸 먹는
   * 상황을 막는다.
   */
  function mutateDoc(
    label: string,
    recipe: (doc: MotionProject) => void,
    coalesceKey?: string,
  ): void {
    const state = get()
    const [next, patches, inversePatches] = produceWithPatches(state.doc, recipe)
    if (patches.length === 0) return

    const now = Date.now()
    const top = state.past[state.past.length - 1]
    const canCoalesce =
      !!coalesceKey && !!top && top.coalesceKey === coalesceKey && now - top.timestamp < COALESCE_MS

    let past: Command[]
    if (canCoalesce && top) {
      // 드래그 한 번이 undo 한 칸이 되도록 합친다.
      // 정방향 패치는 뒤에 붙이고, 역방향 패치는 앞에 붙여야 순서가 맞는다.
      past = state.past.slice(0, -1)
      past.push({
        ...top,
        timestamp: now,
        patches: [...top.patches, ...patches],
        inversePatches: [...inversePatches, ...top.inversePatches],
      })
    } else {
      past = [...state.past, { id: nextId('c'), label, timestamp: now, patches, inversePatches, coalesceKey }]
      if (past.length > HISTORY_LIMIT) past = past.slice(past.length - HISTORY_LIMIT)
    }

    set({ doc: next, past, future: [] })
  }

  return {
    doc: createEmptyProject(),
    past: [],
    future: [],

    undo() {
      const { doc, past, future } = get()
      const cmd = past[past.length - 1]
      if (!cmd) return
      set({
        // 패치가 다듬기 이전 에셋 스냅샷을 되살릴 수 있다. 픽셀과 다시 맞춘다.
        doc: resyncAssetRefs(applyPatches(doc, cmd.inversePatches)),
        past: past.slice(0, -1),
        future: [cmd, ...future],
      })
    },

    redo() {
      const { doc, past, future } = get()
      const cmd = future[0]
      if (!cmd) return
      set({
        doc: resyncAssetRefs(applyPatches(doc, cmd.patches)),
        past: [...past, cmd],
        future: future.slice(1),
      })
    },

    clearHistory() {
      set({ past: [], future: [] })
    },

    addImage({ name, bitmap, hasAlpha }) {
      const assetId = nextId('a')
      assetRegistry.set(assetId, bitmap)

      const ref: AssetRef = {
        id: assetId,
        name,
        storeKey: `idb:asset:${assetId}`,
        naturalW: bitmap.width,
        naturalH: bitmap.height,
        hasAlpha,
      }

      let layerId = ''
      mutateDoc('이미지 추가', (d) => {
        d.assets.push(ref)
        const layer = createImageLayer(ref, d.layers.length)
        layerId = layer.id
        d.layers.push(layer)

        /*
         * 캔버스를 들어온 이미지 중 **가장 큰 것**에 맞춘다.
         *
         * 첫 장은 그대로 받고, 이후에는 폭과 높이를 각각 큰 쪽으로만 넓힌다.
         * 여러 장을 한 번에 떨어뜨리면 addImage 가 장당 한 번씩 불리므로, 이 규칙이
         * 곧 "그 묶음에서 가장 큰 크기" 가 된다. 줄이지는 않는다. 나중에 작은 그림을
         * 한 장 더 넣었다고 이미 잡아 둔 캔버스가 쪼그라들면 안 된다.
         *
         * 축소하지 않는 이유는 레이어 기본값이 '원본 크기 그대로'(fit: none,
         * keepInside: false)이기 때문이다. 캔버스만 줄이면 넣은 그림이 곧바로 잘린다.
         * 상한은 CANVAS_MAX(4000) 하나뿐이다.
         */
        const w = d.layers.length === 1 ? bitmap.width : Math.max(d.canvas.w, bitmap.width)
        const h = d.layers.length === 1 ? bitmap.height : Math.max(d.canvas.h, bitmap.height)
        d.canvas.w = clamp(Math.round(w), CANVAS_MIN, CANVAS_MAX)
        d.canvas.h = clamp(Math.round(h), CANVAS_MIN, CANVAS_MAX)
      })

      return { assetId, layerId }
    },

    updateAssetPrep(assetId, { width, height, hasAlpha, prep }) {
      // mutateDoc 을 일부러 안 쓴다. 히스토리에 쌓이면 Ctrl+Z 가 크기만 되돌려
      // 픽셀과 어긋난다 (인터페이스 주석 참조). past/future 는 건드리지 않는다.
      // 일부 패치는 에셋 값 스냅샷을 들고 있어 undo/redo 가 이 갱신을 덮을 수
      // 있는데, 그 구멍은 undo/redo 의 resyncAssetRefs 가 실측으로 막는다.
      const next = produce(get().doc, (d) => {
        const asset = d.assets.find((a) => a.id === assetId)
        if (!asset) return
        // 마이그레이션(migrate.ts normalizeAssets)과 같은 범위로 자른다.
        asset.naturalW = clamp(Math.round(width), 1, 1 << 16)
        asset.naturalH = clamp(Math.round(height), 1, 1 << 16)
        asset.hasAlpha = hasAlpha
        if (prep) {
          // 호출자 객체를 그대로 넣으면 immer 밖의 참조가 문서에 섞인다. 사본을 만든다.
          asset.prep = {
            ...(prep.crop ? { crop: [...prep.crop] as [number, number, number, number] } : {}),
            ...(prep.bgRemove ? { bgRemove: { ...prep.bgRemove } } : {}),
          }
        } else {
          delete asset.prep
        }
      })
      // 참조가 같으면 아무것도 안 바뀐 것이다. 불필요한 리렌더와 자동저장을 막는다.
      if (next !== get().doc) set({ doc: next })
    },

    removeLayer(layerId) {
      let orphanAssetId: string | null = null
      mutateDoc('레이어 삭제', (d) => {
        const index = d.layers.findIndex((l) => l.id === layerId)
        if (index < 0) return
        const [removed] = d.layers.splice(index, 1)
        if (!removed) return

        if (removed.assetId) {
          const stillUsed = d.layers.some((l) => l.assetId === removed.assetId)
          if (!stillUsed) {
            // filter 로 배열을 재대입하면 immer 가 ['assets'] 전체 스냅샷 패치를
            // 기록한다. 그 undo 가 다른 에셋의 나중 갱신(updateAssetPrep)까지
            // 통째로 되돌리므로 반드시 지운 항목만 splice 한다.
            const ai = d.assets.findIndex((a) => a.id === removed.assetId)
            if (ai >= 0) d.assets.splice(ai, 1)
            orphanAssetId = removed.assetId
          }
        }
        d.layers.forEach((l, i) => {
          l.z = i
        })
      })
      // 비트맵 해제는 문서 변경 밖에서 한다. undo 로 되돌릴 때 픽셀이 살아 있어야 한다.
      // 지금은 세션 동안 비트맵을 붙잡고 있다. 정리는 영속화와 함께 다룬다.
      void orphanAssetId
    },

    reorderLayer(layerId, direction) {
      mutateDoc('레이어 순서 변경', (d) => {
        const from = d.layers.findIndex((l) => l.id === layerId)
        if (from < 0) return
        const to = from + direction
        if (to < 0 || to >= d.layers.length) return
        const [moved] = d.layers.splice(from, 1)
        if (!moved) return
        d.layers.splice(to, 0, moved)
        d.layers.forEach((l, i) => {
          l.z = i
        })
      })
    },

    setLayerFlag(layerId, key, value) {
      const labels = { visible: '표시 전환', locked: '잠금 전환' }
      mutateDoc(labels[key], (d) => {
        const layer = findLayer(d, layerId)
        if (layer) layer[key] = value
      })
    },

    setAllLayersFlag(key, value) {
      const labels = {
        visible: value ? '전체 보이기' : '전체 숨기기',
        locked: value ? '전체 잠그기' : '전체 잠금 풀기',
      }
      mutateDoc(labels[key], (d) => {
        for (const layer of d.layers) {
          // 이미 같은 값이면 건드리지 않는다. 패치가 비면 히스토리도 안 쌓인다.
          if (layer[key] !== value) layer[key] = value
        }
      })
    },

    setFrameFit(layerId, fit) {
      mutateDoc('프레임 처리 변경', (d) => {
        const layer = findLayer(d, layerId)
        if (!layer) return
        // 셋은 배타다. 한 번의 변경으로 조합을 통째로 정한다.
        layer.keepInside = fit === 'contain'
        layer.fillsCanvas = fit === 'cover'
      })
    },

    setLayerFit(layerId, fit) {
      mutateDoc('맞춤 변경', (d) => {
        const layer = findLayer(d, layerId)
        if (layer) layer.fit = fit
      })
    },

    setLayerAnchor(layerId, ax, ay) {
      mutateDoc('기준점 변경', (d) => {
        const layer = findLayer(d, layerId)
        if (layer) layer.anchor = [clamp(ax, 0, 1), clamp(ay, 0, 1)]
      })
    },

    setLayerName(layerId, name) {
      mutateDoc('이름 변경', (d) => {
        const layer = findLayer(d, layerId)
        if (layer) layer.name = name
      }, `name:${layerId}`)
    },

    setLayerBlend(layerId, blend) {
      mutateDoc('혼합 모드 변경', (d) => {
        const layer = findLayer(d, layerId)
        if (layer) layer.blend = blend
      })
    },

    setLayerParent(layerId, parentId) {
      mutateDoc('부모 레이어 변경', (d) => {
        const layer = findLayer(d, layerId)
        if (!layer) return
        if (parentId === layerId) return

        // 순환이 생기면 평가기가 부모 사슬을 도는 동안 자기 자신으로 돌아온다.
        // 평가기에도 방어가 있지만 문서에 애초에 안 들어가게 막는 편이 낫다.
        let cursor = parentId
        const seen = new Set<string>([layerId])
        while (cursor) {
          if (seen.has(cursor)) return
          seen.add(cursor)
          cursor = d.layers.find((l) => l.id === cursor)?.parentId ?? null
        }
        layer.parentId = parentId
      })
    },

    setLayerParallax(layerId, factor) {
      mutateDoc('깊이감 변경', (d) => {
        const layer = findLayer(d, layerId)
        if (layer) layer.parallaxFactor = clamp(factor, 0, 3)
      }, `parallax:${layerId}`)
    },

    moveLayerTo(layerId, toIndex) {
      mutateDoc('레이어 순서 변경', (d) => {
        const from = d.layers.findIndex((l) => l.id === layerId)
        if (from < 0) return
        const to = clamp(Math.round(toIndex), 0, d.layers.length - 1)
        if (to === from) return
        const [moved] = d.layers.splice(from, 1)
        if (!moved) return
        d.layers.splice(to, 0, moved)
        d.layers.forEach((l, i) => {
          l.z = i
        })
      })
    },

    addEffect(layerId, type, defaults) {
      const id = nextId('e')
      let created: string | null = null
      mutateDoc('이펙트 추가', (d) => {
        const layer = findLayer(d, layerId)
        if (!layer) return
        layer.effects.push({
          id,
          type,
          enabled: true,
          // 시드는 레이어와 이펙트 순서에서 유도한다. 문서를 다시 열어도 같은 패턴이 나온다.
          seed: (hashOf(`${layerId}:${type}:${layer.effects.length}`) & 0x7fffffff) || 1,
          holdFrames: 1,
          requiresHistory: false,
          params: { ...defaults },
        })
        created = id
      })
      return created
    },

    removeEffect(layerId, effectId) {
      mutateDoc('이펙트 삭제', (d) => {
        const layer = findLayer(d, layerId)
        if (!layer) return
        const i = layer.effects.findIndex((e) => e.id === effectId)
        if (i >= 0) layer.effects.splice(i, 1)
      })
    },

    setEffectEnabled(layerId, effectId, enabled) {
      mutateDoc(enabled ? '이펙트 켜기' : '이펙트 끄기', (d) => {
        const fx = findEffect(d, layerId, effectId)
        if (fx) fx.enabled = enabled
      })
    },

    setEffectParam(layerId, effectId, key, value) {
      if (!Number.isFinite(value)) return
      mutateDoc('이펙트 값 변경', (d) => {
        const fx = findEffect(d, layerId, effectId)
        if (fx) fx.params[key] = value
      }, `fx:${layerId}:${effectId}:${key}`)
    },

    setEffectSeed(layerId, effectId, seed) {
      mutateDoc('이펙트 패턴 바꾸기', (d) => {
        const fx = findEffect(d, layerId, effectId)
        if (fx) fx.seed = Math.max(1, Math.floor(seed))
      })
    },

    setEffectHold(layerId, effectId, holdFrames) {
      mutateDoc('이펙트 홀드 변경', (d) => {
        const fx = findEffect(d, layerId, effectId)
        if (fx) fx.holdFrames = clamp(Math.round(holdFrames), 1, 12)
      }, `fxhold:${layerId}:${effectId}`)
    },

    reorderEffect(layerId, effectId, direction) {
      mutateDoc('이펙트 순서 변경', (d) => {
        const layer = findLayer(d, layerId)
        if (!layer) return
        const from = layer.effects.findIndex((e) => e.id === effectId)
        if (from < 0) return
        const to = from + direction
        if (to < 0 || to >= layer.effects.length) return
        const [moved] = layer.effects.splice(from, 1)
        if (moved) layer.effects.splice(to, 0, moved)
      })
    },

    applyPresetTracks({ layerId, presetId, tracks, modifiers, effects, durationFrames, loopMode, fps, allowExit, containScale, baseSec, baseFps, macro }) {
      mutateDoc('모션 프리셋 적용', (d) => {
        const layer = findLayer(d, layerId)
        if (!layer) return
        layer.motionExitsFrame = allowExit === true
        // 세기를 바꿔 재적용해도 이 값은 같다. 그래야 그림 크기가 슬라이더를 따라
        // 출렁이지 않고, 세기가 움직임의 크기만 바꾼다.
        layer.containScale = containScale

        // 소유권 규칙은 motions/merge.ts 한 곳에만 둔다. 호버 미리보기도 같은 헬퍼를 쓴다.
        // 규칙이 두 벌이면 미리보기와 클릭 결과가 갈린다.
        const owned = ownershipOf(d.presetRef)
        const nextTracks = tracks.map((t) => ({ ...t, id: t.id || nextId('t') }))
        const nextFx = (effects ?? []).map((e) => ({ ...e, id: e.id || nextId('e') }))

        layer.tracks = mergePresetTracks(layer.tracks, nextTracks, owned)
        layer.modifiers = modifiers.map((m) => ({ ...m, id: m.id || nextId('m') }))
        layer.effects = mergePresetEffects(layer.effects, effects ? nextFx : undefined, owned)

        if (durationFrames !== undefined) {
          d.timeline.durationFrames = clamp(Math.round(durationFrames), 2, FRAMES_MAX)
        }
        if (loopMode !== undefined) d.timeline.loop.mode = loopMode
        // fps 를 같은 변경 안에서 처리한다. 따로 setFps 를 부르면 undo 가 두 칸 쌓인다.
        // Math.round 를 쓰면 12.5 가 13 이 된다. 13 은 선택 목록에 없어서 fps 셀렉트가
        // 아무것도 안 고른 상태가 되고, GIF 정확도 판정(100/13)도 깨진다.
        if (fps !== undefined) d.timeline.fps = snapFps(fps)

        d.presetRef = {
          id: presetId,
          macro: { ...macro },
          dirty: false,
          props: tracks.map((t) => t.prop),
          effectIds: nextFx.map((e) => e.id),
          // 요청한 기준선을 그대로 보관한다. 지금 durationFrames 는 프리셋이 홀드
          // 배수로 스냅한 결과라, 그걸 되먹이면 속도를 왕복할 때마다 길이가 늘어난다.
          ...(baseSec !== undefined ? { baseSec } : {}),
          ...(baseFps !== undefined ? { baseFps } : {}),
        }
      }, `preset:${layerId}:${presetId}`)
    },

    setStaticValue(layerId, prop, value) {
      mutateDoc(`${prop} 변경`, (d) => {
        const layer = findLayer(d, layerId)
        if (!layer) return
        const existing = findTrack(layer, prop)
        if (existing) {
          const key = existing.keys[0]
          if (key) key.v = value
          else existing.keys.push({ f: 0, v: value, interp: 'bezier' })
          return
        }
        layer.tracks.push(createStaticTrack(prop, TRACK_DEFAULTS[prop].unit, value))
      }, `static:${layerId}:${prop}`)
    },

    setValueAtFrame(layerId, prop, frame, value) {
      mutateDoc(`${prop} 키프레임`, (d) => {
        const layer = findLayer(d, layerId)
        if (!layer) return
        let track = findTrack(layer, prop)
        if (!track) {
          track = createStaticTrack(prop, TRACK_DEFAULTS[prop].unit, value)
          track.animated = true
          track.keys[0]!.f = frame
          layer.tracks.push(track)
          return
        }
        // 특정 프레임에 값을 심는다는 것 자체가 애니메이션 의도다.
        track.animated = true
        const at = track.keys.find((k) => k.f === frame)
        if (at) {
          at.v = value
          return
        }
        track.keys.push({ f: frame, v: value, interp: 'bezier' })
        sortKeys(track)
        markPresetDirty(d)
      }, `keyval:${layerId}:${prop}:${frame}`)
    },

    toggleAnimated(layerId, prop, frame) {
      mutateDoc('애니메이션 전환', (d) => {
        const layer = findLayer(d, layerId)
        if (!layer) return
        const track = findTrack(layer, prop)
        const on = !!track && (track.animated === true || track.keys.length > 1)

        if (on && track) {
          // 끄기: 현재 프레임 값을 상수로 굳힌다.
          const value = evalTrack(track, frame) ?? TRACK_DEFAULTS[prop].identity
          track.animated = false
          track.keys = [{ f: 0, v: value, interp: 'bezier' }]
          return
        }

        // 켜기: 현재 값으로 이 프레임에 첫 키를 만든다.
        const current = track
          ? (evalTrack(track, frame) ?? TRACK_DEFAULTS[prop].identity)
          : TRACK_DEFAULTS[prop].identity
        if (track) {
          track.animated = true
          track.keys = [{ f: frame, v: current, interp: 'bezier' }]
        } else {
          const created = createStaticTrack(prop, TRACK_DEFAULTS[prop].unit, current)
          created.animated = true
          created.keys[0]!.f = frame
          layer.tracks.push(created)
        }
      })
    },

    addKeyframe(layerId, prop, frame) {
      mutateDoc('키프레임 추가', (d) => {
        const layer = findLayer(d, layerId)
        if (!layer) return
        const track = findTrack(layer, prop)
        if (!track || track.keys.length === 0) return
        if (track.keys.some((k) => k.f === frame)) return

        // 두 키 사이면 de Casteljau 분할로 모양을 보존한다.
        // 이걸 안 하면 키를 추가하는 순간 모션이 튄다.
        for (let i = 0; i < track.keys.length - 1; i++) {
          const a = track.keys[i]!
          const b = track.keys[i + 1]!
          if (frame <= a.f || frame >= b.f) continue
          const split = insertKeyframe(a, b, frame)
          if (!split) return
          track.keys[i] = split.a
          track.keys[i + 1] = split.b
          track.keys.splice(i + 1, 0, split.mid)
          return
        }

        // 구간 밖이면 끝 값을 그대로 복제한다.
        const value = evalTrack(track, frame) ?? TRACK_DEFAULTS[prop].identity
        track.keys.push({ f: frame, v: value, interp: 'bezier' })
        sortKeys(track)
        markPresetDirty(d)
      })
    },

    removeKeyframe(layerId, prop, frame) {
      mutateDoc('키프레임 삭제', (d) => {
        const layer = findLayer(d, layerId)
        if (!layer) return
        const track = findTrack(layer, prop)
        if (!track || track.keys.length <= 1) return
        const i = track.keys.findIndex((k) => k.f === frame)
        if (i < 0) return
        track.keys.splice(i, 1)
        markPresetDirty(d)
      })
    },

    moveKeyframe(layerId, prop, fromFrame, toFrame) {
      mutateDoc('키프레임 이동', (d) => {
        const layer = findLayer(d, layerId)
        if (!layer) return
        const track = findTrack(layer, prop)
        if (!track) return
        const key = track.keys.find((k) => k.f === fromFrame)
        if (!key) return
        // 같은 프레임에 두 키가 겹치면 평가가 0 나눗셈을 만난다.
        if (track.keys.some((k) => k !== key && k.f === toFrame)) return
        key.f = toFrame
        sortKeys(track)
        markPresetDirty(d)
        // coalesce 키에 fromFrame 을 넣으면 안 된다. 드래그하는 동안 매 스텝 키가 달라져
        // 10프레임 드래그가 undo 스택을 9칸 먹는다. 트랙 단위로 묶어 한 번의 드래그가
        // 한 번의 실행취소가 되게 한다.
      }, `kfmove:${layerId}:${prop}`)
    },

    setKeyframeEasing(layerId, prop, frame, presetId) {
      const preset = EASING_PRESET_BY_ID.get(presetId)
      if (!preset) return
      mutateDoc('이징 변경', (d) => {
        const layer = findLayer(d, layerId)
        if (!layer) return
        const track = findTrack(layer, prop)
        if (!track) return
        const key = track.keys.find((k) => k.f === frame)
        if (!key) return

        key.interp = preset.interp
        // 평가 정본이 프리셋에 있다. 핸들만 저장하면 bounce/elastic 이 back 과 같아진다.
        key.easingPreset = preset.id
        if (preset.interp === 'spring' && preset.spring) {
          key.spring = { ...preset.spring }
        } else {
          delete key.spring
        }
        if (preset.handles) {
          key.out = { ...preset.handles.out }
          // in 핸들은 다음 키가 갖는다. 세그먼트 하나를 두 키가 나눠 들고 있기 때문이다.
          const i = track.keys.indexOf(key)
          const next = track.keys[i + 1]
          if (next) next.in = { ...preset.handles.in }
        }
        markPresetDirty(d)
      })
    },

    setKeyframeHandles(layerId, prop, frame, handles) {
      mutateDoc('곡선 조정', (d) => {
        const layer = findLayer(d, layerId)
        if (!layer) return
        const track = findTrack(layer, prop)
        if (!track) return
        const key = track.keys.find((k) => k.f === frame)
        if (!key) return
        // x 를 [0,1] 로 클램프하면 베지어 역산 실패가 구조적으로 불가능해진다.
        if (handles.out) key.out = { x: clamp(handles.out.x, 0, 1), y: handles.out.y }
        if (handles.in) key.in = { x: clamp(handles.in.x, 0, 1), y: handles.in.y }
        key.interp = 'bezier'
        // 핸들을 직접 만졌으면 더 이상 프리셋 곡선이 아니다.
        delete key.easingPreset
        delete key.spring
        markPresetDirty(d)
        // coalesce 는 프레임이 아니라 트랙 단위다. Shift 미러 드래그는 out 과 in 을
        // 서로 다른 키에 번갈아 쓰는데, 프레임을 키에 넣으면 병합이 통째로 무력화된다.
      }, `handles:${layerId}:${prop}`)
    },

    setCanvasSize(w, h, options) {
      mutateDoc('캔버스 크기', (d) => {
        const beforeW = d.canvas.w
        const beforeH = d.canvas.h
        const nextW = clamp(Math.round(w), CANVAS_MIN, CANVAS_MAX)
        const nextH = clamp(Math.round(h), CANVAS_MIN, CANVAS_MAX)
        d.canvas.w = nextW
        d.canvas.h = nextH

        if (options?.scaleContent !== true) return
        if (beforeW <= 0 || beforeH <= 0) return

        /*
         * 두 축 비율 중 **작은 쪽**을 쓴다.
         *
         * 해상도 컨트롤은 비율을 유지하므로 둘이 같다. 인스펙터에서 한 축만 줄인
         * 경우에만 갈리는데, 그때 작은 쪽을 쓰면 줄인 축에 맞춰 그림이 들어가고
         * 한 축만 키운 경우에는 1 이 되어 그림이 그대로 남는다. 큰 쪽을 쓰면
         * 폭만 늘렸는데 그림이 세로로 삐져나간다.
         */
        const factor = Math.min(nextW / beforeW, nextH / beforeH)
        if (!Number.isFinite(factor) || factor <= 0 || Math.abs(factor - 1) < 1e-9) return

        for (const layer of d.layers) {
          /*
           * 손으로 넣은 px 단위 위치도 같이 민다.
           *
           * 프리셋의 이동은 percentOfCanvas 라 캔버스를 따라 저절로 줄어든다.
           * 인스펙터에서 직접 입력한 위치만 px 이고, 그것을 그대로 두면 캔버스를
           * 절반으로 줄였을 때 같은 50px 이 화면에서 두 배로 커진다. fit 과 무관하게
           * 위치는 언제나 캔버스 픽셀이므로 이 보정은 모든 레이어에 적용한다.
           */
          for (const track of layer.tracks) {
            if (track.unit !== 'px') continue
            if (track.prop !== 'translateX' && track.prop !== 'translateY') continue
            for (const key of track.keys) key.v *= factor
          }

          // 채우기/담기/늘이기는 fit 기준 배율이 이미 캔버스를 따라간다.
          // 여기서 또 곱하면 두 번 적용된다.
          if (layer.fit !== 'none') continue
          const current =
            typeof layer.baseScale === 'number' && layer.baseScale > 0 ? layer.baseScale : 1
          layer.baseScale = clamp(current * factor, 0.001, 1000)
        }
      }, 'canvasSize')
    },

    setBackgroundType(type) {
      mutateDoc('배경 변경', (d) => {
        d.canvas.background.type = type
        // 알파 0 인 색으로 단색 배경을 켜면 아무것도 안 바뀐 것처럼 보인다.
        if (type === 'solid' && /^#[0-9a-f]{6}00$/i.test(d.canvas.background.color)) {
          d.canvas.background.color = `${d.canvas.background.color.slice(0, 7)}ff`
        }
      })
    },

    setBackgroundColor(color) {
      mutateDoc('배경색 변경', (d) => {
        // 색 입력은 #rrggbb 만 준다. 알파를 잃지 않도록 불투명으로 채운다.
        d.canvas.background.color = /^#[0-9a-f]{6}$/i.test(color) ? `${color}ff` : color
      }, 'bgColor')
    },

    setFps(fps) {
      mutateDoc('속도 변경', (d) => {
        const next = snapFps(fps)
        d.timeline.fps = next
        // 사용자가 직접 고른 fps 가 곧 새 천장이다. 갱신하지 않으면 속도를 되돌릴 때
        // 옛 천장으로 돌아가 방금 고른 값이 조용히 뒤집힌다.
        if (d.presetRef) d.presetRef.baseFps = next
      })
    },

    setDurationFrames(frames) {
      mutateDoc('길이 변경', (d) => {
        d.timeline.durationFrames = clamp(Math.round(frames), 2, FRAMES_MAX)
      }, 'duration')
    },

    setLoopMode(mode) {
      mutateDoc('반복 방식 변경', (d) => {
        d.timeline.loop.mode = mode
      })
    },

    setLoopCount(count) {
      mutateDoc('반복 횟수 변경', (d) => {
        d.timeline.loop.count = Math.max(0, Math.round(count))
      }, 'loopCount')
    },

    replaceDocument(doc) {
      set({ doc, past: [], future: [] })
    },
  }
})

/** 키프레임 목록을 프레임 순으로 돌려준다. 타임라인 렌더링용. */
export function keyframesOf(layer: Layer, prop: TrackProp): readonly Keyframe[] {
  return findTrack(layer, prop)?.keys ?? []
}
