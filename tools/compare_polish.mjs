// 다듬기 검사에 어떤 모델을 쓸지 정하려고, 같은 문장들을 모델 고르는 방식별로 돌려 견준다.
// 깨진 문장은 실제 시험에서 나온 것(2026-11-21)과 조사를 일부러 틀리게 만든 것이고, 멀쩡한 문장은 손대지 않아야 한다.
// 서버를 거치지 않고 Liner를 직접 부른다. 키는 환경 변수에서만 읽고 화면에 찍지 않는다.
// 사용: node --env-file=.env tools/compare_polish.mjs [기본,quality,cost]
import { newBudget } from '../lib/liner.ts';
import { polishDraft } from '../lib/merge/polish.ts';

const key = process.env.LINER_API_KEY ?? '';
if (!key) {
  console.log('LINER_API_KEY가 없다. node --env-file=.env 로 돌린다');
  process.exit(1);
}
const strategies = (process.argv[2] ?? '기본,quality,cost').split(',');

const hours = '박물관은 매일 오전 10시부터 오후 6시까지 문을 엽니다.';
const CASES = [
  {
    name: '깨짐1(실제)',
    broken: true,
    original: hours,
    inserted: ['09:30~17:30(입장 마감 17:00), 토요일과 매월 마지막 수요일은 21:00까지, 매월 마지막 월요일과 명절 당일 휴관'],
    instructions: ["'매일 오전 10시부터 오후 6시까지'를 '09:30~17:30(입장 마감 17:00), 토요일과 매월 마지막 수요일은 21:00까지, 매월 마지막 월요일과 명절 당일 휴관'으로 고친다"],
    draft: '박물관은 09:30~17:30(입장 마감 17:00), 토요일과 매월 마지막 수요일은 21:00까지, 매월 마지막 월요일과 명절 당일 휴관 문을 엽니다.',
  },
  {
    name: '깨짐2(실제)',
    broken: true,
    original: hours,
    inserted: ['월~금·일요일 오전 9시 30분부터 오후 5시 30분까지(토요일은 오후 9시까지), 매월 마지막 월요일 휴관 기준으로'],
    instructions: ["'매일 오전 10시부터 오후 6시까지'를 '월~금·일요일 오전 9시 30분부터 오후 5시 30분까지(토요일은 오후 9시까지), 매월 마지막 월요일 휴관'으로 고친다"],
    draft: '박물관은 월~금·일요일 오전 9시 30분부터 오후 5시 30분까지(토요일은 오후 9시까지), 매월 마지막 월요일 휴관 기준으로 문을 엽니다.',
  },
  {
    name: '깨짐3(조사)',
    broken: true,
    original: '이 탑은 경주에 있으며 높이는 8.2m다.',
    inserted: ['석탑'],
    instructions: ["'탑'을 '석탑'으로 고친다"],
    draft: '이 석탑는 경주에 있으며 높이는 8.2m다.',
  },
  {
    name: '정상1',
    broken: false,
    original: '이 각석은 1985년에 국보로 지정됐고, 지금은 서울의 **국립중앙박물관**에 있습니다.',
    inserted: ['국립고궁박물관'],
    instructions: ["'국립중앙박물관'을 '국립고궁박물관'으로 고친다"],
    draft: '이 각석은 1985년에 국보로 지정됐고, 지금은 서울의 **국립고궁박물관**에 있습니다.',
  },
  {
    name: '정상2',
    broken: false,
    original: '돌의 크기는 세로 311cm, 가로 223cm입니다.',
    inserted: ['세로 211cm, 가로 123cm'],
    instructions: ['세로 311cm를 211cm로, 가로 223cm를 123cm로 고친다'],
    draft: '돌의 크기는 세로 211cm, 가로 123cm입니다.',
  },
  {
    name: '정상3',
    broken: false,
    original: '이 각석은 세계에서 가장 오래된 석각 천문도입니다.',
    inserted: ['우리나라에서 가장 오래된 석각 천문도'],
    instructions: ["'세계에서 가장 오래된 석각 천문도'를 '우리나라에서 가장 오래된 석각 천문도'로 고친다"],
    draft: '이 각석은 우리나라에서 가장 오래된 석각 천문도입니다.',
  },
  {
    name: '정상4',
    broken: false,
    original: hours,
    inserted: ['오전 9시 30분부터 오후 5시 30분까지'],
    instructions: ["'매일 오전 10시부터 오후 6시까지'를 '오전 9시 30분부터 오후 5시 30분까지'로 고치고 '매일'을 뺀다"],
    draft: '박물관은 오전 9시 30분부터 오후 5시 30분까지 문을 엽니다.',
  },
];

for (const strategy of strategies) {
  const routing = strategy === '기본' ? undefined : strategy;
  console.log(`\n===== 모델 고르는 방식: ${strategy}`);
  let right = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  let seconds = 0;
  const models = new Set();
  for (const c of CASES) {
    const out = await polishDraft({ original: c.original, draft: c.draft, inserted: c.inserted, instructions: c.instructions }, key, newBudget(), routing);
    const u = out.usage[0];
    if (u) {
      tokensIn += u.promptTokens;
      tokensOut += u.completionTokens;
      seconds += u.seconds;
      models.add(u.model);
    }
    const state = out.result.state;
    // 깨진 문장은 다듬어야 맞고(받아들이지 못했어도 어색하다고 본 것까지는 맞다), 멀쩡한 문장은 그대로 둬야 맞다
    const ok = c.broken ? state === '다듬음' : state === '고칠 곳 없음';
    if (ok) right += 1;
    console.log(`${ok ? '맞음' : '아님'}  ${c.name}  ${state}  ${u ? `${u.seconds}초` : ''}`);
    if (out.result.problem) console.log(`      어색한 곳: ${out.result.problem}`);
    if (state === '다듬음') console.log(`      다듬은 문장: ${out.text}`);
  }
  console.log(`  기대대로 ${right}/${CASES.length} | 모델 ${[...models].join(', ') || '-'} | 토큰 입력 ${tokensIn} 출력 ${tokensOut} | 걸린 시간 합계 ${seconds.toFixed(1)}초`);
}
