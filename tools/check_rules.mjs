// 판정의 코드 규칙(PRD 5.3절)이 기대대로 동작하는지 확인한다. Liner를 부르지 않는다.
// 모델이 이렇게 답했다고 치고, 코드가 판정을 어떻게 확정하는지를 본다.
// 사용: node tools/check_rules.mjs
import { SINGLE_REFUTER_FLAG, TWO_PUBLISHERS_FLAG } from '../lib/flags.ts';
import { CITE_INSTRUCTION, applyRules, sharesLongRun, squeezeQuote } from '../lib/judge/rules.ts';
import { publisherKey, samePublisherName } from '../lib/standard.ts';

let failed = 0;
function expect(label, actual, wanted) {
  const ok = actual === wanted;
  if (!ok) failed += 1;
  console.log(`${ok ? '통과' : '실패'}  ${label}${ok ? '' : `  (기대 ${wanted}, 실제 ${actual})`}`);
}

// 출처: 기관(목록에 있음), 백과, 블로그 플랫폼, 언론 둘, 논문, 목록에 없는 위키, 기준을 바꾸기 전에 모은 묶음에 남은 위키백과.
// 9~13은 '서로 다른 곳이 낸 글'을 가리는 데 쓴다: 백과와 같은 기관의 다른 사이트, 국가유산청의 두 사이트, 정책브리핑, 백과의 글을 옮겨 실은 곳
const SOURCES = [
  { no: 1, hostname: 'www.gogung.go.kr', publisherHint: '국립고궁박물관', lowPlatform: false },
  { no: 2, hostname: 'encykorea.aks.ac.kr', publisherHint: '한국학중앙연구원', lowPlatform: false },
  { no: 3, hostname: 'blog.naver.com', publisherHint: '', lowPlatform: true },
  { no: 4, hostname: 'www.example-news.co.kr', publisherHint: '', lowPlatform: false },
  { no: 5, hostname: 'www.another-news.co.kr', publisherHint: '', lowPlatform: false },
  { no: 6, hostname: 'www.kci.go.kr', publisherHint: '', lowPlatform: false },
  { no: 7, hostname: 'wiki.example.org', publisherHint: '', lowPlatform: false },
  { no: 8, hostname: 'ko.wikipedia.org', publisherHint: '', lowPlatform: true },
  { no: 9, hostname: 'dh.aks.ac.kr', publisherHint: '한국학중앙연구원', lowPlatform: false },
  { no: 10, hostname: 'www.khs.go.kr', publisherHint: '국가유산청', lowPlatform: false },
  { no: 11, hostname: 'www.heritage.go.kr', publisherHint: '국가유산청(국가유산포털)', lowPlatform: false },
  { no: 12, hostname: 'www.korea.kr', publisherHint: '대한민국 정책브리핑', lowPlatform: false },
  { no: 13, hostname: 'www.example-museum.or.kr', publisherHint: '', lowPlatform: false },
].map((s) => ({
  ...s,
  url: `https://${s.hostname}/a`,
  title: '',
  date: null,
  pageDate: null,
  summary: '',
  foundBy: ['기본'],
  provisionalGrade: 1,
  fetch: { status: '성공', reason: '', chars: 1000, truncated: false, fetchedAt: '2026-11-20T00:00:00.000Z' },
}));
const TEXTS = {
  1: '크기(cm)\n세로: 211㎝, 가로: 123㎝\n관람 시간 | 09:30 ~ 17:30',
  2: '천상열차분야지도 각석은 1395년(태조 4)에 만든 석각천문도이다. 세계에서 두 번째로 오래된 석각천문도이다.',
  3: '각석의 크기는 세로 311cm라고 한다. 세계에서 가장 오래된 천문도다.',
  4: '박물관은 오전 10시부터 오후 6시까지 문을 연다고 밝혔다.',
  5: '박물관 관람 시간은 오전 10시부터 오후 6시까지다.',
  6: '태조본 각석은 1395년에 제작되었다. 이 연구는 각석을 직접 조사했다.',
  7: '각석의 크기는 세로 311cm이다. 태조 때 만든 석각천문도로 세계에서 가장 오래되었다.',
  8: '천상열차분야지도 각석의 세로는 311cm이다.',
  9: '이 각석은 태조 4년인 1395년에 돌에 새겼다.',
  10: '각석은 조선 태조 4년(1395)에 제작하였다.',
  11: '태조 4년(1395) 12월에 돌에 새겨 완성한 천문도이다.',
  12: '각석은 1395년에 만들어졌다고 밝혔다.',
  13: '소개 글. 천상열차분야지도 각석은 1395년(태조 4)에 만든 석각천문도이다. 세계에서 두 번째로 오래된 석각천문도이다.',
};
const bundleOf = (nos) => ({
  v: 1,
  claimKey: 'x',
  gatheredAt: '2026-11-20T03:00:00.000Z',
  searches: [],
  sources: SOURCES,
  evidence: nos.map((no) => ({ no, sourceNo: no, text: TEXTS[no] })),
  extraSearch: { done: false, reason: '' },
  premium: [],
});
// 8번은 모델이 위키백과를 백과사전으로 잘못 골랐다고 친다
const DOC = {
  1: '기관의 공식 안내',
  2: '백과사전',
  3: '블로그·커뮤니티 글',
  4: '언론 보도',
  5: '언론 보도',
  6: '학술 논문',
  7: '위키',
  8: '백과사전',
  9: '기관의 해설 글',
  10: '기관의 해설 글',
  11: '기관의 해설 글',
  12: '기관의 해설 글',
  13: '기관의 해설 글',
};
const ev = (no, relation, quote, over = {}) => ({ evidence_no: no, relation, target: '적용 가능', scope: '적용 가능', time: '적용 가능', quote, ...over });
function model(verdict, evidence, over = {}) {
  return {
    sources: evidence.map((e) => ({ source_no: e.evidence_no, doc_type: DOC[e.evidence_no], publisher: '', own_fact: true })),
    links: [],
    evidence,
    qualifiers: [],
    conflict: { state: '엇갈림 없음', correcting_evidence_no: 0, correcting_quote: '' },
    verdict,
    reason: '',
    priority: '중',
    need_choice: false,
    fix: { kind: '없음', instruction: '', source_no: 0 },
    action: '',
    ...over,
  };
}
function run(type, statement, m, { lead = false } = {}) {
  const nos = [...new Set(m.evidence.map((e) => e.evidence_no))];
  return applyRules({ claim: { statement, type, lead }, bundle: bundleOf(nos), model: m, sentenceKey: 'k' });
}

