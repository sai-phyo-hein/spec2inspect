// Shared data shapes of the line page. Used for type checking only (JSDoc + tsc --checkJs); nothing is compiled.

/** Probability of each answer "0".."9" for one compartment, from Gemma's token probabilities. */
export type Dist = Record<string, number>;

/** One compartment: grid position, pixel box [x0, y0, x1, y1] in original image pixels, and Gemma's answer. */
export interface Cell {
  r: number; c: number; box: [number, number, number, number]; dist: Dist | null;
  /** named region (fixed_regions programs) */
  id?: string;
  /** answers to the rule set's custom questions, per question id */
  q?: Record<string, Dist | null>;
}

/** One internal wall segment: vertical ("v") or horizontal ("h"), its position, and the measured wall-line strength. */
export interface Wall { o: "v" | "h"; r: number; c: number; strength: number; }

/** One recorded (or live) inspection of a box image. */
export interface Entry {
  entry: string; img_id: string;
  /** dataset ground truth: 0 good, 1 logical anomaly, null for an uploaded photo */
  label: 0 | 1 | null;
  color: string; stops: number;
  rows: number; cols: number; xs: number[]; ys: number[]; grid_strength: number;
  cells: Cell[]; walls: Wall[];
  seconds?: number; live?: boolean; w?: number; h?: number;
}

/** replay/index.json */
export interface ReplayIndex {
  model: string; recorded: string; cell_text?: string; gpu?: string; servers?: number;
  entries: Entry[];
}

export type RuleType =
  | "each_exact" | "each_max" | "each_min" | "cell_exact" | "row_total" | "col_total"
  | "box_exact" | "box_range" | "walls" | "color_all" | "color_same";

/** Rule parameters: n = count, r/c = row/column (1-based), a/b = range, col = colour name. */
export interface RuleParams { n?: number; r?: number; c?: number; a?: number; b?: number; col?: string; }

export interface RuleDef { p: RuleParams; t: string; k?: string; }

export interface Rule {
  id: number; type: RuleType; on: boolean; p: RuleParams;
  /** parameters the operator may change on the production line (e.g. ["col"] or ["n"]) */
  operator?: (keyof RuleParams)[];
}

export interface RuleSet {
  items: Rule[]; seq: number;
  add(type: RuleType, p?: RuleParams): void;
  remove(rule: Rule): void;
}

export type RuleStatus = "pass" | "fail" | "off" | "n/a";

/** A compartment after the rules: most likely count and whether a rule flagged it. */
export interface EvalCell extends Cell { count: string; viol: number | null; flagged: boolean; }

export interface Evaluation {
  cells: EvalCell[]; missing: Wall[]; failed: boolean; findings: string[];
  hasModel: boolean; status: Record<string, RuleStatus>;
}

/** A named value rules can refer to as param.<name>; operator: true lets the operator change it on the line. */
export interface RuleParamDef { default: number | string; kind: "count" | "colour"; operator?: boolean; label?: string; }

/** A custom question the planner asks Gemma in every region (read in rules as q.<id>). */
export interface Question { id: string; text: string; answer: "yesno" | "count"; }

/** An expression rule: with "for", checked in every selected region; without, checked once per box. */
export interface ExprRule { id: string; test: string; for?: string; text?: string; on?: boolean; }

/** What each region and box must satisfy (format rules/v2). */
export interface RuleSetV2 {
  version: "rules/v2"; sensitivity: number;
  params: Record<string, RuleParamDef>; questions: Question[]; rules: ExprRule[];
}

/** A box photo ready for drawing and pixel measurement. */
export interface BoxImage { canvas: HTMLCanvasElement; variant: [string, number]; w: number; h: number; }

export type BoxPhase = "infeed" | "station" | "toDiverter" | "good" | "reject" | "done";

/** A box moving through the scene. */
export interface Box {
  id: number; entry: Entry; el: HTMLDivElement; x: number; y: number; phase: BoxPhase;
  image: BoxImage | null; result: Evaluation | null; colors?: (string | null)[];
  revealed: number; dist: number; removing?: boolean;
  /** an uploaded photo inspected live (not from the recording) */
  upload?: boolean; liveSeconds?: number; name?: string;
  /** set when the box is removed from the line mid-inspection (e.g. switching to Live) */
  cancelled?: boolean;
  /** uploads: runs the analysis on the GPU (with progress), and is told when the box is done */
  analyse?: (progress: (seconds: number) => void) => Promise<Entry>;
  onDone?: () => void;
}

export type Mode = "replay" | "live" | "check";

export interface LineState {
  mode: Mode;
  entries: Entry[]; playlist: Entry[]; pos: number; imgUrl: ((e: Entry) => string) | null;
  running: boolean; speed: number; live: boolean;
  inspected: number; passed: number; failed: number; agreeN: number; agreeOk: number; runMs: number;
  binGood: number; binRej: number;
  station: Box | null; lastDone: Box | null;
}

/** A photo in the Live-mode tray: a sample from the Hugging Face dataset (or the recording), or one the user uploaded. */
export interface TrayItem { name: string; url: string; kind: "sample" | "yours"; }

/** One live inspection of an uploaded photo, kept for the Check page (and in localStorage). */
export interface CheckRecord {
  id: string; at: string; name: string;
  /** small JPEG of the photo with its inspection overlay */
  thumb: string;
  failed: boolean; findings: string[]; counts: string[];
  seconds: number | null; rules: string[];
  /** approved specification version the photo was inspected with */
  spec_version?: number | null;
}

/** One step of a region program (the fixed operation set the line can execute). */
export type RegionStep =
  | { op: "normalize_light" }
  | { op: "grid_from_walls"; rows?: number | "auto"; cols?: number | "auto"; inset?: number; max_cells?: number }
  | { op: "fixed_regions"; regions: { id?: string; box: [number, number, number, number]; row?: number; col?: number }[] }
  | { op: "wall_segments"; missing_below?: number };

/** How a container is divided into regions: output by the planner, executed by the line. */
export interface RegionProgram { program: "region-plan/v1"; steps: RegionStep[]; }

/** The layout a program resolved to on a sample (for display). */
export interface Layout { rows: number; cols: number; }

/** Accuracy of a rule set on labelled images (null when the images are mocks without ground truth). */
export interface AccuracyReport {
  images: string; n: number; tp: number; fp: number; tn: number; fn: number;
  accuracy: number; recall: number; false_alarm: number; auroc: number | null; note?: string;
}

/** A specification approved on the Admin page; the production line runs the latest one. */
export interface SpecVersion {
  version: number; approved_at: string; program: RegionProgram; layout?: Layout | null;
  ruleset?: RuleSetV2;
  /** specifications approved before rules/v2 */
  rules?: { type: RuleType; on: boolean; p: RuleParams; operator?: (keyof RuleParams)[] }[]; threshold?: number;
  accuracy: AccuracyReport | null; spec_text?: string;
}
