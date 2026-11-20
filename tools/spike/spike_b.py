"""Stage B of the pre-PRD check: a miniature end-to-end run.

A short made-up manuscript (public facts about one artefact, with errors
planted on purpose and two sentences that no public source can confirm) goes
through: claim extraction -> search -> page fetch -> verdict. Measures time,
tokens and cost so the PRD can state realistic targets.
Usage: python spike_b.py <env_file> <out_report>
"""
import concurrent.futures as cf
import json
import pathlib
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

BASE = "https://platform.liner.com/api/v1"
PRICE = {  # USD per 1M tokens (input, output), from the pricing page
    "claude-haiku-5.5": (0.10, 0.50), "claude-sonnet-5.5": (2.0, 10.0), "claude-opus-5.5": (4.0, 20.0),
    "claude-fable-5.1": (10.0, 50.0),
}

MANUSCRIPT = """만 원권 지폐 뒷면의 바탕에는 천상열차분야지도가 그려져 있습니다. 이 도안은 2007년 1월부터 쓰이고 있습니다.
천상열차분야지도 각석의 원본은 1396년에 새긴 돌로, 지금은 서울의 국립중앙박물관에 있습니다.
돌의 크기는 세로 311cm, 가로 123cm입니다. 2018년 조사에서는 이 돌이 암갈색 점판암으로 확인됐습니다.
이 각석은 세계에서 가장 오래된 석각 천문도입니다.
저희 뉴스레터 구독자는 지난달 3만 명을 넘었습니다. 박물관 관계자는 "내년 봄에 특별전을 연다"고 말했습니다.
국립고궁박물관은 매일 오전 10시부터 오후 6시까지 문을 엽니다."""

# what was planted: (keyword that identifies the claim, expected verdict)
PLANTED = [
    ("1396", "불일치"), ("국립중앙박물관", "불일치"), ("311", "불일치"), ("가장 오래된", "불일치 또는 해석 주의"),
    ("구독자", "직접 확인"), ("특별전", "직접 확인"), ("만 원권", "일치"), ("2007", "일치"), ("점판암", "일치"),
]

TYPES = ["인용·출처 귀속", "수치·통계", "분류·지정", "운영 정보", "연대·인명·기관명", "통설", "최상급", "인과", "기타"]
EXTRACT_SCHEMA = {
    "type": "object", "additionalProperties": False, "required": ["claims"],
    "properties": {"claims": {"type": "array", "items": {
        "type": "object", "additionalProperties": False,
        "required": ["id", "sentence", "claim", "type", "qualifiers", "public", "queries"],
        "properties": {
            "id": {"type": "integer"}, "sentence": {"type": "string"}, "claim": {"type": "string"},
            "type": {"type": "string", "enum": TYPES}, "qualifiers": {"type": "array", "items": {"type": "string"}},
            "public": {"type": "boolean"}, "queries": {"type": "array", "items": {"type": "string"}},
        }}}},
}
VERDICTS = ["일치", "불일치", "근거 부족", "해석 주의", "직접 확인"]
JUDGE_SCHEMA = {
    "type": "object", "additionalProperties": False,
    "required": ["verdict", "risk", "evidence_quote", "evidence_url", "reason", "suggestion"],
    "properties": {
        "verdict": {"type": "string", "enum": VERDICTS}, "risk": {"type": "string", "enum": ["상", "중", "하", "해당 없음"]},
        "evidence_quote": {"type": "string"}, "evidence_url": {"type": "string"},
        "reason": {"type": "string"}, "suggestion": {"type": "string"},
    },
}


def load_key(env_file):
    text = pathlib.Path(env_file).read_text(encoding="utf-8-sig", errors="replace")
    m = re.search(r"^\s*LINER_API_KEY\s*=\s*(.*)$", text, re.M)
    key = m.group(1).strip().strip('"').strip("'") if m else ""
    if not key:
        raise SystemExit("LINER_API_KEY is not set")
    return key


