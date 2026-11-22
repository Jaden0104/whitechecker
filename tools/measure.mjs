// 측정(PRD 1.3절, 11절): 원고 한 편을 앱이 하는 그대로 처음부터 끝까지 돌리고, 정답지와 견줘 지표를 낸다.
// 화면이 쓰는 진행 코드(lib/run/runner.ts)를 그대로 써서, 같은 명제 묶기와 '직접 확인' 찾아보기, 수정안 합치기까지 앱과 똑같이 돈다.
// 서버가 떠 있어야 하고(Liner를 실제로 부른다), 접속 코드는 환경 변수 ACCESS_CODE에서 읽는다(화면에 찍지 않는다).
// 사용: node tools/measure.mjs <서버 주소> [원고 파일] [정답지 파일] [--state=저장해 둔 실행 파일] [--rejudge=저장해 둔 실행 파일] [--out=저장할 파일]
//   돌린 결과는 tools/.cache/run-<원고 식별값>.json에 남는다(--out으로 다른 이름을 줄 수 있다). --state로 그 파일을 주면 서버를 부르지 않고 집계만 다시 한다.
//   --rejudge로 저장해 둔 실행을 주면, 그때 뽑은 명제와 모은 근거는 그대로 두고 판정과 수정안만 다시 돌린다.
//   판정 지시문이나 코드 규칙을 고친 효과를, 추출과 검색이 달라진 효과와 섞지 않고 보려는 것이다. 호출과 비용은 다시 돌린 것만 센다.
// 추출한 명제와 정답 명제는 같은 문장 안에서 낱말이 가장 많이 겹치는 것끼리 먼저 잇고(어림), 사람이 보고 고친다(11절의 집계 규칙).
//   고칠 때는 tools/.cache/links-<원고 식별값>.json에 { "실행 번호": "...", "잇기": { "s5-c1": "D04", "s9-c2": null, "s19-c1": ["D19", "D20"] } }처럼 적는다.
//   null은 '정답지에 없는 추출'이라는 뜻이다. 배열은 명제 하나가 정답 여럿을 한데 묶어 뽑았다는 뜻이고, 첫째가 그 명제의 판정을 받는 정답이다.
//   실행 번호가 다르면 쓰지 않는다.
// 한 문장의 두 사실을 명제 하나로 묶어 뽑으면, 판정은 그 가운데 하나에만 매겨진 셈이다. 나머지 정답은 '묶여 뽑힘'으로 따로 세고 판정 지표에서 뺀다.
// '수정안의 새 오류'는 사람이 수정안을 읽어 확인한다. 이 도구는 읽어 볼 수정안을 모아 보여 주기만 한다.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { failureOf } from '../lib/client/api.ts';
import { RECENT_FAILURE, SKIPPED_REASON, pageKey } from '../lib/gather/page-cache.ts';
import { totalCost } from '../lib/pricing.ts';
import { autoRevision, staysDirect, summarizeUsage, viewOf } from '../lib/run/model.ts';
import { createRunner } from '../lib/run/runner.ts';

const flags = process.argv.slice(2).filter((a) => a.startsWith('--'));
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const base = args[0] ?? 'http://localhost:3111';
const manuscriptPath = args[1] ?? 'fixtures/small/manuscript.md';
const answersPath = args[2] ?? 'fixtures/small/answers.json';
const statePath = flags.find((f) => f.startsWith('--state='))?.slice(8) ?? null;
const rejudgePath = flags.find((f) => f.startsWith('--rejudge='))?.slice(10) ?? null;
const outPath = flags.find((f) => f.startsWith('--out='))?.slice(6) ?? null;

const text = readFileSync(manuscriptPath, 'utf8');
const answers = JSON.parse(readFileSync(answersPath, 'utf8')).명제;
const tag = createHash('sha256').update(text).digest('hex').slice(0, 10);
mkdirSync('tools/.cache', { recursive: true });
const runFile = outPath ?? `tools/.cache/run-${tag}.json`;
const linksFile = `tools/.cache/links-${tag}.json`;
// 집계는 실행 파일 옆에 같은 이름으로 둔다(run-… → measure-…)
const beside = (outPath ?? statePath ?? '').replace(/run-([^/\\]*)$/, 'measure-$1');
const reportFile = beside && beside !== (outPath ?? statePath) ? beside : `tools/.cache/measure-${tag}.json`;

