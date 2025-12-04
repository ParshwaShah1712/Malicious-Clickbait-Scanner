// Background service worker: relays messages between popup and content script

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'POPUP_SCAN_REQUEST') {
    // Send a message to the active tab's content script to start scanning
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tabId = tabs[0]?.id;
      if (tabId) {
        chrome.tabs.sendMessage(tabId, { type: 'CONTENT_SCAN_REQUEST' }, (response) => {
          if (chrome.runtime.lastError) {
            console.error('Error sending message to content script:', chrome.runtime.lastError);
          }
        });
      }
    });
    sendResponse({ ok: true });
    return true;
  }

  if (message?.type === 'API_FETCH') {
    const { apiUrl, texts } = message;
    (async () => {
      try {
        const resp = await fetch(apiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ links: Array.isArray(texts) ? texts : [] })
        });
        const text = await resp.text();
        if (!resp.ok) {
          sendResponse({ ok: false, error: `HTTP ${resp.status} ${resp.statusText} | ${text}` });
          return;
        }
        let data;
        try { data = JSON.parse(text); } catch { data = null; }
        if (!data || !Array.isArray(data.results)) {
          sendResponse({ ok: false, error: 'Bad API response' });
          return;
        }
        sendResponse({ ok: true, results: data.results });
      } catch (e) {
        sendResponse({ ok: false, error: `Network error: ${e && e.message ? e.message : e}` });
      }
    })();
    return true; // keep the message channel open for async sendResponse
  }
});

