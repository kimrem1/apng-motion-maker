/**
 * 프리셋 구현이 공유하는 순수 헬퍼.
 *
 * 여기서 하는 일은 네 가지뿐이다.
 *   1. EASY 의 강도/속도 슬라이더를 진폭과 프레임 수로 옮긴다.
 *   2. 이징 프리셋 id 를 키프레임 핸들로 옮긴다 (curve.ts 의 evalSegment 규약).
 *   3. 프레임을 정수 격자에 올리고 오름차순을 보장한다.
 *   4. Ken Burns 의 뷰포트 rect 를 트랙 값으로 바꾼다.
 *
 * 새 보간 로직은 만들지 않는다. Math.random / Date.now 도 쓰지 않는다.
 */

import {
  FRAMES_MAX,
  SPEED_MAX,
  SPEED_MIN,
  type EffectInstance,
  type EffectParam,
  type Handle,
  type Interp,
  type Keyframe,
  type LoopMode,
  type SpringSpec,
  type Track,
  type TrackProp,
  type TrackUnit,
} from '@/core/types.ts'
import { hashSeed } from '@/core/rng.ts'
import { DEFAULT_IN, DEFAULT_OUT } from '@/easing/curve.ts'
import { EASING_PRESET_BY_ID } from '@/easing/presets.ts'
import type { EmitContext, LoopSafety, PresetNotice } from '@/motions/types.ts'

// ---------------------------------------------------------------------------
// 수치 유틸
// ---------------------------------------------------------------------------

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

export function clamp01(v: number): number {
  return clamp(v, 0, 1)
}

/**
 * 세기 슬라이더를 진폭 배수로 옮긴다.
 * 0.5 가 기본값이라 그 지점에서 정확히 1.0 이 나와야 표의 기본값과 일치한다.
 */
export function gainOf(strength: number): number {
  return 0.3 + 1.4 * clamp01(strength)
}

/**
 * 이 프리셋이 쓸 프레임 수.
 *
 * **시간으로 계산하고 마지막에만 프레임으로 바꾼다.** 느린 속도에서는 fps 도 함께
 * 내려가는데, 프레임 수를 그와 별개로 계산하면 두 값이 갈라진다. 실제로 갈라뒀을 때
 * 속도를 1 -> 0.1 -> 1 로 왕복하면 길이가 5배 줄었다.
 *
 * 속도는 진폭이 아니라 시간에만 작용한다.
 */
export function resolveSpan(ctx: EmitContext, defaultMs: number): number {
  const fps = ctx.fps > 0 ? ctx.fps : 25
  const speed = clamp(ctx.speed > 0 ? ctx.speed : 1, SPEED_MIN, SPEED_MAX)
  const baseSec =
    ctx.baseSec !== undefined && ctx.baseSec > 0
      ? ctx.baseSec
      : ctx.durationFrames > 0
        ? ctx.durationFrames / fps
        : defaultMs / 1000
  return clamp(Math.round((baseSec / speed) * fps), 2, FRAMES_MAX)
}

/**
 * 마지막 키를 놓을 프레임.
 * 이음새 없는 루프는 한 주기가 span 프레임이므로 끝 키가 span 에 온다.
 * 출력 프레임은 0..span-1 이라 값이 중복되지 않는다.
 * 그 외에는 마지막 출력 프레임인 span-1 에서 모션이 끝나야 한다.
 */
export function lastFrame(span: number, loopSafe: LoopSafety): number {
  return loopSafe === 'seamless' ? span : Math.max(1, span - 1)
}

/** 반복 안전성에서 어울리는 반복 모드를 고른다. */
export function loopFor(loopSafe: LoopSafety): LoopMode {
  if (loopSafe === 'seamless') return 'loop'
  if (loopSafe === 'pingPongOnly') return 'pingPong'
  return 'once'
}

