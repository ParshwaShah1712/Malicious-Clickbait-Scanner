// Content script: extract clickable labels, call backend, and display results panel

(function () {
  const DEFAULT_API = 'http://127.0.0.1:5000/predict_batch';
  let panelInjected = false;

  // Listen for scan requests from background (triggered by popup)
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === 'CONTENT_SCAN_REQUEST') {
      runScan().catch(err => {
        console.error('Scan error:', err);
      });
      sendResponse({ ok: true });
    }
    return true; // Keep message channel open for async response
  });

  async function runScan() {
    try {
      const apiUrl = await getApiBase();
      const texts = collectButtonTexts();
      injectPanel();
      renderPanelLoading(texts.length);
      if (texts.length === 0) {
        renderPanelResults([], [], 'No clickable labels found');
        return;
      }
      const results = await callApi(apiUrl, texts);
      renderPanelResults(texts, results);
      highlightMalicious(texts, results);
    } catch (err) {
      const errorMsg = err && err.message ? `API Error: ${err.message}` : 'API Error: Unable to connect to server. Make sure Flask is running at http://127.0.0.1:5000';
      renderPanelResults([], [], errorMsg);
      console.error('Scan error:', err);
    }
  }

  function collectButtonTexts() {
    const nodes = Array.from(document.querySelectorAll(
      'a, button, [role="button"], input[type="button"], input[type="submit"]'
    ));

    const getLabel = (el) => {
      let t = (el.innerText || '').trim();
      if (!t && (el.tagName === 'INPUT')) t = (el.value || '').trim();
      if (!t) t = (el.getAttribute('aria-label') || '').trim();
      if (!t) t = (el.getAttribute('title') || '').trim();
      return t;
    };

    const set = new Set();
    for (const el of nodes) {
      const label = getLabel(el);
      if (!label) continue;
      if (label.length < 2) continue;
      set.add(label);
    }
    return Array.from(set);
  }

  async function getApiBase() {
    return new Promise((resolve) => {
      chrome.storage.sync.get(['apiBase'], (res) => {
        let val = (res.apiBase || DEFAULT_API).trim();
        try {
          const url = new URL(val);
          if (!/\/predict_batch\/?$/.test(url.pathname)) {
            val = `${url.origin}${url.pathname.replace(/\/$/, '')}/predict_batch`;
          }
        } catch {}
        resolve(val);
      });
    });
  }

  async function callApi(apiUrl, texts) {
    const truncated = texts.slice(0, 250);
    const res = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: 'API_FETCH', apiUrl, texts: truncated }, (resp) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!resp || !resp.ok) {
          reject(new Error(resp && resp.error ? resp.error : 'Unknown error'));
          return;
        }
        resolve(resp);
      });
    });
    return res.results;
  }

  function injectPanel() {
    // Remove existing panel if it exists
    const existingPanel = document.getElementById('clickbait-panel');
    const existingStyle = document.querySelector('style[data-clickbait-panel]');
    if (existingPanel) existingPanel.remove();
    if (existingStyle) existingStyle.remove();
    
    panelInjected = true;
    const panel = document.createElement('div');
    panel.id = 'clickbait-panel';
    panel.innerHTML = `
      <div class="cb-panel-header">
        <span>Clickbait Scanner</span>
        <button id="cb-panel-close" aria-label="Close">✕</button>
      </div>
      <div id="cb-panel-body">Scanning...</div>
    `;
    const style = document.createElement('style');
    style.setAttribute('data-clickbait-panel', 'true');
    style.textContent = `
      #clickbait-panel { position: fixed; top: 10px; right: 10px; z-index: 2147483647; width: 320px; max-height: 60vh; overflow: auto; background: rgba(255,255,255,0.95); backdrop-filter: blur(4px); border-radius: 12px; box-shadow: 0 8px 24px rgba(0,0,0,0.15); font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial; color: #222; }
      #clickbait-panel * { box-sizing: border-box; }
      .cb-panel-header { position: sticky; top: 0; display: flex; align-items: center; justify-content: space-between; padding: 10px 12px; font-weight: 600; background: rgba(255,255,255,0.9); border-bottom: 1px solid #eee; border-top-left-radius: 12px; border-top-right-radius: 12px; }
      #cb-panel-close { border: none; background: transparent; font-size: 16px; cursor: pointer; line-height: 1; padding: 4px 6px; }
      #cb-panel-close:hover { background: rgba(0,0,0,0.05); border-radius: 4px; }
      #cb-panel-body { padding: 10px 12px; }
      .cb-row { display: flex; align-items: center; gap: 8px; padding: 6px 0; border-bottom: 1px solid #f2f2f2; }
      .cb-text { flex: 1; word-break: break-word; font-size: 13px; }
      .cb-badge { font-size: 12px; font-weight: 700; padding: 2px 8px; border-radius: 10px; }
      .cb-safe { background: #e8f5e9; color: #2e7d32; border: 1px solid #c8e6c9; }
      .cb-mal { background: #ffebee; color: #c62828; border: 1px solid #ffcdd2; }
      .cb-note { color: #666; font-size: 12px; margin-top: 6px; }
    `;
    document.head.appendChild(style);
    document.body.appendChild(panel);
    panel.querySelector('#cb-panel-close')?.addEventListener('click', () => {
      panel.remove();
      style.remove();
      panelInjected = false;
    });
  }

  function renderPanelLoading(count) {
    const body = document.getElementById('cb-panel-body');
    if (!body) return;
    body.textContent = `Found ${count} items. Classifying...`;
  }

  function renderPanelResults(texts, results, errorMsg) {
    const body = document.getElementById('cb-panel-body');
    if (!body) return;
    if (errorMsg) {
      body.innerHTML = `<div class="cb-note">${escapeHtml(String(errorMsg))}</div>`;
      return;
    }
    const rows = texts.map((t, i) => {
      const r = (results?.[i] || 'Unknown');
      const cls = r === 'Malicious' ? 'cb-mal' : 'cb-safe';
      return `<div class="cb-row"><div class="cb-text">${escapeHtml(t)}</div><span class="cb-badge ${cls}">${r}</span></div>`;
    });
    body.innerHTML = rows.join('') + '<div class="cb-note">Only button texts are sent to the API.</div>';
  }

  function highlightMalicious(texts, results) {
    const malSet = new Set(texts.filter((_, i) => results?.[i] === 'Malicious'));
    if (malSet.size === 0) return;
    const nodes = Array.from(document.querySelectorAll('a, button, [role="button"], input[type="button"], input[type="submit"]'));
    const getLabel = (el) => (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('title') || '').trim();
    for (const el of nodes) {
      const label = getLabel(el);
      if (malSet.has(label)) {
        el.style.outline = '2px solid #c62828';
        el.style.outlineOffset = '2px';
      }
    }
  }

  function escapeHtml(s) {
    if (typeof s !== 'string') s = String(s);
    const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    return s.replace(/[&<>"']/g, (c) => map[c] || c);
  }
})();


