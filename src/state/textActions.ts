/**
 * 글자 패널이 문서를 바꾸는 유일한 통로.
 *
 * shapeActions.ts 와 같은 역할이고 같은 규칙을 따른다. UI 컴포넌트가 스토어 액션을
 * 직접 조립하지 않는다. 그래야 "어디서 넣었느냐에 따라 결과가 다른" 일이 안 생긴다.
 */

import { createTextSpec, cssFontOf } from '@/core/text.ts'
import type { TextSpec } from '@/core/types.ts'
import { waitForFont } from '@/ui/text/fonts.ts'
import { useDocumentStore } from './document.ts'
import { useLayerUiStore } from './layerUi.ts'

/** 레이어 이름은 내용 앞머리로 만든다. 목록에서 어느 글자인지 바로 보여야 한다. */
export function textLayerName(content: string): string {
  const line = content.split('\n')[0] ?? ''
  const trimmed = line.trim()
  if (trimmed.length === 0) return '글자'
  return trimmed.length > 12 ? `${trimmed.slice(0, 12)}...` : trimmed
}

/**
 * 글자 한 장을 넣는다.
 *
 * 크기는 캔버스 짧은 변의 1/6 이다. 한 줄이 화면 폭의 절반쯤을 차지해서, 넣자마자
 * 읽히면서도 글자 등장 모션이 움직일 여백이 남는다.
 */
export async function addTextLayer(overrides: Partial<TextSpec> = {}): Promise<string | null> {
  const store = useDocumentStore.getState()
  const doc = store.doc
  const base = Math.min(doc.canvas.w, doc.canvas.h)
  const fontSize = Math.max(12, Math.round(base / 6))

  const spec = createTextSpec({ fontSize, ...overrides })

  /*
   * 글꼴이 도착한 뒤에 넣는다.
   *
   * 글자는 굽는 즉시 텍스처가 되고 그 결과가 캐시에 남는다. 글꼴이 아직 안 왔을 때
   * 구우면 대체 글꼴로 구워진 그림이 그대로 굳어, 글꼴이 도착해도 화면이 바뀌지 않는다.
   */
  await waitForFont(cssFontOf(spec))

  const { layerId } = useDocumentStore.getState().addText({
    name: textLayerName(spec.content),
    text: spec,
  })

  if (layerId) useLayerUiStore.getState().setSelectedLayerIds([layerId], layerId)
  return layerId || null
}
