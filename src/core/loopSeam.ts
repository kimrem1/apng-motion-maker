/**
 * 루프 이음새 검사기.
 *
 * 반복 재생에서 사용자가 "왜 튀지" 하고 느끼는 지점은 세 종류다.
 *
 *   1. 값 불연속   마지막 프레임 다음(= 다시 첫 프레임)에서 값이 갑자기 바뀐다.
 *   2. 속도 불연속 값은 이어지는데 속도가 꺾인다. 무한 회전에 이징을 걸면 매 바퀴
 *                  시작마다 급가속이 반복되어 즉시 싸구려로 읽힌다.
 *   3. 홀드 어긋남 자글자글의 홀드 블록이 전체 길이를 나누지 못해 마지막 블록만
 *                  잘린다.
 *
 * 왕복(pingPong)은 끝에서 되돌아오므로 이음새가 구조적으로 존재하지 않는다. 1회
 * 재생(once)도 이어 붙일 곳이 없다. 그래서 검사 대상은 loop / loopWithHold 뿐이다.
 *
 * 값 비교 지점이 "마지막 프레임" 이 아니라 "마지막 + 1 프레임" 인 이유는 재생기가
 * frame % durationFrames 로 감기 때문이다(core/time.ts). 즉 프레임 N-1 다음에 오는
 * 것은 프레임 N 이 아니라 프레임 0 이고, 심리스 루프의 조건은 track(N) == track(0) 이다.
 * 프리셋이 마지막 키를 N-1 이 아니라 N 에 두는 것도 같은 이유다.
 *
 * 이 파일은 DOM / React 를 참조하지 않는다.
 */

import {
  FRAMES_MAX,
  type Keyframe,
  type Layer,
  type Modifier,
  type MotionProject,
  type Track,
  type TrackProp,
  type TrackUnit,
} from './types.ts'
import { evalTrack, realSpeed, segmentSpeed } from '@/easing/curve.ts'

// ---------------------------------------------------------------------------
// 공개 타입
// ---------------------------------------------------------------------------

export type SeamIssueKind = 'valueJump' | 'speedJump' | 'holdMisaligned'

export type SeamFixKind = 'matchFirstKey' | 'makeLinear' | 'snapDuration'

export interface SeamFix {
  kind: SeamFixKind
  /** 원클릭 수정이 무엇을 할지 사용자에게 미리 알려 주는 한 줄. */
  detail: string
}

export interface SeamIssue {
  kind: SeamIssueKind
  layerId: string
  prop: TrackProp
  /** 사용자에게 보여줄 한국어 설명 */
  message: string
  /** 원클릭 수정 제안 */
  fix: SeamFix
  severity: 'warn' | 'error'
}

// ---------------------------------------------------------------------------
// 임계값
// ---------------------------------------------------------------------------

/**
 * 값이 이만큼 어긋나면 이음새로 본다.
 * 512px 캔버스에서 눈에 띄기 시작하는 최소 변위가 대략 0.5px 이라는 기준으로 잡았다.
 * 배율은 0.4% 가 512px 기준 약 2px 이동에 해당한다.
 */
const VALUE_TOLERANCE: Record<TrackUnit, number> = {
  ratio: 0.004,
  px: 0.5,
  percentOfCanvas: 0.1,
  deg: 0.25,
  norm: 0.002,
}

/**
 * 이 속도(단위/초) 아래면 양쪽 다 사실상 정지 상태다. 정지 구간의 속도 비교는
 * 분모가 0 에 가까워 의미 없는 경고만 만든다.
 */
const SPEED_FLOOR: Record<TrackUnit, number> = {
  ratio: 0.05,
  px: 4,
  percentOfCanvas: 1,
  deg: 2,
  norm: 0.02,
}

/** 큰 쪽 속도의 몇 배까지 차이를 허용할지. 0.5 = 50% 차이까지는 눈에 안 띈다. */
const SPEED_RATIO_TOLERANCE = 0.5

const PROP_LABEL: Record<TrackProp, string> = {
  scale: '크기',
  scaleX: '가로 크기',
  scaleY: '세로 크기',
  rotate: '회전',
  rotateX: '가로축 회전',
  rotateY: '세로축 회전',
  translateX: '가로 위치',
  translateY: '세로 위치',
  skewX: '가로 기울기',
  skewY: '세로 기울기',
  opacity: '투명도',
  reveal: '가리기',
  charIn: '글자 등장',
  anchorX: '기준점 가로',
  anchorY: '기준점 세로',
}

// ---------------------------------------------------------------------------
// 표시 헬퍼
// ---------------------------------------------------------------------------

