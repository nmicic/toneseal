// Copyright (c) 2026 Nenad Micic
// SPDX-License-Identifier: Apache-2.0
// Reuse the unchanged synth worker's complete verification path. Only immutable,
// digest-checked engine assets are retained, and only for this Worker lifetime.
const nativeFetch = self.fetch.bind(self);
const nativeCompile = WebAssembly.compile.bind(WebAssembly);
const hex = bytes => Array.from(new Uint8Array(bytes), value => value.toString(16).padStart(2,'0')).join('');
const digest = async bytes => hex(await crypto.subtle.digest('SHA-256',bytes));
const MAX_ASSET = 16 * 1024 * 1024;
let allowed = new Map(), assets = new Map(), compiled = null, engineKey = '', busy = false;

function configure(engine) {
  if (!engine || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(engine.id)) throw Error('Invalid installed renderer.');
  const entries = [[engine.browser_wasm,engine.browser_sha256], ...(engine.runtime_module ? [[engine.runtime_module,engine.runtime_sha256]] : [])];
  const next = new Map(), base = new URL('./',import.meta.url), expected = new URL(`engines/${engine.id}/`,base);
  for (const [path,hash] of entries) {
    const url = new URL(path,base);
    if (url.origin !== base.origin || !url.pathname.startsWith(expected.pathname) || url.search || url.hash || !/^[0-9a-f]{64}$/.test(hash || ''))
      throw Error('Renderer assets require their installed directory and digest.');
    next.set(url.href,hash);
  }
  const id = JSON.stringify([...next]);
  if (id !== engineKey) { assets.clear(); compiled = null; engineKey = id; }
  allowed = next;
}

self.fetch = async (input,options) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url,import.meta.url).href;
  const expected = allowed.get(url), method = options?.method || input?.method || 'GET';
  if (!expected || method !== 'GET') return nativeFetch(input,options);
  const cached = assets.get(url);
  if (cached) return new Response(cached.bytes.slice(0),{status:200,headers:cached.headers});
  const response = await nativeFetch(input,options);
  if (!response.ok) return response;
  const declared = Number(response.headers.get('Content-Length'));
  if (Number.isFinite(declared) && declared > MAX_ASSET) throw Error('Renderer asset exceeds its memory limit.');
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > MAX_ASSET || await digest(bytes) !== expected) throw Error('Renderer asset checksum or size mismatch.');
  const headers = new Headers(response.headers);
  assets.set(url,{bytes,headers});
  return new Response(bytes.slice(0),{status:200,headers});
};

// The original worker still hashes the fetched bytes, validates the native
// identity, and performs canonical replay. Compilation is pure for exact bytes.
WebAssembly.compile = async bytes => {
  const hash = await digest(bytes);
  if (compiled?.hash === hash) return compiled.module;
  const module = await nativeCompile(bytes);
  compiled = {hash,module};
  return module;
};

const ready = import('./worker.mjs').then(() => {
  const original = self.onmessage;
  self.onmessage = handle;
  if (typeof original !== 'function') throw Error('Synth worker did not initialize.');
  return original;
});
async function handle(event) {
  if (busy) { self.postMessage({verdict:'refused',code:2,stderr:'Renderer is already working.',stdout:''}); return; }
  busy = true;
  try {
    const original = await ready;
    configure(event.data.engine);
    // Automatic transport uses verified mono PCM only. New synth workers can
    // skip their optional display projection; older workers ignore this field.
    await original({data:{...event.data,spatialDeadlineMs:0}});
  } catch (error) { self.postMessage({verdict:'refused',code:2,stderr:error.message,stdout:''}); }
  finally { busy = false; }
}
self.onmessage = handle;
