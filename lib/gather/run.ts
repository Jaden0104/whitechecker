// [근거 모으기] 명제 하나에 대해 검색, 출처 고르기, 원문 수집, 발췌까지 한다.
// 절차와 횟수는 코드가 통제한다. 모델은 추가 검색이 필요한지와 그 검색어만 정한다.
import { claimKey } from '../evidence.ts';
import { LIMITS } from '../limits.ts';
import { LinerError, chatJson, searchWeb, type Budget, type SearchHit, type SearchOptions } from '../liner.ts';
import { decodeBody, safeGet } from '../net/safe-get.ts';
import { MORE_SEARCH_SCHEMA, MORE_SEARCH_SYSTEM, moreSearchUserMessage } from '../prompts/more-search.ts';
import { STANDARD, hostMatches, requirementMetBeforeJudging } from '../standard.ts';
import type {
  Claim,
  Evidence,
  EvidenceBundle,
  FetchOutcome,
  PremiumData,
  SearchKind,
  SearchRecord,
  SourceInfo,
  Usage,
} from '../types.ts';
import { claimKeywords, pickExcerpts, textRelevance, type Keyword } from './excerpts.ts';
import { extractPageText } from './page-text.ts';
import { mergeResults, orderCandidates, pickPages, type Candidate } from './rank.ts';

export type GatherClaim = Pick<Claim, 'statement' | 'type' | 'qualifiers' | 'asOf' | 'queries' | 'counterQuery'>;

interface PlanItem {
  query: string;
  kind: SearchKind;
  maxResults: number;
  dateRange?: SearchOptions['dateRange'];
  includeKnowledge: boolean;
}

interface OpenedPage {
  candidate: Candidate;
  outcome: FetchOutcome;
  blocks: string[];
  pageDate: string | null;
  /** 이 명제가 묻는 속성까지 다루는 페이지인지. 대상의 이름만 나오면 false */
  direct: boolean;
}

type Batch = { kind: SearchKind; hits: SearchHit[] };

/** 최근에 바뀌었을 수 있어 검색 한 번에 기간을 거는 유형 */
const RECENT_TYPES = new Set<string>(['운영 정보', '수치·통계']);
/** 이보다 짧게 뽑힌 페이지는 본문을 읽지 못한 것으로 본다(스크립트로 그리는 페이지, 오류 안내) */
const MIN_PAGE_CHARS = 200;
/** 추가 검색과 그 뒤의 수집을 위해 남겨 두는 시간 */
const EXTRA_RESERVE_MS = 12_000;
/** 처음에 여는 페이지 수. 나머지 자리는 추가 검색의 몫으로 남겨 둔다 */
const FIRST_ROUND = LIMITS.gather.pages - 1;
/** 열기를 시도하는 횟수의 상한. 주소가 없어졌거나 거부당한 페이지를 다음 후보로 한두 번 메운다 */
const MAX_ATTEMPTS = LIMITS.gather.pages + 2;
/** 묶음에 적는 출처 수의 상한 */
const MAX_SOURCES = 16;
/** 소장처나 운영 주체를 알려 주는 낱말 */
const HOLDER_WORDS = /소장|소재지|관리자|관리단체|소유자|운영 ?기관|주최|주관/;

function searchPlan(claim: GatherClaim): PlanItem[] {
  const basics = claim.queries.map((q) => q.trim()).filter(Boolean).slice(0, 2);
  if (basics.length === 0) basics.push(claim.statement.slice(0, 80));
  const recent = RECENT_TYPES.has(claim.type);
  const plan: PlanItem[] = basics.map((query, i) => ({
    query,
    kind: '기본',
    maxResults: 6,
    // 검색 가운데 한 번은 최근 1년으로 좁혀 바뀐 내용을 찾는다
    dateRange: recent && i === 1 ? 'past_year' : undefined,
    // Premium Data는 수치·통계 유형에서만 받는다
    includeKnowledge: claim.type === '수치·통계' && i === 0,
  }));
  if (claim.counterQuery.trim()) {
    plan.push({ query: claim.counterQuery.trim(), kind: '반증', maxResults: 5, includeKnowledge: false });
  }
  return plan;
}

