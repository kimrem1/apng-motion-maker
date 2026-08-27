/**
 * 오버스캔 / 세이프존 솔버.
 *
 * 문제: 이미지를 움직이거나 돌리면 캔버스 모서리가 빈다. 500px 캔버스에서 45도만 돌려도
 * 네 모서리가 전부 투명해진다(실측 확인). 이걸 막으려면 배율을 미리 키워 둬야 한다.
 *
 * 핵심 정의: cover 기준 배율 s0 = max(W/Iw, H/Ih) 일 때가 k = 1.0 이고,
 * 그 상태가 "이미지가 캔버스를 최소로 덮는" 지점이다. 그래서 안전 판정이
 * "전 구간 k >= 1" 이라는 한 줄로 끝난다.
 *
 * 채우기 / 담기 모두 렌더러의 buildLayerMatrix 를 그대로 다시 만들어 재는
 * **매트릭스 기반**이다 (coverScaleAt / containScaleAt). 렌더러는 기준점(anchor)을
 * 축으로 회전 / 배율을 걸기 때문에 (transform.ts), "회전이 이미지 중심을 돈다" 고
 * 가정한 닫힌 AABB 식은 기준점이 중앙을 벗어난 순간 이미지 중심의 이동항
 * (I - c·R)·S_base·q 를 통째로 놓친다 (기준점 (0,0) + 45도 회전에서 보정 후에도
 * 캔버스 꼭짓점이 500px 비는 실측). 매트릭스를 다시 만들면 렌더러와 어긋날 수
 * 없다. 배율 채널만 0 으로 둔 매트릭스에서는 네 꼭짓점이 기준점 자리 한 점으로
 * 붕괴하므로 꼭짓점 = p0 + c·D 라는 배율 c 의 1차식이 성립하고, 두 솔버 모두
 * 이분 탐색 없이 닫힌 형태로 풀린다.
 *
 * 세 가지를 특히 조심한다.
 *
 * 1. 키프레임 값만 검사하면 틀린다. back / spring / elastic 이징은 값이 [v0, v1] 밖으로
 *    벗어난다. scale 1.0 -> 1.2 에 오버슈트를 걸면 중간에 1.25 까지 갔다 온다.
 *    그래서 반드시 시간축 샘플링으로 최대화한다.
 * 2. 솔버는 채널 결합이 끝난 뒤에 돈다. 프리셋마다 따로 계산하면
 *    합쳐졌을 때 이동량이 커져 다시 캔버스가 빈다.
 * 3. 결과는 시간에 따라 변하지 않는 상수 배율이다. 프레임마다 다른 보정을 걸면
 *    사용자가 만든 속도감이 뭉개진다. 전 구간 최댓값 하나를 곱한다.
 */

import type {
  CompositionSnapshot,
  FitMode,
  Layer,
  ResolvedTransform,
  SafeZonePolicy,
} from './types.ts'
import {
  baseFitScale,
  buildGroupMatrix,
  buildLayerMatrix,
  mat3Multiply,
  perspectiveZMax,
  type Mat3,
} from './transform.ts'
import { effectiveRepeat, resolveLayerTransformWithParents } from './evaluate.ts'
import { folderChain } from './group.ts'
import { layerIntrinsicSize } from './shape.ts'
import { modifierPeak } from '@/motions/generators.ts'

/** 서브픽셀 리샘플링 때문에 s = s_min 정확히에서 가장자리에 반투명 1px 라인이 생긴다. */
const DEFAULT_MARGIN = 0.005

/** 균등 샘플 수. 키프레임 시각과 출력 프레임 시각을 여기에 합집합으로 더한다. */
const DEFAULT_SAMPLES = 240

/** 이 배율을 넘으면 원본이 부족하다고 보고 배경 채우기를 제안한다. */
export const UPSCALE_SUGGEST_THRESHOLD = 1.05

/**
 * 담기 배율의 하한. 이보다 더 줄여야 하는 상황은 담기로 풀 수 없다.
 *
 * 이동이 캔버스 반쪽을 넘어가면 배율을 아무리 낮춰도 그림이 프레임 밖에 있다.
 * 그때는 0 에 수렴하는 배율이 나오는데, 점으로 사라지는 것보다 조금 잘리는 편이
 * 낫다. 여기서 끊고 진단으로 알린다.
 */
const CONTAIN_MIN_SCALE = 0.2

/**
 * 채우기 배율 보정의 상한. 담기의 CONTAIN_MIN_SCALE 과 거울상이다.
 *
 * 원근이 판을 모서리에 가깝게 눕히면 필요 배율이 발산한다. 무한대를 물릴 수는
 * 없으니 여기서 끊고 clipped 로 진단한다. 20 은 옛 닫힌 식이 쓰던 원근 발산 바닥
 * (perspectiveShrink 의 최소 특이값 0.05 = 최대 20배)을 승계한 값이다.
 */
const COVER_MAX_RATIO = 20

export interface OverscanNeed {
  /**
   * 이 레이어에 어떤 솔버가 걸렸는가.
   *   cover   캔버스를 덮어야 한다. correction >= 1
   *   contain 원본이 잘리면 안 된다. correction <= 1
   *   none    아무도 개입하지 않는다. correction === 1
   */
  mode: 'cover' | 'contain' | 'none'
  /**
   * 보정이 한계에 걸려 목표를 다 못 이뤘는가.
   *   cover   기하적으로 못 덮는 방향이 있거나(기준점이 이미지 가장자리에 붙은 채
   *           도는 경우) 필요 배율이 상한(COVER_MAX_RATIO)을 넘어, 보정 후에도
   *           비는 프레임이 남는다.
   *   contain 하한(CONTAIN_MIN_SCALE)에 걸려 여전히 잘린다.
   */
  clipped: boolean
  /** 캔버스를 채우기 위해 필요한 절대 배율의 최댓값 */
  sRequired: number
  /** s0 대비 필요한 상대 배율. 1 이하면 솔버가 개입하지 않는다. */
  kRequired: number
  /** 현재 애니메이션이 실제로 만드는 최대 상대 배율 */
  kMax: number
  /** 트랙에 곱해야 하는 보정 계수. 1 이면 보정 없음. */
  correction: number
  /** 보정 후 실제 샘플링 배율. 1 을 넘으면 원본을 확대하게 된다. */
  usedScale: number
  /** 화질 손실 없이 가려면 필요한 원본 긴 변 픽셀 수 */
  recommendedSourcePx: number
  /** 원본이 부족한가 */
  needsUpscale: boolean
  /** 어느 시각에서 최댓값이 나왔는가. 타임라인 마커용. */
  worstFrame: number
}

