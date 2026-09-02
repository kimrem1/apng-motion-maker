/**
 * 파티클 오버레이 렌더 코어.
 *
 * 불변 조건 두 가지가 이 파일 전체를 지배한다.
 * 1) 결정론 — Math.random / Date.now 금지. 모든 난수는 seed 로 고정된 mulberry32 에서
 *    나오고, buildParticles 안의 rnd() 호출 순서가 곧 배치의 정체다.
 *    호출 자리 하나만 밀려도 저장해 둔 문서의 모든 레이아웃이 달라진다.
 * 2) 정수 주기 — t∈[0,1) 를 받는 모든 주기항(loops, cyc, gust 의 sin(TAU*t), caustic 의
 *    n*TAU*t …)은 루프당 정수 사이클이라 render(0)과 render(1⁻)이 이어진다.
 *    비정수 주파수 하나가 이음매를 깨뜨린다.
 */
import { mulberry32 } from '../core/rng'
import type { EffectKey, ParticleSpec } from './types'
import {
  BASE_T,
  BL,
  BOKEH_BASE,
  DUST_BASE,
  FIRE_BASE,
  FLOWER_BASE,
  FOG_BASE,
  PALETTES,
  PETAL_BASE,
  REF,
  RIPPLE_BASE,
  SNOW_BASE,
  SPARKLE_BASE,
  TL,
  normalizeParticleSpec,
} from './config'
import { TAU, clamp, fsin, hexToRgb, num, smoothstep } from './util'
import { SpriteCache, hexPath } from './sprites'

export { BASE_T }

// ---------- 원근 크기 분포 ----------
// u1,u2 ∈ [0,1) 균등난수 → sr ∈ [0,1]  (0 = 가장 작음/멀리, 1 = 가장 큼/가까이)
// dist=0 이면 균등. 올릴수록 작은 쪽에 완만한 봉우리가 서고 큰 쪽 꼬리가 얇아진다.
// 순수 거듭제곱(u^k)은 최솟값에 밀도가 발산해 '똑같이 작은 입자 뭉텅이'가 생기므로 쓰지 않는다.
export function sizeRank(u1: number, u2: number, dist: number): number {
  if (dist <= 0.001) return u1
  const b = 1 + 3 * dist // 1 … 4
  const A = 1 - Math.pow(1 - u1, 1 / b)
  const B = 1 - Math.pow(1 - u2, 1 / b) // Beta(1,b) 두 개
  const h = A > B ? A : B // 둘 중 큰 값 → 작은 쪽 봉우리 + 얇은 큰 꼬리
  return u1 + (h - u1) * dist // 균등 ↔ 원근 블렌드
}

// ---------- 색: 팔레트 × 밝기/색온도 7단계 틴트 테이블 ----------
export type RGB = [number, number, number]

export function resolvePalette(spec: ParticleSpec): RGB[] {
  if (spec.colorMode === 'single') return [hexToRgb(spec.single)]
  const preset = PALETTES[spec.palette]
  const hexes = preset ?? (spec.customPal.length ? spec.customPal : PALETTES['무지개']!)
  return hexes.map(hexToRgb)
}

export function buildTints(
  palette: RGB[],
  colorVar: number,
): { tints: RGB[]; tintCss: string[] } {
  const out: RGB[] = []
  const v = colorVar
  for (const c of palette) {
    for (let k = 0; k < TL; k++) {
      const f = (k / (TL - 1) - 0.5) * 2 // -1 … 1
      const b = 1 + f * 0.30 * v
      const w = f * 26 * v // 밝기 · 색온도(따뜻↔차갑)
      let r = c[0] * b + w
      let g = c[1] * b
      let bl = c[2] * b - w
      // 흰색처럼 밝은 색은 채널별로 잘라내면 전부 순백이 되어 변화가 사라진다.
      // 넘치는 만큼 비례 축소해 색온도 차이를 살린다.
      const mx = Math.max(r, g, bl)
      if (mx > 255) {
        const s = 255 / mx
        r *= s
        g *= s
        bl *= s
      }
      out.push([
        clamp(Math.round(r), 0, 255),
        clamp(Math.round(g), 0, 255),
        clamp(Math.round(bl), 0, 255),
      ])
    }
  }
  return { tints: out, tintCss: out.map(c => c.join(',')) }
}

// ---------- 입자 타입 ----------
export interface BaseP {
  sr: number
  ci: number
  ti: number
  bv: number
}
interface RadP {
  th: number
  r0: number
}
export interface RainP extends BaseP, RadP {
  x: number; op: number; loops: number; phase: number; spanJ: number
  swF: number; swC: number; swP: number
}
export interface SnowP extends BaseP, RadP {
  x0: number; op: number; loops: number; phase: number; spanJ: number
  swayF: number; cyc: number; sphase: number; cyc2: number; sphase2: number
  twCyc: number; twPh: number; spinCyc: number; spin0: number
}
export interface DustP extends BaseP {
  x0: number; y0: number; op: number; axF: number; ayF: number
  fx: number; fy: number; fx2: number; fy2: number
  px: number; py: number; px2: number; py2: number
  ft: number; pt: number; riseP: number; rc: number; spec: number
}
export interface FlareP extends BaseP {
  g: number; shape: number; rot: number; op: number; cyc: number; phase: number
}
export interface SparkleP extends BaseP, RadP {
  x0: number; y0: number; op: number; ft: number; pt: number
  dxF: number; dyF: number; dfx: number; dfy: number; dphx: number; dphy: number
  rot0: number; rotCyc: number; sk: number; rj: number; phase: number; loops: number
}
export interface PetalP extends BaseP, RadP {
  x0: number; op: number; loops: number; phase: number; spanJ: number
  swayF: number; swayCyc: number; sphase: number
  spin0: number; spinCyc: number; flip0: number; flipCyc: number; kind: number
}
export interface FogP extends BaseP {
  x0: number; y0: number; gz: number; op: number
  ax: number; cyc: number; ph: number; ay: number; vcyc: number; vph: number
  pcyc: number; pph: number
}
export interface FireflyP extends BaseP {
  x0: number; y0: number; op: number; ax: number; ay: number
  fx: number; fy: number; fx2: number; fy2: number
  px: number; py: number; px2: number; py2: number; gph: number; gj: number
}
export interface BokehP extends BaseP, RadP {
  x0: number; y0: number; op: number; ax: number; ay: number
  fx: number; fy: number; px: number; py: number
  bcyc: number; bph: number; phase: number; loops: number
}
export interface RippleP extends BaseP {
  gx: number; gz: number; phase: number; cyc: number; jx: number; jy: number; op: number
}
export interface CausticP extends BaseP {
  kx: number; ky: number; n: number; ph: number; amp: number
}
export interface BloomP extends BaseP {
  gx: number; gz: number; phase: number; cyc: number
  rot0: number; rotCyc: number; pj: number; kind: number
  swF: number; swC: number; swP: number; op: number
}
export type Particle =
  | RainP | SnowP | DustP | FlareP | SparkleP | PetalP
  | FogP | FireflyP | BokehP | RippleP | CausticP | BloomP

/** 루프당 반드시 정수 사이클이어야 하는 필드 (이음매 검증용) */
export const CYCLE_FIELDS: Record<EffectKey, string[]> = {
  rain: ['loops', 'swC'],
  snow: ['loops', 'cyc', 'cyc2', 'twCyc', 'spinCyc'],
  dust: ['fx', 'fy', 'fx2', 'fy2', 'ft', 'rc'],
  flare: ['cyc'],
  sparkle: ['ft', 'dfx', 'dfy', 'rotCyc', 'loops'],
  petal: ['loops', 'swayCyc', 'spinCyc', 'flipCyc'],
  fog: ['cyc', 'vcyc', 'pcyc'],
  firefly: ['fx', 'fy', 'fx2', 'fy2', 'gj'],
  bokeh: ['fx', 'fy', 'bcyc', 'loops'],
  ripple: ['cyc'],
  caustic: ['n'],
  bloom: ['cyc', 'rotCyc', 'swC'],
}

