/**
 * 모션 프리셋 카탈로그 전체 규칙.
 *
 * 프리셋은 "적용해 보고 눈으로 확인"이 어려운 종류의 코드다. 61종 중 하나가 조용히
 * 깨져도 사용자가 그 프리셋을 고르기 전까지 아무도 모른다. 그래서 카탈로그 전체를
 * 한 번에 훑는 규칙 검사를 둔다.
 *
 * 특히 세 가지를 감시한다.
 *   1. 이음새 없는 루프 프리셋의 첫 값과 끝 값이 실제로 같은가
 *   2. rotate.spin360 의 이징 잠금이 풀리지 않았는가
 *   3. 회전/이동 프리셋에서 캔버스가 비지 않는가
 *
 * ---------------------------------------------------------------------------
 * "프리셋 = 키프레임 트랙" 이 아니다
 * ---------------------------------------------------------------------------
 * 다음 셋이 전부 성립한다.
 *   1. 프리셋은 트랙 없이 **모디파이어만** 낼 수 있다 (흔들기, 자글자글).
 *   2. 프리셋은 트랙도 모디파이어도 없이 **이펙트만** 낼 수 있다 (지지직).
 *   3. 홀드 클럭이 있는 프리셋은 요청 길이를 홀드의 배수로 **스냅한다**.
 * F~I 고유 규칙은 motionsFGHI.test.ts 가 본다. 이 파일은 61종 공통 규칙만 본다.
 */

import { describe, expect, it } from 'vitest'

import { createEmptyProject, createImageLayer, resetIdCounter } from '@/core/factory.ts'
import { resolveComposition, resolveLayerTransform } from '@/core/evaluate.ts'
import { modifierHeadroom, requiredScaleAt, solveLayerOverscan } from '@/core/overscan.ts'
import { FRAMES_MAX, type AssetRef, type Layer, type MotionProject } from '@/core/types.ts'
import { evalTrack } from '@/easing/curve.ts'
import {
  CATEGORY_LABELS,
  EASY_PRESETS,
  MOTION_PRESETS,
  MOTION_PRESET_BY_ID,
  applyPreset,
  byCategory,
  createEmitContext,
  resolveParams,
} from '@/motions/registry.ts'
import type {
  EmitContext,
  MotionCategory,
  MotionPreset,
  ParamSpec,
  PresetEmission,
} from '@/motions/types.ts'

// ---------------------------------------------------------------------------
// 공통 헬퍼
// ---------------------------------------------------------------------------

function emit(preset: MotionPreset, overrides: Partial<EmitContext> = {}): PresetEmission {
  return applyPreset(preset, createEmitContext(overrides))
}

/**
 * 500px 캔버스에 600px 원본.
 *
 * **모디파이어까지 붙인다.** 흔들기와 자글자글은 움직임 전부가 모디파이어에 있어서,
 * 트랙만 붙이면 "아무 데도 안 움직이는 레이어" 를 놓고 오버스캔을 재게 된다.
 * 솔버는 layer.modifiers 를 읽어 헤드룸을 더하므로(overscan.modifierHeadroom)
 * 여기서 붙여야 실제와 같은 조건이 된다.
 */
function overscanCase(emission: PresetEmission): { doc: MotionProject; layer: Layer } {
  resetIdCounter()
  const doc = createEmptyProject()
  doc.canvas.w = 500
  doc.canvas.h = 500
  doc.timeline.durationFrames = Math.max(2, emission.durationFrames)

  const asset: AssetRef = {
    id: 'a1', name: 'img', storeKey: 'k', naturalW: 600, naturalH: 600, hasAlpha: true,
  }
  doc.assets = [asset]

  const layer = createImageLayer(asset, 0)
  // 채우기 솔버를 재는 자리다. 레이어 기본값은 '원본 크기 그대로'(fit: none, 담기/채우기
  // 모두 꺼짐)라 명시적으로 채우기로 돌린다. fit 도 같이 바꿔야 isSolverTarget 이 통과한다.
  layer.fit = 'cover'
  layer.fillsCanvas = true
  layer.keepInside = false
  layer.tracks = emission.tracks
  layer.modifiers = emission.modifiers ?? []
  doc.layers = [layer]
  return { doc, layer }
}

/**
 * 보정을 걸지 않은 상태에서 한 프레임이라도 캔버스가 비는가.
 *
 * correction > 1 로 판정하면 안 된다. 두 방향으로 틀린다.
 *   - 아무 데도 안 움직이는 프리셋도 안전 여백(marginRatio 0.005) 때문에 1.005 가 나온다.
 *   - 줌이 함께 있는 조합은 kMax 가 이미 커서 correction 이 1 로 떨어지는데,
 *     정작 배율이 1 인 첫 프레임에서는 흔들림이 가장자리를 비운다.
 * 그래서 "빈다" 를 프레임마다 직접 잰다. 모디파이어 헤드룸도 함께 넣는다.
 */
