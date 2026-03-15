// src/components/panels/RightPanel.jsx
import React from 'react';
import { useStore } from '../../store/index.js';
import MetadataPanel from './MetadataPanel.jsx';
import AnnotationsPanel from './AnnotationsPanel.jsx';
import AIPanel from './AIPanel.jsx';
import PanelsPanel from './PanelsPanel.jsx';

export default function RightPanel() {
  const { rightPanelOpen, rightPanelTab, setRightPanelTab, panels } = useStore();
  if (!rightPanelOpen) return null;

  const tabs = [
    { id:'metadata',    label:'Metadata', icon:
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/>
        <line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>
      </svg> },
    { id:'annotations', label:'Annotations', icon:
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>
      </svg> },
    { id:'panels',      label:'Panels', badge: panels.length || null, icon:
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/>
        <circle cx="12" cy="13" r="4"/>
      </svg> },
    { id:'ai',          label:'AI', icon:
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
      </svg> },
  ];

  return (
    <div className="app-sidepanel app-sidepanel-right" style={{ width:'var(--right-w)' }}>
      <div className="tab-bar shrink-0">
        {tabs.map(t => (
          <button key={t.id} className={`tab flex items-center gap-1 ${rightPanelTab === t.id ? 'active' : ''}`}
            onClick={() => setRightPanelTab(t.id)}>
            {t.icon}{t.label}
            {t.badge ? (
              <span style={{ fontSize:8, fontWeight:700, padding:'0px 4px', borderRadius:8,
                background:'rgba(124,58,237,0.25)', color:'#7c3aed', border:'1px solid rgba(124,58,237,0.4)', lineHeight:'14px' }}>
                {t.badge}
              </span>
            ) : null}
          </button>
        ))}
      </div>
      <div className="flex-1 overflow-hidden flex flex-col">
        {rightPanelTab === 'annotations' && <AnnotationsPanel/>}
        {rightPanelTab === 'metadata'    && <MetadataPanel/>}
        {rightPanelTab === 'panels'      && <PanelsPanel/>}
        {rightPanelTab === 'ai'          && <AIPanel/>}
      </div>
    </div>
  );
}
