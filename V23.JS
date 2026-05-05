// ==UserScript==
// @name         StudyGuide AI Automation v13 - Text + Gemini Images MODIFICATION
// @namespace    https://github.com/studyguide-automation
// @version      13.0.0
// @description  v13 — Automated exam study-guide generation. Text pages + Gemini images + equations + charts, captured from DOM and posted to Google Docs via Apps Script.
// @author       StudyGuide Automation
// @match        https://chat.openai.com/*
// @match        https://chatgpt.com/*
// @match        https://gemini.google.com/*
// @match        https://aistudio.google.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// @grant        GM_notification
// @grant        GM_openInTab
// @connect      script.google.com
// @connect      script.googleusercontent.com
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ─────────────────────────────────────────────────────────────
  //  TRUSTED TYPES SHIM  (must run before any innerHTML assignment)
  //  Recent ChatGPT builds enforce "require-trusted-types-for 'script'"
  //  which rejects raw string innerHTML and kills our whole UI with
  //  "This document requires 'TrustedHTML' assignment." Register a
  //  local policy and transparently wrap every innerHTML/outerHTML
  //  setter used by our panel's code.
  // ─────────────────────────────────────────────────────────────
  (function installTrustedTypesShim() {
    try {
      if (!(window.trustedTypes && typeof window.trustedTypes.createPolicy === 'function')) return;

      let policy = null;
      try {
        policy = window.trustedTypes.createPolicy('studyguide-auto', {
          createHTML:      (s) => String(s),
          createScript:    (s) => String(s),
          createScriptURL: (s) => String(s),
        });
      } catch (_) {
        // The name might already be taken if the script re-injects — fall
        // back to a uniquely-named policy so we still get a working wrapper.
        try {
          policy = window.trustedTypes.createPolicy('studyguide-auto-' + Date.now(), {
            createHTML:      (s) => String(s),
            createScript:    (s) => String(s),
            createScriptURL: (s) => String(s),
          });
        } catch (err) {
          console.warn('[StudyGuide] Unable to create Trusted Types policy:', err);
          return;
        }
      }

      const patch = (proto, prop) => {
        if (!proto) return;
        const desc = Object.getOwnPropertyDescriptor(proto, prop);
        if (!desc || !desc.set) return;
        if (proto['__sgPatched_' + prop]) return;
        const origSet = desc.set;
        Object.defineProperty(proto, prop, {
          configurable: true,
          enumerable: desc.enumerable,
          get: desc.get,
          set(v) {
            try {
              if (typeof v === 'string') v = policy.createHTML(v);
            } catch (_) {}
            return origSet.call(this, v);
          },
        });
        proto['__sgPatched_' + prop] = true;
      };

      patch(Element.prototype, 'innerHTML');
      patch(Element.prototype, 'outerHTML');
      if (window.ShadowRoot && ShadowRoot.prototype) patch(ShadowRoot.prototype, 'innerHTML');
    } catch (err) {
      console.warn('[StudyGuide] Trusted Types shim failed:', err);
    }
  })();

  // ─────────────────────────────────────────────────────────────
  //  CONSTANTS & STORAGE
  // ─────────────────────────────────────────────────────────────
  const APP_ID = 'SG_V13';
  const GEMINI_URL = 'https://gemini.google.com/app';

  const STORAGE_KEYS = {
    APPS_SCRIPT_URL: `${APP_ID}_appsScriptUrl`,
    DOC_ID:          `${APP_ID}_docId`,
    SECRET_KEY:      `${APP_ID}_secretKey`,
    EXAM_CONFIG:     `${APP_ID}_examConfig`,
    IMAGE_CONFIG:    `${APP_ID}_imageConfig`,
    DOMAINS:         `${APP_ID}_domains`,
    REF_CONFIG:      `${APP_ID}_refConfig`,
    WORKFLOW:        `${APP_ID}_workflow`,
    PROGRESS:        `${APP_ID}_progress`,
    PIPELINE_STATE:  `${APP_ID}_pipelineState`,
    PRACTICE_CONFIG: `${APP_ID}_practiceConfig`,
    SAMPLE_MAPPING:  `${APP_ID}_sampleMapping`,
    SAMPLE_MAPPING_META: `${APP_ID}_sampleMappingMeta`,
    CONTROL:         `${APP_ID}_control`,
    SNAP_AUTO_DOMAINS:    `${APP_ID}_snap_autoDomains`,
    SNAP_DOMAIN_MAPPING:  `${APP_ID}_snap_domainMapping`,
    SNAP_PAGE_ALLOC:      `${APP_ID}_snap_pageAlloc`,
    SNAP_SAMPLE_MAPPING:  `${APP_ID}_snap_sampleMapping`,
    FREE_RESPONSE_MAPPING: `${APP_ID}_freeResponseMapping`,
    SNAP_FREE_RESPONSE_MAPPING: `${APP_ID}_snap_freeResponseMapping`,
    ISSUE_LOG:            `${APP_ID}_issueLogDev`,
    VOICE_CONFIG:         `${APP_ID}_voiceConfig`,
  };

  const STATE = {
    IDLE:    'IDLE',
    RUNNING: 'RUNNING',
    PAUSED:  'PAUSED',
    STOPPED: 'STOPPED',
    ERROR:   'ERROR',
  };

  // Default configurations (all image toggles default ON per spec)
  const DEFAULT_EXAM_CONFIG = {
    examName:       '',
    freeResponseAvailable: false,
    difficultyLevel: 'academic_college_level',
    totalPages:     50,
    wordsPerPage:   650,
    minLinesPerPara: 4,
    maxLinesPerPara: 8,
    startFromPage:  1,
  };

  const DEFAULT_PRACTICE_CONFIG = {
    totalQuestions:   100,
    explMinLength:    80,
    explMaxLength:    250,
    explMinLines:     5,
    explMaxLines:     7,
    explLineMinWords: 10,
    explLineMaxWords: 22,
  };

  const DEFAULT_VOICE_CONFIG = {
    enabled: false,
    rate: 0.94,
    pitch: 0.95,
    volume: 1.0,
    selectedVoiceName: '',
  };

  // Sample Question Mapping — fields to auto-detect with weights
  // Each field receives a weight% and a detected value from GPT after outline upload.
  const SAMPLE_MAPPING_FIELDS = [
    { key: 'scenarioBased',   label: 'Scenario-based questions',   unit: '%' },
    { key: 'definitionType',  label: 'Definition type',             unit: '%' },
    { key: 'recallStatement', label: 'Recall / Statemental type',   unit: '%' },
    { key: 'applicationBased',label: 'Application-based',           unit: '%' },
    { key: 'fillInTheBlanks', label: 'Fill in the blanks',          unit: '%' },
    { key: 'tableBased',      label: 'Table-based',                 unit: '%' },
    { key: 'statementsLength',label: 'Statements length (words)',   unit: 'w' },
    { key: 'scenarioLength',  label: 'Scenario statement length',   unit: 'w' },
    { key: 'definitionLength',label: 'Definition statement length', unit: 'w' },
    { key: 'recallLength',    label: 'Recall statement length',     unit: 'w' },
    { key: 'fillBlankLength', label: 'Fill-in-blank statement length', unit: 'w' },
    { key: 'tableLength',     label: 'Table-based statement length', unit: 'w' },
    { key: 'chartsLength',    label: 'Charts/Graphs statement length', unit: 'w' },
    { key: 'maxStatementLength', label: 'Maximum statement length', unit: 'w' },
    { key: 'optionsCount',    label: 'Options count (per MCQ)',     unit: 'n' },
    { key: 'chartsGraphsImg', label: 'Charts / Graphs / Images',    unit: '%' },
  ];
  const SAMPLE_TYPE_KEYS = [
    'scenarioBased',
    'definitionType',
    'recallStatement',
    'applicationBased',
    'fillInTheBlanks',
    'tableBased',
    'chartsGraphsImg',
  ];

  // Extra detected-only descriptors (not part of numeric weight totals)
  const SAMPLE_MAPPING_EXTRA_KEYS = [];

  const DEFAULT_SAMPLE_MAPPING = (() => {
    const m = {};
    SAMPLE_MAPPING_FIELDS.forEach(f => { m[f.key] = { weight: 0, detected: '' }; });
    return m;
  })();
  const DEFAULT_SAMPLE_MAPPING_META = {
    totalDetectedQuestions: 0,
    typeCounts: {},
    plannedTypeCounts: {},
  };

  /** Free-response style profile merged from pipeline (global) + per-domain FR GPT passes. Second pass updates/overrides non-empty fields. */
  function defaultFreeResponseMappingState() {
    return { pipeline: {}, merged: {}, lastMergedFromDomain: '' };
  }

  /** Editable/viewable numeric knobs + metadata shown in FR mapping panel — values live on `merged`. */
  const FR_MAPPING_PANEL_NUMERIC_ROWS = [
    { key: 'fr_statement_words', label: 'FR stem words (GPT target)', hint: '' },
    { key: 'fr_option_words', label: 'FR option-line words', hint: 'Fallback: ~45% stem if unset' },
    { key: 'fr_roman_point_words', label: '(i)/(ii) roman point words', hint: 'Fallback: ~60% option if unset' },
    { key: 'fr_options_count', label: 'Options per FR item (A,B,…)', hint: '' },
    { key: 'est_sample_total_questions', label: 'Estimated total samples (exam-wide)', hint: 'Pipeline heuristic' },
    { key: 'est_sample_fr_questions', label: 'Estimated FR samples (exam-wide)', hint: 'Pipeline heuristic' },
    { key: 'est_fr_share_percent', label: 'FR share % (exam-wide est.)', hint: 'Pipeline heuristic' },
  ];

  const FR_JSON_SCHEMA_HINT = `
Return STRICT JSON only (numbers wherever noted; arrays may be empty):
{
  "fr_statement_words": 0,
  "fr_option_words": 0,
  "fr_roman_point_words": 0,
  "fr_options_count": 0,
  "sample_total_questions_estimate": 0,
  "sample_fr_questions_estimate": 0,
  "free_response_percentage_estimate": 0,
  "basis_for_questions": "",
  "stem_structure_notes": "",
  "marking_rubric_hints": "",
  "typical_lengths_words": {"short":"","medium":"","long":""},
  "response_components": ["..."],
  "format_rules": ["..."],
  "concept_rules": ["..."],
  "free_response_categories": [
    {"name":"","weight_percent":0,"description":""}
  ]
}`;

  const DEFAULT_IMAGE_CONFIG = {
    enableGemini:           false,
    requiresPlus:           true,
    equationsAsImages:      true,
    mathVisualRendering:    true,
    generateCharts:         true,
    dataChartsSupplyDemand: true,
    generateDiagrams:       true,
    networkAnatomyFlow:     true,
    maxWaitGeminiSec:       120,
  };

  const DEFAULT_REF_CONFIG = {
    reminderEveryPages:  5,
    validateQuality:     true,
    stripSourceMentions: true,
    autoStopOnMissing:   true, // always forced true on load/save; reserved for storage merge only
  };

  const DEFAULT_WORKFLOW = {
    outlineUploaded: false,
    booksUploaded:   false,
    samplesUploaded: false,
  };

  const DEFAULT_PROGRESS = {
    percent:    0,
    message:    'Waiting to start...',
    pagesDone:  0,
    pagesTotal: 0,
    done:       0,
    failed:     0,
    retries:    0,
    words:      0,
    skipped:    0,
    images:     0,
    questions:  0,
    recent:     [],
    currentPage: 0,
    // ── Checkpoint fields — let "Start Generation" resume at the right step ──
    // phase order: … → outline → how_to_use → why_trust → mapping → alloc
    // → samples → sample_mapping → books → verify → domain → done
    phase:         'idle',
    /** Becomes true after first successful pass into `domain`; used to run GPT-tab resync on later Start presses. */
    pipelineEnteredDomainOnce: false,
    /** Bump when pre-domain phase order changes; used for one-time checkpoint migration. */
    orchestratorSchema: 3,
    domainIdx:     0,   // current domain index (0-based)
    // subPhase within a domain: 'overview' | 'purpose' | 'target' | 'memory' | 'content' | 'freeResponse' | 'done'
    subPhase:      'overview',
    overviewPage:  0,   // 0 = none done, 1 = page1 done, 2 = page2 done
    subIdx:        0,   // index of current subdomain within the domain
    subPageDone:   0,   // pages of current subdomain already saved
    practiceDone:  0,   // questions already saved for the current domain
  };

  const DEFAULT_CONTROL = {
    desiredState: STATE.IDLE,
    heartbeatTs: 0,
    ownerTab: '',
    updatedAt: 0,
  };

  // Memory guards for long-running GPT sessions
  const GPT_MEMORY_GUARDS = {
    MAX_ASSISTANT_MSGS_BEFORE_RESET: 55,
    MAX_PROMPT_CHARS: 22000,
  };

  // v13 Enforced reference rules (shown in UI, always on)
  const V13_RULES = [
    'Reference books ONLY — zero training data',
    'Domain/Subdomain headings: once on first page ONLY',
    'Specific ###topic headings — no generic names',
    'Math/Physics: real equations, not placeholders',
    'Chemistry: balanced reactions with state symbols',
    'Code: complete runnable examples with output',
    'Missing reference → Upload/Skip popup',
    'v13 NEW: Gemini images generated automatically',
    'Prose + separate DISPLAY blocks for examples / equations / reactions like a print book',
  ];

  // ─────────────────────────────────────────────────────────────
  //  STYLES
  // ─────────────────────────────────────────────────────────────
  GM_addStyle(`
    #sg-panel {
      position: fixed !important;
      top: 70px !important;
      right: 16px !important;
      width: 420px !important;
      max-height: 92vh !important;
      background: #0b1220 !important;
      color: #e2e8f0 !important;
      border: 1px solid #1e293b !important;
      border-radius: 14px !important;
      box-shadow: 0 25px 60px rgba(0,0,0,0.65) !important;
      font-family: 'Segoe UI', system-ui, sans-serif !important;
      font-size: 13px !important;
      z-index: 2147483647 !important;
      display: flex !important;
      flex-direction: column !important;
      overflow: hidden !important;
      opacity: 1 !important;
      visibility: visible !important;
      pointer-events: auto !important;
      transform: none !important;
    }
    #sg-panel.collapsed { max-height: 50px !important; }
    #sg-panel[hidden], #sg-panel.sg-hide { display: none !important; }
    #sg-header {
      background: linear-gradient(135deg, #1e3a5f, #0f4c81);
      padding: 11px 14px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      cursor: pointer;
      user-select: none;
      flex-shrink: 0;
    }
    #sg-header h3 {
      margin: 0;
      font-size: 14px;
      font-weight: 700;
      color: #7dd3fc;
      letter-spacing: 0.4px;
    }
    #sg-header-controls { display: flex; gap: 6px; align-items: center; }
    .sg-hbtn {
      background: rgba(255,255,255,0.12);
      border: none;
      color: #e2e8f0;
      padding: 3px 8px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 12px;
    }
    .sg-hbtn:hover { background: rgba(255,255,255,0.25); }
    #sg-voice-btn.active {
      background: rgba(14, 165, 233, 0.35);
      color: #e0f2fe;
      box-shadow: 0 0 0 1px rgba(125,211,252,0.45) inset;
    }
    #sg-body {
      overflow-y: auto;
      flex: 1;
      padding: 12px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    #sg-body::-webkit-scrollbar { width: 6px; }
    #sg-body::-webkit-scrollbar-track { background: #0f172a; }
    #sg-body::-webkit-scrollbar-thumb { background: #334155; border-radius: 3px; }

    .sg-section {
      background: #111c30;
      border: 1px solid #1e293b;
      border-radius: 10px;
      padding: 11px 12px;
    }
    .sg-section-title {
      font-size: 12px;
      font-weight: 700;
      color: #7dd3fc;
      letter-spacing: 0.5px;
      margin-bottom: 8px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .sg-section-sub {
      font-size: 10.5px;
      color: #64748b;
      margin-bottom: 8px;
      line-height: 1.45;
    }
    .sg-badge-required {
      background: #7f1d1d;
      color: #fecaca;
      font-size: 9px;
      font-weight: 800;
      padding: 2px 7px;
      border-radius: 10px;
      letter-spacing: 0.5px;
    }
    .sg-badge-on {
      background: #052e16;
      color: #4ade80;
      font-size: 9px;
      font-weight: 800;
      padding: 2px 7px;
      border-radius: 10px;
      letter-spacing: 0.5px;
      border: 1px solid #16a34a;
    }

    .sg-grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
    .sg-grid-3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px; }

    .sg-field { margin-bottom: 8px; }
    .sg-field label {
      display: block;
      font-size: 11px;
      color: #94a3b8;
      margin-bottom: 3px;
      font-weight: 600;
    }
    .sg-field input, .sg-field textarea, .sg-field select {
      width: 100%;
      background: #0b1220;
      border: 1px solid #1e293b;
      border-radius: 6px;
      color: #e2e8f0;
      padding: 6px 9px;
      font-size: 12px;
      box-sizing: border-box;
      outline: none;
    }
    .sg-field input:focus, .sg-field textarea:focus {
      border-color: #3b82f6;
      box-shadow: 0 0 0 2px rgba(59,130,246,0.15);
    }
    .sg-field textarea { resize: vertical; min-height: 52px; }

    /* Toggle row */
    .sg-toggle-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 5px 0;
      border-bottom: 1px dashed #1e293b;
    }
    .sg-toggle-row:last-child { border-bottom: none; }
    .sg-toggle-label {
      flex: 1;
      font-size: 11.5px;
      color: #cbd5e1;
    }
    .sg-toggle-sub {
      display: block;
      font-size: 10px;
      color: #64748b;
      margin-top: 2px;
    }
    .sg-toggle {
      position: relative;
      width: 36px;
      height: 20px;
      background: #334155;
      border-radius: 20px;
      cursor: pointer;
      transition: background 0.2s;
      flex-shrink: 0;
    }
    .sg-toggle::before {
      content: '';
      position: absolute;
      top: 2px;
      left: 2px;
      width: 16px;
      height: 16px;
      background: #fff;
      border-radius: 50%;
      transition: left 0.2s;
    }
    .sg-toggle.on {
      background: #16a34a;
    }
    .sg-toggle.on::before { left: 18px; }

    /* Save button */
    .sg-save-btn {
      width: 100%;
      background: #2563eb;
      color: #fff;
      border: none;
      border-radius: 7px;
      padding: 7px;
      font-size: 11.5px;
      font-weight: 700;
      cursor: pointer;
      transition: background 0.2s;
      margin-top: 6px;
    }
    .sg-save-btn:hover { background: #1d4ed8; }

    /* v13 Rule list */
    .sg-rules {
      list-style: none;
      margin: 0; padding: 0;
      font-size: 11px;
      color: #cbd5e1;
    }
    .sg-rules li { padding: 3px 0; }
    .sg-rules li::before {
      content: '✓ ';
      color: #4ade80;
      font-weight: 700;
      margin-right: 3px;
    }

    /* Workflow */
    .sg-step-card {
      background: #0b1220;
      border: 1px solid #1e293b;
      border-radius: 8px;
      padding: 10px;
      margin-bottom: 8px;
    }
    .sg-step-title {
      font-size: 12px;
      font-weight: 700;
      color: #e2e8f0;
      margin-bottom: 3px;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .sg-step-sub {
      font-size: 10.5px;
      color: #94a3b8;
      margin-bottom: 7px;
      line-height: 1.4;
    }
    .sg-step-actions { display: flex; gap: 6px; }
    .sg-step-btn {
      flex: 1;
      padding: 6px 8px;
      border-radius: 6px;
      border: 1px solid #334155;
      background: #1e293b;
      color: #cbd5e1;
      font-size: 11px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.15s;
    }
    .sg-step-btn:hover { background: #334155; }
    .sg-step-btn.primary { background: #2563eb; border-color: #3b82f6; color: #fff; }
    .sg-step-btn.primary:hover { background: #1d4ed8; }
    .sg-step-btn.confirmed { background: #052e16; border-color: #16a34a; color: #4ade80; }

    /* Domains list */
    #sg-domains-list {
      display: flex; flex-direction: column; gap: 6px;
      margin-bottom: 8px;
    }
    .sg-domain-row {
      display: grid;
      grid-template-columns: 1fr 70px 26px;
      gap: 6px;
      align-items: center;
    }
    .sg-domain-row input {
      background: #0b1220;
      border: 1px solid #1e293b;
      border-radius: 6px;
      color: #e2e8f0;
      padding: 5px 8px;
      font-size: 11.5px;
      outline: none;
    }
    .sg-domain-row input:focus { border-color: #3b82f6; }
    .sg-domain-del {
      background: #2d0000;
      border: 1px solid #dc2626;
      color: #f87171;
      border-radius: 5px;
      cursor: pointer;
      font-size: 12px;
      padding: 4px;
    }
    .sg-domain-del:hover { background: #7f1d1d; color: #fff; }
    .sg-domain-hint {
      font-size: 10px;
      color: #64748b;
      margin-bottom: 6px;
      font-style: italic;
    }

    /* Sample mapping rows */
    #sg-sample-mapping-list {
      display: flex; flex-direction: column; gap: 6px;
    }
    .sg-sm-row {
      display: grid;
      grid-template-columns: 1.5fr 68px 90px;
      gap: 6px;
      align-items: center;
    }
    .sg-sm-label {
      font-size: 11.5px;
      color: #cbd5e1;
      line-height: 1.25;
    }
    .sg-sm-label small {
      display: block;
      font-size: 9.5px;
      color: #64748b;
      margin-top: 1px;
    }
    .sg-sm-row input {
      background: #0b1220;
      border: 1px solid #1e293b;
      border-radius: 6px;
      color: #e2e8f0;
      padding: 5px 7px;
      font-size: 11.5px;
      outline: none;
      width: 100%;
      box-sizing: border-box;
    }
    .sg-sm-row input:focus { border-color: #3b82f6; }
    .sg-sm-detected {
      font-size: 11px;
      font-weight: 700;
      color: #4ade80;
      background: #052e16;
      border: 1px solid #16a34a;
      border-radius: 6px;
      padding: 5px 7px;
      text-align: center;
      min-height: 18px;
      line-height: 1.2;
    }
    .sg-sm-detected.empty {
      color: #64748b;
      background: #0b1220;
      border-color: #334155;
      font-weight: 500;
      font-style: italic;
    }

    /* Big Auto Generate button */
    #sg-auto-generate {
      width: 100%;
      background: linear-gradient(135deg, #059669, #0d9488);
      color: #fff;
      border: none;
      border-radius: 10px;
      padding: 13px;
      font-size: 14px;
      font-weight: 800;
      cursor: pointer;
      letter-spacing: 0.5px;
      transition: all 0.2s;
      text-transform: uppercase;
    }
    #sg-auto-generate:hover { opacity: 0.92; transform: translateY(-1px); }
    #sg-auto-generate:disabled { opacity: 0.45; transform: none; cursor: not-allowed; }
    #sg-auto-generate .sg-subline {
      display: block;
      font-size: 9.5px;
      font-weight: 500;
      color: rgba(255,255,255,0.78);
      margin-top: 3px;
      text-transform: none;
      letter-spacing: 0.2px;
    }

    /* Progress */
    #sg-progress-wrap {
      background: #0b1220;
      border-radius: 5px;
      height: 10px;
      overflow: hidden;
      border: 1px solid #1e293b;
    }
    #sg-progress-bar {
      height: 100%;
      background: linear-gradient(90deg, #2563eb, #7c3aed, #059669);
      border-radius: 5px;
      transition: width 0.4s ease;
      width: 0%;
    }
    .sg-progress-stats {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 6px;
      margin-top: 9px;
    }
    .sg-stat {
      background: #0b1220;
      border: 1px solid #1e293b;
      border-radius: 7px;
      padding: 6px 8px;
      text-align: center;
    }
    .sg-stat-val {
      display: block;
      font-size: 14px;
      font-weight: 800;
      color: #7dd3fc;
      line-height: 1.2;
    }
    .sg-stat-lbl {
      display: block;
      font-size: 9.5px;
      color: #94a3b8;
      text-transform: uppercase;
      letter-spacing: 0.4px;
      margin-top: 2px;
    }
    .sg-stat.ok .sg-stat-val    { color: #4ade80; }
    .sg-stat.fail .sg-stat-val  { color: #f87171; }
    .sg-stat.retry .sg-stat-val { color: #fbbf24; }
    .sg-stat.skip .sg-stat-val  { color: #94a3b8; }
    .sg-stat.img .sg-stat-val   { color: #c084fc; }
    .sg-stat.word .sg-stat-val  { color: #7dd3fc; }

    #sg-progress-text {
      font-size: 11px;
      color: #94a3b8;
      margin-top: 6px;
      text-align: center;
    }
    #sg-progress-pct {
      font-size: 22px;
      font-weight: 800;
      color: #7dd3fc;
      text-align: center;
      margin-bottom: 4px;
    }

    /* Recent pages */
    #sg-recent-pages {
      max-height: 100px;
      overflow-y: auto;
      background: #0b1220;
      border: 1px solid #1e293b;
      border-radius: 6px;
      padding: 5px 8px;
      font-size: 10.5px;
      color: #94a3b8;
      margin-top: 8px;
    }
    #sg-recent-pages::-webkit-scrollbar { width: 4px; }
    #sg-recent-pages::-webkit-scrollbar-thumb { background: #334155; }
    .sg-recent-item {
      padding: 2px 0;
      border-bottom: 1px dashed #1e293b;
      display: flex;
      justify-content: space-between;
    }
    .sg-recent-item:last-child { border-bottom: none; }
    .sg-recent-status { font-size: 10px; font-weight: 700; }

    /* Control buttons */
    .sg-controls {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 6px;
    }
    .sg-btn {
      border: none;
      border-radius: 7px;
      padding: 8px 5px;
      font-size: 10.5px;
      font-weight: 700;
      cursor: pointer;
      transition: all 0.15s;
      letter-spacing: 0.3px;
    }
    .sg-btn:disabled { opacity: 0.4; cursor: not-allowed; }
    .sg-btn-start  { background: #16a34a; color: #fff; }
    .sg-btn-start:hover:not(:disabled)  { background: #15803d; }
    .sg-btn-pause  { background: #d97706; color: #fff; }
    .sg-btn-pause:hover:not(:disabled)  { background: #b45309; }
    .sg-btn-resume { background: #0891b2; color: #fff; }
    .sg-btn-resume:hover:not(:disabled) { background: #0e7490; }
    .sg-btn-stop   { background: #dc2626; color: #fff; }
    .sg-btn-stop:hover:not(:disabled)   { background: #b91c1c; }
    .sg-btn-retry  { background: #7c3aed; color: #fff; }
    .sg-btn-retry:hover:not(:disabled)  { background: #6d28d9; }
    .sg-btn-skip   { background: #475569; color: #fff; }
    .sg-btn-skip:hover:not(:disabled)   { background: #334155; }
    .sg-btn-reset  { background: #1e293b; color: #f87171; border: 1px solid #dc2626; grid-column: span 3; }
    .sg-btn-reset:hover:not(:disabled)  { background: #7f1d1d; color: #fff; }
    .sg-btn-verify { background: linear-gradient(135deg, #0f766e, #0891b2); color: #fff; }
    .sg-btn-verify:hover:not(:disabled) { background: linear-gradient(135deg, #0d5e57, #0e7490); }

    /* Generation lane tracker (study / free response) */
    .sg-lane-wrap {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 6px;
      margin-top: 8px;
    }
    .sg-lane-chip {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 7px;
      border-radius: 999px;
      border: 1px solid #334155;
      background: linear-gradient(180deg,#111827,#0b1220);
      color: #cbd5e1;
      padding: 8px 7px;
      font-size: 9.5px;
      font-weight: 700;
      letter-spacing: 0.2px;
      text-align: center;
      white-space: nowrap;
    }
    .sg-lane-dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: #475569;
      box-shadow: 0 0 0 0 rgba(148,163,184,0.35);
      flex: 0 0 auto;
    }
    .sg-lane-chip.active {
      border-color: #38bdf8;
      color: #e0f2fe;
      background: linear-gradient(135deg,#0f172a,#132a43);
      box-shadow: inset 0 0 0 1px rgba(56,189,248,0.28), 0 0 22px rgba(56,189,248,0.16);
    }
    .sg-lane-chip.active .sg-lane-dot {
      background: radial-gradient(circle at 35% 30%, #e0f2fe 0%, #38bdf8 45%, #0284c7 100%);
      animation: sg-lane-spin 1.05s linear infinite, sg-lane-glow 1.8s ease-in-out infinite;
      box-shadow: 0 0 0 3px rgba(56,189,248,0.16), 0 0 14px rgba(56,189,248,0.42);
    }
    @keyframes sg-lane-spin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }
    @keyframes sg-lane-glow {
      0%,100% { filter: saturate(1); }
      50% { filter: saturate(1.25) brightness(1.12); }
    }

    /* Phase navigator (10 shortcuts) + collapsible blocks */
    .sg-phase-nav {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 6px;
      margin-bottom: 8px;
    }
    @media (min-width: 420px) {
      .sg-phase-nav { grid-template-columns: repeat(5, 1fr); }
    }
    .sg-phase-jump-btn {
      font-size: 9.5px;
      font-weight: 700;
      padding: 8px 5px;
      border-radius: 8px;
      border: 1px solid #334155;
      background: linear-gradient(180deg,#1e293b,#0f172a);
      color: #e2e8f0;
      cursor: pointer;
      line-height: 1.25;
      text-align: center;
    }
    .sg-phase-jump-btn:hover {
      border-color: #7dd3fc;
      background: #334155;
    }
    .sg-phase-jump-btn.sg-phase-jump-btn-active {
      border-color: #7dd3fc;
      box-shadow: 0 0 0 2px rgba(125,211,252,0.35);
      background: #334155;
    }
    #sg-body div.sg-phase-block {
      background: #111c30;
      border: 1px solid #1e293b;
      border-radius: 10px;
      margin-bottom: 10px;
      overflow: visible;
    }
    #sg-body button.sg-phase-summary-btn {
      cursor: pointer;
      padding: 10px 12px;
      font-size: 11.5px;
      font-weight: 700;
      color: #7dd3fc;
      letter-spacing: 0.35px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      user-select: none;
      background: linear-gradient(90deg,#0f172a,#111c30);
      border: none;
      border-bottom: 1px solid #334155;
      width: 100%;
      box-sizing: border-box;
      font-family: inherit;
      text-align: left;
    }
    #sg-body button.sg-phase-summary-btn:hover { filter: brightness(1.08); }
    /* Phase visibility enforced in JS (.style setProperty important) — host CSS fights these rules otherwise */
    .sg-phase-inner { padding: 11px 12px 12px; }

    /* Status */
    #sg-status-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 3px 9px;
      border-radius: 20px;
      font-size: 10.5px;
      font-weight: 700;
    }
    .badge-idle    { background: #1e293b; color: #64748b; border: 1px solid #334155; }
    .badge-running { background: #052e16; color: #4ade80; border: 1px solid #16a34a; }
    .badge-paused  { background: #431407; color: #fb923c; border: 1px solid #d97706; }
    .badge-stopped { background: #1a1a1a; color: #94a3b8; border: 1px solid #475569; }
    .badge-error   { background: #2d0000; color: #f87171; border: 1px solid #dc2626; }
    .badge-dot {
      width: 6px; height: 6px; border-radius: 50%;
      background: currentColor;
    }
    .badge-running .badge-dot { animation: sg-pulse 1.2s ease-in-out infinite; }
    @keyframes sg-pulse { 0%,100%{opacity:1} 50%{opacity:0.3} }

    /* Live console */
    #sg-console {
      background: #020617;
      border: 1px solid #1e293b;
      border-radius: 7px;
      padding: 8px 10px;
      font-family: 'Courier New', Consolas, monospace;
      font-size: 10.5px;
      height: 150px;
      overflow-y: auto;
      color: #94a3b8;
      line-height: 1.5;
    }
    #sg-console::-webkit-scrollbar { width: 4px; }
    #sg-console::-webkit-scrollbar-thumb { background: #334155; border-radius: 2px; }
    .log-info  { color: #60a5fa; }
    .log-ok    { color: #4ade80; }
    .log-warn  { color: #fbbf24; }
    .log-error { color: #f87171; }
    .log-img   { color: #c084fc; }
    .log-sys   { color: #94a3b8; font-style: italic; }

    /* Step notification banner */
    #sg-step-notify {
      background: linear-gradient(135deg, #78350f, #b45309);
      border: 1px solid #f59e0b;
      border-radius: 8px;
      padding: 10px 12px;
      color: #fef3c7;
      font-size: 12px;
      font-weight: 600;
      display: none;
      line-height: 1.4;
      animation: sg-blink 1.6s ease-in-out infinite;
    }
    #sg-step-notify .sg-notify-title {
      display: block;
      font-size: 13px;
      color: #fff;
      margin-bottom: 2px;
    }
    @keyframes sg-blink {
      0%,100% { box-shadow: 0 0 0 0 rgba(245,158,11,0.0); }
      50%     { box-shadow: 0 0 0 4px rgba(245,158,11,0.35); }
    }

    /* Upload / Skip popup */
    #sg-popup-overlay {
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.72);
      display: none;
      align-items: center;
      justify-content: center;
      z-index: 2147483646;
    }
    #sg-popup {
      background: #0b1220;
      border: 1px solid #dc2626;
      border-radius: 12px;
      padding: 22px;
      width: 420px;
      max-width: 90vw;
      box-shadow: 0 25px 60px rgba(0,0,0,0.8);
      color: #e2e8f0;
    }
    #sg-popup h3 {
      margin: 0 0 10px 0;
      color: #f87171;
      font-size: 16px;
    }
    #sg-popup p {
      font-size: 12px;
      color: #cbd5e1;
      line-height: 1.5;
      margin-bottom: 14px;
    }
    #sg-popup .sg-popup-btns {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
    }
  `);

  // ─────────────────────────────────────────────────────────────
  //  RUNTIME STATE
  // ─────────────────────────────────────────────────────────────
  let currentState = STATE.IDLE;
  let _sgPageVisWired = false;
  let _sgUnloadWired = false;
  let abortFlag    = false;
  let pauseFlag    = false;
  /** Tracks last nav-selection for same-button toggle (click again = collapse all phases). */
  let studyGuideNavLastPhaseId = null;
  /** Visual tracker for current generation lane: studyguide | free_response | ''. */
  let activeGenerationLane = '';
  let voiceConfig = loadObj(STORAGE_KEYS.VOICE_CONFIG, DEFAULT_VOICE_CONFIG);
  let _sgVoiceLastText = '';
  let _sgVoiceLastTs = 0;
  let _sgVoiceLockedName = '';

  // Confirmation resolvers — startGeneration awaits these when it needs
  // the user to do something in ChatGPT (upload outline / samples / books).
  const pendingConfirm = {
    outline:  null,
    samples:  null,
    books:    null,
    newBook:  null,
    resumeContext: null,
  };
  const popupContext = { mode: 'missing_reference' };
  let subjectRulesAcknowledged = false;
  let examConfig     = loadObj(STORAGE_KEYS.EXAM_CONFIG,     DEFAULT_EXAM_CONFIG);
  let imageConfig    = loadObj(STORAGE_KEYS.IMAGE_CONFIG,    DEFAULT_IMAGE_CONFIG);
  let refConfig      = loadObj(STORAGE_KEYS.REF_CONFIG,      DEFAULT_REF_CONFIG);
  refConfig.autoStopOnMissing = true; // always enforced; no opt-out (legacy storage may have had false)
  let workflow       = loadObj(STORAGE_KEYS.WORKFLOW,        DEFAULT_WORKFLOW);
  let progress       = loadObj(STORAGE_KEYS.PROGRESS,        DEFAULT_PROGRESS);
  let domains        = loadObj(STORAGE_KEYS.DOMAINS,         []); // [{name, weight}]
  let practiceConfig = loadObj(STORAGE_KEYS.PRACTICE_CONFIG, DEFAULT_PRACTICE_CONFIG);
  let sampleMapping  = loadObj(STORAGE_KEYS.SAMPLE_MAPPING,  DEFAULT_SAMPLE_MAPPING);
  let sampleMappingMeta = loadObj(STORAGE_KEYS.SAMPLE_MAPPING_META, DEFAULT_SAMPLE_MAPPING_META);
  let freeResponseMapping = (() => {
    const fb = loadObj(STORAGE_KEYS.FREE_RESPONSE_MAPPING, null);
    if (!fb || typeof fb !== 'object') return defaultFreeResponseMappingState();
    const pipe = fb.pipeline && typeof fb.pipeline === 'object' ? fb.pipeline : {};
    const mer = fb.merged && typeof fb.merged === 'object' ? fb.merged : {};
    const lastDom = fb.lastMergedFromDomain != null ? String(fb.lastMergedFromDomain) : '';
    return { pipeline: { ...pipe }, merged: { ...mer }, lastMergedFromDomain: lastDom };
  })();
  hydrateMappingSnapshotsFromStorage();

  // Recover from the old index-keyed-object bug: if prior versions of the
  // script stored `domains` as { "0": {...}, "1": {...} } instead of a real
  // array, convert it back now so .map / .reduce / .forEach don't throw.
  if (!Array.isArray(domains)) {
    try {
      if (domains && typeof domains === 'object') {
        const arr = Object.keys(domains)
          .filter(k => /^\d+$/.test(k))
          .sort((a, b) => +a - +b)
          .map(k => domains[k]);
        domains = arr;
      } else {
        domains = [];
      }
    } catch (_) { domains = []; }
    saveObj(STORAGE_KEYS.DOMAINS, domains);
    console.warn('[StudyGuide] Recovered domains[] from legacy storage shape.');
  }

  // ─────────────────────────────────────────────────────────────
  //  UI BUILD
  // ─────────────────────────────────────────────────────────────
  function buildUI() {
    const panel = document.createElement('div');
    panel.id = 'sg-panel';
    panel.innerHTML = `
      <div id="sg-header">
        <h3>📖 StudyGuide AI — v13</h3>
        <div id="sg-header-controls">
          <span id="sg-status-badge" class="badge-idle"><span class="badge-dot"></span>IDLE</span>
          <button type="button" class="sg-hbtn" id="sg-voice-btn" title="Toggle voice announcements">🔇</button>
          <button type="button" class="sg-hbtn" id="sg-toggle-btn">▼</button>
          <button type="button" class="sg-hbtn" id="sg-close-btn">✕</button>
        </div>
      </div>
      <div id="sg-body">

        <div id="sg-phase-nav" class="sg-phase-nav">
          <button type="button" class="sg-phase-jump-btn sg-phase-jump-btn-active" id="sg-jump-requirement" data-phase-target="sg-phase-requirement">📋 Requirement</button>
          <button type="button" class="sg-phase-jump-btn" id="sg-jump-studyguide" data-phase-target="sg-phase-studyguide">📖 Study guide</button>
          <button type="button" class="sg-phase-jump-btn" id="sg-jump-reference" data-phase-target="sg-phase-reference">🔒 Reference</button>
          <button type="button" class="sg-phase-jump-btn" id="sg-jump-workflow" data-phase-target="sg-phase-workflow">📋 Workflow</button>
          <button type="button" class="sg-phase-jump-btn" id="sg-jump-visual" data-phase-target="sg-phase-visual">🎨 Visual</button>
          <button type="button" class="sg-phase-jump-btn" id="sg-jump-domain-weights" data-phase-target="sg-phase-domain-weights">⚖ Domains</button>
          <button type="button" class="sg-phase-jump-btn" id="sg-jump-fr-mapping" data-phase-target="sg-phase-fr-mapping">📝 FR map</button>
          <button type="button" class="sg-phase-jump-btn" id="sg-jump-issue-log" data-phase-target="sg-phase-issue-log">🧪 Issue log</button>
          <button type="button" class="sg-phase-jump-btn" id="sg-jump-google-docs" data-phase-target="sg-phase-google-docs">🔗 Docs API</button>
        </div>
        <div class="sg-phase-nav-hint" style="font-size:10px;color:#94a3b8;text-align:center;margin:-4px 0 8px;line-height:1.35">
          ↑ Ek daba khule gi; <b>dobara wahi nav button</b> dabao tu band. Koi aur dabao tu woh khule gi.
        </div>

        <!-- PHASE 1 — Requirement -->
        <div class="sg-phase-block sg-phase-open" id="sg-phase-requirement">
          <button type="button" class="sg-phase-summary-btn" data-phase-collapse="sg-phase-requirement">
            <span>📋 REQUIREMENT PHASE</span><span class="sg-badge-required">REQ</span>
          </button>
          <div class="sg-phase-inner">
            <div class="sg-field">
              <label>Exam Name</label>
              <input type="text" id="sg-exam-name" placeholder="e.g. CompTIA Security+, USMLE Step 1, PMP..." />
            </div>
            <div class="sg-grid-2">
              <div class="sg-field">
                <label>Free Response (auto — Exam Verification)</label>
                <input type="text" id="sg-free-response-available" readonly />
              </div>
              <div class="sg-field">
                <label>Difficulty (auto — Exam Verification)</label>
                <input type="text" id="sg-exam-difficulty-level" readonly />
              </div>
            </div>
            <button type="button" class="sg-save-btn" id="sg-save-requirement-exam">💾 Save exam name</button>
            <div style="font-size:10px;color:#64748b;margin-top:6px;line-height:1.35">
              Same storage as Study Guide → “Save Exam Config” (pages/words/min-max bhi update ho jate hain). Free Response / Difficulty sirf Exam Verification / automation se bharte hain.
            </div>
          </div>
        </div>

        <!-- PHASE 2 — Study guide text -->
        <div class="sg-phase-block" id="sg-phase-studyguide">
          <button type="button" class="sg-phase-summary-btn" data-phase-collapse="sg-phase-studyguide">
            <span>📖 STUDYGUIDE PHASE</span><span class="sg-badge-required">TEXT</span>
          </button>
          <div class="sg-phase-inner">
            <div class="sg-grid-2">
              <div class="sg-field">
                <label>Total Pages</label>
                <input type="number" id="sg-total-pages" min="1" />
              </div>
              <div class="sg-field">
                <label>Words / Page</label>
                <input type="number" id="sg-words-page" min="100" />
              </div>
            </div>
            <div class="sg-grid-2">
              <div class="sg-field">
                <label>Minimum Paragraph Lines</label>
                <input type="number" id="sg-min-lines" min="1" />
              </div>
              <div class="sg-field">
                <label>Maximum Paragraph Lines</label>
                <input type="number" id="sg-max-lines" min="1" />
              </div>
            </div>
            <div class="sg-field">
              <label>Start From Page</label>
              <input type="number" id="sg-start-page" min="1" />
            </div>
            <div class="sg-field" style="margin-top:10px;padding-top:8px;border-top:1px solid #334155">
              <label>Planning question total (per domain)</label>
              <input type="number" id="sg-fr-planning-total" min="0" />
              <div style="font-size:10px;color:#64748b;margin-top:4px;line-height:1.35">
                Used only for sample-map → free-response ratio math. Objective MCQs are not generated in this script (use the standalone practice userscript if needed).
              </div>
            </div>
            <button type="button" class="sg-save-btn" id="sg-save-exam">💾 Save Exam Config</button>
          </div>
        </div>

        <!-- PHASE 3 — Reference enforcement (practice MCQ phase removed; FR runs after content in pipeline) -->
        <div class="sg-phase-block" id="sg-phase-reference">
          <button type="button" class="sg-phase-summary-btn" data-phase-collapse="sg-phase-reference">
            <span>🔒 REFERENCE ENFORCEMENT PHASE</span><span class="sg-badge-on">LOCK</span>
          </button>
          <div class="sg-phase-inner">
            <div style="font-size:11px;font-weight:700;color:#c084fc;margin-bottom:5px">
              v13 Enforced Rules
            </div>
            <ul class="sg-rules">
              ${V13_RULES.map(r => `<li>${escapeHtml(r)}</li>`).join('')}
            </ul>

            <div class="sg-toggle-row" style="margin-top:8px">
              <div class="sg-toggle-label">
                Reference reminder every N pages
                <span class="sg-toggle-sub">Re-sends strict content rules</span>
              </div>
            </div>
            <div class="sg-field">
              <label>Remind every (pages)</label>
              <input type="number" id="sg-remind-every" min="1" max="50" />
            </div>
            <div class="sg-toggle-row">
              <div class="sg-toggle-label">
                Validate response quality
                <span class="sg-toggle-sub">Reject + retry if response has forbidden patterns</span>
              </div>
              <div class="sg-toggle" id="tog-validateQuality"></div>
            </div>
            <div class="sg-toggle-row">
              <div class="sg-toggle-label">Strip source mentions before saving</div>
              <div class="sg-toggle" id="tog-stripSourceMentions"></div>
            </div>
            <div class="sg-field" style="font-size:11px;color:#94a3b8;padding:8px 0;border-bottom:1px solid #334155;margin-bottom:8px">
              <strong style="color:#e2e8f0">Missing reference handling</strong> — always enabled: generation pauses, shows upload popup, up to 3 retries, then stops if unresolved. Cannot be turned off.
            </div>
            <button type="button" class="sg-save-btn" id="sg-save-ref">💾 Save Reference Config</button>
          </div>
        </div>

        <!-- PHASE 4 — Workflow steps -->
        <div class="sg-phase-block" id="sg-phase-workflow">
          <button type="button" class="sg-phase-summary-btn" data-phase-collapse="sg-phase-workflow">
            <span>📋 WORKFLOW STEPS PHASE</span><span class="sg-badge-required">STEP</span>
          </button>
          <div class="sg-phase-inner">
            <div class="sg-step-card">
              <div class="sg-step-title">1️⃣ Upload Exam Outline</div>
              <div class="sg-step-sub">
                Click GPT + → upload outline → confirm here. UI auto-detects domains.
              </div>
              <div class="sg-step-actions">
                <button type="button" class="sg-step-btn primary" id="sg-open-outline">📎 Open GPT Upload</button>
                <button type="button" class="sg-step-btn" id="sg-confirm-outline">✓ Confirm Outline</button>
              </div>
            </div>

            <div class="sg-step-card">
              <div class="sg-step-title">2️⃣ Upload Sample / Past Papers (FR style)</div>
              <div class="sg-step-sub">
                When the orchestrator reaches the sample step: upload past papers or model answers in GPT, then confirm here (FR mapping auto-detect follows).
              </div>
              <div class="sg-step-actions">
                <button type="button" class="sg-step-btn primary" id="sg-open-samples-workflow">📎 Open GPT Upload</button>
                <button type="button" class="sg-step-btn" id="sg-confirm-samples-workflow">✓ Confirm Sample Papers</button>
              </div>
            </div>

            <div class="sg-step-card">
              <div class="sg-step-title">3️⃣ Upload Reference Books</div>
              <div class="sg-step-sub">
                Upload ALL reference PDFs to GPT, then confirm — after samples + FR mapping passes in the runner.
              </div>
              <div class="sg-step-actions">
                <button type="button" class="sg-step-btn primary" id="sg-open-books">📚 Open GPT Upload</button>
                <button type="button" class="sg-step-btn" id="sg-confirm-books">✓ Confirm Books</button>
              </div>
            </div>

          </div>
        </div>

        <!-- PHASE 5 — Visual / Gemini -->
        <div class="sg-phase-block" id="sg-phase-visual">
          <button type="button" class="sg-phase-summary-btn" data-phase-collapse="sg-phase-visual">
            <span>🎨 VISUAL CONTENT GENERATION PHASE</span><span class="sg-badge-on">GEMINI</span>
          </button>
          <div class="sg-phase-inner">
            <div class="sg-section-sub" style="margin-bottom:10px">
              🎨 <b>Gemini Image Generation:</b> For each figure, a <b>new Gemini tab</b> opens in the <b>background</b>;
              the script injects the prompt and captures the image — you do not need to open Gemini yourself.<br>
              🏷️ <b>Figure labels:</b> GPT assigns <b>Figure 1, Figure 2, …</b> in order; prompts require that label on the
              graphic so you can match each image to the right place in Google Docs.<br>
              ⏳ <b>Wait time:</b> typically 30–120s per image (see “Max wait” below).<br>
              📥 <b>Save method:</b> Images are posted to the Doc in order after each page’s text.
            </div>

            <div class="sg-toggle-row">
              <div class="sg-toggle-label">
                Enable Image Generation (Gemini)
                <span class="sg-toggle-sub">Requires ChatGPT Plus/Pro account</span>
              </div>
              <div class="sg-toggle" id="tog-enableGemini"></div>
            </div>
            <div class="sg-toggle-row">
              <div class="sg-toggle-label">
                Generate equations as images
                <span class="sg-toggle-sub">Math / Physics / Chemistry equations rendered visually</span>
              </div>
              <div class="sg-toggle" id="tog-equationsAsImages"></div>
            </div>
            <div class="sg-toggle-row">
              <div class="sg-toggle-label">
                Generate charts / graphs
                <span class="sg-toggle-sub">Data charts, supply-demand curves, bar graphs</span>
              </div>
              <div class="sg-toggle" id="tog-generateCharts"></div>
            </div>
            <div class="sg-toggle-row">
              <div class="sg-toggle-label">
                Generate diagrams / flowcharts
                <span class="sg-toggle-sub">Network diagrams, anatomy, process flows</span>
              </div>
              <div class="sg-toggle" id="tog-generateDiagrams"></div>
            </div>

            <div class="sg-field" style="margin-top:8px">
              <label>Max wait for Gemini (seconds)</label>
              <input type="number" id="sg-max-wait" min="10" max="600" />
            </div>
            <button type="button" class="sg-save-btn" id="sg-save-image">💾 Save Image Config</button>
          </div>
        </div>

        <!-- PHASE: Domain Weights -->
        <div class="sg-phase-block" id="sg-phase-domain-weights">
          <button type="button" class="sg-phase-summary-btn" data-phase-collapse="sg-phase-domain-weights">
            <span>⚖ Domain Weights</span><span class="sg-badge-on">AUTO-DETECT</span>
          </button>
          <div class="sg-phase-inner">
            <div class="sg-domain-hint">
              ⚡ Auto-Detect: Leave empty — after outline upload, UI auto-detects all domains + weights from GPT.
            </div>
            <div id="sg-domains-list"></div>
            <div class="sg-grid-2" style="gap:6px">
              <button type="button" class="sg-step-btn" id="sg-add-domain">➕ Add Domain</button>
              <button type="button" class="sg-step-btn primary" id="sg-detect-domains">🔍 Auto-Detect Now</button>
            </div>
            <div style="margin-top:6px;text-align:right;font-size:10px;color:#64748b" id="sg-weight-total">
              Total weight: 0%
            </div>
          </div>
        </div>

        <!-- PHASE: Free-response mapping (pipeline detect + per-domain merge) -->
        <div class="sg-phase-block" id="sg-phase-fr-mapping">
          <button type="button" class="sg-phase-summary-btn" data-phase-collapse="sg-phase-fr-mapping">
            <span>📝 FREE-RESPONSE MAPPING</span><span class="sg-badge-on">FR</span>
          </button>
          <div class="sg-phase-inner">
            <div class="sg-section-sub" style="margin-bottom:8px;line-height:1.35">
              <b>First pass:</b> pipeline step <code>sample_mapping</code> runs GPT FR-style auto-detect from uploads (exam-wide). <b>Second pass:</b> each domain FR profile merges on top — non‑empty overlays update the merged row. Editing here saves only the merged snapshot (legacy <code>statementsLength</code> / <code>optionsCount</code> are synced for generators that still read them).
            </div>
            <div id="sg-fr-mapping-status" style="font-size:11px;color:#94a3b8;margin-bottom:8px"></div>
            <div id="sg-sample-mapping-list"></div>
            <div id="sg-fr-text-wrap" style="display:flex;flex-direction:column;gap:6px;margin-top:8px">
              <div class="sg-field" style="margin:0"><label style="font-size:11px">Basis / grounding</label><textarea id="sg-fr-basis" rows="2" style="width:100%;box-sizing:border-box;font-size:11px;line-height:1.35;background:#020617;color:#e2e8f0;border:1px solid #334155;border-radius:6px;padding:6px;resize:vertical"></textarea></div>
              <div class="sg-field" style="margin:0"><label style="font-size:11px">Stem framing notes</label><textarea id="sg-fr-stem" rows="2" style="width:100%;box-sizing:border-box;font-size:11px;line-height:1.35;background:#020617;color:#e2e8f0;border:1px solid #334155;border-radius:6px;padding:6px;resize:vertical"></textarea></div>
              <div class="sg-field" style="margin:0"><label style="font-size:11px">Marking / rubric hints</label><textarea id="sg-fr-mark" rows="2" style="width:100%;box-sizing:border-box;font-size:11px;line-height:1.35;background:#020617;color:#e2e8f0;border:1px solid #334155;border-radius:6px;padding:6px;resize:vertical"></textarea></div>
              <div class="sg-field" style="margin:0"><label style="font-size:11px">Typical lengths (compact line)</label><textarea id="sg-fr-typical" rows="2" placeholder="short: … | medium: …" style="width:100%;box-sizing:border-box;font-size:11px;line-height:1.35;background:#020617;color:#e2e8f0;border:1px solid #334155;border-radius:6px;padding:6px;resize:vertical"></textarea></div>
              <div class="sg-field" style="margin:0"><label style="font-size:11px">Format rules — one per line</label><textarea id="sg-fr-format" rows="3" style="width:100%;box-sizing:border-box;font-size:11px;line-height:1.35;background:#020617;color:#e2e8f0;border:1px solid #334155;border-radius:6px;padding:6px;resize:vertical"></textarea></div>
              <div class="sg-field" style="margin:0"><label style="font-size:11px">Concept rules — one per line</label><textarea id="sg-fr-concept" rows="3" style="width:100%;box-sizing:border-box;font-size:11px;line-height:1.35;background:#020617;color:#e2e8f0;border:1px solid #334155;border-radius:6px;padding:6px;resize:vertical"></textarea></div>
              <div class="sg-field" style="margin:0"><label style="font-size:11px">Answer components — one per line</label><textarea id="sg-fr-response" rows="3" style="width:100%;box-sizing:border-box;font-size:11px;line-height:1.35;background:#020617;color:#e2e8f0;border:1px solid #334155;border-radius:6px;padding:6px;resize:vertical"></textarea></div>
            </div>
            <div class="sg-grid-3" style="gap:6px;margin-top:10px">
              <button type="button" class="sg-save-btn" id="sg-fr-mapping-save">💾 Save FR mapping</button>
              <button type="button" class="sg-save-btn" id="sg-fr-mapping-reset" style="background:linear-gradient(135deg,#7f1d1d,#991b1b)">↺ Reset FR mapping</button>
              <button type="button" class="sg-step-btn primary" id="sg-fr-mapping-autodetect">🔍 Pipeline auto‑detect</button>
            </div>
          </div>
        </div>

        <!-- PHASE: Developer issue log -->
        <div class="sg-phase-block" id="sg-phase-issue-log">
          <button type="button" class="sg-phase-summary-btn" data-phase-collapse="sg-phase-issue-log">
            <span>🧪 Developer issue log</span><span class="sg-badge-on">DEV</span>
          </button>
          <div class="sg-phase-inner">
            <div class="sg-section-sub" style="margin-bottom:6px">Persistent structured events (warnings, errors, key phases). Download JSON for testing — survives refresh until Reset or Clear.</div>
            <textarea id="sg-issue-log" readonly spellcheck="false" style="width:100%;min-height:130px;font-size:10px;line-height:1.35;font-family:Consolas,monospace;background:#020617;color:#cbd5e1;border:1px solid #334155;border-radius:6px;padding:8px;resize:vertical;box-sizing:border-box"></textarea>
            <div class="sg-grid-3" style="gap:6px;margin-top:8px">
              <button type="button" class="sg-save-btn" id="sg-issue-log-refresh" style="margin-top:0">↻ Refresh</button>
              <button type="button" class="sg-save-btn" id="sg-issue-log-download" style="margin-top:0;background:linear-gradient(135deg,#334155,#475569)">⬇ Download JSON</button>
              <button type="button" class="sg-save-btn" id="sg-issue-log-clear" style="margin-top:0;background:linear-gradient(135deg,#7f1d1d,#991b1b)">🗑 Clear log</button>
            </div>
          </div>
        </div>

        <!-- PHASE: Google Docs Connection -->
        <div class="sg-phase-block" id="sg-phase-google-docs">
          <button type="button" class="sg-phase-summary-btn" data-phase-collapse="sg-phase-google-docs">
            <span>🔗 Google Docs Connection</span><span class="sg-badge-required">DOC</span>
          </button>
          <div class="sg-phase-inner">
            <div class="sg-field">
              <label>Apps Script Web URL</label>
              <input type="text" id="sg-apps-script-url" placeholder="https://script.google.com/macros/s/.../exec" />
            </div>
            <div class="sg-field">
              <label>Google Doc ID</label>
              <input type="text" id="sg-doc-id" placeholder="Doc ID (from URL)" />
            </div>
            <div class="sg-field">
              <label>Secret Key</label>
              <input type="password" id="sg-secret-key" placeholder="same as Apps Script secret..." />
            </div>
            <div class="sg-grid-2" style="gap:6px">
              <button type="button" class="sg-save-btn" id="sg-save-docs" style="margin-top:0">💾 Save Docs Config</button>
              <button type="button" class="sg-save-btn" id="sg-test-conn" style="margin-top:0;background:linear-gradient(135deg,#0891b2,#0e7490)">🧪 Test Connection</button>
            </div>
            <div id="sg-conn-result" style="display:none;margin-top:7px;padding:6px 10px;border-radius:6px;font-size:11px;font-family:monospace"></div>
          </div>
        </div>

        <!-- 6. AUTO GENERATE -->
        <div class="sg-section">
          <div id="sg-step-notify">
            <span class="sg-notify-title">🔔 Action Required</span>
            <span id="sg-step-notify-msg">Waiting...</span>
            <button type="button" class="sg-step-btn primary" id="sg-resume-context-ok" style="display:none;margin-top:8px;width:100%;box-sizing:border-box;">✓ ChatGPT context ready — continue resume</button>
            <button type="button" class="sg-step-btn primary" id="sg-frq-sample-confirm" style="display:none;margin-top:6px;width:100%;box-sizing:border-box;background:linear-gradient(135deg,#7c3aed,#2563eb)">✓ FR sample papers uploaded — continue</button>
          </div>
          <button type="button" id="sg-auto-generate">
            ⚡ Auto Generate — Text + Images
            <span class="sg-subline">
              v13: Text pages + Gemini images + equations + charts generated automatically.
              Images detected from DOM and saved to Google Docs.
            </span>
          </button>
        </div>

        <!-- 7. GENERATION PROGRESS -->
        <div class="sg-section">
          <div class="sg-section-title">
            <span>📊 Generation Progress</span>
            <span id="sg-page-counter" style="color:#7dd3fc;font-weight:700">0 / 0 pages</span>
          </div>
          <div class="sg-lane-wrap" id="sg-generation-lanes">
            <div class="sg-lane-chip" id="sg-lane-studyguide"><span class="sg-lane-dot"></span>Study Guide Generation</div>
            <div class="sg-lane-chip" id="sg-lane-free-response"><span class="sg-lane-dot"></span>Free Response Question Generation</div>
          </div>
          <div id="sg-progress-pct">0%</div>
          <div id="sg-progress-wrap"><div id="sg-progress-bar"></div></div>
          <div id="sg-progress-text">Waiting to start...</div>

          <div class="sg-progress-stats">
            <div class="sg-stat ok"><span class="sg-stat-val" id="sg-stat-done">0</span><span class="sg-stat-lbl">done</span></div>
            <div class="sg-stat fail"><span class="sg-stat-val" id="sg-stat-failed">0</span><span class="sg-stat-lbl">failed</span></div>
            <div class="sg-stat retry"><span class="sg-stat-val" id="sg-stat-retries">0</span><span class="sg-stat-lbl">retries</span></div>
            <div class="sg-stat word"><span class="sg-stat-val" id="sg-stat-words">0</span><span class="sg-stat-lbl">words</span></div>
            <div class="sg-stat skip"><span class="sg-stat-val" id="sg-stat-skipped">⏭ 0</span><span class="sg-stat-lbl">skipped</span></div>
            <div class="sg-stat img"><span class="sg-stat-val" id="sg-stat-images">🖼 0</span><span class="sg-stat-lbl">images</span></div>
          </div>

          <div style="margin-top:10px;font-size:10.5px;color:#94a3b8;font-weight:700">Recent Pages</div>
          <div id="sg-recent-pages"><div style="color:#475569">No pages generated yet.</div></div>
        </div>

        <!-- 8. CONTROLS -->
        <div class="sg-section">
          <div class="sg-section-title"><span>🎯 Controls</span></div>
          <div class="sg-controls">
            <button type="button" class="sg-btn sg-btn-verify" id="sg-btn-verify" style="grid-column:span 3">📋 Start Exam Verification</button>
            <button type="button" class="sg-btn sg-btn-start"  id="sg-btn-start">▶ Start Generation</button>
            <button type="button" class="sg-btn sg-btn-pause"  id="sg-btn-pause"  disabled>⏸ Pause</button>
            <button type="button" class="sg-btn sg-btn-resume" id="sg-btn-resume" disabled>▶ Resume</button>
            <button type="button" class="sg-btn sg-btn-retry"  id="sg-btn-retry"  disabled>↺ Retry Page</button>
            <button type="button" class="sg-btn sg-btn-skip"   id="sg-btn-skip"   disabled>⏭ Skip Page</button>
            <button type="button" class="sg-btn sg-btn-stop"   id="sg-btn-stop"   disabled>⏹ Stop</button>
            <button type="button" class="sg-btn sg-btn-reset"  id="sg-btn-reset">🗑 Reset Everything</button>
          </div>
        </div>

        <!-- 9. LIVE CONSOLE -->
        <div class="sg-section">
          <div class="sg-section-title">
            <span>💻 Live Console</span>
            <button type="button" class="sg-hbtn" id="sg-clear-console">🗑</button>
          </div>
          <div id="sg-console"></div>
        </div>

      </div>

    `;

    document.body.appendChild(panel);

    // Overlays MUST be siblings of the panel (not inside it) so they render
    // as real full-screen modals and aren't clipped by the panel's overflow.
    buildOverlays();

    // Tiny floating button that reopens the panel after the user closes it.
    buildRestoreButton();

    applyConfigsToUI();
    updateVoiceToggleUI();
    try {
      if (window.speechSynthesis && typeof window.speechSynthesis.onvoiceschanged !== 'undefined') {
        window.speechSynthesis.onvoiceschanged = () => { try { updateVoiceToggleUI(); } catch (_) {} };
      }
    } catch (_) {}
    renderDomains();
    renderSampleMapping();
    updateProgressUI();
    bindEvents();
    try { openStudyGuidePhaseAccordion('sg-phase-requirement'); } catch (_) {}
    try { refreshIssueLogUI(); } catch (_) {}
    loadCheckpointStateFromStorage();
    setUIState(STATE.IDLE);
    const boot = formatCheckpointForLog();
    if (boot) {
      log(`💾 Previous run in storage — ${boot} — use Resume to continue, or Reset to clear.`, 'sys');
    }
  }

  function buildOverlays() {
    // Missing-reference popup
    if (!document.getElementById('sg-popup-overlay')) {
      const o = document.createElement('div');
      o.id = 'sg-popup-overlay';
      o.innerHTML = `
        <div id="sg-popup">
          <h3 id="sg-popup-title">⚠ Missing Reference</h3>
          <p id="sg-popup-body">GPT could not find the referenced content. Upload the missing reference or skip this page.</p>
          <div class="sg-popup-btns">
            <button type="button" class="sg-step-btn primary" id="sg-popup-upload">📎 Upload Reference</button>
            <button type="button" class="sg-step-btn" id="sg-popup-skip">⏭ Skip Page</button>
          </div>
        </div>`;
      document.body.appendChild(o);
    }
    // Missing-book popup
    if (!document.getElementById('sg-book-popup-overlay')) {
      const o2 = document.createElement('div');
      o2.id = 'sg-book-popup-overlay';
      // No dark fullscreen layer — ChatGPT stays fully clickable. Panel is draggable.
      o2.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483646;display:none;';
      o2.innerHTML = `
        <div id="sg-book-popup-panel" style="pointer-events:auto;position:fixed;right:18px;top:90px;width:min(430px,94vw);max-height:min(82vh,640px);overflow:auto;background:#0b1220;border:1px solid #f59e0b;border-radius:12px;box-shadow:0 25px 60px rgba(0,0,0,0.8);color:#e2e8f0">
          <div id="sg-book-popup-drag" style="cursor:grab;padding:10px 14px;background:linear-gradient(90deg,#1e293b,#0f172a);border-radius:12px 12px 0 0;border-bottom:1px solid #334155;user-select:none">
            <div style="color:#fbbf24;font-size:14px;font-weight:700">⚠ New book / reference needed</div>
            <div style="color:#94a3b8;font-size:10px;margin-top:2px">Drag this bar to move. You can use ChatGPT behind this card.</div>
          </div>
          <div style="padding:14px 16px 16px">
            <p id="sg-book-popup-body" style="font-size:12px;color:#cbd5e1;line-height:1.5;margin:0 0 8px 0">GPT needs another reference. Upload a PDF in ChatGPT, then press Confirm to re-verify.</p>
            <p id="sg-book-popup-hint" style="font-size:11px;color:#94a3b8;margin:0 0 12px 0">Confirm runs the <b>“new book + coverage”</b> check so generation can continue only when the reference is available.</p>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
              <button type="button" class="sg-step-btn primary" id="sg-book-popup-add">📎 Add New Book</button>
              <button type="button" class="sg-step-btn" id="sg-book-popup-confirm">✓ Confirm (verify ref)</button>
            </div>
          </div>
        </div>`;
      document.body.appendChild(o2);
      initBookPopupDrag();
    }
  }

  function initBookPopupDrag() {
    const panel = document.getElementById('sg-book-popup-panel');
    const handle = document.getElementById('sg-book-popup-drag');
    if (!panel || !handle || panel.dataset.sgDragWired) return;
    panel.dataset.sgDragWired = '1';
    let down = false, sx = 0, sy = 0, sl = 0, st = 0;
    handle.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      down = true;
      const r = panel.getBoundingClientRect();
      sx = e.clientX;
      sy = e.clientY;
      sl = r.left;
      st = r.top;
      panel.style.left = r.left + 'px';
      panel.style.top = r.top + 'px';
      panel.style.right = 'auto';
      handle.style.cursor = 'grabbing';
      e.preventDefault();
    });
    const move = (e) => {
      if (!down) return;
      panel.style.left = `${sl + (e.clientX - sx)}px`;
      panel.style.top = `${st + (e.clientY - sy)}px`;
    };
    const up = () => {
      if (!down) return;
      down = false;
      handle.style.cursor = 'grab';
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  }

  function buildRestoreButton() {
    if (document.getElementById('sg-restore-btn')) return;
    const b = document.createElement('button');
    b.id = 'sg-restore-btn';
    b.textContent = '📖';
    b.title = 'Re-open StudyGuide panel';
    b.style.cssText = `
      position:fixed;top:16px;right:16px;width:44px;height:44px;border-radius:50%;
      border:none;background:linear-gradient(135deg,#2563eb,#7c3aed);color:#fff;font-size:20px;
      box-shadow:0 8px 24px rgba(0,0,0,0.5);cursor:pointer;z-index:2147483645;display:none;
    `;
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      const p = document.getElementById('sg-panel');
      if (p) { p.classList.remove('sg-hide', 'collapsed'); p.style.display = ''; }
      b.style.display = 'none';
    });
    document.body.appendChild(b);
  }

  function closePanel() {
    const p = document.getElementById('sg-panel');
    if (p) p.classList.add('sg-hide');
    const r = document.getElementById('sg-restore-btn');
    if (r) r.style.display = 'block';
  }

  // ─────────────────────────────────────────────────────────────
  //  LOAD / APPLY CONFIG
  // ─────────────────────────────────────────────────────────────
  /**
   * @param {object} [options]
   * @param {boolean} [options.includeDocs=true]  If false, do not touch Apps URL / Doc ID / Secret
   *  fields — avoids wiping unsaved text when `loadCheckpointStateFromStorage` runs (e.g. on Start).
   */
  function applyConfigsToUI(options) {
    const includeDocs = !options || options.includeDocs !== false;
    // Exam
    $('#sg-free-response-available').value = examConfig.freeResponseAvailable ? 'true' : 'false';
    $('#sg-exam-difficulty-level').value = formatDifficultyUiLabel(examConfig.difficultyLevel || 'academic_college_level');
    $('#sg-exam-name').value    = examConfig.examName || '';
    $('#sg-total-pages').value  = examConfig.totalPages;
    $('#sg-words-page').value   = examConfig.wordsPerPage;
    $('#sg-start-page').value   = examConfig.startFromPage;
    $('#sg-min-lines').value    = examConfig.minLinesPerPara;
    $('#sg-max-lines').value    = examConfig.maxLinesPerPara;

    // Image toggles
    setToggle('tog-enableGemini',          imageConfig.enableGemini);
    setToggle('tog-equationsAsImages',     imageConfig.equationsAsImages);
    setToggle('tog-generateCharts',        imageConfig.generateCharts);
    setToggle('tog-generateDiagrams',      imageConfig.generateDiagrams);
    $('#sg-max-wait').value = imageConfig.maxWaitGeminiSec;

    const ftp = $('#sg-fr-planning-total');
    if (ftp) ftp.value = practiceConfig.totalQuestions;

    // Reference
    $('#sg-remind-every').value = refConfig.reminderEveryPages;
    setToggle('tog-validateQuality',     refConfig.validateQuality);
    setToggle('tog-stripSourceMentions', refConfig.stripSourceMentions);

    // Docs (only full panel init / after Save / after Reset — not on checkpoint reload)
    if (includeDocs) {
      $('#sg-apps-script-url').value = GM_getValue(STORAGE_KEYS.APPS_SCRIPT_URL, '');
      $('#sg-doc-id').value          = GM_getValue(STORAGE_KEYS.DOC_ID, '');
      const sk = $('#sg-secret-key');
      if (sk) sk.value = GM_getValue(STORAGE_KEYS.SECRET_KEY, '');
    }

    // Workflow
    applyWorkflowUI();
  }

  function applyWorkflowUI() {
    const b1 = $('#sg-confirm-outline');
    const b2 = $('#sg-confirm-books');
    const bS = $('#sg-confirm-samples-workflow');
    if (b1) b1.classList.toggle('confirmed', workflow.outlineUploaded);
    if (bS) bS.classList.toggle('confirmed', workflow.samplesUploaded);
    if (b2) b2.classList.toggle('confirmed', workflow.booksUploaded);
    if (b1) b1.textContent = workflow.outlineUploaded ? '✔ Outline Confirmed' : '✓ Confirm Outline';
    if (bS) bS.textContent = workflow.samplesUploaded ? '✔ Sample Papers Confirmed' : '✓ Confirm Sample Papers';
    if (b2) b2.textContent = workflow.booksUploaded   ? '✔ Books Confirmed'   : '✓ Confirm Books';
  }

  function setToggle(id, on) {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.toggle('on', !!on);
  }

  // Apply visual_needs returned by Start Exam Verification to the UI toggles
  // + mutate the in-memory imageConfig + persist it. This is what keeps image
  // generation ready throughout the pipeline.
  function applyVisualNeedsToUI(vn) {
    if (!vn || typeof vn !== 'object') return;

    const need = (k) => !!vn[k];

    const map = [
      // GPT field             → imageConfig field           → toggle id
      ['images_required',       'enableGemini',               'tog-enableGemini'],
      ['equations_required',    'equationsAsImages',          'tog-equationsAsImages'],
      ['charts_required',       'generateCharts',             'tog-generateCharts'],
      ['diagrams_required',     'generateDiagrams',           'tog-generateDiagrams'],
    ];

    // Never down-toggle images if they're already on — only raise.
    map.forEach(([gptKey, cfgKey, togId]) => {
      const v = need(gptKey);
      if (v) {
        imageConfig[cfgKey] = true;
      }
      setToggle(togId, !!imageConfig[cfgKey]);
    });

    // If the exam genuinely needs no images at all, respect GPT — but the
    // master toggle (enableGemini) is always kept ON unless the user later
    // disables it manually. We never auto-turn it OFF here.
    saveObj(STORAGE_KEYS.IMAGE_CONFIG, imageConfig);

    // Log a crisp summary
    const parts = [];
    if (vn.images_required)     parts.push('images');
    if (vn.equations_required)  parts.push('equations');
    if (vn.charts_required)     parts.push('charts');
    if (vn.diagrams_required)   parts.push('diagrams');
    if (vn.reactions_required)  parts.push('reactions');
    if (vn.code_required)       parts.push('code');
    if (vn.tables_required)     parts.push('tables');
    if (vn.case_studies)        parts.push('case-studies');
    log(`🎨 Visual needs applied: ${parts.join(', ') || '(none)'}, frequency: ${vn.image_frequency || 'smart'}`, 'img');
  }

  // ─────────────────────────────────────────────────────────────
  //  DOMAIN RENDER
  // ─────────────────────────────────────────────────────────────
  function renderDomains() {
    const list = $('#sg-domains-list');
    if (!list) return;
    if (!domains.length) {
      list.innerHTML = `<div style="font-size:11px;color:#64748b;font-style:italic">
        No domains yet. Click "Auto-Detect Now" after uploading the outline, or add manually.
      </div>`;
    } else {
      list.innerHTML = domains.map((d, i) => `
        <div class="sg-domain-row">
          <input type="text" placeholder="Domain name" value="${escapeAttr(d.name || '')}" data-idx="${i}" data-field="name" />
          <input type="number" placeholder="%" min="0" max="100" value="${d.weight ?? ''}" data-idx="${i}" data-field="weight" />
          <button type="button" class="sg-domain-del" data-idx="${i}" title="Remove">🗑</button>
        </div>
      `).join('');

      list.querySelectorAll('input').forEach(inp => {
        inp.addEventListener('input', (e) => {
          const idx = +e.target.dataset.idx;
          const field = e.target.dataset.field;
          if (field === 'weight') {
            domains[idx][field] = parseFloat(e.target.value) || 0;
          } else {
            domains[idx][field] = e.target.value;
          }
          saveObj(STORAGE_KEYS.DOMAINS, domains);
          updateWeightTotal();
        });
      });

      list.querySelectorAll('.sg-domain-del').forEach(btn => {
        btn.addEventListener('click', (e) => {
          const idx = +e.target.dataset.idx;
          domains.splice(idx, 1);
          saveObj(STORAGE_KEYS.DOMAINS, domains);
          renderDomains();
          updateWeightTotal();
        });
      });
    }
    updateWeightTotal();
  }

  function updateWeightTotal() {
    const total = domains.reduce((s, d) => s + (parseFloat(d.weight) || 0), 0);
    const el = $('#sg-weight-total');
    if (!el) return;
    el.textContent = `Total weight: ${total.toFixed(1)}%`;
    el.style.color = (Math.abs(total - 100) < 0.5) ? '#4ade80'
                   : (total > 100 ? '#f87171' : '#fbbf24');
  }

  // ─────────────────────────────────────────────────────────────
  //  FREE-RESPONSE MAPPING (pipeline + merged UI)
  // ─────────────────────────────────────────────────────────────
  function mergeDistinctStringLists(baseArr, overlayArr) {
    const seen = new Set();
    const out = [];
    function pushOne(s) {
      const t = String(s || '').trim();
      if (!t) return;
      const k = t.toLowerCase();
      if (seen.has(k)) return;
      seen.add(k);
      out.push(t);
    }
    (Array.isArray(baseArr) ? baseArr : []).forEach(pushOne);
    (Array.isArray(overlayArr) ? overlayArr : []).forEach(pushOne);
    return out;
  }

  function normalizeFrCategories(arr) {
    const out = [];
    if (!Array.isArray(arr)) return out;
    arr.forEach((raw) => {
      if (!raw || typeof raw !== 'object') return;
      const name = String(raw.name || '').trim();
      if (!name) return;
      const w = Math.max(0, Math.min(100, parseFloat(raw.weight_percent) || 0));
      const description = String(raw.description || '').trim();
      out.push({ name, weight_percent: w, description });
    });
    return out;
  }

  function mergeFrCategoryLists(baseArr, overlayArr) {
    const map = new Map();
    normalizeFrCategories(baseArr).forEach((c) => map.set(c.name.toLowerCase(), { ...c }));
    normalizeFrCategories(overlayArr).forEach((c) => {
      const prev = map.get(c.name.toLowerCase()) || { name: c.name };
      map.set(c.name.toLowerCase(), { ...prev, ...c, name: c.name || prev.name });
    });
    return Array.from(map.values());
  }

  function compactTypicalLengthsFromObj(tl) {
    if (!tl || typeof tl !== 'object') return '';
    return ['short', 'medium', 'long']
      .map((k) => (tl[k] != null && String(tl[k]).trim() !== '' ? `${k}: ${String(tl[k]).trim()}` : ''))
      .filter(Boolean)
      .join(' | ');
  }

  function pctFromFlexible(v) {
    let x = parseFloat(v);
    if (isNaN(x)) return null;
    if (x > 0 && x <= 1) x *= 100;
    return Math.max(0, Math.min(100, Math.round(x)));
  }

  /** Normalise GPT JSON from pipeline FR-mapping pass → flat merged keys. */
  function normalizePipelineFrGPT(data) {
    if (!data || typeof data !== 'object') data = {};
    const o = {};

    function iw(field) {
      const n = parseInt(field, 10);
      if (!isNaN(n) && n > 0) return n;
      return 0;
    }
    const st = iw(data.fr_statement_words);
    const ow = iw(data.fr_option_words);
    const rw = iw(data.fr_roman_point_words);
    const oc = iw(data.fr_options_count);
    if (st > 0) o.fr_statement_words = st;
    if (ow > 0) o.fr_option_words = ow;
    if (rw > 0) o.fr_roman_point_words = rw;
    if (oc > 0) o.fr_options_count = oc;

    const tq = parseInt(data.sample_total_questions_estimate, 10);
    const fq = parseInt(data.sample_fr_questions_estimate, 10);
    if (!isNaN(tq) && tq > 0) o.est_sample_total_questions = tq;
    if (!isNaN(fq) && fq > 0) o.est_sample_fr_questions = fq;
    const p = pctFromFlexible(data.free_response_percentage_estimate);
    if (p != null && !isNaN(p)) o.est_fr_share_percent = p;

    ['basis_for_questions', 'stem_structure_notes', 'marking_rubric_hints'].forEach((k) => {
      const s = String(data[k] || '').trim();
      if (s) o[k] = s;
    });
    const compact = compactTypicalLengthsFromObj(data.typical_lengths_words);
    if (compact) o.typical_lengths_compact = compact;

    if (Array.isArray(data.response_components)) {
      o.response_components = data.response_components.map((x) => String(x || '').trim()).filter(Boolean);
    }
    if (Array.isArray(data.format_rules)) {
      o.format_rules = data.format_rules.map((x) => String(x || '').trim()).filter(Boolean);
    }
    if (Array.isArray(data.concept_rules)) {
      o.concept_rules = data.concept_rules.map((x) => String(x || '').trim()).filter(Boolean);
    }
    const cats = normalizeFrCategories(data.free_response_categories);
    if (cats.length) o.free_response_categories = cats;
    return o;
  }

  function cloneFrMerged(src) {
    try {
      return JSON.parse(JSON.stringify(src && typeof src === 'object' ? src : {}));
    } catch (_) {
      return {};
    }
  }

  /** Overlay updates base: second pass (domain) refines merged store. */
  function mergeFrMappingLayers(baseIn, overlayIn) {
    const a = cloneFrMerged(baseIn);
    const o = overlayIn && typeof overlayIn === 'object' ? overlayIn : {};

    FR_MAPPING_PANEL_NUMERIC_ROWS.forEach(({ key }) => {
      if (!Object.prototype.hasOwnProperty.call(o, key)) return;
      const raw = parseFloat(o[key]);
      if (key === 'est_fr_share_percent') {
        if (!isNaN(raw)) a[key] = Math.max(0, Math.min(100, Math.round(raw)));
      } else if (!isNaN(raw) && raw > 0) {
        a[key] = Math.round(raw);
      }
    });
    ['est_sample_total_questions', 'est_sample_fr_questions'].forEach((k) => {
      if (!Object.prototype.hasOwnProperty.call(o, k)) return;
      const raw = parseInt(o[k], 10);
      if (!isNaN(raw) && raw >= 0) a[k] = raw;
    });

    ['basis_for_questions', 'stem_structure_notes', 'marking_rubric_hints', 'typical_lengths_compact'].forEach((k) => {
      const s = String(o[k] || '').trim();
      if (s) a[k] = s;
    });
    if (Array.isArray(o.response_components)) {
      a.response_components = mergeDistinctStringLists(a.response_components, o.response_components);
    }
    if (Array.isArray(o.format_rules)) {
      a.format_rules = mergeDistinctStringLists(a.format_rules, o.format_rules);
    }
    if (Array.isArray(o.concept_rules)) {
      a.concept_rules = mergeDistinctStringLists(a.concept_rules, o.concept_rules);
    }
    if (Array.isArray(o.free_response_categories)) {
      a.free_response_categories = mergeFrCategoryLists(a.free_response_categories, o.free_response_categories);
    }
    return a;
  }

  function syncMergedFrMappingToLegacySampleFields(m) {
    if (!sampleMapping || !m) return;
    const stmt = parseInt(m.fr_statement_words, 10);
    if (!isNaN(stmt) && stmt > 0) {
      if (!sampleMapping.statementsLength) sampleMapping.statementsLength = { weight: 0, detected: '' };
      sampleMapping.statementsLength.detected = stmt;
      sampleMapping.statementsLength.weight = stmt;
    }
    const optc = parseInt(m.fr_options_count, 10);
    if (!isNaN(optc) && optc > 0) {
      if (!sampleMapping.optionsCount) sampleMapping.optionsCount = { weight: 0, detected: '' };
      sampleMapping.optionsCount.detected = optc;
      sampleMapping.optionsCount.weight = optc;
    }
  }

  function persistFreeResponseMappingState() {
    if (!freeResponseMapping || typeof freeResponseMapping !== 'object') return;
    if (!freeResponseMapping.pipeline || typeof freeResponseMapping.pipeline !== 'object') {
      freeResponseMapping.pipeline = {};
    }
    if (!freeResponseMapping.merged || typeof freeResponseMapping.merged !== 'object') {
      freeResponseMapping.merged = {};
    }
    syncMergedFrMappingToLegacySampleFields(freeResponseMapping.merged);
    saveObj(STORAGE_KEYS.FREE_RESPONSE_MAPPING, freeResponseMapping);
    saveObj(STORAGE_KEYS.SAMPLE_MAPPING, sampleMapping);
    persistMappingSnapshot('sample_mapping');
  }

  function captureFrMappingInputsToMerged() {
    if (!freeResponseMapping || typeof freeResponseMapping !== 'object') freeResponseMapping = defaultFreeResponseMappingState();
    if (!freeResponseMapping.merged || typeof freeResponseMapping.merged !== 'object') freeResponseMapping.merged = {};

    FR_MAPPING_PANEL_NUMERIC_ROWS.forEach(({ key }) => {
      const sel = `#sg-sample-mapping-list input[data-fr-key="${key}"]`;
      const el = typeof document !== 'undefined' ? document.querySelector(sel) : null;
      if (!el) return;
      const v = parseFloat(el.value);
      if (key === 'est_fr_share_percent') {
        if (!isNaN(v)) freeResponseMapping.merged[key] = Math.max(0, Math.min(100, Math.round(v)));
        else delete freeResponseMapping.merged[key];
      } else if (!isNaN(v) && v > 0) {
        freeResponseMapping.merged[key] = Math.round(v);
      } else {
        delete freeResponseMapping.merged[key];
      }
    });

    function setTa(id, mk, lines) {
      const node = $(id);
      if (!node) return;
      const raw = String(node.value || '').trim();
      if (!raw) delete freeResponseMapping.merged[mk];
      else if (lines) freeResponseMapping.merged[mk] = raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      else freeResponseMapping.merged[mk] = raw;
    }
    setTa('#sg-fr-basis', 'basis_for_questions');
    setTa('#sg-fr-stem', 'stem_structure_notes');
    setTa('#sg-fr-mark', 'marking_rubric_hints');
    setTa('#sg-fr-typical', 'typical_lengths_compact');
    setTa('#sg-fr-format', 'format_rules', true);
    setTa('#sg-fr-concept', 'concept_rules', true);
    setTa('#sg-fr-response', 'response_components', true);
  }

  function renderSampleMapping() {
    const list = $('#sg-sample-mapping-list');
    if (!list) return;

    list.innerHTML = FR_MAPPING_PANEL_NUMERIC_ROWS.map((row) => {
      const merged = freeResponseMapping.merged || {};
      const pv = merged[row.key];
      const disp = pv != null && pv !== '' && !isNaN(parseFloat(pv)) ? String(pv) : '';
      return `
        <div class="sg-sm-row" data-fr-key="${row.key}">
          <div class="sg-sm-label">${escapeHtml(row.label)}${row.hint ? `<small>${escapeHtml(row.hint)}</small>` : ''}</div>
          <input type="number" step="1" min="0" data-fr-key="${row.key}"
                 placeholder="—" value="${escapeHtml(disp)}" />
        </div>`;
    }).join('');

    list.querySelectorAll('input[data-fr-key]').forEach((inp) => {
      inp.addEventListener('input', () => {
        captureFrMappingInputsToMerged();
        persistFreeResponseMappingState();
        refreshFrMappingStatus();
      });
    });

    const m = freeResponseMapping.merged || {};
    const basis = $('#sg-fr-basis'); if (basis) basis.value = String(m.basis_for_questions || '');
    const stem = $('#sg-fr-stem'); if (stem) stem.value = String(m.stem_structure_notes || '');
    const mark = $('#sg-fr-mark'); if (mark) mark.value = String(m.marking_rubric_hints || '');
    const typ = $('#sg-fr-typical'); if (typ) typ.value = String(m.typical_lengths_compact || '');
    const fmt = $('#sg-fr-format'); if (fmt) fmt.value = Array.isArray(m.format_rules) ? m.format_rules.join('\n') : '';
    const cpt = $('#sg-fr-concept'); if (cpt) cpt.value = Array.isArray(m.concept_rules) ? m.concept_rules.join('\n') : '';
    const rsp = $('#sg-fr-response'); if (rsp) rsp.value = Array.isArray(m.response_components) ? m.response_components.join('\n') : '';

    ['#sg-fr-basis', '#sg-fr-stem', '#sg-fr-mark', '#sg-fr-typical', '#sg-fr-format', '#sg-fr-concept', '#sg-fr-response'].forEach((sel) => {
      const el = $(sel);
      if (!el || el.dataset.sgFrTextBound === '1') return;
      el.dataset.sgFrTextBound = '1';
      el.addEventListener('input', () => {
        captureFrMappingInputsToMerged();
        persistFreeResponseMappingState();
        refreshFrMappingStatus();
      });
    });

    refreshFrMappingStatus();
  }

  function refreshFrMappingStatus() {
    const st = $('#sg-fr-mapping-status');
    if (!st) return;
    const pipe = freeResponseMapping.pipeline || {};
    const merged = freeResponseMapping.merged || {};
    const pipeKeys = pipe && typeof pipe === 'object' ? Object.keys(pipe).length : 0;
    const mergeKeys = merged && typeof merged === 'object' ? Object.keys(merged).length : 0;
    const lastDom = freeResponseMapping.lastMergedFromDomain ? escapeHtml(String(freeResponseMapping.lastMergedFromDomain)) : '';
    st.innerHTML = `Pipeline captured fields: <b>${pipeKeys}</b> • Merged keys: <b>${mergeKeys}</b>${lastDom ? `<br>Last domain merge: ${lastDom}` : ''}`;
  }

  /** Legacy hook — unused after FR-only panel; harmless no-op header if present. */
  function updateSampleMappingTotal() {}

  // ─────────────────────────────────────────────────────────────
  //  EVENTS
  // ─────────────────────────────────────────────────────────────
  // Safe binder — logs + continues on missing element / error, so a single
  // missing ID never breaks every other button on the panel.
  function on(sel, ev, fn) {
    try {
      const el = (typeof sel === 'string') ? $(sel) : sel;
      if (!el) { log(`⚠ bind: "${sel}" not found`, 'warn'); return; }
      // One listener per (element, event) so rebuild / duplicate init never stacks handlers.
      var mark = '__sgBound_' + String(ev);
      if (el[mark]) return;
      el[mark] = true;
      el.addEventListener(ev, (e) => {
        try { return fn(e); }
        catch (err) { log(`✗ handler ${sel}: ${err.message}`, 'error'); console.error(err); }
      });
    } catch (err) {
      log(`✗ bind error ${sel}: ${err.message}`, 'error');
    }
  }

  /** Hide all phase blocks + clear nav highlight (used by same-button toggle). */
  function closeAllStudyGuidePhasePanels() {
    studyGuideNavLastPhaseId = null;
    document.querySelectorAll('#sg-panel #sg-body .sg-phase-block').forEach((block) => {
      block.classList.remove('sg-phase-open');
      try {
        block.style.setProperty('display', 'none', 'important');
        block.style.setProperty('visibility', 'hidden', 'important');
        block.style.setProperty('max-height', '0', 'important');
        block.style.setProperty('height', '0', 'important');
        block.style.setProperty('opacity', '0', 'important');
        block.style.setProperty('pointer-events', 'none', 'important');
        block.style.setProperty('overflow', 'hidden', 'important');
        block.style.setProperty('margin-bottom', '0', 'important');
      } catch (_) {}
    });
    document.querySelectorAll('#sg-phase-nav .sg-phase-jump-btn').forEach((b) => {
      b.classList.remove('sg-phase-jump-btn-active');
    });
  }

  /** Open exactly one .sg-phase-block (div), scroll into panel body, highlight top nav.
   * Same nav button dabane se dubara ⇢ sab band. Uses inline !important so host-page CSS cannot hide fields. */
  function openStudyGuidePhaseAccordion(targetId) {
    const body = document.getElementById('sg-body');
    const blocks = document.querySelectorAll('#sg-panel #sg-body .sg-phase-block');
    const target = targetId ? document.getElementById(targetId) : null;
    if (!target || !target.classList || !target.classList.contains('sg-phase-block')) return;

    // Second click on the same highlighted nav shortcut = collapse everything
    if (studyGuideNavLastPhaseId === targetId && target.classList.contains('sg-phase-open')) {
      closeAllStudyGuidePhasePanels();
      return;
    }

    studyGuideNavLastPhaseId = targetId;
    blocks.forEach((block) => {
      const on = block.id === targetId;
      block.classList.toggle('sg-phase-open', on);
      try {
        if (on) {
          block.style.setProperty('display', 'block', 'important');
          block.style.setProperty('visibility', 'visible', 'important');
          block.style.setProperty('opacity', '1', 'important');
          block.style.setProperty('max-height', 'none', 'important');
          block.style.setProperty('height', 'auto', 'important');
          block.style.setProperty('pointer-events', 'auto', 'important');
          block.style.setProperty('overflow', 'visible', 'important');
          block.style.setProperty('margin-bottom', '10px', 'important');
          const inner = block.querySelector('.sg-phase-inner');
          if (inner) {
            inner.style.setProperty('display', 'block', 'important');
            inner.style.setProperty('visibility', 'visible', 'important');
          }
          const hdr = block.querySelector('.sg-phase-summary-btn');
          if (hdr) {
            hdr.style.setProperty('display', 'flex', 'important');
            hdr.style.setProperty('visibility', 'visible', 'important');
          }
        } else {
          block.style.setProperty('display', 'none', 'important');
          block.style.setProperty('visibility', 'hidden', 'important');
          block.style.setProperty('max-height', '0', 'important');
          block.style.setProperty('height', '0', 'important');
          block.style.setProperty('opacity', '0', 'important');
          block.style.setProperty('pointer-events', 'none', 'important');
          block.style.setProperty('overflow', 'hidden', 'important');
          block.style.setProperty('margin-bottom', '0', 'important');
        }
      } catch (_) {}
    });
    document.querySelectorAll('#sg-phase-nav .sg-phase-jump-btn').forEach((b) => {
      const tid = b.getAttribute('data-phase-target');
      b.classList.toggle('sg-phase-jump-btn-active', tid === targetId);
    });
    if (!body) return;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        try {
          target.scrollIntoView({ block: 'nearest', behavior: 'auto' });
          const br = body.getBoundingClientRect();
          const er = target.getBoundingClientRect();
          const pad = 8;
          if (Math.abs(er.top - br.top) > 150) body.scrollTop += (er.top - br.top) - pad;
        } catch (_) {
          try { target.scrollIntoView({ block: 'start', behavior: 'auto' }); } catch (_) {}
        }
      });
    });
  }

  /** Capture-phase delegation — works even when per-button bindEvents missed (SPA / early init race). */
  function ensureStudyGuidePhaseNavDelegation() {
    const root = document.documentElement;
    if (root.dataset.sgPhaseNavDelegation === '1') return;
    root.dataset.sgPhaseNavDelegation = '1';
    document.addEventListener(
      'click',
      function _sgPhaseNavDelegation(ev) {
        const raw = ev.target;
        if (!raw || !raw.closest) return;
        const btn = raw.closest('#sg-phase-nav [data-phase-target]');
        if (!btn || btn.disabled) return;
        const panel = document.getElementById('sg-panel');
        if (!panel || !panel.contains(btn)) return;
        const tid = btn.getAttribute('data-phase-target');
        if (!tid) return;
        try {
          ev.preventDefault();
          ev.stopPropagation();
        } catch (_) {}
        openStudyGuidePhaseAccordion(tid);
      },
      true,
    );
  }

  function wirePhaseJumpButton(buttonSelector, phaseDetailsId) {
    on(buttonSelector, 'click', (e) => {
      try {
        e.preventDefault();
        e.stopPropagation();
      } catch (_) {}
      openStudyGuidePhaseAccordion(phaseDetailsId);
    });
  }

  /** Purple row under each phase — same behaviour as top jump buttons. */
  function wirePhaseHeaderCollapseButtons() {
    document.querySelectorAll('#sg-body button.sg-phase-summary-btn').forEach((btn) => {
      if (btn.dataset.sgPhaseSummBound) return;
      btn.dataset.sgPhaseSummBound = '1';
      btn.addEventListener('click', (ev) => {
        try {
          ev.preventDefault();
          ev.stopPropagation();
        } catch (_) {}
        const pid = btn.getAttribute('data-phase-collapse');
        if (pid) openStudyGuidePhaseAccordion(pid);
      });
    });
  }

  function bindEvents() {
    // IMPORTANT: Do NOT attach click-to-collapse on the whole header — it
    // swallows clicks targeted at the toggle / close buttons sitting inside it.
    on('#sg-voice-btn',  'click', (e) => { e.stopPropagation(); toggleVoiceEnabled(); });
    on('#sg-toggle-btn', 'click', (e) => { e.stopPropagation(); togglePanel(); });
    on('#sg-close-btn',  'click', (e) => { e.stopPropagation(); closePanel(); });

    ensureStudyGuidePhaseNavDelegation();

    wirePhaseJumpButton('#sg-jump-requirement', 'sg-phase-requirement');
    wirePhaseJumpButton('#sg-jump-studyguide', 'sg-phase-studyguide');
    wirePhaseJumpButton('#sg-jump-reference', 'sg-phase-reference');
    wirePhaseJumpButton('#sg-jump-workflow', 'sg-phase-workflow');
    wirePhaseJumpButton('#sg-jump-visual', 'sg-phase-visual');
    wirePhaseJumpButton('#sg-jump-domain-weights', 'sg-phase-domain-weights');
    wirePhaseJumpButton('#sg-jump-fr-mapping', 'sg-phase-fr-mapping');
    wirePhaseJumpButton('#sg-jump-issue-log', 'sg-phase-issue-log');
    wirePhaseJumpButton('#sg-jump-google-docs', 'sg-phase-google-docs');

    // Saves
    on('#sg-save-requirement-exam', 'click', saveExamConfig);
    on('#sg-save-exam',     'click', saveExamConfig);
    on('#sg-save-image',    'click', saveImageConfig);
    on('#sg-save-ref',      'click', saveRefConfig);
    on('#sg-save-docs',     'click', saveDocsConfig);
    on('#sg-test-conn',     'click', testDocsConnection);
    // Toggles — clicking flips state and auto-saves immediately.
    bindToggle('tog-enableGemini',          imageConfig, 'enableGemini',          STORAGE_KEYS.IMAGE_CONFIG);
    bindToggle('tog-equationsAsImages',     imageConfig, 'equationsAsImages',     STORAGE_KEYS.IMAGE_CONFIG);
    bindToggle('tog-generateCharts',        imageConfig, 'generateCharts',        STORAGE_KEYS.IMAGE_CONFIG);
    bindToggle('tog-generateDiagrams',      imageConfig, 'generateDiagrams',      STORAGE_KEYS.IMAGE_CONFIG);

    bindToggle('tog-validateQuality',     refConfig, 'validateQuality',     STORAGE_KEYS.REF_CONFIG);
    bindToggle('tog-stripSourceMentions', refConfig, 'stripSourceMentions', STORAGE_KEYS.REF_CONFIG);

    // Domains
    on('#sg-add-domain', 'click', () => {
      domains.push({ name: '', weight: 0 });
      saveObj(STORAGE_KEYS.DOMAINS, domains);
      renderDomains();
    });
    on('#sg-detect-domains', 'click', autoDetectDomains);

    // Workflow
    on('#sg-open-outline',    'click', () => openGPTForUpload('outline'));
    on('#sg-confirm-outline', 'click', () => confirmUpload('outline'));
    on('#sg-open-books',      'click', () => openGPTForUpload('books'));
    on('#sg-confirm-books',   'click', () => confirmUpload('books'));
    on('#sg-open-samples-workflow', 'click', () => openGPTForUpload('samples'));
    on('#sg-confirm-samples-workflow', 'click', () => confirmUpload('samples'));
    on('#sg-frq-sample-confirm', 'click', () => confirmUpload('samples'));
    on('#sg-issue-log-refresh', 'click', () => { try { refreshIssueLogUI(); } catch (_) {} });
    on('#sg-issue-log-download', 'click', downloadIssueLogFile);
    on('#sg-issue-log-clear', 'click', clearIssueLogManually);
    on('#sg-resume-context-ok', 'click', () => {
      const btn = $('#sg-resume-context-ok');
      if (btn) btn.style.display = 'none';
      hideStepNotify();
      if (pendingConfirm.resumeContext) {
        const fn = pendingConfirm.resumeContext;
        pendingConfirm.resumeContext = null;
        fn();
      }
    });

    // Auto-generate + controls
    on('#sg-auto-generate','click', autoGenerate);
    on('#sg-btn-verify',   'click', (e) => {
      try { e.preventDefault(); e.stopPropagation(); } catch (_) {}
      startExamVerification();
    });
    on('#sg-btn-start',    'click', startGeneration);
    on('#sg-btn-pause',    'click', pauseGeneration);
    on('#sg-btn-resume',   'click', resumeGeneration);
    on('#sg-btn-retry',    'click', retryPage);
    on('#sg-btn-skip',     'click', skipPage);
    on('#sg-btn-stop',     'click', stopGeneration);
    on('#sg-btn-reset',    'click', resetEverything);

    on('#sg-fr-mapping-save', 'click', saveSampleMapping);
    on('#sg-fr-mapping-reset', 'click', resetSampleMapping);
    on('#sg-fr-mapping-autodetect', 'click', () => { void autoDetectSampleMapping(); });

    // Console
    on('#sg-clear-console', 'click', () => {
      const c = $('#sg-console'); if (c) c.innerHTML = '';
      log('Console cleared.', 'sys');
    });

    // Popup
    on('#sg-popup-upload', 'click', () => {
      const mode = popupContext.mode || 'missing_reference';
      if (mode === 'open_gpt_tab') {
        hidePopup();
        try { GM_openInTab('https://chatgpt.com/', { active: true }); } catch (_) {}
        log('🌐 ChatGPT tab opened. Continue upload there, then return and confirm.', 'info');
        return;
      }
      hidePopup();
      openGPTForUpload('missing');
    });
    on('#sg-popup-skip',   'click', () => {
      const mode = popupContext.mode || 'missing_reference';
      hidePopup();
      if (mode === 'open_gpt_tab') return;
      skipPage();
    });

    // Book popup
    on('#sg-book-popup-add',     'click', () => openGPTForUpload('new-book'));
    on('#sg-book-popup-confirm', 'click', () => {
      if (pendingConfirm.newBook) {
        pendingConfirm.newBook();
        pendingConfirm.newBook = null;
      }
      hideBookPopup();
      log('✔ New book confirmed. Re-checking coverage...', 'ok');
    });

    wirePhaseHeaderCollapseButtons();
  }

  function bindToggle(id, target, field, storageKey) {
    const el = document.getElementById(id);
    if (!el) return;
    if (el.dataset.sgToggleBound === '1') return;
    el.dataset.sgToggleBound = '1';
    el.addEventListener('click', () => {
      target[field] = !target[field];
      el.classList.toggle('on', target[field]);
      saveObj(storageKey, target);
      log(`Toggle "${field}" → ${target[field] ? 'ON' : 'OFF'}`, 'sys');
    });
  }

  function togglePanel() {
    const p = $('#sg-panel');
    p.classList.toggle('collapsed');
    $('#sg-toggle-btn').textContent = p.classList.contains('collapsed') ? '▲' : '▼';
  }

  // ─────────────────────────────────────────────────────────────
  //  SAVE CONFIGS
  // ─────────────────────────────────────────────────────────────
  function saveExamConfig() {
    examConfig = {
      ...examConfig, // keep auto-detected verification fields
      examName:        $('#sg-exam-name').value.trim(),
      totalPages:      parseInt($('#sg-total-pages').value, 10)  || DEFAULT_EXAM_CONFIG.totalPages,
      wordsPerPage:    parseInt($('#sg-words-page').value, 10)   || DEFAULT_EXAM_CONFIG.wordsPerPage,
      startFromPage:   parseInt($('#sg-start-page').value, 10)   || 1,
      minLinesPerPara: parseInt($('#sg-min-lines').value, 10)    || DEFAULT_EXAM_CONFIG.minLinesPerPara,
      maxLinesPerPara: parseInt($('#sg-max-lines').value, 10)    || DEFAULT_EXAM_CONFIG.maxLinesPerPara,
    };
    if (!examConfig.examName) {
      log('⚠ Exam Name is required.', 'warn');
      return;
    }
    saveObj(STORAGE_KEYS.EXAM_CONFIG, examConfig);
    progress.pagesTotal = examConfig.totalPages;
    saveObj(STORAGE_KEYS.PROGRESS, progress);
    const frPlanEl = $('#sg-fr-planning-total');
    if (frPlanEl) {
      const tv = parseInt(frPlanEl.value, 10);
      if (!isNaN(tv) && tv >= 0) {
        practiceConfig.totalQuestions = tv;
        saveObj(STORAGE_KEYS.PRACTICE_CONFIG, practiceConfig);
      }
    }
    updateProgressUI();
    log(`✔ Exam config saved — ${examConfig.examName}, ${examConfig.totalPages} pages.`, 'ok');
    notify('Exam configuration saved!');
  }

  function saveImageConfig() {
    imageConfig.maxWaitGeminiSec =
      parseInt($('#sg-max-wait').value, 10) || DEFAULT_IMAGE_CONFIG.maxWaitGeminiSec;
    saveObj(STORAGE_KEYS.IMAGE_CONFIG, imageConfig);
    log('✔ Image config saved.', 'ok');
    notify('Image configuration saved!');
  }

  function saveRefConfig() {
    refConfig.reminderEveryPages =
      parseInt($('#sg-remind-every').value, 10) || DEFAULT_REF_CONFIG.reminderEveryPages;
    refConfig.autoStopOnMissing = true;
    saveObj(STORAGE_KEYS.REF_CONFIG, refConfig);
    log('✔ Reference config saved.', 'ok');
    notify('Reference configuration saved!');
  }

  /** Read current input values into Tampermonkey storage (no toast). */
  function persistDocsConfigFromUI() {
    const u   = document.getElementById('sg-apps-script-url');
    const d   = document.getElementById('sg-doc-id');
    const sk  = document.getElementById('sg-secret-key');
    const url    = (u && u.value) ? String(u.value).trim() : '';
    const docId  = (d && d.value) ? String(d.value).trim() : '';
    const secret = (sk && sk.value) ? String(sk.value).trim() : '';
    GM_setValue(STORAGE_KEYS.APPS_SCRIPT_URL, url);
    GM_setValue(STORAGE_KEYS.DOC_ID, docId);
    GM_setValue(STORAGE_KEYS.SECRET_KEY, secret);
  }

  function saveDocsConfig() {
    persistDocsConfigFromUI();
    log('✔ Google Docs connection saved.', 'ok');
    notify('Docs connection saved!');
  }

  function testDocsConnection() {
    const result = $('#sg-conn-result');
    const url    = $('#sg-apps-script-url').value.trim();
    const docId  = $('#sg-doc-id').value.trim();
    const secret = ($('#sg-secret-key')?.value || '').trim();

    if (!url || !docId) {
      if (result) {
        result.style.display = 'block';
        result.style.background = 'rgba(239,68,68,.08)';
        result.style.color = '#f87171';
        result.textContent = '✗ URL and Doc ID required';
      }
      return;
    }
    if (result) {
      result.style.display = 'block';
      result.style.background = 'rgba(59,130,246,.08)';
      result.style.color = '#60a5fa';
      result.textContent = '⏳ Testing...';
    }

    GM_xmlhttpRequest({
      method: 'POST',
      url,
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify({ secret, docId, action: 'ping' }),
      timeout: 15000,
      onload: (r) => {
        if (r.status >= 200 && r.status < 400) {
          let serverErr = null;
          try {
            const resp = JSON.parse(r.responseText || '{}');
            if (resp.status === 'error') serverErr = resp.message || 'Server error';
          } catch (_) {}
          if (result) {
            result.style.display = 'block';
            if (serverErr) {
              result.style.background = 'rgba(239,68,68,.08)';
              result.style.color = '#f87171';
              result.textContent = '✗ ' + serverErr;
            } else {
              result.style.background = 'rgba(16,185,129,.08)';
              result.style.color = '#4ade80';
              result.textContent = '✓ Connection successful';
            }
          }
        } else if (result) {
          result.style.display = 'block';
          result.style.background = 'rgba(239,68,68,.08)';
          result.style.color = '#f87171';
          result.textContent = `✗ HTTP ${r.status}`;
        }
      },
      onerror: () => {
        if (result) {
          result.style.display = 'block';
          result.style.background = 'rgba(239,68,68,.08)';
          result.style.color = '#f87171';
          result.textContent = '✗ Network unreachable';
        }
      },
      ontimeout: () => {
        if (result) {
          result.style.display = 'block';
          result.style.background = 'rgba(239,68,68,.08)';
          result.style.color = '#f87171';
          result.textContent = '✗ Timed out';
        }
      },
    });
  }

  function saveSampleMapping() {
    captureFrMappingInputsToMerged();
    persistFreeResponseMappingState();
    log('✔ Free-response mapping saved.', 'ok');
    notify('FR mapping saved.');
  }

  function resetSampleMapping() {
    if (!confirm('Reset pipeline + merged free-response mapping? (Does not clear legacy sampleMapping table.)')) return;
    freeResponseMapping = defaultFreeResponseMappingState();
    saveObj(STORAGE_KEYS.FREE_RESPONSE_MAPPING, freeResponseMapping);
    persistMappingSnapshot('sample_mapping');
    renderSampleMapping();
    log('↺ Free-response mapping reset.', 'warn');
  }

  async function autoDetectSampleMapping() {
    if (!isOnGPT()) {
      log('⚠ FR mapping auto-detect runs on ChatGPT. Open chatgpt.com.', 'warn');
      return;
    }
    if (!examConfig.examName) {
      log('⚠ Set Exam Name first.', 'warn');
      return;
    }

    log('🔍 Pipeline FR mapping: confirming uploads are readable...', 'info');
    try {
      await sendToGPT(`Confirm you can read uploaded FREE-RESPONSE / past-paper materials for "${examConfig.examName}".
Reply exactly:
FR_UPLOADS_UNDERSTOOD
Then stop.`, 120000, 1);
    } catch (err) {
      log(`⚠ FR upload confirm step failed: ${err.message}`, 'warn');
    }

    const prompt = `You are analysing exam "${examConfig.examName}".

Use ONLY observable patterns in uploaded materials (past papers, model answers, examiner reports, free-response prompts). Extract measurable FREE-RESPONSE style signals so future FR items can mirror the real exam.

Do NOT estimate MCQ type distribution. Do NOT output scenarioBased / definitionType percentages.

${FR_JSON_SCHEMA_HINT}

Rules:
- Integer word counts and counts only when evidence exists; otherwise 0.
- free_response_percentage_estimate: from measurable FR vs total question counts if possible; else 0.
- Arrays: list concrete rules seen in samples; keep each line short.`;

    try {
      const raw = await sendToGPT(prompt, 180000, 2);
      const data = extractJSON(raw);
      const norm = normalizePipelineFrGPT(data);
      freeResponseMapping.pipeline = { ...norm };
      freeResponseMapping.merged = mergeFrMappingLayers({}, norm);
      freeResponseMapping.lastMergedFromDomain = '';
      persistFreeResponseMappingState();
      renderSampleMapping();
      const n = Object.keys(norm).length;
      log(`✔ Pipeline FR mapping captured (${n} fields).`, 'ok');
      notify(`FR mapping: pipeline pass updated (${n} fields).`);
    } catch (err) {
      log(`✗ FR pipeline mapping detect failed: ${err.message}`, 'error');
    }
  }

  // ─────────────────────────────────────────────────────────────
  //  WORKFLOW STEPS
  // ─────────────────────────────────────────────────────────────
  function openGPTForUpload(kind) {
    const host = window.location.hostname;
    if (host.includes('chatgpt') || host.includes('openai')) {
      log(`📎 Opening GPT upload dialog for ${kind}...`, 'info');
      GPT.triggerUpload();
    } else {
      log('ℹ Auto-open disabled. Please use popup to open ChatGPT tab.', 'warn');
      showPopup(
        'Open ChatGPT Tab',
        'You are not on chatgpt.com. Click "Open ChatGPT Tab", upload the required file there, then return and press Confirm in this panel.',
        {
          mode: 'open_gpt_tab',
          uploadLabel: '🌐 Open ChatGPT Tab',
          skipLabel: 'Cancel',
          showSkip: true,
        }
      );
    }
  }

  async function confirmUpload(kind) {
    if (kind === 'outline') {
      workflow.outlineUploaded = true;
      log('✔ Outline confirmed.', 'ok');
      applyWorkflowUI();
      saveObj(STORAGE_KEYS.WORKFLOW, workflow);
      hideStepNotify();
      if (pendingConfirm.outline) {
        pendingConfirm.outline(); pendingConfirm.outline = null;
      } else {
        // Manual (non-orchestrated) path: auto-detect inline
        await autoDetectDomains();
      }
    } else if (kind === 'books') {
      workflow.booksUploaded = true;
      log('✔ Reference books confirmed.', 'ok');
      applyWorkflowUI();
      saveObj(STORAGE_KEYS.WORKFLOW, workflow);
      hideStepNotify();
      if (pendingConfirm.books) {
        pendingConfirm.books(); pendingConfirm.books = null;
      }
    } else if (kind === 'samples') {
      workflow.samplesUploaded = true;
      log('✔ Sample questions confirmed.', 'ok');
      issueLog('info', 'confirm_samples', { pendingResolver: !!pendingConfirm.samples });
      applyWorkflowUI();
      saveObj(STORAGE_KEYS.WORKFLOW, workflow);
      hideStepNotify();
      if (pendingConfirm.samples) {
        pendingConfirm.samples(); pendingConfirm.samples = null;
      }
    }
  }

  // ─────────────────────────────────────────────────────────────
  //  AUTO-DETECT DOMAINS (via GPT)
  // ─────────────────────────────────────────────────────────────
  async function autoDetectDomains() {
    if (!isOnGPT()) {
      log('⚠ Auto-detect runs on ChatGPT. Please run from chatgpt.com.', 'warn');
      return;
    }
    log('🔍 Asking GPT to extract domains + weights from the uploaded outline...', 'info');
    const prompt = `From the exam outline I just uploaded, extract ALL domains and their official weight percentages.
Return STRICT JSON ONLY in this shape — no prose, no commentary:
{
  "domains": [
    { "name": "DOMAIN NAME", "weight": 20 }
  ]
}
Rules:
- Weights MUST sum to 100.
- Use the exact domain names from the outline.
- If a domain has no explicit weight, estimate proportionally from sub-topic counts.`;

    try {
      const raw = await sendToGPT(prompt);
      const data = extractJSON(raw);
      const list = Array.isArray(data.domains) ? data.domains : [];
      if (!list.length) {
        log('⚠ GPT returned no domains. Add them manually.', 'warn');
        return;
      }
      domains = list.map(d => ({
        name:   String(d.name || '').trim(),
        weight: parseFloat(d.weight) || 0,
      })).filter(d => d.name);
      saveObj(STORAGE_KEYS.DOMAINS, domains);
      persistMappingSnapshot('auto_domains');
      renderDomains();
      log(`✔ Auto-detected ${domains.length} domains.`, 'ok');
      notify(`Detected ${domains.length} domains from outline.`);
    } catch (err) {
      log(`✗ Auto-detect failed: ${err.message}`, 'error');
    }
  }

  // ─────────────────────────────────────────────────────────────
  //  EXAM VERIFICATION (pre-flight check via GPT)
  // ─────────────────────────────────────────────────────────────
  async function startExamVerification() {
    if (startExamVerification.__lock) {
      log('⏳ Exam verification already in progress — wait for it to finish.', 'warn');
      return;
    }
    if (!examConfig.examName) {
      log('⚠ Enter the Exam Name first.', 'warn');
      return;
    }
    if (!isOnGPT()) {
      log('⚠ Exam verification runs on ChatGPT. Open chatgpt.com and retry.', 'warn');
      return;
    }
    // Fresh verification run should not inherit a stale abort from a prior stop.
    abortFlag = false;
    startExamVerification.__lock = true;

    const btn = $('#sg-btn-verify');
    if (btn) {
      btn.disabled = true;
      btn.textContent = '⏳ Verifying...';
    }

    // Recovery mode for new-tab resume:
    // If checkpoint is mid-run, do not re-run full exam verification/mapping.
    // Ask only for books upload, verify coverage, then continue from checkpoint.
    const isResumeCheckpoint = !!(progress && progress.phase && progress.phase !== 'idle' && progress.phase !== 'done');
    if (isResumeCheckpoint) {
      try {
        log(`📌 Resume recovery via Exam Verification (phase=${progress.phase}).`, 'info');
        if (progress.pipelineEnteredDomainOnce) {
          await runGptTabResyncWarmup('Exam verification — GPT tab resync');
        } else {
          showStepNotify('Upload All Reference Books', 'Upload ALL reference books in this GPT tab, then click "✓ Confirm Books".');
          await waitForConfirm('books');
          if (abortFlag) throw new Error('Aborted');
          hideStepNotify();
          await verifyReferenceCoverageOrStop('exam verification resume');
        }
        log('✔ Resume preamble done. Continuing orchestrator from checkpoint...', 'ok');

        abortFlag = false;
        pauseFlag = false;
        await startGeneration({ skipWarmup: true });
      } catch (err) {
        log(`✗ Resume recovery failed: ${err.message}`, 'error');
      } finally {
        startExamVerification.__lock = false;
        if (btn) {
          btn.disabled = false;
          btn.textContent = '📋 Start Exam Verification';
        }
      }
      return;
    }

    log(`📋 Starting exam verification for "${examConfig.examName}"...`, 'info');

    const prompt = `You are a study-guide architect. Verify the following exam and return plain text.

Exam: ${examConfig.examName}

Return in this format:
{
  "exam_name": "",
  "free_response_available": true,
  "difficulty_level": "school_level | academic_college_level | full_advanced_level",
  "governing_body": "",
  "total_questions": 0,
  "time_limit_minutes": 0,
  "passing_score": "",
  "question_types": [],
  "domains": [{"name":"","weight_percent":0,"subdomain_count":0}],
  "recommended_references": [],
  "visual_needs": {
    "images_required":     true,
    "equations_required":  true,
    "charts_required":     true,
    "diagrams_required":   true,
    "reactions_required":  false,
    "code_required":       false,
    "tables_required":     true,
    "case_studies":        false,
    "image_frequency":     "every_page | smart | rare | never",
    "notes": "short reason why images are needed for this exam"
  },
  "verified": true,
  "warnings": []
}

Rules:
- If the exam is unknown or ambiguous: set "verified": false, list issues in "warnings".
- Domain weights MUST sum to 100 when verified is true.
- Use official names (no paraphrasing).
- "free_response_available" must be true only if this exam normally includes subjective/long/free-response style questions.
- "difficulty_level" must be exactly one of: school_level, academic_college_level, full_advanced_level.
- visual_needs MUST be populated truthfully based on the exam subject:
    * Anatomy / Biology / Medical / Physics / Chemistry / Engineering / Networking / Programming / Math / Stats / Economics → images_required: true
    * Chemistry → reactions_required: true, equations_required: true
    * Math / Physics / Stats / Engineering / Economics → equations_required: true, charts_required: true
    * Programming / Data structures / Algorithms → code_required: true
- image_frequency: "every_page" for Anatomy/Medical/Biology-heavy visual exams; "smart" for most others; "rare" or "never" only for pure theory / literature / law.`;

    try {
      // One shot only — no automatic retries, or the same exam prompt would be sent twice in chat.
      const raw = await sendToGPT(prompt, 300000, 1);
      const data = extractJSON(raw);

      if (!data || data.verified === false) {
        const warnings = (data && data.warnings) ? data.warnings.join('; ') : 'Exam not verified.';
        log(`✗ Verification failed: ${warnings}`, 'error');
        try {
          log(`📎 Fallback follow-up → confirm (free response + difficulty)...`, 'info');
          const cfFallback = await fetchExamProfileJsonConfirmationSecondShot();
          examConfig.freeResponseAvailable = cfFallback.detectedFR;
          examConfig.difficultyLevel = cfFallback.detectedDifficulty;
          saveObj(STORAGE_KEYS.EXAM_CONFIG, examConfig);
          applyConfigsToUI({ includeDocs: false });
          log(`   Fallback pass-2: FR=${examConfig.freeResponseAvailable}; difficulty=${examConfig.difficultyLevel}`, 'ok');
        } catch (eCf2) {
          log(`⚠ Fallback pass-2 failed: ${eCf2.message}`, 'warn');
        }
        notify('Exam verification returned warnings — see console.');
      } else {
        log(`✔ Verified: ${data.exam_name || examConfig.examName}`, 'ok');
        const merged1 = mergeExamProfileFieldsFromGPTPayload(data);
        examConfig.freeResponseAvailable = merged1.detectedFR;
        examConfig.difficultyLevel = merged1.detectedDifficulty;
        log(`   Pass-1 FR: ${examConfig.freeResponseAvailable}; difficulty: ${examConfig.difficultyLevel}`, 'sys');
        if (data.governing_body)     log(`   Governing body: ${data.governing_body}`, 'sys');
        if (data.total_questions)    log(`   Total questions: ${data.total_questions}`, 'sys');
        if (data.time_limit_minutes) log(`   Time limit: ${data.time_limit_minutes} min`, 'sys');
        if (data.passing_score)      log(`   Passing score: ${data.passing_score}`, 'sys');
        if (Array.isArray(data.question_types) && data.question_types.length) {
          log(`   Question types: ${data.question_types.join(', ')}`, 'sys');
        }
        if (Array.isArray(data.domains) && data.domains.length) {
          log(`   Detected ${data.domains.length} domain(s) — pre-filling Domain Weights.`, 'sys');
          domains = data.domains.map(d => ({
            name:   String(d.name || '').trim(),
            weight: parseFloat(d.weight_percent) || 0,
            subdomains: [],
          })).filter(d => d.name);
          saveObj(STORAGE_KEYS.DOMAINS, domains);
          renderDomains();
        }

        // Auto-apply visual_needs to the UI toggles so images + diagrams are
        // ready for the whole pipeline.
        const vn = data.visual_needs || {};
        applyVisualNeedsToUI(vn);
        // Persist the freq so the orchestrator can force-enable images when needed.
        examConfig.imageFrequency = String(vn.image_frequency || 'smart').toLowerCase();
        if (data.visual_needs && data.visual_needs.notes) {
          log(`   Visual needs: ${vn.notes}`, 'img');
        }
        try {
          log(`📎 Auto follow-up → confirm (free response + difficulty)...`, 'info');
          const cf = await fetchExamProfileJsonConfirmationSecondShot();
          examConfig.freeResponseAvailable = cf.detectedFR;
          examConfig.difficultyLevel = cf.detectedDifficulty;
          log(`   Pass-2 authoritative: FR=${examConfig.freeResponseAvailable}; difficulty=${examConfig.difficultyLevel}`, 'ok');
        } catch (eCf) {
          log(`⚠ Pass-2 profile confirm failed: ${eCf.message} — keeping Pass-1 FR/difficulty.`, 'warn');
        }
        saveObj(STORAGE_KEYS.EXAM_CONFIG, examConfig);
        applyConfigsToUI({ includeDocs: false });

        notify('Exam verified + FR/difficulty confirmed + visual needs applied!');
      }
    } catch (err) {
      const msg = String(err && err.message || '');
      if (/aborted/i.test(msg)) {
        // User-triggered abort/cancel: do not spam error lines.
        log('Verification cancelled.', 'sys');
      } else {
        log(`✗ Exam verification error: ${msg || 'unknown error'}`, 'error');
      }
    } finally {
      startExamVerification.__lock = false;
      if (btn) {
        btn.disabled = false;
        btn.textContent = '📋 Start Exam Verification';
      }
    }
  }

  // ─────────────────────────────────────────────────────────────
  //  AUTO GENERATE (Text + Images pipeline)
  // ─────────────────────────────────────────────────────────────
  async function autoGenerate() {
    if (!examConfig.examName) {
      log('⚠ Set Exam Name first.', 'warn');
      return;
    }
    await startGeneration();
  }

  // ─────────────────────────────────────────────────────────────
  //  STEP NOTIFICATION (yellow banner + active confirm button)
  // ─────────────────────────────────────────────────────────────
  function showStepNotify(title, message) {
    const box = $('#sg-step-notify');
    const msg = $('#sg-step-notify-msg');
    if (!box || !msg) return;
    box.style.display = 'block';
    msg.innerHTML = `<b>${escapeHtml(title)}</b><br>${escapeHtml(message)}`;
    announceVoice(`Action required. ${title}. ${message}`, { minGapMs: 2200 });
  }
  function hideStepNotify() {
    const box = $('#sg-step-notify');
    if (box) box.style.display = 'none';
    const resumeBtn = $('#sg-resume-context-ok');
    if (resumeBtn) resumeBtn.style.display = 'none';
    const frqBtn = $('#sg-frq-sample-confirm');
    if (frqBtn) frqBtn.style.display = 'none';
  }

  function updateVoiceToggleUI() {
    const btn = $('#sg-voice-btn');
    if (!btn) return;
    const on = !!voiceConfig.enabled;
    btn.textContent = on ? '🔊' : '🔇';
    btn.classList.toggle('active', on);
    btn.title = on ? 'Voice announcements ON' : 'Voice announcements OFF';
  }

  function setVoiceEnabled(enabled) {
    voiceConfig.enabled = !!enabled;
    if (voiceConfig.enabled) {
      const picked = getAnnouncementVoice();
      _sgVoiceLockedName = picked && picked.name ? String(picked.name) : '';
      voiceConfig.selectedVoiceName = _sgVoiceLockedName;
    } else {
      _sgVoiceLockedName = '';
    }
    saveObj(STORAGE_KEYS.VOICE_CONFIG, voiceConfig);
    updateVoiceToggleUI();
    if (!voiceConfig.enabled) {
      try { window.speechSynthesis && window.speechSynthesis.cancel(); } catch (_) {}
      log('🔇 Voice announcements disabled.', 'sys');
      return;
    }
    log('🔊 Voice announcements enabled.', 'sys');
    announceVoice('Voice announcements enabled.', { force: true });
  }

  function toggleVoiceEnabled() {
    setVoiceEnabled(!voiceConfig.enabled);
  }

  function getAnnouncementVoice() {
    const synth = window.speechSynthesis;
    if (!synth || !synth.getVoices) return null;
    const voices = synth.getVoices() || [];
    if (!voices.length) return null;
    const preferredName = String(_sgVoiceLockedName || voiceConfig.selectedVoiceName || '').trim();
    if (preferredName) {
      const locked = voices.find(v => String(v.name || '').toLowerCase() === preferredName.toLowerCase());
      if (locked) return locked;
    }
    return (
      voices.find(v => /jenny/i.test(v.name)) ||
      voices.find(v => /aria/i.test(v.name)) ||
      voices.find(v => /sonia/i.test(v.name)) ||
      voices.find(v => /female|woman|girl/i.test(v.name)) ||
      voices.find(v => /^en-(US|GB|AU)/i.test(v.lang) && /microsoft|google|neural/i.test(v.name)) ||
      voices.find(v => /^en-/i.test(v.lang)) ||
      voices[0]
    );
  }

  function sanitizeAnnouncementText(text) {
    return String(text || '')
      .replace(/[✅✔🎯📘📚🗺📏🧩⚠✗⏸▶🎉🔔🔇🔊]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function announceVoice(text, opts = {}) {
    if (!voiceConfig.enabled) return;
    const clean = sanitizeAnnouncementText(text);
    if (!clean) return;
    const now = Date.now();
    const minGapMs = Math.max(600, parseInt(opts.minGapMs, 10) || 1400);
    if (!opts.force) {
      if (clean === _sgVoiceLastText && (now - _sgVoiceLastTs) < 9000) return;
      if ((now - _sgVoiceLastTs) < minGapMs) return;
    }
    _sgVoiceLastText = clean;
    _sgVoiceLastTs = now;
    try {
      const synth = window.speechSynthesis;
      if (!synth || typeof SpeechSynthesisUtterance === 'undefined') return;
      const utter = new SpeechSynthesisUtterance(clean);
      const v = getAnnouncementVoice();
      if (v) {
        utter.voice = v;
        utter.lang = v.lang || 'en-US';
      } else {
        utter.lang = 'en-US';
      }
      // Keep the exact same pace/tone across full coverage announcements.
      utter.rate = 0.94;
      utter.pitch = 0.95;
      utter.volume = 1.0;
      if (opts.interrupt) synth.cancel();
      synth.speak(utter);
    } catch (_) {}
  }

  function waitForConfirm(kind) {
    return new Promise((resolve) => { pendingConfirm[kind] = resolve; });
  }

  function showBookPopup(missingList) {
    const overlay = $('#sg-book-popup-overlay');
    const body    = $('#sg-book-popup-body');
    if (!overlay || !body) return Promise.resolve();
    const listHtml = (missingList && missingList.length)
      ? `<br><br><b>Missing / topic:</b><br>• ${missingList.map(escapeHtml).join('<br>• ')}`
      : '';
    body.innerHTML = `The runner is waiting (no full-screen block). In ChatGPT, add the missing book or file, then press <b>Confirm</b> to re-check that the reference is available.${listHtml}`;
    overlay.style.display = 'block';
    const firstMissing = (missingList && missingList.length) ? String(missingList[0]) : 'a required reference topic';
    announceVoice(`Reference required. Please upload the missing source. First missing item: ${firstMissing}.`, { minGapMs: 1700, interrupt: true });
    return new Promise((resolve) => { pendingConfirm.newBook = resolve; });
  }

  function hideBookPopup() {
    const overlay = $('#sg-book-popup-overlay');
    const body = $('#sg-book-popup-body');
    const hint = $('#sg-book-popup-hint');
    const addBtn = $('#sg-book-popup-add');
    const confirmBtn = $('#sg-book-popup-confirm');
    if (overlay) overlay.style.display = 'none';
    if (body) body.innerHTML = 'GPT needs another reference. Upload a PDF in ChatGPT, then press Confirm to re-verify.';
    if (hint) hint.innerHTML = 'Confirm runs the <b>“new book + coverage”</b> check so generation can continue only when the reference is available.';
    if (addBtn) addBtn.textContent = '📎 Add New Book';
    if (confirmBtn) confirmBtn.textContent = '✓ Confirm (verify ref)';
  }

  // ─────────────────────────────────────────────────────────────
  //  MASTER RULES (the v13 absolute-structure command)
  // ─────────────────────────────────────────────────────────────
  function buildMasterRules() {
    const cfg = {
      pages: examConfig.totalPages,
      words: examConfig.wordsPerPage,
      minL:  examConfig.minLinesPerPara,
      maxL:  examConfig.maxLinesPerPara,
    };
    const difficulty = String(examConfig.difficultyLevel || 'academic_college_level');
    const frAvail = !!examConfig.freeResponseAvailable;
    return `You are the StudyGuide AI — exam "${examConfig.examName}".

Core rules:
- Use uploaded references only. If missing, output: REFERENCE_NOT_FOUND: <topic>
- Use heading hierarchy exactly: #Domain, ##Subdomain, ###Topic
- No author/student voice, no filler, English only
- Keep approx ${cfg.words} words/page and paragraph length ${cfg.minL}-${cfg.maxL} lines
- Keep book-style output with prose first, then DISPLAY blocks where needed
- Verified profile: difficulty_level=${difficulty}, free_response_available=${frAvail ? 'true' : 'false'}

Total pages: ${cfg.pages} | Words/page: ~${cfg.words} | Para lines: ${cfg.minL}–${cfg.maxL}
Do NOT generate anything yet. Reply ONLY: RULES ACKNOWLEDGED — READY FOR OUTLINE`;
  }

  const SG_STRICT_DOMAIN_MAPPING_PROMPT = `Step 1: Confirm you have read the outline I just uploaded. Start your reply with exactly:
OUTLINE_CONFIRMED

Step 2: On new lines output the OFFICIAL domain + subdomain mapping with official exam weights.
Use this EXACT format — no extra text, no commentary, no intro, no outro:

Domain-1:<domain name>
Subdomain-1.1:<subdomain name>    <weight%>
Subdomain-1.2:<subdomain name>    <weight%>
Domain-2:<domain name>
Subdomain-2.1:<subdomain name>    <weight%>
...

Rules:
- Zero extra text.
- Weights MUST sum to 100 overall.
- Use official exam weights from the outline I uploaded.
- Four spaces between subdomain name and its weight percent.`;

  async function ingestDomainMappingFromGPT(logLabel, sendOpts = {}) {
    const timeoutMs = sendOpts.timeoutMs != null ? sendOpts.timeoutMs : 300000;
    const maxAttempts = sendOpts.maxAttempts != null ? sendOpts.maxAttempts : 3;
    const flags = sendOpts.flags && typeof sendOpts.flags === 'object' ? sendOpts.flags : {};
    log(logLabel || '🗺 Requesting strict domain + subdomain mapping...', 'info');
    const mappingResp = await sendToGPT(SG_STRICT_DOMAIN_MAPPING_PROMPT, timeoutMs, maxAttempts, flags);
    if (!/OUTLINE_CONFIRMED/i.test(mappingResp)) log('⚠ GPT did not confirm outline. Continuing with parse attempt.', 'warn');
    const parsed = parseDomainMapping(mappingResp);
    if (!parsed.domains.length) throw new Error('Could not parse any domains from GPT mapping response.');
    const mapCheck = validateDomainSubdomainCompleteness(parsed.domains);
    if (!mapCheck.ok) throw new Error(`Domain/subdomain mapping incomplete: ${mapCheck.problems.join(' | ')}`);
    domains = parsed.domains;
    saveObj(STORAGE_KEYS.DOMAINS, domains);
    persistMappingSnapshot('domain_mapping');
    renderDomains();
    log(`✔ Parsed ${domains.length} domain(s), ${parsed.totalSub} subdomain(s).`, 'ok');
    return parsed;
  }

  async function ingestPageAllocationFromGPT(logLabel, sendOpts = {}) {
    const timeoutMs = sendOpts.timeoutMs != null ? sendOpts.timeoutMs : 300000;
    const maxAttempts = sendOpts.maxAttempts != null ? sendOpts.maxAttempts : 3;
    const flags = sendOpts.flags && typeof sendOpts.flags === 'object' ? sendOpts.flags : {};
    log(logLabel || `📏 Allocating ${examConfig.totalPages} pages across domains + subdomains...`, 'info');
    const allocPrompt = buildPageAllocationPrompt(domains, examConfig.totalPages);
    const allocResp = await sendToGPT(allocPrompt, timeoutMs, maxAttempts, flags);
    const alloc = parsePageAllocation(allocResp, domains, examConfig.totalPages);
    applyPageAllocation(alloc);
    saveObj(STORAGE_KEYS.DOMAINS, domains);
    persistMappingSnapshot('page_alloc');
    renderDomains();
    log('✔ Page allocation applied.', 'ok');
  }

  /**
   * Fresh ChatGPT tab / 2nd+ Start Generation (after domain phase has started once):
   * outline confirm → domain map GPT → page alloc GPT → sample confirm → 3 GPT sample/FR passes → books + REFERENCE_CONFIRMED + coverage.
   * Does not re-post How-To / Why-Trust pages (those are Doc-only preamble).
   */
  async function runGptTabResyncWarmup(stageLabel) {
    const tag = stageLabel || 'GPT tab resync';
    log(`🔁 ${tag}: outline + domain/page mapping → FR sample pipeline → reference books + coverage...`, 'info');

    showStepNotify('Resync — Outline', 'Upload the exam outline in this GPT tab, then click "✓ Confirm Outline".');
    await waitForConfirm('outline');
    if (abortFlag) throw new Error('Aborted');
    hideStepNotify();

    await ingestDomainMappingFromGPT(`${tag}: domain map`, { timeoutMs: 240000, maxAttempts: 2, flags: { skipReferenceGuard: true } });
    await ingestPageAllocationFromGPT(`${tag}: page allocation`, { timeoutMs: 240000, maxAttempts: 2, flags: { skipReferenceGuard: true } });

    showStepNotify('Resync — Sample papers', 'Upload FR / past-paper PDFs in GPT, then click "✓ Confirm Sample Papers".');
    await waitForConfirm('samples');
    if (abortFlag) throw new Error('Aborted');
    hideStepNotify();

    await sendToGPT(
      `Confirm you have read the uploaded FREE-RESPONSE / exam sample materials. Reply exactly:
FR_SAMPLES_CONFIRMED

Then STOP — do not output anything else.`,
      120000,
      1,
      { skipReferenceGuard: true },
    );
    await autoDetectSampleMapping();

    showStepNotify('Resync — Reference books', 'Upload ALL reference PDFs in GPT, then click "✓ Confirm Books".');
    await waitForConfirm('books');
    if (abortFlag) throw new Error('Aborted');
    hideStepNotify();

    await sendToGPT(
      'All reference books have been uploaded in this chat. Read every uploaded reference fully and reply exactly: REFERENCE_CONFIRMED.',
      120000,
      2,
      { skipReferenceGuard: true },
    );
    await verifyReferenceCoverageOrStop(tag);
    hideStepNotify();
  }

  /** @deprecated — use {@link runGptTabResyncWarmup}; kept only for readability in logs. */
  async function runNewTabRehydratePhases(stageLabel) {
    await runGptTabResyncWarmup(stageLabel || 'resume sync');
  }

  function buildCoverageChecklistText(dArr) {
    const list = Array.isArray(dArr) ? dArr : [];
    if (!list.length) return 'Domain/Subdomain list unavailable.';
    return list.map((d, di) => {
      const dn = di + 1;
      const dName = String(d && d.name || '').trim() || `Domain-${dn}`;
      const subs = Array.isArray(d && d.subdomains) ? d.subdomains : [];
      const subLines = subs.map((s, si) => {
        const sn = `${dn}.${si + 1}`;
        const sName = String(s && s.name || '').trim() || `Subdomain-${sn}`;
        return `- Subdomain-${sn}: ${sName}`;
      }).join('\n');
      return `Domain-${dn}: ${dName}\n${subLines || '- (no subdomains listed)'}`;
    }).join('\n');
  }

  async function verifyReferenceCoverageOrStop(stageLabel) {
    log(`📚 ${stageLabel}: verifying reference coverage in current GPT tab...`, 'info');
    let verifyOK = false;
    let tries = 0;
    while (!verifyOK && !abortFlag && tries < 3) {
      tries++;
      const checklist = buildCoverageChecklistText(domains);
      const verifyResp = await sendToGPT(`List every reference book you currently have access to (title + author if possible).
Then cross-check EVERY domain and subdomain from this explicit checklist and say for each whether the reference data is COMPLETE, PARTIAL, or MISSING.

CHECKLIST (authoritative):
${checklist}

Return STRICT JSON only:
{
  "books": ["Book 1", "Book 2"],
  "coverage": [
    {"domain": "Domain-1", "subdomain": "Subdomain-1.1", "status": "COMPLETE|PARTIAL|MISSING", "notes": ""}
  ],
  "missing_any": true|false
}`);
      const verifyData = extractJSON(verifyResp);
      const missingFlag = isMissingAnyTrue(verifyData.missing_any);
      const missing = (verifyData.coverage || []).filter(c => {
        const st = String(c.status || '').toUpperCase();
        return st === 'MISSING';
      });
      if (!missingFlag) {
        verifyOK = true;
        log(`✔ ${stageLabel}: coverage verified (attempt ${tries}).`, 'ok');
      } else {
        const list = missing.length
          ? missing.map(m => `${m.domain} / ${m.subdomain}${m.notes ? ' — ' + m.notes : ''}`)
          : ['GPT reported missing_any=true. Upload missing reference(s).'];
        showStepNotify('Missing Reference Data', 'Upload missing book(s), then press Confirm.');
        await showBookPopup(list);
        hideBookPopup();
        hideStepNotify();
      }
    }
    if (!verifyOK) throw new Error(`${stageLabel}: coverage verification failed.`);
  }

  // ─────────────────────────────────────────────────────────────
  //  MASTER ORCHESTRATOR — this is what "Start Generation" runs
  // ─────────────────────────────────────────────────────────────
  async function startGeneration(opts) {
    if (currentState === STATE.RUNNING) return;
    // Fresh snapshot from storage (other tab, reload) before guards & resume
    loadCheckpointStateFromStorage();
    // Sync visible Apps URL / Doc ID / Secret into storage so Start uses what you see
    // (even if you forgot "Save Docs Config") and checkpoint reload does not clear fields.
    persistDocsConfigFromUI();

    // Guards
    if (!examConfig.examName)           { log('⚠ Set Exam Name first.', 'warn'); return; }
    if (!GM_getValue(STORAGE_KEYS.APPS_SCRIPT_URL, '') ||
        !GM_getValue(STORAGE_KEYS.DOC_ID, ''))
                                        { log('⚠ Enter Apps Script Web URL + Google Doc ID (or click Save Docs Config).', 'warn'); return; }
    if (!isOnGPT())                     { log('⚠ Open chatgpt.com — the orchestrator drives ChatGPT.', 'warn'); return; }

    abortFlag = false;
    pauseFlag = false;
    subjectRulesAcknowledged = false;
    // Strict mode: never proceed with unresolved reference gaps.
    refConfig.autoStopOnMissing = true;
    saveObj(STORAGE_KEYS.REF_CONFIG, refConfig);
    updateControlState({ desiredState: STATE.RUNNING });

    setUIState(STATE.RUNNING);
    setActiveGenerationLane('studyguide');

    // ── RESUME DETECTION ────────────────────────────────────────
    // If saved checkpoint says we're mid-run, skip every phase that's already done.
    const resume = resumeSummary();
    const skipTo = progress.phase && progress.phase !== 'idle' && progress.phase !== 'done';
    const optSkipWarmup = opts && opts.skipWarmup;
    const resumedMidPipeline = !!(progress.phase && progress.phase !== 'idle' && progress.phase !== 'done');
    if (skipTo) {
      log(`▶ Resuming from saved checkpoint: ${resume}`, 'info');
      notify('Resuming generation — skipping completed steps.');
    } else {
      log(`▶ Starting full generation pipeline for "${examConfig.examName}"...`, 'info');
      saveCheckpoint({ phase: 'rules', domainIdx: 0, subPhase: 'overview', overviewPage: 0, subIdx: 0, subPageDone: 0, practiceDone: 0 });
    }

    try {
      issueLog('info', 'pipeline_start', {
        exam: examConfig.examName || '',
        resume: !!skipTo,
        phase: progress.phase || 'idle',
        difficultyLevel: examConfig.difficultyLevel || '',
        freeResponseAvailable: !!examConfig.freeResponseAvailable,
      });

      if (!optSkipWarmup && resumedMidPipeline && progress.pipelineEnteredDomainOnce) {
        await runGptTabResyncWarmup('Start Generation — GPT tab resync');
        loadCheckpointStateFromStorage();
      }

      // 1) Inject master rules
      if (phaseBefore('rules') === false) {
        log('📜 Injecting master rules into GPT...', 'info');
        const ackResp = await sendToGPT(buildMasterRules());
        if (!/RULES\s+ACKNOWLEDGED/i.test(ackResp)) log('⚠ GPT did not acknowledge rules verbatim — continuing.', 'warn');
        else log('✔ GPT acknowledged rules.', 'ok');
        subjectRulesAcknowledged = true;
        saveCheckpoint({ phase: 'intro' });
      } else {
        log('⏭ Skip: rules already injected.', 'sys');
      }

      // 1b) Author Introduction page (front matter — no outline required)
      if (phaseBefore('intro') === false) {
        await generateAuthorIntroPage();
        saveCheckpoint({ phase: 'copyright' });
      } else {
        log('⏭ Skip: author introduction already written.', 'sys');
      }

      // 1c) Copyright page with Disclaimer
      if (phaseBefore('copyright') === false) {
        await generateCopyrightPage();
        saveCheckpoint({ phase: 'outline' });
      } else {
        log('⏭ Skip: copyright page already written.', 'sys');
      }

      // 2) Outline upload — popup prompting user to upload
      if (phaseBefore('outline') === false) {
        showStepNotify('Upload Exam Outline', 'Open ChatGPT + button, upload the outline PDF, then click "✓ Confirm Outline".');
        notify('Upload exam outline to ChatGPT now.');
        log('⏸ Waiting for outline upload + confirmation...', 'warn');
        await waitForConfirm('outline');
        if (abortFlag) throw new Error('Aborted');
        saveCheckpoint({ phase: 'how_to_use' });
      } else {
        log('⏭ Skip: outline already confirmed.', 'sys');
      }

      // 3) How-To-Use (outline in-chat; domain GPT not yet structural)
      if (phaseBefore('how_to_use') === false) {
        await generateHowToUsePage();
        saveCheckpoint({ phase: 'why_trust' });
      } else {
        log('⏭ Skip: how-to-use page already written.', 'sys');
      }

      // 4) Why-Trust page
      if (phaseBefore('why_trust') === false) {
        await generateWhyTrustPage();
        saveCheckpoint({ phase: 'mapping' });
      } else {
        log('⏭ Skip: why-trust page already written.', 'sys');
      }

      // 5) Domain mapping (GPT) — after How-To / Why-Trust pages
      if (phaseBefore('mapping') === false) {
        await ingestDomainMappingFromGPT('🗺 Requesting strict domain + subdomain mapping...', {});
        saveCheckpoint({ phase: 'alloc' });
      } else {
        log('⏭ Skip: domain mapping already done.', 'sys');
      }

      // 5b) Page allocation (GPT)
      if (phaseBefore('alloc') === false) {
        await ingestPageAllocationFromGPT(null, {});
        saveCheckpoint({ phase: 'samples' });
      } else {
        log('⏭ Skip: page allocation already committed.', 'sys');
      }

      // 6) Sample papers → confirm → GPT confirm + FR detect (three GPT touches)
      if (phaseBefore('samples') === false) {
        showStepNotify('Upload Sample Papers', 'Upload FREE-RESPONSE / past-paper PDFs in ChatGPT, then click "✓ Confirm Sample Papers" in Workflow.');
        notify('Upload sample papers to ChatGPT, then confirm in the panel.');
        log('⏸ Waiting for sample-paper upload + confirmation...', 'warn');
        await waitForConfirm('samples');
        if (abortFlag) throw new Error('Aborted');
        saveObj(STORAGE_KEYS.WORKFLOW, workflow);
        try { applyWorkflowUI(); } catch (_) {}
        hideStepNotify();
        saveCheckpoint({ phase: 'sample_mapping' });
      } else {
        log('⏭ Skip: samples phase already marked done.', 'sys');
      }

      // 6a) Sample-mapping detect
      if (phaseBefore('sample_mapping') === false) {
        log('🧩 Confirming uploads + detecting FREE-RESPONSE mapping...', 'info');
        await sendToGPT(`Confirm you have read the uploaded FREE-RESPONSE / exam sample materials. Reply exactly:
FR_SAMPLES_CONFIRMED

Then STOP — do not output anything else.`);
        await autoDetectSampleMapping();
        saveCheckpoint({ phase: 'books' });
      } else {
        log('⏭ Skip: sample mapping already done.', 'sys');
      }

      // 7) Upload reference books
      if (phaseBefore('books') === false) {
        showStepNotify('Upload Reference Books', 'Upload ALL reference book PDFs to ChatGPT, then click "✓ Confirm Books".');
        notify('Upload reference books to ChatGPT now.');
        log('⏸ Waiting for reference-book upload + confirmation...', 'warn');
        await waitForConfirm('books');
        if (abortFlag) throw new Error('Aborted');
        saveCheckpoint({ phase: 'verify' });
      } else {
        log('⏭ Skip: books already confirmed.', 'sys');
      }

      // 6) Coverage verification
      if (phaseBefore('verify') === false) {
        log('📚 Asking GPT to list uploaded books and verify coverage...', 'info');
        let verifyOK = false;
        let verifyTries = 0;
        while (!verifyOK && !abortFlag) {
        verifyTries++;
        const checklist = buildCoverageChecklistText(domains);
        const verifyResp = await sendToGPT(`List every reference book you currently have access to (title + author if possible).
Then cross-check EVERY domain and subdomain from this explicit checklist and say for each whether the reference data is COMPLETE, PARTIAL, or MISSING.

CHECKLIST (authoritative):
${checklist}

CRITICAL RULES:
- Do NOT fill gaps from your training data.
- Do NOT guess. Open each uploaded book's content panel and confirm before answering.
- If you cannot clearly locate a subdomain's content in the actual uploaded books, mark it MISSING — do not mark COMPLETE just because the topic feels familiar.
- Any MISSING subdomain will cause the orchestrator to pause and request a new reference book. Do not write generic content to avoid a pause — pausing is the CORRECT action.

Return STRICT JSON only:
{
  "books": ["Book 1", "Book 2"],
  "coverage": [
    {"domain": "Domain-1", "subdomain": "Subdomain-1.1", "status": "COMPLETE|PARTIAL|MISSING", "notes": ""}
  ],
  "missing_any": true|false
}`);
        const verifyData = extractJSON(verifyResp);
        const missingFlag = isMissingAnyTrue(verifyData.missing_any);
        const missing = (verifyData.coverage || []).filter(c => {
          const st = String(c.status || '').toUpperCase();
          return st === 'MISSING';
        });
        if (!missingFlag) {
          log(`✔ Coverage verified on attempt ${verifyTries}.`, 'ok');
          verifyOK = true;
        } else {
          const totalIssues = missing.length || 1;
          log(`⚠ missing_any=true from GPT. Prompting for new book (${totalIssues} item(s)).`, 'warn');
          showStepNotify('Missing Reference Data', `GPT reports missing_any=true. Upload the missing book(s).`);
          const list = missing.length
            ? missing.map(m => `${m.domain} / ${m.subdomain}${m.notes ? ' — ' + m.notes : ''}`)
            : ['GPT reported missing_any=true. Upload missing reference(s).'];
          await showBookPopup(list);
          hideBookPopup();
          if (abortFlag) throw new Error('Aborted');
          const missingChecklist = missing.length
            ? missing.map((m, i) => `${i + 1}. ${m.domain || 'Domain ?'} / ${m.subdomain || 'Subdomain ?'}${m.notes ? ` — ${m.notes}` : ''}`).join('\n')
            : '1. GPT reported missing_any=true but did not enumerate items. Re-evaluate full checklist.';
          // After user uploads, tell GPT to ingest
          await sendToGPT(`A new reference book has been uploaded. Read it fully.
Then re-check only these items:
${missingChecklist}

Reply STRICT JSON:
{
  "still_missing": [ {"domain":"","subdomain":"","notes":""} ]
}`);
          }
        }
        saveCheckpoint({
          phase: 'domain',
          domainIdx: 0,
          subPhase: 'overview',
          overviewPage: 0,
          subIdx: 0,
          subPageDone: 0,
          practiceDone: 0,
          pipelineEnteredDomainOnce: true,
        });
      } else {
        log('⏭ Skip: coverage already verified.', 'sys');
      }

      // 9) Per-domain generation — resume-aware
      const startDomain = Math.max(0, progress.domainIdx || 0);
      for (let di = startDomain; di < domains.length; di++) {
        if (abortFlag) break;
        const d = domains[di];
        const domainNum = di + 1;
        if (currentState === STATE.RUNNING) setActiveGenerationLane('studyguide');

        // If we're resuming mid-domain, keep existing subPhase; else reset.
        if (di !== startDomain) {
          saveCheckpoint({
            domainIdx: di, subPhase: 'overview',
            overviewPage: 0, subIdx: 0, subPageDone: 0, practiceDone: 0,
          });
        } else if (!progress.subPhase) {
          saveCheckpoint({ domainIdx: di, subPhase: 'overview', overviewPage: 0 });
        } else {
          saveCheckpoint({ domainIdx: di });
        }

        log(`🎯 ===== DOMAIN ${domainNum}: ${d.name} =====`, 'info');
        log(`   Resume plan: ${resumeSummary() || 'from start'}`, 'sys');

        if (subPhaseBefore('overview') === false) {
          await generateOverview(d, domainNum);
          saveCheckpoint({ subPhase: 'purpose' });
        } else log(`⏭ Skip overview (domain ${domainNum}).`, 'sys');

        if (subPhaseBefore('purpose') === false) {
          await generatePurposePage(d, domainNum);
          saveCheckpoint({ subPhase: 'target' });
        } else log(`⏭ Skip purpose (domain ${domainNum}).`, 'sys');

        if (subPhaseBefore('target') === false) {
          await generateSubdomainTable(d, domainNum);
          saveCheckpoint({ subPhase: 'memory' });
        } else log(`⏭ Skip target-covered table (domain ${domainNum}).`, 'sys');

        if (subPhaseBefore('memory') === false) {
          await generateMemoryTable(d, domainNum);
          saveCheckpoint({ subPhase: 'content', subIdx: 0, subPageDone: 0 });
        } else log(`⏭ Skip memory-check table (domain ${domainNum}).`, 'sys');

        if (subPhaseBefore('content') === false) {
          const subs = (d.subdomains && d.subdomains.length) ? d.subdomains : [];
          if (!subs.length) {
            throw new Error(`Domain ${domainNum} has no subdomains. Generation stopped to avoid missing/incomplete content.`);
          }
          const startSub = Math.max(0, progress.subIdx || 0);
          for (let si = startSub; si < subs.length; si++) {
            if (abortFlag) break;
            const sub = subs[si];
            const subNum = si + 1;
            const skipPages = (si === startSub) ? (progress.subPageDone || 0) : 0;
            saveCheckpoint({ subIdx: si, subPageDone: skipPages });
            log(`📘 Subdomain ${domainNum}.${subNum}: ${sub.name}${skipPages ? ` (resume from page ${skipPages+1})` : ''}`, 'info');
            await generateSubdomainContent(d, domainNum, sub, subNum, si === 0, skipPages);
            saveCheckpoint({ subIdx: si + 1, subPageDone: 0 });
          }
          saveCheckpoint({ subPhase: 'freeResponse', practiceDone: 0 });
        } else log(`⏭ Skip content (domain ${domainNum}).`, 'sys');

        if (abortFlag) break;

        if (subPhaseBefore('freeResponse') === false) {
          const qScale = getPlanningTargetQuestionsPerDomain(d);
          log(`➡ Domain ${domainNum} content complete. Entering Free-Response phase...`, 'info');
          if (examConfig.freeResponseAvailable) {
            await generateFreeResponseSectionForDomain(d, domainNum, qScale);
            log(`✔ Domain ${domainNum} Free-Response phase complete.`, 'ok');
          } else {
            log(`⏭ Free-response section skipped for Domain ${domainNum} (exam verification: no FR).`, 'sys');
          }
          saveCheckpoint({ subPhase: 'done', practiceDone: 0 });
          if (currentState === STATE.RUNNING) setActiveGenerationLane('studyguide');
        } else log(`⏭ Skip free-response (domain ${domainNum}).`, 'sys');

        // Do not force manual new-tab handoff between domains.
        // If user opens a fresh tab at any point, Start Generation resume flow
        // (books confirm + auto coverage check) handles continuation.
      }

      if (!abortFlag) {
        setUIState(STATE.IDLE);
        updateControlState({ desiredState: STATE.IDLE });
        log('🎉 Full generation pipeline complete!', 'ok');
        issueLog('info', 'pipeline_complete', { exam: examConfig.examName || '' });
        notify('StudyGuide generation complete!');
        saveCheckpoint({ phase: 'done' });
      }
    } catch (err) {
      setUIState(STATE.ERROR);
      updateControlState({ desiredState: STATE.ERROR });
      log(`✗ Orchestrator error: ${err.message}`, 'error', {
        kind: 'orchestrator',
        stack: err && err.stack ? String(err.stack) : '',
        phase: progress.phase || '',
        subPhase: progress.subPhase || '',
        domainIdx: progress.domainIdx,
      });
      log('ℹ Press Resume to continue from the last saved step.', 'warn');
      notify('Error — press Resume to continue.');
    }
  }

  // ── Phase comparators — return true if the already-saved phase is AFTER the given one ──
  const PHASE_ORDER = ['idle','rules','intro','copyright','outline','how_to_use','why_trust','mapping','alloc','samples','sample_mapping','books','verify','domain','done'];
  function phaseBefore(p) {
    const cur = PHASE_ORDER.indexOf(progress.phase || 'idle');
    const tgt = PHASE_ORDER.indexOf(p);
    return cur > tgt; // true = saved phase is already past `p` → skip it
  }

  const SUB_PHASE_ORDER = ['overview','purpose','target','memory','content','freeResponse','done'];
  function subPhaseBefore(p) {
    const cur = SUB_PHASE_ORDER.indexOf(progress.subPhase || 'overview');
    const tgt = SUB_PHASE_ORDER.indexOf(p);
    return cur > tgt;
  }

  function hasResumableCheckpointProgress(p) {
    if (!p) return false;
    const ph = p.phase || 'idle';
    if (ph === 'done') return false;
    if (ph && ph !== 'idle') return true;
    if ((+p.done || 0) > 0) return true;
    if ((+p.currentPage || 0) > 0) return true;
    return false;
  }

  /** Re-read Tampermonkey storage into globals so reload / new tab / other tab see the same run. */
  function loadCheckpointStateFromStorage() {
    progress = loadObj(STORAGE_KEYS.PROGRESS, DEFAULT_PROGRESS);
    if (progress.pipelineEnteredDomainOnce === undefined) {
      const ph = progress.phase || 'idle';
      progress.pipelineEnteredDomainOnce = ph === 'domain' || ph === 'done';
      saveObj(STORAGE_KEYS.PROGRESS, progress);
    }
    if ((progress.orchestratorSchema || 0) < 3) {
      const ph = progress.phase || 'idle';
      if (ph === 'mapping' || ph === 'alloc') progress.phase = 'how_to_use';
      progress.orchestratorSchema = 3;
      saveObj(STORAGE_KEYS.PROGRESS, progress);
    }
    if (progress.subPhase === 'practice') {
      progress.subPhase = 'freeResponse';
      progress.practiceDone = 0;
      saveObj(STORAGE_KEYS.PROGRESS, progress);
    }
    domains = loadObj(STORAGE_KEYS.DOMAINS, []);
    workflow = loadObj(STORAGE_KEYS.WORKFLOW, DEFAULT_WORKFLOW);
    examConfig = loadObj(STORAGE_KEYS.EXAM_CONFIG, DEFAULT_EXAM_CONFIG);
    practiceConfig = loadObj(STORAGE_KEYS.PRACTICE_CONFIG, DEFAULT_PRACTICE_CONFIG);
    sampleMapping = loadObj(STORAGE_KEYS.SAMPLE_MAPPING, DEFAULT_SAMPLE_MAPPING);
    sampleMappingMeta = loadObj(STORAGE_KEYS.SAMPLE_MAPPING_META, DEFAULT_SAMPLE_MAPPING_META);
    freeResponseMapping = (() => {
      const fb = loadObj(STORAGE_KEYS.FREE_RESPONSE_MAPPING, null);
      if (!fb || typeof fb !== 'object') return defaultFreeResponseMappingState();
      const pipe = fb.pipeline && typeof fb.pipeline === 'object' ? fb.pipeline : {};
      const mer = fb.merged && typeof fb.merged === 'object' ? fb.merged : {};
      const lastDom = fb.lastMergedFromDomain != null ? String(fb.lastMergedFromDomain) : '';
      return { pipeline: { ...pipe }, merged: { ...mer }, lastMergedFromDomain: lastDom };
    })();
    hydrateMappingSnapshotsFromStorage();
    try { applyWorkflowUI && applyWorkflowUI(); } catch (_) {}
    try { applyConfigsToUI && applyConfigsToUI({ includeDocs: false }); } catch (_) {}
    try { renderDomains && renderDomains(); } catch (_) {}
    try { renderSampleMapping && renderSampleMapping(); } catch (_) {}
    try { updateProgressUI && updateProgressUI(); } catch (_) {}
  }

  // ─────────────────────────────────────────────────────────────
  //  DOMAIN-MAPPING PARSER (strict format)
  // ─────────────────────────────────────────────────────────────
  function parseDomainMapping(text) {
    const out = { domains: [], totalSub: 0 };
    const lines = text.split(/\r?\n/);
    let currentDomain = null;
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      const dMatch = line.match(/^Domain-(\d+)\s*:\s*(.+)$/i);
      const sMatch = line.match(/^Subdomain-(\d+)\.(\d+)\s*:\s*(.+?)(?:\s{2,}|\t+)(\d+(?:\.\d+)?)\s*%?$/i)
                  || line.match(/^Subdomain-(\d+)\.(\d+)\s*:\s*(.+?)\s+(\d+(?:\.\d+)?)\s*%?$/i);
      if (dMatch) {
        currentDomain = { name: dMatch[2].trim(), weight: 0, subdomains: [] };
        out.domains.push(currentDomain);
      } else if (sMatch && currentDomain) {
        const subName = sMatch[3].trim();
        const weight  = parseFloat(sMatch[4]) || 0;
        currentDomain.subdomains.push({ name: subName, weight });
        currentDomain.weight += weight;
        out.totalSub++;
      } else if (/^Subdomain-/i.test(line) && currentDomain) {
        // no weight specified
        const bare = line.match(/^Subdomain-\d+\.\d+\s*:\s*(.+)$/i);
        if (bare) {
          currentDomain.subdomains.push({ name: bare[1].trim(), weight: 0 });
          out.totalSub++;
        }
      }
    }
    return out;
  }

  function validateDomainSubdomainCompleteness(dArr) {
    const problems = [];
    const list = Array.isArray(dArr) ? dArr : [];
    if (!list.length) problems.push('No domains found.');
    list.forEach((d, i) => {
      const dn = i + 1;
      const dName = String(d && d.name || '').trim();
      const subs = Array.isArray(d && d.subdomains) ? d.subdomains : [];
      if (!dName) problems.push(`Domain-${dn} name is missing.`);
      if (!subs.length) problems.push(`Domain-${dn} has no subdomains.`);
      subs.forEach((s, j) => {
        const sn = `${dn}.${j + 1}`;
        const sName = String(s && s.name || '').trim();
        if (!sName) problems.push(`Subdomain-${sn} name is missing.`);
      });
    });
    return { ok: problems.length === 0, problems };
  }

  function validateCoverageMatrix(coverageArr, dArr) {
    const issues = [];
    const cov = Array.isArray(coverageArr) ? coverageArr : [];
    const wanted = [];
    (Array.isArray(dArr) ? dArr : []).forEach((d, di) => {
      const dName = String(d && d.name || '').trim().toLowerCase();
      const subs = Array.isArray(d && d.subdomains) ? d.subdomains : [];
      subs.forEach((s, si) => {
        wanted.push({
          dn: di + 1,
          sn: si + 1,
          domain: dName,
          sub: String(s && s.name || '').trim().toLowerCase(),
        });
      });
    });
    wanted.forEach(w => {
      const hit = cov.find(c => {
        const cd = String(c && c.domain || '').trim().toLowerCase();
        const cs = String(c && c.subdomain || '').trim().toLowerCase();
        return (!!w.domain && (cd === w.domain || cd.includes(w.domain) || w.domain.includes(cd))) &&
               (!!w.sub && (cs === w.sub || cs.includes(w.sub) || w.sub.includes(cs)));
      });
      if (!hit) {
        issues.push(`Coverage missing entry for Domain-${w.dn} / Subdomain-${w.dn}.${w.sn}`);
        return;
      }
      const st = String(hit.status || '').toUpperCase();
      if (st !== 'COMPLETE') {
        issues.push(`Coverage not COMPLETE for Domain-${w.dn} / Subdomain-${w.dn}.${w.sn} (status=${st || 'UNKNOWN'})`);
      }
    });
    return { ok: issues.length === 0, issues };
  }

  function isMissingAnyTrue(v) {
    if (v === true) return true;
    const s = String(v == null ? '' : v).trim().toLowerCase();
    return s === 'true' || s === '1' || s === 'yes';
  }

  // ─────────────────────────────────────────────────────────────
  //  PAGE ALLOCATION — commit GPT to exact page counts per sub-domain
  // ─────────────────────────────────────────────────────────────
  function buildPageAllocationPrompt(dArr, totalPages) {
    const block = dArr.map((d, i) => {
      const num = i + 1;
      const subs = (d.subdomains || []).map((s, j) =>
        `  Subdomain-${num}.${j+1}:${s.name}    ${(s.weight || 0).toFixed(1)}%`
      ).join('\n');
      return `Domain-${num}:${d.name}    ${(d.weight || 0).toFixed(1)}%\n${subs}`;
    }).join('\n');

    return `PAGE ALLOCATION — commit to exact page counts.

Total pages to produce: ${totalPages}
Domains + subdomains + weights (already detected):
${block}

TASK:
Assign EXACT page counts so:
  - The SUM of all Subdomain pages = ${totalPages} (no more, no less).
  - Each Domain's page count = sum of its Subdomain pages.
  - Page counts are proportional to each Subdomain's weight.
  - Minimum of 1 page per subdomain.

REPLY FORMAT — STRICT, NO EXTRA TEXT, NO COMMENTARY:
Domain-1:<name>    <pages>p
Subdomain-1.1:<name>    <pages>p
Subdomain-1.2:<name>    <pages>p
Domain-2:<name>    <pages>p
Subdomain-2.1:<name>    <pages>p
...

Use exactly "<N>p" after the four spaces (e.g. "12p"). First line MUST match the above pattern. Do not output anything else.`;
  }

  function parsePageAllocation(text, dArr, totalPages) {
    // Returns { domains: [{idx, pages}], subs: {"d.s": pages} }
    const subs = {};
    const dpages = {};
    const lines = (text || '').split(/\r?\n/);
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      let m = line.match(/^Domain-(\d+)\s*:\s*.+?(?:\s{2,}|\t+)(\d+)\s*p$/i);
      if (m) { dpages[+m[1]] = parseInt(m[2], 10); continue; }
      m = line.match(/^Subdomain-(\d+)\.(\d+)\s*:\s*.+?(?:\s{2,}|\t+)(\d+)\s*p$/i);
      if (m) { subs[`${m[1]}.${m[2]}`] = parseInt(m[3], 10); continue; }
      // Tolerate single-space separators
      m = line.match(/^Subdomain-(\d+)\.(\d+)\s*:\s*.+?\s+(\d+)\s*p$/i);
      if (m) { subs[`${m[1]}.${m[2]}`] = parseInt(m[3], 10); }
    }

    // Fallback: if GPT didn't return a usable allocation, distribute evenly by weight.
    const subCount = dArr.reduce((s, d) => s + (d.subdomains || []).length, 0);
    if (Object.keys(subs).length === 0 && subCount > 0) {
      log('⚠ GPT did not return allocation — distributing by weight locally.', 'warn');
      const totalWeight = dArr.reduce((s, d) => s + (d.weight || 0), 0) || 100;
      dArr.forEach((d, di) => {
        const subsArr = d.subdomains || [];
        const subWeightSum = subsArr.reduce((s, sd) => s + (sd.weight || 0), 0) || subsArr.length;
        subsArr.forEach((sd, si) => {
          const share = (d.weight || 0) / totalWeight *
                        ((sd.weight || 1) / subWeightSum);
          subs[`${di+1}.${si+1}`] = Math.max(1, Math.round(share * totalPages));
        });
      });
    }

    // Normalize so the total exactly matches totalPages
    let assigned = Object.values(subs).reduce((a, b) => a + b, 0);
    if (assigned !== totalPages && Object.keys(subs).length) {
      const keys = Object.keys(subs);
      // Sort by largest first to absorb the delta
      keys.sort((a, b) => subs[b] - subs[a]);
      let delta = totalPages - assigned;
      let idx = 0;
      while (delta !== 0 && keys.length > 0) {
        const k = keys[idx % keys.length];
        if (delta > 0) { subs[k] += 1; delta -= 1; }
        else if (subs[k] > 1) { subs[k] -= 1; delta += 1; }
        idx++;
        if (idx > 10000) break; // safety
      }
    }

    // Recompute domain pages from subs
    dArr.forEach((_, di) => {
      dpages[di + 1] = 0;
      (dArr[di].subdomains || []).forEach((_, si) => {
        dpages[di + 1] += subs[`${di+1}.${si+1}`] || 0;
      });
    });

    return { subs, dpages };
  }

  function applyPageAllocation(alloc) {
    if (!alloc || !alloc.subs) return;
    let pageCursor = 1;
    const totalPages = examConfig.totalPages;
    domains.forEach((d, di) => {
      d.pages = alloc.dpages[di + 1] || 0;
      d.startPage = pageCursor;
      (d.subdomains || []).forEach((sd, si) => {
        sd.pages = alloc.subs[`${di+1}.${si+1}`] || 1;
        sd.startPage = pageCursor;
        sd.endPage   = pageCursor + sd.pages - 1;
        pageCursor = sd.endPage + 1;
      });
      d.endPage = pageCursor - 1;
    });
    const assigned = pageCursor - 1;
    log(`📐 Page allocation: ${assigned} / ${totalPages} pages committed.`, assigned === totalPages ? 'ok' : 'warn');
    domains.forEach((d, i) => {
      log(`   Domain ${i+1}: "${d.name}" → ${d.pages}p (p${d.startPage}–${d.endPage})`, 'sys');
      (d.subdomains || []).forEach((sd, j) => {
        log(`     ${i+1}.${j+1} "${sd.name}" → ${sd.pages}p (p${sd.startPage}–${sd.endPage})`, 'sys');
      });
    });
  }

  const STYLE_RULES = `
WRITING STYLE:
- Use uploaded references only; no fabrication
- Professional neutral tone; no author/student narration
- Use specific ### topic headings (avoid generic headings)
- Write complete concept explanations with short Example and Purpose endings
- English only
- If source is missing, output: REFERENCE_NOT_FOUND: <topic>
`;
  const MARKUP_CONTRACT = `
MARKUP:
- Headings: #Domain, ##Subdomain, ###Topic
- Prose paragraphs wrapped with: $C ... $C
- Tables in markdown pipe format
- Use $$...$$ for display equations/reactions
- Use DISPLAY blocks for worked examples/formulas/exercises
- Figures format:
  [FIGURE: title]
  description
  [/FIGURE]
- Last line of content page:
  SOURCE: <Book Title> | Chapter: <chapter> | Pages: <range>
`;

  // ─────────────────────────────────────────────────────────────
  //  CONTENT GENERATORS
  // ─────────────────────────────────────────────────────────────
  async function generateOverview(domain, domainNum) {
    log(`📖 Overview for ${domain.name} (2 pages × ~500 words, heading only, no sub-headings)...`, 'info');
    const subNames = (domain.subdomains || []).map(s => s.name).join(', ');
    const skip = Math.max(0, progress.overviewPage || 0);
    for (let p = skip + 1; p <= 2; p++) {
      if (abortFlag) return;
      const firstPageHeader = (p === 1)
        ? `#Domain-${domainNum}:${domain.name}\n#Overview\n\n`
        : '';
      const prompt = `Write OVERVIEW page ${p} of 2 for Domain-${domainNum}: "${domain.name}".

CONTENT SCOPE:
- Synthesize the core concepts of this whole domain and ALL its subdomains (${subNames}) into flowing prose.
- Explain what the domain as a whole is about and how its sub-areas connect together.

${STYLE_RULES}
${MARKUP_CONTRACT}

STRUCTURE RULES:
- Target ~500 words on this page.
- Paragraphs: ${examConfig.minLinesPerPara}–${examConfig.maxLinesPerPara} lines each, ending with a short "Example:" sentence.
- ${p === 1
    ? `Begin with exactly:\n${firstPageHeader}Then only running paragraphs. Do NOT add any extra # or ## headings after these two lines.`
    : `Do NOT emit any heading whatsoever. Continue the overview seamlessly from the previous page. Plain paragraphs only.`}
- Absolutely NO sub-section headings, NO bullet lists, NO tables.

Reply with the page content only.`;
      await runAndPostPage({
        promptText: prompt,
        label:      `overview_d${domainNum}_p${p}`,
        allowImages:true,
      });
      saveCheckpoint({ overviewPage: p });
    }
    saveCheckpoint({ overviewPage: 0 }); // reset for next domain
  }

  async function generatePurposePage(domain, domainNum) {
    log(`🎯 Main Purpose page for ${domain.name} (~600 words, heading only)...`, 'info');
    const prompt = `Write the MAIN PURPOSE page for Domain-${domainNum}: "${domain.name}".

CONTENT SCOPE:
- Explain, in flowing prose, why this domain exists, what problems it solves, and what overall outcomes its study is meant to achieve.

${STYLE_RULES}
${MARKUP_CONTRACT}

STRUCTURE RULES:
- Begin with exactly:
#Main Purpose

- After that, ONLY running paragraphs — absolutely NO other headings, NO bullet lists, NO tables.
- Target ~600 words on this single page.
- Paragraphs: ${examConfig.minLinesPerPara}–${examConfig.maxLinesPerPara} lines each, ending with a short "Example:" sentence.

Reply with the page content only.`;
    await runAndPostPage({
      promptText: prompt,
      label:      `purpose_d${domainNum}`,
      allowImages:true,
    });
  }

  async function generateSubdomainTable(domain, domainNum) {
    log(`📊 Target Covered table for ${domain.name}...`, 'info');
    const subList = (domain.subdomains || []).map((s, i) => `${domainNum}.${i+1} ${s.name}`).join(' | ');
    const prompt = `Produce a single markdown section titled "#Target Covered" for Domain-${domainNum}: "${domain.name}".

CONTENT:
- A markdown TABLE listing, for every subdomain of this domain (${subList}), what is covered inside it and to what depth.
- Columns: | # | Subdomain | What is covered | Depth of coverage |
- "What is covered" = 1–2 sentence summary of the concrete topics, mechanisms and skills inside that subdomain.
- "Depth of coverage" = one of: Foundational / Intermediate / Advanced — plus a very short reason.

${STYLE_RULES}
${MARKUP_CONTRACT}

STRICT FORMAT:
- ONLY the "#Target Covered" heading at the top, then the table.
- NO other headings. NO prose outside the table. NO bullet lists.

Return the markdown only.`;
    await runAndPostPage({
      promptText: prompt,
      label:      `target_covered_d${domainNum}`,
      allowImages:false,
    });
  }

  async function generateMemoryTable(domain, domainNum) {
    log(`🧠 Memory Check table for ${domain.name}...`, 'info');
    const prompt = `Produce a single markdown section titled "#Memory Check" for Domain-${domainNum}: "${domain.name}".

CONTENT:
- A markdown TABLE of 10–20 of the most important key terms, shortcuts, acronyms, and mnemonics of this whole domain.
- Columns: | # | Term / Shortcut | 1-line definition |
- Each definition must be a single, self-contained line that is enough to recall the concept.

${STYLE_RULES}
${MARKUP_CONTRACT}

STRICT FORMAT:
- ONLY the "#Memory Check" heading at the top, then the table.
- NO other headings. NO prose outside the table. NO bullet lists.

Return the markdown only.`;
    await runAndPostPage({
      promptText: prompt,
      label:      `memory_check_d${domainNum}`,
      allowImages:false,
    });
  }

  // ─────────────────────────────────────────────────────────────
  //  FRONT-MATTER GENERATORS
  //  Intro → Copyright → How-To-Use → Why-Trust (book preamble)
  // ─────────────────────────────────────────────────────────────
  async function generateAuthorIntroPage() {
    log(`✍ Author Introduction page (1 page × 450–500 words)...`, 'info');
    const prompt = `Write the AUTHOR INTRODUCTION page for the study guide "${examConfig.examName}".

LENGTH:
- 450–500 words.

HEADING:
#Author Introduction

VOICE & TONE:
- Strictly third person.
- No first-person or reader address.
- No personal names or identifiable biography.
- Formal, authoritative, academic publishing tone.

PURPOSE:
- Present a highly experienced lead academic expert supported by a specialised team.
- Emphasise subject mastery in ${examConfig.examName} and deep familiarity with ${examConfig.examName} exam standards.
- Highlight strong professional achievements such as:
  - extensive experience in teaching and assessment design
  - consistent success in preparing students for high-stakes examinations
  - expertise in curriculum development and exam-focused content creation
  - contribution to structured academic learning resources

CONTENT REQUIREMENTS:
- Opening paragraph MUST be specific to ${examConfig.examName}, reflecting exam rigor, analytical depth, and real-world application.
- Clearly show collaboration between the lead expert and a specialised academic team.
- Emphasise expertise in the core subject areas, analytical methods, and exam strategy relevant to ${examConfig.examName}.
- Reflect a structured, results-driven pedagogical approach focused on clarity, precision, and exam readiness.
- Maintain varied sentence structure to avoid a generic or templated tone.

CONSTRAINTS:
- Plain prose only.
- No lists, no tables, no extra headings.
- Only include "#Author Introduction" at the top.
- Do NOT include any source line.

Write now.`;
    await runAndPostPage({ promptText: prompt, label: 'front_author_intro', allowImages: false });
  }

  async function generateCopyrightPage() {
    log(`©  Copyright page (1 page × 450–500 words) with Disclaimer...`, 'info');
    const prompt = `Write the COPYRIGHT page for the study guide of "${examConfig.examName}".

LENGTH:
- Exactly 450–500 words total.

HEADING (exactly):
#Copyright

CONTENT — in this order, as natural flowing paragraphs (NOT bulleted):
1. Standard copyright notice (current year, professional educational-publisher language, reservation of rights).
2. Permissions and restrictions on reproduction, distribution, and derivative works.
3. Trademark and intellectual-property statement relevant to the exam subject.
4. Accuracy statement (best-effort preparation, periodic revision, no guarantee of exam outcome).
5. Attribution to reference materials used, without naming specific authors or publishers.
6. Contact / permissions-request paragraph (generic — no real email or address).

FINAL TWO LINES — EXACTLY:
- The PENULTIMATE line must be the bolded label (use markdown bold):
  **DISCLAIMER**
- The FINAL line(s) must be a tailored disclaimer specific to "${examConfig.examName}":
   - Name the exam explicitly.
   - State that this study guide is an independent educational work, not affiliated with, endorsed by, or sponsored by the exam's governing body.
   - State that passing the exam depends on the candidate's own preparation and judgement.
   - Keep this disclaimer concise (2–4 sentences) and exam-specific.

VOICE:
- Formal publishing tone. Third person. No personal voice. No casual language.

${MARKUP_CONTRACT}

CONSTRAINTS:
- No tables, no figures, no code.
- Do NOT include a SOURCE line.

Write the page now.`;
    await runAndPostPage({ promptText: prompt, label: 'front_copyright', allowImages: false });
  }

  async function generateHowToUsePage() {
    log(`📘 "How to Use This Book" page (1 page × 450–500 words)...`, 'info');
    const prompt = `Write the "HOW TO USE THIS BOOK" page for the study guide of "${examConfig.examName}".

LENGTH:
- Exactly 450–500 words.

HEADING (exactly):
#How to Use This Book

CONTENT:
- Explain the structure of the study guide: domains, subdomains, topic pages, tables, memory checks, plus any free-response style review material included in this book where applicable.
- Explain how a candidate should progress — reading order, using the purpose and target-covered tables, using memory-check tables for revision, and applying structured drills or external question banks suited to "${examConfig.examName}".
- Explain how to interpret images, figures, equations, and reactions when they appear.
- Explain a recommended study cadence tied to the difficulty of "${examConfig.examName}" (e.g. weekly domain blocks, revision sprints, spaced review). Tailor specifics to this exam's nature.
- End with a short paragraph reinforcing disciplined, reference-grounded study.

VOICE:
- Third person. Formal, instructive, exam-publishing tone. No "you".
- Paragraphs ${examConfig.minLinesPerPara}–${examConfig.maxLinesPerPara} lines each.

${MARKUP_CONTRACT}

CONSTRAINTS:
- Plain prose. One short numbered list (up to 5 items) is allowed if it improves clarity, but prose is preferred.
- No figures, no code, no math, no tables.
- Do NOT include a SOURCE line.

Write the page now.`;
    await runAndPostPage({ promptText: prompt, label: 'front_how_to_use', allowImages: false });
  }

  async function generateWhyTrustPage() {
    log(`🛡  "Why Trust This Study Guide" page (1 page × 450–500 words)...`, 'info');
    const prompt = `Write the "WHY TRUST THIS STUDY GUIDE" page for the study guide of "${examConfig.examName}".

LENGTH:
- Exactly 450–500 words.

HEADING (exactly):
#Why Trust This Study Guide

CONTENT:
- Explain why a candidate preparing for "${examConfig.examName}" can rely on this book.
- Cover measurable signals of quality: alignment with the official exam outline and weightings, grounding in authoritative reference texts, structured domain-by-domain coverage, integrated memory-check tables, alignment between content structure and measurable sample or outline signals where available, and methodology for iterative quality review.
- Convey the depth of subject-matter preparation, the academic-team collaboration, and the commitment to ongoing accuracy revisions.
- Communicate outcomes focus — designed to move a candidate from concept familiarity to exam readiness.
- Avoid naming any individual author, company, publisher or brand. Avoid vague marketing phrases ("the best in the industry"). Keep it concrete and evidence-based.

VOICE:
- Third person, confident, scholarly. No first-person, no direct reader address.

${MARKUP_CONTRACT}

CONSTRAINTS:
- Plain prose only. No tables, no figures, no code.
- Do NOT include a SOURCE line.

Write the page now.`;
    await runAndPostPage({ promptText: prompt, label: 'front_why_trust', allowImages: false });
  }

  async function generateSubdomainContent(domain, domainNum, sub, subNum, isFirstSubOfDomain, skipPages = 0) {
    const pagesForSub = Math.max(
      1,
      parseInt(sub.pages, 10) ||
        Math.round(((sub.weight || 0) / 100) * examConfig.totalPages)
    );
    const subStart = sub.startPage || '?';
    const subEnd   = sub.endPage   || '?';
    log(`📄 ${pagesForSub} page(s) for Subdomain-${domainNum}.${subNum}: ${sub.name} (p${subStart}–${subEnd})${skipPages ? ` — resuming at page ${skipPages+1}` : ''}`, 'info');

    for (let p = Math.max(1, skipPages + 1); p <= pagesForSub; p++) {
      if (abortFlag) return;
      const absPage = (sub.startPage || 0) + p - 1;
      const headingBlock = (p === 1)
        ? `##Subdomain-${domainNum}.${subNum}:${sub.name}\n\n`
        : '';
      const prompt = `Content page ${p}/${pagesForSub} for Subdomain-${domainNum}.${subNum}: "${sub.name}" (of Domain-${domainNum}: "${domain.name}").
Absolute book page: ${absPage} of ${examConfig.totalPages}.

${STYLE_RULES}
${MARKUP_CONTRACT}

STRUCTURE RULES:
- Target ~${examConfig.wordsPerPage} words on this page.
- Paragraphs: ${examConfig.minLinesPerPara}–${examConfig.maxLinesPerPara} lines each. Every paragraph MUST end with one short "Example:" sentence and one short "Purpose:" sentence.
- Use ### headings ONLY for specific, concrete, unique topic names (e.g. "###TCP Three-Way Handshake", "###Osmotic Pressure in Isotonic Solutions"). ABSOLUTELY NO generic names: "Introduction", "Overview", "Key Points", "Summary", "Conclusion", "Background", "Basics" are BANNED.
      - HEADING HIERARCHY IS FIXED: #Domain (only on first page of domain), ##Subdomain (only on first page of subdomain), ###Specific Topic (only when introducing a new topic — NEVER repeat a heading that already appeared in this entire domain).
      - NO heading of any level (# ## ###) may appear more than ONCE across the entire study guide. Track and avoid all previously used headings.
      - NO bold text (**text**) used as a heading substitute. Bold is ONLY for key terms inside prose.
      - ALL subheadings must be inside ### three symbols — nothing beyond ### is allowed.
- TABLES: if the reference material on this topic naturally contains a comparative/structured data table (drug list, properties, values, protocol comparison, taxonomy, etc.), you MUST include at least one markdown table on this page. Skip the table only if the topic is purely narrative.
- **DISPLAY** BLOCKS (MANDATORY for any long equation, worked example, reaction, formula block, or exercise on this page): follow MARKUP CONTRACT §2b. Introduce the idea in prose; then, on new lines, **DISPLAY — Worked example** (or **DISPLAY — Formula / identity** / **DISPLAY — Chemical reaction** / **DISPLAY — Exercises (questions)**, etc.) and put the book-style material there — never a single undifferentiated wall of text.
${isMathExamName(examConfig.examName) ? '- MATH-HEAVY EXAM: every page with formulas MUST use at least one **DISPLAY — Formula / identity** and at least one **DISPLAY — Exercises (questions)** or **DISPLAY — Worked example** in true textbook layout (explanation in prose, math in blocks).' : ''}
${p === 1
  ? `- BEGIN the response with exactly this heading block:\n${headingBlock}`
  : `- Continue from the previous page. Do NOT repeat any # or ## headings. Start directly with a fresh ### specific-topic heading.`}

Reply with the page content only.`;
      await runAndPostPage({
        promptText: prompt,
        label:      `d${domainNum}_s${subNum}_p${p}`,
        allowImages:true,
      });
      saveCheckpoint({ subPageDone: p });
    }
  }

  // ─────────────────────────────────────────────────────────────
  //  PAGE RUNNER (send prompt, post, images, stats)
  // ─────────────────────────────────────────────────────────────
  async function runAndPostPage({ promptText, label, allowImages }) {
    // Pause / abort support
    while (pauseFlag) { await sleep(400); if (abortFlag) return; }
    if (abortFlag) return;

    progress.currentPage++;
    updateProgressUI();

    // Reference reminder every N pages
    if (refConfig.reminderEveryPages > 0 &&
        progress.done > 0 &&
        (progress.done % refConfig.reminderEveryPages === 0)) {
      await sendReferenceReminder();
    }

    try {
      const lbl = String(label || '').trim();
      const enforceRefGuardForThisPage =
        /^d\d+_s\d+_p\d+$/i.test(lbl) ||
        lbl.startsWith('overview_d') ||
        lbl.startsWith('purpose_d') ||
        lbl.startsWith('target_covered_d') ||
        lbl.startsWith('memory_check_d');
      let raw = await sendToGPT(promptText, 300000, 3, { forceReferenceGuard: enforceRefGuardForThisPage });

      // Missing-reference loop: GPT returned "REFERENCE_NOT_FOUND: <topic>".
      // Show the book popup so the user can upload the missing book, tell GPT
      // to ingest it, then re-send the same prompt. Up to 3 attempts.
      let missingAttempts = 0;
      while (detectMissingReference(raw) && !abortFlag && missingAttempts < 3) {
        missingAttempts++;
        const topicMatch = raw.match(/REFERENCE_NOT_FOUND\s*:\s*([^\n]+)/i);
        const missingTopic = topicMatch ? topicMatch[1].trim() : `(page ${label})`;
        log(`⚠ GPT reports REFERENCE_NOT_FOUND for "${missingTopic}" (attempt ${missingAttempts}/3). Draggable card — add book in ChatGPT, then Confirm to verify.`, 'warn');
        showStepNotify('Reference needed (runner keeps state)', `Topic: ${missingTopic} — use the card or upload in ChatGPT, then Confirm.`);
        await showBookPopup([`REFERENCE_NOT_FOUND: ${missingTopic}`]);
        hideBookPopup();
        hideStepNotify();
        if (abortFlag) return;
        await verifyReferenceCoverageOrStop(`mid-generation ${label}`);

        // Tell GPT a new book was uploaded and ask it to ingest + retry
        try {
          await sendToGPT(`A new reference book has just been uploaded. Read it fully. Then regenerate the previous page — referring to the new book if it now contains the required content. If the topic is STILL missing, emit REFERENCE_NOT_FOUND: <topic> again.`);
        } catch (_) {}
        raw = await sendToGPT(promptText, 300000, 3, { forceReferenceGuard: enforceRefGuardForThisPage });
      }

      if (detectMissingReference(raw)) {
        // Hard-stop: never allow incomplete subdomain content to pass.
        log(`✗ Still missing reference after ${missingAttempts} attempts — stopping ${label}.`, 'error');
        progress.skipped++;
        saveObj(STORAGE_KEYS.PROGRESS, progress);
        updateProgressUI();
        throw new Error(`Content incomplete for ${label}: unresolved reference gap`);
      }

      let text = raw;
      if (refConfig.validateQuality && !validateQuality(text)) {
        log(`↺ Quality failed for ${label} — retrying once.`, 'warn');
        progress.retries++;
        updateProgressUI();
        text = await sendToGPT(
          promptText + '\n\nRewrite the page — previous response failed quality rules.',
          300000,
          3,
          { forceReferenceGuard: enforceRefGuardForThisPage },
        );
      }
      if (refConfig.stripSourceMentions) text = stripSourceMentions(text);
      text = normalizeOutboundContent(text);
      text = tagContentParagraphs(text);

      const wordCount = countWords(text);

      // Ask GPT whether this page needs images
      // Ask GPT whether this page needs images
      // RULE: Overview, Purpose, Target-Covered, Memory-Check pages NEVER get images
      const NO_IMAGE_LABELS = ['overview_d', 'purpose_d', 'target_covered_d', 'memory_check_d'];
      const isNoImagePage = NO_IMAGE_LABELS.some(prefix => (label || '').startsWith(prefix));
      const pageNoForSection = progress.currentPage;
      let images = [];
      let imagePrompts = [];
      if (isNoImagePage) {
        log(`🚫 Image skipped (no-image page type): ${label}`, 'sys');
      } else if (allowImages) {
        imagePrompts = await maybeGenerateImagesForPage(text, label);
        if (imagePrompts.length) {
          log(`📝 GPT generated ${imagePrompts.length} image prompt(s) for ${label} (generation-only, no image render wait).`, 'img');
        }
      }

      await postPageToDoc({ page: pageNoForSection, text, images: [], wordCount, label });
      if (imagePrompts.length) {
        await postImagePlaceholdersToDoc({
          prompts: imagePrompts,
          page: pageNoForSection,
          label,
          wordCount,
        });
      }
      progress.done++;
      progress.words += wordCount;
      if (imagePrompts.length) progress.images += imagePrompts.length;
      pushRecent(progress.currentPage, 'ok', `${label} · ${wordCount}w · placeholders:${imagePrompts.length} · ${images.length}🖼`);
      log(`✔ ${label} done (${wordCount}w, placeholders:${imagePrompts.length}, ${images.length} img).`, 'ok');
    } catch (err) {
      progress.failed++;
      pushRecent(progress.currentPage, 'fail', `${label}: ${err.message}`);
      log(`✗ ${label} failed: ${err.message}`, 'error');
      saveObj(STORAGE_KEYS.PROGRESS, progress);
      updateProgressUI();
      throw err; // do not advance orchestrator / checkpoint on failed Doc post
    }
    saveObj(STORAGE_KEYS.PROGRESS, progress);
    updateProgressUI();
  }

  // ─────────────────────────────────────────────────────────────
  //  IMAGE CHECK — ask GPT if page needs images + detail prompts
  // ─────────────────────────────────────────────────────────────
  async function maybeGenerateImagesForPage(pageText, label) {
    try {
      // Exam-type-driven override: if verification told us this exam needs
      // every page to have a visual, force the image prompt even if GPT
      // would otherwise say "no image needed".
      const freq = (examConfig.imageFrequency || 'smart').toLowerCase();
      const forceAlways = freq === 'every_page';
      const skipAll     = freq === 'never';
      if (skipAll) return [];

      const instr = forceAlways
        ? `This exam has image_frequency=every_page. You MUST return needs_image:true with at least ONE textbook-style image prompt that fits the page content. Never return needs_image:false.`
        : `Include an image prompt ONLY if the page truly requires a diagram / chart / anatomical figure / chemical structure / circuit diagram to be understood. Otherwise return needs_image:false with prompts:[].`;

      const figureBase = Math.max(0, parseInt(progress.images || 0, 10));
      const figureHint = figureBase > 0
        ? `The study guide already has ${figureBase} figure(s) before this page.`
        : `This page will be the first figure(s) in the study guide.`;

      const checkResp = await sendToGPT(`Analyse the page you just wrote for "${label}" in the study guide of "${examConfig.examName}".

TASK: Determine if this page needs a visual diagram or figure.

CRITICAL IMAGE RULES:
- The image prompt you write MUST be based EXCLUSIVELY on the content of the uploaded study guide reference books for "${examConfig.examName}".
- The image must reflect the EXACT topic, terminology, labels, and structure as described in those reference books — not generic internet or training-data visuals.
- The image must be exam-specific: any diagram, flowchart, anatomical figure, circuit, or table visual must use the exact labels, values, and relationships that appear in the reference material for this exam.
- If the page is purely prose/narrative with no diagram-worthy content, return needs_image: false.
- FIGURE NUMBERS (mandatory): ${figureHint} For EACH prompt in the "prompts" array, set "figure_label" to the exact string "Figure N" where N runs sequentially starting at ${figureBase + 1} (first prompt = "Figure ${figureBase + 1}", second = "Figure ${figureBase + 2}", etc.). Repeat that same "Figure N" string inside the "prompt" text on its own FIRST line exactly as: "Label for this infographic: Figure N — [topic]". Never skip this line for any prompt.

Reply STRICT JSON only:
{
  "needs_image": true|false,
  "prompts": [
    {
      "figure_label": "Figure 1",
      "title": "exact topic name as it appears in the reference book",
      "prompt": "Exactly one concatenated infographic prompt string: first line 'Label for this infographic: Figure N — <short topic>', then paragraphs with the full B&W textbook-style diagram description grounded in uploaded references."
    }
  ]
}
Rules: ${instr}`, 300000, 3, { skipReferenceGuard: true });
      const data = extractJSON(checkResp);
      if (!data || !data.needs_image || !Array.isArray(data.prompts) || !data.prompts.length) {
        return [];
      }
      log(`🖼 GPT prepared ${data.prompts.length} image prompt(s) for ${label} (figures ${figureBase + 1}…${figureBase + data.prompts.length}).`, 'img');

      const results = [];
      for (let pi = 0; pi < data.prompts.length; pi++) {
        if (abortFlag) break;
        const p = data.prompts[pi];
        const n = figureBase + pi + 1;
        const figLabel = `Figure ${n}`;
        results.push({
          label: p.title || label,
          figureTag: figLabel,
          prompt: String(p.prompt || '').trim(),
        });
      }
      log(`✔ Image prompts ready for ${label}: ${results.length}/${data.prompts.length}.`, 'img');
      return results;
    } catch (err) {
      log(`⚠ Image-check failed: ${err.message}`, 'warn');
      return [];
    }
  }

  function getPlanningTargetQuestionsPerDomain(domain) {
    const subCount = (domain.subdomains || []).length;
    const perSubRule = 10;
    const totalFromUI = practiceConfig.totalQuestions || 0;
    let qForDomain = totalFromUI > 0 ? totalFromUI : (perSubRule * subCount);
    if (qForDomain <= 0) qForDomain = perSubRule * Math.max(1, subCount);
    return qForDomain;
  }

  async function detectFreeResponseProfileForDomain(domain, domainNum, targetQ) {
    // Phase 1/3: confirm FR samples are understood
    await sendToGPT(`For Domain-${domainNum} "${domain.name}", confirm you have read the uploaded FREE-RESPONSE sample paper(s).
Reply exactly:
FR_SAMPLES_CONFIRMED
Then stop.`, 120000, 1, { skipReferenceGuard: true });

    // Phase 2/3: detect measured sample counts only
    const countPrompt = `Analyze uploaded FREE-RESPONSE samples for Domain-${domainNum}: "${domain.name}" in exam "${examConfig.examName}".

Return STRICT JSON only:
{
  "sample_total_questions": 0,
  "sample_free_response_questions": 0,
  "free_response_percentage": 0
}

Rules:
- Count only measurable sample questions.
- free_response_percentage must be derived from counts, not guessed.
- If free-response is absent, return 0 for all relevant values.`;
    const countRaw = await sendToGPT(countPrompt, 300000, 1, { skipReferenceGuard: true });
    const countData = extractJSON(countRaw);
    const total = Math.max(0, parseInt(countData.sample_total_questions, 10) || 0);
    const frCount = Math.max(0, parseInt(countData.sample_free_response_questions, 10) || 0);
    const pct = Math.max(0, Math.min(100, parseFloat(countData.free_response_percentage) || 0));

    // Phase 3/3: map counts to UI target + detect FR style profile
    const planPrompt = `Using this measured data for Domain-${domainNum} "${domain.name}":
- sample_total_questions: ${total}
- sample_free_response_questions: ${frCount}
- free_response_percentage: ${pct}
- target_questions_from_ui: ${targetQ}

TASK:
1) Compute exact target_free_response_questions for target_questions_from_ui.
2) Extract free-response style profile from uploaded samples only.

