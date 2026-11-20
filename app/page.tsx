import Link from 'next/link';

export default function HomePage() {
  return (
    <main>
      <h1>화이트체커</h1>
      <p>발행 전 원고의 사실 취약점을 먼저 찾아 주는 팩트체크 에이전트입니다.</p>
      <p className="muted">검증 화면은 만드는 중입니다. 지금은 원문 수집 시험만 열려 있습니다.</p>
      <p>
        <Link href="/diag">원문 수집 시험</Link>
      </p>
    </main>
  );
}
