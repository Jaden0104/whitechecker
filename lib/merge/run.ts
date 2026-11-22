// [수정안 합치기] 문장 하나와 그 문장에 걸린 고칠 내용을 받아, 문장의 수정안을 한 번 만든다(PRD F7).
// 1. 모델에는 바꿀 대목만 묻고, 문장은 코드가 그 대목만 바꿔서 만든다
// 2. 만든 문장을 모델에 다시 읽혀, 이음매가 어긋났으면 문법만 다듬는다(숫자·낱말·표시가 그대로일 때만 받는다)
// 3. 원문과 견줘 달라진 것을 뽑는다
import { LIMITS } from '../limits.ts';
import { chatJson, type Budget } from '../liner.ts';
import { MERGE_SCHEMA, MERGE_SYSTEM, mergeUserMessage } from '../prompts/merge.ts';
import { contentId } from '../sentences.ts';
import { STANDARD } from '../standard.ts';
import type { FixKind, MergeFix, PolishResult, SentenceRevision, Usage } from '../types.ts';
import { applyEdits, reviewRevision, type ModelMerge } from './check.ts';
import { polishDraft } from './polish.ts';

export interface MergeInput {
  /** 원고에 적힌 그대로의 문장(Markdown 표시 포함). 수정안도 이 꼴로 돌려준다 */
  sentence: string;
  fixes: MergeFix[];
}

const NO_CHANGES = { numbersRemoved: [], numbersAdded: [], wordsRemoved: [], wordsAdded: [] };
const NOT_POLISHED: PolishResult = { state: '검사 안 함', problem: '', draft: null };

/** 모델의 답으로 수정안을 확정한다. Liner를 부르지 않으므로 따로 시험할 수 있다 */
export function buildRevision(input: MergeInput, model: ModelMerge): SentenceRevision {
  const { sentence, fixes } = input;
  const result = applyEdits(
    sentence,
    model,
    fixes.map((f) => f.kind),
    // 추측이나 전언임을 나타내는 말이 고친 대목에서 사라지는 수정은 받지 않는다
    { hedges: STANDARD.hedges ?? [], instructions: fixes.map((f) => f.instruction) },
  );
  const idOf = (n: number) => fixes[n - 1].claimId;
  const appliedFixes = result.applied.map((n) => fixes[n - 1]);
  const review = result.revised
    ? reviewRevision(sentence, result.revised, appliedFixes, STANDARD.hedges ?? [])
    : { changes: NO_CHANGES, cautions: [], markupKept: true };
  return {
    revised: result.revised,
    edits: result.edits.map((e) => ({ before: e.before, after: e.after, claimIds: e.claims.map(idOf) })),
    applied: result.applied.map(idOf),
    skipped: result.skipped.map((s) => ({ claimId: idOf(s.claim), why: s.why })),
    kinds: [...new Set<FixKind>(appliedFixes.map((f) => f.kind))],
    changes: review.changes,
    cautions: review.cautions,
    markupKept: review.markupKept,
    polish: NOT_POLISHED,
    sentenceKey: contentId(sentence),
  };
}

/** 다듬기 검사의 결과를 수정안에 반영한다. 다듬은 문장을 받아들였으면 달라진 것을 그 문장으로 다시 뽑는다 */
export function withPolish(input: MergeInput, revision: SentenceRevision, text: string, polish: PolishResult): SentenceRevision {
  if (!revision.revised) return revision;
  const appliedFixes = input.fixes.filter((f) => revision.applied.includes(f.claimId));
  const review = reviewRevision(input.sentence, text, appliedFixes, STANDARD.hedges ?? []);
  const cautions = [...review.cautions];
  if (polish.state === '다듬지 못함') cautions.push(`문장이 어색할 수 있다: ${polish.problem}`);
  if (polish.state === '검사 실패') cautions.push('문장이 자연스러운지 검사하지 못했다');
  return { ...revision, revised: text, changes: review.changes, cautions, markupKept: review.markupKept, polish };
}

export async function mergeSentence(input: MergeInput, key: string, budget: Budget): Promise<{ revision: SentenceRevision; usage: Usage[] }> {
  // 합칠 것이 없으면 모델을 부르지 않는다
  if (input.fixes.length === 0) return { revision: buildRevision(input, { edits: [], skipped: [] }), usage: [] };

  const { value, usage } = await chatJson<ModelMerge>({
    stage: '수정안 합치기',
    key,
    system: MERGE_SYSTEM,
    user: mergeUserMessage(input.sentence, input.fixes),
    schemaName: 'sentence_edits',
    schema: MERGE_SCHEMA,
    maxTokens: LIMITS.merge.outputTokens,
    budget,
    // 품질 우선으로 고정한다. 2026-11-21에 견줘 보니 품질 우선과 기본은 같은 모델이 응답해 결과와 값이 같았고,
    // 싼 모델은 빼면 안 되는 대목을 빼서 깨진 문장을 냈다
    routingStrategy: 'quality',
  });
  const revision = buildRevision(input, value);
  if (!revision.revised) return { revision, usage: [usage] };

  const polished = await polishDraft(
    {
      original: input.sentence,
      draft: revision.revised,
      inserted: revision.edits.map((e) => e.after),
      instructions: input.fixes.filter((f) => revision.applied.includes(f.claimId)).map((f) => f.instruction),
    },
    key,
    budget,
  );
  return { revision: withPolish(input, revision, polished.text, polished.result), usage: [usage, ...polished.usage] };
}
