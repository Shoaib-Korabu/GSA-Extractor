// popup/popup.js
// Universal Gray Swan Arena Chat Extractor popup (v2.3).
// Parallel + incremental sync, server-side scenario sync, multi-select filters, sorted ZIP, batch opener.

(function () {
  'use strict';

  const STATUS_OPTIONS = [
    { value: 'accepted', label: 'Accepted' },
    { value: 'pending', label: 'Pending' },
    { value: 'rejected', label: 'Rejected' },
    { value: 'error', label: 'Submission failed' }
  ];

  const state = {
    slug: '',
 challengeName: '',
 baseUrl: 'https://app.grayswan.ai',
 isGSA: false,
 chats: [],
 rosterModels: [],
 rosterScenarios: [],
 scenarioKeyMap: {},
 breakStats: null,
 serverTotals: null,
 filters: {
   outcomes: new Set(),
 scenarios: new Set(),
 models: new Set(),
 search: ''
 },
 menuSearch: { scenario: '', model: '' },
 openMenu: null,
 selected: new Set(),
 isSorted: true,
 extracting: false
  };

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const keyOf = (c, i) => c && c.chatId ? `id:${c.chatId}` : `idx:${i}`;
  const outcomeOf = (c) => GSANormalizer.outcomeOf(c);
  const outcomeLabel = (oc) => GSANormalizer.outcomeLabel(oc);

  function toast(msg, kind = 'info') {
    const el = document.createElement('div');
    el.className = `toast toast-${kind}`;
    el.textContent = msg;
    $('toastContainer').appendChild(el);
    setTimeout(() => el.classList.add('show'), 10);
    setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 300); }, 3200);
  }

  function assignKeys() {
    state.chats.forEach((c, i) => { c._key = keyOf(c, i); });
  }

  const send = (type, payload) => new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type, payload }, (resp) => {
        const err = chrome.runtime.lastError;
        if (err) resolve({ success: false, error: err.message });
        else resolve(resp || { success: false, error: 'Empty response' });
      });
    } catch (e) {
      resolve({ success: false, error: e.message });
    }
  });

  function effectiveSlug() {
    const override = $('challengeSlug').value.trim();
    return override || state.slug;
  }

  // ---- Tab detection & live website synchronization --------------------
  async function syncChallengeData(slug, baseUrl) {
    state.chats = [];
    state.rosterModels = [];
    state.rosterScenarios = [];
    state.scenarioKeyMap = {};
    state.breakStats = null;
    state.serverTotals = null;
    state.selected.clear();
    state.filters.outcomes.clear();
    state.filters.scenarios.clear();
    state.filters.models.clear();
    state.filters.search = '';
    state.menuSearch.scenario = '';
    state.menuSearch.model = '';
    closeAllMenus();
    $('searchInput').value = '';
    $('btnClearSearch').classList.add('hidden');

    if (!slug) {
      state.challengeName = '';
      renderChallengeHeader(state.isGSA);
      renderAll();
      return;
    }

    const [stResp, sumResp] = await Promise.all([
      send('GET_EXTRACTION_STATE', { slug, baseUrl, allowFallbackLast: false }),
                                                send('GET_CHALLENGE_SUMMARY', { slug, baseUrl })
    ]);

    const d = stResp?.data || {};
    const summary = sumResp?.summary || stResp?.summary || null;

    if (d.challengeSlug === slug) {
      state.challengeName = summary?.challengeName || d.challengeName || state.challengeName;
      state.rosterModels = (summary?.allModels?.length ? summary.allModels : d.allModels) || [];
      state.rosterScenarios = (summary?.allScenarios?.length ? summary.allScenarios : d.allScenarios) || [];
      state.scenarioKeyMap = { ...(d.scenarioKeyMap || {}), ...(summary?.scenarioKeyMap || {}) };
      state.breakStats = summary?.breakStats || d.breakStats || null;
      state.serverTotals = summary
      ? { chats: summary.chatsCount || 0, submissions: summary.submissionsCount || 0 }
      : (d.serverTotals || null);

      if (Array.isArray(d.extractedChats) && d.extractedChats.length) {
        state.chats = d.extractedChats;
        assignKeys();
      }
    } else if (summary) {
      state.challengeName = summary.challengeName || state.challengeName;
      state.rosterModels = summary.allModels || [];
      state.rosterScenarios = summary.allScenarios || [];
      state.scenarioKeyMap = summary.scenarioKeyMap || {};
      state.breakStats = summary.breakStats || null;
      state.serverTotals = { chats: summary.chatsCount || 0, submissions: summary.submissionsCount || 0 };
    }

    renderChallengeHeader(state.isGSA);
    renderAll();

    if (state.chats.length) {
      const serverChats = state.serverTotals?.chats || 0;
      const delta = serverChats > state.chats.length ? ` (${serverChats - state.chats.length} new on server)` : '';
      setProgress(100, `Loaded ${state.chats.length} cached chats for ${slug}${delta}.`);
      $('progressContainer').classList.remove('hidden');
    } else if (state.serverTotals) {
      setProgress(0, `Synced live site (${state.serverTotals.chats} chats, ${state.serverTotals.submissions} subs). Click Extract chats.`);
      $('progressContainer').classList.remove('hidden');
    } else {
      $('progressContainer').classList.add('hidden');
    }
  }

  async function detectTab(silent) {
    const info = await send('GET_ACTIVE_TAB_INFO');
    if (!info || !info.success) return info;

    state.isGSA = !!info.isGSA;
    state.baseUrl = info.baseUrl || state.baseUrl;
    state.slug = info.slug || '';
    state.challengeName = info.challengeName || '';
    $('challengeSlug').placeholder = info.slug || 'auto-detected';

    if (!info.slug && !silent) {
      toast('No challenge detected on the active tab. Open a Gray Swan Arena challenge page.', 'warn');
    }

    renderChallengeHeader(info.isGSA);
    return info;
  }

  function renderChallengeHeader(isGSA) {
    const slug = effectiveSlug();
    const name = state.challengeName || (slug ? GSANormalizer.humanizeSlug(slug) : '');
    $('challengeName').textContent = name || '—';
    $('challengeSlugText').textContent = slug || (isGSA === false ? 'not on grayswan.ai' : 'not on a challenge page');
    $('challengeCard').classList.toggle('detected', !!slug);

    const summaryEl = $('websiteSummary');
    if (!slug || (!state.breakStats && !state.serverTotals)) {
      summaryEl.innerHTML = '';
      summaryEl.classList.add('hidden');
      return;
    }

    const pills = [];
    if (state.breakStats) {
      const reg = Number(state.breakStats.registeredBreaks ?? 0);
      const tot = Number(state.breakStats.totalCombinations ?? 0);
      const scS = Number(state.breakStats.scenariosSolved ?? 0);
      const scT = Number(state.breakStats.totalScenarios ?? 0);
      pills.push(`<span class="ws-pill ws-breaks" title="Unique (scenario, model) breaks registered on website">Site Breaks: ${reg}${tot ? ` / ${tot}` : ''}</span>`);
      if (scT > 0) {
        pills.push(`<span class="ws-pill" title="Scenarios with at least one registered break">Scenarios: ${scS} / ${scT}</span>`);
      }
    }
    if (state.serverTotals && (state.serverTotals.chats || state.serverTotals.submissions)) {
      pills.push(`<span class="ws-pill">${state.serverTotals.chats || 0} chats &bull; ${state.serverTotals.submissions || 0} subs</span>`);
    }
    summaryEl.innerHTML = pills.join('');
    summaryEl.classList.toggle('hidden', pills.length === 0);
  }

  function resolveSelectedServerFilters() {
    const behaviors = [];
    const scenarioNames = [];
    for (const scenarioName of state.filters.scenarios) {
      let bSlug = state.scenarioKeyMap && state.scenarioKeyMap[scenarioName];
      if (!bSlug) {
        const fromChat = state.chats.find(c => c.scenario === scenarioName && c.behaviorId);
        if (fromChat) bSlug = fromChat.behaviorId;
      }
      if (bSlug) {
        behaviors.push(bSlug);
        scenarioNames.push(scenarioName);
      }
    }
    const models = [...state.filters.models];
    if (behaviors.length === 0 && models.length === 0) return null;

    const parts = [];
    if (scenarioNames.length === 1) parts.push(`"${scenarioNames[0]}"`);
    else if (scenarioNames.length > 1) parts.push(`${scenarioNames.length} scenarios`);
    if (models.length === 1) parts.push(models[0]);
    else if (models.length > 1) parts.push(`${models.length} models`);
    return { behaviors, models, label: parts.join(' • ') };
  }

  function updateSyncButtons() {
    const hasCache = state.chats.length > 0;
    const lbl = $('btnStartLabel');
    const icon = $('btnStartIcon');
    if (lbl) lbl.textContent = hasCache ? 'Sync new' : 'Extract chats';
    if (icon) icon.textContent = hasCache ? '⚡' : '▶';
    $('btnStart').disabled = state.extracting;
    $('btnFullSync').disabled = state.extracting;
    $('btnStop').disabled = !state.extracting;

    const scenBtn = $('btnSyncScenario');
    const sel = resolveSelectedServerFilters();
    if (sel) {
      scenBtn.textContent = `⚡ Sync filtered (${sel.label})`;
      scenBtn.classList.remove('hidden');
      scenBtn.disabled = state.extracting;
    } else {
      scenBtn.classList.add('hidden');
    }
  }

  // ---- Extraction ------------------------------------------------------
  async function startExtraction(opts = {}) {
    const slug = effectiveSlug();
    if (!slug) { toast('No challenge to extract. Open a challenge page or set a slug in Advanced.', 'warn'); return; }

    const rawMax = $('maxPages').value.trim();
    const parsedMax = rawMax === '0' ? 0 : (parseInt(rawMax, 10) || 250);
    const rawDelay = $('delayMs').value.trim();
    const parsedDelay = rawDelay === '' ? 0 : Math.max(0, parseInt(rawDelay, 10) || 0);
    const concurrency = Math.max(1, Math.min(10, parseInt($('concurrency').value, 10) || 5));

    const mode = opts.mode || (state.chats.length > 0 ? 'incremental' : 'full');
    const behaviors = Array.isArray(opts.behaviors) ? opts.behaviors : (opts.behavior ? [opts.behavior] : undefined);
    const models = Array.isArray(opts.models) ? opts.models : undefined;

    state.extracting = true;
    updateSyncButtons();
    $('progressContainer').classList.remove('hidden');
    const startMsg = (mode === 'scenario' || mode === 'filtered')
    ? `Syncing filtered (${opts.filterLabel || 'selection'}, ${concurrency}x parallel)...`
    : mode === 'incremental'
    ? `Syncing new chats & verdicts for ${slug}...`
    : `Full parallel sync (${concurrency}x) for ${slug}...`;
    setProgress(6, startMsg);

    const resp = await send('START_EXTRACTION', {
      slug,
      baseUrl: state.baseUrl,
      mode,
      behavior: opts.behavior || '',
      behaviors,
      models,
      concurrency,
      maxPages: parsedMax,
      delayMs: parsedDelay,
      fetchFullDetails: $('fetchFullDetails').checked
    });

    state.extracting = false;
    updateSyncButtons();

    if (!resp || !resp.success) {
      setProgress(100, `Error: ${resp?.error || 'extraction failed'}`, true);
      toast(resp?.error || 'Extraction failed', 'error');
      return;
    }

    state.slug = slug;
    state.challengeName = resp.challengeName || state.challengeName;
    state.chats = resp.chats || [];
    state.rosterModels = resp.allModels || state.rosterModels;
    state.rosterScenarios = resp.allScenarios || state.rosterScenarios;
    if (resp.scenarioKeyMap) state.scenarioKeyMap = { ...state.scenarioKeyMap, ...resp.scenarioKeyMap };
    state.breakStats = resp.breakStats || state.breakStats;
    state.serverTotals = resp.serverTotals || state.serverTotals;
    assignKeys();
    state.selected.clear();
    renderChallengeHeader(true);

    const ss = resp.syncStats;
    const sec = ss && ss.elapsedMs ? `${(ss.elapsedMs / 1000).toFixed(1)}s` : '';
    let summaryText;
    if (ss && ss.mode === 'incremental') {
      summaryText = `Synced +${ss.newChats} new (${ss.pagesFetched}p in ${sec}) — ${state.chats.length} total.`;
    } else if (ss && (ss.mode === 'scenario' || ss.mode === 'filtered')) {
      summaryText = `Filtered sync (+${ss.newChats} new, ${ss.pagesFetched}p in ${sec}) — ${state.chats.length} total.`;
    } else if (ss) {
      summaryText = `Full sync — ${state.chats.length} chats (${ss.pagesFetched}p in ${sec}).`;
    } else {
      summaryText = `Done — ${state.chats.length} chats (${resp.stats?.rejected || 0} rejected, ${resp.stats?.accepted || 0} accepted).`;
    }
    const warnCount = Array.isArray(resp.warnings) ? resp.warnings.length : 0;
    setProgress(100, warnCount ? `${summaryText} ${resp.warnings[0]}` : summaryText);
    if (warnCount) toast(resp.warnings[0], 'warn');

    renderAll();
  }

  function setProgress(pct, text, isError) {
    const bar = $('progressBar');
    bar.style.width = `${Math.max(0, Math.min(100, pct))}%`;
    bar.classList.toggle('error', !!isError);
    $('statusText').textContent = text;
  }

  // ---- Rendering -------------------------------------------------------
  function renderAll() {
    renderStats();
    renderFilters();
    renderList();
    updateDownloadButton();
    updateSyncButtons();
  }

  function renderStats() {
    const counts = { all: state.chats.length, rejected: 0, accepted: 0, error: 0, pending: 0 };
    for (const c of state.chats) counts[outcomeOf(c)]++;
    $('statTotalCount').textContent = counts.all;
    $('statRejectedCount').textContent = counts.rejected;
    $('statAcceptedCount').textContent = counts.accepted;
    $('statErrorCount').textContent = counts.error;
    $('statPendingCount').textContent = counts.pending;
    document.querySelectorAll('.stat-card').forEach(card => {
      const oc = card.dataset.outcome;
      const active = oc === 'all' ? state.filters.outcomes.size === 0 : state.filters.outcomes.has(oc);
      card.classList.toggle('active', active);
    });
    return counts;
  }

  function buildDropdownMeta() {
    const outcomeCounts = { accepted: 0, pending: 0, rejected: 0, error: 0 };
    const scenCounts = {};
    const modCounts = {};
    for (const c of state.chats) {
      outcomeCounts[outcomeOf(c)]++;
      if (c.scenario) scenCounts[c.scenario] = (scenCounts[c.scenario] || 0) + 1;
      if (c.model) modCounts[c.model] = (modCounts[c.model] || 0) + 1;
    }

    const scenarios = GSANormalizer.collectScenarios(state.chats, state.rosterScenarios);
    const models = GSANormalizer.collectModels(state.chats, state.rosterModels);

    for (const s of [...state.filters.scenarios]) {
      if (!scenarios.includes(s)) state.filters.scenarios.delete(s);
    }
    for (const m of [...state.filters.models]) {
      if (!models.includes(m)) state.filters.models.delete(m);
    }

    const solvedIds = new Set(state.breakStats?.solvedBehaviors || []);
    const brokenScenarios = new Set();
    for (const c of state.chats) {
      if (c.scenario && c.behaviorId && solvedIds.has(c.behaviorId)) brokenScenarios.add(c.scenario);
    }

    return {
      status: {
        btnId: 'btnDdStatus', lblId: 'lblDdStatus', menuId: 'menuDdStatus',
 title: 'Status', selectedSet: state.filters.outcomes, searchable: false,
 options: STATUS_OPTIONS.map(o => ({
   value: o.value,
   label: o.label,
   count: state.chats.length ? outcomeCounts[o.value] : null
 }))
      },
 scenario: {
   btnId: 'btnDdScenario', lblId: 'lblDdScenario', menuId: 'menuDdScenario',
 title: 'Scenario', selectedSet: state.filters.scenarios, searchable: scenarios.length > 5,
 options: scenarios.map(s => ({
   value: s,
   label: s,
   tag: brokenScenarios.has(s) ? 'broken' : '',
                              count: scenCounts[s] ?? null
 }))
 },
 model: {
   btnId: 'btnDdModel', lblId: 'lblDdModel', menuId: 'menuDdModel',
 title: 'Model', selectedSet: state.filters.models, searchable: models.length > 5,
 options: models.map(m => ({
   value: m,
   label: m,
   count: modCounts[m] ?? null
 }))
 }
    };
  }

  function updateDropdownTrigger(cfg) {
    const btn = $(cfg.btnId);
    const lbl = $(cfg.lblId);
    const size = cfg.selectedSet.size;
    if (size === 0) {
      lbl.textContent = cfg.title;
      btn.title = `${cfg.title}: All`;
    } else if (size === 1) {
      const only = [...cfg.selectedSet][0];
      const match = cfg.options.find(o => o.value === only);
      const text = match ? match.label : only;
      lbl.textContent = text;
      btn.title = `${cfg.title}: ${text}`;
    } else {
      lbl.textContent = `${cfg.title} (${size})`;
      btn.title = `${cfg.title}: ${size} selected`;
    }
    btn.classList.toggle('has-selection', size > 0);
  }

  function renderMenuOptions(kind, cfg, optsWrap) {
    const q = (state.menuSearch[kind] || '').trim().toLowerCase();
    const visible = q
    ? cfg.options.filter(o => o.label.toLowerCase().includes(q))
    : cfg.options;
    const allChecked = cfg.selectedSet.size === 0;

    const rows = [];
    if (!q) {
      rows.push(`
      <label class="multi-opt${allChecked ? ' is-checked' : ''}" data-value="__all__">
      <input type="checkbox" class="multi-opt-cb"${allChecked ? ' checked' : ''}>
      <span class="multi-box"></span>
      <span class="multi-opt-label">All</span>
      </label>`);
    }

    if (visible.length === 0) {
      rows.push(`<div class="multi-empty">No matches</div>`);
    } else {
      for (const o of visible) {
        const checked = cfg.selectedSet.has(o.value);
        rows.push(`
        <label class="multi-opt${checked ? ' is-checked' : ''}" data-value="${esc(o.value)}" title="${esc(o.label)}">
        <input type="checkbox" class="multi-opt-cb"${checked ? ' checked' : ''}>
        <span class="multi-box"></span>
        <span class="multi-opt-label">${esc(o.label)}</span>
        ${o.tag ? `<span class="multi-opt-tag">${esc(o.tag)}</span>` : ''}
        ${typeof o.count === 'number' ? `<span class="multi-opt-cnt">${o.count}</span>` : ''}
        </label>`);
      }
    }

    optsWrap.innerHTML = rows.join('');
    optsWrap.querySelectorAll('.multi-opt-cb').forEach(cb => {
      cb.addEventListener('change', () => {
        const val = cb.closest('.multi-opt').dataset.value;
        if (val === '__all__') {
          cfg.selectedSet.clear();
        } else if (cb.checked) {
          cfg.selectedSet.add(val);
        } else {
          cfg.selectedSet.delete(val);
        }
        renderMenuOptions(kind, cfg, optsWrap);
        updateDropdownTrigger(cfg);
        if (kind === 'status') renderStats();
        if (kind === 'scenario' || kind === 'model') updateSyncButtons();
        renderList();
        updateDownloadButton();
      });
    });
  }

  function renderDropdown(kind, cfg) {
    const menu = $(cfg.menuId);
    updateDropdownTrigger(cfg);

    let searchWrap = menu.querySelector('.multi-search-wrap');
    let optsWrap = menu.querySelector('.multi-opts');

    if (!optsWrap || Boolean(searchWrap) !== cfg.searchable) {
      menu.innerHTML = (cfg.searchable
      ? `<div class="multi-search-wrap"><input type="text" class="multi-search" placeholder="Filter ${esc(cfg.title.toLowerCase())}..." spellcheck="false"></div>`
      : '') + `<div class="multi-opts"></div>`;
      optsWrap = menu.querySelector('.multi-opts');
      const searchInput = menu.querySelector('.multi-search');
      if (searchInput) {
        searchInput.value = state.menuSearch[kind] || '';
        searchInput.addEventListener('input', (e) => {
          state.menuSearch[kind] = e.target.value;
          const fresh = buildDropdownMeta()[kind];
          renderMenuOptions(kind, fresh, optsWrap);
        });
      }
    } else {
      const searchInput = menu.querySelector('.multi-search');
      if (searchInput && searchInput.value !== (state.menuSearch[kind] || '')) {
        searchInput.value = state.menuSearch[kind] || '';
      }
    }

    renderMenuOptions(kind, cfg, optsWrap);
  }

  function renderFilters() {
    const cfgs = buildDropdownMeta();
    renderDropdown('status', cfgs.status);
    renderDropdown('scenario', cfgs.scenario);
    renderDropdown('model', cfgs.model);
  }

  function closeAllMenus() {
    state.openMenu = null;
    for (const [btnId, menuId] of [
      ['btnDdStatus', 'menuDdStatus'],
      ['btnDdScenario', 'menuDdScenario'],
      ['btnDdModel', 'menuDdModel']
    ]) {
      const btn = $(btnId);
      const menu = $(menuId);
      if (btn) { btn.classList.remove('open'); btn.setAttribute('aria-expanded', 'false'); }
      if (menu) menu.classList.add('hidden');
    }
  }

  function toggleMenu(kind) {
    const next = state.openMenu === kind ? null : kind;
    closeAllMenus();
    if (!next) return;
    state.openMenu = next;
    const cap = next.charAt(0).toUpperCase() + next.slice(1);
    const btn = $('btnDd' + cap);
    const menu = $('menuDd' + cap);
    btn.classList.add('open');
    btn.setAttribute('aria-expanded', 'true');
    menu.classList.remove('hidden');
    const searchInput = menu.querySelector('.multi-search');
    if (searchInput) searchInput.focus();
  }

  function getFiltered() {
    return GSANormalizer.filterChats(state.chats, state.filters);
  }

  function getDownloadTarget() {
    const filtered = getFiltered();
    if (state.selected.size === 0) return filtered;
    return filtered.filter(c => state.selected.has(c._key));
  }

  function renderList() {
    const list = $('chatsList');
    const filtered = getFiltered();
    $('emptyState').classList.toggle('hidden', state.chats.length > 0);

    if (state.chats.length === 0) {
      list.innerHTML = '';
      syncSelectAll(filtered);
      return;
    }
    if (filtered.length === 0) {
      list.innerHTML = `<div class="no-results">No conversations match the current filters.</div>`;
      syncSelectAll(filtered);
      return;
    }

    list.innerHTML = filtered.map(c => {
      const oc = outcomeOf(c);
      const checked = state.selected.has(c._key) ? ' checked' : '';
      const title = c.title && !/^\[|^\{/.test(c.title) ? c.title : (c.scenario || 'Conversation');
        const reason = c.rejectionDetails?.reason || '';
        const msgs = (c.messages || []).length;
        return `
        <div class="chat-row outcome-${oc}" data-key="${esc(c._key)}">
        <input type="checkbox" class="row-check" data-key="${esc(c._key)}"${checked}>
        <div class="chat-row-body" data-key="${esc(c._key)}">
        <div class="chat-row-top">
        <span class="chat-model">${esc(c.model)}</span>
        <span class="outcome-pill pill-${oc}">${esc(outcomeLabel(oc))}</span>
        </div>
        <div class="chat-scenario">${esc(c.scenario)}</div>
        <div class="chat-title">${esc(title.slice(0, 140))}</div>
        ${reason ? `<div class="chat-reason">${esc(reason.slice(0, 160))}</div>` : ''}
        <div class="chat-meta"><code>${esc((c.chatId || '').slice(-10))}</code> &bull; ${msgs} msgs</div>
        </div>
        </div>`;
      }).join('');

      list.querySelectorAll('.row-check').forEach(cb => {
        cb.addEventListener('change', () => {
          if (cb.checked) state.selected.add(cb.dataset.key);
          else state.selected.delete(cb.dataset.key);
          syncSelectAll(getFiltered());
          updateDownloadButton();
        });
      });
      list.querySelectorAll('.chat-row-body').forEach(body => {
        body.addEventListener('click', () => {
          const c = state.chats.find(x => x._key === body.dataset.key);
          if (c) openInspector(c);
        });
      });

      syncSelectAll(filtered);
    }

    function syncSelectAll(filtered) {
      const keys = filtered.map(c => c._key);
      const selectedVisible = keys.filter(k => state.selected.has(k)).length;
      const all = $('selectAll');
      all.checked = keys.length > 0 && selectedVisible === keys.length;
      all.indeterminate = selectedVisible > 0 && selectedVisible < keys.length;
      $('selectAllLabel').textContent = state.selected.size > 0 ? `Selected ${state.selected.size}` : 'Select all';
    }

    function updateDownloadButton() {
      const n = getDownloadTarget().length;
      $('downloadCount').textContent = `(${n})`;
      $('btnDownload').disabled = n === 0;
      const txt = $('btnDownloadText');
      if (txt) {
        if (state.isSorted) {
          txt.textContent = 'Download Sorted ZIP';
        } else {
          txt.textContent = n === 1 ? 'Download JSON' : 'Download ZIP';
        }
      }
      $('downloadHint').innerHTML = state.isSorted
      ? `Downloads as a <code>.zip</code> organized into <code>&lt;Scenario&gt;/&lt;Status&gt;/&lt;Model&gt;</code> subfolders.`
      : (n === 1
      ? 'Downloads as a single <code>.json</code> file.'
      : `Downloads as a flat <code>.zip</code> of ${n} JSON files. No 10-chat cap.`);
    }

    // ---- Download (single JSON, or ZIP of JSON files) --------------------
    function triggerBlobDownload(blob, filename) {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 15000);
    }

    function download() {
      const target = getDownloadTarget();
      if (target.length === 0) { toast('Nothing to download.', 'warn'); return; }
      const ts = GSANormalizer.formatTimestampCompact(new Date());
      const slug = (effectiveSlug() || 'challenge').replace(/[^a-zA-Z0-9_-]/g, '_');

      if (target.length === 1 && !state.isSorted) {
        const c = target[0];
        const blob = new Blob([JSON.stringify(c, null, 2)], { type: 'application/json' });
        triggerBlobDownload(blob, GSANormalizer.generateChatFilename(c));
        toast('Downloaded 1 JSON file.', 'success');
        return;
      }

      const files = GSANormalizer.buildChatZipFiles(target, {
        slug: effectiveSlug(),
                                                    name: state.challengeName,
                                                    breakStats: state.breakStats || undefined,
                                                    isSorted: state.isSorted
      });

      const isFiltered = state.selected.size > 0
      || state.filters.outcomes.size > 0
      || state.filters.scenarios.size > 0
      || state.filters.models.size > 0
      || Boolean(state.filters.search.trim());
      const scopeTag = isFiltered ? 'filtered-' : '';

      const blob = GSAZip.createZipBlob(files);
      const zipName = state.isSorted
      ? `gsa-${slug}-${scopeTag}chats-sorted-${target.length}-${ts}.zip`
      : `gsa-${slug}-${scopeTag}chats-${target.length}-${ts}.zip`;
      triggerBlobDownload(blob, zipName);
      toast(state.isSorted
      ? `Downloaded ${target.length} chats in sorted ZIP.`
      : `Downloaded ${target.length} JSON files in a ZIP.`, 'success');
    }

    // ---- Inspector -------------------------------------------------------
    let inspectChat = null;
    function openInspector(c) {
      inspectChat = c;
      const oc = outcomeOf(c);
      $('modalTitle').textContent = c.scenario || 'Conversation';
      $('modalScenario').textContent = outcomeLabel(oc);
      $('modalScenario').className = `modal-scenario-tag pill-${oc}`;
      $('modalModel').textContent = c.model;
      $('modalStatusBadge').textContent = outcomeLabel(oc);
      $('modalChatId').textContent = c.chatId || '(none)';

      $('modalDialogue').innerHTML = (c.messages || []).map(m => {
        const toolCallsHtml = Array.isArray(m.toolCalls) && m.toolCalls.length
        ? `<div class="msg-tools">${m.toolCalls.map(t => `<code>${esc(t.name)}</code>`).join(' ')}</div>`
        : '';
        const toolSummaryHtml = (m.toolCalled || m.toolCallSummary)
        ? `<div class="msg-tool-summary"><strong>Tool call:</strong> ${esc(m.toolCallSummary || (m.toolCalled ? 'invoked' : ''))}</div>`
        : '';
        const reasoningHtml = m.reasoning
        ? `<details class="msg-reasoning"><summary>Reasoning trace</summary><div class="msg-reasoning-body">${esc(m.reasoning)}</div></details>`
        : '';
        return `
        <div class="msg msg-${esc(m.role)}">
        <div class="msg-role">${esc(m.role)}</div>
        <div class="msg-content">${esc(m.content)}</div>
        ${toolSummaryHtml}
        ${toolCallsHtml}
        ${reasoningHtml}
        </div>`;
      }).join('') || '<div class="no-results">No messages.</div>';

      const sig = c.rejectionDetails?.signals || [];
      const subMeta = c.submissionMeta
      ? `<div class="sig-line"><strong>Submission:</strong> grade=${esc(c.submissionMeta.gradeStatus || 'n/a')}${c.submissionMeta.appealStatus ? `, appeal=${esc(c.submissionMeta.appealStatus)}` : ''}${c.submissionMeta.manualStatus ? `, manual=${esc(c.submissionMeta.manualStatus)}` : ''}</div>`
      : '';
      $('modalSignals').innerHTML = `
      <div class="sig-line"><strong>Outcome:</strong> ${esc(c.rejectionDetails?.outcome)} (${esc(c.rejectionDetails?.confidence)})</div>
      <div class="sig-line"><strong>Reason:</strong> ${esc(c.rejectionDetails?.reason || '')}</div>
      ${subMeta}
      <div class="sig-list">${sig.length ? sig.map(s => `<code>${esc(s)}</code>`).join('') : '<em>no signals</em>'}</div>`;

      $('modalRawJson').textContent = JSON.stringify(c, null, 2);
      switchTab('messages');
      $('inspectModal').classList.remove('hidden');
    }

    function switchTab(name) {
      document.querySelectorAll('.modal-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
      document.querySelectorAll('.tab-pane').forEach(p => p.classList.toggle('active', p.id === 'tab' + name.charAt(0).toUpperCase() + name.slice(1)));
    }

    // ---- Wire up ---------------------------------------------------------
    function wire() {
      $('btnDetect').addEventListener('click', async () => {
        const info = await detectTab(false);
        await syncChallengeData(effectiveSlug(), info?.baseUrl || state.baseUrl);
      });
      $('challengeSlug').addEventListener('change', async () => {
        await syncChallengeData(effectiveSlug(), state.baseUrl);
      });
      $('btnStart').addEventListener('click', () => startExtraction({ mode: state.chats.length > 0 ? 'incremental' : 'full' }));
      $('btnFullSync').addEventListener('click', () => startExtraction({ mode: 'full' }));
      $('btnSyncScenario').addEventListener('click', () => {
        const sel = resolveSelectedServerFilters();
        if (!sel) { toast('Select at least one scenario or model filter first.', 'warn'); return; }
        startExtraction({ mode: 'filtered', behaviors: sel.behaviors, models: sel.models, filterLabel: sel.label });
      });
      $('btnStop').addEventListener('click', () => send('STOP_EXTRACTION', { slug: effectiveSlug() }));
      $('btnDownload').addEventListener('click', download);
      $('btnClearData').addEventListener('click', async () => {
        const slug = effectiveSlug();
        await send('CLEAR_EXTRACTION_DATA', { slug });
        state.chats = [];
        state.selected.clear();
        renderAll();
        toast(slug ? `Cleared stored chats for ${slug}.` : 'Cleared.', 'info');
      });

      document.querySelectorAll('.stat-card').forEach(card => {
        card.addEventListener('click', (e) => {
          const oc = card.dataset.outcome;
          const outcomes = state.filters.outcomes;
          if (oc === 'all') {
            outcomes.clear();
          } else if (e.shiftKey || e.ctrlKey || e.metaKey) {
            if (outcomes.has(oc)) outcomes.delete(oc);
            else outcomes.add(oc);
          } else if (outcomes.size === 1 && outcomes.has(oc)) {
            outcomes.clear();
          } else {
            outcomes.clear();
            outcomes.add(oc);
          }
          renderStats();
          renderDropdown('status', buildDropdownMeta().status);
          renderList();
          updateDownloadButton();
        });
      });

      $('btnDdStatus').addEventListener('click', (e) => { e.stopPropagation(); toggleMenu('status'); });
      $('btnDdScenario').addEventListener('click', (e) => { e.stopPropagation(); toggleMenu('scenario'); });
      $('btnDdModel').addEventListener('click', (e) => { e.stopPropagation(); toggleMenu('model'); });

      document.addEventListener('click', (e) => {
        if (state.openMenu && !e.target.closest('.multi-dd')) closeAllMenus();
      });
        document.addEventListener('keydown', (e) => {
          if (e.key !== 'Escape') return;
          if (state.openMenu) closeAllMenus();
          else if (!$('inspectModal').classList.contains('hidden')) $('inspectModal').classList.add('hidden');
        });

          $('searchInput').addEventListener('input', (e) => {
            state.filters.search = e.target.value;
            $('btnClearSearch').classList.toggle('hidden', !e.target.value);
            renderList(); updateDownloadButton();
          });
          $('btnClearSearch').addEventListener('click', () => {
            $('searchInput').value = ''; state.filters.search = '';
            $('btnClearSearch').classList.add('hidden');
            renderList(); updateDownloadButton();
          });

          $('selectAll').addEventListener('change', (e) => {
            const filtered = getFiltered();
            if (e.target.checked) filtered.forEach(c => state.selected.add(c._key));
            else filtered.forEach(c => state.selected.delete(c._key));
            renderList(); updateDownloadButton();
          });

          $('toggleSorted').addEventListener('change', (e) => {
            state.isSorted = !!e.target.checked;
            try {
              chrome.storage?.local?.set({ gsa_sorted_export: state.isSorted });
            } catch (_) {}
            updateDownloadButton();
          });

          $('btnCloseModal').addEventListener('click', () => $('inspectModal').classList.add('hidden'));
          $('inspectModal').addEventListener('click', (e) => { if (e.target.id === 'inspectModal') $('inspectModal').classList.add('hidden'); });
          document.querySelectorAll('.modal-tab').forEach(t => t.addEventListener('click', () => switchTab(t.dataset.tab)));

          $('btnCopyPrompt').addEventListener('click', async () => {
            if (!inspectChat) return;
            const u = (inspectChat.messages || []).find(m => m.role === 'user');
            try {
              await navigator.clipboard.writeText(u?.content || inspectChat.title || '');
              toast('Prompt copied.', 'success');
            } catch (e) {
              toast(`Copy failed: ${e.message}`, 'error');
            }
          });

          $('btnCopyJson').addEventListener('click', async () => {
            if (!inspectChat) return;
            try {
              await navigator.clipboard.writeText(JSON.stringify(inspectChat, null, 2));
              toast('JSON copied.', 'success');
            } catch (e) {
              toast(`Copy failed: ${e.message}`, 'error');
            }
          });

          $('btnDownloadCurrentJson').addEventListener('click', () => {
            if (!inspectChat) return;
            const blob = new Blob([JSON.stringify(inspectChat, null, 2)], { type: 'application/json' });
            triggerBlobDownload(blob, GSANormalizer.generateChatFilename(inspectChat));
            toast('Downloaded 1 JSON file.', 'success');
          });

          chrome.runtime.onMessage.addListener((msg) => {
            if (!msg) return;
            if (msg.type === 'EXTRACTION_PROGRESS') {
              const p = msg.payload || {};
              if (p.slug && p.slug !== effectiveSlug()) return;
              const pct = typeof p.pct === 'number'
              ? p.pct
              : (p.totalPages ? Math.min(92, Math.round(((p.page || 0) / p.totalPages) * 90)) : Math.min(90, 10 + (p.page || 0) * 6));
              setProgress(pct, p.status || 'Working...');
            } else if (msg.type === 'EXTRACTION_ERROR') {
              const p = msg.payload || {};
              if (p.slug && p.slug !== effectiveSlug()) return;
              setProgress(100, `Error: ${p.error}`, true);
            }
          });
          try {
            chrome.storage?.onChanged?.addListener((changes, area) => {
              if (area !== 'local' || !changes.gsa_sorted_export) return;
              const val = changes.gsa_sorted_export.newValue;
              if (typeof val === 'boolean' && val !== state.isSorted) {
                state.isSorted = val;
                const cb = $('toggleSorted');
                if (cb) cb.checked = state.isSorted;
                updateDownloadButton();
              }
            });
          } catch (_) {}
    }
    async function init() {
      try {
        chrome.storage?.local?.get(['gsa_sorted_export'], (res) => {
          if (typeof res?.gsa_sorted_export === 'boolean') {
            state.isSorted = res.gsa_sorted_export;
          }
          const cb = $('toggleSorted');
          if (cb) cb.checked = state.isSorted;
          updateDownloadButton();
        });
      } catch (_) {}
      wire();
      const info = await detectTab(true);
      await syncChallengeData(effectiveSlug(), info?.baseUrl || state.baseUrl);
    }

    document.addEventListener('DOMContentLoaded', init);
  })();
