/**
 * 모션 프리셋 엔진의 계약.
 *
 * 프리셋은 새 로직을 만들지 않는다. 결과물은 키프레임 트랙과 모디파이어뿐이다.
 * 그래야 세 가지가 공짜로 따라온다.
 *   1. 프리셋을 적용한 뒤에도 그래프 에디터로 이어서 손댈 수 있다.
 *   2. 렌더러와 오버스캔 솔버가 프리셋의 존재를 몰라도 된다.
 *   3. 사용자가 만든 조합을 "내 프리셋"으로 저장하는 기능이 그대로 성립한다.
 *
 * 내부 id 는 어떤 형태로도 UI 에 노출하지 않는다. label 만 보여준다.
 */

import type { EffectInstance, LoopMode, Modifier, RevealSpec, Track } from '@/core/types.ts'

/**
 * 사용자에게 보이는 1차 분류는 의도 기반이다.
 * 속성 기반(스케일/이동/회전)은 PRO 모드의 필터 태그로 내린다.
 * 사용자는 "스케일 카테고리"를 찾지 않고 "톡 튀게 나타나게 하고 싶다"를 찾는다.
 *
 * 등장 / 사라짐 / 이동 / 시선 끌기 / 사진 훑기 / 흔들기 / 자글자글 / 지지직 / 조합 아홉 종이다.
 */
export type MotionCategory =
  | 'appear'
  | 'disappear'
  | 'move'
  | 'attention'
  | 'kenburns'
  | 'shake'
  | 'boil'
  | 'glitch'
  | 'combo'

/**
 * 반복 안전성.
 * - seamless     : 한 주기가 정확히 닫힌다. 첫 키와 끝 키의 값이 같다. 무한 반복에 그대로 쓴다.
 * - pingPongOnly : 값이 시작으로 돌아오지 않는다. 왕복으로만 자연스럽다.
 * - once         : 이음새가 닫히지 않는다 (등장/사라짐처럼 시작과 끝이 다르다).
 *                  그래도 기본 제안은 반복이다. 스티커 파일은 반복 재생이 표준이고,
 *                  반복 시 첫 프레임으로 점프해 돌아가는 것은 반복을 고른 결과이지
 *                  결함이 아니다 (presets/shared.ts 의 loopFor 참조). 자동 보정은 없다.
 *
 * 이 값은 UI 에 그대로 노출하지 않는다. 반복 모드 제안으로만 쓴다.
 */
export type LoopSafety = 'seamless' | 'pingPongOnly' | 'once'

/**
 * 오버스캔 요구.
 * - auto       : 전 구간 k >= 1 이라 솔버가 개입하지 않는다.
 * - required   : 그냥 두면 캔버스가 빈다. autoFit 솔버 또는 배경 채우기가 필요하다.
 * - allowEmpty : 화면 밖으로 나가는 것이 의도다. 솔버를 끈다.
 */
export type OverscanPolicy = 'auto' | 'required' | 'allowEmpty'

/** 프리셋 카드에 미리 표시하는 용량 등급. */
export type SizeClass = 'light' | 'normal' | 'heavy'

export interface ParamSpec {
  key: string
  /** 사용자에게 보이는 한국어 이름 */
  label: string
  type: 'number' | 'select' | 'boolean'
  min?: number
  max?: number
  step?: number
  unit?: string
  options?: { value: string; label: string }[]
  default: number | string | boolean
}

/**
 * 프리셋이 적용 시점에 사용자에게 알려야 하는 사실. 원인이 아니라 처방을 말한다.
 *
 * 세 가지가 있다.
 *   needsEffect     : 이 프리셋은 픽셀 이펙트가 함께 있어야 완성된다 (G, H 카테고리).
 *   flashWarning    : 점멸이 있다. 초당 3회 미만이라도 광과민성 사용자에게는 알려야 한다 (WCAG 2.3.1).
 *   durationSnapped : 홀드 클럭 때문에 지속 프레임을 홀드의 배수로 맞췄다.
 */
