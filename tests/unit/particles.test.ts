/**
 * 파티클 엔진 결정론 검증. 캔버스 없이 도는 부분만 다룬다.
 * PRNG 스트림, 입자 구성, 정수 주기 불변식, spec 정규화, 루프 길이 공식이다.
 */
import { describe, expect, it } from 'vitest'
import { mulberry32 } from '@/core/rng'
import { CFG, EFFECTS, PALETTES, defaultParticleSpec, normalizeParticleSpec } from '@/particles/config'
import { BASE_T, CYCLE_FIELDS, buildParticles, sizeRank } from '@/particles/engine'
import { particleLoops } from '@/particles/frames'

describe('mulberry32', () => {
  // 알고리즘 정의(a|=0; a=a+0x6D2B79F5|0; …)에서 손으로 계산해 박아 둔 기대값.
  // 값이 하나라도 어긋나면 저장된 문서의 모든 입자 배치가 달라진다.
  it('시드 1의 처음 세 값이 박아 둔 기대값과 같다', () => {
    const r = mulberry32(1)
    expect(r()).toBe(0.6270739405881613)
    expect(r()).toBe(0.002735721180215478)
    expect(r()).toBe(0.5274470399599522)
  })
  it('시드 0의 처음 세 값이 박아 둔 기대값과 같다', () => {
    const r = mulberry32(0)
    expect(r()).toBe(0.26642920868471265)
    expect(r()).toBe(0.0003297457005828619)
    expect(r()).toBe(0.2232720274478197)
  })
  it('snow 시드 해시(seed 7)의 스트림이 박아 둔 기대값과 같다', () => {
    const seed = ((7 * 2654435761) ^ ('snow'.length * 2246822519) ^ 0x9e3779b9) | 0
    const r = mulberry32(seed)
    expect(r()).toBe(0.05637933616526425)
    expect(r()).toBe(0.8176738382317126)
    expect(r()).toBe(0.7248167193029076)
  })
})

describe('sizeRank', () => {
  it('dist=0 이면 균등 난수 u1 그대로다', () => {
    expect(sizeRank(0.37, 0.9, 0)).toBe(0.37)
    expect(sizeRank(0.0, 0.5, 0.0009)).toBe(0)
  })
  it('결과는 항상 [0,1] 안이다', () => {
    const r = mulberry32(99)
    for (let i = 0; i < 2000; i++) {
      const v = sizeRank(r(), r(), r())
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThanOrEqual(1)
    }
  })
  it('dist 를 올릴수록 평균 크기 순위가 단조로 내려간다(작은 쪽 봉우리)', () => {
    const u1: number[] = []
    const u2: number[] = []
    const r = mulberry32(4242)
    for (let i = 0; i < 4000; i++) {
      u1.push(r())
      u2.push(r())
    }
    const mean = (dist: number): number => {
      let s = 0
      for (let i = 0; i < u1.length; i++) s += sizeRank(u1[i]!, u2[i]!, dist)
      return s / u1.length
    }
    // 극저 dist 에서는 max-of-two-Beta 의 평균이 0.5보다 살짝 높아(E[max]≈0.505)
    // 공식 자체가 미세한 +0.001 언덕을 갖는다. 작은 쪽 봉우리는 중간 이상에서 지배한다.
    const dists = [0, 0.5, 0.75, 1]
    const means = dists.map(mean)
    for (let i = 1; i < means.length; i++)
      expect(means[i]!).toBeLessThanOrEqual(means[i - 1]! + 1e-9)
    expect(means[3]!).toBeLessThan(0.35)
    // dist=0 은 균등분포 → 평균 0.5 근처
    expect(means[0]!).toBeGreaterThan(0.47)
    expect(means[0]!).toBeLessThan(0.53)
  })
})

describe('buildParticles', () => {
  it('같은 spec 이면 입자 배열이 깊은 동등이다', () => {
    for (const e of EFFECTS) {
      const spec = defaultParticleSpec(e)
      expect(buildParticles(spec)).toEqual(buildParticles(spec))
    }
  })
  it('시드가 다르면 배열이 달라진다', () => {
    const a = defaultParticleSpec('snow')
    const b = { ...a, seed: 8 }
    expect(JSON.stringify(buildParticles(a))).not.toBe(JSON.stringify(buildParticles(b)))
  })
  it('count 만큼 만든다', () => {
    for (const e of EFFECTS) {
      const spec = defaultParticleSpec(e)
      expect(buildParticles(spec)).toHaveLength(spec.count)
    }
  })
  it('모든 효과의 주기 필드가 정수다(이음매 없는 루프의 전제)', () => {
    for (const e of EFFECTS) {
      const spec = { ...defaultParticleSpec(e), seed: 123 }
      const parts = buildParticles(spec)
      expect(parts.length).toBeGreaterThan(0)
      for (const p of parts) {
        const rec = p as unknown as Record<string, number>
        for (const f of CYCLE_FIELDS[e]) {
          expect(
            Number.isInteger(rec[f]),
            `${e}.${f} = ${rec[f]} 는 정수가 아니다`,
          ).toBe(true)
        }
      }
    }
  })
  it('bv(흐림 제비뽑기)는 BL 단계로 양자화된다', () => {
    const parts = buildParticles(defaultParticleSpec('snow'))
    const allowed = new Set([0, 0.25, 0.5, 0.75, 1])
    for (const p of parts) expect(allowed.has(p.bv)).toBe(true)
  })
})

