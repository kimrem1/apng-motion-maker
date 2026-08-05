/**
 * 2D 어파인 변환.
 *
 * 합성 순서는 Lottie 스펙을 따른다:
 *   translate(-anchor) -> scale -> skew -> rotate -> translate(position)
 * 즉  M = T(pos) · R(θ) · K(skew) · S(s) · T(-anchor)
 *
 * S 와 K 의 순서를 반대로 적은 자료가 흔한데, 스펙상 MUST 인 Lottie 순서를
 * 정본으로 삼는다. skew 가 0 이면 두 순서의 결과는 같다.
 *
 * mat3 은 Float32Array(9), 열 우선(column-major)이다. WebGL uniformMatrix3fv 가
 * 그 레이아웃을 기대한다.
 *
 *   m[0] m[3] m[6]
 *   m[1] m[4] m[7]
 *   m[2] m[5] m[8]
 */

import { PERSPECTIVE_DEFAULT, type FitMode, type ResolvedTransform } from './types.ts'

export type Mat3 = Float32Array

export function mat3Identity(out?: Mat3): Mat3 {
  const m = out ?? new Float32Array(9)
  m[0] = 1; m[1] = 0; m[2] = 0
  m[3] = 0; m[4] = 1; m[5] = 0
  m[6] = 0; m[7] = 0; m[8] = 1
  return m
}

/** out = a · b */
export function mat3Multiply(a: Mat3, b: Mat3, out?: Mat3): Mat3 {
  const m = out ?? new Float32Array(9)
  const a00 = a[0]!, a01 = a[3]!, a02 = a[6]!
  const a10 = a[1]!, a11 = a[4]!, a12 = a[7]!
  const a20 = a[2]!, a21 = a[5]!, a22 = a[8]!
  const b00 = b[0]!, b01 = b[3]!, b02 = b[6]!
  const b10 = b[1]!, b11 = b[4]!, b12 = b[7]!
  const b20 = b[2]!, b21 = b[5]!, b22 = b[8]!

  m[0] = a00 * b00 + a01 * b10 + a02 * b20
  m[3] = a00 * b01 + a01 * b11 + a02 * b21
  m[6] = a00 * b02 + a01 * b12 + a02 * b22

  m[1] = a10 * b00 + a11 * b10 + a12 * b20
  m[4] = a10 * b01 + a11 * b11 + a12 * b21
  m[7] = a10 * b02 + a11 * b12 + a12 * b22

  m[2] = a20 * b00 + a21 * b10 + a22 * b20
  m[5] = a20 * b01 + a21 * b11 + a22 * b21
  m[8] = a20 * b02 + a21 * b12 + a22 * b22
  return m
}

export function mat3Translation(tx: number, ty: number, out?: Mat3): Mat3 {
  const m = mat3Identity(out)
  m[6] = tx
  m[7] = ty
  return m
}

export function mat3Scaling(sx: number, sy: number, out?: Mat3): Mat3 {
  const m = mat3Identity(out)
  m[0] = sx
  m[4] = sy
  return m
}

export function mat3Rotation(radians: number, out?: Mat3): Mat3 {
  const m = mat3Identity(out)
  const c = Math.cos(radians)
  const s = Math.sin(radians)
  // y 축이 아래로 향하는 화면 좌표계. 양의 각도가 시계 방향이 된다.
  m[0] = c; m[1] = s
  m[3] = -s; m[4] = c
  return m
}

/** skew 각도(도)를 받는다. tan 을 쓰므로 90도 근처는 클램프한다. */
export function mat3Skew(skewXDeg: number, skewYDeg: number, out?: Mat3): Mat3 {
  const m = mat3Identity(out)
  const lim = 89.5
  const kx = Math.tan((Math.max(-lim, Math.min(lim, skewXDeg)) * Math.PI) / 180)
  const ky = Math.tan((Math.max(-lim, Math.min(lim, skewYDeg)) * Math.PI) / 180)
  m[3] = kx
  m[1] = ky
  return m
}

