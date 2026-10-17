# Source from each job. Set ACCOUNT/paths for your Delta allocation.
module load python/3.11 cuda 2>/dev/null || true
source "${SECONDLOOK_VENV:-$HOME/secondlook-venv}/bin/activate"
# Home quota is 100 GB: keep slides and arrays on scratch/projects.
export SECONDLOOK_DATA="${SECONDLOOK_DATA:-/scratch/$ACCOUNT/$USER/secondlook-data}"
cd "${SECONDLOOK_REPO:-$HOME/secondlook}"
