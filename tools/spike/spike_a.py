"""Stage A of the pre-PRD check: what do the Liner APIs actually return?

Reads LINER_API_KEY from the project's .env (never prints it) and makes a
handful of small calls: web search, scholar search, a chat completion,
routing strategies, structured output and tool calling.
Usage: python spike_a.py <env_file> <out_report>
"""
import json
import pathlib
import re
import sys
import time
import urllib.error
import urllib.request

BASE = "https://platform.liner.com/api/v1"


def load_key(env_file):
    text = pathlib.Path(env_file).read_text(encoding="utf-8-sig", errors="replace")
    m = re.search(r"^\s*LINER_API_KEY\s*=\s*(.*)$", text, re.M)
    key = m.group(1).strip().strip('"').strip("'") if m else ""
    if not key:
        raise SystemExit("LINER_API_KEY is not set")
    return key


def post(path, body, key, auth="bearer", timeout=120):
    headers = {"Content-Type": "application/json", "User-Agent": "whitechecker-spike/0.1"}
    if auth == "bearer":
        headers["Authorization"] = "Bearer " + key
    else:
        headers["x-api-key"] = key
    req = urllib.request.Request(BASE + path, data=json.dumps(body).encode("utf-8"), headers=headers, method="POST")
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read().decode("utf-8")), time.time() - t0, dict(r.headers)
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace")
        try:
            payload = json.loads(raw)
        except ValueError:
            payload = {"raw": raw[:500]}
        return e.code, payload, time.time() - t0, dict(e.headers)
    except Exception as e:  # timeouts, TLS, DNS
        return None, {"error": type(e).__name__ + ": " + str(e)[:200]}, time.time() - t0, {}


def clip(value, n=260):
    text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)
    return text if len(text) <= n else text[:n] + " …(%d자)" % len(text)


