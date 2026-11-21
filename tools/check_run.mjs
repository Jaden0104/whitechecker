// 화면이 맡는 진행(lib/run)이 기대대로 동작하는지 확인한다. Liner도 서버도 부르지 않는다.
// 서버의 네 경로를 흉내 낸 함수로 바꿔 끼워, 요청이 몇 번 나가는지와 상태가 어떻게 바뀌는지를 본다.
// 사용: node tools/check_run.mjs
import { editRanges, inlineRuns, quoteContext } from '../lib/client/text.ts';
import { countClaims, entryOf, hasUnfinished, recover, summarizeUsage, viewOf } from '../lib/run/model.ts';
import { createRunner } from '../lib/run/runner.ts';

let failed = 0;
function expect(label, actual, wanted) {
  const a = typeof actual === 'string' ? actual : JSON.stringify(actual);
  const w = typeof wanted === 'string' ? wanted : JSON.stringify(wanted);
  const ok = a === w;
  if (!ok) failed += 1;
  console.log(`${ok ? '통과' : '실패'}  ${label}${ok ? '' : `\n      기대 ${w}\n      실제 ${a}`}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const FAIL = (reason, extra = {}) => ({ ok: false, aborted: false, fatal: false, status: 502, reason, ...extra });

function makeStore() {
  let state = null;
  return { get: () => state, set: (update) => (state = update(state)) };
}

/**
 * 흉내 낸 서버. rules로 문장마다 낼 명제를, 나머지 옵션으로 실패와 지연을 정한다.
 * calls에는 경로마다 받은 요청이 쌓인다.
 */
function makeApi({ claimsFor, verdictFor = () => '일치', fixFor = () => ({ kind: '없음', instruction: '', sourceNo: null }), evidenceFor = () => 1, delay = 0, fail = {} }) {
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
        sources: [],
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
      const judgment = {
        verdict,
        modelVerdict: verdict,
        lowered: null,
        reason: '사유',
        action: '',
        priority: verdict === '일치' ? null : body.lead ? '상' : '중',
        needChoice: false,
        flags: [],
        sources: [],
        links: [],
        evidence: [],
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
      const revision = {
        revised: `${body.sentence} (고침)`,
        edits: [{ before: 'x', after: 'y', claimIds: ids }],
        applied: ids,
        skipped: [],
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

const view = (store, id) => viewOf(store.get(), entryOf(store.get(), id));
const FIX = { kind: '교정안', instruction: '고친다', sourceNo: null };

// ---------- 1. 같은 명제는 한 번만 ----------
console.log('[같은 명제 묶기]');
{
  // 문장 4와 6은 글자까지 같은 문장이다. 문장 5는 다른 문장이지만 같은 명제가 나온다
  const text = '# 제목\n\n첫 문단입니다.\n\n각석은 가장 오래된 천문도입니다.\n\n각석은 국보이며 가장 오래됐다고 합니다.\n\n각석은 가장 오래된 천문도입니다.\n';
  const same = { statement: '각석은 가장 오래된 천문도이다', type: '최상급' };
  const api = makeApi({
    claimsFor: (s) => (s.includes('가장 오래') ? [same] : s.includes('첫 문단') ? [{ statement: '첫 문단의 명제' }] : []),
    verdictFor: (st) => (st === same.statement ? '불일치' : '일치'),
    fixFor: (st) => (st === same.statement ? FIX : { kind: '없음', instruction: '', sourceNo: null }),
  });
  const store = makeStore();
  const runner = createRunner(store, api);
  expect('실행을 시작한다', runner.start(text).ok, true);
  await runner.idle();
  const run = store.get();
  expect('끝나면 상태는 끝남', run.status, '끝남');
  expect('명제는 넷', run.claims.map((e) => e.claim.id), ['s2-c1', 's3-c1', 's4-c1', 's5-c1']);
  expect('근거는 명제 내용마다 한 번만 모은다(2회)', api.calls.gather.length, 2);
  expect('판정은 문장이 다르면 따로 한다(같은 문장 둘은 한 번, 합쳐 3회)', api.calls.judge.length, 3);
  expect('문장까지 같은 명제는 앞 항목의 판정을 함께 쓴다', [run.claims[3].judgeFrom, view(store, 's5-c1').verdict, view(store, 's5-c1').sharedWith], ['s3-c1', '불일치', 's3-c1']);
  expect('문장이 다른 같은 명제는 근거만 함께 쓴다', [run.claims[2].bundleFrom, run.claims[2].judgeFrom, view(store, 's4-c1').bundle !== null], ['s3-c1', null, true]);
  expect('같은 문장의 수정안은 한 번만 만든다(문장 3·5가 한 번, 문장 4가 한 번)', api.calls.merge.length, 2);
  expect('함께 쓰는 수정안은 명제 번호를 그 문장의 것으로 바꾼다', [run.revisions[3].revision.applied, run.revisions[5].revision.applied], [['s3-c1'], ['s5-c1']]);
  expect('고칠 내용이 없는 문장은 수정안을 만들지 않는다', run.revisions[2].state, '없음');
  expect('제목과 첫 문단의 명제는 lead로 보낸다', api.calls.judge.map((j) => j.lead), [true, false, false]);
  const summary = summarizeUsage(run.usage);
  expect('호출 요약: 검색 4회, 모델 8회(추출 1, 판정 3, 합치기와 다듬기 4)', [summary.searches, summary.modelCalls], [4, 8]);
  expect('남은 것이 없다', hasUnfinished(run), false);
  expect('명제는 끝났는데 수정안을 만들기 전에 멈췄으면 남은 것으로 본다', hasUnfinished({ ...run, revisions: {} }), true);
  expect('호출 요약은 처리 순서대로 보인다', summary.byStage.map((r) => r.stage), ['추출', '근거 모으기', '판정', '수정안 합치기', '수정안 다듬기']);
}

// ---------- 2. 직접 확인(F9) ----------
console.log('\n[직접 확인]');
{
  const text = '# 제목\n\n구독자는 3만 명입니다. 이 건물은 등록문화유산입니다. 이 탑은 보물입니다. 저 탑도 보물입니다.\n';
  const api = makeApi({
    claimsFor: (s) => {
      if (s.includes('구독자')) return [{ statement: '구독자는 3만 명이다', type: '수치·통계', isPublic: false }];
      if (s.includes('건물')) return [{ statement: '이 건물은 등록문화유산이다', type: '분류·지정', isPublic: false }];
      if (s.includes('이 탑')) return [{ statement: '이 탑은 보물이다', type: '분류·지정', isPublic: false }];
      if (s.includes('저 탑')) return [{ statement: '저 탑은 보물이다', type: '분류·지정', isPublic: false }];
      return [];
    },
    evidenceFor: (st) => (st.includes('건물') ? 0 : 2),
    verdictFor: (st) => (st.includes('이 탑') ? '불일치' : '근거 부족'),
  });
  const store = makeStore();
  const runner = createRunner(store, api);
  runner.start(text);
  await runner.idle();
  expect('내부 수치는 검색 없이 확정한다', [view(store, 's2-c1').verdict, view(store, 's2-c1').state], ['직접 확인', '완료']);
  expect('유형이 내부 수치·비공개 취재가 아니면 한 번 찾아본다(3회)', api.calls.gather.length, 3);
  expect('찾아볼 때는 명제를 검색어로 쓴다', api.calls.gather[0].queries, ['이 건물은 등록문화유산이다']);
  expect('자료가 없으면 판정하지 않고 직접 확인으로 확정한다', [view(store, 's3-c1').verdict, view(store, 's3-c1').direct.reclassified, api.calls.judge.length], ['직접 확인', false, 2]);
  expect('자료가 있어 판정이 나오면 그 판정을 쓴다', [view(store, 's4-c1').verdict, view(store, 's4-c1').direct.reclassified], ['불일치', true]);
  expect('판정이 근거 부족이면 직접 확인으로 둔다', [view(store, 's5-c1').verdict, view(store, 's5-c1').judgment], ['직접 확인', null]);
  expect('모두 끝난 것으로 센다', countClaims(store.get()).done, 4);
}

// ---------- 3. 실패한 단계만 다시 ----------
console.log('\n[실패와 다시 실행]');
{
  const text = '# 제목\n\n가 문장입니다. 나 문장입니다. 다 문장입니다.\n';
  const api = makeApi({
    claimsFor: (s) => (s.includes('문장') ? [{ statement: `${s[0]} 명제` }] : []),
    fixFor: () => FIX,
    fail: {
      // '가'는 근거 모으기가 처음에 실패하고, '나'는 판정이 처음에 실패한다
      gather: (body, nth) => (body.statement.startsWith('가') && nth <= 3 ? FAIL('검색 오류(호출 한도)') : null),
      judge: (body, nth) => (body.claim.statement.startsWith('나') && nth <= 2 ? FAIL('모델 응답 오류(응답 잘림)') : null),
    },
  });
  const store = makeStore();
  const runner = createRunner(store, api);
  runner.start(text);
  await runner.idle();
  expect('실패한 항목은 실패로 남고 사유가 붙는다', [view(store, 's2-c1').state, view(store, 's2-c1').failure, view(store, 's3-c1').state, view(store, 's3-c1').failure], ['실패', '검색 오류(호출 한도)', '실패', '모델 응답 오류(응답 잘림)']);
  expect('실패를 근거 부족으로 보이지 않는다', view(store, 's2-c1').verdict, null);
  expect('성공한 항목은 완료', [view(store, 's4-c1').state, store.get().revisions[4].state], ['완료', '완료']);
  expect('판정이 실패해도 모은 근거는 남는다', entryOf(store.get(), 's3-c1').bundle !== null, true);
  expect('남은 것이 있다', hasUnfinished(store.get()), true);
  const before = { gather: api.calls.gather.length, judge: api.calls.judge.length };
  runner.resume();
  await runner.idle();
  expect('다시 실행하면 실패한 단계만 한다(근거 1회, 판정 2회)', [api.calls.gather.length - before.gather, api.calls.judge.length - before.judge], [1, 2]);
  expect('다시 실행한 뒤에는 모두 완료', [countClaims(store.get()).done, hasUnfinished(store.get()), store.get().status], [3, false, '끝남']);
}

// ---------- 4. 중단, 늦게 온 응답, 기록 삭제 ----------
console.log('\n[중단과 기록 삭제]');
{
  const text = `# 제목\n\n${Array.from({ length: 12 }, (_, i) => `${i + 1}번 문장입니다.`).join(' ')}\n`;
  const api = makeApi({ claimsFor: (s) => (s.includes('번 문장') ? [{ statement: `${s} 명제` }] : []), delay: 30 });
  const store = makeStore();
  const runner = createRunner(store, api, { concurrency: 3 });
  runner.start(text);
  await sleep(110);
  runner.stop();
  await runner.idle();
  let counts = countClaims(store.get());
  expect('멈추면 상태는 중단', store.get().status, '중단');
  expect('돌던 것은 중단, 시작하지 않은 것은 대기로 남는다', [counts.running, counts.stopped > 0, counts.waiting > 0, counts.done < 12], [0, true, true, true]);
  expect('돌아간 시간을 적는다', store.get().activeMs > 0 && store.get().passStartedAt === null, true);
  const reloaded = recover({ ...store.get(), status: '검증 중' });
  expect("새로 고친 뒤에는 돌던 실행을 '중단'으로 연다", reloaded.status, '중단');
  runner.resume();
  await runner.idle();
  counts = countClaims(store.get());
  expect('이어서 실행하면 모두 끝난다', [counts.done, store.get().status], [12, '끝남']);

  const store2 = makeStore();
  const api2 = makeApi({ claimsFor: (s) => (s.includes('번 문장') ? [{ statement: `${s} 명제` }] : []), delay: 30 });
  const runner2 = createRunner(store2, api2);
  runner2.start(text);
  await sleep(70);
  runner2.clear();
  await runner2.idle();
  await sleep(60);
  expect('기록을 지우면 늦게 온 응답이 상태를 되살리지 않는다', store2.get(), null);
}

// ---------- 5. 접속 코드 문제, 추출 나누기, 처리 수 한도 ----------
console.log('\n[막힘, 추출 나누기, 한도]');
{
  const text = '# 제목\n\n가 문장입니다. 나 문장입니다. 다 문장입니다. 라 문장입니다.\n';
  const claimsFor = (s) => (s.includes('문장') ? [{ statement: `${s[0]} 명제` }] : []);

  const denied = makeApi({ claimsFor, fail: { extract: () => FAIL('접속 코드가 맞지 않습니다.', { fatal: true, status: 401 }) } });
  const store = makeStore();
  const runner = createRunner(store, denied);
  runner.start(text);
  await runner.idle();
  expect('접속 코드가 틀리면 실행을 멈추고 사유를 남긴다', [store.get().blocked, store.get().status, denied.calls.gather.length], ['접속 코드가 맞지 않습니다.', '중단', 0]);

  const cut = makeApi({ claimsFor, fail: { extract: (input, nth) => (nth === 1 ? FAIL('응답 잘림') : null) } });
  const store2 = makeStore();
  const runner2 = createRunner(store2, cut);
  runner2.start(text);
  await runner2.idle();
  expect('추출 응답이 잘리면 반으로 나눠 다시 보낸다(3회)', [cut.calls.extract.length, store2.get().chunks.length, store2.get().chunks.every((c) => c.state === '완료')], [3, 2, true]);
  expect('나눠 보내도 명제는 빠지지 않는다', store2.get().claims.length, 4);

  const limited = makeApi({ claimsFor });
  const store3 = makeStore();
  const runner3 = createRunner(store3, limited, { claimsPerRun: 3 });
  runner3.start(text);
  await runner3.idle();
  expect('한 번에 처리하는 수를 넘으면 나머지는 대기로 남긴다', [countClaims(store3.get()).done, countClaims(store3.get()).waiting, store3.get().deferred], [3, 1, 1]);
  runner3.resume();
  await runner3.idle();
  expect('이어서 실행하면 나머지를 처리한다', [countClaims(store3.get()).done, store3.get().deferred], [4, 0]);
}

// ---------- 6. 화면에 글을 보이는 계산 ----------
console.log('\n[글 표시]');
{
  const source = '지금은 서울의 **국립중앙박물관**에 있습니다.';
  const revised = '지금은 서울의 **국립고궁박물관**에 있습니다.';
  const ranges = editRanges(source, revised, [{ before: '국립중앙박물관', after: '국립고궁박물관' }]);
  const shown = inlineRuns(source, ranges.removed);
  expect('굵은 글씨 표시는 감추고, 그 안의 고친 대목을 표시한다', shown.map((r) => `${r.text}${r.bold ? '[굵게]' : ''}${r.mark ? '[표시]' : ''}`), ['지금은 서울의 ', '국립중앙박물관[굵게][표시]', '에 있습니다.']);
  expect('수정안에서도 같은 자리를 찾는다', inlineRuns(revised, ranges.added).find((r) => r.mark)?.text, '국립고궁박물관');

  const size = '돌의 크기는 세로 311cm, 가로 223cm입니다.';
  const sized = '돌의 크기는 세로 211cm, 가로 123cm입니다.';
  const two = editRanges(size, sized, [{ before: '223cm', after: '123cm' }, { before: '311cm', after: '211cm' }]);
  expect('고친 곳이 둘이면 둘 다 제자리에 표시한다', [two.removed.map(([a, b]) => size.slice(a, b)), two.added.map(([a, b]) => sized.slice(a, b))], [['311cm', '223cm'], ['211cm', '123cm']]);

  const link = inlineRuns('각석은 [국립고궁박물관](https://www.gogung.go.kr/)이 소장하고 있습니다.');
  expect('링크는 글만 보이고 주소는 감춘다', link.map((r) => `${r.text}${r.link ? '[링크]' : ''}`), ['각석은 ', '국립고궁박물관[링크]', '이 소장하고 있습니다.']);

  const removal = editRanges('세계에서 가장 오래된 천문도입니다.', '천문도입니다.', [{ before: '세계에서 가장 오래된 ', after: '' }]);
  expect('빼기만 한 수정은 수정안에 표시할 곳이 없다', [removal.removed.length, removal.added.length], [1, 0]);

  const excerpt = '앞 문장이다. 세로: 211cm,  가로: 123cm 로 적혀 있다. 뒤 문장이다.';
  const exact = quoteContext(excerpt, '세로: 211cm', 5);
  expect('인용문의 앞뒤 문맥을 잘라 낸다', [exact.before, exact.quote, exact.after, exact.found], ['…장이다. ', '세로: 211cm', ', 가로…', true]);
  const loose = quoteContext(excerpt, '세로: 211cm, 가로: 123cm', 3);
  expect('띄어쓰기만 다른 인용문도 찾는다', [loose.found, loose.quote], [true, '세로: 211cm,  가로: 123cm']);
  expect('없는 인용문은 못 찾았다고 알린다', quoteContext(excerpt, '없는 글').found, false);
}

console.log(failed ? `\n실패 ${failed}건` : '\n모두 통과');
process.exit(failed ? 1 : 0);