console.log('[인용문 견주기]');
expect('공백과 칸 구분, ㎝와 cm의 차이는 무시한다', squeezeQuote(TEXTS[1]).includes(squeezeQuote('관람 시간 09:30~17:30')), true);
expect('세로: 211cm도 같은 것으로 본다', squeezeQuote(TEXTS[1]).includes(squeezeQuote('세로: 211cm')), true);
expect('글자로 섞여 든 태그(</br>)는 빼고 견준다', squeezeQuote('제작되었다.</br>'), squeezeQuote('제작되었다.'));
expect('없는 구절은 여전히 없다고 본다', squeezeQuote(TEXTS[1]).includes(squeezeQuote('세로: 311cm')), false);

console.log('\n[일치]');
let j = run('운영 정보', '박물관은 09:30부터 17:30까지 문을 연다', model('일치', [ev(1, '지지', '관람 시간 | 09:30 ~ 17:30')]));
expect('1등급 지지 근거가 있으면 일치', j.verdict, '일치');
expect('  바꾸지 않았으면 낮춘 기록이 없다', j.lowered, null);

j = run('운영 정보', '박물관은 10시부터 18시까지 문을 연다', model('일치', [ev(3, '지지', '세로 311cm라고 한다')]));
expect('3등급 지지뿐이면 근거 부족(2번)', `${j.verdict}/${j.lowered?.rule}`, '근거 부족/2번');

j = run('운영 정보', '박물관은 10시부터 18시까지 문을 연다', model('일치', [ev(1, '지지', '오전 10시부터 오후 6시까지')]));
expect('인용문이 발췌에 없으면 근거 부족(1번)', `${j.verdict}/${j.lowered?.rule}`, '근거 부족/1번');

j = run('운영 정보', '박물관은 09:30부터 문을 연다', model('일치', [ev(1, '지지', '09:30 ~ 17:30', { target: '적용 불가' })]));
expect('대상이 적용 불가면 근거 부족(4번)', `${j.verdict}/${j.lowered?.rule}`, '근거 부족/4번');

j = run('운영 정보', '박물관은 09:30부터 문을 연다', model('일치', [ev(1, '반박', '09:30 ~ 17:30')]));
expect('일치라면서 지지 근거가 없으면 근거 부족(5번)', `${j.verdict}/${j.lowered?.rule}`, '근거 부족/5번');

j = applyRules({ claim: { statement: '가', type: '기타', lead: false }, bundle: bundleOf([]), model: model('일치', []), sentenceKey: 'k' });
expect('원문을 하나도 열지 못했으면 근거 부족(3번)', `${j.verdict}/${j.lowered?.rule}`, '근거 부족/3번');

j = run('운영 정보', '박물관은 09:30부터 문을 연다', {
  ...model('일치', [ev(1, '지지', '09:30 ~ 17:30')]),
  sources: [{ source_no: 1, doc_type: '기관의 공식 안내', publisher: '국립고궁박물관', own_fact: false }],
});
expect('기관이 직접 정하는 사실이 아니면 2등급이라 운영 정보는 근거 부족', `${j.verdict}/${j.sources[0].grade}`, '근거 부족/2');

