// 단계마다 거는 상한(PRD F16). 초기값이며 시험해 보고 조정한다.
export const LIMITS = {
  extract: {
    /** 한 번에 보내는 문장들의 글자 수 합. 2026-11-20 시험에서 명제 하나에 출력이 약 170토큰이라 800자로 잡았다 */
    inputChars: 800,
    /** 앞 문맥으로 함께 보내는 글자 수 */
    contextChars: 400,
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
  },
  judge: { outputTokens: 2000 },
  merge: { outputTokens: 1000 },
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
