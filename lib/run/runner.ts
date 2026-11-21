// 화면이 맡는 진행. 원고를 묶음으로 나눠 [추출]을 요청하고, 명제마다 [근거 모으기]와 [판정]을,
// 문장마다 [수정안 합치기]를 요청한다(PRD 7장). 서버를 부르는 부분은 밖에서 받아, Liner 없이도 확인할 수 있게 했다.
//
// 지키는 것
// - 같은 명제는 한 번만 처리한다. 내용이 같으면 근거를 함께 쓰고, 문장과 자리까지 같으면 판정도 함께 쓴다.
// - 실패한 단계만 다시 한다. 이미 모은 근거가 있으면 다시 검색하지 않는다(F16).
// - '직접 확인'으로 분류됐지만 유형이 내부 수치나 비공개 취재가 아니면 검색을 한 번 해 본 뒤 확정한다(F9).
// - 멈추거나 기록을 지운 뒤에 늦게 도착한 응답은 저장하지 않는다(F17).
import { buildExtractChunks, followingText } from '../chunks.ts';
import { LIMITS } from '../limits.ts';
import { planMerge, unresolvedAfter } from '../merge/plan.ts';
import type { ExtractInput } from '../prompts/extract.ts';
import { contentId, splitManuscript } from '../sentences.ts';
import type { Claim, ClaimCore, EvidenceBundle, Judgment, MergeFix, SentenceRevision, Usage } from '../types.ts';
import {
  PRIVATE_BY_NATURE,
  bundleLeader,
  coreKey,
  entryOf,
  isLead,
  judgeKey,
  judgeLeader,
  recover,
  sentenceClaims,
  type ChunkEntry,
  type ClaimEntry,
  type RevisionEntry,
  type RunState,
} from './model.ts';

export interface ApiFailure {
  ok: false;
  /** 사용자가 멈췄거나 기록을 지워서 끊긴 요청 */
  aborted: boolean;
  /** 접속 코드나 키처럼, 다시 보내도 같은 결과가 나올 문제. 실행 전체를 멈춘다 */
  fatal: boolean;
  status: number;
  /** 화면에 보일 실패 사유 */
  reason: string;
}

export type ApiResult<T> = ({ ok: true } & T) | ApiFailure;

export interface GatherRequest {
  statement: string;
  type: Claim['type'];
  qualifiers: string[];
  asOf: string;
  queries: string[];
  counterQuery: string;
  isPublic: true;
}

export interface JudgeRequest {
  claim: ClaimCore;
  sentence: string;
  lead: boolean;
  bundle: EvidenceBundle;
  signature: string;
}

export interface MergeRequest {
  sentence: string;
  fixes: MergeFix[];
}

/** 서버의 네 경로. 화면은 fetch로, 확인용 도구는 흉내 낸 함수로 채운다 */
export interface RunApi {
  extract(input: ExtractInput, signal: AbortSignal): Promise<ApiResult<{ claims: Claim[]; dropped: number; usage: Usage }>>;
  gather(claim: GatherRequest, signal: AbortSignal): Promise<ApiResult<{ bundle: EvidenceBundle; signature: string; usage: Usage[] }>>;
  judge(body: JudgeRequest, signal: AbortSignal): Promise<ApiResult<{ judgment: Judgment; usage: Usage[] }>>;
  merge(body: MergeRequest, signal: AbortSignal): Promise<ApiResult<{ revision: SentenceRevision; usage: Usage[] }>>;
}

export interface RunStore {
  get(): RunState | null;
  set(update: (prev: RunState | null) => RunState | null): void;
}

export interface RunnerOptions {
  /** 동시에 처리하는 수 */
  concurrency?: number;
  /** 실행 하나가 처리하는 명제 수. 넘는 것은 '대기'로 남겨 다음 실행으로 넘긴다 */
  claimsPerRun?: number;
  now?: () => number;
}

export type StartResult = { ok: true } | { ok: false; message: string };

const ABORTED: ApiFailure = { ok: false, aborted: true, fatal: false, status: 0, reason: '중단' };

