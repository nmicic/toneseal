#!/usr/bin/env python3
# Copyright (c) 2026 Nenad Micic; SPDX-License-Identifier: Apache-2.0
"""Native CLI/WAV acceptance checks. No audio hardware, Node, or network needed."""
import array
import hashlib
import json
import math
import os
from pathlib import Path
import random
import re
import stat
import struct
import subprocess
import sys
import tempfile
import unittest
import wave

ROOT = Path(__file__).resolve().parents[1]
CLI = Path(os.environ.get('TONESEAL_CLI', ROOT / 'build/toneseal'))
MODEM = Path(os.environ.get('TONESEAL_MODEM', ROOT / 'build/modem-driver'))

class NativeFiles(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory(prefix='toneseal-native-')
        cls.directory = Path(cls.temporary.name)

    @classmethod
    def tearDownClass(cls):
        cls.temporary.cleanup()

    def run_cli(self, *args, data=None, code=0):
        result = subprocess.run([str(CLI), *map(str, args)], input=data,
                                capture_output=True, timeout=30)
        self.assertEqual(result.returncode, code, result.stderr.decode(errors='replace'))
        return result

    def modem(self, *args, code=0):
        result = subprocess.run([str(MODEM), *map(str, args)], capture_output=True, timeout=30)
        self.assertEqual(result.returncode, code, result.stderr.decode(errors='replace'))
        return result.stdout

    def name(self, name):
        return self.directory / (self._testMethodName + '-' + name)

    def encode(self, text, profile='nearby', rate=48000, suffix='input.wav'):
        name = self.name(suffix)
        self.run_cli('encode', '--output', name, '--rate', rate, '--profile', profile, data=text)
        return name

    def test_01_exact_utf8_bytes_all_profiles_and_rates(self):
        samples = [b'  line\n\x00end  ', ('\u00e9'*48).encode(), b'\x1b]52;c;ignored\x07\r\t']
        for profile in ('nearby', 'telephone'):
            for rate in (44100, 48000):
                for i, text in enumerate(samples):
                    with self.subTest(profile=profile, rate=rate, item=i):
                        name = self.encode(text, profile, rate, f'{profile}-{rate}-{i}.wav')
                        self.assertEqual(stat.S_IMODE(name.stat().st_mode), 0o600)
                        with wave.open(str(name), 'rb') as recording:
                            self.assertEqual((recording.getnchannels(), recording.getsampwidth(), recording.getframerate()), (1, 2, rate))
                            self.assertLessEqual(recording.getnframes()/rate, 5.55)
                        result = self.run_cli('decode', '--input', name, '--profile', profile)
                        self.assertEqual(result.stdout, text)
                        events = self.run_cli('decode', '--input', name, '--profile', profile, '--json')
                        event = json.loads(events.stdout)
                        self.assertEqual(event['text'].encode(), text)

    def test_02_new_outputs_and_private_permissions(self):
        name = self.encode(b'file output')
        before = name.read_bytes()
        self.run_cli('encode', '--output', name, data=b'replace', code=2)
        self.assertEqual(name.read_bytes(), before)
        output = self.name('message.txt')
        self.run_cli('decode', '--input', name, '--output', output)
        self.assertEqual(output.read_bytes(), b'file output')
        self.assertEqual(stat.S_IMODE(output.stat().st_mode), 0o600)
        self.run_cli('decode', '--input', name, '--output', output, code=2)
        target = self.name('target'); target.write_bytes(b'keep')
        symlink = self.name('link'); symlink.symlink_to(target)
        self.run_cli('encode', '--output', symlink, data=b'no', code=2)
        self.assertEqual(target.read_bytes(), b'keep')

    def test_03_invalid_text_is_not_replaced_or_truncated(self):
        for i, text in enumerate((b'', b'x'*97, b'\xc0\xaf', b'\xed\xa0\x80', b'\xf4\x90\x80\x80', b'\x80', b'\xe2\x82')):
            with self.subTest(item=i):
                name = self.name(str(i)+'.wav')
                self.run_cli('encode', '--output', name, data=text, code=2)
                self.assertFalse(name.exists())

    def test_04_framing_matches_independent_vectors(self):
        fixture = json.loads((ROOT/'tests/fixtures/codec-vectors.json').read_text())
        for item in fixture['vectors']:
            actual = self.modem('frame', bytes(item['payload']).hex(), item['sender']).strip()
            self.assertEqual(bytes.fromhex(actual.decode()), bytes(item['encoded']))

    def test_05_opaque_packets_and_maximum_frame(self):
        packet = bytes((i*37+9)%256 for i in range(128))
        name = self.name('max.wav')
        info = json.loads(self.modem('render', packet.hex(), name, 48000, 'nearby'))
        self.assertEqual(info['frames'], 199680)
        events = [json.loads(line) for line in self.modem('decode', name, 'nearby').splitlines()]
        self.assertEqual([event['packet'] for event in events if 'packet' in event], [packet.hex()])
        self.assertEqual(events[-1]['packets'], 1)
        self.run_cli('decode', '--input', name, code=1)
        event = json.loads(self.run_cli('decode', '--input', name, '--packets').stdout)
        self.assertEqual(event['hex'], packet.hex())

    def test_06_render_is_deterministic(self):
        packet = 'a70301' + '0123456789abcdef'*6
        files = [self.name(f'{i}.wav') for i in (1, 2)]
        records = [json.loads(self.modem('render', packet, name, 44100, 'telephone')) for name in files]
        self.assertEqual(records[0], records[1])
        self.assertEqual(hashlib.sha256(files[0].read_bytes()).digest(), hashlib.sha256(files[1].read_bytes()).digest())

    def test_07_stereo_first_channel_and_noise(self):
        text = b'stereo with mild deterministic noise'
        name = self.encode(text)
        with wave.open(str(name), 'rb') as recording:
            pcm = array.array('h', recording.readframes(recording.getnframes()))
        if sys.byteorder != 'little': pcm.byteswap()
        rng = random.Random(0x7a6513)
        samples = array.array('h')
        for value in pcm:
            samples.extend((max(-32768, min(32767, round(value*.6)+rng.randint(-20, 20))), 0))
        if sys.byteorder != 'little': samples.byteswap()
        stereo = self.name('stereo.wav')
        with wave.open(str(stereo), 'wb') as recording:
            recording.setparams((2, 2, 48000, 0, 'NONE', 'not compressed')); recording.writeframes(samples.tobytes())
        self.assertEqual(self.run_cli('decode', '--input', stereo).stdout, text)

    def test_08_damage_does_not_release_partial_text(self):
        name = self.encode(b'A message that must never be partly accepted')
        with wave.open(str(name), 'rb') as recording:
            pcm = bytearray(recording.readframes(recording.getnframes()))
        # Destroy the preamble and a substantial part of its protected header.
        pcm[:48000] = bytes(min(48000, len(pcm)))
        broken = self.name('broken.wav')
        with wave.open(str(broken), 'wb') as recording:
            recording.setparams((1, 2, 48000, 0, 'NONE', 'not compressed')); recording.writeframes(pcm)
        output = self.name('must-not-exist.txt')
        result = self.run_cli('decode', '--input', broken, '--output', output, code=1)
        self.assertEqual(result.stdout, b''); self.assertFalse(output.exists())

    def test_09_malformed_wav_is_bounded(self):
        name = self.encode(b'valid')
        good = name.read_bytes()
        rows = [b'', good[:20], good[:-1], good+b'x', b'RF64'+good[4:], good[:4]+struct.pack('<I', 0xffffffff)+good[8:]]
        for offset, value, encoding in ((20, 3, '<H'), (22, 0, '<H'), (22, 8, '<H'), (24, 8000, '<I'), (32, 1, '<H'), (34, 24, '<H'), (40, 0xffffffff, '<I')):
            row = bytearray(good); struct.pack_into(encoding, row, offset, value); rows.append(row)
        rows += [b'RIFF'+struct.pack('<I', 36)+b'WAVEfmt '+struct.pack('<I', 0xffffffff)+bytes(24), bytes(4*1024*1024+1)]
        for i, row in enumerate(rows):
            with self.subTest(item=i):
                broken = self.name(str(i)+'.wav'); broken.write_bytes(row)
                result = self.run_cli('decode', '--input', broken, code=2)
                self.assertEqual(result.stdout, b'')

    def test_10_unsupported_flags_are_explicit_errors(self):
        for args in (('decode', '--input', 'x', '--mode', 'password'), ('send', '--packets'), ('send', '--send'), ('receive', '--input', '-'), ('chat', '--input', '-'), ('send', '--mode', 'clear', '--verify'), ('encode', '--output', '-'), ('send', '--text', 'secret'), ('send', '--timeout', '0'), ('send', '--crypto', 'weaker'), ('send', '--output', '-', '--json')):
            with self.subTest(args=args): self.run_cli(*args, code=2)
        self.assertIn(b'0.1.0', self.run_cli('--version').stdout)
        self.assertIn(b'No clipboard', self.run_cli('--help').stdout)
        manifest = json.loads(self.run_cli('capabilities').stdout)
        self.assertEqual(manifest['schemaVersion'], 1)
        self.assertEqual(manifest['maxTextBytes'], 96)
        self.assertFalse(manifest['automaticClipboard'])

    def test_11_text_timeline_round_trip_is_byte_exact(self):
        samples = [b'x', b'\x00', b' \r\n\t\x00  ', b'NEVER_EMBED_ME_IN_TL',
                   '\ufeffe\u0301 \u00e9 \U0001f511\r\n\x00'.encode(), b'x'*96, ('\u00e9'*48).encode()]
        for i, text in enumerate(samples):
            with self.subTest(item=i):
                source = self.name(f'{i}.txt'); source.write_bytes(text)
                timeline = self.name(f'{i}.tl'); recovered = self.name(f'{i}-recovered.txt')
                event = json.loads(self.run_cli('text', 'to-tl', '--input', source, '--output', timeline, '--json').stdout)
                self.assertEqual(event['format'], 'tl'); self.assertFalse(event['encrypted'])
                self.assertEqual(event['timelineBytes'], timeline.stat().st_size)
                self.assertEqual(stat.S_IMODE(timeline.stat().st_mode), 0o600)
                self.assertRegex(timeline.read_text(), r'(?m)^hash [0-9a-f]{16}$')
                self.assertNotIn(b'NEVER_EMBED_ME_IN_TL', timeline.read_bytes())
                self.run_cli('text', 'from-tl', '--input', timeline, '--output', recovered)
                self.assertEqual(recovered.read_bytes(), source.read_bytes())
                self.assertEqual(stat.S_IMODE(recovered.stat().st_mode), 0o600)
                self.assertEqual(self.run_cli('text', 'from-tl', '--input', timeline).stdout, text)

    def test_12_text_wav_round_trip_all_profiles_and_rates(self):
        text = ' \ufeffe\u0301 \u00e9 \U0001f511\r\n\x00tail  '.encode()
        source = self.name('source.txt'); source.write_bytes(text)
        for profile in ('nearby', 'telephone'):
            for rate in (44100, 48000):
                with self.subTest(profile=profile, rate=rate):
                    name = self.name(f'{profile}-{rate}.wav'); recovered = self.name(f'{profile}-{rate}.txt')
                    event = json.loads(self.run_cli('text', 'to-wav', '--input', source, '--output', name, '--profile', profile, '--rate', rate, '--json').stdout)
                    self.assertEqual(event['format'], 'wav')
                    self.run_cli('text', 'from-wav', '--input', name, '--output', recovered, '--profile', profile)
                    self.assertEqual(recovered.read_bytes(), source.read_bytes())
                    self.assertEqual(self.run_cli('text', 'from-wav', '--input', '-', '--profile', profile, data=name.read_bytes()).stdout, text)

    def test_13_timeline_pipes_and_comments_do_not_supply_the_text(self):
        text = b'  Sound carries this text.\r\n\x00  '
        timeline = self.run_cli('text', 'to-tl', data=text).stdout
        for source in (timeline, timeline.replace(b'\n', b'\r\n'),
                       b'# Bogus recovered text: DO NOT USE\n'+timeline,
                       re.sub(rb'(?m)^hash [0-9a-f]{16}\n', b'', timeline)):
            with self.subTest(bytes=len(source)):
                self.assertEqual(self.run_cli('text', 'from-tl', '--input', '-', data=source).stdout, text)
        event = json.loads(self.run_cli('text', 'from-tl', '--input', '-', '--json', data=timeline).stdout)
        self.assertEqual(event['text'].encode(), text)

    def test_14_timeline_hash_damage_and_input_limits_release_nothing(self):
        timeline = self.run_cli('text', 'to-tl', data=b'dummy').stdout
        saved_hash = re.search(rb'(?m)^hash ([0-9a-f]{16})$', timeline)
        self.assertIsNotNone(saved_hash)
        digest = saved_hash.group(1); wrong = (b'1' if digest[:1] == b'0' else b'0')+digest[1:]
        altered_hash = timeline[:saved_hash.start(1)]+wrong+timeline[saved_hash.end(1):]
        rows = [b'', b'not a timeline\n', timeline+b'\x00', b'x'*200001, altered_hash,
                re.sub(rb'(?m)^fs 48000$', b'fs 44100', timeline),
                re.sub(rb'(?m)^length_ns [0-9]+$', b'length_ns 1000000000000', timeline),
                timeline.replace(b'on 600000 32767', b'on 650000 32767', 1)]
        for i, source in enumerate(rows):
            with self.subTest(item=i):
                output = self.name(f'{i}.txt')
                result = self.run_cli('text', 'from-tl', '--input', '-', '--output', output, data=source, code=2)
                self.assertEqual(result.stdout, b''); self.assertFalse(output.exists())

    def test_15_general_synth_sound_is_not_interpreted_as_text(self):
        timeline = self.run_cli('text', 'to-tl', data=b'dummy').stdout
        header = b'\n'.join(line for line in timeline.splitlines() if line and not line[:1].isdigit() and not line.startswith(b'hash '))+b'\n'
        header = re.sub(rb'(?m)^length_ns [0-9]+$', b'length_ns 1000000000', header)
        music = header+b'0 message 0 on 440000 32767\n500000000 message 0 off\n'
        output = self.name('no-message.txt')
        result = self.run_cli('text', 'from-tl', '--input', '-', '--output', output, data=music, code=1)
        self.assertEqual(result.stdout, b''); self.assertFalse(output.exists())

    def test_16_text_conversion_flags_and_no_overwrite(self):
        timeline = self.name('message.tl')
        self.run_cli('text', 'to-tl', '--output', timeline, data=b'dummy')
        before = timeline.read_bytes()
        self.run_cli('text', 'to-tl', '--output', timeline, data=b'replace', code=2)
        self.assertEqual(timeline.read_bytes(), before)
        output = self.name('keep.txt'); output.write_bytes(b'keep')
        self.run_cli('text', 'from-tl', '--input', timeline, '--output', output, code=2)
        self.assertEqual(output.read_bytes(), b'keep')
        for action in ('to-tl', 'to-wav'):
            for text in (b'', b'x'*97, b'\xed\xa0\x80'):
                name = self.name(action+str(len(text)))
                self.run_cli('text', action, '--output', name, data=text, code=2)
                self.assertFalse(name.exists())
        for args in (('to-tl', '--profile', 'telephone'), ('from-tl', '--rate', '44100'),
                     ('to-tl', '--json'), ('to-tl', '--json', '--output', '-'),
                     ('from-tl',), ('from-wav',), ('to-wav',), ('to-wav', '--output', '-'),
                     ('to-tl', '--mode', 'password'), ('unknown',)):
            with self.subTest(args=args): self.run_cli('text', *args, code=2)
        self.assertIn(b'ToneSeal', self.run_cli('text', '--help').stdout)
        manifest = json.loads(self.run_cli('capabilities').stdout)
        self.assertIn('text', manifest['commands'])
        self.assertEqual(manifest['textConversions']['actions'], ['to-tl', 'from-tl', 'to-wav', 'from-wav'])

    def test_17_ultrasonic_text_round_trip_and_audible_interference(self):
        text = ('\u00e9'*48).encode()
        timeline = self.name('ultrasonic.tl')
        self.run_cli('text', 'to-tl', '--profile', 'ultrasonic', '--output', timeline, data=text)
        self.assertIn(b'length_ns 8320000000\n', timeline.read_bytes())
        self.assertEqual(self.run_cli('text', 'from-tl', '--profile', 'ultrasonic', '--input', timeline).stdout, text)
        self.run_cli('text', 'from-tl', '--input', timeline, code=1)
        for rate in (48000, 44100):
            with self.subTest(rate=rate):
                name = self.name(str(rate)+'.wav')
                self.run_cli('text', 'to-wav', '--profile', 'ultrasonic', '--rate', rate, '--output', name, data=text)
                with wave.open(str(name), 'rb') as recording:
                    self.assertAlmostEqual(recording.getnframes()/rate, 8.32)
                    samples = array.array('h', recording.readframes(recording.getnframes()))
                if sys.byteorder != 'little': samples.byteswap()
                self.assertEqual(self.run_cli('text', 'from-wav', '--profile', 'ultrasonic', '--input', name).stdout, text)
                rng = random.Random(0x7192)
                for i, value in enumerate(samples):
                    sample = round(value*.7+8000*math.cos(2*math.pi*7000*i/rate)+rng.randint(-8, 8))
                    self.assertLess(abs(sample), 32768, 'synthetic interference must not clip the microphone')
                    samples[i] = sample
                if sys.byteorder != 'little': samples.byteswap()
                noisy = self.name(str(rate)+'-noisy.wav')
                with wave.open(str(noisy), 'wb') as recording:
                    recording.setparams((1, 2, rate, 0, 'NONE', 'not compressed')); recording.writeframes(samples.tobytes())
                self.assertEqual(self.run_cli('text', 'from-wav', '--profile', 'ultrasonic', '--input', noisy).stdout, text)
                self.run_cli('text', 'from-wav', '--input', noisy, code=1)

if __name__ == '__main__': unittest.main(verbosity=2)