Return STRICT JSON only:
{
  "sample_total_questions": ${total},
  "sample_free_response_questions": ${frCount},
  "free_response_percentage": ${pct},
  "target_questions": ${targetQ},
  "target_free_response_questions": 0,
  "free_response_categories": [
    {"name":"", "weight_percent":0, "description":""}
  ],
  "basis_for_questions": "what each FR item is grounded in (e.g. derivation, clinical vignette steps, calculation, policy analysis)",
  "stem_structure_notes": "how stems are framed (scenario lead-in, multipart instructions, diagrams referenced inline, word limits)",
  "typical_lengths_words": {"short":"","medium":"","long":""},
  "response_components": ["bullet list of what a complete student answer must include"],
  "marking_rubric_hints": "brief notes on marking style if visible in samples (points, checkpoints, partially-credit cues)",
  "format_rules": [
    "line/structure rule..."
  ],
  "concept_rules": [
    "concept expectation..."
  ],
  "fr_statement_words": 0,
  "fr_option_words": 0,
  "fr_roman_point_words": 0,
  "fr_options_count": 0
}

Rules:
- target_free_response_questions must be based on measured sample ratio.
- target_free_response_questions must be an integer between 0 and target_questions.
- Provide fr_* word/option knobs only when evidenced by uploaded FR samples (integers > 0), else use 0.`;
    const planRaw = await sendToGPT(planPrompt, 300000, 1, { skipReferenceGuard: true });
    const data = extractJSON(planRaw);

    const overlayForMerge = {
      est_sample_total_questions: total,
      est_sample_fr_questions: frCount,
      est_fr_share_percent: pct,
      basis_for_questions: '',
      stem_structure_notes: '',
      marking_rubric_hints: '',
      typical_lengths_compact: '',
      response_components: [],
      format_rules: [],
      concept_rules: [],
      free_response_categories: [],
    };

    let targetFR = Math.max(0, parseInt(data.target_free_response_questions, 10) || 0);
    if (targetFR <= 0) {
      // Fallback calculation if GPT misses target field
      if (total > 0 && frCount > 0) {
        targetFR = Math.round((frCount / total) * targetQ);
      } else if (pct > 0) {
        targetFR = Math.round((pct / 100) * targetQ);
      }
    }
    if (frCount > 0 && targetFR <= 0) targetFR = 1;
    targetFR = Math.min(targetQ, Math.max(0, targetFR));
    const categories = Array.isArray(data.free_response_categories) ? data.free_response_categories : [];
    const formatRules = Array.isArray(data.format_rules) ? data.format_rules : [];
    const conceptRules = Array.isArray(data.concept_rules) ? data.concept_rules : [];
    const basisForQuestions = String(data.basis_for_questions || '').trim();
    const stemStructureNotes = String(data.stem_structure_notes || '').trim();
    const markingRubricHints = String(data.marking_rubric_hints || '').trim();
    const responseComponents = Array.isArray(data.response_components)
      ? data.response_components.map(x => String(x || '').trim()).filter(Boolean)
      : [];
    const tl = data.typical_lengths_words;
    let typicalLengthsLine = '';
    if (tl && typeof tl === 'object') {
      typicalLengthsLine = ['short', 'medium', 'long']
        .map(k => (tl[k] != null && String(tl[k]).trim() !== '' ? `${k}: ${String(tl[k]).trim()}` : ''))
        .filter(Boolean)
        .join(' | ');
    }

    overlayForMerge.basis_for_questions = basisForQuestions;
    overlayForMerge.stem_structure_notes = stemStructureNotes;
    overlayForMerge.marking_rubric_hints = markingRubricHints;
    overlayForMerge.typical_lengths_compact = typicalLengthsLine;
    overlayForMerge.response_components = responseComponents;
    overlayForMerge.format_rules = formatRules.map((x) => String(x || '').trim()).filter(Boolean);
    overlayForMerge.concept_rules = conceptRules.map((x) => String(x || '').trim()).filter(Boolean);
    overlayForMerge.free_response_categories = categories;

    ['fr_statement_words', 'fr_option_words', 'fr_roman_point_words', 'fr_options_count'].forEach((k) => {
      const n = parseInt(data[k], 10);
      if (!isNaN(n) && n > 0) overlayForMerge[k] = n;
    });

    return {
      sampleTotalQuestions: total,
      sampleFreeResponseQuestions: frCount,
      freeResponsePercentage: pct,
      targetFreeResponseQuestions: targetFR,
      categories,
      formatRules,
      conceptRules,
      basisForQuestions,
      stemStructureNotes,
      markingRubricHints,
      responseComponents,
      typicalLengthsLine,
      overlayForMerge,
    };
  }

  async function generateFreeResponseSectionForDomain(domain, domainNum, targetQ) {
    if (!examConfig.freeResponseAvailable) return;
    if (currentState === STATE.RUNNING) setActiveGenerationLane('free_response');
    await promptFrqSampleUploadUI(domainNum, domain.name);
    if (abortFlag) throw new Error('Aborted');

    const profile = await detectFreeResponseProfileForDomain(domain, domainNum, targetQ);
    log(`🧠 Domain ${domainNum} free-response profile: sample_total=${profile.sampleTotalQuestions}, sample_fr=${profile.sampleFreeResponseQuestions}, pct=${profile.freeResponsePercentage.toFixed(2)}%, target_fr=${profile.targetFreeResponseQuestions}.`, 'info');

    if (profile.overlayForMerge && typeof profile.overlayForMerge === 'object') {
      freeResponseMapping.merged = mergeFrMappingLayers(freeResponseMapping.merged || {}, profile.overlayForMerge);
      freeResponseMapping.lastMergedFromDomain = `Domain-${domainNum}: ${domain.name}`;
      persistFreeResponseMappingState();
      try { renderSampleMapping(); } catch (_) {}
    }

    if (profile.targetFreeResponseQuestions <= 0) {
      log(`⏭ Domain ${domainNum}: free-response target resolved to 0. Skipping section.`, 'sys');
      issueLog('warn', `fr_skip_zero_target_domain_${domainNum}`, { domain: domain.name });
      return;
    }

    const cats = (profile.categories || [])
      .map(c => `- ${String(c.name || 'Category').trim()}: ${parseFloat(c.weight_percent) || 0}% (${String(c.description || '').trim()})`)
      .join('\n') || '- (No explicit categories returned)';
    const fmt = (profile.formatRules || []).map(x => `- ${String(x || '').trim()}`).join('\n') || '- Keep exam-true structure from samples.';
    const concepts = (profile.conceptRules || []).map(x => `- ${String(x || '').trim()}`).join('\n') || '- Keep domain-authentic conceptual depth.';
    const basis = profile.basisForQuestions ? `- Basis / grounding (from samples): ${profile.basisForQuestions}` : '';
    const stemStruct = profile.stemStructureNotes ? `- Stem framing (from samples): ${profile.stemStructureNotes}` : '';
    const lengths = profile.typicalLengthsLine ? `- Typical lengths (from samples): ${profile.typicalLengthsLine}` : '';
    const comps = (profile.responseComponents || []).length
      ? `- Required answer components pattern:\n${profile.responseComponents.map(x => `  • ${x}`).join('\n')}`
      : '';
    const markHint = profile.markingRubricHints ? `- Marking / rubric hints (from samples): ${profile.markingRubricHints}` : '';

    let optionCount = Math.round(getMergedFrNumeric('fr_options_count', 0));
    if (!optionCount) optionCount = Math.round(parseFloat(getSampleMapValue('optionsCount', 4)));
    optionCount = Math.max(2, Math.min(6, optionCount || 4));
    const optionLetters = alphaLetters(optionCount);

    let frStatementWords = Math.round(getMergedFrNumeric('fr_statement_words', 0));
    if (!frStatementWords) frStatementWords = Math.max(8, parseInt(getSampleMapValue('statementsLength', 28), 10) || 28);
    else frStatementWords = Math.max(8, frStatementWords);

    let frOptionWords = Math.round(getMergedFrNumeric('fr_option_words', 0));
    if (!frOptionWords) frOptionWords = Math.max(6, Math.round(frStatementWords * 0.45));

    let frRomanPointWords = Math.round(getMergedFrNumeric('fr_roman_point_words', 0));
    if (!frRomanPointWords) frRomanPointWords = Math.max(5, Math.round(frOptionWords * 0.6));
    const optionTemplate = optionLetters.map((l) =>
      `        {"label":"${l}","text":"","roman_points":["",""]}`
    ).join(',\n');

    const prompt = `Generate ${profile.targetFreeResponseQuestions} FREE-RESPONSE questions for Domain-${domainNum}: "${domain.name}" in exam "${examConfig.examName}".

