# Canvas 0.1.0 candidate

Status: `PARTIAL / SOURCE+FIXTURE`. The S1-02 product and human validation are
`UNPROVEN`; no release, deployment or user `ACCEPTED` is claimed.

Given authorized `canvas/v2` calls and an authorized `world-adapter/v2` provider,
Canvas persists engine-neutral world/object choices, computes affected-object
decisions, and returns scoped results. It owns the registry, selection, analysis,
decision and future linked-history state. The Adapter owns engine transport,
protected before-image, mutation and recovery. Workshop owns Sessions and intent.

## Public boundary

The package exports a DSH plugin `apply(ctx)` and a `CanvasV2.call(operation,raw)`
port. Adapter calls use only `WorldAdapterV2.call`. Its DSH host requires:

- `hanaworldsAuthority.verify`: current actor/session/authorization/action and
  world revision proof. A fixture verifier is not a product grant.
- `hanaworldsProfileStorage.canvasDirectory`: an isolated, writable profile
  directory. Canvas does not pick a developer path or copy credentials.
- `hanaworldsWorldAdapterV2` plus a declared adapter identity from composition.

Implemented source operations: ListWorldConnections, SelectWorldConnection,
SwitchWorldConnection, ListObjects, SetObjectSelection, NameObject,
RenameObject, InspectObject, AnalyzeAffectedObjects,
DecideAffectedObjectNotification and HistoryQuery. CreateObject accepts only a
Canvas-reserved ref linked to a durable VERIFIED transaction; no such production
entry exists under the current frozen v2 contract, so arbitrary client refs are
rejected. Unsupported `ApplyRecoverableCommit`, `Readback`, `Undo`, `Redo`
currently fail closed and are **not** component checks passed.

Raw UTF-8 admission rejects malformed bytes, duplicate decoded keys and unsafe
JavaScript values before authority lookup. Current authority/revocation precedes
persisted replay; revision checks precede state changes. Object names use
`icu@2.3.1` ICU4X WASM NFC and White_Space data, pinned in the npm lock, so the
host Node 22 Unicode data version is not used for persistent comparison keys.
The source tests cover representative names and all Unicode scalar White_Space
membership against the frozen list. Full Unicode17 normalization conformance
against the published contracts package is not claimed.

## Durable state and lifecycle

Canvas stores `canvas-v2.json` under the host-provided profile directory. Each
commit writes a mode-0600 temporary file, fsyncs it, renames it over the prior
snapshot and fsyncs the directory. A single writer instance per profile is
required. Restart opens the same versioned state; unknown schema versions fail
closed. The file retains object registry, selections, replay records and later
history until an explicit supported migration or deletion. Uninstall must keep
this state and Adapter recovery journal.

The package has `private: true` as a registry publication guard. `npm ci` from
the exact lock, `npm run build`, `npm test` and `npm pack --ignore-scripts` are
the source/package checks. A DSH install must use the declared public origin
after task-branch publication; local tarballs are diagnostic only. The DSH
`cordis.patch.yml` registers only this plugin, with no engine payload.

Rollback of code requires stopping the profile, backing up `canvas-v2.json`,
installing an earlier verified package and confirming that package can read
schema version 1 before restart. If it cannot, keep the state and stop the
downgrade. Removing the package must not erase worlds, objects, histories or
Adapter pending recovery evidence. The isolated DSH profile local-tarball
install, unload/reinstall and loopback restart are lifecycle diagnostics only;
public-origin install and downgrade readback remain `NOT_RUN` until separately
evidenced.

## Exact open gates

The approved rc.5 v2 public contract has three semantic gaps identified by an
independent audit: a caller cannot legally obtain the required
`preparedTransaction` before `ApplyRecoverableCommit`; complete inverse state
for a newly authorized Undo is inaccessible and not encodable in
`operations/v2` effects; and `CreateObject` does not define how the Canvas-owned
stable `objectRef` reaches the caller. No private Adapter journal read,
WorldEdit undo substitution or caller-generated ref is used here. These need a
new approved semantic closure and fixtures before implementation.

Separately, the current Adapter captures its `hanaworldsLuantiInspectionContext`
host hook when it loads before Canvas. The host/Adapter must provide a stable
trusted context or late binding for real InspectWorld; a fixture response only
proves the Canvas consumer checks. This is an implementation/composition repair,
not a product decision. Real Shell+Canvas+Luanti player-visible entry, binding,
mutation, linked history, restart recovery and rollback are `NOT_RUN`.

## Sources and licenses

Owner-authored source is AGPL-3.0-only; the complete license is included.
`canonicalize@5.1.0` is Apache-2.0. The portable Unicode implementation uses
official ICU4X `icu@2.3.1` under Unicode-3.0, locked to its npm integrity.
The [ICU4X changelog](https://github.com/unicode-org/icu4x/blob/main/CHANGELOG.md)
records the 2.3 line and Unicode17 data work; its published JavaScript package
includes a precompiled NFC normalizer and White_Space property. WorldEdit and
the Luanti Adapter are separate origins with their own licenses and bytes.
