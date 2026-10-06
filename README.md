# HanaWorlds Canvas

Stage 1 local world Canvas `0.3.0` component candidate, exposing `canvas/v5`
and consuming the public `world-adapter/v6` port. It owns current local world
selection, object footprints, recoverable apply/readback, durable history and
same-transaction Undo.

Source and fixture checks are separate from an installed player-visible product
path. Stage 1 product readiness remains `UNPROVEN`; user `ACCEPTED` is unset.

See [GADGET.md](GADGET.md) for host services, durable transactions and the
current component boundary. [GADGET-v4-legacy.md](GADGET-v4-legacy.md) preserves
the previous component guidance as historical evidence.
