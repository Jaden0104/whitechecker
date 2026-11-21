// 화면이 맡는 진행(lib/run)이 기대대로 동작하는지 확인한다. Liner도 서버도 부르지 않는다.
// 서버의 네 경로를 흉내 낸 함수로 바꿔 끼워, 요청이 몇 번 나가는지와 상태가 어떻게 바뀌는지를 본다.
// 사용: node tools/check_run.mjs
import { diffPieces, editRanges, inlineRuns, quoteContext, sharedEnds } from '../lib/client/text.ts';
import {
  candidateText,
  compareByRank,
  countClaims,
  entryOf,
  factNote,
  hasUnfinished,
  isAdopted,
  isResolved,
  recheckStatus,
  recover,
  reviewOf,
  sentenceRows,
  summarizeUsage,
  viewOf,
} from '../lib/run/model.ts';
import { buildExtractChunks } from '../lib/chunks.ts';
import { extractUserMessage } from '../lib/prompts/extract.ts';
import { splitManuscript } from '../lib/sentences.ts';
import { createRechecker } from '../lib/run/recheck.ts';
import { applyReview } from '../lib/run/review.ts';
import { createRunner } from '../lib/run/runner.ts';
import { FAIL, NO_FIX, makeApi, makeStore, sleep } from './fake_api.mjs';

