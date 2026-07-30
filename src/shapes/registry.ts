/**
 * 도형 모션 세트 레지스트리.
 *
 * 카탈로그는 여섯 묶음 24종이다.
 *   퍼지기 4 / 소리 그래프 4 / 화면 전환 4 / 돌기 4 / 강조 5 / 배경 장식 3
 *
 * 이 파일이 UI 와 만나는 유일한 면이다. UI 는 label / hint / group 만 읽고
 * 내부 id 는 어떤 형태로도 화면에 내보내지 않는다.
 *
 * 모션 프리셋(motions/registry.ts)과 카탈로그를 합치지 않는다. 그쪽은 "이미 있는
 * 레이어 하나에 움직임을 얹는다" 는 계약이고, 이쪽은 "레이어를 만든다" 는 계약이다.
 * 섞으면 프리셋을 고를 때마다 도형이 새로 생기거나, 도형 세트를 고를 때 이미지에
 * 엉뚱한 트랙이 얹힌다.
 */

import { FRAMES_MAX, SPEED_MAX, SPEED_MIN, type Track } from '@/core/types.ts'
import { normalizeShapeSpec } from '@/core/shape.ts'
import { clamp, clamp01 } from './shared.ts'
import type { SceneContext, SceneEmission, SceneLayer, ShapeScene, ShapeSceneGroup } from './types.ts'
import { PULSE_SCENES } from './scenes/pulse.ts'
import { BARS_SCENES } from './scenes/bars.ts'
import { WIPE_SCENES } from './scenes/wipe.ts'
import { SPIN_SCENES } from './scenes/spin.ts'
import { ACCENT_SCENES } from './scenes/accent.ts'
import { AMBIENT_SCENES } from './scenes/ambient.ts'

export const SHAPE_SCENES: ShapeScene[] = [
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
    tracks,
  }
}

/**
 * 세트 하나를 실제로 심을 모양으로 계산한다. 문서를 건드리지 않는다.
 * 미리보기와 확정 삽입이 **같은 함수**를 쓰므로 카드에서 본 것과 다른 결과가 나올 수 없다.
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
  return {
    layers: emission.layers.map(sanitizeLayer),
    durationFrames: clamp(Math.round(emission.durationFrames), 2, FRAMES_MAX),
    loopMode: emission.loopMode,
    fps: emission.fps > 0 ? emission.fps : safe.fps,
  }
}
