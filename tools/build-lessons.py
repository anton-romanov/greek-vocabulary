#!/usr/bin/env python3
"""Builds lessons.js (course vocabulary lessons) from the offline GreekBy copy in ~/greekby."""
import json, os, re, unicodedata
SRC = os.path.expanduser("~/greekby/content")
d = json.load(open(f"{SRC}/greekby-content-export.json"))
words = json.load(open(f"{SRC}/lexical_words.json"))
import html
CYR = re.compile("[а-яё]", re.I)
def clean(t):
    t = html.unescape(re.sub(r"<[^>]+>", " ", t or ""))
    return unicodedata.normalize("NFC", re.sub(r"\s+", " ", t).strip())
def key(t):
    t = "".join(c for c in unicodedata.normalize("NFD", t.lower()) if not unicodedata.combining(c))
    return re.sub(r"^(ο|η|το|οι|τα)\s+", "", t.strip())
place = {}
for ci, st in enumerate(sorted(d["structure"], key=lambda s: s["group"]["title"])):
    course = re.sub(r"^Курс\s*В1\s*-\s*", "", st["group"]["title"]).strip()
    sections = {s["id"]: s for s in st["sections"]["data"]}
    for l in st["lessons"]["data"]:
        sec = sections.get(l["section_id"], {})
        place.setdefault(str(l["id"]), (ci, course, sec.get("order", 0), l["section_id"] or 0,
                                         (sec.get("name") or sec.get("title") or "").strip(), l.get("order") or 0))
out = []
for lid, items in words.items():
    if lid not in place: continue
    ci, course, so, sid, section, lo = place[lid]
    name = d["lessons"].get(lid, {}).get("name", "").strip()
    pairs = []
    for w in items:
        gr = clean(w.get("t"))
        ru = clean(w.get("tr"))
        if gr and ru and [gr, ru] not in pairs: pairs.append([gr, ru])
    if pairs: out.append(((ci, so, sid, lo, name), {"id": lid, "c": course, "s": section, "n": name, "w": pairs}))
# Verb lessons give a form with its dictionary form instead of a translation ("θα πάω" — "πηγαίνω").
# Such entries become [form, meaning of the dictionary form, dictionary form]; the meaning is
# looked up in the other lessons, or left empty for the app to find in the user's own words.
meaning = {}
for _, l in out:
    for gr, ru in l["w"]:
        if CYR.search(ru): meaning.setdefault(key(gr), ru)
for _, l in out:
    l["w"] = [[gr, ru] if CYR.search(ru) else [gr, meaning.get(key(ru), ""), ru] for gr, ru in l["w"]]
out.sort(key=lambda x: x[0])
data = [x[1] for x in out]
with open(os.path.join(os.path.dirname(__file__), "..", "lessons.js"), "w") as f:
    f.write("// Vocabulary of the GreekBy B1 course lessons. Built by tools/build-lessons.py.\n")
    f.write("const COURSE_LESSONS = " + json.dumps(data, ensure_ascii=False, separators=(",", ":")) + ";\n")
print(len(data), "lessons,", sum(len(x["w"]) for x in data), "words")
