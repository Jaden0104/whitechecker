// 수정안 합치기의 코드 쪽(PRD F7)이 기대대로 동작하는지 확인한다. Liner를 부르지 않는다.
// 모델이 바꿀 대목을 이렇게 냈다고 치고, 코드가 문장을 어떻게 만들고 무엇을 알리는지를 본다.
// 사용: node tools/check_merge.mjs
import { acceptPolish, applyEdits, compareRevision, markupSignature, numbersIn, removalOnly, reviewRevision } from '../lib/merge/check.ts';
import { planMerge, unresolvedAfter } from '../lib/merge/plan.ts';
import { settlePolish } from '../lib/merge/polish.ts';
import { buildRevision, withPolish } from '../lib/merge/run.ts';

let failed = 0;
function expect(label, actual, wanted) {
  const a = typeof actual === 'string' ? actual : JSON.stringify(actual);
  const w = typeof wanted === 'string' ? wanted : JSON.stringify(wanted);
  const ok = a === w;
  if (!ok) failed += 1;
  console.log(`${ok ? '통과' : '실패'}  ${label}${ok ? '' : `\n      기대 ${w}\n      실제 ${a}`}`);
}

const fix = (claimId, kind, instruction, sourceName = '') => ({ claimId, statement: '', kind, instruction, sourceName });
const HEDGES = ['알려져 있', '전해진', '라고 한다'];
const FIX1 = ['교정안'];
const FIX2 = ['교정안', '교정안'];

console.log('[대목 바꾸기]');
const size = '돌의 크기는 세로 311cm, 가로 223cm입니다.';
let r = applyEdits(size, { edits: [{ claims: [1], before: '세로 311cm', after: '세로 211cm' }, { claims: [2], before: '가로 223cm', after: '가로 123cm' }], skipped: [] }, FIX2);
expect('한 문장의 오류 둘을 모두 반영한다', r.revised, '돌의 크기는 세로 211cm, 가로 123cm입니다.');
expect('  반영한 번호', r.applied, [1, 2]);

r = applyEdits(size, { edits: [{ claims: [1, 2], before: '세로 311cm, 가로 223cm', after: '세로 211cm, 가로 123cm' }], skipped: [] }, FIX2);
expect('수정 하나로 합쳐 내도 둘 다 반영된 것으로 센다', `${r.revised}/${r.applied.join()}`, '돌의 크기는 세로 211cm, 가로 123cm입니다./1,2');

r = applyEdits(size, { edits: [{ claims: [1], before: '세로 311 cm', after: '세로 211 cm' }], skipped: [] }, FIX1);
expect('바꿀 대목이 원문에 글자 그대로 없으면 반영하지 않는다', `${r.revised}/${r.skipped[0].why}`, 'null/바꿀 대목이 원문에 글자 그대로 있지 않다');

r = applyEdits(size, { edits: [{ claims: [1], before: 'cm', after: 'm' }], skipped: [] }, FIX1);
expect('바꿀 대목이 두 번 나오면 반영하지 않는다', `${r.revised}/${r.skipped[0].why}`, 'null/바꿀 대목이 문장에 두 번 이상 나와 자리를 정할 수 없다');

r = applyEdits(size, { edits: [{ claims: [1], before: '세로 311cm, 가로', after: '세로 211cm, 가로' }, { claims: [2], before: '가로 223cm', after: '가로 123cm' }], skipped: [] }, FIX2);
expect('수정끼리 대목이 겹치면 어느 쪽도 반영하지 않는다', `${r.revised}/${r.skipped.map((s) => s.claim).join()}`, 'null/1,2');

r = applyEdits(size, { edits: [{ claims: [1], before: '세로 311cm', after: '세로 211cm' }], skipped: [{ claim: 2, why: '무엇으로 바꿀지 적혀 있지 않다' }] }, [...FIX2, '교정안']);
expect('반영하지 못한 것은 까닭과 함께 남는다', r.skipped, [
  { claim: 2, why: '무엇으로 바꿀지 적혀 있지 않다' },
  { claim: 3, why: '모델이 반영하지 않았다' },
]);

r = applyEdits(size, { edits: [{ claims: [9], before: '세로 311cm', after: '세로 211cm' }], skipped: [] }, FIX1);
expect('없는 번호를 댄 수정은 받지 않는다', `${r.revised}/${r.skipped[0].why}`, 'null/모델이 반영하지 않았다');

