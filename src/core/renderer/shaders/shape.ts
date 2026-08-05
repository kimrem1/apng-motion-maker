/**
 * 도형 레이어 셰이더.
 *
 * 도형은 텍스처가 아니라 거리장(SDF) 으로 그린다. 픽셀을 확대해서 늘리는 것이
 * 아니라 매 프레임 수식으로 다시 그리므로, 4000px 로 키워도 가장자리가 뭉개지지 않고
 * 파일 크기도 늘지 않는다.
 *
 * 좌표계는 LAYER_VS 가 주는 유닛 사각형 v_uv 를 도형 로컬 픽셀로 되돌린 것이다.
 *   p = (v_uv - 0.5) * u_size,  원점 = 도형 중앙, +y 는 아래
 * 매트릭스(회전 / 확대 / 기준점)는 이미 정점 단계에서 끝났으므로 여기서는 모양만 본다.
 *
 * 규칙 세 가지.
 *
 * 1. 출력은 premultiplied 다. 레이어 셰이더와 같은 규약이고 블렌드 함수가
 *    (ONE, ONE_MINUS_SRC_ALPHA) 이기 때문이다. 어기면 프리뷰는 멀쩡한데 내보낸
 *    파일에서만 반투명 가장자리 색이 부풀어 오른다.
 * 2. 안티에일리어싱은 fwidth 로 한다. v_uv 는 실제로 그려지는 넓이에 걸쳐
 *    보간되므로, 도형을 3배로 키워도 경계 흐림은 항상 화면 1픽셀이다.
 * 3. 시간을 모른다. 움직임은 전부 트랙이 만든다. 셰이더가 프레임을 알면
 *    프리뷰와 내보내기가 갈릴 여지가 생긴다.
 */

import { REVEAL_GLSL } from './reveal.ts'

/** u_kind 로 넘기는 코드. ShapeKind 의 순서와 같아야 한다. */
export const SHAPE_KIND_CODE: Record<string, number> = {
  rect: 0,
  circle: 1,
  triangle: 2,
  polygon: 3,
  star: 4,
  cross: 5,
  arc: 6,
  burst: 7,
  ticks: 8,
  sparkle: 9,
}

