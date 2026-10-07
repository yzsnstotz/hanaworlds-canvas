# Canvas independent objects/history webpage evidence

Source: 0cd4e39358f884af671c6fa5baf48a1be9cee896; branch codex/s1-canvas-region-undo-01.
Entry: http://127.0.0.1:47601/objects. See receipt.json for exact startup/build, current bytes, checks and evidence boundaries.

Four screenshots and complete accessibility snapshots show the first real empty page, explicit sample, browser + service restart preserving sample preference, and return to real empty + refresh. This is REAL_UI for the independent local webpage. The service uses actual CanvasV5/CanvasStore in its own fresh run; no world connection or new world commit was exercised. Sample rows remain explicit fixtures, and the HTTP seeded durable records are isolated test fixtures, never live world data. App integration is outside the new entry scope. No owner acceptance is inferred.

http-red.log records the intended missing-implementation failure. http-green.log records the new HTTP/read-only gate (1 pass); view-regression.log records the affected existing view gate (2 passes). Prior successful full SOURCE/package/admission gates were not repeated. validate.log is format only. assets/ contains the exact current JS/CSS. React and ReactDOM MIT notices are preserved in the source LICENSES/ directory; no new dependency or tar was produced.

previous-app-report.md preserves the prior REPORT verbatim, including old App failures and unknown embedded sourceRevision. Those failures are historical and were not rerun after the owner changed the entry.
