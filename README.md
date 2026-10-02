# HanaWorlds Canvas

Stage 1 Canvas `0.2.0` component candidate, exposing `canvas/v4` and consuming the
public `world-adapter/v4` port. It owns world and object selection, a durable
named-object registry, affected-object decisions, recoverable apply/readback,
first-building region inspection relay, and same-author linked Undo/Redo.

Source and fixture checks are separate from an installed player-visible product
path. Stage 1 product readiness remains `UNPROVEN`; user `ACCEPTED` is unset.

See [GADGET.md](GADGET.md) for host services, placement settings, recovery,
installation, and rollback. [LICENSE_AUDIT.md](LICENSE_AUDIT.md) records the
owner-source MIT transition and third-party provenance.
