// 내보내기(F11): 수정 원고와 검토 기록을 만든다. 브라우저에서 만들고 서버에 보내지 않는다.
// 수정 원고는 채택한 문장만, 기록해 둔 위치의 글자를 바꿔 만든다. 원본 원고는 그대로 둔다.
import { markupSignature } from '../merge/check.ts';
import { totalCost } from '../pricing.ts';
import {
  autoRevision,
  candidateText,
  isAdopted,
  isResolved,
  recheckOf,
  recheckStatus,
  reviewOf,
  staysDirect,
  summarizeUsage,
  viewOf,
  type ClaimView,
  type RunState,
} from '../run/model.ts';
import { contentId } from '../sentences.ts';
import type { Sentence } from '../types.ts';

export interface ExportItem {
  sentenceId: number;
  before: string;
  after: string;
}

export interface ExportPlan {
  /** 채택한 문장만 바꾼 새 원고. 원고가 검증을 시작할 때와 달라 만들 수 없으면 null */
  manuscript: string | null;
  /** 원고를 만들지 못한 까닭. 만들었으면 빈 문자열 */
  problem: string;
  /** 원고에 반영한 문장 */
  applied: ExportItem[];
  /** 직접 반영할 항목: 채택했지만 자동으로 바꾸지 않은 문장과 그 까닭 */
  manual: Array<ExportItem & { why: string }>;
  /** 채택하지 않은 수정안(보류했거나 아직 고르지 않음). 원문 그대로 내보낸다 */
  held: Array<ExportItem & { choice: '' | '보류' }>;
  /** 미해결로 남는 내용: 손봐야 할 판정이 났는데 채택한 수정으로 풀리지 않은 명제 */
  open: ClaimView[];
  /** 직접 확인할 것 */
  direct: ClaimView[];
  /** 처리가 끝나지 않은 명제 */
  unfinished: ClaimView[];
  /** 고쳐 쓴 뒤 다시 검증하지 않고 채택한 문장의 번호 */
  unchecked: number[];
}

/** 채택한 수정안을 자동으로 바꾸지 않는 까닭. 자동으로 바꿔도 되면 빈 문자열 */
function manualReason(run: RunState, sentence: Sentence, after: string): string {
  if (sentence.kind === 'table' || sentence.kind === 'caption' || sentence.kind === 'footnote') return '표, 캡션, 각주에 놓인 문장입니다';
  if (sentence.hasLinkOrFootnote) return '링크나 각주가 든 문장입니다';
  const a = markupSignature(sentence.source);
  const b = markupSignature(after);
  if (a.length !== b.length || a.some((mark, i) => mark !== b[i])) return '강조 표시가 원문과 달라진 수정안입니다';
  // 바꾸기 전에 그 위치의 글자가 기록해 둔 원문 문장과 같은지 본다
  if (run.manuscript.slice(sentence.start, sentence.end) !== sentence.source) return '원고의 그 자리 글자가 기록해 둔 문장과 달라 바꾸지 않았습니다';
  return '';
}

