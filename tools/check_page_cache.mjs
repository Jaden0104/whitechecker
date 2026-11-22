// 페이지 읽기(같은 페이지는 한 번만 열기, 응답 없는 사이트 건너뛰기)가 기대대로 동작하는지 확인한다.
// 외부 사이트를 열지 않는다. 주소를 여는 함수와 시계를 흉내 낸 것으로 바꿔 끼운다.
// 사용: node tools/check_page_cache.mjs
import { RECENT_FAILURE, SKIPPED_REASON, createPageReader, isPassingSkip, pageKey, unopenableReason } from '../lib/gather/page-cache.ts';
import { mergeResults } from '../lib/gather/rank.ts';

let failed = 0;
function expect(label, actual, wanted) {
  const a = typeof actual === 'string' ? actual : JSON.stringify(actual);
  const w = typeof wanted === 'string' ? wanted : JSON.stringify(wanted);
  const ok = a === w;
  if (!ok) failed += 1;
  console.log(`${ok ? '통과' : '실패'}  ${label}${ok ? '' : `\n      기대 ${w}\n      실제 ${a}`}`);
}

const html = (text, links = '') => Buffer.from(`<!doctype html><html><head><title>시험</title></head><body><nav>${links}</nav><main><p>${text}</p></main></body></html>`, 'utf8');
const okResult = (url, text = '본문입니다. 금속활자로 찍은 책에 대한 설명이 이어집니다.', links = '') => ({
  ok: true,
  url,
  status: 200,
  contentType: 'text/html; charset=utf-8',
  body: html(text, links),
  truncated: false,
  seconds: 0,
});
const failResult = (url, reason) => ({ ok: false, url, status: null, reason, detail: '', seconds: 0 });
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};

/** 흉내 낸 환경. answer(주소)가 돌려준 것(결과나 약속)을 그 주소의 응답으로 쓴다. calls에는 실제로 연 주소가 쌓인다 */
function setup(answer, limits = {}) {
  const calls = [];
  const clock = { t: 1_000_000 };
  const reader = createPageReader({
    get: async (address) => {
      calls.push(address);
      return answer(address);
    },
    now: () => clock.t,
    limits: { okMs: 1000, failMs: 100, entries: 50, chars: 1_000_000, links: 5, hostSkipAfter: 3, hostSkipMs: 500, ...limits },
    timeoutMs: 20_000,
    maxBytes: 1_000_000,
  });
  return { reader, calls, clock };
}

