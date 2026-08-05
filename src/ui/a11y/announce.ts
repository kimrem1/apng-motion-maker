/**
 * 전역 낭독 알림.
 *
 * 문제: 이 앱의 변화는 대부분 포커스 밖에서 일어난다. 프리셋을 적용하면 캔버스가
 * 바뀌고, 이펙트를 추가하면 인스펙터 아래쪽에 줄이 생기고, 내보내기가 끝나면 모달
 * 본문이 통째로 갈린다. 마우스 사용자는 눈으로 보지만 낭독기 사용자에게는
 * 아무 일도 일어나지 않은 것과 구분되지 않는다.
 *
 * 이 모듈은 그 사건들을 aria-live 영역 하나로 모은다. DOM 은 건드리지 않는다.
 * 실제 노드는 LiveRegion.tsx 가 만들고 여기 구독한다. 그래서 이 파일은
 * 브라우저 없이도 돌아가고 테스트할 수 있다.
 *
 * 중복 억제:
 * 슬라이더를 끌거나 같은 버튼을 연타하면 같은 문장이 초당 수십 번 날아온다.
 * 그대로 흘리면 낭독기가 계속 말을 끊고 다시 시작해서 아무것도 못 듣는다.
 * 같은 문장이 ANNOUNCE_DEDUPE_MS 안에 다시 오면 버린다.
 * 다만 polite 로 이미 말한 문장이 assertive 로 다시 오면 버리지 않는다.
 * 등급이 올라갔다는 것은 상황이 나빠졌다는 뜻이고 그건 반드시 들려야 한다.
 */

export type AnnouncePriority = 'polite' | 'assertive'

export interface Announcement {
  /** 단조 증가. 같은 문장이 다시 와도 LiveRegion 이 새 사건임을 알 수 있다. */
  seq: number
  message: string
  priority: AnnouncePriority
  /** clock() 시각 (ms) */
  at: number
}

export type AnnouncementListener = (announcement: Announcement) => void

/** 같은 문장을 다시 말하기까지의 최소 간격. */
export const ANNOUNCE_DEDUPE_MS = 1500

/** 구독자가 아직 없을 때 들고 있을 최대 개수. 앱 부팅 직후의 알림을 잃지 않는다. */
export const ANNOUNCE_BUFFER_MAX = 4

/**
 * 우선순위 -> 라이브 영역 속성.
 *
 * role 과 aria-live 를 함께 준다. 둘 중 하나만 보는 낭독기가 아직 있다.
 * aria-atomic 은 항상 true 다. 문장 일부만 읽히면 뜻이 뒤집힌다
 * ("적용했습니다" 와 "적용하지 못했습니다").
 */
export interface LiveRegionAttrs {
  role: 'status' | 'alert'
  ariaLive: AnnouncePriority
  ariaAtomic: 'true'
}

const LIVE_REGION_ATTRS: Readonly<Record<AnnouncePriority, LiveRegionAttrs>> = {
  polite: { role: 'status', ariaLive: 'polite', ariaAtomic: 'true' },
  assertive: { role: 'alert', ariaLive: 'assertive', ariaAtomic: 'true' },
}

/** LiveRegion 이 각 영역에 붙일 속성. 매핑을 컴포넌트에 흩지 않는다. */
export function liveRegionAttrs(priority: AnnouncePriority): LiveRegionAttrs {
  return LIVE_REGION_ATTRS[priority]
}

// ---------------------------------------------------------------------------
// 내부 상태
// ---------------------------------------------------------------------------

let clock: () => number = () => Date.now()
let seq = 0
let lastMessage: string | null = null
let lastPriority: AnnouncePriority = 'polite'
let lastAt = Number.NEGATIVE_INFINITY

const listeners = new Set<AnnouncementListener>()
let buffered: Announcement[] = []

/**
 * 지금 이 문장을 흘려보낼 것인가.
 *
 * 밖으로 뺀 이유는 테스트 때문이 아니라, 규칙이 한 곳에만 있어야 하기 때문이다.
 * announce 안에 인라인으로 두면 나중에 "이 경우만 예외" 가 반드시 끼어든다.
 */
