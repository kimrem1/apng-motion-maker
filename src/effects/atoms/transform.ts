/**
 * A 스테이지(변형) 원자 이펙트.
 *
 * A 스테이지는 픽셀을 만들지 않는다. **샘플링 좌표만 바꾼다.** 그래서 이펙트 여러 개를
 * 개별 패스로 쪼갤 이유가 없다. 각 이펙트는 GLSL 함수 하나만 제공하고, 패스 그래프가
 * 그것들을 하나의 셰이더로 융합해 UV 누산기를 돌린다.
 *
 *   vec2 warp_<id>(vec2 uv, vec2 texel)   // 반환값 = 이 이펙트가 더할 UV 오프셋
 *   uv += warp_a(uv, texel); uv += warp_b(uv, texel); ...   // 순차 누산
 *
 * 계약 4가지. 어기면 프리뷰와 내보내기가 갈리거나 컴파일이 깨진다.
 *
 * 1. **반환은 오프셋이다. 절대 좌표가 아니다.** 누산은 엔진이 한다.
 * 2. **좌표계는 소스 샘플링 공간이다.** 반환값 +x 는 "더 오른쪽을 읽어라"이므로
 *    화면에서는 그림이 왼쪽으로 간다. 이미지 기준 이동을 원하는 이펙트(shake)는
 *    함수 안에서 부호를 뒤집는다.
 * 3. **texel = 1.0 / 소스 해상도.** px 단위 파라미터는 전부 texel 을 곱해 UV 로 바꾼다.
 *    가로세로 비가 다른 캔버스에서 회전/극좌표를 다룰 때는 texel.y/texel.x (= w/h) 로
 *    가로를 보정한 뒤 되돌린다.
 * 4. **누산은 순서대로, 갱신된 uv 로 한다.** fx.pixelate 는 최종 uv 를 양자화해야 의미가
 *    있으므로 A 스테이지 체인의 **마지막**에 배치해야 한다 (registry 정렬 책임).
 *
 * 결정론:
 * - 셰이더 난수는 PCG 정수 비트 해시뿐이다. `fract(sin(x))` 는 GPU 마다 값이 달라 금지.
 * - 프레임 간 상태 캐리오버 없음. 시드는 프레임마다 hashSeed 로 다시 만든다.
 * - CPU 쪽 시간 소스는 ctx.frame 뿐이다. Date.now / performance.now / Math.random 없음.
 *
 * 유니폼 규칙:
 * - 이름은 `u_<id>_<param>` 이고 id 의 '.' 는 '_' 로 바꾼다 (GLSL 식별자 제약).
 * - **값 타입은 float 와 vec2 두 가지뿐이다.** int 유니폼을 쓰지 않으므로 엔진은
 *   number -> uniform1f, [x,y] -> uniform2f 두 갈래만 구현하면 된다. 정수가 필요한
 *   자리는 셰이더에서 int(x + 0.5) 로 캐스팅한다.
 */

import { effectiveFrame, hashSeed, mulberry32, signedRandom } from '@/core/rng.ts'
import { fbmLoop } from '@/motions/generators.ts'
import type { EffectDef } from '@/effects/types.ts'

// ---------------------------------------------------------------------------
// 공용 GLSL 프리로그
// ---------------------------------------------------------------------------

/**
 * 모든 A 스테이지 조각이 함께 쓰는 헬퍼. 융합 셰이더에 **한 번만** 붙인다.
 * 이펙트마다 붙이면 함수 재정의로 링크가 깨진다.
 *
 * `u_stageSrc` 는 A 스테이지의 입력 텍스처(premultiplied)다. 엣지 가중 워프와
 * 자기 이미지 디스플레이스먼트가 원본 픽셀을 읽어야 해서 필요하다. 엔진은 A 패스의
 * 입력 텍스처를 항상 여기에 바인딩하면 된다. 아무도 안 쓰면 컴파일러가 지우고
 * getUniformLocation 이 null 을 주므로, 엔진은 null 위치를 건너뛰기만 하면 된다.
 *
 * 호스트 셰이더는 `precision highp float;` 를 선언해야 한다. int/uint 는 이 프리로그가
 * 전부 highp 로 명시하므로 기본 정밀도(fragment 에서 mediump int)에 의존하지 않는다.
 */
