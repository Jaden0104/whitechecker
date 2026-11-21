// 추출 요청을 나누는 방법. 문단을 쪼개지 않고, 한 묶음의 글자 수가 한도를 넘지 않게 묶는다.
import { LIMITS } from './limits.ts';
import type { ExtractInput } from './prompts/extract.ts';
import type { Sentence } from './types.ts';

/**
 * 그 문장의 바로 뒤에 이어지는 글(뒤 문맥). 다음 소제목 앞까지의 문장에서 앞부분만 돌려준다.
 * 지시어와 시점을 뒤 문장에서 밝히는 글("그해 겨울이었다. 1395년의 일이다.")을 풀 수 있게 하려는 것이다.
 * 처음 검증의 묶음과, 한 문장만 다시 검증할 때(F14)가 같은 규칙을 쓴다.
 */
export function followingText(sentences: Sentence[], sentenceId: number, maxChars: number = LIMITS.extract.afterChars): string {
  const following = sentences.filter((s) => s.id > sentenceId);
  const nextHeading = following.findIndex((s) => s.kind === 'heading');
  return (nextHeading < 0 ? following : following.slice(0, nextHeading))
    .map((s) => s.plain)
    .join(' ')
    .slice(0, maxChars);
}

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
  // 묶음마다 바로 뒤에 이어지는 글을 뒤 문맥으로 붙인다. 묶음의 끝에 놓인 문장은 같은 묶음 안에 뒤 문장이 없기 때문이다.
  // 긴 문단이 한가운데서 끊긴 묶음에서 특히 필요하다. 뒤에 글이 없거나 바로 소제목이 오면 붙이지 않는다
  for (const chunk of chunks) {
    const after = followingText(sentences, chunk.sentences[chunk.sentences.length - 1].id);
    if (after) chunk.after = after;
  }
  return chunks;
}
