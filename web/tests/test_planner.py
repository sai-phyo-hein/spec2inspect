"""Tests for the Inspection Planner: two streamed Gemini calls (regions, then rules), validated and checked for
coverage. Gemini is replaced by stand-ins; nothing here uses the network. Run: python -m unittest discover tests"""
import base64, io, os, sys, unittest
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
os.environ.setdefault("REPLAY_DIR", "/nonexistent")
import app_web  # noqa: E402
import spec_rules  # noqa: E402
from tests.test_region_program import synthetic_box  # noqa: E402

SPEC = ("Info about the container: equally spaced compartments, 3 rows and 5 columns.\n"
        "Each compartment holds exactly one pushpin.\nThe box holds 15 pushpins in total.\n"
        "Every compartment is enclosed by walls.\nThe user can change the detecting colour.")
REGIONS = {"region_program": {"steps": [{"op": "normalize_light"}, {"op": "grid_from_walls", "rows": "3", "cols": "5"},
                                        {"op": "wall_segments", "missing_below": 0.3}]},
           "layout_sentences": ["S1"], "notes": "A 3 x 5 grid from the walls."}
RULES = {"params": [{"name": "detecting_colour", "kind": "colour", "default": "any", "operator": True, "label": "colour"}],
         "questions": [], "sensitivity": 0.5, "notes": "ok",
         "rules": [{"id": "one_pin", "text": "Each compartment holds one pushpin", "for": "all", "test": "count == 1"},
                   {"id": "R2", "text": "15 in total", "test": "total(count) == 15"},
                   {"id": "R3", "text": "Walls present", "test": "walls.missing == 0"},
                   {"id": "R4", "text": "Pins have the selected colour", "for": "all", "test": "colour == param.detecting_colour"}],
         "coverage": [{"sentence": "S2", "how": "rule", "rules": ["one_pin"]}, {"sentence": "S3", "how": "rule", "rules": ["R2"]},
                      {"sentence": "S4", "how": "rule", "rules": ["R3"]},
                      {"sentence": "S5", "how": "operator_setting", "params": ["detecting_colour"], "rules": ["R4"]}]}

def photo():
    buf = io.BytesIO(); synthetic_box(3, 5).save(buf, format="JPEG")
    return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()

class Fake:
    """Stand-in for call_gemini: answers per stage (region / rules instructions), and streams a little thinking."""
    def __init__(self, regions, rules):
        self.replies = {"regions": list(regions), "rules": list(rules)}; self.prompts = {"regions": [], "rules": []}
    def __call__(self, model, jpeg, text, instructions, schema, on_thought=None, on_text=None):
        name = "regions" if instructions is app_web.REGION_INSTRUCTIONS else "rules"
        self.prompts[name].append(text)
        if on_thought: on_thought(f"thinking about {name}... ")
        r = self.replies[name].pop(0) if len(self.replies[name]) > 1 else self.replies[name][0]
        if isinstance(r, Exception): raise r
        if on_text: on_text('{"partial": ')
        return r

def run(fake, job=None):
    app_web.call_gemini = fake; app_web._plan_times.clear()
    body = app_web.PlanIn(spec_text=SPEC, image=photo(), model=app_web.PLANNER_MODELS[0])
    return app_web.plan_sync(body, job)

