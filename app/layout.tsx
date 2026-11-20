import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: '화이트체커',
  description: '발행 전 원고의 사실 취약점을 먼저 찾아 주는 팩트체크 에이전트',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
