# Source from each job. Submit with: sbatch --account=bfqi-delta-gpu ... (#SBATCH lines cannot expand variables).
module load pytorch-conda/2.8   # hackathon-recommended stack (torch + CUDA)
unset PYTHONNOUSERSITE          # packages installed with pip install --user
# Home quota is 100 GB: keep slides and arrays on /work/nvme (not backed up, readable by all participants).
export SECONDLOOK_DATA="${SECONDLOOK_DATA:-/work/nvme/bfqi/$USER/secondlook-data}"
cd "${SECONDLOOK_REPO:-$HOME/secondlook}"
# CONCH and MUSK download into the HF cache with your own token (accept both licences first).
export SECONDLOOK_PRIMARY_MODEL="${SECONDLOOK_PRIMARY_MODEL:-conch}"
export SECONDLOOK_SECONDARY_MODEL="${SECONDLOOK_SECONDARY_MODEL:-musk}"
export SECONDLOOK_CONCH_WEIGHTS="${SECONDLOOK_CONCH_WEIGHTS:-}"
export SECONDLOOK_MUSK_WEIGHTS="${SECONDLOOK_MUSK_WEIGHTS:-}"
