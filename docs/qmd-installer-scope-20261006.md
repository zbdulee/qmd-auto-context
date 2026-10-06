# QMD 2.5.3 installer and project index routing (2026-10-06)

This development checkout has an installer, a project-local shadow index pointer,
and synthetic tests. After explicit approval, the official locked QMD 2.5.3 package
was installed in a **new inactive generation**. Its active pointer SHA-256 remained
`ce1b2b370c6a66a0b542f30d6c051d1ce00b2c9d572df8097911b239cb745df2`.
No operating project pointer, global hook, existing QMD database, or original
model was changed. Existing Mini QMD 2.5.3 was also reused by earlier fixtures.

## Locked installation

`core/qmd_installer.py` requires two explicit execution gates, validates the
checked-in `locks/qmd-2.5.3/package-lock.json` SHA-256
`a31cc40f0cbaa413d0b9988c6d7617daa60bb902379fac7f432e77b5b3f7cf3e`,
checks every registry URL and SHA-512 integrity, checks Node >=22, and calls
`npm ci` only inside a new owner-private generation with its own npm cache and
empty user npm config. It probes QMD commands and the native SQLite module,
then writes a prepared wrapper. It never changes the active runtime pointer.
The lock contains 289 package entries. `test/qmd-installer.test.mjs` still uses
an injected fake npm runner. The separate approved real install ran `npm ci
--include=optional --no-audit --no-fund` in generation
`g-dde1d942e5554063a3a211cd8e56f184` with Node 24.21.0. The 267 logged
HTTP fetches all used `registry.npmjs.org`; npm verified lock SHA-512 integrity.
`better-sqlite3` install and `node-llama-cpp` postinstall exited 0, and the
installer's native SQLite load and CLI capability probes passed. The installed
package used 176,270,750 bytes, its dedicated npm cache 51,477,385 bytes, and
the complete generation 227,757,559 bytes. The new inactive wrapper passed an
offline synthetic collection add, update, embed, and typed lex/vec query against
a disposable 3,280,896-byte SQLite DB. Evidence is in the sibling `/tmp` S03
validation directory recorded with the final snapshot.

Official sources: [QMD repository](https://github.com/tobi/qmd) and
[@tobilu/qmd 2.5.3 npm metadata](https://registry.npmjs.org/@tobilu%2Fqmd/2.5.3).
The QMD package tarball is 732,385 unpacked bytes (194,417 compressed bytes)
and requires Node >=22. Read-only one-byte HTTP range requests to all 289
official registry tarballs in the lock measured 766,646,532 compressed bytes
(731.1 MiB) in total. Filtering the lock's `os` and `cpu` fields for this
Darwin ARM64 machine leaves 266 candidate tarballs totaling 51,232,407 bytes
(48.9 MiB). These are package-tarball sums, not a measured `npm ci` transfer:
npm cache hits can reduce it and native install scripts can fetch additional
artifacts outside the lock. Thus 48.9 MiB is the expected locked package
payload, 731.1 MiB is a conservative ceiling for *locked tarballs only*, and
there is no proven all-in network cap for lifecycle scripts. The local
complete npm installation occupies about 187 MiB; the installer checks for
at least 512 MiB free before starting but does not cap its final disk use.
The dependency set
includes `node-llama-cpp` 3.18.1 (`postinstall`), `better-sqlite3` 12.10.0
(`prebuild-install` or `node-gyp rebuild`), and `sqlite-vec` 0.1.9 with an
optional Darwin ARM binary. The local Metal optional package is about 5.5 MB
unpacked and `node-llama-cpp` is about 32.3 MB unpacked. The installer leaves
the user's model cache alone; it does not install Claude.

## Project index cutover

`core/runtime_update.py` stages an index in a private generation, copies a
project QMD config, links an existing model cache, runs QMD
update/embed and a synthetic query probe, then records schema, dimension,
model fingerprint, config SHA, and original DB SHA. Explicit activation writes
only `.auto-context/qmd-index-active.json` under a pointer lock. Selection
checks the prepared proof and schema again. The new DB can then change during
normal updates without invalidating the pointer. A damaged pointer fails
closed; rollback restores the previous pointer or removes the first pointer
after checking the original DB.

Selected projects use that DB/config/cache in `core/recall.py` through a
bounded local `qmd query` JSON call, in `core/update.sh`, in the SessionStart
update worker, and in `backend/index_worker.sh`. Mixed dirty queues resolve
each collection before writing, then update each selected project in its own
environment. A selected project does not route through the global daemon.
The project's original DB and global hook config are not changed.
For selected projects, `index_enqueue.py` adds the project root as a third
dirty-queue field so collections under an explicit external `allowRoots` path
still route to the selected index. Legacy two-field entries keep their old
format. An invalid or missing selected pointer retains a three-field entry
instead of sending it to the global index.

Synthetic tests: `test/qmd-pointer-e2e.test.mjs` checks local recall, dirty
`update.sh --worker`, post-edit update including an external collection,
changed selected DB, damaged pointer requeue, original DB byte
preservation, and rollback. `test/qmd-pointer-real-cli.test.mjs` uses the
already installed QMD 2.5.3 and offline model cache with a disposable
synthetic document; typed query returned one JSON result from a 3,280,896
byte isolated SQLite file. No external model/API call was made.

## Remaining operating boundary

The approved new npm `ci` and native lifecycle smoke passed in an inactive
generation. No actual project shadow migration or private source data has been
processed. A real Codex host shutdown test did run in a disposable project
with a separate config, official folder and `/hooks` trust review, and only
synthetic prompts. Its update and topical workers both completed after the
Codex process ended. This does not test Claude host teardown or operational
private data. Claude was not installed for this check. Before product plugin activation, review its SessionStart/UserPromptSubmit/PreToolUse/PostToolUse/Stop hook effects and explicitly choose the target project. The isolated host test did not install the plugin globally.

The proposed Codex plugin manifest registers SessionStart update queue and
topical reconcile commands (5s and 3s host timeouts), blocking prompt recall
(22s), a pre-write gate (3s), four post-write actions for context, indexing,
compile and topical events (22s/5s/5s/5s), and a Stop topical boundary (3s).
The same manifest grants Read/Write capabilities. These effects must be
reviewed before installing the plugin; this task only inspected the manifest.
