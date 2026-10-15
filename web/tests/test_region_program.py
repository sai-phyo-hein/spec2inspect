"""Tests for the region-program interpreter (spec_core.run_region_program). Run: python -m unittest discover tests"""
import os, sys, unittest
from PIL import Image, ImageDraw
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import spec_core as sc  # noqa: E402

def synthetic_box(rows, cols, missing=None, W=1700, H=1000, pad=60, line=14):
    """A dark tray with light-grey walls: rows x cols compartments; `missing` = (r, c) of a vertical wall to leave out."""
    im = Image.new("RGB", (W, H), (12, 12, 12)); d = ImageDraw.Draw(im)
    x0, y0, x1, y1 = pad, pad, W - pad, H - pad
    xs = [x0 + (x1 - x0) * k / cols for k in range(cols + 1)]
    ys = [y0 + (y1 - y0) * k / rows for k in range(rows + 1)]
    for k, x in enumerate(xs):
        for r in range(rows):
            if missing and 0 < k < cols and (r, k - 1) == missing:
                continue
            d.rectangle([x - line / 2, ys[r], x + line / 2, ys[r + 1]], fill=(200, 200, 200))
    for y in ys:
        d.rectangle([x0, y - line / 2, x1, y + line / 2], fill=(200, 200, 200))
    return im

class RegionProgramTest(unittest.TestCase):
    def test_default_program_detects_the_layout(self):
        res = sc.run_region_program(synthetic_box(3, 5), sc.DEFAULT_PROGRAM)
        self.assertEqual((res["rows"], res["cols"]), (3, 5))
        self.assertEqual(len(res["cells"]), 15)
        self.assertEqual(len(res["walls"]), 22)

    def test_other_grid_sizes_are_detected_too(self):
        res = sc.run_region_program(synthetic_box(2, 4), sc.DEFAULT_PROGRAM)
        self.assertEqual((res["rows"], res["cols"]), (2, 4))

    def test_missing_wall_is_measured_weak(self):
        res = sc.run_region_program(synthetic_box(3, 5, missing=(1, 1)), sc.DEFAULT_PROGRAM)
        weak = [w for w in res["walls"] if w["strength"] < res["missing_below"]]
        self.assertEqual([(w["o"], w["r"], w["c"]) for w in weak], [("v", 1, 1)])

    def test_fixed_regions_for_non_grid_trays(self):
        prog = {"program": "region-plan/v1", "steps": [{"op": "fixed_regions", "regions": [
            {"id": "left", "box": [0.0, 0.0, 0.5, 1.0]}, {"id": "right", "box": [0.5, 0.0, 1.0, 1.0]}]}]}
        res = sc.run_region_program(synthetic_box(3, 5), prog)
        self.assertEqual([c["id"] for c in res["cells"]], ["left", "right"])
        self.assertEqual(res["walls"], [])

    def test_unknown_operations_are_refused(self):
        with self.assertRaises(ValueError):
            sc.run_region_program(synthetic_box(3, 5), {"program": "region-plan/v1", "steps": [{"op": "exec"}]})
        with self.assertRaises(ValueError):
            sc.run_region_program(synthetic_box(3, 5), {"program": "region-plan/v2", "steps": [{"op": "normalize_light"}]})

if __name__ == "__main__":
    unittest.main()