r = applyEdits(size, { edits: [{ claims: [1], before: '세로 311cm', after: '세로 211cm\n(고침)' }], skipped: [] }, FIX1);
expect('바꿔 넣을 글에 줄바꿈이 있으면 받지 않는다', r.revised, null);

console.log('\n[축소안은 빼기만]');
const most = '이 각석은 세계에서 가장 오래된 석각 천문도입니다.';
r = applyEdits(most, { edits: [{ claims: [1], before: '세계에서 가장 오래된 ', after: '' }], skipped: [] }, ['축소안']);
expect('대목을 빼는 수정은 받는다', r.revised, '이 각석은 석각 천문도입니다.');
r = applyEdits(most, { edits: [{ claims: [1], before: '세계에서 가장', after: '' }], skipped: [] }, ['축소안']);
expect('  빼면서 생긴 겹친 공백은 정리한다', r.revised, '이 각석은 오래된 석각 천문도입니다.');
r = applyEdits(most, { edits: [{ claims: [1], before: '세계에서 가장 오래된 석각 천문도입니다', after: '세계에서도 손꼽히는 오래된 천문도입니다' }], skipped: [] }, ['축소안']);
expect('다른 표현으로 바꿔 넣은 축소안은 받지 않는다', `${r.revised}/${r.skipped[0].why}`, 'null/축소안인데 원문에 없던 말을 넣었다');
const quote = '조선의 한 학자는 이 천문도를 두고 "하늘의 뜻을 돌에 옮긴 것"이라고 썼습니다.';
r = applyEdits(quote, { edits: [{ claims: [1], before: quote, after: '이 천문도는 조선 초에 돌에 새겨 만들었습니다.' }], skipped: [] }, ['축소안']);
expect('문장을 통째로 새로 쓴 축소안은 받지 않는다', r.revised, null);
expect('조사를 맞추는 정도는 빼기로 본다', removalOnly('혼천의와 천상열차분야지도가', '혼천의가'), true);
expect('늘어난 글은 빼기가 아니다', removalOnly('가장 오래된', '가장 오래된 축에 드는'), false);
r = applyEdits(most, { edits: [{ claims: [1], before: '세계에서 가장 오래된', after: '세계에서 두 번째로 오래된' }], skipped: [] }, ['교정안']);
expect('교정안은 새 값을 넣을 수 있다', r.revised, '이 각석은 세계에서 두 번째로 오래된 석각 천문도입니다.');

console.log('\n[강조와 링크 표시]');
const bold = '이 각석은 1985년에 국보로 지정됐고, 지금은 서울의 **국립중앙박물관**에 있습니다.';
let rev = buildRevision(
  { sentence: bold, fixes: [fix('s4-c2', '교정안', '국립중앙박물관을 국립고궁박물관으로 고친다')] },
  { edits: [{ claims: [1], before: '국립중앙박물관', after: '국립고궁박물관' }], skipped: [] },
);
expect('굵은 글씨 안의 이름만 바꾸면 표시는 그대로다', `${rev.revised}/${rev.markupKept}`, '이 각석은 1985년에 국보로 지정됐고, 지금은 서울의 **국립고궁박물관**에 있습니다./true');
expect('  달라진 낱말을 알려 준다', `${rev.changes.wordsRemoved.join()}→${rev.changes.wordsAdded.join()}`, '국립중앙박물관→국립고궁박물관');
expect('  숫자는 달라지지 않았고 주의할 것도 없다', `${rev.changes.numbersAdded.length + rev.changes.numbersRemoved.length}/${rev.cautions.length}`, '0/0');
rev = buildRevision(
  { sentence: bold, fixes: [fix('s4-c2', '교정안', '국립중앙박물관을 국립고궁박물관으로 고친다')] },
  { edits: [{ claims: [1], before: '**국립중앙박물관**', after: '국립고궁박물관' }], skipped: [] },
);
expect('표시를 지운 수정안은 표시가 달라졌다고 알린다', `${rev.markupKept}/${rev.cautions.join()}`, 'false/강조나 링크, 각주 표시가 원문과 달라졌다');
expect('링크와 각주 표시도 견준다', markupSignature('각석은 [국립고궁박물관](https://www.gogung.go.kr/)이 소장[^1]하고 있습니다.'), ['[', '](https://www.gogung.go.kr/)', '[^1]']);