// ---------- 입자 정의(시드 고정 · 모든 주기는 정수라 무한 루프 유지) ----------
// rnd() 호출 순서가 곧 파일 포맷이다. 자리를 옮기면 저장된 문서의 배치가 전부 달라진다.
export function buildParticles(spec: ParticleSpec): Particle[] {
  const rnd = mulberry32(
    (((spec.seed | 0) * 2654435761) ^ (spec.effect.length * 2246822519) ^ 0x9e3779b9) | 0,
  )
  const N = Math.max(0, spec.count | 0)
  const plen = resolvePalette(spec).length
  const E = spec.effect
  const SR = (): number => sizeRank(rnd(), rnd(), spec.sizeDist)
  const CI = (): number => (rnd() * plen) | 0
  const TI = (): number => (rnd() * TL) | 0
  const pick = (a: number[]): number => a[(rnd() * a.length) | 0]!
  // toward(정면 낙하) 뷰에서 쓰는 방사 좌표
  const RAD = (): RadP => ({ th: rnd() * TAU, r0: rnd() })
  const P: Particle[] = []

  if (E === 'rain') {
    for (let i = 0; i < N; i++) {
      const sr = SR()
      P.push({
        x: rnd(), op: 0.20 + rnd() * 0.42,
        loops: clamp(2 + Math.round(sr * 2.6 + (rnd() - 0.5) * 1.2), 1, 7),
        phase: rnd(), spanJ: 1 + rnd() * 0.14,
        swF: 0.004 + rnd() * 0.014, swC: pick([2, 3, 3, 4]), swP: rnd() * TAU,
        sr, ci: CI(), ti: TI(), ...RAD(), bv: 0,
      })
    }
  } else if (E === 'snow') {
    for (let i = 0; i < N; i++) {
      const sr = SR()
      P.push({
        x0: rnd(), op: 0.5 + rnd() * 0.5,
        loops: clamp(1 + Math.round(sr * 1.9 + (rnd() - 0.5) * 0.9), 1, 4),
        phase: rnd(), spanJ: 1 + rnd() * 0.12,
        swayF: 0.010 + rnd() * 0.042, cyc: pick([1, 2, 2, 3]), sphase: rnd() * TAU,
        cyc2: pick([2, 3, 3, 4, 5]), sphase2: rnd() * TAU,
        twCyc: pick([0, 0, 0, 1, 1, 2]), twPh: rnd() * TAU,
        spinCyc: pick([1, 1, 2, 2, 3]) * (rnd() < 0.5 ? -1 : 1), spin0: rnd() * TAU,
        sr, ci: CI(), ti: TI(), ...RAD(), bv: 0,
      })
    }
  } else if (E === 'dust') {
    for (let i = 0; i < N; i++) {
      const sr = SR()
      P.push({
        x0: rnd(), y0: rnd(), op: 0.12 + rnd() * 0.36,
        axF: 0.008 + rnd() * 0.05, ayF: 0.008 + rnd() * 0.04,
        fx: pick([1, 1, 2]), fy: pick([1, 2, 2, 3]), fx2: pick([2, 3, 3, 4]), fy2: pick([2, 3, 4, 5]),
        px: rnd() * TAU, py: rnd() * TAU, px2: rnd() * TAU, py2: rnd() * TAU,
        ft: pick([1, 2, 2, 3]), pt: rnd() * TAU, riseP: rnd() * TAU, rc: pick([1, 1, 2]),
        spec: rnd() < 0.18 ? 1 : 0, // 일부만 짧게 빛을 반사
        sr, ci: CI(), ti: TI(), bv: 0,
      })
    }
  } else if (E === 'flare') {
    for (let i = 0; i < N; i++) {
      const rr = rnd()
      const sr = SR()
      P.push({
        g: rnd(), shape: rr < 0.4 ? 0 : rr < 0.82 ? 2 : 1, rot: 0.2 + (rnd() - 0.5) * 0.6,
        op: 0.4 + rnd() * 0.6, cyc: pick([1, 2, 2, 3]), phase: rnd() * TAU,
        sr, ci: CI(), ti: TI(), bv: 0,
      })
    }
  } else if (E === 'sparkle') {
    for (let i = 0; i < N; i++) {
      const sr = SR()
      P.push({
        x0: rnd(), y0: rnd(), op: 0.6 + rnd() * 0.4, ft: pick([1, 2, 2, 3, 3, 4]), pt: rnd() * TAU,
        dxF: 0.003 + rnd() * 0.02, dyF: 0.003 + rnd() * 0.02,
        dfx: pick([1, 1, 2]), dfy: pick([1, 2, 2]),
        dphx: rnd() * TAU, dphy: rnd() * TAU, rot0: rnd() * TAU, rotCyc: pick([0, 0, 1, 1, -1]),
        sk: rnd() < 0.5 ? 0 : 1, rj: pick([0.7, 1, 1.3]), // 갈래 수·보조 갈래 길이 개체차
        phase: rnd(), loops: pick([1, 1, 2]), sr, ci: CI(), ti: TI(), ...RAD(), bv: 0,
      })
    }
  } else if (E === 'petal') {
    for (let i = 0; i < N; i++) {
      const sr = SR()
      P.push({
        x0: rnd(), op: 0.55 + rnd() * 0.45,
        loops: clamp(1 + Math.round(sr * 1.4 + (rnd() - 0.5) * 0.8), 1, 3),
        phase: rnd(), spanJ: 1 + rnd() * 0.12,
        swayF: 0.015 + rnd() * 0.06, swayCyc: pick([1, 2, 2, 3]), sphase: rnd() * TAU,
        spin0: rnd() * TAU, spinCyc: pick([1, 1, 2]) * (rnd() < 0.5 ? -1 : 1),
        flip0: rnd() * TAU, flipCyc: pick([1, 2, 2, 3]) * (rnd() < 0.5 ? -1 : 1),
        kind: rnd() < 0.5 ? 0 : 1, sr, ci: CI(), ti: TI(), ...RAD(), bv: 0,
      })
    }
  } else if (E === 'fog') {
    for (let i = 0; i < N; i++) {
      const sr = SR()
      P.push({
        x0: rnd(), y0: rnd(), gz: rnd(), op: 0.10 + rnd() * 0.22,
        ax: 0.04 + rnd() * 0.14, cyc: pick([1, 1, 2]), ph: rnd() * TAU,
        ay: 0.01 + rnd() * 0.05, vcyc: pick([1, 2]), vph: rnd() * TAU,
        pcyc: pick([1, 2, 2, 3]), pph: rnd() * TAU, sr, ci: CI(), ti: TI(), bv: 0,
      })
    }
  } else if (E === 'firefly') {
    for (let i = 0; i < N; i++) {
      const sr = SR()
      P.push({
        x0: rnd(), y0: rnd(), op: 0.7 + rnd() * 0.3,
        ax: 0.02 + rnd() * 0.10, ay: 0.02 + rnd() * 0.09,
        fx: pick([1, 1, 2]), fy: pick([1, 2, 2]), fx2: pick([2, 3, 3, 4]), fy2: pick([2, 3, 4]),
        px: rnd() * TAU, py: rnd() * TAU, px2: rnd() * TAU, py2: rnd() * TAU,
        gph: rnd(), gj: pick([0, 0, 1]), sr, ci: CI(), ti: TI(), bv: 0,
      })
    }
  } else if (E === 'bokeh') {
    for (let i = 0; i < N; i++) {
      const sr = SR()
      P.push({
        x0: rnd(), y0: rnd(), op: 0.35 + rnd() * 0.55,
        ax: 0.005 + rnd() * 0.05, ay: 0.005 + rnd() * 0.05,
        fx: pick([1, 1, 2]), fy: pick([1, 2, 2]),
        px: rnd() * TAU, py: rnd() * TAU, bcyc: pick([0, 1, 1, 2]), bph: rnd() * TAU,
        phase: rnd(), loops: pick([1, 1, 2]), sr, ci: CI(), ti: TI(), ...RAD(), bv: 0,
      })
    }
  } else if (E === 'ripple') {
    for (let i = 0; i < N; i++) {
      const sr = SR()
      P.push({
        gx: rnd(), gz: rnd(), phase: rnd(), cyc: pick([1, 1, 2, 2, 3]),
        jx: rnd() - 0.5, jy: rnd() - 0.5, op: 0.45 + rnd() * 0.55,
        sr, ci: CI(), ti: TI(), bv: 0,
      })
    }
  } else if (E === 'caustic') {
    // 방향과 파장을 층마다 고르게 흩어 놓는다. 완전 무작위로 뽑으면 몇 층이 같은 쪽으로
    // 쏠려 그물이 아니라 줄무늬가 되고, 파장이 몰리면 결이 한 가지로 단조로워진다.
    for (let i = 0; i < N; i++) {
      const a = ((i + 0.15 + rnd() * 0.70) / N) * Math.PI // 능선 방향은 180° 안에서 균등
      const k = 6 + ((((i * 3) % N) + rnd()) / N) * 22 // 파장은 순서를 섞어 방향과 어긋나게
      P.push({
        kx: Math.cos(a) * k, ky: Math.sin(a) * k, n: pick([1, 1, 2, 2, 3, -1, -2]),
        ph: rnd() * TAU, amp: 0.7 + rnd() * 0.6, sr: rnd(), ci: CI(), ti: TI(), bv: 0,
      })
    }
  } else if (E === 'bloom') {
    for (let i = 0; i < N; i++) {
      const sr = SR()
      P.push({
        gx: rnd(), gz: rnd(), phase: rnd(), cyc: pick([1, 1, 1, 2]),
        rot0: rnd() * TAU,
        // 곱은 항상 1이지만 지우면 안 된다. rnd() 스트림이 한 칸 밀려 배치가 전부 달라진다.
        rotCyc: pick([0, 1, 1, -1]) * (rnd() < 0.5 ? 1 : 1),
        pj: ((rnd() * 3) | 0) - 1, kind: rnd() < 0.5 ? 0 : 1,
        swF: 0.004 + rnd() * 0.014, swC: pick([1, 2, 2, 3]), swP: rnd() * TAU,
        op: 0.7 + rnd() * 0.3, sr, ci: CI(), ti: TI(), bv: 0,
      })
    }
  }
  // 입자별 흐림 제비뽑기. 색 틴트(TL)와 같은 이유로 단계를 끊는다 —
  // 연속값이면 입자마다 다른 스프라이트가 생겨 캐시가 무의미해진다.
  for (const q of P) q.bv = ((rnd() * BL) | 0) / (BL - 1)
  // 먼 것 먼저 → 가까운 것이 위에 겹치도록 정렬(지면 원근 효과는 깊이 gz 기준)
  if (E === 'ripple' || E === 'bloom' || E === 'fog')
    (P as { gz: number }[]).sort((a, b) => a.gz - b.gz)
  else if (E !== 'caustic') P.sort((a, b) => a.sr - b.sr)
  return P
}

