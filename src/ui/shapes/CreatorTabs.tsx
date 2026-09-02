/**
 * 만들기 도구 전환.
 *
 * 모션 갤러리와 도형 패널을 한 자리에서 번갈아 보여 준다. 세로로 쌓지 않는 이유는
 * 왼쪽 도크 높이가 이미 레이어 목록과 나뉘어 있어서, 셋으로 쪼개면 어느 것도
 * 쓸 만한 높이가 남지 않기 때문이다.
 *
 * 고른 탭은 화면 상태에 남는다. EASY 와 PRO 를 오갈 때 탭이 되돌아가면 방금 쓰던
 * 도구를 매번 다시 찾아야 한다.
 */

import { useRef, type KeyboardEvent as ReactKeyboardEvent } from 'react'

import { PresetGallery } from '@/ui/presets/PresetGallery.tsx'
import { useShapeUiStore, type CreatorTab } from '@/state/shapeUi.ts'
import { CutPanel } from '@/ui/cuts/CutPanel.tsx'
import { TextGallery } from '@/ui/text/TextGallery.tsx'
import { ParticleGallery } from '@/ui/particles/ParticleGallery.tsx'
import { ShapeGallery } from './ShapeGallery.tsx'
import './shapes.css'

const TABS: readonly { id: CreatorTab; label: string }[] = [
  { id: 'motion', label: '모션' },
  { id: 'shape', label: '도형' },
  { id: 'text', label: '글자' },
  { id: 'particle', label: '파티클' },
  { id: 'cut', label: '컷' },
]

export function CreatorTabs() {
  const tab = useShapeUiStore((s) => s.tab)
  const setTab = useShapeUiStore((s) => s.setTab)
  const listRef = useRef<HTMLDivElement | null>(null)

  /**
   * 탭 줄의 키보드 이동.
   *
   * role="tab" 을 쓰면 화살표로 옮겨 다니는 것이 규약이다. 탭이 둘뿐이라도
   * 규약을 지켜야 낭독기가 "2개 중 1번째" 를 제대로 읽는다. 선택된 탭 하나만
   * Tab 순서에 남기고(로빙 tabindex), 나머지는 화살표로 간다.
   */
  function onKeyDown(e: ReactKeyboardEvent<HTMLDivElement>): void {
    const index = TABS.findIndex((t) => t.id === tab)
    let next = index
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (index + 1) % TABS.length
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (index - 1 + TABS.length) % TABS.length
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = TABS.length - 1
    else return

    e.preventDefault()
    const target = TABS[next]
    if (!target) return
    setTab(target.id)
    // 상태가 반영된 뒤에 포커스를 옮긴다. 옮기지 않으면 화살표를 한 번 더 눌러도
    // 같은 버튼에 머문다.
    requestAnimationFrame(() => {
      listRef.current?.querySelector<HTMLElement>(`#mm-tab-${target.id}`)?.focus()
    })
  }

  return (
    <div className="mm-dock-panels">
      <div
        ref={listRef}
        className="mm-dock-tabs"
        role="tablist"
        aria-label="만들기 도구"
        onKeyDown={onKeyDown}
      >
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            id={`mm-tab-${item.id}`}
            className="mm-dock-tab"
            aria-selected={tab === item.id}
            aria-controls="mm-tabpanel-creator"
            tabIndex={tab === item.id ? 0 : -1}
            onClick={() => setTab(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div
        id="mm-tabpanel-creator"
        role="tabpanel"
        className="mm-dock-panel-body"
        aria-labelledby={`mm-tab-${tab}`}
      >
        {tab === 'motion' ? (
          <PresetGallery />
        ) : tab === 'shape' ? (
          <ShapeGallery />
        ) : tab === 'text' ? (
          <TextGallery />
        ) : tab === 'particle' ? (
          <ParticleGallery />
        ) : (
          <CutPanel />
        )}
      </div>
    </div>
  )
}

export default CreatorTabs
