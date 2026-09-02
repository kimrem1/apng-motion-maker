/**
 * 스프라이트 캐시(LRU · 개수와 메모리 상한)와 입자 비트맵 공장.
 *
 * 크기·흐림을 잘게 나누면 입자마다 다른 스프라이트가 생겨 캐시가 매 프레임 뒤집힌다.
 * 작을 때는 절대 단계, 커지면 비율 단계(5.5%)로 사다리를 만들어 서로 나눠 쓰게 한다.
 * 큰 입자에서 5% 차이는 눈에 띄지 않지만 캐시 적중률은 수 배로 올라간다.
 * 키에 양자화된 파라미터가 전부 들어가므로 오래된 항목이 잘못 그려질 일은 없다 —
 * 지우는 것은 메모리 문제일 뿐이다.
 */
import { TAU, clamp } from './util'

const LQS = Math.log(1.055)
const qsize = (v: number, min: number): number =>
  v <= min * 8
    ? Math.round(v / min) * min
    : Math.round(Math.exp(Math.round(Math.log(v) / LQS) * LQS) * 100) / 100

// 흐림은 절대 픽셀이 아니라 '크기 대비 비율' 사다리로 스냅한다. 절대값으로 나누면
// 크기 사다리와 곱해져 조합이 폭발하지만, 비율로 묶으면 큰 입자와 작은 입자가 같은 칸을 쓴다.
const BRAT = [0, 0.05, 0.10, 0.16, 0.24, 0.34, 0.46, 0.60, 0.78, 1.00, 1.30, 1.70, 2.20]
function qblur(v: number, px: number): number {
  if (!(v > 0.15)) return 0
  const r = v / Math.max(px, 0.3)
  let b = 0
  let d = 1e9
  for (const br of BRAT) {
    const e = Math.abs(br - r)
    if (e < d) {
      d = e
      b = br
    }
  }
  const out = Math.round(b * px * 100) / 100
  return out > 0.15 ? out : 0
}

export function hexPath(
  g: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  rot: number,
): void {
  g.beginPath()
  for (let k = 0; k < 6; k++) {
    const a = rot + (k * Math.PI) / 3
    const X = cx + Math.cos(a) * r
    const Y = cy + Math.sin(a) * r
    if (k) g.lineTo(X, Y)
    else g.moveTo(X, Y)
  }
  g.closePath()
}

const ctx2d = (c: HTMLCanvasElement): CanvasRenderingContext2D => {
  const g = c.getContext('2d')
  if (!g) throw new Error('2d context unavailable')
  return g
}

// 개수만으로 끊으면 두 가지가 동시에 어긋난다. 작은 스프라이트는 한 프레임 분량이 상한을 넘겨
// 매 프레임 전부 다시 그려지고, 큰 스프라이트는 몇 백 장만으로 수 GB를 물고 있는다.
// 그래서 개수와 픽셀 총량을 함께 본다.
const SPRITE_MAX = 4096
const SPRITE_PX_MAX = 48e6

export class SpriteCache {
  private map = new Map<string, HTMLCanvasElement>()
  private px = 0

  clear(): void {
    this.map = new Map()
    this.px = 0
  }

  private get(k: string): HTMLCanvasElement | undefined {
    const v = this.map.get(k)
    if (v !== undefined) {
      this.map.delete(k)
      this.map.set(k, v)
    }
    return v
  }

  private set(k: string, v: HTMLCanvasElement): HTMLCanvasElement {
    this.map.set(k, v)
    this.px += v.width * v.height
    if (this.map.size > SPRITE_MAX || this.px > SPRITE_PX_MAX)
      for (const [ok, ov] of this.map) {
        if (this.map.size <= SPRITE_MAX * 0.85 && this.px <= SPRITE_PX_MAX * 0.85) break
        if (ok === k) continue // 방금 넣은 것은 곧바로 쓰이므로 남긴다
        this.map.delete(ok)
        this.px -= ov.width * ov.height
      }
    return v
  }