/** [0, span] 을 n 등분한 정수 프레임 목록 (길이 n+1). 반드시 오름차순이다. */
export function spread(span: number, n: number): number[] {
  const count = Math.max(1, Math.round(n))
  const out: number[] = []
  for (let i = 0; i <= count; i += 1) {
    const f = Math.round((span * i) / count)
    const prev = out[out.length - 1]
    out.push(prev === undefined || f > prev ? f : prev + 1)
  }
  return out
}

/**
 * 주기 수를 프레임 예산에 맞춘다.
 * 한 세그먼트가 minSegFrames 프레임보다 짧아지면 정수 프레임 격자에서 뭉개져
 * 사인이 사인으로 보이지 않는다. 표의 기본 주기보다 낮춰야 하는 경우가 생긴다.
 */
export function limitCycles(
  span: number,
  cycles: number,
  segmentsPerCycle: number,
  minSegFrames = 1,
): number {
  const maxSegments = Math.floor(span / Math.max(1, minSegFrames))
  const maxCycles = Math.floor(maxSegments / segmentsPerCycle)
  return Math.max(1, Math.min(Math.round(cycles), Math.max(1, maxCycles)))
}

// ---------------------------------------------------------------------------
// 점멸 상한 (WCAG 2.3.1)
// ---------------------------------------------------------------------------

/**
 * 점멸 횟수 상한 (WCAG 2.3.1 일반 섬광 임계값).
 *
 * 초당 3회 이상 번쩍이면 광과민성 발작 위험이 있다. 사용자가 세게 올려도 그 선을
 * 넘기지 않는다. 경고만 띄우고 통과시키면 경고가 아니라 알리바이다.
 *
 * 여기는 지지직만의 규칙이 아니다. 깜빡임(fade.flicker)처럼 불투명도로 점멸을
 * 만드는 프리셋도 같은 상한을 받아야 해서 카테고리 파일이 아니라 이 파일에 둔다.
 */
export function limitFlashCount(count: number, durationFrames: number, fps: number): number {
  const seconds = Math.max(0.1, durationFrames / (fps > 0 ? fps : 25))
  const ceiling = Math.max(1, Math.floor(2.9 * seconds))
  return clamp(Math.round(count), 1, ceiling)
}

/**
 * 점멸이 있다는 사실은 상한 안이라도 반드시 알린다.
 * 문구를 한 곳에 두어야 프리셋마다 다른 말로 경고하는 일이 생기지 않는다.
 */
export function flashNotice(): PresetNotice {
  return {
    code: 'flashWarning',
    message: '화면이 순간적으로 번쩍입니다. 빛에 민감한 분에게는 보여 주기 전에 확인해 주세요.',
  }
}

// ---------------------------------------------------------------------------
// 파라미터 읽기
// ---------------------------------------------------------------------------

export type ParamBag = Record<string, number | string | boolean>

