/**
 * 지인 전용 비밀번호 게이트.
 *
 * 사이트는 GitHub Pages 정적 호스팅이라 서버가 없다. 그래서 이 잠금은
 * **클라이언트 측**이다. 번들을 읽을 줄 아는 사람은 우회할 수 있으므로 보안
 * 장치가 아니라 "주소를 우연히 알게 된 사람을 돌려보내는 문" 이다. 지인만
 * 쓰게 하려는 목적에는 이 수준이 맞고, 진짜 인증이 필요해지면 호스팅을
 * 옮겨야 한다.
 *
 * 평문 비밀번호는 번들에 싣지 않는다. PBKDF2-SHA256 으로 60만 번 늘린 해시만
 * 싣고(gateHash.ts), 입력값을 같은 방식으로 늘려 비교한다. 번들에서 해시를
 * 뽑아 무차별 대입하려면 추측마다 같은 비용을 치러야 해서 단발 해시보다 훨씬
 * 느리다. 틀린 입력이 쌓이면 다음 시도까지 기다리게 해 화면에서 두드리는
 * 것도 늦춘다. 통과하면 localStorage 에 해시를 남겨 같은 브라우저에서는 다시
 * 묻지 않는다.
 *
 * 개발 서버(npm run dev)에서는 게이트를 걸지 않는다. 빌드 결과를 서비스하는
 * 로컬 실행기(scripts/launch.ps1)와 배포 사이트에서만 잠긴다.
 *
 * 비밀번호를 바꾸려면 아래 명령으로 새 해시를 만들어 PASS_HASH 를 갈아끼운다.
 * 소금과 반복 횟수는 gateHash.ts 의 GATE_SALT, GATE_ITERATIONS 와 같아야 한다.
 *
 *   node -e "const c=require('crypto');console.log(c.pbkdf2Sync('새비밀번호','mm-gate:v2',600000,32,'sha256').toString('hex'))"
 */

import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { deriveGateHash } from './gateHash.ts'

/** pbkdf2(비밀번호, GATE_SALT, GATE_ITERATIONS) 의 16진수. 현재 비밀번호는 별도로 전달한다. */
const PASS_HASH = '70b906b01f268dd9ea0e59b29265cbf5e78acf3fef513a5b2188d24a540a852c'
/** 통과 기록. 값이 PASS_HASH 와 같으면 다시 묻지 않는다. 해시 방식이 바뀌어 v2. */
const UNLOCK_KEY = 'mm.access.v2'
/** 틀린 횟수. 탭을 닫으면 지워지지만 새로고침으로는 안 지워진다. */
const FAIL_KEY = 'mm.access.fail'
/** 이 횟수까지는 바로 다시 입력할 수 있다. */
const FREE_TRIES = 3
/** 이후에는 틀릴 때마다 대기 시간이 두 배가 된다. 상한 초. */
const MAX_WAIT_SEC = 60

const GATE_CSS = `
.mm-gate {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100dvh;
  padding: var(--sp-5);
  background: var(--bg);
}

.mm-gate-card {
  display: flex;
  flex-direction: column;
  gap: var(--sp-4);
  width: min(360px, 100%);
  padding: var(--sp-6);
  border: 1px solid var(--border-strong);
  border-radius: var(--r-lg);
  background: var(--surface);
}

.mm-gate-title {
  color: var(--text);
  font-size: var(--fs-lg);
  font-weight: 700;
  letter-spacing: 0.04em;
}

.mm-gate-sub {
  color: var(--text-muted);
  font-size: var(--fs-sm);
  line-height: 1.6;
}

.mm-gate-input {
  min-height: 36px;
  padding: 0 var(--sp-4);
  border: 1px solid var(--border-strong);
  border-radius: var(--r-md);
  background: var(--bg);
  color: var(--text);
  font-size: var(--fs-md);
}

.mm-gate-input:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 1px;
}

.mm-gate-submit {
  min-height: 36px;
  border: 1px solid var(--accent);
  border-radius: var(--r-md);
  background: var(--accent-soft);
  color: var(--text);
  font-size: var(--fs-sm);
  font-weight: 700;
  cursor: pointer;
}

.mm-gate-error {
  margin: 0;
  color: var(--danger);
  font-size: var(--fs-xs);
}
`

function readUnlocked(): boolean {
  try {
    return window.localStorage.getItem(UNLOCK_KEY) === PASS_HASH
  } catch {
    // 프라이빗 모드 등으로 막히면 매번 묻는다.
    return false
  }
}

