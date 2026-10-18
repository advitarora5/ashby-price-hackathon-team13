# Source from each job. Submit with: sbatch --account=<allocation> ... (#SBATCH lines cannot expand variables).
module load python/3.11 cuda 2>/dev/null || true
source "${SECONDLOOK_VENV:-$HOME/secondlook-venv}/bin/activate"
# Home quota is 100 GB: keep slides and arrays on scratch/projects.
export SECONDLOOK_DATA="${SECONDLOOK_DATA:-/scratch/$ACCOUNT/$USER/secondlook-data}"
cd "${SECONDLOOK_REPO:-$HOME/secondlook}"
# CONCH and MUSK: the hackathon's preloaded weights on Delta (override per run if they move).
export SECONDLOOK_PRIMARY_MODEL="${SECONDLOOK_PRIMARY_MODEL:-conch}"
export SECONDLOOK_SECONDARY_MODEL="${SECONDLOOK_SECONDARY_MODEL:-musk}"
export SECONDLOOK_CONCH_WEIGHTS="${SECONDLOOK_CONCH_WEIGHTS:-}"
export SECONDLOOK_MUSK_WEIGHTS="${SECONDLOOK_MUSK_WEIGHTS:-}"
