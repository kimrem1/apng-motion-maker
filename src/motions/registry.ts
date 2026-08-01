/**
 * 모션 프리셋 레지스트리.
 *
 * 카탈로그는 아홉 카테고리 56종이다.
 *   A 등장 6 / B 사라짐 4 / C 계속 움직이기 10 / D 시선 끌기 10 / E 사진 훑기 4
 *   F 흔들기 6 / G 자글자글 4 / H 지지직 8 / I 조합 4
 * A 와 B 의 마지막 한 종씩(combo.popGlitchIn, combo.slideFadeGlitch)은 만드는 방식이
 * 조합이라 presets/combo.ts 에 있지만 카테고리는 표대로 등장 / 사라짐이다.
 *
 * 이 파일이 UI 와 만나는 유일한 면이다. UI 는 여기 있는 label / hint / params 만 읽고
 * 내부 id 와 loopSafe 값은 어떤 형태로도 화면에 내보내지 않는다.
 */

import { SPEED_MAX, SPEED_MIN } from '@/core/types.ts'
import type {
  EmitContext,
  MotionCategory,
  MotionPreset,
  ParamSpec,
  PresetEmission,
} from './types.ts'
import { APPEAR_PRESETS } from './presets/appear.ts'
import { DISAPPEAR_PRESETS } from './presets/disappear.ts'
import { MOVE_PRESETS } from './presets/move.ts'
import { ATTENTION_PRESETS } from './presets/attention.ts'
import { KENBURNS_PRESETS } from './presets/kenburns.ts'
import { SHAKE_PRESETS } from './presets/shake.ts'
import { BOIL_PRESETS } from './presets/boil.ts'
import { GLITCH_PRESETS } from './presets/glitch.ts'
import { COMBO_PRESETS } from './presets/combo.ts'
import { REVEAL_PRESETS } from './presets/reveal.ts'
import { clamp, clamp01 } from './presets/shared.ts'

/**
 * 사용자에게 보이는 의도 기반 분류.
 *
 * 이름은 전부 "무엇을 하고 싶은가" 다. 속성 이름(스케일, 이동, 회전)도 기술 용어
 * (켄번즈, 패럴랙스, 글리치)도 쓰지 않는다. 사용자는 "지지직거리게 하고 싶다" 를 찾지
 * "글리치 카테고리" 를 찾지 않는다.
 */
export const CATEGORY_LABELS: Record<MotionCategory, string> = {
  appear: '등장',
  disappear: '사라짐',
  move: '계속 움직이기',
  attention: '시선 끌기',
  kenburns: '사진 훑기',
  shake: '흔들기',
  boil: '자글자글',
  glitch: '지지직',
  combo: '조합',
}

/**
 * 갤러리 탭 순서. 처음 만드는 사람이 찾는 순서대로 둔다.
 *
 * 등장 -> 계속 움직이기 -> 시선 끌기 까지가 첫 결과물을 만드는 최단 경로다.
 * 흔들기 / 자글자글 / 지지직은 "이미 움직이는 것에 질감을 더하는" 단계라 그 뒤에 온다.
 * 조합은 여러 개를 한 번에 얹는 것이라 마지막 직전이고, 사라짐은 마무리라 끝이다.
 */
export const CATEGORY_ORDER: MotionCategory[] = [
  'appear',
  'move',
  'attention',
  'shake',
  'boil',
  'glitch',
  'kenburns',
  'combo',
  'disappear',
]

export const MOTION_PRESETS: MotionPreset[] = [
  ...APPEAR_PRESETS,
  ...DISAPPEAR_PRESETS,
  ...MOVE_PRESETS,
  ...ATTENTION_PRESETS,
  ...KENBURNS_PRESETS,
  ...SHAKE_PRESETS,
  ...BOIL_PRESETS,
  ...GLITCH_PRESETS,
  ...COMBO_PRESETS,
  ...REVEAL_PRESETS,
]

