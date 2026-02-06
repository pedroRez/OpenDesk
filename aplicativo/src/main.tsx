import React from 'react';
import ReactDOM from 'react-dom/client';
import { GoogleOAuthProvider } from '@react-oauth/google';

import App from './App';
import './index.css';

const root = document.getElementById('root');
if (!root) {
  throw new Error('Root element not found');
}

const googleClientId = import.meta.env.VITE_GOOGLE_CLIENT_ID;

const app = (
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

ReactDOM.createRoot(root).render(
  googleClientId ? <GoogleOAuthProvider clientId={googleClientId}>{app}</GoogleOAuthProvider> : app,
);