export function planExport(run: RunState): ExportPlan {
  const applied: ExportPlan['applied'] = [];
  const manual: ExportPlan['manual'] = [];
  const held: ExportPlan['held'] = [];
  const unchecked: number[] = [];

  for (const sentence of run.sentences) {
    const after = candidateText(run, sentence.id);
    if (after === null) continue;
    const review = reviewOf(run, sentence.id);
    const item = { sentenceId: sentence.id, before: sentence.source, after };
    if (!isAdopted(run, sentence.id)) {
      held.push({ ...item, choice: review.choice === '보류' ? '보류' : '' });
      continue;
    }
    if (review.edited !== null && recheckStatus(run, sentence) !== '현재 문장 검증 완료') unchecked.push(sentence.id);
    const why = manualReason(run, sentence, after);
    if (why) manual.push({ ...item, why });
    else applied.push(item);
  }

  // 원고 버전이 검증을 시작할 때와 같은지 본다. 다르면 위치가 맞지 않으므로 만들지 않는다
  let manuscript: string | null = null;
  let problem = '';
  if (contentId(run.manuscript) !== run.manuscriptKey) {
    problem = '원고가 검증을 시작할 때와 달라 수정 원고를 만들 수 없습니다.';
  } else {
    // 뒤에서부터 바꿔야 앞쪽 문장의 위치가 밀리지 않는다. 모든 교체는 바뀌지 않은 원본의 위치를 기준으로 한다
    const byId = new Map(run.sentences.map((s) => [s.id, s]));
    const ordered = [...applied].sort((x, y) => (byId.get(y.sentenceId) as Sentence).start - (byId.get(x.sentenceId) as Sentence).start);
    manuscript = run.manuscript;
    for (const item of ordered) {
      const s = byId.get(item.sentenceId) as Sentence;
      manuscript = manuscript.slice(0, s.start) + item.after + manuscript.slice(s.end);
    }
  }

  const views = run.claims.map((e) => viewOf(run, e));
  const finished = (v: ClaimView) => v.state === '완료' && v.verdict !== null;
  return {
    manuscript,
    problem,
    applied,
    manual,
    held,
    open: views.filter((v) => finished(v) && !staysDirect(v) && !isResolved(run, v)),
    direct: views.filter((v) => finished(v) && staysDirect(v)),
    unfinished: views.filter((v) => !finished(v)),
    unchecked,
  };
}

/** 문장에 대해 편집자가 고른 것을 한 낱말로 */
function decisionOf(run: RunState, sentence: Sentence): string {
  if (candidateText(run, sentence.id) === null) return '수정안 없음';
  if (isAdopted(run, sentence.id)) return '채택';
  return reviewOf(run, sentence.id).choice === '보류' ? '보류' : '고르지 않음(보류로 처리)';
}

interface EvidenceLine {
  no: number;
  relation: string;
  quote: string;
  sourceNo: number;
  publisher: string;
  grade: number | null;
  docType: string;
  url: string;
}

/** 판정을 정하는 데 쓴 근거를 인용문, 출처와 함께 뽑는다 */
function evidenceLines(view: ClaimView): EvidenceLine[] {
  const out: EvidenceLine[] = [];
  for (const use of view.judgment?.evidence ?? []) {
    if (!use.usable) continue;
    const info = view.bundle?.sources.find((s) => s.no === use.sourceNo);
    const rating = view.judgment?.sources.find((s) => s.sourceNo === use.sourceNo);
    out.push({
      no: use.evidenceNo,
      relation: use.relation,
      quote: use.quote,
      sourceNo: use.sourceNo,
      publisher: info?.publisherHint || rating?.publisher || info?.hostname || '',
      grade: rating?.grade ?? null,
      docType: rating?.docType ?? '',
      url: info?.url ?? '',
    });
  }
  return out;
}

function usageLine(run: RunState): string {
  const summary = summarizeUsage(run.usage);
  const cost = totalCost(run.usage);
  return `검색 ${summary.searches}회, 모델 호출 ${summary.modelCalls}회, 추정 비용 약 ${cost.dollars.toFixed(2)}달러`;
}

/** 이 명제가 내보낸 원고에서 어떻게 됐는지 */
function outcomeOf(run: RunState, view: ClaimView): string {
  if (!(view.state === '완료' && view.verdict !== null)) return '처리가 끝나지 않음';
  if (view.verdict === '일치') return '';
  if (staysDirect(view)) return '직접 확인 필요';
  return isResolved(run, view) ? '채택한 수정안에 반영' : '미해결';
}

/** 저장해 둔 시각을 이 기기의 시각으로 적는다(예: 2026-11-21 19:05). 읽을 수 없는 값이면 그대로 돌려준다 */
function localStamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const two = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

/**
 * 사실 하나를 검토 기록(.md)에 적는다: 판정과 명제, 유형, 까닭, 고칠 내용, 권고, 근거의 인용문과 출처, 확인일.
 * 원문에서 확인한 사실과 고쳐 쓴 문장을 다시 검증한 사실을 같은 꼴로 적는다
 */
