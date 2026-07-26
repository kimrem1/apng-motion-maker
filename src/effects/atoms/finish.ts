/**
 * C 스테이지(마감) 원자 이펙트.
 *
 * C 는 픽셀 로컬이라 조각만 제공하고 엔진이 하나의 프로그램으로 융합한다.
 * 각 조각의 진입점은 다음 한 가지 형태뿐이다.
 *
 *   vec4 grade_<token>(vec4 c, vec2 uv)
 *
 * c 는 premultiplied 다. 색을 만질 때는 unpremul 하고 끝에 다시 premul 한다.
 *
 * ── 퓨전 계약 ───────────────────────────────────────────────────────────────
 * 융합 프로그램의 머리에 엔진이 다음을 한 번씩 깔아둔다. 조각은 다시 선언하지 않는다.
 *
 *   #version 300 es
 *   precision highp float;
 *   precision highp int;        // 빠지면 PCG 해시가 32비트로 돌지 않는다
 *   <COMMON_GLSL>               // pcg2d/pcg3d/hash11/hash21/hash22/unpremul/premul
 *   uniform sampler2D u_image;
 *   uniform vec2 u_resolution;  // 출력 픽셀 크기
 *   in vec2 v_uv;
 *   out vec4 fragColor;
 *
 * 그리고 main 은 이렇게 만든다.
 *
 *   vec4 c = texture(u_image, v_uv);
 *   c = grade_fx_grade(c, v_uv);
 *   c = grade_fx_scanline(c, v_uv);
 *   ...
 *   fragColor = c;
 *
 * 조각이 선언하는 **모든 식별자(유니폼/헬퍼/진입점)에는 자기 토큰이 들어 있다**.
 * 예: fx.scanline -> 토큰 fx_scanline -> u_fx_scanline_opacity, grade_fx_scanline.
 * 같은 이펙트를 한 레이어에 두 번 쌓으면 퓨전기가 소스와 uniforms[].name 양쪽에서
 * `fx_scanline` 을 `fx_scanline_2` 로 문자열 치환하는 것만으로 충돌이 사라진다.
 *
 * fusable: false 인 조각은 이웃 픽셀을 읽으므로 단독 패스로 돌려야 한다. 이때
 * u_image 가 곧 그 패스의 입력이라 c 와 의미가 일치한다. 다른 조각과 묶으면
 * 앞 조각의 결과가 아니라 스테이지 입력을 읽어 순서가 어긋난다.
 */

import type { EffectDef, EffectUniformContext } from '@/effects/types.ts'

// ---------------------------------------------------------------------------
// 로컬 헬퍼
// ---------------------------------------------------------------------------

