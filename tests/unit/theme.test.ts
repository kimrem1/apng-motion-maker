/**
 * 무채색 테마가 지켜야 하는 것.
 *
 * 색을 다 뺀 화면에서 상태 구분을 지탱하는 것은 밝기 하나뿐이다. 그래서 밝기 차이는
 * 취향이 아니라 계약이다. 여기서 그 계약을 수치로 붙잡는다.
 *
 * CSS 는 여기서 못 읽는다(테스트 환경에 DOM 이 없다). 대신 타임라인이 CSS 변수를
 * 못 읽을 때 쓰는 THEME_FALLBACK 을 검사한다. 그 표는 tokens.css 를 그대로 옮긴
 * 것이라, 여기가 통과하면 팔레트 자체가 통과한 것이다.
 */

import { describe, expect, it } from 'vitest'

import {
  drawTimeline,
  readTheme,
  selectionId,
  type TimelineDrawOptions,
  type TimelineModel,
} from '@/ui/timeline/timelineDraw.ts'

// ---------------------------------------------------------------------------
// 대비 계산
// ---------------------------------------------------------------------------

function channel(v: number): number {
  const c = v / 255
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

function luminance(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16)
  return (
    0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255)
  )
}

function contrast(a: string, b: string): number {
  const l1 = luminance(a)
  const l2 = luminance(b)
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
}

/** 색이 조금이라도 섞였는가. 무채색이면 세 채널이 같다. */
function chroma(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16)
  const r = (n >> 16) & 255
  const g = (n >> 8) & 255
  const b = n & 255
  return Math.max(r, g, b) - Math.min(r, g, b)
}

// ---------------------------------------------------------------------------
// 2D 컨텍스트 대역
// ---------------------------------------------------------------------------

interface Painted {
  op: 'fill' | 'stroke'
  style: string
  lineWidth: number
}

/**
 * 그리기 명령을 받아 적기만 하는 가짜 컨텍스트.
 *
 * 픽셀을 만들지 않는다. 알고 싶은 것은 "무슨 색으로 칠했나" 뿐이고, 그건 명령을
 * 받아 적는 것으로 충분하다. 픽셀을 만들면 node 에 canvas 를 붙여야 한다.
 */
function stubContext(): { ctx: CanvasRenderingContext2D; painted: Painted[] } {
  const painted: Painted[] = []
  const state = { fillStyle: '#000000', strokeStyle: '#000000', lineWidth: 1 }

  const target = {
    fill: () => painted.push({ op: 'fill', style: state.fillStyle, lineWidth: state.lineWidth }),
    stroke: () =>
      painted.push({ op: 'stroke', style: state.strokeStyle, lineWidth: state.lineWidth }),
    fillRect: () => painted.push({ op: 'fill', style: state.fillStyle, lineWidth: 0 }),
    measureText: () => ({ width: 20 }),
  }

  const ctx = new Proxy(target, {
    get(t, key) {
      if (key in t) return (t as Record<string | symbol, unknown>)[key]
      if (key in state) return state[key as keyof typeof state]
      // 나머지 명령(beginPath, arc, save, ...)은 전부 빈 함수로 삼킨다.
      return () => undefined
    },
    set(_t, key, value) {
      if (key in state) state[key as keyof typeof state] = value as never
      return true
    },
  }) as unknown as CanvasRenderingContext2D

  return { ctx, painted }
}

function model(): TimelineModel {
  return {
    layerId: 'L1',
    layerName: '레이어',
    fps: 30,
    durationFrames: 60,
    rows: [
      {
        prop: 'translateX',
        label: '가로 위치',
        unit: 'px',
        keys: [
          { f: 0, v: 0, interp: 'linear' },
          { f: 30, v: 100, interp: 'linear' },
        ],
      },
    ],
  }
}

function options(selected: ReadonlySet<string>): TimelineDrawOptions {
  return {
    theme: readTheme(null),
    width: 600,
    height: 200,
    geo: { rulerH: 24, rowH: 22, axis: { originX: 120, pxPerFrame: 8, scrollFrame: 0 } },
    model: model(),
    playhead: 10,
    selected,
    hovered: null,
    loopMode: 'loop',
  }
}

// ---------------------------------------------------------------------------

describe('무채색 팔레트', () => {
  const theme = readTheme(null)

  it('UI 색은 전부 무채색이다', () => {
    const colored: string[] = []
    for (const [key, value] of Object.entries(theme)) {
      if (!value.startsWith('#')) continue
      if (chroma(value) !== 0) colored.push(`${key}=${value}`)
    }
    expect(colored).toEqual([])
  })

  it('글자는 다섯 표면 어디에서도 본문 기준 4.5:1 을 넘는다', () => {
    const surfaces = [theme.bg, theme.surface, theme.surfaceRaised, theme.surfaceHover]
    const inks = [theme.text, theme.textMuted, theme.textFaint, theme.accent, theme.danger, theme.warn]
    for (const ink of inks) {
      for (const surface of surfaces) {
        expect(contrast(ink, surface), `${ink} on ${surface}`).toBeGreaterThanOrEqual(4.5)
      }
    }
  })

  it('컨트롤 경계는 앉는 표면마다 3:1 을 넘는다', () => {
    // WCAG 2.2 의 1.4.11. 입력칸과 버튼의 테두리가 여기 걸린다.
    for (const surface of [theme.bg, theme.surface, theme.surfaceRaised, theme.surfaceHover]) {
      expect(contrast(theme.borderStrong, surface), surface).toBeGreaterThanOrEqual(3)
    }
  })

  it('경고와 위험은 밝기로 갈린다', () => {
    // 색으로 못 가르니 밝기로 가른다. 같은 밝기면 두 등급이 같은 상자가 된다.
    expect(luminance(theme.danger)).toBeGreaterThan(luminance(theme.warn))
  })
})

describe('무채색에서의 타임라인', () => {
  it('선택된 키는 채움과 테가 서로 3:1 이상 벌어진다', () => {
    /*
     * 선택 표시는 밝은 채움 + 그 바깥의 밝은 링이다. 둘 사이의 테가 어두워야
     * 두 밝은 면이 한 덩어리로 뭉치지 않는다. 예전에는 이 테가 --text 였는데,
     * 무채색 팔레트에서 --text 와 --accent 는 1.06:1 이라 테가 사라졌다.
     */
    const { ctx, painted } = stubContext()
    const opts = options(new Set([selectionId('translateX', 0)]))
    drawTimeline(ctx, opts)

    const theme = opts.theme
    const rim = painted.find((p) => p.op === 'stroke' && p.style === theme.bg)
    expect(rim, '선택된 키의 어두운 테').toBeDefined()

    expect(contrast(theme.accent, theme.bg)).toBeGreaterThanOrEqual(3)
    expect(contrast(theme.focus, theme.bg)).toBeGreaterThanOrEqual(3)
  })

  it('선택되지 않은 키는 어두운 테를 쓰지 않는다', () => {
    // 안 고른 키는 어두운 표면 위의 어두운 점이라, 테까지 어두우면 안 보인다.
    const { ctx, painted } = stubContext()
    const opts = options(new Set())
    drawTimeline(ctx, opts)

    expect(painted.some((p) => p.op === 'stroke' && p.style === opts.theme.bg)).toBe(false)
    expect(painted.some((p) => p.op === 'stroke' && p.style === opts.theme.borderStrong)).toBe(true)
  })
})