class TwoStagePlannerTest(unittest.TestCase):
    def test_regions_then_rules_with_the_regions_described(self):
        fake, job = Fake([REGIONS], [RULES]), {}
        out = run(fake, job)
        self.assertEqual(out["program"]["steps"][1]["rows"], 3)                      # "3" -> 3, as the spec states
        self.assertIn("3 x 5 regions, 22 measured walls", fake.prompts["rules"][0])  # rules are told what the regions are
        self.assertEqual([r["id"] for r in out["ruleset"]["rules"]], ["R1", "R2", "R3", "R4"])
        self.assertEqual(out["coverage"][0], {"sentence": "S1", "how": "layout", "rules": [], "params": []})
        self.assertEqual((out["warnings"], out["attempts"]), ([], 2))
        self.assertIn("thinking about regions", job["regions"]["thoughts"])           # streamed into the job
        self.assertIn("thinking about rules", job["rules"]["thoughts"])

    def test_a_missed_sentence_gets_one_correction_in_the_rules_call(self):
        partial = {**RULES, "rules": RULES["rules"][:3], "params": [], "coverage": RULES["coverage"][:3]}
        fake = Fake([REGIONS], [partial, RULES])
        out = run(fake)
        self.assertIn("no coverage entry for S5", fake.prompts["rules"][1])
        self.assertEqual((len(out["ruleset"]["rules"]), out["warnings"]), (4, []))

    def test_at_most_two_attempts_per_call(self):
        partial = {**RULES, "rules": RULES["rules"][:3], "params": [], "coverage": RULES["coverage"][:3]}
        fake = Fake([REGIONS], [partial, partial, partial])
        out = run(fake)
        self.assertEqual(len(fake.prompts["rules"]), 2)
        self.assertTrue(any("S5" in w for w in out["warnings"]))

    def test_a_timeout_is_retried_once_then_reported(self):
        fake = Fake([RuntimeError("504 DEADLINE_EXCEEDED"), REGIONS], [RULES])
        self.assertEqual(len(run(fake)["ruleset"]["rules"]), 4)
        fake = Fake([RuntimeError("504 DEADLINE_EXCEEDED"), RuntimeError("504 DEADLINE_EXCEEDED")], [RULES])
        with self.assertRaises(app_web.HTTPException) as cm:
            run(fake)
        self.assertIn("could not be reached (regions)", cm.exception.detail)

    def test_invalid_answers_are_refused(self):
        bad_regions = {**REGIONS, "region_program": {"steps": [{"op": "grid_from_walls", "rows": "12"}]}}
        with self.assertRaises(app_web.HTTPException):
            run(Fake([bad_regions], [RULES]))
        bad_rules = {**RULES, "rules": [{"id": "R1", "text": "x", "for": "all", "test": "__import__('os')"}]}
        with self.assertRaises(app_web.HTTPException):
            run(Fake([REGIONS], [bad_rules]))

class NamesAndValuesTest(unittest.TestCase):
    def test_names_are_shortened_and_references_rewritten(self):
        raw = {**RULES, "params": [{"name": "number_of_pins_per_compartment_value", "kind": "count", "default": "1", "operator": True}],
               "rules": [{"id": "x", "text": "n", "for": "all", "test": "count == param.number_of_pins_per_compartment_value"}], "coverage": []}
        rs = app_web.normalize_rules(raw)["ruleset"]
        self.assertEqual(rs["rules"][0]["test"], "count == param.number_of_pins_per_c")
        self.assertEqual(app_web.normalize_rules({**RULES, "sensitivity": 3})["ruleset"]["sensitivity"], 0.95)
        with self.assertRaises(ValueError):
            spec_rules.validate_ruleset({"questions": [{"id": "lid", "text": "Lid?", "answer": "maybe"}], "rules": [{"test": "walls.missing == 0"}]})

class GeminiStreamTest(unittest.TestCase):
    """call_gemini's request shape, streaming and fallbacks, against a stand-in client."""
    def setUp(self):
        self.calls, test = [], self
        def chunk(text, thought=False):
            part = type("P", (), {"text": text, "thought": thought})()
            return type("Ch", (), {"candidates": [type("Ca", (), {"content": type("Co", (), {"parts": [part]})()})()]})()
        class Models:
            def generate_content_stream(self, model, contents, config):
                test.calls.append(config)
                if test.fail_with and len(test.calls) == 1: raise RuntimeError(test.fail_with)
                return iter([chunk("Looking at the grid. ", True), chunk('{"ok": '), chunk("true}")])
        app_web._genai["client"] = type("C", (), {"models": Models()})()
        self.fail_with = None

    def tearDown(self):
        app_web._genai["client"] = None

    def test_streamed_thoughts_and_output_reach_the_callbacks(self):
        thoughts, text = [], []
        out = app_web.call_gemini("gemini-x", b"jpg", "S1: x", "instr", {}, thoughts.append, text.append)
        self.assertEqual(out, {"ok": True})
        self.assertEqual(thoughts, ["Looking at the grid. "])
        self.assertEqual("".join(text), '{"ok": true}')
        cfg = self.calls[0]
        self.assertEqual(cfg.response_mime_type, "application/json")
        self.assertTrue(cfg.thinking_config.include_thoughts)

    def test_models_without_thinking_levels_get_a_plain_call(self):
        self.fail_with = "400 INVALID_ARGUMENT: thinking_level is not supported for this model"
        app_web.call_gemini("gemini-x", b"jpg", "S1: x", "instr", {})
        self.assertIsNone(self.calls[1].thinking_config)

    def test_transient_errors_are_recognised(self):
        self.assertTrue(app_web.transient(RuntimeError("504 DEADLINE_EXCEEDED. Deadline expired")))
        self.assertFalse(app_web.transient(RuntimeError("403 PERMISSION_DENIED")))

if __name__ == "__main__":
    unittest.main()
