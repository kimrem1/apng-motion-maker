/**
 * 글자 쿼드 셰이더.
 *
 * 레이어 셰이더(layer.ts)와 두 가지가 다르다.
 *
 * 1. **아틀라스의 한 칸만 샘플링한다.** 글자마다 자기 칸이 따로 있어서 옆 글자의
 *    잉크가 번지지 않는다. 글자가 서로 떨어져 날아올 때 이게 없으면 이웃 글자의
 *    획 끄트머리가 유령처럼 딸려 온다.
 *
 * 2. **가리기 좌표를 따로 넘긴다.** 경계선은 글자 하나가 아니라 글자 상자 전체를
 *    지나가야 한다. 글자가 움직여도 경계선은 제자리에 서 있어야 하므로,
 *    움직이기 **전** 자리로 계산한 상자 좌표를 쓴다.
 */

import { REVEAL_GLSL } from './reveal.ts'

export const TEXT_VS = /* glsl */ `#version 300 es
uniform mat3 u_matrix;
/** 아틀라스에서 이 글자가 있는 칸. (u0, v0, du, dv) */
uniform vec4 u_atlas;
/** 글자 상자 안에서 이 글자의 원래 자리. (x, y, w, h) 를 0~1 로 정규화한 값이다. */
uniform vec4 u_box;

out vec2 v_uv;
out vec2 v_box;

void main() {
  vec2 uv = vec2(float(gl_VertexID & 1), float((gl_VertexID >> 1) & 1));
  v_uv = u_atlas.xy + uv * u_atlas.zw;
  v_box = u_box.xy + uv * u_box.zw;
  vec3 p = u_matrix * vec3(uv, 1.0);
  gl_Position = vec4(p.xy, 0.0, p.z);
}
`

export const TEXT_FS = /* glsl */ `#version 300 es
precision highp float;

uniform sampler2D u_image;
uniform float u_opacity;
/** 글자 하나의 투명도. 글자별 등장이 쓴다. */
uniform float u_charAlpha;
${REVEAL_GLSL}

in vec2 v_uv;
in vec2 v_box;
out vec4 fragColor;

void main() {
  vec4 c = texture(u_image, v_uv);
  float a = c.a * u_opacity * u_charAlpha * mmRevealMask(v_box);
  fragColor = vec4(c.rgb * a, a);
}
`