def post(path, body, key, timeout=180):
    req = urllib.request.Request(BASE + path, data=json.dumps(body).encode("utf-8"), method="POST", headers={
        "Content-Type": "application/json", "x-api-key": key, "Authorization": "Bearer " + key, "User-Agent": "whitechecker-spike/0.1"})
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read().decode("utf-8")), time.time() - t0
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace")
        try:
            return e.code, json.loads(raw), time.time() - t0
        except ValueError:
            return e.code, {"raw": raw[:400]}, time.time() - t0
    except Exception as e:
        return None, {"error": type(e).__name__ + ": " + str(e)[:200]}, time.time() - t0


USAGE = []  # (stage, model, prompt_tokens, completion_tokens, seconds)


def chat(stage, messages, schema, name, key, model="liner-claude-router", strategy=None, max_tokens=2000):
    body = {"model": model, "messages": messages, "max_tokens": max_tokens,
            "response_format": {"type": "json_schema", "json_schema": {"name": name, "strict": True, "schema": schema}}}
    if strategy:
        body["routing_strategy"] = strategy
    status, data, secs = post("/chat/completions", body, key)
    if status != 200:
        raise RuntimeError("%s: HTTP %s %s" % (stage, status, json.dumps(data, ensure_ascii=False)[:300]))
    u = data.get("usage") or {}
    USAGE.append((stage, data.get("model"), u.get("prompt_tokens", 0), u.get("completion_tokens", 0), secs))
    return json.loads(data["choices"][0]["message"]["content"])


def grade(host):
    host = (host or "").lower()
    if host.endswith(".go.kr") or host in ("bok.or.kr", "www.bok.or.kr", "whc.unesco.org"):
        return 1
    if "encykorea" in host or host.endswith(".ac.kr") or any(s in host for s in ("koreascience", "dbpia", "kci.go.kr", "kiss.kstudy", "riss")):
        return 2
    return 3


def fetch_text(url):
    safe = urllib.parse.quote(url, safe=":/?&=%#")
    req = urllib.request.Request(safe, headers={"User-Agent": "WhiteCheckerPrototype/0.1 (fact-check research)", "Accept-Language": "ko,en;q=0.8"})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            raw = r.read(2_000_000)
            ctype = r.headers.get("Content-Type", "")
    except Exception:
        return ""
    if "pdf" in ctype.lower():
        return ""
    m = re.search(r"charset=([\w-]+)", ctype, re.I) or re.search(rb"charset=[\"']?([\w-]+)", raw[:3000], re.I)
    charset = (m.group(1).decode() if m and isinstance(m.group(1), bytes) else (m.group(1) if m else "utf-8")).lower()
    try:
        html = raw.decode(charset, "replace")
    except LookupError:
        html = raw.decode("utf-8", "replace")
    text = re.sub(r"(?is)<(script|style|noscript)[^>]*>.*?</\1>", " ", html)
    text = re.sub(r"(?s)<[^>]+>", " ", text)
    return re.sub(r"\s+", " ", text)


def passages(text, claim, limit=1500):
    """Pick the chunks of a page that share the most keywords with the claim."""
    words = set(re.findall(r"[가-힣]{2,}|\d+", claim))
    chunks = [text[i:i + 300] for i in range(0, min(len(text), 60000), 250)]
    scored = sorted(((sum(1 for w in words if w in c), i, c) for i, c in enumerate(chunks)), reverse=True)
    picked = sorted((i, c) for s, i, c in scored[:5] if s > 0)
    return " … ".join(c for _, c in picked)[:limit]


