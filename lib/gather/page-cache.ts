// 페이지 읽기: 주소 하나를 열어 본문 글과 링크를 뽑는다. 같은 페이지는 잠깐 동안 한 번만 연다.
//
// 한 번의 검증에서 여러 명제가 같은 페이지를 찾는다(기관의 첫 화면, 백과사전의 같은 항목). 명제마다 따로 열면
// 같은 사이트에 같은 요청이 열 번 넘게 간다. 그 사이트에 폐가 되고, 기다리는 시간도 그만큼 는다.
// - 연 결과(뽑은 글과 링크)를 서버의 메모리에 몇 분 두고 함께 쓴다.
// - 지금 열고 있는 주소를 또 찾으면 새로 열지 않고 그 결과를 기다린다.
// - 응답이 없는 사이트는 잠시 건너뛴다. 연달아 응답하지 않으면(시간 초과, 연결 실패) 얼마 동안 그 사이트를 열지 않고 바로 실패로 돌려준다.
//
// 두는 것은 공개 웹 페이지에서 뽑은 글과 링크뿐이다. 원고, 명제, 판정은 두지 않는다. 서버가 다시 뜨면 사라진다.
// 서버가 여러 대면 저마다 따로 둔다(덜 열려는 것일 뿐이라 서로 달라도 결과는 같다).
import { LIMITS } from '../limits.ts';
import { decodeBody, safeGet, type GetFailure, type GetOptions, type GetResult } from '../net/safe-get.ts';
import { readHtml, type PageLink, type PageText } from './page-text.ts';

/** 응답이 없던 사이트라 열지 않고 건너뛰었을 때 적는 사유 */
export const SKIPPED_REASON = '응답 없어 건너뜀';
/** 조금 전에 다른 명제가 열어 보았다가 못 연 주소라 고르지 않았을 때 적는 사유의 앞머리. 뒤에 그때의 까닭이 붙는다 */
export const RECENT_FAILURE = '조금 전에 열리지 않음';

/** 잠깐 동안만 열지 않는 까닭인지(응답 없는 사이트, 조금 전의 실패). 시간이 지나면 다시 열어 볼 수 있다 */
export function isPassingSkip(reason: string): boolean {
  return reason === SKIPPED_REASON || reason.startsWith(RECENT_FAILURE);
}

export type PageReading =
  | {
      ok: true;
      /** 리디렉션을 따라간 뒤의 마지막 주소. 링크는 이 주소를 기준으로 읽은 것이다 */
      url: string;
      /** 크기 한도에 걸려 앞부분만 받았다 */
      truncated: boolean;
      page: PageText;
      links: PageLink[];
      /** 실제로 연 시각. 두었던 것을 다시 쓸 때도 처음 연 시각 그대로다 */
      fetchedAt: string;
    }
  | { ok: false; reason: GetFailure | typeof SKIPPED_REASON; detail: string; fetchedAt: string };

type CacheLimits = Record<keyof typeof LIMITS.pageCache, number>;

export interface PageReaderOptions {
  /** 주소를 여는 함수. 확인용 도구가 바꿔 끼운다 */
  get?: (address: string, options: GetOptions) => Promise<GetResult>;
  /** 지금 시각(ms). 확인용 도구가 바꿔 끼운다 */
  now?: () => number;
  limits?: Partial<CacheLimits>;
  /** 주소 하나를 열 때 기다리는 시간과 받는 크기 */
  timeoutMs?: number;
  maxBytes?: number;
}

export interface PageReaderStats {
  /** 실제로 연 횟수 */
  opened: number;
  /** 두었던 결과를 다시 쓴 횟수 */
  reused: number;
  /** 열고 있던 요청의 결과를 함께 기다린 횟수 */
  joined: number;
  /** 응답 없는 사이트라 열지 않은 횟수 */
  skipped: number;
  /** 지금 두고 있는 페이지 수와 글자 수 */
  kept: number;
  chars: number;
}

export interface PageReader {
  /**
   * 주소 하나를 읽는다.
   * @param waitMs 부른 쪽이 기다릴 수 있는 시간. 이 안에 끝나지 않으면 부른 쪽에는 '시간 초과'를 돌려주지만,
   *   여는 일은 끝까지 가고 그 결과는 다음에 찾는 쪽이 쓴다
   */
  read(address: string, waitMs: number): Promise<PageReading>;
  /** 그 주소의 사이트를 지금 건너뛰고 있는지. 열 페이지를 고를 때 미리 빼려고 묻는다(요청을 내보내지 않는다) */
  skipping(address: string): boolean;
  /** 그 주소를 조금 전에 열어 본 결과. 두고 있는 것이 없거나 기한이 지났으면 null이다. 요청을 내보내지 않고 집계에도 세지 않는다 */
  peek(address: string): PageReading | null;
  stats(): PageReaderStats;
}

interface Entry {
  reading: PageReading;
  until: number;
  size: number;
}

