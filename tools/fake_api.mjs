// 확인용 도구가 함께 쓰는 흉내 낸 서버와 저장소. Liner도 서버도 부르지 않는다.
// 서버의 네 경로(추출, 근거 모으기, 판정, 수정안 합치기)를 정해 둔 규칙대로 답하는 함수로 바꿔 끼운다.

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const FAIL = (reason, extra = {}) => ({ ok: false, aborted: false, fatal: false, status: 502, reason, ...extra });
export const NO_FIX = { kind: '없음', instruction: '', sourceNo: null };

export function makeStore() {
  let state = null;
  return { get: () => state, set: (update) => (state = update(state)) };
}

/**
 * 흉내 낸 서버. claimsFor로 문장마다 낼 명제를, 나머지 옵션으로 판정과 수정안, 실패와 지연을 정한다.
 * calls에는 경로마다 받은 요청이 쌓인다.
 * @param reviseFor (문장, 고칠 내용) → { revised, edits, applied?, skipped? }. 주지 않으면 문장 끝에 '(고침)'을 붙인 수정안을 낸다
 * @param priorityFor (명제) → 편집 우선순위. 주지 않으면 첫 문단은 '상', 나머지는 '중'이다
 */
export function makeApi({ claimsFor, verdictFor = () => '일치', fixFor = () => NO_FIX, evidenceFor = () => 1, reviseFor = null, priorityFor = null, delay = 0, fail = {} }) {
  const calls = { extract: [], gather: [], judge: [], merge: [] };
  const usage = (stage, model = 'claude-sonnet-5.5') => ({ stage, model, promptTokens: 100, completionTokens: 10, searchCalls: 0, seconds: 0.1 });
  const wait = async (signal) => {
    if (delay) await sleep(delay);
    return signal.aborted;
  };
  /** fail[경로]는 (요청, 그 경로의 몇 번째 호출인지) → 실패 응답 또는 null */
  const failing = (route, request) => (fail[route] ? fail[route](request, calls[route].length) : null);
  return {
    calls,
    async extract(input, signal) {
      calls.extract.push(input);
      if (await wait(signal)) return FAIL('중단', { aborted: true });
      const failure = failing('extract', input);
      if (failure) return failure;
      const claims = [];
      for (const s of input.sentences) {
        (claimsFor(s.text) ?? []).forEach((c, i) => {
          claims.push({
            id: `s${s.id}-c${i + 1}`,
            sentenceId: s.id,
            statement: c.statement,
            type: c.type ?? '기타',
            qualifiers: c.qualifiers ?? [],
            asOf: '현재',
            isPublic: c.isPublic ?? true,
            privateReason: c.isPublic === false ? '공개 자료 없음' : '',
            queries: c.isPublic === false ? [] : ['검색어 1', '검색어 2'],
            counterQuery: '',
          });
        });
      }
      return { ok: true, claims, dropped: 0, usage: usage('추출') };
    },
    async gather(body, signal) {
      calls.gather.push(body);
      if (await wait(signal)) return FAIL('중단', { aborted: true });
      const failure = failing('gather', body);
      if (failure) return failure;
      const count = evidenceFor(body.statement);
      const bundle = {
        v: 1,
        claimKey: body.statement,
        gatheredAt: '2026-11-21T00:00:00.000Z',
        searches: body.queries.map((query) => ({ query, kind: '기본', dateRange: null, results: 3, error: null })),
        sources: [
          {
            no: 1,
            url: 'https://www.example.go.kr/a',
            title: '자료',
            hostname: 'www.example.go.kr',
            date: null,
            pageDate: null,
            summary: '',
            foundBy: ['기본'],
            provisionalGrade: 1,
            publisherHint: '어느 기관',
            lowPlatform: false,
            fetch: { status: '성공', reason: '', chars: 1000, truncated: false, fetchedAt: '2026-11-21T00:00:00.000Z' },
          },
        ],
        evidence: Array.from({ length: count }, (_, i) => ({ no: i + 1, sourceNo: 1, text: '발췌' })),
        extraSearch: { done: false, reason: '' },
        premium: [],
      };
      const searches = body.queries.map(() => ({ ...usage('근거 모으기', 'search/web'), promptTokens: 0, completionTokens: 0, searchCalls: 1 }));
      return { ok: true, bundle, signature: `sig:${body.statement}`, usage: searches };
    },
    async judge(body, signal) {
      calls.judge.push(body);
      if (await wait(signal)) return FAIL('중단', { aborted: true });
      const failure = failing('judge', body);
      if (failure) return failure;
      const verdict = verdictFor(body.claim.statement, body);
      const used = verdict === '일치' || verdict === '불일치';
      const judgment = {
        verdict,
        modelVerdict: verdict,
        lowered: null,
        reason: '사유',
        action: '',
        priority: verdict === '일치' ? null : priorityFor ? priorityFor(body.claim.statement) : body.lead ? '상' : '중',
        needChoice: false,
        flags: [],
        sources: used ? [{ sourceNo: 1, docType: '기관의 공식 안내', publisher: '어느 기관', ownFact: true, grade: 1, publisherUnlisted: false }] : [],
        links: [],
        evidence: used
          ? [{ evidenceNo: 1, sourceNo: 1, relation: verdict === '일치' ? '지지' : '반박', target: '적용 가능', scope: '적용 가능', time: '적용 가능', quote: '발췌', quoteFound: true, usable: true }]
          : [],
        qualifiers: [],
        conflict: { found: false, resolved: false, supportTop: null, refuteTop: null },
        fix: fixFor(body.claim.statement),
        checkedAt: '2026-11-21',
        sentenceKey: body.sentence,
      };
      return { ok: true, judgment, usage: [usage('판정')] };
    },
    async merge(body, signal) {
      calls.merge.push(body);
      if (await wait(signal)) return FAIL('중단', { aborted: true });
      const failure = failing('merge', body);
      if (failure) return failure;
      const ids = body.fixes.map((f) => f.claimId);
      const custom = reviseFor ? reviseFor(body.sentence, body.fixes) : null;
      const revision = {
        revised: custom ? custom.revised : `${body.sentence} (고침)`,
        edits: custom ? custom.edits : [{ before: 'x', after: 'y', claimIds: ids }],
        applied: custom?.applied ?? ids,
        skipped: custom?.skipped ?? [],
        kinds: body.fixes.map((f) => f.kind),
        changes: { numbersRemoved: [], numbersAdded: [], wordsRemoved: [], wordsAdded: [] },
        cautions: [],
        markupKept: true,
        polish: { state: '고칠 곳 없음', problem: '', draft: null },
        sentenceKey: body.sentence,
      };
      return { ok: true, revision, usage: [usage('수정안 합치기'), usage('수정안 다듬기')] };
    },
  };
}
