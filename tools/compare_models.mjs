// 단계마다 모델을 고르는 방식(비용 우선, 기본=균형, 품질 우선)을 바꿔 가며 같은 입력을 돌려 견준다.
// 어느 단계에 어떤 방식이 값에 견줘 나은지 정하는 데 쓴다. 서버를 거치지 않고 Liner를 직접 부른다.
// 키는 환경 변수에서만 읽고 화면에 찍지 않는다.
// 사용: node --env-file=.env tools/compare_models.mjs <extract|judge|merge> <기본,quality,cost> [--only=s4-c1,s8-c1]
//   extract: 작은 시험 원고에서 명제를 뽑아 정답지의 문장별 명제 수와 견준다
//   judge:   모아 둔 근거 묶음(tools/.cache/gather-*.json)으로 판정해 정답지의 허용·불허와 견준다
//   merge:   저장해 둔 판정 결과(tools/.cache/judge-*.json)의 고칠 내용으로 수정안을 만들어 정답지의 기대와 견준다(다듬기 검사는 뺀다)
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { buildExtractChunks } from '../lib/chunks.ts';
import { applyRules } from '../lib/judge/rules.ts';
import { LIMITS } from '../lib/limits.ts';
import { chatJson, newBudget } from '../lib/liner.ts';
import { citedSourceName, planMerge } from '../lib/merge/plan.ts';
import { buildRevision } from '../lib/merge/run.ts';
import { totalCost } from '../lib/pricing.ts';
import { EXTRACT_SCHEMA, EXTRACT_SYSTEM, extractUserMessage } from '../lib/prompts/extract.ts';
import { JUDGE_SCHEMA, JUDGE_SYSTEM, judgeUserMessage } from '../lib/prompts/judge.ts';
import { MERGE_SCHEMA, MERGE_SYSTEM, mergeUserMessage } from '../lib/prompts/merge.ts';
import { contentId, splitManuscript } from '../lib/sentences.ts';
import { CLAIM_TYPES } from '../lib/types.ts';

const key = process.env.LINER_API_KEY ?? '';
if (!key) {
  console.log('LINER_API_KEY가 없다. node --env-file=.env 로 돌린다');
  process.exit(1);
}
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const only = process.argv.find((a) => a.startsWith('--only='))?.slice(7).split(',') ?? null;
const stage = args[0];
const strategies = (args[1] ?? '기본,quality,cost').split(',');
const manuscriptPath = 'fixtures/small/manuscript.md';
const answersPath = 'fixtures/small/answers.json';

const dollars = (usages) => totalCost(usages).dollars;
const summary = (usages, seconds) => {
  const models = {};
  for (const u of usages) models[u.model] = (models[u.model] ?? 0) + 1;
  const tin = usages.reduce((n, u) => n + u.promptTokens, 0);
  const tout = usages.reduce((n, u) => n + u.completionTokens, 0);
  const named = Object.entries(models).map(([m, n]) => `${m} ${n}회`).join(', ');
  return `모델: ${named || '-'} | 토큰 입력 ${tin} 출력 ${tout} | 약 ${dollars(usages).toFixed(4)}달러 | ${seconds.toFixed(1)}초`;
};
const routingOf = (strategy) => (strategy === '기본' ? undefined : strategy);

const text = readFileSync(manuscriptPath, 'utf8');
const sentences = splitManuscript(text);
const answers = JSON.parse(readFileSync(answersPath, 'utf8')).명제;
const tag = createHash('sha256').update(text).digest('hex').slice(0, 10);
const orderOf = (sentence) => sentences.filter((s) => s.source === sentence.source && s.id <= sentence.id).length;
const answersFor = (sentence) => answers.filter((a) => a.문장 === sentence.source && a['나온 순서'] === orderOf(sentence));

/** 동시에 몇 개씩 돌린다 */
async function pool(items, size, work) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const at = next;
      next += 1;
      out[at] = await work(items[at]).catch((e) => ({ error: e.kind ?? e.message ?? String(e) }));
    }
  }
  await Promise.all(Array.from({ length: size }, worker));
  return out;
}