function factLines(view: ClaimView, index: number, outcome: string): string[] {
  const { claim } = view.entry;
  const done = view.state === '완료' && view.verdict !== null;
  const lines = [`  ${index + 1}. [${done ? view.verdict : view.state}] ${claim.statement}${outcome ? ` → ${outcome}` : ''}`];
  lines.push(`     - 유형: ${claim.type}, 기준 시점: ${claim.asOf}${view.judgment?.priority ? `, 편집 우선순위: ${view.judgment.priority}` : ''}`);
  if (!done) {
    if (view.failure) lines.push(`     - 실패 사유: ${view.failure}`);
    return lines;
  }
  if (staysDirect(view)) {
    lines.push(`     - 공개 자료로 확인할 수 없는 까닭: ${claim.privateReason || '적혀 있지 않음'}`);
    if (view.direct?.note) lines.push(`     - 찾아본 결과: ${view.direct.note}`);
    return lines;
  }
  const judgment = view.judgment;
  if (!judgment) return lines;
  lines.push(`     - 까닭: ${judgment.reason}`);
  // 일치로 본 길이 평소와 다를 때의 표시(서로 다른 기관 두 곳, 단일 근거 등)도 기록에 남긴다
  if (judgment.flags.length > 0) lines.push(`     - 표시: ${judgment.flags.join(', ')}`);
  if (judgment.lowered) lines.push(`     - 판정을 바꾼 규칙: ${judgment.lowered.rule}(${judgment.lowered.note})`);
  if (judgment.fix.kind !== '없음') lines.push(`     - 고칠 내용(${judgment.fix.kind}): ${judgment.fix.instruction}`);
  if (judgment.action) lines.push(`     - 권고: ${judgment.action}`);
  for (const e of evidenceLines(view)) {
    lines.push(`     - 근거 ${e.no}(${e.relation}): "${e.quote}"`);
    lines.push(`       출처 ${e.sourceNo}: ${[e.publisher, e.grade ? `${e.grade}등급` : '', e.docType, e.url].filter(Boolean).join(', ')}`);
  }
  lines.push(`     - 확인일: ${judgment.checkedAt}`);
  return lines;
}

