/**
 * 레이어 쿼드 셰이더.
 *
 * 정점 버퍼가 없다. gl_VertexID 로 유닛 사각형을 만들고 TRIANGLE_STRIP 4개를 그린다.
 * attribute-less draw 다.
 */

import { REVEAL_GLSL } from './reveal.ts'

export const LAYER_VS = /* glsl */ `#version 300 es
uniform mat3 u_matrix;
out vec2 v_uv;

void main() {
  // id 0,1,2,3 -> (0,0) (1,0) (0,1) (1,1)
  vec2 uv = vec2(float(gl_VertexID & 1), float((gl_VertexID >> 1) & 1));
  v_uv = uv;
  vec3 p = u_matrix * vec3(uv, 1.0);
  /*
   * w 로 p.z 를 넘긴다. 3D 회전(호모그래피)의 원근 나눗셈이 여기서 일어나고,
   * v_uv 의 원근 보정 보간도 래스터라이저가 공짜로 해 준다.
   *
   * **옛 문서의 픽셀은 한 점도 바뀌지 않는다.** rotateX / rotateY 가 0 이면
   * buildLayerMatrix 가 마지막 행을 [0,0,1] 그대로 두므로 p.z 가 정확히 1.0 이다.
   */
  gl_Position = vec4(p.xy, 0.0, p.z);
}
`

export const LAYER_FS = /* glsl */ `#version 300 es
precision highp float;

uniform sampler2D u_image;
uniform float u_opacity;
${REVEAL_GLSL}

in vec2 v_uv;
out vec4 fragColor;

void main() {
  // 텍스처는 straight alpha 로 올라와 있다 (gl.ts 참조).
  vec4 c = texture(u_image, v_uv);
  float a = c.a * u_opacity * mmRevealMask(v_uv);
  // 출력은 premultiplied. 블렌드는 (ONE, ONE_MINUS_SRC_ALPHA).
  fragColor = vec4(c.rgb * a, a);
}
`

/**
 * 전체화면 패스용 빅 트라이앵글. 이펙트 체인이 쓴다.
 * 정점 3개로 화면을 덮으면 쿼드 대각선의 중복 셰이딩이 사라진다.
 */
export const FULLSCREEN_VS = /* glsl */ `#version 300 es
out vec2 v_uv;

void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  v_uv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`

export const COPY_FS = /* glsl */ `#version 300 es
precision highp float;

uniform sampler2D u_image;

in vec2 v_uv;
out vec4 fragColor;

void main() {
  fragColor = texture(u_image, v_uv);
}
`
