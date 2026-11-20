import { checkAccess } from '@/lib/access';
import { LIMITS } from '@/lib/limits';
import { LinerError, chatJson, newBudget, serverKey } from '@/lib/liner';
import { EXTRACT_SCHEMA, EXTRACT_SYSTEM, extractUserMessage, type ExtractInput } from '@/lib/prompts/extract';
import { CLAIM_TYPES, type Claim, type ClaimType } from '@/lib/types';

export const dynamic = 'force-dynamic';

interface RawClaim {
  sentence_id: number;
  statement: string;
  type: string;
  qualifiers: string[];
  as_of: string;
  is_public: boolean;
  private_reason: string;
  queries: string[];
  counter_query: string;
}

function readInput(body: unknown): ExtractInput | string {
  const b = body as Partial<ExtractInput> | null;
  if (!b || !Array.isArray(b.sentences) || b.sentences.length === 0) return '문장이 없습니다.';
  const sentences = b.sentences.filter((s) => Number.isInteger(s?.id) && typeof s?.text === 'string' && s.text.trim());
  if (sentences.length !== b.sentences.length) return '문장의 형식이 맞지 않습니다.';
  const size = sentences.reduce((n, s) => n + s.text.length, 0);
  if (size > LIMITS.extract.inputChars) return `한 번에 보낼 수 있는 글자 수(${LIMITS.extract.inputChars}자)를 넘었습니다.`;
  return {
    title: String(b.title ?? '').slice(0, 200),
    context: String(b.context ?? '').slice(-LIMITS.extract.contextChars),
    sentences,
  };
}

// 명제 추출. 번호가 붙은 문장 묶음을 받아 명제 목록을 돌려준다.
export async function POST(request: Request) {
  const denied = checkAccess(request);
  if (denied) return denied;

  let input: ExtractInput | string;
  try {
    input = readInput(await request.json());
  } catch {
    input = '요청의 형식이 맞지 않습니다.';
  }
  if (typeof input === 'string') return Response.json({ error: input }, { status: 400 });

  try {
    const { value, usage } = await chatJson<{ claims: RawClaim[] }>({
      stage: '추출',
      key: serverKey(),
      system: EXTRACT_SYSTEM,
      user: extractUserMessage(input),
      schemaName: 'claims',
      schema: EXTRACT_SCHEMA,
      maxTokens: LIMITS.extract.outputTokens,
      budget: newBudget(),
    });

    const known = new Set(input.sentences.map((s) => s.id));
    const counter = new Map<number, number>();
    const claims: Claim[] = [];
    let dropped = 0;
    for (const raw of value.claims ?? []) {
      // 보낸 문장 번호가 아니거나 유형이 목록에 없으면 받지 않는다
      if (!known.has(raw.sentence_id) || !CLAIM_TYPES.includes(raw.type as ClaimType) || !raw.statement?.trim()) {
        dropped += 1;
        continue;
      }
      const n = (counter.get(raw.sentence_id) ?? 0) + 1;
      counter.set(raw.sentence_id, n);
      claims.push({
        id: `s${raw.sentence_id}-c${n}`,
        sentenceId: raw.sentence_id,
        statement: raw.statement.trim(),
        type: raw.type as ClaimType,
        qualifiers: (raw.qualifiers ?? []).map((q) => q.trim()).filter(Boolean),
        asOf: raw.as_of?.trim() || '현재',
        isPublic: Boolean(raw.is_public),
        privateReason: raw.is_public ? '' : (raw.private_reason ?? '').trim(),
        queries: raw.is_public ? (raw.queries ?? []).map((q) => q.trim()).filter(Boolean).slice(0, 2) : [],
        counterQuery: raw.is_public ? (raw.counter_query ?? '').trim() : '',
      });
    }
    return Response.json({ claims, dropped, usage });
  } catch (e) {
    if (e instanceof LinerError) {
      // 잘린 응답은 성공으로 처리하지 않는다. 화면이 입력을 더 작게 나눠 다시 보낸다
      return Response.json({ error: e.kind, reason: e.kind }, { status: e.kind === '키 없음' ? 500 : 502 });
    }
    return Response.json({ error: '처리 중 오류가 났습니다.', reason: '서버 오류' }, { status: 500 });
  }
}
