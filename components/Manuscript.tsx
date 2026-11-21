// 원고를 문단 꼴로 다시 짜서 보인다. 제목, 문단, 목록을 원고의 순서대로 놓고, 문장 하나하나는 부르는 쪽이 그린다.
// 원고 보기(F2)와 내보내기의 수정 원고 미리 보기(F11)가 함께 쓴다.
import type { ReactNode } from 'react';
import type { Sentence } from '@/lib/types';

interface Group {
  kind: 'heading' | 'paragraph' | 'list' | 'aside';
  /** 문단은 문장 여러 개, 목록은 항목(문장 묶음) 여러 개 */
  items: Sentence[][];
}

/** 문장을 문단 단위로 묶는다. 같은 문단(block)의 문장은 한 덩어리로, 이어진 목록 항목은 한 목록으로 둔다 */
function groupSentences(sentences: Sentence[]): Group[] {
  const groups: Group[] = [];
  let lastBlock = -1;
  for (const s of sentences) {
    const last = groups[groups.length - 1];
    if (s.kind === 'heading') {
      groups.push({ kind: 'heading', items: [[s]] });
    } else if (s.kind === 'listItem') {
      if (last?.kind === 'list') {
        if (s.block === lastBlock) last.items[last.items.length - 1].push(s);
        else last.items.push([s]);
      } else groups.push({ kind: 'list', items: [[s]] });
    } else {
      // 표의 줄, 캡션, 각주는 본문과 구별되게 따로 놓는다
      const kind = s.kind === 'paragraph' ? 'paragraph' : 'aside';
      if (last?.kind === kind && s.block === lastBlock) last.items[0].push(s);
      else groups.push({ kind, items: [[s]] });
    }
    lastBlock = s.block;
  }
  return groups;
}

export function Manuscript({ sentences, render }: { sentences: Sentence[]; render: (sentence: Sentence) => ReactNode }) {
  const titleId = sentences.find((s) => s.kind === 'heading')?.id;
  const line = (list: Sentence[]) =>
    list.map((s) => (
      <span key={s.id}>
        {render(s)}{' '}
      </span>
    ));
  return (
    <>
      {groupSentences(sentences).map((group) => {
        const key = group.items[0][0].id;
        if (group.kind === 'heading') {
          const s = group.items[0][0];
          return s.id === titleId ? <h4 key={key}>{line([s])}</h4> : <h5 key={key}>{line([s])}</h5>;
        }
        if (group.kind === 'list') {
          return (
            <ul key={key}>
              {group.items.map((item) => (
                <li key={item[0].id}>{line(item)}</li>
              ))}
            </ul>
          );
        }
        return (
          <p key={key} className={group.kind === 'aside' ? 'aside' : undefined}>
            {line(group.items[0])}
          </p>
        );
      })}
    </>
  );
}
