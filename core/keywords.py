#!/usr/bin/env python3
import sys
import re
import json
import argparse

KO_STOPWORDS = {
    "해줘", "해주세요", "해봐", "알려줘", "보여줘", "찾아줘",
    "있나", "있어", "뭐야", "어때", "인가", "인지",
    "그거", "이거", "저거", "여기", "거기",
    "좀", "것", "수", "등", "및", "또는", "그리고",
    "어떻게", "어디서", "언제", "왜", "뭘", "무엇을",
    "하나요", "할까요", "하지", "할까", "하면", "하려면",
    "나는데", "있는데", "되는데", "하는데", "인데", "건데",
    "그런데", "그래서", "그러면", "그러니", "그러나",
    "때문에", "대해서", "관해서", "대한", "위해", "통해", "따라",
}

EN_STOPWORDS = {
    "the", "a", "an", "is", "are", "was", "were",
    "how", "what", "where", "when", "why", "which",
    "do", "does", "did", "can", "could", "should",
    "please", "help", "me", "about", "this", "that",
    "it", "in", "on", "to", "for", "with", "from",
    "has", "have", "been", "be", "will", "would", "not", "no",
}

def strip_ko_suffix(token: str) -> str:
    for suffix in (
        "해주세요", "해줘", "해봐",
        "하려면", "하나요", "할까요", "하지", "할까", "하면",
        "는데", "인데",
        "에서", "으로", "에게", "처럼", "부터", "까지", "에는",
        "을", "를", "으", "로", "와", "과", "의", "은", "는", "이", "가",
    ):
        if token.endswith(suffix) and len(token) > len(suffix) + 1:
            return token[: -len(suffix)]
    return token

def extract_keywords(text: str) -> list[str]:
    # Remove markdown titles and links
    text = re.sub(r"^#{1,6}\s+", " ", text, flags=re.MULTILINE)
    text = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", text)
    text = re.sub(r"[`*_~>|]", " ", text)

    tokens = re.findall(r"[a-zA-Z0-9가-힣_-]{2,}", text)
    keywords: list[str] = []
    seen: set[str] = set()
    for token in tokens:
        if token.lower() in EN_STOPWORDS or token in KO_STOPWORDS:
            continue
        stemmed = strip_ko_suffix(token)
        key = stemmed.lower()
        if len(stemmed) < 2 or key in seen:
            continue
        seen.add(key)
        keywords.append(stemmed)
        if len(keywords) >= 5: # Limit increased to 5 for general configuration
            break
    return keywords

def extract_ep_terms(prompt: str) -> list[str]:
    terms: list[str] = []
    for match in re.finditer(r"\bEP\s*0*(\d{1,3})\b|\b0*(\d{1,3})\s*화", prompt, re.IGNORECASE):
        ep_num = match.group(1) or match.group(2)
        if ep_num:
            normalized = int(ep_num)
            terms.extend([f"EP{normalized:03d}", f"{normalized:03d}", f"EP{normalized}"])
    return list(dict.fromkeys(terms))

def main():
    parser = argparse.ArgumentParser(description="Extract keywords and lexical terms.")
    parser.add_argument("--patterns", default="")
    args = parser.parse_args()

    patterns = [p.strip() for p in args.patterns.split(",") if p.strip()]

    prompt = sys.stdin.read().strip()
    
    keywords = extract_keywords(prompt)
    
    lexical_terms = []
    if "ep" in patterns:
        lexical_terms.extend(extract_ep_terms(prompt))
        lexical_terms.extend(keywords)
    else:
        # If ep is not active, filter out any EP-like words (e.g., EP12, EP012) that might have been extracted as keywords
        lexical_terms.extend([k for k in keywords if not re.match(r"^EP\d+$", k, re.IGNORECASE)])
    
    # Deduplicate while preserving order
    seen = set()
    deduped_lexical_terms = []
    for term in lexical_terms:
        if term not in seen:
            seen.add(term)
            deduped_lexical_terms.append(term)

    result = {
        "keywords": keywords,
        "lexicalTerms": deduped_lexical_terms
    }
    
    print(json.dumps(result, ensure_ascii=False))

if __name__ == "__main__":
    main()
