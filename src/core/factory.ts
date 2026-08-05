/** 문서 생성 헬퍼. 기본값은 스키마가 정한 default 를 따른다. */

import {
  RENDER_REVISION,
  SCHEMA_ID,
  type AssetRef,
  type Layer,
  type MotionProject,
  type ShapeSpec,
  type TextSpec,
  type Track,
  type TrackProp,
  type TrackUnit,
} from './types.ts'

export const APP_VERSION = '0.1.0'

let idCounter = 0

/**
 * 문서용 id. crypto.randomUUID 를 쓰지 않는 이유는 같은 조작이 같은 문서를 만들어야
 * 테스트에서 스냅샷 비교가 가능하기 때문이다. 충돌은 접두어 + 단조 증가로 막는다.
 */
export function nextId(prefix: string): string {
  idCounter += 1
  return `${prefix}${idCounter.toString(36)}`
}

/** 테스트에서 카운터를 되돌린다. */
export function resetIdCounter(): void {
  idCounter = 0
}

/**
 * 카운터를 최소 n 까지 앞으로 감는다.
 *
 * 파일에서 문서를 불러오면 그 안에 이미 l3, t7 같은 id 가 들어 있다. 카운터가 0 인 채로
 * 새 레이어를 만들면 l1 부터 다시 발급해 충돌한다. 불러오기 직후 이 함수로 감아 둔다.
 */
export function advanceIdCounter(n: number): void {
  if (Number.isFinite(n) && n > idCounter) idCounter = Math.floor(n)
}

/** 문서 안에서 쓰인 id 의 최대 순번. 접두어 뒤는 36진수다. */
export function maxIdOrdinal(ids: Iterable<string>): number {
  let max = 0
  for (const id of ids) {
    const m = /^[a-z]+([0-9a-z]+)$/i.exec(id)
    if (!m || !m[1]) continue
    const n = parseInt(m[1], 36)
    if (Number.isFinite(n) && n > max) max = n
  }
  return max
}

export function createEmptyProject(): MotionProject {
  return {
    schema: SCHEMA_ID,
    appVersion: APP_VERSION,
    renderRevision: RENDER_REVISION,
    canvas: {
      w: 512,
      h: 512,
      // 단색 배경의 기본색. 알파 0 으로 두면 '단색' 을 골라도 투명하게 렌더된다.
      background: { type: 'alpha', color: '#000000ff', matteColor: '#ffffff' },
    },
    timeline: {
      fps: 25,
      durationFrames: 30,
      loop: { mode: 'loop', count: 0, holdMs: 0, dedupeBoundaryFrame: true },
    },
    safeZone: { policy: 'autoFit', marginRatio: 0.005, sampleCount: 240, edgeBleedPx: 1 },
    assets: [],
    layers: [],
  }
}

export function createImageLayer(asset: AssetRef, z: number): Layer {
  return {
    id: nextId('l'),
    name: asset.name,
    type: 'image',
    assetId: asset.id,
    parentId: null,
    z,
    visible: true,
    locked: false,
    // 원본 크기 그대로 앉힌다. 캔버스가 가장 큰 이미지에 맞춰 잡히므로 채우기나
    // 담기로 배율을 건드리면 오히려 원본과 다른 크기가 된다.
    fit: 'none',
    anchor: [0.5, 0.5],
    keepPlaceOnAnchorChange: true,
    // 캔버스 크기를 아직 안 건드렸다. 넣은 픽셀 그대로다.
    baseScale: 1,
    blend: 'normal',
    parallaxFactor: 1,
    /*
     * 기본은 '원본 크기 그대로'(FrameFit = crop)다. 둘 다 끈 상태가 그 뜻이다.
     *
     * 캔버스가 처음 들어온 가장 큰 이미지에 맞춰 잡히므로(state/document.ts addImage)
     * 그림은 이미 프레임에 딱 맞는다. 여기서 담기(keepInside)를 켜면 모션이 조금만
     * 프레임을 벗어나도 솔버가 배율을 낮춰, 넣은 그림이 넣자마자 작아진다.
     * 잘리는 것이 더 싫은 레이어는 인스펙터 > 레이어 관계에서 '잘리지 않게' 로 바꾼다.
     * 셋은 배타다.
     */
    fillsCanvas: false,
    keepInside: false,
    motionExitsFrame: false,
    tracks: [],
    modifiers: [],
    effects: [],
  }
}

