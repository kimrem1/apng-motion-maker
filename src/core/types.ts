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
  /**
   * 3D 회전. rotateX 는 가로축을 중심으로(위아래로 눕는다), rotateY 는 세로축을
   * 중심으로(좌우로 돈다) 돈다. 단위는 도이고 rotate 와 같이 쌓을 수 있다.
   *
   * 둘 다 0 이면 매트릭스가 지금까지와 한 글자도 달라지지 않는다. 그래서 옛 문서의
   * 픽셀은 바뀌지 않는다 (transform.ts buildLayerMatrix).
   */
  | 'rotateX'
  | 'rotateY'
  | 'translateX'
  | 'translateY'
  | 'skewX'
  | 'skewY'
  | 'opacity'
  /**
   * 가리기 진행률. 0 이면 완전히 가려지고 1 이면 전부 보인다.
   *
   * 투명도와 다르다. 투명도는 그림 전체가 옅어지고, 이쪽은 **경계선이 지나간
   * 자리만** 보인다. 어느 모양으로 지나갈지는 Layer.reveal 이 정한다.
   * 항등값이 1 이라 트랙이 없으면 아무 일도 일어나지 않는다.
   */
  | 'reveal'
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

// ---------------------------------------------------------------------------
// 도형
// ---------------------------------------------------------------------------

/**
 * 절차형 도형의 종류.
 *
 * 픽셀이 아니라 수식(SDF)으로 그린다. 그래서 크기를 아무리 키워도 가장자리가
 * 뭉개지지 않고, 파일도 늘어나지 않는다. 회전과 확대는 이미지 레이어와 똑같이
 * 트랙이 맡으므로 여기에는 **모양을 정하는 값만** 들어간다.
 */
export type ShapeKind =
  | 'rect'
  | 'circle'
  | 'triangle'
  | 'polygon'
  | 'star'
  | 'cross'
  | 'arc'
  /** 가운데에서 뻗는 살. 바람개비 / 집중선 / 방사 눈금이 전부 이것이다. */
  | 'burst'
  /** 일정한 간격으로 늘어선 짧은 막대. 자 눈금과 점선이 이것이다. */
  | 'ticks'
  /** 변이 안으로 파인 별빛. 별(star)은 변이 직선이라 이 모양이 나오지 않는다. */
  | 'sparkle'

export const SHAPE_KIND_LIST: ShapeKind[] = [
  'rect',
  'circle',
  'triangle',
  'polygon',
  'star',
  'cross',
  'arc',
  'burst',
  'ticks',
  'sparkle',
]

/** 도형의 기본 크기 상한. 캔버스 상한과 같은 이유로 4000 을 넘길 이유가 없다. */
export const SHAPE_SIZE_MIN = 2
export const SHAPE_SIZE_MAX = 4000

export interface ShapeSpec {
  kind: ShapeKind
  /** 채우기 색. `#rrggbb` 또는 `#rrggbbaa`. */
  color: string
  /**
   * 이 도형의 자연 크기(px). 이미지 레이어의 원본 픽셀 크기와 같은 자리다.
   *
   * fit 이 '원본 크기'(none)면 이 값이 그대로 화면 크기가 되고, 캔버스 해상도를
   * 바꾸면 Layer.baseScale 이 같은 비율로 따라간다. 즉 이미지와 완전히 같은 규칙을 탄다.
   */
  width: number
  height: number
  /**
   * 0 이면 꽉 찬 도형, 0 보다 크면 그 두께(px)의 테두리만 그린다.
   * 테두리는 안쪽으로 물리므로 두께를 올려도 이 레이어가 차지하는 크기는 그대로다.
   */
  strokeWidth: number
  /** 사각형 모서리 반지름(px). 짧은 변의 절반까지 올리면 알약이 된다. */
  cornerRadius: number
  /** 다각형과 별의 꼭짓점 수. */
  points: number
  /** 별의 안쪽 반지름 비율. 작을수록 뾰족하다. */
  innerRatio: number
  /** 부채꼴이 도는 각도. 360 이면 원이 된다. */
  sweepDeg: number
}

// ---------------------------------------------------------------------------
// 가리기 (와이프 / 마스크)
// ---------------------------------------------------------------------------

