// src/components/referring/ReferringPortalPage.jsx
// Phase 1 stub — full implementation in Phase 2.
import React from 'react';
import Header from '../layout/Header.jsx';
import { useStore } from '../../store/index.js';

export default function ReferringPortalPage() {
  const { user, clearAuth } = useStore();

  return (
    <div className="app-shell">
      <Header />
      <div className="flex-1 flex flex-col items-center justify-center gap-4 p-8">
        <h1 style={{ fontSize: 22, fontWeight: 600 }}>Referring Physician Portal</h1>
        <p style={{ color: 'var(--text-muted)', fontSize: 14 }}>
          Welcome, {user?.firstName || user?.login}. Submit cases and track your referrals here.
        </p>
        <p style={{ color: 'var(--text-muted)', fontSize: 12, opacity: 0.6 }}>
          (Full portal coming in Phase 2)
        </p>
        <button
          className="btn btn-secondary"
          style={{ marginTop: 16 }}
          onClick={clearAuth}>
          Sign out
        </button>
      </div>
    </div>
  );
}