export const TRANSFORM_COMMON_GLSL = /* glsl */ `
uniform sampler2D u_stageSrc;

// PCG 3D 정수 해시. 비트 연산만 쓰므로 GPU 가 달라도 같은 값이 나온다.
highp uvec3 mmPcg3(highp uvec3 v) {
  v = v * 1664525u + 1013904223u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  v ^= v >> 16u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  return v;
}

// float 로 실어 온 시드를 uint 로. 24비트 이하 정수만 실으므로 왕복이 정확하다.
highp uint mmSeed(float s) {
  return uint(max(s, 0.0));
}

// 정수 격자점의 의사난수. [-1, 1]
float mmLattice(highp ivec2 cell, highp uint seed) {
  highp uvec3 h = mmPcg3(uvec3(uvec2(cell), seed));
  return float(h.x) * (2.0 / 4294967295.0) - 1.0;
}

// 5차 스무스스텝. 2차 도함수까지 연속이라 셀 경계에서 기울기가 튀지 않는다.
float mmSmoother(float t) {
  return t * t * t * (t * (t * 6.0 - 15.0) + 10.0);
}

float mmNoise2(vec2 p, highp uint seed) {
  vec2 i = floor(p);
  vec2 f = p - i;
  highp ivec2 c = ivec2(i);
  float u = mmSmoother(f.x);
  float v = mmSmoother(f.y);
  float n00 = mmLattice(c, seed);
  float n10 = mmLattice(c + ivec2(1, 0), seed);
  float n01 = mmLattice(c + ivec2(0, 1), seed);
  float n11 = mmLattice(c + ivec2(1, 1), seed);
  return mix(mix(n00, n10, u), mix(n01, n11, u), v);
}

highp ivec2 mmWrapCell(highp ivec2 c, highp int period) {
  return ivec2(((c.x % period) + period) % period, ((c.y % period) + period) % period);
}

// 격자 period 칸마다 반복하는 값 노이즈. 팬을 정확히 period 배수만큼 밀면
// 필드가 원래 자리로 돌아오므로 루프 이음새가 없다.
float mmNoise2Periodic(vec2 p, highp int period, highp uint seed) {
  highp int per = max(period, 1);
  vec2 i = floor(p);
  vec2 f = p - i;
  highp ivec2 c0 = mmWrapCell(ivec2(i), per);
  highp ivec2 c1 = mmWrapCell(ivec2(i) + ivec2(1), per);
  float u = mmSmoother(f.x);
  float v = mmSmoother(f.y);
  float n00 = mmLattice(ivec2(c0.x, c0.y), seed);
  float n10 = mmLattice(ivec2(c1.x, c0.y), seed);
  float n01 = mmLattice(ivec2(c0.x, c1.y), seed);
  float n11 = mmLattice(ivec2(c1.x, c1.y), seed);
  return mix(mix(n00, n10, u), mix(n01, n11, u), v);
}

// 옥타브 합. 가중 평균으로 정규화하므로 옥타브 수와 무관하게 [-1, 1] 이다.
// (CPU 쪽 generators.ts fbmLoop 과 같은 정규화 규칙)
float mmFbm2(vec2 p, highp int octaves, highp uint seed) {
  float sum = 0.0;
  float amp = 1.0;
  float norm = 0.0;
  for (int i = 0; i < 3; i++) {
    if (i >= octaves) break;
    sum += mmNoise2(p, seed + uint(i) * 0x9e3779b9u) * amp;
    norm += amp;
    amp *= 0.5;
    p *= 2.0;
  }
  return norm > 0.0 ? sum / norm : 0.0;
}

float mmFbm2Periodic(vec2 p, highp int period, highp int octaves, highp uint seed) {
  float sum = 0.0;
  float amp = 1.0;
  float norm = 0.0;
  highp int per = max(period, 1);
  for (int i = 0; i < 3; i++) {
    if (i >= octaves) break;
    sum += mmNoise2Periodic(p, per, seed + uint(i) * 0x9e3779b9u) * amp;
    norm += amp;
    amp *= 0.5;
    p *= 2.0;
    per *= 2;
  }
  return norm > 0.0 ? sum / norm : 0.0;
}

vec4 mmSrc(vec2 uv) {
  return texture(u_stageSrc, clamp(uv, vec2(0.0), vec2(1.0)));
}

// 파이프라인은 premultiplied 다. 색을 값으로 읽을 때는 알파를 되돌려야
// 반투명 영역에서 어두운 쪽으로 치우치지 않는다.
vec3 mmStraight(vec4 c) {
  return c.a > 0.0 ? c.rgb / c.a : vec3(0.0);
}

float mmLuma(vec3 c) {
  return dot(c, vec3(0.2126, 0.7152, 0.0722));
}
`

// ---------------------------------------------------------------------------
// GLSL 식별자 규칙
// ---------------------------------------------------------------------------

/** 'boil.warp' -> 'boil_warp'. GLSL 식별자에 '.' 를 못 쓴다. */
export function glslKey(id: string): string {
  return id.replace(/[^A-Za-z0-9_]/g, '_')
}

/** 융합 셰이더가 호출할 함수 이름. 'boil.warp' -> 'warp_boil_warp' */
export function warpFnName(id: string): string {
  return `warp_${glslKey(id)}`
}

/** 유니폼 접두사. 'boil.warp' -> 'u_boil_warp_' */
export function warpUniformPrefix(id: string): string {
  return `u_${glslKey(id)}_`
}

// ---------------------------------------------------------------------------
// CPU 헬퍼 (전부 순수 함수. 시간 소스는 ctx.frame 뿐이다)
// ---------------------------------------------------------------------------

const DEG = Math.PI / 180
const TAU = Math.PI * 2

/** 24비트로 접어 float 유니폼에 정확히 실을 수 있게 만든다. */
const SEED_MOD = 0x1000000

function num(v: number | string | boolean | undefined, fallback: number): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : fallback
  if (typeof v === 'string') {
    const n = Number(v)
    return Number.isFinite(n) ? n : fallback
  }
  if (typeof v === 'boolean') return v ? 1 : 0
  return fallback
}

