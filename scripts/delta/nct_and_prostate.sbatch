#!/bin/bash
#SBATCH --job-name=sl-nct-prostate
#SBATCH --partition=gpuA100x4
#SBATCH --gpus-per-node=1
#SBATCH --cpus-per-task=16
#SBATCH --mem=60g
#SBATCH --time=02:00:00
source scripts/delta/common.sh
python -m secondlook.pipeline.run_nct all --models conch musk colorhist imagenet
python -m secondlook.pipeline.run_prostate embed --patches "$SECONDLOOK_DATA/raw/crowdgleason/Patches" --models conch musk
python -m secondlook.pipeline.run_prostate train --models conch musk
