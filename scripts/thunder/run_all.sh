#!/bin/bash
# One unattended run on a rented GPU machine (Thunder Compute A100). Resumable: re-running it
# skips finished slides and stages. Slides are embedded as soon as their download passes its
# checksum, so the GPU starts while the rest are still downloading.
#
#   nohup bash scripts/thunder/run_all.sh > ~/logs/run.log 2>&1 &
#
# Expects: ~/slides.txt (one CAMELYON16 slide per line), the slide downloader writing
# ~/logs/download.log, the NCT downloader writing ~/logs/nct_download.log, and `hf auth login`
# done with an account approved for CONCH and MUSK.
set -euo pipefail
cd "$(dirname "$0")/../.."
export SECONDLOOK_DATA="${SECONDLOOK_DATA:-$HOME/data}"
export SECONDLOOK_PRIMARY_MODEL=conch SECONDLOOK_SECONDARY_MODEL=musk
export SECONDLOOK_STRICT_MODELS=1   # a model that does not load stops the run instead of being skipped
PY="${PY:-$HOME/venv/bin/python}"
MODELS="conch musk quiltnet plip colorhist imagenet"
SLIDES="${SLIDES:-$HOME/slides.txt}"
DL_LOG="${DL_LOG:-$HOME/logs/download.log}"
NCT_LOG="${NCT_LOG:-$HOME/logs/nct_download.log}"
stamp() { echo "== $(date +%H:%M:%S) $*"; }

stamp "smoke test: CONCH and MUSK load and embed"
$PY scripts/delta/smoke_encoders.py --models conch musk

stamp "embed CAMELYON16 slides as their downloads finish"
# one process per batch of downloaded slides, so the six models load once per batch, not per slide
while true; do
  # the downloader prints "<name> <bytes> xml|no-xml" once the checksum has passed
  ready=$(grep -oE "^[a-z]+_[0-9]+ [0-9]+ (xml|no-xml)$" "$DL_LOG" | cut -d' ' -f1 | grep -Fx -f "$SLIDES" \
          | while read -r s; do [ -f "$SECONDLOOK_DATA/work/camelyon16/$s/info.json" ] || echo "$s"; done || true)
  if [ -n "$ready" ]; then
    $PY -m secondlook.pipeline.run_camelyon embed $ready --models $MODELS --workers 14
    continue
  fi
  if grep -q DOWNLOADS_DONE "$DL_LOG"; then break; fi
  sleep 30
done
missing=$(while read -r s; do [ -f "$SECONDLOOK_DATA/work/camelyon16/$s/info.json" ] || echo "$s"; done < "$SLIDES")
[ -z "$missing" ] || echo "not embedded (download failed?): $missing"

stamp "NCT tissue tiles: embed, tissue probes, feature-bar calibrators"
until grep -q NCT_DONE "$NCT_LOG"; do sleep 30; done
$PY -m secondlook.pipeline.run_nct all --models $MODELS

stamp "tumour probes on the training slides"
$PY -m secondlook.pipeline.run_camelyon train --models $MODELS

stamp "score the test slides into the bundle"
$PY -m secondlook.pipeline.run_camelyon score $(grep '^test_' "$SLIDES") --models $MODELS

stamp "spatial context"
$PY -m secondlook.pipeline.context

stamp "evaluations"
$PY -m secondlook.eval.run_all || echo "run_all reported errors (see above)"
$PY -m secondlook.eval.context_eval || echo "context_eval failed (see above)"

stamp RUN_DONE
