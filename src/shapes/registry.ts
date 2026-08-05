/**
 * 도형 모션 세트 레지스트리.
 *
 * 카탈로그는 일곱 묶음 43종이다.
 *   연출 15 / 퍼지기 4 / 소리 그래프 5 / 화면 전환 5 / 돌기 4 / 강조 6 / 배경 장식 4
 *
 * 이 파일이 UI 와 만나는 유일한 면이다. UI 는 label / hint / group 만 읽고
 * 내부 id 는 어떤 형태로도 화면에 내보내지 않는다.
 *
 * 모션 프리셋(motions/registry.ts)과 카탈로그를 합치지 않는다. 그쪽은 "이미 있는
 * 레이어 하나에 움직임을 얹는다" 는 계약이고, 이쪽은 "레이어를 만든다" 는 계약이다.
 * 섞으면 프리셋을 고를 때마다 도형이 새로 생기거나, 도형 세트를 고를 때 이미지에
 * 엉뚱한 트랙이 얹힌다.
 */

import { FRAMES_MAX, SPEED_MAX, SPEED_MIN, type Keyframe, type Track } from '@/core/types.ts'
import { normalizeShapeSpec } from '@/core/shape.ts'
import { normalizeRevealSpec } from '@/core/reveal.ts'
import { clamp, clamp01, timingOf } from './shared.ts'
import type { SceneContext, SceneEmission, SceneLayer, ShapeScene, ShapeSceneGroup } from './types.ts'
import { PULSE_SCENES } from './scenes/pulse.ts'
import { BARS_SCENES } from './scenes/bars.ts'
import { WIPE_SCENES } from './scenes/wipe.ts'
import { SPIN_SCENES } from './scenes/spin.ts'
import { ACCENT_SCENES } from './scenes/accent.ts'
import { AMBIENT_SCENES } from './scenes/ambient.ts'
import { STAGE_SCENES } from './scenes/stage.ts'
import { PANEL_SCENES } from './scenes/panel.ts'
import { PAPER_SCENES } from './scenes/paper.ts'

export const SHAPE_SCENES: ShapeScene[] = [
  ...STAGE_SCENES,
  ...PANEL_SCENES,
  ...PAPER_SCENES,
  ...PULSE_SCENES,
  ...BARS_SCENES,
  ...SPIN_SCENES,
  ...ACCENT_SCENES,
  ...WIPE_SCENES,
  ...AMBIENT_SCENES,
]

export const SHAPE_SCENE_BY_ID: ReadonlyMap<string, ShapeScene> = new Map(
  SHAPE_SCENES.map((scene) => [scene.id, scene]),
)

export function scenesOfGroup(group: ShapeSceneGroup): ShapeScene[] {
  return SHAPE_SCENES.filter((scene) => scene.group === group)
}

/** 기본 색. 어느 배경 위에서도 보이는 밝은 회백색이다. */
export const DEFAULT_SHAPE_COLOR = '#f5f7fa'

