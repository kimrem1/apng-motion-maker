/**
 * I. 조합. 6종.
 *
 * 순수 조합 4종에 등장 / 사라짐 계열의 지지직 조합 2종(combo.popGlitchIn,
 * combo.slideFadeGlitch)을 더한 것이다. 그 둘은 이펙트가 있어야 성립한다.
 *
 * ---------------------------------------------------------------------------
 * 규칙 하나: 조합은 새 로직을 만들지 않는다
 * ---------------------------------------------------------------------------
 * 조합 프리셋은 **기존 프리셋 id + params 오버라이드 + weight** 리스트로만 정의한다.
 * 여기서 새 곡선이나 새 생성기를 만들면 두 가지를 잃는다.
 *   1. "지금 화면 상태를 내 프리셋으로 저장" 이 공짜로 따라오지 않는다. 사용자가 만든
 *      조합과 우리가 만든 조합이 다른 자료구조가 되기 때문이다.
 *   2. 부품 프리셋을 고치면 조합이 조용히 갈라진다.
 *
 * weight 는 **세기 축에만** 작용한다. 트랙 값을 직접 곱하면 안 된다. 예를 들어
 * translateX 가 -6 에서 +6 을 오가는 트랙에 0.5 를 곱하는 방법은 정의되지 않는다.
 * 첫 키 기준으로 줄이면 중심이 -3 으로 밀리고, 0 기준으로 줄이면 다른 트랙과 규칙이
 * 달라진다. 세기 슬라이더는 이미 모든 프리셋이 진폭 축으로만 해석하기로 약속한 값이라
 * 거기에 태우는 것이 유일하게 일관된 방법이다.
 *
 * ---------------------------------------------------------------------------
 * 순환 참조 주의
 * ---------------------------------------------------------------------------
 * registry.ts 가 이 파일을 읽으므로 이 파일은 registry.ts 를 읽지 않는다.
 * 부품은 프리셋 배열에서 직접 가져와 자체 맵을 만든다. registry 의 resolveParams 를
 * 쓰면 편하지만, 이 파일이 먼저 평가되는 경로(테스트가 combo.ts 를 직접 import)에서
 * registry 의 const 초기화가 TDZ 에 걸려 터진다.
 */

import type { EffectInstance, Modifier, Track, TrackProp } from '@/core/types.ts'
import type {
  EmitContext,
  LoopSafety,
  MotionCategory,
  MotionPreset,
  OverscanPolicy,
  ParamSpec,
  PresetEmission,
  PresetNotice,
  SizeClass,
} from '@/motions/types.ts'
import { APPEAR_PRESETS } from './appear.ts'
import { DISAPPEAR_PRESETS } from './disappear.ts'
import { MOVE_PRESETS } from './move.ts'
import { ATTENTION_PRESETS } from './attention.ts'
import { KENBURNS_PRESETS } from './kenburns.ts'
import { SHAKE_PRESETS, snapToHold } from './shake.ts'
import { BOIL_PRESETS } from './boil.ts'
import { GLITCH_PRESETS } from './glitch.ts'
import { clamp, clamp01, emitDuration, loopFor, num, resolveSpan, type ParamBag } from './shared.ts'

// ---------------------------------------------------------------------------
// 부품 조회
// ---------------------------------------------------------------------------

const PART_PRESETS: MotionPreset[] = [
  ...APPEAR_PRESETS,
  ...DISAPPEAR_PRESETS,
  ...MOVE_PRESETS,
  ...ATTENTION_PRESETS,
  ...KENBURNS_PRESETS,
  ...SHAKE_PRESETS,
  ...BOIL_PRESETS,
  ...GLITCH_PRESETS,
]

const PART_BY_ID: ReadonlyMap<string, MotionPreset> = new Map(PART_PRESETS.map((p) => [p.id, p]))

/** 조합이 참조하는 부품 id 전부. 테스트가 이 목록으로 오타를 잡는다. */
export function comboPartIds(): string[] {
  return [...new Set(COMBO_DEFS.flatMap((def) => def.parts.map((p) => p.presetId)))]
}

// ---------------------------------------------------------------------------
// 파라미터 정리 (registry.resolveParams 의 국소 사본)
// ---------------------------------------------------------------------------

