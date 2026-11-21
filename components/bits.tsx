// 화면 곳곳에서 쓰는 작은 조각들: 로고 묶음, 판정 표시, 우선순위 표시, 문장 글.
import type { ReactNode } from 'react';
import { diffPieces, inlineRuns } from '@/lib/client/text';
import type { ItemState, ReviewEntry, Step } from '@/lib/run/model';
import type { Priority, Verdict } from '@/lib/types';

const ENGLISH_NAME = 'WhiteChecker';

/** 로고 묶음. 영문은 글자 단위로 나눠 한글 이름의 폭에 맞추고, 읽어 주는 프로그램에는 한 낱말로 들리게 한다 */
export function Brand() {
  return (
    <div className="brand">
      <span className="logo">
        <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M3 8.5l3.2 3.2L13 4.8" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
      <span className="name">
        <span className="ko">화이트체커</span>
        <span className="en" role="img" aria-label={ENGLISH_NAME}>
          {[...ENGLISH_NAME].map((ch, i) => (
            <i key={i} aria-hidden="true">
              {ch}
            </i>
          ))}
        </span>
      </span>
    </div>
  );
}

const VERDICT_CLASS: Record<Verdict, string> = {
  불일치: 'bad',
  '해석 주의': 'caution',
  '근거 부족': 'unknown',
  일치: 'ok',
  '직접 확인': 'direct',
};

/** 판정 표시. 한 문장에 같은 판정이 여럿이면 count로 그 수를 함께 적는다 */
export function VerdictBadge({ verdict, count }: { verdict: Verdict; count?: number }) {
  return (
    <span className={`verdict v-${VERDICT_CLASS[verdict]}`}>
      {verdict}
      {count !== undefined && count > 1 ? ` ${count}` : ''}
    </span>
  );
}

/** 판정에 맞춘 색 이름. 원고 보기에서 문장에 밑줄 색을 입히는 데 쓴다 */
export const verdictClass = (verdict: Verdict): string => VERDICT_CLASS[verdict];

/** 문장에 대한 편집자의 선택(F10)을 작은 표시로 보여 준다. choiceOnly면 '고쳐 씀'은 빼고 채택과 보류만 */
export function DecisionChip({ review, hasCandidate, choiceOnly }: { review: ReviewEntry; hasCandidate: boolean; choiceOnly?: boolean }) {
  const edited = review.edited !== null;
  if (review.choice === '채택' && hasCandidate) return <span className="decision d-adopt">{edited ? '채택(고쳐 씀)' : '채택'}</span>;
  if (review.choice === '보류') return <span className="decision d-hold">보류</span>;
  if (edited && !choiceOnly) return <span className="decision d-edit">고쳐 씀</span>;
  return null;
}

const PRIORITY_CLASS: Record<Priority, string> = { 상: 'high', 중: 'mid', 하: 'low' };

export function PriorityBadge({ priority }: { priority: Priority | null }) {
  if (!priority) return null;
  return (
    <span className={`prio p-${PRIORITY_CLASS[priority]}`} title={`편집 우선순위 ${priority}: 틀렸을 때 글에 미치는 영향`}>
      <span className="visually-hidden">우선순위 </span>
      {priority}
    </span>
  );
}

/** 처리가 끝나지 않은 항목의 상태 표시. 실패를 판정처럼 보이지 않게 따로 그린다 */
export function StateBadge({ state, step, failure }: { state: ItemState; step: Step; failure: string }) {
  if (state === '진행 중') {
    return (
      <>
        <i className="dot" aria-hidden="true" />
        <span>{step === '판정' ? '판정하는 중' : '근거를 모으는 중'}</span>
      </>
    );
  }
  if (state === '실패') {
    return (
      <>
        <span className="tag failed">실패</span>
        <span>{failure}</span>
      </>
    );
  }
  return <span className="tag">{state}</span>;
}

/**
 * 두 문장을 견줘 달라진 곳을 표시한다. 편집자가 고쳐 쓴 문장처럼 바꾼 대목을 따로 받지 못한 글에 쓴다.
 * side가 before면 앞 글에 뺀 곳만, after면 뒤 글에 넣은 곳만, both면 한 줄에 둘 다 보인다.
 */
export function DiffText({ before, after, side }: { before: string; after: string; side: 'before' | 'after' | 'both' }) {
  const pieces = diffPieces(before, after).filter((p) => p.kind === 'same' || side === 'both' || (side === 'before' ? p.kind === 'removed' : p.kind === 'added'));
  return (
    <>
      {pieces.map((piece, i) => {
        let node: ReactNode = piece.text;
        if (piece.link) node = <u>{node}</u>;
        if (piece.bold) node = <strong>{node}</strong>;
        if (piece.kind === 'removed') node = <del>{node}</del>;
        else if (piece.kind === 'added') node = <ins>{node}</ins>;
        return <span key={i}>{node}</span>;
      })}
    </>
  );
}

/** 명제의 글. 같은 문장의 다른 명제와 겹치는 앞뒤 말은 흐리게, 서로 다른 대목은 굵게 적는다 */
export function PartsText({ text, head, tail }: { text: string; head: number; tail: number }) {
  if (head === 0 && tail === 0) return <>{text}</>;
  const end = text.length - tail;
  return (
    <>
      <span className="common">{text.slice(0, head)}</span>
      <b>{text.slice(head, end)}</b>
      <span className="common">{text.slice(end)}</span>
    </>
  );
}

/** 원고에 적힌 꼴의 문장을 그린다. 굵은 글씨와 링크는 모양으로 보이고, marks의 범위는 고친 대목으로 표시한다 */
export function InlineText({ source, marks, as }: { source: string; marks?: Array<[number, number]>; as?: 'del' | 'ins' }) {
  const Mark = as ?? 'ins';
  return (
    <>
      {inlineRuns(source, marks).map((run, i) => {
        let node: ReactNode = run.text;
        if (run.link) node = <u>{node}</u>;
        if (run.bold) node = <strong>{node}</strong>;
        if (run.mark) node = <Mark>{node}</Mark>;
        return <span key={i}>{node}</span>;
      })}
    </>
  );
}
