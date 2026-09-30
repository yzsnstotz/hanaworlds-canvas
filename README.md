# HanaWorlds Canvas

Stage 1 `0.1.0` component candidate on `codex/s1-02-canvas`. Status: **PARTIAL**.
The S1-02 product path is **UNPROVEN** and this candidate is not released.

Canvas persists world selection, a named object registry, ordered selection,
affected-object analysis and decisions, and safe read-only inspection through the
public `world-adapter/v2` port. It does not own Luanti transport, credentials,
Workshop Sessions, compiled buildings or a world editor.

See [GADGET.md](GADGET.md) for implemented operations, remaining contract gates,
the storage barrier, installation limits and rollback procedure.
