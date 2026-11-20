"""Sample 200 personas from Nemotron-Personas-Korea and write the prompt files.

Follows 01_설계와_판정기준.md: five groups of 40, a 2x2x2 scenario grid with
five respondents per cell, and per-respondent shuffled option orders.

Usage: python build_study.py <parquet_dir> <study_dir>
Needs: duckdb
"""
import hashlib
import json
import pathlib
import random
import sys

import duckdb

SEED = "20261118"

# (group, [(occupation names, how many)])
GROUPS = [
    ("G1", [(["기자"], 40)]),
    ("G2", [
        (["홍보 전문가", "광고 및 홍보 사무원", "광고 및 홍보 관리자"], 20),
        (["마케팅 전문가", "마케팅 관리자", "그 외 기획 및 마케팅 사무원"], 20),
    ]),
    ("G3", [(["국가행정 사무원", "지방행정 사무원", "공공행정 사무원", "공공행정 전문가", "정부행정 전문가"], 40)]),
    ("G4", [
        (["출판물 편집자", "출판물 기획자"], 16),
        (["출판 및 자료편집 사무원"], 12),
        (["미디어 콘텐츠 창작자"], 12),
    ]),
    ("G5", [([name], 5) for name in [
        "경리 사무원", "회계 사무원", "생산관리 사무원", "자재 관리 사무원",
        "영업 관리 사무원", "품질 관리 사무원", "총무 사무원", "인사 및 노무 사무원",
    ]]),
]

ROLE = {
    "G1": "언론사(신문·잡지·온라인 매체)에서 기사와 칼럼을 쓰고, 다른 사람의 원고를 데스킹·교열하기도 합니다. 한 주에 3~5건을 내보냅니다.",
    "G2": "기업에서 보도자료, 회사 소개 자료, 블로그·뉴스레터 글을 작성합니다. 한 달에 4~8건을 내보냅니다.",
    "G3": "공공기관(또는 지방자치단체)에서 보도자료, 행사·제도 안내문, 소식지를 작성합니다. 한 달에 4~8건을 내보냅니다.",
    "G4": "교양서, 교재, 건강·생활 정보 글 같은 정보성 콘텐츠의 원고를 쓰거나 편집합니다. 한 달에 2~4건을 내보냅니다.",
    "G5": "사내 보고서, 회의 자료, 업무 메일 같은 내부 문서를 작성합니다. 외부에 공개되는 글은 맡지 않습니다. 한 주에 2~3건을 작성합니다.",
}

STEPS = {
    "PLAN": "기획·자료 조사",
    "DRAFT": "초안 작성",
    "FACT": "사실관계·출처 재확인",
    "POLISH": "문장 다듬기·교정",
    "APPROVAL": "내부 검토·승인 대응",
    "PRODUCTION": "디자인·편집·배포 작업",
    "AFTERCARE": "{released} 뒤 문의·정정 대응",
}
PROBLEM_TYPES = {
    "FACT_ERROR": "사실관계·수치·출처가 틀림",
    "TYPO_STYLE": "오탈자·문장 표현",
    "FORMAT_DESIGN": "형식·디자인·레이아웃",
    "SCHEDULE_DISTRIBUTION": "일정·배포·전달 실수",
    "TONE_EXPRESSION": "어조·표현 수위",
}
METHODS = {
    "SELF_SEARCH": "직접 검색하거나 원문을 찾아 확인",
    "ASK_AI": "대화형 AI에 다시 물어 확인",
    "PEER": "동료나 상급자가 검토",
    "SOURCE_OWNER": "자료를 준 사람이나 담당 기관에 문의",
}
ERRORS = {
    "E_SECONDARY": "참고한 자료들이 서로 같은 내용을 옮겨 적은 것이어서, 원문이나 공식 자료와 다른 내용이 그대로 실림",
    "E_QUALIFIER": "큰 줄기는 맞는데 '유일한', '최초의', '모든', '해마다' 같은 한정 표현이 틀림",
    "E_DRIFT": "확인을 마친 문장이 퇴고·교정을 거치면서 뜻이 달라짐",
    "E_STALE": "확인한 날과 {release_day} 사이에 일정·요금·수치가 바뀜",
    "E_FABRICATED": "AI가 실제로 없는 출처·인용·통계를 만들어 냄",
    "E_NUMERIC": "숫자의 단위·환산·계산이 틀림",
    "E_NAMES": "인명·기관명·직함 표기가 틀림",
}
TOOLS = {
    "AISEARCH": "평소 쓰는 대화형 AI 검색에 {doc} 전체를 붙여 넣고 사실 확인을 요청합니다. 몇 분 안에 요약 답변과 참고 링크 몇 개를 받습니다. 새 도구나 추가 비용이 필요 없습니다. 문장별 판정 목록은 따로 나오지 않습니다.",
    "CLAIMTABLE": "{doc}를 전용 웹 도구에 올리면 10~30분 뒤 문장별 판정표를 받습니다. 사실 확인이 필요한 문장마다 판정(일치·불일치·근거 부족·해석 주의), 근거 링크, 출처의 신뢰 등급, 고친 문장 제안이 붙습니다. 판정표를 직접 훑어봐야 하고, {doc} 한 건당 소액의 이용료가 듭니다.",
    "SCORE": "{doc}를 전용 웹 도구에 올리면 1분 안에 {doc} 전체의 사실 신뢰도 점수(0~100점)와 의심스러운 문장 표시를 받습니다. 근거 링크나 고친 문장 제안은 없습니다. {doc} 한 건당 소액의 이용료가 듭니다.",
}

