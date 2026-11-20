// 원문 수집 시험의 공통 부분.
// 앱의 진단 경로(app/api/diag/fetch-probe)와 PC용 명령(tools/fetch_probe.mjs)이 같이 쓴다.
// 사이트가 거부하면 그대로 실패로 적는다. 브라우저인 척하거나 헤더를 바꿔 다시 열지 않는다.
import { extractPageText } from './gather/page-text.ts';
import { USER_AGENT, decodeBody, safeGet } from './net/safe-get.ts';

/**
 * [이름, 주소, 본문에 있어야 하는 핵심어]
 * @type {ReadonlyArray<readonly [string, string, string]>}
 */
export const TARGETS = [
  ['한국은행 현용 화폐', 'https://www.bok.or.kr/portal/main/contents.do?menuNo=200377', '천상열차분야지도'],
  ['정책브리핑 기사', 'https://www.korea.kr/news/policyNewsView.do?newsId=148680499', '천상열차분야지도'],
  ['국립고궁박물관 상세', 'https://www.gogung.go.kr/gogung/pgm/psgudMng/appointView.do?psgudSn=357802&menuNo=800067&gubunCd=PSGUD_006', '천상열차분야지도'],
  ['국가유산포털 상세', 'https://www.heritage.go.kr/heri/cul/culSelectDetail.do?ccbaKdcd=11&ccbaAsno=0002280000000&ccbaCtcd=11', '천상열차분야지도'],
  ['학술지(KoreaScience)', 'https://koreascience.kr/article/JAKO201810866006924.page', '점판암'],
  ['한국민족문화대백과', 'https://encykorea.aks.ac.kr/Article/E0055909', '천상열차분야지도'],
  ['국가법령정보센터', 'https://www.law.go.kr/법령/문화유산의보존및활용에관한법률', '문화유산'],
  ['유네스코 세계유산', 'https://whc.unesco.org/en/list/816', 'Changdeokgung'],
  ['위키백과', 'https://ko.wikipedia.org/wiki/천상열차분야지도', '천상열차분야지도'],
  ['한국고전종합DB', 'https://db.itkc.or.kr/', '고전'],
  ['조선왕조실록', 'https://sillok.history.go.kr/main/main.do', '실록'],
  ['국가통계포털', 'https://kosis.kr/index/index.do', '통계'],
];

/** 앱이 원문을 열 때 쓰는 이름. 자기가 누구인지 밝힌다. */
export { USER_AGENT };

/**
 * @typedef {object} ProbeResult
 * @property {boolean} ok 기대한 구절이 뽑은 본문에 있을 때만 성공으로 본다
 * @property {number | null} status
 * @property {string | null} charset
 * @property {number} koreanChars
 * @property {boolean} keywordFound
 * @property {number} seconds
 * @property {string | null} error
 */

/**
 * 페이지 하나를 열어 본문에 핵심어가 있는지 본다.
 * 앱이 근거를 모을 때와 같은 길(주소 검사, 크기와 시간 한도, 본문 추출)로 연다.
 * @param {string} url
 * @param {string} keyword
 * @param {number} [timeoutMs]
 * @returns {Promise<ProbeResult>}
 */
export async function probe(url, keyword, timeoutMs = 20000) {
  const got = await safeGet(url, { timeoutMs, maxBytes: 2_000_000 });
  if (!got.ok) {
    return {
      ok: false,
      status: got.status,
      charset: null,
      koreanChars: 0,
      keywordFound: false,
      seconds: got.seconds,
      error: got.status ? null : `${got.reason}${got.detail ? ` ${got.detail}` : ''}`,
    };
  }
  const decoded = decodeBody(got.body, got.contentType);
  const text = extractPageText(decoded.text).blocks.join(' ');
  const keywordFound = text.includes(keyword);
  return {
    ok: keywordFound,
    status: got.status,
    charset: decoded.charset,
    koreanChars: (text.match(/[가-힣]/g) ?? []).length,
    keywordFound,
    seconds: got.seconds,
    error: null,
  };
}

/**
 * 결과 한 줄을 사람이 읽는 글로 바꾼다.
 * @param {ProbeResult} r
 */
export function describe(r) {
  if (r.error) return `실패: ${r.error} (${r.seconds.toFixed(1)}초)`;
  return `HTTP ${r.status}, ${r.charset}, 한글 ${r.koreanChars}자, 핵심어 ${r.keywordFound ? '있음' : '없음'} (${r.seconds.toFixed(1)}초)`;
}
