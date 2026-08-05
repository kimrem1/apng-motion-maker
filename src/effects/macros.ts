/**
 * 이펙트 매크로.
 *
 * 매크로는 새 셰이더가 아니다. 원자 이펙트 id 와 파라미터 오버라이드 목록일 뿐이다.
 *
 * VHS 를 하나의 모놀리식 셰이더로 만들면 "스캔라인만 남기고 나머지는 빼줘" 를
 * 영원히 못 맞춘다. 원자로 펼쳐 두면 사용자가 스택에서 한 줄만 지우면 된다.
 * 그래서 여기서 하는 일은 EffectInstance 배열을 만들어 주는 것뿐이고,
 * 만들어진 뒤에는 매크로였다는 사실이 문서에 남지 않는다.
 *
 * 렌더 경로가 아니므로 Math.random 금지 규칙은 여기에도 그대로 적용된다.
 * 시드는 호출부가 준 baseSeed 에서 결정론적으로 파생한다.
 */

import type { EffectInstance } from '@/core/types.ts'
import type { EffectCost, EffectDef, EffectParamSpec } from '@/effects/types.ts'
import { DESTROY_EFFECTS } from '@/effects/atoms/destroy.ts'
import { FINISH_EFFECTS } from '@/effects/atoms/finish.ts'

// ---------------------------------------------------------------------------
// 타입
// ---------------------------------------------------------------------------

export interface EffectMacroStep {
  /** 원자 이펙트 id */
  type: string
  /** 기본값을 덮어쓸 파라미터 */
  params: Record<string, number>
  /** 이 원자가 레지스트리에 없으면 조용히 건너뛴다. */
  optional?: boolean
  holdFrames?: number
  /** 같은 매크로 안에서 스텝마다 다른 난수를 쓰게 한다. 생략하면 스텝 순번을 쓴다. */
  seedOffset?: number
  /** 세기 슬라이더가 곱해질 파라미터 키. 여기 없는 키는 세기와 무관하게 고정된다. */
  scaled?: string[]
}

export interface EffectMacro {
  /** 내부 id. UI 에 노출하지 않는다. */
  id: string
  label: string
  hint: string
  cost: EffectCost
  /**
   * 투명 배경이 오염되는가.
   * 원자 하나하나는 알파를 지켜도, 겹쳐 놓으면 실루엣 밖에 색이 남는 조합이 있다.
   * 이 값은 개별 원자의 값을 AND 한 것이 아니라 조합 결과를 보고 정한다.
   */
  preservesAlpha: boolean
  steps: EffectMacroStep[]
}

export interface MacroExpandOptions {
  /** EffectInstance.id 생성기. 보통 () => nextId('e') */
  makeId: () => string
  /** 0~1. 0.5 가 기본이고 그 지점에서 표의 값이 그대로 나온다. */
  strength?: number
  /** 시드 기준값. 프로젝트 시드나 레이어 해시를 넣는다. */
  baseSeed?: number
  /**
   * 레지스트리에 그 원자가 있는지 검사한다.
   * 생략하면 전부 통과시킨다. 실제 검사를 넘겨야 optional 스텝이 걸러진다.
   */
  has?: (type: string) => boolean
}

// ---------------------------------------------------------------------------
// 파라미터 스펙 조회 (범위 클램프용)
// ---------------------------------------------------------------------------

const SPEC_BY_TYPE: Map<string, Map<string, EffectParamSpec>> = new Map()

function indexDefs(defs: EffectDef[]): void {
  for (const def of defs) {
    const bag = new Map<string, EffectParamSpec>()
    for (const p of def.params) bag.set(p.key, p)
    SPEC_BY_TYPE.set(def.id, bag)
  }
}

indexDefs(DESTROY_EFFECTS)
indexDefs(FINISH_EFFECTS)

function clampToSpec(type: string, key: string, value: number): number {
  const spec = SPEC_BY_TYPE.get(type)?.get(key)
  if (!spec) return value
  let v = value
  if (typeof spec.min === 'number' && v < spec.min) v = spec.min
  if (typeof spec.max === 'number' && v > spec.max) v = spec.max
  // 정수 격자 파라미터는 반올림한다. 슬라이스 수 15.7 같은 값이 셰이더로 흘러가면 안 된다.
  if (spec.step === 1) v = Math.round(v)
  return v
}

