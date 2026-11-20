import { checkAccess } from '@/lib/access';
import { signBundle } from '@/lib/evidence';
import { gatherEvidence, type GatherClaim } from '@/lib/gather/run';
import { LinerError, newBudget, serverKey } from '@/lib/liner';
import { CLAIM_TYPES, type ClaimType } from '@/lib/types';

export const dynamic = 'force-dynamic';

const short = (value: unknown, max: number) => (typeof value === 'string' ? value.trim().slice(0, max) : '');

function readClaim(body: unknown): GatherClaim | string {
  const c = (body as { claim?: Record<string, unknown> } | null)?.claim;
  if (!c || typeof c !== 'object') return '명제가 없습니다.';
  const statement = short(c.statement, 400);
  if (!statement) return '명제의 내용이 없습니다.';
  if (!CLAIM_TYPES.includes(c.type as ClaimType)) return '명제의 유형이 맞지 않습니다.';
  if (c.isPublic === false) return "공개 자료로 확인할 수 없는 명제는 '직접 확인' 목록으로 보냅니다.";
  const list = (value: unknown, count: number, max: number) =>
    (Array.isArray(value) ? value : [])
      .map((v) => short(v, max))
      .filter(Boolean)
      .slice(0, count);
  return {
    statement,
    type: c.type as ClaimType,
    qualifiers: list(c.qualifiers, 10, 20),
    asOf: short(c.asOf, 40) || '현재',
    // 검색어는 기본 2개와 반증 1개까지 받는다. 추가 검색 1회는 서버가 정한다
    queries: list(c.queries, 2, 120),
    counterQuery: short(c.counterQuery, 120),
  };
}

// 근거 모으기. 명제 하나를 받아 검색, 원문 수집, 발췌까지 하고 서명한 근거 묶음을 돌려준다.
export async function POST(request: Request) {
  const denied = checkAccess(request);
  if (denied) return denied;

  let claim: GatherClaim | string;
  try {
    claim = readClaim(await request.json());
  } catch {
    claim = '요청의 형식이 맞지 않습니다.';
  }
  if (typeof claim === 'string') return Response.json({ error: claim }, { status: 400 });

  try {
    const key = serverKey();
    const { bundle, usage } = await gatherEvidence(claim, key, newBudget());
    return Response.json({ bundle, signature: signBundle(bundle, key), usage });
  } catch (e) {
    if (e instanceof LinerError) {
      const status = e.kind === '키 없음' ? 500 : 502;
      return Response.json({ error: '검색 오류', reason: e.kind }, { status });
    }
    return Response.json({ error: '처리 중 오류가 났습니다.', reason: '서버 오류' }, { status: 500 });
  }
}