/** 열어 본 페이지에서 소장처나 운영 주체를 알려 주는 줄을 몇 개 뽑는다. 추가 검색에서 어느 기관을 겨냥할지 정하는 데 쓴다 */
function holderClues(pages: OpenedPage[]): string[] {
  const out = new Set<string>();
  for (const page of pages) {
    page.blocks.forEach((line, i) => {
      if (out.size >= 6 || !HOLDER_WORDS.test(line)) return;
      // 항목 이름과 값이 줄을 달리하는 표가 많아 다음 줄을 붙여 둔다
      const text = line.length < 12 && page.blocks[i + 1] ? `${line} ${page.blocks[i + 1]}` : line;
      if (text.length >= 6) out.add(text.slice(0, 110));
    });
  }
  return [...out];
}

async function openPage(candidate: Candidate, timeoutMs: number, keywords: Keyword[]): Promise<OpenedPage> {
  const fetchedAt = new Date().toISOString();
  const failed = (reason: string, chars = 0): OpenedPage => ({
    candidate,
    outcome: { status: '실패', reason, chars, truncated: false, fetchedAt },
    blocks: [],
    pageDate: null,
    direct: false,
  });
  const got = await safeGet(candidate.url, { timeoutMs, maxBytes: LIMITS.gather.pageBytes });
  if (!got.ok) return failed(got.reason);
  const page = extractPageText(decodeBody(got.body, got.contentType).text);
  // 성공의 기준은 본문 글을 실제로 뽑았는지다
  if (page.chars < MIN_PAGE_CHARS) return failed('본문 없음', page.chars);
  const probe = pickExcerpts(page.blocks, keywords, 2000);
  const relevant = probe.excerpts.length > 0;
  return {
    candidate,
    outcome: {
      status: relevant ? '성공' : '관련 내용 없음',
      reason: '',
      chars: page.chars,
      truncated: got.truncated,
      fetchedAt,
    },
    blocks: relevant ? page.blocks : [],
    pageDate: page.pageDate,
    direct: relevant && probe.direct,
  };
}

