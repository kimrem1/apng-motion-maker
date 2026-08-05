/**
 * 이징 프리셋 팔레트.
 *
 * 각 프리셋은 정본(Penner 닫힌 수식 또는 스프링)과 표시용 베지어 근사를 함께 갖는다.
 * 평가는 정본으로 하고, 베지어는 그래프 에디터의 핸들 초기값과 CSS 복사에 쓴다.
 * 두 표현의 오차는 테스트가 감시한다.
 */

import type { Handle, Interp, SpringSpec } from '@/core/types.ts'
import { PENNER, type EasingFn } from './penner.ts'
import { createSpringEasing } from './spring.ts'

export interface EasingPreset {
  id: string
  /** 사용자에게 보이는 이름. 내부 id 는 UI 에 노출하지 않는다. */
  label: string
  /** 언제 쓰는지. 툴팁에 쓴다. */
  hint: string
  interp: Interp
  /** interp 가 bezier 일 때의 핸들 */
  handles?: { out: Handle; in: Handle }
  /** interp 가 spring 일 때의 파라미터 */
  spring?: SpringSpec
  /** 평가 정본. bezier 프리셋도 Penner 수식이 있으면 그쪽을 쓴다. */
  canonical?: EasingFn
  /** EASY 모드 칩으로 노출할지 */
  chip: boolean
}

function springSpec(visualDuration: number, bounce: number): SpringSpec {
  return {
    mode: 'visual',
    stiffness: 100,
    damping: 10,
    mass: 1,
    visualDuration,
    bounce,
    fit: 'fitToDuration',
    bakeSamples: 129,
  }
}

const h = (x1: number, y1: number, x2: number, y2: number): { out: Handle; in: Handle } => ({
  out: { x: x1, y: y1 },
  in: { x: x2, y: y2 },
})

