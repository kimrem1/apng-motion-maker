/**
 * 도형 패널.
 *
 * 두 층으로 나눈다.
 *
 *   1. 도형 하나 넣기. 넣기만 하고 움직이지 않는다. 그 다음에 모션 갤러리에서
 *      아무 모션이나 고르면 그대로 얹힌다. 도형 레이어는 이미지 레이어와 완전히
 *      같은 트랙 위에 있으므로 모션 프리셋이 전부 그냥 걸린다.
 *   2. 도형 모션 세트. 도형 여러 장과 그 위상차까지 한 번에 만든다. 물결 파동이나
 *      음악 막대처럼 한 장으로는 성립하지 않는 것들이다.
 *
 * 색과 세기와 속도는 세트를 만들 때 쓰는 값이고, 방금 넣은 세트에 실시간으로
 * 반영된다. 이미 다른 작업을 한 뒤라면 다시 카드를 눌러야 한다.
 */

import { useMemo, useState } from 'react'

import { SHAPE_KIND_LABELS, toHex6 } from '@/core/shape.ts'
import { SHAPE_KIND_LIST, type ShapeKind } from '@/core/types.ts'
import { useDocumentStore } from '@/state/document.ts'
// 속도 눈금은 모션 갤러리와 같은 것을 쓴다. 같은 로그 눈금을 두 벌 두면 두 슬라이더가
// 같은 자리에서 다른 배수를 뜻하게 된다.
import { SPEED_STEP, pFromSpeed, speedFromPSnapped } from '@/state/speedScale.ts'
import {
  addSingleShape,
  applyShapeScene,
  commitShapeSceneNow,
  reapplyShapeSceneSoon,
} from '@/state/shapeActions.ts'
import { useShapeUiStore, type ShapeGroupFilter } from '@/state/shapeUi.ts'
import { useUiStore } from '@/state/ui.ts'
import { SHAPE_SCENES } from '@/shapes/registry.ts'
import { SHAPE_GROUP_LABELS, SHAPE_GROUP_ORDER } from '@/shapes/types.ts'
import { SceneGlyph, ShapeKindIcon } from './ShapeGlyphs.tsx'
import './shapes.css'