console.log('\n[달라진 숫자]');
expect('쉼표와 앞의 0을 덜고 센다', numbersIn('2,000명이 09:30에'), ['2000', '9', '30']);
expect('점으로 이은 날짜는 따로 센다', numbersIn('2007.01.22 발행, 길이 1.5m'), ['2007', '1', '22', '1.5']);
let changes = compareRevision(size, '돌의 크기는 세로 211cm, 가로 123cm입니다.');
expect('빠진 숫자와 들어간 숫자', `${changes.numbersRemoved.join()}→${changes.numbersAdded.join()}`, '311,223→211,123');

const hoursFix = [fix('s9-c1', '교정안', '오전 10시부터 오후 6시까지를 09:30~17:30으로 고친다')];
let review = reviewRevision('박물관은 매일 오전 10시부터 오후 6시까지 문을 엽니다.', '박물관은 매일 오전 9시 30분부터 오후 5시 30분까지 문을 엽니다.', hoursFix, HEDGES);
expect('시각을 적는 방식만 다른 것(17:30과 오후 5시 30분)은 알리지 않는다', review.cautions, []);
const sizeFixes = [fix('a', '교정안', '세로 311cm를 211cm로 고친다'), fix('b', '교정안', '가로 223cm를 123cm로 고친다')];
review = reviewRevision(size, '돌의 크기는 세로 211cm, 가로 122.8cm입니다.', sizeFixes, HEDGES);
expect('고칠 내용에 없는 숫자가 들어가면 알린다', review.cautions, ['고칠 내용에 적히지 않은 숫자가 들어갔다: 122.8']);

console.log('\n[새로 들어간 말]');
review = reviewRevision(size, '돌의 크기는 세로 211cm, 가로 123cm로 꽤 큰 편입니다.', sizeFixes, HEDGES);
expect('고칠 내용에 없는 낱말이 들어가면 알린다', review.cautions, ['고칠 내용에 적히지 않은 낱말이 들어갔다: 편입니다']);
review = reviewRevision(bold, bold.replace('국립중앙박물관', '국립고궁박물관'), [fix('a', '교정안', "'국립중앙박물관'을 '국립고궁박물관'으로 고친다")], HEDGES);
expect('고칠 내용에 적힌 낱말은 알리지 않는다', review.cautions, []);
review = reviewRevision(
  '박물관은 매일 오전 10시부터 오후 6시까지 문을 엽니다.',
  '박물관은 09:30~17:30에 문을 열고, 토요일은 21:00까지 문을 엽니다. 매월 마지막 월요일은 휴관합니다.',
  [fix('a', '교정안', "'매일 오전 10시부터 오후 6시까지'를 '09:30~17:30, 토요일은 21:00까지, 매월 마지막 월요일 휴관'으로 고친다")],
  HEDGES,
);
expect('따옴표 안에 적힌 말의 활용형(휴관합니다)과 원문 낱말을 다시 쓴 것(문을)은 알리지 않는다', review.cautions, ['고칠 내용에 적히지 않은 낱말이 들어갔다: 열고']);
review = reviewRevision(quote, '이 천문도는 "하늘의 뜻을 돌에 옮긴 것"으로 알려져 있습니다.', [fix('a', '축소안', '학자를 뺀다')], HEDGES);
expect('출처 없이 흐리는 말이 들어가면 알린다', review.cautions[0], '출처를 밝히지 않고 흐리는 말이 들어갔다: 알려져 있');
review = reviewRevision(most, '국립고궁박물관의 설명에 따르면 이 각석은 세계에서 두 번째로 오래된 석각 천문도라고 한다.', [fix('a', '인용형', '국립고궁박물관의 설명임을 밝혀 쓴다', '국립고궁박물관')], HEDGES);
expect('출처를 밝힌 인용형에서는 낱말과 흐리는 말을 알리지 않는다', review.cautions, []);

console.log('\n[합칠 때를 정하기]');
const done = (claimId, verdict, kind = '없음', instruction = '') => ({ claimId, statement: claimId, state: '완료', verdict, fix: { kind, instruction, sourceNo: null }, sourceName: '' });
let plan = planMerge([done('c1', '일치'), done('c2', '불일치', '교정안', '국립고궁박물관으로 고친다')]);
expect('끝난 명제에서 고칠 내용만 모은다', `${plan.ready}/${plan.fixes.map((f) => f.claimId).join()}`, 'true/c2');
plan = planMerge([done('c1', '불일치', '교정안', '고친다'), { ...done('c2', null), state: '실패' }]);
expect('실패한 명제가 있으면 기다린다', `${plan.ready}/${plan.fixes.length}`, 'false/0');
plan = planMerge([done('c1', '일치'), done('c2', '근거 부족')]);
expect('고칠 내용이 없으면 합칠 것도 없다', `${plan.ready}/${plan.fixes.length}`, 'true/0');
expect(
  '수정안을 채택해도 남는 명제(근거 부족, 직접 확인, 반영하지 못한 불일치)',
  unresolvedAfter([done('c1', '일치'), done('c2', '불일치', '교정안', '고친다'), done('c3', '근거 부족'), done('c4', '직접 확인'), done('c5', '불일치', '교정안', '고친다')], ['c2']),
  ['c3', 'c4', 'c5'],
);

