// src/components/ViewerApp.jsx — the original viewer layout
import React from 'react';
import { useStore } from '../store/index.js';
import Header from './layout/Header.jsx';
import LeftSidebar from './sidebar/LeftSidebar.jsx';
import ViewerPanel from './viewer/ViewerPanel.jsx';
import RightPanel from './panels/RightPanel.jsx';

function LeftRail() {
  const {
    leftPanelOpen, leftPanelTab, setLeftPanelTab, setLeftPanelOpen,
    toggleLeftPanel, caseContext, hasRole, autoCollapseViewerPanels, setAutoCollapseViewerPanels,
  } = useStore();
  const canAnnotate = hasRole('annotation-users');
  const tabs = [
    {
      id: 'slides',
      title: caseContext ? 'Case slides' : 'Slides',
      show: true,
      icon: caseContext ? (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>
        </svg>
      ) : (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
        </svg>
      ),
    },
    {
      id: 'annotations',
      title: 'Annotations',
      show: canAnnotate,
      icon: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>
        </svg>
      ),
    },
    {
      id: 'layers',
      title: 'Layers',
      show: canAnnotate,
      icon: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <polygon points="12 2 22 8 12 14 2 8 12 2"/><polyline points="2 12 12 18 22 12"/><polyline points="2 16 12 22 22 16"/>
        </svg>
      ),
    },
  ].filter((tab) => tab.show);

  const openTab = (id) => {
    if (leftPanelOpen && leftPanelTab === id) {
      setLeftPanelOpen(false);
      return;
    }
    setLeftPanelTab(id);
    setLeftPanelOpen(true);
  };

  return (
    <div className={`viewer-side-rail viewer-side-rail-left ${leftPanelOpen ? 'is-open' : 'is-closed'}`}>
      <button
        type="button"
        onClick={toggleLeftPanel}
        className="viewer-rail-chevron"
        title={leftPanelOpen ? 'Hide left panel' : 'Show left panel'}
        aria-expanded={leftPanelOpen}
        aria-label={leftPanelOpen ? 'Hide left panel' : 'Show left panel'}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4">
          <polyline points={leftPanelOpen ? '15 18 9 12 15 6' : '9 18 15 12 9 6'} />
        </svg>
      </button>
      <div className="viewer-rail-divider" aria-hidden="true" />
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          onClick={() => openTab(tab.id)}
          className={`viewer-rail-btn ${leftPanelTab === tab.id && leftPanelOpen ? 'active' : ''}`}
          title={leftPanelOpen && leftPanelTab === tab.id ? `Hide ${tab.title}` : tab.title}
          aria-pressed={leftPanelTab === tab.id && leftPanelOpen}
        >
          {tab.icon}
        </button>
      ))}
      <div className="viewer-rail-divider" aria-hidden="true" />
      <button
        type="button"
        onClick={() => setAutoCollapseViewerPanels(!autoCollapseViewerPanels)}
        className={`viewer-rail-pref ${autoCollapseViewerPanels ? 'active' : ''}`}
        title={autoCollapseViewerPanels ? 'Auto-collapse after slide switch: on' : 'Auto-collapse after slide switch: off'}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          {autoCollapseViewerPanels ? (
            <>
              <path d="M12 17v5"/>
              <path d="M9 12l3 5 3-5"/>
              <path d="M5 7h14"/>
            </>
          ) : (
            <>
              <path d="M12 7V2"/>
              <path d="M9 12l3-5 3 5"/>
              <path d="M5 17h14"/>
            </>
          )}
        </svg>
      </button>
    </div>
  );
}

function RightRail() {
  const {
    rightPanelOpen, rightPanelTab, rightRailVisible, setRightPanelOpen, setRightPanelTab,
    setRightRailVisible, hasRole, autoCollapseViewerPanels, setAutoCollapseViewerPanels,
    panels,
  } = useStore();
  const tabs = [
    {
      id: 'metadata',
      show: true,
      title: 'Info',
      icon: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/>
          <line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>
        </svg>
      ),
    },
    {
      id: 'ai',
      show: hasRole('ai-users'),
      title: 'AI',
      icon: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
        </svg>
      ),
    },
    {
      id: 'analysis',
      show: hasRole('ai-users'),
      title: 'Analysis',
      icon: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M3 3v18h18"/><path d="M7 14l4-4 3 3 5-6"/>
        </svg>
      ),
    },
    {
      id: 'chat',
      show: hasRole('ai-users'),
      title: 'AskPA',
      icon: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
        </svg>
      ),
    },
    {
      id: 'copilot',
      show: hasRole('ai-users'),
      title: 'Copilot',
      icon: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8z"/>
        </svg>
      ),
    },
    {
      id: 'panels',
      show: true,
      title: 'Panels',
      badge: panels.length || null,
      icon: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/>
          <circle cx="12" cy="13" r="4"/>
        </svg>
      ),
    },
  ].filter((tab) => tab.show);

  const openTab = (id) => {
    setRightPanelTab(id);
    setRightPanelOpen(true);
  };

  if (!rightRailVisible) return null;

  return (
    <div className={`viewer-side-rail viewer-side-rail-right ${rightPanelOpen ? 'is-open' : 'is-closed'}`}>
      <button
        type="button"
        onClick={() => setRightRailVisible(false)}
        className="viewer-rail-chevron"
        title="Hide icon bar"
        aria-label="Hide icon bar"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4">
          <polyline points="9 18 15 12 9 6" />
        </svg>
      </button>
      <div className="viewer-rail-divider" aria-hidden="true" />
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          onClick={() => openTab(tab.id)}
          className={`viewer-rail-btn ${rightPanelTab === tab.id && rightPanelOpen ? 'active' : ''}`}
          title={tab.title}
          aria-pressed={rightPanelTab === tab.id && rightPanelOpen}
        >
          {tab.icon}
          {tab.badge ? <span className="viewer-rail-badge">{tab.badge}</span> : null}
        </button>
      ))}
      <div className="viewer-rail-divider" aria-hidden="true" />
      <button
        type="button"
        onClick={() => setAutoCollapseViewerPanels(!autoCollapseViewerPanels)}
        className={`viewer-rail-pref ${autoCollapseViewerPanels ? 'active' : ''}`}
        title={autoCollapseViewerPanels ? 'Auto-collapse after slide switch: on' : 'Auto-collapse after slide switch: off'}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          {autoCollapseViewerPanels ? (
            <>
              <path d="M12 17v5"/>
              <path d="M9 12l3 5 3-5"/>
              <path d="M5 7h14"/>
            </>
          ) : (
            <>
              <path d="M12 7V2"/>
              <path d="M9 12l3-5 3 5"/>
              <path d="M5 17h14"/>
            </>
          )}
        </svg>
      </button>
    </div>
  );
}

export default function ViewerApp() {
  return (
    <div className="app-shell">
      <Header showBack />
      <div className="app-main">
        <LeftSidebar />
        <LeftRail />
        <ViewerPanel />
        <RightRail />
        <RightPanel />
      </div>
    </div>
  );
}
