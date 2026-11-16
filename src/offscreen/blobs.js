// Offscreen document: makes blob: URLs for the service worker, which has no
// URL.createObjectURL. src/lib/sink-downloads.js opens it only while files
// are being written, and closes it after.

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  // Every runtime message reaches every extension page, the popup's included.
  // Answer only the service worker's, addressed here; stay silent otherwise
  // so the worker's own answer to the popup is the one that arrives.
  if (msg?.target !== 'cc-offscreen' || sender.id !== chrome.runtime.id || sender.tab) return;
  if (msg.type === 'blob') {
    reply({ url: URL.createObjectURL(new Blob([msg.body], { type: msg.mime })) });
  } else if (msg.type === 'revoke') {
    URL.revokeObjectURL(msg.url);
    reply({ ok: true });
  }
});
