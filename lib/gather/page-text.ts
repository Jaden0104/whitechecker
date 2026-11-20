// HTML에서 본문 글을 줄 단위로 뽑는다. 글자는 고치지 않고, 메뉴나 스크립트처럼 본문이 아닌 부분만 뺀다.
// 표의 칸과 칸 사이에는 ' | '를 넣는다(원문에 없는 글자는 이것뿐이다).
import { parse } from 'parse5';

export interface PageText {
  title: string;
  /** 본문의 줄. 문단, 목록 항목, 표의 행이 한 줄이 된다 */
  blocks: string[];
  /** 페이지가 스스로 밝힌 날짜(작성일이나 수정일). 없으면 null */
  pageDate: string | null;
  chars: number;
}

interface HtmlNode {
  nodeName: string;
  value?: string;
  attrs?: Array<{ name: string; value: string }>;
  childNodes?: HtmlNode[];
  content?: HtmlNode;
}

const SKIP = new Set([
  'script', 'style', 'noscript', 'template', 'svg', 'canvas', 'iframe', 'object', 'embed', 'audio', 'video', 'map',
  'nav', 'footer', 'aside', 'select', 'option', 'button', 'input', 'textarea', 'dialog', 'menu',
]);
const SKIP_ROLES = new Set(['navigation', 'search', 'contentinfo', 'complementary', 'menu', 'menubar', 'dialog']);
const BLOCK = new Set([
  'address', 'article', 'blockquote', 'body', 'caption', 'dd', 'details', 'div', 'dl', 'dt', 'fieldset', 'figcaption',
  'figure', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'li', 'main', 'ol', 'p', 'pre', 'section',
  'summary', 'table', 'tbody', 'tfoot', 'thead', 'tr', 'ul',
]);
const DATE_META = [
  'article:modified_time', 'og:updated_time', 'article:published_time', 'last-modified', 'dcterms.modified',
  'dc.date', 'date', 'pubdate',
];

const attr = (node: HtmlNode, name: string) => node.attrs?.find((a) => a.name === name)?.value ?? null;

function hidden(node: HtmlNode): boolean {
  if (attr(node, 'hidden') !== null) return true;
  if (attr(node, 'aria-hidden') === 'true') return true;
  const role = attr(node, 'role');
  if (role && SKIP_ROLES.has(role.toLowerCase())) return true;
  const style = attr(node, 'style');
  return Boolean(style && /display\s*:\s*none|visibility\s*:\s*hidden/i.test(style));
}

function textOf(node: HtmlNode): string {
  if (node.nodeName === '#text') return node.value ?? '';
  return (node.childNodes ?? []).map(textOf).join('');
}

export function extractPageText(html: string): PageText {
  const doc = parse(html) as unknown as HtmlNode;
  const lines: string[] = [];
  const seen = new Set<string>();
  let current = '';
  let title = '';
  const meta = new Map<string, string>();

  const flush = () => {
    const line = current.replace(/\s+/g, ' ').replace(/^(\| )+|( \|)+$/g, '').trim();
    current = '';
    if (!line || /^[\s|·•\-–—>/\\]+$/.test(line)) return;
    // 같은 줄이 되풀이되면(메뉴, 꼬리말) 처음 것만 둔다
    if (seen.has(line)) return;
    seen.add(line);
    lines.push(line);
  };

  const walk = (node: HtmlNode) => {
    const name = node.nodeName;
    if (name === '#text') {
      current += node.value ?? '';
      return;
    }
    if (name === '#comment' || name === '#documentType') return;
    if (name === 'title') {
      if (!title) title = textOf(node).replace(/\s+/g, ' ').trim();
      return;
    }
    if (name === 'meta') {
      const key = (attr(node, 'property') ?? attr(node, 'name') ?? '').toLowerCase();
      const value = attr(node, 'content');
      if (key && value && !meta.has(key)) meta.set(key, value.trim());
      return;
    }
    if (SKIP.has(name) || hidden(node)) return;
    if (name === 'br') {
      flush();
      return;
    }
    const block = BLOCK.has(name);
    if (block) flush();
    for (const child of node.childNodes ?? []) walk(child);
    if (name === 'td' || name === 'th') current += ' | ';
    if (block) flush();
  };
  walk(doc);
  flush();

  // 설명문을 본문이 아니라 문서 머리에만 적어 두는 사이트가 있다(본문은 스크립트로 그린다).
  // 페이지가 스스로 적은 글이므로, 본문에 같은 글이 없으면 첫 줄로 싣는다
  const description = (meta.get('description') ?? meta.get('og:description') ?? '').replace(/\s+/g, ' ').trim();
  if (description.length >= 40) {
    const head = description.slice(0, 30);
    if (!lines.some((line) => line.includes(head))) lines.unshift(description.slice(0, 2000));
  }

  let pageDate: string | null = null;
  for (const key of DATE_META) {
    const value = meta.get(key);
    if (value) {
      pageDate = value.slice(0, 40);
      break;
    }
  }
  return { title: title.slice(0, 200), blocks: lines, pageDate, chars: lines.reduce((n, l) => n + l.length, 0) };
}
