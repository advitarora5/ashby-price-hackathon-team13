"""Run every evaluation that has its inputs; each writes bundle/eval/<name>.json.

    python -m secondlook.eval.run_all
"""
from __future__ import annotations

import traceback


def main():
    from secondlook.eval import artifacts_eval, disagreement_eval, features_eval, policy_eval, unseen_eval

    for name, fn in (("policy", policy_eval.run), ("features", features_eval.run),
                     ("disagreement", disagreement_eval.run), ("artifacts", artifacts_eval.run),
                     ("unseen", unseen_eval.run)):
        print(f"== {name}", flush=True)
        try:
            fn()
        except Exception:  # one missing input must not block the others
            traceback.print_exc()


if __name__ == "__main__":
    main()
