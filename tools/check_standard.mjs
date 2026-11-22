// 검증 기준 파일의 도메인 규칙이 기대대로 동작하는지 확인한다. Liner를 부르지 않는다.
// 위키는 열지 않고 판정에 보여 주지도 않는다. 블로그와 커뮤니티 플랫폼은 3등급으로 남는다.
// 사용: node tools/check_standard.mjs
import { mergeResults, pickPages } from '../lib/gather/rank.ts';
import { JUDGE_SYSTEM, judgeUserMessage } from '../lib/prompts/judge.ts';
import { STANDARD, excludedReason, finalGrade, isLowGradePlatform, notEvidenceDocType, provisionalGrade } from '../lib/standard.ts';

let failed = 0;
function expect(label, actual, wanted) {
  const ok = actual === wanted;
  if (!ok) failed += 1;
  console.log(`${ok ? '통과' : '실패'}  ${label}${ok ? '' : `  (기대 ${wanted}, 실제 ${actual})`}`);
}

console.log('[열지 않는 사이트]');
const WIKIS = [
  'ko.wikipedia.org',
  'en.m.wikipedia.org',
  'www.wikiwand.com',
  'ko.wikisource.org',
  'commons.wikimedia.org',
  'namu.wiki',
  'en.namu.wiki',
  'namu.moe',
  'thewiki.kr',
  'librewiki.net',
  'femiwiki.com',
  'uncyclopedia.kr',
  'starwars.fandom.com',
];
expect('위키는 모두 열지 않는다', WIKIS.filter((h) => excludedReason(h) !== '위키').join() || '모두', '모두');
expect('동영상 사이트는 전과 같이 열지 않는다', excludedReason('www.youtube.com'), '동영상');
const OPEN = ['www.wikitree.co.kr', 'encykorea.aks.ac.kr', 'terms.naver.com', 'www.heritage.go.kr', 'blog.naver.com', 'www.britannica.com'];
expect('이름에 wiki가 든 언론사, 백과사전, 기관, 블로그는 연다', OPEN.filter((h) => excludedReason(h) !== '').join() || '모두', '모두');

console.log('\n[낮은 등급 플랫폼]');
expect('블로그는 3등급 플랫폼으로 남는다', `${isLowGradePlatform('blog.naver.com')}/${isLowGradePlatform('m.blog.naver.com')}/${isLowGradePlatform('abc.tistory.com')}`, 'true/true/true');
expect('  공식 안내라고 해도 3등급', finalGrade('기관의 공식 안내', true, true), 3);
expect('위키는 이 목록에 두지 않는다', WIKIS.filter((h) => isLowGradePlatform(h)).join() || '없음', '없음');
expect('한 도메인이 두 목록에 함께 있지 않다', STANDARD.domains.lowGradePlatforms.filter((d) => excludedReason(d)).join() || '없음', '없음');

console.log('\n[문서 종류]');
expect("'위키'는 판정에 쓰지 않는 종류", notEvidenceDocType('위키'), true);
expect('  그 밖의 종류는 판정에 쓴다', STANDARD.documentTypes.filter((d) => d.id !== '위키' && notEvidenceDocType(d.id)).map((d) => d.id).join() || '없음', '없음');
expect('  목록에 없는 종류도 판정에 쓰지 않는 종류로 보지 않는다', notEvidenceDocType('없는 종류'), false);

