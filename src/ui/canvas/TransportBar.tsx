/**
 * 재생 컨트롤.
 *
 * 아이콘은 인라인 SVG 다. 아이콘 라이브러리를 넣지 않는다(의존성 0 유지).
 * 현재 프레임 표시는 UI 스토어를 읽는다. 재생 중 이 값은 useRenderer 가
 * 100ms 마다 반영하므로, 이 컴포넌트가 rAF 마다 리렌더되지 않는다.
 */

import type { ReactNode } from 'react'

import { FPS_CHOICES, FRAMES_MAX, type LoopMode } from '@/core/types.ts'
import { frameToSec, isGifExactFps } from '@/core/time.ts'
import { useDocumentStore } from '@/state/document.ts'
import { useUiStore } from '@/state/ui.ts'

/** GIF 로 정확히 표현되지 않는 fps 안내 문구. */
const GIF_INEXACT_HINT = '움직임이 아주 살짝 덜 부드러워집니다'

const LOOP_LABELS: Record<LoopMode, string> = {
  once: '한 번만',
  loop: '반복',
  pingPong: '왕복',
  loopWithHold: '반복 + 끝에서 멈춤',
}

const LOOP_ORDER: LoopMode[] = ['loop', 'pingPong', 'once', 'loopWithHold']

const TRANSPORT_CSS = `
.transport {
  display: flex;
  align-items: center;
  gap: var(--sp-4);
  padding: var(--sp-2) var(--sp-4);
  border-top: 1px solid var(--border);
  background: var(--surface);
}

.transport__play {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 32px;
  height: 32px;
  padding: 0;
  border: 1px solid var(--border-strong);
  border-radius: var(--r-md);
  background: var(--surface-raised);
  color: var(--text);
  transition:
    background var(--dur-fast) var(--ease-standard),
    border-color var(--dur-fast) var(--ease-standard);
}

.transport__play:hover {
  background: var(--surface-hover);
  border-color: var(--accent);
}

.transport__time {
  font-family: var(--font-mono);
  font-size: var(--fs-sm);
  font-variant-numeric: tabular-nums;
  color: var(--text);
  white-space: nowrap;
}

.transport__time-total {
  color: var(--text-faint);
}

.transport__fields {
  display: flex;
  align-items: center;
  gap: var(--sp-4);
  margin-left: auto;
}

.transport__field {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}

.transport__field .mm-field-label {
  white-space: nowrap;
}

.transport__select {
  width: auto;
  min-width: 88px;
}

.transport__frames {
  width: 76px;
}

.transport__gifmark {
  color: var(--warn);
  font-size: var(--fs-xs);
  cursor: help;
}
`

function PlayIcon(): ReactNode {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
      <path d="M5 3.2v9.6L12.6 8z" fill="currentColor" />
    </svg>
  )
}

function PauseIcon(): ReactNode {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
      <rect x="4" y="3" width="3" height="10" rx="1" fill="currentColor" />
      <rect x="9" y="3" width="3" height="10" rx="1" fill="currentColor" />
    </svg>
  )
}

/** 00:01.20 형식. 1/100초 단위까지 보여준다(GIF 격자와 같은 단위다). */
function formatClock(sec: number): string {
  const centis = Math.max(0, Math.round(sec * 100))
  const m = Math.floor(centis / 6000)
  const s = Math.floor(centis / 100) % 60
  const c = centis % 100
  const pad = (n: number): string => n.toString().padStart(2, '0')
  return `${pad(m)}:${pad(s)}.${pad(c)}`
}

export function TransportBar(): ReactNode {
  const fps = useDocumentStore((s) => s.doc.timeline.fps)
  const durationFrames = useDocumentStore((s) => s.doc.timeline.durationFrames)
  const loopMode = useDocumentStore((s) => s.doc.timeline.loop.mode)
  const setFps = useDocumentStore((s) => s.setFps)
  const setDurationFrames = useDocumentStore((s) => s.setDurationFrames)
  const setLoopMode = useDocumentStore((s) => s.setLoopMode)

  const playing = useUiStore((s) => s.playing)
  const togglePlaying = useUiStore((s) => s.togglePlaying)
  const frame = useUiStore((s) => s.playheadFrame)

  const currentSec = frameToSec(frame, fps)
  const totalSec = frameToSec(durationFrames, fps)
  const gifExact = isGifExactFps(fps)

  return (
    <div className="transport">
      <style href="mm-transport-bar" precedence="default">
        {TRANSPORT_CSS}
      </style>

      <button
        type="button"
        className="transport__play"
        onClick={togglePlaying}
        aria-label={playing ? '정지' : '재생'}
        title={playing ? '정지 (Space)' : '재생 (Space)'}
      >
        {playing ? <PauseIcon /> : <PlayIcon />}
      </button>

      <span className="transport__time">
        {formatClock(currentSec)}
        <span className="transport__time-total"> / {formatClock(totalSec)}</span>
      </span>

      <div className="transport__fields">
        <label className="transport__field">
          <span className="mm-field-label">속도</span>
          <select
            className="mm-select transport__select"
            value={fps}
            onChange={(e) => setFps(Number(e.target.value))}
          >
            {FPS_CHOICES.map((choice) => (
              <option key={choice} value={choice}>
                {choice} fps{isGifExactFps(choice) ? '' : ' *'}
              </option>
            ))}
          </select>
        </label>

        {/* GIF 는 1/100초 격자라 24 / 30 fps 는 정확히 표현되지 않는다. */}
        {!gifExact && (
          <span className="transport__gifmark" title={GIF_INEXACT_HINT} aria-hidden="true">
            *
          </span>
        )}
        {!gifExact && <span className="mm-visually-hidden">GIF: {GIF_INEXACT_HINT}</span>}

        <label className="transport__field">
          <span className="mm-field-label">길이</span>
          <input
            className="mm-input transport__frames"
            type="number"
            min={2}
            max={FRAMES_MAX}
            step={1}
            value={durationFrames}
            onChange={(e) => {
              // Number('') 은 NaN 이 아니라 0 이다. 빈 문자열을 그냥 넘기면
              // 스토어의 clamp 가 2 로 만들어 사용자가 지우던 값이 파괴된다.
              const raw = e.target.value.trim()
              if (raw === '') return
              const n = Number(raw)
              if (Number.isFinite(n)) setDurationFrames(n)
            }}
          />
          <span className="mm-field-label">프레임</span>
        </label>

        <label className="transport__field">
          <span className="mm-field-label">반복</span>
          <select
            className="mm-select transport__select"
            value={loopMode}
            onChange={(e) => setLoopMode(e.target.value as LoopMode)}
          >
            {LOOP_ORDER.map((mode) => (
              <option key={mode} value={mode}>
                {LOOP_LABELS[mode]}
              </option>
            ))}
          </select>
        </label>
      </div>
    </div>
  )
}
