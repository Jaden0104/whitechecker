import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Sample } from '@/components/StartScreen';
import Workbench from '@/components/Workbench';
import './workbench.css';

/** 시작 화면에서 불러올 수 있는 가상 원고. 일부러 틀린 곳을 심어 둔 시험용 글이다 */
function loadSamples(): Sample[] {
  try {
    const text = readFileSync(path.join(process.cwd(), 'fixtures', 'small', 'manuscript.md'), 'utf8');
    return [{ id: 'small', label: '돌에 새긴 하늘, 천상열차분야지도', text }];
  } catch {
    return [];
  }
}

export default function HomePage() {
  return <Workbench samples={loadSamples()} />;
}
