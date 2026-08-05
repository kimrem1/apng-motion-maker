/**
 * 글자 아틀라스.
 *
 * 글자 하나를 자기 칸에 따로 그려 텍스처 한 장에 격자로 담는다.
 *
 * 왜 글자마다 칸을 나누는가
 *
 * 문장 전체를 한 장에 그려 두고 각 글자의 사각형만 잘라 쓰면 훨씬 간단하다.
 * 그런데 글자가 서로 떨어져 날아오는 모션에서는 그 방식이 무너진다. 이웃 글자의
 * 획이 내 사각형 안으로 조금씩 넘어와 있어서, 글자가 벌어질 때 옆 글자의 획
 * 끄트머리가 유령처럼 딸려 온다. 기울임체나 받침이 큰 한글에서 특히 잘 보인다.
 *
 * 그래서 칸마다 따로 그린다. 칸에는 여백(패딩)을 넉넉히 두어 테두리와 획이
 * 잘리지 않게 한다.
 *
 * 색과 테두리는 구워 넣는다. 흰 마스크로 굽고 셰이더에서 색을 곱하는 방법도
 * 있지만, 그러면 채우기 색과 테두리 색이 다를 때를 표현할 수 없다. 색은 자주
 * 바뀌는 값이 아니므로 바뀔 때 다시 굽는 편이 낫다.
 */

import { cssFontOf, layoutText, rememberTextBox, type TextLayout } from '../text.ts'
import type { TextSpec } from '../types.ts'
import { uploadImageBitmap } from './gl.ts'

/** 한 장에 담을 수 있는 최대 변. 저사양 기기의 텍스처 상한 아래로 잡는다. */
const ATLAS_MAX = 4096

export interface TextRaster {
  texture: WebGLTexture
  /** 아틀라스 픽셀 크기. UV 계산에 쓴다. */
  atlasW: number
  atlasH: number
  /** 한 칸의 크기(px). 여백을 포함한다. */
  cellW: number
  cellH: number
  cols: number
  layout: TextLayout
  /** 굽는 데 쓴 배율. 큰 글자를 상한 안에 넣으려고 줄였을 수 있다. */
  scale: number
}

/** 이 캔버스는 재사용한다. 글자를 칠 때마다 새로 만들면 GC 가 요동친다. */
let scratch: HTMLCanvasElement | OffscreenCanvas | null = null

function getScratch(w: number, h: number): {
  canvas: HTMLCanvasElement | OffscreenCanvas
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D
} {
  if (!scratch) {
    scratch =
      typeof OffscreenCanvas !== 'undefined'
        ? new OffscreenCanvas(w, h)
        : document.createElement('canvas')
  }
  scratch.width = w
  scratch.height = h
  const ctx = scratch.getContext('2d', { willReadFrequently: false }) as
    | CanvasRenderingContext2D
    | OffscreenCanvasRenderingContext2D
    | null
  if (!ctx) throw new Error('글자를 그릴 2D 컨텍스트를 만들지 못했습니다.')
  return { canvas: scratch, ctx }
}

/** 폭 측정용 컨텍스트. 배치는 그리기 전에 끝나야 하므로 따로 둔다. */
let measureCtx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null = null

function getMeasureCtx(): CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D {
  if (measureCtx) return measureCtx
  const canvas =
    typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(8, 8)
      : document.createElement('canvas')
  const ctx = canvas.getContext('2d') as
    | CanvasRenderingContext2D
    | OffscreenCanvasRenderingContext2D
    | null
  if (!ctx) throw new Error('글자를 잴 2D 컨텍스트를 만들지 못했습니다.')
  measureCtx = ctx
  return ctx
}

/** 글자 배치. 폭은 브라우저가 재고 규칙은 core/text.ts 가 정한다. */
export function measureLayout(spec: TextSpec): TextLayout {
  const ctx = getMeasureCtx()
  ctx.font = cssFontOf(spec)
  const cache = new Map<string, number>()
  const layout = layoutText(spec, (char) => {
    const hit = cache.get(char)
    if (hit !== undefined) return hit
    const w = ctx.measureText(char).width
    cache.set(char, w)
    return w
  })
  // 오버스캔 솔버와 레이어 속성 표시가 실측값을 쓰게 한다.
  rememberTextBox(spec, layout.width, layout.height)
  return layout
}

/**
 * 글자를 구워 텍스처로 올린다.
 *
 * 실패하면 던진다. 호출부(렌더러)가 그 레이어만 건너뛴다.
 */
