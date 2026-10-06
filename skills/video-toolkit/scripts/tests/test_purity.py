"""vtlib must stay free of I/O.

This is the invariant that makes the rest of the suite possible without a
network, ffmpeg or a media file — and the one that will let the signals and
candidates stages run inside a Cloudflare Worker, where the cache is R2 and
there is no local filesystem to reach for.

It is easy to violate by accident (one `Path.read_text` for convenience), and
the damage only shows up much later, so it is asserted rather than documented.
"""

import ast
import sys
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent.parent
VTLIB = SCRIPTS / "vtlib"
sys.path.insert(0, str(SCRIPTS))

# Modules that reach outside the process. `pathlib` is allowed for type hints
# only, and is not imported by any current vtlib module.
FORBIDDEN_IMPORTS = {
    "subprocess", "shutil", "socket", "urllib", "requests", "http",
    "os", "pathlib", "tempfile", "sqlite3",
}
FORBIDDEN_CALLS = {"open", "print", "exit", "input"}


def vtlib_sources():
    return sorted(p for p in VTLIB.glob("*.py"))


class TestVtlibPurity(unittest.TestCase):
    def test_there_are_modules_to_check(self):
        self.assertTrue(vtlib_sources(), "vtlib/ has no modules")

    def test_no_io_imports(self):
        for path in vtlib_sources():
            tree = ast.parse(path.read_text(encoding="utf-8"))
            for node in ast.walk(tree):
                names = []
                if isinstance(node, ast.Import):
                    names = [a.name.split(".")[0] for a in node.names]
                elif isinstance(node, ast.ImportFrom) and node.level == 0:
                    names = [(node.module or "").split(".")[0]]
                for name in names:
                    self.assertNotIn(
                        name, FORBIDDEN_IMPORTS,
                        f"{path.name} imports {name!r} — vtlib must stay pure. "
                        f"Move the I/O into vt.py and pass the data in.")

    def test_no_builtin_io_calls(self):
        for path in vtlib_sources():
            tree = ast.parse(path.read_text(encoding="utf-8"))
            for node in ast.walk(tree):
                if isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
                    self.assertNotIn(
                        node.func.id, FORBIDDEN_CALLS,
                        f"{path.name} calls {node.func.id}() at line "
                        f"{node.lineno} — vtlib must stay pure.")

    def test_modules_import_with_stdlib_only(self):
        """CI runs a stock python3.12 with no pip installs."""
        for path in vtlib_sources():
            if path.name == "__init__.py":
                continue
            __import__(f"vtlib.{path.stem}")


class TestNoSysExit(unittest.TestCase):
    """Stages raise VtError; only main() decides the process's fate. A
    sys.exit() three levels down cannot run inside a request handler."""

    def test_vt_py_exits_only_from_main(self):
        src = (SCRIPTS / "vt.py").read_text(encoding="utf-8")
        tree = ast.parse(src)
        offenders = []
        for fn in [n for n in ast.walk(tree)
                   if isinstance(n, ast.FunctionDef) and n.name != "main"]:
            for node in ast.walk(fn):
                if (isinstance(node, ast.Call)
                        and isinstance(node.func, ast.Attribute)
                        and node.func.attr == "exit"):
                    offenders.append(f"{fn.name}:{node.lineno}")
        self.assertEqual(offenders, [],
                         f"sys.exit outside main(): {offenders}")


if __name__ == "__main__":
    unittest.main()
