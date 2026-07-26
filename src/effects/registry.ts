/**
 * 이펙트 레지스트리.
 *
 * 카탈로그는 atoms/ 세 파일이 만든다. 이 파일은 그것들을 한 줄로 세우고, UI 와
 * 패스 그래프가 쓰는 조회 / 정규화 / 파라미터 해석을 담당한다.
 * 원자만 둔다. VHS 나 CRT 같은 매크로는 macros.ts 가 원자 조합으로 만든다.
 * 모놀리식 셰이더로 만들면 "스캔라인만 원한다"를 영원히 못 맞춘다.
 *
 * 이 파일이 UI 와 만나는 유일한 면이다. UI 는 label / hint / params 만 읽는다.
 * 내부 id 와 define 은 어떤 형태로도 화면에 내보내지 않는다.
 *
 * ---------------------------------------------------------------------------
 * 카탈로그 순서 = 융합 셰이더의 실행 순서
 * ---------------------------------------------------------------------------
 * A 와 C 는 하나의 셰이더로 융합되므로, 같은 패스 안에서의 적용 순서는 사용자가
 * 스택에 쌓은 순서가 아니라 EFFECT_DEFS 의 순서다. 소스에 호출이 박혀 있기 때문이다.
 * 스테이지 간 순서(A -> B -> C)는 언제나 지켜진다.
 */

import type { EffectInstance, EffectParam, Track } from '@/core/types.ts'
import { effectiveFrame, hashSeed } from '@/core/rng.ts'
import { evalTrack } from '@/easing/curve.ts'
import type {
  EffectCategory,
  EffectDef,
  EffectEvalContext,
  EffectParamSpec,
  EffectStage,
  UniformValue,
} from './types.ts'
import { DESTROY_EFFECTS } from './atoms/destroy.ts'
import { FINISH_EFFECTS } from './atoms/finish.ts'
import { TRANSFORM_COMMON_GLSL, TRANSFORM_EFFECTS } from './atoms/transform.ts'

// ---------------------------------------------------------------------------
// 분류 라벨
// ---------------------------------------------------------------------------

export const EFFECT_CATEGORY_LABELS: Record<EffectCategory, string> = {
  warp: '왜곡',
  glitch: '지지직',
  texture: '질감',
  color: '색',
}

export const EFFECT_CATEGORY_ORDER: EffectCategory[] = ['warp', 'glitch', 'texture', 'color']

/**
 * 사용자에게 보이는 분류.
 *
 * 스테이지로 자동 유도하면 그레인과 스캔라인이 "색"에 들어간다. 사용자가 찾는 곳은
 * 거기가 아니다. 그래서 스테이지(구현 구조)와 카테고리(찾는 자리)를 여기서 끊는다.
 * 목록에 없는 id 는 스테이지에서 유도한다.
 */
const CATEGORY_BY_ID: Record<string, EffectCategory> = {
  // 왜곡
  'shake.transform': 'warp',
  'boil.warp': 'warp',
  'boil.edge': 'warp',
  'warp.displace': 'warp',
  'warp.lens': 'warp',
  'glitch.wave': 'warp',
  // 지지직
  'glitch.rgbShift': 'glitch',
  'glitch.slice': 'glitch',
  'glitch.block': 'glitch',
  'glitch.band': 'glitch',
  'glitch.pixelSort': 'glitch',
  'glitch.chroma': 'glitch',
  // 질감
  'fx.pixelate': 'texture',
  'fx.dirBlur': 'texture',
  'fx.halftone': 'texture',
  'fx.aperture': 'texture',
  'fx.scanline': 'texture',
  'fx.grain': 'texture',
  'fx.paper': 'texture',
  // 색
  'fx.grade': 'color',
  'fx.posterize': 'color',
  'fx.vignette': 'color',
}

// ---------------------------------------------------------------------------
// 카탈로그
// ---------------------------------------------------------------------------

