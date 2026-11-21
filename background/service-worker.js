// background/service-worker.js
// Service worker for Gray Swan Arena Chat Extractor (v2.3.0, per-challenge persistent storage + incremental/parallel/filtered sync + batch opener).

importScripts(
  '../lib/heuristics.js',
  '../lib/normalizer.js',
  '../lib/zip-writer.js',
  '../lib/api-client.js'
);

let activeClient = null;
const DEFAULT_BASE_URL = 'https://app.grayswan.ai';

function emptyExtractionEntry(slug = '', baseUrl = DEFAULT_BASE_URL) {
  return {
    challengeSlug: slug,
    challengeName: slug ? GSANormalizer.humanizeSlug(slug) : '',
    baseUrl,
    extractedChats: [],
    modelMap: {},
    scenarioMap: {},
    scenarioKeyMap: {},
    allModels: [],
    allScenarios: [],
    breakStats: null,
    lastExtractedAt: null,
    extractionStatus: 'idle',
    stats: { total: 0, rejected: 0, accepted: 0, errors: 0, pending: 0 },
    counts: { chats: 0, submissions: 0 },
    serverTotals: { chats: 0, submissions: 0 },
    truncated: false,
    warnings: []
  };
}

const LEGACY_KEYS = [
  'challengeSlug', 'challengeName', 'baseUrl', 'extractedChats',
  'modelMap', 'scenarioMap', 'lastExtractedAt', 'extractionStatus', 'stats'
];

const entryKey = (slug) => `gsa_entry::${slug}`;
const summaryKey = (slug) => `gsa_summary::${slug}`;

/**
 * One-time automatic migration from v2.1 single-blob `extractionsBySlug` / `summariesBySlug`
 * into dedicated per-challenge persistent keys (`gsa_entry::<slug>`, `gsa_summary::<slug>`).
 * Reading/writing one challenge never deserializes other challenges, and all challenge
 * caches persist permanently across browser closes, reloads, and full OS reboots.
 */
async function migrateStorageIfNeeded() {
  const cur = await chrome.storage.local.get([
    'gsa_storage_v22', 'gsa_slugs_index', 'lastActiveSlug',
    'extractionsBySlug', 'summariesBySlug', ...LEGACY_KEYS
  ]);
  const patch = {};
  const toRemove = LEGACY_KEYS.filter(k => cur[k] !== undefined);

  const slugsSet = new Set(Array.isArray(cur.gsa_slugs_index) ? cur.gsa_slugs_index : []);

  if (cur.extractionsBySlug && typeof cur.extractionsBySlug === 'object') {
    for (const [slug, entry] of Object.entries(cur.extractionsBySlug)) {
      if (!slug || !entry || typeof entry !== 'object') continue;
      patch[entryKey(slug)] = entry;
      slugsSet.add(slug);
    }
    toRemove.push('extractionsBySlug');
  }

  if (cur.summariesBySlug && typeof cur.summariesBySlug === 'object') {
    for (const [slug, sum] of Object.entries(cur.summariesBySlug)) {
      if (!slug || !sum || typeof sum !== 'object') continue;
      patch[summaryKey(slug)] = sum;
      slugsSet.add(slug);
    }
    toRemove.push('summariesBySlug');
  }

  if (!cur.gsa_storage_v22) {
    patch.gsa_storage_v22 = true;
    patch.gsa_slugs_index = Array.from(slugsSet);
    if (typeof cur.lastActiveSlug !== 'string') patch.lastActiveSlug = '';
  }

  if (Object.keys(patch).length) await chrome.storage.local.set(patch);
  if (toRemove.length) await chrome.storage.local.remove(toRemove);
}

