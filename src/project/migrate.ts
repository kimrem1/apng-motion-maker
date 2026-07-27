/**
 * 프로젝트 스키마 마이그레이션과 복구.
 *
 * 두 가지 일을 한다.
 *   1. 옛 스키마를 현재 스키마로 올린다. 지금은 'motion-maker/1' 하나뿐이지만
 *      단계 목록(MIGRATIONS)의 구조를 지금 만들어 둔다. 나중에 스키마가 갈라질 때
 *      호출부를 건드리지 않고 단계만 얹으면 되게 하려는 것이다.
 *   2. 값을 검증하고 복구한다. 이쪽이 훨씬 중요하다.
 *
 * 복구 원칙:
 *   - 절대 던지지 않는다. 사용자 파일을 못 열면 그 작업은 사라진다.
 *   - 모르는 필드는 버리지 않는다. 앞으로 생길 필드를 옛 버전이 지워 버리면 안 된다.
 *   - 고칠 수 없는 것만 버리고, 버린 것은 전부 경고로 남긴다.
 *
 * DOM 을 참조하지 않는다.
 */

import {
  CANVAS_MAX,
  CANVAS_MIN,
  FPS_CHOICES,
  FRAMES_MAX,
  SPEED_DEFAULT,
  SPEED_MAX,
  SPEED_MIN,
  RENDER_REVISION,
  SCHEMA_ID,
  type BackgroundType,
  type BlendMode,
  type CompositeOp,
  type EffectInstance,
  type EffectParam,
  type FitMode,
  type Handle,
  type Interp,
  type Keyframe,
  type Layer,
  type LayerType,
  type LoopMode,
  type Modifier,
  type ModifierTarget,
  type ModifierType,
  type MotionProject,
  type SafeZonePolicy,
  type SpringFit,
  type SpringSpec,
  type Track,
  type TrackProp,
  type TrackUnit,
} from '@/core/types.ts'
import { TRACK_DEFAULTS, createEmptyProject } from '@/core/factory.ts'
import { EFFECT_BY_ID } from '@/effects/registry.ts'

// ---------------------------------------------------------------------------
// 허용값 목록
// ---------------------------------------------------------------------------

const TRACK_PROPS = Object.keys(TRACK_DEFAULTS) as TrackProp[]
const TRACK_UNITS: TrackUnit[] = ['ratio', 'px', 'percentOfCanvas', 'deg', 'norm']
const INTERPS: Interp[] = ['bezier', 'linear', 'hold', 'spring', 'samples']
const COMPOSITES: CompositeOp[] = ['replace', 'add', 'multiply']
const MODIFIER_TYPES: ModifierType[] = ['sine', 'loopNoise', 'eventBurst', 'spring', 'audioEnvelope']
const MODIFIER_TARGETS: ModifierTarget[] = [
  'translateX',
  'translateY',
  'rotate',
  'scale',
  'opacity',
  'skewX',
  'skewY',
]
const LOOP_MODES: LoopMode[] = ['once', 'loop', 'pingPong', 'loopWithHold']
const BACKGROUND_TYPES: BackgroundType[] = ['alpha', 'solid', 'blurExtend', 'mirror']
const SAFE_POLICIES: SafeZonePolicy[] = ['autoFit', 'backgroundFill', 'warn', 'allowEmpty']
const FIT_MODES: FitMode[] = ['cover', 'contain', 'fill', 'none']
const BLEND_MODES: BlendMode[] = ['normal', 'multiply', 'screen', 'overlay', 'lighten', 'darken']
const LAYER_TYPES: LayerType[] = ['image', 'solid', 'group']
const SPRING_MODES: SpringSpec['mode'][] = ['physical', 'visual']
const SPRING_FITS: SpringFit[] = ['springDrivesDuration', 'fitToDuration']

/** 레지스트리는 Map 이라 그대로는 Set 자리에 못 들어간다. 키만 뽑아 한 번 만든다. */
const DEFAULT_EFFECT_TYPES: ReadonlySet<string> = new Set(EFFECT_BY_ID.keys())

/** 이 상한을 넘는 fps 는 사람이 만든 값이 아니다. 프레임 예산 계산이 무너진다. */
const FPS_MAX = 240

