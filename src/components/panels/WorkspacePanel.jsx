// src/components/panels/WorkspacePanel.jsx — the per-slide artifact workspace (Inc 5).
//
// One place that lists every artifact a slide has, says what each one is in a line, switches its
// overlay on and off, and deletes it. This ticket (Inc 5 · 01) is the shell: the tab and the
// vendored OHIF section the list will be built out of. The rows arrive in ticket 02, bound to the
// slide's artifact table; the eye in 03; delete in 04.
//
// The panel itself is ordinary .jsx like every other panel — only the components it is assembled
// from are vendored TypeScript. That boundary is the point: OHIF's files stay a copy, and the app
// code that binds them to this repo's data stays ours.
import React from 'react';
import { useStore } from '../../store/index.js';
import { PanelSection } from '../workspace/vendor/ohif/PanelSection.tsx';

export default function WorkspacePanel() {
  const activeItem = useStore((s) => s.activeItem);

  if (!activeItem) {
    return (
      <div
        className="flex flex-col items-center justify-center h-48 text-xs gap-2"
        style={{ color: 'var(--muted-hex)' }}
      >
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
          <polygon points="12 2 2 7 12 12 22 7 12 2" />
          <polyline points="2 17 12 22 22 17" />
          <polyline points="2 12 12 17 22 12" />
        </svg>
        No slide selected
      </div>
    );
  }

  return (
    <div className="p-2">
      <PanelSection>
        <PanelSection.Header>
          <span>Artifacts</span>
        </PanelSection.Header>
        <PanelSection.Content>
          <div className="px-2.5 py-6 text-center text-xs" style={{ color: 'var(--muted-hex)' }}>
            This slide&apos;s artifacts will be listed here.
          </div>
        </PanelSection.Content>
      </PanelSection>
    </div>
  );
}
