#!/bin/bash
# CPU-only: run on a CPU node or the laptop after copying WORK + bundle.
source scripts/delta/common.sh
python -m secondlook.pipeline.run_camelyon train --models conch musk colorhist
python -m secondlook.pipeline.run_camelyon score $(ls "$SECONDLOOK_DATA/work/camelyon16" | grep '^test_')
python -m secondlook.pipeline.ingest pathogaze
python -m secondlook.pipeline.ingest crowdgleason
python -m secondlook.eval.run_all
echo "copy $SECONDLOOK_DATA/bundle to the laptop (rsync -a) before Sunday 6 pm"
