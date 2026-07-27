/**
 * 문서 모델.
 *
 * 이 파일은 엔진 전체의 계약이다. DOM / React / window 를 절대 참조하지 않는다.
 * UI 가 당장 쓰지 않는 필드까지 스키마에 미리 확정해 둔다.
 * 나중에 필드를 추가하면 저장된 프로젝트를 마이그레이션해야 하기 때문이다.
 */

export const SCHEMA_ID = 'motion-maker/1' as const

/** 셰이더나 평가기가 바뀌어 같은 문서가 다른 픽셀을 내면 증가시킨다. */
export const RENDER_REVISION = 1

// ---------------------------------------------------------------------------
// 캔버스
// ---------------------------------------------------------------------------

export type BackgroundType = 'alpha' | 'solid' | 'blurExtend' | 'mirror'

export interface CanvasConfig {
  w: number
  h: number
  background: {
    type: BackgroundType
    /** solid 일 때의 색 (#rrggbb 또는 #rrggbbaa) */
    color: string
    /**
     * 불투명 포맷으로 내보낼 때 반투명 픽셀을 합성할 색.
     * 지정하지 않으면 검은 테두리가 생긴다.
     */
    matteColor: string
  }
}

/**
 * 하드 상한.
 *
 * 4096 이 아니라 4000 인 이유는 저사양 기기의 MAX_TEXTURE_SIZE 가 4096 이기
 * 때문이다. 캔버스와 같은 크기의 FBO 를 여러 장 잡으므로 상한을 기기 상한에
 * 딱 붙이면 여유가 없다. 4000 이면 그 아래에 안전하게 들어간다.
 *
 * 이 크기는 싸지 않다. 4000x4000 한 장이 64MB 이고, 내보내기는 거의 항상
 * 스트리밍 경로(MEMORY_BUDGET_BYTES 초과)로 간다. 그쪽이 상주 메모리를
 * 프레임 두어 장으로 묶어 주므로 상한을 올려도 탭이 죽지 않는다.
 */
export const CANVAS_MIN = 16
export const CANVAS_MAX = 4000
export const FRAMES_MAX = 120

/**
 * 속도 노브의 범위. 값이 클수록 짧아진다. 시간에만 작용하고 진폭에는 섞이지 않는다.
 *
 * **이 두 상수는 여기 한 곳에만 있어야 한다.** 예전에는 같은 숫자가 일곱 군데에
 * 흩어져 있었고, 그중 하나(레지스트리의 emit 전처리)만 남아 있어도 나머지를 전부
 * 바꾼 것이 화면에서는 아무 효과가 없었다. 실제로 속도 0.5 와 0.05 가 56종 전부에서
 * 같은 결과를 냈다.
 *
 * 하한 0.1 은 기본 재생 시간 1.2초를 12초까지 늘린다. 12초는 프레임 상한 120 을
 * 최저 fps 10 으로 나눈 값이고, 이 제품이 낼 수 있는 가장 긴 애니메이션이다.
 */
export const SPEED_MIN = 0.1
export const SPEED_MAX = 2
export const SPEED_DEFAULT = 1

// ---------------------------------------------------------------------------
// 타임라인
// ---------------------------------------------------------------------------

export type LoopMode = 'once' | 'loop' | 'pingPong' | 'loopWithHold'

export interface LoopSpec {
  mode: LoopMode
  /** 0 = 무한 */
  count: number
  /** loopWithHold 에서 마지막 프레임을 붙잡는 시간 (ms) */
  holdMs: number
  /** loop/pingPong 에서 이음새 프레임 중복을 제거한다 */
  dedupeBoundaryFrame: boolean
}

/**
 * 선택 가능한 fps.
 * GIF 는 1/100초 격자라 100/N 인 값만 정확히 표현된다 (10 / 12.5 / 20 / 25 / 50).
 */
export const FPS_CHOICES = [10, 12, 12.5, 15, 20, 24, 25, 30, 50] as const
export type Fps = (typeof FPS_CHOICES)[number]

