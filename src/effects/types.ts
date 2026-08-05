/**
 * 이펙트 엔진의 계약.
 *
 * 이펙트는 레이어 렌더 결과에 얹는 픽셀 처리다. 세 스테이지로 나뉜다.
 *
 *   A 변형  : 픽셀 로컬 UV 오프셋. 단일 셰이더로 융합한다.
 *   B 파괴  : 이웃/상태 의존이라 개별 패스여야 한다.
 *   C 마감  : 픽셀 로컬 색 변환. 단일 셰이더로 융합한다.
 *
 * 이 파일은 DOM / React / WebGL 객체를 참조하지 않는다. 문자열과 숫자만 다룬다.
 *
 * 결정론 계약
 *
 * 유니폼 계산은 순수 함수다. 같은 컨텍스트면 항상 같은 값을 낸다.
 * Math.random / Date.now / performance.now 를 부르면 프리뷰와 내보내기가 갈린다.
 * 셰이더 난수는 정수 비트 해시(PCG)만 쓴다. glsl/common.ts 를 보라.
 *
 * 두 가지 표기를 모두 받는다
 *
 * 원자 이펙트 카탈로그가 늘면서 같은 뜻의 필드가 두 갈래로 갈렸다.
 * 엔진은 둘 다 받아들이고 registry.ts 의 정규화 함수로 하나로 합친다.
 *
 *   유니폼   uniforms(ctx) 함수형   |  uniforms: EffectUniformSpec[] 선언형
 *   셰이더   fragmentShader          |  fragment
 *   식별자   define / entry 명시     |  생략하면 id 에서 유도 (effectDefine / effectEntry)
 *
 * 새 이펙트를 쓸 때는 어느 쪽이든 좋다. 정규화 함수만 거치면 동작이 같다.
 */

import type { ParamSpec } from '@/motions/types.ts'

export type EffectStage = 'A' | 'B' | 'C'

/** 'medium' 은 'mid' 의 표기 흔들림이다. 표시용 등급이라 같은 값으로 다룬다. */
export type EffectCost = 'free' | 'low' | 'mid' | 'medium' | 'high'

/**
 * 사용자에게 보이는 분류. 스테이지와는 다른 축이다.
 * 스테이지는 구현상의 패스 구조이고, 카테고리는 "무엇처럼 보이는가"다.
 * 예를 들어 방향성 블러는 이웃 의존이라 개별 패스지만 사용자에게는 질감이다.
 */
export type EffectCategory = 'warp' | 'glitch' | 'texture' | 'color'

/** 이펙트가 셰이더에 넘길 유니폼. 이름은 u_ 로 시작한다. */
export type UniformValue = number | readonly number[]

/**
 * ParamSpec 의 상위 집합.
 *
 * motions 쪽 ParamSpec 은 select 의 value 가 문자열이다. 이펙트 파라미터는 최종적으로
 * 숫자 하나로 확정되어야 해서(EffectEvalContext.params) 숫자 옵션도 함께 받는다.
 * registry.ts 의 resolveEffectParams 가 어느 쪽이든 숫자로 정규화한다.
 */
export interface EffectParamSpec {
  key: string
  /** 사용자에게 보이는 한국어 이름 */
  label: string
  /** 'color' 는 0xRRGGBB 정수 하나로 저장한다. 셰이더에서 성분으로 쪼갠다. */
  type: 'number' | 'select' | 'boolean' | 'color'
  min?: number
  max?: number
  step?: number
  unit?: string
  options?: { value: string | number; label: string }[]
  default: number | string | boolean
}

/** motions 의 ParamSpec 은 그대로 대입된다. 이 별칭은 그 사실을 명시하려고 둔다. */
export type MotionParamSpec = ParamSpec

export interface EffectEvalContext {
  /** 정수 프레임 */
  frame: number
  /** 홀드 클럭 적용 후. effFrame = floor(frame / holdFrames) * holdFrames */
  effFrame: number
  durationFrames: number
  fps: number
  width: number
  height: number
  /**
   * hashSeed(projectSeed ^ instanceSeed, nodeId, effFrame).
   * 프레임마다 달라진다. 그레인 / 슬라이스 / 블록처럼 매 프레임 새 난수를
   * 원하는 이펙트가 그대로 셰이더에 넘기면 되는 값이다.
   * effFrame 을 섞으므로 홀드 클럭이 자동으로 반영된다.
   */
  seed: number
  /**
   * hashSeed(projectSeed ^ instanceSeed, nodeId, 0). 프레임 불변이다.
   *
   * CPU 쪽 fbmLoop 은 t 축이 곧 시간축이므로 시드가 프레임마다 바뀌면 안 된다.
   * 매끄러운 흔들림 / 심리스 루프를 만드는 이펙트는 반드시 이 값을 쓴다.
   * seed 를 쓰면 부드러운 곡선이 아니라 백색잡음이 나온다.
   */
  seedStatic: number
  /** EffectInstance.seed 원본. 시드 조합을 직접 하는 이펙트가 쓴다. */
  instanceSeed: number
  /** 문서 시드. */
  projectSeed: number
  /** `${layerId}:${effectId}`. 인스턴스마다 달라야 한다. */
  nodeId: string
  /** EffectInstance.holdFrames. 1 이면 홀드 없음. */
  holdFrames: number
  /** 다중 패스 이펙트(픽셀 소트 등)의 현재 패스 번호. 0부터 센다. */
  pass: number
  /** 이 이펙트가 이번 프레임에 도는 총 패스 수. 보통 1 이다. */
  passCount: number
  /** Track 파라미터는 이미 평가되어 숫자다. select / boolean / color 도 숫자다. */
  params: Record<string, number>
}