COLUMNS = [
    "uuid", "sex", "age", "marital_status", "education_level", "bachelors_field", "occupation",
    "district", "province", "persona", "professional_persona", "skills_and_expertise",
    "career_goals_and_ambitions",
]


def md5(text):
    return hashlib.md5(text.encode("utf-8")).hexdigest()


def sample(parquet_dir):
    files = sorted(str(p).replace("\\", "/") for p in pathlib.Path(parquet_dir).glob("*.parquet"))
    con = duckdb.connect()
    src = "read_parquet(%s)" % files
    people = []
    for group, strata in GROUPS:
        rows = []
        for names, k in strata:
            marks = ", ".join("?" for _ in names)
            got = con.execute(
                "SELECT %s FROM %s WHERE age BETWEEN 25 AND 64 AND occupation IN (%s) "
                "ORDER BY md5(uuid || '%s') LIMIT %d" % (", ".join(COLUMNS), src, marks, SEED, k),
                names,
            ).fetchall()
            if len(got) < k:
                raise SystemExit("not enough personas for %s %s: %d < %d" % (group, names, len(got), k))
            rows += [dict(zip(COLUMNS, r)) for r in got]
        rows.sort(key=lambda r: md5(r["uuid"] + SEED))
        for i, r in enumerate(rows):
            cell = i % 8
            r.update({
                "pid": "%s-%02d" % (group, i + 1),
                "group": group,
                "ai": cell & 1,
                "big_org": (cell >> 1) & 1,
                "reviewed": (cell >> 2) & 1,
                "repeat": i in (0, 11, 22, 33),
                "pilot": i in (4, 17),
            })
            rng = random.Random(int(md5(r["pid"] + SEED)[:8], 16))
            for key, table in (("steps", STEPS), ("problem_types", PROBLEM_TYPES), ("methods", METHODS),
                               ("errors", ERRORS), ("tools", TOOLS)):
                order = list(table)
                rng.shuffle(order)
                r["order_" + key] = order
            people.append(r)
    return people


def words(group):
    """Wording that differs between published writing (G1-G4) and internal documents (G5)."""
    if group == "G5":
        return {"unit": "문서 한 건", "doc": "문서", "release": "제출하거나 공유하기", "released": "제출한",
                "release_day": "제출하는 날", "before": "제출·공유 전"}
    return {"unit": "글 한 편", "doc": "원고", "release": "내보내기", "released": "내보낸",
            "release_day": "내보내는 날", "before": "내보내기 전"}


def head(p, part):
    w = words(p["group"])
    major = p.get("bachelors_field")
    edu = p["education_level"] + (" (전공: %s)" % major if major and major not in ("해당없음", "해당 없음") else "")
    ai = "초안을 쓸 때 생성형 AI(대화형 AI)를 일상적으로 사용합니다." if p["ai"] else "초안은 생성형 AI 없이 직접 씁니다."
    size = "직원이 100명이 넘는 조직입니다." if p["big_org"] else "직원이 10명이 안 되는 작은 조직입니다."
    review = ("%s에 상급자나 담당 부서가 내용을 검토하는 절차가 있습니다." % w["before"]) if p["reviewed"] else (
        "%s에 내용을 검토해 주는 다른 사람이 없고, 내용이 정확한지는 본인이 최종 책임집니다." % w["before"])
    return "\n".join([
        "# 응답자 조사 (%d/2)" % part,
        "",
        "이 파일에는 설문 응답자 한 사람의 정보와 질문이 들어 있습니다. 당신은 이 응답자를 연기합니다. 아래 인물과 업무 상황이 곧 당신입니다.",
        "",
        "## 인물",
        "- 응답자 번호: %s" % p["pid"],
        "- %d세 %s, %s 거주, %s" % (p["age"], p["sex"], p["district"], p["marital_status"]),
        "- 학력: %s" % edu,
        "- 직업: %s" % p["occupation"],
        "- 소개: %s" % p["persona"],
        "- 직업 생활: %s" % p["professional_persona"],
        "- 역량: %s" % p["skills_and_expertise"],
        "- 진로 목표: %s" % p["career_goals_and_ambitions"],
        "",
        "## 업무 상황",
        "- 맡은 일: %s" % ROLE[p["group"]],
        "- 초안 작성: %s" % ai,
        "- 조직: %s" % size,
        "- 검토 체계: %s" % review,
        "",
        "인물 소개와 업무 상황이 서로 다르면 업무 상황을 따릅니다.",
        "",
        "## 응답 원칙",
        "- 조사자가 듣고 싶어 할 답을 짐작해 맞추지 않습니다. 이 인물의 처지에서 실제로 할 법한 답을 합니다.",
        "- 해당 사항이 없거나 불편을 느끼지 않으면 그대로 그렇게 답합니다.",
        "- 다른 파일을 읽거나 검색하지 않습니다. 이 파일과 호출 지시문만으로 답합니다.",
        "",
    ])


