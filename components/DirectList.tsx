// 직접 확인 목록(F9): 공개 자료로 확인할 수 없는 주장을 판정표와 따로 모아, 까닭과 권고를 한 줄씩 붙인다.
// 판정표와 같이 한 줄이 문장 하나이고, 줄에는 원고 문장을 그대로 적는다. 무엇을 확인하려 했는지는 줄을 눌러 상세의 '판정 대상'에서 본다.
import type { ClaimView, RunState } from '@/lib/run/model';
import { InlineText, StateBadge, VerdictBadge } from './bits';

interface Props {
  run: RunState;
  /** '직접 확인'으로 남는 명제들 */
  views: ClaimView[];
  /** 지금 열어 본 명제가 걸린 문장의 번호 */
  selectedSentence: number | null;
  onSelect: (claimId: string) => void;
}

/** 직접 확인할 것이 있는 문장의 수. 탭에 적는 숫자다 */
export function directSentenceCount(views: ClaimView[]): number {
  return new Set(views.map((v) => v.entry.claim.sentenceId)).size;
}

export function DirectList({ run, views, selectedSentence, onSelect }: Props) {
  if (views.length === 0) return <p className="hint-row">공개 자료로 확인할 수 없는 주장은 없었습니다.</p>;
  // 문장별로 묶는다. 명제는 원고 순서로 들어오므로 묶음도 원고 순서가 된다
  const groups = new Map<number, ClaimView[]>();
  for (const view of views) {
    const id = view.entry.claim.sentenceId;
    groups.set(id, [...(groups.get(id) ?? []), view]);
  }
  return (
    <div className="scroll">
      <ul className="rows">
        {[...groups].map(([sentenceId, list]) => {
          const sentence = run.sentences.find((s) => s.id === sentenceId);
          const settled = list.filter((v) => v.state === '완료');
          // 유형이 내부 수치나 비공개 취재가 아니면 검색을 한 번 해 본 뒤에 확정한다. 그동안은 처리 상태를 보인다
          const waiting = list.find((v) => v.state !== '완료');
          const types = [...new Set(list.map((v) => v.entry.claim.type))];
          const reasons = [...new Set(list.map((v) => v.entry.claim.privateReason || '적혀 있지 않음'))];
          const notes = [...new Set(settled.map((v) => v.direct?.note ?? '').filter(Boolean))];
          return (
            <li key={sentenceId}>
              <button type="button" className="row" aria-current={selectedSentence === sentenceId} onClick={() => onSelect(list[0].entry.claim.id)}>
                <div className="head">
                  {settled.length > 0 && <VerdictBadge verdict="직접 확인" count={settled.length} />}
                  {waiting && (
                    <span className="state">
                      <StateBadge state={waiting.state} step={waiting.step} failure={waiting.failure} />
                    </span>
                  )}
                  {types.map((type) => (
                    <span key={type} className="tag">
                      {type}
                    </span>
                  ))}
                </div>
                <div className="text">
                  {!sentence ? list[0].entry.claim.statement : sentence.kind === 'table' ? sentence.plain : <InlineText source={sentence.source} />}
                </div>
                <div className="meta">
                  문장 {sentenceId} · 공개 자료로 확인할 수 없는 까닭: {reasons.join(' / ')}
                </div>
                <div className="meta">
                  {waiting ? '공개 자료가 있는지 한 번 찾아본 뒤에 확정합니다.' : '권고: 당사자나 내부 자료로 직접 확인한다'}
                  {/* 앞의 글이 마침표로 끝나면 가운뎃점 없이 잇는다 */}
                  {notes.length > 0 ? `${waiting ? ' ' : ' · '}${notes.join(' ')}` : ''}
                </div>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
