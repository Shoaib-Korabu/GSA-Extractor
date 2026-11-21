// content/batch-opener.js
// Gray Swan Arena Batch Mode — 1-Click Multi-Tab Opener.
// Scoped strictly to the selected/expanded batch attempt (#12, #11, etc.).
// Injects a "🚀 Open all (N)" button into the attempt card header/sub-row.

(function () {
  'use strict';
  if (!window.location.hostname.includes('grayswan.ai')) return;

  const INJECTED_CLASS = 'gsa-batch-open-btn';
  const ATTR_PROCESSED = 'data-gsa-opener-ready';
  let observer = null;
  let scanTimer = null;

  /**
   * Checks if current page is in batch mode.
   */
  function isBatchView() {
    return (
      window.location.search.includes('batchGroupId=') ||
      Boolean(document.querySelector('.batch-block-scroll, div[data-block-key]')) ||
      /batch\s+mode/i.test(document.body.innerText.slice(0, 1000))
    );
  }

  /**
   * Extracts model chat URLs from an expanded attempt card.
   * Priority: model chat links `a[href*="chatId="]` (the `↗` links next to model names).
   * Fallback: submission links `a[href*="submissionId="]`.
   */
  function extractAttemptUrls(cardEl) {
    if (!cardEl) return [];

    const urls = [];
    const seen = new Set();

    // Primary: look inside the batch results list
    const list = cardEl.querySelector('ul[aria-label*="Batch results"], ul');
    const scope = list || cardEl;

    // 1. Gather all model chat links (View chat ↗)
    const chatAnchors = scope.querySelectorAll('a[href*="chatId="]');
    for (const a of chatAnchors) {
      const rawHref = a.getAttribute('href');
      if (!rawHref) continue;
      const fullUrl = new URL(rawHref, window.location.origin).href;
      if (!seen.has(fullUrl)) {
        seen.add(fullUrl);
        urls.push(fullUrl);
      }
    }

    // 2. If no chat links found, check for submission links
    if (urls.length === 0) {
      const subAnchors = scope.querySelectorAll('a[href*="submissionId="]');
      for (const a of subAnchors) {
        const rawHref = a.getAttribute('href');
        if (!rawHref) continue;
        const fullUrl = new URL(rawHref, window.location.origin).href;
        if (!seen.has(fullUrl)) {
          seen.add(fullUrl);
          urls.push(fullUrl);
        }
      }
    }

    return urls;
  }

  /**
   * Dispatches the URL list to the background service worker to spawn a new window.
   */
  function launchBatchWindow(urls, btn) {
    if (!urls || urls.length === 0) {
      if (btn) {
        btn.textContent = '⚠ No links found';
        setTimeout(() => updateBtnDisplay(btn, 0), 2000);
      }
      return;
    }

    if (btn) {
      btn.disabled = true;
      btn.innerHTML = `<span class="gsa-bo-icon">⏳</span> Opening ${urls.length}...`;
    }

    try {
      chrome.runtime.sendMessage(
        { type: 'OPEN_BATCH_WINDOW', urls },
        (resp) => {
          if (chrome.runtime.lastError || !resp || resp.status !== 'OK') {
            // Fallback: sequential tab creation
            chrome.runtime.sendMessage(
              { type: 'OPEN_BATCH_TABS_SEQUENTIAL', urls },
              (resp2) => {
                if (btn) {
                  btn.disabled = false;
                  if (resp2 && resp2.status === 'OK') {
                    btn.innerHTML = `<span class="gsa-bo-icon">✅</span> Opened ${resp2.count}`;
                  } else {
                    btn.innerHTML = `<span class="gsa-bo-icon">❌</span> Error`;
                  }
                  setTimeout(() => updateBtnDisplay(btn, urls.length), 3000);
                }
              }
            );
            return;
          }

          if (btn) {
            btn.disabled = false;
            btn.innerHTML = `<span class="gsa-bo-icon">✅</span> Opened ${resp.count}`;
            setTimeout(() => updateBtnDisplay(btn, urls.length), 3000);
          }
        }
      );
    } catch (err) {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = `<span class="gsa-bo-icon">❌</span> ${err.message}`;
        setTimeout(() => updateBtnDisplay(btn, urls.length), 3000);
      }
    }
  }

  function updateBtnDisplay(btn, count) {
    if (!btn) return;
    btn.innerHTML = `<span class="gsa-bo-icon">🚀</span> Open in new window <span class="gsa-bo-count">(${count})</span>`;
    btn.title = `Open all ${count} model chats in a dedicated new browser window`;
  }

  /**
   * Injects or updates the 1-click open button inside a specific attempt card.
   */
  function processCard(card) {
    // Check if attempt card has an accordion button
    const accordionBtn = card.querySelector('button[aria-expanded]');
    if (!accordionBtn) return;

    const isExpanded = accordionBtn.getAttribute('aria-expanded') === 'true';

    // Find the attempt badge (#10, #11, etc.)
    const badgeEl = accordionBtn.querySelector('span[class*="font-mono"], span');
    const attemptText = badgeEl ? badgeEl.textContent.trim() : '#';

    // Target injection container:
    // When expanded, Gray Swan has a status sub-row directly under the accordion button:
    // <div class="... flex min-h-6 items-center gap-2 ..."> with text like "22 rejected"
    const subRow = card.querySelector('div[class*="pl-9"], div[class*="pl-(--space-54)"], div.sticky > div.flex');
    const targetContainer = subRow || accordionBtn.parentElement;
    if (!targetContainer) return;

    let btn = targetContainer.querySelector(`.${INJECTED_CLASS}`);

    if (!isExpanded) {
      // If card is collapsed, remove button if present to prevent opening stale/hidden tabs
      if (btn) btn.remove();
      return;
    }

    // Card is EXPANDED: extract model links
    const urls = extractAttemptUrls(card);
    const count = urls.length;
    if (count === 0) return;

    if (btn) {
      // Already injected, update count if changed
      const countEl = btn.querySelector('.gsa-bo-count');
      if (countEl && countEl.textContent !== `(${count})`) {
        updateBtnDisplay(btn, count);
      }
      return;
    }

    // Create new button
    btn = document.createElement('button');
    btn.type = 'button';
    btn.className = INJECTED_CLASS;
    btn.setAttribute(ATTR_PROCESSED, attemptText);
    updateBtnDisplay(btn, count);

    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();

      // Freshly query URLs from THIS card only at click time
      const latestUrls = extractAttemptUrls(card);
      launchBatchWindow(latestUrls, btn);
    });

    // Place button cleanly:
    // If subRow has a maximize button (`title="View full prompt"` or `aria-label="View full prompt"`),
    // insert right before it. Otherwise append.
    const maxBtn = targetContainer.querySelector('button[title*="full prompt"], button[aria-label*="full prompt"]');
    if (maxBtn) {
      targetContainer.insertBefore(btn, maxBtn);
    } else {
      targetContainer.appendChild(btn);
    }
  }

  /**
   * Scans all attempt cards currently in DOM.
   */
  function scanAttempts() {
    if (!isBatchView()) return;

    // Gray Swan attempt cards use `div[data-block-key]`
    let cards = document.querySelectorAll('div[data-block-key]');

    // Fallback: look for cards containing accordion buttons with #N badges
    if (!cards || cards.length === 0) {
      const btns = document.querySelectorAll('button[aria-expanded]');
      const set = new Set();
      btns.forEach(b => {
        if (/#\d+/.test(b.textContent)) {
          const card = b.closest('div[class*="rounded"], div[class*="border"]') || b.parentElement?.parentElement;
          if (card) set.add(card);
        }
      });
      cards = Array.from(set);
    }

    cards.forEach(card => processCard(card));
  }

  function scheduleScan() {
    if (scanTimer) clearTimeout(scanTimer);
    scanTimer = setTimeout(scanAttempts, 150);
  }

  function setupObserver() {
    if (observer) observer.disconnect();
    observer = new MutationObserver((mutations) => {
      let shouldScan = false;
      for (const m of mutations) {
        if (m.type === 'childList' && (m.addedNodes.length > 0 || m.removedNodes.length > 0)) {
          shouldScan = true;
          break;
        }
        if (m.type === 'attributes' && (m.attributeName === 'aria-expanded' || m.attributeName === 'class')) {
          shouldScan = true;
          break;
        }
      }
      if (shouldScan) scheduleScan();
    });

    const target = document.querySelector('.batch-block-scroll, #chatElement, main') || document.body;
    observer.observe(target, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['aria-expanded', 'class']
    });
  }

  function init() {
    scanAttempts();
    setupObserver();

    // Handle SPA route changes
    let lastUrl = window.location.href;
    const urlCheck = () => {
      if (window.location.href !== lastUrl) {
        lastUrl = window.location.href;
        setTimeout(() => {
          scanAttempts();
          setupObserver();
        }, 300);
      }
    };
    window.addEventListener('popstate', urlCheck);
    new MutationObserver(urlCheck).observe(document, { subtree: true, childList: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