export function degToRad(deg: number): number {
  return (deg * Math.PI) / 180
}

/**
 * 점 하나를 옮긴다. 원근이 걸려 있으면 w 로 나눈 뒤의 화면 좌표다.
 *
 * w 가 0 이하면 그 점은 카메라 뒤로 넘어갔다. 화면에 자리가 없으므로 undefined 다.
 * 나눗셈을 호출부마다 다시 적으면 한 곳만 빠뜨렸을 때 3D 회전이 걸린 레이어에서만
 * 좌표가 어긋난다. 그 종류의 버그는 눈으로 못 잡는다.
 */
export function mat3ProjectPoint(
  m: Mat3,
  x: number,
  y: number,
): { x: number; y: number } | undefined {
  const w = m[2]! * x + m[5]! * y + m[8]!
  if (!(w > 1e-9)) return undefined
  return {
    x: (m[0]! * x + m[3]! * y + m[6]!) / w,
    y: (m[1]! * x + m[4]! * y + m[7]!) / w,
  }
}

/**
 * 어파인 매트릭스의 역행렬. 마지막 행이 [0,0,1] 인 것을 전제한다.
 *
 * 캔버스에서 잰 자리를 폴더 안쪽 좌표로 되돌릴 때 쓴다. 폴더가 돌아가 있거나
 * 확대되어 있으면 화면에서 오른쪽으로 10px 끈 것이 안쪽 레이어에게는 10px 이
 * 아니다. 되돌리지 않으면 폴더에 모션을 건 순간 드래그가 손을 따라오지 않는다.
 *
 * 폴더 매트릭스는 언제나 어파인이다 (buildGroupMatrix). 그래서 마지막 행 가정이
 * 성립하고, 배율이 0 인 특이 행렬만 undefined 로 돌려보내면 된다.
 */
export function mat3InvertAffine(m: Mat3, out?: Mat3): Mat3 | undefined {
  const a = m[0]!, b = m[1]!, c = m[3]!, d = m[4]!
  const tx = m[6]!, ty = m[7]!
  const det = a * d - c * b
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return undefined

  const r = mat3Identity(out)
  r[0] = d / det
  r[1] = -b / det
  r[3] = -c / det
  r[4] = a / det
  r[6] = -(r[0]! * tx + r[3]! * ty)
  r[7] = -(r[1]! * tx + r[4]! * ty)
  return r
}

/**
 * 3D 회전 + 원근을 mat3 하나로 접는다.
 *
 * 왜 mat4 가 아닌가
 *
 * 평면 한 장을 3D 로 돌려 화면에 투영하는 것은 호모그래피다. z 는 언제나
 * 회전 뒤에 곧바로 나눗셈으로 사라지므로 3x3 으로 정확히 표현된다. mat4 를 들이면
 * 매트릭스 파이프라인 전체가 갈라지고, 오버스캔 솔버가 쓰는 "배율만 0 으로 둔
 * 매트릭스" 같은 요령이 전부 다시 쓰여야 한다.
 *
 * 점 (x, y, 0) 을 rotateY(β) 다음 rotateX(α) 로 돌리면
 *   X = x·cosβ
 *   Y = y·cosα + x·sinα·sinβ
 *   Z = -x·cosα·sinβ + y·sinα
 * 이고, 카메라까지의 거리 d 로 나누는 투영은 w = 1 - Z/d 다. 부호는 CSS 의
 * rotateX / rotateY 와 같다. 양의 rotateY 는 오른쪽 변을 뒤로 보낸다.
 *
 * d 가 0 이면 평행 투영이다. 원근 없이 각도만큼 눌리는, 종이 인형 같은 뒤집기가 된다.
 *
 * 정점 셰이더가 `gl_Position = vec4(p.xy, 0.0, p.z)` 로 넘기므로 나눗셈과
 * 원근 보정 UV 보간은 래스터라이저가 한다 (shaders/layer.ts).
 */
