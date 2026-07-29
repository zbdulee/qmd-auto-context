#!/usr/bin/env python3
"""frontmatter scalar 인용/역인용 규칙의 SSOT.

`dump`(쓰기)와 `load`(읽기)는 **반드시 서로의 역함수**여야 한다. 이 저장소에서
frontmatter 파서가 여러 벌로 늘어난 결과, 쓰기(`wiki_compile.yaml_scalar`)는 `"`를
`\\"`로 이스케이프하는데 recall의 읽기 파서는 되돌리지 않았고 `strip('"')`이 닫는
인용부호와 이스케이프된 `"`를 함께 벗겨 백슬래시가 남았다 — service-engineering
731장 중 8장(1.1%)의 title이 그 상태로 주입됐고 로그에는 흔적이 없었다.

`load`는 **block scalar 헤더**(`>`, `|`, `>-` …)를 값으로 오인하지 않는다. 값이 다음
줄들에 들여쓰여 있으므로 top-level 스칼라만 읽는 호출자는 그 값을 볼 수 없고, 예전
구현은 title을 문자 `>` 하나로 주입했다.
"""

BLOCK_SCALAR_HEADERS = {">", "|", ">-", "|-", ">+", "|+", ">>", "|2", ">2"}


def dump(value) -> str:
    """스칼라를 frontmatter 표기로 낸다(항상 double-quoted)."""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return str(value)
    text = str(value).replace('"', '\\"')
    return f'"{text}"'


def is_block_scalar_header(raw: str) -> bool:
    """`key: >` / `key: |` 처럼 값이 이어지는 줄들에 있는 경우."""
    return raw.strip() in BLOCK_SCALAR_HEADERS


def load(raw: str) -> str:
    """frontmatter 표기를 원래 문자열로 되돌린다(`dump`의 역함수).

    양끝의 같은 인용부호 **한 쌍만** 벗기고 그 뒤에 `\\"` → `"`를 되돌린다.
    `strip('"')`처럼 반복 제거하면 이스케이프된 인용부호까지 먹는다.
    """
    text = raw.strip()
    if len(text) >= 2 and text[0] == text[-1] and text[0] in ("'", '"'):
        text = text[1:-1]
    return text.replace('\\"', '"')
