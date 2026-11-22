// 문장과 수정안(F7, F10, F14): 원문과 수정안, 이 문장에서 확인한 사실, 편집자의 선택(채택·고쳐 쓰기·보류), 고쳐 쓴 문장 다시 검증.
// 검토 단위는 문장이다. 한 문장에 확인한 사실이 여럿이어도 수정안과 선택은 문장마다 하나다.
// 다시 검증하는 것은 편집자가 고쳐 쓴 글뿐이다. 원문에는 처음 검증의 판정 하나만 둔다(한 글에는 검증 결과가 하나).
import { useState, type ReactNode } from 'react';
import { editRanges, sharedEnds } from '@/lib/client/text';
import {
  autoRevision,
  candidateText,
  canRecheck,
  factNote,
  recheckOf,
  recheckStatus,
  reviewOf,
  staysDirect,
  viewOf,
  type RecheckStatus,
  type RunState,
} from '@/lib/run/model';
import type { ReviewAction } from '@/lib/run/review';
import type { Sentence, Verdict } from '@/lib/types';
import { DecisionChip, DiffText, InlineText, PartsText, StateBadge, VerdictBadge } from './bits';
import { EvidenceItem } from './EvidenceItem';

interface Props {
  run: RunState;
  sentence: Sentence;
  /** 지금 열어 본 명제의 번호 */
  currentId: string;
  /** 검증이 돌고 있는지. 도는 동안에는 다시 검증을 잠시 막는다 */
  running: boolean;
  onSelect: (claimId: string) => void;
  /** 편집자의 선택을 반영하고, 화면에 알릴 말이 있으면 돌려준다 */
  onReview: (sentenceId: number, action: ReviewAction) => string;
  onRecheck: (sentenceId: number) => void;
}

const STATUS_CLASS: Record<RecheckStatus, string> = { 미검증: '', '검증 중': 'busy', '현재 문장 검증 완료': 'done', '이전 문장에 대한 결과': 'stale' };
const STATUS_LABEL: Record<RecheckStatus, string> = {
  미검증: '아직 검증하지 않음',
  '검증 중': '검증 중',
  '현재 문장 검증 완료': '현재 문장 검증 완료',
  '이전 문장에 대한 결과': '이전 문장에 대한 결과',
};

/**
 * 고쳐 쓴 글을 다시 검증한 결과. 요청할 때의 글에 묶여 있어, 그 뒤에 글을 또 고치면 앞서 고쳐 쓴 글에 대한 결과로 보인다.
 * 재검증 상태(검증 중, 현재 문장 검증 완료, 이전 문장에 대한 결과)는 카드 머리에 한 번만 적는다
 */