def check_claim(claim, key):
    t0 = time.time()
    timing = {}
    if not claim["public"]:
        return {"verdict": "직접 확인", "risk": "해당 없음", "evidence_quote": "", "evidence_url": "",
                "reason": "추출 단계에서 공개 자료로 확인할 수 없는 정보로 분류", "suggestion": ""}, {"total": 0.0}, []
    # search
    s0 = time.time()
    hits = {}
    with cf.ThreadPoolExecutor(max_workers=2) as pool:
        for status, data, _ in pool.map(lambda q: post("/tools/search/web", {"query": q, "max_results": 5, "include_knowledge": False}, key), claim["queries"][:2]):
            for r in (data.get("results") or []) if status == 200 else []:
                if "youtube" not in (r.get("hostname") or ""):
                    hits.setdefault(r["url"], r)
    timing["search"] = time.time() - s0
    ranked = sorted(hits.values(), key=lambda r: grade(r.get("hostname")))[:3]
    # fetch
    f0 = time.time()
    with cf.ThreadPoolExecutor(max_workers=3) as pool:
        texts = list(pool.map(lambda r: fetch_text(r["url"]), ranked))
    timing["fetch"] = time.time() - f0
    blocks = []
    for r, text in zip(ranked, texts):
        blocks.append("[출처 등급 %d] %s (%s)\n검색 요약: %s\n원문 발췌: %s" % (
            grade(r.get("hostname")), r.get("title"), r.get("url"), r.get("description"), passages(text, claim["claim"]) or "(원문을 읽지 못함)"))
    # judge
    j0 = time.time()
    prompt = (
        "당신은 원고의 사실 명제를 공개 자료와 대조하는 검증자입니다.\n"
        "규칙: (1) '원문 발췌'에 근거 문장이 있을 때만 일치 또는 불일치로 판정합니다. 검색 요약만으로는 판정하지 않습니다. "
        "(2) 근거가 없거나 3등급 출처뿐이면 '근거 부족'. (3) 출처가 엇갈리거나 한정 표현(가장, 최초, 유일 등)이 출처와 다르면 '해석 주의' 또는 '불일치'. "
        "(4) 불일치에는 고친 완성 문장을 suggestion에 적고 위험도를 매깁니다. (5) evidence_quote에는 원문 발췌에서 그대로 옮긴 구절만 적습니다.\n\n"
        "원고 문장: %s\n검증할 명제: %s\n유형: %s\n한정 표현: %s\n\n자료:\n%s" % (
            claim["sentence"], claim["claim"], claim["type"], ", ".join(claim["qualifiers"]) or "없음", "\n\n".join(blocks) or "(검색 결과 없음)"))
    result = chat("judge", [{"role": "user", "content": prompt}], JUDGE_SCHEMA, "verdict", key, max_tokens=900)
    timing["judge"] = time.time() - j0
    timing["total"] = time.time() - t0
    return result, timing, [(grade(r.get("hostname")), r.get("hostname"), len(t)) for r, t in zip(ranked, texts)]