def bullets(order, table, w):
    return ["- %s: %s" % (code, table[code].format(**w)) for code in order]


def prompt1(p):
    w = words(p["group"])
    lines = [head(p, 1), "## 질문", ""]
    lines.append("Q1. %s을 완성해 %s까지 거치는 단계 가운데, 시간과 신경이 가장 많이 쓰이는 것부터 순서대로 3개를 고르십시오. (top3: 코드 3개, 1위부터)" % (w["unit"], w["release"]))
    lines += bullets(p["order_steps"], STEPS, w)
    lines.append("")
    lines.append("Q1-2. %s에 드는 전체 시간을 100으로 볼 때, 위 일곱 단계가 각각 차지하는 비중을 정수로 적으십시오. 합이 100이 되게 합니다. (share_plan, share_draft, share_fact, share_polish, share_approval, share_production, share_aftercare)" % w["unit"])
    lines.append("")
    lines.append("Q2. 위 단계 중 누가 대신 맡아 준다면 가장 먼저 덜어 내고 싶은 단계 1개를 고르십시오. (help_step)")
    lines.append("")
    lines.append("Q3. %s에 드는 전체 시간은 대략 얼마입니까? (total_time)" % w["unit"])
    lines += ["- LT1H: 1시간 미만", "- H1_3: 1~3시간", "- H3_8: 3~8시간", "- GT8H: 8시간 이상", ""]
    lines.append("Q4. 최근 반년 사이 %s 것 가운데 나중에 고쳐야 했던 문제 중 가장 기억에 남는 것을 한 문장(80자 이내)으로 적으십시오. 없으면 '없음'이라고 적습니다. (memorable_problem) 그리고 그 문제의 유형을 고르십시오. (memorable_type)" % w["released"])
    lines += bullets(p["order_problem_types"], PROBLEM_TYPES, w)
    lines += ["- OTHER: 그 밖의 문제", "- NONE: 없음", ""]
    lines.append("Q5. 이 조사가 무엇을 알아보려는 것 같습니까? 한 구절(40자 이내)로 적으십시오. (guessed_purpose)")
    lines.append("")
    lines.append("## 답하는 형식")
    lines.append("구조화된 응답으로 제출합니다. pid에는 응답자 번호를 그대로 적습니다.")
    return "\n".join(lines) + "\n"


