# Hook budget and detached recovery (development checkout)

Codex and Claude command hooks support a `timeout` field in seconds. Their
official hook references also describe `async`, but background hook process
survival varies at session teardown. The manifests therefore retain synchronous
prompt injection and gate checks, give every command an explicit host timeout,
and make maintenance hooks record a durable job before returning. See
[Codex hooks](https://developers.openai.com/codex/hooks) and
[Claude hooks](https://code.claude.com/docs/en/hooks).

`UserPromptSubmit` and `posttool` use one absolute monotonic deadline through
`core/hook_budget.py`. The default is **18 seconds**; the bounded
`QMD_HOOK_TOTAL_SECONDS` override accepts **2–20 seconds**. The host timeout is
22 seconds, leaving two seconds for process teardown. QMD health, primary and
backfill queries, lexical probes, shadow diagnostics, and Laya smoke/predict
consume the same remaining time. Existing 5-second QMD query, 1-second lex,
2.5-second shadow and Laya policy limits are further clamped by that shared
deadline. Ordinary selector failure returns the prior QMD top-three result;
total budget exhaustion returns no injection and exit 0. `posttool` kills its
recall subprocess group on timeout. The real entrypoint tests include a slow
selector and a slow child recall under a 2-second budget.

SessionStart QMD update now records only a canonical project path in
`~/.cache/qmd/update-hook-jobs` and launches an independent one-shot worker.
The worker logs and writes a private status file, rotates at 1 MiB, and leaves
failed jobs for the next SessionStart. The existing `update.sh` worker still
handles index/embed and the existing Laya due-cycle journal/locks. The
enqueue completion means only that work was accepted, not that embed finished.
Enqueue errors are recorded in private `enqueue.log` and `enqueue.status.json`.
The first unresolved project opt-in decision is checked with a bounded,
read-only resolve and displayed synchronously. Other SessionStart notices are
recorded in the worker log and do not appear in the same host turn. The direct `run-hook update` path
remains for manual and compatibility testing.

For v2, Stop and SessionStart record action/turn-key jobs in the explicit
opt-in project's `.topical-hook-jobs`. The separate worker performs the full
source scan, one-card refresh/recovery, and fake-only synthetic drain in order.
It writes `topical-hook-status.json` and a rotating `topical-hook-worker.log`.
Enqueue failures for a valid opted-in root are recorded there too.
Jobs do not store source or assistant message bodies. flock serializes workers;
the backend attempt audit distinguishes completed and uncertain model calls.
An interrupted worker leaves the job; the next boundary enqueues a wake-up.
The regression suite kills the enqueuing parent and races two SessionStart
entries in an isolated synthetic project. No global daemon or OS security
setting is changed. An approved Codex host run subsequently tested an isolated project with
project-local hooks trusted through the official folder and `/hooks` UI. Both
update and topical jobs were still pending when the synthetic host turn ended
and completed 2.99s and 4.23s after Codex shutdown, respectively. A 1s
SessionStart hook timeout interrupted the parent shell while detached workers
continued. No global hook or operating project was changed. Claude teardown
remains untested.
