// 추출 요청을 나누는 방법. 문단을 쪼개지 않고, 한 묶음의 글자 수가 한도를 넘지 않게 묶는다.
import { LIMITS } from './limits.ts';
import type { ExtractInput } from './prompts/extract.ts';
import type { Sentence } from './types.ts';

export function buildExtractChunks(sentences: Sentence[], maxChars: number = LIMITS.extract.inputChars): ExtractInput[] {
  const title = sentences.find((s) => s.kind === 'heading')?.plain ?? '';
  const chunks: ExtractInput[] = [];
  let current: Sentence[] = [];
  let size = 0;
  let previousBlockText = '';

  const flush = () => {
    if (current.length === 0) return;
    chunks.push({
      title,
      context: previousBlockText.slice(-LIMITS.extract.contextChars),
      sentences: current.map((s) => ({ id: s.id, text: s.plain })),
    });
    // 다음 묶음의 앞 문맥은 방금 보낸 묶음의 끝부분이다
    previousBlockText = current.map((s) => s.plain).join(' ');
    current = [];
    size = 0;
  };

  // 문단 단위로 모은다
  const blocks = new Map<number, Sentence[]>();
  for (const s of sentences) blocks.set(s.block, [...(blocks.get(s.block) ?? []), s]);

  for (const block of blocks.values()) {
    const blockSize = block.reduce((n, s) => n + s.plain.length, 0);
    if (size > 0 && size + blockSize > maxChars) flush();
    if (blockSize > maxChars) {
      // 한 문단이 한도보다 길면 문장 단위로 끊는다
      for (const s of block) {
        if (size > 0 && size + s.plain.length > maxChars) flush();
        current.push(s);
        size += s.plain.length;
      }
    } else {
      current.push(...block);
      size += blockSize;
    }
  }
  flush();
  return chunks;
}
