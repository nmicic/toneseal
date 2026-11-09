// Copyright (c) 2026 Nenad Micic
// SPDX-License-Identifier: Apache-2.0

// Both peers select the same profile before Start. Packet framing is shared.
// Telephone scales Nearby PCM; near-ultrasonic uses its own verified timeline
// and a mixer/low-pass front end before the unchanged packet decoder.
const profiles = Object.freeze({
  nearby:Object.freeze({id:'nearby',name:'Nearby devices',playbackRate:1,decodeRate:1,timingScale:1,toneBaseHz:600,toneStepHz:50,symbolMs:20,minHz:600,maxHz:3750,maxRenderSeconds:4.2}),
  telephone:Object.freeze({id:'telephone',name:'Telephone (experimental)',playbackRate:0.75,decodeRate:0.75,timingScale:1/0.75,toneBaseHz:600,toneStepHz:50,symbolMs:20,minHz:450,maxHz:2812.5,maxRenderSeconds:4.2}),
  ultrasonic:Object.freeze({id:'ultrasonic',name:'Near-ultrasonic (experimental)',playbackRate:1,decodeRate:0.5,timingScale:2,toneBaseHz:18400,toneStepHz:25,symbolMs:40,minHz:18400,maxHz:19975,maxRenderSeconds:8.4}),
});

export function getAudioProfile(id = 'nearby') {
  if (typeof id !== 'string' || !Object.hasOwn(profiles,id)) throw Error('Choose a supported audio profile.');
  return profiles[id];
}