function readFails(): number {
  try {
    return Number(window.sessionStorage.getItem(FAIL_KEY)) || 0
  } catch {
    return 0
  }
}

function writeFails(n: number): void {
  try {
    if (n === 0) window.sessionStorage.removeItem(FAIL_KEY)
    else window.sessionStorage.setItem(FAIL_KEY, String(n))
  } catch {
    // 저장 못 하면 메모리 상태로만 버틴다.
  }
}

/** n 번째 실패 뒤 기다려야 하는 초. FREE_TRIES 까지는 0. */
function waitAfter(fails: number): number {
  if (fails < FREE_TRIES) return 0
  return Math.min(MAX_WAIT_SEC, 2 ** (fails - FREE_TRIES + 1))
}

export function AccessGate({ children }: { children: ReactNode }) {
  const [unlocked, setUnlocked] = useState<boolean>(() => import.meta.env.DEV || readUnlocked())
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [fails, setFails] = useState<number>(readFails)
  /** 이 시각(performance.now 기준 ms)까지는 제출을 받지 않는다. */
  const [lockedUntil, setLockedUntil] = useState(0)
  const [now, setNow] = useState(() => performance.now())

  // 잠긴 동안 남은 초를 표시하려고 1초마다 깨운다. 풀리면 멈춘다.
  useEffect(() => {
    if (lockedUntil <= now) return
    const id = window.setInterval(() => setNow(performance.now()), 250)
    return () => window.clearInterval(id)
  }, [lockedUntil, now])

  // 통과 순간이 아니라 상태로 남긴다. 다른 탭에서 풀었으면 여기서도 풀린다.
  useEffect(() => {
    if (unlocked) return
    const onStorage = (e: StorageEvent): void => {
      if (e.key === UNLOCK_KEY && e.newValue === PASS_HASH) setUnlocked(true)
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [unlocked])

  if (unlocked) return <>{children}</>

  const remainSec = Math.ceil((lockedUntil - now) / 1000)
  const locked = remainSec > 0

  async function onSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault()
    if (busy || performance.now() < lockedUntil) return
    setBusy(true)
    try {
      // crypto.subtle 은 https 와 localhost 에서만 있다. 배포(https)와 로컬
      // 실행기(localhost) 모두 해당하므로 없으면 환경이 잘못된 것이다.
      if (!('crypto' in window) || !crypto.subtle) {
        setError('이 브라우저 환경에서는 잠금을 확인할 수 없습니다. https 로 접속하세요.')
        return
      }
      const hash = await deriveGateHash(value)
      if (hash !== PASS_HASH) {
        const next = fails + 1
        setFails(next)
        writeFails(next)
        const wait = waitAfter(next)
        if (wait > 0) {
          const t = performance.now()
          setNow(t)
          setLockedUntil(t + wait * 1000)
        }
        setError('비밀번호가 맞지 않습니다.')
        return
      }
      writeFails(0)
      try {
        window.localStorage.setItem(UNLOCK_KEY, hash)
      } catch {
        // 저장을 못 해도 이번 세션은 연다.
      }
      setUnlocked(true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mm-gate">
      <style href="mm-gate" precedence="default">
        {GATE_CSS}
      </style>
      <form className="mm-gate-card" onSubmit={onSubmit}>
        <span className="mm-gate-title">
          MOTION<span aria-hidden="true"> </span>MAKER
        </span>
        <label className="mm-gate-sub" htmlFor="mm-gate-pass">
          초대받은 분만 쓸 수 있습니다. 비밀번호를 입력하세요.
        </label>
        <input
          id="mm-gate-pass"
          className="mm-gate-input"
          type="password"
          autoComplete="current-password"
          autoFocus
          value={value}
          onChange={(e) => {
            setValue(e.target.value)
            setError(null)
          }}
        />
        {error ? (
          <p className="mm-gate-error" role="alert">
            {error}
            {locked ? ` ${remainSec}초 뒤에 다시 시도할 수 있습니다.` : ''}
          </p>
        ) : null}
        <button
          type="submit"
          className="mm-gate-submit"
          disabled={busy || locked || value.length === 0}
        >
          {busy ? '확인 중' : locked ? `${remainSec}초 대기` : '들어가기'}
        </button>
      </form>
    </div>
  )
}

export default AccessGate