console.log('\n[유형별 요구 수준]');
const two = [ev(2, '지지', '1395년(태조 4)에 만든'), ev(6, '지지', '1395년에 제작되었다')];
j = run('연대·인명·기관명', '각석은 1395년에 만들었다', model('일치', two));
expect('서로 다른 곳이 낸 2등급 둘이면 독립의 단서가 없어도 일치, 표시를 붙인다', `${j.verdict}/${j.flags.join()}`, `일치/${TWO_PUBLISHERS_FLAG}`);
j = run('연대·인명·기관명', '각석은 1395년에 만들었다', model('일치', two, { links: [{ a: 2, b: 6, status: '독립 추정', reason: '직접 조사' }] }));
expect('독립 추정인 2등급 둘이면 일치, 표시는 붙이지 않는다', `${j.verdict}/${j.flags.join()}`, '일치/');
j = run('연대·인명·기관명', '각석은 1395년에 만들었다', model('일치', two, { links: [{ a: 2, b: 6, status: '중복', reason: '같은 자료' }] }));
expect('중복이면 한 출처로 세어 근거 부족', j.verdict, '근거 부족');
j = run('연대·인명·기관명', '각석은 태조 때 만든 석각천문도다', model('일치', [ev(2, '지지', '만든 석각천문도이다')]));
expect('값이 달려 있지 않은 서술은 2등급 하나로 일치(단일 근거 표시)', `${j.verdict}/${j.flags.join()}`, '일치/단일 근거');
j = run('연대·인명·기관명', '각석은 태조 때 만든 석각천문도다', model('일치', [ev(2, '지지', '만든 석각천문도이다')]), { lead: true });
expect('  같은 경우라도 제목·첫 문단이면 근거 부족', j.verdict, '근거 부족');
j = run('통설', '각석은 태조 때 만든 것으로 전한다', model('일치', [ev(2, '지지', '만든 석각천문도이다')]));
expect('통설은 못 채우면 해석 주의', j.verdict, '해석 주의');
j = run('운영 정보', '박물관은 10시부터 18시까지 문을 연다', model('일치', [ev(4, '지지', '오전 10시부터 오후 6시까지'), ev(5, '지지', '오전 10시부터 오후 6시까지')]));
expect('운영 정보는 여러 보도가 같으면 해석 주의', j.verdict, '해석 주의');

console.log('\n[서로 다른 곳이 낸 2등급 둘]');
const year = '각석은 1395년에 만들었다';
const Q = {
  2: '1395년(태조 4)에 만든',
  9: '1395년에 돌에 새겼다',
  10: '태조 4년(1395)에 제작하였다',
  11: '태조 4년(1395) 12월에',
  12: '1395년에 만들어졌다고',
  13: '1395년(태조 4)에 만든',
};
const pair = (a, b, over = {}) => run('연대·인명·기관명', year, model('일치', [ev(a, '지지', Q[a]), ev(b, '지지', Q[b])], over));
const rated = (a, pa, b, pb) => ({
  sources: [
    { source_no: a, doc_type: '기관의 해설 글', publisher: pa, own_fact: false },
    { source_no: b, doc_type: '기관의 해설 글', publisher: pb, own_fact: false },
  ],
});
j = pair(2, 9);
expect('같은 기관의 두 사이트에 실린 글은 한 출처로 세어 근거 부족', j.verdict, '근거 부족');
j = pair(10, 11);
expect('사이트가 달라도 기관 이름이 같으면 한 출처로 센다(국가유산청과 국가유산포털)', j.verdict, '근거 부족');
j = pair(10, 12, rated(10, '국가유산청', 12, '문화재청'));
expect('모델이 적은 발행 주체가 그 기관의 예전 이름이어도 같은 곳으로 본다(문화재청)', j.verdict, '근거 부족');
j = pair(10, 12, rated(10, '국가유산청', 12, '국립중앙과학관'));
expect('  발행 주체가 다른 기관이면 서로 다른 곳이 낸 둘로 센다', `${j.verdict}/${j.flags.join()}`, `일치/${TWO_PUBLISHERS_FLAG}`);
j = pair(2, 13);
expect('다른 곳이 낸 글이어도 한쪽이 옮겨 적은 글이면 한 출처로 센다', j.verdict, '근거 부족');
j = pair(2, 10, { links: [{ a: 2, b: 10, status: '중복', reason: '같은 보도자료' }] });
expect('모델이 중복이라고 한 쌍은 서로 다른 곳이어도 한 출처로 센다', j.verdict, '근거 부족');
j = run('연대·인명·기관명', year, model('일치', [ev(2, '지지', Q[2]), ev(4, '지지', '오전 10시부터 오후 6시까지')]));
expect('2등급 하나와 3등급 하나는 서로 다른 곳이어도 채우지 못한다', j.verdict, '근거 부족');
j = run('통설', '각석은 태조 때 만든 것으로 전한다', model('일치', [ev(2, '지지', '만든 석각천문도이다'), ev(10, '지지', '제작하였다')]));
expect('통설도 서로 다른 곳이 낸 2등급 둘이면 일치', `${j.verdict}/${j.flags.join()}`, `일치/${TWO_PUBLISHERS_FLAG}`);
j = run('인과', '각석은 태조의 명으로 만들었다', model('일치', [ev(2, '지지', '만든 석각천문도이다'), ev(10, '지지', '제작하였다')]));
expect('인과는 학술 논문이 아닌 2등급 둘로는 채우지 못한다', j.verdict, '근거 부족');
j = run('운영 정보', '박물관은 10시부터 18시까지 문을 연다', model('일치', [ev(2, '지지', '만든 석각천문도이다'), ev(10, '지지', '제작하였다')]));
expect('1등급만 받는 유형은 서로 다른 곳이 낸 2등급 둘로도 채우지 못한다', j.verdict, '근거 부족');
expect('괄호 속 덧붙임은 빼고 견준다', publisherKey('국가유산청(국가유산포털)'), '국가유산청');
expect('예전 이름은 지금 이름으로 바꿔 견준다', samePublisherName('문화재청', '국가유산청'), true);
expect('한쪽이 다른 쪽을 품으면 같은 곳', samePublisherName('국가유산청 국가유산포털', '국가유산청'), true);
expect('다른 기관은 다른 곳', samePublisherName('국가기록원', '국가유산청'), false);
expect('이름을 모르면 같다고 보지 않는다', samePublisherName('', '국가유산청'), false);
const longText = '청주 흥덕사지는 1985년 발굴조사 때 금당터와 서회랑터, 강당터가 확인되었고 흥덕사라고 새겨진 쇠북 조각이 나와 절의 이름을 알게 되었다.';
expect('긴 대목이 그대로 겹치면 옮겨 적은 글(띄어쓰기는 무시)', sharesLongRun(`머리말. ${longText}`, `${longText.replace(/ /g, '')} 꼬리말`), true);
expect(
  '이름과 연도만 겹치는 정도는 옮겨 적은 글이 아니다',
  sharesLongRun('백운화상초록불조직지심체요절은 1377년 청주 흥덕사에서 찍었다.', '1377년에 흥덕사에서 간행한 백운화상초록불조직지심체요절(직지)이다.'),
  false,
);

