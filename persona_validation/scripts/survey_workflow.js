export const meta = {
  name: 'persona-survey-main',
  description: 'Synthetic persona survey: 200 respondents plus 20 repeat runs, two separate Opus calls each (440 agents)',
  phases: [
    { title: 'Stage 1', detail: 'neutral workload questions, one agent per respondent', model: 'opus' },
    { title: 'Stage 2', detail: 'practice and method comparison, one agent per respondent', model: 'opus' },
  ],
}

// Each respondent is two separate agent calls. The agent reads its own prompt file
// (persona, assigned work situation, questions) and returns coded answers.
// Results are read back from the run's journal.jsonl by collect_responses.py,
// so this script returns only a short completion summary.

const DIR = 'c:/WhiteChecker/persona_validation/prompts/'
const STEP_LABEL = {
  PLAN: '기획·자료 조사', DRAFT: '초안 작성', FACT: '사실관계·출처 재확인', POLISH: '문장 다듬기·교정',
  APPROVAL: '내부 검토·승인 대응', PRODUCTION: '디자인·편집·배포 작업', AFTERCARE: '내보낸(제출한) 뒤 문의·정정 대응',
}
const TIME_LABEL = { LT1H: '1시간 미만', H1_3: '1~3시간', H3_8: '3~8시간', GT8H: '8시간 이상' }
const TYPE_LABEL = {
  FACT_ERROR: '사실관계·수치·출처가 틀림', TYPO_STYLE: '오탈자·문장 표현', FORMAT_DESIGN: '형식·디자인·레이아웃',
  SCHEDULE_DISTRIBUTION: '일정·배포·전달 실수', TONE_EXPRESSION: '어조·표현 수위', OTHER: '그 밖의 문제', NONE: '없음',
}
const STEPS = Object.keys(STEP_LABEL)
const ERRS = ['E_SECONDARY', 'E_QUALIFIER', 'E_DRIFT', 'E_STALE', 'E_FABRICATED', 'E_NUMERIC', 'E_NAMES', 'NONE']
const TOOLS = ['AISEARCH', 'CLAIMTABLE', 'SCORE', 'CURRENT']
const RATE = { type: 'integer', minimum: 1, maximum: 5 }
const SHARE = { type: 'integer', minimum: 0, maximum: 100 }
const SHARE_KEYS = ['share_plan', 'share_draft', 'share_fact', 'share_polish', 'share_approval', 'share_production', 'share_aftercare']

const S1 = {
  type: 'object',
  properties: {
    pid: { type: 'string' },
    top3: { type: 'array', items: { type: 'string', enum: STEPS }, minItems: 3, maxItems: 3 },
    share_plan: SHARE, share_draft: SHARE, share_fact: SHARE, share_polish: SHARE,
    share_approval: SHARE, share_production: SHARE, share_aftercare: SHARE,
    help_step: { type: 'string', enum: STEPS },
    total_time: { type: 'string', enum: Object.keys(TIME_LABEL) },
    memorable_problem: { type: 'string' },
    memorable_type: { type: 'string', enum: Object.keys(TYPE_LABEL) },
    guessed_purpose: { type: 'string' },
  },
  required: ['pid', 'top3', ...SHARE_KEYS, 'help_step', 'total_time', 'memorable_problem', 'memorable_type', 'guessed_purpose'],
}

const S2 = {
  type: 'object',
  properties: {
    pid: { type: 'string' },
    methods: { type: 'array', items: { type: 'string', enum: ['SELF_SEARCH', 'ASK_AI', 'PEER', 'SOURCE_OWNER', 'NONE'] }, minItems: 1 },
    fact_time: { type: 'string', enum: ['NONE', 'LT15M', 'M15_60', 'H1_3', 'GT3H'] },
    errors: { type: 'array', items: { type: 'string', enum: ERRS }, minItems: 1 },
    top_error: { type: 'string', enum: ERRS },
    rate_aisearch: RATE,
    rate_claimtable: RATE,
    rate_score: RATE,
    rate_current: RATE,
    choice: { type: 'string', enum: TOOLS },
    choice_reason: { type: 'string' },
    objections: { type: 'array', items: { type: 'string' }, maxItems: 2 },
    apply_mode: { type: 'string', enum: ['AUTO', 'PER_ITEM', 'HYBRID'] },
    upload: { type: 'string', enum: ['OK', 'CONDITIONAL', 'NO'] },
    upload_note: { type: 'string' },
    match_handling: { type: 'string', enum: ['RECHECK_ALL', 'RECHECK_KEY', 'SPOT', 'TRUST'] },
  },
  required: ['pid', 'methods', 'fact_time', 'errors', 'top_error', 'rate_aisearch', 'rate_claimtable', 'rate_score',
    'rate_current', 'choice', 'choice_reason', 'objections', 'apply_mode', 'upload', 'upload_note', 'match_handling'],
}

function ask(job, part, extra) {
  return `${DIR}${job.pid}_${part}.md 파일 하나만 Read 도구로 읽고, 그 안의 지시대로 응답자를 연기해 질문에 답하십시오. ` +
    `다른 파일은 읽지 말고 검색이나 명령 실행 도구도 쓰지 마십시오. 답은 구조화된 응답으로 제출합니다.` +
    (job.run > 1 ? ` (응답 기록 번호 ${job.run})` : '') + (extra || '')
}

function previous(s1) {
  return `\n\n앞 단계에서 이 응답자가 한 답:\n` +
    `- 시간과 신경이 많이 쓰이는 단계 1~3위: ${s1.top3.map(c => STEP_LABEL[c]).join(', ')}\n` +
    `- 가장 먼저 덜어 내고 싶은 단계: ${STEP_LABEL[s1.help_step]}\n` +
    `- 한 건에 드는 전체 시간: ${TIME_LABEL[s1.total_time]}\n` +
    `- 기억에 남는 문제: ${s1.memorable_problem} (유형: ${TYPE_LABEL[s1.memorable_type]})`
}

const GROUPS = ['G1', 'G2', 'G3', 'G4', 'G5']
const id = (g, i) => `${g}-${String(i).padStart(2, '0')}`
let jobs = []
for (const g of GROUPS) for (let i = 1; i <= 40; i++) jobs.push({ pid: id(g, i), run: 1 })
for (const g of GROUPS) for (const i of [1, 12, 23, 34]) jobs.push({ pid: id(g, i), run: 2 })
// optional: args = { only: ["G1-01 r1", ...] } reruns just those respondent-runs
if (args && Array.isArray(args.only)) jobs = jobs.filter(j => args.only.includes(`${j.pid} r${j.run}`))

const OPTS = { model: 'opus', effort: 'medium' }
const done = await pipeline(
  jobs,
  job => agent(ask(job, 1), { ...OPTS, label: `${job.pid} r${job.run} 1/2`, phase: 'Stage 1', schema: S1 }),
  (s1, job) => {
    if (!s1) return { s1: null, s2: null }
    return agent(ask(job, 2, previous(s1)), { ...OPTS, label: `${job.pid} r${job.run} 2/2`, phase: 'Stage 2', schema: S2 })
      .then(s2 => ({ s1: true, s2: !!s2 }))
  },
)
const failed = jobs.filter((job, i) => !(done[i] && done[i].s1 && done[i].s2)).map(job => `${job.pid} r${job.run}`)
log(`complete ${jobs.length - failed.length} of ${jobs.length}`)
return { jobs: jobs.length, complete: jobs.length - failed.length, failed }
