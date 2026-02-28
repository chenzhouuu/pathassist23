// src/components/panels/RightPanel.jsx
import React from 'react';
import { useStore } from '../../store/index.js';
import MetadataPanel from './MetadataPanel.jsx';
import AnnotationsPanel from './AnnotationsPanel.jsx';
import AnalysisPanel from './AnalysisPanel.jsx';

export default function RightPanel() {
  const { rightPanelOpen, rightPanelTab, setRightPanelTab } = useStore();
  if (!rightPanelOpen) return null;

  const tabs = [
    { id: 'metadata', label: 'Metadata' },
    { id: 'annotations', label: 'Annotations' },
    { id: 'analysis', label: 'Analysis' },
  ];

  return (
    <div
      className="flex flex-col shrink-0 overflow-hidden"
      style={{
        width: 'var(--right-w)',
        background: 'var(--bg-panel)',
        borderLeft: '1px solid var(--border)',
      }}
    >
      <div className="tab-bar shrink-0">
        {tabs.map((t) => (
          <button
            key={t.id}
            className={`tab ${rightPanelTab === t.id ? 'active' : ''}`}
            onClick={() => setRightPanelTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto">
        {rightPanelTab === 'metadata' && <MetadataPanel />}
        {rightPanelTab === 'annotations' && <AnnotationsPanel />}
        {rightPanelTab === 'analysis' && <AnalysisPanel />}
      </div>
    </div>
  );
}