export function mat3Perspective(
  rotateXDeg: number,
  rotateYDeg: number,
  distance: number,
  out?: Mat3,
): Mat3 {
  const m = mat3Identity(out)
  if (rotateXDeg === 0 && rotateYDeg === 0) return m

  const a = degToRad(rotateXDeg)
  const b = degToRad(rotateYDeg)
  const ca = Math.cos(a)
  const sa = Math.sin(a)
  const cb = Math.cos(b)
  const sb = Math.sin(b)

  m[0] = cb
  m[1] = sa * sb
  m[4] = ca

  if (distance > 0) {
    m[2] = (ca * sb) / distance
    m[5] = -sa / distance
  }
  return m
}

/**
 * 원근 회전이 만드는 z 의 최대 절댓값.
 *
 * 기준점이 가운데라고 가정하면 안 된다
 *
 * mat3Perspective 에 들어가는 좌표는 `local` 이 만든 기준점 기준 로컬 픽셀이라
 * x 는 [-anchorX·W, (1-anchorX)·W] 범위다. 기준점이 왼쪽 끝이면 |x| 의 최댓값이
 * W/2 가 아니라 W 다. 절반으로 잡으면 안전 거리가 필요한 값의 절반이 되고,
 * w 가 음수로 내려가 쿼드가 화면 전체로 찢어진다.
 */
export function perspectiveZMax(
  rotateXDeg: number,
  rotateYDeg: number,
  imageW: number,
  imageH: number,
  anchorX: number,
  anchorY: number,
): number {
  const a = degToRad(rotateXDeg)
  const b = degToRad(rotateYDeg)
  const reachX = Math.max(Math.abs(anchorX), Math.abs(1 - anchorX)) * imageW
  const reachY = Math.max(Math.abs(anchorY), Math.abs(1 - anchorY)) * imageH
  return Math.abs(Math.cos(a) * Math.sin(b)) * reachX + Math.abs(Math.sin(a)) * reachY
}

/**
 * fit 모드가 만드는 기준 배율 s0.
 * cover 에서 s0 는 "이미지가 캔버스를 최소로 덮는 배율"이고, 이 상태가 k = 1.0 이다
 * 이 정의 덕에 오버스캔 판정이 k >= 1 이라는 한 줄로 끝난다.
 */
export function baseFitScale(
  fit: FitMode,
  canvasW: number,
  canvasH: number,
  imageW: number,
  imageH: number,
): { sx: number; sy: number } {
  if (imageW <= 0 || imageH <= 0) return { sx: 1, sy: 1 }
  const rx = canvasW / imageW
  const ry = canvasH / imageH
  switch (fit) {
    case 'cover': {
      const s = Math.max(rx, ry)
      return { sx: s, sy: s }
    }
    case 'contain': {
      const s = Math.min(rx, ry)
      return { sx: s, sy: s }
    }
    case 'fill':
      return { sx: rx, sy: ry }
    case 'none':
    default:
      return { sx: 1, sy: 1 }
  }
}

/**
 * 레이어의 최종 매트릭스를 만든다.
 * 입력 정점은 [0,1]^2 유닛 사각형이고, 출력은 캔버스 픽셀 좌표
 * (원점 = 캔버스 중심, +x 오른쪽, +y 아래)다.
 *
 * 기준점은 축이지 배치 원점이 아니다
 *
 * 원래 식은 M = T(pos)·R·K·S·T(-anchor)·L 이었다. 이러면 기준점으로 찍은 그 점이
 * 캔버스 중앙에 온다. 기준점을 왼쪽 위로 옮기는 순간 그림이 오른쪽 아래로
 * 반 장씩 튀어 나간다. 사용자가 원한 것은 "회전과 확대가 도는 축을 옮기는 것"
 * 이지 "그림을 옮기는 것" 이 아니다.
 *
 * 그래서 기준점이 중앙에서 벗어난 만큼(q)을 다시 더해 준다.
 *
 *   M = T(pos + S_base·q) · R·K·S · T(-anchor)·L,   q = (anchor - 0.5) * 이미지크기
 *
 * 더하는 양은 움직이지 않는 배율(S_base) 로만 잰다. 애니메이션되는 scaleX 로
 * 재면 확대할 때 보정도 같이 커져서 그림이 제자리에서 커지고, 기준점이 아무
 * 일도 하지 않는다. S_base 로 재면 이렇게 된다.
 *
 *   - 정지 상태(배율 1, 회전 0): 기준점이 어디든 그림은 캔버스 중앙에 그대로 있다
 *   - 확대: 기준점이 박힌 채로 그 반대쪽으로 자란다
 *   - 회전: 기준점을 축으로 돈다
 */
