// Liner Platform API 호출. 서버에서만 쓴다(Liner는 브라우저에서 직접 보내는 요청을 받지 않는다).
// 키는 환경 변수에서만 읽고, 기록이나 응답에 싣지 않는다.
import { LIMITS } from './limits.ts';
import type { PremiumData, Usage } from './types.ts';

const BASE = 'https://platform.liner.com/api/v1';

export type FailureKind =
  | '키 없음'
  | '인증 실패'
  | '크레딧 부족'
  | '요청 오류'
  | '호출 한도'
  | 'Liner 서버 오류'
  | '연결 실패'
  | '응답 잘림'
  | '응답 형식 오류'
  | '시간 초과';

export class LinerError extends Error {
  kind: FailureKind;
  status: number | null;
  constructor(kind: FailureKind, status: number | null, detail = '') {
    super(detail ? `${kind}: ${detail}` : kind);
    this.kind = kind;
    this.status = status;
  }
}

/** 요청 하나가 쓸 수 있는 시간과 다시 시도 횟수 */
export interface Budget {
  deadline: number;
  retriesLeft: number;
}

export function newBudget(): Budget {
  return { deadline: Date.now() + LIMITS.requestMs, retriesLeft: LIMITS.retriesPerRequest };
}

export function serverKey(): string {
  const key = process.env.LINER_API_KEY ?? '';
  if (!key) throw new LinerError('키 없음', null);
  return key;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function post(path: string, body: unknown, key: string, budget: Budget): Promise<{ data: any; seconds: number }> {
  for (let attempt = 0; ; attempt += 1) {
    const left = budget.deadline - Date.now();
    if (left <= 0) throw new LinerError('시간 초과', null);
    const t0 = performance.now();
    let failure: LinerError;
    let canRetry = false;
    let retryAfterMs = 0;
    try {
      const res = await fetch(BASE + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': key },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(left),
      });
      if (res.ok) return { data: await res.json(), seconds: (performance.now() - t0) / 1000 };

      const raw = await res.text();
      let payload: any = null;
      try {
        payload = JSON.parse(raw);
      } catch {
        // 본문이 JSON이 아니어도 상태 코드로 판단한다
      }
      // Liner가 다시 시도하지 말라고 알려 주면(retryable: false) 따른다
      const flagged = payload?.error?.retryable ?? payload?.retryable;
      canRetry = flagged !== false && (res.status === 429 || res.status >= 500);
      const kind: FailureKind =
        res.status === 401 || res.status === 403
          ? '인증 실패'
          : res.status === 402
            ? '크레딧 부족'
            : res.status === 429
              ? '호출 한도'
              : res.status < 500
                ? '요청 오류'
                : 'Liner 서버 오류';
      failure = new LinerError(kind, res.status);
      retryAfterMs = (Number(res.headers.get('retry-after')) || 0) * 1000;
    } catch (e) {
      const timedOut = (e as Error).name === 'TimeoutError';
      failure = new LinerError(timedOut ? '시간 초과' : '연결 실패', null);
      canRetry = !timedOut;
    }
    // 다시 시도할 때는 Liner의 안내대로 기다리는 시간을 점점 늘린다
    if (!canRetry || attempt >= LIMITS.retriesPerCall || budget.retriesLeft <= 0) throw failure;
    const wait = Math.max(retryAfterMs, 500 * 2 ** attempt + Math.random() * 250);
    if (Date.now() + wait >= budget.deadline) throw failure;
    budget.retriesLeft -= 1;
    await sleep(wait);
  }
}

export interface ChatOptions {
  stage: string;
  key: string;
  system: string;
  user: string;
  schemaName: string;
  schema: object;
  maxTokens: number;
  budget: Budget;
  /** 'cost', 'balanced', 'quality' 가운데 하나. 주지 않으면 라우터가 고른다 */
  routingStrategy?: 'cost' | 'balanced' | 'quality';
}

/** 구조화 출력(json_schema)으로 모델을 부른다. 잘렸거나 형식이 깨진 응답은 실패로 돌려준다 */
export async function chatJson<T>(opts: ChatOptions): Promise<{ value: T; usage: Usage }> {
  const body: Record<string, unknown> = {
    model: opts.routingStrategy ? 'liner-claude-router-1.0' : 'liner-claude-router',
    messages: [
      { role: 'system', content: opts.system },
      { role: 'user', content: opts.user },
    ],
    max_tokens: opts.maxTokens,
    response_format: {
      type: 'json_schema',
      json_schema: { name: opts.schemaName, strict: true, schema: opts.schema },
    },
  };
  if (opts.routingStrategy) body.routing_strategy = opts.routingStrategy;

  const { data, seconds } = await post('/chat/completions', body, opts.key, opts.budget);
  const choice = data?.choices?.[0];
  const usage: Usage = {
    stage: opts.stage,
    model: String(data?.model ?? ''),
    promptTokens: Number(data?.usage?.prompt_tokens ?? 0),
    cachedTokens: Number(data?.usage?.prompt_tokens_details?.cached_tokens ?? 0),
    completionTokens: Number(data?.usage?.completion_tokens ?? 0),
    searchCalls: 0,
    seconds: Math.round(seconds * 10) / 10,
  };
  if (choice?.finish_reason === 'length') throw new LinerError('응답 잘림', 200);
  try {
    return { value: JSON.parse(choice?.message?.content ?? '') as T, usage };
  } catch {
    throw new LinerError('응답 형식 오류', 200);
  }
}

export interface SearchHit {
  title: string;
  url: string;
  hostname: string;
  description: string;
  date: string | null;
}

export interface SearchOptions {
  key: string;
  query: string;
  maxResults: number;
  /** 기간 제한. Liner가 받는 값은 past_day, past_week, past_month, past_year */
  dateRange?: 'past_day' | 'past_week' | 'past_month' | 'past_year';
  /** Premium Data를 함께 받을지. 켜면 검색 단가가 오른다 */
  includeKnowledge: boolean;
  budget: Budget;
}

const text = (value: unknown, max: number) => (typeof value === 'string' ? value.trim().slice(0, max) : '');

/** Liner 웹 검색. 결과의 요약은 근거로 쓰지 않고, 어느 페이지를 열지 정하는 데만 쓴다 */
export async function searchWeb(opts: SearchOptions): Promise<{ hits: SearchHit[]; knowledge: PremiumData[]; seconds: number }> {
  const body: Record<string, unknown> = {
    query: opts.query,
    max_results: opts.maxResults,
    include_knowledge: opts.includeKnowledge,
  };
  if (opts.dateRange) body.date_range = opts.dateRange;

  const { data, seconds } = await post('/tools/search/web', body, opts.key, opts.budget);
  const hits: SearchHit[] = [];
  for (const r of Array.isArray(data?.results) ? data.results : []) {
    const url = text(r?.url, 1000);
    if (!url) continue;
    hits.push({
      title: text(r?.title, 200),
      url,
      hostname: text(r?.hostname, 200),
      description: text(r?.description, 400),
      date: text(r?.date, 40) || null,
    });
  }
  const knowledge: PremiumData[] = [];
  for (const k of Array.isArray(data?.knowledge) ? data.knowledge.slice(0, 3) : []) {
    knowledge.push({
      title: text(k?.title, 120),
      description: text(k?.description, 400),
      dataAsOf: text(k?.dataAsOf, 20) || null,
      sources: Array.isArray(k?.sources) ? k.sources.slice(0, 5).map((s: unknown) => text(s, 120)) : [],
    });
  }
  return { hits, knowledge, seconds: Math.round(seconds * 10) / 10 };
}
