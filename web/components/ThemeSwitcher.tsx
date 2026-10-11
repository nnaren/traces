import React, { useEffect, useState } from 'react';

/**
 * Appearance switcher: 浅色 / 深色 / 系统.
 *
 * "系统" removes the `data-theme` attribute entirely and lets the
 * `prefers-color-scheme` media query in styles.css decide, so the app follows the OS
 * live — a laptop switching to night mode updates the UI without a reload.
 * The choice is persisted; it is also applied before React mounts (see index.html
 * inline script) so there is no flash of the wrong theme on load.
 */

export type Theme = 'light' | 'dark' | 'system';
const KEY = 'trajview.theme';
const isTheme = (v: unknown): v is Theme => v === 'light' || v === 'dark' || v === 'system';

function apply(theme: Theme) {
  const root = document.documentElement;
  if (theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);
}

// localStorage throws in private mode and does not exist outside a browser; neither
// should be able to take the page down.
function read(): Theme {
  try {
    const v = localStorage.getItem(KEY);
    return isTheme(v) ? v : 'system';
  } catch {
    return 'system';
  }
}

function write(theme: Theme) {
  try { localStorage.setItem(KEY, theme); } catch { /* ignore */ }
}

const OPTIONS: Array<{ id: Theme; label: string; title: string }> = [
  { id: 'light', label: '浅色', title: '始终使用浅色外观' },
  { id: 'dark', label: '深色', title: '始终使用深色外观' },
  { id: 'system', label: '系统', title: '跟随操作系统外观设置' },
];

export function ThemeSwitcher() {
  const [theme, setTheme] = useState<Theme>(read);

  useEffect(() => {
    apply(theme);
    write(theme);
  }, [theme]);

  return (
    <div className="theme-switch" role="group" aria-label="外观">
      {OPTIONS.map((o) => (
        <button key={o.id} type="button" title={o.title} aria-pressed={theme === o.id}
          className={'theme-opt' + (theme === o.id ? ' on' : '')}
          onClick={() => setTheme(o.id)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}