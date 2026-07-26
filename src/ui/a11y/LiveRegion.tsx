/**
 * 전역 aria-live 영역.
 *
 * 앱 루트에 **한 번만** 놓는다. 컴포넌트마다 role="status" 를 흩뿌리면 낭독기가
 * 어느 영역을 읽어야 하는지 몰라 겹쳐 읽거나 통째로 건너뛴다.
 *
 * 영역을 두 개 두는 이유:
 * 한 노드의 aria-live 값을 도중에 바꾸면 대부분의 낭독기가 그 변경을 무시한다.
 * polite 와 assertive 를 처음부터 각각 만들어 두고 글자만 갈아 끼운다.
 *
 * 같은 문장을 다시 말해야 할 때:
 * 텍스트 노드가 그대로면 낭독기는 "바뀌지 않았다" 로 보고 읽지 않는다.
 * announce 가 짧은 시간 안의 중복은 이미 걸렀으므로, 그 창을 지나 다시 온
 * 같은 문장은 진짜로 다시 들려야 한다. 폭 0 문자를 번갈아 붙여 노드를 바꾼다.
 * U+200B 는 낭독되지 않고 화면에도 나타나지 않는다.
 */

import { useEffect, useState, type ReactNode } from 'react'

import { liveRegionAttrs, subscribeAnnouncements, type AnnouncePriority } from './announce.ts'

import './a11y.css'

/** 같은 문장을 다시 읽히기 위한 보이지 않는 표식 (U+200B). 소스에 직접 넣지 않는다. */
const ZERO_WIDTH = String.fromCharCode(0x200b)

interface Slot {
  text: string
  /** 이 슬롯이 지금까지 받은 알림 수. 홀수면 표식을 붙인다. */
  count: number
}

const EMPTY: Slot = { text: '', count: 0 }

function slotText(slot: Slot): string {
  if (slot.text.length === 0) return ''
  return slot.count % 2 === 1 ? slot.text + ZERO_WIDTH : slot.text
}

export interface LiveRegionProps {
  /**
   * 이 시간이 지나면 문장을 지운다.
   *
   * 남겨 두면 낭독기 사용자가 나중에 커서로 훑다가 몇 분 전 문장을 현재 상태로
   * 잘못 읽는다. 0 이면 지우지 않는다.
   */
  clearAfterMs?: number
}

export function LiveRegion({ clearAfterMs = 8000 }: LiveRegionProps): ReactNode {
  const [polite, setPolite] = useState<Slot>(EMPTY)
  const [assertive, setAssertive] = useState<Slot>(EMPTY)

  useEffect(() => {
    return subscribeAnnouncements((announcement) => {
      const next = (prev: Slot): Slot => ({ text: announcement.message, count: prev.count + 1 })
      if (announcement.priority === 'assertive') setAssertive(next)
      else setPolite(next)
    })
  }, [])

  // 오래된 문장 청소. 두 슬롯이 서로 독립적으로 늙는다.
  useEffect(() => {
    if (clearAfterMs <= 0 || polite.text.length === 0) return
    const timer = setTimeout(() => setPolite(EMPTY), clearAfterMs)
    return () => clearTimeout(timer)
  }, [polite, clearAfterMs])

  useEffect(() => {
    if (clearAfterMs <= 0 || assertive.text.length === 0) return
    const timer = setTimeout(() => setAssertive(EMPTY), clearAfterMs)
    return () => clearTimeout(timer)
  }, [assertive, clearAfterMs])

  return (
    <>
      <Region priority="polite" text={slotText(polite)} />
      <Region priority="assertive" text={slotText(assertive)} />
    </>
  )
}

interface RegionProps {
  priority: AnnouncePriority
  text: string
}

function Region({ priority, text }: RegionProps): ReactNode {
  const attrs = liveRegionAttrs(priority)
  return (
    <div
      className="a11y-live"
      role={attrs.role}
      aria-live={attrs.ariaLive}
      aria-atomic={attrs.ariaAtomic}
    >
      {text}
    </div>
  )
}

export default LiveRegion
