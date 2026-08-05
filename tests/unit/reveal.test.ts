/**
 * 가리기와 입체 회전.
 *
 * 두 기능 모두 최종 판정이 셰이더 안에서 나므로 여기서는 **셰이더에 들어가기 전까지**
 * 를 잠근다. 값 규칙, 매트릭스, 문서 왕복, 프리셋 소유권 네 가지다. 셰이더 자체는
 * 문자열 규칙(effects.test.ts 와 shapes.test.ts)이 따로 검사한다.
 */

import { describe, expect, it } from 'vitest'

import {
  PERSPECTIVE_DEFAULT,
  REVEAL_MODE_LIST,
  SHAPE_KIND_LIST,
  type Layer,
} from '@/core/types.ts'
import {
  REVEAL_LIMITS,
  REVEAL_MODE_CODE,
  REVEAL_MODE_LABELS,
  createRevealSpec,
  normalizeRevealSpec,
  revealIsActive,
} from '@/core/reveal.ts'
import { SHAPE_KIND_LABELS, createShapeSpec, normalizeShapeSpec } from '@/core/shape.ts'
import { SHAPE_FS, SHAPE_KIND_CODE } from '@/core/renderer/shaders/shape.ts'
import { REVEAL_GLSL } from '@/core/renderer/shaders/reveal.ts'
import { LAYER_FS, LAYER_VS } from '@/core/renderer/shaders/layer.ts'
import { TEXT_FS } from '@/core/renderer/shaders/text.ts'
import { buildLayerMatrix, identityTransform, mat3Perspective, type Mat3 } from '@/core/transform.ts'
import { createEmptyProject, createShapeLayer } from '@/core/factory.ts'
import { requiredScaleAt } from '@/core/overscan.ts'
import { migrateProject } from '@/project/migrate.ts'
import { MOTION_PRESET_BY_ID, applyPreset } from '@/motions/registry.ts'
import {
  mergePresetAnchor,
  mergePresetPerspective,
  mergePresetReveal,
  ownershipOf,
} from '@/motions/merge.ts'
import { SHAPE_SCENES, buildShapeScene, createSceneContext } from '@/shapes/registry.ts'
import { checkLoopSeam } from '@/core/loopSeam.ts'
import type { EmitContext } from '@/motions/types.ts'

// ---------------------------------------------------------------------------
// 값 규칙
// ---------------------------------------------------------------------------

