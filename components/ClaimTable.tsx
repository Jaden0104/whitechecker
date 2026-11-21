// 판정표(F8): 편집 우선순위가 높은 것부터 보이고, '일치'는 접어 둔다. 판정별로 골라 보고 원고 순서로 바꿔 볼 수 있다.
import { useState } from 'react';
import type { ClaimView } from '@/lib/run/model';
import type { Verdict } from '@/lib/types';
import { PriorityBadge, StateBadge, VerdictBadge } from './bits';

type Filter = '전체' | '불일치' | '해석 주의' | '근거 부족' | '일치' | '미완료';

const PRIORITY_ORDER: Record<string, number> = { 상: 0, 중: 1, 하: 2 };
const VERDICT_ORDER: Partial<Record<Verdict, number>> = { 불일치: 0, '근거 부족': 1, '해석 주의': 2 };

/** 보이는 순서(F8): 편집 우선순위가 높은 것부터, 같은 우선순위 안에서는 불일치, 근거 부족, 해석 주의 순 */
export function compareByRank(a: ClaimView, b: ClaimView): number {
  const rank = (v: ClaimView) => [PRIORITY_ORDER[v.judgment?.priority ?? ''] ?? 3, VERDICT_ORDER[v.verdict as Verdict] ?? 3];
  const [pa, va] = rank(a);
  const [pb, vb] = rank(b);
  return pa - pb || va - vb;
}

interface Props {
  views: ClaimView[];
  running: boolean;
  /** 명제를 뽑는 중이라 아직 줄이 없을 수 있다 */
  extracting: boolean;
  selected: string | null;
  onSelect: (claimId: string) => void;
}

export function ClaimRow({ view, current, onSelect }: { view: ClaimView; current: boolean; onSelect: (claimId: string) => void }) {
  const { claim } = view.entry;
  const done = view.state === '완료' && view.verdict !== null;
  const fix = view.judgment?.fix.kind;
  const notes = [
    view.judgment?.needChoice ? '선택 필요' : '',
    ...(view.judgment?.flags ?? []),
    view.sharedWith ? '같은 명제의 결과를 함께 씀' : '',
  ].filter(Boolean);
  return (
    <li>
      <button type="button" className={done ? 'row' : 'row pending'} aria-current={current} onClick={() => onSelect(claim.id)}>
        <div className="head">
          {done && view.verdict ? (
            <>
              <PriorityBadge priority={view.judgment?.priority ?? null} />
              <VerdictBadge verdict={view.verdict} />
              {fix && fix !== '없음' && <span className="tag fix">{fix}</span>}
            </>
          ) : (
            <StateBadge state={view.state} step={view.step} failure={view.failure} />
          )}
        </div>
        <div className="text">{claim.statement}</div>
        <div className="meta">
          {claim.type} · 문장 {claim.sentenceId}
          {notes.map((note) => ` · ${note}`)}
        </div>
      </button>
    </li>
  );
}

export function ClaimTable({ views, running, extracting, selected, onSelect }: Props) {
  const [filter, setFilter] = useState<Filter>('전체');
  const [byPriority, setByPriority] = useState(true);
  const [showOk, setShowOk] = useState(false);

  const finished = views.filter((v) => v.state === '완료' && v.verdict !== null);
  const unfinished = views.filter((v) => !(v.state === '완료' && v.verdict !== null));
  const count = (f: Filter) => (f === '전체' ? views.length : f === '미완료' ? unfinished.length : finished.filter((v) => v.verdict === f).length);
  const chips: Filter[] = ['전체', '불일치', '해석 주의', '근거 부족', '일치'];
  // 돌아가는 동안에는 줄이 자리를 옮기지 않게 원고 순서로 둔다
  const sorted = byPriority && !running;

  let list = views;
  if (filter === '미완료') list = unfinished;
  else if (filter !== '전체') list = finished.filter((v) => v.verdict === filter);

  const byRank = compareByRank;

  const row =(v: ClaimView) => <ClaimRow key={v.entry.claim.id} view={v} current={selected === v.entry.claim.id} onSelect={onSelect} />;
  let rows;
  if (!sorted || filter !== '전체') {
    rows = (sorted ? [...list].sort(byRank) : list).map(row);
  } else {
    // 경고가 붙은 것을 우선순위대로, 그다음 끝나지 않은 것, '일치'는 접어서 맨 아래에
    const warned = finished.filter((v) => v.verdict !== '일치').sort(byRank);
    const ok = finished.filter((v) => v.verdict === '일치');
    rows = (
      <>
        {warned.map(row)}
        {unfinished.map(row)}
        {ok.length > 0 && (
          <li>
            <button type="button" className="fold" aria-expanded={showOk} onClick={() => setShowOk((v) => !v)}>
              <VerdictBadge verdict="일치" /> {ok.length}건
            </button>
          </li>
        )}
        {showOk && ok.map(row)}
      </>
    );
  }

  return (
    <>
      <div className="filters">
        {chips.map((f) => (
          <button key={f} type="button" className="chip" aria-pressed={filter === f} onClick={() => setFilter(f)}>
            {f}
            <span className="n">{count(f)}</span>
          </button>
        ))}
        {!running && unfinished.length > 0 && (
          <button type="button" className="chip" aria-pressed={filter === '미완료'} onClick={() => setFilter('미완료')}>
            미완료<span className="n">{unfinished.length}</span>
          </button>
        )}
        {!running && (
          <button type="button" className="sort" onClick={() => setByPriority((v) => !v)}>
            {byPriority ? '우선순위순 ▾' : '원고순 ▾'}
          </button>
        )}
      </div>
      <div className="scroll">
        {views.length === 0 ? (
          <p className="hint-row">{extracting ? '원고에서 확인할 명제를 뽑고 있습니다.' : '판정표에 올릴 명제가 없습니다.'}</p>
        ) : list.length === 0 ? (
          <p className="hint-row">여기에 해당하는 항목이 없습니다.</p>
        ) : (
          <ul className="rows">{rows}</ul>
        )}
      </div>
    </>
  );
}
