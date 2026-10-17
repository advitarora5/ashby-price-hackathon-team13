import numpy as np
import pytest

from secondlook.geometry import TileGrid, magnification, smooth_grid, visual_angle_radius_px
from secondlook.ids import parse_tile_id, sequence_digest, tile_id
from secondlook.store.arrays import AlignmentError, read_matrix, write_matrix


def test_tile_grid_for_camelyon_like_slide():
    g = TileGrid.for_slide(77824, 53760, 0.2263, 224, 0.5)
    assert g.tile_w0 == 495  # 224 * 0.5 / 0.2263
    assert g.shape == (int(np.ceil(53760 / 495)), int(np.ceil(77824 / 495)))


def test_refuses_missing_mpp():
    with pytest.raises(ValueError):
        TileGrid.for_slide(100, 100, 0, 224, 0.5)


def test_point_and_rect_round_trip():
    g = TileGrid(10_000, 6_000, 0.25, 448)
    r, c = g.point_to_rc(np.array([0, 447, 448, 9999]), np.array([0, 0, 900, 5999]))
    assert r.tolist() == [0, 0, 2, 13] and c.tolist() == [0, 0, 1, 22]
    cx, cy = g.rc_to_center(2, 1)
    assert g.point_to_rc(cx, cy) == (2, 1)
    # rectangle exactly covering tiles (1..3, 2..4) by centres
    r0, r1, c0, c1 = g.rect_to_rc_range(2 * 448, 1 * 448, 3 * 448, 3 * 448)
    assert (r0, r1, c0, c1) == (1, 4, 2, 5)
    # bbox of cells clips at the slide edge
    x, y, w, h = g.bbox_of_cells(np.array([13]), np.array([22]))
    assert x + w == 10_000 and y + h == 6_000


def test_magnification_convention():
    # zoomScale 1 at 0.25 um/px = 40x; 0.25 -> 10x
    assert magnification(1.0, 0.25) == pytest.approx(40)
    assert magnification(0.25, 0.25) == pytest.approx(10)


def test_visual_angle():
    r = visual_angle_radius_px(5, 650, 0.2331)
    assert 240 < r < 250


def test_smooth_grid_ignores_invalid():
    v = np.zeros((5, 5)); v[2, 2] = 9
    valid = np.zeros((5, 5), bool); valid[2, 2] = True; valid[2, 3] = True
    s = smooth_grid(v, valid, 3)
    assert s[2, 2] == pytest.approx(4.5) and np.isnan(s[0, 0])


def test_tile_id_round_trip():
    assert parse_tile_id(tile_id("test_001", 12, 7)) == ("test_001", 12, 7)


def test_matrix_alignment(tmp_path):
    ids = [f"s:r0c{i}" for i in range(5)]
    p = write_matrix(np.eye(5, dtype=np.float32), tmp_path / "emb_x.npy", ids, model="x")
    assert read_matrix(p, ids).shape == (5, 5)
    with pytest.raises(AlignmentError):
        read_matrix(p, list(reversed(ids)))       # same ids, different order
    with pytest.raises(AlignmentError):
        read_matrix(p, ids[:4])                    # different count
    with pytest.raises(AlignmentError):
        write_matrix(np.eye(5), tmp_path / "bad.npy", ids[:3], model="x")
    assert sequence_digest(ids) != sequence_digest(ids[::-1])
