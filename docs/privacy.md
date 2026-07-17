# Data Handling and Privacy

## Default local processing

qmd auto-context is inactive until a project is opted in. For an opted-in
project, configured collection paths are indexed by the local qmd CLI and the
default qmd daemon at `localhost`. Recall queries are sent to that daemon.

The plugin does not provide a separate telemetry service. If you override the
qmd daemon URL or configure collection paths outside the project, those choices
change the data boundary and are your responsibility to review.

## Optional wiki compile

Optional wiki compile runs only when it is enabled in the project settings. It
passes selected Markdown source content and limited wiki orientation context to
the configured host CLI to produce or verify wiki candidates. Depending on the
configured host CLI and its account settings, that CLI may send the content to
its provider. Review the host provider's privacy policy before enabling this
feature for sensitive material.

The built-in adapters run in an isolated temporary working directory with their
tools disabled. This limits filesystem access by the nested host CLI, but it
does not change the host provider's data policy.

## Controls

- Keep a project inactive by declining auto-context or removing its configured
  collections.
- Ask the agent to disable wiki compile for a project before editing sensitive
  raw or session Markdown.
- Use only collection paths and qmd daemon endpoints that you trust.
- Do not include credentials, private keys, or secrets in issue reports, logs,
  or generated wiki content.

This document describes qmd auto-context. Each host CLI and qmd have their own
terms, retention, and privacy controls.