console.log('[같은 페이지는 한 번만]');
{
  const { reader, calls, clock } = setup((url) => okResult(url));
  const a = await reader.read('https://a.example.go.kr/page', 1000);
  clock.t += 300;
  const b = await reader.read('https://a.example.go.kr/page', 1000);
  expect('같은 주소를 두 번 찾으면 한 번만 연다', calls.length, 1);
  expect('다시 쓴 결과의 연 시각은 처음 연 시각 그대로다', b.fetchedAt, a.fetchedAt);
  expect('본문 글을 뽑아 돌려준다', a.ok && a.page.blocks.join(' ').includes('금속활자'), true);
  await reader.read('https://a.example.go.kr/other', 1000);
  expect('다른 주소는 따로 연다', calls.length, 2);
  clock.t += 800;
  await reader.read('https://a.example.go.kr/page', 1000);
  expect('두는 시간이 지나면 다시 연다', calls.length, 3);
  expect('집계: 연 것 3, 다시 쓴 것 1', [reader.stats().opened, reader.stats().reused], [3, 1]);
}
{
  const gate = deferred();
  const { reader, calls } = setup(async (url) => {
    await gate.promise;
    return okResult(url);
  });
  const first = reader.read('https://a.example.go.kr/page', 1000);
  const second = reader.read('https://a.example.go.kr/page', 1000);
  gate.resolve();
  const [a, b] = await Promise.all([first, second]);
  expect('열고 있는 주소를 또 찾으면 새로 열지 않고 함께 기다린다', [calls.length, a === b, reader.stats().joined], [1, true, 1]);
}
{
  expect('주소의 세션 표시(;jsessionid=…)는 떼고 견준다', pageKey('https://a.example.go.kr/bbs/view.do;jsessionid=ABC123?id=7'), 'https://a.example.go.kr/bbs/view.do?id=7');
  expect('# 뒤는 떼고 견준다', pageKey('https://a.example.go.kr/page?id=7#top'), 'https://a.example.go.kr/page?id=7');
  expect('주소로 읽을 수 없으면 그대로 둔다', pageKey('주소 아님'), '주소 아님');
  const { reader, calls } = setup((url) => okResult(url));
  await reader.read('https://a.example.go.kr/bbs/view.do;jsessionid=ABC123?id=7', 1000);
  await reader.read('https://a.example.go.kr/bbs/view.do;jsessionid=XYZ999?id=7', 1000);
  await reader.read('https://a.example.go.kr/bbs/view.do?id=7#top', 1000);
  expect('세션 표시나 # 뒤만 다른 주소는 같은 페이지로 보고 한 번만 연다', calls.length, 1);
  await reader.read('https://a.example.go.kr/bbs/view.do?id=8', 1000);
  expect('질의가 다르면 다른 페이지다', calls.length, 2);
}
{
  const { reader } = setup((url) => ({ ...okResult(url, '본문입니다.', '<a href="history.do">연혁</a><a href="/guide/visit.do">관람 안내</a>'), url: 'https://moved.example.go.kr/museum/index.do' }));
  const got = await reader.read('https://a.example.go.kr/museum', 1000);
  expect('링크는 옮겨 간 마지막 주소를 기준으로 푼다', got.ok && got.links.map((l) => l.url), ['https://moved.example.go.kr/museum/history.do', 'https://moved.example.go.kr/guide/visit.do']);
  expect('마지막 주소를 함께 돌려준다', got.ok && got.url, 'https://moved.example.go.kr/museum/index.do');
  let frozen = false;
  try {
    got.page.blocks.push('덧붙임');
  } catch {
    frozen = true;
  }
  expect('여러 명제가 함께 쓰는 결과는 고칠 수 없다', frozen, true);
}

console.log('[실패를 기억하는 시간]');
{
  const { reader, calls, clock } = setup((url) => failResult(url, url.includes('gone') ? '페이지 없음' : '연결 실패'));
  const a = await reader.read('https://b.example.go.kr/slow', 1000);
  await reader.read('https://b.example.go.kr/slow', 1000);
  expect('실패한 주소도 잠깐은 다시 열지 않는다', [a.ok, a.reason, calls.length], [false, '연결 실패', 1]);
  clock.t += 150;
  await reader.read('https://b.example.go.kr/slow', 1000);
  expect('연결 실패처럼 잠깐의 문제일 수 있는 실패는 짧게만 기억한다', calls.length, 2);
  await reader.read('https://b.example.go.kr/gone', 1000);
  clock.t += 150;
  await reader.read('https://b.example.go.kr/gone', 1000);
  expect('없는 페이지는 연 페이지만큼 오래 기억한다', calls.length, 3);
  clock.t += 900;
  await reader.read('https://b.example.go.kr/gone', 1000);
  expect('그 시간이 지나면 다시 연다', calls.length, 4);
}

