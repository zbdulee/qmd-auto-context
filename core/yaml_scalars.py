#!/usr/bin/env python3
"""frontmatter scalar 인용/역인용 규칙의 SSOT.

`dump`(쓰기)와 `load`(읽기)는 서로의 역함수여야 하고, **동시에 표준 YAML이어야 한다.**

두 번의 실패가 이 모듈의 형태를 정했다:
1. 규칙이 두 벌로 갈려 있던 동안(쓰기는 `"`→`\\"`, 읽기는 `strip('"')`) 읽기가 닫는
   인용부호와 이스케이프된 `"`를 함께 벗겨 백슬래시가 남았다 — service-engineering
   731장 중 8장의 title이 그 상태로 주입됐고 로그에 흔적이 없었다.
2. 규칙을 한 곳으로 모은 뒤에도 `dump`가 `"`만 이스케이프해 **표준 YAML이 아니었다.**
   백슬래시·개행이 그대로 나가 PyYAML로는 21종 중 7종이 ScannerError/오독이었다.
   실해는 title에 그치지 않는다: `wiki_compile.parse_frontmatter`가 같은 카드에서
   fail-closed(`ok=False`)하므로 이후 verify·dedup이 그 카드에서 죽는다.

그래서 `dump`는 YAML 1.2 double-quoted 규칙을 구현한다(PyYAML 대조는 테스트에서 한다 —
런타임 의존성을 blocking hook에 추가하지 않는다).

`load`는 의도적으로 **관용적(lenient)** 이다: 표준이 아닌 이스케이프(`\\p` 등)를 만나면
에러가 아니라 문자 그대로 남긴다. 표준 파서라면 거부할 값이지만, 이 함수는 이미 디스크에
있는 카드를 읽어 recall을 살려야 하는 경로이므로 fail-open이 옳다(hook은 어떤 입력에도
exit 0이어야 한다). 대신 열린 인용부호처럼 **값이 잘렸다고 판단되는 경우는 신호로 알린다**
(`load_with_issue`) — 조용히 잘린 값을 반환하던 것이 위 1번과 같은 클래스다.
"""

from __future__ import annotations
import re

BLOCK_SCALAR_HEADERS = {">", "|", ">-", "|-", ">+", "|+", ">>", "|2", ">2"}

# flow mapping의 키로 허용할 형태. 키도 모델(extractor)이 주므로 개행·구두점이 든 키는
# 매핑을 벗어나 새 줄을 만들 수 있다 — 안전한 식별자만 통과시킨다.
# (wiki_compile.SAFE_YAML_KEY_RE가 이 상수를 그대로 재노출한다: 정의는 한 곳이다.)
SAFE_KEY_RE = re.compile(r"[A-Za-z][A-Za-z0-9_]*")

# YAML 1.2 double-quoted 이스케이프(값 → 표기). 순서 중요: 백슬래시가 먼저다.
_DUMP_ESCAPES = [
    ("\\", "\\\\"),
    ('"', '\\"'),
    ("\n", "\\n"),
    ("\r", "\\r"),
    ("\t", "\\t"),
    ("\x00", "\\0"),
    ("\x07", "\\a"),
    ("\x08", "\\b"),
    ("\x0b", "\\v"),
    ("\x0c", "\\f"),
    ("\x1b", "\\e"),
    ("\x85", "\\N"),
    ("\xa0", "\\_"),
    ("\u2028", "\\L"),
    ("\u2029", "\\P"),
]

# 표기 → 값. `\xNN`/`\uNNNN`/`\UNNNNNNNN`는 별도 처리한다.
_LOAD_SIMPLE = {
    "\\": "\\", '"': '"', "/": "/", "n": "\n", "r": "\r", "t": "\t",
    "0": "\x00", "a": "\x07", "b": "\x08", "v": "\x0b", "f": "\x0c",
    "e": "\x1b", " ": " ", "N": "\x85", "_": "\xa0", "L": "\u2028",
    "P": "\u2029",
}
_LOAD_HEX = {"x": 2, "u": 4, "U": 8}


def _needs_hex(char: str) -> bool:
    code = ord(char)
    return code < 0x20 or code == 0x7F or 0x80 <= code <= 0x9F