  /** 둥근 입자. soft 0=또렷한 원반(보케) … 1=부드러운 글로우. blur>0이면 아웃포커스. rim=조리개 테두리. */
  disc(
    px: number,
    soft: number,
    css: string,
    blur: number,
    shape: string,
    rim: number,
  ): HTMLCanvasElement {
    px = Math.max(0.3, qsize(px, 0.25))
    blur = qblur(blur || 0, px)
    soft = Math.round(clamp(soft, 0, 1) * 8) / 8
    rim = Math.round(clamp(rim || 0, 0, 1) * 4) / 4
    shape = shape || 'round'
    const key = 'd' + px + '|' + soft + '|' + blur + '|' + shape + '|' + rim + '|' + css
    const hit = this.get(key)
    if (hit) return hit
    const R = px
    const pad = Math.ceil(blur * 2.6) + 2
    const S = Math.max(3, Math.ceil(R * 2) + 2 + pad * 2)
    const c = document.createElement('canvas')
    c.width = c.height = S
    const g = ctx2d(c)
    const cx = S / 2
    if (blur > 0) g.filter = 'blur(' + blur + 'px)'
    if (shape === 'hex' && R >= 3) {
      hexPath(g, cx, cx, R, 0.26)
      const grd = g.createRadialGradient(cx, cx, 0, cx, cx, R)
      grd.addColorStop(0, 'rgba(' + css + ',' + (0.92 - 0.48 * soft).toFixed(3) + ')')
      grd.addColorStop(0.72, 'rgba(' + css + ',' + (0.88 - 0.44 * soft).toFixed(3) + ')')
      grd.addColorStop(1, 'rgba(' + css + ',' + (0.96 - 0.5 * soft).toFixed(3) + ')')
      g.fillStyle = grd
      g.fill()
      if (rim > 0) {
        g.strokeStyle = 'rgba(' + css + ',' + clamp(rim, 0, 1).toFixed(3) + ')'
        g.lineWidth = Math.max(0.7, R * 0.13)
        g.stroke()
      }
    } else if (shape === 'ring' && R >= 3) {
      g.strokeStyle = 'rgba(' + css + ',0.92)'
      g.lineWidth = Math.max(0.8, R * (0.30 - 0.15 * soft))
      g.beginPath()
      g.arc(cx, cx, R * 0.80, 0, TAU)
      g.stroke()
    } else {
      const c0 = clamp(1 - (0.05 + 0.62 * soft), 0.02, 0.97)
      const grd = g.createRadialGradient(cx, cx, 0, cx, cx, R)
      grd.addColorStop(0, 'rgba(' + css + ',0.97)')
      grd.addColorStop(c0, 'rgba(' + css + ',' + (0.95 - 0.58 * soft).toFixed(3) + ')')
      grd.addColorStop(1, 'rgba(' + css + ',0)')
      g.fillStyle = grd
      g.fillRect(0, 0, S, S)
      if (rim > 0 && R >= 3) {
        g.strokeStyle = 'rgba(' + css + ',' + clamp(rim * 0.85, 0, 1).toFixed(3) + ')'
        g.lineWidth = Math.max(0.7, R * 0.11)
        g.beginPath()
        g.arc(cx, cx, R * 0.93, 0, TAU)
        g.stroke()
      }
    }
    g.filter = 'none'
    return this.set(key, c)
  }

  /** 빗줄기: 위는 흐리고 아래(진행 방향)가 진함 */
  streak(wpx: number, lpx: number, css: string, blur: number): HTMLCanvasElement {
    const w = Math.max(0.75, qsize(wpx, 0.5))
    const l = Math.max(2, Math.round(qsize(lpx, 1)))
    const b = qblur(blur || 0, w)
    const key = 's' + w + '|' + l + '|' + b + '|' + css
    const hit = this.get(key)
    if (hit) return hit
    const bl = Math.max(0.4, w * 0.28) + b
    const pad = Math.ceil(bl * 2.6) + 2
    const c = document.createElement('canvas')
    c.width = Math.ceil(w + pad * 2)
    c.height = Math.ceil(l + pad * 2)
    const g = ctx2d(c)
    const grd = g.createLinearGradient(0, pad, 0, pad + l)
    grd.addColorStop(0, 'rgba(' + css + ',0)')
    grd.addColorStop(0.5, 'rgba(' + css + ',0.55)')
    grd.addColorStop(1, 'rgba(' + css + ',1)')
    g.filter = 'blur(' + bl.toFixed(2) + 'px)'
    g.fillStyle = grd
    g.beginPath()
    if (typeof g.roundRect === 'function') g.roundRect(pad, pad, w, l, w / 2)
    else g.rect(pad, pad, w, l)
    g.fill()
    g.filter = 'none'
    return this.set(key, c)
  }