describe('가리기 값 규칙', () => {
  it('모르는 값이 들어와도 그릴 수 있는 가리기가 된다', () => {
    const bad = normalizeRevealSpec({
      mode: '없는모양' as never,
      softness: 99,
      slats: -4,
      angle: 9999,
      invert: 'yes' as never,
    })
    expect(bad.mode).toBe('none')
    expect(bad.softness).toBeLessThanOrEqual(REVEAL_LIMITS.softness.max)
    expect(bad.slats).toBeGreaterThanOrEqual(REVEAL_LIMITS.slats.min)
    expect(bad.angle).toBeLessThanOrEqual(REVEAL_LIMITS.angle.max)
    // 불리언이 아닌 값은 전부 꺼짐이다. 켜진 채로 열리면 그림이 반대로 잘린다.
    expect(bad.invert).toBe(false)
  })

  it('모든 모양에 이름과 셰이더 코드가 있다', () => {
    for (const mode of REVEAL_MODE_LIST) {
      expect(REVEAL_MODE_LABELS[mode], mode).toBeTruthy()
      expect(REVEAL_MODE_LABELS[mode]).not.toMatch(/[a-zA-Z]/)
      expect(REVEAL_MODE_CODE[mode], mode).toBe(REVEAL_MODE_LIST.indexOf(mode))
    }
    // 코드가 겹치면 사용자가 A 를 고르고 B 가 그려진다.
    expect(new Set(Object.values(REVEAL_MODE_CODE)).size).toBe(REVEAL_MODE_LIST.length)
  })

  it("'없음' 은 가리기가 아니다", () => {
    expect(revealIsActive(undefined)).toBe(false)
    expect(revealIsActive(createRevealSpec('none'))).toBe(false)
    expect(revealIsActive(createRevealSpec('iris'))).toBe(true)
  })

  it('셰이더가 모양 코드를 전부 분기한다', () => {
    // 코드가 늘었는데 셰이더에 분기가 없으면 그 모양은 조용히 아무것도 안 가린다.
    for (const mode of REVEAL_MODE_LIST) {
      if (mode === 'none') continue
      expect(REVEAL_GLSL, mode).toContain(`u_revealMode == ${REVEAL_MODE_CODE[mode]}`)
    }
  })

  it('마스크가 레이어 셰이더의 알파에 곱해진다', () => {
    // 곱하는 자리를 놓치면 인스펙터에서는 값이 바뀌는데 화면은 그대로다.
    expect(LAYER_FS).toContain('mmRevealMask(v_uv)')
    expect(LAYER_FS).toContain('u_revealMode')
  })

  it('공유 조각이 남의 이름을 두 번 선언하지 않는다', () => {
    /*
     * REVEAL_GLSL 은 **세 셰이더에 통째로 삽입된다.** 그 안에서 선언한 이름이 받는
     * 쪽에도 있으면 GLSL 은 재정의 오류로 컴파일을 거부하고, 그 레이어 종류가
     * 통째로 안 그려진다. 화면이 비는 것 말고는 아무 신호가 없어 원인을 찾기 어렵다.
     *
     * 실제로 부채 모양을 넣으며 MM_PI 를 선언했다가 도형 셰이더와 부딪혔다.
     * 타입 검사도 단위 테스트도 잡지 못하고 브라우저에서만 드러났다.
     */
    const declarations = (src: string): string[] => {
      const out: string[] = []
      // `const float NAME =` 와 `float NAME(` 두 형태만 본다. 유니폼은 접두사로 갈린다.
      for (const m of src.matchAll(/^\s*const\s+\w+\s+(\w+)\s*=/gm)) out.push(m[1]!)
      for (const m of src.matchAll(/^\s*\w+\s+(\w+)\s*\([^)]*\)\s*\{/gm)) out.push(m[1]!)
      return out
    }
    for (const [name, src] of [
      ['도형', SHAPE_FS],
      ['이미지', LAYER_FS],
      ['글자', TEXT_FS],
    ] as const) {
      const all = declarations(src)
      const dupes = all.filter((id, i) => all.indexOf(id) !== i)
      expect(dupes, `${name} 셰이더에서 이름이 겹친다`).toEqual([])
    }
  })
})

// ---------------------------------------------------------------------------
// 새 도형
// ---------------------------------------------------------------------------

describe('새 도형 세 종', () => {
  it('세 종이 카탈로그와 셰이더 양쪽에 있다', () => {
    for (const kind of ['burst', 'ticks', 'sparkle'] as const) {
      expect(SHAPE_KIND_LIST).toContain(kind)
      expect(SHAPE_KIND_LABELS[kind]).toBeTruthy()
      expect(SHAPE_KIND_CODE[kind], kind).toBeTypeOf('number')
    }
    // 종류마다 코드가 하나씩이어야 한다.
    expect(new Set(Object.values(SHAPE_KIND_CODE)).size).toBe(SHAPE_KIND_LIST.length)
    for (const kind of SHAPE_KIND_LIST) expect(SHAPE_KIND_CODE[kind], kind).toBeTypeOf('number')
  })

  it('방사살은 살 굵기가 0 이 아닌 채로 만들어진다', () => {
    // 0 이면 아무것도 안 보인다. "넣었는데 화면에 없다" 가 된다.
    expect(createShapeSpec('burst').strokeWidth).toBeGreaterThan(0)
  })

  it('방사살의 살 굵기는 짧은 변의 절반에 걸리지 않는다', () => {
    // 그 상한은 "테두리가 도형을 통째로 메우는 지점" 이라 살 굵기에는 뜻이 없다.
    const wide = createShapeSpec('burst', { width: 400, height: 40, strokeWidth: 120 })
    expect(wide.strokeWidth).toBe(120)
    // 테두리로 쓰는 종류는 여전히 절반에서 끊긴다.
    const ring = createShapeSpec('circle', { width: 400, height: 40, strokeWidth: 120 })
    expect(ring.strokeWidth).toBe(20)
  })

  it('살과 눈금은 열두 개를 넘길 수 있다', () => {
    expect(createShapeSpec('burst', { points: 24 }).points).toBe(24)
    expect(createShapeSpec('ticks', { points: 30 }).points).toBe(30)
  })
})

