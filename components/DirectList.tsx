// 직접 확인 목록(F9): 공개 자료로 확인할 수 없는 주장을 판정표와 따로 모아, 까닭과 권고를 한 줄씩 붙인다.
import type { ClaimView } from '@/lib/run/model';
import { StateBadge, VerdictBadge } from './bits';

interface Props {
  views: ClaimView[];
  selected: string | null;
  onSelect: (claimId: string) => void;
}

export function DirectList({ views, selected, onSelect }: Props) {
  if (views.length === 0) return <p className="hint-row">공개 자료로 확인할 수 없는 주장은 없었습니다.</p>;
  return (
    <div className="scroll">
      <ul className="rows">
        {views.map((view) => {
          const { claim } = view.entry;
          const settled = view.state === '완료';
          return (
            <li key={claim.id}>
              <button type="button" className="row" aria-current={selected === claim.id} onClick={() => onSelect(claim.id)}>
                <div className="head">
                  {settled ? <VerdictBadge verdict="직접 확인" /> : <StateBadge state={view.state} step={view.step} failure={view.failure} />}
                  <span className="tag">{claim.type}</span>
                </div>
                <div className="text">{claim.statement}</div>
                <div className="meta">
                  문장 {claim.sentenceId} · 공개 자료로 확인할 수 없는 까닭: {claim.privateReason || '적혀 있지 않음'}
                </div>
                <div className="meta">
                  {settled ? '권고: 당사자나 내부 자료로 직접 확인한다' : '공개 자료가 있는지 한 번 찾아본 뒤에 확정합니다'}
                  {settled && view.direct?.note ? ` · ${view.direct.note}` : ''}
                </div>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
