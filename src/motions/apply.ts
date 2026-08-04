/**
 * 프리셋을 문서에 앉히기 위한 순수 계산부.
 *
 * 여기서 하는 일은 "무엇을 쓸지" 를 정하는 것뿐이다. 실제로 스토어 액션을 호출하는
 * 쪽은 state/presetActions.ts 다. 둘을 나눈 이유는 두 가지다.
 *   1. 미리보기는 문서를 건드리면 안 된다. 같은 계산으로 임시 문서만 만들어야 한다.
 *   2. 이 파일은 window / document / React 를 참조하지 않는다. 테스트가 쉬워진다.
 *
 * ---------------------------------------------------------------------------
 * 통합 메모 (레지스트리 병렬 작업)
 * ---------------------------------------------------------------------------
 * motions/registry.ts 와 motions/types.ts 는 다른 담당자가 동시에 만든다. 이 파일이
 * 작성된 시점에는 EmitContext / PresetEmission 의 **정확한 필드 이름**을 컴파일 타임에
 * 확인할 수 없었다. 그래서 구조적 가정을 아래 두 어댑터에만 가둔다.
 *
 *   toEmitContext()   우리가 아는 값을 넉넉히 담아 넘긴다 (여분 필드는 무시된다)
 *   readEmission()    결과에서 tracks / modifiers / durationFrames / loop 만 읽는다
 *
 * 레지스트리 계약이 확정되면 이 두 함수의 캐스트만 지우면 된다. 나머지 코드는
 * 이 파일이 정의한 타입만 본다.
 */

import {
  FRAMES_MAX,
  GIF_EXACT_FPS,
  SPEED_MAX,
  SPEED_MIN,
  type CharAnimSpec,
  type EffectInstance,
  type Layer,
  type LoopMode,
  type Modifier,
  type MotionProject,
  type RevealSpec,
  type Track,
} from '@/core/types.ts'
import { solveLayerContain } from '@/core/overscan.ts'
import { normalizeRevealSpec } from '@/core/reveal.ts'
import { normalizeCharAnimSpec } from '@/core/charAnim.ts'
import { layerIntrinsicSize } from '@/core/shape.ts'
import type { EmitContext, MotionPreset, PresetEmission } from './types.ts'
import { MOTION_PRESET_BY_ID, applyPreset, resolveParams } from './registry.ts'
import {
  mergePresetCharAnim,
  mergePresetEffects,
  mergePresetPerspective,
  mergePresetReveal,
  mergePresetTracks,
  ownershipOf,
} from './merge.ts'

// ---------------------------------------------------------------------------
// 공개 타입
// ---------------------------------------------------------------------------

export interface PresetApplyArgs {
  doc: MotionProject
  layerId: string
  presetId: string
  /** 0 ~ 1. 진폭 축. */
  strength: number
  /** 0.5 ~ 2. 시간 축. 값이 클수록 짧아진다. */
  speed: number
  /** 프리셋 고유 파라미터 오버라이드. 생략하면 프리셋 기본값. */
  params?: Record<string, unknown>
}

