"""Opt-in Codex exec descriptor and event guard; never launches a provider.

Reduces optional context; does not attest an empty builtin tool catalog.
Mandatory instructions, policy hooks and normal authentication remain intact.
"""

MODEL = 'gpt-6-luna'
EFFORT = 'low'
MAX_RESPONSE_BYTES = 32768

import re


def argv(*, model=MODEL):
    if not isinstance(model, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,79}', model):
        raise ValueError('invalid_model')
    overrides = (
        'model_reasoning_effort="low"', 'approval_policy="never"',
        'project_doc_max_bytes=0', 'web_search="disabled"',
        'features.plugins=false', 'features.shell_tool=false',
        'features.multi_agent=false', 'features.multi_agent_v2=false',
        'features.view_image=false', 'features.skip_host_skill_discovery=true',
        'features.memories=false', 'features.goals=false',
        'model_provider="openai"', 'suppress_unstable_features_warning=true',
        # Suppress the available-skills prompt block, not mandatory policy.
        # Skills may still exist and an explicit invocation may load one.
        'skills.include_instructions=false',
    )
    result = ['codex', 'exec', '--ignore-user-config', '--ignore-rules',
              '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only',
              '--json', '--color', 'never', '--model', model]
    for override in overrides:
        result.extend(('-c', override))
    return result + ['-']


def child_environment(parent):
    # Do not inherit Orca transport, IDE state, credentials or debug logging vars.
    # HOME/CODEX_HOME point to existing authentication; never move/copy it.
    result = {key: parent[key] for key in
              ('HOME', 'PATH', 'TMPDIR', 'LANG', 'USER', 'LOGNAME', 'CODEX_HOME')
              if key in parent}
    result['QMD_SANDBOX'] = '1'
    return result


def inspect_event(event):
    if not isinstance(event, dict):
        raise ValueError('invalid_event')
    kind = event.get('type')
    if kind not in {'thread.started', 'turn.started', 'turn.completed',
                    'item.started', 'item.updated', 'item.completed',
                    'turn.failed', 'error'}:
        raise ValueError('unexpected_event')
    if kind in {'turn.failed', 'error'}:
        raise ValueError('provider_error')
    result = {'event_type': kind}
    if kind.startswith('item.'):
        item = event.get('item')
        if not isinstance(item, dict):
            raise ValueError('invalid_item')
        item_type = item.get('type')
        if item_type == 'error':
            # Do not expose raw provider errors, paths or arbitrary user content.
            raise ValueError('provider_error_item')
        if item_type not in {'agent_message', 'reasoning'}:
            raise ValueError('unexpected_action_item')
        result['item_type'] = item_type
        if kind == 'item.completed' and item_type == 'agent_message':
            text = item.get('text')
            if not isinstance(text, str) or len(text.encode()) > MAX_RESPONSE_BYTES:
                raise ValueError('response_budget')
            result['response'] = text
    if kind == 'turn.completed':
        usage = event.get('usage')
        if not isinstance(usage, dict):
            raise ValueError('missing_usage')
        allowed = {'input_tokens', 'cached_input_tokens', 'cache_write_input_tokens',
                   'output_tokens', 'reasoning_output_tokens'}
        result['usage'] = {k: v for k, v in usage.items()
                           if k in allowed and type(v) is int and v >= 0}
    # exec JSON currently does not report resolved model/effort or full catalogs.
    return result