async function readChallengeStore(slug, baseUrl = DEFAULT_BASE_URL) {
  await migrateStorageIfNeeded();
  const keys = ['lastActiveSlug', 'gsa_slugs_index'];
  if (slug) keys.push(entryKey(slug), summaryKey(slug));
  const data = await chrome.storage.local.get(keys);
  return {
    entry: slug && data[entryKey(slug)] ? data[entryKey(slug)] : emptyExtractionEntry(slug, baseUrl),
    hasEntry: Boolean(slug && data[entryKey(slug)]),
    summary: slug ? (data[summaryKey(slug)] || null) : null,
    lastActiveSlug: typeof data.lastActiveSlug === 'string' ? data.lastActiveSlug : '',
    slugsIndex: Array.isArray(data.gsa_slugs_index) ? data.gsa_slugs_index : []
  };
}

async function writeChallengeStore(slug, { entry, summary, setLastActive = false }) {
  await migrateStorageIfNeeded();
  const { gsa_slugs_index } = await chrome.storage.local.get(['gsa_slugs_index']);
  const slugsSet = new Set(Array.isArray(gsa_slugs_index) ? gsa_slugs_index : []);
  if (slug) slugsSet.add(slug);

  const patch = { gsa_slugs_index: Array.from(slugsSet) };
  if (slug && entry !== undefined) patch[entryKey(slug)] = entry;
  if (slug && summary !== undefined) patch[summaryKey(slug)] = summary;
  if (setLastActive && slug) patch.lastActiveSlug = slug;
  await chrome.storage.local.set(patch);
}

