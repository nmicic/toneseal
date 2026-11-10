// Copyright (c) 2026 Nenad Micic; SPDX-License-Identifier: Apache-2.0
// Unity gain keeps verified PCM unchanged and avoids clipping the modem tones.
export const MAX_PLAYBACK_GAIN = 1;

export function devicePlaybackHint(navigator = globalThis.navigator) {
  const ios = /iPhone|iPad|iPod/.test(navigator?.userAgent || '') ||
    navigator?.platform === 'MacIntel' && navigator?.maxTouchPoints > 1;
  return ios ? 'iPhone/iPad: use the volume buttons after starting audio.'
    : 'Use your device’s volume buttons to adjust the speaker.';
}
export function installPlaybackHints(root = globalThis.document) {
  for (const node of root?.querySelectorAll('[data-playback-hint]') || []) node.textContent = devicePlaybackHint();
}
const release = lock => {try {Promise.resolve(lock.release()).catch(() => {});} catch {}};

// Screen timeout protection only: never background audio or a CPU wake lock.
// The browser may refuse or release it; neither condition stops the transfer.
export class ScreenAwake {
  constructor({navigator = globalThis.navigator, document = globalThis.document, onChange = () => {}} = {}) {
    this.navigator = navigator; this.document = document; this.onChange = onChange;
    this.generation = 0; this.lock = null; this.wanted = false; this.state = 'idle';
  }
  setState(state) {if (this.state !== state) {this.state = state; this.onChange(state);}}
  async start() {
    this.stop(); this.wanted = true; const generation = this.generation;
    if (!this.navigator?.wakeLock?.request) {this.setState('unsupported'); return;}
    if (this.document?.hidden) {this.setState('released'); return;}
    this.setState('pending');
    try {
      const lock = await this.navigator.wakeLock.request('screen');
      if (!lock || typeof lock.release !== 'function') throw Error('No screen lock returned.');
      if (!this.wanted || generation !== this.generation || this.document?.hidden) {
        release(lock);
        if (this.wanted && generation === this.generation) this.setState('released');
        return;
      }
      if (lock.released) {this.setState('released'); return;}
      this.lock = lock;
      lock.onrelease = () => {
        if (this.lock !== lock) return;
        this.lock = null; lock.onrelease = null; this.setState('released');
      };
      this.setState('held');
    } catch {
      if (this.wanted && generation === this.generation) this.setState('denied');
    }
  }
  stop() {
    this.wanted = false; this.generation++;
    const lock = this.lock; this.lock = null;
    if (lock) {lock.onrelease = null; if (!lock.released) release(lock);}
    this.setState('idle');
  }
}
