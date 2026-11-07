// Copyright (c) 2026 Nenad Micic
// SPDX-License-Identifier: Apache-2.0

// Deliberate, fixed suites: no arbitrary key/tag/nonce lengths and no automatic
// downgrade. A wire version identifies exactly one key-exchange algorithm.
const profiles = Object.freeze({
  p256:Object.freeze({id:'p256',name:'P-256 · compatible',version:2,publicKeyBytes:65,shareBytes:81,
    publicPacketBytes:84,rekeyPacketBytes:113,algorithm:Object.freeze({name:'ECDH',namedCurve:'P-256'})}),
  x25519:Object.freeze({id:'x25519',name:'X25519 · compact',version:3,publicKeyBytes:32,shareBytes:48,
    publicPacketBytes:51,rekeyPacketBytes:80,algorithm:Object.freeze({name:'X25519'})}),
});

export function getCryptoProfile(id = 'p256') {
  if (typeof id !== 'string' || !Object.hasOwn(profiles,id)) throw Error('Choose a supported cryptographic profile.');
  return profiles[id];
}

export function cryptoSupportError(profile) {
  return Error(profile.id === 'x25519'
    ? 'This browser cannot use native X25519. Choose P-256 on both devices or update the browser.'
    : 'This browser cannot use P-256 Web Crypto. Use HTTPS or localhost in a supported browser.');
}

// A receiver must check native support before waiting for someone else's offer.
// No shim is installed and no weaker/different profile is selected on failure.
export async function checkCryptoProfile(id = 'p256') {
  const profile = getCryptoProfile(id);
  let secret;
  try {
    if (!globalThis.crypto?.subtle) throw Error('Web Crypto is unavailable.');
    const keys = await crypto.subtle.generateKey(profile.algorithm,false,['deriveBits']);
    const raw = new Uint8Array(await crypto.subtle.exportKey('raw',keys.publicKey));
    if (raw.length !== profile.publicKeyBytes) throw Error('Unexpected native public key encoding.');
    const publicKey = await crypto.subtle.importKey('raw',raw,profile.algorithm,false,[]);
    secret = new Uint8Array(await crypto.subtle.deriveBits({...profile.algorithm,public:publicKey},keys.privateKey,256));
    let nonzero = 0;
    for (const byte of secret) nonzero |= byte;
    if (secret.length !== 32 || !nonzero) throw Error('Native key agreement failed.');
    return profile;
  } catch { throw cryptoSupportError(profile); }
  finally { secret?.fill(0); }
}
