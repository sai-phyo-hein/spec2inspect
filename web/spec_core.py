"""spec_core: shared logic for recording (Kaggle) and serving (Cloud Run).
Geometry (grid, walls) runs on an auto-gain copy of the image; the model sees the image as given."""
import io, base64, tempfile, time
import numpy as np
from PIL import Image, ImageDraw, ImageFont
from scipy import ndimage

ROWS, COLS = 3, 5
DIGITS = [str(d) for d in range(10)]
CELL_TEXT = ("The image is a close-up of a single compartment from a box of pushpins. How many pushpins are "
             "inside this compartment? Count a pushpin if its head is inside the compartment. "
             "Answer with a single digit only.")
SYSTEM = "You are a meticulous quality inspector on a packaging line. Look carefully at the image before answering."
WALL_DENSITY_MIN = 0.30     # good boxes' weakest wall line was >= 0.52; missing walls measured <= 0.10

# ---------------- grid geometry ----------------
def _smooth(p, k=9):
    return np.convolve(p, np.ones(k) / k, mode="same")

def _peaks(p, thr):
    idx = [i for i in range(1, len(p) - 1) if p[i] >= p[i - 1] and p[i] >= p[i + 1] and p[i] > thr]
    merged = []
    for i in idx:                                            # merge plateaus / near-duplicates
        if merged and i - merged[-1] < 15:
            if p[i] > p[merged[-1]]: merged[-1] = i
        else:
            merged.append(i)
    return merged

def _lines(profile, n_cells, strong=0.3, search=0.25):
    """Try every plausible (outer-left, outer-right) border pair among strong lines near the ends; keep the pair
    whose implied dividers are strongest and whose cells are most evenly sized (rejects lids/hinges/shadows)."""
    p = _smooth(profile)
    pk = _peaks(p, strong * p.max())
    span = pk[-1] - pk[0]
    los = [x for x in pk if x <= pk[0] + 0.25 * span]
    his = [x for x in pk if x >= pk[-1] - 0.25 * span]
    best = None
    for lo in los:
        for hi in his:
            if hi - lo < 0.5 * span:
                continue
            cell = (hi - lo) / n_cells
            inner = []
            for k in range(1, n_cells):
                c = lo + k * cell; w = int(search * cell)
                a, b = int(c - w), int(c + w)
                inner.append(a + int(np.argmax(p[a:b])))
            lines = [lo] + inner + [hi]
            widths = np.diff(lines)
            strength = float(np.mean([p[x] for x in inner]) / (p.max() + 1e-9))
            score = strength - 2.0 * widths.std() / widths.mean()
            if best is None or score > best[0]:
                best = (score, lines, strength)
    return best[1], best[2]

def find_grid(path, rows=ROWS, cols=COLS, sat_max=0.25, val_min=90):
    a = np.asarray(Image.open(path).convert("RGB")).astype(np.float32)
    mx, mn = a.max(-1), a.min(-1)
    wall = (mx > val_min) & ((mx - mn) / (mx + 1e-6) < sat_max)
    xs, sx = _lines(wall.mean(0), cols)
    ys, sy = _lines(wall.mean(1), rows)
    return xs, ys, min(sx, sy)

def _count_cells(profile, max_cells=8, min_strength=0.6, max_cv=0.05):
    """How many compartments along one axis: the largest count whose dividers are strong and evenly spaced."""
    best = None
    for n in range(2, max_cells + 1):
        try:
            lines, strength = _lines(profile, n)
        except Exception:
            continue
        w = np.diff(lines)
        if strength >= min_strength and w.std() / w.mean() <= max_cv:
            best = n
    return best

def detect_grid(im, max_cells=8, sat_max=0.25, val_min=90):
    """Find the container's layout from its own wall lines, without being told the size.
    Returns rows, cols, xs, ys, strength; raises ValueError if the container isn't a regular grid."""
    a = np.asarray(normalize_for_geometry(im)).astype(np.float32)
    mx, mn = a.max(-1), a.min(-1)
    wall = (mx > val_min) & ((mx - mn) / (mx + 1e-6) < sat_max)
    cols, rows = _count_cells(wall.mean(0), max_cells), _count_cells(wall.mean(1), max_cells)
    if not rows or not cols:
        raise ValueError("no regular grid of compartments found")
    xs, sx = _lines(wall.mean(0), cols)
    ys, sy = _lines(wall.mean(1), rows)
    return rows, cols, xs, ys, min(sx, sy)