export function num(params: ParamBag, key: string, fallback: number): number {
  const v = params[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

export function str(params: ParamBag, key: string, fallback: string): string {
  const v = params[key]
  return typeof v === 'string' ? v : fallback
}

export function bool(params: ParamBag, key: string, fallback: boolean): boolean {
  const v = params[key]
  return typeof v === 'boolean' ? v : fallback
}

// ---------------------------------------------------------------------------
// 이징 -> 키프레임 핸들
// ---------------------------------------------------------------------------

interface SegmentEase {
  interp: Interp
  out?: Handle
  in?: Handle
  spring?: SpringSpec
}

/**
 * 이징 프리셋 id 를 세그먼트 이징으로 바꾼다.
 * curve.ts 의 규약: 한 세그먼트의 곡선은 시작 키의 out 과 끝 키의 in 이 함께 만든다.
 */
function segmentEase(id: string): SegmentEase {
  const preset = EASING_PRESET_BY_ID.get(id)
  if (!preset) return { interp: 'bezier', out: { ...DEFAULT_OUT }, in: { ...DEFAULT_IN } }
  if (preset.interp === 'linear') return { interp: 'linear' }
  if (preset.interp === 'hold') return { interp: 'hold' }
  if (preset.interp === 'spring' && preset.spring) {
    return { interp: 'spring', spring: { ...preset.spring } }
  }
  const handles = preset.handles
  return {
    interp: 'bezier',
    out: handles ? { ...handles.out } : { ...DEFAULT_OUT },
    in: handles ? { ...handles.in } : { ...DEFAULT_IN },
  }
}

export interface KeyPoint {
  f: number
  v: number
  /** 이 키에서 다음 키로 가는 세그먼트의 이징 id. 생략하면 defaultEase. */
  ease?: string
}

/**
 * 키프레임 배열을 만든다.
 * 프레임은 정수로 반올림하고, 반올림 충돌이 나면 1프레임씩 밀어 오름차순을 지킨다.
 * 마지막 키의 interp 는 직전 세그먼트를 따른다. 그래야 "모든 키가 linear" 같은
 * 이징 잠금 검사가 성립한다 (rotate.spin360).
 */
export function buildKeys(points: KeyPoint[], defaultEase: string): Keyframe[] {
  const keys: Keyframe[] = []
  for (let i = 0; i < points.length; i += 1) {
    const p = points[i]!
    const prev = keys[i - 1]
    let f = Math.round(p.f)
    if (prev !== undefined && f <= prev.f) f = prev.f + 1
    keys.push({ f, v: p.v, interp: 'bezier' })
  }

  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i]!
    const isLast = i === keys.length - 1
    const own = segmentEase(points[isLast ? Math.max(0, i - 1) : i]!.ease ?? defaultEase)
    key.interp = own.interp
    if (own.spring) key.spring = own.spring
    if (!isLast && own.out) key.out = own.out
    if (i > 0) {
      const before = segmentEase(points[i - 1]!.ease ?? defaultEase)
      if (before.in) key.in = before.in
    }
  }
  return keys
}

/**
 * 트랙을 만든다.
 * id 는 결정론을 위해 prop 에서 짓는다. 한 프리셋이 같은 prop 을 두 번 내지 않으므로
 * 충돌하지 않는다. 문서에 심을 때 기존 트랙과 겹치면 호출부가 다시 매긴다.
 */
export function track(prop: TrackProp, unit: TrackUnit, keys: Keyframe[]): Track {
  return { id: `mt.${prop}`, prop, unit, keys }
}

/** 값이 변하지 않는 트랙. 키를 2개 두어 트랙 검사 규칙을 그대로 통과시킨다. */
export function constTrack(prop: TrackProp, unit: TrackUnit, value: number, span: number): Track {
  return track(prop, unit, buildKeys([{ f: 0, v: value }, { f: span, v: value }], 'linear'))
}

/** 키가 span 밖으로 밀렸을 때를 대비한 실제 지속 프레임. 보통은 span 그대로다. */
export function emitDuration(span: number, tracks: Track[]): number {
  let last = span
  for (const t of tracks) {
    const key = t.keys[t.keys.length - 1]
    if (key && key.f > last) last = key.f
  }
  return last
}

// ---------------------------------------------------------------------------
// 이펙트 인스턴스
// ---------------------------------------------------------------------------

/**
 * 프리셋이 낼 이펙트의 시드.
 *
 * Math.random 은 금지다. 같은 EmitContext 로 두 번 emit 하면 시드까지
 * 같아야 호버 미리보기와 확정 적용이 같은 그림을 낸다. 프리셋 id 와 salt 를 함께
 * 섞으므로 한 프리셋이 인스턴스를 여럿 내도 서로 다른 난수 계열을 쓴다.
 */
export function effectSeed(ctx: EmitContext, presetId: string, salt: string): number {
  return hashSeed(ctx.seed >>> 0, `${presetId}:${salt}`, 0)
}

