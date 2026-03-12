// src/components/layout/AppLogo.jsx
// Single source of truth for the app logo.
// Logo and app name are controlled via .env:
//   VITE_LOGO_SRC=/alogopath-logo.png
//   VITE_APP_NAME=AlgoPath
import React from 'react';
import { LOGO_SRC, APP_NAME } from '../../config/branding.js';

export default function AppLogo({ className = 'h-8 md:h-9 w-auto object-contain' }) {
  return (
    <img src={LOGO_SRC} alt={APP_NAME} className={className} />
  );
}
