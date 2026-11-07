// Copyright (c) 2026 Nenad Micic
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {encodePayload} from '../web/communication-codec.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const fixture=JSON.parse(await fs.readFile(new URL('./fixtures/codec-vectors.json',import.meta.url),'utf8'));
test('independent wire vectors agree with the JavaScript encoder and C decoder',async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'toneseal-codec-'));
  try{
    const receiver=path.join(directory,'receiver'),input=path.join(directory,'frames.bin');
    execFileSync('python3',[path.join(root,'build.py'),'--out',receiver],{stdio:'pipe'});
    const frames=fixture.vectors.map(row=>{
      assert.deepEqual([...encodePayload(Uint8Array.from(row.payload),row.sender)],row.encoded);
      const frame=Buffer.alloc(row.encoded.length+2);frame.writeUInt16LE(row.encoded.length);frame.set(row.encoded,2);return frame;
    });
    await fs.writeFile(input,Buffer.concat(frames));
    const events=execFileSync(receiver,['frames',input],{encoding:'utf8'}).trim().split('\n').map(JSON.parse);
    assert.equal(events.length,fixture.vectors.length);
    for(const [index,row] of fixture.vectors.entries()){
      assert.equal(events[index].kind,'packet');assert.equal(events[index].sender,row.sender);
      assert.equal(events[index].payload_hex,Buffer.from(row.payload).toString('hex'));
    }
  }finally{await fs.rm(directory,{recursive:true,force:true});}
});
