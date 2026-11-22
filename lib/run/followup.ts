// 보강 검색(판정 뒤 한 번 더 찾기)을 언제 하고 무엇을 보낼지 정한다. 처음 검증과 고쳐 쓴 문장의 재검증이 함께 쓴다.
// 판정이 '근거 부족'으로 나오면, 모자랐던 근거를 겨냥해 한 번 더 찾고 그 묶음으로 한 번만 다시 판정한다.
// 같은 글을 다시 검증해 판정이 둘 생기는 것과는 다르다. 검증 하나가 끝나기 전에 스스로 한 번 더 찾아보는 것이다.
import { LIMITS } from '../limits.ts';
import type { EvidenceBundle, Judgment } from '../types.ts';

/** 한 번 더 찾아볼 판정인지. '근거 부족'이고, 그 묶음으로 아직 보강 검색을 하지 않았을 때다 */
export function needsFollowUp(judgment: Judgment, bundle: EvidenceBundle): boolean {
  return judgment.verdict === '근거 부족' && !bundle.followUp;
}

/** 판정에서 모자랐던 것. 서버가 검색어를 정하는 데 쓴다. 판정을 바꾼 규칙의 설명, 판정의 까닭, 권고를 이어 붙인다 */
export function missingNote(judgment: Judgment): string {
  return [judgment.lowered?.note ?? '', judgment.reason, judgment.action]
    .map((s) => s.trim())
    .filter(Boolean)
    .join(' / ')
    .slice(0, LIMITS.followUp.missingChars);
}

/** 보강 검색으로 새 발췌가 실렸는지. 실리지 않았으면 다시 판정하지 않는다 */
export function gainedEvidence(before: EvidenceBundle, after: EvidenceBundle): boolean {
  return after.evidence.length > before.evidence.length;
}
