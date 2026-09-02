/**
 * 파티클 레이어의 설정 패널.
 *
 * 어떤 컨트롤이 보이고 어떤 라벨을 다는지는 particles/config.ts 의
 * specVisibleControls 한 곳에만 있다. 여기서 다시 판정하면 효과를 추가할 때마다
 * 두 곳이 어긋난다. 이 파일이 스스로 정하는 것은 "지금 값에 따라 줄을 접는 것"
 * (흐림 양이 0 이면 초점/무작위 줄을 접는다) 하나뿐이다.
 */

import { useEffect, useId, useRef } from 'react'

import { mulberry32 } from '@/core/rng.ts'
import type { Layer } from '@/core/types.ts'
import {
  CFG,
  EFFECTS,
  PALETTES,
  VIEW_NAME,
  VIEW_NOTE,
  applyQuickStyle,
  defaultParticleSpec,
  specVisibleControls,
} from '@/particles/config.ts'
import { sizeRank } from '@/particles/engine.ts'
import { particleLoops } from '@/particles/frames.ts'
import type { EffectKey, ParticleSpec, ViewKey } from '@/particles/types.ts'
import { useDocumentStore } from '@/state/document.ts'
import { NumberField, SelectField } from '@/ui/widgets/Field.tsx'

const round2 = (v: number): string => String(Math.round(v * 100) / 100)

interface SliderProps {
  label: string
  value: number
  min: number
  max: number
  step: number
  fmt?: (v: number) => string
  note?: string
  disabled?: boolean
  onChange(next: number): void
}

/** 파라미터 하나 = 슬라이더 한 줄. 이펙트 패널(mm-fx-range)과 같은 생김새다. */
function Slider({ label, value, min, max, step, fmt, note, disabled, onChange }: SliderProps) {
  const id = useId()
  return (
    <div className="mm-field">
      <label className="mm-field-label" htmlFor={id}>
        {label}
      </label>
      <span className="mm-fx-range-row">
        <input
          id={id}
          className="mm-fx-range"
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(Number(e.target.value))}
        />
        <output className="mm-fx-range-value" htmlFor={id}>
          {fmt ? fmt(value) : round2(value)}
        </output>
      </span>
      {note ? <p className="mm-field-hint">{note}</p> : null}
    </div>
  )
}

/**
 * 크기 분포 히스토그램. 지금 분포로 뽑히는 크기의 생김새를 보여 준다.
 * 표본은 시드 고정이라 슬라이더를 되돌리면 그림도 정확히 되돌아온다.
 */
function SizeHistogram({ dist }: { dist: number }) {
  const ref = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const canvas = ref.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return

    const W = canvas.width
    const H = canvas.height
    const BINS = 30
    const bins = new Array<number>(BINS).fill(0)
    const rnd = mulberry32(1)
    const N = 3000
    let sum = 0
    for (let i = 0; i < N; i += 1) {
      const v = sizeRank(rnd(), rnd(), dist)
      sum += v
      bins[Math.min(BINS - 1, Math.floor(v * BINS))]! += 1
    }
    const peak = Math.max(...bins, 1)

    ctx.clearRect(0, 0, W, H)
    const style = getComputedStyle(canvas)
    const bar = style.getPropertyValue('--border-strong').trim() || '#888'
    const accent = style.getPropertyValue('--accent').trim() || '#d4af37'
    ctx.fillStyle = bar
    const bw = W / BINS
    for (let i = 0; i < BINS; i += 1) {
      const h = (bins[i]! / peak) * (H - 2)
      ctx.fillRect(i * bw + 0.5, H - h, bw - 1, h)
    }
    // 평균 자리 표시선
    ctx.fillStyle = accent
    ctx.fillRect((sum / N) * W - 0.5, 0, 1.5, H)
  }, [dist])

  return (
    <canvas
      ref={ref}
      width={220}
      height={34}
      className="mm-ptc-hist"
      role="img"
      aria-label="크기 분포 미리보기. 왼쪽이 작은 입자."
    />
  )
}

