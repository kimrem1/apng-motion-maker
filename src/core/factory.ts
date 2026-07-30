/** 문서 생성 헬퍼. 기본값은 스키마가 정한 default 를 따른다. */

import {
  RENDER_REVISION,
  SCHEMA_ID,
  type AssetRef,
  type Layer,
  type MotionProject,
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
  rotate: { unit: 'deg', identity: 0 },
  translateX: { unit: 'px', identity: 0 },
  translateY: { unit: 'px', identity: 0 },
  skewX: { unit: 'deg', identity: 0 },
  skewY: { unit: 'deg', identity: 0 },
  anchorX: { unit: 'norm', identity: 0.5 },
  anchorY: { unit: 'norm', identity: 0.5 },
}
