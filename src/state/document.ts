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
  PERSPECTIVE_DEFAULT,
  PERSPECTIVE_MAX,
  type AssetPrep,
  type AssetRef,
  type BackgroundType,
  type BlendMode,
  type CharAnimSpec,
  type CutSpec,
  type FitMode,
  type FrameFit,
  type Handle,
  type EffectInstance,
  type Keyframe,
  type Modifier,
  type Layer,
  type LoopMode,
  type MotionProject,
  type RevealSpec,
  type ShapeSpec,
  type TextSpec,
  type Track,
  type TrackProp,
} from '@/core/types.ts'
import {
  TRACK_DEFAULTS,
  createEmptyProject,
  createFolderLayer,
  createImageLayer,
  createShapeLayer,
  createTextLayer,
  createStaticTrack,
  nextId,
} from '@/core/factory.ts'
import { MAX_FOLDER_DEPTH } from '@/core/group.ts'
import { normalizeShapeSpec } from '@/core/shape.ts'
import { normalizeTextSpec } from '@/core/text.ts'
import { createCharAnimSpec, normalizeCharAnimSpec } from '@/core/charAnim.ts'
import { createRevealSpec, normalizeRevealSpec } from '@/core/reveal.ts'
import { evalTrack, insertKeyframe } from '@/easing/curve.ts'
import { EASING_PRESET_BY_ID } from '@/easing/presets.ts'
import {
  mergePresetAnchor,
  mergePresetCharAnim,
  mergePresetEffects,
  mergePresetPerspective,
  mergePresetReveal,
  mergePresetTracks,
  ownershipOf,
} from '@/motions/merge.ts'
import { probeAlpha } from '@/imageprep/alphaProbe.ts'
import { assetRegistry } from './assets.ts'

enablePatches()

/** 스택 상한. 200 엔트리다. */
const HISTORY_LIMIT = 200
/** 같은 coalesceKey 가 이 시간 안에 다시 오면 하나로 합친다. */
const COALESCE_MS = 500
/**
 * 한 엔트리가 품을 수 있는 패치 수의 상한.
 *
 * 병합은 패치를 덧붙이기만 한다. 같은 자리를 반복해서 덮는 패치를 접지 않는 이유는
 * splice 처럼 add/remove 가 섞인 패치를 경로만 보고 접으면 순서가 무너지기 때문이다.
 * 대신 한 칸이 너무 커지면 병합을 멈추고 새 칸을 연다. 도형 세트의 세기 슬라이더처럼
 * 레이어 아홉 장을 초당 일곱 번 갈아끼우는 조작이 실행취소 한 칸에 수 MB 를 쌓던
 * 문제가 여기서 막힌다. 드래그가 두어 칸으로 나뉘는 대신 메모리가 엔트리 수로 묶인다.
 */
const COALESCE_PATCH_LIMIT = 240

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

/**
 * 도형 레이어 한 장의 재료.
 *
 * shapes/types.ts 의 SceneLayer 와 모양이 같지만 그쪽을 import 하지 않는다.
 * 문서 스토어가 세트 카탈로그를 알면 core 가 UI 쪽 데이터에 묶인다. 구조만 맞춘다.
 */
export interface ShapeLayerInput {
  name: string
  shape: ShapeSpec
  tracks: Track[]
  modifiers?: Modifier[]
  blend?: BlendMode
  anchor?: [number, number]
  /** 경계선이 지나가는 모양. 진행률은 `reveal` 트랙이 민다. */
  reveal?: RevealSpec
}

export interface AddShapeSceneInput {
  /** 실행취소 목록에 보일 이름. */
  label: string
  layers: ShapeLayerInput[]
  durationFrames: number
  /**
   * 반복 방식 제안. **생략하면 지금 설정을 그대로 둔다.**
   *
   * 반복은 공통 노브다. 세트를 하나 넣었다고 사용자가 고른 '한 번만' 을 덮으면
   * 조정값을 날린다. 프리셋 쪽과 같은 규칙이고(state/presetActions.ts), 그래서
   * 호출부가 첫 삽입일 때만 채운다.
   */
  loopMode?: LoopMode
  fps: number
  /**
   * 이 레이어들을 지우고 그 자리에 넣는다.
   *
   * 세기나 속도 슬라이더를 끌면 같은 세트를 계속 다시 만든다. 지우지 않으면
   * 드래그 한 번에 도형이 수십 장 쌓인다. coalesceKey 와 짝이다.
   */
  replace?: string[]
  coalesceKey?: string
  /**
   * 만든 레이어들을 이 이름의 폴더로 묶는다.
   *
   * 세트 하나가 도형을 스무 장까지 만든다. 목록에 스무 줄이 그대로 쏟아지면
   * 그다음 작업이 전부 스크롤 싸움이 된다. 폴더로 묶으면 한 줄이고, **그 한 줄에
   * 모션을 걸면 세트 전체가 함께 움직인다.**
   */
  folderName?: string
}

