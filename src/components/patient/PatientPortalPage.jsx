// src/components/patient/PatientPortalPage.jsx
// Phase 1 stub — full implementation in Phase 3.
import React from 'react';
import Header from '../layout/Header.jsx';
import { useStore } from '../../store/index.js';

export default function PatientPortalPage() {
  const { user, clearAuth } = useStore();

  return (
    <div className="app-shell">
      <Header />
      <div className="flex-1 flex flex-col items-center justify-center gap-4 p-8">
        <h1 style={{ fontSize: 22, fontWeight: 600 }}>Patient Portal</h1>
        <p style={{ color: 'var(--text-muted)', fontSize: 14 }}>
          Welcome, {user?.firstName || user?.login}. Your slides and reports will appear here.
        </p>
        <p style={{ color: 'var(--text-muted)', fontSize: 12, opacity: 0.6 }}>
          (Full portal coming in Phase 3)
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