function emptiesCanvas(doc: MotionProject, layer: Layer): boolean {
  const head = modifierHeadroom(layer)
  const duration = doc.timeline.durationFrames
  for (let f = 0; f < duration; f += 1) {
    // durationFrames 를 넘겨야 모디파이어가 실제 위상으로 평가된다. 기본값 1 로 두면
    // 사인이 정수 프레임마다 0 이 되어 흔들림이 통째로 사라진 것처럼 보인다.
    const t = resolveLayerTransform(layer, f, doc.canvas, duration)
    const probe = {
      ...t,
      translateX: Math.abs(t.translateX) + head.translate,
      translateY: Math.abs(t.translateY) + head.translate,
      rotate: Math.abs(t.rotate) + head.rotateDeg,
    }
    const want = requiredScaleAt(500, 500, 600, 600, probe)
    const actual = (500 / 600) * Math.min(t.scaleX, t.scaleY)
    if (actual < want - 1e-9) return true
  }
  return false
}

/**
 * 세기 슬라이더가 실제로 진폭을 바꾸는지 보는 데 쓴다.
 *
 * 트랙 값 폭만 재서는 안 된다. 흔들기가 모디파이어로, 지지직이 이펙트
 * 파라미터로 진폭을 표현하므로 넷을 다 더해야 한다. 이펙트 파라미터는 상수일 수도
 * 있고 시간축 트랙일 수도 있다(EffectParam = number | Track). 색 어긋남처럼
 * 이펙트 자체에 시간 성분이 없는 경우 진폭이 트랙 쪽에만 있으므로, 트랙을 빼고 세면
 * "세기를 올려도 아무 일이 없다" 로 잘못 읽힌다.
 * 세기와 무관한 항은 양쪽에 똑같이 더해지므로 비교에 영향을 주지 않는다.
 */
function amplitudeOf(emission: PresetEmission): number {
  let total = 0
  for (const t of emission.tracks) {
    let lo = Number.POSITIVE_INFINITY
    let hi = Number.NEGATIVE_INFINITY
    for (const k of t.keys) {
      if (k.v < lo) lo = k.v
      if (k.v > hi) hi = k.v
    }
    total += hi - lo
  }
  /*
   * 글자 프리셋의 진폭은 트랙이 아니라 charAnim 에 있다.
   * 진행률 트랙은 언제나 0 -> 1 이고, 세기는 거리 / 각도 / 배율에 걸린다.
   */
  const ca = emission.charAnim
  if (ca) {
    total += Math.abs(ca.distance) + Math.abs(ca.rotate) / 360 + Math.abs(ca.scale - 1)
  }
  for (const m of emission.modifiers ?? []) total += Math.abs(m.amplitude)
  for (const e of emission.effects ?? []) {
    for (const v of Object.values(e.params)) {
      if (typeof v === 'number') {
        if (Number.isFinite(v)) total += Math.abs(v)
        continue
      }
      // 파라미터 트랙은 최고치가 곧 그 이펙트의 진폭이다.
      total += Math.max(0, ...v.keys.map((k) => Math.abs(k.v)))
    }
  }
  return total
}

/** 사용자가 명시적으로 요구한 프리셋. 하나라도 빠지면 안 된다. */
const REQUIRED_IDS = [
  // 등장 / 사라짐
  'zoom.pop', 'fade.in', 'fade.out', 'fade.inOut',
  'slide.inFade', 'slide.outFade',
  'zoom.upIn', 'zoom.downIn',
  // 계속 움직이기
  'zoom.slowIn', 'zoom.slowOut',
  'slide.panLR', 'slide.panUD',
  'slide.left', 'slide.right', 'slide.up', 'slide.down',
  // 화면을 가로질러 지나가는 4종. 한쪽 밖에서 반대쪽 밖으로 빠진다.
  'slide.crossRight', 'slide.crossLeft', 'slide.crossDown', 'slide.crossUp',
  // 시선 끌기
  'rotate.cw', 'rotate.ccw', 'rotate.spin360', 'rotate.sway',
  'zoom.punch', 'zoom.squash', 'fade.flicker',
  // 사진 훑기
  'kb.classic', 'kb.random', 'kb.zoomToPoint', 'parallax.dual',
]

