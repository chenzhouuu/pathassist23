// src/App.jsx
import React from 'react';
import { useStore } from './store/index.js';
import LoginModal from './components/layout/LoginModal.jsx';
import Dashboard from './components/dashboard/Dashboard.jsx';
import WorklistPage from './components/worklist/WorklistPage.jsx';
import ViewerApp from './components/ViewerApp.jsx';

export default function App() {
  const { token, currentPage } = useStore();
  if (!token) return <LoginModal />;
  if (currentPage === 'dashboard') return <Dashboard />;
  if (currentPage === 'worklist') return <WorklistPage />;
  return <ViewerApp />;
}
