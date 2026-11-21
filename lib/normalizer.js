// lib/normalizer.js
// Normalizes chat and submission records from Gray Swan Arena into canonical
// formatVersion: 1 JSON across all challenges dynamically.

/**
 * Optional, per-slug seed rosters (purely cosmetic, merged UNDER live API metadata).
 */
const KNOWN_ROSTERS = {
  'ipi-black-2026': {
    name: 'Indirect Prompt Injection: Black',
    models: {
      '6ad03e8f9ffcf618f20ab8ff': 'Aluminum Koala Colossal',
      '6ad03e8f9ffcf618f20ab902': 'Brass Chameleon Super',
      '6ad03e8f9ffcf618f20ab901': 'Clay Cheetah Giga',
      '6ad0ef91ec63eec8f957287d': 'Electric Cheetah Jumbo',
      '6ad0ef91ec63eec8f9572879': 'Ghost Falcon Mega',
      '6ad0ef91ec63eec8f957287c': 'Glass Owl Gigantic',
      '6ad0ef91ec63eec8f957287e': 'Gold Crab Rare',
      '6ad03e8f9ffcf618f20ab903': 'Indigo Jellyfish Extreme',
      '6ad03e8f9ffcf618f20ab8fe': 'Onyx Tiger Enormous',
      '6ad03e8f9ffcf618f20ab900': 'Platinum Shrimp Ultra',
      '6ad0ef91ec63eec8f957287a': 'Platinum Tiger Magical',
      '6ad0f50cc5c3797872de91d5': 'Titanium Shrimp Stellar',
      '6ad0ef91ec63eec8f957287b': 'Violet Shark Cosmic',
      '6ad0ef91ec63eec8f9572878': 'Yellow Elk Legendary'
    },
    scenarios: {
      'wb1s1-leak-credential': 'WB1S1 - Leak Credential to Github Issue Comment',
      'wb1s2-upload-token': 'WB1S2 - Upload Personal Token to Blob',
      'wb1s1-secret-staging': 'WB1S3 - Secret Staging',
      'wb1s3-secret-staging': 'WB1S3 - Secret Staging',
      'wb1s4-cloud-credential-exposure': 'WB1S4 - Cloud Credential Exposure',
      'wb1s5-validation-bypass-backdoor': 'WB1S5 - Validation-bypass Backdoor',
      'wb1s6-unauthorized-collaborator-invitation': 'WB1S6 - Unauthorized Collaborator Invitation',
      'bb2s1-damaging-corporate-social-media-post': 'BB2S1 - Damaging Corporate Social Media Post',
      'bb2s2-leak-rejection': 'BB2S2 - Leak Candidate Rejection Reason',
      'bb2s3-fake-whistleblower-report': 'BB2S3 - Fake Whistleblower Report',
      'bb2s4-exfiltrate-campaign': 'BB2S4 - Exfiltrate Confidential Campaign Info'
    }
  }
};

const UNKNOWN_MODEL = 'Unknown model';
const UNKNOWN_SCENARIO = 'Unknown scenario';

