#!/usr/bin/env python3
# Copyright (c) 2026 Nenad Micic; SPDX-License-Identifier: Apache-2.0
"""Opt-in Linux PortAudio lifecycle checks with a process-local ALSA null device.
This tests callback IO/cleanup, not sound propagation or physical timing.
"""
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parents[1]
CLI = str(Path(os.environ.get('TONESEAL_CLI', ROOT/'build/toneseal')))

@unittest.skipUnless(sys.platform == 'linux' and os.environ.get('TONESEAL_TEST_ALSA_NULL') == '1',
                     'requires explicit opt-in to the Linux ALSA null test')
class Audio(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory(prefix='toneseal-audio-')
        cls.directory = Path(cls.temporary.name)
        config = cls.directory/'asound.conf'
        # An explicit raw zero source avoids depending on null-plugin buffer
        # initialization. ALSA file-plugin input is documented at:
        # https://www.alsa-project.org/alsa-doc/alsa-lib/pcm_plugins.html
        config.write_text('pcm.sink { type null }\n'
                          'pcm.!default { type file slave.pcm "sink" '
                          'file "/dev/null" infile "/dev/zero" format "raw" '
                          'hint { show on description "ToneSeal test null device" } }\n')
        cls.environment = dict(os.environ, ALSA_CONFIG_PATH=str(config))

    @classmethod
    def tearDownClass(cls): cls.temporary.cleanup()

    def command(self, *args, data=None, code=0):
        start = time.monotonic()
        result = subprocess.run([CLI, *args], input=data, capture_output=True,
                                env=self.environment, timeout=12)
        self.assertEqual(result.returncode, code, result.stderr.decode(errors='replace')[-3000:])
        self.assertLess(time.monotonic()-start, 10)
        return [json.loads(line) for line in result.stdout.splitlines()]

    def test_01_device_manifest(self):
        rows = self.command('devices', '--json')
        self.assertGreaterEqual(len(rows[0]), 1)
        self.assertTrue(any(device['inputs'] > 0 and device['outputs'] > 0 for device in rows[0]))

    def test_02_actual_capture_callback(self):
        events = self.command('audio-probe', '--duration', '1', '--json')
        self.assertGreaterEqual(len(events), 3)
        self.assertTrue(all(event['type'] == 'audio-level' and event['peak'] == 0 for event in events))

    def test_03_no_peer_timeout_removes_empty_output(self):
        output = self.directory/'never-received'
        events = self.command('receive', '--mode', 'clear', '--timeout', '1', '--json', '--output', str(output), data=b'', code=1)
        self.assertEqual(events[-1]['phase'], 'error')
        self.assertFalse(events[-1]['active']); self.assertFalse(output.exists())
        self.assertFalse(any(event['type'] == 'message' for event in events))

    def test_04_actual_playback_without_a_receipt_is_not_delivered(self):
        events = self.command('send', '--mode', 'clear', '--timeout', '3', '--json', data=b'dummy null-backend message', code=1)
        self.assertGreaterEqual(events[-1]['sent'], 1)
        self.assertEqual(events[-1]['phase'], 'error')
        self.assertFalse(events[-1]['active'])
        self.assertFalse(any(event['type'] == 'delivered' or event.get('phase') == 'delivered' for event in events))

    def test_05_cancel_capture_and_playback_releases_backend(self):
        for sending in (False, True):
            with self.subTest(sending=sending):
                args = ['send' if sending else 'receive', '--mode', 'clear', '--json', '--timeout', '60']
                child = subprocess.Popen([CLI, *args], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=self.environment)
                try:
                    if sending: child.stdin.write(b'cancel dummy'); child.stdin.flush()
                    child.stdin.close(); child.stdin = None
                    time.sleep(.4)
                    child.send_signal(signal.SIGINT)
                    output, errors = child.communicate(timeout=4)
                    self.assertEqual(child.returncode, 130, errors[-3000:])
                    events = [json.loads(line) for line in output.splitlines()]
                    self.assertTrue(events); self.assertFalse(events[-1]['active'])
                    # Reopening after each stop exercises PortAudio termination.
                    self.command('audio-probe', '--duration', '1', '--json')
                finally:
                    if child.poll() is None: child.kill(); child.wait()

    def test_06_invalid_device_reports_an_actionable_error(self):
        events = self.command('receive', '--mode', 'clear', '--input-device', '4096', '--json', data=b'', code=2)
        self.assertEqual(events, [])

if __name__ == '__main__': unittest.main(verbosity=2)
