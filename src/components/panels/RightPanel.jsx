// src/components/panels/RightPanel.jsx
import React from 'react';
import { useStore } from '../../store/index.js';
import MetadataPanel from './MetadataPanel.jsx';
import AIPanel from './AIPanel.jsx';
import PanelsPanel from './PanelsPanel.jsx';
import AnalysisPanel from './AnalysisPanel.jsx';

export default function RightPanel() {
  const { rightPanelOpen, rightPanelTab, setRightPanelTab, panels, hasRole } = useStore();
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
    { id:'panels',      label:'Panels', show: true, badge: panels.length || null, icon:
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/>
        <circle cx="12" cy="13" r="4"/>
      </svg> },
  ];
  const tabs = allTabs.filter((t) => t.show);

  return (
    <div className="app-sidepanel app-sidepanel-right" style={{ width:'var(--right-w)' }}>
      <div className="viewer-panel-topbar">
        <div>
          <div className="viewer-panel-eyebrow">Workspace Panel</div>
          <div className="viewer-panel-title">{tabs.find((t) => t.id === rightPanelTab)?.label || 'Info'}</div>
        </div>
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
      </div>
    </div>
  );
}
