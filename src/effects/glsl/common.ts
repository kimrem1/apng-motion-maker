/**
 * 이펙트 셰이더 공용 GLSL 스니펫.
 *
 * ---------------------------------------------------------------------------
 * 난수 규칙
 * ---------------------------------------------------------------------------
 * 셰이더 난수는 **정수 비트 해시(PCG 계열)** 만 쓴다.
 *
 * 삼각함수의 소수부를 취하는 관용구(널리 쓰이는 그 한 줄짜리 해시)는 이 저장소에서
 * 금지다. sin 의 큰 인자에서의 정밀도가 드라이버마다 달라서 같은 문서가 GPU 마다
 * 다른 픽셀을 낸다. 픽셀 단위 노이즈에서는 그 차이가 그대로 보인다.
 * PCG 는 정수 연산만 쓰므로 결과가 비트 단위로 같다.
 *
 * 정밀도도 계약이다. GLSL ES 3.00 의 프래그먼트 기본 int 정밀도는 mediump 이고
 * 그건 16비트만 보장한다. 32비트 해시가 잘려 나가면 결과가 완전히 달라지므로
 * 모든 이펙트 셰이더는 `precision highp int;` 를 선언한다 (EFFECT_FS_PRELUDE).
 *
 * sin / cos 자체를 금지하는 것이 아니다. 회전 행렬과 물결 왜곡처럼 인자가 작고
 * 매끄러운 용도는 안전하다. 금지되는 것은 난수 생성에 쓰는 것이다.
 */