export const EASING_PRESETS: EasingPreset[] = [
  {
    id: 'linear',
    label: '균등',
    hint: '처음부터 끝까지 같은 속도. 무한 회전과 무한 스크롤에만 쓴다.',
    interp: 'linear',
    handles: h(0.33, 0.33, 0.67, 0.67),
    canonical: PENNER.linear,
    chip: true,
  },
  {
    id: 'easeOutExpo',
    label: '부드럽게 끝',
    hint: '빠르게 출발해 길게 감속. 가장 세련되게 읽히는 기본값이다.',
    interp: 'bezier',
    handles: h(0.16, 1, 0.3, 1),
    canonical: PENNER.easeOutExpo,
    chip: true,
  },
  {
    id: 'easeOutQuint',
    label: '부드럽게 끝 (약하게)',
    hint: 'easeOutExpo 보다 앞쪽 몰림이 덜하다. 프레임이 부족할 때.',
    interp: 'bezier',
    handles: h(0.22, 1, 0.36, 1),
    canonical: PENNER.easeOutQuint,
    chip: false,
  },
  {
    id: 'easeInOutCubic',
    label: '양끝 부드럽게',
    hint: '천천히 시작해 천천히 멈춘다. 왕복 루프의 기본.',
    interp: 'bezier',
    handles: h(0.65, 0, 0.35, 1),
    canonical: PENNER.easeInOutCubic,
    chip: true,
  },
  {
    id: 'easeInOutQuart',
    label: '양끝 부드럽게 (강하게)',
    hint: '중간 구간이 더 빠르다. 좌우 이동에 어울린다.',
    interp: 'bezier',
    handles: h(0.76, 0, 0.24, 1),
    canonical: PENNER.easeInOutQuart,
    chip: false,
  },
  {
    id: 'easeInExpo',
    label: '점점 빠르게',
    hint: '사라질 때. 마지막에 확 빠져나간다.',
    interp: 'bezier',
    handles: h(0.7, 0, 0.84, 0),
    canonical: PENNER.easeInExpo,
    chip: false,
  },
  {
    id: 'easeOutCirc',
    label: '툭 멈추기',
    hint: '거의 등속으로 가다 끝에서만 멈춘다.',
    interp: 'bezier',
    handles: h(0, 0.55, 0.45, 1),
    canonical: PENNER.easeOutCirc,
    chip: false,
  },
  {
    id: 'popBack',
    label: '톡 튀기',
    hint: '목표를 살짝 넘었다가 돌아온다. 등장 모션의 쫀득함은 여기서 나온다.',
    interp: 'bezier',
    // easeOutBack 기본값(1.56)은 오버슈트가 약 10% 로 세다.
    // 1.25 로 낮춘 커스텀을 기본으로 둔다.
    handles: h(0.34, 1.25, 0.64, 1),
    chip: true,
  },
  {
    id: 'easeOutBack',
    label: '크게 튀기',
    hint: '오버슈트가 크다. 강조하고 싶을 때만.',
    interp: 'bezier',
    handles: h(0.34, 1.56, 0.64, 1),
    canonical: PENNER.easeOutBack,
    chip: false,
  },
  {
    id: 'easeOutBounce',
    label: '탱탱볼',
    hint: '바닥에 몇 번 튕긴다. 장난스러운 느낌.',
    interp: 'bezier',
    handles: h(0.34, 1.56, 0.64, 1),
    canonical: PENNER.easeOutBounce,
    chip: true,
  },
  {
    id: 'easeOutElastic',
    label: '고무줄',
    hint: '길게 진동한다. 짧은 지속시간에서는 지저분해진다.',
    interp: 'bezier',
    handles: h(0.34, 1.56, 0.64, 1),
    canonical: PENNER.easeOutElastic,
    chip: false,
  },
  {
    id: 'springSoft',
    label: '스프링 (부드럽게)',
    hint: '물리 기반. 오버슈트가 약하고 빨리 정착한다.',
    interp: 'spring',
    spring: springSpec(0.4, 0.15),
    chip: true,
  },
  {
    id: 'springBouncy',
    label: '스프링 (탱글하게)',
    hint: '물리 기반. 오버슈트가 크고 여러 번 흔들린다.',
    interp: 'spring',
    spring: springSpec(0.5, 0.45),
    chip: false,
  },
  {
    id: 'hold',
    label: '뚝 끊기',
    hint: '다음 키프레임까지 값을 붙잡는다. 스톱모션 룩.',
    interp: 'hold',
    chip: false,
  },
]

export const EASING_PRESET_BY_ID = new Map(EASING_PRESETS.map((p) => [p.id, p]))

export const CHIP_PRESETS = EASING_PRESETS.filter((p) => p.chip)

/** 프리셋의 평가 함수. 정본이 있으면 정본, 없으면 베지어 근사. */
export function presetEasing(preset: EasingPreset): EasingFn {
  if (preset.canonical) return preset.canonical
  if (preset.interp === 'spring' && preset.spring) return createSpringEasing(preset.spring)
  if (preset.interp === 'hold') return () => 0
  if (preset.handles) {
    const { out, in: inH } = preset.handles
    // 지연 import 를 피하려고 여기서만 동적으로 만든다.
    return bezierOf(out.x, out.y, inH.x, inH.y)
  }
  return PENNER.linear!
}

// presets.ts 가 bezier.ts 를 직접 import 하면 순환이 생기지 않지만,
// 프리셋 정의부와 평가부를 분리해 두는 편이 읽기 쉽다.
import { getBezierEasing } from './bezier.ts'
function bezierOf(x1: number, y1: number, x2: number, y2: number): EasingFn {
  return getBezierEasing(x1, y1, x2, y2)
}

/**
 * 무한 루프에서 쓰면 안 되는 프리셋.
 * 매 사이클 시작마다 급가속이 반복되어 눈에 거슬린다.
 */
export function isLoopSafe(presetId: string, loopMode: string): boolean {
  if (loopMode !== 'loop') return true
  return presetId === 'linear'
}