/**
 * GIF 에서 지연 시간이 정확히 표현되는 fps.
 *
 * GIF 의 지연 필드는 1/100초 단위 정수다. 100/N 이 정수인 fps 만 어긋나지 않는다.
 * 12fps 는 8.33/100초를 8 로 반올림해 실제로는 12.5fps 로 재생되고, 30fps 는 33.3fps 가
 * 된다. 자동으로 fps 를 고를 때는 이 집합에서만 고른다. 사용자가 직접 고르는 것은
 * FPS_CHOICES 전체이고, 그때는 TransportBar 가 어긋남을 문구로 알린다.
 */
export const GIF_EXACT_FPS = [50, 25, 20, 12.5, 10] as const

export interface TimelineConfig {
  fps: number
  durationFrames: number
  loop: LoopSpec
}

// ---------------------------------------------------------------------------
// 세이프존 / 오버스캔
// ---------------------------------------------------------------------------

export type SafeZonePolicy = 'autoFit' | 'backgroundFill' | 'warn' | 'allowEmpty'

export interface SafeZoneConfig {
  policy: SafeZonePolicy
  /** s_min 위에 얹는 여유. 서브픽셀 리샘플링으로 생기는 반투명 1px 라인을 막는다. */
  marginRatio: number
  /** 시간축 최대화에 쓰는 균등 샘플 수 */
  sampleCount: number
  edgeBleedPx: number
}

// ---------------------------------------------------------------------------
// 에셋
// ---------------------------------------------------------------------------

export interface AssetPrep {
  /** [x, y, w, h] 를 자연 크기 픽셀 단위로 */
  crop?: [number, number, number, number]
  bgRemove?: {
    enabled: boolean
    keyColor: string
    tolerance: number
    featherPx: number
    /** 모서리에서 연결된 영역만 지웠는가. 이게 빠지면 기록으로 재현이 안 된다. */
    contiguous?: boolean
  }
}

export interface AssetRef {
  id: string
  name: string
  /** 픽셀은 문서 상태에 넣지 않는다. IndexedDB 키만 저장한다. */
  storeKey: string
  naturalW: number
  naturalH: number
  hasAlpha: boolean
  prep?: AssetPrep
}

// ---------------------------------------------------------------------------
// 키프레임 / 트랙
// ---------------------------------------------------------------------------

export type TrackProp =
  | 'scale'
  | 'scaleX'
  | 'scaleY'
  | 'rotate'
  | 'translateX'
  | 'translateY'
  | 'skewX'
  | 'skewY'
  | 'opacity'
  | 'anchorX'
  | 'anchorY'

export type TrackUnit = 'ratio' | 'px' | 'percentOfCanvas' | 'deg' | 'norm'

export type CompositeOp = 'replace' | 'add' | 'multiply'

export type Interp = 'bezier' | 'linear' | 'hold' | 'spring' | 'samples'

export interface Handle {
  /** 시간축 영향력. [0,1] 클램프가 베지어 역산의 단조성을 보장한다. */
  x: number
  /** 값축. 클램프하지 않는다. 오버슈트를 허용해야 한다. */
  y: number
}

export type SpringFit = 'springDrivesDuration' | 'fitToDuration'

export interface SpringSpec {
  mode: 'physical' | 'visual'
  stiffness: number
  damping: number
  mass: number
  visualDuration: number
  /** bounce = 1 - 감쇠비. 0 이면 임계 감쇠. */
  bounce: number
  fit: SpringFit
  bakeSamples: number
}

export interface Keyframe {
  /** 정수 프레임 인덱스가 정본이다. 부동소수 드리프트를 막는다. */
  f: number
  v: number
  interp: Interp
  out?: Handle
  in?: Handle
  spring?: SpringSpec
  /**
   * 적용된 이징 프리셋 id (easing/presets.ts).
   *
   * 이게 없으면 bounce 와 elastic 이 사라진다. 두 곡선은 베지어 핸들 4개로 표현할 수
   * 없어서 프리셋의 표시용 근사치만 저장하면 back 과 구별되지 않는다. 실제로 세 프리셋이
   * 완전히 같은 곡선을 만들고 "탱탱볼" 이 튕기지 않았다.
   * 평가는 이 id 의 정본 함수로 하고, 핸들은 그래프 표시와 CSS 복사에만 쓴다.
   */
  easingPreset?: string
}

