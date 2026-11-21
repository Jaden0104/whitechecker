// 내보내기(F11)가 기대대로 동작하는지 확인한다. Liner도 서버도 부르지 않는다.
// 흉내 낸 서버로 실행을 한 번 돌린 뒤, 편집자의 선택을 바꿔 가며 수정 원고와 검토 기록을 만들어 본다.
// 사용: node tools/check_export.mjs
import { fileBase, planExport, reviewRecordJson, reviewRecordMarkdown } from '../lib/client/export.ts';
import { createRechecker } from '../lib/run/recheck.ts';
import { applyReview } from '../lib/run/review.ts';
import { createRunner } from '../lib/run/runner.ts';
import { NO_FIX, makeApi, makeStore } from './fake_api.mjs';

let failed = 0;
function expect(label, actual, wanted) {
  const a = typeof actual === 'string' ? actual : JSON.stringify(actual);
  const w = typeof wanted === 'string' ? wanted : JSON.stringify(wanted);
  const ok = a === w;
  if (!ok) failed += 1;
  console.log(`${ok ? '통과' : '실패'}  ${label}${ok ? '' : `\n      기대 ${w}\n      실제 ${a}`}`);
}

// 문장 3과 7은 글자까지 같은 문장이다. 문장 4에는 링크가, 문장 6에는 굵은 글씨가 들어 있다
const TEXT = [
  '# 돌에 새긴 하늘',
  '',
  '돌의 크기는 세로 311cm, 가로 223cm입니다. 이 각석은 세계에서 가장 오래된 천문도입니다.',
  '',
  '- 각석은 [국립중앙박물관](https://example.org/)이 소장하고 있습니다.',
  '- 관람료는 무료입니다.',
  '',
  '지금은 서울의 **국립중앙박물관**에 있습니다. 이 각석은 세계에서 가장 오래된 천문도입니다. 구독자는 3만 명입니다.',
  '',
].join('\n');

const api = makeApi({
  claimsFor: (s) => {
    if (s.includes('세로')) return [{ statement: '각석의 크기는 세로 311cm입니다.', type: '제원·실측' }, { statement: '각석의 크기는 가로 223cm입니다.', type: '제원·실측' }];
    if (s.includes('가장 오래된')) return [{ statement: '각석은 세계에서 가장 오래된 천문도입니다.', type: '최상급' }];
    if (s.includes('소장')) return [{ statement: '각석은 국립중앙박물관이 소장하고 있습니다.' }];
    if (s.includes('관람료')) return [{ statement: '관람료는 무료입니다.', type: '운영 정보' }];
    if (s.includes('서울의')) return [{ statement: '각석은 지금 서울의 국립중앙박물관에 있습니다.' }];
    if (s.includes('구독자')) return [{ statement: '구독자는 3만 명입니다.', type: '수치·통계', isPublic: false }];
    return [];
  },
  verdictFor: (st) => (st.includes('관람료') || st.includes('고궁') || st.includes('두 번째') ? '일치' : '불일치'),
  fixFor: (st) => (st.includes('관람료') ? NO_FIX : { kind: '교정안', instruction: '고친다', sourceNo: null }),
  reviseFor: (sentence, fixes) => {
    const ids = fixes.map((f) => f.claimId);
    if (sentence.includes('세로')) {
      return {
        revised: sentence.replace('311cm', '211cm').replace('223cm', '123cm'),
        edits: [{ before: '311cm', after: '211cm', claimIds: [ids[0]] }, { before: '223cm', after: '123cm', claimIds: [ids[1]] }],
      };
    }
    if (sentence.includes('가장 오래된')) return { revised: sentence.replace('가장', '두 번째로'), edits: [{ before: '가장', after: '두 번째로', claimIds: ids }] };
    return { revised: sentence.replace('국립중앙박물관', '국립고궁박물관'), edits: [{ before: '국립중앙박물관', after: '국립고궁박물관', claimIds: ids }] };
  },
});
const store = makeStore();
const runner = createRunner(store, api);
runner.start(TEXT);
await runner.idle();
const base = store.get();
const act = (run, sentenceId, action) => applyReview(run, sentenceId, action, '2026-11-21T10:00:00.000Z').run;
const adopt = (run, ...ids) => ids.reduce((r, id) => act(r, id, { kind: 'adopt' }), run);
const sentenceText = (id) => base.sentences.find((s) => s.id === id).source;

console.log('[준비]');
expect('문장은 여덟 개로 나뉜다', base.sentences.map((s) => s.id), [1, 2, 3, 4, 5, 6, 7, 8]);
expect('같은 문장 둘(3과 7)이 있다', sentenceText(3) === sentenceText(7), true);

