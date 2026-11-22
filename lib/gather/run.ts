// [근거 모으기] 명제 하나에 대해 검색, 출처 고르기, 원문 수집, 발췌까지 한다.
// 절차와 횟수는 코드가 통제한다. 모델은 추가 검색이 필요한지와 그 검색어만 정한다.
import { claimKey } from '../evidence.ts';
import { LIMITS } from '../limits.ts';
import { LinerError, chatJson, searchWeb, type Budget, type SearchHit, type SearchOptions } from '../liner.ts';
import { decodeBody, safeGet } from '../net/safe-get.ts';
import { FOLLOW_UP_SYSTEM, MORE_SEARCH_SCHEMA, MORE_SEARCH_SYSTEM, followUpUserMessage, moreSearchUserMessage } from '../prompts/more-search.ts';
import { STANDARD, excludedReason, hostMatches, institutionOf, requirementMetBeforeJudging, siteOf } from '../standard.ts';
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
import { extractLinks, extractPageText } from './page-text.ts';
import { UNREADABLE, mergeResults, orderCandidates, pickPages, type Candidate } from './rank.ts';

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
    maxResults: LIMITS.gather.maxResults,
    // 검색 가운데 한 번은 최근 1년으로 좁혀 바뀐 내용을 찾는다
    dateRange: recent && i === 1 ? 'past_year' : undefined,
    // Premium Data는 수치·통계 유형에서만 받는다
    includeKnowledge: claim.type === '수치·통계' && i === 0,
  }));
  if (claim.counterQuery.trim()) {
    plan.push({ query: claim.counterQuery.trim(), kind: '반증', maxResults: LIMITS.gather.maxResults, includeKnowledge: false });
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

/** 검색 한 번을 하고 기록(검색 내역, 사용량, Premium Data)을 남기는 함수를 만든다. 실패해도 던지지 않고 실패를 돌려준다 */
function makeSearcher(key: string, budget: Budget, searches: SearchRecord[], usage: Usage[], premium: PremiumData[]) {
  return async (item: PlanItem): Promise<Batch | LinerError> => {
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
  const search = makeSearcher(key, budget, searches, usage, premium);

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
                ? c.skip
                  ? `열지 않음(${c.skip})`
                  : '열지 않음'
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
        const found = await search({ query, kind: '추가', maxResults: LIMITS.gather.maxResults, includeKnowledge: false });
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

/** 보강 검색에서 새로 적는 출처 수의 상한 */
const MAX_FOLLOW_UP_SOURCES = 8;
/** 링크의 글자가 찾는 낱말과 이만큼은 겹쳐야 안쪽 페이지로 열어 본다(찾는 내용을 가리키는 낱말 하나, 또는 대상의 이름 둘쯤) */
const MIN_LINK_RELEVANCE = 0.5;

/**
 * 안쪽 페이지 찾기. 앞서 열어 본 기관 사이트의 페이지에서 링크를 읽어, 찾는 내용이 실릴 만한 페이지(연혁, 관람 안내 등)를 후보로 돌려준다.
 * 검색은 기관 사이트의 첫 화면까지만 주고 안쪽 페이지는 잘 주지 않는다. 사람이 메뉴를 눌러 들어가듯 한 단계만 따라간다.
 * 같은 사이트 안의 링크만, 링크에 적힌 글자가 찾는 낱말과 겹치는 것만 고른다. 백과사전이나 논문 사이트에서는 하지 않는다
 * @param site 보강 검색이 겨냥한 사이트. 있으면 그 사이트의 페이지에서만 링크를 읽는다
 * @param wanted 보강 검색어에서 뽑은 낱말(찾는 내용이 실릴 페이지의 이름 등). 이 낱말이 적힌 링크를 먼저 고른다
 * @param knownUrls 이미 찾아 둔 주소. 다시 후보로 내지 않는다
 */
async function innerPages(
  previous: EvidenceBundle,
  site: string,
  keywords: Keyword[],
  wanted: Keyword[],
  knownUrls: Set<string>,
  budget: Budget,
): Promise<Candidate[]> {
  const reference = STANDARD.domains.provisional.grade2;
  const from = previous.sources
    .filter(
      (s) =>
        (s.fetch.status === '성공' || s.fetch.status === '관련 내용 없음') &&
        s.provisionalGrade <= 2 &&
        !s.lowPlatform &&
        !reference.some((d) => hostMatches(s.hostname, d)) &&
        (!site || hostMatches(s.hostname, site)),
    )
    .slice(0, LIMITS.followUp.linkSources);
  // 뒤이어 페이지를 열 시간은 남겨 둔다
  const timeoutMs = Math.min(LIMITS.followUp.linkTimeoutMs, budget.deadline - Date.now() - 20_000);
  if (from.length === 0 || timeoutMs < 1500) return [];

  const byUrl = new Map<string, Candidate>();
  /** 링크의 글자가 보강 검색어의 낱말(예: 연혁)과 겹치는 정도. 명제의 낱말(예: 절 이름)만 겹치는 링크보다 앞에 둔다 */
  const aimed = new Map<string, number>();
  await Promise.all(
    from.map(async (source) => {
      const got = await safeGet(source.url, { timeoutMs, maxBytes: LIMITS.gather.pageBytes });
      if (!got.ok) return;
      const home = siteOf(new URL(got.url).hostname);
      extractLinks(decodeBody(got.body, got.contentType).text, got.url).forEach((link, order) => {
        const url = new URL(link.url);
        if (siteOf(url.hostname) !== home || UNREADABLE.test(url.pathname) || knownUrls.has(url.href) || url.href === got.url) return;
        if (link.text.length < 2 || link.text.length > 40) return;
        const relevance = textRelevance(keywords, link.text);
        if (relevance < MIN_LINK_RELEVANCE || byUrl.has(url.href)) return;
        aimed.set(url.href, textRelevance(wanted, link.text));
        const hostname = url.hostname.toLowerCase();
        byUrl.set(url.href, {
          url: url.href,
          title: link.text,
          hostname,
          date: null,
          summary: '',
          foundBy: ['보강'],
          bestRank: order,
          provisionalGrade: source.provisionalGrade,
          publisherHint: institutionOf(hostname),
          lowPlatform: false,
          skip: excludedReason(hostname),
          relevance,
        });
      });
    }),
  );
  return [...byUrl.values()]
    .filter((c) => !c.skip)
    .sort((a, b) => (aimed.get(b.url) ?? 0) - (aimed.get(a.url) ?? 0) || b.relevance - a.relevance || a.bestRank - b.bestRank);
}

/**
 * 보강 검색. 한 차례 판정했지만 근거가 모자랐던 명제('근거 부족'이거나, '불일치'의 반박 근거가 한 곳뿐)에 대해, 모자란 근거를 겨냥해 한 번 더 찾는다.
 * 앞서 모은 근거 묶음은 그대로 두고(번호도 그대로) 새로 찾은 출처와 발췌를 뒤에 붙여 돌려준다. 한 묶음에 한 번만 한다.
 * @param missing 판정에서 무엇이 모자랐는지. 화면이 판정의 까닭과 권고에서 가져와 보낸다. 검색어를 정하는 데만 쓴다
 */
export async function gatherMore(
  claim: GatherClaim,
  previous: EvidenceBundle,
  missing: string,
  key: string,
  budget: Budget,
): Promise<{ bundle: EvidenceBundle; usage: Usage[] }> {
  if (previous.followUp) return { bundle: previous, usage: [] };

  const usage: Usage[] = [];
  const searches: SearchRecord[] = [];
  // 발췌를 고르는 낱말. 보강 검색어를 정한 뒤에는 그 검색어의 낱말도 더한다.
  // 외국 기관의 공식 페이지처럼 한국어가 아닌 글은 명제의 낱말이 걸리지 않아, 검색어의 낱말이 없으면 관련 없는 페이지로 버려진다
  let keywords = claimKeywords(claim.statement, claim.queries.filter(Boolean), [claim.counterQuery].filter(Boolean));
  const relevanceOf = (text: string) => textRelevance(keywords, text);
  const search = makeSearcher(key, budget, searches, usage, []);

  // 앞서 찾은 출처를 후보로 되살린다. 열지 않았던 것은 이번에 열 수 있다
  const sourceByUrl = new Map(previous.sources.map((s) => [s.url, s]));
  const known: Candidate[] = previous.sources.map((s, i) => ({
    url: s.url,
    title: s.title,
    hostname: s.hostname,
    date: s.date,
    summary: s.summary,
    foundBy: [...s.foundBy],
    bestRank: i,
    provisionalGrade: s.provisionalGrade,
    publisherHint: s.publisherHint,
    lowPlatform: s.lowPlatform,
    skip: s.fetch.status === '열지 않음' ? s.fetch.reason : '',
    relevance: relevanceOf(`${s.title} ${s.summary}`),
  }));
  const openedUrls = new Set(previous.sources.filter((s) => s.fetch.status !== '열지 않음').map((s) => s.url));
  const hasExcerpt = new Set(previous.evidence.map((e) => e.sourceNo));

  const followUp = { done: false, reason: '', added: 0, linked: 0 };
  let candidates = known;
  let fresh: Candidate[] = [];
  let wanted = true;
  /** 보강 검색이 겨냥한 사이트. 정하지 않았으면 빈 문자열 */
  let targetSite = '';
  /** 보강 검색어에서 뽑은 낱말. 안쪽 페이지를 고를 때 이 낱말이 적힌 링크를 먼저 본다 */
  let aimWords: Keyword[] = [];
  try {
    const sites = new Map<string, string>();
    for (const i of STANDARD.domains.institutions) sites.set(i.domain, i.publisher);
    for (const c of known) {
      const host = c.hostname.replace(/^www\./, '');
      if (c.provisionalGrade <= 2 && ![...sites.keys()].some((d) => hostMatches(host, d))) sites.set(host, c.publisherHint);
    }
    const clues: string[] = [];
    for (const e of previous.evidence) {
      for (const line of e.text.split('\n')) {
        if (clues.length < 6 && line.length >= 6 && HOLDER_WORDS.test(line)) clues.push(line.slice(0, 110));
      }
    }
    const { value, usage: used } = await chatJson<{ need_more: boolean; site: string; query: string; reason: string }>({
      stage: '보강 검색 판단',
      key,
      system: FOLLOW_UP_SYSTEM,
      user: followUpUserMessage({
        statement: claim.statement,
        type: claim.type,
        asOf: claim.asOf,
        need: STANDARD.requirements[claim.type]?.need ?? '',
        missing: missing.trim().slice(0, LIMITS.followUp.missingChars),
        queries: previous.searches.map((s) => s.query),
        results: orderCandidates(known)
          .slice(0, 12)
          .map((c) => {
            const source = sourceByUrl.get(c.url);
            const status = source?.fetch.status ?? '열지 않음';
            const outcome =
              status === '성공'
                ? source && hasExcerpt.has(source.no)
                  ? '열어서 발췌를 실음'
                  : '열었으나 찾는 내용이 없음'
                : status === '관련 내용 없음'
                  ? '열었으나 찾는 내용이 없음'
                  : status === '실패'
                    ? `열지 못함(${source?.fetch.reason ?? ''})`
                    : c.skip
                      ? `열지 않음(${c.skip})`
                      : '열지 않음';
            return { grade: c.provisionalGrade, hostname: c.hostname, title: c.title.slice(0, 80), summary: c.summary.slice(0, 120), outcome };
          }),
        sites: [...sites].map(([domain, publisher]) => ({ domain, publisher })),
        clues,
      }),
      schemaName: 'more_search',
      schema: MORE_SEARCH_SCHEMA,
      maxTokens: LIMITS.gather.decideTokens,
      budget,
      routingStrategy: 'cost',
    });
    usage.push(used);
    followUp.reason = (value.reason ?? '').trim().slice(0, 200);
    wanted = Boolean(value.need_more);
    const words = (value.query ?? '').replace(/site:\S+/gi, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
    // 사이트는 후보에 있는 것만 받는다. 모델이 지어낸 도메인으로는 찾지 않는다
    const site = [...sites.keys()].find((d) => d === (value.site ?? '').trim().toLowerCase().replace(/^www\./, '')) ?? '';
    const query = site ? `site:${site} ${words}` : words;
    const squeeze = (s: string) => s.replace(/\s+/g, '');
    targetSite = site;
    // 보강 검색어의 낱말(찾는 내용이 실릴 페이지의 이름 등)도 발췌와 안쪽 페이지를 고르는 낱말로 쓴다
    if (wanted && words) {
      keywords = claimKeywords(claim.statement, claim.queries.filter(Boolean), [claim.counterQuery, words].filter(Boolean));
      aimWords = claimKeywords('', [], [words]);
    }
    if (wanted && words && !previous.searches.some((s) => squeeze(s.query) === squeeze(query))) {
      const found = await search({ query, kind: '보강', maxResults: LIMITS.gather.maxResults, includeKnowledge: false });
      if (!(found instanceof LinerError)) {
        followUp.done = true;
        const before = new Set(known.map((c) => c.url));
        candidates = mergeResults([found], relevanceOf, known);
        fresh = candidates.filter((c) => !before.has(c.url));
      }
    }
  } catch (e) {
    // 한 번 더 찾는 것은 덤이다. 실패해도 앞서 모은 근거는 그대로 돌려준다
    followUp.reason = `보강 검색을 하지 못했다(${e instanceof LinerError ? e.kind : '오류'})`;
    wanted = false;
  }

  // 새로 찾은 페이지를 먼저 열고, 자리가 남으면 앞서 찾아 두고 열지 않았던 잠정 2등급 이상의 페이지를 연다
  const opened: OpenedPage[] = [];
  const good = () => opened.filter((p) => p.outcome.status === '성공');
  const open = async (picks: Candidate[]) => {
    const room = Math.min(LIMITS.followUp.pages - good().length, LIMITS.followUp.attempts - opened.length);
    const timeoutMs = Math.min(LIMITS.gather.pageTimeoutMs, budget.deadline - Date.now() - 1500);
    const list = picks.slice(0, Math.max(0, room));
    if (list.length === 0 || timeoutMs < 1500) return;
    for (const c of list) openedUrls.add(c.url);
    opened.push(...(await Promise.all(list.map((c) => openPage(c, timeoutMs, keywords)))));
  };
  if (wanted) {
    const left = () => LIMITS.followUp.pages - good().length;
    // 안쪽 페이지를 먼저 연다. 앞서 연 기관 사이트의 메뉴에서, 찾는 내용을 가리키는 이름이 붙은 링크를 따라간다.
    // 실패해도(사이트가 응답하지 않는 경우 등) 검색으로 찾은 페이지는 그대로 연다
    const linked = await innerPages(previous, targetSite, keywords, aimWords, new Set(candidates.map((c) => c.url)), budget).catch(() => []);
    const before = opened.length;
    const goodLinks = () => opened.slice(before).filter((p) => p.outcome.status === '성공').length;
    await open(linked.slice(0, LIMITS.followUp.linkPages));
    // 따라간 링크가 없는 페이지였거나 찾는 내용이 없었으면, 다음 링크로 한 번만 더 메운다
    const missing = LIMITS.followUp.linkPages - goodLinks();
    if (missing > 0) await open(linked.slice(LIMITS.followUp.linkPages, LIMITS.followUp.linkPages + missing));
    followUp.linked = opened.length - before;
    if (left() > 0) await open(pickPages(fresh, left(), openedUrls, false));
    // 열지 못했거나 찾는 내용이 없던 자리는 다음 후보로 한 번 메운다
    if (left() > 0) await open(pickPages(fresh, left(), openedUrls, false));
    if (left() > 0) await open(pickPages(known.filter((c) => c.provisionalGrade <= 2), left(), openedUrls, false));
  }

  // 앞서 모은 출처와 발췌는 번호까지 그대로 두고, 새로 얻은 것을 뒤에 붙인다
  const sources: SourceInfo[] = previous.sources.map((s) => ({ ...s }));
  const evidence: Evidence[] = [...previous.evidence];
  let nextSource = Math.max(0, ...sources.map((s) => s.no)) + 1;
  let nextEvidence = Math.max(0, ...evidence.map((e) => e.no)) + 1;
  const placeSource = (c: Candidate, outcome: FetchOutcome, pageDate: string | null): number => {
    const old = sources.find((s) => s.url === c.url);
    if (old) {
      // 앞서 찾아 두고 열지 않았던 출처다. 번호는 그대로 두고 연 결과만 적는다
      old.fetch = outcome;
      old.pageDate = pageDate;
      return old.no;
    }
    const no = nextSource;
    nextSource += 1;
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
  const useful = good().sort((a, b) => a.candidate.provisionalGrade - b.candidate.provisionalGrade);
  const perPage = Math.min(4000, Math.floor(LIMITS.followUp.excerptChars / Math.max(1, useful.length)));
  let total = 0;
  for (const page of useful) {
    const sourceNo = placeSource(page.candidate, page.outcome, page.pageDate);
    for (const text of pickExcerpts(page.blocks, keywords, perPage).excerpts) {
      if (total + text.length > LIMITS.followUp.excerptChars) break;
      evidence.push({ no: nextEvidence, sourceNo, text });
      nextEvidence += 1;
      total += text.length;
      followUp.added += 1;
    }
  }
  for (const page of opened.filter((p) => p.outcome.status !== '성공')) placeSource(page.candidate, page.outcome, page.pageDate);
  let listed = 0;
  for (const c of orderCandidates(fresh)) {
    if (listed >= MAX_FOLLOW_UP_SOURCES) break;
    if (openedUrls.has(c.url)) continue;
    placeSource(c, { status: '열지 않음', reason: c.skip, chars: 0, truncated: false, fetchedAt: null }, null);
    listed += 1;
  }

  const bundle: EvidenceBundle = { ...previous, searches: [...previous.searches, ...searches], sources, evidence, followUp };
  return { bundle, usage };
}
