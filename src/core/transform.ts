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

import type { FitMode, ResolvedTransform } from './types.ts'

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
 * ---------------------------------------------------------------------------
 * 기준점은 축이지 배치 원점이 아니다
 * ---------------------------------------------------------------------------
 * 원래 식은 M = T(pos)·R·K·S·T(-anchor)·L 이었다. 이러면 **기준점으로 찍은 그 점이
 * 캔버스 중앙에 온다.** 기준점을 왼쪽 위로 옮기는 순간 그림이 오른쪽 아래로
 * 반 장씩 튀어 나간다. 사용자가 원한 것은 "회전과 확대가 도는 축을 옮기는 것"
 * 이지 "그림을 옮기는 것" 이 아니다.
 *
 * 그래서 기준점이 중앙에서 벗어난 만큼(q)을 다시 더해 준다.
 *
 *   M = T(pos + S_base·q) · R·K·S · T(-anchor)·L,   q = (anchor - 0.5) * 이미지크기
 *
 * 더하는 양은 **움직이지 않는 배율(S_base)** 로만 잰다. 애니메이션되는 scaleX 로
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
    translateX: 0,
    translateY: 0,
    skewX: 0,
    skewY: 0,
    anchorX: 0.5,
    anchorY: 0.5,
    opacity: 1,
  }
}