def dump(value) -> str:
    """스칼라를 **표준 YAML** double-quoted 표기로 낸다.

    항상 인용하는 이유: 인용 없는 plain scalar는 `: `·`#`·선두 기호 등에서 의미가 바뀌고,
    무엇을 인용해야 하는지 판정하는 규칙이 또 하나의 갈릴 지점이 된다.
    """
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return str(value)
    text = str(value)
    for raw, escaped in _DUMP_ESCAPES:
        text = text.replace(raw, escaped)
    # 위 목록에 없는 C0/C1 제어문자(예: \x01)는 raw로 나가면 표준 파서가 거부한다.
    text = "".join(
        char if not _needs_hex(char) else "\\x%02x" % ord(char)
        for char in text
    )
    return f'"{text}"'


def is_block_scalar_header(raw: str) -> bool:
    """`key: >` / `key: |` 처럼 값이 이어지는 줄들에 있는 경우."""
    return raw.strip() in BLOCK_SCALAR_HEADERS


def _ends_with_escaped_quote(text: str, quote: str) -> bool:
    """마지막 인용부호가 실은 이스케이프된 문자라 값이 닫히지 않은 경우.

    `"...\\"` — 끝의 `"`는 `\\"`의 일부이므로 값이 열린 채다. 홀수 개의 연속 백슬래시가
    앞서면 이스케이프된 것이다(짝수면 `\\\\` 리터럴 뒤의 진짜 닫는 인용부호).
    """
    if quote != '"' or len(text) < 3:
        return False
    backslashes = 0
    index = len(text) - 2
    while index >= 1 and text[index] == "\\":
        backslashes += 1
        index -= 1
    return backslashes % 2 == 1


def _unescape_double(body: str) -> str:
    out = []
    index = 0
    length = len(body)
    while index < length:
        char = body[index]
        if char != "\\" or index + 1 >= length:
            out.append(char)
            index += 1
            continue
        marker = body[index + 1]
        if marker in _LOAD_SIMPLE:
            out.append(_LOAD_SIMPLE[marker])
            index += 2
            continue
        if marker in _LOAD_HEX:
            width = _LOAD_HEX[marker]
            digits = body[index + 2:index + 2 + width]
            if len(digits) == width:
                try:
                    out.append(chr(int(digits, 16)))
                    index += 2 + width
                    continue
                except ValueError:
                    pass
        # 표준이 아닌 이스케이프: 에러 대신 문자 그대로 남긴다(fail-open — 이미 디스크에
        # 있는 카드를 읽는 경로다. 예전 dump가 백슬래시를 이스케이프하지 않았으므로
        # `C:\\path` 같은 값이 그대로 들어 있을 수 있고, 그 title을 계속 읽어야 한다).
        out.append(char)
        index += 1
    return "".join(out)


def load_with_issue(raw: str) -> tuple[str, str]:
    """(값, 문제) — 문제 없으면 빈 문자열.

    문제 값: `unbalanced_quote`(인용부호가 열린 채 줄이 끝났다 = 값이 잘렸다).
    쓰기가 개행을 이스케이프하지 않던 시절 멀티라인 title이 실제 개행으로 디스크에
    나가, 첫 줄만 읽으면 `"멀티` 처럼 열린 인용부호로 끝났다 — 예전엔 그 문자열을
    조용히 값으로 반환했다(앞 인용부호까지 붙은 채).
    """
    text = raw.strip()
    if not text:
        return "", ""
    quote = text[0]
    if quote not in ("'", '"'):
        # plain scalar. YAML은 plain scalar에 이스케이프를 두지 않으므로 그대로 쓴다.
        return text, ""
    if len(text) < 2 or text[-1] != quote or _ends_with_escaped_quote(text, quote):
        return text[1:], "unbalanced_quote"
    body = text[1:-1]
    if quote == "'":
        # single-quoted YAML: 백슬래시 이스케이프가 없고 `''`만 리터럴 `'`다.
        return body.replace("''", "'"), ""
    return _unescape_double(body), ""


def load(raw: str) -> str:
    """frontmatter 표기를 원래 문자열로 되돌린다(`dump`의 역함수)."""
    return load_with_issue(raw)[0]


