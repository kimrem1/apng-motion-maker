/**
 * 이펙트 패스 그래프 컴파일러.
 *
 *   A 변형(UV 누산 융합) -> B 파괴(개별 패스) -> C 마감(색 변환 융합)
 *
 * 스테이지 간 순서는 항상 이 순서다. A 와 C 안에서의 순서는 registry.ts 의
 * EFFECT_DEFS 배열 순서다. 하나의 프로그램에 #ifdef 로 조각을 켜고 끄는 구조라
 * 호출 순서가 소스에 박혀 있기 때문이다.
 *
 * 같은 종류를 두 번 쌓으면(예: 흔들림 두 개) 하나의 융합 패스에 담을 수 없다.
 * #define 이 종류당 하나뿐이라 두 번째 인스턴스의 유니폼이 첫 번째를 덮어쓴다.
 * 그래서 종류가 겹치지 않도록 버킷을 나누고 버킷마다 패스를 하나씩 낸다.
 * fusable: false 인 조각(방향성 블러처럼 이웃을 읽는 것)도 같은 이유로 버킷을 끊는다.
 * passes() 를 가진 B 이펙트(픽셀 소트)는 같은 셰이더를 그 횟수만큼 반복한다.
 *
 * 이 파일이 건드리는 GL 상태
 *
 *   - 자체 VAO 를 바인딩하고 그대로 둔다. 이 저장소의 모든 드로우가 attribute-less 라
 *     문제가 없지만, 이후에 정점 버퍼를 쓰는 패스가 생기면 다시 바인딩해야 한다.
 *   - GL_BLEND 를 끈 채로 돌려준다. 패스는 결과를 덮어써야 하기 때문이다.
 *     이어서 레이어를 그린다면 setPremultipliedBlend 를 다시 불러야 한다.
 *   - 텍스처 유닛 0 을 활성으로 돌려준다.
 *   - 프레임버퍼 바인딩은 마지막 패스의 출력에 남는다.
 */

import type { EffectInstance } from '@/core/types.ts'
import { effectiveFrame, hashSeed } from '@/core/rng.ts'
import { FULLSCREEN_VS } from '@/core/renderer/shaders/layer.ts'
import type { ProgramCache, ProgramInfo } from '@/core/renderer/programCache.ts'
import type { PooledTarget, TargetPool } from '@/core/renderer/targetPool.ts'
import type { EffectDef, EffectEvalContext, EffectStage, UniformValue } from './types.ts'
import {
  EFFECT_BY_ID,
  EFFECT_DEFS,
  effectDefine,
  effectEntry,
  effectFragment,
  effectGlsl,
  effectPassCount,
  evalEffectUniforms,
  isEffectActiveAt,
  isFusable,
  resolveEffectParams,
  STAGE_PROLOGUE,
} from './registry.ts'
import { EFFECT_FS_PRELUDE } from './glsl/common.ts'
import {
  NOISE_ATLAS_LAYERS,
  NOISE_ATLAS_SIZE,
  createNoiseAtlas,
} from './noiseAtlas.ts'

// ---------------------------------------------------------------------------
// 융합 셰이더 조립 (모듈 로드 시 한 번)
// ---------------------------------------------------------------------------

function fusedDefs(stage: EffectStage): EffectDef[] {
  return EFFECT_DEFS.filter((d) => d.stage === stage && !!effectGlsl(d))
}

function buildFusedFragment(stage: 'A' | 'C'): string {
  const defs = fusedDefs(stage)
  const blocks = defs.map((d) => `#ifdef ${effectDefine(d)}\n${effectGlsl(d)}\n#endif`).join('\n')
  const calls = defs
    .map((d) =>
      stage === 'A'
        ? `#ifdef ${effectDefine(d)}\n  uv += ${effectEntry(d)}(uv, u_texel);\n#endif`
        : `#ifdef ${effectDefine(d)}\n  c = ${effectEntry(d)}(c, v_uv);\n#endif`,
    )
    .join('\n')

  const body =
    stage === 'A'
      ? `  vec2 uv = v_uv;\n${calls}\n  fragColor = fxFetch(u_image, uv);`
      : `  vec4 c = texture(u_image, v_uv);\n${calls}\n  fragColor = fxClampPremultiplied(c);`

  return `${EFFECT_FS_PRELUDE}
${STAGE_PROLOGUE[stage]}
${blocks}

void main() {
${body}
}
`
}

