// 수집한 본문에서 명제와 관련 있는 대목을 고른다.
// 고르는 것은 코드가 하고, 글자는 본문에서 그대로 잘라 낸다. 모델이 다시 쓰지 않는다.
import { STANDARD } from '../standard.ts';

/**
 * 낱말의 구실.
 * - 대상: 무엇에 관한 주장인지를 가리키는 낱말. 명제와 검색어에 모두 나온다(예: 천상열차분야지도)
 * - 기관: 검색어에만 들어 있는 기관 이름. 그 사이트의 모든 페이지에 나오므로 관련성을 가리는 데 약하다
 * - 속성: 확인하려는 값이나 속성을 가리키는 낱말(예: 세로, 관람시간, 1985)
 */
type Role = '대상' | '기관' | '속성';

export interface Keyword {
  /** 견줄 때 쓰는 꼴들. 조사가 붙은 낱말은 뒤를 한두 글자 덜어 낸 꼴도 함께 둔다 */
  forms: string[];
  weight: number;
  numeric: boolean;
  /** 명제 본문에서 나온 낱말인지(검색어에만 있는 낱말과 구분한다) */
  fromStatement: boolean;
  role: Role;
}

export interface PageExcerpts {
  excerpts: string[];
  /** 고른 대목이 이 명제가 묻는 속성까지 다루는지. 대상의 이름만 나오는 페이지는 false다 */
  direct: boolean;
}

const TOKEN = /\d[\d,.:]*\d|\d|[가-힣]+|[A-Za-z][A-Za-z0-9-]+|[一-鿿]+/g;
// 어디에나 나와서 관련성을 가리는 데 도움이 안 되는 낱말
const STOP = new Set([
  '있다', '있습니다', '있는', '입니다', '합니다', '됩니다', '했습니다', '됐습니다', '이다', '것이다', '것으로',
  '그리고', '그러나', '하지만', '또한', '대한', '위한', '통해', '관련', '따르면', '지금', '현재',
]);
const INSTITUTION_END =
  /(박물관|미술관|도서관|기념관|전시관|과학관|연구원|연구소|위원회|재단|공사|공단|은행|협회|학회|대학교|유산청|문화재청|통계청|시청|군청|구청|도청|관광부|진흥원|정보원|포털)$/;
const INSTITUTION_WORDS = new Set(
  STANDARD.domains.institutions.flatMap((i) => i.publisher.match(/[가-힣]{3,}/g) ?? []),
);
const WEIGHT: Record<Role, number> = { 속성: 1, 대상: 0.3, 기관: 0.2 };

function tokens(text: string): string[] {
  return text.match(TOKEN) ?? [];
}

function formsOf(token: string): { forms: string[]; numeric: boolean } | null {
  if (/^\d/.test(token)) {
    const plain = token.replace(/,/g, '').replace(/[.:]$/, '');
    // 한 자리 숫자는 어디에나 있어 쓰지 않는다
    if (plain.replace(/\D/g, '').length < 2) return null;
    return { forms: [plain], numeric: true };
  }
  if (/^[가-힣]/.test(token)) {
    if (token.length < 2 || STOP.has(token)) return null;
    const forms = [token];
    if (token.length >= 3) forms.push(token.slice(0, -1));
    if (token.length >= 4) forms.push(token.slice(0, -2));
    return { forms, numeric: false };
  }
  if (/^[A-Za-z]/.test(token)) return token.length >= 3 ? { forms: [token.toLowerCase()], numeric: false } : null;
  return token.length >= 2 ? { forms: [token], numeric: false } : null;
}

/**
 * 명제와 검색어에서 견줄 낱말을 뽑고 구실을 나눈다.
 * @param basicQueries 기본 검색어. 명제와 이 검색어들에 모두 나오는 낱말을 '대상'으로 본다
 * @param otherQueries 반증 검색어 등
 */
