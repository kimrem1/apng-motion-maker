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
import { baseFitScale, identityTransform } from './transform.ts'
import { parseHexColor } from './color.ts'
import { charAnimIsActive, objectCharTransform } from './charAnim.ts'
import { folderChain, isFolderLayer } from './group.ts'
import { layerIntrinsicSize } from './shape.ts'
import { layerTimeGate } from './cuts.ts'
import { evalTrack } from '@/easing/curve.ts'
import { evalModifier } from '@/motions/generators.ts'

/** prop 별 기본 결합 방식. 트랙이 composite 를 지정하지 않으면 이 규칙을 쓴다. */
const DEFAULT_COMPOSITE: Record<TrackProp, CompositeOp> = {
  scale: 'multiply',
  scaleX: 'multiply',
  scaleY: 'multiply',
  opacity: 'multiply',
  // 흐림은 항등값 0 에 더해지므로 트랙 하나면 그 값이 그대로다.
  blur: 'add',
  // 가리기는 투명도와 같은 규칙이다. 항등값 1 에 곱해지므로 트랙 하나면 그 값이 그대로다.
  reveal: 'multiply',
  // 글자 등장도 같다.
  charIn: 'multiply',
  translateX: 'add',
  translateY: 'add',
  rotate: 'add',
  rotateX: 'add',
  rotateY: 'add',
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

/**
 * 트랙 단위 1 이 렌더러 단위(px, deg, 배율) 몇에 해당하는가.
 *
 * 값 변환과 따로 두는 이유는 되돌릴 일이 있기 때문이다. 캔버스에서 끌어 옮긴
 * 거리는 언제나 픽셀인데, 그 레이어의 이동 트랙이 percentOfCanvas 로 되어 있으면
 * (사진 훑기 프리셋이 그렇게 낸다) 픽셀을 그대로 쓸 수 없다. 나눗셈에 쓸 배율을
 * 여기 한 곳에서만 정의해 두면 두 방향이 어긋날 수 없다.
 */
export function unitScale(prop: TrackProp, unit: TrackUnit, canvas: CanvasConfig): number {
  // 캔버스 환산은 이동 계열에만 뜻이 있다. anchorX/anchorY 는 이미지 비율(0..1)이
  // 그 자체로 렌더러 단위라(buildLayerMatrix 가 비율로 읽는다), 여기서 캔버스
  // 크기를 곱하면 항등값 0.5 짜리 트랙이 레이어를 화면 밖으로 날려 버린다.
  const stretches = prop === 'translateX' || prop === 'translateY'
  switch (unit) {
    case 'percentOfCanvas':
      return stretches ? (prop === 'translateY' ? canvas.h : canvas.w) / 100 : 1
    case 'norm':
      return stretches ? (prop === 'translateY' ? canvas.h : canvas.w) : 1
    case 'px':
    case 'deg':
    case 'ratio':
    default:
      return 1
  }
}

/** 단위를 렌더러가 쓰는 단위(px, deg, 배율)로 바꾼다. */
function convertUnit(
  value: number,
  prop: TrackProp,
  unit: TrackUnit,
  canvas: CanvasConfig,
): number {
  return value * unitScale(prop, unit, canvas)
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
    case 'rotateX':
      t.rotateX = applyOp(t.rotateX, value, op)
      return
    case 'rotateY':
      t.rotateY = applyOp(t.rotateY, value, op)
      return
    case 'reveal':
      t.reveal = applyOp(t.reveal, value, op)
      return
    case 'charIn':
      t.charIn = applyOp(t.charIn, value, op)
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
    case 'blur':
      // 음수 흐림은 없다. add 결합에서 내려간 값이 또렷함 아래로 뚫지 않게 여기서 자른다.
      t.blur = Math.max(0, applyOp(t.blur, value, op))
      return
    case 'anchorX':
      t.anchorX = applyOp(t.anchorX, value, op)
      return
    case 'anchorY':
      t.anchorY = applyOp(t.anchorY, value, op)
      return
  }
}

/**
 * 이 레이어가 실제로 돌 배수.
 *
 * 문서에 적힌 값을 그대로 쓰지 않고 두 번 조인다.
 *   - 주기 하나가 2프레임보다 짧아지면 정수 프레임 격자에서 모션이 뭉개진다.
 *     24프레임 문서에 12배를 걸면 주기가 2프레임이고, 그 아래는 의미가 없다.
 *   - 정수가 아니면 마지막 주기가 잘려 반복 이음새에 값 도약이 새로 생긴다
 *     (core/types.ts Layer.motionRepeat 주석).
 *
 * 값이 없거나 1 이면 1 이다. 그때는 아래 매핑이 항등이라 옛 문서의 픽셀이 바뀌지 않는다.
 */
