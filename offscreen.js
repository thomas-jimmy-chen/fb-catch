// offscreen.js — 為 background SW 建立 blob URL（SW 不支援 URL.createObjectURL）
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action !== 'createBlobUrl') return false;
  try {
    const blob = new Blob([msg.content], { type: msg.mimeType || 'application/octet-stream' });
    const blobUrl = URL.createObjectURL(blob);
    sendResponse({ ok: true, blobUrl });
  } catch (e) {
    sendResponse({ ok: false, error: e.message });
  }
  return true;
});
