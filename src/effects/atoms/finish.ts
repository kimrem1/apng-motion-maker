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
// ---------------------------------------------------------------------------
// 15. 부드러운 흐림
// ---------------------------------------------------------------------------

/**
 * 원판 흐림. 방향성 블러와 달리 사방으로 고르게 번진다.
 *
 * ---------------------------------------------------------------------------
 * 왜 황금각 나선인가
 * ---------------------------------------------------------------------------
 * 표본을 격자로 뽑으면 반경이 커질 때 격자 무늬가 그대로 보인다. 무작위로 뽑으면
 * 프레임마다 얼룩이 달라져 지글거린다. 황금각(137.5도) 나선은 **고정된 배치인데도
 * 방향이 반복되지 않아서**, 적은 표본으로도 무늬가 안 보이고 프레임 간에 완전히
 * 정지해 있다. 반경에 sqrt 를 씌우는 것은 원판 위에 고르게 퍼뜨리기 위해서다.
 *
 * 진짜 가우시안은 가로/세로 두 패스로 나눠야 하고 그러려면 패스 그래프가 조각
 * 하나에 두 번 그릴 수 있어야 한다. 지금 구조로는 단일 패스라, 표본 수를 늘려
 * 품질을 사는 쪽을 택했다. 흐림 반경이 크면 표본을 올려야 한다.
 */
const BLUR_CHUNK = /* glsl */ `
uniform float u_fx_blur_radius;   // px
uniform int   u_fx_blur_taps;
uniform float u_fx_blur_mix;

vec4 fx_blur_tap(vec2 uv) {
  // 밖을 읽으면 투명이다. 가장자리에서 그림이 늘어붙는 것보다 옅어지는 편이 낫다.
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return vec4(0.0);
  return texture(u_image, uv);
}

vec4 grade_fx_blur(vec4 c, vec2 uv) {
  int taps = clamp(u_fx_blur_taps, 1, 48);
  if (taps < 2 || u_fx_blur_radius <= 0.0) return c;

  // premultiplied 색은 선형이라 그냥 평균 내면 된다. straight 로 되돌려 평균 내면
  // 반투명 가장자리에서 색이 어긋난다.
  vec4 acc = c;
  float count = 1.0;
  const float GOLDEN = 2.39996323;

  for (int i = 1; i < 48; i++) {
    if (i >= taps) break;
    float fi = float(i);
    float r = sqrt(fi / float(taps - 1)) * u_fx_blur_radius;
    float a = fi * GOLDEN;
    acc += fx_blur_tap(uv + vec2(cos(a), sin(a)) * r / u_resolution);
    count += 1.0;
  }
  acc /= count;
  return mix(c, acc, clamp(u_fx_blur_mix, 0.0, 1.0));
}
`

const blur: EffectDef = {
  id: 'fx.blur',
  label: '부드러운 흐림',
  hint: '사방으로 고르게 번지게 한다. 반경을 크게 하면 표본 수도 올려야 깔끔하다.',
  stage: 'C',
  cost: 'low',
  preservesAlpha: true,
  // 이웃 픽셀을 읽는다. 융합하면 조각 순서가 어긋난다 (파일 머리주석).
  fusable: false,
  fn: 'grade_fx_blur',
  chunk: BLUR_CHUNK,
  params: [
    { key: 'radius', label: '반경', type: 'number', min: 0, max: 80, step: 0.5, unit: 'px', default: 8 },
    { key: 'taps', label: '표본 수', type: 'number', min: 8, max: 48, step: 1, default: 24 },
    { key: 'mix', label: '적용량', type: 'number', min: 0, max: 1, step: 0.01, default: 1 },
  ],
  uniforms: [
    { name: 'u_fx_blur_radius', type: 'float', value: (c) => pv(c, 'radius', 8) },
    {
      name: 'u_fx_blur_taps',
      type: 'int',
      value: (c) => Math.min(48, Math.max(2, Math.round(pv(c, 'taps', 24)))),
    },
    { name: 'u_fx_blur_mix', type: 'float', value: (c) => pv(c, 'mix', 1) },
  ],
}

// ---------------------------------------------------------------------------
// 16. 렌즈 색수차
// ---------------------------------------------------------------------------

/**
 * 렌즈가 파장마다 다르게 굴절하는 것을 흉내낸다.
 *
 * 'RGB 분리'(glitch.rgbShift)와 다르다. 저쪽은 화면 전체를 **같은 방향으로** 민
 * 고장난 신호이고, 이쪽은 **중심에서 멀수록 세지는** 광학 현상이다. 가운데는
 * 또렷하고 네 귀퉁이만 색이 갈라지는 그림이 사진처럼 보이는 이유가 그것이다.
 *
 * 채널마다 다른 배율로 확대/축소해 읽는다. 빨강은 조금 크게, 파랑은 조금 작게.
 */
