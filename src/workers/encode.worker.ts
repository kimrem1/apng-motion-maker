/**
 * 인코딩 워커.
 *
 * 존재 이유: 메인 스레드에서 인코딩하면 그동안 취소 버튼도 진행률도 죽는다.
 * export/yield.ts 의 양보로 프레임 경계마다 숨통을 틔워 두긴 했지만, deflate 한 덩어리가
 * 수백 ms 를 먹는 구간은 양보로 쪼갤 수 없다. 그 구간을 통째로 다른 스레드에 옮긴다.
 *
 * 이 파일은 얇아야 한다. 실제 인코딩은 protocol.ts 의 runEncodeJob 하나뿐이고
 * 메인 스레드 폴백도 같은 함수를 부른다. 여기서 하는 일은 comlink 노출과 취소 등록뿐이다.
 *
 * 취소는 cancel(jobId) 메시지로 받는다. AbortSignal 을 구조적 복제로 못 넘기기 때문이다.
 * 자세한 근거는 protocol.ts 머리말 참조. terminate 는 호출자 쪽 마지막 수단이다.
 */

import * as Comlink from 'comlink'

import {
  probeCapabilities,
  runEncodeJob,
  type EncodeJobRequest,
  type EncodeJobResult,
  type EncodeProgressCallback,
  type EncodeWorkerApi,
  type WorkerCapabilities,
} from './protocol.ts'

/** 진행 중인 job 의 취소 스위치. 끝나면 반드시 지운다(누수 방지). */
const running = new Map<number, AbortController>()

const api: EncodeWorkerApi = {
  async capabilities(): Promise<WorkerCapabilities> {
    return probeCapabilities()
  },

  async encode(
    request: EncodeJobRequest,
    onProgress?: EncodeProgressCallback,
  ): Promise<EncodeJobResult> {
    const controller = new AbortController()
    running.set(request.jobId, controller)
    try {
      const result = await runEncodeJob(request, onProgress, controller.signal)
      // 결과 바이트를 복사하지 않고 메인으로 넘긴다. 이 버퍼는 여기서 즉시 detached 된다.
      return Comlink.transfer(result, [result.bytes.buffer as ArrayBuffer])
    } finally {
      running.delete(request.jobId)
    }
  },

  async cancel(jobId: number): Promise<void> {
    // 이미 끝났으면 아무 일도 하지 않는다. 중복 취소는 정상 흐름이다.
    running.get(jobId)?.abort()
  },
}

Comlink.expose(api)