interface HostState {
  /** 연달아 응답하지 않은 수(시간 초과, 연결 실패) */
  misses: number;
  skipUntil: number;
  /** 건너뛰는 시간이 지난 뒤, 살아났는지 보려고 내보낸 요청이 아직 돌아오지 않았다 */
  probing: boolean;
}

/**
 * 그 사이트가 응답하지 않았다는 뜻의 실패. 연달아 나오면 그 사이트를 잠시 건너뛴다.
 * 시간 초과만 세면, 접속하자마자 끊는 사이트(연결 실패)는 건너뛰지 않게 된다. 그러면 방금 못 연 주소를 뺀 자리에
 * 같은 사이트의 다른 주소가 뽑혀, 우리를 막는 사이트에 요청만 늘어난다(2026-11-22 측정)
 */
const NO_RESPONSE = new Set<string>(['시간 초과', '연결 실패']);
/** 사이트가 응답은 했다는 뜻의 실패. 응답 없는 사이트로 세지 않고, 연달아 세던 수를 지운다 */
const ANSWERED = new Set<string>(['접근 제한', '페이지 없음', '서버 오류', '지원하지 않는 형식', '리디렉션 과다']);
/** 잠깐의 문제일 수 있어 짧게만 기억하는 실패. 나머지 실패(없는 페이지, 거부, 읽을 수 없는 형식)는 다시 열어도 같다 */
const TRANSIENT = new Set<string>(['시간 초과', '연결 실패', '서버 오류']);

/** 같은 페이지로 볼 주소의 꼴. 주소에 붙은 세션 표시(;jsessionid=…)와 # 뒤는 뗀다 */
export function pageKey(address: string): string {
  try {
    const url = new URL(address);
    url.hash = '';
    url.pathname = url.pathname.replace(/;jsessionid=[^/;]*/gi, '');
    return url.href;
  } catch {
    return address;
  }
}

function hostOf(address: string): string {
  try {
    return new URL(address).hostname.toLowerCase();
  } catch {
    return '';
  }
}

export function createPageReader(options: PageReaderOptions = {}): PageReader {
  const get = options.get ?? safeGet;
  const now = options.now ?? Date.now;
  const limits: CacheLimits = { ...LIMITS.pageCache, ...options.limits };
  const timeoutMs = options.timeoutMs ?? LIMITS.gather.pageTimeoutMs;
  const maxBytes = options.maxBytes ?? LIMITS.gather.pageBytes;

  const entries = new Map<string, Entry>();
  const loading = new Map<string, Promise<PageReading>>();
  const hosts = new Map<string, HostState>();
  const counts = { opened: 0, reused: 0, joined: 0, skipped: 0 };
  let chars = 0;

  const stamp = () => new Date(now()).toISOString();

  const drop = (key: string) => {
    const entry = entries.get(key);
    if (!entry) return;
    chars -= entry.size;
    entries.delete(key);
  };

  const keep = (key: string, reading: PageReading) => {
    drop(key);
    const size = reading.ok ? reading.page.chars + reading.links.reduce((n, l) => n + l.url.length + l.text.length, 0) : 0;
    // 아주 큰 페이지 하나가 자리를 다 차지하지 않게, 한도의 4분의 1을 넘으면 두지 않는다
    if (size > limits.chars / 4) return;
    entries.set(key, { reading, until: now() + (reading.ok || !TRANSIENT.has(reading.reason) ? limits.okMs : limits.failMs), size });
    chars += size;
    if (entries.size <= limits.entries && chars <= limits.chars) return;
    // 넘치면 기한이 지난 것부터 빼고, 그래도 넘치면 오래된 것부터 뺀다(Map은 넣은 순서대로 돈다)
    const t = now();
    for (const [k, e] of entries) if (e.until <= t) drop(k);
    for (const k of entries.keys()) {
      if (entries.size <= limits.entries && chars <= limits.chars) break;
      drop(k);
    }
  };

  /** 그 사이트를 지금 열어도 되는지. 건너뛰는 시간이 지났으면 요청 하나만 시험 삼아 내보낸다 */
  const gate = (host: string): 'open' | 'skip' | 'probe' => {
    const state = hosts.get(host);
    if (!state || state.misses < limits.hostSkipAfter) return 'open';
    if (now() < state.skipUntil || state.probing) return 'skip';
    state.probing = true;
    return 'probe';
  };

  /** 연 결과를 그 사이트의 상태에 반영한다 */
  const settle = (host: string, reading: PageReading, probe: boolean) => {
    const state = hosts.get(host) ?? { misses: 0, skipUntil: 0, probing: false };
    if (probe) state.probing = false;
    if (!reading.ok && NO_RESPONSE.has(reading.reason)) {
      state.misses += 1;
      if (state.misses >= limits.hostSkipAfter) state.skipUntil = now() + limits.hostSkipMs;
    } else if (reading.ok || ANSWERED.has(reading.reason)) {
      // 응답이 왔다. 내용이 없거나 거부했더라도 그 사이트는 살아 있다
      state.misses = 0;
      state.skipUntil = 0;
    }
    if (state.misses === 0 && !state.probing) hosts.delete(host);
    else hosts.set(host, state);
  };

  /** 실제로 연다. 던지지 않는다(기다리던 쪽이 먼저 떠나도 받는 곳 없는 오류가 남지 않게) */
  const load = async (key: string, address: string, host: string, probe: boolean): Promise<PageReading> => {
    const fetchedAt = stamp();
    let reading: PageReading;
    try {
      const got = await get(address, { timeoutMs, maxBytes });
      if (!got.ok) {
        reading = { ok: false, reason: got.reason, detail: got.detail, fetchedAt };
      } else {
        const { page, links } = readHtml(decodeBody(got.body, got.contentType).text, got.url);
        // 여러 명제가 같은 결과를 함께 쓰므로 고치지 못하게 얼려 둔다
        Object.freeze(page.blocks);
        reading = { ok: true, url: got.url, truncated: got.truncated, page, links: Object.freeze(links.slice(0, limits.links)) as PageLink[], fetchedAt };
      }
    } catch (e) {
      reading = { ok: false, reason: '지원하지 않는 형식', detail: `페이지를 읽지 못했다: ${String((e as Error)?.message ?? e).slice(0, 60)}`, fetchedAt };
    }
    loading.delete(key);
    settle(host, reading, probe);
    keep(key, reading);
    return reading;
  };

  const waitFor = (pending: Promise<PageReading>, waitMs: number): Promise<PageReading> =>
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ ok: false, reason: '시간 초과', detail: '', fetchedAt: stamp() }), Math.max(0, waitMs));
      void pending.then((reading) => {
        clearTimeout(timer);
        resolve(reading);
      });
    });

  return {
    read(address, waitMs) {
      const key = pageKey(address);
      const entry = entries.get(key);
      if (entry) {
        if (now() < entry.until) {
          counts.reused += 1;
          return Promise.resolve(entry.reading);
        }
        drop(key);
      }
      let pending = loading.get(key);
      if (pending) {
        counts.joined += 1;
      } else {
        const host = hostOf(address);
        const pass = gate(host);
        if (pass === 'skip') {
          counts.skipped += 1;
          return Promise.resolve({ ok: false, reason: SKIPPED_REASON, detail: '이 사이트가 앞서 연달아 응답하지 않았다', fetchedAt: stamp() });
        }
        counts.opened += 1;
        pending = load(key, address, host, pass === 'probe');
        loading.set(key, pending);
      }
      return waitFor(pending, waitMs);
    },
    skipping(address) {
      const state = hosts.get(hostOf(address));
      return Boolean(state && state.misses >= limits.hostSkipAfter && (now() < state.skipUntil || state.probing));
    },
    peek(address) {
      const entry = entries.get(pageKey(address));
      return entry && now() < entry.until ? entry.reading : null;
    },
    stats: () => ({ ...counts, kept: entries.size, chars }),
  };
}

