// 근거 묶음의 식별값과 서명.
// 서명은 근거가 수집 당시와 같은지 확인하는 장치다. 화면이 묶음을 보관했다가 판정 요청에 다시 실어 보내므로,
// 그 사이에 발췌가 바뀌거나 다른 명제의 근거와 섞이지 않았는지를 서버가 확인한다.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { ClaimCore, EvidenceBundle } from './types.ts';

/** 키의 순서와 상관없이 같은 내용이면 같은 글자열이 되게 적는다 */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((k) => record[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(record[k])}`).join(',')}}`;
}

/** 명제의 식별값. 문장이나 유형, 기준 시점이 달라지면 값도 달라진다 */
export function claimKey(claim: ClaimCore): string {
  const text = canonical([claim.statement, claim.type, claim.asOf, claim.qualifiers]);
  return createHash('sha256').update(text).digest('hex').slice(0, 32);
}

// 서명에 쓰는 비밀값은 그 요청에 쓰는 Liner 키에서 만들어 낸다. 키 자체는 묶음에도 서명에도 들어가지 않는다.
function secretFrom(linerKey: string): Buffer {
  return createHmac('sha256', linerKey).update('whitechecker:evidence:v1').digest();
}

export function signBundle(bundle: EvidenceBundle, linerKey: string): string {
  return createHmac('sha256', secretFrom(linerKey)).update(canonical(bundle)).digest('base64url');
}

/** 서명이 맞고, 묶음이 이 명제의 것인지 확인한다 */
export function verifyBundle(bundle: EvidenceBundle, signature: string, claim: ClaimCore, linerKey: string): boolean {
  if (!bundle || typeof signature !== 'string' || bundle.claimKey !== claimKey(claim)) return false;
  const expected = Buffer.from(signBundle(bundle, linerKey));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}
