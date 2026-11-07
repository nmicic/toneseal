// Copyright (c) 2026 Nenad Micic
// SPDX-License-Identifier: Apache-2.0
// Keep focus/scroll targets below the shared header, including safe areas,
// orientation changes, and enlarged browser text. This opens no media or keys.
const header = document.getElementById('site-header');
function measureHeader() {
  if (header) document.documentElement.style.setProperty('--site-header-height', `${Math.ceil(header.getBoundingClientRect().height)}px`);
}
measureHeader();
if (header && globalThis.ResizeObserver) new ResizeObserver(measureHeader).observe(header);
window.addEventListener('pageshow', measureHeader);
window.addEventListener('resize', measureHeader);
