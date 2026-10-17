# SecondLook

Experimental pathology decision support (TriageLens + UNSEEN + WORTH A READER) that never outputs a diagnosis.
It shows evidence, flags tissue the reader never looked at, routes disputed cases to a blind-first
slow path, and prices how many human reads a policy needs.

## Run the demo (laptop, no GPU or network needed)
```
# once
py -3.11 -m venv %USERPROFILE%\.venvs\secondlook
%USERPROFILE%\.venvs\secondlook\Scripts\pip install -r requirements.txt
cd frontend && npm install && npm run build && cd ..
# every time
%USERPROFILE%\.venvs\secondlook\Scripts\python -m uvicorn secondlook.api.main:app --port 8000
# open http://localhost:8000   (or `npm run dev` in frontend/ for hot reload on :5173)
```
`.env` sets `SECONDLOOK_DATA` (here `C:/Users/Advit/secondlook-data`, outside OneDrive so SQLite locking
and multi-GB slides behave). The app reads only `$SECONDLOOK_DATA/bundle` plus the slide `.tif` files
(Deep Zoom). If a slide file is missing the viewer falls back to the thumbnail.

Tests: `python -m pytest -q` (23 passing: coordinates, storage alignment, coverage, decision rules, API flow).

## Architecture
```
public datasets -> pipeline (tile, artifact gate, frozen encoders, probes, bars, disagreement, regions, exemplars)
                -> bundle/ (SQLite + Parquet + .npy + FAISS + eval JSON)
                -> FastAPI (evidence | disagreement | coverage | policy | audit | replay)
                -> React + OpenSeadragon workspace
```
| Path | What |
|---|---|
| `secondlook/geometry.py` | the one coordinate system (level-0 px), tile grid, magnification convention |
| `secondlook/store/` | SQLite schema + migrations, alignment-checked Parquet/.npy |
| `secondlook/pipeline/` | tiler, artifacts, embed, probes, features, disagreement, regions, exemplars, export, dataset loaders, `run_camelyon`, `run_nct`, `run_prostate`, `ingest` |
| `secondlook/core/` | coverage (seen map), sign-out check, review policies (shared by API, replay and eval) |
| `secondlook/api/` | FastAPI app and the services |
| `secondlook/eval/` | measures #1-#5, `run_all` |
| `frontend/` | React/TS/OpenSeadragon workspace + evaluation page |
| `scripts/delta/` | SLURM jobs for Delta; `scripts/process_pathogaze_local.sh` for a local GPU |

## Pipeline order
```
python -m secondlook.pipeline.run_camelyon embed <slides> --models quiltnet plip colorhist   # GPU
python -m secondlook.pipeline.run_camelyon train --models quiltnet plip colorhist          # CPU
python -m secondlook.pipeline.run_camelyon score <test slides>
python -m secondlook.pipeline.ingest pathogaze && python -m secondlook.pipeline.ingest crowdgleason
python -m secondlook.pipeline.run_nct all                                                   # GPU
python -m secondlook.pipeline.run_prostate embed|train                                      # Delta (16 GB patches)
python -m secondlook.eval.run_all       # writes bundle/eval/*.json, thresholds.json (light, routing signal)
```

## Results so far (development scale; read the caveats)
| # | Measure | Result | Scale |
|---|---|---|---|
| 5 | Human reads vs expert agreement (CrowdGleason, real labels) | 1 resident 74.3%; 2 + arbitration 85.3% at 241 reads/100; majority of 5 92.5%; of 7 98.5% | 2,812 patches, 232 slides, slide bootstrap |
| 4 | Search misses among benign calls on tumour slides | 56/69 (81%); abstract reported 67.5% | 18 of 60 PathoGaze slides |
| 4 | Search misses caught at <=1 alert per benign read (budget-matched, nested CV) | 55% (CI 21-88% by slide); random unseen 1%; colour control 0%; colleague read 27% | same |
| 4 | Same AI ignoring the gaze log, same budget | 55%: benign callers rarely fixated the top-risk tissue, so coverage adds no catch here | same |
| 2 | Errors in top-15% most-disputed lymph-node tiles | disagreement 65% vs entropy 89% -> **routing switched to entropy** | 4 slides |
| 1 | Lymph-node `metastasis` text bar AUROC / tumour probe AUROC | 0.70 / 0.93 | 4 slides |
| - | Tumour probe, out-of-fold tile AUROC (slide-grouped) | QuiltNet 0.942, PLIP 0.929, colour control 0.880 | 12 training slides |
| 3 | Artifact rules on injected damage (sanity only) | ink 54%, blur 97%, 0% clean tiles flagged | real labelled tiles pending |

The probe localises tumour on test_065 and test_122 but misses test_084 entirely (trained on only 12 slides).

## Checklist
- [x] Foundations: config, coordinates, IDs, schema + migrations, alignment-checked stores
- [x] Offline pipeline stages 1-8 (PathGen-CLIP needs `HF_TOKEN` and accepted terms; CONCH/MUSK not approved)
- [x] Dataset loaders verified against the real files (CAMELYON16, PathoGaze, CrowdGleason, NCT)
- [x] FastAPI services and all required endpoints; blind gating, audit trail, revisits, overrides
- [x] Frontend workspace verified in a browser: queue, viewer + overlays, evidence, unseen alerts, policy, replay, evaluation page
- [x] Real replay of a PathoGaze read through the live coverage/sign-out code (test_065, P10: the alert hit the unseen tumour)
- [x] Evaluations #1-#5 implemented; light cut-offs and routing signal written to `thresholds.json` by evaluation
- [ ] Process all 60 PathoGaze slides (`scripts/process_pathogaze_local.sh` running: 19/60 scored; reruns all evals when done)
- [ ] NCT-CRC-HE-100K: zip repaired and md5-verified; unzip -> `run_nct` (40K-tile cap locally) -> features + disagreement evals (chained, running)
- [ ] Full CAMELYON16 training on Delta (`scripts/delta/`); retrain, rescore
- [ ] Prostate probe on Delta -> `bundle/eval/crowdgleason_test_ai.parquet` -> AI-supported policy row
- [ ] Real artifact labels: sheet exported to `raw/artifact_sheet/` (216 tiles, flags hidden); teammates fill the CSV, save as `raw/artifact_labels.csv`
- [ ] Validation-derived tier cut-off (rank-based top 15% until then; the UI says so)

## Known facts and caveats
- CrowdGleason test has 232 WSI prefixes (the paper says 262); 114 patches lack some residents and are excluded from the primary analysis.
- Majority-of-7 agreement of 98.5% suggests the expert reference may have been formed with resident labels; check before claiming reads saved.
- Isotonic calibration cannot change a bar's AUROC (monotone); it fixes the 0-100% scale. Probe probabilities rank better.
- Viewport coverage proves only that tissue was on screen, not that it was looked at; gaze and viewport are never mixed.
- Separate organ-specific evaluations are not an end-to-end clinical validation.
