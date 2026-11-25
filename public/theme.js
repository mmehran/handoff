'use strict';
// Runs before the page draws: applies the theme picked in the menu (light or dark; otherwise the
// system's), so the page never flashes the other one first.
(function () {
  let t = null;
  try { t = JSON.parse(localStorage.getItem('handoff.theme')); } catch { /* private mode */ }
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  const dark = t === 'light' || t === 'dark' ? t === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  const meta = document.querySelector('meta[name=theme-color]');
  if (meta) meta.setAttribute('content', dark ? '#171a20' : '#ffffff');
})();
