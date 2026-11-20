"""Turn a workflow run's journal.jsonl into responses.jsonl.

The journal has a 'started' line (key, label) and a 'result' line (key, result)
per agent. Labels look like "G1-05 r1 1/2" (respondent, run, stage).

Usage: python collect_responses.py <journal.jsonl> [<journal.jsonl> ...] <out responses.jsonl>
Later journals override earlier ones for the same respondent, run and stage.
"""
import json
import pathlib
import re
import sys

LABEL = re.compile(r"^(G\d-\d\d)(?: r(\d))? ([12])/2$")


def main(journals, out_path):
    data = {}
    for j in journals:
        labels, results = {}, {}
        for line in pathlib.Path(j).read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            row = json.loads(line)
            if row.get("type") == "started":
                labels[row["key"]] = row.get("label", "")
            elif row.get("type") == "result":
                results[row["key"]] = row.get("result")
        for key, result in results.items():
            m = LABEL.match(labels.get(key, ""))
            if not m or not isinstance(result, dict):
                continue
            pid, run, stage = m.group(1), int(m.group(2) or 1), "s" + m.group(3)
            data.setdefault((pid, run), {})[stage] = result
    mismatched = [k for k, v in data.items() for s in v.values() if s.get("pid") != k[0]]
    with open(out_path, "w", encoding="utf-8") as f:
        for (pid, run), v in sorted(data.items()):
            f.write(json.dumps({"pid": pid, "run": run, "s1": v.get("s1"), "s2": v.get("s2")}, ensure_ascii=False) + "\n")
    complete = sum(1 for v in data.values() if v.get("s1") and v.get("s2"))
    print("respondent-runs:", len(data), "| complete:", complete, "| pid mismatches:", len(mismatched))


if __name__ == "__main__":
    main(sys.argv[1:-1], sys.argv[-1])