/** 목록 안의 가장 가까운 fps. 12.5 가 있어서 정수 반올림을 쓰면 안 된다. */
function pickFps(fps: number): number {
  let best: number = FPS_CHOICES[0]
  let gap = Infinity
  for (const choice of FPS_CHOICES) {
    const d = Math.abs(choice - fps)
    if (d < gap) { gap = d; best = choice }
  }
  return best
}

// ---------------------------------------------------------------------------
// 공개 타입
// ---------------------------------------------------------------------------

export interface MigrationResult {
  doc: MotionProject
  warnings: string[]
}

export interface MigrateOptions {
  /**
   * 알려진 이펙트 type 집합. 기본값은 이펙트 레지스트리다.
   * 테스트에서 레지스트리와 무관하게 규칙만 확인할 때 주입한다.
   */
  knownEffectTypes?: ReadonlySet<string>
}

// ---------------------------------------------------------------------------
// 경고 수집
// ---------------------------------------------------------------------------

/**
 * 같은 문장을 반복하지 않고 개수를 제한한다.
 * 키프레임 200개가 깨진 파일에서 경고 200줄을 띄우면 아무도 읽지 않는다.
 */
const MAX_WARNINGS = 12

class WarningBag {
  private readonly seen = new Set<string>()
  private readonly list: string[] = []
  private extra = 0

  add(message: string): void {
    if (this.seen.has(message)) return
    this.seen.add(message)
    if (this.list.length >= MAX_WARNINGS) {
      this.extra += 1
      return
    }
    this.list.push(message)
  }

  toArray(): string[] {
    if (this.extra === 0) return [...this.list]
    return [...this.list, `그 밖에 ${this.extra}가지 문제를 복구했습니다.`]
  }
}

// ---------------------------------------------------------------------------
// 원시 값 강제
// ---------------------------------------------------------------------------

type RawRecord = Record<string, unknown>

function isRecord(v: unknown): v is RawRecord {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : []
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}

function num(v: unknown, fallback: number, lo = Number.NEGATIVE_INFINITY, hi = Number.POSITIVE_INFINITY): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback
  return clamp(v, lo, hi)
}

function int(v: unknown, fallback: number, lo: number, hi: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback
  return clamp(Math.round(v), lo, hi)
}

function str(v: unknown, fallback: string): string {
  return typeof v === 'string' ? v : fallback
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback
}

function pick<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback
}

/** 값이 있고 허용 목록 밖일 때만 true. 없는 값은 경고 대상이 아니다. */
function isBadEnum(v: unknown, allowed: readonly string[]): boolean {
  return v !== undefined && v !== null && !(typeof v === 'string' && allowed.includes(v))
}

// ---------------------------------------------------------------------------
// 스키마 단계
// ---------------------------------------------------------------------------

interface Migration {
  readonly from: string
  readonly to: string
  run(raw: RawRecord, warn: (message: string) => void): RawRecord
}

/**
 * 옛 버전 -> 새 버전 변환기.
 *
 * 지금은 비어 있다. 스키마가 'motion-maker/2' 로 올라가면 여기에
 * { from: 'motion-maker/1', to: 'motion-maker/2', run } 을 하나 넣으면 끝난다.
 */
const MIGRATIONS: readonly Migration[] = []

const KNOWN_SCHEMAS: ReadonlySet<string> = new Set<string>([
  SCHEMA_ID,
  ...MIGRATIONS.map((m) => m.from),
])

function upgradeSchema(raw: RawRecord, from: string, bag: WarningBag): RawRecord {
  let current = raw
  let version = from
  const visited = new Set<string>()

  while (version !== SCHEMA_ID) {
    if (visited.has(version)) break
    visited.add(version)
    const step = MIGRATIONS.find((m) => m.from === version)
    if (!step) break
    current = step.run(current, (m) => bag.add(m))
    version = step.to
  }
  return current
}

// ---------------------------------------------------------------------------
// 정규화
// ---------------------------------------------------------------------------

function normalizeHandle(raw: unknown): Handle | undefined {
  if (!isRecord(raw)) return undefined
  // x 를 [0,1] 로 자르면 베지어 역산 실패가 구조적으로 불가능해진다.
  // y 는 자르지 않는다. 오버슈트를 허용해야 한다.
  return { x: num(raw.x, 0.33, 0, 1), y: num(raw.y, 0, -1e6, 1e6) }
}

