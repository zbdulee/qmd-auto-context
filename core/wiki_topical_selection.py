#!/usr/bin/env python3
"""Pure, isolated postprocessing of already verified topical search candidates.

The caller must validate backend attestations and source/card freshness first. This
module neither queries QMD nor infers semantic equivalence. Topic labels are
diagnostic only; only byte-exact fact-and-provenance copies are deduplicated.
"""
from __future__ import annotations

import hashlib
import json

STATES = frozenset({"plan", "actual", "observation", "unknown", "rule"})


def _stable(value) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def claim_identity(claim: dict) -> str:
    """Exact claim, time, condition, state, and every cited source revision/span."""
    if (not isinstance(claim, dict) or set(claim) !=
            {"claimId", "statement", "state", "timeScope", "condition", "evidence"}
            or claim["state"] not in STATES or not isinstance(claim["evidence"], list)
            or not claim["evidence"]):
        raise ValueError("invalid_verified_claim")
    evidence = []
    required = {"sourcePath", "sourceRevisionSha256", "startLine", "endLine",
                "quoteAnchor", "quoteSha256"}
    for span in claim["evidence"]:
        if not isinstance(span, dict) or set(span) != required:
            raise ValueError("invalid_verified_span")
        evidence.append({key: span[key] for key in sorted(required)})
    payload = {key: claim[key] for key in ("claimId", "statement", "state", "timeScope", "condition")}
    payload["evidence"] = sorted(evidence, key=_stable)
    return hashlib.sha256(_stable(payload).encode("utf-8")).hexdigest()


def exact_card_identity(card: dict) -> str:
    """Never equate different states, conditions, source revisions, or added facts."""
    required = {"cardId", "title", "category", "details", "lead", "claims", "sourceRevisions"}
    if (not isinstance(card, dict) or not required <= set(card)
            or not isinstance(card["claims"], list) or not card["claims"]
            or not isinstance(card["sourceRevisions"], list)):
        raise ValueError("invalid_verified_card")
    payload = {"title": card["title"], "category": card["category"],
               "details": card["details"], "lead": card["lead"],
               "claims": sorted(claim_identity(claim) for claim in card["claims"]),
               "sourceRevisions": sorted(card["sourceRevisions"], key=_stable)}
    return hashlib.sha256(_stable(payload).encode("utf-8")).hexdigest()


def select(candidates: list[dict], *, header: str, footer: str,
           budget_chars: int = 2400, top_n: int = 3, top_k: int = 8) -> dict:
    """Keep ranked whole cards, skip exact copies, and explain every exclusion.

    A candidate has rank, sourceKind, groupId, card, and a complete rendered block.
    Group labels never cause suppression. No cards or facts are synthesized.
    """
    if (not isinstance(candidates, list) or not isinstance(header, str) or not header
            or not isinstance(footer, str) or not footer
            or type(budget_chars) is not int or budget_chars < 1
            or type(top_n) is not int or top_n < 1
            or type(top_k) is not int or top_k < 1):
        raise ValueError("invalid_selection_input")
    base = header + "\n" + footer
    if len(base) > budget_chars:
        raise ValueError("fixed_overhead_exceeds_budget")
    blocks, selected, excluded = [], [], []
    seen: dict[str, dict] = {}
    topical_complements = []
    processed = []
    for index, candidate in enumerate(candidates):
        if (not isinstance(candidate, dict) or not {"rank", "sourceKind", "groupId", "card", "block"} <= set(candidate)
                or type(candidate["rank"]) is not int or candidate["rank"] < 1
                or not isinstance(candidate["sourceKind"], str)
                or not isinstance(candidate["groupId"], str)
                or not isinstance(candidate["block"], str) or not candidate["block"]):
            raise ValueError("invalid_selection_candidate")
        card = candidate["card"]
        identity = exact_card_identity(card)
        claim_keys = set(claim_identity(claim) for claim in card["claims"])
        row = {"rank": candidate["rank"], "sourceKind": candidate["sourceKind"],
               "groupId": candidate["groupId"], "cardId": card["cardId"],
               "exactCardIdentity": identity,
               "claimCount": len(card["claims"]),
               "leadChars": len(card["lead"]),
               "states": sorted({claim["state"] for claim in card["claims"]})}
        if len(card["lead"]) > 600:
            raise ValueError("lead_over_600")
        for earlier in processed:
            if earlier["groupId"] == row["groupId"] and earlier["exactCardIdentity"] != identity:
                topical_complements.append({"earlierRank": earlier["rank"],
                                            "laterRank": row["rank"], "groupId": row["groupId"],
                                            "sharedExactClaims": len(earlier["claimKeys"] & claim_keys),
                                            "earlierSourceKind": earlier["sourceKind"],
                                            "laterSourceKind": row["sourceKind"]})
        processed.append({**row, "claimKeys": claim_keys})
        if index >= top_k:
            excluded.append({**row, "reason": "outside_top_k"})
            continue
        if identity in seen:
            excluded.append({**row, "reason": "exact_duplicate",
                             "duplicateOfRank": seen[identity]["rank"]})
            continue
        if len(selected) >= top_n:
            excluded.append({**row, "reason": "top_n_reached"})
            continue
        proposed = header + "\n" + "\n".join(blocks + [candidate["block"]]) + "\n" + footer
        if len(proposed) > budget_chars:
            excluded.append({**row, "reason": "whole_card_over_budget",
                             "blockChars": len(candidate["block"])})
            continue
        blocks.append(candidate["block"])
        selected.append(row)
        seen[identity] = row
    context = header + ("\n" + "\n".join(blocks) if blocks else "") + "\n" + footer
    assert len(context) <= budget_chars
    status = "selected" if selected else ("candidates_present_no_selection" if candidates else "no_candidates")
    return {"status": status, "budgetChars": budget_chars, "usedChars": len(context),
            "topN": top_n, "topK": top_k, "selected": selected, "excluded": excluded,
            "sameTopicDistinctFacts": topical_complements, "context": context}