export function effectiveRepeat(layer: Layer, durationFrames: number): number {
  const raw = layer.motionRepeat
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return 1
  const wanted = Math.floor(raw)
  if (wanted <= 1) return 1
  const cap = Math.floor(durationFrames / 2)
  return Math.max(1, Math.min(wanted, cap))
}

export function resolveLayerTransform(
  layer: Layer,
  frame: number,
  canvas: CanvasConfig,
  durationFrames = 1,
): ResolvedTransform {
  /*
   * 레이어 로컬 시간.
   *
   *   period     = durationFrames / repeat   (한 주기의 문서 프레임 수)
   *   localFrame = (frame % period) * repeat
   *
   * 이 매핑은 한 주기를 트랙의 전 구간 [0, durationFrames] 로 정확히 펼친다.
   * 프리셋은 이음새 없는 모션의 마지막 키를 durationFrames 에 둔다 (presets/shared.ts
   * lastFrame). 그래서 주기 끝에서 트랙이 첫 키의 값으로 정확히 돌아오고, 새 이음새가
   * 생기지 않는다.
   *
   * 모디파이어는 프레임이 아니라 durationFrames 쪽을 줄여서 넘긴다. 그쪽은 t 를
   * `(effectiveFrame(frame, hold) % duration) / duration` 으로 만드는데(generators.ts),
   * 홀드 클럭은 문서 시간에 있어야 한다. 프레임에 배수를 곱하면 자글자글의 "2컷,
   * 3컷" 이 배수를 따라 잘아져서 홀드 정렬 검사(core/loopSeam.ts)가 거짓이 된다.
   *
   * motionLoop 는 이 매핑의 모양만 바꾼다.
   *   pingPong  주기 앞 절반에 트랙 전 구간을 순방향으로, 뒤 절반에 역방향으로 편다.
   *             주기 끝 값 = 시작 값이라 이음새가 저절로 이어진다.
   *   once      첫 주기만 돌고 그 뒤로는 트랙 끝 값에 멈춘다 (evalTrack 은 구간 밖을
   *             양 끝 값으로 클램프한다).
   * 모디파이어의 프레임은 접지 않는다. 왕복에서 삼각파 프레임을 넘기면 클럭이 두 배로
   * 흘러 홀드 격자("2컷, 3컷")가 잘아지고, 전체 길이에 깔린 감쇠 엔벌로프의 꼬리가
   * 영영 샘플되지 않는다. 배수(repeat) 분기가 원래 그렇듯 흔들림은 문서 시간을 지키고,
   * once 만 주기 끝에서 멈춰 세운다. 멈춘 모션 위에서 흔들림만 계속되면 안 되기 때문이다.
   */
  const repeat = effectiveRepeat(layer, durationFrames)
  const period = repeat > 1 ? durationFrames / repeat : durationFrames
  const loopMode = layer.motionLoop
  let localFrame: number
  let modifierFrame = frame
  if (loopMode === 'pingPong') {
    const pos = period > 0 ? (frame % period) / period : 0
    const tri = pos < 0.5 ? pos * 2 : (1 - pos) * 2
    localFrame = tri * durationFrames
  } else if (loopMode === 'once') {
    const clamped = Math.min(frame, period)
    localFrame = clamped * repeat
    modifierFrame = clamped
  } else {
    localFrame = repeat > 1 ? (frame % period) * repeat : frame
  }

  const t = identityTransform()
  t.anchorX = layer.anchor[0]
  t.anchorY = layer.anchor[1]
  // 캔버스 해상도를 바꾼 만큼의 고정 배율. 트랙 결합과 섞이면 안 되므로 별도 채널이다.
  t.baseScale =
    typeof layer.baseScale === 'number' && layer.baseScale > 0 ? layer.baseScale : 1
  // 원근 거리도 애니메이션되지 않는 값이라 같은 자리에서 옮긴다.
  if (typeof layer.perspective === 'number' && Number.isFinite(layer.perspective)) {
    t.perspective = Math.max(0, layer.perspective)
  }

  for (const track of layer.tracks) {
    const raw = evalTrackAt(track, localFrame)
    if (raw === undefined) continue
    const value = convertUnit(raw, track.prop, track.unit, canvas)
    writeChannel(t, track.prop, value, track.composite ?? DEFAULT_COMPOSITE[track.prop])
  }

  // 모디파이어는 트랙 결합이 끝난 뒤에 얹는다. 흔들림은 "이미 정해진 위치" 위에
  // 더해지는 것이지 위치를 대체하는 것이 아니다.
  // 오버스캔 솔버는 이보다 더 뒤에 돈다.
  for (const m of layer.modifiers) {
    const value = evalModifier(m, {
      frame: modifierFrame,
      durationFrames: period,
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
 * v1 의 parentId 는 패럴랙스 전용이다. 회전과 배율은 물려받지 않는다.
 * 상속 대상을 이동으로 한정한 것은, 유일한 소비자가 parallax.dual 프리셋이기 때문이다.
 * 애프터이펙트식 전체 부모 변환(회전/배율 상속)은 v2 다.
 * UI 는 이 필드를 "깊이감" 으로 부르고 부모-자식이라는 말을 쓰지 않는다.
 */
/**
 * 오브제 등장의 이동 거리를 재는 자(px).
 *
 * 글자는 글자 크기 배수로 재고, 오브제는 화면에서 차지하는 자기 상자 배수로
 * 잰다. 거리 1.4 면 "제 폭의 1.4 배 밖에서 들어온다" 는 뜻이라, 큰 그림도 작은
 * 그림도 화면 밖에서 출발한다. 캔버스 크기로 재면 작은 도형이 저 멀리서 순간이동해
 * 오는 것처럼 보인다.
 *
 * 애니메이션 배율(scaleX / scaleY)은 일부러 뺀다. 넣으면 이동량이 배율에 딸려
 * 움직여서, 담기 솔버가 기대는 "꼭짓점 = 위치 + c·D" 라는 1차식이 깨진다
 * (overscan.ts containScaleAt).
 */
function objectRefSize(
  doc: CompositionSnapshot,
  layer: Layer,
  canvas: CanvasConfig,
): { w: number; h: number } {
  const intrinsic = layerIntrinsicSize(layer, (assetId) => {
    const asset = doc.assets.find((a) => a.id === assetId)
    return asset ? { width: asset.naturalW, height: asset.naturalH } : undefined
  })
  // 원본 크기가 없는 레이어(솔리드)는 캔버스를 채운다고 본다.
  if (!intrinsic || intrinsic.width <= 0 || intrinsic.height <= 0) {
    return { w: canvas.w, h: canvas.h }
  }
  const fit = baseFitScale(layer.fit, canvas.w, canvas.h, intrinsic.width, intrinsic.height)
  const k = typeof layer.baseScale === 'number' && layer.baseScale > 0 ? layer.baseScale : 1
  return { w: intrinsic.width * fit.sx * k, h: intrinsic.height * fit.sy * k }
}

/**
 * 글자가 아닌 레이어의 등장을 레이어 변환에 접어 넣는다.
 *
 * 이것이 "글자 모션을 이미지와 도형에도" 의 전부다. 오브제를 글자 한 개짜리 글
 * 상자로 보면 규칙이 한 벌로 끝난다. 렌더러는 한 줄도 바뀌지 않는다.
 *
 * 글자 레이어는 여기서 아무 일도 하지 않는다. 글자는 상자 안에서 글자마다 따로
 * 움직여야 해서 렌더러가 직접 계산한다. 여기서도 걸면 두 번 먹어 상자째로 날아간다.
 *
 * 담기 / 채우기 솔버가 이 결과를 본다. 솔버는 resolveLayerTransformWithParents
 * 를 불러 배율을 푸는데, 접어 넣는 자리를 여기보다 뒤(resolveComposition)로 미루면
 * 솔버가 등장 구간을 못 봐서, 담기를 켜 둔 그림이 등장할 때만 프레임 밖으로 튀어
 * 나간다. 일부러 밖에서 들어오는 프리셋은 overscan: 'allowEmpty' 로 솔버를 끈다.
 */
function applyObjectCharAnim(
  doc: CompositionSnapshot,
  layer: Layer,
  t: ResolvedTransform,
): void {
  if (layer.text) return
  if (!charAnimIsActive(layer.charAnim)) return
  // 다 들어온 뒤에는 계산도 에셋 조회도 하지 않는다. 대부분의 프레임이 여기다.
  if (!Number.isFinite(t.charIn) || t.charIn >= 1) return

  const ct = objectCharTransform(layer.charAnim, t.charIn)
  const ref = objectRefSize(doc, layer, doc.canvas)

  t.translateX += ct.tx * ref.w
  t.translateY += ct.ty * ref.h
  t.rotate += ct.rotate
  t.scaleX *= ct.scale * ct.scaleX
  t.scaleY *= ct.scale
  t.opacity *= ct.opacity
}

export function resolveLayerTransformWithParents(
  doc: CompositionSnapshot,
  layer: Layer,
  frame: number,
): ResolvedTransform {
  const duration = doc.timeline.durationFrames
  const own = resolveLayerTransform(layer, frame, doc.canvas, duration)
  if (!layer.parentId) {
    applyObjectCharAnim(doc, layer, own)
    return own
  }

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

  applyObjectCharAnim(doc, layer, own)
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

    /*
     * 레이어 구간(컷).
     *
     * 구간 밖이면 아예 그리지 않고, 구간 안쪽 페이드는 투명도에 곱한다.
     * 구간이 없는 레이어는 gate 가 언제나 1 이라 옛 문서의 픽셀이 바뀌지 않는다.
     */
    const gate = layerTimeGate(layer, frame)
    if (gate < 1) transform.opacity *= gate

    /*
     * 폴더에 담긴 레이어.
     *
     * 투명도와 보임 여부와 구간만 여기서 물려받는다. 이동/회전/배율은 채널이
     * 아니라 매트릭스로 얹는다 (core/group.ts 머리주석). 폴더의 가로세로 배율이
     * 다르고 안쪽이 돌아가 있으면 채널로는 만들 수 없는 기울임이 생기기 때문이다.
     *
     * 폴더의 투명도에는 폴더 자신의 구간 페이드가 이미 곱해져 있다. 그래서 곱하기
     * 한 번으로 "폴더가 사라지면 안쪽도 사라진다" 가 따라온다.
     */
    let folderVisible = true
    // 색 덧씌우기는 가장 가까운 것 하나만 이긴다. 자기 것 > 안쪽 폴더 > 바깥 폴더.
    let tintSpec = layer.tint && layer.tint.amount > 0 ? layer.tint : undefined
    for (const folder of folderChain(doc.layers, layer)) {
      const folderTransform = resolveLayerTransformWithParents(doc, folder, frame)
      const folderGate = layerTimeGate(folder, frame)
      transform.opacity *= folderTransform.opacity * folderGate
      if (!folder.visible || folderGate <= 0) folderVisible = false
      if (!tintSpec && folder.tint && folder.tint.amount > 0) tintSpec = folder.tint
    }
    // 렌더러가 프레임마다 문자열을 파싱하지 않도록 여기서 숫자로 푼다.
    let tint: ResolvedLayer['tint']
    if (tintSpec) {
      const [r, g, b] = parseHexColor(tintSpec.color)
      tint = { r, g, b, amount: Math.min(1, Math.max(0, tintSpec.amount)) }
    }

    resolved.push({
      layerId: layer.id,
      assetId: layer.assetId,
      visible: layer.visible && folderVisible && gate > 0,
      z: layer.z,
      fit: layer.fit,
      blend: layer.blend,
      transform,
      effects: layer.effects,
      ...(isFolderLayer(layer) ? { isFolder: true } : {}),
      ...(layer.folderId ? { folderId: layer.folderId } : {}),
      ...(layer.clipToBelow === true ? { clipToBelow: true } : {}),
      // 도형이 아닌 레이어에는 키 자체를 만들지 않는다. JSON 비교로 결정론을
      // 확인하는 테스트가 있어서 undefined 를 실어 보내도 결과는 같지만,
      // 뜻이 없는 키를 남기지 않는 편이 읽기 쉽다.
      ...(layer.shape ? { shape: layer.shape } : {}),
      ...(layer.text ? { text: layer.text } : {}),
      ...(layer.particle ? { particle: layer.particle } : {}),
      /*
       * 글자 등장은 글자 레이어에만 싣는다.
       *
       * 오브제는 applyObjectCharAnim 이 이미 변환에 접어 넣었다. 여기서도 실어 보내면
       * 렌더러가 두 번 걸 여지가 생긴다. 'none' 이면 어느 쪽이든 싣지 않아서 렌더러가
       * 글자별 계산을 통째로 건너뛴다.
       */
      ...(layer.text && layer.charAnim && layer.charAnim.mode !== 'none'
        ? { charAnim: layer.charAnim }
        : {}),
      // 가리기도 같은 규칙이다. 'none' 이면 아예 싣지 않아 렌더러가 유니폼조차 만지지 않는다.
      ...(layer.reveal && layer.reveal.mode !== 'none' ? { reveal: layer.reveal } : {}),
      ...(tint ? { tint } : {}),
    })
  }
  resolved.sort((a, b) => a.z - b.z)
  return resolved
}