MANDATORY PROFILE (from detected sample mapping):
- Sample total questions: ${profile.sampleTotalQuestions}
- Sample free-response questions: ${profile.sampleFreeResponseQuestions}
- Free-response percentage: ${profile.freeResponsePercentage.toFixed(2)}%
- Target free-response questions for this domain: ${profile.targetFreeResponseQuestions}
${basis ? '\n' + basis : ''}${stemStruct ? '\n' + stemStruct : ''}${lengths ? '\n' + lengths : ''}${comps ? '\n' + comps : ''}${markHint ? '\n' + markHint : ''}

FREE-RESPONSE CATEGORIES:
${cats}

FORMAT RULES (must follow):
${fmt}

CONCEPT RULES (must follow):
${concepts}

STRICT CONTENT RULES:
- Use ONLY ALL uploaded reference books in this chat (full corpus) and this domain's mapped concepts derived from those materials — advanced professional synthesis only.
- Do NOT output REFERENCE_NOT_FOUND, MISSING_REFERENCE, or ask for more uploads — assume uploads are readable; derive all content from them.
- Professional exam-level wording according to verified difficulty_level=${examConfig.difficultyLevel}.
- No generic filler.
- Force full advanced level only: no basic/easy/definition-only FR items.
- Every FR question must require deep conceptual reasoning, structured argumentation, and applied professional judgment.
- Every generated row MUST follow this structure intent:
  Qn. [detailed long statement based on sample detections]
  (A) option text + two roman points
  (B) option text + two roman points
  ... up to detected option count from sample mapping.