function formatValue(v: number, unit: TrackUnit): string {
  switch (unit) {
    case 'ratio':
      return `${(v * 100).toFixed(1)}%`
    case 'deg':
      return `${v.toFixed(1)}도`
    case 'px':
      return `${v.toFixed(1)}px`
    case 'percentOfCanvas':
      return `${v.toFixed(1)}%`
    case 'norm':
    default:
      return v.toFixed(3)
  }
}

const formatSpeed = (v: number, unit: TrackUnit): string => `${formatValue(v, unit)}/초`

/** 회전은 360도 주기다. 차이를 (-180, 180] 로 접는다. */
function wrapDegrees(deg: number): number {
  const r = ((deg % 360) + 540) % 360 - 180
  // -180 은 +180 과 같은 자세다. 부호를 하나로 모아 메시지가 흔들리지 않게 한다.
  return r === -180 ? 180 : r
}

// ---------------------------------------------------------------------------
// 1. 값 불연속
// ---------------------------------------------------------------------------

function checkValueJump(layer: Layer, track: Track, durationFrames: number): SeamIssue | null {
  if (track.keys.length < 2) return null

  const head = evalTrack(track, 0)
  const wrap = evalTrack(track, durationFrames)
  if (head === undefined || wrap === undefined) return null

  let diff = wrap - head
  // 0도 -> 360도 는 시각적으로 같은 자세다. spin360 을 오검출하면 안 된다.
  // 세 회전축이 모두 같은 규칙이다. 한 축만 보면 카드 한 바퀴가 이음새로 잡힌다.
  if (track.prop === 'rotate' || track.prop === 'rotateX' || track.prop === 'rotateY') {
    diff = wrapDegrees(diff)
  }
  if (Math.abs(diff) <= VALUE_TOLERANCE[track.unit]) return null

  const label = PROP_LABEL[track.prop]
  return {
    kind: 'valueJump',
    layerId: layer.id,
    prop: track.prop,
    message:
      `'${layer.name}' 의 ${label}가 반복 지점에서 ${formatValue(Math.abs(diff), track.unit)} 튑니다. ` +
      `끝 값 ${formatValue(wrap, track.unit)} 이 첫 값 ${formatValue(head, track.unit)} 과 다릅니다.`,
    fix: {
      kind: 'matchFirstKey',
      detail: `마지막 키프레임 값을 첫 값 ${formatValue(head, track.unit)} 으로 맞춥니다.`,
    },
    severity: 'error',
  }
}

// ---------------------------------------------------------------------------
// 2. 속도 불연속
// ---------------------------------------------------------------------------

/**
 * 세그먼트 양끝의 정규화 속도.
 *
 * segmentSpeed 는 핸들에서 속도를 뽑으므로 베지어에만 의미가 있다. linear 키는
 * 핸들을 안 들고 있어서 기본 핸들(0.33,0)/(0.67,1) 로 읽히고, 그러면 등속 구간이
 * 양끝 정지로 잘못 읽힌다. 보간 타입을 먼저 갈라야 하는 이유다.
 * spring / samples 는 정본이 핸들이 아니라 여기서 판단하지 않는다.
 */
function edgeSpeeds(a: Keyframe, b: Keyframe): { out: number; in: number } | null {
  switch (a.interp) {
    case 'hold':
      // 계단식이 의도된 모양이다. 속도 불연속을 지적할 대상이 아니다.
      return null
    case 'spring':
    case 'samples':
      return null
    case 'linear':
      return { out: 1, in: 1 }
    case 'bezier':
    default: {
      const s = segmentSpeed(a, b)
      return { out: s.outSpeed, in: s.inSpeed }
    }
  }
}

function checkSpeedJump(layer: Layer, track: Track, fps: number): SeamIssue | null {
  const keys = track.keys
  if (keys.length < 2) return null

  const firstA = keys[0]!
  const firstB = keys[1]!
  const lastA = keys[keys.length - 2]!
  const lastB = keys[keys.length - 1]!

  const head = edgeSpeeds(firstA, firstB)
  const tail = edgeSpeeds(lastA, lastB)
  if (!head || !tail) return null

  const vStart = realSpeed(head.out, firstB.v - firstA.v, firstB.f - firstA.f, fps)
  const vEnd = realSpeed(tail.in, lastB.v - lastA.v, lastB.f - lastA.f, fps)

  const scale = Math.max(Math.abs(vStart), Math.abs(vEnd))
  if (scale < SPEED_FLOOR[track.unit]) return null
  if (Math.abs(vStart - vEnd) <= SPEED_RATIO_TOLERANCE * scale) return null

  const label = PROP_LABEL[track.prop]
  return {
    kind: 'speedJump',
    layerId: layer.id,
    prop: track.prop,
    message:
      `'${layer.name}' 의 ${label}가 반복 지점에서 속도가 꺾입니다. ` +
      `끝 속도 ${formatSpeed(vEnd, track.unit)}, 시작 속도 ${formatSpeed(vStart, track.unit)}. ` +
      '매 바퀴 같은 자리에서 급가속이 반복됩니다.',
    fix: {
      kind: 'makeLinear',
      detail: '양 끝 키프레임을 균등(등속)으로 바꿉니다. 이징을 살리려면 왕복 반복을 고르세요.',
    },
    severity: 'warn',
  }
}

