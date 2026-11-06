'use strict';

// Light/dark theme. Loaded in <head>, before the page draws, so it doesn't
// flash the wrong theme. Follows the system setting until the viewer picks one.
(function () {
  const KEY = 'finestra-theme';
  const root = document.documentElement;
  const prefersLight = window.matchMedia('(prefers-color-scheme: light)');

  function saved() {
    try {
      const value = localStorage.getItem(KEY);
      return value === 'light' || value === 'dark' ? value : null;
    } catch (e) {
      return null;
    }
  }

  function save(theme) {
    try {
      localStorage.setItem(KEY, theme);
    } catch (e) {
      // Storage is blocked: the choice just lasts until the page reloads.
    }
  }

  function label() {
    const button = document.getElementById('theme-toggle');
    if (!button) return;
    const next = root.dataset.theme === 'light' ? 'dark' : 'light';
    button.title = `Switch to ${next} mode`;
    button.setAttribute('aria-label', button.title);
  }

  function apply(theme) {
    root.dataset.theme = theme;
    label();
  }

  apply(saved() || (prefersLight.matches ? 'light' : 'dark'));

  prefersLight.addEventListener('change', e => {
    if (!saved()) apply(e.matches ? 'light' : 'dark');
  });

  document.addEventListener('DOMContentLoaded', () => {
    label();
    document.getElementById('theme-toggle').addEventListener('click', () => {
      const next = root.dataset.theme === 'light' ? 'dark' : 'light';
      save(next);
      apply(next);
    });
  });
})();
