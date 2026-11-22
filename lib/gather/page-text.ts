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

export interface PageLink {
  url: string;
  /** 링크에 적힌 글자(메뉴의 이름 등) */
  text: string;
}

/**
 * 페이지 안의 링크와 거기 적힌 글자를 뽑는다. 주소는 그 페이지의 주소를 기준으로 온전한 꼴로 바꾼다.
 * 본문 글을 뽑을 때는 메뉴를 빼지만, 여기서는 메뉴의 링크도 싣는다. 기관 사이트에서 연혁이나 관람 안내 같은
 * 안쪽 페이지를 찾을 때는 메뉴가 길잡이이기 때문이다. 스크립트로만 움직이는 링크(href="#", javascript:)는 뽑지 않는다
 */
export function extractLinks(html: string, baseUrl: string): PageLink[] {
  return linksOf(parse(html) as unknown as HtmlNode, baseUrl);
}

export function extractPageText(html: string): PageText {
  return pageTextOf(parse(html) as unknown as HtmlNode);
}

/** HTML을 한 번만 풀어 본문 글과 링크를 함께 뽑는다. 연 페이지를 여러 명제가 함께 쓸 때(page-cache.ts) 쓴다 */
export function readHtml(html: string, baseUrl: string): { page: PageText; links: PageLink[] } {
  const doc = parse(html) as unknown as HtmlNode;
  return { page: pageTextOf(doc), links: linksOf(doc, baseUrl) };
}

function linksOf(doc: HtmlNode, baseUrl: string): PageLink[] {
  const out: PageLink[] = [];
  const seen = new Set<string>();
  const walk = (node: HtmlNode) => {
    const name = node.nodeName;
    if (name === 'script' || name === 'style' || name === 'template' || name === 'noscript') return;
    if (name === 'a') {
      const href = (attr(node, 'href') ?? '').trim();
      const text = (textOf(node).replace(/\s+/g, ' ').trim() || (attr(node, 'title') ?? '').replace(/\s+/g, ' ').trim()).slice(0, 80);
      if (href && text && !href.startsWith('#')) {
        try {
          const url = new URL(href, baseUrl);
          url.hash = '';
          if ((url.protocol === 'http:' || url.protocol === 'https:') && !seen.has(url.href)) {
            seen.add(url.href);
            out.push({ url: url.href, text });
          }
        } catch {
          // 주소로 읽을 수 없는 링크는 건너뛴다
        }
      }
    }
    for (const child of node.childNodes ?? []) walk(child);
    if (node.content) walk(node.content);
  };
  walk(doc);
  return out;
}

function pageTextOf(doc: HtmlNode): PageText {
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
