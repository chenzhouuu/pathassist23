// src/components/layout/LoginModal.jsx
import React, { useState } from 'react';
import { useStore } from '../../store/index.js';
import { login, getMyGroups } from '../../api/index.js';
import AppLogo from './AppLogo.jsx';
import { APP_NAME } from '../../config/branding.js';
import { KEYCLOAK_OAUTH_PROVIDERS_URL } from '../../config/girder.js';

export default function LoginModal() {
  const { setAuth, setUserGroups } = useStore();
  const [form, setForm] = useState({ username: '', password: '' });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [ssoLoading, setSsoLoading] = useState(false);
  const [tokenMode, setTokenMode] = useState(false);
  const [directToken, setDirectToken] = useState('');

  const updateField = (field, value) => {
    setError('');
    setForm((current) => ({ ...current, [field]: value }));
  };

  const handleKeycloakSSO = async () => {
    setError('');
    setSsoLoading(true);
    try {
      const redirect = window.location.href;
      const res = await fetch(
        `${KEYCLOAK_OAUTH_PROVIDERS_URL}?redirect=${encodeURIComponent(redirect)}`
      );
      if (!res.ok) {
        throw new Error(`Girder returned ${res.status} — check that the OAuth plugin is enabled.`);
      }
      const contentType = res.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) {
        throw new Error(`Expected JSON from Girder OAuth endpoint but got ${contentType || 'HTML'}. Is the server reachable?`);
      }
      const data = await res.json();
      // Girder v5 returns { "Keycloak": "<auth_url_with_state>" }
      const url = data?.Keycloak || data?.keycloak;
      if (!url) throw new Error('Keycloak provider not configured in Girder. Check OAuth plugin settings.');
      window.location.href = url;
    } catch (e) {
      setError('SSO unavailable: ' + (e.message || 'Unknown error'));
      setSsoLoading(false);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const data = await login(form.username, form.password);
      setAuth(data.authToken.token, data.user);
      // Fetch user's Girder groups to power role-based nav visibility.
      try {
        const groups = await getMyGroups(data.user._id);
        setUserGroups(groups);
      } catch (_) {
        setUserGroups([]);
      }
    } catch (err) {
      setError(err.response?.data?.message || 'Authentication failed. Check credentials.');
    } finally {
      setLoading(false);
    }
  };

  const handleTokenLogin = () => {
    const token = directToken.trim();
    if (!token) {
      setError('Enter a Girder API token before continuing.');
      return;
    }
    setError('');
    setAuth(token, { login: 'token-user', firstName: 'Token', lastName: 'User' });
  };

  return (
    <div className="login-overlay">
      <div className="login-card">
        <div className="login-brand">
          <div className="login-brand-mark">
            <AppLogo className="h-10 w-auto object-contain" />
          </div>
          <div className="login-brand-copy">
            <p className="login-eyebrow">Digital pathology workspace</p>
            <h1 className="login-title">{APP_NAME}</h1>
            <p className="login-subtitle">
              Sign in to review slides, annotations, and analysis from one interface.
            </p>
          </div>
        </div>

        <div className="login-mode-switch" role="tablist" aria-label="Authentication method">
          <button
            type="button"
            className={`login-mode-pill ${!tokenMode ? 'active' : ''}`}
            onClick={() => { setTokenMode(false); setError(''); }}
          >
            Username
          </button>
          <button
            type="button"
            className={`login-mode-pill ${tokenMode ? 'active' : ''}`}
            onClick={() => { setTokenMode(true); setError(''); }}
          >
            API Token
          </button>
        </div>

        {KEYCLOAK_OAUTH_PROVIDERS_URL && (
          <>
            <button
              type="button"
              onClick={handleKeycloakSSO}
              disabled={ssoLoading}
              className="login-sso-button"
            >
              {ssoLoading
                ? <div className="spinner w-3.5 h-3.5" />
                : <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M12 22C6.477 22 2 17.523 2 12S6.477 2 12 2s10 4.477 10 10-4.477 10-10 10z"/><path d="M8 12h8M12 8v8"/>
                  </svg>
              }
              {ssoLoading ? 'Redirecting...' : 'Sign in with SSO'}
            </button>
            <div className="login-divider">
              <div className="login-divider-line" />
              <span>or continue with credentials</span>
              <div className="login-divider-line" />
            </div>
          </>
        )}

        {error && (
          <div className="login-alert" role="alert">
            {error}
          </div>
        )}

        {!tokenMode ? (
          <form onSubmit={handleSubmit} className="login-form">
            <div className="login-field">
              <label className="login-label">Username</label>
              <input
                className="login-input"
                type="text"
                placeholder="username"
                value={form.username}
                onChange={(e) => updateField('username', e.target.value)}
                autoFocus
                autoComplete="username"
              />
            </div>
            <div className="login-field">
              <label className="login-label">Password</label>
              <input
                className="login-input"
                type="password"
                placeholder="********"
                value={form.password}
                onChange={(e) => updateField('password', e.target.value)}
                autoComplete="current-password"
              />
            </div>
            <button
              type="submit"
              className="btn-primary w-full justify-center flex items-center gap-2 py-2.5"
              disabled={loading || !form.username.trim() || !form.password}
            >
              {loading && <div className="spinner w-3.5 h-3.5" />}
              {loading ? 'Signing in...' : 'Sign In'}
            </button>
          </form>
        ) : (
          <div className="login-form">
            <div className="login-field">
              <label className="login-label">Girder API Token</label>
              <p className="login-help">Useful for local development, automation, or scoped service access.</p>
            </div>
            <input
              className="login-input"
              type="text"
              placeholder="Paste your Girder token here"
              value={directToken}
              onChange={(e) => { setError(''); setDirectToken(e.target.value); }}
              autoFocus
            />
            <button
              type="button"
              onClick={handleTokenLogin}
              className="btn-primary w-full justify-center flex py-2.5"
              disabled={!directToken.trim()}
            >
              Connect with Token
            </button>
          </div>
        )}

      </div>
    </div>
  );
}
