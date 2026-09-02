/**
 * 레이어별 모션 반복 방식 (motionLoop).
 *
 * 지키는 것은 네 가지다.
 *   1. 키가 없으면(기본 'repeat') 옛 문서의 값이 한 점도 바뀌지 않는다.
 *   2. pingPong 은 한 주기 안에서 갔다가 되돌아오고, 주기 경계 값이 시작 값과 같다.
 *   3. once 는 첫 주기만 돌고 트랙 끝 값에 멈춘다.
 *   4. 'repeat' 는 키를 만들지 않는다 (JSON 왕복 결정론).
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { resolveLayerTransform } from '@/core/evaluate.ts'
import {
  createEmptyProject,
  createImageLayer,
  resetIdCounter,
} from '@/core/factory.ts'
import type { AssetRef, Layer, MotionProject } from '@/core/types.ts'
import { migrateProject } from '@/project/migrate.ts'
import { useDocumentStore } from '@/state/document.ts'

const s = () => useDocumentStore.getState()

const DURATION = 20

function baseDoc(): MotionProject {
  resetIdCounter()
  const doc = createEmptyProject()
  doc.canvas.w = 500
  doc.canvas.h = 500
  doc.timeline.durationFrames = DURATION
  const ref: AssetRef = {
    id: 'a1', name: 'x', storeKey: 'k', naturalW: 100, naturalH: 100, hasAlpha: true,
  }
  doc.assets.push(ref)
  doc.layers.push(createImageLayer(ref, 0))
  return doc
}

/** 0 프레임에 0, 문서 길이 프레임(반복에서 0 프레임과 같은 자리)에 100 을 찍은 선형 이동 트랙. */
function withLinearTravel(layer: Layer): Layer {
  layer.tracks = [
    {
      id: 't1',
      prop: 'translateX',
      unit: 'px',
      keys: [
        { f: 0, v: 0, interp: 'linear' },
        { f: DURATION, v: 100, interp: 'linear' },
      ],
    },
  ]
  return layer
}

function xAt(doc: MotionProject, frame: number): number {
  return resolveLayerTransform(doc.layers[0]!, frame, doc.canvas, DURATION).translateX
}

beforeEach(() => resetIdCounter())

describe('모션 반복 방식 평가', () => {
  it('키가 없으면 기존 매핑 그대로다', () => {
    const doc = baseDoc()
    withLinearTravel(doc.layers[0]!)
    expect(xAt(doc, 10)).toBeCloseTo(50, 6)
  })

  it('왕복은 앞 절반에 순방향, 뒤 절반에 역방향으로 편다', () => {
    const doc = baseDoc()
    withLinearTravel(doc.layers[0]!).motionLoop = 'pingPong'
    expect(xAt(doc, 0)).toBeCloseTo(0, 6)
    expect(xAt(doc, 5)).toBeCloseTo(50, 6)
    expect(xAt(doc, 10)).toBeCloseTo(100, 6)
    expect(xAt(doc, 15)).toBeCloseTo(50, 6)
  })

  it('왕복의 주기 경계 값은 시작 값과 같다 (반복 이음새)', () => {
    const doc = baseDoc()
    withLinearTravel(doc.layers[0]!).motionLoop = 'pingPong'
    // 문서 반복에서 프레임 20 은 곧 프레임 0 이다. 그 직전 값이 시작 값으로 돌아와야 한다.
    expect(xAt(doc, 19)).toBeCloseTo(xAt(doc, 1), 6)
  })

  it('배수와 왕복이 함께 걸리면 주기마다 한 번 갔다 온다', () => {
    const doc = baseDoc()
    const layer = withLinearTravel(doc.layers[0]!)
    layer.motionLoop = 'pingPong'
    layer.motionRepeat = 2 // 주기 10프레임
    expect(xAt(doc, 0)).toBeCloseTo(0, 6)
    expect(xAt(doc, 5)).toBeCloseTo(100, 6)
    expect(xAt(doc, 10)).toBeCloseTo(0, 6)
  })

  it('왕복이어도 흔들림(모디파이어)은 문서 시간을 지킨다', () => {
    /*
     * 삼각파 프레임을 모디파이어에 넘기면 클럭이 두 배로 흘러 홀드 격자("2컷")가
     * 잘아지고 감쇠 엔벌로프의 꼬리가 샘플되지 않는다. 배수(repeat) 분기가 원래
     * 그렇듯 흔들림은 접지 않는다.
     */
    const doc = baseDoc()
    const layer = doc.layers[0]!
    layer.modifiers = [
      {
        id: 'm1', type: 'sine', target: 'translateY', blendOp: 'add', seed: 1,
        amplitude: 10, cycles: 2, octaves: 1, persistence: 0.5, lacunarity: 2,
        holdFrames: 1, decay: 0,
      },
    ]
    const plain = resolveLayerTransform(layer, 7, doc.canvas, DURATION).translateY
    layer.motionLoop = 'pingPong'
    const folded = resolveLayerTransform(layer, 7, doc.canvas, DURATION).translateY
    expect(folded).toBeCloseTo(plain, 9)
  })

  it('한번만은 첫 주기 뒤 트랙 끝 값에 멈춘다', () => {
    const doc = baseDoc()
    const layer = withLinearTravel(doc.layers[0]!)
    layer.motionLoop = 'once'
    layer.motionRepeat = 2 // 주기 10프레임: 10프레임 만에 다 돌고 멈춘다
    expect(xAt(doc, 5)).toBeCloseTo(50, 6)
    expect(xAt(doc, 10)).toBeCloseTo(100, 6)
    expect(xAt(doc, 15)).toBeCloseTo(100, 6)
    expect(xAt(doc, 19)).toBeCloseTo(100, 6)
  })
})

describe('모션 반복 방식 스토어', () => {
  beforeEach(() => {
    s().replaceDocument(baseDoc())
  })

  it('pingPong 과 once 는 값으로, repeat 는 키 삭제로 저장한다', () => {
    const id = s().doc.layers[0]!.id
    s().setLayerMotionLoop(id, 'pingPong')
    expect(s().doc.layers[0]!.motionLoop).toBe('pingPong')
    s().setLayerMotionLoop(id, 'once')
    expect(s().doc.layers[0]!.motionLoop).toBe('once')
    s().setLayerMotionLoop(id, 'repeat')
    expect('motionLoop' in s().doc.layers[0]!).toBe(false)
  })

  it('실행취소가 방식을 되돌린다', () => {
    const id = s().doc.layers[0]!.id
    s().setLayerMotionLoop(id, 'pingPong')
    s().undo()
    expect('motionLoop' in s().doc.layers[0]!).toBe(false)
  })
})

describe('모션 반복 방식 저장 파일', () => {
  it('값이 왕복에서 그대로 남는다', () => {
    const before = baseDoc()
    before.layers[0]!.motionLoop = 'pingPong'
    const { doc, warnings } = migrateProject(JSON.parse(JSON.stringify(before)) as unknown)
    expect(warnings).toEqual([])
    expect(JSON.stringify(doc)).toBe(JSON.stringify(before))
  })

  it('모르는 값은 키째로 지운다', () => {
    const before = baseDoc() as unknown as Record<string, unknown>
    ;(before['layers'] as Record<string, unknown>[])[0]!['motionLoop'] = 'zigzag'
    const { doc } = migrateProject(JSON.parse(JSON.stringify(before)) as unknown)
    expect(doc.layers[0]).not.toHaveProperty('motionLoop')
  })
})
