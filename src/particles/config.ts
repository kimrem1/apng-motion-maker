/**
 * 효과 정의표. UI 라벨과 기본값, 슬라이더 범위, 빠른 스타일을 한 곳에서 관리한다.
 * angle/variation/gust/bokeh/ex1/ex2/shape 가 있으면 그 컨트롤이 패널에 나타나고,
 * views 가 둘 이상이면 시점 섹션이 나타난다 (specVisibleControls).
 */
import type { EffectKey, ParticleParams, ParticleSpec, ViewKey } from './types'

export const REF = 720
export const BASE_T = 3
export const TL = 7 // 색 흔들림 단계 수(스프라이트 캐시 폭증 방지를 위한 양자화)
export const BL = 5 // 입자별 흐림 단계 수 — 같은 이유로 끊어 둔다

// REF(720) 기준 기본 픽셀 크기
export const SNOW_BASE = 5.5
export const DUST_BASE = 7.5
export const SPARKLE_BASE = 20
export const PETAL_BASE = 22
export const FOG_BASE = 115
export const FIRE_BASE = 5.6
export const BOKEH_BASE = 26
export const RIPPLE_BASE = 52
export const FLOWER_BASE = 26

export const PALETTES: Record<string, string[]> = {
  무지개: ['#ff4d4d', '#ff9f1c', '#ffe74c', '#4cd964', '#4db8ff', '#9b6bff'],
  파스텔: ['#ffd1dc', '#ffe5b4', '#c1f0c1', '#cfe8ff', '#e3d0ff', '#fff7c0'],
  네온: ['#ff2d95', '#00f0ff', '#39ff14', '#ff00e6', '#1e90ff', '#fff700'],
  노을: ['#ff6b35', '#ff9e7a', '#ff5e9c', '#c44cff', '#ffd166'],
  봄: ['#ffb7d5', '#ffd6e7', '#b8e986', '#fff1a8', '#cdeac0'],
  바다: ['#bff4ff', '#7fe3f0', '#4fc3d9', '#a8f0e0', '#e6ffff'],
}
export const DEFAULT_PALETTE_KEY = '무지개'

export const VIEW_NAME: Record<ViewKey, string> = {
  flat: '평면',
  toward: '정면 낙하',
  ground: '지면 원근',
}
export const VIEW_NOTE: Record<ViewKey, string> = {
  flat: '화면과 나란한 기본 시점.',
  toward: '소실점에서 쏟아집니다. 누워서 보는 시점.',
  ground: '바닥·수면을 비스듬히 봅니다.',
}

export interface SliderMeta {
  label: string
  min: number
  max: number
  step: number
  fmt?: (v: number) => string
  note?: string
}
export interface ShapeMeta {
  label: string
  opts: [value: string, label: string][]
}
export interface EffectConfig {
  ic: string
  name: string
  color: string
  def: ParticleParams
  noSize?: boolean
  count?: { label?: string; min?: number; max?: number }
  angle?: SliderMeta
  variation?: SliderMeta
  gust?: boolean
  bokeh?: { label: string }
  ex1?: SliderMeta
  ex2?: SliderMeta
  shape?: ShapeMeta
  views: ViewKey[]
  styles: Record<string, Partial<ParticleParams>>
}

const deg = (v: number): string => v + '°'

// 효과와 무관하게 늘 같은 기본값을 갖는 항목. 여기 한 곳에만 적으면 12개 def 전부에 채워진다.
const COMMON_DEF = { blurAmt: 0, blurFocus: 0.75, blurRand: 0.35, vpHole: 0.32 }
export { COMMON_DEF }

type RawDef = Omit<ParticleParams, keyof typeof COMMON_DEF>
const def = (d: RawDef): ParticleParams => ({ ...COMMON_DEF, ...d })