function normalizeSpring(raw: unknown): SpringSpec | undefined {
  if (!isRecord(raw)) return undefined
  return {
    ...raw,
    mode: pick(raw.mode, SPRING_MODES, 'visual'),
    stiffness: num(raw.stiffness, 170, 0.01, 100000),
    damping: num(raw.damping, 26, 0, 100000),
    mass: num(raw.mass, 1, 0.001, 1000),
    visualDuration: num(raw.visualDuration, 0.5, 0.001, 60),
    bounce: num(raw.bounce, 0, -1, 1),
    fit: pick(raw.fit, SPRING_FITS, 'fitToDuration'),
    bakeSamples: int(raw.bakeSamples, 60, 2, 2048),
  } as SpringSpec
}

/**
 * 키프레임 목록.
 *
 * 정렬과 중복 프레임 제거가 핵심이다. 평가기는 키가 프레임 오름차순임을 전제하고,
 * 같은 프레임에 키가 둘이면 세그먼트 길이가 0 이 된다. evalTrack 에 방어가 있지만
 * 그래프 에디터와 키 이동은 중복을 가정하지 않는다.
 */
function normalizeKeys(raw: unknown, identity: number, bag: WarningBag): Keyframe[] {
  const out: Keyframe[] = []
  for (const item of asArray(raw)) {
    if (!isRecord(item)) {
      bag.add('키프레임 하나를 읽을 수 없어 건너뛰었습니다.')
      continue
    }
    const key: Keyframe = {
      ...item,
      f: int(item.f, 0, 0, FRAMES_MAX * 8),
      v: num(item.v, identity, -1e9, 1e9),
      interp: pick(item.interp, INTERPS, 'bezier'),
    } as Keyframe

    if (isBadEnum(item.interp, INTERPS)) bag.add('알 수 없는 보간 방식을 기본값으로 바꿨습니다.')

    const out0 = normalizeHandle(item.out)
    const in0 = normalizeHandle(item.in)
    if (out0) key.out = out0
    else delete key.out
    if (in0) key.in = in0
    else delete key.in

    const spring = normalizeSpring(item.spring)
    if (spring) key.spring = spring
    else delete key.spring

    if (typeof item.easingPreset !== 'string') delete key.easingPreset

    out.push(key)
  }

  out.sort((a, b) => a.f - b.f)

  const deduped: Keyframe[] = []
  for (const key of out) {
    const prev = deduped[deduped.length - 1]
    if (prev && prev.f === key.f) {
      bag.add('같은 위치에 겹친 키프레임을 정리했습니다.')
      continue
    }
    deduped.push(key)
  }
  return deduped
}

/** 이펙트 파라미터에 붙은 트랙. prop/unit 은 평가에 쓰이지 않으므로 그대로 둔다. */
function normalizeParamTrack(raw: RawRecord, bag: WarningBag): Track {
  return {
    ...raw,
    id: str(raw.id, ''),
    prop: pick(raw.prop, TRACK_PROPS, 'opacity'),
    unit: pick(raw.unit, TRACK_UNITS, 'ratio'),
    keys: normalizeKeys(raw.keys, 0, bag),
  } as Track
}

function normalizeTrack(raw: RawRecord, bag: WarningBag): Track | null {
  if (isBadEnum(raw.prop, TRACK_PROPS) || typeof raw.prop !== 'string') {
    bag.add('알 수 없는 속성의 트랙을 버렸습니다.')
    return null
  }
  const prop = raw.prop as TrackProp
  const defaults = TRACK_DEFAULTS[prop]
  const keys = normalizeKeys(raw.keys, defaults.identity, bag)
  if (keys.length === 0) {
    // 키가 없는 트랙은 아무 값도 만들지 못한다. 없는 것과 같으므로 버린다.
    bag.add('값이 비어 있는 트랙을 버렸습니다.')
    return null
  }

  const track: Track = {
    ...raw,
    id: str(raw.id, ''),
    prop,
    unit: pick(raw.unit, TRACK_UNITS, defaults.unit),
    keys,
  } as Track

  if (raw.composite === undefined) delete track.composite
  else track.composite = pick(raw.composite, COMPOSITES, 'replace')

  if (raw.animated === undefined) delete track.animated
  else track.animated = bool(raw.animated, keys.length > 1)

  return track
}

