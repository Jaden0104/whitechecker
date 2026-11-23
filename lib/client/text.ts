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

export interface DiffPiece {
  kind: 'same' | 'removed' | 'added';
  text: string;
  bold: boolean;
  link: boolean;
}

/** 견줄 때의 단위: 빈칸, 숫자, 영문 낱말, 한글 낱말, 그 밖의 기호 하나 */
const UNITS = /\s+|\d+(?:[.,]\d+)*|[A-Za-z]+|[가-힣]+|[^\s\dA-Za-z가-힣]/g;

function styledUnits(source: string): Array<{ text: string; bold: boolean; link: boolean }> {
  const out: Array<{ text: string; bold: boolean; link: boolean }> = [];
  for (const run of inlineRuns(source)) for (const text of run.text.match(UNITS) ?? []) out.push({ text, bold: run.bold, link: run.link });
  return out;
}

/**
 * 두 문장을 숫자와 낱말 단위로 견줘, 같은 곳과 뺀 곳과 넣은 곳을 차례로 돌려준다.
 * 편집자가 고쳐 쓴 문장처럼 '어느 대목을 바꿨는지'를 따로 받지 못한 글에 쓴다.
 * 굵은 글씨와 링크의 표시(**, [글](주소))는 감춘 채로 견주고, 조각마다 모양만 알려 준다.
 */
export function diffPieces(before: string, after: string): DiffPiece[] {
  const a = styledUnits(before);
  const b = styledUnits(after);
  const n = a.length;
  const m = b.length;
  // 가장 긴 공통 부분열의 길이를 뒤에서부터 채운다
  const table: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let k = m - 1; k >= 0; k -= 1) table[i][k] = a[i].text === b[k].text ? table[i + 1][k + 1] + 1 : Math.max(table[i + 1][k], table[i][k + 1]);
  }
  const pieces: DiffPiece[] = [];
  const push = (kind: DiffPiece['kind'], unit: { text: string; bold: boolean; link: boolean }) => {
    const last = pieces[pieces.length - 1];
    if (last && last.kind === kind && last.bold === unit.bold && last.link === unit.link) last.text += unit.text;
    else pieces.push({ kind, ...unit });
  };
  let i = 0;
  let k = 0;
  while (i < n || k < m) {
    if (i < n && k < m && a[i].text === b[k].text) {
      push('same', b[k]);
      i += 1;
      k += 1;
    } else if (i < n && (k === m || table[i + 1][k] >= table[i][k + 1])) {
      push('removed', a[i]);
      i += 1;
    } else {
      push('added', b[k]);
      k += 1;
    }
  }
  return pieces;
}

/**
 * 같은 문장에서 나온 명제들의 앞뒤로 겹치는 말의 길이.
 * 겹치는 말을 흐리게 적으면 명제마다 다른 대목(세로 311cm, 가로 223cm)이 눈에 들어온다.
 */
export function sharedEnds(statements: string[]): { head: number; tail: number } {
  if (statements.length < 2) return { head: 0, tail: 0 };
  const first = statements[0];
  const shortest = Math.min(...statements.map((s) => s.length));
  let head = 0;
  while (head < shortest && statements.every((s) => s[head] === first[head])) head += 1;
  // 낱말 한가운데에서 끊지 않게 앞쪽 빈칸까지 물린다
  while (head > 0 && first[head - 1] !== ' ') head -= 1;
  let tail = 0;
  while (tail < shortest - head && statements.every((s) => s[s.length - 1 - tail] === first[first.length - 1 - tail])) tail += 1;
  // 숫자 뒤의 단위(cm, % 등)는 흐리게 하지 않고 숫자에 붙여 둔다
  if (tail > 0 && /\d/.test(first[first.length - tail - 1] ?? '')) {
    tail -= (first.slice(first.length - tail).match(/^[A-Za-z%㎝㎜㎞℃]+/) ?? [''])[0].length;
  }
  return { head, tail };
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

/** 앞말에 붙일 '로'나 '으로'를 고른다. 받침이 없거나 ㄹ받침이면 '로'다(예: '일치'로, '근거 부족'으로) */
export function roParticle(word: string): string {
  const code = word.charCodeAt(word.length - 1) - 0xac00;
  if (Number.isNaN(code) || code < 0 || code > 11171) return '로';
  const final = code % 28;
  return final === 0 || final === 8 ? '로' : '으로';
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
