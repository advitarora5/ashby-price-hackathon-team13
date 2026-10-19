"""Clef reads real pathology reports (TCGA-Reports, Kefeli & Tatonetti, Patterns 2024).

    python -m secondlook.eval.report_mining extract --reports TCGA_Reports.csv [--n 300]
        Clef answers present / absent / not mentioned for every finding in config/clef.yaml
        on a seeded sample of reports -> bundle/eval/clef_reports.parquet (resumable).
    python -m secondlook.eval.report_mining sheet --reports TCGA_Reports.csv [--n 50]
        Blank hand-label sheet (Clef's answers hidden) -> bundle/eval/clef_label_sheet.csv;
        its reports are the first n of the extract sample, so extract with the default --n covers them.
        Fill each finding column with P (present), A (absent) or N (not mentioned).
    python -m secondlook.eval.report_mining score --labels <filled sheet>
        How often Clef matches the hand labels, against two baselines it must beat:
        "always not mentioned" and keyword matching with simple negation.
        -> bundle/eval/report_mining.json
    python -m secondlook.eval.report_mining slides --map <report_id,slide_id csv>
        For reports whose slides are in the bundle: does the slide-level AI prevalence of each
        feature pick out the reports that say it is present (AUROC per feature), and how do
        report and slide compare when the report is treated as the reader's notes.
"""
from __future__ import annotations

import argparse
import re
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
import pandas as pd

from secondlook import clef
from secondlook.config import RNG_SEED, bundle_paths
from secondlook.eval.stats import auroc, ci, group_bootstrap, write_eval

EXTRACT_N = 300
CODES = {"P": "present", "A": "absent", "N": "not_mentioned"}
NEGATION = re.compile(r"\b(no|not|without|negative for|absent|free of|none)\b[^.;:]{0,60}$", re.I)


def load_reports(path: Path) -> pd.DataFrame:
    """report_id, text from the TCGA-Reports CSV (column names vary between releases)."""
    df = pd.read_csv(path)
    idc = next(c for c in df.columns if c.lower() in ("patient_filename", "report_id", "filename", "patient_id", "case_id"))
    txt = next(c for c in df.columns if c.lower() in ("text", "report", "report_text"))
    df = df.rename(columns={idc: "report_id", txt: "text"})[["report_id", "text"]]
    df["text"] = df["text"].fillna("").astype(str)
    return df[df.text.str.len() > 50].reset_index(drop=True)


def sample(df: pd.DataFrame, n: int, seed: int = RNG_SEED) -> pd.DataFrame:
    return df.sample(min(n, len(df)), random_state=seed).reset_index(drop=True)


def keyword_answer(text: str, f: clef.Finding) -> str:
    """Baseline: present if a keyword appears, absent if every hit is preceded by a negation in its sentence."""
    t = text.lower()
    hits = [m.start() for k in f.keywords for m in re.finditer(re.escape(k.lower()), t)]
    if not hits:
        return "not_mentioned"
    negated = [bool(NEGATION.search(t[max(0, h - 80):h])) for h in hits]
    return "absent" if all(negated) else "present"


# --------------------------------------------------------------------------- stages
def extract(reports: Path, n: int, workers: int = 4) -> Path:
    out = bundle_paths().eval_dir / "clef_reports.parquet"
    version, findings = clef.load_findings()
    client = clef.get_client()
    df = sample(load_reports(reports), n)
    done = pd.read_parquet(out) if out.exists() else pd.DataFrame(columns=["report_id"])
    todo = df[~df.report_id.isin(set(done.report_id))]
    print(f"{len(todo)} reports to read ({len(df) - len(todo)} cached) with {client.model}")

    def one(row):
        try:
            got = clef.extract_findings(client, row.text, findings, kind="report")
        except Exception as e:  # keep going; the report is retried on the next run
            print(f"  {row.report_id}: {e}")
            return []
        return [{"report_id": row.report_id, "finding": fid, "answer": a["answer"], "confidence": a["confidence"],
                 **{f"p_{k}": a["p"][k] for k in clef.ANSWERS}, "model": client.model, "findings_version": version}
                for fid, a in got.items()]

    rows = []
    with ThreadPoolExecutor(workers) as ex:
        for i, r in enumerate(ex.map(one, todo.itertuples()), 1):
            rows.extend(r)
            if i % 25 == 0 or i == len(todo):
                pd.concat([done, pd.DataFrame(rows)], ignore_index=True).to_parquet(out, index=False)
                print(f"  {i}/{len(todo)}")
    return out


def sheet(reports: Path, n: int) -> Path:
    _, findings = clef.load_findings()
    df = sample(load_reports(reports), EXTRACT_N).head(n)   # a subset of what `extract` reads by default
    for f in findings:
        df[f.id] = ""
    out = bundle_paths().eval_dir / "clef_label_sheet.csv"
    out.parent.mkdir(parents=True, exist_ok=True)
    df.to_csv(out, index=False)
    print(f"{out}: fill each finding column with P (present), A (absent) or N (not mentioned)")
    return out


def _kappa(a, b) -> float:
    from sklearn.metrics import cohen_kappa_score

    return float(cohen_kappa_score(a, b)) if len(set(a) | set(b)) > 1 else float("nan")