function normalizeModifier(raw: unknown, bag: WarningBag): Modifier | null {
  if (!isRecord(raw)) return null
  if (isBadEnum(raw.type, MODIFIER_TYPES) || typeof raw.type !== 'string') {
    bag.add('알 수 없는 흔들림 종류를 버렸습니다.')
    return null
  }
  if (isBadEnum(raw.target, MODIFIER_TARGETS) || typeof raw.target !== 'string') {
    bag.add('흔들림이 가리키는 속성을 알 수 없어 버렸습니다.')
    return null
  }

  const mod: Modifier = {
    ...raw,
    id: str(raw.id, ''),
    type: raw.type as ModifierType,
    target: raw.target as ModifierTarget,
    blendOp: pick(raw.blendOp, COMPOSITES, 'add'),
    seed: int(raw.seed, 1, 0, 0x7fffffff),
    amplitude: num(raw.amplitude, 0, -1e6, 1e6),
    // sine 은 정수 주기여야 심리스 루프가 된다.
    cycles: num(raw.cycles, 1, 0, 1000),
    octaves: int(raw.octaves, 1, 1, 8),
    persistence: num(raw.persistence, 0.5, 0, 1),
    lacunarity: num(raw.lacunarity, 2, 0.01, 16),
    holdFrames: int(raw.holdFrames, 1, 1, FRAMES_MAX),
    decay: num(raw.decay, 0, 0, 100),
  } as Modifier

  if (raw.envelope === undefined) delete mod.envelope
  else mod.envelope = normalizeKeys(raw.envelope, 0, bag)

  return mod
}

function normalizeEffect(
  raw: unknown,
  known: ReadonlySet<string>,
  takenIds: Set<string>,
  reservedIds: ReadonlySet<string>,
  bag: WarningBag,
): EffectInstance | null {
  if (!isRecord(raw)) return null
  const type = str(raw.type, '')
  if (type.length === 0) {
    bag.add('종류가 없는 효과를 버렸습니다.')
    return null
  }

  const params: Record<string, EffectParam> = {}
  const rawParams: RawRecord = isRecord(raw.params) ? raw.params : {}
  for (const [key, value] of Object.entries(rawParams)) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      params[key] = value
      continue
    }
    if (isRecord(value) && Array.isArray(value.keys)) {
      params[key] = normalizeParamTrack(value, bag)
      continue
    }
    bag.add('효과의 값 하나를 읽을 수 없어 기본값으로 되돌렸습니다.')
  }

  const known0 = known.has(type)
  const fx: EffectInstance = {
    ...raw,
    id: claimId('e', str(raw.id, ''), takenIds, reservedIds),
    type,
    // 모르는 효과는 지우지 않는다. 껐다가, 나중 버전에서 그대로 다시 켤 수 있게 남긴다.
    enabled: known0 ? bool(raw.enabled, true) : false,
    seed: int(raw.seed, 1, 1, 0x7fffffff),
    holdFrames: int(raw.holdFrames, 1, 1, FRAMES_MAX),
    requiresHistory: bool(raw.requiresHistory, false),
    params,
  } as EffectInstance

  if (!known0) bag.add(`이 버전이 모르는 효과(${type})를 꺼 두었습니다.`)

  const range = asArray(raw.range)
  if (range.length === 2) {
    const a = int(range[0], 0, 0, FRAMES_MAX * 8)
    const b = int(range[1], FRAMES_MAX, 0, FRAMES_MAX * 8)
    fx.range = [Math.min(a, b), Math.max(a, b)]
  } else {
    delete fx.range
  }

  return fx
}

/**
 * 빈 id 를 채우고 중복 id 를 갈라 준다. 같은 id 가 둘이면 조회가 엉뚱한 것을 집는다.
 *
 * reserved 는 아직 처리하지 않은 뒤쪽 항목의 id 까지 포함한다. 이게 없으면 새로 만든
 * id 가 뒤에서 나올 진짜 id 와 부딪혀 문제를 한 칸 미루기만 한다.
 */