// ---------- 1. 실행 ----------
/** 저장해 둔 실행에서 판정과 수정안만 지운다. 뽑은 명제와 모은 근거(서명 포함)는 그대로 둔다 */
function withoutJudgments(saved) {
  const { reviews: _reviews, rechecks: _rechecks, ...rest } = saved;
  return {
    ...rest,
    runId: `${saved.runId}-rj${Date.now().toString(36).slice(-4)}`,
    status: '중단',
    claims: saved.claims.map((e) => {
      // 검색 없이 확정한 '직접 확인'은 처리할 것이 없다
      if (e.direct && !e.direct.probe) return e;
      return { ...e, state: '대기', step: '', failure: '', judgment: null, direct: e.direct ? { probe: true, reclassified: false, note: '' } : null };
    }),
    revisions: {},
    usage: [],
    activeMs: 0,
    passStartedAt: null,
    blocked: '',
    deferred: 0,
  };
}

async function runOnce(seed = null) {
  let state = seed;
  const store = { get: () => state, set: (update) => (state = update(state)) };
  const code = process.env.ACCESS_CODE ?? '';
  const failed = (reason, extra = {}) => ({ ok: false, aborted: false, fatal: false, status: 0, reason, ...extra });
  const post = async (path, body, signal) => {
    if (signal.aborted) return failed('중단', { aborted: true });
    try {
      const res = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-access-code': code },
        body: JSON.stringify(body),
        // 서버가 요청 하나에 거는 60초보다 조금 넉넉하게 기다린다(화면과 같다)
        signal: AbortSignal.any([signal, AbortSignal.timeout(80_000)]),
      });
      const data = await res.json().catch(() => null);
      if (res.ok && data) return { ok: true, ...data };
      return failureOf(res.status, data);
    } catch {
      return signal.aborted ? failed('중단', { aborted: true }) : failed('연결 실패 또는 시간 초과');
    }
  };
  const api = {
    extract: (input, signal) => post('/api/extract', input, signal),
    gather: ({ more, ...claim }, signal) => post('/api/gather', more ? { claim, more } : { claim }, signal),
    judge: (body, signal) => post('/api/judge', body, signal),
    merge: (body, signal) => post('/api/merge', body, signal),
  };
  const runner = createRunner(store, api);
  if (seed) {
    // 끝나지 않은 것만 다시 돌린다. 근거가 이미 있는 명제는 다시 검색하지 않고 판정부터 한다
    runner.resume();
  } else {
    const started = runner.start(text);
    if (!started.ok) throw new Error(started.message);
  }
  const t0 = Date.now();
  const tick = setInterval(() => {
    const run = store.get();
    if (!run) return;
    const done = run.claims.filter((e) => e.state === '완료').length;
    console.log(`  ... ${Math.round((Date.now() - t0) / 1000)}초: ${run.status}, 명제 ${done}/${run.claims.length}`);
  }, 20_000);
  await runner.idle();
  clearInterval(tick);
  return store.get();
}

let run;
if (statePath) {
  run = JSON.parse(readFileSync(statePath, 'utf8'));
  console.log(`저장해 둔 실행을 다시 집계한다: ${statePath}`);
  if (run.manuscript !== text) console.log('주의  저장해 둔 실행의 원고가 지금 원고 파일과 다르다');
} else if (rejudgePath) {
  const saved = JSON.parse(readFileSync(rejudgePath, 'utf8'));
  if (saved.manuscript !== text) {
    console.log('저장해 둔 실행의 원고가 지금 원고 파일과 달라 다시 판정하지 않는다');
    process.exit(1);
  }
  if (!outPath) {
    console.log('--rejudge에는 --out으로 저장할 파일을 함께 준다(처음 실행의 기록을 덮어쓰지 않기 위해서다)');
    process.exit(1);
  }
  console.log(`모아 둔 근거로 판정과 수정안만 다시 돌린다: ${rejudgePath} → ${base}`);
  run = await runOnce(withoutJudgments(saved));
  writeFileSync(runFile, JSON.stringify(run), 'utf8');
  console.log(`실행 결과를 ${runFile}에 저장했다`);
} else {
  console.log(`실행한다: ${manuscriptPath} → ${base}`);
  run = await runOnce();
  writeFileSync(runFile, JSON.stringify(run), 'utf8');
  console.log(`실행 결과를 ${runFile}에 저장했다`);
}
if (run.blocked) {
  console.log(`실행이 멈췄다: ${run.blocked}`);
  process.exit(1);
}