console.log('\n[불일치]');
const wrongSize = '각석의 세로는 311cm다';
j = run('제원·실측', wrongSize, model('불일치', [ev(1, '반박', '세로: 211㎝')], { fix: { kind: '교정안', instruction: '세로 311cm를 211cm로 고친다', source_no: 0 } }));
expect('1등급 반박이 있으면 불일치, 교정안 유지', `${j.verdict}/${j.fix.kind}`, '불일치/교정안');
j = run('제원·실측', '각석의 세로는 211cm다', model('불일치', [ev(3, '반박', '세로 311cm라고 한다')], { fix: { kind: '교정안', instruction: '211cm를 311cm로 고친다', source_no: 0 } }));
expect('3등급 반박뿐이면 근거 부족(2번), 교정안 없음', `${j.verdict}/${j.lowered?.rule}/${j.fix.kind}`, '근거 부족/2번/없음');
j = run('제원·실측', wrongSize, model('불일치', [ev(1, '지지', '세로: 211㎝')]));
expect('불일치라면서 반박 근거가 없으면 근거 부족(5번)', `${j.verdict}/${j.lowered?.rule}`, '근거 부족/5번');

console.log('\n[엇갈린 근거]');
const mixed = [ev(1, '반박', '세로: 211㎝'), ev(3, '지지', '세로 311cm라고 한다')];
j = run('제원·실측', wrongSize, model('불일치', mixed, { fix: { kind: '교정안', instruction: '세로 311cm를 211cm로 고친다', source_no: 0 } }));
expect('1등급 반박과 3등급 지지가 함께 있으면 해석 주의(6번)', `${j.verdict}/${j.lowered?.rule}`, '해석 주의/6번');
expect('  교정안 대신 2등급 이상 출처를 밝힌 인용형', `${j.fix.kind}/${j.fix.sourceNo}`, '인용형/1');
expect('  편집자가 골라야 한다고 표시', j.needChoice, true);
expect('  양쪽의 가장 높은 등급을 남긴다', `${j.conflict.supportTop}/${j.conflict.refuteTop}`, '3/1');
expect('  그 출처의 내용으로 바꾸라는 말을 함께 적는다', j.fix.instruction.includes('그 출처의 내용: 세로 311cm를 211cm로 고친다'), true);
j = run('제원·실측', wrongSize, model('해석 주의', mixed, { fix: { kind: '인용형', instruction: '이 출처의 설명임을 밝혀 쓴다', source_no: 1 } }));
expect('원고와 다르게 적은 출처의 이름을 붙이면서 원고의 내용을 그대로 두지는 않는다', `${j.verdict}/${j.fix.kind}`, '해석 주의/없음');
const bothSides = [ev(2, '지지', '1395년(태조 4)에 만든'), ev(10, '반박', '태조 4년(1395)에 제작하였다')];
j = run('연대·인명·기관명', '각석은 1395년에 만들었다', model('해석 주의', bothSides, { fix: { kind: '인용형', instruction: '이 출처의 설명임을 밝혀 쓴다', source_no: 2 } }));
expect(
  '엇갈릴 때 모델이 고른 출처가 원고와 같은 내용을 적고 있으면 그 이름만 밝힌다',
  `${j.verdict}/${j.fix.kind}/${j.fix.sourceNo}/${j.fix.instruction}`,
  `해석 주의/인용형/2/${CITE_INSTRUCTION}`,
);
j = run('연대·인명·기관명', '각석은 1395년에 만들었다', model('불일치', bothSides, { fix: { kind: '교정안', instruction: '1395년을 1396년으로 고친다', source_no: 0 } }));
expect('  모델이 고르지 않았으면 코드가 지지 출처를 골라 이름을 붙이지 않는다', `${j.verdict}/${j.fix.kind}`, '해석 주의/없음');
// 2등급 이상 출처끼리 엇갈린다: 백과(2등급)는 1395년, 국가유산청(2등급)은 1396년이라고 적었다고 친다
const disputed = {
  ...bundleOf([2]),
  evidence: [
    { no: 2, sourceNo: 2, text: TEXTS[2] },
    { no: 10, sourceNo: 10, text: '각석은 조선 태조 5년(1396)에 제작하였다.' },
  ],
};
const dispute = (over) =>
  applyRules({
    claim: { statement: '각석은 1395년에 만들었다', type: '연대·인명·기관명', lead: false },
    bundle: disputed,
    model: model('불일치', [ev(2, '지지', '1395년(태조 4)에 만든'), ev(10, '반박', '태조 5년(1396)에 제작하였다')], { fix: { kind: '교정안', instruction: '1395년을 1396년으로 고친다', source_no: 0 }, ...over }),
    sentenceKey: 'k',
  });
