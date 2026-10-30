/** Navigates this tab to an address - the web app's way into the server's own pages (sign-in, account) and back. */
export function navigateTo(url: string): void {
  window.location.assign(url);
}
