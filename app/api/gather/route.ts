import { checkAccess } from '@/lib/access';
import { signBundle, verifyBundle } from '@/lib/evidence';
import { gatherEvidence, gatherMore, type GatherClaim } from '@/lib/gather/run';
import { LIMITS } from '@/lib/limits';
import { LinerError, newBudget, serverKey } from '@/lib/liner';
import { CLAIM_TYPES, type ClaimType, type EvidenceBundle } from '@/lib/types';

export const dynamic = 'force-dynamic';

/** 보강 검색 요청에는 앞서 모은 근거 묶음이 함께 온다. 묶음은 발췌 8,000자와 출처 16곳까지라 이보다 클 수 없다 */
const MAX_BODY_CHARS = 200_000;

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

interface More {
  bundle: EvidenceBundle;
  signature: string;
  missing: string;
}

/** 보강 검색 요청이면 앞서 모은 묶음과 서명, 판정에서 모자랐던 것을 읽는다. 보강 검색이 아니면 null */
function readMore(body: unknown): More | string | null {
  const m = (body as { more?: { bundle?: unknown; signature?: unknown; missing?: unknown } } | null)?.more;
  if (m === undefined || m === null) return null;
  const bundle = m.bundle as EvidenceBundle | undefined;
  if (!bundle || typeof bundle !== 'object' || bundle.v !== 1 || !Array.isArray(bundle.evidence) || !Array.isArray(bundle.sources) || !Array.isArray(bundle.searches)) {
    return '근거 묶음의 형식이 맞지 않습니다.';
  }
  if (typeof m.signature !== 'string' || !m.signature) return '근거 묶음의 서명이 없습니다.';
  return { bundle, signature: m.signature, missing: short(m.missing, LIMITS.followUp.missingChars) };
}

// 근거 모으기. 명제 하나를 받아 검색, 원문 수집, 발췌까지 하고 서명한 근거 묶음을 돌려준다.
// 요청에 more가 있으면 보강 검색이다. 앞서 모은 묶음(서명이 맞아야 한다)에 새로 찾은 근거를 붙여 다시 서명해 돌려준다.
export async function POST(request: Request) {
  const denied = checkAccess(request);
  if (denied) return denied;

  let claim: GatherClaim | string;
  let more: More | string | null = null;
  try {
    const text = await request.text();
    if (text.length > MAX_BODY_CHARS) {
      claim = '요청이 너무 큽니다.';
    } else {
      const body = JSON.parse(text);
      claim = readClaim(body);
      more = readMore(body);
    }
  } catch {
    claim = '요청의 형식이 맞지 않습니다.';
  }
  if (typeof claim === 'string') return Response.json({ error: claim }, { status: 400 });
  if (typeof more === 'string') return Response.json({ error: more }, { status: 400 });

  try {
    const key = serverKey();
    if (more) {
      // 서명으로 묶음이 수집 당시와 같은지, 이 명제의 것인지 확인한다. 맞지 않으면 검색하지 않는다
      if (!verifyBundle(more.bundle, more.signature, claim, key)) {
        return Response.json({ error: '근거 묶음의 서명이 맞지 않는다.', reason: '근거 묶음 오류' }, { status: 409 });
      }
      const { bundle, usage } = await gatherMore(claim, more.bundle, more.missing, key, newBudget());
      return Response.json({ bundle, signature: signBundle(bundle, key), usage });
    }
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
