// Registers the service worker (installable app + offline app shell). Kept as its own file,
// not an inline <script>, so the Content-Security-Policy can forbid inline scripts entirely.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js'));
}