console.log('\n[수정안 하나로 묶기]');
rev = buildRevision(
  { sentence: size, fixes: [fix('s5-c1', '교정안', '세로 311cm를 211cm로 고친다'), fix('s5-c2', '교정안', '가로 223cm를 123cm로 고친다')] },
  { edits: [{ claims: [1], before: '세로 311cm', after: '세로 211cm' }], skipped: [{ claim: 2, why: '값이 적혀 있지 않다' }] },
);
expect('반영한 명제와 반영하지 못한 명제를 명제 번호로 돌려준다', `${rev.applied.join()}/${rev.skipped.map((s) => `${s.claimId}:${s.why}`).join()}`, 's5-c1/s5-c2:값이 적혀 있지 않다');
expect('  바꾼 대목도 명제 번호와 함께 남긴다', rev.edits, [{ before: '세로 311cm', after: '세로 211cm', claimIds: ['s5-c1'] }]);
rev = buildRevision({ sentence: size, fixes: [] }, { edits: [], skipped: [] });
expect('고칠 내용이 없으면 수정안도 없다', `${rev.revised}/${rev.kinds.length}`, 'null/0');

console.log('\n[다듬기 검사]');
const broken = '박물관은 09:30~17:30(입장 마감 17:00), 토요일과 매월 마지막 수요일은 21:00까지, 매월 마지막 월요일과 명절 당일 휴관 문을 엽니다.';
const insertedHours = ['09:30~17:30(입장 마감 17:00), 토요일과 매월 마지막 수요일은 21:00까지, 매월 마지막 월요일과 명절 당일 휴관'];
const mended = '박물관은 09:30~17:30(입장 마감 17:00)에 문을 열고, 토요일과 매월 마지막 수요일은 21:00까지 엽니다. 매월 마지막 월요일과 명절 당일은 휴관합니다.';
const hoursOriginal = '박물관은 매일 오전 10시부터 오후 6시까지 문을 엽니다.';
const hoursInstruction = "'매일 오전 10시부터 오후 6시까지'를 '09:30~17:30(입장 마감 17:00), 토요일과 매월 마지막 수요일은 21:00까지, 매월 마지막 월요일과 명절 당일 휴관'으로 고친다";
const hoursContext = { original: hoursOriginal, inserted: insertedHours, instructions: [hoursInstruction] };
expect('조사, 어미, 어순만 손본 문장은 받는다', acceptPolish(broken, mended, hoursContext), '');
expect('숫자를 적는 방식을 바꾸면 받지 않는다', acceptPolish(broken, mended.replace('21:00까지', '오후 9시까지'), hoursContext), '다듬으면서 숫자가 달라졌다');
const fixedBold = '이 각석은 1985년에 국보로 지정됐고, 지금은 서울의 **국립고궁박물관**에 있습니다.';
const boldContext = { original: bold, inserted: ['국립고궁박물관'], instructions: ["'국립중앙박물관'을 '국립고궁박물관'으로 고친다"] };
expect('고쳐 넣은 이름을 바꾸면 받지 않는다', acceptPolish(fixedBold, fixedBold.replace('국립고궁박물관', '국립중앙박물관'), boldContext), '다듬으면서 고쳐 넣은 말이 빠졌다: 국립고궁박물관');
expect('강조 표시를 지우면 받지 않는다', acceptPolish(fixedBold, fixedBold.replaceAll('**', ''), boldContext), '다듬으면서 강조나 링크 표시가 달라졌다');
expect(
  '문장을 새로 쓰다시피 하면 받지 않는다',
  acceptPolish(fixedBold, '국보인 이 각석은 현재 서울 종로구에 자리한 **국립고궁박물관**이 보관하며 전시합니다.', boldContext).startsWith('다듬으면서'),
  true,
);
const pagodaContext = { original: '이 탑은 경주에 있으며 높이는 8.2m다.', inserted: ['석탑'], instructions: ["'탑'을 '석탑'으로 고친다"] };
expect('조사만 고친 것은 받는다', acceptPolish('이 석탑는 경주에 있으며 높이는 8.2m다.', '이 석탑은 경주에 있으며 높이는 8.2m다.', pagodaContext), '');

