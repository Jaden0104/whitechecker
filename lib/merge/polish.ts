// 다듬기 검사: 코드가 대목만 바꿔 만든 문장을 모델에 다시 읽혀, 이음매가 어긋났으면 문법만 다듬는다.
// 다듬은 문장은 그대로 받지 않는다. 숫자, 낱말, 표시가 그대로인 것을 코드가 확인한 뒤에만 쓴다.
import { LIMITS } from '../limits.ts';
import { chatJson, LinerError, type Budget, type ChatOptions } from '../liner.ts';
import { POLISH_SCHEMA, POLISH_SYSTEM, polishUserMessage, type ModelPolish } from '../prompts/polish.ts';
import type { PolishResult, Usage } from '../types.ts';
import { acceptPolish } from './check.ts';

/**
 * 다듬기 검사에 쓰는 모델을 고르는 방식. 품질 우선으로 보낸다.
 * Liner에서는 모델을 직접 지정할 수 없고, 라우터가 요청을 보고 고른다. 방식은 무엇을 먼저 볼지만 정한다.
 * 2026-11-21에 같은 문장 7개로 세 방식을 견줬다(tools/compare_polish.mjs). 셋 다 깨진 문장 3개를 고치고 멀쩡한 4개는 그대로 뒀다.
 * 품질 우선은 매번 claude-sonnet-5.5가 응답했고 어색한 곳의 설명이 정확했다. 기본(균형)은 claude-haiku-5.5가 섞여 응답했고,
 * 비용 우선(claude-haiku-5.5)은 고치기는 했지만 설명이 틀린 것이 있었다.
 */
export const POLISH_ROUTING: ChatOptions['routingStrategy'] = 'quality';

export interface PolishInput {
  /** 원고의 원래 문장 */
  original: string;
  /** 코드가 대목만 바꿔 만든 문장 */
  draft: string;
  /** 수정으로 바꿔 넣은 대목들 */
  inserted: string[];
  /** 반영한 고칠 내용의 글. 여기에 적힌 말은 다듬은 뒤에도 남아 있어야 한다 */
  instructions: string[];
}

export interface PolishOutput {
  /** 쓸 문장. 다듬은 것을 받아들였으면 다듬은 문장, 아니면 draft 그대로 */
  text: string;
  result: PolishResult;
  usage: Usage[];
}

/** 모델의 답으로 다듬기 결과를 확정한다. Liner를 부르지 않으므로 따로 시험할 수 있다 */
export function settlePolish(input: PolishInput, model: ModelPolish): { text: string; result: PolishResult } {
  const problem = typeof model?.problem === 'string' ? model.problem.trim().slice(0, 160) : '';
  const polished = typeof model?.polished === 'string' ? model.polished.trim() : '';
  if (model?.natural === true || !polished || polished === input.draft) {
    // 어색하다고 하면서 고친 문장을 내지 않았으면 알려만 준다
    if (model?.natural === false) return { text: input.draft, result: { state: '다듬지 못함', problem: problem || '어색하다고 봤지만 다듬은 문장이 없다', draft: null } };
    return { text: input.draft, result: { state: '고칠 곳 없음', problem: '', draft: null } };
  }
  const refused = acceptPolish(input.draft, polished, { original: input.original, inserted: input.inserted, instructions: input.instructions });
  if (refused) return { text: input.draft, result: { state: '다듬지 못함', problem: `${problem ? `${problem} / ` : ''}${refused}`.slice(0, 240), draft: null } };
  return { text: polished, result: { state: '다듬음', problem, draft: input.draft } };
}

export async function polishDraft(
  input: PolishInput,
  key: string,
  budget: Budget,
  routing: ChatOptions['routingStrategy'] = POLISH_ROUTING,
): Promise<PolishOutput> {
  try {
    const { value, usage } = await chatJson<ModelPolish>({
      stage: '수정안 다듬기',
      key,
      system: POLISH_SYSTEM,
      user: polishUserMessage(input.original, input.draft, input.inserted),
      schemaName: 'polish',
      schema: POLISH_SCHEMA,
      maxTokens: LIMITS.polish.outputTokens,
      budget,
      routingStrategy: routing,
    });
    return { ...settlePolish(input, value), usage: [usage] };
  } catch (e) {
    // 다듬기 검사가 실패해도 수정안은 쓸 수 있다. 검사하지 못했다는 것만 알린다
    if (e instanceof LinerError) return { text: input.draft, result: { state: '검사 실패', problem: e.kind, draft: null }, usage: [] };
    throw e;
  }
}
