// @ts-check
// Fixed settings shared by every module.
export const ROWS = 3, COLS = 5;
export const WALL_MIN = 0.30;          // wall-line strength below this = missing wall (good boxes measured >= 0.52)
export const LIVE_MAX_MIN = 10;        // cost guard: live mode switches itself off after this many minutes

// Scene geometry, in the 1200 x 500 design space of the production-line drawing.
export const SCENE_W = 1200;
export const BOX_W = 150, BOX_H = 88, BELT_Y = 175, STATION_X = 420, DIVERT_X = 790;
export const REJECT_PATH = [[DIVERT_X, BELT_Y], [930, 415], [1150, 415]];
export const GOOD_END = 1150;
export const BELT_SPEED = 150;         // px per second at 1x