// ---------- 시점(원근) 변환 ----------
interface TowardOut {
  x: number
  y: number
  g: number
  f: number
  hz: number
}
// toward: u 0(소실점=멀리) → 1(카메라 통과). 등속 접근의 원근 투영 = 지수 성장.
// 소실점 부근은 지수 곡선 탓에 입자가 한 점에 뭉친다. K.hole > 0 이면 그 둘레를
// 부드럽게 지우고(f), 지운 자리 바깥까지 초점이 덜 맞은 듯 번지게(hz) 한다.
function towardAt(p: RadP, u: number, K: FrameK): TowardOut {
  const k = 2.4 + 5.2 * K.persp
  const g = Math.exp(k * (u - 1))
  const rad = K.diag * 0.82 * g * (0.40 + 0.60 * p.r0)
  const o: TowardOut = { x: K.vx + Math.cos(p.th) * rad, y: K.vy + Math.sin(p.th) * rad, g, f: 1, hz: 0 }
  if (K.hole > 0) {
    const R = K.hole * K.diag * 0.15 // 비워둘 반지름
    o.f = smoothstep(R * 0.28, R, rad) // 안쪽은 완전히 비고 가장자리에서 살아난다
    // 구멍 밖까지 번져 초점이 서서히 맞는다. 단계를 끊어 스프라이트를 나눠 쓰게 한다.
    o.hz = Math.round((1 - smoothstep(R * 0.5, R * 2.6, rad)) * 4) / 4
  }
  return o
}
// ground: gz 0(지평선) → 1(화면 앞). s = 화면상 축척.
// 가로는 vx를 중심으로 펼친다 — 0.5면 화면 한가운데다.
function groundAt(gx: number, gz: number, K: FrameK): { x: number; y: number; s: number } {
  const hy = K.vy
  const gp = 0.35 + 2.2 * K.persp
  const s = Math.pow(clamp(gz, 0, 1), gp)
  return { x: K.vx + (gx - 0.5) * K.W, y: hy + (K.H - hy) * s, s: 0.05 + 0.95 * s }
}
// 가로로 순환하는 입자를 화면 경계에서 두 번 그려 끊김 방지
function wrapDraw(
  ctx: CanvasRenderingContext2D,
  spr: HTMLCanvasElement,
  x: number,
  y: number,
  W: number,
  dw?: number,
  dh?: number,
): void {
  const w = dw || spr.width
  const h = dh || spr.height
  const hx = Math.max(w, h) / 2 + 1
  ctx.drawImage(spr, x - w / 2, y - h / 2, w, h)
  if (x < hx) ctx.drawImage(spr, x + W - w / 2, y - h / 2, w, h)
  else if (x > W - hx) ctx.drawImage(spr, x - W - w / 2, y - h / 2, w, h)
}

// ---------- 프레임 컨텍스트 ----------
interface FrameK {
  W: number
  H: number
  t: number
  scale: number
  om: number
  lo: number
  hi: number
  ds: number
  view: string
  vx: number
  vy: number
  persp: number
  tilt: number
  diag: number
  hole: number
  dim: (sr: number) => number
  gustX: (sr: number) => number
  col: (p: BaseP) => string
  blurF: (p: BaseP) => number
  blurPx: (p: BaseP, px: number) => number
  haze: (hz: number, px: number) => number
}

interface CausticBuf {
  buf: HTMLCanvasElement | null
  g: CanvasRenderingContext2D | null
  img: ImageData | null
  w: number
  h: number
}

interface Env {
  S: ParticleSpec
  P: Particle[]
  tints: RGB[]
  tintCss: string[]
  sp: SpriteCache
  caus: CausticBuf
  K: FrameK
}

type Renderer = (ctx: CanvasRenderingContext2D, env: Env) => void

