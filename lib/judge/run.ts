// [판정] 서명이 맞는 근거 묶음 하나를 받아, 그 발췌로 판정하고 코드 규칙을 검사한다.
import { verifyBundle } from '../evidence.ts';
import { LIMITS } from '../limits.ts';
import { chatJson, type Budget } from '../liner.ts';
import { JUDGE_SCHEMA, JUDGE_SYSTEM, judgeUserMessage, type ModelJudgment } from '../prompts/judge.ts';
import { contentId } from '../sentences.ts';
import type { ClaimCore, EvidenceBundle, Judgment, Usage } from '../types.ts';
import { applyRules } from './rules.ts';

export interface JudgeInput {
  claim: ClaimCore;
  /** 명제가 나온 원고 문장(Markdown 표시를 걷어 낸 글) */
  sentence: string;
  /** 제목이나 첫 문단의 문장인지. 그러면 편집 우선순위를 '상'으로 올린다 */
  lead: boolean;
  bundle: EvidenceBundle;
  signature: string;
}

/** 근거 묶음이 서버가 서명한 것이 아니거나 이 명제의 것이 아니다 */
export class BundleError extends Error {}

export async function judgeClaim(input: JudgeInput, key: string, budget: Budget): Promise<{ judgment: Judgment; usage: Usage[] }> {
  const { claim, bundle } = input;
  // 서명으로 근거가 수집 당시와 같은지, 이 명제의 근거인지 확인한다. 맞지 않으면 모델을 부르지 않는다
  if (bundle?.v !== 1 || !Array.isArray(bundle.evidence) || !Array.isArray(bundle.sources)) throw new BundleError('근거 묶음의 형식이 맞지 않는다');
  if (!verifyBundle(bundle, input.signature, claim, key)) throw new BundleError('근거 묶음의 서명이 맞지 않는다');

  const { value, usage } = await chatJson<ModelJudgment>({
    stage: '판정',
    key,
    system: JUDGE_SYSTEM,
    user: judgeUserMessage({
      statement: claim.statement,
      sentence: input.sentence,
      type: claim.type,
      qualifiers: claim.qualifiers,
      asOf: claim.asOf,
      bundle,
    }),
    schemaName: 'judgment',
    schema: JUDGE_SCHEMA,
    maxTokens: LIMITS.judge.outputTokens,
    budget,
    // 품질 우선으로 고정한다. 2026-11-21에 견줘 보니 품질 우선과 기본은 같은 모델(claude-sonnet-5.5)이 응답해 결과와 값이 같았고,
    // 싼 모델은 인용문을 글자 그대로 옮기지 못해 대부분 '근거 부족'으로 떨어졌다. 기본에 맡기면 싼 모델이 섞일 수 있다
    routingStrategy: 'quality',
  });

  const judgment = applyRules({
    claim: { statement: claim.statement, type: claim.type, lead: input.lead, asOf: claim.asOf },
    bundle,
    model: value,
    sentenceKey: input.sentence ? contentId(input.sentence) : '',
  });
  return { judgment, usage: [usage] };
}
