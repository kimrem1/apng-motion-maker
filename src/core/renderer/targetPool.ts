/**
 * FBO 풀.
 *
 * 프레임 루프 안에서는 절대 할당하지 않는다. (w, h, format) 을 키로 재사용한다.
 * 해상도 상한이 2048px / 120프레임으로 확정되었으므로(14.A3) 타일 분할은 없다.
 */

export type TargetFormat = 'rgba8' | 'rgba16f'

export interface PooledTarget {
  fbo: WebGLFramebuffer
  texture: WebGLTexture
  width: number
  height: number
  format: TargetFormat
}

interface PoolEntry {
  target: PooledTarget
  inUse: boolean
  /** 마지막으로 대여된 세대. 오래 안 쓰인 버킷을 회수하는 기준이다. */
  lastUsed: number
}

/**
 * 이 세대만큼 안 쓰인 버킷은 GPU 에서 지운다.
 *
 * 캔버스 크기를 바꿀 때마다 새 (w,h) 버킷이 생기는데 회수가 없으면 이전 크기의
 * FBO 와 텍스처가 영원히 남는다. 인스펙터의 폭 입력에 방향키를 누르고 있으면
 * 증분마다 버킷이 쌓여 수백 MB 가 해제되지 않는다. 2048px 버킷 하나가 64MB 다.
 */
const EVICT_AFTER_GENERATIONS = 120

export class TargetPool {
  private readonly gl: WebGL2RenderingContext
  private readonly entries = new Map<string, PoolEntry[]>()
  private readonly allowFloat: boolean
  /** 프레임 카운터. releaseAll 마다 하나 올라간다. */
  private generation = 0

  constructor(gl: WebGL2RenderingContext, allowFloat: boolean) {
    this.gl = gl
    this.allowFloat = allowFloat
  }

  private key(w: number, h: number, format: TargetFormat): string {
    return `${w}x${h}:${format}`
  }

  /**
   * 대여. 반드시 release 로 돌려준다.
   * rgba16f 를 요청했는데 EXT_color_buffer_float 이 없으면 rgba8 로 폴백한다.
   * 폴백 사실은 호출자가 caps 로 알 수 있으므로 여기서는 조용히 낮춘다.
   */
  acquire(w: number, h: number, format: TargetFormat = 'rgba8'): PooledTarget {
    const fmt: TargetFormat = format === 'rgba16f' && !this.allowFloat ? 'rgba8' : format
    const k = this.key(w, h, fmt)
    let list = this.entries.get(k)
    if (!list) {
      list = []
      this.entries.set(k, list)
    }
    const free = list.find((e) => !e.inUse)
    if (free) {
      free.inUse = true
      free.lastUsed = this.generation
      return free.target
    }
    const target = this.create(w, h, fmt)
    list.push({ target, inUse: true, lastUsed: this.generation })
    return target
  }

  release(target: PooledTarget): void {
    const list = this.entries.get(this.key(target.width, target.height, target.format))
    if (!list) return
    for (const e of list) {
      if (e.target === target) {
        e.inUse = false
        return
      }
    }
  }

  releaseAll(): void {
    for (const list of this.entries.values()) {
      for (const e of list) e.inUse = false
    }
    this.endFrame()
  }

  /**
   * 프레임 경계. 세대를 올리고 오래 안 쓰인 버킷을 GPU 에서 지운다.
   * 렌더러가 프레임마다 부른다.
   */
  endFrame(): void {
    this.generation += 1
    if (this.generation % 30 !== 0) return // 30프레임마다 한 번만 훑는다

    for (const [key, list] of this.entries) {
      const keep: PoolEntry[] = []
      for (const e of list) {
        if (e.inUse || this.generation - e.lastUsed < EVICT_AFTER_GENERATIONS) {
          keep.push(e)
          continue
        }
        this.gl.deleteFramebuffer(e.target.fbo)
        this.gl.deleteTexture(e.target.texture)
      }
      if (keep.length === 0) this.entries.delete(key)
      else if (keep.length !== list.length) this.entries.set(key, keep)
    }
  }

  /** 지금 살아 있는 타깃 수와 대략적인 바이트. 진단용. */
  stats(): { targets: number; bytes: number } {
    let targets = 0
    let bytes = 0
    for (const list of this.entries.values()) {
      for (const e of list) {
        targets += 1
        bytes += e.target.width * e.target.height * (e.target.format === 'rgba16f' ? 8 : 4)
      }
    }
    return { targets, bytes }
  }

  private create(w: number, h: number, format: TargetFormat): PooledTarget {
    const gl = this.gl
    const texture = gl.createTexture()
    if (!texture) throw new Error('렌더 타깃 텍스처를 만들지 못했습니다.')

    gl.bindTexture(gl.TEXTURE_2D, texture)
    if (format === 'rgba16f') {
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA16F, w, h)
    } else {
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, w, h)
    }
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)

    const fbo = gl.createFramebuffer()
    if (!fbo) throw new Error('프레임버퍼를 만들지 못했습니다.')
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0)

    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.bindTexture(gl.TEXTURE_2D, null)
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error(`프레임버퍼가 불완전합니다 (0x${status.toString(16)}).`)
    }

    return { fbo, texture, width: w, height: h, format }
  }

  dispose(): void {
    const gl = this.gl
    for (const list of this.entries.values()) {
      for (const e of list) {
        gl.deleteFramebuffer(e.target.fbo)
        gl.deleteTexture(e.target.texture)
      }
    }
    this.entries.clear()
  }
}
