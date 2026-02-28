// src/App.jsx
import React from 'react';
import { useStore } from './store/index.js';
import LoginModal from './components/layout/LoginModal.jsx';
import Header from './components/layout/Header.jsx';
import LeftSidebar from './components/sidebar/LeftSidebar.jsx';
import ViewerPanel from './components/viewer/ViewerPanel.jsx';
import RightPanel from './components/panels/RightPanel.jsx';

export default function App() {
  const { token } = useStore();

  if (!token) return <LoginModal />;

  return (
    <div className="flex flex-col h-screen overflow-hidden" style={{ background: 'var(--bg)' }}>
      <Header />
      <div className="flex flex-1 overflow-hidden">
        <LeftSidebar />
        <ViewerPanel />
        <RightPanel />
      </div>
    </div>
  );
}
