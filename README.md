# workspace-dist

**Generated distribution target. Do not edit by hand.**

This repository is a build artifact. Its contents are produced one way, from the
workspace repository, by the exporter `cli/util-tools/dist-export.js` (Phase 3),
driven by the export manifest `configs/distribution.json`.

- Every release lands as a single squashed commit; no upstream history is carried over.
- Release tags are cut and published by the repository owner.
- Nothing here is authored in place: hand edits are overwritten by the next export,
  and the source of truth for every shipped file is the workspace repository.
- Distribution-only files (client README, LICENSE, generic SYSTEM.md, CI, changelog)
  are authored in the workspace repository's `dist/` overlay and copied over the
  exported tree during the export.

This placeholder README is replaced by the client-facing README at the first export.
