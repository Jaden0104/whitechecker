// 화면이 맡는 진행(PRD 7장 '화면이 진행을 맡는다')의 자료 모양과, 그 자료를 읽는 함수들.
// 처리 상태, 사실 판정, 실패 사유를 따로 둔다(F16). 처리에 실패한 것을 '근거 부족'으로 보이지 않기 위해서다.
import { citedSourceName, type SentenceClaim } from '../merge/plan.ts';
import type { Claim, ClaimType, EvidenceBundle, Judgment, Sentence, SentenceRevision, Usage, Verdict } from '../types.ts';

export type ItemState = '대기' | '진행 중' | '완료' | '실패' | '중단';
export type Step = '' | '근거 모으기' | '판정';

/** 추출 요청 하나에 보내는 문장 묶음 */
export interface ChunkEntry {
  title: string;
  context: string;
  sentences: Array<{ id: number; text: string }>;
  state: ItemState;
  failure: string;
  /** 응답이 온전하지 않아 반으로 나눠 다시 보낸 묶음이다. 한 번 더 나누지는 않는다 */
  split: boolean;
}

/** 추출이 공개 자료로 확인할 수 없다고 본 명제의 처리(F9) */
export interface DirectInfo {
  /** 검색을 한 번 해 본 뒤에 확정할 명제인지. 유형이 내부 수치나 비공개 취재가 아닌 것이 그렇다 */
  probe: boolean;
  /** 검색해 보니 공개 자료가 있어 판정을 냈다 */
  reclassified: boolean;
  note: string;
}

export interface ClaimEntry {
  claim: Claim;
  state: ItemState;
  step: Step;
  failure: string;
  bundle: EvidenceBundle | null;
  signature: string;
  judgment: Judgment | null;
  /** 내용, 유형, 한정 표현, 기준 시점이 같은 명제를 먼저 처리하는 항목. 그 항목이 모은 근거를 함께 쓴다 */
  bundleFrom: string | null;
  /** 문장과 놓인 자리까지 같은 명제를 먼저 처리하는 항목. 그 항목의 판정까지 함께 쓴다 */
  judgeFrom: string | null;
  direct: DirectInfo | null;
}

/** 문장 하나의 통합 수정안과 그 처리 상태. '없음'은 합칠 고칠 내용이 없어 만들지 않았다는 뜻이다 */
export interface RevisionEntry {
  state: ItemState | '없음';
  failure: string;
  revision: SentenceRevision | null;
  /** 수정안을 채택해도 확인되지 않은 채 남는 명제 */
  unresolved: string[];
  /** 수정안을 만든 고칠 내용의 식별값. 판정이 달라지면 값이 달라져 다시 만든다 */
  fixesKey: string;
}

export type RunStatus = '추출 중' | '검증 중' | '끝남' | '중단';

export interface RunState {
  v: 1;
  /** 실행 번호. 기록을 지우거나 새로 시작하면 바뀌고, 늦게 도착한 앞 실행의 응답은 버린다(F17) */
  runId: string;
  manuscript: string;
  /** 원고 버전. 실행을 시작할 때의 원고 글자에서 만든 식별값 */
  manuscriptKey: string;
  title: string;
  sentences: Sentence[];
  status: RunStatus;
  chunks: ChunkEntry[];
  /** 추출에서 문장 번호나 유형이 맞지 않아 받지 않은 명제 수 */
  dropped: number;
  claims: ClaimEntry[];
  revisions: Record<number, RevisionEntry>;
  /** 성공한 요청이 알려 준 사용량. 실패한 요청의 사용량은 서버가 돌려주지 않아 들어 있지 않다 */
  usage: Usage[];
  /** 실제로 돌아간 시간의 합(밀리초). 멈춰 있던 시간은 넣지 않는다 */
  activeMs: number;
  /** 지금 돌고 있는 실행이 시작된 시각. 멈춰 있으면 null */
  passStartedAt: number | null;
  startedAt: string;
  /** 접속 코드나 키 문제처럼 실행 전체를 멈춘 사유. 없으면 빈 문자열 */
  blocked: string;
  /** 한 번에 처리하는 수를 넘겨 다음 실행으로 넘긴 명제 수 */
  deferred: number;
}