export const CFG: Record<EffectKey, EffectConfig> = {
  rain: {
    ic: 'rainy', name: '비', color: '#ffffff',
    def: def({ count: 520, sizeMin: 0.24, sizeMax: 1.25, sizeDist: 0.80, depth: 1.00, speed: 1, opacityMul: 0.95, variation: 0.30, angle: 12, gust: 0.20, soft: 0.30, bokeh: 0.30, colorVar: 0.10, blend: 'normal', ex1: 0.055, ex2: 0, shape: 'streak', view: 'flat', viewX: 0.5, viewY: 0.5, persp: 0.6, tilt: 0.35 }),
    angle: { label: '바람 방향', min: -80, max: 80, step: 1, fmt: deg, note: '0°는 수직, 음수는 왼쪽.' },
    variation: { label: '빗줄기 흔들림', min: 0, max: 1.5, step: 0.05 },
    gust: true,
    bokeh: { label: '가까운 줄기 흐림' },
    ex1: { label: '빗줄기 길이', min: 0.012, max: 0.20, step: 0.004, fmt: v => (v * 100).toFixed(1) + '%' },
    shape: { label: '모양', opts: [['streak', '빗줄기'], ['drop', '물방울']] },
    views: ['flat', 'toward'],
    styles: {
      이슬비: { count: 1400, sizeMin: 0.06, sizeMax: 0.55, sizeDist: 0.85, speed: 0.8, opacityMul: 0.8, ex1: 0.03, bokeh: 0.15, angle: 8 },
      보통비: { count: 520, sizeMin: 0.24, sizeMax: 1.25, sizeDist: 0.8, speed: 1, opacityMul: 0.95, ex1: 0.055, bokeh: 0.3, angle: 12 },
      소나기: { count: 900, sizeMin: 0.35, sizeMax: 1.8, sizeDist: 0.7, speed: 1.6, opacityMul: 1.1, ex1: 0.10, bokeh: 0.35, angle: 26, gust: 0.45 },
      '누워서 천장': { count: 700, sizeMin: 0.30, sizeMax: 1.6, sizeDist: 0.82, speed: 1.1, opacityMul: 1, ex1: 0.08, bokeh: 0.4, view: 'toward', persp: 0.62, viewX: 0.5, viewY: 0.46 },
    },
  },

  snow: {
    ic: 'ac_unit', name: '눈', color: '#ffffff',
    def: def({ count: 900, sizeMin: 0.10, sizeMax: 1.50, sizeDist: 0.80, depth: 1.00, speed: 0.75, opacityMul: 1, variation: 1.10, angle: 6, gust: 0.30, soft: 0.35, bokeh: 0.50, colorVar: 0.08, blend: 'normal', ex1: 0.35, ex2: 0, shape: 'round', view: 'flat', viewX: 0.5, viewY: 0.5, persp: 0.6, tilt: 0.35 }),
    angle: { label: '바람 방향', min: -80, max: 80, step: 1, fmt: deg, note: '0°는 수직, 음수는 왼쪽.' },
    variation: { label: '흔들림', min: 0, max: 2.5, step: 0.05 },
    gust: true,
    bokeh: { label: '빛망울' },
    ex1: { label: '뒤척임', min: 0, max: 1, step: 0.02, note: '' },
    shape: { label: '보케 모양', opts: [['round', '원형'], ['hex', '육각']] },
    views: ['flat', 'toward'],
    styles: {
      가랑눈: { count: 2600, sizeMin: 0.04, sizeMax: 0.40, sizeDist: 0.85, speed: 0.6, opacityMul: 1.05, variation: 1.35, bokeh: 0.2, ex1: 0.15 },
      '원근 혼합': { count: 1200, sizeMin: 0.06, sizeMax: 1.5, sizeDist: 0.82, speed: 0.7, opacityMul: 1, variation: 1.2, bokeh: 0.5, ex1: 0.35 },
      함박눈: { count: 320, sizeMin: 0.40, sizeMax: 2.0, sizeDist: 0.72, speed: 0.85, opacityMul: 1, variation: 1, bokeh: 0.62, ex1: 0.55 },
      눈보라: { count: 1800, sizeMin: 0.08, sizeMax: 1.2, sizeDist: 0.84, speed: 1.7, opacityMul: 1, variation: 1.6, angle: 42, gust: 0.7, bokeh: 0.35, ex1: 0.3 },
    },
  },

  dust: {
    ic: 'grain', name: '먼지', color: '#ffffff',
    def: def({ count: 220, sizeMin: 0.25, sizeMax: 1.35, sizeDist: 0.76, depth: 0.65, speed: 1, opacityMul: 1.7, variation: 1, angle: 0, gust: 0, soft: 0.55, bokeh: 0.25, colorVar: 0.18, blend: 'screen', ex1: 0.30, ex2: 0.55, shape: 'round', view: 'flat', viewX: 0.5, viewY: 0.5, persp: 0.6, tilt: 0.35 }),
    variation: { label: '퍼짐', min: 0, max: 2.5, step: 0.05 },
    bokeh: { label: '가까운 먼지 흐림' },
    ex1: { label: '공기 흐름', min: 0, max: 1, step: 0.02, note: '' },
    ex2: { label: '후광', min: 0, max: 1, step: 0.02 },
    views: ['flat'],
    styles: {
      '햇살 먼지': { count: 220, sizeMin: 0.25, sizeMax: 1.35, sizeDist: 0.76, variation: 1, ex1: 0.3, ex2: 0.55, soft: 0.55, opacityMul: 1.7 },
      '미세 반짝': { count: 900, sizeMin: 0.10, sizeMax: 0.60, sizeDist: 0.86, variation: 1.4, ex1: 0.5, ex2: 0.8, soft: 0.35, opacityMul: 2 },
      '실내 공기': { count: 130, sizeMin: 0.35, sizeMax: 1.8, sizeDist: 0.68, variation: 0.6, ex1: 0.15, ex2: 0.35, soft: 0.85, opacityMul: 1.4 },
    },
  },

  flare: {
    ic: 'wb_sunny', name: '햇빛', color: '#ffffff',
    def: def({ count: 14, sizeMin: 0.50, sizeMax: 1.40, sizeDist: 0.50, depth: 0.40, speed: 1, opacityMul: 1, variation: 1, angle: -40, gust: 0, soft: 0.50, bokeh: 0, colorVar: 0.15, blend: 'screen', ex1: 0.70, ex2: 0.50, shape: 'round', view: 'flat', viewX: 0.5, viewY: 0.5, persp: 0.6, tilt: 0.35 }),
    angle: { label: '햇빛 위치', min: -180, max: 180, step: 1, fmt: deg, note: '0°는 위, 90°는 오른쪽.' },
    variation: { label: '고스트 퍼짐', min: 0.3, max: 1.8, step: 0.05 },
    count: { label: '고스트 개수', min: 0, max: 60 },
    ex1: { label: '스타버스트 세기', min: 0, max: 1.5, step: 0.02 },
    ex2: { label: '애너모픽 스트릭', min: 0, max: 1.5, step: 0.02 },
    views: ['flat'],
    styles: {
      '부드러운 역광': { count: 10, ex1: 0.35, ex2: 0.3, opacityMul: 0.8, sizeMin: 0.4, sizeMax: 1.1 },
      시네마틱: { count: 18, ex1: 0.6, ex2: 1.2, opacityMul: 1, sizeMin: 0.5, sizeMax: 1.4 },
      '강한 태양': { count: 24, ex1: 1.2, ex2: 0.7, opacityMul: 1.3, sizeMin: 0.6, sizeMax: 1.8 },
    },
  },

  sparkle: {
    ic: 'auto_awesome', name: '반짝임', color: '#ffffff',
    def: def({ count: 250, sizeMin: 0.16, sizeMax: 1.20, sizeDist: 0.80, depth: 0.70, speed: 1, opacityMul: 1.3, variation: 0.40, angle: 0, gust: 0, soft: 0.35, bokeh: 0, colorVar: 0.15, blend: 'screen', ex1: 2.40, ex2: 0.35, shape: 'mix', view: 'flat', viewX: 0.5, viewY: 0.5, persp: 0.6, tilt: 0.35 }),
    variation: { label: '드리프트', min: 0, max: 2.5, step: 0.05 },
    ex1: { label: '여운', min: 0.6, max: 6, step: 0.1, note: '클수록 짧게 번쩍입니다.' },
    ex2: { label: '보조 갈래 길이', min: 0, max: 0.8, step: 0.02, note: '주 갈래 사이의 짧은 갈래. 0은 끔.' },
    shape: { label: '갈래', opts: [['4', '4갈래'], ['6', '6갈래'], ['mix', '혼합']] },
    views: ['flat', 'toward'],
    styles: {
      별가루: { count: 320, sizeMin: 0.08, sizeMax: 0.8, sizeDist: 0.86, ex1: 3.2, ex2: 0.3, variation: 0.3, shape: 'mix' },
      크리스마스: { count: 120, sizeMin: 0.35, sizeMax: 1.6, sizeDist: 0.7, ex1: 1.8, ex2: 0.45, variation: 0.5, shape: '6' },
      '유리 반사': { count: 95, sizeMin: 0.5, sizeMax: 2.2, sizeDist: 0.62, ex1: 3.4, ex2: 0.2, variation: 0.15, shape: '4' },
      '다이아 광채': { count: 90, sizeMin: 0.4, sizeMax: 2.4, sizeDist: 0.68, ex1: 2.2, ex2: 0.6, variation: 0.2, soft: 0.15, shape: 'mix' },
    },
  },

  petal: {
    ic: 'local_florist', name: '꽃잎', color: '#ffffff',
    def: def({ count: 120, sizeMin: 0.24, sizeMax: 1.35, sizeDist: 0.78, depth: 1.00, speed: 0.80, opacityMul: 1, variation: 1, angle: 15, gust: 0.30, soft: 0.30, bokeh: 0.26, colorVar: 0.18, blend: 'normal', ex1: 0.70, ex2: 0, shape: 'petal', view: 'flat', viewX: 0.5, viewY: 0.5, persp: 0.6, tilt: 0.35 }),
    angle: { label: '떨어지는 방향', min: -80, max: 80, step: 1, fmt: deg, note: '0°는 수직, 음수는 왼쪽.' },
    variation: { label: '나풀거림', min: 0, max: 3, step: 0.05 },
    gust: true,
    bokeh: { label: '가까운 꽃잎 흐림' },
    ex1: { label: '뒤집힘', min: 0, max: 1, step: 0.02, note: '앞뒤로 뒤집히며 떨어집니다.' },
    shape: { label: '모양', opts: [['petal', '꽃잎'], ['leaf', '나뭇잎'], ['mix', '혼합']] },
    views: ['flat', 'toward'],
    styles: {
      벚꽃: { count: 140, sizeMin: 0.22, sizeMax: 1.2, sizeDist: 0.8, speed: 0.75, variation: 1.1, ex1: 0.75, shape: 'petal', angle: 15 },
      단풍: { count: 80, sizeMin: 0.35, sizeMax: 1.7, sizeDist: 0.7, speed: 0.9, variation: 1.4, ex1: 0.85, shape: 'leaf', angle: 24 },
      흩날림: { count: 260, sizeMin: 0.12, sizeMax: 1.0, sizeDist: 0.85, speed: 1.4, variation: 2.0, ex1: 0.6, gust: 0.6, angle: 38 },
    },
  },

  fog: {
    ic: 'foggy', name: '안개', color: '#ffffff',
    def: def({ count: 46, sizeMin: 0.45, sizeMax: 1.60, sizeDist: 0.55, depth: 0.80, speed: 0.50, opacityMul: 0.80, variation: 1, angle: 0, gust: 0.25, soft: 1, bokeh: 0, colorVar: 0.06, blend: 'normal', ex1: 0.50, ex2: 0, shape: 'round', view: 'flat', viewX: 0.5, viewY: 0.42, persp: 0.6, tilt: 0.35 }),
    angle: { label: '흐름 방향', min: -90, max: 90, step: 1, fmt: deg, note: '' },
    variation: { label: '뒤척임', min: 0, max: 2.5, step: 0.05 },
    gust: true,
    count: { label: '안개 덩어리', min: 4, max: 400 },
    ex1: { label: '층 두께', min: 0.05, max: 1, step: 0.02, note: '1은 화면 전체, 낮추면 아래쪽.' },
    views: ['flat', 'ground'],
    styles: {
      '옅은 연무': { count: 34, opacityMul: 0.5, sizeMin: 0.6, sizeMax: 1.8, ex1: 0.8, variation: 0.7 },
      '바닥 안개': { count: 60, opacityMul: 0.95, sizeMin: 0.5, sizeMax: 1.5, ex1: 0.30, variation: 1.2 },
      '짙은 안개': { count: 90, opacityMul: 1.3, sizeMin: 0.8, sizeMax: 2.2, ex1: 1, variation: 1.5 },
    },
  },

  firefly: {
    ic: 'emoji_nature', name: '반딧불이', color: '#ffffff',
    def: def({ count: 70, sizeMin: 0.30, sizeMax: 1.30, sizeDist: 0.75, depth: 0.70, speed: 0.60, opacityMul: 1.6, variation: 0.80, angle: 0, gust: 0, soft: 0.60, bokeh: 0.20, colorVar: 0.20, blend: 'screen', ex1: 0.50, ex2: 2, shape: 'round', view: 'flat', viewX: 0.5, viewY: 0.5, persp: 0.6, tilt: 0.35 }),
    variation: { label: '배회 범위', min: 0, max: 2.5, step: 0.05 },
    bokeh: { label: '글로우 번짐' },
    ex1: { label: '잔광', min: 0, max: 1, step: 0.02, note: '지나온 자리에 빛이 남습니다.' },
    ex2: { label: '발광 주기', min: 1, max: 6, step: 1, fmt: v => v + '회' },
    views: ['flat'],
    styles: {
      여름밤: { count: 70, speed: 0.6, variation: 0.8, ex1: 0.5, ex2: 2, opacityMul: 1 },
      '무리 짓기': { count: 200, speed: 0.5, variation: 0.45, ex1: 0.35, ex2: 3, sizeMin: 0.2, sizeMax: 1, opacityMul: 0.9 },
      드문드문: { count: 24, speed: 0.8, variation: 1.5, ex1: 0.75, ex2: 1, sizeMin: 0.5, sizeMax: 1.6 },
    },
  },

  bokeh: {
    ic: 'lens_blur', name: '빛망울', color: '#ffffff',
    def: def({ count: 90, sizeMin: 0.16, sizeMax: 1.80, sizeDist: 0.85, depth: 1.00, speed: 0.50, opacityMul: 0.90, variation: 0.50, angle: 0, gust: 0, soft: 0.35, bokeh: 0.55, colorVar: 0.22, blend: 'screen', ex1: 0.45, ex2: 0, shape: 'round', view: 'flat', viewX: 0.5, viewY: 0.5, persp: 0.6, tilt: 0.35 }),
    variation: { label: '드리프트', min: 0, max: 2, step: 0.05 },
    bokeh: { label: '흐림 정도' },
    ex1: { label: '테두리', min: 0, max: 1, step: 0.02, note: '조리개 가장자리의 밝은 테두리.' },
    shape: { label: '조리개', opts: [['round', '원형'], ['hex', '육각'], ['ring', '링']] },
    views: ['flat', 'toward'],
    styles: {
      야경: { count: 90, sizeMin: 0.16, sizeMax: 1.8, sizeDist: 0.85, ex1: 0.45, bokeh: 0.55, opacityMul: 0.9 },
      '큰 빛망울': { count: 26, sizeMin: 0.7, sizeMax: 2.6, sizeDist: 0.6, ex1: 0.6, bokeh: 0.75, opacityMul: 1 },
      '먼지 같은 빛': { count: 400, sizeMin: 0.05, sizeMax: 0.6, sizeDist: 0.88, ex1: 0.2, bokeh: 0.3, opacityMul: 0.8 },
    },
  },

  ripple: {
    ic: 'water_drop', name: '물결', color: '#ffffff',
    def: def({ count: 60, sizeMin: 0.30, sizeMax: 1.50, sizeDist: 0.78, depth: 0.75, speed: 0.80, opacityMul: 1.5, variation: 0.30, angle: 0, gust: 0, soft: 0.30, bokeh: 0, colorVar: 0.10, blend: 'screen', ex1: 3, ex2: 2.20, shape: 'round', view: 'ground', viewX: 0.5, viewY: 0.30, persp: 0.60, tilt: 0.30 }),
    variation: { label: '튐(물방울)', min: 0, max: 1.5, step: 0.05 },
    count: { label: '물방울 수', min: 2, max: 600 },
    ex1: { label: '파동 링 수', min: 1, max: 5, step: 1, fmt: v => v + '겹' },
    ex2: { label: '퍼지는 감속', min: 1, max: 4, step: 0.1, note: '클수록 빠르게 퍼졌다 멎습니다.' },
    views: ['flat', 'ground'],
    styles: {
      '빗방울 수면': { count: 120, speed: 1.2, sizeMin: 0.2, sizeMax: 1.1, ex1: 3, ex2: 2.4, opacityMul: 1 },
      '고요한 호수': { count: 22, speed: 0.45, sizeMin: 0.5, sizeMax: 2.0, ex1: 2, ex2: 2.8, opacityMul: 0.85 },
      '위에서 보기': { count: 70, view: 'flat', sizeMin: 0.3, sizeMax: 1.6, ex1: 3, ex2: 2.2, speed: 0.8 },
    },
  },

  caustic: {
    ic: 'waves', name: '물그물', color: '#ffffff',
    def: def({ count: 5, sizeMin: 0.3, sizeMax: 1.5, sizeDist: 0.7, depth: 0, speed: 0.60, opacityMul: 0.80, variation: 0.35, angle: 0, gust: 0, soft: 0.50, bokeh: 0.35, colorVar: 0.10, blend: 'screen', ex1: 0.50, ex2: 0.55, shape: 'round', view: 'ground', viewX: 0.5, viewY: 0.34, persp: 0.55, tilt: 0.35 }),
    noSize: true,
    count: { label: '물결 겹 수', min: 2, max: 12 },
    angle: { label: '무늬 방향', min: -90, max: 90, step: 1, fmt: deg, note: '' },
    variation: { label: '무늬 왜곡', min: 0, max: 1.5, step: 0.05 },
    bokeh: { label: '번짐(소프트)' },
    ex1: { label: '무늬 밀도', min: 0.1, max: 1.5, step: 0.02 },
    ex2: { label: '선 굵기', min: 0.15, max: 1.2, step: 0.02, note: '작을수록 가늘어집니다.' },
    views: ['flat', 'ground'],
    styles: {
      '수영장 바닥': { count: 5, ex1: 0.5, ex2: 0.55, opacityMul: 0.8, speed: 0.6, view: 'ground', viewY: 0.34 },
      '얕은 바다': { count: 7, ex1: 0.75, ex2: 0.4, opacityMul: 1, speed: 0.9, variation: 0.6, view: 'ground', viewY: 0.28 },
      '수면 위': { count: 4, ex1: 0.35, ex2: 0.7, opacityMul: 0.65, speed: 0.4, view: 'flat' },
    },
  },

  bloom: {
    ic: 'filter_vintage', name: '꽃피움', color: '#ffffff',
    def: def({ count: 110, sizeMin: 0.18, sizeMax: 1.50, sizeDist: 0.80, depth: 1.00, speed: 0.70, opacityMul: 1, variation: 0.40, angle: 0, gust: 0, soft: 0.35, bokeh: 0.30, colorVar: 0.20, blend: 'normal', ex1: 5, ex2: 0.35, shape: 'flower', view: 'flat', viewX: 0.5, viewY: 0.40, persp: 0.55, tilt: 0.90 }),
    variation: { label: '흔들림', min: 0, max: 1.5, step: 0.05 },
    bokeh: { label: '가까운 꽃 흐림' },
    count: { label: '꽃 개수', min: 2, max: 1200 },
    ex1: { label: '꽃잎 수', min: 3, max: 12, step: 1, fmt: v => v + '장' },
    ex2: { label: '피어나는 시간', min: 0.08, max: 0.7, step: 0.02, note: '작을수록 빠르게 핍니다.' },
    shape: { label: '모양', opts: [['flower', '둥근 꽃'], ['star', '별꽃'], ['mix', '혼합']] },
    views: ['flat', 'ground'],
    styles: {
      사라락: { count: 260, speed: 1.1, sizeMin: 0.10, sizeMax: 1.0, sizeDist: 0.85, ex1: 5, ex2: 0.16, variation: 0.5 },
      들판: { count: 240, speed: 0.6, sizeMin: 0.3, sizeMax: 2.1, sizeDist: 0.72, ex1: 6, ex2: 0.35, view: 'ground', viewY: 0.42, tilt: 0.9 },
      '큰 꽃 몇 송이': { count: 26, speed: 0.5, sizeMin: 0.7, sizeMax: 2.4, sizeDist: 0.55, ex1: 8, ex2: 0.45 },
    },
  },
}

