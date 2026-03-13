// src/components/ViewerApp.jsx — the original viewer layout
import React from 'react';
import Header from './layout/Header.jsx';
import LeftSidebar from './sidebar/LeftSidebar.jsx';
import ViewerPanel from './viewer/ViewerPanel.jsx';
import RightPanel from './panels/RightPanel.jsx';

export default function ViewerApp() {
  return (
    <div className="app-shell">
      <Header showBack />
      <div className="app-main">
        <LeftSidebar />
        <ViewerPanel />
        <RightPanel />
      </div>
    </div>
  );
}
