/* Copyright (c) 2026 Nenad Micic; SPDX-License-Identifier: Apache-2.0 */
#ifndef TONESEAL_AUDIO_PROFILE_H
#define TONESEAL_AUDIO_PROFILE_H
enum { TS_AUDIO_NEARBY, TS_AUDIO_TELEPHONE, TS_AUDIO_ULTRASONIC };
static inline int ts_audio_profile_valid(int profile) { return profile>=TS_AUDIO_NEARBY && profile<=TS_AUDIO_ULTRASONIC; }
static inline double ts_audio_timing_scale(int profile) { return profile==TS_AUDIO_ULTRASONIC?2:profile==TS_AUDIO_TELEPHONE?4.0/3:1; }
#endif
