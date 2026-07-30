/**
 * 렌더 엔진 유일 진입점.
 *
 *   같은 (doc, t) 면 항상 같은 픽셀이 나온다.
 *
 * 프리뷰와 내보내기는 물리적으로 이 함수를 호출한다. 다른 경로를 만드는 순간
 * "프리뷰 = 결과물" 이라는 제품의 핵심 약속이 깨진다.
 *
 * 이 파일은 DOM 을 참조하지 않는다. 워커에서도 그대로 동작해야 한다.
 */

import type {
  AssetTable,
  BlendMode,
  CompositionSnapshot,
  RenderTarget,
  ResolvedLayer,
} from '../types.ts'
import { parseHexColor, premultiply } from '../color.ts'
import { resolveComposition } from '../evaluate.ts'
import { solveOverscan, type OverscanMap } from '../overscan.ts'
import { buildLayerMatrix, canvasToClip, mat3Multiply, type Mat3 } from '../transform.ts'
import { secToFrame } from '../time.ts'
import { setPremultipliedBlend, type GlCapabilities } from './gl.ts'
import { ProgramCache } from './programCache.ts'
import { TargetPool, type PooledTarget } from './targetPool.ts'
import { COPY_FS, FULLSCREEN_VS, LAYER_FS, LAYER_VS } from './shaders/layer.ts'
import { BLEND_FS, BLEND_MODE_CODE } from './shaders/blend.ts'
import { SHAPE_FS, SHAPE_KIND_CODE } from './shaders/shape.ts'
import {
  disposeEffectResources,
  effectWarmupCombos,
  hasActiveEffects,
  runEffectChain,
} from '@/effects/passGraph.ts'

/**
 * 문서 시드. evaluate.ts 의 PROJECT_SEED 와 같은 값이어야 한다.
 * 모디파이어와 이펙트가 같은 문서에서 같은 난수 계보를 쓴다.
 */
const PROJECT_SEED = 0x4d4d

export class Renderer {
  readonly gl: WebGL2RenderingContext
  readonly caps: GlCapabilities
  readonly programs: ProgramCache
  readonly targets: TargetPool

  /** 프레임마다 새로 만들지 않는다. */
  private readonly clipMatrix: Mat3 = new Float32Array(9)
  private readonly layerMatrix: Mat3 = new Float32Array(9)
  private readonly finalMatrix: Mat3 = new Float32Array(9)
  private readonly emptyVao: WebGLVertexArrayObject | null

  /**
   * 오버스캔 해는 문서당 한 번만 구하면 된다. 240샘플씩 트랙을 평가하므로
   * 프레임마다 다시 풀면 재생이 그대로 멈춘다.
   * 문서는 immer 로 불변이라 참조 동일성이 완벽한 캐시 키가 된다.
   */
  private overscanDoc: CompositionSnapshot | null = null
  private overscanMap: OverscanMap = new Map()

  constructor(gl: WebGL2RenderingContext, caps: GlCapabilities) {
    this.gl = gl
    this.caps = caps
    this.programs = new ProgramCache(gl)
    this.targets = new TargetPool(gl, caps.colorBufferFloat)

    // attribute-less draw 라도 VAO 는 바인딩되어 있어야 한다.
    this.emptyVao = gl.createVertexArray()

    this.programs.warmup([
      { vs: LAYER_VS, fs: LAYER_FS },
      // 도형은 같은 정점 셰이더를 쓰고 프래그먼트만 다르다. 종류는 유니폼으로 가르므로
      // 프로그램이 한 벌뿐이고, 캐시(용량 64)를 이펙트와 나눠 쓰는 부담이 없다.
      { vs: LAYER_VS, fs: SHAPE_FS },
      { vs: FULLSCREEN_VS, fs: COPY_FS },
      { vs: FULLSCREEN_VS, fs: BLEND_FS },
      // 이펙트 셰이더는 종류가 많아 프레임 루프 안에서 컴파일하면 그대로 끊긴다.
      ...effectWarmupCombos(),
    ])
  }