export const GLSL_COMMON = /* glsl */ `
// ---------------------------------------------------------------------------
// PCG 정수 비트 해시
// ---------------------------------------------------------------------------

uvec2 pcg2d(uvec2 v) {
  v = v * 1664525u + 1013904223u;
  v.x += v.y * 1664525u;
  v.y += v.x * 1664525u;
  v ^= v >> 16u;
  v.x += v.y * 1664525u;
  v.y += v.x * 1664525u;
  v ^= v >> 16u;
  return v;
}

uvec3 pcg3d(uvec3 v) {
  v = v * 1664525u + 1013904223u;
  v.x += v.y * v.z;
  v.y += v.z * v.x;
  v.z += v.x * v.y;
  v ^= v >> 16u;
  v.x += v.y * v.z;
  v.y += v.z * v.x;
  v.z += v.x * v.y;
  return v;
}

/** 상위 24비트만 쓴다. float 가 정확히 표현할 수 있는 범위라 반올림이 끼지 않는다. */
float fxUintToUnit(uint u) {
  return float(u >> 8u) * (1.0 / 16777216.0);
}

/** 격자 좌표를 uint 로 접는다. floor 를 먼저 해야 -0.5 와 0.5 가 같은 칸으로 뭉치지 않는다. */
uvec2 fxCell(vec2 p) {
  return uvec2(ivec2(floor(p)));
}

float hash11(float x) {
  return fxUintToUnit(pcg2d(uvec2(uint(int(x)), 0x9e3779b9u)).x);
}

float hash21(vec2 p) {
  return fxUintToUnit(pcg2d(fxCell(p)).x);
}

vec2 hash22(vec2 p) {
  uvec2 h = pcg2d(fxCell(p));
  return vec2(fxUintToUnit(h.x), fxUintToUnit(h.y));
}

/**
 * 정수 키 오버로드.
 *
 * 슬라이스 번호, 블록 id, 픽셀 좌표처럼 이미 정수인 키는 float 을 거치지 않고
 * 그대로 해시해야 한다. float 으로 왕복하면 큰 값에서 정밀도가 떨어져
 * 서로 다른 블록이 같은 난수를 받는다. GPU 마다 그 임계가 달라 결과도 갈린다.
 */
float hash21(uvec2 p) {
  return fxUintToUnit(pcg2d(p).x);
}

vec2 hash22(uvec2 p) {
  uvec2 h = pcg2d(p);
  return vec2(fxUintToUnit(h.x), fxUintToUnit(h.y));
}

/** 난수 3개. 켜짐 판정 / 오프셋 / 밝기를 한 번에 뽑을 때 쓴다. */
vec3 hash23(vec2 p, float salt) {
  uvec3 h = pcg3d(uvec3(fxCell(p), uint(int(salt))));
  return vec3(fxUintToUnit(h.x), fxUintToUnit(h.y), fxUintToUnit(h.z));
}

// ---------------------------------------------------------------------------
// 값 노이즈
// ---------------------------------------------------------------------------

/** 5차 스무스스텝. 2차 도함수까지 연속이라 격자 경계에서 기울기가 튀지 않는다. */
vec2 fxSmoother(vec2 t) {
  return t * t * t * (t * (t * 6.0 - 15.0) + 10.0);
}

/** 2D 값 노이즈. [0, 1) */
float valueNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fxSmoother(p - i);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

// ---------------------------------------------------------------------------
// 기하
// ---------------------------------------------------------------------------

mat2 rot2(float a) {
  float s = sin(a);
  float c = cos(a);
  return mat2(c, s, -s, c);
}

// ---------------------------------------------------------------------------
// 알파 (파이프라인 전체가 premultiplied 다)
// ---------------------------------------------------------------------------

/** 알파 0 에서 나누기가 생긴다. 투명 스티커가 주 용도라 그 픽셀이 화면 대부분이다. */
vec4 fxUnpremultiply(vec4 c) {
  return c.a > 0.0 ? vec4(c.rgb / c.a, c.a) : vec4(0.0);
}

vec4 fxPremultiply(vec4 c) {
  return vec4(c.rgb * c.a, c.a);
}

/** rgb <= a 를 강제한다. 이걸 깨면 합성 결과에 유령 테두리가 남는다. */
vec4 fxClampPremultiplied(vec4 c) {
  float a = clamp(c.a, 0.0, 1.0);
  return vec4(clamp(c.rgb, vec3(0.0), vec3(a)), a);
}

float fxLuma(vec3 c) {
  return dot(c, vec3(0.2126, 0.7152, 0.0722));
}

// 짧은 이름. 조각 쪽 코드가 읽기 쉬워진다. 동작은 위 두 함수와 같다.
vec4 unpremul(vec4 c) { return fxUnpremultiply(c); }
vec4 premul(vec4 c) { return fxPremultiply(c); }
float luma(vec3 c) { return fxLuma(c); }

/**
 * 경계 밖은 투명으로 읽는다.
 * CLAMP_TO_EDGE 로 두면 가장자리 픽셀이 캔버스 전체로 번진다. 투명 배경 결과물에서
 * 그건 즉시 눈에 띄는 하자다. 화면을 채우는 레이어는 오버스캔 솔버가 담당한다.
 */
vec4 fxFetch(sampler2D tex, vec2 uv) {
  vec2 inside = step(vec2(0.0), uv) * step(uv, vec2(1.0));
  return texture(tex, uv) * (inside.x * inside.y);
}

/** 채움 모드. 0 투명 / 1 클램프 / 2 랩 / 3 미러 */
vec2 fxFillUv(vec2 uv, int mode) {
  if (mode == 1) return clamp(uv, 0.0, 1.0);
  if (mode == 2) return fract(uv);
  if (mode == 3) {
    vec2 t = fract(uv * 0.5) * 2.0;
    return 1.0 - abs(t - 1.0);
  }
  return uv;
}

// ---------------------------------------------------------------------------
// 디더 (Bayer)
// ---------------------------------------------------------------------------

const int FX_BAYER4[16] = int[16](
  0, 8, 2, 10,
  12, 4, 14, 6,
  3, 11, 1, 9,
  15, 7, 13, 5
);

const int FX_BAYER2[4] = int[4](0, 2, 3, 1);

/** [0, 1) */
float fxBayer4(vec2 p) {
  ivec2 q = ivec2(mod(floor(p), 4.0));
  return float(FX_BAYER4[q.y * 4 + q.x]) / 16.0;
}

/** 재귀 정의: M_2n = 4 * M_n(하위) + M_2(상위) */
float fxBayer8(vec2 p) {
  ivec2 q = ivec2(mod(floor(p), 8.0));
  int lo = FX_BAYER4[(q.y & 3) * 4 + (q.x & 3)];
  int hi = FX_BAYER2[(q.y >> 2) * 2 + (q.x >> 2)];
  return float(lo * 4 + hi) / 64.0;
}
`

/** 같은 문자열의 다른 이름. 조각 카탈로그가 이 이름으로 참조한다. */
export const COMMON_GLSL = GLSL_COMMON

/**
 * 모든 이펙트 프래그먼트 셰이더가 공유하는 프렐류드.
 *
 * u_image        레이어 렌더 결과 (premultiplied)
 * u_noiseAtlas   시간축 심리스 노이즈 (noiseAtlas.ts). 쓰는 셰이더만 실제로 바인딩된다.
 * u_noiseLayers  아틀라스 레이어 수
 * u_resolution   출력 해상도 (px)
 * u_texel        1 / u_resolution
 * u_aspect       width / height
 */
export const EFFECT_FS_PRELUDE = /* glsl */ `#version 300 es
precision highp float;
precision highp int;

uniform sampler2D u_image;
uniform mediump sampler2DArray u_noiseAtlas;
uniform float u_noiseLayers;
uniform vec2 u_resolution;
uniform vec2 u_texel;
uniform float u_aspect;

in vec2 v_uv;
out vec4 fragColor;
${GLSL_COMMON}`

/** B 스테이지 셰이더 한 장을 만든다. declarations 에는 유니폼 선언과 헬퍼를 넣는다. */
export function effectFragmentShader(declarations: string, body: string): string {
  return `${EFFECT_FS_PRELUDE}
${declarations}

void main() {
${body}
}
`
}