export function claimKeywords(statement: string, basicQueries: string[], otherQueries: string[] = []): Keyword[] {
  const queryTokens = basicQueries.map((q) => tokens(q));
  const inEveryQuery = (forms: string[]) =>
    queryTokens.length > 0 &&
    queryTokens.every((list) => list.some((t) => forms.some((f) => t.includes(f)) || (t.length >= 2 && forms[0].includes(t))));

  const out = new Map<string, Keyword>();
  const add = (text: string, fromStatement: boolean) => {
    for (const token of tokens(text)) {
      const made = formsOf(token);
      if (!made) continue;
      // 조사만 다른 같은 낱말(각석의, 각석)은 먼저 들어온 것 하나로 본다
      const same = [...out.values()].some((k) => k.forms.includes(made.forms[0]) || made.forms.includes(k.forms[0]));
      if (same) continue;
      let role: Role = '속성';
      if (fromStatement && inEveryQuery(made.forms)) role = '대상';
      else if (!fromStatement && !made.numeric && (INSTITUTION_END.test(token) || INSTITUTION_WORDS.has(token))) role = '기관';
      // 검색어에만 있는 낱말은 조금 낮게 친다
      const weight = WEIGHT[role] * (fromStatement ? 1 : 0.8);
      out.set(made.forms[0], { ...made, weight, fromStatement, role });
    }
  };
  add(statement, true);
  for (const query of [...basicQueries, ...otherQueries]) add(query, false);
  return [...out.values()];
}

/** 낱말이 그 글에 있으면 0보다 큰 값(온전한 꼴이면 1, 덜어 낸 꼴이면 그보다 작게) */
function matchStrength(keyword: Keyword, lower: string, plainNumbers: string): number {
  if (keyword.numeric) {
    const form = keyword.forms[0];
    for (let i = plainNumbers.indexOf(form); i >= 0; i = plainNumbers.indexOf(form, i + 1)) {
      // 더 긴 숫자의 일부로 들어 있는 것은 치지 않는다
      if (!/\d/.test(plainNumbers[i - 1] ?? '') && !/\d/.test(plainNumbers[i + form.length] ?? '')) return 1;
    }
    return 0;
  }
  const full = keyword.forms[0].length;
  for (const form of keyword.forms) {
    if (lower.includes(form)) return Math.max(0.5, form.length / full);
  }
  return 0;
}

interface Segment {
  text: string;
  lower: string;
  plainNumbers: string;
}

const SEGMENT_MAX = 280;
const WINDOW_MAX = 600;
/** 대목 하나를 이 길이쯤까지 넓힌다 */
const WINDOW_TARGET = 450;
/** 통째로 싣는 페이지를 근거 하나로 끊는 길이 */
const PIECE_MAX = 700;

const lowerOf = (text: string) => text.toLowerCase();
const numbersOf = (lower: string) => lower.replace(/(\d),(?=\d{3})/g, '$1');

function toSegments(blocks: string[]): Segment[] {
  const splitter = new Intl.Segmenter('ko', { granularity: 'sentence' });
  const out: Segment[] = [];
  const push = (text: string) => {
    const t = text.trim();
    if (!t) return;
    const lower = lowerOf(t);
    out.push({ text: t, lower, plainNumbers: numbersOf(lower) });
  };
  for (const block of blocks) {
    if (block.length <= SEGMENT_MAX) {
      push(block);
      continue;
    }
    for (const part of splitter.segment(block)) {
      // 문장 하나가 아주 길면 그대로 잘라서 넣는다
      for (let i = 0; i < part.segment.length; i += WINDOW_MAX) push(part.segment.slice(i, i + WINDOW_MAX));
    }
  }
  return out;
}

/** 고른 대목이 명제가 묻는 속성까지 다루는지: 명제의 속성 낱말이 하나라도 있거나, 속성 낱말이 둘 이상 있다 */
function isDirect(keywords: Keyword[], texts: string[]): boolean {
  const lower = lowerOf(texts.join('\n'));
  const numbers = numbersOf(lower);
  const found = (k: Keyword) => matchStrength(k, lower, numbers) > 0;
  const own = keywords.filter((k) => k.fromStatement);
  // 명제의 낱말이 모두 검색어에도 들어 있어 속성 낱말이 따로 없으면, 명제의 낱말이 대부분 나오는지로 본다
  if (!own.some((k) => k.role === '속성')) return own.filter(found).length >= Math.max(2, Math.ceil(own.length * 0.6));
  const hit = keywords.filter((k) => k.role === '속성' && found(k));
  return hit.some((k) => k.fromStatement) || hit.length >= 2;
}

