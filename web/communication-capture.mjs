// Copyright (c) 2026 Nenad Micic
// SPDX-License-Identifier: Apache-2.0
class BoundedCapture extends AudioWorkletProcessor {
  constructor(options){super();this.maximum=options.processorOptions.maximum;this.count=0;this.used=0;this.buffer=new Float32Array(2048);this.done=false;this.port.onmessage=()=>this.finish();}
  flush(){if(this.used){const data=this.buffer.slice(0,this.used);this.port.postMessage({samples:data},[data.buffer]);this.used=0;}}
  finish(){if(this.done)return;this.flush();this.done=true;this.port.postMessage({done:true});}
  process(inputs,outputs){for(const output of outputs)for(const channel of output)channel.fill(0);
    if(this.done)return false;const samples=inputs[0]?.[0];if(!samples)return true;
    for(const sample of samples){if(this.count>=this.maximum){this.finish();return false;}this.buffer[this.used++]=sample;this.count++;if(this.used===this.buffer.length)this.flush();}
    if(this.count===this.maximum){this.finish();return false;}return true;}
}
registerProcessor('bounded-communication-capture',BoundedCapture);
