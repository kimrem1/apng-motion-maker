/**
 * 프로젝트 파일 저장/열기와 마이그레이션.
 *
 * 여기서 확인하는 것은 세 가지다.
 *   1. 왕복이 문서를 한 글자도 바꾸지 않는가.
 *   2. 손상된 입력에서 던지지 않고 복구하는가. 파일을 못 열면 그 작업은 사라진다.
 *   3. PNG 를 다시 압축하고 있지 않은가. 하면 CPU 만 쓰고 크기는 그대로다.
 */

import { strToU8, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'

import {
  advanceIdCounter,
  createEmptyProject,
  createImageLayer,
  createStaticTrack,
  maxIdOrdinal,
  nextId,
  resetIdCounter,
} from '@/core/factory.ts'
import {
  CANVAS_MAX,
  CANVAS_MIN,
  RENDER_REVISION,
  SCHEMA_ID,
  type AssetRef,
  type MotionProject,
} from '@/core/types.ts'
import { EFFECT_DEFS } from '@/effects/registry.ts'
import {
  DOC_ENTRY,
  ProjectFormatError,
  deserializeProject,
  ensureProjectExtension,
  readProjectBundle,
  serializeProject,
} from '@/project/format.ts'
import { migrateProject } from '@/project/migrate.ts'

// ---------------------------------------------------------------------------
// 도우미
// ---------------------------------------------------------------------------

const KNOWN_EFFECT = EFFECT_DEFS[0]!.id

function sampleAsset(): AssetRef {
  return {
    id: 'a1',
    name: '고양이.png',
    storeKey: 'idb:asset:a1',
    naturalW: 640,
    naturalH: 480,
    hasAlpha: true,
  }
}

function sampleDoc(): MotionProject {
  resetIdCounter()
  const doc = createEmptyProject()
  const asset = sampleAsset()
  doc.assets.push(asset)

  const layer = createImageLayer(asset, 0)
  layer.tracks.push(createStaticTrack('scale', 'ratio', 1))
  layer.tracks.push({
    id: 't9',
    prop: 'rotate',
    unit: 'deg',
    animated: true,
    keys: [
      { f: 0, v: 0, interp: 'bezier', out: { x: 0.33, y: 0 } },
      { f: 12, v: 360, interp: 'bezier', in: { x: 0.67, y: 1 }, easingPreset: 'easeInOut' },
    ],
  })
  layer.effects.push({
    id: 'e1',
    type: KNOWN_EFFECT,
    enabled: true,
    seed: 1234,
    holdFrames: 1,
    requiresHistory: false,
    params: {},
  })
  doc.layers.push(layer)

  doc.presetRef = { id: 'pop-in', macro: { speed: 1, strength: 1 }, dirty: false, props: ['scale'], effectIds: ['e1'] }
  return doc
}

/** zip 로컬 헤더를 직접 읽는다. 압축 방식은 라이브러리 말이 아니라 바이트로 확인한다. */
interface ZipEntry {
  name: string
  /** 0 = STORE, 8 = DEFLATE */
  method: number
  compressedSize: number
  originalSize: number
}

function readLocalHeaders(bytes: Uint8Array): ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const decoder = new TextDecoder()
  const out: ZipEntry[] = []
  let at = 0

  while (at + 30 <= bytes.length && view.getUint32(at, true) === 0x04034b50) {
    const method = view.getUint16(at + 8, true)
    const compressedSize = view.getUint32(at + 18, true)
    const originalSize = view.getUint32(at + 22, true)
    const nameLength = view.getUint16(at + 26, true)
    const extraLength = view.getUint16(at + 28, true)
    const name = decoder.decode(bytes.subarray(at + 30, at + 30 + nameLength))
    out.push({ name, method, compressedSize, originalSize })
    at += 30 + nameLength + extraLength + compressedSize
  }
  return out
}

/** 압축이 잘 드는 더미 PNG 바이트. 실제 디코드는 하지 않는다. */
function dummyPng(size: number): Uint8Array {
  const bytes = new Uint8Array(size)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  return bytes
}

// ---------------------------------------------------------------------------
// 왕복
// ---------------------------------------------------------------------------