function newEntry(claim: Claim): ClaimEntry {
  const direct = claim.isPublic ? null : { probe: !PRIVATE_BY_NATURE.includes(claim.type), reclassified: false, note: '' };
  // 내부 수치나 비공개 취재는 찾아볼 공개 자료가 없으므로 바로 '직접 확인'으로 확정한다
  const settled = direct !== null && !direct.probe;
  return { claim, state: settled ? '완료' : '대기', step: '', failure: '', bundle: null, signature: '', judgment: null, bundleFrom: null, judgeFrom: null, direct };
}

/** 검색 없이 확정한 '직접 확인'인지. 처리할 것이 없는 항목이다 */
const settledDirect = (entry: ClaimEntry) => entry.direct !== null && !entry.direct.probe;

const orderOf = (claimId: string) => Number(claimId.split('-c')[1] ?? 0);

/**
 * 같은 명제를 묶는다. 이미 결과가 있는 항목을 먼저 올리고, 아직 처리하지 않은 항목을 원고 순서대로 붙인다.
 * 그래서 다시 실행할 때도 앞서 얻은 근거와 판정을 함께 쓴다.
 */
export function regroup(run: RunState): RunState {
  const judgeLeaders = new Map<string, string>();
  const coreLeaders = new Map<string, string>();
  const touched = (e: ClaimEntry) => e.bundle !== null || e.judgment !== null || e.state === '완료';
  for (const e of run.claims) {
    if (settledDirect(e) || !touched(e) || e.judgeFrom) continue;
    const jk = judgeKey(e.claim, run.sentences);
    if (!judgeLeaders.has(jk)) judgeLeaders.set(jk, e.claim.id);
    const ck = coreKey(e.claim);
    if (!e.bundleFrom && !coreLeaders.has(ck)) coreLeaders.set(ck, e.claim.id);
  }
  const claims = run.claims.map((e) => {
    if (settledDirect(e) || touched(e)) return e;
    const jk = judgeKey(e.claim, run.sentences);
    const judgeFrom = judgeLeaders.get(jk);
    if (judgeFrom && judgeFrom !== e.claim.id) return { ...e, judgeFrom, bundleFrom: null };
    judgeLeaders.set(jk, e.claim.id);
    const ck = coreKey(e.claim);
    const bundleFrom = coreLeaders.get(ck);
    if (bundleFrom && bundleFrom !== e.claim.id) return { ...e, judgeFrom: null, bundleFrom };
    coreLeaders.set(ck, e.claim.id);
    return { ...e, judgeFrom: null, bundleFrom: null };
  });
  return { ...run, claims };
}

/** 함께 쓰는 수정안의 명제 번호를 이 문장의 번호로 바꾼다 */
export function remapRevision(revision: SentenceRevision, ids: Map<string, string>): SentenceRevision {
  const to = (id: string) => ids.get(id) ?? id;
  return {
    ...revision,
    edits: revision.edits.map((e) => ({ ...e, claimIds: e.claimIds.map(to) })),
    applied: revision.applied.map(to),
    skipped: revision.skipped.map((s) => ({ ...s, claimId: to(s.claimId) })),
  };
}

