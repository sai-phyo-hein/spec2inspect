# spec-web

The line page, its APIs and the Gradio inspection page, served by one Cloud Run service.

```
web/
├── app_web.py          FastAPI + Gradio: /api/live/*, /replay (recorded results), /inspect (Gradio), / (line page)
├── spec_core.py        Shared Python logic: grid finding, wall/colour measurement, model calls, rendering
├── public/             The line page — static files, also what Firebase Hosting serves
│   ├── index.html      Markup only
│   ├── css/line.css    Styles
│   └── js/             ES modules, one responsibility each
│       ├── main.js         entry point: wires the modules together
│       ├── config.js       constants (grid size, wall threshold, scene geometry, cost guard)
│       ├── state.js        shared line state, timing helpers
│       ├── rules.js        rule types and evaluation (pure, unit-tested)
│       ├── colours.js      pin colour per compartment from pixels
│       ├── data.js         recorded results and box images
│       ├── scene.js        conveyor drawing, clamping arms, diverter, box movement
│       ├── station.js      inspection sequence at the camera
│       ├── panel.js        AI pipeline panel (image overlay, steps, grid, verdict)
│       ├── spec-editor.js  written-specification card (add / remove / edit rules)
│       ├── live.js         Live mode (wake GPU, analyse boxes now)
│       └── log.js          line log, KPIs, mode badge
├── types/model.d.ts    shared data shapes (Entry, Rule, Evaluation, Box, ...) for type checking
├── tsconfig.json       type checking only: checkJs + strict, no build output
├── tests/rules.test.mjs    unit tests for the rule engine (npm test)
└── replay/             recorded results (downloaded by ../prepare_replay.sh; not committed)
```

Images are never embedded in the page: it loads `replay/index.json` and `replay/images/*.jpg` at run time.

## Type checking

The modules are plain JavaScript that browsers run as-is (no build step), but every file starts with `// @ts-check`
and carries JSDoc types, and `types/model.d.ts` defines the shared data shapes. The TypeScript compiler checks the
whole page in strict mode without emitting anything:

```bash
npm install          # TypeScript 5.6.3 and Node types, development only
npm run typecheck    # tsc --noEmit (checkJs, strict): must report 0 errors
npm run check        # type check + unit tests
```

## Run locally

```bash
../prepare_replay.sh                         # needs HF_TOKEN; fills web/replay
pip install -r requirements.txt
REPLAY_DIR=replay python app_web.py          # http://localhost:8080
npm install && npm run check                 # type check + rule-engine unit tests (Node 18+)
```