export const MOTION_PRESET_BY_ID: ReadonlyMap<string, MotionPreset> = new Map(
  MOTION_PRESETS.map((preset) => [preset.id, preset]),
)

/** 카테고리에 속한 프리셋. 정의 순서를 그대로 유지한다. */
export function byCategory(category: MotionCategory): MotionPreset[] {
  return MOTION_PRESETS.filter((preset) => preset.category === category)
}

/** EASY 모드 기본 노출. 나머지는 "변형 더 보기"로 접는다. */
export const EASY_PRESETS: MotionPreset[] = MOTION_PRESETS.filter((preset) => preset.easy)

/** PRO 모드 필터용 속성 태그 목록. */
export const MOTION_TAGS: string[] = [
  ...new Set(MOTION_PRESETS.flatMap((preset) => preset.tags)),
].sort()

// ---------------------------------------------------------------------------
// 파라미터
// ---------------------------------------------------------------------------

/** 저장된 프로젝트에서 온 값은 무엇이든 들어올 수 있다. 타입까지 여기서 걸러낸다. */
function coerce(spec: ParamSpec, raw: unknown): number | string | boolean {
  if (raw === undefined) return spec.default
  switch (spec.type) {
    case 'number': {
      if (typeof raw !== 'number' || !Number.isFinite(raw)) return spec.default
      const lo = spec.min ?? Number.NEGATIVE_INFINITY
      const hi = spec.max ?? Number.POSITIVE_INFINITY
      return clamp(raw, lo, hi)
    }
    case 'boolean':
      return typeof raw === 'boolean' ? raw : spec.default
    case 'select':
    default: {
      if (typeof raw !== 'string') return spec.default
      const options = spec.options ?? []
      return options.some((o) => o.value === raw) ? raw : spec.default
    }
  }
}

/**
 * 기본값을 채우고 범위를 넘은 값을 잘라낸다.
 * 프리셋을 교체해도 공통 노브(속도/세기/반복)는 유지하고 고유 파라미터만 리셋하는
 * 규칙은 호출부에서 이 함수에 무엇을 넘길지로 표현한다.
 */
export function resolveParams(
  preset: MotionPreset,
  overrides: Record<string, unknown> = {},
): Record<string, number | string | boolean> {
  const out: Record<string, number | string | boolean> = {}
  for (const spec of preset.params) {
    out[spec.key] = coerce(spec, overrides[spec.key])
  }
  return out
}

/** 기본 컨텍스트. durationFrames 0 은 "프리셋 기본 지속시간을 쓰라"는 뜻이다. */
export function createEmitContext(overrides: Partial<EmitContext> = {}): EmitContext {
  return {
    durationFrames: 0,
    fps: 25,
    canvasW: 512,
    canvasH: 512,
    strength: 0.5,
    speed: 1,
    params: {},
    seed: 1,
    layerCount: 1,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// 적용
// ---------------------------------------------------------------------------

/**
 * 프리셋을 실제 트랙으로 바꾼다.
 * 세기와 속도를 범위 안으로 자르고 파라미터 기본값을 채운 뒤 emit 을 부른다.
 * emit 은 순수 함수라서 같은 입력이면 항상 같은 트랙이 나온다.
 */
export function applyPreset(preset: MotionPreset, ctx: EmitContext): PresetEmission {
  const safe: EmitContext = {
    ...ctx,
    strength: clamp01(Number.isFinite(ctx.strength) ? ctx.strength : 0.5),
    speed: clamp(Number.isFinite(ctx.speed) && ctx.speed > 0 ? ctx.speed : 1, SPEED_MIN, SPEED_MAX),
    fps: ctx.fps > 0 ? ctx.fps : 25,
    durationFrames: Number.isFinite(ctx.durationFrames) ? Math.max(0, Math.round(ctx.durationFrames)) : 0,
    params: resolveParams(preset, ctx.params),
  }
  return preset.emit(safe)
}
