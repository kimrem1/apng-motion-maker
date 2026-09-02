/**
 * 파티클 갤러리가 문서를 바꾸는 통로. shapeActions.ts 와 같은 역할이다.
 * 세부 조정은 인스펙터의 파티클 섹션이 setParticleSpec 으로 직접 한다.
 */

import { CFG, defaultParticleSpec } from '@/particles/config.ts'
import type { EffectKey } from '@/particles/types.ts'
import { useDocumentStore } from './document.ts'
import { useLayerUiStore } from './layerUi.ts'

/** 이 효과의 기본값으로 파티클 레이어 한 장을 넣고 선택한다. */
export function addParticleLayer(effect: EffectKey): string | null {
  const store = useDocumentStore.getState()
  const { layerId } = store.addParticle({
    name: CFG[effect].name,
    spec: defaultParticleSpec(effect),
  })
  if (layerId) useLayerUiStore.getState().setSelectedLayerIds([layerId], layerId)
  return layerId || null
}
