// The tab bar (Inc 5 · 01). Adding a tab is the kind of change that silently drops another one —
// the list is a single literal — so this asserts the whole bar, not just the new entry, and that
// picking the new tab mounts its panel while an existing tab still mounts its own.
import React from 'react';
import { render as rtlRender, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, beforeEach } from 'vitest';

import RightPanel from './RightPanel.jsx';
import { useStore } from '../../store/index.js';

// Info is the default tab and it fetches through TanStack Query, so the bar cannot be rendered
// without a client. Retries off so a failed fetch fails the test instead of hanging it.
const render = () => rtlRender(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <RightPanel />
  </QueryClientProvider>,
);

// An admin sees every ai-users tab; that is the widest bar the app draws.
const AS_ADMIN = { user: { _id: 'u1', login: 'dev', admin: true }, userGroups: [] };

// Nuclei left in Inc 6 · 05: the run is a Girder job started from Analysis and watched in Runs,
// and everything the tab used to show about the artifact opens on its Workspace row.
const EXPECTED_TABS = [
  'Workspace', 'Info', 'AI', 'Analysis', 'AskPA', 'Copilot', 'Preprocess',
  'Markers', 'Tissue', 'Task', 'Panels',
];

describe('RightPanel tab bar', () => {
  beforeEach(() => {
    useStore.setState({
      ...AS_ADMIN, rightPanelOpen: true, rightPanelTab: null, activeItem: null, panels: [],
      visibleArtifacts: {},
    });
  });

  it('draws every tab, in order, with Workspace among them', () => {
    render();
    const labels = screen.getAllByRole('button')
      .map((b) => b.textContent.trim())
      .filter((t) => EXPECTED_TABS.includes(t));
    expect(labels).toEqual(EXPECTED_TABS);
  });

  it('lands an ai-user on the Workspace without their having picked it', () => {
    render();
    expect(useStore.getState().rightPanelTab).toBe(null);   // nothing pinned
    expect(screen.getByRole('button', { name: 'Workspace' })).toHaveClass('active');
  });

  it('lands everyone else on Info', () => {
    useStore.setState({ user: { _id: 'u2', login: 'viewer', admin: false }, userGroups: [] });
    render();
    expect(screen.getByRole('button', { name: 'Info' })).toHaveClass('active');
  });

  it('switches panels when a tab is picked, and pins the choice', async () => {
    render();
    useStore.setState({ activeItem: { _id: 'item-1', name: 'slide.svs' } });
    expect(await screen.findByText('Artifacts')).toBeInTheDocument();    // Workspace, the landing tab

    await userEvent.click(screen.getByRole('button', { name: 'Panels' }));
    expect(useStore.getState().rightPanelTab).toBe('panels');
    expect(screen.queryByText('Artifacts')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Workspace' }));
    expect(useStore.getState().rightPanelTab).toBe('workspace');
    expect(await screen.findByText('Artifacts')).toBeInTheDocument();
  });

  it('hides the ai-users tabs from a user without the role', () => {
    useStore.setState({ user: { _id: 'u2', login: 'viewer', admin: false }, userGroups: [] });
    render();
    expect(screen.queryByRole('button', { name: 'Workspace' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Info' })).toBeInTheDocument();
  });
});
