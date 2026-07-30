/**
 * 도형 패널의 그림 조각들.
 *
 * 세트 카드의 그림은 실제 렌더러로 굽지 않는다. 프리셋 카드가 그렇게 하는 이유는
 * "지금 내 이미지가 어떻게 움직이는가" 를 보여 줘야 하기 때문인데, 도형 세트는
 * 문서와 무관하게 언제나 같은 모양이라 정지 그림 하나로 충분하다. 대신 카드
 * 스무 장이 동시에 GL 을 두드리지 않아 목록이 즉시 뜬다.
 *
 * 색은 전부 currentColor 다. 테마가 바뀌어도 따라온다.
 */

import type { ShapeKind } from '@/core/types.ts'
import type { ShapeSceneGroup } from '@/shapes/types.ts'

export function ShapeKindIcon({ kind }: { kind: ShapeKind }) {
  const common = { fill: 'currentColor' } as const
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
      {kind === 'rect' ? <rect x="4" y="4" width="16" height="16" rx="4" {...common} /> : null}
      {kind === 'circle' ? <circle cx="12" cy="12" r="8" {...common} /> : null}
      {kind === 'triangle' ? <path d="M12 4 L20.5 19 L3.5 19 Z" {...common} /> : null}
      {kind === 'polygon' ? (
        <path d="M12 3.5 L19.4 7.75 L19.4 16.25 L12 20.5 L4.6 16.25 L4.6 7.75 Z" {...common} />
      ) : null}
      {kind === 'star' ? (
        <path d="M12 3 L14.5 9.4 L21.2 9.8 L16 14 L17.7 20.5 L12 16.8 L6.3 20.5 L8 14 L2.8 9.8 L9.5 9.4 Z" {...common} />
      ) : null}
      {kind === 'cross' ? (
        <path d="M9.6 3.5h4.8v6.1h6.1v4.8h-6.1v6.1H9.6v-6.1H3.5V9.6h6.1z" {...common} />
      ) : null}
      {kind === 'arc' ? <path d="M12 12 L12 3 A9 9 0 0 1 20.1 15.2 Z" {...common} /> : null}
    </svg>
  )
}

/** 세트 카드의 그림. 묶음마다 성격이 드러나는 정지 화면 하나씩이다. */
export function SceneGlyph({ group }: { group: ShapeSceneGroup }) {
  return (
    <svg viewBox="0 0 48 32" className="mm-shape-glyph" aria-hidden="true">
      {group === 'pulse' ? (
        <g fill="none" stroke="currentColor">
          <circle cx="24" cy="16" r="4" fill="currentColor" stroke="none" />
          <circle cx="24" cy="16" r="8" strokeWidth="1.6" opacity="0.6" />
          <circle cx="24" cy="16" r="12.5" strokeWidth="1.4" opacity="0.28" />
        </g>
      ) : null}

      {group === 'bars' ? (
        <g fill="currentColor">
          <rect x="9" y="18" width="4" height="9" rx="2" opacity="0.55" />
          <rect x="16" y="9" width="4" height="18" rx="2" />
          <rect x="23" y="14" width="4" height="13" rx="2" opacity="0.8" />
          <rect x="30" y="5" width="4" height="22" rx="2" opacity="0.65" />
          <rect x="37" y="17" width="4" height="10" rx="2" opacity="0.45" />
        </g>
      ) : null}

      {group === 'wipe' ? (
        <g fill="currentColor">
          <rect x="4" y="6" width="18" height="20" rx="2" opacity="0.85" />
          <rect x="25" y="6" width="7" height="20" rx="2" opacity="0.5" />
          <rect x="35" y="6" width="4" height="20" rx="2" opacity="0.25" />
        </g>
      ) : null}

      {group === 'spin' ? (
        <g>
          <rect
            x="16"
            y="8"
            width="16"
            height="16"
            rx="3"
            fill="currentColor"
            transform="rotate(20 24 16)"
          />
          <path
            d="M9 16a15 15 0 0 1 8-13.2"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            opacity="0.55"
          />
        </g>
      ) : null}

      {group === 'accent' ? (
        <g fill="currentColor">
          <path d="M24 5 L26.6 13 L34.5 13 L28.2 17.8 L30.6 25.5 L24 20.7 L17.4 25.5 L19.8 17.8 L13.5 13 L21.4 13 Z" />
          <circle cx="9" cy="8" r="2" opacity="0.6" />
          <circle cx="39" cy="22" r="2.6" opacity="0.45" />
        </g>
      ) : null}

      {group === 'ambient' ? (
        <g fill="currentColor">
          <circle cx="11" cy="11" r="5" opacity="0.35" />
          <circle cx="28" cy="21" r="7" opacity="0.28" />
          <circle cx="38" cy="9" r="3.4" opacity="0.5" />
          <rect x="18" y="4" width="4" height="4" rx="1" opacity="0.45" transform="rotate(25 20 6)" />
        </g>
      ) : null}
    </svg>
  )
}