function coerceLocal(spec: ParamSpec, raw: number | string | boolean | undefined): number | string | boolean {
  if (raw === undefined) return spec.default
  switch (spec.type) {
    case 'number': {
      if (typeof raw !== 'number' || !Number.isFinite(raw)) return spec.default
      return clamp(raw, spec.min ?? Number.NEGATIVE_INFINITY, spec.max ?? Number.POSITIVE_INFINITY)
    }
    case 'boolean':
      return typeof raw === 'boolean' ? raw : spec.default
    case 'select':
    default: {
      if (typeof raw !== 'string') return spec.default
      return (spec.options ?? []).some((o) => o.value === raw) ? raw : spec.default
    }
  }
}

function resolveLocalParams(preset: MotionPreset, overrides: ParamBag): ParamBag {
  const out: ParamBag = {}
  for (const spec of preset.params) out[spec.key] = coerceLocal(spec, overrides[spec.key])
  return out
}

// ---------------------------------------------------------------------------
// 홀드 정렬
// ---------------------------------------------------------------------------

function gcd(a: number, b: number): number {
  let x = Math.abs(Math.round(a))
  let y = Math.abs(Math.round(b))
  while (y > 0) {
    const t = x % y
    x = y
    y = t
  }
  return x || 1
}

/**
 * 부품들의 홀드 최소공배수.
 *
 * 부품마다 지속 프레임을 자기 홀드의 배수로 스냅한다. 조합이 그 배수를 미리 맞춰
 * 넘기지 않으면 부품 A 는 30프레임, 부품 B 는 32프레임을 쓰겠다고 답하고, 둘 중
 * 무엇을 택해도 다른 하나의 마지막 홀드 블록이 잘린다.
 */
function partHoldLcm(parts: readonly ComboPart[]): number {
  let out = 1
  for (const part of parts) {
    const hold = PART_BY_ID.get(part.presetId)?.noiseHoldFrames ?? 1
    out = Math.abs(out * hold) / gcd(out, hold)
  }
  return Math.max(1, Math.round(out))
}

// ---------------------------------------------------------------------------
// 조합 정의
// ---------------------------------------------------------------------------

interface ComboPart {
  presetId: string
  /**
   * 0 ~ 2. 이 부품에 넘길 세기 배수.
   * 1 이면 그 프리셋을 단독으로 적용한 것과 같다. 0 이면 부품을 아예 뺀다.
   */
  weight: number
  params?: ParamBag
}

interface ComboDef {
  id: string
  label: string
  hint: string
  category: MotionCategory
  tags: string[]
  loopSafe: LoopSafety
  overscan: OverscanPolicy
  easy: boolean
  size: SizeClass
  defaultDurationMs: number
  recommendedFps?: number
  /** 첫 부품이 기준(base)이다. 나머지는 섞는 정도 노브의 영향을 받는다. */
  parts: ComboPart[]
  /** 조합 자체가 추가로 알려야 하는 사실 */
  notices?: PresetNotice[]
}

