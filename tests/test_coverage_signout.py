from dataclasses import replace

import numpy as np
import pandas as pd

from secondlook.config import DEFAULT_COVERAGE
from secondlook.core.coverage import compute
from secondlook.core.signout import light_for, unseen_check
from secondlook.geometry import TileGrid

G = TileGrid(10_000, 6_000, 0.25, 448)
R, C = (a.ravel() for a in np.mgrid[0:G.rows, 0:G.cols])


def fix(x, y, zoom, t=0, dur=200, seq=0):
    return dict(seq=seq, t_ms=t, kind="fixation", x=x, y=y, w=np.nan, h=np.nan, zoom=zoom, duration_ms=dur, eye_mm=650.0)


def test_gaze_seen_only_at_sufficient_magnification():
    cx, cy = G.rc_to_center(5, 10)
    p = replace(DEFAULT_COVERAGE, mode="gaze")
    hi = compute(pd.DataFrame([fix(cx, cy, zoom=0.25)]), G, R, C, p)  # 10x
    lo = compute(pd.DataFrame([fix(cx, cy, zoom=0.05)]), G, R, C, p)  # 2x
    i = np.nonzero((R == 5) & (C == 10))[0][0]
    assert hi.seen[i] and hi.dwell_ms[i] == 200
    assert not lo.seen.any() and lo.max_mag[i] > 0
    # radius: 5 deg at 650 mm ~ 244 screen px / 0.25 zoom ~ 977 level-0 px ~ 2.2 tiles
    seen_rc = {(R[k], C[k]) for k in np.nonzero(hi.seen)[0]}
    assert (5, 12) in seen_rc and (5, 14) not in seen_rc


def test_viewport_mode_and_order_independence():
    p = replace(DEFAULT_COVERAGE, mode="viewport")
    ev = pd.DataFrame([
        dict(seq=0, t_ms=0, kind="viewport", x=0, y=0, w=10_000, h=6_000, zoom=0.03, duration_ms=np.nan, eye_mm=np.nan),
        dict(seq=1, t_ms=1000, kind="viewport", x=448 * 3, y=448 * 2, w=448 * 2, h=448 * 2, zoom=0.5, duration_ms=np.nan, eye_mm=np.nan),
        dict(seq=2, t_ms=3000, kind="viewport", x=0, y=0, w=10_000, h=6_000, zoom=0.03, duration_ms=np.nan, eye_mm=np.nan),
    ])
    a = compute(ev, G, R, C, p)
    b = compute(pd.concat([ev.iloc[::-1], ev.iloc[[1]]]), G, R, C, p)  # shuffled + duplicate seq
    assert a.seen.sum() == 4  # only the zoomed-in 2x2 block counts
    assert (a.seen == b.seen).all() and np.allclose(a.dwell_ms, b.dwell_ms)
    assert a.dwell_ms.max() == 2000


def test_gaze_and_viewport_definitions_do_not_mix():
    p = replace(DEFAULT_COVERAGE, mode="gaze")
    ev = pd.DataFrame([dict(seq=0, t_ms=0, kind="viewport", x=0, y=0, w=10_000, h=6_000, zoom=1.0,
                            duration_ms=np.nan, eye_mm=np.nan)])
    assert not compute(ev, G, R, C, p).seen.any()


def test_light_and_unseen_regions():
    th = {"lo": 0.5, "hi": 0.8}
    assert light_for(0.2, th) == "green" and light_for(0.6, th) == "amber" and light_for(0.9, th) == "red"
    risk = np.zeros(len(R)); risk[(R == 3) & (C == 3)] = 0.9; risk[(R == 10) & (C == 18)] = 0.6
    tissue = np.ones(len(R), bool)
    seen = (R == 3) & (C == 3)  # the hottest tile was looked at
    res = unseen_check(G, R, C, tissue, risk, seen, th)
    assert res.light == "amber" and res.unseen_risk == 0.6
    assert len(res.regions) == 1 and (res.regions[0].peak_row, res.regions[0].peak_col) == (10, 18)
    none = unseen_check(G, R, C, tissue, None, seen, th)
    assert none.light == "unavailable"
