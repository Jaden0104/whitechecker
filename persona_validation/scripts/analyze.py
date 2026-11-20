"""Compute the pre-registered indicators and verdicts (see 01_설계와_판정기준.md).

Usage: python analyze.py <study_dir>
Reads  personas.jsonl, responses.jsonl
Writes results_auto.md (tables and mechanical verdicts), freetext.txt (open answers)
"""
import collections
import json
import pathlib
import sys

TARGET = ["G1", "G2", "G3", "G4"]
GROUP_NAME = {"G1": "언론", "G2": "홍보·마케팅", "G3": "공공", "G4": "출판·콘텐츠", "G5": "통제군"}
H2_TYPES = ["E_SECONDARY", "E_QUALIFIER", "E_DRIFT", "E_STALE"]
FOILS = ["E_FABRICATED", "E_NUMERIC", "E_NAMES"]
ERR_NAME = {
    "E_SECONDARY": "T1 2차 자료 의존", "E_QUALIFIER": "T2 한정어", "E_DRIFT": "T3 검증 뒤 변형", "E_STALE": "T4 시차",
    "E_FABRICATED": "F1 AI가 지어낸 출처", "E_NUMERIC": "F2 숫자 단위·계산", "E_NAMES": "F3 인명·기관명", "NONE": "없음",
}
STEP_NAME = {
    "PLAN": "기획·자료 조사", "DRAFT": "초안 작성", "FACT": "사실관계·출처 재확인", "POLISH": "문장 다듬기·교정",
    "APPROVAL": "내부 검토·승인 대응", "PRODUCTION": "디자인·편집·배포", "AFTERCARE": "내보낸 뒤 문의·정정",
}
TOOLS = ["CLAIMTABLE", "AISEARCH", "SCORE", "CURRENT"]
PURPOSE_KEYS = ["사실", "팩트", "출처", "검증", "정확"]


def load(study):
    people = {}
    for line in (study / "personas.jsonl").read_text(encoding="utf-8").splitlines():
        p = json.loads(line)
        people[p["pid"]] = p
    rows = []
    for line in (study / "responses.jsonl").read_text(encoding="utf-8").splitlines():
        if line.strip():
            rows.append(json.loads(line))
    return people, rows


def pct(k, n):
    return 100.0 * k / n if n else float("nan")


def cell(k, n):
    return "%d/%d (%.0f%%)" % (k, n, pct(k, n)) if n else "0/0"


def count(rows, pred):
    return sum(1 for r in rows if pred(r)), len(rows)


def fact_top3(r):
    return "FACT" in r["s1"]["top3"]


def mean(vals):
    vals = list(vals)
    return sum(vals) / len(vals) if vals else float("nan")


SHARE_KEYS = ["share_plan", "share_draft", "share_fact", "share_polish", "share_approval", "share_production", "share_aftercare"]


def fact_share(r):
    """Share of total time spent on fact re-checking (Q1-2), normalised to 100."""
    s1 = r["s1"]
    if not all(k in s1 for k in SHARE_KEYS):
        return None
    total = sum(max(0, s1[k]) for k in SHARE_KEYS)
    return 100.0 * max(0, s1["share_fact"]) / total if total else None


def mean_share(rows):
    vals = [v for v in (fact_share(r) for r in rows) if v is not None]
    return "%.0f%%" % mean(vals) if vals else "자료 없음"


def dist(rows, getter, keys):
    c = collections.Counter(getter(r) for r in rows)
    return " / ".join("%s %s" % (k, cell(c.get(k, 0), len(rows))) for k in keys)


def verdict_line(name, verdict, why, flags=()):
    tail = (" [주의: %s]" % ", ".join(flags)) if flags else ""
    return "- **%s: %s**%s — %s" % (name, verdict, tail, why)