/** A 스테이지 융합 셰이더. 활성 이펙트의 define 만 켜서 변형을 만든다. */
export const EFFECT_WARP_FS = buildFusedFragment('A')

/** C 스테이지 융합 셰이더. */
export const EFFECT_GRADE_FS = buildFusedFragment('C')

/** ProgramCache.warmup 에 그대로 넘길 수 있는 조합. 앱 시작 시 부른다. */
export function effectWarmupCombos(): { vs: string; fs: string; defines: string[] }[] {
  const combos: { vs: string; fs: string; defines: string[] }[] = []
  for (const def of EFFECT_DEFS) {
    const fs = def.stage === 'B' ? effectFragment(def) : undefined
    if (fs) combos.push({ vs: FULLSCREEN_VS, fs, defines: [] })
  }
  combos.push({ vs: FULLSCREEN_VS, fs: EFFECT_WARP_FS, defines: [] })
  combos.push({ vs: FULLSCREEN_VS, fs: EFFECT_GRADE_FS, defines: [] })
  return combos
}

// ---------------------------------------------------------------------------
// 컨텍스트별 공용 리소스
// ---------------------------------------------------------------------------

interface EffectResources {
  vao: WebGLVertexArrayObject | null
  atlases: Map<number, WebGLTexture>
}

/**
 * 노이즈 아틀라스와 빈 VAO 는 프레임 루프 안에서 만들면 안 된다.
 * 컨텍스트가 살아 있는 동안만 유지하면 되므로 WeakMap 이 정확한 수명이다.
 */
const RESOURCES = new WeakMap<WebGL2RenderingContext, EffectResources>()

/** 프로젝트 시드마다 아틀라스가 달라진다. 문서를 몇 개 열어도 두 장이면 충분하다. */
const MAX_ATLASES = 2

function getResources(gl: WebGL2RenderingContext): EffectResources {
  let res = RESOURCES.get(gl)
  if (!res) {
    res = { vao: gl.createVertexArray(), atlases: new Map() }
    RESOURCES.set(gl, res)
  }
  return res
}

function getNoiseAtlas(gl: WebGL2RenderingContext, seed: number): WebGLTexture {
  const res = getResources(gl)
  const key = seed >>> 0
  const hit = res.atlases.get(key)
  if (hit) return hit

  const texture = createNoiseAtlas(gl, NOISE_ATLAS_SIZE, NOISE_ATLAS_LAYERS, key)
  res.atlases.set(key, texture)

  if (res.atlases.size > MAX_ATLASES) {
    const oldest = res.atlases.keys().next().value
    if (oldest !== undefined) {
      const old = res.atlases.get(oldest)
      if (old) gl.deleteTexture(old)
      res.atlases.delete(oldest)
    }
  }
  return texture
}

/** 컨텍스트를 버릴 때 부른다. Renderer.dispose 에서 함께 부르면 된다. */
export function disposeEffectResources(gl: WebGL2RenderingContext): void {
  const res = RESOURCES.get(gl)
  if (!res) return
  for (const texture of res.atlases.values()) gl.deleteTexture(texture)
  res.atlases.clear()
  if (res.vao) gl.deleteVertexArray(res.vao)
  RESOURCES.delete(gl)
}

// ---------------------------------------------------------------------------
// 패스 계획
// ---------------------------------------------------------------------------

interface ResolvedEffect {
  def: EffectDef
  instance: EffectInstance
  /** EFFECT_DEFS 안의 위치. 융합 패스의 define 순서를 안정시킨다. */
  order: number
  /** 프레임마다 확정된 파라미터. 반복 패스 수를 정하는 데도 쓴다. */
  params: Record<string, number>
}

interface Pass {
  stage: EffectStage
  items: ResolvedEffect[]
  /** 다중 패스 이펙트의 현재 패스 번호. 융합 패스는 항상 0 이다. */
  passIndex: number
  passCount: number
}

/**
 * 융합 스테이지 하나를 패스 목록으로 만든다.
 *
 * 융합 셰이더의 호출 순서는 소스에 박혀 있으므로 항목을 정의 순서로 세운다.
 * 그 상태에서 앞에서부터 담다가 두 경우에 패스를 끊는다.
 *   1. 같은 종류가 다시 나온다   -> #define 이 종류당 하나뿐이라 유니폼이 덮어써진다
 *   2. fusable: false 인 조각     -> 이웃 픽셀을 읽으므로 단독 패스여야 한다
 */
