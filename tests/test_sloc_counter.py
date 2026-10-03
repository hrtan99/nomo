"""Counter v2 regression: product roots are explicit and cannot silently disappear."""
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

    def write(self, relative, text="code;\n"):
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)

    def test_package_contributes_to_combined_product(self):
        self.write("src/nomo/main.es", "// note\ncode;\n\n")
        self.write("packages/session-store/src/nomo/store.es", "first;\nsecond;\n")
        self.write("tests/fixture.py", "fixture()\n")
        counts = COUNTER.inventory(self.root)
        self.assertEqual(counts["src"], (1, 3, 1))
        self.assertEqual(counts["packages/session-store/src"], (2, 2, 1))
        self.assertEqual(counts["product"], (3, 5, 2))
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
                (self.root / name).rmdir()
                with self.assertRaisesRegex(ValueError, name):
                    COUNTER.inventory(self.root)
                (self.root / name).mkdir()

    def test_file_cannot_stand_in_for_declared_root(self):
        (self.root / "src").rmdir()
        self.write("src")
        with self.assertRaisesRegex(ValueError, "src"):
            COUNTER.inventory(self.root)

    def test_empty_existing_roots_are_reported_as_zero(self):
        self.assertTrue(all(values == (0, 0, 0) for values in COUNTER.inventory(self.root).values()))

    def test_physical_line_convention_unchanged(self):
        self.write("src/lines.py", '\n \n  # comment\n\t// comment\ncode # inline\n"""doc"""\n/* block */\n')
        self.assertEqual(COUNTER.inventory(self.root)["src"], (3, 7, 1))

    def test_suffixes_exclusions_and_package_boundary(self):
        for suffix in COUNTER.SUFFIXES:
            self.write("packages/session-store/src/file" + suffix)
        for excluded in COUNTER.EXCLUDED:
            self.write("packages/session-store/src/" + excluded + "/ignored.es")
        self.write("packages/session-store/src/ignored.md")
        self.write("packages/session-store/tests/outside.es")
        self.write("packages/unrelated/src/outside.es")
        self.assertEqual(COUNTER.inventory(self.root)["product"], (4, 4, 4))

    def test_cli_reports_version_roots_and_aggregate(self):
        self.write("src/main.es")
        self.write("packages/session-store/src/store.es")
        output = io.StringIO()
        with patch.object(COUNTER, "ROOT", self.root), contextlib.redirect_stdout(output):
            self.assertEqual(COUNTER.main(), 0)
        self.assertIn("nomo-physical-v2; authoritative", output.getvalue())
        self.assertIn("src: 1 SLOC, 1 raw lines, 1 files", output.getvalue())
        self.assertIn("packages/session-store/src: 1 SLOC, 1 raw lines, 1 files", output.getvalue())
        self.assertIn("product: 2 SLOC, 2 raw lines, 2 files", output.getvalue())

    def test_cli_missing_root_has_no_authoritative_totals(self):
        (self.root / "packages/session-store/src").rmdir()
        output, errors = io.StringIO(), io.StringIO()
        with patch.object(COUNTER, "ROOT", self.root), contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors):
            self.assertEqual(COUNTER.main(), 2)
        self.assertEqual(output.getvalue(), "")
        self.assertIn("authoritative inventory requires directories: packages/session-store/src", errors.getvalue())


if __name__ == "__main__":
    unittest.main()