def cell_boxes(xs, ys, inset=6):
    return [(r, c, (xs[c] + inset, ys[r] + inset, xs[c + 1] - inset, ys[r + 1] - inset))
            for r in range(len(ys) - 1) for c in range(len(xs) - 1)]

def wall_box(xs, ys, orient, r, c, half=0.2, inset=10):
    """Strip centred on one internal wall segment, wide enough to show a bit of both neighbouring compartments."""
    if orient == "v":
        w = half * (xs[c + 1] - xs[c])
        return (int(xs[c + 1] - w), ys[r] + inset, int(xs[c + 1] + w), ys[r + 1] - inset)
    h = half * (ys[r + 1] - ys[r])
    return (xs[c] + inset, int(ys[r + 1] - h), xs[c + 1] - inset, int(ys[r + 1] + h))


def find_grid_image(im, rows=ROWS, cols=COLS):
    with tempfile.NamedTemporaryFile(suffix=".png") as f:
        im.save(f.name)
        return find_grid(f.name, rows=rows, cols=cols)

# ---------------- synthetic edits ----------------
PIN_HUES = {"Red": 0, "Green": 85, "Cyan": 128, "Blue": 165, "Purple": 195, "Pink": 225}   # PIL HSV hue (0-255)
COLOR_MODES = ["Original", *PIN_HUES, "Random per pin", "Cycle (changes every image)"]

def recolor(im, mode, seed=0):
    if mode == "Original":
        return im
    if mode.startswith("Cycle"):
        options = [*PIN_HUES, "Random per pin", "Original"]
        mode = options[seed % len(options)]
        if mode == "Original":
            return im
    hsv = np.array(im.convert("RGB").convert("HSV")).astype(np.int16)
    h, s, v = hsv[..., 0], hsv[..., 1], hsv[..., 2]
    mask = (s > 110) & (v > 70)
    base = int(np.median(h[mask])) if mask.any() else 0
    if mode == "Random per pin":
        lab, n = ndimage.label(ndimage.binary_dilation(mask, iterations=3))
        rng = np.random.default_rng(seed)
        hues = np.array(list(PIN_HUES.values()) + [26])        # include the original yellow
        target = hues[rng.integers(0, len(hues), size=n + 1)]
        h[mask] = (h[mask] - base + target[lab[mask]]) % 256
    else:
        h[mask] = (h[mask] - base + PIN_HUES[mode]) % 256
    return Image.fromarray(np.stack([h, s, v], -1).astype(np.uint8), "HSV").convert("RGB")

def expose(im, stops):
    if not stops:
        return im
    a = np.asarray(im.convert("RGB")).astype(np.float32) * (2.0 ** float(stops))
    return Image.fromarray(np.clip(a, 0, 255).astype(np.uint8))

def normalize_for_geometry(im):
    a = np.asarray(im.convert("RGB")).astype(np.float32)
    p = np.percentile(a.max(-1), 99.5)
    return Image.fromarray(np.clip(a * (230.0 / max(p, 1.0)), 0, 255).astype(np.uint8))

def wall_strength(im, xs, ys, orient, r, c):
    a = np.asarray(im.crop(wall_box(xs, ys, orient, r, c))).astype(np.float32)
    mx, mn = a.max(-1), a.min(-1)
    wall = (mx > 90) & ((mx - mn) / (mx + 1e-6) < 0.25)
    return float(wall.mean(axis=0 if orient == "v" else 1).max())

# ---------------- model answers ----------------
def answer_distribution(choice, answers):
    """Distribution over the answer set from token log-probabilities. If the backend returns no logprobs
    (some hosted APIs), fall back to the answer text with 0.9 confidence."""
    aset = set(answers)
    for step in (choice.get("logprobs") or {}).get("content") or []:
        if step["token"].strip().lower() in aset:
            lp = {}
            for t in step.get("top_logprobs", []):
                a = t["token"].strip().lower()
                if a in aset:
                    lp[a] = np.logaddexp(lp[a], t["logprob"]) if a in lp else t["logprob"]
            if lp:
                floor = min(lp.values()) - 2.0
                raw = np.array([lp.get(a, floor) for a in answers]); p = np.exp(raw - raw.max()); p /= p.sum()
                return dict(zip(answers, p.tolist()))
    text = ((choice.get("message") or {}).get("content") or "").strip().lower()
    for ch in text.split():
        ch = ch.strip(".,:;!")
        if ch in aset:
            rest = 0.1 / (len(answers) - 1)
            return {a: (0.9 if a == ch else rest) for a in answers}
    return None