export const SHAPE_FS = /* glsl */ `#version 300 es
precision highp float;

uniform vec4 u_color;
uniform float u_opacity;
uniform vec2 u_size;
uniform float u_stroke;
uniform float u_radius;
uniform float u_inner;
uniform float u_sweep;
uniform int u_kind;
uniform int u_points;
${REVEAL_GLSL}

in vec2 v_uv;
out vec4 fragColor;

const float MM_PI = 3.14159265359;

float sdRoundBox(vec2 p, vec2 ext, float r) {
  vec2 q = abs(p) - ext + r;
  return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - r;
}

/*
 * 타원. 정확한 해는 4차 방정식이라 뉴턴 한 단계 근사를 쓴다.
 * 경계에서의 오차가 화면 1픽셀보다 훨씬 작아 안티에일리어싱에 영향이 없다.
 */
float sdEllipse(vec2 p, vec2 r) {
  float k1 = length(p / (r * r));
  if (k1 < 1e-6) return -min(r.x, r.y);
  float k0 = length(p / r);
  return k0 * (k0 - 1.0) / k1;
}

/*
 * 각 꼭짓점의 반지름이 번갈아 바뀌는 다각형까지 한 함수로 처리한다.
 * 점이 속한 각도 구간의 변 하나까지의 거리를 재고, 그 변을 기준으로 안팎을 가른다.
 * 첫 꼭짓점은 화면 위쪽에 온다.
 *
 * 거리는 반드시 진짜 픽셀 좌표에서 잰다. 정규화 좌표에서 재고 짧은 변 하나를
 * 곱해 되돌리면, 가로세로 비가 다를 때 긴 축의 거리가 그 비율만큼 부풀어
 * 테두리 두께가 축마다 달라진다. 폭 400 / 높이 100 다각형에 20px 테두리를 주면
 * 세로 변은 20px, 가로 변은 95px 이 된다. 각도 구간만 정규화 좌표에서 고르고,
 * 꼭짓점과 거리는 픽셀에서 만든다.
 */
float sdRadialPoly(vec2 p, vec2 ext, float inner, int n, bool alternate) {
  vec2 pn = p / ext;
  if (dot(pn, pn) < 1e-8) return -min(ext.x, ext.y) * min(1.0, inner);

  float sides = float(n) * (alternate ? 2.0 : 1.0);
  float seg = 2.0 * MM_PI / sides;
  // 첫 꼭짓점이 화면 위(-y)에 오도록 기준 각도를 -90도로 잡는다.
  float base = -MM_PI * 0.5;

  float a = atan(pn.y, pn.x) - base;
  a = a - floor(a / (2.0 * MM_PI)) * 2.0 * MM_PI;
  float idx = floor(a / seg);
  float a0 = base + idx * seg;
  float a1 = a0 + seg;

  float evenSide = (mod(idx, 2.0) < 0.5) ? 1.0 : 0.0;
  float r0 = alternate ? mix(inner, 1.0, evenSide) : 1.0;
  float r1 = alternate ? mix(1.0, inner, evenSide) : 1.0;

  vec2 v0 = vec2(cos(a0), sin(a0)) * ext * r0;
  vec2 v1 = vec2(cos(a1), sin(a1)) * ext * r1;
  vec2 e = v1 - v0;
  vec2 w = p - v0;
  float h = clamp(dot(w, e) / max(dot(e, e), 1e-8), 0.0, 1.0);
  float d = length(w - e * h);
  float side = e.x * w.y - e.y * w.x;
  return (side > 0.0) ? -d : d;
}

/** 십자. 가로 막대와 세로 막대의 합집합이다. */
float sdCross(vec2 p, vec2 ext, float arm, float r) {
  float ra = min(r, arm);
  float a = sdRoundBox(p, vec2(ext.x, arm), ra);
  float b = sdRoundBox(p, vec2(arm, ext.y), ra);
  return min(a, b);
}

/** 부채꼴. 위쪽을 중심으로 좌우 대칭으로 벌어진다. */
float sdPie(vec2 p, float halfAngle, float r) {
  vec2 q = vec2(abs(p.x), -p.y);
  vec2 c = vec2(sin(halfAngle), cos(halfAngle));
  float l = length(q) - r;
  float m = length(q - c * clamp(dot(q, c), 0.0, r));
  return max(l, m * sign(c.y * q.x - c.x * q.y));
}

/**
 * 부채꼴의 각도 부분만. 반지름 제한이 없는 무한 쐐기다.
 *
 * 테두리만 그리는 부채꼴에 필요하다. 부채꼴 전체의 윤곽을 그리면 두 반지름 선까지
 * 함께 그려져 "잘린 원" 이 되는데, 사람들이 기대하는 것은 고리의 한 조각이다.
 */
float sdWedge(vec2 p, float halfAngle) {
  vec2 q = vec2(abs(p.x), -p.y);
  vec2 c = vec2(sin(halfAngle), cos(halfAngle));
  float m = length(q - c * clamp(dot(q, c), 0.0, 1e4));
  return m * sign(c.y * q.x - c.x * q.y);
}

/*
 * 방사살. 가운데에서 뻗어 나가는 막대 n 개다.
 *
 * 막대 하나하나를 도형으로 두면 살 24개짜리 집중선에 레이어가 24장 필요하다.
 * 각도 구간으로 접으면 한 장이면 된다. 살까지의 가로 거리는 각거리가 아니라
 * 픽셀 거리로 잰다. 각거리로 재면 바깥으로 갈수록 살이 두꺼워진다.
 *
 * thick 은 살 굵기(px), inner 는 가운데 빈 반지름의 비율이다.
 */
float sdBurst(vec2 p, vec2 ext, int n, float inner, float thick) {
  float scale = min(ext.x, ext.y);
  vec2 q = p / ext;
  float r = length(q);
  if (r < 1e-6) return -thick * 0.5;

  float count = float(max(n, 1));
  float seg = 2.0 * MM_PI / count;
  // 첫 살이 화면 위(-y)를 향하도록 기준 각도를 옮긴다.
  float a = atan(q.y, q.x) + MM_PI * 0.5;
  a = a - floor(a / seg) * seg - seg * 0.5;

  // 살 중심선까지의 수직 거리. 반지름에 비례해 벌어지는 각거리를 픽셀로 되돌린다.
  float across = abs(sin(a)) * r * scale - thick * 0.5;
  float radial = max(r - 1.0, inner - r) * scale;
  return max(across, radial);
}

/*
 * 눈금. 가로로 늘어선 짧은 막대 n 개다. 자 눈금과 점선이 이 모양이다.
 *
 * mod 로 접으면 도형 밖까지 무한히 반복되므로 바깥 사각형과 교집합을 잡는다.
 * duty 는 한 칸에서 막대가 차지하는 비율이다. 1 이면 빈틈이 사라진다.
 */
float sdTicks(vec2 p, vec2 ext, int n, float duty, float r) {
  float count = float(max(n, 1));
  float cell = (ext.x * 2.0) / count;
  float x = p.x + ext.x;
  float local = x - floor(x / cell) * cell - cell * 0.5;
  float halfBar = max(cell * 0.5 * clamp(duty, 0.02, 1.0), 0.5);

  float bar = sdRoundBox(vec2(local, p.y), vec2(halfBar, ext.y), min(r, min(halfBar, ext.y)));
  float box = max(abs(p.x) - ext.x, abs(p.y) - ext.y);
  return max(bar, box);
}

/*
 * 별빛. 변이 안으로 파인 뾰족한 별이다.
 *
 * 별(star)은 꼭짓점 사이를 직선으로 잇는다. 반짝임에 쓰면 뾰족하지 않고 종이별처럼
 * 보인다. 여기서는 극좌표 반지름을 |cos| 의 거듭제곱으로 깎아 사이를 오목하게 만든다.
 * 지수가 클수록 날카롭다.
 *
 * 진짜 거리장은 아니지만 경계 근처에서 단조롭게 부호가 바뀌므로 fwidth
 * 안티에일리어싱에는 충분하다 (sdWedge 와 같은 근사다).
 */
float sdSparkle(vec2 p, vec2 ext, int n, float sharp) {
  float scale = min(ext.x, ext.y);
  vec2 q = p / ext;
  float r = length(q);
  if (r < 1e-6) return -scale;
  float count = float(max(n, 2));
  float a = atan(q.y, q.x) + MM_PI * 0.5;
  float lobe = pow(abs(cos(a * count * 0.5)), sharp);
  return (r - lobe) * scale;
}

void main() {
  // 테두리는 안쪽으로 물린다. 두께를 올려도 레이어가 차지하는 크기가 그대로여야 한다.
  vec2 ext = max(u_size * 0.5 - vec2(u_stroke * 0.5), vec2(0.5));
  vec2 p = (v_uv - 0.5) * u_size;
  float minExt = min(ext.x, ext.y);

  float d;
  bool banded = false;
  if (u_kind == 1) {
    d = sdEllipse(p, ext);
  } else if (u_kind == 2) {
    d = sdRadialPoly(p, ext, 1.0, 3, false);
  } else if (u_kind == 3) {
    d = sdRadialPoly(p, ext, 1.0, u_points, false);
  } else if (u_kind == 4) {
    d = sdRadialPoly(p, ext, u_inner, u_points, true);
  } else if (u_kind == 5) {
    d = sdCross(p, ext, minExt * u_inner, u_radius);
  } else if (u_kind == 6) {
    if (u_stroke > 0.0) {
      // 고리를 부채꼴로 잘라 조각만 남긴다. 두 반지름 선은 그리지 않는다.
      float band = abs(sdEllipse(p, ext)) - u_stroke * 0.5;
      if (u_sweep >= 2.0 * MM_PI - 1e-3) {
        /*
         * 한 바퀴를 다 도는 부채꼴은 그냥 고리다. 쐐기와 교집합을 하면 안 된다.
         * 각도 상한(π - 0.001) 때문에 화면 아래쪽 한 줄이 쐐기 밖으로 판정되어
         * 고리에 세로로 이가 빠진다.
         */
        d = band;
      } else {
        d = max(band, sdWedge(p / ext, u_sweep * 0.5) * minExt);
      }
      banded = true;
    } else {
      d = sdPie(p / ext, min(u_sweep * 0.5, MM_PI - 1e-3), 1.0) * minExt;
    }
  } else if (u_kind == 7) {
    // 살 굵기가 곧 u_stroke 다. 테두리처럼 안으로 물리면 원판이 굵기만큼 작아진다.
    vec2 full = max(u_size * 0.5, vec2(0.5));
    d = sdBurst(p, full, u_points, u_inner, max(u_stroke, 1.0));
    banded = true;
  } else if (u_kind == 8) {
    d = sdTicks(p, ext, u_points, u_inner, u_radius);
  } else if (u_kind == 9) {
    // innerRatio 가 작을수록 날카롭다. 0.05~0.95 를 지수 6~1 로 옮긴다.
    d = sdSparkle(p, ext, u_points, mix(6.0, 1.0, clamp((u_inner - 0.05) / 0.9, 0.0, 1.0)));
  } else {
    d = sdRoundBox(p, ext, min(u_radius, minExt));
  }

  if (u_stroke > 0.0 && !banded) d = abs(d) - u_stroke * 0.5;

  // 경계 한 픽셀에 걸쳐 부드럽게 넘긴다. 0 으로 나누는 경우를 막는다.
  float aa = max(fwidth(d), 1e-4);
  float cov = 1.0 - smoothstep(-aa * 0.5, aa * 0.5, d);

  float a = cov * u_color.a * u_opacity * mmRevealMask(v_uv);
  fragColor = vec4(u_color.rgb * a, a);
}
`