/**
 * 한 시점의 변환에서 캔버스를 덮는 데 필요한 절대 배율의 **중심 기준점 근사**.
 *
 * 회전 / 배율이 이미지 중심을 축으로 돈다고 가정한 닫힌 식이다. 렌더러는
 * 기준점(anchor)을 축으로 돌기 때문에 (transform.ts buildLayerMatrix), 기준점이
 * 중앙(0.5, 0.5)일 때만 정확하다. 그래서 솔버는 이 함수 대신 렌더러와 같은
 * 매트릭스로 재는 coverScaleAt 을 쓴다. 이 함수는 기준점이 중앙인 상황의 빠른
 * 추정과 테스트 대조용으로만 남긴다.
 *
 * 회전이 있으면 이미지 로컬 좌표계로 넘어가 캔버스를 -θ 회전시킨 AABB 를 쓴다.
 *   W' = |W cosθ| + |H sinθ|,  H' = |W sinθ| + |H cosθ|
 *   tx' =  tx cosθ + ty sinθ,  ty' = -tx sinθ + ty cosθ
 *   s_min = max( (W' + 2|tx'|) / Iw , (H' + 2|ty'|) / Ih )
 *
 * skew 는 정확한 해가 복잡하다. tan 만큼 폭이 늘어나는 것으로 보수적으로 근사한다.
 * 과하게 잡히는 쪽이라 캔버스가 비는 일은 없다.
 *
 * 3D 회전도 같은 방식이다. 원근 투영은 가까운 쪽을 키우고 먼 쪽을 줄이는데,
 * 캔버스를 채우려면 가장 많이 줄어든 곳을 기준으로 잡아야 한다. 그래서 각도가
 * 만드는 최소 배율의 역수를 곱한다. 이것도 과하게 잡히는 쪽이다.
 */
export function requiredScaleAt(
  canvasW: number,
  canvasH: number,
  imageW: number,
  imageH: number,
  t: ResolvedTransform,
): number {
  if (imageW <= 0 || imageH <= 0) return 1

  const rad = (t.rotate * Math.PI) / 180
  const c = Math.abs(Math.cos(rad))
  const s = Math.abs(Math.sin(rad))

  const wPrime = canvasW * c + canvasH * s
  const hPrime = canvasW * s + canvasH * c

  const cosR = Math.cos(rad)
  const sinR = Math.sin(rad)
  const txPrime = Math.abs(t.translateX * cosR + t.translateY * sinR)
  const tyPrime = Math.abs(-t.translateX * sinR + t.translateY * cosR)

  // skew 보정. 기울인 만큼 반대 축 길이가 밀려 들어온다.
  const lim = 89.5
  const kx = Math.abs(Math.tan((Math.min(lim, Math.abs(t.skewX)) * Math.PI) / 180))
  const ky = Math.abs(Math.tan((Math.min(lim, Math.abs(t.skewY)) * Math.PI) / 180))

  const needW = (wPrime + hPrime * kx + 2 * txPrime) / imageW
  const needH = (hPrime + wPrime * ky + 2 * tyPrime) / imageH
  return Math.max(needW, needH) / perspectiveShrink(imageW, imageH, t)
}

/**
 * 3D 회전이 만드는 최소 선형 배율. 1 이면 회전이 없다는 뜻이다.
 *
 * min(cos) 이 아니라 최소 특이값이다
 *
 * 호모그래피의 어파인 부분은 [[cosβ, 0], [sinα·sinβ, cosα]] 이고, 대각 성분 말고
 * 전단 성분 sinα·sinβ 가 있다. 한 축만 돌면 그 항이 0 이라 min(|cosα|, |cosβ|)
 * 가 정확한 답이지만, 두 축이 동시에 돌면 틀린다. 예를 들어 두 각이 모두 60도면
 * 실제 최소 배율은 0.25 인데 min(cos) 은 0.5 를 준다. 정확히 두 배 낙관이고,
 * 그만큼 캔버스가 빈다.
 *
 * 2x2 행렬의 최소 특이값은 닫힌 형태로 나온다. 한 축만 도는 경우에는 이 식이
 * min(|cosα|, |cosβ|) 와 정확히 같은 값을 주므로 기존 계산이 달라지지 않는다.
 */
function perspectiveShrink(imageW: number, imageH: number, t: ResolvedTransform): number {
  if (t.rotateX === 0 && t.rotateY === 0) return 1

  const a = (t.rotateX * Math.PI) / 180
  const b = (t.rotateY * Math.PI) / 180
  const ca = Math.cos(a)
  const cb = Math.cos(b)
  const shear = Math.sin(a) * Math.sin(b)

  // [[cb, 0], [shear, ca]] 의 특이값. sigma = |Q - R|, |Q + R|.
  const e = (cb + ca) / 2
  const f = (cb - ca) / 2
  const g = shear / 2
  const q = Math.hypot(e, g)
  const r = Math.hypot(f, g)

  // 각도가 90도에 붙으면 배율이 발산한다. 솔버가 무한대를 물지 않게 바닥을 둔다.
  let k = Math.max(Math.abs(q - r), 0.05)

  const distRatio = Number.isFinite(t.perspective) ? Math.max(0, t.perspective) : 0
  if (distRatio > 0) {
    const d = distRatio * Math.max(imageW, imageH)
    // 기준점이 가운데가 아니면 로컬 좌표가 한쪽으로 더 멀리 뻗는다 (transform.ts).
    const zMax = perspectiveZMax(t.rotateX, t.rotateY, imageW, imageH, t.anchorX, t.anchorY)
    k /= 1 + zMax / Math.max(d, 1e-6)
  }
  return k
}

