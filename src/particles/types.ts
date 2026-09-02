/**
 * 파티클 오버레이 엔진의 공개 타입.
 *
 * ParticleSpec 하나가 한 오버레이의 모든 입력이다 — 같은 spec·크기·t 면
 * 언제나 같은 프레임이 나온다(엔진에 Math.random / Date.now 없음).
 */

export type EffectKey =
  | 'rain'
  | 'snow'
  | 'dust'
  | 'flare'
  | 'sparkle'
  | 'petal'
  | 'fog'
  | 'firefly'
  | 'bokeh'
  | 'ripple'
  | 'caustic'
  | 'bloom'

export type ViewKey = 'flat' | 'toward' | 'ground'
export type BlendKey = 'normal' | 'screen'
export type ColorModeKey = 'single' | 'palette'

/** 효과 종류·시드·색 구성을 뺀 파라미터. CFG def 와 빠른 스타일 패치가 이 모양이다. */
export interface ParticleParams {
  count: number
  sizeMin: number
  sizeMax: number
  /** 크기 분포(원근). 0=균등, 1=작은 쪽 봉우리 + 얇은 큰 꼬리 */
  sizeDist: number
  depth: number
  speed: number
  opacityMul: number
  variation: number
  angle: number
  gust: number
  soft: number
  bokeh: number
  colorVar: number
  blend: BlendKey
  ex1: number
  ex2: number
  shape: string
  view: ViewKey
  viewX: number
  viewY: number
  persp: number
  tilt: number
  vpHole: number
  blurAmt: number
  blurFocus: number
  blurRand: number
}

export interface ParticleSpec extends ParticleParams {
  effect: EffectKey
  seed: number
  colorMode: ColorModeKey
  /** 단색 모드의 색 (hex) */
  single: string
  /** 팔레트 모드의 팔레트 키. PALETTES 에 없으면(예: '직접') customPal 을 쓴다. */
  palette: string
  /** 직접 팔레트 (hex 최대 8개) */
  customPal: string[]
}
