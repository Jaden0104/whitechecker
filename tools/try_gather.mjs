// 근거 모으기 확인: 원고에서 뽑은 명제마다 로컬 서버의 근거 모으기 경로를 불러, 무엇을 찾아 열었는지 보여 준다.
// 정답지에 '발췌에 있어야 할 말'이 있으면 모은 발췌에 그 말이 들어 있는지 견준다. 서버가 떠 있어야 한다.
// 사용: node tools/try_gather.mjs <서버 주소> [원고 파일] [정답지 파일] [--fresh] [--only=s6-c1,s6-c2]
// 접속 코드는 환경 변수 ACCESS_CODE에서 읽는다(화면에 찍지 않는다).
// 뽑은 명제와 모은 근거는 tools/.cache에 두어, 다음 단계(판정)를 시험할 때 다시 쓴다. --fresh를 주면 새로 뽑는다.
// --only로 명제를 골라 돌리면 저장해 둔 근거 파일은 건드리지 않는다.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { buildExtractChunks } from '../lib/chunks.ts';
import { LIMITS } from '../lib/limits.ts';
import { splitManuscript } from '../lib/sentences.ts';

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const fresh = process.argv.includes('--fresh');
const only = process.argv.find((a) => a.startsWith('--only='))?.slice(7).split(',') ?? null;
const base = args[0] ?? 'http://localhost:3111';
const manuscriptPath = args[1] ?? 'fixtures/small/manuscript.md';
const answersPath = args[2] ?? 'fixtures/small/answers.json';
const headers = { 'Content-Type': 'application/json', 'x-access-code': process.env.ACCESS_CODE ?? '' };

const text = readFileSync(manuscriptPath, 'utf8');
const sentences = splitManuscript(text);
const tag = createHash('sha256').update(text).digest('hex').slice(0, 10);
mkdirSync('tools/.cache', { recursive: true });
const claimsFile = `tools/.cache/claims-${tag}.json`;
const gatherFile = `tools/.cache/gather-${tag}.json`;