function planFusedStage(items: ResolvedEffect[], stage: EffectStage): Pass[] {
  const sorted = [...items].sort((a, b) => a.order - b.order)
  const passes: Pass[] = []
  const seen = new Set<string>()
  let bucket: ResolvedEffect[] = []

  const flush = (): void => {
    if (bucket.length === 0) return
    passes.push({ stage, items: bucket, passIndex: 0, passCount: 1 })
    bucket = []
    seen.clear()
  }

  for (const item of sorted) {
    if (!isFusable(item.def)) {
      flush()
      passes.push({ stage, items: [item], passIndex: 0, passCount: 1 })
      continue
    }
    if (seen.has(item.def.id)) flush()
    bucket.push(item)
    seen.add(item.def.id)
  }
  flush()
  return passes
}

/** B 는 개별 패스다. 반복 이펙트(픽셀 소트)는 같은 셰이더를 N 번 돈다. */
function planSingleStage(items: ResolvedEffect[]): Pass[] {
  const passes: Pass[] = []
  for (const item of items) {
    const count = effectPassCount(item.def, item.params)
    for (let i = 0; i < count; i += 1) {
      passes.push({ stage: 'B', items: [item], passIndex: i, passCount: count })
    }
  }
  return passes
}

function planPasses(active: ResolvedEffect[]): Pass[] {
  const stageA = active.filter((x) => x.def.stage === 'A' && !!effectGlsl(x.def))
  const stageB = active.filter((x) => x.def.stage === 'B' && !!effectFragment(x.def))
  const stageC = active.filter((x) => x.def.stage === 'C' && !!effectGlsl(x.def))

  return [
    ...planFusedStage(stageA, 'A'),
    ...planSingleStage(stageB),
    ...planFusedStage(stageC, 'C'),
  ]
}

// ---------------------------------------------------------------------------
// 공개 API
// ---------------------------------------------------------------------------

export interface EffectChainDeps {
  gl: WebGL2RenderingContext
  programs: ProgramCache
  targets: TargetPool
}

export interface EffectChainInput {
  /** 이펙트를 적용할 원본 (레이어 렌더 결과, premultiplied). 절대 쓰기 대상이 되지 않는다. */
  source: PooledTarget
  /** 결과를 쓸 곳 */
  output: { fbo: WebGLFramebuffer | null; width: number; height: number }
  effects: readonly EffectInstance[]
  /**
   * 프레임 공통 정보.
   * projectSeed / nodeId / holdFrames 는 여기 넣지 않는다. 앞의 둘은 이 입력의 필드에서,
   * holdFrames 는 EffectInstance 에서 인스턴스마다 채운다.
   */
  ctxBase: Omit<
    EffectEvalContext,
    'seed' | 'effFrame' | 'params' | 'projectSeed' | 'nodeId' | 'holdFrames'
  >
  projectSeed: number
  nodeId: string
}

/** 이 프레임에 실제로 그릴 이펙트가 있는가. */
export function hasActiveEffects(effects: readonly EffectInstance[], frame: number): boolean {
  for (const instance of effects) {
    if (!isEffectActiveAt(instance, frame)) continue
    const def = EFFECT_BY_ID.get(instance.type)
    if (!def) continue
    if (def.stage === 'B' ? !!effectFragment(def) : !!effectGlsl(def)) return true
  }
  return false
}

/**
 * 체인을 실행한다.
 * 이펙트가 하나도 없으면 아무것도 그리지 않고 false 를 돌려준다.
 * 호출자는 그때 원본을 그대로 쓰거나 직접 복사하면 된다.
 */
