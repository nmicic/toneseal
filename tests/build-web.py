# Copyright (c) 2026 Nenad Micic
# SPDX-License-Identifier: Apache-2.0
"""Check renderer packaging without compiling the native receiver."""
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import subprocess
from unittest.mock import patch
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

    def test_portable_document_dependency_is_required_and_packaged(self):
        self.worker.write_text("import {parseDocument} from './tl-document.mjs';\n")
        with self.assertRaisesRegex(ValueError, "requires missing tl-document\\.mjs"):
            builder.renderer_support_assets(self.assets, self.entries)
        (self.assets / "tl-document.mjs").write_text("export const parseDocument = () => {};\n")
        self.assertIn("tl-document.mjs", builder.renderer_support_assets(self.assets, self.entries))

    def test_transitive_document_dependency_is_packaged(self):
        self.worker.write_text("import './authoring.mjs';\n")
        (self.assets / "authoring.mjs").write_text("import './tl-document.mjs';\n")
        with self.assertRaisesRegex(ValueError, "requires missing tl-document\\.mjs"):
            builder.renderer_support_assets(self.assets, self.entries)
        (self.assets / "tl-document.mjs").write_text("export const parseDocument = () => {};\n")
        self.assertIn("tl-document.mjs", builder.renderer_support_assets(self.assets, self.entries))

    def test_legacy_renderer_does_not_gain_unused_document_helper(self):
        (self.assets / "tl-document.mjs").write_text("export const parseDocument = () => {};\n")
        self.assertNotIn("tl-document.mjs", builder.renderer_support_assets(self.assets, self.entries))

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


class OutputSafety(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name).resolve()
        root_patch = patch.object(builder, 'ROOT', self.root)
        root_patch.start()
        self.addCleanup(root_patch.stop)
        self.dist = self.root / 'dist'

    def staged(self, data='new'):
        stage = Path(tempfile.mkdtemp(dir=self.root))
        (stage / 'index.html').write_text(data)
        return stage

    def test_fresh_repeat_and_legacy_migration(self):
        self.staged().rename(self.dist)
        builder.install_site(self.staged(), self.dist)
        self.assertTrue((self.dist / builder.BUILD_INVENTORY).is_file())
        builder.install_site(self.staged('changed upstream'), self.dist)
        self.assertEqual((self.dist / 'index.html').read_text(), 'changed upstream')

    def test_populated_custom_and_modified_outputs_stay_intact(self):
        custom = self.staged()
        with self.assertRaises(ValueError):
            builder.install_site(self.staged(), custom)
        self.assertEqual((custom / 'index.html').read_text(), 'new')
        builder.install_site(self.staged(), self.dist)
        (self.dist / 'my-notes').write_text('keep')
        with self.assertRaises(ValueError):
            builder.install_site(self.staged(), self.dist)
        self.assertEqual((self.dist / 'my-notes').read_text(), 'keep')
        (self.dist / 'my-notes').unlink()
        (self.dist / 'index.html').write_text('hand edited')
        with self.assertRaises(ValueError):
            builder.install_site(self.staged(), self.dist)
        self.assertEqual((self.dist / 'index.html').read_text(), 'hand edited')

    def test_source_tracked_content_and_symlinks_are_refused(self):
        for path in ['docs', '.github', '.git', 'tests/subdir', 'out/../docs']:
            with self.subTest(path=path), self.assertRaises(ValueError):
                builder.output_path(self.root / path)
        tracked = self.staged()
        subprocess.run(['git', 'init', '-q', self.root], check=True)
        subprocess.run(['git', 'add', str(tracked)], cwd=self.root, check=True)
        with self.assertRaisesRegex(ValueError, 'tracked'):
            builder.install_site(self.staged(), tracked)
        (self.root / 'alias').symlink_to(tracked, target_is_directory=True)
        for path in ['alias', 'alias/child']:
            with self.subTest(path=path), self.assertRaisesRegex(ValueError, 'symlink'):
                builder.output_path(self.root / path)
        builder.install_site(self.staged(), self.dist)
        (self.dist / 'extra').symlink_to(tracked, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, 'file type'):
            builder.install_site(self.staged(), self.dist)
        self.assertTrue((self.dist / 'extra').is_symlink())

    def test_failed_publication_restores_previous_tree(self):
        builder.install_site(self.staged('original'), self.dist)
        stage = self.staged('replacement')
        original_rename = Path.rename
        def fail_install(path, target):
            if path == stage:
                raise OSError('cannot install')
            return original_rename(path, target)
        with patch.object(Path, 'rename', fail_install), self.assertRaisesRegex(OSError, 'cannot install'):
            builder.install_site(stage, self.dist)
        self.assertEqual((self.dist / 'index.html').read_text(), 'original')


if __name__ == "__main__":
    unittest.main()