j = dispute({});
expect('2등급 이상 출처끼리 엇갈리면 반박 쪽 값으로 바꾸는 수정안을 내지 않는다', `${j.verdict}/${j.conflict.supportTop}/${j.fix.kind}`, '해석 주의/2/없음');
// 지지는 블로그(3등급)뿐이고 반박은 기관(1등급)인 경우에만 그 기관의 내용으로 바꾼다(위의 '교정안 대신 … 인용형'). 바꿔 넣을 수가 발췌에 없으면 그것도 하지 않는다
j = run('제원·실측', wrongSize, model('불일치', mixed, { fix: { kind: '교정안', instruction: '세로 311cm를 212cm로 고친다', source_no: 0 } }));
expect('  바꿔 넣을 수(212)가 반박 출처의 발췌에 없으면 그 출처의 이름으로 고치지 않는다', `${j.verdict}/${j.fix.kind}`, '해석 주의/없음');
j = run('최상급', '각석은 세계에서 가장 오래된 천문도다', model('해석 주의', [ev(3, '지지', '세계에서 가장 오래된 천문도다'), ev(4, '반박', '오전 10시부터')]));
expect('엇갈리는 근거가 모두 3등급이면 근거 부족', j.verdict, '근거 부족');
const fixed = { state: '바로잡은 자료로 풀림', correcting_evidence_no: 1, correcting_quote: '세로: 211㎝, 가로: 123㎝' };
j = run('제원·실측', wrongSize, model('불일치', mixed, { conflict: fixed }));
expect('바로잡은 구절이 발췌에 있고 1등급이면 그쪽을 따른다', `${j.verdict}/${j.conflict.resolved}`, '불일치/true');
j = run('제원·실측', wrongSize, model('불일치', mixed, { conflict: { ...fixed, correcting_quote: '앞서 적은 크기를 바로잡습니다' } }));
expect('바로잡았다는 구절이 발췌에 없으면 해석 주의', j.verdict, '해석 주의');

console.log('\n[위키는 판정의 근거로 쓰지 않는다]');
j = run('제원·실측', wrongSize, model('일치', [ev(7, '지지', '세로 311cm이다')]));
expect('위키의 지지뿐이면 근거 부족(2번)', `${j.verdict}/${j.lowered?.rule}`, '근거 부족/2번');
expect('  바꾼 까닭에 위키라고 적는다', j.lowered?.note.includes('위키'), true);
expect('  그 출처에 쓰지 않는 까닭을 남긴다', j.sources[0].notUsed, '위키');
expect('  그 근거는 판정에 쓰지 않은 것으로 남긴다', j.evidence[0].usable, false);
j = run('제원·실측', wrongSize, model('불일치', [ev(1, '반박', '세로: 211㎝'), ev(7, '지지', '세로 311cm이다')], { fix: { kind: '교정안', instruction: '세로 311cm를 211cm로 고친다', source_no: 0 } }));
expect('1등급 반박과 위키의 지지가 함께 있어도 불일치(엇갈린 것으로 보지 않는다)', `${j.verdict}/${j.conflict.found}/${j.fix.kind}`, '불일치/false/교정안');
j = run('제원·실측', '각석의 세로는 211cm다', model('일치', [ev(1, '지지', '세로: 211㎝'), ev(7, '반박', '세로 311cm이다')]));
expect('1등급 지지와 위키의 반박이 함께 있어도 일치', `${j.verdict}/${j.conflict.found}`, '일치/false');
j = run('제원·실측', '각석의 세로는 211cm다', model('불일치', [ev(7, '반박', '세로 311cm이다')], { fix: { kind: '교정안', instruction: '211cm를 311cm로 고친다', source_no: 0 } }));
expect('위키의 반박뿐이면 근거 부족(2번), 교정안 없음', `${j.verdict}/${j.lowered?.rule}/${j.fix.kind}`, '근거 부족/2번/없음');
j = run(
  '최상급',
  '각석은 세계에서 가장 오래된 천문도다',
  model('해석 주의', [ev(7, '지지', '세계에서 가장 오래되었다', { scope: '미확인' })], {
    qualifiers: [{ text: '가장', result: '확인하지 못했다', note: '' }],
    fix: { kind: '축소안', instruction: "'세계에서 가장'을 뺀다", source_no: 0 },
  }),
);
expect('같은 대상을 다룬 자료가 위키뿐이면 해석 주의도 축소안도 두지 않는다', `${j.verdict}/${j.fix.kind}`, '근거 부족/없음');
j = run('제원·실측', wrongSize, model('불일치', [ev(1, '반박', '세로: 211㎝'), ev(8, '지지', '세로는 311cm이다')]));
expect('예전 묶음에 남은 위키백과는 모델이 백과사전이라고 해도 쓰지 않는다', `${j.verdict}/${j.sources.find((s) => s.sourceNo === 8)?.notUsed}`, '불일치/위키');
j = run('제원·실측', wrongSize, model('불일치', [ev(1, '반박', '세로: 211㎝'), ev(3, '지지', '세로 311cm라고 한다')]));
expect('블로그 플랫폼의 글은 전과 같이 3등급 근거로 센다(엇갈리면 해석 주의)', `${j.verdict}/${j.sources.find((s) => s.sourceNo === 3)?.notUsed}`, '해석 주의/undefined');

