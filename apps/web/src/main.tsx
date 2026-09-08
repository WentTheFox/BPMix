import { createRoot } from 'react-dom/client';
import App from './App';

const container = document.getElementById('root');
if (!container) {
  throw new Error('#root element not found');
}

createRoot(container).render(<App />);

// Registers the (deliberately no-op/passthrough) service worker at
// public/sw.js purely so Chrome treats this as an installable PWA - see
// that file's doc. Registration failure is swallowed: this is a nice-to-have
// for persistent File System Access permissions, never something that
// should surface as an app error.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}
