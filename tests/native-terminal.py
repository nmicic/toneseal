#!/usr/bin/env python3
# Copyright (c) 2026 Nenad Micic; SPDX-License-Identifier: Apache-2.0
"""Exercise real terminal IO, echo restoration and control escaping, without capture."""
import errno
import os
from pathlib import Path
import pty
import select
import signal
import subprocess
import tempfile
import termios
import time
import unittest

ROOT = Path(__file__).resolve().parents[1]
CLI = str(Path(os.environ.get('TONESEAL_CLI', ROOT/'build/toneseal')))

class Terminal(unittest.TestCase):
    def open(self, args):
        master, slave = pty.openpty()
        child = subprocess.Popen([CLI, *args], stdin=slave, stdout=slave, stderr=slave, close_fds=True)
        return child, master, slave

    def read(self, child, master, until=None):
        output = bytearray(); deadline = time.monotonic()+15
        while time.monotonic()<deadline:
            if select.select([master], [], [], .05)[0]:
                try: data = os.read(master, 16384)
                except OSError as error:
                    if error.errno == errno.EIO: break
                    raise
                if not data: break
                output.extend(data)
                if until and until in output: return bytes(output)
            elif child.poll() is not None: return bytes(output)
        if child.poll() is None and (until is None or until not in output):
            child.kill(); self.fail('Terminal operation exceeded its deadline')
        return bytes(output)

    def test_01_password_echo_restored_on_interrupt_and_suspend_request(self):
        for stop in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP, signal.SIGTSTP):
            with self.subTest(signal=stop):
                child, master, slave = self.open(['send', '--mode', 'password'])
                try:
                    before = self.read(child, master, b'bytes): ')
                    self.assertIn(b'Enter password', before)
                    self.assertFalse(termios.tcgetattr(slave)[3] & termios.ECHO)
                    os.write(master, b'dummy-only-unsubmitted')
                    os.kill(child.pid, stop)
                    output = before+self.read(child, master)
                    child.wait(timeout=5)
                    self.assertEqual(child.returncode, 128+stop)
                    self.assertNotIn(b'dummy-only-unsubmitted', output)
                    self.assertTrue(termios.tcgetattr(slave)[3] & termios.ECHO)
                finally:
                    if child.poll() is None: child.kill(); child.wait()
                    os.close(master); os.close(slave)

    def test_02_password_too_long_never_echoes_or_starts_audio(self):
        child, master, slave = self.open(['send', '--mode', 'password'])
        try:
            before = self.read(child, master, b'bytes): ')
            os.write(master, b'DUMMY_TOO_LONG_'*9+b'\n')
            output = before+self.read(child, master); child.wait(timeout=5)
            self.assertEqual(child.returncode, 2)
            self.assertNotIn(b'DUMMY_TOO_LONG_', output)
            self.assertIn(b'1-96', output)
            self.assertTrue(termios.tcgetattr(slave)[3] & termios.ECHO)
        finally:
            if child.poll() is None: child.kill(); child.wait()
            os.close(master); os.close(slave)

    def test_03_received_text_cannot_inject_terminal_control_sequences(self):
        with tempfile.TemporaryDirectory(prefix='toneseal-terminal-') as temporary:
            name = Path(temporary)/'control.wav'
            text = b'\x1b]52;c;not-a-clipboard-write\x07\r\n/end'
            result = subprocess.run([CLI, 'encode', '--output', str(name)], input=text, capture_output=True, timeout=30)
            self.assertEqual(result.returncode, 0, result.stderr)
            timeline = Path(temporary)/'control.tl'
            result = subprocess.run([CLI, 'text', 'to-tl', '--output', str(timeline)], input=text, capture_output=True, timeout=30)
            self.assertEqual(result.returncode, 0, result.stderr)
            for args in (['decode', '--input', str(name)], ['text', 'from-wav', '--input', str(name)],
                         ['text', 'from-tl', '--input', str(timeline)]):
                with self.subTest(command=args[:2]):
                    child, master, slave = self.open(args)
                    try:
                        output = self.read(child, master); child.wait(timeout=5)
                        self.assertEqual(child.returncode, 0, output)
                        self.assertNotIn(b'\x1b', output)
                        self.assertNotIn(b'\x07', output)
                        self.assertIn(b'\\x1b]52;c;not-a-clipboard-write\\x07\\x0d\\x0a/end', output)
                    finally:
                        if child.poll() is None: child.kill(); child.wait()
                        os.close(master); os.close(slave)

    def test_04_timeline_parser_diagnostics_cannot_inject_terminal_controls(self):
        with tempfile.TemporaryDirectory(prefix='toneseal-terminal-') as temporary:
            timeline = Path(temporary)/'invalid.tl'
            timeline.write_bytes(b'\x1b]52;c;not-a-clipboard-write\x07\n')
            child, master, slave = self.open(['text', 'from-tl', '--input', str(timeline)])
            try:
                output = self.read(child, master); child.wait(timeout=5)
                self.assertEqual(child.returncode, 2, output)
                self.assertNotIn(b'\x1b', output); self.assertNotIn(b'\x07', output)
            finally:
                if child.poll() is None: child.kill(); child.wait()
                os.close(master); os.close(slave)

if __name__ == '__main__': unittest.main(verbosity=2)
