// 화면이 맡는 진행(PRD 7장 '화면이 진행을 맡는다')의 자료 모양과, 그 자료를 읽는 함수들.
// 처리 상태, 사실 판정, 실패 사유를 따로 둔다(F16). 처리에 실패한 것을 '근거 부족'으로 보이지 않기 위해서다.
import { citedSourceName, type SentenceClaim } from '../merge/plan.ts';
import type { Claim, ClaimType, EvidenceBundle, Judgment, Priority, Sentence, SentenceRevision, Usage, Verdict } from '../types.ts';

export type ItemState = '대기' | '진행 중' | '완료' | '실패' | '중단';
export type Step = '' | '근거 모으기' | '판정';

/** 추출 요청 하나에 보내는 문장 묶음 */
export interface ChunkEntry {
  title: string;
  context: string;
  sentences: Array<{ id: number; text: string }>;
  /** 묶음의 바로 뒤에 이어지는 글(뒤 문맥). 뒤에 글이 없거나 앞선 판에서 저장한 기록이면 없다 */
  after?: string;
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

/** 문장에 대한 편집자의 선택(F10). 고르지 않은 문장은 보류로 처리한다 */
export interface ReviewEntry {
  choice: '' | '채택' | '보류';
  /** 편집자가 고쳐 쓴 수정안(원고에 적힌 꼴). 고쳐 쓰지 않았으면 null */
  edited: string | null;
  /** 마지막으로 고르거나 고친 시각 */
  at: string;
}

/** 고쳐 쓴 문장 하나를 다시 검증한 결과(F14). 요청할 때의 글에 묶는다. 그 뒤에 글이 바뀌면 이전 문장에 대한 결과가 된다 */
export interface RecheckEntry {
  /** 요청 번호. 늦게 도착한 앞선 요청의 응답이 지금의 결과를 덮어쓰지 않게 한다 */
  token: string;
  /** 다시 검증한 글(원고에 적힌 꼴) */
  text: string;
  /**
   * 검증한 글의 종류. 이제는 편집자가 고쳐 쓴 글('edited')만 다시 검증한다.
   * 'original'은 원문도 다시 검증하던 때에 저장된 기록에만 남아 있고, 화면과 내보내기에서는 쓰지 않는다(recheckOf)
   */
  target: 'edited' | 'original';
  state: '진행 중' | '완료' | '실패' | '중단';
  failure: string;
  /** 그 글에서 다시 뽑은 명제와 그 근거, 판정 */
  claims: ClaimEntry[];
  at: string;
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
  /** 문장별 선택과 고쳐 쓴 수정안(F10). 앞선 판에서 저장한 기록에는 없을 수 있다 */
  reviews?: Record<number, ReviewEntry>;
  /** 문장별 재검증 결과(F14) */
  rechecks?: Record<number, RecheckEntry>;
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
  const rechecks: Record<number, RecheckEntry> = {};
  for (const [id, k] of Object.entries(run.rechecks ?? {})) {
    rechecks[Number(id)] = { ...settle(k), claims: k.claims.map((e) => ({ ...settle(e), step: '' as Step })) };
  }
  const wasRunning = run.status === '추출 중' || run.status === '검증 중';
  return {
    ...run,
    status: wasRunning ? '중단' : run.status,
    passStartedAt: null,
    chunks: run.chunks.map(settle),
    claims: run.claims.map((e) => ({ ...settle(e), step: '' as Step })),
    revisions,
    rechecks,
  };
}

// ---------- 문장 단위로 보기: 판정표의 줄, 편집자의 선택, 재검증(F8, F10, F14) ----------

const PRIORITY_ORDER: Record<string, number> = { 상: 0, 중: 1, 하: 2 };
const VERDICT_ORDER: Record<Verdict, number> = { 불일치: 0, '근거 부족': 1, '해석 주의': 2, '직접 확인': 3, 일치: 4 };

/**
 * 보이는 순서(F8). 틀린 것으로 확인된 것(불일치)을 먼저 보인다. 자리와 상관없이 반드시 고쳐야 하기 때문이다.
 * 그 안에서, 그리고 나머지(근거 부족, 해석 주의)에서는 편집 우선순위가 높은 것부터 보인다. 끝나지 않은 것은 맨 뒤다.
 * 편집 우선순위(상·중·하)는 판정과 따로 매기는 값으로, 틀렸을 때 글에 미치는 영향을 뜻한다(5.4절).
 */
export function compareByRank(a: ClaimView, b: ClaimView): number {
  const rank = (v: ClaimView) => [v.verdict === '불일치' ? 0 : 1, PRIORITY_ORDER[v.judgment?.priority ?? ''] ?? 3, v.verdict ? VERDICT_ORDER[v.verdict] : 5];
  const ra = rank(a);
  const rb = rank(b);
  return ra[0] - rb[0] || ra[1] - rb[1] || ra[2] - rb[2];
}

/** '직접 확인'으로 남는 명제인지. 찾아보니 자료가 있어 판정이 난 것은 아니다 */
export const staysDirect = (view: ClaimView): boolean => view.direct !== null && !view.direct.reclassified;

/** 판정표의 한 줄. 한 줄이 문장 하나다 */
export interface SentenceRow {
  sentence: Sentence;
  /** 이 문장에 걸린 명제 전체('직접 확인' 포함). 원고에서 뽑힌 순서다 */
  views: ClaimView[];
  /** 가장 급한 명제. 줄의 자리를 정하고, 줄을 누르면 이 명제를 연다 */
  top: ClaimView;
  /** 줄에 올릴 판정 표시. 손봐야 할 판정을 급한 순서로 적고, 손볼 것이 없으면 '일치' 하나만 적는다 */
  badges: Array<{ verdict: Verdict; count: number }>;
  /** 이 문장의 편집 우선순위. 손봐야 할 명제들 가운데 가장 높은 값이다. 손볼 것이 없으면 null */
  priority: Priority | null;
  /** '일치'로 끝난 명제 수 */
  okCount: number;
  /** 처리가 끝나지 않은 명제 */
  pending: ClaimView[];
  /** 모두 끝났고 모두 '일치'다 */
  allOk: boolean;
}

/**
 * 판정표의 줄을 만든다. 공개 자료로 확인하는 명제가 하나라도 있는 문장만 올리고, 원고 순서로 돌려준다.
 * '직접 확인'으로만 이뤄진 문장은 직접 확인 목록에만 둔다.
 */
export function sentenceRows(run: RunState): SentenceRow[] {
  const rows: SentenceRow[] = [];
  for (const sentence of run.sentences) {
    const views = run.claims.filter((e) => e.claim.sentenceId === sentence.id).map((e) => viewOf(run, e));
    if (!views.some((v) => !staysDirect(v))) continue;
    const finished = views.filter((v) => v.state === '완료' && v.verdict !== null);
    const pending = views.filter((v) => !(v.state === '완료' && v.verdict !== null));
    const warned = finished.filter((v) => v.verdict !== '일치').sort(compareByRank);
    const okCount = finished.length - warned.length;
    const badges: SentenceRow['badges'] = [];
    for (const v of [...warned].sort((a, b) => VERDICT_ORDER[a.verdict as Verdict] - VERDICT_ORDER[b.verdict as Verdict])) {
      const last = badges[badges.length - 1];
      if (last && last.verdict === v.verdict) last.count += 1;
      else badges.push({ verdict: v.verdict as Verdict, count: 1 });
    }
    const allOk = pending.length === 0 && warned.length === 0;
    if (allOk) badges.push({ verdict: '일치', count: 1 });
    const priority =
      warned
        .map((v) => v.judgment?.priority ?? null)
        .filter((p): p is Priority => p !== null)
        .sort((x, y) => PRIORITY_ORDER[x] - PRIORITY_ORDER[y])[0] ?? null;
    rows.push({ sentence, views, top: warned[0] ?? pending[0] ?? views[0], badges, priority, okCount, pending, allOk });
  }
  return rows;
}

/**
 * 판정표의 줄 순서. 불일치가 난 문장을 먼저 두고, 그 안과 나머지에서는 그 문장의 편집 우선순위가 높은 것부터,
 * 같으면 가장 무거운 판정(근거 부족, 해석 주의) 순, 그래도 같으면 원고 순서로 둔다
 */
export function compareRows(a: SentenceRow, b: SentenceRow): number {
  const rank = (row: SentenceRow) => [
    row.badges.some((x) => x.verdict === '불일치') ? 0 : 1,
    PRIORITY_ORDER[row.priority ?? ''] ?? 3,
    row.badges[0] ? VERDICT_ORDER[row.badges[0].verdict] : 5,
  ];
  const ra = rank(a);
  const rb = rank(b);
  return ra[0] - rb[0] || ra[1] - rb[1] || ra[2] - rb[2] || a.sentence.id - b.sentence.id;
}

const NO_REVIEW: ReviewEntry = { choice: '', edited: null, at: '' };

export function reviewOf(run: RunState, sentenceId: number): ReviewEntry {
  return run.reviews?.[sentenceId] ?? NO_REVIEW;
}

/** 자동으로 만든 수정안. 만들지 않았거나 걸러졌으면 null */
export function autoRevision(run: RunState, sentenceId: number): SentenceRevision | null {
  const entry = run.revisions[sentenceId];
  return entry?.state === '완료' && entry.revision?.revised ? entry.revision : null;
}

/** 지금의 수정안: 편집자가 고쳐 쓴 글이 있으면 그것, 없으면 자동으로 만든 수정안. 둘 다 없으면 null */
export function candidateText(run: RunState, sentenceId: number): string | null {
  const edited = reviewOf(run, sentenceId).edited;
  return edited !== null ? edited : (autoRevision(run, sentenceId)?.revised ?? null);
}

/** 채택한 문장인지. 채택은 수정안이 있을 때만 뜻이 있다 */
export function isAdopted(run: RunState, sentenceId: number): boolean {
  return reviewOf(run, sentenceId).choice === '채택' && candidateText(run, sentenceId) !== null;
}

/**
 * 문장에 딸린 재검증 기록(F14). 다시 검증하는 것은 편집자가 고쳐 쓴 글뿐이고, 결과는 그 글에 딸린다.
 * 원문에는 처음 검증의 판정 하나만 둔다. 같은 글에 판정이 둘 생기면 어느 쪽을 따를지 알 수 없기 때문이다.
 * 그래서 원문을 다시 검증한 예전 기록이 저장돼 있거나, 고쳐 쓴 글이 지금은 없으면 돌려주지 않는다
 */
export function recheckOf(run: RunState, sentenceId: number): RecheckEntry | null {
  const entry = run.rechecks?.[sentenceId];
  return entry && entry.target === 'edited' && reviewOf(run, sentenceId).edited !== null ? entry : null;
}

/**
 * 지금의 고쳐 쓴 글을 다시 검증할 수 있는지(F14). 한 글에는 검증 결과를 하나만 둔다.
 * 고쳐 쓴 글이 있고, 그 글을 끝까지 검증한 기록이 없을 때만 할 수 있다. 실패했거나 멈춘 검증은 다시 할 수 있다
 */
export function canRecheck(run: RunState, sentenceId: number): boolean {
  const edited = reviewOf(run, sentenceId).edited;
  if (edited === null) return false;
  const entry = recheckOf(run, sentenceId);
  if (!entry || entry.text !== edited) return true;
  if (entry.state === '진행 중') return false;
  // 딸린 명제 가운데 하나라도 실패했거나 멈췄으면 끝까지 검증한 것이 아니다
  return !(entry.state === '완료' && entry.claims.every((e) => e.state === '완료'));
}

export type RecheckStatus = '미검증' | '검증 중' | '현재 문장 검증 완료' | '이전 문장에 대한 결과';

/** 재검증 상태(F14). 고쳐 쓰지 않은 문장에는 재검증 상태가 없다(null) */
export function recheckStatus(run: RunState, sentence: Sentence): RecheckStatus | null {
  const edited = reviewOf(run, sentence.id).edited;
  if (edited === null) return null;
  const entry = recheckOf(run, sentence.id);
  if (entry?.state === '진행 중') return '검증 중';
  if (entry?.state === '완료') return entry.text === edited ? '현재 문장 검증 완료' : '이전 문장에 대한 결과';
  return '미검증';
}

/** 이 명제가 지금의 수정안에서 어떻게 됐는지 한 줄로 적는다(상세의 '이 문장에서 확인한 사실') */
export function factNote(run: RunState, view: ClaimView): { text: string; tone: 'ok' | 'warn' | '' } {
  const { id, sentenceId } = view.entry.claim;
  if (view.state !== '완료' || view.verdict === null) {
    if (view.state === '실패') return { text: `처리하지 못했습니다(${view.failure || '사유를 알 수 없음'})`, tone: 'warn' };
    return { text: view.state === '진행 중' ? '검증하는 중입니다' : '아직 처리가 끝나지 않았습니다', tone: '' };
  }
  if (view.verdict === '일치') return { text: '고칠 것이 없습니다', tone: 'ok' };
  const sentence = run.sentences.find((s) => s.id === sentenceId);
  if (reviewOf(run, sentenceId).edited !== null) {
    return sentence && recheckStatus(run, sentence) === '현재 문장 검증 완료'
      ? { text: '고쳐 쓴 문장을 다시 검증한 결과는 아래에 있습니다', tone: '' }
      : { text: '고쳐 쓴 문장은 아직 다시 검증하지 않았습니다', tone: 'warn' };
  }
  const entry = run.revisions[sentenceId];
  const revision = entry?.state === '완료' ? entry.revision : null;
  if (revision?.revised && revision.applied.includes(id)) return { text: '수정안에 반영했습니다', tone: 'ok' };
  if (view.verdict === '직접 확인') return { text: '공개 자료로 확인할 수 없어, 직접 확인이 필요합니다', tone: 'warn' };
  const skipped = revision?.skipped.find((s) => s.claimId === id);
  if (skipped) return { text: `수정안에 넣지 못했습니다(${skipped.why})`, tone: 'warn' };
  if (view.verdict === '근거 부족') return { text: '확인하지 못해 그대로 뒀습니다', tone: 'warn' };
  const hasFix = view.judgment !== null && view.judgment.fix.kind !== '없음';
  return { text: hasFix ? '고칠 내용은 있지만 수정안에 넣지 못했습니다' : '고칠 방향을 하나로 정하지 못해 그대로 뒀습니다', tone: 'warn' };
}

/**
 * 내보낼 원고에서 이 명제가 풀렸는지. '일치'였거나, 채택한 수정안이 이 명제를 고쳤을 때다.
 * 편집자가 고쳐 쓴 문장은 그 글을 다시 검증해 모두 '일치'가 나왔을 때만 풀린 것으로 본다.
 */
export function isResolved(run: RunState, view: ClaimView): boolean {
  if (view.verdict === '일치') return true;
  const { id, sentenceId } = view.entry.claim;
  if (!isAdopted(run, sentenceId)) return false;
  const edited = reviewOf(run, sentenceId).edited;
  if (edited !== null) {
    const recheck = recheckOf(run, sentenceId);
    return recheck?.state === '완료' && recheck.text === edited && recheck.claims.every((e) => viewOf(run, e).verdict === '일치');
  }
  return autoRevision(run, sentenceId)?.applied.includes(id) ?? false;
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