/**
 * fit 기준 배율에 레이어 고정 배율(Layer.baseScale)을 곱한 값.
 * 렌더러가 쓰는 것과 같은 배율이어야 솔버가 다른 그림을 재지 않는다.
 */
function layerBaseScale(
  layer: Layer,
  canvasW: number,
  canvasH: number,
  imageW: number,
  imageH: number,
): { sx: number; sy: number } {
  const fit = baseFitScale(layer.fit, canvasW, canvasH, imageW, imageH)
  const k = typeof layer.baseScale === 'number' && layer.baseScale > 0 ? layer.baseScale : 1
  return { sx: fit.sx * k, sy: fit.sy * k }
}

/** 이 레이어가 오버스캔 대상인가. */
export function isSolverTarget(layer: Layer, policy: SafeZonePolicy): boolean {
  if (policy === 'allowEmpty') return false
  if (!layer.fillsCanvas) return false
  if (!layer.visible) return false
  // contain / none 은 애초에 캔버스를 채울 의도가 아니다.
  return layer.fit === 'cover' || layer.fit === 'fill'
}

/**
 * 이 레이어가 담기 대상인가.
 *
 * 채우기와 배타다. 채우기가 켜져 있으면 그쪽이 이긴다. 두 솔버가 같은 레이어에
 * 걸리면 하나는 배율을 올리고 하나는 내려 결과가 정의되지 않는다.
 */
export function isContainTarget(layer: Layer): boolean {
  if (!layer.keepInside) return false
  if (layer.fillsCanvas) return false
  if (!layer.visible) return false
  // 일부러 화면 밖으로 나가는 모션에는 개입하지 않는다.
  return !layer.motionExitsFrame
}

/**
 * 검사할 시각 목록.
 * 균등 샘플만 쓰면 오버슈트의 꼭짓점을 놓칠 수 있고, 키프레임만 쓰면 그 사이를 놓친다.
 * 출력 프레임 시각도 넣어야 "실제로 저장될 그림"에서 비는 일이 없다.
 */
export function sampleFrames(doc: CompositionSnapshot, layer: Layer, count = DEFAULT_SAMPLES): number[] {
  const last = Math.max(1, doc.timeline.durationFrames - 1)
  const set = new Set<number>()

  for (let i = 0; i <= count; i += 1) set.add((i / count) * last)
  for (let f = 0; f <= last; f += 1) set.add(f)

  /*
   * 키프레임 자리는 **문서 좌표로 되돌려서** 넣는다.
   *
   * 레이어 배수가 걸리면 키 f 는 문서 프레임 f 에 오지 않는다. 한 주기가
   * durationFrames / repeat 이므로 f / repeat 에 오고, 그것이 주기마다 반복된다.
   * 키 좌표를 그대로 넣으면 오버슈트 꼭짓점을 통째로 놓쳐서 담기 솔버가 배율을
   * 덜 낮추고, 빠르게 도는 레이어만 가장자리가 잘린다.
   *
   * 반프레임 자리를 함께 보는 이유는 렌더러가 프레임 **한가운데** 시각을 그리기
   * 때문이다 (export/pipeline.ts renderFrameSink 의 frame + 0.5). 정수 프레임만
   * 보면 실제로 저장되는 그림을 안 보는 셈이 된다.
   */
  const repeat = effectiveRepeat(layer, doc.timeline.durationFrames)
  const period = doc.timeline.durationFrames / repeat
  for (const track of layer.tracks) {
    for (const key of track.keys) {
      // 오버슈트 꼭짓점은 키 직후에 온다. 세그먼트 앞쪽을 촘촘히 본다.
      for (const localOffset of [0, 0.25, 0.5]) {
        const local = (key.f + localOffset) / repeat
        for (let cycle = 0; cycle < repeat; cycle += 1) set.add(local + cycle * period)
      }
    }
  }

  return [...set].filter((f) => f >= 0 && f <= last).sort((a, b) => a - b)
}

/**
 * 모디파이어(흔들림/자글자글)가 더할 수 있는 이론적 최대 변위.
 *
 * 실측하지 않고 상수로 더한다. 시드를 바꿀 때마다 배율이 달라지면
 * 사용자 눈에는 이유 없이 그림 크기가 흔들리는 것으로 보인다.
 */
export function modifierHeadroom(layer: Layer): { translate: number; rotateDeg: number } {
  let translate = 0
  let rotateDeg = 0
  for (const m of layer.modifiers) {
    // 상한 계산은 생성기와 한 곳에서만 정의한다. 두 벌이 되면 언젠가 갈라지고,
    // 그 결과는 "가끔 캔버스가 비는" 재현 불가 버그다.
    const peak = modifierPeak(m)
    if (m.target === 'translateX' || m.target === 'translateY') translate = Math.max(translate, peak)
    else if (m.target === 'rotate') rotateDeg = Math.max(rotateDeg, peak)
  }
  return { translate, rotateDeg }
}

export interface SolveOptions {
  policy?: SafeZonePolicy
  marginRatio?: number
  sampleCount?: number
}

