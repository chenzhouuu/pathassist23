// src/components/panels/RightPanel.jsx
import React, { useState, useRef, useCallback, useEffect } from 'react';
import { useStore } from '../../store/index.js';
import MetadataPanel from './MetadataPanel.jsx';
import AIPanel from './AIPanel.jsx';
import PanelsPanel from './PanelsPanel.jsx';
import AnalysisPanel from './AnalysisPanel.jsx';
import PathChatPanel from './PathChatPanel.jsx';
import CopilotPanel from './CopilotPanel.jsx';
import PreprocessPanel from './PreprocessPanel.jsx';

const MIN_W = 248;
const MAX_W = 780;
const DEFAULT_W = 248;

export default function RightPanel() {
  const {
    rightPanelOpen, rightPanelTab, rightRailVisible, setRightPanelTab,
    toggleRightRail, panels, hasRole,
  } = useStore();
  const [panelW, setPanelW] = useState(DEFAULT_W);
  const dragRef = useRef(null);

  useEffect(() => {
    document.documentElement.style.setProperty('--right-w', `${panelW}px`);
  }, [panelW]);

  const onDragStart = useCallback((e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX;
    const startW = panelW;
    const onMove = (ev) => {
      const newW = Math.min(MAX_W, Math.max(MIN_W, startW - (ev.clientX - startX)));
      setPanelW(newW);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.body.style.cursor = 'ew-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [panelW]);

  if (!rightPanelOpen) return null;

  const allTabs = [
    { id:'metadata',    label:'Info',   show: true, icon:
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/>
        <line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>
      </svg> },
    { id:'ai',          label:'AI',     show: hasRole('ai-users'), icon:
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
      </svg> },
    { id:'analysis',    label:'Analysis', show: hasRole('ai-users'), icon:
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M3 3v18h18"/><path d="M7 14l4-4 3 3 5-6"/>
      </svg> },
    { id:'chat',        label:'AskPA', show: hasRole('ai-users'), icon:
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
      </svg> },
    { id:'copilot',     label:'Copilot', show: hasRole('ai-users'), icon:
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8z"/>
      </svg> },
    { id:'preprocess',  label:'Preprocess', show: hasRole('ai-users'), icon:
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/>
        <rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>
      </svg> },
    { id:'panels',      label:'Panels', show: true, badge: panels.length || null, icon:
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/>
        <circle cx="12" cy="13" r="4"/>
      </svg> },
  ];
  const tabs = allTabs.filter((t) => t.show);
  const activeLabel = tabs.find((t) => t.id === rightPanelTab)?.label || 'Info';

  return (
    <div className="app-sidepanel app-sidepanel-right" style={{ width: panelW, position: 'relative' }}>
      {/* Left-edge drag handle */}
      <div
        ref={dragRef}
        onMouseDown={onDragStart}
        title="Drag to resize panel"
        className="viewer-panel-resize-handle"
      />
      <div className="viewer-panel-topbar">
        <div>
          <div className="viewer-panel-eyebrow">Workspace Panel</div>
          <div className="viewer-panel-title">{activeLabel}</div>
        </div>
        <button
          type="button"
          className="viewer-panel-collapse-btn"
          onClick={toggleRightRail}
          title={rightRailVisible ? 'Hide icon bar' : 'Show icon bar'}
          aria-label={rightRailVisible ? 'Hide icon bar' : 'Show icon bar'}
          aria-pressed={rightRailVisible}
        >
          {rightRailVisible ? (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
              <rect x="4" y="3" width="6" height="18" rx="1.5" />
              <path d="M14 8h6M14 12h6M14 16h6" />
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
              <rect x="4" y="3" width="6" height="18" rx="1.5" />
              <polyline points="14 8 18 12 14 16" />
            </svg>
          )}
        </button>
      </div>
      <div className="tab-bar shrink-0 viewer-right-tabs" style={{ display:'flex', borderBottom:'1px solid var(--border)' }}>
        {tabs.map(t => (
          <button key={t.id}
            title={t.label}
            className={`tab viewer-right-tab flex items-center gap-1 ${rightPanelTab === t.id ? 'active' : ''}`}
            onClick={() => setRightPanelTab(t.id)}
            style={{ flex:1, justifyContent:'center', minWidth:0 }}>
            {t.icon}
            <span style={{ fontSize:10, letterSpacing:'0.01em' }}>{t.label}</span>
            {t.badge ? (
              <span style={{ fontSize:8, fontWeight:700, padding:'0px 3px', borderRadius:8,
                background:'rgba(124,58,237,0.25)', color:'#7c3aed', border:'1px solid rgba(124,58,237,0.4)', lineHeight:'14px' }}>
                {t.badge}
              </span>
            ) : null}
          </button>
        ))}
      </div>
      <div className="flex-1 overflow-hidden flex flex-col">
        {rightPanelTab === 'metadata'    && <MetadataPanel/>}
        {rightPanelTab === 'panels'      && <PanelsPanel/>}
        {rightPanelTab === 'ai'          && <AIPanel/>}
        {rightPanelTab === 'analysis'    && <AnalysisPanel/>}
        {rightPanelTab === 'chat'        && <PathChatPanel/>}
        {rightPanelTab === 'copilot'     && <CopilotPanel/>}
        {rightPanelTab === 'preprocess'  && <PreprocessPanel/>}
      </div>
    </div>
  );
}