// ---------------------------------------------------------------------------
// 3. 홀드 어긋남
// ---------------------------------------------------------------------------

/** hold 로 나누어떨어지는 가장 가까운 길이. 상한(FRAMES_MAX)에 걸리면 아래로 내린다. */
export function snapDurationToHold(durationFrames: number, holdFrames: number): number {
  const hold = Math.max(1, Math.round(holdFrames))
  const up = Math.ceil(durationFrames / hold) * hold
  if (up <= FRAMES_MAX) return Math.max(hold, up)
  const down = Math.floor(durationFrames / hold) * hold
  return Math.max(hold, down)
}

/** durationFrames 를 나누는 약수 중 target 에 가장 가까운 값. 길이를 안 건드리는 쪽 수정안. */
export function nearestHoldDivisor(durationFrames: number, target: number): number {
  const n = Math.max(1, Math.round(durationFrames))
  let best = 1
  let bestDist = Number.POSITIVE_INFINITY
  for (let d = 1; d <= n; d += 1) {
    if (n % d !== 0) continue
    const dist = Math.abs(d - target)
    if (dist < bestDist) {
      best = d
      bestDist = dist
    }
  }
  return best
}

function checkHoldAlignment(
  layer: Layer,
  modifier: Modifier,
  durationFrames: number,
): SeamIssue | null {
  const hold = Math.round(modifier.holdFrames)
  // 1 이하는 홀드를 안 쓴다는 뜻이다. 매 프레임 갱신이라 잘릴 블록이 없다.
  if (hold <= 1) return null
  if (durationFrames % hold === 0) return null

  const snapped = snapDurationToHold(durationFrames, hold)
  const altHold = nearestHoldDivisor(durationFrames, hold)
  const remainder = durationFrames % hold

  return {
    kind: 'holdMisaligned',
    layerId: layer.id,
    prop: modifier.target,
    message:
      `'${layer.name}' 의 홀드 ${hold}프레임이 전체 길이 ${durationFrames}프레임을 나누지 못합니다. ` +
      `마지막 블록이 ${remainder}프레임만 남아 잘리고, 그 자리에서 반복이 튑니다.`,
    fix: {
      kind: 'snapDuration',
      detail: `길이를 ${snapped}프레임으로 바꿉니다. 길이를 유지하려면 홀드를 ${altHold}프레임으로 바꾸세요.`,
    },
    severity: 'warn',
  }
}

// ---------------------------------------------------------------------------
// 진입점
// ---------------------------------------------------------------------------

export function checkLoopSeam(doc: MotionProject): SeamIssue[] {
  const issues: SeamIssue[] = []

  const { mode } = doc.timeline.loop
  // 왕복은 끝에서 되돌아오므로 이음새가 없고, 1회 재생은 이어 붙일 곳이 없다.
  if (mode !== 'loop' && mode !== 'loopWithHold') return issues

  const durationFrames = doc.timeline.durationFrames
  const fps = doc.timeline.fps
  if (durationFrames <= 1 || fps <= 0) return issues

  for (const layer of doc.layers) {
    // 안 보이는 레이어는 화면에 아무것도 기여하지 않는다. 경고를 띄우면 소음이다.
    if (!layer.visible) continue

    for (const track of layer.tracks) {
      const jump = checkValueJump(layer, track, durationFrames)
      if (jump) {
        // 값이 이미 튀는 트랙에 속도 경고까지 붙이면 무엇부터 고칠지 흐려진다.
        // 값을 맞추면 속도는 다시 판단해야 하므로 여기서 끊는다.
        issues.push(jump)
        continue
      }
      const speed = checkSpeedJump(layer, track, fps)
      if (speed) issues.push(speed)
    }

    for (const modifier of layer.modifiers) {
      const hold = checkHoldAlignment(layer, modifier, durationFrames)
      if (hold) issues.push(hold)
    }
  }

  return issues
}