// ---------- 추출
async function runExtract(strategy) {
  const chunks = buildExtractChunks(sentences);
  const usages = [];
  const claims = [];
  let failed = 0;
  const t0 = performance.now();
  for (const chunk of chunks) {
    try {
      const { value, usage } = await chatJson({
        stage: '추출',
        key,
        system: EXTRACT_SYSTEM,
        user: extractUserMessage(chunk),
        schemaName: 'claims',
        schema: EXTRACT_SCHEMA,
        maxTokens: LIMITS.extract.outputTokens,
        budget: newBudget(),
        routingStrategy: routingOf(strategy),
      });
      usages.push(usage);
      // 서버 경로(app/api/extract)와 같은 조건으로 받는다
      const known = new Set(chunk.sentences.map((s) => s.id));
      for (const raw of value.claims ?? []) {
        if (!known.has(raw.sentence_id) || !CLAIM_TYPES.includes(raw.type) || !raw.statement?.trim()) continue;
        claims.push({ sentenceId: raw.sentence_id, statement: raw.statement.trim(), type: raw.type, isPublic: Boolean(raw.is_public), qualifiers: raw.qualifiers ?? [], asOf: raw.as_of, queries: raw.queries ?? [], counter: raw.counter_query ?? '' });
      }
    } catch (e) {
      failed += 1;
      console.log(`   묶음 실패: ${e.kind ?? e.message}`);
    }
  }
  const seconds = (performance.now() - t0) / 1000;
  let short = 0;
  let extra = 0;
  let privateRight = 0;
  let privateWrong = 0;
  for (const s of sentences) {
    const expected = answersFor(s);
    const got = claims.filter((c) => c.sentenceId === s.id);
    if (got.length < expected.length) short += expected.length - got.length;
    if (got.length > expected.length) extra += got.length - expected.length;
    const shouldBePrivate = expected.some((a) => a.허용?.includes('직접 확인'));
    for (const c of got) {
      if (shouldBePrivate && !c.isPublic) privateRight += 1;
      if (shouldBePrivate !== !c.isPublic) privateWrong += 1;
    }
    const line = got.map((c) => `${c.type}${c.isPublic ? '' : '(직접 확인)'}`).join(' / ');
    console.log(`   [${s.id}] 정답 ${expected.length} / 추출 ${got.length}  ${line}`);
  }
  console.log(`  명제 ${claims.length}개(정답 ${answers.length}개) | 모자란 것 ${short} | 더 뽑은 것 ${extra} | 직접 확인으로 맞게 가린 것 ${privateRight}/2, 잘못 가린 것 ${privateWrong} | 실패한 묶음 ${failed}`);
  console.log(`  ${summary(usages, seconds)}`);
}

// ---------- 판정
const words = (s) => new Set((s.match(/[가-힣]{2,}|\d+/g) ?? []).map((w) => (/\d/.test(w) ? w : w.slice(0, 2))));
function answerFor(claim) {
  const sentence = sentences.find((s) => s.id === claim.sentenceId);
  if (!sentence) return null;
  const mine = words(claim.statement);
  let best = null;
  let bestScore = -1;
  for (const a of answersFor(sentence)) {
    const score = [...words(a.내용)].filter((w) => mine.has(w)).length;
    if (score > bestScore) {
      best = a;
      bestScore = score;
    }
  }
  return best;
}

async function runJudge(strategy) {
  const gatherFile = `tools/.cache/gather-${tag}.json`;
  if (!existsSync(gatherFile)) {
    console.log('모아 둔 근거가 없다');
    return;
  }
  const rows = JSON.parse(readFileSync(gatherFile, 'utf8')).filter((r) => r.bundle && (!only || only.includes(r.claim.id)));
  const titleId = sentences.find((s) => s.kind === 'heading')?.id;
  const firstParagraph = sentences.find((s) => s.kind === 'paragraph')?.block;
  const t0 = performance.now();
  const results = await pool(rows, LIMITS.concurrency, async (row) => {
    const sentence = sentences.find((s) => s.id === row.claim.sentenceId);
    const { value, usage } = await chatJson({
      stage: '판정',
      key,
      system: JUDGE_SYSTEM,
      user: judgeUserMessage({ statement: row.claim.statement, sentence: sentence?.plain ?? '', type: row.claim.type, qualifiers: row.claim.qualifiers, asOf: row.claim.asOf, bundle: row.bundle }),
      schemaName: 'judgment',
      schema: JUDGE_SCHEMA,
      maxTokens: LIMITS.judge.outputTokens,
      budget: newBudget(),
      routingStrategy: routingOf(strategy),
    });
    const lead = Boolean(sentence && (sentence.id === titleId || sentence.block === firstParagraph));
    const judgment = applyRules({ claim: { statement: row.claim.statement, type: row.claim.type, lead }, bundle: row.bundle, model: value, sentenceKey: sentence ? contentId(sentence.plain) : '' });
    return { judgment, usage };
  });
  const seconds = (performance.now() - t0) / 1000;
  const tally = { 허용: 0, '허용 밖': 0, 불허: 0, 실패: 0 };
  let quotes = 0;
  let found = 0;
  let lowered = 0;
  const usages = [];
  rows.forEach((row, i) => {
    const r = results[i];
    if (r.error) {
      tally.실패 += 1;
      console.log(`   ${row.claim.id} 실패: ${r.error}`);
      return;
    }
    usages.push(r.usage);
    const j = r.judgment;
    if (j.lowered) lowered += 1;
    for (const e of j.evidence) {
      quotes += 1;
      if (e.quoteFound) found += 1;
    }
    const a = answerFor(row.claim);
    const grade = !a ? '-' : a.허용.includes(j.verdict) ? '허용' : a.불허.includes(j.verdict) ? '불허' : '허용 밖';
    if (a) tally[grade] += 1;
    const links = j.links.map((l) => `${l.status}(${l.a}·${l.b})`).join(' ');
    const moved = j.lowered ? ` ← 모델은 '${j.modelVerdict}'(${j.lowered.rule})` : '';
    console.log(`   ${row.claim.id} ${j.verdict}${moved} | ${grade} | 고칠 내용 ${j.fix.kind}${j.fix.kind !== '없음' ? `: ${j.fix.instruction.slice(0, 70)}` : ''}${links ? ` | ${links}` : ''} | ${r.usage.model.replace('claude-', '')}`);
  });
  console.log(`  정답지: 허용 ${tally.허용}, 허용 밖 ${tally['허용 밖']}, 불허 ${tally.불허}, 실패 ${tally.실패} | 인용문 ${found}/${quotes} | 코드가 바꾼 판정 ${lowered}건`);
  console.log(`  ${summary(usages, seconds)}`);
}

