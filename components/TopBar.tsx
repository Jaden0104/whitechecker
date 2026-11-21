// 위쪽 줄: 로고 묶음, 진행 상태, 호출 요약(F12), 중단과 이어서 실행(F16).
import { useEffect, useState } from 'react';
import { formatDollars, formatDuration } from '@/lib/client/text';
import { totalCost } from '@/lib/pricing';
import { countClaims, hasUnfinished, summarizeUsage, type RunState } from '@/lib/run/model';
import { Brand } from './bits';

interface Props {
  /** 시작 화면에서는 null */
  run: RunState | null;
  onStop: () => void;
  onResume: () => void;
  onHome: () => void;
  onClear: () => void;
  /** 내보내기 화면을 열거나 닫는다. 주지 않으면 단추를 보이지 않는다 */
  onExport?: () => void;
  /** 내보내기 화면이 열려 있는지 */
  exporting?: boolean;
  /** 채택한 문장 수. 단추에 함께 적는다 */
  adopted?: number;
}

/** 돌아가는 동안 1초마다 다시 그려, 걸린 시간이 흐르게 한다 */
function useTick(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

export function TopBar({ run, onStop, onResume, onHome, onClear, onExport, exporting, adopted }: Props) {
  const [showUsage, setShowUsage] = useState(false);
  const running = run !== null && (run.status === '추출 중' || run.status === '검증 중');
  const now = useTick(running);

  if (!run) {
    return (
      <header className="top">
        <Brand />
        <div className="status" />
        <div className="top-actions">
          <button type="button" className="btn quiet small" onClick={onClear}>
            이 기기의 기록 삭제
          </button>
        </div>
      </header>
    );
  }

  const counts = countClaims(run);
  const summary = summarizeUsage(run.usage);
  const cost = totalCost(run.usage);
  const elapsed = run.activeMs + (run.passStartedAt !== null ? Math.max(0, now - run.passStartedAt) : 0);
  const chunksDone = run.chunks.filter((c) => c.state === '완료').length;
  const left = counts.total - counts.done;
  const scope = `뽑은 ${counts.total}개 중 ${counts.done}개 처리${left > 0 ? `, ${left}개 미완료` : ''}`;

  let headline: string;
  let detail: string;
  let ratio: number | null = null;
  if (run.status === '추출 중') {
    headline = '명제를 뽑는 중';
    detail = `원고 묶음 ${run.chunks.length}개 가운데 ${chunksDone}개 끝남`;
    ratio = run.chunks.length ? chunksDone / run.chunks.length : 0;
  } else if (run.status === '검증 중') {
    headline = '검증하는 중';
    detail = `명제 ${counts.total}개 가운데 ${counts.done}개 끝남`;
    ratio = counts.total ? counts.done / counts.total : 0;
  } else {
    headline = run.status === '끝남' ? '검증 끝남' : '멈춤';
    detail = scope;
  }
  const usageLine = running
    ? `검색 ${summary.searches}회 · 모델 ${summary.modelCalls}회 · ${formatDuration(elapsed)}`
    : `검색 ${summary.searches}회 · 모델 ${summary.modelCalls}회 · ${formatDollars(cost.dollars)} · ${formatDuration(elapsed)}`;

  return (
    <header className="top">
      <Brand />
      <div className="status" aria-live="polite">
        <b>{headline}</b>
        <span>{detail}</span>
        {ratio !== null && (
          <span className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(ratio * 100)}>
            <i style={{ width: `${Math.round(ratio * 100)}%` }} />
          </span>
        )}
        <button type="button" className="usage" aria-expanded={showUsage} onClick={() => setShowUsage((v) => !v)} title="Liner API 호출 내역 보기">
          {usageLine}
        </button>
      </div>
      <div className="top-actions">
        {running ? (
          <button type="button" className="btn small" onClick={onStop}>
            중단
          </button>
        ) : (
          <>
            {hasUnfinished(run) && (
              <button type="button" className="btn primary small" onClick={onResume}>
                이어서 실행
              </button>
            )}
            {onExport &&
              counts.total > 0 &&
              (exporting ? (
                <button type="button" className="btn small" onClick={onExport}>
                  검토로 돌아가기
                </button>
              ) : (
                // 다시 돌릴 것이 남아 있으면 '이어서 실행'이 먼저다. 그때는 내보내기를 눈에 덜 띄게 둔다
                <button type="button" className={hasUnfinished(run) ? 'btn small' : 'btn primary small'} onClick={onExport}>
                  내보내기{adopted ? ` · 채택 ${adopted}` : ''}
                </button>
              ))}
            <button type="button" className="btn quiet small" onClick={onHome}>
              처음으로
            </button>
          </>
        )}
      </div>

      {showUsage && (
        <div className="usage-panel" role="region" aria-label="Liner API 호출 내역">
          <h3>
            Liner API 호출 내역
            <button type="button" onClick={() => setShowUsage(false)}>
              닫기
            </button>
          </h3>
          <div className="scroll-x">
            <table>
              <thead>
                <tr>
                  <th>단계</th>
                  <th>검색</th>
                  <th>모델 호출</th>
                  <th>입력 토큰</th>
                  <th>출력 토큰</th>
                  <th>추정 비용</th>
                </tr>
              </thead>
              <tbody>
                {summary.byStage.map((row) => (
                  <tr key={row.stage}>
                    <td>{row.stage}</td>
                    <td>{row.searches ? `${row.searches}회` : '-'}</td>
                    <td>{row.modelCalls ? `${row.modelCalls}회` : '-'}</td>
                    <td>{row.promptTokens ? row.promptTokens.toLocaleString() : '-'}</td>
                    <td>{row.completionTokens ? row.completionTokens.toLocaleString() : '-'}</td>
                    <td>{formatDollars(totalCost(run.usage.filter((u) => u.stage === row.stage)).dollars)}</td>
                  </tr>
                ))}
                {summary.byStage.length === 0 && (
                  <tr>
                    <td colSpan={6}>아직 끝난 호출이 없습니다.</td>
                  </tr>
                )}
              </tbody>
              <tfoot>
                <tr>
                  <td>합계</td>
                  <td>{summary.searches}회</td>
                  <td>{summary.modelCalls}회</td>
                  <td>{summary.promptTokens.toLocaleString()}</td>
                  <td>{summary.completionTokens.toLocaleString()}</td>
                  <td>{formatDollars(cost.dollars)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
          <p>
            검색은 Liner Search API, 나머지는 Liner Model API입니다. 걸린 시간 {formatDuration(elapsed)}. 비용은 Liner의 가격표로 어림한 값이며, 실패한
            요청의 사용량은 들어 있지 않습니다.
            {cost.unknownModels.length > 0 && ` 가격표에 없는 모델(${cost.unknownModels.join(', ')})의 토큰 값은 넣지 못했습니다.`}
            {run.dropped > 0 && ` 추출 결과 가운데 형식이 맞지 않는 명제 ${run.dropped}개는 받지 않았습니다.`}
          </p>
        </div>
      )}
    </header>
  );
}
