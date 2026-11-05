"""Counter v3 regression: product roots and runtime files cannot disappear."""
import contextlib
import importlib.util
import io
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / "scripts/count-sloc.py"
SPEC = importlib.util.spec_from_file_location("sloc_counter", SCRIPT)
COUNTER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(COUNTER)


class SlocCounterTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="nomo-sloc-test-")
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        for name in COUNTER.PRODUCT_ROOTS + COUNTER.OTHER_ROOTS:
            (self.root / name).mkdir(parents=True)
        for name in COUNTER.RUNTIME_FILES:
            self.write(name, "")

    def write(self, relative, text="code;\n"):
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)

    def test_moved_storage_contributes_to_canonical_product(self):
        self.write("src/nomo/main.es", "// note\ncode;\n\n")
        self.write("src/nomo/store.es", "first;\nsecond;\n")
        self.write("tests/fixture.py", "fixture()\n")
        counts = COUNTER.inventory(self.root)
        self.assertEqual(counts["src"], (3, 5, 2))
        self.assertEqual(counts["runtime"], (0, 0, len(COUNTER.RUNTIME_FILES)))
        self.assertEqual(counts["product"], (3, 5, 2 + len(COUNTER.RUNTIME_FILES)))
        self.assertEqual(counts["tests"], (1, 1, 1))

    def test_missing_product_root_refused(self):
        for name in COUNTER.PRODUCT_ROOTS:
            with self.subTest(name=name):
                (self.root / name).rmdir()
                with self.assertRaisesRegex(ValueError, name):
                    COUNTER.inventory(self.root)
                (self.root / name).mkdir()

    def test_missing_other_category_refused(self):
        for name in COUNTER.OTHER_ROOTS:
            with self.subTest(name=name):
                selected = self.root / name
                moved = self.root / (name + "-missing")
                selected.rename(moved)
                with self.assertRaisesRegex(ValueError, name):
                    COUNTER.inventory(self.root)
                moved.rename(selected)

    def test_missing_runtime_file_refused(self):
        (self.root / COUNTER.RUNTIME_FILES[0]).unlink()
        with self.assertRaisesRegex(ValueError, COUNTER.RUNTIME_FILES[0]):
            COUNTER.inventory(self.root)

    def test_file_cannot_stand_in_for_declared_root(self):
        (self.root / "src").rmdir()
        self.write("src")
        with self.assertRaisesRegex(ValueError, "src"):
            COUNTER.inventory(self.root)

    def test_empty_existing_roots_are_reported_as_zero(self):
        counts = COUNTER.inventory(self.root)
        self.assertEqual(counts["runtime"], (0, 0, len(COUNTER.RUNTIME_FILES)))
        self.assertEqual(counts["product"], counts["runtime"])
        self.assertEqual(counts["engineering-scripts"], (0, 0, 0))

    def test_physical_line_convention_unchanged(self):
        self.write("src/lines.py", '\n \n  # comment\n\t// comment\ncode # inline\n"""doc"""\n/* block */\n')
        self.assertEqual(COUNTER.inventory(self.root)["src"], (3, 7, 1))

    def test_suffixes_exclusions_and_product_boundary(self):
        for suffix in COUNTER.SUFFIXES:
            self.write("src/file" + suffix)
        for excluded in COUNTER.EXCLUDED:
            self.write("src/" + excluded + "/ignored.es")
        self.write("src/ignored.md")
        self.write("packages/session-store/tests/outside.es")
        self.write("packages/unrelated/src/outside.es")
        self.assertEqual(COUNTER.inventory(self.root)["product"], (4, 4, 4 + len(COUNTER.RUNTIME_FILES)))

    def test_cli_reports_version_roots_and_aggregate(self):
        self.write("src/main.es")
        self.write("src/store.es")
        output = io.StringIO()
        with patch.object(COUNTER, "ROOT", self.root), contextlib.redirect_stdout(output):
            self.assertEqual(COUNTER.main(), 0)
        self.assertIn("nomo-physical-v3; authoritative", output.getvalue())
        self.assertIn("product roots: src; reviewed runtime inventory:", output.getvalue())
        self.assertIn("src: 2 SLOC, 2 raw lines, 2 files", output.getvalue())
        self.assertIn("product: 2 SLOC, 2 raw lines, 14 files", output.getvalue())

    def test_cli_missing_root_has_no_authoritative_totals(self):
        (self.root / "src").rmdir()
        output, errors = io.StringIO(), io.StringIO()
        with patch.object(COUNTER, "ROOT", self.root), contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors):
            self.assertEqual(COUNTER.main(), 2)
        self.assertEqual(output.getvalue(), "")
        self.assertIn("authoritative inventory requires directories: src", errors.getvalue())

    def test_retired_product_root_refuses_stale_or_duplicate_sources(self):
        self.write("packages/session-store/src/nomo/store.es")
        output, errors = io.StringIO(), io.StringIO()
        with patch.object(COUNTER, "ROOT", self.root), contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors):
            self.assertEqual(COUNTER.main(), 2)
        self.assertEqual(output.getvalue(), "")
        self.assertIn("retired product root still contains counted sources", errors.getvalue())


if __name__ == "__main__":
    unittest.main()