  /**
   * @param doc  불변 스냅샷
   * @param t    연속 시간(초). frameIndex 는 floor(t * fps) 로 유도한다.
   */
  renderFrame(
    doc: CompositionSnapshot,
    t: number,
    target: RenderTarget,
    assets: AssetTable,
  ): void {
    const gl = this.gl
    const frame = secToFrame(t, doc.timeline.fps)

    gl.disable(gl.DEPTH_TEST)
    gl.disable(gl.CULL_FACE)
    gl.disable(gl.SCISSOR_TEST)

    canvasToClip(doc.canvas.w, doc.canvas.h, this.clipMatrix)

    if (this.overscanDoc !== doc) {
      this.overscanDoc = doc
      this.overscanMap = solveOverscan(doc, (assetId) => {
        const gpu = assets.get(assetId)
        if (gpu) return { width: gpu.width, height: gpu.height }
        const ref = doc.assets.find((a) => a.id === assetId)
        return ref ? { width: ref.naturalW, height: ref.naturalH } : undefined
      })
    }

    const layers = resolveComposition(doc, frame, this.overscanMap)

    // 레이어별 이펙트가 있으면 그 레이어를 따로 그려 체인을 태워야 하고,
    // 혼합 모드가 있으면 배경을 읽어야 한다. 둘 다 오프스크린을 요구한다.
    const layerNeedsPass = layers.map(
      (l) =>
        (!!l.assetId || !!l.shape) &&
        l.visible &&
        (l.blend !== 'normal' || hasActiveEffects(l.effects, frame)),
    )
    const needsOffscreen = layerNeedsPass.some(Boolean)

    gl.bindVertexArray(this.emptyVao)

    if (!needsOffscreen) {
      // 흔한 경우. 오프스크린을 거칠 이유가 없다.
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo)
      gl.viewport(0, 0, target.width, target.height)
      this.clearBackground(doc)
      setPremultipliedBlend(gl)
      for (const layer of layers) this.drawLayer(doc, layer, assets)
      gl.bindVertexArray(null)
      this.targets.endFrame()
      return
    }

    // 그리고 있는 프레임버퍼를 동시에 샘플링할 수 없으므로 누산기를 두 장 번갈아 쓴다.
    // 화면(기본 프레임버퍼)에는 텍스처가 없어서 프리뷰 경로도 오프스크린을 거친다.
    const w = target.width
    const h = target.height
    let acc = this.targets.acquire(w, h, 'rgba8')
    let spare = this.targets.acquire(w, h, 'rgba8')
    const layerBuf = this.targets.acquire(w, h, 'rgba8')
    const fxBuf = this.targets.acquire(w, h, 'rgba8')

