# Returned project Handler runtime diagnostic on 0.13.5

The unaccepted project-only integration is retained in `attempt-overlay.patch`. Apply it to the selected DIP-12 preparation in the same delivery to inspect the attempted source; it is not installed in the normal source tree.

The official normal check passed 295 files. The original full `tests/native_projects_probe.py` then failed before its first Nomo prompt with `path does not name a runtime value in the current frame` at the immutable `recent` dependency in the returned Handler. The trace is terminal: execution_fault, no Host requests and no unsettled operations. The owned worker was automatically removed. Selected files were restored byte for byte, and the five newly selected assembly files were removed.

The failure was reported as https://github.com/etas-project/etas-interpreter/issues/118 . It is scoped to 0.13.5 and does not establish a defect on the latest graph. The upstream payload contains only the diagnostic summary, short Handler excerpt and public graph identity. `evidence.json` retains the exact local consumer/trace/source hashes and the passing source-check scope.
