// 판정 확인: 앞서 모아 둔 근거 묶음(tools/.cache/gather-*.json)을 로컬 서버의 판정 경로에 보내고,
// 명제마다 판정과 그 까닭을 보여 준다. 정답지가 있으면 허용하는 판정, 허용하지 않는 판정과 견준다.
// 서버가 떠 있어야 하고, 근거를 모을 때와 같은 Liner 키를 써야 한다(서명을 그 키로 확인한다).
// 사용: node tools/try_judge.mjs <서버 주소> [원고 파일] [정답지 파일] [--only=s6-c1,s6-c2]
// 접속 코드는 환경 변수 ACCESS_CODE에서 읽는다(화면에 찍지 않는다).
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { LIMITS } from '../lib/limits.ts';
import { totalCost } from '../lib/pricing.ts';
import { splitManuscript } from '../lib/sentences.ts';

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const only = process.argv.find((a) => a.startsWith('--only='))?.slice(7).split(',') ?? null;
const base = args[0] ?? 'http://localhost:3111';
const manuscriptPath = args[1] ?? 'fixtures/small/manuscript.md';
const answersPath = args[2] ?? 'fixtures/small/answers.json';
const headers = { 'Content-Type': 'application/json', 'x-access-code': process.env.ACCESS_CODE ?? '' };

const text = readFileSync(manuscriptPath, 'utf8');
const sentences = splitManuscript(text);
const tag = createHash('sha256').update(text).digest('hex').slice(0, 10);
const gatherFile = `tools/.cache/gather-${tag}.json`;
const judgeFile = `tools/.cache/judge-${tag}.json`;
if (!existsSync(gatherFile)) {
  console.log(`모아 둔 근거가 없다. 먼저 node tools/try_gather.mjs ${base} 를 돌린다`);
  process.exit(1);
}
const rows = JSON.parse(readFileSync(gatherFile, 'utf8')).filter((r) => r.bundle && (!only || only.includes(r.claim.id)));

