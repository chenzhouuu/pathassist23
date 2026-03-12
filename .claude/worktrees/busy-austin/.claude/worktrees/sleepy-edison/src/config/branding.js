// src/config/branding.js
// Override via .env (or .env.local):
//
//   VITE_APP_NAME=AlgoPath
//   VITE_LOGO_SRC=/alogopath-logo.png
//   VITE_APP_TAGLINE=Pathology AI Platform
//
// Defaults to IMPART DX.

export const APP_NAME    = import.meta.env.VITE_APP_NAME    || 'Impart DX';
export const LOGO_SRC    = import.meta.env.VITE_LOGO_SRC    || '/impart-dx-logo.svg';
export const APP_TAGLINE = import.meta.env.VITE_APP_TAGLINE || 'Digital Pathology Platform';
