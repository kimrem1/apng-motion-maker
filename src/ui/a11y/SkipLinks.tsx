/**
 * 스킵 링크.
 *
 * 왜 필요한가. 지금 툴바에서 프리셋 그리드까지 Tab 으로 가려면 실측 15번 이상
 * 눌러야 한다. 실행취소 / 다시실행 / EASY / PRO / 내보내기 / 레이어 목록 /
 * 이미지 추가 / 검색 / 분류 칩 9개 / 세기 / 속도 를 전부 지나야 첫 카드에 닿는다.
 * 릴리즈 게이트는 "3단계를 Tab/Enter 만으로" 인데, 갈 수는 있어도 그 길이면
 * 아무도 안 간다. 스킵 링크가 그 세 지점을 한 번에 잇는다.
 *
 * 화면에서는 숨어 있다가 포커스를 받으면 왼쪽 위에 뜬다 (a11y.css).
 * 그래서 반드시 **앱 루트의 맨 처음** 에 놓아야 한다. Tab 을 처음 눌렀을 때
 * 가장 먼저 닿아야 뜻이 있다.
 *
 * 목적지를 id 가 아니라 후보 선택자 목록으로 잡는 이유:
 * 지금 App.tsx / Toolbar.tsx / PresetGallery.tsx 에는 이 링크가 겨냥할 id 가
 * 하나도 없다. 그 파일들은 이 작업의 담당이 아니다. 그래서 현재 마크업에
 * 이미 있는 것(main 요소, .mm-preset-grid, 툴바의 기본 버튼)으로 먼저 찾고,
 * 나중에 통합 담당이 정식 id 를 붙이면 그쪽이 먼저 잡히게 순서를 두었다.
 * 마크업이 바뀌어도 링크가 조용히 죽지 않는다.
 */

import { useCallback, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'

import { announce } from './announce.ts'

import './a11y.css'

/**
 * 통합 담당이 붙여 주면 가장 먼저 잡히는 id.
 * 이 값들을 각 컴포넌트의 컨테이너에 그대로 달면 된다.
 */
export const SKIP_TARGET_IDS = {
  main: 'mm-main',
  presets: 'mm-preset-list',
  export: 'mm-export-action',
} as const

export interface SkipLinkItem {
  /** 링크에 보이는 글자. 목적지를 말해야 한다. "건너뛰기" 만 있으면 어디로 가는지 모른다. */
  label: string
  /** 앵커 href 에 쓸 id. 아직 DOM 에 없어도 된다. */
  targetId: string
  /** 위에서부터 먼저 맞는 것을 쓴다. */
  selectors: readonly string[]
  /** 못 찾았을 때 낭독기에 알릴 말. */
  missingMessage: string
}

/**
 * 3단계 경로: 이미지(본문) -> 프리셋 -> 내보내기.
 * 순서는 그 경로 순서 그대로다. 목록 순서가 곧 안내다.
 */
export const DEFAULT_SKIP_LINKS: readonly SkipLinkItem[] = [
  {
    label: '본문으로 건너뛰기',
    targetId: SKIP_TARGET_IDS.main,
    selectors: ['#mm-main', 'main.mm-app-stage', 'main', '.mm-app-stage'],
    missingMessage: '본문을 찾지 못했습니다.',
  },
  {
    label: '모션 프리셋 목록으로',
    targetId: SKIP_TARGET_IDS.presets,
    selectors: [
      '#mm-preset-list',
      // 로빙 tabindex 의 현재 진입점. 있으면 카드에 바로 내려앉는다.
      '.mm-preset-grid:not(.is-compare) [role="option"][tabindex="0"]',
      '.mm-preset-grid:not(.is-compare)',
      '.mm-preset-gallery input[type="search"]',
      '.mm-preset-gallery',
    ],
    missingMessage: '모션 목록을 찾지 못했습니다. 먼저 이미지를 넣어 주세요.',
  },
  {
    label: '내보내기로',
    targetId: SKIP_TARGET_IDS.export,
    selectors: [
      '#mm-export-action',
      '.mm-toolbar-right .mm-btn-primary',
      '.mm-toolbar .mm-btn-primary',
    ],
    missingMessage: '내보내기 버튼을 찾지 못했습니다.',
  },
]

/** 원래 포커스를 받을 수 있는 요소인가. 아니면 임시로 tabindex 를 빌려 준다. */
const NATIVELY_FOCUSABLE =
  'a[href], button, input, select, textarea, summary, [tabindex], [contenteditable]'

function resolve(selectors: readonly string[]): HTMLElement | null {
  if (typeof document === 'undefined') return null
  for (const selector of selectors) {
    const el = document.querySelector<HTMLElement>(selector)
    // 화면에 없는 요소로 보내면 포커스가 사라진다. 렌더 여부까지 확인한다.
    if (el && el.offsetParent !== null) return el
  }
  return null
}

/**
 * 목적지에 실제로 포커스를 준다.
 *
 * 컨테이너(section, main, ul)는 원래 포커스를 못 받는다. tabindex="-1" 을 잠깐
 * 빌려 주고 포커스가 떠날 때 되돌린다. 영구히 남기면 그 컨테이너가 Tab 순서에는
 * 없으면서 클릭 시 포커스를 훔치는 이상한 요소가 된다.
 *
 * data-a11y-landed 는 도착 지점을 한 번 보여 주는 표시다 (a11y.css).
 * 강제 포커스한 컨테이너에는 :focus-visible 이 안 붙어서, 그냥 두면
 * 보이는 키보드 사용자가 자기가 어디로 왔는지 모른다.
 */
function land(el: HTMLElement): void {
  const borrowed = !el.matches(NATIVELY_FOCUSABLE)
  if (borrowed) el.setAttribute('tabindex', '-1')
  el.dataset['a11yLanded'] = 'true'

  // 스크롤은 우리가 정한다. 브라우저 기본 스크롤은 패널을 통째로 밀어 버린다.
  el.focus({ preventScroll: true })
  el.scrollIntoView({ block: 'nearest', inline: 'nearest' })

  const cleanup = (): void => {
    delete el.dataset['a11yLanded']
    if (borrowed) el.removeAttribute('tabindex')
    el.removeEventListener('blur', cleanup)
  }
  el.addEventListener('blur', cleanup)
}

export interface SkipLinksProps {
  /** 기본 3개 대신 다른 목록을 쓸 때. */
  items?: readonly SkipLinkItem[]
}

export function SkipLinks({ items = DEFAULT_SKIP_LINKS }: SkipLinksProps): ReactNode {
  const go = useCallback((item: SkipLinkItem, e: ReactMouseEvent<HTMLAnchorElement>) => {
    // href 는 진짜 앵커로 남겨 두되 이동은 우리가 한다. 브라우저 기본 점프는
    // 해시를 주소창에 남기고, 포커스는 옮기지 않는 브라우저가 아직 있다.
    e.preventDefault()
    const target = resolve(item.selectors)
    if (!target) {
      // 조용히 실패하면 사용자는 링크가 고장 난 줄 안다.
      announce(item.missingMessage, 'assertive')
      return
    }
    land(target)
  }, [])

  return (
    <nav className="a11y-skip" aria-label="건너뛰기">
      {items.map((item) => (
        <a
          key={item.targetId}
          className="a11y-skip-link"
          href={`#${item.targetId}`}
          onClick={(e) => go(item, e)}
        >
          {item.label}
        </a>
      ))}
    </nav>
  )
}

export default SkipLinks
