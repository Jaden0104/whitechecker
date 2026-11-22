// 단계마다 거는 상한(PRD F16). 초기값이며 시험해 보고 조정한다.
export const LIMITS = {
  extract: {
    /** 한 번에 보내는 문장들의 글자 수 합. 2026-11-20 시험에서 명제 하나에 출력이 약 170토큰이라 800자로 잡았다 */
    inputChars: 800,
    /** 앞 문맥으로 함께 보내는 글자 수 */
    contextChars: 400,
    /** 뒤 문맥으로 함께 보내는 글자 수. 한 문장만 다시 검증할 때 바로 뒤에 이어지는 한두 문장을 보낸다(F14) */
    afterChars: 200,
    outputTokens: 6000,
  },
  gather: {
    /** 검색어 수(기본 2, 반증 1, 추가 1). 다시 시도한 호출은 따로 센다 */
    queries: 4,
    pages: 4,
    pageBytes: 2_000_000,
    pageTimeoutMs: 20_000,
    excerptChars: 8000,
    decideTokens: 300,
    /** 검색 한 번에 받는 결과 수. Liner의 웹 검색은 건당 요금이라 결과를 더 받아도 값이 같다 */
    maxResults: 10,
  },
  /** 보강 검색: 판정이 '근거 부족'일 때 모자랐던 근거를 겨냥해 한 번 더 찾는다. 검색 1회, 새로 여는 페이지와 더 싣는 발췌의 상한 */
  followUp: {
    pages: 3,
    attempts: 8,
    excerptChars: 4000,
    missingChars: 600,
    /** 안쪽 페이지 열기: 앞서 연 기관 사이트의 페이지에서 링크를 읽어 올 곳의 수, 그 가운데 열어 볼 링크의 수, 링크를 읽을 때 기다리는 시간 */
    linkSources: 2,
    linkPages: 2,
    linkTimeoutMs: 8000,
  },
  judge: { outputTokens: 2000 },
  merge: { outputTokens: 1000 },
  /** 수정안의 다듬기 검사. 문장 하나를 다시 적는 정도다 */
  polish: { outputTokens: 800 },
  /** 요청 하나의 처리 시간. 다시 시도하느라 기다린 시간과 원문 수집 시간을 포함한다 */
  requestMs: 60_000,
  /** 호출 하나를 다시 시도하는 횟수 */
  retriesPerCall: 2,
  /** 요청 하나에서 다시 시도하는 횟수의 합 */
  retriesPerRequest: 4,
  /** 실행 하나가 처리하는 명제 수(화면 쪽 설정값) */
  claimsPerRun: 150,
  /** 동시에 처리하는 명제 수의 기본값 */
  concurrency: 5,
} as const;
