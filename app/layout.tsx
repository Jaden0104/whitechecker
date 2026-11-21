import type { Metadata, Viewport } from 'next';
// 글꼴은 앱에 담아 보낸다. 글자 묶음별로 나뉜 파일이라 브라우저가 화면에 나온 글자의 묶음만 받는다
import 'pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css';
import './globals.css';

export const metadata: Metadata = {
  title: '화이트체커',
  description: '발행 전 원고의 사실 취약점을 먼저 찾아 주는 팩트체크 에이전트',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#ffffff',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
