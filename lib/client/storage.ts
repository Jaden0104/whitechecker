// 브라우저에 남기는 기록(PRD 7장 '저장', F17). 서버는 아무것도 저장하지 않으므로, 원고와 검증 결과는 이 기기의 브라우저에만 남는다.
// 근거 묶음까지 담으면 수 MB가 될 수 있어 IndexedDB에 둔다. 접속 코드는 탭을 닫으면 지워지는 sessionStorage에만 둔다.
import { recover, type RunState } from '../run/model.ts';

const DB_NAME = 'whitechecker';
const STORE = 'kv';
const RUN_KEY = 'run';
const ACCESS_KEY = 'whitechecker:access';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('blocked'));
  });
}

function done(request: IDBRequest): Promise<unknown> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** 저장해 둔 실행을 읽는다. 돌던 항목은 '중단'으로 바꿔 돌려준다. 읽지 못하면 null */
export async function loadRun(): Promise<RunState | null> {
  try {
    const db = await openDb();
    const value = (await done(db.transaction(STORE, 'readonly').objectStore(STORE).get(RUN_KEY))) as RunState | undefined;
    db.close();
    return value && value.v === 1 && Array.isArray(value.claims) ? recover(value) : null;
  } catch {
    return null;
  }
}

/** 실행을 저장한다. null이면 지운다. 저장하지 못해도 화면은 계속 돈다 */
export async function saveRun(run: RunState | null): Promise<boolean> {
  try {
    const db = await openDb();
    const store = db.transaction(STORE, 'readwrite').objectStore(STORE);
    await done(run ? store.put(run, RUN_KEY) : store.delete(RUN_KEY));
    db.close();
    return true;
  } catch {
    return false;
  }
}

/** 이 기기의 기록을 모두 지운다: 원고, 검증 결과, 접속 코드 */
export async function clearRecords(): Promise<void> {
  try {
    sessionStorage.removeItem(ACCESS_KEY);
  } catch {
    // 저장소를 쓸 수 없는 환경이면 지울 것도 없다
  }
  await new Promise<void>((resolve) => {
    try {
      const request = indexedDB.deleteDatabase(DB_NAME);
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
      request.onblocked = () => resolve();
    } catch {
      resolve();
    }
  });
}

export function loadAccessCode(): string {
  try {
    return sessionStorage.getItem(ACCESS_KEY) ?? '';
  } catch {
    return '';
  }
}

export function saveAccessCode(code: string): void {
  try {
    if (code) sessionStorage.setItem(ACCESS_KEY, code);
    else sessionStorage.removeItem(ACCESS_KEY);
  } catch {
    // 저장하지 못하면 새로 고쳤을 때 다시 넣으면 된다
  }
}
