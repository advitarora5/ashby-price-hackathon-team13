"""Encode the concept vocabulary (config/concepts_lymph_node.yaml) with the CONCH text encoder and
save the concept directions next to the bundle's text banks. CPU is enough (a few seconds).

Needs torch + the conch package + CONCH access (`hf auth login`). It can run in its own virtualenv,
so the app itself never needs torch:

    SECONDLOOK_DATA=<data> <venv-with-conch>/bin/python scripts/build_concept_vocab.py

Writes <bundle>/models/concept_vocab_conch.npz: ids, labels, groups, directions [k, 512] (unit),
built as text(template.format(label)) - text(neutral), as in CoCoX. Before writing, it re-encodes
the feature text bank's prompts and checks they match the exported bank, so the vocabulary is in
the same space as the tile embeddings.
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import yaml

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from secondlook.config import REPO_ROOT, bundle_paths  # noqa: E402
from secondlook.pipeline.embed import get_encoder  # noqa: E402
from secondlook.pipeline.features import load_features, text_bank  # noqa: E402

VOCAB = REPO_ROOT / "config" / "concepts_lymph_node.yaml"


def main() -> None:
    paths = bundle_paths()
    enc = get_encoder("conch")
    banked = np.load(paths.models_dir / "text_banks" / "conch.npz")
    fresh = text_bank(enc, load_features()[1])
    agree = min(float(fresh[str(i)][0] @ banked["protos"][k][0]) for k, i in enumerate(banked["ids"]))
    print(f"re-encoded feature prompts vs exported bank: min cosine {agree:.4f}")
    if agree < 0.99:
        sys.exit("the text encoder does not reproduce the exported bank; not writing a mismatched vocabulary")

    v = yaml.safe_load(VOCAB.read_text())
    concepts = v["concepts"]
    neutral = np.asarray(enc.encode_text([v["neutral"]]), np.float32)[0]
    stim = np.asarray(enc.encode_text([v["template"].format(c["label"]) for c in concepts]), np.float32)
    d = stim - neutral
    d /= np.linalg.norm(d, axis=1, keepdims=True)
    out = paths.models_dir / "concept_vocab_conch.npz"
    np.savez(out, version=np.array(v["version"]), ids=np.array([c["id"] for c in concepts]),
             labels=np.array([c["label"] for c in concepts]), groups=np.array([c["group"] for c in concepts]),
             directions=d.astype(np.float32))
    print(f"wrote {out}: {len(concepts)} concepts")


if __name__ == "__main__":
    main()