export interface PresetNotice {
  code:
    | 'needsSecondLayer'
    | 'largeSourceRecommended'
    | 'easingLocked'
    | 'needsEffect'
    | 'flashWarning'
    | 'durationSnapped'
  message: string
}

/** 여러 레이어에 역할을 나눠 배정하는 프리셋용. */
export type PresetRole = 'background' | 'foreground'

export interface PresetRoleEmission {
  role: PresetRole
  tracks: Track[]
  modifiers?: Modifier[]
}

/** 프리셋이 문서에 심는 결과. 새 로직이 아니라 키프레임 + 모디파이어 + 이펙트로만 표현한다. */
export interface PresetEmission {
  tracks: Track[]
  modifiers?: Modifier[]
  /**
   * 이 프리셋이 요구하는 이펙트 스택.
   *
   * ---------------------------------------------------------------------------
   * 계약: 있으면 통째로 대체, 없으면 손대지 않는다
   * ---------------------------------------------------------------------------
   * - 배열이 있으면 그것이 **레이어 이펙트 스택 전체**다. 호출부는 layer.effects 를
   *   이 배열로 통째로 갈아끼운다. 앞 프리셋이 남긴 이펙트가 뒤에 붙어 남으면
   *   사용자가 고르지 않은 픽셀 처리가 계속 그려진다.
   * - **undefined 는 "이 프리셋은 이펙트를 정의하지 않는다" 는 뜻이고, 기존 스택을
   *   그대로 둔다.** 빈 배열과 절대 같지 않다. 이펙트를 안 쓰는 프리셋(A~E, 흔들기,
   *   2컷 스텝)이 빈 배열을 내면 사용자가 직접 쌓아 둔 이펙트가 프리셋을 갈아탈
   *   때마다 날아간다. 그래서 그런 프리셋은 이 필드를 아예 채우지 않는다.
   * - 빈 배열은 "이펙트 스택을 비우는 것이 이 프리셋의 정의다" 라는 선언이다.
   *   지금 그런 프리셋은 없다.
   *
   * EffectInstance.type 과 params 의 key 는 effects/registry.ts 의 EffectDef 를
   * 그대로 따라야 한다. 없는 키는 조용히 무시되어 "적용했는데 아무 일도 안 일어남"
   * 이 된다. seed 는 EmitContext.seed 에서 결정론적으로 유도한다.
   */
  effects?: EffectInstance[]
  /**
   * 이 프리셋이 요구하는 가리기 모양.
   *
   * 진행률은 여기 없다. `reveal` 트랙이 민다. 둘을 나눠야 세기 슬라이더가 모양을
   * 다시 정하지 않는다.
   *
   * **motionExitsFrame 과 같은 규칙이다.** 호출부가 언제나 통째로 대체하므로,
   * 값을 내지 않은 프리셋으로 갈아타면 앞 프리셋의 경계선이 깨끗이 사라진다.
   * 이펙트와 달리 undefined 와 "비움" 을 구별하지 않는다. 가리기는 사용자가
   * 손으로 쌓아 올리는 스택이 아니라 프리셋 한 벌에 딸린 값 하나이기 때문이다.
   */
  reveal?: RevealSpec
  /** 3D 회전에 쓰는 카메라 거리(레이어 긴 변의 배수). 생략하면 기본값이다. */
  perspective?: number
  /** 이 프리셋에 어울리는 반복 모드 제안 */
  suggestedLoop?: LoopMode
  /** 권장 지속 프레임 수 */
  durationFrames: number
  /**
   * 레이어별 역할 배정. parallax.dual 처럼 두 장이 필요한 프리셋만 채운다.
   * tracks 는 첫 역할(배경)과 같은 내용이라 단일 레이어 호출부도 그대로 쓸 수 있다.
   */
  roles?: PresetRoleEmission[]
  /** 적용 시 사용자에게 보여줄 안내 */
  notices?: PresetNotice[]
  /**
   * 이 프리셋이 권장하는 fps.
   *
   * 지지직 계열은 매 프레임 노이즈가 바뀌어 프레임 간 델타 압축 효율이 0 에 수렴한다.
   * 25fps 로 두면 같은 길이에서 파일이 그냥 커진다. 적용 시 타임라인 fps 를 여기로 내린다.
   * 생략하면 현재 fps 를 유지한다.
   */
  suggestedFps?: number
}

