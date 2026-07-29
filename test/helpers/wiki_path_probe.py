#!/usr/bin/env python3
"""resolve_wiki_result_path / read_wiki_meta 를 함수 단위로 호출해 결과를 JSON으로 낸다.

hook 전체를 돌리면 keyword 추출·필터·topN 이 섞여 "경로 해석이 실패했는지"를 단정할 수
없다(실패 시 기본값 generated/미검수로 조용히 degrade 하므로 겉보기 출력이 성공 케이스와
구분되지 않는다 — 이 공백이 plain-path 회귀를 라이브까지 통과시켰다).

Usage: wiki_path_probe.py <project_dir> '<file uri>' ['<_collection>']
Output: {"resolved": <절대경로 or null>, "meta": {"status":..., "reviewed":...}}
"""
import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2] / "core"))
import config as qmd_config  # noqa: E402
import recall as R  # noqa: E402


def main() -> int:
    project_dir = sys.argv[1]
    uri = sys.argv[2]
    result = {"file": uri}
    if len(sys.argv) > 3 and sys.argv[3]:
        result["_collection"] = sys.argv[3]
    cfg = qmd_config.load_project_config(project_dir)
    resolved = R.resolve_wiki_result_path(result, cfg, project_dir)
    print(json.dumps({
        "resolved": str(resolved) if resolved else None,
        "meta": R.read_wiki_meta(result, cfg, project_dir),
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