def main(env_file, out_path):
    key = load_key(env_file)
    out = []
    # ---- does Premium Data ever come back? --------------------------------
    out.append("## Premium Data(knowledge) 확인")
    for q in ("한국은행 기준금리 추이", "삼성전자 2025년 연간 매출", "대한민국 인구 2025"):
        status, data, secs = post("/tools/search/web", {"query": q, "max_results": 3}, key)
        ks = data.get("knowledge") if isinstance(data, dict) else None
        if ks:
            k = ks[0]
            out.append("- '%s': knowledge %d건, 첫 항목 제목 %s | dataAsOf=%s | 열 %s | 행 %d" % (
                q, len(ks), str(k.get("title"))[:50], k.get("dataAsOf"), json.dumps(k.get("columns"), ensure_ascii=False)[:120], len(k.get("rows") or [])))
        else:
            out.append("- '%s': HTTP %s, knowledge 없음 (%.1f초)" % (q, status, secs))

    # ---- extraction ---------------------------------------------------------
    t_all = time.time()
    e0 = time.time()
    extraction = chat("extract", [{"role": "user", "content": (
        "아래 원고에서 사실 확인이 필요한 명제를 빠짐없이 뽑으세요. 한 문장에 명제가 여럿이면 나눕니다. "
        "각 명제마다 유형, 문장에 든 한정 표현(가장, 최초, 유일, 모든, 매일 등), 공개 자료로 확인 가능한지(public: 내부 수치나 직접 들은 말이면 false), "
        "검색어 2개(queries: 공식 기관이나 원자료가 나오도록)를 적습니다.\n\n원고:\n" + MANUSCRIPT)}],
        EXTRACT_SCHEMA, "claims", key, max_tokens=3000)
    claims = extraction["claims"]
    t_extract = time.time() - e0
    out.append("")
    out.append("## 명제 추출")
    out.append("- 원고 %d자 → 명제 %d개, %.1f초" % (len(MANUSCRIPT), len(claims), t_extract))

    # ---- verification, 5 claims at a time ------------------------------------
    v0 = time.time()
    with cf.ThreadPoolExecutor(max_workers=5) as pool:
        results = list(pool.map(lambda c: check_claim(c, key), claims))
    t_verify = time.time() - v0
    t_total = time.time() - t_all

    out.append("")
    out.append("## 명제별 결과")
    out.append("| # | 명제 | 유형 | 공개 | 판정 | 위험 | 근거 출처(등급, 읽은 글자 수) | 초 |")
    out.append("| --- | --- | --- | --- | --- | --- | --- | --- |")
    for c, (res, timing, sources) in zip(claims, results):
        src = ", ".join("%d급 %s(%d)" % s for s in sources) or "-"
        out.append("| %d | %s | %s | %s | %s | %s | %s | %.1f |" % (
            c["id"], c["claim"][:44], c["type"], "예" if c["public"] else "아니오", res["verdict"], res["risk"], src[:110], timing.get("total", 0)))
    out.append("")
    out.append("## 판정 상세 (불일치·해석 주의·근거 부족만)")
    for c, (res, timing, sources) in zip(claims, results):
        if res["verdict"] in ("불일치", "해석 주의", "근거 부족"):
            out.append("- #%d %s → %s" % (c["id"], c["claim"][:60], res["verdict"]))
            out.append("  - 사유: %s" % res["reason"][:220])
            out.append("  - 근거 인용: %s (%s)" % (res["evidence_quote"][:160], res["evidence_url"][:90]))
            out.append("  - 수정안: %s" % res["suggestion"][:160])

    out.append("")
    out.append("## 심어 둔 오류의 판정")
    for keyword, expected in PLANTED:
        found = [(c, r) for c, (r, _, _) in zip(claims, results) if keyword in c["claim"] or keyword in c["sentence"]]
        got = ", ".join(sorted({r["verdict"] for _, r in found})) or "명제로 추출되지 않음"
        out.append("- '%s': 기대 %s → 실제 %s" % (keyword, expected, got))

    out.append("")
    out.append("## 시간")
    steps = collections_sum(results)
    out.append("- 전체 %.1f초 = 추출 %.1f초 + 검증 %.1f초(명제 %d개를 5개씩 동시에)" % (t_total, t_extract, t_verify, len(claims)))
    out.append("- 공개 명제 1개당 평균: 검색 %.1f초, 원문 수집 %.1f초, 판정 %.1f초, 합계 %.1f초" % steps)

    out.append("")
    out.append("## 토큰과 비용")
    cost = 0.0
    by = {}
    for stage, model, pt, ct, secs in USAGE:
        pin, pout = PRICE.get(model, (2.0, 10.0))
        c = pt / 1e6 * pin + ct / 1e6 * pout
        cost += c
        b = by.setdefault((stage, model), [0, 0, 0, 0.0])
        b[0] += 1; b[1] += pt; b[2] += ct; b[3] += c
    for (stage, model), (n, pt, ct, c) in sorted(by.items()):
        out.append("- %s / %s: 호출 %d회, 입력 %d·출력 %d 토큰, 약 $%.4f" % (stage, model, n, pt, ct, c))
    n_public = sum(1 for c in claims if c["public"])
    searches = 2 * n_public
    out.append("- 검색 %d회(Premium Data 제외, 1,000건당 $1) 약 $%.4f" % (searches, searches * 0.001))
    out.append("- 이번 실행 합계 약 $%.4f (명제 %d개, 그중 공개 %d개)" % (cost + searches * 0.001, len(claims), n_public))
    if n_public:
        per = (cost + searches * 0.001) / len(claims)
        out.append("- 명제 1개당 약 $%.4f → 명제 100개 원고는 약 $%.2f, 150개는 약 $%.2f" % (per, per * 100, per * 150))

    pathlib.Path(out_path).write_text("\n".join(out) + "\n", encoding="utf-8")
    print("claims:", len(claims), "| total seconds: %.1f" % t_total)


def collections_sum(results):
    rows = [t for _, t, _ in results if t.get("search") is not None]
    n = len(rows) or 1
    return (sum(t["search"] for t in rows) / n, sum(t["fetch"] for t in rows) / n, sum(t["judge"] for t in rows) / n,
            sum(t["total"] for t in rows) / n)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
