'use client';

// 검증 화면의 뿌리. 진행은 lib/run의 runner가 맡고, 여기서는 그 상태를 그리고 브라우저에 저장한다.
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { createApi } from '@/lib/client/api';
import { clearRecords, loadAccessCode, loadRun, saveAccessCode, saveRun } from '@/lib/client/storage';
import { compareRows, countClaims, entryOf, hasUnfinished, isAdopted, sentenceRows, staysDirect, viewOf, type RunState } from '@/lib/run/model';
import { createRechecker } from '@/lib/run/recheck';
import { applyReview, type ReviewAction } from '@/lib/run/review';
import { createRunner } from '@/lib/run/runner';
import { ClaimDetail } from './ClaimDetail';
import { ClaimTable } from './ClaimTable';
import { DirectList, directSentenceCount } from './DirectList';
import { ExportPanel } from './ExportPanel';
import { PaperView } from './PaperView';
import { MAX_CHARS, StartScreen, type Sample } from './StartScreen';
import { TopBar } from './TopBar';

type Listener = () => void;

/** 실행 상태를 담는 작은 저장소. runner가 바꾸고 화면이 구독한다 */
function createStore() {
  let state: RunState | null = null;
  const listeners = new Set<Listener>();
  return {
    get: () => state,
    set(update: (prev: RunState | null) => RunState | null) {
      const next = update(state);
      if (next === state) return;
      state = next;
      for (const listener of listeners) listener();
    },
    subscribe(listener: Listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

function createKit() {
  const store = createStore();
  const access = { code: '' };
  const api = createApi(() => access.code);
  const runner = createRunner(store, api);
  // 고쳐 쓴 문장 다시 검증(F14)은 실행과 따로 돈다. 같은 저장소와 같은 서버 경로를 쓴다
  const rechecker = createRechecker(store, api);
  return { store, access, runner, rechecker };
}

const noRun = () => null;

export default function Workbench({ samples }: { samples: Sample[] }) {
  const [kit] = useState(createKit);
  const run = useSyncExternalStore(kit.store.subscribe, kit.store.get, noRun);
  /** 브라우저에 남겨 둔 기록을 읽었는지. 읽기 전에는 시작 화면도 판정표도 그리지 않는다 */
  const [ready, setReady] = useState(false);
  const [screen, setScreen] = useState<'start' | 'review'>('start');
  const [code, setCode] = useState('');
  const [draft, setDraft] = useState('');
  const [startError, setStartError] = useState('');
  const [tab, setTab] = useState<'table' | 'paper' | 'direct'>('table');
  /** 오른쪽 칸에 무엇을 보일지: 고른 명제의 상세, 또는 내보내기 */
  const [panel, setPanel] = useState<'detail' | 'export'>('detail');
  const [selected, setSelected] = useState<string | null>(null);
  const [inDetail, setInDetail] = useState(false);

  // 남겨 둔 기록을 읽는다. 돌던 항목은 '중단'으로 표시된 채 열린다
  useEffect(() => {
    let cancelled = false;
    const savedCode = loadAccessCode();
    if (savedCode) {
      kit.access.code = savedCode;
      setCode(savedCode);
    }
    void loadRun().then((saved) => {
      if (cancelled) return;
      if (saved && !kit.store.get()) {
        kit.store.set(() => saved);
        setDraft(saved.manuscript);
        setScreen('review');
      }
      setReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, [kit]);

  // 상태가 바뀌면 잠시 뒤에 저장한다. 화면을 떠날 때는 바로 저장한다
  useEffect(() => {
    if (!ready) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let last: RunState | null = kit.store.get();
    const flush = () => {
      timer = null;
      const state = kit.store.get();
      if (state === last) return;
      last = state;
      void saveRun(state);
    };
    const unsubscribe = kit.store.subscribe(() => {
      if (timer === null) timer = setTimeout(flush, 800);
    });
    const onHide = () => {
      if (timer !== null) {
        clearTimeout(timer);
        flush();
      }
    };
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', onHide);
    return () => {
      unsubscribe();
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', onHide);
      onHide();
    };
  }, [kit, ready]);

  // 접속 코드나 키 문제로 처음부터 막혔으면 시작 화면에서 알린다(F15)
  const blockedAtStart = run !== null && run.blocked !== '' && run.claims.length === 0;
  useEffect(() => {
    if (!blockedAtStart || !run) return;
    setStartError(run.blocked);
    setScreen('start');
  }, [blockedAtStart, run]);

  const changeCode = useCallback(
    (value: string) => {
      kit.access.code = value;
      setCode(value);
    },
    [kit],
  );

  function start() {
    const text = draft.replace(/\r\n?/g, '\n');
    if (!text.trim()) return setStartError('원고를 넣어 주십시오.');
    if (text.length > MAX_CHARS) return setStartError(`원고가 ${MAX_CHARS.toLocaleString()}자를 넘습니다. 나눠서 넣어 주십시오.`);
    const existing = kit.store.get();
    if (existing && existing.claims.length > 0 && !window.confirm('앞서 한 검증 결과를 지우고 새로 시작합니다. 계속할까요?')) return;
    kit.rechecker.stopAll();
    const result = kit.runner.start(text);
    if (!result.ok) return setStartError(result.message);
    setPanel('detail');
    saveAccessCode(code);
    setStartError('');
    setSelected(null);
    setInDetail(false);
    setTab('table');
    setScreen('review');
  }

  function resume() {
    saveAccessCode(code);
    kit.runner.resume();
  }

  async function clearAll() {
    if (!window.confirm('이 기기에 남은 원고와 검증 결과, 접속 코드를 지웁니다. 돌고 있는 검증도 멈춥니다. 계속할까요?')) return;
    kit.rechecker.stopAll();
    kit.runner.clear();
    kit.access.code = '';
    setPanel('detail');
    setCode('');
    setDraft('');
    setStartError('');
    setSelected(null);
    setInDetail(false);
    setScreen('start');
    await clearRecords();
  }

  // 판정표의 한 줄은 문장 하나다. '직접 확인' 목록에는 공개 자료로 확인할 수 없다고 본 주장을 둔다(찾아보니 자료가 있어 판정이 난 것은 판정표로 간다)
  const rows = useMemo(() => (run ? sentenceRows(run) : []), [run]);
  const directViews = useMemo(() => (run ? run.claims.map((e) => viewOf(run, e)).filter(staysDirect) : []), [run]);
  const adopted = useMemo(() => (run ? run.sentences.filter((s) => isAdopted(run, s.id)).length : 0), [run]);

  const running = run !== null && (run.status === '추출 중' || run.status === '검증 중');
  const finishedRun = run !== null && run.status === '끝남';

  // 검증이 끝났는데 고른 항목이 없으면 맨 먼저 볼 항목을 골라 둔다(넓은 화면에서 상세가 비어 보이지 않게)
  useEffect(() => {
    if (!finishedRun || selected !== null || !run) return;
    const warned = rows.filter((row) => !row.allOk).sort(compareRows);
    const first = (warned[0] ?? rows[0])?.top ?? directViews[0];
    if (first) setSelected(first.entry.claim.id);
  }, [finishedRun, selected, run, rows, directViews]);

  const select = useCallback((claimId: string) => {
    setSelected(claimId);
    setPanel('detail');
    setInDetail(true);
  }, []);

  /** 편집자의 선택(F10). 고르는 즉시 브라우저에 저장해, 새로 고쳐도 남아 있게 한다 */
  const review = useCallback(
    (sentenceId: number, action: ReviewAction): string => {
      let notice = '';
      kit.store.set((prev) => {
        if (!prev) return prev;
        const outcome = applyReview(prev, sentenceId, action, new Date().toISOString());
        notice = outcome.notice;
        return outcome.run;
      });
      void saveRun(kit.store.get());
      return notice;
    },
    [kit],
  );

  const recheck = useCallback(
    (sentenceId: number) => {
      saveAccessCode(kit.access.code);
      void kit.rechecker.start(sentenceId);
    },
    [kit],
  );

  if (!ready) {
    return (
      <div className="wc">
        <div className="app">
          <TopBar run={null} onStop={() => {}} onResume={() => {}} onHome={() => {}} onClear={() => {}} />
          <div />
        </div>
      </div>
    );
  }

  if (screen === 'start' || !run) {
    return (
      <div className="wc">
        <div className="app">
          <TopBar run={null} onStop={() => {}} onResume={() => {}} onHome={() => {}} onClear={() => void clearAll()} />
          <StartScreen
            code={code}
            onCode={changeCode}
            draft={draft}
            onDraft={setDraft}
            samples={samples}
            error={startError}
            onError={setStartError}
            onStart={start}
            hasRun={run !== null && run.claims.length > 0}
            onBack={() => setScreen('review')}
          />
        </div>
      </div>
    );
  }

  const counts = countClaims(run);
  const failedChunks = run.chunks.filter((c) => c.state === '실패' || c.state === '중단').length;
  const selectedEntry = selected ? entryOf(run, selected) : undefined;
  const selectedView = selectedEntry ? viewOf(run, selectedEntry) : null;
  const selectedSentence = selectedEntry?.claim.sentenceId ?? null;
  const toggleExport = () => {
    const next = panel === 'export' ? 'detail' : 'export';
    setPanel(next);
    setInDetail(next === 'export');
  };

  let banner: { text: string; bad: boolean } | null = null;
  if (run.blocked) banner = { text: `${run.blocked} '처음으로'에서 접속 코드를 고친 뒤 이 화면으로 돌아와 '이어서 실행'을 누르십시오.`, bad: true };
  else if (!running && failedChunks > 0) banner = { text: `원고의 일부(${failedChunks}묶음)에서 명제를 뽑지 못했습니다. '이어서 실행'으로 그 부분만 다시 뽑습니다.`, bad: true };
  else if (!running && run.deferred > 0) banner = { text: `한 번에 처리하는 수를 넘겨 명제 ${run.deferred}개를 남겨 두었습니다. '이어서 실행'으로 마저 처리합니다.`, bad: false };
  else if (!running && hasUnfinished(run)) {
    const parts = [counts.failed ? `실패 ${counts.failed}` : '', counts.stopped ? `중단 ${counts.stopped}` : '', counts.waiting ? `대기 ${counts.waiting}` : ''].filter(Boolean);
    banner = { text: `끝나지 않은 항목이 있습니다${parts.length ? `(${parts.join(', ')})` : ''}. '이어서 실행'을 누르면 그 항목만 다시 처리합니다.`, bad: false };
  }

  return (
    <div className="wc">
      <div className={`app${banner ? ' with-banner' : ''}${inDetail ? ' in-detail' : ''}`}>
        <TopBar
          run={run}
          onStop={kit.runner.stop}
          onResume={resume}
          onHome={() => setScreen('start')}
          onClear={() => void clearAll()}
          onExport={toggleExport}
          exporting={panel === 'export'}
          adopted={adopted}
        />
        {banner && (
          <div className={banner.bad ? 'banner bad' : 'banner'} role="status">
            <span className="grow">{banner.text}</span>
          </div>
        )}
        <div className="body">
          <aside className="side">
            <div className="tabs" role="tablist">
              <button type="button" role="tab" aria-selected={tab === 'table'} onClick={() => setTab('table')}>
                판정표<span className="n">{rows.length}</span>
              </button>
              <button type="button" role="tab" aria-selected={tab === 'paper'} onClick={() => setTab('paper')}>
                원고 보기
              </button>
              <button type="button" role="tab" aria-selected={tab === 'direct'} onClick={() => setTab('direct')}>
                직접 확인<span className="n">{directSentenceCount(directViews)}</span>
              </button>
            </div>
            {tab === 'table' ? (
              <ClaimTable run={run} rows={rows} running={running} extracting={run.status === '추출 중'} selectedSentence={selectedSentence} onSelect={select} />
            ) : tab === 'paper' ? (
              <PaperView run={run} selectedSentence={selectedSentence} onSelect={select} />
            ) : (
              <DirectList run={run} views={directViews} selectedSentence={selectedSentence} onSelect={select} />
            )}
          </aside>
          <main className="main">
            {panel === 'export' ? (
              <ExportPanel
                run={run}
                onBack={() => {
                  setPanel('detail');
                  setInDetail(false);
                }}
                onOpen={select}
              />
            ) : (
              <ClaimDetail run={run} view={selectedView} running={running} onBack={() => setInDetail(false)} onSelect={select} onReview={review} onRecheck={recheck} />
            )}
          </main>
        </div>
      </div>
    </div>
  );
}
