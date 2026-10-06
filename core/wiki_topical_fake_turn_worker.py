#!/usr/bin/env python3
"""One-shot synthetic batch + optional local QMD embed; safe to rerun."""
from __future__ import annotations

import argparse
import json

import wiki_topical_fake_pipeline as fake
import wiki_topical_fake_qmd as qmd


def run(root):
    generation = fake.drain(root)
    embedding = qmd.sync_qmd(root)
    return {"generation": generation, "embedding": embedding}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True)
    args = parser.parse_args()
    print(json.dumps(run(args.root), ensure_ascii=False, sort_keys=True))
