# OSS Launch Readiness Design

## Goal

Make the public repository understandable and safe to adopt without changing
the qmd runtime contract or introducing npm publication.

## Scope

- Align public metadata and README claims with the current Claude Code, Codex,
  and Hermes support surface.
- Correct the temporary gate-skip wording to describe the actual project-cwd,
  two-hour marker.
- Explain the wiki-compile data path and user controls in public-facing docs.
- Add lightweight contributor, security, community, issue, pull-request, CI,
  and release surfaces.
- Move superseded implementation plans and specifications into a clearly marked
  `docs/history/` archive. The current README, settings reference, and
  architecture document remain the source of truth.

## Non-goals

- Changing the skip-marker implementation to session-scoped state.
- Publishing to npm or changing the plugin marketplace distribution model.
- Running hosted-agent integration tests in CI, which require installed host
  CLIs and host credentials.

## Design

### Public contract

The README becomes the adoption entry point. It will include an English
quickstart alongside the Korean guide, a three-host compatibility table, and a
short data-handling section. The section will distinguish local qmd indexing
from optional wiki compile: when enabled, the selected source content is passed
to the configured host CLI, so the host provider's policy applies. It will also
state how to disable the feature through the agent.

The gate documentation will say that a temporary skip applies to the canonical
project cwd for two hours. This matches the marker key used by the runtime and
does not promise session isolation.

### Repository operations

Add concise repository-root policy files: `CONTRIBUTING.md`, `SECURITY.md`, and
`CODE_OF_CONDUCT.md`. Add GitHub issue and pull-request templates that request
host/version/reproduction evidence, warn against including project content or
credentials, and require tests for behavior changes.

A GitHub Actions workflow will run `npm test` on supported Node versions. It
will install no project dependencies because the repository has none, while
making the Node/Python/Bash prerequisites explicit. Hosted CLI smoke tests stay
in a release checklist rather than becoming a flaky or credentialed CI job.

### Documentation lifecycle

Existing implementation plans and design specs will move beneath
`docs/history/`. An archive README will state that those files are historical
decision records and cannot override current docs or code. This avoids exposing
old “implementation pending” status as current product documentation while
preserving provenance.

## Verification

- Add deterministic tests that enforce README/metadata/skip wording and the
  presence of the public governance and CI files.
- Prove each new contract test fails before the documentation/configuration is
  added, then make it pass.
- Run the targeted contract test, `npm test`, JSON parsing checks, YAML syntax
  validation, and `git diff --check`.
