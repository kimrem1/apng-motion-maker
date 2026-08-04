/**
 * 글자 패널.
 *
 * 하는 일은 두 가지뿐이다. 글자 한 장 넣기, 그리고 지금 고른 글자 레이어의 등장
 * 모양을 한 번에 바꾸기. 세밀한 조정은 인스펙터의 글자 섹션이 맡는다.
 *
 * 모션은 여기서 고르지 않는다. 글자 레이어도 다른 레이어와 똑같은 트랙 위에 있어서
 * `모션` 탭의 프리셋이 전부 그대로 걸린다. 글자 전용 프리셋 18종은 그 갤러리의
 * `글자` 카테고리에 있다.
 */

import { useState } from 'react'

import { CHAR_IN_LABELS } from '@/core/charAnim.ts'
import { CHAR_IN_MODE_LIST, type CharInMode } from '@/core/types.ts'
import { useDocumentStore } from '@/state/document.ts'
import { useLayerUiStore } from '@/state/layerUi.ts'
import { addTextLayer } from '@/state/textActions.ts'
import './text.css'

/** 카드에 그리는 화살표. 어느 쪽에서 들어오는지 한눈에 보이게 한다. */
const ARROWS: Partial<Record<CharInMode, string>> = {
  left: '→',
  right: '←',
  up: '↓',
  down: '↑',
  sides: '→←',
  updown: '↓↑',
  scatter: '✳',
  zoom: '⤢',
  shrink: '⤡',
  drop: '↧',
  spin: '↻',
  flip: '⇋',
  typewriter: '|',
  fade: '◍',
  wave: '〜',
}

export function TextGallery() {
  const layers = useDocumentStore((s) => s.doc.layers)
  const setLayerCharAnim = useDocumentStore((s) => s.setLayerCharAnim)
  const selectedIds = useLayerUiStore((s) => s.selectedLayerIds)

  const [busy, setBusy] = useState(false)

  // 고른 것 중 글자 레이어만. 없으면 문서의 마지막 글자 레이어를 대신 본다.
  const selectedText = layers.filter((l) => l.text && selectedIds.includes(l.id))
  const fallback = layers.filter((l) => l.text).slice(-1)
  const targets = selectedText.length > 0 ? selectedText : fallback
  const current = targets[0]?.charAnim?.mode ?? 'none'

  async function handleAdd(): Promise<void> {
    setBusy(true)
    try {
      await addTextLayer()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mm-text-panel">
      <button
        type="button"
        className="mm-btn mm-btn-primary mm-btn-block"
        disabled={busy}
        onClick={() => {
          void handleAdd()
        }}
      >
        {busy ? '넣는 중' : '글자 넣기'}
      </button>
      <p className="mm-text-hint">
        넣은 다음 내용과 글꼴은 인스펙터 &gt; 글자 에서 바꿉니다. 모션 탭의 프리셋도 그대로
        걸립니다.
      </p>

      <h3 className="mm-text-head">글자가 들어오는 방향</h3>
      {targets.length === 0 ? (
        <p className="mm-text-hint">글자를 먼저 넣으면 여기서 방향을 고를 수 있습니다.</p>
      ) : (
        <div className="mm-text-grid" role="group" aria-label="글자가 들어오는 방향">
          {CHAR_IN_MODE_LIST.map((mode) => (
            <button
              key={mode}
              type="button"
              className="mm-text-card"
              aria-pressed={current === mode}
              title={CHAR_IN_LABELS[mode]}
              onClick={() => {
                for (const layer of targets) setLayerCharAnim(layer.id, { mode })
              }}
            >
              <span className="mm-text-card-glyph" aria-hidden="true">
                {ARROWS[mode] ?? '·'}
              </span>
              <span className="mm-text-card-label">{CHAR_IN_LABELS[mode]}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export default TextGallery
