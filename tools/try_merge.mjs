// 수정안 합치기 확인: 앞서 저장해 둔 판정 결과(tools/.cache/judge-*.json)에서 문장마다 고칠 내용을 모아
// 로컬 서버의 수정안 합치기 경로에 보내고, 문장의 수정안과 달라진 것을 보여 준다.
// 정답지에 '수정안에 있어야 할 말', '수정안에 없어야 할 말'이 있으면 그것과 견준다.
// 서버가 떠 있어야 한다. 사용: node tools/try_merge.mjs <서버 주소> [원고 파일] [정답지 파일]
// 접속 코드는 환경 변수 ACCESS_CODE에서 읽는다(화면에 찍지 않는다).
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { citedSourceName, planMerge, unresolvedAfter } from '../lib/merge/plan.ts';
import { totalCost } from '../lib/pricing.ts';
import { splitManuscript } from '../lib/sentences.ts';

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const base = args[0] ?? 'http://localhost:3111';
const manuscriptPath = args[1] ?? 'fixtures/small/manuscript.md';
const answersPath = args[2] ?? 'fixtures/small/answers.json';
const headers = { 'Content-Type': 'application/json', 'x-access-code': process.env.ACCESS_CODE ?? '' };

const text = readFileSync(manuscriptPath, 'utf8');
const sentences = splitManuscript(text);
const tag = createHash('sha256').update(text).digest('hex').slice(0, 10);
const claimsFile = `tools/.cache/claims-${tag}.json`;
const gatherFile = `tools/.cache/gather-${tag}.json`;
const judgeFile = `tools/.cache/judge-${tag}.json`;
const mergeFile = `tools/.cache/merge-${tag}.json`;
for (const file of [claimsFile, gatherFile, judgeFile]) {
  if (!existsSync(file)) {
    console.log(`${file}이 없다. try_extract, try_gather, try_judge를 먼저 돌린다`);
    process.exit(1);
  }
}
const claims = JSON.parse(readFileSync(claimsFile, 'utf8'));
const allClaims = Array.isArray(claims) ? claims : claims.claims;
const gathered = new Map(JSON.parse(readFileSync(gatherFile, 'utf8')).map((r) => [r.claim.id, r]));
const judged = new Map(JSON.parse(readFileSync(judgeFile, 'utf8')).map((r) => [r.claim.id, r]));
const answers = existsSync(answersPath) ? JSON.parse(readFileSync(answersPath, 'utf8')).명제 : [];

/** 인용형에서 밝힐 출처의 이름: 실제로 열어 보고 등급을 매긴 출처의 이름(화면도 같은 함수를 쓴다) */
function sourceNameOf(claimId, fix) {
  return citedSourceName(fix, judged.get(claimId)?.judgment?.sources ?? [], gathered.get(claimId)?.bundle?.sources ?? []);
}

/** 문장에 연결된 명제의 상태. 화면이 하게 될 일을 여기서 흉내 낸다 */
function claimsOf(sentence) {
  return allClaims
    .filter((c) => c.sentenceId === sentence.id)
    .map((c) => {
      if (!c.isPublic) return { claimId: c.id, statement: c.statement, state: '완료', verdict: '직접 확인', fix: null, sourceName: '' };
      const j = judged.get(c.id)?.judgment;
      if (!j) return { claimId: c.id, statement: c.statement, state: '실패', verdict: null, fix: null, sourceName: '' };
      return { claimId: c.id, statement: c.statement, state: '완료', verdict: j.verdict, fix: j.fix, sourceName: sourceNameOf(c.id, j.fix) };
    });
}

const squeeze = (s) => s.replace(/\s+/g, '');
const hasAny = (haystack, option) => option.split('|').some((o) => squeeze(haystack).includes(squeeze(o)));

const usage = [];
const saved = [];
const tally = { 수정안: 0, '기다림': 0, '합칠 것 없음': 0, 실패: 0, '기대 충족': 0, '기대 어긋남': 0 };

/** 정답지의 기대와 견준다: 같은 문장, 같은 순서의 정답 항목에 적힌 말. 수정안이 없으면 원문 문장과 견준다 */
function checkAnswers(sentence, revised) {
  const order = sentences.filter((s) => s.source === sentence.source && s.id <= sentence.id).length;
  for (const a of answers.filter((x) => x.문장 === sentence.source && x['나온 순서'] === order)) {
    const must = a['수정안에 있어야 할 말'] ?? [];
    const mustNot = a['수정안에 없어야 할 말'] ?? [];
    const none = a['수정안 없음'] === true;
    if (must.length === 0 && mustNot.length === 0 && !none) continue;
    const got = revised ?? sentence.source;
    const problems = [];
    if (none && revised) problems.push('수정안이 나오면 안 되는데 나왔다');
    const missing = must.filter((m) => !hasAny(got, m));
    const present = mustNot.filter((m) => hasAny(got, m));
    if (missing.length) problems.push(`없음: ${missing.join(', ')}`);
    if (present.length) problems.push(`남아 있음: ${present.join(', ')}`);
    tally[problems.length ? '기대 어긋남' : '기대 충족'] += 1;
    console.log(`   정답지 ${a.id}: ${problems.length ? `어긋남 (${problems.join(' / ')})` : '기대대로'}`);
  }
}

