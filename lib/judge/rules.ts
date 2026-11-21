// 모델의 판정을 그대로 믿지 않고 코드가 다시 검사한다(PRD 5.3절의 규칙 1~7번).
// 이 파일의 함수는 Liner를 부르지 않는다. 모델의 답과 근거 묶음만 받아 판정을 확정한다.
import type { ModelJudgment } from '../prompts/judge.ts';
import { FALLBACK_DOC_TYPE, STANDARD, finalGrade, isDocType, type RequirementOption } from '../standard.ts';
import type {
  Applicability,
  ClaimType,
  EvidenceBundle,
  EvidenceUse,
  Fix,
  FixKind,
  Grade,
  Judgment,
  Priority,
  QualifierCheck,
  Relation,
  SourceLink,
  SourceRating,
  Verdict,
} from '../types.ts';

export interface RuleInput {
  claim: { statement: string; type: ClaimType; lead: boolean };
  bundle: EvidenceBundle;
  model: ModelJudgment;
  sentenceKey: string;
}

type ModelVerdict = '일치' | '불일치' | '근거 부족' | '해석 주의';
const VERDICTS: ModelVerdict[] = ['일치', '불일치', '근거 부족', '해석 주의'];
const RELATIONS: Relation[] = ['지지', '반박', '판단 불충분'];
const APPLICABILITY: Applicability[] = ['적용 가능', '적용 불가', '미확인'];
const FIX_KINDS: FixKind[] = ['교정안', '인용형', '축소안', '없음'];
const QUALIFIER_RESULTS: QualifierCheck['result'][] = ['출처와 같다', '출처와 다르다', '확인하지 못했다'];
const NO_FIX: Fix = { kind: '없음', instruction: '', sourceNo: null };

/**
 * 인용문을 견줄 때 쓰는 꼴. 공백과 표의 칸 구분(' | ')의 차이는 무시한다.
 * 같은 글자를 달리 적은 것(㎝와 cm, 둥근 따옴표와 곧은 따옴표)도 같은 것으로 본다.
 * 페이지에 글자로 섞여 든 태그(</br> 등)도 뺀다. 원문에 그런 찌꺼기가 있으면 모델이 인용문에 붙이거나 빼는 일이 있다.
 */
export function squeezeQuote(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/<\/?(br|p|b|i|em|strong|span|div|sub|sup)\b[^<>]{0,20}>/gi, '')
    .replace(/[\s|]+/g, '')
    .replace(/[“”„‟]/g, '"')
    .replace(/[‘’‚‛]/g, "'");
}

/** 같은 사이트인지 견줄 때 쓰는 이름. 예: www.gogung.go.kr과 m.gogung.go.kr은 gogung.go.kr */
function siteOf(hostname: string): string {
  const parts = hostname
    .toLowerCase()
    .replace(/^(www|m)\./, '')
    .split('.');
  const country = parts[parts.length - 1]?.length === 2;
  const second = ['go', 'or', 'ac', 'co', 're', 'ne', 'pe', 'com', 'org', 'gov', 'edu'].includes(parts[parts.length - 2] ?? '');
  return parts.slice(country && second ? -3 : -2).join('.');
}

const pick = <T extends string>(value: unknown, allowed: T[], fallback: T): T =>
  allowed.includes(value as T) ? (value as T) : fallback;
const short = (value: unknown, max: number) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
const unique = (list: number[]) => [...new Set(list)];

