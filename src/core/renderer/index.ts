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
import { REVEAL_MODE_CODE } from '../reveal.ts'
import { resolveComposition } from '../evaluate.ts'
import { solveOverscan, type OverscanMap } from '../overscan.ts'
import { buildLayerMatrix, canvasToClip, mat3Multiply, type Mat3 } from '../transform.ts'
import { applyFolderMatrix, buildFolderMatrices } from '../group.ts'
import { clipGroups, subtreeEnds } from '../clip.ts'
import { CLIP_FS } from './shaders/clip.ts'
import { secToFrame } from '../time.ts'
import { setPremultipliedBlend, type GlCapabilities } from './gl.ts'
import { ProgramCache, type ProgramInfo } from './programCache.ts'
import { TargetPool, type PooledTarget } from './targetPool.ts'
import { COPY_FS, FULLSCREEN_VS, LAYER_FS, LAYER_VS } from './shaders/layer.ts'
import { BLEND_FS, BLEND_MODE_CODE } from './shaders/blend.ts'
import { SHAPE_FS, SHAPE_KIND_CODE } from './shaders/shape.ts'
import { TEXT_FS, TEXT_VS } from './shaders/text.ts'
import { TextRasterCache, type TextRaster } from './textAtlas.ts'
import {
  charEasedProgress,
  charProgress,
  charScrambleSlot,
  charTransformAt,
} from '../charAnim.ts'
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

/**
 * 가리기 유니폼. 이미지 경로와 도형 경로가 같은 함수를 부른다.
 *
 * 가리기가 없는 레이어에서도 `u_revealMode` 를 0 으로 반드시 써야 한다. 프로그램은
 * 캐시되고 유니폼은 프로그램에 남으므로, 앞 레이어가 켜 둔 값이 그대로 남아 다음
 * 레이어까지 잘려 나간다.
 */
function setRevealUniforms(
  gl: WebGL2RenderingContext,
  info: ProgramInfo,
  layer: ResolvedLayer,
): void {
  const uMode = info.uniforms.get('u_revealMode')
  const spec = layer.reveal
  if (!spec || spec.mode === 'none') {
    if (uMode) gl.uniform1i(uMode, 0)
    return
  }

  if (uMode) gl.uniform1i(uMode, REVEAL_MODE_CODE[spec.mode] ?? 0)

  const uProgress = info.uniforms.get('u_reveal')
  if (uProgress) gl.uniform1f(uProgress, layer.transform.reveal)

  const uSoft = info.uniforms.get('u_revealSoft')
  if (uSoft) gl.uniform1f(uSoft, spec.softness)

  const uSlats = info.uniforms.get('u_revealSlats')
  if (uSlats) gl.uniform1f(uSlats, Math.max(1, spec.slats))

  const uAngle = info.uniforms.get('u_revealAngle')
  if (uAngle) gl.uniform1f(uAngle, (spec.angle * Math.PI) / 180)

  const uFlip = info.uniforms.get('u_revealFlip')
  if (uFlip) gl.uniform1f(uFlip, spec.invert ? 1 : 0)
}

export class Renderer {
  readonly gl: WebGL2RenderingContext
  readonly caps: GlCapabilities
  readonly programs: ProgramCache
  readonly targets: TargetPool

  /** 프레임마다 새로 만들지 않는다. */
  private readonly clipMatrix: Mat3 = new Float32Array(9)
  private readonly layerMatrix: Mat3 = new Float32Array(9)
  private readonly finalMatrix: Mat3 = new Float32Array(9)
  /** 글자 상자 전체의 매트릭스. 글자 하나하나가 여기에 곱해진다. */
  private readonly textBase: Mat3 = new Float32Array(9)
  /** 글자 하나의 상자 로컬 매트릭스. */
  private readonly textLocal: Mat3 = new Float32Array(9)
  private readonly emptyVao: WebGLVertexArrayObject | null

  /** 글자 텍스처. 값이 같으면 레이어가 달라도 한 장을 나눠 쓴다. */
  readonly texts: TextRasterCache

  /**
   * 오버스캔 해는 문서당 한 번만 구하면 된다. 240샘플씩 트랙을 평가하므로
   * 프레임마다 다시 풀면 재생이 그대로 멈춘다.
   * 문서는 immer 로 불변이라 참조 동일성이 완벽한 캐시 키가 된다.
   */
  private overscanDoc: CompositionSnapshot | null = null
  private overscanMap: OverscanMap = new Map()

