/**
 * B 스테이지(파괴) 원자 이펙트.
 *
 * B 는 이웃 픽셀과 상태에 의존한다. 그래서 C 처럼 하나로 융합하지 못하고
 * 각자 독립 프래그먼트 셰이더 전체를 가진다.
 *
 * 공통 계약
 *   - 입력 u_image 와 출력 fragColor 는 **모두 premultiplied** 다.
 *   - 색을 만질 때만 unpremul 하고 끝에 premul 로 되돌린다.
 *   - premultiplied 불변식 rgb <= a 를 절대 깨지 않는다. 깨면 블렌드가 발산한다.
 *   - 난수는 정수 비트 해시(PCG)만 쓴다. fract(sin(x)) 는 GPU 마다 결과가 달라
 *     프리뷰와 내보내기가 갈린다.
 *   - 프레임 간 캐리오버가 없다. 시드는 매 프레임 effFrame 으로 재생성된다.
 *
 * 셰이더에서 캔버스 밖을 샘플할 때 기본값은 투명이다. 이 제품의 주 용도가
 * 투명 배경 스티커라(14.A1) 가장자리 색이 늘어나면 실루엣이 오염된다.
 */

import { COMMON_GLSL } from '@/effects/glsl/common.ts'
import type { EffectDef, EffectUniformContext } from '@/effects/types.ts'

// ---------------------------------------------------------------------------
// 로컬 헬퍼
// ---------------------------------------------------------------------------

