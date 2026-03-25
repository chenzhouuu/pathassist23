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
import PatientPortalPage from './components/patient/PatientPortalPage.jsx';
import ReferringPortalPage from './components/referring/ReferringPortalPage.jsx';

export default function App() {
  const { token, currentPage, theme, setAuth, setUserGroups, hasRole, user, setPage } = useStore();

  // Patient share links use URL hash — no auth required.
  // Must check before any auth gating.
  const hash = typeof window !== 'undefined' ? window.location.hash : '';
  const search = typeof window !== 'undefined' ? window.location.search : '';
  const isPatientView = hash.startsWith('#/patient/');
  const isSharedImageView = hash.startsWith('#/shared-image/');
  const isCompareWindow = new URLSearchParams(search).get('compare') === '1';

  // Handle Keycloak OAuth callback: Girder appends ?girderToken=TOKEN after SSO.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const oauthToken = params.get('girderToken');
    if (!oauthToken) return;
    // Remove token from URL immediately so it isn't bookmarked or leaked in logs.
    window.history.replaceState({}, '', window.location.pathname + window.location.hash);
    (async () => {
      try {
        localStorage.setItem('girderToken', oauthToken); // must set before getMe() so interceptor uses it
        // Girder can return null for /user/me immediately after token creation
        // (token not yet committed / visible). Retry with backoff before giving up.
        let user = await getMe();
        if (!user) { await new Promise(r => setTimeout(r, 800));  user = await getMe(); }
        if (!user) { await new Promise(r => setTimeout(r, 1500)); user = await getMe(); }
        if (!user) { await new Promise(r => setTimeout(r, 3000)); user = await getMe(); }
        if (!user) throw new Error('getMe returned null after retries');
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

  useEffect(() => {
    if (!token || !user || isPatientView || isSharedImageView || isCompareWindow) return;
    const shouldLandOnCases = !user.admin && hasRole('second-opinion-users') && !hasRole('import-users');
    if (shouldLandOnCases && currentPage === 'dashboard') {
      setPage('second-opinion');
    }
  }, [token, user, currentPage, hasRole, setPage, isPatientView, isSharedImageView, isCompareWindow]);

  if (isPatientView) {
    return <PatientViewer encodedData={hash.slice('#/patient/'.length)} />;
  }

  if (isSharedImageView) {
    return <SingleImageViewer encodedData={hash.slice('#/shared-image/'.length)} />;
  }

  if (!token) return <LoginModal />;
  if (isCompareWindow) return <CompareViewer />;
  // Role-isolated portals — only for non-admin users who have NO clinical roles.
  // A user with both 'patient' and 'pathologist' groups is a clinical user
  // who was accidentally placed in a portal group; treat them as clinical staff.
  const hasClinicalRole = hasRole('annotation-users') || hasRole('worklist-users') || hasRole('import-users');
  if (!user?.admin && !hasClinicalRole && hasRole('patient-portal-users'))   return <PatientPortalPage />;
  if (!user?.admin && !hasClinicalRole && hasRole('referring-portal-users')) return <ReferringPortalPage />;
  // All internal roles use page-based routing.
  if (currentPage === 'dashboard')       return <Dashboard />;
  if (currentPage === 'projects')        return <ProjectsPage />;
  if (currentPage === 'worklist')        return <WorklistPage />;
  if (currentPage === 'compare')         return <CompareViewer />;
  if (currentPage === 'second-opinion')  return <SecondOpinionPage />;
  return <ViewerApp />;
}
