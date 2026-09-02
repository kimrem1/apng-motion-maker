/**
 * 파티클 갤러리. 효과 하나를 고르면 그 기본값으로 레이어 한 장이 들어간다.
 *
 * 세부 조정(개수 / 크기 / 속도 / 시점 / 색 등 전부)은 인스펙터의 파티클 섹션이
 * 맡는다. 갤러리는 넣는 곳, 인스펙터는 다듬는 곳 — 도형 / 글자와 같은 분업이다.
 */

import { CFG, EFFECTS } from '@/particles/config.ts'
import type { EffectKey } from '@/particles/types.ts'
import { addParticleLayer } from '@/state/particleActions.ts'
import { useUiStore } from '@/state/ui.ts'

/** 효과마다 다른 작은 글리프. 사진 없이도 무엇인지 짚이게 한다. */
const GLYPHS: Record<EffectKey, string> = {
  rain: '︳︳',
  snow: '❆',
  dust: '⋯',
  flare: '☀',
  sparkle: '✦',
  petal: '❀',
  fog: '≋',
  firefly: '⁘',
  bokeh: '◉',
  ripple: '◎',
  caustic: '𓂃',
  bloom: '✿',
}

export function ParticleGallery() {
  const setPlaying = useUiStore((s) => s.setPlaying)

  function handleAdd(effect: EffectKey): void {
    const layerId = addParticleLayer(effect)
    // 넣자마자 움직이는 것을 보여 준다. 멈춘 파티클은 "아무 일도 안 일어났다" 로 보인다.
    if (layerId) setPlaying(true)
  }

  return (
    <section className="mm-shape-panel" aria-labelledby="mm-particle-title">
      <h2 className="mm-section-title" id="mm-particle-title">
        파티클
      </h2>

      <div className="mm-shape-kinds" role="group" aria-label="파티클 넣기">
        {EFFECTS.map((effect) => (
          <button
            key={effect}
            type="button"
            className="mm-shape-kind"
            title={`${CFG[effect].name} 넣기`}
            onClick={() => handleAdd(effect)}
          >
            <span aria-hidden="true">{GLYPHS[effect]}</span>
            <span>{CFG[effect].name}</span>
          </button>
        ))}
      </div>

      <p className="mm-shape-help">
        효과를 넣으면 캔버스 전체를 덮는 오버레이 레이어가 생깁니다. 개수 / 크기 / 속도 /
        시점 / 색 같은 세부 조정은 오른쪽 <strong>인스펙터</strong> 의 파티클 섹션에서 합니다.
      </p>
    </section>
  )
}

export default ParticleGallery
