/**
 * J. 글자.
 *
 * 글자 레이어를 위한 프리셋이다. 이미지나 도형에 걸면 아무 일도 일어나지 않는다
 * (charIn 트랙은 글자 레이어만 읽는다). 그래서 갤러리가 글자 레이어를 골랐을 때만
 * 이 카테고리를 보여 준다.
 *
 * ---------------------------------------------------------------------------
 * 구조
 * ---------------------------------------------------------------------------
 * 전부 같은 뼈대다. **모양은 charAnim 이 정하고 시간은 charIn 트랙이 민다.**
 * 그래서 세기/속도 슬라이더를 아무리 끌어도 글자가 들어오는 방향이 바뀌지 않는다.
 *
 *   charAnim : 어느 쪽에서, 얼마나 멀리서, 어떤 순서로  (모양)
 *   charIn   : 0 -> 1  (시간)
 *
 * 세기(strength)는 거리와 시간차에 걸린다. 세게 하면 더 멀리서, 더 늦게 따라온다.
 *
 * ---------------------------------------------------------------------------
 * 왜 이징이 프리셋마다 다른가
 * ---------------------------------------------------------------------------
 * 글자가 "날아와 멈추는" 느낌은 거의 전부 감속 곡선에서 나온다. 등속으로 들어오면
 * 글자가 미끄러지는 것처럼 보이고, 오버슈트를 주면 부딪혀 튕기는 것처럼 보인다.
 * 그래서 같은 방향이라도 곡선이 다르면 완전히 다른 모션이 된다.
 */

import { createCharAnimSpec } from '@/core/charAnim.ts'
import type { CharInMode, CharOrder } from '@/core/types.ts'
import type { MotionPreset, PresetEmission } from '@/motions/types.ts'
import {
  bool,
  buildKeys,
  clamp,
  emitDuration,
  gainOf,
  lastFrame,
  loopFor,
  num,
  resolveSpan,
  str,
  track,
} from './shared.ts'

/** 등장 순서 선택지. 프리셋마다 같은 목록을 쓴다. */
const ORDER_OPTIONS = [
  { value: 'forward', label: '앞에서부터' },
  { value: 'backward', label: '뒤에서부터' },
  { value: 'center', label: '가운데에서' },
  { value: 'edges', label: '양끝에서' },
  { value: 'random', label: '무작위' },
] as const

const ORDER_VALUES: readonly CharOrder[] = ['forward', 'backward', 'center', 'edges', 'random']

function orderOf(params: unknown, fallback: CharOrder = 'forward'): CharOrder {
  const raw = str(params as never, 'order', fallback)
  return ORDER_VALUES.includes(raw as CharOrder) ? (raw as CharOrder) : fallback
}

/**
 * 글자 등장 프리셋 한 종을 만든다.
 *
 * 열 몇 종이 같은 코드를 복사해 다닐 이유가 없다. 다른 것은 이름과 기본값,
 * 그리고 곡선뿐이다.
 */
