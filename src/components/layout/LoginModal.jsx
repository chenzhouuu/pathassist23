// src/components/layout/LoginModal.jsx
import React, { useState } from 'react';
import { useStore } from '../../store/index.js';
import { login, getMyGroups } from '../../api/index.js';
import ThemeSwitcher from '../ThemeSwitcher.jsx';
import AppLogo from './AppLogo.jsx';
import { APP_NAME } from '../../config/branding.js';
import { KEYCLOAK_OAUTH_PROVIDERS_URL } from '../../config/girder.js';

export default function LoginModal() {
  const { setAuth, setUserGroups } = useStore();
  const [form, setForm] = useState({ username: '', password: '' });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [ssoLoading, setSsoLoading] = useState(false);

  const handleKeycloakSSO = async () => {
    setSsoLoading(true);
    try {
      const redirect = window.location.href;
      const res = await fetch(
        `${KEYCLOAK_OAUTH_PROVIDERS_URL}?redirect=${encodeURIComponent(redirect)}`
      );
      const data = await res.json();
      // Girder v5 returns { "Keycloak": "<auth_url_with_state>" }
      const url = data?.Keycloak || data?.keycloak;
      if (!url) throw new Error('Keycloak provider not available');
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

  // Allow direct token entry for dev/testing
  const [tokenMode, setTokenMode] = useState(false);
  const [directToken, setDirectToken] = useState('');
  const handleTokenLogin = () => {
    if (directToken.trim()) {
      setAuth(directToken.trim(), { login: 'token-user', firstName: 'Token', lastName: 'User' });
    }
  };

  return (
    <div className="login-overlay">
      <div className="login-card">
        {/* Logo / title */}
        <div className="flex items-center gap-3 mb-6">
          <div className="w-12 h-12 rounded-lg flex items-center justify-center overflow-hidden"
            style={{ background: 'rgba(77,166,255,0.1)', border: '1px solid rgba(77,166,255,0.25)' }}>
            <AppLogo className="h-9 w-auto object-contain" />
          </div>
          <div>
            <div className="font-semibold text-white text-sm">{APP_NAME}</div>
             
          </div>
        </div>

        {/* Keycloak SSO button — calls Girder v5 /oauth/provider to get state-embedded URL */}
        {KEYCLOAK_OAUTH_PROVIDERS_URL && (
          <>
            <button
              type="button"
              onClick={handleKeycloakSSO}
              disabled={ssoLoading}
              className="btn-primary w-full justify-center flex items-center gap-2 py-2 mb-3"
              style={{ background: 'linear-gradient(135deg, #4da6ff22, #7c3aed33)', border: '1px solid rgba(77,166,255,0.35)', color: 'var(--accent)' }}
            >
              {ssoLoading
                ? <div className="spinner w-3.5 h-3.5" />
                : <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <circle cx="12" cy="12" r="10"/><path d="M12 8v4l3 3"/>
                  </svg>
              }
              {ssoLoading ? 'Redirecting...' : 'Sign in with Keycloak (SSO)'}
            </button>
            <div className="flex items-center gap-2 mb-3">
              <div className="flex-1 h-px" style={{ background: 'var(--border)' }} />
              <span className="text-xs" style={{ color: 'var(--muted)' }}>or</span>
              <div className="flex-1 h-px" style={{ background: 'var(--border)' }} />
            </div>
          </>
        )}

        {!tokenMode ? (
          <form onSubmit={handleSubmit}>
            <div className="mb-3">
              <label className="block text-xs text-gray-500 mb-1.5">Username</label>
              <input
                className="login-input"
                type="text"
                placeholder="username"
                value={form.username}
                onChange={(e) => setForm({ ...form, username: e.target.value })}
                autoFocus
              />
            </div>
            <div className="mb-4">
              <label className="block text-xs text-gray-500 mb-1.5">Password</label>
              <input
                className="login-input"
                type="password"
                placeholder="********"
                value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
              />
            </div>
            {error && (
              <div className="text-xs text-red-400 mb-3 px-2 py-2 rounded"
                style={{ background: 'rgba(233,69,96,0.1)', border: '1px solid rgba(233,69,96,0.2)' }}>
                {error}
              </div>
            )}
            <button type="submit" className="btn-primary w-full justify-center flex items-center gap-2 py-2" disabled={loading}>
              {loading && <div className="spinner w-3.5 h-3.5" />}
              {loading ? 'Signing in...' : 'Sign In'}
            </button>
            <div className="mt-3 text-center">
              <button type="button" onClick={() => setTokenMode(true)}
                className="text-xs text-gray-500 hover:text-gray-300 transition-colors">
                Use API token instead
              </button>
            </div>
          </form>
        ) : (
          <div>
            <label className="block text-xs text-gray-500 mb-1.5">Girder API Token</label>
            <input
              className="login-input mb-3"
              type="text"
              placeholder="Paste your Girder token here"
              value={directToken}
              onChange={(e) => setDirectToken(e.target.value)}
              autoFocus
            />
            <button onClick={handleTokenLogin} className="btn-primary w-full justify-center flex py-2">
              Connect with Token
            </button>
            <div className="mt-3 text-center">
              <button onClick={() => setTokenMode(false)}
                className="text-xs text-gray-500 hover:text-gray-300 transition-colors">
                Back to username login
              </button>
            </div>
          </div>
        )}

        <div className="mt-5 pt-4 border-t flex items-center justify-end" style={{ borderColor: 'var(--border)' }}>
          <ThemeSwitcher />
        </div>
      </div>
    </div>
  );
}
