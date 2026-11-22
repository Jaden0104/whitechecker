// 화면과 서버가 같이 쓰는 자료의 모양. 검증 단위는 명제, 교체 단위는 문장이다.

/** 문장이 놓인 자리의 종류 */
export type BlockKind = 'heading' | 'paragraph' | 'listItem' | 'table' | 'caption' | 'footnote';

export interface Sentence {
  /** 원고 안에서 1부터 매긴 번호 */
  id: number;
  /** 원고 글자열 안의 시작 위치 */
  start: number;
  /** 원고 글자열 안의 끝 위치(이 위치의 글자는 포함하지 않는다) */
  end: number;
  /** 원고에 적힌 그대로의 글자. Markdown 표시를 포함한다 */
  source: string;
  /** Markdown 표시를 걷어 낸 글. 모델에 보내고 화면에 보여 주는 데 쓴다 */
  plain: string;
  kind: BlockKind;
  /** 같은 문단에 속한 문장끼리 같은 번호를 갖는다 */
  block: number;
  /** 문장 안에 링크나 각주 표시가 있다 */
  hasLinkOrFootnote: boolean;
  /** 문장 안에 굵은 글씨 같은 강조 표시가 있다 */
  hasEmphasis: boolean;
  /** 수정안을 자동으로 반영할 수 있는 문장인지 */
  autoApply: boolean;
}

export const CLAIM_TYPES = [
  '인용·출처 귀속',
  '수치·통계',
  '제원·실측',
  '분류·지정',
  '운영 정보',
  '연대·인명·기관명',
  '통설',
  '최상급',
  '인과',
  '기타',
] as const;

export type ClaimType = (typeof CLAIM_TYPES)[number];

export interface Claim {
  /** 예: "s12-c1" (12번 문장의 첫 명제) */
  id: string;
  /** 이 명제가 나온 문장의 번호 */
  sentenceId: number;
  /** 독립 명제. 지시어와 생략된 주어를 풀어 그 문장만으로 뜻이 통하게 쓴 것 */
  statement: string;
  type: ClaimType;
  /** 한정 표현. 예: 유일, 최초, 매일 */
  qualifiers: string[];
  /** 기준 시점. 명제가 언제의 사실을 말하는지. 없으면 "현재" */
  asOf: string;
  /** 공개 자료로 확인할 수 있는 성격의 주장인지 */
  isPublic: boolean;
  /** 공개 자료로 확인할 수 없는 경우 그 이유 */
  privateReason: string;
  /** 근거를 찾을 검색어 */
  queries: string[];
  /** 반대 근거를 찾을 검색어. 통설, 최상급, 인용 귀속 유형에만 둔다 */
  counterQuery: string;
}

/** 출처 등급. 1이 가장 높다 */
export type Grade = 1 | 2 | 3;

/**
 * 검색의 종류. 기본 검색 2회, 반증 검색 1회, 추가 검색 1회까지.
 * '보강'은 판정이 '근거 부족'으로 나온 뒤, 모자랐던 근거를 겨냥해 한 번 더 하는 검색이다
 */
export type SearchKind = '기본' | '반증' | '추가' | '보강';

export interface SearchRecord {
  query: string;
  kind: SearchKind;
  /** 기간을 걸었으면 그 값(예: past_year) */
  dateRange: string | null;
  results: number;
  /** 실패했으면 그 사유 */
  error: string | null;
}

/** 원문 수집의 결과 */
export interface FetchOutcome {
  status: '성공' | '실패' | '관련 내용 없음' | '열지 않음';
  /** 실패나 제약의 사유. 예: 접근 제한, 시간 초과, 본문 없음 */
  reason: string;
  /** 뽑은 본문의 글자 수 */
  chars: number;
  /** 크기 한도에 걸려 앞부분만 읽었다 */
  truncated: boolean;
  fetchedAt: string | null;
}

export interface SourceInfo {
  /** 출처 번호 */
  no: number;
  url: string;
  title: string;
  hostname: string;
  /** 검색 결과가 알려 준 날짜 */
  date: string | null;
  /** 페이지가 스스로 밝힌 작성일이나 수정일 */
  pageDate: string | null;
  /** 검색 결과의 요약. 근거로 쓰지 않는다 */
  summary: string;
  foundBy: SearchKind[];
  /** 잠정 등급. 원문을 열기 전의 어림이며 판정에 쓰지 않는다 */
  provisionalGrade: Grade;
  /** 기관 도메인 목록에서 찾은 기관 이름. 없으면 빈 문자열 */
  publisherHint: string;
  /** 블로그, 커뮤니티 플랫폼인지. 그러면 문서 종류와 상관없이 3등급이다 */
  lowPlatform: boolean;
  fetch: FetchOutcome;
}