export function createRunner(store: RunStore, api: RunApi, options: RunnerOptions = {}) {
  const concurrency = options.concurrency ?? LIMITS.concurrency;
  const claimsPerRun = options.claimsPerRun ?? LIMITS.claimsPerRun;
  const now = options.now ?? (() => Date.now());
  let controller: AbortController | null = null;
  let current: Promise<void> = Promise.resolve();

  async function pass(runId: string): Promise<void> {
    const mine = new AbortController();
    controller = mine;
    const signal = mine.signal;
    const alive = () => !signal.aborted && store.get()?.runId === runId;
    const update = (fn: (run: RunState) => RunState) => store.set((prev) => (prev && prev.runId === runId ? fn(prev) : prev));
    const snapshot = () => store.get() as RunState;

    const setEntry = (id: string, patch: Partial<ClaimEntry>) =>
      update((run) => ({ ...run, claims: run.claims.map((e) => (e.claim.id === id ? { ...e, ...patch } : e)) }));
    const setChunk = (index: number, patch: Partial<ChunkEntry>) =>
      update((run) => ({ ...run, chunks: run.chunks.map((c, i) => (i === index ? { ...c, ...patch } : c)) }));
    const setRevision = (sentenceId: number, entry: RevisionEntry) => update((run) => ({ ...run, revisions: { ...run.revisions, [sentenceId]: entry } }));
    const addUsage = (usage: Usage[]) => update((run) => ({ ...run, usage: [...run.usage, ...usage] }));
    /** 접속 코드나 키 문제. 남은 요청도 같은 결과가 나오므로 실행을 멈춘다 */
    const block = (reason: string) => {
      update((run) => ({ ...run, blocked: reason }));
      mine.abort();
    };

    async function pool<T>(items: T[], work: (item: T) => Promise<void>): Promise<void> {
      let next = 0;
      const worker = async () => {
        while (next < items.length && alive()) {
          const item = items[next];
          next += 1;
          try {
            await work(item);
          } catch (e) {
            // 한 항목에서 난 예기치 않은 오류로 나머지가 멈추지 않게 한다
            console.error(e);
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
    }

    // ---------- 1. 추출 ----------
    async function extractChunk(index: number): Promise<void> {
      if (!alive()) return;
      const chunk = snapshot().chunks[index];
      setChunk(index, { state: '진행 중', failure: '' });
      const result = await api.extract(
        { title: chunk.title, context: chunk.context, sentences: chunk.sentences, ...(chunk.after ? { after: chunk.after } : {}) },
        signal,
      );
      if (!alive()) return;
      if (result.ok) {
        update((run) => {
          const known = new Set(run.claims.map((e) => e.claim.id));
          const added = result.claims.filter((c) => !known.has(c.id)).map(newEntry);
          const claims = [...run.claims, ...added].sort(
            (a, b) => a.claim.sentenceId - b.claim.sentenceId || orderOf(a.claim.id) - orderOf(b.claim.id),
          );
          return {
            ...run,
            claims,
            dropped: run.dropped + (result.dropped ?? 0),
            usage: [...run.usage, result.usage],
            chunks: run.chunks.map((c, i): ChunkEntry => (i === index ? { ...c, state: '완료', failure: '' } : c)),
          };
        });
        return;
      }
      if (result.fatal) return block(result.reason);
      // 응답이 잘렸거나 온전하지 않으면 입력을 반으로 나눠 한 번 더 보낸다. 그래도 안 되면 실패로 남긴다(F16)
      const canSplit = !chunk.split && chunk.sentences.length > 1 && /응답 잘림|응답 형식 오류/.test(result.reason);
      if (!canSplit) {
        setChunk(index, { state: '실패', failure: result.reason });
        return;
      }
      const half = Math.ceil(chunk.sentences.length / 2);
      const firstHalf = chunk.sentences.slice(0, half);
      // 앞쪽 반의 뒤 문맥은 뒤쪽 반의 앞부분이다. 뒤쪽 반은 원래 묶음의 뒤 문맥을 그대로 쓴다
      const afterFirst = followingText(snapshot().sentences, firstHalf[firstHalf.length - 1].id);
      const { after: _whole, ...rest } = chunk;
      const first: ChunkEntry = { ...rest, ...(afterFirst ? { after: afterFirst } : {}), sentences: firstHalf, state: '대기', failure: '', split: true };
      const second: ChunkEntry = {
        ...chunk,
        sentences: chunk.sentences.slice(half),
        context: firstHalf
          .map((s) => s.text)
          .join(' ')
          .slice(-LIMITS.extract.contextChars),
        state: '대기',
        failure: '',
        split: true,
      };
      let secondIndex = -1;
      update((run) => {
        const chunks = [...run.chunks];
        chunks[index] = first;
        secondIndex = chunks.length;
        chunks.push(second);
        return { ...run, chunks };
      });
      if (secondIndex < 0) return;
      await extractChunk(index);
      await extractChunk(secondIndex);
    }

    // ---------- 2. 근거 모으기와 판정 ----------
    const gathering = new Map<string, Promise<ApiFailure | null>>();

    async function gatherFor(holderId: string): Promise<ApiFailure | null> {
      const claim = (entryOf(snapshot(), holderId) as ClaimEntry).claim;
      // '직접 확인' 후보에는 추출이 검색어를 달지 않는다. 명제를 그대로 검색어로 써서 한 번 찾아본다
      const own = claim.isPublic ? claim.queries.filter(Boolean) : [];
      const queries = own.length > 0 ? own : [claim.statement.slice(0, 120)];
      const result = await api.gather(
        {
          statement: claim.statement,
          type: claim.type,
          qualifiers: claim.qualifiers,
          asOf: claim.asOf,
          queries,
          counterQuery: claim.isPublic ? claim.counterQuery : '',
          isPublic: true,
        },
        signal,
      );
      if (!alive()) return ABORTED;
      if (!result.ok) {
        if (result.fatal) block(result.reason);
        return result;
      }
      update((run) => ({
        ...run,
        usage: [...run.usage, ...result.usage],
        claims: run.claims.map((e) => (e.claim.id === holderId ? { ...e, bundle: result.bundle, signature: result.signature } : e)),
      }));
      return null;
    }

    /** 근거를 한 번만 모은다. 같은 명제를 기다리는 항목들은 같은 요청의 결과를 받는다 */
    function ensureBundle(holderId: string): Promise<ApiFailure | null> {
      if (entryOf(snapshot(), holderId)?.bundle) return Promise.resolve(null);
      let job = gathering.get(holderId);
      if (!job) {
        job = gatherFor(holderId);
        gathering.set(holderId, job);
      }
      return job;
    }

    async function verifyOne(id: string): Promise<void> {
      if (!alive()) return;
      const before = snapshot();
      const holderId = bundleLeader(before, entryOf(before, id) as ClaimEntry).claim.id;
      setEntry(id, { state: '진행 중', step: entryOf(before, holderId)?.bundle ? '판정' : '근거 모으기', failure: '' });

      const failed = await ensureBundle(holderId);
      if (!alive()) return;
      if (failed) {
        setEntry(id, { state: failed.aborted ? '중단' : '실패', step: '', failure: failed.aborted ? '' : failed.reason });
        return;
      }
      const run = snapshot();
      const entry = entryOf(run, id) as ClaimEntry;
      const holder = entryOf(run, holderId) as ClaimEntry;
      const bundle = holder.bundle as EvidenceBundle;

      // '직접 확인' 후보인데 이 주장을 다룬 자료가 없으면 그대로 확정한다
      if (entry.direct?.probe && bundle.evidence.length === 0) {
        setEntry(id, {
          state: '완료',
          step: '',
          direct: { probe: true, reclassified: false, note: '검색을 한 번 해 보았지만 이 주장을 다룬 공개 자료를 찾지 못했습니다.' },
        });
        await afterClaim(id);
        return;
      }

      setEntry(id, { step: '판정' });
      const sentence = run.sentences.find((s) => s.id === entry.claim.sentenceId);
      const result = await api.judge(
        {
          claim: { statement: entry.claim.statement, type: entry.claim.type, qualifiers: entry.claim.qualifiers, asOf: entry.claim.asOf },
          sentence: sentence?.plain ?? '',
          lead: isLead(run.sentences, entry.claim.sentenceId),
          bundle,
          signature: holder.signature,
        },
        signal,
      );
      if (!alive()) return;
      if (!result.ok) {
        if (result.fatal) return block(result.reason);
        // 서명이 맞지 않는 근거 묶음은 버린다. 다시 실행하면 새로 모은다
        if (result.status === 409) setEntry(holderId, { bundle: null, signature: '' });
        setEntry(id, { state: result.aborted ? '중단' : '실패', step: '', failure: result.aborted ? '' : result.reason });
        return;
      }
      addUsage(result.usage);
      if (entry.direct?.probe) {
        // 검색해 보니 판정할 자료가 있었으면 그 판정을 쓰고, 없었으면 '직접 확인'으로 확정한다
        const decided = result.judgment.verdict !== '근거 부족';
        const note = decided
          ? '처음에는 공개 자료로 확인할 수 없는 주장으로 봤지만, 검색해 보니 자료가 있어 판정했습니다.'
          : '검색을 한 번 해 보았지만 판정할 만한 공개 자료가 없었습니다.';
        setEntry(id, { state: '완료', step: '', judgment: result.judgment, direct: { probe: true, reclassified: decided, note } });
      } else {
        setEntry(id, { state: '완료', step: '', judgment: result.judgment });
      }
      await afterClaim(id);
    }

    /** 판정이 끝난 명제가 걸린 문장마다, 수정안을 합칠 때가 됐는지 본다 */
    async function afterClaim(leaderId: string): Promise<void> {
      const run = snapshot();
      const sentenceIds = new Set(run.claims.filter((e) => e.claim.id === leaderId || e.judgeFrom === leaderId).map((e) => e.claim.sentenceId));
      for (const sentenceId of sentenceIds) await mergeSentence(sentenceId);
    }

    // ---------- 3. 수정안 합치기 ----------
    type MergeDone = { ok: true; revision: SentenceRevision; fixes: MergeFix[] } | ApiFailure;
    const merging = new Map<string, Promise<MergeDone>>();

    async function runMerge(sentence: string, fixes: MergeFix[]): Promise<MergeDone> {
      const result = await api.merge({ sentence, fixes }, signal);
      if (!alive()) return ABORTED;
      if (!result.ok) {
        if (result.fatal) block(result.reason);
        return result;
      }
      addUsage(result.usage);
      return { ok: true, revision: result.revision, fixes };
    }

    async function mergeSentence(sentenceId: number): Promise<void> {
      if (!alive()) return;
      const run = snapshot();
      const sentence = run.sentences.find((s) => s.id === sentenceId);
      if (!sentence) return;
      const list = sentenceClaims(run, sentenceId);
      const plan = planMerge(list);
      // 연결된 명제 가운데 끝나지 않은 것이 있으면 기다린다(F7)
      if (!plan.ready) return;
      const fixesKey = JSON.stringify([sentence.source, plan.fixes]);
      const existing = run.revisions[sentenceId];
      if (existing && existing.fixesKey === fixesKey && ['완료', '없음', '진행 중'].includes(existing.state)) return;
      if (plan.fixes.length === 0) {
        setRevision(sentenceId, { state: '없음', failure: '', revision: null, unresolved: unresolvedAfter(list, []), fixesKey });
        return;
      }
      setRevision(sentenceId, { state: '진행 중', failure: '', revision: null, unresolved: [], fixesKey });
      // 같은 문장에 같은 고칠 내용이면 한 번만 만들어 함께 쓴다. 같은 문장이 두 번 나와도 수정안이 갈리지 않는다
      const shareKey = JSON.stringify([sentence.source, plan.fixes.map((f) => [f.kind, f.instruction, f.sourceName, f.statement])]);
      let job = merging.get(shareKey);
      if (!job) {
        job = runMerge(sentence.source, plan.fixes);
        merging.set(shareKey, job);
      }
      const done = await job;
      if (!alive()) return;
      if (!done.ok) {
        setRevision(sentenceId, { state: done.aborted ? '중단' : '실패', failure: done.aborted ? '' : done.reason, revision: null, unresolved: [], fixesKey });
        return;
      }
      const ids = new Map(done.fixes.map((f, i) => [f.claimId, plan.fixes[i].claimId] as [string, string]));
      const revision = remapRevision(done.revision, ids);
      setRevision(sentenceId, { state: '완료', failure: '', revision, unresolved: unresolvedAfter(list, revision.applied), fixesKey });
    }

    // ---------- 실행 ----------
    update((run) => ({
      ...run,
      status: run.chunks.some((c) => c.state !== '완료') ? '추출 중' : '검증 중',
      passStartedAt: now(),
      blocked: '',
      deferred: 0,
      // 다시 돌릴 것은 '대기'로 돌려놓는다. 차례를 기다리는 동안 앞 실행의 실패 표시가 남지 않게 한다
      chunks: run.chunks.map((c): ChunkEntry => (c.state === '완료' ? c : { ...c, state: '대기', failure: '' })),
      claims: run.claims.map((e): ClaimEntry => (e.state === '완료' ? e : { ...e, state: '대기', step: '', failure: '' })),
      revisions: Object.fromEntries(Object.entries(run.revisions).filter(([, r]) => r.state === '완료' || r.state === '없음')),
    }));

    try {
      const chunkIndexes = snapshot()
        .chunks.map((c, i) => (c.state === '완료' ? -1 : i))
        .filter((i) => i >= 0);
      await pool(chunkIndexes, extractChunk);

      if (alive()) {
        update((run) => ({ ...regroup(run), status: '검증 중' }));
        const run = snapshot();
        const leaders = run.claims.filter((e) => !e.judgeFrom && e.state !== '완료' && !settledDirect(e));
        const batch = leaders.slice(0, claimsPerRun).map((e) => e.claim.id);
        if (leaders.length > batch.length) {
          const later = new Set(leaders.slice(claimsPerRun).map((e) => e.claim.id));
          update((r) => ({ ...r, deferred: r.claims.filter((e) => later.has(judgeLeader(r, e).claim.id)).length }));
        }
        await pool(batch, verifyOne);
        // 명제가 모두 '직접 확인'인 문장이나 앞 실행에서 수정안이 실패한 문장까지 훑는다
        if (alive()) {
          await pool(
            snapshot().sentences.map((s) => s.id),
            mergeSentence,
          );
        }
      }
    } finally {
      const stopped = signal.aborted;
      store.set((prev) => {
        if (!prev || prev.runId !== runId) return prev;
        const settled = recover({ ...prev, status: '검증 중' });
        return {
          ...settled,
          status: stopped ? '중단' : '끝남',
          activeMs: prev.activeMs + (prev.passStartedAt !== null ? Math.max(0, now() - prev.passStartedAt) : 0),
          passStartedAt: null,
        };
      });
      if (controller === mine) controller = null;
    }
  }

  function stop(): void {
    controller?.abort();
  }

  return {
    /** 원고를 문장으로 나누고 실행을 시작한다. 앞서 돌던 실행은 멈추고 그 기록을 새 실행으로 바꾼다 */
    start(text: string): StartResult {
      const sentences = splitManuscript(text);
      if (sentences.length === 0) return { ok: false, message: '원고에서 문장을 찾지 못했습니다.' };
      stop();
      const runId = `${now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const run: RunState = {
        v: 1,
        runId,
        manuscript: text,
        manuscriptKey: contentId(text),
        title: sentences.find((s) => s.kind === 'heading')?.plain ?? '',
        sentences,
        status: '추출 중',
        chunks: buildExtractChunks(sentences).map((c) => ({ ...c, state: '대기', failure: '', split: false })),
        dropped: 0,
        claims: [],
        revisions: {},
        usage: [],
        activeMs: 0,
        passStartedAt: null,
        startedAt: new Date(now()).toISOString(),
        blocked: '',
        deferred: 0,
      };
      store.set(() => run);
      current = current.then(() => pass(runId));
      return { ok: true };
    },
    /** 끝나지 않은 것만 다시 돌린다: 실패하거나 중단된 묶음과 명제, 다음 실행으로 넘긴 명제, 실패한 수정안 */
    resume(): void {
      const run = store.get();
      if (!run || controller) return;
      const runId = run.runId;
      current = current.then(() => pass(runId));
    },
    stop,
    /** 기록 삭제(F17): 돌던 실행을 멈추고 상태를 비운다. 늦게 도착하는 응답은 실행 번호가 달라 버려진다 */
    clear(): void {
      stop();
      store.set(() => null);
    },
    isRunning: () => controller !== null,
    /** 지금 도는 실행이 끝날 때까지 기다린다(확인용 도구가 쓴다) */
    idle: () => current,
  };
}

export type Runner = ReturnType<typeof createRunner>;