chrome.runtime.onInstalled.addListener(async () => {
  await migrateStorageIfNeeded();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // ── Batch Opener: open all model chats in a new window ──
  if (message.type === 'OPEN_BATCH_WINDOW' && Array.isArray(message.urls) && message.urls.length > 0) {
    chrome.windows.create({ url: message.urls, focused: true, type: 'normal' }, (win) => {
      if (chrome.runtime.lastError) {
        sendResponse({ status: 'ERROR', error: chrome.runtime.lastError.message });
      } else {
        sendResponse({ status: 'OK', windowId: win?.id, count: message.urls.length });
      }
    });
    return true;
  }
  if (message.type === 'OPEN_BATCH_TABS_SEQUENTIAL' && Array.isArray(message.urls) && message.urls.length > 0) {
    (async () => {
      try {
        const win = await chrome.windows.create({ url: message.urls[0], focused: true, type: 'normal' });
        for (let i = 1; i < message.urls.length; i++) {
          await chrome.tabs.create({ windowId: win.id, url: message.urls[i], active: false });
        }
        sendResponse({ status: 'OK', windowId: win.id, count: message.urls.length });
      } catch (err) {
        sendResponse({ status: 'ERROR', error: err.message });
      }
    })();
    return true;
  }

  (async () => {
    try {
      switch (message.type) {
        case 'GET_ACTIVE_TAB_INFO': {
          sendResponse({ success: true, ...(await detectActiveTabInfo()) });
          break;
        }
        case 'LIST_CHALLENGES': {
          const info = await detectActiveTabInfo();
          const client = new GSAClient({ baseUrl: info.baseUrl });
          const challenges = await client.listChallenges().catch(() => []);
          sendResponse({ success: true, challenges });
          break;
        }
        case 'GET_CHALLENGE_SUMMARY': {
          const p = message.payload || {};
          const slug = String(p.slug || '').trim();
          const baseUrl = p.baseUrl || DEFAULT_BASE_URL;
          if (!slug) {
            sendResponse({ success: false, error: 'Missing challenge slug' });
            break;
          }
          const st = await readChallengeStore(slug, baseUrl);
          try {
            const client = new GSAClient({ baseUrl });
            const summary = await client.getChallengeSummary(slug);

            // Synchronize any cached extraction header without erasing stored chats.
            let updatedEntry;
            if (st.hasEntry) {
              updatedEntry = { ...st.entry };
              if (summary.challengeName) updatedEntry.challengeName = summary.challengeName;
              if (summary.breakStats) updatedEntry.breakStats = summary.breakStats;
              if (Array.isArray(summary.allModels) && summary.allModels.length) updatedEntry.allModels = summary.allModels;
              if (Array.isArray(summary.allScenarios) && summary.allScenarios.length) updatedEntry.allScenarios = summary.allScenarios;
              if (summary.scenarioKeyMap) updatedEntry.scenarioKeyMap = summary.scenarioKeyMap;
            }
            await writeChallengeStore(slug, { summary, entry: updatedEntry });
            sendResponse({ success: true, summary });
          } catch (err) {
            if (st.summary) {
              sendResponse({ success: true, summary: { ...st.summary, stale: true }, warning: err.message });
            } else {
              sendResponse({ success: false, error: err.message });
            }
          }
          break;
        }
        case 'START_EXTRACTION': {
          const p = message.payload || {};
          const maxPagesVal = p.maxPages === 0 || p.maxPages === '0' ? 0 : (parseInt(p.maxPages, 10) || 250);
          const delayVal = (p.delayMs !== undefined && p.delayMs !== null && p.delayMs !== '')
            ? Math.max(0, parseInt(p.delayMs, 10) || 0)
            : 0;
          const concurrencyVal = Math.max(1, Math.min(10, parseInt(p.concurrency, 10) || 5));
          const result = await runExtraction({
            slug: String(p.slug || '').trim(),
            baseUrl: p.baseUrl,
            mode: p.mode || undefined,
            behavior: String(p.behavior || '').trim(),
            behaviors: Array.isArray(p.behaviors) ? p.behaviors : undefined,
            models: Array.isArray(p.models) ? p.models : undefined,
            delayMs: delayVal,
            concurrency: concurrencyVal,
            maxPages: maxPagesVal,
            fetchFullDetails: !!p.fetchFullDetails
          });
          sendResponse({ success: true, ...result });
          break;
        }
        case 'STOP_EXTRACTION': {
          const p = message.payload || {};
          if (activeClient) { activeClient.abort(); activeClient = null; }
          const st = await readChallengeStore(String(p.slug || '').trim());
          const targetSlug = String(p.slug || st.lastActiveSlug || '').trim();
          if (targetSlug) {
            const cur = await readChallengeStore(targetSlug);
            if (cur.hasEntry) {
              await writeChallengeStore(targetSlug, { entry: { ...cur.entry, extractionStatus: 'stopped' } });
            }
          }
          await updateBadge('');
          sendResponse({ success: true, message: 'Extraction stopped' });
          break;
        }
        case 'GET_EXTRACTION_STATE': {
          const p = message.payload || {};
          await migrateStorageIfNeeded();
          let targetSlug = String(p.slug || '').trim();
          if (!targetSlug && p.allowFallbackLast) {
            const { lastActiveSlug } = await chrome.storage.local.get(['lastActiveSlug']);
            targetSlug = lastActiveSlug || '';
          }
          const st = await readChallengeStore(targetSlug, p.baseUrl || DEFAULT_BASE_URL);
          sendResponse({
            success: true,
            data: st.entry,
            summary: st.summary,
            lastActiveSlug: st.lastActiveSlug
          });
          break;
        }
        case 'CLEAR_EXTRACTION_DATA': {
          const p = message.payload || {};
          const slug = String(p.slug || '').trim();
          await migrateStorageIfNeeded();
          if (slug) {
            await chrome.storage.local.remove([entryKey(slug)]);
          } else {
            const { gsa_slugs_index } = await chrome.storage.local.get(['gsa_slugs_index']);
            const keysToRemove = (Array.isArray(gsa_slugs_index) ? gsa_slugs_index : []).map(entryKey);
            if (keysToRemove.length) await chrome.storage.local.remove(keysToRemove);
            await chrome.storage.local.set({ lastActiveSlug: '' });
          }
          await updateBadge('');
          sendResponse({ success: true });
          break;
        }
        default:
          sendResponse({ success: false, error: `Unknown message type: ${message.type}` });
      }
    } catch (err) {
      console.error('Service worker message error:', err);
      sendResponse({ success: false, error: err.message });
    }
  })();
  return true;
});

