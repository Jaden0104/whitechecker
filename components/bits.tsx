// 화면 곳곳에서 쓰는 작은 조각들: 로고 묶음, 판정 표시, 우선순위 표시, 문장 글.
import type { ReactNode } from 'react';
import { inlineRuns } from '@/lib/client/text';
import type { ItemState, Step } from '@/lib/run/model';
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

export function VerdictBadge({ verdict }: { verdict: Verdict }) {
  return <span className={`verdict v-${VERDICT_CLASS[verdict]}`}>{verdict}</span>;
}

const PRIORITY_CLASS: Record<Priority, string> = { 상: 'high', 중: 'mid', 하: 'low' };

export function PriorityBadge({ priority }: { priority: Priority | null }) {
  if (!priority) return null;
  return (
    <span className={`prio p-${PRIORITY_CLASS[priority]}`} title={`편집 우선순위 ${priority}`}>
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