export function runEffectChain(deps: EffectChainDeps, input: EffectChainInput): boolean {
  const { gl, targets } = deps
  const frame = input.ctxBase.frame

  const active: ResolvedEffect[] = []
  for (const instance of input.effects) {
    if (!isEffectActiveAt(instance, frame)) continue
    const def = EFFECT_BY_ID.get(instance.type)
    if (!def) continue
    const order = EFFECT_DEFS.indexOf(def)
    active.push({
      def,
      instance,
      order: order < 0 ? EFFECT_DEFS.length : order,
      params: resolveEffectParams(def, instance, frame),
    })
  }
  if (active.length === 0) return false

  const passes = planPasses(active)
  if (passes.length === 0) return false

  const w = input.source.width
  const h = input.source.height
  const res = getResources(gl)

  // 아틀라스는 실제로 u_noiseAtlas 를 선언한 프로그램이 나올 때까지 만들지 않는다.
  // 굽는 비용이 작지 않은데 아무도 안 쓰는 문서가 흔하다.
  let noiseTexture: WebGLTexture | null = null
  const noise = (): WebGLTexture => {
    if (!noiseTexture) noiseTexture = getNoiseAtlas(gl, input.projectSeed)
    return noiseTexture
  }

  gl.bindVertexArray(res.vao)
  gl.disable(gl.BLEND)
  gl.disable(gl.DEPTH_TEST)
  gl.disable(gl.SCISSOR_TEST)

  /**
   * 빌린 임시 타깃. 최대 두 장이다.
   * 중간에 예외가 나도 전부 돌려주려고 배열로 들고 있는다. 프레임 루프 안에서
   * 새로 만드는 일은 없어야 하므로 반납을 빠뜨리면 곧바로 누수다.
   */
  const borrowed: PooledTarget[] = []
  /** 지금 읽고 있는 임시 타깃. 원본은 여기 들어오지 않는다. */
  let held: PooledTarget | null = null
  /** 방금 자유로워진 타깃. 다음 패스의 출력지로 그대로 재사용한다. */
  let spare: PooledTarget | null = null
  let readTexture = input.source.texture

  try {
    for (let i = 0; i < passes.length; i += 1) {
      const pass = passes[i]!
      const isLast = i === passes.length - 1

      let dstFbo: WebGLFramebuffer | null
      let dstW: number
      let dstH: number
      let dstTarget: PooledTarget | null = null

      if (isLast) {
        dstFbo = input.output.fbo
        dstW = input.output.width
        dstH = input.output.height
      } else {
        if (spare) {
          dstTarget = spare
          spare = null
        } else {
          dstTarget = targets.acquire(w, h, 'rgba8')
          borrowed.push(dstTarget)
        }
        dstFbo = dstTarget.fbo
        dstW = dstTarget.width
        dstH = dstTarget.height
      }

      drawPass(deps, pass, input, readTexture, noise, dstFbo, dstW, dstH, w, h)

      if (!isLast && dstTarget) {
        // 방금 읽은 타깃은 이제 자유롭다. 다음 패스가 거기에 쓴다.
        spare = held
        held = dstTarget
        readTexture = dstTarget.texture
      }
    }
  } finally {
    for (const target of borrowed) targets.release(target)
    gl.activeTexture(gl.TEXTURE0)
  }

  return true
}

// ---------------------------------------------------------------------------
// 패스 실행
// ---------------------------------------------------------------------------

function drawPass(
  deps: EffectChainDeps,
  pass: Pass,
  input: EffectChainInput,
  readTexture: WebGLTexture,
  noise: () => WebGLTexture,
  dstFbo: WebGLFramebuffer | null,
  dstW: number,
  dstH: number,
  srcW: number,
  srcH: number,
): void {
  const { gl, programs } = deps

  let info: ProgramInfo
  if (pass.stage === 'B') {
    const def = pass.items[0]!.def
    info = programs.get(FULLSCREEN_VS, effectFragment(def) ?? '')
  } else {
    const fs = pass.stage === 'A' ? EFFECT_WARP_FS : EFFECT_GRADE_FS
    const defines = pass.items.map((x) => effectDefine(x.def))
    info = programs.get(FULLSCREEN_VS, fs, defines)
  }

  gl.bindFramebuffer(gl.FRAMEBUFFER, dstFbo)
  gl.viewport(0, 0, dstW, dstH)
  gl.useProgram(info.program)

  // 공통 유니폼. 해상도는 언제나 소스 기준이다. 픽셀 격자(스캔라인/그레인)가
  // 출력 크기에 따라 흔들리면 안 된다.
  setFloat(gl, info, 'u_noiseLayers', NOISE_ATLAS_LAYERS)
  setVec2(gl, info, 'u_resolution', srcW, srcH)
  setVec2(gl, info, 'u_texel', 1 / Math.max(1, srcW), 1 / Math.max(1, srcH))
  setFloat(gl, info, 'u_aspect', srcW / Math.max(1, srcH))

  // 이 패스의 입력 텍스처. u_stageSrc 는 A 스테이지 조각(엣지 워프, 자기 디스플레이스먼트)이
  // 원본 픽셀을 읽을 때 쓰는 다른 이름이고, 가리키는 것은 같은 텍스처다.
  gl.activeTexture(gl.TEXTURE0)
  gl.bindTexture(gl.TEXTURE_2D, readTexture)
  const uImage = info.uniforms.get('u_image')
  if (uImage) gl.uniform1i(uImage, 0)
  const uStageSrc = info.uniforms.get('u_stageSrc')
  if (uStageSrc) gl.uniform1i(uStageSrc, 0)
  const uNoise = info.uniforms.get('u_noiseAtlas')
  if (uNoise) {
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, noise())
    gl.uniform1i(uNoise, 1)
  }

  for (const item of pass.items) {
    const ctx = buildContext(item, input, pass)
    for (const u of evalEffectUniforms(item.def, ctx)) {
      const loc = info.uniforms.get(u.name)
      if (!loc) continue
      setUniform(gl, loc, u.value, u.kind)
    }
  }

  gl.drawArrays(gl.TRIANGLES, 0, 3)
  gl.activeTexture(gl.TEXTURE0)
}

