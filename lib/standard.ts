// 검증 기준 파일(standards/*.json)을 읽어 코드에서 쓰기 좋게 내놓는다.
// 기준의 내용은 JSON에만 둔다. 파일을 바꿔 끼우면 코드를 고치지 않고 다른 기준으로 동작한다.
import profile from '../standards/culture-ko.json' with { type: 'json' };
import type { ClaimType, Grade } from './types.ts';

export interface RequirementOption {
  /** 이 등급 이상의 출처가 */
  grade: Grade;
  /** 몇 곳 있어야 하는지 */
  count: number;
  /** 그 출처들이 서로 독립이어야 하는지 */
  independent?: boolean;
  /** 문서 종류를 제한하는 경우(예: 학술 논문만) */
  docTypes?: string[];
}

export interface Requirement {
  /** '일치'에 필요한 근거. 이 가운데 하나를 채우면 된다 */
  anyOf: RequirementOption[];
  /** 못 채웠을 때의 판정 */
  shortfall: '근거 부족' | '해석 주의';
  /** 못 채웠지만 여러 보도가 같은 내용일 때의 판정 */
  shortfallIfSeveralReports?: '해석 주의';
  /** 2등급 근거 하나뿐이어도, 특정 값이 달려 있지 않은 서술이면 '단일 근거'로 표시하고 받아들일지 */
  allowSingleSource?: boolean;
  /** 모델에 보여 주는 설명 */
  need: string;
  ifShort: string;
}

export interface Standard {
  id: string;
  name: string;
  version: string;
  updated: string;
  about: string;
  references: Array<{ name: string; publisher: string; url: string; checked: string; used: string }>;
  documentTypes: Array<{ id: string; grade: Grade; gradeOutsideRole?: Grade; about: string; role?: string }>;
  requirements: Record<ClaimType, Requirement>;
  qualifiers: string[];
  /** 출처를 밝히지 않고 흐리는 말. 수정안에 이런 말이 새로 들어가면 알린다 */
  hedges: string[];
  /** 판정 지침. 판정 지시문에 그대로 들어간다 */
  judgeGuidelines: string[];
  priority: { about: string; high: string[]; mid: string[]; low: string[] };
  domains: {
    about: string;
    institutions: Array<{ domain: string; publisher: string }>;
    lowGradePlatforms: string[];
    excluded: Array<{ domain: string; why: string }>;
    provisional: { about: string; grade2: string[]; suffixes: Array<{ suffix: string; grade: Grade }> };
  };
}

export const STANDARD = profile as unknown as Standard;

function bare(hostname: string): string {
  return hostname.toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
}

/** 호스트가 그 도메인이거나 그 아래에 있는지 */
export function hostMatches(hostname: string, domain: string): boolean {
  const h = bare(hostname);
  return h === domain || h.endsWith(`.${domain}`);
}

/** 기관 도메인 목록에서 찾은 기관 이름. 없으면 빈 문자열 */
export function institutionOf(hostname: string): string {
  return STANDARD.domains.institutions.find((i) => hostMatches(hostname, i.domain))?.publisher ?? '';
}

/** 블로그, 위키, 커뮤니티 플랫폼인지. 여기에 실린 글은 문서 종류와 상관없이 3등급으로 묶는다 */
export function isLowGradePlatform(hostname: string): boolean {
  return STANDARD.domains.lowGradePlatforms.some((d) => hostMatches(hostname, d));
}

/** 열지 않는 사이트(동영상 등)면 그 이유, 아니면 빈 문자열 */
export function excludedReason(hostname: string): string {
  return STANDARD.domains.excluded.find((e) => hostMatches(hostname, e.domain))?.why ?? '';
}

/**
 * 잠정 등급. 원문을 열기 전에 도메인으로 어림한 값이며, 어느 페이지부터 열지 정하는 데만 쓴다.
 * 판정에 쓰는 등급은 본문을 확인한 뒤 문서 종류로 정한다.
 */
export function provisionalGrade(hostname: string): Grade {
  if (isLowGradePlatform(hostname)) return 3;
  const p = STANDARD.domains.provisional;
  // 기관이 운영하는 백과사전이나 해설 사이트는 기관 목록보다 먼저 걸러 2등급으로 어림한다
  if (p.grade2.some((d) => hostMatches(hostname, d))) return 2;
  if (institutionOf(hostname)) return 1;
  const h = bare(hostname);
  return p.suffixes.find((s) => h.endsWith(s.suffix))?.grade ?? 3;
}

/**
 * 수집 단계에서, 그 유형이 요구하는 등급의 출처가 모였는지 어림한다. 등급은 잠정 평가이고 출처 하나에 하나씩 넘긴다.
 * 출처들이 서로 독립인지는 판정에서야 알 수 있다. 그래서 1등급 하나로도 채울 수 있는 유형에서는
 * '서로 독립인 2등급 둘'을 채운 것으로 치지 않고, 1등급 출처가 있어야 모인 것으로 본다.
 * 2등급 둘이 유일한 길인 유형(통설)은 2등급 둘이 있으면 모인 것으로 본다.
 */
export function requirementMetBeforeJudging(type: ClaimType, grades: Grade[]): boolean {
  const options = STANDARD.requirements[type]?.anyOf ?? [];
  const hasSingleSourcePath = options.some((o) => o.count <= 1);
  const usable = hasSingleSourcePath ? options.filter((o) => !o.independent) : options;
  return usable.some((o) => grades.filter((g) => g <= o.grade).length >= o.count);
}

/** 문서 종류의 목록에 없는 값이 오면 쓰는 종류 */
export const FALLBACK_DOC_TYPE = '그 밖의 글';

export function isDocType(id: string): boolean {
  return STANDARD.documentTypes.some((d) => d.id === id);
}

/**
 * 판정에 쓰는 등급. 문서 종류와, 그 명제에 대해 출처가 맡는 역할로 정한다.
 * @param ownFact 그 기관이 직접 정하거나 관리하는 사실인지(기관의 공식 안내에만 뜻이 있다)
 * @param lowPlatform 블로그, 위키, 커뮤니티 플랫폼의 글인지. 그러면 문서 종류와 상관없이 3등급이다
 */
export function finalGrade(docType: string, ownFact: boolean, lowPlatform: boolean): Grade {
  if (lowPlatform) return 3;
  const found = STANDARD.documentTypes.find((d) => d.id === docType);
  if (!found) return 3;
  if (found.gradeOutsideRole && !ownFact) return found.gradeOutsideRole;
  return found.grade;
}