export function ShapeGallery() {
  const group = useShapeUiStore((s) => s.group)
  const setGroup = useShapeUiStore((s) => s.setGroup)
  const color = useShapeUiStore((s) => s.color)
  const setColor = useShapeUiStore((s) => s.setColor)
  const strength = useShapeUiStore((s) => s.strength)
  const setStrength = useShapeUiStore((s) => s.setStrength)
  const speed = useShapeUiStore((s) => s.speed)
  const setSpeed = useShapeUiStore((s) => s.setSpeed)
  const applied = useShapeUiStore((s) => s.applied)

  const layers = useDocumentStore((s) => s.doc.layers)
  const setPlaying = useUiStore((s) => s.setPlaying)
  const [notice, setNotice] = useState<string | null>(null)

  const layerCount = layers.length
  /**
   * 이 세트가 이미 있는 타임라인에 얹히는가.
   *
   * 그러면 문서 길이는 그 타임라인을 따른다. 속도는 그 안에서 세트의 주기를 몇 번
   * 반복할지를 정한다(shapes/shared.ts timingOf). 안내 문구를 고르는 데만 쓴다.
   * 예전에는 이 값으로 속도 슬라이더를 잠갔는데, 이미지를 한 장만 올려도 노브가
   * 영영 안 열려서 "속도를 조절할 수 없다" 가 됐다.
   */
  const fitsExisting = useMemo(() => {
    const ids = new Set(applied?.layerIds ?? [])
    return layers.some((l) => !ids.has(l.id))
  }, [layers, applied])

  const visible = useMemo(
    () => (group === 'all' ? SHAPE_SCENES : SHAPE_SCENES.filter((s) => s.group === group)),
    [group],
  )

  function handleScene(sceneId: string): void {
    const report = applyShapeScene(sceneId)
    // 뺀 경우에도 할 말이 있다. 아무 안내 없이 레이어만 사라지면 사고로 읽힌다.
    setNotice(report.ok && !report.removed ? null : (report.message ?? '넣지 못했습니다.'))
    // 넣자마자 움직이는 것을 보여 준다. 여러 세트는 0프레임에서 투명해서
    // 멈춘 채로 두면 "아무 일도 안 일어났다" 로 보인다.
    if (report.ok && !report.removed) setPlaying(true)
  }

  return (
    <section className="mm-shape-panel" aria-labelledby="mm-shape-title">
      <h2 className="mm-section-title" id="mm-shape-title">
        도형
      </h2>

      <div className="mm-shape-kinds" role="group" aria-label="도형 하나 넣기">
        {SHAPE_KIND_LIST.map((kind: ShapeKind) => (
          <button
            key={kind}
            type="button"
            className="mm-shape-kind"
            title={`${SHAPE_KIND_LABELS[kind]} 넣기`}
            onClick={() => addSingleShape(kind)}
          >
            <ShapeKindIcon kind={kind} />
            <span>{SHAPE_KIND_LABELS[kind]}</span>
          </button>
        ))}
      </div>

      <p className="mm-shape-help">
        도형을 하나 넣고 위쪽 <strong>모션</strong> 에서 움직임을 고르면 그대로 얹힙니다.
        아래 세트는 도형 여러 개와 시간차까지 한 번에 만듭니다.
      </p>

      <div className="mm-shape-knobs">
        <div className="mm-field mm-field-inline mm-shape-color">
          <label className="mm-field-label" htmlFor="mm-shape-color">
            도형 색
          </label>
          <div className="mm-field-control mm-color-row">
            <span className="mm-field-hint">{toHex6(color)}</span>
            <input
              id="mm-shape-color"
              className="mm-color"
              type="color"
              value={toHex6(color)}
              aria-label="도형 색"
              onChange={(e) => {
                setColor(e.target.value)
                reapplyShapeSceneSoon(setNotice)
              }}
              onBlur={() => commitShapeSceneNow(setNotice)}
            />
          </div>
        </div>

        <label
          className="mm-field mm-shape-knob"
          title={applied ? undefined : '세트를 먼저 고르면 조절할 수 있습니다'}
        >
          <span className="mm-field-label">도형 세기</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={strength}
            disabled={!applied}
            aria-label="도형 세트 세기"
            onChange={(e) => {
              setStrength(Number(e.target.value))
              reapplyShapeSceneSoon(setNotice)
            }}
            onPointerUp={() => commitShapeSceneNow(setNotice)}
            onKeyUp={() => commitShapeSceneNow(setNotice)}
            onBlur={() => commitShapeSceneNow(setNotice)}
          />
        </label>

        <label
          className="mm-field mm-shape-knob"
          title={applied ? undefined : '세트를 먼저 고르면 조절할 수 있습니다'}
        >
          <span className="mm-field-label">도형 속도</span>
          <input
            type="range"
            min={0}
            max={1}
            step={SPEED_STEP}
            value={pFromSpeed(speed)}
            disabled={!applied}
            aria-label="도형 세트 속도"
            onChange={(e) => {
              setSpeed(speedFromPSnapped(Number(e.target.value)))
              reapplyShapeSceneSoon(setNotice)
            }}
            onPointerUp={() => commitShapeSceneNow(setNotice)}
            onKeyUp={() => commitShapeSceneNow(setNotice)}
            onBlur={() => commitShapeSceneNow(setNotice)}
          />
        </label>
      </div>

      {/*
        노브의 적용 범위를 화면에 적어 둔다. 세트를 고르기 전에는 세기/속도가
        아무 일도 하지 않는데, 안내가 없으면 사용자는 기능이 고장 난 것으로 읽는다.
      */}
      <p className="mm-shape-help">
        {applied
          ? fitsExisting
            ? '색과 세기와 속도는 방금 넣은 세트에 바로 반영됩니다. 전체 길이는 이미 만들어 둔 타임라인을 그대로 두고, 속도는 그 안에서 세트가 몇 번 반복할지를 정합니다.'
            : '색과 세기와 속도는 방금 넣은 세트에 바로 반영됩니다. 세트를 손보면 그때부터는 카드를 다시 눌러야 합니다.'
          : '세트를 고르면 세기와 속도를 여기서 조절할 수 있습니다. 색은 다음에 넣을 도형에 쓰입니다.'}
      </p>

      <div className="mm-preset-chips" role="group" aria-label="도형 세트 분류">
        <button
          type="button"
          className="mm-chip"
          aria-pressed={group === 'all'}
          onClick={() => setGroup('all')}
        >
          전체
        </button>
        {SHAPE_GROUP_ORDER.map((value) => (
          <button
            key={value}
            type="button"
            className="mm-chip"
            aria-pressed={group === value}
            onClick={() => setGroup(value as ShapeGroupFilter)}
          >
            {SHAPE_GROUP_LABELS[value]}
          </button>
        ))}
      </div>

      {notice ? (
        <p className="mm-preset-notice" role="status">
          {notice}
        </p>
      ) : null}

      <ul className="mm-shape-grid">
        {visible.map((scene) => {
          const isApplied = applied?.sceneId === scene.id
          return (
            <li key={scene.id}>
              <button
                type="button"
                className={isApplied ? 'mm-shape-card is-applied' : 'mm-shape-card'}
                aria-pressed={isApplied}
                title={isApplied ? '한 번 더 누르면 뺍니다' : scene.hint}
                onClick={() => handleScene(scene.id)}
              >
                <SceneGlyph group={scene.group} />
                <span className="mm-shape-card-name">{scene.label}</span>
                <span className="mm-shape-card-hint">{scene.hint}</span>
                {scene.covers ? (
                  <span className="mm-shape-card-badge">화면을 덮습니다</span>
                ) : null}
              </button>
            </li>
          )
        })}
      </ul>

      {layerCount === 0 ? (
        <p className="mm-shape-help">
          이미지가 없어도 됩니다. 도형만으로 만들어 바로 내보낼 수 있습니다.
        </p>
      ) : null}
    </section>
  )
}

export default ShapeGallery