/**
 * id 가 겹치면 먼저 등록된 것만 남긴다.
 *
 * 조용히 덮어쓰면 사용자가 A 를 고르고 B 가 실행되는 상태가 되고, 그 버그는
 * 셰이더까지 내려가서야 드러난다. 목록에서 빼는 편이 훨씬 빨리 눈에 띈다.
 */
function dedupeById(defs: readonly EffectDef[]): EffectDef[] {
  const seen = new Set<string>()
  const out: EffectDef[] = []
  for (const def of defs) {
    if (seen.has(def.id)) continue
    seen.add(def.id)
    out.push(def)
  }
  return out
}

export const EFFECT_DEFS: EffectDef[] = dedupeById([
  ...TRANSFORM_EFFECTS, // A 변형
  ...DESTROY_EFFECTS, // B 파괴
  ...FINISH_EFFECTS, // C 마감
])

export const EFFECT_BY_ID: ReadonlyMap<string, EffectDef> = new Map(
  EFFECT_DEFS.map((def) => [def.id, def]),
)

/**
 * 스테이지별로 융합 셰이더 머리에 한 번 깔아야 하는 공용 GLSL.
 *
 * A 스테이지 조각들은 도메인 워프와 엣지 검출에 쓰는 헬퍼를 공유한다. 조각마다
 * 붙이면 함수 재정의로 링크가 깨지므로 여기서 한 장으로 모은다.
 */
export const STAGE_PROLOGUE: Record<EffectStage, string> = {
  A: TRANSFORM_COMMON_GLSL,
  B: '',
  C: '',
}

/** 정의 순서를 유지한다. 이 순서가 융합 셰이더의 적용 순서다. */
export function byStage(stage: EffectStage): EffectDef[] {
  return EFFECT_DEFS.filter((def) => def.stage === stage)
}

export function byEffectCategory(category: EffectCategory): EffectDef[] {
  return EFFECT_DEFS.filter((def) => effectCategory(def) === category)
}

/** 투명 배경에서 경고 배지를 달아야 하는 이펙트. */
export function warnsOnAlpha(def: EffectDef): boolean {
  return !def.preservesAlpha
}

// ---------------------------------------------------------------------------
// 정규화 (두 가지 표기를 하나로 합친다. types.ts 상단 주석 참조)
// ---------------------------------------------------------------------------

/** GLSL 식별자로 쓸 수 있게 접은 id. 'boil.warp' -> 'boil_warp' */
export function effectToken(def: EffectDef): string {
  return def.id.replace(/[^A-Za-z0-9]/g, '_')
}

/** 생략되었으면 id 에서 유도한다. 전역에서 유일해야 한다. */
export function effectDefine(def: EffectDef): string {
  return def.define ?? `FX_${effectToken(def).toUpperCase()}`
}

/** 융합 조각의 진입 함수 이름. A 는 warp_, C 는 grade_ 접두사를 쓴다. */
export function effectEntry(def: EffectDef): string {
  const explicit = def.entry ?? def.fn
  if (explicit) return explicit
  return `${def.stage === 'A' ? 'warp' : 'grade'}_${effectToken(def)}`
}

/** 융합 조각 GLSL. 두 필드 이름 중 채워진 쪽을 돌려준다. */
export function effectGlsl(def: EffectDef): string | undefined {
  return def.glsl ?? def.chunk
}

/** B 스테이지 셰이더. 두 필드 이름 중 채워진 쪽을 돌려준다. */
export function effectFragment(def: EffectDef): string | undefined {
  return def.fragmentShader ?? def.fragment
}

/** 카테고리. 표에 없으면 스테이지에서 유도한다. */
export function effectCategory(def: EffectDef): EffectCategory {
  if (def.category) return def.category
  const mapped = CATEGORY_BY_ID[def.id]
  if (mapped) return mapped
  if (def.stage === 'A') return 'warp'
  if (def.stage === 'B') return 'glitch'
  return 'color'
}

/**
 * 융합 가능한가.
 * 명시적으로 false 인 조각은 이웃 픽셀을 읽으므로 단독 패스여야 한다.
 * 다른 조각과 묶으면 앞 조각의 결과가 아니라 스테이지 입력을 읽어 순서가 어긋난다.
 */
