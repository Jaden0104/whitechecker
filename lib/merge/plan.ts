// 한 문장에 연결된 명제들을 보고, 수정안을 만들 때가 됐는지와 무엇을 합칠지를 정한다(PRD F7).
// Liner를 부르지 않는다. 화면이 [수정안 합치기]를 요청하기 전에 쓴다.
import type { Fix, MergeFix, SourceInfo, SourceRating, Verdict } from '../types.ts';

/**
 * 인용형 수정안에서 밝힐 출처의 이름. 판정이 가리킨 출처, 곧 실제로 열어 보고 등급을 매긴 자료의 이름이다.
 * 검증 기준 파일의 기관 목록에 있는 이름을 먼저 쓰고, 없으면 판정이 적은 발행 주체, 그것도 없으면 사이트 주소를 쓴다.
 * 판정이 고칠 내용에 다른 이름을 적었더라도 이 이름을 쓴다. 확인한 출처만 밝히기 위해서다.
 */
export function citedSourceName(fix: Fix | null, ratings: SourceRating[], sources: SourceInfo[]): string {
  if (!fix || fix.kind !== '인용형' || fix.sourceNo === null) return '';
  const info = sources.find((s) => s.no === fix.sourceNo);
  const rating = ratings.find((r) => r.sourceNo === fix.sourceNo);
  return info?.publisherHint || rating?.publisher || info?.hostname.replace(/^www\./, '') || '';
}

/** 문장에 연결된 명제 하나의 지금 상태 */
export interface SentenceClaim {
  claimId: string;
  statement: string;
  /** 처리 상태(F16) */
  state: '대기' | '진행 중' | '완료' | '실패' | '중단';
  /** 사실 판정. 처리가 끝나지 않았으면 null */
  verdict: Verdict | null;
  /** 판정이 낸 고칠 내용 */
  fix: Fix | null;
  /** 인용형일 때 밝힐 출처의 이름 */
  sourceName: string;
}

export interface MergePlan {
  /** 연결된 명제의 처리가 모두 끝났는지. 실패, 중단, 대기인 것이 있으면 수정안을 만들지 않고 기다린다 */
  ready: boolean;
  /** 합칠 고칠 내용. 비어 있으면 [수정안 합치기]를 부를 필요가 없다 */
  fixes: MergeFix[];
}

export function planMerge(claims: SentenceClaim[]): MergePlan {
  const ready = claims.length > 0 && claims.every((c) => c.state === '완료');
  const fixes: MergeFix[] = [];
  if (ready) {
    for (const c of claims) {
      if (!c.fix || c.fix.kind === '없음' || !c.fix.instruction) continue;
      fixes.push({ claimId: c.claimId, statement: c.statement, kind: c.fix.kind, instruction: c.fix.instruction, sourceName: c.sourceName });
    }
  }
  return { ready, fixes };
}

/**
 * 수정안을 채택해도 해결되지 않고 남는 명제. 경고가 붙었는데(불일치, 근거 부족, 해석 주의, 직접 확인) 반영된 수정이 없는 것이다.
 * 이런 명제는 확인된 것으로 적지 않고 검토 기록에 미해결로 남긴다.
 */
export function unresolvedAfter(claims: SentenceClaim[], applied: string[]): string[] {
  return claims.filter((c) => c.verdict !== null && c.verdict !== '일치' && !applied.includes(c.claimId)).map((c) => c.claimId);
}