const COMBO_DEFS: ComboDef[] = [
  {
    id: 'combo.zoomShake',
    label: '줌 + 흔들림',
    hint: '천천히 다가가면서 화면이 함께 흔들린다.',
    category: 'combo',
    tags: ['scale', 'shake'],
    loopSafe: 'pingPongOnly',
    overscan: 'required',
    easy: true,
    size: 'normal',
    defaultDurationMs: 3000,
    parts: [
      { presetId: 'zoom.slowIn', weight: 1, params: { amount: 18 } },
      { presetId: 'shake.camera', weight: 0.5, params: { amount: 4, cycles: 3 } },
    ],
  },
  {
    id: 'combo.driftSway',
    label: '잔잔한 흐름',
    hint: '좌우로 천천히 흐르면서 고개를 갸웃하고 숨을 쉰다.',
    category: 'combo',
    tags: ['move', 'rotate', 'shake'],
    loopSafe: 'seamless',
    overscan: 'required',
    easy: false,
    size: 'normal',
    defaultDurationMs: 4000,
    parts: [
      { presetId: 'slide.panLR', weight: 1, params: { distance: 5, cycles: 1 } },
      { presetId: 'rotate.sway', weight: 0.4, params: { angle: 3, cycles: 1 } },
      { presetId: 'shake.breathe', weight: 0.3 },
    ],
  },
  {
    id: 'combo.punchRgb',
    label: '비트 펀치',
    hint: '한 번 확 커지면서 색이 어긋났다 제자리로 돌아온다.',
    category: 'combo',
    tags: ['scale', 'glitch'],
    loopSafe: 'once',
    overscan: 'auto',
    easy: false,
    size: 'normal',
    defaultDurationMs: 600,
    recommendedFps: 20,
    parts: [
      { presetId: 'zoom.punch', weight: 1, params: { peak: 18, settle: 4 } },
      { presetId: 'glitch.rgbShift', weight: 0.8, params: { amount: 8, cycles: 1 } },
    ],
  },
  {
    id: 'combo.kbGrain',
    label: '필름 훑기',
    hint: '사진을 천천히 훑으면서 필름처럼 잘게 떤다.',
    category: 'combo',
    tags: ['kenburns', 'shake'],
    loopSafe: 'pingPongOnly',
    overscan: 'required',
    easy: false,
    size: 'normal',
    defaultDurationMs: 4000,
    parts: [
      { presetId: 'kb.classic', weight: 1 },
      { presetId: 'shake.jitter', weight: 0.25, params: { amount: 1.5, hold: 2 } },
    ],
    notices: [
      {
        code: 'needsEffect',
        message: '필름 입자는 이펙트 스택의 입자 효과가 맡습니다. 떨림과 같은 박자로 맞춰집니다.',
      },
    ],
  },
  {
    // 등장 계열이라 카테고리는 등장이다. 만드는 방식만 조합이다.
    id: 'combo.popGlitchIn',
    label: '지지직 등장',
    hint: '톡 튀어 나오면서 처음 순간에만 화면이 깨진다.',
    category: 'appear',
    tags: ['scale', 'fade', 'glitch'],
    loopSafe: 'once',
    overscan: 'required',
    easy: false,
    size: 'normal',
    defaultDurationMs: 600,
    recommendedFps: 20,
    parts: [
      { presetId: 'zoom.pop', weight: 1, params: { from: 0.86, fade: true } },
      { presetId: 'glitch.block', weight: 0.8, params: { block: 24, density: 6, jitter: 12 } },
    ],
  },
  {
    // 사라짐 계열이다.
    id: 'combo.slideFadeGlitch',
    label: '지지직 사라지기',
    hint: '밀려나며 사라지는 동안 화면이 조각조각 밀린다.',
    category: 'disappear',
    tags: ['move', 'fade', 'glitch'],
    loopSafe: 'once',
    overscan: 'allowEmpty',
    easy: false,
    size: 'normal',
    defaultDurationMs: 800,
    recommendedFps: 20,
    parts: [
      { presetId: 'slide.outFade', weight: 1 },
      { presetId: 'glitch.slice', weight: 0.8, params: { slices: 12, amount: 20, density: 40 } },
    ],
  },
]

// ---------------------------------------------------------------------------
// 조합 -> MotionPreset
// ---------------------------------------------------------------------------

const MIX_PARAM: ParamSpec = {
  key: 'mix',
  label: '섞는 정도',
  type: 'number',
  min: 0,
  max: 150,
  step: 5,
  unit: '%',
  default: 100,
}

