// 검색 결과를 모아 어느 페이지부터 열지 정한다. 여기서 쓰는 등급은 잠정 평가다.
import type { SearchHit } from '../liner.ts';
import { excludedReason, institutionOf, isLowGradePlatform, provisionalGrade } from '../standard.ts';
import type { Grade, SearchKind } from '../types.ts';

export interface Candidate {
  url: string;
  title: string;
  hostname: string;
  date: string | null;
  summary: string;
  /** 어느 검색에서 나왔는지 */
  foundBy: SearchKind[];
  /** 검색 결과 안에서 가장 앞섰던 순위(0이 가장 앞) */
  bestRank: number;
  provisionalGrade: Grade;
  /** 기관 도메인 목록에서 찾은 기관 이름. 없으면 빈 문자열 */
  publisherHint: string;
  lowPlatform: boolean;
  /** 열지 않는 이유. 열 수 있으면 빈 문자열 */
  skip: string;
  /** 제목과 요약이 명제와 겹치는 정도. 여는 순서를 정하는 데만 쓴다 */
  relevance: number;
}

/** 본문을 읽을 수 없는 형식의 파일 주소 */
export const UNREADABLE = /\.(pdf|hwp|hwpx|docx?|xlsx?|pptx?|zip|jpe?g|png|gif|mp4|mp3)$/i;

function keyOf(url: URL): string {
  // 주소에 붙은 세션 표시(;jsessionid=…)만 다른 결과는 같은 페이지다
  const path = url.pathname.replace(/;jsessionid=[^/;]*/gi, '').replace(/\/$/, '');
  return `${url.hostname.toLowerCase().replace(/^www\./, '')}${path}${url.search}`;
}

/** 여러 검색의 결과를 주소 기준으로 합친다 */
export function mergeResults(
  batches: Array<{ kind: SearchKind; hits: SearchHit[] }>,
  relevanceOf: (text: string) => number,
  known: Candidate[] = [],
): Candidate[] {
  const byKey = new Map<string, Candidate>();
  for (const c of known) {
    try {
      byKey.set(keyOf(new URL(c.url)), c);
    } catch {
      // 앞에서 이미 걸러 낸 주소라 여기까지 오지 않는다
    }
  }
  for (const batch of batches) {
    batch.hits.forEach((hit, rank) => {
      let url: URL;
      try {
        url = new URL(hit.url);
      } catch {
        return;
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
      url.hash = '';
      const key = keyOf(url);
      const old = byKey.get(key);
      if (old) {
        if (!old.foundBy.includes(batch.kind)) old.foundBy.push(batch.kind);
        old.bestRank = Math.min(old.bestRank, rank);
        return;
      }
      const hostname = url.hostname.toLowerCase();
      byKey.set(key, {
        url: url.href,
        title: hit.title.slice(0, 160),
        hostname,
        date: hit.date,
        summary: hit.description.slice(0, 240),
        foundBy: [batch.kind],
        bestRank: rank,
        provisionalGrade: provisionalGrade(hostname),
        publisherHint: institutionOf(hostname),
        lowPlatform: isLowGradePlatform(hostname),
        skip: excludedReason(hostname) || (UNREADABLE.test(url.pathname) ? '지원하지 않는 형식' : ''),
        relevance: relevanceOf(`${hit.title} ${hit.description}`),
      });
    });
  }
  return [...byKey.values()];
}

/** 잠정 등급이 높은 것, 제목과 요약이 명제와 많이 겹치는 것, 여러 검색에 함께 나온 것, 순위가 앞선 것 순 */
export function orderCandidates(candidates: Candidate[]): Candidate[] {
  return [...candidates].sort(
    (a, b) =>
      a.provisionalGrade - b.provisionalGrade ||
      b.relevance - a.relevance ||
      b.foundBy.length - a.foundBy.length ||
      a.bestRank - b.bestRank,
  );
}

/**
 * 열 페이지를 고른다. 같은 사이트의 페이지는 되도록 하나만 고르고,
 * 반증 검색을 했으면 그 결과에서도 하나는 연다(반대 근거를 찾으려고 한 검색이기 때문이다).
 */
export function pickPages(candidates: Candidate[], count: number, opened: Set<string>, wantCounter: boolean): Candidate[] {
  const open = orderCandidates(candidates).filter((c) => !c.skip && !opened.has(c.url));
  const picked: Candidate[] = [];
  const hosts = new Set<string>();
  for (const c of open) {
    if (picked.length >= count) break;
    if (hosts.has(c.hostname)) continue;
    picked.push(c);
    hosts.add(c.hostname);
  }
  for (const c of open) {
    if (picked.length >= count) break;
    if (!picked.includes(c)) picked.push(c);
  }
  if (wantCounter && picked.length > 0 && !picked.some((c) => c.foundBy.includes('반증'))) {
    const counter = open.find((c) => c.foundBy.includes('반증') && !picked.includes(c) && !hosts.has(c.hostname));
    if (counter) picked[picked.length - 1] = counter;
  }
  return picked;
}