const CHROMA_ABERRATION_CHUNK = /* glsl */ `
uniform float u_fx_lensChroma_amount;
uniform float u_fx_lensChroma_falloff;
uniform float u_fx_lensChroma_mix;

vec4 fx_lensChroma_tap(vec2 uv) {
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return vec4(0.0);
  return texture(u_image, uv);
}

vec4 grade_fx_lensChroma(vec4 c, vec2 uv) {
  if (u_fx_lensChroma_amount <= 0.0) return c;

  vec2 d = uv - 0.5;
  // 중심에서의 거리로 세기를 키운다. falloff 1 이면 선형, 2 면 귀퉁이에만 몰린다.
  float k = pow(clamp(length(d) * 2.0, 0.0, 1.0), max(0.2, u_fx_lensChroma_falloff));
  float s = u_fx_lensChroma_amount * 0.01 * k;

  vec4 r = fx_lensChroma_tap(0.5 + d * (1.0 + s));
  vec4 b = fx_lensChroma_tap(0.5 + d * (1.0 - s));

  /*
   * 알파는 **원래 것을 그대로 쓴다.**
   *
   * 채널마다 다른 자리를 읽으면 알파도 세 갈래가 되어 실루엣이 무지개색으로
   * 번진다. 투명 배경 스티커에서는 그 테두리가 곧바로 눈에 띈다.
   */
  vec4 shifted = vec4(r.r, c.g, b.b, c.a);
  return mix(c, shifted, clamp(u_fx_lensChroma_mix, 0.0, 1.0));
}
`

const lensChroma: EffectDef = {
  id: 'fx.lensChroma',
  label: '렌즈 색수차',
  hint: '가운데는 또렷하고 가장자리로 갈수록 색이 갈라진다. 사진 렌즈의 성질이다.',
  stage: 'C',
  cost: 'free',
  preservesAlpha: true,
  fusable: false,
  fn: 'grade_fx_lensChroma',
  chunk: CHROMA_ABERRATION_CHUNK,
  params: [
    { key: 'amount', label: '세기', type: 'number', min: 0, max: 5, step: 0.05, default: 1 },
    { key: 'falloff', label: '가장자리 쏠림', type: 'number', min: 0.2, max: 4, step: 0.1, default: 1.6 },
    { key: 'mix', label: '적용량', type: 'number', min: 0, max: 1, step: 0.01, default: 1 },
  ],
  uniforms: [
    { name: 'u_fx_lensChroma_amount', type: 'float', value: (c) => pv(c, 'amount', 1) },
    { name: 'u_fx_lensChroma_falloff', type: 'float', value: (c) => pv(c, 'falloff', 1.6) },
    { name: 'u_fx_lensChroma_mix', type: 'float', value: (c) => pv(c, 'mix', 1) },
  ],
}

// ---------------------------------------------------------------------------
// 17. 그라데이션
// ---------------------------------------------------------------------------

/**
 * 두 색 사이의 그라데이션을 얹는다.
 *
 * ---------------------------------------------------------------------------
 * 왜 도형 색이 아니라 이펙트인가
 * ---------------------------------------------------------------------------
 * 도형과 글자의 색 필드를 그라데이션으로 바꾸면 도형에서만 쓸 수 있고, 사진에
 * 노을빛을 입히는 흔한 쓰임은 여전히 못 한다. 이펙트로 두면 **이미지 / 도형 / 글자
 * 어디에나 같은 노브**가 걸리고, 스톱워치를 켜 각도와 위치를 애니메이션할 수도 있다.
 *
 * '색만 바꾸기' 모드가 도형 그라데이션 채우기다. 알파(실루엣)는 그대로 두고 색만
 * 갈아치우므로, 별 모양 도형에 걸면 별이 그라데이션으로 칠해진다.
 *
 * 알파를 건드리지 않는 것이 이 조각의 계약이다. 투명 배경 스티커에서 그라데이션이
 * 배경까지 칠하면 파일이 통째로 불투명해진다.
 */
