/**
 * 루프 이음새 검사기.
 *
 * 세 종류의 이음새를 각각 만들고, 같은 문서에서 조건 하나만 고치면 경고가
 * 사라지는지까지 확인한다. 검출만 보면 "항상 경고" 로도 통과해 버린다.
 */

import { describe, expect, it } from 'vitest'

import { checkLoopSeam, nearestHoldDivisor, snapDurationToHold } from '@/core/loopSeam.ts'
import { createEmptyProject, createImageLayer, resetIdCounter } from '@/core/factory.ts'
import type { AssetRef, Layer, Modifier, MotionProject, Track } from '@/core/types.ts'

function setup(): { doc: MotionProject; layer: Layer } {
  resetIdCounter()
  const doc = createEmptyProject()
  doc.canvas.w = 512
  doc.canvas.h = 512
  doc.timeline.fps = 25
  doc.timeline.durationFrames = 30
  doc.timeline.loop.mode = 'loop'

  const asset: AssetRef = {
    id: 'a1',
    name: '고양이',
    storeKey: 'k',
    naturalW: 600,
    naturalH: 600,
    hasAlpha: true,
  }
  doc.assets = [asset]
  const layer = createImageLayer(asset, 0)
  doc.layers = [layer]
  return { doc, layer }
}

function modifier(patch: Partial<Modifier>): Modifier {
  return {
    id: 'm1',
    type: 'loopNoise',
    target: 'translateX',
    blendOp: 'add',
    seed: 7,
    amplitude: 2.5,
    cycles: 6,
    octaves: 1,
    persistence: 0.5,
    lacunarity: 2,
    holdFrames: 1,
    decay: 0,
    ...patch,
  }
}

// ---------------------------------------------------------------------------
// 1. 값 불연속
// ---------------------------------------------------------------------------