export async function gatherEvidence(
  claim: GatherClaim,
  key: string,
  budget: Budget,
): Promise<{ bundle: EvidenceBundle; usage: Usage[] }> {
  const usage: Usage[] = [];
  const searches: SearchRecord[] = [];
  const premium: PremiumData[] = [];
  const keywords = claimKeywords(claim.statement, claim.queries.filter(Boolean), [claim.counterQuery].filter(Boolean));
  const relevanceOf = (text: string) => textRelevance(keywords, text);

  // 검색 한 번. 실패해도 나머지 검색은 계속한다
  const search = async (item: PlanItem): Promise<Batch | LinerError> => {
    try {
      const found = await searchWeb({
        key,
        query: item.query,
        maxResults: item.maxResults,
        dateRange: item.dateRange,
        includeKnowledge: item.includeKnowledge,
        budget,
      });
      searches.push({ query: item.query, kind: item.kind, dateRange: item.dateRange ?? null, results: found.hits.length, error: null });
      premium.push(...found.knowledge);
      usage.push({
        stage: '근거 모으기',
        model: item.includeKnowledge ? 'search/web+knowledge' : 'search/web',
        promptTokens: 0,
        completionTokens: 0,
        searchCalls: 1,
        seconds: found.seconds,
      });
      return { kind: item.kind, hits: found.hits };
    } catch (e) {
      const error = e instanceof LinerError ? e : new LinerError('연결 실패', null);
      searches.push({ query: item.query, kind: item.kind, dateRange: item.dateRange ?? null, results: 0, error: error.kind });
      return error;
    }
  };

  // 1. 검색: 기본 2회, 반증 검색어가 있으면 1회 더
  const first = await Promise.all(searchPlan(claim).map(search));
  const batches = first.filter((r): r is Batch => !(r instanceof LinerError));
  if (batches.length === 0) throw first[0] as LinerError;
  let candidates = mergeResults(batches, relevanceOf);

  // 2. 원문 수집: 잠정 평가가 높은 순으로 연다
  const opened: OpenedPage[] = [];
  const openedUrls = new Set<string>();
  const good = () => opened.filter((p) => p.outcome.status === '성공');
  /** 고른 페이지를 한꺼번에 연다. 성공한 페이지 수와 시도 횟수의 상한을 넘지 않는다 */
  const open = async (picks: Candidate[], reserveMs: number) => {
    const room = Math.min(LIMITS.gather.pages - good().length, MAX_ATTEMPTS - opened.length);
    const timeoutMs = Math.min(LIMITS.gather.pageTimeoutMs, budget.deadline - Date.now() - reserveMs);
    const list = picks.slice(0, Math.max(0, room));
    if (list.length === 0 || timeoutMs < 1500) return;
    for (const c of list) openedUrls.add(c.url);
    opened.push(...(await Promise.all(list.map((c) => openPage(c, timeoutMs, keywords)))));
  };
  await open(pickPages(candidates, FIRST_ROUND, openedUrls, Boolean(claim.counterQuery.trim())), EXTRA_RESERVE_MS);
  // 열지 못한 곳이 있으면 다음 후보로 한 번 메운다
  const missed = FIRST_ROUND - good().length;
  if (missed > 0) await open(pickPages(candidates, missed, openedUrls, false), EXTRA_RESERVE_MS);

  // 3. 요구하는 등급의 출처가 이 명제가 묻는 속성까지 다루는지 본다. 모자라면 추가 검색을 한 번 한다.
  //    1등급 하나로도 채울 수 있는 유형은 2등급 둘로는 채운 것으로 치지 않는다(독립인지는 판정에서야 알 수 있다)
  const satisfied = () =>
    requirementMetBeforeJudging(
      claim.type,
      good()
        .filter((p) => p.direct)
        .map((p) => p.candidate.provisionalGrade),
    );
  const extraSearch = { done: false, reason: '' };
  let extraCandidates: Candidate[] = [];

  if (satisfied()) {
    extraSearch.reason = '요구하는 등급의 출처를 확보했다';
  } else if (searches.length >= LIMITS.gather.queries || budget.deadline - Date.now() < 10_000) {
    extraSearch.reason = '남은 시간이나 검색 횟수가 모자라 하지 않았다';
  } else {
    try {
      // 사이트 후보: 기준 파일의 기관 목록과, 검색 결과에 나온 잠정 1~2등급 사이트
      const sites = new Map<string, string>();
      for (const i of STANDARD.domains.institutions) sites.set(i.domain, i.publisher);
      for (const c of candidates) {
        const host = c.hostname.replace(/^www\./, '');
        if (c.provisionalGrade <= 2 && ![...sites.keys()].some((d) => hostMatches(host, d))) sites.set(host, c.publisherHint);
      }
      const { value, usage: used } = await chatJson<{ need_more: boolean; site: string; query: string; reason: string }>({
        stage: '추가 검색 판단',
        key,
        system: MORE_SEARCH_SYSTEM,
        user: moreSearchUserMessage({
          statement: claim.statement,
          type: claim.type,
          asOf: claim.asOf,
          need: STANDARD.requirements[claim.type]?.need ?? '',
          queries: searches.map((s) => s.query),
          results: orderCandidates(candidates)
            .slice(0, 10)
            .map((c) => {
              const page = opened.find((p) => p.candidate === c);
              const outcome = !page
                ? c.skip || '열지 않음'
                : page.outcome.status === '실패'
                  ? `열지 못함(${page.outcome.reason})`
                  : page.outcome.status === '성공' && !page.direct
                    ? '열었으나 찾는 내용이 없음'
                    : page.outcome.status;
              return { grade: c.provisionalGrade, hostname: c.hostname, title: c.title.slice(0, 80), summary: c.summary.slice(0, 120), outcome };
            }),
          sites: [...sites].map(([domain, publisher]) => ({ domain, publisher })),
          clues: holderClues(good()),
        }),
        schemaName: 'more_search',
        schema: MORE_SEARCH_SCHEMA,
        maxTokens: LIMITS.gather.decideTokens,
        budget,
        routingStrategy: 'cost',
      });
      usage.push(used);
      extraSearch.reason = (value.reason ?? '').trim().slice(0, 200);
      const words = (value.query ?? '').replace(/site:\S+/gi, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
      // 사이트는 후보에 있는 것만 받는다. 모델이 지어낸 도메인으로는 찾지 않는다
      const site = [...sites.keys()].find((d) => d === (value.site ?? '').trim().toLowerCase().replace(/^www\./, '')) ?? '';
      const query = site ? `site:${site} ${words}` : words;
      const squeeze = (s: string) => s.replace(/\s+/g, '');
      if (value.need_more && words && !searches.some((s) => squeeze(s.query) === squeeze(query))) {
        const found = await search({ query, kind: '추가', maxResults: 8, includeKnowledge: false });
        if (!(found instanceof LinerError)) {
          extraSearch.done = true;
          const before = new Set(candidates.map((c) => c.url));
          candidates = mergeResults([found], relevanceOf, candidates);
          extraCandidates = candidates.filter((c) => !before.has(c.url));
        }
      }
    } catch (e) {
      // 추가 검색은 덤이다. 실패해도 모은 근거는 그대로 돌려준다
      extraSearch.reason = `추가 검색을 하지 못했다(${e instanceof LinerError ? e.kind : '오류'})`;
    }
  }

  // 4. 남은 자리에 더 연다. 추가 검색의 결과를 먼저 보고, 그래도 모자라면 잠정 2등급 이상의 다음 후보를 연다
  if (!satisfied()) {
    await open(pickPages(extraCandidates, LIMITS.gather.pages - good().length, openedUrls, false), 1500);
    if (!satisfied()) {
      const better = candidates.filter((c) => c.provisionalGrade <= 2);
      await open(pickPages(better, 1, openedUrls, false), 1500);
    }
  }

  // 5. 발췌: 관련 있는 페이지끼리 글자 수를 나눠 쓴다. 잠정 등급이 높은 출처를 앞에 둔다
  const useful = good().sort((a, b) => a.candidate.provisionalGrade - b.candidate.provisionalGrade);
  const others = opened.filter((p) => p.outcome.status !== '성공');
  const perPage = Math.min(4000, Math.floor(LIMITS.gather.excerptChars / Math.max(1, useful.length)));

  const sources: SourceInfo[] = [];
  const evidence: Evidence[] = [];
  let total = 0;
  const addSource = (c: Candidate, outcome: FetchOutcome, pageDate: string | null): number => {
    const no = sources.length + 1;
    sources.push({
      no,
      url: c.url,
      title: c.title,
      hostname: c.hostname,
      date: c.date,
      pageDate,
      summary: c.summary,
      foundBy: c.foundBy,
      provisionalGrade: c.provisionalGrade,
      publisherHint: c.publisherHint,
      lowPlatform: c.lowPlatform,
      fetch: outcome,
    });
    return no;
  };
  for (const page of useful) {
    const sourceNo = addSource(page.candidate, page.outcome, page.pageDate);
    for (const text of pickExcerpts(page.blocks, keywords, perPage).excerpts) {
      if (total + text.length > LIMITS.gather.excerptChars) break;
      evidence.push({ no: evidence.length + 1, sourceNo, text });
      total += text.length;
    }
  }
  for (const page of others) addSource(page.candidate, page.outcome, page.pageDate);
  for (const c of orderCandidates(candidates)) {
    if (sources.length >= MAX_SOURCES) break;
    if (openedUrls.has(c.url)) continue;
    addSource(c, { status: '열지 않음', reason: c.skip, chars: 0, truncated: false, fetchedAt: null }, null);
  }

  const bundle: EvidenceBundle = {
    v: 1,
    claimKey: claimKey(claim),
    gatheredAt: new Date().toISOString(),
    searches,
    sources,
    evidence,
    extraSearch,
    premium: premium.slice(0, 3),
  };
  return { bundle, usage };
}
