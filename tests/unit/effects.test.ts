/**
 * 이펙트 엔진 검사.
 *
 * 이펙트는 프리셋과 같은 종류의 위험을 갖는다. 카탈로그의 한 항목이 조용히 깨져도
 * 사용자가 그걸 고르기 전까지 아무도 모른다. 게다가 이펙트는 픽셀을 직접 만들기
 * 때문에 결정론이 깨지면 "프리뷰 = 결과물" 이라는 약속이 곧바로 무너진다.
 *
 * 네 가지를 감시한다.
 *   1. 레지스트리 무결성 (id / define / entry 중복, 기본값 범위)
 *   2. Track 파라미터가 프레임별로 평가되는가
 *   3. range / enabled 가 활성 판정에 반영되는가
 *   4. uniforms() 가 결정론적인가, 그리고 셰이더에 금지된 난수가 없는가
 */

import { describe, expect, it } from 'vitest'

import type { EffectInstance, Track } from '@/core/types.ts'
import {
  EFFECT_BY_ID,
  EFFECT_CATEGORY_LABELS,
  EFFECT_CATEGORY_ORDER,
  EFFECT_DEFS,
  activeEffects,
  byEffectCategory,
  byStage,
  createEffectInstance,
  defaultNumber,
  effectCategory,
  effectDefine,
  effectEntry,
  effectFragment,
  effectGlsl,
  evalEffectUniforms,
  frameSeed,
  loopPhase,
  resolveEffectParams,
  seedFloat,
} from '@/effects/registry.ts'
import {
  EFFECT_GRADE_FS,
  EFFECT_WARP_FS,
  effectWarmupCombos,
  hasActiveEffects,
} from '@/effects/passGraph.ts'
import { EFFECT_FS_PRELUDE, GLSL_COMMON } from '@/effects/glsl/common.ts'
import { buildNoiseAtlasData } from '@/effects/noiseAtlas.ts'
import type { EffectDef, EffectEvalContext, UniformValue } from '@/effects/types.ts'

// ---------------------------------------------------------------------------
// 공통 헬퍼
// ---------------------------------------------------------------------------

function instanceOf(def: EffectDef, overrides: Partial<EffectInstance> = {}): EffectInstance {
  const base = createEffectInstance(def.id, `fx-${def.id}`, 7)
  expect(base).not.toBeNull()
  return { ...(base as EffectInstance), ...overrides }
}

function contextFor(def: EffectDef, frame = 3): EffectEvalContext {
  const instance = instanceOf(def)
  return {
    frame,
    effFrame: frame,
    durationFrames: 24,
    fps: 25,
    width: 512,
    height: 384,
    seed: 0x12345678,
    seedStatic: 0x0bad5eed,
    instanceSeed: 7,
    projectSeed: 4242,
    nodeId: `layer1:fx-${def.id}`,
    holdFrames: 1,
    pass: 0,
    passCount: 1,
    params: resolveEffectParams(def, instance, frame),
  }
}

/** 유니폼 목록을 이름 -> 값 레코드로 되돌린다. 함수형/선언형을 가리지 않는다. */
function uniformsOf(def: EffectDef, ctx: EffectEvalContext): Record<string, UniformValue> {
  const out: Record<string, UniformValue> = {}
  for (const u of evalEffectUniforms(def, ctx)) out[u.name] = u.value
  return out
}

/** GLSL 주석을 지운다. 규칙을 설명하는 주석이 규칙 위반으로 잡히지 않게 한다. */
function stripGlslComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ')
}

/** 셰이더 문자열 전부. 검사할 때마다 빠뜨리지 않도록 한 곳에서 모은다. */
function allShaderSources(): { name: string; source: string }[] {
  const out: { name: string; source: string }[] = [
    { name: 'GLSL_COMMON', source: GLSL_COMMON },
    { name: 'EFFECT_FS_PRELUDE', source: EFFECT_FS_PRELUDE },
    { name: 'EFFECT_WARP_FS', source: EFFECT_WARP_FS },
    { name: 'EFFECT_GRADE_FS', source: EFFECT_GRADE_FS },
  ]
  for (const def of EFFECT_DEFS) {
    const glsl = effectGlsl(def)
    if (glsl) out.push({ name: `${def.id}.glsl`, source: glsl })
    const fragment = effectFragment(def)
    if (fragment) out.push({ name: `${def.id}.fs`, source: fragment })
  }
  return out
}