def chat_body(crop, text, model="gemma"):
    buf = io.BytesIO(); crop.convert("RGB").save(buf, format="JPEG", quality=95)
    url = "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()
    return {"model": model,
            "messages": [{"role": "system", "content": SYSTEM},
                         {"role": "user", "content": [{"type": "image_url", "image_url": {"url": url}},
                                                      {"type": "text", "text": text}]}],
            "max_tokens": 2, "temperature": 0, "logprobs": True, "top_logprobs": 20,
            "chat_template_kwargs": {"enable_thinking": False}}

# ---------------- analyse (needs a model) and render (CPU only) ----------------
# ---------------- region programs ----------------
# How a container is divided is not hard-coded: it is a small *region program* (JSON), a list of steps from a fixed
# set of operations, interpreted here. The planner (built-in today, Gemini next) outputs this program; the line runs
# whatever program was approved. A fixed operation set (instead of arbitrary generated code) keeps it safe to run,
# testable, and the same on Kaggle, Cloud Run and in the browser preview.
REGION_PROGRAM_V1 = "region-plan/v1"
DEFAULT_PROGRAM = {"program": REGION_PROGRAM_V1, "steps": [
    {"op": "normalize_light"},
    {"op": "grid_from_walls", "rows": "auto", "cols": "auto", "inset": 6},
    {"op": "wall_segments", "missing_below": WALL_DENSITY_MIN},
]}

def program_for(rows, cols):
    """A grid program with a fixed size (used when callers still pass rows/cols)."""
    return {"program": REGION_PROGRAM_V1, "steps": [
        {"op": "normalize_light"},
        {"op": "grid_from_walls", "rows": int(rows), "cols": int(cols), "inset": 6},
        {"op": "wall_segments", "missing_below": WALL_DENSITY_MIN},
    ]}

def run_region_program(im, program):
    """Execute a region program on a photo. Returns the regions (cells with r, c, box), the wall segments with their
    measured strength, the resolved layout, and the missing-wall threshold the program sets."""
    if program.get("program") != REGION_PROGRAM_V1:
        raise ValueError(f"unsupported region program {program.get('program')!r}")
    im = im.convert("RGB"); geo = im
    rows = cols = 0; xs, ys = [], []; strength = 1.0; cells = []; walls = []; missing_below = WALL_DENSITY_MIN
    for step in program["steps"]:
        op = step["op"]
        if op == "normalize_light":                      # auto-gain for the geometric steps only
            geo = normalize_for_geometry(im)
        elif op == "grid_from_walls":                    # compartments from the container's own wall lines
            r, c = step.get("rows", "auto"), step.get("cols", "auto")
            if r == "auto" or c == "auto":
                dr, dc = detect_grid(im, max_cells=int(step.get("max_cells", 8)))[:2]
                r, c = (dr if r == "auto" else int(r)), (dc if c == "auto" else int(c))
            rows, cols = int(r), int(c)
            xs, ys, strength = find_grid_image(geo, rows, cols)
            xs, ys = [int(x) for x in xs], [int(y) for y in ys]
            cells = [dict(r=rr, c=cc, box=[int(v) for v in b]) for rr, cc, b in cell_boxes(xs, ys, inset=int(step.get("inset", 6)))]
        elif op == "fixed_regions":                      # explicit regions, as fractions of the photo (non-grid trays)
            W, H = im.size
            cells = [dict(r=int(g.get("row", 0)), c=int(g.get("col", i)), id=g.get("id"),
                          box=[int(g["box"][0] * W), int(g["box"][1] * H), int(g["box"][2] * W), int(g["box"][3] * H)])
                     for i, g in enumerate(step["regions"])]
            rows = 1 + max(x["r"] for x in cells); cols = 1 + max(x["c"] for x in cells); xs, ys = [], []
        elif op == "wall_segments":                      # every internal wall between neighbouring grid cells
            missing_below = float(step.get("missing_below", WALL_DENSITY_MIN))
            if xs and ys:
                segs = [("v", r_, c_) for r_ in range(rows) for c_ in range(cols - 1)] + \
                       [("h", r_, c_) for r_ in range(rows - 1) for c_ in range(cols)]
                walls = [dict(o=o, r=r_, c=c_, strength=wall_strength(geo, xs, ys, o, r_, c_)) for o, r_, c_ in segs]
        else:
            raise ValueError(f"unknown region operation {op!r}")
    if not cells:
        raise ValueError("the region program produced no regions")
    return dict(rows=rows, cols=cols, xs=xs, ys=ys, grid_strength=float(strength), cells=cells, walls=walls,
                missing_below=missing_below)