/** Parses slug, clean title, and base origin from a browser tab record. */
function parseTabInfo(tab) {
  if (!tab || !tab.url) return { isGSA: false, slug: '', challengeName: '', baseUrl: DEFAULT_BASE_URL };
  try {
    const url = new URL(tab.url);
    const isGSA = url.hostname.includes('grayswan.ai');
    const baseUrl = isGSA ? `${url.protocol}//${url.host}` : DEFAULT_BASE_URL;
    const match = url.pathname.match(/\/(?:arena\/)?challenge\/([^/?#]+)/i);
    const slug = match ? decodeURIComponent(match[1]) : '';

    let challengeName = '';
    if (slug && tab.title) {
      let clean = tab.title.split(/[|–—\-]\s*(?:Gray\s*Swan|GSA|Arena)/i)[0].trim();
      clean = clean.replace(/\s+Chat$/i, '').trim();
      if (clean && !/^gray\s*swan$|^arena$/i.test(clean)) challengeName = clean;
    }
    return { isGSA, slug, challengeName, baseUrl, tabId: tab.id };
  } catch {
    return { isGSA: false, slug: '', challengeName: '', baseUrl: DEFAULT_BASE_URL };
  }
}

/** Reads slug / name / origin from the active tab (with fallback if popup is opened as its own tab). */
async function detectActiveTabInfo() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.url && !tab.url.startsWith('chrome-extension://')) {
      return parseTabInfo(tab);
    }

    // Fallback when popup.html is opened directly inside a browser tab.
    if (tab && tab.url && tab.url.startsWith('chrome-extension://')) {
      const extUrl = new URL(tab.url);
      const paramSlug = extUrl.searchParams.get('slug');
      const gsaTabs = await chrome.tabs.query({ url: ['https://app.grayswan.ai/*', 'https://*.grayswan.ai/*'] });
      const parsedGsa = (gsaTabs || [])
        .map(t => ({ t, info: parseTabInfo(t) }))
        .sort((a, b) => {
          const score = (x) => (x.info.slug ? 4 : 0) + (x.t.windowId === tab.windowId ? 2 : 0) + (x.t.lastAccessed ? 1 : 0);
          return score(b) - score(a) || (b.t.lastAccessed || 0) - (a.t.lastAccessed || 0);
        });
      if (paramSlug) {
        const matched = parsedGsa.find(x => x.info.slug === paramSlug);
        return matched ? matched.info : { isGSA: true, slug: paramSlug, challengeName: '', baseUrl: DEFAULT_BASE_URL, tabId: parsedGsa[0]?.t.id };
      }
      if (parsedGsa.length) return parsedGsa[0].info;
    }
    return { isGSA: false, slug: '', challengeName: '', baseUrl: DEFAULT_BASE_URL };
  } catch {
    return { isGSA: false, slug: '', challengeName: '', baseUrl: DEFAULT_BASE_URL };
  }
}

