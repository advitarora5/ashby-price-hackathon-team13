#!/bin/bash
#SBATCH --job-name=sl-embed
#SBATCH --partition=gpuA40x4
#SBATCH --gpus-per-node=1
#SBATCH --cpus-per-task=16
#SBATCH --mem=64g
#SBATCH --time=02:00:00
#SBATCH --account=${ACCOUNT}
# usage: sbatch --export=ALL,ACCOUNT=xxxx,SLIDES="tumor_001 tumor_002" scripts/delta/embed_camelyon.sbatch
# Downloads, embeds and then deletes each slide (one at a time, quota-safe).
source scripts/delta/common.sh
for s in $SLIDES; do
  python -m secondlook.pipeline.datasets.camelyon16 "$s"
  python -m secondlook.pipeline.run_camelyon embed "$s" --models quiltnet plip pathgen colorhist imagenet --workers 16
  [ "${KEEP_SLIDES:-0}" = "1" ] || rm -f "$SECONDLOOK_DATA/raw/camelyon16/images/$s.tif"
done