/**
 * 세기 슬라이더를 진폭 배수로 옮긴다.
 * 0.5 에서 정확히 1.0 이 나와야 아래 표의 기본값과 일치한다 (motions/presets/shared.ts 와 동일 식).
 */
function gainOf(strength: number): number {
  const s = strength < 0 ? 0 : strength > 1 ? 1 : strength
  return 0.3 + 1.4 * s
}

// ---------------------------------------------------------------------------
// VHS
// ---------------------------------------------------------------------------

/**
 * VHS.
 *
 * 핵심은 glitch.chroma 다. RGB 를 통째로 뭉개면 그냥 초점 나간 그림이 되고
 * "테이프 같다" 는 인상이 전혀 안 산다. YIQ 로 바꿔 휘도는 남기고 색차만
 * 죽여야 그 특유의 번진 색이 나온다.
 *
 * 나머지는 그 위에 얹는 부수 효과다.
 *   - glitch.slice   촘촘한 슬라이스 + 작은 오프셋 = 테이프 흔들림
 *   - glitch.band    밴드 1개를 아래쪽에 두면 헤드 스위칭 노이즈가 된다
 *   - fx.scanline    아주 옅게. 진하게 넣으면 VHS 가 아니라 CRT 가 된다
 *   - fx.grain       테이프 노이즈
 *   - fx.grade       채도를 올리고 살짝 따뜻하게
 */
const vhs: EffectMacro = {
  id: 'macro.vhs',
  label: 'VHS',
  hint: '오래된 비디오테이프처럼 색이 번지고 화면이 흔들린다.',
  cost: 'mid',
  // 슬라이스가 감기고 밴드가 찢기면서 실루엣 밖으로 픽셀이 나간다.
  preservesAlpha: false,
  steps: [
    {
      type: 'glitch.chroma',
      params: { blur: 10, offset: 2.5, noise: 0.22, ghost: 0.3, ghostDist: 9 },
      scaled: ['blur', 'offset', 'noise', 'ghost'],
      seedOffset: 0,
    },
    {
      type: 'glitch.slice',
      // 슬라이스를 촘촘하게 잡고 오프셋을 작게 두면 '밀림' 이 아니라 '흔들림' 이 된다.
      params: { slices: 48, maxOffset: 4, probability: 0.55, fill: 2, axis: 0, rollCycles: 0 },
      scaled: ['maxOffset'],
      holdFrames: 1,
      seedOffset: 1,
    },
    {
      type: 'glitch.band',
      // 밴드 1개 + 위치 0.03 = 화면 아래쪽 헤드 스위칭 자국.
      params: {
        bands: 1,
        thickness: 0.07,
        offset: 0.03,
        scrollCycles: 0,
        lift: 0.45,
        tearing: 0.7,
        noise: 0.5,
      },
      scaled: ['lift', 'tearing', 'noise'],
      seedOffset: 2,
    },
    {
      type: 'fx.scanline',
      params: { height: 3, opacity: 0.14, softness: 0.7, rollCycles: 1, interlace: 0 },
      scaled: ['opacity'],
      seedOffset: 3,
    },
    {
      type: 'fx.grain',
      params: { amount: 0.11, size: 1, mono: 1, midtone: 0.6 },
      scaled: ['amount'],
      seedOffset: 4,
    },
    {
      type: 'fx.grade',
      // 세기와 무관하게 고정한다. 색 보정까지 세기에 묶으면 슬라이더 끝에서 그림이 타버린다.
      params: { exposure: 0.05, contrast: 1.06, saturation: 1.18, temperature: 0.1, tint: 0, linear: 1 },
      seedOffset: 5,
    },
  ],
}

// ---------------------------------------------------------------------------
// CRT
// ---------------------------------------------------------------------------