function claimId(prefix: string, wanted: string, taken: Set<string>, reserved: ReadonlySet<string>): string {
  if (wanted.length > 0 && !taken.has(wanted)) {
    taken.add(wanted)
    return wanted
  }
  let n = 1
  let candidate = `${prefix}${n}`
  while (taken.has(candidate) || reserved.has(candidate)) {
    n += 1
    candidate = `${prefix}${n}`
  }
  taken.add(candidate)
  return candidate
}

/** 목록에서 문자열 id 만 걷어 낸다. claimId 의 reserved 를 만들 때 쓴다. */
function collectIds(items: unknown[]): Set<string> {
  const out = new Set<string>()
  for (const item of items) {
    if (isRecord(item) && typeof item.id === 'string' && item.id.length > 0) out.add(item.id)
  }
  return out
}

function normalizeLayer(
  raw: unknown,
  index: number,
  known: ReadonlySet<string>,
  takenLayerIds: Set<string>,
  reservedLayerIds: ReadonlySet<string>,
  bag: WarningBag,
): Layer | null {
  if (!isRecord(raw)) {
    bag.add('레이어 하나를 읽을 수 없어 건너뛰었습니다.')
    return null
  }

  const wantedId = str(raw.id, '')
  const id = claimId('l', wantedId, takenLayerIds, reservedLayerIds)
  if (id !== wantedId) bag.add('레이어 식별자가 없거나 겹쳐서 새로 매겼습니다.')

  const tracks: Track[] = []
  const seenProps = new Set<TrackProp>()
  for (const item of asArray(raw.tracks)) {
    if (!isRecord(item)) continue
    const track = normalizeTrack(item, bag)
    if (!track) continue
    if (seenProps.has(track.prop)) {
      // 같은 속성의 트랙이 둘이면 평가기가 둘 다 합성해 값이 두 배로 튄다.
      bag.add('같은 속성이 두 번 들어 있어 뒤쪽을 버렸습니다.')
      continue
    }
    seenProps.add(track.prop)
    tracks.push(track)
  }

  const modifiers: Modifier[] = []
  for (const item of asArray(raw.modifiers)) {
    const mod = normalizeModifier(item, bag)
    if (mod) modifiers.push(mod)
  }

  const rawEffects = asArray(raw.effects)
  const reservedEffectIds = collectIds(rawEffects)
  const takenEffectIds = new Set<string>()
  const effects: EffectInstance[] = []
  for (const item of rawEffects) {
    const fx = normalizeEffect(item, known, takenEffectIds, reservedEffectIds, bag)
    if (fx) effects.push(fx)
  }

  const anchor = asArray(raw.anchor)

  const layer: Layer = {
    ...raw,
    id,
    name: str(raw.name, `레이어 ${index + 1}`),
    type: pick(raw.type, LAYER_TYPES, 'image'),
    assetId: typeof raw.assetId === 'string' ? raw.assetId : null,
    parentId: typeof raw.parentId === 'string' ? raw.parentId : null,
    z: int(raw.z, index, 0, 100000),
    visible: bool(raw.visible, true),
    locked: bool(raw.locked, false),
    fit: pick(raw.fit, FIT_MODES, 'cover'),
    anchor: [num(anchor[0], 0.5, 0, 1), num(anchor[1], 0.5, 0, 1)],
    keepPlaceOnAnchorChange: bool(raw.keepPlaceOnAnchorChange, true),
    blend: pick(raw.blend, BLEND_MODES, 'normal'),
    parallaxFactor: num(raw.parallaxFactor, 1, 0, 3),
    fillsCanvas: bool(raw.fillsCanvas, index === 0),
    /*
     * keepInside 가 없는 파일은 담기 솔버가 생기기 전에 저장된 것이다. 그때의 그림을
     * 그대로 재현해야 하므로 끈 상태로 읽는다. 기본값 true 를 주면 열자마자 배율이
     * 달라져서 "저장할 때와 다른 결과물" 이 된다.
     */
    keepInside: bool(raw.keepInside, false),
    motionExitsFrame: bool(raw.motionExitsFrame, false),
    // 0 이나 음수는 그림을 없애 버린다. 범위 밖이면 없는 것으로 보고 문서에서 다시 푼다.
    ...(typeof raw.containScale === 'number' && raw.containScale > 0 && raw.containScale <= 1
      ? { containScale: raw.containScale }
      : {}),
    tracks,
    modifiers,
    effects,
  } as Layer

  return layer
}