export interface PresetApplyResult {
  tracks: Track[]
  modifiers: Modifier[]
  durationFrames: number
  /**
   * 속도 1 기준 재생 시간(초). PresetRef.baseSec 으로 들어간다.
   * **emit 결과가 아니라 요청한 기준선이다.** 이유는 PresetRef.baseSec 주석.
   */
  baseSec: number
  /** 속도 1 일 때의 fps. PresetRef.baseFps 로 들어간다. 속도 유도 fps 의 천장이다. */
  baseFps: number
  /**
   * 속도 때문에 확정된 fps. suggestedFps 와 물리적으로 다른 필드다.
   *
   * suggestedFps 는 "프리셋이 이 fps 를 권한다" 이고 첫 적용에서만 반영된다.
   * 사용자가 프리셋을 갈아탄다고 맞춰 둔 fps 를 덮으면 안 되기 때문이다.
   * 이쪽은 "이 속도로 이 길이를 내려면 fps 가 이만큼이어야 한다" 이고, 사용자가
   * 방금 요구한 결과 그 자체라 항상 반영한다. 같은 필드에 태우면 재적용 경로에서
   * 통째로 지워져 속도 슬라이더가 어느 지점부터 아무 일도 안 하게 된다.
   */
  forcedFps?: number
  /**
   * 이 프리셋은 일부러 프레임 밖으로 나간다 (슬라이드 등장 / 사라짐).
   * 담기 솔버가 개입하면 빠져나가야 할 그림이 가장자리에 붙어 멈춘다.
   */
  allowExit: boolean
  /**
   * 세기 최대치 기준 담기 배율. Layer.containScale 로 들어간다.
   * 담기가 필요 없는 모션이면 없다.
   */
  containScale?: number
  /**
   * 프리셋이 요구하는 글자 등장 모양. Layer.charAnim 으로 들어간다.
   */
  charAnim?: CharAnimSpec
  /**
   * 프리셋이 요구하는 가리기 모양. Layer.reveal 로 들어간다.
   *
   * 이펙트와 달리 undefined 와 "비움" 을 구별하지 않는다. 호출부가 언제나 통째로
   * 대체하므로 값이 없으면 앞 프리셋의 경계선이 지워진다 (motions/types.ts 주석).
   */
  reveal?: RevealSpec
  /** 3D 회전에 쓰는 카메라 거리. 없으면 기본값으로 되돌아간다. */
  perspective?: number
  /** 프리셋이 요구하는 반복 방식. 없으면 현재 설정을 유지한다. */
  suggestedLoop?: LoopMode
  /**
   * 프리셋이 요구하는 이펙트 스택 전체.
   *
   * **undefined 와 빈 배열은 다르다.** undefined 는 "이 프리셋은 이펙트를 정의하지
   * 않는다" 이고 레이어의 기존 스택을 그대로 둔다. 빈 배열이면 스택을 비운다.
   * A~E 와 흔들기처럼 이펙트를 안 쓰는 프리셋을 빈 배열로 바꿔 버리면, 사용자가
   * 직접 쌓아 둔 이펙트가 프리셋을 갈아탈 때마다 날아간다.
   */
  effects?: EffectInstance[]
  /**
   * 프리셋이 권장하는 fps.
   *
   * 지지직은 매 프레임 노이즈가 달라 델타 압축 효율이 0 에 수렴한다. 해상도와
   * 프레임 수만 조여도 fps 축이 빠지면 파일이 그대로 커진다. 없으면 현재 fps 를 쓴다.
   */
  suggestedFps?: number
}

/**
 * 프리셋을 갈아탈 때도 살아남는 공통 노브.
 *
 * "톡 튀기" 를 강하게/느리게 맞춰 두고 "지지직" 을 눌렀을 때 강도와 속도가 기본값으로
 * 돌아가면 사용자는 조정값을 잃는다. 반대로 프리셋 고유 파라미터(방향, 진폭 px,
 * 블록 크기 등)는 프리셋마다 의미가 달라 그대로 옮기면 엉뚱한 값이 된다.
 * 그래서 공통 노브만 화이트리스트로 통과시킨다.
 */
export const COMMON_KNOB_KEYS = ['strength', 'speed', 'loop', 'loopMode', 'repeat'] as const

const COMMON_KNOB_SET = new Set<string>(COMMON_KNOB_KEYS)

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

// ---------------------------------------------------------------------------
// 파라미터 인수인계
// ---------------------------------------------------------------------------

/**
 * 프리셋 교체 시 남길 파라미터를 고른다.
 *
 * 계약:
 *   - 같은 프리셋이면 오버라이드를 전부 유지한다 (강도만 바꾼 재적용).
 *   - 다른 프리셋이면 **공통 노브만 유지하고 나머지는 버린다.** 버린 자리는
 *     새 프리셋의 기본값(resolveParams)이 채운다.
 */