/**
 * CRT.
 *
 * 배럴 왜곡은 A 스테이지(변형)라 여기서 만들지 않고 참조만 한다. A 스테이지 원자가
 * 아직 없으면 optional 로 걸러지고 나머지 네 줄은 그대로 동작한다.
 *
 *   - warp.barrel    화면 가운데가 볼록한 유리
 *   - fx.aperture    적녹청 스트라이프 + 인광체 글로우
 *   - fx.scanline    인터레이스 켠 촘촘한 주사선
 *   - fx.grade       노출을 올려 마스크가 먹은 밝기를 되돌린다
 *   - fx.vignette    사각에 가까운 비네트 = 브라운관 모서리
 */
const crt: EffectMacro = {
  id: 'macro.crt',
  label: 'CRT 모니터',
  hint: '브라운관에 띄운 화면처럼 만든다. 주사선과 화소 격자가 보인다.',
  cost: 'low',
  // 어퍼처 마스크와 비네트가 색을 덮어 투명 배경에서는 의도대로 보이지 않는다.
  preservesAlpha: false,
  steps: [
    {
      // 렌즈 배럴 왜곡 원자. 레지스트리에서 id 가 바뀌면 이 한 줄만 고치면 된다.
      type: 'warp.barrel',
      params: { k: 0.12 },
      scaled: ['k'],
      optional: true,
      seedOffset: 0,
    },
    {
      type: 'fx.aperture',
      params: { pitch: 3, strength: 0.55, glow: 0.35, mode: 0 },
      scaled: ['strength'],
      seedOffset: 1,
    },
    {
      type: 'fx.scanline',
      params: { height: 2, opacity: 0.3, softness: 0.35, rollCycles: 0, interlace: 1 },
      scaled: ['opacity'],
      seedOffset: 2,
    },
    {
      type: 'fx.grade',
      params: { exposure: 0.35, contrast: 1.12, saturation: 1.1, temperature: -0.05, tint: 0, linear: 1 },
      seedOffset: 3,
    },
    {
      type: 'fx.vignette',
      // roundness 0.3 = 원보다 사각에 가깝다. 브라운관은 둥근 모서리의 사각형이다.
      params: { inner: 0.78, outer: 1.3, roundness: 0.3, feather: 0.55, color: 0x000000, opacity: 0.85 },
      scaled: ['opacity'],
      seedOffset: 4,
    },
  ],
}

// ---------------------------------------------------------------------------

export const EFFECT_MACROS: EffectMacro[] = [vhs, crt]

export const EFFECT_MACRO_BY_ID: ReadonlyMap<string, EffectMacro> = new Map(
  EFFECT_MACROS.map((m) => [m.id, m]),
)

/**
 * 매크로를 EffectInstance 배열로 펼친다.
 *
 * 반환값은 그대로 layer.effects 에 이어 붙이면 된다. 매크로였다는 흔적은 남지 않으므로
 * 사용자가 한 줄씩 지우거나 파라미터를 손대도 아무것도 깨지지 않는다.
 *
 * 스테이지 순서 정렬은 하지 않는다. 렌더러가 A -> B -> C 로 정렬하기 때문에
 * 여기서는 읽기 좋은 순서(파이프라인 순서)로 두는 것이 낫다.
 */
export function expandMacro(macro: EffectMacro, opts: MacroExpandOptions): EffectInstance[] {
  const gain = gainOf(opts.strength ?? 0.5)
  const base = (opts.baseSeed ?? 0) >>> 0
  const has = opts.has
  const out: EffectInstance[] = []

  for (let i = 0; i < macro.steps.length; i += 1) {
    const step = macro.steps[i]
    if (!step) continue
    if (step.optional && has && !has(step.type)) continue

    const scaled = step.scaled
    const params: Record<string, number> = {}
    for (const key of Object.keys(step.params)) {
      const raw = step.params[key]
      if (typeof raw !== 'number' || !Number.isFinite(raw)) continue
      const v = scaled && scaled.includes(key) ? raw * gain : raw
      params[key] = clampToSpec(step.type, key, v)
    }

    out.push({
      id: opts.makeId(),
      type: step.type,
      enabled: true,
      // 스텝마다 다른 시드를 준다. 같으면 슬라이스와 밴드가 같은 자리에서 같이 튄다.
      seed: (base + (step.seedOffset ?? i) * 0x9e3779b1) >>> 0,
      holdFrames: step.holdFrames ?? 1,
      requiresHistory: false,
      params,
    })
  }

  return out
}
