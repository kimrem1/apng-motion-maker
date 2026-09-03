import { pbkdf2Sync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { GATE_ITERATIONS, GATE_SALT, deriveGateHash } from '@/ui/shell/gateHash.ts'

describe('deriveGateHash', () => {
  it('브라우저 파생 결과가 Node 의 해시 생성 명령과 같다', async () => {
    // AccessGate.tsx 주석의 PASS_HASH 생성 명령과 동일한 호출.
    const expected = pbkdf2Sync('예시 비밀번호', GATE_SALT, GATE_ITERATIONS, 32, 'sha256').toString('hex')
    await expect(deriveGateHash('예시 비밀번호')).resolves.toBe(expected)
  })

  it('한 글자만 달라도 전혀 다른 값이 나온다', async () => {
    const [a, b] = await Promise.all([deriveGateHash('abc'), deriveGateHash('abd')])
    expect(a).not.toBe(b)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
  })
})