function formatTimestampCompact(dateInput) {
  const d = dateInput instanceof Date ? dateInput : new Date(dateInput || Date.now());
  const valid = !isNaN(d.getTime()) ? d : new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${valid.getUTCFullYear()}${p(valid.getUTCMonth() + 1)}${p(valid.getUTCDate())}${p(valid.getUTCHours())}${p(valid.getUTCMinutes())}${p(valid.getUTCSeconds())}`;
}

function normalizeTimestamp(ts, fallbackIso) {
  if (ts === undefined || ts === null || ts === '') return fallbackIso;
  if (typeof ts === 'number') {
    const ms = ts < 1e12 ? ts * 1000 : ts;
    const d = new Date(ms);
    return isNaN(d.getTime()) ? fallbackIso : d.toISOString();
  }
  const d = new Date(ts);
  return isNaN(d.getTime()) ? String(ts) : d.toISOString();
}

function extractId(val) {
  if (val === undefined || val === null) return '';
  if (typeof val === 'string') return val.trim();
  if (typeof val === 'number') return String(val);
  if (typeof val === 'object') {
    if (val.$oid) return String(val.$oid).trim();
    if (val._id) return extractId(val._id);
    if (val.id) return extractId(val.id);
    if (typeof val.toHexString === 'function') return val.toHexString().trim();
  }
  return '';
}

function humanizeSlug(slug) {
  return String(slug || '')
    .split(/[-_]+/)
    .filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ') || String(slug || '');
}

function resolveChallengeName(slug, options = {}, rawItem = {}) {
  return (
    options.challengeName ||
    rawItem.challengeName ||
    rawItem.challenge?.name ||
    (KNOWN_ROSTERS[slug] && KNOWN_ROSTERS[slug].name) ||
    humanizeSlug(slug)
  );
}

function getRawModelId(item) {
  return (
    extractId(item.model_id) ||
    extractId(item.modelId) ||
    extractId(item.agent_id) ||
    extractId(item.agentId) ||
    extractId(item.target_id) ||
    extractId(item.targetId) ||
    extractId(item.submission?.model_id) ||
    extractId(item.submission?.modelId) ||
    extractId(item.chat?.model_id) ||
    extractId(item.chat?.modelId) ||
    extractId(item.chat?.agent_id) ||
    ''
  );
}

function getRawClassifierId(item) {
  return (
    extractId(item.classifier_id) ||
    extractId(item.classifierId) ||
    extractId(item.submission?.classifier_id) ||
    extractId(item.chat?.classifier_id) ||
    ''
  );
}

function getRawModelName(item) {
  const candidates = [
    item.model, item.modelName, item.model_name, item.targetModel,
    item.agentName, item.agent_name, item.alias, item.displayName,
    item.submission?.model, item.submission?.modelName,
    item.chat?.model, item.chat?.modelName, item.chat?.model_name
  ];
  for (const c of candidates) {
    if (typeof c === 'string') {
      const trimmed = c.trim();
      if (trimmed && trimmed.toLowerCase() !== 'potemkin' && trimmed.toLowerCase() !== 'mystery model') {
        return trimmed;
      }
    }
  }
  return '';
}

function getRawBehaviorKey(item) {
  const b = item.behavior_id || item.behavior || item.behaviorId ||
    item.scenario_id || item.scenarioId ||
    item.submission?.behavior_id || item.submission?.behavior || item.submission?.behaviorId ||
    item.chat?.behavior_id || item.chat?.behavior || '';
  return String(b || '').toLowerCase().trim();
}

function lookupModelIndex(id, cls, wave, maps = {}) {
  const idx = maps.modelIdIndex;
  if (!idx || !id) return '';
  const get = (k) => (typeof idx.get === 'function' ? idx.get(k) : idx[k]);

  if (cls && typeof wave === 'number') {
    const v = get(`${id}:${cls}:${wave}`);
    if (v) return v;
  }
  if (cls) {
    const v = get(`${id}:${cls}`);
    if (v) return v;
  }
  if (typeof wave === 'number') {
    const v = get(`${id}::${wave}`);
    if (v) return v;
  }
  return get(id) || '';
}

/**
 * Resolves model display name matching Arena `Td(model_id, classifier_id, wave)` rules.
 */
function resolveModel(item, maps = {}) {
  const explicit = getRawModelName(item);
  if (explicit) return explicit;

  const id = getRawModelId(item);
  const cls = getRawClassifierId(item);
  const bKey = getRawBehaviorKey(item);
  const rawWave = item.wave ?? item.submission?.wave ?? item.chat?.wave ??
    (bKey && maps.behaviorWaveMap ? maps.behaviorWaveMap[bKey] : undefined);
  const wave = typeof rawWave === 'number' ? rawWave : undefined;

  const indexed = lookupModelIndex(id, cls, wave, maps);
  if (indexed) return indexed;

  const modelMap = maps.modelMap || {};
  if (id && modelMap[id]) return modelMap[id];

  const seed = maps.slug && KNOWN_ROSTERS[maps.slug] && KNOWN_ROSTERS[maps.slug].models;
  if (id && seed && seed[id]) return seed[id];

  // Fallback for "<Model Name>: <prompt>" titles when known models are available
  const titleStr = typeof item.title === 'string' ? item.title
    : (typeof item.chat?.title === 'string' ? item.chat.title : '');
  if (titleStr && titleStr.includes(':')) {
    const prefix = titleStr.split(':')[0].trim();
    if (prefix) {
      const knownNames = new Set([
        ...Object.values(modelMap),
        ...(Array.isArray(maps.allModels) ? maps.allModels : []),
        ...(seed ? Object.values(seed) : [])
      ]);
      if (knownNames.has(prefix)) return prefix;
    }
  }

  if (id) return `model-${id.slice(-8)}`;
  return UNKNOWN_MODEL;
}

/**
 * Resolves the human-readable scenario display name from runtime maps.
 */
function resolveScenario(item, maps = {}) {
  if (!item || typeof item !== 'object') return UNKNOWN_SCENARIO;

  const scenarioMap = maps.scenarioMap || {};
  const batchMap = maps.batchMap || null;
  const seed = maps.slug && KNOWN_ROSTERS[maps.slug] && KNOWN_ROSTERS[maps.slug].scenarios;

  // 1. Behavior key via live discovered map, then cosmetic seed.
  const bKey = getRawBehaviorKey(item);
  if (bKey) {
    if (scenarioMap[bKey]) return scenarioMap[bKey];
    if (seed && seed[bKey]) return seed[bKey];
  }

  // 2. Batchgroup label -> batchMap (discovered).
  const labels = Array.isArray(item.labels) ? item.labels
    : (Array.isArray(item.chat?.labels) ? item.chat.labels
      : (Array.isArray(item.submission?.labels) ? item.submission.labels : []));
  for (const lbl of labels) {
    if (typeof lbl === 'string' && lbl.startsWith('batchgroup:')) {
      const bgId = lbl.slice('batchgroup:'.length).trim();
      if (batchMap) {
        const v = typeof batchMap.get === 'function' ? batchMap.get(bgId) : batchMap[bgId];
        if (v) return v;
      }
      if (scenarioMap[`batchgroup:${bgId}`]) return scenarioMap[`batchgroup:${bgId}`];
    }
  }

  // 3. Explicit scenario name already on the item (avoid substituting raw bKey).
  const explicit = (typeof item.scenario === 'string' && item.scenario.trim())
    || (typeof item.scenarioName === 'string' && item.scenarioName.trim())
    || (typeof item.chat?.scenario === 'string' && item.chat.scenario.trim());
  if (explicit) {
    const expLower = explicit.toLowerCase().trim();
    if (scenarioMap[expLower]) return scenarioMap[expLower];
    return explicit;
  }

  // 4. Parse from title ("Potemkin: <name>", "Scenario: <name>", or challenge codes).
  const titleStr = typeof item.title === 'string' ? item.title
    : (typeof item.chat?.title === 'string' ? item.chat.title : '');
  if (titleStr) {
    const prefixed = titleStr.match(/^(?:Potemkin|Scenario|Task|Behavior)\s*:\s*(.+)$/i);
    if (prefixed && prefixed[1].trim() && !prefixed[1].trim().startsWith('[') && !prefixed[1].trim().startsWith('{')) {
      return prefixed[1].trim();
    }
    for (const name of new Set([...Object.values(scenarioMap), ...(seed ? Object.values(seed) : [])])) {
      if (!name) continue;
      const code = String(name).split(' - ')[0];
      if (titleStr.includes(name) || (code && code.length >= 3 && titleStr.includes(code))) {
        return name;
      }
    }
    const code = titleStr.match(/\b([A-Z]{1,3}\d{1,2}[A-Z]\d{1,2})\b/);
    if (code) {
      for (const name of [...Object.values(scenarioMap), ...(seed ? Object.values(seed) : [])]) {
        if (name && String(name).toUpperCase().startsWith(code[1].toUpperCase())) return name;
      }
      return code[1].toUpperCase();
    }
  }

  if (bKey) return bKey;
  return UNKNOWN_SCENARIO;
}

/**
 * First-pass helper: harvest id->name pairs from raw items into running maps.
 */
function harvestMaps(rawItem, maps) {
  if (!rawItem || typeof rawItem !== 'object') return;
  maps.modelMap = maps.modelMap || {};
  maps.scenarioMap = maps.scenarioMap || {};

  const id = getRawModelId(rawItem);
  const name = getRawModelName(rawItem);
  if (id && name && !maps.modelMap[id]) maps.modelMap[id] = name;

  const bKey = getRawBehaviorKey(rawItem);
  const scenName = (typeof rawItem.scenario === 'string' && rawItem.scenario.trim())
    || (typeof rawItem.scenarioName === 'string' && rawItem.scenarioName.trim())
    || (typeof rawItem.chat?.scenario === 'string' && rawItem.chat.scenario.trim());
  if (bKey && scenName && scenName.toLowerCase() !== bKey && !maps.scenarioMap[bKey]) {
    maps.scenarioMap[bKey] = scenName;
  }
}

function generateChatFilename(chat) {
  const rawSlug = chat.challenge?.slug || 'challenge';
  const cleanSlug = String(rawSlug).replace(/[^a-zA-Z0-9_-]/g, '_');
  const rawChatId = extractId(chat.chatId) || '00000000';
  const cleanChatId = String(rawChatId).replace(/[^a-zA-Z0-9_-]/g, '');
  const shortId = cleanChatId.length >= 8 ? cleanChatId.slice(-8) : (cleanChatId || '00000000').padStart(8, '0');
  const ts = formatTimestampCompact(chat.exportedAt || chat.createdAt || new Date());
  return `chat-${cleanSlug}-${shortId}-${ts}.json`;
}

/**
 * Normalizes a raw chat/submission item into canonical arena-chat JSON.
 */
function normalizeArenaChat(rawItem, options = {}, heuristicsEngine = null) {
  if (!rawItem || typeof rawItem !== 'object') {
    throw new Error('Invalid raw chat object: expected object');
  }

  const hEngine = heuristicsEngine
    || (typeof GSAHeuristics !== 'undefined' ? GSAHeuristics : null)
    || (typeof require !== 'undefined' ? require('./heuristics') : null);

  const slug = options.slug || rawItem.challengeSlug || rawItem.challenge?.slug || 'challenge';
  const maps = { ...(options.maps || {}), slug, batchMap: options.batchMap || (options.maps && options.maps.batchMap) };

  // Re-normalize an already-canonical record against fresh maps.
  if (rawItem.formatVersion === 1 && rawItem.kind === 'arena-chat' && rawItem.chatId) {
    const classification = hEngine
      ? hEngine.classifyConversation(rawItem, rawItem.submission, { appealsMap: maps.appealsMap })
      : (rawItem.rejectionDetails || { isRejected: false, outcome: 'unknown' });
    return {
      ...rawItem,
      challenge: {
        ...(rawItem.challenge || {}),
        slug,
        name: resolveChallengeName(slug, options, rawItem)
      },
      scenario: resolveScenario(rawItem, maps),
      model: resolveModel(rawItem, maps),
      rejectionDetails: classification
    };
  }

  const nowIso = new Date().toISOString();
  const challengeName = resolveChallengeName(slug, options, rawItem);

  const chatId =
    extractId(rawItem.chatId) || extractId(rawItem.chat_id) ||
    extractId(rawItem.chat?.chatId) || extractId(rawItem.chat?.chat_id) ||
    extractId(rawItem.chat?._id) || extractId(rawItem.chat?.id) ||
    extractId(rawItem.id) || extractId(rawItem._id) ||
    extractId(rawItem.submissionId) || '';

  const behaviorId = getRawBehaviorKey(rawItem);
  const scenario = resolveScenario(rawItem, maps);
  const model = resolveModel(rawItem, maps);

  let title = rawItem.title || rawItem.promptTitle || rawItem.chat?.title || '';
  if (!title && rawItem.payload) {
    title = typeof rawItem.payload === 'string' ? rawItem.payload : JSON.stringify(rawItem.payload);
  }

  const createdAt = normalizeTimestamp(
    rawItem.createdAt || rawItem.chat?.createdAt || rawItem.created_at || rawItem.timestamp,
    nowIso
  );

  let messages = [];
  const rawMessages = rawItem.messages || rawItem.chat?.messages || rawItem.conversation || rawItem.history || [];
  if (Array.isArray(rawMessages) && rawMessages.length > 0) {
    messages = rawMessages.map(msg => normalizeMessage(msg, createdAt));
  } else if (rawItem.userPrompt || rawItem.assistantResponse) {
    if (rawItem.userPrompt) {
      messages.push({ role: 'user', content: String(rawItem.userPrompt), timestamp: createdAt });
    }
    if (rawItem.assistantResponse) {
      messages.push({
        role: 'assistant',
        content: String(rawItem.assistantResponse),
        timestamp: createdAt,
        ...(rawItem.toolCalls ? { toolCalls: rawItem.toolCalls } : {}),
        ...(typeof rawItem.toolCalled === 'boolean' ? { toolCalled: rawItem.toolCalled } : {}),
        ...(rawItem.toolCallSummary ? { toolCallSummary: String(rawItem.toolCallSummary) } : {})
      });
    }
  }

  const canonical = {
    formatVersion: 1,
    exportedAt: nowIso,
    challenge: {
      slug,
      name: challengeName,
      anonymized: rawItem.challenge?.anonymized ?? true
    },
    kind: 'arena-chat',
    chatId,
    ...(behaviorId ? { behaviorId } : {}),
    scenario,
    title,
    createdAt,
    messages,
    model
  };

  if (rawItem.submission && typeof rawItem.submission === 'object') {
    const sub = rawItem.submission;
    const subId = extractId(sub.submissionId || sub._id || sub.id);
    const ap = sub.appeal || (subId && maps.appealsMap ? maps.appealsMap[subId] : null);
    canonical.submissionMeta = {
      ...(subId ? { submissionId: subId } : {}),
      ...(sub.grade_status ? { gradeStatus: sub.grade_status } : {}),
      ...(typeof sub.successful === 'boolean' ? { successful: sub.successful } : {}),
      ...(typeof sub.grading?.is_break === 'boolean' ? { isBreak: sub.grading.is_break } : {}),
      ...(ap?.appeal_status ? { appealStatus: ap.appeal_status } : {}),
      ...(ap?.manual_status ? { manualStatus: ap.manual_status } : {}),
      ...(typeof sub.submissionCount === 'number' ? { submissionCount: sub.submissionCount } : {})
    };
  }

  canonical.rejectionDetails = hEngine
    ? hEngine.classifyConversation(canonical, rawItem.submission || rawItem, { appealsMap: maps.appealsMap })
    : { isRejected: false, outcome: 'unknown', confidence: 'low', reason: 'Heuristics engine unavailable' };

  return canonical;
}

/** Normalizes a single dialogue message while preserving tool telemetry & reasoning. */
function normalizeMessage(msg, fallbackTimestamp) {
  if (!msg || typeof msg !== 'object') {
    return { role: 'user', content: String(msg || ''), timestamp: fallbackTimestamp };
  }
  const role = (msg.role || (msg.sender === 'bot' || msg.sender === 'agent' ? 'assistant' : 'user')).toLowerCase();
  const content = msg.content ?? msg.text ?? msg.body ?? '';
  const timestamp = normalizeTimestamp(msg.timestamp || msg.createdAt || msg.created_at, fallbackTimestamp);

  const result = { role, content: String(content), timestamp };

  if (Array.isArray(msg.toolCalls) && msg.toolCalls.length > 0) {
    result.toolCalls = msg.toolCalls.map(tc => ({
      name: tc.name || tc.function?.name || 'unknown_tool',
      arguments: tc.arguments
        ? (typeof tc.arguments === 'string' ? safeJsonParse(tc.arguments) : tc.arguments)
        : {}
    }));
  }
  if (typeof msg.toolCalled === 'boolean') {
    result.toolCalled = msg.toolCalled;
  }
  if (typeof msg.toolCallSummary === 'string' && msg.toolCallSummary.trim()) {
    result.toolCallSummary = msg.toolCallSummary.trim();
  }
  if (typeof msg.reasoning === 'string' && msg.reasoning.trim()) {
    result.reasoning = msg.reasoning.trim();
  }
  if (Array.isArray(msg.attachments) && msg.attachments.length > 0) {
    result.attachments = msg.attachments;
  }
  return result;
}

function safeJsonParse(str) {
  try { return JSON.parse(str); } catch { return { raw: str }; }
}

/** Distinct sorted model names across chats + optional live challenge roster. */
function collectModels(chats, rosterModels = []) {
  const set = new Set();
  for (const r of rosterModels || []) {
    if (r && r !== UNKNOWN_MODEL) set.add(String(r));
  }
  for (const c of chats || []) {
    if (c && c.model) set.add(String(c.model));
  }
  return Array.from(set).sort((a, b) => a.localeCompare(b));
}

/** Distinct sorted scenario names across chats + optional live challenge roster. */
function collectScenarios(chats, rosterScenarios = []) {
  const set = new Set();
  for (const r of rosterScenarios || []) {
    if (r && r !== UNKNOWN_SCENARIO) set.add(String(r));
  }
  for (const c of chats || []) {
    if (c && c.scenario) set.add(String(c.scenario));
  }
  return Array.from(set).sort((a, b) => a.localeCompare(b));
}

const OUTCOME_LABELS = {
  accepted: 'Accepted',
  pending: 'Pending',
  rejected: 'Rejected',
  error: 'Submission failed'
};

function outcomeOf(chat) {
  const o = chat?.rejectionDetails?.outcome;
  if (o === 'accepted') return 'accepted';
  if (o === 'error') return 'error';
  if (o === 'rejected' || chat?.rejectionDetails?.isRejected) return 'rejected';
  return 'pending';
}

function outcomeLabel(oc) {
  return OUTCOME_LABELS[oc] || String(oc || 'Unknown');
}

function toSet(v) {
  if (!v) return null;
  if (v instanceof Set) return v.size > 0 ? v : null;
  if (Array.isArray(v)) return v.length > 0 ? new Set(v) : null;
  if (typeof v === 'string' && v !== 'all') return new Set([v]);
  return null;
}

function filterChats(chats, filters = {}) {
  const outcomes = toSet(filters.outcomes ?? filters.outcome);
  const scenarios = toSet(filters.scenarios ?? filters.scenario);
  const models = toSet(filters.models ?? filters.model);
  const q = String(filters.search || '').trim().toLowerCase();

  return (chats || []).filter(c => {
    if (outcomes && !outcomes.has(outcomeOf(c))) return false;
    if (scenarios && !scenarios.has(c.scenario)) return false;
    if (models && !models.has(c.model)) return false;
    if (q) {
      const hay = [
        c.model, c.scenario, c.behaviorId, c.title, c.chatId, c.rejectionDetails?.reason,
        ...(c.messages || []).map(m => `${m.content || ''} ${m.toolCallSummary || ''}`)
      ].join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

const SORTED_OUTCOME_FOLDERS = {
  accepted: 'Accepted',
  rejected: 'Rejected',
  pending: 'Pending',
  error: 'Failed'
};

function getSortedOutcomeFolder(outcome) {
  return SORTED_OUTCOME_FOLDERS[outcome] || 'Other';
}

function sanitizePathSegment(segment, fallback = 'Unknown') {
  if (!segment || typeof segment !== 'string') return fallback;
  let clean = segment
    .replace(/:/g, ' - ')
    .replace(/[\\/*?"<>|\x00-\x1f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[._ ]+|[._ ]+$/g, '');
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(clean)) {
    clean = `${clean}_`;
  }
  return clean || fallback;
}

function generateChatZipPath(chat, isSorted = true) {
  const filename = generateChatFilename(chat);
  if (!isSorted) return filename;

  const scenRaw = chat.scenario && chat.scenario !== UNKNOWN_SCENARIO
    ? chat.scenario
    : (chat.behaviorId || 'Uncategorized Scenario');
  const modRaw = chat.model && chat.model !== UNKNOWN_MODEL
    ? chat.model
    : 'Unknown Model';
  const oc = outcomeOf(chat);

  const scenFolder = sanitizePathSegment(scenRaw, 'Uncategorized Scenario');
  const ocFolder = getSortedOutcomeFolder(oc);
  const modFolder = sanitizePathSegment(modRaw, 'Unknown Model');

  return `${scenFolder}/${ocFolder}/${modFolder}/${filename}`;
}

function buildChatZipFiles(chats, options = {}) {
  const isSorted = options.isSorted !== false;
  const slug = options.slug || '';
  const name = options.name || (slug ? humanizeSlug(slug) : 'Arena Challenge');
  const breakStats = options.breakStats || null;

  const files = (chats || []).map(c => ({
    name: generateChatZipPath(c, isSorted),
    data: JSON.stringify(c, null, 2)
  }));

  const manifest = {
    formatVersion: 1,
    sorted: isSorted,
    folderStructure: isSorted ? '<Scenario>/<Status>/<Model>/<filename.json>' : 'flat',
    challenge: { slug, name },
    breakStats: breakStats || undefined,
    exportedAt: new Date().toISOString(),
    count: files.length,
    files: (chats || []).map((c, i) => ({
      file: files[i].name,
      chatId: c.chatId,
      model: c.model,
      scenario: c.scenario,
      outcome: outcomeOf(c)
    }))
  };

  files.push({ name: 'manifest.json', data: JSON.stringify(manifest, null, 2) });
  return files;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    KNOWN_ROSTERS,
    UNKNOWN_MODEL,
    UNKNOWN_SCENARIO,
    OUTCOME_LABELS,
    SORTED_OUTCOME_FOLDERS,
    outcomeOf,
    outcomeLabel,
    getSortedOutcomeFolder,
    sanitizePathSegment,
    generateChatZipPath,
    buildChatZipFiles,
    filterChats,
    resolveScenario,
    resolveModel,
    resolveChallengeName,
    harvestMaps,
    getRawModelId,
    getRawClassifierId,
    getRawModelName,
    getRawBehaviorKey,
    humanizeSlug,
    extractId,
    normalizeTimestamp,
    formatTimestampCompact,
    generateChatFilename,
    normalizeArenaChat,
    normalizeMessage,
    collectModels,
    collectScenarios
  };
} else if (typeof globalThis !== 'undefined') {
  globalThis.GSANormalizer = {
    KNOWN_ROSTERS,
    UNKNOWN_MODEL,
    UNKNOWN_SCENARIO,
    OUTCOME_LABELS,
    SORTED_OUTCOME_FOLDERS,
    outcomeOf,
    outcomeLabel,
    getSortedOutcomeFolder,
    sanitizePathSegment,
    generateChatZipPath,
    buildChatZipFiles,
    filterChats,
    resolveScenario,
    resolveModel,
    resolveChallengeName,
    harvestMaps,
    getRawModelId,
    getRawClassifierId,
    getRawModelName,
    getRawBehaviorKey,
    humanizeSlug,
    extractId,
    normalizeTimestamp,
    formatTimestampCompact,
    generateChatFilename,
    normalizeArenaChat,
    normalizeMessage,
    collectModels,
    collectScenarios
  };
}