export function buildLayerMatrix(
  t: ResolvedTransform,
  fit: FitMode,
  canvasW: number,
  canvasH: number,
  imageW: number,
  imageH: number,
  out?: Mat3,
): Mat3 {
  const fitBase = baseFitScale(fit, canvasW, canvasH, imageW, imageH)
  // 캔버스 해상도를 바꿨을 때 따라붙는 고정 배율. 옛 문서에는 없다.
  const layerScale = Number.isFinite(t.baseScale) && t.baseScale > 0 ? t.baseScale : 1
  const base = { sx: fitBase.sx * layerScale, sy: fitBase.sy * layerScale }

  // 유닛 사각형 -> 앵커 기준 이미지 로컬 픽셀
  const local = mat3Identity()
  local[0] = imageW
  local[4] = imageH
  local[6] = -t.anchorX * imageW
  local[7] = -t.anchorY * imageH

  const s = mat3Scaling(base.sx * t.scaleX, base.sy * t.scaleY)
  const k = mat3Skew(t.skewX, t.skewY)
  const r = mat3Rotation(degToRad(t.rotate))
  const p = mat3Translation(
    t.translateX + base.sx * (t.anchorX - 0.5) * imageW,
    t.translateY + base.sy * (t.anchorY - 0.5) * imageH,
  )

  const m = out ?? new Float32Array(9)
  mat3Multiply(p, r, m)
  mat3Multiply(m, k, m)
  mat3Multiply(m, s, m)

  /*
   * 원근 회전은 배율보다 안쪽에 들어간다. 순서가 뒤집히면 담기 솔버가 깨진다.
   *
   * 솔버는 "배율 채널에 c 를 곱했을 때 꼭짓점이 pos + c·D 라는 1차식" 이라는 성질로
   * 배율을 닫힌 형태로 푼다 (overscan.ts containScaleAt). 원근을 배율 바깥에 두면
   * c 가 나눗셈 안으로 들어가 그 성질이 깨지고, 이분 탐색 없이는 풀 수 없게 된다.
   * 안쪽에 두면 나눗셈이 c 와 무관해져 1차식이 그대로 유지된다.
   *
   * 어파인 변환은 원근 나눗셈과 교환된다(마지막 행이 [0,0,1] 이므로). 그래서
   * "먼저 투영하고 그 결과를 확대·회전한다" 와 결과가 같다. CSS 의
   * transform-style: flat 과 같은 모형이다.
   */
  if (t.rotateX !== 0 || t.rotateY !== 0) {
    const distRatio = Number.isFinite(t.perspective) ? Math.max(0, t.perspective) : 0
    let d = distRatio * Math.max(imageW, imageH)
    if (d > 0) {
      /*
       * w 가 0 이하로 내려가지 않게 바닥을 둔다.
       *
       * w 가 0 을 지나면 그 꼭짓점이 카메라 뒤로 넘어간다. gl_Position.z 가 상수 0 이라
       * 근평면이 정확히 w=0 이고, 클리퍼가 거기서 자른 모서리는 무한대로 늘어나
       * 화면 전체를 덮는 얼룩이 된다. 사용자가 원근을 아무리 세게 밀어도 그 그림은
       * 보여 줄 가치가 없다. 1.05 여유는 최악의 꼭짓점에서 w >= 0.047 을 남긴다.
       */
      const zMax = perspectiveZMax(t.rotateX, t.rotateY, imageW, imageH, t.anchorX, t.anchorY)
      d = Math.max(d, zMax * 1.05)
    }
    const h = mat3Perspective(t.rotateX, t.rotateY, d)
    mat3Multiply(m, h, m)
  }

  mat3Multiply(m, local, m)
  return m
}