export interface EmitContext {
  /**
   * 요청 지속 프레임. 0 이하면 프리셋의 defaultDurationMs 를 쓴다.
   * 0 보다 크면 기존 타임라인 길이를 유지한다는 뜻이다. 어느 쪽이든 speed 로 나눈다.
   *
   * baseSec 이 있으면 그쪽이 이긴다. 이 필드는 baseSec 이 없는 호출부(테스트, 옛 경로)를
   * 위한 폴백이다.
   */
  durationFrames: number
  /**
   * 속도 1 일 때의 재생 시간(초).
   *
   * **프레임이 아니라 초로 소통하는 이유**: 느린 속도에서는 fps 를 함께 낮춰야 프레임
   * 상한 120 안에서 시간을 더 늘릴 수 있다. 프레임 수를 emit 밖에서 정하고 fps 만
   * 따로 바꾸면 두 계산이 갈려서, 속도를 1 -> 0.1 -> 1 로 왕복했을 때 길이가 5배
   * 줄어든다. 그래서 fps 와 프레임 수를 같은 계산 단위 안에서 정한다.
   * span = round(baseSec / speed * fps) 가 resolveSpan 안에서 일어난다.
   */
  baseSec?: number
  fps: number
  canvasW: number
  canvasH: number
  /** 0~1. EASY 모드의 세기 슬라이더. 0.5 가 기본. */
  strength: number
  /** 0.5~2. EASY 모드의 속도 슬라이더. 1 이 기본. */
  speed: number
  params: Record<string, number | string | boolean>
  seed: number
  /** 현재 문서의 레이어 수. 두 장이 필요한 프리셋이 부족을 알리는 데 쓴다. 생략하면 1. */
  layerCount?: number
}

export interface MotionPreset {
  /** 내부 id. UI 에 절대 노출하지 않는다 */
  id: string
  /** 사용자에게 보이는 한국어 이름 */
  label: string
  /** 한 줄 설명 */
  hint: string
  category: MotionCategory
  /** PRO 필터용 속성 태그 */
  tags: string[]
  loopSafe: LoopSafety
  overscan: OverscanPolicy
  /** EASY 기본 노출 */
  easy: boolean
  size: SizeClass
  defaultDurationMs: number
  /**
   * 카드에 미리 보여 주고 적용 시 타임라인에 반영할 권장 fps.
   * emit 의 suggestedFps 와 같은 값이다. 이쪽은 emit 을 부르지 않고도 읽을 수 있어
   * 갤러리 카드가 쓴다.
   */
  recommendedFps?: number
  /**
   * 이 프리셋은 점멸을 만든다.
   *
   * emit 이 내는 code:'flashWarning' 안내와 **항상 같은 값**이다. 안내는 적용 시점에
   * 배너로 보이고, 이 필드는 적용 전에 카드의 점멸 주의 배지가 읽는다. 갤러리는
   * 56장을 그리면서 emit 을 부르지 않는다. recommendedFps 와 같은 이유의 사본이고,
   * 둘이 어긋나지 않는다는 것은 테스트가 카탈로그 전체에서 확인한다.
   */
  flashWarning?: boolean
  /**
   * 원본이 클수록 결과가 또렷하다.
   * flashWarning 과 같은 규칙이다. emit 의 code:'largeSourceRecommended' 안내와 같다.
   */
  largeSource?: boolean
  /**
   * 노이즈 홀드 프레임 기본값.
   * 1 이면 매 프레임 새로 뽑는다. 2 면 2컷, 3 이면 3컷으로 잡힌다.
   * 조합 프리셋이 지속 프레임을 홀드의 배수로 미리 맞추는 데도 쓴다.
   */
  noiseHoldFrames?: number
  params: ParamSpec[]
  emit(ctx: EmitContext): PresetEmission
}