console.log('\n[수정 방향과 우선순위]');
j = run('최상급', '각석은 세계에서 가장 오래된 천문도다', model('해석 주의', [ev(2, '반박', '세계에서 두 번째로 오래된', { scope: '미확인' })], { fix: { kind: '인용형', instruction: '블로그의 설명임을 밝힌다', source_no: 3 } }));
expect('평가하지 않은 출처를 밝히라는 인용형은 받지 않는다', j.fix.kind, '없음');
const hearsay = '각석은 태조 때 만든 것으로 전한다';
j = run('통설', hearsay, model('해석 주의', [ev(2, '지지', '만든 석각천문도이다')], { fix: { kind: '인용형', instruction: '이 출처의 설명임을 밝혀, 태조 때 만들었다고 전해진다고 쓴다', source_no: 2 } }));
expect('인용형의 고칠 내용은 코드가 정해 둔 말만 쓴다', `${j.fix.kind}/${j.fix.sourceNo}/${j.fix.instruction}`, `인용형/2/${CITE_INSTRUCTION}`);
j = run('통설', hearsay, model('해석 주의', [ev(2, '지지', '만든 석각천문도이다'), ev(10, '판단 불충분', '제작하였다')], { fix: { kind: '인용형', instruction: '이 출처의 설명임을 밝혀 쓴다', source_no: 10 } }));
expect('모델이 고른 출처에 지지 근거가 없으면 인용형을 두지 않는다(코드가 다른 출처로 바꿔 넣지 않는다)', j.fix.kind, '없음');
j = run('통설', '각석은 1395년에 만든 것으로 전한다', model('해석 주의', [ev(12, '지지', '1395년에 만들어졌다고')], { fix: { kind: '인용형', instruction: '이 출처의 설명임을 밝혀 쓴다', source_no: 12 } }));
expect('명제의 수가 그 출처의 발췌에 있으면 인용형을 둔다', `${j.fix.kind}/${j.fix.sourceNo}`, '인용형/12');
j = run('통설', '각석은 1396년에 만든 것으로 전한다', model('해석 주의', [ev(12, '지지', '1395년에 만들어졌다고')], { fix: { kind: '인용형', instruction: '이 출처의 설명임을 밝혀 쓴다', source_no: 12 } }));
expect('명제의 수가 그 출처의 발췌에 없으면 인용형을 두지 않는다', j.fix.kind, '없음');
// 모델이 명제의 일부만 확인해 준 근거를 지지로 적은 경우: 출처는 도서관이라고 적었는데 원고는 박물관이라고 썼다
const holders = {
  ...bundleOf([]),
  evidence: [{ no: 2, sourceNo: 2, text: '목판본은 한국학중앙연구원 장서각과 국립중앙도서관에 소장되어 있다.' }],
};
const cite2 = { kind: '인용형', instruction: '이 출처의 설명임을 밝혀 쓴다', source_no: 2 };
j = applyRules({
  claim: { statement: '목판본은 한국학중앙연구원과 국립중앙박물관에 전합니다', type: '통설', lead: false },
  bundle: holders,
  model: model('해석 주의', [ev(2, '지지', '한국학중앙연구원 장서각과 국립중앙도서관에')], { fix: cite2 }),
  sentenceKey: 'k',
});
expect('명제의 기관 이름이 그 출처의 발췌에 없으면 인용형을 두지 않는다(박물관과 도서관)', j.fix.kind, '없음');
j = applyRules({
  claim: { statement: '목판본은 한국학중앙연구원과 국립중앙도서관에 전합니다', type: '통설', lead: false },
  bundle: holders,
  model: model('해석 주의', [ev(2, '지지', '한국학중앙연구원 장서각과 국립중앙도서관에')], { fix: cite2 }),
  sentenceKey: 'k',
});
expect('  기관 이름이 모두 있으면 둔다(조사가 붙어 있어도 찾는다)', `${j.fix.kind}/${j.fix.sourceNo}`, '인용형/2');
j = run('통설', hearsay, model('해석 주의', [ev(3, '지지', '세계에서 가장 오래된 천문도다'), ev(10, '판단 불충분', '제작하였다')], { fix: { kind: '인용형', instruction: '이 출처의 설명임을 밝혀 쓴다', source_no: 10 } }));
expect('원고와 같은 내용을 적은 2등급 이상 출처가 없으면 인용형을 두지 않는다', j.fix.kind, '없음');
j = run('제원·실측', wrongSize, model('불일치', [ev(1, '반박', '세로: 211㎝')], { fix: { kind: '인용형', instruction: '이 출처의 설명임을 밝혀 쓴다', source_no: 1 } }));
expect('불일치에는 인용형을 두지 않는다(원고와 다르게 적은 출처다)', `${j.verdict}/${j.fix.kind}`, '불일치/없음');
j = run('최상급', '각석은 세계에서 가장 오래된 천문도다', model('해석 주의', [ev(2, '반박', '세계에서 두 번째로 오래된', { scope: '미확인' })], { fix: { kind: '교정안', instruction: '두 번째로 고친다', source_no: 0 } }));
expect('불일치가 아니면 교정안을 두지 않는다', `${j.verdict}/${j.fix.kind}`, '해석 주의/없음');
j = run('제원·실측', wrongSize, model('불일치', [ev(1, '반박', '세로: 211㎝')], { priority: '하' }), { lead: true });
expect('제목·첫 문단의 문장은 우선순위를 상으로 올린다', j.priority, '상');
j = run('운영 정보', '박물관은 09:30부터 17:30까지 문을 연다', model('일치', [ev(1, '지지', '09:30 ~ 17:30')], { priority: '상' }));
expect('일치에는 우선순위를 매기지 않는다', j.priority, null);
j = run('운영 정보', '박물관은 09:30부터 문을 연다', {
  ...model('일치', [ev(4, '지지', '오전 10시부터 오후 6시까지')]),
  sources: [{ source_no: 4, doc_type: '기관의 공식 안내', publisher: '어느 박물관', own_fact: true }],
});
expect('목록에 없는 곳을 1등급으로 보면 발행 주체 확인 표시', `${j.verdict}/${j.flags.join()}`, '일치/발행 주체 확인 필요');
j = run('운영 정보', '박물관은 09:30부터 문을 연다', {
  ...model('일치', [ev(3, '지지', '세로 311cm라고 한다')]),
  sources: [{ source_no: 3, doc_type: '기관의 공식 안내', publisher: '국립고궁박물관', own_fact: true }],
});
expect('블로그 플랫폼의 글은 공식 안내라고 해도 3등급', `${j.verdict}/${j.sources[0].grade}`, '근거 부족/3');

