// Kept in the userscript scope: pairing credentials are never put into page storage.
(() => {
  'use strict';
  if (unsafeWindow.top !== unsafeWindow || location.origin !== 'https://b24.entgld.com') return;
  const api = unsafeWindow.__betterBitrixDesktop;
  if (!api || !navigator.locks) return;
  const clientId = crypto.randomUUID();
  let stopped = false, polling = false, executing = false, lastCalendar = 0;
  let pendingResults = [];
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  unsafeWindow.addEventListener('pagehide', () => { stopped = true; });
  function request(port, path, body, token = '') {
    if (!Number.isInteger(port) || port < 1024 || port > 65535) return Promise.reject(Error('Некорректный порт.'));
    return new Promise((resolve, reject) => GM_xmlhttpRequest({
      method: 'POST', url: `http://127.0.0.1:${port}${path}`, anonymous: true, timeout: 5000,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      data: JSON.stringify(body),
      onload: response => {
        if (response.status !== 200) return reject(Error(`Portable: ${response.status}`));
        try { resolve(JSON.parse(response.responseText)); } catch (error) { reject(error); }
      },
      ontimeout: () => reject(Error('Portable не отвечает.')),
      onerror: () => reject(Error('Portable недоступен.'))
    }));
  }
  async function pairFromHash() {
    const match = /^#betterbitrix-pair=(\d{4,5})\.([A-F0-9]{48})$/.exec(location.hash);
    if (!match) return;
    const port = Number(match[1]), nonce = match[2];
    // Remove only our own fragment. Do not leave even the short-lived nonce in history.
    history.replaceState(history.state, '', location.pathname + location.search);
    const until = Date.now() + 120000;
    while (!stopped && Date.now() < until) {
      const state = await api.execute('state');
      if (state.uid) {
        try {
          const linked = await request(port, '/pair', { nonce, state });
          if (/^[A-F0-9]{64}$/.test(linked.token) && linked.uid === state.uid)
            GM_setValue('portablePair', { port, token: linked.token, uid: linked.uid });
          return;
        } catch { /* App not ready, permission prompt, or identity still loading. */ }
      }
      await sleep(1000);
    }
  }
  unsafeWindow.addEventListener('hashchange', () => { void pairFromHash(); });
  GM_registerMenuCommand('Связать с BetterBitrix Portable', () => {
    alert('Откройте настройки portable-приложения и нажмите «Связать с браузером». Оно откроет Bitrix с одноразовым ключом.');
  });
  void pairFromHash();
  async function execute(command, uid) {
    if (executing || command.expectedUid !== uid || typeof command.id !== 'string' || typeof command.command !== 'string') return;
    const completed = GM_getValue('portableCompleted', []);
    const existing = completed.find(item => item.id === command.id);
    if (existing) { pendingResults.push(existing);return; }
    // Mark before any side effect. A duplicate ID is never executed after reload.
    const result = { type: 'result', id: command.id, error: 'Выполнение было прервано. Проверьте состояние Bitrix.' };
    GM_setValue('portableCompleted', [...completed.slice(-7), result]);
    executing = true;
    try { await api.execute(command.command, command.params || {}, command.expectedUid);result.error = null; }
    catch (error) { result.error = String(error.message || error).slice(0, 1000); }
    finally {
      GM_setValue('portableCompleted', [...completed.slice(-7), result]);
      pendingResults.push(result);executing = false;
    }
  }
  async function tick() {
    if (polling || stopped) return;
    const linked = GM_getValue('portablePair', null);
    if (!linked?.token || !linked.port) return;
    polling = true;
    try {
      const state = await api.execute('state');
      if (!state.uid || state.uid !== linked.uid) return;
      const sentResults = pendingResults.slice(0, 8);
      const response = await request(linked.port, '/exchange', { clientId, state, results: sentResults }, linked.token);
      pendingResults.splice(0, sentResults.length);
      if (response.command) void execute(response.command, state.uid);
      if (!executing && (Date.now() - lastCalendar > 300000 || state.meetingsStatus === 'idle') && state.meetingsStatus !== 'loading') {
        lastCalendar = Date.now();
        // Calendar fetch may be slow; the transport heartbeat must continue.
        void api.execute('meetings', {}, state.uid).catch(() => {});
      }
    } catch { /* Keep the timer in portal storage; reconnect on the next heartbeat. */ }
    finally { polling = false; }
  }
  async function lead() {
    while (!stopped) {
      await navigator.locks.request('betterbitrix-portable-transport-v1', { mode: 'exclusive', ifAvailable: true }, async lock => {
        if (!lock) return;
        while (!stopped) { await tick();await sleep(2000); }
      });
      if (!stopped) await sleep(2000);
    }
  }
  void lead();
})();
