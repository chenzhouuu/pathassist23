// src/components/ViewerApp.jsx — the original viewer layout
import React from 'react';
import { useStore } from '../store/index.js';
import Header from './layout/Header.jsx';
import LeftSidebar from './sidebar/LeftSidebar.jsx';
import ViewerPanel from './viewer/ViewerPanel.jsx';
import RightPanel from './panels/RightPanel.jsx';

export default function ViewerApp() {
  return (
    <div className="flex flex-col h-screen overflow-hidden" style={{ background: 'var(--bg)' }}>
      <Header showBack />
      <div className="flex flex-1 overflow-hidden">
        <LeftSidebar />
        <ViewerPanel />
        <RightPanel />
      </div>
    </div>
  );
}
