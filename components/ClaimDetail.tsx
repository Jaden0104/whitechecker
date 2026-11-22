// 항목의 상세(F8): 문장과 수정안, 판정의 까닭, 근거와 인용문, 출처와 등급, 검색 기록.
import { Fragment } from 'react';
import { TWO_PUBLISHERS_FLAG } from '@/lib/flags';
import type { ClaimView, RunState } from '@/lib/run/model';
import type { ReviewAction } from '@/lib/run/review';
import { PriorityBadge, StateBadge, VerdictBadge } from './bits';
import { EvidenceItem } from './EvidenceItem';
import { SentenceCard } from './SentenceCard';

interface Props {
  run: RunState;
  view: ClaimView | null;
  /** 검증이 돌고 있는지 */
  running: boolean;
  onBack: () => void;
  onSelect: (claimId: string) => void;
  onReview: (sentenceId: number, action: ReviewAction) => string;
  onRecheck: (sentenceId: number) => void;
}

const ORDINALS = ['첫째', '둘째', '셋째', '넷째', '다섯째'];

export function ClaimDetail({ run, view, running, onBack, onSelect, onReview, onRecheck }: Props) {
  if (!view) return <div className="empty">목록에서 항목을 고르면 판정의 까닭과 근거가 여기에 보입니다.</div>;

  const { claim } = view.entry;
  const judgment = view.judgment;
  const bundle = view.bundle;
  const sentence = run.sentences.find((s) => s.id === claim.sentenceId);
  const done = view.state === '완료' && view.verdict !== null;
  const stayedDirect = view.verdict === '직접 확인';
  const sharedSentence = view.sharedWith ? run.claims.find((e) => e.claim.id === view.sharedWith)?.claim.sentenceId : null;
  const opened = bundle?.sources.filter((s) => s.fetch.status !== '열지 않음') ?? [];
  // 한 문장에 확인한 사실이 여럿이면, 맨 위의 판정이 그 가운데 어느 사실의 것인지 적어 둔다
  const siblings = run.claims.filter((e) => e.claim.sentenceId === claim.sentenceId);
  const nth = siblings.findIndex((e) => e.claim.id === claim.id);
  const which = siblings.length > 1 && nth >= 0 ? `확인한 사실 ${siblings.length}가지 가운데 ${ORDINALS[nth] ?? `${nth + 1}번째`}` : '';
  /**
   * 화이트체커가 실제로 확인한 글(명제). 문장의 지시어와 생략된 주어를 풀어 쓴 것이라 원문과 조금 다르다.
   * 편집자가 다루는 것은 원문과 수정안이므로 크게 내세우지 않고, 판정이 무엇에 대한 것인지 알 수 있게 그 카드의 첫 줄에 적는다
   */
  const factLine = (
    <dl className="kv fact-line">
      <dt>확인한 사실</dt>
      <dd>{claim.statement}</dd>
    </dl>
  );

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
        {which && <span>· {which}</span>}
      </div>
      <h2 className="visually-hidden">문장 {claim.sentenceId}의 판정과 수정안</h2>

      {sentence && <SentenceCard key={sentence.id} run={run} sentence={sentence} currentId={claim.id} running={running} onSelect={onSelect} onReview={onReview} onRecheck={onRecheck} />}

      {!done && (
        <div className="card">
          <h3>처리 상태</h3>
          {factLine}
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
          {factLine}
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
          {factLine}
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
                <dd>
                  {[judgment.needChoice ? '선택 필요' : '', ...judgment.flags].filter(Boolean).join(' · ')}
                  {judgment.flags.includes(TWO_PUBLISHERS_FLAG) && (
                    <small> (서로 다른 기관 두 곳이 같은 내용을 적어 일치로 봤습니다. 두 글이 같은 자료를 보고 쓴 것인지까지는 확인하지 못했습니다.)</small>
                  )}
                </dd>
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
              {bundle.followUp && (
                <li>
                  판정이 &lsquo;근거 부족&rsquo;이어서 한 번 더 찾음(보강 검색){bundle.followUp.done ? '' : ', 검색은 하지 않음'}: {bundle.followUp.reason}{' '}
                  {bundle.followUp.added > 0 ? `새로 실은 발췌 ${bundle.followUp.added}개` : '새로 실은 자료 없음'}
                  {bundle.followUp.linked ? ` · 기관 사이트의 메뉴를 따라 열어 본 안쪽 페이지 ${bundle.followUp.linked}곳` : ''}
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