    try {
      gl.bindFramebuffer(gl.FRAMEBUFFER, acc.fbo)
      gl.viewport(0, 0, w, h)
      this.clearBackground(doc)

      for (let i = 0; i < layers.length; i += 1) {
        const layer = layers[i]!

        if (!layerNeedsPass[i]) {
          gl.bindFramebuffer(gl.FRAMEBUFFER, acc.fbo)
          gl.viewport(0, 0, w, h)
          setPremultipliedBlend(gl)
          this.drawLayer(doc, layer, assets)
          continue
        }

        // 레이어만 따로 그린다. 배경과 섞이면 이펙트가 배경까지 망가뜨린다.
        gl.bindFramebuffer(gl.FRAMEBUFFER, layerBuf.fbo)
        gl.viewport(0, 0, w, h)
        gl.clearColor(0, 0, 0, 0)
        gl.clear(gl.COLOR_BUFFER_BIT)
        setPremultipliedBlend(gl)
        this.drawLayer(doc, layer, assets)

        let source = layerBuf
        if (hasActiveEffects(layer.effects, frame)) {
          const ran = runEffectChain(
            { gl, programs: this.programs, targets: this.targets },
            {
              source: layerBuf,
              output: { fbo: fxBuf.fbo, width: w, height: h },
              effects: layer.effects,
              ctxBase: {
                frame,
                durationFrames: doc.timeline.durationFrames,
                fps: doc.timeline.fps,
                width: w,
                height: h,
                pass: 0,
                passCount: 1,
                seedStatic: 0,
                instanceSeed: 0,
              },
              projectSeed: PROJECT_SEED,
              nodeId: layer.layerId,
            },
          )
          if (ran) source = fxBuf
          // 체인은 자기 VAO 를 바인딩하고 블렌딩을 꺼 둔 채 돌아온다. 되돌린다.
          gl.bindVertexArray(this.emptyVao)
        }

        if (layer.blend === 'normal') {
          gl.bindFramebuffer(gl.FRAMEBUFFER, acc.fbo)
          gl.viewport(0, 0, w, h)
          setPremultipliedBlend(gl)
          this.composePass(source)
        } else {
          this.blendPass(acc, source, spare, layer.blend)
          const swap = acc
          acc = spare
          spare = swap
        }
      }

      // 최종 결과를 요청받은 타깃에 옮긴다.
      this.copyPass(acc, target)
    } finally {
      this.targets.release(acc)
      this.targets.release(spare)
      this.targets.release(layerBuf)
      this.targets.release(fxBuf)
      // 프레임 경계를 알려야 오래 안 쓰인 크기의 FBO 가 회수된다.
      // 캔버스 크기를 바꾸면 새 버킷이 생기는데 회수가 없으면 GPU 에 계속 쌓인다.
      this.targets.endFrame()
      gl.bindVertexArray(null)
    }
  }

  /**
   * 이미 렌더된 텍스처를 현재 프레임버퍼 위에 노멀 합성한다.
   * 이펙트를 거친 레이어를 누산기에 얹을 때 쓴다. 블렌딩은 호출자가 켜 둔다.
   */
  private composePass(src: PooledTarget): void {
    const gl = this.gl
    const info = this.programs.get(FULLSCREEN_VS, COPY_FS)
    gl.useProgram(info.program)
    const uImage = info.uniforms.get('u_image')
    if (uImage) {
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, src.texture)
      gl.uniform1i(uImage, 0)
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3)
  }

  /** 전체화면 패스 공통 준비. 빅 트라이앵글 하나로 화면을 덮는다. */
  private fullscreenPass(fbo: WebGLFramebuffer | null, w: number, h: number): void {
    const gl = this.gl
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
    gl.viewport(0, 0, w, h)
    // 패스가 결과를 그대로 써야 하므로 블렌딩을 끈다.
    gl.disable(gl.BLEND)
  }

  private blendPass(
    backdrop: PooledTarget,
    source: PooledTarget,
    out: PooledTarget,
    mode: BlendMode,
  ): void {
    const gl = this.gl
    const info = this.programs.get(FULLSCREEN_VS, BLEND_FS)
    this.fullscreenPass(out.fbo, out.width, out.height)
    gl.useProgram(info.program)

    const uBackdrop = info.uniforms.get('u_backdrop')
    if (uBackdrop) {
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, backdrop.texture)
      gl.uniform1i(uBackdrop, 0)
    }
    const uSource = info.uniforms.get('u_source')
    if (uSource) {
      gl.activeTexture(gl.TEXTURE1)
      gl.bindTexture(gl.TEXTURE_2D, source.texture)
      gl.uniform1i(uSource, 1)
    }
    const uMode = info.uniforms.get('u_mode')
    if (uMode) gl.uniform1i(uMode, BLEND_MODE_CODE[mode] ?? 0)

    gl.drawArrays(gl.TRIANGLES, 0, 3)
    gl.activeTexture(gl.TEXTURE0)
  }

  private copyPass(src: PooledTarget, target: RenderTarget): void {
    const gl = this.gl
    const info = this.programs.get(FULLSCREEN_VS, COPY_FS)
    this.fullscreenPass(target.fbo, target.width, target.height)
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.useProgram(info.program)

    const uImage = info.uniforms.get('u_image')
    if (uImage) {
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, src.texture)
      gl.uniform1i(uImage, 0)
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3)
  }

  private clearBackground(doc: CompositionSnapshot): void {
    const gl = this.gl
    const bg = doc.canvas.background
    if (bg.type === 'solid') {
      const [r, g, b, a] = premultiply(parseHexColor(bg.color))
      gl.clearColor(r, g, b, a)
    } else {
      // blurExtend / mirror 는 아직 없다. 배경 채우기 정책과 함께 들어온다.
      // 그때까지는 투명으로 지운다.
      gl.clearColor(0, 0, 0, 0)
    }
    gl.clear(gl.COLOR_BUFFER_BIT)
  }

  private drawLayer(
    doc: CompositionSnapshot,
    layer: ResolvedLayer,
    assets: AssetTable,
  ): void {
    if (!layer.visible) return
    if (layer.transform.opacity <= 0) return

    // 도형이 먼저다. 도형 레이어는 에셋을 가리키지 않는다.
    if (layer.shape) {
      this.drawShapeLayer(doc, layer)
      return
    }
    if (!layer.assetId) return

    const asset = assets.get(layer.assetId)
    if (!asset) return

    const gl = this.gl
    const info = this.programs.get(LAYER_VS, LAYER_FS)

    buildLayerMatrix(
      layer.transform,
      layer.fit,
      doc.canvas.w,
      doc.canvas.h,
      asset.width,
      asset.height,
      this.layerMatrix,
    )
    mat3Multiply(this.clipMatrix, this.layerMatrix, this.finalMatrix)

    gl.useProgram(info.program)

    const uMatrix = info.uniforms.get('u_matrix')
    if (uMatrix) gl.uniformMatrix3fv(uMatrix, false, this.finalMatrix)

    const uOpacity = info.uniforms.get('u_opacity')
    if (uOpacity) gl.uniform1f(uOpacity, layer.transform.opacity)

    const uImage = info.uniforms.get('u_image')
    if (uImage) {
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, asset.texture)
      gl.uniform1i(uImage, 0)
    }

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
  }

  /**
   * 도형 레이어.
   *
   * 이미지 경로와 **같은 매트릭스**를 쓴다. 도형의 자연 크기(ShapeSpec.width/height)가
   * 원본 픽셀 크기 자리에 그대로 들어가므로, 맞춤 / 기준점 / 캔버스 배율 규칙이
   * 이미지와 한 글자도 다르지 않다. 여기서 크기 계산을 새로 하면 오버스캔 솔버와
   * 어긋나 담기를 켠 도형이 엉뚱한 배율로 앉는다.
   */
  private drawShapeLayer(doc: CompositionSnapshot, layer: ResolvedLayer): void {
    const shape = layer.shape
    if (!shape) return

    const gl = this.gl
    const info = this.programs.get(LAYER_VS, SHAPE_FS)

    const w = Math.max(1, shape.width)
    const h = Math.max(1, shape.height)

    buildLayerMatrix(
      layer.transform,
      layer.fit,
      doc.canvas.w,
      doc.canvas.h,
      w,
      h,
      this.layerMatrix,
    )
    mat3Multiply(this.clipMatrix, this.layerMatrix, this.finalMatrix)

    gl.useProgram(info.program)

    const uMatrix = info.uniforms.get('u_matrix')
    if (uMatrix) gl.uniformMatrix3fv(uMatrix, false, this.finalMatrix)

    const uOpacity = info.uniforms.get('u_opacity')
    if (uOpacity) gl.uniform1f(uOpacity, layer.transform.opacity)

    // 색은 straight alpha 로 넘긴다. premultiply 는 프래그먼트 셰이더가 마지막에 한다.
    const uColor = info.uniforms.get('u_color')
    if (uColor) {
      const [r, g, b, a] = parseHexColor(shape.color)
      gl.uniform4f(uColor, r, g, b, a)
    }

    const uSize = info.uniforms.get('u_size')
    if (uSize) gl.uniform2f(uSize, w, h)

    const uStroke = info.uniforms.get('u_stroke')
    if (uStroke) gl.uniform1f(uStroke, Math.max(0, shape.strokeWidth))

    const uRadius = info.uniforms.get('u_radius')
    if (uRadius) gl.uniform1f(uRadius, Math.max(0, shape.cornerRadius))

    const uInner = info.uniforms.get('u_inner')
    if (uInner) gl.uniform1f(uInner, shape.innerRatio)

    const uSweep = info.uniforms.get('u_sweep')
    if (uSweep) gl.uniform1f(uSweep, (shape.sweepDeg * Math.PI) / 180)

    const uKind = info.uniforms.get('u_kind')
    if (uKind) gl.uniform1i(uKind, SHAPE_KIND_CODE[shape.kind] ?? 0)

    const uPoints = info.uniforms.get('u_points')
    if (uPoints) gl.uniform1i(uPoints, Math.max(3, Math.round(shape.points)))

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
  }

  dispose(): void {
    // 이펙트 체인이 컨텍스트별로 들고 있는 VAO 와 노이즈 아틀라스를 먼저 정리한다.
    disposeEffectResources(this.gl)
    this.programs.dispose()
    this.targets.dispose()
    if (this.emptyVao) this.gl.deleteVertexArray(this.emptyVao)
  }
}

export { WebGL2UnsupportedError } from './gl.ts'