// 합칠 때 모델이 말을 잇느라 지어 넣은 낱말('기준으로')은 원문에도 고칠 내용에도 없다. 다듬으면서 빠져도 된다
const glued = '박물관은 월~금·일요일 오전 9시 30분부터 오후 5시 30분까지(토요일은 오후 9시까지), 매월 마지막 월요일 휴관 기준으로 문을 엽니다.';
const gluedContext = {
  original: hoursOriginal,
  inserted: ['월~금·일요일 오전 9시 30분부터 오후 5시 30분까지(토요일은 오후 9시까지), 매월 마지막 월요일 휴관 기준으로'],
  instructions: ["'매일 오전 10시부터 오후 6시까지'를 '월~금·일요일 오전 9시 30분부터 오후 5시 30분까지(토요일은 오후 9시까지), 매월 마지막 월요일 휴관'으로 고친다"],
};
expect(
  '지어 넣었던 이음말은 다듬으면서 빠져도 된다',
  acceptPolish(glued, '박물관은 월~금·일요일 오전 9시 30분부터 오후 5시 30분까지(토요일은 오후 9시까지) 문을 열며, 매월 마지막 월요일은 휴관합니다.', gluedContext),
  '',
);
expect(
  '고칠 내용에 적혀 있던 말이 빠지면 받지 않는다',
  acceptPolish(glued, '박물관은 월~금·일요일 오전 9시 30분부터 오후 5시 30분까지(토요일은 오후 9시까지) 문을 엽니다.', gluedContext).startsWith('다듬으면서 낱말이 빠졌다'),
  true,
);

let settled = settlePolish(
  { original: size, draft: '돌의 크기는 세로 211cm, 가로 123cm입니다.', inserted: ['세로 211cm, 가로 123cm'], instructions: ['세로 311cm를 211cm로, 가로 223cm를 123cm로 고친다'] },
  { natural: true, problem: '', polished: '돌의 크기는 세로 211cm, 가로 123cm입니다.' },
);
expect('자연스럽다고 하면 그대로 둔다', `${settled.result.state}/${settled.text}`, '고칠 곳 없음/돌의 크기는 세로 211cm, 가로 123cm입니다.');
settled = settlePolish({ ...hoursContext, draft: broken }, { natural: false, problem: "'휴관 문을 엽니다'가 이어지지 않는다", polished: mended });
expect('다듬은 문장을 받아들이면 다듬기 전 문장도 남긴다', `${settled.result.state}/${settled.text === mended}/${settled.result.draft === broken}`, '다듬음/true/true');
settled = settlePolish({ ...hoursContext, draft: broken }, { natural: false, problem: '어색하다', polished: mended.replace('21:00까지', '오후 9시까지') });
expect('받아들일 수 없으면 다듬기 전 문장을 그대로 쓴다', `${settled.result.state}/${settled.text === broken}`, '다듬지 못함/true');

const hoursInput = { sentence: hoursOriginal, fixes: [fix('s12-c1', '교정안', hoursInstruction)] };
rev = buildRevision(hoursInput, { edits: [{ claims: [1], before: '매일 오전 10시부터 오후 6시까지', after: insertedHours[0] }], skipped: [] });
expect('코드가 만든 문장은 다듬기 전 상태다', `${rev.revised === broken}/${rev.polish.state}`, 'true/검사 안 함');
let polishedRev = withPolish(hoursInput, rev, mended, { state: '다듬음', problem: '이어지지 않는다', draft: broken });
expect('다듬은 문장으로 수정안을 바꾸고 달라진 것을 다시 뽑는다', `${polishedRev.revised === mended}/${polishedRev.polish.state}/${polishedRev.changes.wordsAdded.includes('열고')}`, 'true/다듬음/true');
polishedRev = withPolish(hoursInput, rev, broken, { state: '다듬지 못함', problem: '이어지지 않는다', draft: null });
expect('다듬지 못했으면 어색할 수 있다고 알린다', polishedRev.cautions.some((c) => c.startsWith('문장이 어색할 수 있다')), true);

console.log(failed ? `\n실패 ${failed}건` : '\n모두 통과');
process.exit(failed ? 1 : 0);