// ---------------------------------------------------------------------------
// 1. 레지스트리 무결성
// ---------------------------------------------------------------------------

describe('이펙트 레지스트리', () => {
  it('카탈로그가 비어 있지 않다', () => {
    expect(EFFECT_DEFS.length).toBeGreaterThan(0)
    expect(EFFECT_BY_ID.size).toBe(EFFECT_DEFS.length)
  })

  it('id 가 중복되지 않는다', () => {
    const ids = EFFECT_DEFS.map((d) => d.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('define 이 중복되지 않는다', () => {
    const defines = EFFECT_DEFS.map((d) => effectDefine(d))
    expect(new Set(defines).size).toBe(defines.length)
    for (const d of defines) expect(d).toMatch(/^FX_[A-Z0-9_]+$/)
  })

  it('융합 스테이지의 진입 함수 이름이 중복되지 않는다', () => {
    // A 와 C 는 각각 한 장의 셰이더로 합쳐진다. 이름이 겹치면 링크가 깨진다.
    for (const stage of ['A', 'C'] as const) {
      const entries = byStage(stage).map((d) => effectEntry(d))
      expect(new Set(entries).size).toBe(entries.length)
    }
  })

  it('스테이지별 필수 필드가 채워져 있다', () => {
    for (const def of EFFECT_DEFS) {
      if (def.stage === 'B') {
        expect(effectFragment(def), def.id).toBeTruthy()
      } else {
        expect(effectGlsl(def), def.id).toBeTruthy()
        // 진입 함수가 조각 안에 실제로 정의되어 있어야 한다.
        expect(effectGlsl(def) ?? '', def.id).toContain(`${effectEntry(def)}(`)
      }
    }
  })

  it('라벨과 힌트가 한국어로 채워져 있다', () => {
    for (const def of EFFECT_DEFS) {
      expect(def.label.length, def.id).toBeGreaterThan(0)
      expect(def.hint.length, def.id).toBeGreaterThan(0)
      // 내부 id 가 그대로 노출되면 안 된다.
      expect(def.label).not.toContain(def.id)
    }
  })

  it('파라미터 기본값이 스펙 범위 안이다', () => {
    for (const def of EFFECT_DEFS) {
      const keys = def.params.map((p) => p.key)
      expect(new Set(keys).size, def.id).toBe(keys.length)

      for (const spec of def.params) {
        const d = spec.default
        expect(typeof d, `${def.id}.${spec.key}`).toBe('number')
        const value = defaultNumber(spec)

        if (spec.type === 'number') {
          if (spec.min !== undefined) expect(value, `${def.id}.${spec.key}`).toBeGreaterThanOrEqual(spec.min)
          if (spec.max !== undefined) expect(value, `${def.id}.${spec.key}`).toBeLessThanOrEqual(spec.max)
        } else if (spec.type === 'select') {
          const values = (spec.options ?? []).map((o) => String(o.value))
          expect(values.length, `${def.id}.${spec.key}`).toBeGreaterThan(0)
          expect(values, `${def.id}.${spec.key}`).toContain(String(value))
        } else if (spec.type === 'boolean') {
          expect([0, 1], `${def.id}.${spec.key}`).toContain(value)
        } else {
          // color 는 0xRRGGBB 정수 하나다. 범위 검사를 하지 않는다.
          expect(Number.isFinite(value), `${def.id}.${spec.key}`).toBe(true)
        }
      }
    }
  })

  it('카테고리가 모두 라벨을 갖는다', () => {
    for (const def of EFFECT_DEFS) {
      expect(EFFECT_CATEGORY_LABELS[effectCategory(def)], def.id).toBeTruthy()
      expect(EFFECT_CATEGORY_ORDER).toContain(effectCategory(def))
    }
    for (const category of EFFECT_CATEGORY_ORDER) {
      expect(byEffectCategory(category).length, category).toBeGreaterThan(0)
    }
  })

  it('byStage 가 정의 순서를 유지한다', () => {
    const all = [...byStage('A'), ...byStage('B'), ...byStage('C')]
    expect(all.length).toBe(EFFECT_DEFS.length)
    for (const stage of ['A', 'B', 'C'] as const) {
      const list = byStage(stage)
      const indices = list.map((d) => EFFECT_DEFS.indexOf(d))
      expect(indices).toEqual([...indices].sort((a, b) => a - b))
    }
  })

  it('createEffectInstance 가 기본값을 채운다', () => {
    for (const def of EFFECT_DEFS) {
      const instance = createEffectInstance(def.id, 'x')
      expect(instance, def.id).not.toBeNull()
      const params = (instance as EffectInstance).params
      for (const spec of def.params) expect(params[spec.key], `${def.id}.${spec.key}`).toBe(defaultNumber(spec))
    }
    expect(createEffectInstance('없는이펙트', 'x')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 2. 파라미터 해석
// ---------------------------------------------------------------------------

describe('resolveEffectParams', () => {
  const boil = EFFECT_BY_ID.get('boil.warp') as EffectDef

  function ampTrack(keys: [number, number][]): Track {
    return {
      id: 'amp',
      prop: 'scale',
      unit: 'ratio',
      keys: keys.map(([f, v]) => ({ f, v, interp: 'linear' as const })),
    }
  }

  it('Track 파라미터를 프레임별로 평가한다', () => {
    const instance = instanceOf(boil, { params: { amp: ampTrack([[0, 0], [10, 8]]) } })
    expect(resolveEffectParams(boil, instance, 0).amp).toBeCloseTo(0, 6)
    expect(resolveEffectParams(boil, instance, 5).amp).toBeCloseTo(4, 6)
    expect(resolveEffectParams(boil, instance, 10).amp).toBeCloseTo(8, 6)
  })

  it('Track 값이 스펙 범위를 넘으면 잘라낸다', () => {
    const instance = instanceOf(boil, { params: { amp: ampTrack([[0, -50], [10, 500]]) } })
    expect(resolveEffectParams(boil, instance, 0).amp).toBe(0)
    expect(resolveEffectParams(boil, instance, 10).amp).toBe(8)
  })

  it('값이 없거나 망가졌으면 기본값을 쓴다', () => {
    const instance = instanceOf(boil, { params: {} })
    const resolved = resolveEffectParams(boil, instance, 0)
    for (const spec of boil.params) expect(resolved[spec.key]).toBe(defaultNumber(spec))
  })

  it('select 는 가장 가까운 옵션으로 스냅한다', () => {
    const slice = EFFECT_BY_ID.get('glitch.slice') as EffectDef
    const instance = instanceOf(slice, { params: { fill: 2.4 } })
    expect(resolveEffectParams(slice, instance, 0).fill).toBe(2)
    const wild = instanceOf(slice, { params: { fill: 99 } })
    expect(resolveEffectParams(slice, instance, 0).fill).toBe(2)
    expect(resolveEffectParams(slice, wild, 0).fill).toBe(3)
  })

  it('스펙에 없는 키는 결과에 들어가지 않는다', () => {
    const instance = instanceOf(boil, { params: { amp: 1, 없는키: 9 } })
    const resolved = resolveEffectParams(boil, instance, 0)
    expect(Object.keys(resolved).sort()).toEqual(boil.params.map((p) => p.key).sort())
  })
})

// ---------------------------------------------------------------------------
// 3. 활성 판정
// ---------------------------------------------------------------------------

describe('hasActiveEffects', () => {
  const def = EFFECT_DEFS[0] as EffectDef

  it('빈 목록은 false 다', () => {
    expect(hasActiveEffects([], 0)).toBe(false)
  })

  it('enabled=false 는 건너뛴다', () => {
    const off = instanceOf(def, { enabled: false })
    expect(hasActiveEffects([off], 0)).toBe(false)
    expect(hasActiveEffects([instanceOf(def)], 0)).toBe(true)
  })

  it('range 밖의 프레임에서는 꺼진다', () => {
    const ranged = instanceOf(def, { range: [5, 10] })
    expect(hasActiveEffects([ranged], 4)).toBe(false)
    expect(hasActiveEffects([ranged], 5)).toBe(true)
    expect(hasActiveEffects([ranged], 10)).toBe(true)
    expect(hasActiveEffects([ranged], 11)).toBe(false)
  })

  it('뒤집힌 range 도 받아 준다', () => {
    const flipped = instanceOf(def, { range: [10, 5] })
    expect(hasActiveEffects([flipped], 7)).toBe(true)
    expect(hasActiveEffects([flipped], 11)).toBe(false)
  })

  it('등록되지 않은 type 은 무시한다', () => {
    const unknown = instanceOf(def, { type: '없는이펙트' })
    expect(hasActiveEffects([unknown], 0)).toBe(false)
  })

  it('activeEffects 가 순서를 유지한다', () => {
    const a = instanceOf(EFFECT_DEFS[0] as EffectDef, { id: 'a' })
    const b = instanceOf(EFFECT_DEFS[1] as EffectDef, { id: 'b', enabled: false })
    const c = instanceOf(EFFECT_DEFS[2] as EffectDef, { id: 'c' })
    expect(activeEffects([a, b, c], 0).map((e) => e.id)).toEqual(['a', 'c'])
  })
})

// ---------------------------------------------------------------------------
// 4. 결정론
// ---------------------------------------------------------------------------

describe('결정론', () => {
  it('uniforms() 가 같은 ctx 에 같은 값을 낸다', () => {
    for (const def of EFFECT_DEFS) {
      const ctx = contextFor(def, 7)
      const a = uniformsOf(def, ctx)
      const b = uniformsOf(def, { ...ctx, params: { ...ctx.params } })
      expect(a, def.id).toEqual(b)
    }
  })

  it('uniforms() 결과에 NaN 이 없고 이름이 u_ 로 시작한다', () => {
    for (const def of EFFECT_DEFS) {
      for (const frame of [0, 1, 7, 23]) {
        const values = uniformsOf(def, contextFor(def, frame))
        for (const [name, value] of Object.entries(values)) {
          expect(name, `${def.id}.${name}`).toMatch(/^u_[A-Za-z0-9_]+$/)
          const list: readonly number[] = typeof value === 'number' ? [value] : value
          for (const n of list) expect(Number.isFinite(n), `${def.id}.${name}`).toBe(true)
        }
      }
    }
  })

  it('프레임이 다르면 절차형 이펙트의 유니폼도 달라진다', () => {
    const shake = EFFECT_BY_ID.get('shake.transform') as EffectDef
    const at = (frame: number) =>
      uniformsOf(shake, { ...contextFor(shake, frame), effFrame: frame })
    expect(at(0)).not.toEqual(at(6))
  })

  it('loopPhase 가 한 바퀴를 정확히 닫는다', () => {
    const base = contextFor(EFFECT_DEFS[0] as EffectDef, 0)
    const start = loopPhase({ ...base, effFrame: 0 })
    const wrapped = loopPhase({ ...base, effFrame: base.durationFrames })
    expect(start).toBe(0)
    expect(wrapped).toBe(start)
  })

  it('frameSeed / seedFloat 가 결정론적이고 셰이더가 다룰 수 있는 범위다', () => {
    const ctx = contextFor(EFFECT_DEFS[0] as EffectDef, 3)
    expect(frameSeed(ctx)).toBe(frameSeed(ctx))
    for (let f = 0; f < 32; f += 1) {
      const s = seedFloat(frameSeed({ ...ctx, effFrame: f }))
      expect(Number.isInteger(s)).toBe(true)
      expect(s).toBeGreaterThanOrEqual(0)
      // 24비트를 넘으면 float 유니폼에서 반올림이 생겨 GPU 마다 결과가 갈린다.
      expect(s).toBeLessThan(16777216)
    }
  })

  it('warp.displace 의 팬이 어느 방향에서도 루프를 닫는다', () => {
    /*
     * 노이즈는 x 와 y **각각** period 셀마다 반복한다(mmWrapCell). 그러니 한 주기 끝의
     * 이동량은 두 성분이 모두 period 의 정수배여야 필드가 제자리로 온다.
     *
     * 스칼라 이동량에 cos/sin 을 곱하면 0도와 90도에서만 우연히 맞는다. 45도에서는
     * 0.707 배가 되어 축별 사이클 수가 정수가 아니다. 루프 끝에서 무늬가 어긋난 채
     * 첫 프레임으로 돌아가는데, 왜곡 필드라 눈으로는 "원래 그런 효과" 처럼 보인다.
     * 그래서 수치로 잡는다.
     */
    const def = EFFECT_BY_ID.get('warp.displace') as EffectDef
    const base = contextFor(def, 0)
    const total = base.durationFrames

    // 이동량은 t 에 선형이고 t 는 마지막 프레임 다음에 0 으로 감긴다. 그래서 한 주기
    // 전체 이동량은 "한 프레임 이동량 x 프레임 수" 다. 그 값을 period 로 재면 된다.
    const panAt = (frame: number, params: Record<string, number>): readonly number[] =>
      uniformsOf(def, {
        ...base,
        // 이 이펙트의 loopPhase 는 ctx.frame 을 홀드 클럭에 물려 쓴다. 둘 다 맞춘다.
        frame,
        effFrame: frame,
        params: { ...base.params, ...params },
      })['u_warp_displace_pan'] as readonly number[]

    for (const period of [2, 8, 32]) {
      for (const panSpeed of [-3, -1, 1, 2, 3]) {
        for (const panAngle of [0, 15, 30, 45, 60, 90, 137, 180, 271, 359]) {
          const params = { period, panSpeed, panAngle }
          const p0 = panAt(0, params)
          const p1 = panAt(1, params)
          const label = `period=${period} speed=${panSpeed} angle=${panAngle}`

          let moved = 0
          for (let axis = 0; axis < 2; axis += 1) {
            const perLoop = ((p1[axis] ?? 0) - (p0[axis] ?? 0)) * total
            const cycles = perLoop / period
            expect(cycles, `${label} 축${axis} 사이클 수`).toBeCloseTo(Math.round(cycles), 9)
            moved += Math.abs(perLoop)
          }
          // 팬을 켰는데 두 축이 모두 0 이면 그 노브가 죽는다.
          expect(moved, label).toBeGreaterThan(0)
        }
      }
    }
  })

  it('warp.displace 의 팬을 끄면 움직이지 않는다', () => {
    const def = EFFECT_BY_ID.get('warp.displace') as EffectDef
    const base = contextFor(def, 5)
    const ctx: EffectEvalContext = {
      ...base,
      params: { ...base.params, panSpeed: 0, panAngle: 45 },
    }
    expect(uniformsOf(def, ctx)['u_warp_displace_pan']).toEqual([0, 0])
  })
})

// ---------------------------------------------------------------------------
// 5. 셰이더 문자열
// ---------------------------------------------------------------------------

describe('셰이더 문자열', () => {
  it('삼각함수 소수부 해시를 쓰지 않는다', () => {
    // GPU 마다 결과가 달라지는 관용구다. PCG 정수 해시만 허용한다.
    // 금지 규칙을 적어 둔 주석까지 걸리면 안 되므로 코드만 남기고 검사한다.
    for (const { name, source } of allShaderSources()) {
      const code = stripGlslComments(source)
      expect(code.includes('fract(sin'), name).toBe(false)
      expect(code.includes('fract( sin'), name).toBe(false)
      expect(code.includes('fract(cos'), name).toBe(false)
    }
  })

  it('정수 정밀도를 highp 로 못박는다', () => {
    // 프래그먼트 기본 int 정밀도는 mediump 이고 16비트만 보장한다.
    // 32비트 PCG 해시가 잘리면 결과가 완전히 달라진다.
    expect(EFFECT_FS_PRELUDE).toContain('precision highp int;')
    expect(EFFECT_WARP_FS).toContain('precision highp int;')
    expect(EFFECT_GRADE_FS).toContain('precision highp int;')
    for (const def of EFFECT_DEFS) {
      const fs = effectFragment(def)
      if (fs) expect(fs, def.id).toContain('precision highp int;')
    }
  })

  it('버전 선언이 첫 줄이다', () => {
    for (const { name, source } of allShaderSources()) {
      if (!source.includes('#version')) continue
      expect(source.startsWith('#version 300 es'), name).toBe(true)
    }
  })

  it('융합 셰이더가 모든 조각을 #ifdef 로 감싼다', () => {
    for (const def of byStage('A')) {
      expect(EFFECT_WARP_FS).toContain(`#ifdef ${effectDefine(def)}`)
      expect(EFFECT_WARP_FS).toContain(`uv += ${effectEntry(def)}(uv, u_texel);`)
    }
    for (const def of byStage('C')) {
      expect(EFFECT_GRADE_FS).toContain(`#ifdef ${effectDefine(def)}`)
      expect(EFFECT_GRADE_FS).toContain(`c = ${effectEntry(def)}(c, v_uv);`)
    }
    // B 스테이지는 개별 패스라 융합 셰이더에 들어가면 안 된다.
    for (const def of byStage('B')) {
      expect(EFFECT_WARP_FS).not.toContain(effectDefine(def))
      expect(EFFECT_GRADE_FS).not.toContain(effectDefine(def))
    }
  })

  it('#ifdef 와 #endif 개수가 맞는다', () => {
    for (const source of [EFFECT_WARP_FS, EFFECT_GRADE_FS]) {
      const ifs = source.match(/#ifdef /g)?.length ?? 0
      const ends = source.match(/#endif/g)?.length ?? 0
      expect(ifs).toBe(ends)
    }
  })

  it('워밍업 조합이 모든 셰이더를 덮는다', () => {
    const combos = effectWarmupCombos()
    const sources = new Set(combos.map((c) => c.fs))
    expect(sources.has(EFFECT_WARP_FS)).toBe(true)
    expect(sources.has(EFFECT_GRADE_FS)).toBe(true)
    for (const def of byStage('B')) {
      expect(sources.has(effectFragment(def) ?? '')).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// 6. 노이즈 아틀라스
// ---------------------------------------------------------------------------

describe('노이즈 아틀라스', () => {
  it('같은 시드면 바이트까지 같다', () => {
    const a = buildNoiseAtlasData(32, 4, 12345)
    const b = buildNoiseAtlasData(32, 4, 12345)
    expect(a.length).toBe(32 * 32 * 4 * 4)
    expect(Array.from(a)).toEqual(Array.from(b))
  })

  it('시드가 다르면 내용이 다르다', () => {
    const a = buildNoiseAtlasData(32, 4, 1)
    const b = buildNoiseAtlasData(32, 4, 2)
    expect(Array.from(a)).not.toEqual(Array.from(b))
  })

  it('알파는 항상 255 이고 값이 한쪽으로 몰리지 않는다', () => {
    const data = buildNoiseAtlasData(32, 4, 99)
    let sum = 0
    let count = 0
    for (let i = 0; i < data.length; i += 4) {
      expect(data[i + 3]).toBe(255)
      sum += data[i] ?? 0
      count += 1
    }
    // 0 중심 노이즈를 0.5 기준으로 인코딩했으므로 평균이 128 근처여야 한다.
    expect(Math.abs(sum / count - 128)).toBeLessThan(24)
  })

  it('공간축이 백색잡음이 아니다', () => {
    // 이웃 텍셀 차이가 무작위 쌍의 차이보다 뚜렷하게 작아야 워프에 쓸 수 있다.
    const size = 64
    const data = buildNoiseAtlasData(size, 2, 7)
    let neighbour = 0
    let random = 0
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size - 1; x += 1) {
        const i = (y * size + x) * 4
        neighbour += Math.abs((data[i] ?? 0) - (data[i + 4] ?? 0))
        const j = (y * size + ((x * 37 + 11) % size)) * 4
        random += Math.abs((data[i] ?? 0) - (data[j] ?? 0))
      }
    }
    expect(neighbour).toBeLessThan(random * 0.5)
  })
})
