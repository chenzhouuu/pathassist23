// src/api/client.js
import axios from 'axios';
import { GIRDER_BASE } from '../config/girder.js';

const client = axios.create({
  baseURL: GIRDER_BASE,
  timeout: 30000,
});

// Attach Girder-Token from localStorage on every request
client.interceptors.request.use((config) => {
  const token = localStorage.getItem('girderToken');
  if (token) {
    config.headers['Girder-Token'] = token;
  }
  return config;
});

// Handle 401 — clear token and redirect to login
client.interceptors.response.use(
  (res) => res,
  (err) => {
    if (err.response?.status === 401) {
      localStorage.removeItem('girderToken');
      localStorage.removeItem('girderUser');
      window.location.reload();
    }
    return Promise.reject(err);
  }
);

export default client;