const t0 = performance.now();
for (const sentence of sentences) {
  const linked = claimsOf(sentence);
  if (linked.length === 0) continue;
  const plan = planMerge(linked);
  const verdicts = linked.map((c) => `${c.claimId} ${c.verdict ?? c.state}`).join(', ');
  console.log(`\n■ 문장 ${sentence.id} (${sentence.kind}${sentence.autoApply ? '' : ', 직접 반영할 항목'}) ${verdicts}`);
  console.log(`   원문: ${sentence.source}`);
  if (!plan.ready) {
    tally['기다림'] += 1;
    console.log('   끝나지 않은 명제가 있어 수정안을 만들지 않는다');
    continue;
  }
  if (plan.fixes.length === 0) {
    tally['합칠 것 없음'] += 1;
    const left = unresolvedAfter(linked, []);
    console.log(`   고칠 내용이 없다${left.length ? `. 미해결로 남는 명제: ${left.join(', ')}` : ''}`);
    saved.push({ sentenceId: sentence.id, revision: null, unresolved: left });
    checkAnswers(sentence, null);
    continue;
  }
  for (const f of plan.fixes) console.log(`   고칠 내용[${f.kind}] ${f.claimId}: ${f.instruction}${f.sourceName ? ` (밝힐 출처: ${f.sourceName})` : ''}`);

  const started = performance.now();
  const res = await fetch(`${base}/api/merge`, { method: 'POST', headers, body: JSON.stringify({ sentence: sentence.source, fixes: plan.fixes }) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    tally.실패 += 1;
    console.log(`   실패(${res.status}): ${data.error ?? ''} ${data.reason ?? ''}`);
    continue;
  }
  const rev = data.revision;
  usage.push(...data.usage);
  tally.수정안 += rev.revised ? 1 : 0;
  console.log(`   수정안: ${rev.revised ?? '(없음)'}  | ${((performance.now() - started) / 1000).toFixed(1)}초`);
  for (const e of rev.edits) console.log(`   바꾼 대목 [${e.claimIds.join(', ')}]: "${e.before}" → "${e.after}"`);
  const c = rev.changes;
  if (c.numbersRemoved.length || c.numbersAdded.length) console.log(`   달라진 숫자: ${c.numbersRemoved.join(', ') || '-'} → ${c.numbersAdded.join(', ') || '-'}`);
  if (c.wordsRemoved.length || c.wordsAdded.length) console.log(`   달라진 낱말: ${c.wordsRemoved.join(' ') || '-'} → ${c.wordsAdded.join(' ') || '-'}`);
  console.log(`   종류: ${rev.kinds.join(', ') || '-'} | 표시 유지: ${rev.markupKept ? '예' : '아니오'}${rev.cautions.length ? ` | 주의: ${rev.cautions.join(' / ')}` : ''}`);
  console.log(`   다듬기 검사: ${rev.polish.state}${rev.polish.problem ? ` (${rev.polish.problem})` : ''}${rev.polish.draft ? ` | 다듬기 전: ${rev.polish.draft}` : ''}`);
  for (const s of rev.skipped) console.log(`   반영하지 못함 ${s.claimId}: ${s.why}`);
  const left = unresolvedAfter(linked, rev.applied);
  if (left.length) console.log(`   채택해도 미해결로 남는 명제: ${left.join(', ')}`);
  saved.push({ sentenceId: sentence.id, revision: rev, unresolved: left });
  checkAnswers(sentence, rev.revised);
}

writeFileSync(mergeFile, JSON.stringify(saved, null, 2), 'utf8');
const tokensIn = usage.reduce((n, u) => n + u.promptTokens, 0);
const tokensOut = usage.reduce((n, u) => n + u.completionTokens, 0);
const tokensCached = usage.reduce((n, u) => n + (u.cachedTokens ?? 0), 0);
const tokensWritten = usage.reduce((n, u) => n + (u.cacheWriteTokens ?? 0), 0);
const cost = totalCost(usage);
const plainCost = totalCost(usage.map((u) => ({ ...u, cachedTokens: 0, cacheWriteTokens: 0 })));
console.log(`\n수정안 ${tally.수정안}개, 합칠 것 없는 문장 ${tally['합칠 것 없음']}개, 기다린 문장 ${tally['기다림']}개, 실패 ${tally.실패}개`);
console.log(`정답지의 기대: 충족 ${tally['기대 충족']}, 어긋남 ${tally['기대 어긋남']}`);
console.log(`모델 호출 ${usage.length}회(${[...new Set(usage.map((u) => u.model))].join(', ') || '-'}), 토큰 입력 ${tokensIn}(캐시에서 읽은 것 ${tokensCached}, 캐시에 쓴 것 ${tokensWritten}) 출력 ${tokensOut}, 전체 ${((performance.now() - t0) / 1000).toFixed(1)}초`);
console.log(`추정 비용 ${cost.dollars.toFixed(4)}달러(캐시가 없었다면 ${plainCost.dollars.toFixed(4)}달러)`);
console.log(`결과를 ${mergeFile}에 저장했다`);