/** 선언형 유니폼을 쓰는 카탈로그가 쓰는 이름. 내용은 EffectEvalContext 와 같다. */
export type EffectUniformContext = EffectEvalContext

/** 선언형 유니폼. value 는 결정론적이어야 한다. */
export interface EffectUniformSpec {
  name: string
  type: 'float' | 'vec2' | 'vec3' | 'vec4' | 'int' | 'uint'
  value(ctx: EffectEvalContext): UniformValue
}

/** 함수형 유니폼. 값은 전부 float 계열로 취급한다. */
export type EffectUniformFn = (ctx: EffectEvalContext) => Record<string, UniformValue>

export interface EffectDef {
  id: string
  /** 사용자에게 보이는 한국어 이름 */
  label: string
  hint: string
  stage: EffectStage
  /** 생략하면 스테이지에서 유도한다 (registry.ts 의 effectCategory). */
  category?: EffectCategory
  cost: EffectCost
  /**
   * 알파를 그대로 보존하는가.
   * false 면 투명 배경에서 배경이 오염될 수 있으므로 경고 배지를 단다.
   */
  preservesAlpha: boolean
  params: EffectParamSpec[]

  /**
   * A/C 융합 셰이더에 넣을 GLSL 조각. 아래 계약을 지켜야 한다.
   *
   * 조각은 `#ifdef <define> ... #endif` 안에 통째로 들어간다. 따라서 유니폼 선언도
   * 여기에 함께 쓴다. 활성이 아니면 선언 자체가 사라져 프로그램이 가벼워진다.
   *
   * A 스테이지: `vec2 <entry>(vec2 uv, vec2 texel)` 를 정의한다.
   *   - 인자는 지금까지 누산된 uv 이고, 반환값은 거기에 더할 오프셋이다.
   *     융합 셰이더는 `uv += entry(uv, u_texel);` 를 레지스트리 순서대로 실행한다.
   *   - uv 를 직접 바꿔 반환하면 안 된다. 오프셋만 낸다.
   *     좌표를 통째로 갈아끼우고 싶으면 `목표좌표 - uv` 를 반환한다 (렌즈 왜곡이 그 예다).
   *   - texel = 1.0 / 소스 해상도. px 단위 파라미터를 UV 로 바꾸는 데 쓴다.
   *   - 최종 샘플링은 융합 셰이더가 한 번만 한다. 조각 안에서 u_image 를 읽지 않는다.
   *
   * C 스테이지: `vec4 <entry>(vec4 c, vec2 uv)` 를 정의한다.
   *   - c 는 premultiplied 색이고 반환값도 premultiplied 여야 한다.
   *     스트레이트로 다루려면 unpremul / premul 을 쓴다.
   *   - uv 는 원본 v_uv 다. 누산된 값이 아니다.
   *   - rgb <= a 를 깨면 합성 결과에 유령 테두리가 생긴다.
   */
  glsl?: string

  /** glsl 의 다른 이름. 둘 중 하나만 채운다. */
  chunk?: string

  /** glsl 조각의 진입 함수 이름. 생략하면 id 에서 유도한다 (effectEntry). */
  entry?: string

  /** entry 의 다른 이름. 둘 중 하나만 채운다. */
  fn?: string

  /**
   * B 스테이지 전용. 자체 프래그먼트 셰이더 전체.
   * glsl/common.ts 의 effectFragmentShader() 로 만들면 공통 프렐류드가 함께 붙는다.
   */
  fragmentShader?: string

  /** fragmentShader 의 다른 이름. 둘 중 하나만 채운다. */
  fragment?: string

  /**
   * false 면 융합하지 않고 단독 패스로 돌린다.
   * C 스테이지인데 이웃 픽셀을 읽는 조각(방향성 블러 등)이 여기 해당한다.
   * 다른 조각과 묶으면 앞 조각의 결과가 아니라 스테이지 입력을 읽어 순서가 어긋난다.
   */
  fusable?: boolean

  /** 이 이펙트가 활성일 때 켜지는 #define 이름. 생략하면 id 에서 유도한다. */
  define?: string

  /**
   * B 스테이지에서 같은 셰이더를 몇 번 반복할지. 생략하면 1 이다.
   *
   * 픽셀 소트처럼 이웃 스왑을 반복해 근사하는 이펙트가 쓴다. 반환값은 결과 픽셀을
   * 바꾸므로 성능에 따라 조절하면 안 된다. 반드시 파라미터로 저장해 문서에 남긴다
   * 반복 수는 반드시 저장해야 한다.
   * 각 패스는 ctx.pass 로 자기 번호를 알 수 있다.
   */
  passes?: (params: Record<string, number>) => number

  /**
   * 유니폼. 함수형과 선언형 둘 다 받는다.
   *
   * 함수형이면 값은 전부 float 계열(float/vec2/vec3/vec4)로 다룬다. 정수가 필요하면
   * 셰이더에서 int() 로 캐스팅한다. 선언형이면 type 이 'int' 인 항목만 uniform1i 로 간다.
   * 샘플러는 패스 그래프가 직접 바인딩하므로 여기서 다루지 않는다.
   */
  uniforms: EffectUniformFn | readonly EffectUniformSpec[]
}
