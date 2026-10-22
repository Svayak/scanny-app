// Minimalt service worker — krävs för att Chrome ska erbjuda
// "Lägg till på startskärmen" / installera Scanny.
// Ingen cache: API-data och sidor hämtas alltid från nätverket.
self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', () => {
  // Avsiktligt tom. respondWith skulle lägga sig i vägen för /api-anrop
  // och en cache får inte spara lagerdata eller tokens.
});