// ---------- 효과별 렌더러 ----------
const RENDER: Record<EffectKey, Renderer> = {
  rain(ctx, env) {
    const { S, sp, K } = env
    const P = env.P as RainP[]
    const { W, H, scale, om, lo, hi, ds, t } = K
    const len = S.ex1
    const drop = S.shape === 'drop'
    if (K.view === 'toward') {
      // 누워서 천장 보기 — 방사형으로 쏟아짐
      for (const p of P) {
        const u = (((p.phase + p.loops * t) % 1) + 1) % 1
        const q = towardAt(p, u, K)
        const m = lo + p.sr * ds
        // 알파를 먼저 보고 버린다 — 중심을 비우면 상당수가 안 보이는데 스프라이트까지 만들면 헛일
        const a = p.op * om * smoothstep(0, 0.10, u) * (1 - smoothstep(0.90, 1, u)) * K.dim(p.sr) * q.f
        if (a < 0.004) continue
        const wpx = clamp(2.6 * scale * m * (0.12 + 3.6 * q.g), 0.75, 70)
        const lpx = Math.max(wpx * (drop ? 1.6 : 2.4), len * H * m * (0.15 + 4.2 * q.g))
        const bl = S.bokeh * smoothstep(0.55, 1, q.g) * wpx * 0.9 + K.haze(q.hz, wpx) + K.blurPx(p, wpx)
        const spr = sp.streak(wpx, lpx, K.col(p), bl)
        ctx.globalAlpha = clamp(a, 0, 1)
        ctx.save()
        ctx.translate(q.x, q.y)
        ctx.rotate(p.th - Math.PI / 2)
        ctx.drawImage(spr, -spr.width / 2, -spr.height / 2)
        ctx.restore()
      }
      return
    }
    const th = (S.angle * Math.PI) / 180
    const margin = len * H * hi + 10
    const span0 = H + 2 * margin
    const driftPx = span0 * Math.tan(th)
    const rot = -th
    const sinA = Math.abs(Math.sin(th))
    const cosA = Math.abs(Math.cos(th))
    for (const p of P) {
      const m = lo + p.sr * ds
      const wpx = clamp(2.1 * scale * m, 0.75, 44)
      let lpx = len * H * m
      if (drop) lpx = Math.max(wpx * 1.8, lpx * 0.30)
      const bl = S.bokeh * smoothstep(0.70, 1, p.sr) * wpx * 0.85 + K.blurPx(p, wpx)
      const spr = sp.streak(wpx, lpx, K.col(p), bl)
      const prog = (((p.phase + p.loops * t) % 1) + 1) % 1
      const yc = prog * span0 * p.spanJ - margin
      const sw = S.variation * p.swF * W * Math.sin(TAU * p.swC * t + p.swP)
      const xc = (((p.x * W + prog * driftPx + sw + K.gustX(p.sr)) % W) + W) % W
      const hx = (spr.height * sinA + spr.width * cosA) / 2 + 1
      ctx.globalAlpha = clamp(p.op * om * K.dim(p.sr), 0, 1)
      const put = (xx: number): void => {
        ctx.save()
        ctx.translate(xx, yc)
        ctx.rotate(rot)
        ctx.drawImage(spr, -spr.width / 2, -spr.height / 2)
        ctx.restore()
      }
      put(xc)
      if (xc < hx) put(xc + W)
      else if (xc > W - hx) put(xc - W)
    }
  },

  snow(ctx, env) {
    const { S, sp, K } = env
    const P = env.P as SnowP[]
    const { W, H, t, scale, om, lo, hi, ds } = K
    const tum = S.ex1
    const shp = S.shape
    const bth = 1 - 0.5 * S.bokeh
    if (K.view === 'toward') {
      for (const p of P) {
        const u = (((p.phase + p.loops * t) % 1) + 1) % 1
        const q = towardAt(p, u, K)
        const m = lo + p.sr * ds
        const a = p.op * om * smoothstep(0, 0.10, u) * (1 - smoothstep(0.90, 1, u)) * K.dim(p.sr) * q.f
        if (a < 0.004) continue // 스프라이트를 만들기 전에 버린다
        const px = Math.max(0.3, SNOW_BASE * scale * m * (0.15 + 5.5 * q.g))
        const bk = S.bokeh * smoothstep(0.35, 1, q.g)
        const spr = sp.disc(px, clamp(S.soft, 0, 1), K.col(p), px * 0.7 * bk + K.haze(q.hz, px) + K.blurPx(p, px), shp, bk * 0.5)
        ctx.globalAlpha = clamp(a, 0, 1)
        ctx.drawImage(spr, q.x - spr.width / 2, q.y - spr.height / 2)
      }
      return
    }
    const margin = SNOW_BASE * scale * hi * 2.2 + 8
    const span0 = H + 2 * margin
    const th = (S.angle * Math.PI) / 180
    const driftPx = span0 * Math.tan(th)
    for (const p of P) {
      const m = lo + p.sr * ds
      const px = SNOW_BASE * scale * m
      const bk = S.bokeh > 0 ? smoothstep(bth, 1, p.sr) : 0
      // 먼(작은) 눈은 더 무르게 — 깊이감의 반은 이 소프트 가감에서 온다
      const soft = clamp(S.soft * (1 - 0.4 * p.sr) + 0.22 * (1 - p.sr), 0, 1)
      const spr = sp.disc(px, soft, K.col(p), px * 0.70 * S.bokeh * bk + K.blurPx(p, px), shp, bk * S.bokeh * (shp === 'hex' ? 0.6 : 0.42))
      const flut = 1 + (1 - p.sr) * 0.9
      const sway = S.variation * flut * W * (p.swayF * Math.sin(TAU * p.cyc * t + p.sphase) + p.swayF * 0.42 * Math.sin(TAU * p.cyc2 * t + p.sphase2))
      const prog = (((p.phase + p.loops * t) % 1) + 1) % 1
      const yc = prog * span0 * p.spanJ - margin
      const xc = (((p.x0 * W + sway + prog * driftPx + K.gustX(p.sr)) % W) + W) % W
      const tw = p.twCyc ? 0.82 + 0.18 * Math.sin(TAU * p.twCyc * t + p.twPh) : 1
      ctx.globalAlpha = clamp(p.op * om * tw * K.dim(p.sr), 0, 1)
      const sx = tum > 0 ? 1 - tum * 0.55 * (1 - Math.abs(Math.cos(TAU * p.spinCyc * t + p.spin0))) : 1
      wrapDraw(ctx, spr, xc, yc, W, spr.width * sx, spr.height)
    }
  },

  dust(ctx, env) {
    const { S, sp, K } = env
    const P = env.P as DustP[]
    const { W, H, t, scale, om, lo, ds } = K
    const soft = clamp(0.35 + 0.65 * S.soft, 0, 1)
    const glow = S.ex2
    for (const p of P) {
      const m = lo + p.sr * ds
      const px = DUST_BASE * scale * m
      const col = K.col(p)
      const s = 0.5 + 0.5 * Math.sin(TAU * p.ft * t + p.pt)
      const tw = 0.26 + 0.74 * Math.pow(s, 2.4) // 대체로 옅다가 짧게 빛을 문다
      const blur = S.bokeh * smoothstep(0.72, 1, p.sr) * px * 0.8 + K.blurPx(p, px)
      const spr = sp.dust(px, col, glow * (0.30 + 0.70 * p.sr), soft, blur)
      const v = S.variation * (1 + (1 - p.sr) * 0.8)
      const x = p.x0 * W + v * W * (p.axF * Math.sin(TAU * p.fx * t + p.px) + p.axF * 0.38 * Math.sin(TAU * p.fx2 * t + p.px2))
      const y = p.y0 * H + v * H * (p.ayF * Math.sin(TAU * p.fy * t + p.py) + p.ayF * 0.34 * Math.sin(TAU * p.fy2 * t + p.py2))
        + S.ex1 * 0.20 * H * Math.sin(TAU * p.rc * t + p.riseP)
      const a = clamp(p.op * om * tw * K.dim(p.sr), 0, 1)
      ctx.globalAlpha = a
      ctx.drawImage(spr, x - spr.width / 2, y - spr.height / 2)
      if (p.spec) {
        // 반사한 알갱이의 작은 십자 섬광
        const f = Math.pow(s, 9)
        if (f > 0.02) {
          const spx = Math.max(4, Math.round(px * 4.2))
          const st = sp.sparkle(spx, col, 4, 0.65, 0.28, K.blurPx(p, spx))
          ctx.globalAlpha = clamp(a * f * 1.6, 0, 1)
          ctx.drawImage(st, x - st.width / 2, y - st.height / 2)
        }
      }
    }
  },

  flare(ctx, env) {
    const { S, K } = env
    const P = env.P as FlareP[]
    const { W, H, t, om, lo, hi, ds, diag } = K
    const C = env.tintCss
    const C0 = C[TL >> 1] || C[0] || '255,255,255' // 틴트 사다리의 가운데 = 고른 색 그대로
    const cx = W / 2
    const cy = H / 2
    const ph = (S.angle * Math.PI) / 180
    const sw = 0.045 * Math.min(W, H)
    const sx = W * (0.5 + 0.5 * Math.sin(ph)) + sw * Math.sin(TAU * t)
    const sy = H * (0.5 - 0.5 * Math.cos(ph)) + sw * 0.5 * Math.cos(TAU * t)
    const ax = cx - sx
    const ay = cy - sy
    const ss = (lo + hi) / 2
    const gp = 0.75 + 0.25 * Math.sin(TAU * t)
    ctx.globalAlpha = 1
    let g = ctx.createRadialGradient(sx, sy, 0, sx, sy, Math.max(6, diag * 0.34 * ss)) // 글로우
    g.addColorStop(0, 'rgba(' + C0 + ',' + clamp(0.45 * om * gp, 0, 1) + ')')
    g.addColorStop(0.3, 'rgba(' + C0 + ',' + clamp(0.15 * om * gp, 0, 1) + ')')
    g.addColorStop(1, 'rgba(' + C0 + ',0)')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, W, H)
    const coreR = Math.max(3, diag * 0.05 * ss) // 코어
    g = ctx.createRadialGradient(sx, sy, 0, sx, sy, coreR)
    g.addColorStop(0, 'rgba(255,255,255,' + clamp(0.95 * om * gp, 0, 1) + ')')
    g.addColorStop(0.45, 'rgba(' + C0 + ',' + clamp(0.6 * om * gp, 0, 1) + ')')
    g.addColorStop(1, 'rgba(' + C0 + ',0)')
    ctx.fillStyle = g
    ctx.beginPath()
    ctx.arc(sx, sy, coreR, 0, TAU)
    ctx.fill()
    if (S.ex1 > 0) {
      // 스타버스트
      ctx.save()
      ctx.translate(sx, sy)
      ctx.rotate(0.05 * Math.sin(TAU * t))
      const spikes = 12
      const sl = diag * 0.17 * ss * S.ex1 * (0.85 + 0.15 * Math.sin(TAU * 2 * t))
      const w2 = Math.max(1, coreR * 0.16)
      for (let i = 0; i < spikes; i++) {
        ctx.rotate(TAU / spikes)
        const L = sl * (i % 2 ? 0.5 : 1)
        const lg = ctx.createLinearGradient(0, 0, L, 0)
        lg.addColorStop(0, 'rgba(' + C0 + ',' + clamp(0.45 * om * gp, 0, 1) + ')')
        lg.addColorStop(1, 'rgba(' + C0 + ',0)')
        ctx.fillStyle = lg
        ctx.beginPath()
        ctx.moveTo(0, -w2)
        ctx.lineTo(0, w2)
        ctx.lineTo(L, 0)
        ctx.closePath()
        ctx.fill()
      }
      ctx.restore()
    }
    if (S.ex2 > 0) {
      // 애너모픽 가로 스트릭
      const hl = diag * 0.42 * ss * S.ex2
      const sh = Math.max(1, coreR * 0.09)
      const lg = ctx.createLinearGradient(sx - hl, 0, sx + hl, 0)
      lg.addColorStop(0, 'rgba(' + C0 + ',0)')
      lg.addColorStop(0.5, 'rgba(' + (C[Math.min(C.length - 1, TL)] || C0) + ',' + clamp(0.26 * om * gp * S.ex2, 0, 1) + ')')
      lg.addColorStop(1, 'rgba(' + C0 + ',0)')
      ctx.fillStyle = lg
      ctx.fillRect(sx - hl, sy - sh, hl * 2, sh * 2)
    }
    for (const p of P) {
      // 고스트
      const u = -0.3 + p.g * (2.0 * S.variation)
      const gx = sx + ax * u
      const gy = sy + ay * u
      const m = lo + p.sr * ds
      const r = Math.max(2, diag * 0.045 * m)
      const pulse = 0.7 + 0.3 * Math.sin(TAU * p.cyc * t + p.phase)
      const op = clamp(p.op * om * 0.38 * pulse * K.dim(p.sr), 0, 1)
      if (op < 0.01) continue
      const col = K.col(p)
      const gb = K.blurPx(p, r) // 고스트마다 다른 아웃포커스
      if (gb > 0.4) ctx.filter = 'blur(' + gb.toFixed(2) + 'px)'
      if (p.shape === 0) {
        const cg = ctx.createRadialGradient(gx, gy, 0, gx, gy, r)
        cg.addColorStop(0, 'rgba(' + col + ',' + op + ')')
        cg.addColorStop(0.7, 'rgba(' + col + ',' + op * 0.45 + ')')
        cg.addColorStop(1, 'rgba(' + col + ',0)')
        ctx.fillStyle = cg
        ctx.beginPath()
        ctx.arc(gx, gy, r, 0, TAU)
        ctx.fill()
      } else if (p.shape === 1) {
        // 링 + 색수차
        ctx.lineWidth = Math.max(1, r * 0.10)
        ctx.strokeStyle = 'rgba(' + col + ',' + op + ')'
        ctx.beginPath()
        ctx.arc(gx, gy, r * 0.85, 0, TAU)
        ctx.stroke()
        const c2 = C[(p.ci * TL + ((p.ti + 3) % TL)) % C.length] || col
        ctx.strokeStyle = 'rgba(' + c2 + ',' + op * 0.45 + ')'
        ctx.beginPath()
        ctx.arc(gx, gy, r * 0.92, 0, TAU)
        ctx.stroke()
      } else {
        const rot = p.rot + 0.12 * Math.sin(TAU * t)
        ctx.save()
        ctx.translate(gx, gy)
        ctx.rotate(rot)
        hexPath(ctx, 0, 0, r, 0)
        ctx.fillStyle = 'rgba(' + col + ',' + op * 0.42 + ')'
        ctx.fill()
        ctx.strokeStyle = 'rgba(' + col + ',' + op + ')'
        ctx.lineWidth = Math.max(1, r * 0.08)
        ctx.stroke()
        ctx.restore()
      }
      if (gb > 0.4) ctx.filter = 'none'
    }
  },

  sparkle(ctx, env) {
    const { S, sp, K } = env
    const P = env.P as SparkleP[]
    const { W, H, t, scale, om, lo, ds } = K
    const sharp = S.ex1
    const ratio = S.ex2
    const mix = S.shape === 'mix'
    const six = S.shape === '6'
    const toward = K.view === 'toward'
    for (const p of P) {
      // 짧게 번쩍 → 서서히 사그라듦. 좌우대칭 사인보다 훨씬 별처럼 보인다.
      const u = (((p.pt / TAU + p.ft * t) % 1) + 1) % 1
      const tw = u < 0.28 ? Math.pow(u / 0.28, 1.5) : Math.pow(1 - (u - 0.28) / 0.72, sharp)
      if (tw < 0.015) continue
      const spikes = mix ? (p.sk ? 6 : 4) : six ? 6 : 4
      const m = lo + p.sr * ds
      let x: number
      let y: number
      let gsc = 1
      let fade = 1
      let hz = 0
      if (toward) {
        const u2 = (((p.phase + p.loops * t) % 1) + 1) % 1
        const q = towardAt(p, u2, K)
        x = q.x
        y = q.y
        gsc = 0.12 + 5.0 * q.g
        hz = q.hz
        fade = smoothstep(0, 0.10, u2) * (1 - smoothstep(0.90, 1, u2)) * q.f
      } else {
        x = p.x0 * W + p.dxF * W * S.variation * Math.sin(TAU * p.dfx * t + p.dphx)
        y = p.y0 * H + p.dyF * H * S.variation * Math.sin(TAU * p.dfy * t + p.dphy)
      }
      const al = p.op * om * tw * fade * K.dim(p.sr)
      if (al < 0.004) continue // 스프라이트를 만들기 전에 버린다
      const rpx = Math.max(3, Math.round(SPARKLE_BASE * scale * m * (toward ? clamp(gsc, 0.05, 6) : 1)))
      const spr = sp.sparkle(rpx, K.col(p), spikes, S.soft, ratio * p.rj, K.haze(hz, rpx * 0.5) + K.blurPx(p, rpx * 0.5))
      ctx.globalAlpha = clamp(al, 0, 1)
      ctx.save()
      ctx.translate(x, y)
      ctx.rotate(p.rot0 + TAU * p.rotCyc * t)
      const sc = 0.25 + 0.75 * tw
      ctx.scale(sc, sc)
      ctx.drawImage(spr, -spr.width / 2, -spr.height / 2)
      ctx.restore()
    }
  },

  petal(ctx, env) {
    const { S, sp, K } = env
    const P = env.P as PetalP[]
    const { W, H, t, scale, om, lo, hi, ds } = K
    const flip = S.ex1
    const kindOf = (p: PetalP): string => (S.shape === 'mix' ? (p.kind ? 'leaf' : 'petal') : S.shape)
    if (K.view === 'toward') {
      for (const p of P) {
        const u = (((p.phase + p.loops * t) % 1) + 1) % 1
        const q = towardAt(p, u, K)
        const m = lo + p.sr * ds
        const a = p.op * om * smoothstep(0, 0.10, u) * (1 - smoothstep(0.90, 1, u)) * K.dim(p.sr) * q.f
        if (a < 0.004) continue // 스프라이트를 만들기 전에 버린다
        const px = Math.max(2, Math.round(PETAL_BASE * scale * m * (0.12 + 4.6 * q.g)))
        const spr = sp.petal(px, S.bokeh * smoothstep(0.65, 1, q.g) * px * 0.45 + K.haze(q.hz, px) + K.blurPx(p, px), K.col(p), kindOf(p))
        const spin = p.spin0 + TAU * p.spinCyc * t
        const fl = Math.abs(Math.cos(p.flip0 + TAU * p.flipCyc * t)) // 1=정면, 0=측면
        const sx = flip > 0 ? clamp(1 - flip * 0.88 * (1 - fl), 0.08, 1) : 1
        ctx.globalAlpha = clamp(a * (flip > 0 ? 1 + 0.5 * flip * Math.pow(1 - fl, 3) : 1), 0, 1)
        ctx.save()
        ctx.translate(q.x, q.y)
        ctx.rotate(spin)
        ctx.drawImage(spr, (-spr.width * sx) / 2, -spr.height / 2, spr.width * sx, spr.height)
        ctx.restore()
      }
      return
    }
    const margin = PETAL_BASE * scale * hi + 0.03 * H
    const span0 = H + 2 * margin
    const th = (S.angle * Math.PI) / 180
    const driftPx = span0 * Math.tan(th)
    for (const p of P) {
      const m = lo + p.sr * ds
      const px = Math.max(2, Math.round(PETAL_BASE * scale * m))
      const spr = sp.petal(px, S.bokeh * smoothstep(0.74, 1, p.sr) * px * 0.45 + K.blurPx(p, px), K.col(p), kindOf(p))
      const prog = (((p.phase + p.loops * t) % 1) + 1) % 1
      const yc = prog * span0 * p.spanJ - margin
      const sway = p.swayF * W * S.variation * Math.sin(TAU * p.swayCyc * t + p.sphase)
      const xc = (((p.x0 * W + prog * driftPx + sway + K.gustX(p.sr)) % W) + W) % W
      const spin = p.spin0 + TAU * p.spinCyc * t
      const fl = Math.abs(Math.cos(p.flip0 + TAU * p.flipCyc * t)) // 1=정면, 0=측면
      const sx = flip > 0 ? clamp(1 - flip * 0.88 * (1 - fl), 0.08, 1) : 1
      // 측면을 스칠 때 빛을 받아 살짝 반짝 — 뒤집힘이 납작한 종잇조각처럼 보이지 않게 한다
      const spec = flip > 0 ? 1 + 0.5 * flip * Math.pow(1 - fl, 3) : 1
      ctx.globalAlpha = clamp(p.op * om * (0.55 + 0.45 * p.sr) * K.dim(p.sr) * spec, 0, 1)
      const w = spr.width * sx
      const h = spr.height
      const hx = Math.max(spr.width, h) / 2 + 1
      const put = (xx: number): void => {
        ctx.save()
        ctx.translate(xx, yc)
        ctx.rotate(spin)
        ctx.drawImage(spr, -w / 2, -h / 2, w, h)
        ctx.restore()
      }
      put(xc)
      if (xc < hx) put(xc + W)
      else if (xc > W - hx) put(xc - W)
    }
  },

  fog(ctx, env) {
    const { S, sp, K } = env
    const P = env.P as FogP[]
    const { W, H, t, scale, om, lo, ds } = K
    const band = clamp(S.ex1, 0.05, 1)
    const th = (S.angle * Math.PI) / 180
    const ca = Math.cos(th)
    const sa = Math.sin(th)
    const ground = K.view === 'ground'
    for (const p of P) {
      const m = lo + p.sr * ds
      const dr = p.ax * Math.sin(TAU * p.cyc * t + p.ph)
      let cx: number
      let cy: number
      let scl = 1
      if (ground) {
        const g = groundAt(p.x0, p.gz, K)
        cx = g.x
        cy = g.y
        scl = g.s
      } else {
        cx = p.x0 * W
        cy = H * (1 - band) + p.y0 * H * band
      }
      cx += dr * W * ca * 1.3 + K.gustX(p.sr)
      cy += dr * H * sa * 0.5 + p.ay * H * S.variation * Math.sin(TAU * p.vcyc * t + p.vph)
      const px = Math.max(2, FOG_BASE * scale * m * scl * (1 + 0.14 * Math.sin(TAU * p.pcyc * t + p.pph)))
      const spr = sp.disc(px, 1, K.col(p), K.blurPx(p, px), 'round', 0)
      ctx.globalAlpha = clamp(p.op * om * K.dim(p.sr) * (ground ? 0.35 + 0.65 * scl : 1), 0, 1)
      ctx.drawImage(spr, cx - spr.width / 2, cy - spr.height / 2)
    }
  },

  firefly(ctx, env) {
    const { S, sp, K } = env
    const P = env.P as FireflyP[]
    const { W, H, t, scale, om, lo, ds } = K
    const trail = S.ex1
    const gc = Math.max(1, Math.round(S.ex2))
    const at = (p: FireflyP, tt: number): { x: number; y: number } => ({
      x: p.x0 * W + S.variation * W * (p.ax * Math.sin(TAU * p.fx * tt + p.px) + p.ax * 0.40 * Math.sin(TAU * p.fx2 * tt + p.px2)),
      y: p.y0 * H + S.variation * H * (p.ay * Math.sin(TAU * p.fy * tt + p.py) + p.ay * 0.40 * Math.sin(TAU * p.fy2 * tt + p.py2)),
    })
    for (const p of P) {
      const u = (((p.gph + (gc + p.gj) * t) % 1) + 1) % 1
      const gl = u < 0.68 ? Math.pow(u / 0.68, 1.7) : Math.pow(1 - (u - 0.68) / 0.32, 2.4)
      if (gl < 0.012) continue
      const m = lo + p.sr * ds
      const px = Math.max(0.6, FIRE_BASE * scale * m)
      const col = K.col(p)
      const glow = sp.disc(px * 3.2, 1, col, px * 0.6 * S.bokeh + K.blurPx(p, px * 3.2), 'round', 0)
      const core = sp.disc(Math.max(0.4, px * 0.85), 0.25, col, K.blurPx(p, px * 0.85), 'round', 0)
      const base = clamp(p.op * om * K.dim(p.sr), 0, 1)
      if (trail > 0)
        for (let k = 3; k >= 1; k--) {
          const q = at(p, t - k * 0.015)
          ctx.globalAlpha = clamp((base * gl * trail * 0.18) / k, 0, 1)
          ctx.drawImage(glow, q.x - glow.width / 2, q.y - glow.height / 2)
        }
      const q = at(p, t)
      ctx.globalAlpha = clamp(base * gl * 0.75, 0, 1)
      ctx.drawImage(glow, q.x - glow.width / 2, q.y - glow.height / 2)
      ctx.globalAlpha = clamp(base * gl, 0, 1)
      ctx.drawImage(core, q.x - core.width / 2, q.y - core.height / 2)
    }
  },

  bokeh(ctx, env) {
    const { S, sp, K } = env
    const P = env.P as BokehP[]
    const { W, H, t, scale, om, lo, ds } = K
    const rim = S.ex1
    const shp = S.shape
    const toward = K.view === 'toward'
    for (const p of P) {
      const m = lo + p.sr * ds
      let x: number
      let y: number
      let gsc = 1
      let fade = 1
      let hz = 0
      if (toward) {
        const u = (((p.phase + p.loops * t) % 1) + 1) % 1
        const q = towardAt(p, u, K)
        x = q.x
        y = q.y
        gsc = clamp(0.10 + 5.2 * q.g, 0.04, 7)
        hz = q.hz
        fade = smoothstep(0, 0.10, u) * (1 - smoothstep(0.90, 1, u)) * q.f
      } else {
        x = p.x0 * W + S.variation * p.ax * W * Math.sin(TAU * p.fx * t + p.px) + K.gustX(p.sr)
        y = p.y0 * H + S.variation * p.ay * H * Math.sin(TAU * p.fy * t + p.py)
      }
      const br = p.bcyc ? 0.70 + 0.30 * Math.sin(TAU * p.bcyc * t + p.bph) : 1
      const al = p.op * om * br * fade * K.dim(p.sr)
      if (al < 0.004) continue // 스프라이트를 만들기 전에 버린다
      const px = Math.max(0.6, BOKEH_BASE * scale * m * gsc)
      const spr = sp.disc(px, clamp(0.08 + 0.50 * S.soft, 0, 1), K.col(p), px * (0.06 + 0.45 * S.bokeh) + K.haze(hz, px) + K.blurPx(p, px), shp, rim)
      ctx.globalAlpha = clamp(al, 0, 1)
      ctx.drawImage(spr, x - spr.width / 2, y - spr.height / 2)
    }
  },

  ripple(ctx, env) {
    const { S, K } = env
    const P = env.P as RippleP[]
    const { W, H, t, scale, om, lo, ds } = K
    const rings = clamp(Math.round(S.ex1), 1, 5)
    const ez = S.ex2
    const ground = K.view === 'ground'
    const sq = ground ? clamp(K.tilt, 0.05, 1) : 1
    for (const p of P) {
      const u = (((p.phase + p.cyc * t) % 1) + 1) % 1
      const m = lo + p.sr * ds
      let cx: number
      let cy: number
      let scl = 1
      if (ground) {
        const g = groundAt(p.gx, p.gz, K)
        cx = g.x
        cy = g.y
        scl = g.s
      } else {
        cx = p.gx * W
        cy = p.gz * H
      }
      cx += S.variation * p.jx * 0.02 * W
      cy += S.variation * p.jy * 0.02 * H
      const Rmax = RIPPLE_BASE * scale * m * scl
      const col = K.col(p)
      const baseA = p.op * om * smoothstep(0, 0.05, u) * K.dim(p.sr) * (ground ? 0.4 + 0.6 * scl : 1)
      if (baseA < 0.004) continue
      const rb = K.blurPx(p, Rmax * 0.45) // 물결마다 다른 아웃포커스
      if (rb > 0.4) ctx.filter = 'blur(' + rb.toFixed(2) + 'px)'
      if (u < 0.16 && S.variation > 0) {
        // 떨어진 자리의 튐
        const spl = 1 - u / 0.16
        const r = Rmax * 0.10 * (1 + spl)
        ctx.globalAlpha = clamp(baseA * spl * 0.8 * S.variation, 0, 1)
        ctx.fillStyle = 'rgba(' + col + ',1)'
        ctx.beginPath()
        ctx.ellipse(cx, cy, r, r * sq, 0, 0, TAU)
        ctx.fill()
      }
      ctx.strokeStyle = 'rgba(' + col + ',1)'
      for (let k = 0; k < rings; k++) {
        const off = k * 0.10
        if (off >= 0.98) break
        const uk = (u - off) / (1 - off)
        if (uk <= 0) continue // 링마다 수명을 정규화 → u=1에서 모두 소멸
        const rr = Rmax * (1 - Math.pow(1 - uk, ez))
        if (rr < 0.6) continue
        const a = baseA * Math.pow(1 - uk, 1.5) * (1 - k * 0.22)
        if (a < 0.005) continue
        ctx.globalAlpha = clamp(a, 0, 1)
        ctx.lineWidth = Math.max(0.8, Rmax * 0.075 * (1 - uk * 0.5) * (1 + k * 0.25))
        ctx.beginPath()
        ctx.ellipse(cx, cy, rr, rr * sq, 0, 0, TAU)
        ctx.stroke()
      }
      if (rb > 0.4) ctx.filter = 'none'
    }
  },

  // 물그물(코스틱): 사인파 간섭의 능선을 저해상도 버퍼에 그려 확대 — 픽셀 단위라 fsin(룩업) 사용
  caustic(ctx, env) {
    const { S, K, caus } = env
    const L = env.P as CausticP[]
    const { W, H, t, om } = K
    // 버퍼가 거칠면 잔무늬가 통째로 뭉개진다 — 긴 변 360px 안팎을 목표로 잡는다
    const step = clamp(Math.round(Math.max(W, H) / 360), 1, 8)
    const w = Math.max(8, Math.ceil(W / step))
    const h = Math.max(8, Math.ceil(H / step))
    if (!caus.buf || caus.w !== w || caus.h !== h) {
      caus.buf = document.createElement('canvas')
      caus.buf.width = w
      caus.buf.height = h
      caus.g = caus.buf.getContext('2d')
      caus.img = caus.g!.createImageData(w, h)
      caus.w = w
      caus.h = h
    }
    const d = caus.img!.data
    const n = Math.max(1, L.length)
    const ground = K.view === 'ground'
    const dist = S.variation
    const th = (S.angle * Math.PI) / 180
    const ca = Math.cos(th)
    const sa = Math.sin(th)
    // 능선의 밝기 곡선. 넓은 띠(v³) 위에 얇고 밝은 심(v⁶)을 얹어야 물 밑 그물처럼 보인다.
    const causRidge = (v: number): number => {
      const v3 = v * v * v
      return v3 * 0.70 + v3 * v3 * 0.44
    }
    // 틴트 사다리의 가운데가 고른 색 그대로다. 끝을 집으면 색 흔들림이 무늬 전체를 물들인다.
    const c0 = env.tints[TL >> 1] || env.tints[0] || [255, 255, 255]
    const CR = c0[0]
    const CG = c0[1]
    const CB = c0[2]
    const T1 = TAU * t

    if (ground) {
      const dens = S.ex1
      const thick = Math.max(0.05, S.ex2) * n * 0.55
      const hy = clamp(S.viewY, 0, 0.96)
      const vcx = clamp(S.viewX, 0, 1)
      const gp = 0.35 + 2.2 * K.persp
      // 지평선 근처는 무늬 주기가 픽셀보다 촘촘해져 세로 줄무늬(에일리어싱)가 생긴다.
      // 화면상 주파수를 구해 나이키스트를 넘는 만큼 진폭을 줄이면 자연스럽게 뭉개진다.
      let kmax = 0
      for (const q of L) {
        const kk = Math.hypot(q.kx, q.ky) * dens
        if (kk > kmax) kmax = kk
      }
      for (let y = 0; y < h; y++) {
        const s0 = (y / h - hy) / (1 - hy)
        if (s0 <= 0.004) {
          for (let x = 0; x < w; x++) d[(y * w + x) * 4 + 3] = 0
          continue
        }
        const pv = Math.min(24, 1 / Math.pow(s0, gp))
        const dpv = (gp * Math.pow(pv, 1 + 1 / gp)) / (1 - hy) // |d(깊이)/d(화면 y)|
        const fpp = (kmax * dpv) / h // 픽셀당 위상 변화(라디안)
        const fade = smoothstep(0, 0.10, s0) / (1 + fpp * fpp * 0.22)
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4
          const pu = (x / w - vcx) * pv
          const u1 = pu * ca - pv * sa
          const v1 = pu * sa + pv * ca
          let s = 0
          for (let k = 0; k < n; k++) {
            const q = L[k]!
            s += q.amp * fsin(q.kx * dens * u1 + q.ky * dens * v1 + q.n * T1 + q.ph + dist * 1.6 * fsin(q.kx * 0.3 * dens * v1 + q.n * T1))
          }
          const a = causRidge(1 - Math.min(1, Math.abs(s) / thick)) * om * fade
          d[i] = CR
          d[i + 1] = CG
          d[i + 2] = CB
          d[i + 3] = a > 0.002 ? Math.min(255, (a * 255) | 0) : 0
        }
      }
    } else {
      // 평면은 깊이가 없어 무늬가 화면을 한두 번밖에 지나가지 않고, u 범위가 0~1로 고정이라
      // 가로로 늘어난다. 화면 비율만큼 좌표를 펴고 밀도를 올려 오밀조밀한 그물이 되게 한다.
      const ar = W / H
      const dens = S.ex1 * 4.4
      const thick = Math.max(0.05, S.ex2) * n * 0.55
      const thin = thick * 0.62
      const KX = new Float64Array(n)
      const KY = new Float64Array(n)
      const PH = new Float64Array(n)
      const TT = new Float64Array(n)
      const A1 = new Float64Array(n)
      const A2 = new Float64Array(n)
      let kav = 0
      for (let k = 0; k < n; k++) {
        const q = L[k]!
        const kx = q.kx * dens
        const ky = q.ky * dens
        const kk = Math.hypot(kx, ky)
        KX[k] = kx
        KY[k] = ky
        PH[k] = q.ph
        TT[k] = q.n * T1
        kav += kk
        // 버퍼 픽셀보다 촘촘한 층은 모아레만 남긴다 → 진폭을 접어 부드럽게 사라지게
        const ppc = w / Math.max(1e-6, (kk / TAU) * ar) // 한 주기가 차지하는 버퍼 픽셀 수
        A1[k] = q.amp * clamp((ppc - 2.8) / 3.4, 0, 1)
        A2[k] = q.amp * clamp((ppc / 2.35 - 2.8) / 3.4, 0, 1)
      }
      kav = Math.max(kav / n, 0.5)
      // 흐름 왜곡: 층마다 따로 흔들면 뭉개지므로 좌표계 자체를 함께 휘게 한다.
      // 진폭은 셀 크기에, 주기는 셀 서너 개에 맞춰 물살처럼 굽이치게.
      const wa = (dist * 0.35 * TAU) / kav
      const wk = kav * 0.30
      const T2 = TAU * 2 * t
      for (let y = 0; y < h; y++) {
        const pv = y / h
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4
          const pu = (x / w) * ar
          const u0 = pu * ca - pv * sa
          const v0 = pu * sa + pv * ca
          const g1 = fsin(wk * v0 + T1 + 0.7)
          const g2 = fsin(wk * 1.9 * u0 - T2)
          const g3 = fsin(wk * u0 - T1 + 2.1)
          const g4 = fsin(wk * 1.7 * v0 + T2)
          const u1 = u0 + wa * (g1 + 0.55 * g2)
          const v1 = v0 + wa * (g3 + 0.55 * g4)
          // 큰 물결이 빛을 모으고 흩는 만큼의 밝기 기복 — 왜곡에 쓴 사인을 재활용해 공짜다
          const env2 = 0.58 + 0.42 * clamp(0.5 + 0.25 * (g1 + g3), 0, 1)
          let s = 0
          let s2 = 0
          for (let k = 0; k < n; k++) {
            const b = KX[k]! * u1 + KY[k]! * v1 + PH[k]!
            s += A1[k]! * fsin(b + TT[k]!)
            s2 += A2[k]! * fsin(b * 2.35 + TT[k]! * 2 + 1.7) // 잔 무늬(2옥타브). 시간은 정수배라 루프 유지
          }
          const v = 1 - Math.min(1, Math.abs(s) / thick)
          const f = 1 - Math.min(1, Math.abs(s2) / thin)
          const f3 = f * f * f
          const a = (causRidge(v) + f3 * (0.10 + 0.26 * v * v)) * om * env2 // 잔무늬는 밝은 능선 쪽에 더 실린다
          d[i] = CR
          d[i + 1] = CG
          d[i + 2] = CB
          d[i + 3] = a > 0.002 ? Math.min(255, (a * 255) | 0) : 0
        }
      }
    }
    caus.g!.putImageData(caus.img!, 0, 0)
    ctx.globalAlpha = 1
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    // 무늬 하나를 통째로 그리는 효과라 입자별 흐림이 없다 → '전체 흐림'은 화면 전체에 건다.
    const bl = (S.bokeh * 0.55 + clamp(num(S.blurAmt, 0), 0, 1) * 1.3) * Math.max(W, H) * 0.006
    if (bl > 0.2) ctx.filter = 'blur(' + bl.toFixed(2) + 'px)'
    ctx.drawImage(caus.buf, 0, 0, W, H)
    ctx.filter = 'none'
  },

  bloom(ctx, env) {
    const { S, sp, K } = env
    const P = env.P as BloomP[]
    const { t, scale, om, lo, ds } = K
    const W = K.W
    const H = K.H
    const npet = Math.round(S.ex1)
    const openT = clamp(S.ex2, 0.05, 0.8)
    const ground = K.view === 'ground'
    const sq = ground ? clamp(K.tilt, 0.05, 1) : 1
    const kindOf = (p: BloomP): string => (S.shape === 'mix' ? (p.kind ? 'star' : 'flower') : S.shape)
    for (const p of P) {
      const u = (((p.phase + p.cyc * t) % 1) + 1) % 1
      const open = u < openT ? easeOutBack(u / openT) : 1
      const fade = u < 0.78 ? 1 : 1 - (u - 0.78) / 0.22
      const a = p.op * om * smoothstep(0, 0.04, u) * fade * K.dim(p.sr)
      if (a < 0.005 || open <= 0.001) continue
      const m = lo + p.sr * ds
      let cx: number
      let cy: number
      let scl = 1
      if (ground) {
        const g = groundAt(p.gx, p.gz, K)
        cx = g.x
        cy = g.y
        scl = g.s
      } else {
        cx = p.gx * W
        cy = p.gz * H
      }
      cx += S.variation * p.swF * W * Math.sin(TAU * p.swC * t + p.swP)
      const R = FLOWER_BASE * scale * m * scl * open * (1 + 0.30 * (1 - fade))
      if (R < 0.7) continue
      cy -= (1 - fade) * R * 0.55 // 질 때 살며시 떠오른다
      const blur = Math.round((S.bokeh * smoothstep(0.68, 1, p.sr) * R * 0.5 + K.blurPx(p, R * 0.5)) * 2) / 2
      const base = clamp(a * (ground ? 0.4 + 0.6 * scl : 1), 0, 1)
      ctx.save()
      ctx.translate(cx, cy)
      if (blur > 0.5) ctx.filter = 'blur(' + blur + 'px)'
      // 피어나는 순간의 은은한 광채 — '사라락' 하고 번지는 느낌
      const burst = Math.max(0, 1 - Math.abs(u - openT * 0.5) / (openT * 1.1))
      if (burst > 0.03) {
        const gs = sp.disc(Math.max(3, Math.round((R * 1.7) / 5) * 5), 1, K.col(p), 0, 'round', 0)
        ctx.globalAlpha = clamp(base * burst * 0.32, 0, 1)
        ctx.drawImage(gs, -gs.width / 2, -gs.height / 2)
      }
      ctx.globalAlpha = base
      drawFlower(ctx, R, p.rot0 + TAU * p.rotCyc * t + (1 - open) * 2.0, npet + p.pj, open, K.col(p), sq, kindOf(p))
      if (blur > 0.5) ctx.filter = 'none'
      ctx.restore()
    }
  },
}

