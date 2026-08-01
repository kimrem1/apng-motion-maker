/**
 * 모션 프리셋 카탈로그 F~I.
 *
 * A~E 와 감시 대상이 다르다. 이쪽은 트랙이 아니라 **모디파이어와 홀드 클럭**이 본체다.
 * 눈으로 확인하기 가장 어려운 종류의 버그가 셋 있고, 셋 다 조용히 깨진다.
 *
 *   1. 이음새. 흔들림은 한 바퀴 돌아 제자리로 와야 한다. sine 주기가 정수가 아니거나
 *      포락선이 닫히지 않으면 매 반복마다 툭 끊긴다. 재생을 오래 봐야 알아챈다.
 *   2. 홀드 배수. totalFrames % holdFrames != 0 이면 마지막 홀드 블록만 짧게 잘린다.
 *      한 프레임짜리 결함이라 스크럽으로는 절대 안 보인다.
 *   3. 용량. 지지직의 기본 fps 와 홀드가 되돌아가면 파일이 세 배가 된다.
 *      그림은 똑같아서 아무도 눈치채지 못한다.
 *
 * 넷째가 있다.
 *   4. **이펙트 배선.** 프리셋이 낸 이펙트 id 나 파라미터 key 에 오타가 하나 있으면
 *      레지스트리가 조용히 무시한다. 예외도 경고도 없이 "적용했는데 아무 일도 안
 *      일어남" 이 된다. 그래서 이 파일이 레지스트리와 직접 대조한다.
 */

import { describe, expect, it } from 'vitest'

import { FRAMES_MAX, type EffectInstance, type Modifier } from '@/core/types.ts'
import { EFFECT_BY_ID } from '@/effects/registry.ts'
import { evalModifier } from '@/motions/generators.ts'
import {
  CATEGORY_LABELS,
  CATEGORY_ORDER,
  MOTION_PRESETS,
  MOTION_PRESET_BY_ID,
  applyPreset,
  byCategory,
  createEmitContext,
} from '@/motions/registry.ts'
import type { EmitContext, MotionCategory, MotionPreset, PresetEmission } from '@/motions/types.ts'
import { SHAKE_PRESETS, snapToHold } from '@/motions/presets/shake.ts'
import { BOIL_PRESETS } from '@/motions/presets/boil.ts'
import { GLITCH_FPS, GLITCH_HOLD, GLITCH_PRESETS, limitFlashCount } from '@/motions/presets/glitch.ts'
import { COMBO_PRESETS, comboPartIds } from '@/motions/presets/combo.ts'

// ---------------------------------------------------------------------------
// 공통
// ---------------------------------------------------------------------------

function emit(preset: MotionPreset, overrides: Partial<EmitContext> = {}): PresetEmission {
  return applyPreset(preset, createEmitContext(overrides))
}

/** 이번 마일스톤에서 새로 들어온 24종. */
const NEW_PRESETS: MotionPreset[] = [
  ...SHAKE_PRESETS,
  ...BOIL_PRESETS,
  ...GLITCH_PRESETS,
  ...COMBO_PRESETS,
]

/** 모디파이어 한 개를 한 주기 동안 프레임별로 평가한다. 시드는 무엇이든 성질이 같아야 한다. */
function series(m: Modifier, duration: number): number[] {
  const out: number[] = []
  for (let f = 0; f < duration; f += 1) {
    out.push(evalModifier(m, { frame: f, durationFrames: duration, projectSeed: 0x4d4d, nodeId: 'L' }))
  }
  return out
}

/** 프리셋 하나가 내는 이펙트 인스턴스. 안 내면 빈 배열이다. */
function effectsOf(preset: MotionPreset): EffectInstance[] {
  return emit(preset).effects ?? []
}

function maxStep(values: number[]): number {
  let out = 0
  for (let i = 1; i < values.length; i += 1) {
    out = Math.max(out, Math.abs((values[i] ?? 0) - (values[i - 1] ?? 0)))
  }
  return out
}

// ---------------------------------------------------------------------------
// 카탈로그 구성
// ---------------------------------------------------------------------------

