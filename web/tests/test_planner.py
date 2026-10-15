"""Tests for validating the Inspection Planner's output (app_web.normalize_plan) and rule sets (spec_rules).
Run: python -m unittest discover tests"""
import os, sys, unittest
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
os.environ.setdefault("REPLAY_DIR", "/nonexistent")
import app_web  # noqa: E402
import spec_rules  # noqa: E402

PROGRAM = {"steps": [{"op": "normalize_light"}, {"op": "grid_from_walls", "rows": "auto", "cols": "5"},
                     {"op": "wall_segments", "missing_below": 0.3}]}
GOOD = {"region_program": PROGRAM, "sensitivity": 0.5, "notes": "ok",
        "params": [{"name": "n", "kind": "count", "default": "1", "operator": True, "label": "pins per compartment"},
                   {"name": "colour", "kind": "colour", "default": "Yellow", "operator": True}],
        "questions": [],
        "rules": [{"id": "R1", "text": "Each compartment holds exactly n pins", "for": "all", "test": "count == param.n"},
                  {"id": "R2", "text": "15 in total", "test": "total(count) == 15"},
                  {"id": "R3", "text": "Walls", "test": "walls.missing == 0"},
                  {"id": "R4", "text": "Colour", "for": "all", "test": "colour == param.colour"}]}

class PlannerOutputTest(unittest.TestCase):
    def test_a_good_plan_is_normalised(self):
        out = app_web.normalize_plan(GOOD)
        grid = out["program"]["steps"][1]
        self.assertEqual((grid["rows"], grid["cols"]), ("auto", 5))
        rs = out["ruleset"]
        self.assertEqual(rs["params"]["n"], {"default": 1, "kind": "count", "operator": True, "label": "pins per compartment"})
        self.assertEqual(rs["params"]["colour"]["default"], "yellow")
        self.assertEqual([r["id"] for r in rs["rules"]], ["R1", "R2", "R3", "R4"])

    def test_bad_expressions_and_values_are_refused(self):
        for rules in ([{"id": "R1", "text": "x", "test": "count == 1"}],                      # per-region value at box level
                      [{"id": "R1", "text": "x", "for": "all", "test": "__import__('os')"}],  # not a function we know
                      [{"id": "R1", "text": "x", "for": "all", "test": "count == param.zz"}]):
            with self.assertRaises(Exception):
                app_web.normalize_plan({**GOOD, "rules": rules})
        with self.assertRaises(Exception):
            app_web.normalize_plan({**GOOD, "region_program": {"steps": [{"op": "grid_from_walls", "rows": "12"}]}})
        with self.assertRaises(Exception):
            app_web.normalize_plan({**GOOD, "params": [{"name": "c", "kind": "colour", "default": "teal", "operator": True}]})

    def test_questions_are_validated(self):
        q = [{"id": "lid", "text": "Is the lid closed?", "answer": "yesno"}]
        out = app_web.normalize_plan({**GOOD, "questions": q, "rules": GOOD["rules"] + [{"id": "R5", "text": "lid", "test": "total(q.lid) == 15"}]})
        self.assertEqual(out["ruleset"]["questions"], q)
        with self.assertRaises(ValueError):
            spec_rules.validate_ruleset({"questions": [{"id": "lid", "text": "Lid?", "answer": "maybe"}], "rules": [{"test": "walls.missing == 0"}]})

    def test_sensitivity_is_clamped(self):
        self.assertEqual(app_web.normalize_plan({**GOOD, "sensitivity": 3})["ruleset"]["sensitivity"], 0.95)

class AnalyzeQuestionsTest(unittest.TestCase):
    def test_custom_questions_are_asked_in_every_region(self):
        import spec_core
        from tests.test_region_program import synthetic_box
        asked = []
        def ask(crop, text, answers):
            asked.append(answers[0]); return {a: 1.0 / len(answers) for a in answers}
        res = spec_core.analyze(synthetic_box(3, 5), ask, program=spec_core.DEFAULT_PROGRAM,
                                questions=[{"id": "lid", "text": "Is the lid closed?", "answer": "yesno"}])
        self.assertEqual(len(asked), 30)                          # 15 counts + 15 yes/no
        self.assertEqual(set(res["cells"][0]["q"]["lid"]), {"yes", "no"})

if __name__ == "__main__":
    unittest.main()
