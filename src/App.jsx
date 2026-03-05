// src/App.jsx
import React, { useEffect } from 'react';
import { useStore } from './store/index.js';
import LoginModal from './components/layout/LoginModal.jsx';
import Dashboard from './components/dashboard/Dashboard.jsx';
import WorklistPage from './components/worklist/WorklistPage.jsx';
import ViewerApp from './components/ViewerApp.jsx';
import CompareViewer from './components/viewer/CompareViewer.jsx';
import ProjectsPage from './components/projects/ProjectsPage.jsx';
import PatientViewer from './components/share/PatientViewer.jsx';

export default function App() {
  const { token, currentPage, theme } = useStore();

  // Patient share links use URL hash — no auth required.
  // Must check before any auth gating.
  const hash = typeof window !== 'undefined' ? window.location.hash : '';
  const isPatientView = hash.startsWith('#/patient/');

  useEffect(() => {
    if (!isPatientView) document.documentElement.dataset.theme = theme;
  }, [theme, isPatientView]);

  if (isPatientView) {
    return <PatientViewer encodedData={hash.slice('#/patient/'.length)} />;
  }

  if (!token) return <LoginModal />;
  if (currentPage === 'dashboard') return <Dashboard />;
  if (currentPage === 'projects')  return <ProjectsPage />;
  if (currentPage === 'worklist') return <WorklistPage />;
  if (currentPage === 'compare')  return <CompareViewer />;
  return <ViewerApp />;
}
