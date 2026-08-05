/**
 * 지금 이 순간 그려지고 있는 프레임.
 *
 * 왜 useUiStore.playheadFrame 으로 부족한가
 *
 * 재생 중 스토어의 playheadFrame 은 100ms 마다만 갱신된다(useRenderer 의
 * PUBLISH_INTERVAL_MS). 매 프레임 스토어를 건드리면 구독한 컴포넌트가 전부 다시
 * 그려져 재생이 끊기기 때문이다. 그래서 재생 중 그 값은 언제나 한두 프레임 뒤처져 있고,
 * 정확한 값은 정지할 때 이펙트가 따로 확정해 넣는다.
 *
 * 문제는 "재생을 멈추고 그 프레임에 키를 찍는" 조작이다. setPlaying(false) 는 React
 * 상태 변경이라 정지 이펙트가 아직 안 돈다. 같은 tick 에서 스토어를 읽으면 뒤처진
 * 값을 집고, 잠시 뒤 이펙트가 정확한 값으로 덮는다. 그래서 인스펙터에 입력한 값이
 * 화면이 보여 주는 프레임이 아니라 그 앞 프레임에 쓰이고, 입력 칸은 블러 직후
 * 보간값으로 되돌아갔다. 캔버스 드래그도 같은 순서라 놓은 자리와 다른 곳에 키를 남겼다.
 *
 * 그래서 렌더 루프가 자기 프레임을 여기에 그대로 미러링한다. 리렌더를 유발하지 않는
 * 모듈 변수 하나다. 쓰는 쪽은 렌더러 소유자(useRenderer) 하나뿐이고, 나머지는
 * 읽기만 한다. rendererHandle.ts 와 같은 규칙이다.
 */

let frame = 0

/** 렌더러 소유자 전용. 다른 곳에서 부르면 편집 프레임이 화면과 갈라진다. */
export function setLivePlayheadFrame(next: number): void {
  if (Number.isFinite(next)) frame = Math.round(next)
}

/**
 * 지금 그려지고 있는 프레임.
 *
 * 정지 상태에서는 스토어의 playheadFrame 과 같다(스크럽도 렌더 루프를 거친다).
 * 재생 중에만 스토어보다 앞선다.
 */
export function livePlayheadFrame(): number {
  return frame
}

/**
 * "지금 편집이 쓸 프레임". 재생을 멈추고 그 자리에 키를 찍는 조작이 전부 이걸 쓴다.
 *
 * 인스펙터의 입력 칸과 캔버스 드래그가 각자 판단하면 반드시 갈라진다. 실제로
 * 갈라져 있었고, 둘 다 재생 중에 스토어 값을 읽어 한두 프레임 앞에 키를 남겼다.
 *
 * 정지 상태에서는 스토어가 진실이다. 스크럽으로 옮긴 자리가 거기 있고, 렌더 루프는
 * 그 값을 따라간다. 재생 중에만 실제로 그려지는 프레임이 앞선다.
 */
export function frameForEdit(playing: boolean, storeFrame: number): number {
  const at = playing ? livePlayheadFrame() : storeFrame
  return Number.isFinite(at) ? Math.round(at) : 0
}
