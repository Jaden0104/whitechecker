// 내보내기(F11, 9장): 채택한 문장만 바꾼 수정 원고와, 무엇을 왜 고쳤는지 적은 검토 기록을 내려받는다.
// 파일은 이 브라우저에서 만들고 서버에 남기지 않는다. 내려받기 전에 남는 것(채택하지 않은 수정안, 미해결, 직접 확인)을 함께 보인다.
import { useMemo, type ReactNode } from 'react';
import { fileBase, planExport, reviewRecordJson, reviewRecordMarkdown } from '@/lib/client/export';
import { formatDollars, formatDuration } from '@/lib/client/text';
import { totalCost } from '@/lib/pricing';
import { summarizeUsage, type ClaimView, type RunState } from '@/lib/run/model';
import type { Sentence, Verdict } from '@/lib/types';
import { DiffText, InlineText, VerdictBadge } from './bits';
import { Manuscript } from './Manuscript';

interface Props {
  run: RunState;
  onBack: () => void;
  /** 목록의 항목을 눌러 그 명제의 상세로 간다 */
  onOpen: (claimId: string) => void;
}

function download(name: string, text: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** 내보낸 때를 이 기기의 시각으로 적는다(예: 2026-11-21 19:05) */
function stamp(): string {
  const d = new Date();
  const two = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

function Tile({ n, label, tone }: { n: number; label: string; tone?: 'ok' | 'warn' }) {
  return (
    <div className={tone ? `tile ${tone}` : 'tile'}>
      <b>{n}</b>
      <span>{label}</span>
    </div>
  );
}

export function ExportPanel({ run, onBack, onOpen }: Props) {
  const plan = useMemo(() => planExport(run), [run]);
  const summary = summarizeUsage(run.usage);
  const cost = totalCost(run.usage);
  const base = fileBase(run.title);
  const adopted = plan.applied.length + plan.manual.length;
  const appliedIds = new Set(plan.applied.map((a) => a.sentenceId));
  const afterOf = new Map(plan.applied.map((a) => [a.sentenceId, a.after]));
  const firstClaim = (sentenceId: number) => run.claims.find((e) => e.claim.sentenceId === sentenceId)?.claim.id;

  const saveManuscript = () => {
    if (plan.manuscript !== null) download(`${base}_수정원고.md`, plan.manuscript, 'text/markdown;charset=utf-8');
  };
  const saveRecord = () => download(`${base}_검토기록.md`, reviewRecordMarkdown(run, plan, stamp()), 'text/markdown;charset=utf-8');
  const saveJson = () => download(`${base}_검토기록.json`, `${JSON.stringify(reviewRecordJson(run, plan, stamp()), null, 2)}\n`, 'application/json;charset=utf-8');

  // 수정 원고 미리 보기: 원고에 반영하는 문장만 바꾸고, 바뀐 대목을 표시한다
  const renderSentence = (sentence: Sentence) => {
    if (sentence.kind === 'table') return sentence.plain;
    const after = afterOf.get(sentence.id);
    return after !== undefined && appliedIds.has(sentence.id) ? <DiffText before={sentence.source} after={after} side="after" /> : <InlineText source={sentence.source} />;
  };

  const open = (claimId: string | undefined) =>
    claimId ? (
      <button type="button" className="open" onClick={() => onOpen(claimId)}>
        열어 보기 ›
      </button>
    ) : null;
  const claimItem = (view: ClaimView, verdict: Verdict | null, extra?: ReactNode) => (
    <li key={view.entry.claim.id}>
      <div className="where">
        문장 {view.entry.claim.sentenceId} {verdict ? <VerdictBadge verdict={verdict} /> : <span className="tag">{view.state}</span>}
        {open(view.entry.claim.id)}
      </div>
      {view.entry.claim.statement}
      {extra}
    </li>
  );
  const none = (text: string) => <p className="reason quiet small">{text}</p>;

  return (
    <div className="export">
      <button type="button" className="back" onClick={onBack}>
        ‹ 검토로
      </button>
      <h2>내보내기</h2>
      <p className="lead">채택한 문장만 바꾼 새 원고와, 무엇을 왜 고쳤는지 적은 검토 기록을 만듭니다. 원본 원고는 바뀌지 않습니다.</p>

      <div className="tiles">
        <Tile n={adopted} label="채택한 문장" tone="ok" />
        <Tile n={plan.held.length} label="채택하지 않은 수정안" />
        <Tile n={plan.open.length} label="미해결로 남는 내용" tone={plan.open.length ? 'warn' : undefined} />
        <Tile n={plan.direct.length} label="직접 확인할 것" />
        <Tile n={plan.manual.length} label="직접 반영할 항목" tone={plan.manual.length ? 'warn' : undefined} />
        <Tile n={plan.unfinished.length} label="끝나지 않은 항목" tone={plan.unfinished.length ? 'warn' : undefined} />
      </div>

      <div className="card">
        <h3>내려받기</h3>
        <div className="downloads">
          <button type="button" className="btn primary" disabled={plan.manuscript === null} onClick={saveManuscript}>
            수정 원고 (.md)
          </button>
          <button type="button" className="btn" onClick={saveRecord}>
            검토 기록 (.md)
          </button>
          <button type="button" className="btn" onClick={saveJson}>
            검토 기록 (.json)
          </button>
        </div>
        <p className="small-note">
          파일은 이 브라우저에서 만들고 서버에 남기지 않습니다.
          {plan.problem ? ` ${plan.problem}` : ''}
          {plan.unchecked.length > 0 ? ` 고쳐 쓴 뒤 다시 검증하지 않고 채택한 문장이 ${plan.unchecked.length}개 있습니다. 검토 기록에 그렇게 적힙니다.` : ''}
          {plan.unfinished.length > 0 ? ` 끝나지 않은 항목이 ${plan.unfinished.length}개 있습니다. 검토 기록에 함께 적힙니다.` : ''}
        </p>
      </div>

      <div className="card">
        <h3>
          수정 원고 미리 보기 <span className="n">바뀐 문장 {plan.applied.length}개</span>
        </h3>
        <div className="preview">
          <Manuscript sentences={run.sentences} render={renderSentence} />
        </div>
      </div>

      <div className="card">
        <h3>
          채택하지 않은 수정안 <span className="n">{plan.held.length}</span>
        </h3>
        {plan.held.length === 0 ? (
          none('채택하지 않은 수정안이 없습니다.')
        ) : (
          <>
            <ul className="todo">
              {plan.held.map((item) => (
                <li key={item.sentenceId}>
                  <div className="where">
                    문장 {item.sentenceId} <span className="tag">{item.choice === '보류' ? '보류' : '고르지 않음'}</span>
                    {open(firstClaim(item.sentenceId))}
                  </div>
                  <DiffText before={item.before} after={item.after} side="before" />
                  <div className="then">
                    <span className="label">수정안</span> <DiffText before={item.before} after={item.after} side="after" />
                  </div>
                </li>
              ))}
            </ul>
            <p className="small-note">보류했거나 아직 고르지 않은 수정안입니다. 이 문장들은 원문 그대로 내보냅니다.</p>
          </>
        )}
      </div>

      <div className="card">
        <h3>
          미해결로 남는 내용 <span className="n">{plan.open.length}</span>
        </h3>
        {plan.open.length === 0 ? none('남는 내용이 없습니다.') : <ul className="todo">{plan.open.map((view) => claimItem(view, view.verdict))}</ul>}
      </div>

      <div className="card">
        <h3>
          직접 확인할 것 <span className="n">{plan.direct.length}</span>
        </h3>
        {plan.direct.length === 0 ? (
          none('없습니다.')
        ) : (
          <ul className="todo">
            {plan.direct.map((view) =>
              claimItem(view, '직접 확인', <div className="then">{view.entry.claim.privateReason || '공개 자료로는 확인할 수 없는 주장입니다.'}</div>),
            )}
          </ul>
        )}
      </div>

      <div className="card">
        <h3>
          직접 반영할 항목 <span className="n">{plan.manual.length}</span>
        </h3>
        {plan.manual.length === 0 ? (
          none('없습니다. 링크나 각주가 든 문장, 표와 캡션의 수정안은 원고를 자동으로 바꾸지 않고 여기에 모읍니다.')
        ) : (
          <ul className="todo">
            {plan.manual.map((item) => (
              <li key={item.sentenceId}>
                <div className="where">
                  문장 {item.sentenceId} · {item.why}
                  {open(firstClaim(item.sentenceId))}
                </div>
                <DiffText before={item.before} after={item.after} side="before" />
                <div className="then">
                  <span className="label">고친 뒤</span> <DiffText before={item.before} after={item.after} side="after" />
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {plan.unfinished.length > 0 && (
        <div className="card">
          <h3>
            끝나지 않은 항목 <span className="n">{plan.unfinished.length}</span>
          </h3>
          <ul className="todo">{plan.unfinished.map((view) => claimItem(view, null, view.failure ? <div className="then">{view.failure}</div> : null))}</ul>
        </div>
      )}

      <div className="card">
        <h3>
          검토 기록 미리 보기 <span className="n">.md</span>
        </h3>
        <pre className="record">{reviewRecordMarkdown(run, plan, stamp())}</pre>
      </div>

      <div className="card">
        <h3>이번 실행</h3>
        <p className="reason small">
          검색 {summary.searches}회 · 모델 {summary.modelCalls}회 · {formatDollars(cost.dollars)} · {formatDuration(run.activeMs)}
        </p>
      </div>
    </div>
  );
}
