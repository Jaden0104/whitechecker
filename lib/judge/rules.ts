// 모델의 판정을 그대로 믿지 않고 코드가 다시 검사한다(PRD 5.3절의 규칙 1~7번).
// 이 파일의 함수는 Liner를 부르지 않는다. 모델의 답과 근거 묶음만 받아 판정을 확정한다.
import { SINGLE_REFUTER_FLAG, TWO_PUBLISHERS_FLAG } from '../flags.ts';
import { institutionNames } from '../gather/excerpts.ts';
import type { ModelJudgment } from '../prompts/judge.ts';
import {
  FALLBACK_DOC_TYPE,
  STANDARD,
  excludedReason,
  finalGrade,
  isDocType,
  notEvidenceDocType,
  samePublisherName,
  siteOf,
  type RequirementOption,
} from '../standard.ts';
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
  /** asOf는 명제의 기준 시점이다. 없으면 지금의 사실로 본다 */
  claim: { statement: string; type: ClaimType; lead: boolean; asOf?: string };
  bundle: EvidenceBundle;
  model: ModelJudgment;
  sentenceKey: string;
}

/**
 * 기준 시점이 지난 해인지. 기준 시점에 적힌 연도가 모두 근거를 모은 해보다 앞서면 지난 때로 본다.
 * 연도가 없으면("현재", "이번 겨울") 지금으로 보고, 올해나 그 뒤의 연도가 하나라도 있으면(예: "2025년 12월~2026년 3월") 지금으로 본다
 */
export function isPastAsOf(asOf: string, gatheredAt: string): boolean {
  const thisYear = Number(gatheredAt.slice(0, 4));
  const years = [...asOf.matchAll(/(?<!\d)(1\d{3}|20\d{2})(?!\d)/g)].map((m) => Number(m[1]));
  return Number.isFinite(thisYear) && years.length > 0 && years.every((year) => year < thisYear);
}

type ModelVerdict = '일치' | '불일치' | '근거 부족' | '해석 주의';
const VERDICTS: ModelVerdict[] = ['일치', '불일치', '근거 부족', '해석 주의'];
const RELATIONS: Relation[] = ['지지', '반박', '판단 불충분'];
const APPLICABILITY: Applicability[] = ['적용 가능', '적용 불가', '미확인'];
const FIX_KINDS: FixKind[] = ['교정안', '인용형', '축소안', '없음'];
const QUALIFIER_RESULTS: QualifierCheck['result'][] = ['출처와 같다', '출처와 다르다', '확인하지 못했다'];
const NO_FIX: Fix = { kind: '없음', instruction: '', sourceNo: null };
/** 인용형의 고칠 내용. 출처의 이름을 밝히는 것 말고는 원고를 바꾸지 않도록 코드가 정해 둔 말만 쓴다 */
export const CITE_INSTRUCTION = '이 출처의 설명임을 밝혀 쓴다';
/** 글자와 숫자만 남기고 견줘 이만큼 이어서 같으면, 한쪽이 다른 쪽을 옮겼거나 둘이 같은 글을 옮긴 것으로 본다 */
const COPIED_RUN = 40;

/**
 * 셈을 해야 맞는지 알 수 있는 표현: 두 시점의 차이(3년 뒤, 87년 앞선다, 10년 만에)와 배수(2배).
 * 네 자리 수 뒤의 '년'은 연도이므로 치지 않는다. '전라북도'의 '전'처럼 다른 낱말의 첫 글자는 걸리지 않게 한다
 */
const RELATIVE =
  /(?<!\d)\d{1,3}\s*(여\s*)?(년|개월|달|주|일|시간|세기)\s*(이나\s*|가량\s*|쯤\s*|남짓\s*)?((뒤|후|전)(?![가-힣])|(뒤|후|전)(?=에|의|인|부터|까지|쯤|이[며고다]|입니다)|만에|앞(서|선|섭|당|지)|먼저|늦[게은었]|빠[르른]|빨리|이른)|(?<![\d.])\d+(\.\d+)?\s*배/;

