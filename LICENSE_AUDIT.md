# Canvas 0.1.1 source rights audit

Scope: public baseline `d27be3f51e6733ab4f720700bb86145e9a578a5d`,
its six commits through that revision, and this Canvas origin's tracked paths.

- `git log --all -- src test README.md GADGET.md cordis.patch.yml NOTICE package.json`
  shows one author, `yzsnstotz <snstotz@gmail.com>`, for all source and test
  changes through the baseline. Baseline `NOTICE` declares the source
  owner-authored. No tracked source file carries a different copyright header
  or a copied third-party/AGPL derivative notice.
- `src/`, `test/`, `README.md`, `GADGET.md`, `cordis.patch.yml`, and package
  metadata are Canvas-owned material. This candidate changes their owner
  license from AGPL-3.0-only to MIT under the standing Stage 1 instruction.
  The historical 0.1.0 revision remains AGPL-3.0-only.
- `canonicalize@5.1.0` is a separately installed Apache-2.0 dependency;
  `icu@2.3.1` is a separately installed Unicode-3.0 dependency. No source from
  either package is copied into this repository. Their package license files
  must remain in the installed dependency trees. The package carries this
  dependency notice in `NOTICE`.
- WorldEdit and the Luanti Adapter are separate origins; no bytes from either
  are in the Canvas package. Canvas now includes only the current v3/v4
  runtime import closure and six test fixtures from admitted
  hanaworlds-contracts@0.3.2 public revision
  `3d64364782181c8b5abc3150f8fa9f7ae20bf101`. Its MIT LICENSE and NOTICE
  are retained under `vendor/contracts/`, with an exact per-file provenance
  manifest bound to the admitted package SHA256
  `48f0b56a3b385bd3a17773fd968c0566068fe1a28ecb4aa08d9686d254cdbb0a`.
  Canvas does not relicense third-party source or alter Contracts semantics.

The repository history and owner-authored baseline notice are the available
provenance evidence. They do not independently prove legal title outside this
repository; a contrary ownership claim would require the PM to stop a public
push and resolve the exact file with its holder.
