"""Measure #5: human reads saved at equal expert agreement (CrowdGleason test set).

Human-only policies run on the real resident and expert labels. The AI-supported
policy additionally needs prostate-probe predictions on the test patches
(bundle/eval/crowdgleason_test_ai.parquet: patch_id, ai_class, ai_conf,
ai_disagreement), produced on Delta by `secondlook.pipeline.run_prostate`.
Without that file the AI rows are reported as unavailable, never simulated.

    python -m secondlook.eval.policy_eval
"""
from __future__ import annotations

import json

import numpy as np
import pandas as pd

from secondlook import config
from secondlook.config import RAW_DIR, bundle_paths
from secondlook.core.policy import bootstrap, enumerate_policies, metrics
from secondlook.pipeline.datasets.crowdgleason import ingest_labels, load_split, residents_matrix
from secondlook.store import db


def run(complete_only: bool = True, reps: int = config.BOOTSTRAP_REPS, write_db: bool = True) -> dict:
    paths = bundle_paths()
    root = RAW_DIR / "crowdgleason"
    test = load_split(root, "test")
    L, truth, groups, patch_ids = residents_matrix(test, complete_only=complete_only)

    ai_path = paths.eval_dir / "crowdgleason_test_ai.parquet"
    ai = gate = None
    ai_source = "unavailable: prostate probe predictions not exported yet"
    thresholds = json.loads(paths.thresholds.read_text()) if paths.thresholds.exists() else {}
    if ai_path.exists():
        a = pd.read_parquet(ai_path).set_index("patch_id").reindex(patch_ids)
        if a["ai_class"].isna().any():
            raise ValueError("AI predictions missing for some test patches")
        ai = a["ai_class"].to_numpy().astype(int)
        g = thresholds.get("prostate_gate", {})
        if g:
            gate = (a["ai_conf"].to_numpy() >= g.get("min_conf", 0)) & \
                   (a["ai_disagreement"].fillna(0).to_numpy() <= g.get("max_disagreement", 1))
        ai_source = f"prostate_probe ({ai_path.name})"

    results = enumerate_policies(L, ai=ai, ai_gate=gate)
    boots = bootstrap(results, truth, groups, reps=reps, seed=config.RNG_SEED,
                      reference="double_arbitrated", margin=config.NONINFERIORITY_MARGIN)
    rows = []
    for name, r in results.items():
        m = metrics(r.dist, r.reads, truth)
        b = boots[name]
        row = {"policy": name, "params": r.params, **m,
               "agreement_ci": b["agreement_ci"], "kappa_ci": b["kappa_ci"], "reads_ci": b["reads_ci"],
               "diff_vs_double_ci": b.get("diff_vs_reference_ci"), "noninferior_vs_double": b.get("noninferior"),
               "provenance": "real_human_labels" if name not in ("ai_supported", "random_skip") else ai_source}
        rows.append(row)

    # per-resident single-reader agreement (shows how much readers differ)
    per_reader = [{"resident": i + 1, "agreement": float((L[:, i] == truth).mean())} for i in range(L.shape[1])]
    by = {r["policy"]: r for r in rows}
    headline = []
    for name, label in (("single", "1 resident"), ("double_arbitrated", "2 residents (+3rd on disagreement)"),
                        ("majority_5", "Majority of 5"), ("majority_7", "Majority of 7"),
                        ("ai_supported", "AI as supporting reader"), ("random_skip", "Random skip (control)")):
        if name in by:
            r = by[name]
            ni = r["noninferior_vs_double"]
            headline.append({"label": f"{label}: {r['reads_per_100']:.0f} human reads / 100 cases",
                             "value": f"{r['agreement']:.1%}", "ci": f"{r['agreement_ci'][0]:.1%}-{r['agreement_ci'][1]:.1%}",
                             "status": "info" if ni is None or name == "double_arbitrated" else ("pass" if ni else "fail"),
                             "note": f"QWK {r['kappa']:.3f}; cancer vs non-cancer {r['cancer_acc']:.1%}"
                                     + ("" if ni is None or name == "double_arbitrated" else
                                        f"; non-inferior to double reading (2-pt margin): {'yes' if ni else 'no'}")})
    caveats = [f"Primary analysis on {len(truth)} patches with all 7 residents (of {len(test)}).",
               "Majority-of-7 agreement is near-perfect, so the expert reference may have been formed with the "
               "residents' labels visible; check before claiming reads saved."]
    if ai is None:
        caveats.insert(0, "AI-supported policy not run: prostate-probe predictions not exported yet (Delta job). Never simulated.")
    out = {
        "title": "Human reads per policy (WORTH A READER)", "measure": "#5 routing and cost",
        "headline": headline, "caveats": caveats,
        "dataset": "CrowdGleason test (expert ground truth)",
        "n_patches": int(len(truth)), "n_slides": int(len(np.unique(groups))),
        "complete_only": complete_only, "bootstrap": {"reps": reps, "unit": "slide (WSI prefix)"},
        "noninferiority_margin": config.NONINFERIORITY_MARGIN, "reference_policy": "double_arbitrated",
        "ai_source": ai_source, "policies": rows, "per_resident": per_reader,
        "note": "Exact enumeration over all ordered reader triples (7*6*5=210). AI never breaks a human tie.",
    }
    paths.eval_dir.mkdir(parents=True, exist_ok=True)
    (paths.eval_dir / "policy.json").write_text(json.dumps(out, indent=1))

    if write_db:
        con = db.init_db(paths.db)
        ingest_labels(root, con)
        con.execute("DELETE FROM policy_case_results")
        con.execute("DELETE FROM policy_runs WHERE dataset='crowdgleason'")
        for row in rows:
            run_id = f"cg_{row['policy']}"
            db.upsert(con, "policy_runs", {
                "run_id": run_id, "policy": row["policy"], "params": row["params"], "dataset": "crowdgleason",
                "n_cases": row["n"], "reads_per_100": row["reads_per_100"], "agreement": row["agreement"],
                "kappa": row["kappa"], "cancer_acc": row["cancer_acc"], "highgrade_acc": row["highgrade_acc"],
                "ci_low": row["agreement_ci"][0], "ci_high": row["agreement_ci"][1],
                "reads_ci_low": row["reads_ci"][0], "reads_ci_high": row["reads_ci"][1],
                "noninferior": None if row["noninferior_vs_double"] is None else int(row["noninferior_vs_double"]),
                "provenance": row["provenance"], "created": db.now()})
            r = results[row["policy"]]
            db.insert_many(con, "policy_case_results", [
                {"run_id": run_id, "patch_id": str(p), "expected_reads": float(rd), "p_correct": float(d[t])}
                for p, rd, d, t in zip(patch_ids, r.reads, r.dist, truth)])
        con.commit()
        con.close()
    return out


if __name__ == "__main__":
    import argparse

    ap = argparse.ArgumentParser()
    ap.add_argument("--all-patches", action="store_true", help="include patches missing some residents (sensitivity)")
    ap.add_argument("--reps", type=int, default=config.BOOTSTRAP_REPS)
    a = ap.parse_args()
    o = run(complete_only=not a.all_patches, reps=a.reps)
    print(f"{o['n_patches']} patches / {o['n_slides']} slides; AI: {o['ai_source']}")
    for r in o["policies"]:
        print(f"  {r['policy']:<18} reads/100={r['reads_per_100']:6.1f}  agreement={r['agreement']:.3f} "
              f"[{r['agreement_ci'][0]:.3f},{r['agreement_ci'][1]:.3f}]  qwk={r['kappa']:.3f}  "
              f"cancer={r['cancer_acc']:.3f}  NI={r['noninferior_vs_double']}")
