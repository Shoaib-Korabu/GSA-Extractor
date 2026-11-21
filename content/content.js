// content/content.js
// Lightweight in-page widget for Gray Swan Arena (v2.3, incremental + parallel sync, sorted ZIP & batch opener).

(function () {
  'use strict';
  if (!window.location.hostname.includes('grayswan.ai')) return;

  function detectSlug() {
    const m = window.location.pathname.match(/\/(?:arena\/)?challenge\/([^/?#]+)/i);
    return m ? decodeURIComponent(m[1]) : '';
  }

  let currentSlug = detectSlug();
  let currentChallengeName = '';
  let currentBreakStats = null;
  let lastChats = [];
  let syncSeq = 0;
  let isSorted = true;

  try {
    chrome.storage?.local?.get(['gsa_sorted_export'], (res) => {
      if (typeof res?.gsa_sorted_export === 'boolean') {
        isSorted = res.gsa_sorted_export;
        updateSortedUI();
      }
    });
    chrome.storage?.onChanged?.addListener((changes, area) => {
      if (area !== 'local' || !changes.gsa_sorted_export) return;
      const val = changes.gsa_sorted_export.newValue;
      if (typeof val === 'boolean' && val !== isSorted) {
        isSorted = val;
        updateSortedUI();
      }
    });
  } catch (_) {}

  function sendMsg(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (resp) => {
          const err = chrome.runtime.lastError;
          if (err) resolve({ success: false, error: err.message });
          else resolve(resp || { success: false, error: 'Empty response' });
        });
      } catch (e) {
        resolve({ success: false, error: e.message });
      }
    });
  }

  function triggerBlobDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 15000);
  }

  function updateSortedUI() {
    const cb = document.getElementById('gsa-toggle-sorted');
    if (cb && cb.checked !== isSorted) cb.checked = isSorted;
    const btnDownload = document.getElementById('gsa-inpage-download');
    if (btnDownload) {
      btnDownload.textContent = isSorted ? '⬇ Download Sorted ZIP' : '⬇ Download JSON';
    }
    const btnExtract = document.getElementById('gsa-inpage-extract');
    if (btnExtract) {
      btnExtract.textContent = lastChats.length > 0 ? '⚡ Sync new chats' : '▶ Extract all chats';
    }
  }

  function downloadChats(chats, slug, sortedOpt) {
    if (!chats || !chats.length) return;
    if (typeof GSANormalizer === 'undefined' || typeof GSAZip === 'undefined') return;
    const cleanSlug = String(slug || 'challenge').replace(/[^a-zA-Z0-9_-]/g, '_');
    const ts = GSANormalizer.formatTimestampCompact(new Date());
    const useSorted = typeof sortedOpt === 'boolean' ? sortedOpt : isSorted;

    if (chats.length === 1 && !useSorted) {
      const blob = new Blob([JSON.stringify(chats[0], null, 2)], { type: 'application/json' });
      triggerBlobDownload(blob, GSANormalizer.generateChatFilename(chats[0]));
      return;
    }

    const files = GSANormalizer.buildChatZipFiles(chats, {
      slug,
      name: currentChallengeName,
      breakStats: currentBreakStats,
      isSorted: useSorted
    });

    const zipName = useSorted
      ? `gsa-${cleanSlug}-chats-sorted-${chats.length}-${ts}.zip`
      : `gsa-${cleanSlug}-chats-${chats.length}-${ts}.zip`;
    triggerBlobDownload(GSAZip.createZipBlob(files), zipName);
  }

  function setStats(s = {}) {
    const total = Number(s.total ?? 0);
    const rejected = Number(s.rejected ?? 0);
    const accepted = Number(s.accepted ?? 0);
    const totalEl = document.getElementById('gsa-stat-total');
    const rejEl = document.getElementById('gsa-stat-rejected');
    const accEl = document.getElementById('gsa-stat-accepted');
    const badge = document.getElementById('gsa-badge-count');
    const btnDownload = document.getElementById('gsa-inpage-download');

    if (totalEl) totalEl.textContent = String(total);
    if (rejEl) rejEl.textContent = String(rejected);
    if (accEl) accEl.textContent = String(accepted);

    if (badge) {
      if (total > 0) {
        badge.textContent = String(total);
        badge.classList.remove('gsa-hidden');
      } else {
        badge.textContent = '0';
        badge.classList.add('gsa-hidden');
      }
    }
    if (btnDownload) btnDownload.disabled = lastChats.length === 0;
    updateSortedUI();
  }

  function setWebsiteBreakLine(slug, breakStats, challengeName) {
    const slugEl = document.getElementById('gsa-drawer-slug');
    const siteEl = document.getElementById('gsa-website-breaks');
    if (slugEl) {
      if (!slug) slugEl.textContent = '(not on a challenge)';
      else slugEl.textContent = challengeName ? `${challengeName} (${slug})` : slug;
    }
    if (!siteEl) return;

    if (!slug || !breakStats) {
      siteEl.classList.add('gsa-empty');
      siteEl.innerHTML = slug
        ? 'Website Breaks: <strong>loading…</strong>'
        : 'Open any challenge page to sync registered breaks.';
      return;
    }

    siteEl.classList.remove('gsa-empty');
    const reg = Number(breakStats.registeredBreaks ?? 0);
    const tot = Number(breakStats.totalCombinations ?? 0);
    const scSolved = Number(breakStats.scenariosSolved ?? 0);
    const scTot = Number(breakStats.totalScenarios ?? 0);
    siteEl.innerHTML = `Website Breaks: <strong>${reg}</strong>${tot ? ` / ${tot}` : ''} &bull; Scenarios solved: <strong>${scSolved}/${scTot}</strong>`;
  }

  async function syncChallengeState(slug) {
    const seq = ++syncSeq;
    const status = document.getElementById('gsa-drawer-status');
    lastChats = [];
    setStats({ total: 0, rejected: 0, accepted: 0 });
    setWebsiteBreakLine(slug, null, '');

    if (!slug) {
      if (status) status.textContent = 'Navigate to a challenge page to extract chats.';
      return;
    }

    if (status) status.textContent = 'Syncing challenge state...';

    const baseUrl = `${location.protocol}//${location.host}`;
    const [stateResp, summaryResp] = await Promise.all([
      sendMsg({ type: 'GET_EXTRACTION_STATE', payload: { slug, baseUrl, allowFallbackLast: false } }),
      sendMsg({ type: 'GET_CHALLENGE_SUMMARY', payload: { slug, baseUrl } })
    ]);

    if (seq !== syncSeq) return; // stale async return after SPA route switch

    const entry = stateResp?.data || {};
    const summary = summaryResp?.summary || stateResp?.summary || null;

    if (Array.isArray(entry.extractedChats) && entry.challengeSlug === slug) {
      lastChats = entry.extractedChats;
      setStats(entry.stats || { total: lastChats.length, rejected: 0, accepted: 0 });
    } else {
      lastChats = [];
      setStats({ total: 0, rejected: 0, accepted: 0 });
    }

    const challengeName = summary?.challengeName || entry.challengeName || '';
    const breakStats = summary?.breakStats || entry.breakStats || null;
    currentChallengeName = challengeName;
    currentBreakStats = breakStats;
    setWebsiteBreakLine(slug, breakStats, challengeName);

    if (status) {
      if (lastChats.length > 0) {
        status.textContent = `Loaded ${lastChats.length} cached chats for ${slug}. Open popup to filter.`;
      } else if (summary) {
        status.textContent = `Synced (${summary.chatsCount || 0} chats on server). Click Extract or open popup.`;
      } else {
        status.textContent = 'Open toolbar popup for scenario/model filters.';
      }
    }
  }

  function init() {
    if (document.getElementById('gsa-extractor-floating-widget')) return;
    currentSlug = detectSlug();

    const wrap = document.createElement('div');
    wrap.id = 'gsa-extractor-floating-widget';
    wrap.innerHTML = `
      <div id="gsa-inpage-drawer" class="gsa-hidden">
        <div class="gsa-drawer-header">
          <span class="gsa-drawer-title">🦢 Arena Extractor</span>
          <button id="gsa-btn-close-drawer" class="gsa-drawer-close">×</button>
        </div>
        <div class="gsa-drawer-target">Challenge: <strong id="gsa-drawer-slug">${currentSlug || '(not on a challenge)'}</strong></div>
        <div id="gsa-website-breaks" class="gsa-drawer-site-breaks gsa-empty">Website Breaks: <strong>—</strong></div>
        <div class="gsa-drawer-stats">
          <span>Extracted <strong id="gsa-stat-total">0</strong></span>
          <span style="color:#f43f5e;">Rejected <strong id="gsa-stat-rejected">0</strong></span>
          <span style="color:#10b981;">Accepted <strong id="gsa-stat-accepted">0</strong></span>
        </div>
        <div class="gsa-drawer-sort-row">
          <label class="gsa-sort-toggle" for="gsa-toggle-sorted" title="Organize ZIP into Scenario / Status / Model subfolders">
            <input type="checkbox" id="gsa-toggle-sorted" class="gsa-sort-cb"${isSorted ? ' checked' : ''}>
            <span class="gsa-sort-slider"></span>
            <span class="gsa-sort-label">Sorted</span>
          </label>
          <span class="gsa-sort-desc">Scenario / Status / Model</span>
        </div>
        <div class="gsa-drawer-actions">
          <div class="gsa-drawer-extract-row">
            <button id="gsa-inpage-extract" class="gsa-drawer-btn gsa-drawer-btn-primary">▶ Extract all chats</button>
            <button id="gsa-inpage-full" class="gsa-drawer-btn gsa-drawer-btn-outline" title="Force full parallel re-sync from page 0">↻ Full</button>
          </div>
          <button id="gsa-inpage-download" class="gsa-drawer-btn gsa-drawer-btn-secondary" disabled>${isSorted ? '⬇ Download Sorted ZIP' : '⬇ Download JSON'}</button>
        </div>
        <div id="gsa-drawer-status" class="gsa-drawer-status">Open the toolbar popup for scenario/model filters.</div>
      </div>
      <button id="gsa-floating-toggle" class="gsa-floating-btn" title="Open Arena Extractor">
        <span class="gsa-btn-swan">🦢</span><span>Extractor</span>
        <span id="gsa-badge-count" class="gsa-btn-badge gsa-hidden">0</span>
      </button>`;
    document.body.appendChild(wrap);

    const drawer = document.getElementById('gsa-inpage-drawer');
    const status = document.getElementById('gsa-drawer-status');
    const btnExtract = document.getElementById('gsa-inpage-extract');
    const btnFull = document.getElementById('gsa-inpage-full');
    const btnDownload = document.getElementById('gsa-inpage-download');
    const toggleSorted = document.getElementById('gsa-toggle-sorted');

    if (toggleSorted) {
      toggleSorted.addEventListener('change', () => {
        isSorted = !!toggleSorted.checked;
        updateSortedUI();
        try {
          chrome.storage?.local?.set({ gsa_sorted_export: isSorted });
        } catch (_) {}
      });
    }

    document.getElementById('gsa-floating-toggle').addEventListener('click', () => {
      drawer.classList.toggle('gsa-hidden');
      if (!drawer.classList.contains('gsa-hidden') && currentSlug) {
        syncChallengeState(currentSlug);
      }
    });
    document.getElementById('gsa-btn-close-drawer').addEventListener('click', () => drawer.classList.add('gsa-hidden'));

    const runInpageSync = async (mode) => {
      const targetSlug = detectSlug();
      currentSlug = targetSlug;
      if (!targetSlug) {
        status.textContent = 'Open a Gray Swan Arena challenge page first.';
        return;
      }
      btnExtract.disabled = true;
      btnFull.disabled = true;
      btnDownload.disabled = true;
      status.textContent = mode === 'incremental'
        ? `Syncing new chats for ${targetSlug}...`
        : `Full parallel sync for ${targetSlug}...`;

      const resp = await sendMsg({
        type: 'START_EXTRACTION',
        payload: {
          slug: targetSlug,
          baseUrl: `${location.protocol}//${location.host}`,
          mode,
          concurrency: 5,
          delayMs: 0
        }
      });

      btnExtract.disabled = false;
      btnFull.disabled = false;
      if (targetSlug !== detectSlug()) return;

      if (!resp || !resp.success) {
        status.textContent = `Error: ${resp?.error || 'Extraction failed'}`;
        btnDownload.disabled = lastChats.length === 0;
        return;
      }

      lastChats = resp.chats || [];
      currentChallengeName = resp.challengeName || currentChallengeName;
      currentBreakStats = resp.breakStats || currentBreakStats;
      setStats(resp.stats || { total: lastChats.length, rejected: 0, accepted: 0 });
      setWebsiteBreakLine(targetSlug, resp.breakStats || null, resp.challengeName || '');

      const ss = resp.syncStats;
      const sec = ss && ss.elapsedMs ? `${(ss.elapsedMs / 1000).toFixed(1)}s` : '';
      const syncDetail = ss
        ? (ss.mode === 'incremental'
          ? `+${ss.newChats} new (${ss.pagesFetched}p in ${sec})`
          : `${lastChats.length} chats (${ss.pagesFetched}p in ${sec})`)
        : `${lastChats.length} chats`;

      if (isSorted && lastChats.length > 0) {
        downloadChats(lastChats, targetSlug, true);
        status.textContent = `Done — ${syncDetail} — downloaded sorted ZIP.`;
      } else {
        const warnText = Array.isArray(resp.warnings) && resp.warnings.length
          ? ` (${resp.warnings.length} warning${resp.warnings.length > 1 ? 's' : ''})`
          : '';
        status.textContent = `Done — ${syncDetail}${warnText}. Click Download or open popup.`;
      }
    };

    btnExtract.addEventListener('click', () => runInpageSync(lastChats.length > 0 ? 'incremental' : 'full'));
    btnFull.addEventListener('click', () => runInpageSync('full'));

    btnDownload.addEventListener('click', async () => {
      if (!lastChats.length && currentSlug) {
        const st = await sendMsg({ type: 'GET_EXTRACTION_STATE', payload: { slug: currentSlug } });
        lastChats = st?.data?.extractedChats || [];
        currentChallengeName = st?.data?.challengeName || currentChallengeName;
        currentBreakStats = st?.data?.breakStats || currentBreakStats;
      }
      if (!lastChats.length) { status.textContent = 'Nothing extracted yet.'; return; }
      downloadChats(lastChats, currentSlug, isSorted);
      status.textContent = isSorted
        ? `Downloaded ${lastChats.length} chat(s) in sorted ZIP.`
        : `Downloaded ${lastChats.length} chat(s).`;
    });

    // Keep widget synchronized with progress and popup extractions
    chrome.runtime.onMessage.addListener((msg) => {
      if (!msg || !msg.payload) return;
      if (msg.type === 'EXTRACTION_PROGRESS' && msg.payload.slug === currentSlug) {
        if (status && msg.payload.status) status.textContent = msg.payload.status;
      } else if (msg.type === 'EXTRACTION_COMPLETE' && msg.payload.slug === currentSlug) {
        lastChats = msg.payload.chats || [];
        setStats(msg.payload.stats || {});
        setWebsiteBreakLine(currentSlug, msg.payload.breakStats || null, msg.payload.challengeName || '');
        if (status) status.textContent = `Synced — ${lastChats.length} chats ready.`;
      }
    });

    syncChallengeState(currentSlug);
  }

  let lastUrl = location.href;
  const handleUrlCheck = () => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      const newSlug = detectSlug();
      if (newSlug !== currentSlug) {
        currentSlug = newSlug;
        syncChallengeState(newSlug);
      }
    }
  };

  window.addEventListener('popstate', handleUrlCheck);
  new MutationObserver(handleUrlCheck).observe(document, { subtree: true, childList: true });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
