// 공개 웹 페이지 하나를 받아 온다.
// - 사설·로컬 주소는 열지 않는다. 이름을 주소로 바꾸는 순간에 검사하므로, 검사한 뒤에 주소가 바뀌어도 막힌다.
// - 리디렉션은 직접 따라가며 옮겨 간 주소도 같은 검사를 한다.
// - 받는 크기와 시간에 한도를 둔다.
// - 앱은 자기 이름을 밝힌 채로만 연다. 사이트가 거부하면 그대로 실패로 돌려주고, 헤더를 바꿔 다시 열지 않는다.
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import zlib from 'node:zlib';
import type { Readable } from 'node:stream';
import { isPublicAddress } from './address.ts';

/** 앱이 원문을 열 때 쓰는 이름 */
export const USER_AGENT = 'WhiteCheckerPrototype/0.1 (fact-check research)';

export type GetFailure =
  | '주소 차단'
  | '접근 제한'
  | '페이지 없음'
  | '서버 오류'
  | '시간 초과'
  | '연결 실패'
  | '지원하지 않는 형식'
  | '리디렉션 과다';

export type GetResult =
  | {
      ok: true;
      /** 리디렉션을 따라간 뒤의 마지막 주소 */
      url: string;
      status: number;
      contentType: string;
      body: Buffer;
      /** 크기 한도에 걸려 앞부분만 받았다 */
      truncated: boolean;
      seconds: number;
    }
  | { ok: false; url: string; status: number | null; reason: GetFailure; detail: string; seconds: number };

export interface GetOptions {
  timeoutMs: number;
  maxBytes: number;
  maxRedirects?: number;
}

const ALLOWED_PORTS = new Set(['', '80', '443', '8080', '8443']);
const READABLE_TYPES = /^\s*(text\/html|application\/xhtml\+xml|text\/plain)\b/i;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/** 열어도 되는 주소면 null, 아니면 막은 이유 */
export function blockedReason(url: URL): string | null {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return '웹 주소가 아니다';
  if (url.username || url.password) return '계정 정보가 든 주소';
  if (!ALLOWED_PORTS.has(url.port)) return '허용하지 않는 포트';
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (net.isIP(host)) return isPublicAddress(host) ? null : '사설·로컬 주소';
  if (!host.includes('.') || /\.(local|localhost|internal|lan|home|corp|test)$/.test(host)) return '내부 이름';
  return null;
}

// 이름을 주소로 바꿀 때 불린다. 돌아온 주소 가운데 하나라도 막힌 대역이면 연결하지 않는다.
function guardedLookup(hostname: string, options: dns.LookupOptions, callback: (...args: any[]) => void): void {
  dns.lookup(hostname, { ...options, all: true }, (err, found) => {
    if (err) return callback(err);
    const list = found as dns.LookupAddress[];
    if (list.length === 0 || list.some((a) => !isPublicAddress(a.address))) {
      const blocked = new Error('blocked address') as NodeJS.ErrnoException;
      blocked.code = 'EBLOCKED';
      return callback(blocked);
    }
    if (options.all) callback(null, list);
    else callback(null, list[0].address, list[0].family);
  });
}

type Step =
  | { kind: 'body'; status: number; contentType: string; body: Buffer; truncated: boolean }
  | { kind: 'redirect'; status: number; location: string }
  | { kind: 'status'; status: number }
  | { kind: 'type'; status: number; contentType: string }
  | { kind: 'timeout' }
  | { kind: 'error'; error: NodeJS.ErrnoException };