function textPreset(args: {
  id: string
  label: string
  hint: string
  mode: CharInMode
  /** 진행률 곡선. 여기서 느낌이 갈린다. */
  ease: string
  durationMs: number
  /** 세기 1 일 때의 출발 거리(글자 크기 배수). 0 이면 거리 노브를 숨긴다. */
  distance: number
  stagger: number
  rotate?: number
  scale?: number
  order?: CharOrder
  /** 들어오면서 흐렸다가 또렷해지는가. 레이어 전체 투명도로 준다. */
  fade?: boolean
  size?: MotionPreset['size']
}): MotionPreset {
  const hasDistance = args.distance > 0
  return {
    id: args.id,
    label: args.label,
    hint: args.hint,
    category: 'text',
    tags: ['text'],
    loopSafe: 'once',
    // 글자별 움직임은 상자 **안**에서 일어난다. 레이어 변환은 제자리라 담기 솔버가
    // 개입할 일이 없다. allowEmpty 로 두면 '일부러 프레임을 벗어나는 프리셋' 으로
    // 잘못 분류된다.
    overscan: 'auto',
    easy: true,
    size: args.size ?? 'light',
    defaultDurationMs: args.durationMs,
    params: [
      { key: 'order', label: '들어오는 순서', type: 'select', options: [...ORDER_OPTIONS], default: args.order ?? 'forward' },
      { key: 'stagger', label: '글자 시간차', type: 'number', min: 0, max: 1, step: 0.05, default: args.stagger },
      ...(hasDistance
        ? [
            {
              key: 'distance',
              label: '출발 거리',
              type: 'number' as const,
              min: 0,
              max: 4,
              step: 0.1,
              default: args.distance,
            },
          ]
        : []),
      { key: 'fade', label: '흐리게 시작', type: 'boolean', default: args.fade ?? true },
    ],
    emit(ctx): PresetEmission {
      const span = resolveSpan(ctx, args.durationMs)
      const end = lastFrame(span, 'once')
      const gain = gainOf(ctx.strength)

      const distance = hasDistance
        ? clamp(num(ctx.params, 'distance', args.distance) * gain, 0, 8)
        : 0
      // 거리를 안 쓰는 모양(회전 / 확대 / 뒤집기)도 세기가 뭔가를 해야 한다.
      // 각도와 배율을 기본값과 1(항등) 사이에서 세기만큼 민다.
      const rotate = (args.rotate ?? 0) * gain
      const scale = 1 + ((args.scale ?? 1) - 1) * gain
      const stagger = clamp(num(ctx.params, 'stagger', args.stagger), 0, 1)

      const tracks = [
        // 진행률은 0 에서 1 로 한 번만 간다. 곡선이 느낌을 정한다.
        track('charIn', 'ratio', buildKeys([{ f: 0, v: 0 }, { f: end, v: 1 }], args.ease)),
      ]

      /*
       * 레이어 전체 투명도는 **글자별 투명도와 다른 축이다.**
       * 글자별 투명도는 charAnim 이 자동으로 걸고, 이쪽은 상자 전체가 스르륵 뜨는
       * 느낌을 더한다. 둘을 같이 쓰면 첫 글자가 두 번 옅어져 부자연스러워서,
       * 레이어 페이드는 앞 30% 안에서 빨리 끝낸다.
       */
      if (bool(ctx.params, 'fade', args.fade ?? true)) {
        const cut = clamp(Math.round(end * 0.3), 1, end)
        tracks.push(
          track('opacity', 'ratio', buildKeys([{ f: 0, v: 0 }, { f: cut, v: 1 }], 'easeOutQuad')),
        )
      }

      return {
        tracks,
        charAnim: createCharAnimSpec(args.mode, {
          stagger,
          distance,
          rotate,
          scale,
          order: orderOf(ctx.params, args.order ?? 'forward'),
          // 시드는 레이어마다 달라야 같은 화면의 두 줄이 똑같이 흩어지지 않는다.
          seed: ctx.seed & 0xffff,
        }),
        durationFrames: emitDuration(span, tracks),
        suggestedLoop: loopFor('once'),
      }
    },
  }
}

// ---------------------------------------------------------------------------
// 한 방향에서
// ---------------------------------------------------------------------------

const slideLeft = textPreset({
  id: 'text.slideLeft',
  label: '왼쪽에서 밀려들어오기',
  hint: '글자가 왼쪽에서 차례로 미끄러져 들어와 제자리에 선다.',
  mode: 'left',
  ease: 'easeOutQuint',
  durationMs: 900,
  distance: 1.4,
  stagger: 0.45,
})

const slideRight = textPreset({
  id: 'text.slideRight',
  label: '오른쪽에서 밀려들어오기',
  hint: '오른쪽에서 들어온다. 뒤에서부터 순서를 바꾸면 흘러가는 느낌이 난다.',
  mode: 'right',
  ease: 'easeOutQuint',
  durationMs: 900,
  distance: 1.4,
  stagger: 0.45,
  order: 'backward',
})

const slideUp = textPreset({
  id: 'text.slideUp',
  label: '아래에서 올라오기',
  hint: '자막이 아래에서 밀려 올라오는 가장 흔한 방식이다.',
  mode: 'down',
  ease: 'easeOutQuint',
  durationMs: 850,
  distance: 1,
  stagger: 0.4,
})

const slideDown = textPreset({
  id: 'text.slideDown',
  label: '위에서 내려오기',
  hint: '위에서 떨어져 내려온다.',
  mode: 'up',
  ease: 'easeOutQuint',
  durationMs: 850,
  distance: 1,
  stagger: 0.4,
})

// ---------------------------------------------------------------------------
// 여러 방향에서
// ---------------------------------------------------------------------------

const scatter = textPreset({
  id: 'text.scatter',
  label: '사방에서 모이기',
  hint: '글자마다 다른 방향에서 날아와 한 줄로 모인다. 시드가 방향을 정한다.',
  mode: 'scatter',
  ease: 'easeOutQuint',
  durationMs: 1100,
  distance: 2.2,
  stagger: 0.35,
  order: 'random',
  size: 'normal',
})

const scatterSpin = textPreset({
  id: 'text.scatterSpin',
  label: '돌면서 사방에서 모이기',
  hint: '사방에서 날아오며 각자 한 바퀴 돈다. 흩날리는 종이 같은 느낌이다.',
  mode: 'scatter',
  ease: 'easeOutQuart',
  durationMs: 1300,
  distance: 2.4,
  stagger: 0.4,
  rotate: 240,
  order: 'random',
  size: 'normal',
})

