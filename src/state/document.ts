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
import { applyPatches, enablePatches, produceWithPatches, type Patch } from 'immer'

import {
  CANVAS_MAX,
  CANVAS_MIN,
  FPS_CHOICES,
  FRAMES_MAX,
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

  setLayerFlag(layerId: string, key: 'visible' | 'locked', value: boolean): void
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

  setCanvasSize(w: number, h: number): void
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
        doc: applyPatches(doc, cmd.inversePatches),
        past: past.slice(0, -1),
        future: [cmd, ...future],
      })
    },

    redo() {
      const { doc, past, future } = get()
      const cmd = future[0]
      if (!cmd) return
      set({
        doc: applyPatches(doc, cmd.patches),
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

        // 첫 이미지는 캔버스를 이미지 비율에 맞춘다. 사용자가 크기를 먼저
        // 정하게 만들면 3클릭 온보딩이 깨진다.
        if (d.layers.length === 1) {
          const long = Math.max(bitmap.width, bitmap.height)
          const scale = long > 1080 ? 1080 / long : 1
          d.canvas.w = clamp(Math.round(bitmap.width * scale), CANVAS_MIN, CANVAS_MAX)
          d.canvas.h = clamp(Math.round(bitmap.height * scale), CANVAS_MIN, CANVAS_MAX)
        }
      })

      return { assetId, layerId }
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
            d.assets = d.assets.filter((a) => a.id !== removed.assetId)
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

    setCanvasSize(w, h) {
      mutateDoc('캔버스 크기', (d) => {
        d.canvas.w = clamp(Math.round(w), CANVAS_MIN, CANVAS_MAX)
        d.canvas.h = clamp(Math.round(h), CANVAS_MIN, CANVAS_MAX)
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
