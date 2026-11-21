// 근거 하나: 관계(지지, 반박), 적용 가능성, 출처와 등급, 발췌 안의 인용문과 앞뒤 문맥.
// 판정의 상세와, 고쳐 쓴 문장을 다시 검증한 결과가 함께 쓴다.
import { quoteContext } from '@/lib/client/text';
import type { ClaimView } from '@/lib/run/model';
import type { EvidenceUse } from '@/lib/types';

const RELATION_CLASS: Record<string, string> = { 지지: 'r-support', 반박: 'r-refute', '판단 불충분': '' };

export function EvidenceItem({ use, view }: { use: EvidenceUse; view: ClaimView }) {
  const excerpt = view.bundle?.evidence.find((e) => e.no === use.evidenceNo)?.text ?? '';
  const rating = view.judgment?.sources.find((s) => s.sourceNo === use.sourceNo);
  const info = view.bundle?.sources.find((s) => s.no === use.sourceNo);
  const context = quoteContext(excerpt, use.quote);
  const fits = [use.target, use.scope, use.time].every((a) => a === '적용 가능');
  const fit = fits ? '적용 가능' : `대상 ${use.target} · 범위 ${use.scope} · 시점 ${use.time}`;
  const publisher = info?.publisherHint || rating?.publisher || info?.hostname || '';
  let unused = '';
  if (rating?.notUsed) unused = `${rating.notUsed} 자료라 판정에 쓰지 않았습니다.`;
  else if (!use.quoteFound) unused = '인용문을 발췌에서 찾지 못해 판정에 쓰지 않았습니다.';
  else if (!use.usable && use.relation !== '판단 불충분') unused = '이 명제에 적용할 수 없는 근거라 판정에 쓰지 않았습니다.';
  return (
    <div className={`ev ${RELATION_CLASS[use.relation] ?? ''}`}>
      <div className="evhead">
        <span className="no">근거 {use.evidenceNo}</span>
        <span className="rel">{use.relation}</span>
        <span>{fit}</span>
        <span className="src">
          출처 {use.sourceNo}
          {rating ? ` · ${rating.notUsed || `${rating.grade}등급`}` : ''}
          {publisher ? ` · ${publisher}` : ''}
        </span>
      </div>
      <blockquote>
        {context.before}
        <mark>{context.quote}</mark>
        {context.after}
      </blockquote>
      {unused && <div className="unused">{unused}</div>}
    </div>
  );
}