const easeOutBack = (x: number): number => {
  const c1 = 1.70158
  const c3 = c1 + 1
  const q = x - 1
  return 1 + c3 * q * q * q + c1 * q * q
}

function drawFlower(
  g: CanvasRenderingContext2D,
  R: number,
  rot: number,
  n: number,
  open: number,
  css: string,
  squash: number,
  kind: string,
): void {
  n = clamp(n | 0, 3, 14)
  // 눕힘은 화면 세로로 눌러야 한다 — 회전보다 먼저 걸면 꽃마다 눌리는 방향이 제각각이 된다.
  if (squash !== 1) g.scale(1, squash)
  g.rotate(rot)
  const star = kind === 'star'
  const pl = R * (0.32 + 0.68 * open)
  const pw = R * (star ? 0.28 : 0.48) * (0.40 + 0.60 * open)
  const twist = (1 - open) * 0.95 // 봉오리에서 꼬여 있다가 풀리며 펼쳐진다
  const petal = (len: number, wid: number, a: number): void => {
    g.beginPath()
    g.moveTo(0, 0)
    if (star) {
      g.lineTo(wid, -len * 0.40)
      g.lineTo(0, -len)
      g.lineTo(-wid, -len * 0.40)
    } else {
      // 끝이 넓고 얕게 팬 꽃잎
      g.bezierCurveTo(wid, -len * 0.34, wid * 0.92, -len * 0.95, wid * 0.22, -len)
      g.quadraticCurveTo(0, -len * 0.90, -wid * 0.22, -len)
      g.bezierCurveTo(-wid * 0.92, -len * 0.95, -wid, -len * 0.34, 0, 0)
    }
    g.closePath()
    g.fillStyle = 'rgba(' + css + ',' + a + ')'
    g.fill()
  }
  for (let i = 0; i < n; i++) {
    // 아래층: 반 칸 어긋나고 작고 어둡게 → 겹침의 깊이
    g.save()
    g.rotate(((i + 0.5) * TAU) / n - twist)
    petal(pl * 0.86, pw * 0.94, 0.42)
    g.restore()
  }
  for (let i = 0; i < n; i++) {
    // 위층
    g.save()
    g.rotate((i * TAU) / n + twist)
    petal(pl, pw, 0.95)
    g.restore()
  }
  const cr = R * 0.17 * (0.35 + 0.65 * open)
  if (cr > 0.6) {
    // 암·수술
    const ns = clamp(Math.round(n * 1.4), 4, 14)
    const sl = cr * 1.9 * open
    g.strokeStyle = 'rgba(255,246,214,0.7)'
    g.lineWidth = Math.max(0.5, cr * 0.20)
    g.beginPath()
    for (let i = 0; i < ns; i++) {
      const a = (i * TAU) / ns + 0.3
      g.moveTo(0, 0)
      g.lineTo(Math.cos(a) * sl, Math.sin(a) * sl)
    }
    g.stroke()
    g.fillStyle = 'rgba(255,240,190,0.9)'
    const dr = Math.max(0.4, cr * 0.24)
    for (let i = 0; i < ns; i++) {
      const a = (i * TAU) / ns + 0.3
      g.beginPath()
      g.arc(Math.cos(a) * sl, Math.sin(a) * sl, dr, 0, TAU)
      g.fill()
    }
    g.beginPath()
    g.arc(0, 0, cr * 0.58, 0, TAU)
    g.fillStyle = 'rgba(255,250,232,0.85)'
    g.fill()
  } else if (cr > 0.2) {
    g.beginPath()
    g.arc(0, 0, cr, 0, TAU)
    g.fillStyle = 'rgba(255,250,232,0.6)'
    g.fill()
  }
}