// ---------- 2. 정답지와 잇기 ----------
const sentences = run.sentences;
const orderOf = (s) => sentences.filter((x) => x.source === s.source && x.id <= s.id).length;
const answersOf = (s) => answers.filter((a) => a.문장 === s.source && a['나온 순서'] === orderOf(s));
// 조사가 달라도 같은 낱말로 보도록 한글은 앞의 두 글자만, 숫자는 쉼표를 빼고 견준다
const words = (s) => new Set((s.match(/[가-힣]{2,}|\d+(?:[.,]\d+)*/g) ?? []).map((w) => (/\d/.test(w) ? w.replace(/,/g, '') : w.slice(0, 2))));
const overlap = (a, b) => [...a].filter((w) => b.has(w)).length;

/** 명제 → 그 명제의 판정을 받는 정답(없으면 null) */
const link = new Map();
/** 정답 → 그 정답을 다른 정답과 한데 묶어 뽑은 명제들 */
const bundled = new Map();
const doubt = new Map();
for (const s of sentences) {
  const pool = answersOf(s);
  const mine = run.claims.filter((e) => e.claim.sentenceId === s.id);
  for (const e of mine) {
    if (pool.length === 0) {
      link.set(e.claim.id, null);
      continue;
    }
    const scored = pool.map((a) => ({ a, score: overlap(words(a.내용), words(e.claim.statement)) })).sort((x, y) => y.score - x.score);
    link.set(e.claim.id, scored[0].a.id);
    if (pool.length > 1 && (scored[0].score === 0 || scored[1].score === scored[0].score)) doubt.set(e.claim.id, '어느 정답과 이을지 불확실');
  }
  if (pool.length === 1 && mine.length > 1) for (const e of mine) doubt.set(e.claim.id, '정답 하나에 명제가 여럿 이어짐');
  // 명제를 받지 못한 정답이, 같은 문장의 다른 명제에 함께 들어 있는지 본다(낱말이 둘 이상 겹치고, 정답의 숫자가 그 명제에 모두 있을 때)
  const taken = new Set(mine.map((e) => link.get(e.claim.id)));
  for (const a of pool) {
    if (taken.has(a.id)) continue;
    const mineWords = words(a.내용);
    const numbers = [...mineWords].filter((w) => /\d/.test(w));
    const covering = mine.filter((e) => {
      const theirs = words(e.claim.statement);
      return overlap(mineWords, theirs) >= 2 && numbers.every((n) => theirs.has(n));
    });
    if (covering.length) bundled.set(a.id, covering.map((e) => e.claim.id));
  }
}
let overridden = 0;
if (existsSync(linksFile)) {
  const saved = JSON.parse(readFileSync(linksFile, 'utf8'));
  if (saved['실행 번호'] === run.runId) {
    for (const [claimId, value] of Object.entries(saved.잇기 ?? {})) {
      if (!link.has(claimId)) continue;
      const list = Array.isArray(value) ? value : [value];
      link.set(claimId, list[0] ?? null);
      // 사람이 정한 잇기가 어림으로 묶은 것보다 앞선다
      for (const [answerId, claimIds] of bundled) {
        const rest = claimIds.filter((id) => id !== claimId);
        if (rest.length) bundled.set(answerId, rest);
        else bundled.delete(answerId);
      }
      for (const answerId of list.slice(1)) bundled.set(answerId, [...(bundled.get(answerId) ?? []), claimId]);
      doubt.delete(claimId);
      overridden += 1;
    }
  } else {
    console.log(`주의  ${linksFile}은 다른 실행(${saved['실행 번호']})의 것이라 쓰지 않았다`);
  }
}

// ---------- 3. 정답마다 결과를 매긴다 ----------
const SEVERITY = ['불일치', '해석 주의', '근거 부족', '직접 확인', '일치'];
const WARNINGS = ['불일치', '해석 주의', '근거 부족'];
const squeeze = (s) => s.replace(/\s+/g, '');
const hasAny = (haystack, option) => option.split('|').some((o) => squeeze(haystack).includes(squeeze(o)));

