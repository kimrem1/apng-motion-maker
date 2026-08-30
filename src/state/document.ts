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
  MOTION_REPEAT_MAX,
  MOTION_REPEAT_MIN,
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
import { MAX_FOLDER_DEPTH, folderChain } from '@/core/group.ts'
import { normalizeShapeSpec } from '@/core/shape.ts'
import { normalizeTextSpec } from '@/core/text.ts'
import { createCharAnimSpec, normalizeCharAnimSpec } from '@/core/charAnim.ts'
import { createRevealSpec, normalizeRevealSpec } from '@/core/reveal.ts'
import { unitScale } from '@/core/evaluate.ts'
import { evalTrack, insertKeyframe } from '@/easing/curve.ts'
import { EASING_PRESET_BY_ID } from '@/easing/presets.ts'
import {
  mergePresetAnchor,
  mergePresetCharAnim,
  mergePresetEffects,
  mergePresetPerspective,
  mergePresetReveal,
  mergePresetTracks,
  ownershipFor,
  presetOwnershipRecord,
} from '@/motions/merge.ts'
import {
  applyMotionBundle,
  bundleIsEmpty,
  clearMotion,
  extractMotion,
  type IdMinter,
  type MotionParts,
} from '@/motions/transfer.ts'
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
   * 반복 방식 제안. 생략하면 지금 설정을 그대로 둔다.
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
   * 그다음 작업이 전부 스크롤 싸움이 된다. 폴더로 묶으면 한 줄이고, 그 한 줄에
   * 모션을 걸면 세트 전체가 함께 움직인다.
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
   * 레이어는 그대로 두고 **그림만** 갈아끼운다. 템플릿의 실체다.
   *
   * 왜 지우고 다시 넣으면 안 되는가
   *
   * 레이어를 새로 만들면 id 가 바뀐다. id 가 바뀌면 트랙 / 모디파이어 / 이펙트 /
   * 가리기 / 등장 / 기준점 / 모션 배수 / 구간 / 폴더 소속 / 깊이감이 전부 딸려
   * 사라진다. 프리셋을 다시 눌러 되살릴 수 있는 것은 그중 프리셋이 심은 것뿐이고,
   * 그래프 에디터로 다듬은 곡선과 손으로 쌓은 이펙트는 돌아오지 않는다.
   * 여기서는 assetId 하나만 바꾼다. 나머지는 한 글자도 건드리지 않는다.
   *
   * 화면에서 차지하던 크기도 지킨다. 맞춤이 '원본 크기'(none)면 그림 크기가 곧
   * 화면 크기라, 500px 로 만든 템플릿에 2000px 를 끼우면 네 배로 튀어나온다.
   * 긴 변이 같아지도록 baseScale 을 민다. cover / contain / fill 은 맞춤이 이미
   * 크기를 정하므로 건드리지 않는다.
   *
   * 캔버스는 건드리지 않는다. addImage 는 들어온 그림에 맞춰 캔버스를 넓히는데,
   * 갈아끼우기에서 그러면 "결과물 해상도가 고정된 템플릿" 이라는 전제가 깨진다.
   *
   * 이미지 레이어가 아니면 아무 일도 하지 않고 null 을 돌려준다.
   */
  replaceLayerImage(layerId: string, input: AddImageInput): { assetId: string } | null
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
   * 진행률 트랙을 등속 0 -> 1 로 다시 쓴다. 그래프 에디터로 찍어 둔 키가 있으면
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
  /**
   * 레이어 한 장을 지운다. 폴더면 **안에 든 것도 함께** 사라진다
   * (몇 겹이든, withFolderContents 주석 참조).
   */
  removeLayer(layerId: string): void
  /**
   * 여러 장을 한 번에 지운다. 실행취소 한 칸이다. 폴더 규칙은 removeLayer 와 같다.
   *
   * removeLayer 를 반복해서 부르면 안 된다. 도형 세트 하나가 스무 장까지 만드는데,
   * 그것을 취소하는 데 Ctrl+Z 를 스무 번 눌러야 하면 취소가 아니다.
   */
  removeLayers(layerIds: readonly string[]): void
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
   * 실행취소 스택에 쌓지 않는다. 픽셀(assetRegistry)은 undo 로 되돌릴 수 없으므로
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
  /**
   * toIndex 는 문서 배열 인덱스(z 오름차순)다.
   *
   * folderId 를 주면 그 소속을 그대로 쓴다(null 이면 최상위로 꺼낸다). 생략하면
   * 놓인 자리의 아래 이웃을 보고 추측한다. 목록에서 끌어다 놓는 경로는 접힌 폴더까지
   * 아는 트리를 이미 들고 있으므로 반드시 지정한다. 추측에 맡기면 접힌 폴더 위에
   * 놓았을 때 그 폴더 안으로 빨려 들어간다 (ui/layers/layerTree.ts).
   */
  moveLayerTo(layerId: string, toIndex: number, folderId?: string | null): void

  /**
   * 지금 걸려 있는 모션 프리셋을 걷어낸다.
   *
   * 프리셋이 심은 것만 지운다. 소유권 기록(레이어의 presetOwnership)이 그대로
   * 답이다. 사용자가 인스펙터에서 직접 만든 트랙과 이펙트, 가리기, 글자 등장은
   * 살아남는다. 같은 카드를 한 번 더 눌러 끄는 경로가 이것을 쓴다.
   */
  clearPreset(): void

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
     * 이 프리셋이 요구하는 가리기 모양. 언제나 통째로 대체한다.
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
   * 한 레이어의 모션과 효과를 다른 레이어들로 보낸다.
   *
   * 무엇이 따라가고 무엇이 남는지는 motions/transfer.ts 한 곳이 정한다.
   * 이름 / 크기 / 맞춤 / 구간 / 담기 배율은 따라가지 않는다.
   *
   * `move` 가 참이면 원본에서 그 갈래를 걷어낸다. 그때 원본이 프리셋을 들고 있던
   * 레이어면 presetRef 도 함께 지운다. 안 지우면 EASY 의 세기/속도 슬라이더를
   * 스치는 순간 방금 걷어낸 모션이 원본에 되살아난다 (state/presetActions.ts).
   *
   * 대상이 여럿이어도 실행취소는 한 칸이다. coalesceKey 를 주지 않으므로 연속으로
   * 두 번 보내면 두 칸이 쌓인다. 보내기는 드래그가 아니라 한 번의 결정이다.
   */
  transferMotion(args: {
    fromLayerId: string
    toLayerIds: readonly string[]
    parts: MotionParts
    move?: boolean
  }): { moved: number; skipped: number }

  /**
   * 이 레이어의 움직임만 몇 배 빠르게 돌린다. 문서 길이와 fps 는 건드리지 않는다.
   *
   * 값 규칙과 왜 정수인지는 core/types.ts 의 Layer.motionRepeat 주석에 있다.
   * 1 이면 키를 지운다. 뜻이 없는 키가 남으면 저장/열기 왕복에서 JSON 이 달라진다.
   */
  setLayerMotionRepeat(layerId: string, repeat: number): void

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
  /**
   * 캔버스에서 끌어 옮긴 자리를 쓴다. 값은 캔버스 픽셀이다.
   *
   * 여러 장을 한 번에 받는 이유는 setLayerRange 와 같다. 드래그 한 번이 실행취소
   * 한 칸이어야 하는데, 레이어마다 따로 쓰면 coalesceKey 가 번갈아 들어와 합쳐지지
   * 않는다. 두 장을 함께 끌면 히스토리가 드래그 스텝 수만큼 쌓인다.
   *
   * 픽셀로 받는 이유는 트랙 단위가 레이어마다 다르기 때문이다. 사진 훑기 프리셋은
   * 이동 트랙을 percentOfCanvas 로 낸다. 화면에서 10px 끈 것을 그 트랙에 10 으로
   * 쓰면 캔버스의 10% 만큼 날아간다. 변환은 evaluate.ts 의 unitScale 한 곳에서만 한다.
   *
   * 애니메이션 중인 위치는 재생헤드에 키를 찍는다. 첫 키만 고치면 나머지 키가 그대로라
   * 손을 떼는 순간 그림이 원래 자리로 돌아간다.
   */
  setLayerTranslate(
    moves: readonly { layerId: string; x: number; y: number }[],
    frame: number,
  ): void
  /** 지정 프레임에 키프레임을 만들거나 갱신한다. */
  setValueAtFrame(layerId: string, prop: TrackProp, frame: number, value: number): void

  /** 속성의 애니메이션을 켜고 끈다. 켜면 현재 값으로 첫 키가 생긴다. */
  toggleAnimated(layerId: string, prop: TrackProp, frame: number): void
  addKeyframe(layerId: string, prop: TrackProp, frame: number): void
  removeKeyframe(layerId: string, prop: TrackProp, frame: number): void
  /**
   * 여러 키프레임을 한 번의 실행취소로 지운다. 다중 선택 삭제가 removeKeyframe 을
   * 하나씩 부르면 키 N개가 히스토리 N칸이 된다 (레이어 삭제의 removeLayers 와 같은 이유).
   */
  removeKeyframes(refs: readonly { layerId: string; prop: TrackProp; frame: number }[]): void
  moveKeyframe(
    layerId: string,
    prop: TrackProp,
    fromFrame: number,
    toFrame: number,
    coalesceKey?: string,
  ): void
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
   * scaleContent 는 해상도를 바꾸는 컨트롤만 켠다 (EASY 의 크기, 인스펙터의
   * 폭/높이). 그때는 그림도 같은 비율로 따라가야 한다. 켜지 않으면 fit 이
   * '원본 크기'인 레이어가 제자리에 남아, 캔버스를 줄인 만큼 그림이 커 보이고
   * 사방이 잘린다 (Layer.baseScale 주석).
   *
   * 자르기 / 여백 제거처럼 원본 픽셀 자체가 달라져서 캔버스가 따라가는 경우는
   * 끈 채로 부른다. 그림은 이미 그만큼 작아져 있으므로 또 줄이면 두 번 줄어든다.
   */
  setCanvasSize(w: number, h: number, options?: { scaleContent?: boolean }): void
  setBackgroundType(type: BackgroundType): void
  setBackgroundColor(color: string): void
  setFps(fps: number): void
  /**
   * 타임라인 길이를 바꾼다.
   *
   * 기본은 **길이 못박기**다. 사용자가 길이를 직접 입력했다는 것은 "이 길이를
   * 지켜 달라" 는 뜻이고, 그때부터 모션/도형의 속도 노브는 전체 길이를 건드리지
   * 못한다 (TimelineConfig.durationPinned). 내보내기 복원처럼 사용자의 선언이
   * 아닌 경로는 pin: false 로 불러 표시를 남기지 않는다.
   */
  setDurationFrames(frames: number, options?: { pin?: boolean }): void
  /** 길이 못박기 표시만 켜고 끈다. 트랜스포트 바의 자물쇠 버튼이 쓴다. */
  setDurationPinned(pinned: boolean): void
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
  /**
   * 레이어마다 서로 다른 구간을 한 번에 쓴다. 타임라인에서 클립 막대를 끌 때 쓴다.
   *
   * setLayerRange 와 나눠 둔 이유는 두 가지다. 저쪽은 여러 장에 **같은** 구간을
   * 씌우는 컷 배정이고, 이쪽은 장마다 다른 구간이다. 그리고 이쪽은 드래그라서
   * coalesceKey 로 실행취소 한 칸에 묶어야 한다. 묶지 않으면 막대를 한 번 끄는
   * 동안 히스토리가 스텝 수만큼 쌓여 Ctrl+Z 를 수십 번 눌러야 한다.
   *
   * 페이드는 건드리지 않되 구간 길이 안으로 접는다. 구간보다 긴 페이드가 남으면
   * 구간 전체가 반투명해져서 "왜 흐릿하지" 가 된다. clearFades 를 켜면 아예 지운다.
   */
  setLayerRanges(
    entries: readonly { layerId: string; inFrame: number; outFrame: number }[],
    label: string,
    options?: { coalesceKey?: string; clearFades?: boolean },
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

/**
 * 이동 트랙에 캔버스 픽셀 값을 쓴다. setLayerTranslate 전용이다.
 *
 * 트랙이 이미 있으면 그 단위를 지킨다. px 로 갈아끼우면 사진 훑기 프리셋이 낸
 * percentOfCanvas 트랙이 드래그 한 번에 단위째 바뀌어, 캔버스 크기를 바꿨을 때
 * 따라가던 성질이 조용히 사라진다.
 */
function writeTranslatePx(
  doc: MotionProject,
  layer: Layer,
  prop: 'translateX' | 'translateY',
  px: number,
  frame: number,
): void {
  const track = findTrack(layer, prop)
  const unit = track?.unit ?? TRACK_DEFAULTS[prop].unit
  const scale = unitScale(prop, unit, doc.canvas)
  const value = scale !== 0 ? px / scale : px

  if (!track) {
    layer.tracks.push(createStaticTrack(prop, unit, value))
    return
  }

  // 애니메이션이 아니면 상수 키 하나를 고친다. 인스펙터의 위치 입력과 같은 경로다.
  if (track.animated !== true && track.keys.length <= 1) {
    const key = track.keys[0]
    if (key) key.v = value
    else track.keys.push({ f: 0, v: value, interp: 'bezier' })
    return
  }

  const at = track.keys.find((k) => k.f === frame)
  if (at) at.v = value
  else {
    track.keys.push({ f: frame, v: value, interp: 'bezier' })
    sortKeys(track)
  }
  // 키를 만지는 것은 PRO 편집이다. EASY 의 세기 슬라이더가 이 값을 덮지 않게 막는다.
  markPresetDirty(doc)
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
 * 글자 등장은 모양만으로는 아무 일도 하지 않는다.
 *
 * 실제로 글자를 움직이는 것은 진행률(charIn) 트랙이고, 그 항등값은 1 이다.
 * 1 은 "이미 다 들어와 제자리에 있다" 는 뜻이라, 트랙이 없으면 방향을 아무리 골라도
 * 화면이 한 픽셀도 바뀌지 않는다. 방향을 고르는 것은 곧 "움직이게 해 달라" 는
 * 뜻이므로 트랙이 없으면 여기서 만들어 준다.
 *
 * 이미 있으면 손대지 않는다. 그래프 에디터로 다듬어 둔 곡선을 방향만 바꿨다고
 * 지우면, 사용자가 만든 것을 말없이 되돌리는 셈이 된다.
 *
 * 곡선은 여기 걸지 않는다. 이 트랙은 "글자들이 차례로 출발하는" 컨베이어라
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
 * 지울 목록을 폴더 안까지 넓힌다. 몇 겹이든 따라 들어간다.
 *
 * 폴더를 지우면 안에 든 것도 함께 사라진다. 목록에서 폴더 한 줄로 보이는 것이
 * 화면에서도 한 덩어리이므로, 그 한 줄을 지웠는데 식구가 최상위로 흩어져 나오면
 * 지운 것보다 늘어난 것처럼 보인다. 상자만 없애고 안은 남기고 싶으면 지우기 전에
 * 꺼내면 된다(목록에서 밖으로 끌어내기).
 *
 * 잃을 걱정은 실행취소가 받는다. 삭제 한 번이 실행취소 한 칸이라 폴더 안에 스무
 * 장이 있어도 Ctrl+Z 하나로 전부 돌아온다.
 */
export function withFolderContents(layers: readonly Layer[], ids: Iterable<string>): Set<string> {
  const drop = new Set(ids)
  const folders = new Set<string>()
  for (const layer of layers) {
    if (layer.type === 'group' && drop.has(layer.id)) folders.add(layer.id)
  }
  if (folders.size === 0) return drop

  for (const layer of layers) {
    if (drop.has(layer.id)) continue
    // 사슬을 타고 올라가므로 몇 겹으로 중첩된 폴더도 한 번에 잡힌다.
    if (folderChain(layers, layer).some((f) => folders.has(f.id))) drop.add(layer.id)
  }
  return drop
}

/**
 * 레이어를 지우는 유일한 경로. 한 장을 지우든 여러 장을 지우든 같은 함수를 탄다.
 *
 * 갈라 두면 "한 장 지우기" 와 "골라서 지우기" 가 서로 다른 규칙을 갖게 된다.
 * 실제로 폴더 처리와 에셋 정리가 두 곳에 따로 적혀 있었다.
 */
function dropLayers(d: MotionProject, ids: readonly string[]): void {
  const drop = withFolderContents(d.layers, ids)
  if (drop.size === 0) return

  for (let i = d.layers.length - 1; i >= 0; i -= 1) {
    const layer = d.layers[i]
    if (!layer || !drop.has(layer.id)) continue
    d.layers.splice(i, 1)
  }

  /*
   * 아무 레이어도 안 쓰는 에셋을 걷어낸다.
   *
   * filter 로 배열을 재대입하면 immer 가 ['assets'] 전체 스냅샷 패치를 기록한다.
   * 그 undo 가 다른 에셋의 나중 갱신(updateAssetPrep)까지 통째로 되돌리므로
   * 반드시 지운 항목만 splice 한다.
   *
   * 비트맵 해제는 하지 않는다. 실행취소로 되돌릴 때 픽셀이 살아 있어야 한다.
   */
  for (let i = d.assets.length - 1; i >= 0; i -= 1) {
    const asset = d.assets[i]
    if (!asset) continue
    if (d.layers.some((l) => l.assetId === asset.id)) continue
    d.assets.splice(i, 1)
  }

  normalizeFolderOrder(d)
}

/**
 * 폴더에 담긴 레이어가 폴더 바로 뒤에 오도록 배열을 정리하고 z 를 다시 매긴다.
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
   * 중복 제거는 id 가 아니라 객체 자체로 한다.
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
   * 자리 하나씩 갈아 끼운다. 배열을 통째로 재대입하면 안 된다.
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
        /*
         * 캔버스는 **맨 처음 넣은 이미지** 크기로 잡고 그 뒤로는 고정한다.
         *
         * 예전에는 들어온 이미지 중 가장 큰 것에 맞춰 캔버스를 넓혔다. 그러면
         * 첫 장으로 화면을 잡아 둔 뒤 큰 참고 이미지를 한 장 얹는 순간 결과물
         * 해상도가 통째로 바뀌었다. 캔버스는 작업의 액자라서, 처음 정해진 뒤에는
         * 사용자가 직접 바꿀 때(setCanvasSize, 자르기)만 움직여야 한다.
         *
         * 첫 판정은 "이미지 레이어가 하나도 없는가" 다. 레이어 수로 재지 않는
         * 이유는 도형이나 글자를 먼저 만들어 둔 문서에서도 첫 이미지가 액자를
         * 정해야 하기 때문이다. 도형에는 원본 픽셀이 없어 기준이 못 된다.
         *
         * 이후에 더 큰 이미지를 넣으면 기본값(fit: none)에서는 캔버스 밖으로
         * 넘친 부분이 잘려 보인다. 액자를 지키는 대가이고, 담기/배율로 줄이는
         * 것은 사용자의 몫이다. 상한은 CANVAS_MAX(4000) 하나뿐이다.
         */
        const firstImage = !d.layers.some((l) => l.type === 'image')

        d.assets.push(ref)
        const layer = createImageLayer(ref, d.layers.length)
        layerId = layer.id
        d.layers.push(layer)

        if (firstImage) {
          d.canvas.w = clamp(Math.round(bitmap.width), CANVAS_MIN, CANVAS_MAX)
          d.canvas.h = clamp(Math.round(bitmap.height), CANVAS_MIN, CANVAS_MAX)
        }
      })

      return { assetId, layerId }
    },

    replaceLayerImage(layerId, { name, bitmap, hasAlpha }) {
      const target = get().doc.layers.find((l) => l.id === layerId)
      // 도형과 글자와 폴더에는 갈아끼울 그림이 없다. 조용히 넘기지 않고 null 로 알린다.
      if (!target || target.type !== 'image') return null

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

      mutateDoc('그림 갈아끼우기', (d) => {
        const layer = findLayer(d, layerId)
        if (!layer) return
        const before = d.assets.find((a) => a.id === layer.assetId)

        d.assets.push(ref)

        /*
         * 화면에서 차지하던 크기를 지킨다 (선언부 주석).
         *
         * 긴 변으로 잰다. 넓이로 재면 가로 사진과 세로 사진을 바꿔 끼울 때 한쪽이
         * 프레임을 넘어간다. 긴 변이 같으면 어느 방향이든 같은 상자 안에 들어온다.
         */
        if (layer.fit === 'none' && before && before.naturalW > 0 && before.naturalH > 0) {
          const beforeLong = Math.max(before.naturalW, before.naturalH)
          const afterLong = Math.max(bitmap.width, bitmap.height)
          if (afterLong > 0) {
            const base =
              typeof layer.baseScale === 'number' && layer.baseScale > 0 ? layer.baseScale : 1
            layer.baseScale = clamp(base * (beforeLong / afterLong), 0.001, 1000)
          }
        }

        /*
         * 이름은 사용자가 손댄 적이 없을 때만 새 파일 이름을 따른다.
         *
         * 레이어 이름은 처음에 파일 이름으로 채워진다. 그대로면 아직 파일 이름이라는
         * 뜻이므로 새 파일 이름이 맞고, 다르면 사용자가 "주인공" 처럼 자기 이름을
         * 붙여 둔 것이라 갈아끼우기가 그것을 지우면 안 된다.
         */
        if (before && layer.name === before.name) layer.name = name

        layer.assetId = assetId

        /*
         * 아무도 안 쓰게 된 옛 에셋을 걷어낸다. filter 재대입이 아니라 splice 다.
         * 배열을 통째로 갈면 immer 가 ['assets'] 스냅샷 패치를 기록해서, 그 실행취소가
         * 다른 에셋의 나중 갱신까지 함께 되돌린다 (dropLayers 와 같은 이유).
         *
         * 비트맵은 레지스트리에 남긴다. 실행취소로 돌아올 때 픽셀이 살아 있어야 한다.
         */
        for (let i = d.assets.length - 1; i >= 0; i -= 1) {
          const asset = d.assets[i]
          if (!asset) continue
          if (d.layers.some((l) => l.assetId === asset.id)) continue
          d.assets.splice(i, 1)
        }
      })

      return { assetId }
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
      mutateDoc('레이어 삭제', (d) => dropLayers(d, [layerId]))
    },

    removeLayers(layerIds) {
      if (layerIds.length === 0) return
      mutateDoc('레이어 삭제', (d) => dropLayers(d, layerIds))
    },

    clearPreset() {
      mutateDoc('모션 프리셋 해제', (d) => {
        const ref = d.presetRef
        if (!ref) return
        const layer = ref.layerId ? findLayer(d, ref.layerId) : undefined

        if (layer) {
          /*
           * 소유권 병합 헬퍼를 그대로 쓴다. "새 프리셋이 아무것도 내지 않는다" 와
           * 정확히 같은 상황이므로 규칙을 다시 적을 이유가 없다 (motions/merge.ts).
           */
          const owned = ownershipFor(d, layer.id)
          const drop = new Set<TrackProp>(owned.props)
          layer.tracks = layer.tracks.filter((t) => !drop.has(t.prop))
          layer.effects = mergePresetEffects(layer.effects, undefined, owned)
          layer.modifiers = []

          if (mergePresetReveal(layer.reveal, undefined, owned) === undefined) delete layer.reveal
          if (mergePresetCharAnim(layer.charAnim, undefined, owned) === undefined) {
            delete layer.charAnim
          }
          if (mergePresetPerspective(layer.perspective, undefined, owned) === undefined) {
            delete layer.perspective
          }
          const anchor = mergePresetAnchor(layer.anchor, undefined, owned)
          if (anchor[0] !== layer.anchor[0] || anchor[1] !== layer.anchor[1]) layer.anchor = anchor

          // 프리셋이 켠 것이므로 함께 내린다. 켜진 채 남으면 담기 솔버가 계속 비켜선다.
          layer.motionExitsFrame = false
          delete layer.containScale
          // 프리셋이 없어졌으니 기록도 걷는다. 남으면 사용자가 나중에 같은 prop 의
          // 트랙을 손으로 만들었을 때 다음 프리셋이 그것을 프리셋 것으로 오인한다.
          delete layer.presetOwnership
        }

        delete d.presetRef
      })
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

    moveLayerTo(layerId, toIndex, folderId) {
      mutateDoc('레이어 순서 변경', (d) => {
        const from = d.layers.findIndex((l) => l.id === layerId)
        if (from < 0) return
        const to = clamp(Math.round(toIndex), 0, d.layers.length - 1)
        // 소속을 함께 지정했으면 자리가 그대로여도 할 일이 남아 있다.
        if (to === from && folderId === undefined) return
        const [moved] = d.layers.splice(from, 1)
        if (!moved) return
        d.layers.splice(to, 0, moved)

        /*
         * 소속을 지정했으면 추측하지 않는다.
         *
         * 목록에서 끌어다 놓는 경로는 접힘까지 반영한 트리를 이미 계산해 두었다
         * (ui/layers/layerTree.ts dropTarget). 그쪽이 더 많이 안다.
         */
        if (folderId !== undefined) {
          if (folderId === null) delete moved.folderId
          else if (folderId !== moved.id && !isInsideFolder(d, moved.id, folderId)) {
            moved.folderId = folderId
          }
          normalizeFolderOrder(d)
          return
        }

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
        // 소유권은 이 레이어 자신의 기록에서 읽는다. 앞 프리셋이 다른 레이어에 걸려
        // 있었어도 이 레이어의 기록은 남아 있으므로 앞 프리셋의 잔재를 걷어낼 수 있고,
        // 다른 레이어의 소유권으로 이 레이어의 수동 편집을 걷어내는 일도 없다.
        const owned = ownershipFor(d, layerId)
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

        /*
         * 소유권은 **이 레이어에** 기록한다. 다음 프리셋이 "이건 내가 지워도 되는
         * 것" 을 알아보는 표식이다. 문서(presetRef)에 두면 다른 레이어에 프리셋을
         * 얹는 순간 이 기록이 덮여서, A -> B -> A 에서 A 의 앞 프리셋 트랙이
         * 영구히 잔류한다 (motions/merge.ts ownershipFor). 다른 레이어의 기록은
         * 여기서 건드리지 않는다.
         */
        const record = presetOwnershipRecord({
          tracks: nextTracks,
          effectIds: nextFx.map((e) => e.id),
          reveal,
          charAnim,
          perspective,
          anchor,
        })
        if (record) layer.presetOwnership = record
        else delete layer.presetOwnership

        d.presetRef = {
          id: presetId,
          // 재적용 대상을 추측하지 않고 기록한다. 트랙을 내지 않는 프리셋
          // (흔들기/자글자글/지지직)은 소유 기록으로는 레이어를 역추적할 수 없다.
          layerId,
          macro: { ...macro },
          dirty: false,
          // 요청한 기준선을 그대로 보관한다. 지금 durationFrames 는 프리셋이 홀드
          // 배수로 스냅한 결과라, 그걸 되먹이면 속도를 왕복할 때마다 길이가 늘어난다.
          ...(baseSec !== undefined ? { baseSec } : {}),
          ...(baseFps !== undefined ? { baseFps } : {}),
        }
      }, `preset:${layerId}:${presetId}`)
    },

    transferMotion({ fromLayerId, toLayerIds, parts, move }) {
      const doc = get().doc
      const source = doc.layers.find((l) => l.id === fromLayerId)
      if (!source) return { moved: 0, skipped: 0 }
      if (!parts.tracks && !parts.effects && !parts.shaping) return { moved: 0, skipped: 0 }

      const bundle = extractMotion(source)
      if (bundleIsEmpty(bundle, parts)) return { moved: 0, skipped: 0 }

      /*
       * 대상을 먼저 거른다. 자기 자신과 잠긴 레이어는 건너뛴다. 걸러 낸 결과가 비면
       * mutateDoc 을 부르지 않는다. 패치가 비면 히스토리에 안 쌓이기는 하지만,
       * 부르지 않는 편이 뜻이 분명하다.
       */
      const targets = toLayerIds.filter((id) => {
        if (id === fromLayerId) return false
        const layer = doc.layers.find((l) => l.id === id)
        return layer !== undefined && !layer.locked
      })
      const skipped = toLayerIds.length - targets.length
      if (targets.length === 0) return { moved: 0, skipped }

      const mint: IdMinter = {
        track: () => nextId('t'),
        modifier: () => nextId('m'),
        effect: () => nextId('e'),
      }

      mutateDoc(move ? '모션 옮기기' : '모션 보내기', (d) => {
        for (const id of targets) {
          const target = findLayer(d, id)
          if (!target) continue
          applyMotionBundle(target, bundle, parts, mint)
          /*
           * 전송은 고른 갈래를 통째로 대체한다 (transfer.ts 계약). 대상에 남아 있던
           * 프리셋 소유권 기록은 이제 전송 결과(사용자 것)를 가리키므로, 남겨 두면
           * 다음 프리셋이 방금 보낸 모션을 앞 프리셋 것으로 오인해 걷어간다.
           * 갈래별로 쪼개 남기지 않고 통째로 지운다. 지우는 쪽은 "사용자 것으로
           * 승격" 이라 잘못돼도 남을 뿐이지만, 남기는 쪽은 말없이 지운다.
           */
          delete target.presetOwnership
        }
        if (move === true) {
          const origin = findLayer(d, fromLayerId)
          if (origin) {
            clearMotion(origin, parts)
            // 걷어낸 트랙/이펙트를 가리키던 기록이다. 대상과 같은 이유로 지운다.
            delete origin.presetOwnership
          }
          // 프리셋이 이 레이어에 걸려 있었다면 그 기록도 함께 지운다 (선언부 주석).
          if (d.presetRef?.layerId === fromLayerId) delete d.presetRef
        } else {
          /*
           * 복사는 원본을 안 건드리므로 presetRef 도 그대로다. 대상의 사본은 id 가
           * 새로 발급되어 소유권 목록에 없고, ownershipFor 가 레이어로 대조하므로
           * 대상에서는 "사용자가 만든 것" 으로 살아남는다 (motions/merge.ts).
           */
        }
        /*
         * 대상이 프리셋 레이어면 원본 move 와 대칭으로 기록을 지운다. 전송은 대상의
         * 갈래를 통째로 대체하므로(transfer.ts 계약) 프리셋이 심은 상태는 이미
         * 사라졌는데, 기록이 남으면 EASY 슬라이더를 스치는 재적용이 옛 프리셋
         * 모션을 전송 결과 위에 도로 심는다. dirty 로만 올리면 "프리셋으로 리셋"
         * 버튼이 같은 파괴를 되살릴 길이 남아 삭제가 일관적이다.
         */
        const ownerId = d.presetRef?.layerId
        if (ownerId !== undefined && targets.includes(ownerId)) delete d.presetRef
      })

      return { moved: targets.length, skipped }
    },

    setLayerMotionRepeat(layerId, repeat) {
      const next = Math.round(repeat)
      if (!Number.isFinite(next)) return
      const clamped = clamp(next, MOTION_REPEAT_MIN, MOTION_REPEAT_MAX)
      mutateDoc('모션 속도', (d) => {
        const layer = findLayer(d, layerId)
        if (!layer) return
        if (clamped <= MOTION_REPEAT_MIN) {
          if ('motionRepeat' in layer) delete layer.motionRepeat
          return
        }
        layer.motionRepeat = clamped
      }, `repeat:${layerId}`)
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

    setLayerTranslate(moves, frame) {
      if (moves.length === 0) return
      mutateDoc('위치 이동', (d) => {
        const at = clamp(Math.round(frame), 0, FRAMES_MAX)
        for (const move of moves) {
          const layer = findLayer(d, move.layerId)
          // 잠긴 레이어는 손이 미끄러져도 움직이지 않는다. 잠금의 뜻이 그것이다.
          if (!layer || layer.locked) continue
          writeTranslatePx(d, layer, 'translateX', move.x, at)
          writeTranslatePx(d, layer, 'translateY', move.y, at)
        }
      }, 'drag:translate')
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
          // 스톱워치로 굳힌 것도 PRO 편집이다. 표시를 안 남기면 EASY 슬라이더의
          // 재적용이 방금 정지시킨 애니메이션을 소리 없이 되살린다.
          markPresetDirty(d)
          return
        }

        // 켜기: 현재 값으로 이 프레임에 첫 키를 만든다.
        const current = track
          ? (evalTrack(track, frame) ?? TRACK_DEFAULTS[prop].identity)
          : TRACK_DEFAULTS[prop].identity
        if (track) {
          track.animated = true
          track.keys = [{ f: frame, v: current, interp: 'bezier' }]
          // 기존 키들을 리셋했으므로 끄기와 같은 이유로 표시를 남긴다.
          // 새 트랙을 만드는 아래 분기는 프리셋 트랙을 안 건드리므로 제외한다
          // (setValueAtFrame 의 새 트랙 분기와 같은 관례).
          markPresetDirty(d)
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
          // 아래 구간 밖 경로와 **같은 표시를 남긴다.** 한 함수 안에서 두 길이
          // '사용자가 손댔다' 를 다르게 판정하면, 두 키 사이에 찍은 키만 dirty 가
          // 안 켜져 EASY 슬라이더가 그 트랙을 통째로 갈아끼우며 지워 버린다.
          markPresetDirty(d)
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

    removeKeyframes(refs) {
      if (refs.length === 0) return
      mutateDoc('키프레임 삭제', (d) => {
        for (const ref of refs) {
          const layer = findLayer(d, ref.layerId)
          if (!layer) continue
          const track = findTrack(layer, ref.prop)
          // 마지막 키는 지우지 않는다 (removeKeyframe 과 같은 규칙). 같은 트랙의
          // 키 여러 개를 골랐어도 순서대로 지우다 하나 남으면 거기서 멈춘다.
          if (!track || track.keys.length <= 1) continue
          const i = track.keys.findIndex((k) => k.f === ref.frame)
          if (i < 0) continue
          track.keys.splice(i, 1)
          markPresetDirty(d)
        }
      })
    },

    moveKeyframe(layerId, prop, fromFrame, toFrame, coalesceKey) {
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
        // 한 번의 실행취소가 되게 한다. 여러 속성의 키를 함께 끄는 드래그는 속성 단위
        // 키로는 A,B,A,B 로 번갈아 쌓여 병합이 안 되므로(스택 최상단만 비교한다),
        // 호출자가 드래그 세션 단위 키를 넘겨 덮을 수 있다 (clipDrag 와 같은 패턴).
      }, coalesceKey ?? `kfmove:${layerId}:${prop}`)
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
         * **짧은 변**이 얼마나 달라졌는가. 그것이 배율이다.
         *
         * 해상도 컨트롤은 비율을 유지하므로 두 축이 같이 움직이고, 짧은 변의 비율이
         * 곧 그 배율이다. 한 축만 줄이면 짧은 변이 그만큼 줄어 그림도 따라 들어가고,
         * 한 축만 키우면 짧은 변이 그대로라 그림도 그대로다. 지금까지의 동작이다.
         *
         * 두 축 비율의 min 을 쓰던 것이 문제였다. 그 식은 **되돌릴 수 없다.**
         * 폭을 512 -> 1024 로 키우면 min(2, 1) = 1 이라 그대로인데, 다시 512 로
         * 되돌리면 min(0.5, 1) = 0.5 가 되어 그림만 절반으로 줄었다. 캔버스는
         * 제자리인데 그림은 안 돌아오고, 폭을 아무리 다시 쳐도 복구되지 않았다
         * (Ctrl+Z 로만 되돌아간다). 짧은 변 하나를 기준으로 삼으면 A -> B -> A 가
         * 언제나 1 로 돌아온다. 두 값의 비가 아니라 한 값의 비이기 때문이다.
         */
        const factor = Math.min(nextW, nextH) / Math.min(beforeW, beforeH)
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

    setDurationFrames(frames, options) {
      mutateDoc('길이 변경', (d) => {
        d.timeline.durationFrames = clamp(Math.round(frames), 2, FRAMES_MAX)
        /*
         * 기본은 못박기다. 사용자가 길이를 직접 넣었다는 사실 자체가 "이 길이를
         * 지켜 달라" 는 선언이고, 그때부터 속도 노브는 길이 대신 그 안의 반복
         * 횟수를 바꾼다 (motions/apply.ts 의 pinned 분기). 내보내기 복원 같은
         * 기계적 경로만 pin: false 로 지나간다. false 는 키를 지워서 저장 파일의
         * 왕복 JSON 을 더럽히지 않는다.
         */
        if (options?.pin !== false) d.timeline.durationPinned = true
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

    setDurationPinned(pinned) {
      mutateDoc(pinned ? '길이 고정' : '길이 고정 해제', (d) => {
        // false 는 키를 지운다. 저장 파일에 false 가 남으면 왕복 JSON 이 달라진다.
        if (pinned) d.timeline.durationPinned = true
        else delete d.timeline.durationPinned
      }, 'durationPin')
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
        // 재생과 내보내기는 duration 안만 돈다. 구간이 그 밖에 있으면 레이어가
        // 어디에도 안 보인다 (setLayerRanges 와 같은 클램프).
        const last = Math.max(0, d.timeline.durationFrames - 1)
        for (const layer of d.layers) {
          if (!ids.has(layer.id)) continue
          if (!range) {
            delete layer.inFrame
            delete layer.outFrame
            delete layer.inFade
            delete layer.outFade
            continue
          }
          layer.inFrame = clamp(Math.round(range.inFrame), 0, last)
          layer.outFrame = clamp(Math.round(range.outFrame), layer.inFrame, last)
          // 0 이면 키를 남기지 않는다. 아무 일도 하지 않는 값이 저장 파일에 남으면
          // 왕복 JSON 이 달라진다 (도형 / 가리기와 같은 규칙).
          if (range.inFade && range.inFade > 0) layer.inFade = Math.round(range.inFade)
          else delete layer.inFade
          if (range.outFade && range.outFade > 0) layer.outFade = Math.round(range.outFade)
          else delete layer.outFade
        }
      })
    },

    setLayerRanges(entries, label, options) {
      if (entries.length === 0) return
      const last = Math.max(0, get().doc.timeline.durationFrames - 1)
      const byId = new Map(entries.map((e) => [e.layerId, e]))
      mutateDoc(
        label,
        (d) => {
          for (const layer of d.layers) {
            const entry = byId.get(layer.id)
            if (!entry) continue
            const start = clamp(Math.round(entry.inFrame), 0, last)
            const end = clamp(Math.round(entry.outFrame), start, last)
            layer.inFrame = start
            layer.outFrame = end

            // 페이드가 구간을 넘으면 구간 전체가 반투명해진다. 안으로 접는다.
            // 0 이면 키를 남기지 않는다. 아무 일도 하지 않는 값이 저장 파일에
            // 남으면 왕복 JSON 이 달라진다 (setLayerRange 와 같은 규칙).
            const span = end - start + 1
            const fold = (fade: number | undefined): number => {
              if (options?.clearFades) return 0
              if (typeof fade !== 'number' || fade <= 0) return 0
              return Math.min(Math.round(fade), span - 1)
            }
            const nextIn = fold(layer.inFade)
            if (nextIn > 0) layer.inFade = nextIn
            else delete layer.inFade
            const nextOut = fold(layer.outFade)
            if (nextOut > 0) layer.outFade = nextOut
            else delete layer.outFade
          }
        },
        options?.coalesceKey,
      )
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
