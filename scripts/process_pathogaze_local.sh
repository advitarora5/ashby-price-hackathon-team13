#!/bin/bash
# Local GPU loop: embed + score each PathoGaze experiment-I slide as soon as its
# download finishes, then re-ingest reads and re-run the evaluations. Resumable.
set -u
PY=${PY:-/c/Users/Advit/.venvs/secondlook/Scripts/python.exe}
DATA=${SECONDLOOK_DATA:-C:/Users/Advit/secondlook-data}
IMG="$DATA/raw/camelyon16/images"
SLIDES=$(cat "$DATA/raw/pathogaze/exp1_slides.txt")
for s in $SLIDES; do
  for i in $(seq 1 720); do                       # wait up to 2 h for the download
    [ -f "$IMG/$s.tif" ] && [ ! -f "$IMG/$s.tif.part" ] && break
    sleep 10
  done
  [ -f "$IMG/$s.tif" ] || { echo "skip $s (not downloaded)"; continue; }
  $PY -m secondlook.pipeline.run_camelyon embed "$s" --models quiltnet plip colorhist 2>&1 | grep -E "^\[embed\]"
  $PY -m secondlook.pipeline.run_camelyon score "$s" 2>&1 | grep -E "^\[score\] $s"
done
$PY -m secondlook.pipeline.ingest pathogaze
$PY -m secondlook.eval.run_all 2>&1 | grep -E "^==|^\[unseen\]|Error"
echo DONE
