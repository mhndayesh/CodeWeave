#!/usr/bin/env python3
"""Independent RELATION oracle: for a sample of symbol definitions, use Jedi's find-references
(a different engine than pyright) to list every place that uses the symbol, attributed to the
enclosing function/class/module. This is the fair ground truth for a *reference* graph.

Requires: pip install jedi

Usage: python oracle_jedi_refs.py --root <repo> --subdir src --sample 40 --out refs.json
"""
import argparse, ast, json, os, random, sys
try:
    import jedi
except ImportError:
    sys.exit("jedi not installed. Run: pip install jedi")


def enclosing(defs, lineno):
    best = None
    for n in defs:
        end = getattr(n, "end_lineno", n.lineno) or n.lineno
        if n.lineno <= lineno <= end and (best is None or n.lineno > best.lineno):
            best = n
    return best


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", required=True)
    ap.add_argument("--subdir", default="")
    ap.add_argument("--sample", type=int, default=40)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    root = os.path.abspath(a.root)
    project = jedi.Project(root)

    cache = {}
    def load(path):
        if path not in cache:
            try:
                src = open(path, encoding="utf8").read()
                defs = [n for n in ast.walk(ast.parse(src))
                        if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))]
                cache[path] = (src.split("\n"), defs)
            except Exception:
                cache[path] = (None, [])
        return cache[path]

    sample_root = os.path.join(root, a.subdir) if a.subdir else root
    cand = []
    for dp, dirs, files in os.walk(sample_root):
        dirs[:] = [d for d in dirs if d not in (".git", "__pycache__", "tests", "test")]
        for f in files:
            if not f.endswith(".py"):
                continue
            path = os.path.join(dp, f)
            lines, defs = load(path)
            if lines is None:
                continue
            for n in defs:
                if len(n.name) < 4 or (n.name.startswith("__") and n.name.endswith("__")):
                    continue
                line_text = lines[n.lineno - 1] if n.lineno - 1 < len(lines) else ""
                col = line_text.find(n.name, n.col_offset)
                if col < 0:
                    continue
                cand.append({"path": path, "line": n.lineno, "col": col, "name": n.name})

    random.Random(a.seed).shuffle(cand)
    cand = cand[:a.sample]

    out = []
    for c in cand:
        try:
            refs = jedi.Script(path=c["path"], project=project).get_references(
                c["line"], c["col"], include_builtins=False)
        except Exception:
            refs = []
        referrers, seen = [], set()
        for r in refs:
            if not r.module_path:
                continue
            mp = str(r.module_path)
            rel = os.path.relpath(mp, root).replace("\\", "/")
            if rel.startswith(".."):
                continue  # outside the repo (stdlib/site-packages)
            if os.path.abspath(mp) == os.path.abspath(c["path"]) and r.line == c["line"]:
                continue  # the definition itself
            lines, defs = load(mp)
            enc = enclosing(defs, r.line) if defs else None
            name = enc.name if enc else "<module>"
            key = (rel, name)
            if key in seen:
                continue
            seen.add(key)
            referrers.append({"file": rel, "line": r.line, "name": name})
        out.append({"name": c["name"],
                    "def_file": os.path.relpath(c["path"], root).replace("\\", "/"),
                    "def_line": c["line"], "referrers": referrers})
    json.dump(out, open(a.out, "w"), indent=2)
    total = sum(len(s["referrers"]) for s in out)
    print(f"wrote {len(out)} symbols, {total} in-repo referrer edges to {a.out}", file=sys.stderr)


if __name__ == "__main__":
    main()
