// 문장의 수정안을 코드가 만들고 검사한다(PRD F7). 이 파일의 함수는 Liner를 부르지 않고, 화면에서도 같이 쓴다.
// 모델은 '어느 대목을 무엇으로 바꿀지'만 낸다. 문장은 코드가 그 대목만 바꿔서 만든다.
// 그래서 고치기로 한 대목 밖의 글자는 원문 그대로 남는다.
import type { MergeFix, RevisionChanges } from '../types.ts';

/** 모델이 낸 수정 하나. claims는 고칠 내용의 번호(1부터) */
export interface ModelEdit {
  claims: number[];
  before: string;
  after: string;
}

/** 모델이 돌려주는 답의 모양 */
export interface ModelMerge {
  edits: ModelEdit[];
  skipped: Array<{ claim: number; why: string }>;
}

export interface AppliedEdits {
  /** 고친 문장. 반영한 것이 없으면 null */
  revised: string | null;
  /** 실제로 바꾼 대목 */
  edits: Array<{ before: string; after: string; claims: number[] }>;
  /** 반영한 고칠 내용의 번호(1부터) */
  applied: number[];
  skipped: Array<{ claim: number; why: string }>;
}

/** 바꿔 넣을 글 하나의 길이 한도. 문장 하나를 통째로 바꾸는 경우까지 받는다 */
const MAX_AFTER_CHARS = 1200;
/** 축소안에서 조사를 맞추느라 새로 들어갈 수 있는 글자 수 */
const REMOVAL_SLACK_CHARS = 2;

/** 두 글에 순서대로 함께 들어 있는 글자의 수(가장 긴 공통 부분열의 길이) */
function commonLength(a: string, b: string): number {
  let previous = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    const current = new Array<number>(b.length + 1).fill(0);
    for (let k = 1; k <= b.length; k += 1) {
      current[k] = a[i - 1] === b[k - 1] ? previous[k - 1] + 1 : Math.max(previous[k], current[k - 1]);
    }
    previous = current;
  }
  return previous[b.length];
}

/**
 * 빼기만 한 수정인지. 바꿔 넣은 글이 원래 대목보다 짧고, 원래 대목에 없던 글자가 거의 없어야 한다.
 * 축소안은 확인되지 않은 부분을 빼는 것이다. 다른 말로 바꿔 넣으면 새 주장이 생긴다.
 */
export function removalOnly(before: string, after: string): boolean {
  if (after.length >= before.length) return false;
  return after.length - commonLength(before, after) <= REMOVAL_SLACK_CHARS;
}

/**
 * 모델이 낸 수정을 원문에 적용한다. 받아들이는 조건은 코드가 정한다.
 * - 바꿀 대목은 원문에 글자 그대로, 한 번만 나와야 한다. 아니면 그 수정은 반영하지 않는다
 * - 축소안만 반영하는 수정은 빼기만 해야 한다. 새 말을 넣었으면 반영하지 않는다
 * - 수정끼리 대목이 겹치면 어느 쪽도 반영하지 않는다
 * - 반영하지 못한 고칠 내용은 까닭과 함께 돌려준다
 * @param kinds 고칠 내용의 종류. 순서는 고칠 내용의 번호와 같다
 */
