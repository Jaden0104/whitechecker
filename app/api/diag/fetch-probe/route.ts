import { checkAccess } from '@/lib/access';
import { TARGETS, describe, probe } from '@/lib/probe-core.mjs';

export const dynamic = 'force-dynamic';

// 원문 수집 시험. 배포한 서버에서 공개 페이지 12곳을 열어, PC에서 돌린 결과와 비교하는 데 쓴다.
// 성공은 기대한 구절이 뽑은 본문에 있을 때로 본다.
export async function POST(request: Request) {
  const denied = checkAccess(request);
  if (denied) return denied;

  const results: Array<{ label: string; url: string; line: string } & Awaited<ReturnType<typeof probe>>> = [];
  const queue = TARGETS.map((target, index) => ({ target, index }));
  const worker = async () => {
    for (let job = queue.shift(); job; job = queue.shift()) {
      const [label, url, keyword] = job.target;
      const res = await probe(url, keyword);
      results[job.index] = { label, url, line: describe(res), ...res };
    }
  };
  // 한꺼번에 네 곳까지만 연다
  await Promise.all([worker(), worker(), worker(), worker()]);

  return Response.json({
    where: process.env.WEBSITE_SITE_NAME ? `Azure ${process.env.REGION_NAME ?? ''}`.trim() : 'PC',
    node: process.version,
    at: new Date().toISOString(),
    passed: results.filter((r) => r.ok).length,
    total: results.length,
    results,
  });
}
