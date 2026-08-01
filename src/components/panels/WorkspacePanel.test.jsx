// The Workspace shell (Inc 5 · 01). What is worth asserting here is not the copy — it is that a
// vendored OHIF .tsx renders inside this .jsx app at all, and that its Radix accordion is wired
// well enough to collapse. That is the whole claim of ticket 01.
import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, beforeEach } from 'vitest';

import WorkspacePanel from './WorkspacePanel.jsx';
import { useStore } from '../../store/index.js';

describe('WorkspacePanel', () => {
  beforeEach(() => useStore.setState({ activeItem: null }));

  it('asks for a slide before showing a section', () => {
    render(<WorkspacePanel />);
    expect(screen.getByText('No slide selected')).toBeInTheDocument();
    expect(screen.queryByText('Artifacts')).not.toBeInTheDocument();
  });

  it('renders the vendored section for the open slide', () => {
    useStore.setState({ activeItem: { _id: 'item-1', name: 'slide.svs' } });
    render(<WorkspacePanel />);
    expect(screen.getByText('Artifacts')).toBeInTheDocument();
    expect(screen.getByText(/artifacts will be listed here/i)).toBeInTheDocument();
  });

  it('collapses the section when its header is clicked', async () => {
    useStore.setState({ activeItem: { _id: 'item-1', name: 'slide.svs' } });
    render(<WorkspacePanel />);

    const header = screen.getByRole('button', { name: /artifacts/i });
    expect(header).toHaveAttribute('data-state', 'open');

    await userEvent.click(header);
    expect(header).toHaveAttribute('data-state', 'closed');
  });
});
