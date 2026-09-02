/**
 * 레이어 패널에서 타임라인으로 끌어다 놓는 통로.
 *
 * 왜 이런 모듈이 필요한가
 *
 * 끄는 쪽(레이어 패널)은 놓는 쪽의 좌표계를 모른다. 타임라인만이 지금 배율과
 * 스크롤로 "화면 x 가 몇 프레임인가" 를 안다. 반대로 타임라인은 지금 무엇을 끌고
 * 있는지 모른다. 포인터 캡처가 레이어 패널 쪽에 걸려 있어서 타임라인 캔버스에는
 * 이벤트가 한 개도 가지 않기 때문이다.
 *
 * 그래서 타임라인이 자기 좌표 변환을 여기 걸어 두고, 레이어 패널이 뷰포트 좌표만
 * 넘긴다. 스토어를 쓰지 않는 이유는 이 값이 상태가 아니라 콜백이기 때문이다.
 * zustand 에 함수를 넣으면 마운트 순서에 따라 낡은 클로저가 남는다.
 *
 * HTML5 드래그를 쓰지 않는 이유는 레이어 패널과 같다(ui/layers/LayerPanel.tsx
 * 머리주석). dragover 좌표가 끊겨 들어와 손가락보다 늦게 따라온다.
 */

export interface TimelineDropHost {
  /**
   * 이 좌표가 클립 영역 위인가. 위면 놓일 자리를 미리 그린다.
   * 아니면 표시를 지운다. 판정과 표시를 한 번에 하는 이유는 두 번 오가면
   * "영역을 벗어났는데 표시가 남는" 상태가 반드시 생기기 때문이다.
   */
  hover(clientX: number, clientY: number, layerId: string): boolean
  /**
   * 놓는다. 처리했으면 참이다. 거짓이면 끄는 쪽이 원래 하려던 일을 한다.
   * layerIds 는 잡은 것을 포함해 함께 끌려온 전부다. 다중 선택을 잡아 끌었으면
   * 목록에서처럼 여기서도 전부가 한꺼번에 놓여야 한다.
   */
  drop(clientX: number, clientY: number, layerIds: readonly string[]): boolean
  /** 드래그가 끝났다. 표시를 지운다. */
  cancel(): void
}

let host: TimelineDropHost | null = null

/**
 * 타임라인이 자기를 등록한다. 돌려받은 함수를 부르면 등록이 풀린다.
 *
 * 마운트가 겹치는 경우(그래프 에디터로 바뀌는 순간 등)에 대비해, 풀 때는 지금
 * 걸려 있는 것이 자기일 때만 지운다. 무조건 null 로 만들면 뒤에 등록한 쪽이
 * 앞선 쪽의 언마운트에 지워진다.
 */
export function setTimelineDropHost(next: TimelineDropHost): () => void {
  host = next
  return () => {
    if (host === next) host = null
  }
}

export function timelineDropHover(clientX: number, clientY: number, layerId: string): boolean {
  return host?.hover(clientX, clientY, layerId) ?? false
}

export function timelineDropCommit(
  clientX: number,
  clientY: number,
  layerIds: readonly string[],
): boolean {
  const done = host?.drop(clientX, clientY, layerIds) ?? false
  host?.cancel()
  return done
}

export function timelineDropCancel(): void {
  host?.cancel()
}
