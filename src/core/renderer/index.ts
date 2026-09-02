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
  EffectInstance,
  RenderTarget,
  ResolvedLayer,
} from '../types.ts'
import { parseHexColor, premultiply } from '../color.ts'
import { REVEAL_MODE_CODE } from '../reveal.ts'
import { resolveComposition } from '../evaluate.ts'
import { solveOverscan, type OverscanMap } from '../overscan.ts'
import { buildLayerMatrix, canvasToClip, mat3Multiply, type Mat3 } from '../transform.ts'
import { applyFolderMatrix, buildFolderMatrices } from '../group.ts'
import { clipGroups, subtreeEnds, type ClipGroup } from '../clip.ts'
import { glyphInkCenterX, renderStepsForRange } from './renderPlan.ts'
import { CLIP_FS } from './shaders/clip.ts'
import { secToFrame } from '../time.ts'
import { applyPixelStorePolicy, setPremultipliedBlend, type GlCapabilities } from './gl.ts'
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
import { ParticleFrameCache } from '@/particles/frames.ts'

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

/**
 * 색 덧씌우기 유니폼. 가리기와 같은 이유로 tint 가 없어도 양을 0 으로 반드시 쓴다
 * (setRevealUniforms 주석).
 */
function setTintUniforms(
  gl: WebGL2RenderingContext,
  info: ProgramInfo,
  layer: ResolvedLayer,
): void {
  const uAmount = info.uniforms.get('u_tintAmount')
  const tint = layer.tint
  if (!tint || tint.amount <= 0) {
    if (uAmount) gl.uniform1f(uAmount, 0)
    return
  }
  if (uAmount) gl.uniform1f(uAmount, tint.amount)
  const uColor = info.uniforms.get('u_tintColor')
  if (uColor) gl.uniform3f(uColor, tint.r, tint.g, tint.b)
}

/**
 * 흐림 채널 하나짜리 이펙트 인스턴스.
 *
 * 흐림은 이웃 픽셀을 읽어야 해서 행렬로는 표현할 수 없고, 기존 fx.blur 패스가
 * 정확히 그 일을 한다. 채널 전용 셰이더를 새로 만들면 같은 흐림이 두 벌이 된다.
 *
 * 사용자 이펙트 배열에 이어 붙이면 안 된다. C 단계는 배열 순서가 아니라 카탈로그
 * 순서로 도는데(passGraph planFusedStage) fx.blur 는 카탈로그 앞쪽이라, 스캔라인이나
 * 그레인 같은 뒤쪽 원자가 흐린 그림 위에 다시 또렷하게 찍힌다. 그래서 이 인스턴스는
 * 사용자 체인이 다 끝난 뒤 **별도 체인**으로 돌린다 (renderLayerAlone).
 *
 * 반경은 문서 픽셀 값이다. 셰이더는 타깃 해상도로 나누므로(u_resolution) 썸네일이나
 * 크기를 바꾼 내보내기에서는 같은 값이 다르게 번진다. 타깃/문서 비율로 환산해
 * "프리뷰 = 결과물" 을 지킨다.
 */