describe('프로젝트 파일 왕복', () => {
  it('문서를 한 글자도 바꾸지 않는다', () => {
    const doc = sampleDoc()
    const before = JSON.stringify(doc)

    const bytes = serializeProject({ doc, assets: new Map([['a1', dummyPng(256)]]) })
    const bundle = deserializeProject(bytes)

    expect(JSON.stringify(bundle.doc)).toBe(before)
  })

  it('빈 문서도 그대로 돌아온다', () => {
    resetIdCounter()
    const doc = createEmptyProject()
    const bytes = serializeProject({ doc, assets: new Map() })
    expect(JSON.stringify(deserializeProject(bytes).doc)).toBe(JSON.stringify(doc))
  })

  it('에셋 바이트가 그대로 돌아온다', () => {
    const doc = sampleDoc()
    const png = dummyPng(1024)
    png[100] = 0x7f

    const bundle = deserializeProject(serializeProject({ doc, assets: new Map([['a1', png]]) }))
    const restored = bundle.assets.get('a1')

    expect(restored).toBeDefined()
    expect(restored?.length).toBe(png.length)
    expect(restored?.[100]).toBe(0x7f)
  })

  it('에셋 id 에 이상한 문자가 있어도 살아 돌아온다', () => {
    const doc = sampleDoc()
    doc.assets[0]!.id = '고양이/특수 문자?'
    doc.layers[0]!.assetId = doc.assets[0]!.id

    const id = doc.assets[0]!.id
    const bundle = deserializeProject(serializeProject({ doc, assets: new Map([[id, dummyPng(64)]]) }))
    expect(bundle.assets.has(id)).toBe(true)
  })

  it('경고 없이 열린 파일에는 경고가 없다', () => {
    const doc = sampleDoc()
    const result = readProjectBundle(serializeProject({ doc, assets: new Map([['a1', dummyPng(64)]]) }))
    expect(result.warnings).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 압축 방식
// ---------------------------------------------------------------------------

describe('zip 압축 방식', () => {
  it('에셋은 STORE, 문서는 DEFLATE 다', () => {
    const doc = sampleDoc()
    const png = dummyPng(4096)
    const bytes = serializeProject({ doc, assets: new Map([['a1', png]]) })

    const entries = readLocalHeaders(bytes)
    const names = entries.map((e) => e.name)
    expect(names).toContain(DOC_ENTRY)
    expect(names.some((n) => n.startsWith('assets/'))).toBe(true)

    const docEntry = entries.find((e) => e.name === DOC_ENTRY)!
    // 문서는 텍스트다. 압축이 들어야 하고 실제로 줄어야 한다.
    expect(docEntry.method).toBe(8)
    expect(docEntry.compressedSize).toBeLessThan(docEntry.originalSize)

    const assetEntry = entries.find((e) => e.name.startsWith('assets/'))!
    // 0 = STORE. PNG 재압축은 CPU 만 먹는다.
    expect(assetEntry.method).toBe(0)
    expect(assetEntry.compressedSize).toBe(png.length)
    expect(assetEntry.originalSize).toBe(png.length)
  })

  it('확장자를 보정한다', () => {
    expect(ensureProjectExtension('작업')).toBe('작업.mmproj')
    expect(ensureProjectExtension('작업.mmproj')).toBe('작업.mmproj')
    expect(ensureProjectExtension('   ')).toBe('무제.mmproj')
  })
})

// ---------------------------------------------------------------------------
// 손상된 파일
// ---------------------------------------------------------------------------

describe('손상된 파일', () => {
  it('zip 이 아니면 이유를 말하고 던진다', () => {
    expect(() => deserializeProject(new Uint8Array([1, 2, 3, 4, 5]))).toThrow(ProjectFormatError)
  })

  it('project.json 이 깨져도 에셋은 살아 돌아온다', () => {
    // zip 은 멀쩡한데 문서만 잘린 파일. 사용자가 이걸 못 열면 그림까지 잃는다.
    const bytes = zipSync({
      [DOC_ENTRY]: strToU8('{"schema":"motion-maker/1","layers":[{'),
      'assets/a1.png': dummyPng(64),
    })

    const result = readProjectBundle(bytes)
    expect(result.bundle.assets.get('a1')?.length).toBe(64)
    expect(result.bundle.doc.schema).toBe(SCHEMA_ID)
    expect(result.warnings.length).toBeGreaterThan(0)
  })

  it('project.json 이 아예 없어도 열린다', () => {
    const bytes = zipSync({ 'assets/a1.png': dummyPng(32) })
    const result = readProjectBundle(bytes)
    expect(result.bundle.doc.layers).toEqual([])
    expect(result.warnings.join(' ')).toContain('project.json')
  })
})

// ---------------------------------------------------------------------------
// 마이그레이션 / 복구
// ---------------------------------------------------------------------------

describe('migrateProject', () => {
  it('무엇이 들어와도 던지지 않는다', () => {
    const inputs: unknown[] = [
      null,
      undefined,
      0,
      '',
      '{ 이건 JSON 이 아니다',
      '[]',
      [],
      {},
      { schema: 'motion-maker/99' },
      { layers: 'not-an-array', assets: 42, canvas: null, timeline: 'x' },
    ]
    for (const input of inputs) {
      const result = migrateProject(input)
      expect(result.doc.schema).toBe(SCHEMA_ID)
      expect(Array.isArray(result.doc.layers)).toBe(true)
      expect(Array.isArray(result.warnings)).toBe(true)
    }
  })

  it('손상된 JSON 문자열을 빈 문서로 복구하고 알린다', () => {
    const result = migrateProject('{"schema": "motion-maker/1", "layers": [')
    expect(result.doc.layers).toEqual([])
    expect(result.warnings.join(' ')).toContain('손상')
  })

  it('범위 밖 값을 잘라 낸다', () => {
    const result = migrateProject({
      schema: SCHEMA_ID,
      canvas: { w: 999999, h: -5, background: { type: '없는배경' } },
      timeline: { fps: Number.NaN, durationFrames: 100000, loop: { mode: 'wat', count: -3 } },
      layers: [],
      assets: [],
    })

    // 상수를 숫자로 박으면 상한을 올릴 때마다 이 테스트가 이유 없이 깨진다.
    expect(result.doc.canvas.w).toBe(CANVAS_MAX)
    expect(result.doc.canvas.h).toBe(CANVAS_MIN)
    expect(result.doc.canvas.background.type).toBe('alpha')
    expect(result.doc.timeline.fps).toBe(25)
    expect(result.doc.timeline.durationFrames).toBe(120)
    expect(result.doc.timeline.loop.mode).toBe('loop')
    expect(result.doc.timeline.loop.count).toBe(0)
    expect(result.warnings.length).toBeGreaterThan(0)
  })

  it('키프레임을 정렬하고 겹친 것을 정리한다', () => {
    const result = migrateProject({
      schema: SCHEMA_ID,
      assets: [],
      layers: [
        {
          id: 'l1',
          tracks: [
            {
              id: 't1',
              prop: 'scale',
              unit: 'ratio',
              keys: [
                { f: 10, v: 2, interp: 'bezier' },
                { f: 0, v: 1, interp: 'bezier' },
                { f: 10, v: 9, interp: 'bezier' },
                { f: 4, v: 'nope', interp: '없는보간' },
              ],
            },
            // 같은 속성이 두 번. 뒤쪽은 버려야 값이 두 배로 튀지 않는다.
            { id: 't2', prop: 'scale', unit: 'ratio', keys: [{ f: 0, v: 5, interp: 'bezier' }] },
            // 키가 없는 트랙은 아무 값도 못 만든다.
            { id: 't3', prop: 'opacity', unit: 'ratio', keys: [] },
            { id: 't4', prop: '없는속성', unit: 'ratio', keys: [{ f: 0, v: 1, interp: 'bezier' }] },
          ],
        },
      ],
    })

    const layer = result.doc.layers[0]!
    expect(layer.tracks.length).toBe(1)
    const keys = layer.tracks[0]!.keys
    expect(keys.map((k) => k.f)).toEqual([0, 4, 10])
    // 값이 숫자가 아니면 항등값으로 되돌린다. scale 의 항등값은 1 이다.
    expect(keys[1]!.v).toBe(1)
    expect(keys[1]!.interp).toBe('bezier')
  })

  it('모르는 이펙트는 지우지 않고 꺼 둔다', () => {
    const result = migrateProject({
      schema: SCHEMA_ID,
      assets: [],
      layers: [
        {
          id: 'l1',
          tracks: [],
          effects: [
            { id: 'e1', type: '미래에나올효과', enabled: true, seed: 3, holdFrames: 1, requiresHistory: false, params: { amount: 0.5 } },
            { id: 'e2', type: KNOWN_EFFECT, enabled: true, seed: 3, holdFrames: 1, requiresHistory: false, params: {} },
          ],
        },
      ],
    })

    const effects = result.doc.layers[0]!.effects
    expect(effects.length).toBe(2)
    expect(effects[0]!.type).toBe('미래에나올효과')
    expect(effects[0]!.enabled).toBe(false)
    // 파라미터는 남아 있어야 나중 버전에서 그대로 다시 켤 수 있다.
    expect(effects[0]!.params.amount).toBe(0.5)
    expect(effects[1]!.enabled).toBe(true)
    expect(result.warnings.join(' ')).toContain('미래에나올효과')
  })

  it('알 수 없는 필드를 버리지 않는다', () => {
    const result = migrateProject({
      ...sampleDoc(),
      미래필드: { a: 1 },
      layers: [{ id: 'l1', tracks: [], 레이어미래필드: 7 }],
    })

    expect((result.doc as unknown as Record<string, unknown>)['미래필드']).toEqual({ a: 1 })
    expect((result.doc.layers[0] as unknown as Record<string, unknown>)['레이어미래필드']).toBe(7)
  })

  it('옛 renderRevision 에 경고를 단다', () => {
    const doc = sampleDoc()
    const result = migrateProject({ ...doc, renderRevision: RENDER_REVISION - 1 })
    expect(result.warnings.join(' ')).toContain('예전 버전')
    // 지금 렌더러로 그리므로 값은 현재 리비전이 된다. 안 그러면 열 때마다 같은 경고가 뜬다.
    expect(result.doc.renderRevision).toBe(RENDER_REVISION)
  })

  it('부모 순환을 끊는다', () => {
    const result = migrateProject({
      schema: SCHEMA_ID,
      assets: [],
      layers: [
        { id: 'l1', parentId: 'l2', tracks: [] },
        { id: 'l2', parentId: 'l1', tracks: [] },
        { id: 'l3', parentId: '없는레이어', tracks: [] },
      ],
    })

    const parents = result.doc.layers.map((l) => l.parentId)
    // 최소한 한쪽은 끊겨야 사슬을 도는 루프가 멈춘다.
    expect(parents.filter((p) => p !== null).length).toBeLessThan(2)
    expect(result.doc.layers[2]!.parentId).toBe(null)
  })

  it('겹친 레이어 id 를 갈라 준다', () => {
    const result = migrateProject({
      schema: SCHEMA_ID,
      assets: [],
      layers: [
        { id: 'l1', tracks: [] },
        { id: 'l1', tracks: [] },
        { tracks: [] },
      ],
    })

    const ids = result.doc.layers.map((l) => l.id)
    expect(new Set(ids).size).toBe(3)
    expect(ids[0]).toBe('l1')
  })

  it('식별자 없는 에셋만 버린다', () => {
    const result = migrateProject({
      schema: SCHEMA_ID,
      layers: [],
      assets: [
        { id: 'a1', name: 'x', naturalW: 10, naturalH: 10 },
        { name: 'id 없음' },
        { id: 'a1', name: '중복' },
      ],
    })

    expect(result.doc.assets.length).toBe(1)
    expect(result.doc.assets[0]!.storeKey).toBe('idb:asset:a1')
  })
})

/**
 * 파일에서 온 id 와 앞으로 만들 id 가 겹치면 안 된다.
 *
 * nextId 는 세션 단조 카운터라 새 탭에서 0 부터 시작한다. 파일을 열 때 카운터를
 * 문서의 최대 순번까지 감아 두는데, 그 최대치를 읽는 정규식이 틀려 있었다.
 * `[a-z]+` 가 탐욕적이라 36진수 순번의 앞 글자를 접두어로 먹는다. 순번 360 은
 * 'a0' 이므로 'la0' 이 '0'(=0) 으로 읽혔고, 카운터가 359 에서 멈췄다.
 *
 * 그러면 그 뒤 발급하는 id 가 문서 안의 레이어/트랙과 겹친다. 조회가 엉뚱한
 * 레이어를 집고, 다시 저장했다 열면 migrate 가 중복 id 를 새로 매기면서
 * folderId 가 가리키던 자리를 잃어 레이어가 폴더에서 튕겨 나온다.
 */
describe('id 카운터 되감기', () => {
  it('36진수 순번을 끝까지 읽는다', () => {
    // 359 = '9z', 360 = 'a0'. 여기가 정확히 갈리던 경계다.
    expect(maxIdOrdinal(['l9z'])).toBe(359)
    expect(maxIdOrdinal(['la0'])).toBe(360)
    expect(maxIdOrdinal(['la1'])).toBe(361)
    expect(maxIdOrdinal(['lab'])).toBe(371)
    expect(maxIdOrdinal(['tzzz'])).toBe(46655)
    // 여러 접두어가 섞여도 최댓값 하나다.
    expect(maxIdOrdinal(['l9z', 'ta0', 'm5', 'e1'])).toBe(360)
  })

  it('id 처럼 안 생긴 것은 건너뛴다', () => {
    expect(maxIdOrdinal(['', 'idb:asset:a1', 'l', '12', 'L1'])).toBe(1)
  })

  it('되감은 뒤 발급하는 id 가 문서 안의 id 와 겹치지 않는다', () => {
    resetIdCounter()
    // 순번 360 이 넘어가는 문서. 옛 정규식이 359 에서 멈추던 구간이다.
    const used = ['l9z', 'la0', 'la1', 'lab', 'tb7']
    advanceIdCounter(maxIdOrdinal(used))

    const taken = new Set(used)
    for (let i = 0; i < 50; i += 1) {
      for (const prefix of ['l', 't', 'm']) {
        const id = nextId(prefix)
        expect(taken.has(id), id).toBe(false)
        taken.add(id)
      }
    }
  })
})