export interface Track {
  id: string
  prop: TrackProp
  unit: TrackUnit
  /** 생략하면 prop 별 기본 규칙 */
  composite?: CompositeOp
  /**
   * 사용자가 스톱워치를 켰는가.
   *
   * 키가 하나뿐이어도 애니메이션 상태일 수 있다는 점이 중요하다. 이 필드가 없으면
   * "스톱워치를 켠 뒤 재생헤드를 옮겨 값을 바꿔도 키가 생기지 않는" 상태가 된다.
   * 키 개수만으로 판정하면 첫 키를 찍은 직후가 정확히 그 상태다.
   */
  animated?: boolean
  keys: Keyframe[]
}

// ---------------------------------------------------------------------------
// 절차형 모디파이어 (흔들림 / 자글자글의 토대)
// ---------------------------------------------------------------------------

export type ModifierType = 'sine' | 'loopNoise' | 'eventBurst' | 'spring' | 'audioEnvelope'

export type ModifierTarget = Extract<
  TrackProp,
  'translateX' | 'translateY' | 'rotate' | 'scale' | 'opacity' | 'skewX' | 'skewY'
>

export interface Modifier {
  id: string
  type: ModifierType
  target: ModifierTarget
  blendOp: CompositeOp
  seed: number
  amplitude: number
  /** sine 에서는 정수여야 심리스 루프가 된다. */
  cycles: number
  octaves: number
  persistence: number
  lacunarity: number
  /** effFrame = floor(frame / holdFrames) * holdFrames */
  holdFrames: number
  decay: number
  envelope?: Keyframe[]
}

// ---------------------------------------------------------------------------
// 이펙트
// ---------------------------------------------------------------------------

/** 파라미터는 상수이거나 시간에 따라 변하는 트랙이다. */
export type EffectParam = number | Track

export interface EffectInstance {
  id: string
  /** effects/registry.ts 의 id */
  type: string
  enabled: boolean
  seed: number
  holdFrames: number
  /** true 면 순차 렌더를 강제한다 (데이터모시 등) */
  requiresHistory: boolean
  /** [startFrame, endFrame], 생략 시 전 구간 */
  range?: [number, number]
  params: Record<string, EffectParam>
}

// ---------------------------------------------------------------------------
// 레이어
// ---------------------------------------------------------------------------

export type FitMode = 'cover' | 'contain' | 'fill' | 'none'

/**
 * 모션이 프레임을 벗어날 때 무엇을 지킬 것인가. 저장되는 값이 아니라
 * keepInside / fillsCanvas 조합에 붙인 이름이다.
 *
 *   contain  원본이 잘리지 않게 줄여 담는다. 투명 배경 스티커의 기본값이다.
 *   crop     원본 크기를 그대로 두고 프레임 밖은 잘라낸다. 확대가 프레임을
 *            넘어가도 되는 경우다. 이동 모션에서는 한쪽에 빈 가장자리가 드러난다.
 *   cover    여백이 생기지 않게 미리 키운다. 배경 사진을 훑는 모션이 이쪽이다.
 *            양쪽이 잘리는 대신 어느 프레임에도 빈 곳이 없다.
 *
 * 셋은 배타다. contain 과 cover 는 배율을 반대 방향으로 밀고, crop 은 아무도
 * 개입하지 않는 상태다.
 */
export type FrameFit = 'contain' | 'crop' | 'cover'

export type BlendMode = 'normal' | 'multiply' | 'screen' | 'overlay' | 'lighten' | 'darken'

export type LayerType = 'image' | 'solid' | 'group'