const rows = answers.map((a) => {
  const views = run.claims.filter((e) => link.get(e.claim.id) === a.id).map((e) => viewOf(run, e));
  const done = views.filter((v) => v.state === '완료' && v.verdict !== null);
  // 이어진 명제가 여럿이면 가장 무거운 판정을 그 정답의 판정으로 본다
  const verdict = done.length ? SEVERITY.find((x) => done.some((v) => v.verdict === x)) : null;
  // 이 정답을 다른 정답과 한데 묶어 뽑은 명제. 따로 받은 명제가 없을 때만 본다
  const within = views.length ? [] : (bundled.get(a.id) ?? []).map((id) => viewOf(run, run.claims.find((e) => e.claim.id === id)));
  const status =
    views.length === 0 ? (within.length ? '묶여 뽑힘' : '미추출') : done.length === 0 ? '미완료' : a.허용.includes(verdict) ? '허용' : (a.불허 ?? []).includes(verdict) ? '불허' : '허용 밖';
  // 근거 모으기: 정답지의 말이 이어진 명제들의 발췌 어딘가에 있는지
  const must = a['발췌에 있어야 할 말'] ?? [];
  const covering = views.length ? views : within;
  const evidenceText = covering.map((v) => (v.bundle?.evidence ?? []).map((x) => x.text).join('\n')).join('\n');
  const missing = covering.length && must.length ? must.filter((m) => !hasAny(evidenceText, m)) : [];
  return { a, views, within, covering, done, verdict, status, must, missing };
});

const kindOf = (a) => (a.정상 === true ? '정상' : a.정상 === null ? '확인 불가' : '심은 오류');
const count = (list, by) => {
  const out = new Map();
  for (const item of list) out.set(by(item), (out.get(by(item)) ?? 0) + 1);
  return [...out].map(([k, n]) => `${k} ${n}`).join(', ') || '없음';
};
const pct = (n, d) => (d ? `${((n / d) * 100).toFixed(1)}%` : '-');
const idsOf = (list) => list.map((r) => r.a.id).join(', ') || '없음';

console.log(`\n[정답별 결과] 실행 번호 ${run.runId}${overridden ? `, 사람이 고친 잇기 ${overridden}건` : ''}`);
for (const r of rows) {
  const claimIds = r.views.length
    ? r.views.map((v) => `${v.entry.claim.id}${doubt.has(v.entry.claim.id) ? '?' : ''}:${v.verdict ?? v.state}`).join(' ')
    : r.within.map((v) => `(${v.entry.claim.id}에 함께 들어 있음: ${v.verdict ?? v.state})`).join(' ');
  const mark = r.status === '불허' ? '✗' : r.status === '허용' ? '·' : '△';
  console.log(`${mark} ${r.a.id} ${kindOf(r.a).padEnd(5)} ${(r.a.종류 ?? '').padEnd(10)} → ${(r.verdict ?? r.status).padEnd(5)} [${r.status}] ${claimIds}${r.missing.length ? ` | 발췌에 없음: ${r.missing.join(', ')}` : ''}`);
}
const extra = run.claims.filter((e) => link.get(e.claim.id) === null).map((e) => viewOf(run, e));
if (extra.length) {
  console.log('\n[정답지에 없는 추출]');
  for (const v of extra) console.log(`  ${v.entry.claim.id} (${v.verdict ?? v.state}) ${v.entry.claim.statement}`);
}
if (doubt.size) {
  console.log('\n[잇기를 확인할 명제] 표에 ?로 표시했다');
  for (const [id, why] of doubt) {
    const e = run.claims.find((x) => x.claim.id === id);
    console.log(`  ${id} → ${link.get(id)} (${why}) ${e.claim.statement}`);
  }
}

// ---------- 4. 지표 ----------
const normal = rows.filter((r) => r.a.정상 === true);
const planted = rows.filter((r) => r.a.정상 === false);
const hidden = rows.filter((r) => r.a.정상 === null);
const judged = (list) => list.filter((r) => r.verdict !== null);
const missed = rows.filter((r) => r.status === '미추출');
const merged = rows.filter((r) => r.status === '묶여 뽑힘');
const unfinishedClaims = run.claims.map((e) => viewOf(run, e)).filter((v) => !(v.state === '완료' && v.verdict !== null));
const wrongMatch = [...planted, ...hidden].filter((r) => r.verdict === '일치');
const wrongMismatch = normal.filter((r) => r.verdict === '불일치');
const burden = normal.filter((r) => r.verdict === '근거 부족' || r.verdict === '해석 주의');
const warned = rows.filter((r) => WARNINGS.includes(r.verdict));
const warnedReal = warned.filter((r) => r.a.정상 !== true);
const caught = planted.filter((r) => WARNINGS.includes(r.verdict));
const directOk = hidden.filter((r) => r.verdict === '직접 확인');
const normalDirect = [...normal, ...planted].filter((r) => r.verdict === '직접 확인');
const evidenceChecked = rows.filter((r) => r.covering.length && r.must.length);
const evidenceFound = evidenceChecked.filter((r) => r.missing.length === 0);

