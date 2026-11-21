'use client';

import { useState } from 'react';

type Row = {
  label: string;
  url: string;
  ok: boolean;
  line: string;
};

type Report = {
  where: string;
  node: string;
  at: string;
  passed: number;
  total: number;
  results: Row[];
};

// 원문 수집 시험 화면. 이 서버에서 공개 페이지 12곳을 열어 본 결과를 보여 준다.
export default function DiagPage() {
  const [code, setCode] = useState('');
  const [running, setRunning] = useState(false);
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState('');

  async function run() {
    setRunning(true);
    setError('');
    setReport(null);
    try {
      const res = await fetch('/api/diag/fetch-probe', {
        method: 'POST',
        headers: { 'x-access-code': code },
      });
      const body = await res.json();
      if (!res.ok) setError(body.error ?? `요청이 실패했습니다(${res.status}).`);
      else setReport(body as Report);
    } catch {
      setError('서버에 연결하지 못했습니다.');
    } finally {
      setRunning(false);
    }
  }

  return (
    <main className="diag">
      <h1>원문 수집 시험</h1>
      <p className="muted">
        이 서버에서 공공기관, 백과, 논문, 위키 12곳을 열어 본문에 기대한 구절이 있는지 확인합니다. 앱의 이름을 밝히고 열며,
        거부하는 사이트는 다시 열지 않습니다.
      </p>
      <p>
        <input
          type="password"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="접속 코드"
          aria-label="접속 코드"
        />{' '}
        <button onClick={run} disabled={running}>
          {running ? '여는 중…' : '시험 시작'}
        </button>
      </p>
      {error && <p className="bad">{error}</p>}
      {report && (
        <>
          <p>
            <strong>
              본문까지 읽힌 출처: {report.passed}/{report.total}
            </strong>{' '}
            <span className="muted">
              ({report.where}, Node {report.node}, {report.at.slice(0, 19).replace('T', ' ')} UTC)
            </span>
          </p>
          <table>
            <thead>
              <tr>
                <th>출처</th>
                <th>결과</th>
              </tr>
            </thead>
            <tbody>
              {report.results.map((r) => (
                <tr key={r.url}>
                  <td>{r.label}</td>
                  <td className={r.ok ? 'ok' : 'bad'}>{r.line}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </main>
  );
}