YESNO = ["yes", "no"]

def question_prompt(q):
    """A custom question from the rule set, phrased so the first token is the answer."""
    tail = "Answer with yes or no only." if q["answer"] == "yesno" else "Answer with a single digit (0-9) only."
    return f"The image is a close-up of a single region of a container. {q['text']} {tail}"

def analyze(im, ask, cell_text=CELL_TEXT, rows=ROWS, cols=COLS, max_workers=4, program=None, questions=()):
    """Divide the photo with a region program, then ask the model about every region: the pin count, plus each
    custom question of the rule set (answers go to cell["q"][question id]).
    `ask(crop, text, answers) -> dist or None`. Without a program, a fixed rows x cols grid is used."""
    from concurrent.futures import ThreadPoolExecutor
    im = im.convert("RGB")
    res = run_region_program(im, program or program_for(rows, cols))
    jobs = [(k, None, cell_text, DIGITS) for k in range(len(res["cells"]))]
    for q in questions:
        jobs += [(k, q["id"], question_prompt(q), YESNO if q["answer"] == "yesno" else DIGITS) for k in range(len(res["cells"]))]
    with ThreadPoolExecutor(max_workers=max_workers) as ex:
        answers = list(ex.map(lambda j: ask(im.crop(tuple(res["cells"][j[0]]["box"])), j[2], j[3]), jobs))
    for (k, qid, _, _), d in zip(jobs, answers):
        if qid is None:
            res["cells"][k]["dist"] = d
        else:
            res["cells"][k].setdefault("q", {})[qid] = d
    return res

def _font(size=34):
    try:
        return ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", size)
    except Exception:
        return ImageFont.load_default()

def render(im, raw, expected=1, threshold=0.5, check_walls=True):
    """Apply the rules to recorded/raw answers: returns (annotated image, verdict markdown, rows, failed)."""
    expected = int(expected); xs, ys = raw["xs"], raw["ys"]
    out = im.convert("RGB").copy(); d = ImageDraw.Draw(out); font = _font()
    findings, table = [], []
    for cell in raw["cells"]:
        p = cell["dist"]; r, c, b = cell["r"], cell["c"], cell["box"]
        count = max(p, key=p.get) if p else "?"
        viol = (1.0 - p.get(str(expected), 0.0)) if p else 1.0
        flagged = viol > threshold
        table.append(dict(check=f"compartment row {r+1}, col {c+1}", answer=count,
                          p_violation=round(viol, 3), flagged=flagged))
        if flagged:
            findings.append(f"Rule 1: compartment row {r+1}, column {c+1} looks like it has **{count}** "
                            f"pushpin(s), expected {expected} (P(violation) = {viol:.2f})")
        color = (230, 40, 40) if flagged else (60, 200, 90)
        d.rectangle(b, outline=color, width=8 if flagged else 3)
        d.text((b[0] + 10, b[1] + 6), str(count), fill=color, font=font)
    if check_walls:
        for w in raw["walls"]:
            o, r, c, s = w["o"], w["r"], w["c"], w["strength"]
            missing = s < WALL_DENSITY_MIN
            a, b2 = (f"row {r+1}, col {c+1}", f"row {r+1}, col {c+2}") if o == "v" else \
                    (f"row {r+1}, col {c+1}", f"row {r+2}, col {c+1}")
            table.append(dict(check=f"wall between {a} and {b2}", answer=f"line strength {s:.2f}",
                              p_violation=None, flagged=missing))
            if missing:
                findings.append(f"Rule 3: the wall between {a} and {b2} is **missing** (line strength {s:.2f})")
                if o == "v":
                    d.line([(xs[c + 1], ys[r]), (xs[c + 1], ys[r + 1])], fill=(255, 150, 0), width=14)
                else:
                    d.line([(xs[c], ys[r + 1]), (xs[c + 1], ys[r + 1])], fill=(255, 150, 0), width=14)
    failed = bool(findings)
    verdict = ("### FAIL\n" + "\n".join(f"- {f}" for f in findings)) if failed else "### PASS\nAll rules satisfied."
    return out, verdict, table, failed