/** 진폭이 정의상 고정인 프리셋. 완전한 페이드와 정확히 한 바퀴 회전은 세기로 줄일 수 없다. */
/*
 * 세기가 진폭을 바꾸지 않는 프리셋.
 *
 * 전부 "끝값이 정의상 고정" 인 경우다. 페이드는 0 에서 1 까지가 페이드이고,
 * 한 바퀴는 정확히 360도여야 이음새가 닫힌다. 카드 한 바퀴도 같은 이유다.
 * 세기는 이쪽에서 속도나 원근처럼 다른 축에 걸린다.
 */
const FIXED_AMPLITUDE = new Set([
  // 자리에서 나타나기만 하는 글자 모션. 움직임 자체가 없어 세기가 걸릴 곳이 없다.
  'text.typewriter',
  'text.fade',
  // 굴리기도 같다. 자리에 앉은 채 그리는 칸만 바뀐다 (core/charAnim.ts).
  'text.scramble',
  // 뒤집기는 90도에서 0도까지 한 번 도는 것이 전부다. flip3d.turn 과 같은 이유다.
  'text.flip',
  'fade.in',
  'fade.out',
  'fade.inOut',
  'rotate.spin360',
  'flip3d.turn',
])

const CATEGORY_IDS = Object.keys(CATEGORY_LABELS) as MotionCategory[]

/**
 * 트랙만으로 표현되는 A~E 카테고리.
 *
 * "프리셋은 모디파이어를 내지 않는다" 는 규칙은 이 다섯에만 적용된다.
 * F~I 는 모디파이어와 이펙트가 본체다.
 */
const M3_CATEGORIES = new Set<MotionCategory>([
  'appear',
  'disappear',
  'move',
  'attention',
  'kenburns',
])

/** A~E 프리셋. combo.popGlitchIn 처럼 카테고리만 A/B 인 조합은 뺀다. */
const M3_PRESETS = MOTION_PRESETS.filter(
  (p) => M3_CATEGORIES.has(p.category) && !p.id.startsWith('combo.'),
)

// ---------------------------------------------------------------------------
// 카탈로그 구성
// ---------------------------------------------------------------------------

