"""SecondLook API: one FastAPI app, five service modules, all reading the local bundle.

    uvicorn secondlook.api.main:app --port 8000
"""
from __future__ import annotations

import json
import os
from pathlib import Path

from fastapi import APIRouter, Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from secondlook.api.services import audit, coverage, disagreement, evidence, policy, replay
from secondlook.api.store import Store, get_store
from secondlook.config import REPO_ROOT

app = FastAPI(title="SecondLook", version="0.1.0",
              description="Experimental pathology decision support. Never outputs a diagnosis.")
app.add_middleware(CORSMiddleware, allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
                   allow_methods=["*"], allow_headers=["*"])

meta = APIRouter(tags=["meta"])


@meta.get("/health")
def health(store: Store = Depends(get_store)):
    m = store.manifest()
    con = store.con()
    try:
        n_cases = con.execute("SELECT COUNT(*) FROM cases").fetchone()[0]
    finally:
        con.close()
    return {"ok": True, "bundle": str(store.paths.root), "cases": n_cases,
            "provenance": m.get("provenance", "unknown"), "manifest_updated": m.get("updated"),
            "thresholds": store.thresholds()}


@meta.get("/eval/summary")
def eval_summary(store: Store = Depends(get_store)):
    out = {}
    d = store.paths.eval_dir
    if d.exists():
        for p in sorted(d.glob("*.json")):
            try:
                out[p.stem] = json.loads(p.read_text())
            except json.JSONDecodeError:
                out[p.stem] = {"error": "unreadable"}
    return out


for r in (meta, disagreement.router, evidence.router, coverage.router, policy.router, audit.router, replay.router):
    app.include_router(r, prefix="/api")

# optional spatial-context feature; SECONDLOOK_CONTEXT=0 turns it off (see secondlook/pipeline/context.py)
if os.environ.get("SECONDLOOK_CONTEXT", "1") != "0":
    from secondlook.api.services import context

    app.include_router(context.router, prefix="/api")

# optional Clef feature (notes check, region referee); SECONDLOOK_CLEF=0 turns it off (see secondlook/clef.py)
if os.environ.get("SECONDLOOK_CLEF", "1") != "0":
    from secondlook.api.services import clef as clef_service

    app.include_router(clef_service.router, prefix="/api")

# optional tissue search ("Ctrl+F for tissue"); SECONDLOOK_SEARCH=0 turns it off (see services/search.py)
if os.environ.get("SECONDLOOK_SEARCH", "1") != "0":
    from secondlook.api.services import search as search_service

    app.include_router(search_service.router, prefix="/api")

_dist = REPO_ROOT / "frontend" / "dist"
if _dist.exists():
    app.mount("/assets", StaticFiles(directory=_dist / "assets"), name="assets")

    @app.get("/{path:path}", include_in_schema=False)
    def spa(path: str):
        f = _dist / path
        return FileResponse(f if path and f.is_file() else _dist / "index.html")