/**
 * 한 시점에서 이미지가 캔버스 안에 들어가려면 배율에 얼마를 곱해야 하는가.
 * 1 이상이면 이미 들어가 있다는 뜻이다.
 *
 * 보정은 배율 채널에만 곱한다. 즉 형상은 줄어들고 위치는 그대로다. 그래서
 * 모서리 좌표를 배율 c 의 함수로 쓰면 corner(c) = pos + c * D 라는 1차식이 되고,
 * 축마다 부등식 두 개를 풀면 c 가 닫힌 형태로 나온다. 이분 탐색이 필요 없다.
 *
 * pos 와 D 를 손으로 유도하지 않는다. 배율만 0 으로 둔 매트릭스를 한 번 더 만들면
 * 형상이 한 점으로 collapse 되어 이동 성분만 남는다. 그것이 pos 다. 회전 / 기울임 /
 * 앵커 / fit 기준 배율을 여기서 다시 계산하지 않으므로 렌더러와 어긋날 수 없다.
 *
 * 3D 회전이 있어도 1차식이 유지된다
 *
 * 원근 나눗셈은 배율 안쪽에서 일어난다 (transform.ts buildLayerMatrix 주석).
 * 그래서 꼭짓점의 w 성분은 c 와 무관하고, 나눈 뒤에도 좌표는 여전히 c 의 1차식이다.
 * 나눗셈만 여기서 한 번 해 주면 나머지 논리는 그대로다. 3D 회전이 없으면 w 가
 * 정확히 1 이므로 옛 문서에서는 나눗셈이 아무 일도 하지 않는다.
 */
function containScaleAt(
  canvasW: number,
  canvasH: number,
  imageW: number,
  imageH: number,
  t: ResolvedTransform,
  fit: FitMode,
  group?: Mat3,
): number {
  // fit 과 baseScale 을 미리 곱해 넘기면 안 된다. 기준점 보정이 그 둘로 계산되므로
  // (transform.ts buildLayerMatrix), 접어 넣는 순간 솔버가 렌더러와 다른 위치를 본다.
  const full = buildLayerMatrix(t, fit, canvasW, canvasH, imageW, imageH)
  const origin = buildLayerMatrix(
    { ...t, scaleX: 0, scaleY: 0 },
    fit,
    canvasW,
    canvasH,
    imageW,
    imageH,
  )
  /*
   * 폴더는 바깥에 곱한다. 렌더러와 정확히 같은 자리여야 한다.
   *
   * 폴더 매트릭스는 어파인이라 1차식이 그대로다.
   *   G·(pos + c·D) = G_선형·pos + G_이동 + c·G_선형·D
   * 마지막 행도 [0,0,1] 이라 w 성분이 바뀌지 않는다. 아래에서 "두 매트릭스의
   * 마지막 행이 같다" 고 가정하는 부분이 그래서 그대로 유효하다.
   */
  if (group) {
    mat3Multiply(group, full, full)
    mat3Multiply(group, origin, origin)
  }
  const halfW = canvasW / 2
  const halfH = canvasH / 2

  let c = Infinity
  // 유닛 사각형의 네 꼭짓점. buildLayerMatrix 의 입력 좌표계와 같다.
  const corners: [number, number][] = [
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1],
  ]
  for (const [u, v] of corners) {
    // 두 매트릭스의 마지막 행은 같다. 배율은 원근 나눗셈에 영향을 주지 않는다.
    const w = full[2]! * u + full[5]! * v + full[8]!
    // 꼭짓점이 카메라 뒤로 넘어갔다. 어떤 배율로도 담기지 않는다.
    if (!(w > 1e-9)) return 0

    const posX = (origin[0]! * u + origin[3]! * v + origin[6]!) / w
    const posY = (origin[1]! * u + origin[4]! * v + origin[7]!) / w

    const dx = (full[0]! * u + full[3]! * v + full[6]!) / w - posX
    const dy = (full[1]! * u + full[4]! * v + full[7]!) / w - posY

    // posX + c*dx <= halfW  그리고  posX + c*dx >= -halfW
    if (dx > 1e-9) c = Math.min(c, (halfW - posX) / dx)
    else if (dx < -1e-9) c = Math.min(c, (-halfW - posX) / dx)

    if (dy > 1e-9) c = Math.min(c, (halfH - posY) / dy)
    else if (dy < -1e-9) c = Math.min(c, (-halfH - posY) / dy)
  }

  // 중심이 이미 프레임 밖이면 어떤 양수 배율로도 담기지 않는다.
  if (!Number.isFinite(c) || c < 0) return 0
  return c
}

/**
 * 한 시점에서 캔버스를 덮으려면 배율 채널에 얼마를 곱해야 하는가.
 * c 가 1 이하면 이미 덮고 있다는 뜻이다. containScaleAt 의 거울상이다.
 *
 * 같은 요령으로 매트릭스를 두 번 만들어 꼭짓점 = p0 + c·D 라는 1차식을 얻는다.
 * 배율 채널이 0 이면 네 꼭짓점이 전부 기준점 자리(p0) 한 점으로 붕괴하므로,
 * D 는 "기준점에서 그 꼭짓점으로 자라는 방향" 이다. 회전 / 기울임 / 기준점 보정 /
 * fit 기준 배율을 여기서 다시 계산하지 않으므로 렌더러와 어긋날 수 없다.
 *
 * 담기와 다른 점은 부등식의 방향뿐이다. 담기는 "이미지 꼭짓점이 캔버스(축 정렬
 * 사각형) 안", 채우기는 "캔버스 꼭짓점 Q 가 이미지(볼록 사각형) 안" 이다. 이미지
 * 변은 축에 정렬돼 있지 않지만 변 벡터가 c·(D_j - D_i) 로 c 에 비례하므로,
 * 점-내부 외적 판정에서 c 하나를 나누면
 *   cross(D_j - D_i, Q - p0) - c·cross(D_j, D_i)  (감김 방향 부호를 곱해) >= 0
 * 이라는 변마다의 1차 부등식이 남는다. cover 가 필요한 c 의 하한은 이 부등식들의
 * max 로 닫힌 형태로 나온다. 이분 탐색이 필요 없다.
 *
 * 원근 나눗셈이 c 와 무관한 이유는 containScaleAt 과 같다. 원근은 배율보다
 * 안쪽에 곱해지므로 (transform.ts buildLayerMatrix) 꼭짓점의 w 가 c 와 무관하고,
 * 나눈 뒤에도 좌표는 여전히 c 의 1차식이다.
 *
 * blocked: 배율을 아무리 키워도 못 덮는 방향이 있는가.
 *
 * cross(D_j, D_i) 는 기준점(D 좌표계의 원점)과 변이 이루는 삼각형의 넓이라,
 * 기준점이 이미지 안쪽이면 항상 하한 쪽 부호다. 기준점이 이미지 가장자리에 정확히
 * 붙어 있으면(예: anchor 0,0) 그 항이 0 이 되어 부등식에서 c 가 사라진다. 이미지가
 * 기준점을 꼭짓점으로 하는 부채꼴로만 자라기 때문에, 부채꼴 밖의 캔버스 꼭짓점은
 * 어떤 배율로도 못 덮는다는 뜻이다. 그때는 덮을 수 있는 방향만 마저 채우는 하한을
 * 돌려주고 blocked 로 알린다. 담기가 "점으로 사라지는 것보다 조금 잘리는 편이
 * 낫다" 고 하한을 두는 것과 같은 원칙이다. 한없이 키워 봐야 화질만 잃는다.
 *
 * 폴더 항이 없는 이유: 채우기는 움직이는 폴더 안에서 개입하지 않는다
 * (solveLayerOverscan 의 주석).
 */
