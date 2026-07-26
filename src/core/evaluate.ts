/**
 * 트랙 평가와 채널 결합.
 *
 * 세그먼트 보간은 easing/curve.ts 가 맡는다. 여기는 채널 결합 규칙과 단위 변환만 본다.
 */

import type {
  CanvasConfig,
  CompositeOp,
  CompositionSnapshot,
  Layer,
  ResolvedLayer,
  ResolvedTransform,
  TrackProp,
  TrackUnit,
} from './types.ts'
import { identityTransform } from './transform.ts'
import { evalTrack } from '@/easing/curve.ts'
import { evalModifier } from '@/motions/generators.ts'

/** prop 별 기본 결합 방식. 트랙이 composite 를 지정하지 않으면 이 규칙을 쓴다. */
const DEFAULT_COMPOSITE: Record<TrackProp, CompositeOp> = {
  scale: 'multiply',
  scaleX: 'multiply',
  scaleY: 'multiply',
  opacity: 'multiply',
  translateX: 'add',
  translateY: 'add',
  rotate: 'add',
  skewX: 'add',
  skewY: 'add',
  anchorX: 'replace',
  anchorY: 'replace',
}

export function defaultCompositeFor(prop: TrackProp): CompositeOp {
  return DEFAULT_COMPOSITE[prop]
}

/** 프레임 위치에서 트랙 값을 뽑는다. 키가 하나면 상수다. */
export const evalTrackAt = evalTrack

/** 단위를 렌더러가 쓰는 단위(px, deg, 배율)로 바꾼다. */
function convertUnit(
  value: number,
  prop: TrackProp,
  unit: TrackUnit,
  canvas: CanvasConfig,
): number {
  switch (unit) {
    case 'percentOfCanvas': {
      const base = prop === 'translateY' ? canvas.h : canvas.w
      return (value / 100) * base
    }
    case 'norm': {
      const base = prop === 'translateY' ? canvas.h : canvas.w
      return value * base
    }
    case 'px':
    case 'deg':
    case 'ratio':
    default:
      return value
  }
}

function applyOp(current: number, incoming: number, op: CompositeOp): number {
  switch (op) {
    case 'multiply':
      return current * incoming
    case 'add':
      return current + incoming
    case 'replace':
    default:
      return incoming
  }
}

function writeChannel(
  t: ResolvedTransform,
  prop: TrackProp,
  value: number,
  op: CompositeOp,
): void {
  switch (prop) {
    case 'scale':
      t.scaleX = applyOp(t.scaleX, value, op)
      t.scaleY = applyOp(t.scaleY, value, op)
      return
    case 'scaleX':
      t.scaleX = applyOp(t.scaleX, value, op)
      return
    case 'scaleY':
      t.scaleY = applyOp(t.scaleY, value, op)
      return
    case 'rotate':
      t.rotate = applyOp(t.rotate, value, op)
      return
    case 'translateX':
      t.translateX = applyOp(t.translateX, value, op)
      return
    case 'translateY':
      t.translateY = applyOp(t.translateY, value, op)
      return
    case 'skewX':
      t.skewX = applyOp(t.skewX, value, op)
      return
    case 'skewY':
      t.skewY = applyOp(t.skewY, value, op)
      return
    case 'opacity':
      t.opacity = applyOp(t.opacity, value, op)
      return
    case 'anchorX':
      t.anchorX = applyOp(t.anchorX, value, op)
      return
    case 'anchorY':
      t.anchorY = applyOp(t.anchorY, value, op)
      return
  }
}

export function resolveLayerTransform(
  layer: Layer,
  frame: number,
  canvas: CanvasConfig,
  durationFrames = 1,
): ResolvedTransform {
  const t = identityTransform()
  t.anchorX = layer.anchor[0]
  t.anchorY = layer.anchor[1]

  for (const track of layer.tracks) {
    const raw = evalTrackAt(track, frame)
    if (raw === undefined) continue
    const value = convertUnit(raw, track.prop, track.unit, canvas)
    writeChannel(t, track.prop, value, track.composite ?? DEFAULT_COMPOSITE[track.prop])
  }

  // 모디파이어는 트랙 결합이 끝난 뒤에 얹는다. 흔들림은 "이미 정해진 위치" 위에
  // 더해지는 것이지 위치를 대체하는 것이 아니다.
  // 오버스캔 솔버는 이보다 더 뒤에 돈다.
  for (const m of layer.modifiers) {
    const value = evalModifier(m, {
      frame,
      durationFrames,
      projectSeed: PROJECT_SEED,
      nodeId: layer.id,
    })
    if (value === 0) continue
    writeChannel(t, m.target, value, m.blendOp)
  }

  return t
}