console.log('\n[수정 원고]');
let plan = planExport(base);
expect('아무것도 채택하지 않으면 원고는 그대로다', plan.manuscript, TEXT);
expect('  채택하지 않은 수정안으로 센다', plan.held.map((h) => h.sentenceId), [2, 3, 4, 6, 7]);

plan = planExport(adopt(base, 2));
expect('한 문장에 오류가 둘이어도 둘 다 반영된다', plan.manuscript, TEXT.replace('세로 311cm, 가로 223cm', '세로 211cm, 가로 123cm'));

plan = planExport(adopt(base, 7));
const expectedSecond = TEXT.slice(0, TEXT.lastIndexOf('가장')) + '두 번째로' + TEXT.slice(TEXT.lastIndexOf('가장') + 2);
expect('같은 문장이 두 번 나와도 채택한 자리만 바뀐다', plan.manuscript, expectedSecond);
expect('  앞쪽의 같은 문장은 그대로다', plan.manuscript.indexOf('가장 오래된') === TEXT.indexOf('가장 오래된'), true);

plan = planExport(adopt(base, 2, 6, 7));
const expectedAll = TEXT.replace('세로 311cm, 가로 223cm', '세로 211cm, 가로 123cm').replace('**국립중앙박물관**', '**국립고궁박물관**');
expect('여러 문장을 채택해도 서로의 자리가 밀리지 않는다', plan.manuscript, expectedAll.slice(0, expectedAll.lastIndexOf('가장')) + '두 번째로' + expectedAll.slice(expectedAll.lastIndexOf('가장') + 2));
expect('채택하지 않은 부분과 Markdown 구조는 그대로다', [plan.manuscript.startsWith('# 돌에 새긴 하늘\n\n'), plan.manuscript.includes('\n- 각석은 [국립중앙박물관](https://example.org/)이 소장하고 있습니다.\n- 관람료는 무료입니다.\n'), plan.manuscript.includes('**국립고궁박물관**')], [true, true, true]);
expect('원고에 반영한 문장을 알려 준다', plan.applied.map((a) => a.sentenceId), [2, 6, 7]);

console.log('\n[직접 반영할 항목]');
plan = planExport(adopt(base, 4));
expect('링크가 든 문장은 자동으로 바뀌지 않고 직접 반영할 항목에 나온다', [plan.manuscript === TEXT, plan.manual.map((m) => `${m.sentenceId}:${m.why}`)], [true, ['4:링크나 각주가 든 문장입니다']]);

let run = act(base, 6, { kind: 'save', text: '지금은 서울의 국립고궁박물관에 있습니다.' });
plan = planExport(adopt(run, 6));
expect('강조 표시가 달라진 수정안도 직접 반영할 항목으로 돌린다', [plan.manuscript === TEXT, plan.manual.map((m) => m.why)], [true, ['강조 표시가 원문과 달라진 수정안입니다']]);

const shifted = { ...base, sentences: base.sentences.map((s) => (s.id === 2 ? { ...s, start: s.start + 1, end: s.end + 1 } : s)) };
plan = planExport(adopt(shifted, 2));
expect('그 자리의 글자가 기록한 문장과 다르면 바꾸지 않고 알린다', [plan.manuscript === TEXT, plan.manual.length, plan.manual[0].why.includes('달라 바꾸지 않았습니다')], [true, 1, true]);

plan = planExport(adopt({ ...base, manuscript: `${TEXT}덧붙인 글` }, 2));
expect('원고가 검증을 시작할 때와 다르면 수정 원고를 만들지 않는다', [plan.manuscript, plan.problem !== ''], [null, true]);

console.log('\n[남는 것]');
plan = planExport(adopt(base, 2));
expect('채택한 수정안이 고친 명제는 미해결에서 빠진다', plan.open.map((v) => v.entry.claim.id), ['s3-c1', 's4-c1', 's6-c1', 's7-c1']);
expect('직접 확인할 것을 따로 모은다', plan.direct.map((v) => v.entry.claim.id), ['s8-c1']);
expect('끝나지 않은 항목은 없다', plan.unfinished.length, 0);

run = act(base, 2, { kind: 'save', text: '돌의 크기는 세로 211cm, 가로 123cm쯤입니다.' });
run = adopt(run, 2);
plan = planExport(run);
expect('고쳐 쓴 뒤 다시 검증하지 않고 채택한 문장을 알려 준다', [plan.unchecked, plan.applied.map((a) => a.after)], [[2], ['돌의 크기는 세로 211cm, 가로 123cm쯤입니다.']]);
expect('  다시 검증하지 않았으면 미해결로 남긴다', plan.open.filter((v) => v.entry.claim.sentenceId === 2).length, 2);