def prompt2(p):
    w = words(p["group"])
    lines = [head(p, 2), "## 앞 단계에서 한 답", "호출 지시문에 이 응답자가 앞 단계에서 한 답이 함께 주어집니다. 그 답과 어긋나지 않게 이어서 답합니다.", "", "## 질문", ""]
    lines.append("Q6. 지금 %s의 사실관계와 출처를 어떻게 확인합니까? 해당하는 것을 모두 고르십시오. (methods)" % w["doc"])
    lines += bullets(p["order_methods"], METHODS, w)
    lines += ["- NONE: 따로 확인하지 않음 (이 경우 NONE만 고름)", ""]
    lines.append("Q7. %s의 사실관계·출처 확인에 쓰는 시간은 대략 얼마입니까? (fact_time)" % w["unit"])
    lines += ["- NONE: 하지 않음", "- LT15M: 15분 미만", "- M15_60: 15분~1시간", "- H1_3: 1~3시간", "- GT3H: 3시간 이상", ""]
    lines.append("Q8. 최근 반년 사이 직접 겪은 일을 모두 고르고(errors), 그중 가장 자주 겪는 것 1개를 고르십시오(top_error). 겪은 것이 없으면 둘 다 NONE으로 답합니다.")
    lines += bullets(p["order_errors"], ERRORS, w)
    lines += ["- NONE: 겪은 것 없음", ""]
    lines.append("이제 사실관계를 확인하는 네 가지 방식을 읽고 답하십시오.")
    lines += bullets(p["order_tools"], TOOLS, w)
    lines += ["- CURRENT: 새 방식을 쓰지 않고 지금 하던 대로 합니다.", ""]
    lines.append("Q9. 네 방식 각각이 내 업무에 얼마나 도움이 될지 1점(전혀 도움이 안 됨)부터 5점(매우 도움이 됨)까지 매기십시오. (rate_aisearch, rate_claimtable, rate_score, rate_current)")
    lines.append("")
    lines.append("Q10. 다음 %s에 한 가지 방식만 쓴다면 무엇을 고르겠습니까? (choice)" % w["doc"])
    lines.append("")
    lines.append("Q11. 그렇게 고른 이유를 한 문장(60자 이내)으로 적으십시오. (choice_reason)")
    lines.append("")
    lines.append("Q12. CLAIMTABLE 방식을 쓰지 않거나 망설이게 할 이유가 있다면 최대 2개를 각각 40자 이내로 적으십시오. 없으면 비워 둡니다. (objections)")
    lines.append("")
    lines.append("Q13. 도구가 고친 문장을 제안한다면 어떤 방식으로 반영하기를 원합니까? (apply_mode)")
    lines += ["- AUTO: 도구가 알아서 반영하고 바뀐 곳만 알려 줌", "- PER_ITEM: 제안을 하나씩 보고 직접 채택하거나 보류", "- HYBRID: 사소한 것은 자동으로 반영하고 중요한 것만 직접 확인", ""]
    lines.append("Q14. %s의 %s를 외부 웹 도구에 올리는 것은 가능합니까? (upload) 조건이나 사유가 있으면 한 구절(40자 이내)로 적고, 없으면 비워 둡니다. (upload_note)" % (w["before"], w["doc"]))
    lines += ["- OK: 바로 가능", "- CONDITIONAL: 조건이 맞으면 가능", "- NO: 불가", ""]
    lines.append("Q15. CLAIMTABLE 방식의 판정표에서 '일치'로 나온 문장은 어떻게 하겠습니까? (match_handling)")
    lines += ["- RECHECK_ALL: 전부 직접 다시 확인", "- RECHECK_KEY: 중요한 문장만 다시 확인", "- SPOT: 몇 개만 무작위로 확인", "- TRUST: 다시 확인하지 않음", ""]
    lines.append("## 답하는 형식")
    lines.append("구조화된 응답으로 제출합니다. pid에는 응답자 번호를 그대로 적습니다.")
    return "\n".join(lines) + "\n"


def main(parquet_dir, study_dir):
    study = pathlib.Path(study_dir)
    prompts = study / "prompts"
    prompts.mkdir(parents=True, exist_ok=True)
    people = sample(parquet_dir)
    with open(study / "personas.jsonl", "w", encoding="utf-8") as f:
        for p in people:
            f.write(json.dumps(p, ensure_ascii=False) + "\n")
    for p in people:
        (prompts / ("%s_1.md" % p["pid"])).write_text(prompt1(p), encoding="utf-8")
        (prompts / ("%s_2.md" % p["pid"])).write_text(prompt2(p), encoding="utf-8")
    # summary for a quick check
    by_group = {}
    for p in people:
        g = by_group.setdefault(p["group"], {"n": 0, "occ": {}, "cells": {}, "ages": []})
        g["n"] += 1
        g["occ"][p["occupation"]] = g["occ"].get(p["occupation"], 0) + 1
        cell = (p["ai"], p["big_org"], p["reviewed"])
        g["cells"][cell] = g["cells"].get(cell, 0) + 1
        g["ages"].append(p["age"])
    summary = []
    for name, g in by_group.items():
        summary.append("%s n=%d | cells %s | age %d-%d | %s" % (
            name, g["n"], sorted(set(g["cells"].values())), min(g["ages"]), max(g["ages"]),
            ", ".join("%s %d" % kv for kv in sorted(g["occ"].items(), key=lambda x: -x[1]))))
    summary.append("pilot: " + ", ".join(p["pid"] for p in people if p["pilot"]))
    summary.append("repeat: " + ", ".join(p["pid"] for p in people if p["repeat"]))
    summary.append("education levels: " + ", ".join(sorted({p["education_level"] for p in people})))
    summary.append("bachelors fields: " + ", ".join(sorted({str(p["bachelors_field"]) for p in people})))
    (study / "sampling_summary.txt").write_text("\n".join(summary) + "\n", encoding="utf-8")
    print("personas:", len(people), "| prompt files:", 2 * len(people))


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
