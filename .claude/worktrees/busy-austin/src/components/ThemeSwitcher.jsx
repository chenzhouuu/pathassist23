// src/components/ThemeSwitcher.jsx
import React, { useEffect } from 'react';
import { useStore } from '../store/index.js';

const THEMES = [
  {
    id: 'light',
    label: 'Light',
    icon: (
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="12" cy="12" r="5"/>
        <line x1="12" y1="1" x2="12" y2="3"/>
        <line x1="12" y1="21" x2="12" y2="23"/>
        <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/>
        <line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/>
        <line x1="1" y1="12" x2="3" y2="12"/>
        <line x1="21" y1="12" x2="23" y2="12"/>
        <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/>
        <line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
      </svg>
    ),
  },
  {
    id: 'he',
    label: 'H&E',
    icon: (
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="12" cy="12" r="9"/>
        <circle cx="12" cy="12" r="4"/>
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
            borderRight: t.id !== 'he' ? '1px solid var(--border)' : 'none',
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