export function createSceneContext(overrides: Partial<SceneContext> = {}): SceneContext {
  return {
    canvasW: 512,
    canvasH: 512,
    fps: 25,
    strength: 0.5,
    speed: 1,
    color: DEFAULT_SHAPE_COLOR,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// 적용
// ---------------------------------------------------------------------------

/**
 * 트랙 값의 마지막 방어선.
 *
 * 장면 하나가 실수로 투명도 1.4 나 배율 0 을 내면 화면에서는 "가끔 안 보이는 도형"
 * 으로만 드러나 원인을 찾기 어렵다. 여기서 한 번에 가둔다. 값 자체를 고치므로
 * 저장된 문서에도 잘못된 값이 남지 않는다.
 */
function sanitizeTrack(source: Track): Track {
  const keys = source.keys
    .filter((k) => Number.isFinite(k.f) && Number.isFinite(k.v))
    .map((k) => {
      let v = k.v
      if (source.prop === 'opacity') v = clamp01(v)
      else if (source.prop === 'scale' || source.prop === 'scaleX' || source.prop === 'scaleY') {
        v = clamp(v, 0.001, 100)
      }
      return { ...k, f: Math.max(0, Math.round(k.f)), v }
    })
    .sort((a, b) => a.f - b.f)

  // 같은 프레임에 키가 둘이면 평가가 0 으로 나눈다. 뒤엣것을 버린다.
  const unique = keys.filter((k, i) => i === 0 || k.f !== keys[i - 1]?.f)
  return { ...source, keys: unique.length > 0 ? unique : [{ f: 0, v: 0, interp: 'bezier' }] }
}

function sanitizeLayer(layer: SceneLayer): SceneLayer {
  const seen = new Set<string>()
  const tracks: Track[] = []
  for (const t of layer.tracks) {
    // 같은 속성의 트랙이 둘이면 평가기가 둘 다 합성해 값이 두 배로 튄다.
    if (seen.has(t.prop)) continue
    seen.add(t.prop)
    tracks.push(sanitizeTrack(t))
  }
  return {
    ...layer,
    shape: normalizeShapeSpec(layer.shape),
    // 가리기도 같은 문을 통과시킨다. 'none' 이면 필드 자체를 만들지 않는다.
    ...(layer.reveal
      ? (() => {
          const reveal = normalizeRevealSpec(layer.reveal)
          return reveal.mode === 'none' ? {} : { reveal }
        })()
      : {}),
    tracks,
  }
}

// ---------------------------------------------------------------------------
// 주기 이어 붙이기
// ---------------------------------------------------------------------------

/**
 * 한 주기를 여러 번 이어 붙인다.
 *
 * 이미 만들어 둔 타임라인에 세트를 얹을 때 쓴다. 예전에는 세트 하나를 문서 길이만큼
 * 늘여 버렸다. 2초짜리 파동이 4.8초에 걸쳐 한 번 번지고, 무엇보다 속도 노브가
 * 아무 일도 하지 않아 화면에서 잠겨 있었다. 이제는 속도가 주기를 정하고 그 주기를
 * 문서 길이 안에 채운다.
 *
 * **새 이음새가 생기지 않는다.** 모든 세트가 loopMode 'loop' 이고, 주기의 끝에서
 * 처음으로 돌아가는 자리는 이미 반복 재생이 매 바퀴 지나는 자리다. 이어 붙이기는
 * 그 자리를 문서 안으로 옮겨 놓을 뿐이라 없던 끊김이 새로 생길 수 없다.
 *
 * offsets 는 각 주기의 시작 프레임이고 길이가 reps + 1 이다. 마지막 항목이 총 길이다.
 * 주기마다 폭이 한 프레임씩 다를 수 있어서(총 길이가 reps 로 안 나누어떨어질 때)
 * 키를 그 폭에 맞춰 다시 편다. 그래야 마지막 주기가 정확히 총 길이에서 끝난다.
 */
function tileTrack(source: Track, cycle: number, offsets: readonly number[]): Track {
  const reps = offsets.length - 1
  if (reps <= 1 || cycle < 2 || source.keys.length < 2) return source

  const first = source.keys[0]
  const last = source.keys[source.keys.length - 1]
  if (!first || !last) return source

  /** 끝 값이 첫 값으로 돌아오는가. cycle() 이 만든 트랙은 전부 그렇다. */
  const closed = last.v === first.v
  /*
   * **한 바퀴**를 도는 회전만 이어서 돈다.
   *
   * 레이더와 팽이는 한 주기에 360도를 돈다(0 -> 360). 값을 그대로 복사하면 두 번째
   * 주기의 첫 키가 다시 0 이라, 겹친 키를 버리는 규칙에 걸려 트랙이 360 에 멈춘다.
   * 주기마다 한 바퀴씩 더해 두면 계속 돈다. 360 과 0 은 같은 그림이라 이음새도 없다.
   *
   * "각도면 무조건" 이 아니다. 쫀득 팝의 회전은 -18도에서 0도로 펴지는 흔들림이고,
   * 한 바퀴가 아니다. 그것까지 더하면 주기마다 18도씩 기울어 간다. 360의 배수만
   * 같은 그림으로 돌아오므로 그 경우만 잇는다.
   */
  const delta = last.v - first.v
  const fullTurns = Math.abs(delta) >= 359.9 && Math.abs(delta % 360) < 0.1
  const step = source.unit === 'deg' && fullTurns ? delta : 0

  const keys: Keyframe[] = []
  for (let r = 0; r < reps; r += 1) {
    const from = offsets[r] ?? 0
    const to = offsets[r + 1] ?? from
    const width = Math.max(1, to - from)
    /*
     * 마지막 주기가 아니면 끝 키가 다음 주기의 첫 키 자리를 침범한다.
     *
     * 값이 이어지면(closed 이거나 각도) 같은 자리에 같은 값이므로 하나로 합친다.
     * 값이 안 이어지면 한 프레임 앞에서 끝낸다. 되돌아가는 순간을 한 프레임에
     * 몰아넣는 wipe.ts 의 lastFrame 과 같은 규칙이다.
     */
    const limit = r === reps - 1 || closed || step !== 0 ? to : to - 1
    for (const key of source.keys) {
      const f = Math.min(from + Math.round((key.f * width) / cycle), limit)
      const prev = keys[keys.length - 1]
      // 이음새에서 겹친다. 앞 주기가 만든 키를 남긴다.
      if (prev !== undefined && f <= prev.f) continue
      keys.push({ ...key, f, v: key.v + step * r })
    }
  }
  return { ...source, keys }
}

function tileLayer(layer: SceneLayer, cycle: number, offsets: readonly number[]): SceneLayer {
  return { ...layer, tracks: layer.tracks.map((t) => tileTrack(t, cycle, offsets)) }
}

/** 각 주기의 시작 프레임. 길이는 reps + 1 이고 마지막이 총 길이다. */
function cycleOffsets(total: number, reps: number): number[] {
  const out: number[] = []
  for (let r = 0; r < reps; r += 1) out.push(Math.round((total * r) / reps))
  out.push(total)
  return out
}

/**
 * 세트 하나를 실제로 심을 모양으로 계산한다. 문서를 건드리지 않는다.
 * 미리보기와 확정 삽입이 같은 함수를 쓰므로 카드에서 본 것과 다른 결과가 나올 수 없다.
 */
export function buildShapeScene(sceneId: string, ctx: SceneContext): SceneEmission | null {
  const scene = SHAPE_SCENE_BY_ID.get(sceneId)
  if (!scene) return null

  const safe: SceneContext = {
    ...ctx,
    canvasW: Math.max(16, Math.round(ctx.canvasW)),
    canvasH: Math.max(16, Math.round(ctx.canvasH)),
    fps: ctx.fps > 0 ? ctx.fps : 25,
    strength: clamp01(Number.isFinite(ctx.strength) ? ctx.strength : 0.5),
    speed: clamp(Number.isFinite(ctx.speed) && ctx.speed > 0 ? ctx.speed : 1, SPEED_MIN, SPEED_MAX),
  }

  const emission = scene.emit(safe)
  const cycle = clamp(Math.round(emission.durationFrames), 2, FRAMES_MAX)

  /*
   * 세트가 낸 것은 한 주기다. 이미 만들어 둔 타임라인에 맞추는 중이면 그 주기를
   * 문서 길이만큼 이어 붙인다. 몇 번 붙일지는 속도가 정한다(shared.ts timingOf).
   *
   * 여기서 timingOf 를 다시 부르는 이유는 세트가 reps 를 돌려주지 않기 때문이다.
   * 세트 43종이 저마다 반복을 짜게 하지 않으려고 계약을 "한 주기만 만든다" 로
   * 뒀다. 순수 함수라 같은 ctx 면 emit 안에서 부른 것과 같은 값이 나온다.
   */
  const plan = timingOf(safe, scene.defaultDurationMs)
  // 세트가 timingOf 의 span 을 그대로 쓰지 않았으면 계약 밖이다. 이어 붙이지 않는다.
  const reps = plan.span === cycle ? Math.max(1, Math.round(plan.reps)) : 1
  const total =
    reps > 1 && safe.fitFrames !== undefined
      ? clamp(Math.round(safe.fitFrames), 2, FRAMES_MAX)
      : cycle
  const offsets = cycleOffsets(total, reps)

  return {
    layers: emission.layers.map((l) => sanitizeLayer(tileLayer(l, cycle, offsets))),
    durationFrames: total,
    loopMode: emission.loopMode,
    fps: emission.fps > 0 ? emission.fps : safe.fps,
  }
}
