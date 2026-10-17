"""Ingest human-reading datasets into the bundle.

    python -m secondlook.pipeline.ingest pathogaze      # events parquet + readers + reads (slides in DB only)
    python -m secondlook.pipeline.ingest crowdgleason   # patches + resident / expert labels
"""
from __future__ import annotations

import argparse

from secondlook.config import RAW_DIR, bundle_paths
from secondlook.store import db


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("dataset", choices=["pathogaze", "crowdgleason"])
    ap.add_argument("--all-slides", action="store_true", help="ingest reads even for slides not processed")
    a = ap.parse_args(argv)
    paths = bundle_paths()
    if a.dataset == "pathogaze":
        from secondlook.pipeline.datasets.pathogaze import ingest

        con = db.init_db(paths.db)
        slides = None if a.all_slides else {r["slide_id"] for r in db.all_(con, "SELECT slide_id FROM slides WHERE status='ok'")}
        con.close()
        print(ingest(RAW_DIR / "pathogaze", paths, slides))
    else:
        from secondlook.pipeline.datasets.crowdgleason import ingest_labels

        con = db.init_db(paths.db)
        print(ingest_labels(RAW_DIR / "crowdgleason", con))
        con.close()


if __name__ == "__main__":
    main()