// ---------------------------------------------------------------------------
// 입체 회전
// ---------------------------------------------------------------------------

describe('입체 회전', () => {
  const persp = (m: Mat3, u: number, v: number): [number, number] => {
    const w = m[2]! * u + m[5]! * v + m[8]!
    return [(m[0]! * u + m[3]! * v + m[6]!) / w, (m[1]! * u + m[4]! * v + m[7]!) / w]
  }

  it('회전이 0 이면 매트릭스가 항등이다', () => {
    // 이게 깨지면 옛 문서의 픽셀이 바뀐다.
    const m = mat3Perspective(0, 0, 800)
    expect([...m]).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1])
  })

  it('회전이 0 이면 마지막 행이 그대로다', () => {
    const t = identityTransform()
    const m = buildLayerMatrix(t, 'none', 500, 500, 200, 200)
    expect(m[2]).toBe(0)
    expect(m[5]).toBe(0)
    expect(m[8]).toBe(1)
  })

  it('세로축 회전은 오른쪽 변을 뒤로 보낸다', () => {
    // 부호는 CSS 의 rotateY 와 같다. 양수면 오른쪽이 멀어진다.
    const t = { ...identityTransform(), rotateY: 60 }
    const m = buildLayerMatrix(t, 'none', 500, 500, 200, 200)

    const leftTop = persp(m, 0, 0)
    const leftBottom = persp(m, 0, 1)
    const rightTop = persp(m, 1, 0)
    const rightBottom = persp(m, 1, 1)

    const leftH = Math.abs(leftBottom[1] - leftTop[1])
    const rightH = Math.abs(rightBottom[1] - rightTop[1])
    // 가까운 변이 더 크다. 사다리꼴이 아니면 원근이 안 걸린 것이다.
    expect(leftH).toBeGreaterThan(rightH * 1.1)
  })

  it('원근 0 이면 사다리꼴이 아니라 눌린 직사각형이다', () => {
    const t = { ...identityTransform(), rotateY: 60, perspective: 0 }
    const m = buildLayerMatrix(t, 'none', 500, 500, 200, 200)

    const leftH = Math.abs(persp(m, 0, 1)[1] - persp(m, 0, 0)[1])
    const rightH = Math.abs(persp(m, 1, 1)[1] - persp(m, 1, 0)[1])
    expect(leftH).toBeCloseTo(rightH, 6)
    // 폭은 cos(60도) = 0.5 만큼 눌린다.
    const width = Math.abs(persp(m, 1, 0)[0] - persp(m, 0, 0)[0])
    expect(width).toBeCloseTo(200 * Math.cos((60 * Math.PI) / 180), 4)
  })

  it('네 꼭짓점 모두 카메라 앞에 있다', () => {
    // w 가 0 을 지나면 쿼드가 화면 전체로 찢어진다. 각도를 아무리 밀어도 막혀야 한다.
    for (const deg of [45, 80, 89.9, -89.9, 120, 200, 359]) {
      for (const t of [
        { ...identityTransform(), rotateY: deg, perspective: 0.01 },
        { ...identityTransform(), rotateX: deg, perspective: 0.01 },
      ]) {
        const m = buildLayerMatrix(t, 'none', 500, 500, 200, 200)
        for (const [u, v] of [[0, 0], [1, 0], [0, 1], [1, 1]] as [number, number][]) {
          const w = m[2]! * u + m[5]! * v + m[8]!
          expect(w, `${deg}도에서 w=${w}`).toBeGreaterThan(0)
        }
      }
    }
  })

  it('오버스캔은 입체 회전에서 더 큰 배율을 요구한다', () => {
    const flat = requiredScaleAt(500, 500, 600, 600, identityTransform())
    const turned = requiredScaleAt(500, 500, 600, 600, {
      ...identityTransform(),
      rotateY: 60,
    })
    // 돌면 화면에 닿는 폭이 줄어드니 더 키워야 캔버스가 찬다.
    expect(turned).toBeGreaterThan(flat)
    // 회전이 없으면 예전 계산과 한 자리도 다르지 않아야 한다.
    expect(requiredScaleAt(500, 500, 600, 600, identityTransform())).toBe(flat)
  })
})