export function isFusable(def: EffectDef): boolean {
  return def.fusable !== false
}

/** 'medium' 은 'mid' 와 같은 등급이다. 표기 흔들림을 여기서 흡수한다. */
export function normalizedCost(def: EffectDef): 'free' | 'low' | 'mid' | 'high' {
  return def.cost === 'medium' ? 'mid' : def.cost
}

/**
 * 반복 패스 수 (픽셀 소트 등). 1 이상 64 이하로 자른다.
 * 이 값은 결과 픽셀을 바꾸므로 기기 성능에 따라 달라지면 안 된다.
 */
export function effectPassCount(def: EffectDef, params: Record<string, number>): number {
  if (!def.passes) return 1
  const n = def.passes(params)
  if (!Number.isFinite(n)) return 1
  return Math.max(1, Math.min(64, Math.round(n)))
}

export interface ResolvedUniform {
  name: string
  value: UniformValue
  /** 'float' 는 uniform1f, 'int' 는 uniform1i, 'uint' 는 uniform1ui 로 간다. */
  kind: 'float' | 'int' | 'uint'
}

/** 함수형과 선언형 유니폼을 같은 목록으로 펼친다. */
export function evalEffectUniforms(def: EffectDef, ctx: EffectEvalContext): ResolvedUniform[] {
  const spec = def.uniforms
  if (typeof spec === 'function') {
    // 함수형은 전부 float 계열이다. 정수는 셰이더에서 캐스팅한다.
    const record = spec(ctx)
    return Object.keys(record).map((name) => ({
      name,
      value: record[name] as UniformValue,
      kind: 'float' as const,
    }))
  }
  return spec.map((u) => ({
    name: u.name,
    value: u.value(ctx),
    kind: u.type === 'int' ? ('int' as const) : u.type === 'uint' ? ('uint' as const) : ('float' as const),
  }))
}

// ---------------------------------------------------------------------------
// 시간 / 시드 헬퍼 (이펙트 구현이 공유한다)
// ---------------------------------------------------------------------------

/** float 가 정확히 표현하는 범위. 셰이더에서 uint(int(x)) 로 되돌린다. */
const SEED_MODULUS = 16777216

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

/** 한 주기 안의 위상 [0, 1). effFrame 기준이라 홀드 클럭이 그대로 반영된다. */
export function loopPhase(ctx: EffectEvalContext): number {
  const duration = Math.max(1, Math.floor(ctx.durationFrames))
  const f = ((Math.floor(ctx.effFrame) % duration) + duration) % duration
  return f / duration
}

/**
 * 프레임마다 다른 난수가 필요한 이펙트용 시드.
 *
 * ctx.seed 를 그대로 써도 되지만, 한 이펙트 안에서 여러 계열이 필요할 때는
 * salt 로 갈라야 두 계열이 상관되지 않는다. 기준은 프레임 불변 시드이고
 * effFrame 을 여기서 섞으므로 홀드 클럭이 그대로 반영된다.
 */
export function frameSeed(ctx: EffectEvalContext, salt = 0): number {
  return hashSeed((ctx.seedStatic ^ salt) >>> 0, 'fx', Math.floor(ctx.effFrame))
}

/** 유니폼(float)으로 넘길 수 있게 24비트로 줄인다. */
export function seedFloat(seed: number): number {
  return (seed >>> 0) % SEED_MODULUS
}

// ---------------------------------------------------------------------------
// 파라미터 해석
// ---------------------------------------------------------------------------

function isTrack(v: EffectParam | undefined): v is Track {
  return typeof v === 'object' && v !== null && Array.isArray((v as Track).keys)
}

/** 이펙트 파라미터의 기본값은 항상 숫자다. 저장된 문자열/불리언도 받아 준다. */
export function defaultNumber(spec: EffectParamSpec): number {
  const d = spec.default
  if (typeof d === 'number') return d
  if (typeof d === 'boolean') return d ? 1 : 0
  const n = Number(d)
  return Number.isFinite(n) ? n : 0
}