// 고쳐 쓴 문장을 다시 검증하면(흉내 낸 서버는 211과 123이 든 명제를 내지 않으므로 명제가 달라진다)
const store2 = makeStore();
store2.set(() => run);
const checker = createRechecker(store2, makeApi({ claimsFor: () => [{ statement: '각석의 크기는 세로 211cm쯤입니다.' }], verdictFor: () => '일치' }));
await checker.start(2);
plan = planExport(store2.get());
expect('다시 검증해 모두 일치면 재검증하지 않은 문장에서 빠지고 미해결도 풀린다', [plan.unchecked, plan.open.filter((v) => v.entry.claim.sentenceId === 2).length], [[], 0]);

console.log('\n[검토 기록]');
run = adopt(act(base, 2, { kind: 'save', text: '돌의 크기는 세로 211cm, 가로 123cm쯤입니다.' }), 2, 4, 7);
run = act(run, 3, { kind: 'hold' });
plan = planExport(run);
const md = reviewRecordMarkdown(run, plan, '2026-11-21 19:00');
const has = (text) => md.includes(text);
expect('제목과 요약을 적는다', [has('# 검토 기록: 돌에 새긴 하늘'), has('- 채택한 문장: 3개(원고에 반영 2개, 직접 반영할 항목 1개)'), has('- Liner API 사용: 검색')], [true, true, true]);
expect('문장마다 고치기 전과 고친 뒤, 선택을 적는다', [has('### 문장 2: 채택'), has('- 고치기 전: 돌의 크기는 세로 311cm, 가로 223cm입니다.'), has('- 고친 뒤: 돌의 크기는 세로 211cm, 가로 123cm쯤입니다.'), has('### 문장 3: 보류'), has('### 문장 6: 고르지 않음(보류로 처리)'), has('### 문장 5: 수정안 없음')], [true, true, true, true, true, true]);
expect("고쳐 쓴 뒤 다시 검증하지 않고 채택한 문장에는 그렇게 적는다", has('- 편집자 수정 후 재검증하지 않음'), true);
expect('사실마다 판정, 까닭, 근거의 인용문과 주소, 출처 등급, 확인일을 적는다', [has('  1. [불일치] 각석의 크기는 세로 311cm입니다. → 미해결'), has('     - 까닭: 사유'), has('     - 근거 1(반박): "발췌"'), has('       출처 1: 어느 기관, 1등급, 기관의 공식 안내, https://www.example.go.kr/a'), has('     - 확인일: 2026-11-21')], [true, true, true, true, true]);
expect('채택한 수정안이 고친 명제에는 반영했다고 적는다', has('[불일치] 각석은 세계에서 가장 오래된 천문도입니다. → 채택한 수정안에 반영'), true);
expect('직접 반영할 항목, 직접 확인할 것, 미해결, 끝나지 않은 항목을 붙인다', [has('## 직접 반영할 항목\n\n- 문장 4: 링크나 각주가 든 문장입니다'), has('## 직접 확인할 것\n\n- 문장 8: 구독자는 3만 명입니다.'), has('## 미해결로 남는 내용\n\n- 문장 2 [불일치]'), has('## 끝나지 않은 항목\n\n없음')], [true, true, true, true]);

const json = JSON.parse(JSON.stringify(reviewRecordJson(run, plan, '2026-11-21 19:00')));
expect('JSON 기록의 요약이 같은 수를 적는다', json.요약, { '채택한 문장': 3, '원고에 반영한 문장': 2, '직접 반영할 항목': 1, '채택하지 않은 수정안': 2, '미해결로 남는 내용': plan.open.length, '직접 확인할 것': 1, '끝나지 않은 항목': 0 });
const second = json['문장별 기록'].find((s) => s['문장 번호'] === 2);
expect('JSON 기록에도 문장별로 선택과 사실, 근거를 담는다', [second.선택, second['편집자가 고쳐 씀'], second['편집자 수정 후 재검증하지 않음'], second['확인한 사실'].length, second['확인한 사실'][0].근거[0].출처.주소], ['채택', true, true, 2, 'https://www.example.go.kr/a']);

console.log('\n[파일 이름]');
expect('제목에서 파일 이름에 쓸 수 없는 글자를 뺀다', fileBase('돌에 새긴 하늘: "천문도"/각석?'), '돌에 새긴 하늘 천문도 각석');
expect('제목이 없으면 원고라고 적는다', fileBase('  '), '원고');

console.log(failed ? `\n실패 ${failed}건` : '\n모두 통과');
process.exit(failed ? 1 : 0);
