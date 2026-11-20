// 문장 나누기 확인: 원고를 문장으로 나눈 결과를 보여 주고, 위치가 원고의 글자와 맞는지 검사한다.
// 사용: node tools/check_sentences.mjs [원고 파일]
import { readFileSync } from 'node:fs';
import { contentId, splitManuscript } from '../lib/sentences.ts';

const path = process.argv[2] ?? 'fixtures/small/manuscript.md';
const text = readFileSync(path, 'utf8');
const sentences = splitManuscript(text);

let bad = 0;
for (const s of sentences) {
  if (text.slice(s.start, s.end) !== s.source) bad += 1;
  const flags = [s.kind, s.autoApply ? '자동' : '직접', s.hasLinkOrFootnote ? '링크' : '', s.hasEmphasis ? '강조' : ''].filter(Boolean).join(',');
  console.log(`${String(s.id).padStart(2)} [${flags}] (문단 ${s.block}, ${s.start}-${s.end}) ${s.plain}`);
}
console.log(`\n문장 ${sentences.length}개, 위치가 어긋난 문장 ${bad}개, 원고 버전 ${contentId(text)}`);
if (bad > 0) process.exit(1);
