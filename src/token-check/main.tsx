import React from 'react';
import ReactDOM from 'react-dom/client';
import { TokenCheck } from './TokenCheck';
import '../styles/popup.css';
import '../styles/token-check.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <TokenCheck />
  </React.StrictMode>
);