console.log('\n[지표] 비율은 명제 수와 함께 본다(PRD 1.3절)');
console.log(`정답 명제 ${answers.length}개(정상 ${normal.length}, 심은 오류 ${planted.length}, 확인 불가 ${hidden.length}) / 추출한 명제 ${run.claims.length}개(정답지에 없는 추출 ${extra.length}개)`);
console.log(`명제 추출 누락률: ${missed.length}/${answers.length} (${pct(missed.length, answers.length)}) — 미추출 ${idsOf(missed)}`);
console.log(`한 명제로 묶여 뽑힌 것: ${merged.length}개 — ${idsOf(merged)} (따로 판정되지 않아 아래 판정 지표에서 뺀다. 심은 오류 ${merged.filter((r) => r.a.정상 === false).length}개 포함)`);
console.log(`끝나지 않은 명제(실패·중단·대기): ${unfinishedClaims.length}개${unfinishedClaims.length ? ` — ${unfinishedClaims.map((v) => `${v.entry.claim.id}(${v.state}${v.failure ? `: ${v.failure}` : ''})`).join(', ')}` : ''}`);
console.log(`잘못된 '일치': ${wrongMatch.length}건 — ${idsOf(wrongMatch)}`);
console.log(`잘못된 '불일치': ${wrongMismatch.length}건 — ${idsOf(wrongMismatch)}`);
console.log(`경고 적중률: ${warnedReal.length}/${warned.length} (${pct(warnedReal.length, warned.length)}) — 경고가 붙은 정답 가운데 실제로 문제가 있던 것`);
console.log(`정상 문장의 추가 확인 부담: ${burden.length}/${judged(normal).length} (${pct(burden.length, judged(normal).length)}) — ${burden.map((r) => `${r.a.id}(${r.verdict})`).join(', ') || '없음'}`);
// 정답지가 그 경고를 허용한 것(출처가 실제로 엇갈리거나 공식 자료가 한 곳뿐인 문장)도 부담으로 센다. 몇 건인지만 따로 보인다
const burdenAllowed = burden.filter((r) => r.status === '허용');
console.log(`  이 가운데 정답지가 허용한 경고 ${burdenAllowed.length}건(${idsOf(burdenAllowed)}), 허용 밖 ${burden.length - burdenAllowed.length}건`);
console.log(`심은 오류 ${planted.length}개: 경고가 붙은 것 ${caught.length}개, 판정 ${count(planted, (r) => r.verdict ?? r.status)} / 정답지 기준 ${count(planted, (r) => r.status)}`);
console.log(`정상 ${normal.length}개: 판정 ${count(normal, (r) => r.verdict ?? r.status)} / 정답지 기준 ${count(normal, (r) => r.status)}`);
console.log(`확인 불가 ${hidden.length}개: '직접 확인'으로 간 것 ${directOk.length}개 — 판정 ${count(hidden, (r) => r.verdict ?? r.status)}`);
if (normalDirect.length) console.log(`공개 자료로 확인되는 명제인데 '직접 확인'으로 간 것: ${idsOf(normalDirect)}`);
console.log(`근거 모으기: 정답지의 말이 발췌에 있는 정답 ${evidenceFound.length}/${evidenceChecked.length} — 없는 것 ${idsOf(evidenceChecked.filter((r) => r.missing.length))}`);

if (planted.some((r) => r.a.종류)) {
  console.log('\n[심은 것의 종류별]');
  const kinds = [...new Set([...planted, ...hidden].map((r) => r.a.종류).filter(Boolean))];
  for (const kind of kinds) {
    const list = rows.filter((r) => r.a.종류 === kind);
    console.log(`  ${kind}: ${list.map((r) => `${r.a.id} ${r.verdict ?? r.status}[${r.status}]`).join(', ')}`);
  }
}