/** 선택형 옵션 값. 문자열로 저장되어 있어도 숫자로 되돌린다. */
export function optionValues(spec: EffectParamSpec): number[] {
  return (spec.options ?? []).map((o) => Number(o.value)).filter((n) => Number.isFinite(n))
}

function coerceParam(spec: EffectParamSpec, raw: number): number {
  // 색은 0xRRGGBB 정수 하나다. 범위를 자르면 색이 바뀐다.
  if (spec.type === 'color') return Math.round(raw)

  if (spec.type === 'select') {
    const options = optionValues(spec)
    const first = options[0]
    if (first === undefined) return raw
    let best = first
    for (const o of options) {
      if (Math.abs(o - raw) < Math.abs(best - raw)) best = o
    }
    return best
  }

  if (spec.type === 'boolean') return raw >= 0.5 ? 1 : 0

  const lo = spec.min ?? Number.NEGATIVE_INFINITY
  const hi = spec.max ?? Number.POSITIVE_INFINITY
  return clamp(raw, lo, hi)
}

/**
 * 인스턴스 파라미터를 프레임에서 숫자로 확정한다.
 * 값이 Track 이면 easing/curve.ts 의 evalTrack 으로 그 프레임에서 평가한다.
 * 저장된 프로젝트에서 무엇이 들어오든 스펙 범위 안으로 잘라낸다.
 */
export function resolveEffectParams(
  def: EffectDef,
  instance: EffectInstance,
  frame: number,
): Record<string, number> {
  const out: Record<string, number> = {}
  for (const spec of def.params) {
    const raw = instance.params[spec.key]
    let v: number
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      v = raw
    } else if (isTrack(raw)) {
      const evaluated = evalTrack(raw, frame)
      v = evaluated !== undefined && Number.isFinite(evaluated) ? evaluated : defaultNumber(spec)
    } else {
      v = defaultNumber(spec)
    }
    out[spec.key] = coerceParam(spec, v)
  }
  return out
}

// ---------------------------------------------------------------------------
// 활성 판정
// ---------------------------------------------------------------------------

/** range 는 [시작, 끝] 프레임이고 양끝을 포함한다. 뒤집혀 저장되어도 받아 준다. */
export function isEffectActiveAt(instance: EffectInstance, frame: number): boolean {
  if (!instance.enabled) return false
  if (!EFFECT_BY_ID.has(instance.type)) return false
  const range = instance.range
  if (range) {
    const lo = Math.min(range[0], range[1])
    const hi = Math.max(range[0], range[1])
    if (frame < lo || frame > hi) return false
  }
  return true
}

export function activeEffects(
  effects: readonly EffectInstance[],
  frame: number,
): EffectInstance[] {
  return effects.filter((e) => isEffectActiveAt(e, frame))
}

/** 순차 렌더를 강제해야 하는가 (데이터모시 등). */
export function requiresHistory(effects: readonly EffectInstance[]): boolean {
  return effects.some((e) => e.enabled && e.requiresHistory)
}

// ---------------------------------------------------------------------------
// 인스턴스 생성
// ---------------------------------------------------------------------------

/**
 * 기본값으로 채운 인스턴스. 상태 레이어가 이펙트를 추가할 때 쓴다.
 * id 는 호출부가 정한다. 여기서 만들면 결정론이 깨진다.
 */
export function createEffectInstance(type: string, id: string, seed = 1): EffectInstance | null {
  const def = EFFECT_BY_ID.get(type)
  if (!def) return null
  const params: Record<string, EffectParam> = {}
  for (const spec of def.params) params[spec.key] = defaultNumber(spec)
  return {
    id,
    type: def.id,
    enabled: true,
    seed: seed >>> 0,
    holdFrames: 1,
    requiresHistory: false,
    params,
  }
}

/** 인스턴스의 홀드 클럭을 적용한 프레임. 시드에는 항상 이 값을 넣는다. */
export function effectFrameOf(instance: EffectInstance, frame: number): number {
  return effectiveFrame(frame, instance.holdFrames)
}