/**
 * 도형 레이어.
 *
 * 이미지 레이어와 필드 순서를 맞춘다. 마이그레이션이 `shape` 를 같은 자리에 끼우므로
 * 저장했다 다시 여는 왕복에서 JSON 이 한 글자도 달라지지 않는다.
 *
 * 담기(keepInside)와 채우기(fillsCanvas)는 꺼 둔다. 도형은 자기 크기를 사용자가 직접
 * 정하는 것이고, 솔버가 배율을 건드리면 방금 정한 크기가 조용히 달라진다.
 */
export function createShapeLayer(shape: ShapeSpec, name: string, z: number): Layer {
  return {
    id: nextId('l'),
    name,
    type: 'shape',
    assetId: null,
    parentId: null,
    z,
    visible: true,
    locked: false,
    fit: 'none',
    anchor: [0.5, 0.5],
    keepPlaceOnAnchorChange: true,
    baseScale: 1,
    blend: 'normal',
    parallaxFactor: 1,
    fillsCanvas: false,
    keepInside: false,
    motionExitsFrame: false,
    shape,
    tracks: [],
    modifiers: [],
    effects: [],
  }
}

/**
 * 글자 레이어.
 *
 * 도형과 완전히 같은 규칙을 탄다. 자연 크기는 글자 배치가 정하고(core/text.ts),
 * 맞춤 / 기준점 / 캔버스 배율은 이미지와 한 글자도 다르지 않다.
 */
export function createTextLayer(text: TextSpec, name: string, z: number): Layer {
  return {
    id: nextId('l'),
    name,
    type: 'text',
    assetId: null,
    parentId: null,
    z,
    visible: true,
    locked: false,
    fit: 'none',
    anchor: [0.5, 0.5],
    keepPlaceOnAnchorChange: true,
    baseScale: 1,
    blend: 'normal',
    parallaxFactor: 1,
    fillsCanvas: false,
    keepInside: false,
    motionExitsFrame: false,
    text,
    tracks: [],
    modifiers: [],
    effects: [],
  }
}

/**
 * 폴더 레이어.
 *
 * 아무것도 그리지 않는다. 안에 담긴 레이어의 매트릭스 바깥에 자기 변환이 곱해질
 * 뿐이다 (core/group.ts). 그래서 맞춤도 원본도 없다.
 *
 * **트랙은 다른 레이어와 똑같다.** 그래야 94종 프리셋이 폴더에도 그대로 걸린다.
 * 폴더 전용 모션 목록을 따로 만들 이유가 없다.
 *
 * 담기 / 채우기는 끈다. 폴더는 잴 원본 크기가 없어 솔버 대상이 아니다.
 */
export function createFolderLayer(name: string, z: number): Layer {
  return {
    id: nextId('l'),
    name,
    type: 'group',
    assetId: null,
    parentId: null,
    z,
    visible: true,
    locked: false,
    fit: 'none',
    anchor: [0.5, 0.5],
    keepPlaceOnAnchorChange: true,
    baseScale: 1,
    blend: 'normal',
    parallaxFactor: 1,
    fillsCanvas: false,
    keepInside: false,
    motionExitsFrame: false,
    tracks: [],
    modifiers: [],
    effects: [],
  }
}

export function createStaticTrack(prop: TrackProp, unit: TrackUnit, value: number): Track {
  return {
    id: nextId('t'),
    prop,
    unit,
    keys: [{ f: 0, v: value, interp: 'bezier' }],
  }
}

/** 트랙 종류별 기본 단위와 항등값. 인스펙터가 이 표를 그대로 쓴다. */
export const TRACK_DEFAULTS: Record<TrackProp, { unit: TrackUnit; identity: number }> = {
  scale: { unit: 'ratio', identity: 1 },
  scaleX: { unit: 'ratio', identity: 1 },
  scaleY: { unit: 'ratio', identity: 1 },
  opacity: { unit: 'ratio', identity: 1 },
  reveal: { unit: 'ratio', identity: 1 },
  charIn: { unit: 'ratio', identity: 1 },
  rotate: { unit: 'deg', identity: 0 },
  rotateX: { unit: 'deg', identity: 0 },
  rotateY: { unit: 'deg', identity: 0 },
  translateX: { unit: 'px', identity: 0 },
  translateY: { unit: 'px', identity: 0 },
  skewX: { unit: 'deg', identity: 0 },
  skewY: { unit: 'deg', identity: 0 },
  anchorX: { unit: 'norm', identity: 0.5 },
  anchorY: { unit: 'norm', identity: 0.5 },
}