/** 글에 적힌 '수와 단위'(78년, 2배 등). 쉼표와 '여'는 빼고 견준다. 예: "70여 년" → 70년 */
function amountsIn(text: string): Set<string> {
  const out = new Set<string>();
  const plain = text.replace(/(\d),(?=\d{3})/g, '$1');
  for (const m of plain.matchAll(/(?<![\d.])(\d+(?:\.\d+)?)\s*(?:여\s*)?(년|개월|달|주|일|시간|세기|배)/g)) out.add(`${m[1]}${m[2]}`);
  return out;
}

const lettersOnly = (text: string) =>
  text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');

/** 두 글에 길게 이어지는 같은 대목이 있는지. 띄어쓰기와 문장 부호의 차이는 무시한다 */
export function sharesLongRun(a: string, b: string, run: number = COPIED_RUN): boolean {
  const x = lettersOnly(a);
  const y = lettersOnly(b);
  if (x.length < run || y.length < run) return false;
  const seen = new Set<string>();
  for (let i = 0; i + run <= x.length; i += 1) seen.add(x.slice(i, i + run));
  for (let i = 0; i + run <= y.length; i += 1) if (seen.has(y.slice(i, i + run))) return true;
  return false;
}

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
    // 판정의 근거로 쓰지 않는 자료: 열지 않기로 한 사이트의 글(기준을 바꾸기 전에 모은 묶음에 남아 있을 수 있다)과,
    // 모델이 '위키'로 본 글(목록에 없는 위키를 열었을 때)
    const notUsed = excludedReason(info.hostname) || (notEvidenceDocType(docType) ? docType : '');
    sources.push({
      sourceNo: no,
      docType,
      publisher: short(rated?.publisher, 60),
      ownFact,
      grade,
      publisherUnlisted: grade === 1 && !info.publisherHint,
      ...(notUsed ? { notUsed } : {}),
    });
  }
  const ratingOf = (no: number) => sources.find((s) => s.sourceNo === no);
  const gradeOf = (no: number): Grade => ratingOf(no)?.grade ?? 3;
  /** 판정의 근거로 쓰지 않는 자료면 그 까닭(예: 위키), 아니면 빈 문자열 */
  const setAside = (no: number): string => ratingOf(no)?.notUsed ?? '';

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

  // 서로 다른 곳이 낸 글인지: 사이트가 다르고, 글을 낸 곳의 이름(기관 목록의 이름, 모델이 적은 발행 주체)도 서로 겹치지 않아야 한다.
  // 이름을 모르는 출처는 사이트로만 가린다
  const namesOf = (no: number) => [sourceByNo.get(no)?.publisherHint ?? '', ratingOf(no)?.publisher ?? ''].filter(Boolean);
  const samePublisher = (a: number, b: number) =>
    siteOf(sourceByNo.get(a)?.hostname ?? '') === siteOf(sourceByNo.get(b)?.hostname ?? '') ||
    namesOf(a).some((x) => namesOf(b).some((y) => samePublisherName(x, y)));
  const textsOf = (no: number) => bundle.evidence.filter((e) => e.sourceNo === no).map((e) => e.text);
  const copied = (a: number, b: number) => textsOf(a).some((x) => textsOf(b).some((y) => sharesLongRun(x, y)));
  /**
   * 서로 다른 확인으로 셀 수 있는 쌍인지. 모델이 독립의 단서를 찾지 못했더라도, 서로 다른 곳이 낸 글이고
   * 한쪽이 다른 쪽을 옮겨 적은 글이 아니며 모델이 '중복'으로 적지 않았으면 그렇게 센다
   */
  const apart = (a: number, b: number) => a !== b && rootOf(a) !== rootOf(b) && !samePublisher(a, b) && !copied(a, b);

  // 1번, 4번, 5번: 인용문이 그 번호의 발췌에 있어야 하고, 대상·범위·시점이 모두 적용 가능해야 판정에 쓴다.
  // 위키처럼 근거로 쓰지 않는 자료의 발췌는 지지로도 반박으로도 세지 않는다(2번)
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
      usable: quoteFound && applicable && relation !== '판단 불충분' && !setAside(item.sourceNo),
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
    if (claimed.some((u) => u.quoteFound && !setAside(u.sourceNo))) return { rule: '4번', note: `${relation} 근거의 대상·범위·시점이 모두 적용 가능하지 않다` };
    const aside = claimed.find((u) => u.quoteFound && setAside(u.sourceNo));
    if (aside) return { rule: '2번', note: `${relation} 근거가 판정에 쓰지 않는 자료(${setAside(aside.sourceNo)})뿐이다` };
    if (claimed.length > 0) return { rule: '1번', note: `${relation} 근거의 인용문이 발췌에 없다` };
    return { rule: '5번', note: `${relation} 근거가 없다` };
  };

  /**
   * 2번: '일치'에 필요한 근거(5.2절)를 채웠는지.
   * '서로 다른 곳'은 독립의 단서 없이, 서로 다른 곳이 낸 2등급 둘이라는 점만으로 채웠다는 뜻이다. 이때는 화면에 표시를 붙인다
   */
  const meets = (list: number[]): '채움' | '서로 다른 곳' | null => {
    const eligible = (o: RequirementOption) =>
      list.filter((no) => gradeOf(no) <= o.grade && (!o.docTypes || o.docTypes.includes(ratingOf(no)?.docType ?? '')));
    let byPublishers = false;
    for (const o of requirement?.anyOf ?? []) {
      const found = eligible(o);
      if (o.count <= 1) {
        if (found.length >= 1) return '채움';
      } else if (o.independent) {
        if (found.some((a) => found.some((b) => independent(a, b)))) return '채움';
        // 같은 기관의 글 둘이나 옮겨 적은 글 둘은 한 출처로 센다
        if (found.some((a) => found.some((b) => apart(a, b)))) byPublishers = true;
      } else if (unique(found.map(rootOf)).length >= o.count) {
        return '채움';
      }
    }
    return byPublishers ? '서로 다른 곳' : null;
  };

  // 셈이 필요한 명제(몇 년 뒤, 몇 배)는 모델이 값 하나를 잘못 읽으면 맞는 문장을 틀렸다고 하고 엉뚱한 값으로 고치라고 한다.
  // 그래서 이런 명제의 '불일치'와 교정안은, 바꿔 넣을 값(수와 단위)이 반박 근거의 발췌에 그대로 적혀 있을 때만 받는다.
  // 출처가 "78년 앞선다"처럼 다른 값을 직접 적었을 때다. 모델이 두 연도를 빼서 얻은 값은 받지 않는다
  const relative = RELATIVE.test(claim.statement);
  const modelFix = { kind: pick(model.fix?.kind, FIX_KINDS, '없음'), instruction: short(model.fix?.instruction, 200) };
  const groundedCorrection = (): boolean => {
    if (modelFix.kind !== '교정안') return false;
    const given = amountsIn(claim.statement);
    const added = [...amountsIn(modelFix.instruction)].filter((amount) => !given.has(amount));
    if (added.length === 0) return false;
    const stated = new Set(refute.flatMap((no) => textsOf(no)).flatMap((text) => [...amountsIn(text)]));
    return added.every((amount) => stated.has(amount));
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
      const met = meets(support);
      if (met) {
        if (met === '서로 다른 곳') flags.push(TWO_PUBLISHERS_FLAG);
        return { verdict: '일치' };
      }
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
      if (relative && !groundedCorrection()) {
        return { verdict: '근거 부족', rule: '5번', note: '셈을 해야 하는 명제인데, 원고와 다른 값을 직접 적은 근거가 없다(바꿔 넣을 값이 반박 근거의 발췌에 그대로 있어야 한다)' };
      }
      // 반박 근거가 2등급 자료 한 곳뿐이면 불일치로 두되 표시한다. 그 자료가 틀렸거나 자료마다 값이 다를 수 있기 때문이다.
      // 같은 기관의 글 둘이나 옮겨 적은 글 둘도 한 곳으로 센다. 이 표시가 붙으면 화면 쪽 진행이 한 번 더 찾아본다(보강 검색)
      const strong = refute.filter((no) => gradeOf(no) <= 2);
      if (top(refute) === 2 && !strong.some((a) => strong.some((b) => apart(a, b)))) flags.push(SINGLE_REFUTER_FLAG);
      return { verdict: '불일치' };
    }

    if (wanted === '해석 주의') {
      // 같은 대상을 다루는 근거가 하나는 있어야 '해석 주의'라고 말할 수 있다. 위키만 있으면 그렇게 말하지 않는다
      const anchored = evidence.some((u) => u.quoteFound && u.target === '적용 가능' && !setAside(u.sourceNo));
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
  const sameTarget = evidence.some((u) => u.quoteFound && u.target === '적용 가능' && !setAside(u.sourceNo));
  const looseQualifier = qualifiers.some((q) => q.result !== '출처와 같다');
  const partlyConfirmed = evidence.some((u) => u.usable) || (sameTarget && looseQualifier);

  // 수정 방향(F7): 교정안은 '불일치'일 때만, 인용형은 원고와 같은 내용을 적은 2등급 이상의 출처가 있을 때만 둔다
  let fix: Fix = {
    kind: pick(model.fix?.kind, FIX_KINDS, '없음'),
    instruction: short(model.fix?.instruction, 200),
    sourceNo: model.fix?.source_no && ratingOf(model.fix.source_no) ? model.fix.source_no : null,
  };
  /** 글에 적힌 수(두 자리 이상). 쉼표는 빼고 견준다 */
  const numbersIn = (text: string) => new Set((text.replace(/(\d),(?=\d{3})/g, '$1').match(/\d+(?:\.\d+)?/g) ?? []).filter((n) => n.replace(/\D/g, '').length >= 2));
  const numbersOfSource = (no: number) => numbersIn(textsOf(no).join('\n'));
  /**
   * 인용형으로 이름을 밝혀도 되는 출처인지. "그 출처에 따르면"이라는 말이 사실이어야 하므로 아래를 모두 채워야 한다.
   * - 2등급 이상이고, 원고와 같은 내용을 적은 근거(판정에 쓴 지지 근거)가 그 출처에 있다
   * - 명제에 적힌 수(연도, 수량)와 기관 이름이 그 출처의 발췌에 모두 있다.
   *   모델이 명제의 일부만 확인해 준 근거를 지지로 적는 일이 있어, 값이나 이름이 다른 출처의 이름을 붙이지 않도록 코드가 한 번 더 본다
   */
  const citable = (no: number | null): no is number => {
    if (no === null || gradeOf(no) > 2 || !support.includes(no)) return false;
    const squeezed = textsOf(no).join('\n').replace(/\s+/g, '');
    return [...numbersIn(claim.statement)].every((n) => numbersOfSource(no).has(n)) && institutionNames(claim.statement).every((name) => squeezed.includes(name));
  };
  // 인용형의 고칠 내용은 코드가 정해 둔 말만 쓴다. 모델이 덧붙인 말(다른 표현으로 바꿔 쓰라는 것 등)은 수정안에 넣지 않는다
  const citing = (no: number): Fix => ({ kind: '인용형', instruction: CITE_INSTRUCTION, sourceNo: no });
  // 이름을 밝힐 출처는 모델이 고른 것만 받는다. 코드가 다른 지지 출처로 바꿔 넣지 않는다.
  // 지지로 적힌 근거가 명제의 일부만 확인해 준 것일 때가 있어, 코드가 고르면 확인하지 않은 부분까지 그 출처의 말이 된다
  const chosen = fix.kind === '인용형' && citable(fix.sourceNo) ? fix.sourceNo : undefined;
  if (verdict === '일치') {
    fix = NO_FIX;
  } else if (unresolved && verdict === '해석 주의') {
    // 근거가 엇갈린 명제에는 교정안을 그대로 내지 않는다
    const fromRefute = refute.filter((no) => gradeOf(no) <= 2).sort((a, b) => gradeOf(a) - gradeOf(b))[0];
    const added = [...numbersIn(fix.instruction)].filter((n) => !numbersIn(claim.statement).has(n));
    if (chosen !== undefined) {
      // 모델이 고른 출처가 원고와 같은 내용을 적고 있으면 그 이름을 밝힌다
      fix = citing(chosen);
    } else if (
      fromRefute !== undefined &&
      conflict.supportTop === 3 &&
      fix.kind === '교정안' &&
      fix.instruction &&
      added.every((n) => numbersOfSource(fromRefute).has(n)) &&
      (!relative || groundedCorrection())
    ) {
      // 모델은 틀렸다고 봤는데 3등급 자료의 지지가 섞여 '해석 주의'가 된 경우다. 원고와 다르게 적은 2등급 이상 출처의 내용으로 바꾸고 그 이름을 밝힌다.
      // 지지 쪽에도 2등급 이상 출처가 있으면 이렇게 하지 않는다. 믿을 만한 출처끼리 엇갈릴 때 한쪽 값으로 바꾸면 맞는 원고를 틀리게 고칠 수 있다.
      // 바꿔 넣을 수가 그 출처의 발췌에 있어야 한다. 반박 출처가 여럿이고 값이 서로 다를 수 있기 때문이다.
      // 수정안에 밝힐 이름과 같은 순서로 고른다(lib/merge/plan.ts의 citedSourceName): 기관 목록의 이름, 판정이 적은 발행 주체, 사이트 주소
      const info = sourceByNo.get(fromRefute);
      const name = info?.publisherHint || ratingOf(fromRefute)?.publisher || info?.hostname.replace(/^www\./, '') || '';
      fix = { kind: '인용형', instruction: `출처(${name})의 설명임을 밝혀 쓴다. 그 출처의 내용: ${fix.instruction}`.slice(0, 200), sourceNo: fromRefute };
    } else {
      // 원고와 다르게 적은 출처의 이름을 붙이면서 원고의 내용을 그대로 두지는 않는다
      fix = NO_FIX;
    }
  } else if (fix.kind === '교정안' && verdict !== '불일치') {
    fix = NO_FIX;
  } else if (fix.kind === '인용형') {
    fix = chosen === undefined ? NO_FIX : citing(chosen);
  } else if (fix.kind === '축소안' && !partlyConfirmed) {
    fix = NO_FIX;
  } else if (fix.kind === '없음') {
    fix = NO_FIX;
  }

  // 편집 우선순위(5.4절): 모델이 매기고, 제목과 첫 문단의 문장과 지금의 운영 정보는 코드가 '상'으로 올린다.
  // 운영 정보(관람 시간, 요금, 휴관일, 행사 기간과 장소)는 독자가 그대로 따르는 안내라, 틀리면 독자가 헛걸음을 한다.
  // 같은 종류의 문장이 모델의 답에 따라 '상'이 되기도 '중'이 되기도 해서 코드가 정한다.
  // 기준 시점이 지난 해인 것(예: 개관한 해의 입장료)은 지난 일의 사실이므로 모델이 매긴 값을 둔다
  let priority: Priority | null = null;
  if (verdict !== '일치') {
    priority = pick(model.priority, ['상', '중', '하'] as Priority[], '중');
    if (claim.lead || (claim.type === '운영 정보' && !isPastAsOf(claim.asOf ?? '', bundle.gatheredAt))) priority = '상';
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
