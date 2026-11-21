// 선택한 문장 다시 검증(F14). 편집자가 고른 문장을 처음부터 다시 추출하고 검증한다.
// 고쳐 쓴 문장이 맞는지 확인하는 데 쓴다. 결과는 요청할 때의 글에 묶어 두고, 판정표(원문을 검증한 기록)는 바꾸지 않는다.
// 서버를 부르는 부분은 실행(runner)과 같은 것을 밖에서 받는다.
import { followingText } from '../chunks.ts';
import { LIMITS } from '../limits.ts';
import { stripMarkup } from '../sentences.ts';
import type { Usage } from '../types.ts';
import { isLead, recheckTarget, type ClaimEntry, type RecheckEntry, type RunState, type Step } from './model.ts';
import type { RunApi, RunStore } from './runner.ts';

export function createRechecker(store: RunStore, api: RunApi, options: { now?: () => number } = {}) {
  const now = options.now ?? (() => Date.now());
  const controllers = new Map<number, AbortController>();
  const jobs = new Set<Promise<void>>();

  async function work(sentenceId: number): Promise<void> {
    const start = store.get();
    const sentence = start?.sentences.find((s) => s.id === sentenceId);
    if (!start || !sentence) return;
    // 같은 문장을 다시 요청하면 앞선 요청은 멈춘다
    controllers.get(sentenceId)?.abort();
    const mine = new AbortController();
    controllers.set(sentenceId, mine);
    const signal = mine.signal;
    const runId = start.runId;
    const token = `${now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const { text, target } = recheckTarget(start, sentence);
    const plain = stripMarkup(text);
    const startedAt = now();

    /** 이 요청의 결과를 아직 받아도 되는지. 기록을 지웠거나 같은 문장을 다시 요청했으면 받지 않는다 */
    const current = (run: RunState | null): run is RunState => run !== null && run.runId === runId && run.rechecks?.[sentenceId]?.token === token;
    const alive = () => !signal.aborted && current(store.get());
    const patch = (change: (entry: RecheckEntry) => RecheckEntry, usage: Usage[] = []) =>
      store.set((prev) => {
        if (!current(prev)) return prev;
        const entry = (prev.rechecks as Record<number, RecheckEntry>)[sentenceId];
        return { ...prev, usage: usage.length ? [...prev.usage, ...usage] : prev.usage, rechecks: { ...prev.rechecks, [sentenceId]: change(entry) } };
      });
    const setClaim = (id: string, change: Partial<ClaimEntry>, usage: Usage[] = []) =>
      patch((entry) => ({ ...entry, claims: entry.claims.map((e) => (e.claim.id === id ? { ...e, ...change } : e)) }), usage);

    store.set((prev) =>
      prev && prev.runId === runId
        ? { ...prev, rechecks: { ...prev.rechecks, [sentenceId]: { token, text, target, state: '진행 중', failure: '', claims: [], at: new Date(now()).toISOString() } } }
        : prev,
    );

    try {
      // 제목과 앞뒤 문장을 함께 보낸다. '그는', '이 유물', '이듬해'처럼 문맥이 있어야 풀리는 말이 있기 때문이다
      const context = start.sentences
        .filter((s) => s.id < sentenceId && s.kind !== 'heading')
        .map((s) => s.plain)
        .join(' ')
        .slice(-LIMITS.extract.contextChars);
      // 뒤 문맥은 다음 소제목이 나오기 전까지의 문장에서 앞부분만 보낸다. 처음 검증의 묶음과 같은 규칙이다
      const after = followingText(start.sentences, sentenceId);
      const extracted = await api.extract({ title: start.title, context, sentences: [{ id: sentenceId, text: plain }], ...(after ? { after } : {}) }, signal);
      if (!alive()) return;
      if (!extracted.ok) {
        patch((entry) => ({ ...entry, state: extracted.aborted ? '중단' : '실패', failure: extracted.aborted ? '' : extracted.reason }));
        return;
      }

      // 번호는 원문을 검증한 명제(s6-c1)와 겹치지 않게 따로 매긴다
      const entries: ClaimEntry[] = extracted.claims.map((claim, i) => {
        // 공개 자료로 확인할 수 없는 주장은 찾아보지 않고 '직접 확인'으로 둔다
        const direct = claim.isPublic ? null : { probe: false, reclassified: false, note: '' };
        return {
          claim: { ...claim, id: `r${sentenceId}-c${i + 1}` },
          state: claim.isPublic ? '대기' : '완료',
          step: '' as Step,
          failure: '',
          bundle: null,
          signature: '',
          judgment: null,
          bundleFrom: null,
          judgeFrom: null,
          direct,
        };
      });
      patch((entry) => ({ ...entry, claims: entries }), [extracted.usage]);

      const lead = isLead(start.sentences, sentenceId);
      await Promise.all(
        entries
          .filter((e) => e.claim.isPublic)
          .map(async ({ claim }) => {
            setClaim(claim.id, { state: '진행 중', step: '근거 모으기' });
            const queries = claim.queries.filter(Boolean);
            const gathered = await api.gather(
              {
                statement: claim.statement,
                type: claim.type,
                qualifiers: claim.qualifiers,
                asOf: claim.asOf,
                queries: queries.length > 0 ? queries : [claim.statement.slice(0, 120)],
                counterQuery: claim.counterQuery,
                isPublic: true,
              },
              signal,
            );
            if (!alive()) return;
            if (!gathered.ok) {
              setClaim(claim.id, { state: gathered.aborted ? '중단' : '실패', step: '', failure: gathered.aborted ? '' : gathered.reason });
              return;
            }
            setClaim(claim.id, { bundle: gathered.bundle, signature: gathered.signature, step: '판정' }, gathered.usage);
            const judged = await api.judge(
              {
                claim: { statement: claim.statement, type: claim.type, qualifiers: claim.qualifiers, asOf: claim.asOf },
                sentence: plain,
                lead,
                bundle: gathered.bundle,
                signature: gathered.signature,
              },
              signal,
            );
            if (!alive()) return;
            if (!judged.ok) {
              setClaim(claim.id, { state: judged.aborted ? '중단' : '실패', step: '', failure: judged.aborted ? '' : judged.reason });
              return;
            }
            setClaim(claim.id, { state: '완료', step: '', judgment: judged.judgment }, judged.usage);
          }),
      );
      if (alive()) patch((entry) => ({ ...entry, state: '완료', failure: '' }));
    } finally {
      // 멈췄으면 돌던 것을 '중단'으로 남긴다. 같은 문장을 다시 요청해 멈춘 것이면 번호가 달라 건드리지 않는다
      if (signal.aborted) {
        patch((entry) => ({
          ...entry,
          state: entry.state === '진행 중' ? '중단' : entry.state,
          claims: entry.claims.map((e) => (e.state === '진행 중' || e.state === '대기' ? { ...e, state: '중단', step: '' as Step } : e)),
        }));
      }
      // 재검증에 걸린 시간도 실행의 걸린 시간에 더한다(F12)
      store.set((prev) => (prev && prev.runId === runId ? { ...prev, activeMs: prev.activeMs + Math.max(0, now() - startedAt) } : prev));
      if (controllers.get(sentenceId) === mine) controllers.delete(sentenceId);
    }
  }

  return {
    /** 문장 하나를 다시 검증한다. 고쳐 쓴 글이 있으면 그 글을, 없으면 원문을 검증한다 */
    start(sentenceId: number): Promise<void> {
      const job = work(sentenceId).finally(() => jobs.delete(job));
      jobs.add(job);
      return job;
    },
    /** 돌고 있는 재검증을 모두 멈춘다(새 실행을 시작하거나 기록을 지울 때) */
    stopAll(): void {
      for (const controller of controllers.values()) controller.abort();
    },
    isBusy: (sentenceId: number) => controllers.has(sentenceId),
    /** 돌고 있는 재검증이 끝날 때까지 기다린다(확인용 도구가 쓴다) */
    idle: async () => {
      await Promise.all([...jobs]);
    },
  };
}

export type Rechecker = ReturnType<typeof createRechecker>;
