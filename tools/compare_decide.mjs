// 추가 검색 판단 단계에 어떤 모델이 맞는지 견준다.
// 1. 작은 시험 원고의 공개 명제마다 근거 모으기를 실제로 한 번 돌리면서, 추가 검색 판단에 들어간 입력을 그대로 받아 둔다
// 2. 받아 둔 같은 입력을 모델 고르는 방식(비용 우선, 기본, 품질 우선)별로 다시 물어, 판단이 어떻게 다른지 본다
// 서버를 거치지 않고 Liner를 직접 부른다. 키는 환경 변수에서만 읽고 화면에 찍지 않는다.
// 사용: node --env-file=.env tools/compare_decide.mjs [cost,기본,quality]
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { gatherEvidence } from '../lib/gather/run.ts';
import { LIMITS } from '../lib/limits.ts';
import { chatJson, newBudget } from '../lib/liner.ts';
import { usageCost } from '../lib/pricing.ts';
import { MORE_SEARCH_SCHEMA, MORE_SEARCH_SYSTEM } from '../lib/prompts/more-search.ts';

const key = process.env.LINER_API_KEY ?? '';
if (!key) {
  console.log('LINER_API_KEY가 없다. node --env-file=.env 로 돌린다');
  process.exit(1);
}
const strategies = (process.argv[2] ?? 'cost,기본,quality').split(',');
const dollars = (u) => usageCost(u).dollars;

const text = readFileSync('fixtures/small/manuscript.md', 'utf8');
const tag = createHash('sha256').update(text).digest('hex').slice(0, 10);
const claimsFile = `tools/.cache/claims-${tag}.json`;
if (!existsSync(claimsFile)) {
  console.log('저장해 둔 명제가 없다. try_extract를 먼저 돌린다');
  process.exit(1);
}
const claims = JSON.parse(readFileSync(claimsFile, 'utf8')).filter((c) => c.isPublic);

// 추가 검색 판단에 들어가는 요청만 골라, 모델에 보낸 글을 받아 둔다. 요청은 그대로 보낸다
const captured = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  try {
    if (String(url).endsWith('/chat/completions') && typeof init?.body === 'string') {
      const body = JSON.parse(init.body);
      if (body.messages?.[0]?.content === MORE_SEARCH_SYSTEM) captured.push(body.messages[1].content);
    }
  } catch {
    // 받아 두지 못해도 요청은 보낸다
  }
  return realFetch(url, init);
};

console.log(`근거 모으기를 한 번 돌린다(명제 ${claims.length}개)…`);
const t0 = performance.now();
let next = 0;
const live = new Map();
async function worker() {
  while (next < claims.length) {
    const claim = claims[next];
    next += 1;
    try {
      const { bundle, usage } = await gatherEvidence(claim, key, newBudget());
      live.set(claim.id, { extra: bundle.extraSearch, decided: usage.find((u) => u.stage === '추가 검색 판단') ?? null, searches: bundle.searches.length });
    } catch (e) {
      live.set(claim.id, { error: e.kind ?? e.message });
    }
  }
}
await Promise.all(Array.from({ length: LIMITS.concurrency }, worker));
globalThis.fetch = realFetch;
console.log(`끝. ${((performance.now() - t0) / 1000).toFixed(1)}초, 추가 검색 판단을 한 명제 ${captured.length}개`);
for (const claim of claims) {
  const r = live.get(claim.id);
  if (r?.decided) console.log(`  ${claim.id} 실제 실행: 추가 검색 ${r.extra.done ? '함' : '안 함'} | ${r.decided.model} | ${r.extra.reason.slice(0, 90)}`);
}

// 같은 입력을 방식별로 다시 묻는다
for (const user of captured) {
  const claim = claims.find((c) => user.includes(c.statement));
  console.log(`\n■ ${claim?.id ?? '?'} (${claim?.type ?? ''}) ${claim?.statement ?? ''}`);
  for (const strategy of strategies) {
    try {
      const { value, usage } = await chatJson({
        stage: '추가 검색 판단',
        key,
        system: MORE_SEARCH_SYSTEM,
        user,
        schemaName: 'more_search',
        schema: MORE_SEARCH_SCHEMA,
        maxTokens: LIMITS.gather.decideTokens,
        budget: newBudget(),
        routingStrategy: strategy === '기본' ? undefined : strategy,
      });
      console.log(`   [${strategy}] ${usage.model.replace('claude-', '')} | 더 찾을지: ${value.need_more ? '예' : '아니오'} | 사이트: ${value.site || '-'} | 검색어: ${value.query || '-'} | ${usage.seconds}초, 입력 ${usage.promptTokens} 출력 ${usage.completionTokens}, ${dollars(usage).toFixed(5)}달러`);
      console.log(`        까닭: ${(value.reason ?? '').slice(0, 150)}`);
    } catch (e) {
      console.log(`   [${strategy}] 실패: ${e.kind ?? e.message}`);
    }
  }
}