console.log('[응답 없는 사이트 건너뛰기]');
{
  const { reader, calls, clock } = setup((url) => (url.includes('dead.example') ? failResult(url, '시간 초과') : okResult(url)));
  for (const n of [1, 2, 3]) await reader.read(`https://dead.example.go.kr/p${n}`, 1000);
  const skipped = await reader.read('https://dead.example.go.kr/p4', 1000);
  expect('연달아 세 번 시간 초과가 나면 그 사이트의 다른 주소는 열지 않고 바로 돌려준다', [calls.length, skipped.ok, skipped.reason], [3, false, SKIPPED_REASON]);
  const other = await reader.read('https://alive.example.go.kr/p1', 1000);
  expect('다른 사이트는 그대로 연다', [other.ok, calls.length], [true, 4]);
  expect('집계에 건너뛴 수가 남는다', reader.stats().skipped, 1);

  // 건너뛰는 시간이 지나면 요청 하나만 내보내 살아났는지 본다
  clock.t += 600;
  const probe = reader.read('https://dead.example.go.kr/p5', 1000);
  const meanwhile = await reader.read('https://dead.example.go.kr/p6', 1000);
  await probe;
  expect('건너뛰는 시간이 지나면 요청 하나만 내보내고, 그 답을 기다리는 동안 다른 주소는 건너뛴다', [calls.length, meanwhile.reason], [5, SKIPPED_REASON]);
  const again = await reader.read('https://dead.example.go.kr/p7', 1000);
  expect('그 요청도 시간 초과면 다시 건너뛴다', [calls.length, again.reason], [5, SKIPPED_REASON]);
}
{
  let alive = false;
  const { reader, calls, clock } = setup((url) => (alive ? okResult(url) : failResult(url, '시간 초과')));
  for (const n of [1, 2, 3]) await reader.read(`https://back.example.go.kr/p${n}`, 1000);
  clock.t += 600;
  alive = true;
  const probe = await reader.read('https://back.example.go.kr/p4', 1000);
  const next = await reader.read('https://back.example.go.kr/p5', 1000);
  expect('시험 삼아 보낸 요청에 응답이 오면 그 사이트를 다시 연다', [probe.ok, next.ok, calls.length], [true, true, 5]);
}
{
  const answers = ['시간 초과', '시간 초과', '페이지 없음', '시간 초과', '시간 초과', '접근 제한'];
  const { reader, calls } = setup((url) => failResult(url, answers[Number(url.slice(-1)) - 1]));
  for (const n of [1, 2, 3, 4, 5]) await reader.read(`https://mixed.example.go.kr/p${n}`, 1000);
  // 시간 초과가 모두 네 번이지만 연달아서는 두 번씩이다. 여섯 번째 주소를 건너뛰지 않고 실제로 열어야 한다
  const sixth = await reader.read('https://mixed.example.go.kr/p6', 1000);
  expect('사이에 응답이 한 번 오면(없는 페이지라는 답이라도) 연달아 센 수를 지운다', [calls.length, sixth.reason], [6, '접근 제한']);
}
{
  // 접속하자마자 끊는 사이트도 응답하지 않는 사이트다. 시간 초과만 세면 이런 사이트의 다른 주소를 계속 고르게 된다
  const { reader, calls } = setup((url) => failResult(url, '연결 실패'));
  const got = [];
  for (const n of [1, 2, 3, 4, 5]) got.push(await reader.read(`https://reset.example.go.kr/p${n}`, 1000));
  expect('연결 실패도 연달아 세 번이면 그 사이트를 건너뛴다', [calls.length, got[2].reason, got[3].reason, got[4].reason], [3, '연결 실패', SKIPPED_REASON, SKIPPED_REASON]);
}
{
  const answers = ['시간 초과', '연결 실패', '시간 초과'];
  const { reader, calls } = setup((url) => failResult(url, answers[Number(url.slice(-1)) - 1] ?? '시간 초과'));
  for (const n of [1, 2, 3]) await reader.read(`https://mixed2.example.go.kr/p${n}`, 1000);
  const fourth = await reader.read('https://mixed2.example.go.kr/p4', 1000);
  expect('시간 초과와 연결 실패는 함께 센다', [calls.length, fourth.reason], [3, SKIPPED_REASON]);
}
{
  let fail = true;
  const { reader, calls } = setup((url) => (fail ? failResult(url, '연결 실패') : okResult(url)));
  for (const n of [1, 2]) await reader.read(`https://flaky.example.go.kr/p${n}`, 1000);
  fail = false;
  await reader.read('https://flaky.example.go.kr/p3', 1000);
  fail = true;
  for (const n of [4, 5]) await reader.read(`https://flaky.example.go.kr/p${n}`, 1000);
  const sixth = await reader.read('https://flaky.example.go.kr/p6', 1000);
  expect('가끔 열리는 사이트는 한 번 열리면 세던 수를 지운다(연결 실패가 모두 네 번이어도 건너뛰지 않는다)', [calls.length, sixth.reason], [6, '연결 실패']);
}