function coverScaleAt(
  canvasW: number,
  canvasH: number,
  imageW: number,
  imageH: number,
  t: ResolvedTransform,
  fit: FitMode,
): { c: number; blocked: boolean } {
  // fit 과 baseScale 을 미리 곱해 넘기면 안 되는 이유도 containScaleAt 과 같다.
  const full = buildLayerMatrix(t, fit, canvasW, canvasH, imageW, imageH)
  const origin = buildLayerMatrix(
    { ...t, scaleX: 0, scaleY: 0 },
    fit,
    canvasW,
    canvasH,
    imageW,
    imageH,
  )

  /*
   * p0: 배율 채널이 0 인 매트릭스는 위 두 행이 마지막 행의 상수배가 되므로,
   * 원근 나눗셈 후에는 (u,v) 와 무관하게 같은 점이 나온다. 한 번만 읽으면 된다.
   */
  const w0 = origin[8]!
  if (!(w0 > 1e-9)) return { c: 0, blocked: true }
  const p0x = origin[6]! / w0
  const p0y = origin[7]! / w0

  /*
   * 유닛 사각형의 네 꼭짓점을 **둘레 순서**로 돈다. containScaleAt 은 꼭짓점을
   * 독립으로 보므로 순서가 상관없지만, 여기는 변(외적) 판정이라 순서가 전제다.
   */
  const corners: [number, number][] = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ]
  const dx = [0, 0, 0, 0]
  const dy = [0, 0, 0, 0]
  let r2 = 0
  for (let i = 0; i < 4; i += 1) {
    const [u, v] = corners[i]!
    // 두 매트릭스의 마지막 행은 같다. 배율은 원근 나눗셈에 영향을 주지 않는다.
    const w = full[2]! * u + full[5]! * v + full[8]!
    // 꼭짓점이 카메라 뒤로 넘어갔다. 어떤 배율로도 덮이지 않는다.
    if (!(w > 1e-9)) return { c: 0, blocked: true }
    const x = (full[0]! * u + full[3]! * v + full[6]!) / w - p0x
    const y = (full[1]! * u + full[4]! * v + full[7]!) / w - p0y
    dx[i] = x
    dy[i] = y
    r2 = Math.max(r2, x * x + y * y)
  }

  // 부호 있는 넓이로 감김 방향을 읽는다. 뒤집힘(음수 배율)도 이 부호가 흡수한다.
  let area2 = 0
  for (let i = 0; i < 4; i += 1) {
    const j = (i + 1) % 4
    area2 += dx[i]! * dy[j]! - dy[i]! * dx[j]!
  }
  // 판이 모서리로만 보인다(90도 원근, 배율 0). 키워 봐야 선분이라 못 덮는다.
  if (r2 <= 0 || Math.abs(area2) <= 1e-6 * r2) return { c: 0, blocked: true }
  const sign = area2 > 0 ? 1 : -1

  // 매트릭스가 Float32 라 상대 오차 1e-6 아래는 0 으로 취급한다. 여기서 아슬하게
  // 갈리는 경우는 어차피 발산 직전이라, 어느 쪽으로 판정해도 blocked 로 수렴한다.
  const scaleRef = Math.sqrt(r2)
  const epsB = 1e-6 * r2
  const epsA = 1e-6 * scaleRef * (canvasW + canvasH + Math.hypot(p0x, p0y))

  const halfW = canvasW / 2
  const halfH = canvasH / 2
  const quadX = [-halfW, halfW, halfW, -halfW]
  const quadY = [-halfH, -halfH, halfH, halfH]

  let cLo = 0
  let cHi = Infinity
  let blocked = false
  for (let i = 0; i < 4; i += 1) {
    const j = (i + 1) % 4
    const ex = dx[j]! - dx[i]!
    const ey = dy[j]! - dy[i]!
    const b = sign * (dx[j]! * dy[i]! - dy[j]! * dx[i]!)
    for (let q = 0; q < 4; q += 1) {
      const qx = quadX[q]! - p0x
      const qy = quadY[q]! - p0y
      const a = sign * (ex * qy - ey * qx)
      if (b < -epsB) {
        // a - c·b >= 0 에서 b < 0 이므로 부등호가 뒤집혀 c 의 하한이 된다.
        const lb = a / b
        if (lb > cLo) cLo = lb
      } else if (b > epsB) {
        // 기준점이 이미지 밖(0..1 밖). 키울수록 이 변이 Q 에서 멀어지므로 상한이다.
        const ub = a / b
        if (ub < cHi) cHi = ub
      } else if (a < -epsA) {
        // 변이 기준점을 지난다. 부채꼴 밖의 꼭짓점은 어떤 배율로도 못 덮는다.
        // 덮을 수 있는 나머지 방향의 하한은 계속 모은다.
        blocked = true
      }
    }
  }

  // 하한이 상한을 넘으면(기준점이 이미지 밖일 때만 생긴다) 전부 덮는 c 는 없다.
  if (cHi < cLo) blocked = true
  return { c: cLo, blocked }
}

