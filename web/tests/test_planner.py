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


class PlannerNamesTest(unittest.TestCase):
    def test_long_or_odd_names_are_shortened_and_references_rewritten(self):
        raw = {**GOOD,
               "params": [{"name": "Number Of Pins Per Compartment", "kind": "count", "default": "1", "operator": True},
                          {"name": "colour", "kind": "colour", "default": "yellow", "operator": True}],
               "questions": [{"id": "is-the-lid-closed?", "text": "Is the lid closed?", "answer": "yesno"}],
               "rules": [{"id": "one_pushpin_per_compartment", "text": "x", "for": "all", "test": "count == param.Number Of Pins Per Compartment"},
                         {"id": "one_pushpin_per_compartment", "text": "y", "for": "all", "test": "colour == param.colour and q.is-the-lid-closed? == true"}]}
        # names with spaces/punctuation can't appear in an expression, so a well-behaved model won't send them;
        # here the second rule's references are valid identifiers after rewriting:
        raw["params"][0]["name"] = "number_of_pins_per_compartment_value"
        raw["rules"][0]["test"] = "count == param.number_of_pins_per_compartment_value"
        raw["questions"][0]["id"] = "is_the_lid_closed_on_this_box"
        raw["rules"][1]["test"] = "colour == param.colour and q.is_the_lid_closed_on_this_box == true"
        rs = app_web.normalize_plan(raw)["ruleset"]
        self.assertEqual([r["id"] for r in rs["rules"]], ["R1", "R2"])
        self.assertEqual(rs["rules"][0]["test"], "count == param.number_of_pins_per_c")   # 20 characters
        self.assertEqual(rs["questions"][0]["id"], "is_the_lid_closed_on")
        self.assertIn("q.is_the_lid_closed_on == true", rs["rules"][1]["test"])


class PlannerCoverageTest(unittest.TestCase):
    SPEC = ("Each compartment holds exactly one pushpin.\nThe box holds 15 pushpins in total.\nEvery compartment is enclosed by walls.\n"
            "Allow operator to specify colors to check.\nAllow operator to change the number of pins pr compartment.")

    def plan_with(self, replies):
        import base64, io
        from PIL import Image
        calls = []
        def fake(model, jpeg, text):
            calls.append(text); return replies[min(len(calls), len(replies)) - 1]
        app_web.call_gemini = fake; app_web._plan_times.clear()
        buf = io.BytesIO(); Image.new("RGB", (64, 64)).save(buf, format="JPEG")
        out = app_web.plan(app_web.PlanIn(spec_text=self.SPEC, image="data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode(),
                                          model=app_web.PLANNER_MODELS[0]), x_admin_token="")
        return out, calls

    THREE = {**GOOD, "params": [{"name": "n", "kind": "count", "default": "1", "operator": True}], "rules": GOOD["rules"][:3],
             "coverage": [{"sentence": "S1", "how": "rule", "rules": ["R1"]}, {"sentence": "S2", "how": "rule", "rules": ["R2"]},
                          {"sentence": "S3", "how": "rule", "rules": ["R3"]}, {"sentence": "S5", "how": "operator_setting", "params": ["n"]}]}
    FOUR = {**GOOD, "coverage": THREE["coverage"] + [{"sentence": "S4", "how": "operator_setting", "params": ["colour"], "rules": ["R4"]}]}

    def test_sentences_are_numbered_for_the_model(self):
        _, calls = self.plan_with([self.FOUR])
        self.assertIn("S4: Allow operator to specify colors to check.", calls[0])

    def test_a_missing_sentence_triggers_one_retry_with_feedback(self):
        out, calls = self.plan_with([self.THREE, self.FOUR])
        self.assertEqual(len(calls), 2)
        self.assertIn("no coverage entry for S4", calls[1])
        self.assertEqual((out["attempts"], out["warnings"]), (2, []))
        self.assertEqual(len(out["ruleset"]["rules"]), 4)

    def test_remaining_gaps_are_returned_as_warnings(self):
        out, calls = self.plan_with([self.THREE, self.THREE])
        self.assertEqual(len(calls), 2)
        self.assertTrue(any("S4" in w for w in out["warnings"]))

if __name__ == "__main__":
    unittest.main()
