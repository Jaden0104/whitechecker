// 원문 수집 시험(PC용 명령): 앱이 열어야 하는 종류의 공개 페이지를 읽을 수 있는지 확인한다.
// 공공기관, 백과, 논문, 위키 12곳을 앱의 이름을 밝힌 채 열어
// 응답 상태, 인코딩, 읽힌 한글 글자 수, 핵심어가 있는지를 적는다. API 키는 쓰지 않는다.
// 사이트가 거부하면 그대로 '실패'로 적는다. 브라우저인 척하거나 헤더를 바꿔 다시 열지 않는다.
//
// PC에서:      node tools/fetch_probe.mjs [결과 파일]
// 배포본에서:  같은 목록을 진단 경로(/api/diag/fetch-probe)에서 열어 이 결과와 비교한다.
import { writeFileSync } from 'node:fs';
import { TARGETS, describe, probe } from '../lib/probe-core.mjs';

const lines = ['| 출처 | 결과 |', '| --- | --- |'];
let passed = 0;
for (const [label, url, keyword] of TARGETS) {
  const res = await probe(url, keyword);
  if (res.ok) passed += 1;
  lines.push(`| ${label} | ${describe(res)} |`);
}
lines.push('', `핵심어까지 읽힌 출처: ${passed}/${TARGETS.length}`);

const report = `원문 수집 시험 (PC, Node ${process.version}, ${new Date().toISOString().slice(0, 10)})\n\n${lines.join('\n')}\n`;
if (process.argv[2]) writeFileSync(process.argv[2], report, 'utf8');
else console.log(report);