j = run('인용·출처 귀속', '한 학자가 "하늘의 뜻을 돌에 옮긴 것"이라고 썼다', model('근거 부족', [ev(2, '판단 불충분', '1395년(태조 4)에 만든')], { fix: { kind: '축소안', instruction: '인용을 뺀다', source_no: 0 } }));
expect('판단에 쓸 근거가 하나도 없으면 축소안을 두지 않는다', `${j.verdict}/${j.fix.kind}`, '근거 부족/없음');
j = run('최상급', '각석은 세계에서 가장 오래된 천문도다', model('해석 주의', [ev(2, '반박', '세계에서 두 번째로 오래된')], { fix: { kind: '축소안', instruction: "'세계에서 가장'을 뺀다", source_no: 0 } }));
expect('확인한 근거가 있으면 축소안을 둔다', `${j.verdict}/${j.fix.kind}`, '해석 주의/축소안');
j = run(
  '최상급',
  '각석은 세계에서 가장 오래된 천문도다',
  model('해석 주의', [ev(2, '판단 불충분', '1395년(태조 4)에 만든', { scope: '적용 불가' })], {
    qualifiers: [{ text: '가장', result: '출처와 다르다', note: '' }],
    fix: { kind: '축소안', instruction: "'세계에서 가장'을 뺀다", source_no: 0 },
  }),
);
expect('같은 대상의 근거가 있고 한정 표현이 출처와 맞지 않으면 축소안을 둔다', `${j.verdict}/${j.fix.kind}`, '해석 주의/축소안');

console.log('\n[반박 근거가 한 곳뿐인 불일치]');
const made = '각석은 1396년에 만들었다';
const refuting = (nos, over = {}) => run('연대·인명·기관명', made, model('불일치', nos.map((no) => ev(no, '반박', Q[no])), over));
j = refuting([2]);
expect('2등급 자료 한 곳만 원고와 다르게 적었으면 불일치로 두되 표시를 붙인다', `${j.verdict}/${j.flags.join()}`, `불일치/${SINGLE_REFUTER_FLAG}`);
j = refuting([2, 10]);
expect('서로 다른 곳이 낸 2등급 둘이 반박하면 표시를 붙이지 않는다', `${j.verdict}/${j.flags.join()}`, '불일치/');
j = refuting([2, 9]);
expect('같은 기관의 글 둘은 한 곳으로 센다', `${j.verdict}/${j.flags.join()}`, `불일치/${SINGLE_REFUTER_FLAG}`);
j = refuting([2, 13]);
expect('옮겨 적은 글 둘도 한 곳으로 센다', `${j.verdict}/${j.flags.join()}`, `불일치/${SINGLE_REFUTER_FLAG}`);
j = run('제원·실측', wrongSize, model('불일치', [ev(1, '반박', '세로: 211㎝')]));
expect('1등급 자료가 반박하면 한 곳이어도 표시를 붙이지 않는다', `${j.verdict}/${j.flags.join()}`, '불일치/');

console.log('\n[셈이 필요한 명제의 불일치]');
// 출처 2는 책을 찍은 해와 "78년 앞선다"를 적었고, 출처 10은 두 가지로 읽히는 문장을 적었다(1378년이 입적한 해인지 찍은 해인지)
const years = {
  ...bundleOf([]),
  evidence: [
    { no: 2, sourceNo: 2, text: '이 책은 1377년에 금속활자로 찍었다. 서양의 첫 활자본보다 78년이나 앞선 것이다.' },
    { no: 10, sourceNo: 10, text: '1378년 스님이 입적한 절에서 목판으로 찍은 책이다. 금속활자본은 1377년에 찍었다.' },
  ],
};
const relativeCase = (statement, evidence, fix) =>
  applyRules({ claim: { statement, type: '연대·인명·기관명', lead: false }, bundle: years, model: model('불일치', evidence, { fix }), sentenceKey: 'k' });
