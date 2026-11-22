// 보강 검색(판정 뒤 한 번 더 찾기)을 언제 하고 무엇을 보낼지 정한다. 처음 검증과 고쳐 쓴 문장의 재검증이 함께 쓴다.
// 아래 두 경우에 모자란 근거를 겨냥해 한 번 더 찾고, 새 근거가 실렸으면 그 묶음으로 한 번만 다시 판정한다.
// - 판정이 '근거 부족'이다
// - 판정이 '불일치'인데 반박 근거가 2등급 자료 한 곳뿐이다(그 자료가 틀렸거나 자료마다 값이 다를 수 있다)
// 같은 글을 다시 검증해 판정이 둘 생기는 것과는 다르다. 검증 하나가 끝나기 전에 스스로 한 번 더 찾아보는 것이다.
import { SINGLE_REFUTER_FLAG } from '../flags.ts';
import { LIMITS } from '../limits.ts';
import type { EvidenceBundle, Judgment } from '../types.ts';

/** 반박 근거가 한 곳뿐인 불일치인지 */
const thinMismatch = (judgment: Judgment) => judgment.verdict === '불일치' && judgment.flags.includes(SINGLE_REFUTER_FLAG);

/** 한 번 더 찾아볼 판정인지. 그 묶음으로 아직 보강 검색을 하지 않았을 때만이다 */
export function needsFollowUp(judgment: Judgment, bundle: EvidenceBundle): boolean {
  if (bundle.followUp) return false;
  return judgment.verdict === '근거 부족' || thinMismatch(judgment);
}

/** 판정에서 모자랐던 것. 서버가 검색어를 정하는 데 쓴다. 판정을 바꾼 규칙의 설명, 판정의 까닭, 권고를 이어 붙인다 */
export function missingNote(judgment: Judgment): string {
  const lead = thinMismatch(judgment)
    ? '원고와 다르게 적은 자료가 2등급 한 곳뿐이다. 그 사실을 직접 정하거나 관리하는 곳의 자료나, 같은 내용을 따로 적은 다른 기관의 자료로 확인해야 한다'
    : '';
  return [lead, judgment.lowered?.note ?? '', judgment.reason, judgment.action]
    .map((s) => s.trim())
    .filter(Boolean)
    .join(' / ')
    .slice(0, LIMITS.followUp.missingChars);
}

/** 보강 검색으로 새 발췌가 실렸는지. 실리지 않았으면 다시 판정하지 않는다 */
export function gainedEvidence(before: EvidenceBundle, after: EvidenceBundle): boolean {
  return after.evidence.length > before.evidence.length;
}