  /** 이번 프레임의 폴더 매트릭스. 폴더가 없으면 비어 있고 비용도 0 이다. */
  private folderMatrices: ReadonlyMap<string, Mat3> = new Map()

  constructor(gl: WebGL2RenderingContext, caps: GlCapabilities) {
    this.gl = gl
    this.caps = caps
    this.programs = new ProgramCache(gl)
    this.targets = new TargetPool(gl, caps.colorBufferFloat)
    this.texts = new TextRasterCache(gl)

    // attribute-less draw 라도 VAO 는 바인딩되어 있어야 한다.
    this.emptyVao = gl.createVertexArray()

    this.programs.warmup([
      { vs: LAYER_VS, fs: LAYER_FS },
      // 도형은 같은 정점 셰이더를 쓰고 프래그먼트만 다르다. 종류는 유니폼으로 가르므로
      // 프로그램이 한 벌뿐이고, 캐시(용량 64)를 이펙트와 나눠 쓰는 부담이 없다.
      { vs: LAYER_VS, fs: SHAPE_FS },
      { vs: TEXT_VS, fs: TEXT_FS },
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
    /*
     * 폴더 매트릭스는 프레임마다 폴더 개수만큼만 만든다.
     * 레이어마다 사슬을 다시 곱하면 깊이의 제곱이 된다.
     */
    this.folderMatrices = buildFolderMatrices(layers, doc.canvas.w, doc.canvas.h)

    /*
     * 자르기 덩어리. 밑판 하나와 그 위에 붙는 레이어들이다.
     *
     * 덩어리는 반드시 오프스크린을 거친다. 밑판의 알파를 마스크로 읽어야 하는데,
     * 누산기에 이미 섞인 뒤에는 밑판만의 알파를 되찾을 방법이 없기 때문이다.
     */
    const groups = clipGroups(layers)
    const subtreeEnd = subtreeEnds(layers)
    const groupByBase = new Map(groups.map((g) => [g.base, g]))
    /*
     * 덩어리가 이미 그린 번호들. 폴더가 붙는 쪽이면 그 안쪽까지 전부 들어간다.
     * 빠뜨리면 폴더 식구가 잘린 그림 위에 한 번 더 그려져 마스크가 무의미해진다.
     */
    const clippedIndexes = new Set<number>()
    for (const g of groups) {
      for (const m of g.members) {
        for (let k = m; k <= (subtreeEnd[m] ?? m); k += 1) clippedIndexes.add(k)
      }
    }

    // 레이어별 이펙트가 있으면 그 레이어를 따로 그려 체인을 태워야 하고,
    // 혼합 모드가 있으면 배경을 읽어야 한다. 둘 다 오프스크린을 요구한다.
    const layerNeedsPass = layers.map(
      (l) =>
        (!!l.assetId || !!l.shape || !!l.text) &&
        l.visible &&
        (l.blend !== 'normal' || hasActiveEffects(l.effects, frame)),
    )
    const needsOffscreen = layerNeedsPass.some(Boolean) || groups.length > 0

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
      this.texts.endFrame()
      return
    }

    // 그리고 있는 프레임버퍼를 동시에 샘플링할 수 없으므로 누산기를 두 장 번갈아 쓴다.
    // 화면(기본 프레임버퍼)에는 텍스처가 없어서 프리뷰 경로도 오프스크린을 거친다.
    const w = target.width
    const h = target.height

    /*
     * 대여는 반드시 try 안에서 한다.
     *
     * acquire 는 풀에 여유가 없으면 새로 만들고, 텍스처 생성이나 프레임버퍼 완성에
     * 실패하면 던진다(targetPool.create). 네 번의 대여가 try 밖에 있으면 두 번째가
     * 던지는 순간 finally 에 못 가서 앞서 빌린 것이 inUse 로 굳는다. 그 항목은
     * endFrame 도 회수하지 않으므로(inUse 는 건너뛴다) 컨텍스트를 버릴 때까지 남고,
     * 그 크기의 버킷은 영영 재사용되지 못한다. passGraph 의 borrowed 관례와 같게 맞춘다.
     */
    const borrowed: PooledTarget[] = []

    try {
      const borrow = (): PooledTarget => {
        const t = this.targets.acquire(w, h, 'rgba8')
        borrowed.push(t)
        return t
      }
      let acc = borrow()
      let spare = borrow()
      const layerBuf = borrow()
      const fxBuf = borrow()

      gl.bindFramebuffer(gl.FRAMEBUFFER, acc.fbo)
      gl.viewport(0, 0, w, h)
      this.clearBackground(doc)

      // 자르기가 있을 때만 빌린다. 옛 문서에서는 버퍼 세 장을 만들지 않는다.
      const maskBuf = groups.length > 0 ? borrow() : null
      const groupBuf = groups.length > 0 ? borrow() : null
      /** 폴더 하나를 통째로 담는 자리. 폴더가 자르기에 참여할 때만 쓴다. */
      const subBuf = groups.length > 0 ? borrow() : null

      /** 레이어 한 장을 layerBuf 에 그리고 이펙트까지 태운 결과. */
      const renderLayerAlone = (layer: ResolvedLayer): PooledTarget => {
        // 레이어만 따로 그린다. 배경과 섞이면 이펙트가 배경까지 망가뜨린다.
        gl.bindFramebuffer(gl.FRAMEBUFFER, layerBuf.fbo)
        gl.viewport(0, 0, w, h)
        gl.clearColor(0, 0, 0, 0)
        gl.clear(gl.COLOR_BUFFER_BIT)
        setPremultipliedBlend(gl)
        this.drawLayer(doc, layer, assets)

        if (!hasActiveEffects(layer.effects, frame)) return layerBuf

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
        // 체인은 자기 VAO 를 바인딩하고 블렌딩을 꺼 둔 채 돌아온다. 되돌린다.
        gl.bindVertexArray(this.emptyVao)
        return ran ? fxBuf : layerBuf
      }

      /** 다 만들어진 한 장을 누산기에 얹는다. 혼합 모드가 있으면 누산기를 바꿔 낀다. */
      const compose = (source: PooledTarget, blend: BlendMode): void => {
        if (blend === 'normal') {
          gl.bindFramebuffer(gl.FRAMEBUFFER, acc.fbo)
          gl.viewport(0, 0, w, h)
          setPremultipliedBlend(gl)
          this.composePass(source)
          return
        }
        this.blendPass(acc, source, spare, blend)
        const swap = acc
        acc = spare
        spare = swap
      }

      /**
       * from..to 를 한 장에 담는다. 폴더 하나를 통째로 그릴 때 쓴다.
       *
       * 안에서는 노멀 합성이다. 폴더 식구의 혼합 모드를 살리려면 배경 버퍼를 한 장
       * 더 떠야 하는데, 자르기에 들어간 폴더 안에서 그 조합은 거의 나오지 않는다.
       * 이펙트는 레이어마다 그대로 걸린다. 그쪽은 흔하기 때문이다.
       */
      const renderRange = (dest: PooledTarget, from: number, to: number): PooledTarget => {
        gl.bindFramebuffer(gl.FRAMEBUFFER, dest.fbo)
        gl.viewport(0, 0, w, h)
        gl.clearColor(0, 0, 0, 0)
        gl.clear(gl.COLOR_BUFFER_BIT)

        for (let k = from; k <= to; k += 1) {
          const inner = layers[k]!
          if (!inner.visible) continue
          if (!layerNeedsPass[k]) {
            gl.bindFramebuffer(gl.FRAMEBUFFER, dest.fbo)
            gl.viewport(0, 0, w, h)
            setPremultipliedBlend(gl)
            this.drawLayer(doc, inner, assets)
            continue
          }
          const source = renderLayerAlone(inner)
          gl.bindFramebuffer(gl.FRAMEBUFFER, dest.fbo)
          gl.viewport(0, 0, w, h)
          setPremultipliedBlend(gl)
          this.composePass(source)
        }
        return dest
      }

      /**
       * 자르기에 참여하는 한 덩이. 폴더면 안쪽까지, 아니면 자기 한 장이다.
       * 폴더 경로만 subBuf 를 쓰므로, 밑판을 복사해 둔 뒤에 식구를 그려야 한다.
       */
      const renderUnit = (index: number, end: number): PooledTarget => {
        if (end > index && subBuf) return renderRange(subBuf, index, end)
        return renderLayerAlone(layers[index]!)
      }

      for (let i = 0; i < layers.length; i += 1) {
        const layer = layers[i]!

        // 덩어리에 속한 레이어(와 그 폴더 식구)는 밑판 차례에 이미 그렸다.
        if (clippedIndexes.has(i)) continue

        const group = groupByBase.get(i)

        if (group && maskBuf && groupBuf) {
          /*
           * 자르기 덩어리.
           *
           *   1. 밑판을 혼자 그린다. 그 알파가 곧 마스크다.
           *   2. 같은 그림을 덩어리 버퍼에도 깔아 둔다.
           *   3. 위에 붙는 레이어를 하나씩 그려 마스크로 깎아 덩어리에 얹는다.
           *   4. 덩어리를 밑판의 혼합 모드로 누산기에 얹는다.
           *
           * 밑판도 붙는 쪽도 폴더일 수 있다. 그때는 폴더 안쪽 전체가 한 장으로
           * 그려진 뒤 그 한 장이 마스크가 되거나 잘린다. 도형 여러 장으로 만든
           * 모양 안에만 사진을 채우는 것이 이 경로다.
           *
           * 밑판을 먼저 복사해 두고 식구를 그린다. 폴더 경로가 subBuf 를
           * 공유하므로, 복사 전에 식구를 그리면 마스크가 덮인다.
           */
          const baseSource = renderUnit(group.base, group.baseEnd)
          this.copyPass(baseSource, { gl, width: w, height: h, fbo: maskBuf.fbo })
          this.copyPass(baseSource, { gl, width: w, height: h, fbo: groupBuf.fbo })

          for (const m of group.members) {
            const source = renderUnit(m, subtreeEnd[m] ?? m)
            this.clipPass(groupBuf, source, maskBuf)
          }

          compose(groupBuf, layer.blend)
          // 밑판이 폴더면 그 식구들까지 이 차례에 끝났다.
          i = Math.max(i, group.baseEnd)
          continue
        }

        if (!layerNeedsPass[i]) {
          gl.bindFramebuffer(gl.FRAMEBUFFER, acc.fbo)
          gl.viewport(0, 0, w, h)
          setPremultipliedBlend(gl)
          this.drawLayer(doc, layer, assets)
          continue
        }

        compose(renderLayerAlone(layer), layer.blend)
      }

      // 최종 결과를 요청받은 타깃에 옮긴다.
      this.copyPass(acc, target)
    } finally {
      // 스왑은 변수만 맞바꾸므로 빌린 집합은 그대로다.
      for (const t of borrowed) this.targets.release(t)
      this.texts.endFrame()
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

  /**
   * 자를 레이어를 밑판의 알파로 깎아 덩어리 위에 얹는다.
   *
   * 색이 아니라 알파만 본다 (shaders/clip.ts). 블렌딩을 켜 둔 채로 그리므로
   * 결과가 덩어리에 노멀 합성된다.
   */
  private clipPass(dest: PooledTarget, source: PooledTarget, mask: PooledTarget): void {
    const gl = this.gl
    const info = this.programs.get(FULLSCREEN_VS, CLIP_FS)

    gl.bindFramebuffer(gl.FRAMEBUFFER, dest.fbo)
    gl.viewport(0, 0, dest.width, dest.height)
    setPremultipliedBlend(gl)
    gl.useProgram(info.program)

    const uImage = info.uniforms.get('u_image')
    if (uImage) {
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, source.texture)
      gl.uniform1i(uImage, 0)
    }
    const uMask = info.uniforms.get('u_mask')
    if (uMask) {
      gl.activeTexture(gl.TEXTURE1)
      gl.bindTexture(gl.TEXTURE_2D, mask.texture)
      gl.uniform1i(uMask, 1)
    }

    gl.drawArrays(gl.TRIANGLES, 0, 3)
    // 다음 패스가 0번 유닛을 쓴다고 가정한다. blendPass 와 같은 관례다.
    gl.activeTexture(gl.TEXTURE0)
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

    // 도형과 글자가 먼저다. 둘 다 에셋을 가리키지 않는다.
    if (layer.shape) {
      this.drawShapeLayer(doc, layer)
      return
    }
    if (layer.text) {
      this.drawTextLayer(doc, layer)
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
    // 폴더는 바깥에 곱한다. 폴더가 없으면 아무 일도 하지 않는다.
    applyFolderMatrix(this.layerMatrix, layer.folderId, this.folderMatrices)
    mat3Multiply(this.clipMatrix, this.layerMatrix, this.finalMatrix)

    gl.useProgram(info.program)

    const uMatrix = info.uniforms.get('u_matrix')
    if (uMatrix) gl.uniformMatrix3fv(uMatrix, false, this.finalMatrix)

    const uOpacity = info.uniforms.get('u_opacity')
    if (uOpacity) gl.uniform1f(uOpacity, layer.transform.opacity)

    setRevealUniforms(gl, info, layer)

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
   * 이미지 경로와 같은 매트릭스를 쓴다. 도형의 자연 크기(ShapeSpec.width/height)가
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
    applyFolderMatrix(this.layerMatrix, layer.folderId, this.folderMatrices)
    mat3Multiply(this.clipMatrix, this.layerMatrix, this.finalMatrix)

    gl.useProgram(info.program)

    const uMatrix = info.uniforms.get('u_matrix')
    if (uMatrix) gl.uniformMatrix3fv(uMatrix, false, this.finalMatrix)

    const uOpacity = info.uniforms.get('u_opacity')
    if (uOpacity) gl.uniform1f(uOpacity, layer.transform.opacity)

    setRevealUniforms(gl, info, layer)

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

  /**
   * 글자 레이어.
   *
   * 글자 상자 전체가 이미지 한 장인 것처럼 매트릭스를 만들고(그래야 맞춤 / 기준점 /
   * 캔버스 배율 규칙이 이미지와 같다), 그 안에서 글자 하나하나를 따로 그린다.
   *
   * 글자별 변형은 상자 로컬 좌표에서 일어난다. 레이어를 45도 기울이면 글자가
   * 들어오는 방향도 함께 기운다. 가리기가 레이어를 따라 도는 것과 같은 규칙이다.
   */
  private drawTextLayer(doc: CompositionSnapshot, layer: ResolvedLayer): void {
    const spec = layer.text
    if (!spec) return

    const gl = this.gl
    let raster: TextRaster
    try {
      raster = this.texts.get(spec)
    } catch {
      // 글꼴을 못 굽는 상황에서 프리뷰 전체가 멈추면 안 된다. 이 레이어만 빠진다.
      return
    }

    const { layout } = raster
    const boxW = Math.max(1, layout.width)
    const boxH = Math.max(1, layout.height)

    buildLayerMatrix(
      layer.transform,
      layer.fit,
      doc.canvas.w,
      doc.canvas.h,
      boxW,
      boxH,
      this.layerMatrix,
    )
    applyFolderMatrix(this.layerMatrix, layer.folderId, this.folderMatrices)
    mat3Multiply(this.clipMatrix, this.layerMatrix, this.textBase)

    const info = this.programs.get(TEXT_VS, TEXT_FS)
    gl.useProgram(info.program)

    const uOpacity = info.uniforms.get('u_opacity')
    if (uOpacity) gl.uniform1f(uOpacity, layer.transform.opacity)

    setRevealUniforms(gl, info, layer)

    const uImage = info.uniforms.get('u_image')
    if (uImage) {
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, raster.texture)
      gl.uniform1i(uImage, 0)
    }

    const uMatrix = info.uniforms.get('u_matrix')
    const uAtlas = info.uniforms.get('u_atlas')
    const uBox = info.uniforms.get('u_box')
    const uCharAlpha = info.uniforms.get('u_charAlpha')

    const anim = layer.charAnim
    const count = Math.max(1, layout.animCount)
    const t = layer.transform.charIn

    // 칸 하나가 차지하는 UV. 격자가 균일하므로 한 번만 계산한다.
    const du = raster.cellW / raster.atlasW
    const dv = raster.cellH / raster.atlasH
    // 칸은 여백을 품고 있다. 쿼드도 같은 크기로 놓아야 글자가 늘어나지 않는다.
    const quadW = raster.cellW / raster.scale
    const quadH = raster.cellH / raster.scale

    let drawn = 0
    for (const glyph of layout.glyphs) {
      if (glyph.order < 0) continue
      /*
       * 아틀라스 칸 번호는 glyph.order 와 같다. 굽는 쪽(textAtlas.bakeText)이
       * order >= 0 인 글리프만 같은 순서로 격자에 넣기 때문이다.
       */
      let slot = drawn
      drawn += 1

      // 글자 칸의 한가운데. 배치가 정한 자리를 그대로 쓴다.
      const cx = glyph.x + glyph.w / 2
      const cy = glyph.y + glyph.h / 2

      let tx = 0
      let ty = 0
      let rot = 0
      let sc = 1
      let scx = 1
      let alpha = 1
      if (anim) {
        // 곡선은 글자마다 걸린다. 원시 진행률은 투명도가 따로 쓴다(깜빡임 방지).
        const eased = charEasedProgress(anim, glyph.order, count, t)
        const raw = charProgress(anim, glyph.order, count, t)
        const ct = charTransformAt(anim, glyph.order, eased, raw)
        tx = ct.tx * spec.fontSize
        ty = ct.ty * spec.fontSize
        rot = ct.rotate
        sc = ct.scale
        scx = ct.scaleX
        alpha = ct.opacity

        /*
         * 굴리기는 그리는 칸만 바꾼다. 자리도 크기도 그대로다.
         *
         * 격자가 균일해서 어느 칸을 빌려도 쿼드 크기가 같다. 글자마다 다른 전진폭
         * (glyph.w)은 자리를 정할 때 이미 쓰였고 그리는 데는 quadW 를 쓰므로, 빌린
         * 글자는 원래 글자가 앉을 상자 한가운데에 그대로 앉는다.
         */
        const borrowed = charScrambleSlot(anim, glyph.order, count, raw)
        if (borrowed >= 0) slot = borrowed
      }
      if (alpha <= 0) continue

      const col = slot % raster.cols
      const row = Math.floor(slot / raster.cols)

      /*
       * 글자 하나의 매트릭스.
       *
       *   T(중심 + 이동) · R · S · T(-중심) · 칸 사각형
       *
       * 상자 로컬 픽셀로 계산한 뒤 마지막에 [0,1] 로 정규화한다. buildLayerMatrix 가
       * 유닛 사각형을 받기 때문이다.
       */
      const rad = (rot * Math.PI) / 180
      const cos = Math.cos(rad)
      const sin = Math.sin(rad)
      const sx = sc * scx
      const sy = sc

      // 열 우선 3x3. m[0] m[3] m[6] / m[1] m[4] m[7] / m[2] m[5] m[8]
      const m = this.textLocal
      // 회전 + 배율
      const a00 = cos * sx
      const a01 = -sin * sy
      const a10 = sin * sx
      const a11 = cos * sy
      // 유닛 사각형 -> 칸 크기 -> 중심 기준으로 옮김
      m[0] = (a00 * quadW) / boxW
      m[1] = (a10 * quadW) / boxH
      m[2] = 0
      m[3] = (a01 * quadH) / boxW
      m[4] = (a11 * quadH) / boxH
      m[5] = 0
      const ox = -quadW / 2
      const oy = -quadH / 2
      m[6] = (cx + tx + a00 * ox + a01 * oy) / boxW
      m[7] = (cy + ty + a10 * ox + a11 * oy) / boxH
      m[8] = 1

      mat3Multiply(this.textBase, m, this.finalMatrix)

      if (uMatrix) gl.uniformMatrix3fv(uMatrix, false, this.finalMatrix)
      if (uAtlas) gl.uniform4f(uAtlas, col * du, row * dv, du, dv)
      // 가리기는 글자가 움직이기 전 자리로 잰다. 경계선이 글자를 따라다니면 안 된다.
      if (uBox) {
        gl.uniform4f(
          uBox,
          (cx - quadW / 2) / boxW,
          (cy - quadH / 2) / boxH,
          quadW / boxW,
          quadH / boxH,
        )
      }
      if (uCharAlpha) gl.uniform1f(uCharAlpha, alpha)

      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    }
  }

  dispose(): void {
    // 이펙트 체인이 컨텍스트별로 들고 있는 VAO 와 노이즈 아틀라스를 먼저 정리한다.
    disposeEffectResources(this.gl)
    this.programs.dispose()
    this.targets.dispose()
    this.texts.dispose()
    if (this.emptyVao) this.gl.deleteVertexArray(this.emptyVao)
  }
}

export { WebGL2UnsupportedError } from './gl.ts'
