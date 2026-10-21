// Nome e versão do cache (mude a versão se quiser forçar uma atualização)
const CACHE_NAME = 'auditoria-tacaruna-v5';

// Lista de arquivos que serão guardados para funcionar offline
const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './style.css',
  './script.js',
  './firebase-config.js'
];

// Evento de instalação: guarda os arquivos no cache
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('Abrindo cache e salvando arquivos...');
      return cache.addAll(ASSETS_TO_CACHE);
    })
  );
});

// Evento de ativação: limpa caches antigos
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME) {
            console.log('Removendo cache antigo:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
});

// Evento de fetch: serve os arquivos do cache (offline) ou da rede
self.addEventListener('fetch', (event) => {
  event.respondWith(
    caches.match(event.request).then((response) => {
      // Retorna do cache se existir, senão busca na rede
      return response || fetch(event.request);
    })
  );
});