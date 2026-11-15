// First-run consent. Nothing is recorded until this page's "Start
// recording" sets settings.consentedAt; the service worker drops every
// snapshot until then.

const $ = id => document.getElementById(id);

async function getSettings() {
  return (await chrome.storage.local.get('settings')).settings || {};
}

async function render() {
  const { consentedAt } = await getSettings();
  $('start').hidden = !!consentedAt;
  $('started').hidden = !consentedAt;
  if (consentedAt) {
    $('started-at').textContent = new Date(consentedAt).toLocaleString(undefined, {
      month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
    });
  }
}

$('start').onclick = async () => {
  // Merge, so the EEO setting (if any) survives.
  await chrome.storage.local.set({ settings: { ...(await getSettings()), consentedAt: new Date().toISOString() } });
  render();
};

render();