/**
 * 모디파이어 이동 여유분의 검사 후보. 부호를 보존한 양 끝 두 점이다.
 *
 * 고정 회전에서 필요 배율은 이동의 볼록 함수(변마다 1차 부등식의 max)라,
 * [값-여유, 값+여유] 구간의 최댓값이 끝점에서 나온다. 가운데는 볼 필요가 없다.
 */
function offsetCandidates(value: number, headroom: number): number[] {
  return headroom > 0 ? [value - headroom, value + headroom] : [value]
}

/**
 * 모디파이어 회전 여유분의 검사 후보.
 *
 * 이동과 달리 회전은 끝점만 보면 안 된다. 필요 배율이 회전각의 45도(mod 90)
 * 근처에서 꼭대기를 이루므로, 구간 [값-여유, 값+여유] 이 그 지점을 지나면
 * 한가운데가 끝점보다 나쁘다. 옛 절댓값 접기(|rot|+여유)도 이걸 놓쳤다.
 * 지나는 45도 지점을 후보에 더한다. 여유가 아무리 커도 지점 수는 구간 길이에
 * 비례해 유한하고, 실제 여유(흔들림 몇 도)에서는 최대 하나다.
 */
function rotationCandidates(rotate: number, headroom: number): number[] {
  if (headroom <= 0) return [rotate]
  const out = [rotate - headroom, rotate + headroom]
  for (let k = Math.ceil((rotate - headroom - 45) / 90); 45 + 90 * k <= rotate + headroom; k += 1) {
    out.push(45 + 90 * k)
  }
  return out
}

/**
 * 이 레이어를 담고 있는 폴더들의 누적 매트릭스. 폴더가 없으면 undefined 다.
 *
 * core/group.ts 의 buildFolderMatrices 와 같은 곱셈 순서여야 한다. 저쪽은
 * 렌더러가 프레임당 한 번 쓰는 캐시이고 이쪽은 솔버가 표본 프레임마다 쓰는
 * 일회용이다. 순서가 어긋나면 솔버가 실제와 다른 자리를 재서, 폴더에 모션을 건
 * 순간 안쪽 그림이 이유 없이 작아진다.
 */
function folderMatrixAt(
  doc: CompositionSnapshot,
  layer: Layer,
  frame: number,
): Mat3 | undefined {
  const chain = folderChain(doc.layers, layer)
  if (chain.length === 0) return undefined

  // 사슬은 안쪽부터 담겨 있다. 바깥 폴더가 왼쪽에 와야 하므로 뒤에서부터 곱한다.
  let acc: Mat3 | undefined
  for (let i = chain.length - 1; i >= 0; i -= 1) {
    const t = resolveLayerTransformWithParents(doc, chain[i]!, frame)
    const g = buildGroupMatrix(t, doc.canvas.w, doc.canvas.h)
    acc = acc ? mat3Multiply(acc, g, g) : g
  }
  return acc
}

function isIdentityMatrix(m: Mat3): boolean {
  const EPS = 1e-6
  return (
    Math.abs(m[0]! - 1) < EPS &&
    Math.abs(m[4]! - 1) < EPS &&
    Math.abs(m[8]! - 1) < EPS &&
    Math.abs(m[1]!) < EPS &&
    Math.abs(m[2]!) < EPS &&
    Math.abs(m[3]!) < EPS &&
    Math.abs(m[5]!) < EPS &&
    Math.abs(m[6]!) < EPS &&
    Math.abs(m[7]!) < EPS
  )
}

export interface ContainNeed {
  /** 배율 채널에 곱할 값. 1 이면 손대지 않는다. */
  correction: number
  /** 하한에 걸려 여전히 잘리는가 */
  clipped: boolean
  /** 가장 많이 벗어난 시각. 타임라인 마커용. */
  worstFrame: number
}

/**
 * 레이어 하나가 전 구간에서 프레임 안에 들어가는 배율을 푼다.
 *
 * 오버스캔과 같은 이유로 키프레임 값만 보면 안 된다. back / spring 이징은 값이
 * [v0, v1] 밖으로 넘어가고, 흔들림 모디파이어는 키프레임에 아예 없다.
 */
export function solveLayerContain(
  doc: CompositionSnapshot,
  layer: Layer,
  imageW: number,
  imageH: number,
  options: SolveOptions = {},
): ContainNeed {
  const idle: ContainNeed = { correction: 1, clipped: false, worstFrame: 0 }
  if (imageW <= 0 || imageH <= 0) return idle

  const margin = options.marginRatio ?? doc.safeZone.marginRatio ?? DEFAULT_MARGIN
  const canvasW = doc.canvas.w
  const canvasH = doc.canvas.h

  const frames = sampleFrames(doc, layer, options.sampleCount ?? doc.safeZone.sampleCount)

  let worst = Infinity
  let worstFrame = 0

  /*
   * 채우기 솔버와 달리 모디파이어 헤드룸을 더하지 않는다.
   *
   * resolveLayerTransformWithParents 가 돌려주는 변환에는 그 프레임의 흔들림 값이
   * 이미 들어 있다. 거기에 이론적 최대 진폭을 또 더하면 40px 흔들림이 80px 로
   * 계산되어 필요한 것보다 훨씬 작게 담긴다. 채우기 쪽에서는 과하게 잡아도 이미지가
   * 조금 커질 뿐이라 눈에 띄지 않지만, 담기에서는 그림이 눈에 띄게 쪼그라든다.
   *
   * 헤드룸 없이도 정확한 이유는 표본이 실제로 그려질 프레임을 전부 포함하기
   * 때문이다. sampleFrames 는 0 부터 durationFrames-1 까지 정수 프레임을 모두 넣고,
   * 렌더러는 secToFrame 으로 정수 프레임만 그린다. 즉 여기서 재는 값이 곧 화면에
   * 나올 값이다.
   */
  for (const f of frames) {
    const t = resolveLayerTransformWithParents(doc, layer, f)
    const c = containScaleAt(
      canvasW,
      canvasH,
      imageW,
      imageH,
      t,
      layer.fit,
      folderMatrixAt(doc, layer, f),
    )
    if (c < worst) {
      worst = c
      worstFrame = f
    }
  }

  /*
   * 딱 맞게 들어가는 경우를 "이미 들어간다" 로 친다.
   *
   * cos(90도) 는 0 이 아니라 6.1e-17 이다. 그래서 90도로 돌린 정사각형의 대각선이
   * 1 을 아주 미세하게 넘고, 엄격하게 비교하면 담기가 발동해 마진만큼 0.5% 를
   * 깎는다. 아무것도 넘치지 않는 그림이 이유 없이 작아지는 것으로 보인다.
   */
  if (!Number.isFinite(worst) || worst >= 1 - 1e-6) return idle

  // worst 는 "딱 맞게 들어가는" 배율이다. 서브픽셀 리샘플링이 가장자리 1px 를
  // 깎을 수 있으므로 마진만큼 더 안으로 넣는다.
  const wanted = worst * (1 - margin)
  const correction = Math.max(CONTAIN_MIN_SCALE, wanted)
  return { correction, clipped: correction > wanted + 1e-9, worstFrame }
}