export function bakeText(gl: WebGL2RenderingContext, spec: TextSpec): TextRaster {
  const layout = measureLayout(spec)
  const drawable = layout.glyphs.filter((g) => g.order >= 0)
  const count = Math.max(1, drawable.length)

  /*
   * 칸 크기. 여백은 글자 크기의 40% 다.
   * 테두리(strokeWidth)는 획 바깥으로 절반이 나가고, 기울임체와 한글 받침도
   * 전진폭 밖으로 조금 넘친다. 넉넉히 두지 않으면 가장자리가 잘린다.
   */
  const pad = Math.ceil(spec.fontSize * 0.4 + spec.strokeWidth)
  const maxAdvance = drawable.reduce((m, g) => Math.max(m, g.w), spec.fontSize)
  let cellW = Math.ceil(maxAdvance + pad * 2)
  let cellH = Math.ceil(spec.fontSize * spec.lineHeight + pad * 2)

  const cols = Math.max(1, Math.min(count, Math.floor(ATLAS_MAX / Math.max(1, cellW))))
  const rows = Math.ceil(count / cols)

  /*
   * 상한을 넘으면 통째로 줄여서 굽는다. 글자가 400px 를 넘고 개수도 많으면
   * 격자가 4096 을 넘길 수 있다. 줄여 구운 뒤 그릴 때 다시 키우면 조금 흐려지지만,
   * 텍스처를 못 만들어 글자가 통째로 사라지는 것보다 낫다.
   */
  let scale = 1
  const needH = rows * cellH
  const needW = cols * cellW
  if (needW > ATLAS_MAX || needH > ATLAS_MAX) {
    scale = Math.min(ATLAS_MAX / needW, ATLAS_MAX / needH)
    cellW = Math.max(1, Math.floor(cellW * scale))
    cellH = Math.max(1, Math.floor(cellH * scale))
  }

  const atlasW = Math.max(1, cols * cellW)
  const atlasH = Math.max(1, rows * cellH)

  const { canvas, ctx } = getScratch(atlasW, atlasH)
  ctx.clearRect(0, 0, atlasW, atlasH)
  ctx.save()
  if (scale !== 1) ctx.scale(scale, scale)
  ctx.font = cssFontOf(spec)
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.lineJoin = 'round'
  ctx.miterLimit = 2

  const cellWUnscaled = cellW / scale
  const cellHUnscaled = cellH / scale

  for (let i = 0; i < drawable.length; i += 1) {
    const glyph = drawable[i]!
    const col = i % cols
    const row = Math.floor(i / cols)
    // 칸 한가운데에 그린다. 배치가 정한 자리는 그릴 때가 아니라 쿼드를 놓을 때 쓴다.
    const cx = (col + 0.5) * cellWUnscaled
    const cy = (row + 0.5) * cellHUnscaled

    if (spec.strokeWidth > 0) {
      ctx.strokeStyle = spec.strokeColor
      // canvas 의 lineWidth 는 획 중심 기준이라 절반이 안쪽을 먹는다. 두 배로 긋고
      // 그 위에 채우기를 덮으면 사용자가 정한 두께가 바깥에 그대로 남는다.
      ctx.lineWidth = spec.strokeWidth * 2
      ctx.strokeText(glyph.char, cx, cy)
    }
    ctx.fillStyle = spec.color
    ctx.fillText(glyph.char, cx, cy)
  }
  ctx.restore()

  /*
   * 캔버스를 그대로 올린다. transferToImageBitmap 을 거치면 사본이 한 장 더 생기고
   * 캔버스 내용이 비워져 재사용이 까다로워진다. texImage2D 는 캔버스를 직접 받는다.
   * 알파는 straight 로 올라온다(gl.ts 의 픽셀 저장 정책). LAYER_FS 와 같은 계약이다.
   */
  const uploaded = uploadImageBitmap(gl, canvas as unknown as ImageBitmap)

  return {
    texture: uploaded.texture,
    atlasW,
    atlasH,
    cellW,
    cellH,
    cols,
    layout,
    scale,
  }
}

/**
 * 글자 레이어의 텍스처 캐시.
 *
 * 키는 값이다. 같은 글자 같은 모양이면 레이어가 달라도 한 장을 나눠 쓴다.
 * 도형 세트처럼 같은 글자를 여러 장 얹는 쓰임이 흔하다.
 */
export class TextRasterCache {
  private readonly gl: WebGL2RenderingContext
  private readonly map = new Map<string, TextRaster>()
  /** 이번 프레임에 실제로 쓰인 키. 안 쓰인 것은 몇 프레임 뒤 버린다. */
  private readonly used = new Set<string>()
  private idle = 0

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl
  }

  /** 색과 테두리까지 포함한 키. 이것이 바뀌면 다시 구워야 한다. */
  static keyOf(spec: TextSpec): string {
    return [
      spec.content,
      spec.fontFamily,
      spec.fontSize,
      spec.weight,
      spec.italic ? 'i' : 'n',
      spec.letterSpacing,
      spec.lineHeight,
      spec.align,
      spec.color,
      spec.strokeWidth,
      spec.strokeColor,
    ].join('|')
  }

  get(spec: TextSpec): TextRaster {
    const key = TextRasterCache.keyOf(spec)
    this.used.add(key)
    const hit = this.map.get(key)
    if (hit) return hit
    const baked = bakeText(this.gl, spec)
    this.map.set(key, baked)
    return baked
  }

  /**
   * 프레임 경계. 오래 안 쓰인 텍스처를 놓아 준다.
   *
   * 글자를 타이핑하면 키가 글자마다 새로 생긴다. 정리하지 않으면 "안녕하세요" 를
   * 치는 동안 다섯 장이 남는다.
   */
  endFrame(): void {
    this.idle += 1
    if (this.idle < 60) return
    this.idle = 0
    for (const [key, raster] of this.map) {
      if (this.used.has(key)) continue
      this.gl.deleteTexture(raster.texture)
      this.map.delete(key)
    }
    this.used.clear()
  }

  dispose(): void {
    for (const raster of this.map.values()) this.gl.deleteTexture(raster.texture)
    this.map.clear()
    this.used.clear()
  }
}