describe('normalizeParticleSpec', () => {
  it('쓰레기 입력에도 던지지 않고 snow 기본값으로 돌아온다', () => {
    for (const garbage of [null, undefined, 42, 'x', [], { effect: 'zzz' }]) {
      const s = normalizeParticleSpec(garbage)
      expect(s.effect).toBe('snow')
      expect(s.count).toBe(CFG.snow.def.count)
      expect(s.blend).toBe('normal')
    }
  })
  it('범위를 벗어난 값을 슬라이더 한계로 클램프한다', () => {
    const s = normalizeParticleSpec({
      effect: 'snow',
      sizeMin: -5,
      sizeMax: 99,
      speed: 1e9,
      count: 999999,
      angle: 999,
      opacityMul: -1,
      tilt: 0,
      seed: 7,
    })
    expect(s.sizeMin).toBe(0.03)
    expect(s.sizeMax).toBe(3)
    expect(s.speed).toBe(3)
    expect(s.count).toBe(6000)
    expect(s.angle).toBe(80)
    expect(s.opacityMul).toBe(0.05)
    expect(s.tilt).toBe(0.05)
  })
  it('sizeMax 는 sizeMin 아래로 내려가지 않는다', () => {
    const s = normalizeParticleSpec({ effect: 'snow', sizeMin: 2, sizeMax: 1 })
    expect(s.sizeMax).toBe(2)
  })
  it('효과별 count/ex1 범위를 따른다', () => {
    expect(normalizeParticleSpec({ effect: 'flare', count: 999 }).count).toBe(60)
    expect(normalizeParticleSpec({ effect: 'caustic', count: 1 }).count).toBe(2)
    expect(normalizeParticleSpec({ effect: 'rain', ex1: 5 }).ex1).toBe(0.2)
  })
  it('지원하지 않는 view/shape/blend 는 기본으로 돌린다', () => {
    const s = normalizeParticleSpec({ effect: 'dust', view: 'toward', shape: 'hex', blend: 'multiply' })
    expect(s.view).toBe('flat')
    expect(s.blend).toBe('normal')
    const s2 = normalizeParticleSpec({ effect: 'snow', shape: 'star' })
    expect(s2.shape).toBe('round')
  })
  it('문자열 타입 파라미터에 숫자가 와도 살아남는다', () => {
    const s = normalizeParticleSpec({ effect: 'snow', shape: 123, view: 9, blend: 0, customPal: 'nope' })
    expect(s.shape).toBe('round')
    expect(s.view).toBe('flat')
    expect(s.customPal).toEqual(PALETTES['무지개'])
  })
})

describe('defaultParticleSpec', () => {
  it('12개 효과 전부 CFG 기본값과 일치한다', () => {
    for (const e of EFFECTS) {
      const s = defaultParticleSpec(e)
      const rec = s as unknown as Record<string, unknown>
      for (const [k, v] of Object.entries(CFG[e].def)) expect(rec[k], `${e}.${k}`).toBe(v)
      expect(s.effect).toBe(e)
      expect(s.seed).toBe(7)
      expect(s.colorMode).toBe('single')
      expect(s.single).toBe(CFG[e].color)
      // 정규화를 통과해도 그대로여야 기본값이 곧 합법 범위라는 뜻이다
      expect(normalizeParticleSpec(s)).toEqual(s)
    }
  })
})

describe('루프 길이', () => {
  it('기본 루프는 BASE_T/speed 초이고 문서 길이에 정수 반복으로 맞는다', () => {
    expect(BASE_T).toBe(3)
    // 문서 길이가 자연 루프 길이의 배수면 루프 수가 그 배수 그대로 나온다.
    expect(particleLoops({ speed: 1 }, 120, 20)).toBe(2)
    expect(particleLoops({ speed: 3 }, 40, 20)).toBe(2)
  })
})
