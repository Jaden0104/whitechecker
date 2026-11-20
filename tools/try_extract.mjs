// 명제 추출 확인: 원고를 문장으로 나눠 로컬 서버의 추출 경로에 보내고, 문장마다 뽑힌 명제를 보여 준다.
// 정답지가 있으면 문장별 명제 수를 견준다. 서버가 떠 있어야 한다.
// 사용: node tools/try_extract.mjs <서버 주소> [원고 파일] [정답지 파일]
// 접속 코드는 환경 변수 ACCESS_CODE에서 읽는다(화면에 찍지 않는다).
import { existsSync, readFileSync } from 'node:fs';
import { buildExtractChunks } from '../lib/chunks.ts';
import { splitManuscript } from '../lib/sentences.ts';

const base = process.argv[2] ?? 'http://localhost:3111';
const manuscriptPath = process.argv[3] ?? 'fixtures/small/manuscript.md';
const answersPath = process.argv[4] ?? 'fixtures/small/answers.json';

const text = readFileSync(manuscriptPath, 'utf8');
const sentences = splitManuscript(text);
const chunks = buildExtractChunks(sentences);

const claims = [];
const usages = [];
const t0 = performance.now();
for (const chunk of chunks) {
  const res = await fetch(`${base}/api/extract`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-access-code': process.env.ACCESS_CODE ?? '' },
    body: JSON.stringify(chunk),
  });
  const body = await res.json();
  if (!res.ok) {
    console.log(`추출 실패(${res.status}): ${body.error}`);
    process.exit(1);
  }
  claims.push(...body.claims);
  usages.push(body.usage);
  if (body.dropped) console.log(`받지 않은 명제 ${body.dropped}개`);
}
const seconds = ((performance.now() - t0) / 1000).toFixed(1);

for (const s of sentences) {
  const mine = claims.filter((c) => c.sentenceId === s.id);
  console.log(`\n[${s.id}] ${s.plain}`);
  for (const c of mine) {
    const tail = c.isPublic ? `검색어: ${c.queries.join(' / ')}${c.counterQuery ? ` / 반증: ${c.counterQuery}` : ''}` : `직접 확인: ${c.privateReason}`;
    console.log(`   - (${c.type}, 시점 ${c.asOf}${c.qualifiers.length ? `, 한정 ${c.qualifiers.join('·')}` : ''}) ${c.statement}`);
    console.log(`     ${tail}`);
  }
  if (mine.length === 0) console.log('   (명제 없음)');
}

const tokensIn = usages.reduce((n, u) => n + u.promptTokens, 0);
const tokensOut = usages.reduce((n, u) => n + u.completionTokens, 0);
console.log(`\n묶음 ${chunks.length}개, 명제 ${claims.length}개, ${seconds}초, 모델 ${[...new Set(usages.map((u) => u.model))].join(', ')}, 토큰 입력 ${tokensIn} 출력 ${tokensOut}`);

if (existsSync(answersPath)) {
  const answers = JSON.parse(readFileSync(answersPath, 'utf8'));
  console.log('\n정답지와 견준 문장별 명제 수(정답 / 추출)');
  const seen = new Map();
  for (const s of sentences) {
    const order = (seen.get(s.source) ?? 0) + 1;
    seen.set(s.source, order);
    const expected = answers.명제.filter((a) => a.문장 === s.source && a['나온 순서'] === order).length;
    const got = claims.filter((c) => c.sentenceId === s.id).length;
    if (expected || got) console.log(`  [${s.id}] ${expected} / ${got}${got < expected ? '  <- 부족' : ''}`);
  }
}
