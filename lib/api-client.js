// lib/api-client.js
// Universal client for Gray Swan Arena.
// Discovers challenge metadata, models, scenarios, appeals, and live registered
// break counts directly from SvelteKit `__data.json` + `/panels/*` endpoints.

class GSAClient {
  constructor(options = {}) {
    this.baseUrl = options.baseUrl || 'https://app.grayswan.ai';
    this.delayMs = options.delayMs ?? 0;
    this.concurrency = Math.max(1, Math.min(10, Number(options.concurrency) || 5));
    this.maxRetries = options.maxRetries ?? 2;
    this.abortController = null;
  }

  abort() {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }

  async sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  /** Authenticated GET using the browser session cookies with retry/backoff on 429 & 5xx. */
  async request(path, queryParams = {}) {
    const url = new URL(path, this.baseUrl);
    for (const [k, v] of Object.entries(queryParams)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }

    let lastErr = null;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const signal = this.abortController ? this.abortController.signal : undefined;
      if (signal && signal.aborted) throw new Error('Extraction cancelled by user');

      let response;
      try {
        response = await fetch(url.toString(), {
          method: 'GET',
          headers: { 'Accept': 'application/json, text/plain, */*', 'X-Requested-With': 'XMLHttpRequest' },
          credentials: 'include',
          signal
        });
      } catch (err) {
        if (err.name === 'AbortError') throw new Error('Extraction cancelled by user');
        lastErr = new Error(`Network error connecting to Gray Swan Arena: ${err.message}`);
        if (attempt < this.maxRetries) {
          await this.sleep(500 * (attempt + 1));
          continue;
        }
        throw lastErr;
      }

      if (response.status === 401 || response.status === 403) {
        throw new Error(`Authentication required (${response.status}). Please log into ${this.baseUrl} in your browser.`);
      }

      if (response.status === 429 || (response.status >= 500 && response.status < 600)) {
        lastErr = new Error(`Gray Swan Arena API error (${response.status}): ${response.statusText}`);
        lastErr.status = response.status;
        if (attempt < this.maxRetries) {
          const retryAfter = parseInt(response.headers.get('retry-after') || '', 10);
          const backoffMs = !Number.isNaN(retryAfter) && retryAfter > 0
            ? Math.min(10000, retryAfter * 1000)
            : 600 * (attempt + 1) * (response.status === 429 ? 2 : 1);
          await this.sleep(backoffMs);
          continue;
        }
        throw lastErr;
      }

      if (!response.ok) {
        const err = new Error(`Gray Swan Arena API error (${response.status}): ${response.statusText}`);
        err.status = response.status;
        throw err;
      }

      const contentType = response.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) {
        const text = await response.text();
        if (text.includes('<!DOCTYPE html>') || text.includes('<html')) {
          throw new Error(`Session expired or login redirect detected. Please refresh your session at ${this.baseUrl}.`);
        }
        try { return JSON.parse(text); } catch { throw new Error(`Unexpected non-JSON response from ${path}`); }
      }
      return await response.json();
    }
    throw lastErr || new Error(`Request failed for ${path}`);
  }

  /** Like request() but swallows only non-auth / non-abort failures. */
  async tryRequest(path, queryParams = {}) {
    try { return await this.request(path, queryParams); }
    catch (err) {
      if (/Authentication required|Session expired|cancelled/i.test(err.message)) throw err;
      return null;
    }
  }

  async getChallengeDataJson(slug) {
    if (!slug) return null;
    const raw = await this.tryRequest(`/arena/challenge/${encodeURIComponent(slug)}/__data.json`);
    return GSAClient.parseDataJson(raw);
  }

  async getFilterOptions(slug) {
    if (!slug) return null;
    return await this.tryRequest(`/arena/challenge/${encodeURIComponent(slug)}/panels/filter-options`);
  }

  async getBatches(slug) {
    if (!slug) return null;
    return await this.tryRequest(`/arena/challenge/${encodeURIComponent(slug)}/panels/batches`);
  }

  async getChatsPage(slug, page = 0, limit = 50, behavior = '', model = '') {
    const params = { page, limit, sort: 'recent' };
    if (behavior) params.behavior = behavior;
    if (model) params.model = model;
    return await this.request(`/arena/challenge/${encodeURIComponent(slug)}/panels/chats`, params);
  }

  async getSubmissionsPage(slug, page = 0, limit = 50, behavior = '', model = '') {
    const params = { page, limit, sort: 'recent' };
    if (behavior) params.behavior = behavior;
    if (model) params.model = model;
    return await this.request(`/arena/challenge/${encodeURIComponent(slug)}/panels/submissions`, params);
  }

  async getChatDetail(slug, chatId) {
    if (!chatId) return null;
    const candidatePaths = [
      `/arena/challenge/${encodeURIComponent(slug)}/panels/chat/${encodeURIComponent(chatId)}`,
      `/arena/challenge/${encodeURIComponent(slug)}/chats/${encodeURIComponent(chatId)}`,
      `/arena/challenge/${encodeURIComponent(slug)}/chat/${encodeURIComponent(chatId)}`,
      `/arena/chat/${encodeURIComponent(chatId)}`,
      `/arena/challenge/${encodeURIComponent(slug)}/panels/chats/${encodeURIComponent(chatId)}`
    ];
    for (const path of candidatePaths) {
      const data = await this.tryRequest(path);
      if (data && (data.messages || data.chat?.messages || data.data?.messages)) {
        return data.chat || data.data || data;
      }
    }
    return null;
  }

  // ----- SvelteKit devalue decoder & website break calculation -----------

  /**
   * Unflattens a SvelteKit devalue payload node array (`node.data`) into plain
   * JSON-safe JS values (`ObjectId`/`Date`/`BigInt` -> strings, `Set` -> arrays,
   * `Map` -> plain objects). Survives cyclic references via pre-registered cache.
   */
  static unflattenDevalue(arr) {
    if (!Array.isArray(arr) || arr.length === 0) return null;
    const cache = new Map();

    const hydrate = (idx) => {
      if (typeof idx !== 'number') return idx;
      if (idx === -1) return undefined;
      if (idx === -2) return null;
      if (idx === -3) return NaN;
      if (idx === -4) return Infinity;
      if (idx === -5) return -Infinity;
      if (idx === -6) return -0;
      if (idx < 0 || idx >= arr.length) return undefined;
      if (cache.has(idx)) return cache.get(idx);

      const raw = arr[idx];
      if (raw === null || typeof raw !== 'object') {
        cache.set(idx, raw);
        return raw;
      }

      if (Array.isArray(raw)) {
        const tag = raw[0];
        if (typeof tag === 'string') {
          if (tag === 'Date' || tag === 'ObjectId' || tag === 'BigInt' || tag === 'URL' || tag === 'URLSearchParams') {
            const val = typeof raw[1] === 'number' ? hydrate(raw[1]) : raw[1];
            const strVal = val === undefined || val === null ? '' : String(val);
            cache.set(idx, strVal);
            return strVal;
          }
          if (tag === 'RegExp') {
            const pat = typeof raw[1] === 'number' ? hydrate(raw[1]) : raw[1];
            const flg = raw.length > 2 ? (typeof raw[2] === 'number' ? hydrate(raw[2]) : raw[2]) : '';
            const out = { pattern: pat || '', flags: flg || '' };
            cache.set(idx, out);
            return out;
          }
          if (tag === 'Set') {
            const out = [];
            cache.set(idx, out);
            for (let i = 1; i < raw.length; i++) out.push(hydrate(raw[i]));
            return out;
          }
          if (tag === 'Map') {
            const out = {};
            cache.set(idx, out);
            for (let i = 1; i + 1 < raw.length; i += 2) {
              const k = String(hydrate(raw[i]));
              out[k] = hydrate(raw[i + 1]);
            }
            return out;
          }
          if (tag === 'null' && raw[1] && typeof raw[1] === 'object') {
            const out = {};
            cache.set(idx, out);
            for (const [k, vIdx] of Object.entries(raw[1])) out[k] = hydrate(vIdx);
            return out;
          }
        }

        const out = [];
        cache.set(idx, out);
        for (const itemIdx of raw) out.push(hydrate(itemIdx));
        return out;
      }

      const out = {};
      cache.set(idx, out);
      for (const [k, vIdx] of Object.entries(raw)) {
        out[k] = hydrate(vIdx);
      }
      return out;
    };

    return hydrate(0);
  }

  /**
   * Parses `/arena/challenge/{slug}/__data.json` response and extracts the
   * challenge node (`challengeInfo`, `modelMap`, `modelIdNameMap`, etc.) and root node.
   */
  static parseDataJson(raw) {
    if (!raw || !Array.isArray(raw.nodes)) return null;
    const decodedNodes = [];
    let challengeNode = null;
    let rootNode = null;

    for (let i = 0; i < raw.nodes.length; i++) {
      const node = raw.nodes[i];
      if (!node || node.type !== 'data' || !Array.isArray(node.data)) {
        decodedNodes.push(null);
        continue;
      }
      const unflattened = GSAClient.unflattenDevalue(node.data);
      decodedNodes.push(unflattened);
      if (i === 0) rootNode = unflattened;
      if (unflattened && (unflattened.challengeInfo || unflattened.behaviorIdToBehaviorMap || unflattened.modelListsByWave)) {
        challengeNode = unflattened;
      }
    }

    if (!challengeNode && decodedNodes[2]) challengeNode = decodedNodes[2];
    if (!challengeNode) return null;

    return { rootNode, challengeNode, nodes: decodedNodes };
  }

  /** Builds lookup key matching Arena frontend `Td(modelId, classifierId, wave)`. */
  static makeModelIndexKey(modelId, classifierId = null, wave = undefined) {
    const id = String(modelId || '').trim();
    const cls = classifierId !== undefined && classifierId !== null && String(classifierId).trim() !== ''
      ? String(classifierId).trim()
      : null;
    if (typeof wave === 'number' && !Number.isNaN(wave)) {
      return `${id}:${cls ?? ''}:${wave}`;
    }
    return cls ? `${id}:${cls}` : id;
  }

  /**
   * Replicates Arena's website break-count calculation (`Bv4MNIV6.js` Qe/X/$e/et).
   * Counts unique `(scenario, model)` pairs broken in active waves, distinct from
   * raw accepted submission count (`successfulSubmissionCount`).
   */
  static computeBreakStats(challengeNode, nowMs = Date.now()) {
    if (!challengeNode || typeof challengeNode !== 'object') return null;

    const info = challengeNode.challengeInfo || {};
    const waves = Array.isArray(info.waves) ? info.waves : [];
    const modelMap = challengeNode.modelMap || {};
    const modelListsByWave = challengeNode.modelListsByWave || {};
    const modelMapByBehavior = challengeNode.modelMapByBehavior || {};
    const behaviorMap = challengeNode.behaviorIdToBehaviorMap || {};
    const appeals = Array.isArray(challengeNode.appeals) ? challengeNode.appeals : [];

    // Collect displayed behavior IDs matching frontend displayedBehaviorIds.
    const collectedDisp = [];
    const pushBehaviorRef = (b) => {
      if (!b) return;
      if (typeof b === 'string') collectedDisp.push(b);
      else if (typeof b === 'object') {
        const id = b.behaviorId || b.behavior_id || b.id || b._id;
        if (id) collectedDisp.push(String(id));
      }
    };
    if (Array.isArray(info.behaviors)) info.behaviors.forEach(pushBehaviorRef);
    if (Array.isArray(info.categories)) {
      for (const cat of info.categories) {
        if (cat && Array.isArray(cat.behaviors)) cat.behaviors.forEach(pushBehaviorRef);
      }
    }
    if (Array.isArray(info.areas)) {
      for (const area of info.areas) {
        if (area && Array.isArray(area.behaviors)) area.behaviors.forEach(pushBehaviorRef);
      }
    }
    if (collectedDisp.length === 0) {
      for (const id of Object.keys(behaviorMap)) collectedDisp.push(id);
      for (const w of waves) {
        if (Array.isArray(w?.behaviors)) w.behaviors.forEach(pushBehaviorRef);
      }
    }
    const displayedSet = new Set(collectedDisp.filter(Boolean));

    const effectiveWaves = waves.length > 0
      ? waves
      : [{ start_time: null, behaviors: Array.from(displayedSet) }];

    const perWave = [];
    let registeredBreaks = 0;
    let totalCombinations = 0;
    const solvedBehaviors = new Set();
    const activeBehaviors = new Set();
    const fallbackModels = Object.keys(modelMap).map(name => ({ name, disabled: false, deprecated: false }));

    for (let waveIdx = 0; waveIdx < effectiveWaves.length; waveIdx++) {
      const wave = effectiveWaves[waveIdx] || {};
      const startMs = wave.start_time ? new Date(wave.start_time).getTime() : NaN;
      const started = Number.isNaN(startMs) || startMs <= nowMs;

      const waveRawBehaviors = Array.isArray(wave.behaviors) ? wave.behaviors : [];
      const waveBehaviors = [];
      const seenBeh = new Set();
      for (const b of waveRawBehaviors) {
        const bId = typeof b === 'string' ? b : String(b?.behaviorId || b?.id || '');
        if (!bId || !displayedSet.has(bId) || seenBeh.has(bId)) continue;
        seenBeh.add(bId);
        waveBehaviors.push(bId);
      }

      if (!started) {
        perWave.push({ waveIndex: waveIdx, started: false, completed: 0, total: 0, scenariosSolved: 0, totalScenarios: waveBehaviors.length });
        continue;
      }

      waveBehaviors.forEach(b => activeBehaviors.add(b));

      const waveModelsRaw = modelListsByWave[waveIdx + 1]
        ?? modelListsByWave[String(waveIdx + 1)]
        ?? modelListsByWave[1]
        ?? modelListsByWave['1']
        ?? fallbackModels;
      const waveModels = Array.isArray(waveModelsRaw) ? waveModelsRaw : [];

      let waveCompleted = 0;
      let waveTotal = 0;
      const waveSolvedBehaviors = new Set();

      for (const m of waveModels) {
        if (!m || m.disabled || m.deprecated) continue;
        if (Array.isArray(m.excluded_waves) && m.excluded_waves.includes(waveIdx)) continue;

        const mmGlobal = modelMap[m.name] || {};
        const disabledGlobal = new Set((mmGlobal.disabledBehaviors || []).map(String));
        if (Array.isArray(m.disabled_behaviors)) {
          for (const db of m.disabled_behaviors) disabledGlobal.add(String(db));
        }
        const succGlobal = new Set((mmGlobal.successfulSubmissionBehaviors || []).map(String));

        for (const behId of waveBehaviors) {
          const mmBeh = modelMapByBehavior?.[behId]?.[m.name];
          const disBeh = disabledGlobal.has(behId)
            || (Array.isArray(mmBeh?.disabledBehaviors) && mmBeh.disabledBehaviors.includes(behId));
          if (disBeh) continue;

          waveTotal += 1;
          const isSucc = succGlobal.has(behId)
            || (Array.isArray(mmBeh?.successfulSubmissionBehaviors) && mmBeh.successfulSubmissionBehaviors.includes(behId));
          if (isSucc) {
            waveCompleted += 1;
            solvedBehaviors.add(behId);
            waveSolvedBehaviors.add(behId);
          }
        }
      }

      registeredBreaks += waveCompleted;
      totalCombinations += waveTotal;
      perWave.push({
        waveIndex: waveIdx,
        started: true,
        completed: waveCompleted,
        total: waveTotal,
        scenariosSolved: waveSolvedBehaviors.size,
        totalScenarios: waveBehaviors.length
      });
    }

    let acceptedSubmissions = 0;
    const modelBreakdown = {};
    for (const [mName, mm] of Object.entries(modelMap)) {
      if (!mm || typeof mm !== 'object') continue;
      const succCount = Number(mm.successfulSubmissionCount || 0);
      const uniqueBehs = Array.isArray(mm.successfulSubmissionBehaviors)
        ? Array.from(new Set(mm.successfulSubmissionBehaviors.map(String)))
        : [];
      acceptedSubmissions += succCount;
      modelBreakdown[mName] = {
        uniqueBreaks: uniqueBehs.length,
        successfulSubmissionCount: succCount,
        successfulSubmissionBehaviors: uniqueBehs,
        communityBreaks: Number(mm.breaks || 0)
      };
    }

    return {
      registeredBreaks,
      totalCombinations,
      scenariosSolved: solvedBehaviors.size,
      totalScenarios: activeBehaviors.size || displayedSet.size || Object.keys(behaviorMap).length,
      acceptedSubmissions,
      solvedBehaviors: Array.from(solvedBehaviors),
      appealsCount: appeals.length,
      chatsCount: Number(challengeNode.chatsCount ?? 0),
      submissionsCount: Number(challengeNode.submissionsCount ?? 0),
      perWave,
      modelBreakdown
    };
  }

  /** Parses list responses into an array of items (tolerant to wrappers). */
  extractItems(responseData) {
    if (!responseData) return [];
    if (Array.isArray(responseData)) return responseData;
    const listKeys = ['userSubmissions', 'userChats', 'chats', 'submissions', 'models', 'agents', 'behaviors', 'scenarios', 'batches', 'challenges', 'data', 'items', 'results', 'records', 'conversations'];
    for (const key of listKeys) if (Array.isArray(responseData[key])) return responseData[key];
    const wrapperKeys = ['data', 'result', 'payload', 'body', 'response'];
    for (const w of wrapperKeys) {
      const nested = responseData[w];
      if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
        for (const key of listKeys) if (Array.isArray(nested[key])) return nested[key];
      }
    }
    if (responseData.chat && typeof responseData.chat === 'object') return [responseData.chat];
    if (responseData.submission && typeof responseData.submission === 'object') return [responseData.submission];
    return [];
  }

  // ----- Roster / metadata discovery -------------------------------------

  /**
   * Discovers authoritative challenge metadata from:
   *  1) `/arena/challenge/{slug}/__data.json` (complete roster, wave map, appeals, break math)
   *  2) `/arena/challenge/{slug}/panels/filter-options`
   *  3) `/arena/challenge/{slug}/panels/batches` (`batchGroupId` AND `behaviorId` -> `scenarioName`)
   */
  async discoverRoster(slug) {
    const modelMap = {};
    const modelIdIndex = {};
    const scenarioMap = {};
    const behaviorWaveMap = {};
    const appealsMap = {};
    const batchMap = new Map();
    const allModelsSet = new Set();
    const allScenariosSet = new Set();
    let challengeName = '';
    let breakStats = null;
    let chatsCount = 0;
    let submissionsCount = 0;

    const [parsedData, filterOpts, batchesResp] = await Promise.all([
      this.getChallengeDataJson(slug),
      this.getFilterOptions(slug),
      this.getBatches(slug)
    ]);

    if (parsedData && parsedData.challengeNode) {
      const cn = parsedData.challengeNode;
      const info = cn.challengeInfo || {};
      challengeName = info.name || info.title || '';
      chatsCount = Number(cn.chatsCount ?? 0);
      submissionsCount = Number(cn.submissionsCount ?? 0);

      // 1. Model lookup index (matching Arena `Td(model_id, classifier_id, wave)`).
      const idNameMap = cn.modelIdNameMap || {};
      for (const [mIdRaw, entries] of Object.entries(idNameMap)) {
        const list = Array.isArray(entries) ? entries : [entries];
        for (const entry of list) {
          if (!entry || !entry.name) continue;
          const mId = this._id(entry.model_id || entry._id || mIdRaw);
          if (!mId) continue;
          const name = String(entry.name).trim();
          const cls = entry.classifier_id ? String(entry.classifier_id).trim() : null;
          const wave = typeof entry.wave === 'number' ? entry.wave : undefined;

          if (!modelMap[mId]) modelMap[mId] = name;
          if (!modelIdIndex[mId]) modelIdIndex[mId] = name;
          modelIdIndex[GSAClient.makeModelIndexKey(mId, cls, wave)] = name;
          if (cls) modelIdIndex[GSAClient.makeModelIndexKey(mId, cls)] = name;
          if (typeof wave === 'number') modelIdIndex[GSAClient.makeModelIndexKey(mId, null, wave)] = name;
          if (!entry.disabled && !entry.deprecated) allModelsSet.add(name);
        }
      }

      // Also scan modelListsByWave to ensure every wave model is indexed.
      const waveLists = cn.modelListsByWave || {};
      for (const [waveKey, entries] of Object.entries(waveLists)) {
        if (!Array.isArray(entries)) continue;
        const waveNum = parseInt(waveKey, 10);
        for (const entry of entries) {
          if (!entry || !entry.name) continue;
          const mId = this._id(entry.model_id || entry._id);
          const name = String(entry.name).trim();
          const cls = entry.classifier_id ? String(entry.classifier_id).trim() : null;
          if (mId) {
            if (!modelMap[mId]) modelMap[mId] = name;
            if (!modelIdIndex[mId]) modelIdIndex[mId] = name;
            if (!Number.isNaN(waveNum)) {
              modelIdIndex[GSAClient.makeModelIndexKey(mId, cls, waveNum)] = name;
              modelIdIndex[GSAClient.makeModelIndexKey(mId, null, waveNum)] = name;
            }
          }
          if (!entry.disabled && !entry.deprecated) allModelsSet.add(name);
        }
      }

      // If modelMap from challenge node exists by name, include active model names too.
      if (allModelsSet.size === 0 && cn.modelMap) {
        for (const name of Object.keys(cn.modelMap)) allModelsSet.add(name);
      }

      // 2. Complete behavior/scenario map (`behaviorIdToBehaviorMap`).
      const bMap = cn.behaviorIdToBehaviorMap || {};
      for (const [bKeyRaw, bObj] of Object.entries(bMap)) {
        if (!bObj || typeof bObj !== 'object') continue;
        const bKey = String(bObj.behaviorId || bKeyRaw || '').toLowerCase().trim();
        const bName = bObj.name ? String(bObj.name).trim() : '';
        if (bKey && bName) {
          scenarioMap[bKey] = bName;
          allScenariosSet.add(bName);
        }
        if (bKey && typeof bObj.wave === 'number') {
          behaviorWaveMap[bKey] = bObj.wave;
        }
      }

      // 3. Human/auto appeal map keyed by submission_id.
      if (Array.isArray(cn.appeals)) {
        for (const ap of cn.appeals) {
          if (!ap || typeof ap !== 'object') continue;
          const subId = this._id(ap.submission_id || ap.submissionId);
          if (subId) {
            appealsMap[subId] = {
              _id: this._id(ap._id),
              submission_id: subId,
              appeal_status: ap.appeal_status || null,
              manual_status: ap.manual_status || null,
              appeal_analysis: ap.appeal_analysis || null
            };
          }
        }
      }

      breakStats = GSAClient.computeBreakStats(cn);
    }

    // Supplement with `/panels/filter-options`
    if (filterOpts && typeof filterOpts === 'object') {
      if (Array.isArray(filterOpts.behaviors)) {
        for (const b of filterOpts.behaviors) {
          if (!b || typeof b !== 'object') continue;
          const key = String(b.id || b.behaviorId || b._id || '').toLowerCase().trim();
          const name = b.name ? String(b.name).trim() : '';
          if (key && name) {
            if (!scenarioMap[key]) scenarioMap[key] = name;
            allScenariosSet.add(name);
          }
        }
      }
      if (Array.isArray(filterOpts.models)) {
        this.harvestModelList(filterOpts.models, modelMap);
      }
    }

    // Supplement with `/panels/batches` (`batchGroupId` AND `behaviorId` -> `scenarioName`)
    if (batchesResp) {
      for (const b of this.extractItems(batchesResp)) {
        const bgId = this._id(b.batchGroupId || b.batch_group_id || b.batchId || b.id || b._id);
        const behKey = String(b.behaviorId || b.behavior_id || b.behavior || '').toLowerCase().trim();
        const name = (b.scenarioName || b.scenario || b.behaviorName || b.name || '').trim();
        if (bgId && name) {
          batchMap.set(bgId, name);
          scenarioMap[`batchgroup:${bgId}`] = name;
        }
        if (behKey && name) {
          if (!scenarioMap[behKey]) scenarioMap[behKey] = name;
          allScenariosSet.add(name);
        }
      }
    }

    const scenarioKeyMap = {};
    for (const [k, name] of Object.entries(scenarioMap)) {
      if (!k || !name || k.startsWith('batchgroup:')) continue;
      if (!scenarioKeyMap[name]) scenarioKeyMap[name] = k;
    }

    return {
      challengeName,
      modelMap,
      modelIdIndex,
      scenarioMap,
      scenarioKeyMap,
      behaviorWaveMap,
      appealsMap,
      batchMap,
      breakStats,
      chatsCount,
      submissionsCount,
      allModels: Array.from(allModelsSet).sort((a, b) => a.localeCompare(b)),
      allScenarios: Array.from(allScenariosSet).sort((a, b) => a.localeCompare(b))
    };
  }

  /** Convenience method used by popup & content widget to sync website counts immediately. */
  async getChallengeSummary(slug) {
    if (!slug) throw new Error('Challenge slug is required');
    const roster = await this.discoverRoster(slug);
    return {
      slug,
      challengeName: roster.challengeName,
      breakStats: roster.breakStats,
      chatsCount: roster.chatsCount || roster.breakStats?.chatsCount || 0,
      submissionsCount: roster.submissionsCount || roster.breakStats?.submissionsCount || 0,
      allModels: roster.allModels,
      allScenarios: roster.allScenarios,
      modelMap: roster.modelMap,
      scenarioMap: roster.scenarioMap,
      scenarioKeyMap: roster.scenarioKeyMap,
      fetchedAt: new Date().toISOString()
    };
  }

  harvestModelList(list, modelMap) {
    if (!Array.isArray(list)) return;
    for (const m of list) {
      if (!m || typeof m !== 'object') continue;
      const id = this._id(m.id || m._id || m.modelId || m.model_id || m.agentId || m.agent_id);
      const name = m.name || m.modelName || m.model_name || m.alias || m.displayName || m.label;
      if (id && name) modelMap[id] = String(name);
    }
  }

  harvestBehaviorList(list, scenarioMap) {
    if (!Array.isArray(list)) return;
    for (const b of list) {
      if (!b || typeof b !== 'object') continue;
      const key = String(b.id || b._id || b.behaviorId || b.behavior_id || b.key || b.slug || '').toLowerCase().trim();
      const name = b.name || b.scenarioName || b.behaviorName || b.title || b.label;
      if (key && name) scenarioMap[key] = String(name);
    }
  }

  _id(val) {
    if (val === undefined || val === null) return '';
    if (typeof val === 'object') return val.$oid ? String(val.$oid) : String(val._id || val.id || '');
    return String(val).trim();
  }

  /** Best-effort list of challenges the user can see (from SvelteKit data or endpoints). */
  async listChallenges() {
    const out = [];
    const seen = new Set();
    const pushItem = (c) => {
      if (!c || typeof c !== 'object') return;
      const slug = c.slug || c.challengeSlug || c.key;
      if (!slug || seen.has(String(slug))) return;
      seen.add(String(slug));
      out.push({ slug: String(slug), name: c.name || c.title || c.displayName || String(slug) });
    };

    for (const p of ['/challenges/__data.json', '/arena/__data.json']) {
      const resp = await this.tryRequest(p);
      if (!resp || !Array.isArray(resp.nodes)) continue;
      for (const n of resp.nodes) {
        if (!n || n.type !== 'data' || !Array.isArray(n.data)) continue;
        const decoded = GSAClient.unflattenDevalue(n.data);
        if (decoded && Array.isArray(decoded.challenges)) decoded.challenges.forEach(pushItem);
      }
      if (out.length) return out;
    }

    for (const p of ['/arena/challenges', '/arena/panels/challenges']) {
      const resp = await this.tryRequest(p);
      if (!resp) continue;
      this.extractItems(resp).forEach(pushItem);
      if (out.length) break;
    }
    return out;
  }

  // ----- Concurrency, Incremental & Parallel Pagination ------------------

  /** Lightweight async semaphore capping concurrent HTTP requests across chats + submissions. */
  static _createSemaphore(maxConcurrent = 5) {
    let active = 0;
    const queue = [];
    const limit = Math.max(1, maxConcurrent);
    return {
      async run(fn) {
        if (active >= limit) {
          await new Promise(resolve => queue.push(resolve));
        }
        active++;
        try {
          return await fn();
        } finally {
          active--;
          if (queue.length > 0) queue.shift()();
        }
      }
    };
  }

  static _itemTimestampMs(item) {
    if (!item || typeof item !== 'object') return 0;
    const raw = item.created_at || item.createdAt || item.timestamp || item.chat?.created_at || item.chat?.createdAt;
    if (!raw) return 0;
    if (typeof raw === 'number') return raw < 1e12 ? raw * 1000 : raw;
    const ms = new Date(raw).getTime();
    return Number.isNaN(ms) ? 0 : ms;
  }

  /**
   * Fast paginator supporting both:
   *  - Incremental wave-parallel early-stop (when `knownIds.size > 0`)
   *  - Full parallel page pool (when `knownIds` is empty)
   */
  async _paginateFast({
    firstResp,
    fetchPage,
    getItemId,
    maxPages = 250,
    concurrency = 5,
    semaphore = null,
    knownIds = null,
    stopAfterTs = null,
    onPageDone = () => {}
  }) {
    const sem = semaphore || GSAClient._createSemaphore(concurrency);
    const limitPages = maxPages === 0 ? Infinity : maxPages;
    const isIncremental = Boolean(knownIds && knownIds.size > 0);

    const pagesByIndex = new Map();
    const seenIds = new Set();
    let truncated = false;
    let pagesFetched = 0;

    let page0 = firstResp;
    let startPage = 0;
    let page0Items = page0 ? this.extractItems(page0) : [];
    if (page0Items.length === 0) {
      // Fallback for 1-indexed endpoints if page 0 was empty
      try {
        const retry1 = await sem.run(() => fetchPage(1));
        pagesFetched++;
        const retryItems = this.extractItems(retry1);
        if (retryItems.length > 0) {
          page0 = retry1;
          page0Items = retryItems;
          startPage = 1;
        }
      } catch (err) {
        if (/Authentication required|Session expired|cancelled/i.test(err.message)) throw err;
      }
    } else {
      pagesFetched++;
    }

    const serverTotal = typeof page0?.total === 'number' ? page0.total : null;
    const pageSize = page0Items.length || Number(page0?.limit) || 50;
    const respTotalPages = page0?.totalPages || page0?.total_pages
      || page0?.pagination?.totalPages || page0?.pagination?.total_pages
      || page0?.meta?.totalPages
      || (serverTotal !== null && pageSize > 0 ? Math.ceil(serverTotal / pageSize) : null);

    const totalPagesCap = respTotalPages !== null
      ? Math.min(limitPages, respTotalPages)
      : limitPages;

    const analyzePage = (items) => {
      let newCount = 0;
      let knownCount = 0;
      let oldestTs = Infinity;
      for (const item of items) {
        const id = getItemId(item);
        if (id && knownIds && knownIds.has(id)) knownCount++;
        else newCount++;
        const ts = GSAClient._itemTimestampMs(item);
        if (ts > 0 && ts < oldestTs) oldestTs = ts;
      }
      const pastPendingCutoff = !stopAfterTs || (oldestTs !== Infinity && oldestTs <= stopAfterTs);
      const hitBoundary = isIncremental && (
        items.length === 0
        || (knownCount >= 5 && pastPendingCutoff)
        || (newCount === 0 && pastPendingCutoff)
      );
      return { newCount, knownCount, oldestTs, hitBoundary };
    };

    pagesByIndex.set(startPage, page0Items);
    const page0HasMore = page0?.hasMore ?? page0?.has_more ?? page0?.pagination?.hasMore ?? page0?.pagination?.has_more;
    const p0Analysis = analyzePage(page0Items);
    onPageDone({ page: startPage, itemsCount: page0Items.length, totalPages: respTotalPages, pagesFetched });

    const doneAfterPage0 = page0Items.length === 0
      || page0HasMore === false
      || totalPagesCap <= 1
      || p0Analysis.hitBoundary;

    if (!doneAfterPage0) {
      if (isIncremental) {
        // Incremental mode: fetch parallel waves sized to the estimated delta until we cross into cached IDs.
        let nextPage = startPage + 1;
        const maxPageIdx = Number.isFinite(totalPagesCap) ? (startPage + totalPagesCap - 1) : Infinity;
        let estRemaining = serverTotal !== null && knownIds
          ? Math.max(1, Math.ceil(Math.max(0, serverTotal - knownIds.size) / pageSize))
          : 2;

        while (nextPage <= maxPageIdx) {
          if (pagesFetched >= limitPages) {
            truncated = true;
            break;
          }
          const remainingBudget = Number.isFinite(limitPages) ? (limitPages - pagesFetched) : concurrency;
          const waveCount = Math.max(1, Math.min(concurrency, estRemaining, remainingBudget, (maxPageIdx - nextPage + 1)));
          const wavePages = [];
          for (let i = 0; i < waveCount; i++) wavePages.push(nextPage + i);

          const waveResults = await Promise.all(wavePages.map(p => sem.run(async () => {
            if (this.delayMs > 0) await this.sleep(this.delayMs);
            const r = await fetchPage(p);
            const items = this.extractItems(r);
            pagesFetched++;
            onPageDone({ page: p, itemsCount: items.length, totalPages: respTotalPages, pagesFetched });
            return { p, r, items };
          })));

          waveResults.sort((a, b) => a.p - b.p);
          let stopNow = false;
          for (const res of waveResults) {
            pagesByIndex.set(res.p, res.items);
            const hm = res.r?.hasMore ?? res.r?.has_more ?? res.r?.pagination?.hasMore ?? res.r?.pagination?.has_more;
            const info = analyzePage(res.items);
            if (res.items.length === 0 || hm === false || info.hitBoundary) {
              stopNow = true;
              break;
            }
          }
          if (stopNow) break;
          nextPage += waveCount;
          estRemaining = concurrency;
        }
        if (nextPage <= maxPageIdx && respTotalPages !== null && pagesFetched >= limitPages && limitPages < respTotalPages) {
          truncated = true;
        }
      } else if (respTotalPages !== null) {
        // Full / Scenario mode with known totalPages: dispatch ALL remaining pages through shared semaphore.
        const lastIdx = startPage + totalPagesCap - 1;
        if (respTotalPages > limitPages) truncated = true;
        const pageIndices = [];
        for (let p = startPage + 1; p <= lastIdx; p++) pageIndices.push(p);

        await Promise.all(pageIndices.map(p => sem.run(async () => {
          if (this.delayMs > 0) await this.sleep(this.delayMs);
          const r = await fetchPage(p);
          const items = this.extractItems(r);
          pagesByIndex.set(p, items);
          pagesFetched++;
          onPageDone({ page: p, itemsCount: items.length, totalPages: totalPagesCap, pagesFetched });
        })));
      } else {
        // Fallback when endpoint omits `total` / `totalPages`: fetch waves of `concurrency` until empty / hasMore=false.
        let nextPage = startPage + 1;
        while (pagesFetched < limitPages) {
          const waveCount = Math.min(concurrency, Number.isFinite(limitPages) ? (limitPages - pagesFetched) : concurrency);
          const wavePages = [];
          for (let i = 0; i < waveCount; i++) wavePages.push(nextPage + i);

          const waveResults = await Promise.all(wavePages.map(p => sem.run(async () => {
            if (this.delayMs > 0) await this.sleep(this.delayMs);
            const r = await fetchPage(p);
            const items = this.extractItems(r);
            pagesFetched++;
            onPageDone({ page: p, itemsCount: items.length, totalPages: null, pagesFetched });
            return { p, r, items };
          })));

          waveResults.sort((a, b) => a.p - b.p);
          let stopNow = false;
          for (const res of waveResults) {
            pagesByIndex.set(res.p, res.items);
            const hm = res.r?.hasMore ?? res.r?.has_more ?? res.r?.pagination?.hasMore ?? res.r?.pagination?.has_more;
            if (res.items.length === 0 || hm === false) {
              stopNow = true;
              break;
            }
          }
          if (stopNow) break;
          nextPage += waveCount;
        }
        if (pagesFetched >= limitPages) truncated = true;
      }
    }

    // Flatten pages in ascending page order (newest-first) and deduplicate by ID.
    const sortedPages = Array.from(pagesByIndex.keys()).sort((a, b) => a - b);
    const collected = [];
    for (const p of sortedPages) {
      for (const item of pagesByIndex.get(p)) {
        const id = getItemId(item);
        if (id && seenIds.has(id)) continue;
        if (id) seenIds.add(id);
        collected.push(item);
      }
    }

    return {
      items: collected,
      serverTotal: serverTotal ?? collected.length,
      totalPages: respTotalPages,
      pagesFetched,
      truncated
    };
  }

  async extractAllChats(slug, options = {}, metaOut = null) {
    if (!this.abortController) this.abortController = new AbortController();
    const limit = options.limit || 50;
    const maxPages = options.maxPages === 0 ? Infinity : (options.maxPages || 250);
    const concurrency = Math.max(1, Math.min(10, Number(options.concurrency) || this.concurrency));
    const behavior = options.behavior || '';
    const onProgress = options.onProgress || (() => {});
    const fetchFullDetails = options.fetchFullDetails ?? false;

    const firstResp = await this.getChatsPage(slug, 0, limit, behavior);
    const res = await this._paginateFast({
      firstResp,
      fetchPage: (p) => this.getChatsPage(slug, p, limit, behavior),
      getItemId: (item) => this._id(item.chatId || item.id || item._id),
      maxPages,
      concurrency,
      semaphore: options.semaphore || null,
      knownIds: options.knownChatIds || null,
      onPageDone: ({ page, totalPages, pagesFetched }) => {
        onProgress({ type: 'chats_page', page, totalPages, pagesFetched, status: `Fetching chats (${pagesFetched}${totalPages ? `/${totalPages}` : ''})...` });
      }
    });

    if (fetchFullDetails) {
      const sem = options.semaphore || GSAClient._createSemaphore(concurrency);
      await Promise.all(res.items.map((item, idx) => {
        const msgList = item.messages || item.chat?.messages || item.conversation;
        const cleanId = this._id(item.chatId || item.id || item._id);
        if ((!msgList || msgList.length === 0) && cleanId) {
          return sem.run(async () => {
            const detail = await this.getChatDetail(slug, cleanId);
            if (detail) res.items[idx] = { ...item, ...detail };
          });
        }
        return null;
      }));
    }

    if (metaOut) {
      metaOut.chatsTruncated = res.truncated;
      metaOut.chatsServerTotal = res.serverTotal;
      metaOut.chatsPagesFetched = res.pagesFetched;
    }
    return res.items;
  }

  async extractAllSubmissions(slug, options = {}, metaOut = null) {
    if (!this.abortController) this.abortController = new AbortController();
    const limit = options.limit || 50;
    const maxPages = options.maxPages === 0 ? Infinity : (options.maxPages || 250);
    const concurrency = Math.max(1, Math.min(10, Number(options.concurrency) || this.concurrency));
    const behavior = options.behavior || '';
    const onProgress = options.onProgress || (() => {});

    const firstResp = await this.getSubmissionsPage(slug, 0, limit, behavior);
    const res = await this._paginateFast({
      firstResp,
      fetchPage: (p) => this.getSubmissionsPage(slug, p, limit, behavior),
      getItemId: (item) => this._id(item.submissionId || item.id || item._id),
      maxPages,
      concurrency,
      semaphore: options.semaphore || null,
      knownIds: options.knownSubIds || null,
      stopAfterTs: options.minPendingSubTs || null,
      onPageDone: ({ page, totalPages, pagesFetched }) => {
        onProgress({ type: 'submissions_page', page, totalPages, pagesFetched, status: `Fetching submissions (${pagesFetched}${totalPages ? `/${totalPages}` : ''})...` });
      }
    });

    if (metaOut) {
      metaOut.subsTruncated = res.truncated;
      metaOut.subsServerTotal = res.serverTotal;
      metaOut.subsPagesFetched = res.pagesFetched;
    }
    return res.items;
  }

  getChatIdFrom(obj) {
    if (!obj) return '';
    if (typeof obj === 'string') return obj.trim();
    if (typeof obj === 'number') return String(obj);
    if (typeof obj === 'object') {
      const ref = obj.chatId || obj.chat_id;
      if (ref) return typeof ref === 'string' ? ref.trim() : (ref.$oid ? String(ref.$oid).trim() : String(ref).trim());
      if (obj.chat) {
        if (typeof obj.chat === 'string') return obj.chat.trim();
        if (typeof obj.chat === 'object') {
          const nested = obj.chat.chatId || obj.chat.chat_id || obj.chat._id || obj.chat.id;
          if (nested) return typeof nested === 'string' ? nested.trim() : (nested.$oid ? String(nested.$oid).trim() : String(nested).trim());
        }
      }
      const selfId = obj._id || obj.id;
      if (selfId) return typeof selfId === 'string' ? selfId.trim() : (selfId.$oid ? String(selfId.$oid).trim() : String(selfId).trim());
    }
    return '';
  }

  /**
   * Selects the authoritative submission among multiple submissions for a single chat:
   *  1) Any submission with a winning appeal (`appeal_status === 'success'` or `manual_status === 'success'`)
   *  2) Any confirmed accepted break (`successful === true`, `grading.is_break === true`, or `grade_status === 'success'` without `successful === false`)
   *  3) Otherwise the most recent submission by `created_at` / `updated_at`.
   */
  static selectPrimarySubmission(subs, appealsMap = {}) {
    if (!Array.isArray(subs) || subs.length === 0) return null;

    const scoreSubmission = (sub) => {
      const subId = sub._id?.$oid || String(sub._id || sub.id || '');
      const appeal = sub.appeal || (subId ? appealsMap[subId] : null);
      const apSucc = appeal && (appeal.appeal_status === 'success' || appeal.manual_status === 'success');
      if (apSucc) return 3;

      const isConfirmedBreak = sub.successful === true
        || sub.grading?.is_break === true
        || (sub.grade_status === 'success' && sub.successful !== false && sub.grading?.is_break !== false);
      if (isConfirmedBreak) return 2;

      const gs = (sub.grade_status || '').toLowerCase();
      if (gs === 'ungraded' || gs === 'maybe_success') return 1;
      return 0;
    };

    const tsOf = (sub) => {
      const t = new Date(sub.updated_at || sub.created_at || 0).getTime();
      return Number.isNaN(t) ? 0 : t;
    };

    const enriched = subs.map((s, idx) => {
      const subId = this._protoId(s);
      const appeal = subId && appealsMap[subId] ? appealsMap[subId] : s.appeal || null;
      return { sub: appeal ? { ...s, appeal } : s, rank: scoreSubmission(s), ts: tsOf(s), idx };
    });

    enriched.sort((a, b) => {
      if (b.rank !== a.rank) return b.rank - a.rank;
      if (b.ts !== a.ts) return b.ts - a.ts;
      return a.idx - b.idx; // preserve sort=recent newest-first tie-breaker
    });

    const primary = enriched[0].sub;
    if (subs.length > 1) {
      return { ...primary, submissionCount: subs.length };
    }
    return primary;
  }

  static _protoId(obj) {
    if (!obj || typeof obj !== 'object') return '';
    const v = obj.submissionId || obj._id || obj.id;
    if (!v) return '';
    return typeof v === 'object' && v.$oid ? String(v.$oid) : String(v);
  }

  /**
   * Re-applies fresh `appealsMap` or a newly fetched submission onto an existing cached
   * normalized chat without needing to re-fetch its full page from Gray Swan.
   */
  static updateCachedChatVerdict(cachedChat, freshSub, appealsMap, heuristicsMod) {
    if (!cachedChat) return cachedChat;
    const h = heuristicsMod
      || (typeof GSAHeuristics !== 'undefined' ? GSAHeuristics : null)
      || (typeof require !== 'undefined' ? require('./heuristics') : null);

    if (freshSub) {
      const freshSubId = GSAClient._protoId(freshSub);
      const existingSubId = cachedChat.submissionMeta?.submissionId || '';
      const appeal = freshSub.appeal || (freshSubId && appealsMap ? appealsMap[freshSubId] : null);
      const subObj = appeal ? { ...freshSub, appeal } : freshSub;

      const freshClassification = h
        ? h.classifyConversation({ messages: cachedChat.messages || [] }, subObj, { appealsMap })
        : cachedChat.rejectionDetails;

      // Never downgrade an already-accepted different submission if incremental fetch only saw a newer fail
      if (
        existingSubId && freshSubId && existingSubId !== freshSubId
        && cachedChat.rejectionDetails?.outcome === 'accepted'
        && freshClassification?.outcome !== 'accepted'
      ) {
        return cachedChat;
      }

      const nextMeta = {
        submissionId: freshSubId || existingSubId || undefined,
        gradeStatus: subObj.grade_status || undefined,
        successful: typeof subObj.successful === 'boolean' ? subObj.successful : undefined,
        isBreak: typeof subObj.grading?.is_break === 'boolean' ? subObj.grading.is_break : undefined,
        appealStatus: appeal?.appeal_status || undefined,
        manualStatus: appeal?.manual_status || undefined,
        submissionCount: subObj.submissionCount > 1 ? subObj.submissionCount : cachedChat.submissionMeta?.submissionCount
      };
      return {
        ...cachedChat,
        submissionMeta: nextMeta,
        rejectionDetails: freshClassification
      };
    }

    // Free appeal update from `__data.json` for already-cached chats
    const subId = cachedChat.submissionMeta?.submissionId;
    if (subId && appealsMap && appealsMap[subId]) {
      const ap = appealsMap[subId];
      const changed = ap.appeal_status !== cachedChat.submissionMeta.appealStatus
        || ap.manual_status !== cachedChat.submissionMeta.manualStatus;
      if (changed && h) {
        const syntheticSub = {
          _id: subId,
          grade_status: cachedChat.submissionMeta.gradeStatus,
          successful: cachedChat.submissionMeta.successful,
          grading: typeof cachedChat.submissionMeta.isBreak === 'boolean'
            ? { is_break: cachedChat.submissionMeta.isBreak }
            : undefined,
          appeal: ap
        };
        const updatedClass = h.classifyConversation({ messages: cachedChat.messages || [] }, syntheticSub, { appealsMap });
        return {
          ...cachedChat,
          submissionMeta: {
            ...cachedChat.submissionMeta,
            appealStatus: ap.appeal_status || undefined,
            manualStatus: ap.manual_status || undefined
          },
          rejectionDetails: updatedClass
        };
      }
    }
    return cachedChat;
  }

  /**
   * Unified extraction with parallel page pool, incremental early-stop, and scenario-scoped sync.
   * Options:
   *   mode: 'incremental' | 'full' | 'scenario'
   *   behavior: behavior slug (used when mode === 'scenario')
   *   existingChats: previously cached normalized chats for this slug
   *   prevTruncated: true if previous cache was capped (forces full sync on incremental)
   *   concurrency: parallel page workers (default 5)
   */
  async extractUnified(slug, options = {}) {
    const t0 = Date.now();
    this.abortController = new AbortController();

    const onProgress = options.onProgress || (() => {});
    const normalizer = options.normalizer
      || (typeof GSANormalizer !== 'undefined' ? GSANormalizer : null)
      || (typeof require !== 'undefined' ? require('./normalizer') : null);
    const heuristics = options.heuristics
      || (typeof GSAHeuristics !== 'undefined' ? GSAHeuristics : null)
      || (typeof require !== 'undefined' ? require('./heuristics') : null);

    const limit = options.limit || 50;
    const maxPages = options.maxPages === 0 ? Infinity : (options.maxPages || 250);
    const concurrency = Math.max(1, Math.min(10, Number(options.concurrency) || this.concurrency));
    const existingChats = Array.isArray(options.existingChats) ? options.existingChats : [];

    const behaviorsList = Array.isArray(options.behaviors)
      ? options.behaviors.map(s => String(s || '').trim()).filter(Boolean)
      : (options.behavior ? [String(options.behavior).trim()] : []);
    const modelsList = Array.isArray(options.models)
      ? options.models.map(s => String(s || '').trim()).filter(Boolean)
      : (options.model ? [String(options.model).trim()] : []);

    // Determine effective mode: incremental only if cache exists, wasn't truncated, and mode isn't full/scenario/filtered.
    let mode = options.mode || (existingChats.length > 0 ? 'incremental' : 'full');
    if ((mode === 'scenario' || mode === 'filtered') && behaviorsList.length === 0 && modelsList.length === 0) {
      mode = existingChats.length > 0 ? 'incremental' : 'full';
    }
    if (mode === 'incremental' && (existingChats.length === 0 || options.prevTruncated)) mode = 'full';
    const isScopedMode = mode === 'scenario' || mode === 'filtered';

    const filterSlices = [];
    if (isScopedMode) {
      if (behaviorsList.length > 0 && modelsList.length > 0 && behaviorsList.length * modelsList.length <= 6) {
        for (const b of behaviorsList) {
          for (const m of modelsList) filterSlices.push({ behavior: b, model: m });
        }
      } else if (behaviorsList.length > 0) {
        for (const b of behaviorsList) filterSlices.push({ behavior: b, model: '' });
      } else {
        for (const m of modelsList) filterSlices.push({ behavior: '', model: m });
      }
    } else {
      filterSlices.push({ behavior: '', model: '' });
    }

    const warnings = [];
    const modeLabel = isScopedMode
      ? `filtered (${filterSlices.length} slice${filterSlices.length > 1 ? 's' : ''})`
      : (mode === 'incremental' ? 'new chats' : 'all chats');
    onProgress({ pct: 4, status: `Syncing ${modeLabel} (roster + page 0)...` });

    // Build incremental boundary sets from existing cached chats.
    const knownChatIds = new Set();
    const knownSubIds = new Set();
    let minPendingSubTs = null;
    if (mode === 'incremental') {
      const pendingCutoffWindow = Date.now() - (72 * 3600 * 1000);
      for (const c of existingChats) {
        if (c.chatId) knownChatIds.add(String(c.chatId));
        const subMeta = c.submissionMeta;
        if (subMeta && subMeta.submissionId) {
          knownSubIds.add(String(subMeta.submissionId));
          const gs = String(subMeta.gradeStatus || '').toLowerCase();
          const isSubmittedPending = gs === 'ungraded' || gs === 'maybe_success'
            || (c.rejectionDetails?.outcome === 'pending');
          if (isSubmittedPending) {
            const ts = GSAClient._itemTimestampMs(c);
            if (ts >= pendingCutoffWindow && (minPendingSubTs === null || ts < minPendingSubTs)) {
              minPendingSubTs = ts;
            }
          }
        }
      }
      if (minPendingSubTs !== null) minPendingSubTs = Math.max(0, minPendingSubTs - 60000);
    }

    // Shared semaphore ensures total in-flight requests across all slices (chats + submissions) stay <= concurrency.
    const sem = GSAClient._createSemaphore(concurrency);

    // Step 1: Fetch roster + page 0 of every slice IN PARALLEL.
    let roster = {
      challengeName: '', modelMap: {}, modelIdIndex: {}, scenarioMap: {}, scenarioKeyMap: {},
      behaviorWaveMap: {}, appealsMap: {}, batchMap: new Map(), breakStats: null,
      chatsCount: 0, submissionsCount: 0, allModels: [], allScenarios: []
    };

    const rosterPromise = this.discoverRoster(slug).catch(err => {
      if (/Authentication required|Session expired|cancelled/i.test(err.message)) throw err;
      warnings.push(`Challenge metadata warning: ${err.message}`);
      return null;
    });

    const sliceInitPromises = filterSlices.map(async (slice) => {
      const [firstChatsRes, firstSubsRes] = await Promise.all([
        sem.run(() => this.getChatsPage(slug, 0, limit, slice.behavior, slice.model)).catch(err => {
          if (/Authentication required|Session expired|cancelled/i.test(err.message)) throw err;
          return { _error: err };
        }),
        sem.run(() => this.getSubmissionsPage(slug, 0, limit, slice.behavior, slice.model)).catch(err => {
          if (/Authentication required|Session expired|cancelled/i.test(err.message)) throw err;
          warnings.push(`Submissions fetch warning: ${err.message}`);
          return null;
        })
      ]);
      return { slice, firstChatsRes, firstSubsRes };
    });

    const [rosterRes, ...sliceInits] = await Promise.all([rosterPromise, ...sliceInitPromises]);
    if (rosterRes) roster = rosterRes;

    for (const si of sliceInits) {
      if (si.firstChatsRes && si.firstChatsRes._error) throw si.firstChatsRes._error;
    }

    let totalEstPages = 0;
    for (const si of sliceInits) {
      const cLen = this.extractItems(si.firstChatsRes).length || limit;
      const sLen = si.firstSubsRes ? (this.extractItems(si.firstSubsRes).length || limit) : limit;
      const estC = si.firstChatsRes && typeof si.firstChatsRes.total === 'number'
        ? Math.min(maxPages, Math.max(1, Math.ceil(si.firstChatsRes.total / cLen)))
        : 1;
      const estS = si.firstSubsRes && typeof si.firstSubsRes.total === 'number'
        ? Math.min(maxPages, Math.max(1, Math.ceil(si.firstSubsRes.total / sLen)))
        : 0;
      totalEstPages += mode === 'incremental'
        ? Math.max(2,
            Math.ceil(Math.max(0, (si.firstChatsRes?.total || 0) - knownChatIds.size) / limit) + 1
            + Math.ceil(Math.max(0, (si.firstSubsRes?.total || 0) - knownSubIds.size) / limit) + 1)
        : Math.max(1, estC + estS);
    }

    const donePerSlice = new Array(sliceInits.length * 2).fill(0);
    const emitPoolProgress = () => {
      const done = donePerSlice.reduce((a, b) => a + b, 0);
      const pct = Math.min(92, Math.max(8, Math.round((done / Math.max(done, totalEstPages)) * 90)));
      const label = mode === 'incremental'
        ? `Syncing new (${done} pages fetched, ${concurrency}x parallel)...`
        : isScopedMode
          ? `Syncing filtered (${done}/${Math.max(done, totalEstPages)} pages, ${concurrency}x parallel)...`
          : `Fetching pages ${done}/${Math.max(done, totalEstPages)} (${concurrency}x parallel)...`;
      onProgress({ type: 'pool_progress', page: done, totalPages: totalEstPages, pct, status: label });
    };

    // Step 2: Paginate all remaining chat & submission slices CONCURRENTLY through the shared pool.
    const sliceResults = await Promise.all(sliceInits.map(async (si, idx) => {
      const { behavior: b, model: m } = si.slice;
      const [chatPageRes, subPageRes] = await Promise.all([
        this._paginateFast({
          firstResp: si.firstChatsRes,
          fetchPage: (p) => this.getChatsPage(slug, p, limit, b, m),
          getItemId: (item) => this._id(item.chatId || item.id || item._id),
          maxPages,
          concurrency,
          semaphore: sem,
          knownIds: mode === 'incremental' ? knownChatIds : null,
          onPageDone: ({ pagesFetched }) => { donePerSlice[idx * 2] = pagesFetched; emitPoolProgress(); }
        }),
        si.firstSubsRes
          ? this._paginateFast({
              firstResp: si.firstSubsRes,
              fetchPage: (p) => this.getSubmissionsPage(slug, p, limit, b, m),
              getItemId: (item) => this._id(item.submissionId || item.id || item._id),
              maxPages,
              concurrency,
              semaphore: sem,
              knownIds: mode === 'incremental' ? knownSubIds : null,
              stopAfterTs: mode === 'incremental' ? minPendingSubTs : null,
              onPageDone: ({ pagesFetched }) => { donePerSlice[idx * 2 + 1] = pagesFetched; emitPoolProgress(); }
            }).catch(err => {
              if (/Authentication required|Session expired|cancelled/i.test(err.message)) throw err;
              warnings.push(`Submissions fetch warning: ${err.message}`);
              return { items: [], serverTotal: 0, pagesFetched: 0, truncated: false };
            })
          : Promise.resolve({ items: [], serverTotal: 0, pagesFetched: 0, truncated: false })
      ]);
      return { chatPageRes, subPageRes };
    }));

    const rawChats = [];
    const seenRawChatIds = new Set();
    const rawSubmissions = [];
    const seenRawSubIds = new Set();
    let chatsTruncated = false;
    let subsTruncated = false;
    let chatsServerTotal = 0;
    let subsServerTotal = 0;
    let pagesFetchedTotal = 0;

    for (const { chatPageRes, subPageRes } of sliceResults) {
      if (chatPageRes.truncated) chatsTruncated = true;
      if (subPageRes.truncated) subsTruncated = true;
      chatsServerTotal += chatPageRes.serverTotal || 0;
      subsServerTotal += subPageRes.serverTotal || 0;
      pagesFetchedTotal += (chatPageRes.pagesFetched || 0) + (subPageRes.pagesFetched || 0);

      for (const c of chatPageRes.items) {
        const cid = this._id(c.chatId || c.id || c._id);
        if (cid && seenRawChatIds.has(cid)) continue;
        if (cid) seenRawChatIds.add(cid);
        rawChats.push(c);
      }
      for (const s of subPageRes.items) {
        const sid = this._id(s.submissionId || s.id || s._id);
        if (sid && seenRawSubIds.has(sid)) continue;
        if (sid) seenRawSubIds.add(sid);
        rawSubmissions.push(s);
      }
    }

    if (options.fetchFullDetails && rawChats.length > 0) {
      await Promise.all(rawChats.map((item, idx) => {
        const msgList = item.messages || item.chat?.messages || item.conversation;
        const cleanId = this._id(item.chatId || item.id || item._id);
        if ((!msgList || msgList.length === 0) && cleanId) {
          return sem.run(async () => {
            const detail = await this.getChatDetail(slug, cleanId);
            if (detail) rawChats[idx] = { ...item, ...detail };
          });
        }
        return null;
      }));
    }

    if (chatsTruncated) {
      warnings.push(`Chats capped by Max pages setting (fetched ${rawChats.length} of ${chatsServerTotal}). Set Max pages to 0 for unlimited.`);
    }
    if (subsTruncated) {
      warnings.push(`Submissions capped by Max pages setting (fetched ${rawSubmissions.length} of ${subsServerTotal}).`);
    }

    onProgress({ pct: 95, status: 'Merging & classifying conversations...' });

    // Pass 1: harvest id->name pairs from the raw data into the roster maps.
    const maps = {
      slug,
      modelMap: { ...roster.modelMap },
      modelIdIndex: { ...roster.modelIdIndex },
      scenarioMap: { ...roster.scenarioMap },
      behaviorWaveMap: { ...roster.behaviorWaveMap },
      appealsMap: { ...roster.appealsMap },
      allModels: [...roster.allModels],
      batchMap: roster.batchMap
    };
    if (normalizer && normalizer.harvestMaps) {
      for (const c of rawChats) normalizer.harvestMaps(c, maps);
      for (const s of rawSubmissions) normalizer.harvestMaps(s, maps);
    }

    // Group ALL freshly fetched submissions by chat_id.
    const subsByChatId = new Map();
    for (const sub of rawSubmissions) {
      const cId = this.getChatIdFrom(sub);
      if (!cId) continue;
      let list = subsByChatId.get(cId);
      if (!list) {
        list = [];
        subsByChatId.set(cId, list);
      }
      list.push(sub);
    }

    const challengeName = roster.challengeName
      || (normalizer ? normalizer.resolveChallengeName(slug, {}, rawChats[0] || {}) : slug);

    // Index previously cached chats when merging (`incremental`, `scenario`, or `filtered`).
    const shouldMerge = mode === 'incremental' || (isScopedMode && existingChats.length > 0);
    const cachedById = new Map();
    if (shouldMerge) {
      for (const c of existingChats) {
        if (c && c.chatId) cachedById.set(String(c.chatId), c);
      }
    }

    const mergedById = new Map();
    const fetchedChatIds = new Set();
    let newChatsCount = 0;
    let updatedChatsCount = 0;

    for (const rawChat of rawChats) {
      const cId = this.getChatIdFrom(rawChat);
      const chatSubs = cId ? subsByChatId.get(cId) : null;
      const associatedSub = chatSubs
        ? GSAClient.selectPrimarySubmission(chatSubs, maps.appealsMap)
        : null;
      let normalized = normalizer
        ? normalizer.normalizeArenaChat({ ...rawChat, submission: associatedSub }, { slug, challengeName, maps, batchMap: roster.batchMap })
        : rawChat;

      const prevCached = cId ? cachedById.get(cId) : null;
      if (prevCached) {
        // Overlap safety: if incremental fetch didn't re-fetch an older submission for this overlapping chat, keep cached submissionMeta + re-check appeals.
        if (!associatedSub && prevCached.submissionMeta) {
          normalized = GSAClient.updateCachedChatVerdict(
            { ...normalized, submissionMeta: prevCached.submissionMeta, rejectionDetails: prevCached.rejectionDetails },
            null,
            maps.appealsMap,
            heuristics
          );
        } else if (associatedSub && prevCached.submissionMeta) {
          const freshSubId = GSAClient._protoId(associatedSub);
          if (
            prevCached.submissionMeta.submissionId
            && freshSubId !== prevCached.submissionMeta.submissionId
            && prevCached.rejectionDetails?.outcome === 'accepted'
            && normalized.rejectionDetails?.outcome !== 'accepted'
          ) {
            normalized.submissionMeta = prevCached.submissionMeta;
            normalized.rejectionDetails = prevCached.rejectionDetails;
          }
        }
        updatedChatsCount++;
      } else {
        newChatsCount++;
      }

      if (cId) {
        mergedById.set(cId, normalized);
        fetchedChatIds.add(cId);
      } else {
        mergedById.set(`__anon_${mergedById.size}`, normalized);
      }
    }

    // Handle freshly fetched submissions whose chats weren't in `rawChats` (e.g. older chat submitted or newly graded!).
    for (const [cId, chatSubs] of subsByChatId.entries()) {
      if (fetchedChatIds.has(cId)) continue;
      const primary = GSAClient.selectPrimarySubmission(chatSubs, maps.appealsMap);
      if (!primary) continue;

      const prevCached = cachedById.get(cId);
      if (prevCached) {
        mergedById.set(cId, GSAClient.updateCachedChatVerdict(prevCached, primary, maps.appealsMap, heuristics));
        fetchedChatIds.add(cId);
        updatedChatsCount++;
      } else if (primary.chat || primary.messages) {
        const item = typeof primary.chat === 'object' ? primary.chat : primary;
        const normalized = normalizer
          ? normalizer.normalizeArenaChat({ ...item, submission: primary }, { slug, challengeName, maps, batchMap: roster.batchMap })
          : item;
        mergedById.set(cId, normalized);
        fetchedChatIds.add(cId);
        newChatsCount++;
      }
    }

    // Carry forward untouched cached chats (and apply free appeal updates from `__data.json`).
    if (shouldMerge) {
      for (const [cId, prevCached] of cachedById.entries()) {
        if (mergedById.has(cId)) continue;
        const refreshed = GSAClient.updateCachedChatVerdict(prevCached, null, maps.appealsMap, heuristics);
        if (refreshed !== prevCached) updatedChatsCount++;
        mergedById.set(cId, refreshed);
      }
    }

    const unifiedList = Array.from(mergedById.values());
    unifiedList.sort((a, b) => GSAClient._itemTimestampMs(b) - GSAClient._itemTimestampMs(a));

    const allModelsSet = new Set(roster.allModels);
    const allScenariosSet = new Set(roster.allScenarios);
    for (const c of unifiedList) {
      if (c.model && c.model !== 'Unknown model') allModelsSet.add(c.model);
      if (c.scenario && c.scenario !== 'Unknown scenario' && !maps.scenarioMap[c.scenario]) {
        allScenariosSet.add(c.scenario);
      }
    }

    const elapsedMs = Date.now() - t0;

    return {
      chats: unifiedList,
      modelMap: maps.modelMap,
      scenarioMap: maps.scenarioMap,
      scenarioKeyMap: roster.scenarioKeyMap || {},
      allModels: Array.from(allModelsSet).sort((a, b) => a.localeCompare(b)),
      allScenarios: Array.from(allScenariosSet).sort((a, b) => a.localeCompare(b)),
      challengeName,
      breakStats: roster.breakStats,
      counts: { chats: unifiedList.length, submissions: mode === 'full' ? rawSubmissions.length : (roster.submissionsCount || subsServerTotal || rawSubmissions.length) },
      serverTotals: {
        chats: isScopedMode ? (roster.chatsCount || unifiedList.length) : (chatsServerTotal || roster.chatsCount || unifiedList.length),
        submissions: isScopedMode ? (roster.submissionsCount || subsServerTotal) : (subsServerTotal || roster.submissionsCount || rawSubmissions.length)
      },
      truncated: !!(chatsTruncated || subsTruncated),
      warnings,
      syncStats: {
        mode,
        behaviors: behaviorsList.length ? behaviorsList : undefined,
        models: modelsList.length ? modelsList : undefined,
        newChats: newChatsCount,
        updatedChats: updatedChatsCount,
        pagesFetched: pagesFetchedTotal,
        elapsedMs
      }
    };
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { GSAClient };
} else if (typeof globalThis !== 'undefined') {
  globalThis.GSAClient = GSAClient;
}