export interface EffectInit {
  /** 한 프리셋 안에서 유일해야 한다. 문서에 심을 때 그대로 쓰인다. */
  id: string
  /**
   * effects/registry.ts 의 EffectDef.id.
   * 오타가 나면 렌더러가 조용히 건너뛴다. 테스트가 레지스트리와 대조해 잡는다.
   */
  type: string
  seed: number
  /**
   * 노이즈 유지 프레임.
   * 지지직은 기본 2, 자글자글은 프리셋이 고른 값이다. 여기가 용량 통제의 절반이다.
   */
  holdFrames?: number
  /** [시작, 끝] 프레임. 양끝 포함. 생략하면 전 구간이다. */
  range?: [number, number]
  /**
   * 파라미터. **key 는 그 EffectDef.params 에 실제로 있는 것만 쓴다.**
   * 없는 키는 resolveEffectParams 가 조용히 버려서 "적용했는데 아무 일도 안 일어남"
   * 이 된다. 값은 숫자이거나 시간축 트랙이다 (select 도 옵션 값의 숫자 코드다).
   *
   * 트랙을 쓰는 경우는 하나뿐이다. 이펙트 자체에 시간 성분이 없는데(rgbShift 처럼
   * 유니폼이 프레임에 의존하지 않는다) 프리셋이 그 값을 움직여야 할 때다.
   * paramTrack / pulseParamTrack 으로 만든다.
   */
  params: Record<string, EffectParam>
}

/**
 * 이펙트 파라미터에 거는 시간축 트랙 (EffectParam = number | Track).
 *
 * prop 과 unit 은 evalTrack 이 보지 않는다. 값만 읽는다. 그래도 아무 값이나 넣으면
 * 저장 후 다시 읽을 때 값이 바뀌므로, project/migrate.ts 의 normalizeParamTrack 이
 * 되돌리는 기본값(opacity / ratio)과 같은 값을 쓴다. 왕복 저장에도 모양이 유지된다.
 */
export function paramTrack(id: string, keys: Keyframe[]): Track {
  return { id, prop: 'opacity', unit: 'ratio', keys }
}

/**
 * lo -> hi -> lo 를 cycles 회 반복하는 파라미터 트랙.
 *
 * 사인의 반주기마다 키를 놓는다. 마지막 키가 span 에 오고 값이 첫 키와 같아
 * 이음새 없는 루프에 그대로 쓸 수 있다.
 */
export function pulseParamTrack(args: {
  id: string
  span: number
  cycles: number
  lo: number
  hi: number
  ease?: string
}): Track {
  const cycles = Math.max(1, Math.round(args.cycles))
  const frames = spread(Math.max(2, Math.round(args.span)), cycles * 2)
  const points = frames.map((f, i) => ({ f, v: i % 2 === 0 ? args.lo : args.hi }))
  return paramTrack(args.id, buildKeys(points, args.ease ?? 'easeInOutCubic'))
}

/** EffectInstance 는 필수 필드가 많다. 프리셋마다 다 적으면 값이 아니라 잡음이 보인다. */
export function makeEffect(init: EffectInit): EffectInstance {
  const params: Record<string, EffectParam> = {}
  for (const key of Object.keys(init.params)) {
    const v = init.params[key]
    if (typeof v === 'number' && Number.isFinite(v)) params[key] = v
    else if (typeof v === 'object' && v !== null && Array.isArray(v.keys)) params[key] = v
  }

  const instance: EffectInstance = {
    id: init.id,
    type: init.type,
    enabled: true,
    seed: init.seed >>> 0,
    holdFrames: Math.max(1, Math.round(init.holdFrames ?? 1)),
    // 프리셋이 내는 이펙트 중 프레임 간 상태를 이어받는 것은 아직 없다.
    requiresHistory: false,
    params,
  }
  if (init.range) {
    instance.range = [Math.round(init.range[0]), Math.round(init.range[1])]
  }
  return instance
}