async function call(body) {
  const res = await fetch(`${base}/api/judge`, { method: 'POST', headers, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

// 제목과 첫 문단의 문장은 편집 우선순위를 '상'으로 올린다
const titleId = sentences.find((s) => s.kind === 'heading')?.id;
const firstParagraph = sentences.find((s) => s.kind === 'paragraph')?.block;
const sentenceOf = (claim) => sentences.find((s) => s.id === claim.sentenceId);
const requestOf = (row) => {
  const sentence = sentenceOf(row.claim);
  return {
    claim: row.claim,
    sentence: sentence?.plain ?? '',
    lead: Boolean(sentence && (sentence.id === titleId || sentence.block === firstParagraph)),
    bundle: row.bundle,
    signature: row.signature,
  };
};

// 0. 서명 검사: 발췌를 고친 묶음과, 다른 명제에 붙인 묶음은 받지 않아야 한다(모델을 부르기 전에 걸러진다)
if (rows.length >= 2 && rows[0].bundle.evidence.length > 0) {
  const edited = structuredClone(requestOf(rows[0]));
  edited.bundle.evidence[0].text += ' (고친 글)';
  const a = await call(edited);
  console.log(`발췌를 고친 묶음: ${a.status === 409 ? '거부됨(409)' : `거부되지 않음(${a.status})`}`);
  const swapped = { ...requestOf(rows[0]), claim: rows[1].claim };
  const b = await call(swapped);
  console.log(`다른 명제에 붙인 묶음: ${b.status === 409 ? '거부됨(409)' : `거부되지 않음(${b.status})`}`);
}

// 1. 판정: 동시에 5개씩
const results = new Map();
const t0 = performance.now();
let next = 0;
async function worker() {
  while (next < rows.length) {
    const row = rows[next];
    next += 1;
    const started = performance.now();
    const r = await call(requestOf(row));
    results.set(row.claim.id, { ...r, seconds: (performance.now() - started) / 1000 });
  }
}
await Promise.all(Array.from({ length: LIMITS.concurrency }, worker));
const elapsed = (performance.now() - t0) / 1000;

// 2. 정답지와 잇기(확인용 어림): 같은 문장의 정답 가운데 낱말이 가장 많이 겹치는 것
const answers = existsSync(answersPath) ? JSON.parse(readFileSync(answersPath, 'utf8')).명제 : [];
const words = (s) => new Set((s.match(/[가-힣]{2,}|\d+/g) ?? []).map((w) => (/\d/.test(w) ? w : w.slice(0, 2))));
function answerFor(claim) {
  const sentence = sentenceOf(claim);
  if (!sentence) return null;
  const order = sentences.filter((s) => s.source === sentence.source && s.id <= sentence.id).length;
  const pool = answers.filter((a) => a.문장 === sentence.source && a['나온 순서'] === order);
  const mine = words(claim.statement);
  let best = null;
  let bestScore = -1;
  for (const a of pool) {
    const score = [...words(a.내용)].filter((w) => mine.has(w)).length;
    if (score > bestScore) {
      best = a;
      bestScore = score;
    }
  }
  return best;
}

const tally = { 허용: 0, '허용 밖': 0, 불허: 0, 실패: 0 };
const usage = [];
let quotes = 0;
let quotesFound = 0;
let changed = 0;
for (const row of rows) {
  const { claim } = row;
  const r = results.get(claim.id);
  console.log(`\n■ ${claim.id} (${claim.type}) ${claim.statement}`);
  if (!r.ok) {
    tally.실패 += 1;
    console.log(`   실패(${r.status}): ${r.data.error ?? ''} ${r.data.reason ?? ''}`);
    continue;
  }
  const j = r.data.judgment;
  usage.push(...r.data.usage);
  if (j.lowered) changed += 1;
  const moved = j.lowered ? ` ← 모델은 '${j.modelVerdict}', ${j.lowered.rule} 규칙: ${j.lowered.note}` : '';
  console.log(`   판정: ${j.verdict}${moved}`);
  console.log(`   우선순위 ${j.priority ?? '-'}${j.needChoice ? ', 선택 필요' : ''}${j.flags.length ? ` | 표시: ${j.flags.join(', ')}` : ''} | ${r.seconds.toFixed(1)}초`);
  console.log(`   까닭: ${j.reason}`);
  for (const s of j.sources) {
    const info = row.bundle.sources.find((x) => x.no === s.sourceNo);
    console.log(`   출처${s.sourceNo} ${s.grade}등급 | ${s.docType}${s.ownFact ? '(직접 정하는 사실)' : ''} | ${s.publisher || '-'} | ${info?.hostname ?? ''}`);
  }
  for (const l of j.links) console.log(`   출처${l.a}·${l.b}: ${l.status} (${l.reason})`);
  for (const e of j.evidence) {
    quotes += 1;
    if (e.quoteFound) quotesFound += 1;
    const fit = [e.target, e.scope, e.time].every((v) => v === '적용 가능') ? '적용 가능' : `대상 ${e.target}·범위 ${e.scope}·시점 ${e.time}`;
    console.log(`   근거${e.evidenceNo}(출처${e.sourceNo}) ${e.relation} | ${fit} | ${e.quoteFound ? '' : '인용문 없음! '}"${e.quote.slice(0, 70)}"`);
  }
  for (const q of j.qualifiers) console.log(`   한정 표현 '${q.text}': ${q.result}${q.note ? ` (${q.note})` : ''}`);
  if (j.conflict.found) console.log(`   엇갈림: 지지 ${j.conflict.supportTop}등급, 반박 ${j.conflict.refuteTop}등급${j.conflict.resolved ? ', 바로잡은 자료로 풀림' : ''}`);
  if (j.fix.kind !== '없음') console.log(`   고칠 내용[${j.fix.kind}]: ${j.fix.instruction}${j.fix.sourceNo ? ` (출처${j.fix.sourceNo})` : ''}`);
  if (j.action) console.log(`   권고: ${j.action}`);

  const answer = answerFor(claim);
  if (answer) {
    const grade = answer.허용.includes(j.verdict) ? '허용' : answer.불허.includes(j.verdict) ? '불허' : '허용 밖';
    tally[grade] += 1;
    console.log(`   정답지 ${answer.id}: ${grade} (허용 ${answer.허용.join('·')} / 불허 ${answer.불허.join('·')})`);
  }
}

const fresh = rows.map((r) => ({ claim: r.claim, ...(results.get(r.claim.id)?.data ?? {}) }));
if (!only) {
  writeFileSync(judgeFile, JSON.stringify(fresh, null, 2), 'utf8');
} else if (existsSync(judgeFile)) {
  // 고른 명제만 다시 판정했으면, 저장해 둔 결과에서 그 명제의 것만 바꾼다
  const kept = JSON.parse(readFileSync(judgeFile, 'utf8'));
  for (const row of fresh) {
    const at = kept.findIndex((k) => k.claim.id === row.claim.id);
    if (at >= 0) kept[at] = row;
    else kept.push(row);
  }
  writeFileSync(judgeFile, JSON.stringify(kept, null, 2), 'utf8');
  console.log(`\n고른 명제 ${fresh.length}개의 판정만 ${judgeFile}에서 바꿨다`);
}

const tokensIn = usage.reduce((n, u) => n + u.promptTokens, 0);
const tokensOut = usage.reduce((n, u) => n + u.completionTokens, 0);
const tokensCached = usage.reduce((n, u) => n + (u.cachedTokens ?? 0), 0);
const tokensWritten = usage.reduce((n, u) => n + (u.cacheWriteTokens ?? 0), 0);
const cost = totalCost(usage);
// 캐시를 쓰지 않았다면 들었을 값: 캐시에서 읽은 것과 캐시에 쓴 것을 모두 보통 입력으로 친다
const plainCost = totalCost(usage.map((u) => ({ ...u, cachedTokens: 0, cacheWriteTokens: 0 })));
console.log(`\n명제 ${rows.length}개, 전체 ${elapsed.toFixed(1)}초, 모델 ${[...new Set(usage.map((u) => u.model))].join(', ')}, 토큰 입력 ${tokensIn}(캐시에서 읽은 것 ${tokensCached}, 캐시에 쓴 것 ${tokensWritten}) 출력 ${tokensOut}`);
console.log(`추정 비용 ${cost.dollars.toFixed(4)}달러(캐시가 없었다면 ${plainCost.dollars.toFixed(4)}달러), 캐시에서 읽은 호출 ${usage.filter((u) => (u.cachedTokens ?? 0) > 0).length}/${usage.length}`);
console.log(`정답지와 견준 결과: 허용 ${tally.허용}, 허용 밖 ${tally['허용 밖']}, 불허 ${tally.불허}, 실패 ${tally.실패}`);
console.log(`코드가 판정을 바꾼 것 ${changed}건, 인용문이 발췌에 있는 것 ${quotesFound}/${quotes}`);
if (!only) console.log(`판정 결과를 ${judgeFile}에 저장했다`);
