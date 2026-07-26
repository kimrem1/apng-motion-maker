/**
 * 분리형 혼합 모드 (W3C Compositing and Blending Level 1).
 *
 * 파이프라인 전체가 premultiplied 이므로 공식도 premultiplied 기준으로 쓴다.
 *
 *   Cr = (1 - ab)*Cs + (1 - as)*Cb + as*ab*B(Cs', Cb')
 *   ar = as + ab*(1 - as)
 *
 * Cs, Cb 는 premultiplied 색이고 Cs', Cb' 는 알파를 되돌린 색이다.
 * B 를 straight 색으로 계산하지 않으면 반투명 영역에서 색이 어긋난다.
 *
 * 알파 0 에서 나누기가 생기므로 반드시 가드한다. 투명 스티커가 주 용도라
 * 알파 0 픽셀이 화면의 대부분인 경우가 흔하다.
 */

export const BLEND_FS = /* glsl */ `#version 300 es
precision highp float;

uniform sampler2D u_backdrop;   // 지금까지 합성된 결과 (premultiplied)
uniform sampler2D u_source;     // 이번 레이어 (premultiplied)
uniform int u_mode;             // 0 normal, 1 multiply, 2 screen, 3 overlay, 4 lighten, 5 darken

in vec2 v_uv;
out vec4 fragColor;

vec3 unpremultiply(vec4 c) {
  return c.a > 0.0 ? c.rgb / c.a : vec3(0.0);
}

float hardLight1(float s, float b) {
  return s <= 0.5 ? (2.0 * s * b) : (1.0 - 2.0 * (1.0 - s) * (1.0 - b));
}

vec3 blendFn(int mode, vec3 s, vec3 b) {
  if (mode == 1) return s * b;                       // multiply
  if (mode == 2) return s + b - s * b;               // screen
  if (mode == 3) return vec3(                        // overlay = hardLight(b, s)
    hardLight1(b.r, s.r), hardLight1(b.g, s.g), hardLight1(b.b, s.b));
  if (mode == 4) return max(s, b);                   // lighten
  if (mode == 5) return min(s, b);                   // darken
  return s;                                          // normal
}

void main() {
  vec4 src = texture(u_source, v_uv);
  vec4 dst = texture(u_backdrop, v_uv);

  float as = src.a;
  float ab = dst.a;

  vec3 sStraight = unpremultiply(src);
  vec3 bStraight = unpremultiply(dst);
  vec3 blended = blendFn(u_mode, sStraight, bStraight);

  vec3 rgb = (1.0 - ab) * src.rgb + (1.0 - as) * dst.rgb + as * ab * blended;
  float a = as + ab * (1.0 - as);

  fragColor = vec4(rgb, a);
}
`

/** BlendMode 이름을 셰이더 정수로. 순서는 blend.ts 의 u_mode 주석과 맞춰야 한다. */
export const BLEND_MODE_CODE: Record<string, number> = {
  normal: 0,
  multiply: 1,
  screen: 2,
  overlay: 3,
  lighten: 4,
  darken: 5,
}
