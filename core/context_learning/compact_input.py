"""Exact local compact-wiki body contract; frontmatter is provenance, not input.

This is for an already eligible local wiki card. It never truncates body text.
Oversize or malformed cards remain captured as bounded teacher excerpts but
are ineligible for local model training.
"""
from .contracts import digest
import yaml_scalars

MAX_SOURCE_BYTES = 65536
MAX_COMPACT_BODY_BYTES = 16384


def derive(source_text, source_sha256):
    if not isinstance(source_text, str): raise ValueError('invalid_compact_source')
    encoded = source_text.encode('utf-8')
    if len(encoded) > MAX_SOURCE_BYTES or digest(source_text) != source_sha256:
        raise ValueError('compact_source_mismatch_or_limit')
    match = yaml_scalars.FRONTMATTER_RE.match(source_text)
    if match is None: raise ValueError('missing_compact_frontmatter')
    body = source_text[match.end():]
    if not body.strip() or '\x00' in body or len(body.encode('utf-8')) > MAX_COMPACT_BODY_BYTES:
        raise ValueError('compact_body_limit_or_empty')
    return {'input_kind': 'full_compact_wiki_body', 'source_sha256': source_sha256,
            'source_bytes': len(encoded), 'body_sha256': digest(body),
            'body_text': body, 'truncated': False}
