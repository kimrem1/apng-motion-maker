/**
 * 이펙트 셰이더의 정적 무결성.
 *
 * 실제 컴파일은 WebGL2 컨텍스트가 필요해 Node 에서는 못 한다(브라우저에서 확인했다).
 * 대신 컴파일을 깨뜨렸던 실제 원인 두 가지를 문자열 수준에서 막는다.
 * 둘 다 한 번 겪었고, 겪기 전에는 22종 중 4종이 조용히 죽어 있었다.
 */

import { describe, expect, it } from 'vitest'

import { EFFECT_DEFS, EFFECT_BY_ID, effectFragment, effectGlsl } from '@/effects/registry.ts'
import { EFFECT_GRADE_FS, EFFECT_WARP_FS, effectWarmupCombos } from '@/effects/passGraph.ts'
import { GLSL_COMMON } from '@/effects/glsl/common.ts'

/** GLSL ES 3.0 예약어 중 변수명으로 쓰기 쉬운 것들. */
const RESERVED = [
  'active', 'asm', 'attribute', 'cast', 'class', 'common', 'enum', 'extern',
  'external', 'filter', 'fixed', 'goto', 'half', 'inline', 'input', 'interface',
  'namespace', 'noinline', 'output', 'partition', 'public', 'resource', 'row_major',
  'sizeof', 'static', 'superp', 'template', 'this', 'typedef', 'union', 'unsigned',
  'using', 'varying', 'volatile',
]

/**
 * 주석을 걷어낸 소스.
 * "fract(sin(x)) 를 쓰지 마라" 라고 적은 주석까지 위반으로 잡히면 안 된다.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ')
}

function allShaderSources(): { name: string; src: string }[] {
  const out: { name: string; src: string }[] = [
    { name: 'GLSL_COMMON', src: GLSL_COMMON },
    { name: 'EFFECT_WARP_FS', src: EFFECT_WARP_FS },
    { name: 'EFFECT_GRADE_FS', src: EFFECT_GRADE_FS },
  ]
  for (const def of EFFECT_DEFS) {
    const frag = effectFragment(def)
    if (frag) out.push({ name: `${def.id}:fragment`, src: frag })
    const chunk = effectGlsl(def)
    if (chunk) out.push({ name: `${def.id}:chunk`, src: chunk })
  }
  return out
}

describe('GLSL 예약어', () => {
  it('예약어를 변수 이름으로 쓰지 않는다', () => {
    // 'active' 를 float 변수로 쓴 셰이더 하나가 통째로 컴파일 실패했었다.
    const offenders: string[] = []
    for (const { name, src: raw } of allShaderSources()) {
      const src = stripComments(raw)
      for (const word of RESERVED) {
        // "타입 예약어" 형태의 선언만 잡는다. 주석이나 다른 단어의 일부는 무시한다.
        const decl = new RegExp(`\\b(float|int|uint|bool|vec[234]|ivec[234]|uvec[234]|mat[234])\\s+${word}\\b`)
        if (decl.test(src)) offenders.push(`${name}: ${word}`)
      }
    }
    expect(offenders).toEqual([])
  })
})

describe('셰이더 난수', () => {
  it('fract(sin(...)) 을 쓰지 않는다', () => {
    // GPU 마다 결과가 달라 프리뷰와 내보내기가 갈린다.
    const offenders: string[] = []
    for (const { name, src } of allShaderSources()) {
      if (/fract\s*\(\s*sin\s*\(/.test(stripComments(src))) offenders.push(name)
    }
    expect(offenders).toEqual([])
  })

  it('정수 키 해시 오버로드가 있다', () => {
    // B 스테이지는 슬라이스 번호와 블록 id 로 해시한다. float 왕복은 큰 값에서
    // 정밀도가 떨어져 서로 다른 블록이 같은 난수를 받는다.
    expect(GLSL_COMMON).toMatch(/vec2\s+hash22\s*\(\s*uvec2/)
    expect(GLSL_COMMON).toMatch(/float\s+hash21\s*\(\s*uvec2/)
  })
})

describe('융합 셰이더 구조', () => {
  it('A 스테이지 조각의 진입점이 융합 셰이더에 들어 있다', () => {
    for (const def of EFFECT_DEFS) {
      if (def.stage !== 'A') continue
      if (!effectGlsl(def)) continue
      const fn = `warp_${def.id.replace(/\./g, '_')}`
      expect(EFFECT_WARP_FS, `${def.id} 진입점`).toContain(fn)
    }
  })

  it('C 스테이지 조각의 진입점이 융합 셰이더에 들어 있다', () => {
    for (const def of EFFECT_DEFS) {
      if (def.stage !== 'C') continue
      if (!effectGlsl(def)) continue
      const fn = `grade_${def.id.replace(/\./g, '_')}`
      expect(EFFECT_GRADE_FS, `${def.id} 진입점`).toContain(fn)
    }
  })

  it('공용 프리로그가 융합 셰이더마다 한 번씩만 들어간다', () => {
    // 두 번 들어가면 함수 재정의로 링크가 깨진다.
    const marker = 'uvec2 pcg2d('
    for (const src of [EFFECT_WARP_FS, EFFECT_GRADE_FS]) {
      const count = src.split(marker).length - 1
      expect(count).toBeLessThanOrEqual(1)
    }
  })

  it('워밍업 조합에 융합 셰이더 두 장과 B 스테이지 전부가 들어 있다', () => {
    const combos = effectWarmupCombos()
    const bCount = EFFECT_DEFS.filter((d) => d.stage === 'B' && effectFragment(d)).length
    expect(combos).toHaveLength(bCount + 2)
  })
})

describe('레지스트리 무결성', () => {
  it('id 가 중복되지 않는다', () => {
    expect(EFFECT_BY_ID.size).toBe(EFFECT_DEFS.length)
  })

  it('모든 이펙트가 셰이더를 가진다', () => {
    // 셰이더가 없으면 UI 에는 보이는데 적용해도 아무 일이 없다.
    const dead = EFFECT_DEFS.filter((d) =>
      d.stage === 'B' ? !effectFragment(d) : !effectGlsl(d),
    ).map((d) => d.id)
    expect(dead).toEqual([])
  })

  it('파라미터 key 가 이펙트 안에서 중복되지 않는다', () => {
    for (const def of EFFECT_DEFS) {
      const keys = (def.params ?? []).map((p) => p.key)
      expect(new Set(keys).size, `${def.id}`).toBe(keys.length)
    }
  })

  it('알파를 오염시키는 이펙트가 표시되어 있다', () => {
    // 투명 스티커가 주 용도라 이 플래그가 UI 경고 배지의 근거다.
    for (const def of EFFECT_DEFS) {
      expect(typeof def.preservesAlpha, `${def.id}`).toBe('boolean')
    }
    // 전부 true 면 플래그가 의미 없다는 뜻이다.
    expect(EFFECT_DEFS.some((d) => !d.preservesAlpha)).toBe(true)
  })
})