export function carryOverParams(args: {
  fromPresetId: string | null
  toPresetId: string
  params: Readonly<Record<string, unknown>>
}): Record<string, unknown> {
  if (args.fromPresetId === args.toPresetId) return { ...args.params }

  const kept: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(args.params)) {
    if (COMMON_KNOB_SET.has(key)) kept[key] = value
  }
  return kept
}

// ---------------------------------------------------------------------------
// 시드
// ---------------------------------------------------------------------------

/**
 * 결정론 시드. Math.random / Date.now 를 쓰면 같은 조작이 다른 결과를 낸다.
 * FNV-1a 32bit 로 문자열을 접는다.
 */
export function seedFor(...parts: string[]): number {
  let h = 0x811c9dc5
  for (const part of parts) {
    for (let i = 0; i < part.length; i += 1) {
      h ^= part.charCodeAt(i)
      h = Math.imul(h, 0x01000193)
    }
  }
  return h >>> 0
}

// ---------------------------------------------------------------------------
// 레지스트리 어댑터 (여기에만 구조적 가정을 가둔다)
// ---------------------------------------------------------------------------

type Loose = Record<string, unknown>

function asRecord(value: unknown): Loose {
  return typeof value === 'object' && value !== null ? (value as Loose) : {}
}

function readNumber(source: Loose, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const v = source[key]
    if (typeof v === 'number' && Number.isFinite(v)) return v
  }
  return undefined
}

const LOOP_MODES: readonly string[] = ['once', 'loop', 'pingPong', 'loopWithHold']

function readLoopMode(source: Loose, keys: readonly string[]): LoopMode | undefined {
  for (const key of keys) {
    const v = source[key]
    if (typeof v === 'string' && LOOP_MODES.includes(v)) return v as LoopMode
  }
  return undefined
}

function toEmitContext(args: {
  doc: MotionProject
  layer: Layer
  strength: number
  speed: number
  params: Record<string, number | string | boolean>
  seed: number
  /** 이 계산에서 확정한 fps. 느린 속도에서는 문서의 fps 보다 낮다. */
  fps: number
  /** 속도 1 기준 재생 시간(초). */
  baseSec: number
}): EmitContext {
  const { doc, layer } = args
  const ctx = {
    doc,
    layer,
    layerId: layer.id,
    canvas: { w: doc.canvas.w, h: doc.canvas.h },
    canvasW: doc.canvas.w,
    canvasH: doc.canvas.h,
    fps: args.fps,
    baseSec: args.baseSec,
    // baseSec 을 못 읽는 옛 호출부를 위한 폴백. resolveSpan 은 baseSec 을 먼저 본다.
    durationFrames: Math.round(args.baseSec * args.fps),
    strength: args.strength,
    speed: args.speed,
    params: args.params,
    seed: args.seed,
  }
  // 여분 필드는 무시되고 모자란 필드는 레지스트리 기본값이 채운다.
  return ctx as unknown as EmitContext
}

interface ReadEmission {
  tracks: Track[]
  modifiers: Modifier[]
  durationFrames?: number
  suggestedLoop?: LoopMode
  effects?: EffectInstance[]
  suggestedFps?: number
  reveal?: RevealSpec
  charAnim?: CharAnimSpec
  perspective?: number
}