export function ParticleSection({ layer }: { layer: Layer }) {
  const setParticleSpec = useDocumentStore((s) => s.setParticleSpec)
  const durationFrames = useDocumentStore((s) => s.doc.timeline.durationFrames)
  const fps = useDocumentStore((s) => s.doc.timeline.fps)

  const spec = layer.particle
  if (!spec) return null

  const vis = specVisibleControls(spec.effect, spec.view)
  const locked = layer.locked

  /** 같은 노브의 드래그는 실행취소 한 칸으로 묶는다. */
  const patch = (p: Partial<ParticleSpec>, knob?: string): void => {
    setParticleSpec(layer.id, { ...spec, ...p }, knob ? `ptc:${layer.id}:${knob}` : undefined)
  }

  const loops = particleLoops(spec, durationFrames, fps)
  const sec = fps > 0 ? durationFrames / fps : 0
  const cycleSec = loops > 0 ? sec / loops : sec

  const paletteKeys = [...Object.keys(PALETTES), '직접']
  const usingCustom = !(spec.palette in PALETTES)

  return (
    <section className="mm-section" aria-labelledby="mm-sec-particle">
      <h2 className="mm-section-title" id="mm-sec-particle">
        파티클
      </h2>
      <div className="mm-stack">
        <SelectField
          label="효과"
          value={spec.effect}
          options={EFFECTS.map((e) => ({ value: e, label: CFG[e].name }))}
          disabled={locked}
          ariaLabel="파티클 효과 종류"
          onChange={(e: EffectKey) =>
            // 효과를 바꾸면 그 효과의 기본값으로 시작한다. 시드는 이어 간다.
            setParticleSpec(layer.id, { ...defaultParticleSpec(e), seed: spec.seed })
          }
        />

        {/* 빠른 스타일. 어느 스타일을 거쳐 왔든 같은 버튼은 늘 같은 그림이다. */}
        {vis.styles.length > 0 ? (
          <div className="mm-field">
            <span className="mm-field-label">빠른 스타일</span>
            <div className="mm-ptc-styles" role="group" aria-label="빠른 스타일">
              {vis.styles.map((name) => (
                <button
                  key={name}
                  type="button"
                  className="mm-btn mm-ptc-style"
                  disabled={locked}
                  onClick={() => setParticleSpec(layer.id, applyQuickStyle(spec, name))}
                >
                  {name}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        <Slider
          label={vis.count.label}
          value={spec.count}
          min={vis.count.min}
          max={vis.count.max}
          step={1}
          fmt={(v) => String(Math.round(v))}
          note={spec.count >= 1500 ? '개수가 많으면 미리보기가 느려질 수 있습니다.' : undefined}
          disabled={locked}
          onChange={(v) => patch({ count: Math.round(v) }, 'count')}
        />

        {vis.size ? (
          <>
            <Slider
              label="작은 입자 크기"
              value={spec.sizeMin}
              min={0.03}
              max={3}
              step={0.01}
              disabled={locked}
              onChange={(v) => patch({ sizeMin: v, sizeMax: Math.max(v, spec.sizeMax) }, 'size')}
            />
            <Slider
              label="큰 입자 크기"
              value={spec.sizeMax}
              min={0.03}
              max={3}
              step={0.01}
              disabled={locked}
              onChange={(v) => patch({ sizeMax: v, sizeMin: Math.min(v, spec.sizeMin) }, 'size')}
            />
            <Slider
              label="크기 분포 (원근)"
              value={spec.sizeDist}
              min={0}
              max={1}
              step={0.01}
              disabled={locked}
              onChange={(v) => patch({ sizeDist: v }, 'dist')}
            />
            <SizeHistogram dist={spec.sizeDist} />
          </>
        ) : null}

        {vis.depth ? (
          <Slider
            label="깊이감"
            value={spec.depth}
            min={0}
            max={1.5}
            step={0.05}
            note="멀리 있는 입자를 어둡게 가라앉힙니다."
            disabled={locked}
            onChange={(v) => patch({ depth: v }, 'depth')}
          />
        ) : null}

        <Slider
          label="속도"
          value={spec.speed}
          min={0.25}
          max={3}
          step={0.05}
          note={`문서 ${sec.toFixed(2)}초 동안 ${loops}번 반복 (한 루프 ${cycleSec.toFixed(2)}초). 반복 이음새가 없게 정수 반복으로 맞춥니다.`}
          disabled={locked}
          onChange={(v) => patch({ speed: v }, 'speed')}
        />

        <Slider
          label="투명도"
          value={spec.opacityMul}
          min={0.05}
          max={2}
          step={0.05}
          disabled={locked}
          onChange={(v) => patch({ opacityMul: v }, 'opacity')}
        />

        {vis.angle ? (
          <Slider
            label={vis.angle.label}
            value={spec.angle}
            min={vis.angle.min}
            max={vis.angle.max}
            step={vis.angle.step}
            fmt={vis.angle.fmt}
            note={vis.angle.note || undefined}
            disabled={locked}
            onChange={(v) => patch({ angle: v }, 'angle')}
          />
        ) : null}

        {vis.variation ? (
          <Slider
            label={vis.variation.label}
            value={spec.variation}
            min={vis.variation.min}
            max={vis.variation.max}
            step={vis.variation.step}
            disabled={locked}
            onChange={(v) => patch({ variation: v }, 'variation')}
          />
        ) : null}

        {vis.gust ? (
          <Slider
            label="돌풍"
            value={spec.gust}
            min={0}
            max={1}
            step={0.02}
            disabled={locked}
            onChange={(v) => patch({ gust: v }, 'gust')}
          />
        ) : null}

        {vis.soft ? (
          <Slider
            label="부드러움"
            value={spec.soft}
            min={0}
            max={1}
            step={0.02}
            disabled={locked}
            onChange={(v) => patch({ soft: v }, 'soft')}
          />
        ) : null}

        {vis.bokeh ? (
          <Slider
            label={vis.bokeh.label}
            value={spec.bokeh}
            min={0}
            max={1}
            step={0.02}
            disabled={locked}
            onChange={(v) => patch({ bokeh: v }, 'bokeh')}
          />
        ) : null}

        {vis.ex1 ? (
          <Slider
            label={vis.ex1.label}
            value={spec.ex1}
            min={vis.ex1.min}
            max={vis.ex1.max}
            step={vis.ex1.step}
            fmt={vis.ex1.fmt}
            note={vis.ex1.note || undefined}
            disabled={locked}
            onChange={(v) => patch({ ex1: v }, 'ex1')}
          />
        ) : null}

        {vis.ex2 ? (
          <Slider
            label={vis.ex2.label}
            value={spec.ex2}
            min={vis.ex2.min}
            max={vis.ex2.max}
            step={vis.ex2.step}
            fmt={vis.ex2.fmt}
            note={vis.ex2.note || undefined}
            disabled={locked}
            onChange={(v) => patch({ ex2: v }, 'ex2')}
          />
        ) : null}

        {vis.shape ? (
          <SelectField
            label={vis.shape.label}
            value={spec.shape}
            options={vis.shape.opts.map(([value, label]) => ({ value, label }))}
            disabled={locked}
            onChange={(v) => patch({ shape: v })}
          />
        ) : null}

        <SelectField
          label="겹침 방식"
          value={spec.blend}
          options={[
            { value: 'normal', label: '보통' },
            { value: 'screen', label: '밝게 겹침 (스크린)' },
          ]}
          disabled={locked}
          onChange={(v) => patch({ blend: v })}
        />

        {/* 시점. 효과가 시점을 하나만 가지면 섹션째로 숨긴다. */}
        {vis.views.length > 1 ? (
          <>
            <SelectField
              label="시점"
              value={spec.view}
              options={vis.views.map((v: ViewKey) => ({ value: v, label: VIEW_NAME[v] }))}
              hint={VIEW_NOTE[spec.view]}
              disabled={locked}
              onChange={(v) => patch({ view: v })}
            />
            {vis.viewOpts ? (
              <>
                <Slider
                  label={vis.vpXLabel}
                  value={spec.viewX}
                  min={0}
                  max={1}
                  step={0.005}
                  disabled={locked}
                  onChange={(v) => patch({ viewX: v }, 'viewX')}
                />
                <Slider
                  label={vis.vpYLabel}
                  value={spec.viewY}
                  min={0}
                  max={1}
                  step={0.005}
                  disabled={locked}
                  onChange={(v) => patch({ viewY: v }, 'viewY')}
                />
                <Slider
                  label="원근 강도"
                  value={spec.persp}
                  min={0}
                  max={1}
                  step={0.02}
                  disabled={locked}
                  onChange={(v) => patch({ persp: v }, 'persp')}
                />
              </>
            ) : null}
            {vis.tilt ? (
              <Slider
                label="눕힘"
                value={spec.tilt}
                min={0.05}
                max={1}
                step={0.01}
                disabled={locked}
                onChange={(v) => patch({ tilt: v }, 'tilt')}
              />
            ) : null}
            {vis.vpHole ? (
              <Slider
                label="중심 비우기"
                value={spec.vpHole}
                min={0}
                max={1}
                step={0.02}
                note="소실점 근처를 비워 얼굴 자리를 지킵니다."
                disabled={locked}
                onChange={(v) => patch({ vpHole: v }, 'vpHole')}
              />
            ) : null}
          </>
        ) : null}

        {/* 피사계 심도. 초점에서 먼 쪽(가깝든 멀든)이 흐려진다. */}
        <Slider
          label="전체 흐림"
          value={spec.blurAmt}
          min={0}
          max={1}
          step={0.02}
          note="초점에서 먼 입자를 흐립니다."
          disabled={locked}
          onChange={(v) => patch({ blurAmt: v }, 'blurAmt')}
        />
        {spec.blurAmt > 0 && vis.blurFocusRand ? (
          <>
            <Slider
              label="초점 거리"
              value={spec.blurFocus}
              min={0}
              max={1}
              step={0.02}
              note="0은 먼 쪽, 1은 가까운 쪽이 또렷합니다."
              disabled={locked}
              onChange={(v) => patch({ blurFocus: v }, 'blurFocus')}
            />
            <Slider
              label="흐림 무작위"
              value={spec.blurRand}
              min={0}
              max={1}
              step={0.02}
              disabled={locked}
              onChange={(v) => patch({ blurRand: v }, 'blurRand')}
            />
          </>
        ) : null}

        {/* 색. */}
        <SelectField
          label="색 모드"
          value={spec.colorMode}
          options={[
            { value: 'single', label: '단색' },
            { value: 'palette', label: '팔레트 (다색)' },
          ]}
          disabled={locked}
          onChange={(v) => patch({ colorMode: v })}
        />
        {spec.colorMode === 'single' ? (
          <div className="mm-field mm-field-inline">
            <label className="mm-field-label" htmlFor="mm-ptc-single">
              입자 색
            </label>
            <div className="mm-field-control mm-color-row">
              <span className="mm-field-hint">{spec.single}</span>
              <input
                id="mm-ptc-single"
                className="mm-color"
                type="color"
                value={spec.single}
                disabled={locked}
                aria-label="입자 색"
                onChange={(e) => patch({ single: e.target.value }, 'single')}
              />
            </div>
          </div>
        ) : (
          <>
            <SelectField
              label="팔레트"
              value={usingCustom ? '직접' : spec.palette}
              options={paletteKeys.map((k) => ({ value: k, label: k }))}
              disabled={locked}
              onChange={(v) => patch({ palette: v })}
            />
            {usingCustom ? (
              <div className="mm-field">
                <span className="mm-field-label">직접 팔레트 (최대 8색)</span>
                <div className="mm-ptc-pal" role="group" aria-label="직접 팔레트 색">
                  {spec.customPal.map((color, i) => (
                    <input
                      key={i}
                      className="mm-color"
                      type="color"
                      value={color}
                      disabled={locked}
                      aria-label={`팔레트 색 ${i + 1}`}
                      onChange={(e) => {
                        const next = [...spec.customPal]
                        next[i] = e.target.value
                        patch({ customPal: next }, 'customPal')
                      }}
                    />
                  ))}
                  {spec.customPal.length < 8 ? (
                    <button
                      type="button"
                      className="mm-btn"
                      disabled={locked}
                      onClick={() => patch({ customPal: [...spec.customPal, '#ffffff'] })}
                    >
                      + 색 추가
                    </button>
                  ) : null}
                  {spec.customPal.length > 1 ? (
                    <button
                      type="button"
                      className="mm-btn"
                      disabled={locked}
                      onClick={() => patch({ customPal: spec.customPal.slice(0, -1) })}
                    >
                      - 빼기
                    </button>
                  ) : null}
                </div>
              </div>
            ) : null}
          </>
        )}
        <Slider
          label="색 흔들림"
          value={spec.colorVar}
          min={0}
          max={1}
          step={0.02}
          note="입자마다 밝기와 온기를 조금씩 다르게 합니다."
          disabled={locked}
          onChange={(v) => patch({ colorVar: v }, 'colorVar')}
        />

        {/* 배치 시드. 같은 값이면 언제나 같은 배치다. */}
        <div className="mm-row-2">
          <NumberField
            label="배치 시드"
            value={spec.seed}
            min={0}
            step={1}
            ariaLabel="입자 배치 시드"
            disabled={locked}
            onChange={(v) => patch({ seed: Math.round(v) }, 'seed')}
          />
          <div className="mm-field">
            <span className="mm-field-label" aria-hidden="true">
              &nbsp;
            </span>
            <button
              type="button"
              className="mm-btn"
              disabled={locked}
              onClick={() => patch({ seed: Math.floor(Math.random() * 99999) })}
            >
              다른 배치 뽑기
            </button>
          </div>
        </div>
      </div>
    </section>
  )
}

export default ParticleSection