let failed = 0;
function expect(label, actual, wanted) {
  const a = typeof actual === 'string' ? actual : JSON.stringify(actual);
  const w = typeof wanted === 'string' ? wanted : JSON.stringify(wanted);
  const ok = a === w;
  if (!ok) failed += 1;
  console.log(`${ok ? '통과' : '실패'}  ${label}${ok ? '' : `\n      기대 ${w}\n      실제 ${a}`}`);
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
  expect('나눈 앞쪽 반에는 뒤쪽 반의 글을 뒤 문맥으로 붙인다', [cut.calls.extract[1].after, 'after' in cut.calls.extract[2]], ['다 문장입니다. 라 문장입니다.', false]);

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

// ---------- 처음 검증의 뒤 문맥 ----------
console.log('\n[처음 검증의 뒤 문맥]');
{
  const text = '# 제목\n\n가 문단의 첫 문장입니다. 가 문단의 둘째 문장입니다.\n\n나 문단의 문장입니다.\n\n## 소제목\n\n다 문단의 문장입니다.\n';
  const sentences = splitManuscript(text);
  const shape = (chunks) => chunks.map((c) => [c.sentences.map((s) => s.id).join(','), c.after ?? null]);
  expect('묶음의 끝에 놓인 문장도 뒤 문장을 보게, 뒤에 이어지는 글을 붙인다(다음 소제목 앞까지)', shape(buildExtractChunks(sentences, 32)), [['1,2,3', '나 문단의 문장입니다.'], ['4,5,6', null]]);
  expect(
    '긴 문단이 한가운데서 끊겨도 끊긴 자리의 문장이 바로 뒤 문장을 본다',
    shape(buildExtractChunks(sentences, 16)).slice(1, 3),
    [['2', '가 문단의 둘째 문장입니다. 나 문단의 문장입니다.'], ['3', '나 문단의 문장입니다.']],
  );
  expect('원고가 묶음 하나면 뒤 문맥이 없다(보내는 글이 전과 같다)', shape(buildExtractChunks(sentences)), [['1,2,3,4,5,6', null]]);

  // 800자를 넘는 원고는 묶음이 여럿이다. 마지막 묶음만 뒤 문맥이 없다
  const paragraph = (name) => Array.from({ length: 12 }, (_, i) => `${name} 문단의 ${i + 1}번째 문장은 꽤 긴 문장입니다.`).join(' ');
  const long = `# 제목\n\n${paragraph('가')}\n\n${paragraph('나')}\n\n${paragraph('다')}\n`;
  const api = makeApi({ claimsFor: () => [] });
  const store = makeStore();
  const runner = createRunner(store, api);
  runner.start(long);
  await runner.idle();
  const calls = [...api.calls.extract].sort((a, b) => a.sentences[0].id - b.sentences[0].id);
  expect('묶음이 여럿이면 마지막 묶음만 빼고 뒤 문맥을 함께 보낸다', [calls.length, calls.slice(0, -1).every((c) => typeof c.after === 'string'), 'after' in calls[calls.length - 1]], [2, true, false]);
  expect('뒤 문맥은 다음 묶음의 앞부분이다(200자까지)', [calls[0].after.startsWith(calls[1].sentences[0].text), calls[0].after.length], [true, 200]);
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

  const pieces = diffPieces('돌의 크기는 세로 311cm, 가로 223cm입니다.', '돌의 크기는 세로 211cm, 가로 123cm입니다.');
  expect('고쳐 쓴 문장은 숫자와 낱말 단위로 견준다', [pieces.filter((p) => p.kind === 'removed').map((p) => p.text), pieces.filter((p) => p.kind === 'added').map((p) => p.text)], [['311', '223'], ['211', '123']]);
  const bold = diffPieces('서울의 **국립중앙박물관**에 있습니다.', '서울의 **국립고궁박물관**에 있습니다.');
  expect('굵은 글씨 표시는 감추고 견주며, 조각의 모양을 알려 준다', bold.filter((p) => p.kind !== 'same').map((p) => `${p.kind}:${p.text}${p.bold ? '[굵게]' : ''}`), ['removed:국립중앙박물관[굵게]', 'added:국립고궁박물관[굵게]']);
  expect('같은 글이면 달라진 조각이 없다', diffPieces('같은 글입니다.', '같은 글입니다.').every((p) => p.kind === 'same'), true);

  const ends = sharedEnds(['각석의 크기는 세로 311cm입니다.', '각석의 크기는 가로 223cm입니다.']);
  expect('같은 문장의 명제에서 겹치는 앞뒤 말을 찾는다(단위는 숫자에 붙여 둔다)', '각석의 크기는 세로 311cm입니다.'.slice(ends.head, '각석의 크기는 세로 311cm입니다.'.length - ends.tail), '세로 311cm');
  expect('명제가 하나면 겹치는 말을 찾지 않는다', sharedEnds(['명제 하나']), { head: 0, tail: 0 });
}

// ---------- 7. 문장 단위로 보기(판정표의 줄) ----------
// 문장 3에는 사실이 둘(세로는 불일치, 가로는 근거 부족), 문장 4에도 둘(국보는 일치, 박물관은 불일치)이다
const REVIEW_TEXT = '# 제목\n\n첫 문단입니다.\n\n크기는 세로 311cm, 가로 223cm입니다. 이 각석은 1985년에 국보가 됐고 지금은 박물관에 있습니다. 관람료는 무료입니다. 구독자는 3만 명입니다.\n';
function reviewApi(options = {}) {
  const size = (s) => {
    const tall = s.match(/세로 (\d+)cm/)?.[1];
    const wide = s.match(/가로 (\d+)cm/)?.[1];
    return [tall ? { statement: `각석의 크기는 세로 ${tall}cm입니다.`, type: '제원·실측' } : null, wide ? { statement: `각석의 크기는 가로 ${wide}cm입니다.`, type: '제원·실측' } : null].filter(Boolean);
  };
  return makeApi({
    claimsFor: (s) => {
      if (s.includes('세로') || s.includes('가로')) return size(s);
      if (s.includes('국보')) return [{ statement: '각석은 1985년에 국보가 됐습니다.', type: '분류·지정' }, { statement: '각석은 지금 박물관에 있습니다.' }];
      if (s.includes('관람료')) return [{ statement: '관람료는 무료입니다.', type: '운영 정보' }];
      if (s.includes('구독자')) return [{ statement: '구독자는 3만 명입니다.', type: '수치·통계', isPublic: false }];
      if (s.includes('첫 문단')) return [{ statement: '첫 문단의 명제' }];
      return [];
    },
    // 소장 기관이 밝힌 값은 세로 211cm, 가로 123cm다. 가로 223cm는 처음에 근거를 찾지 못한 것으로 친다
    verdictFor: (st) => {
      if (st.includes('세로')) return st.includes('211') ? '일치' : '불일치';
      if (st.includes('가로')) return st.includes('123') ? '일치' : st.includes('223') ? '근거 부족' : '불일치';
      if (st.includes('박물관에 있')) return '불일치';
      return '일치';
    },
    fixFor: (st) => (st.includes('세로 311') ? { kind: '교정안', instruction: '세로 311cm를 211cm로 고친다', sourceNo: null } : st.includes('박물관에 있') ? { kind: '교정안', instruction: '박물관을 고궁박물관으로 고친다', sourceNo: null } : NO_FIX),
    reviseFor: (sentence, fixes) => {
      if (sentence.includes('세로')) return { revised: sentence.replace('311cm', '211cm'), edits: [{ before: '311cm', after: '211cm', claimIds: [fixes[0].claimId] }] };
      return { revised: sentence.replace('박물관', '고궁박물관'), edits: [{ before: '박물관', after: '고궁박물관', claimIds: [fixes[0].claimId] }] };
    },
    ...options,
  });
}

console.log('\n[문장 단위로 보기]');
{
  const api = reviewApi();
  const store = makeStore();
  const runner = createRunner(store, api);
  runner.start(REVIEW_TEXT);
  await runner.idle();
  const run = store.get();
  const rows = sentenceRows(run);
  const row = (id) => rows.find((r) => r.sentence.id === id);
  expect("판정표의 한 줄은 문장 하나다('직접 확인'뿐인 문장은 올리지 않는다)", rows.map((r) => r.sentence.id), [2, 3, 4, 5]);
  expect('두 가지가 걸린 문장은 판정 표시가 둘이다', row(3).badges, [{ verdict: '불일치', count: 1 }, { verdict: '근거 부족', count: 1 }]);
  expect("손볼 판정과 '일치'가 섞이면 '일치'는 표시에서 빼고 수만 센다", [row(4).badges, row(4).okCount, row(4).allOk], [[{ verdict: '불일치', count: 1 }], 1, false]);
  expect("모두 맞은 문장에만 '일치' 표시가 붙는다", [row(5).badges, row(5).allOk], [[{ verdict: '일치', count: 1 }], true]);
  expect('줄을 누르면 그 문장에서 가장 급한 명제를 연다', [row(3).top.entry.claim.id, row(4).top.entry.claim.id], ['s3-c1', 's4-c2']);
  const order = [...rows].filter((r) => !r.allOk).sort((a, b) => compareByRank(a.top, b.top) || a.sentence.id - b.sentence.id);
  expect('줄의 자리는 가장 급한 명제를 따른다', order.map((r) => r.sentence.id), [3, 4]);
  expect('수정안은 세로만 고친다(가로는 근거 부족이라 그대로)', run.revisions[3].revision.revised, '크기는 세로 211cm, 가로 223cm입니다.');
  expect('사실마다 수정안에서 어떻게 됐는지 적는다', [factNote(run, row(3).views[0]).text, factNote(run, row(3).views[1]).text, factNote(run, row(4).views[0]).text], ['수정안에 반영했습니다', '확인하지 못해 그대로 뒀습니다', '고칠 것이 없습니다']);
}

// ---------- 8. 편집자의 선택(F10) ----------
console.log('\n[채택, 고쳐 쓰기, 보류]');
{
  const api = reviewApi();
  const store = makeStore();
  const runner = createRunner(store, api);
  runner.start(REVIEW_TEXT);
  await runner.idle();
  const act = (sentenceId, action) => {
    const outcome = applyReview(store.get(), sentenceId, action, '2026-11-21T10:00:00.000Z');
    store.set(() => outcome.run);
    return outcome.notice;
  };
  const viewAt = (id) => viewOf(store.get(), entryOf(store.get(), id));

  expect('고르기 전에는 채택이 아니다', [isAdopted(store.get(), 3), reviewOf(store.get(), 3).choice], [false, '']);
  act(3, { kind: 'adopt' });
  expect('수정안을 채택한다', [isAdopted(store.get(), 3), candidateText(store.get(), 3)], [true, '크기는 세로 211cm, 가로 223cm입니다.']);
  expect('채택한 수정안이 고친 명제만 풀린 것으로 본다', [isResolved(store.get(), viewAt('s3-c1')), isResolved(store.get(), viewAt('s3-c2'))], [true, false]);
  expect('수정안이 없는 문장은 채택할 수 없다고 알린다', [act(5, { kind: 'adopt' }) !== '', isAdopted(store.get(), 5)], [true, false]);
  act(4, { kind: 'hold' });
  expect('보류를 고르고 되돌릴 수 있다', [reviewOf(store.get(), 4).choice, (act(4, { kind: 'unhold' }), reviewOf(store.get(), 4).choice), store.get().reviews[4]], ['보류', '', undefined]);

  const notice = act(3, { kind: 'save', text: '크기는 세로 211cm,\n가로 123cm입니다.' });
  expect('고쳐 쓰면 그 글이 새 수정안이 된다(줄바꿈은 빈칸으로)', candidateText(store.get(), 3), '크기는 세로 211cm, 가로 123cm입니다.');
  expect('수정안이 바뀌면 앞서 한 채택을 풀고 알린다', [reviewOf(store.get(), 3).choice, notice.includes('채택을 풀었습니다')], ['', true]);
  expect('고쳐 쓴 문장은 다시 검증하기 전까지 미검증이다', recheckStatus(store.get(), store.get().sentences[2]), '미검증');
  expect('원문과 같게 고치면 고쳐 쓴 것으로 치지 않는다', [act(4, { kind: 'save', text: store.get().sentences[3].source }) !== '', reviewOf(store.get(), 4).edited], [true, null]);
  expect('자동 수정안과 같게 고치면 자동 수정안으로 돌아간다', (act(4, { kind: 'save', text: store.get().revisions[4].revision.revised }), reviewOf(store.get(), 4).edited), null);
  expect('빈 글은 저장하지 않는다', [act(4, { kind: 'save', text: '   ' }) !== '', reviewOf(store.get(), 4).edited], [true, null]);
  expect('수정안이 없는 문장도 고쳐 쓴 뒤에는 채택할 수 있다', (act(5, { kind: 'save', text: '관람료는 없습니다.' }), act(5, { kind: 'adopt' }), isAdopted(store.get(), 5)), true);

  // ---------- 9. 선택한 문장 다시 검증(F14) ----------
  console.log('\n[다시 검증]');
  const rechecker = createRechecker(store, api);
  const claimsBefore = store.get().claims.length;
  const usageBefore = store.get().usage.length;
  const extractBefore = api.calls.extract.length;
  await rechecker.start(3);
  let run = store.get();
  const sent = api.calls.extract[extractBefore];
  expect('고쳐 쓴 글 한 문장만 보내고, 제목과 앞 문맥을 함께 보낸다', [sent.sentences, sent.title, sent.context], [[{ id: 3, text: '크기는 세로 211cm, 가로 123cm입니다.' }], '제목', '첫 문단입니다.']);
  expect('뒤에 이어지는 문장도 뒤 문맥으로 함께 보낸다', sent.after, '이 각석은 1985년에 국보가 됐고 지금은 박물관에 있습니다. 관람료는 무료입니다. 구독자는 3만 명입니다.');
  expect('다시 뽑은 명제를 검증해 그 글에 묶어 둔다', [run.rechecks[3].state, run.rechecks[3].target, run.rechecks[3].text, run.rechecks[3].claims.map((e) => `${e.claim.id}:${viewOf(run, e).verdict}`)], ['완료', 'edited', '크기는 세로 211cm, 가로 123cm입니다.', ['r3-c1:일치', 'r3-c2:일치']]);
  expect('판정표(원문을 검증한 기록)는 바꾸지 않는다', [run.claims.length, viewAt('s3-c2').verdict], [claimsBefore, '근거 부족']);
  expect('재검증의 호출도 사용량에 더한다', run.usage.length > usageBefore, true);
  expect('지금 문장을 검증해 둔 상태가 된다', recheckStatus(run, run.sentences[2]), '현재 문장 검증 완료');
  act(3, { kind: 'adopt' });
  expect('고쳐 쓴 문장을 다시 검증해 모두 일치면 풀린 것으로 본다', [isResolved(store.get(), viewAt('s3-c1')), isResolved(store.get(), viewAt('s3-c2'))], [true, true]);
  act(3, { kind: 'save', text: '크기는 세로 211cm, 가로 124cm입니다.' });
  run = store.get();
  expect('그 뒤에 문장을 다시 고치면 앞선 결과는 이전 문장에 대한 결과가 된다', [recheckStatus(run, run.sentences[2]), isResolved(run, viewAt('s3-c2'))], ['이전 문장에 대한 결과', false]);
  act(3, { kind: 'revert' });
  expect('고쳐 쓴 글을 버리면 그 재검증 결과도 치운다', [store.get().rechecks[3], candidateText(store.get(), 3)], [undefined, '크기는 세로 211cm, 가로 223cm입니다.']);

  await rechecker.start(4);
  run = store.get();
  expect('고쳐 쓰지 않은 문장은 원문을 다시 검증한다', [run.rechecks[4].target, run.rechecks[4].claims.map((e) => viewOf(run, e).verdict), recheckStatus(run, run.sentences[3])], ['original', ['일치', '불일치'], '현재 문장 검증 완료']);

  await rechecker.start(6);
  expect('마지막 문장에는 뒤 문맥이 없다', ['after' in api.calls.extract.at(-1), api.calls.extract.at(-1).sentences[0].id], [false, 6]);

  // 뒤 문맥은 다음 소제목 앞에서 끊고, 길면 앞부분만 보낸다
  const long = `${'긴 문장입니다. '.repeat(40)}`.trim();
  const sectioned = makeApi({ claimsFor: () => [] });
  const store4 = makeStore();
  const runner4 = createRunner(store4, sectioned);
  runner4.start(`# 제목\n\n가 문장입니다. 나 문장입니다.\n\n## 다음 절\n\n다 문장입니다. ${long}\n`);
  await runner4.idle();
  const checker4 = createRechecker(store4, sectioned);
  await checker4.start(2);
  expect('뒤 문맥은 다음 소제목 앞에서 끊는다', sectioned.calls.extract.at(-1).after, '나 문장입니다.');
  await checker4.start(5);
  expect('뒤 문맥이 길면 앞부분 200자만 보낸다', [sectioned.calls.extract.at(-1).after.length, sectioned.calls.extract.at(-1).after.startsWith('긴 문장입니다. 긴 문장입니다.')], [200, true]);

  const plainInput = { title: '제목', context: '앞 글', sentences: [{ id: 3, text: '문장' }] };
  expect('뒤 문맥이 없으면 추출에 보내는 글은 전과 같다(처음 검증의 동작을 건드리지 않는다)', extractUserMessage(plainInput), '제목: 제목\n\n앞 문맥: 앞 글\n\n번호가 붙은 문장:\n[3] 문장');
  const withAfter = extractUserMessage({ ...plainInput, after: '뒤 글' });
  expect('뒤 문맥이 있으면 번호가 붙은 문장 뒤에 따로 적는다', [withAfter.startsWith(extractUserMessage(plainInput)), withAfter.endsWith('여기서는 명제를 뽑지 않습니다): 뒤 글')], [true, true]);

  const broken = reviewApi({ fail: { extract: () => FAIL('모델 응답 오류(응답 잘림)') } });
  const store2 = makeStore();
  store2.set(() => store.get());
  await createRechecker(store2, broken).start(5);
  expect('다시 뽑지 못하면 실패로 남기고 사유를 적는다', [store2.get().rechecks[5].state, store2.get().rechecks[5].failure], ['실패', '모델 응답 오류(응답 잘림)']);

  const slow = reviewApi({ delay: 30 });
  const store3 = makeStore();
  store3.set(() => ({ ...store.get(), rechecks: {} }));
  const again = createRechecker(store3, slow);
  const first = again.start(3);
  await sleep(10);
  const second = again.start(3);
  await Promise.all([first, second]);
  expect('같은 문장을 다시 요청하면 앞선 요청의 응답은 받지 않는다', [store3.get().rechecks[3].state, store3.get().rechecks[3].claims.length], ['완료', 2]);
  const third = again.start(3);
  await sleep(10);
  again.stopAll();
  await third;
  expect('멈추면 돌던 재검증은 중단으로 남는다', store3.get().rechecks[3].state, '중단');
  const fourth = again.start(4);
  await sleep(10);
  store3.set(() => null);
  await fourth;
  await sleep(60);
  expect('기록을 지우면 늦게 온 재검증 응답이 상태를 되살리지 않는다', store3.get(), null);
  const reopened = recover({ ...store.get(), rechecks: { 3: { token: 't', text: '글', target: 'edited', state: '진행 중', failure: '', claims: [], at: '' } } });
  expect("새로 고친 뒤에는 돌던 재검증을 '중단'으로 연다", reopened.rechecks[3].state, '중단');
}

console.log(failed ? `\n실패 ${failed}건` : '\n모두 통과');
process.exit(failed ? 1 : 0);