describe('valueJump', () => {
  /** 마지막 키가 첫 값으로 돌아오지 않는 확대 모션. */
  function zoomTrack(): Track {
    return {
      id: 't1',
      prop: 'scale',
      unit: 'ratio',
      keys: [
        { f: 0, v: 1, interp: 'bezier' },
        { f: 29, v: 1.2, interp: 'bezier' },
      ],
    }
  }

  it('끝 값이 첫 값과 다르면 error 로 잡는다', () => {
    const { doc, layer } = setup()
    layer.tracks = [zoomTrack()]

    const issues = checkLoopSeam(doc)
    expect(issues).toHaveLength(1)
    const issue = issues[0]!
    expect(issue.kind).toBe('valueJump')
    expect(issue.severity).toBe('error')
    expect(issue.prop).toBe('scale')
    expect(issue.layerId).toBe(layer.id)
    expect(issue.fix.kind).toBe('matchFirstKey')
    expect(issue.message).toContain('고양이')
  })

  it('끝 값을 첫 값으로 맞추면 경고가 사라진다', () => {
    const { doc, layer } = setup()
    const track = zoomTrack()
    track.keys = [
      { f: 0, v: 1, interp: 'bezier' },
      { f: 15, v: 1.2, interp: 'bezier' },
      { f: 30, v: 1, interp: 'bezier' },
    ]
    layer.tracks = [track]

    expect(checkLoopSeam(doc)).toHaveLength(0)
  })

  it('왕복은 이음새가 구조적으로 없으므로 검사하지 않는다', () => {
    const { doc, layer } = setup()
    layer.tracks = [zoomTrack()]
    doc.timeline.loop.mode = 'pingPong'

    expect(checkLoopSeam(doc)).toHaveLength(0)
  })

  it('회전 0 -> 360 은 같은 자세이므로 값 불연속이 아니다', () => {
    const { doc, layer } = setup()
    layer.tracks = [
      {
        id: 't2',
        prop: 'rotate',
        unit: 'deg',
        keys: [
          { f: 0, v: 0, interp: 'linear' },
          { f: 30, v: 360, interp: 'linear' },
        ],
      },
    ]

    expect(checkLoopSeam(doc).filter((i) => i.kind === 'valueJump')).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// 2. 속도 불연속
// ---------------------------------------------------------------------------

describe('speedJump', () => {
  /** 한 바퀴 회전. 이징에 따라 이음새가 갈린다. */
  function spinTrack(keys: Track['keys']): Track {
    return { id: 't3', prop: 'rotate', unit: 'deg', keys }
  }

  it('무한 회전에 감속 이징을 걸면 매 바퀴 급가속이 반복된다', () => {
    const { doc, layer } = setup()
    // easeOutExpo: 시작 기울기 1/0.16 = 6.25, 끝 기울기 0
    layer.tracks = [
      spinTrack([
        { f: 0, v: 0, interp: 'bezier', out: { x: 0.16, y: 1 } },
        { f: 30, v: 360, interp: 'bezier', in: { x: 0.3, y: 1 } },
      ]),
    ]

    const issues = checkLoopSeam(doc)
    expect(issues).toHaveLength(1)
    const issue = issues[0]!
    expect(issue.kind).toBe('speedJump')
    expect(issue.severity).toBe('warn')
    expect(issue.prop).toBe('rotate')
    expect(issue.fix.kind).toBe('makeLinear')
  })

  it('등속이면 값도 속도도 이어진다', () => {
    const { doc, layer } = setup()
    layer.tracks = [
      spinTrack([
        { f: 0, v: 0, interp: 'linear' },
        { f: 30, v: 360, interp: 'linear' },
      ]),
    ]

    expect(checkLoopSeam(doc)).toHaveLength(0)
  })

  it('값이 튀는 트랙에는 속도 경고를 겹쳐 내지 않는다', () => {
    const { doc, layer } = setup()
    layer.tracks = [
      {
        id: 't4',
        prop: 'translateX',
        unit: 'px',
        keys: [
          { f: 0, v: 0, interp: 'bezier', out: { x: 0.16, y: 1 } },
          { f: 30, v: 120, interp: 'bezier', in: { x: 0.3, y: 1 } },
        ],
      },
    ]

    const issues = checkLoopSeam(doc)
    expect(issues).toHaveLength(1)
    expect(issues[0]!.kind).toBe('valueJump')
  })
})

// ---------------------------------------------------------------------------
// 3. 홀드 어긋남
// ---------------------------------------------------------------------------

describe('holdMisaligned', () => {
  it('홀드가 전체 길이를 나누지 못하면 마지막 블록이 잘린다', () => {
    const { doc, layer } = setup()
    doc.timeline.durationFrames = 30
    layer.modifiers = [modifier({ holdFrames: 4 })]

    const issues = checkLoopSeam(doc)
    expect(issues).toHaveLength(1)
    const issue = issues[0]!
    expect(issue.kind).toBe('holdMisaligned')
    expect(issue.prop).toBe('translateX')
    expect(issue.fix.kind).toBe('snapDuration')
    // 30 -> 32 프레임 스냅, 또는 홀드를 30 의 약수인 3 으로
    expect(issue.fix.detail).toContain('32프레임')
    expect(issue.fix.detail).toContain('홀드를 3프레임')
  })

  it('나누어떨어지면 경고가 없다', () => {
    const { doc, layer } = setup()
    doc.timeline.durationFrames = 32
    layer.modifiers = [modifier({ holdFrames: 4 })]

    expect(checkLoopSeam(doc)).toHaveLength(0)
  })

  it('홀드 1 이하는 매 프레임 갱신이라 잘릴 블록이 없다', () => {
    const { doc, layer } = setup()
    doc.timeline.durationFrames = 30
    layer.modifiers = [modifier({ holdFrames: 1 })]

    expect(checkLoopSeam(doc)).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// 수정 제안 계산
// ---------------------------------------------------------------------------

describe('수정 제안', () => {
  it('snapDurationToHold 는 위쪽 배수로 올린다', () => {
    expect(snapDurationToHold(30, 4)).toBe(32)
    expect(snapDurationToHold(32, 4)).toBe(32)
  })

  it('상한을 넘으면 아래쪽 배수로 내린다', () => {
    // FRAMES_MAX = 120. 118 을 9 로 맞추면 위쪽 배수 126 이 상한을 넘는다.
    expect(snapDurationToHold(118, 9)).toBe(117)
  })

  it('nearestHoldDivisor 는 길이를 유지하는 대안을 준다', () => {
    expect(nearestHoldDivisor(30, 4)).toBe(3)
    expect(nearestHoldDivisor(32, 5)).toBe(4)
    expect(30 % nearestHoldDivisor(30, 7)).toBe(0)
  })
})