/** 내부 수치와 비공개 취재가 나오는 유형. 이 유형의 '직접 확인'은 검색해 보지 않고 확정한다(F9) */
export const PRIVATE_BY_NATURE: ClaimType[] = ['수치·통계', '인용·출처 귀속'];

/** 근거를 함께 쓸 수 있는 명제끼리 같은 값. 서버가 근거 묶음에 붙이는 식별값과 같은 항목으로 만든다 */
export function coreKey(claim: Pick<Claim, 'statement' | 'type' | 'qualifiers' | 'asOf'>): string {
  return JSON.stringify([claim.statement, claim.type, claim.asOf, claim.qualifiers]);
}

/** 제목이나 첫 문단의 문장인지. 판정에서 편집 우선순위와 근거 요구 수준이 달라진다 */
export function isLead(sentences: Sentence[], sentenceId: number): boolean {
  const sentence = sentences.find((s) => s.id === sentenceId);
  if (!sentence) return false;
  const titleId = sentences.find((s) => s.kind === 'heading')?.id;
  const firstParagraph = sentences.find((s) => s.kind === 'paragraph')?.block;
  return sentence.id === titleId || sentence.block === firstParagraph;
}

/** 판정까지 함께 쓸 수 있는 명제끼리 같은 값. 판정은 문장과 놓인 자리도 보므로 그것까지 같아야 한다 */
export function judgeKey(claim: Claim, sentences: Sentence[]): string {
  const sentence = sentences.find((s) => s.id === claim.sentenceId);
  return JSON.stringify([coreKey(claim), sentence?.plain ?? '', isLead(sentences, claim.sentenceId), claim.isPublic]);
}

export function entryOf(run: RunState, claimId: string): ClaimEntry | undefined {
  return run.claims.find((e) => e.claim.id === claimId);
}

/** 판정을 실제로 받는 항목. 같은 명제를 함께 쓰는 항목이면 먼저 처리하는 쪽이다 */
export function judgeLeader(run: RunState, entry: ClaimEntry): ClaimEntry {
  return (entry.judgeFrom && entryOf(run, entry.judgeFrom)) || entry;
}

/** 근거를 실제로 모으는 항목 */
export function bundleLeader(run: RunState, entry: ClaimEntry): ClaimEntry {
  const leader = judgeLeader(run, entry);
  return (leader.bundleFrom && entryOf(run, leader.bundleFrom)) || leader;
}

/** 화면에 보일 명제 하나의 지금 모습. 함께 쓰는 항목이면 먼저 처리하는 쪽의 상태와 결과를 따른다 */
export interface ClaimView {
  entry: ClaimEntry;
  state: ItemState;
  step: Step;
  failure: string;
  verdict: Verdict | null;
  judgment: Judgment | null;
  bundle: EvidenceBundle | null;
  direct: DirectInfo | null;
  /** 결과를 함께 쓰는 다른 항목의 번호. 스스로 처리했으면 null */
  sharedWith: string | null;
}

export function viewOf(run: RunState, entry: ClaimEntry): ClaimView {
  const leader = judgeLeader(run, entry);
  const direct = leader.direct;
  // '직접 확인'으로 남는 경우: 검색 없이 확정했거나, 검색해 보고도 판정할 자료가 없었다
  const staysDirect = direct !== null && !direct.reclassified;
  const verdict: Verdict | null = leader.state !== '완료' ? null : staysDirect ? '직접 확인' : (leader.judgment?.verdict ?? null);
  return {
    entry,
    state: leader.state,
    step: leader.step,
    failure: leader.failure,
    verdict,
    judgment: staysDirect ? null : leader.judgment,
    bundle: bundleLeader(run, entry).bundle,
    direct,
    sharedWith: leader === entry ? null : leader.claim.id,
  };
}

/** 문장에 연결된 명제들의 상태. 수정안을 합칠 때가 됐는지 정하는 데 쓴다 */
export function sentenceClaims(run: RunState, sentenceId: number): SentenceClaim[] {
  return run.claims
    .filter((e) => e.claim.sentenceId === sentenceId)
    .map((e) => {
      const view = viewOf(run, e);
      const fix = view.judgment?.fix ?? null;
      return {
        claimId: e.claim.id,
        statement: e.claim.statement,
        state: view.state,
        verdict: view.verdict,
        fix,
        sourceName: citedSourceName(fix, view.judgment?.sources ?? [], view.bundle?.sources ?? []),
      };
    });
}