/**
 * 레이어 하나의 오버스캔 요구량을 푼다.
 * 반환값의 correction 을 scale 채널에 곱하면 전 구간에서 캔버스가 차게 된다.
 */
export function solveLayerOverscan(
  doc: CompositionSnapshot,
  layer: Layer,
  imageW: number,
  imageH: number,
  options: SolveOptions = {},
): OverscanNeed {
  const policy = options.policy ?? doc.safeZone.policy
  const margin = options.marginRatio ?? doc.safeZone.marginRatio ?? DEFAULT_MARGIN
  const canvasW = doc.canvas.w
  const canvasH = doc.canvas.h

  const base = layerBaseScale(layer, canvasW, canvasH, imageW, imageH)
  const s0 = Math.max(base.sx, base.sy)

  const idle: OverscanNeed = {
    mode: 'none',
    clipped: false,
    sRequired: s0,
    kRequired: 1,
    kMax: 1,
    correction: 1,
    usedScale: s0,
    recommendedSourcePx: Math.max(canvasW, canvasH),
    needsUpscale: false,
    worstFrame: 0,
  }

  if (!isSolverTarget(layer, policy) || imageW <= 0 || imageH <= 0) return idle

  const headroom = modifierHeadroom(layer)
  const frames = sampleFrames(doc, layer, options.sampleCount ?? doc.safeZone.sampleCount)

  /*
   * 움직이는 폴더 안에서는 채우기를 끈다.
   *
   * 솔버 자체는 이제 매트릭스 기반이라 폴더 항을 곱해 풀 수도 있다 (담기가 그렇게
   * 한다). 그래도 개입하지 않는 이유는 결과 해석 쪽이다. sRequired / kMax / 권장
   * 원본 같은 진단이 전부 "레이어 자신의 배율" 기준으로 정의되어 있어서, 폴더가
   * 그룹째로 줄이거나 움직이면 그 수치가 실제 화면과 다른 이야기를 하게 된다.
   * 틀린 진단으로 개입하는 것보다 개입하지 않는 편이 낫다.
   *
   * 정리용으로만 쓰는(움직이지 않는) 폴더에서는 예전과 똑같이 동작해야 한다.
   * 그래서 "폴더가 있다" 가 아니라 "폴더가 실제로 기하를 바꾼다" 로 가른다.
   */
  if (layer.folderId) {
    for (const f of frames) {
      const g = folderMatrixAt(doc, layer, f)
      if (g && !isIdentityMatrix(g)) return idle
    }
  }

  let sRequired = 0
  let kMax = 0
  let worstFrame = 0
  let clipped = false
  /**
   * 프레임마다 "필요 배율 / 실제 배율" 비율을 재고 그 최댓값을 쓴다.
   * coverScaleAt 이 돌려주는 c 가 바로 그 비율이다.
   *
   * 전역 최댓값끼리 나누면(sRequired / kMax) 틀린다. 필요 배율이 가장 큰 프레임과
   * 실제 배율이 가장 큰 프레임이 다르면 보정이 모자란다. 예를 들어 숨쉬기 흔들림은
   * 배율이 1 아래로 내려가는 구간이 있는데, 줌이 함께 있으면 kMax 가 커서
   * 보정이 1 로 떨어지고 정작 축소 구간에서 가장자리가 빈다.
   */
  let maxRatio = 1

  for (const f of frames) {
    // 부모의 이동까지 반영한 유효 변환을 써야 한다.
    // 자기 트랙만 보면 패럴랙스 레이어가 실제보다 덜 움직이는 것으로 계산된다.
    const t = resolveLayerTransformWithParents(doc, layer, f)

    // 실제 배율은 축별로 다를 수 있다. 작은 쪽이 빈 곳을 만든다.
    const actual = Math.min(base.sx * t.scaleX, base.sy * t.scaleY)
    /*
     * 배율이 0 을 지나는 프레임(등장 프리셋)은 어떤 유한 배수를 곱해도 0 이라
     * 못 채운다. 상수 보정에 이 프레임을 물리면 보정이 상한까지 치솟아 나머지
     * 전 구간의 화질만 망가진다. 그래서 비율 계산에서 건너뛴다.
     */
    if (actual <= 1e-9) continue

    /*
     * 모디파이어 여유분은 **부호를 보존한 채** 양 끝(±)에서 잰다.
     *
     * 절댓값으로 접으면 안 된다. 회전이 90도를 넘으면 이동의 로컬 성분 부호가
     * 뒤집혀서, |tx| 로 접은 값은 실제와 다른 자리를 잰다 (비정사각 원본 100x1000
     * + 회전 135도 + 이동 (100,-100) 에서 필요 배율 9.90 을 7.07 로 29% 과소
     * 계산해 빈 띠가 생기는 실측). 고정 회전에서 필요 배율은 이동의 볼록 함수라
     * 최댓값이 (±,±) 상자의 꼭짓점에서 나온다. 회전 여유는 양 끝에 더해, 구간이
     * 45도(mod 90) 꼭대기를 지나면 그 지점도 본다 (rotationCandidates).
     *
     * 여유분이 없으면 후보가 그 프레임 값 하나뿐이라 표본당 상수 시간이 유지된다.
     */
    let cNeed = 0
    for (const rot of rotationCandidates(t.rotate, headroom.rotateDeg)) {
      for (const tx of offsetCandidates(t.translateX, headroom.translate)) {
        for (const ty of offsetCandidates(t.translateY, headroom.translate)) {
          const probe: ResolvedTransform = { ...t, translateX: tx, translateY: ty, rotate: rot }
          const res = coverScaleAt(canvasW, canvasH, imageW, imageH, probe, layer.fit)
          if (res.blocked) clipped = true
          if (res.c > cNeed) cNeed = res.c
        }
      }
    }

    // NaN 방어를 겸한다. 상한 초과는 못 채우는 것으로 진단하고 여기서 끊는다.
    if (!(cNeed <= COVER_MAX_RATIO)) {
      clipped = true
      cNeed = COVER_MAX_RATIO
    }

    const sNeed = cNeed * actual
    if (sNeed > sRequired) {
      sRequired = sNeed
      worstFrame = f
    }
    const k = s0 > 0 ? actual / s0 : 1
    if (k > kMax) kMax = k
    if (cNeed > maxRatio) maxRatio = cNeed
  }

  if (sRequired <= 0) return idle

  const kRequired = (sRequired / s0) * (1 + margin)
  // 사용자가 만든 상대 비율은 보존하고 절대 배율만 위로 민다.
  // 프레임별 최악 비율을 쓰므로 축소 구간이 있는 프리셋도 전 구간이 찬다.
  const correction = Math.max(1, maxRatio * (1 + margin))
  const usedScale = sRequired * (1 + margin) * Math.max(1, correction / Math.max(kMax, 1e-6))
  const longSide = Math.max(canvasW, canvasH)

  return {
    mode: 'cover',
    clipped,
    sRequired,
    kRequired,
    kMax,
    correction,
    usedScale,
    recommendedSourcePx: Math.ceil(longSide * kRequired),
    needsUpscale: usedScale > 1,
    worstFrame,
  }
}