- Roman points must be exactly two per option (i) and (ii), sample-style conditions.
- Hard length lock (STRICT):
  - statement MUST be exactly ${frStatementWords} words.
  - each option text MUST be exactly ${frOptionWords} words.
  - each roman point text MUST be exactly ${frRomanPointWords} words.
  - Keep this same length/DNS structure for all questions; only conceptual content changes.
- Add one final detailed image prompt for each question.
- Add a short explanation specifically for the LAST option's two roman points.

Return STRICT JSON only:
{
  "free_response_questions": [
    {
      "id": 1,
      "statement": "",
      "options": [
${optionTemplate}
      ],
      "final_image_prompt": "",
      "last_option_short_explanation": ""
    }
  ]
}`;

    const raw = await sendToGPT(prompt, 300000, 2, { skipReferenceGuard: true });
    const data = extractJSON(raw);
    const rows = Array.isArray(data.free_response_questions) ? data.free_response_questions : [];
    if (!rows.length) {
      log(`⚠ Domain ${domainNum}: free-response generation returned empty set.`, 'warn');
      issueLog('warn', 'fr_generation_empty_json', { domainNum, domain: domain.name });
      return;
    }

    const toExactWords = (text, exactWords) => {
      const target = Math.max(1, parseInt(exactWords, 10) || 1);
      const tokens = String(text || '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
      if (!tokens.length) return Array(target).fill('concept').join(' ');
      if (tokens.length > target) return tokens.slice(0, target).join(' ');
      if (tokens.length < target) {
        const filler = tokens[tokens.length - 1] || 'concept';
        while (tokens.length < target) tokens.push(filler);
      }
      return tokens.join(' ');
    };

    const lines = [`Free Response Questions — Domain ${domainNum}: ${domain.name}`, ''];
    rows.slice(0, profile.targetFreeResponseQuestions).forEach((r, i) => {
      const statement = toExactWords(String(r.statement || r.prompt || '').trim(), frStatementWords);
      const frLooksBasic = /\b(basic|easy|simple|introductory|definition only|define|list any two|state two points|what is)\b/i;
      if (frLooksBasic.test(statement)) return;
      lines.push(`Q${i + 1}. ${statement}`);
      const opts = Array.isArray(r.options) ? r.options : [];
      optionLetters.forEach((letter) => {
        const hit = opts.find((o) => String(o && o.label || '').trim().toUpperCase() === letter);
        const text = toExactWords(String(hit && hit.text || '').trim() || `Option ${letter}`, frOptionWords);
        if (frLooksBasic.test(text)) return;
        lines.push(`(${letter}) ${text}`);
        const pts = Array.isArray(hit && hit.roman_points) ? hit.roman_points : [];
        const p1 = toExactWords(String(pts[0] || '').trim() || 'point one', frRomanPointWords);
        const p2 = toExactWords(String(pts[1] || '').trim() || 'point two', frRomanPointWords);
        lines.push(`(i) ${p1}`);
        lines.push(`(ii) ${p2}`);
      });
      const imgPrompt = String(r.final_image_prompt || '').trim();
      if (imgPrompt) lines.push(`Final Image Prompt: ${imgPrompt}`);
      const lastExplain = String(r.last_option_short_explanation || '').trim();
      if (lastExplain) lines.push(`Last Option Short Explanation: ${lastExplain}`);
      lines.push('');
    });
    await DOCS.post(lines.join('\n'), `Free Response Questions — Domain ${domainNum}`);
    const posted = Math.min(rows.length, profile.targetFreeResponseQuestions);
    log(`✔ Domain ${domainNum}: posted ${posted} free-response question(s).`, 'ok');
    issueLog('info', 'fr_section_posted', { domainNum, domain: domain.name, count: posted });
  }

  /** Sample-mapping rows with detected value 0 are excluded when computing type-weight percentages. */
  function typeEnabledForPractice(key) {
    const e = sampleMapping && sampleMapping[key];
    if (!e) return true;
    const d = String(e.detected != null ? e.detected : '').trim();
    if (d === '') return true;
    const n = parseFloat(String(d).replace(/,/g, ''));
    return !isNaN(n) && n > 0;
  }

  function buildTypeBreakdown(totalQ) {
    const ALL_PF = [
      'scenarioBased', 'definitionType', 'recallStatement',
      'applicationBased', 'fillInTheBlanks', 'tableBased', 'chartsGraphsImg'
    ];
    const plannedRaw = sampleMappingMeta?.plannedTypeCounts && typeof sampleMappingMeta.plannedTypeCounts === 'object'
      ? sampleMappingMeta.plannedTypeCounts
      : null;
    if (plannedRaw) {
      const planned = {};
      let plannedSum = 0;
      ALL_PF.forEach((k) => {
        const n = Math.max(0, parseInt(plannedRaw[k], 10) || 0);
        planned[k] = n;
        plannedSum += n;
      });
      if (plannedSum === totalQ) return planned;
    }
    const detectedTotal = Math.max(0, parseInt(sampleMappingMeta?.totalDetectedQuestions || 0, 10) || 0);
    const detectedCounts = sampleMappingMeta?.typeCounts && typeof sampleMappingMeta.typeCounts === 'object'
      ? sampleMappingMeta.typeCounts
      : {};
    if (detectedTotal > 0) {
      const active = ALL_PF.filter(k => (parseInt(detectedCounts[k], 10) || 0) > 0);
      const keys = active.length ? active : ALL_PF.slice();
      const breakdown = {};
      let assigned = 0;
      const scored = keys.map((k) => {
        const c = Math.max(0, parseInt(detectedCounts[k], 10) || 0);
        const exact = (c / detectedTotal) * totalQ;
        const base = Math.floor(exact);
        assigned += base;
        breakdown[k] = base;
        return { k, frac: exact - base };
      });
      let rem = totalQ - assigned;
      scored.sort((a, b) => b.frac - a.frac);
      let i = 0;
      while (rem > 0 && scored.length) {
        const k = scored[i % scored.length].k;
        breakdown[k] = (breakdown[k] || 0) + 1;
        rem--;
        i++;
      }
      return breakdown;
    }
    let pctFields = ALL_PF.filter(typeEnabledForPractice);
    if (!pctFields.length) pctFields = ALL_PF.slice();

    const weights = {};
    let sum = 0;
    pctFields.forEach(k => {
      const w = parseFloat(sampleMapping[k]?.weight) || 0;
      weights[k] = w;
      sum += w;
    });
    const breakdown = {};
    if (sum > 0) {
      let assigned = 0;
      pctFields.forEach((k, i) => {
        if (i < pctFields.length - 1) {
          breakdown[k] = Math.round((weights[k] / sum) * totalQ);
          assigned += breakdown[k];
        } else {
          // Last field gets the remainder so the total matches exactly.
          breakdown[k] = Math.max(0, totalQ - assigned);
        }
      });
    } else {
      // No weights → equal split
      const base = Math.floor(totalQ / pctFields.length);
      const rem  = totalQ - base * pctFields.length;
      pctFields.forEach((k, i) => { breakdown[k] = base + (i < rem ? 1 : 0); });
    }

    // Final exact-total correction guard.
    const finalTotal = Object.keys(breakdown).reduce((s, k) => s + (breakdown[k] || 0), 0);
    if (finalTotal !== totalQ) {
      const diff = totalQ - finalTotal;
      let adjustKey = 'definitionType';
      if (!pctFields.includes(adjustKey) || breakdown[adjustKey] === undefined) {
        adjustKey = pctFields.find(k => Object.prototype.hasOwnProperty.call(breakdown, k)) || pctFields[0] || adjustKey;
      }
      breakdown[adjustKey] = Math.max(0, (breakdown[adjustKey] || 0) + diff);
    }
    return breakdown;
  }

  function typeLabel(key) {
    return ({
      scenarioBased:   'Scenario-based',
      definitionType:  'Definition',
      recallStatement: 'Recall / Statemental',
      applicationBased:'Application',
      fillInTheBlanks: 'Fill in the blanks',
      tableBased:      'Table based',
      chartsGraphsImg: 'Chart / Graph / Image based',
    })[key] || key;
  }

  function alphaLetters(n) {
    const out = [];
    for (let i = 0; i < n && i < 26; i++) out.push(String.fromCharCode(65 + i));
    return out;
  }

  function getMergedFrNumeric(key, fallback) {
    const m = freeResponseMapping && freeResponseMapping.merged;
    if (!m || typeof m !== 'object') return fallback;
    if (!Object.prototype.hasOwnProperty.call(m, key)) return fallback;
    const raw = parseFloat(m[key]);
    if (key === 'est_fr_share_percent') {
      if (!isNaN(raw) && raw >= 0) return raw;
      return fallback;
    }
    if (!isNaN(raw) && raw > 0) return raw;
    return fallback;
  }

  function getSampleMapValue(key, fallback) {
    const entry = sampleMapping && sampleMapping[key] ? sampleMapping[key] : null;
    const detected = entry ? parseFloat(entry.detected) : NaN;
    if (!isNaN(detected) && detected > 0) return detected;
    const weight = entry ? parseFloat(entry.weight) : NaN;
    if (!isNaN(weight) && weight > 0) return weight;
    return fallback;
  }

  function pauseGeneration() {
    pauseFlag = true;
    updateControlState({ desiredState: STATE.PAUSED });
    setUIState(STATE.PAUSED);
    log('⏸ Paused.', 'warn');
  }

  function resumeGeneration() {
    pauseFlag = false;
    updateControlState({ desiredState: STATE.RUNNING });
    loadCheckpointStateFromStorage();
    if (currentState === STATE.RUNNING) {
      log('▶ Orchestrator already running (pause was cleared).', 'sys');
      return;
    }
    log('▶ Resuming from saved checkpoint (no extra delay).', 'info');
    const detail = formatCheckpointForLog();
    if (detail) log(`   ${detail}`, 'info');
    // startGeneration() sets STATE.RUNNING — never set RUNNING before it or the
    // `if (currentState === STATE.RUNNING) return` guard will skip the job.
    startGeneration({ skipWarmup: true });
  }

  function stopGeneration() {
    abortFlag = true;
    pauseFlag = false;
    updateControlState({ desiredState: STATE.STOPPED });
    setUIState(STATE.STOPPED);
    log('⏹ Stopped.', 'warn');
  }

  function retryPage() {
    abortFlag = false;
    pauseFlag = false;
    updateControlState({ desiredState: STATE.RUNNING });
    progress.retries++;
    saveObj(STORAGE_KEYS.PROGRESS, progress);
    updateProgressUI();
    log(`↺ Retrying page ${progress.currentPage}...`, 'info');
    // The running loop will re-enter; if not running, start fresh from current page.
    if (currentState !== STATE.RUNNING) startGeneration({ skipWarmup: true });
  }

  function skipPage() {
    pauseFlag = false;
    progress.skipped++;
    pushRecent(progress.currentPage, 'skip', 'skipped by user');
    saveObj(STORAGE_KEYS.PROGRESS, progress);
    updateProgressUI();
    log(`⏭ Skipped page ${progress.currentPage}.`, 'warn');
    if (currentState === STATE.PAUSED) setUIState(STATE.RUNNING);
  }

  function resetEverything() {
    let ok = true;
    try { ok = confirm('Reset ALL progress and saved data? This cannot be undone.'); }
    catch (_) { ok = true; /* some hosts strip confirm */ }
    if (!ok) return;

    abortFlag     = true;
    pauseFlag     = false;
    pendingConfirm.outline = null;
    pendingConfirm.books   = null;
    pendingConfirm.samples = null;
    pendingConfirm.newBook = null;
    pendingConfirm.resumeContext = null;

    examConfig     = JSON.parse(JSON.stringify(DEFAULT_EXAM_CONFIG));
    imageConfig    = JSON.parse(JSON.stringify(DEFAULT_IMAGE_CONFIG));
    refConfig      = JSON.parse(JSON.stringify(DEFAULT_REF_CONFIG));
    workflow       = JSON.parse(JSON.stringify(DEFAULT_WORKFLOW));
    progress       = JSON.parse(JSON.stringify(DEFAULT_PROGRESS));
    practiceConfig = JSON.parse(JSON.stringify(DEFAULT_PRACTICE_CONFIG));
    sampleMapping  = JSON.parse(JSON.stringify(DEFAULT_SAMPLE_MAPPING));
    sampleMappingMeta = JSON.parse(JSON.stringify(DEFAULT_SAMPLE_MAPPING_META));
    freeResponseMapping = defaultFreeResponseMappingState();
    domains        = [];

    saveObj(STORAGE_KEYS.EXAM_CONFIG,     examConfig);
    saveObj(STORAGE_KEYS.IMAGE_CONFIG,    imageConfig);
    saveObj(STORAGE_KEYS.REF_CONFIG,      refConfig);
    saveObj(STORAGE_KEYS.WORKFLOW,        workflow);
    saveObj(STORAGE_KEYS.PROGRESS,        progress);
    saveObj(STORAGE_KEYS.PRACTICE_CONFIG, practiceConfig);
    saveObj(STORAGE_KEYS.SAMPLE_MAPPING,  sampleMapping);
    saveObj(STORAGE_KEYS.SAMPLE_MAPPING_META, sampleMappingMeta);
    saveObj(STORAGE_KEYS.FREE_RESPONSE_MAPPING, freeResponseMapping);
    saveObj(STORAGE_KEYS.DOMAINS,         domains);

    GM_setValue(STORAGE_KEYS.APPS_SCRIPT_URL, '');
    GM_setValue(STORAGE_KEYS.DOC_ID, '');
    GM_setValue(STORAGE_KEYS.SECRET_KEY, '');
    GM_setValue(STORAGE_KEYS.SNAP_AUTO_DOMAINS, '');
    GM_setValue(STORAGE_KEYS.SNAP_DOMAIN_MAPPING, '');
    GM_setValue(STORAGE_KEYS.SNAP_PAGE_ALLOC, '');
    GM_setValue(STORAGE_KEYS.SNAP_SAMPLE_MAPPING, '');
    try { GM_setValue(STORAGE_KEYS.SNAP_FREE_RESPONSE_MAPPING, ''); } catch (_) {}
    GM_setValue(STORAGE_KEYS.ISSUE_LOG, '[]');

    applyConfigsToUI();
    applyWorkflowUI();
    renderDomains();
    renderSampleMapping();
    updateProgressUI();
    hidePopup && hidePopup();
    hideBookPopup && hideBookPopup();
    hideStepNotify && hideStepNotify();
    const cns = $('#sg-console'); if (cns) cns.innerHTML = '';
    try { refreshIssueLogUI(); } catch (_) {}
    setUIState(STATE.IDLE);
    log('🗑 Reset complete — all saved data cleared.', 'warn', false);
    notify('Reset complete.');
  }

  // ─────────────────────────────────────────────────────────────
  //  GPT: PAGE TEXT GENERATION
  // ─────────────────────────────────────────────────────────────
  async function generatePageText(pageNum) {
    const headingRule = (pageNum === examConfig.startFromPage)
      ? 'Include domain (#) and subdomain (##) headings on this FIRST page only.'
      : 'Do NOT repeat domain/subdomain headings. Use only specific ###topic headings.';

    const prompt = `You are generating page ${pageNum} of ${examConfig.totalPages} for the study guide of "${examConfig.examName}".

