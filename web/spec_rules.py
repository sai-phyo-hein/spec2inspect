"""Server-side validation of rule sets (format "rules/v2"), mirroring public/js/expr.js and public/js/ruleset.js.
The browser evaluates rule sets; the server only checks them, so a plan from the Inspection Planner or an approval
can't carry an expression the line can't run. Nothing here evaluates or executes anything."""
import re

COLOURS = ["yellow", "orange", "red", "pink", "purple", "blue", "cyan", "green"]
FUNCTIONS = ("total", "distinct")
CMP = ("==", "!=", "<", "<=", ">", ">=")
ID = re.compile(r"^[A-Za-z][A-Za-z0-9_]{0,23}$")


def _tokens(src):
    out, i = [], 0
    while i < len(src):
        ch = src[i]
        if ch.isspace():
            i += 1; continue
        if src[i:i + 2] in ("==", "!=", "<=", ">="):
            out.append(("op", src[i:i + 2])); i += 2; continue
        if ch in "<>+-(),":
            out.append(("op", ch)); i += 1; continue
        if ch in "\"'":
            j = src.find(ch, i + 1)
            if j < 0: raise ValueError("unclosed string")
            out.append(("str", src[i + 1:j])); i = j + 1; continue
        m = re.match(r"\d+(\.\d+)?", src[i:])
        if m:
            out.append(("num", m.group(0))); i += len(m.group(0)); continue
        m = re.match(r"[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?", src[i:])
        if m:
            out.append(("id", m.group(0))); i += len(m.group(0)); continue
        raise ValueError(f"unexpected {ch!r}")
    return out


def parse(src):
    """Parse into a tree of tuples: ("num"|"str"|"bool"|"id", v), ("call", fn, [args]), ("not", a), ("bin", op, a, b)."""
    if not isinstance(src, str) or not src.strip(): raise ValueError("empty expression")
    if len(src) > 300: raise ValueError("expression longer than 300 characters")
    tk, pos = _tokens(src), [0]
    peek = lambda: tk[pos[0]] if pos[0] < len(tk) else None
    def nxt():
        t = peek()
        if t is None: raise ValueError("unexpected end")
        pos[0] += 1; return t
    def eat(v):
        t = nxt()
        if t[1] != v: raise ValueError(f"expected {v!r}")
    def or_e():
        a = and_e()
        while peek() and peek()[1] == "or": nxt(); a = ("bin", "or", a, and_e())
        return a
    def and_e():
        a = not_e()
        while peek() and peek()[1] == "and": nxt(); a = ("bin", "and", a, not_e())
        return a
    def not_e():
        if peek() and peek()[1] == "not": nxt(); return ("not", not_e())
        return cmp_e()
    def cmp_e():
        a = add_e()
        if peek() and peek()[1] in CMP: op = nxt()[1]; return ("bin", op, a, add_e())
        return a
    def add_e():
        a = atom()
        while peek() and peek()[1] in ("+", "-"): op = nxt()[1]; a = ("bin", op, a, atom())
        return a
    def atom():
        k, v = nxt()
        if k == "num": return ("num", float(v))
        if k == "str": return ("str", v)
        if v == "(":
            e = or_e(); eat(")"); return e
        if k == "id":
            if v in ("true", "false"): return ("bool", v == "true")
            if peek() and peek()[1] == "(":
                if v not in FUNCTIONS: raise ValueError(f"unknown function {v!r}")
                nxt(); args = []
                if peek() and peek()[1] != ")":
                    args.append(or_e())
                    while peek() and peek()[1] == ",": nxt(); args.append(or_e())
                eat(")"); return ("call", v, args)
            return ("id", v)
        raise ValueError(f"unexpected {v!r}")
    tree = or_e()
    if peek() is not None: raise ValueError(f"unexpected {peek()[1]!r}")
    return tree


def parse_selector(sel):
    s = (sel or "all").strip().lower()
    if s in ("all", "*") or re.fullmatch(r"row \d|col(umn)? \d|cell \d \d|region [a-z0-9_-]{1,40}", s): return s
    raise ValueError(f"unknown selector {sel!r} (use all, row N, col N, cell R C or region NAME)")