// ---------------------------------------------------------------------------
// 방향
// ---------------------------------------------------------------------------

export const DIRECTION_OPTIONS = [
  { value: 'left', label: '왼쪽' },
  { value: 'right', label: '오른쪽' },
  { value: 'up', label: '위' },
  { value: 'down', label: '아래' },
]

/** 화면 좌표계는 y 가 아래로 향한다 (transform.ts). 위로 가려면 음수다. */
export function directionVector(dir: string): { prop: TrackProp; sign: number } {
  switch (dir) {
    case 'right':
      return { prop: 'translateX', sign: 1 }
    case 'up':
      return { prop: 'translateY', sign: -1 }
    case 'down':
      return { prop: 'translateY', sign: 1 }
    case 'left':
    default:
      return { prop: 'translateX', sign: -1 }
  }
}

// ---------------------------------------------------------------------------
// Ken Burns 뷰포트 rect
// ---------------------------------------------------------------------------

/**
 * 뷰포트 rect. 기준은 "cover 로 캔버스를 딱 덮은 상태"이고 그 사각형이 단위 정사각형이다.
 * 종횡비는 h = w * H / W 로 강제되므로 w 하나만 저장한다.
 *   cx, cy : 뷰포트 중심 (0.5, 0.5 가 화면 중앙)
 *   w      : 뷰포트 폭 비율. 1.0 이 캔버스 전체이고, 작을수록 확대다.
 */
export interface ViewRect {
  cx: number
  cy: number
  w: number
}

/**
 * rect 를 이미지 경계 안으로 밀어 넣는다.
 * |cx - 0.5| <= (1 - w)/2 를 만족하면 그 순간 캔버스는 100% 이미지로 찬다.
 * 이는 오버스캔 부등식 s >= (W + 2|tx|) / Iw 와 정확히 동치라서 솔버를 우회한다.
 */
export function clampRect(rect: ViewRect): ViewRect {
  const w = clamp(rect.w, 0.2, 1)
  const half = (1 - w) / 2
  return {
    w,
    cx: clamp(rect.cx, 0.5 - half, 0.5 + half),
    cy: clamp(rect.cy, 0.5 - half, 0.5 + half),
  }
}

/**
 * rect -> 트랙 값.
 *   s  = W / rect.w,  k = s / s0 = 1 / w
 *   tx = (Iw/2 - rect.cx) * s  를 캔버스 비율로 정규화하면 -k * (cx - 0.5)
 * 반환하는 이동값은 percentOfCanvas 단위(퍼센트)다.
 */
export function rectToTrackValues(rect: ViewRect): { k: number; tx: number; ty: number } {
  const r = clampRect(rect)
  const k = 1 / r.w
  return {
    k,
    tx: -k * (r.cx - 0.5) * 100,
    ty: -k * (r.cy - 0.5) * 100,
  }
}

/**
 * 두 rect 사이를 훑는 트랙 3개.
 * scale 과 translate 에 같은 이징을 걸어야 중간 프레임도 경계 안에 남는다.
 * k 와 tx 가 모두 이징 e 에 대해 선형이므로 제약식도 e 에 대해 선형이 되고,
 * 양 끝에서 만족하면 사이 전부에서 만족한다. 오버슈트 이징을 금지하는 이유가 이것이다.
 */
export function kenBurnsTracks(from: ViewRect, to: ViewRect, end: number, ease: string): Track[] {
  const a = rectToTrackValues(from)
  const b = rectToTrackValues(to)
  return [
    track('scale', 'ratio', buildKeys([{ f: 0, v: a.k }, { f: end, v: b.k }], ease)),
    track('translateX', 'percentOfCanvas', buildKeys([{ f: 0, v: a.tx }, { f: end, v: b.tx }], ease)),
    track('translateY', 'percentOfCanvas', buildKeys([{ f: 0, v: a.ty }, { f: end, v: b.ty }], ease)),
  ]
}