function readEmission(emission: PresetEmission): ReadEmission {
  const e = asRecord(emission)
  const tracks = Array.isArray(e['tracks']) ? (e['tracks'] as Track[]) : []
  const modifiers = Array.isArray(e['modifiers']) ? (e['modifiers'] as Modifier[]) : []
  // 배열이 아니면(=필드가 없으면) undefined 로 남긴다. 여기서 [] 로 채우면
  // 이펙트를 안 쓰는 프리셋이 사용자의 이펙트 스택을 지우게 된다.
  const effects = Array.isArray(e['effects']) ? (e['effects'] as EffectInstance[]) : undefined
  const fps = readNumber(e, ['suggestedFps'])
  // 값 규칙은 core/reveal.ts 한 곳에만 있다. 'none' 은 가리기가 없는 것과 같다.
  const rawCharAnim = e['charAnim']
  const charAnim =
    rawCharAnim && typeof rawCharAnim === 'object'
      ? normalizeCharAnimSpec(rawCharAnim as Partial<CharAnimSpec>)
      : undefined
  const rawReveal = e['reveal']
  const reveal =
    typeof rawReveal === 'object' && rawReveal !== null
      ? normalizeRevealSpec(rawReveal as Partial<RevealSpec>)
      : undefined
  const perspective = readNumber(e, ['perspective'])
  return {
    tracks,
    modifiers,
    durationFrames: readNumber(e, ['durationFrames', 'frames']),
    suggestedLoop: readLoopMode(e, ['suggestedLoop', 'loopMode', 'loop']),
    effects,
    // 0 이하 fps 는 타임라인을 멈춘다. 읽지 않은 것과 같이 다룬다.
    ...(fps !== undefined && fps > 0 ? { suggestedFps: fps } : {}),
    ...(reveal && reveal.mode !== 'none' ? { reveal } : {}),
    ...(charAnim && charAnim.mode !== 'none' ? { charAnim } : {}),
    ...(perspective !== undefined && perspective >= 0 ? { perspective } : {}),
  }
}

/**
 * 속도 1 일 때의 재생 시간(초). 속도 노브의 기준선이다.
 *
 * resolveSpan 은 기준선을 speed 로 나눈다. 기준선으로 지금 타임라인 길이를 그대로
 * 넘기면, 그 길이가 이미 직전 적용에서 나눈 결과라서 같은 프리셋을 세 번 누를 때마다
 * 계속 짧아진다. 누를 때마다 결과가 달라지는 버튼이 된다.
 *
 * **프레임이 아니라 초로 들고 있어야 한다.** 예전에는 "지금 프레임 x 직전 속도" 로
 * 되짚었는데 두 군데서 틀렸다. 프레임은 상한 120 에 잘리므로 잘린 뒤에는 곱셈으로
 * 되돌아오지 않고(현재 120 / 직전 속도 0.1 -> 기준선이 6배 틀어진다), fps 가 바뀌면
 * 같은 프레임 수가 다른 시간을 뜻하게 된다.
 *
 * presetRef.baseSec 이 진실이다. 없으면 옛 프로젝트이거나 첫 적용이므로 지금
 * 타임라인에서 읽는다.
 */
export function baselineSec(doc: MotionProject): number {
  const stored = doc.presetRef?.baseSec
  if (typeof stored === 'number' && Number.isFinite(stored) && stored > 0) {
    return clamp(stored, MIN_BASE_SEC, MAX_BASE_SEC)
  }
  const fps = doc.timeline.fps > 0 ? doc.timeline.fps : 25
  return clamp(doc.timeline.durationFrames / fps, MIN_BASE_SEC, MAX_BASE_SEC)
}

/** 기준선의 범위. 상한은 최저 fps 로 프레임 상한을 채웠을 때의 시간이다. */
const MIN_BASE_SEC = 0.04
const MAX_BASE_SEC = FRAMES_MAX / 10

/**
 * 속도 1 일 때의 fps. 속도 유도 fps 의 천장이다.
 * 없으면 지금 문서 fps 가 곧 사용자가 고른 값이다 (첫 적용).
 */
export function baselineFps(doc: MotionProject): number {
  const stored = doc.presetRef?.baseFps
  if (typeof stored === 'number' && Number.isFinite(stored) && stored > 0) return stored
  return doc.timeline.fps > 0 ? doc.timeline.fps : 25
}