j = relativeCase('이 책은 서양의 첫 활자본보다 87년 앞선다', [ev(2, '반박', '78년이나 앞선 것이다')], { kind: '교정안', instruction: '87년을 78년으로 고친다', source_no: 0 });
expect('출처가 다른 값을 직접 적었으면 불일치와 교정안을 둔다(78년)', `${j.verdict}/${j.fix.kind}`, '불일치/교정안');
j = relativeCase('금속활자본은 스님이 세상을 떠난 지 3년 뒤에 나왔다', [ev(10, '반박', '금속활자본은 1377년에 찍었다')], {
  kind: '교정안',
  instruction: "'세상을 떠난 지 3년 뒤'를 '세상을 떠나기 1년 전'으로 고친다",
  source_no: 0,
});
expect('모델이 셈해서 얻은 값(1년)은 출처에 없으므로 불일치로 받지 않는다', `${j.verdict}/${j.lowered?.rule}/${j.fix.kind}`, '근거 부족/5번/없음');
expect('  바꾼 까닭에 셈이 필요한 명제라고 적는다', j.lowered?.note.includes('셈을 해야 하는 명제'), true);
j = relativeCase('금속활자본은 스님이 세상을 떠난 지 3년 뒤에 나왔다', [ev(10, '반박', '금속활자본은 1377년에 찍었다')], { kind: '없음', instruction: '', source_no: 0 });
expect('교정안이 없는 불일치도 셈이 필요한 명제면 받지 않는다', j.verdict, '근거 부족');
j = relativeCase('이 책은 1387년에 금속활자로 찍었다', [ev(2, '반박', '이 책은 1377년에 금속활자로 찍었다')], { kind: '교정안', instruction: '1387년을 1377년으로 고친다', source_no: 0 });
expect('연도를 그대로 적은 명제는 셈이 필요한 명제가 아니다(전과 같이 불일치)', `${j.verdict}/${j.fix.kind}`, '불일치/교정안');
j = relativeCase('전시는 1996년 전라북도에서 열렸다', [ev(2, '반박', '이 책은 1377년에 금속활자로 찍었다')], { kind: '교정안', instruction: '1996년을 1997년으로 고친다', source_no: 0 });
expect("  '1996년 전라북도'의 '전'은 셈하는 말로 보지 않는다", j.verdict, '불일치');
j = relativeCase('관람객이 지난해의 2배로 늘었다', [ev(2, '반박', '78년이나 앞선 것이다')], { kind: '교정안', instruction: '2배를 3배로 고친다', source_no: 0 });
expect('배수도 바꿔 넣을 값이 출처에 그대로 있어야 한다', j.verdict, '근거 부족');

console.log('\n[인용문의 근거 번호 바로잡기]');
// 같은 출처(1번)의 발췌가 둘이다: 근거 1은 크기, 근거 7은 관람 시간
const twoExcerpts = {
  ...bundleOf([]),
  evidence: [
    { no: 1, sourceNo: 1, text: '크기(cm)\n세로: 211㎝, 가로: 123㎝' },
    { no: 7, sourceNo: 1, text: '관람 시간 | 09:30 ~ 17:30' },
    { no: 4, sourceNo: 4, text: TEXTS[4] },
  ],
};
const official = [{ source_no: 1, doc_type: '기관의 공식 안내', publisher: '국립고궁박물관', own_fact: true }];
const hours = { statement: '박물관은 09:30부터 17:30까지 문을 연다', type: '운영 정보', lead: false };
j = applyRules({ claim: hours, bundle: twoExcerpts, model: { ...model('일치', [ev(1, '지지', '09:30 ~ 17:30')]), sources: official }, sentenceKey: 'k' });
expect('같은 출처의 다른 발췌에 있는 구절이면 근거 번호를 바로잡고 쓴다', `${j.verdict}/${j.evidence[0].evidenceNo}/${j.evidence[0].correctedFrom}`, '일치/7/1');
expect('  바로잡은 근거는 인용문이 있는 것으로 본다', j.evidence[0].quoteFound, true);
j = applyRules({ claim: hours, bundle: twoExcerpts, model: { ...model('일치', [ev(1, '지지', '오전 10시부터 오후 6시까지')]), sources: official }, sentenceKey: 'k' });
expect('다른 출처의 발췌에만 있는 구절은 바로잡지 않는다', `${j.verdict}/${j.lowered?.rule}/${j.evidence[0].evidenceNo}`, '근거 부족/1번/1');
j = applyRules({
  claim: hours,
  bundle: twoExcerpts,
  model: { ...model('일치', [ev(7, '지지', '09:30 ~ 17:30'), ev(1, '지지', '관람 시간')]), sources: official },
  sentenceKey: 'k',
});
expect('바로잡을 번호가 이미 쓰였으면 그대로 두고 인용문 없음으로 남긴다', j.evidence.map((u) => `${u.evidenceNo}:${u.quoteFound}`).join(), '7:true,1:false');
j = applyRules({ claim: hours, bundle: twoExcerpts, model: { ...model('일치', [ev(7, '지지', '09:30 ~ 17:30')]), sources: official }, sentenceKey: 'k' });
expect('번호가 맞으면 바로잡은 기록을 남기지 않는다', j.evidence[0].correctedFrom, undefined);

console.log(failed ? `\n실패 ${failed}건` : '\n모두 통과');
process.exit(failed ? 1 : 0);