/**
 * 검색 결과의 제목과 요약이 명제와 얼마나 겹치는지. 어느 페이지를 먼저 열지 정하는 데만 쓴다.
 * 같은 사이트에서 제목이 같은 페이지가 여럿 나올 때 맞는 것을 고르는 데 도움이 된다
 */
export function textRelevance(keywords: Keyword[], text: string): number {
  const lower = lowerOf(text);
  const numbers = numbersOf(lower);
  let score = 0;
  for (const k of keywords) {
    if (k.role !== '기관') score += k.weight * matchStrength(k, lower, numbers);
  }
  return Math.round(score * 10) / 10;
}

/**
 * 페이지 하나에서 발췌를 고른다.
 * 짧은 페이지는 관련 있는 범위를 통째로 싣고, 긴 페이지는 낱말이 겹치는 대목과 그 앞뒤를 싣는다.
 * @param budget 이 페이지에서 쓸 수 있는 글자 수
 */
export function pickExcerpts(blocks: string[], keywords: Keyword[], budget: number): PageExcerpts {
  const segments = toSegments(blocks);
  const n = segments.length;
  if (n === 0 || keywords.length === 0) return { excerpts: [], direct: false };

  const strength: number[][] = keywords.map((k) => segments.map((s) => matchStrength(k, s.lower, s.plainNumbers)));
  const hitsAt = (i: number) => keywords.filter((_, j) => strength[j][i] > 0);
  const anyHit = segments.map((_, i) => hitsAt(i).length > 0);
  const distinct = keywords.filter((_, j) => strength[j].some((v) => v > 0));
  // 낱말이 둘도 걸리지 않는 페이지는 이 명제와 상관없는 것으로 본다
  if (distinct.length < 2 && !distinct.some((k) => k.fromStatement && k.role === '속성')) return { excerpts: [], direct: false };

  // 1. 짧은 페이지: 낱말이 처음 나온 줄부터 마지막으로 나온 줄까지(앞뒤 두 줄 포함) 그대로 싣는다.
  //    공식 안내 페이지는 대개 짧고, 값이 든 줄에 명제의 낱말이 없을 때가 많아 골라내면 놓치기 쉽다.
  //    시작은 대상이나 속성 낱말이 처음 제대로 나온 줄로 잡는다(메뉴의 짧은 줄이나 기관 이름만 나온 줄은 건너뛴다).
  const anchors = segments.map((s, i) => {
    const own = hitsAt(i).filter((k) => k.role !== '기관');
    return own.length >= 2 || (own.length === 1 && s.text.length >= 20);
  });
  const firstHit = anchors.includes(true) ? anchors.indexOf(true) : anyHit.indexOf(true);
  const lastHit = anyHit.lastIndexOf(true);
  const from = Math.max(0, firstHit - 2);
  const sizeOf = (list: Segment[]) => list.reduce((sum, s) => sum + s.text.length, 0);
  // 끝은 낱말이 마지막으로 나온 줄 뒤로, 글이 이어지는 동안 더 싣는다(설명문이 뒤따르는 경우가 많다).
  // 짧은 줄이 세 줄 잇따르면 꼬리말이나 메뉴로 보고 거기서 멈춘다
  let to = lastHit;
  let shortRun = 0;
  for (let i = lastHit + 1; i < n && shortRun < 3; i += 1) {
    if (segments[i].text.length < 20) shortRun += 1;
    else {
      shortRun = 0;
      to = i;
    }
  }
  let span = segments.slice(from, to + 1);
  if (sizeOf(span) > budget) span = segments.slice(from, Math.min(n - 1, lastHit + 2) + 1);
  if (sizeOf(span) <= budget) {
    const pieces: string[] = [];
    let piece = '';
    for (const s of span) {
      if (piece && piece.length + s.text.length > PIECE_MAX) {
        pieces.push(piece);
        piece = '';
      }
      piece += (piece ? '\n' : '') + s.text;
    }
    if (piece) pieces.push(piece);
    return { excerpts: pieces, direct: isDirect(keywords, pieces) };
  }

  // 2. 긴 페이지: 페이지 곳곳에 나오는 낱말은 낮게, 드문 낱말은 높게 쳐서 대목을 고른다
  const idf = strength.map((row) => {
    const df = row.filter((v) => v > 0).length;
    return df === 0 ? 0 : Math.log(1 + n / df);
  });
  const scored = segments.map((segment, i) => {
    let score = 0;
    let hits = 0;
    let property = 0;
    keywords.forEach((k, j) => {
      const v = strength[j][i];
      if (v <= 0) return;
      hits += 1;
      if (k.role === '속성') property += 1;
      score += k.weight * v * idf[j];
    });
    return { i, score, hits, property, long: segment.text.length >= 6 };
  });

  // 속성 낱말이 걸린 대목을 씨앗으로 삼는다. 그런 대목이 없으면 대상의 이름이 나오는 대목 둘까지만 싣는다
  let seeds = scored.filter((s) => s.long && s.property >= 1 && s.hits >= 2).sort((a, b) => b.score - a.score);
  let maxWindows = 6;
  if (seeds.length === 0) {
    seeds = scored.filter((s) => s.long && s.hits >= 2).sort((a, b) => b.score - a.score);
    maxWindows = 2;
  }
  const floor = seeds.length ? seeds[0].score * 0.3 : 0;

  const taken = new Array<boolean>(n).fill(false);
  const windows: Array<{ from: number; to: number }> = [];
  let used = 0;
  for (const seed of seeds) {
    if (windows.length >= maxWindows || used >= budget) break;
    if (seed.score < floor || taken[seed.i]) continue;
    let start = seed.i;
    let end = seed.i;
    let size = segments[seed.i].text.length;
    // 앞뒤 대목을 번갈아 붙여 문맥을 둔다. 앞쪽(제목이나 항목 이름)을 먼저 붙인다.
    // 표처럼 줄이 짧은 곳에서도 문맥이 충분하도록 줄 수가 아니라 글자 수를 기준으로 넓힌다
    let before = true;
    let after = true;
    for (let step = 0; step < 16 && size < WINDOW_TARGET && (before || after); step += 1) {
      const back = step % 2 === 0 ? before : !after;
      const j = back ? start - 1 : end + 1;
      const blocked = j < 0 || j >= n || taken[j] || size + segments[j].text.length > WINDOW_MAX;
      if (blocked) {
        if (back) before = false;
        else after = false;
        continue;
      }
      if (back) start = j;
      else end = j;
      size += segments[j].text.length;
    }
    if (used + size > budget && windows.length > 0) continue;
    for (let j = start; j <= end; j += 1) taken[j] = true;
    windows.push({ from: start, to: end });
    used += size;
  }
  if (windows.length === 0) return { excerpts: [], direct: false };

  // 글의 첫 문단에는 핵심 사실이 모여 있는 일이 많다. 자리가 남으면 넣는다
  const lead = segments.findIndex((s, i) => i < 40 && s.text.length >= 80);
  if (lead >= 0 && !taken[lead] && used + segments[lead].text.length <= budget) {
    taken[lead] = true;
    windows.push({ from: lead, to: lead });
  }

  // 맞닿은 대목은 하나로 잇고, 본문에 나온 순서로 둔다
  windows.sort((a, b) => a.from - b.from);
  const merged: typeof windows = [];
  for (const w of windows) {
    const last = merged[merged.length - 1];
    if (last && w.from <= last.to + 1) last.to = Math.max(last.to, w.to);
    else merged.push({ ...w });
  }
  const excerpts = merged.map((w) =>
    segments
      .slice(w.from, w.to + 1)
      .map((s) => s.text)
      .join('\n'),
  );
  return { excerpts, direct: isDirect(keywords, excerpts) };
}
