"""Synthetic regressions for conservative v2 topical postprocessing."""
from __future__ import annotations

import copy
import sys

sys.path.insert(0, "core")
import wiki_topical_selection as selection  # noqa: E402


def card(identifier, *, state="plan", condition="", time="ep002", path="sources/plot.md",
         revision="a" * 64, statement="The gate opens.", extra=False):
    evidence = [{"sourcePath": path, "sourceRevisionSha256": revision,
                 "startLine": 1, "endLine": 1, "quoteAnchor": "The gate opens.",
                 "quoteSha256": "c" * 64}]
    revisions = [{"kind": "file", "path": path, "collection": "sandbox-source",
                  "sha256": revision, "size": 16, "mtimeNs": 1}]
    if extra:
        evidence.append({"sourcePath": "sources/second.md", "sourceRevisionSha256": "d" * 64,
                         "startLine": 2, "endLine": 2, "quoteAnchor": "Another exact source.",
                         "quoteSha256": "e" * 64})
        revisions.append({"kind": "file", "path": "sources/second.md",
                          "collection": "sandbox-source", "sha256": "d" * 64,
                          "size": 22, "mtimeNs": 2})
    claim = {"claimId": "opening", "statement": statement, "state": state,
             "timeScope": time, "condition": condition, "evidence": evidence}
    return {"cardId": identifier, "title": "Gate", "category": "world-rule", "details": "",
            "lead": f"[{state}|{time}] {statement}", "claims": [claim],
            "sourceRevisions": revisions}


def item(rank, body, *, group="gate", block=None, source="plot"):
    return {"rank": rank, "sourceKind": source, "groupId": group, "card": body,
            "block": block if block is not None else "FULL " + body["lead"]}


def choose(rows, **kwargs):
    return selection.select(rows, header="verified pilot", footer="read full source", **kwargs)


def plan_actual():
    rows = [item(1, card("plan")), item(2, card("actual", state="actual"), source="manuscript")]
    result = choose(rows, budget_chars=1000)
    assert [x["cardId"] for x in result["selected"]] == ["plan", "actual"]
    assert result["sameTopicDistinctFacts"][0]["sharedExactClaims"] == 0


def exact_duplicate():
    first = card("first")
    duplicate = copy.deepcopy(first)
    duplicate["cardId"] = "same-facts-new-id"
    result = choose([item(1, first), item(2, duplicate)], budget_chars=1000)
    assert [x["cardId"] for x in result["selected"]] == ["first"]
    assert result["excluded"][0]["reason"] == "exact_duplicate"
    assert result["excluded"][0]["duplicateOfRank"] == 1


def conditions_revisions_multisource():
    variants = [card("condition", condition="only at night"),
                card("time", time="ep003"),
                card("revision", revision="b" * 64),
                card("source", path="sources/manuscript.md"),
                card("multisource", extra=True),
                card("wording", statement="The gate opens slowly.")]
    rows = [item(1, card("base"))] + [item(i + 2, value) for i, value in enumerate(variants)]
    result = choose(rows, budget_chars=10000, top_n=10, top_k=10)
    assert len(result["selected"]) == len(rows)
    assert not result["excluded"]
    assert len({x["exactCardIdentity"] for x in result["selected"]}) == len(rows)


def whole_budget_and_cap():
    rows = [item(1, card("small"), block="small whole"),
            item(2, card("huge", statement="Large body."), block="x" * 300),
            item(3, card("later", statement="Later fact."), block="later whole")]
    result = choose(rows, budget_chars=120, top_n=3)
    assert [x["cardId"] for x in result["selected"]] == ["small", "later"]
    assert result["excluded"][0]["reason"] == "whole_card_over_budget"
    assert "small whole" in result["context"] and "later whole" in result["context"]
    assert "x" * 20 not in result["context"]
    same_after_over = choose([item(1, card("huge"), block="x" * 300),
                              item(2, card("huge-copy"), block="fits")], budget_chars=120)
    assert [x["cardId"] for x in same_after_over["selected"]] == ["huge-copy"]
    capped = choose([item(i, card(f"card-{i}", statement=f"Fact {i}."))
                     for i in range(1, 5)], budget_chars=1000, top_n=3)
    assert [x["reason"] for x in capped["excluded"]] == ["top_n_reached"]
    assert choose([], budget_chars=120)["status"] == "no_candidates"
    too_large = choose([item(1, card("huge"), block="x" * 300)], budget_chars=120)
    assert too_large["status"] == "candidates_present_no_selection"
    assert too_large["excluded"][0]["reason"] == "whole_card_over_budget"


CASES = {"plan_actual": plan_actual,
         "exact_duplicate": exact_duplicate,
         "conditions_revisions_multisource": conditions_revisions_multisource,
         "whole_budget_and_cap": whole_budget_and_cap}

if __name__ == "__main__":
    CASES[sys.argv[1]]()
    print("ok")