const SHARED = Symbol.for('whitechecker.pageReader');

/** 서버 하나가 함께 쓰는 읽기 도구. 모듈이 여러 번 읽혀도(개발 서버, 경로별 묶음) 하나만 남게 전역에 둔다 */
function sharedReader(): PageReader {
  const holder = globalThis as unknown as Record<symbol, PageReader | undefined>;
  let reader = holder[SHARED];
  if (!reader) {
    reader = createPageReader();
    holder[SHARED] = reader;
  }
  return reader;
}

/** 주소 하나를 읽는다. 같은 주소는 잠깐 동안 한 번만 연다. waitMs는 부른 쪽이 기다릴 수 있는 시간이다 */
export function readPage(address: string, waitMs: number): Promise<PageReading> {
  return sharedReader().read(address, waitMs);
}

/**
 * 지금 열어 봐야 소용없는 주소면 그 까닭을, 아니면 빈 문자열을 돌려준다. 열 페이지를 고를 때 미리 빼려고 묻는다(요청을 내보내지 않는다).
 * - 그 사이트가 연달아 응답하지 않아 건너뛰는 중이다
 * - 조금 전에 다른 명제가 열어 보았다가 못 열었다(실패를 기억하는 동안만)
 * - 조금 전에 열어 보니 본문이 없었다(스크립트로 그리는 페이지 등)
 * 이런 주소를 고르면 바로 실패로 돌아오지만, 명제마다 정해 둔 여는 횟수는 하나 줄어든다. 고르지 않으면 그 자리에 다른 후보를 열 수 있다
 * @param minChars 이보다 짧게 뽑힌 페이지는 본문을 읽지 못한 것으로 본다
 */
export function unopenableReason(address: string, minChars: number, reader: PageReader = sharedReader()): string {
  if (reader.skipping(address)) return SKIPPED_REASON;
  const seen = reader.peek(address);
  if (!seen) return '';
  if (!seen.ok) return `${RECENT_FAILURE}: ${seen.reason}`;
  return seen.page.chars < minChars ? `${RECENT_FAILURE}: 본문 없음` : '';
}

/** 함께 쓰는 읽기 도구의 집계. 진단과 확인용 */
export function pageReaderStats(): PageReaderStats {
  return sharedReader().stats();
}