/**
 * 캔버스 픽셀 좌표를 클립 공간으로 옮긴다.
 * y 를 뒤집어 화면 좌표계(아래가 +)를 NDC(위가 +)에 맞춘다.
 */
export function canvasToClip(canvasW: number, canvasH: number, out?: Mat3): Mat3 {
  const m = mat3Identity(out)
  m[0] = 2 / canvasW
  m[4] = -2 / canvasH
  return m
}

export function identityTransform(): ResolvedTransform {
  return {
    baseScale: 1,
    scaleX: 1,
    scaleY: 1,
    rotate: 0,
    rotateX: 0,
    rotateY: 0,
    perspective: PERSPECTIVE_DEFAULT,
    translateX: 0,
    translateY: 0,
    skewX: 0,
    skewY: 0,
    anchorX: 0.5,
    anchorY: 0.5,
    opacity: 1,
    reveal: 1,
    charIn: 1,
  }
}

// ---------------------------------------------------------------------------
// 폴더(그룹) 변환
// ---------------------------------------------------------------------------

/**
 * 폴더 하나의 변환. 캔버스 픽셀 좌표에서 바깥에 곱해진다.
 *
 *   최종 = G_바깥폴더 · ... · G_안쪽폴더 · buildLayerMatrix(레이어)
 *
 * buildLayerMatrix 와 다른 점이 둘 있다.
 *
 * 1. 원본 크기가 없다. 폴더는 픽셀을 갖지 않으므로 맞춤(fit)도 유닛 사각형도
 *    없다. 그래서 이미지 로컬로 내려갔다 올라오는 단계가 통째로 빠진다.
 * 2. 기준점이 진짜 축이다. 이미지 레이어의 기준점은 "회전축이되 배치는 그대로"
 *    라는 보정이 붙어 있지만(buildLayerMatrix 주석), 폴더는 보정할 배치가 없다.
 *    기준점은 캔버스 비율로 읽는다. 0.5, 0.5 가 캔버스 한가운데다.
 *
 * 어파인이라는 것이 중요하다. 마지막 행이 [0,0,1] 이므로 안쪽 레이어가 원근을
 * 써도(마지막 행이 [0,0,1] 이 아니어도) 나눗셈과 교환된다. 그래서 "먼저 투영하고
 * 그 결과를 폴더가 옮긴다" 와 결과가 같다. 담기 솔버가 기대는
 * "꼭짓점 = 위치 + c·D" 라는 1차식도 그대로 유지된다.
 *   G·(p + c·D) = G_선형·p + G_이동 + c·(G_선형·D)
 */
export function buildGroupMatrix(
  t: ResolvedTransform,
  canvasW: number,
  canvasH: number,
  out?: Mat3,
): Mat3 {
  const k = Number.isFinite(t.baseScale) && t.baseScale > 0 ? t.baseScale : 1
  // 기준점을 캔버스 픽셀로 옮긴 것. 회전과 배율이 이 점을 축으로 돈다.
  const px = (t.anchorX - 0.5) * canvasW
  const py = (t.anchorY - 0.5) * canvasH

  const m = out ?? new Float32Array(9)
  mat3Translation(t.translateX + px, t.translateY + py, m)
  mat3Multiply(m, mat3Rotation(degToRad(t.rotate)), m)
  mat3Multiply(m, mat3Skew(t.skewX, t.skewY), m)
  mat3Multiply(m, mat3Scaling(t.scaleX * k, t.scaleY * k), m)
  mat3Multiply(m, mat3Translation(-px, -py), m)
  return m
}