function pv(ctx: EffectUniformContext, key: string, fallback: number): number {
  const v = ctx.params[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

/**
 * 색은 0xRRGGBB 정수로 저장한다.
 * EffectParam 이 number | Track 이라 문자열을 넣을 자리가 없다 (core/types.ts).
 * UI 는 type:'color' 를 보고 컬러 피커를 띄우고 정수로 되돌려 넣는다.
 */
function rgbOf(packed: number): [number, number, number] {
  const v = Math.max(0, Math.min(0xffffff, Math.round(packed))) | 0
  return [((v >> 16) & 0xff) / 255, ((v >> 8) & 0xff) / 255, (v & 0xff) / 255]
}

const DEG2RAD = Math.PI / 180

// ---------------------------------------------------------------------------
// 6. 스캔라인
// ---------------------------------------------------------------------------

const SCANLINE_CHUNK = /* glsl */ `
uniform float u_fx_scanline_height;
uniform float u_fx_scanline_opacity;
uniform float u_fx_scanline_softness;
uniform float u_fx_scanline_offset;   // 정수 px. 롤 + 인터레이스가 합쳐져 있다.

vec4 grade_fx_scanline(vec4 c, vec2 uv) {
  float period = max(1.0, u_fx_scanline_height);
  float y = uv.y * u_resolution.y + u_fx_scanline_offset;
  float w = 0.5 + 0.5 * cos(6.28318530718 * y / period);
  // softness 0 이면 칼같은 줄, 1 이면 코사인 그대로.
  float k = clamp(u_fx_scanline_softness, 0.0, 1.0) * 0.5 + 0.002;
  w = smoothstep(0.5 - k, 0.5 + k, w);
  // 스칼라 곱은 premultiplied 를 그대로 유지한다. 알파는 손대지 않는다.
  float f = mix(1.0, w, clamp(u_fx_scanline_opacity, 0.0, 1.0));
  return vec4(c.rgb * f, c.a);
}
`

/**
 * 롤과 인터레이스를 정수 px 오프셋 하나로 합친다.
 * 롤은 한 루프에서 정확히 (줄 간격 x 정수 사이클) px 이동해 이음새가 없다.
 * 인터레이스는 프레임 홀짝으로 반 칸 어긋내므로 프레임 수가 짝수여야 루프가 닫힌다.
 */
function scanlineOffset(c: EffectUniformContext): number {
  const h = Math.max(1, Math.round(pv(c, 'height', 3)))
  const dur = Math.max(1, c.durationFrames)
  const roll = Math.round((Math.round(pv(c, 'rollCycles', 0)) * h * c.effFrame) / dur)
  const interlace = pv(c, 'interlace', 0) >= 0.5 && c.effFrame % 2 !== 0 ? Math.round(h / 2) : 0
  return roll + interlace
}

const scanline: EffectDef = {
  id: 'fx.scanline',
  label: '스캔라인',
  hint: '가로줄을 겹쳐 브라운관 화면처럼 만든다.',
  stage: 'C',
  cost: 'free',
  preservesAlpha: true,
  fn: 'grade_fx_scanline',
  chunk: SCANLINE_CHUNK,
  params: [
    { key: 'height', label: '줄 간격', type: 'number', min: 1, max: 32, step: 1, unit: 'px', default: 3 },
    { key: 'opacity', label: '진하기', type: 'number', min: 0, max: 1, step: 0.01, default: 0.35 },
    { key: 'softness', label: '부드러움', type: 'number', min: 0, max: 1, step: 0.01, default: 0.25 },
    { key: 'rollCycles', label: '롤', type: 'number', min: -16, max: 16, step: 1, unit: '회/루프', default: 0 },
    {
      key: 'interlace',
      label: '인터레이스',
      type: 'select',
      options: [
        { value: 0, label: '끔' },
        { value: 1, label: '켬 (짝수 프레임 필요)' },
      ],
      default: 0,
    },
  ],
  uniforms: [
    { name: 'u_fx_scanline_height', type: 'float', value: (c) => Math.max(1, Math.round(pv(c, 'height', 3))) },
    { name: 'u_fx_scanline_opacity', type: 'float', value: (c) => pv(c, 'opacity', 0.35) },
    { name: 'u_fx_scanline_softness', type: 'float', value: (c) => pv(c, 'softness', 0.25) },
    { name: 'u_fx_scanline_offset', type: 'float', value: scanlineOffset },
  ],
}

// ---------------------------------------------------------------------------
// 7. 디지털 그레인
// ---------------------------------------------------------------------------

const GRAIN_CHUNK = /* glsl */ `
uniform float u_fx_grain_amount;
uniform float u_fx_grain_size;
uniform float u_fx_grain_midtone;
uniform int   u_fx_grain_mono;
uniform uint  u_fx_grain_seed;

vec3 fx_grain_rand3(uvec2 cell) {
  // 정수 비트 해시만 쓴다. fract(sin(x)) 는 기기마다 다른 값을 낸다.
  return vec3(pcg3d(uvec3(cell, u_fx_grain_seed))) * (1.0 / 4294967296.0);
}

vec4 grade_fx_grain(vec4 c, vec2 uv) {
  if (c.a <= 0.0) return c;

  float cell = max(1.0, u_fx_grain_size);
  vec3 r = fx_grain_rand3(uvec2(floor(uv * u_resolution / cell)));
  vec3 n = ((u_fx_grain_mono == 1) ? vec3(r.x) : r) * 2.0 - 1.0;

  vec4 s = unpremul(c);
  float L = dot(s.rgb, vec3(0.2126, 0.7152, 0.0722));
  // 중간톤 가중 4L(1-L). 완전한 검정과 흰색에는 그레인이 거의 얹히지 않는다.
  float w = mix(1.0, 4.0 * L * (1.0 - L), clamp(u_fx_grain_midtone, 0.0, 1.0));
  s.rgb = clamp(s.rgb + n * u_fx_grain_amount * w, 0.0, 1.0);
  return premul(vec4(s.rgb, c.a));
}
`

const grain: EffectDef = {
  id: 'fx.grain',
  label: '노이즈',
  hint: '입자를 얹는다. 프레임마다 새로 뽑혀 지글거린다.',
  stage: 'C',
  cost: 'free',
  preservesAlpha: true,
  fn: 'grade_fx_grain',
  chunk: GRAIN_CHUNK,
  params: [
    { key: 'amount', label: '강도', type: 'number', min: 0, max: 1, step: 0.01, default: 0.2 },
    { key: 'size', label: '입자 크기', type: 'number', min: 1, max: 8, step: 1, unit: 'px', default: 1 },
    {
      key: 'mono',
      label: '색',
      type: 'select',
      options: [
        { value: 1, label: '흑백 입자' },
        { value: 0, label: '컬러 입자' },
      ],
      default: 1,
    },
    { key: 'midtone', label: '중간톤 가중', type: 'number', min: 0, max: 1, step: 0.01, default: 1 },
  ],
  uniforms: [
    { name: 'u_fx_grain_amount', type: 'float', value: (c) => pv(c, 'amount', 0.2) },
    { name: 'u_fx_grain_size', type: 'float', value: (c) => Math.max(1, Math.round(pv(c, 'size', 1))) },
    { name: 'u_fx_grain_midtone', type: 'float', value: (c) => pv(c, 'midtone', 1) },
    { name: 'u_fx_grain_mono', type: 'int', value: (c) => Math.round(pv(c, 'mono', 1)) },
    { name: 'u_fx_grain_seed', type: 'uint', value: (c) => c.seed >>> 0 },
  ],
}

// ---------------------------------------------------------------------------
// 8. 하프톤
// ---------------------------------------------------------------------------

const HALFTONE_CHUNK = /* glsl */ `
uniform float u_fx_halftone_cell;
uniform float u_fx_halftone_angle;   // rad
uniform int   u_fx_halftone_shape;   // 0 원 1 사각 2 선 3 마름모
uniform float u_fx_halftone_alpha;   // 0 알파 유지 / 1 알파도 점으로 깎기
uniform float u_fx_halftone_mix;
uniform vec3  u_fx_halftone_paper;

vec4 grade_fx_halftone(vec4 c, vec2 uv) {
  // 셀 크기는 출력 픽셀 기준으로 고정한다. 캔버스를 키워도 점이 커지지 않는다.
  float cell = max(2.0, u_fx_halftone_cell);
  vec2 p = uv * u_resolution;
  float ca = cos(u_fx_halftone_angle);
  float sa = sin(u_fx_halftone_angle);
  vec2 q = vec2(p.x * ca - p.y * sa, p.x * sa + p.y * ca) / cell;
  vec2 f = fract(q) - 0.5;

  vec4 s = unpremul(c);
  float L = dot(s.rgb, vec3(0.2126, 0.7152, 0.0722));
  float cover = clamp(1.0 - L, 0.0, 1.0);

  float d;
  float r;
  if (u_fx_halftone_shape == 1) {
    d = max(abs(f.x), abs(f.y));
    r = cover * 0.5;
  } else if (u_fx_halftone_shape == 2) {
    d = abs(f.y);
    r = cover * 0.5;
  } else if (u_fx_halftone_shape == 3) {
    d = abs(f.x) + abs(f.y);
    r = cover * 0.75;
  } else {
    d = length(f);
    // 원 면적이 커버율에 비례하도록. sqrt(A/pi) = sqrt(A) * 0.5642
    r = sqrt(cover) * 0.5642;
  }

  float aa = 0.7 / cell;
  float m = 1.0 - smoothstep(r - aa, r + aa, d);

  float aOut = mix(c.a, c.a * m, clamp(u_fx_halftone_alpha, 0.0, 1.0));
  vec3 rgbOut = mix(u_fx_halftone_paper, s.rgb, m);
  return mix(c, premul(vec4(rgbOut, aOut)), clamp(u_fx_halftone_mix, 0.0, 1.0));
}
`

const halftone: EffectDef = {
  id: 'fx.halftone',
  label: '하프톤',
  hint: '인쇄 망점으로 바꾼다. 점 사이가 뚫리므로 투명 배경에서는 실루엣이 성글어진다.',
  stage: 'C',
  cost: 'low',
  // 점 사이를 뚫으므로 실루엣이 바뀐다. UI 가 경고 배지를 단다 (14.A1).
  preservesAlpha: false,
  fn: 'grade_fx_halftone',
  chunk: HALFTONE_CHUNK,
  params: [
    { key: 'cell', label: '셀 크기', type: 'number', min: 2, max: 64, step: 1, unit: 'px', default: 6 },
    { key: 'angle', label: '각도', type: 'number', min: 0, max: 180, step: 1, unit: '°', default: 15 },
    {
      key: 'shape',
      label: '모양',
      type: 'select',
      options: [
        { value: 0, label: '원' },
        { value: 1, label: '사각' },
        { value: 2, label: '선' },
        { value: 3, label: '마름모' },
      ],
      default: 0,
    },
    { key: 'paper', label: '바탕색', type: 'color', default: 0xffffff },
    { key: 'alphaDots', label: '알파도 점으로', type: 'number', min: 0, max: 1, step: 0.01, default: 1 },
    { key: 'mix', label: '적용량', type: 'number', min: 0, max: 1, step: 0.01, default: 1 },
  ],
  uniforms: [
    { name: 'u_fx_halftone_cell', type: 'float', value: (c) => pv(c, 'cell', 6) },
    { name: 'u_fx_halftone_angle', type: 'float', value: (c) => pv(c, 'angle', 15) * DEG2RAD },
    { name: 'u_fx_halftone_shape', type: 'int', value: (c) => Math.round(pv(c, 'shape', 0)) },
    { name: 'u_fx_halftone_alpha', type: 'float', value: (c) => pv(c, 'alphaDots', 1) },
    { name: 'u_fx_halftone_mix', type: 'float', value: (c) => pv(c, 'mix', 1) },
    { name: 'u_fx_halftone_paper', type: 'vec3', value: (c) => rgbOf(pv(c, 'paper', 0xffffff)) },
  ],
}

// ---------------------------------------------------------------------------
// 9. 포스터라이즈 + 디더
// ---------------------------------------------------------------------------

/**
 * GIF WYSIWYG 의 핵심이다.
 *
 * GIF 는 256색 팔레트에 1비트 알파다. 내보내기 단계에서만 양자화하면 프리뷰와
 * 결과가 다르게 보인다. 여기서 미리 계단을 만들고 알파를 잘라두면 사용자가
 * 화면에서 본 그대로가 파일로 나간다.
 *
 * Bayer 는 비트 인터리브로 만든다. 4x4 와 8x8 이 같은 코드에서 나온다.
 */
const POSTERIZE_CHUNK = /* glsl */ `
uniform float u_fx_posterize_levels;
uniform int   u_fx_posterize_dither;    // 0 없음 1 Bayer 4x4 2 Bayer 8x8
uniform float u_fx_posterize_alphaCut;
uniform float u_fx_posterize_mix;

float fx_posterize_bayer(uvec2 p, uint n) {
  uint v = 0u;
  for (uint i = 0u; i < 3u; i++) {
    if (i >= n) break;
    uint bx = (p.x >> i) & 1u;
    uint by = (p.y >> i) & 1u;
    uint sh = 2u * (n - 1u - i);
    v |= ((bx ^ by) << (sh + 1u)) | (by << sh);
  }
  return float(v) / float(1u << (2u * n));
}

vec4 grade_fx_posterize(vec4 c, vec2 uv) {
  float d = 0.0;
  if (u_fx_posterize_dither != 0) {
    uint n = (u_fx_posterize_dither == 2) ? 3u : 2u;
    d = fx_posterize_bayer(uvec2(uv * u_resolution), n) - 0.5;
  }

  float steps = max(1.0, floor(u_fx_posterize_levels) - 1.0);
  vec4 s = unpremul(c);
  vec3 q = clamp(floor(s.rgb * steps + 0.5 + d) / steps, 0.0, 1.0);

  float a = c.a;
  // GIF 는 1비트 알파다. 미리 자르면 내보내기에서 실루엣이 변하지 않는다.
  if (u_fx_posterize_alphaCut > 0.0) a = step(u_fx_posterize_alphaCut, c.a);

  return mix(c, premul(vec4(q, a)), clamp(u_fx_posterize_mix, 0.0, 1.0));
}
`

const posterize: EffectDef = {
  id: 'fx.posterize',
  label: '색 줄이기',
  hint: '색 단계를 줄이고 디더를 얹는다. GIF 로 내보낼 때 화면과 결과를 맞춰준다.',
  stage: 'C',
  cost: 'free',
  preservesAlpha: true,
  fn: 'grade_fx_posterize',
  chunk: POSTERIZE_CHUNK,
  params: [
    { key: 'levels', label: '색 단계', type: 'number', min: 2, max: 32, step: 1, default: 6 },
    {
      key: 'dither',
      label: '디더',
      type: 'select',
      options: [
        { value: 0, label: '없음' },
        { value: 1, label: '거친 격자 (4x4)' },
        { value: 2, label: '고운 격자 (8x8)' },
      ],
      default: 1,
    },
    { key: 'alphaCut', label: '투명 자르기', type: 'number', min: 0, max: 1, step: 0.01, default: 0 },
    { key: 'mix', label: '적용량', type: 'number', min: 0, max: 1, step: 0.01, default: 1 },
  ],
  uniforms: [
    { name: 'u_fx_posterize_levels', type: 'float', value: (c) => Math.max(2, Math.round(pv(c, 'levels', 6))) },
    { name: 'u_fx_posterize_dither', type: 'int', value: (c) => Math.round(pv(c, 'dither', 1)) },
    { name: 'u_fx_posterize_alphaCut', type: 'float', value: (c) => pv(c, 'alphaCut', 0) },
    { name: 'u_fx_posterize_mix', type: 'float', value: (c) => pv(c, 'mix', 1) },
  ],
}

// ---------------------------------------------------------------------------
// 10. 비네트
// ---------------------------------------------------------------------------

const VIGNETTE_CHUNK = /* glsl */ `
uniform float u_fx_vignette_inner;
uniform float u_fx_vignette_outer;
uniform float u_fx_vignette_round;
uniform float u_fx_vignette_feather;
uniform float u_fx_vignette_opacity;
uniform vec3  u_fx_vignette_color;

vec4 grade_fx_vignette(vec4 c, vec2 uv) {
  if (c.a <= 0.0) return c;

  vec2 d = (uv - 0.5) * 2.0;
  // 라운드니스 1 = 원(L2), 0 = 사각(L-inf).
  float r = mix(max(abs(d.x), abs(d.y)), length(d), clamp(u_fx_vignette_round, 0.0, 1.0));

  float lo = u_fx_vignette_inner;
  float hi = max(lo + 0.001, u_fx_vignette_outer);
  float m = smoothstep(lo, hi, r);
  m = pow(m, mix(3.0, 0.4, clamp(u_fx_vignette_feather, 0.0, 1.0)));

  vec4 s = unpremul(c);
  s.rgb = mix(s.rgb, u_fx_vignette_color, m * clamp(u_fx_vignette_opacity, 0.0, 1.0));
  return premul(vec4(s.rgb, c.a));
}
`

const vignette: EffectDef = {
  id: 'fx.vignette',
  label: '비네트',
  hint: '가장자리를 어둡게 한다. 투명 배경에서는 그림이 있는 자리에만 보인다.',
  stage: 'C',
  cost: 'free',
  preservesAlpha: true,
  fn: 'grade_fx_vignette',
  chunk: VIGNETTE_CHUNK,
  params: [
    { key: 'inner', label: '안쪽 반경', type: 'number', min: 0, max: 1.5, step: 0.01, default: 0.55 },
    { key: 'outer', label: '바깥 반경', type: 'number', min: 0, max: 2, step: 0.01, default: 1.05 },
    { key: 'roundness', label: '둥글기', type: 'number', min: 0, max: 1, step: 0.01, default: 1 },
    { key: 'feather', label: '페더', type: 'number', min: 0, max: 1, step: 0.01, default: 0.5 },
    { key: 'color', label: '색', type: 'color', default: 0x000000 },
    { key: 'opacity', label: '진하기', type: 'number', min: 0, max: 1, step: 0.01, default: 0.6 },
  ],
  uniforms: [
    { name: 'u_fx_vignette_inner', type: 'float', value: (c) => pv(c, 'inner', 0.55) },
    { name: 'u_fx_vignette_outer', type: 'float', value: (c) => pv(c, 'outer', 1.05) },
    { name: 'u_fx_vignette_round', type: 'float', value: (c) => pv(c, 'roundness', 1) },
    { name: 'u_fx_vignette_feather', type: 'float', value: (c) => pv(c, 'feather', 0.5) },
    { name: 'u_fx_vignette_opacity', type: 'float', value: (c) => pv(c, 'opacity', 0.6) },
    { name: 'u_fx_vignette_color', type: 'vec3', value: (c) => rgbOf(pv(c, 'color', 0x000000)) },
  ],
}

// ---------------------------------------------------------------------------
// 11. 컬러 그레이딩
// ---------------------------------------------------------------------------

const GRADE_CHUNK = /* glsl */ `
uniform float u_fx_grade_exposure;
uniform float u_fx_grade_contrast;
uniform float u_fx_grade_saturation;
uniform float u_fx_grade_temperature;
uniform float u_fx_grade_tint;
uniform int   u_fx_grade_linear;

vec4 grade_fx_grade(vec4 c, vec2 uv) {
  if (c.a <= 0.0) return c;

  vec4 s = unpremul(c);
  vec3 v = clamp(s.rgb, 0.0, 1.0);
  bool lin = (u_fx_grade_linear == 1);
  // 선형광에서 노출과 대비를 다뤄야 밝은 쪽이 물 빠지지 않는다. sRGB 는 2.2 근사.
  if (lin) v = pow(v, vec3(2.2));

  v *= exp2(u_fx_grade_exposure);
  // 색온도/틴트는 채널 게인 근사다. 정확한 백색점 변환은 v2 로 미룬다.
  v *= vec3(1.0 + u_fx_grade_temperature * 0.35,
            1.0 + u_fx_grade_tint * 0.25,
            1.0 - u_fx_grade_temperature * 0.35);

  float pivot = lin ? 0.18 : 0.5;
  v = (v - pivot) * max(0.0, u_fx_grade_contrast) + pivot;

  float L = dot(max(v, 0.0), vec3(0.2126, 0.7152, 0.0722));
  v = mix(vec3(L), v, max(0.0, u_fx_grade_saturation));

  if (lin) v = pow(max(v, 0.0), vec3(1.0 / 2.2));
  return premul(vec4(clamp(v, 0.0, 1.0), c.a));
}
`

const grade: EffectDef = {
  id: 'fx.grade',
  label: '색 보정',
  hint: '노출, 대비, 채도, 색온도를 조정한다.',
  stage: 'C',
  cost: 'free',
  preservesAlpha: true,
  fn: 'grade_fx_grade',
  chunk: GRADE_CHUNK,
  params: [
    { key: 'exposure', label: '노출', type: 'number', min: -3, max: 3, step: 0.05, unit: 'EV', default: 0 },
    { key: 'contrast', label: '대비', type: 'number', min: 0, max: 2, step: 0.01, default: 1 },
    { key: 'saturation', label: '채도', type: 'number', min: 0, max: 2, step: 0.01, default: 1 },
    { key: 'temperature', label: '색온도', type: 'number', min: -1, max: 1, step: 0.01, default: 0 },
    { key: 'tint', label: '틴트', type: 'number', min: -1, max: 1, step: 0.01, default: 0 },
    {
      key: 'linear',
      label: '계산 공간',
      type: 'select',
      options: [
        { value: 1, label: '선형광 (권장)' },
        { value: 0, label: '감마 공간' },
      ],
      default: 1,
    },
  ],
  uniforms: [
    { name: 'u_fx_grade_exposure', type: 'float', value: (c) => pv(c, 'exposure', 0) },
    { name: 'u_fx_grade_contrast', type: 'float', value: (c) => pv(c, 'contrast', 1) },
    { name: 'u_fx_grade_saturation', type: 'float', value: (c) => pv(c, 'saturation', 1) },
    { name: 'u_fx_grade_temperature', type: 'float', value: (c) => pv(c, 'temperature', 0) },
    { name: 'u_fx_grade_tint', type: 'float', value: (c) => pv(c, 'tint', 0) },
    { name: 'u_fx_grade_linear', type: 'int', value: (c) => Math.round(pv(c, 'linear', 1)) },
  ],
}

// ---------------------------------------------------------------------------
// 12. 방향성 블러
// ---------------------------------------------------------------------------

/**
 * 이웃을 읽으므로 fusable: false 다. 단독 패스에서만 u_image 가 이 조각의 입력과
 * 같아진다. 다른 조각과 묶으면 앞 조각의 결과 대신 스테이지 입력을 읽어버린다.
 *
 * premultiplied 색은 선형이라 그냥 평균 내면 된다. straight 로 되돌려 평균 내면
 * 반투명 가장자리에서 색이 어긋난다.
 */
const DIR_BLUR_CHUNK = /* glsl */ `
uniform float u_fx_dirBlur_angle;    // rad
uniform float u_fx_dirBlur_length;   // px
uniform int   u_fx_dirBlur_taps;
uniform float u_fx_dirBlur_mix;

vec4 fx_dirBlur_tap(vec2 uv) {
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return vec4(0.0);
  return texture(u_image, uv);
}

vec4 grade_fx_dirBlur(vec4 c, vec2 uv) {
  int taps = clamp(u_fx_dirBlur_taps, 1, 32);
  if (taps < 2 || u_fx_dirBlur_length <= 0.0) return c;

  vec2 dir = vec2(cos(u_fx_dirBlur_angle), sin(u_fx_dirBlur_angle))
           * u_fx_dirBlur_length / u_resolution;

  vec4 acc = vec4(0.0);
  for (int i = 0; i < 32; i++) {
    if (i >= taps) break;
    float t = float(i) / float(taps - 1) - 0.5;
    acc += fx_dirBlur_tap(uv + dir * t);
  }
  acc /= float(taps);
  return mix(c, acc, clamp(u_fx_dirBlur_mix, 0.0, 1.0));
}
`

const dirBlur: EffectDef = {
  id: 'fx.dirBlur',
  label: '방향성 블러',
  hint: '한 방향으로 늘려 번지게 한다. 속도감이나 흐릿한 잔상에 쓴다.',
  stage: 'C',
  cost: 'low',
  preservesAlpha: true,
  // 이웃 픽셀을 읽는다. 융합하면 조각 순서가 어긋난다.
  fusable: false,
  fn: 'grade_fx_dirBlur',
  chunk: DIR_BLUR_CHUNK,
  params: [
    { key: 'angle', label: '각도', type: 'number', min: 0, max: 360, step: 1, unit: '°', default: 0 },
    { key: 'length', label: '길이', type: 'number', min: 0, max: 100, step: 0.5, unit: 'px', default: 12 },
    { key: 'taps', label: '샘플 수', type: 'number', min: 8, max: 32, step: 1, default: 16 },
    { key: 'mix', label: '적용량', type: 'number', min: 0, max: 1, step: 0.01, default: 1 },
  ],
  uniforms: [
    { name: 'u_fx_dirBlur_angle', type: 'float', value: (c) => pv(c, 'angle', 0) * DEG2RAD },
    { name: 'u_fx_dirBlur_length', type: 'float', value: (c) => pv(c, 'length', 12) },
    {
      name: 'u_fx_dirBlur_taps',
      type: 'int',
      value: (c) => Math.min(32, Math.max(2, Math.round(pv(c, 'taps', 16)))),
    },
    { name: 'u_fx_dirBlur_mix', type: 'float', value: (c) => pv(c, 'mix', 1) },
  ],
}

// ---------------------------------------------------------------------------
// 13. 종이 텍스처
// ---------------------------------------------------------------------------

const PAPER_CHUNK = /* glsl */ `
uniform float u_fx_paper_amount;
uniform float u_fx_paper_scale;
uniform int   u_fx_paper_blend;   // 0 곱하기 1 오버레이 2 소프트라이트
uniform vec2  u_fx_paper_shift;   // 지터 오프셋 (px)

float fx_paper_h(vec2 cell) {
  // 음수 좌표를 피하려고 크게 민다. 해시는 정수 비트 연산이라 결정론적이다.
  uvec2 k = uvec2(ivec2(cell) + 4096);
  return hash21(uvec2(k.x ^ (k.y << 16u), 0x50a17u));
}

float fx_paper_noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = fx_paper_h(i);
  float b = fx_paper_h(i + vec2(1.0, 0.0));
  float c = fx_paper_h(i + vec2(0.0, 1.0));
  float d = fx_paper_h(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

vec4 grade_fx_paper(vec4 c, vec2 uv) {
  if (c.a <= 0.0) return c;

  vec2 p = (uv * u_resolution + u_fx_paper_shift) / max(1.0, u_fx_paper_scale);
  float n = fx_paper_noise(p) * 0.65 + fx_paper_noise(p * 2.7 + 11.3) * 0.35;
  // 한 축으로 늘린 성분을 섞어 종이 섬유 방향을 만든다.
  n = mix(n, fx_paper_noise(vec2(p.x * 0.35, p.y * 3.1)), 0.3);

  vec4 s = unpremul(c);
  vec3 v = s.rgb;
  float k = clamp(u_fx_paper_amount, 0.0, 1.0);

  if (u_fx_paper_blend == 1) {
    vec3 t = mix(2.0 * v * n, 1.0 - 2.0 * (1.0 - v) * (1.0 - n), step(vec3(0.5), v));
    v = mix(v, t, k);
  } else if (u_fx_paper_blend == 2) {
    vec3 dd = mix(((16.0 * v - 12.0) * v + 4.0) * v, sqrt(max(v, 0.0)), step(vec3(0.25), v));
    vec3 t = mix(v - (1.0 - 2.0 * n) * v * (1.0 - v),
                 v + (2.0 * n - 1.0) * (dd - v),
                 step(0.5, n));
    v = mix(v, t, k);
  } else {
    v = v * mix(1.0, n * 0.6 + 0.7, k);
  }

  return premul(vec4(clamp(v, 0.0, 1.0), c.a));
}
`

const paper: EffectDef = {
  id: 'fx.paper',
  label: '종이 질감',
  hint: '종이 결을 얹는다. 지터를 0 으로 두면 결이 고정되어 재생 중에 기어다니지 않는다.',
  stage: 'C',
  cost: 'free',
  preservesAlpha: true,
  fn: 'grade_fx_paper',
  chunk: PAPER_CHUNK,
  params: [
    { key: 'amount', label: '강도', type: 'number', min: 0, max: 1, step: 0.01, default: 0.35 },
    { key: 'scale', label: '결 크기', type: 'number', min: 1, max: 16, step: 1, unit: 'px', default: 3 },
    {
      key: 'blend',
      label: '합성',
      type: 'select',
      options: [
        { value: 0, label: '곱하기' },
        { value: 1, label: '오버레이' },
        { value: 2, label: '소프트라이트' },
      ],
      default: 0,
    },
    { key: 'jitter', label: '지터', type: 'number', min: 0, max: 1, step: 0.01, default: 0 },
  ],
  uniforms: [
    { name: 'u_fx_paper_amount', type: 'float', value: (c) => pv(c, 'amount', 0.35) },
    { name: 'u_fx_paper_scale', type: 'float', value: (c) => Math.max(1, Math.round(pv(c, 'scale', 3))) },
    { name: 'u_fx_paper_blend', type: 'int', value: (c) => Math.round(pv(c, 'blend', 0)) },
    {
      name: 'u_fx_paper_shift',
      type: 'vec2',
      // 엔진이 준 정수 시드에서 뽑는다. Math.random 은 렌더 경로에서 금지다.
      value: (c) => {
        const j = pv(c, 'jitter', 0)
        if (j <= 0) return [0, 0]
        const s = c.seed >>> 0
        const rx = ((s & 0xffff) / 65536) * 2 - 1
        const ry = (((s >>> 16) & 0xffff) / 65536) * 2 - 1
        return [rx * j * 8, ry * j * 8]
      },
    },
  ],
}

// ---------------------------------------------------------------------------
// 14. 어퍼처 마스크 (CRT 매크로의 원자)
// ---------------------------------------------------------------------------

/**
 * RGB 스트라이프 마스크 + 인광체 글로우 근사.
 *
 * CRT 를 하나의 모놀리식 셰이더로 만들면 "마스크만 원한다" 를 못 맞춘다.
 * 그래서 마스크를 독립 원자로 둔다. 배럴 왜곡은 A 스테이지, 스캔라인/모서리는
 * 각각 fx.scanline / fx.vignette 가 맡는다.
 */
const APERTURE_CHUNK = /* glsl */ `
uniform float u_fx_aperture_pitch;
uniform float u_fx_aperture_strength;
uniform float u_fx_aperture_glow;
uniform int   u_fx_aperture_mode;   // 0 어퍼처 그릴 1 섀도 마스크

float fx_aperture_band(float phase, float center) {
  float d = abs(phase - center);
  d = min(d, 3.0 - d);          // 3칸 주기라 양 끝이 이어져야 한다
  return 1.0 - min(d, 1.0);
}

vec4 grade_fx_aperture(vec4 c, vec2 uv) {
  if (c.a <= 0.0) return c;

  float pitch = max(1.0, u_fx_aperture_pitch);
  vec2 p = uv * u_resolution;
  float col = p.x;
  // 섀도 마스크는 줄마다 반 칸씩 어긋난다.
  if (u_fx_aperture_mode == 1) col += mod(floor(p.y / pitch), 2.0) * pitch * 1.5;

  float phase = fract(col / (pitch * 3.0)) * 3.0;
  vec3 mask = vec3(fx_aperture_band(phase, 0.5),
                   fx_aperture_band(phase, 1.5),
                   fx_aperture_band(phase, 2.5));
  // 1.35 는 마스크가 먹는 평균 밝기를 되돌리는 보정이다.
  mask = mix(vec3(1.0), mask * 1.35, clamp(u_fx_aperture_strength, 0.0, 1.0));

  vec4 s = unpremul(c);
  vec3 v = s.rgb * mask;
  // 인광체 글로우 근사. 하이라이트만 부풀린다.
  v += s.rgb * s.rgb * clamp(u_fx_aperture_glow, 0.0, 1.0);
  return premul(vec4(clamp(v, 0.0, 1.0), c.a));
}
`

const aperture: EffectDef = {
  id: 'fx.aperture',
  label: '픽셀 마스크',
  hint: '적녹청 스트라이프를 깔아 브라운관 인광체를 흉내낸다.',
  stage: 'C',
  cost: 'free',
  preservesAlpha: true,
  fn: 'grade_fx_aperture',
  chunk: APERTURE_CHUNK,
  params: [
    { key: 'pitch', label: '피치', type: 'number', min: 1, max: 8, step: 1, unit: 'px', default: 3 },
    { key: 'strength', label: '강도', type: 'number', min: 0, max: 1, step: 0.01, default: 0.5 },
    { key: 'glow', label: '글로우', type: 'number', min: 0, max: 1, step: 0.01, default: 0.3 },
    {
      key: 'mode',
      label: '패턴',
      type: 'select',
      options: [
        { value: 0, label: '세로 줄무늬' },
        { value: 1, label: '엇갈린 격자' },
      ],
      default: 0,
    },
  ],
  uniforms: [
    { name: 'u_fx_aperture_pitch', type: 'float', value: (c) => Math.max(1, Math.round(pv(c, 'pitch', 3))) },
    { name: 'u_fx_aperture_strength', type: 'float', value: (c) => pv(c, 'strength', 0.5) },
    { name: 'u_fx_aperture_glow', type: 'float', value: (c) => pv(c, 'glow', 0.3) },
    { name: 'u_fx_aperture_mode', type: 'int', value: (c) => Math.round(pv(c, 'mode', 0)) },
  ],
}

// ---------------------------------------------------------------------------

/** C 스테이지 원자 이펙트. fusable !== false 인 것끼리 한 프로그램으로 융합된다. */
export const FINISH_EFFECTS: EffectDef[] = [
  grade,
  dirBlur,
  halftone,
  posterize,
  aperture,
  scanline,
  grain,
  paper,
  vignette,
]