def score(labels: Path, reports: Path | None = None) -> dict:
    _, findings = clef.load_findings()
    lab = pd.read_csv(labels)
    clef_path = bundle_paths().eval_dir / "clef_reports.parquet"
    if not clef_path.exists():
        raise SystemExit("run the extract stage first (it must include the labelled reports)")
    got = pd.read_parquet(clef_path).set_index(["report_id", "finding"])
    rows = []
    for r in lab.itertuples():
        for f in findings:
            code = str(getattr(r, f.id, "") or "").strip().upper()[:1]
            if code not in CODES or (r.report_id, f.id) not in got.index:
                continue
            g = got.loc[(r.report_id, f.id)]
            rows.append({"report_id": r.report_id, "finding": f.id, "truth": CODES[code], "clef": g["answer"],
                         "p_present": g["p_present"], "keyword": keyword_answer(r.text, f)})
    df = pd.DataFrame(rows)
    if df.empty:
        raise SystemExit("no labelled report/finding pairs that Clef has read; run extract on the sheet's reports")
    df["majority"] = "not_mentioned"
    groups = df.report_id.to_numpy()

    def acc(col):
        return lambda i: float((df[col].to_numpy()[i] == df.truth.to_numpy()[i]).mean())

    overall = {}
    for m in ("clef", "keyword", "majority"):
        overall[m] = {"accuracy": float((df[m] == df.truth).mean()),
                      "ci": ci(group_bootstrap(acc(m), groups, len(df))),
                      "kappa": _kappa(df.truth, df[m])}
    diff = {f"clef - {b}": ci(group_bootstrap(lambda i, b=b: acc("clef")(i) - acc(b)(i), groups, len(df)))
            for b in ("keyword", "majority")}
    per = {}
    for f, g in df.groupby("finding"):
        per[f] = {"n": int(len(g)), "n_present": int((g.truth == "present").sum()),
                  "clef_accuracy": float((g.clef == g.truth).mean()),
                  "keyword_accuracy": float((g.keyword == g.truth).mean()),
                  "present_auroc": auroc((g.truth == "present").astype(int), g.p_present)}
    doc = {"available": True, "n_reports": int(df.report_id.nunique()), "n_pairs": int(len(df)),
           "overall": overall, "clef_minus_baseline_ci": diff, "per_finding": per, "bootstrap": "by report",
           "model": str(got["model"].iloc[0]) if "model" in got else None}
    return write_eval(bundle_paths().eval_dir / "report_mining.json", doc)


def slides(mapping: Path) -> dict:
    """Slide-level AI prevalence vs what Clef read in the matching report."""
    from secondlook.pipeline.features import load_features

    paths = bundle_paths()
    _, findings = clef.load_findings()
    got = pd.read_parquet(paths.eval_dir / "clef_reports.parquet")
    m = pd.read_csv(mapping)
    feats = [f.id for f in load_features()[1]]
    rows, cats = [], []
    for r in m.itertuples():
        if not paths.scores(r.slide_id).exists():
            continue
        prev = clef.feature_prevalence(pd.read_parquet(paths.tiles(r.slide_id)), pd.read_parquet(paths.scores(r.slide_id)), feats)
        g = got[got.report_id == r.report_id]
        found = {x.finding: {"answer": x.answer, "p": {k: getattr(x, f"p_{k}") for k in clef.ANSWERS},
                             "confidence": x.confidence} for x in g.itertuples()}
        for c in clef.compare(found, prev, findings):
            cats.append({"slide_id": r.slide_id, **c})
        for fid, a in found.items():
            f = next(x for x in findings if x.id == fid)
            p = prev.get(f.feature) if f.feature else None
            if p and p.get("measurable"):
                rows.append({"slide_id": r.slide_id, "finding": fid, "said_present": int(a["answer"] == "present"),
                             "share": p["share"]})
    df = pd.DataFrame(rows)
    if df.empty:
        return write_eval(paths.eval_dir / "report_slides.json", {"available": False,
                          "reason": "no mapped report has a scored slide in the bundle"})
    per = {}
    for fid, g in df.groupby("finding"):
        y, s, grp = g.said_present.to_numpy(), g.share.to_numpy(), g.slide_id.to_numpy()
        per[fid] = {"n_slides": int(len(g)), "n_present": int(y.sum()), "auroc": auroc(y, s),
                    "ci": ci(group_bootstrap(lambda i: auroc(y[i], s[i]), grp, len(g)))}
    cat = pd.DataFrame(cats)
    doc = {"available": True, "n_slides": int(df.slide_id.nunique()), "prevalence_vs_report": per,
           "report_as_notes": cat.category.value_counts().to_dict() if len(cat) else {},
           "note": "labels are what Clef read in the report, not expert slide annotations"}
    return write_eval(paths.eval_dir / "report_slides.json", doc)


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("stage", choices=["extract", "sheet", "score", "slides"])
    ap.add_argument("--reports", type=Path)
    ap.add_argument("--labels", type=Path)
    ap.add_argument("--map", type=Path)
    ap.add_argument("--n", type=int)
    ap.add_argument("--workers", type=int, default=4)
    a = ap.parse_args(argv)
    if a.stage == "extract":
        print(extract(a.reports, a.n or EXTRACT_N, a.workers))
    elif a.stage == "sheet":
        sheet(a.reports, a.n or 50)
    elif a.stage == "score":
        d = score(a.labels)
        for k, v in d["overall"].items():
            print(f"{k:9} accuracy {v['accuracy']:.3f} [{v['ci'][0]:.3f}-{v['ci'][1]:.3f}]  kappa {v['kappa']:.3f}")
        print({k: [round(x, 3) for x in v] for k, v in d["clef_minus_baseline_ci"].items()})
    else:
        print(slides(a.map))


if __name__ == "__main__":
    main()