/** 해석된 파라미터 읽기. 누락/NaN 이면 기본값으로 떨어진다. */
function pv(ctx: EffectUniformContext, key: string, fallback: number): number {
  const v = ctx.params[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

const DEG2RAD = Math.PI / 180

/**
 * B 스테이지 프래그먼트 셰이더 전체를 조립한다.
 *
 * precision highp int 는 장식이 아니다. 프래그먼트 셰이더의 int 기본 정밀도는
 * mediump 라서 이걸 빼면 PCG 해시가 32비트로 돌지 않고 기기마다 다른 값을 낸다.
 */
function fs(body: string): string {
  return `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;

${COMMON_GLSL}

uniform sampler2D u_image;
uniform vec2 u_resolution;

in vec2 v_uv;
out vec4 fragColor;

${body}`
}

/** 캔버스 밖은 투명으로 읽는 공용 샘플러. B 셰이더마다 붙인다. */
const TAP = /* glsl */ `
vec4 tap(vec2 uv) {
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return vec4(0.0);
  return texture(u_image, uv);
}
`

// ---------------------------------------------------------------------------
// 1. RGB 분리 / 색수차
// ---------------------------------------------------------------------------

const RGB_SHIFT_FS = fs(/* glsl */ `
uniform float u_amount;   // px
uniform float u_angle;    // rad
uniform float u_radial;
uniform int   u_fringe;   // 0 실루엣 유지, 1 가장자리 확장
${TAP}

void main() {
  vec2 texel = 1.0 / u_resolution;
  vec2 dir = vec2(cos(u_angle), sin(u_angle));
  // 방사형 성분은 중심에서 멀수록 커진다. 렌즈 색수차의 모양이다.
  vec2 d = (v_uv - 0.5) * 2.0;
  vec2 off = (dir + d * u_radial) * u_amount * texel;

  vec4 sr = tap(v_uv + off);
  vec4 sg = texture(u_image, v_uv);
  vec4 sb = tap(v_uv - off);

  vec3 rgb = vec3(sr.r, sg.g, sb.b);
  float a = (u_fringe == 1) ? max(max(sr.a, sg.a), sb.a) : sg.a;
  // rgb <= a 를 강제한다. 실루엣 유지 모드에서 이 클램프가 프린지를 실루엣 안에 가둔다.
  fragColor = vec4(min(rgb, vec3(a)), a);
}
`)

const rgbShift: EffectDef = {
  id: 'glitch.rgbShift',
  label: 'RGB 분리',
  hint: '빨강과 파랑을 반대 방향으로 밀어 색수차를 만든다.',
  stage: 'B',
  cost: 'low',
  preservesAlpha: true,
  params: [
    { key: 'amount', label: '진폭', type: 'number', min: 0, max: 40, step: 0.5, unit: 'px', default: 4 },
    { key: 'angle', label: '각도', type: 'number', min: 0, max: 360, step: 1, unit: '°', default: 0 },
    { key: 'radial', label: '방사형', type: 'number', min: 0, max: 2, step: 0.05, default: 0 },
    {
      key: 'fringe',
      label: '가장자리',
      type: 'select',
      options: [
        { value: 0, label: '실루엣 유지' },
        { value: 1, label: '바깥으로 확장' },
      ],
      default: 0,
    },
  ],
  fragment: RGB_SHIFT_FS,
  uniforms: [
    { name: 'u_resolution', type: 'vec2', value: (c) => [c.width, c.height] },
    { name: 'u_amount', type: 'float', value: (c) => pv(c, 'amount', 4) },
    { name: 'u_angle', type: 'float', value: (c) => pv(c, 'angle', 0) * DEG2RAD },
    { name: 'u_radial', type: 'float', value: (c) => pv(c, 'radial', 0) },
    { name: 'u_fringe', type: 'int', value: (c) => Math.round(pv(c, 'fringe', 0)) },
  ],
}

// ---------------------------------------------------------------------------
// 2. 슬라이스 밀림
// ---------------------------------------------------------------------------

const SLICE_FS = fs(/* glsl */ `
uniform float u_slices;
uniform float u_maxOffset;    // px
uniform float u_probability;
uniform int   u_fill;         // 0 투명 1 클램프 2 랩 3 미러
uniform int   u_axis;         // 0 가로 밀림 1 세로 밀림
uniform int   u_roll;         // 정수 슬라이스 롤 (CPU 계산)
uniform uint  u_seed;

float fillCoord(float x) {
  if (u_fill == 1) return clamp(x, 0.0, 1.0);
  if (u_fill == 2) return fract(x);
  if (u_fill == 3) {
    float t = fract(x * 0.5) * 2.0;
    return t > 1.0 ? 2.0 - t : t;
  }
  return x;
}

void main() {
  int n = int(max(1.0, floor(u_slices)));
  float along = (u_axis == 0) ? v_uv.y : v_uv.x;
  int idx = int(floor(clamp(along, 0.0, 0.999999) * float(n)));

  // 롤은 정수 슬라이스 단위다. 정수라야 한 루프 끝에서 패턴이 정확히 제자리로 온다.
  int rolled = idx + u_roll;
  rolled -= int(floor(float(rolled) / float(n))) * n;

  vec2 rnd = hash22(uvec2(uint(rolled), u_seed));
  // 'active' 는 GLSL ES 예약어다. 변수 이름으로 쓰면 컴파일이 통째로 실패한다.
  float onSlice = step(rnd.x, u_probability);
  float shift = (rnd.y * 2.0 - 1.0) * u_maxOffset * onSlice;

  float texel = (u_axis == 0) ? (1.0 / u_resolution.x) : (1.0 / u_resolution.y);
  float src = ((u_axis == 0) ? v_uv.x : v_uv.y) + shift * texel;

  if (u_fill == 0 && (src < 0.0 || src > 1.0)) {
    fragColor = vec4(0.0);
    return;
  }

  vec2 uv = v_uv;
  float safe = fillCoord(src);
  if (u_axis == 0) uv.x = safe; else uv.y = safe;
  fragColor = texture(u_image, uv);
}
`)

/** 롤 오프셋을 정수 슬라이스로 계산한다. 루프 끝에서 슬라이스 수의 배수가 되어 이음새가 없다. */
function sliceRoll(c: EffectUniformContext): number {
  const n = Math.max(1, Math.floor(pv(c, 'slices', 16)))
  const dur = Math.max(1, c.durationFrames)
  const cycles = Math.round(pv(c, 'rollCycles', 0))
  return Math.round((cycles * n * c.effFrame) / dur)
}

const slice: EffectDef = {
  id: 'glitch.slice',
  label: '슬라이스 밀림',
  hint: '가로 띠 단위로 화면을 어긋나게 민다. 신호가 끊긴 것처럼 보인다.',
  stage: 'B',
  cost: 'low',
  preservesAlpha: true,
  params: [
    { key: 'slices', label: '슬라이스 수', type: 'number', min: 2, max: 64, step: 1, default: 16 },
    { key: 'maxOffset', label: '최대 밀림', type: 'number', min: 0, max: 200, step: 1, unit: 'px', default: 24 },
    { key: 'probability', label: '확률', type: 'number', min: 0, max: 1, step: 0.01, default: 0.4 },
    {
      key: 'fill',
      label: '채움',
      type: 'select',
      options: [
        { value: 0, label: '투명' },
        { value: 1, label: '가장자리 늘리기' },
        { value: 2, label: '반대쪽에서 감기' },
        { value: 3, label: '거울' },
      ],
      default: 0,
    },
    {
      key: 'axis',
      label: '방향',
      type: 'select',
      options: [
        { value: 0, label: '가로로 밀기' },
        { value: 1, label: '세로로 밀기' },
      ],
      default: 0,
    },
    { key: 'rollCycles', label: '롤', type: 'number', min: -8, max: 8, step: 1, unit: '회/루프', default: 0 },
  ],
  fragment: SLICE_FS,
  uniforms: [
    { name: 'u_resolution', type: 'vec2', value: (c) => [c.width, c.height] },
    { name: 'u_slices', type: 'float', value: (c) => Math.max(1, Math.floor(pv(c, 'slices', 16))) },
    { name: 'u_maxOffset', type: 'float', value: (c) => pv(c, 'maxOffset', 24) },
    { name: 'u_probability', type: 'float', value: (c) => pv(c, 'probability', 0.4) },
    { name: 'u_fill', type: 'int', value: (c) => Math.round(pv(c, 'fill', 0)) },
    { name: 'u_axis', type: 'int', value: (c) => Math.round(pv(c, 'axis', 0)) },
    { name: 'u_roll', type: 'int', value: sliceRoll },
    { name: 'u_seed', type: 'uint', value: (c) => c.seed >>> 0 },
  ],
}

// ---------------------------------------------------------------------------
// 3. 블록 깨짐
// ---------------------------------------------------------------------------

const BLOCK_FS = fs(/* glsl */ `
uniform float u_size;      // 가장 굵은 블록 px
uniform int   u_tiers;     // 1..3
uniform float u_density;
uniform float u_jitter;    // 블록 크기 대비 변위 배수
uniform float u_swap;
uniform float u_invert;
uniform uint  u_seed;
${TAP}

void main() {
  vec2 px = v_uv * u_resolution;
  vec2 offUv = vec2(0.0);
  float swapPick = 0.0;
  float invPick = 0.0;

  for (int t = 0; t < 3; t++) {
    if (t >= u_tiers) break;
    float cell = max(2.0, u_size / exp2(float(t)));
    uvec2 bid = uvec2(floor(px / cell));
    // 블록 id 를 하나의 정수로 접고 단 번호를 섞는다.
    uint k = bid.x ^ (bid.y << 16u) ^ (uint(t) * 0x9e3779b9u);
    vec2 ra = hash22(uvec2(k, u_seed));
    vec2 rb = hash22(uvec2(k ^ 0x85ebca6bu, u_seed));

    // 굵은 단은 자주, 잔 단은 드물게 흔든다. 전부 같은 밀도면 화면이 그냥 죽는다.
    float w = u_density / exp2(float(t) * 0.5);
    if (ra.x < w) {
      vec2 j = (vec2(ra.y, rb.x) * 2.0 - 1.0) * u_jitter * cell;
      offUv += j / u_resolution;
      swapPick = max(swapPick, step(rb.y, u_swap));
      invPick = max(invPick, step(1.0 - rb.y, u_invert));
    }
  }

  vec4 c = tap(v_uv + offUv);
  // 채널 회전. 각 성분이 여전히 a 이하라 premultiplied 불변식이 유지된다.
  if (swapPick > 0.5) c.rgb = c.gbr;
  // straight 반전과 동치다: a * (1 - s) = a - a*s
  if (invPick > 0.5) c.rgb = c.a - c.rgb;
  fragColor = c;
}
`)

const block: EffectDef = {
  id: 'glitch.block',
  label: '블록 깨짐',
  hint: '사각 블록을 통째로 어긋내고 채널을 뒤섞는다.',
  stage: 'B',
  cost: 'low',
  preservesAlpha: true,
  params: [
    { key: 'size', label: '블록 크기', type: 'number', min: 4, max: 128, step: 1, unit: 'px', default: 24 },
    { key: 'tiers', label: '크기 단계', type: 'number', min: 1, max: 3, step: 1, default: 2 },
    { key: 'density', label: '밀도', type: 'number', min: 0, max: 1, step: 0.01, default: 0.25 },
    { key: 'jitter', label: '지터', type: 'number', min: 0, max: 2, step: 0.05, default: 0.5 },
    { key: 'swap', label: '채널 스왑', type: 'number', min: 0, max: 1, step: 0.01, default: 0.2 },
    { key: 'invert', label: '채널 반전', type: 'number', min: 0, max: 1, step: 0.01, default: 0.05 },
  ],
  fragment: BLOCK_FS,
  uniforms: [
    { name: 'u_resolution', type: 'vec2', value: (c) => [c.width, c.height] },
    { name: 'u_size', type: 'float', value: (c) => pv(c, 'size', 24) },
    { name: 'u_tiers', type: 'int', value: (c) => Math.min(3, Math.max(1, Math.round(pv(c, 'tiers', 2)))) },
    { name: 'u_density', type: 'float', value: (c) => pv(c, 'density', 0.25) },
    { name: 'u_jitter', type: 'float', value: (c) => pv(c, 'jitter', 0.5) },
    { name: 'u_swap', type: 'float', value: (c) => pv(c, 'swap', 0.2) },
    { name: 'u_invert', type: 'float', value: (c) => pv(c, 'invert', 0.05) },
    { name: 'u_seed', type: 'uint', value: (c) => c.seed >>> 0 },
  ],
}

// ---------------------------------------------------------------------------
// 4. 노이즈 밴드
// ---------------------------------------------------------------------------

const BAND_FS = fs(/* glsl */ `
uniform float u_bands;
uniform float u_thickness;
uniform float u_phase;      // 스크롤 위상 (밴드 단위, CPU 계산)
uniform float u_offset;     // 정적 위치 (밴드 단위)
uniform float u_lift;
uniform float u_tearing;
uniform float u_noise;
uniform uint  u_seed;        // 프레임(홀드 클럭)마다 바뀐다
uniform uint  u_seedStatic;  // 루프 전체에서 고정

void main() {
  int nb = int(max(1.0, floor(u_bands)));
  float t = v_uv.y * float(nb) + u_phase + u_offset * float(nb);
  float f = fract(t);

  // 밴드 id 를 밴드 수로 모듈로 한다. 위상이 한 루프에서 정확히 밴드 수의 배수만큼
  // 움직이므로, 이 모듈로가 있어야 마지막 프레임이 첫 프레임과 같아진다.
  int ib = int(floor(t));
  ib -= int(floor(float(ib) / float(nb))) * nb;
  uint id = uint(ib);

  // 밴드의 정체성은 루프 내내 고정이다. 그래야 스크롤이 '이동' 으로 보인다.
  vec2 rs = hash22(uvec2(id, u_seedStatic));
  // 세기는 프레임마다 다시 뽑는다. 지지직거리는 성분이다.
  vec2 rf = hash22(uvec2(id, u_seed));

  float w = max(0.001, u_thickness * (0.4 + 0.6 * rs.x));
  float m = 1.0 - smoothstep(w * 0.75, w, f);
  m *= step(0.35, rs.y);   // 모든 밴드가 켜지지는 않는다

  // 티어링은 밴드 안쪽만 옆으로 찢는다.
  vec2 uv = v_uv;
  uv.x = fract(uv.x + (rf.x * 2.0 - 1.0) * u_tearing * 0.25 * m);

  vec4 c = texture(u_image, uv);
  if (c.a <= 0.0) {
    fragColor = c;
    return;
  }

  // 픽셀 단위 노이즈. 정수 좌표 해시라 해상도가 같으면 어디서든 같은 값이 나온다.
  uvec2 p = uvec2(v_uv * u_resolution);
  float n = hash21(uvec2(p.x ^ (p.y << 16u), u_seed)) - 0.5;

  vec4 s = unpremul(c);
  float lift = m * (u_lift * (0.5 + 0.5 * rf.y) + n * u_noise);
  s.rgb = clamp(s.rgb + lift, 0.0, 1.0);
  fragColor = premul(vec4(s.rgb, c.a));
}
`)

const band: EffectDef = {
  id: 'glitch.band',
  label: '노이즈 밴드',
  hint: '가로 띠를 밝게 들뜨게 하고 옆으로 찢는다. VHS 헤드 스위칭에 쓴다.',
  stage: 'B',
  cost: 'low',
  preservesAlpha: true,
  params: [
    { key: 'bands', label: '밴드 수', type: 'number', min: 1, max: 32, step: 1, default: 6 },
    { key: 'thickness', label: '두께', type: 'number', min: 0.01, max: 0.5, step: 0.01, default: 0.08 },
    { key: 'offset', label: '위치', type: 'number', min: 0, max: 1, step: 0.01, default: 0 },
    { key: 'scrollCycles', label: '스크롤', type: 'number', min: -8, max: 8, step: 1, unit: '회/루프', default: 1 },
    { key: 'lift', label: '밝기 리프트', type: 'number', min: 0, max: 1, step: 0.01, default: 0.3 },
    { key: 'tearing', label: '티어링', type: 'number', min: 0, max: 1, step: 0.01, default: 0.3 },
    { key: 'noise', label: '노이즈', type: 'number', min: 0, max: 1, step: 0.01, default: 0.25 },
  ],
  fragment: BAND_FS,
  uniforms: [
    { name: 'u_resolution', type: 'vec2', value: (c) => [c.width, c.height] },
    { name: 'u_bands', type: 'float', value: (c) => Math.max(1, Math.floor(pv(c, 'bands', 6))) },
    { name: 'u_thickness', type: 'float', value: (c) => pv(c, 'thickness', 0.08) },
    { name: 'u_offset', type: 'float', value: (c) => pv(c, 'offset', 0) },
    {
      name: 'u_phase',
      type: 'float',
      // 한 루프에서 정확히 (밴드 수 x 정수 사이클) 만큼 흐른다. 이것이 심리스의 근거다.
      value: (c) => {
        const nb = Math.max(1, Math.floor(pv(c, 'bands', 6)))
        const dur = Math.max(1, c.durationFrames)
        return (Math.round(pv(c, 'scrollCycles', 1)) * nb * c.effFrame) / dur
      },
    },
    { name: 'u_lift', type: 'float', value: (c) => pv(c, 'lift', 0.3) },
    { name: 'u_tearing', type: 'float', value: (c) => pv(c, 'tearing', 0.3) },
    { name: 'u_noise', type: 'float', value: (c) => pv(c, 'noise', 0.25) },
    { name: 'u_seed', type: 'uint', value: (c) => c.seed >>> 0 },
    { name: 'u_seedStatic', type: 'uint', value: (c) => c.seedStatic >>> 0 },
  ],
}

// ---------------------------------------------------------------------------
// 5. 픽셀 소트
// ---------------------------------------------------------------------------

/**
 * 홀짝 전위 정렬(odd-even transposition sort)의 한 스텝이다.
 *
 * 진짜 정렬은 GPU 프래그먼트 셰이더로 못 한다. 대신 이웃 두 칸을 비교/교환하는
 * 패스를 반복해 근사한다. 반복 횟수만큼만 값이 이동하므로 **반복 횟수는 반드시
 * 문서에 저장**해야 한다. 저장하지 않고 성능에 맞춰 조절하면 프리뷰와 내보내기가
 * 다른 그림을 낸다.
 *
 * 패스 짝수/홀수에 따라 짝을 (0,1)(2,3) 과 (1,2)(3,4) 로 번갈아 잡는다.
 * 한 짝의 두 픽셀이 서로 정확히 반대 결론을 내야 교환이 성립한다.
 */
const PIXEL_SORT_FS = fs(/* glsl */ `
uniform float u_threshold;
uniform int   u_key;     // 0 휘도 1 알파 2 채도
uniform int   u_axis;    // 0 세로 1 가로
uniform int   u_order;   // 0 오름차순 1 내림차순
uniform int   u_pass;

float sortKey(vec4 c) {
  if (u_key == 1) return c.a;
  vec4 s = unpremul(c);
  if (u_key == 2) {
    float mx = max(max(s.r, s.g), s.b);
    float mn = min(min(s.r, s.g), s.b);
    return mx - mn;
  }
  return dot(s.rgb, vec3(0.2126, 0.7152, 0.0722));
}

void main() {
  vec4 self = texture(u_image, v_uv);

  vec2 dir = (u_axis == 0) ? vec2(0.0, 1.0) : vec2(1.0, 0.0);
  float len = (u_axis == 0) ? u_resolution.y : u_resolution.x;
  float coord = (u_axis == 0) ? (v_uv.y * u_resolution.y) : (v_uv.x * u_resolution.x);

  int i = int(floor(coord));
  int parity = u_pass & 1;
  bool low = ((i + parity) & 1) == 0;
  int partner = low ? (i + 1) : (i - 1);
  if (partner < 0 || partner >= int(len)) {
    fragColor = self;
    return;
  }

  vec2 step1 = dir / u_resolution;
  vec4 other = texture(u_image, v_uv + step1 * (low ? 1.0 : -1.0));

  float ks = sortKey(self);
  float ko = sortKey(other);
  // 임계 아래는 정렬 대상이 아니다. 양쪽 다 대상일 때만 교환한다.
  if (ks < u_threshold || ko < u_threshold) {
    fragColor = self;
    return;
  }

  bool selfFirst = (u_order == 0) ? (ks <= ko) : (ks >= ko);
  // low 는 짝의 앞자리다. 앞자리에는 '먼저 와야 할' 값이 남는다.
  bool keepSelf = low ? selfFirst : !selfFirst;
  fragColor = keepSelf ? self : other;
}
`)

const pixelSort: EffectDef = {
  id: 'glitch.pixelSort',
  label: '픽셀 소트',
  hint: '밝은 픽셀만 한 방향으로 흘러내리게 한다. 반복 횟수가 흘러내린 길이다.',
  stage: 'B',
  cost: 'mid',
  preservesAlpha: true,
  params: [
    { key: 'threshold', label: '임계', type: 'number', min: 0, max: 1, step: 0.01, default: 0.5 },
    {
      key: 'key',
      label: '정렬 키',
      type: 'select',
      options: [
        { value: 0, label: '밝기' },
        { value: 1, label: '불투명도' },
        { value: 2, label: '선명함' },
      ],
      default: 0,
    },
    {
      key: 'axis',
      label: '축',
      type: 'select',
      options: [
        { value: 0, label: '세로' },
        { value: 1, label: '가로' },
      ],
      default: 0,
    },
    {
      key: 'order',
      label: '순서',
      type: 'select',
      options: [
        { value: 0, label: '어두운 쪽이 앞' },
        { value: 1, label: '밝은 쪽이 앞' },
      ],
      default: 0,
    },
    // 이 값은 성능에 따라 바꾸면 안 된다. 결과 픽셀이 달라진다.
    { key: 'iterations', label: '반복 횟수', type: 'number', min: 1, max: 64, step: 1, default: 16 },
  ],
  fragment: PIXEL_SORT_FS,
  passes: (params) => {
    const v = params['iterations']
    const n = typeof v === 'number' && Number.isFinite(v) ? v : 16
    return Math.min(64, Math.max(1, Math.round(n)))
  },
  uniforms: [
    { name: 'u_resolution', type: 'vec2', value: (c) => [c.width, c.height] },
    { name: 'u_threshold', type: 'float', value: (c) => pv(c, 'threshold', 0.5) },
    { name: 'u_key', type: 'int', value: (c) => Math.round(pv(c, 'key', 0)) },
    { name: 'u_axis', type: 'int', value: (c) => Math.round(pv(c, 'axis', 0)) },
    { name: 'u_order', type: 'int', value: (c) => Math.round(pv(c, 'order', 0)) },
    { name: 'u_pass', type: 'int', value: (c) => c.pass },
  ],
}

// ---------------------------------------------------------------------------
// 6. 크로마 열화 (VHS 매크로의 핵심 원자)
// ---------------------------------------------------------------------------

/**
 * RGB 를 YIQ 로 바꿔 **크로마(I, Q)만** 망가뜨린다.
 *
 * VHS 가 지저분해 보이는 이유는 휘도 대역폭은 그럭저럭 살아 있고 색차 대역폭만
 * 심하게 좁기 때문이다. RGB 를 통째로 블러하면 그냥 초점 나간 그림이 되고
 * "VHS 같다" 는 인상이 전혀 안 산다. 휘도는 고스팅 외에는 건드리지 않는다.
 *
 * 알파는 손대지 않는다. 고스팅도 원본 알파 안에서만 더해지므로 실루엣이 번지지 않는다.
 */
const CHROMA_FS = fs(/* glsl */ `
uniform float u_blur;       // 크로마 수평 블러 px
uniform float u_offset;     // 크로마 수평 오프셋 px
uniform float u_noise;
uniform float u_ghost;
uniform float u_ghostDist;  // px
uniform uint  u_seed;

// 열 우선(column-major) 이다. 각 열이 R, G, B 에 곱해지는 계수다.
const mat3 RGB2YIQ = mat3(
  0.299,  0.5959,  0.2115,
  0.587, -0.2746, -0.5227,
  0.114, -0.3213,  0.3112);

const mat3 YIQ2RGB = mat3(
  1.0,    1.0,    1.0,
  0.956, -0.272, -1.106,
  0.619, -0.647,  1.703);

vec4 tapStraight(vec2 uv) {
  if (uv.x < 0.0 || uv.x > 1.0) return vec4(0.0);
  return unpremul(texture(u_image, uv));
}

void main() {
  vec4 c = texture(u_image, v_uv);
  if (c.a <= 0.0) {
    fragColor = c;
    return;
  }

  vec4 s = unpremul(c);
  vec3 base = RGB2YIQ * s.rgb;
  float texel = 1.0 / u_resolution.x;

  // 크로마만 수평으로 뭉갠다. 13탭 삼각 가중.
  vec2 chroma = vec2(0.0);
  float wsum = 0.0;
  for (int i = -6; i <= 6; i++) {
    float fi = float(i) / 6.0;
    vec4 t = tapStraight(v_uv + vec2((fi * u_blur + u_offset) * texel, 0.0));
    // 알파 가중. 투명 영역이 색을 끌어오면 실루엣 안쪽에 검은 테가 생긴다.
    float w = (1.0 - abs(fi) * 0.6) * t.a;
    chroma += (RGB2YIQ * t.rgb).yz * w;
    wsum += w;
  }
  chroma = (wsum > 0.0) ? (chroma / wsum) : base.yz;

  // 크로마 노이즈는 가로로 길게 번진다. 8px 묶음 x 스캔라인 단위로 시드를 잡는다.
  uvec2 p = uvec2(v_uv * u_resolution);
  vec2 n = hash22(uvec2(p.y ^ ((p.x / 8u) * 65539u), u_seed)) - 0.5;
  chroma += n * u_noise * 0.5;

  // 고스팅은 왼쪽에서 지연되어 따라오는 휘도 잔상이다.
  float ghostY = 0.0;
  if (u_ghost > 0.0) {
    vec4 g = tapStraight(v_uv - vec2(u_ghostDist * texel, 0.0));
    ghostY = (RGB2YIQ * g.rgb).x * g.a * u_ghost;
  }

  vec3 rgb = YIQ2RGB * vec3(clamp(base.x + ghostY, 0.0, 1.0), chroma);
  fragColor = premul(vec4(clamp(rgb, 0.0, 1.0), c.a));
}
`)

const chroma: EffectDef = {
  id: 'glitch.chroma',
  label: '색 번짐',
  hint: '휘도는 두고 색만 옆으로 뭉갠다. 테이프에 복사한 화면의 색감이 된다.',
  stage: 'B',
  cost: 'mid',
  preservesAlpha: true,
  params: [
    { key: 'blur', label: '색 번짐', type: 'number', min: 0, max: 40, step: 0.5, unit: 'px', default: 8 },
    { key: 'offset', label: '색 어긋남', type: 'number', min: -20, max: 20, step: 0.5, unit: 'px', default: 2 },
    { key: 'noise', label: '색 노이즈', type: 'number', min: 0, max: 1, step: 0.01, default: 0.2 },
    { key: 'ghost', label: '고스팅', type: 'number', min: 0, max: 1, step: 0.01, default: 0.25 },
    { key: 'ghostDist', label: '고스팅 거리', type: 'number', min: 0, max: 40, step: 0.5, unit: 'px', default: 8 },
  ],
  fragment: CHROMA_FS,
  uniforms: [
    { name: 'u_resolution', type: 'vec2', value: (c) => [c.width, c.height] },
    { name: 'u_blur', type: 'float', value: (c) => pv(c, 'blur', 8) },
    { name: 'u_offset', type: 'float', value: (c) => pv(c, 'offset', 2) },
    { name: 'u_noise', type: 'float', value: (c) => pv(c, 'noise', 0.2) },
    { name: 'u_ghost', type: 'float', value: (c) => pv(c, 'ghost', 0.25) },
    { name: 'u_ghostDist', type: 'float', value: (c) => pv(c, 'ghostDist', 8) },
    { name: 'u_seed', type: 'uint', value: (c) => c.seed >>> 0 },
  ],
}

// ---------------------------------------------------------------------------

/** B 스테이지 원자 이펙트. 각자 독립 패스다. */
export const DESTROY_EFFECTS: EffectDef[] = [rgbShift, slice, block, band, pixelSort, chroma]