function buildCombo(def: ComboDef): MotionPreset {
  const preset: MotionPreset = {
    id: def.id,
    label: def.label,
    hint: def.hint,
    category: def.category,
    tags: def.tags,
    loopSafe: def.loopSafe,
    overscan: def.overscan,
    easy: def.easy,
    size: def.size,
    defaultDurationMs: def.defaultDurationMs,
    params: [MIX_PARAM],
    emit(ctx: EmitContext): PresetEmission {
      // 부품 전부가 같은 길이를 쓰도록 홀드 배수에 미리 올린다.
      const span = snapToHold(resolveSpan(ctx, def.defaultDurationMs), partHoldLcm(def.parts))
      const mix = clamp(num(ctx.params, 'mix', 100), 0, 150) / 100

      // prop 이 겹치면 앞 부품이 이긴다. 기준 부품의 움직임이 보조에 덮이면
      // 사용자가 고른 이름과 화면이 어긋난다.
      const byProp = new Map<TrackProp, Track>()
      const modifiers: Modifier[] = []
      const effects: EffectInstance[] = []
      const notices: PresetNotice[] = []
      const seen = new Set<string>()
      let duration = span
      let fps: number | undefined
      /*
       * 부품이 하나라도 이펙트 스택을 정의했는가.
       *
       * 이 구분이 없으면 이펙트를 안 쓰는 조합(줌 + 흔들림)이 빈 배열을 내고,
       * 그 순간 사용자가 직접 쌓아 둔 이펙트가 통째로 날아간다. 아무도 정의하지
       * 않았으면 effects 필드를 아예 내지 않는다 (motions/types.ts 의 계약).
       */
      let definesEffects = false

      const push = (notice: PresetNotice): void => {
        const key = `${notice.code}|${notice.message}`
        if (seen.has(key)) return
        seen.add(key)
        notices.push(notice)
      }

      def.parts.forEach((part, index) => {
        const partPreset = PART_BY_ID.get(part.presetId)
        if (!partPreset) return

        // 기준 부품은 섞는 정도의 영향을 받지 않는다. 0% 로 내려도 기준은 남는다.
        const weight = index === 0 ? part.weight : part.weight * mix
        if (weight <= 0) return

        const sub = partPreset.emit({
          durationFrames: span,
          fps: ctx.fps,
          canvasW: ctx.canvasW,
          canvasH: ctx.canvasH,
          // weight 는 세기 축에만 태운다 (파일 상단 주석).
          strength: clamp01(ctx.strength * weight),
          // 시간 축은 조합이 이미 적용했다. 여기서 또 나누면 두 번 빨라진다.
          speed: 1,
          params: resolveLocalParams(partPreset, part.params ?? {}),
          seed: ctx.seed,
          layerCount: ctx.layerCount ?? 1,
        })

        for (const t of sub.tracks) {
          if (!byProp.has(t.prop)) byProp.set(t.prop, t)
        }
        for (const m of sub.modifiers ?? []) {
          // 부품끼리 id 가 겹치면 생성기가 같은 노이즈를 두 번 뽑는다.
          modifiers.push({ ...m, id: `c${index}.${m.id}` })
        }
        if (sub.effects) {
          definesEffects = true
          for (const e of sub.effects) {
            // 이펙트도 마찬가지다. id 가 겹치면 문서에 심을 때 하나가 사라진다.
            effects.push({ ...e, id: `c${index}.${e.id}` })
          }
        }
        for (const notice of sub.notices ?? []) {
          // 길이는 조합이 이미 맞췄다. 부품이 낸 길이 안내는 사용자에게 소음이다.
          if (notice.code === 'durationSnapped') continue
          push(notice)
        }
        if (sub.suggestedFps !== undefined) {
          fps = fps === undefined ? sub.suggestedFps : Math.min(fps, sub.suggestedFps)
        }
        duration = Math.max(duration, sub.durationFrames)
      })

      for (const notice of def.notices ?? []) push(notice)

      const tracks = [...byProp.values()]
      const result: PresetEmission = {
        tracks,
        modifiers,
        durationFrames: emitDuration(duration, tracks),
        suggestedLoop: loopFor(def.loopSafe),
        notices,
      }
      if (fps !== undefined) result.suggestedFps = fps
      if (definesEffects) result.effects = effects
      return result
    },
  }

  if (def.recommendedFps !== undefined) preset.recommendedFps = def.recommendedFps

  // 카드 배지용 사본은 부품에서 자동으로 물려받는다. 손으로 적으면 부품을 갈아끼울 때
  // 조용히 어긋나고, 그러면 점멸이 있는 조합에 점멸 주의 배지가 안 뜬다.
  // emit 이 부품의 안내를 그대로 올려 보내는 것과 같은 규칙이다.
  const parts = def.parts.map((p) => PART_BY_ID.get(p.presetId))
  if (parts.some((p) => p?.flashWarning)) preset.flashWarning = true
  if (parts.some((p) => p?.largeSource)) preset.largeSource = true
  return preset
}

export const COMBO_PRESETS: MotionPreset[] = COMBO_DEFS.map(buildCombo)