export const EFFECTS = Object.keys(CFG) as EffectKey[]

/** soft(부드러움) 슬라이더가 뜻을 갖는 효과 */
export const USES_SOFT: ReadonlySet<EffectKey> = new Set(['snow', 'dust', 'sparkle', 'bokeh'])
/** gust(돌풍) 슬라이더가 있는 효과 */
export const GUST_EFFECTS: ReadonlySet<EffectKey> = new Set(
  EFFECTS.filter(e => CFG[e].gust),
)

// ---------- spec 생성·정규화 ----------

const clamp = (v: number, a: number, b: number): number => Math.max(a, Math.min(b, v))
const num = (v: unknown, d: number): number =>
  typeof v === 'number' && isFinite(v) ? v : d

export function defaultParticleSpec(effect: EffectKey): ParticleSpec {
  const c = CFG[effect]
  return {
    effect,
    ...c.def,
    seed: 7,
    colorMode: 'single',
    single: c.color,
    palette: DEFAULT_PALETTE_KEY,
    customPal: [...(PALETTES[DEFAULT_PALETTE_KEY] ?? [])],
  }
}

const isEffectKey = (v: unknown): v is EffectKey =>
  typeof v === 'string' && Object.prototype.hasOwnProperty.call(CFG, v)

const STRING_PARAMS = new Set(['blend', 'shape', 'view'])

