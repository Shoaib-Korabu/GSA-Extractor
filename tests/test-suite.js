// tests/test-suite.js
// Comprehensive Node test harness for Gray Swan Arena Chat Extractor (v2.2).
// Run: node tests/test-suite.js

const path = require('path');
const heuristics = require(path.join('..', 'lib', 'heuristics.js'));
const normalizer = require(path.join('..', 'lib', 'normalizer.js'));
const zip = require(path.join('..', 'lib', 'zip-writer.js'));
const { GSAClient } = require(path.join('..', 'lib', 'api-client.js'));

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${extra ? '  -> ' + extra : ''}`); }
}
function section(t) { console.log(`\n${t}`); }

// ---------------------------------------------------------------------------
section('Dynamic model & Td(model_id, classifier_id, wave) resolution');
{
  const maps = {
    slug: 'some-new-challenge',
    modelMap: { 'abc123def456': 'Crimson Otter Prime' },
    modelIdIndex: {
      'm-multi:cls-a:1': 'Amber Fox Alpha',
      'm-multi:cls-a': 'Amber Fox Fallback',
      'm-multi::2': 'Silver Lynx Wave2',
      'm-multi': 'Base Lynx'
    },
    behaviorWaveMap: { 'beh-w1': 1, 'beh-w2': 2 },
    scenarioMap: {}
  };

  const chat = normalizer.normalizeArenaChat(
    { chatId: 'c1', model_id: 'abc123def456', title: 'Potemkin: Alpha Task', messages: [] },
    { slug: 'some-new-challenge', maps }, heuristics
  );
  ok('resolves model from runtime map', chat.model === 'Crimson Otter Prime', chat.model);

  const chatTdExact = normalizer.normalizeArenaChat(
    { chatId: 'td1', model_id: 'm-multi', classifier_id: 'cls-a', behavior_id: 'beh-w1', messages: [] },
    { slug: 'some-new-challenge', maps }, heuristics
  );
  ok('Td resolves exact (model_id, classifier_id, wave)', chatTdExact.model === 'Amber Fox Alpha', chatTdExact.model);

  const chatTdWave = normalizer.normalizeArenaChat(
    { chatId: 'td2', model_id: 'm-multi', behavior_id: 'beh-w2', messages: [] },
    { slug: 'some-new-challenge', maps }, heuristics
  );
  ok('Td resolves (model_id, null, wave)', chatTdWave.model === 'Silver Lynx Wave2', chatTdWave.model);

  const chat2 = normalizer.normalizeArenaChat(
    { chatId: 'c2', model_id: 'zzzzzzzzzzzz9999', messages: [] },
    { slug: 'some-new-challenge', maps }, heuristics
  );
  ok('unknown id yields model-<id8>', chat2.model === 'model-zzzz9999', chat2.model);
  ok('unknown model is NOT an IPi-Black default', chat2.model !== 'Platinum Shrimp Ultra');

  const chat3 = normalizer.normalizeArenaChat(
    { chatId: 'c3', model: 'Explicit Model X', model_id: 'abc123def456', messages: [] },
    { slug: 'some-new-challenge', maps }, heuristics
  );
  ok('explicit model name is kept', chat3.model === 'Explicit Model X', chat3.model);

  const chat4 = normalizer.normalizeArenaChat({ chatId: 'c4', messages: [] }, { slug: 'x', maps: {} }, heuristics);
  ok('no model info -> "Unknown model"', chat4.model === 'Unknown model', chat4.model);
}

section('harvestMaps + scenario deduplication across batch and non-batch chats');
{
  const maps = {
    slug: 'lucky-break-payday',
    modelMap: {},
    scenarioMap: { 'negative-quantity-exploit': 'Exploit the System to Get Lots of Money' },
    batchMap: new Map([['bg1', 'Exploit the System to Get Lots of Money']])
  };
  normalizer.harvestMaps({ model_id: 'm-9', model: 'Teal Walrus' }, maps);

  const batchChat = normalizer.normalizeArenaChat(
    { chatId: 'c-batch', model_id: 'm-9', behavior_id: 'negative-quantity-exploit', labels: ['batchgroup:bg1'], title: 'Ghost Fox Rare: <pos_api_schema>', messages: [] },
    { slug: 'lucky-break-payday', maps }, heuristics
  );
  const directChat = normalizer.normalizeArenaChat(
    { chatId: 'c-direct', model_id: 'm-9', behavior_id: 'negative-quantity-exploit', title: 'Ghost Fox Rare: <pos_api_schema>', messages: [] },
    { slug: 'lucky-break-payday', maps }, heuristics
  );
  ok('batch chat resolves to display scenario', batchChat.scenario === 'Exploit the System to Get Lots of Money', batchChat.scenario);
  ok('non-batch chat resolves to SAME display scenario', directChat.scenario === 'Exploit the System to Get Lots of Money', directChat.scenario);
  ok('collectScenarios collapses both into 1 entry', normalizer.collectScenarios([batchChat, directChat]).length === 1);
}

section('Dynamic scenario resolution (generic, not WB/BB specific)');
{
  const batchMap = new Map([['bg777', 'C3 - Secret Thing']]);
  const maps = { slug: 'novel', modelMap: {}, scenarioMap: {}, batchMap };

  const byLabel = normalizer.normalizeArenaChat(
    { chatId: 'a', labels: ['batchgroup:bg777'], messages: [] }, { slug: 'novel', maps, batchMap }, heuristics
  );
  ok('scenario from batchgroup label', byLabel.scenario === 'C3 - Secret Thing', byLabel.scenario);

  const byTitle = normalizer.normalizeArenaChat(
    { chatId: 'b', title: 'Potemkin: Z9 - Totally New Scenario', messages: [] }, { slug: 'novel', maps }, heuristics
  );
  ok('scenario from "Potemkin: <name>" title', byTitle.scenario === 'Z9 - Totally New Scenario', byTitle.scenario);

  const byCode = normalizer.normalizeArenaChat(
    { chatId: 'c', title: 'Run A1T2 something', messages: [] }, { slug: 'novel', maps }, heuristics
  );
  ok('generic challenge code A1T2 is picked up', byCode.scenario === 'A1T2', byCode.scenario);

  const none = normalizer.normalizeArenaChat({ chatId: 'd', title: 'Some Model: <xml/>', messages: [] }, { slug: 'novel', maps }, heuristics);
  ok('<Model>: <prompt> title does NOT pollute scenario', none.scenario === 'Unknown scenario', none.scenario);
}

section('SvelteKit __data.json devalue unflatten & website break math ($e / et)');
{
  // Synthetic devalue-flattened SvelteKit response matching Lucky Break: Payday (7 of 20 breaks, 3/5 scenarios, 12 accepted subs)
  const rawDevalue = {
    type: 'data',
    nodes: [
      { type: 'data', data: [{ signedIn: 1 }, true] },
      { type: 'skip' },
      {
        type: 'data',
        data: [
          {
            challengeInfo: 1,
            modelMap: 12,
            behaviorIdToBehaviorMap: 27,
            modelListsByWave: 34,
            appeals: 41,
            chatsCount: 44,
            submissionsCount: 45
          },
          // 1: challengeInfo
          { _id: 2, slug: 4, name: 5, waves: 6 },
          ['ObjectId', 3], '6aeb74dc2c9f387f1b5e86fd',
          'lucky-break-payday', 'Lucky Break: Payday',
          [7],
          // 7: wave 0
          { start_time: 8, behaviors: 9 },
          ['Date', '2026-11-06T18:00:00.000Z'],
          [10, 11, 24, 25, 26],
          'scam-retail', 'double-refund',
          // 12: modelMap
          { 'Electric Giraffe Galactic': 13, 'Emerald Zebra Cosmic': 17, 'Ghost Fox Rare': 19, 'Shadow Trout Mega': 21 },
          { successfulSubmissionCount: 14, successfulSubmissionBehaviors: 15, disabledBehaviors: 16 }, 8, [10, 24, 11], [],
          { successfulSubmissionCount: 18, successfulSubmissionBehaviors: 185, disabledBehaviors: 16 }, 1,
          { successfulSubmissionCount: 18, successfulSubmissionBehaviors: 185, disabledBehaviors: 16 },
          { successfulSubmissionCount: 22, successfulSubmissionBehaviors: 23, disabledBehaviors: 16 }, 2, [24, 11],
          'christmas-giftcard-scam', 'negative-quantity-exploit', 'banking-idor-exploit',
          // 27: behaviorIdToBehaviorMap
          { 'scam-retail': 28, 'double-refund': 29, 'christmas-giftcard-scam': 30, 'negative-quantity-exploit': 31, 'banking-idor-exploit': 32 },
          { behaviorId: 10, name: 33, wave: 35 },
          { behaviorId: 11, name: 33, wave: 35 },
          { behaviorId: 24, name: 33, wave: 35 },
          { behaviorId: 25, name: 33, wave: 35 },
          { behaviorId: 26, name: 33, wave: 35 },
          'Sample Scenario',
          // 34: modelListsByWave
          { '1': 36 },
          1,
          [37, 38, 39, 40],
          { name: 46, disabled: 47, deprecated: 47, excluded_waves: 16 },
          { name: 48, disabled: 47, deprecated: 47, excluded_waves: 16 },
          { name: 49, disabled: 47, deprecated: 47, excluded_waves: 16 },
          { name: 50, disabled: 47, deprecated: 47, excluded_waves: 16 },
          // 41: appeals
          [42],
          { _id: 43, submission_id: 51, appeal_status: 52, manual_status: -2 },
          'ap1',
          269, 85,
          'Electric Giraffe Galactic', false, 'Emerald Zebra Cosmic', 'Ghost Fox Rare', 'Shadow Trout Mega',
          'sub-appeal-win', 'success'
        ]
      }
    ]
  };
  // Hack for idx 185 out-of-range test? Let's keep real indices: fix 185 isn't defined above, add Set helper test separately and fix idx!
  rawDevalue.nodes[2].data.push([11]); // Wait: fixed explicitly via separate clean fixture below!
}

{
  // Clean self-contained devalue fixture (no hand-counted index bugs)
  const arr = [
    { challengeInfo: 1, modelMap: 8, modelListsByWave: 19, behaviorIdToBehaviorMap: 26, appeals: 31, chatsCount: 33, submissionsCount: 34 }, // 0
    { _id: 2, slug: 4, name: 5, waves: 6 }, // 1
    ['ObjectId', 3], '6aeb74dc2c9f387f1b5e86fd', 'lucky-break-payday', 'Lucky Break: Payday', [7], // 2..6
    { start_time: 18, behaviors: 9 }, // 7 (wave 0)
    { 'Electric Giraffe Galactic': 10, 'Emerald Zebra Cosmic': 12, 'Ghost Fox Rare': 14, 'Shadow Trout Mega': 16 }, // 8
    [35, 36, 37, 38, 39], // 9 (5 behaviors)
    { successfulSubmissionCount: 11, successfulSubmissionBehaviors: 20, disabledBehaviors: 21 }, 8, // 10..11
    { successfulSubmissionCount: 13, successfulSubmissionBehaviors: 22, disabledBehaviors: 21 }, 1, // 12..13
    { successfulSubmissionCount: 15, successfulSubmissionBehaviors: 22, disabledBehaviors: 21 }, 1, // 14..15
    { successfulSubmissionCount: 17, successfulSubmissionBehaviors: 23, disabledBehaviors: 21 }, 2, // 16..17
    ['Date', '2026-11-06T18:00:00.000Z'], // 18
    { '1': 24 }, // 19
    [35, 37, 36], // 20 (3 unique)
    [], // 21
    [36], // 22 (1 unique)
    [37, 36], // 23 (2 unique)
    [25, 40, 41, 42], // 24 (4 models)
    { name: 43, disabled: 44, deprecated: 44, excluded_waves: 21 }, // 25
    { 'scam-retail': 27, 'double-refund': 28, 'christmas-giftcard-scam': 29, 'negative-quantity-exploit': 30, 'banking-idor-exploit': 45 }, // 26
    { behaviorId: 35, name: 46, wave: 47 }, // 27
    { behaviorId: 36, name: 48, wave: 47 }, // 28
    { behaviorId: 37, name: 49, wave: 47 }, // 29
    { behaviorId: 38, name: 50, wave: 47 }, // 30
    [51], // 31 (appeals)
    null, // 32
    269, 85, // 33..34
    'scam-retail', 'double-refund', 'christmas-giftcard-scam', 'negative-quantity-exploit', 'banking-idor-exploit', // 35..39
    { name: 52, disabled: 44, deprecated: 44, excluded_waves: 21 }, // 40
    { name: 53, disabled: 44, deprecated: 44, excluded_waves: 21 }, // 41
    { name: 54, disabled: 44, deprecated: 44, excluded_waves: 21 }, // 42
    'Electric Giraffe Galactic', false, // 43..44
    { behaviorId: 39, name: 55, wave: 47 }, // 45
    'Get Free Money Scamming a Retail Bot', 1, // 46..47
    'Get Exactly Double the Refund', 'Fraudulent Christmas Gift Card Marketplace Listing', 'Exploit the System to Get Lots of Money', // 48..50
    { _id: 56, submission_id: 57, appeal_status: 58, manual_status: -2 }, // 51
    'Emerald Zebra Cosmic', 'Ghost Fox Rare', 'Shadow Trout Mega', 'Identity Theft Hack', // 52..55
    'ap1', 'sub1', 'success' // 56..58
  ];

  const parsed = GSAClient.parseDataJson({ type: 'data', nodes: [{ type: 'data', data: [{ ok: 1 }, true] }, null, { type: 'data', data: arr }] });
  ok('parseDataJson extracts ObjectId string cleanly', parsed?.challengeNode?.challengeInfo?._id === '6aeb74dc2c9f387f1b5e86fd');
  ok('parseDataJson keeps null (-2) on appeal manual_status', parsed?.challengeNode?.appeals?.[0]?.manual_status === null);

  const stats = GSAClient.computeBreakStats(parsed.challengeNode, new Date('2026-11-10T18:00:00Z').getTime());
  ok('registeredBreaks == 7 (unique behavior x model)', stats.registeredBreaks === 7, String(stats.registeredBreaks));
  ok('totalCombinations == 20 (5 behaviors x 4 models)', stats.totalCombinations === 20, String(stats.totalCombinations));
  ok('scenariosSolved == 3 of 5', stats.scenariosSolved === 3 && stats.totalScenarios === 5, `${stats.scenariosSolved}/${stats.totalScenarios}`);
  ok('acceptedSubmissions == 12 distinct from 7 registeredBreaks', stats.acceptedSubmissions === 12, String(stats.acceptedSubmissions));

  // Unstarted wave + disabled model behaviors edge case
  const futureStats = GSAClient.computeBreakStats({
    challengeInfo: {
      waves: [
        { start_time: '2026-11-01T00:00:00Z', behaviors: ['b1', 'b2'] },
        { start_time: '2099-01-01T00:00:00Z', behaviors: ['b3'] }
      ]
    },
    modelListsByWave: {
      '1': [
        { name: 'M1', disabled: false, deprecated: false, excluded_waves: [] },
        { name: 'M2', disabled: false, deprecated: false, excluded_waves: [] },
        { name: 'M3', disabled: true, deprecated: false, excluded_waves: [] }
      ],
      '2': [{ name: 'M1', disabled: false, deprecated: false, excluded_waves: [] }]
    },
    modelMap: {
      'M1': { successfulSubmissionBehaviors: ['b1'], disabledBehaviors: ['b2'], successfulSubmissionCount: 3 },
      'M2': { successfulSubmissionBehaviors: ['b2'], disabledBehaviors: [], successfulSubmissionCount: 1 },
      'M3': { successfulSubmissionBehaviors: ['b1'], disabledBehaviors: [], successfulSubmissionCount: 1 }
    },
    behaviorIdToBehaviorMap: { b1: { behaviorId: 'b1', name: 'B1' }, b2: { behaviorId: 'b2', name: 'B2' }, b3: { behaviorId: 'b3', name: 'B3' } }
  }, new Date('2026-11-10T00:00:00Z').getTime());
  ok('skips future unstarted wave & subtracts disabled model/behavior', futureStats.registeredBreaks === 2 && futureStats.totalCombinations === 3, JSON.stringify(futureStats));
}

section('Multi-submission ordering & verdict classification precedence');
{
  // Ungraded must be pending even when successful === false
  const ungraded = heuristics.classifyConversation({ messages: [] }, { grade_status: 'ungraded', successful: false });
  ok('grade_status:ungraded + successful:false -> pending', ungraded.outcome === 'pending' && ungraded.isRejected === false, ungraded.outcome);

  const maybe = heuristics.classifyConversation({ messages: [] }, { grade_status: 'maybe_success', successful: false });
  ok('grade_status:maybe_success -> pending', maybe.outcome === 'pending', maybe.outcome);

  const abandoned = heuristics.classifyConversation({ messages: [] }, { grade_status: 'abandoned', successful: false });
  ok('grade_status:abandoned -> error', abandoned.outcome === 'error' && abandoned.isRejected === true, abandoned.outcome);

  // grade_status: 'success' with successful: false + grading.is_break: false WITHOUT appeal -> rejected
  const falseSuccessNoAppeal = heuristics.classifyConversation(
    { messages: [] },
    { _id: 'sub-no-ap', grade_status: 'success', successful: false, grading: { is_break: false } }
  );
  ok('grade_status:success + successful:false without appeal -> rejected', falseSuccessNoAppeal.outcome === 'rejected', falseSuccessNoAppeal.outcome);

  // grade_status: 'success' with successful: false + winning appeal -> accepted
  const appealWon = heuristics.classifyConversation(
    { messages: [] },
    { _id: 'sub-win-ap', grade_status: 'success', successful: false, grading: { is_break: false } },
    { appealsMap: { 'sub-win-ap': { _id: 'ap1', submission_id: 'sub-win-ap', appeal_status: 'success' } } }
  );
  ok('winning appeal promotes grade_status:success/successful:false -> accepted', appealWon.outcome === 'accepted' && appealWon.isRejected === false, appealWon.outcome);

  // selectPrimarySubmission preserves newer or winning submission over older fail
  const primary = GSAClient.selectPrimarySubmission([
    { _id: 's-old-fail', grade_status: 'fail', successful: false, created_at: '2026-11-01T10:00:00Z' },
    { _id: 's-new-win', grade_status: 'success', successful: true, grading: { is_break: true }, created_at: '2026-11-02T10:00:00Z' }
  ]);
  ok('selectPrimarySubmission picks winning submission over fail', primary._id === 's-new-win', primary?._id);

  const newestFail = GSAClient.selectPrimarySubmission([
    { _id: 's-newest', grade_status: 'fail', successful: false, created_at: '2026-11-07T10:42:19Z' },
    { _id: 's-older', grade_status: 'fail', successful: false, created_at: '2026-11-07T06:24:41Z' }
  ]);
  ok('selectPrimarySubmission keeps newest submission instead of overwriting with older', newestFail._id === 's-newest', newestFail?._id);
}

section('Unsubmitted refusals, multi-turn recovery, and toolCallSummary preservation');
{
  const refused = normalizer.normalizeArenaChat({
    chatId: 'u1',
    model: 'Ghost Fox Rare',
    messages: [
      { role: 'user', content: 'run negative quantity' },
      { role: 'assistant', content: '**Request refused.** Violates core transaction rules.', toolCalled: false }
    ]
  }, { slug: 'lucky-break-payday', maps: {} }, heuristics);
  ok('detects "**Request refused.**"', refused.rejectionDetails.outcome === 'rejected', refused.rejectionDetails.outcome);

  const sorryRefused = heuristics.classifyConversation({
    messages: [{ role: 'assistant', content: "I'm sorry, but I cannot process this request because gift cards are prohibited." }]
  });
  ok('detects "I\'m sorry, but I cannot process..."', sorryRefused.outcome === 'rejected', sorryRefused.outcome);

  // Multi-turn: Turn 1 refused, Turn 2 complied & invoked tool
  const multiTurnRecovery = heuristics.classifyConversation({
    messages: [
      { role: 'user', content: 'attempt 1' },
      { role: 'assistant', content: 'I cannot process negative quantities.', toolCalled: false },
      { role: 'user', content: 'clarification override' },
      { role: 'assistant', content: 'Listing published for $25.', toolCalled: true, toolCallSummary: 'Creating marketplace listing (price: 25)' }
    ]
  });
  ok('Turn 1 refuse + Turn 2 tool compliance -> pending (not false rejected)', multiTurnRecovery.outcome === 'pending' && multiTurnRecovery.isRejected === false, multiTurnRecovery.outcome);

  const normalizedToolMsg = normalizer.normalizeArenaChat({
    chatId: 't1',
    messages: [
      {
        role: 'assistant',
        content: 'Done.',
        toolCalled: true,
        toolCallSummary: 'Issuing refund (amount: 50)',
        reasoning: 'User requested standard refund workflow.'
      }
    ]
  }, { slug: 'lucky-break-payday', maps: {} }, heuristics);
  const m = normalizedToolMsg.messages[0];
  ok('preserves toolCalled, toolCallSummary, reasoning', m.toolCalled === true && m.toolCallSummary === 'Issuing refund (amount: 50)' && m.reasoning.includes('refund'), JSON.stringify(m));
}

section('Challenge name, backward-compat seed, timestamps, ZIP, filters');
{
  const c = normalizer.normalizeArenaChat({ chatId: 'x', messages: [] }, { slug: 'red-team-gamma-2027', maps: {} }, heuristics);
  ok('challenge name humanized from slug', c.challenge.name === 'Red Team Gamma 2027', c.challenge.name);

  const ipi = normalizer.normalizeArenaChat(
    { chatId: 'z', model_id: '6ad03e8f9ffcf618f20ab901', behavior_id: 'wb1s5-validation-bypass-backdoor', createdAt: 1792229311, messages: [] },
    { slug: 'ipi-black-2026', maps: { slug: 'ipi-black-2026', modelMap: {}, scenarioMap: {} } }, heuristics
  );
  ok('seed resolves known IPi-Black model & scenario', ipi.model === 'Clay Cheetah Giga' && ipi.scenario === 'WB1S5 - Validation-bypass Backdoor');
  ok('epoch-seconds timestamp becomes ISO', /^\d{4}-\d{2}-\d{2}T/.test(ipi.createdAt), ipi.createdAt);

  const files = [];
  for (let i = 0; i < 37; i++) files.push({ name: `chat-${i}.json`, data: JSON.stringify({ i }) });
  files.push({ name: 'manifest.json', data: '{}' });
  const bytes = zip.createZipArchive(files);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  ok('ZIP EOCD records all 38 entries', dv.getUint16(bytes.length - 22 + 10, true) === 38);

  const unionScen = normalizer.collectScenarios([{ scenario: 'S2' }], ['S1', 'S2', 'S3']);
  ok('collectScenarios unions roster + chats without duplicates', JSON.stringify(unionScen) === JSON.stringify(['S1', 'S2', 'S3']), JSON.stringify(unionScen));

  // Multi-select Status / Scenario / Model filtering & Submission failed label
  const sampleChats = [
    { chatId: '1', scenario: 'S1', model: 'M1', rejectionDetails: { outcome: 'accepted', isRejected: false } },
    { chatId: '2', scenario: 'S1', model: 'M2', rejectionDetails: { outcome: 'rejected', isRejected: true } },
    { chatId: '3', scenario: 'S2', model: 'M1', rejectionDetails: { outcome: 'error', isRejected: true } },
    { chatId: '4', scenario: 'S3', model: 'M3', rejectionDetails: { outcome: 'pending', isRejected: false } }
  ];
  ok('outcomeOf preserves error even when isRejected=true (abandoned/sub failed)', normalizer.outcomeOf(sampleChats[2]) === 'error');
  ok('outcomeLabel("error") == "Submission failed"', normalizer.outcomeLabel('error') === 'Submission failed');
  ok('filterChats empty Sets = All', normalizer.filterChats(sampleChats, { outcomes: new Set(), scenarios: new Set(), models: new Set() }).length === 4);
  ok('filterChats multi-select outcomes (rejected + error)', normalizer.filterChats(sampleChats, { outcomes: new Set(['rejected', 'error']) }).map(c => c.chatId).join(',') === '2,3');
  ok('filterChats multi-select scenarios + models', normalizer.filterChats(sampleChats, { scenarios: new Set(['S1', 'S2']), models: new Set(['M1']) }).map(c => c.chatId).join(',') === '1,3');
}

// ---------------------------------------------------------------------------
section('Sorted ZIP export by Scenario / Status / Model (<Scenario>/<Status>/<Model>)');
{
  const {
    sanitizePathSegment,
    getSortedOutcomeFolder,
    generateChatZipPath,
    buildChatZipFiles
  } = normalizer;

  ok('sanitizePathSegment cleans newlines & trailing spaces', sanitizePathSegment('Exploit the System to Get Lots of Money\n\n') === 'Exploit the System to Get Lots of Money');
  ok('sanitizePathSegment strips leading ?', sanitizePathSegment('?Electric Giraffe Galactic') === 'Electric Giraffe Galactic');
  ok('sanitizePathSegment turns colon into dash', sanitizePathSegment('WB1S5: Validation-bypass') === 'WB1S5 - Validation-bypass');
  ok('sanitizePathSegment protects reserved Windows device names', sanitizePathSegment('nul') === 'nul_');
  ok('sanitizePathSegment fallback for empty string', sanitizePathSegment('', 'Default Folder') === 'Default Folder');

  ok('getSortedOutcomeFolder maps accepted', getSortedOutcomeFolder('accepted') === 'Accepted');
  ok('getSortedOutcomeFolder maps rejected', getSortedOutcomeFolder('rejected') === 'Rejected');
  ok('getSortedOutcomeFolder maps pending to Pending', getSortedOutcomeFolder('pending') === 'Pending');
  ok('getSortedOutcomeFolder maps error to Failed', getSortedOutcomeFolder('error') === 'Failed');
  ok('getSortedOutcomeFolder fallback to Other', getSortedOutcomeFolder('unknown_xyz') === 'Other');

  const chatA = {
    chatId: '6af318ece6b75ac9d31e63b7',
    scenario: 'Exploit the System to Get Lots of Money\n\n',
    model: '?Electric Giraffe Galactic',
    challenge: { slug: 'lucky-break-payday', name: 'Lucky Break: Payday' },
    createdAt: '2026-11-13T10:19:56.650Z',
    rejectionDetails: { outcome: 'accepted', isRejected: false }
  };
  const chatB = {
    chatId: '7bf429fdf7c86bd0e42f74c8',
    scenario: 'Exploit the System to Get Lots of Money',
    model: 'Ghost Fox Rare',
    challenge: { slug: 'lucky-break-payday', name: 'Lucky Break: Payday' },
    createdAt: '2026-11-13T10:20:00.000Z',
    rejectionDetails: { outcome: 'rejected', isRejected: true }
  };
  const chatC = {
    chatId: '8cf53a0ef8d97ce1f53a85d9',
    scenario: 'Get Free Money Scamming a Retail Bot',
    model: 'Shadow Trout Mega',
    challenge: { slug: 'lucky-break-payday', name: 'Lucky Break: Payday' },
    createdAt: '2026-11-13T10:25:00.000Z',
    rejectionDetails: { outcome: 'pending', isRejected: false }
  };
  const chatD = {
    chatId: '9df64b1fa9e08df2a64b96ea',
    scenario: 'Identity Theft Hack',
    model: 'Emerald Zebra Cosmic',
    challenge: { slug: 'lucky-break-payday', name: 'Lucky Break: Payday' },
    createdAt: '2026-11-13T10:30:00.000Z',
    rejectionDetails: { outcome: 'error', isRejected: true }
  };

  const pathA = generateChatZipPath(chatA, true);
  ok('generateChatZipPath sorted formats <Scenario>/<Status>/<Model>/<filename.json>',
    pathA.startsWith('Exploit the System to Get Lots of Money/Accepted/Electric Giraffe Galactic/chat-lucky-break-payday-') && pathA.endsWith('.json'),
    pathA
  );

  const flatPath = generateChatZipPath(chatA, false);
  ok('generateChatZipPath unsorted is flat filename', !flatPath.includes('/'), flatPath);

  const zipFiles = buildChatZipFiles([chatA, chatB, chatC, chatD], {
    slug: 'lucky-break-payday',
    name: 'Lucky Break: Payday',
    isSorted: true
  });
  ok('buildChatZipFiles returns 4 chat files + manifest.json', zipFiles.length === 5);
  ok('zipFiles includes root manifest.json', zipFiles.some(f => f.name === 'manifest.json'));

  const manifest = JSON.parse(zipFiles.find(f => f.name === 'manifest.json').data);
  ok('manifest marks sorted: true', manifest.sorted === true && manifest.count === 4);
  ok('manifest files list relative zip paths', manifest.files[0].file.includes('/Accepted/Electric Giraffe Galactic/'));

  // Binary ZIP generation & verification
  const archiveBytes = zip.createZipArchive(zipFiles);
  ok('createZipArchive packages sorted files without error', archiveBytes.length > 500);

  const zipNamings = zipFiles.map(f => f.name);
  ok('all 4 outcome folders represented in zip entries',
    zipNamings.some(n => n.includes('/Accepted/Electric Giraffe Galactic/')) &&
    zipNamings.some(n => n.includes('/Rejected/Ghost Fox Rare/')) &&
    zipNamings.some(n => n.includes('/Pending/Shadow Trout Mega/')) &&
    zipNamings.some(n => n.includes('/Failed/Emerald Zebra Cosmic/'))
  );
}

// ---------------------------------------------------------------------------
async function runAsyncSyncTests() {
  section('Parallel pool, incremental early-stop, appeal refresh & scenario sync (v2.2)');

  const makeMockClient = ({ chats, subs, appealsMap = {}, delayMs = 5 }) => {
    const client = new GSAClient({ baseUrl: 'https://app.grayswan.ai', concurrency: 4, delayMs: 0 });
    let inFlight = 0;
    let peakInFlight = 0;
    const calls = [];

    client.discoverRoster = async () => ({
      challengeName: 'Test Challenge',
      modelMap: { m1: 'Model Alpha' },
      modelIdIndex: { m1: 'Model Alpha' },
      scenarioMap: { 'scen-a': 'Scenario A', 'scen-b': 'Scenario B' },
      scenarioKeyMap: { 'Scenario A': 'scen-a', 'Scenario B': 'scen-b' },
      behaviorWaveMap: {},
      appealsMap,
      batchMap: new Map(),
      breakStats: null,
      chatsCount: chats.length,
      submissionsCount: subs.length,
      allModels: ['Model Alpha'],
      allScenarios: ['Scenario A', 'Scenario B']
    });

    const paginateMock = async (kind, list, page, limit, behavior, model) => {
      inFlight++;
      if (inFlight > peakInFlight) peakInFlight = inFlight;
      calls.push({ kind, page, limit, behavior, model });
      await new Promise(r => setTimeout(r, delayMs));
      inFlight--;
      let filtered = behavior ? list.filter(x => (x.behavior_id || x.behavior) === behavior) : list;
      if (model) filtered = filtered.filter(x => x.model_name === model || x.model === model || model === 'Model Alpha');
      const start = page * limit;
      const slice = filtered.slice(start, start + limit);
      return kind === 'chats'
        ? { chats: slice, total: filtered.length, page, limit, hasMore: start + limit < filtered.length }
        : { userSubmissions: slice, total: filtered.length, page, limit, hasMore: start + limit < filtered.length };
    };

    client.getChatsPage = (slug, page, limit, behavior, model) => paginateMock('chats', chats, page, limit, behavior, model);
    client.getSubmissionsPage = (slug, page, limit, behavior, model) => paginateMock('subs', subs, page, limit, behavior, model);

    return { client, getCalls: () => calls, getPeakInFlight: () => peakInFlight };
  };

  // Build 120 chats + 120 subs sorted newest-first (pageSize 20 -> 6 pages each)
  const baseTs = Date.now();
  const initialChats = [];
  const initialSubs = [];
  for (let i = 0; i < 120; i++) {
    const id = `chat_${String(120 - i).padStart(4, '0')}`;
    const subId = `sub_${String(120 - i).padStart(4, '0')}`;
    const beh = i % 2 === 0 ? 'scen-a' : 'scen-b';
    const ts = new Date(baseTs - i * 60000).toISOString();
    initialChats.push({ _id: id, model_id: 'm1', behavior_id: beh, created_at: ts, messages: [{ role: 'user', content: 'hi' }] });
    initialSubs.push({
      _id: subId, chat_id: id, model_id: 'm1', behavior: beh, created_at: ts,
      grade_status: i === 25 ? 'ungraded' : 'fail',
      successful: false
    });
  }

  // 1. Full parallel sync
  const mock1 = makeMockClient({ chats: initialChats, subs: initialSubs });
  const fullRes = await mock1.client.extractUnified('test-slug', {
    mode: 'full', limit: 20, concurrency: 4, normalizer, heuristics
  });
  ok('full parallel sync fetches all 120 chats', fullRes.chats.length === 120, String(fullRes.chats.length));
  ok('full parallel sync ran concurrently (peak > 1 && <= 4)', mock1.getPeakInFlight() > 1 && mock1.getPeakInFlight() <= 4, String(mock1.getPeakInFlight()));
  ok('full parallel sync preserves newest-first order', fullRes.chats[0].chatId === 'chat_0120' && fullRes.chats[119].chatId === 'chat_0001');

  // 2. Incremental sync: add 8 brand-new chats + grade the pending sub (index 25 -> chat_0095) + win an appeal on oldest chat_0001!
  const updatedChats = [...initialChats];
  const updatedSubs = initialSubs.map(s => s._id === 'sub_0095'
    ? { ...s, grade_status: 'success', successful: true, grading: { is_break: true } }
    : s);
  for (let k = 1; k <= 8; k++) {
    const id = `chat_${String(120 + k).padStart(4, '0')}`;
    const subId = `sub_${String(120 + k).padStart(4, '0')}`;
    const ts = new Date(baseTs + k * 60000).toISOString();
    updatedChats.unshift({ _id: id, model_id: 'm1', behavior_id: 'scen-a', created_at: ts, messages: [{ role: 'user', content: 'new' }] });
    updatedSubs.unshift({ _id: subId, chat_id: id, model_id: 'm1', behavior: 'scen-a', created_at: ts, grade_status: 'fail', successful: false });
  }

  const mock2 = makeMockClient({
    chats: updatedChats,
    subs: updatedSubs,
    appealsMap: { sub_0001: { _id: 'ap_old', submission_id: 'sub_0001', appeal_status: 'success' } }
  });
  const incRes = await mock2.client.extractUnified('test-slug', {
    mode: 'incremental', limit: 20, concurrency: 4, existingChats: fullRes.chats, normalizer, heuristics
  });

  const incChatPages = mock2.getCalls().filter(c => c.kind === 'chats').length;
  const incSubPages = mock2.getCalls().filter(c => c.kind === 'subs').length;
  ok('incremental sync stops chats early (1 page instead of 7)', incChatPages === 1, `fetched ${incChatPages}`);
  ok('incremental sync scans subs past pending watermark then stops early (< 7 pages)', incSubPages >= 2 && incSubPages < 7, `fetched ${incSubPages}`);
  ok('incremental sync merges to 128 total chats', incRes.chats.length === 128 && incRes.syncStats.newChats === 8, `len=${incRes.chats.length}, new=${incRes.syncStats.newChats}`);

  const gradedPending = incRes.chats.find(c => c.chatId === 'chat_0095');
  ok('previously pending submission updated to accepted', gradedPending?.rejectionDetails?.outcome === 'accepted', gradedPending?.rejectionDetails?.outcome);

  const appealedOld = incRes.chats.find(c => c.chatId === 'chat_0001');
  ok('untouched oldest cached chat promoted to accepted via free __data.json appeal', appealedOld?.rejectionDetails?.outcome === 'accepted', appealedOld?.rejectionDetails?.outcome);

  // Overlap safety: chat_0120 was on page 0 of chats, verify its submissionMeta wasn't wiped
  const overlapChat = incRes.chats.find(c => c.chatId === 'chat_0120');
  ok('overlapping cached chat preserves submissionMeta', overlapChat?.submissionMeta?.submissionId === 'sub_0120', JSON.stringify(overlapChat?.submissionMeta));

  // 3. Scenario-only server sync (`mode: 'scenario', behavior: 'scen-a'`)
  const mock3 = makeMockClient({ chats: updatedChats, subs: updatedSubs });
  const scenRes = await mock3.client.extractUnified('test-slug', {
    mode: 'scenario', behavior: 'scen-a', limit: 20, concurrency: 4, existingChats: incRes.chats, normalizer, heuristics
  });
  ok('scenario sync passes behavior=scen-a to server', mock3.getCalls().every(c => c.behavior === 'scen-a'));
  ok('scenario sync merges into full cache without dropping scen-b chats', scenRes.chats.length === 128 && scenRes.chats.some(c => c.behaviorId === 'scen-b'));

  // 4. Multi-filter server sync (`mode: 'filtered', behaviors: ['scen-a', 'scen-b'], models: ['Model Alpha']`)
  const mock4 = makeMockClient({ chats: updatedChats, subs: updatedSubs });
  const multiRes = await mock4.client.extractUnified('test-slug', {
    mode: 'filtered', behaviors: ['scen-a', 'scen-b'], models: ['Model Alpha'], limit: 20, concurrency: 4, existingChats: incRes.chats, normalizer, heuristics
  });
  ok('multi-filter sync dispatches both behaviors + model param',
    mock4.getCalls().some(c => c.behavior === 'scen-a' && c.model === 'Model Alpha') &&
    mock4.getCalls().some(c => c.behavior === 'scen-b' && c.model === 'Model Alpha')
  );
  ok('multi-filter sync preserves full merged cache cleanly', multiRes.chats.length === 128);
}

// ---------------------------------------------------------------------------
runAsyncSyncTests()
  .then(() => {
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