console.log('[부른 쪽이 기다릴 수 있는 시간]');
{
  const gate = deferred();
  const { reader, calls } = setup(async (url) => {
    await gate.promise;
    return okResult(url);
  });
  const early = await reader.read('https://slow.example.go.kr/page', 20);
  expect('부른 쪽의 시간이 먼저 끝나면 부른 쪽에는 시간 초과를 돌려준다', [early.ok, early.reason], [false, '시간 초과']);
  // 같은 사이트의 다른 주소 둘도 부른 쪽이 먼저 떠난다(모두 세 번). 사이트가 응답하지 않은 것은 아니므로 건너뛰면 안 된다
  await reader.read('https://slow.example.go.kr/p2', 20);
  await reader.read('https://slow.example.go.kr/p3', 20);
  const fourth = reader.read('https://slow.example.go.kr/p4', 1000);
  gate.resolve();
  const got = await fourth;
  expect('부른 쪽이 먼저 떠난 것은 그 사이트의 시간 초과로 세지 않는다', [got.ok, calls.length], [true, 4]);
  await new Promise((r) => setTimeout(r, 10));
  const later = await reader.read('https://slow.example.go.kr/page', 20);
  expect('여는 일은 끝까지 가고, 다음에 찾는 쪽이 그 결과를 쓴다(다시 열지 않는다)', [later.ok, calls.length], [true, 4]);
}

console.log('[두는 양의 상한]');
{
  const { reader, calls } = setup((url) => okResult(url), { entries: 3 });
  for (const n of [1, 2, 3, 4]) await reader.read(`https://many.example.go.kr/p${n}`, 1000);
  expect('페이지 수가 상한을 넘으면 오래된 것부터 뺀다', reader.stats().kept, 3);
  await reader.read('https://many.example.go.kr/p4', 1000);
  await reader.read('https://many.example.go.kr/p1', 1000);
  expect('빠진 페이지는 다시 열고, 남은 페이지는 다시 쓴다', calls.length, 5);
}
{
  const { reader } = setup((url) => okResult(url, '가'.repeat(url.endsWith('big') ? 400 : 120)), { chars: 1000 });
  await reader.read('https://size.example.go.kr/big', 1000);
  expect('아주 큰 페이지(상한의 4분의 1 초과)는 두지 않는다', reader.stats().kept, 0);
  for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9]) await reader.read(`https://size.example.go.kr/p${n}`, 1000);
  expect('글자 수가 상한을 넘지 않게 오래된 것부터 뺀다', reader.stats().chars <= 1000 && reader.stats().kept < 9, true);
}
{
  const { reader } = setup((url) => okResult(url, '본문입니다.', Array.from({ length: 9 }, (_, i) => `<a href="/m${i}">메뉴 ${i}</a>`).join('')));
  const got = await reader.read('https://links.example.go.kr/', 1000);
  expect('페이지 하나에서 두는 링크 수에 상한이 있다', got.ok && got.links.length, 5);
}