  /**
   * 반짝임 별: 가늘고 긴 바늘 갈래 + 보조 갈래 + 흰 코어.
   * 다각형 하나로 채우면 골짜기까지 메워져 뭉툭해지므로, 갈래를 개별 그라데이션 삼각형으로 그린다.
   */
  sparkle(
    px: number,
    css: string,
    spikes: number,
    soft: number,
    ratio: number,
    blur: number,
  ): HTMLCanvasElement {
    px = Math.max(3, Math.round(qsize(px, 1)))
    soft = Math.round(clamp(soft, 0, 1) * 4) / 4
    spikes = spikes === 6 ? 6 : 4
    ratio = Math.round(clamp(ratio, 0, 0.8) * 8) / 8
    blur = qblur(blur || 0, px * 0.5)
    const key = 'k' + px + '|' + css + '|' + spikes + '|' + soft + '|' + ratio + '|' + blur
    const hit = this.get(key)
    if (hit) return hit
    const S0 = Math.max(10, px * 2 + 4)
    const pad = blur > 0 ? Math.ceil(blur * 2.6) + 2 : 0
    const S = S0 + pad * 2
    const c = document.createElement('canvas')
    c.width = c.height = S
    const g = ctx2d(c)
    const cx = S / 2
    const R = S0 / 2 - 2
    if (blur > 0) g.filter = 'blur(' + blur + 'px)'
    const gl = g.createRadialGradient(cx, cx, 0, cx, cx, R * (0.28 + 0.34 * soft)) // 중심 글로우
    gl.addColorStop(0, 'rgba(' + css + ',0.88)')
    gl.addColorStop(0.45, 'rgba(' + css + ',0.26)')
    gl.addColorStop(1, 'rgba(' + css + ',0)')
    g.fillStyle = gl
    g.fillRect(0, 0, S, S)
    const w0 = Math.max(0.55, R * (0.05 + 0.055 * soft))
    const spike = (ang: number, len: number, wid: number, a: number): void => {
      if (len < 1) return
      g.save()
      g.translate(cx, cx)
      g.rotate(ang)
      const lg = g.createLinearGradient(0, 0, len, 0)
      lg.addColorStop(0, 'rgba(' + css + ',' + a + ')')
      lg.addColorStop(0.16, 'rgba(' + css + ',' + (a * 0.5).toFixed(3) + ')')
      lg.addColorStop(1, 'rgba(' + css + ',0)')
      g.fillStyle = lg
      g.beginPath()
      g.moveTo(0, -wid)
      g.lineTo(len, 0)
      g.lineTo(0, wid)
      g.closePath()
      g.fill()
      g.restore()
    }
    for (let i = 0; i < spikes; i++) spike((i * TAU) / spikes, R, w0, 0.95) // 주 갈래
    if (ratio > 0)
      for (let i = 0; i < spikes; i++) spike(((i + 0.5) * TAU) / spikes, R * ratio, w0 * 0.7, 0.5) // 보조 갈래
    const co = g.createRadialGradient(cx, cx, 0, cx, cx, Math.max(0.9, R * 0.14)) // 흰 코어
    co.addColorStop(0, 'rgba(255,255,255,0.96)')
    co.addColorStop(0.45, 'rgba(' + css + ',0.8)')
    co.addColorStop(1, 'rgba(' + css + ',0)')
    g.fillStyle = co
    g.fillRect(0, 0, S, S)
    g.filter = 'none'
    return this.set(key, c)
  }

  /** 먼지 알갱이: 또렷한 심 + 넓고 옅은 후광(역광에 뜬 먼지의 특징) */
  dust(px: number, css: string, glow: number, soft: number, blur: number): HTMLCanvasElement {
    px = Math.max(0.3, qsize(px, 0.25))
    glow = Math.round(clamp(glow, 0, 1) * 4) / 4
    soft = Math.round(clamp(soft, 0, 1) * 4) / 4
    blur = qblur(blur || 0, px)
    const key = 'm' + px + '|' + glow + '|' + soft + '|' + blur + '|' + css
    const hit = this.get(key)
    if (hit) return hit
    const R = px * (1 + 2.4 * glow)
    const pad = Math.ceil(blur * 2.6) + 2
    const S = Math.max(3, Math.ceil(R * 2) + 2 + pad * 2)
    const c = document.createElement('canvas')
    c.width = c.height = S
    const g = ctx2d(c)
    const cx = S / 2
    if (blur > 0) g.filter = 'blur(' + blur + 'px)'
    if (glow > 0 && R > px) {
      const hg = g.createRadialGradient(cx, cx, 0, cx, cx, R)
      hg.addColorStop(0, 'rgba(' + css + ',' + (0.32 * glow).toFixed(3) + ')')
      hg.addColorStop(0.32, 'rgba(' + css + ',' + (0.11 * glow).toFixed(3) + ')')
      hg.addColorStop(1, 'rgba(' + css + ',0)')
      g.fillStyle = hg
      g.fillRect(0, 0, S, S)
    }
    const c0 = clamp(1 - (0.08 + 0.55 * soft), 0.05, 0.95)
    const cg = g.createRadialGradient(cx, cx, 0, cx, cx, Math.max(0.3, px))
    cg.addColorStop(0, 'rgba(' + css + ',0.98)')
    cg.addColorStop(c0, 'rgba(' + css + ',' + (0.92 - 0.5 * soft).toFixed(3) + ')')
    cg.addColorStop(1, 'rgba(' + css + ',0)')
    g.fillStyle = cg
    g.fillRect(0, 0, S, S)
    g.filter = 'none'
    return this.set(key, c)
  }

