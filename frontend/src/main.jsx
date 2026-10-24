import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles.css';
import './view-styles.css';

// StrictMode is omitted in this data-heavy demo because development double-mount
// would trigger two simultaneous historical API loads on the first render.
createRoot(document.getElementById('root')).render(<App />);
