// src/App.jsx
import React, { useEffect } from 'react';
import { useStore } from './store/index.js';
import { getMe, getMyGroups } from './api/index.js';
import LoginModal from './components/layout/LoginModal.jsx';
import Dashboard from './components/dashboard/Dashboard.jsx';
import WorklistPage from './components/worklist/WorklistPage.jsx';
import ViewerApp from './components/ViewerApp.jsx';
import CompareViewer from './components/viewer/CompareViewer.jsx';
import ProjectsPage from './components/projects/ProjectsPage.jsx';
import PatientViewer from './components/share/PatientViewer.jsx';
import SingleImageViewer from './components/share/SingleImageViewer.jsx';
import SecondOpinionPage from './components/cases/SecondOpinionPage.jsx';

export default function App() {
  const { token, currentPage, theme, setAuth, setUserGroups } = useStore();

  // Patient share links use URL hash — no auth required.
  // Must check before any auth gating.
  const hash = typeof window !== 'undefined' ? window.location.hash : '';
  const isPatientView = hash.startsWith('#/patient/');
  const isSharedImageView = hash.startsWith('#/shared-image/');

  // Handle Keycloak OAuth callback: Girder appends ?girderToken=TOKEN after SSO.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const oauthToken = params.get('girderToken');
    if (!oauthToken) return;
    // Remove token from URL immediately so it isn't bookmarked or leaked in logs.
    window.history.replaceState({}, '', window.location.pathname + window.location.hash);
    (async () => {
      try {
        const user = await getMe();          // fetch full user profile with the new token
        setAuth(oauthToken, user);
        const groups = await getMyGroups(user._id);
        setUserGroups(groups);
      } catch (_) {
        // Token was invalid; fall through to show login modal.
      }
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!isPatientView) document.documentElement.dataset.theme = theme;
  }, [theme, isPatientView]);

  if (isPatientView) {
    return <PatientViewer encodedData={hash.slice('#/patient/'.length)} />;
  }

  if (isSharedImageView) {
    return <SingleImageViewer encodedData={hash.slice('#/shared-image/'.length)} />;
  }

  if (!token) return <LoginModal />;
  if (currentPage === 'dashboard') return <Dashboard />;
  if (currentPage === 'projects')  return <ProjectsPage />;
  if (currentPage === 'worklist') return <WorklistPage />;
  if (currentPage === 'compare')        return <CompareViewer />;
  if (currentPage === 'second-opinion') return <SecondOpinionPage />;
  return <ViewerApp />;
}