console.log('\n[어느 페이지를 열지]');
const hit = (url, title) => ({ url, title, hostname: new URL(url).hostname, description: '천상열차분야지도 각석', date: null });
const batch = {
  kind: '기본',
  hits: [
    hit('https://ko.wikipedia.org/wiki/천상열차분야지도', '천상열차분야지도 - 위키백과'),
    hit('https://namu.wiki/w/천상열차분야지도', '천상열차분야지도 - 나무위키'),
    hit('https://www.heritage.go.kr/heri/cul/culSelectDetail.do?ccbaCpno=1', '천상열차분야지도 각석'),
    hit('https://blog.naver.com/someone/1', '천상열차분야지도를 보고 왔다'),
    hit('https://www.example-news.co.kr/a/1', '천상열차분야지도 공개'),
    hit('https://www.youtube.com/watch?v=1', '천상열차분야지도 영상'),
  ],
};
const candidates = mergeResults([batch], () => 1);
expect('위키 후보에는 열지 않는 까닭이 붙는다', candidates.filter((c) => c.skip === '위키').map((c) => c.hostname).join(), 'ko.wikipedia.org,namu.wiki');
expect('  잠정 등급은 3등급', candidates.filter((c) => c.skip === '위키').map((c) => provisionalGrade(c.hostname)).join(), '3,3');
const picked = pickPages(candidates, 4, new Set(), false).map((c) => c.hostname);
expect('자리가 남아도 위키와 동영상은 고르지 않는다', picked.join(), 'www.heritage.go.kr,blog.naver.com,www.example-news.co.kr');
const onlyWikis = mergeResults([{ kind: '기본', hits: batch.hits.slice(0, 2) }], () => 1);
expect('검색 결과가 위키뿐이면 아무것도 열지 않는다', pickPages(onlyWikis, 3, new Set(), false).length, 0);

console.log('\n[판정에 보내는 글]');
expect('문서 종류의 설명에 위키를 쓰지 않는다고 적는다', JUDGE_SYSTEM.includes('위키(근거로 쓰지 않음): 누구나 고칠 수 있는 위키 문서. 판정의 근거로 쓰지 않는다'), true);
expect('문서 종류마다 등급을 함께 적는다', JUDGE_SYSTEM.includes('백과사전(2등급):') && JUDGE_SYSTEM.includes('기관의 공식 안내(1등급, own_fact가 false면 2등급):'), true);
expect('판정 지침에도 적는다', JUDGE_SYSTEM.includes('위키 문서는 판정의 근거로 쓰지 않는다'), true);
const source = (no, hostname, lowPlatform) => ({
  no,
  url: `https://${hostname}/a`,
  title: '',
  hostname,
  date: null,
  pageDate: null,
  summary: '',
  foundBy: ['기본'],
  provisionalGrade: 3,
  publisherHint: '',
  lowPlatform,
  fetch: { status: '성공', reason: '', chars: 1000, truncated: false, fetchedAt: '2026-11-20T00:00:00.000Z' },
});
// 기준을 바꾸기 전에 모은 묶음: 위키백과의 발췌가 들어 있다
const oldBundle = {
  v: 1,
  claimKey: 'x',
  gatheredAt: '2026-11-20T03:00:00.000Z',
  searches: [],
  sources: [source(1, 'www.gogung.go.kr', false), source(2, 'ko.wikipedia.org', true), source(3, 'blog.naver.com', true)],
  evidence: [
    { no: 1, sourceNo: 1, text: '세로: 211㎝' },
    { no: 2, sourceNo: 2, text: '위키백과의 발췌' },
    { no: 3, sourceNo: 3, text: '블로그의 발췌' },
  ],
  extraSearch: { done: false, reason: '' },
  premium: [],
};
const claim = { statement: '각석의 세로는 211cm다', sentence: '', type: '제원·실측', qualifiers: [], asOf: '현재' };
let message = judgeUserMessage({ ...claim, bundle: oldBundle });
expect('예전 묶음에 남은 위키의 발췌는 모델에 보내지 않는다', `${message.includes('위키백과의 발췌')}/${message.includes('ko.wikipedia.org')}`, 'false/false');
expect('  기관과 블로그의 발췌는 보낸다', `${message.includes('세로: 211㎝')}/${message.includes('블로그의 발췌')}`, 'true/true');
expect('  블로그에는 플랫폼이라고 적는다', message.includes('blog.naver.com |') && message.includes('블로그·커뮤니티 플랫폼'), true);
message = judgeUserMessage({ ...claim, bundle: { ...oldBundle, sources: [oldBundle.sources[1]], evidence: [oldBundle.evidence[1]] } });
expect('위키의 발췌뿐이면 모은 근거가 없다고 보낸다', message.includes('(모은 근거가 없습니다)'), true);

console.log(failed ? `\n실패 ${failed}건` : '\n모두 통과');
process.exit(failed ? 1 : 0);