def validate(tree, scope, params, questions):
    def walk(n, in_agg):
        kind = n[0]
        if kind == "id":
            v = n[1]
            if v.startswith("param."):
                if v[6:] not in params: raise ValueError(f"unknown parameter {v!r}")
                return
            if v.startswith("q.") or v in ("count", "colour"):
                if v.startswith("q.") and v[2:] not in questions: raise ValueError(f"unknown question {v!r}")
                if scope == "box" and not in_agg: raise ValueError(f"{v!r} is a per-region measurement")
                return
            if v == "walls.missing": return
            raise ValueError(f"unknown name {v!r}")
        if kind == "call":
            fn, args = n[1], n[2]
            if scope == "region": raise ValueError(f"{fn}() is a box function")
            if not 1 <= len(args) <= 2 or args[0][0] != "id": raise ValueError(f"{fn}() takes a measurement and an optional selector")
            m = args[0][1]
            if fn == "total" and not (m == "count" or (m.startswith("q.") and m[2:] in questions)): raise ValueError("total() sums count or a q.<question>")
            if fn == "distinct" and m != "colour": raise ValueError("distinct() counts colour")
            walk(args[0], True)
            if len(args) == 2:
                if args[1][0] != "str": raise ValueError(f"{fn}()'s second argument must be a selector string")
                parse_selector(args[1][1])
            return
        if kind == "not": return walk(n[1], in_agg)
        if kind == "bin": walk(n[2], in_agg); walk(n[3], in_agg)
    walk(tree, False)


def validate_ruleset(d):
    """Check a rule set and return a clean copy. Raises ValueError with a readable message."""
    if not isinstance(d, dict): raise ValueError("expected a rule-set object")
    sens = d.get("sensitivity", 0.5)
    if not isinstance(sens, (int, float)) or not 0.05 <= sens <= 0.95: raise ValueError("sensitivity must be 0.05-0.95")
    params = {}
    for name, p in (d.get("params") or {}).items():
        if not ID.match(name) or not isinstance(p, dict): raise ValueError(f"bad parameter {name!r}")
        kind = p.get("kind") or ("colour" if isinstance(p.get("default"), str) else "count")
        if kind == "colour":
            if p.get("default") != "any" and p.get("default") not in COLOURS: raise ValueError(f"parameter {name!r}: unknown colour")
        elif kind == "count":
            if not isinstance(p.get("default"), int) or not 0 <= p["default"] <= 99: raise ValueError(f"parameter {name!r}: default must be 0-99")
        else: raise ValueError(f"parameter {name!r}: kind must be count or colour")
        params[name] = {"default": p["default"], "kind": kind, **({"operator": True} if p.get("operator") else {}),
                        **({"label": str(p["label"])[:60]} if p.get("label") else {})}
    questions = []
    for q in d.get("questions") or []:
        if not isinstance(q, dict) or not ID.match(str(q.get("id", ""))): raise ValueError("bad question id")
        if not isinstance(q.get("text"), str) or not 5 <= len(q["text"]) <= 200: raise ValueError(f"question {q['id']!r}: text 5-200 chars")
        if q.get("answer") not in ("yesno", "count"): raise ValueError(f"question {q['id']!r}: answer must be yesno or count")
        questions.append({"id": q["id"], "text": q["text"], "answer": q["answer"]})
    if len(questions) > 4: raise ValueError("at most 4 custom questions")
    rules, seen = [], set()
    if not isinstance(d.get("rules"), list) or not 1 <= len(d["rules"]) <= 20: raise ValueError("expected 1-20 rules")
    for i, r in enumerate(d["rules"]):
        rid = str(r.get("id") or f"R{i + 1}")
        if not ID.match(rid) or rid in seen: raise ValueError(f"rule {rid}: id must be a unique short identifier")
        seen.add(rid)
        try:
            if "for" in r: parse_selector(r["for"])
            validate(parse(r.get("test")), "region" if "for" in r else "box", params, {q["id"] for q in questions})
        except ValueError as ex:
            raise ValueError(f"rule {rid}: {ex}")
        rules.append({"id": rid, "test": str(r["test"]), **({"for": str(r["for"])} if "for" in r else {}),
                      **({"text": str(r["text"])[:200]} if r.get("text") else {}), **({"on": False} if r.get("on") is False else {})})
    return {"version": "rules/v2", "sensitivity": float(sens), "params": params, "questions": questions, "rules": rules}
