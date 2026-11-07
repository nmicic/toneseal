// Copyright (c) 2026 Nenad Micic
// SPDX-License-Identifier: Apache-2.0
import {StreamingDecoder} from './auto-decoder.mjs';
let decoder=null,epoch=0,chain=Promise.resolve();
self.onmessage=({data})=>{
  chain=chain.then(async()=>{
    if(data.type==='init'){
      const response=await fetch(new URL('./communication-decoder.wasm',import.meta.url));
      if(!response.ok)throw Error('Audio decoder is unavailable.');
      const bytes=await response.arrayBuffer();
      if(bytes.byteLength>262144)throw Error('Audio decoder exceeds its size limit.');
      decoder=await StreamingDecoder.create(await WebAssembly.compile(bytes),data.rate,data.profile);
      self.postMessage({type:'ready'});
    }else if(data.type==='reset'){
      if(!decoder)throw Error('Decoder is not initialized.');
      epoch=data.epoch;decoder.reset();
    }else if(data.type==='samples'){
      if(!decoder)throw Error('Decoder is not initialized.');
      const packets=data.epoch===epoch?decoder.push(data.samples):[];
      self.postMessage({type:'decoded',id:data.id,epoch:data.epoch,packets,metrics:{...decoder.metrics}},packets.map(packet=>packet.buffer));
    }
  }).catch(error=>{self.postMessage({type:'error',error:error.message});});
};