/**
 * 부모 사슬을 검사한다.
 * 순환이 있으면 평가기가 부모를 따라 돌다 자기 자신으로 돌아온다.
 * 평가기에도 방어가 있지만 문서에 애초에 남기지 않는 편이 낫다.
 */
function fixParents(layers: Layer[], bag: WarningBag): void {
  const ids = new Set(layers.map((l) => l.id))
  for (const layer of layers) {
    if (layer.parentId === null) continue
    if (!ids.has(layer.parentId)) {
      bag.add('없는 레이어를 부모로 가리켜 연결을 끊었습니다.')
      layer.parentId = null
      continue
    }
    const seen = new Set<string>([layer.id])
    let cursor: string | null = layer.parentId
    while (cursor) {
      if (seen.has(cursor)) {
        bag.add('레이어 부모 관계가 순환이라 연결을 끊었습니다.')
        layer.parentId = null
        break
      }
      seen.add(cursor)
      cursor = layers.find((l) => l.id === cursor)?.parentId ?? null
    }
  }
}

function normalizeAssets(raw: unknown, bag: WarningBag): MotionProject['assets'] {
  const out: MotionProject['assets'] = []
  const used = new Set<string>()

  for (const item of asArray(raw)) {
    if (!isRecord(item)) {
      bag.add('이미지 정보 하나를 읽을 수 없어 건너뛰었습니다.')
      continue
    }
    const id = str(item.id, '')
    if (id.length === 0) {
      // id 가 없으면 픽셀과 이어 붙일 방법이 없다. 새로 매겨도 의미가 없다.
      bag.add('식별자가 없는 이미지를 버렸습니다.')
      continue
    }
    if (used.has(id)) {
      bag.add('같은 이미지가 두 번 들어 있어 하나만 남겼습니다.')
      continue
    }
    used.add(id)

    const asset = {
      ...item,
      id,
      name: str(item.name, '이미지'),
      storeKey: str(item.storeKey, `idb:asset:${id}`),
      naturalW: int(item.naturalW, 1, 1, 1 << 16),
      naturalH: int(item.naturalH, 1, 1, 1 << 16),
      hasAlpha: bool(item.hasAlpha, true),
    } as MotionProject['assets'][number]

    const rawPrep = item.prep
    if (!isRecord(rawPrep)) {
      delete asset.prep
    } else {
      const prep = { ...rawPrep } as NonNullable<MotionProject['assets'][number]['prep']>
      const crop = asArray(rawPrep.crop)
      if (crop.length === 4) {
        prep.crop = [
          num(crop[0], 0, 0, 1 << 16),
          num(crop[1], 0, 0, 1 << 16),
          num(crop[2], asset.naturalW, 0, 1 << 16),
          num(crop[3], asset.naturalH, 0, 1 << 16),
        ]
      } else {
        delete prep.crop
      }
      const rawBgRemove = rawPrep.bgRemove
      if (isRecord(rawBgRemove)) {
        prep.bgRemove = {
          ...rawBgRemove,
          enabled: bool(rawBgRemove.enabled, false),
          keyColor: str(rawBgRemove.keyColor, '#ffffff'),
          tolerance: num(rawBgRemove.tolerance, 0.12, 0, 1),
          featherPx: num(rawBgRemove.featherPx, 1, 0, 64),
          // 기본 true 는 PrepPanel 초기값과 같다. 없던 시절 기록도 그 값으로 만들었다.
          contiguous: bool(rawBgRemove.contiguous, true),
        } as NonNullable<NonNullable<MotionProject['assets'][number]['prep']>['bgRemove']>
      } else {
        delete prep.bgRemove
      }
      asset.prep = prep
    }

    out.push(asset)
  }
  return out
}

