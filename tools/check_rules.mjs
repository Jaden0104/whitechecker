// 판정의 코드 규칙(PRD 5.3절)이 기대대로 동작하는지 확인한다. Liner를 부르지 않는다.
// 모델이 이렇게 답했다고 치고, 코드가 판정을 어떻게 확정하는지를 본다.
// 사용: node tools/check_rules.mjs
import { applyRules, squeezeQuote } from '../lib/judge/rules.ts';

let failed = 0;
function expect(label, actual, wanted) {
  const ok = actual === wanted;
  if (!ok) failed += 1;
  console.log(`${ok ? '통과' : '실패'}  ${label}${ok ? '' : `  (기대 ${wanted}, 실제 ${actual})`}`);
}

// 출처 네 곳: 기관(목록에 있음), 백과, 블로그 플랫폼, 언론
const SOURCES = [
  { no: 1, hostname: 'www.gogung.go.kr', publisherHint: '국립고궁박물관', lowPlatform: false },
  { no: 2, hostname: 'encykorea.aks.ac.kr', publisherHint: '한국학중앙연구원', lowPlatform: false },
  { no: 3, hostname: 'blog.naver.com', publisherHint: '', lowPlatform: true },
  { no: 4, hostname: 'www.example-news.co.kr', publisherHint: '', lowPlatform: false },
  { no: 5, hostname: 'www.another-news.co.kr', publisherHint: '', lowPlatform: false },
  { no: 6, hostname: 'www.kci.go.kr', publisherHint: '', lowPlatform: false },
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
const DOC = { 1: '기관의 공식 안내', 2: '백과사전', 3: '블로그·커뮤니티 글', 4: '언론 보도', 5: '언론 보도', 6: '학술 논문' };
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
expect('2등급 둘이어도 독립의 단서가 없으면 근거 부족', j.verdict, '근거 부족');
j = run('연대·인명·기관명', '각석은 1395년에 만들었다', model('일치', two, { links: [{ a: 2, b: 6, status: '독립 추정', reason: '직접 조사' }] }));
expect('독립 추정인 2등급 둘이면 일치', j.verdict, '일치');
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
j = run('최상급', '각석은 세계에서 가장 오래된 천문도다', model('해석 주의', [ev(3, '지지', '세계에서 가장 오래된 천문도다'), ev(4, '반박', '오전 10시부터')]));
expect('엇갈리는 근거가 모두 3등급이면 근거 부족', j.verdict, '근거 부족');
const fixed = { state: '바로잡은 자료로 풀림', correcting_evidence_no: 1, correcting_quote: '세로: 211㎝, 가로: 123㎝' };
j = run('제원·실측', wrongSize, model('불일치', mixed, { conflict: fixed }));
expect('바로잡은 구절이 발췌에 있고 1등급이면 그쪽을 따른다', `${j.verdict}/${j.conflict.resolved}`, '불일치/true');
j = run('제원·실측', wrongSize, model('불일치', mixed, { conflict: { ...fixed, correcting_quote: '앞서 적은 크기를 바로잡습니다' } }));
expect('바로잡았다는 구절이 발췌에 없으면 해석 주의', j.verdict, '해석 주의');

console.log('\n[수정 방향과 우선순위]');
j = run('최상급', '각석은 세계에서 가장 오래된 천문도다', model('해석 주의', [ev(2, '반박', '세계에서 두 번째로 오래된', { scope: '미확인' })], { fix: { kind: '인용형', instruction: '블로그의 설명임을 밝힌다', source_no: 3 } }));
expect('평가하지 않은 출처를 밝히라는 인용형은 받지 않는다', j.fix.kind, '없음');
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