function RecheckBlock({ run, sentence }: { run: RunState; sentence: Sentence }) {
  const entry = recheckOf(run, sentence.id);
  if (!entry) return null;
  const stale = entry.state === '완료' && entry.text !== reviewOf(run, sentence.id).edited;
  return (
    <div className="recheck">
      <h4>
        {entry.state === '진행 중' && <i className="dot" aria-hidden="true" />}
        {stale ? '앞서 고쳐 쓴 글을 검증한 결과' : '고쳐 쓴 문장을 다시 검증한 결과'}
      </h4>
      {stale && <p className="was">검증한 글: {entry.text}</p>}
      {entry.state === '진행 중' && entry.claims.length === 0 && <p>이 문장에서 명제를 다시 뽑고 있습니다. 제목과 앞뒤 문맥을 함께 보냅니다.</p>}
      {entry.state === '실패' && <p className="warn">다시 검증하지 못했습니다({entry.failure || '사유를 알 수 없음'}). 한 번 더 눌러 볼 수 있습니다.</p>}
      {entry.state === '중단' && <p className="warn">다시 검증하다가 멈췄습니다. 한 번 더 누르면 처음부터 다시 합니다.</p>}
      {entry.state === '완료' && entry.claims.length === 0 && <p>이 문장에서는 확인할 사실을 찾지 못했습니다.</p>}
      {entry.claims.length > 0 && (
        <ul>
          {entry.claims.map((e) => {
            const view = viewOf(run, e);
            const done = view.state === '완료' && view.verdict !== null;
            const evidence = view.judgment?.evidence ?? [];
            return (
              <li key={e.claim.id}>
                <div className="rc-head">
                  {done ? (
                    <VerdictBadge verdict={view.verdict as Verdict} />
                  ) : (
                    <span className="rc-state">
                      <StateBadge state={view.state} step={view.step} failure={view.failure} />
                    </span>
                  )}
                  <span>{e.claim.statement}</span>
                </div>
                {view.judgment?.reason && <p className="rc-reason">{view.judgment.reason}</p>}
                {/* 고쳐 쓴 글에서도 손볼 것이 나오면, 어떻게 하라는지까지 보여 준다 */}
                {view.judgment?.action && (
                  <p className="rc-reason">
                    <span className="rc-label">권고</span> {view.judgment.action}
                  </p>
                )}
                {view.judgment && view.judgment.fix.kind !== '없음' && (
                  <p className="rc-reason">
                    <span className="rc-label">고칠 내용</span> {view.judgment.fix.instruction} <small>({view.judgment.fix.kind})</small>
                  </p>
                )}
                {done && staysDirect(view) && <p className="rc-reason">공개 자료로 확인할 수 없는 주장입니다. {e.claim.privateReason}</p>}
                {evidence.length > 0 && (
                  <details className="more">
                    <summary>근거 {evidence.length}개 보기</summary>
                    <div className="rc-evidence">
                      {evidence.map((use) => (
                        <EvidenceItem key={`${use.evidenceNo}-${use.quote.slice(0, 12)}`} use={use} view={view} />
                      ))}
                    </div>
                  </details>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export function SentenceCard({ run, sentence, currentId, running, onSelect, onReview, onRecheck }: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [notice, setNotice] = useState('');

  const entry = run.revisions[sentence.id];
  const auto = autoRevision(run, sentence.id);
  const review = reviewOf(run, sentence.id);
  const edited = review.edited;
  const candidate = candidateText(run, sentence.id);
  const mine = run.claims.filter((e) => e.claim.sentenceId === sentence.id).map((e) => viewOf(run, e));
  const pending = mine.filter((v) => v.state !== '완료');
  const status = recheckStatus(run, sentence);
  const recheck = recheckOf(run, sentence.id);
  /** 지금의 고쳐 쓴 글을 검증하는 중인지 */
  const recheckingNow = recheck?.state === '진행 중' && recheck.text === edited;
  /** 다시 검증 단추는 고쳐 쓴 글이 있고, 그 글을 아직 끝까지 검증하지 않았을 때만 보인다(한 글에는 검증 결과가 하나) */
  const showRecheck = recheckingNow || canRecheck(run, sentence.id);
  const checkedNow = status === '현재 문장 검증 완료';
  /** 손봐야 할 판정이 난 문장인지. 그런 문장에만 보류를 고를 수 있게 한다 */
  const flagged = mine.some((v) => v.verdict !== null && v.verdict !== '일치');

  const act = (action: ReviewAction) => setNotice(onReview(sentence.id, action));
  const startEdit = () => {
    setDraft(edited ?? auto?.revised ?? sentence.source);
    setNotice('');
    setEditing(true);
  };
  const save = () => {
    setNotice(onReview(sentence.id, { kind: 'save', text: draft }));
    // 빈 글은 저장하지 못한다. 그때는 고쳐 쓰는 칸을 그대로 둔다
    if (draft.trim() !== '') setEditing(false);
  };

  // 수정안에 붙이는 알림. 편집자가 고쳐 쓴 글에는 자동 수정안의 알림을 붙이지 않는다
  const notes: Array<{ text: string; tone?: 'warn' | 'busy' }> = [];
  if (edited === null) {
    if (auto) {
      if (auto.applied.length > 1) notes.push({ text: `고칠 내용 ${auto.applied.length}가지를 수정안 하나로 합쳤습니다.` });
      const { numbersRemoved, numbersAdded } = auto.changes;
      if (numbersRemoved.length || numbersAdded.length) notes.push({ text: `달라진 숫자: ${numbersRemoved.join(', ') || '-'} → ${numbersAdded.join(', ') || '-'}` });
      if (auto.polish.state === '다듬음') notes.push({ text: '고친 대목의 이음매가 어색해 문법만 다듬었습니다.' });
      // 사실이 둘 이상인 문장은 아래 목록에서 사실마다 알린다
      if (mine.length < 2) {
        for (const skipped of auto.skipped) notes.push({ text: `반영하지 못한 고칠 내용이 있습니다(${skipped.why}).`, tone: 'warn' });
        if (entry?.unresolved.length) notes.push({ text: '이 수정안을 받아들여도 확인되지 않은 채 남는 내용이 있습니다.', tone: 'warn' });
      }
      for (const caution of auto.cautions) notes.push({ text: caution, tone: 'warn' });
    } else if (entry?.state === '진행 중') {
      notes.push({ text: '수정안을 만드는 중입니다.', tone: 'busy' });
    } else if (entry?.state === '실패' || entry?.state === '중단') {
      notes.push({ text: `수정안을 만들지 못했습니다${entry.failure ? `(${entry.failure})` : ''}. '이어서 실행'으로 다시 만들 수 있습니다.`, tone: 'warn' });
    } else if (entry?.state === '완료' && entry.revision) {
      const why = entry.revision.skipped[0]?.why;
      notes.push({ text: `생성된 수정안에 문제가 있어 보여 드리지 않습니다${why ? `(${why})` : ''}. 아래 '고칠 내용'을 보고 직접 고쳐 쓸 수 있습니다.`, tone: 'warn' });
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
      if (running) notes.push({ text: '수정안을 만들 차례를 기다리고 있습니다.', tone: 'busy' });
      else notes.push({ text: "수정안을 아직 만들지 않았습니다. '이어서 실행'으로 만들 수 있습니다.", tone: 'warn' });
    }
  }
  if (candidate !== null && !sentence.autoApply) {
    notes.push({ text: "링크나 각주가 들었거나 표·캡션에 놓인 문장이라, 채택해도 원고를 자동으로 바꾸지 않습니다. 내보낼 때 '직접 반영할 항목'으로 알립니다.", tone: 'warn' });
  }

  let pair: ReactNode;
  if (edited !== null) {
    pair = (
      <>
        <dt>원문</dt>
        <dd>
          <DiffText before={sentence.source} after={edited} side="before" />
        </dd>
        <dt>수정안</dt>
        <dd>
          <DiffText before={sentence.source} after={edited} side="after" />
        </dd>
      </>
    );
  } else if (auto?.revised) {
    const ranges = editRanges(sentence.source, auto.revised, auto.edits);
    pair = (
      <>
        <dt>원문</dt>
        <dd>
          <InlineText source={sentence.source} marks={ranges.removed} as="del" />
        </dd>
        <dt>수정안</dt>
        <dd>
          <InlineText source={auto.revised} marks={ranges.added} as="ins" />
        </dd>
      </>
    );
  } else {
    pair = (
      <>
        <dt>원문</dt>
        <dd>
          <InlineText source={sentence.source} />
        </dd>
      </>
    );
  }

  const ends = sharedEnds(mine.map((v) => v.entry.claim.statement));

  let said: ReactNode;
  if (review.choice === '채택' && candidate !== null) {
    said = (
      <>
        <p className="said ok">✓ 채택했습니다. 내보낼 때 원문을 이 수정안으로 바꿉니다.</p>
        {edited !== null && !checkedNow && (
          <p className="said warn">고쳐 쓴 뒤 다시 검증하지 않았습니다. 검토 기록에 &lsquo;편집자 수정 후 재검증하지 않음&rsquo;으로 남습니다.</p>
        )}
      </>
    );
  } else if (review.choice === '보류') {
    said = <p className="said">보류했습니다. 원문 그대로 내보냅니다.</p>;
  } else if (candidate !== null) {
    said = <p className="said quiet">아직 고르지 않았습니다. 고르지 않은 문장은 보류로 처리합니다.</p>;
  } else if (flagged) {
    said = <p className="said quiet">수정안이 없습니다. 직접 고쳐 쓰거나, 원문 그대로 둘 수 있습니다.</p>;
  } else {
    said = null;
  }

  return (
    <div className="card">
      <h3>
        문장과 수정안 <span className="n">문장 {sentence.id}</span>
        {edited === null &&
          auto &&
          [...new Set(auto.kinds)].map((kind) => (
            <span key={kind} className="tag fix">
              {kind}
            </span>
          ))}
        {edited !== null && <span className="tag">편집자가 고쳐 씀</span>}
        {status && <span className={`chip-state ${STATUS_CLASS[status]}`}>{STATUS_LABEL[status]}</span>}
        <DecisionChip review={review} hasCandidate={candidate !== null} choiceOnly />
      </h3>
      <dl className="pair">{pair}</dl>

      {mine.length >= 2 && (
        <div className="facts">
          <h4>
            {edited !== null ? '원문에서' : '이 문장에서'} 확인한 사실 {mine.length}가지
          </h4>
          {mine.map((view) => {
            const { id, statement } = view.entry.claim;
            const note = factNote(run, view);
            const done = view.state === '완료' && view.verdict !== null;
            return (
              <button key={id} type="button" className="fact" aria-current={id === currentId} onClick={() => onSelect(id)}>
                {done ? <VerdictBadge verdict={view.verdict as Verdict} /> : <span className="tag">{view.state}</span>}
                <span className="what">
                  <PartsText text={statement} head={ends.head} tail={ends.tail} />
                  {id === currentId && <span className="now">지금 보는 것</span>}
                </span>
                <span className={`state ${note.tone}`}>{note.text}</span>
              </button>
            );
          })}
        </div>
      )}

      {notes.length > 0 && (
        <ul className="notes">
          {notes.map((note, i) => (
            <li key={i} className={note.tone}>
              {note.text}
            </li>
          ))}
        </ul>
      )}

      <RecheckBlock run={run} sentence={sentence} />

      <div className="decide">
        {editing ? (
          <div className="editor">
            <textarea value={draft} onChange={(event) => setDraft(event.target.value)} aria-label="수정안 고쳐 쓰기" autoFocus />
            <p className="hint">
              저장하면 이 글이 새 수정안이 됩니다. 원문은 그대로 남고, 채택해야 내보낼 때 반영됩니다. 저장한 뒤에는 이 문장만 다시 검증할 수 있습니다. 굵은
              글씨(**)와 링크 표시는 원고에 적힌 꼴 그대로 둡니다.
            </p>
            {notice && (
              <p className="said warn" role="status">
                {notice}
              </p>
            )}
            <div className="actions">
              <button type="button" className="btn primary" onClick={save}>
                저장
              </button>
              <button type="button" className="btn" onClick={() => setEditing(false)}>
                취소
              </button>
            </div>
          </div>
        ) : (
          <>
            {said}
            {notice && (
              <p className="said warn" role="status">
                {notice}
              </p>
            )}
            <div className="actions">
              {candidate !== null &&
                (review.choice === '채택' ? (
                  <button type="button" className="btn" onClick={() => act({ kind: 'unadopt' })}>
                    채택 취소
                  </button>
                ) : (
                  <button type="button" className="btn primary" onClick={() => act({ kind: 'adopt' })}>
                    {edited !== null ? '고쳐 쓴 문장 채택' : '수정안 채택'}
                  </button>
                ))}
              <button type="button" className="btn" onClick={startEdit}>
                {edited !== null ? '다시 고쳐 쓰기' : '고쳐 쓰기'}
              </button>
              {(candidate !== null || flagged) &&
                (review.choice === '보류' ? (
                  <button type="button" className="btn" onClick={() => act({ kind: 'unhold' })}>
                    보류 취소
                  </button>
                ) : (
                  <button type="button" className="btn" onClick={() => act({ kind: 'hold' })}>
                    보류
                  </button>
                ))}
              <span className="spacer" />
              {edited !== null && (
                <button type="button" className="btn quiet" onClick={() => act({ kind: 'revert' })}>
                  {auto ? '자동 수정안으로 되돌리기' : '고쳐 쓴 글 지우기'}
                </button>
              )}
              {showRecheck && (
                <button
                  type="button"
                  className="btn"
                  disabled={running || recheckingNow}
                  title={running ? '검증이 끝난 뒤에 쓸 수 있습니다.' : undefined}
                  onClick={() => {
                    setNotice('');
                    onRecheck(sentence.id);
                  }}
                >
                  {recheckingNow ? '다시 검증하는 중' : '고쳐 쓴 문장 다시 검증'}
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