function normalizePresetRef(raw: unknown): MotionProject['presetRef'] | undefined {
  if (!isRecord(raw)) return undefined
  const id = str(raw.id, '')
  if (id.length === 0) return undefined
  const macro: RawRecord = isRecord(raw.macro) ? raw.macro : {}

  const ref = {
    ...raw,
    id,
    macro: {
      speed: num(macro.speed, SPEED_DEFAULT, SPEED_MIN, SPEED_MAX),
      strength: num(macro.strength, 0.5, 0, 1),
    },
    dirty: bool(raw.dirty, false),
  } as NonNullable<MotionProject['presetRef']>

  /*
   * 속도 기준선. 없으면 옛 프로젝트이므로 넣지 않는다. 그러면 apply 쪽이 지금
   * 타임라인에서 초로 읽어 그 순간의 길이를 기준선으로 삼는다. 0 이나 음수를 그대로
   * 두면 나눗셈이 폭발하므로 범위 밖은 없는 것으로 본다.
   */
  if (typeof raw.baseSec === 'number' && Number.isFinite(raw.baseSec) && raw.baseSec > 0) {
    ref.baseSec = clamp(raw.baseSec, 0.04, FRAMES_MAX / 10)
  }
  if (typeof raw.baseFps === 'number' && Number.isFinite(raw.baseFps) && raw.baseFps > 0) {
    ref.baseFps = pickFps(raw.baseFps)
  }

  if (Array.isArray(raw.props)) {
    ref.props = raw.props.filter(
      (p): p is TrackProp => typeof p === 'string' && (TRACK_PROPS as string[]).includes(p),
    )
  } else {
    delete ref.props
  }

  if (Array.isArray(raw.effectIds)) {
    ref.effectIds = raw.effectIds.filter((e): e is string => typeof e === 'string')
  } else {
    delete ref.effectIds
  }

  return ref
}

function normalizeProject(raw: RawRecord, known: ReadonlySet<string>, bag: WarningBag): MotionProject {
  const base = createEmptyProject()

  const rawCanvas: RawRecord = isRecord(raw.canvas) ? raw.canvas : {}
  const rawBg: RawRecord = isRecord(rawCanvas.background) ? rawCanvas.background : {}
  if (isBadEnum(rawBg.type, BACKGROUND_TYPES)) bag.add('알 수 없는 배경 종류를 투명으로 되돌렸습니다.')

  const canvas: MotionProject['canvas'] = {
    ...rawCanvas,
    w: int(rawCanvas.w, base.canvas.w, CANVAS_MIN, CANVAS_MAX),
    h: int(rawCanvas.h, base.canvas.h, CANVAS_MIN, CANVAS_MAX),
    background: {
      ...rawBg,
      type: pick(rawBg.type, BACKGROUND_TYPES, base.canvas.background.type),
      color: str(rawBg.color, base.canvas.background.color),
      matteColor: str(rawBg.matteColor, base.canvas.background.matteColor),
    },
  } as MotionProject['canvas']

  const rawTimeline: RawRecord = isRecord(raw.timeline) ? raw.timeline : {}
  const rawLoop: RawRecord = isRecord(rawTimeline.loop) ? rawTimeline.loop : {}
  if (isBadEnum(rawLoop.mode, LOOP_MODES)) bag.add('알 수 없는 반복 방식을 기본값으로 바꿨습니다.')

  const timeline: MotionProject['timeline'] = {
    ...rawTimeline,
    fps: num(rawTimeline.fps, base.timeline.fps, 1, FPS_MAX),
    durationFrames: int(rawTimeline.durationFrames, base.timeline.durationFrames, 2, FRAMES_MAX),
    loop: {
      ...rawLoop,
      mode: pick(rawLoop.mode, LOOP_MODES, base.timeline.loop.mode),
      count: int(rawLoop.count, 0, 0, 100000),
      holdMs: num(rawLoop.holdMs, 0, 0, 600000),
      dedupeBoundaryFrame: bool(rawLoop.dedupeBoundaryFrame, true),
    },
  } as MotionProject['timeline']

  const rawSafe: RawRecord = isRecord(raw.safeZone) ? raw.safeZone : {}
  const safeZone: MotionProject['safeZone'] = {
    ...rawSafe,
    policy: pick(rawSafe.policy, SAFE_POLICIES, base.safeZone.policy),
    marginRatio: num(rawSafe.marginRatio, base.safeZone.marginRatio, 0, 0.5),
    sampleCount: int(rawSafe.sampleCount, base.safeZone.sampleCount, 2, 4096),
    edgeBleedPx: int(rawSafe.edgeBleedPx, base.safeZone.edgeBleedPx, 0, 64),
  } as MotionProject['safeZone']

  const assets = normalizeAssets(raw.assets, bag)

  // id 를 먼저 전부 걷어야 새로 매긴 id 가 뒤쪽 레이어와 겹치지 않는다.
  const rawLayers = asArray(raw.layers)
  const reservedLayerIds = collectIds(rawLayers)
  const takenLayerIds = new Set<string>()
  const layers: Layer[] = []
  rawLayers.forEach((item, index) => {
    const layer = normalizeLayer(item, index, known, takenLayerIds, reservedLayerIds, bag)
    if (layer) layers.push(layer)
  })
  fixParents(layers, bag)

  const assetIds = new Set(assets.map((a) => a.id))
  const dangling = layers.filter((l) => l.assetId !== null && !assetIds.has(l.assetId))
  if (dangling.length > 0) {
    // 참조를 지우지는 않는다. 이미지가 없을 뿐이고, 지우면 되돌릴 수 없다.
    bag.add(`레이어 ${dangling.length}장이 없는 이미지를 가리킵니다.`)
  }

  const revision = num(raw.renderRevision, RENDER_REVISION, -1e9, 1e9)
  if (revision < RENDER_REVISION) {
    bag.add('이 파일은 예전 버전에서 만들어져 움직임이 조금 다를 수 있습니다.')
  } else if (revision > RENDER_REVISION) {
    bag.add('이 파일은 더 새로운 버전에서 만들어졌습니다. 일부 움직임이 다르게 보일 수 있습니다.')
  }

  // 모르는 필드를 살리려고 raw 를 먼저 펼친다. 아래 키들이 그 위를 덮는다.
  const out: RawRecord = {
    ...raw,
    schema: SCHEMA_ID,
    appVersion: str(raw.appVersion, base.appVersion),
    // 지금 렌더러로 그리므로 이 문서의 렌더 리비전은 현재 값이다.
    // 옛 값을 남기면 열 때마다 같은 경고가 반복된다.
    renderRevision: RENDER_REVISION,
    canvas,
    timeline,
    safeZone,
    assets,
    layers,
  }

  const presetRef = normalizePresetRef(raw.presetRef)
  if (presetRef) out.presetRef = presetRef
  else delete out.presetRef

  return out as unknown as MotionProject
}

