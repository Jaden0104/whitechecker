// 항목의 상세(F8): 문장과 수정안, 판정의 까닭, 근거와 인용문, 출처와 등급, 검색 기록.
import { Fragment } from 'react';
import { editRanges, quoteContext } from '@/lib/client/text';
import { viewOf, type ClaimView, type RunState } from '@/lib/run/model';
import type { EvidenceUse, Sentence } from '@/lib/types';
import { InlineText, PriorityBadge, StateBadge, VerdictBadge } from './bits';

interface Props {
  run: RunState;
  view: ClaimView | null;
  onBack: () => void;
}

/** 문장과 그 문장의 통합 수정안. 수정안은 문장에 걸린 명제가 모두 끝난 뒤에 한 번 만든다(F7) */
function SentenceCard({ run, sentence }: { run: RunState; sentence: Sentence }) {
  const entry = run.revisions[sentence.id];
  const revision = entry?.revision ?? null;
  const mine = run.claims.filter((e) => e.claim.sentenceId === sentence.id).map((e) => viewOf(run, e));
  const pending = mine.filter((v) => v.state !== '완료');
  const notes: Array<{ text: string; tone?: 'warn' | 'busy' }> = [];
  const revised = entry?.state === '완료' ? (revision?.revised ?? null) : null;

  if (revised && revision) {
    if (mine.length > 1 && revision.applied.length > 1) notes.push({ text: `이 문장의 명제 ${revision.applied.length}개의 고칠 내용을 하나로 합쳤습니다.` });
    const { numbersRemoved, numbersAdded } = revision.changes;
    if (numbersRemoved.length || numbersAdded.length) notes.push({ text: `달라진 숫자: ${numbersRemoved.join(', ') || '-'} → ${numbersAdded.join(', ') || '-'}` });
    if (revision.polish.state === '다듬음') notes.push({ text: '고친 대목의 이음매가 어색해 문법만 다듬었습니다.' });
    for (const skipped of revision.skipped) notes.push({ text: `반영하지 못한 고칠 내용이 있습니다(${skipped.why}).`, tone: 'warn' });
    if (!sentence.autoApply) notes.push({ text: '링크나 각주가 들었거나 표·캡션에 놓인 문장이라, 수정안을 자동으로 반영하지 않습니다.', tone: 'warn' });
    for (const caution of revision.cautions) notes.push({ text: caution, tone: 'warn' });
    if (entry.unresolved.length) notes.push({ text: '이 수정안을 받아들여도 확인되지 않은 채 남는 명제가 있습니다.', tone: 'warn' });
  } else if (entry?.state === '진행 중') {
    notes.push({ text: '수정안을 만드는 중입니다.', tone: 'busy' });
  } else if (entry?.state === '실패' || entry?.state === '중단') {
    notes.push({ text: `수정안을 만들지 못했습니다${entry.failure ? `(${entry.failure})` : ''}. '이어서 실행'으로 다시 만들 수 있습니다.`, tone: 'warn' });
  } else if (entry?.state === '완료' && revision) {
    notes.push({ text: `만든 수정안이 검사에서 걸러졌습니다${revision.skipped[0] ? `(${revision.skipped[0].why})` : ''}. 아래 '고칠 내용'을 보고 직접 고쳐 쓸 수 있습니다.`, tone: 'warn' });
  } else if (entry?.state === '없음') {
    if (mine.every((v) => v.verdict === '일치')) notes.push({ text: '고칠 내용이 없습니다.' });
    else if (mine.every((v) => v.verdict === '직접 확인' || v.verdict === '일치')) notes.push({ text: '공개 자료로 확인할 수 없는 문장이라 수정안을 만들지 않았습니다.' });
    else notes.push({ text: '수정안이 없습니다. 대신 쓸 사실을 확인하지 못했습니다.' });
  } else if (pending.some((v) => v.state === '진행 중' || v.state === '대기')) {
    notes.push({ text: '이 문장의 명제를 모두 처리한 뒤에 수정안을 만듭니다.', tone: 'busy' });
  } else if (pending.length > 0) {
    notes.push({ text: '끝나지 않은 명제가 있어 수정안을 만들지 않았습니다.', tone: 'warn' });
  } else if (mine.some((v) => v.judgment && v.judgment.fix.kind !== '없음')) {
    // 판정은 끝났는데 수정안은 아직 없다. 돌고 있으면 곧 만들고, 멈춰 있으면 만들기 전에 멈춘 것이다
    const running = run.status === '추출 중' || run.status === '검증 중';
    if (running) notes.push({ text: '수정안을 만들 차례를 기다리고 있습니다.', tone: 'busy' });
    else notes.push({ text: "수정안을 아직 만들지 않았습니다. '이어서 실행'으로 만들 수 있습니다.", tone: 'warn' });
  }

  const ranges = revised && revision ? editRanges(sentence.source, revised, revision.edits) : null;
  return (
    <div className="card">
      <h3>
        문장과 수정안 <span className="n">문장 {sentence.id}</span>
        {revised &&
          revision &&
          [...new Set(revision.kinds)].map((kind) => (
            <span key={kind} className="tag fix">
              {kind}
            </span>
          ))}
      </h3>
      <dl className="pair">
        <dt>원문</dt>
        <dd>
          <InlineText source={sentence.source} marks={ranges?.removed} as="del" />
        </dd>
        {revised && ranges && (
          <>
            <dt>수정안</dt>
            <dd>
              <InlineText source={revised} marks={ranges.added} as="ins" />
            </dd>
          </>
        )}
      </dl>
      {notes.length > 0 && (
        <ul className="notes">
          {notes.map((note, i) => (
            <li key={i} className={note.tone}>
              {note.text}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const RELATION_CLASS: Record<string, string> = { 지지: 'r-support', 반박: 'r-refute', '판단 불충분': '' };

function EvidenceItem({ use, view }: { use: EvidenceUse; view: ClaimView }) {
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

export function ClaimDetail({ run, view, onBack }: Props) {
  if (!view) return <div className="empty">목록에서 항목을 고르면 판정의 까닭과 근거가 여기에 보입니다.</div>;

  const { claim } = view.entry;
  const judgment = view.judgment;
  const bundle = view.bundle;
  const sentence = run.sentences.find((s) => s.id === claim.sentenceId);
  const done = view.state === '완료' && view.verdict !== null;
  const stayedDirect = view.verdict === '직접 확인';
  const sharedSentence = view.sharedWith ? run.claims.find((e) => e.claim.id === view.sharedWith)?.claim.sentenceId : null;
  const opened = bundle?.sources.filter((s) => s.fetch.status !== '열지 않음') ?? [];

  return (
    <div className="detail">
      <button type="button" className="back" onClick={onBack}>
        ‹ 목록으로
      </button>
      <div className="crumb">
        {done && view.verdict ? (
          <>
            <PriorityBadge priority={judgment?.priority ?? null} />
            <VerdictBadge verdict={view.verdict} />
          </>
        ) : (
          <StateBadge state={view.state} step={view.step} failure={view.failure} />
        )}
        <span>{claim.type}</span>
        <span>· 기준 시점 {claim.asOf}</span>
        {claim.qualifiers.length > 0 && <span>· 한정 표현 {claim.qualifiers.join(', ')}</span>}
      </div>
      <h2>{claim.statement}</h2>

      {sentence && <SentenceCard run={run} sentence={sentence} />}

      {!done && (
        <div className="card">
          <h3>처리 상태</h3>
          <p className="reason">
            {view.state === '진행 중' && (view.step === '판정' ? '모은 근거로 판정하는 중입니다.' : '공개 자료에서 근거를 모으는 중입니다.')}
            {view.state === '대기' && '차례를 기다리고 있습니다.'}
            {view.state === '실패' && `처리하지 못했습니다. 사유: ${view.failure || '알 수 없음'}`}
            {view.state === '중단' && '처리하다가 멈췄습니다.'}
          </p>
          {(view.state === '실패' || view.state === '중단') && (
            <ul className="notes">
              <li>위쪽의 &lsquo;이어서 실행&rsquo;을 누르면 끝나지 않은 항목만 다시 처리합니다. 이미 모은 근거는 다시 찾지 않습니다.</li>
            </ul>
          )}
        </div>
      )}

      {stayedDirect && (
        <div className="card">
          <h3>직접 확인할 것</h3>
          <p className="reason">{claim.privateReason || '공개 자료로는 확인할 수 없는 주장입니다.'}</p>
          <dl className="kv">
            <dt>권고</dt>
            <dd>당사자나 내부 자료로 직접 확인한다</dd>
            {view.direct?.note && (
              <>
                <dt>찾아본 결과</dt>
                <dd>{view.direct.note}</dd>
              </>
            )}
          </dl>
        </div>
      )}

      {done && judgment && (
        <div className="card">
          <h3>판정의 까닭</h3>
          <p className="reason">{judgment.reason}</p>
          <dl className="kv">
            {judgment.action && (
              <>
                <dt>권고</dt>
                <dd>{judgment.action}</dd>
              </>
            )}
            {judgment.fix.kind !== '없음' && (
              <>
                <dt>고칠 내용</dt>
                <dd>
                  {judgment.fix.instruction} <small>({judgment.fix.kind})</small>
                </dd>
              </>
            )}
            {judgment.qualifiers.map((q, i) => (
              <Fragment key={i}>
                <dt>한정 표현</dt>
                <dd>
                  &lsquo;{q.text}&rsquo; {q.result}
                  {q.note && <small> ({q.note})</small>}
                </dd>
              </Fragment>
            ))}
            {judgment.lowered && (
              <>
                <dt>바꾼 까닭</dt>
                <dd>
                  모델은 &lsquo;{judgment.modelVerdict}&rsquo;로 봤지만 규칙 {judgment.lowered.rule}에 따라 바꿨습니다. {judgment.lowered.note}
                </dd>
              </>
            )}
            {judgment.conflict.found && (
              <>
                <dt>엇갈린 근거</dt>
                <dd>
                  지지하는 근거와 반박하는 근거가 함께 있습니다
                  {judgment.conflict.supportTop && judgment.conflict.refuteTop
                    ? `(지지 쪽 최고 ${judgment.conflict.supportTop}등급, 반박 쪽 최고 ${judgment.conflict.refuteTop}등급).`
                    : '.'}
                </dd>
              </>
            )}
            {(judgment.flags.length > 0 || judgment.needChoice) && (
              <>
                <dt>표시</dt>
                <dd>{[judgment.needChoice ? '선택 필요' : '', ...judgment.flags].filter(Boolean).join(' · ')}</dd>
              </>
            )}
            {view.direct?.reclassified && (
              <>
                <dt>찾아본 결과</dt>
                <dd>{view.direct.note}</dd>
              </>
            )}
            {sharedSentence && (
              <>
                <dt>함께 쓴 결과</dt>
                <dd>문장 {sharedSentence}의 같은 명제와 근거와 판정을 함께 씁니다.</dd>
              </>
            )}
            <dt>확인일</dt>
            <dd>{judgment.checkedAt}</dd>
          </dl>
        </div>
      )}

      {done && judgment && (
        <>
          <div className="card">
            <h3>
              근거 <span className="n">{judgment.evidence.length}</span>
            </h3>
            {judgment.evidence.length === 0 ? (
              <p className="reason quiet">판단에 쓴 근거가 없습니다.</p>
            ) : (
              judgment.evidence.map((use) => <EvidenceItem key={`${use.evidenceNo}-${use.quote.slice(0, 12)}`} use={use} view={view} />)
            )}
          </div>
          <div className="card">
            <h3>
              출처 <span className="n">{judgment.sources.length}</span>
            </h3>
            {judgment.sources.length === 0 && <p className="reason quiet">근거로 쓴 출처가 없습니다.</p>}
            {judgment.sources.map((s) => {
              const info = bundle?.sources.find((x) => x.no === s.sourceNo);
              const twin = judgment.links.find((l) => l.status === '중복' && (l.a === s.sourceNo || l.b === s.sourceNo));
              const twinNo = twin ? (twin.a === s.sourceNo ? twin.b : twin.a) : null;
              return (
                <div key={s.sourceNo} className="source">
                  <span className={`grade ${s.notUsed ? 'gx' : `g${s.grade}`}`}>{s.notUsed ? '제외' : `${s.grade}등급`}</span>
                  <div className="who">
                    {info?.publisherHint || s.publisher || info?.hostname}{' '}
                    <span>
                      · {s.docType}
                      {s.notUsed ? ` · 판정에 쓰지 않음${s.notUsed !== s.docType ? `(${s.notUsed})` : ''}` : ''}
                      {s.ownFact ? ' · 직접 정하는 사실' : ''}
                      {twinNo ? ` · 출처 ${twinNo}와 같은 자료로 봄` : ''}
                      {s.publisherUnlisted ? ' · 발행 주체 확인 필요' : ''}
                    </span>
                  </div>
                  {info && (
                    <a href={info.url} target="_blank" rel="noopener noreferrer">
                      출처 {s.sourceNo} · {info.title ? `${info.title.slice(0, 50)} · ` : ''}
                      {info.hostname}
                    </a>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}

      {bundle && (
        <div className="card">
          <details className="more">
            <summary>검색 기록과 열어 본 페이지</summary>
            <ul>
              {bundle.searches.map((s, i) => (
                <li key={`s${i}`}>
                  {s.kind} 검색 <code>{s.query}</code> {s.error ? `실패(${s.error})` : `결과 ${s.results}건`}
                </li>
              ))}
              {bundle.extraSearch.reason && (
                <li>
                  추가 검색 {bundle.extraSearch.done ? '함' : '하지 않음'}: {bundle.extraSearch.reason}
                </li>
              )}
              {opened.map((s) => (
                <li key={`p${s.no}`}>
                  {s.hostname} {s.fetch.status}
                  {s.fetch.reason ? `(${s.fetch.reason})` : ''}
                </li>
              ))}
              {bundle.searches.length === 0 && opened.length === 0 && <li>기록이 없습니다.</li>}
            </ul>
          </details>
        </div>
      )}
    </div>
  );
}
