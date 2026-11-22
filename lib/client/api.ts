// 화면이 서버의 네 경로를 부르는 곳. 접속 코드를 머리말에 싣고, 실패를 화면에 보일 사유로 바꾼다.
// 다시 시도는 서버가 맡는다(F16). 여기서는 다시 보내지 않고, 실패한 항목은 사용자가 골라 다시 실행한다.
import type { ApiFailure, ApiResult, RunApi } from '../run/runner.ts';

/** 서버가 요청 하나에 거는 60초보다 조금 넉넉하게 기다린다 */
const CLIENT_TIMEOUT_MS = 80_000;

const FATAL_TEXT: Record<string, string> = {
  '키 없음': '서버에 Liner 키가 설정되어 있지 않습니다.',
  '인증 실패': '서버의 Liner 키가 거절되었습니다.',
  '크레딧 부족': 'Liner 크레딧이 부족합니다.',
};

const fail = (reason: string, extra: Partial<ApiFailure> = {}): ApiFailure => ({ ok: false, aborted: false, fatal: false, status: 0, reason, ...extra });

/** 서버가 돌려준 오류를 화면에 보일 사유로 바꾼다 */
export function failureOf(status: number, data: unknown): ApiFailure {
  const body = (data ?? {}) as { error?: unknown; reason?: unknown };
  const error = typeof body.error === 'string' ? body.error : '';
  const kind = typeof body.reason === 'string' ? body.reason : '';
  if (status === 401) return fail('접속 코드가 맞지 않습니다.', { status, fatal: true });
  if (status === 503 && error.includes('접속 코드')) return fail(error, { status, fatal: true });
  if (FATAL_TEXT[kind]) return fail(FATAL_TEXT[kind], { status, fatal: true });
  if (!error) return fail(`요청 실패(${status})`, { status });
  return fail(kind && kind !== error ? `${error}(${kind})` : error, { status });
}

async function post<T>(path: string, body: unknown, code: string, signal: AbortSignal): Promise<ApiResult<T>> {
  if (signal.aborted) return fail('중단', { aborted: true });
  // 머리말에는 한글을 실을 수 없다. 접속 코드에 그런 글자가 있으면 보내기 전에 알린다
  if (/[^\x20-\x7E]/.test(code)) return fail('접속 코드가 맞지 않습니다.', { status: 401, fatal: true });
  const guard = new AbortController();
  const onAbort = () => guard.abort();
  signal.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => guard.abort(), CLIENT_TIMEOUT_MS);
  try {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-access-code': code },
      body: JSON.stringify(body),
      signal: guard.signal,
    });
    const data = (await res.json().catch(() => null)) as T | null;
    if (res.ok && data) return { ok: true, ...data };
    return failureOf(res.status, data);
  } catch {
    if (signal.aborted) return fail('중단', { aborted: true });
    return fail(guard.signal.aborted ? '시간 초과' : '연결 실패');
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
}

/** 접속 코드는 요청할 때마다 읽는다. 실행 중에 고쳐 넣어도 다음 요청부터 쓰인다 */
export function createApi(accessCode: () => string): RunApi {
  return {
    extract: (input, signal) => post('/api/extract', input, accessCode(), signal),
    // 보강 검색이면 앞서 모은 묶음(more)을 명제와 따로 싣는다
    gather: ({ more, ...claim }, signal) => post('/api/gather', more ? { claim, more } : { claim }, accessCode(), signal),
    judge: (body, signal) => post('/api/judge', body, accessCode(), signal),
    merge: (body, signal) => post('/api/merge', body, accessCode(), signal),
  };
}
