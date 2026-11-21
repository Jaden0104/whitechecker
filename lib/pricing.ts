// Liner의 가격표로 호출의 값을 어림한다. 실행이 끝났을 때 보여 주는 추정 비용에 쓴다(PRD F12).
// 가격은 2026-11-21에 Liner 문서에서 확인한 값이다(100만 토큰당 달러). 청구액은 Liner가 정하므로 이 값은 어림이다.
import type { Usage } from './types.ts';

interface ModelPrice {
  input: number;
  output: number;
  /** 캐시에서 읽은 입력 */
  cachedInput: number;
  /** 캐시에 새로 쓴 입력 */
  cacheWrite: number;
}

export const MODEL_PRICES: Record<string, ModelPrice> = {
  'claude-haiku-5.5': { input: 0.1, output: 0.5, cachedInput: 0.01, cacheWrite: 0.125 },
  'claude-sonnet-5.5': { input: 2, output: 10, cachedInput: 0.1, cacheWrite: 2.5 },
  'claude-opus-5.5': { input: 4, output: 20, cachedInput: 0.2, cacheWrite: 5 },
  'claude-fable-5.1': { input: 10, output: 50, cachedInput: 0.25, cacheWrite: 12.5 },
};

/** 웹 검색 한 번의 값(달러). 1,000건에 2달러이고, 함께 오는 데이터(Premium Data)를 끄면 1달러다 */
export const SEARCH_PRICE = { withKnowledge: 0.002, plain: 0.001 };

/** 호출 한 번의 값(달러). 가격표에 없는 모델이 응답했으면 토큰 값은 0으로 두고 known을 false로 돌려준다 */
export function usageCost(usage: Usage): { dollars: number; known: boolean } {
  // 검색은 모델 이름 자리에 'search/web'이나 'search/web+knowledge'를 적어 둔다
  const perSearch = usage.model.includes('knowledge') || !usage.model.startsWith('search/') ? SEARCH_PRICE.withKnowledge : SEARCH_PRICE.plain;
  const search = (usage.searchCalls ?? 0) * perSearch;
  if (!usage.model || usage.model.startsWith('search/')) return { dollars: search, known: true };
  const price = MODEL_PRICES[usage.model];
  if (!price) return { dollars: search, known: false };
  const cached = usage.cachedTokens ?? 0;
  const written = usage.cacheWriteTokens ?? 0;
  // 캐시에서 읽은 것과 캐시에 쓴 것은 입력 토큰 수에 들어 있다
  const plain = Math.max(0, usage.promptTokens - cached - written);
  const tokens = plain * price.input + cached * price.cachedInput + written * price.cacheWrite + usage.completionTokens * price.output;
  return { dollars: search + tokens / 1_000_000, known: true };
}

/** 여러 호출의 값을 더한다 */
export function totalCost(usages: Usage[]): { dollars: number; unknownModels: string[] } {
  let dollars = 0;
  const unknown = new Set<string>();
  for (const usage of usages) {
    const cost = usageCost(usage);
    dollars += cost.dollars;
    if (!cost.known) unknown.add(usage.model);
  }
  return { dollars, unknownModels: [...unknown] };
}