// ---------- 엔진 ----------
export class ParticleEngine {
  private spec: ParticleSpec
  private w: number
  private h: number
  private particles: Particle[] = []
  private tints: RGB[] = []
  private tintCss: string[] = []
  private plen = 1
  private readonly sprites = new SpriteCache()
  private readonly caus: CausticBuf = { buf: null, g: null, img: null, w: 0, h: 0 }

  constructor(spec: ParticleSpec, w: number, h: number) {
    this.spec = normalizeParticleSpec(spec)
    this.w = w
    this.h = h
    this.rebuildColors()
    this.particles = buildParticles(this.spec)
  }

  /** 바뀐 입력만 다시 만든다. 같은 spec 이면 정규화와 비교만 하고 끝난다. */
  update(spec: ParticleSpec, w: number, h: number): void {
    const next = normalizeParticleSpec(spec)
    const prev = this.spec
    this.w = w
    this.h = h
    this.spec = next
    const colorChanged =
      next.colorMode !== prev.colorMode ||
      next.single !== prev.single ||
      next.palette !== prev.palette ||
      next.colorVar !== prev.colorVar ||
      next.customPal.join('|') !== prev.customPal.join('|')
    const prevPlen = this.plen
    if (colorChanged) this.rebuildColors()
    if (
      next.effect !== prev.effect ||
      next.seed !== prev.seed ||
      next.count !== prev.count ||
      next.sizeDist !== prev.sizeDist ||
      this.plen !== prevPlen
    )
      this.particles = buildParticles(next)
    // 스프라이트 키에 양자화 파라미터가 전부 들어가 잘못 그려질 일은 없다.
    // 지우는 것은 안 쓰게 된 비트맵을 놓아주는 메모리 관리다.
    if (
      colorChanged ||
      next.effect !== prev.effect ||
      next.shape !== prev.shape ||
      next.sizeMin !== prev.sizeMin ||
      next.sizeMax !== prev.sizeMax ||
      next.soft !== prev.soft ||
      next.bokeh !== prev.bokeh ||
      next.ex1 !== prev.ex1 ||
      next.ex2 !== prev.ex2 ||
      next.blurAmt !== prev.blurAmt ||
      next.blurFocus !== prev.blurFocus ||
      next.blurRand !== prev.blurRand ||
      next.vpHole !== prev.vpHole ||
      next.view !== prev.view
    )
      this.sprites.clear()
  }