  /** 꽃잎 / 나뭇잎 */
  petal(px: number, blur: number, css: string, kind: string): HTMLCanvasElement {
    px = Math.max(2, Math.round(qsize(px, 1)))
    blur = qblur(blur || 0, px * 0.6)
    const key = 't' + px + '|' + blur + '|' + kind + '|' + css
    const hit = this.get(key)
    if (hit) return hit
    const leaf = kind === 'leaf'
    const w = Math.max(2, Math.round(px * (leaf ? 0.54 : 0.72)))
    const h = Math.max(3, Math.round(px))
    const pad = Math.ceil(blur * 2.6) + 3
    const c = document.createElement('canvas')
    c.width = w + pad * 2
    c.height = h + pad * 2
    const g = ctx2d(c)
    const cx = c.width / 2
    const top = pad
    const bot = pad + h
    const hw = w / 2
    if (blur > 0) g.filter = 'blur(' + blur + 'px)'
    g.beginPath()
    if (leaf) {
      // 잎: 밑동이 좁고 가운데가 넓으며 끝이 뾰족
      g.moveTo(cx, top)
      g.bezierCurveTo(cx + hw * 0.98, top + h * 0.28, cx + hw * 0.72, bot - h * 0.08, cx, bot)
      g.bezierCurveTo(cx - hw * 0.72, bot - h * 0.08, cx - hw * 0.98, top + h * 0.28, cx, top)
    } else {
      // 꽃잎: 밑동은 좁고 끝으로 갈수록 넓어지며 끝에 얕은 홈(벚꽃)
      const nt = h * 0.10
      g.moveTo(cx, bot)
      g.bezierCurveTo(cx + hw * 0.40, bot - h * 0.32, cx + hw, top + h * 0.32, cx + hw * 0.50, top + nt)
      g.quadraticCurveTo(cx + hw * 0.22, top - nt * 0.20, cx, top + nt)
      g.quadraticCurveTo(cx - hw * 0.22, top - nt * 0.20, cx - hw * 0.50, top + nt)
      g.bezierCurveTo(cx - hw, top + h * 0.32, cx - hw * 0.40, bot - h * 0.32, cx, bot)
    }
    g.closePath()
    // 길이 방향 음영: 밑동과 끝은 살짝 비치고 가운데가 진해 부피가 생긴다
    const lg = g.createLinearGradient(0, top, 0, bot)
    lg.addColorStop(0, 'rgba(' + css + ',0.70)')
    lg.addColorStop(0.42, 'rgba(' + css + ',1)')
    lg.addColorStop(1, 'rgba(' + css + ',0.74)')
    g.fillStyle = lg
    g.fill()
    g.save()
    g.clip() // 말린 결: 한쪽에 치우친 밝은 띠 + 반대쪽 그늘
    const cg = g.createLinearGradient(cx - hw, 0, cx + hw, 0)
    cg.addColorStop(0, 'rgba(255,255,255,0)')
    cg.addColorStop(0.34, 'rgba(255,255,255,' + (leaf ? 0.10 : 0.20) + ')')
    cg.addColorStop(0.64, 'rgba(0,0,0,0.05)')
    cg.addColorStop(1, 'rgba(0,0,0,' + (leaf ? 0.16 : 0.11) + ')')
    g.fillStyle = cg
    g.fillRect(cx - hw - 1, top - 1, w + 2, h + 2)
    g.restore()
    if (leaf && h > 9) {
      // 잎맥(중앙맥 + 곁맥)
      g.strokeStyle = 'rgba(255,255,255,0.20)'
      g.lineWidth = Math.max(0.5, w * 0.06)
      g.beginPath()
      g.moveTo(cx, top + h * 0.07)
      g.lineTo(cx, bot - h * 0.05)
      g.stroke()
      g.lineWidth = Math.max(0.4, w * 0.04)
      g.beginPath()
      for (let i = 1; i <= 3; i++) {
        const y = top + h * (0.16 + i * 0.20)
        const s = hw * 0.55 * (1 - i * 0.18)
        g.moveTo(cx, y)
        g.lineTo(cx + s, y + h * 0.10)
        g.moveTo(cx, y)
        g.lineTo(cx - s, y + h * 0.10)
      }
      g.stroke()
    }
    g.filter = 'none'
    return this.set(key, c)
  }
}