export interface Layer {
  id: string
  name: string
  type: LayerType
  assetId: string | null
  parentId: string | null
  z: number
  visible: boolean
  locked: boolean
  fit: FitMode
  /** [0,1] 이미지 로컬 비율 */
  anchor: [number, number]
  /** 기준점을 바꿔도 화면상 위치가 유지되도록 translate 를 보정한다. */
  keepPlaceOnAnchorChange: boolean
  blend: BlendMode
  parallaxFactor: number
  /** true 인 레이어만 오버스캔 솔버 대상이다. */
  fillsCanvas: boolean
  /**
   * 원본이 프레임 밖으로 나가 잘리지 않게 배율을 자동으로 낮춘다.
   *
   * fillsCanvas 의 거울상이고 둘은 동시에 켤 수 없다. 채우기는 이미지를 키워
   * 캔버스를 덮고, 담기는 이미지를 줄여 캔버스 안에 넣는다. 같이 켜면 한쪽이
   * 반드시 진다. 스토어 액션이 배타를 강제한다.
   */
  keepInside: boolean
  /**
   * 지금 얹힌 모션은 일부러 프레임 밖으로 나간다 (슬라이드 등장 / 사라짐).
   *
   * 사용자 설정이 아니라 프리셋에서 파생된 사실이고, 프리셋을 적용할 때마다 다시
   * 쓰인다. 담기 솔버가 이런 모션에 개입하면 빠져나가야 할 그림이 가장자리에 붙어
   * 멈춘다. 프리셋 카탈로그를 문서에 복사해 두는 이유는 core/ 가 motions/ 레지스트리를
   * import 하지 않기 위해서다.
   */
  motionExitsFrame: boolean
  /**
   * 담기 배율의 기준값. 세기를 최대(1.0)로 올렸을 때도 담기는 배율이다.
   *
   * 지금 세기로 매번 다시 풀면 안 된다. 담기는 "안 잘리는 선에서 최대한 크게" 를
   * 구하므로 모션의 극단이 **항상 프레임에 딱 맞는다.** 세기를 올리면 이동이 커지는
   * 만큼 그림이 작아져서, 화면에서 그림이 훑는 범위는 세기와 무관하게 일정해진다.
   * 세기 슬라이더가 아무 일도 안 하는 것처럼 보이고, 한쪽으로만 움직이는 프리셋에서는
   * 세기를 올릴수록 훑는 범위가 오히려 줄어든다.
   *
   * 그래서 프리셋을 적용할 때 세기 1.0 기준으로 한 번만 재서 여기 박아 둔다. 그림
   * 크기가 슬라이더를 따라 변하지 않고, 세기는 고정된 크기 안에서 움직임의 크기만
   * 바꾼다. 대신 기본 세기에서는 프레임에 여백이 남는다.
   *
   * 없으면 문서에서 직접 푼다. 손으로 만든 레이어와 옛 프로젝트가 그 경우다.
   */
  containScale?: number
  tracks: Track[]
  modifiers: Modifier[]
  effects: EffectInstance[]
}

// ---------------------------------------------------------------------------
// 프로젝트
// ---------------------------------------------------------------------------