console.log('[조금 전에 못 연 주소를 고르지 않기]');
{
  const answer = (url) => {
    if (url.includes('/gone')) return failResult(url, '페이지 없음');
    if (url.includes('/slow')) return failResult(url, '연결 실패');
    if (url.includes('/empty')) return okResult(url, '짧음');
    return okResult(url);
  };
  const { reader, calls, clock } = setup(answer);
  const ask = (path) => unopenableReason(`https://c.example.go.kr${path}`, 10, reader);
  expect('열어 본 적 없는 주소는 고를 수 있다', ask('/page'), '');
  for (const path of ['/page', '/slow', '/gone', '/empty']) await reader.read(`https://c.example.go.kr${path}`, 1000);
  const opened = calls.length;
  expect('잘 열린 주소는 고를 수 있다', ask('/page'), '');
  expect('조금 전에 못 연 주소는 까닭과 함께 빼라고 답한다', ask('/slow'), `${RECENT_FAILURE}: 연결 실패`);
  expect('없는 페이지도 뺀다', ask('/gone'), `${RECENT_FAILURE}: 페이지 없음`);
  expect('열어 보니 본문이 없던 주소도 뺀다', ask('/empty'), `${RECENT_FAILURE}: 본문 없음`);
  expect('세션 표시만 다른 주소도 같은 주소로 본다', ask('/slow;jsessionid=AAA111'), `${RECENT_FAILURE}: 연결 실패`);
  expect('묻는 것만으로는 요청을 내보내지 않고 집계도 바뀌지 않는다', [calls.length - opened, reader.stats().reused], [0, 0]);
  clock.t += 150;
  expect('잠깐의 실패는 기억하는 시간이 지나면 다시 고를 수 있다', ask('/slow'), '');
  expect('없는 페이지는 더 오래 뺀다', ask('/gone'), `${RECENT_FAILURE}: 페이지 없음`);
  expect(
    '잠깐 동안만 열지 않는 까닭을 가려낸다(다음에 다시 가릴 것)',
    [SKIPPED_REASON, `${RECENT_FAILURE}: 시간 초과`, '위키', ''].map((reason) => isPassingSkip(reason)),
    [true, true, false, false],
  );
}
{
  const { reader } = setup((url) => failResult(url, '시간 초과'));
  for (const n of [1, 2, 3]) await reader.read(`https://dead.example.go.kr/p${n}`, 1000);
  expect('건너뛰는 사이트의 다른 주소는 응답 없는 사이트라고 답한다', unopenableReason('https://dead.example.go.kr/p9', 10, reader), SKIPPED_REASON);
}

console.log('[건너뛰는 중인지 묻기, 검색 결과 합치기]');
{
  const { reader, calls, clock } = setup((url) => failResult(url, '시간 초과'));
  expect('응답 없던 적이 없는 사이트는 건너뛰는 중이 아니다', reader.skipping('https://dead.example.go.kr/p9'), false);
  for (const n of [1, 2, 3]) await reader.read(`https://dead.example.go.kr/p${n}`, 1000);
  expect('연달아 응답이 없으면 그 사이트의 주소는 건너뛰는 중이라고 답한다', [reader.skipping('https://dead.example.go.kr/p9'), reader.skipping('https://alive.example.go.kr/')], [true, false]);
  expect('묻는 것만으로는 요청을 내보내지 않는다', calls.length, 3);
  clock.t += 600;
  expect('건너뛰는 시간이 지나면 다시 열어 볼 수 있다고 답한다', reader.skipping('https://dead.example.go.kr/p9'), false);
}
{
  const hit = (url) => ({ url, title: '보도자료', description: '설명', date: null });
  const merged = mergeResults(
    [
      {
        kind: '기본',
        hits: [
          hit('https://www.example.go.kr/bbs/view.do;jsessionid=AAA111?id=7'),
          hit('https://www.example.go.kr/bbs/view.do;jsessionid=BBB222?id=7'),
          hit('https://www.example.go.kr/bbs/view.do?id=8'),
        ],
      },
    ],
    () => 1,
  );
  expect('검색 결과에서 세션 표시만 다른 주소는 한 후보로 합친다', merged.length, 2);
}

console.log('[예상하지 못한 오류]');
{
  const { reader } = setup(() => {
    throw new Error('뜻밖의 오류');
  });
  let thrown = false;
  let got = null;
  try {
    got = await reader.read('https://error.example.go.kr/', 1000);
  } catch {
    thrown = true;
  }
  expect('여는 중에 오류가 나도 던지지 않고 실패로 돌려준다', [thrown, got?.ok], [false, false]);
}

console.log(failed ? `\n실패 ${failed}건` : '\n모두 통과');
process.exit(failed ? 1 : 0);