describe('카탈로그 구성', () => {
  it('아홉 카테고리 76종이다', () => {
    expect(MOTION_PRESETS).toHaveLength(76)
    expect(byCategory('shake')).toHaveLength(6)
    expect(byCategory('boil')).toHaveLength(5)
    expect(byCategory('glitch')).toHaveLength(8)
    expect(byCategory('combo')).toHaveLength(4)
  })

  it('지지직 조합 2종은 만드는 방식이 조합이어도 카테고리는 표를 따른다', () => {
    // combo.popGlitchIn 은 등장, combo.slideFadeGlitch 는 사라짐에 속한다.
    expect(MOTION_PRESET_BY_ID.get('combo.popGlitchIn')?.category).toBe('appear')
    expect(MOTION_PRESET_BY_ID.get('combo.slideFadeGlitch')?.category).toBe('disappear')
    expect(byCategory('appear')).toHaveLength(12)
    expect(byCategory('disappear')).toHaveLength(9)
  })

  it('id 가 중복되지 않는다', () => {
    expect(MOTION_PRESET_BY_ID.size).toBe(MOTION_PRESETS.length)
  })

  it('새 카테고리 이름이 한국어 의도 표현이다', () => {
    expect(CATEGORY_LABELS.shake).toBe('흔들기')
    expect(CATEGORY_LABELS.boil).toBe('자글자글')
    expect(CATEGORY_LABELS.glitch).toBe('지지직')
    expect(CATEGORY_LABELS.combo).toBe('조합')
    for (const label of Object.values(CATEGORY_LABELS)) {
      expect(label).not.toMatch(/[a-zA-Z]/)
    }
  })

  it('탭 순서에 아홉 카테고리가 하나씩만 있다', () => {
    const all = Object.keys(CATEGORY_LABELS) as MotionCategory[]
    expect([...CATEGORY_ORDER].sort()).toEqual([...all].sort())
    expect(new Set(CATEGORY_ORDER).size).toBe(CATEGORY_ORDER.length)
  })

  it('내부 id 를 사용자에게 노출하지 않는다', () => {
    for (const preset of NEW_PRESETS) {
      expect(preset.label.length, preset.id).toBeGreaterThan(0)
      expect(preset.hint.length, preset.id).toBeGreaterThan(0)
      expect(preset.label, preset.id).not.toMatch(/[a-zA-Z.]/)
      expect(preset.hint, preset.id).not.toContain(preset.id)
      for (const spec of preset.params) {
        expect(spec.label, `${preset.id}.${spec.key}`).not.toMatch(/[a-zA-Z]/)
      }
      for (const notice of emit(preset).notices ?? []) {
        expect(notice.message, preset.id).not.toContain(preset.id)
        expect(notice.message.length).toBeGreaterThan(0)
      }
    }
  })

  it('EASY 기본 노출이 흔들기와 자글자글, 지지직에 하나씩 있다', () => {
    for (const category of ['shake', 'boil', 'glitch'] as const) {
      expect(byCategory(category).some((p) => p.easy), category).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// emit 유효성
// ---------------------------------------------------------------------------

describe('emit 유효성', () => {
  for (const preset of NEW_PRESETS) {
    it(`${preset.id} 는 쓸 수 있는 결과를 낸다`, () => {
      const e = emit(preset)

      expect(Number.isInteger(e.durationFrames)).toBe(true)
      expect(e.durationFrames).toBeGreaterThanOrEqual(2)
      expect(e.durationFrames).toBeLessThanOrEqual(FRAMES_MAX)

      /*
       * 셋 다 비어 있으면 안 된다.
       *
       * 지지직 대부분은 순수 픽셀 처리라 트랙도 모디파이어도 없다. 그래도 이펙트는
       * 낸다. 셋 다 0 이면 그 프리셋은 눌러도 화면이 그대로다. 안내 문구가 있어도
       * 아무 일도 안 하는 프리셋은 고장과 구별되지 않는다.
       */
      const parts = e.tracks.length + (e.modifiers?.length ?? 0) + (e.effects?.length ?? 0)
      expect(parts, `${preset.id} 는 적용해도 아무 일도 일어나지 않는다`).toBeGreaterThanOrEqual(1)

      for (const t of e.tracks) {
        expect(t.keys.length, `${t.prop} 트랙의 키가 부족하다`).toBeGreaterThanOrEqual(2)
        let prev = -1
        for (const k of t.keys) {
          expect(Number.isInteger(k.f), `${t.prop} 의 프레임이 정수가 아니다`).toBe(true)
          expect(k.f, `${t.prop} 의 프레임이 오름차순이 아니다`).toBeGreaterThan(prev)
          expect(k.f).toBeLessThanOrEqual(e.durationFrames)
          expect(Number.isFinite(k.v)).toBe(true)
          prev = k.f
        }
      }

      for (const m of e.modifiers ?? []) {
        expect(Number.isFinite(m.amplitude), `${m.id} 의 진폭`).toBe(true)
        expect(m.holdFrames, `${m.id} 의 홀드`).toBeGreaterThanOrEqual(1)
        expect(Number.isInteger(m.holdFrames)).toBe(true)
        expect(m.octaves).toBeGreaterThanOrEqual(1)
        expect(m.octaves).toBeLessThanOrEqual(4)
        expect(m.cycles).toBeGreaterThan(0)
      }
    })
  }

  it('emit 은 순수 함수다', () => {
    for (const preset of NEW_PRESETS) {
      expect(emit(preset, { seed: 7 }), preset.id).toEqual(emit(preset, { seed: 7 }))
    }
  })

  it('모디파이어 id 가 한 프리셋 안에서 유일하다', () => {
    // 겹치면 생성기가 같은 노이즈를 두 번 뽑는다. 세 축이 한 덩어리로 움직여 보인다.
    for (const preset of NEW_PRESETS) {
      const ids = (emit(preset).modifiers ?? []).map((m) => m.id)
      expect(new Set(ids).size, preset.id).toBe(ids.length)
    }
  })

  it('속도 슬라이더는 진폭이 아니라 지속 프레임에 작용한다', () => {
    for (const preset of NEW_PRESETS) {
      const slow = emit(preset, { speed: 0.5 })
      const fast = emit(preset, { speed: 2 })
      expect(fast.durationFrames, preset.id).toBeLessThan(slow.durationFrames)
    }
  })

  it('반복 모드 제안이 반복 안전성과 맞는다', () => {
    for (const preset of NEW_PRESETS) {
      // once 계열도 기본 제안은 반복이다 (loopFor 주석 참조). 스티커는 반복이 표준이다.
      const expected = preset.loopSafe === 'pingPongOnly' ? 'pingPong' : 'loop'
      expect(emit(preset).suggestedLoop, preset.id).toBe(expected)
    }
  })
})

// ---------------------------------------------------------------------------
// 이펙트 배선
// ---------------------------------------------------------------------------

describe('프리셋이 내는 이펙트', () => {
  it('지지직 8종과 자글자글 4종은 전부 실제로 무언가를 낸다', () => {
    // 실측으로 tracks=0 mods=0 fx=0 이 열한 종 나왔던 자리다. 다시 그렇게 되면
    // 카드는 멀쩡한데 눌러도 화면이 그대로다.
    for (const preset of [...GLITCH_PRESETS, ...BOIL_PRESETS]) {
      const e = emit(preset)
      const parts = e.tracks.length + (e.modifiers ?? []).length + (e.effects ?? []).length
      expect(parts, `${preset.id} 가 아무것도 내지 않는다`).toBeGreaterThanOrEqual(1)
    }
  })

  it('지지직 8종은 전부 이펙트를 낸다', () => {
    // 이 카테고리는 본질이 픽셀 처리다. 모디파이어만 내는 지지직은 반쪽이다.
    for (const preset of GLITCH_PRESETS) {
      expect(effectsOf(preset).length, `${preset.id} 에 이펙트가 없다`).toBeGreaterThanOrEqual(1)
    }
  })

  it('자글자글은 2컷 스텝만 이펙트가 없다', () => {
    // 2컷 스텝은 홀드 클럭만으로 완성이라 이펙트 스택을 정의하지 않는다.
    // 정의하지 않는다는 것은 빈 배열이 아니라 undefined 다. 빈 배열을 내면
    // 사용자가 직접 쌓아 둔 이펙트가 이 프리셋을 누를 때마다 날아간다.
    expect(emit(MOTION_PRESET_BY_ID.get('boil.step')!).effects).toBeUndefined()
    for (const id of ['boil.hand', 'boil.edge', 'boil.paper']) {
      expect(effectsOf(MOTION_PRESET_BY_ID.get(id)!).length, id).toBeGreaterThanOrEqual(1)
    }
  })

  it('흔들기는 이펙트를 내지 않는다', () => {
    // F 는 모디파이어로 이미 완성이다. 여기에 이펙트를 얹으면 같은 흔들림이
    // 두 겹으로 들어가고, 오버스캔 솔버는 그중 한 겹만 계산한다.
    for (const preset of SHAKE_PRESETS) {
      expect(emit(preset).effects, preset.id).toBeUndefined()
    }
  })

  it('emit 한 모든 이펙트 타입이 레지스트리에 있다', () => {
    // 타입 오타는 예외가 아니라 침묵이다. isEffectActiveAt 이 조용히 false 를 낸다.
    for (const preset of MOTION_PRESETS) {
      for (const e of effectsOf(preset)) {
        expect(EFFECT_BY_ID.has(e.type), `${preset.id} 가 모르는 이펙트 ${e.type} 를 낸다`).toBe(true)
      }
    }
  })

  it('emit 한 모든 파라미터 key 가 그 이펙트의 스펙에 있다', () => {
    /*
     * **이 검사가 이번 배선 작업의 핵심이다.**
     *
     * resolveEffectParams 는 EffectDef.params 를 순회하며 값을 읽는다. 스펙에 없는
     * key 는 읽히지 않으므로 오타 하나가 그대로 "적용했는데 아무 일도 안 일어남" 이
     * 된다. 셰이더까지 내려가서야 드러나는 종류의 버그라 여기서 잡아야 한다.
     */
    for (const preset of MOTION_PRESETS) {
      for (const e of effectsOf(preset)) {
        const def = EFFECT_BY_ID.get(e.type)
        expect(def, `${preset.id}: ${e.type}`).toBeDefined()
        const keys = new Set(def!.params.map((p) => p.key))
        for (const key of Object.keys(e.params)) {
          expect(keys.has(key), `${preset.id} 의 ${e.type} 에 없는 파라미터 ${key}`).toBe(true)
        }
        for (const [key, value] of Object.entries(e.params)) {
          /*
           * 값은 상수이거나 시간축 트랙이다 (EffectParam = number | Track).
           *
           * 프리셋이 트랙을 내는 경우는 하나뿐이다. 그 이펙트의 유니폼이 프레임에
           * 의존하지 않는데(glitch.rgbShift) 프리셋이 그 값을 움직여야 할 때다.
           * 그때 상수를 내면 전 프레임이 완전히 같은 정지 이미지가 된다.
           * 트랙이면 키가 오름차순이고 값이 유한해야 문서에 심을 수 있다.
           */
          if (typeof value === 'number') {
            expect(Number.isFinite(value), `${preset.id}/${e.type}.${key}`).toBe(true)
            continue
          }
          expect(Array.isArray(value.keys), `${preset.id}/${e.type}.${key}`).toBe(true)
          expect(value.keys.length).toBeGreaterThanOrEqual(2)
          let prev = -1
          for (const k of value.keys) {
            expect(Number.isInteger(k.f), `${preset.id}/${e.type}.${key} 의 프레임`).toBe(true)
            expect(k.f, `${preset.id}/${e.type}.${key} 가 오름차순이 아니다`).toBeGreaterThan(prev)
            expect(Number.isFinite(k.v)).toBe(true)
            prev = k.f
          }
        }
      }
    }
  })

  it('이펙트 인스턴스가 문서에 그대로 심을 수 있는 모양이다', () => {
    for (const preset of MOTION_PRESETS) {
      const effects = effectsOf(preset)
      const ids = effects.map((e) => e.id)
      // id 가 겹치면 문서에 심을 때 하나가 사라진다.
      expect(new Set(ids).size, `${preset.id} 에 같은 이펙트 id 가 두 개다`).toBe(ids.length)

      const duration = emit(preset).durationFrames
      for (const e of effects) {
        expect(e.id.length, preset.id).toBeGreaterThan(0)
        expect(e.enabled, `${preset.id}/${e.id}`).toBe(true)
        expect(Number.isInteger(e.holdFrames), `${preset.id}/${e.id} 의 홀드`).toBe(true)
        expect(e.holdFrames).toBeGreaterThanOrEqual(1)
        expect(Number.isInteger(e.seed), `${preset.id}/${e.id} 의 시드`).toBe(true)
        expect(e.seed).toBeGreaterThanOrEqual(0)
        if (e.range) {
          expect(Number.isInteger(e.range[0])).toBe(true)
          expect(Number.isInteger(e.range[1])).toBe(true)
          expect(e.range[0]).toBeGreaterThanOrEqual(0)
          expect(e.range[1]).toBeGreaterThanOrEqual(e.range[0])
          // 구간이 마지막 출력 프레임을 넘으면 그 이펙트는 영영 안 켜진다.
          expect(e.range[0], `${preset.id}/${e.id} 의 구간이 밖에 있다`).toBeLessThan(duration)
        }
      }
    }
  })

  it('같은 컨텍스트로 두 번 emit 하면 시드까지 같다', () => {
    // Math.random 을 쓰면 호버 미리보기와 확정 적용이 다른 그림을 낸다.
    for (const preset of MOTION_PRESETS) {
      const a = emit(preset, { seed: 12345 })
      const b = emit(preset, { seed: 12345 })
      expect(a.effects, preset.id).toEqual(b.effects)
      expect((a.effects ?? []).map((e) => e.seed), preset.id).toEqual(
        (b.effects ?? []).map((e) => e.seed),
      )
    }
  })

  it('시드가 다르면 이펙트 시드도 달라진다', () => {
    const preset = MOTION_PRESET_BY_ID.get('glitch.rgbShift')!
    const a = emit(preset, { seed: 1 }).effects ?? []
    const b = emit(preset, { seed: 2 }).effects ?? []
    expect(a).toHaveLength(b.length)
    expect(a.map((e) => e.seed)).not.toEqual(b.map((e) => e.seed))
  })

  it('한 프리셋 안에서 이펙트 시드가 서로 다르다', () => {
    // 같으면 슬라이스와 블록이 같은 자리에서 같이 튄다. 하나가 두 번 그려진 것처럼 보인다.
    for (const preset of MOTION_PRESETS) {
      const seeds = effectsOf(preset).map((e) => e.seed)
      expect(new Set(seeds).size, `${preset.id} 의 이펙트 시드가 겹친다`).toBe(seeds.length)
    }
  })

  it('지지직 이펙트의 홀드가 용량 통제 값이다', () => {
    // 주사선과 물결은 규칙적인 무늬라 홀드가 필요 없다. 나머지는 전부 홀드 노브를 따른다.
    const noiseless = new Set(['glitch.scanline', 'glitch.wave'])
    for (const preset of GLITCH_PRESETS) {
      const expected = noiseless.has(preset.id) ? 1 : GLITCH_HOLD
      for (const e of effectsOf(preset)) {
        expect(e.holdFrames, `${preset.id}/${e.id}`).toBe(expected)
      }
    }
  })

  it('자글자글은 이펙트와 모디파이어가 같은 홀드에 물린다', () => {
    // 그림은 3컷인데 결은 2컷으로 놀면 원인을 못 짚겠는 어색함만 남는다.
    for (const preset of BOIL_PRESETS) {
      const e = emit(preset)
      const holds = new Set<number>()
      for (const m of e.modifiers ?? []) holds.add(m.holdFrames)
      for (const fx of e.effects ?? []) {
        holds.add(fx.holdFrames)
        // 이펙트 자체의 hold 파라미터도 같은 값이어야 한다.
        const own = fx.params['hold']
        if (typeof own === 'number') holds.add(own)
      }
      expect(holds.size, `${preset.id} 의 홀드가 갈린다`).toBe(1)
    }
  })

  it('조합은 부품의 이펙트를 합친다', () => {
    // 지지직을 섞은 조합이 이펙트를 잃으면 이름만 지지직이고 화면은 멀쩡하다.
    for (const id of ['combo.punchRgb', 'combo.popGlitchIn', 'combo.slideFadeGlitch']) {
      expect(effectsOf(MOTION_PRESET_BY_ID.get(id)!).length, id).toBeGreaterThanOrEqual(1)
    }
    // 부품 중 아무도 이펙트를 정의하지 않으면 조합도 정의하지 않는다.
    // 여기서 빈 배열을 내면 사용자가 쌓아 둔 이펙트가 날아간다.
    expect(emit(MOTION_PRESET_BY_ID.get('combo.zoomShake')!).effects).toBeUndefined()
    expect(emit(MOTION_PRESET_BY_ID.get('combo.driftSway')!).effects).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// F. 흔들기
// ---------------------------------------------------------------------------

describe('F. 흔들기', () => {
  it('여섯 종 전부 있다', () => {
    expect(SHAKE_PRESETS.map((p) => p.id).sort()).toEqual(
      ['shake.breathe', 'shake.camera', 'shake.handheld', 'shake.impact', 'shake.jitter', 'shake.wobble'],
    )
  })

  for (const preset of SHAKE_PRESETS) {
    it(`${preset.id} 는 키프레임이 아니라 모디파이어를 낸다`, () => {
      const e = emit(preset)
      expect((e.modifiers ?? []).length, '모디파이어가 없다').toBeGreaterThanOrEqual(1)
      // 트랙을 내면 사용자가 잡아 둔 위치를 덮어쓴다.
      expect(e.tracks, '흔들기는 트랙을 내지 않는다').toHaveLength(0)
    })

    it(`${preset.id} 의 모든 모디파이어에 포락선이 붙어 있다`, () => {
      // 감쇠 없는 등진폭 흔들림은 즉시 싸구려로 보인다.
      for (const m of emit(preset).modifiers ?? []) {
        expect(m.envelope, `${m.id} 에 포락선이 없다`).toBeDefined()
        expect((m.envelope ?? []).length).toBeGreaterThanOrEqual(2)
      }
    })

    it(`${preset.id} 의 세기 슬라이더가 진폭을 바꾼다`, () => {
      const sum = (e: PresetEmission): number =>
        (e.modifiers ?? []).reduce((acc, m) => acc + Math.abs(m.amplitude), 0)
      expect(sum(emit(preset, { strength: 1 })), preset.id).toBeGreaterThan(sum(emit(preset, { strength: 0 })))
    })
  }

  for (const preset of SHAKE_PRESETS.filter((p) => p.loopSafe === 'seamless')) {
    it(`${preset.id} 의 포락선이 닫혀 있다`, () => {
      const e = emit(preset)
      for (const m of e.modifiers ?? []) {
        const env = m.envelope ?? []
        const first = env[0]
        const last = env[env.length - 1]
        expect(first, m.id).toBeDefined()
        expect(last, m.id).toBeDefined()
        // 시작과 끝 값이 다르면 매 반복 시작에서 진폭이 툭 살아난다.
        expect(last?.v).toBeCloseTo(first?.v ?? 0, 9)
        expect(last?.f).toBe(e.durationFrames)
      }
    })

    it(`${preset.id} 의 사인 주기가 정수다`, () => {
      for (const m of emit(preset).modifiers ?? []) {
        if (m.type !== 'sine') continue
        expect(Number.isInteger(m.cycles), `${m.id} 의 주기가 정수가 아니다`).toBe(true)
      }
    })

    it(`${preset.id} 는 한 바퀴를 돌아 제자리로 온다`, () => {
      const e = emit(preset)
      for (const m of e.modifiers ?? []) {
        const values = series(m, e.durationFrames)
        const inner = maxStep(values)
        const wrap = Math.abs((values[0] ?? 0) - (values[values.length - 1] ?? 0))
        // 마지막 프레임에서 첫 프레임으로 넘어가는 폭이 구간 안 최대 변화보다
        // 크게 튀면 그 지점이 눈에 보이는 이음새다.
        expect(wrap, `${m.id} 의 이음새가 벌어진다`).toBeLessThanOrEqual(inner * 2 + 1e-9)
      }
    })
  }

  it('쿵 충격만 1회 재생이고 그 포락선은 0 으로 떨어진다', () => {
    const once = SHAKE_PRESETS.filter((p) => p.loopSafe !== 'seamless')
    expect(once.map((p) => p.id)).toEqual(['shake.impact'])

    for (const m of emit(once[0]!).modifiers ?? []) {
      const env = m.envelope ?? []
      expect(env[0]?.v).toBeCloseTo(1, 9)
      expect(env[env.length - 1]?.v).toBeCloseTo(0, 9)
    }
  })

  it('카메라 흔들림의 기본 진폭은 6px 다', () => {
    const e = emit(MOTION_PRESET_BY_ID.get('shake.camera')!)
    const x = (e.modifiers ?? []).find((m) => m.target === 'translateX')
    expect(x?.amplitude).toBeCloseTo(6, 9)
    const r = (e.modifiers ?? []).find((m) => m.target === 'rotate')
    expect(r?.amplitude).toBeCloseTo(0.8, 9)
  })

  it('자글자글 떨림은 홀드 클럭에 물려 있다', () => {
    const preset = MOTION_PRESET_BY_ID.get('shake.jitter')!
    expect(preset.noiseHoldFrames).toBe(2)
    const e = emit(preset)
    for (const m of e.modifiers ?? []) expect(m.holdFrames).toBe(2)
    expect(e.durationFrames % 2).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// G. 자글자글
// ---------------------------------------------------------------------------

describe('G. 자글자글', () => {
  it('다섯 종 전부 있다', () => {
    expect(BOIL_PRESETS.map((p) => p.id).sort()).toEqual(
      ['boil.edge', 'boil.fine', 'boil.hand', 'boil.paper', 'boil.step'],
    )
  })

  it('잔결 자글자글은 손그림보다 무늬가 촘촘하고 진폭이 작다', () => {
    // 둘의 차이는 노이즈 스케일이다. scale 은 픽셀 좌표에 곱해지므로 값이 클수록
    // 무늬 주기가 짧다. 이 관계가 뒤집히면 두 프리셋이 구분되지 않는다.
    const warpOf = (id: string) => {
      const preset = MOTION_PRESET_BY_ID.get(id)!
      const fx = (emit(preset).effects ?? []).find((e) => e.type === 'boil.warp')
      return fx?.params as Record<string, number>
    }
    const hand = warpOf('boil.hand')
    const fine = warpOf('boil.fine')
    expect(fine.scale!).toBeGreaterThan(hand.scale! * 3)
    expect(fine.amp!).toBeLessThan(hand.amp!)
  })

  it('잔결 자글자글은 그림을 통째로 흔들지 않는다', () => {
    // 면이 끓는 것과 그림이 흔들리는 것은 다르다. 어파인이 크면 잔결이 묻힌다.
    const fine = emit(MOTION_PRESET_BY_ID.get('boil.fine')!)
    const hand = emit(MOTION_PRESET_BY_ID.get('boil.hand')!)
    const peak = (mods: typeof fine.modifiers) =>
      Math.max(0, ...(mods ?? []).map((m) => Math.abs(m.amplitude)))
    expect(peak(fine.modifiers)).toBeLessThan(peak(hand.modifiers) / 3)
    // 회전과 배율은 아예 없다.
    expect((fine.modifiers ?? []).some((m) => m.target === 'rotate' || m.target === 'scale')).toBe(false)
  })

  for (const preset of BOIL_PRESETS) {
    it(`${preset.id} 의 지속 프레임이 홀드의 배수다`, () => {
      // totalFrames % holdFrames != 0 이면 마지막 홀드 블록이 잘려 루프가 깨진다.
      for (const durationFrames of [0, 17, 23, 40, 61]) {
        for (const speed of [0.5, 1, 2]) {
          const e = emit(preset, { durationFrames, speed })
          const holds = new Set((e.modifiers ?? []).map((m) => m.holdFrames))
          expect(holds.size, `${preset.id} 의 홀드가 축마다 다르다`).toBe(1)
          const hold = [...holds][0] ?? 1
          expect(e.durationFrames % hold, `${preset.id} d=${durationFrames} s=${speed}`).toBe(0)
        }
      }
    })

    it(`${preset.id} 의 홀드가 2프레임 이상이다`, () => {
      // 홀드가 1이면 자글자글이 아니라 그냥 흔들림이다.
      for (const m of emit(preset).modifiers ?? []) {
        expect(m.holdFrames, m.id).toBeGreaterThanOrEqual(2)
      }
    })
  }

  it('홀드를 바꾸면 지속 프레임도 그 배수로 따라간다', () => {
    const preset = MOTION_PRESET_BY_ID.get('boil.hand')!
    for (const hold of [2, 3, 4, 5, 6]) {
      const e = emit(preset, { params: { hold } })
      expect(e.durationFrames % hold, `hold=${hold}`).toBe(0)
    }
  })

  it('2컷 스텝만 이펙트 없이 완성된다', () => {
    const codes = (e: PresetEmission): string[] => (e.notices ?? []).map((n) => n.code)
    expect(codes(emit(MOTION_PRESET_BY_ID.get('boil.step')!))).not.toContain('needsEffect')
    for (const id of ['boil.hand', 'boil.edge', 'boil.paper']) {
      expect(codes(emit(MOTION_PRESET_BY_ID.get(id)!)), id).toContain('needsEffect')
    }
  })

  it('길이를 맞췄으면 그 사실을 알린다', () => {
    // 17프레임을 요청하면 3의 배수인 18로 올라간다.
    const e = emit(MOTION_PRESET_BY_ID.get('boil.hand')!, { durationFrames: 17 })
    expect(e.durationFrames).toBe(18)
    expect((e.notices ?? []).map((n) => n.code)).toContain('durationSnapped')
  })

  it('snapToHold 는 항상 홀드의 배수를 돌려준다', () => {
    for (let hold = 1; hold <= 12; hold += 1) {
      for (let span = 2; span <= 200; span += 7) {
        const out = snapToHold(span, hold)
        expect(out % hold, `span=${span} hold=${hold}`).toBe(0)
        expect(out).toBeGreaterThanOrEqual(2)
        expect(out).toBeLessThanOrEqual(FRAMES_MAX)
      }
    }
  })
})

// ---------------------------------------------------------------------------
// H. 지지직
// ---------------------------------------------------------------------------

describe('H. 지지직', () => {
  it('여덟 종 전부 있다', () => {
    expect(GLITCH_PRESETS.map((p) => p.id).sort()).toEqual([
      'glitch.block',
      'glitch.burst',
      'glitch.pixelSort',
      'glitch.rgbShift',
      'glitch.scanline',
      'glitch.slice',
      'glitch.vhs',
      'glitch.wave',
    ])
  })

  it('용량 통제 값이 프리셋 정의에 박혀 있다', () => {
    // 이 셋이 되돌아가면 그림은 그대로인데 파일만 세 배가 된다.
    expect(GLITCH_FPS).toBe(20)
    expect(GLITCH_HOLD).toBe(2)

    for (const preset of GLITCH_PRESETS) {
      expect(preset.recommendedFps, `${preset.id} 의 권장 fps`).toBe(GLITCH_FPS)
      expect(emit(preset).suggestedFps, `${preset.id} 의 emit fps`).toBe(GLITCH_FPS)
      // 지지직 계열의 지속시간은 400~1600ms 다. 길게 잡으면 용량이 바로 무너진다.
      expect(preset.defaultDurationMs, `${preset.id} 의 기본 길이`).toBeLessThanOrEqual(1600)

      const hold = preset.params.find((p) => p.key === 'hold')
      if (hold) expect(hold.default, `${preset.id} 의 홀드 기본값`).toBe(GLITCH_HOLD)
    }
  })

  it('노이즈를 쓰는 프리셋은 홀드 노브를 갖는다', () => {
    // 주사선과 물결은 규칙적인 무늬라 홀드가 없어도 델타 압축이 먹는다.
    const noiseless = new Set(['glitch.scanline', 'glitch.wave'])
    for (const preset of GLITCH_PRESETS) {
      const hasHold = preset.params.some((p) => p.key === 'hold')
      expect(hasHold, preset.id).toBe(!noiseless.has(preset.id))
    }
  })

  it('홀드가 있는 프리셋의 지속 프레임은 홀드의 배수다', () => {
    for (const preset of GLITCH_PRESETS) {
      if (!preset.params.some((p) => p.key === 'hold')) continue
      for (const durationFrames of [0, 15, 33]) {
        const e = emit(preset, { durationFrames })
        expect(e.durationFrames % GLITCH_HOLD, `${preset.id} d=${durationFrames}`).toBe(0)
      }
    }
  })

  it('이펙트가 필요한 프리셋은 전부 그 사실을 알린다', () => {
    for (const preset of GLITCH_PRESETS) {
      expect((emit(preset).notices ?? []).map((n) => n.code), preset.id).toContain('needsEffect')
    }
  })

  it('점멸은 초당 3회 미만이다 (WCAG 2.3.1)', () => {
    const preset = MOTION_PRESET_BY_ID.get('glitch.burst')!
    for (const fps of [10, 20, 25, 50]) {
      for (const strength of [0, 0.5, 1]) {
        const e = emit(preset, { fps, strength, params: { events: 4 } })
        const events = Math.max(...(e.modifiers ?? []).map((m) => m.cycles))
        const seconds = e.durationFrames / fps
        expect(events / seconds, `fps=${fps} strength=${strength}`).toBeLessThan(3)
      }
    }
  })

  it('점멸이 있으면 경고를 함께 낸다', () => {
    const codes = (emit(MOTION_PRESET_BY_ID.get('glitch.burst')!).notices ?? []).map((n) => n.code)
    expect(codes).toContain('flashWarning')
  })

  it('limitFlashCount 는 요청이 아무리 커도 상한을 넘기지 않는다', () => {
    for (const seconds of [0.2, 0.5, 1, 2, 4]) {
      const frames = Math.round(seconds * 25)
      const out = limitFlashCount(99, frames, 25)
      // 1회는 아무리 짧아도 뺄 수 없다. 그 아래는 프리셋이 아니라 길이 문제다.
      expect(out).toBe(Math.max(1, Math.floor(2.9 * seconds)))
      // 1초 이상이면 초당 3회 미만이 실제로 성립한다.
      if (seconds >= 1) expect(out / seconds).toBeLessThan(3)
    }
  })

  it('limitFlashCount 는 요청보다 늘리지 않는다', () => {
    expect(limitFlashCount(1, 100, 25)).toBe(1)
    expect(limitFlashCount(2, 100, 25)).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// 점멸 (WCAG 2.3.1) - 카테고리를 가리지 않는다
// ---------------------------------------------------------------------------

/**
 * 이 프리셋이 한 주기에 몇 번 번쩍이는가.
 *
 * 점멸을 만드는 방법이 둘이라 둘 다 센다.
 *   1. 불투명도 계단 (fade.flicker). 값이 내려가는 키의 개수가 곧 번쩍인 횟수다.
 *   2. eventBurst 모디파이어 (glitch.burst). 사건 수가 곧 번쩍인 횟수다.
 * 둘 중 큰 쪽을 쓴다. 한 프리셋이 둘을 함께 쓰면 사람 눈에는 많은 쪽으로 보인다.
 */
function flashCountOf(e: PresetEmission): number {
  let steps = 0
  for (const t of e.tracks) {
    if (t.prop !== 'opacity') continue
    for (let i = 1; i < t.keys.length; i += 1) {
      if ((t.keys[i]?.v ?? 0) < (t.keys[i - 1]?.v ?? 0)) steps += 1
    }
  }
  let bursts = 0
  for (const m of e.modifiers ?? []) {
    if (m.type === 'eventBurst') bursts = Math.max(bursts, m.cycles)
  }
  return Math.max(steps, bursts)
}

describe('점멸 상한 (WCAG 2.3.1)', () => {
  /*
   * 상한은 지지직만의 규칙이 아니다. 깜빡임(fade.flicker)은 시선 끌기 카테고리인데
   * 불투명도 계단으로 초당 10회까지 번쩍일 수 있었다. limitFlashCount 가 glitch.ts
   * 안에만 있어서 그 프리셋에는 닿지 않았고, 경고 안내도 없었다.
   * 그래서 검사를 카탈로그 전체로 넓힌다. 점멸을 선언한 프리셋은 전부 여기를 지난다.
   */
  const flashing = MOTION_PRESETS.filter((p) => p.flashWarning === true)

  it('점멸을 만드는 프리셋이 실제로 있다', () => {
    expect(flashing.map((p) => p.id).sort()).toEqual(['fade.flicker', 'glitch.burst'])
  })

  for (const preset of flashing) {
    it(`${preset.id} 은 어떤 설정에서도 초당 3회 미만이다`, () => {
      // 사용자가 만질 수 있는 축을 전부 최대로 민다. 세기, 속도, fps, 고유 노브.
      const extremes: Record<string, number> = {}
      for (const spec of preset.params) {
        if (spec.type === 'number' && spec.max !== undefined) extremes[spec.key] = spec.max
      }
      for (const fps of [10, 20, 25, 50]) {
        for (const speed of [0.5, 1, 2]) {
          for (const strength of [0, 1]) {
            const e = emit(preset, { fps, speed, strength, params: extremes })
            const seconds = e.durationFrames / fps
            const rate = flashCountOf(e) / seconds
            expect(rate, `${preset.id} fps=${fps} speed=${speed} strength=${strength}`).toBeLessThan(3)
          }
        }
      }
    })

    it(`${preset.id} 은 점멸 사실을 안내로 알린다`, () => {
      // 상한 안이라도 알린다. 광과민성 사용자에게는 "안전하다" 가 아니라
      // "번쩍인다" 가 필요한 정보다.
      expect((emit(preset).notices ?? []).map((n) => n.code), preset.id).toContain('flashWarning')
    })
  }

  it('점멸을 만들지 않는 프리셋은 헛경고를 내지 않는다', () => {
    // 경고가 흔해지면 아무도 안 읽는다.
    for (const preset of MOTION_PRESETS) {
      if (preset.flashWarning === true) continue
      expect((emit(preset).notices ?? []).map((n) => n.code), preset.id).not.toContain('flashWarning')
    }
  })
})

// ---------------------------------------------------------------------------
// I. 조합
// ---------------------------------------------------------------------------

describe('I. 조합', () => {
  it('여섯 종이다', () => {
    expect(COMBO_PRESETS.map((p) => p.id).sort()).toEqual([
      'combo.driftSway',
      'combo.kbGrain',
      'combo.popGlitchIn',
      'combo.punchRgb',
      'combo.slideFadeGlitch',
      'combo.zoomShake',
    ])
  })

  it('참조하는 부품이 전부 실재한다', () => {
    // 오타 하나로 부품이 조용히 빠지면 조합은 이름만 남고 반쪽만 재생된다.
    for (const id of comboPartIds()) {
      expect(MOTION_PRESET_BY_ID.get(id), `${id} 가 없다`).toBeDefined()
    }
  })

  it('조합이 조합을 부품으로 쓰지 않는다', () => {
    // 중첩을 허용하면 순환이 생기고, 순환은 emit 무한 재귀다.
    for (const id of comboPartIds()) {
      expect(MOTION_PRESET_BY_ID.get(id)?.category, id).not.toBe('combo')
      expect(id.startsWith('combo.'), id).toBe(false)
    }
  })

  for (const preset of COMBO_PRESETS) {
    it(`${preset.id} 는 부품의 움직임을 실제로 합친다`, () => {
      const e = emit(preset)
      expect(e.tracks.length + (e.modifiers ?? []).length).toBeGreaterThanOrEqual(1)

      // 같은 prop 을 두 부품이 내면 하나만 남아야 한다. 두 개면 나중 것이 앞의 것을 덮는다.
      const props = e.tracks.map((t) => t.prop)
      expect(new Set(props).size, `${preset.id} 에 같은 속성 트랙이 두 개다`).toBe(props.length)

      // 트랙 id 도 겹치면 안 된다. 문서에 심을 때 하나가 사라진다.
      const ids = e.tracks.map((t) => t.id)
      expect(new Set(ids).size).toBe(ids.length)
    })
  }

  it('섞는 정도 0퍼센트면 기준 부품만 남는다', () => {
    const preset = MOTION_PRESET_BY_ID.get('combo.zoomShake')!
    const off = emit(preset, { params: { mix: 0 } })
    const on = emit(preset, { params: { mix: 100 } })

    // 기준은 zoom.slowIn 의 크기 트랙, 보조는 shake.camera 의 모디파이어다.
    expect(off.tracks.length).toBeGreaterThanOrEqual(1)
    expect(off.modifiers ?? []).toHaveLength(0)
    expect((on.modifiers ?? []).length).toBeGreaterThanOrEqual(1)
  })

  it('섞는 정도를 올리면 보조 부품의 진폭이 커진다', () => {
    const preset = MOTION_PRESET_BY_ID.get('combo.zoomShake')!
    const sum = (e: PresetEmission): number =>
      (e.modifiers ?? []).reduce((acc, m) => acc + Math.abs(m.amplitude), 0)
    expect(sum(emit(preset, { params: { mix: 150 } }))).toBeGreaterThan(
      sum(emit(preset, { params: { mix: 50 } })),
    )
  })

  it('부품마다 다른 길이를 쓰지 않는다', () => {
    // 홀드가 다른 부품을 섞으면 한쪽의 마지막 홀드 블록이 잘린다.
    for (const preset of COMBO_PRESETS) {
      const e = emit(preset)
      for (const m of e.modifiers ?? []) {
        expect(e.durationFrames % m.holdFrames, `${preset.id} / ${m.id}`).toBe(0)
      }
    }
  })

  it('지지직을 섞은 조합은 권장 fps 를 물려받는다', () => {
    for (const id of ['combo.punchRgb', 'combo.popGlitchIn', 'combo.slideFadeGlitch']) {
      expect(emit(MOTION_PRESET_BY_ID.get(id)!).suggestedFps, id).toBe(GLITCH_FPS)
    }
  })

  it('부품이 낸 안내를 그대로 올려 보낸다', () => {
    // 조합을 골랐다는 이유로 "이펙트가 필요하다" 를 숨기면 사용자는 반쪽 결과를 본다.
    const codes = (emit(MOTION_PRESET_BY_ID.get('combo.popGlitchIn')!).notices ?? []).map((n) => n.code)
    expect(codes).toContain('needsEffect')
  })

  it('길이 안내는 조합이 대신 흡수한다', () => {
    // 조합이 이미 홀드 배수로 맞춰 넘겼으므로 부품의 길이 안내는 소음이다.
    for (const preset of COMBO_PRESETS) {
      const codes = (emit(preset).notices ?? []).map((n) => n.code)
      expect(codes, preset.id).not.toContain('durationSnapped')
    }
  })
})

// ---------------------------------------------------------------------------
// 이음새 (트랙이 있는 새 프리셋)
// ---------------------------------------------------------------------------

describe('이음새 없는 루프', () => {
  for (const preset of NEW_PRESETS.filter((p) => p.loopSafe === 'seamless')) {
    it(`${preset.id} 는 첫 값과 끝 값이 같다`, () => {
      const e = emit(preset)
      for (const t of e.tracks) {
        const first = t.keys[0]!
        const last = t.keys[t.keys.length - 1]!
        expect(last.f, `${t.prop} 의 마지막 키가 주기 끝에 없다`).toBe(e.durationFrames)
        const norm = (v: number): number => (t.prop === 'rotate' ? ((v % 360) + 360) % 360 : v)
        expect(norm(last.v), `${t.prop} 의 이음새가 벌어진다`).toBeCloseTo(norm(first.v), 9)
      }
    })
  }

  it('왕복 전용과 1회 재생의 트랙은 마지막 출력 프레임에서 끝난다', () => {
    for (const preset of NEW_PRESETS) {
      if (preset.loopSafe === 'seamless') continue
      const e = emit(preset)
      if (e.tracks.length === 0) continue
      const ends = e.tracks.map((t) => t.keys[t.keys.length - 1]!.f)
      expect(Math.max(...ends), preset.id).toBe(e.durationFrames - 1)
    }
  })
})