// ---------------------------------------------------------------------------
// 진입점
// ---------------------------------------------------------------------------

/**
 * 어떤 입력이 와도 열 수 있는 문서를 돌려준다. 던지지 않는다.
 * raw 는 파싱된 객체이거나 JSON 문자열이다. 문자열이 깨져 있어도 여기서 처리한다.
 */
export function migrateProject(raw: unknown, options: MigrateOptions = {}): MigrationResult {
  const bag = new WarningBag()
  const known = options.knownEffectTypes ?? DEFAULT_EFFECT_TYPES

  let source: unknown = raw
  if (typeof source === 'string') {
    try {
      source = JSON.parse(source)
    } catch {
      bag.add('프로젝트 정보가 손상되어 읽을 수 없습니다. 빈 문서로 엽니다.')
      source = null
    }
  }

  if (!isRecord(source)) {
    if (source !== null && source !== undefined) {
      bag.add('프로젝트 정보의 형식이 올바르지 않아 빈 문서로 엽니다.')
    }
    return { doc: createEmptyProject(), warnings: bag.toArray() }
  }

  const schema = str(source.schema, '')
  if (schema.length === 0) {
    bag.add('스키마 버전이 없어 현재 버전으로 간주합니다.')
  } else if (!KNOWN_SCHEMAS.has(schema)) {
    bag.add(`알 수 없는 형식(${schema})입니다. 읽을 수 있는 만큼 복구했습니다.`)
  }

  const upgraded = upgradeSchema(source, schema.length > 0 ? schema : SCHEMA_ID, bag)
  const doc = normalizeProject(upgraded, known, bag)
  return { doc, warnings: bag.toArray() }
}

/** 현재 스키마 목록. UI 가 "이 버전까지 열 수 있습니다" 를 보여줄 때 쓴다. */
export function supportedSchemas(): string[] {
  return [...KNOWN_SCHEMAS]
}
