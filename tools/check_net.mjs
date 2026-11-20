// 주소 검사와 근거 서명이 기대대로 동작하는지 확인한다. 외부 사이트는 열지 않는다.
// 사용: node tools/check_net.mjs
import http from 'node:http';
import { claimKey, signBundle, verifyBundle } from '../lib/evidence.ts';
import { isPublicAddress } from '../lib/net/address.ts';
import { blockedReason, safeGet } from '../lib/net/safe-get.ts';

let failed = 0;
function expect(label, actual, wanted) {
  const ok = actual === wanted;
  if (!ok) failed += 1;
  console.log(`${ok ? '통과' : '실패'}  ${label}${ok ? '' : `  (기대 ${wanted}, 실제 ${actual})`}`);
}

console.log('[주소 대역]');
for (const [ip, open] of [
  ['8.8.8.8', true],
  ['211.43.210.1', true],
  ['2001:4860:4860::8888', true],
  ['127.0.0.1', false],
  ['10.1.2.3', false],
  ['172.16.0.1', false],
  ['172.31.255.255', false],
  ['172.32.0.1', true],
  ['192.168.0.10', false],
  ['169.254.169.254', false],
  ['168.63.129.16', false],
  ['100.64.0.1', false],
  ['0.0.0.0', false],
  ['::1', false],
  ['::', false],
  ['fe80::1', false],
  ['fd00::1', false],
  ['::ffff:127.0.0.1', false],
  ['::ffff:7f00:1', false],
  ['::ffff:8.8.8.8', true],
  ['example.com', false],
]) {
  expect(`${ip} → ${open ? '열 수 있음' : '막음'}`, isPublicAddress(ip), open);
}

console.log('\n[주소 형식]');
for (const [url, open] of [
  ['https://www.heritage.go.kr/heri/idx/index.do', true],
  ['http://www.gogung.go.kr:8080/', true],
  ['ftp://example.com/a', false],
  ['file:///etc/passwd', false],
  ['http://localhost:3000/', false],
  ['http://127.0.0.1/', false],
  ['http://[::1]/', false],
  ['http://169.254.169.254/metadata/instance', false],
  ['http://2130706433/', false],
  ['http://0x7f.1/', false],
  ['http://user:pw@example.com/', false],
  ['http://example.com:22/', false],
  ['http://intranet/', false],
  ['http://printer.local/', false],
]) {
  expect(`${url} → ${open ? '열 수 있음' : '막음'}`, blockedReason(new URL(url)) === null, open);
}

console.log('\n[이 PC의 서버로 실제 요청]');
// 이 PC에 서버를 띄워 놓고, 그 주소를 여는 요청과 그리로 옮겨 가는 요청이 막히는지 본다
const local = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end('<p>이 글이 읽히면 안 된다</p>');
});
await new Promise((resolve) => local.listen(0, '127.0.0.1', resolve));
const port = local.address().port;
const direct = await safeGet(`http://127.0.0.1:${port}/`, { timeoutMs: 3000, maxBytes: 10000 });
expect('로컬 주소를 직접 여는 요청', direct.ok ? '열림' : direct.reason, '주소 차단');
const named = await safeGet(`http://localhost:${port}/`, { timeoutMs: 3000, maxBytes: 10000 });
expect('localhost 이름으로 여는 요청', named.ok ? '열림' : named.reason, '주소 차단');
local.close();

// 겉보기에는 공개된 이름인데 로컬 주소로 풀리는 경우. 이름을 주소로 바꾸는 순간의 검사가 막아야 한다.
// (이 항목만 이름 풀이를 위해 외부 DNS에 묻는다. 풀이가 안 되면 건너뛴다)
const trap = http.createServer((req, res) => res.end('<p>이 글이 읽히면 안 된다</p>'));
const listening = await new Promise((resolve) => {
  trap.once('error', () => resolve(false));
  trap.listen(8080, '127.0.0.1', () => resolve(true));
});
if (listening) {
  const disguised = await safeGet('http://localtest.me:8080/', { timeoutMs: 5000, maxBytes: 10000 });
  if (!disguised.ok && disguised.reason === '연결 실패') console.log(`건너뜀  로컬 주소로 풀리는 공개 이름 (${disguised.detail})`);
  else expect('로컬 주소로 풀리는 공개 이름', disguised.ok ? '열림' : disguised.reason, '주소 차단');
  trap.close();
} else {
  console.log('건너뜀  로컬 주소로 풀리는 공개 이름 (8080 포트를 쓸 수 없다)');
}

console.log('\n[근거 서명]');
const claim = { statement: '각석의 세로는 211cm다', type: '제원·실측', qualifiers: [], asOf: '현재' };
const bundle = {
  v: 1,
  claimKey: claimKey(claim),
  gatheredAt: '2026-11-20T00:00:00.000Z',
  searches: [],
  sources: [],
  evidence: [{ no: 1, sourceNo: 1, text: '크기 | 세로 211cm, 가로 123cm' }],
  extraSearch: { done: false, reason: '' },
  premium: [],
};
const signature = signBundle(bundle, 'test-key-a');
expect('같은 묶음과 같은 명제', verifyBundle(bundle, signature, claim, 'test-key-a'), true);
// 화면을 거쳐 돌아오면 키의 순서가 달라질 수 있다
const reordered = JSON.parse(JSON.stringify({ evidence: bundle.evidence, ...bundle }));
expect('키의 순서만 다른 묶음', verifyBundle(reordered, signature, claim, 'test-key-a'), true);
const edited = { ...bundle, evidence: [{ no: 1, sourceNo: 1, text: '크기 | 세로 311cm, 가로 123cm' }] };
expect('발췌를 고친 묶음', verifyBundle(edited, signature, claim, 'test-key-a'), false);
expect('다른 명제에 붙인 묶음', verifyBundle(bundle, signature, { ...claim, statement: '각석의 가로는 123cm다' }, 'test-key-a'), false);
expect('다른 키로 만든 서명', verifyBundle(bundle, signBundle(bundle, 'test-key-b'), claim, 'test-key-a'), false);
expect('서명이 없는 묶음', verifyBundle(bundle, '', claim, 'test-key-a'), false);

console.log(failed ? `\n실패 ${failed}건` : '\n모두 통과');
process.exit(failed ? 1 : 0);