def main(study_dir):
    study = pathlib.Path(study_dir)
    people, rows = load(study)
    for r in rows:
        r["p"] = people[r["pid"]]
    main_rows = [r for r in rows if r.get("run", 1) == 1 and r.get("s1") and r.get("s2")]
    rep_rows = {r["pid"]: r for r in rows if r.get("run", 1) == 2 and r.get("s1") and r.get("s2")}
    incomplete = [r["pid"] for r in rows if r.get("run", 1) == 1 and not (r.get("s1") and r.get("s2"))]

    G = {g: [r for r in main_rows if r["p"]["group"] == g] for g in GROUP_NAME}
    T = [r for r in main_rows if r["p"]["group"] in TARGET]
    C = G["G5"]
    T_ai = [r for r in T if r["p"]["ai"]]
    T_noai = [r for r in T if not r["p"]["ai"]]
    T_core = [r for r in T if r["p"]["ai"] and not r["p"]["reviewed"]]

    out = ["# 합성 페르소나 조사: 자동 집계 결과", ""]
    out.append("- 완료 응답: %d명 (대상 T %d명, 통제군 C %d명), 반복 실행 %d명" % (len(main_rows), len(T), len(C), len(rep_rows)))
    if incomplete:
        out.append("- 미완료 응답: " + ", ".join(sorted(incomplete)))
    out.append("")

    # ---- validity checks -------------------------------------------------
    flags = collections.defaultdict(list)
    out += ["## 조사 자체의 점검", ""]
    kc, nc = count(C, fact_top3)
    kt, nt = count(T, fact_top3)
    v1_ok = pct(kc, nc) < 50
    out.append("- V1 통제군 구별: FACT_TOP3(C) = %s, FACT_TOP3(T) = %s → %s" % (cell(kc, nc), cell(kt, nt), "통과" if v1_ok else "미달"))
    if not v1_ok:
        flags["H1"].append("구별력 부족")
        flags["H7"].append("구별력 부족")

    m_claim = mean(r["s2"]["rate_claimtable"] for r in T)
    m_score = mean(r["s2"]["rate_score"] for r in T)
    m_ai = mean(r["s2"]["rate_aisearch"] for r in T)
    m_cur = mean(r["s2"]["rate_current"] for r in T)
    gap = m_claim - m_score
    v2_ok = gap >= 0.5
    out.append("- V2 가짜 대조 구별: 평균 점수 CLAIMTABLE %.2f, SCORE %.2f (차 %.2f), AISEARCH %.2f, CURRENT %.2f → %s" % (
        m_claim, m_score, gap, m_ai, m_cur, "통과" if v2_ok else "미달"))

    items = {
        "사실 재확인의 상위 3위 포함(Q1)": (lambda r: fact_top3(r), ["H1", "H7"]),
        "방식 선택(Q10)": (lambda r: r["s2"]["choice"], ["H3", "H7"]),
        "반영 방식(Q13)": (lambda r: r["s2"]["apply_mode"], ["H5"]),
        "외부 업로드(Q14)": (lambda r: r["s2"]["upload"], ["H6"]),
    }
    first = {r["pid"]: r for r in main_rows}
    pairs = [(first[pid], rep) for pid, rep in rep_rows.items() if pid in first]
    if pairs:
        parts = []
        for label, (fn, hyps) in items.items():
            agree = sum(1 for a, b in pairs if fn(a) == fn(b))
            ok = pct(agree, len(pairs)) >= 80
            parts.append("%s %s%s" % (label, cell(agree, len(pairs)), "" if ok else " 미달"))
            if not ok:
                for h in hyps:
                    flags[h].append("불안정(%s)" % label)
        out.append("- V3 반복 안정성(일치율, 기준 80%): " + "; ".join(parts))
    else:
        out.append("- V3 반복 안정성: 반복 실행 자료 없음")

    leak = [r for r in main_rows if any(k in r["s1"]["guessed_purpose"] for k in PURPOSE_KEYS)]
    v4_ok = pct(len(leak), len(main_rows)) <= 20
    out.append("- V4 목적 노출: 1단계에서 조사 목적을 사실 확인 관련으로 짐작한 응답 %s → %s" % (
        cell(len(leak), len(main_rows)), "통과" if v4_ok else "미달"))
    if not v4_ok:
        flags["H1"].append("목적 노출")
        flags["H7"].append("목적 노출")

    noai_all = [r for r in main_rows if not r["p"]["ai"]]
    kf, nf = count(noai_all, lambda r: "E_FABRICATED" in r["s2"]["errors"])
    out.append("- V5 상황 일관성: AI 미사용 조건에서 'AI가 지어낸 출처'를 겪었다고 답한 응답 %s" % cell(kf, nf))
    out.append("")

    # ---- H1 ---------------------------------------------------------------
    out += ["## 가설별 지표와 판정", ""]
    k_core, n_core = count(T_core, fact_top3)
    diff = pct(k_core, n_core) - pct(kc, nc)
    if pct(k_core, n_core) >= 50 and diff >= 20:
        v = "지지"
    elif pct(k_core, n_core) < 30 or diff < 10:
        v = "약화"
    else:
        v = "판단 불가"
    out.append(verdict_line("H1 고객·문제", v, "FACT_TOP3(T_core) %s, 통제군 %s, 차이 %.0f%%p" % (cell(k_core, n_core), cell(kc, nc), diff), flags["H1"]))
    ka, na = count(T_ai, fact_top3)
    kn, nn = count(T_noai, fact_top3)
    k1, n1 = count(T, lambda r: r["s1"]["top3"][0] == "FACT")
    kh, nh = count(T, lambda r: r["s1"]["help_step"] == "FACT")
    km, nm = count(T, lambda r: r["s1"]["memorable_type"] == "FACT_ERROR")
    kmc, nmc = count(C, lambda r: r["s1"]["memorable_type"] == "FACT_ERROR")
    out.append("  - 참고: AI 사용 %s vs 미사용 %s / 1위로 꼽음 %s / 가장 먼저 덜어 내고 싶은 단계로 꼽음 %s" % (cell(ka, na), cell(kn, nn), cell(k1, n1), cell(kh, nh)))
    out.append("  - 참고: 기억에 남는 문제의 유형이 '사실관계·수치·출처' — 대상 %s, 통제군 %s" % (cell(km, nm), cell(kmc, nmc)))
    out.append("  - 참고: 전체 시간 중 사실 재확인 비중(평균) — T_core %s, 대상 전체 %s, 통제군 %s / AI 사용 %s vs 미사용 %s" % (
        mean_share(T_core), mean_share(T), mean_share(C), mean_share(T_ai), mean_share(T_noai)))
    out.append("  - 참고(판정 제외): T_core의 편당 사실 확인 시간 — " + dist(T_core, lambda r: r["s2"]["fact_time"], ["NONE", "LT15M", "M15_60", "H1_3", "GT3H"]))

    # ---- H2 ---------------------------------------------------------------
    rates = {e: count(T_ai, lambda r, e=e: e in r["s2"]["errors"]) for e in H2_TYPES + FOILS}
    top = collections.Counter(r["s2"]["top_error"] for r in T_ai)
    top_code = top.most_common(1)[0][0] if top else "NONE"
    low = [e for e in H2_TYPES if pct(*rates[e]) < 20]
    if all(pct(*rates[e]) >= 40 for e in H2_TYPES) and top_code in H2_TYPES:
        v = "지지"
    elif len(low) >= 2 or top_code in FOILS:
        v = "약화"
    else:
        v = "판단 불가"
    out.append(verdict_line("H2 실패 유형", v, "T_AI 선택률 — " + ", ".join("%s %s" % (ERR_NAME[e], cell(*rates[e])) for e in H2_TYPES)
                            + " / 가장 잦은 유형 1위: %s" % ERR_NAME[top_code], flags["H2"]))
    out.append("  - 참고: 대조 유형 선택률 — " + ", ".join("%s %s" % (ERR_NAME[e], cell(*rates[e])) for e in FOILS))
    out.append("  - 참고: '가장 잦은 유형' 분포(T_AI) — " + ", ".join("%s %d" % (ERR_NAME[k], c) for k, c in top.most_common()))
    top_all = collections.Counter(r["s2"]["top_error"] for r in T_noai)
    out.append("  - 참고: '가장 잦은 유형' 분포(AI 미사용 대상) — " + ", ".join("%s %d" % (ERR_NAME[k], c) for k, c in top_all.most_common()))

    # ---- H3 ---------------------------------------------------------------
    ch = collections.Counter(r["s2"]["choice"] for r in T)
    p_claim, p_ai, p_cur = pct(ch["CLAIMTABLE"], len(T)), pct(ch["AISEARCH"], len(T)), pct(ch["CURRENT"], len(T))
    if not v2_ok:
        v = "판단 불가"
    elif p_claim >= 50 and p_claim - p_ai >= 20:
        v = "지지"
    elif p_ai >= p_claim or p_ai + p_cur >= 60:
        v = "약화"
    else:
        v = "판단 불가"
    out.append(verdict_line("H3 대안 불만족", v, "T의 선택 — " + dist(T, lambda r: r["s2"]["choice"], TOOLS)
                            + " / 평균 점수 차(CLAIMTABLE − SCORE) %.2f" % gap, flags["H3"]))
    out.append("  - 참고: 통제군의 선택 — " + dist(C, lambda r: r["s2"]["choice"], TOOLS))

    # ---- H4 (not judged) --------------------------------------------------
    out.append("- **H4 신뢰와 시간: 판정하지 않음** — 참고: '일치' 판정 문장의 처리(T) — "
               + dist(T, lambda r: r["s2"]["match_handling"], ["RECHECK_ALL", "RECHECK_KEY", "SPOT", "TRUST"]))

    # ---- H5 ---------------------------------------------------------------
    kp, np_ = count(T, lambda r: r["s2"]["apply_mode"] == "PER_ITEM")
    v = "지지" if pct(kp, np_) >= 50 else ("약화" if pct(kp, np_) <= 40 else "판단 불가")
    out.append(verdict_line("H5 통제권", v, "T의 반영 방식 — " + dist(T, lambda r: r["s2"]["apply_mode"], ["PER_ITEM", "HYBRID", "AUTO"]), flags["H5"]))

    # ---- H6 ---------------------------------------------------------------
    ko, no = count(T, lambda r: r["s2"]["upload"] == "OK")
    no_by_group = {g: count(G[g], lambda r: r["s2"]["upload"] == "NO") for g in TARGET}
    blocked = [g for g in TARGET if pct(*no_by_group[g]) >= 30]
    if pct(ko, no) >= 60 and not blocked:
        v = "지지"
    elif pct(ko, no) < 40 or blocked:
        v = "약화"
    else:
        v = "판단 불가"
    out.append(verdict_line("H6 도입 장벽", v, "T의 외부 업로드 — " + dist(T, lambda r: r["s2"]["upload"], ["OK", "CONDITIONAL", "NO"])
                            + (" / '불가' 30%% 이상인 군: %s" % ", ".join(GROUP_NAME[g] for g in blocked) if blocked else ""), flags["H6"]))

    # ---- H7 ---------------------------------------------------------------
    passed = []
    detail = []
    for g in TARGET:
        kg, ng = count(G[g], fact_top3)
        kc2, nc2 = count(G[g], lambda r: r["s2"]["choice"] == "CLAIMTABLE")
        d = pct(kg, ng) - pct(kc, nc)
        ok = d >= 20 and pct(kc2, nc2) >= 40
        if ok:
            passed.append(g)
        detail.append("%s: FACT_TOP3 %s(통제군 대비 %+.0f%%p), CLAIMTABLE 선택 %s → %s" % (GROUP_NAME[g], cell(kg, ng), d, cell(kc2, nc2), "통과" if ok else "미통과"))
    v = "지지" if len(passed) >= 3 else ("약화" if len(passed) <= 1 else "판단 불가")
    out.append(verdict_line("H7 확장", v, "통과한 군 %d개 (%s)" % (len(passed), ", ".join(GROUP_NAME[g] for g in passed) or "없음"), flags["H7"]))
    out += ["  - " + d for d in detail]
    out.append("")

    # ---- tables -----------------------------------------------------------
    out += ["## 군별 표", "", "| 지표 | " + " | ".join(GROUP_NAME[g] for g in GROUP_NAME) + " |", "| --- |" + " --- |" * len(GROUP_NAME)]

    def row(label, pred):
        return "| %s | " % label + " | ".join(cell(*count(G[g], pred)) for g in GROUP_NAME) + " |"

    out.append(row("사실 재확인이 부담 상위 3위", fact_top3))
    out.append(row("사실 재확인이 부담 1위", lambda r: r["s1"]["top3"][0] == "FACT"))
    out.append("| 전체 시간 중 사실 재확인 비중(평균) | " + " | ".join(mean_share(G[g]) for g in GROUP_NAME) + " |")
    out.append(row("덜어 내고 싶은 단계 = 사실 재확인", lambda r: r["s1"]["help_step"] == "FACT"))
    out.append(row("기억에 남는 문제 = 사실 오류", lambda r: r["s1"]["memorable_type"] == "FACT_ERROR"))
    out.append(row("사실 확인에 1시간 이상", lambda r: r["s2"]["fact_time"] in ("H1_3", "GT3H")))
    for t in TOOLS:
        out.append(row("선택: " + t, lambda r, t=t: r["s2"]["choice"] == t))
    out.append("| 평균 점수 CLAIMTABLE / AISEARCH / SCORE / CURRENT | " + " | ".join(
        "%.1f / %.1f / %.1f / %.1f" % tuple(mean(r["s2"][k] for r in G[g]) for k in ("rate_claimtable", "rate_aisearch", "rate_score", "rate_current"))
        for g in GROUP_NAME) + " |")
    for m in ("PER_ITEM", "HYBRID", "AUTO"):
        out.append(row("반영 방식: " + m, lambda r, m=m: r["s2"]["apply_mode"] == m))
    for u in ("OK", "CONDITIONAL", "NO"):
        out.append(row("외부 업로드: " + u, lambda r, u=u: r["s2"]["upload"] == u))
    for h in ("RECHECK_ALL", "RECHECK_KEY", "SPOT", "TRUST"):
        out.append(row("'일치' 처리: " + h, lambda r, h=h: r["s2"]["match_handling"] == h))
    for e in H2_TYPES + FOILS:
        out.append(row("겪은 오류: " + ERR_NAME[e], lambda r, e=e: e in r["s2"]["errors"]))
    out.append("")

    out += ["## 상황 조건별 표 (대상 T만)", "", "| 조건 | 사실 재확인 상위 3위 | 사실 재확인 시간 비중 | CLAIMTABLE 선택 | 외부 업로드 '바로 가능' | 사실 확인 1시간 이상 |", "| --- | --- | --- | --- | --- | --- |"]
    conds = [
        ("AI 초안 사용", lambda r: r["p"]["ai"]), ("AI 초안 미사용", lambda r: not r["p"]["ai"]),
        ("검토자 없음", lambda r: not r["p"]["reviewed"]), ("검토 절차 있음", lambda r: r["p"]["reviewed"]),
        ("10명 미만 조직", lambda r: not r["p"]["big_org"]), ("100명 이상 조직", lambda r: r["p"]["big_org"]),
        ("AI 사용 + 검토자 없음(T_core)", lambda r: r["p"]["ai"] and not r["p"]["reviewed"]),
    ]
    for label, pred in conds:
        sub = [r for r in T if pred(r)]
        out.append("| %s | %s | %s | %s | %s | %s |" % (
            label, cell(*count(sub, fact_top3)), mean_share(sub), cell(*count(sub, lambda r: r["s2"]["choice"] == "CLAIMTABLE")),
            cell(*count(sub, lambda r: r["s2"]["upload"] == "OK")), cell(*count(sub, lambda r: r["s2"]["fact_time"] in ("H1_3", "GT3H")))))
    out.append("")

    out += ["## 부담 단계 상위 3위 포함 비율 (대상 T / 통제군 C)", ""]
    for s in STEP_NAME:
        out.append("- %s: T %s / C %s" % (STEP_NAME[s], cell(*count(T, lambda r, s=s: s in r["s1"]["top3"])), cell(*count(C, lambda r, s=s: s in r["s1"]["top3"]))))
    out.append("")

    (study / "results_auto.md").write_text("\n".join(out) + "\n", encoding="utf-8")

    # ---- open answers -----------------------------------------------------
    ft = []
    for g in GROUP_NAME:
        ft.append("===== %s %s =====" % (g, GROUP_NAME[g]))
        for r in sorted(G[g], key=lambda r: r["pid"]):
            p, s1, s2 = r["p"], r["s1"], r["s2"]
            ft.append("%s [AI %d, 큰조직 %d, 검토 %d] %s" % (r["pid"], p["ai"], p["big_org"], p["reviewed"], p["occupation"]))
            ft.append("  목적 짐작: %s" % s1["guessed_purpose"])
            ft.append("  기억에 남는 문제(%s): %s" % (s1["memorable_type"], s1["memorable_problem"]))
            ft.append("  선택 %s — %s" % (s2["choice"], s2["choice_reason"]))
            ft.append("  망설일 이유: %s" % " | ".join(s2["objections"]))
            ft.append("  업로드 %s — %s" % (s2["upload"], s2["upload_note"]))
    (study / "freetext.txt").write_text("\n".join(ft) + "\n", encoding="utf-8")
    print("complete:", len(main_rows), "| repeats:", len(rep_rows), "| incomplete:", len(incomplete))


if __name__ == "__main__":
    main(sys.argv[1])
