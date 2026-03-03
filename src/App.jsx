// src/App.jsx
import React, { useEffect } from 'react';
import { useStore } from './store/index.js';
import LoginModal from './components/layout/LoginModal.jsx';
import Dashboard from './components/dashboard/Dashboard.jsx';
import WorklistPage from './components/worklist/WorklistPage.jsx';
import ViewerApp from './components/ViewerApp.jsx';
import CompareViewer from './components/viewer/CompareViewer.jsx';

export default function App() {
  const { token, currentPage, theme } = useStore();

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  if (!token) return <LoginModal />;
  if (currentPage === 'dashboard') return <Dashboard />;
  if (currentPage === 'worklist') return <WorklistPage />;
  if (currentPage === 'compare')  return <CompareViewer />;
  return <ViewerApp />;
}