export function applyRules(input: RuleInput): Judgment {
  const { claim, bundle, model } = input;
  const sourceByNo = new Map(bundle.sources.map((s) => [s.no, s]));
  const evidenceByNo = new Map(bundle.evidence.map((e) => [e.no, e]));

  // 출처 평가: 문서 종류와 발행 주체는 모델이 고르고, 등급은 코드가 기준 파일의 표로 정한다
  const sources: SourceRating[] = [];
  for (const no of unique(bundle.evidence.map((e) => e.sourceNo))) {
    const info = sourceByNo.get(no);
    if (!info) continue;
    const rated = (model.sources ?? []).find((s) => s.source_no === no);
    // 모델이 평가를 빠뜨렸거나 목록에 없는 종류를 내면 가장 낮은 쪽으로 둔다
    const docType = rated && isDocType(rated.doc_type) ? rated.doc_type : FALLBACK_DOC_TYPE;
    const ownFact = Boolean(rated?.own_fact);
    const grade = finalGrade(docType, ownFact, info.lowPlatform);
    sources.push({
      sourceNo: no,
      docType,
      publisher: short(rated?.publisher, 60),
      ownFact,
      grade,
      publisherUnlisted: grade === 1 && !info.publisherHint,
    });
  }
  const ratingOf = (no: number) => sources.find((s) => s.sourceNo === no);
  const gradeOf = (no: number): Grade => ratingOf(no)?.grade ?? 3;

  // 출처 사이의 관계: 중복은 한 출처로 세고, '독립 추정'인 쌍만 서로 독립인 것으로 본다
  const links: SourceLink[] = [];
  for (const l of model.links ?? []) {
    if (l.a === l.b || !ratingOf(l.a) || !ratingOf(l.b)) continue;
    if (l.status !== '중복' && l.status !== '독립 추정') continue;
    links.push({ a: l.a, b: l.b, status: l.status, reason: short(l.reason, 120) });
  }
  const group = new Map<number, number>(sources.map((s) => [s.sourceNo, s.sourceNo]));
  const rootOf = (no: number): number => (group.get(no) === no || !group.has(no) ? no : rootOf(group.get(no) as number));
  for (const l of links) if (l.status === '중복') group.set(rootOf(l.a), rootOf(l.b));
  const independent = (a: number, b: number) =>
    rootOf(a) !== rootOf(b) &&
    links.some((l) => l.status === '독립 추정' && ((l.a === a && l.b === b) || (l.a === b && l.b === a)));

  // 1번, 4번, 5번: 인용문이 그 번호의 발췌에 있어야 하고, 대상·범위·시점이 모두 적용 가능해야 판정에 쓴다
  const evidence: EvidenceUse[] = [];
  for (const e of model.evidence ?? []) {
    const cited = evidenceByNo.get(e.evidence_no);
    if (!cited) continue;
    const quote = short(e.quote, 300);
    const squeezed = squeezeQuote(quote);
    let item = cited;
    let quoteFound = squeezed.length >= 2 && squeezeQuote(cited.text).includes(squeezed);
    if (!quoteFound && squeezed.length >= 2) {
      // 모델이 같은 출처의 다른 발췌에 있는 구절을 옮기며 근거 번호를 잘못 적는 일이 있다.
      // 그 구절이 같은 출처의 다른 발췌에 그대로 있으면 번호를 그 발췌로 바로잡는다. 다른 출처의 발췌는 찾지 않는다
      const other = bundle.evidence.find(
        (x) => x.sourceNo === cited.sourceNo && x.no !== cited.no && squeezeQuote(x.text).includes(squeezed) && !evidence.some((u) => u.evidenceNo === x.no),
      );
      if (other) {
        item = other;
        quoteFound = true;
      }
    }
    if (evidence.some((u) => u.evidenceNo === item.no)) continue;
    const relation = pick(e.relation, RELATIONS, '판단 불충분');
    const target = pick(e.target, APPLICABILITY, '미확인');
    const scope = pick(e.scope, APPLICABILITY, '미확인');
    const time = pick(e.time, APPLICABILITY, '미확인');
    const applicable = target === '적용 가능' && scope === '적용 가능' && time === '적용 가능';
    evidence.push({
      evidenceNo: item.no,
      sourceNo: item.sourceNo,
      relation,
      target,
      scope,
      time,
      quote,
      quoteFound,
      ...(item.no !== cited.no ? { correctedFrom: cited.no } : {}),
      usable: quoteFound && applicable && relation !== '판단 불충분',
    });
  }
  const sourcesFor = (relation: Relation) => unique(evidence.filter((u) => u.usable && u.relation === relation).map((u) => u.sourceNo));
  let support = sourcesFor('지지');
  let refute = sourcesFor('반박');
  const top = (list: number[]): Grade | null => (list.length ? (Math.min(...list.map(gradeOf)) as Grade) : null);

  // 6번: 적용 가능한 지지 근거와 반박 근거가 함께 있으면 등급의 차이만으로 정하지 않는다
  const conflict = { found: support.length > 0 && refute.length > 0, resolved: false, supportTop: top(support), refuteTop: top(refute) };
  let corrected: Relation | null = null;
  if (conflict.found && model.conflict?.state === '바로잡은 자료로 풀림') {
    // 풀렸다는 모델의 답은 그대로 받지 않는다. 바로잡았다는 구절이 그 근거의 발췌에 있어야 하고,
    // 바로잡은 곳이 같은 발행처이거나 그 사실을 정하는 기관(1등급)이어야 한다
    const use = evidence.find((u) => u.evidenceNo === model.conflict.correcting_evidence_no && u.usable);
    const item = use ? evidenceByNo.get(use.evidenceNo) : undefined;
    const mine = use ? sourceByNo.get(use.sourceNo) : undefined;
    const said = squeezeQuote(short(model.conflict.correcting_quote, 300));
    if (use && item && mine && said.length >= 6 && squeezeQuote(item.text).includes(said)) {
      const others = (use.relation === '지지' ? refute : support).map((no) => sourceByNo.get(no));
      const sameSite = others.some((o) => o && siteOf(o.hostname) === siteOf(mine.hostname));
      if (sameSite || gradeOf(use.sourceNo) === 1) {
        corrected = use.relation;
        conflict.resolved = true;
        if (corrected === '지지') refute = [];
        else support = [];
      }
    }
  }

  const modelVerdict = pick(model.verdict, VERDICTS, '근거 부족');
  const flags: string[] = [];
  const requirement = STANDARD.requirements[claim.type];

  /** 모델이 그 관계라고 한 근거가 왜 하나도 남지 않았는지 */
  const whyNone = (relation: Relation): { rule: string; note: string } => {
    if (bundle.evidence.length === 0) return { rule: '3번', note: '원문을 하나도 열지 못했다' };
    const claimed = evidence.filter((u) => u.relation === relation);
    if (claimed.some((u) => u.quoteFound)) return { rule: '4번', note: `${relation} 근거의 대상·범위·시점이 모두 적용 가능하지 않다` };
    if (claimed.length > 0) return { rule: '1번', note: `${relation} 근거의 인용문이 발췌에 없다` };
    return { rule: '5번', note: `${relation} 근거가 없다` };
  };

  /** 2번: '일치'에 필요한 근거(5.2절)를 채웠는지 */
  const meets = (list: number[]): boolean => {
    const eligible = (o: RequirementOption) =>
      list.filter((no) => gradeOf(no) <= o.grade && (!o.docTypes || o.docTypes.includes(ratingOf(no)?.docType ?? '')));
    return (requirement?.anyOf ?? []).some((o) => {
      const found = eligible(o);
      if (o.count <= 1) return found.length >= 1;
      // 2등급이 둘이어도 독립이 확인되지 않으면 독립인 근거 하나로 센다
      if (o.independent) return found.some((a) => found.some((b) => independent(a, b)));
      return unique(found.map(rootOf)).length >= o.count;
    });
  };

  type Decision = { verdict: ModelVerdict; rule?: string; note?: string };
  const decide = (): Decision => {
    if (support.length > 0 && refute.length > 0) {
      if (top([...support, ...refute]) === 3) return { verdict: '근거 부족', rule: '2번', note: '엇갈리는 근거가 모두 3등급이다' };
      return { verdict: '해석 주의', rule: '6번', note: '적용 가능한 지지 근거와 반박 근거가 함께 있고 풀리지 않았다' };
    }
    // 바로잡은 자료로 풀렸으면 바로잡은 쪽의 판정을 따른다
    const wanted: ModelVerdict = corrected === '지지' ? '일치' : corrected === '반박' ? '불일치' : modelVerdict;

    if (wanted === '일치') {
      if (support.length === 0) return { verdict: '근거 부족', ...whyNone('지지') };
      if (meets(support)) return { verdict: '일치' };
      const note = `'일치'에 필요한 근거를 채우지 못했다(${requirement?.need ?? ''})`;
      // 2등급 근거 하나뿐이어도, 특정 값이 달려 있지 않은 서술이고 글의 앞머리가 아니면 받아들이되 표시한다
      const hasGrade2 = support.some((no) => gradeOf(no) <= 2);
      if (requirement?.allowSingleSource && hasGrade2 && !/\d/.test(claim.statement) && !claim.lead) {
        flags.push('단일 근거');
        return { verdict: '일치' };
      }
      const reports = unique(support.filter((no) => ratingOf(no)?.docType === '언론 보도').map(rootOf));
      if (requirement?.shortfallIfSeveralReports && reports.length >= 2) {
        return { verdict: requirement.shortfallIfSeveralReports, rule: '2번', note: `${note}. 여러 보도가 같은 내용이다` };
      }
      if (top(support) === 3) flags.push('3등급 자료만 있다');
      return { verdict: requirement?.shortfall ?? '근거 부족', rule: '2번', note };
    }

    if (wanted === '불일치') {
      if (refute.length === 0) return { verdict: '근거 부족', ...whyNone('반박') };
      if (top(refute) === 3) {
        flags.push('3등급 자료가 다른 내용을 적고 있다');
        return { verdict: '근거 부족', rule: '2번', note: '반박 근거가 3등급뿐이다' };
      }
      return { verdict: '불일치' };
    }

    if (wanted === '해석 주의') {
      // 같은 대상을 다루는 근거가 하나는 있어야 '해석 주의'라고 말할 수 있다
      const anchored = evidence.some((u) => u.quoteFound && u.target === '적용 가능');
      if (anchored) return { verdict: '해석 주의' };
      return bundle.evidence.length === 0
        ? { verdict: '근거 부족', rule: '3번', note: '원문을 하나도 열지 못했다' }
        : { verdict: '근거 부족', rule: '1번', note: '판단에 쓸 수 있는 근거가 없다' };
    }
    return { verdict: '근거 부족' };
  };

  const decision = decide();
  const verdict: Verdict = decision.verdict;
  // 7번: 판정을 바꿨으면 어느 규칙으로 바꿨는지 적는다
  let lowered: Judgment['lowered'] = null;
  if (verdict !== modelVerdict) {
    lowered = decision.rule
      ? { rule: decision.rule, note: decision.note ?? '' }
      : { rule: '6번', note: '바로잡았다고 밝힌 자료를 따랐다' };
  }
  const unresolved = conflict.found && !conflict.resolved;

  const qualifiers: QualifierCheck[] = (model.qualifiers ?? [])
    .map((q) => ({ text: short(q.text, 40), result: pick(q.result, QUALIFIER_RESULTS, '확인하지 못했다'), note: short(q.note, 160) }))
    .filter((q) => q.text);

  // 축소안은 일부를 확인했을 때 나머지를 빼는 것이다. 아래 둘 가운데 하나여야 확인한 부분이 있다고 본다.
  // - 판단에 쓸 수 있는 근거가 있다
  // - 같은 대상을 다룬 근거가 있고, 한정 표현이 출처와 맞지 않는다(그 한정 표현을 빼면 된다)
  const sameTarget = evidence.some((u) => u.quoteFound && u.target === '적용 가능');
  const looseQualifier = qualifiers.some((q) => q.result !== '출처와 같다');
  const partlyConfirmed = evidence.some((u) => u.usable) || (sameTarget && looseQualifier);

  // 수정 방향(F7): 교정안은 '불일치'일 때만, 인용형은 2등급 이상의 출처일 때만 둔다
  let fix: Fix = {
    kind: pick(model.fix?.kind, FIX_KINDS, '없음'),
    instruction: short(model.fix?.instruction, 200),
    sourceNo: model.fix?.source_no && ratingOf(model.fix.source_no) ? model.fix.source_no : null,
  };
  if (verdict === '일치') {
    fix = NO_FIX;
  } else if (unresolved && verdict === '해석 주의') {
    // 근거가 엇갈린 명제에는 교정안을 만들지 않는다. 2등급 이상 출처의 이름을 밝힌 인용형을 내거나 수정안을 내지 않는다
    const keep = fix.kind === '인용형' && fix.sourceNo !== null && gradeOf(fix.sourceNo) <= 2;
    if (!keep) {
      const fromSupport = support.filter((no) => gradeOf(no) <= 2).sort((a, b) => gradeOf(a) - gradeOf(b))[0];
      const fromRefute = refute.filter((no) => gradeOf(no) <= 2).sort((a, b) => gradeOf(a) - gradeOf(b))[0];
      const named = fromSupport ?? fromRefute;
      if (named === undefined) {
        fix = NO_FIX;
      } else {
        // 수정안에 밝힐 이름과 같은 순서로 고른다(lib/merge/plan.ts의 citedSourceName): 기관 목록의 이름, 판정이 적은 발행 주체, 사이트 주소
        const info = sourceByNo.get(named);
        const name = info?.publisherHint || ratingOf(named)?.publisher || info?.hostname.replace(/^www\./, '') || '';
        const detail = fromSupport === undefined && fix.kind === '교정안' && fix.instruction ? ` 그 출처의 내용: ${fix.instruction}` : '';
        fix = { kind: '인용형', instruction: `출처(${name})의 설명임을 밝혀 쓴다.${detail}`.slice(0, 200), sourceNo: named };
      }
    }
  } else if (fix.kind === '교정안' && verdict !== '불일치') {
    fix = NO_FIX;
  } else if (fix.kind === '인용형' && (fix.sourceNo === null || gradeOf(fix.sourceNo) > 2)) {
    fix = NO_FIX;
  } else if (fix.kind === '축소안' && !partlyConfirmed) {
    fix = NO_FIX;
  } else if (fix.kind === '없음') {
    fix = NO_FIX;
  }

  // 편집 우선순위(5.4절): 모델이 매기고, 제목과 첫 문단의 문장은 코드가 '상'으로 올린다
  let priority: Priority | null = null;
  if (verdict !== '일치') {
    priority = pick(model.priority, ['상', '중', '하'] as Priority[], '중');
    if (claim.lead) priority = '상';
  }

  const used = new Set([...support, ...refute]);
  if (sources.some((s) => s.publisherUnlisted && used.has(s.sourceNo))) flags.push('발행 주체 확인 필요');

  return {
    verdict,
    modelVerdict,
    lowered,
    reason: short(model.reason, 400),
    action: verdict === '일치' ? '' : short(model.action, 200),
    priority,
    needChoice: verdict !== '일치' && (Boolean(model.need_choice) || (unresolved && verdict === '해석 주의')),
    flags,
    sources,
    links,
    evidence,
    qualifiers,
    conflict,
    fix,
    checkedAt: bundle.gatheredAt.slice(0, 10),
    sentenceKey: input.sentenceKey,
  };
}
