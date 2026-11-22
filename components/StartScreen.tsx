// 시작 화면(PRD 9장 1번): 접속 코드, 원고 붙여넣기와 파일 올리기, 가상 원고, 고지 네 가지.
import { useRef } from 'react';

export interface Sample {
  id: string;
  label: string;
  text: string;
}

/** 원고의 글자 수 한도(F1의 수용 기준) */
export const MAX_CHARS = 10_000;

interface Props {
  code: string;
  onCode: (value: string) => void;
  draft: string;
  onDraft: (value: string) => void;
  samples: Sample[];
  error: string;
  onError: (message: string) => void;
  onStart: () => void;
  /** 돌아갈 검증 결과가 있는지 */
  hasRun: boolean;
  onBack: () => void;
}

export function StartScreen({ code, onCode, draft, onDraft, samples, error, onError, onStart, hasRun, onBack }: Props) {
  const fileInput = useRef<HTMLInputElement>(null);
  const over = draft.length > MAX_CHARS;

  async function readFile(file: File | undefined) {
    if (!file) return;
    onError('');
    if (!/\.(md|txt)$/i.test(file.name)) return onError('지원하지 않는 형식입니다. .md나 .txt 파일을 올려 주십시오.');
    if (file.size > 400_000) return onError(`파일이 너무 큽니다. 원고는 ${MAX_CHARS.toLocaleString()}자까지 넣을 수 있습니다.`);
    const text = (await file.text()).replace(/^﻿/, '');
    // UTF-8이 아닌 파일을 UTF-8로 읽으면 깨진 글자 표시가 섞인다
    if (text.includes('�')) return onError('UTF-8로 저장한 파일이 아닌 것 같습니다. UTF-8로 다시 저장해 올려 주십시오.');
    if (!text.trim()) return onError('파일에 내용이 없습니다.');
    onDraft(text);
  }

  function loadSample(sample: Sample) {
    if (draft.trim() && draft !== sample.text && !window.confirm('지금 적혀 있는 원고를 가상 원고로 바꿉니다. 계속할까요?')) return;
    onError('');
    onDraft(sample.text);
  }

  return (
    <div className="start">
      <div className="col">
        <h1>발행 전에, 원고의 사실부터 확인합니다</h1>
        <p className="lead">원고에서 사실 확인이 필요한 문장을 뽑아 공개 자료와 대조하고, 문장마다 판정과 근거, 수정안을 보여 드립니다.</p>

        {error && (
          <p className="alert" role="alert">
            {error}
          </p>
        )}

        <div className="field">
          <label htmlFor="access-code">
            접속 코드<span className="hint">심사와 시연을 위해 받은 코드를 넣습니다.</span>
          </label>
          <input
            id="access-code"
            className="code"
            type="password"
            value={code}
            onChange={(e) => onCode(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </div>

        <div className="field">
          <label htmlFor="manuscript">
            원고<span className="hint">붙여 넣거나 .md, .txt 파일을 올립니다.</span>
          </label>
          <textarea
            id="manuscript"
            className={over ? 'over' : undefined}
            value={draft}
            onChange={(e) => onDraft(e.target.value)}
            placeholder="여기에 원고를 붙여 넣습니다"
            spellCheck={false}
          />
          <div className="under">
            <button type="button" className="btn small" onClick={() => fileInput.current?.click()}>
              파일 올리기
            </button>
            <input
              ref={fileInput}
              type="file"
              accept=".md,.txt,text/markdown,text/plain"
              className="visually-hidden"
              tabIndex={-1}
              aria-hidden="true"
              onChange={(e) => {
                void readFile(e.target.files?.[0]);
                e.target.value = '';
              }}
            />
            {samples.map((sample) => (
              <button key={sample.id} type="button" className="btn small" onClick={() => loadSample(sample)} title={sample.label}>
                {samples.length > 1 ? `가상 원고: ${sample.label}` : '가상 원고 불러오기'}
              </button>
            ))}
            <span className={over ? 'count over' : 'count'}>
              {draft.length.toLocaleString()}자 / {MAX_CHARS.toLocaleString()}자
            </span>
          </div>
        </div>

        <div className="notice">
          <b>시작하기 전에</b>
          <ol>
            <li>화이트체커 서버는 원고를 저장하지 않습니다.</li>
            <li>이 브라우저에 원고와 검토 기록이 남습니다. &lsquo;이 기기의 기록 삭제&rsquo;로 지울 수 있습니다.</li>
            <li>원고 내용이 Liner API로 전송됩니다. 개인정보가 든 원고는 넣지 마십시오.</li>
            <li>전송된 내용의 보관과 삭제는 Liner의 정책을 따릅니다.</li>
          </ol>
        </div>

        <div className="go">
          <button type="button" className="btn primary" onClick={onStart} disabled={over}>
            검증 시작
          </button>
          {hasRun && (
            <button type="button" className="btn quiet" onClick={onBack}>
              앞서 한 검증 결과 보기
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
