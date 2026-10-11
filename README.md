# HanaWorlds Canvas

Canvas `0.13.2` manages local world selection, object footprints, recoverable
transactions and durable Undo/Redo history. It provides `canvas/v7` and
`canvas-region/v3`, using the formal Contracts `v2.2.1` git tag.

Install with Node `24.13.1` and run:

```sh
npm ci
npm run build
npm run verify:contracts
npm run typecheck
node --test test/protocol-handshake.test.mjs test/session-world-seam.test.mjs && npm test
```

[Host services and transaction behavior](GADGET.md) describe the module boundary.
The single package entry includes the DSH objects/history panel; its bundle has no
fixture switch. Isolated mocks and public NativeFacts fixtures exercise Canvas's real
store and transaction paths. Retired fixture pages and evidence are preserved in the
canvas-01 runtime archive and Git history.

Source, fixture, bundle and package checks remain distinct from real-world GUI
validation and owner ACCEPTED. Product readiness is `UNPROVEN`.
