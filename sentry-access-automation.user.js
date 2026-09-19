// ==UserScript==
// @name         Sentry Access Automation
// @namespace    zalhariz.sentry.automation
// @version      1.12.0
// @description  Full workflow automation for Sentry datacenter Enter/Leave access requests
// @match        https://sentry-apac.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  /* =========================================================
   * PHASE 3 — CONFIGURATION
   * Edit this tree to add/remove rooms. Nothing else needs to change.
   * ========================================================= */
  const CONFIG = {
    // Nested datacenter -> campus -> building -> [room codes]. Empty by
    // default — rooms are added via the FAB's "Add Room" form (stored
    // separately, merged in at runtime by getEffectiveTree()), or you can
    // hardcode a datacenter here by adding a top-level key in this shape
    // (the campus/building keys and labels must match whatever the real
    // Sentry portal shows when you test manually):
    // MY88: {
    //   campuses: {
    //     MY88_C01: { label: 'C01', buildings: { A: ['A1-1'] } }
    //   }
    // }
    tree: {},
    // CONFIRMED (via Network tab on the real portal, Sep 2026): the Access
    // Control Location list is actually per-door, labeled like
    // "C3-1.MY88-1号门外" (door 1) or, on some datacenters, in English like
    // "B7-1.MY115-1 Outside the door" — NOT the bare room code. resolveLocation()
    // only searches the "<room>.<dc>-<door>" prefix (no suffix words), which
    // matches either language and still disambiguates door 1 vs door 2.
    // tagOverrides still lets you override the searched text entirely for a
    // room if its label doesn't follow that pattern at all. Keyed by plain
    // room code, so room codes must stay unique across every datacenter in
    // this config, not just within one.
    tagOverrides: {},
    // Which door number each room should target. Any room not listed here
    // defaults to door 1. Add entries as you confirm more rooms need a
    // non-default door. Also keyed by plain room code — same uniqueness
    // requirement as tagOverrides above.
    doorOverrides: {},
    // Where the actual Enter/Leave form lives. If the workflow starts on a
    // different page (e.g. the app hub with the four tiles) and the
    // "direction" field isn't there, it navigates here first and waits for
    // the form to render before continuing.
    formUrl: 'https://sentry-apac.com/sentryh5/page#/call-security-create'
  };

  const STORAGE_KEYS = {
    autoSubmit: 'sentry_auto_submit',
    debug: 'sentry_debug',
    favorites: 'sentry_favorites',
    history: 'sentry_history',
    fastMode: 'sentry_fast_mode',
    customRooms: 'sentry_custom_rooms',
    customDoorOverrides: 'sentry_custom_door_overrides'
  };

  // Environment shim: the GM_* globals only exist under Tampermonkey. When this
  // same script is injected directly into a page (e.g. from a WebView-based
  // wrapper app), fall back to localStorage/a plain <style> tag instead of
  // crashing on an undefined GM_addStyle/etc.
  const gm = {
    get: (key, def) => {
      if (typeof GM_getValue === 'function') { try { return GM_getValue(key, def); } catch (e) {} }
      try {
        const raw = localStorage.getItem('sa_' + key);
        return raw === null ? def : JSON.parse(raw);
      } catch (e) { return def; }
    },
    set: (key, val) => {
      if (typeof GM_setValue === 'function') { try { GM_setValue(key, val); return; } catch (e) {} }
      try { localStorage.setItem('sa_' + key, JSON.stringify(val)); } catch (e) {}
    },
    addStyle: (css) => {
      if (typeof GM_addStyle === 'function') { try { GM_addStyle(css); return; } catch (e) {} }
      const s = document.createElement('style');
      s.textContent = css;
      document.head.appendChild(s);
    },
    registerMenuCommand: (label, fn) => {
      if (typeof GM_registerMenuCommand === 'function') { try { GM_registerMenuCommand(label, fn); } catch (e) {} }
      // No native menu to hook up outside Tampermonkey — the same toggles are
      // already reachable from the in-page Settings section.
    }
  };

  const getSetting = (key, def) => gm.get(key, def);
  const setSetting = (key, val) => gm.set(key, val);

  let DEBUG = getSetting(STORAGE_KEYS.debug, false);
  // Room code currently loaded into the Add Room form for editing, or null
  // when the form is in plain "add new" mode.
  let editingRoomCode = null;
  // Whether the Add Room dropdown is expanded — collapsed by default so the
  // menu stays compact; stays in sync with the <details> element's own state.
  let addRoomOpen = false;
  const log = (...args) => { if (DEBUG) console.log('[SentryAuto]', ...args); };

  // wm(fast, safe) — returns the fast duration unless "Fast waits" is turned off
  // in Settings, in which case it falls back to the original, more cautious value.
  // If the page ever feels laggy on a given day, flip the toggle off rather than
  // editing these numbers.
  const wm = (fast, safe) => (getSetting(STORAGE_KEYS.fastMode, true) ? fast : safe);

  /* =========================================================
   * LOW-LEVEL DOM HELPERS (from your original bookmarklet)
   * ========================================================= */
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function waitFor(conditionFn, timeout = 5000, interval = 80) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      // check immediately — no reason to eat one full interval before the
      // first check when the condition may already be true.
      let val;
      try { val = conditionFn(); } catch (e) { val = false; }
      if (val) { resolve(val); return; }
      const timer = setInterval(() => {
        let val;
        try { val = conditionFn(); } catch (e) { val = false; }
        if (val) {
          clearInterval(timer);
          resolve(val);
        } else if (Date.now() - start > timeout) {
          clearInterval(timer);
          reject(new Error('timeout'));
        }
      }, interval);
    });
  }

  function clickRadioSel(id, label) {
    const g = document.getElementById(id);
    if (!g) throw new Error('Radio group not found: ' + id);
    let clicked = false;
    g.querySelectorAll('.mt-radio-container').forEach((c) => {
      const t = c.querySelector('.mt-radio-text');
      if (t && t.textContent.trim() === label) {
        c.click();
        clicked = true;
      }
    });
    if (!clicked) throw new Error('Radio option not found: ' + label + ' in ' + id);
  }

  function typeInto(el, val) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
    if (setter && setter.set) setter.set.call(el, val);
    else el.value = val;
    ['input', 'change', 'keyup', 'compositionend'].forEach((ev) => {
      el.dispatchEvent(new Event(ev, { bubbles: true }));
    });
  }

  function pressEnter(el) {
    ['keydown', 'keypress', 'keyup'].forEach((ev) => {
      el.dispatchEvent(new KeyboardEvent(ev, { key: 'Enter', keyCode: 13, bubbles: true }));
    });
  }

  function clickOK() {
    const btns = document.querySelectorAll('.mt-drawer-modal div.mt-button--primary-solid');
    for (const b of btns) {
      if (b.offsetParent === null) continue;
      const sp = b.querySelector('span');
      if (sp && sp.textContent.trim() === 'OK') {
        b.click();
        return true;
      }
    }
    return false;
  }

  // Matches exact text first, then falls back to items that START WITH the
  // search text followed by a non-alphanumeric char (e.g. "A1-11" matches
  // list entry "A1-11.MY88" but not "A1-110").
  function textMatches(itemText, target) {
    if (itemText === target) return true;
    if (itemText.startsWith(target)) {
      const nextChar = itemText.charAt(target.length);
      if (nextChar === '' || !/[a-zA-Z0-9]/.test(nextChar)) return true;
    }
    return false;
  }

  function clickListItem(exactText) {
    const drawer = document.querySelector('.mt-drawer-modal');
    if (!drawer) return false;
    const items = drawer.querySelectorAll('.mt-list-item-title');
    for (const it of items) {
      if (textMatches(it.textContent.trim(), exactText)) {
        const container = it.closest('.mt-list-item-container') || it.parentElement;
        container.click();
        return true;
      }
    }
    const spans = drawer.querySelectorAll('span');
    for (const s of spans) {
      if (textMatches(s.textContent.trim(), exactText) && s.offsetParent !== null) {
        s.click();
        return true;
      }
    }
    return false;
  }

  function getDrawerInput() {
    const drawer = document.querySelector('.mt-drawer-modal');
    if (!drawer) return null;
    const inp = drawer.querySelector('input[type="search"]');
    return inp && inp.offsetParent !== null ? inp : null;
  }

  function waitForDrawerCloseP(timeout = 6000) {
    return new Promise((resolve) => {
      if (!document.querySelector('.mt-drawer-modal')) return resolve(true);
      const observer = new MutationObserver(() => {
        if (!document.querySelector('.mt-drawer-modal')) {
          observer.disconnect();
          clearTimeout(timer);
          resolve(true);
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });
      const timer = setTimeout(() => {
        observer.disconnect();
        resolve(false); // didn't confirm close, but don't hang forever
      }, timeout);
    });
  }

  /* =========================================================
   * PHASE 7 — RELIABLE STEP: open drawer, select item (search or plain list)
   * ========================================================= */
  async function genericSelectDrawer(drawerId, exactMatch, fallbackMatch) {
    const el = document.getElementById(drawerId);
    if (!el) throw new Error('Field not found on page: ' + drawerId);
    el.click();
    await waitFor(() => document.querySelector('.mt-drawer-modal'), 4000);
    // wait for the drawer to actually have something interactive in it,
    // instead of blindly assuming it's ready after a fixed delay
    await waitFor(
      () => getDrawerInput() || document.querySelector('.mt-drawer-modal .mt-list-item-title'),
      2000
    ).catch(() => {});
    await sleep(wm(60, 350));

    async function trySelect(text) {
      let inp = getDrawerInput();
      if (inp) {
        // Some drawers (e.g. Access Control Location) finish loading their
        // item list asynchronously after opening and re-render the search
        // input while doing so, which can wipe out text typed too early.
        // Re-fetch the live input and confirm the value actually stuck
        // before moving on, retrying against whatever node is live now.
        for (let attempt = 0; attempt < 3; attempt++) {
          typeInto(inp, text);
          await sleep(wm(150, 500));
          const liveInp = getDrawerInput() || inp;
          inp = liveInp;
          if (inp.value === text) break;
        }
        pressEnter(inp);
        // no long blind wait here — the poll below already retries for up to
        // 3s until the filtered item appears, so this only needs to cover the
        // time between pressing Enter and the list re-rendering starting.
        await sleep(wm(60, 700));
      } else {
        await sleep(wm(120, 400)); // let plain list render
      }
      return waitFor(() => clickListItem(text), 3000).catch(() => false);
    }

    let ticked = await trySelect(exactMatch);
    if (!ticked && fallbackMatch && fallbackMatch !== exactMatch) {
      log('Exact match not found, retrying with fallback:', exactMatch, '->', fallbackMatch);
      ticked = await trySelect(fallbackMatch);
    }
    if (!ticked) throw new Error('Item not found in list: ' + exactMatch);
    // wait for the OK button to actually be visible rather than guessing a delay
    await waitFor(() => {
      const btns = document.querySelectorAll('.mt-drawer-modal div.mt-button--primary-solid');
      return Array.from(btns).some((b) => b.offsetParent !== null);
    }, 1500).catch(() => {});
    await sleep(wm(60, 400));
    clickOK();
    await waitForDrawerCloseP();
  }

  function clickSubmitButton() {
    // ASSUMPTION — verify this selector against the real form before relying on Auto Submit.
    const btns = document.querySelectorAll('div.mt-button--primary-solid, button.mt-button--primary-solid');
    for (const b of btns) {
      if (b.offsetParent === null) continue;
      const sp = b.querySelector('span');
      const text = (sp ? sp.textContent : b.textContent || '').trim();
      if (text === 'Submit') {
        b.click();
        return true;
      }
    }
    return false;
  }

  // If the "direction" field isn't on the page yet, we're probably on the
  // app hub instead of the actual form — navigate to formUrl and wait for
  // the form to render before letting the workflow proceed.
  async function ensureFormPage() {
    if (document.getElementById('direction')) return;
    log('Form not found on current page, navigating to', CONFIG.formUrl);
    window.location.href = CONFIG.formUrl;
    await waitFor(() => document.getElementById('direction'), 8000);
  }

  /* =========================================================
   * PHASE 2 — WORKFLOW DEFINITION
   * ========================================================= */
  function buildSteps(loc, autoSubmit) {
    const steps = [
      { name: 'Load Form', run: ensureFormPage },
      { name: 'Direction', run: () => { clickRadioSel('direction', loc.direction); return sleep(wm(100, 300)); } },
      { name: 'Data Center', run: () => genericSelectDrawer('machineIdc', loc.idc) },
      { name: 'Park / Campus', run: () => genericSelectDrawer('campus', loc.campus) },
      { name: 'Building', run: () => genericSelectDrawer('building', loc.building) },
      { name: 'Room', run: () => genericSelectDrawer('machineRoom', loc.room) },
      { name: 'Access Control Location', run: () => genericSelectDrawer('tagNumber', loc.tag, loc.fallbackTag) },
      { name: 'Document Association', run: () => { clickRadioSel('isCorrelation', 'No'); return sleep(wm(120, 400)); } }
    ];
    if (autoSubmit) {
      steps.push({
        name: 'Submit',
        run: async () => {
          await sleep(wm(120, 300));
          const ok = clickSubmitButton();
          if (!ok) throw new Error('Submit button not found — please submit manually');
        }
      });
    }
    return steps;
  }

  // Rooms added via the FAB's "Add Room" form live in GM storage, separate
  // from the hardcoded CONFIG.tree. This merges them into a plain object
  // shaped exactly like CONFIG.tree so resolveLocation() and renderMenu()
  // can walk one structure without caring where a room came from.
  function getEffectiveTree() {
    const tree = {};
    for (const [dcId, dc] of Object.entries(CONFIG.tree)) {
      tree[dcId] = { campuses: {} };
      for (const [campusId, campus] of Object.entries(dc.campuses)) {
        tree[dcId].campuses[campusId] = { label: campus.label, buildings: {} };
        for (const [buildingId, rooms] of Object.entries(campus.buildings)) {
          tree[dcId].campuses[campusId].buildings[buildingId] = [...rooms];
        }
      }
    }
    const customRooms = getSetting(STORAGE_KEYS.customRooms, []);
    customRooms.forEach((r) => {
      if (!tree[r.dc]) tree[r.dc] = { campuses: {} };
      if (!tree[r.dc].campuses[r.campusId]) tree[r.dc].campuses[r.campusId] = { label: r.campusLabel || r.campusId, buildings: {} };
      if (!tree[r.dc].campuses[r.campusId].buildings[r.building]) tree[r.dc].campuses[r.campusId].buildings[r.building] = [];
      if (!tree[r.dc].campuses[r.campusId].buildings[r.building].includes(r.room)) {
        tree[r.dc].campuses[r.campusId].buildings[r.building].push(r.room);
      }
    });
    return tree;
  }

  function getEffectiveDoorOverrides() {
    return { ...CONFIG.doorOverrides, ...getSetting(STORAGE_KEYS.customDoorOverrides, {}) };
  }

  function collectRoomCodes(tree) {
    const codes = [];
    for (const dc of Object.values(tree)) {
      for (const campus of Object.values(dc.campuses)) {
        for (const rooms of Object.values(campus.buildings)) {
          codes.push(...rooms);
        }
      }
    }
    return codes;
  }

  function resolveLocation(roomCode, direction) {
    const doorOverrides = getEffectiveDoorOverrides();
    for (const [dcId, dc] of Object.entries(getEffectiveTree())) {
      for (const [campusId, campus] of Object.entries(dc.campuses)) {
        for (const [buildingId, rooms] of Object.entries(campus.buildings)) {
          if (rooms.includes(roomCode)) {
            const doorNumber = doorOverrides[roomCode] || 1;
            const fallbackTag = CONFIG.tagOverrides[roomCode] || roomCode;
            // Some datacenters' Room drawer displays room codes with the
            // datacenter already baked in (e.g. "B7-1.MY115" instead of
            // "B7-1"), which people naturally copy into a custom room's
            // "Room" field as-is. Don't double-append the datacenter suffix
            // in that case, or the tag search string comes out mangled
            // ("B7-1.MY115.MY115-2") and matches nothing.
            const roomPart = roomCode.endsWith(`.${dcId}`) ? roomCode : `${roomCode}.${dcId}`;
            return {
              direction,
              idc: dcId,
              campus: campusId,
              building: buildingId,
              room: roomCode,
              doorNumber,
              // Primary target: the locale-independent prefix of the per-door
              // label (e.g. "B7-1.MY115-1"). The portal appends a language-
              // specific suffix after this ("号门外" / " Outside the door" /
              // etc), which textMatches()'s prefix rule ignores — so this
              // still uniquely disambiguates the door number without caring
              // which language the list is rendered in. fallbackTag (bare
              // room code) is kept for genericSelectDrawer to retry with if
              // this ever doesn't match at all (unseen room/label format) —
              // note it can't tell doors apart, so it's a last resort only.
              tag: `${roomPart}-${doorNumber}`,
              fallbackTag
            };
          }
        }
      }
    }
    return null;
  }

  /* =========================================================
   * PHASE 6 / 8 — STATUS OVERLAY + ERROR HANDLING
   * ========================================================= */
  let statusPanel, statusList, statusFooter, statusStopBtn;
  let currentRunToken = null;

  function ensureStatusPanel() {
    if (statusPanel) return;
    statusPanel = document.createElement('div');
    statusPanel.id = 'sa-status';
    statusPanel.innerHTML = `
      <div class="sa-status-header">
        <span class="sa-status-title">Sentry Automation</span>
        <button class="sa-btn sa-stop-btn">Stop</button>
      </div>
      <ul class="sa-status-list"></ul>
      <div class="sa-status-footer"></div>`;
    document.body.appendChild(statusPanel);
    statusList = statusPanel.querySelector('.sa-status-list');
    statusFooter = statusPanel.querySelector('.sa-status-footer');
    statusStopBtn = statusPanel.querySelector('.sa-stop-btn');
    statusStopBtn.addEventListener('click', () => {
      if (currentRunToken) currentRunToken.cancelled = true;
      statusFooter.innerHTML = '<div class="sa-result-row"><span class="sa-stopped-msg">Stopped by user</span><button class="sa-btn sa-done-btn">Done</button></div>';
      statusFooter.querySelector('.sa-done-btn').addEventListener('click', hideStatus);
      statusStopBtn.style.display = 'none';
    });
  }

  function showStatus(steps) {
    ensureStatusPanel();
    statusList.innerHTML = steps.map((s, i) =>
      `<li data-idx="${i}"><span class="sa-icon">…</span><span class="sa-label">${s.name}</span></li>`
    ).join('');
    statusFooter.innerHTML = '';
    statusStopBtn.style.display = '';
    statusPanel.classList.add('sa-visible');
  }

  function setStepState(idx, state, message) {
    const li = statusList.querySelector(`li[data-idx="${idx}"]`);
    if (!li) return;
    const icon = li.querySelector('.sa-icon');
    li.classList.remove('sa-pending', 'sa-active', 'sa-done', 'sa-error');
    if (state === 'active') { icon.textContent = '⏳'; li.classList.add('sa-active'); }
    else if (state === 'done') { icon.textContent = '✔'; li.classList.add('sa-done'); }
    else if (state === 'error') { icon.textContent = '❌'; li.classList.add('sa-error'); if (message) li.title = message; }
  }

  function showErrorFooter(message, onRetry) {
    statusFooter.innerHTML = `
      <div class="sa-error-msg">${message}</div>
      <div class="sa-error-actions">
        <button class="sa-btn sa-retry">Retry</button>
        <button class="sa-btn sa-manual">Continue manually</button>
      </div>`;
    statusFooter.querySelector('.sa-retry').onclick = () => {
      statusStopBtn.style.display = '';
      onRetry();
    };
    statusFooter.querySelector('.sa-manual').onclick = () => hideStatus();
    statusStopBtn.style.display = 'none';
  }

  function hideStatus() {
    if (statusPanel) statusPanel.classList.remove('sa-visible');
  }

  /* =========================================================
   * PHASE 8 — RUN WORKFLOW WITH RETRY
   * ========================================================= */
  async function runWorkflow(loc) {
    const autoSubmit = getSetting(STORAGE_KEYS.autoSubmit, false);
    const steps = buildSteps(loc, autoSubmit);
    showStatus(steps);
    log('Starting workflow', loc);

    const token = { cancelled: false };
    currentRunToken = token;

    let i = 0;
    async function runFrom(startIdx) {
      for (i = startIdx; i < steps.length; i++) {
        if (token.cancelled) {
          log('Workflow cancelled by user before step', steps[i].name);
          return;
        }
        setStepState(i, 'active');
        try {
          await steps[i].run();
          if (token.cancelled) {
            log('Workflow cancelled by user during step', steps[i].name);
            return;
          }
          setStepState(i, 'done');
          log('Step OK:', steps[i].name);
        } catch (err) {
          log('Step FAILED:', steps[i].name, err.message);
          if (token.cancelled) return;
          // one silent retry
          try {
            await sleep(600);
            if (token.cancelled) return;
            await steps[i].run();
            setStepState(i, 'done');
            log('Step OK on retry:', steps[i].name);
            continue;
          } catch (err2) {
            if (token.cancelled) return;
            setStepState(i, 'error', err2.message);
            showErrorFooter(`${steps[i].name} failed: ${err2.message}`, () => runFrom(i));
            return; // stop — wait for user
          }
        }
      }
      // reached the end without stopping
      recordHistory(loc);
      statusStopBtn.style.display = 'none';
      statusFooter.innerHTML = '<div class="sa-result-row"><span class="sa-success-msg">Done ✔</span><button class="sa-btn sa-done-btn">Done</button></div>';
      statusFooter.querySelector('.sa-done-btn').addEventListener('click', hideStatus);
    }
    await runFrom(0);
  }

  /* =========================================================
   * PHASE 9 — HISTORY
   * ========================================================= */
  function recordHistory(loc) {
    const hist = getSetting(STORAGE_KEYS.history, []);
    hist.unshift({ room: loc.room, direction: loc.direction, ts: Date.now() });
    setSetting(STORAGE_KEYS.history, hist.slice(0, 20));
  }

  function relativeTime(ts) {
    const d = new Date(ts);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    const yest = new Date(now); yest.setDate(now.getDate() - 1);
    const isYesterday = d.toDateString() === yest.toDateString();
    const hhmm = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (sameDay) return hhmm;
    if (isYesterday) return 'Yesterday ' + hhmm;
    return d.toLocaleDateString() + ' ' + hhmm;
  }

  /* =========================================================
   * PHASE 4 — FLOATING BUTTON + MENU UI
   * ========================================================= */
  gm.addStyle(`
    :root {
      --sa-accent-1: #FF7A1A;
      --sa-accent-border: rgba(255,122,26,.5);
      --sa-bg: rgba(8, 8, 9, .98);
      --sa-bg-solid: #0a0a0a;
      --sa-card: rgba(255,255,255,.04);
      --sa-card-hover: rgba(255,255,255,.08);
      --sa-border: rgba(255,255,255,.12);
      --sa-text: #F5F3EF;
      --sa-text-dim: #8F8B85;
      --sa-green-1: #00E5A8; --sa-green-2: #00C2FF;
      --sa-red-1: #FF5C8A; --sa-red-2: #FF2E63;
    }
    @keyframes sa-pulse-ring { 0% { box-shadow: 0 0 0 0 rgba(255,122,26,.5); } 100% { box-shadow: 0 0 0 14px rgba(255,122,26,0); } }
    @keyframes sa-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
    #sa-fab { position: fixed; right: 16px; bottom: 16px; z-index: 999999;
      width: 56px; height: 56px; border-radius: 50%;
      background: var(--sa-bg-solid);
      display: flex; align-items: center; justify-content: center;
      box-shadow: 0 6px 20px rgba(255,122,26,.35);
      cursor: pointer; user-select: none; border: 2px solid var(--sa-accent-1);
      transition: transform .25s ease, box-shadow .25s ease, border-color .25s ease; }
    #sa-fab::after { content: ''; position: absolute; inset: 0; border-radius: 50%;
      animation: sa-pulse-ring 2.4s ease-out infinite; pointer-events: none; }
    #sa-fab svg { width: 28px; height: 28px; transition: transform .25s ease; position: relative; z-index: 1; }
    #sa-fab.sa-fab-active { transform: scale(1.05) rotate(90deg); box-shadow: 0 6px 24px rgba(255,122,26,.55); border-color: #FFA35C; }
    #sa-menu { position: fixed; right: 16px; bottom: 82px; z-index: 999999;
      width: min(340px, 92vw); max-height: 74vh; background: var(--sa-bg);
      border-radius: 18px; border: 1px solid var(--sa-border);
      box-shadow: 0 16px 48px rgba(0,0,0,.6);
      display: flex; flex-direction: column; overflow: hidden;
      font-family: -apple-system, "Segoe UI", sans-serif; font-size: 14px; color: var(--sa-text);
      opacity: 0; transform: translateY(14px) scale(.96); pointer-events: none;
      transition: opacity .2s ease, transform .2s ease; }
    #sa-menu.sa-open { opacity: 1; transform: translateY(0) scale(1); pointer-events: auto; }
    #sa-menu .sa-menu-header { display: flex; align-items: center; justify-content: space-between;
      padding: 14px 16px; border-bottom: 1px solid var(--sa-border); flex-shrink: 0; }
    #sa-menu .sa-menu-title { font-weight: 800; font-size: 15px; letter-spacing: .4px;
      text-transform: uppercase; color: var(--sa-text); }
    #sa-menu .sa-menu-close { background: var(--sa-card); border: 1px solid var(--sa-border); color: var(--sa-text-dim);
      width: 26px; height: 26px; border-radius: 50%; cursor: pointer; font-size: 13px; line-height: 1;
      display: flex; align-items: center; justify-content: center; transition: background .15s, color .15s; }
    #sa-menu .sa-menu-close:hover { background: var(--sa-card-hover); color: var(--sa-text); }
    #sa-menu .sa-menu-body { overflow-y: auto; scrollbar-width: thin; scrollbar-color: rgba(255,255,255,.2) transparent; }
    #sa-menu .sa-menu-body::-webkit-scrollbar { width: 6px; }
    #sa-menu .sa-menu-body::-webkit-scrollbar-thumb { background: rgba(255,255,255,.18); border-radius: 6px; }
    #sa-menu .sa-menu-footer { padding: 8px 16px; border-top: 1px solid var(--sa-border);
      font-size: 10px; letter-spacing: .4px; text-transform: uppercase; text-align: center;
      color: var(--sa-text-dim); flex-shrink: 0; }
    #sa-menu .sa-section-title { padding: 14px 16px 6px; font-weight: 700; color: var(--sa-accent-1);
      font-size: 11px; text-transform: uppercase; letter-spacing: 1.2px; }
    #sa-menu .sa-section-title::before { content: '\\25CF'; font-size: 7px; margin-right: 6px; vertical-align: middle; }
    #sa-menu .sa-room-row { display: flex; align-items: center; justify-content: space-between;
      margin: 4px 10px; padding: 9px 10px; border-radius: 12px; background: var(--sa-card);
      border: 1px solid var(--sa-border); transition: background .15s, border-color .15s; }
    #sa-menu .sa-room-row:hover { background: var(--sa-card-hover); border-color: rgba(255,255,255,.22); }
    #sa-menu .sa-room-code { font-weight: 600; letter-spacing: .2px; }
    #sa-menu .sa-room-actions { display: flex; gap: 6px; }
    #sa-menu .sa-room-actions button { border: none; border-radius: 999px; padding: 6px 12px;
      font-size: 12px; font-weight: 600; cursor: pointer; transition: transform .12s, filter .15s; }
    #sa-menu .sa-room-actions button:active { transform: scale(.94); }
    #sa-menu .sa-enter-btn { background: linear-gradient(135deg, var(--sa-green-1), var(--sa-green-2)); color: #012;
      box-shadow: 0 2px 10px rgba(0,194,255,.3); }
    #sa-menu .sa-leave-btn { background: linear-gradient(135deg, var(--sa-red-1), var(--sa-red-2)); color: #fff;
      box-shadow: 0 2px 10px rgba(255,46,99,.3); }
    #sa-menu .sa-delete-btn { background: transparent; color: var(--sa-text-dim); border: 1px solid var(--sa-border) !important; }
    #sa-menu .sa-delete-btn:hover { background: var(--sa-card-hover); color: var(--sa-text); }
    #sa-menu .sa-edit-btn { background: transparent; color: var(--sa-text-dim); border: 1px solid var(--sa-border) !important; }
    #sa-menu .sa-edit-btn:hover { background: var(--sa-card-hover); color: var(--sa-text); }
    #sa-menu .sa-fav-star { cursor: pointer; margin-right: 8px; color: rgba(255,255,255,.25); font-size: 15px;
      transition: color .15s, transform .15s; display: inline-block; }
    #sa-menu .sa-fav-star.sa-favd { color: var(--sa-accent-1); text-shadow: 0 0 8px rgba(255,122,26,.5); transform: scale(1.1); }
    #sa-menu .sa-history-row { display: flex; justify-content: space-between; margin: 3px 10px;
      padding: 7px 10px; font-size: 12.5px; color: var(--sa-text-dim); border-radius: 10px; }
    #sa-menu .sa-repeat-row { display: flex; align-items: center; justify-content: space-between;
      margin: 4px 10px 8px; padding: 10px 12px; border-radius: 14px;
      background: rgba(255,122,26,.08); border: 1px solid var(--sa-accent-border); }
    #sa-menu .sa-repeat-label { font-weight: 600; }
    #sa-menu .sa-repeat-btn { border: none; border-radius: 999px; padding: 7px 16px; font-size: 13px;
      font-weight: 700; cursor: pointer; }
    #sa-menu .sa-quick-enter { background: linear-gradient(135deg, var(--sa-green-1), var(--sa-green-2)); color: #012; }
    #sa-menu .sa-quick-leave { background: linear-gradient(135deg, var(--sa-red-1), var(--sa-red-2)); color: #fff; }
    #sa-menu .sa-settings-row { display: flex; align-items: center; justify-content: space-between; padding: 10px 16px; }
    #sa-menu .sa-settings-row label { font-size: 13px; color: var(--sa-text); }
    #sa-menu .sa-settings-row .sa-btn { background: var(--sa-card); color: var(--sa-text); border: 1px solid var(--sa-border);
      border-radius: 999px; padding: 6px 14px; font-size: 12px; font-weight: 600; cursor: pointer; }
    #sa-menu .sa-settings-row .sa-btn:hover { background: var(--sa-card-hover); }
    #sa-menu .sa-switch { position: relative; display: inline-block; width: 42px; height: 24px; }
    #sa-menu .sa-switch input { opacity: 0; width: 0; height: 0; }
    #sa-menu .sa-slider { position: absolute; inset: 0; background: rgba(255,255,255,.15); border-radius: 999px;
      transition: background .2s; cursor: pointer; }
    #sa-menu .sa-slider::before { content: ''; position: absolute; width: 18px; height: 18px; left: 3px; top: 3px;
      background: #fff; border-radius: 50%; transition: transform .2s; box-shadow: 0 2px 4px rgba(0,0,0,.3); }
    #sa-menu .sa-switch input:checked + .sa-slider { background: var(--sa-accent-1); }
    #sa-menu .sa-switch input:checked + .sa-slider::before { transform: translateX(18px); }
    #sa-menu .sa-addroom-details { border-top: 1px solid var(--sa-border); margin-top: 4px; }
    #sa-menu .sa-addroom-summary { cursor: pointer; list-style: none; display: flex;
      align-items: center; justify-content: space-between; user-select: none;
      transition: color .15s; }
    #sa-menu .sa-addroom-summary::-webkit-details-marker { display: none; }
    #sa-menu .sa-addroom-summary:hover { color: var(--sa-text); }
    #sa-menu .sa-addroom-summary .sa-caret { font-size: 11px; color: var(--sa-text-dim);
      transition: transform .2s ease; }
    #sa-menu .sa-addroom-details[open] .sa-addroom-summary .sa-caret { transform: rotate(180deg); }
    #sa-menu .sa-addroom-form { display: flex; flex-direction: column; gap: 8px; padding: 8px 16px 16px; }
    #sa-menu .sa-addroom-form input { background: var(--sa-card); border: 1px solid var(--sa-border); color: var(--sa-text);
      border-radius: 10px; padding: 9px 10px; font-size: 13px; width: 100%; box-sizing: border-box;
      transition: border-color .15s, box-shadow .15s; }
    #sa-menu .sa-addroom-form input::placeholder { color: var(--sa-text-dim); }
    #sa-menu .sa-addroom-form input:focus { outline: none; border-color: var(--sa-accent-1);
      box-shadow: 0 0 0 3px rgba(255,122,26,.18); }
    #sa-menu .sa-addroom-actions { display: flex; align-items: center; gap: 8px; }
    #sa-menu .sa-add-room-btn { background: var(--sa-accent-1); color: #0a0a0a;
      border: none; border-radius: 999px; padding: 8px 18px; font-size: 13px;
      font-weight: 700; cursor: pointer; box-shadow: 0 4px 14px rgba(255,122,26,.3); }
    #sa-menu .sa-cancel-edit-btn { background: var(--sa-card); color: var(--sa-text-dim); border: 1px solid var(--sa-border);
      border-radius: 999px; padding: 8px 16px; font-size: 13px; font-weight: 600; cursor: pointer; }
    #sa-menu .sa-cancel-edit-btn:hover { background: var(--sa-card-hover); }
    #sa-menu .sa-addroom-msg { font-size: 12px; min-height: 14px; color: var(--sa-text-dim); }
    #sa-menu .sa-addroom-msg.sa-addroom-error { color: #FF7A7A; }
    #sa-status { position: fixed; left: 16px; bottom: 16px; z-index: 999999;
      width: min(280px, 85vw); background: var(--sa-bg);
      border-radius: 16px; border: 1px solid var(--sa-border); box-shadow: 0 16px 48px rgba(0,0,0,.6);
      font-family: -apple-system, "Segoe UI", sans-serif; font-size: 13px; color: var(--sa-text);
      display: none; overflow: hidden; }
    #sa-status.sa-visible { display: block; }
    #sa-status .sa-status-header { display: flex; align-items: center; justify-content: space-between;
      padding: 12px 14px; border-bottom: 1px solid var(--sa-border); }
    #sa-status .sa-status-title { font-weight: 800; letter-spacing: .3px; text-transform: uppercase; }
    #sa-status .sa-stop-btn { background: linear-gradient(135deg, var(--sa-red-1), var(--sa-red-2)); color: #fff;
      border: none; border-radius: 999px; padding: 5px 12px; font-size: 12px; font-weight: 600; cursor: pointer; }
    #sa-status .sa-status-list { list-style: none; margin: 0; padding: 8px 0; }
    #sa-status .sa-status-list li { display: flex; align-items: center; gap: 8px; padding: 6px 14px; color: var(--sa-text-dim); }
    #sa-status .sa-status-list li .sa-icon { display: inline-flex; width: 16px; justify-content: center; }
    #sa-status .sa-status-list li.sa-active { color: var(--sa-accent-1); }
    #sa-status .sa-status-list li.sa-active .sa-icon { animation: sa-spin 1s linear infinite; }
    #sa-status .sa-status-list li.sa-done { color: #00E5A8; }
    #sa-status .sa-status-list li.sa-error { color: #FF7A7A; }
    #sa-status .sa-status-footer { padding: 8px 14px 14px; }
    #sa-status .sa-error-msg { color: #FF7A7A; margin-bottom: 8px; }
    #sa-status .sa-error-actions button { margin-right: 6px; border: none; border-radius: 999px; padding: 6px 12px;
      font-size: 12px; font-weight: 600; cursor: pointer; }
    #sa-status .sa-retry { background: var(--sa-accent-1); color: #0a0a0a; }
    #sa-status .sa-manual { background: var(--sa-card); color: var(--sa-text); border: 1px solid var(--sa-border); }
    #sa-status .sa-success-msg { color: #00E5A8; font-weight: 700; }
    #sa-status .sa-stopped-msg { color: #FF7A7A; font-weight: 700; }
    #sa-status .sa-result-row { display: flex; align-items: center; justify-content: space-between; }
    #sa-status .sa-done-btn { background: var(--sa-accent-1); color: #0a0a0a;
      border: none; border-radius: 999px; padding: 6px 14px; font-size: 12px; font-weight: 600; cursor: pointer; }
  `);

  function buildMenu(fab) {
    const menu = document.createElement('div');
    menu.id = 'sa-menu';
    menu.innerHTML = `
      <div class="sa-menu-header">
        <span class="sa-menu-title">⚡ Sentry Access</span>
        <button class="sa-menu-close" id="sa-menu-close" aria-label="Close">✕</button>
      </div>
      <div class="sa-menu-body" id="sa-menu-body"></div>
      <div class="sa-menu-footer">Design and Develop by MY88 IT Zalhariz</div>`;
    document.body.appendChild(menu);
    menu.querySelector('#sa-menu-close').addEventListener('click', () => {
      menu.classList.remove('sa-open');
      if (fab) fab.classList.remove('sa-fab-active');
    });
    renderMenu(menu);
    return menu;
  }

  function renderMenu(menu) {
    const favorites = getSetting(STORAGE_KEYS.favorites, []);
    const history = getSetting(STORAGE_KEYS.history, []);
    const autoSubmit = getSetting(STORAGE_KEYS.autoSubmit, false);

    let html = '';

    if (history.length) {
      const last = history[0];
      const nextDirection = last.direction === 'Enter' ? 'Leave' : 'Enter';
      html += '<div class="sa-section-title">Quick Action</div>';
      html += `<div class="sa-repeat-row">
        <span class="sa-repeat-label">${last.room} · ${nextDirection}</span>
        <button class="sa-btn sa-repeat-btn ${nextDirection === 'Enter' ? 'sa-quick-enter' : 'sa-quick-leave'}" data-room="${last.room}" data-direction="${nextDirection}">${nextDirection}</button>
      </div>`;
    }

    const customRoomCodes = new Set(getSetting(STORAGE_KEYS.customRooms, []).map((r) => r.room));

    if (favorites.length) {
      html += '<div class="sa-section-title">Favorites</div>';
      favorites.forEach((f) => {
        html += roomRow(f.room, true, customRoomCodes.has(f.room));
      });
    }

    const effectiveTree = getEffectiveTree();
    for (const [dcId, dc] of Object.entries(effectiveTree)) {
      for (const [campusId, campus] of Object.entries(dc.campuses)) {
        for (const [buildingId, rooms] of Object.entries(campus.buildings)) {
          html += `<div class="sa-section-title">${dcId} · Building ${buildingId} (${campus.label})</div>`;
          rooms.forEach((r) => { html += roomRow(r, isFavorite(r, favorites), customRoomCodes.has(r)); });
        }
      }
    }

    if (history.length) {
      html += '<div class="sa-section-title">Recent</div>';
      history.slice(0, 6).forEach((h) => {
        html += `<div class="sa-history-row"><span>${h.room} · ${h.direction}</span><span>${relativeTime(h.ts)}</span></div>`;
      });
    }

    const customRoomsList = getSetting(STORAGE_KEYS.customRooms, []);
    const editingEntry = editingRoomCode ? customRoomsList.find((r) => r.room === editingRoomCode) : null;
    if (editingRoomCode && !editingEntry) editingRoomCode = null; // stale (e.g. deleted elsewhere)

    html += `<details class="sa-addroom-details" id="sa-addroom-details" ${(addRoomOpen || editingEntry) ? 'open' : ''}>
      <summary class="sa-section-title sa-addroom-summary">${editingEntry ? 'Edit Room' : 'Add Room'}<span class="sa-caret">▾</span></summary>
      <div class="sa-addroom-form">
        <input type="text" id="sa-add-dc" placeholder="Data Center (e.g. MY88)" value="${editingEntry ? editingEntry.dc : ''}">
        <input type="text" id="sa-add-campus" placeholder="Campus (e.g. C01)" value="${editingEntry ? editingEntry.campusId : ''}">
        <input type="text" id="sa-add-building" placeholder="Building (e.g. A)" value="${editingEntry ? editingEntry.building : ''}">
        <input type="text" id="sa-add-room" placeholder="Room (e.g. A1-99)" value="${editingEntry ? editingEntry.room : ''}">
        <input type="number" id="sa-add-door" placeholder="Access Control Location (door #, default 1)" min="1" value="${editingEntry ? (getEffectiveDoorOverrides()[editingEntry.room] || 1) : ''}">
        <div class="sa-addroom-actions">
          <button class="sa-btn sa-add-room-btn" id="sa-add-room-btn">${editingEntry ? 'Save Changes' : 'Add Room'}</button>
          ${editingEntry ? '<button class="sa-btn sa-cancel-edit-btn" id="sa-cancel-edit-btn">Cancel</button>' : ''}
        </div>
        <div class="sa-addroom-msg" id="sa-addroom-msg"></div>
      </div>
    </details>`;

    html += '<div class="sa-section-title">Settings</div>';
    html += `<div class="sa-settings-row"><label>Fast waits</label><label class="sa-switch"><input type="checkbox" id="sa-fast-toggle" ${getSetting(STORAGE_KEYS.fastMode, true) ? 'checked' : ''}><span class="sa-slider"></span></label></div>`;
    html += `<div class="sa-settings-row"><label>Auto Submit</label><label class="sa-switch"><input type="checkbox" id="sa-auto-submit-toggle" ${autoSubmit ? 'checked' : ''}><span class="sa-slider"></span></label></div>`;
    html += `<div class="sa-settings-row"><label>Debug logging</label><label class="sa-switch"><input type="checkbox" id="sa-debug-toggle" ${DEBUG ? 'checked' : ''}><span class="sa-slider"></span></label></div>`;
    html += `<div class="sa-settings-row"><label>Clear history</label><button class="sa-btn" id="sa-clear-history">Clear</button></div>`;
    html += `<div class="sa-settings-row"><label>Clear added rooms</label><button class="sa-btn" id="sa-clear-custom-rooms">Clear</button></div>`;

    menu.querySelector('#sa-menu-body').innerHTML = html;

    menu.querySelectorAll('.sa-enter-btn').forEach((b) => b.addEventListener('click', () => runFromMenu(b.dataset.room, 'Enter')));
    menu.querySelectorAll('.sa-leave-btn').forEach((b) => b.addEventListener('click', () => runFromMenu(b.dataset.room, 'Leave')));
    menu.querySelectorAll('.sa-fav-star').forEach((s) => s.addEventListener('click', () => toggleFavorite(s.dataset.room, menu)));
    menu.querySelectorAll('.sa-delete-btn').forEach((b) => b.addEventListener('click', () => deleteCustomRoom(b.dataset.room, menu)));
    menu.querySelectorAll('.sa-edit-btn').forEach((b) => b.addEventListener('click', () => editCustomRoom(b.dataset.room, menu)));
    const cancelEditBtn = menu.querySelector('#sa-cancel-edit-btn');
    if (cancelEditBtn) cancelEditBtn.addEventListener('click', () => { editingRoomCode = null; addRoomOpen = false; renderMenu(menu); });
    const repeatBtn = menu.querySelector('.sa-repeat-btn');
    if (repeatBtn) repeatBtn.addEventListener('click', () => runFromMenu(repeatBtn.dataset.room, repeatBtn.dataset.direction));
    const addRoomDetails = menu.querySelector('#sa-addroom-details');
    if (addRoomDetails) addRoomDetails.addEventListener('toggle', () => { addRoomOpen = addRoomDetails.open; });

    menu.querySelector('#sa-fast-toggle').addEventListener('change', (e) => setSetting(STORAGE_KEYS.fastMode, e.target.checked));
    menu.querySelector('#sa-auto-submit-toggle').addEventListener('change', (e) => setSetting(STORAGE_KEYS.autoSubmit, e.target.checked));
    menu.querySelector('#sa-debug-toggle').addEventListener('change', (e) => { DEBUG = e.target.checked; setSetting(STORAGE_KEYS.debug, DEBUG); });
    menu.querySelector('#sa-clear-history').addEventListener('click', () => { setSetting(STORAGE_KEYS.history, []); renderMenu(menu); });
    menu.querySelector('#sa-clear-custom-rooms').addEventListener('click', () => {
      setSetting(STORAGE_KEYS.customRooms, []);
      setSetting(STORAGE_KEYS.customDoorOverrides, {});
      renderMenu(menu);
    });
    menu.querySelector('#sa-add-room-btn').addEventListener('click', () => addRoomFromForm(menu));
  }

  function addRoomFromForm(menu) {
    const val = (id) => menu.querySelector(id).value.trim();
    const dc = val('#sa-add-dc');
    const campusId = val('#sa-add-campus');
    const campusLabel = campusId;
    const building = val('#sa-add-building');
    const room = val('#sa-add-room');
    const doorRaw = parseInt(val('#sa-add-door'), 10);
    const door = Number.isFinite(doorRaw) && doorRaw > 0 ? doorRaw : 1;
    const msg = menu.querySelector('#sa-addroom-msg');
    const isEditing = !!editingRoomCode;

    if (!dc || !campusId || !building || !room) {
      msg.textContent = 'Data Center, Campus, Building, and Room are required.';
      msg.classList.add('sa-addroom-error');
      return;
    }

    // When editing, the room being edited shouldn't collide with itself if
    // its code is unchanged — exclude it from the duplicate check.
    const existing = collectRoomCodes(getEffectiveTree()).filter((code) => !(isEditing && code === editingRoomCode));
    if (existing.includes(room)) {
      msg.textContent = `Room "${room}" already exists.`;
      msg.classList.add('sa-addroom-error');
      return;
    }

    let customRooms = getSetting(STORAGE_KEYS.customRooms, []);
    const customDoorOverrides = getSetting(STORAGE_KEYS.customDoorOverrides, {});

    if (isEditing) {
      customRooms = customRooms.filter((r) => r.room !== editingRoomCode);
      delete customDoorOverrides[editingRoomCode];
      if (editingRoomCode !== room) {
        // carry the favorite star over if the room code was renamed
        const favorites = getSetting(STORAGE_KEYS.favorites, []).map((f) => (f.room === editingRoomCode ? { room } : f));
        setSetting(STORAGE_KEYS.favorites, favorites);
      }
    }

    customRooms.push({ dc, campusId, campusLabel, building, room });
    setSetting(STORAGE_KEYS.customRooms, customRooms);

    if (door !== 1) customDoorOverrides[room] = door;
    else delete customDoorOverrides[room];
    setSetting(STORAGE_KEYS.customDoorOverrides, customDoorOverrides);

    editingRoomCode = null;
    renderMenu(menu);
  }

  function editCustomRoom(room, menu) {
    editingRoomCode = room;
    renderMenu(menu);
  }

  function roomRow(room, favd, isCustom) {
    return `<div class="sa-room-row">
      <span><span class="sa-fav-star ${favd ? 'sa-favd' : ''}" data-room="${room}">★</span><span class="sa-room-code">${room}</span></span>
      <span class="sa-room-actions">
        <button class="sa-enter-btn" data-room="${room}">Enter</button>
        <button class="sa-leave-btn" data-room="${room}">Leave</button>
        ${isCustom ? `<button class="sa-edit-btn" data-room="${room}">Edit</button><button class="sa-delete-btn" data-room="${room}">Delete</button>` : ''}
      </span>
    </div>`;
  }

  function isFavorite(room, favorites) { return favorites.some((f) => f.room === room); }

  function toggleFavorite(room, menu) {
    let favorites = getSetting(STORAGE_KEYS.favorites, []);
    if (isFavorite(room, favorites)) favorites = favorites.filter((f) => f.room !== room);
    else favorites.push({ room });
    setSetting(STORAGE_KEYS.favorites, favorites);
    renderMenu(menu);
  }

  function deleteCustomRoom(room, menu) {
    const customRooms = getSetting(STORAGE_KEYS.customRooms, []).filter((r) => r.room !== room);
    setSetting(STORAGE_KEYS.customRooms, customRooms);

    const customDoorOverrides = getSetting(STORAGE_KEYS.customDoorOverrides, {});
    if (room in customDoorOverrides) {
      delete customDoorOverrides[room];
      setSetting(STORAGE_KEYS.customDoorOverrides, customDoorOverrides);
    }

    const favorites = getSetting(STORAGE_KEYS.favorites, []).filter((f) => f.room !== room);
    setSetting(STORAGE_KEYS.favorites, favorites);

    if (editingRoomCode === room) editingRoomCode = null;
    renderMenu(menu);
  }

  function runFromMenu(room, direction) {
    const loc = resolveLocation(room, direction);
    if (!loc) { alert('Room not found in config: ' + room); return; }
    document.getElementById('sa-menu').classList.remove('sa-open');
    runWorkflow(loc).catch((e) => log('Workflow error', e));
  }

  function init() {
    const fab = document.createElement('div');
    fab.id = 'sa-fab';
    fab.innerHTML = '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">' +
      '<path d="M6.5 18C4.01 18 2 15.99 2 13.5C2 11.26 3.63 9.4 5.76 9.06C6.37 6.72 8.49 5 11 5C13.9 5 16.29 7.19 16.63 10C18.55 10.29 20 11.94 20 13.93C20 16.17 18.19 18 15.93 18H6.5Z" ' +
      'fill="#FF7A1A"/></svg>';
    document.body.appendChild(fab);

    const menu = buildMenu(fab);

    function openMenu() {
      editingRoomCode = null; // don't resurrect a stale edit from a previous session
      addRoomOpen = false; // keep the menu compact on a fresh open
      renderMenu(menu); // refresh recent/favorites each open
      menu.classList.add('sa-open');
      fab.classList.add('sa-fab-active');
    }

    function closeMenu() {
      menu.classList.remove('sa-open');
      fab.classList.remove('sa-fab-active');
    }

    fab.addEventListener('click', () => {
      if (menu.classList.contains('sa-open')) closeMenu();
      else openMenu();
    });

    gm.registerMenuCommand('Open Sentry Menu', () => openMenu());
    gm.registerMenuCommand('Toggle Debug Logging', () => {
      DEBUG = !DEBUG;
      setSetting(STORAGE_KEYS.debug, DEBUG);
      alert('Debug logging ' + (DEBUG ? 'ON' : 'OFF'));
    });
    gm.registerMenuCommand('Toggle Auto Submit', () => {
      const cur = getSetting(STORAGE_KEYS.autoSubmit, false);
      setSetting(STORAGE_KEYS.autoSubmit, !cur);
      alert('Auto Submit ' + (!cur ? 'ON' : 'OFF'));
    });

    log('Sentry Access Automation loaded');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