/**
 * 문서에 시드 필드가 아직 없다. 흔들림 패턴을 사용자가 바꾸고 싶어지면
 * MotionProject 에 seed 를 추가하고 여기를 그 값으로 바꾼다.
 * 상수여도 결정론은 깨지지 않는다. 모디파이어마다 id 로 다시 섞이기 때문이다.
 */
const PROJECT_SEED = 0x4d4d

/** 순환 참조를 만나면 멈춘다. 깊이 상한은 넉넉히 잡되 무한 루프는 막는다. */
const MAX_PARENT_DEPTH = 16

/**
 * 부모 레이어의 이동을 물려받은 변환.
 *
 *   translate_effective = translate_own + translate_parent * parallaxFactor
 *
 * v1 의 parentId 는 **패럴랙스 전용**이다. 회전과 배율은 물려받지 않는다.
 * 상속 대상을 이동으로 한정한 것은, 유일한 소비자가 parallax.dual 프리셋이기 때문이다.
 * 애프터이펙트식 전체 부모 변환(회전/배율 상속)은 v2 다.
 * UI 는 이 필드를 "깊이감" 으로 부르고 부모-자식이라는 말을 쓰지 않는다.
 */
export function resolveLayerTransformWithParents(
  doc: CompositionSnapshot,
  layer: Layer,
  frame: number,
): ResolvedTransform {
  const duration = doc.timeline.durationFrames
  const own = resolveLayerTransform(layer, frame, doc.canvas, duration)
  if (!layer.parentId) return own

  let parentId: string | null = layer.parentId
  const seen = new Set<string>([layer.id])
  let depth = 0

  while (parentId && depth < MAX_PARENT_DEPTH) {
    if (seen.has(parentId)) break // 순환
    seen.add(parentId)

    const parent = doc.layers.find((l) => l.id === parentId)
    if (!parent) break

    const parentTransform = resolveLayerTransform(parent, frame, doc.canvas, duration)
    own.translateX += parentTransform.translateX * layer.parallaxFactor
    own.translateY += parentTransform.translateY * layer.parallaxFactor

    parentId = parent.parentId
    depth += 1
  }

  return own
}

/**
 * 컴포지션 전체를 평가한다.
 * z 오름차순으로 정렬해서 반환하므로 렌더러는 순서대로 그리기만 하면 된다.
 *
 * overscan 은 선택 사항이다. 넘기면 결합이 끝난 scale 채널에 보정 계수를 곱한다.
 * 이 순서가 중요하다. 결합 전에 곱하면 여러 모션이 겹쳤을 때 다시 캔버스가 빈다
 */
export function resolveComposition(
  doc: CompositionSnapshot,
  frame: number,
  overscan?: ReadonlyMap<string, { correction: number }>,
): ResolvedLayer[] {
  const resolved: ResolvedLayer[] = []
  for (const layer of doc.layers) {
    const transform = resolveLayerTransformWithParents(doc, layer, frame)

    // 보정은 양방향이다. 채우기 레이어는 1 보다 큰 값으로 키우고, 담기 레이어는
    // 1 보다 작은 값으로 줄인다. 1 초과만 반영하면 담기가 통째로 무시된다.
    const need = overscan?.get(layer.id)
    if (need && need.correction !== 1) {
      transform.scaleX *= need.correction
      transform.scaleY *= need.correction
    }

    resolved.push({
      layerId: layer.id,
      assetId: layer.assetId,
      visible: layer.visible,
      z: layer.z,
      fit: layer.fit,
      blend: layer.blend,
      transform,
      effects: layer.effects,
    })
  }
  resolved.sort((a, b) => a.z - b.z)
  return resolved
}
