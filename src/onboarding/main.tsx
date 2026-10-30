import React from 'react';
import ReactDOM from 'react-dom/client';
import { Onboarding } from './Onboarding';
import { ErrorBoundary } from '@popup/components/ErrorBoundary';
import '../styles/popup.css';
import '../styles/onboarding.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary
      fallback={(err, retry) => (
        <div className="error-boundary-fallback" role="alert">
          <h2>Onboarding failed to load</h2>
          <p className="error-boundary-message">{err.message}</p>
          <button type="button" onClick={retry}>
            Retry
          </button>
        </div>
      )}
    >
      <Onboarding />
    </ErrorBoundary>
  </React.StrictMode>
);