interface DocumentState {
  doc: MotionProject
  past: Command[]
  future: Command[]

  undo(): void
  redo(): void
  clearHistory(): void

  addImage(input: AddImageInput): { assetId: string; layerId: string }
  /**
   * 도형 레이어 한 장을 만든다.
   *
   * addImage 와 달리 캔버스 크기를 건드리지 않는다. 도형에는 "원본 픽셀" 이 없어서
   * 캔버스를 맞출 기준이 없고, 이미 잡혀 있는 캔버스에 얹는 것이 언제나 맞다.
   */
  addShape(input: { name: string; shape: ShapeSpec }): { layerId: string }
  /**
   * 글자 레이어 한 장을 만든다.
   *
   * addShape 와 같은 규칙이다. 캔버스를 건드리지 않고 이미 잡힌 캔버스에 얹는다.
   */
  addText(input: { name: string; text: TextSpec }): { layerId: string }
  /**
   * 도형 모션 세트를 통째로 심는다.
   *
   * 레이어마다 addShape 를 부르면 안 된다. 물결 파동 하나가 실행취소 세 칸을 먹고,
   * 그 중간에 링이 한 장만 있는 상태가 문서로 남는다. 한 번의 변경으로 묶는다.
   */
  addShapeScene(input: AddShapeSceneInput): { layerIds: string[] }
  /** 도형의 모양을 바꾼다. 값 규칙은 core/shape.ts 한 곳에만 있다. */
  setShapeSpec(layerId: string, patch: Partial<ShapeSpec>): void
  /** 글자 내용과 모양을 바꾼다. 값 규칙은 core/text.ts 한 곳에만 있다. */
  setTextSpec(layerId: string, patch: Partial<TextSpec>): void
  /**
   * 글자가 들어오는 모양을 바꾼다. 값 규칙은 core/charAnim.ts 한 곳에만 있다.
   *
   * 'none' 으로 되돌리면 필드를 지운다. 가리기와 같은 이유다(저장 JSON 왕복).
   */
  setLayerCharAnim(layerId: string, patch: Partial<CharAnimSpec>): void
  /**
   * 등장이 시작하는 프레임과 걸리는 프레임 수. 곧 등장 속도다.
   *
   * 진행률 트랙을 **등속 0 -> 1 로 다시 쓴다.** 그래프 에디터로 찍어 둔 키가 있으면
   * 지워진다. 속도 조절은 "이만큼에 걸쳐 들어와라" 라는 지시라 그 편이 맞다.
   * 속도 곡선은 이 트랙이 아니라 글자마다 charAnim.ease 가 건다.
   */
  setCharInSpan(layerId: string, startFrame: number, frames: number): void
  /**
   * 가리기 모양을 바꾼다. 값 규칙은 core/reveal.ts 한 곳에만 있다.
   *
   * 'none' 으로 되돌리면 필드를 지운다. 남겨 두면 저장 파일에 아무 일도 하지 않는
   * 객체가 남아 왕복 JSON 이 달라진다.
   */
  setLayerReveal(layerId: string, patch: Partial<RevealSpec>): void
  /** 3D 회전에 쓰는 카메라 거리. 기본값과 같으면 필드를 지운다. */
  setLayerPerspective(layerId: string, value: number): void
  removeLayer(layerId: string): void
  reorderLayer(layerId: string, direction: -1 | 1): void