const conflicts = run.claims.map((e) => viewOf(run, e)).filter((v) => v.verdict === '해석 주의' && v.judgment?.conflict.found);
if (conflicts.length) {
  console.log('\n[근거가 엇갈려 해석 주의가 된 것] 지지 쪽과 반박 쪽의 가장 높은 등급');
  for (const v of conflicts) console.log(`  ${v.entry.claim.id} → 정답 ${link.get(v.entry.claim.id) ?? '없음'}: 지지 ${v.judgment.conflict.supportTop}등급, 반박 ${v.judgment.conflict.refuteTop}등급`);
}

// ---------- 5. 수정안 ----------
console.log('\n[수정안] 정답지의 기대(있어야 할 말, 없어야 할 말, 수정안 없음)와 견준다');
let fixOk = 0;
let fixBad = 0;
const toRead = [];
for (const s of sentences) {
  const pool = answersOf(s);
  if (pool.length === 0) continue;
  const revised = autoRevision(run, s.id)?.revised ?? null;
  const entry = run.revisions[s.id];
  const problems = [];
  for (const a of pool) {
    const must = a['수정안에 있어야 할 말'] ?? [];
    const mustNot = a['수정안에 없어야 할 말'] ?? [];
    const none = a['수정안 없음'] === true;
    if (must.length === 0 && mustNot.length === 0 && !none) continue;
    const got = revised ?? s.source;
    const mine = [];
    if (none && revised) mine.push('수정안이 나오면 안 되는데 나왔다');
    const lacking = must.filter((m) => !hasAny(got, m));
    const left = mustNot.filter((m) => hasAny(got, m));
    if (lacking.length) mine.push(`없음: ${lacking.join(', ')}`);
    if (left.length) mine.push(`남아 있음: ${left.join(', ')}`);
    if (mine.length) {
      fixBad += 1;
      problems.push(`${a.id} ${mine.join(' / ')}`);
    } else {
      fixOk += 1;
    }
  }
  if (problems.length) console.log(`  문장 ${s.id}: ${problems.join(' | ')}${revised ? '' : ` (수정안 없음${entry?.state && entry.state !== '없음' && entry.state !== '완료' ? `, ${entry.state}` : ''})`}`);
  if (revised) toRead.push({ id: s.id, before: s.source, after: revised, allNormal: pool.every((a) => a.정상 === true) });
}
console.log(`정답지의 기대와 맞는 것 ${fixOk}건, 어긋난 것 ${fixBad}건`);
console.log(`만들어진 수정안 ${toRead.length}개(사람이 읽고 새 오류가 없는지 확인한다). 정상 문장만 든 문장에 나온 수정안 ${toRead.filter((x) => x.allNormal).length}개`);
for (const x of toRead) console.log(`  문장 ${x.id}${x.allNormal ? ' [정상 문장인데 수정안이 나옴]' : ''}\n    전: ${x.before}\n    후: ${x.after}`);

// ---------- 6. 호출과 비용 ----------
const summary = summarizeUsage(run.usage);
const cost = totalCost(run.usage);
console.log('\n[호출과 비용]');
console.log(`검색 ${summary.searches}회, 모델 호출 ${summary.modelCalls}회, 추정 비용 약 ${cost.dollars.toFixed(2)}달러, 실제로 돈 시간 ${Math.round(run.activeMs / 1000)}초`);
for (const row of summary.byStage) console.log(`  ${row.stage}: 검색 ${row.searches}회, 모델 ${row.modelCalls}회${row.models.length ? `(${row.models.join(', ')})` : ''}, 토큰 입력 ${row.promptTokens} 출력 ${row.completionTokens}`);