def main(env_file, out_path):
    key = load_key(env_file)
    out = []

    def section(title):
        out.append("")
        out.append("## " + title)

    # ---- search: web ------------------------------------------------------
    for label, body in [
        ("웹 검색 (기본값)", {"query": "천상열차분야지도 각석 제작 연도", "max_results": 5}),
        ("웹 검색 (include_knowledge=false)", {"query": "천상열차분야지도 각석 제작 연도", "max_results": 5, "include_knowledge": False}),
        ("웹 검색 (통계 질의, 기본값)", {"query": "대한민국 명승 지정 건수 현황", "max_results": 5}),
    ]:
        section(label)
        status, data, secs, _ = post("/tools/search/web", body, key, auth="x-api-key")
        out.append("- HTTP %s, %.2f초, 응답 키: %s" % (status, secs, sorted(data.keys()) if isinstance(data, dict) else type(data)))
        for r in (data.get("results") or [])[:5]:
            out.append("  - [%s] %s | date=%s | 설명 %d자 | 필드 %s" % (
                r.get("hostname"), clip(r.get("title", ""), 50), r.get("date"), len(r.get("description") or ""), sorted(r.keys())))
        if data.get("results"):
            out.append("  - 첫 결과 설명: " + clip(data["results"][0].get("description", ""), 300))
        if "knowledge" in data:
            for k in data["knowledge"][:3]:
                out.append("  - knowledge: %s | dataAsOf=%s | 열 %s | 행 %d | 출처 %s" % (
                    clip(k.get("title", ""), 60), k.get("dataAsOf"), clip(k.get("columns", ""), 80), len(k.get("rows") or []), clip(k.get("sources", ""), 120)))
        else:
            out.append("  - knowledge 키 없음")
        if status != 200:
            out.append("  - 오류 본문: " + clip(data, 400))

    # ---- search: scholar ---------------------------------------------------
    section("학술 검색")
    status, data, secs, _ = post("/tools/search/scholar", {"query": "천상열차분야지도 각석 암석 손상", "max_results": 5}, key, auth="x-api-key")
    out.append("- HTTP %s, %.2f초, 응답 키: %s" % (status, secs, sorted(data.keys()) if isinstance(data, dict) else type(data)))
    for r in (data.get("results") or [])[:5]:
        out.append("  - [%s] %s | %s | 인용 %s | 저자 %s | date=%s" % (
            r.get("hostname"), clip(r.get("title", ""), 60), r.get("journal"), r.get("citationCount"), clip(r.get("authors", ""), 50), r.get("date")))
    if status != 200:
        out.append("  - 오류 본문: " + clip(data, 400))

    # ---- model: plain chat, both auth styles -------------------------------
    section("모델 호출 (chat/completions)")
    ask = [{"role": "user", "content": "한 문장으로만 답하세요. 조선의 첫 번째 임금은 누구입니까?"}]
    auth_ok = None
    for auth in ("bearer", "x-api-key"):
        status, data, secs, _ = post("/chat/completions", {"model": "liner-claude-router", "messages": ask, "max_tokens": 100}, key, auth=auth)
        out.append("- 인증 방식 %s: HTTP %s, %.2f초" % (auth, status, secs))
        if status == 200:
            auth_ok = auth_ok or auth
            msg = data["choices"][0]["message"]
            out.append("  - 응답 모델: %s | usage: %s | 내용: %s" % (data.get("model"), json.dumps(data.get("usage"), ensure_ascii=False), clip(msg.get("content"), 120)))
        else:
            out.append("  - 오류 본문: " + clip(data, 300))
    auth_ok = auth_ok or "bearer"

    # ---- model: which model each router / strategy picks -------------------
    section("라우터와 라우팅 전략")
    medium = [{"role": "user", "content": "다음 문장에서 사실 확인이 필요한 명제를 번호를 매겨 뽑으세요: '창덕궁은 1405년에 지어진 조선의 두 번째 궁궐로, 1997년 유네스코 세계유산에 등재되었습니다.'"}]
    trials = [
        ("liner-claude-router", None), ("liner-claude-router-1.0", "cost"), ("liner-claude-router-1.0", "balanced"),
        ("liner-claude-router-1.0", "quality"), ("liner-gpt-router", None), ("liner-gemini-router", None), ("liner-mark", None),
    ]
    for model, strategy in trials:
        body = {"model": model, "messages": medium, "max_tokens": 300}
        if strategy:
            body["routing_strategy"] = strategy
        status, data, secs, _ = post("/chat/completions", body, key, auth=auth_ok)
        if status == 200:
            u = data.get("usage") or {}
            out.append("- %s%s: 응답 모델 %s, %.2f초, 입력 %s·출력 %s 토큰" % (
                model, " (" + strategy + ")" if strategy else "", data.get("model"), secs, u.get("prompt_tokens"), u.get("completion_tokens")))
        else:
            out.append("- %s%s: HTTP %s %s" % (model, " (" + strategy + ")" if strategy else "", status, clip(data, 220)))

    # ---- model: structured output ------------------------------------------
    section("구조화 출력")
    schema = {
        "type": "object", "additionalProperties": False,
        "properties": {"claims": {"type": "array", "items": {
            "type": "object", "additionalProperties": False,
            "properties": {"text": {"type": "string"}, "type": {"type": "string", "enum": ["연대", "지정", "수치", "기타"]}},
            "required": ["text", "type"]}}},
        "required": ["claims"],
    }
    formats = [
        ("json_schema", {"type": "json_schema", "json_schema": {"name": "claims", "strict": True, "schema": schema}}),
        ("json_object", {"type": "json_object"}),
    ]
    for label, fmt in formats:
        body = {"model": "liner-claude-router", "max_tokens": 400, "response_format": fmt, "messages": [
            {"role": "user", "content": "다음 문장의 사실 명제를 JSON으로 뽑으세요. 형식: {\"claims\":[{\"text\":..., \"type\": 연대|지정|수치|기타}]}\n문장: 창덕궁은 1405년에 지어졌고 1997년 유네스코 세계유산에 등재되었습니다."}]}
        status, data, secs, _ = post("/chat/completions", body, key, auth=auth_ok)
        if status == 200:
            content = data["choices"][0]["message"].get("content") or ""
            try:
                parsed = json.loads(content)
                ok = "유효한 JSON, 명제 %d개" % len(parsed.get("claims", []))
            except ValueError:
                ok = "JSON 파싱 실패"
            out.append("- %s: HTTP 200, %.2f초, %s | %s" % (label, secs, ok, clip(content, 200)))
        else:
            out.append("- %s: HTTP %s %s" % (label, status, clip(data, 260)))

    # ---- model: tool calling ------------------------------------------------
    section("도구 호출")
    tools = [{"type": "function", "function": {
        "name": "search_web", "description": "웹에서 근거를 검색한다",
        "parameters": {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]}}}]
    body = {"model": "liner-claude-router", "max_tokens": 300, "tools": tools, "tool_choice": "auto", "messages": [
        {"role": "user", "content": "'창덕궁은 1997년 유네스코 세계유산에 등재되었다'가 맞는지 확인하려고 합니다. 먼저 검색 도구를 호출하세요."}]}
    status, data, secs, _ = post("/chat/completions", body, key, auth=auth_ok)
    if status == 200:
        msg = data["choices"][0]["message"]
        calls = msg.get("tool_calls") or []
        out.append("- HTTP 200, %.2f초, 응답 모델 %s, 도구 호출 %d건: %s | finish_reason=%s" % (
            secs, data.get("model"), len(calls), clip([c.get("function") for c in calls], 200), data["choices"][0].get("finish_reason")))
    else:
        out.append("- HTTP %s %s" % (status, clip(data, 260)))

    pathlib.Path(out_path).write_text("\n".join(out) + "\n", encoding="utf-8")
    print("report lines:", len(out))


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
