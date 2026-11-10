// Copyright (c) 2026 Nenad Micic
// SPDX-License-Identifier: Apache-2.0
export const DEFAULT_PEER_IDLE_TIMEOUT_MS = 60000;
export const MAX_PEER_IDLE_TIMEOUT_MS = 3600000;
export const MAX_AUDIO_RUN_MS = 2 * MAX_PEER_IDLE_TIMEOUT_MS;

// Preserve the normal three-/ten-minute limits. Longer Advanced choices need
// room for the chosen idle window and a bounded delivery/close exchange.
export const transferLifetimeMs = (normalMs, idleMs) =>
  idleMs > 120000 ? Math.max(normalMs, 2 * idleMs) : normalMs;
