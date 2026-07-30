/**
 * 모션 기준점 3x3 그리드.
 *
 * EASY 와 PRO 가 같은 컨트롤을 쓴다. 둘이 갈라지면 한쪽에서 고른 기준점이
 * 다른 쪽에서 다르게 보이거나, 한쪽에만 새 칸이 생긴다.
 *
 * 여기서 고르는 값은 **회전과 확대가 도는 축**이다. 그림이 놓이는 자리는 바뀌지
 * 않는다 (core/transform.ts buildLayerMatrix). 예전에는 기준점을 왼쪽 위로 옮기면
 * 그림이 오른쪽 아래로 반 장 튀어 나갔고, 그것 때문에 이 컨트롤을 아무도 쓸 수
 * 없었다.
 */

export interface AnchorCell {
  ax: number
  ay: number
  label: string
}

/** 값은 이미지 로컬 비율 [0,1] 이다. 읽는 순서는 왼쪽 위부터 오른쪽 아래까지다. */
export const ANCHOR_CELLS: readonly AnchorCell[] = [
  { ax: 0, ay: 0, label: '왼쪽 위' },
  { ax: 0.5, ay: 0, label: '가운데 위' },
  { ax: 1, ay: 0, label: '오른쪽 위' },
  { ax: 0, ay: 0.5, label: '왼쪽 가운데' },
  { ax: 0.5, ay: 0.5, label: '정중앙' },
  { ax: 1, ay: 0.5, label: '오른쪽 가운데' },
  { ax: 0, ay: 1, label: '왼쪽 아래' },
  { ax: 0.5, ay: 1, label: '가운데 아래' },
  { ax: 1, ay: 1, label: '오른쪽 아래' },
]

const near = (a: number, b: number): boolean => Math.abs(a - b) < 0.001

export function anchorLabelOf(ax: number, ay: number): string {
  return ANCHOR_CELLS.find((c) => near(ax, c.ax) && near(ay, c.ay))?.label ?? '직접 지정'
}

export interface AnchorGridProps {
  ax: number
  ay: number
  disabled?: boolean
  /** 그리드를 설명하는 라벨 요소의 id. 스크린리더가 group 이름으로 읽는다. */
  labelledBy: string
  onChange(ax: number, ay: number): void
}

export function AnchorGrid({ ax, ay, disabled = false, labelledBy, onChange }: AnchorGridProps) {
  return (
    <div className="mm-anchor-grid" role="group" aria-labelledby={labelledBy}>
      {ANCHOR_CELLS.map((cell) => {
        const active = near(ax, cell.ax) && near(ay, cell.ay)
        return (
          <button
            key={cell.label}
            type="button"
            className="mm-anchor-cell"
            aria-pressed={active}
            disabled={disabled}
            title={cell.label}
            aria-label={`기준점 ${cell.label}`}
            onClick={() => onChange(cell.ax, cell.ay)}
          >
            <span className="mm-anchor-dot" />
          </button>
        )
      })}
    </div>
  )
}

export default AnchorGrid