describe('카탈로그 구성', () => {
  it('아홉 카테고리 구성이 표와 같다', () => {
    expect(byCategory('appear')).toHaveLength(16)
    expect(byCategory('disappear')).toHaveLength(9)
    expect(byCategory('move')).toHaveLength(14)
    expect(byCategory('attention')).toHaveLength(14)
    expect(byCategory('kenburns')).toHaveLength(4)
    expect(byCategory('shake')).toHaveLength(6)
    expect(byCategory('boil')).toHaveLength(5)
    expect(byCategory('glitch')).toHaveLength(8)
    expect(byCategory('combo')).toHaveLength(4)
  })

  it('전부 합쳐 99종이다 (A16 + B9 + C14 + D14 + E4 + F6 + G5 + H8 + I4 + J19)', () => {
    const total = CATEGORY_IDS.map((c) => byCategory(c).length).reduce((a, b) => a + b, 0)
    expect(total).toBe(99)
    expect(MOTION_PRESETS).toHaveLength(99)
  })

  it('조합 프리셋이 들어와 있다', () => {
    // 이펙트가 붙어야 성립하는 조합 2종이 실제로 카탈로그에 있는지 본다.
    expect(byCategory('combo').length).toBeGreaterThan(0)
    // 지지직 조합 2종은 만드는 방식만 조합이고 카테고리는 등장 / 사라짐이다.
    expect(MOTION_PRESET_BY_ID.get('combo.popGlitchIn')?.category).toBe('appear')
    expect(MOTION_PRESET_BY_ID.get('combo.slideFadeGlitch')?.category).toBe('disappear')
  })

  it('id 가 중복되지 않는다', () => {
    expect(MOTION_PRESET_BY_ID.size).toBe(MOTION_PRESETS.length)
  })

  it('사용자가 명시한 프리셋이 전부 있다', () => {
    for (const id of REQUIRED_IDS) {
      expect(MOTION_PRESET_BY_ID.get(id), `${id} 가 레지스트리에 없다`).toBeDefined()
    }
  })

  it('카테고리 이름은 의도 기반 한국어다', () => {
    expect(CATEGORY_LABELS.appear).toBe('등장')
    expect(CATEGORY_LABELS.kenburns).toBe('사진 훑기')
    // 켄번즈, 패럴랙스 같은 용어는 노출하지 않는다.
    for (const label of Object.values(CATEGORY_LABELS)) {
      expect(label).not.toMatch(/[a-zA-Z]/)
    }
  })

  it('내부 id 를 사용자에게 노출하지 않는다', () => {
    for (const preset of MOTION_PRESETS) {
      expect(preset.label.length).toBeGreaterThan(0)
      expect(preset.hint.length).toBeGreaterThan(0)
      // 모든 내부 id 는 점을 포함한다. 이름과 설명에는 영문도 점도 없어야 한다.
      expect(preset.label).not.toMatch(/[a-zA-Z.]/)
      expect(preset.hint).not.toContain(preset.id)
      for (const spec of preset.params) {
        expect(spec.label).not.toMatch(/[a-zA-Z]/)
      }
    }
  })

  it('EASY 기본 노출은 카테고리마다 최소 한 개씩 있다', () => {
    expect(EASY_PRESETS.length).toBeGreaterThan(0)
    for (const preset of EASY_PRESETS) expect(preset.easy).toBe(true)
    for (const category of ['appear', 'disappear', 'move', 'attention', 'kenburns'] as const) {
      expect(EASY_PRESETS.some((p) => p.category === category), category).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// 죽은 파라미터
// ---------------------------------------------------------------------------

/** 이 파라미터가 가질 수 있는 양 끝 값. 숫자는 min/max, 선택은 옵션 전부다. */
function paramProbes(spec: ParamSpec): (number | string | boolean)[] {
  if (spec.type === 'number') return [spec.min ?? 0, spec.max ?? 1]
  if (spec.type === 'boolean') return [false, true]
  return (spec.options ?? []).map((o) => o.value)
}

describe('죽은 파라미터가 없다', () => {
  /*
   * 슬라이더를 끝에서 끝까지 밀었는데 emit 결과가 한 글자도 안 바뀌면 그 노브는
   * 죽어 있다. 예외도 경고도 없고 화면도 그대로라 아무도 알아채지 못한다.
   * 실제로 '색 어긋남' 의 반복 횟수가 그랬다. emit 이 그 값을 아예 읽지 않아
   * 전 프레임이 같은 정지 이미지로 렌더됐고, 카드에는 노브가 멀쩡히 보였다.
   *
   * 값이 바뀌는지만 본다. 어떻게 바뀌어야 하는지는 프리셋마다 다르고, 그것까지
   * 여기서 규정하면 카탈로그를 손댈 때마다 이 파일을 고치게 된다.
   */
  for (const preset of MOTION_PRESETS) {
    for (const spec of preset.params) {
      it(`${preset.id}.${spec.key} 가 결과를 바꾼다`, () => {
        const probes = paramProbes(spec)
        // 고를 것이 하나뿐인 노브는 노브가 아니다.
        expect(probes.length, `${preset.id}.${spec.key} 는 후보 값이 하나뿐이다`).toBeGreaterThanOrEqual(2)

        const seen = new Set(probes.map((v) => JSON.stringify(emit(preset, { params: { [spec.key]: v } }))))
        expect(seen.size, `${preset.id}.${spec.key} 를 끝에서 끝까지 밀어도 결과가 같다`).toBeGreaterThan(1)
      })
    }
  }
})

// ---------------------------------------------------------------------------
// 카드 배지
// ---------------------------------------------------------------------------

describe('카드가 미리 읽는 필드가 emit 과 어긋나지 않는다', () => {
  /*
   * 갤러리는 61장을 그리면서 emit 을 부르지 않는다. 그래서 점멸 / 큰 원본 / 권장 fps 는
   * MotionPreset 에 미리 선언해 두고 카드가 그 필드를 읽는다. 선언과 emit 이 갈리면
   * 배너에는 "번쩍입니다" 가 뜨는데 카드에는 점멸 주의 배지가 없는 상태가 된다.
   * 사본을 두기로 한 이상 어긋나지 않는다는 것은 여기서 확인해야 한다.
   */
  const codesOf = (preset: MotionPreset): string[] => (emit(preset).notices ?? []).map((n) => n.code)

  for (const preset of MOTION_PRESETS) {
    it(`${preset.id} 의 배지 필드가 안내와 같다`, () => {
      const codes = codesOf(preset)
      expect(preset.flashWarning === true, `${preset.id} 의 점멸 선언`).toBe(codes.includes('flashWarning'))
      expect(preset.largeSource === true, `${preset.id} 의 큰 원본 선언`).toBe(
        codes.includes('largeSourceRecommended'),
      )
      expect(preset.recommendedFps, `${preset.id} 의 권장 fps`).toBe(emit(preset).suggestedFps)
    })
  }

  it('실제로 점멸하는 프리셋이 있다', () => {
    // 위 검사는 "둘 다 없음" 으로도 통과한다. 카탈로그에 점멸이 하나도 없으면
    // 그 자체가 회귀다 (깜빡임과 지지직 폭발은 카탈로그에 있는 항목이다).
    const flashing = MOTION_PRESETS.filter((p) => p.flashWarning === true).map((p) => p.id).sort()
    expect(flashing).toEqual(['fade.flicker', 'glitch.burst'])
  })
})

// ---------------------------------------------------------------------------
// emit 유효성
// ---------------------------------------------------------------------------

describe('emit 유효성', () => {
  for (const preset of MOTION_PRESETS) {
    it(`${preset.id} 는 쓸 수 있는 결과를 낸다`, () => {
      const e = emit(preset)

      expect(e.durationFrames).toBeGreaterThanOrEqual(2)
      expect(e.durationFrames).toBeLessThanOrEqual(FRAMES_MAX)

      // 트랙 / 모디파이어 / 이펙트 중 최소 하나는 비어 있지 않아야 한다.
      // 지지직은 트랙도 모디파이어도 없이 이펙트만 내는 것이 정상이다.
      const parts = e.tracks.length + (e.modifiers ?? []).length + (e.effects ?? []).length
      expect(parts, `${preset.id} 가 아무것도 내지 않는다`).toBeGreaterThanOrEqual(1)

      for (const t of e.tracks) {
        expect(t.keys.length, `${t.prop} 트랙의 키가 부족하다`).toBeGreaterThanOrEqual(2)

        let prev = -1
        for (const k of t.keys) {
          expect(Number.isInteger(k.f), `${t.prop} 의 프레임 ${k.f} 가 정수가 아니다`).toBe(true)
          expect(k.f, `${t.prop} 의 프레임이 오름차순이 아니다`).toBeGreaterThan(prev)
          expect(k.f).toBeGreaterThanOrEqual(0)
          expect(k.f, `${t.prop} 의 키가 지속 구간을 넘었다`).toBeLessThanOrEqual(e.durationFrames)
          expect(Number.isFinite(k.v)).toBe(true)
          prev = k.f
        }

        if (t.prop === 'opacity') {
          for (const k of t.keys) {
            expect(k.v).toBeGreaterThanOrEqual(0)
            expect(k.v).toBeLessThanOrEqual(1)
          }
        }
        if (t.prop === 'scale' || t.prop === 'scaleX' || t.prop === 'scaleY') {
          for (const k of t.keys) expect(k.v).toBeGreaterThan(0)
        }
      }
    })
  }

  it('emit 은 순수 함수다. 같은 입력이면 같은 결과가 나온다', () => {
    for (const preset of MOTION_PRESETS) {
      const a = emit(preset, { seed: 7 })
      const b = emit(preset, { seed: 7 })
      expect(a, preset.id).toEqual(b)
    }
  })

  it('무작위 훑기는 시드가 다르면 다른 결과를 낸다', () => {
    const preset = MOTION_PRESET_BY_ID.get('kb.random')!
    const a = emit(preset, { seed: 1 })
    const b = emit(preset, { seed: 2 })
    expect(a).not.toEqual(b)
  })

  it('A~E 프리셋은 모디파이어도 이펙트도 내지 않는다', () => {
    /*
     * A~E 는 다듬을 수 있어야 하는 모션이라 결과가 전부 키프레임이어야 한다.
     * 여기서 모디파이어나 이펙트를 내면 그래프 에디터로 손댈 수 없는 성분이 섞이고,
     * 오버스캔 솔버의 이론적 최대 진폭만 부풀린다.
     *
     * F~I 는 반대다. 그쪽은 모디파이어와 이펙트가 본체다.
     *
     * effects 를 "빈 배열" 이 아니라 **undefined** 로 확인하는 것이 핵심이다.
     * A~E 가 빈 배열을 내면 사용자가 직접 쌓아 둔 이펙트가 프리셋을 갈아탈 때마다
     * 날아간다 (motions/types.ts 의 PresetEmission.effects 계약).
     */
    for (const preset of M3_PRESETS) {
      const e = emit(preset)
      expect(e.modifiers ?? [], preset.id).toHaveLength(0)
      expect(e.effects, `${preset.id} 가 이펙트 스택을 건드린다`).toBeUndefined()
    }
  })

  it('반복 모드 제안이 반복 안전성과 맞는다', () => {
    for (const preset of MOTION_PRESETS) {
      const e = emit(preset)
      // once 계열도 기본 제안은 반복이다 (loopFor 주석 참조). 스티커는 반복이 표준이다.
      const expected = preset.loopSafe === 'pingPongOnly' ? 'pingPong' : 'loop'
      expect(e.suggestedLoop, preset.id).toBe(expected)
    }
  })

  it('속도 슬라이더는 진폭이 아니라 지속 프레임에 작용한다', () => {
    for (const preset of MOTION_PRESETS) {
      const slow = emit(preset, { speed: 0.5 })
      const fast = emit(preset, { speed: 2 })
      expect(fast.durationFrames, preset.id).toBeLessThan(slow.durationFrames)
    }
  })

  it('요청 지속 프레임이 있으면 그 길이에 맞춘다', () => {
    /*
     * 홀드 클럭이 없는 프리셋은 요청 길이를 정확히 쓴다.
     *
     * 자글자글처럼 홀드 클럭이 있는 프리셋은 **홀드의 배수로 스냅한다. 의도된 동작이다.**
     * effFrame = floor(frame/hold)*hold 이므로 totalFrames % holdFrames != 0 이면
     * 마지막 홀드 블록만 짧게 잘리고, 그 한 칸이 정확히 루프가 끊기는 지점이 된다.
     * 그래서 "요청 길이 이하이면서 홀드의 배수" 로 단언한다. 스냅한 사실은
     * durationSnapped 안내로 사용자에게 알린다.
     */
    const requested = 40
    for (const preset of MOTION_PRESETS) {
      const e = emit(preset, { durationFrames: requested })
      const hold = Math.max(1, Math.round(preset.noiseHoldFrames ?? 1))
      if (hold <= 1) {
        expect(e.durationFrames, preset.id).toBe(requested)
        continue
      }
      expect(e.durationFrames % hold, `${preset.id} 가 홀드의 배수가 아니다`).toBe(0)
      expect(e.durationFrames, preset.id).toBeLessThanOrEqual(requested)
      expect(e.durationFrames, preset.id).toBeGreaterThan(requested - hold)
    }
  })
})

// ---------------------------------------------------------------------------
// 이음새
// ---------------------------------------------------------------------------

describe('이음새 없는 루프', () => {
  const seamless = MOTION_PRESETS.filter((p) => p.loopSafe === 'seamless')

  it('seamless 프리셋이 존재한다', () => {
    expect(seamless.length).toBeGreaterThanOrEqual(8)
  })

  for (const preset of seamless) {
    it(`${preset.id} 는 첫 값과 끝 값이 같다`, () => {
      const e = emit(preset)
      for (const t of e.tracks) {
        const first = t.keys[0]!
        const last = t.keys[t.keys.length - 1]!

        // 한 주기가 정확히 durationFrames 여야 0..N-1 출력이 한 바퀴가 된다.
        expect(last.f, `${t.prop} 의 마지막 키가 주기 끝에 없다`).toBe(e.durationFrames)

        // 회전은 360도 = 0도 다. 세 회전축이 모두 같은 규칙이다. 나머지는 값이 그대로 같아야 한다.
        const isRotation = t.prop === 'rotate' || t.prop === 'rotateX' || t.prop === 'rotateY'
        const norm = (v: number): number => (isRotation ? ((v % 360) + 360) % 360 : v)
        expect(norm(last.v), `${t.prop} 의 이음새가 벌어진다`).toBeCloseTo(norm(first.v), 9)
      }
    })
  }

  it('왕복 전용과 1회 재생은 마지막 출력 프레임에서 끝난다', () => {
    for (const preset of MOTION_PRESETS) {
      if (preset.loopSafe === 'seamless') continue
      const e = emit(preset)
      // 트랙이 없는 프리셋(쿵 충격, 픽셀 흘러내림)은 검사 대상이 아니다.
      // 모디파이어와 이펙트는 마지막 키가 아니라 포락선과 range 로 끝을 정한다.
      if (e.tracks.length === 0) continue
      const ends = e.tracks.map((t) => t.keys[t.keys.length - 1]!.f)
      expect(Math.max(...ends), preset.id).toBe(e.durationFrames - 1)
    }
  })
})

// ---------------------------------------------------------------------------
// 이징 잠금
// ---------------------------------------------------------------------------

describe('rotate.spin360 이징 잠금', () => {
  const preset = MOTION_PRESET_BY_ID.get('rotate.spin360')!

  it('모든 키가 linear 다', () => {
    const e = emit(preset)
    const t = e.tracks[0]!
    expect(t.prop).toBe('rotate')
    for (const k of t.keys) {
      expect(k.interp).toBe('linear')
      // 베지어 핸들이 남아 있으면 나중에 interp 만 바꿔도 곡선이 살아난다.
      expect(k.out).toBeUndefined()
      expect(k.in).toBeUndefined()
    }
  })

  it('한 바퀴가 정확히 360도다', () => {
    const e = emit(preset)
    const keys = e.tracks[0]!.keys
    expect(Math.abs(keys[keys.length - 1]!.v - keys[0]!.v)).toBe(360)
  })

  it('등속이라 회전 속도가 전 구간 일정하다', () => {
    const e = emit(preset)
    const t = e.tracks[0]!
    const speeds: number[] = []
    for (let f = 0; f < e.durationFrames; f += 1) {
      speeds.push(evalTrack(t, f + 1)! - evalTrack(t, f)!)
    }
    const first = speeds[0]!
    for (const s of speeds) expect(s).toBeCloseTo(first, 6)
  })

  it('이징 잠금과 큰 원본 권장을 알린다', () => {
    const codes = (emit(preset).notices ?? []).map((n) => n.code)
    expect(codes).toContain('easingLocked')
    expect(codes).toContain('largeSourceRecommended')
  })
})

// ---------------------------------------------------------------------------
// 오버스캔
// ---------------------------------------------------------------------------

describe('오버스캔 정책', () => {
  for (const preset of MOTION_PRESETS.filter((p) => p.overscan === 'required')) {
    it(`${preset.id} 는 그냥 두면 캔버스가 빈다`, () => {
      const e = emit(preset)
      const { doc, layer } = overscanCase(e)
      expect(emptiesCanvas(doc, layer)).toBe(true)
    })
  }

  for (const preset of MOTION_PRESETS.filter((p) => p.overscan === 'auto')) {
    it(`${preset.id} 는 솔버가 개입하지 않는다`, () => {
      const e = emit(preset)
      const { doc, layer } = overscanCase(e)
      expect(emptiesCanvas(doc, layer), '자동인데 캔버스가 빈다').toBe(false)
      const need = solveLayerOverscan(doc, layer, 600, 600)
      // 서브픽셀 여유(marginRatio 0.005) 말고는 보정이 붙지 않아야 한다.
      // needsUpscale 은 별개다. 크게 당겨 들어가면 원본 픽셀이 모자랄 수 있고,
      // 그건 보정이 아니라 "큰 원본 권장" 배지로 처리한다.
      expect(need.correction).toBeLessThan(1.006)
    })
  }

  it('크게 당겨 들어가는 프리셋은 큰 원본을 권한다', () => {
    const e = emit(MOTION_PRESET_BY_ID.get('kb.zoomToPoint')!)
    const { doc, layer } = overscanCase(e)
    const need = solveLayerOverscan(doc, layer, 600, 600)
    expect(need.needsUpscale).toBe(true)
    expect(need.recommendedSourcePx).toBeGreaterThan(600)
  })

  for (const preset of MOTION_PRESETS.filter((p) => p.overscan === 'allowEmpty')) {
    it(`${preset.id} 는 화면 밖으로 나가는 것이 의도다`, () => {
      const e = emit(preset)
      const { doc, layer } = overscanCase(e)
      const need = solveLayerOverscan(doc, layer, 600, 600, { policy: 'allowEmpty' })
      expect(need.correction).toBe(1)
    })
  }

  it('보정을 받으면 이동/회전 프리셋에서 캔버스가 전 구간 찬다', () => {
    for (const preset of MOTION_PRESETS) {
      if (preset.overscan !== 'required') continue
      const e = emit(preset)
      const { doc, layer } = overscanCase(e)

      // 크기가 1 아래로 내려가는 프리셋은 배율 보정으로 메울 수 없다.
      // 처방은 배경 채우기다. 여기서는 검사 대상에서 뺀다.
      // 배율을 줄이는 모디파이어(숨쉬기의 scale)도 여기 걸리므로 durationFrames 를
      // 넘겨 아래의 resolveComposition 과 같은 위상으로 평가해야 한다.
      let minScale = Number.POSITIVE_INFINITY
      for (let f = 0; f < doc.timeline.durationFrames; f += 1) {
        const t = resolveLayerTransform(layer, f, doc.canvas, doc.timeline.durationFrames)
        minScale = Math.min(minScale, t.scaleX, t.scaleY)
      }
      if (minScale < 1) continue

      const need = solveLayerOverscan(doc, layer, 600, 600)
      const map = new Map([[layer.id, need]])
      for (let f = 0; f < doc.timeline.durationFrames; f += 1) {
        const resolved = resolveComposition(doc, f, map)[0]!
        const t = resolved.transform
        const want = requiredScaleAt(500, 500, 600, 600, t)
        const actual = (500 / 600) * Math.min(t.scaleX, t.scaleY)
        expect(actual, `${preset.id} frame ${f}`).toBeGreaterThanOrEqual(want - 1e-9)
      }
    }
  })

  it('사진 훑기는 rect 제약만으로 캔버스를 채운다', () => {
    for (const preset of byCategory('kenburns')) {
      const e = emit(preset)
      const { doc, layer } = overscanCase(e)
      for (let f = 0; f < doc.timeline.durationFrames; f += 1) {
        const t = resolveLayerTransform(layer, f, doc.canvas)
        const want = requiredScaleAt(500, 500, 600, 600, t)
        const actual = (500 / 600) * Math.min(t.scaleX, t.scaleY)
        expect(actual, `${preset.id} frame ${f}`).toBeGreaterThanOrEqual(want - 1e-9)
      }
    }
  })
})

// ---------------------------------------------------------------------------
// 세기 / 파라미터
// ---------------------------------------------------------------------------

describe('세기 슬라이더', () => {
  for (const preset of MOTION_PRESETS) {
    if (FIXED_AMPLITUDE.has(preset.id)) continue
    it(`${preset.id} 의 진폭이 세기에 따라 달라진다`, () => {
      const weak = amplitudeOf(emit(preset, { strength: 0 }))
      const strong = amplitudeOf(emit(preset, { strength: 1 }))
      expect(strong).toBeGreaterThan(weak)
    })
  }

  it('세기 0.5 가 기본값이다', () => {
    // 천천히 확대: k 1.00 -> 1.20
    const e = emit(MOTION_PRESET_BY_ID.get('zoom.slowIn')!)
    const keys = e.tracks[0]!.keys
    expect(keys[0]!.v).toBeCloseTo(1, 9)
    expect(keys[keys.length - 1]!.v).toBeCloseTo(1.2, 9)
  })

  it('좌우로 이동의 기본 진폭은 캔버스의 6퍼센트다', () => {
    const e = emit(MOTION_PRESET_BY_ID.get('slide.panLR')!)
    const t = e.tracks[0]!
    expect(t.prop).toBe('translateX')
    expect(t.unit).toBe('percentOfCanvas')
    expect(Math.max(...t.keys.map((k) => Math.abs(k.v)))).toBeCloseTo(6, 9)
  })
})

describe('resolveParams', () => {
  const preset = MOTION_PRESET_BY_ID.get('slide.inFade')!

  it('빠진 값은 기본값으로 채운다', () => {
    expect(resolveParams(preset, {})).toEqual({ direction: 'left', distance: 10 })
  })

  it('범위를 넘은 숫자는 잘라낸다', () => {
    expect(resolveParams(preset, { distance: 999 }).distance).toBe(40)
    expect(resolveParams(preset, { distance: -5 }).distance).toBe(2)
  })

  it('없는 선택지와 잘못된 타입은 기본값으로 되돌린다', () => {
    expect(resolveParams(preset, { direction: 'diagonal' }).direction).toBe('left')
    expect(resolveParams(preset, { distance: 'far' }).distance).toBe(10)
  })

  it('프리셋이 모르는 키는 버린다', () => {
    expect(resolveParams(preset, { nonsense: 1 })).not.toHaveProperty('nonsense')
  })

  it('applyPreset 은 세기와 속도를 범위 안으로 자른다', () => {
    const clamped = applyPreset(preset, createEmitContext({ strength: 99, speed: 99 }))
    const normal = emit(preset, { strength: 1, speed: 2 })
    expect(clamped).toEqual(normal)
  })
})

// ---------------------------------------------------------------------------
// 레이어 역할
// ---------------------------------------------------------------------------

describe('깊이감 흔들기의 역할 배정', () => {
  const preset = MOTION_PRESET_BY_ID.get('parallax.dual')!

  it('배경과 전경 두 역할을 낸다', () => {
    const e = emit(preset, { layerCount: 2 })
    expect(e.roles?.map((r) => r.role)).toEqual(['background', 'foreground'])
    // 기본 트랙은 배경 역할과 같아야 레이어 한 장짜리 호출부도 그대로 쓸 수 있다.
    expect(e.tracks).toEqual(e.roles![0]!.tracks)
  })

  it('전경은 배경보다 적게, 반대 방향으로 움직인다', () => {
    const e = emit(preset, { layerCount: 2 })
    const bg = e.roles![0]!.tracks.find((t) => t.prop === 'translateX')!
    const fg = e.roles![1]!.tracks.find((t) => t.prop === 'translateX')!
    expect(Math.abs(fg.keys[0]!.v)).toBeLessThan(Math.abs(bg.keys[0]!.v))
    expect(Math.sign(fg.keys[0]!.v)).toBe(-Math.sign(bg.keys[0]!.v))
  })

  it('레이어가 한 장뿐이면 그 사실을 알린다', () => {
    const one = emit(preset, { layerCount: 1 })
    expect((one.notices ?? []).map((n) => n.code)).toContain('needsSecondLayer')
    const two = emit(preset, { layerCount: 2 })
    expect((two.notices ?? []).map((n) => n.code)).not.toContain('needsSecondLayer')
  })
})