/**
 * 이 재생 시간을 프레임 상한 안에 담을 수 있는 가장 높은 fps.
 *
 * 느린 모션은 fps 를 함께 내려야 성립한다. 120프레임 상한 때문에 25fps 에서는 4.8초가
 * 최대이고, 10fps 로 내려야 12초가 된다.
 *
 * 두 가지를 지킨다.
 *   1. **올리지 않는다.** 사용자가 "느리게" 를 요구했는데 fps 가 25 에서 50 으로
 *      오르면 프레임 수와 파일 크기가 두 배가 된다.
 *   2. **GIF 에서 정확한 fps 만 고른다.** GIF 지연은 1/100초 정수라 12fps 는 실제로
 *      12.5fps 로, 30fps 는 33.3fps 로 재생된다. 자동으로 고르는 값이 어긋나면
 *      사용자가 고치지도 못한다.
 */
export function fpsForDuration(sec: number, currentFps: number): number {
  const cap = currentFps > 0 ? currentFps : 25
  let best = 0
  for (const f of GIF_EXACT_FPS) {
    if (f > cap + 1e-9) continue
    if (Math.round(sec * f) > FRAMES_MAX) continue
    if (f > best) best = f
  }
  // 어느 값으로도 안 담기면 가장 낮은 fps 를 쓴다. 길이는 상한에서 잘린다.
  if (best === 0) {
    const lowest = Math.min(...GIF_EXACT_FPS.filter((f) => f <= cap + 1e-9))
    return Number.isFinite(lowest) ? lowest : cap
  }
  return best
}

/** 프리셋이 권장하는 지속시간(ms). 레지스트리가 안 주면 1200ms 를 쓴다. */
function presetDurationMs(preset: MotionPreset): number {
  return readNumber(asRecord(preset), ['durationMs', 'defaultDurationMs', 'duration']) ?? 1200
}

// ---------------------------------------------------------------------------
// 진입점
// ---------------------------------------------------------------------------

/**
 * 프리셋 하나를 레이어에 적용했을 때 문서가 어떤 모양이 되어야 하는지 계산한다.
 * 문서를 바꾸지 않는다. 미리보기와 확정 적용이 같은 결과를 쓰게 하려면 이래야 한다.
 *
 * 파라미터 계약:
 *   params 에는 **이 프리셋 고유의 값만** 넘긴다. 강도/속도/반복은 별도 인자이며
 *   프리셋을 갈아타도 유지된다. 교체 시 params 를 걸러 내는 규칙은 carryOverParams
 *   가 정의한다. 호출자는 반드시 그 함수를 거친 params 를 넘겨야 한다.
 */
