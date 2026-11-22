// 페이지에서 링크를 뽑는 부분이 기대대로 동작하는지 확인한다. 외부 사이트를 열지 않는다.
// 안쪽 페이지 열기(보강 검색에서 기관 사이트의 메뉴를 한 단계 따라가는 것)가 이 결과를 쓴다.
// 사용: node tools/check_links.mjs
import { extractLinks, extractPageText } from '../lib/gather/page-text.ts';

let failed = 0;
function expect(label, actual, wanted) {
  const a = typeof actual === 'string' ? actual : JSON.stringify(actual);
  const w = typeof wanted === 'string' ? wanted : JSON.stringify(wanted);
  const ok = a === w;
  if (!ok) failed += 1;
  console.log(`${ok ? '통과' : '실패'}  ${label}${ok ? '' : `\n      기대 ${w}\n      실제 ${a}`}`);
}

const html = `<!doctype html><html><head><title>어느 박물관</title><script>var a = '<a href="/hidden">숨은 링크</a>';</script></head><body>
<nav><ul>
  <li><a href="/museum/contents.do?key=10">박물관 소개</a></li>
  <li><a href="contents.do?key=11">연혁</a></li>
  <li><a href="/museum/contents.do?key=12#top">관람   안내</a></li>
  <li><a href="#">메뉴 펼치기</a></li>
  <li><a href="javascript:goPage(3)">전시 해설</a></li>
  <li><a href="mailto:someone@example.org">문의</a></li>
  <li><a href="/museum/contents.do?key=11">연혁(다시)</a></li>
  <li><a href="/files/guide.pdf">안내문 내려받기</a></li>
  <li><a href="https://other.example.org/page" title="다른 기관">바깥 링크</a></li>
  <li><a href="/museum/contents.do?key=13" title="오시는 길"><img src="/a.png" alt=""></a></li>
  <li><a href="/museum/contents.do?key=14"></a></li>
</ul></nav>
<main><p>본문입니다. <a href="/museum/notice.do?id=7">휴관일 안내</a>를 보십시오.</p></main>
</body></html>`;

const links = extractLinks(html, 'https://www.example.go.kr/museum/index.do');
const byText = (text) => links.find((l) => l.text === text)?.url ?? null;
expect('메뉴(nav) 안의 링크도 뽑는다', byText('박물관 소개'), 'https://www.example.go.kr/museum/contents.do?key=10');
expect('상대 주소는 그 페이지의 주소를 기준으로 푼다', byText('연혁'), 'https://www.example.go.kr/museum/contents.do?key=11');
expect('글자의 공백은 하나로 줄이고, 주소 끝의 #은 뗀다', byText('관람 안내'), 'https://www.example.go.kr/museum/contents.do?key=12');
expect('본문 안의 링크도 뽑는다', byText('휴관일 안내'), 'https://www.example.go.kr/museum/notice.do?id=7');
expect('같은 주소는 처음 것만 둔다', byText('연혁(다시)'), null);
expect('href="#"과 javascript:, mailto: 링크는 뽑지 않는다', [byText('메뉴 펼치기'), byText('전시 해설'), byText('문의')], [null, null, null]);
expect('글자가 없으면 title의 글자를 쓴다', byText('오시는 길'), 'https://www.example.go.kr/museum/contents.do?key=13');
expect('글자도 title도 없는 링크는 뽑지 않는다', links.some((l) => l.url.endsWith('key=14')), false);
expect('스크립트 안의 글은 링크로 읽지 않는다', links.some((l) => l.url.endsWith('/hidden')), false);
expect('바깥 사이트와 파일 링크도 일단 뽑는다(같은 사이트인지와 형식은 쓰는 쪽에서 가린다)', [byText('바깥 링크'), byText('안내문 내려받기')], ['https://other.example.org/page', 'https://www.example.go.kr/files/guide.pdf']);
expect('뽑은 링크의 수', links.length, 7);
// 본문 글을 뽑을 때는 전과 같이 메뉴를 뺀다
const text = extractPageText(html).blocks.join(' / ');
expect('본문 글에는 메뉴의 글자가 들어가지 않는다', [text.includes('연혁'), text.includes('본문입니다')], [false, true]);

console.log(failed ? `\n실패 ${failed}건` : '\n모두 통과');
process.exit(failed ? 1 : 0);