export function applyEdits(source: string, model: ModelMerge, kinds: string[]): AppliedEdits {
  const fixCount = kinds.length;
  const valid = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 1 && (n as number) <= fixCount;
  const why = new Map<number, string>();
  const skip = (claims: number[], reason: string) => {
    for (const c of claims) if (!why.has(c)) why.set(c, reason);
  };

  type Placed = { start: number; end: number; before: string; after: string; claims: number[] };
  const placed: Placed[] = [];
  for (const edit of Array.isArray(model?.edits) ? model.edits : []) {
    const claims = [...new Set((Array.isArray(edit?.claims) ? edit.claims : []).filter(valid))];
    if (claims.length === 0) continue;
    const before = typeof edit.before === 'string' ? edit.before : '';
    const after = typeof edit.after === 'string' ? edit.after : '';
    if (!before) {
      skip(claims, '바꿀 대목이 비어 있다');
      continue;
    }
    if (before === after) {
      skip(claims, '바꾼 것이 없다');
      continue;
    }
    if (/[\r\n]/.test(after) || after.length > MAX_AFTER_CHARS) {
      skip(claims, '바꿔 넣을 글이 한 줄이 아니거나 너무 길다');
      continue;
    }
    const start = source.indexOf(before);
    if (start < 0) {
      skip(claims, '바꿀 대목이 원문에 글자 그대로 있지 않다');
      continue;
    }
    if (source.indexOf(before, start + 1) >= 0) {
      skip(claims, '바꿀 대목이 문장에 두 번 이상 나와 자리를 정할 수 없다');
      continue;
    }
    if (claims.every((c) => kinds[c - 1] === '축소안') && !removalOnly(before, after)) {
      skip(claims, '축소안인데 원문에 없던 말을 넣었다');
      continue;
    }
    placed.push({ start, end: start + before.length, before, after, claims });
  }

  // 서로 겹치는 수정은 어느 쪽도 반영하지 않는다
  const clashed = new Set<Placed>();
  for (let i = 0; i < placed.length; i += 1) {
    for (let k = i + 1; k < placed.length; k += 1) {
      if (placed[i].start < placed[k].end && placed[k].start < placed[i].end) {
        clashed.add(placed[i]);
        clashed.add(placed[k]);
      }
    }
  }
  for (const p of clashed) skip(p.claims, '다른 수정과 대목이 겹친다');

  // 뒤에서부터 바꿔야 앞쪽 수정의 위치가 밀리지 않는다
  const usable = placed.filter((p) => !clashed.has(p)).sort((a, b) => b.start - a.start);
  let revised = source;
  for (const p of usable) revised = revised.slice(0, p.start) + p.after + revised.slice(p.end);
  // 대목을 빼면서 생긴 겹친 공백만 정리한다. 원문에 원래 있던 겹친 공백은 건드리지 않는다
  if (!/ {2,}/.test(source)) revised = revised.replace(/ {2,}/g, ' ');

  const changed = usable.length > 0 && revised !== source;
  const applied = changed ? [...new Set(usable.flatMap((p) => p.claims))].sort((a, b) => a - b) : [];
  for (const c of applied) why.delete(c);
  for (const s of Array.isArray(model?.skipped) ? model.skipped : []) {
    if (valid(s?.claim) && !applied.includes(s.claim) && !why.has(s.claim)) {
      why.set(s.claim, (typeof s.why === 'string' ? s.why.trim().slice(0, 120) : '') || '모델이 반영하지 않았다');
    }
  }
  for (let c = 1; c <= fixCount; c += 1) if (!applied.includes(c) && !why.has(c)) why.set(c, '모델이 반영하지 않았다');

  return {
    revised: changed ? revised : null,
    edits: changed ? usable.map((p) => ({ before: p.before, after: p.after, claims: p.claims })).reverse() : [],
    applied,
    skipped: [...why.entries()].sort((a, b) => a[0] - b[0]).map(([claim, reason]) => ({ claim, why: reason })),
  };
}

/** 글에 나온 숫자. 쉼표와 앞의 0은 덜어 내고, 점으로 이은 날짜(2007.01.22)는 따로따로 센다 */
export function numbersIn(text: string): string[] {
  const out: string[] = [];
  for (const token of text.match(/\d(?:[\d,]*\d)?(?:\.\d+)*/g) ?? []) {
    const parts = token.split('.');
    const pieces = parts.length > 2 ? parts : [token];
    for (const piece of pieces) out.push(piece.replace(/,/g, '').replace(/^0+(?=\d)/, ''));
  }
  return out;
}

