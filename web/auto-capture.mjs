// Copyright (c) 2026 Nenad Micic
// SPDX-License-Identifier: Apache-2.0
class AutoCapture extends AudioWorkletProcessor {
  constructor(){super();this.buffer=new Float32Array(2048);this.used=0;this.start=0;this.stopped=false;this.port.onmessage=()=>{this.stopped=true;};}
  process(inputs,outputs){
    for(const output of outputs)for(const channel of output)channel.fill(0);
    if(this.stopped)return false;
    const samples=inputs[0]?.[0];if(!samples)return true;
    for(let i=0;i<samples.length;i++){
      if(!this.used)this.start=currentFrame+i;
      this.buffer[this.used++]=samples[i];
      if(this.used===this.buffer.length){
        const part=this.buffer;this.buffer=new Float32Array(2048);this.used=0;
        this.port.postMessage({samples:part,startFrame:this.start},[part.buffer]);
      }
    }
    return true;
  }
}
registerProcessor('automatic-audio-capture',AutoCapture);