STRICT v13 RULES (enforce all):
- Use REFERENCE BOOKS ONLY. Zero training data. Zero fabrication.
- If reference content is missing, output exactly: "MISSING_REFERENCE: <topic>".
- ${headingRule}
- Use ONLY specific ###topic headings — no generic names like "Introduction".
- Each paragraph: ${examConfig.minLinesPerPara}–${examConfig.maxLinesPerPara} lines.
- Target ~${examConfig.wordsPerPage} words for this page.
- Math/Physics: include REAL equations (not placeholders).
- Chemistry: balanced reactions with state symbols (s, l, g, aq).
- Code blocks: complete runnable examples with expected output.
- Do NOT include source citations inline — just content.

Produce the page now. Return plain text (markdown allowed).`;

    return await sendToGPT(prompt);
  }

  async function sendReferenceReminder() {
    if (!isOnGPT()) return;
    log('🔒 Re-sending v13 reference rules...', 'sys');
    const reminder = `REFERENCE REMINDER (v13): Continue using REFERENCE BOOKS ONLY. No training data.
- Specific ###topic headings only (no generic names).
- Keep textbook layout: **DISPLAY — Worked example** / **DISPLAY — Formula / identity** / **DISPLAY — Chemical reaction** / **DISPLAY — Exercises (questions)** below paragraphs — not inline walls of math.
- Math/Chemistry/Code must be real, balanced, and runnable.
- If reference missing, output "MISSING_REFERENCE: <topic>".
Acknowledge with "OK" and continue.`;
    try {
      await sendToGPT(reminder);
    } catch (err) {
      log(`⚠ Reminder failed: ${err.message}`, 'warn');
    }
  }

  // ─────────────────────────────────────────────────────────────
  //  GPT DOM INTERACTION
  // ─────────────────────────────────────────────────────────────
  function assistantNodeToMarkdown(node) {
    if (!node) return '';
    const root = node.cloneNode(true);

    root.querySelectorAll('h1').forEach(el => el.replaceWith(`# ${(el.textContent || '').trim()}\n\n`));
    root.querySelectorAll('h2').forEach(el => {
      const t = (el.textContent || '').trim();
      const isOfficialSub = /^Subdomain-\d+\.\d+\s*:/i.test(t);
      el.replaceWith(isOfficialSub ? `## ${t}\n\n` : `### ${t}\n\n`);
    });
    root.querySelectorAll('h3').forEach(el => el.replaceWith(`### ${(el.textContent || '').trim()}\n\n`));
    root.querySelectorAll('h4,h5,h6').forEach(el => el.replaceWith(`### ${(el.textContent || '').trim()}\n\n`));

    root.querySelectorAll('table').forEach(tbl => {
      const rows = Array.from(tbl.querySelectorAll('tr')).map(tr =>
        Array.from(tr.querySelectorAll('th,td')).map(td => (td.textContent || '').replace(/\s+/g, ' ').trim())
      ).filter(r => r.length && r.some(Boolean));
      if (!rows.length) {
        tbl.replaceWith('\n');
        return;
      }
      const header = rows[0];
      const sep = header.map(() => '---');
      const body = rows.slice(1);
      let md = `| ${header.join(' | ')} |\n| ${sep.join(' | ')} |\n`;
      body.forEach(r => {
        while (r.length < header.length) r.push('');
        md += `| ${r.slice(0, header.length).join(' | ')} |\n`;
      });
      tbl.replaceWith(`\n${md}\n`);
    });

    root.querySelectorAll('strong,b').forEach(el => el.replaceWith(`**${(el.textContent || '').trim()}**`));
    root.querySelectorAll('em,i').forEach(el => el.replaceWith(`*${(el.textContent || '').trim()}*`));
    root.querySelectorAll('li').forEach(el => el.replaceWith(`- ${(el.textContent || '').trim()}\n`));
    root.querySelectorAll('br').forEach(el => el.replaceWith('\n'));
    root.querySelectorAll('p').forEach(el => el.replaceWith(`${(el.textContent || '').trim()}\n\n`));

    return (root.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
  }

  function normalizeOutboundContent(text) {
    let normalized = String(text || '')
      // Keep `##Subdomain-1.1: Name` as real markdown (ULTRA.js parses to H2 + styled row).
      // Do NOT convert to **bold** or "Subdomain-…" will appear as plain text in the Doc.
      // LaTeX: ensure display math is wrapped in $$ so ULTRA/Doc see proper blocks
      .replace(/\\\[([\s\S]*?)\\\]/g, (m, inner) => `$$\n${String(inner).trim()}\n$$`)
      .replace(/^###\s*Target Page\s*$/gmi, '# Target Covered')
      .replace(/^###Target Page\s*$/gmi, '# Target Covered')
      .replace(/^###\s*Memeory Check\s*$/gmi, '# Memory Check')
      .replace(/^\s*Memeory Check\s*$/gmi, 'Memory Check')
      .replace(/^\s*(?:#{1,2}\s*)?Subdomain-(\d+)\.(\d+):\s*([^\n]+)\s*$/gmi, (full, a, b, name) => {
        if (/^##\s*Subdomain-/i.test(full)) return full;
        return `##Subdomain-${a}.${b}: ${String(name).trim()}`;
      })
      .trim();
    normalized = enforceTopicSubheadingHashes(normalized);
    return normalized;
  }

  /** Topic subheadings must use ###. Fix wrong ## (except ##Subdomain-N.M:) and lone **Heading** lines. */
  function enforceTopicSubheadingHashes(text) {
    const lines = String(text || '').split('\n');
    const out = [];
    for (let i = 0; i < lines.length; i++) {
      let line = lines[i];
      const t = line.trim();
      if (/^##\s+/.test(t) && !/^##\s*Subdomain-\d+\.\d+:/i.test(t)) {
        line = line.replace(/^(\s*)##(\s+)/, '$1###$2');
      } else if (/^\s*\*\*[^*\n]+\*\*\s*$/.test(t) && t.length <= 220) {
        const m = t.match(/^\s*\*\*([^*]+)\*\*\s*$/);
        if (m) {
          const inner = String(m[1] || '').replace(/\s+/g, ' ').trim();
          if (inner && !/^#{1,3}\s/.test(inner)) {
            const indent = (lines[i].match(/^(\s*)/) || [''])[0];
            line = `${indent}### ${inner}`;
          }
        }
      }
      out.push(line);
    }
    return out.join('\n');
  }

  // Add $C content markers to prose paragraphs only (not headings, tables, lists,
  // code fences, block math, DISPLAY labels, quotes, figure tags, or source lines).
  function tagContentParagraphs(text) {
    const blocks = String(text || '').split(/\n\s*\n/);
    const isNonContentBlock = (b) => {
      const t = b.trim();
      if (!t) return true;
      if (/^\$C\s+/i.test(t) && /\s\$C$/i.test(t)) return true; // already tagged
      // Headings: `### foo` and prompts like `###Author Introduction` (no space after #)
      const firstLine = t.split('\n')[0].trim();
      if (/^#{1,6}\s/.test(firstLine) || /^#{1,6}\S/.test(firstLine)) return true;
      if (/^\*\*DISPLAY\s*—/i.test(t)) return true;              // display labels
      if (/^\|/.test(t)) return true;                            // tables
      if (/^[-*]\s+/.test(t)) return true;                       // bullets
      if (/^\d+\.\s+/.test(t)) return true;                      // numbered list
      if (/^>/.test(t)) return true;                             // callouts/quotes
      if (/^```/.test(t)) return true;                           // fenced code
      if (/^\$\$[\s\S]*\$\$$/.test(t)) return true;              // pure block math
      if (/^\[\/?FIGURE:/i.test(t) || /^\[\/?FIGURE\]/i.test(t)) return true;
      if (/^SOURCE\s*:/i.test(t)) return true;
      return false;
    };

    const out = blocks.map((b) => {
      const raw = b.trim();
      if (!raw || isNonContentBlock(raw)) return raw;
      return `$C ${raw} $C`;
    }).filter(Boolean);

    return out.join('\n\n').trim();
  }

  function isOnGPT() {
    const h = window.location.hostname;
    return h.includes('chatgpt') || h.includes('openai');
  }

  // ChatGPT interaction layer — hardened (multi-strategy injection, streaming-aware wait, upload helper)
  const GPT = {
    getInput() {
      return document.getElementById('prompt-textarea')
          || document.querySelector('.ProseMirror[contenteditable="true"]')
          || document.querySelector('[contenteditable="true"][role="textbox"]')
          || document.querySelector('textarea[data-id="root"]')
          || document.querySelector('textarea[placeholder]');
    },
    getSend() {
      return document.querySelector('[data-testid="send-button"]')
          || document.querySelector('button[aria-label*="Send" i]')
          || document.querySelector('button[aria-label="Send prompt"]');
    },
    getStop() {
      return document.querySelector('[data-testid="stop-button"]')
          || document.querySelector('button[aria-label*="Stop" i]');
    },
    isStreaming() {
      if (this.getStop()) return true;
      if (document.querySelector('[class*="result-streaming"]')) return true;
      return false;
    },
    countMsgs() {
      return document.querySelectorAll('[data-message-author-role="assistant"]').length;
    },
    getLatest() {
      const msgs = document.querySelectorAll('[data-message-author-role="assistant"]');
      if (!msgs.length) return '';
      const last = msgs[msgs.length - 1];
      const sels = ['.markdown.prose', '.markdown', '.prose', '[class*="markdown"]', '[class*="prose"]', '.whitespace-pre-wrap'];
      for (const s of sels) {
        const el = last.querySelector(s);
        if (el) {
          const md = assistantNodeToMarkdown(el);
          if (md && md.length > 5) return md;
          const txt = (el.textContent || '').trim();
          if (txt.length > 5) return txt;
        }
      }
      return normalizeOutboundContent((last.textContent || '').trim());
    },

    async injectText(text) {
      let el = this.getInput();
      if (!el) { await sleep(800); el = this.getInput(); }
      if (!el) { log('ChatGPT textarea not found.', 'error'); return false; }

      try { el.focus(); await sleep(40); el.innerHTML = ''; el.dispatchEvent(new Event('input', { bubbles: true })); await sleep(60); } catch (_) {}

      // Strategy 1: execCommand insertText (works for ProseMirror)
      try {
        el.focus();
        document.execCommand('selectAll', false, null);
        document.execCommand('delete', false, null);
        await sleep(30);
        document.execCommand('insertText', false, text);
        await sleep(150);
        if ((el.textContent || el.value || '').trim().length > 20) return true;
      } catch (_) {}

      // Strategy 2: native value setter (HTMLTextArea)
      try {
        const ns = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value');
        if (ns && el.tagName === 'TEXTAREA') {
          ns.set.call(el, text);
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          await sleep(150);
          if ((el.value || '').trim().length > 20) return true;
        }
      } catch (_) {}

      // Strategy 3: React fiber onChange
      try {
        const fk = Object.keys(el).find(k => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance'));
        if (fk) {
          let node = el[fk];
          while (node) {
            if (node.memoizedProps && node.memoizedProps.onChange) {
              node.memoizedProps.onChange({ target: { value: text } });
              break;
            }
            node = node.return;
          }
          await sleep(200);
          if ((el.textContent || el.value || '').trim().length > 20) return true;
        }
      } catch (_) {}

      // Strategy 4: synthetic paste event
      try {
        const dt = new DataTransfer();
        dt.setData('text/plain', text);
        el.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }));
        await sleep(250);
        if ((el.textContent || el.value || '').trim().length > 20) return true;
      } catch (_) {}

      // Strategy 5: direct textContent + InputEvent
      try {
        el.focus();
        el.textContent = text;
        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
        await sleep(300);
        return true;
      } catch (e) {
        log('All inject methods failed: ' + e.message, 'error');
        return false;
      }
    },

    async clickSend() {
      for (let i = 0; i < 30; i++) {
        const btn = this.getSend();
        if (btn && !btn.disabled) { btn.click(); return true; }
        await sleep(100);
      }
      return false;
    },

    async send(text) {
      const el = this.getInput();
      if (el) {
        try { el.innerHTML = ''; el.dispatchEvent(new Event('input', { bubbles: true })); } catch (_) {}
        await sleep(50);
      }
      const ok = await this.injectText(text);
      if (!ok) throw new Error('Text injection failed');
      await sleep(150);
      const sent = await this.clickSend();
      if (!sent) throw new Error('Send button failed');
      await sleep(200);
    },

    // Streaming-aware wait: waits for stop button to disappear + text to stabilize
    waitForDone(timeoutMs) {
      const timeout = timeoutMs || 300000;
      return new Promise((resolve, reject) => {
        const start = Date.now();
        const initCount = this.countMsgs();
        let lastLen = 0, lastText = '', stable = 0, started = false, stoppedAt = 0;
        let lastGrowthAt = Date.now();
        let lastLiveLogAt = 0;
        let staleBailLogged = false;
        /** If ChatGPT leaves Stop/streaming artifacts up but assistant text hasn't grown ~≥this long, assume done */
        const STALE_STREAM_IDLE_MS = 90000;
        const POLL_MS = 300, STOP_GRACE = 400, STABLE_NEED = 2;
        const t = setInterval(() => {
          if (abortFlag) { clearInterval(t); reject(new Error('Aborted')); return; }
          if (pauseFlag) return;
          if (Date.now() - start > timeout) {
            clearInterval(t);
            reject(new Error(`GPT response timeout after ${Math.round(timeout / 1000)}s`));
            return;
          }
          let streaming = this.isStreaming();
          const count = this.countMsgs();
          const text = this.getLatest();
          const len = text.length;
          if (len > lastLen) lastGrowthAt = Date.now();
          const now = Date.now();
          const idleNoGrowthMs = now - lastGrowthAt;
          if (streaming && started && idleNoGrowthMs >= STALE_STREAM_IDLE_MS && len >= 40) {
            streaming = false;
            if (!staleBailLogged) {
              log(`⚠ GPT UI hung on "streaming/stop" but text idle ${Math.round(idleNoGrowthMs / 1000)}s — treating reply as finished.`, 'warn');
              staleBailLogged = true;
            }
          }
          if (now - lastLiveLogAt > 12000) {
            const waited = Math.round((now - start) / 1000);
            const idleFor = Math.round((now - lastGrowthAt) / 1000);
            log(`⏱ GPT live: waiting ${waited}s | streaming=${streaming ? 'yes' : 'no'} | text=${len} chars | idle=${idleFor}s`, idleFor > 45 ? 'warn' : 'sys');
            lastLiveLogAt = now;
          }
          if (!started) {
            if (streaming || count > initCount) { started = true; lastLen = len; lastText = text; }
            lastLen = len;
            return;
          }
          if (streaming) { stable = 0; stoppedAt = 0; lastLen = len; lastText = text; return; }
          if (stoppedAt === 0 && len > 0) { stoppedAt = Date.now(); lastLen = len; lastText = text; }
          if (stoppedAt > 0 && Date.now() - stoppedAt < STOP_GRACE) return;
          if (len > 0 && len === lastLen && text === lastText) {
            stable++;
            if (stable >= STABLE_NEED) { clearInterval(t); resolve(text); }
          } else { stable = 0; lastLen = len; lastText = text; }
        }, POLL_MS);
      });
    },

    // Trigger the ChatGPT attachment upload dialog
    triggerUpload() {
      // Step 1: direct file input
      const directFi = document.querySelector('input[type="file"]');
      if (directFi) { directFi.click(); return; }

      // Step 2: find the + / attach / paperclip button
      const plusSelectors = [
        '[data-testid="composer-plus-btn"]',
        '[data-testid="composer-attach-btn"]',
        '[data-testid="attachments-menu-button"]',
        'button[aria-label*="attach" i]',
        'button[aria-label*="upload" i]',
        'button[aria-label*="add" i]',
        'button[aria-label*="file" i]',
        'button[aria-label*="paperclip" i]',
        'button[aria-label*="plus" i]',
        'form button svg[data-icon="paperclip"]',
        'form button svg[data-icon="plus"]',
      ];
      let plusBtn = null;
      for (const sel of plusSelectors) {
        const el = document.querySelector(sel);
        if (el) { plusBtn = el.closest('button') || el; break; }
      }
      if (!plusBtn) {
        const composerArea = document.querySelector('form,#prompt-textarea,div[contenteditable]')?.closest('div');
        if (composerArea) {
          for (const btn of composerArea.querySelectorAll('button')) {
            const lbl = (btn.getAttribute('aria-label') || btn.title || btn.textContent || '').toLowerCase();
            if (lbl && !lbl.includes('send') && !lbl.includes('stop') && !lbl.includes('submit')) {
              plusBtn = btn; break;
            }
          }
        }
      }
      if (plusBtn) {
        plusBtn.click();
        setTimeout(() => {
          const menuSelectors = '[role="menuitem"],[role="option"],button,li,[role="listitem"]';
          for (const el of document.querySelectorAll(menuSelectors)) {
            if (!el.offsetParent) continue;
            const t = (el.textContent || el.getAttribute('aria-label') || '').toLowerCase();
            if (t.includes('upload') || t.includes('computer') || t.includes('file') || t.includes('attach')) {
              el.click();
              setTimeout(() => {
                const fi = document.querySelector('input[type="file"]');
                if (fi) fi.click();
              }, 400);
              return;
            }
          }
          const fi = document.querySelector('input[type="file"]');
          if (fi) fi.click();
          else log('⚠ ChatGPT upload menu not found — click + manually.', 'warn');
        }, 600);
        return;
      }
      log('⚠ Could not find upload button — click + in ChatGPT manually.', 'warn');
    },
  };

  function shouldApplyReferenceGuard(promptText, opts = {}) {
    if (opts && opts.forceReferenceGuard) return true;
    if (opts && opts.skipReferenceGuard) return false;
    return false; // default OFF; enable only for selected phases/calls.
  }

  function buildReferenceGuardSuffix() {
    return `\n\nREFERENCE CONFIRMATION (MANDATORY):
- Ground every substantive claim ONLY in ALL reference books/files the user uploaded in THIS chat session (titles may differ — treat the full upload set as one authoritative corpus).
- Synthesize advanced, professional exam-level explanations by combining those sources; never invent citations, editions, URLs, page numbers not present in uploads, or out-of-scope “general internet” substitutes.
- This is lawful private authoring for the user's own uploaded materials inside this workspace—not an excuse to copy long verbatim passages unrelated to instructional need; paraphrase and integrate professionally across books.
- If you cannot satisfy the requested item from the uploaded corpus, reply ONLY: REFERENCE_NOT_FOUND: <short topic/concept>.
- Never continue with fabricated, templated, or generic substitution when uploads are insufficient.`;
  }

  // Thin compatibility wrappers so the rest of the codebase keeps working.
  async function sendToGPT(prompt, timeoutMs = 300000, maxAttempts = 3, opts = {}) {
    let lastErr = null;
    const attempts = Math.max(1, maxAttempts);
    let finalPrompt = String(prompt || '');
    if (shouldApplyReferenceGuard(finalPrompt, opts)) {
      finalPrompt += buildReferenceGuardSuffix();
    }
    if (finalPrompt.length > GPT_MEMORY_GUARDS.MAX_PROMPT_CHARS) {
      log(`🧠 Prompt too large (${finalPrompt.length} chars). Applying memory-safe truncation.`, 'warn');
      finalPrompt = finalPrompt.slice(0, GPT_MEMORY_GUARDS.MAX_PROMPT_CHARS) +
        '\n\n[TRUNCATED BY AUTOMATION FOR TAB STABILITY]';
    }
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        log(`🤖 GPT request attempt ${attempt}/${attempts}...`, 'sys');
        await GPT.send(finalPrompt);
        let resp = await GPT.waitForDone(timeoutMs);
        if (!resp || !String(resp).trim()) throw new Error('Empty GPT response');
        const maxRefRecoveries = 12;
        let refRecovery = 0;
        while (shouldApplyReferenceGuard(finalPrompt, opts) && detectMissingReference(resp) && refRecovery < maxRefRecoveries) {
          refRecovery++;
          const topicMatch =
            String(resp).match(/REFERENCE_NOT_FOUND\s*:\s*([^\n]+)/i) ||
            String(resp).match(/MISSING_REFERENCE\s*:\s*([^\n]+)/i);
          const missingTopic = topicMatch ? topicMatch[1].trim() : 'required topic';
          log(`⚠ Reference guard detected missing topic: ${missingTopic} (recovery ${refRecovery}/${maxRefRecoveries})`, 'warn');
          showStepNotify('Reference Missing', `GPT reported missing reference for "${missingTopic}". Upload book(s), then Confirm.`);
          await showBookPopup([`REFERENCE_NOT_FOUND: ${missingTopic}`]);
          hideBookPopup();
          hideStepNotify();
          if (abortFlag) throw new Error('Aborted');
          await verifyReferenceCoverageOrStop(`reference guard ${missingTopic}`);
          await GPT.send(`A new reference book has been uploaded. Read it fully and acknowledge with exactly: REFERENCE_CONFIRMED.`);
          resp = await GPT.waitForDone(timeoutMs);
          if (!resp || !String(resp).trim()) throw new Error('Empty GPT response after reference confirm');
          if (detectMissingReference(resp)) {
            log('⚠ GPT still reports missing reference after REFERENCE_CONFIRMED — repeat upload/verify if needed.', 'warn');
            continue;
          }
          log('✔ Reference acknowledged — re-injecting original prompt.', 'ok');
          await GPT.send(finalPrompt);
          resp = await GPT.waitForDone(timeoutMs);
          if (!resp || !String(resp).trim()) throw new Error('Empty GPT response after reference recovery retry');
        }
        if (shouldApplyReferenceGuard(finalPrompt, opts) && detectMissingReference(resp)) {
          throw new Error('Reference guard: topic still unresolved after uploads');
        }
        return resp;
      } catch (err) {
        lastErr = err;
        const emsg = String(err && err.message || '');
        if (/aborted/i.test(emsg)) {
          throw err;
        }
        log(`⚠ GPT attempt ${attempt}/${attempts} failed: ${emsg}`, 'warn');
        if (attempt < attempts) await sleep(Math.min(1500 * attempt, 6000));
      }
    }
    throw (lastErr || new Error('GPT request failed'));
  }
  // ─────────────────────────────────────────────────────────────
  //  GOOGLE DOCS POSTER (Apps Script protocol)
  // ─────────────────────────────────────────────────────────────
  const DOCS = {
    _cfg() {
      return {
        url:    GM_getValue(STORAGE_KEYS.APPS_SCRIPT_URL, ''),
        docId:  GM_getValue(STORAGE_KEYS.DOC_ID, ''),
        secret: GM_getValue(STORAGE_KEYS.SECRET_KEY, ''),
      };
    },
    _sendRaw(rawData) {
      const cfg = this._cfg();
      if (!cfg.url || !cfg.docId) return Promise.reject(new Error('Missing URL/DocID'));
      return new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method: 'POST',
          url: cfg.url,
          headers: { 'Content-Type': 'application/json; charset=UTF-8', 'Accept': 'application/json, */*' },
          data: rawData,
          timeout: 90000,
          onload: (r) => {
            if (r.status >= 200 && r.status < 400) {
              try {
                const resp = JSON.parse(r.responseText || '{}');
                if (resp.status === 'error') { reject(new Error('Apps Script: ' + (resp.message || 'unknown'))); return; }
              } catch (_) {}
              resolve();
            } else reject(new Error(`HTTP ${r.status}: ${(r.responseText || '').slice(0, 200)}`));
          },
          onerror: () => reject(new Error('Network error')),
          ontimeout: () => reject(new Error('Request timed out after 90s')),
        });
      });
    },

    async sendChunk(content, section) {
      const cfg = this._cfg();
      const payload = {
        secret: String(cfg.secret || '').trim(),
        docId:  String(cfg.docId).trim(),
        action: 'append',
        section: String(section || '').trim(),
        content: String(content || ''),
      };
      return this._sendRaw(JSON.stringify(payload));
    },

    async sendWithRetry(content, section, attempts = 5) {
      let lastErr = '';
      for (let i = 1; i <= attempts; i++) {
        try {
          await this.sendChunk(content, section);
          log(`📤 Saved to Docs: "${section}"`, 'sys');
          return;
        } catch (e) {
          lastErr = e.message;
          log(`Docs save attempt ${i}/${attempts} failed: ${e.message}`, 'warn');
          if (i < attempts) await sleep(Math.min(2000 * i, 12000));
        }
      }
      const msg = `Docs save failed after ${attempts} attempts (${lastErr || 'unknown'}) — "${String(section).slice(0, 80)}"`;
      log(`✗ ${msg}`, 'error');
      throw new Error(msg);
    },

    // Post an arbitrary text block — chunks on paragraph boundaries if > 40KB
    async post(content, section) {
      let text = String(content || '').replace(/^\n+/, '').replace(/\n+$/, '');
      if (!text) return;
      if (text.length <= 40000) { await this.sendWithRetry(text, section); return; }
      const paragraphs = text.split('\n\n');
      let chunk = '', idx = 1;
      for (const p of paragraphs) {
        const add = p + '\n\n';
        if (chunk.length > 0 && (chunk.length + add.length) > 40000) {
          await this.sendWithRetry(chunk, `${section} (Part ${idx})`);
          chunk = add; idx++;
        } else {
          chunk += add;
        }
      }
      if (chunk.replace(/\n/g, '').trim()) await this.sendWithRetry(chunk, `${section} (Part ${idx})`);
    },

    async postImage(imageRecord, section) {
      if (!imageRecord) return;
      const cfg = this._cfg();
      const data = (typeof imageRecord.dataUrl === 'string' && /^data:image\//i.test(imageRecord.dataUrl))
        ? imageRecord.dataUrl
        : '';
      const srcFromData = (typeof imageRecord.dataUrl === 'string' && /^https?:\/\//i.test(imageRecord.dataUrl))
        ? imageRecord.dataUrl
        : '';
      const payload = {
        secret: String(cfg.secret || '').trim(),
        docId:  String(cfg.docId).trim(),
        action: 'appendImage',
        section: String(section || '').trim(),
        imageCaption: imageRecord.label || imageRecord.topic || 'Figure',
        imageSrc:     imageRecord.src || srcFromData || '',
        imageData:    data,
        asciiArt:     imageRecord.asciiArt || '',
      };
      try {
        await this._sendRaw(JSON.stringify(payload));
        log(`🖼 Image saved to Docs: "${payload.imageCaption}"`, 'sys');
      } catch (e) {
        log(`⚠ Image save failed: ${e.message} — falling back to text placeholder.`, 'warn');
        const fallback = imageRecord.asciiArt
          ? `\n📊 FIGURE: ${payload.imageCaption}\n\`\`\`\n${imageRecord.asciiArt}\n\`\`\`\n`
          : `\n[📊 DIAGRAM: ${payload.imageCaption}]\n`;
        await this.post(fallback, section);
      }
    },

  };

  async function postImagesToDoc(images, section) {
    if (!images || !images.length) return;
    const figureBase = Math.max(0, parseInt(progress.images || 0, 10));
    for (let i = 0; i < images.length; i++) {
      const img = images[i];
      if (abortFlag) break;
      const figureIndex = figureBase + i + 1;
      const cap = (img.figureTag && String(img.figureTag).trim())
        ? `${String(img.figureTag).trim()}${img.label && String(img.label).trim() && String(img.label) !== String(img.figureTag) ? ': ' + String(img.label).trim() : ''}`
        : `Figure ${figureIndex}${img.label ? ': ' + img.label : ''}`;
      await DOCS.postImage({ ...img, label: cap }, `${section} — ${cap}`);
    }
  }

  async function postImagePlaceholdersToDoc({ prompts, page, label, wordCount }) {
    if (!Array.isArray(prompts) || !prompts.length) return;
    const lbl = String(label || '').trim();
    const ALLOWED_PLACEHOLDER_LABEL_PREFIXES = [
      'd',                  // domain content pages: d1_s1_p1 ...
      'practice_q_d',       // legacy practice visual placeholders
    ];
    const isAllowed = ALLOWED_PLACEHOLDER_LABEL_PREFIXES.some(prefix => lbl.startsWith(prefix));
    if (!isAllowed) {
      log(`⏭ Placeholder post blocked (invalid section label): "${lbl}"`, 'warn');
      return;
    }
    const section = `${label ? `[${label}] ` : ''}Image Placeholders — Page ${page} — ${examConfig.examName}${wordCount ? ` (~${wordCount}w)` : ''}`;
    const lines = ['###Image Placeholders', ''];
    prompts.forEach((p, i) => {
      const figureTag = String(p.figureTag || `Figure ${i + 1}`).trim();
      const fullPrompt = String(p.prompt || '').trim();
      lines.push(`${i + 1}. [IMAGE PLACEHOLDER — ${figureTag}]`);
      if (fullPrompt) lines.push(fullPrompt);
      lines.push('');
    });
    try {
      await DOCS.post(lines.join('\n'), section);
    } catch (err) {
      log(`⚠ Image placeholder post failed for ${label}: ${err.message}`, 'warn');
    }
  }

  function postPageToDoc({ page, text, images, wordCount, label }) {
    // ── ALLOWED SECTIONS FILTER ──
    // Only post: front-matter (author, copyright, how-to-use, why-trust)
    // AND domain content (overview, purpose, target, memory, subdomain pages)
    // NEVER post: any command, system message, reminder, verification output, or raw GPT ack
    const ALLOWED_LABEL_PREFIXES = [
      'front_author_intro',
      'front_copyright',
      'front_how_to_use',
      'front_why_trust',
      'overview_d',
      'purpose_d',
      'target_covered_d',
      'memory_check_d',
      'd',          // matches d1_s1_p1, d2_s3_p2, etc. (subdomain content pages)
      'practice_q', // legacy / external MCQ appendix labels — still permitted if posting from other tools
    ];
    const lbl = String(label || '');
    const isAllowed = ALLOWED_LABEL_PREFIXES.some(prefix => lbl.startsWith(prefix));
    if (!isAllowed) {
      log(`⏭ Doc post SKIPPED (not in allowed list): "${lbl}"`, 'sys');
      return Promise.resolve();
    }

    const section = `${lbl ? `[${lbl}] ` : ''}Page ${page} — ${examConfig.examName}${wordCount ? ` (~${wordCount}w)` : ''}`;
    return (async () => {
      await DOCS.post(text, section);
      await postImagesToDoc(images, section);
    })();
  }
  // ─────────────────────────────────────────────────────────────
  //  QUALITY + REFERENCE VALIDATION
  // ─────────────────────────────────────────────────────────────
  function detectMissingReference(text) {
    return /MISSING_REFERENCE\s*:/i.test(text) ||
           /REFERENCE_NOT_FOUND\s*:/i.test(text) ||
           /i\s+don'?t\s+have\s+access/i.test(text) ||
           /i\s+cannot\s+find.*reference/i.test(text);
  }

  function validateQuality(text) {
    if (!text || text.length < 200) return false;
    // Forbidden patterns (training-data / placeholder / generic)
    const forbidden = [
      /\[placeholder\]/i,
      /as an ai language model/i,
      /lorem ipsum/i,
      /<insert .* here>/i,
      /\btodo\b:/i,
    /[\u0600-\u06FF]/, // Arabic/Urdu
    /[\u0750-\u077F]/, // Arabic Supplement
    /[\u08A0-\u08FF]/, // Arabic Extended
    /[\u0900-\u097F]/, // Devanagari (Hindi)
    ];
    return !forbidden.some(r => r.test(text));
  }

  function stripSourceMentions(text) {
    return text
      // Full "SOURCE: ..." trailing line that the prompt forces on every page
      .replace(/^\s*SOURCE\s*:.*$/gmi, '')
      // Bracketed source citations GPT sometimes adds inline
      .replace(/\[source\s*:[^\]]+\]/gi, '')
      .replace(/\(see\s+[^)]+?(page|chapter)\s+\d+[^)]*\)/gi, '')
      // Phrases that leak the book / author into the body
      .replace(/according to the reference[^.]*\./gi, '')
      .replace(/as stated in [^.]+\./gi, '')
      // Acknowledgement echoes that occasionally leak through
      .replace(/^\s*(RULES|OUTLINE|SAMPLES|REFERENCE[_\s]*BOOKS?|DOMAIN)[\s_]*(ACKNOWLEDGED|CONFIRMED).*$/gmi, '')
      // Collapse any resulting triple blank lines
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function countWords(text) {
    return (text.trim().split(/\s+/).filter(Boolean) || []).length;
  }

function isMathExamName(name) {
  var n = String(name || '').toLowerCase();
  return /(math|mathematics|calculus|algebra|trigonometry|geometry|statistics|quant|quantitative|aptitude|reasoning)/i.test(n);
}

  // ─────────────────────────────────────────────────────────────
  //  PROGRESS UI
  // ─────────────────────────────────────────────────────────────
  function updateProgressUI() {
    const total = progress.pagesTotal || examConfig.totalPages || 1;
    const done  = Math.min(progress.done, total);
    const pct   = Math.round((done / total) * 100);

    $('#sg-progress-bar').style.width = `${pct}%`;
    $('#sg-progress-pct').textContent = `${pct}%`;
    $('#sg-progress-text').textContent = progress.message || (currentState === STATE.RUNNING
      ? `Generating page ${progress.currentPage}/${total}...`
      : 'Waiting to start...');
    $('#sg-page-counter').textContent = `${done} / ${total} pages`;

    $('#sg-stat-done').textContent    = progress.done;
    $('#sg-stat-failed').textContent  = progress.failed;
    $('#sg-stat-retries').textContent = progress.retries;
    $('#sg-stat-words').textContent   = progress.words.toLocaleString();
    $('#sg-stat-skipped').textContent = `⏭ ${progress.skipped}`;
    $('#sg-stat-images').textContent  = `🖼 ${progress.images}`;

    renderRecent();
  }

  // Checkpoint helpers — persist to storage so close/reload/new-tab can resume.
  function saveCheckpoint(patch) {
    if (patch && typeof patch === 'object') Object.assign(progress, patch);
    saveObj(STORAGE_KEYS.PROGRESS, progress);
  }

  function resumeSummary() {
    const p = progress || {};
    if (!p.phase || p.phase === 'idle' || p.phase === 'done') return null;
    const dIdx = (p.domainIdx || 0) + 1;
    const dTotal = (domains && domains.length) || '?';
    const parts = [`phase=${p.phase}`];
    if (p.phase === 'domain') {
      parts.push(`domain ${dIdx}/${dTotal}`);
      parts.push(`sub=${p.subPhase}`);
      if (p.subPhase === 'content') parts.push(`sub ${((p.subIdx||0)+1)}, page ${p.subPageDone||0}`);
      if (p.subPhase === 'freeResponse') parts.push('free-response');
    }
    return parts.join(' · ');
  }

  /** One line for log: front-matter stages completed + current step + page counts (same storage all tabs). */
  function formatCheckpointForLog() {
    const p = progress || {};
    if (!hasResumableCheckpointProgress(p)) return '';
    const ph = p.phase || 'idle';
    const parts = [];
    const idx = PHASE_ORDER.indexOf(ph);
    if (idx > 1) {
      const done = PHASE_ORDER.slice(1, idx).filter((x) => x !== 'idle' && x !== 'done');
      if (done.length) parts.push(`completed: ${done.join(' → ')}`);
    }
    if (ph && ph !== 'done') parts.push(`cursor: ${ph}`);
    if (ph === 'domain') {
      const rs = resumeSummary();
      if (rs) parts.push(rs);
    }
    const d = +p.done || 0;
    const t = p.pagesTotal || examConfig.totalPages || 0;
    if (d > 0 || t > 0) parts.push(`doc pages ${d}/${t || '?'}`);
    return parts.join(' | ');
  }

  function pushRecent(page, status, detail) {
    progress.recent = progress.recent || [];
    progress.recent.unshift({ page, status, detail, ts: new Date().toLocaleTimeString() });
    progress.recent = progress.recent.slice(0, 12);
  }

  function renderRecent() {
    const box = $('#sg-recent-pages');
    if (!box) return;
    if (!progress.recent || !progress.recent.length) {
      box.innerHTML = `<div style="color:#475569">No pages generated yet.</div>`;
      return;
    }
    const statusIcon = { ok: '✅', fail: '❌', skip: '⏭', retry: '↺' };
    const statusColor = { ok: '#4ade80', fail: '#f87171', skip: '#94a3b8', retry: '#fbbf24' };
    box.innerHTML = progress.recent.map(r => `
      <div class="sg-recent-item">
        <span><b>Page ${r.page}</b> <span style="color:#475569">· ${r.ts}</span></span>
        <span class="sg-recent-status" style="color:${statusColor[r.status] || '#94a3b8'}">
          ${statusIcon[r.status] || '•'} ${escapeHtml(r.detail || '')}
        </span>
      </div>
    `).join('');
  }

  // ─────────────────────────────────────────────────────────────
  //  UI STATE
  // ─────────────────────────────────────────────────────────────
  function setUIState(state) {
    currentState = state;
    const badge = $('#sg-status-badge');
    badge.className = 'badge-' + state.toLowerCase();
    badge.innerHTML = `<span class="badge-dot"></span>${state}`;

    $('#sg-btn-start').disabled  = state === STATE.RUNNING || state === STATE.PAUSED;
    $('#sg-btn-pause').disabled  = state !== STATE.RUNNING;
    // Resume: pauses/errors, OR idle with saved work (reload / new tab) until Reset clears storage.
    const pPeek = loadObj(STORAGE_KEYS.PROGRESS, DEFAULT_PROGRESS);
    const resumeByCheckpoint = (state === STATE.IDLE) && hasResumableCheckpointProgress(pPeek);
    const resumeByControlState = (state === STATE.PAUSED || state === STATE.ERROR || state === STATE.STOPPED);
    $('#sg-btn-resume').disabled = !(resumeByControlState || resumeByCheckpoint);
    $('#sg-btn-stop').disabled   = state === STATE.IDLE || state === STATE.STOPPED;
    $('#sg-btn-retry').disabled  = !(state === STATE.ERROR || state === STATE.PAUSED || state === STATE.STOPPED);
    $('#sg-btn-skip').disabled   = !(state === STATE.RUNNING || state === STATE.PAUSED);
    $('#sg-auto-generate').disabled = state === STATE.RUNNING;
    if (state !== STATE.RUNNING) setActiveGenerationLane('');
    if (state !== STATE.RUNNING) touchControlHeartbeat();
    updateGenerationLaneUI();
  }

  function setActiveGenerationLane(lane) {
    const next = String(lane || '');
    if (next && next !== activeGenerationLane && currentState === STATE.RUNNING) {
      if (next === 'studyguide') announceVoice('Study guide generation is in progress.');
      if (next === 'free_response') announceVoice('Free response question generation has started.');
    }
    activeGenerationLane = next;
    updateGenerationLaneUI();
  }

  function updateGenerationLaneUI() {
    const byId = {
      studyguide: $('#sg-lane-studyguide'),
      free_response: $('#sg-lane-free-response'),
    };
    Object.values(byId).forEach((el) => { if (el) el.classList.remove('active'); });
    if (currentState !== STATE.RUNNING) return;
    if (activeGenerationLane && byId[activeGenerationLane]) {
      byId[activeGenerationLane].classList.add('active');
      return;
    }
    if (progress.phase === 'domain' && progress.subPhase === 'freeResponse') {
      if (byId.free_response) byId.free_response.classList.add('active');
      return;
    }
    if (byId.studyguide) byId.studyguide.classList.add('active');
  }

  function showPopup(title, body, opts = {}) {
    popupContext.mode = String(opts.mode || 'missing_reference');
    $('#sg-popup-title').textContent = title;
    $('#sg-popup-body').textContent  = body;
    const up = $('#sg-popup-upload');
    const sk = $('#sg-popup-skip');
    if (up) up.textContent = String(opts.uploadLabel || '📎 Upload Reference');
    if (sk) {
      sk.textContent = String(opts.skipLabel || '⏭ Skip Page');
      sk.style.display = opts.showSkip === false ? 'none' : '';
    }
    $('#sg-popup-overlay').style.display = 'flex';
    announceVoice(`Attention. ${title}. ${body}`, { minGapMs: 2200 });
  }
  function hidePopup() {
    popupContext.mode = 'missing_reference';
    const up = $('#sg-popup-upload');
    const sk = $('#sg-popup-skip');
    if (up) up.textContent = '📎 Upload Reference';
    if (sk) {
      sk.textContent = '⏭ Skip Page';
      sk.style.display = '';
    }
    $('#sg-popup-overlay').style.display = 'none';
  }

  // ─────────────────────────────────────────────────────────────
  //  LOGGING
  // ─────────────────────────────────────────────────────────────
  const ISSUE_LOG_MAX_ENTRIES = 500;

  function issueLog(level, message, extra) {
    try {
      const entry = Object.assign({
        ts: Date.now(),
        iso: new Date().toISOString(),
        level: String(level || 'info'),
        message: String(message || ''),
      }, extra && typeof extra === 'object' ? extra : {});
      let arr = [];
      try {
        arr = JSON.parse(GM_getValue(STORAGE_KEYS.ISSUE_LOG, '[]'));
      } catch (_) {
        arr = [];
      }
      if (!Array.isArray(arr)) arr = [];
      arr.push(entry);
      while (arr.length > ISSUE_LOG_MAX_ENTRIES) arr.shift();
      GM_setValue(STORAGE_KEYS.ISSUE_LOG, JSON.stringify(arr));
      refreshIssueLogUI();
    } catch (_) {/* ignore */}
  }

  function refreshIssueLogUI() {
    const ta = $('#sg-issue-log');
    if (!ta) return;
    let arr = [];
    try {
      arr = JSON.parse(GM_getValue(STORAGE_KEYS.ISSUE_LOG, '[]'));
    } catch (_) {
      arr = [];
    }
    if (!Array.isArray(arr)) arr = [];
    ta.value = arr.length
      ? arr.map((e) => {
          const meta = Object.keys(e)
            .filter(k => !['ts', 'iso', 'level', 'message'].includes(k))
            .map(k => {
              const v = e[k];
              return `${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`;
            }).join(' ');
          return `[${e.iso || ''}] ${e.level || '?'}: ${e.message || ''}${meta ? ' | ' + meta : ''}`;
        }).join('\n')
      : '// No developer issue-log entries yet. Warnings/errors from the Live Console append here.';
  }

  function downloadIssueLogFile() {
    try {
      const raw = GM_getValue(STORAGE_KEYS.ISSUE_LOG, '[]');
      const blob = new Blob([raw], { type: 'application/json;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `studyguide-issue-log-${Date.now()}.json`;
      a.click();
      setTimeout(() => { try { URL.revokeObjectURL(a.href); } catch (_) {} }, 2500);
      log('Issue log downloaded (JSON).', 'sys');
    } catch (err) {
      log(`Issue log download failed: ${err.message}`, 'error');
    }
  }

  function clearIssueLogManually() {
    let ok = true;
    try { ok = confirm('Clear developer issue log only? (Exam data is not reset.)'); } catch (_) { ok = true; }
    if (!ok) return;
    GM_setValue(STORAGE_KEYS.ISSUE_LOG, '[]');
    refreshIssueLogUI();
    log('Developer issue log cleared.', 'sys');
  }

  /**
   * @param {string} msg
   * @param {'info'|'ok'|'warn'|'error'|'sys'|'img'|string} [type]
   * @param {object|false} [issueExtra]  Merged into developer issue-log for warn/error. Pass `false` to skip issue-log.
   */
  function log(msg, type = 'info', issueExtra) {
    const el = $('#sg-console');
    if (!el) return;
    const time = new Date().toLocaleTimeString();
    const line = document.createElement('div');
    line.className = `log-${type}`;
    line.textContent = `[${time}] ${msg}`;
    el.appendChild(line);
    if (issueExtra !== false && (type === 'error' || type === 'warn')) {
      const base = { source: 'console' };
      issueLog(type, msg, issueExtra && typeof issueExtra === 'object' ? Object.assign(base, issueExtra) : base);
    }
    // Prevent DOM bloat in very long runs
    const MAX_LOG_LINES = 900;
    while (el.childNodes.length > MAX_LOG_LINES) {
      el.removeChild(el.firstChild);
    }
    el.scrollTop = el.scrollHeight;
    voiceAnnounceFromLog(msg, type);
  }

  function voiceAnnounceFromLog(msg, type) {
    if (!voiceConfig.enabled) return;
    const t = String(type || '');
    const m = String(msg || '');
    if (!m) return;

    if (t === 'error') {
      announceVoice(`Issue detected. ${m}`, { minGapMs: 1200, interrupt: true });
      return;
    }
    if (t === 'warn') {
      if (/missing|upload|reference|stopped|failed|cannot|error/i.test(m)) {
        announceVoice(`Warning. ${m}`, { minGapMs: 1500 });
      }
      return;
    }
    if (t === 'ok') {
      if (/complete|coverage verified|posted|saved to docs|done/i.test(m)) {
        announceVoice(`Update. ${m}`, { minGapMs: 1300 });
      }
      return;
    }
    if (t === 'info') {
      if (/domain \d+|starting|resuming|allocating|requesting strict domain|detecting sample mapping/i.test(m)) {
        announceVoice(m, { minGapMs: 1800 });
      }
    }
  }

  function notify(text) {
    try {
      GM_notification({ title: 'StudyGuide v13', text, timeout: 4000 });
    } catch {/* ignore */}
  }

  function tabRuntimeId() {
    if (!window.__sgTabRuntimeId) {
      window.__sgTabRuntimeId = `tab_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    }
    return window.__sgTabRuntimeId;
  }

  function loadControlState() {
    return loadObj(STORAGE_KEYS.CONTROL, DEFAULT_CONTROL);
  }

  function syncUiStateFromControl() {
    try {
      const c = loadControlState();
      const desired = String(c.desiredState || STATE.IDLE);
      const resumable = hasResumableCheckpointProgress(progress);
      if (resumable && (desired === STATE.PAUSED || desired === STATE.STOPPED || desired === STATE.ERROR)) {
        setUIState(desired);
        return;
      }
    } catch (_) {}
    setUIState(STATE.IDLE);
  }

  function markRunInterruptedByTabClose() {
    try {
      if (currentState !== STATE.RUNNING) return;
      updateControlState({ desiredState: STATE.STOPPED });
      saveCheckpoint({ message: 'Stopped — GPT tab was closed. Open ChatGPT and press Resume.' });
    } catch (_) {}
  }

  function wireUnloadProtection() {
    if (_sgUnloadWired) return;
    _sgUnloadWired = true;
    window.addEventListener('pagehide', () => { markRunInterruptedByTabClose(); });
    window.addEventListener('beforeunload', () => { markRunInterruptedByTabClose(); });
  }

  function updateControlState(patch) {
    const c = loadControlState();
    Object.assign(c, patch || {}, { ownerTab: tabRuntimeId(), updatedAt: Date.now() });
    saveObj(STORAGE_KEYS.CONTROL, c);
  }

  function touchControlHeartbeat() {
    const c = loadControlState();
    c.heartbeatTs = Date.now();
    c.ownerTab = c.ownerTab || tabRuntimeId();
    c.updatedAt = Date.now();
    saveObj(STORAGE_KEYS.CONTROL, c);
  }

  function startControlHeartbeat() {
    if (window.__sgControlHeartbeatTimer) return;
    window.__sgControlHeartbeatTimer = setInterval(() => {
      if (currentState === STATE.RUNNING) touchControlHeartbeat();
    }, 2000);
  }

  function startLiveActivityTicker() {
    if (window.__sgLiveTickerTimer) return;
    window.__sgLiveTickerTimer = setInterval(() => {
      if (currentState !== STATE.RUNNING) return;
      const total = progress.pagesTotal || examConfig.totalPages || 0;
      const msg = progress.message || `Running page ${progress.currentPage}/${total || '?'}`;
      log(`📡 Live activity | state=${currentState} | page=${progress.currentPage}/${total || '?'} | done=${progress.done || 0} | failed=${progress.failed || 0} | retries=${progress.retries || 0} | images=${progress.images || 0} | ${msg}`, 'sys');
    }, 15000);
  }

  // ─────────────────────────────────────────────────────────────
  //  UTILS
  // ─────────────────────────────────────────────────────────────
  function $(sel) { return document.querySelector(sel); }

  function loadObj(key, fallback) {
    const clone = () => {
      try { return JSON.parse(JSON.stringify(fallback)); }
      catch (_) { return fallback; }
    };
    try {
      const raw = GM_getValue(key, null);
      if (!raw) return clone();
      const parsed = JSON.parse(raw);
      // Array fallback → return the stored array as-is (no object merging,
      // otherwise `[{...}, {...}]` gets flattened into an index-keyed
      // object and later breaks .reduce / .map / .forEach).
      if (Array.isArray(fallback)) {
        return Array.isArray(parsed) ? parsed : clone();
      }
      // Object fallback → shallow-merge stored fields over defaults.
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return { ...clone(), ...parsed };
      }
      return clone();
    } catch (_) {
      return clone();
    }
  }
  function saveObj(key, obj) {
    GM_setValue(key, JSON.stringify(obj));
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  function extractJSON(text) {
    if (!text) throw new Error('Empty AI response');
    const m = text.match(/```json\s*([\s\S]*?)```/) ||
              text.match(/```\s*([\s\S]*?)```/)   ||
              text.match(/(\{[\s\S]*\})/);
    if (m) {
      try { return JSON.parse(m[1].trim()); } catch { /* fallthrough */ }
    }
    try { return JSON.parse(text.trim()); } catch { /* fallthrough */ }
    return { raw: text };
  }

  function parseBooleanLike(value) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    const s = String(value || '').trim().toLowerCase();
    if (!s) return null;
    if (['true', 'yes', 'y', '1', 'available'].includes(s)) return true;
    if (['false', 'no', 'n', '0', 'not_available', 'not available', 'none'].includes(s)) return false;
    return null;
  }

  /**
   * Map GPT text to slug: school | college-academic | full advanced (university top tier / grad / pro).
   */
  function normalizeDifficultyLevel(value) {
    const raw = String(value || '').trim();
    const s = raw
      .toLowerCase()
      .replace(/[^\w]+/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_+|_+$/g, '');
    if (!s) return 'academic_college_level';
    if (s === 'school_level' || s === 'academic_college_level' || s === 'full_advanced_level') return s;
    if (s.includes('school')) return 'school_level';
    const fullTier =
      (s.includes('full') && s.includes('advanced')) ||
      (s.includes('university') && (s.includes('advanced') || s.includes('full'))) ||
      /doctoral|postdoc|postgraduate|professional\s*board|board\s*exam|licensing/i.test(raw) ||
      /usmle|cfa\s|cpa\s|gate\s|gre\s|gmat|bar\s*exam|mcat|lsat/i.test(raw);
    if (fullTier) return 'full_advanced_level';
    if (s.includes('university') || s.includes('college') || s.includes('academic') || s.includes('undergrad')) {
      return 'academic_college_level';
    }
    return 'academic_college_level';
  }

  /** UI label for slug (readable + slug for Scripts / logs). */
  function formatDifficultyUiLabel(slug) {
    const map = {
      school_level: 'school_level — School/board level exam',
      academic_college_level: 'academic_college_level — College / undergraduate academic',
      full_advanced_level: 'full_advanced_level — Full-advanced university, graduate / professional-board rigor',
    };
    return map[slug] || String(slug || 'academic_college_level');
  }

  function mergeExamProfileFieldsFromGPTPayload(data) {
    const frFromPrimary = parseBooleanLike(data && data.free_response_available);
    const frFromAlt = parseBooleanLike(data && data.freeResponseAvailable);
    const frByQuestionTypes =
      Array.isArray(data?.question_types)
        ? data.question_types.some((t) =>
            /free|essay|subjective|long\s*answer|short\s*answer/i.test(String(t || '')))
        : null;
    const detectedFR =
      frFromPrimary !== null ? frFromPrimary :
        frFromAlt !== null ? frFromAlt :
          frByQuestionTypes !== null ? !!frByQuestionTypes :
            false;
    const detectedDifficulty = normalizeDifficultyLevel(
      data && (data.difficulty_level || data.difficultyLevel) || ''
    );
    return { detectedFR, detectedDifficulty };
  }

  /** Second GPT call after main verification — FR + difficulty confirm. */
  async function fetchExamProfileJsonConfirmationSecondShot() {
    const p = `You are confirming TWO fields for "${examConfig.examName}". Return plain text in this exact shape:
{
  "free_response_available": false,
  "difficulty_level": "academic_college_level"
}

Rules:
1) free_response_available: true ONLY if this exam FORMAT normally includes subjective / long answer / constructed responses (essay, short answer, descriptive) — not ONLY MCQs.

2) difficulty_level — EXACTLY one slug string:
   - "school_level" — school/board level.
   - "academic_college_level" — college / undergraduate academic level (including typical university undergrad).
   - "full_advanced_level" — full advanced university, rigorous graduate exams, doctoral-level items, OR professional/board licensing rigor where appropriate.

Judge from the exam name and well-known norms.`;
    const raw = await sendToGPT(p, 180000, 3, { skipReferenceGuard: true });
    let data = null;
    try {
      data = extractJSON(raw);
    } catch (_) {
      data = null;
    }
    // Fallback parser when GPT returns near-JSON/prose wrappers.
    if (!data || (typeof data === 'object' && data.raw)) {
      const txt = String(raw || '');
      const frM = txt.match(/free_response_available["'\s:=-]+(true|false)/i);
      const dM = txt.match(/difficulty_level["'\s:=-]+(school_level|academic_college_level|full_advanced_level)/i);
      if (frM || dM) {
        data = {
          free_response_available: frM ? /^true$/i.test(String(frM[1])) : false,
          difficulty_level: dM ? String(dM[1]).toLowerCase() : 'academic_college_level',
        };
      }
    }
    if (!data || (typeof data === 'object' && data.raw)) throw new Error('Second-shot profile JSON parse failed');
    return mergeExamProfileFieldsFromGPTPayload(data);
  }

  /** Draggable popup: reminds user to upload FRQ/sample docs before Confirm Samples. */
  async function promptFrqSampleUploadUI(domainNum, domainName) {
    issueLog('phase', 'free_response_wait_upload', { domainNum, domainName: domainName || '' });
    showStepNotify(
      'Free-response samples (after study-guide content for this domain)',
      `Domain ${domainNum} — ${domainName || ''}: Upload FRQ / long-answer sample papers in ChatGPT (same conversation). Then click the purple panel button "FR sample papers uploaded — continue" or "✓ Confirm Samples" under Workflow.`,
    );
    notify('Phase 3: upload FR samples in ChatGPT, then confirm in the panel.');
    const frBtn = $('#sg-frq-sample-confirm');
    if (frBtn) frBtn.style.display = 'block';

    const overlay = $('#sg-book-popup-overlay');
    const body = $('#sg-book-popup-body');
    const hint = $('#sg-book-popup-hint');
    if (!overlay || !body) {
      await waitForConfirm('samples');
      hideStepNotify();
      if (frBtn) frBtn.style.display = 'none';
      return;
    }
    body.innerHTML =
      `<b>Free-response sample upload — Domain ${escapeHtml(domainNum)}: ${escapeHtml(domainName || '')}</b><br><br>` +
      `Study-guide content for this domain is complete.<br><br>` +
      `Upload <b>FRQ / long-answer / subjective exemplar PDFs</b> in ChatGPT, then confirm using the purple <b>FR sample papers uploaded — continue</b> button at the top of the panel (or Workflow → ✓ Confirm Samples).`;
    if (hint) {
      hint.textContent = 'After confirm, GPT will detect FR counts, categories, and stem structure from your uploads.';
    }
    overlay.style.display = 'block';
    await waitForConfirm('samples');
    hideBookPopup();
    hideStepNotify();
    if (frBtn) frBtn.style.display = 'none';
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c =>
      ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  }
  function escapeAttr(s) { return escapeHtml(s); }

  // ─────────────────────────────────────────────────────────────
  //  INIT
  // ─────────────────────────────────────────────────────────────
  // Keep a reference to our DOM nodes so we can re-attach them if ChatGPT's
  // React tree re-renders document.body and nukes them.
  let _sgPanelEl = null;
  let _sgOverlayEls = [];
  let _sgRestoreEl = null;

  function captureMountedNodes() {
    _sgPanelEl   = document.getElementById('sg-panel');
    _sgOverlayEls = [
      document.getElementById('sg-popup-overlay'),
      document.getElementById('sg-book-popup-overlay'),
    ].filter(Boolean);
    _sgRestoreEl = document.getElementById('sg-restore-btn');
  }

  // Re-attach our nodes to document.body if they were removed by a React
  // re-render. Runs cheaply in a MutationObserver.
  let _sgEnsureBusy = false;
  let _sgLastRebuild = 0;
  function hydrateMappingSnapshotsFromStorage() {
    try {
      const snapDomainMap = loadObj(STORAGE_KEYS.SNAP_DOMAIN_MAPPING, null);
      if (snapDomainMap && Array.isArray(snapDomainMap.domains) && snapDomainMap.domains.length) {
        domains = snapDomainMap.domains;
      } else {
        const snapAuto = loadObj(STORAGE_KEYS.SNAP_AUTO_DOMAINS, null);
        if (snapAuto && Array.isArray(snapAuto.domains) && snapAuto.domains.length && (!domains || !domains.length)) {
          domains = snapAuto.domains;
        }
      }
      const snapSample = loadObj(STORAGE_KEYS.SNAP_SAMPLE_MAPPING, null);
      if (snapSample && snapSample.sampleMapping && typeof snapSample.sampleMapping === 'object') {
        sampleMapping = { ...JSON.parse(JSON.stringify(DEFAULT_SAMPLE_MAPPING)), ...snapSample.sampleMapping };
        if (snapSample.sampleMappingMeta && typeof snapSample.sampleMappingMeta === 'object') {
          sampleMappingMeta = { ...JSON.parse(JSON.stringify(DEFAULT_SAMPLE_MAPPING_META)), ...snapSample.sampleMappingMeta };
        }
      }
      if (snapSample && snapSample.freeResponseMapping && typeof snapSample.freeResponseMapping === 'object') {
        const fb = snapSample.freeResponseMapping;
        const pipe = fb.pipeline && typeof fb.pipeline === 'object' ? fb.pipeline : {};
        const mer = fb.merged && typeof fb.merged === 'object' ? fb.merged : {};
        const lastDom = fb.lastMergedFromDomain != null ? String(fb.lastMergedFromDomain) : '';
        freeResponseMapping = { pipeline: { ...pipe }, merged: { ...mer }, lastMergedFromDomain: lastDom };
      }
    } catch (_) {}
  }

  function persistMappingSnapshot(kind) {
    const now = Date.now();
    if (kind === 'auto_domains') {
      saveObj(STORAGE_KEYS.SNAP_AUTO_DOMAINS, { ts: now, examName: examConfig.examName || '', domains });
      return;
    }
    if (kind === 'domain_mapping') {
      saveObj(STORAGE_KEYS.SNAP_DOMAIN_MAPPING, { ts: now, examName: examConfig.examName || '', domains });
      return;
    }
    if (kind === 'page_alloc') {
      saveObj(STORAGE_KEYS.SNAP_PAGE_ALLOC, { ts: now, examName: examConfig.examName || '', domains });
      return;
    }
    if (kind === 'sample_mapping') {
      saveObj(STORAGE_KEYS.SNAP_SAMPLE_MAPPING, {
        ts: now,
        examName: examConfig.examName || '',
        sampleMapping,
        sampleMappingMeta,
        freeResponseMapping,
      });
    }
  }

  function ensureMounted() {
    if (_sgEnsureBusy) return;
    _sgEnsureBusy = true;
    try {
      if (!document.body) return;

      // Fast path: panel is live — refresh our reference and return.
      const live = document.getElementById('sg-panel');
      if (live) { _sgPanelEl = live; return; }

      // Try to re-attach the node we still hold.
      try {
        if (_sgPanelEl && _sgPanelEl.isConnected === false) {
          document.body.appendChild(_sgPanelEl);
        }
      } catch (_) {}
      _sgOverlayEls.forEach(el => {
        try { if (el && el.isConnected === false) document.body.appendChild(el); } catch (_) {}
      });
      try {
        if (_sgRestoreEl && _sgRestoreEl.isConnected === false) {
          document.body.appendChild(_sgRestoreEl);
        }
      } catch (_) {}

      // Only rebuild from scratch as a last resort, and at most every 6s,
      // so we don't fight ChatGPT's re-renders.
      if (!document.getElementById('sg-panel')) {
        const now = Date.now();
        if (now - _sgLastRebuild < 6000) return;
        _sgLastRebuild = now;
        try {
          buildUI();
          captureMountedNodes();
          console.warn('[StudyGuide] Panel was removed by host page — rebuilt.');
        } catch (err) {
          console.error('[StudyGuide] Rebuild failed:', err);
        }
      }
    } finally {
      _sgEnsureBusy = false;
    }
  }

  function startMountGuard() {
    try {
      // Throttled observer — only watches document.body for direct child
      // removals and schedules a single ensureMounted() call at most every
      // 400 ms. This avoids the storm that killed the UI on modern ChatGPT.
      let pending = null;
      const schedule = () => {
        if (pending) return;
        pending = setTimeout(() => { pending = null; ensureMounted(); }, 400);
      };
      const mo = new MutationObserver(muts => {
        for (const m of muts) {
          if (m.removedNodes && m.removedNodes.length) { schedule(); return; }
        }
      });
      if (document.body) {
        mo.observe(document.body, { childList: true, subtree: false });
      }
      // Gentle safety tick
      setInterval(ensureMounted, 4000);
    } catch (err) {
      console.error('[StudyGuide] Mount guard failed:', err);
    }
  }

  function init() {
    try {
      if (document.getElementById('sg-panel')) {
        try {
          bindEvents();
          updateVoiceToggleUI();
          try { openStudyGuidePhaseAccordion('sg-phase-requirement'); } catch (_) {}
          loadCheckpointStateFromStorage();
          syncUiStateFromControl();
          updateProgressUI();
          startControlHeartbeat();
          startLiveActivityTicker();
          wireUnloadProtection();
        } catch (_) {}
        ensurePageVisibilitySync();
        captureMountedNodes();
        return;
      }
      buildUI();
      startControlHeartbeat();
      startLiveActivityTicker();
      wireUnloadProtection();
      captureMountedNodes();
      startMountGuard();
      ensurePageVisibilitySync();
      log('🟢 StudyGuide AI v13 loaded — Text + Gemini Images pipeline ready.', 'ok');
    } catch (err) {
      console.error('[StudyGuide] Init error:', err);
      try { alert('StudyGuide init failed: ' + err.message); } catch (_) {}
    }
  }

  // Install global error listeners so runtime errors are visible in the console
  window.addEventListener('error', (e) => {
    try { log(`✗ JS error: ${e.message} (${e.filename}:${e.lineno})`, 'error'); } catch (_) {}
  });
  window.addEventListener('unhandledrejection', (e) => {
    try { log(`✗ Unhandled promise rejection: ${e.reason && e.reason.message || e.reason}`, 'error'); } catch (_) {}
  });

  // Robust init: wait for document.body + ChatGPT's React mount to settle,
  // then run init. This avoids the "panel flashes then disappears" race where
  // we mount before ChatGPT's first paint and it wipes document.body.
  function ensurePageVisibilitySync() {
    if (_sgPageVisWired) return;
    _sgPageVisWired = true;
    window.addEventListener('pageshow', (ev) => {
      if (!document.getElementById('sg-panel')) return;
      try {
        loadCheckpointStateFromStorage();
        syncUiStateFromControl();
        const hi = formatCheckpointForLog();
        if (hi) {
          log(`📂 ${ev.persisted ? 'bf-cache restore' : 'Page reloaded'} — ${hi}. Resume available if stopped.`, 'sys');
        }
      } catch (e) { console.warn('[StudyGuide] pageshow', e); }
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      if (!document.getElementById('sg-panel')) return;
      try {
        loadCheckpointStateFromStorage();
        syncUiStateFromControl();
      } catch (e) { console.warn('[StudyGuide] visibility', e); }
    });
  }

  function scheduleInit() {
    if (!document.body) {
      document.addEventListener('DOMContentLoaded', scheduleInit, { once: true });
      return;
    }
    // Wait for a ChatGPT-specific anchor (composer / main / textarea) to appear,
    // then wait one more animation frame + 800ms for React hydration.
    const readyMarkers = ['#prompt-textarea', 'main', '[contenteditable="true"]'];
    const hasMarker = () => readyMarkers.some(s => document.querySelector(s));
    if (hasMarker()) {
      requestAnimationFrame(() => setTimeout(init, 800));
      return;
    }
    let tries = 0;
    const poll = setInterval(() => {
      tries++;
      if (hasMarker() || tries > 40) {
        clearInterval(poll);
        requestAnimationFrame(() => setTimeout(init, 800));
      }
    }, 400);
  }

  scheduleInit();
})();