async function call(path, body) {
  const res = await fetch(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

// 1. 명제: 앞서 뽑아 둔 것이 있으면 다시 쓴다
let claims;
if (!fresh && existsSync(claimsFile)) {
  claims = JSON.parse(readFileSync(claimsFile, 'utf8'));
  console.log(`명제 ${claims.length}개(앞서 뽑은 것을 다시 씀)`);
} else {
  claims = [];
  for (const chunk of buildExtractChunks(sentences, LIMITS.extract.inputChars)) {
    const r = await call('/api/extract', chunk);
    if (!r.ok) {
      console.log(`추출 실패(${r.status}): ${r.data.error ?? ''}`);
      process.exit(1);
    }
    claims.push(...r.data.claims);
  }
  writeFileSync(claimsFile, JSON.stringify(claims, null, 2), 'utf8');
  console.log(`명제 ${claims.length}개(새로 뽑음)`);
}

// 2. 근거 모으기: 공개 자료로 확인할 수 있는 명제만, 동시에 5개씩
const targets = claims.filter((c) => c.isPublic && (!only || only.includes(c.id)));
const results = new Map();
const t0 = performance.now();
let next = 0;
async function worker() {
  while (next < targets.length) {
    const claim = targets[next];
    next += 1;
    const started = performance.now();
    const r = await call('/api/gather', { claim });
    results.set(claim.id, { ...r, seconds: (performance.now() - started) / 1000 });
  }
}
await Promise.all(Array.from({ length: LIMITS.concurrency }, worker));
const elapsed = (performance.now() - t0) / 1000;

// 3. 정답지와 잇기: 같은 문장의 정답 가운데 낱말이 가장 많이 겹치는 것을 고른다(확인용 어림이다)
const answers = existsSync(answersPath) ? JSON.parse(readFileSync(answersPath, 'utf8')).명제 : [];
// 조사가 달라도 같은 낱말로 보도록 한글은 앞의 두 글자만, 숫자는 그대로 견준다
const words = (s) => new Set((s.match(/[가-힣]{2,}|\d+/g) ?? []).map((w) => (/\d/.test(w) ? w : w.slice(0, 2))));
function answerFor(claim) {
  const sentence = sentences.find((s) => s.id === claim.sentenceId);
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
const squeeze = (s) => s.replace(/\s+/g, '');

let withEvidence = 0;
let checked = 0;
let found = 0;
const usage = [];
for (const claim of targets) {
  const r = results.get(claim.id);
  console.log(`\n■ ${claim.id} (${claim.type}, 시점 ${claim.asOf}) ${claim.statement}`);
  if (!r.ok) {
    console.log(`   실패(${r.status}): ${r.data.error ?? ''} ${r.data.reason ?? ''}`);
    continue;
  }
  const { bundle } = r.data;
  usage.push(...r.data.usage);
  for (const s of bundle.searches) {
    console.log(`   검색[${s.kind}${s.dateRange ? `, ${s.dateRange}` : ''}] "${s.query}" → ${s.error ? `실패(${s.error})` : `${s.results}건`}`);
  }
  console.log(`   추가 검색: ${bundle.extraSearch.done ? '함' : '안 함'} — ${bundle.extraSearch.reason}`);
  for (const s of bundle.sources.filter((x) => x.fetch.status !== '열지 않음')) {
    const count = bundle.evidence.filter((e) => e.sourceNo === s.no).length;
    const tail = s.fetch.status === '성공' ? `발췌 ${count}개` : s.fetch.reason;
    console.log(`   출처${s.no} [잠정 ${s.provisionalGrade}등급${s.lowPlatform ? ', 낮은 등급 플랫폼' : ''}] ${s.hostname} | ${s.title.slice(0, 40)} | ${s.fetch.status}${tail ? ` (${tail})` : ''}`);
  }
  const chars = bundle.evidence.reduce((n, e) => n + e.text.length, 0);
  console.log(`   발췌 ${bundle.evidence.length}개, ${chars}자, ${r.seconds.toFixed(1)}초`);
  if (bundle.evidence.length) withEvidence += 1;

  const answer = answerFor(claim);
  const must = answer?.['발췌에 있어야 할 말'];
  if (answer && must?.length) {
    const all = squeeze(bundle.evidence.map((e) => e.text).join('\n'));
    // 항목마다 '|'로 나눈 말 가운데 하나만 있으면 된다
    const missing = must.filter((m) => !m.split('|').some((alt) => all.includes(squeeze(alt))));
    checked += 1;
    if (missing.length === 0) found += 1;
    console.log(`   정답지 ${answer.id}: ${missing.length === 0 ? '필요한 말이 발췌에 있음' : `발췌에 없음 → ${missing.join(', ')}`}`);
  } else if (answer) {
    console.log(`   정답지 ${answer.id}: 견줄 말 없음`);
  }
}

if (!only) {
  writeFileSync(
    gatherFile,
    JSON.stringify(targets.map((c) => ({ claim: c, ...(results.get(c.id)?.data ?? {}) })), null, 2),
    'utf8',
  );
}

const searches = usage.reduce((n, u) => n + u.searchCalls, 0);
const withData = usage.filter((u) => u.model === 'search/web+knowledge').length;
const tokensIn = usage.reduce((n, u) => n + u.promptTokens, 0);
const tokensOut = usage.reduce((n, u) => n + u.completionTokens, 0);
const modelCalls = usage.filter((u) => u.searchCalls === 0).length;
console.log(`\n명제 ${targets.length}개 가운데 발췌를 얻은 것 ${withEvidence}개, 전체 ${elapsed.toFixed(1)}초`);
console.log(`검색 ${searches}회(Premium Data 포함 ${withData}회), 모델 호출 ${modelCalls}회(입력 ${tokensIn}, 출력 ${tokensOut}토큰)`);
if (checked) console.log(`정답지의 말이 발췌에 있는 명제: ${found}/${checked}`);
if (!only) console.log(`모은 근거를 ${gatherFile}에 저장했다`);