const sides = textPreset({
  id: 'text.sides',
  label: '좌우에서 번갈아',
  hint: '홀수 글자는 왼쪽, 짝수 글자는 오른쪽에서 들어와 맞물린다.',
  mode: 'sides',
  ease: 'easeOutQuint',
  durationMs: 1000,
  distance: 1.8,
  stagger: 0.35,
})

const updown = textPreset({
  id: 'text.updown',
  label: '위아래에서 번갈아',
  hint: '한 글자씩 위와 아래에서 엇갈려 들어온다.',
  mode: 'updown',
  ease: 'easeOutQuint',
  durationMs: 1000,
  distance: 1.2,
  stagger: 0.35,
})

const fromCenter = textPreset({
  id: 'text.fromCenter',
  label: '가운데에서 퍼지기',
  hint: '가운데 글자가 먼저 서고 바깥으로 번져 나간다.',
  mode: 'scatter',
  ease: 'easeOutQuint',
  durationMs: 1000,
  distance: 1.6,
  stagger: 0.4,
  order: 'center',
})

// ---------------------------------------------------------------------------
// 제자리에서
// ---------------------------------------------------------------------------

const typewriter = textPreset({
  id: 'text.typewriter',
  label: '타자기',
  hint: '한 글자씩 딱딱 나타난다. 움직이지 않는다.',
  mode: 'typewriter',
  // 등속이어야 타이핑 리듬이 일정하다. 가속을 넣으면 뒤로 갈수록 빨라진다.
  ease: 'linear',
  durationMs: 1200,
  distance: 0,
  stagger: 1,
  fade: false,
})

const fadeIn = textPreset({
  id: 'text.fade',
  label: '차례로 밝아지기',
  hint: '자리는 그대로 두고 한 글자씩 밝아진다. 가장 조용한 등장이다.',
  mode: 'fade',
  ease: 'easeOutQuad',
  durationMs: 1000,
  distance: 0,
  stagger: 0.6,
  fade: false,
})

const drop = textPreset({
  id: 'text.drop',
  label: '떨어져 튕기기',
  hint: '위에서 떨어져 바닥에 부딪히듯 한 번 튕긴다.',
  mode: 'drop',
  ease: 'bounceOut',
  durationMs: 1200,
  distance: 1.6,
  stagger: 0.4,
  size: 'normal',
})

const pop = textPreset({
  id: 'text.pop',
  label: '톡톡 튀어나오기',
  hint: '작게 시작해 살짝 넘쳤다가 제자리 크기를 잡는다.',
  mode: 'zoom',
  ease: 'popBack',
  durationMs: 900,
  distance: 0,
  stagger: 0.45,
  scale: 0.2,
})

const zoomIn = textPreset({
  id: 'text.zoomIn',
  label: '멀리서 다가오기',
  hint: '작은 점에서 커지며 다가온다. 가운데에서부터 퍼지면 더 세다.',
  mode: 'zoom',
  ease: 'easeOutQuint',
  durationMs: 1000,
  distance: 0,
  stagger: 0.4,
  scale: 0.05,
  order: 'center',
})

const zoomOut = textPreset({
  id: 'text.zoomOut',
  label: '크게 왔다 제자리로',
  hint: '화면을 덮을 만큼 크게 시작해 제자리 크기로 줄어든다.',
  mode: 'shrink',
  ease: 'easeOutQuint',
  durationMs: 950,
  distance: 0,
  stagger: 0.35,
  scale: 4,
  size: 'normal',
})

const spin = textPreset({
  id: 'text.spin',
  label: '제자리에서 돌기',
  hint: '자리는 그대로 두고 글자마다 한 바퀴 돈다.',
  mode: 'spin',
  ease: 'easeOutQuart',
  durationMs: 1100,
  distance: 0,
  stagger: 0.4,
  rotate: 360,
})

const flip = textPreset({
  id: 'text.flip',
  label: '카드처럼 뒤집히기',
  hint: '가로로 눌린 상태에서 펴진다. 글자 카드가 한 장씩 도는 느낌이다.',
  mode: 'flip',
  ease: 'easeOutQuart',
  durationMs: 1000,
  distance: 0,
  stagger: 0.5,
})

const wave = textPreset({
  id: 'text.wave',
  label: '물결치듯',
  hint: '위아래로 엇갈려 출렁이며 자리를 잡는다.',
  mode: 'wave',
  ease: 'easeOutBack',
  durationMs: 1100,
  distance: 0.6,
  stagger: 0.55,
})

export const TEXT_PRESETS: MotionPreset[] = [
  slideLeft,
  slideRight,
  slideUp,
  slideDown,
  scatter,
  scatterSpin,
  sides,
  updown,
  fromCenter,
  typewriter,
  fadeIn,
  drop,
  pop,
  zoomIn,
  zoomOut,
  spin,
  flip,
  wave,
]