export function applyPresetToLayer(args: PresetApplyArgs): PresetApplyResult {
  const preset = MOTION_PRESET_BY_ID.get(args.presetId)
  if (!preset) throw new Error(`모르는 프리셋입니다: ${args.presetId}`)

  const layer = args.doc.layers.find((l) => l.id === args.layerId)
  if (!layer) throw new Error('적용할 레이어를 찾지 못했습니다.')

  const strength = Number.isFinite(args.strength) ? clamp(args.strength, 0, 1) : 0.5
  const speed = Number.isFinite(args.speed) ? clamp(args.speed, SPEED_MIN, SPEED_MAX) : 1

  const params = resolveParams(preset, args.params)

  /*
   * 기준선(초) -> 목표 시간(초) -> fps -> 프레임 수. 이 순서를 지켜야 한다.
   *
   * 그 프리셋의 기준선이 문서에 없으면(첫 적용이거나 다른 프리셋으로 갈아탔으면)
   * 프리셋 권장 길이를 기준선으로 삼는다. 같은 프리셋을 다시 누르면 presetRef.baseSec 이
   * 진실이라 몇 번을 눌러도 같은 결과가 나온다.
   *
   * id 를 안 보면 처음 누른 카드 하나가 이후 모든 프리셋의 길이를 지배해
   * defaultDurationMs 가 문서당 1회만 읽힌다. 4초짜리 훑기 다음에 고른 0.5초짜리
   * 튀어오름이 4초 동안 늘어진다.
   */
  const stored = args.doc.presetRef?.baseSec
  const samePreset = args.doc.presetRef?.id === args.presetId
  const hasStored = samePreset && typeof stored === 'number' && Number.isFinite(stored) && stored > 0
  const baseSec = hasStored ? baselineSec(args.doc) : presetDurationMs(preset) / 1000
  const targetSec = baseSec / speed
  // 천장은 지금 fps 가 아니라 사용자가 고른 fps 다. 지금 fps 를 천장으로 쓰면
  // 한 번 내려간 값이 영영 안 올라와 속도를 되돌려도 길이가 안 돌아온다.
  const baseFps = baselineFps(args.doc)
  const fps = fpsForDuration(targetSec, baseFps)

  const emission = applyPreset(
    preset,
    toEmitContext({
      doc: args.doc,
      layer,
      strength,
      speed,
      params,
      seed: seedFor(args.presetId, layer.id),
      fps,
      baseSec,
    }),
  )

  const read = readEmission(emission)

  // 레지스트리가 길이를 정해 주면 그대로 쓴다. 프리셋이 홀드 배수로 스냅한 결과가
  // 여기 들어오므로 그 값을 기준선으로 되먹이면 안 된다 (PresetRef.baseSec 주석).
  const derived = Math.round(targetSec * fps)
  const durationFrames = clamp(Math.round(read.durationFrames ?? derived), 2, FRAMES_MAX)

  const allowExit = preset.overscan === 'allowEmpty'
  const result: PresetApplyResult = {
    tracks: read.tracks,
    modifiers: read.modifiers,
    durationFrames,
    baseSec,
    baseFps,
    allowExit,
    suggestedLoop: read.suggestedLoop,
  }
  // 속도 때문에 fps 를 내렸으면 그 사실을 별도 채널로 싣는다. suggestedFps 는
  // 재적용에서 통째로 지워지므로 여기에 태우면 속도 슬라이더가 먹지 않는다.
  if (fps !== args.doc.timeline.fps) result.forcedFps = fps
  // 프리셋이 이펙트를 정의했을 때만 키를 만든다. undefined 를 실어 보내는 것과
  // 키 자체가 없는 것은 여기서는 같지만, 호출부가 in 연산자를 쓰게 되면 갈린다.
  if (read.effects) result.effects = read.effects
  if (read.suggestedFps !== undefined) result.suggestedFps = read.suggestedFps
  if (read.reveal) result.reveal = read.reveal
  if (read.charAnim) result.charAnim = read.charAnim
  if (read.perspective !== undefined) result.perspective = read.perspective
  if (!allowExit) {
    const reference = containReferenceScale({
      doc: args.doc,
      layer,
      preset,
      params,
      speed,
      durationFrames,
      fps,
    })
    if (reference !== undefined) result.containScale = reference
  }
  return result
}

/**
 * 담기 기준값의 하한. 이보다 작게 잡지 않는다.
 *
 * 프레임의 60% 는 스티커가 아직 스티커로 보이는 크기다. 이 아래로 내려가면 사용자는
 * 모션을 고른 것이 아니라 이미지가 줄어든 것으로 읽는다.
 */
const CONTAIN_REFERENCE_FLOOR = 0.6

/**
 * 세기를 최대로 올렸을 때도 프레임 안에 담기는 배율.
 *
 * 지금 세기로 재면 안 되는 이유는 Layer.containScale 주석에 적었다. 요약하면,
 * 매번 다시 풀면 모션의 극단이 항상 프레임에 딱 맞아 세기 슬라이더가 화면에서
 * 아무 일도 안 하는 것처럼 보인다.
 *
 * 프리셋을 세기 1.0 으로 한 번 더 emit 해서 그 결과만 담긴 임시 문서를 만들고,
 * 거기에 담기 솔버를 돌린다. 문서 스토어는 건드리지 않는다.
 */