export interface RunCounts {
  total: number;
  done: number;
  running: number;
  failed: number;
  stopped: number;
  waiting: number;
}

export function countClaims(run: RunState): RunCounts {
  const counts: RunCounts = { total: run.claims.length, done: 0, running: 0, failed: 0, stopped: 0, waiting: 0 };
  for (const entry of run.claims) {
    const state = judgeLeader(run, entry).state;
    if (state === '완료') counts.done += 1;
    else if (state === '진행 중') counts.running += 1;
    else if (state === '실패') counts.failed += 1;
    else if (state === '중단') counts.stopped += 1;
    else counts.waiting += 1;
  }
  return counts;
}

/** 다시 돌릴 것이 남았는지: 끝나지 않은 추출 묶음, 명제, 수정안 */
export function hasUnfinished(run: RunState): boolean {
  return (
    run.chunks.some((c) => c.state !== '완료') ||
    run.claims.some((e) => judgeLeader(run, e).state !== '완료') ||
    Object.values(run.revisions).some((r) => r.state !== '완료' && r.state !== '없음') ||
    // 명제는 모두 끝났는데 수정안을 만들지도, 만들 것이 없다고 정하지도 않은 문장(만들기 전에 멈춘 경우)
    run.sentences.some((s) => {
      const mine = run.claims.filter((e) => e.claim.sentenceId === s.id);
      return mine.length > 0 && !run.revisions[s.id] && mine.every((e) => judgeLeader(run, e).state === '완료');
    })
  );
}

/** 저장해 둔 실행을 다시 열 때: 돌던 것은 '중단'으로 표시한다(F16) */
export function recover(run: RunState): RunState {
  const settle = <T extends { state: string }>(item: T): T => (item.state === '진행 중' ? { ...item, state: '중단' } : item);
  const revisions: Record<number, RevisionEntry> = {};
  for (const [id, r] of Object.entries(run.revisions)) revisions[Number(id)] = settle(r);
  const wasRunning = run.status === '추출 중' || run.status === '검증 중';
  return {
    ...run,
    status: wasRunning ? '중단' : run.status,
    passStartedAt: null,
    chunks: run.chunks.map(settle),
    claims: run.claims.map((e) => ({ ...settle(e), step: '' as Step })),
    revisions,
  };
}

export interface UsageSummary {
  searches: number;
  modelCalls: number;
  promptTokens: number;
  completionTokens: number;
  byStage: Array<{ stage: string; searches: number; modelCalls: number; promptTokens: number; completionTokens: number; models: string[] }>;
}

/** 호출 내역의 요약(F12). 단계별로 검색 횟수, 모델 호출 횟수, 토큰을 더한다 */
export function summarizeUsage(usage: Usage[]): UsageSummary {
  const summary: UsageSummary = { searches: 0, modelCalls: 0, promptTokens: 0, completionTokens: 0, byStage: [] };
  for (const u of usage) {
    let row = summary.byStage.find((r) => r.stage === u.stage);
    if (!row) {
      row = { stage: u.stage, searches: 0, modelCalls: 0, promptTokens: 0, completionTokens: 0, models: [] };
      summary.byStage.push(row);
    }
    const isSearch = u.model.startsWith('search/');
    const searches = u.searchCalls ?? 0;
    row.searches += searches;
    summary.searches += searches;
    if (!isSearch) {
      row.modelCalls += 1;
      summary.modelCalls += 1;
      if (u.model && !row.models.includes(u.model)) row.models.push(u.model);
    }
    row.promptTokens += u.promptTokens;
    row.completionTokens += u.completionTokens;
    summary.promptTokens += u.promptTokens;
    summary.completionTokens += u.completionTokens;
  }
  // 처리 순서대로 보인다. 목록에 없는 단계는 뒤에 둔다
  const at = (stage: string) => (STAGE_ORDER.includes(stage) ? STAGE_ORDER.indexOf(stage) : STAGE_ORDER.length);
  summary.byStage.sort((a, b) => at(a.stage) - at(b.stage));
  return summary;
}

const STAGE_ORDER = ['추출', '근거 모으기', '추가 검색 판단', '판정', '수정안 합치기', '수정안 다듬기'];