def dump_flow_mapping(mapping) -> str:
    """`{k: "v", ...}` flow mapping 표기를 낸다. 안전한 키가 하나도 없으면 빈 문자열.

    `sources:` 항목이 이 표기다(`- {kind: "raw", path: "docs/a.md"}`). **읽는 쪽
    (`load_flow_mapping`)과 쌍으로 여기 둔다** — 이 저장소는 emit/parse가 갈려 두 번
    깨졌다(title 이스케이프 규칙 8/731장 오염, `qmd:auto` 마커 정규식). 값은 전부 `dump`를
    거치므로 `,`·`}`·개행·인용부호가 들어도 표기를 벗어나지 못하고, 키는 SAFE_KEY_RE
    화이트리스트다.
    """
    parts = []
    for key, value in mapping.items():
        if not isinstance(key, str) or not SAFE_KEY_RE.fullmatch(key):
            continue
        parts.append(f"{key}: {dump(value)}")
    return "{" + ", ".join(parts) + "}" if parts else ""


def _split_flow_items(inner: str) -> list[str] | None:
    """flow mapping 내부를 인용부호 밖의 `,`로만 나눈다. 인용부호가 열린 채 끝나면 None.

    값이 `,`를 담을 수 있으므로(`dump`가 인용하므로 표기상 안전하다) 단순 `split(",")`은
    값을 반으로 자른다 — 그러면 경로가 조용히 다른 문자열이 된다.
    """
    items: list[str] = []
    buf: list[str] = []
    quote = ""
    index = 0
    length = len(inner)
    while index < length:
        char = inner[index]
        if quote:
            buf.append(char)
            if quote == '"' and char == "\\" and index + 1 < length:
                buf.append(inner[index + 1])
                index += 2
                continue
            if char == quote:
                quote = ""
            index += 1
            continue
        if char in ('"', "'"):
            quote = char
            buf.append(char)
            index += 1
            continue
        if char == ",":
            items.append("".join(buf))
            buf = []
            index += 1
            continue
        buf.append(char)
        index += 1
    if quote:
        return None
    items.append("".join(buf))
    return items


def load_flow_mapping(raw: str) -> tuple[dict, str]:
    """`{k: "v", ...}` → (dict, 문제). `dump_flow_mapping`의 역함수.

    문제 값: `not_flow_mapping`(중괄호로 감싸이지 않음) / `unbalanced_quote`(값이 잘렸다)
    / `empty`(키가 하나도 없음). fail-open이 원칙이라 파싱한 키는 문제와 함께 그대로
    돌려준다 — 읽기 경로(recall)는 한 항목이 이상해도 나머지를 살려야 한다.
    중복 키는 first-wins다(`parse_frontmatter_scalars`와 같은 규약).
    """
    text = raw.strip()
    if not (text.startswith("{") and text.endswith("}")) or len(text) < 2:
        return {}, "not_flow_mapping"
    items = _split_flow_items(text[1:-1])
    if items is None:
        return {}, "unbalanced_quote"
    fields: dict[str, str] = {}
    issue = ""
    for item in items:
        if not item.strip():
            continue
        key, sep, value = item.partition(":")
        key = key.strip()
        if not sep or not SAFE_KEY_RE.fullmatch(key) or key in fields:
            continue
        parsed, value_issue = load_with_issue(value)
        if value_issue:
            issue = issue or value_issue
            continue
        fields[key] = parsed
    if not fields and not issue:
        issue = "empty"
    return fields, issue


def fold_inline(value) -> str:
    """한 줄 스칼라로 쓸 값에서 개행·탭을 공백으로 접는다(쓰기 경로).

    title 같은 한 줄 라벨은 개행을 담을 이유가 없다. `dump`가 `\\n`으로 이스케이프해도
    표준 YAML이지만, 값 자체가 여러 줄이면 recall 주입에서 `sanitize_inline`이 다시 접게
    되고 카드 이름으로도 부적절하다 — **소스에서 접는다**. dump의 이스케이프는 그래도
    남겨 둔다(다른 필드·미래 입력에 대한 안전망).
    """
    return " ".join(str(value).split())