  /**
   * 폴더를 만든다. layerIds 를 주면 그 레이어들을 바로 담는다.
   *
   * 폴더는 아무것도 그리지 않고, 자기 변환이 안쪽 레이어 바깥에 곱해진다.
   * 그래서 폴더에 모션 A 를 걸고 안의 그림에 모션 B 를 걸면 둘이 함께 보인다.
   */
  addFolder(input?: { name?: string; layerIds?: string[] }): { folderId: string }
  /**
   * 레이어를 폴더에 넣거나(folderId) 밖으로 꺼낸다(null).
   *
   * 순환은 만들지 않는다. 폴더를 자기 자손 안으로 넣으려 하면 아무 일도 하지 않는다.
   */
  setLayerFolder(layerIds: string[], folderId: string | null): void
  /**
   * 바로 아래 레이어 모양으로 자를지. 값 규칙은 core/clip.ts 한 곳에만 있다.
   *
   * 끄면 필드를 지운다. 거짓을 남겨 두면 저장 JSON 이 왕복에서 달라진다.
   */
  setLayerClip(layerIds: string[], on: boolean): void

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
    /**
     * 이 프리셋이 요구하는 가리기 모양. **언제나 통째로 대체한다.**
     *
     * motionExitsFrame 과 같은 규칙이다. 프리셋에서 파생된 사실이므로 프리셋을
     * 갈아탈 때 앞 프리셋의 경계선이 남아 있으면 안 된다. 없으면 지운다.
     */
    reveal?: RevealSpec
    /** 이 프리셋이 요구하는 글자 등장 모양. 가리기와 같은 규칙이다. */
    charAnim?: CharAnimSpec
    /** 3D 회전에 쓰는 카메라 거리. 없으면 지운다(기본값으로 되돌아간다). */
    perspective?: number
    /** 프리셋이 옮긴 기준점. 없으면 한가운데로 되돌린다. 경첩 계열만 낸다. */
    anchor?: [number, number]
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
  /**
   * 컷 목록과 타임라인 길이를 한 번에 쓴다.
   *
   * 둘을 따로 쓰면 실행취소가 두 칸 쌓이고 그 사이에 길이만 바뀐 문서가 남는다.
   * 컷이 한 개뿐이면 목록을 지운다. 한 컷짜리 문서는 컷이 없는 문서와 같다.
   */
  setCuts(cuts: CutSpec[], durationFrames: number, label: string, coalesceKey?: string): void
  /**
   * 레이어가 보이는 구간을 정한다. null 이면 구간을 지워 처음부터 끝까지 보이게 한다.
   * 여러 장을 한 번에 바꾸는 이유는 컷 배정이 언제나 여러 장을 함께 옮기기 때문이다.
   */
  setLayerRange(
    layerIds: readonly string[],
    range: { inFrame: number; outFrame: number; inFade?: number; outFade?: number } | null,
  ): void
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

/**
 * 글자 등장은 **모양만으로는 아무 일도 하지 않는다.**
 *
 * 실제로 글자를 움직이는 것은 진행률(charIn) 트랙이고, 그 항등값은 1 이다.
 * 1 은 "이미 다 들어와 제자리에 있다" 는 뜻이라, 트랙이 없으면 방향을 아무리 골라도
 * 화면이 한 픽셀도 바뀌지 않는다. 방향을 고르는 것은 곧 "움직이게 해 달라" 는
 * 뜻이므로 트랙이 없으면 여기서 만들어 준다.
 *
 * **이미 있으면 손대지 않는다.** 그래프 에디터로 다듬어 둔 곡선을 방향만 바꿨다고
 * 지우면, 사용자가 만든 것을 말없이 되돌리는 셈이 된다.
 *
 * **곡선은 여기 걸지 않는다.** 이 트랙은 "글자들이 차례로 출발하는" 컨베이어라
 * 등속이어야 하고, 속도 곡선은 글자마다 charAnim.ease 가 건다. 둘 다 걸면 곡선이
 * 두 번 먹어 앞 글자만 빨라지고 뒤 글자는 기어 오는 이상한 리듬이 된다.
 */
function writeCharInSpan(layer: Layer, start: number, end: number): void {
  let track = findTrack(layer, 'charIn')
  if (!track) {
    track = createStaticTrack('charIn', 'ratio', 0)
    layer.tracks.push(track)
  }
  track.animated = true
  track.keys = [
    { f: start, v: 0, interp: 'linear' },
    { f: end, v: 1, interp: 'linear' },
  ]
}

/**
 * 폴더에 담긴 레이어가 폴더 **바로 뒤에** 오도록 배열을 정리하고 z 를 다시 매긴다.
 *
 * 이 한 가지 규칙 덕분에 렌더러가 폴더의 존재를 몰라도 순서를 맞게 그린다. z 로
 * 정렬하면 한 폴더의 식구가 저절로 붙어 있기 때문이다. 정리하지 않으면 폴더 밖
 * 레이어가 폴더 식구들 사이에 끼어 들어가고, 그러면 "폴더째로 앞에 놓기" 가
 * 불가능해진다.
 *
 * 배열을 통째로 재대입한다. 레이어 순서를 바꾸는 조작에서는 어차피 거의 모든
 * 원소가 움직이므로, splice 를 반복하는 것보다 패치가 작다.
 */
function normalizeFolderOrder(d: MotionProject): void {
  const childrenOf = new Map<string, Layer[]>()
  const roots: Layer[] = []

  for (const layer of d.layers) {
    const parent = layer.folderId
    // 없는 폴더를 가리키거나 자기 자신을 가리키면 최상위로 본다.
    const valid =
      parent !== undefined &&
      parent !== layer.id &&
      d.layers.some((l) => l.id === parent && l.type === 'group')
    if (!valid) {
      roots.push(layer)
      continue
    }
    const list = childrenOf.get(parent!)
    if (list) list.push(layer)
    else childrenOf.set(parent!, [layer])
  }

  /*
   * 중복 제거는 **id 가 아니라 객체 자체로** 한다.
   *
   * 다른 문서에서 온 레이어와 id 가 겹치는 일이 실제로 있다. id 로 걸러내면 그중
   * 한 장이 out 에 못 들어가서, 순서를 정리했을 뿐인데 레이어가 조용히 사라진다.
   * 객체 동일성은 무슨 일이 있어도 겹치지 않는다.
   */
  const out: Layer[] = []
  const emitted = new Set<Layer>()
  const emit = (layer: Layer, depth: number): void => {
    if (emitted.has(layer) || depth > MAX_FOLDER_DEPTH) return
    emitted.add(layer)
    out.push(layer)
    for (const child of childrenOf.get(layer.id) ?? []) emit(child, depth + 1)
  }
  for (const root of roots) emit(root, 0)
  // 순환이나 깊이 상한에 걸려 못 나온 레이어는 최상위로 끌어올린다. 사라지면 안 된다.
  for (const layer of d.layers) {
    if (emitted.has(layer)) continue
    delete layer.folderId
    emitted.add(layer)
    out.push(layer)
  }

  /*
   * **자리 하나씩 갈아 끼운다.** 배열을 통째로 재대입하면 안 된다.
   *
   * immer 는 `d.layers = out` 을 ['layers'] 전체 스냅샷 패치 하나로 기록한다. 순서가
   * 한 칸도 안 바뀐 경우에도 배열 참조가 달라졌다는 이유로 기록되므로, 레이어를
   * 건드리는 모든 조작이 문서 전체 사본을 실행취소 스택에 쌓는다. 스무 장짜리
   * 문서에서 슬라이더를 끄는 동안 메모리가 그대로 터진다.
   *
   * 자리별로 비교해 다른 곳만 쓰면 패치가 실제로 움직인 개수만큼만 생긴다.
   * 순서가 그대로면 패치가 아예 없다. z 도 같은 이유로 값이 다를 때만 쓴다.
   */
  for (let i = 0; i < out.length; i += 1) {
    if (d.layers[i] !== out[i]) d.layers[i] = out[i]!
  }
  d.layers.forEach((l, i) => {
    if (l.z !== i) l.z = i
  })
}

/** layerId 가 folderId 안에 (몇 겹이든) 들어 있는가. 순환을 만들지 않기 위한 검사다. */
function isInsideFolder(d: MotionProject, layerId: string, folderId: string): boolean {
  let cursor: string | undefined = folderId
  const seen = new Set<string>()
  while (cursor) {
    if (cursor === layerId) return true
    if (seen.has(cursor)) return false
    seen.add(cursor)
    cursor = d.layers.find((l) => l.id === cursor)?.folderId
  }
  return false
}

function ensureCharInTrack(d: MotionProject, layer: Layer): void {
  if (findTrack(layer, 'charIn')) return
  writeCharInSpan(layer, 0, Math.max(1, d.timeline.durationFrames - 1))
}

/**
 * 등장이 언제 시작해 몇 프레임 동안 이어지는가. 인스펙터의 속도 조절이 읽는다.
 *
 * 트랙의 첫 키와 마지막 키가 그대로 답이다. 트랙이 없으면 ensureCharInTrack 이
 * 만들 값을 미리 답한다. 그래야 모양을 고르는 순간 숫자가 튀지 않는다.
 */
export function charInSpanOf(
  layer: Layer,
  durationFrames: number,
): { start: number; frames: number } {
  const full = Math.max(1, durationFrames - 1)
  const track = findTrack(layer, 'charIn')
  if (!track || track.keys.length === 0) return { start: 0, frames: full }

  const first = track.keys[0]!
  const last = track.keys[track.keys.length - 1]!
  return { start: Math.max(0, first.f), frames: Math.max(1, last.f - first.f) }
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
      !!coalesceKey &&
      !!top &&
      top.coalesceKey === coalesceKey &&
      now - top.timestamp < COALESCE_MS &&
      top.patches.length + patches.length <= COALESCE_PATCH_LIMIT

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

    addShape({ name, shape }) {
      let layerId = ''
      mutateDoc('도형 추가', (d) => {
        const layer = createShapeLayer(normalizeShapeSpec(shape), name, d.layers.length)
        layerId = layer.id
        d.layers.push(layer)
      })
      return { layerId }
    },

    addText({ name, text }) {
      let layerId = ''
      mutateDoc('글자 추가', (d) => {
        const layer = createTextLayer(normalizeTextSpec(text), name, d.layers.length)
        layerId = layer.id
        d.layers.push(layer)
      })
      return { layerId }
    },

    addShapeScene({ label, layers, durationFrames, loopMode, fps, replace, coalesceKey, folderName }) {
      const layerIds: string[] = []
      mutateDoc(
        label,
        (d) => {
          if (replace && replace.length > 0) {
            const drop = new Set(replace)
            // filter 로 배열을 재대입하면 immer 가 ['layers'] 전체 스냅샷 패치를
            // 기록한다. 지운 항목만 splice 한다 (removeLayer 와 같은 이유).
            for (let i = d.layers.length - 1; i >= 0; i -= 1) {
              if (drop.has(d.layers[i]?.id ?? '')) d.layers.splice(i, 1)
            }
          }

          /*
           * 폴더가 먼저 들어간다. 폴더는 자기 뒤에 오는 식구들의 좌표계를 정하므로
           * 목록에서도 앞자리다 (state/document.ts normalizeFolderOrder).
           * 반환하는 layerIds 에도 포함시킨다. 그래야 슬라이더를 끌어 세트를 다시
           * 만들 때 빈 폴더가 남지 않는다.
           */
          let folderId: string | undefined
          if (folderName !== undefined && layers.length > 0) {
            const folder = createFolderLayer(folderName, d.layers.length)
            folderId = folder.id
            layerIds.push(folder.id)
            d.layers.push(folder)
          }

          for (const input of layers) {
            const layer = createShapeLayer(
              normalizeShapeSpec(input.shape),
              input.name,
              d.layers.length,
            )
            if (folderId) layer.folderId = folderId
            if (input.anchor) {
              layer.anchor = [clamp(input.anchor[0], 0, 1), clamp(input.anchor[1], 0, 1)]
            }
            if (input.blend) layer.blend = input.blend
            if (input.reveal && input.reveal.mode !== 'none') {
              layer.reveal = normalizeRevealSpec(input.reveal)
            }
            // id 는 여기서 다시 매긴다. 장면 정의는 같은 id 를 여러 레이어에 쓴다.
            layer.tracks = input.tracks.map((t) => ({ ...t, id: nextId('t') }))
            layer.modifiers = (input.modifiers ?? []).map((m) => ({ ...m, id: nextId('m') }))
            layerIds.push(layer.id)
            d.layers.push(layer)
          }

          normalizeFolderOrder(d)

          d.timeline.durationFrames = clamp(Math.round(durationFrames), 2, FRAMES_MAX)
          if (loopMode !== undefined) d.timeline.loop.mode = loopMode
          d.timeline.fps = snapFps(fps)
          /*
           * 세트는 프리셋이 아니다. presetRef 를 건드리지 않는다.
           *
           * presetRef 는 "문서에 걸린 모션 프리셋 하나" 를 가리키고 EASY 의 세기/속도
           * 슬라이더가 그것을 다시 적용한다. 세트가 그 자리를 차지하면 슬라이더가
           * 도형을 지우고 이미지 모션을 다시 그린다.
           *
           * baseFps 도 건드리지 않는다. 그 필드의 뜻은 **사용자가 고른 fps** 이고
           * 속도 유도 fps 의 천장이다(core/types.ts). 도형 속도 노브에서 유도된 값을
           * 거기 넣으면, 모션 속도를 1 로 되돌려도 원래 fps 로 못 돌아온다.
           */
        },
        coalesceKey,
      )
      return { layerIds }
    },

    setShapeSpec(layerId, patch) {
      mutateDoc(
        '도형 바꾸기',
        (d) => {
          const layer = findLayer(d, layerId)
          if (!layer || !layer.shape) return
          layer.shape = normalizeShapeSpec({ ...layer.shape, ...patch })
        },
        `shape:${layerId}`,
      )
    },

    setTextSpec(layerId, patch) {
      mutateDoc(
        '글자 바꾸기',
        (d) => {
          const layer = findLayer(d, layerId)
          if (!layer || !layer.text) return
          layer.text = normalizeTextSpec({ ...layer.text, ...patch })
        },
        `text:${layerId}`,
      )
    },

    setLayerCharAnim(layerId, patch) {
      mutateDoc(
        '글자 등장 변경',
        (d) => {
          const layer = findLayer(d, layerId)
          if (!layer) return
          const next = normalizeCharAnimSpec({
            ...createCharAnimSpec('none'),
            ...layer.charAnim,
            ...patch,
          })
          if (next.mode === 'none') {
            delete layer.charAnim
          } else {
            layer.charAnim = next
            // 모양만 정하면 화면이 그대로다. 진행률 트랙이 없으면 만들어 준다.
            ensureCharInTrack(d, layer)
          }
          // 손으로 만졌으므로 EASY 의 세기/속도 슬라이더가 이 값을 덮지 않게 한다.
          markPresetDirty(d)
        },
        `charAnim:${layerId}`,
      )
    },

    setCharInSpan(layerId, startFrame, frames) {
      mutateDoc(
        '등장 시간 바꾸기',
        (d) => {
          const layer = findLayer(d, layerId)
          if (!layer) return
          // 마지막 출력 프레임을 넘어가면 등장이 끝나지 않은 채로 파일이 끝난다.
          const lastFrame = Math.max(1, d.timeline.durationFrames - 1)
          const start = clamp(Math.round(startFrame), 0, lastFrame - 1)
          const span = clamp(Math.round(frames), 1, lastFrame - start)
          writeCharInSpan(layer, start, start + span)
          markPresetDirty(d)
        },
        `charInSpan:${layerId}`,
      )
    },

    setLayerReveal(layerId, patch) {
      mutateDoc(
        '가리기 변경',
        (d) => {
          const layer = findLayer(d, layerId)
          if (!layer) return
          const next = normalizeRevealSpec({ ...createRevealSpec('none'), ...layer.reveal, ...patch })
          if (next.mode === 'none') delete layer.reveal
          else layer.reveal = next
          // 손으로 만졌으므로 EASY 의 세기/속도 슬라이더가 이 값을 덮지 않게 한다.
          markPresetDirty(d)
        },
        `reveal:${layerId}`,
      )
    },

    setLayerPerspective(layerId, value) {
      mutateDoc(
        '원근 변경',
        (d) => {
          const layer = findLayer(d, layerId)
          if (!layer) return
          /*
           * 기본값이어도 필드를 남긴다.
           *
           * 예전에는 기본값이면 지웠는데, 인스펙터의 원근 입력행이 그 필드의 존재로
           * 표시 여부를 정한다. 숫자 칸은 글자 하나마다 값을 보내므로 "2.5" 를 치는
           * 순간 필드가 지워지고 입력행이 발밑에서 사라졌다. 사용자가 직접 정한 값은
           * 기본값과 같더라도 사용자가 정했다는 사실 자체가 정보다.
           */
          layer.perspective = Number.isFinite(value)
            ? clamp(value, 0, PERSPECTIVE_MAX)
            : PERSPECTIVE_DEFAULT
          markPresetDirty(d)
        },
        `persp:${layerId}`,
      )
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

        /*
         * 폴더를 지우면 **안의 레이어는 한 겹 밖으로 나온다.** 함께 지우지 않는다.
         * 정리하려고 만든 상자를 지웠다고 안에 든 것까지 사라지면, 되돌리기를 모르는
         * 사람은 그림을 잃는다. 안까지 지우고 싶으면 레이어를 골라 지우면 된다.
         */
        if (removed.type === 'group') {
          for (const l of d.layers) {
            if (l.folderId !== removed.id) continue
            if (removed.folderId) l.folderId = removed.folderId
            else delete l.folderId
          }
        }

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
        normalizeFolderOrder(d)
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

    addFolder(input = {}) {
      let folderId = ''
      mutateDoc('폴더 만들기', (d) => {
        const wanted = (input.layerIds ?? []).filter((id) =>
          d.layers.some((l) => l.id === id),
        )
        /*
         * 폴더는 담을 레이어들 **바로 앞자리**에 놓는다.
         *
         * 맨 뒤에 만들면 정리 순서가 뒤바뀐 채로 나타나서, 사용자가 폴더를 만들자마자
         * 목록을 다시 끌어 옮겨야 한다. normalizeFolderOrder 가 뒤이어 식구들을
         * 붙여 주므로 여기서는 앞자리만 잡으면 된다.
         */
        const first = wanted.length > 0
          ? Math.min(...wanted.map((id) => d.layers.findIndex((l) => l.id === id)))
          : d.layers.length

        const folder = createFolderLayer(input.name ?? '폴더', first)
        folderId = folder.id
        d.layers.splice(first, 0, folder)

        for (const id of wanted) {
          const layer = d.layers.find((l) => l.id === id)
          if (layer) layer.folderId = folder.id
        }
        normalizeFolderOrder(d)
      })
      return { folderId }
    },

    setLayerFolder(layerIds, folderId) {
      mutateDoc('폴더 옮기기', (d) => {
        if (folderId !== null) {
          const folder = d.layers.find((l) => l.id === folderId)
          if (!folder || folder.type !== 'group') return
        }

        for (const id of layerIds) {
          const layer = d.layers.find((l) => l.id === id)
          if (!layer) continue
          if (folderId === null) {
            delete layer.folderId
            continue
          }
          // 자기 자신이나 자기 자손 안으로는 못 들어간다. 사슬이 끊기지 않게 한다.
          if (id === folderId) continue
          if (isInsideFolder(d, id, folderId)) continue
          layer.folderId = folderId
        }
        normalizeFolderOrder(d)
      })
    },

    setLayerClip(layerIds, on) {
      mutateDoc('자르기 변경', (d) => {
        for (const id of layerIds) {
          const layer = findLayer(d, id)
          if (!layer) continue
          if (on) layer.clipToBelow = true
          else delete layer.clipToBelow
        }
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

        /*
         * 놓은 자리가 곧 폴더 소속이다.
         *
         * 목록에서 폴더 안으로 끌어다 놓았는데 그대로 튕겨 나오면, 사용자는 폴더가
         * 고장 났다고 읽는다. **바로 아래 이웃**을 따른다. 이웃이 폴더 자신이면
         * 그 폴더의 첫 자리에 놓인 것이고, 이웃이 어떤 폴더 안에 있으면 같은 폴더다.
         *
         * 순환은 만들지 않는다. 폴더를 자기 자손 안으로 끌면 소속을 그대로 둔다.
         */
        const below = to > 0 ? d.layers[to - 1] : undefined
        const wanted = below ? (below.type === 'group' ? below.id : below.folderId) : undefined
        if (wanted === undefined) delete moved.folderId
        else if (wanted !== moved.id && !isInsideFolder(d, moved.id, wanted)) {
          moved.folderId = wanted
        }

        normalizeFolderOrder(d)
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

    applyPresetTracks({ layerId, presetId, tracks, modifiers, effects, durationFrames, loopMode, fps, allowExit, containScale, reveal, charAnim, perspective, anchor, baseSec, baseFps, macro }) {
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

        /*
         * 가리기와 원근도 트랙 / 이펙트와 같은 소유권 규칙을 탄다.
         * 앞 프리셋이 심은 것만 걷어내고 사용자가 인스펙터에서 만든 것은 살린다.
         */
        const nextReveal = mergePresetReveal(layer.reveal, reveal, owned)
        if (nextReveal) layer.reveal = normalizeRevealSpec(nextReveal)
        else delete layer.reveal

        const nextCharAnim = mergePresetCharAnim(layer.charAnim, charAnim, owned)
        if (nextCharAnim) layer.charAnim = normalizeCharAnimSpec(nextCharAnim)
        else delete layer.charAnim

        const nextPerspective = mergePresetPerspective(layer.perspective, perspective, owned)
        if (nextPerspective !== undefined) {
          layer.perspective = clamp(nextPerspective, 0, PERSPECTIVE_MAX)
        } else {
          delete layer.perspective
        }

        /*
         * 기준점만 규칙이 조금 다르다. 지울 수 있는 값이 아니라 언제나 두 숫자를
         * 갖는 필드라, 걷어낼 때는 한가운데로 되돌린다. 값이 그대로면 대입하지
         * 않는다. immer 가 배열 대입을 패치로 기록하기 때문이다.
         */
        const nextAnchor = mergePresetAnchor(layer.anchor, anchor, owned)
        if (nextAnchor[0] !== layer.anchor[0] || nextAnchor[1] !== layer.anchor[1]) {
          layer.anchor = nextAnchor
        }

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
          // 재적용 대상을 추측하지 않고 기록한다. 트랙을 내지 않는 프리셋
          // (흔들기/자글자글/지지직)은 props 가 비어 소유 레이어를 역추적할 수 없다.
          layerId,
          macro: { ...macro },
          dirty: false,
          props: tracks.map((t) => t.prop),
          effectIds: nextFx.map((e) => e.id),
          // 다음 프리셋이 "이건 내가 지워도 되는 것" 을 알아보는 표식이다.
          ...(reveal && reveal.mode !== 'none' ? { ownsReveal: true } : {}),
          ...(charAnim && charAnim.mode !== 'none' ? { ownsCharAnim: true } : {}),
          ...(perspective !== undefined ? { ownsPerspective: true } : {}),
          ...(anchor ? { ownsAnchor: true } : {}),
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
          // 새 키를 만들 때와 같다. 값만 바꾼 것도 PRO 편집이므로 EASY 슬라이더의
          // 재적용이 이 값을 덮지 않게 막는다. 프리셋 트랙은 f:0 에 키가 있어서
          // 기본 재생 헤드(0)에서 고치면 항상 이 분기로 들어온다.
          markPresetDirty(d)
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
        // setFps 가 baseFps 를 갱신하는 것과 같은 이유다. 사용자가 직접 넣은 길이가
        // 곧 새 기준선이다. 갱신하지 않으면 세기 슬라이더를 한 번 스치는 순간
        // 재적용이 옛 baseSec 으로 길이를 되돌려 방금 넣은 값이 사라진다.
        // baseSec 은 속도 1 기준이므로 지금 macro.speed 를 곱해 되짚는다.
        if (d.presetRef && d.timeline.fps > 0) {
          d.presetRef.baseSec =
            (d.timeline.durationFrames / d.timeline.fps) * d.presetRef.macro.speed
        }
      }, 'duration')
    },

    setCuts(cuts, durationFrames, label, coalesceKey) {
      mutateDoc(
        label,
        (d) => {
          if (cuts.length <= 1) delete d.cuts
          else d.cuts = cuts.map((c) => ({ ...c }))
          d.timeline.durationFrames = clamp(Math.round(durationFrames), 2, FRAMES_MAX)
        },
        coalesceKey,
      )
    },

    setLayerRange(layerIds, range) {
      const ids = new Set(layerIds)
      mutateDoc(range ? '컷에 넣기' : '구간 해제', (d) => {
        for (const layer of d.layers) {
          if (!ids.has(layer.id)) continue
          if (!range) {
            delete layer.inFrame
            delete layer.outFrame
            delete layer.inFade
            delete layer.outFade
            continue
          }
          layer.inFrame = Math.max(0, Math.round(range.inFrame))
          layer.outFrame = Math.max(layer.inFrame, Math.round(range.outFrame))
          // 0 이면 키를 남기지 않는다. 아무 일도 하지 않는 값이 저장 파일에 남으면
          // 왕복 JSON 이 달라진다 (도형 / 가리기와 같은 규칙).
          if (range.inFade && range.inFade > 0) layer.inFade = Math.round(range.inFade)
          else delete layer.inFade
          if (range.outFade && range.outFade > 0) layer.outFade = Math.round(range.outFade)
          else delete layer.outFade
        }
      })
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
