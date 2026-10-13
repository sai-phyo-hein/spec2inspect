// Shared data shapes of the line page. Used for type checking only (JSDoc + tsc --checkJs); nothing is compiled.

/** Probability of each answer "0".."9" for one compartment, from Gemma's token probabilities. */
export type Dist = Record<string, number>;

/** One compartment: grid position, pixel box [x0, y0, x1, y1] in original image pixels, and Gemma's answer. */
export interface Cell { r: number; c: number; box: [number, number, number, number]; dist: Dist | null; }

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

export interface Rule { id: number; type: RuleType; on: boolean; p: RuleParams; }

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
  hasModel: boolean; status: Record<number, RuleStatus>;
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
  upload?: boolean; liveSeconds?: number;
}

export interface LineState {
  mode: "replay" | "live";
  entries: Entry[]; playlist: Entry[]; pos: number; imgUrl: ((e: Entry) => string) | null;
  running: boolean; speed: number; live: boolean;
  /** infeed held while an uploaded photo is placed at, or inspected at, the camera */
  hold: boolean;
  inspected: number; passed: number; failed: number; agreeN: number; agreeOk: number; runMs: number;
  binGood: number; binRej: number;
  station: Box | null; lastDone: Box | null;
}

/** A photo in the Live-mode tray: a sample from the Hugging Face dataset (or the recording), or one the user uploaded. */
export interface TrayItem { name: string; url: string; kind: "sample" | "yours"; }
