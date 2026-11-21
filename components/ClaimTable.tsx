// 판정표(F8): 한 줄이 문장 하나다. 틀린 것으로 확인된 문장을 먼저, 그다음 편집 우선순위가 높은 것부터 보이고, 모두 '일치'인 문장은 접어 둔다.
// 판정별로 골라 보고 원고 순서로 바꿔 볼 수 있다. 어느 사실이 어느 판정인지는 줄을 눌러 상세에서 본다.
import { useState } from 'react';
import { candidateText, compareRows, reviewOf, type RunState, type SentenceRow } from '@/lib/run/model';
import type { Verdict } from '@/lib/types';
import { DecisionChip, InlineText, PriorityBadge, StateBadge, VerdictBadge } from './bits';

type Filter = '전체' | '불일치' | '해석 주의' | '근거 부족' | '일치' | '미완료';

/** 손봐야 할 판정이 하나라도 나온 문장인지 */
const warned = (row: SentenceRow) => row.badges.some((b) => b.verdict !== '일치');

function matches(row: SentenceRow, filter: Filter): boolean {
  if (filter === '전체') return true;
  if (filter === '미완료') return row.pending.length > 0;
  // '일치'는 사실이 모두 맞은 문장만 가리킨다. 섞인 문장은 손볼 판정 쪽에서 찾는다
  if (filter === '일치') return row.allOk;
  return row.badges.some((b) => b.verdict === (filter as Verdict));
}

interface Props {
  run: RunState;
  rows: SentenceRow[];
  running: boolean;
  /** 명제를 뽑는 중이라 아직 줄이 없을 수 있다 */
  extracting: boolean;
  /** 지금 열어 본 명제가 걸린 문장의 번호 */
  selectedSentence: number | null;
  onSelect: (claimId: string) => void;
}

function Row({ run, row, current, onSelect }: { run: RunState; row: SentenceRow; current: boolean; onSelect: (claimId: string) => void }) {
  const { sentence, views, top, badges, okCount, pending } = row;
  const done = views.filter((v) => v.state === '완료' && v.verdict !== null);
  const kinds = [...new Set(done.map((v) => v.judgment?.fix.kind).filter((k): k is NonNullable<typeof k> => Boolean(k) && k !== '없음'))];
  const types = [...new Set(views.map((v) => v.entry.claim.type))];
  const flags = [...new Set(done.flatMap((v) => [v.judgment?.needChoice ? '선택 필요' : '', ...(v.judgment?.flags ?? [])]).filter(Boolean))];
  // 처리가 끝나지 않은 명제는 판정처럼 보이지 않게 상태로 따로 적는다. 돌고 있는 것, 실패한 것 순으로 하나만 보인다
  const waiting = pending.find((v) => v.state === '진행 중') ?? pending.find((v) => v.state === '실패') ?? pending[0];
  const meta = [
    types.slice(0, 2).join(', ') + (types.length > 2 ? ' 외' : ''),
    `문장 ${sentence.id}`,
    views.length > 1 ? `확인한 사실 ${views.length}가지${okCount > 0 && !row.allOk ? ` 가운데 ${okCount}가지는 일치` : ''}` : '',
    ...flags,
    views.some((v) => v.sharedWith) ? '같은 명제의 결과를 함께 씀' : '',
  ].filter(Boolean);
  return (
    <li>
      <button type="button" className={done.length === 0 ? 'row pending' : 'row'} aria-current={current} onClick={() => onSelect(top.entry.claim.id)}>
        <div className="head">
          <PriorityBadge priority={row.priority} />
          {badges.map((b) => (
            <VerdictBadge key={b.verdict} verdict={b.verdict} count={b.count} />
          ))}
          {waiting && (
            <span className="state">
              <StateBadge state={waiting.state} step={waiting.step} failure={waiting.failure} />
              {pending.length > 1 && <span>외 {pending.length - 1}</span>}
            </span>
          )}
          <span className="push">
            {kinds.map((kind) => (
              <span key={kind} className="tag fix">
                {kind}
              </span>
            ))}
            <DecisionChip review={reviewOf(run, sentence.id)} hasCandidate={candidateText(run, sentence.id) !== null} />
          </span>
        </div>
        <div className="text">{sentence.kind === 'table' ? sentence.plain : <InlineText source={sentence.source} />}</div>
        <div className="meta">{meta.join(' · ')}</div>
      </button>
    </li>
  );
}

export function ClaimTable({ run, rows, running, extracting, selectedSentence, onSelect }: Props) {
  const [filter, setFilter] = useState<Filter>('전체');
  const [byPriority, setByPriority] = useState(true);
  const [showOk, setShowOk] = useState(false);

  const count = (f: Filter) => rows.filter((row) => matches(row, f)).length;
  const chips: Filter[] = ['전체', '불일치', '해석 주의', '근거 부족', '일치'];
  const unfinished = count('미완료');
  // 돌아가는 동안에는 줄이 자리를 옮기지 않게 원고 순서로 둔다
  const sorted = byPriority && !running;
  const list = rows.filter((row) => matches(row, filter));

  const item = (row: SentenceRow) => <Row key={row.sentence.id} run={run} row={row} current={selectedSentence === row.sentence.id} onSelect={onSelect} />;
  let body;
  if (!sorted || filter !== '전체') {
    body = (sorted ? [...list].sort(compareRows) : list).map(item);
  } else {
    // 틀린 것으로 확인된 문장, 확인하지 못한 문장(영향이 큰 순), 아직 판정이 없는 문장 순. 모두 '일치'인 문장은 접어서 맨 아래에
    const first = list.filter(warned).sort(compareRows);
    const later = list.filter((row) => !warned(row) && !row.allOk);
    const ok = list.filter((row) => row.allOk);
    body = (
      <>
        {first.map(item)}
        {later.map(item)}
        {ok.length > 0 && (
          <li>
            <button type="button" className="fold" aria-expanded={showOk} onClick={() => setShowOk((v) => !v)}>
              <VerdictBadge verdict="일치" /> 모두 일치한 문장 {ok.length}개
            </button>
          </li>
        )}
        {showOk && ok.map(item)}
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
        {!running && unfinished > 0 && (
          <button type="button" className="chip" aria-pressed={filter === '미완료'} onClick={() => setFilter('미완료')}>
            미완료<span className="n">{unfinished}</span>
          </button>
        )}
        {!running && (
          <button type="button" className="sort" onClick={() => setByPriority((v) => !v)}>
            {byPriority ? '확인된 오류부터 ▾' : '원고순 ▾'}
          </button>
        )}
      </div>
      <div className="scroll">
        {sorted && filter === '전체' && rows.length > 0 && (
          <p className="list-note">틀린 것으로 확인된 문장을 먼저 보입니다. 상·중·하는 틀렸을 때 글에 미치는 영향입니다.</p>
        )}
        {rows.length === 0 ? (
          <p className="hint-row">{extracting ? '원고에서 확인할 명제를 뽑고 있습니다.' : '판정표에 올릴 문장이 없습니다.'}</p>
        ) : list.length === 0 ? (
          <p className="hint-row">여기에 해당하는 문장이 없습니다.</p>
        ) : (
          <ul className="rows">{body}</ul>
        )}
      </div>
    </>
  );
}
