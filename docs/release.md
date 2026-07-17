# Release Checklist

## Before creating a GitHub Release

1. Confirm the version matches every host manifest and marketplace entry.
2. Run `npm test` and `git diff --check` on the release commit.
3. Verify JSON manifests parse successfully.
4. In fresh temporary projects, install the marketplace plugin for Claude Code,
   Codex, and Hermes Agent. Confirm session start, recall, and the opt-in gate
   for each supported host.
5. If wiki compile is advertised, confirm its one-time notice and disable path.
6. Publish a GitHub Release with compatibility notes, user-visible changes,
   upgrade notes, and known limitations.

## Evidence to retain

Record the commit SHA, host and qmd versions, commands used, test summary, and
any intentionally skipped live checks in the release notes or linked issue.