function isDuplicate(message: string, priority: AnnouncePriority, now: number): boolean {
  if (message !== lastMessage) return false
  if (now - lastAt >= ANNOUNCE_DEDUPE_MS) return false
  // 등급이 올라가면 통과시킨다.
  if (priority === 'assertive' && lastPriority !== 'assertive') return false
  return true
}

/**
 * 낭독기에 한 문장을 알린다.
 *
 * 문장은 그 자체로 완결되어야 한다. "적용됨" 이 아니라 "흔들기를 적용했습니다" 다.
 * 낭독기 사용자는 화면 맥락 없이 이 문장 하나만 듣는다.
 *
 * priority:
 *   polite    (기본) 하던 말을 끊지 않는다. 성공 / 진행 / 완료가 여기다.
 *   assertive 즉시 끼어든다. 오류와 데이터 손실 위험만 여기다.
 *             남용하면 낭독기가 아무 말도 끝맺지 못한다.
 */
export function announce(message: string, priority: AnnouncePriority = 'polite'): void {
  const text = message.trim()
  if (text.length === 0) return

  const now = clock()
  if (isDuplicate(text, priority, now)) return

  lastMessage = text
  lastPriority = priority
  lastAt = now
  seq += 1

  const announcement: Announcement = { seq, message: text, priority, at: now }

  if (listeners.size === 0) {
    // 아직 LiveRegion 이 안 붙었다. 마운트되면 넘겨준다.
    buffered.push(announcement)
    if (buffered.length > ANNOUNCE_BUFFER_MAX) buffered = buffered.slice(-ANNOUNCE_BUFFER_MAX)
    return
  }

  for (const listener of listeners) listener(announcement)
}

/**
 * 라이브 영역이 구독한다. 첫 구독자에게는 밀린 알림을 순서대로 넘긴다.
 * 반환값을 부르면 해제된다.
 */
export function subscribeAnnouncements(listener: AnnouncementListener): () => void {
  listeners.add(listener)

  if (buffered.length > 0) {
    const pending = buffered
    buffered = []
    for (const item of pending) listener(item)
  }

  return () => {
    listeners.delete(listener)
  }
}

/** 밀려 있는(아직 아무도 안 받은) 알림. 진단용이다. */
export function getBufferedAnnouncements(): readonly Announcement[] {
  return buffered
}

/**
 * 테스트용 시계 교체. null 이면 Date.now 로 되돌린다.
 * 제품 코드에서는 부르지 않는다.
 */
export function setAnnounceClock(fn: (() => number) | null): void {
  clock = fn ?? (() => Date.now())
}

/** 테스트용 전체 초기화. */
export function resetAnnouncer(): void {
  seq = 0
  lastMessage = null
  lastPriority = 'polite'
  lastAt = Number.NEGATIVE_INFINITY
  listeners.clear()
  buffered = []
}

// ---------------------------------------------------------------------------
// 자주 쓰는 문장
// ---------------------------------------------------------------------------

/*
 * 문장을 호출부마다 손으로 쓰면 "적용됨" / "적용했습니다" / "적용 완료" 가 섞인다.
 * 낭독기가 읽는 말투는 한 곳에 모아 둔다.
 */

/** 프리셋 적용 (state/presetActions.applyPresetToDocument 뒤). */
export function announcePresetApplied(label: string): void {
  announce(`${label} 모션을 적용했습니다.`)
}

/** 이펙트 추가 (ui/effects/EffectStack 의 추가 뒤). */
export function announceEffectAdded(label: string): void {
  announce(`${label} 효과를 추가했습니다.`)
}

/** 실행 취소 / 다시 실행. */
export function announceUndo(label: string | undefined, redo = false): void {
  const verb = redo ? '다시 실행' : '되돌림'
  announce(label ? `${verb}: ${label}` : `${verb}.`)
}

/** 내보내기 완료. */
export function announceExportDone(sizeLabel: string): void {
  announce(`내보내기를 마쳤습니다. 파일 크기 ${sizeLabel}.`)
}

/** 되돌릴 수 없는 실패. 여기만 assertive 다. */
export function announceFailure(message: string): void {
  announce(message, 'assertive')
}