const MARKUP = /\*{1,3}|_{1,3}|~~|`+|\[\^[^\]]+\]|\]\([^)]*\)|!?\[/g;

/** 강조, 링크, 각주 표시를 나온 순서대로 뽑는다. 원문과 수정안에서 이것이 같아야 표시가 그대로인 것이다 */
export function markupSignature(text: string): string[] {
  return text.match(MARKUP) ?? [];
}

/** 낱말(띄어 쓴 덩어리). 표시와 앞뒤 문장 부호는 덜어 낸다 */
function wordsIn(text: string): string[] {
  return text
    .replace(/\]\([^)]*\)/g, ' ')
    .replace(MARKUP, ' ')
    .split(/\s+/)
    .map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''))
    .filter(Boolean);
}

/** a에는 있고 b에는 없는 것(같은 것이 여러 번 나오면 개수까지 본다) */
function minus(a: string[], b: string[]): string[] {
  const left = [...b];
  const out: string[] = [];
  for (const item of a) {
    const at = left.indexOf(item);
    if (at >= 0) left.splice(at, 1);
    else out.push(item);
  }
  return out;
}

/** 원문과 수정안에서 달라진 숫자와 낱말 */
export function compareRevision(source: string, revised: string): RevisionChanges {
  const numbersBefore = numbersIn(source);
  const numbersAfter = numbersIn(revised);
  const wordsBefore = wordsIn(source);
  const wordsAfter = wordsIn(revised);
  return {
    numbersRemoved: minus(numbersBefore, numbersAfter),
    numbersAdded: minus(numbersAfter, numbersBefore),
    wordsRemoved: minus(wordsBefore, wordsAfter),
    wordsAdded: minus(wordsAfter, wordsBefore),
  };
}

/** 두 낱말이 같은 낱말인지 어림한다. 뒤에 붙은 조사나 어미가 달라도 앞부분이 같으면 같은 낱말로 본다 */
function sameWord(a: string, b: string): boolean {
  const shorter = Math.min(a.length, b.length);
  let common = 0;
  while (common < shorter && a[common] === b[common]) common += 1;
  return common >= Math.max(1, shorter - 1) && (shorter < 3 || common >= 2);
}

/** 다듬으면서 새로 생겨도 되는 낱말의 수. 말을 잇는 낱말이 한둘 들어가는 정도까지 받는다 */
const POLISH_ADDED_SLACK = 2;
/** 다듬으면서 사라져도 되는 낱말의 수. 내용이 빠지는 쪽은 더 좁게 본다 */
const POLISH_LOST_SLACK = 1;

/** 고칠 내용에 적힌 낱말인지 알려 주는 함수를 만든다. 조사나 어미가 달라진 것은 같은 낱말로 본다(휴관과 휴관합니다) */
function mentionedIn(told: string): (word: string) => boolean {
  // 고칠 내용은 따옴표로 값을 감싸 적는 일이 많다('휴관'으로). 글자와 숫자가 아닌 것에서 모두 끊는다
  const toldWords = told.split(/[^\p{L}\p{N}]+/u).filter((t) => t.length >= 2);
  return (word) =>
    [0, 1, 2].some((cut) => word.length - cut >= 2 && told.includes(word.slice(0, word.length - cut))) || toldWords.some((t) => sameWord(word, t));
}

export interface PolishContext {
  /** 원고의 원래 문장 */
  original: string;
  /** 수정으로 바꿔 넣은 대목들 */
  inserted: string[];
  /** 반영한 고칠 내용의 글 */
  instructions: string[];
}

/**
 * 다듬은 문장을 받아들여도 되는지 본다. 받아들일 수 없으면 그 까닭을, 받아들이면 빈 문자열을 돌려준다.
 * 다듬기는 조사, 어미, 어순만 손보는 것이다. 숫자와 표시는 그대로여야 하고, 낱말이 거의 그대로여야 한다.
 * 고칠 내용에 적혀 있던 말(고쳐 넣은 값과 이름)은 하나도 빠지면 안 된다.
 * 합칠 때 모델이 말을 잇느라 지어 넣은 낱말(원문에도 고칠 내용에도 없는 것)은 빠져도 된다.
 * @param draft 코드가 대목만 바꿔 만든 문장
 * @param polished 모델이 다듬은 문장
 */
export function acceptPolish(draft: string, polished: string, context: PolishContext): string {
  if (!polished.trim()) return '다듬은 문장이 비어 있다';
  if (/[\r\n]/.test(polished) && !/[\r\n]/.test(draft)) return '다듬은 문장에 줄바꿈이 생겼다';
  if (polished.length > draft.length * 1.3 + 10 || polished.length < draft.length * 0.7 - 10) return '다듬은 문장의 길이가 크게 달라졌다';

  const numbersBefore = [...numbersIn(draft)].sort();
  const numbersAfter = [...numbersIn(polished)].sort();
  if (numbersBefore.length !== numbersAfter.length || numbersBefore.some((n, i) => n !== numbersAfter[i])) return '다듬으면서 숫자가 달라졌다';

  const a = markupSignature(draft);
  const b = markupSignature(polished);
  if (a.length !== b.length || a.some((mark, i) => mark !== b[i])) return '다듬으면서 강조나 링크 표시가 달라졌다';

  // 숫자가 든 낱말은 위에서 봤다. 나머지 낱말을 견준다
  const plain = (text: string) => wordsIn(text).filter((w) => !/\d/.test(w));
  const before = plain(draft);
  const after = plain(polished);
  const fromOriginal = plain(context.original);
  const mentioned = mentionedIn(context.instructions.join(' '));
  const filler = (w: string) => !mentioned(w) && !fromOriginal.some((x) => sameWord(w, x));

  const added = after.filter((w) => !before.some((x) => sameWord(w, x)));
  const lost = before.filter((w) => !filler(w) && !after.some((x) => sameWord(w, x)));
  if (added.length > POLISH_ADDED_SLACK) return `다듬으면서 새 낱말이 들어갔다: ${added.join(', ')}`;
  if (lost.length > POLISH_LOST_SLACK) return `다듬으면서 낱말이 빠졌다: ${lost.join(', ')}`;

  // 고칠 내용에 적혀 있던 말은 하나도 빠지면 안 된다
  const must = context.inserted.flatMap(plain).filter(mentioned);
  const dropped = must.filter((w) => !after.some((x) => sameWord(w, x)));
  if (dropped.length > 0) return `다듬으면서 고쳐 넣은 말이 빠졌다: ${dropped.join(', ')}`;
  return '';
}

export interface RevisionReview {
  changes: RevisionChanges;
  cautions: string[];
  markupKept: boolean;
}

/**
 * 수정안을 원문과 견줘, 편집자가 봐야 할 것을 뽑는다.
 * @param fixes 반영한 고칠 내용
 * @param hedges 출처 없이 흐리는 말의 목록(검증 기준 파일)
 */
export function reviewRevision(source: string, revised: string, fixes: MergeFix[], hedges: string[]): RevisionReview {
  const changes = compareRevision(source, revised);
  const cautions: string[] = [];

  // 새로 들어간 숫자는 고칠 내용에 적힌 것이어야 한다. 시각을 적는 방식(17:30과 오후 5시 30분)의 차이는 같은 값으로 본다
  const allowed = new Set(fixes.flatMap((f) => numbersIn(f.instruction)));
  const known = (n: string) => {
    if (allowed.has(n)) return true;
    if (!/^\d+$/.test(n)) return false;
    return allowed.has(String(Number(n) + 12)) || allowed.has(String(Number(n) - 12));
  };
  const strange = [...new Set(changes.numbersAdded.filter((n) => !known(n)))];
  if (strange.length > 0) cautions.push(`고칠 내용에 적히지 않은 숫자가 들어갔다: ${strange.join(', ')}`);

  // 출처를 밝히는 인용형은 문장의 틀을 바꾸므로 아래 두 가지를 보지 않는다
  if (!fixes.some((f) => f.kind === '인용형')) {
    // 출처를 밝히지 않고 흐리는 말로 바꾸면 안 된다
    const hedged = hedges.filter((h) => h && revised.includes(h) && !source.includes(h));
    if (hedged.length > 0) cautions.push(`출처를 밝히지 않고 흐리는 말이 들어갔다: ${hedged.join(', ')}`);

    // 새로 들어간 낱말은 고칠 내용에 적힌 것이어야 한다. 숫자가 든 낱말은 위에서 봤다.
    // 원문에 있던 낱말을 한 번 더 쓴 것(문을 … 문을)은 새 낱말이 아니다
    const mentioned = mentionedIn(fixes.map((f) => f.instruction).join(' '));
    const sourceWords = wordsIn(source);
    const invented = [
      ...new Set(changes.wordsAdded.filter((w) => w.length >= 2 && !/\d/.test(w) && !mentioned(w) && !sourceWords.some((s) => sameWord(w, s)))),
    ];
    if (invented.length > 0) cautions.push(`고칠 내용에 적히지 않은 낱말이 들어갔다: ${invented.join(', ')}`);
  }

  const a = markupSignature(source);
  const b = markupSignature(revised);
  const markupKept = a.length === b.length && a.every((mark, i) => mark === b[i]);
  if (!markupKept) cautions.push('강조나 링크, 각주 표시가 원문과 달라졌다');

  return { changes, cautions, markupKept };
}