// ---------- 7. 원문 수집 ----------
// 여러 명제가 같은 페이지를 찾으면 한 번만 열고 함께 쓴다(lib/gather/page-cache.ts). 같은 주소가 같은 '연 시각'으로 적혀 있으면 함께 쓴 것이다
const pages = [];
// 응답 없는 사이트라 건너뛴 것은 대개 고르는 단계에서 빠져 '열지 않음'으로 적힌다. 고른 뒤에 건너뛰게 된 것은 '실패'로 적힌다
const skippedPages = [];
// 조금 전에 다른 명제가 못 연 주소라 고르지 않은 것
const recentSkips = [];
for (const e of run.claims) {
  if (!e.bundle || e.bundleFrom) continue;
  for (const s of e.bundle.sources) {
    if (s.fetch.reason === SKIPPED_REASON) skippedPages.push(s);
    if (s.fetch.status === '열지 않음' && s.fetch.reason.startsWith(RECENT_FAILURE)) recentSkips.push(s);
    if (s.fetch.status !== '열지 않음') pages.push(s);
  }
}
// 조금 전에 실패한 주소를 다른 명제가 다시 고른 횟수. 고르는 단계에서 빼므로 0에 가까워야 한다
const failedMarks = new Set();
let pickedAgain = 0;
for (const s of pages.filter((x) => x.fetch.status === '실패')) {
  const mark = `${pageKey(s.url)} @ ${s.fetch.fetchedAt}`;
  if (failedMarks.has(mark)) pickedAgain += 1;
  else failedMarks.add(mark);
}
const opens = new Set(pages.filter((s) => s.fetch.reason !== SKIPPED_REASON).map((s) => `${pageKey(s.url)} @ ${s.fetch.fetchedAt}`));
const failedPages = pages.filter((s) => s.fetch.status === '실패');
const countBy = (list, keyOf) => {
  const counts = new Map();
  for (const item of list) counts.set(keyOf(item), (counts.get(keyOf(item)) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1]);
};
const failReasons = countBy(failedPages, (s) => s.fetch.reason || '사유 없음');
const failHosts = countBy(failedPages, (s) => s.hostname);
console.log('\n[원문 수집]');
console.log(
  `묶음에 적힌 페이지 ${pages.length}곳(서로 다른 주소 ${new Set(pages.map((s) => pageKey(s.url))).size}곳), 실제로 연 횟수 ${opens.size}, 응답 없는 사이트라 건너뛴 것 ${skippedPages.length}`,
);
console.log(
  `성공 ${pages.filter((s) => s.fetch.status === '성공').length}, 관련 내용 없음 ${pages.filter((s) => s.fetch.status === '관련 내용 없음').length}, 실패 ${failedPages.length}${failReasons.length ? ` (${failReasons.map(([k, n]) => `${k} ${n}`).join(', ')})` : ''}`,
);
console.log(`  조금 전에 못 연 주소라 고르지 않은 것 ${recentSkips.length}, 그런 주소를 다시 고른 것 ${pickedAgain}`);
if (failHosts.length) console.log(`  실패가 많은 사이트: ${failHosts.slice(0, 6).map(([k, n]) => `${k} ${n}`).join(', ')}`);

writeFileSync(
  reportFile,
  JSON.stringify(
    {
      원고: manuscriptPath,
      '실행 번호': run.runId,
      '검증을 시작한 때': run.startedAt,
      '정답 명제': answers.length,
      '추출한 명제': run.claims.length,
      '정답지에 없는 추출': extra.length,
      미추출: missed.map((r) => r.a.id),
      '한 명제로 묶여 뽑힌 것': merged.map((r) => r.a.id),
      "잘못된 '일치'": wrongMatch.map((r) => r.a.id),
      "잘못된 '불일치'": wrongMismatch.map((r) => r.a.id),
      '경고 적중률': { 문제가_있던_것: warnedReal.length, 경고가_붙은_것: warned.length },
      '정상 문장의 추가 확인 부담': { 건수: burden.length, 정상_가운데_판정이_난_것: judged(normal).length, 항목: burden.map((r) => r.a.id) },
      '심은 오류': { 수: planted.length, 경고가_붙은_것: caught.length },
      '직접 확인': { '확인 불가 문장': hidden.length, 맞춘_것: directOk.length },
      '근거 모으기': { 견준_것: evidenceChecked.length, 있는_것: evidenceFound.length },
      수정안: { 기대와_맞음: fixOk, 어긋남: fixBad, 만들어진_것: toRead.length },
      호출: { 검색: summary.searches, 모델: summary.modelCalls, '추정 비용(달러)': Number(cost.dollars.toFixed(4)), '돈 시간(초)': Math.round(run.activeMs / 1000) },
      '원문 수집': { 적힌_페이지: pages.length, 연_횟수: opens.size, 건너뛴_것: skippedPages.length, 실패: Object.fromEntries(failReasons) },
      정답별: rows.map((r) => ({ id: r.a.id, 구분: kindOf(r.a), 종류: r.a.종류 ?? null, 판정: r.verdict, 결과: r.status, 명제: r.views.map((v) => v.entry.claim.id) })),
    },
    null,
    2,
  ),
  'utf8',
);
console.log(`\n집계를 ${reportFile}에 저장했다`);
