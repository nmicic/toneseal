// Copyright (c) 2026 Nenad Micic
// SPDX-License-Identifier: Apache-2.0

// Both peers select the same profile before Start. The renderer and packet
// format stay canonical; playback and capture apply inverse time scaling.
const profiles = Object.freeze({
  nearby:Object.freeze({id:'nearby',name:'Nearby devices',playbackRate:1,timingScale:1}),
  telephone:Object.freeze({id:'telephone',name:'Telephone (experimental)',playbackRate:0.75,timingScale:1/0.75}),
});

export function getAudioProfile(id = 'nearby') {
  if (typeof id !== 'string' || !Object.hasOwn(profiles,id)) throw Error('Choose a supported audio profile.');
  return profiles[id];
}
