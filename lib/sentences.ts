// 원고(Markdown)를 문장으로 나누고, 문장마다 원고 안의 위치를 기록한다.
// 위치는 내보낼 때 그 자리의 글자만 바꾸는 데 쓴다. 구문 분석은 검증된 라이브러리에 맡긴다.
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';
import type { Nodes, Paragraph, Parent } from 'mdast';
import type { BlockKind, Sentence } from './types.ts';

const segmenter = new Intl.Segmenter('ko', { granularity: 'sentence' });

const LINK_TYPES = new Set(['link', 'linkReference', 'image', 'imageReference', 'footnoteReference']);
const EMPHASIS_TYPES = new Set(['emphasis', 'strong', 'delete', 'inlineCode']);

interface Range {
  type: string;
  start: number;
  end: number;
}

/** 원고 글자에서 만든 식별값. 원고 버전과 문장 버전을 견주는 데 쓴다 */
export function contentId(text: string): string {
  // cyrb53: 빠르고 고르게 퍼지는 53비트 해시. 보안용이 아니라 같은 글인지 가리는 용도다
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const hash = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  return `${text.length.toString(36)}-${hash.toString(36)}`;
}

/** Markdown 표시를 걷어 낸 글을 만든다 */
export function stripMarkup(source: string): string {
  return source
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\[\^[^\]]+\]/g, '')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(\*|_)(.+?)\1/g, '$2')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function collectInline(node: Nodes, out: Range[]): void {
  if ((LINK_TYPES.has(node.type) || EMPHASIS_TYPES.has(node.type)) && node.position) {
    out.push({ type: node.type, start: node.position.start.offset ?? 0, end: node.position.end.offset ?? 0 });
  }
  if ('children' in node) for (const child of (node as Parent).children) collectInline(child as Nodes, out);
}

export function splitManuscript(text: string): Sentence[] {
  const tree = fromMarkdown(text, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
  const sentences: Sentence[] = [];
  let block = 0;

  const add = (start: number, end: number, kind: BlockKind, inline: Range[], plainOverride?: string) => {
    // 앞뒤 공백을 덜어 낸다
    while (start < end && /\s/.test(text[start])) start += 1;
    while (end > start && /\s/.test(text[end - 1])) end -= 1;
    if (end <= start) return;
    const source = text.slice(start, end);
    const touching = inline.filter((r) => r.start < end && r.end > start);
    const hasLinkOrFootnote = touching.some((r) => LINK_TYPES.has(r.type));
    const hasEmphasis = touching.some((r) => EMPHASIS_TYPES.has(r.type));
    const plain = plainOverride ?? stripMarkup(source);
    if (!plain) return;
    sentences.push({
      id: sentences.length + 1,
      start,
      end,
      source,
      plain,
      kind,
      block,
      hasLinkOrFootnote,
      hasEmphasis,
      autoApply: (kind === 'heading' || kind === 'paragraph' || kind === 'listItem') && !hasLinkOrFootnote,
    });
  };

  const addParagraph = (node: Paragraph, kind: BlockKind) => {
    if (!node.position) return;
    block += 1;
    const a = node.position.start.offset ?? 0;
    const b = node.position.end.offset ?? 0;
    const inline: Range[] = [];
    collectInline(node, inline);

    // 그림만 있는 문단은 그림 설명으로 다룬다
    if (node.children.length === 1 && node.children[0].type === 'image') {
      add(a, b, 'caption', inline, node.children[0].alt ?? '');
      return;
    }

    const slice = text.slice(a, b);
    const cuts: number[] = [];
    for (const seg of segmenter.segment(slice)) {
      const boundary = a + seg.index + seg.segment.length;
      if (boundary >= b) continue;
      // 사이에 공백이 없이 끊긴 곳(예: 했다."라고)은 문장의 끝이 아니다
      if (!/\s$/.test(seg.segment)) continue;
      // 링크나 강조 표시의 한가운데에서는 끊지 않는다
      if (inline.some((r) => r.start < boundary && boundary < r.end)) continue;
      cuts.push(boundary);
    }
    let from = a;
    for (const cut of [...cuts, b]) {
      add(from, cut, kind, inline);
      from = cut;
    }
  };

  const walk = (node: Nodes, kind: BlockKind) => {
    switch (node.type) {
      case 'heading': {
        if (!node.position || node.children.length === 0) return;
        block += 1;
        const first = node.children[0].position;
        const last = node.children[node.children.length - 1].position;
        const inline: Range[] = [];
        collectInline(node, inline);
        add(first?.start.offset ?? 0, last?.end.offset ?? 0, 'heading', inline);
        return;
      }
      case 'paragraph':
        addParagraph(node, kind);
        return;
      case 'list':
        for (const item of node.children) for (const child of item.children) walk(child, 'listItem');
        return;
      case 'blockquote':
        for (const child of node.children) walk(child, kind);
        return;
      case 'table':
        for (const row of node.children) {
          if (!row.position) continue;
          block += 1;
          const cells = row.children.map((cell) =>
            stripMarkup(text.slice(cell.position?.start.offset ?? 0, cell.position?.end.offset ?? 0).replace(/^\||\|$/g, '')),
          );
          add(row.position.start.offset ?? 0, row.position.end.offset ?? 0, 'table', [], cells.filter(Boolean).join(' | '));
        }
        return;
      case 'footnoteDefinition':
        for (const child of node.children) walk(child, 'footnote');
        return;
      case 'root':
        for (const child of node.children) walk(child, 'paragraph');
        return;
      default:
        // 코드 블록, 구분선, HTML 등은 검증 대상이 아니다
        return;
    }
  };

  walk(tree, 'paragraph');
  return sentences;
}