function requestOnce(url: URL, deadline: number, maxBytes: number): Promise<Step> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (step: Step) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(step);
    };

    const client = url.protocol === 'https:' ? https : http;
    const req = client.request(
      url,
      {
        method: 'GET',
        agent: false,
        lookup: guardedLookup as net.LookupFunction,
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'text/html,application/xhtml+xml;q=0.9,text/plain;q=0.8,*/*;q=0.1',
          'Accept-Language': 'ko,en;q=0.8',
          'Accept-Encoding': 'gzip, deflate, br',
        },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const location = res.headers.location;
        if (REDIRECTS.has(status) && location) {
          res.resume();
          req.destroy();
          return finish({ kind: 'redirect', status, location });
        }
        if (status < 200 || status >= 300) {
          res.resume();
          req.destroy();
          return finish({ kind: 'status', status });
        }
        const contentType = String(res.headers['content-type'] ?? '');
        if (contentType && !READABLE_TYPES.test(contentType)) {
          req.destroy();
          return finish({ kind: 'type', status, contentType });
        }

        const encoding = String(res.headers['content-encoding'] ?? '').toLowerCase();
        let stream: Readable = res;
        if (encoding === 'gzip' || encoding === 'x-gzip') stream = res.pipe(zlib.createGunzip());
        else if (encoding === 'deflate') stream = res.pipe(zlib.createInflate());
        else if (encoding === 'br') stream = res.pipe(zlib.createBrotliDecompress());

        const chunks: Buffer[] = [];
        let size = 0;
        let truncated = false;
        const done = () => finish({ kind: 'body', status, contentType, body: Buffer.concat(chunks), truncated });
        stream.on('data', (chunk: Buffer) => {
          if (truncated) return;
          const room = maxBytes - size;
          if (chunk.length > room) {
            // 한도까지만 받고 끊는다. 앞부분은 그대로 쓴다
            chunks.push(chunk.subarray(0, room));
            size = maxBytes;
            truncated = true;
            req.destroy();
            done();
            return;
          }
          chunks.push(chunk);
          size += chunk.length;
        });
        stream.on('end', done);
        // 받는 도중에 끊기면 받은 만큼만 쓴다
        const broken = (error: NodeJS.ErrnoException) => {
          if (size > 0) {
            truncated = true;
            done();
          } else {
            finish({ kind: 'error', error });
          }
        };
        stream.on('error', broken);
        if (stream !== res) res.on('error', broken);
      },
    );
    req.on('error', (error: NodeJS.ErrnoException) => finish({ kind: 'error', error }));
    timer = setTimeout(() => {
      finish({ kind: 'timeout' });
      req.destroy();
    }, Math.max(0, deadline - Date.now()));
    req.end();
  });
}

function statusFailure(status: number): GetFailure {
  if (status === 404 || status === 410) return '페이지 없음';
  if (status >= 500) return '서버 오류';
  return '접근 제한';
}

/** 주소 하나를 연다. 실패는 예외가 아니라 이유가 붙은 결과로 돌려준다 */
export async function safeGet(address: string, options: GetOptions): Promise<GetResult> {
  const t0 = performance.now();
  const seconds = () => Math.round((performance.now() - t0) / 100) / 10;
  const deadline = Date.now() + options.timeoutMs;
  const maxRedirects = options.maxRedirects ?? 5;
  const fail = (url: string, reason: GetFailure, detail: string, status: number | null = null): GetResult => ({
    ok: false,
    url,
    status,
    reason,
    detail,
    seconds: seconds(),
  });

  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return fail(address, '주소 차단', '주소를 읽을 수 없다');
  }

  for (let hop = 0; ; hop += 1) {
    const blocked = blockedReason(url);
    if (blocked) return fail(url.href, '주소 차단', blocked);
    if (Date.now() >= deadline) return fail(url.href, '시간 초과', '');

    const step = await requestOnce(url, deadline, options.maxBytes);
    if (step.kind === 'body') {
      return {
        ok: true,
        url: url.href,
        status: step.status,
        contentType: step.contentType,
        body: step.body,
        truncated: step.truncated,
        seconds: seconds(),
      };
    }
    if (step.kind === 'redirect') {
      if (hop >= maxRedirects) return fail(url.href, '리디렉션 과다', '', step.status);
      try {
        url = new URL(step.location, url);
      } catch {
        return fail(url.href, '연결 실패', '옮겨 갈 주소를 읽을 수 없다', step.status);
      }
      continue;
    }
    if (step.kind === 'status') return fail(url.href, statusFailure(step.status), `HTTP ${step.status}`, step.status);
    if (step.kind === 'type') return fail(url.href, '지원하지 않는 형식', step.contentType.slice(0, 60), step.status);
    if (step.kind === 'timeout') return fail(url.href, '시간 초과', '');
    if (step.error.code === 'EBLOCKED') return fail(url.href, '주소 차단', '사설·로컬 주소');
    return fail(url.href, '연결 실패', String(step.error.code ?? step.error.message ?? '').slice(0, 60));
  }
}

/** 받은 바이트를 글자로 바꾼다. 문자 집합은 응답 헤더, 문서 머리의 표시 순으로 찾는다 */
export function decodeBody(body: Buffer, contentType: string): { text: string; charset: string } {
  const head = body.subarray(0, 3000).toString('latin1');
  const charset = (
    contentType.match(/charset=["']?([\w-]+)/i)?.[1] ??
    head.match(/charset=["']?([\w-]+)/i)?.[1] ??
    'utf-8'
  ).toLowerCase();
  try {
    return { text: new TextDecoder(charset).decode(body), charset };
  } catch {
    return { text: new TextDecoder('utf-8').decode(body), charset: 'utf-8' };
  }
}
