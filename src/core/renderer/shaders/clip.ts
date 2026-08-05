/**
 * 자르기(클리핑 마스크) 합성.
 *
 * 위 레이어를 밑판의 알파로만 깎아서 내보낸다. 색은 보지 않는다. 그래야
 * 반투명한 가장자리가 반투명하게 잘리고, 글자의 안티에일리어싱이 살아난다.
 *
 * 파이프라인이 premultiplied 라서 곱하기 한 번이면 끝난다. rgb 와 a 에 같은 배수를
 * 걸어야 rgb <= a 불변식이 유지되는데, 스칼라 곱은 그 조건을 저절로 만족한다.
 * straight 였다면 rgb 는 그대로 두고 a 만 곱해야 해서 분기가 하나 더 필요했다.
 *
 * 블렌딩은 호출자가 켜 둔다. 결과를 덩어리 버퍼 위에 노멀 합성하는 것이 전부다.
 */

export const CLIP_FS = /* glsl */ `#version 300 es
precision highp float;

uniform sampler2D u_image;   // 자를 레이어 (premultiplied)
uniform sampler2D u_mask;    // 밑판. 알파만 쓴다

in vec2 v_uv;
out vec4 fragColor;

void main() {
  fragColor = texture(u_image, v_uv) * texture(u_mask, v_uv).a;
}
`
