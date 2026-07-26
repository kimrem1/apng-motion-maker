/**
 * 커맨드 레지스트리.
 *
 * 이 테스트의 핵심은 **키 조합 중복 검사**다. tinykeys 는 이벤트 하나에 대해
 * 처음 매치된 바인딩만 실행하고 break 한다. 두 명령이 같은 조합을 잡으면 나중에
 * 등록된 쪽은 영원히 눌리지 않는데, 화면에는 단축키가 멀쩡히 표시된다.
 * 사람 눈으로는 절대 못 잡는 종류의 회귀다.
 *
 * registry.ts 는 DOM 을 만지지 않으므로 node 환경에서 그대로 돌아간다.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import {
  COMMANDS,
  COMMAND_BY_ID,
  COMMAND_CATEGORY_ORDER,
  bindingSignature,
  closeOverlay,
  findCommands,
  formatBinding,
  getOverlay,
  isCommandAvailable,
  needsPlatformMod,
  parseBinding,
  resetCommandHost,
  setCommandHost,
  subscribeOverlay,
  toChoseong,
  toggleOverlay,
} from '@/ui/shortcuts/registry.ts'

beforeEach(() => {
  resetCommandHost()
  closeOverlay()
})

const allBindings = (): { id: string; binding: string }[] =>
  COMMANDS.flatMap((c) => (c.keys ?? []).map((binding) => ({ id: c.id, binding })))

// ---------------------------------------------------------------------------
// 무결성
// ---------------------------------------------------------------------------

describe('COMMANDS 무결성', () => {
  it('id 가 중복되지 않는다', () => {
    const seen = new Map<string, number>()
    for (const command of COMMANDS) {
      seen.set(command.id, (seen.get(command.id) ?? 0) + 1)
    }
    const dupes = [...seen].filter(([, n]) => n > 1).map(([id]) => id)
    expect(dupes).toEqual([])
  })

  it('COMMAND_BY_ID 가 전부를 담는다', () => {
    expect(COMMAND_BY_ID.size).toBe(COMMANDS.length)
    for (const command of COMMANDS) {
      expect(COMMAND_BY_ID.get(command.id)).toBe(command)
    }
  })

  it('라벨이 비어 있지 않고 run 이 함수다', () => {
    for (const command of COMMANDS) {
      expect(command.label.trim().length, command.id).toBeGreaterThan(0)
      expect(typeof command.run, command.id).toBe('function')
    }
  })

  it('카테고리가 COMMAND_CATEGORY_ORDER 안에 있다', () => {
    for (const command of COMMANDS) {
      expect(COMMAND_CATEGORY_ORDER, command.id).toContain(command.category)
    }
  })

  it('when / reason 이 빈 문서에서도 던지지 않는다', () => {
    for (const command of COMMANDS) {
      expect(() => command.when?.(), command.id).not.toThrow()
      expect(() => command.reason?.(), command.id).not.toThrow()
    }
  })
})

// ---------------------------------------------------------------------------
// 키 조합 충돌 (이 파일의 존재 이유)
// ---------------------------------------------------------------------------

describe('키 조합', () => {
  it('같은 조합을 두 명령이 잡지 않는다', () => {
    const owner = new Map<string, string>()
    const conflicts: string[] = []
    for (const { id, binding } of allBindings()) {
      const signature = bindingSignature(binding)
      const previous = owner.get(signature)
      if (previous !== undefined) {
        conflicts.push(`${signature}: ${previous} vs ${id} (${binding})`)
      } else {
        owner.set(signature, id)
      }
    }
    expect(conflicts).toEqual([])
  })

  it('한 명령 안에서도 같은 조합을 두 번 적지 않는다', () => {
    for (const command of COMMANDS) {
      const signatures = (command.keys ?? []).map(bindingSignature)
      expect(new Set(signatures).size, command.id).toBe(signatures.length)
    }
  })

  it('플랫폼 수식자는 $mod 로만 적는다', () => {
    // Control / Meta 를 직접 적으면 macOS 에서 어긋나고, 무엇보다 $mod 로 적은
    // 다른 바인딩과 지문이 달라져 위의 충돌 검사가 그 쌍을 놓친다.
    for (const { id, binding } of allBindings()) {
      const { required, optional } = parseBinding(binding)
      const raw = [...required, ...optional].filter((m) => m === 'Control' || m === 'Meta')
      expect(raw, `${id} (${binding})`).toEqual([])
    }
  })

  it('모든 바인딩에 키가 있다', () => {
    for (const { id, binding } of allBindings()) {
      expect(parseBinding(binding).key.length, `${id} (${binding})`).toBeGreaterThan(0)
    }
  })

  it('붙여넣기와 복사/잘라내기는 등록하지 않는다', () => {
    // Ctrl+V 는 imageprep/useImageDrop.ts 가 paste 이벤트로 이미 받는다.
    // 여기서도 잡으면 이미지가 두 번 들어온다.
    const reserved = new Set(['MOD|V', 'MOD|C', 'MOD|X'])
    const taken = allBindings()
      .map(({ binding }) => bindingSignature(binding).toUpperCase())
      .filter((signature) => reserved.has(signature))
    expect(taken).toEqual([])
  })

  it('필수 조합이 모두 있다', () => {
    const byId = (id: string): string[] => COMMAND_BY_ID.get(id)?.keys ?? []
    expect(byId('file.open')).toContain('$mod+o')
    expect(byId('file.save')).toContain('$mod+s')
    expect(byId('file.export')).toContain('$mod+e')
    expect(byId('file.exportAgain')).toContain('$mod+Shift+e')
    expect(byId('palette.toggle')).toContain('$mod+k')
    expect(byId('edit.undo')).toContain('$mod+z')
    expect(byId('edit.redo')).toContain('$mod+Shift+z')
    expect(byId('edit.duplicate')).toContain('$mod+d')
    expect(byId('edit.selectAll')).toContain('$mod+a')
    expect(byId('play.toggle')).toContain('Space')
    expect(byId('play.back10')).toContain('Shift+ArrowLeft')
    expect(byId('timeline.graph')).toContain('g')
    expect(byId('timeline.graphTab')).toContain('Shift+g')
    expect(byId('timeline.keyframe')).toContain('Alt+k')
    expect(byId('timeline.zoomFit')).toContain('Shift+z')
    expect(byId('canvas.fit')).toContain('$mod+0')
    expect(byId('canvas.actual')).toContain('$mod+1')
    expect(byId('preset.random')).toContain('$mod+r')
  })

  it('프리셋 슬롯 1 ~ 9 가 숫자 키를 하나씩 잡는다', () => {
    for (let slot = 1; slot <= 9; slot += 1) {
      const command = COMMAND_BY_ID.get(`preset.slot${slot}`)
      expect(command, `preset.slot${slot}`).toBeDefined()
      expect(command?.keys).toEqual([String(slot)])
    }
  })
})

// ---------------------------------------------------------------------------
// 파싱과 표기
// ---------------------------------------------------------------------------

describe('parseBinding', () => {
  it('수식자와 키를 나눈다', () => {
    expect(parseBinding('$mod+Shift+e')).toEqual({
      required: ['Mod', 'Shift'],
      optional: [],
      key: 'e',
    })
  })

  it('대괄호는 선택 수식자다', () => {
    expect(parseBinding('[Shift]+?')).toEqual({ required: [], optional: ['Shift'], key: '?' })
  })

  it('수식자 순서가 달라도 같은 지문이다', () => {
    expect(bindingSignature('Shift+$mod+e')).toBe(bindingSignature('$mod+Shift+e'))
  })

  it('선택 수식자는 지문에서 빠진다', () => {
    // `?` 가 잡는 입력을 `[Shift]+?` 가 전부 포함하므로 함께 등록하면 한쪽이 죽는다.
    expect(bindingSignature('[Shift]+?')).toBe(bindingSignature('?'))
  })

  it('필수 수식자가 다르면 다른 지문이다', () => {
    expect(bindingSignature('Shift+ArrowLeft')).not.toBe(bindingSignature('ArrowLeft'))
  })

  it('needsPlatformMod 가 Ctrl 계열만 참이다', () => {
    expect(needsPlatformMod('$mod+e')).toBe(true)
    expect(needsPlatformMod('Shift+g')).toBe(false)
    expect(needsPlatformMod('Alt+k')).toBe(false)
    expect(needsPlatformMod('Space')).toBe(false)
  })
})

describe('formatBinding', () => {
  it('윈도우 표기', () => {
    expect(formatBinding('$mod+Shift+e', false)).toEqual(['Ctrl', 'Shift', 'E'])
  })

  it('macOS 표기', () => {
    expect(formatBinding('$mod+Shift+e', true)).toEqual(['⌘', '⇧', 'E'])
  })

  it('특수 키는 기호로 바꾼다', () => {
    expect(formatBinding('Shift+ArrowLeft', false)).toEqual(['Shift', '←'])
    expect(formatBinding('Escape', false)).toEqual(['Esc'])
    expect(formatBinding('Space', false)).toEqual(['Space'])
  })

  it('선택 수식자는 표기하지 않는다', () => {
    expect(formatBinding('[Shift]+?', false)).toEqual(['?'])
  })
})

// ---------------------------------------------------------------------------
// 퍼지 검색
// ---------------------------------------------------------------------------

describe('toChoseong', () => {
  it('한글 음절을 초성으로 바꾼다', () => {
    expect(toChoseong('내보내기')).toBe('ㄴㅂㄴㄱ')
    expect(toChoseong('실행 취소')).toBe('ㅅㅎ ㅊㅅ')
  })

  it('한글이 아닌 글자는 그대로 둔다', () => {
    expect(toChoseong('모션 1: abc')).toBe('ㅁㅅ 1: abc')
  })
})

describe('findCommands', () => {
  it('빈 쿼리는 전체를 등록 순서로 돌려준다', () => {
    expect(findCommands('')).toEqual(COMMANDS)
    expect(findCommands('   ')).toEqual(COMMANDS)
  })

  it('앞에서 걸리는 부분 문자열이 먼저 온다', () => {
    const hits = findCommands('내보')
    expect(hits[0]?.id).toBe('file.export')
    expect(hits.map((c) => c.id)).toContain('file.exportAgain')
  })

  it('초성으로 찾는다', () => {
    const hits = findCommands('ㄴㅂㄴㄱ')
    expect(hits[0]?.id).toBe('file.export')
  })

  it('영문 별칭으로 찾는다', () => {
    expect(findCommands('export')[0]?.id).toBe('file.export')
    expect(findCommands('undo')[0]?.id).toBe('edit.undo')
    expect(findCommands('palette')[0]?.id).toBe('palette.toggle')
  })

  it('띄엄띄엄 골라도 순서만 맞으면 찾는다', () => {
    // '레이어 전체 선택' 에서 ㄹ...ㅈ...ㅅ 을 골라낸다.
    const hits = findCommands('레전')
    expect(hits.map((c) => c.id)).toContain('edit.selectAll')
  })

  it('없는 말이면 빈 배열이다', () => {
    expect(findCommands('zzqqxx')).toEqual([])
  })

  it('결과 순서가 매번 같다', () => {
    const a = findCommands('키').map((c) => c.id)
    const b = findCommands('키').map((c) => c.id)
    expect(a).toEqual(b)
  })
})

// ---------------------------------------------------------------------------
// 호스트 주입
// ---------------------------------------------------------------------------

describe('CommandHost', () => {
  it('주입되지 않은 명령은 쓸 수 없다', () => {
    const open = COMMAND_BY_ID.get('file.open')!
    expect(isCommandAvailable(open)).toBe(false)
    expect(open.reason?.()).toBeTruthy()
  })

  it('주입하면 쓸 수 있고 해제하면 되돌아간다', () => {
    const open = COMMAND_BY_ID.get('file.open')!
    let called = 0
    const dispose = setCommandHost({ openFile: () => void (called += 1) })

    expect(isCommandAvailable(open)).toBe(true)
    open.run()
    expect(called).toBe(1)

    dispose()
    expect(isCommandAvailable(open)).toBe(false)
    open.run()
    expect(called).toBe(1)
  })

  it('해제는 자기가 꽂은 것만 뺀다', () => {
    const first = (): void => {}
    const second = (): void => {}
    const disposeFirst = setCommandHost({ openFile: first })
    setCommandHost({ openFile: second })

    // 그 사이 다른 쪽이 덮어썼으므로 첫 번째 해제는 아무것도 지우지 않는다.
    disposeFirst()
    expect(isCommandAvailable(COMMAND_BY_ID.get('file.open')!)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 오버레이 상태
// ---------------------------------------------------------------------------

describe('오버레이', () => {
  it('한 번에 하나만 열린다', () => {
    toggleOverlay('palette')
    expect(getOverlay()).toBe('palette')
    toggleOverlay('help')
    expect(getOverlay()).toBe('help')
    toggleOverlay('help')
    expect(getOverlay()).toBe(null)
  })

  it('종류를 지정한 닫기는 다른 것을 건드리지 않는다', () => {
    toggleOverlay('palette')
    closeOverlay('help')
    expect(getOverlay()).toBe('palette')
    closeOverlay('palette')
    expect(getOverlay()).toBe(null)
  })

  it('구독자에게 변화를 알린다', () => {
    let ticks = 0
    const unsubscribe = subscribeOverlay(() => void (ticks += 1))
    toggleOverlay('palette')
    toggleOverlay('palette')
    unsubscribe()
    toggleOverlay('palette')
    expect(ticks).toBe(2)
  })
})