/** 검토 기록(.md). 문장 단위로 묶고, 그 아래에 사실별 판정과 까닭, 근거를 적는다 */
export function reviewRecordMarkdown(run: RunState, plan: ExportPlan, exportedAt: string): string {
  const lines: string[] = [];
  const adopted = plan.applied.length + plan.manual.length;
  lines.push(`# 검토 기록: ${run.title || '제목 없는 원고'}`, '');
  lines.push(`- 검증을 시작한 때: ${localStamp(run.startedAt)}`);
  lines.push(`- 내보낸 때: ${exportedAt}`);
  lines.push(`- 채택한 문장: ${adopted}개(원고에 반영 ${plan.applied.length}개, 직접 반영할 항목 ${plan.manual.length}개)`);
  lines.push(`- 채택하지 않은 수정안: ${plan.held.length}개`);
  lines.push(`- 미해결로 남는 내용: ${plan.open.length}개, 직접 확인할 것: ${plan.direct.length}개, 끝나지 않은 항목: ${plan.unfinished.length}개`);
  lines.push(`- Liner API 사용: ${usageLine(run)}`);
  if (plan.problem) lines.push(`- 알림: ${plan.problem}`);
  lines.push('', '## 문장별 기록', '');

  for (const sentence of run.sentences) {
    const views = run.claims.filter((e) => e.claim.sentenceId === sentence.id).map((e) => viewOf(run, e));
    if (views.length === 0) continue;
    const review = reviewOf(run, sentence.id);
    const after = candidateText(run, sentence.id);
    const adoptedHere = isAdopted(run, sentence.id);
    lines.push(`### 문장 ${sentence.id}: ${decisionOf(run, sentence)}`, '');
    lines.push(`- 고치기 전: ${sentence.source}`);
    if (after !== null) lines.push(`- ${adoptedHere ? '고친 뒤' : '채택하지 않은 수정안'}: ${after}`);
    if (after !== null) {
      const kinds = review.edited !== null ? '편집자가 고쳐 씀' : [...new Set(autoRevision(run, sentence.id)?.kinds ?? [])].join(', ');
      if (kinds) lines.push(`- 수정안의 종류: ${kinds}`);
    }
    if (adoptedHere && plan.unchecked.includes(sentence.id)) lines.push('- 편집자 수정 후 재검증하지 않음');
    const manual = plan.manual.find((m) => m.sentenceId === sentence.id);
    if (manual) lines.push(`- 원고에 자동으로 반영하지 않음: ${manual.why}`);
    lines.push('- 확인한 사실');
    views.forEach((view, i) => lines.push(...factLines(view, i, outcomeOf(run, view))));
    // 고쳐 쓴 문장을 다시 검증한 결과. 채택한 글이 무엇을 근거로 확인됐는지 알 수 있게 근거와 출처까지 적는다
    const recheck = recheckOf(run, sentence.id);
    if (recheck && recheck.state === '완료') {
      const stale = recheck.text !== review.edited;
      lines.push(`- 고쳐 쓴 문장을 다시 검증한 결과(${recheck.at.slice(0, 10)})${stale ? ' — 이전 문장에 대한 결과' : ''}`);
      if (stale) lines.push(`  - 검증한 글: ${recheck.text}`);
      if (recheck.claims.length === 0) lines.push('  - 확인할 사실을 찾지 못했습니다');
      recheck.claims.forEach((e, i) => lines.push(...factLines(viewOf(run, e), i, '')));
    }
    lines.push('');
  }

  const sentenceOf = (view: ClaimView) => `문장 ${view.entry.claim.sentenceId}`;
  lines.push('## 직접 반영할 항목', '');
  if (plan.manual.length === 0) lines.push('없음', '');
  for (const m of plan.manual) lines.push(`- 문장 ${m.sentenceId}: ${m.why}`, `  - 고치기 전: ${m.before}`, `  - 고친 뒤: ${m.after}`, '');
  lines.push('## 직접 확인할 것', '');
  if (plan.direct.length === 0) lines.push('없음', '');
  for (const v of plan.direct) lines.push(`- ${sentenceOf(v)}: ${v.entry.claim.statement}`, `  - 까닭: ${v.entry.claim.privateReason || '적혀 있지 않음'}`, '');
  lines.push('## 미해결로 남는 내용', '');
  if (plan.open.length === 0) lines.push('없음', '');
  for (const v of plan.open) lines.push(`- ${sentenceOf(v)} [${v.verdict}] ${v.entry.claim.statement}`);
  if (plan.open.length > 0) lines.push('');
  lines.push('## 끝나지 않은 항목', '');
  if (plan.unfinished.length === 0) lines.push('없음', '');
  for (const v of plan.unfinished) lines.push(`- ${sentenceOf(v)} [${v.state}] ${v.entry.claim.statement}${v.failure ? ` (${v.failure})` : ''}`);
  if (plan.unfinished.length > 0) lines.push('');
  return `${lines.join('\n').trimEnd()}\n`;
}

