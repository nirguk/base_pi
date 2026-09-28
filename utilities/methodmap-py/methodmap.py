#!/usr/bin/env python3
"""Python method map — lists every function/method per file, like methodmap-cs.

Usage: python methodmap.py [rootDir-or-file]

Walks *.py files, parses each with ast, and prints:

    FILE <relative path>
      <line>  <owner>.<name>(<args>)
    TOTAL <n> functions in <m> files under <root>

Skipped folders: __pycache__, .venv, .git, node_modules, obj, bin, publish.
Unparseable files are skipped, never fatal — the TOTAL line always prints
so size-hello's mapCommand (which greps for it) still gets its summary.
"""

import ast
import sys
from pathlib import Path

SKIP_DIRS = {"__pycache__", ".venv", ".git", "node_modules", "obj", "bin", "publish"}


def collect(target: Path) -> tuple[list[Path], Path]:
    if target.is_file():
        return [target], target.parent
    files = sorted(
        p
        for p in target.rglob("*.py")
        if not any(part in SKIP_DIRS for part in p.relative_to(target).parts[:-1])
    )
    return files, target


class Visitor(ast.NodeVisitor):
    def __init__(self) -> None:
        self.stack: list[str] = []
        self.entries: list[tuple[int, str]] = []

    def _describe(self, node: ast.FunctionDef | ast.AsyncFunctionDef) -> str:
        args = ", ".join(a.arg for a in node.args.args)
        if node.args.vararg:
            args += (", " if args else "") + "*" + node.args.vararg.arg
        if node.args.kwarg:
            args += (", " if args else "") + "**" + node.args.kwarg.arg
        kind = "async " if isinstance(node, ast.AsyncFunctionDef) else ""
        owner = self.stack[-1] if self.stack else "global"
        return f"{owner}.{kind}{node.name}({args})"

    def visit_ClassDef(self, node: ast.ClassDef) -> None:
        self.stack.append(node.name)
        self.generic_visit(node)
        self.stack.pop()

    def visit_FunctionDef(self, node: ast.FunctionDef) -> None:
        self.entries.append((node.lineno, self._describe(node)))
        self.stack.append(node.name)
        self.generic_visit(node)  # pick up nested defs
        self.stack.pop()

    def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef) -> None:
        self.entries.append((node.lineno, self._describe(node)))
        self.stack.append(node.name)
        self.generic_visit(node)
        self.stack.pop()


def main(argv: list[str]) -> int:
    target = Path(argv[1] if len(argv) > 1 else ".").resolve()
    if not target.exists():
        print(f"methodmap: no such file or directory: {target}", file=sys.stderr)
        return 1
    files, root = collect(target)
    total = 0
    counted = 0
    for f in files:
        try:
            tree = ast.parse(f.read_text(encoding="utf-8"), filename=str(f))
        except (SyntaxError, UnicodeDecodeError, OSError):
            continue
        visitor = Visitor()
        visitor.visit(tree)
        if not visitor.entries:
            continue
        visitor.entries.sort()
        rel = f.name if f == target else f.relative_to(root)
        print(f"FILE {rel}")
        for lineno, label in visitor.entries:
            print(f"  {lineno:5d}  {label}")
        total += len(visitor.entries)
        counted += 1
    print(f"TOTAL {total} functions in {counted} files under {root}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
