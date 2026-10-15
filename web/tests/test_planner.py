"""Tests for validating the Inspection Planner's output (app_web.normalize_plan). Run: python -m unittest discover tests"""
import os, sys, unittest
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
os.environ.setdefault("REPLAY_DIR", "/nonexistent")
import app_web  # noqa: E402

GOOD = {"region_program": {"steps": [{"op": "normalize_light"}, {"op": "grid_from_walls", "rows": "auto", "cols": "5"},
                                     {"op": "wall_segments", "missing_below": 0.3}]},
        "rules": [{"type": "each_exact", "n": 1, "c": 9}, {"type": "box_exact", "n": 15}, {"type": "walls"}],
        "sensitivity": 0.5, "notes": "ok"}

class PlannerOutputTest(unittest.TestCase):
    def test_a_good_plan_is_normalised(self):
        out = app_web.normalize_plan(GOOD)
        grid = out["program"]["steps"][1]
        self.assertEqual((grid["rows"], grid["cols"]), ("auto", 5))           # "5" becomes a number
        self.assertEqual(out["rules"][0], {"type": "each_exact", "on": True, "p": {"n": 1}})   # stray "c" dropped
        self.assertEqual(out["rules"][2]["p"], {})

    def test_unknown_rule_types_are_skipped_and_empty_plans_refused(self):
        out = app_web.normalize_plan({**GOOD, "rules": GOOD["rules"] + [{"type": "make_coffee"}]})
        self.assertEqual(len(out["rules"]), 3)
        with self.assertRaises(ValueError):
            app_web.normalize_plan({**GOOD, "rules": [{"type": "make_coffee"}]})

    def test_out_of_range_values_are_refused(self):
        with self.assertRaises(Exception):
            app_web.normalize_plan({**GOOD, "region_program": {"steps": [{"op": "grid_from_walls", "rows": "12"}]}})
        with self.assertRaises(ValueError):
            app_web.normalize_plan({**GOOD, "rules": [{"type": "cell_exact", "r": 0, "c": 1, "n": 1}]})
        with self.assertRaises(ValueError):
            app_web.normalize_plan({**GOOD, "rules": [{"type": "color_all", "col": "teal"}]})

    def test_sensitivity_is_clamped(self):
        self.assertEqual(app_web.normalize_plan({**GOOD, "sensitivity": 3})["sensitivity"], 0.95)

if __name__ == "__main__":
    unittest.main()