/** 검토 기록(.json). 내용은 .md와 같고, 다른 도구가 읽기 쉽게 구조만 다르다 */
export function reviewRecordJson(run: RunState, plan: ExportPlan, exportedAt: string): Record<string, unknown> {
  const summary = summarizeUsage(run.usage);
  const claimRecord = (view: ClaimView) => ({
    번호: view.entry.claim.id,
    명제: view.entry.claim.statement,
    유형: view.entry.claim.type,
    '한정 표현': view.entry.claim.qualifiers,
    '기준 시점': view.entry.claim.asOf,
    '처리 상태': view.state,
    판정: view.verdict,
    '편집 우선순위': view.judgment?.priority ?? null,
    까닭: view.judgment?.reason ?? (staysDirect(view) ? view.entry.claim.privateReason : ''),
    표시: view.judgment?.flags ?? [],
    권고: view.judgment?.action ?? '',
    '고칠 내용': view.judgment && view.judgment.fix.kind !== '없음' ? { 종류: view.judgment.fix.kind, 내용: view.judgment.fix.instruction } : null,
    '판정을 바꾼 규칙': view.judgment?.lowered ?? null,
    결과: outcomeOf(run, view) || '고칠 것 없음',
    근거: evidenceLines(view).map((e) => ({ 번호: e.no, 관계: e.relation, 인용문: e.quote, 출처: { 번호: e.sourceNo, 발행처: e.publisher, 등급: e.grade, '문서 종류': e.docType, 주소: e.url } })),
    확인일: view.judgment?.checkedAt ?? null,
    '실패 사유': view.failure || null,
  });
  const sentences = run.sentences
    .map((sentence) => ({ sentence, views: run.claims.filter((e) => e.claim.sentenceId === sentence.id).map((e) => viewOf(run, e)) }))
    .filter((x) => x.views.length > 0)
    .map(({ sentence, views }) => {
      const review = reviewOf(run, sentence.id);
      const after = candidateText(run, sentence.id);
      const recheck = recheckOf(run, sentence.id);
      return {
        '문장 번호': sentence.id,
        선택: decisionOf(run, sentence),
        '고치기 전': sentence.source,
        수정안: after,
        '고친 뒤': isAdopted(run, sentence.id) ? after : null,
        '편집자가 고쳐 씀': review.edited !== null,
        '편집자 수정 후 재검증하지 않음': plan.unchecked.includes(sentence.id),
        '원고에 반영': plan.applied.some((a) => a.sentenceId === sentence.id),
        '직접 반영할 까닭': plan.manual.find((m) => m.sentenceId === sentence.id)?.why ?? null,
        '선택한 때': review.at || null,
        '확인한 사실': views.map(claimRecord),
        재검증:
          recheck && recheck.state === '완료'
            ? {
                대상: '고쳐 쓴 문장',
                '검증한 글': recheck.text,
                '검증한 때': recheck.at,
                '이전 문장에 대한 결과': recheck.text !== review.edited,
                결과: recheck.claims.map((e) => claimRecord(viewOf(run, e))),
              }
            : null,
      };
    });
  return {
    제목: run.title,
    '검증을 시작한 때': run.startedAt,
    '내보낸 때': exportedAt,
    요약: {
      '채택한 문장': plan.applied.length + plan.manual.length,
      '원고에 반영한 문장': plan.applied.length,
      '직접 반영할 항목': plan.manual.length,
      '채택하지 않은 수정안': plan.held.length,
      '미해결로 남는 내용': plan.open.length,
      '직접 확인할 것': plan.direct.length,
      '끝나지 않은 항목': plan.unfinished.length,
    },
    'Liner API 사용': { 검색: summary.searches, '모델 호출': summary.modelCalls, '추정 비용(달러)': Number(totalCost(run.usage).dollars.toFixed(4)) },
    알림: plan.problem || null,
    '문장별 기록': sentences,
    '미해결로 남는 내용': plan.open.map((v) => ({ '문장 번호': v.entry.claim.sentenceId, 판정: v.verdict, 명제: v.entry.claim.statement })),
    '직접 확인할 것': plan.direct.map((v) => ({ '문장 번호': v.entry.claim.sentenceId, 명제: v.entry.claim.statement, 까닭: v.entry.claim.privateReason })),
    '끝나지 않은 항목': plan.unfinished.map((v) => ({ '문장 번호': v.entry.claim.sentenceId, '처리 상태': v.state, 명제: v.entry.claim.statement, '실패 사유': v.failure || null })),
  };
}

/** 내려받는 파일의 이름 앞부분. 원고의 제목에서 파일 이름에 쓸 수 없는 글자를 뺀다 */
export function fileBase(title: string): string {
  const clean = title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);
  return clean || '원고';
}