export type OverscanMap = ReadonlyMap<string, OverscanNeed>

/**
 * 컴포지션 전체를 푼다. 결과는 문서가 바뀔 때만 다시 계산하면 된다.
 * 240샘플 x 레이어 수 만큼 트랙을 평가하므로 프레임마다 부르면 안 된다.
 *
 * 레이어마다 솔버는 하나만 돈다. 채우기가 켜져 있으면 오버스캔, 담기가 켜져 있으면
 * 담기다. 둘 다 켜는 것은 스토어가 막는다.
 */
export function solveOverscan(
  doc: CompositionSnapshot,
  imageSize: (assetId: string) => { width: number; height: number } | undefined,
  options: SolveOptions = {},
): OverscanMap {
  const out = new Map<string, OverscanNeed>()
  for (const layer of doc.layers) {
    // 도형은 에셋이 없다. 자연 크기를 ShapeSpec 에서 가져온다. 렌더러도 같은 헬퍼를
    // 거치므로 솔버와 화면이 다른 크기를 볼 수 없다.
    const size = layerIntrinsicSize(layer, imageSize)
    if (!size) continue

    const cover = solveLayerOverscan(doc, layer, size.width, size.height, options)
    if (cover.mode === 'cover' || !isContainTarget(layer)) {
      out.set(layer.id, cover)
      continue
    }

    const contain = solveLayerContain(doc, layer, size.width, size.height, options)

    /*
     * 프리셋이 세기 최대치로 재 둔 기준값이 있으면 그쪽이 이긴다.
     *
     * 지금 세기로 푼 값을 그대로 쓰면 모션의 극단이 항상 프레임에 딱 맞아, 세기를
     * 올려도 그림이 훑는 범위가 그대로다. 기준값을 쓰면 그림 크기가 세기와 무관하게
     * 고정되고 움직임의 크기만 달라진다.
     *
     * 그래도 둘 중 작은 쪽을 쓴다. PRO 에서 키프레임을 프리셋의 최대치보다 크게
     * 손보면 기준값만으로는 잘림을 못 막는다.
     */
    const reference = layer.containScale
    const correction = Math.min(
      contain.correction,
      typeof reference === 'number' && reference > 0 ? reference : 1,
    )
    if (correction >= 1) {
      out.set(layer.id, cover)
      continue
    }
    out.set(layer.id, {
      ...cover,
      mode: 'contain',
      clipped: contain.clipped,
      correction,
      worstFrame: contain.worstFrame,
    })
  }
  return out
}

/**
 * 사용자에게 보여줄 진단.
 * 원칙은 하나다. 원인이 아니라 처방을 말한다.
 * "실제 배율 1.2 -> 1.34 (자동 보정됨)" 같은 문구는 비개발자에게 의미가 없다.
 */
export interface OverscanDiagnosis {
  level: 'ok' | 'notice' | 'warn'
  message: string
  /** 배경 채우기를 제안할 상황인가 */
  suggestBackgroundFill: boolean
}

export function diagnose(need: OverscanNeed, sourceLongSide: number): OverscanDiagnosis {
  if (!need.needsUpscale) {
    return { level: 'ok', message: '', suggestBackgroundFill: false }
  }
  if (need.usedScale > UPSCALE_SUGGEST_THRESHOLD) {
    return {
      level: 'warn',
      message: `이 움직임을 쓰려면 원본이 ${need.recommendedSourcePx}px 이상이면 좋습니다. 지금 원본은 ${sourceLongSide}px 이라 살짝 흐려질 수 있어요.`,
      suggestBackgroundFill: true,
    }
  }
  return {
    level: 'notice',
    message: '가장자리가 아주 살짝 흐려질 수 있어요.',
    suggestBackgroundFill: false,
  }
}
