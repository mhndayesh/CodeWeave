#!/usr/bin/env python3
"""Independent ground-truth oracle for real-repo accuracy (OPTIONAL track).

Jedi is a *different* static-analysis engine than pyright, so scoring the compiler against
it is not circular. For a random sample of call sites in the target repo, this resolves the
callee to its definition (file, line) and records the enclosing caller function. Output is a
JSON list consumed by accuracy_oracle.mjs.

Requires: pip install jedi   (Python 3.8+)

Usage:
  python oracle_jedi.py --root <repo> --sample 300 --seed 7 --out oracle.json
"""
import argparse, ast, json, os, random, sys

try:
    import jedi
except ImportError:
    sys.exit("jedi not installed. Run: pip install jedi")


def enclosing_def(tree_lines, lineno):
    """Nearest def/class whose block contains lineno (by indentation walk on the AST)."""
    best = None
    for node in tree_lines:
        if node.lineno <= lineno <= (getattr(node, "end_lineno", node.lineno) or node.lineno):
            if best is None or node.lineno > best.lineno:
                best = node
    return best


def collect(root, sample, seed):
    py_files = []
    for dirpath, dirs, files in os.walk(root):
        dirs[:] = [d for d in dirs if d not in (".git", "node_modules", "__pycache__", "dist", "build")]
        for f in files:
            if f.endswith(".py"):
                py_files.append(os.path.join(dirpath, f))

    # gather candidate call sites (Call with a Name/Attribute func) across files
    sites = []
    for path in py_files:
        try:
            src = open(path, encoding="utf8").read()
            tree = ast.parse(src)
        except Exception:
            continue
        defs = [n for n in ast.walk(tree) if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))]
        for node in ast.walk(tree):
            if isinstance(node, ast.Call):
                func = node.func
                if isinstance(func, ast.Name):
                    name, line, col = func.id, func.lineno, func.col_offset
                elif isinstance(func, ast.Attribute):
                    name, line, col = func.attr, func.value.end_lineno if hasattr(func.value, "end_lineno") else func.lineno, func.end_col_offset - len(func.attr)
                    line = func.lineno
                else:
                    continue
                caller = enclosing_def(defs, node.lineno)
                sites.append({"path": path, "line": line, "col": col, "callee_name": name,
                              "caller_name": caller.name if caller else "<module>",
                              "caller_line": caller.lineno if caller else 1})

    random.Random(seed).shuffle(sites)
    sites = sites[:sample]

    out = []
    for s in sites:
        try:
            script = jedi.Script(path=s["path"])
            defns = script.goto(s["line"], s["col"] + 1, follow_imports=True, follow_builtin_imports=False)
        except Exception:
            defns = []
        for d in defns:
            if not d.module_path:
                continue
            try:
                rel_caller = os.path.relpath(s["path"], root).replace("\\", "/")
                rel_def = os.path.relpath(str(d.module_path), root).replace("\\", "/")
            except Exception:
                continue
            if rel_def.startswith(".."):
                continue  # external (stdlib/site-packages) — out of repo scope
            out.append({
                "caller_file": rel_caller, "caller_name": s["caller_name"], "caller_line": s["caller_line"],
                "callee_name": s["callee_name"], "def_file": rel_def, "def_line": d.line,
            })
            break  # take the primary definition
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", required=True)
    ap.add_argument("--sample", type=int, default=300)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    records = collect(os.path.abspath(a.root), a.sample, a.seed)
    json.dump(records, open(a.out, "w"), indent=2)
    print(f"wrote {len(records)} resolved call->def records to {a.out}", file=sys.stderr)


if __name__ == "__main__":
    main()