function channelBlurInstance(
  layer: ResolvedLayer,
  targetW: number,
  docW: number,
): EffectInstance | null {
  const radius = layer.transform.blur
  if (radius <= 0) return null
  const scale = docW > 0 ? targetW / docW : 1
  return {
    id: `${layer.layerId}:channelBlur`,
    type: 'fx.blur',
    enabled: true,
    seed: 0,
    holdFrames: 1,
    requiresHistory: false,
    params: { radius: Math.min(80, radius) * scale, taps: 36, mix: 1 },
  }
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

  /**
   * 파티클 레이어의 프레임 공급과 텍스처.
   *
   * 파티클은 Canvas 2D 로 그린 뒤 프레임마다 텍스처로 올린다. 이 경로만은
   * document 를 쓰므로 (src/particles) 메인 스레드에서만 돈다. 지금 내보내기도
   * 메인 스레드에서 렌더하므로 (워커는 인코딩만 한다) 프리뷰 = 결과물 약속은
   * 그대로다.
   */
  private readonly particleFrames = new ParticleFrameCache()
  private readonly particleTextures = new Map<string, { texture: WebGLTexture }>()

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
    // 문서에서 사라진 파티클 레이어의 엔진과 텍스처를 돌려준다.
    if (this.particleTextures.size > 0 || layers.some((l) => l.particle)) {
      const alive = new Set(layers.filter((l) => l.particle).map((l) => l.layerId))
      this.particleFrames.prune(alive)
      for (const [id, slot] of this.particleTextures) {
        if (!alive.has(id)) {
          gl.deleteTexture(slot.texture)
          this.particleTextures.delete(id)
        }
      }
    }
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

    // 레이어별 이펙트가 있으면 그 레이어를 따로 그려 체인을 태워야 하고,
    // 혼합 모드가 있으면 배경을 읽어야 한다. 둘 다 오프스크린을 요구한다.
    const layerNeedsPass = layers.map(
      (l) =>
        (!!l.assetId || !!l.shape || !!l.text || !!l.particle) &&
        l.visible &&
        (l.blend !== 'normal' ||
          l.transform.blur > 0 ||
          hasActiveEffects(l.effects, frame)),
    )
    /*
     * 혼합 모드가 걸린 보이는 폴더는 서브트리를 한 장에 담아 폴더의 blend 로
     * 얹어야 한다. 이 판정이 빠지면 빠른 경로로 빠져 폴더 혼합이 조용히 무시된다.
     */
    const hasFolderBlend = layers.some(
      (l) => !!l.isFolder && l.visible && l.blend !== 'normal',
    )
    const needsOffscreen = layerNeedsPass.some(Boolean) || groups.length > 0 || hasFolderBlend

    gl.bindVertexArray(this.emptyVao)

    if (!needsOffscreen) {
      // 흔한 경우. 오프스크린을 거칠 이유가 없다.
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo)
      gl.viewport(0, 0, target.width, target.height)
      this.clearBackground(doc)
      setPremultipliedBlend(gl)
      for (const layer of layers) this.drawLayer(doc, layer, assets, frame)
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

      /** 레이어 한 장을 layerBuf 에 그리고 이펙트까지 태운 결과. */
      const renderLayerAlone = (layer: ResolvedLayer): PooledTarget => {
        // 레이어만 따로 그린다. 배경과 섞이면 이펙트가 배경까지 망가뜨린다.
        gl.bindFramebuffer(gl.FRAMEBUFFER, layerBuf.fbo)
        gl.viewport(0, 0, w, h)
        gl.clearColor(0, 0, 0, 0)
        gl.clear(gl.COLOR_BUFFER_BIT)
        setPremultipliedBlend(gl)
        this.drawLayer(doc, layer, assets, frame)

        const runChain = (source: PooledTarget, output: PooledTarget, effects: EffectInstance[]) =>
          runEffectChain(
            { gl, programs: this.programs, targets: this.targets },
            {
              source,
              output: { fbo: output.fbo, width: w, height: h },
              effects,
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

        let current = layerBuf
        if (hasActiveEffects(layer.effects, frame)) {
          if (runChain(current, fxBuf, layer.effects)) current = fxBuf
        }

        /*
         * 흐림 채널은 사용자 체인이 다 끝난 뒤 별도 체인으로 돌린다. 같은 체인에
         * 붙이면 C 단계가 카탈로그 순서로 돌아 스캔라인/그레인이 흐림 뒤에 다시
         * 또렷하게 찍힌다 (channelBlurInstance 주석).
         */
        const blurFx = channelBlurInstance(layer, w, doc.canvas.w)
        if (blurFx) {
          const output = current === layerBuf ? fxBuf : layerBuf
          if (runChain(current, output, [blurFx])) current = output
        }

        // 체인은 자기 VAO 를 바인딩하고 블렌딩을 꺼 둔 채 돌아온다. 되돌린다.
        gl.bindVertexArray(this.emptyVao)
        return current
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
       * 재귀 한 단계 동안만 쓰는 대여. 절차가 끝나면 즉시 반납한다.
       *
       * 자르기 덩어리 안에 또 자르기 덩어리가 있을 수 있다(자르기에 참여한 폴더
       * 안의 자르기). 마스크와 덩어리 버퍼를 공유하면 안쪽 덩어리가 바깥 덩어리의
       * 마스크를 덮는다. 그래서 덩어리마다 새로 빌리고 나가면서 바로 돌려줘,
       * 살아 있는 버퍼가 중첩 깊이만큼만 늘어난다. acquire 가 던져도 finally 가
       * 이 단계에서 빌린 것을 돌려주므로 inUse 로 굳는 항목이 없다.
       */
      const scoped = <T,>(fn: (borrowLocal: () => PooledTarget) => T): T => {
        const local: PooledTarget[] = []
        try {
          return fn(() => {
            const t = this.targets.acquire(w, h, 'rgba8')
            local.push(t)
            return t
          })
        } finally {
          for (const t of local) this.targets.release(t)
        }
      }

      /**
       * dest 위에 source 를 혼합 모드로 얹는다.
       *
       * 누산기(compose)와 달리 스왑하지 않는다. 재귀 안에서 스왑하면 빌린 버퍼의
       * 소유가 호출자와 어긋난다. 대신 임시 한 장에 섞은 뒤 dest 로 되돌려
       * 복사한다. 복사 한 번이 더 들지만 폴더 안 혼합 모드는 드문 경로다.
       */
      const composeOnto = (dest: PooledTarget, source: PooledTarget, blend: BlendMode): void => {
        if (blend === 'normal') {
          gl.bindFramebuffer(gl.FRAMEBUFFER, dest.fbo)
          gl.viewport(0, 0, w, h)
          setPremultipliedBlend(gl)
          this.composePass(source)
          return
        }
        scoped((borrowLocal) => {
          const tmp = borrowLocal()
          this.blendPass(dest, source, tmp, blend)
          this.copyPass(tmp, { gl, width: w, height: h, fbo: dest.fbo })
        })
      }

      /**
       * 자르기 덩어리 하나.
       *
       *   1. 밑판을 혼자 그린다. 그 알파가 곧 마스크다.
       *   2. 같은 그림을 덩어리 버퍼에도 깔아 둔다.
       *   3. 위에 붙는 레이어를 하나씩 그려 마스크로 깎아 덩어리에 얹는다.
       *   4. 덩어리를 밑판의 혼합 모드로 얹는다. 어디에 얹는지는 composeFn 이
       *      정한다 — 최상위는 누산기(스왑), 재귀에서는 담고 있는 범위의 버퍼다.
       *
       * 밑판도 붙는 쪽도 폴더일 수 있다. 그때는 폴더 안쪽 전체가 한 장으로
       * 그려진 뒤 그 한 장이 마스크가 되거나 잘린다. 도형 여러 장으로 만든
       * 모양 안에만 사진을 채우는 것이 이 경로다. 그 안쪽에 또 자르기가 있으면
       * renderRange 가 이 함수를 다시 부르므로 버퍼는 공유하지 않고
       * 덩어리마다 빌린다(scoped 주석).
       *
       * 밑판을 먼저 복사해 두고 식구를 그린다. 폴더 경로가 unitBuf 를
       * 공유하므로, 복사 전에 식구를 그리면 마스크가 덮인다.
       */
      const renderClipGroup = (
        group: ClipGroup,
        composeFn: (source: PooledTarget, blend: BlendMode) => void,
      ): void => {
        scoped((borrowLocal) => {
          const mask = borrowLocal()
          const grp = borrowLocal()
          /** 폴더 하나를 통째로 담는 자리. 폴더가 자르기에 참여할 때만 빌린다. */
          let unitBuf: PooledTarget | null = null
          /** 자르기에 참여하는 한 덩이. 폴더면 안쪽까지, 아니면 자기 한 장이다. */
          const unit = (index: number, end: number): PooledTarget => {
            if (end > index) {
              if (!unitBuf) unitBuf = borrowLocal()
              // 폴더 자신은 아무것도 그리지 않는다. 식구부터 담는다.
              return renderRange(unitBuf, index + 1, end)
            }
            return renderLayerAlone(layers[index]!)
          }

          const baseSource = unit(group.base, group.baseEnd)
          this.copyPass(baseSource, { gl, width: w, height: h, fbo: mask.fbo })
          this.copyPass(baseSource, { gl, width: w, height: h, fbo: grp.fbo })

          for (const m of group.members) {
            const source = unit(m, subtreeEnd[m] ?? m)
            this.clipPass(grp, source, mask)
          }

          composeFn(grp, layers[group.base]!.blend)
        })
      }

      /**
       * from..to 를 dest 한 장에 담는다. 폴더 하나를 통째로 그릴 때 쓴다.
       *
       * 순회 규칙은 최상위 루프와 같다(renderPlan.renderStepsForRange). 그래서
       * 범위 안의 자르기 덩어리와 혼합 모드 폴더도 여기서 그대로 처리된다.
       * 예전에는 평면 노멀 합성만 해서, 자르기에 참여한 폴더 안의 중첩 자르기가
       * 통째로 무시됐다.
       *
       * 안에서의 혼합 모드는 dest 한 장을 배경으로 읽는다(고립 그룹). 바깥
       * 배경까지 읽게 하려면 배경을 한 장 더 떠야 하는데, 폴더가 통째로
       * 마스크가 되거나 잘리거나 혼합되는 자리에서는 바깥 배경이 어차피
       * 정의되지 않는다. 이펙트는 레이어마다 그대로 걸린다.
       *
       * 재귀는 범위가 반드시 줄어들므로(폴더 식구는 폴더 뒤에 붙는다) 폴더
       * 중첩 상한(group.ts MAX_FOLDER_DEPTH) 이상 내려가지 않는다.
       */
      const renderRange = (dest: PooledTarget, from: number, to: number): PooledTarget => {
        gl.bindFramebuffer(gl.FRAMEBUFFER, dest.fbo)
        gl.viewport(0, 0, w, h)
        gl.clearColor(0, 0, 0, 0)
        gl.clear(gl.COLOR_BUFFER_BIT)

        for (const step of renderStepsForRange(layers, groupByBase, subtreeEnd, from, to)) {
          if (step.kind === 'clipGroup') {
            renderClipGroup(step.group, (source, blend) => composeOnto(dest, source, blend))
            continue
          }
          if (step.kind === 'folderBlend') {
            scoped((borrowLocal) => {
              const sub = borrowLocal()
              renderRange(sub, step.index + 1, step.end)
              composeOnto(dest, sub, layers[step.index]!.blend)
            })
            continue
          }
          const inner = layers[step.index]!
          if (!layerNeedsPass[step.index]) {
            gl.bindFramebuffer(gl.FRAMEBUFFER, dest.fbo)
            gl.viewport(0, 0, w, h)
            setPremultipliedBlend(gl)
            this.drawLayer(doc, inner, assets, frame)
            continue
          }
          // 이펙트나 혼합 모드가 있는 레이어. 따로 그린 뒤 자기 blend 로 얹는다.
          composeOnto(dest, renderLayerAlone(inner), inner.blend)
        }
        return dest
      }

      for (const step of renderStepsForRange(layers, groupByBase, subtreeEnd, 0, layers.length - 1)) {
        if (step.kind === 'clipGroup') {
          renderClipGroup(step.group, compose)
          continue
        }
        if (step.kind === 'folderBlend') {
          // 폴더 서브트리를 한 장에 담아 폴더의 혼합 모드로 누산기에 얹는다.
          scoped((borrowLocal) => {
            const sub = borrowLocal()
            renderRange(sub, step.index + 1, step.end)
            compose(sub, layers[step.index]!.blend)
          })
          continue
        }
        const layer = layers[step.index]!
        if (!layerNeedsPass[step.index]) {
          gl.bindFramebuffer(gl.FRAMEBUFFER, acc.fbo)
          gl.viewport(0, 0, w, h)
          setPremultipliedBlend(gl)
          this.drawLayer(doc, layer, assets, frame)
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
    frame: number,
  ): void {
    if (!layer.visible) return
    if (layer.transform.opacity <= 0) return

    // 도형 / 글자 / 파티클이 먼저다. 셋 다 에셋을 가리키지 않는다.
    if (layer.shape) {
      this.drawShapeLayer(doc, layer)
      return
    }
    if (layer.text) {
      this.drawTextLayer(doc, layer)
      return
    }
    if (layer.particle) {
      this.drawParticleLayer(doc, layer, frame)
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
    setTintUniforms(gl, info, layer)

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
    setTintUniforms(gl, info, layer)

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
   * 파티클 레이어.
   *
   * 엔진(src/particles)이 Canvas 2D 로 캔버스 크기의 한 장을 그리고, 그걸 프레임마다
   * 텍스처로 올려 이미지 경로와 같은 쿼드로 그린다. 원본 크기 = 캔버스 크기라
   * 맞춤 / 기준점 / 배율 규칙이 이미지와 한 글자도 다르지 않고, 변환 / 투명도 /
   * 가리기 / 색 덧씌우기 유니폼도 그대로 걸린다.
   */
  private drawParticleLayer(
    doc: CompositionSnapshot,
    layer: ResolvedLayer,
    frame: number,
  ): void {
    const spec = layer.particle
    if (!spec) return

    const gl = this.gl
    const w = doc.canvas.w
    const h = doc.canvas.h
    const canvas = this.particleFrames.frame(
      layer.layerId,
      spec,
      w,
      h,
      frame,
      doc.timeline.durationFrames,
      doc.timeline.fps,
    )
    if (!canvas) return

    let slot = this.particleTextures.get(layer.layerId)
    if (!slot) {
      const texture = gl.createTexture()
      if (!texture) return
      gl.bindTexture(gl.TEXTURE_2D, texture)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      slot = { texture }
      this.particleTextures.set(layer.layerId, slot)
    }

    // 캔버스 내용은 프레임마다 다르므로 매 프레임 올린다. 업로드는 straight alpha 다
    // (gl.ts 픽셀 저장 정책). 셰이더가 마지막에 premultiply 하는 계약 그대로다.
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, slot.texture)
    applyPixelStorePolicy(gl)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, canvas)

    const info = this.programs.get(LAYER_VS, LAYER_FS)

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
    setTintUniforms(gl, info, layer)

    const uImage = info.uniforms.get('u_image')
    if (uImage) gl.uniform1i(uImage, 0)

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
    setTintUniforms(gl, info, layer)

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

      /*
       * 잉크의 가로 중심. 자간 포함 폭(glyph.w)의 중심이 아니다 — 거기에 놓으면
       * 모든 글자가 +자간/2 만큼 밀리고 마지막 글자가 상자를 벗어난다.
       * 근거는 renderPlan.glyphInkCenterX 주석에 있다. u_box 도 같은 cx 를 쓰므로
       * 가리기 경계도 함께 맞는다.
       */
      const cx = glyphInkCenterX(glyph.x, glyph.w, spec.letterSpacing)
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
    for (const slot of this.particleTextures.values()) this.gl.deleteTexture(slot.texture)
    this.particleTextures.clear()
    if (this.emptyVao) this.gl.deleteVertexArray(this.emptyVao)
  }
}

export { WebGL2UnsupportedError } from './gl.ts'
