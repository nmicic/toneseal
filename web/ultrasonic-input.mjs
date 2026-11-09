// Copyright (c) 2026 Nenad Micic; SPDX-License-Identifier: Apache-2.0
import {ultrasonicTables} from './ultrasonic-tables.mjs';
const Q30=1073741824;
const rounded=value=>value<0?-Math.floor((-value+Q30/2)/Q30):Math.floor((value+Q30/2)/Q30);
const clamp=value=>Math.max(-32768,Math.min(32767,value));

// Mix 18.4–19.975 kHz down by 18.1 kHz. Low-pass BEFORE rate conversion,
// to suppress out-of-band music and the upper mixing image before decimation.
// Products/sums stay exact integers below 2^53, matching the native Q30 path.
export class UltrasonicInput {
  constructor(rate){
    if(!Object.hasOwn(ultrasonicTables,rate))throw Error('Use 44.1 or 48 kHz ultrasonic capture.');
    this.table=ultrasonicTables[rate];this.history=new Int16Array(128);this.reset();
  }
  reset(){this.phase=0;this.at=0;this.history.fill(0);}
  push(samples){
    if(!(samples instanceof Float32Array)||!samples.length||samples.length>8192)throw Error('Invalid ultrasonic capture chunk.');
    const out=new Float32Array(samples.length),{mix,filter}=this.table,history=this.history;
    for(let i=0;i<samples.length;i++){
      if(!Number.isFinite(samples[i]))throw Error('Non-finite ultrasonic input sample.');
      const value=clamp(Math.round(samples[i]*32768));
      history[this.at]=clamp(rounded(value*mix[this.phase]));
      let sum=filter[48]*history[(this.at-48)&127];
      for(let j=0;j<48;j++)sum+=filter[j]*(history[(this.at-j)&127]+history[(this.at-(96-j))&127]);
      out[i]=clamp(rounded(sum))/32768;
      this.at=(this.at+1)&127;if(++this.phase===mix.length)this.phase=0;
    }
    return out;
  }
}
