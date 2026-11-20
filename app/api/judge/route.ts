import { checkAccess } from '@/lib/access';
import { BundleError, judgeClaim, type JudgeInput } from '@/lib/judge/run';
import { LinerError, newBudget, serverKey } from '@/lib/liner';
import { CLAIM_TYPES, type ClaimType, type EvidenceBundle } from '@/lib/types';

export const dynamic = 'force-dynamic';

/** 근거 묶음은 발췌 8,000자와 출처 16곳까지라 이보다 클 수 없다 */
const MAX_BODY_CHARS = 200_000;

const short = (value: unknown, max: number) => (typeof value === 'string' ? value.trim().slice(0, max) : '');

function readInput(body: unknown): JudgeInput | string {
  const b = body as { claim?: Record<string, unknown>; sentence?: unknown; lead?: unknown; bundle?: unknown; signature?: unknown } | null;
  const c = b?.claim;
  if (!c || typeof c !== 'object') return '명제가 없습니다.';
  const statement = short(c.statement, 400);
  if (!statement) return '명제의 내용이 없습니다.';
  if (!CLAIM_TYPES.includes(c.type as ClaimType)) return '명제의 유형이 맞지 않습니다.';
  if (!b?.bundle || typeof b.bundle !== 'object') return '근거 묶음이 없습니다.';
  if (typeof b.signature !== 'string' || !b.signature) return '근거 묶음의 서명이 없습니다.';
  return {
    claim: {
      statement,
      type: c.type as ClaimType,
      qualifiers: (Array.isArray(c.qualifiers) ? c.qualifiers : [])
        .map((q) => short(q, 20))
        .filter(Boolean)
        .slice(0, 10),
      asOf: short(c.asOf, 40) || '현재',
    },
    sentence: short(b.sentence, 1000),
    lead: b.lead === true,
    bundle: b.bundle as EvidenceBundle,
    signature: b.signature,
  };
}

// 판정. 명제 하나와 서명된 근거 묶음을 받아 판정을 돌려준다. 서명이 맞지 않는 묶음은 받지 않는다.
export async function POST(request: Request) {
  const denied = checkAccess(request);
  if (denied) return denied;

  let input: JudgeInput | string;
  try {
    const text = await request.text();
    input = text.length > MAX_BODY_CHARS ? '요청이 너무 큽니다.' : readInput(JSON.parse(text));
  } catch {
    input = '요청의 형식이 맞지 않습니다.';
  }
  if (typeof input === 'string') return Response.json({ error: input }, { status: 400 });

  try {
    const { judgment, usage } = await judgeClaim(input, serverKey(), newBudget());
    return Response.json({ judgment, usage });
  } catch (e) {
    if (e instanceof BundleError) return Response.json({ error: `${e.message}.`, reason: '근거 묶음 오류' }, { status: 409 });
    if (e instanceof LinerError) {
      // 잘린 응답이나 형식이 깨진 응답은 성공으로 처리하지 않는다
      return Response.json({ error: '모델 응답 오류', reason: e.kind }, { status: e.kind === '키 없음' ? 500 : 502 });
    }
    return Response.json({ error: '처리 중 오류가 났습니다.', reason: '서버 오류' }, { status: 500 });
  }
}
