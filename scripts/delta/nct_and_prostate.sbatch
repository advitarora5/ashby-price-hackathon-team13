#!/bin/bash
#SBATCH --job-name=sl-nct-prostate
#SBATCH --partition=gpuA40x4
#SBATCH --gpus-per-node=1
#SBATCH --cpus-per-task=16
#SBATCH --mem=64g
#SBATCH --time=02:00:00
#SBATCH --account=${ACCOUNT}
source scripts/delta/common.sh
python -m secondlook.pipeline.run_nct all --models quiltnet plip pathgen colorhist imagenet
python -m secondlook.pipeline.run_prostate embed --patches "$SECONDLOOK_DATA/raw/crowdgleason/Patches" --models quiltnet plip pathgen
python -m secondlook.pipeline.run_prostate train --models quiltnet plip pathgen
