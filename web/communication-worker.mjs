// Copyright (c) 2026 Nenad Micic
// SPDX-License-Identifier: Apache-2.0
import {receiverPCM,decodePCM,payloadText} from './communication-codec.mjs';
self.onmessage=async({data})=>{
  try {
    const response=await fetch(new URL('./communication-decoder.wasm',import.meta.url));
    if(!response.ok)throw Error('Experimental decoder is not built.');
    const bytes=await response.arrayBuffer();if(bytes.byteLength>256*1024)throw Error('Decoder module exceeds its budget.');
    const module=await WebAssembly.compile(bytes),converted=receiverPCM(data.samples,data.rate),decoded=await decodePCM(module,converted.pcm);
    const messages=decoded.messages.map(message=>({...message,text:payloadText(message.bytes),bytes:undefined}));
    self.postMessage({ok:true,messages,inputRate:data.rate,resampled:converted.resampled,clipped:converted.clipped,seconds:converted.pcm.length/48000});
  }catch(error){self.postMessage({ok:false,error:error.message});}
};
