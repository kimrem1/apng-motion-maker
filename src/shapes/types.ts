/**
 * 도형 모션 세트의 계약.
 *
 * 모션 프리셋(motions/)과 목적이 다르다. 프리셋은 이미 있는 레이어 하나에
 * 움직임을 얹고, 세트는 도형 레이어 여러 장을 통째로 만든다. 물결 파동은 링 3장,
 * 음악 막대는 막대 7장이 서로 다른 위상으로 움직여야 성립하는데, 한 레이어에 담으면
 * 그 위상차를 트랙으로 표현할 방법이 없다.
 *
 * 그래도 결과물은 여전히 키프레임 트랙과 모디파이어뿐이다. 세트를 넣은 뒤에도
 * 레이어를 하나씩 골라 그래프 에디터로 다듬을 수 있고, 렌더러는 세트의 존재를 모른다.
 *
 * 내부 id 는 UI 에 노출하지 않는다. label 과 hint 만 보여준다.
 */

import type {
  BlendMode,
  LoopMode,
  Modifier,
  RevealSpec,
  ShapeSpec,
  Track,
} from '@/core/types.ts'

/**
 * 사용자에게 보이는 분류. 이름은 전부 "무엇을 하고 싶은가" 다.
 * 기술 용어(파티클, 트랜지션, 이퀄라이저)를 쓰지 않는다.
 */
export type ShapeSceneGroup =
  | 'pulse'
  | 'bars'
  | 'wipe'
  | 'spin'
  | 'accent'
  | 'ambient'
  | 'stage'
  /** 애니메이션 영상에서 따온 연출. 잉크 튀김, 부유 파편, 임팩트 프레임 등이다. */
  | 'cinema'

export const SHAPE_GROUP_LABELS: Record<ShapeSceneGroup, string> = {
  pulse: '퍼지기',
  bars: '소리 그래프',
  wipe: '화면 전환',
  spin: '돌기',
  accent: '강조',
  ambient: '배경 장식',
  stage: '연출',
  cinema: '영상 느낌',
}

export const SHAPE_GROUP_ORDER: ShapeSceneGroup[] = [
  'cinema',
  'stage',
  'pulse',
  'bars',
  'spin',
  'accent',
  'wipe',
  'ambient',
]

/** 세트가 만들 레이어 한 장. */
export interface SceneLayer {
  /** 레이어 패널에 보이는 이름. */
  name: string
  shape: ShapeSpec
  tracks: Track[]
  modifiers?: Modifier[]
  blend?: BlendMode
  /** 회전과 확대가 도는 축. 아래에서 자라는 막대는 [0.5, 1] 이다. */
  anchor?: [number, number]
  /** 경계선이 지나가는 모양. 진행률은 `reveal` 트랙이 민다. */
  reveal?: RevealSpec
}

export interface SceneEmission {
  layers: SceneLayer[]
  durationFrames: number
  loopMode: LoopMode
  /**
   * 이 길이를 담으려면 필요한 fps.
   * 느린 속도에서는 fps 를 낮춰야 프레임 상한 안에서 시간이 늘어난다.
   */
  fps: number
}

export interface SceneContext {
  canvasW: number
  canvasH: number
  /** 지금 문서의 fps. 세트는 이 값을 천장으로만 쓴다(올리지 않는다). */
  fps: number
  /** 0~1. 움직임의 크기. 0.5 가 기본이다. */
  strength: number
  /** 0.1~2. 값이 클수록 짧아진다. 시간에만 작용하고 크기에는 섞이지 않는다. */
  speed: number
  /** 사용자가 고른 색. `#rrggbb`. 세트가 여기서 계열색을 만든다. */
  color: string
  /**
   * 이미 만들어 둔 타임라인 길이(프레임). 있으면 세트가 그 길이에 맞춘다.
   *
   * 문서에 이미 다른 레이어가 있을 때만 채운다. 배경 장식을 하나 얹었다고 사용자가
   * 맞춰 둔 5초짜리 모션이 세트의 기본 길이(1.2초)로 잘리면 안 된다. 대신 그때는
   * 속도 노브가 길이를 바꾸지 못한다.
   */
  fitFrames?: number
  /**
   * fitFrames 를 절대로 넘지 않는다.
   *
   * 보통은 한 주기도 못 담을 만큼 느려지면 문서를 늘린다 (shared.ts timingOf 규칙 3).
   * 사용자가 길이를 못박아 둔 문서(timeline.durationPinned)에서는 그 예외도 금지다.
   * 그때 아주 느린 속도는 "한 주기가 문서 전체" 에서 멈춘다.
   */
  hardFit?: boolean
}

export interface ShapeScene {
  /** 내부 id. UI 에 노출하지 않는다. */
  id: string
  label: string
  hint: string
  group: ShapeSceneGroup
  /** 속도 1 일 때의 재생 시간(ms). */
  defaultDurationMs: number
  /**
   * 화면을 통째로 덮는 전환인가.
   * 카드가 "위에 얹혀 화면을 가립니다" 라고 미리 알려 준다.
   */
  covers?: boolean
  /** 순수 함수여야 한다. 같은 ctx 면 항상 같은 결과다. */
  emit(ctx: SceneContext): SceneEmission
}
