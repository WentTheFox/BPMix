import { useEffect, useState } from 'react';

/** True once the page is running as an installed PWA (standalone window, no browser chrome) - this is what actually unlocks Chrome's persistent File System Access permissions, not just having a manifest/service worker registered. */
export function isRunningInstalled(): boolean {
  if (typeof window === 'undefined') return false;
  if (window.matchMedia?.('(display-mode: standalone)').matches) return true;
  // iOS Safari's legacy flag - harmless to also check even though iOS has no
  // File System Access API at all and isn't what this is solving for.
  if ((navigator as unknown as { standalone?: boolean }).standalone === true) return true;
  return false;
}

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
}

let deferredPrompt: BeforeInstallPromptEvent | null = null;

if (typeof window !== 'undefined') {
  // Fires only once Chrome's own installability heuristics pass (manifest +
  // service worker + HTTPS/localhost) - stashed here so a later click on the
  // onboarding step's "Install" button can call .prompt() on it, since (like
  // requestPermission()) that call also needs to happen close to a real
  // gesture.
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferredPrompt = event as BeforeInstallPromptEvent;
  });
}

/** Null until Chrome has actually signaled this page is installable (see beforeinstallprompt above) - a caller should hide/disable its install button until this is available. */
export function getInstallPrompt(): BeforeInstallPromptEvent | null {
  return deferredPrompt;
}

/** Triggers the captured install prompt (a no-op if none is available yet) and clears it afterward - Chrome only lets each captured prompt be used once. */
export async function promptInstall(): Promise<void> {
  const prompt = deferredPrompt;
  if (!prompt) return;
  deferredPrompt = null;
  await prompt.prompt();
}

/** React-friendly wrapper: `available` flips true once Chrome actually signals installability (see beforeinstallprompt above), so a caller can hide its "Install" affordance until this fires rather than showing a button that does nothing yet. */
export function usePwaInstallAvailable(): boolean {
  const [available, setAvailable] = useState(getInstallPrompt() !== null);
  useEffect(() => {
    if (available) return;
    const handler = () => setAvailable(true);
    window.addEventListener('beforeinstallprompt', handler);
    return () => window.removeEventListener('beforeinstallprompt', handler);
  }, [available]);
  return available;
}