function containReferenceScale(args: {
  doc: MotionProject
  layer: Layer
  preset: MotionPreset
  params: Record<string, number | string | boolean>
  speed: number
  durationFrames: number
  /** 이 적용에서 확정된 fps. 문서의 fps 와 다를 수 있다. */
  fps: number
}): number | undefined {
  const { doc, layer, preset, params, speed, durationFrames, fps } = args
  // 도형에는 에셋이 없다. 자연 크기는 core/shape.ts 가 한 곳에서 정한다.
  const size = layerIntrinsicSize(layer, (assetId) => {
    const found = doc.assets.find((a) => a.id === assetId)
    return found ? { width: found.naturalW, height: found.naturalH } : undefined
  })
  if (!size || size.width <= 0 || size.height <= 0) return undefined

  let emission: PresetEmission
  try {
    emission = applyPreset(
      preset,
      toEmitContext({
        doc,
        layer,
        strength: 1,
        speed,
        params,
        seed: seedFor(preset.id, layer.id),
        // 기준 배율은 이 적용에서 확정된 길이 그대로 재야 한다. 다른 fps 로 재면
        // 홀드 배수가 달라져 담기 배율이 실제와 어긋난다.
        fps,
        baseSec: (durationFrames / fps) * speed,
      }),
    )
  } catch {
    // 기준값을 못 구해도 담기 자체는 문서 기반으로 계속 돈다. 조용히 포기한다.
    return undefined
  }

  const read = readEmission(emission)
  const probeLayer: Layer = {
    ...layer,
    tracks: read.tracks,
    modifiers: read.modifiers,
    // 부모 상속까지 재현할 필요는 없다. 기준값은 이 레이어 자신의 모션 크기다.
    parentId: null,
    fillsCanvas: false,
    keepInside: true,
    motionExitsFrame: false,
  }
  const probeDoc: MotionProject = {
    ...doc,
    layers: [probeLayer],
    timeline: { ...doc.timeline, durationFrames, fps },
  }

  const need = solveLayerContain(probeDoc, probeLayer, size.width, size.height)
  if (need.correction >= 1) return undefined
  // 하한 아래로는 기준값을 쓰지 않는다. 세기를 끝까지 올려야 성립하는 프리셋(한 점으로
  // 파고드는 사진 훑기 같은 것)은 기준값이 33% 까지 내려가는데, 그러면 세기를 낮춰
  // 써도 스티커가 프레임 구석에 조그맣게 남는다. 하한에 걸리면 문서 기반 계산이
  // 대신 잡으므로 잘림은 그대로 막힌다. 대신 그 프리셋에서는 세기를 올릴 때
  // 그림이 조금 더 작아진다.
  return Math.max(CONTAIN_REFERENCE_FLOOR, need.correction)
}

/**
 * 권장 fps 까지 반영한 계산.
 *
 * allowFps 는 "이번 적용이 fps 를 바꿔도 되는가" 다. 반복 모드와 같은 규칙으로
 * **첫 적용에서만** true 다. 프리셋을 갈아탄다고 사용자가 맞춰 둔 fps 를 덮으면
 * 조정값을 날린다.
 *
 * fps 가 바뀌면 프리셋이 프레임으로 환산해 둔 값들(폭발 사건 구간 80ms, 점멸 상한)이
 * 달라진다. 그래서 바뀐 타임라인으로 한 번 더 계산한다. 한 번만 계산하고 fps 만 내리면
 * 25fps 로 잰 구간이 20fps 타임라인에 얹혀 사건이 길어진다.
 */
export function applyPresetWithFps(args: PresetApplyArgs, allowFps: boolean): PresetApplyResult {
  const first = applyPresetToLayer(args)
  const wanted = first.suggestedFps
  if (!allowFps || wanted === undefined || wanted === args.doc.timeline.fps) {
    // forcedFps 는 지우지 않는다. 그쪽은 사용자가 방금 고른 속도의 결과다.
    if (!allowFps) delete first.suggestedFps
    return first
  }

  const doc: MotionProject = {
    ...args.doc,
    timeline: { ...args.doc.timeline, fps: wanted },
  }
  const second = applyPresetToLayer({ ...args, doc })
  second.suggestedFps = wanted
  return second
}

