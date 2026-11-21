// 호출의 값을 어림하는 계산(lib/pricing.ts)이 가격표대로인지 확인한다. Liner를 부르지 않는다.
// 사용: node tools/check_pricing.mjs
import { totalCost, usageCost } from '../lib/pricing.ts';

let failed = 0;
function expect(label, actual, wanted) {
  const ok = Math.abs(actual - wanted) < 1e-9;
  if (!ok) failed += 1;
  console.log(`${ok ? '통과' : '실패'}  ${label}${ok ? '' : `  (기대 ${wanted}, 실제 ${actual})`}`);
}
const usage = (model, promptTokens, completionTokens, extra = {}) => ({ stage: '판정', model, promptTokens, completionTokens, searchCalls: 0, seconds: 1, ...extra });

expect('캐시가 없으면 입력과 출력만 센다', usageCost(usage('claude-sonnet-5.5', 12000, 800)).dollars, (12000 * 2 + 800 * 10) / 1e6);
// 2026-11-21에 실제로 받은 사용량: 입력 12,806(캐시에서 읽은 것 7,178, 캐시에 쓴 것 5,624), 출력 16
expect(
  '캐시에서 읽은 것은 20분의 1, 캐시에 쓴 것은 4분의 1 비싸게 센다',
  usageCost(usage('claude-sonnet-5.5', 12806, 16, { cachedTokens: 7178, cacheWriteTokens: 5624 })).dollars,
  (4 * 2 + 7178 * 0.1 + 5624 * 2.5 + 16 * 10) / 1e6,
);
expect('싼 모델의 가격', usageCost(usage('claude-haiku-5.5', 3887, 105)).dollars, (3887 * 0.1 + 105 * 0.5) / 1e6);
const search = (model) => ({ stage: '근거 모으기', model, promptTokens: 0, completionTokens: 0, searchCalls: 3, seconds: 1 });
expect('함께 오는 데이터를 켠 검색은 한 번에 0.002달러', usageCost(search('search/web+knowledge')).dollars, 0.006);
expect('데이터를 끈 검색은 한 번에 0.001달러', usageCost(search('search/web')).dollars, 0.003);
expect('검색은 모르는 모델로 치지 않는다', usageCost(search('search/web')).known ? 1 : 0, 1);
const unknown = usageCost(usage('some-new-model', 1000, 100));
expect('가격표에 없는 모델은 0으로 두고 표시한다', unknown.dollars + (unknown.known ? 1 : 0), 0);
const sum = totalCost([usage('claude-sonnet-5.5', 1000, 100), usage('some-new-model', 1000, 100)]);
expect('여러 호출을 더하고, 모르는 모델의 이름을 돌려준다', sum.dollars + sum.unknownModels.length, (1000 * 2 + 100 * 10) / 1e6 + 1);

console.log(failed ? `\n실패 ${failed}건` : '\n모두 통과');
process.exit(failed ? 1 : 0);
