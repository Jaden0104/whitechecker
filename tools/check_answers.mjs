// 시험 원고와 정답지가 서로 맞는지 확인한다. Liner도 서버도 부르지 않는다.
// - 정답지의 '문장'이 원고를 나눈 문장과 글자까지 같은지('나온 순서' 포함)
// - 제목이 아닌 문장마다 정답이 하나 이상 있는지
// - 심은 항목이 종류별로 몇 개인지(PRD 11장의 표와 견줄 수 있게)
// --sources 를 붙이면 정답지의 '출처'에 적은 페이지를 앱의 원문 수집 코드로 열어,
// '발췌에 있어야 할 말'이 그 페이지들 어딘가에 실제로 있는지도 본다(인터넷에 나간다).
// 사용: node tools/check_answers.mjs [원고 파일] [정답지 파일] [--sources]
import { readFileSync } from 'node:fs';
import { extractPageText } from '../lib/gather/page-text.ts';
import { decodeBody, safeGet } from '../lib/net/safe-get.ts';
import { splitManuscript } from '../lib/sentences.ts';

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const withSources = process.argv.includes('--sources');
const manuscriptPath = args[0] ?? 'fixtures/small/manuscript.md';
const answersPath = args[1] ?? 'fixtures/small/answers.json';

const text = readFileSync(manuscriptPath, 'utf8');
const key = JSON.parse(readFileSync(answersPath, 'utf8'));
const answers = key.명제;
const sentences = splitManuscript(text);
let problems = 0;
const problem = (message) => {
  problems += 1;
  console.log(`문제  ${message}`);
};

// 1. 정답의 문장이 원고에 있는지
const orderOf = (s) => sentences.filter((x) => x.source === s.source && x.id <= s.id).length;
const sentenceFor = (a) => sentences.find((s) => s.source === a.문장 && orderOf(s) === a['나온 순서']);
const ids = new Set();
for (const a of answers) {
  if (ids.has(a.id)) problem(`${a.id}: 번호가 겹친다`);
  ids.add(a.id);
  if (!sentenceFor(a)) problem(`${a.id}: 원고에 없는 문장이다(나온 순서 ${a['나온 순서']}) — ${a.문장.slice(0, 40)}`);
  if (!Array.isArray(a.허용) || a.허용.length === 0) problem(`${a.id}: 허용하는 판정이 없다`);
  if ((a.허용 ?? []).some((v) => (a.불허 ?? []).includes(v))) problem(`${a.id}: 허용과 불허에 같은 판정이 있다`);
  if (a.정상 === false && !a['심은 것']) problem(`${a.id}: 정상이 아닌데 무엇을 심었는지 적지 않았다`);
}

// 2. 문장마다 정답이 있는지
const body = sentences.filter((s) => s.kind !== 'heading');
for (const s of body) {
  const order = orderOf(s);
  if (!answers.some((a) => a.문장 === s.source && a['나온 순서'] === order)) problem(`문장 ${s.id}: 정답이 없다 — ${s.source.slice(0, 40)}`);
}

// 3. 집계
const count = (list, by) => {
  const out = new Map();
  for (const item of list) out.set(by(item), (out.get(by(item)) ?? 0) + 1);
  return [...out].map(([k, n]) => `${k} ${n}`).join(', ');
};
const planted = answers.filter((a) => a.정상 !== true);
const doubleSentences = new Set(answers.filter((a) => a.종류 === '한 문장에 오류 둘').map((a) => `${a.문장}#${a['나온 순서']}`));
console.log(`원고 ${manuscriptPath}: 글자 ${text.length}자, 문장 ${sentences.length}개(제목 ${sentences.length - body.length}개)`);
console.log(`정답지 ${answersPath}: 명제 ${answers.length}개(정상 ${answers.length - planted.length}, 심은 것 ${planted.length}), 확인일 ${key.확인일}`);
if (planted.some((a) => a.종류)) console.log(`심은 것의 종류(명제 수): ${count(planted.filter((a) => a.종류), (a) => a.종류)} / '한 문장에 오류 둘'은 문장으로 ${doubleSentences.size}개`);
console.log(`허용하는 판정: ${count(answers, (a) => a.허용.join('·'))}`);

// 4. 출처 페이지에 그 말이 실제로 있는지
if (withSources) {
  const squeeze = (s) => s.replace(/\s+/g, '');
  const pages = [];
  for (const [name, url] of Object.entries(key.출처 ?? {})) {
    const got = await safeGet(url, { timeoutMs: 20000, maxBytes: 2_000_000 });
    if (!got.ok) {
      console.log(`출처  ${name}: 열지 못함(${got.reason})`);
      continue;
    }
    const page = extractPageText(decodeBody(got.body, got.contentType).text);
    console.log(`출처  ${name}: 글자 ${page.chars}`);
    pages.push(squeeze(`${page.title}\n${page.blocks.join('\n')}`));
  }
  const all = pages.join('\n');
  let checked = 0;
  for (const a of answers) {
    for (const must of a['발췌에 있어야 할 말'] ?? []) {
      checked += 1;
      if (!must.split('|').some((word) => all.includes(squeeze(word)))) problem(`${a.id}: 발췌에 있어야 할 말 '${must}'이 출처 페이지 어디에도 없다`);
    }
  }
  console.log(`발췌에 있어야 할 말 ${checked}개를 출처 ${pages.length}곳의 글과 견줬다`);
}

console.log(problems ? `\n문제 ${problems}건` : '\n모두 통과');
process.exit(problems ? 1 : 0);