/**
 * 이 적용이 문서에 심을 최종 fps.
 *
 * 권한이 둘이라 우선순위를 한 곳에서 정한다. 프리셋 권장 fps 는 용량 통제이고
 * 속도 유도 fps 는 길이 확보라, **둘 중 낮은 쪽**을 쓰면 두 요구가 모두 지켜진다.
 */
export function finalFps(result: PresetApplyResult, currentFps: number): number {
  const candidates = [result.forcedFps, result.suggestedFps].filter(
    (f): f is number => typeof f === 'number' && f > 0,
  )
  if (candidates.length === 0) return currentFps
  return Math.min(...candidates)
}

// ---------------------------------------------------------------------------
// 임시 문서 만들기 (호버 미리보기 / 카드 썸네일)
// ---------------------------------------------------------------------------

/**
 * 계산 결과를 문서 스냅샷에 얹는다. 원본은 건드리지 않는다.
 *
 * 병합 규칙은 motions/merge.ts 한 곳에만 있다. document.ts 의 applyPresetTracks 와
 * **같은 헬퍼를 써야** 호버 미리보기와 확정 적용이 같은 그림을 낸다. 여기서 규칙을
 * 다시 적으면 다시 갈라진다 (merge.ts 상단 주석).
 */
export function withPresetApplied(
  doc: MotionProject,
  layerId: string,
  result: PresetApplyResult,
): MotionProject {
  const owned = ownershipOf(doc.presetRef)
  const layers = doc.layers.map((layer) =>
    layer.id === layerId
      ? {
          ...layer,
          tracks: mergePresetTracks(layer.tracks, result.tracks, owned),
          modifiers: result.modifiers,
          effects: mergePresetEffects(layer.effects, result.effects, owned),
          // 담기 솔버가 미리보기와 확정 적용에서 같은 판단을 하도록 여기서도 심는다.
          // 빠뜨리면 슬라이드 사라짐이 호버 때만 가장자리에서 멈추고, 세기에 따라
          // 그림 크기가 미리보기에서만 달라진다.
          motionExitsFrame: result.allowExit,
          containScale: result.containScale,
          /*
           * 가리기와 원근도 미리보기에서 그대로 보여야 한다. 빼면 호버에서는
           * 경계선 없이 열려 있다가 클릭하는 순간 갑자기 잘린 그림이 나온다.
           * 소유권 규칙도 확정 적용과 **같은 헬퍼**를 써야 두 결과가 갈리지 않는다.
           */
          reveal: mergePresetReveal(layer.reveal, result.reveal, owned),
          charAnim: mergePresetCharAnim(layer.charAnim, result.charAnim, owned),
          perspective: mergePresetPerspective(layer.perspective, result.perspective, owned),
        }
      : layer,
  )

  const loop = result.suggestedLoop
    ? { ...doc.timeline.loop, mode: result.suggestedLoop }
    : doc.timeline.loop

  return {
    ...doc,
    layers,
    timeline: {
      ...doc.timeline,
      durationFrames: result.durationFrames,
      // 확정 적용이 fps 를 내리면 미리보기도 같은 fps 로 보여 줘야 한다.
      // 규칙은 finalFps 한 곳에만 둔다. 여기서 따로 고르면 호버와 클릭이 갈린다.
      fps: finalFps(result, doc.timeline.fps),
      loop,
    },
    // 기준선도 함께 얹어야 미리보기에서 속도를 두 번 바꿔도 길이가 흘러가지 않는다.
    presetRef: doc.presetRef
      ? { ...doc.presetRef, baseSec: result.baseSec, baseFps: result.baseFps }
      : doc.presetRef,
  }
}

/**
 * 호버 미리보기와 카드 썸네일이 쓰는 임시 문서.
 * 문서 스토어를 거치지 않으므로 undo 스택이 오염되지 않는다.
 */
export function buildPreviewDoc(args: PresetApplyArgs, allowFps = true): MotionProject {
  return withPresetApplied(args.doc, args.layerId, applyPresetWithFps(args, allowFps))
}
