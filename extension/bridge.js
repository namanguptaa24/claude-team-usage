// Isolated-world content script: relays messages from inject.js to the service worker.
(function () {
  'use strict';
  window.addEventListener('message', (e) => {
    if (e.source !== window || e.origin !== location.origin) return;
    const d = e.data;
    if (!d || d.__ctu !== 1 || (d.type !== 'message' && d.type !== 'snapshot')) return;
    try {
      chrome.runtime.sendMessage({ kind: 'ctu', type: d.type, payload: d.payload }).catch(() => {});
    } catch { /* extension was reloaded; the page needs a refresh */ }
  });
})();