/**
 * 이펙트 하나의 평가 컨텍스트.
 *
 * seed 는 프레임을 섞지 않는다. 프레임별 난수가 필요한 이펙트는 registry.ts 의
 * frameSeed(ctx) 로 effFrame 을 직접 섞는다 (types.ts 의 seed 주석).
 * Track 파라미터는 홀드 클럭이 아니라 실제 재생헤드에서 평가한다. 홀드는 절차형
 * 난수를 끊어 주는 장치이지 사용자가 찍은 애니메이션을 끊는 장치가 아니다.
 */
function buildContext(
  item: ResolvedEffect,
  input: EffectChainInput,
  pass: Pass,
): EffectEvalContext {
  const { instance } = item
  const frame = input.ctxBase.frame
  const holdFrames = Math.max(1, Math.floor(instance.holdFrames) || 1)
  const effFrame = effectiveFrame(frame, holdFrames)
  const nodeId = `${input.nodeId}:${instance.id}`
  const base = (input.projectSeed ^ (instance.seed >>> 0)) >>> 0
  return {
    ...input.ctxBase,
    effFrame,
    holdFrames,
    projectSeed: input.projectSeed,
    instanceSeed: instance.seed >>> 0,
    nodeId,
    // 프레임 불변 시드와 프레임별 시드를 둘 다 준다. 어느 쪽을 쓰는지가 곧
    // "매끄럽게 흔들린다" 와 "매 프레임 새로 튄다" 의 차이다 (types.ts 주석).
    seedStatic: hashSeed(base, nodeId, 0),
    seed: hashSeed(base, nodeId, effFrame),
    pass: pass.passIndex,
    passCount: pass.passCount,
    params: item.params,
  }
}

// ---------------------------------------------------------------------------
// 유니폼 설정
// ---------------------------------------------------------------------------

function setFloat(gl: WebGL2RenderingContext, info: ProgramInfo, name: string, v: number): void {
  const loc = info.uniforms.get(name)
  if (loc) gl.uniform1f(loc, v)
}

function setVec2(
  gl: WebGL2RenderingContext,
  info: ProgramInfo,
  name: string,
  x: number,
  y: number,
): void {
  const loc = info.uniforms.get(name)
  if (loc) gl.uniform2f(loc, x, y)
}

/** 선언형 스펙의 int / uint 만 정수 유니폼으로 보낸다. 나머지는 float 계열이다. */
function setUniform(
  gl: WebGL2RenderingContext,
  loc: WebGLUniformLocation,
  value: UniformValue,
  kind: 'float' | 'int' | 'uint',
): void {
  if (typeof value === 'number') {
    if (kind === 'int') gl.uniform1i(loc, Math.round(value))
    else if (kind === 'uint') gl.uniform1ui(loc, Math.round(value) >>> 0)
    else gl.uniform1f(loc, value)
    return
  }
  const a = value[0] ?? 0
  const b = value[1] ?? 0
  const c = value[2] ?? 0
  const d = value[3] ?? 0
  switch (value.length) {
    case 1:
      gl.uniform1f(loc, a)
      return
    case 2:
      gl.uniform2f(loc, a, b)
      return
    case 3:
      gl.uniform3f(loc, a, b, c)
      return
    case 4:
      gl.uniform4f(loc, a, b, c, d)
      return
    default:
      gl.uniform1fv(loc, Array.from(value))
  }
}