  private rebuildColors(): void {
    const pal = resolvePalette(this.spec)
    this.plen = pal.length
    const { tints, tintCss } = buildTints(pal, this.spec.colorVar)
    this.tints = tints
    this.tintCss = tintCss
  }

  /**
   * 한 프레임. t ∈ [0,1), 배경은 투명. 같은 (spec, w, h, t)면 항상 같은 그림 —
   * 모든 주기가 정수라 render(0)과 render(1⁻)이 이음매 없이 이어진다.
   */
  render(ctx: CanvasRenderingContext2D, t: number): void {
    const S = this.spec
    const W = this.w
    const H = this.h
    ctx.clearRect(0, 0, W, H)
    ctx.globalCompositeOperation = S.blend === 'screen' ? 'lighter' : 'source-over'
    const dep = S.depth
    const tintCss = this.tintCss
    const K: FrameK = {
      W, H, t,
      scale: H / REF,
      om: S.opacityMul,
      lo: S.sizeMin, hi: S.sizeMax, ds: S.sizeMax - S.sizeMin,
      view: S.view,
      vx: S.viewX * W, vy: S.viewY * H,
      persp: S.persp, tilt: S.tilt,
      diag: Math.hypot(W, H),
      hole: S.view === 'toward' ? clamp(S.vpHole, 0, 1) : 0,
      dim: sr => 1 - dep * 0.55 * (1 - sr),
      gustX: sr => S.gust * 0.085 * W * (0.30 + 0.70 * sr) * Math.sin(TAU * t),
      col: p => tintCss[p.ci * TL + p.ti] || tintCss[0] || '255,255,255',
      blurF: () => 0,
      blurPx: () => 0,
      haze: (hz, px) => (hz > 0 ? hz * (px * 0.45 + (H / REF) * 2.2) : 0),
    }
    // 전체 흐림: 초점(blurFocus)에서 깊이가 멀수록 흐려지고,
    // blurRand 만큼 입자별 제비뽑기(bv)로 섞어 한결같이 흐려 보이지 않게 한다.
    const bA = clamp(num(S.blurAmt, 0), 0, 1)
    if (bA > 0) {
      const bF = clamp(num(S.blurFocus, 0.75), 0, 1)
      const bR = clamp(num(S.blurRand, 0.35), 0, 1)
      const nz = Math.max(bF, 1 - bF, 0.001)
      K.blurF = p => {
        const d = Math.abs(p.sr - bF) / nz
        return bA * (d + (p.bv - d) * bR)
      }
    }
    // px = 그 입자의 화면상 크기. 크기에 비례시켜야 작은 입자가 통째로 사라지지 않는다.
    K.blurPx = (p, px) => {
      const f = K.blurF(p)
      return f > 0 ? f * (px * 0.75 + K.scale * 0.35) : 0
    }
    const env: Env = {
      S,
      P: this.particles,
      tints: this.tints,
      tintCss,
      sp: this.sprites,
      caus: this.caus,
      K,
    }
    RENDER[S.effect](ctx, env)
    ctx.globalAlpha = 1
    ctx.globalCompositeOperation = 'source-over'
    ctx.filter = 'none'
  }
}