/** 근거. 수집한 본문에서 코드가 그대로 잘라 낸 대목이다 */
export interface Evidence {
  /** 근거 번호 */
  no: number;
  sourceNo: number;
  text: string;
}

/** Liner 검색이 함께 돌려준 데이터(Premium Data). 오지 않는 질의가 많다 */
export interface PremiumData {
  title: string;
  description: string;
  dataAsOf: string | null;
  sources: string[];
}

/** 명제 하나의 근거 묶음. 서버가 서명해 돌려주고, 판정 요청은 서명이 맞는 묶음만 받는다 */
export interface EvidenceBundle {
  v: 1;
  /** 명제의 식별값. 다른 명제의 근거와 섞이면 판정에서 거부한다 */
  claimKey: string;
  gatheredAt: string;
  searches: SearchRecord[];
  sources: SourceInfo[];
  evidence: Evidence[];
  /** 추가 검색을 했는지와 그 까닭 */
  extraSearch: { done: boolean; reason: string };
  premium: PremiumData[];
  /**
   * 판정이 '근거 부족'으로 나온 뒤 한 번 더 찾아본 기록(보강 검색). 찾아보지 않은 묶음에는 없다.
   * done은 검색을 실제로 했는지, added는 새로 실은 발췌의 수다. 한 묶음에 한 번만 한다
   */
  followUp?: { done: boolean; reason: string; added: number };
}

/** 근거 묶음의 식별값을 만드는 데 들어가는 명제의 항목 */
export type ClaimCore = Pick<Claim, 'statement' | 'type' | 'qualifiers' | 'asOf'>;

/** 사실 판정. '직접 확인'은 추출 단계에서 정해지고, 판정 단계는 앞의 넷 가운데 하나를 낸다 */
export type Verdict = '일치' | '불일치' | '근거 부족' | '해석 주의' | '직접 확인';

/** 근거와 명제의 관계 */
export type Relation = '지지' | '반박' | '판단 불충분';

/** 근거를 이 명제의 판단에 쓸 수 있는지 */
export type Applicability = '적용 가능' | '적용 불가' | '미확인';

export type Priority = '상' | '중' | '하';

export type FixKind = '교정안' | '인용형' | '축소안' | '없음';

/** 출처의 최종 평가. 문서 종류와 발행 주체는 모델이 고르고, 등급은 코드가 기준 파일의 표로 정한다 */
export interface SourceRating {
  sourceNo: number;
  docType: string;
  publisher: string;
  /** 그 기관이 직접 정하거나 관리하는 사실인지 */
  ownFact: boolean;
  grade: Grade;
  /** 기관 목록에 없는 곳의 글을 1등급으로 봤다. 편집자가 발행 주체를 확인할 수 있게 표시한다 */
  publisherUnlisted: boolean;
  /** 판정의 근거로 쓰지 않는 자료면 그 까닭(예: 위키). 근거로 쓰는 자료에는 두지 않는다 */
  notUsed?: string;
}

/** 두 출처의 관계. 여기에 없는 쌍은 '미확인'이다 */
export interface SourceLink {
  a: number;
  b: number;
  status: '중복' | '독립 추정';
  reason: string;
}

export interface EvidenceUse {
  evidenceNo: number;
  sourceNo: number;
  relation: Relation;
  /** 대상, 범위, 시점 */
  target: Applicability;
  scope: Applicability;
  time: Applicability;
  /** 모델이 근거 번호와 함께 낸 인용문 */
  quote: string;
  /** 인용문이 그 번호의 발췌 안에 실제로 있는지(코드가 검사) */
  quoteFound: boolean;
  /** 모델이 적은 근거 번호. 인용문이 같은 출처의 다른 발췌에 있어 코드가 번호를 바로잡았을 때만 둔다 */
  correctedFrom?: number;
  /** 판정을 정하는 데 쓸 수 있는지: 인용문이 있고, 대상·범위·시점이 모두 적용 가능하고, 관계가 지지나 반박이다 */
  usable: boolean;
}

export interface QualifierCheck {
  text: string;
  result: '출처와 같다' | '출처와 다르다' | '확인하지 못했다';
  note: string;
}

/** 이 명제 때문에 문장에서 고칠 내용. 문장의 수정안은 [수정안 합치기]가 이것들을 모아 만든다 */
export interface Fix {
  kind: FixKind;
  instruction: string;
  /** 인용형일 때 이름을 밝힐 출처 */
  sourceNo: number | null;
}

