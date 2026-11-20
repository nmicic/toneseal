// Copyright (c) 2026 Nenad Micic
// SPDX-License-Identifier: Apache-2.0
import {test} from 'node:test';

const flush = () => new Promise(resolve => setImmediate(resolve));

// Time each simulated packet and retry on one clock. Real WebCrypto runs on
// Node's worker pool. Virtual time may advance only after that work settles.
export function installProtocolClock(t) {
  t.mock.timers.enable({apis:['setTimeout','Date'],now:0});
  t.mock.method(performance,'now',()=>Date.now());
  const pending = new Set();
  const subtle = globalThis.crypto.subtle;
  for (const name of ['generateKey','exportKey','importKey','deriveBits','digest','encrypt','decrypt']) {
    const perform = subtle[name].bind(subtle);
    t.mock.method(subtle,name,(...args)=>{
      const operation = perform(...args);
      pending.add(operation);
      const finished = () => pending.delete(operation);
      operation.then(finished,finished);
      return operation;
    });
  }
  return async function drainCrypto() {
    await flush();
    while (pending.size) {
      await Promise.allSettled([...pending]);
      await flush(); // Protocol continuations can start another operation.
    }
  };
}

export function protocolTest(name, run) {
  return test(name,async t=>{
    const drain = installProtocolClock(t);
    let running = true;
    async function advance() {
      while (running) {
        await drain();
        if (running) t.mock.timers.tick(1);
      }
    }
    const ticking = advance();
    try { await run(t); }
    finally { running = false; await ticking; }
  });
}