const GRADIENT_CHUNK = /* glsl */ `
uniform vec3  u_fx_gradient_from;
uniform vec3  u_fx_gradient_to;
uniform float u_fx_gradient_angle;   // rad
uniform float u_fx_gradient_start;
uniform float u_fx_gradient_end;
uniform int   u_fx_gradient_shape;   // 0 선형 1 원형
uniform int   u_fx_gradient_blend;   // 0 색만 2 곱하기 3 스크린 4 겹치기
uniform float u_fx_gradient_opacity;

vec4 grade_fx_gradient(vec4 c, vec2 uv) {
  if (c.a <= 0.0) return c;

  float t;
  if (u_fx_gradient_shape == 1) {
    // 0.70710678 = 중심에서 모서리까지. 1 에서 네 귀퉁이가 정확히 끝 색이 된다.
    t = length(uv - 0.5) / 0.70710678;
  } else {
    vec2 dir = vec2(cos(u_fx_gradient_angle), sin(u_fx_gradient_angle));
    // 정사각형이 아닌 캔버스에서도 각도가 눈에 보이는 대로 돌게 uv 를 그대로 쓴다.
    t = dot(uv - 0.5, dir) + 0.5;
  }

  float lo = u_fx_gradient_start;
  float hi = u_fx_gradient_end;
  // 두 위치가 같으면 나눗셈이 터진다. 그때는 칼로 자른 경계가 맞다.
  t = (hi - lo) > 1e-4 ? clamp((t - lo) / (hi - lo), 0.0, 1.0) : step(lo, t);

  vec3 g = mix(u_fx_gradient_from, u_fx_gradient_to, t);
  vec4 s = unpremul(c);

  vec3 mixed;
  if (u_fx_gradient_blend == 2) mixed = s.rgb * g;
  else if (u_fx_gradient_blend == 3) mixed = 1.0 - (1.0 - s.rgb) * (1.0 - g);
  else if (u_fx_gradient_blend == 4) {
    // 겹치기(overlay). 어두운 곳은 곱하기, 밝은 곳은 스크린이다.
    vec3 lo2 = 2.0 * s.rgb * g;
    vec3 hi2 = 1.0 - 2.0 * (1.0 - s.rgb) * (1.0 - g);
    mixed = mix(lo2, hi2, step(vec3(0.5), s.rgb));
  } else mixed = g;

  s.rgb = mix(s.rgb, clamp(mixed, 0.0, 1.0), clamp(u_fx_gradient_opacity, 0.0, 1.0));
  // 알파는 손대지 않는다. 실루엣이 곧 이 레이어의 모양이다.
  return premul(vec4(s.rgb, c.a));
}
`

const gradient: EffectDef = {
  id: 'fx.gradient',
  label: '그라데이션',
  hint: '두 색 사이로 물들인다. 색만 바꾸기로 두면 도형과 글자가 그라데이션으로 칠해진다.',
  stage: 'C',
  cost: 'free',
  preservesAlpha: true,
  fn: 'grade_fx_gradient',
  chunk: GRADIENT_CHUNK,
  params: [
    { key: 'from', label: '시작 색', type: 'color', default: 0xff6b6b },
    { key: 'to', label: '끝 색', type: 'color', default: 0x4d7cff },
    {
      key: 'shape',
      label: '모양',
      type: 'select',
      options: [
        { value: 0, label: '한 방향' },
        { value: 1, label: '가운데에서' },
      ],
      default: 0,
    },
    { key: 'angle', label: '각도', type: 'number', min: 0, max: 360, step: 1, unit: '°', default: 90 },
    { key: 'start', label: '시작 위치', type: 'number', min: -0.5, max: 1.5, step: 0.01, default: 0 },
    { key: 'end', label: '끝 위치', type: 'number', min: -0.5, max: 1.5, step: 0.01, default: 1 },
    {
      key: 'blend',
      label: '섞는 방식',
      type: 'select',
      options: [
        { value: 0, label: '색만 바꾸기' },
        { value: 2, label: '곱하기' },
        { value: 3, label: '스크린' },
        { value: 4, label: '겹치기' },
      ],
      default: 0,
    },
    { key: 'opacity', label: '진하기', type: 'number', min: 0, max: 1, step: 0.01, default: 1 },
  ],
  uniforms: [
    { name: 'u_fx_gradient_from', type: 'vec3', value: (c) => rgbOf(pv(c, 'from', 0xff6b6b)) },
    { name: 'u_fx_gradient_to', type: 'vec3', value: (c) => rgbOf(pv(c, 'to', 0x4d7cff)) },
    { name: 'u_fx_gradient_angle', type: 'float', value: (c) => pv(c, 'angle', 90) * DEG2RAD },
    { name: 'u_fx_gradient_start', type: 'float', value: (c) => pv(c, 'start', 0) },
    { name: 'u_fx_gradient_end', type: 'float', value: (c) => pv(c, 'end', 1) },
    {
      name: 'u_fx_gradient_shape',
      type: 'int',
      value: (c) => (Math.round(pv(c, 'shape', 0)) === 1 ? 1 : 0),
    },
    {
      name: 'u_fx_gradient_blend',
      type: 'int',
      value: (c) => Math.round(pv(c, 'blend', 0)),
    },
    { name: 'u_fx_gradient_opacity', type: 'float', value: (c) => pv(c, 'opacity', 1) },
  ],
}

export const FINISH_EFFECTS: EffectDef[] = [
  grade,
  gradient,
  blur,
  lensChroma,
  dirBlur,
  halftone,
  posterize,
  aperture,
  scanline,
  grain,
  paper,
  vignette,
]
