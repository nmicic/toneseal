// Copyright (c) 2026 Nenad Micic
// SPDX-License-Identifier: Apache-2.0
import {receiverPCM, decodePCM} from './communication-codec.mjs';
self.onmessage = async ({data}) => {
  try {
    const response = await fetch(new URL('./communication-decoder.wasm', import.meta.url));
    if (!response.ok) throw Error('Audio decoder is unavailable.');
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > 262144) throw Error('Audio decoder exceeds its size limit.');
    const module = await WebAssembly.compile(bytes);
    const {pcm} = receiverPCM(data.samples, data.rate);
    const {messages} = await decodePCM(module, pcm);
    const packets = messages.map(message => message.bytes);
    self.postMessage({ok:true, packets}, packets.map(packet => packet.buffer));
  } catch (error) { self.postMessage({ok:false, error:error.message}); }
};