// ---------------------------------------------------------------------------
// 저장 / 열기
// ---------------------------------------------------------------------------

describe('문서 왕복', () => {
  function docWith(patch: Partial<Layer>) {
    const doc = createEmptyProject()
    const layer = createShapeLayer(createShapeSpec('rect'), '판', 0)
    doc.layers = [{ ...layer, ...patch }]
    return doc
  }

  it('가리기와 원근이 저장하고 열어도 그대로다', () => {
    const doc = docWith({
      reveal: createRevealSpec('blinds', { slats: 12, softness: 0.2, invert: true }),
      perspective: 3.5,
    })
    const back = migrateProject(JSON.parse(JSON.stringify(doc)))
    expect(back.warnings).toEqual([])
    expect(back.doc.layers[0]!.reveal).toEqual(doc.layers[0]!.reveal)
    expect(back.doc.layers[0]!.perspective).toBe(3.5)
  })

  it('가리기가 없는 문서에는 키가 생기지 않는다', () => {
    // 빈 키가 붙으면 왕복에서 JSON 이 달라져 "한 글자도 바꾸지 않는다" 가 깨진다.
    const doc = docWith({})
    const back = migrateProject(JSON.parse(JSON.stringify(doc)))
    expect('reveal' in back.doc.layers[0]!).toBe(false)
    expect('perspective' in back.doc.layers[0]!).toBe(false)
    expect(JSON.stringify(back.doc)).toBe(JSON.stringify(doc))
  })

  it('망가진 가리기 값도 던지지 않고 복구된다', () => {
    const raw = JSON.parse(JSON.stringify(docWith({}))) as Record<string, unknown>
    const layers = raw['layers'] as Record<string, unknown>[]
    layers[0]!['reveal'] = { mode: 'clock', softness: 'x', slats: null, angle: NaN }
    layers[0]!['perspective'] = -5
    const back = migrateProject(raw)
    expect(back.doc.layers[0]!.reveal!.mode).toBe('clock')
    expect(Number.isFinite(back.doc.layers[0]!.reveal!.softness)).toBe(true)
    // 음수 거리는 뜻이 없다. 없는 것으로 보고 기본값으로 돌아간다.
    expect(back.doc.layers[0]!.perspective).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 프리셋 소유권
// ---------------------------------------------------------------------------

describe('프리셋이 내는 가리기와 원근', () => {
  const ctx = (): EmitContext => ({
    durationFrames: 30,
    fps: 25,
    canvasW: 512,
    canvasH: 512,
    strength: 0.5,
    speed: 1,
    params: {},
    seed: 1,
  })

  it('가리기 프리셋은 모양과 진행률 트랙을 함께 낸다', () => {
    for (const id of ['reveal.wipeIn', 'reveal.doorIn', 'reveal.irisIn', 'reveal.blindsIn']) {
      const preset = MOTION_PRESET_BY_ID.get(id)!
      const e = applyPreset(preset, ctx())
      // 모양만 있고 진행률이 없으면 아무 일도 안 일어난다. 그 반대도 마찬가지다.
      expect(e.reveal, id).toBeDefined()
      expect(e.reveal!.mode, id).not.toBe('none')
      expect(e.tracks.some((t) => t.prop === 'reveal'), id).toBe(true)
    }
  })

  it('진행률은 세기와 무관하게 언제나 0 에서 1 까지 간다', () => {
    // 세기로 진행률을 줄이면 "약하게 했더니 절반만 드러난 채로 끝난다" 가 된다.
    for (const strength of [0, 0.5, 1]) {
      const e = applyPreset(MOTION_PRESET_BY_ID.get('reveal.wipeIn')!, { ...ctx(), strength })
      const t = e.tracks.find((x) => x.prop === 'reveal')!
      expect(t.keys[0]!.v).toBe(0)
      expect(t.keys[t.keys.length - 1]!.v).toBe(1)
    }
  })

  it('입체 프리셋은 원근 거리를 함께 낸다', () => {
    for (const id of ['flip3d.cardIn', 'flip3d.unfoldIn', 'flip3d.cardOut', 'flip3d.turn']) {
      const preset = MOTION_PRESET_BY_ID.get(id)!
      const e = applyPreset(preset, ctx())
      expect(e.perspective, id).toBeGreaterThan(0)
      expect(e.tracks.some((t) => t.prop === 'rotateX' || t.prop === 'rotateY'), id).toBe(true)
    }
  })

  it('가리기를 쓰지 않는 프리셋은 모양을 내지 않는다', () => {
    // 호출부가 값이 없으면 지운다. 여기서 내면 앞 프리셋의 경계선이 계속 남는다.
    for (const id of ['zoom.pop', 'fade.in', 'shake.camera', 'flip3d.cardIn']) {
      expect(applyPreset(MOTION_PRESET_BY_ID.get(id)!, ctx()).reveal, id).toBeUndefined()
    }
  })

  it('원근을 쓰지 않는 프리셋은 거리를 내지 않는다', () => {
    for (const id of ['zoom.pop', 'reveal.wipeIn', 'reveal.clockDraw']) {
      expect(applyPreset(MOTION_PRESET_BY_ID.get(id)!, ctx()).perspective, id).toBeUndefined()
    }
  })

  it('원근 기본값은 문서에 적히지 않는다', () => {
    // 기본값을 적어 두면 나중에 기본값을 바꿔도 옛 문서가 안 따라온다.
    expect(identityTransform().perspective).toBe(PERSPECTIVE_DEFAULT)
    expect(createShapeLayer(createShapeSpec('rect'), '판', 0).perspective).toBeUndefined()
  })

  it('정점 셰이더가 원근 나눗셈을 한다', () => {
    // 이 한 줄이 빠지면 호모그래피가 어파인처럼 그려져 사다리꼴이 안 나온다.
    expect(LAYER_VS).toContain('vec4(p.xy, 0.0, p.z)')
  })
})

// ---------------------------------------------------------------------------
// 경첩 (기준점 소유권)
// ---------------------------------------------------------------------------

describe('경첩 프리셋이 옮기는 기준점', () => {
  const ctx = (params: Record<string, string | number> = {}): EmitContext => ({
    durationFrames: 30,
    fps: 25,
    canvasW: 512,
    canvasH: 512,
    strength: 0.5,
    speed: 1,
    params,
    seed: 1,
  })

  it('고정되는 변마다 기준점과 회전축이 짝지어진다', () => {
    /*
     * 축이 어긋나면 "위쪽이 고정" 을 골랐는데 문이 옆으로 돈다. 두 값은 반드시
     * 함께 정해져야 한다. 위아래 경첩은 가로축(rotateX), 좌우 경첩은 세로축(rotateY)이다.
     */
    const table: [string, [number, number], 'rotateX' | 'rotateY'][] = [
      ['top', [0.5, 0], 'rotateX'],
      ['bottom', [0.5, 1], 'rotateX'],
      ['left', [0, 0.5], 'rotateY'],
      ['right', [1, 0.5], 'rotateY'],
    ]
    for (const [hinge, anchor, prop] of table) {
      const e = applyPreset(MOTION_PRESET_BY_ID.get('flip3d.hingeIn')!, ctx({ hinge }))
      expect(e.anchor, hinge).toEqual(anchor)
      expect(e.tracks.some((t) => t.prop === prop), hinge).toBe(true)
      // 다른 축은 건드리지 않는다. 둘 다 돌면 문이 아니라 종이비행기가 된다.
      const other = prop === 'rotateX' ? 'rotateY' : 'rotateX'
      expect(e.tracks.some((t) => t.prop === other), hinge).toBe(false)
    }
  })

  it('회전은 언제나 0 으로 끝난다', () => {
    // 끝값이 0 이 아니면 문이 반쯤 열린 채로 굳는다. 세기와 무관해야 한다.
    for (const strength of [0, 0.5, 1]) {
      const e = applyPreset(MOTION_PRESET_BY_ID.get('flip3d.hingeIn')!, { ...ctx(), strength })
      const rot = e.tracks.find((t) => t.prop === 'rotateX' || t.prop === 'rotateY')!
      expect(rot.keys[rot.keys.length - 1]!.v).toBe(0)
      expect(Math.abs(rot.keys[0]!.v)).toBeGreaterThan(0)
    }
  })

  it('기준점을 쓰지 않는 프리셋은 값을 내지 않는다', () => {
    // 값이 없으면 호출부가 한가운데로 되돌린다. 여기서 내면 앞 프리셋의 축이 남는다.
    for (const id of ['zoom.pop', 'flip3d.cardIn', 'reveal.wipeIn', 'reveal.inkIn']) {
      expect(applyPreset(MOTION_PRESET_BY_ID.get(id)!, ctx()).anchor, id).toBeUndefined()
    }
  })

  it('부채는 아래 가운데를 축으로 삼는다', () => {
    // 한복판을 기준으로 커지면 펼쳐지는 동안 손잡이가 위아래로 흔들린다.
    const e = applyPreset(MOTION_PRESET_BY_ID.get('reveal.fanIn')!, ctx())
    expect(e.anchor).toEqual([0.5, 1])
    expect(e.reveal!.mode).toBe('fan')
  })

  it('앞 프리셋이 옮긴 기준점만 한가운데로 되돌린다', () => {
    const mine = ownershipOf({ id: 'x', macro: { speed: 1, strength: 0.5 }, dirty: false, ownsAnchor: true })
    const users = ownershipOf({ id: 'x', macro: { speed: 1, strength: 0.5 }, dirty: false })

    // 새 값이 있으면 언제나 그 값이다.
    expect(mergePresetAnchor([0.2, 0.3], [0.5, 0], mine)).toEqual([0.5, 0])
    expect(mergePresetAnchor([0.2, 0.3], [0.5, 0], users)).toEqual([0.5, 0])
    // 값이 없을 때만 갈린다. 앞 프리셋 것은 지우고 사용자가 옮긴 것은 살린다.
    expect(mergePresetAnchor([0, 0.5], undefined, mine)).toEqual([0.5, 0.5])
    expect(mergePresetAnchor([0.2, 0.3], undefined, users)).toEqual([0.2, 0.3])
  })

  it('소유 표식이 저장 왕복에서 살아남는다', () => {
    /*
     * 이 표식이 사라지면 프리셋이 옮긴 기준점이 "사용자가 옮긴 것" 으로 승격되어
     * 다음 프리셋을 눌러도 축이 그대로 남는다. 문이 엉뚱한 변을 축으로 돈다.
     */
    const before = createEmptyProject()
    before.presetRef = {
      id: 'flip3d.hingeIn',
      macro: { speed: 1, strength: 0.5 },
      dirty: false,
      ownsAnchor: true,
      ownsCharAnim: true,
    }
    const { doc, warnings } = migrateProject(JSON.parse(JSON.stringify(before)) as unknown)
    expect(warnings).toEqual([])
    expect(doc.presetRef?.ownsAnchor).toBe(true)
    expect(doc.presetRef?.ownsCharAnim).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 적대적 검증에서 잡힌 것들
// ---------------------------------------------------------------------------

describe('가리기 마스크의 불변식', () => {
  /**
   * 셰이더를 그대로 옮긴 참조 구현.
   *
   * GLSL 을 node 에서 돌릴 수 없으니 같은 식을 여기 한 번 더 적는다. 두 벌이 갈리지
   * 않게 아래 첫 번째 검사가 셰이더 문자열에 이 식이 실제로 들어 있는지 확인한다.
   */
  const smoothstep = (e0: number, e1: number, x: number): number => {
    const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)))
    return t * t * (3 - 2 * t)
  }

  function mask(field: number, progress: number, softness: number, invert: boolean): number {
    let g = field
    if (invert) g = 1 - g
    const w = Math.max(Math.min(Math.max(softness, 0), 1) * 0.5, 1e-4)
    const tt = progress * (1 + 2 * w) - w
    return smoothstep(g - w, g + w, tt)
  }

  it('셰이더가 진행률이 아니라 필드를 뒤집는다', () => {
    // t = 1.0 - t 로 되돌아가면 뒤집기가 '되감기' 가 되어 계약이 깨진다.
    expect(REVEAL_GLSL).toContain('g = 1.0 - g')
    expect(REVEAL_GLSL).not.toContain('t = 1.0 - t')
  })

  it('진행률 0 은 완전히 가려지고 1 은 전부 보인다', () => {
    for (const softness of [0, 0.02, 0.5, 1]) {
      for (const invert of [false, true]) {
        for (const field of [0, 0.25, 0.5, 0.75, 1]) {
          expect(mask(field, 0, softness, invert), `soft=${softness} g=${field}`).toBe(0)
          expect(mask(field, 1, softness, invert), `soft=${softness} g=${field}`).toBe(1)
        }
      }
    }
  })

  it('뒤집기는 어느 쪽이 먼저 드러나는지를 바꾼다', () => {
    // 되감기라면 두 값이 같다. 방향이 바뀌어야 서로 여집합이 된다.
    const left = mask(0.2, 0.5, 0, false)
    const right = mask(0.2, 0.5, 0, true)
    expect(left).toBe(1)
    expect(right).toBe(0)
  })

  it('진행률 트랙이 없어도 뒤집기만으로 사라지지 않는다', () => {
    // reveal 의 항등값은 1 이다. 뒤집기가 그 계약을 뒤집으면 안 된다.
    for (const field of [0, 0.5, 1]) expect(mask(field, 1, 0.1, true)).toBe(1)
  })
})

describe('원근 오버스캔', () => {
  const at = (rotateX: number, rotateY: number, extra: Record<string, number> = {}) => ({
    ...identityTransform(),
    rotateX,
    rotateY,
    ...extra,
  })

  it('한 축만 돌면 예전 식(cos)과 같은 값을 준다', () => {
    // 이 등식이 깨지면 기존 프리셋의 오버스캔이 조용히 달라진다.
    for (const deg of [15, 45, 60, 80]) {
      const flat = requiredScaleAt(500, 500, 600, 600, identityTransform())
      const turned = requiredScaleAt(500, 500, 600, 600, at(0, deg, { perspective: 0 }))
      expect(turned / flat, `${deg}도`).toBeCloseTo(1 / Math.cos((deg * Math.PI) / 180), 6)
    }
  })

  it('두 축이 동시에 돌면 전단항까지 반영한다', () => {
    // min(cos) 만 보면 60/60 에서 2 를 주는데 실제로 필요한 것은 4 다.
    const flat = requiredScaleAt(500, 500, 600, 600, identityTransform())
    const both = requiredScaleAt(500, 500, 600, 600, at(60, 60, { perspective: 0 }))
    expect(both / flat).toBeCloseTo(4, 4)
  })

  it('기준점이 가장자리면 더 큰 배율을 요구한다', () => {
    // 로컬 좌표가 한쪽으로 두 배 뻗으므로 원근 축소도 그만큼 세다.
    const center = requiredScaleAt(500, 500, 600, 600, at(0, 45))
    const edge = requiredScaleAt(500, 500, 600, 600, at(0, 45, { anchorX: 0 }))
    expect(edge).toBeGreaterThan(center)
  })
})

describe('기준점이 가장자리여도 카메라 뒤로 넘어가지 않는다', () => {
  it('어떤 기준점 / 각도 / 원근 조합에서도 네 꼭짓점의 w 가 양수다', () => {
    /*
     * w 가 0 을 지나면 근평면에서 잘린 모서리가 무한대로 늘어나 화면 전체를 덮는다.
     * 인스펙터의 원근 거리는 0.5 까지 내려가고 기준점은 3x3 어디든 고를 수 있으므로
     * 그 곱집합 전체가 도달 가능한 입력이다.
     */
    for (const ax of [0, 0.5, 1]) {
      for (const ay of [0, 0.5, 1]) {
        for (const rx of [-89, -45, 0, 45, 89, 137]) {
          for (const ry of [-89, -45, 0, 45, 89, 137]) {
            for (const persp of [0.5, 1, 2.5, 20]) {
              const m = buildLayerMatrix(
                { ...identityTransform(), rotateX: rx, rotateY: ry, perspective: persp, anchorX: ax, anchorY: ay },
                'none',
                500,
                500,
                400,
                240,
              )
              for (const [u, v] of [[0, 0], [1, 0], [0, 1], [1, 1]] as [number, number][]) {
                const w = m[2]! * u + m[5]! * v + m[8]!
                expect(w, `anchor=${ax},${ay} rx=${rx} ry=${ry} p=${persp}`).toBeGreaterThan(0)
              }
            }
          }
        }
      }
    }
  })
})

describe('소유권', () => {
  const spec = createRevealSpec('blinds', { slats: 7 })

  it('사용자가 만든 가리기는 프리셋을 갈아타도 남는다', () => {
    // 인스펙터에서 직접 만든 값이라 presetRef 가 소유하지 않는다.
    const owned = ownershipOf({ id: 'zoom.pop', macro: { speed: 1, strength: 0.5 }, dirty: true })
    expect(mergePresetReveal(spec, undefined, owned)).toBe(spec)
    expect(mergePresetPerspective(4, undefined, owned)).toBe(4)
  })

  it('앞 프리셋이 심은 가리기는 걷어낸다', () => {
    const owned = ownershipOf({
      id: 'reveal.wipeIn',
      macro: { speed: 1, strength: 0.5 },
      dirty: false,
      ownsReveal: true,
      ownsPerspective: true,
    })
    expect(mergePresetReveal(spec, undefined, owned)).toBeUndefined()
    expect(mergePresetPerspective(4, undefined, owned)).toBeUndefined()
  })

  it('새 프리셋이 내는 값이 언제나 이긴다', () => {
    const next = createRevealSpec('iris')
    const owned = ownershipOf(undefined)
    expect(mergePresetReveal(spec, next, owned)).toBe(next)
    expect(mergePresetPerspective(4, 2, owned)).toBe(2)
  })
})

describe('도형 값 규칙 보강', () => {
  it('종류만 방사살로 바꿔도 살이 보인다', () => {
    // 다른 종류에서 굵기 0(꽉 찬 도형)으로 두었다가 종류만 바꾸는 경로다.
    const filled = createShapeSpec('circle', { strokeWidth: 0 })
    const turned = normalizeShapeSpec({ ...filled, kind: 'burst' })
    expect(turned.strokeWidth).toBeGreaterThan(0)
  })
})

describe('연출 세트는 반복 이음새가 없다', () => {
  it('열 종 모두 마지막 프레임 다음이 첫 프레임과 이어진다', () => {
    /*
     * 이 묶음은 전부 loop 이고 재생기는 마지막 프레임 다음에 0 프레임을 잇는다
     * (core/time.ts). 다 그려진 채로 끝나는 레이어가 하나라도 있으면 그 자리에서
     * 화면이 튄다. 실제로 둘레가 그려진 채 끝나던 세트가 셋 있었다.
     *
     * 사람 눈으로 판정하지 않고 제품이 이미 쓰는 이음새 검사기에 그대로 물린다.
     */
    for (const scene of SHAPE_SCENES.filter((x) => x.group === 'stage')) {
      const out = buildShapeScene(scene.id, createSceneContext())!
      const doc = createEmptyProject()
      doc.timeline.durationFrames = out.durationFrames
      doc.timeline.fps = out.fps
      doc.timeline.loop = { ...doc.timeline.loop, mode: 'loop' }
      doc.layers = out.layers.map((input, i) => {
        const layer = createShapeLayer(input.shape, input.name, i)
        layer.tracks = input.tracks
        return layer
      })

      const jumps = checkLoopSeam(doc).filter((issue) => issue.kind === 'valueJump')
      expect(jumps.map((j) => j.message), scene.id).toEqual([])
    }
  })
})

describe('입체 프리셋의 오버스캔 정책', () => {
  it('다섯 종 모두 솔버를 끈다', () => {
    // required 로 두면 90도 근처에서 원본을 스무 배까지 확대한다.
    for (const id of ['flip3d.cardIn', 'flip3d.unfoldIn', 'flip3d.cardOut', 'flip3d.turn', 'flip3d.sway']) {
      expect(MOTION_PRESET_BY_ID.get(id)!.overscan, id).toBe('allowEmpty')
    }
  })
})
