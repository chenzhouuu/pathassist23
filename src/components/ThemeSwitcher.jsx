// src/components/ThemeSwitcher.jsx
import React, { useEffect } from 'react';
import { useStore } from '../store/index.js';

const THEMES = [
  {
    id: 'clinical',
    label: 'Clinical',
    icon: (
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <rect x="3" y="3" width="18" height="18" rx="2"/>
        <path d="M9 12h6M12 9v6"/>
      </svg>
    ),
  },
  {
    id: 'dark',
    label: 'Dark',
    icon: (
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
      </svg>
    ),
  },
];

export default function ThemeSwitcher() {
  const { theme, setTheme } = useStore();

  return (
    <div className="flex items-center rounded overflow-hidden" style={{ border: '1px solid var(--border)' }}>
      {THEMES.map((t) => (
        <button
          key={t.id}
          onClick={() => setTheme(t.id)}
          title={t.label}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '4px',
            padding: '3px 7px',
            fontSize: '10px',
            fontWeight: 500,
            cursor: 'pointer',
            border: 'none',
            borderRight: t.id !== 'dark' ? '1px solid var(--border)' : 'none',
            transition: 'all 0.15s',
            background: theme === t.id ? 'var(--accent)' : 'var(--bg-toolbar)',
            color: theme === t.id ? '#fff' : 'var(--muted)',
          }}
        >
          {t.icon}
          <span className="hidden sm:inline">{t.label}</span>
        </button>
      ))}
    </div>
  );
}
