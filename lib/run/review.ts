// 편집자의 선택(F10): 문장마다 수정안을 채택하거나, 고쳐 쓰거나, 보류한다.
// 상태를 바꾸는 계산만 한다. 저장과 화면은 부르는 쪽이 맡는다.
import { autoRevision, candidateText, reviewOf, type ReviewEntry, type RunState } from './model.ts';

export type ReviewAction =
  | { kind: 'adopt' }
  | { kind: 'unadopt' }
  | { kind: 'hold' }
  | { kind: 'unhold' }
  /** 고쳐 쓴 글을 저장한다 */
  | { kind: 'save'; text: string }
  /** 고쳐 쓴 글을 버리고 자동 수정안(없으면 원문)으로 돌아간다 */
  | { kind: 'revert' };

export interface ReviewOutcome {
  run: RunState;
  /** 화면에 한 번 알릴 말. 없으면 빈 문자열 */
  notice: string;
}

/** 고쳐 쓴 글을 한 줄로 다듬는다. 문장 하나는 원고에서 한 줄 안에 놓이므로 줄바꿈은 빈칸으로 바꾼다 */
export function tidyEdit(text: string): string {
  return text.replace(/\s*[\r\n]+\s*/g, ' ').trim();
}

export function applyReview(run: RunState, sentenceId: number, action: ReviewAction, at: string): ReviewOutcome {
  const sentence = run.sentences.find((s) => s.id === sentenceId);
  if (!sentence) return { run, notice: '' };
  const before = reviewOf(run, sentenceId);
  const candidateBefore = candidateText(run, sentenceId);
  let next: ReviewEntry = { ...before, at };
  let rechecks = run.rechecks;
  let notice = '';

  if (action.kind === 'adopt') {
    if (candidateBefore === null) return { run, notice: '채택할 수정안이 없습니다. 고쳐 쓴 뒤에 채택할 수 있습니다.' };
    next.choice = '채택';
  } else if (action.kind === 'hold') {
    next.choice = '보류';
  } else if (action.kind === 'unadopt' || action.kind === 'unhold') {
    next.choice = '';
  } else if (action.kind === 'save') {
    const text = tidyEdit(action.text);
    if (!text) return { run, notice: '빈 글은 저장할 수 없습니다.' };
    if (text === sentence.source) {
      // 원문과 같게 고쳤으면 고쳐 쓴 것으로 치지 않는다
      next.edited = null;
      notice = '원문과 같습니다. 원문 그대로 두려면 보류를 고르면 됩니다.';
    } else {
      // 자동 수정안과 같으면 자동 수정안으로 돌아간다
      next.edited = text === autoRevision(run, sentenceId)?.revised ? null : text;
    }
  } else {
    next.edited = null;
    // 고쳐 쓴 글에 대한 재검증 결과는 그 글과 함께 치운다
    if (rechecks?.[sentenceId]?.target === 'edited') {
      rechecks = { ...rechecks };
      delete rechecks[sentenceId];
    }
  }

  const candidateAfter = next.edited !== null ? next.edited : (autoRevision(run, sentenceId)?.revised ?? null);
  // 수정안이 달라졌으면 앞서 한 채택은 풀어, 새 글을 보고 다시 고르게 한다
  if (candidateAfter !== candidateBefore && before.choice === '채택') {
    next.choice = '';
    notice = '수정안이 바뀌어 채택을 풀었습니다. 새 수정안을 보고 다시 골라 주십시오.';
  }
  if (next.choice === before.choice && next.edited === before.edited) next = before;

  const reviews = { ...run.reviews };
  if (next.choice === '' && next.edited === null) delete reviews[sentenceId];
  else reviews[sentenceId] = next;
  return { run: { ...run, reviews, rechecks }, notice };
}