async function runExtraction({ slug, baseUrl, mode, behavior, behaviors, models, delayMs = 0, concurrency = 5, maxPages = 250, fetchFullDetails = false }) {
  if (!slug) throw new Error('No challenge detected. Open a Gray Swan Arena challenge page first.');
  const effectiveBase = baseUrl || DEFAULT_BASE_URL;
  activeClient = new GSAClient({ baseUrl: effectiveBase, delayMs, concurrency });

  const st = await readChallengeStore(slug, effectiveBase);
  const prev = st.entry;
  const existingChats = Array.isArray(prev.extractedChats) ? prev.extractedChats : [];
  const prevTruncated = !!prev.truncated;

  await writeChallengeStore(slug, {
    entry: { ...prev, challengeSlug: slug, baseUrl: effectiveBase, extractionStatus: 'running' },
    setLastActive: true
  });
  await updateBadge('…', '#3b82f6');

  const onProgress = async (progress) => {
    try { await chrome.runtime.sendMessage({ type: 'EXTRACTION_PROGRESS', payload: { slug, ...progress } }); } catch {}
  };

  try {
    const extracted = await activeClient.extractUnified(slug, {
      mode,
      behavior,
      behaviors,
      models,
      concurrency,
      maxPages,
      fetchFullDetails,
      existingChats,
      prevTruncated,
      onProgress,
      normalizer: GSANormalizer,
      heuristics: GSAHeuristics
    });

    const stats = { total: extracted.chats.length, rejected: 0, accepted: 0, errors: 0, pending: 0 };
    for (const chat of extracted.chats) {
      const outcome = GSANormalizer.outcomeOf(chat);
      if (outcome === 'rejected') stats.rejected++;
      else if (outcome === 'accepted') stats.accepted++;
      else if (outcome === 'error') stats.errors++;
      else stats.pending++;
    }

    const nowIso = new Date().toISOString();
    const resolvedName = extracted.challengeName || GSANormalizer.humanizeSlug(slug);

    const entry = {
      challengeSlug: slug,
      challengeName: resolvedName,
      baseUrl: effectiveBase,
      extractedChats: extracted.chats,
      modelMap: extracted.modelMap || {},
      scenarioMap: extracted.scenarioMap || {},
      scenarioKeyMap: extracted.scenarioKeyMap || prev.scenarioKeyMap || {},
      allModels: extracted.allModels || [],
      allScenarios: extracted.allScenarios || [],
      breakStats: extracted.breakStats || null,
      lastExtractedAt: nowIso,
      extractionStatus: 'complete',
      stats,
      counts: extracted.counts || { chats: extracted.chats.length, submissions: 0 },
      serverTotals: extracted.serverTotals || { chats: extracted.chats.length, submissions: 0 },
      truncated: !!extracted.truncated,
      warnings: extracted.warnings || [],
      syncStats: extracted.syncStats || null
    };

    const nextSummary = extracted.breakStats
      ? {
          slug,
          challengeName: resolvedName,
          breakStats: extracted.breakStats,
          chatsCount: extracted.serverTotals?.chats ?? extracted.chats.length,
          submissionsCount: extracted.serverTotals?.submissions ?? extracted.counts?.submissions ?? 0,
          allModels: extracted.allModels || [],
          allScenarios: extracted.allScenarios || [],
          modelMap: extracted.modelMap || {},
          scenarioMap: extracted.scenarioMap || {},
          scenarioKeyMap: entry.scenarioKeyMap,
          fetchedAt: nowIso
        }
      : undefined;

    await writeChallengeStore(slug, { entry, summary: nextSummary, setLastActive: true });

    await updateBadge(String(extracted.chats.length), extracted.chats.length ? '#10b981' : '#64748b');

    const payload = {
      slug,
      chats: extracted.chats,
      modelMap: entry.modelMap,
      scenarioMap: entry.scenarioMap,
      scenarioKeyMap: entry.scenarioKeyMap,
      allModels: entry.allModels,
      allScenarios: entry.allScenarios,
      challengeName: resolvedName,
      breakStats: entry.breakStats,
      stats,
      counts: entry.counts,
      serverTotals: entry.serverTotals,
      truncated: entry.truncated,
      warnings: entry.warnings,
      syncStats: entry.syncStats,
      extractedAt: nowIso
    };
    try { await chrome.runtime.sendMessage({ type: 'EXTRACTION_COMPLETE', payload }); } catch {}

    return payload;
  } catch (err) {
    const cur = await readChallengeStore(slug, effectiveBase);
    if (cur.hasEntry) {
      await writeChallengeStore(slug, { entry: { ...cur.entry, extractionStatus: 'error' } });
    }
    await updateBadge('!', '#ef4444');
    try { await chrome.runtime.sendMessage({ type: 'EXTRACTION_ERROR', payload: { slug, error: err.message } }); } catch {}
    throw err;
  } finally {
    activeClient = null;
  }
}

async function updateBadge(text, color = '#10b981') {
  try {
    await chrome.action.setBadgeText({ text: text || '' });
    if (color) await chrome.action.setBadgeBackgroundColor({ color });
  } catch {}
}