export interface PresetRef {
  id: string
  macro: { speed: number; strength: number }
  /** PRO 에서 손대면 true. EASY 의 강도 슬라이더가 비활성화된다. */
  dirty: boolean
  /**
   * 이 프리셋이 만든 트랙의 속성 목록.
   *
   * 다음 프리셋을 적용할 때 이 목록을 지운다. 없으면 앞 프리셋의 모션이 그대로 남아
   * 두 움직임이 겹쳐 재생된다. 예를 들어 "톡 튀며 등장"(크기+투명도) 다음에
   * "한 바퀴 회전"(회전)을 고르면 회전하면서 계속 튀어오른다.
   * 사용자가 직접 만든 트랙은 이 목록에 없으므로 살아남는다.
   */
  props?: TrackProp[]
  /**
   * 이 프리셋이 만든 이펙트의 id 목록.
   *
   * 트랙과 같은 이유다. 자글자글 다음에 흔들기를 고르면 흔들기는 이펙트를 정의하지
   * 않으므로 자글자글의 워프가 그대로 남아 두 효과가 겹친다.
   * 사용자가 직접 추가한 이펙트는 이 목록에 없으므로 살아남는다.
   */
  effectIds?: string[]
  /**
   * 속도 1 일 때의 재생 시간(초). 속도 노브의 기준선이다.
   *
   * **emit 이 돌려준 길이가 아니라 요청한 기준선을 넣는다.** 자글자글과 지지직 계열은
   * 홀드 배수로 길이를 반올림하는데(snapToHold), 그 결과를 기준선으로 되먹이면 속도를
   * 왕복할 때마다 오차가 다시 들어와 길이가 계속 늘어난다. 실제로 56종 중 12종이
   * 속도 1 -> 0.5 -> 2 -> 0.5 -> 1 왕복 한 번에 1.20초에서 1.28초가 됐다.
   *
   * 프레임 수로 저장하면 안 되는 이유는 두 가지다. 프레임은 상한 120 에 잘리므로
   * 나중에 속도를 곱해 되돌릴 수 없고, fps 가 바뀌면 같은 프레임 수가 다른 시간을
   * 뜻하게 된다. 초는 둘 다에서 자유롭다.
   *
   * 없으면 옛 프로젝트다. durationFrames / fps 로 되짚는다.
   */
  baseSec?: number
  /**
   * 속도 1 일 때의 fps. 속도가 낮아지며 내려간 fps 를 다시 올릴 때의 천장이다.
   *
   * 속도 유도 fps 는 절대 올리지 않는다는 규칙이 있다. 사용자가 "느리게" 를 요구했는데
   * fps 가 25 에서 50 으로 오르면 프레임 수와 파일 크기가 두 배가 되기 때문이다.
   * 그런데 천장을 "지금 문서 fps" 로 잡으면 한 번 내려간 fps 가 영영 안 올라와서,
   * 속도를 되돌려도 길이가 원래대로 돌아오지 않는다. 실제로 56종 중 13종이
   * 0.92초에서 0.88초로 어긋났다.
   *
   * 그래서 천장을 **사용자가 고른 fps** 로 따로 들고 있는다. 속도를 1 로 되돌리면
   * 이 값으로 복귀한다.
   */
  baseFps?: number
}

export interface MotionProject {
  schema: typeof SCHEMA_ID
  appVersion: string
  renderRevision: number
  canvas: CanvasConfig
  timeline: TimelineConfig
  safeZone: SafeZoneConfig
  assets: AssetRef[]
  layers: Layer[]
  presetRef?: PresetRef
}

/**
 * 렌더러에 넘기는 불변 스냅샷.
 * 지금은 MotionProject 와 같지만, 프리컴프가 들어오면 갈라진다.
 */
export type CompositionSnapshot = MotionProject

// ---------------------------------------------------------------------------
// 평가 결과 (렌더러 입력)
// ---------------------------------------------------------------------------

/** 트랙 + 모디파이어를 결합하고 오버스캔 솔버까지 적용한 최종 값. */
export interface ResolvedTransform {
  scaleX: number
  scaleY: number
  rotate: number
  translateX: number
  translateY: number
  skewX: number
  skewY: number
  anchorX: number
  anchorY: number
  opacity: number
}

export interface ResolvedLayer {
  layerId: string
  assetId: string | null
  visible: boolean
  z: number
  fit: FitMode
  blend: BlendMode
  transform: ResolvedTransform
  effects: EffectInstance[]
}

// ---------------------------------------------------------------------------
// 렌더 타깃
// ---------------------------------------------------------------------------

export interface RenderTarget {
  gl: WebGL2RenderingContext
  width: number
  height: number
  /** null = 기본 프레임버퍼(화면) */
  fbo: WebGLFramebuffer | null
}

/** GPU 에 올라간 에셋. 프레임마다 createImageBitmap 을 호출하지 않는다. */
export interface GpuAsset {
  texture: WebGLTexture
  width: number
  height: number
  hasAlpha: boolean
}

export type AssetTable = ReadonlyMap<string, GpuAsset>
