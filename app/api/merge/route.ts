import { checkAccess } from '@/lib/access';
import { LinerError, newBudget, serverKey } from '@/lib/liner';
import { mergeSentence, type MergeInput } from '@/lib/merge/run';
import type { MergeFix } from '@/lib/types';

export const dynamic = 'force-dynamic';

/** 문장 하나와 고칠 내용 몇 개라 이보다 클 수 없다 */
const MAX_BODY_CHARS = 20_000;
const MAX_SENTENCE_CHARS = 1000;
const MAX_FIXES = 12;
const FIX_KINDS: MergeFix['kind'][] = ['교정안', '인용형', '축소안'];

const short = (value: unknown, max: number) => (typeof value === 'string' ? value.trim().slice(0, max) : '');

function readInput(body: unknown): MergeInput | string {
  const b = body as { sentence?: unknown; fixes?: unknown } | null;
  // 문장은 원고에 적힌 그대로 받아야 한다. 수정안을 그 자리에 바꿔 넣기 때문에 다듬지 않는다
  if (typeof b?.sentence !== 'string' || !b.sentence.trim()) return '문장이 없습니다.';
  if (b.sentence.length > MAX_SENTENCE_CHARS) return '문장이 너무 깁니다.';
  if (!Array.isArray(b.fixes)) return '고칠 내용이 없습니다.';
  if (b.fixes.length > MAX_FIXES) return '고칠 내용이 너무 많습니다.';

  const fixes: MergeFix[] = [];
  const seen = new Set<string>();
  for (const item of b.fixes as Array<Record<string, unknown>>) {
    const claimId = short(item?.claimId, 24);
    const instruction = short(item?.instruction, 200);
    if (!/^[\w-]+$/.test(claimId) || seen.has(claimId)) return '고칠 내용의 명제 번호가 맞지 않습니다.';
    if (!FIX_KINDS.includes(item?.kind as MergeFix['kind'])) return '고칠 내용의 종류가 맞지 않습니다.';
    if (!instruction) return '고칠 내용이 비어 있습니다.';
    seen.add(claimId);
    fixes.push({
      claimId,
      statement: short(item.statement, 400),
      kind: item.kind as MergeFix['kind'],
      instruction,
      sourceName: short(item.sourceName, 60),
    });
  }
  return { sentence: b.sentence, fixes };
}

// 수정안 합치기. 문장 하나와 그 문장에 걸린 고칠 내용을 받아, 바뀐 대목과 고친 문장을 돌려준다.
export async function POST(request: Request) {
  const denied = checkAccess(request);
  if (denied) return denied;

  let input: MergeInput | string;
  try {
    const text = await request.text();
    input = text.length > MAX_BODY_CHARS ? '요청이 너무 큽니다.' : readInput(JSON.parse(text));
  } catch {
    input = '요청의 형식이 맞지 않습니다.';
  }
  if (typeof input === 'string') return Response.json({ error: input }, { status: 400 });

  try {
    const { revision, usage } = await mergeSentence(input, serverKey(), newBudget());
    return Response.json({ revision, usage });
  } catch (e) {
    if (e instanceof LinerError) {
      // 잘린 응답이나 형식이 깨진 응답은 성공으로 처리하지 않는다
      return Response.json({ error: '모델 응답 오류', reason: e.kind }, { status: e.kind === '키 없음' ? 500 : 502 });
    }
    return Response.json({ error: '처리 중 오류가 났습니다.', reason: '서버 오류' }, { status: 500 });
  }
}
