// 화면에 글을 보일 때 쓰는 계산. 문장의 굵은 글씨와 링크, 고친 대목의 표시, 근거에서 인용문이 놓인 자리.
// 글자를 태그로 바꿔 끼우지 않고 '어디부터 어디까지가 무엇인지'만 계산해 돌려준다. 그리는 일은 화면이 한다.

export interface TextRun {
  text: string;
  bold: boolean;
  link: boolean;
  /** 고친 대목(원문에서는 뺀 곳, 수정안에서는 넣은 곳) */
  mark: boolean;
}

/**
 * 원고에 적힌 꼴의 문장을 화면용 조각으로 나눈다. 굵은 글씨(**)와 링크([글](주소))의 표시는 감추고,
 * marks로 받은 범위는 고친 대목으로 표시한다. 표시가 굵은 글씨 안쪽이나 걸친 자리에 있어도 된다.
 */
export function inlineRuns(source: string, marks: Array<[number, number]> = []): TextRun[] {
  const n = source.length;
  const hidden = new Uint8Array(n);
  const bold = new Uint8Array(n);
  const link = new Uint8Array(n);
  const mark = new Uint8Array(n);
  for (const m of source.matchAll(/\*\*(.+?)\*\*/g)) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    hidden[start] = hidden[start + 1] = hidden[end - 1] = hidden[end - 2] = 1;
    for (let i = start + 2; i < end - 2; i += 1) bold[i] = 1;
  }
  for (const m of source.matchAll(/\[([^\]]+)\]\(([^)]+)\)/g)) {
    const start = m.index ?? 0;
    const textEnd = start + 1 + m[1].length;
    hidden[start] = 1;
    for (let i = start + 1; i < textEnd; i += 1) link[i] = 1;
    for (let i = textEnd; i < start + m[0].length; i += 1) hidden[i] = 1;
  }
  for (const [from, to] of marks) for (let i = Math.max(0, from); i < Math.min(n, to); i += 1) mark[i] = 1;

  const runs: TextRun[] = [];
  for (let i = 0; i < n; i += 1) {
    if (hidden[i]) continue;
    const last = runs[runs.length - 1];
    if (last && last.bold === Boolean(bold[i]) && last.link === Boolean(link[i]) && last.mark === Boolean(mark[i])) last.text += source[i];
    else runs.push({ text: source[i], bold: Boolean(bold[i]), link: Boolean(link[i]), mark: Boolean(mark[i]) });
  }
  return runs;
}

/**
 * 수정안에서 바뀐 대목이 원문과 수정안의 어디에 있는지 찾는다.
 * 수정안은 원문에서 그 대목만 바꿔 만든 것이라, 앞에서부터 길이의 차이를 더해 가면 자리가 나온다.
 * 다듬기 검사로 글이 조금 달라졌으면 그 자리에 없을 수 있다. 그때는 수정안에서 그 글을 찾아본다.
 */
export function editRanges(
  source: string,
  revised: string,
  edits: Array<{ before: string; after: string }>,
): { removed: Array<[number, number]>; added: Array<[number, number]> } {
  const placed = edits
    .map((e) => ({ ...e, at: e.before ? source.indexOf(e.before) : -1 }))
    .filter((e) => e.at >= 0)
    .sort((a, b) => a.at - b.at);
  const removed: Array<[number, number]> = [];
  const added: Array<[number, number]> = [];
  let shift = 0;
  for (const e of placed) {
    removed.push([e.at, e.at + e.before.length]);
    const expected = e.at + shift;
    shift += e.after.length - e.before.length;
    if (!e.after) continue;
    const at = revised.startsWith(e.after, expected) ? expected : revised.indexOf(e.after);
    if (at >= 0) added.push([at, at + e.after.length]);
  }
  return { removed, added };
}

/** 근거 발췌에서 인용문과 그 앞뒤 문맥을 잘라 낸다. 띄어쓰기만 다른 인용문도 찾는다 */
export function quoteContext(excerpt: string, quote: string, around = 70): { before: string; quote: string; after: string; found: boolean } {
  let start = quote ? excerpt.indexOf(quote) : -1;
  let end = start >= 0 ? start + quote.length : -1;
  if (start < 0 && quote) {
    // 공백과 표의 칸 구분을 빼고 견준다. 찾으면 원래 글의 자리로 되돌린다
    const skip = /[\s|]/;
    const map: number[] = [];
    let squeezed = '';
    for (let i = 0; i < excerpt.length; i += 1) {
      if (skip.test(excerpt[i])) continue;
      map.push(i);
      squeezed += excerpt[i];
    }
    const needle = quote.replace(/[\s|]+/g, '');
    const at = needle ? squeezed.indexOf(needle) : -1;
    if (at >= 0) {
      start = map[at];
      end = map[at + needle.length - 1] + 1;
    }
  }
  if (start < 0) return { before: '', quote, after: '', found: false };
  const tidy = (s: string) => s.replace(/\s+/g, ' ');
  const from = Math.max(0, start - around);
  const to = Math.min(excerpt.length, end + around);
  return {
    before: (from > 0 ? '…' : '') + tidy(excerpt.slice(from, start)),
    quote: excerpt.slice(start, end),
    after: tidy(excerpt.slice(end, to)) + (to < excerpt.length ? '…' : ''),
    found: true,
  };
}

/** 걸린 시간을 '1분 12초'처럼 적는다 */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes}분 ${seconds % 60}초` : `${seconds}초`;
}

/** 추정 비용을 달러로 적는다. 1센트보다 작으면 그렇게 적는다 */
export function formatDollars(dollars: number): string {
  if (dollars <= 0) return '0달러';
  return dollars < 0.01 ? '0.01달러 미만' : `약 ${dollars.toFixed(2)}달러`;
}