/**
 * 임의 입력을 안전한 spec 으로. 기본값 채움 → 슬라이더 범위 클램프 순서다.
 * 어떤 쓰레기가 와도 던지지 않는다. 손으로 고친 JSON 이 들어와도 범위를
 * 벗어나지 않게 하기 위해서다. 음수 크기는 그리는 도중에 터진다.
 */
export function normalizeParticleSpec(raw: unknown): ParticleSpec {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const effect: EffectKey = isEffectKey(o.effect) ? o.effect : 'snow'
  const c = CFG[effect]
  const d = c.def
  const s = defaultParticleSpec(effect)

  // 파라미터: 문자열형은 문자열만, 수치형은 유한수만 받는다
  for (const k of Object.keys(d) as (keyof ParticleParams)[]) {
    const dv = d[k]
    if (STRING_PARAMS.has(k)) {
      const v = o[k]
      ;(s as unknown as Record<string, unknown>)[k] =
        typeof v === 'string' && v ? v : dv
    } else {
      ;(s as unknown as Record<string, unknown>)[k] = num(o[k], dv as number)
    }
  }

  // 색
  s.single = typeof o.single === 'string' && o.single ? o.single : c.color
  s.colorMode = o.colorMode === 'palette' ? 'palette' : 'single'
  s.palette = typeof o.palette === 'string' && o.palette ? o.palette : DEFAULT_PALETTE_KEY
  const cp = Array.isArray(o.customPal)
    ? o.customPal.filter((v): v is string => typeof v === 'string' && v.length > 0).slice(0, 8)
    : []
  if (cp.length) s.customPal = cp

  // 열거형 검증
  s.blend = s.blend === 'screen' ? 'screen' : 'normal'
  if (!c.views.includes(s.view)) s.view = 'flat'
  if (c.shape && !c.shape.opts.some(op => op[0] === s.shape)) s.shape = c.shape.opts[0]![0]

  // 슬라이더 범위 클램프
  s.count = clamp(Math.round(num(s.count, d.count)), c.count?.min ?? 4, c.count?.max ?? 6000)
  s.sizeMin = clamp(s.sizeMin, 0.03, 3)
  s.sizeMax = clamp(s.sizeMax, s.sizeMin, 3)
  s.sizeDist = clamp(s.sizeDist, 0, 1)
  s.depth = clamp(s.depth, 0, 1.5)
  s.speed = clamp(s.speed, 0.25, 3)
  s.opacityMul = clamp(s.opacityMul, 0.05, 2)
  s.gust = clamp(s.gust, 0, 1)
  s.soft = clamp(s.soft, 0, 1)
  s.bokeh = clamp(s.bokeh, 0, 1)
  s.colorVar = clamp(s.colorVar, 0, 1)
  s.viewX = clamp(s.viewX, 0, 1)
  s.viewY = clamp(s.viewY, 0, 1)
  s.persp = clamp(s.persp, 0, 1)
  s.tilt = clamp(s.tilt, 0.05, 1)
  s.vpHole = clamp(s.vpHole, 0, 1)
  s.blurAmt = clamp(s.blurAmt, 0, 1)
  s.blurFocus = clamp(s.blurFocus, 0, 1)
  s.blurRand = clamp(s.blurRand, 0, 1)
  if (c.angle) s.angle = clamp(s.angle, c.angle.min, c.angle.max)
  if (c.variation) s.variation = clamp(s.variation, c.variation.min, c.variation.max)
  if (c.ex1) s.ex1 = clamp(s.ex1, c.ex1.min, c.ex1.max)
  if (c.ex2) s.ex2 = clamp(s.ex2, c.ex2.min, c.ex2.max)
  s.seed = num(o.seed, 7)
  return s
}

