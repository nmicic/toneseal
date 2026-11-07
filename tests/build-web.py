# Copyright (c) 2026 Nenad Micic
# SPDX-License-Identifier: Apache-2.0
"""Check renderer packaging without compiling the native receiver."""
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("audio_site_builder", Path(__file__).resolve().parents[1] / "scripts/build-web.py")
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


class RendererAssets(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.assets = Path(self.directory.name)
        self.worker = self.assets / "worker.mjs"
        self.worker.write_text("import './runtime.mjs';\n")
        self.entries = [{"browser_wasm": "engines/test/browser.wasm", "browser_sha256": "a" * 64,
                         "library_wasm": "engines/test/library.wasm", "library_sha256": "b" * 64}]

    def companion(self):
        self.worker.write_text("import './spatial.mjs';\n")
        (self.assets / "spatial.mjs").write_text("import './runtime.mjs';\n")
        helper = b"test helper bytes"
        (self.assets / "spatial-view.wasm").write_bytes(helper)
        manifest = {"format": 1, "wasm_sha256": hashlib.sha256(helper).hexdigest(),
                    "browser_sha256": "a" * 64, "library_sha256": "b" * 64}
        (self.assets / "spatial-view.json").write_text(json.dumps(manifest))
        return manifest

    def test_old_renderer_remains_supported(self):
        self.assertEqual(builder.renderer_support_assets(self.assets, self.entries),
                         ["policy.mjs", "worker.mjs", "runtime.mjs", "engines.json"])

    def test_new_import_requires_and_packages_module(self):
        self.worker.write_text("import './spatial.mjs';\n")
        with self.assertRaisesRegex(ValueError, "requires missing"):
            builder.renderer_support_assets(self.assets, self.entries)
        (self.assets / "spatial.mjs").write_text("import './runtime.mjs';\n")
        self.assertIn("spatial.mjs", builder.renderer_support_assets(self.assets, self.entries))

    def test_authoring_import_requires_and_packages_module(self):
        self.companion()
        with self.worker.open("a") as worker:
            worker.write("import {compileScore,selectScoreStreams} from './authoring.mjs';\n")
        with self.assertRaisesRegex(ValueError, "requires missing authoring\\.mjs"):
            builder.renderer_support_assets(self.assets, self.entries)
        (self.assets / "authoring.mjs").write_text("export const compileScore = () => {};\n")
        names = builder.renderer_support_assets(self.assets, self.entries)
        self.assertTrue({"authoring.mjs", "spatial.mjs", "spatial-view.json",
                         "spatial-view.wasm"}.issubset(names))

    def test_unused_authoring_module_is_not_packaged(self):
        (self.assets / "authoring.mjs").write_text("export const compileScore = () => {};\n")
        self.assertNotIn("authoring.mjs", builder.renderer_support_assets(self.assets, self.entries))

    def test_companion_is_complete_and_digest_checked(self):
        self.companion()
        names = builder.renderer_support_assets(self.assets, self.entries)
        self.assertTrue({"spatial.mjs", "spatial-view.json", "spatial-view.wasm"}.issubset(names))
        (self.assets / "spatial-view.wasm").write_bytes(b"changed")
        with self.assertRaisesRegex(ValueError, "checksum"):
            builder.renderer_support_assets(self.assets, self.entries)
        (self.assets / "spatial-view.wasm").unlink()
        with self.assertRaisesRegex(ValueError, "requires its module"):
            builder.renderer_support_assets(self.assets, self.entries)

    def test_companion_must_match_installed_renderer(self):
        manifest = self.companion()
        manifest["browser_sha256"] = "c" * 64
        (self.assets / "spatial-view.json").write_text(json.dumps(manifest))
        with self.assertRaisesRegex(ValueError, "does not match"):
            builder.renderer_support_assets(self.assets, self.entries)


if __name__ == "__main__":
    unittest.main()