function clampNum(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

function clamp1(v: number): number {
  return clampNum(v, -1, 1)
}

function intOf(v: number | string | boolean | undefined, fallback: number, lo: number, hi: number): number {
  return Math.round(clampNum(num(v, fallback), lo, hi))
}

/**
 * 이펙트 인스턴스의 시드 베이스.
 * projectSeed 를 섞으므로 문서마다 다른 흔들림이 나오고, nodeId 를 섞으므로
 * 같은 프레임의 서로 다른 인스턴스가 같은 값을 내지 않는다.
 */
function seedBaseOf(ctx: WarpFrameContext, salt: string): number {
  // instanceSeed 를 쓴다. ctx.seed 는 effFrame 이 섞여 프레임마다 바뀌는 값이라
  // 여기에 넣으면 노이즈 필드가 매 프레임 통째로 재추첨된다. fbmLoop 은 t 축 연속성으로
  // 부드러운 흔들림을 만드는 함수인데, 시드가 바뀌면 매번 다른 필드에서 한 점씩 뽑는 셈이라
  // 결과가 백색잡음이 되고 t=0 == t=1 심리스 보장도 사라진다.
  return hashSeed(ctx.projectSeed ^ ctx.instanceSeed, `${ctx.nodeId}:${salt}`, 0)
}

/**
 * 홀드 클럭.
 * 인스턴스 공통 홀드(EffectInstance.holdFrames)를 먼저 적용하고 그 위에 이펙트 자체
 * 홀드를 얹는다. 어느 쪽이 1 이어도 결과는 다른 쪽만 적용한 것과 같다.
 */
function heldFrame(ctx: WarpFrameContext, hold: number): number {
  return effectiveFrame(effectiveFrame(ctx.frame, ctx.holdFrames), hold)
}

/**
 * 선택 필드 읽기. 엔진 컨텍스트에 hasAlpha 가 없어도 이 헬퍼를 거치면 컴파일된다
 * (선택 프로퍼티는 대입 가능성을 막지 않는다).
 */
function hasAlphaOf(ctx: WarpFrameContext): boolean | undefined {
  return ctx.hasAlpha
}

/** 정규화 루프 위상 [0, 1). t=0 과 t=1 이 같은 점을 가리켜야 심리스다. */
function loopPhase(ctx: WarpFrameContext, hold: number): number {
  const duration = Math.max(1, ctx.durationFrames)
  const f = heldFrame(ctx, hold)
  return (((f % duration) + duration) % duration) / duration
}

/**
 * N 상태 사이클.
 *
 *   state = floor(frame / hold) % states
 *
 * 왜 이것이 심리스 루프의 근거인가:
 * 상태는 **보간 없는 이산값**이다. 상태 사이에 트윈이 없으므로 프레임 N 과 프레임 0
 * 사이의 전환도 다른 모든 컷 전환과 성질이 완전히 같다. 즉 "루프 지점만 유독 튄다"가
 * 원리적으로 생기지 않는다. 연속 노이즈를 프레임에 직접 물리면 마지막 프레임과 첫
 * 프레임 사이에만 기울기 불연속이 생겨 이음새가 보이는 것과 정반대다.
 *
 * 완전히 같은 컷 순서로 반복되게 하려면 durationFrames % (hold * states) == 0 이면
 * 된다. 아니어도 루프는 깨지지 않고 컷 순서만 주기마다 회전한다. 다만 마지막 홀드
 * 블록이 잘리는 durationFrames % hold != 0 은 마지막 컷만 짧아지므로 경고 대상이다
 * 경고와 원클릭 수정은 UI 담당이다.
 */
function boilState(ctx: WarpFrameContext, hold: number, states: number): number {
  const h = Math.max(1, Math.floor(hold))
  const n = Math.max(1, Math.floor(states))
  const f = effectiveFrame(ctx.frame, ctx.holdFrames)
  return Math.floor(f / h) % n
}

/** 상태마다 노이즈 필드를 통째로 갈아 끼울 위상 오프셋과 정수 시드. */
function boilStateSeed(ctx: WarpFrameContext, salt: string, state: number): {
  jitter: [number, number]
  seed: number
} {
  // seedBaseOf 와 같은 이유로 instanceSeed 를 쓴다. ctx.seed 를 섞으면 같은 state 번호가
  // 매 프레임 다른 필드를 받아 '그림 장수'(states) 파라미터가 아무 일도 하지 않는다.
  const h = hashSeed(ctx.projectSeed ^ ctx.instanceSeed, `${ctx.nodeId}:${salt}`, state)
  const rng = mulberry32(h)
  return { jitter: [rng() * 512, rng() * 512], seed: h % SEED_MOD }
}

// ---------------------------------------------------------------------------
// uniforms() 가 받는 프레임 컨텍스트
// ---------------------------------------------------------------------------

/**
 * A 스테이지 조각이 요구하는 최소 컨텍스트.
 * 엔진의 실제 컨텍스트 타입이 이 필드들을 모두 가지면 그대로 대입된다.
 */
export interface WarpFrameContext {
  /** 정수 프레임 인덱스 */
  frame: number
  /** 이 컴포지션의 총 프레임 수 */
  durationFrames: number
  /** 문서 시드 */
  projectSeed: number
  /**
   * EffectInstance.seed. **프레임 불변이어야 한다.**
   *
   * 필드 이름을 seed 로 두면 안 된다. 엔진의 EffectEvalContext 에도 seed 가 있고
   * 그건 effFrame 이 섞인 프레임 가변 값이라, 구조적 타이핑 때문에 조용히 대입되어
   * 흔들림이 백색잡음이 된다. tsc 는 통과한다.
   */
  instanceSeed: number
  /** EffectInstance.id (또는 layerId:effectId). 인스턴스마다 달라야 한다. */
  nodeId: string
  /** EffectInstance.holdFrames. 1 이면 홀드 없음. */
  holdFrames: number
  /** 트랙이면 이미 이 프레임에서 평가된 값. select 는 숫자 코드다. */
  params: Readonly<Record<string, number | string | boolean>>
  /**
   * 소스에 알파가 있는가 (AssetRef.hasAlpha). 선택 필드다.
   * boil.edge 의 '자동' 판정에만 쓰고, 없으면 셰이더가 픽셀 단위로 판정한다.
   */
  hasAlpha?: boolean
}

// ---------------------------------------------------------------------------
// 1. 워프 boil (boil.warp)
// ---------------------------------------------------------------------------

const BOIL_WARP: EffectDef = {
  id: 'boil.warp',
  label: '자글자글 워프',
  hint: '손으로 다시 그린 것처럼 윤곽이 미세하게 떨린다. 홀드 프레임이 2~3컷 느낌을 만든다.',
  stage: 'A',
  cost: 'low',
  preservesAlpha: true,
  params: [
    { key: 'amp', label: '워프 진폭', type: 'number', min: 0, max: 8, step: 0.1, unit: 'px', default: 1.5 },
    { key: 'scale', label: '노이즈 스케일', type: 'number', min: 0.0005, max: 0.05, step: 0.0005, default: 0.006 },
    { key: 'swirl', label: '도메인 워프', type: 'number', min: 0, max: 1, step: 0.05, default: 0.5 },
    { key: 'octaves', label: '옥타브', type: 'number', min: 1, max: 2, step: 1, default: 1 },
    { key: 'states', label: '상태 수', type: 'number', min: 1, max: 8, step: 1, default: 3 },
    { key: 'hold', label: '홀드 프레임', type: 'number', min: 1, max: 8, step: 1, unit: 'f', default: 3 },
  ],
  glsl: /* glsl */ `
uniform float u_boil_warp_amp;
uniform float u_boil_warp_scale;
uniform float u_boil_warp_swirl;
uniform float u_boil_warp_octaves;
uniform float u_boil_warp_seed;
uniform vec2  u_boil_warp_jitter;

// 도메인 워프: 노이즈로 노이즈의 좌표를 민다. 한 번만 접어도 등고선이 손그림처럼
// 구불거린다. 옥타브를 올리는 것보다 싸고 결과가 낫다.
vec2 warp_boil_warp(vec2 uv, vec2 texel) {
  highp int oct = int(u_boil_warp_octaves + 0.5);
  highp uint s = mmSeed(u_boil_warp_seed);
  vec2 p = uv / texel * u_boil_warp_scale + u_boil_warp_jitter;

  vec2 q = vec2(
    mmFbm2(p, oct, s),
    mmFbm2(p + vec2(5.2, 1.3), oct, s ^ 0x68bc21ebu)
  ) * u_boil_warp_swirl;

  vec2 d = vec2(
    mmFbm2(p + q + vec2(1.7, 9.2), oct, s ^ 0xb5297a4du),
    mmFbm2(p + q + vec2(8.3, 2.8), oct, s ^ 0x1b56c4e9u)
  );

  return d * u_boil_warp_amp * texel;
}
`,
  uniforms: (ctx) => {
    const p = ctx.params
    const hold = intOf(p.hold, 3, 1, 8)
    const states = intOf(p.states, 3, 1, 8)
    const state = boilState(ctx, hold, states)
    const { jitter, seed } = boilStateSeed(ctx, 'boil.warp', state)
    return {
      u_boil_warp_amp: clampNum(num(p.amp, 1.5), 0, 8),
      u_boil_warp_scale: clampNum(num(p.scale, 0.006), 0.0005, 0.05),
      // 파라미터는 0~1 이고 노이즈 도메인 단위로 옮긴다. 1.5 를 넘기면 필드가
      // 스스로를 접어 형체가 뭉개진다.
      u_boil_warp_swirl: clampNum(num(p.swirl, 0.5), 0, 1) * 1.5,
      u_boil_warp_octaves: intOf(p.octaves, 1, 1, 2),
      u_boil_warp_seed: seed,
      u_boil_warp_jitter: jitter,
    }
  },
}

// ---------------------------------------------------------------------------
// 2. 엣지 가중 워프 (boil.edge)
// ---------------------------------------------------------------------------

const BOIL_EDGE: EffectDef = {
  id: 'boil.edge',
  label: '외곽선만 자글자글',
  hint: '엣지가 강한 곳만 떨린다. 알파가 있으면 알파 경계를, 없으면 휘도 경계를 쓴다.',
  stage: 'A',
  cost: 'medium',
  preservesAlpha: true,
  params: [
    { key: 'amp', label: '워프 진폭', type: 'number', min: 0, max: 10, step: 0.1, unit: 'px', default: 2 },
    {
      key: 'source',
      label: '엣지 소스',
      type: 'select',
      options: [
        { value: '0', label: '자동' },
        { value: '1', label: '알파 경계' },
        { value: '2', label: '휘도 경계' },
      ],
      default: 0,
    },
    { key: 'threshold', label: '엣지 임계', type: 'number', min: 0, max: 1, step: 0.01, default: 0.08 },
    { key: 'feather', label: '엣지 페더', type: 'number', min: 0.01, max: 1, step: 0.01, default: 0.2 },
    { key: 'radius', label: '엣지 탭 간격', type: 'number', min: 1, max: 4, step: 0.5, unit: 'px', default: 1 },
    { key: 'scale', label: '노이즈 스케일', type: 'number', min: 0.0005, max: 0.05, step: 0.0005, default: 0.01 },
    { key: 'octaves', label: '옥타브', type: 'number', min: 1, max: 2, step: 1, default: 1 },
    { key: 'states', label: '상태 수', type: 'number', min: 1, max: 8, step: 1, default: 3 },
    { key: 'hold', label: '홀드 프레임', type: 'number', min: 1, max: 8, step: 1, unit: 'f', default: 3 },
  ],
  glsl: /* glsl */ `
uniform float u_boil_edge_amp;
uniform float u_boil_edge_mode;
uniform float u_boil_edge_threshold;
uniform float u_boil_edge_feather;
uniform float u_boil_edge_radius;
uniform float u_boil_edge_scale;
uniform float u_boil_edge_octaves;
uniform float u_boil_edge_seed;
uniform vec2  u_boil_edge_jitter;

// Sobel. 가중치 합이 한쪽당 4 라 결과를 4 로 나누면 [0, 1] 로 맞는다.
vec2 boilEdge_sobel(float mm, float zm, float pm, float mz, float pz, float mp, float zp, float pp) {
  float gx = (pm + 2.0 * pz + pp) - (mm + 2.0 * mz + mp);
  float gy = (mp + 2.0 * zp + pp) - (mm + 2.0 * zm + pm);
  return vec2(gx, gy) * 0.25;
}

vec2 warp_boil_edge(vec2 uv, vec2 texel) {
  vec2 st = texel * max(u_boil_edge_radius, 0.5);

  vec4 cmm = mmSrc(uv + vec2(-st.x, -st.y));
  vec4 czm = mmSrc(uv + vec2(0.0, -st.y));
  vec4 cpm = mmSrc(uv + vec2(st.x, -st.y));
  vec4 cmz = mmSrc(uv + vec2(-st.x, 0.0));
  vec4 cpz = mmSrc(uv + vec2(st.x, 0.0));
  vec4 cmp = mmSrc(uv + vec2(-st.x, st.y));
  vec4 czp = mmSrc(uv + vec2(0.0, st.y));
  vec4 cpp = mmSrc(uv + vec2(st.x, st.y));

  float ea = length(boilEdge_sobel(cmm.a, czm.a, cpm.a, cmz.a, cpz.a, cmp.a, czp.a, cpp.a));
  float el = length(boilEdge_sobel(
    mmLuma(mmStraight(cmm)), mmLuma(mmStraight(czm)), mmLuma(mmStraight(cpm)),
    mmLuma(mmStraight(cmz)), mmLuma(mmStraight(cpz)),
    mmLuma(mmStraight(cmp)), mmLuma(mmStraight(czp)), mmLuma(mmStraight(cpp))
  ));

  // 자동: 주변 9탭이 전부 불투명하면 알파 경계가 존재하지 않는 영역이므로 휘도로 폴백한다.
  // 알파가 있는 스티커의 외곽에서는 항상 알파 경계가 이긴다. 그쪽이 더 정확하다.
  float minA = min(min(min(cmm.a, czm.a), min(cpm.a, cmz.a)), min(min(cpz.a, cmp.a), min(czp.a, cpp.a)));
  float e = u_boil_edge_mode > 1.5 ? el : (u_boil_edge_mode > 0.5 ? ea : (minA > 0.999 ? el : ea));

  float t0 = u_boil_edge_threshold;
  float w = smoothstep(t0, t0 + max(u_boil_edge_feather, 0.001), e);
  if (w <= 0.0) return vec2(0.0);

  highp int oct = int(u_boil_edge_octaves + 0.5);
  highp uint s = mmSeed(u_boil_edge_seed);
  vec2 p = uv / texel * u_boil_edge_scale + u_boil_edge_jitter;
  vec2 d = vec2(
    mmFbm2(p, oct, s),
    mmFbm2(p + vec2(19.3, 7.1), oct, s ^ 0x27d4eb2du)
  );

  return d * (u_boil_edge_amp * w) * texel;
}
`,
  uniforms: (ctx) => {
    const p = ctx.params
    const hold = intOf(p.hold, 3, 1, 8)
    const states = intOf(p.states, 3, 1, 8)
    const state = boilState(ctx, hold, states)
    const { jitter, seed } = boilStateSeed(ctx, 'boil.edge', state)
    // 자동인데 소스에 알파가 없다는 것을 엔진이 알려주면 휘도로 고정한다.
    // 모르면 셰이더의 9탭 판정에 맡긴다. 어느 쪽이든 워프가 0 이 되는 일은 없다.
    const src = intOf(p.source, 0, 0, 2)
    const mode = src === 0 && hasAlphaOf(ctx) === false ? 2 : src
    return {
      u_boil_edge_amp: clampNum(num(p.amp, 2), 0, 10),
      u_boil_edge_mode: mode,
      u_boil_edge_threshold: clampNum(num(p.threshold, 0.08), 0, 1),
      u_boil_edge_feather: clampNum(num(p.feather, 0.2), 0.01, 1),
      u_boil_edge_radius: clampNum(num(p.radius, 1), 0.5, 4),
      u_boil_edge_scale: clampNum(num(p.scale, 0.01), 0.0005, 0.05),
      u_boil_edge_octaves: intOf(p.octaves, 1, 1, 2),
      u_boil_edge_seed: seed,
      u_boil_edge_jitter: jitter,
    }
  },
}

// ---------------------------------------------------------------------------
// 3. 흔들림 (shake.transform)
// ---------------------------------------------------------------------------

interface ShakeSample {
  x: number
  y: number
  rot: number
  scale: number
}

/**
 * 쿵 충격. 균등 배치한 사건마다 임펄스 응답을 더한다.
 * 이전 주기에서 넘어온 꼬리(wrap = -1)까지 더해야 t=0 에 이음새가 없다.
 * 방향은 사건마다 해시로 고정한다. 매 프레임 뽑으면 방향이 프레임마다 튄다.
 */
function impactSample(base: number, t: number, events: number, decay: number): ShakeSample {
  const n = Math.max(1, Math.round(events))
  const d = Math.max(0.001, decay)
  let x = 0
  let y = 0
  let rot = 0

  for (let i = 0; i < n; i += 1) {
    const rng = mulberry32(hashSeed(base, 'impact', i))
    const ang = rng() * TAU
    const spin = signedRandom(rng)
    for (let wrap = -1; wrap <= 0; wrap += 1) {
      const dt = t - (i / n + wrap)
      if (dt < 0) continue
      const v = Math.sin(dt * TAU * n * 2) * Math.exp(-d * dt * n)
      x += Math.cos(ang) * v
      y += Math.sin(ang) * v
      rot += spin * v
    }
  }
  return { x: clamp1(x), y: clamp1(y), rot: clamp1(rot), scale: clamp1((x + y) * 0.5) }
}

/** 모드별 원시 흔들림 [-1, 1]. 진폭은 아직 곱하지 않았다. */
function sampleShake(
  base: number,
  t: number,
  mode: number,
  cycles: number,
  octaves: number,
  decay: number,
): ShakeSample {
  const sx = hashSeed(base, 'shake:x', 0)
  const sy = hashSeed(base, 'shake:y', 0)
  const sr = hashSeed(base, 'shake:rot', 0)
  const ss = hashSeed(base, 'shake:scale', 0)
  const c = Math.max(0.5, cycles)

  switch (mode) {
    // 자글자글 떨림. 1옥타브 고주파. 홀드 프레임과 함께 써야 성격이 산다.
    case 1: {
      const r = c * 1.5
      return {
        x: fbmLoop(sx, t, 1, 0.5, 2, r),
        y: fbmLoop(sy, t, 1, 0.5, 2, r),
        rot: fbmLoop(sr, t, 1, 0.5, 2, r),
        scale: fbmLoop(ss, t, 1, 0.5, 2, r),
      }
    }

    // 크게 흔들. sine 이고 x/y 위상차 90도라 원 궤도를 그린다.
    // 주기는 정수여야 t=0 과 t=1 이 값도 기울기도 같다.
    case 2: {
      const w = TAU * Math.max(1, Math.round(cycles)) * t
      return {
        x: Math.sin(w),
        y: Math.sin(w + Math.PI / 2),
        rot: Math.sin(w + Math.PI / 4),
        scale: Math.sin(w),
      }
    }

    // 손으로 든 느낌. 저주파에 고주파를 섞는다.
    case 3: {
      const hi = 0.1875
      const norm = 1 + hi
      const lo = (s: number): number => fbmLoop(s, t, 1, 0.5, 2, Math.max(0.5, c * 0.5))
      const up = (s: number): number => fbmLoop(s ^ 0x51ed3f, t, 1, 0.5, 2, c * 3)
      return {
        x: (lo(sx) + up(sx) * hi) / norm,
        y: (lo(sy) + up(sy) * hi) / norm,
        rot: (lo(sr) + up(sr) * hi) / norm,
        scale: (lo(ss) + up(ss) * hi) / norm,
      }
    }

    // 쿵 충격
    case 4:
      return impactSample(base, t, cycles, decay)

    // 카메라 흔들림. 옥타브 2 가 기본이라 큰 흔들림 위에 잔떨림이 얹힌다.
    default:
      return {
        x: fbmLoop(sx, t, octaves, 0.5, 2, c),
        y: fbmLoop(sy, t, octaves, 0.5, 2, c),
        rot: fbmLoop(sr, t, octaves, 0.5, 2, c),
        scale: fbmLoop(ss, t, octaves, 0.5, 2, c),
      }
  }
}

/**
 * 포락선. 감쇠 없는 등진폭 흔들림은 즉시 싸구려로 보인다.
 * 기본값이 '없음'이 아니라 '숨쉬기'인 이유다.
 * - 숨쉬기: 세기가 주기적으로 오간다. t=0 과 t=1 이 같아 심리스가 유지된다.
 * - 감쇠  : 처음 세게 치고 지수적으로 죽는다. 1회 재생 전용이다.
 */
function shakeEnvelope(mode: number, t: number, cycles: number, decay: number): number {
  if (mode === 2) return 1
  if (mode === 1) return Math.exp(-Math.max(0.001, decay) * t)
  const c = Math.max(1, Math.round(cycles))
  return 0.35 + 0.65 * (0.5 - 0.5 * Math.cos(TAU * c * t))
}

const SHAKE_TRANSFORM: EffectDef = {
  id: 'shake.transform',
  label: '흔들림',
  hint: '화면 전체를 흔든다. 진폭은 CPU 에서 계산해 UV 를 통째로 민다. 리샘플은 한 번뿐이라 사실상 공짜다.',
  stage: 'A',
  cost: 'low',
  preservesAlpha: true,
  params: [
    {
      key: 'mode',
      label: '모드',
      type: 'select',
      options: [
        { value: '0', label: '카메라 흔들림' },
        { value: '1', label: '자글자글 떨림' },
        { value: '2', label: '크게 흔들' },
        { value: '3', label: '손으로 든 느낌' },
        { value: '4', label: '쿵 충격' },
      ],
      default: 0,
    },
    { key: 'ampX', label: '진폭 X', type: 'number', min: 0, max: 80, step: 0.5, unit: 'px', default: 6 },
    { key: 'ampY', label: '진폭 Y', type: 'number', min: 0, max: 80, step: 0.5, unit: 'px', default: 6 },
    { key: 'rotate', label: '회전', type: 'number', min: 0, max: 15, step: 0.1, unit: 'deg', default: 0.8 },
    { key: 'scaleAmp', label: '스케일 흔들림', type: 'number', min: 0, max: 0.2, step: 0.005, default: 0 },
    { key: 'cycles', label: '주기', type: 'number', min: 1, max: 16, step: 1, default: 4 },
    { key: 'octaves', label: '옥타브', type: 'number', min: 1, max: 4, step: 1, default: 2 },
    {
      key: 'envelope',
      label: '포락선',
      type: 'select',
      options: [
        { value: '0', label: '숨쉬기 (반복 안전)' },
        { value: '1', label: '감쇠 (1회 재생)' },
        { value: '2', label: '없음' },
      ],
      default: 0,
    },
    { key: 'envCycles', label: '포락선 주기', type: 'number', min: 1, max: 8, step: 1, default: 1 },
    { key: 'decay', label: '감쇠', type: 'number', min: 0.5, max: 20, step: 0.5, default: 6 },
    { key: 'hold', label: '홀드 프레임', type: 'number', min: 1, max: 8, step: 1, unit: 'f', default: 1 },
  ],
  glsl: /* glsl */ `
uniform vec2  u_shake_transform_offset;  // 이미지 기준 이동 (px)
uniform float u_shake_transform_rot;     // rad
uniform float u_shake_transform_scale;   // 배율

// 화면 좌표를 소스 좌표로 되돌리는 역어파인이다. 이동은 부호를 뒤집고,
// 회전과 스케일은 역행렬을 쓴다. 픽셀 공간에서 돌려야 정사각형이 아닌 캔버스에서
// 회전이 찌그러지지 않는다.
vec2 warp_shake_transform(vec2 uv, vec2 texel) {
  vec2 px = (uv - 0.5) / texel;
  float s = sin(u_shake_transform_rot);
  float c = cos(u_shake_transform_rot);
  vec2 r = vec2(c * px.x + s * px.y, -s * px.x + c * px.y) / max(u_shake_transform_scale, 0.0001);
  vec2 dst = 0.5 + (r - u_shake_transform_offset) * texel;
  return dst - uv;
}
`,
  uniforms: (ctx) => {
    const p = ctx.params
    const hold = intOf(p.hold, 1, 1, 8)
    const t = loopPhase(ctx, hold)
    const mode = intOf(p.mode, 0, 0, 4)
    const cycles = clampNum(num(p.cycles, 4), 1, 16)
    const octaves = intOf(p.octaves, 2, 1, 4)
    const decay = clampNum(num(p.decay, 6), 0.5, 20)
    const base = seedBaseOf(ctx, 'shake.transform')

    const n = sampleShake(base, t, mode, cycles, octaves, decay)
    const env = shakeEnvelope(intOf(p.envelope, 0, 0, 2), t, clampNum(num(p.envCycles, 1), 1, 8), decay)

    const ampX = clampNum(num(p.ampX, 6), 0, 80)
    const ampY = clampNum(num(p.ampY, 6), 0, 80)
    const rot = clampNum(num(p.rotate, 0.8), 0, 15)
    const scaleAmp = clampNum(num(p.scaleAmp, 0), 0, 0.2)

    return {
      u_shake_transform_offset: [n.x * ampX * env, n.y * ampY * env] as [number, number],
      u_shake_transform_rot: n.rot * rot * DEG * env,
      u_shake_transform_scale: 1 + n.scale * scaleAmp * env,
    }
  },
}

// ---------------------------------------------------------------------------
// 4. 디스플레이스먼트 맵 (warp.displace)
// ---------------------------------------------------------------------------

const WARP_DISPLACE: EffectDef = {
  id: 'warp.displace',
  label: '디스플레이스먼트 맵',
  hint: '맵의 밝기로 픽셀을 민다. 팬 속도는 루프당 정수 주기라 몇으로 두든 이음새가 없다.',
  stage: 'A',
  cost: 'low',
  preservesAlpha: true,
  params: [
    {
      key: 'source',
      label: '맵 소스',
      type: 'select',
      options: [
        { value: '0', label: 'fBm 노이즈' },
        { value: '1', label: '자기 이미지' },
      ],
      default: 0,
    },
    { key: 'amount', label: '변위 강도', type: 'number', min: 0, max: 64, step: 0.5, unit: 'px', default: 8 },
    { key: 'cell', label: '격자 크기', type: 'number', min: 4, max: 256, step: 1, unit: 'px', default: 24 },
    { key: 'octaves', label: '옥타브', type: 'number', min: 1, max: 3, step: 1, default: 2 },
    { key: 'period', label: '노이즈 주기', type: 'number', min: 2, max: 32, step: 1, unit: '셀', default: 8 },
    { key: 'panSpeed', label: '팬 속도', type: 'number', min: -3, max: 3, step: 1, unit: '루프당', default: 0 },
    // 방향은 셀 격자에 스냅된다 (uniforms 주석). 15도 단위로 보여 줘 봐야 실제로는
    // 가장 가까운 격자 방향으로 붙으므로, 눈금을 촘촘하게 두어 사용자가 직접 훑게 둔다.
    { key: 'panAngle', label: '팬 방향', type: 'number', min: 0, max: 360, step: 1, unit: 'deg', default: 0 },
    {
      key: 'channels',
      label: '채널 매핑',
      type: 'select',
      options: [
        { value: '0', label: 'R -> X, G -> Y' },
        { value: '1', label: 'G -> X, B -> Y' },
        { value: '2', label: 'R -> X, R -> Y (대각)' },
      ],
      default: 0,
    },
  ],
  glsl: /* glsl */ `
uniform float u_warp_displace_source;
uniform float u_warp_displace_amount;
uniform float u_warp_displace_cell;
uniform float u_warp_displace_octaves;
uniform float u_warp_displace_period;
uniform float u_warp_displace_channels;
uniform float u_warp_displace_seed;
uniform vec2  u_warp_displace_pan;

vec2 warp_warp_displace(vec2 uv, vec2 texel) {
  vec2 d;

  if (u_warp_displace_source > 0.5) {
    // 자기 이미지. premultiplied 를 되돌려야 반투명 영역이 0 쪽으로 쏠리지 않는다.
    vec3 c = mmStraight(mmSrc(uv));
    vec2 m = u_warp_displace_channels > 1.5 ? c.rr
           : (u_warp_displace_channels > 0.5 ? c.gb : c.rg);
    d = (m - 0.5) * 2.0;
  } else {
    // 주기 노이즈. 팬을 정확히 period 의 정수배만큼 밀면 필드가 제자리로 돌아온다.
    highp int per = int(u_warp_displace_period + 0.5);
    highp int oct = int(u_warp_displace_octaves + 0.5);
    highp uint s = mmSeed(u_warp_displace_seed);
    vec2 p = uv / texel / max(u_warp_displace_cell, 1.0) + u_warp_displace_pan;
    d = vec2(
      mmFbm2Periodic(p, per, oct, s),
      mmFbm2Periodic(p + vec2(3.1, 6.7), per, oct, s ^ 0x9e3779b9u)
    );
  }

  return d * u_warp_displace_amount * texel;
}
`,
  uniforms: (ctx) => {
    const p = ctx.params
    const t = loopPhase(ctx, 1)
    const period = intOf(p.period, 8, 2, 32)
    const panCycles = intOf(p.panSpeed, 0, -3, 3)
    const ang = num(p.panAngle, 0) * DEG

    /*
     * 팬 벡터를 셀 격자에 스냅한다.
     *
     * 노이즈는 x 와 y **각각** period 셀마다 반복한다(mmWrapCell). 그러니 t=1 에서
     * 필드가 제자리로 오려면 이동량의 **두 성분이 모두** period 의 정수배여야 한다.
     * 스칼라 이동량 panCycles*period 에 cos/sin 을 곱하면 안 된다. 45도에서 성분이
     * 0.707 배가 되어 축별 사이클 수가 정수가 아니게 되고, 루프 끝에서 필드가
     * 어긋난 채로 첫 프레임으로 돌아간다. 0도와 90도에서만 우연히 맞는다.
     *
     * 그래서 각도가 아니라 **축별 사이클 수를 정수로** 반올림한다. 방향은 표현할 수
     * 있는 격자 방향 중 가장 가까운 것으로 스냅되고(panCycles 가 클수록 촘촘해진다),
     * 대신 어느 각도로 두든 이음새가 없다. max(|cos|,|sin|) >= 0.707 이라
     * panCycles 가 0 이 아니면 두 성분이 동시에 0 이 되는 일도 없다.
     */
    const cyclesX = Math.round(panCycles * Math.cos(ang))
    const cyclesY = Math.round(panCycles * Math.sin(ang))
    return {
      u_warp_displace_source: intOf(p.source, 0, 0, 1),
      u_warp_displace_amount: clampNum(num(p.amount, 8), 0, 64),
      u_warp_displace_cell: clampNum(num(p.cell, 24), 4, 256),
      u_warp_displace_octaves: intOf(p.octaves, 2, 1, 3),
      u_warp_displace_period: period,
      u_warp_displace_channels: intOf(p.channels, 0, 0, 2),
      u_warp_displace_seed: seedBaseOf(ctx, 'warp.displace') % SEED_MOD,
      u_warp_displace_pan: [cyclesX * period * t, cyclesY * period * t] as [number, number],
    }
  },
}

// ---------------------------------------------------------------------------
// 5. 렌즈 / 배럴 왜곡 (warp.lens)
// ---------------------------------------------------------------------------

const WARP_LENS: EffectDef = {
  id: 'warp.lens',
  label: '렌즈 왜곡',
  hint: '양수는 볼록(배럴), 음수는 오목(핀쿠션). 곱셈 세 번이라 사실상 공짜다.',
  stage: 'A',
  cost: 'low',
  preservesAlpha: true,
  params: [
    { key: 'k', label: '왜곡 계수', type: 'number', min: -0.6, max: 0.6, step: 0.01, default: 0.15 },
    { key: 'centerX', label: '중심 X', type: 'number', min: 0, max: 1, step: 0.01, default: 0.5 },
    { key: 'centerY', label: '중심 Y', type: 'number', min: 0, max: 1, step: 0.01, default: 0.5 },
  ],
  glsl: /* glsl */ `
uniform float u_warp_lens_k;
uniform vec2  u_warp_lens_center;

vec2 warp_warp_lens(vec2 uv, vec2 texel) {
  // texel.y / texel.x = 가로/세로. 이 보정이 없으면 정사각형이 아닌 캔버스에서
  // 왜곡 등고선이 타원이 된다.
  float aspect = texel.y / texel.x;
  vec2 d = uv - u_warp_lens_center;
  d.x *= aspect;
  vec2 o = d * dot(d, d) * u_warp_lens_k;
  o.x /= aspect;
  return o;
}
`,
  uniforms: (ctx) => {
    const p = ctx.params
    return {
      u_warp_lens_k: clampNum(num(p.k, 0.15), -0.6, 0.6),
      u_warp_lens_center: [
        clampNum(num(p.centerX, 0.5), 0, 1),
        clampNum(num(p.centerY, 0.5), 0, 1),
      ] as [number, number],
    }
  },
}

// ---------------------------------------------------------------------------
// 6. 물결 왜곡 (glitch.wave)
// ---------------------------------------------------------------------------

const GLITCH_WAVE: EffectDef = {
  id: 'glitch.wave',
  label: '물결 왜곡',
  hint: '사인파로 밀어낸다. 파 개수와 주기를 정수로 강제해 공간과 시간 양쪽에서 이음새를 없앤다.',
  stage: 'A',
  cost: 'low',
  preservesAlpha: true,
  params: [
    { key: 'amp', label: '진폭', type: 'number', min: 0, max: 64, step: 0.5, unit: 'px', default: 8 },
    { key: 'waves', label: '파 개수', type: 'number', min: 1, max: 16, step: 1, default: 3 },
    {
      key: 'axis',
      label: '축',
      type: 'select',
      options: [
        { value: '0', label: '가로로 밀기 (세로 방향 파)' },
        { value: '1', label: '세로로 밀기 (가로 방향 파)' },
      ],
      default: 0,
    },
    { key: 'cycles', label: '주기', type: 'number', min: 1, max: 8, step: 1, default: 1 },
    { key: 'hold', label: '홀드 프레임', type: 'number', min: 1, max: 8, step: 1, unit: 'f', default: 1 },
  ],
  glsl: /* glsl */ `
uniform float u_glitch_wave_amp;
uniform float u_glitch_wave_waves;
uniform float u_glitch_wave_axis;
uniform float u_glitch_wave_phase;   // 2PI * cycles * t (CPU 계산)

vec2 warp_glitch_wave(vec2 uv, vec2 texel) {
  bool horiz = u_glitch_wave_axis < 0.5;
  float coord = horiz ? uv.y : uv.x;
  float s = sin(coord * 6.283185307179586 * u_glitch_wave_waves + u_glitch_wave_phase);
  return horiz
    ? vec2(s * u_glitch_wave_amp * texel.x, 0.0)
    : vec2(0.0, s * u_glitch_wave_amp * texel.y);
}
`,
  uniforms: (ctx) => {
    const p = ctx.params
    const hold = intOf(p.hold, 1, 1, 8)
    const t = loopPhase(ctx, hold)
    // 주기가 정수여야 t=0 과 t=1 의 위상이 같다. 소수면 마지막 프레임에서 물결이 튄다.
    const cycles = intOf(p.cycles, 1, 1, 8)
    return {
      u_glitch_wave_amp: clampNum(num(p.amp, 8), 0, 64),
      // 파 개수도 정수로 잡는다. uv 0 과 1 의 값이 같아야 랩 채움에서 경계가 안 보인다.
      u_glitch_wave_waves: intOf(p.waves, 3, 1, 16),
      u_glitch_wave_axis: intOf(p.axis, 0, 0, 1),
      u_glitch_wave_phase: TAU * cycles * t,
    }
  },
}

// ---------------------------------------------------------------------------
// 7. 픽셀화 (fx.pixelate)
// ---------------------------------------------------------------------------

const FX_PIXELATE: EffectDef = {
  id: 'fx.pixelate',
  label: '픽셀화',
  hint: 'UV 를 셀 단위로 양자화한다. A 스테이지 체인의 마지막에 두어야 앞의 워프까지 함께 계단이 진다.',
  stage: 'A',
  cost: 'low',
  preservesAlpha: true,
  params: [
    { key: 'cell', label: '셀 크기', type: 'number', min: 2, max: 128, step: 1, unit: 'px', default: 8 },
    {
      key: 'mode',
      label: '모드',
      type: 'select',
      options: [
        { value: '0', label: '격자' },
        { value: '1', label: '극좌표' },
      ],
      default: 0,
    },
    { key: 'sectors', label: '각도 분할', type: 'number', min: 4, max: 256, step: 1, default: 64 },
    { key: 'centerX', label: '중심 X', type: 'number', min: 0, max: 1, step: 0.01, default: 0.5 },
    { key: 'centerY', label: '중심 Y', type: 'number', min: 0, max: 1, step: 0.01, default: 0.5 },
  ],
  glsl: /* glsl */ `
uniform float u_fx_pixelate_cell;
uniform float u_fx_pixelate_mode;
uniform float u_fx_pixelate_sectors;
uniform vec2  u_fx_pixelate_center;

vec2 warp_fx_pixelate(vec2 uv, vec2 texel) {
  float cell = max(u_fx_pixelate_cell, 1.0);

  if (u_fx_pixelate_mode < 0.5) {
    // 셀 중심으로 스냅한다. floor 만 하면 반 셀씩 왼쪽 위로 밀린다.
    vec2 px = uv / texel;
    vec2 q = (floor(px / cell) + 0.5) * cell;
    return q * texel - uv;
  }

  float aspect = texel.y / texel.x;
  vec2 d = uv - u_fx_pixelate_center;
  d.x *= aspect;
  float r = length(d);
  if (r < 1e-6) return vec2(0.0);          // atan(0,0) 은 정의되지 않는다

  float rq = (floor((r / texel.y) / cell) + 0.5) * cell * texel.y;
  // 내장 함수 step 을 가리지 않도록 이름을 피한다.
  float sect = max(u_fx_pixelate_sectors, 3.0);
  float slice = 6.283185307179586 / sect;
  float aq = (floor(atan(d.y, d.x) / slice) + 0.5) * slice;

  vec2 q = vec2(cos(aq), sin(aq)) * rq;
  q.x /= aspect;
  return (u_fx_pixelate_center + q) - uv;
}
`,
  uniforms: (ctx) => {
    const p = ctx.params
    return {
      u_fx_pixelate_cell: clampNum(num(p.cell, 8), 1, 128),
      u_fx_pixelate_mode: intOf(p.mode, 0, 0, 1),
      u_fx_pixelate_sectors: intOf(p.sectors, 64, 4, 256),
      u_fx_pixelate_center: [
        clampNum(num(p.centerX, 0.5), 0, 1),
        clampNum(num(p.centerY, 0.5), 0, 1),
      ] as [number, number],
    }
  },
}

// ---------------------------------------------------------------------------
// export
// ---------------------------------------------------------------------------

/**
 * A 스테이지 원자 이펙트.
 *
 * 배열 순서가 곧 권장 누산 순서다. 좌표를 통째로 옮기는 것(shake)이 먼저,
 * 국소 워프가 다음, 좌표를 계단으로 만드는 fx.pixelate 가 마지막이다.
 * registry 가 사용자 스택 순서를 존중하더라도 fx.pixelate 만은 마지막으로 밀어야
 * "픽셀 격자가 워프를 따라 흐르는" 결과가 나온다.
 */
export const TRANSFORM_EFFECTS: EffectDef[] = [
  SHAKE_TRANSFORM,
  BOIL_WARP,
  BOIL_EDGE,
  WARP_DISPLACE,
  WARP_LENS,
  GLITCH_WAVE,
  FX_PIXELATE,
]