/**
 * 빠른 스타일 적용. 그 효과의 어떤 스타일이든 건드리는 키 전부를 기본값으로
 * 되돌린 뒤 패치를 얹는다 — 어떤 스타일을 거쳐 왔든 같은 버튼은 늘 같은 그림.
 */
export function applyQuickStyle(spec: ParticleSpec, styleName: string): ParticleSpec {
  const c = CFG[spec.effect]
  const patch = c.styles[styleName]
  if (!patch) return spec
  const touched = new Set<keyof ParticleParams>()
  for (const st of Object.values(c.styles))
    for (const k of Object.keys(st)) touched.add(k as keyof ParticleParams)
  const out = { ...spec } as ParticleSpec
  for (const k of touched)
    (out as unknown as Record<string, unknown>)[k] = c.def[k]
  Object.assign(out, patch)
  if (!c.views.includes(out.view)) out.view = 'flat'
  return out
}

// ---------- 컨트롤 가시성 ----------

export interface VisibleControls {
  /** 빠른 스타일 이름 목록 (빈 배열이면 스타일 줄 숨김) */
  styles: string[]
  count: { label: string; min: number; max: number }
  /** sizeMin / sizeMax / sizeDist 그룹 (caustic 은 숨김) */
  size: boolean
  depth: boolean
  angle: SliderMeta | null
  variation: SliderMeta | null
  gust: boolean
  soft: boolean
  bokeh: { label: string } | null
  ex1: SliderMeta | null
  ex2: SliderMeta | null
  shape: ShapeMeta | null
  /** 길이 1이면 시점 섹션 자체를 숨긴다 */
  views: ViewKey[]
  /** viewX / viewY / persp — flat 이 아닐 때만 */
  viewOpts: boolean
  tilt: boolean
  vpHole: boolean
  /**
   * blurFocus / blurRand 를 보여줄 수 있는 효과인가. 입자 단위 흐림이 없는
   * 효과(caustic)는 거짓이다. blurAmt 가 0 일 때 줄을 접는 것은 패널의 몫이다.
   */
  blurFocusRand: boolean
  vpXLabel: string
  vpYLabel: string
}