export interface Judgment {
  verdict: Verdict;
  /** 모델이 낸 판정. 코드가 바꾸지 않았으면 verdict와 같다 */
  modelVerdict: Verdict;
  /** 코드가 판정을 바꿨으면 어느 규칙(5.3절의 번호)으로 왜 바꿨는지 */
  lowered: { rule: string; note: string } | null;
  reason: string;
  /** 권고 조치 */
  action: string;
  /** 편집 우선순위. '일치'에는 매기지 않는다 */
  priority: Priority | null;
  /** 수정안을 하나로 정할 수 없어 편집자가 골라야 한다 */
  needChoice: boolean;
  /** 화면에 함께 보여 줄 표시. 예: 단일 근거 */
  flags: string[];
  sources: SourceRating[];
  links: SourceLink[];
  evidence: EvidenceUse[];
  qualifiers: QualifierCheck[];
  /** 적용 가능한 지지 근거와 반박 근거가 함께 있었는지. 있었으면 양쪽에서 가장 높은 등급 */
  conflict: { found: boolean; resolved: boolean; supportTop: Grade | null; refuteTop: Grade | null };
  fix: Fix;
  /** 확인일. 근거를 모은 날이다 */
  checkedAt: string;
  /** 검증한 문장의 식별값. 문장이 바뀌면 이 판정은 이전 문장에 대한 것이 된다 */
  sentenceKey: string;
}

/** [수정안 합치기]에 넘기는, 명제 하나의 고칠 내용. 판정의 고칠 내용 가운데 '없음'이 아닌 것만 넘긴다 */
export interface MergeFix {
  /** 명제의 번호. 예: "s6-c1" */
  claimId: string;
  /** 독립 명제. 문장의 어느 대목을 가리키는지 알려 주는 데 쓴다 */
  statement: string;
  kind: Exclude<FixKind, '없음'>;
  instruction: string;
  /** 인용형일 때 이름을 밝힐 출처. 없으면 빈 문자열 */
  sourceName: string;
}

/** 원문과 수정안에서 달라진 숫자와 낱말. 편집자가 눈으로 확인하도록 화면에 보여 준다 */
export interface RevisionChanges {
  numbersRemoved: string[];
  numbersAdded: string[];
  wordsRemoved: string[];
  wordsAdded: string[];
}

/** 문장 하나의 통합 수정안. 모델은 바꿀 대목만 내고, 문장은 코드가 그 대목만 바꿔서 만든다 */
export interface SentenceRevision {
  /** 고친 문장(원고에 적힌 꼴, Markdown 표시 포함). 반영한 것이 없으면 null */
  revised: string | null;
  /** 실제로 바꾼 대목. 이 밖의 글자는 원문 그대로다 */
  edits: Array<{ before: string; after: string; claimIds: string[] }>;
  /** 반영한 명제의 번호 */
  applied: string[];
  /** 반영하지 못한 명제와 그 까닭 */
  skipped: Array<{ claimId: string; why: string }>;
  /** 반영한 수정의 종류 */
  kinds: FixKind[];
  changes: RevisionChanges;
  /** 화면에 함께 보여 줄 주의. 예: 고칠 내용에 적히지 않은 숫자가 들어갔다 */
  cautions: string[];
  /** 강조, 링크, 각주 표시가 원문과 같은지. 다르면 자동으로 반영하지 않는다 */
  markupKept: boolean;
  polish: PolishResult;
  /** 수정안을 만든 문장의 식별값. 문장이 바뀌면 이 수정안은 이전 문장에 대한 것이 된다 */
  sentenceKey: string;
}

/**
 * 다듬기 검사의 결과. 코드가 대목만 바꿔 만든 문장을 모델에 다시 읽혀 문법만 손본다.
 * - 검사 안 함: 수정안이 없다
 * - 고칠 곳 없음: 모델이 자연스럽다고 봤다
 * - 다듬음: 모델이 다듬었고, 숫자·낱말·표시가 그대로인 것을 코드가 확인해 받아들였다
 * - 다듬지 못함: 모델이 어색하다고 봤지만 다듬은 결과를 받아들일 수 없었다. 수정안은 다듬기 전 그대로다
 * - 검사 실패: 모델 호출이 실패했다. 수정안은 다듬기 전 그대로다
 */
export interface PolishResult {
  state: '검사 안 함' | '고칠 곳 없음' | '다듬음' | '다듬지 못함' | '검사 실패';
  /** 모델이 짚은 어색한 곳. 없으면 빈 문자열 */
  problem: string;
  /** 다듬기 전의 문장. '다듬음'일 때만 둔다 */
  draft: string | null;
}

/** Liner 호출 한 번의 사용량 */
export interface Usage {
  stage: string;
  model: string;
  promptTokens: number;
  /** 입력 토큰 가운데 캐시에서 읽은 것. 값이 입력의 20분의 1이다 */
  cachedTokens?: number;
  /** 입력 토큰 가운데 캐시에 새로 쓴 것. 값이 입력보다 4분의 1 비싸다 */
  cacheWriteTokens?: number;
  completionTokens: number;
  searchCalls: number;
  seconds: number;
}