/**
 * 경계선이 지나가는 모양.
 *
 * 진행률은 여기 없다. `reveal` 트랙이 시간에 따라 0 에서 1 로 민다. 모양과 진행률을
 * 나눠 두는 이유는 프리셋이 트랙만 갈아끼우기 때문이다. 한 덩어리로 두면 세기
 * 슬라이더를 움직일 때마다 모양까지 새로 정해진다.
 */
export type RevealMode =
  | 'none'
  /** 한쪽 끝에서 반대쪽으로 쓸고 지나간다. */
  | 'left'
  | 'right'
  | 'up'
  | 'down'
  /** 가운데에서 양쪽으로 갈라진다. 양문이 열리는 모양이다. */
  | 'splitX'
  | 'splitY'
  /** 가운데에서 원이 자란다. */
  | 'iris'
  /** 시계바늘처럼 한 바퀴 돈다. 도형에 걸면 테두리가 그려지는 모양이 된다. */
  | 'clock'
  /** 가로 칸마다 따로 열린다. 블라인드다. */
  | 'blinds'

export const REVEAL_MODE_LIST: RevealMode[] = [
  'none',
  'left',
  'right',
  'up',
  'down',
  'splitX',
  'splitY',
  'iris',
  'clock',
  'blinds',
]

export const REVEAL_SLATS_MIN = 2
export const REVEAL_SLATS_MAX = 40

export interface RevealSpec {
  mode: RevealMode
  /**
   * 경계의 부드러움. 0 이면 칼로 자른 듯 끊기고, 1 이면 폭의 절반에 걸쳐 흐려진다.
   * 진행률 0 과 1 에서는 부드러움과 무관하게 완전히 가려지고 완전히 보인다.
   */
  softness: number
  /** 블라인드 칸 수. 다른 모양에서는 쓰지 않는다. */
  slats: number
  /** 시계 모양이 시작하는 각도(도). 0 이 12시이고 시계 방향이 양수다. */
  angle: number
  /**
   * 경계선이 지나가는 방향을 뒤집는다.
   *
   * **진행률을 되감는 것이 아니다.** 되감기는 트랙이 하는 일이고(1 에서 0 으로 키를
   * 찍으면 된다), 이 값은 "왼쪽에서" 를 "오른쪽에서" 로 바꾸는 것이다. 진행률 0 이면
   * 완전히 가려지고 1 이면 전부 보인다는 계약은 이 값과 무관하게 유지된다.
   */
  invert: boolean
}

/**
 * 원근 카메라 거리의 기본값. 레이어 긴 변의 몇 배인가로 잰다.
 *
 * px 가 아니라 배수인 이유는 캔버스 크기를 바꿔도 같은 그림이 나와야 하기 때문이다.
 * px 로 두면 512 캔버스에서 만든 카드 뒤집기가 2048 캔버스에서는 거의 평면이 된다.
 * 값이 작을수록 원근이 세다. 0 은 원근 없음(평행 투영)이다.
 */
export const PERSPECTIVE_DEFAULT = 2.5
export const PERSPECTIVE_MAX = 20

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