// ---------- 수정안 합치기(다듬기 검사 제외)
async function runMerge(strategy) {
  const claimsFile = `tools/.cache/claims-${tag}.json`;
  const judgeFile = `tools/.cache/judge-${tag}.json`;
  if (!existsSync(claimsFile) || !existsSync(judgeFile)) {
    console.log('저장해 둔 명제나 판정 결과가 없다');
    return;
  }
  const allClaims = JSON.parse(readFileSync(claimsFile, 'utf8'));
  const judged = new Map(JSON.parse(readFileSync(judgeFile, 'utf8')).map((r) => [r.claim.id, r]));
  const gatherFile = `tools/.cache/gather-${tag}.json`;
  const gathered = new Map((existsSync(gatherFile) ? JSON.parse(readFileSync(gatherFile, 'utf8')) : []).map((r) => [r.claim.id, r]));
  const squeeze = (s) => s.replace(/\s+/g, '');
  const hasAny = (haystack, option) => option.split('|').some((o) => squeeze(haystack).includes(squeeze(o)));
  const usages = [];
  let met = 0;
  let missed = 0;
  let produced = 0;
  const t0 = performance.now();
  for (const sentence of sentences) {
    const linked = allClaims
      .filter((c) => c.sentenceId === sentence.id)
      .map((c) => {
        if (!c.isPublic) return { claimId: c.id, statement: c.statement, state: '완료', verdict: '직접 확인', fix: null, sourceName: '' };
        const j = judged.get(c.id)?.judgment;
        return j
          ? { claimId: c.id, statement: c.statement, state: '완료', verdict: j.verdict, fix: j.fix, sourceName: citedSourceName(j.fix, j.sources, gathered.get(c.id)?.bundle?.sources ?? []) }
          : { claimId: c.id, statement: c.statement, state: '실패', verdict: null, fix: null, sourceName: '' };
      });
    const plan = planMerge(linked);
    if (!plan.ready || plan.fixes.length === 0) continue;
    let revision;
    try {
      const { value, usage } = await chatJson({
        stage: '수정안 합치기',
        key,
        system: MERGE_SYSTEM,
        user: mergeUserMessage(sentence.source, plan.fixes),
        schemaName: 'sentence_edits',
        schema: MERGE_SCHEMA,
        maxTokens: LIMITS.merge.outputTokens,
        budget: newBudget(),
        routingStrategy: routingOf(strategy),
      });
      usages.push(usage);
      revision = buildRevision({ sentence: sentence.source, fixes: plan.fixes }, value);
    } catch (e) {
      console.log(`   [${sentence.id}] 실패: ${e.kind ?? e.message}`);
      continue;
    }
    if (revision.revised) produced += 1;
    const notes = [];
    for (const a of answersFor(sentence)) {
      const must = a['수정안에 있어야 할 말'] ?? [];
      const mustNot = a['수정안에 없어야 할 말'] ?? [];
      const none = a['수정안 없음'] === true;
      if (must.length === 0 && mustNot.length === 0 && !none) continue;
      const got = revision.revised ?? sentence.source;
      const bad = (none && revision.revised) || must.some((m) => !hasAny(got, m)) || mustNot.some((m) => hasAny(got, m));
      if (bad) missed += 1;
      else met += 1;
      notes.push(`${a.id} ${bad ? '어긋남' : '기대대로'}`);
    }
    const skipped = revision.skipped.map((s) => `${s.claimId}: ${s.why}`).join(' / ');
    console.log(`   [${sentence.id}] ${revision.revised ?? '(수정안 없음)'}`);
    console.log(`        ${notes.join(', ') || '-'}${revision.cautions.length ? ` | 주의: ${revision.cautions.join(' / ')}` : ''}${skipped ? ` | 반영 못 함: ${skipped.slice(0, 120)}` : ''}`);
  }
  const seconds = (performance.now() - t0) / 1000;
  console.log(`  수정안 ${produced}개 | 정답지의 기대: 충족 ${met}, 어긋남 ${missed}`);
  console.log(`  ${summary(usages, seconds)}`);
}

const RUN = { extract: runExtract, judge: runJudge, merge: runMerge };
if (!RUN[stage]) {
  console.log('단계는 extract, judge, merge 가운데 하나');
  process.exit(1);
}
for (const strategy of strategies) {
  console.log(`\n===== ${stage} | 모델 고르는 방식: ${strategy}`);
  await RUN[stage](strategy);
}
