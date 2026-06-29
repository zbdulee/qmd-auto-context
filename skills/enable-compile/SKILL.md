---
name: enable-compile
description: Use when the user wants to turn on automatic wiki compilation for a project — e.g. "wiki 자동화 켜줘", "auto wiki compile 켜줘", "enable wiki auto-compile". Wires compile.extractor (host adapters) into .auto-context/settings.json and discloses that edits will run the host CLI in the background. Requires the project to be opted in first.
---

# Enable Compile

Turn on wiki auto-compile for the current project in one step.

## Workflow

1. Confirm the target cwd and that it is opted in (`.auto-context/settings.json` with `indexing:true`). If not, run `--optin --recommended` first.
2. Resolve the plugin root:
   ```bash
   ROOT="${CLAUDE_PLUGIN_ROOT:-${PLUGIN_ROOT:-$(git rev-parse --show-toplevel)}}"
   ```
3. Run the wrapper (optionally pass `--engines claude,codex`):
   ```bash
   bash "$ROOT/skills/enable-compile/scripts/enable-compile.sh" "$PWD"
   ```
4. Relay the disclosure the command prints (which engines, that edits run the CLI in the background, how to disable).

## Safety

- This enables background host-CLI execution on raw/session `.md` edits. Surface the disclosure to the user — do not enable silently.
- Do not bypass opt-in: the command refuses non-opted-in projects.