export type LayerType = 'image' | 'solid' | 'group' | 'shape'

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
  /**
   * 모션 기준점. [0,1] 이미지 로컬 비율이다.
   *
   * **회전과 확대가 도는 축일 뿐, 배치 원점이 아니다.** 그림은 언제나 캔버스
   * 중앙(+ translate)에 놓이고, 기준점을 옮겨도 그 자리는 그대로다. 보정은
   * transform.ts 의 buildLayerMatrix 가 매트릭스 안에서 한다. 트랙 값을 고쳐
   * 보정하면 프리셋을 다시 적용하는 순간(EASY 슬라이더는 드래그마다 다시 적용한다)
   * 그 값이 통째로 갈아끼워져 그림이 튄다.
   */
  anchor: [number, number]
  /**
   * 남아 있는 옛 필드. 지금은 보정이 항상 켜져 있다(위 anchor 주석).
   * 저장된 프로젝트가 이 키를 들고 있으므로 스키마에서 지우지 않는다.
   */
  keepPlaceOnAnchorChange: boolean
  /**
   * 캔버스 크기를 바꿨을 때 따라붙는 고정 배율. 기본 1 이다.
   *
   * fit 이 '원본 크기'(none)면 그림은 캔버스와 무관하게 자기 픽셀 크기로 앉는다.
   * 그래서 캔버스만 512 에서 256 으로 줄이면 그림은 그대로인 채 프레임이 좁아져,
   * 화면에서는 그림이 두 배로 커진 것처럼 보이고 사방이 잘린다. 반대로 키우면
   * 가운데 작게 남는다. 사용자가 고른 것은 "결과물 해상도" 이지 "확대" 가 아니다.
   *
   * 그래서 해상도를 바꾸는 컨트롤(EASY 의 크기, 인스펙터의 폭/높이)은 캔버스와 함께
   * 이 값을 같은 비율로 민다. 자르기처럼 **원본 픽셀 자체가 달라져서** 캔버스가
   * 바뀌는 경우는 건드리지 않는다. 그쪽은 그림도 이미 그만큼 작아져 있다.
   *
   * 트랙이 아니라 별도 필드인 이유는 프리셋이 scale 트랙을 통째로 갈아끼우기
   * 때문이다. 트랙에 섞어 두면 모션을 한 번 고르는 순간 사라진다.
   */
  baseScale?: number
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
   * 도형 레이어의 모양. type 이 'shape' 일 때만 있다.
   *
   * 이미지 레이어에는 이 키를 아예 넣지 않는다. 넣으면 저장된 프로젝트의 JSON 이
   * 왕복에서 달라져 "한 글자도 바꾸지 않는다" 는 계약이 깨진다 (project/migrate.ts).
   */
  shape?: ShapeSpec
  /**
   * 경계선이 지나가는 모양. `reveal` 트랙이 진행률을 민다.
   *
   * 없으면 가리기가 없다는 뜻이다. 렌더러가 마스크 계산을 통째로 건너뛰므로
   * 옛 문서에는 비용이 0 이다. 프리셋이 이 값을 정하고, 인스펙터에서 손대면
   * 다른 수동 편집과 똑같이 프리셋이 dirty 로 표시된다.
   */
  reveal?: RevealSpec
  /**
   * 3D 회전에 쓰는 카메라 거리. 레이어 긴 변의 배수다 (PERSPECTIVE_DEFAULT 주석).
   * 없으면 기본값을 쓴다. rotateX / rotateY 가 둘 다 0 이면 아무 데도 쓰이지 않는다.
   */
  perspective?: number
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
   * 이 프리셋이 레이어의 가리기 / 원근 거리를 심었는가.
   *
   * 트랙의 `props` 와 이펙트의 `effectIds` 와 같은 자리다. 둘 다 값이 하나뿐이라
   * 목록 대신 불리언이다. 이게 없으면 사용자가 인스펙터에서 직접 만든 가리기가
   * 다음 프리셋 클릭에 말없이 지워진다 (motions/merge.ts).
   */
  ownsReveal?: boolean
  ownsPerspective?: boolean
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
  /**
   * Layer.baseScale 그대로. fit 기준 배율에 곱해진다.
   *
   * scaleX/scaleY 에 섞지 않는 이유는 기준점 보정 때문이다. 보정은 "움직이지 않는
   * 배율"로 재야 확대 모션이 기준점에서 자란다. 애니메이션되는 scaleX 에 섞으면
   * 보정도 같이 커져서 기준점이 아무 일도 하지 않게 된다.
   */
  baseScale: number
  scaleX: number
  scaleY: number
  rotate: number
  /** 3D 회전(도). 둘 다 0 이면 매트릭스가 지금까지와 완전히 같다. */
  rotateX: number
  rotateY: number
  /**
   * 3D 회전에 쓸 카메라 거리(레이어 긴 변의 배수). Layer.perspective 를 그대로 옮긴다.
   * 트랙이 아니라 별도 채널인 이유는 baseScale 과 같다. 애니메이션되지 않는 값이다.
   */
  perspective: number
  translateX: number
  translateY: number
  skewX: number
  skewY: number
  anchorX: number
  anchorY: number
  opacity: number
  /** 가리기 진행률. 1 이면 전부 보인다. */
  reveal: number
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
  /**
   * 도형 레이어의 모양. 렌더러가 에셋 대신 이걸 그린다.
   *
   * 렌더러에 원본 Layer 를 넘기지 않는 이유는 그리기 루프가 문서를 다시 뒤지면
   * 레이어 수의 제곱만큼 탐색이 늘기 때문이다. 평가 단계에서 한 번만 실어 보낸다.
   */
  shape?: ShapeSpec
  /**
   * 가리기 모양. 진행률은 transform.reveal 이다.
   * shape 과 같은 이유로 있을 때만 키를 만든다 (JSON 결정론).
   */
  reveal?: RevealSpec
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