export function specVisibleControls(effect: EffectKey, view: ViewKey): VisibleControls {
  const c = CFG[effect]
  const views = c.views
  const v: ViewKey = views.includes(view) ? view : views[0]!
  const toward = v === 'toward'
  return {
    styles: Object.keys(c.styles),
    count: { label: c.count?.label ?? '개수', min: c.count?.min ?? 4, max: c.count?.max ?? 6000 },
    size: !c.noSize,
    depth: !c.noSize,
    // 정면 낙하는 소실점에서 방사로 쏟아지는 그림이라 옆바람·흔들림이 끼어들 자리가 없다.
    angle: c.angle && !toward ? c.angle : null,
    variation: c.variation && !toward ? c.variation : null,
    gust: !!c.gust && !toward,
    soft: USES_SOFT.has(effect),
    bokeh: c.bokeh ?? null,
    // 눈의 '뒤척임'(ex1)도 같은 이유로 평면에서만 뜻이 있다.
    ex1: c.ex1 && !(toward && effect === 'snow') ? c.ex1 : null,
    ex2: c.ex2 ?? null,
    shape: c.shape ?? null,
    views,
    viewOpts: v !== 'flat',
    tilt: v === 'ground',
    vpHole: toward,
    // 물그물은 입자 단위로 그리지 않아 초점/무작위가 뜻이 없다 → 세기만 남긴다
    blurFocusRand: !c.noSize,
    vpXLabel: v === 'ground' ? '좌우 중심 X' : '소실점 X',
    vpYLabel: v === 'ground' ? '지평선 높이 Y' : '소실점 Y',
  }
}
