// 원고 보기(F2의 명제 추출 범위 표시, 9장): 원고를 문장 단위로 보이고, 문장마다 가장 급한 판정과 뽑힌 명제 수를 표시한다.
// 명제가 하나도 뽑히지 않은 문장이 눈에 띄게 해, 빠진 검증 대상이 없는지 살피게 한다. 채택한 문장은 바뀐 대목을 함께 보인다.
import type { KeyboardEvent } from 'react';
import { candidateText, compareByRank, isAdopted, reviewOf, viewOf, type RunState } from '@/lib/run/model';
import type { Sentence, Verdict } from '@/lib/types';
import { DecisionChip, DiffText, InlineText, VerdictBadge, verdictClass } from './bits';
import { Manuscript } from './Manuscript';

interface Props {
  run: RunState;
  /** 지금 열어 본 명제가 걸린 문장의 번호 */
  selectedSentence: number | null;
  onSelect: (claimId: string) => void;
}

/** 문장에 입히는 색은 그 문장에서 가장 무거운 판정을 따른다 */
const WORST: Verdict[] = ['불일치', '해석 주의', '근거 부족', '직접 확인', '일치'];

export function PaperView({ run, selectedSentence, onSelect }: Props) {
  const running = run.status === '추출 중' || run.status === '검증 중';
  const body = run.sentences.filter((s) => s.kind !== 'heading');
  const without = body.filter((s) => !run.claims.some((e) => e.claim.sentenceId === s.id)).length;

  const render = (sentence: Sentence) => {
    const views = run.claims.filter((e) => e.claim.sentenceId === sentence.id).map((e) => viewOf(run, e));
    const done = views.filter((v) => v.state === '완료' && v.verdict !== null);
    const worst = WORST.find((verdict) => done.some((v) => v.verdict === verdict));
    // 판정이 하나도 나오지 않은 문장은 흐리게, 명제가 없는 문장은 가는 밑줄만 둔다
    const tone = views.length === 0 ? 'none' : worst ? verdictClass(worst) : 'wait';
    const text = candidateText(run, sentence.id);
    const adopted = isAdopted(run, sentence.id) && text !== null;
    // 문장을 누르면 그 문장에서 가장 급한 명제를 연다
    const first = [...done].sort(compareByRank)[0] ?? views[0];
    const open = () => first && onSelect(first.entry.claim.id);
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      open();
    };
    const shown = sentence.kind === 'table' ? sentence.plain : adopted ? <DiffText before={sentence.source} after={text} side="both" /> : <InlineText source={sentence.source} />;
    // 본문 문장인데 명제가 하나도 뽑히지 않았으면 0으로 적어 눈에 띄게 한다(제목에는 적지 않는다)
    const count = views.length > 0 ? String(views.length) : sentence.kind === 'heading' ? '' : '0';
    return (
      <>
        <span
          className={`sent s-${tone}${adopted ? ' adopted' : ''}`}
          role={first ? 'button' : undefined}
          tabIndex={first ? 0 : undefined}
          aria-current={sentence.id === selectedSentence || undefined}
          onClick={open}
          onKeyDown={first ? onKey : undefined}
        >
          {shown}
        </span>
        {count && <span className={count === '0' ? 'cnt zero' : 'cnt'}>{count}</span>}
        <DecisionChip review={reviewOf(run, sentence.id)} hasCandidate={text !== null} />
      </>
    );
  };

  return (
    <>
      <div className="legend">
        {WORST.map((verdict) => (
          <VerdictBadge key={verdict} verdict={verdict} />
        ))}
        <span className="wide">
          문장 끝의 숫자는 그 문장에서 뽑은 명제 수입니다. 본문 문장 {body.length}개 가운데 명제가 뽑히지 않은 문장은 {without}개입니다.
          {running ? ' 흐린 문장은 아직 검증하는 중입니다.' : ''} 문장을 누르면 판정과 수정안이 열립니다.
        </span>
      </div>
      <div className="scroll">
        <div className="paper">
          <Manuscript sentences={run.sentences} render={render} />
        </div>
      </div>
    </>
  );
}
