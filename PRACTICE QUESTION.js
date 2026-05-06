// ==UserScript==
// @name         Practice Questions — Standalone (ChatGPT)
// @namespace    https://github.com/local/formater
// @version      1.2.4
// @description  Separate panel to generate MCQ practice only; uses same ChatGPT tab + optional Google Doc post. Turn OFF the main Study Guide script on this tab to avoid two panels.
// @author       Formater
// @match        https://chat.openai.com/*
// @match        https://chatgpt.com/*
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @connect      *
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const APP_ID = 'PQ_STANDALONE_V1';
  const STORAGE = {
    APPS_SCRIPT_URL: `${APP_ID}_appsScriptUrl`,
    DOC_ID: `${APP_ID}_docId`,
    SECRET_KEY: `${APP_ID}_secretKey`,
    UI: `${APP_ID}_ui`,
    PIPELINE: `${APP_ID}_pipeline`,
    TYPE_MAP: `${APP_ID}_typeMap`,
  };

  const pendingConfirm = {
    outline: null,
    samples: null,
    books: null,
    refrecovery: null,
  };

  function loadPipeline() {
    try {
      const raw = GM_getValue(STORAGE.PIPELINE, '');
      const o = raw ? JSON.parse(raw) : {};
      return {
        phase: o.phase || 'idle',
        enteredDomainDetect: !!o.enteredDomainDetect,
        lastSampleTotal: +(o.lastSampleTotal || 0),
        batchesSinceReminder: +(o.batchesSinceReminder || 0),
      };
    } catch (_) {
      return {
        phase: 'idle',
        enteredDomainDetect: false,
        lastSampleTotal: 0,
        batchesSinceReminder: 0,
      };
    }
  }

  let pqPipeline = loadPipeline();

  function savePipeline(patch) {
    pqPipeline = { ...pqPipeline, ...(patch || {}) };
    GM_setValue(STORAGE.PIPELINE, JSON.stringify(pqPipeline));
  }

  function waitForConfirm(kind) {
    return new Promise((resolve) => {
      pendingConfirm[kind] = resolve;
    });
  }

  function extractJSON(md) {
    const s = String(md || '').trim();
    const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const inner = fence ? fence[1] : s;
    const brace = inner.indexOf('{');
    const bracket = inner.indexOf('[');
    let start = -1;
    if (brace >= 0 && (bracket < 0 || brace < bracket)) start = brace;
    else if (bracket >= 0) start = bracket;
    if (start < 0) throw new Error('No JSON found in GPT response');
    const openChar = inner[start];
    const closeChar = openChar === '{' ? '}' : ']';
    let depth = 0;
    let end = -1;
    for (let i = start; i < inner.length; i++) {
      const ch = inner[i];
      if (ch === openChar) depth++;
      if (ch === closeChar) {
        depth--;
        if (depth === 0) {
          end = i + 1;
          break;
        }
      }
    }
    if (end < 0) throw new Error('Unbalanced JSON');
    return JSON.parse(inner.slice(start, end));
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
    );
  }

  /** Scale sample counts → UI target totals (enforce integer & sum = targetTotal). */
  function scaleCountsToTotal(countsObj, targetTotal) {
    const keys = SAMPLE_TYPE_KEYS.slice();
    const raw = {};
    keys.forEach((k) => {
      raw[k] = Math.max(0, parseInt(countsObj && countsObj[k], 10) || 0);
    });
    let sum = keys.reduce((a, k) => a + raw[k], 0);
    const tgt = Math.max(1, parseInt(targetTotal, 10) || 1);
    const out = {};
    if (!sum) {
      return buildEqualTypeBreakdown(tgt);
    }
    let acc = 0;
    keys.forEach((k, idx) => {
      const frac = raw[k] / sum;
      const n = idx < keys.length - 1 ? Math.round(frac * tgt) : tgt - acc;
      out[k] = Math.max(0, n);
      acc += out[k];
    });
    let diff = tgt - acc;
    let qi = 0;
    while (diff !== 0 && qi < 10000) {
      qi++;
      const k = keys[qi % keys.length];
      if (diff > 0) {
        out[k]++;
        diff--;
      } else if (diff < 0 && out[k] > 0) {
        out[k]--;
        diff++;
      }
    }
    return out;
  }

  function saveTypeMapToStorage(obj) {
    GM_setValue(STORAGE.TYPE_MAP, JSON.stringify(obj || {}));
  }

  function loadTypeMapFromStorage() {
    try {
      const raw = GM_getValue(STORAGE.TYPE_MAP, '');
      return raw ? JSON.parse(raw) : {};
    } catch (_) {
      return {};
    }
  }

  function setPanelPipelineActive(on) {
    const p = document.getElementById('pq-panel');
    const banner = document.getElementById('pq-step-banner');
    if (p) p.classList.toggle('pq-pipeline-active', !!on);
    if (banner) banner.style.display = on ? 'block' : 'none';
    if (!on && banner) banner.textContent = '';
  }

  function showPipelineBanner(msg) {
    const el = document.getElementById('pq-step-banner');
    if (el) {
      el.textContent = String(msg || '');
      el.style.whiteSpace = 'pre-wrap';
    }
    setPanelPipelineActive(true);
  }

  function stripCodeFences(s) {
    return String(s || '')
      .replace(/^\s*```(?:json)?\s*/i, '')
      .replace(/\s*```\s*$/, '')
      .trim();
  }

  /** Auto workflow: MCQ batches use refs + reminders; resumes after missing-ref upload */
  async function sendToGPTPractice(prompt, timeoutMs, maxAttempts, depth = 0) {
    const raw = await sendToGPT(prompt, timeoutMs, maxAttempts);
    if (detectReferenceGap(raw) && depth < 3) {
      pqLog('GPT reported missing reference — fix uploads, then Confirm in modal', 'warn');
      savePipeline({ phase: 'ref_gap' });
      showPipelineBanner(
        'Reference gap (REFERENCE_NOT_FOUND / MISSING_REFERENCE).\nUpload the missing reference book(s) in this ChatGPT chat, then click “Reference recovered” below.'
      );
      const overlay = $('#pq-modal-ref');
      if (overlay) overlay.style.display = 'flex';
      await waitForConfirm('refrecovery');
      if (overlay) overlay.style.display = 'none';
      await sendToGPT(
        [
          'RECOVERY: The user uploaded or corrected ALL required reference documents in THIS chat.',
          'Read EVERY uploaded reference book from the beginning of this conversation.',
          'Reply ONLY with this exact token on one line:',
          'REFERENCE_CONFIRMED_THEN_CONTINUE',
        ].join('\n'),
        180000,
        3
      );
      savePipeline({ phase: 'mcq_running' });
      showPipelineBanner('Reference confirmed — continuing question generation.');
      return sendToGPTPractice(prompt, timeoutMs, maxAttempts, depth + 1);
    }
    return raw;
  }

  function resolveWorkflowConfirm(kind) {
    const cb = pendingConfirm[kind];
    if (typeof cb === 'function') {
      pendingConfirm[kind] = null;
      try {
        cb();
      } catch (_) {}
    }
  }

  const PQ_ENFORCEMENT_SUITE = [
    'REFERENCE ENFORCEMENT (paste into GPT when needed)',
    '- Start EVERY batch cycle by re-reading every uploaded reference book before writing answers.',
    '- Use referenced books ONLY — synthesize professionally; NEVER copy exact passages/training fluff.',
    '- No author tone, no student vibe, zero brand chatter — examiner-neutral voice only.',
    '• Force unique stems, stems, explanations, numbering (no recycled templates).',
    '• Charts/graph/table stems require single-Q batches plus detailed visual prompts downstream.',
    '• If a fact is missing → emit REFERENCE_NOT_FOUND / MISSING_REFERENCE (UI will pause for uploads).',
  ];

  /** Second command immediately after PQ_EXAM_RULES_BLOCK ingestion — GPT fills UI-backed fields */
  const PQ_EXAM_VERIFY_DETECT_JSON_PHASE2 = [
    'EXAM_VERIFY_PHASE2_INGEST_DETECT:',
    'You already absorbed the preceding EXAM_VERIFICATION_BATCH instructions for this workspace.',
    'From EVERYTHING inferable IN THIS THREAD (exam name, paper notes, uploads, outlines, disclosed samples)',
    '- Decide if the LIVE exam blueprint visibly includes substantive FREE-RESPONSE / constructed-response prompts (essay, short-answer grids, OSCES write-ups beyond pure MCQs).',
    '- Grade overall calibrated difficulty aspirational tier for STEM writing (foundation | standard | advanced | expert_gate). expert_gate reserved for tertiary board depth.',
    'Return ONLY ONE JSON object. No prose, no markdown fences, no keys beyond schema:',
    '{',
    '  "free_response_in_blueprint": <boolean strictly JSON true|false>,',
    '  "exam_difficulty": "foundation" | "standard" | "advanced" | "expert_gate",',
    '  "notes": "<=120 chars factual justification>"',
    '}',
    'If uploads missing, infer conservatively and lower confidence logically within notes wording.',
  ].join('\n');

  const PQ_EXAM_RULES_BLOCK = [
    'EXAM_RULES_PACKAGE (PLAIN TEXT OUTPUT ONLY)',
    '- Entire MCQ deck: normal text only — no bold, italic, headings (#), markdown fences, or backticks on questions/explanations.',
    '- Advanced professional exam-level only; neutral tone — no student voice, author voice, or brand/company names.',
    '- Use ONLY uploaded reference books in this chat (plus outline/samples already here). Zero reliance on undocumented training guesses.',
    '- Do not copy verbatim sentences from references; synthesize concepts.',
    '- Each item: unique stem, unique options, unique explanation.',
    '- Number sequentially Q1 … Q(target); never repeat numbering within the same generation run.',
    '- Every practice-block reply: NOTHING before the first question line and NOTHING after the final explanation (no greeting, recap, batch narration, or echoes of instructions); only the mandated MCQ template.',
    '',
    'Format per question:',
    'Q<number>. statement',
    '(A) option one',
    '(B) option two',
    '(C) …',
    'Answer : single letter (A,B,C,…)',
    'Explanation: one paragraph-style block — develop exactly three conceptual anchors: (1) why the keyed line is correct, (2) principle the item tests,',
    '(3) why other lines fail without naming option letters. About 5–7 lines dense prose; no bullets; no "(A)/(B)" in explanation.',
  ].join('\n');

  const PQ_DOMAIN_MAPPING_PROMPT = [
    'You are mapping an uploaded OUTLINE plus reference books already in this ChatGPT conversation.',
    'Return ONLY compact plain-text lines in this schema (no markdown, no numbering):',
    'TopicLeaf | CanonicalSubtopic | TypicalScenario | TypicalTrap | TypicalNumericPattern',
    '- One conceptual row per leaf topic (exam-relevant density). Max 120 lines.',
  ].join('\n');

  const PQ_SAMPLE_DETECT_JSON_PROMPT = [
    'The user uploaded a SAMPLE QUESTION FILE in this chat that represents the target exam blueprint.',
    'Analyze EVERY question in that file (MCQ sections only for type mix; separately count FREE_RESPONSE items if present).',
    'Return ONLY a single JSON object (no prose) with:',
    '{',
    '  "total_mcq_detected": <number>,',
    '  "free_response_count": <number>,',
    '  "type_counts": { "scenarioBased","definitionType","recallStatement","applicationBased","fillInTheBlanks","tableBased","chartsGraphsImg" },',
    '  "statement_word_targets": same keys optional average word counts per type (integers)',
    '}',
    'If unsure for a bucket use 0. Never invent unseen question types.',
  ].join('\n');

  function readTypePlanFromUi(totalQ) {
    const tgt = Math.max(1, parseInt(totalQ, 10) || 1);
    const fromInputs = {};
    let sum = 0;
    SAMPLE_TYPE_KEYS.forEach((k) => {
      const el = document.getElementById(`pq-plan-${k}`);
      const n = el ? parseInt(el.value, 10) : 0;
      const v = Number.isFinite(n) ? Math.max(0, n) : 0;
      fromInputs[k] = v;
      sum += v;
    });
    if (sum <= 0) return buildEqualTypeBreakdown(tgt);
    if (sum === tgt) return fromInputs;
    return scaleCountsToTotal(fromInputs, tgt);
  }

  function fillTypePlanUi(planned, stmtLens) {
    SAMPLE_TYPE_KEYS.forEach((k) => {
      const pe = document.getElementById(`pq-plan-${k}`);
      const se = document.getElementById(`pq-stmt-${k}`);
      if (pe && planned && planned[k] != null) pe.value = String(Math.max(0, parseInt(planned[k], 10) || 0));
      if (se && stmtLens && stmtLens[k] != null) se.value = String(Math.max(6, parseInt(stmtLens[k], 10) || 0));
    });
  }

  function applyVisualToggleToBreakdown(br) {
    const out = { ...(br || {}) };
    const chartOk = $('#pq-vis-chart');
    const tableOk = $('#pq-vis-table');
    if (chartOk && !chartOk.checked) out.chartsGraphsImg = 0;
    if (tableOk && !tableOk.checked) out.tableBased = 0;
    const need = Math.max(1, parseInt(String(($('#pq-total') && $('#pq-total').value) || '1'), 10) || 1);
    let sum = SAMPLE_TYPE_KEYS.reduce((acc, k) => acc + (parseInt(out[k], 10) || 0), 0);
    if (sum === need) return out;
    if (sum <= 0) return buildEqualTypeBreakdown(need);
    return scaleCountsToTotal(out, need);
  }

  /** Injected into every MCQ synthesis prompt — no assistant preamble/epilogue besides required blocks */
  const PQ_MCQ_PURIST_OUTPUT_GUARDS = [
    'PURE MCQ OUTPUT (hard): Your entire reply MUST be NOTHING except the mandated question payloads.',
    '- First printable line = start of first question artefact ONLY: "Type:" OR "Table:" OR the first numbered "Q#. " stem line (whatever this template dictates for that batch). Absolutely NO preamble.',
    '- After the LAST required "Explanation:" block (and mandated separator "=" row if continuing), NOTHING else — NO footnote, apology, recap, counts, echoes of prompt, disclaimers list, "---", headings, bullets about rules.',
    '- Do NOT paste batch/domain meta, quotas, numbering commentary, greetings ("Sure!", "Certainly"), or confirmations.',
    '- ONLY exception allowed: if truly impossible, reply is EXACTLY one line containing ONLY REFERENCE_NOT_FOUND or ONLY MISSING_REFERENCE and nothing else.',
  ].join('\n');

  /** After every 5 *completed* sequential MCQ generation rounds, send standalone ACK command to GPT before next stems. */
  const PQ_BATCH_RULE_ACK_COMMAND = [
    'RULES_ACK_SEQUENCE_CHECKPOINT:',
    'Five sequential MCQ generation batches were just FINISHED successfully in THIS run.',
    'Before writing the next stems:',
    '(1) Re-read ALL uploaded reference books in THIS chat mentally.',
    '(2) USE ONLY referenced materials plus chat context — synthesize professionally, no verbatim quoting, examiner-neutral wording.',
    '(3) All MCQ OUTPUT stays plain normal text — no markdown bold (#, ** ), no decorative headings.',
    '',
    'Reply ONLY this single token on its own line: ACK_RULE_BATCH_THEN_CONTINUE_MCQ',
  ].join('\n');

  function detectReferenceGap(text) {
    const t = String(text || '');
    return /\bREFERENCE[\s_:]*NOT\s*FOUND\b/i.test(t) || /\bMISSING_REFERENCE\b/i.test(t);
  }

  const GPT_MEMORY_GUARDS = { MAX_PROMPT_CHARS: 22000 };

  const SAMPLE_TYPE_KEYS = [
    'scenarioBased',
    'definitionType',
    'recallStatement',
    'applicationBased',
    'fillInTheBlanks',
    'tableBased',
    'chartsGraphsImg',
  ];

  let abortFlag = false;
  let pauseFlag = false;
  let pqImageCounter = 0;
  let runBusy = false;

  /** Last mounted root — ChatGPT’s React shell often wipes `body` children; we re-append this node if detached. */
  let _pqPanelEl = null;
  let _pqEnsureBusy = false;
  let _pqMountGuardStarted = false;
  let _pqMountBusy = false;

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function $(sel, root) {
    return (root || document).querySelector(sel);
  }

  function pqLog(msg, level) {
    const ta = $('#pq-log');
    const line = `[${new Date().toLocaleTimeString()}] ${level === 'error' ? '✗' : level === 'warn' ? '⚠' : '•'} ${msg}\n`;
    if (ta) {
      ta.value = (ta.value + line).slice(-12000);
      ta.scrollTop = ta.scrollHeight;
    }
    try {
      console.log(`[PQ] ${msg}`);
    } catch (_) {}
  }

  function isOnGPT() {
    const h = location.hostname || '';
    return h.includes('chatgpt') || h.includes('openai');
  }

  function alphaLetters(n) {
    const out = [];
    for (let i = 0; i < n && i < 26; i++) out.push(String.fromCharCode(65 + i));
    return out;
  }

  function buildEqualTypeBreakdown(totalQ) {
    const n = Math.max(1, parseInt(totalQ, 10) || 1);
    const keys = SAMPLE_TYPE_KEYS.slice();
    const breakdown = {};
    const base = Math.floor(n / keys.length);
    let rem = n - base * keys.length;
    keys.forEach((k, i) => {
      breakdown[k] = base + (i < rem ? 1 : 0);
    });
    return breakdown;
  }

  function typeLabel(key) {
    return (
      {
        scenarioBased: 'Scenario-based',
        definitionType: 'Definition',
        recallStatement: 'Recall / Statemental',
        applicationBased: 'Application',
        fillInTheBlanks: 'Fill in the blanks',
        tableBased: 'Table based',
        chartsGraphsImg: 'Chart / Graph / Image based',
      }[key] || key
    );
  }

  function normalizeType(t) {
    const s = String(t || '').toLowerCase();
    if (s.includes('scenario')) return 'scenarioBased';
    if (s.includes('def')) return 'definitionType';
    if (s.includes('recall') || s.includes('statement')) return 'recallStatement';
    if (s.includes('application') || s.includes('apply')) return 'applicationBased';
    if (s.includes('fill') || s.includes('blank')) return 'fillInTheBlanks';
    if (s.includes('table') || s.includes('tabular')) return 'tableBased';
    if (s.includes('chart') || s.includes('graph') || s.includes('image') || s.includes('plot')) return 'chartsGraphsImg';
    return 'definitionType';
  }

  function getTypeStatementWordLimit(typeKey, fallbackMax) {
    const fb = Math.max(6, parseInt(fallbackMax, 10) || 25);
    const inp = document.getElementById(`pq-stmt-${typeKey}`);
    if (inp) {
      const n = parseInt(inp.value, 10);
      if (Number.isFinite(n) && n >= 6) return n;
    }
    const tm = loadTypeMapFromStorage();
    const w =
      tm && tm.statement_word_targets && Number.isFinite(parseInt(tm.statement_word_targets[typeKey], 10))
        ? parseInt(tm.statement_word_targets[typeKey], 10)
        : null;
    if (w != null && w >= 6) return w;
    return fb;
  }

  /** Strip ChatGPT markdown/bold noise so MCQ source stays plain. */
  function sanitizePracticeGPTRawText(s) {
    const lines = String(s || '').replace(/\r/g, '').split('\n');
    const out = [];
    for (let line of lines) {
      if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
        out.push('');
        continue;
      }
      line = line.replace(/^\s*>\s?/, '').replace(/^\s{0,3}#{1,6}\s+/, '');
      line = line.replace(/\*\*/g, '').replace(/__/g, '').replace(/`/g, '');
      out.push(line);
    }
    return out.join('\n');
  }

  /** Remove assistant prelude before parse (model sometimes ignores PURIST_GUARDS). */
  function stripMcqLeadingAssistantFluff(text) {
    const lines = String(text || '').split('\n');
    let i = 0;
    while (i < lines.length) {
      const raw = lines[i];
      const t = raw.trim();
      if (!t) {
        i++;
        continue;
      }
      if (/^REFERENCE[\s_:]*NOT\s*FOUND\b/i.test(t) || /\bMISSING_REFERENCE\b/i.test(t)) return lines.slice(i).join('\n');
      if (/^type\s*:/i.test(t) || /^table\s*:/i.test(t))
        return lines.slice(i).join('\n');
      if (/^q(?:no\.?)?\s*\d+[\.)]\s*.+/i.test(t)) return lines.slice(i).join('\n');
      i++;
    }
    return lines.join('\n');
  }

  function stripPracticeExplanationOptionRefs(s) {
    let t = String(s || '')
      .replace(/\r/g, '')
      .replace(/\*\*/g, '')
      .replace(/__/g, '')
      .replace(/`/g, '')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    t = t.replace(/\b(option|choice)s?\s+[A-F]\b/gi, 'that distractor');
    t = t.replace(/\b(answer|correct\s+answer)\s+(is|=)\s+[A-F]\b/gi, 'the keyed response aligns with the reference principle');
    t = t.replace(/\b(?:the\s+)?(?:correct|right)\s+(?:option|choice|answer)\s+(?:is|was)\s+[A-F]\b/gi, 'the keyed response follows this principle');
    t = t.replace(/\b(?:the\s+)?(?:incorrect|wrong)\s+(?:option|choice|answer)\s+(?:is|was)\s+[A-F]\b/gi, 'that distractor fails this test');
    t = t.replace(/\b[A-F]\s+is\s+(?:not\s+)?(?:correct|incorrect|right|wrong)\b/gi, 'that line of reasoning is evaluated against the concept');
    t = t.replace(/\b(?:choices?|options?)\s+(?:marked|labeled)\s+[A-F]\b/gi, 'alternatives framed in the stem');
    t = t.replace(/\b(?:letter|label)\s+[A-F]\b/gi, 'that alternative');
    t = t.replace(/\(\s*([A-F])\s*\)/g, ' ');
    t = t.replace(/\bchoices?\s+like\s+[A-F]\b/gi, 'incorrect lines of reasoning');
    t = t.replace(/\b\d\)\s*[A-F]\b/gi, ' ');
    t = t.replace(/\b[A-F]\s*[,:–-]\s*(?:correct|incorrect|right|wrong)\b/gi, ' ');
    t = t.replace(/\b(?:options?|choices?)\s+[A-F](?:\s*[,/]\s*[A-F])*\b/gi, 'the listed alternatives');
    t = t.replace(/\b(?:factual\s+overview|why\s+the\s+correct\s+choice\s+matches\s+the\s+reference|why\s+other\s+choices?\s+fail)\s*:?/gi, '')
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();
    return t;
  }

  function fallbackParseQuestionsFromText(rawText) {
    const lines = sanitizePracticeGPTRawText(stripMcqLeadingAssistantFluff(rawText)).split('\n');
    const out = [];
    let i = 0;
    let pendingType = '';
    let pendingTable = '';
    while (i < lines.length) {
      const t = (lines[i] || '').trim();
      const typeMatch = t.match(/^Type\s*:\s*(.+)$/i);
      if (typeMatch) {
        pendingType = String(typeMatch[1] || '').trim();
        i++;
        continue;
      }
      if (/^Table\s*:/i.test(t)) {
        const tableLines = [];
        i++;
        while (i < lines.length) {
          const tl = String(lines[i] || '');
          const tx = tl.trim();
          if (!tx) {
            i++;
            continue;
          }
          if (
            /^\|/.test(tx) ||
            /^\+[-+]+\+$/.test(tx) ||
            /^[-]{3,}\s+[-]{3,}/.test(tx) ||
            /[,;\t]/.test(tx) ||
            /^col(?:umn)?\s*\d+/i.test(tx) ||
            /^\w+\s*\|\s*\w+/.test(tx)
          ) {
            tableLines.push(tx);
            i++;
            continue;
          }
          break;
        }
        pendingTable = tableLines.join('\n').trim();
        continue;
      }
      const qMatch = t.match(/^Q(?:no\.?)?\s*(\d+)[\.\)]\s+(.+)$/i) || t.match(/^Q?\s*(\d+)[\.\)]\s+(.+)$/i);
      if (!qMatch) {
        i++;
        continue;
      }
      const q = {
        statement: qMatch[2].trim(),
        options: {},
        correct_answer: '',
        explanation: '',
        type: pendingType || '',
        tableData: pendingTable || '',
      };
      pendingType = '';
      pendingTable = '';
      i++;
      while (i < lines.length) {
        const ln = (lines[i] || '').trim();
        const opt = ln.match(/^\(([A-Z])\)\s+(.+)$/);
        if (opt) {
          q.options[opt[1]] = opt[2];
          i++;
          continue;
        }
        if (/^Answer\s*:/i.test(ln)) {
          q.correct_answer = ln.replace(/^Answer\s*:\s*/i, '').trim().charAt(0).toUpperCase();
          i++;
          continue;
        }
        if (/^Explanation\s*:/i.test(ln)) {
          let exp = ln.replace(/^Explanation\s*:\s*/i, '').trim();
          i++;
          while (i < lines.length) {
            const nx = (lines[i] || '').trim();
            if (!nx) {
              i++;
              continue;
            }
            if (/^=+$/.test(nx)) {
              i++;
              break;
            }
            if (/^Q(?:no\.?)?\s*\d+[\.\)]\s+/i.test(nx) || /^Q?\s*\d+[\.\)]\s+/.test(nx)) break;
            if (/^\(([A-Z])\)\s+/.test(nx) || /^Answer\s*:/i.test(nx)) break;
            exp += (exp ? '\n' : '') + nx;
            i++;
          }
          q.explanation = exp.trim();
          continue;
        }
        if (/^Q(?:no\.?)?\s*\d+[\.\)]\s+/i.test(ln) || /^Q?\s*\d+[\.\)]\s+/.test(ln)) break;
        i++;
      }
      if (q.statement && Object.keys(q.options).length) out.push(q);
    }
    return out;
  }

  function normalizePracticeQuestions(arr, cfg) {
    const out = [];
    const explMinWords = Math.max(1, parseInt(cfg?.explMinWords, 10) || 80);
    const explMaxWords = Math.max(explMinWords, parseInt(cfg?.explMaxWords, 10) || 250);
    const explMinLines = Math.max(1, parseInt(cfg?.explMinLines, 10) || 5);
    const explMaxLines = Math.max(explMinLines, parseInt(cfg?.explMaxLines, 10) || 7);
    const explLineMinWords = Math.max(1, parseInt(cfg?.explLineMinWords, 10) || 10);
    const explLineMaxWords = Math.max(explLineMinWords, parseInt(cfg?.explLineMaxWords, 10) || 22);
    const seen = cfg && cfg.seenSet instanceof Set ? cfg.seenSet : new Set();
    const letters = Array.isArray(cfg?.optionLetters) ? cfg.optionLetters : [];
    const answerUsage = cfg && cfg.answerUsage && typeof cfg.answerUsage === 'object' ? cfg.answerUsage : {};
    const pickBalancedAnswer = (validLetters) => {
      const list = validLetters.filter(Boolean);
      if (!list.length) return '';
      let min = Infinity;
      list.forEach((l) => {
        min = Math.min(min, parseInt(answerUsage[l] || 0, 10));
      });
      const candidates = list.filter((l) => parseInt(answerUsage[l] || 0, 10) === min);
      return candidates[Math.floor(Math.random() * candidates.length)];
    };
    const normalizeExplanationLines = (exp, minLines, maxLines) => {
      const minL = Math.max(1, parseInt(minLines, 10) || 1);
      const maxL = Math.max(minL, parseInt(maxLines, 10) || minL);
      let rows = String(exp || '')
        .replace(/\r/g, '\n')
        .split('\n')
        .map((x) => x.replace(/\s+/g, ' ').trim())
        .filter(Boolean);
      if (rows.length <= 1) {
        const sentenceSplit = String(exp || '')
          .replace(/\r/g, ' ')
          .split(/(?<=[.!?])\s+/)
          .map((x) => x.replace(/\s+/g, ' ').trim())
          .filter(Boolean);
        if (sentenceSplit.length) rows = sentenceSplit;
      }
      while (rows.length < minL) {
        let expanded = false;
        for (let i = 0; i < rows.length && rows.length < minL; i++) {
          const parts = rows[i].split(/\s*,\s*/).map((x) => x.trim()).filter(Boolean);
          if (parts.length >= 2) {
            rows.splice(i, 1, ...parts);
            expanded = true;
            break;
          }
        }
        if (!expanded) break;
      }
      while (rows.length > maxL) {
        rows[maxL - 1] = `${rows[maxL - 1]} ${rows[maxL]}`.replace(/\s+/g, ' ').trim();
        rows.splice(maxL, 1);
      }
      while (rows.length < minL && rows.length) rows.push(rows[rows.length - 1]);
      return rows.join('\n').trim();
    };
    const looksTooBasic = (text) => {
      const tx = String(text || '').toLowerCase();
      if (!tx) return true;
      return /\b(basic|easy|simple|introductory|definition only|define|list any two|state two points|what is)\b/.test(tx);
    };
    const explanationLooksValid = (exp) => {
      const raw = String(exp || '').replace(/\r/g, '').trim();
      const lines = raw.split('\n').map((s) => s.trim()).filter(Boolean);
      const text = lines.join(' ');
      if (!text) return false;
      const wc = text.split(/\s+/).filter(Boolean).length;
      if (wc < explMinWords || wc > explMaxWords) return false;
      if (lines.length < explMinLines || lines.length > explMaxLines) return false;
      for (const ln of lines) {
        const lw = ln.split(/\s+/).filter(Boolean).length;
        if (lw < explLineMinWords || lw > explLineMaxWords) return false;
      }
      if (/\b(?:factual\s+overview|why\s+the\s+correct\s+choice\s+matches\s+the\s+reference|why\s+other\s+choices?\s+fail)\b/i.test(text)) return false;
      if (/(?:^|\s)\([A-F]\)|\boption\s+[A-F]\b|\bchoice\s+[A-F]\b|\banswer\s+[A-F]\b/i.test(text)) return false;
      if (/\b[A-F]\s+is\s+(?:not\s+)?(?:correct|incorrect|right|wrong)\b/i.test(text)) return false;
      if (/\b(?:correct|incorrect|right|wrong)\s+(?:option|choice|answer)\b/i.test(text)) return false;
      return true;
    };
    for (const rawQ of Array.isArray(arr) ? arr : []) {
      const q = rawQ && typeof rawQ === 'object' ? rawQ : {};
      const typeKey = q.type ? normalizeType(q.type) : normalizeType(cfg?.forcedTypeKey || 'definitionType');
      const rawStatement = String(q.statement || q.question || '').replace(/\s+/g, ' ').trim();
      const maxWords = Math.max(6, parseInt(cfg?.forcedTypeMaxWords || cfg?.maxStatementWords || 120, 10) || 120);
      const exactWords = Math.max(6, parseInt(cfg?.forcedTypeExactWords || maxWords, 10) || maxWords);
      const statement = rawStatement
        .replace(/^type\s*:\s*[^.:\n]+[.:\-]?\s*/i, '')
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, maxWords)
        .join(' ')
        .trim();
      const statementWordCount = statement ? statement.split(/\s+/).filter(Boolean).length : 0;
      if (statementWordCount !== exactWords) continue;
      if (looksTooBasic(statement)) continue;
      const dedupeBase = `${statement}::${JSON.stringify(q.options || {})}`;
      if (!dedupeBase) continue;
      const dedupeKey = `${typeKey}::${String(dedupeBase).toLowerCase()}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      const cleaned = {
        statement,
        type: typeKey,
        subdomain: String(q.subdomain || '').trim(),
        reference_topic: String(q.reference_topic || '').trim(),
        tableData: String(q.tableData || '').trim(),
        explanation: stripPracticeExplanationOptionRefs(String(q.explanation || '')).trim(),
        options: {},
        correct_answer: '',
      };
      if (!cleaned.explanation) cleaned.explanation = 'Explanation not provided with sufficient reasoning detail.';
      cleaned.explanation = normalizeExplanationLines(cleaned.explanation, explMinLines, explMaxLines);
      cleaned.explanation = stripPracticeExplanationOptionRefs(cleaned.explanation).trim();
      if (looksTooBasic(cleaned.explanation)) continue;
      if (!explanationLooksValid(cleaned.explanation)) continue;

      const srcOpts = q.options && typeof q.options === 'object' ? q.options : {};
      const seenOptText = new Set();
      for (const l of letters) {
        const v = String(srcOpts[l] || '')
          .replace(/\r/g, '')
          .replace(/[ \t]+\n/g, '\n')
          .replace(/\n{3,}/g, '\n\n')
          .trim();
        if (!v) continue;
        const dedupeOpt = v.toLowerCase();
        if (seenOptText.has(dedupeOpt)) continue;
        seenOptText.add(dedupeOpt);
        cleaned.options[l] = v;
      }
      if (!Object.keys(cleaned.options).length) continue;
      for (const l of letters) {
        if (!Object.prototype.hasOwnProperty.call(cleaned.options, l)) {
          cleaned.options[l] = `Option ${l}`;
        }
      }

      let ca = String(q.correct_answer || q.answer || '').trim().toUpperCase();
      ca = ca ? ca.charAt(0) : '';
      if (!ca || !Object.prototype.hasOwnProperty.call(cleaned.options, ca)) {
        ca = pickBalancedAnswer(Object.keys(cleaned.options)) || Object.keys(cleaned.options)[0] || '';
      }
      cleaned.correct_answer = ca;
      answerUsage[ca] = (parseInt(answerUsage[ca] || 0, 10) || 0) + 1;
      out.push(cleaned);
    }
    return out;
  }

  function enforceBatchTypeQuota(questions, quotaByType) {
    const src = Array.isArray(questions) ? questions : [];
    const out = [];
    const used = {};
    Object.keys(quotaByType || {}).forEach((k) => {
      used[k] = 0;
    });
    const activeTypes = Object.keys(quotaByType || {}).filter((k) => (parseInt((quotaByType || {})[k], 10) || 0) > 0);
    const pickNextType = () => {
      let best = '';
      let bestNeed = -1;
      activeTypes.forEach((k) => {
        const want = Math.max(0, parseInt((quotaByType || {})[k], 10) || 0);
        const have = Math.max(0, parseInt(used[k] || 0, 10) || 0);
        const need = want - have;
        if (need > bestNeed) {
          bestNeed = need;
          best = k;
        }
      });
      return best || activeTypes[0] || 'definitionType';
    };
    for (const q of src) {
      let t = normalizeType(q && q.type);
      if (!q || !q.type) {
        t = pickNextType();
        if (q && typeof q === 'object') q.type = t;
      }
      let want = Math.max(0, parseInt((quotaByType || {})[t], 10) || 0);
      if (want <= 0) {
        const mapped = pickNextType();
        const mappedWant = Math.max(0, parseInt((quotaByType || {})[mapped], 10) || 0);
        if (mappedWant <= 0) continue;
        t = mapped;
        if (q && typeof q === 'object') q.type = t;
        want = Math.max(0, parseInt((quotaByType || {})[t], 10) || 0);
      }
      if ((used[t] || 0) >= want) continue;
      out.push(q);
      used[t] = (used[t] || 0) + 1;
    }
    return out;
  }

  function buildPracticeVisualPrompts({ questions, domainName, domainNum, batchIdx, startNumber, imageBase }) {
    const arr = Array.isArray(questions) ? questions : [];
    const out = [];
    const baseFigure = Math.max(0, parseInt(imageBase, 10) || 0);
    const startIdx = Math.max(1, parseInt(startNumber, 10) || 1) - 1;
    let visualCount = 0;
    for (let i = 0; i < arr.length; i++) {
      const q = arr[i] || {};
      const t = normalizeType(q.type);
      const stmtProbe = String(q.statement || '').toLowerCase();
      const chartHint = /chart|graph|plot|trend|histogram|bar\s*chart|line\s*graph|pie\s*chart|data\s*set|distribution/i.test(stmtProbe);
      if (t !== 'chartsGraphsImg' && !chartHint) continue;
      visualCount++;
      const figureNum = baseFigure + visualCount;
      const statement = String(q.statement || '').replace(/\s+/g, ' ').trim();
      const topic = String(q.reference_topic || q.subdomain || `Domain ${domainNum} visual concept`).trim();
      const qNo = startIdx + i + 1;
      out.push({
        qNumber: qNo,
        figureTag: `Figure ${figureNum}`,
        label: `Practice Visual Q${qNo} — ${topic}`,
        prompt: `Label for this infographic: Figure ${figureNum} — ${topic}
Create a BLACK-AND-WHITE textbook infographic only (no color).
Use clear layout with title, axes/table headings (if data), and concise labels.
Keep it exam-focused and data-accurate for the given scenario.
Required content anchor: ${statement || `Practice question ${qNo} context`}.
Include all relevant entities, values, units, and relationships.
No watermark, no decorative icons, no branding, no extra narrative.
Output should be print-friendly monochrome educational style.`.trim(),
      });
    }
    return out;
  }

  function assistantNodeToMarkdown(node) {
    if (!node) return '';
    const root = node.cloneNode(true);
    root.querySelectorAll('h1').forEach((el) => el.replaceWith(`# ${(el.textContent || '').trim()}\n\n`));
    root.querySelectorAll('h2').forEach((el) => el.replaceWith(`### ${(el.textContent || '').trim()}\n\n`));
    root.querySelectorAll('h3').forEach((el) => el.replaceWith(`### ${(el.textContent || '').trim()}\n\n`));
    root.querySelectorAll('h4,h5,h6').forEach((el) => el.replaceWith(`### ${(el.textContent || '').trim()}\n\n`));
    root.querySelectorAll('table').forEach((tbl) => {
      const rows = Array.from(tbl.querySelectorAll('tr')).map((tr) =>
        Array.from(tr.querySelectorAll('th,td')).map((td) => (td.textContent || '').replace(/\s+/g, ' ').trim())
      ).filter((r) => r.length && r.some(Boolean));
      if (!rows.length) {
        tbl.replaceWith('\n');
        return;
      }
      const header = rows[0];
      const sep = header.map(() => '---');
      const body = rows.slice(1);
      let md = `| ${header.join(' | ')} |\n| ${sep.join(' | ')} |\n`;
      body.forEach((r) => {
        while (r.length < header.length) r.push('');
        md += `| ${r.slice(0, header.length).join(' | ')} |\n`;
      });
      tbl.replaceWith(`\n${md}\n`);
    });
    root.querySelectorAll('strong,b').forEach((el) => el.replaceWith(`**${(el.textContent || '').trim()}**`));
    root.querySelectorAll('em,i').forEach((el) => el.replaceWith(`*${(el.textContent || '').trim()}*`));
    root.querySelectorAll('li').forEach((el) => el.replaceWith(`- ${(el.textContent || '').trim()}\n`));
    root.querySelectorAll('br').forEach((el) => el.replaceWith('\n'));
    root.querySelectorAll('p').forEach((el) => el.replaceWith(`${(el.textContent || '').trim()}\n\n`));
    return (root.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
  }

  const GPT = {
    getInput() {
      return (
        document.getElementById('prompt-textarea') ||
        document.querySelector('.ProseMirror[contenteditable="true"]') ||
        document.querySelector('[contenteditable="true"][role="textbox"]') ||
        document.querySelector('textarea[data-id="root"]') ||
        document.querySelector('textarea[placeholder]')
      );
    },
    getSend() {
      return (
        document.querySelector('[data-testid="send-button"]') ||
        document.querySelector('button[aria-label*="Send" i]') ||
        document.querySelector('button[aria-label="Send prompt"]')
      );
    },
    getStop() {
      return document.querySelector('[data-testid="stop-button"]') || document.querySelector('button[aria-label*="Stop" i]');
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
      return (last.textContent || '').trim();
    },

    async injectText(text) {
      let el = this.getInput();
      if (!el) {
        await sleep(800);
        el = this.getInput();
      }
      if (!el) throw new Error('ChatGPT textarea not found');
      try {
        el.focus();
        await sleep(40);
        el.innerHTML = '';
        el.dispatchEvent(new Event('input', { bubbles: true }));
        await sleep(60);
      } catch (_) {}

      try {
        el.focus();
        document.execCommand('selectAll', false, null);
        document.execCommand('delete', false, null);
        await sleep(30);
        document.execCommand('insertText', false, text);
        await sleep(150);
        if ((el.textContent || el.value || '').trim().length > 20) return true;
      } catch (_) {}

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

      try {
        el.focus();
        el.textContent = text;
        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
        await sleep(300);
        return true;
      } catch (e) {
        throw new Error('inject failed: ' + e.message);
      }
    },

    async clickSend() {
      for (let i = 0; i < 30; i++) {
        const btn = this.getSend();
        if (btn && !btn.disabled) {
          btn.click();
          return true;
        }
        await sleep(100);
      }
      return false;
    },

    async send(text) {
      const el = this.getInput();
      if (el) {
        try {
          el.innerHTML = '';
          el.dispatchEvent(new Event('input', { bubbles: true }));
        } catch (_) {}
        await sleep(50);
      }
      const ok = await this.injectText(text);
      if (!ok) throw new Error('Text injection failed');
      await sleep(150);
      const sent = await this.clickSend();
      if (!sent) throw new Error('Send button failed');
      await sleep(200);
    },

    waitForDone(timeoutMs) {
      const timeout = timeoutMs || 300000;
      return new Promise((resolve, reject) => {
        const start = Date.now();
        const initCount = this.countMsgs();
        let lastLen = 0;
        let lastText = '';
        let stable = 0;
        let started = false;
        let stoppedAt = 0;
        let lastGrowthAt = Date.now();
        const STALE_STREAM_IDLE_MS = 90000;
        const POLL_MS = 300;
        const STOP_GRACE = 400;
        const STABLE_NEED = 2;
        let staleBailLogged = false;

        const t = setInterval(() => {
          if (abortFlag) {
            clearInterval(t);
            reject(new Error('Aborted'));
            return;
          }
          if (pauseFlag) return;
          if (Date.now() - start > timeout) {
            clearInterval(t);
            reject(new Error(`GPT response timeout (${Math.round(timeout / 1000)}s)`));
            return;
          }
          let streaming = this.isStreaming();
          const count = this.countMsgs();
          const text = this.getLatest();
          const len = text.length;
          if (len > lastLen) lastGrowthAt = Date.now();
          const idleNoGrowthMs = Date.now() - lastGrowthAt;
          if (streaming && started && idleNoGrowthMs >= STALE_STREAM_IDLE_MS && len >= 40) {
            streaming = false;
            if (!staleBailLogged) {
              staleBailLogged = true;
              pqLog(`Streaming idle ${Math.round(idleNoGrowthMs / 1000)}s — treating as done`, 'warn');
            }
          }
          if (!started) {
            if (streaming || count > initCount) started = true;
            lastLen = len;
            return;
          }
          if (streaming) {
            stable = 0;
            stoppedAt = 0;
            lastLen = len;
            lastText = text;
            return;
          }
          if (stoppedAt === 0 && len > 0) stoppedAt = Date.now();
          if (stoppedAt > 0 && Date.now() - stoppedAt < STOP_GRACE) return;
          if (len > 0 && len === lastLen && text === lastText) {
            stable++;
            if (stable >= STABLE_NEED) {
              clearInterval(t);
              resolve(text);
            }
          } else {
            stable = 0;
            lastLen = len;
            lastText = text;
          }
        }, POLL_MS);
      });
    },
  };

  async function sendToGPT(prompt, timeoutMs, maxAttempts) {
    let lastErr = null;
    const attempts = Math.max(1, maxAttempts || 3);
    let finalPrompt = String(prompt || '');
    if (finalPrompt.length > GPT_MEMORY_GUARDS.MAX_PROMPT_CHARS) {
      finalPrompt =
        finalPrompt.slice(0, GPT_MEMORY_GUARDS.MAX_PROMPT_CHARS) + '\n\n[TRUNCATED FOR TAB STABILITY]';
      pqLog('Prompt truncated for memory guard', 'warn');
    }
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        pqLog(`GPT attempt ${attempt}/${attempts}`, 'sys');
        await GPT.send(finalPrompt);
        const resp = await GPT.waitForDone(timeoutMs || 300000);
        if (!resp || !String(resp).trim()) throw new Error('Empty GPT response');
        return resp;
      } catch (err) {
        lastErr = err;
        pqLog(`Attempt failed: ${err.message}`, 'warn');
        if (attempt < attempts) await sleep(Math.min(1500 * attempt, 6000));
      }
    }
    throw lastErr || new Error('GPT request failed');
  }

  const PQ_DOCS = {
    _cfg() {
      return {
        url: String(GM_getValue(STORAGE.APPS_SCRIPT_URL, '') || '').trim(),
        docId: String(GM_getValue(STORAGE.DOC_ID, '') || '').trim(),
        secret: String(GM_getValue(STORAGE.SECRET_KEY, '') || '').trim(),
      };
    },
    _sendRaw(rawData) {
      const cfg = this._cfg();
      if (!cfg.url || !cfg.docId) return Promise.reject(new Error('Missing URL or Doc ID'));
      return new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method: 'POST',
          url: cfg.url,
          headers: { 'Content-Type': 'application/json; charset=UTF-8', Accept: 'application/json, */*' },
          data: rawData,
          timeout: 90000,
          onload: (r) => {
            if (r.status >= 200 && r.status < 400) {
              try {
                const resp = JSON.parse(r.responseText || '{}');
                if (resp.status === 'error') reject(new Error(resp.message || 'Apps Script error'));
                else resolve();
              } catch (_) {
                resolve();
              }
            } else reject(new Error(`HTTP ${r.status}`));
          },
          onerror: () => reject(new Error('Network error')),
          ontimeout: () => reject(new Error('Timeout')),
        });
      });
    },
    async sendWithRetry(content, section) {
      const cfg = this._cfg();
      const payload = {
        secret: cfg.secret,
        docId: cfg.docId,
        action: 'append',
        section: String(section || '').trim(),
        content: String(content || ''),
      };
      for (let i = 0; i < 5; i++) {
        try {
          await this._sendRaw(JSON.stringify(payload));
          pqLog(`Docs saved: "${section.slice(0, 60)}…"`, 'ok');
          return;
        } catch (e) {
          pqLog(`Docs retry ${i + 1}/5: ${e.message}`, 'warn');
          if (i < 4) await sleep(Math.min(2000 * (i + 1), 12000));
        }
      }
      throw new Error('Docs post failed');
    },
    async post(content, section) {
      let text = String(content || '').replace(/^\n+/, '').replace(/\n+$/, '');
      if (!text) return;
      if (text.length <= 40000) {
        await this.sendWithRetry(text, section);
        return;
      }
      const paragraphs = text.split('\n\n');
      let chunk = '';
      let idx = 1;
      for (const p of paragraphs) {
        const add = p + '\n\n';
        if (chunk.length > 0 && chunk.length + add.length > 40000) {
          await this.sendWithRetry(chunk, `${section} (Part ${idx})`);
          chunk = add;
          idx++;
        } else chunk += add;
      }
      if (chunk.replace(/\n/g, '').trim()) await this.sendWithRetry(chunk, `${section} (Part ${idx})`);
    },
    async postQuestions(args) {
      const { domain, domainNum, batchIdx, startNumber, questions, visualPrompts = [] } = args || {};
      const lines = [`Practice Questions — Domain ${domainNum}: ${domain} (Batch ${batchIdx})`, ''];
      const startIdx = Math.max(1, parseInt(startNumber, 10) || 1) - 1;
      const visualByQn = {};
      (Array.isArray(visualPrompts) ? visualPrompts : []).forEach((p) => {
        const qn = parseInt(p && p.qNumber, 10);
        if (qn) visualByQn[qn] = p;
      });
      questions.forEach((q, i) => {
        const n = startIdx + i + 1;
        const cleanPlain = (v) =>
          String(v || '')
            .replace(/\*\*/g, '')
            .replace(/__/g, '')
            .replace(/`/g, '')
            .replace(/\r/g, ' ')
            .replace(/\n+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
        const cleanExplanation = (v) => {
          const rows = stripPracticeExplanationOptionRefs(v)
            .split('\n')
            .map((x) => x.replace(/\s+/g, ' ').trim())
            .filter(Boolean);
          return rows.join('\n');
        };
        const stmt = cleanPlain(q.statement || q.question || '');
        const visual = visualByQn[n];
        if (visual) {
          const fig = String(visual.figureTag || '').trim() || 'Figure';
          const pr = String(visual.prompt || '').replace(/\s+/g, ' ').trim().slice(0, 1200);
          lines.push(`[IMAGE PLACEHOLDER — Q${n} — ${fig} — PROMPT: ${pr}]`);
        }
        if (normalizeType(q.type) === 'tableBased' || String(q.tableData || '').trim()) {
          const tableRaw = String(q.tableData || '').trim();
          if (tableRaw) {
            lines.push('Table:');
            tableRaw.split('\n').forEach((row) => {
              const cleanedRow = String(row || '').replace(/\r/g, '').trim();
              if (cleanedRow) lines.push(cleanedRow);
            });
          } else {
            lines.push('Table:');
            lines.push('| Item | Value |');
            lines.push('|---|---|');
            lines.push('| Data 1 | Data 2 |');
          }
        }
        lines.push(`Q${n}. ${stmt}`);
        const opts = q.options || {};
        for (let ci = 65; ci <= 90; ci++) {
          const k = String.fromCharCode(ci);
          if (!Object.prototype.hasOwnProperty.call(opts, k)) continue;
          const v = cleanPlain(opts[k] || '');
          if (v) lines.push(`(${k}) ${v}`);
        }
        if (q.correct_answer) lines.push(`Answer: ${String(q.correct_answer).trim()}`);
        if (q.explanation) {
          const exRows = cleanExplanation(q.explanation).split('\n').filter(Boolean);
          if (exRows.length) {
            lines.push(`Explanation: ${exRows[0]}`);
            exRows.slice(1).forEach((ln) => lines.push(ln));
          }
        }
        lines.push('');
      });
      const sectionTitle = `Practice Questions — Domain ${domainNum} (Batch ${batchIdx})`;
      await this.post(lines.join('\n'), sectionTitle);
    },
  };

  function coerceBooleanLoose(v) {
    if (v === true || v === false) return v;
    const s = String(v || '').trim().toLowerCase();
    if (s === 'true' || s === 'yes' || s === '1') return true;
    if (s === 'false' || s === 'no' || s === '0' || !s) return false;
    return !!v;
  }

  function applyExamVerifyDetectPayload(det) {
    const raw = det && typeof det === 'object' ? det : {};
    const fr = coerceBooleanLoose(raw.free_response_in_blueprint);
    let diff =
      typeof raw.exam_difficulty === 'string' ? raw.exam_difficulty.trim().toLowerCase() : '';
    const allowed = new Set(['foundation', 'standard', 'advanced', 'expert_gate']);
    if (!allowed.has(diff)) diff = 'advanced';
    const cb = $('#pq-free-response-followup');
    const di = $('#pq-exam-difficulty-level');
    if (cb) cb.checked = fr;
    if (di) di.value = diff;
    const merged = Object.assign(loadTypeMapFromStorage(), {
      exam_difficulty_level: diff,
      free_response_blueprint_from_verify: fr,
      exam_verify_phase2_notes: String(raw.notes || '').slice(0, 200),
      exam_verify_detected_at: Date.now(),
    });
    saveTypeMapToStorage(merged);
    pqLog(
      `Phase-2 ingest: FR blueprint=${fr} · tier=${diff} · ${merged.exam_verify_phase2_notes}`,
      'ok'
    );
  }

  async function runFreeResponseSynthesisAfterMcq(opts) {
    const { domainName, domainNum, totalQ, postDoc, suppressFinishAlert } = opts || {};
    const follow = $('#pq-free-response-followup');
    const enable = !!(follow && follow.checked);
    if (!enable) {
      pqLog('Free-response synthesis skipped — blueprint flagged false (exam verify)', 'sys');
      return false;
    }
    if (!isOnGPT() || abortFlag) return false;
    const tm = loadTypeMapFromStorage();
    let planned = Math.max(0, parseInt(tm.planned_fr_at_target, 10) || 0);
    if (!planned) {
      try {
        const fx = $('#pq-fr-detect-result') && $('#pq-fr-detect-result').value;
        const o = fx ? JSON.parse(fx) : {};
        planned = Math.max(0, parseInt(o.free_response_scaled_to_target, 10) || 0);
      } catch (_) {
        planned = 0;
      }
    }
    if (!planned) {
      planned = Math.max(
        1,
        Math.min(80, Math.round(Math.max(1, parseInt(totalQ, 10) || 1) * 0.06))
      );
      pqLog(`FR quota heuristic ${planned} (no sample-scaled quota stored)`, 'warn');
    }
    const tier = (($('#pq-exam-difficulty-level') && $('#pq-exam-difficulty-level').value) || 'advanced')
      .trim()
      .replace(/\s+/g, '_')
      .slice(0, 32);
    /** FR numbering stays separate from MCQ Q index (always FR‑1…) */
    let frDone = 0;
    pqLog(`Starting free-response synthesis: ~${planned} items · tier ${tier}`, 'sys');
    const baseGuards = [
      'OUTPUT = ONLY free-response artefacts (no prelude/postscript, no greetings).',
      'Plain text ONLY — NO markdown headings, bold, backticks wrapping whole blocks.',
    ].join('\n');
    while (frDone < planned && !abortFlag) {
      const chunk = Math.min(10, planned - frDone);
      const lo = frDone + 1;
      const hi = frDone + chunk;
      const payload = `${baseGuards}

WRITE ${chunk} substantive FREE RESPONSE practice task(s) for Domain-${domainNum}: "${domainName}".

Difficulty calibration MUST match ingest tier="${tier}" (${tier}: foundation recall → expert_gate tertiary boards).

REFERENCE discipline identical to MCQ runs: citations live only mentally from uploaded refs in-thread; never fabricate named references absent in chat.

Number tasks FR-${lo} … FR-${hi} sequentially (global FR series this run; independent MCQ numbering).

Each artefact FORMAT (repeat per item):
FR-<n>. [multi-sentence clinician-grade prompt spanning required depth]
Suggested_response_outline: [3–7 concise clinician bullet lines referencing concepts only]

==================

ZERO extra chatter outside artefacts.`;

      try {
        const raw = await sendToGPTPractice(payload, 420000, 3);
        const clean = sanitizePracticeGPTRawText(raw).trim();
        if (postDoc) {
          await PQ_DOCS.post(clean, `Free Response Tasks — Domain ${domainNum} (FR ${lo}–${hi})`);
        }
        pqLog(`FR chunk posted ${chunk} (FR-${lo}–FR-${hi}) · Docs=${postDoc ? 'yes' : 'no'}`, 'ok');
      } catch (e) {
        pqLog(`FR chunk failed: ${e.message}`, 'error');
        break;
      }
      frDone += chunk;
      await sleep(200);
    }
    pqLog(`Free-response phase finished (${frDone}/${planned}).`, frDone >= planned ? 'ok' : 'warn');
    if (!suppressFinishAlert) {
      try {
        window.alert(
          `Free-response generation ${frDone}/${planned} complete (Docs posting ${postDoc ? 'ON' : 'OFF'}).`
        );
      } catch (_) {}
    }
    return frDone > 0;
  }

  async function runExamVerificationPressed() {
    if (!isOnGPT()) {
      pqLog('Open ChatGPT tab first.', 'warn');
      return;
    }
    const exam =
      (($('#pq-exam-name') && $('#pq-exam-name').value) || '').trim() ||
      (($('#pq-domain-name') && $('#pq-domain-name').value) || '').trim();
    const examPaper =
      (($('#pq-exam-paper') && $('#pq-exam-paper').value) || '').trim() || '';
    const examNotes =
      (($('#pq-exam-notes') && $('#pq-exam-notes').value) || '').trim() || '';
    if (!exam) {
      pqLog('Set Exam name (Requirements) or domain/topic name first.', 'warn');
      return;
    }
    const header = [`EXAM_VERIFICATION_BATCH exam_name=${JSON.stringify(exam)}`];
    if (examPaper) header.push(`exam_paper_section=${JSON.stringify(examPaper)}`);
    if (examNotes) header.push(`requirements_notes=${JSON.stringify(examNotes)}`);
    const cmd = [header.join('\n'), '', PQ_EXAM_RULES_BLOCK].join('\n');
    try {
      pqLog('Exam verification phase 1: rules package…', 'sys');
      await sendToGPT(cmd, 240000, 3);
      savePipeline({ phase: 'post_verify', lastVerifyAt: Date.now() });
      pqLog('Exam verification phase 1 complete.', 'ok');
    } catch (e) {
      pqLog(`Exam verification phase 1 failed: ${e.message}`, 'error');
      return;
    }
    try {
      pqLog('Exam verification phase 2: FR blueprint + difficulty JSON…', 'sys');
      const rawDetect = await sendToGPT(PQ_EXAM_VERIFY_DETECT_JSON_PHASE2, 180000, 3);
      applyExamVerifyDetectPayload(extractJSON(rawDetect));
      saveUiBlob();
      pqLog('Exam verification phase 2 stored in panel + stash.', 'ok');
    } catch (e2) {
      pqLog(`Exam verification phase 2 skipped/failed (UI unchanged): ${e2.message}`, 'warn');
    }
  }

  async function sendSampleFreeResponseTriple(totalTarget) {
    const c1 =
      'USER_CONFIRM: Sample uploads for redistribution are finalized in this chat. Reply exactly: SAMPLE_REDIST_CONFIRMED.';
    await sendToGPT(c1, 180000, 3);
    const c2 =
      PQ_SAMPLE_DETECT_JSON_PROMPT +
      '\nAppend key "free_response_categories": string[] listing distinct FR styles you observe (short labels).';
    const raw2 = await sendToGPT(c2, 300000, 3);
    const j = extractJSON(raw2);
    const tgt = Math.max(1, parseInt(totalTarget, 10) || 1);
    const sampleMcqTotal = Math.max(
      1,
      parseInt(j.total_mcq_detected, 10) ||
        SAMPLE_TYPE_KEYS.reduce((a, k) => a + (parseInt((j.type_counts || {})[k], 10) || 0), 0)
    );
    const frInSample = Math.max(0, parseInt(j.free_response_count, 10) || 0);
    const predictedFr =
      sampleMcqTotal > 0 ? Math.round((frInSample / sampleMcqTotal) * tgt) : 0;

    const frEl = $('#pq-fr-detect-result');
    if (frEl) {
      frEl.value = JSON.stringify(
        {
          free_response_scaled_to_target: predictedFr,
          free_response_categories: j.free_response_categories || [],
          raw_sample_totals: { mcq: sampleMcqTotal, free_response_in_file: frInSample },
        },
        null,
        2
      );
    }

    GM_setValue(
      STORAGE.TYPE_MAP,
      JSON.stringify({
        ...(j || {}),
        planned_fr_at_target: predictedFr,
      })
    );

    pqLog(
      `Post-MCQ redistribution: scaled free-response quota ≈ ${predictedFr} (from sample FR ${frInSample}/${sampleMcqTotal})`,
      'ok'
    );
  }

  async function runOutlineSamplePipelineOrchestration() {
    if (runBusy) {
      pqLog('Busy', 'warn');
      return;
    }
    GM_setValue(STORAGE.APPS_SCRIPT_URL, ($('#pq-url') && $('#pq-url').value).trim());
    GM_setValue(STORAGE.DOC_ID, ($('#pq-doc') && $('#pq-doc').value).trim());
    GM_setValue(STORAGE.SECRET_KEY, ($('#pq-secret') && $('#pq-secret').value).trim());

    if (!isOnGPT()) {
      pqLog('Open ChatGPT tab first.', 'warn');
      return;
    }
    const dn = (($('#pq-domain-name') && $('#pq-domain-name').value) || '').trim();
    if (!dn) {
      pqLog('Domain / topic required', 'warn');
      return;
    }

    setPanelPipelineActive(true);
    showPipelineBanner(
      '[Pipeline]\n1) Upload OUTLINE material to this ChatGPT chat.\n2) Click “Outline uploaded ✓”.'
    );
    pqLog('Pipeline idle — awaiting outline confirmation', 'sys');

    try {
      await waitForConfirm('outline');

      pqLog('Sending outline acknowledgment + domain mapping request…', 'sys');
      await sendToGPT(
        [
          'PIPELINE_STAGE_OUTLINE_CONFIRMED:',
          `Domain label (UI): "${dn}".`,
          'User uploaded an outline bundle in-thread. Acknowledge and internalize headings + coverage.',
          'Reply briefly: OUTLINE_ACK_AND_DOMAIN_MAP_READY',
        ].join('\n'),
        180000,
        3
      );

      const dRaw = await sendToGPT(PQ_DOMAIN_MAPPING_PROMPT, 240000, 3);
      const dma = $('#pq-domain-map');
      if (dma) dma.value = stripCodeFences(dRaw).slice(0, 12000);
      pqLog('Domain mapping text stored in Workflow panel.', 'ok');
      savePipeline({ phase: 'post_domain', enteredDomainDetect: true });

      showPipelineBanner(
        '[Pipeline]\n1) Upload SAMPLE exam questions.\n2) Click “Samples uploaded ✓”.'
      );
      pqLog('Awaiting sample batch confirmation…', 'sys');

      await waitForConfirm('samples');

      pqLog('Sample phase: confirm + detectors + redistribution…', 'sys');
      await sendToGPT(
        [
          'PIPELINE_STAGE_SAMPLES_CONFIRMED:',
          `Domain: "${dn}". Samples uploaded in-thread — memorize style, verbosity, blueprint.`,
          'Reply exactly: SAMPLE_FILES_INGESTED',
        ].join('\n'),
        180000,
        3
      );

      const detRaw = await sendToGPT(PQ_SAMPLE_DETECT_JSON_PROMPT, 300000, 3);
      const det = extractJSON(detRaw);

      const totalQ = Math.max(1, parseInt($('#pq-total').value, 10) || 50);
      const scaled = scaleCountsToTotal(det.type_counts || {}, totalQ);
      const stmt = det.statement_word_targets || {};

      fillTypePlanUi(scaled, stmt);
      saveTypeMapToStorage({
        type_counts_observed: det.type_counts || {},
        statement_word_targets: stmt,
        planned_counts_target: scaled,
        total_ui: totalQ,
        free_response_observed: det.free_response_count || 0,
      });

      const distPrompt = [
        `Redistribution check: TARGET_TOTAL_MCQ=${totalQ}`,
        JSON.stringify({ planned_counts: scaled, statement_targets: stmt }, null, 2),
        'Reply JSON only {"ok":true,"accept":"planned_counts_aligned"} ',
      ].join('\n');
      await sendToGPT(distPrompt, 180000, 2);

      pqLog('Detector + plan saved — starting MCQ engine', 'sys');
      savePipeline({
        phase: 'mcq_running',
        batchesSinceReminder: 0,
        batchesDone: 0,
      });

      await runStandalonePracticeGeneration({ orchestratedPipeline: true });
    } catch (err) {
      pqLog(`Pipeline error: ${err.message}`, 'error');
      showPipelineBanner(`Pipeline halted: ${err.message}`);
    } finally {
      setPanelPipelineActive(false);
      showPipelineBanner('');
    }
  }

  async function pqAutoDetectDomainMap() {
    if (!isOnGPT()) return;
    try {
      const raw = await sendToGPT(
        PQ_DOMAIN_MAPPING_PROMPT + `\nFocused domain keyword: "${($('#pq-domain-name').value || '').trim()}"`,
        240000,
        3
      );
      const dma = $('#pq-domain-map');
      if (dma) dma.value = stripCodeFences(raw).slice(0, 12000);
      pqLog('Domain map auto-fill complete', 'ok');
    } catch (e) {
      pqLog(e.message, 'error');
    }
  }

  async function pqSampleQuestionsAutoDetect() {
    if (!isOnGPT()) return;
    try {
      const raw = await sendToGPT(PQ_SAMPLE_DETECT_JSON_PROMPT, 300000, 3);
      const j = extractJSON(raw);
      const totalQ = Math.max(1, parseInt($('#pq-total').value, 10) || 50);
      const scaled = scaleCountsToTotal(j.type_counts || {}, totalQ);
      fillTypePlanUi(scaled, j.statement_word_targets || {});
      saveTypeMapToStorage({
        type_counts_observed: j.type_counts || {},
        statement_word_targets: j.statement_word_targets || {},
        planned_counts_target: scaled,
      });
      pqLog(`Sample blueprint stored · ${totalQ} target rows filled`, 'ok');
    } catch (e) {
      pqLog(e.message, 'error');
    }
  }

  async function pqFreeResponseAutoDetect() {
    if (!isOnGPT()) return;
    try {
      const prompt = [
        'Analyze ALL free-response prompts present in uploaded sample decks in-thread.',
        'Return ONLY JSON:',
        '{"free_response_count":N,"categories":["..."],"notes":"short"}',
      ].join('\n');
      const raw = await sendToGPT(prompt, 240000, 3);
      const j = extractJSON(raw);
      const frEl = $('#pq-fr-detect-result');
      if (frEl) frEl.value = JSON.stringify(j, null, 2);
      const nFR = parseInt(j.free_response_count, 10) || 0;
      if (nFR > 0) {
        const cb = $('#pq-free-response-followup');
        if (cb) cb.checked = true;
        pqLog('Auto FR scan: count>0 → follow-up checkbox ON', 'ok');
      }
      pqLog('Free-response classifier JSON cached in panel', 'ok');
    } catch (e) {
      pqLog(e.message, 'error');
    }
  }

  function readUiPracticeConfig() {
    let gmin = parseInt($('#pq-expl-minw').value, 10) || 80;
    let gmax = parseInt($('#pq-expl-maxw').value, 10) || 250;
    if (gmin > gmax) [gmin, gmax] = [gmax, gmin];
    let lmin = parseInt($('#pq-expl-lines-min').value, 10) || 5;
    let lmax = parseInt($('#pq-expl-lines-max').value, 10) || 7;
    if (lmin > lmax) [lmin, lmax] = [lmax, lmin];
    let lwmin = parseInt($('#pq-expl-line-minw').value, 10) || 10;
    let lwmax = parseInt($('#pq-expl-line-maxw').value, 10) || 22;
    if (lwmin > lwmax) [lwmin, lwmax] = [lwmax, lwmin];
    return {
      explMinWords: gmin,
      explMaxWords: gmax,
      explMinLines: lmin,
      explMaxLines: lmax,
      explLineMinWords: lwmin,
      explLineMaxWords: lwmax,
    };
  }

  function buildPracticePrompt({
    domainName,
    domainNum,
    absStartQ,
    absEndQ,
    targetBatch,
    currentType,
    currentTypeMaxWords,
    optionLetters,
    splitLines,
  }) {
    const examPaper =
      (($('#pq-exam-paper') && $('#pq-exam-paper').value) || '').trim() || '';
    const examNotes =
      (($('#pq-exam-notes') && $('#pq-exam-notes').value) || '').trim() || '';
    let examCtx = '';
    if (examPaper || examNotes) {
      examCtx =
        `\nExam labels for internal alignment ONLY (never print these labels verbatim in MCQ lines): paper_section=` +
        JSON.stringify(examPaper || '—') +
        ` · requirements_notes=` +
        JSON.stringify(examNotes || '—');
    }
    const examTierSel = (($('#pq-exam-difficulty-level') && $('#pq-exam-difficulty-level').value) || '').trim();
    if (examTierSel) {
      examCtx +=
        `\nexam_difficulty_tier (internal cue ONLY — echo nowhere in output)` +
        `=${JSON.stringify(examTierSel)} (foundation<easier … expert_gate=highest).`;
    }
    return `Generate ${targetBatch} objective practice MCQ question(s) for Domain-${domainNum}: "${domainName}".${examCtx}

${PQ_MCQ_PURIST_OUTPUT_GUARDS}

Suggested type mix for this batch:
${splitLines}

Hard requirements:
- Questions must be UNIQUE across all batches in this domain.
- Numbering must continue globally for this domain: start from Q${absStartQ} and end at Q${absEndQ}. Do NOT restart from Q1 in this batch.
- Use ONLY the user's uploaded reference books (all of them) plus any study/guide text already produced in THIS chat — advanced professional synthesis, no unrelated training lore.
- If needed materials are truly absent, output exactly REFERENCE_NOT_FOUND or MISSING_REFERENCE (one token) so automation can pause; otherwise synthesize from uploaded books only.
- Calibrate BOTH stems and rationales to ingest difficulty tier ${
      examTierSel ? JSON.stringify(examTierSel) : '"advanced"'
    } — NEVER easier nor cartoon-simple relative to tier; never regress below calibrated rigor.
- Tone must be professional and neutral.
- Keep output plain normal text only (no bold/markdown styling).
- Rendering discipline (critical): do NOT use # ## ### headings. Do NOT use **bold**, __underscores__, italic asterisks, or backticks on Type, Q statement, options, Answer, Explanation, or separators. NEVER wrap an entire batch in formatting.
- ONLY exception: type "tableBased" may use markdown pipe rows under Table:; all MCQ lines after remain plain ASCII.
- For "${typeLabel(currentType)}", each question statement MUST be exactly ${currentTypeMaxWords} words (hard rule).
- Include "Type: ${currentType}" line for each question block.
- Explanation MUST be exactly 5 to 7 lines, concept-rich and exam-level (no MCQ letters A–E in explanation — concept-only wording).
- If type is "tableBased", include a compact markdown pipe table BEFORE each question.
- If type is "chartsGraphsImg", question must be chart/graph based.

Use this plain text format:
Type: ${currentType}
Table: [only for tableBased, otherwise omit]
Q${absStartQ}. [statement]
(${optionLetters[0]}) [option text]
(${optionLetters[1] || 'B'}) [option text]
${optionLetters.slice(2).map((l) => `(${l}) [option text]`).join('\n')}
Answer: [single correct option letter]
Explanation: [multi-line explanation]
==================

Hard repeat: ZERO extra text outside the mandated blocks (see PURE MCQ OUTPUT above).

Keep output in simple text, no markdown fences, and avoid JSON.`;
  }

  async function runStandalonePracticeGeneration(opts) {
    const orchestratedPipeline = !!(opts && opts.orchestratedPipeline);
    if (runBusy) {
      pqLog('Already running', 'warn');
      return;
    }
    if (!isOnGPT()) {
      pqLog('Open chatgpt.com first.', 'warn');
      return;
    }

    GM_setValue(STORAGE.APPS_SCRIPT_URL, $('#pq-url').value.trim());
    GM_setValue(STORAGE.DOC_ID, $('#pq-doc').value.trim());
    GM_setValue(STORAGE.SECRET_KEY, $('#pq-secret').value.trim());

    const postDoc = $('#pq-post-docs').checked;
    if (postDoc) {
      const u = GM_getValue(STORAGE.APPS_SCRIPT_URL, '').trim();
      const d = GM_getValue(STORAGE.DOC_ID, '').trim();
      if (!u || !d) {
        pqLog('Docs posting on: need Web App URL + Doc ID (or disable posting)', 'warn');
        return;
      }
    }

    const domainName = $('#pq-domain-name').value.trim();
    const domainNum = Math.max(1, parseInt($('#pq-domain-num').value, 10) || 1);
    if (!domainName) {
      pqLog('Enter domain/topic name', 'warn');
      return;
    }

    const totalQ = Math.max(1, parseInt($('#pq-total').value, 10) || 50);
    const batchLockEl = $('#pq-batch-lock');
    const batchLocked = !!(batchLockEl && batchLockEl.checked);
    if (batchLocked) {
      $('#pq-batch').value = '10';
    }
    let batchCap = Math.min(10, Math.max(1, parseInt($('#pq-batch').value, 10) || 10));
    if (batchLocked) batchCap = 10;
    const optionsCount = Math.min(10, Math.max(2, parseInt($('#pq-options').value, 10) || 4));
    const stmtWords = Math.max(6, parseInt($('#pq-stmt-w').value, 10) || 25);

    let nextQN = Math.max(1, parseInt($('#pq-next-q').value, 10) || 1);
    let produced = nextQN - 1;

    const pc = readUiPracticeConfig();

    let typeBreakdown = buildEqualTypeBreakdown(totalQ);
    let planSum = 0;
    SAMPLE_TYPE_KEYS.forEach((k) => {
      const el = document.getElementById(`pq-plan-${k}`);
      planSum += el ? parseInt(el.value, 10) || 0 : 0;
    });
    const useTypePlanUi = orchestratedPipeline || planSum > 0;
    if (useTypePlanUi) {
      typeBreakdown = applyVisualToggleToBreakdown(readTypePlanFromUi(totalQ));
    } else {
      const uiMix = $('#pq-type-mix').value;
      if (uiMix === 'definition') {
        typeBreakdown = {};
        SAMPLE_TYPE_KEYS.forEach((k) => {
          typeBreakdown[k] = k === 'definitionType' ? totalQ : 0;
        });
      } else if (uiMix === 'scenario') {
        typeBreakdown = {};
        SAMPLE_TYPE_KEYS.forEach((k) => {
          typeBreakdown[k] = k === 'scenarioBased' ? totalQ : 0;
        });
      }
      typeBreakdown = applyVisualToggleToBreakdown(typeBreakdown);
    }

    const remainingByType = { ...typeBreakdown };
    const batch = batchCap;

    abortFlag = false;
    runBusy = true;
    $('#pq-run').disabled = true;
    const rp = $('#pq-run-pipeline');
    if (rp) rp.disabled = true;
    if (orchestratedPipeline) {
      setPanelPipelineActive(true);
      showPipelineBanner('MCQ generation running — keep this ChatGPT conversation open.');
    }
    pqLog(`Starting: ${totalQ} Q · domain ${domainNum} "${domainName}" · next Q${nextQN}`, 'sys');

    const domainSeenQuestions = new Set();
    const optionLetters = alphaLetters(optionsCount);
    const answerUsage = {};
    optionLetters.forEach((l) => {
      answerUsage[l] = 0;
    });

    /** Successfully finished MCQ API rounds THIS run — batch “1”, “2”, … (not tied to ceil(Q/10)). */
    let mcqSequentialCompleted = 0;
    let consecutiveFailures = 0;

    try {
      while (produced - (nextQN - 1) < totalQ && !abortFlag) {
        const quotaUsed = produced - (nextQN - 1);
        if (quotaUsed >= totalQ) break;

        const remainingTotal = totalQ - quotaUsed;
        const thisBatch = Math.min(batch, remainingTotal);
        const displayMcqBatch = mcqSequentialCompleted + 1;
        const absStartQ = produced + 1;

        const typeOrder = SAMPLE_TYPE_KEYS.slice();
        const currentType = typeOrder.find((k) => (remainingByType[k] || 0) > 0) || 'definitionType';
        const typeNeed = Math.max(0, parseInt(remainingByType[currentType], 10) || 0);
        const thisTypeBatch = Math.min(thisBatch, Math.max(1, typeNeed));
        const targetBatch = currentType === 'tableBased' || currentType === 'chartsGraphsImg' ? 1 : thisTypeBatch;
        const absEndQ = produced + targetBatch;
        const currentTypeMaxWords = getTypeStatementWordLimit(currentType, stmtWords);
        const splitLines = `  - ${typeLabel(currentType)}: ${targetBatch}`;

        let prompt = buildPracticePrompt({
          domainName,
          domainNum,
          absStartQ,
          absEndQ,
          targetBatch,
          currentType,
          currentTypeMaxWords,
          optionLetters,
          splitLines,
        });

        pqLog(`MCQ batch ${displayMcqBatch}: type=${currentType} · ask ${targetBatch} Q (${absStartQ}–${absEndQ})`, 'sys');

        try {
          let arr = [];
          let guard = 0;
          while (arr.length < targetBatch && guard < 4 && !abortFlag) {
            guard++;
            const need = targetBatch - arr.length;
            const haveCurrent = arr.filter((q) => normalizeType(q.type) === currentType).length;
            const needByType = { [currentType]: Math.max(0, targetBatch - haveCurrent) };
            const needSplitLines = `  - ${typeLabel(currentType)}: ${needByType[currentType]}`;
            const noRepeatPrefix =
              produced + arr.length > 0
                ? `Already finalized up to Q${produced + arr.length}. Continue from Q${produced + arr.length + 1}.`
                : '';
            let ptext = prompt.replace(
              'Suggested type mix for this batch:',
              `${noRepeatPrefix}\n\nSuggested type mix for this batch:`
            );
            if (need !== targetBatch) {
              ptext = ptext.replace(/^Generate\s+\d+\s+objective\s+practice/i, `Generate ${need} objective practice`);
            }
            ptext = ptext.replace(splitLines, needSplitLines || splitLines);

            const raw = await sendToGPTPractice(ptext, 300000, 3);
            let chunk = fallbackParseQuestionsFromText(raw);
            chunk = normalizePracticeQuestions(chunk, {
              optionsCount,
              optionLetters,
              maxStatementWords: stmtWords + 120,
              explMinWords: pc.explMinWords,
              explMaxWords: pc.explMaxWords,
              explMinLines: pc.explMinLines,
              explMaxLines: pc.explMaxLines,
              explLineMinWords: pc.explLineMinWords,
              explLineMaxWords: pc.explLineMaxWords,
              seenSet: domainSeenQuestions,
              answerUsage,
              forcedTypeKey: currentType,
              forcedTypeMaxWords: currentTypeMaxWords,
              forcedTypeExactWords: currentTypeMaxWords,
            });
            chunk = enforceBatchTypeQuota(chunk, needByType);
            arr = arr.concat(chunk).slice(0, targetBatch);
          }

          if (arr.length < targetBatch) {
            pqLog(`Underfilled (${arr.length}/${targetBatch}) — emergency retry`, 'warn');
            const needEmergency = targetBatch - arr.length;
            const emergencyPrompt = `${PQ_MCQ_PURIST_OUTPUT_GUARDS}

Generate ${needEmergency} objective MCQ(s) for Domain-${domainNum}: "${domainName}".
Continue numbering from Q${produced + arr.length + 1}.
Plain text ONLY — NO # headings, NO **/__/backticks.
Type MUST be "${currentType}".
Statement MUST be exactly ${getTypeStatementWordLimit(currentType, stmtWords)} words.
Explanation MUST be exactly 5 to 7 lines; never name MCQ letters A–E in explanation.
Plain format ONLY — no prelude or postscript:
Type: ${currentType}
Q${produced + arr.length + 1}. [statement]
(${optionLetters[0]}) ...
Answer: ...
Explanation: ...
==================`;
            const emergencyRaw = await sendToGPTPractice(emergencyPrompt, 180000, 2);
            let emergencyChunk = fallbackParseQuestionsFromText(emergencyRaw);
            emergencyChunk = normalizePracticeQuestions(emergencyChunk, {
              optionsCount,
              optionLetters,
              maxStatementWords: stmtWords + 120,
              explMinWords: pc.explMinWords,
              explMaxWords: pc.explMaxWords,
              explMinLines: pc.explMinLines,
              explMaxLines: pc.explMaxLines,
              explLineMinWords: pc.explLineMinWords,
              explLineMaxWords: pc.explLineMaxWords,
              seenSet: domainSeenQuestions,
              answerUsage,
              forcedTypeKey: currentType,
              forcedTypeMaxWords: currentTypeMaxWords,
              forcedTypeExactWords: currentTypeMaxWords,
            });
            arr = arr.concat(emergencyChunk).slice(0, targetBatch);
          }

          if (!arr.length) throw new Error('No questions parsed this batch');

          arr.forEach((q) => {
            const tt = normalizeType(q.type || currentType);
            if (remainingByType[tt] !== undefined && remainingByType[tt] > 0) remainingByType[tt]--;
          });

          const practiceVisualPrompts = buildPracticeVisualPrompts({
            questions: arr,
            domainName,
            domainNum,
            batchIdx: displayMcqBatch,
            startNumber: produced + 1,
            imageBase: pqImageCounter,
          });

          if (postDoc) {
            await PQ_DOCS.postQuestions({
              domain: domainName,
              domainNum,
              batchIdx: displayMcqBatch,
              startNumber: produced + 1,
              questions: arr,
              visualPrompts: practiceVisualPrompts,
            });
          } else {
            pqLog(`Skipped Docs — ${arr.length} Q parsed (enable “Post to Google Doc” to save)`, 'sys');
          }

          pqImageCounter += practiceVisualPrompts.length;
          produced += arr.length;
          consecutiveFailures = 0;
          pqLog(`OK MCQ batch ${displayMcqBatch}: +${arr.length} Q (absolute up to Q${produced})`, 'ok');

          mcqSequentialCompleted++;
          if (mcqSequentialCompleted % 5 === 0 && !abortFlag) {
            pqLog(
              `${mcqSequentialCompleted} sequential MCQ batch(es) finished — sending rules/reference ACK command to GPT`,
              'sys'
            );
            await sendToGPTPractice(PQ_BATCH_RULE_ACK_COMMAND, 120000, 2);
          }
        } catch (err) {
          consecutiveFailures++;
          pqLog(`Batch error: ${err.message}`, 'error');
          if (consecutiveFailures >= 3) {
            pqLog('Stopped after 3 consecutive batch failures', 'error');
            break;
          }
          await sleep(400);
        }

        await sleep(120);
      }

      $('#pq-next-q').value = String(produced + 1);
      const finishedSlot = produced - (nextQN - 1);
      const quotaMet = !abortFlag && finishedSlot >= totalQ;
      if (quotaMet) {
        await runFreeResponseSynthesisAfterMcq({
          domainName,
          domainNum,
          totalQ,
          postDoc,
          suppressFinishAlert: orchestratedPipeline,
        });
      }
      pqLog(produced > 0 ? `Done. Next suggested Q number: ${produced + 1}` : 'Finished run.', 'ok');
      if (orchestratedPipeline && quotaMet) {
        const frOn = !!(document.getElementById('pq-free-response-followup') || {}).checked;
        const msg =
          (frOn
            ? 'MCQ complete + free-response pass finished (unless skipped in log). Tune FR counts via Post‑MCQ workflow if needed.'
            : 'MCQ complete; free-response not generated (exam blueprint = no FR).') +
          ' New ChatGPT thread — run Exam verify again.';
        pqLog(msg, 'ok');
        try {
          window.alert(msg);
        } catch (_) {}
      }
    } finally {
      runBusy = false;
      $('#pq-run').disabled = false;
      const rp2 = $('#pq-run-pipeline');
      if (rp2) rp2.disabled = false;
      if (orchestratedPipeline) {
        setPanelPipelineActive(false);
        showPipelineBanner('');
      }
    }
  }

  function saveUiBlob() {
    const blob = {
      url: $('#pq-url').value.trim(),
      doc: $('#pq-doc').value.trim(),
      secret: $('#pq-secret').value.trim(),
      examName: ($('#pq-exam-name') && $('#pq-exam-name').value) || '',
      examPaper: ($('#pq-exam-paper') && $('#pq-exam-paper').value) || '',
      examNotes: ($('#pq-exam-notes') && $('#pq-exam-notes').value) || '',
      examDifficultyTier: ($('#pq-exam-difficulty-level') && $('#pq-exam-difficulty-level').value) || 'advanced',
      freeResponseFollowup: $('#pq-free-response-followup')
        ? !!$('#pq-free-response-followup').checked
        : false,
      domain: $('#pq-domain-name').value.trim(),
      domainMap: ($('#pq-domain-map') && $('#pq-domain-map').value) || '',
      frScratch: ($('#pq-fr-detect-result') && $('#pq-fr-detect-result').value) || '',
      domainNum: $('#pq-domain-num').value,
      total: $('#pq-total').value,
      batch: $('#pq-batch').value,
      batchLock: $('#pq-batch-lock') ? $('#pq-batch-lock').checked : true,
      visChart: $('#pq-vis-chart') ? $('#pq-vis-chart').checked : true,
      visTable: $('#pq-vis-table') ? $('#pq-vis-table').checked : true,
      options: $('#pq-options').value,
      stmtw: $('#pq-stmt-w').value,
      nextQ: $('#pq-next-q').value,
      mix: $('#pq-type-mix').value,
      post: $('#pq-post-docs').checked,
      explMinW: $('#pq-expl-minw').value,
      explMaxW: $('#pq-expl-maxw').value,
      explLMin: $('#pq-expl-lines-min').value,
      explLMax: $('#pq-expl-lines-max').value,
      explLWMin: $('#pq-expl-line-minw').value,
      explLWMax: $('#pq-expl-line-maxw').value,
    };
    SAMPLE_TYPE_KEYS.forEach((k) => {
      const pc = $(`#pq-plan-${k}`);
      const sw = $(`#pq-stmt-${k}`);
      blob[`plan_${k}`] = pc ? pc.value : '';
      blob[`stmt_${k}`] = sw ? sw.value : '';
    });
    GM_setValue(STORAGE.UI, JSON.stringify(blob));
    pqLog('Saved panel fields', 'ok');
  }

  /** Re-hook panel to `document.body` when the host SPA removes injected nodes (common on chatgpt.com). */
  function ensurePqMounted() {
    if (_pqEnsureBusy) return;
    _pqEnsureBusy = true;
    try {
      const body = document.body;
      if (!body) return;

      const live = document.getElementById('pq-panel');
      if (live) {
        _pqPanelEl = live;
        return;
      }

      if (_pqPanelEl) {
        try {
          body.appendChild(_pqPanelEl);
          return;
        } catch (_) {
          _pqPanelEl = null;
        }
      }

      mountPanel();
    } finally {
      _pqEnsureBusy = false;
    }
  }

  function startPqMountGuard() {
    if (_pqMountGuardStarted) return;
    _pqMountGuardStarted = true;

    let pending = null;
    const schedule = () => {
      if (pending) return;
      pending = setTimeout(() => {
        pending = null;
        ensurePqMounted();
      }, 350);
    };

    try {
      const mo = new MutationObserver((mutations) => {
        for (const m of mutations) {
          if (m.removedNodes && m.removedNodes.length) {
            schedule();
            return;
          }
        }
      });
      const body = document.body;
      if (body) mo.observe(body, { childList: true, subtree: false });
    } catch (_) {}

    try {
      setInterval(ensurePqMounted, 4000);
    } catch (_) {}
  }

  function loadUiBlob() {
    try {
      const raw = GM_getValue(STORAGE.UI, '');
      if (!raw) return;
      const b = JSON.parse(raw);
      if (b.url != null) $('#pq-url').value = b.url;
      if (b.doc != null) $('#pq-doc').value = b.doc;
      if (b.secret != null) $('#pq-secret').value = b.secret;
      if (b.examName != null && $('#pq-exam-name')) $('#pq-exam-name').value = b.examName;
      if (b.examPaper != null && $('#pq-exam-paper')) $('#pq-exam-paper').value = b.examPaper;
      if (b.examNotes != null && $('#pq-exam-notes')) $('#pq-exam-notes').value = b.examNotes;
      if (
        b.examDifficultyTier != null &&
        $('#pq-exam-difficulty-level') &&
        ['foundation', 'standard', 'advanced', 'expert_gate'].includes(b.examDifficultyTier)
      ) {
        $('#pq-exam-difficulty-level').value = b.examDifficultyTier;
      }
      if (typeof b.freeResponseFollowup === 'boolean' && $('#pq-free-response-followup')) {
        $('#pq-free-response-followup').checked = b.freeResponseFollowup;
      }
      if (b.domainMap != null && $('#pq-domain-map')) $('#pq-domain-map').value = b.domainMap;
      if (b.frScratch != null && $('#pq-fr-detect-result')) $('#pq-fr-detect-result').value = b.frScratch;
      if (b.domain != null) $('#pq-domain-name').value = b.domain;
      if (b.domainNum != null) $('#pq-domain-num').value = b.domainNum;
      if (b.total != null) $('#pq-total').value = b.total;
      if (b.batch != null) $('#pq-batch').value = b.batch;
      if (typeof b.batchLock === 'boolean' && $('#pq-batch-lock')) $('#pq-batch-lock').checked = b.batchLock;
      if (typeof b.visChart === 'boolean' && $('#pq-vis-chart')) $('#pq-vis-chart').checked = b.visChart;
      if (typeof b.visTable === 'boolean' && $('#pq-vis-table')) $('#pq-vis-table').checked = b.visTable;
      if (b.options != null) $('#pq-options').value = b.options;
      if (b.stmtw != null) $('#pq-stmt-w').value = b.stmtw;
      if (b.nextQ != null) $('#pq-next-q').value = b.nextQ;
      if (b.mix != null) $('#pq-type-mix').value = b.mix;
      if (typeof b.post === 'boolean') $('#pq-post-docs').checked = b.post;
      if (b.explMinW != null) $('#pq-expl-minw').value = b.explMinW;
      if (b.explMaxW != null) $('#pq-expl-maxw').value = b.explMaxW;
      if (b.explLMin != null) $('#pq-expl-lines-min').value = b.explLMin;
      if (b.explLMax != null) $('#pq-expl-lines-max').value = b.explLMax;
      if (b.explLWMin != null) $('#pq-expl-line-minw').value = b.explLWMin;
      if (b.explLWMax != null) $('#pq-expl-line-maxw').value = b.explLWMax;
      SAMPLE_TYPE_KEYS.forEach((k) => {
        const pk = b[`plan_${k}`];
        const sk = b[`stmt_${k}`];
        const pc = $(`#pq-plan-${k}`);
        const sw = $(`#pq-stmt-${k}`);
        if (pc && pk != null) pc.value = pk;
        if (sw && sk != null) sw.value = sk;
      });
      $('#pq-batch-lock') && $('#pq-batch-lock').dispatchEvent(new Event('change'));
      const tm = loadTypeMapFromStorage();
      if (
        tm &&
        tm.planned_counts_target &&
        SAMPLE_TYPE_KEYS.reduce((acc, kk) => acc + (($(`#pq-plan-${kk}`) && parseInt($(`#pq-plan-${kk}`).value)) || 0), 0) === 0
      ) {
        fillTypePlanUi(tm.planned_counts_target, tm.statement_word_targets || {});
      }
      const tierFm = tm && tm.exam_difficulty_level ? String(tm.exam_difficulty_level).trim().toLowerCase() : '';
      if (
        tm &&
        ['foundation', 'standard', 'advanced', 'expert_gate'].includes(tierFm) &&
        $('#pq-exam-difficulty-level') &&
        !(b.examDifficultyTier || '').trim()
      ) {
        $('#pq-exam-difficulty-level').value = tierFm;
      }
      if (
        tm &&
        typeof tm.free_response_blueprint_from_verify === 'boolean' &&
        $('#pq-free-response-followup') &&
        typeof b.freeResponseFollowup !== 'boolean'
      ) {
        $('#pq-free-response-followup').checked = tm.free_response_blueprint_from_verify;
      }
    } catch (_) {}
  }

  function mountPanel() {
    if (document.getElementById('pq-panel')) return;
    if (_pqMountBusy) return;
    _pqMountBusy = true;
    try {
    GM_addStyle(`
      #pq-panel {
        position: fixed !important; top: 64px !important; left: 16px !important;
        visibility: visible !important; opacity: 1 !important;
        width: 440px !important; max-height: 92vh !important; z-index: 2147483646 !important;
        background: #0f172a !important; color: #e2e8f0 !important; border: 1px solid #334155 !important;
        border-radius: 12px !important; box-shadow: 0 20px 50px rgba(0,0,0,.55) !important;
        font: 13px/1.4 system-ui,Segoe UI,sans-serif !important; display: flex !important; flex-direction: column !important;
        overflow: hidden !important;
      }
      #pq-panel.pq-pipeline-active {
        border: 2px solid #eab308 !important;
        box-shadow: 0 0 0 3px rgba(234,179,8,.45), 0 20px 50px rgba(0,0,0,.55) !important;
      }
      #pq-head { cursor: grab; padding: 10px 12px; background: linear-gradient(135deg,#4c1d95,#2563eb); flex-shrink:0; user-select:none; }
      #pq-head h3 { margin: 0; font-size: 14px; color: #e0e7ff; }
      #pq-head small { display:block;color:#c7d2fe;font-size:10px;margin-top:2px;opacity:.9 }
      #pq-body { padding:10px 12px; overflow-y:auto; flex:1; display:flex; flex-direction:column; gap:8px; }
      #pq-step-banner {
        display:none; font-size:11px; color:#fef9c3; background:#422006; border:1px solid #eab308;
        border-radius:8px; padding:8px; white-space:pre-wrap; min-height:0;
      }
      .pq-details { border:1px solid #334155; border-radius:8px; padding:4px 8px;background:#020617;}
      .pq-details > summary { cursor:pointer;font-size:11px;font-weight:700;color:#93c5fd;user-select:none; }
      .pq-row label { font-size:10px;color:#94a3b8;display:block;margin-bottom:2px }
      .pq-row input, .pq-row select, .pq-row textarea {
        width:100%; box-sizing:border-box; background:#020617; border:1px solid #334155; border-radius:6px; color:#e2e8f0;
        padding:6px 8px; font-size:12px;
      }
      .pq-grid { display:grid; grid-template-columns:1fr 1fr; gap:6px }
      .pq-wf-actions { display:grid; grid-template-columns:repeat(3,1fr); gap:6px }
      .pq-wf-actions button { font-size:10px !important;padding:7px 4px!important }
      #pq-plan-grid td, #pq-plan-grid th { font-size:10px;padding:4px;border-bottom:1px solid #334155;text-align:left; }
      #pq-log { min-height:120px; max-height:280px; font:11px/1.3 ui-monospace,Consolas,monospace }
      #pq-controls { display:grid; grid-template-columns:1fr 1fr; gap:6px }
      #pq-controls button, #pq-actions button {
        padding:9px;border-radius:8px;border:1px solid #475569;background:#1e293b;color:#e2e8f0;font-weight:700;font-size:11px;cursor:pointer
      }
      #pq-controls button.primary, #pq-actions button.primary { background:linear-gradient(135deg,#7c3aed,#2563eb); border-color:#6366f1 }
      #pq-controls button.secondary { background:#0f766e;border-color:#14b8a6;font-size:10px!important }
      #pq-actions button.danger { background:#7f1d1d; border-color:#dc2626; color:#fecaca }
      #pq-modal-ref {
        display:none; position:fixed; inset:0; z-index:2147483647;
        background:rgba(0,0,0,.6); align-items:center; justify-content:center; padding:20px;
      }
      #pq-modal-ref > div {
        background:#0f172a; border:1px solid #facc15; border-radius:12px; padding:16px; max-width:360px;
        box-shadow:0 20px 60px rgba(0,0,0,.65); font-size:12px;line-height:1.45;color:#cbd5f5;
      }
    `);

    const wrap = document.createElement('div');
    wrap.id = 'pq-panel';
    wrap.innerHTML = `
      <div id="pq-head"><h3>Practice MCQ · Standalone</h3><small>Disable Study Guide overlay here · Shares this ChatGPT thread for uploads &amp; context</small></div>
      <div id="pq-body">
        <div id="pq-step-banner" aria-live="polite"></div>
        <div id="pq-modal-ref">
          <div>
            <strong style="display:block;color:#fcd34d;margin-bottom:10px;">Reference gap</strong>
            <p>GPT signaled missing references. Upload the books / pages in-chat, read them mentally, then continue.</p>
            <button type="button" class="primary" id="pq-ref-recovered">Reference recovered ✓</button>
          </div>
        </div>

        <details class="pq-details" open><summary>Docs &amp; connection</summary>
        <div class="pq-row" style="margin-top:8px"><label>Apps Script URL</label><input id="pq-url" type="url" placeholder="https://script.google.com/..."></div>
        <div class="pq-grid">
          <div class="pq-row"><label>Doc ID</label><input id="pq-doc" placeholder="Doc"></div>
          <div class="pq-row"><label>Secret</label><input id="pq-secret"></div>
        </div>
        <div class="pq-row"><label><input type="checkbox" id="pq-post-docs"> Post batches</label></div>
        </details>

        <details class="pq-details" open><summary>Requirements</summary>
        <div class="pq-row" style="margin-top:8px"><label>Exam name</label><input id="pq-exam-name" placeholder="e.g. STEP-2 Clinical Knowledge"></div>
        <div class="pq-grid">
          <div class="pq-row"><label>Paper / section</label><input id="pq-exam-paper" placeholder="e.g. Block 2 · Cardiology"></div>
          <div class="pq-row"><label>Requirements notes</label><input id="pq-exam-notes" placeholder="e.g. vignette style, time pressure"></div>
        </div>
        <div class="pq-row"><button type="button" id="pq-req-scroll" style="width:100%;margin-top:2px">Jump → workflow</button></div>
        <div class="pq-grid">
          <div class="pq-row">
            <label><input type="checkbox" id="pq-free-response-followup"> Free-response after MCQs (<span title="Filled by Exam verify phase 2">auto</span>)</label>
          </div>
          <div class="pq-row"><label>Exam difficulty</label><select id="pq-exam-difficulty-level">
            <option value="foundation">foundation</option>
            <option value="standard">standard</option>
            <option value="advanced" selected>advanced</option>
            <option value="expert_gate">expert_gate</option>
          </select></div>
        </div>
        <div class="pq-grid">
          <div class="pq-row"><label>Domain / topic</label><input id="pq-domain-name" placeholder="e.g. Infectious Disease"></div>
          <div class="pq-row"><label>Domain #</label><input id="pq-domain-num" type="number" min="1" value="1"></div>
        </div>
        <div class="pq-grid">
          <div class="pq-row"><label>Target questions</label><input id="pq-total" type="number" min="1" value="30"></div>
          <div class="pq-row"><label title="Locks batch ceiling at 10 for full run">Batch cap (≤10)</label><input id="pq-batch" type="number" min="1" max="10" value="10"></div>
        </div>
        <div class="pq-row"><label><input type="checkbox" id="pq-batch-lock" checked> Lock batch at 10 (no >10/question call)</label></div>
        <div class="pq-grid">
          <div class="pq-row"><label>Options (2–10)</label><input id="pq-options" type="number" min="2" max="10" value="4"></div>
          <div class="pq-row"><label>Default stmt words</label><input id="pq-stmt-w" type="number" min="6" value="25"></div>
        </div>
        <div class="pq-row">
          <label>Type preset (manual mode)</label>
          <select id="pq-type-mix">
            <option value="equal" selected>Equal mix</option>
            <option value="definition">Definition heavy</option>
            <option value="scenario">Scenario heavy</option>
          </select>
        </div>
        <div class="pq-grid">
          <div class="pq-row"><label>Next Q# resume</label><input id="pq-next-q" type="number" min="1" value="1"></div>
          <div class="pq-row"></div>
        </div>
        <div class="pq-grid">
          <div class="pq-row"><label>Expl words min</label><input id="pq-expl-minw" type="number" value="80"></div>
          <div class="pq-row"><label>Expl words max</label><input id="pq-expl-maxw" type="number" value="250"></div>
        </div>
        <div class="pq-grid">
          <div class="pq-row"><label>Expl lines min</label><input id="pq-expl-lines-min" type="number" value="5"></div>
          <div class="pq-row"><label>Expl lines max</label><input id="pq-expl-lines-max" type="number" value="7"></div>
        </div>
        <div class="pq-grid">
          <div class="pq-row"><label>Line words min</label><input id="pq-expl-line-minw" type="number" value="10"></div>
          <div class="pq-row"><label>Line words max</label><input id="pq-expl-line-maxw" type="number" value="22"></div>
        </div>
        </details>

        <details id="pq-workflow-block" class="pq-details"><summary>Workflow &amp; mapping</summary>
        <div class="pq-wf-actions" style="margin-top:8px;margin-bottom:6px">
          <button type="button" id="pq-wf-outline-ok">Outline ✓</button>
          <button type="button" id="pq-wf-samples-ok">Samples ✓</button>
          <button type="button" id="pq-wf-sample-postmcq">Post‑MCQ ✓</button>
        </div>
        <div class="pq-row"><label style="margin-top:4px;color:#fcd34d">Mapping actions → GPT thread</label></div>
        <div class="pq-wf-actions" style="margin-bottom:6px">
          <button type="button" id="pq-wf-map-domain">Domain map</button>
          <button type="button" id="pq-wf-map-sample">Sample map</button>
          <button type="button" id="pq-wf-map-books">All books</button>
        </div>
        <div class="pq-row"><label>Domain mapping (stored)</label><textarea id="pq-domain-map" rows="3" placeholder="Leaf rows after detection…"></textarea></div>
        <div class="pq-row"><label>Free-response / FR JSON scratchpad</label><textarea id="pq-fr-detect-result" rows="2" placeholder="Auto FR stats…"></textarea></div>
        </details>

        <details class="pq-details"><summary>Reference enforcement (copy/read)</summary>
        <textarea id="pq-rules-readonly" rows="5" readonly style="opacity:.95;margin-top:8px;"></textarea></details>

        <details class="pq-details"><summary>Visual phases</summary>
        <div class="pq-row" style="margin-top:8px"><label><input type="checkbox" id="pq-vis-chart" checked> Chart/graph image prompts advanced</label></div>
        <div class="pq-row"><label><input type="checkbox" id="pq-vis-table" checked> Compact table prompts</label></div>
        </details>

        <details class="pq-details"><summary>Type plan × statement word targets</summary>
        <table id="pq-plan-grid" style="width:100%;border-collapse:collapse;margin-top:8px;"><thead><tr><th>Type</th><th>Qty</th><th>Words</th></tr></thead><tbody>
        <tr><td>Scenario</td><td><input id="pq-plan-scenarioBased" type="number" min="0" value="0"/></td><td><input id="pq-stmt-scenarioBased" type="number" min="6"/></td></tr>
        <tr><td>Definition</td><td><input id="pq-plan-definitionType" type="number" min="0" value="0"/></td><td><input id="pq-stmt-definitionType" type="number" min="6"/></td></tr>
        <tr><td>Recall</td><td><input id="pq-plan-recallStatement" type="number" min="0" value="0"/></td><td><input id="pq-stmt-recallStatement" type="number" min="6"/></td></tr>
        <tr><td>Application</td><td><input id="pq-plan-applicationBased" type="number" min="0" value="0"/></td><td><input id="pq-stmt-applicationBased" type="number" min="6"/></td></tr>
        <tr><td>FITB</td><td><input id="pq-plan-fillInTheBlanks" type="number" min="0" value="0"/></td><td><input id="pq-stmt-fillInTheBlanks" type="number" min="6"/></td></tr>
        <tr><td>Table</td><td><input id="pq-plan-tableBased" type="number" min="0" value="0"/></td><td><input id="pq-stmt-tableBased" type="number" min="6"/></td></tr>
        <tr><td>Chart</td><td><input id="pq-plan-chartsGraphsImg" type="number" min="0" value="0"/></td><td><input id="pq-stmt-chartsGraphsImg" type="number" min="6"/></td></tr>
        </tbody></table>
        <div style="margin-top:6px;display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px">
          <button type="button" id="pq-auto-domain">Auto domain</button>
          <button type="button" id="pq-auto-sample">Auto blueprint</button>
          <button type="button" id="pq-auto-fr">Auto FR scan</button>
        </div>
        </details>

        <div class="pq-row"><label style="margin-top:2px;color:#38bdf8">Controls</label></div>
        <div id="pq-controls">
          <button type="button" class="secondary" id="pq-verify-exam">Exam verify</button>
          <button type="button" class="secondary" id="pq-run-pipeline">Start pipeline</button>
        </div>
        <div id="pq-actions">
          <button type="button" class="primary" id="pq-run">Generate MCQs</button>
          <button type="button" id="pq-stop" class="danger">Stop</button>
          <button type="button" id="pq-save">Save fields</button>
          <button type="button" id="pq-clear-log">Clear log</button>
        </div>

        <div class="pq-row"><label>Live console</label><textarea id="pq-log" readonly></textarea></div>
      </div>`;
    (document.body || document.documentElement).appendChild(wrap);
    _pqPanelEl = wrap;

    $('#pq-url').value = GM_getValue(STORAGE.APPS_SCRIPT_URL, '');
    $('#pq-doc').value = GM_getValue(STORAGE.DOC_ID, '');
    $('#pq-secret').value = GM_getValue(STORAGE.SECRET_KEY, '');
    loadUiBlob();

    const _rulesTa = $('#pq-rules-readonly');
    if (_rulesTa) _rulesTa.value = PQ_ENFORCEMENT_SUITE.concat(['', PQ_EXAM_RULES_BLOCK]).join('\n');

    const _syncExamName = () => {
      const ex = $('#pq-exam-name');
      const dom = $('#pq-domain-name');
      if (!ex || !dom) return;
      if (!ex.value.trim() && dom.value.trim()) ex.value = dom.value.trim();
    };
    const _dns = $('#pq-domain-name');
    if (_dns) _dns.addEventListener('change', _syncExamName);

    $('#pq-batch-lock').addEventListener('change', () => {
      const lk = $('#pq-batch-lock').checked;
      const b = $('#pq-batch');
      if (lk) {
        b.value = '10';
        b.readOnly = true;
      } else b.readOnly = false;
    });
    $('#pq-batch-lock').dispatchEvent(new Event('change'));

    $('#pq-verify-exam').addEventListener('click', () => runExamVerificationPressed());
    $('#pq-run-pipeline').addEventListener('click', () => runOutlineSamplePipelineOrchestration());
    $('#pq-wf-outline-ok').addEventListener('click', () => {
      pqLog('Outline confirm clicked', 'sys');
      resolveWorkflowConfirm('outline');
    });
    $('#pq-wf-samples-ok').addEventListener('click', () => {
      pqLog('Samples confirm clicked', 'sys');
      resolveWorkflowConfirm('samples');
    });
    $('#pq-wf-sample-postmcq').addEventListener('click', async () => {
      const qq = $('#pq-total').value || '50';
      try {
        pqLog(`Post‑MCQ FR redistribution for target ${qq} …`, 'sys');
        await sendSampleFreeResponseTriple(qq);
      } catch (e) {
        pqLog(`Post‑MCQ step failed: ${e.message}`, 'error');
      }
    });

    $('#pq-wf-map-domain').addEventListener('click', async () => {
      if (!isOnGPT()) return;
      try {
        const raw = await sendToGPT(
          PQ_DOMAIN_MAPPING_PROMPT + `\nEcho domain slug: "${($('#pq-domain-name').value || '').trim()}".`,
          240000,
          3
        );
        const dma = $('#pq-domain-map');
        if (dma) dma.value = stripCodeFences(raw).slice(0, 12000);
        pqLog('Domain mapping prompt flushed to ChatGPT · textarea synced', 'ok');
      } catch (e) {
        pqLog(e.message, 'error');
      }
    });
    $('#pq-wf-map-sample').addEventListener('click', () => pqSampleQuestionsAutoDetect());
    $('#pq-wf-map-books').addEventListener('click', async () => {
      try {
        await sendToGPT(
          [
            'REFERENCE_BOOK_INGEST_STAGE:',
            'User uploaded FULL reference corpus in-chat (all books/files). Read every referenced book end-to-end now.',
            'Reply BOOKS_INGEST_CONFIRMED_ONLY',
          ].join('\n'),
          240000,
          3
        );
        pqLog('All-books ingestion reminder sent.', 'ok');
      } catch (e) {
        pqLog(e.message, 'error');
      }
    });

    $('#pq-auto-domain').addEventListener('click', () => pqAutoDetectDomainMap());
    $('#pq-auto-sample').addEventListener('click', () => pqSampleQuestionsAutoDetect());
    $('#pq-auto-fr').addEventListener('click', () => pqFreeResponseAutoDetect());

    $('#pq-ref-recovered').addEventListener('click', () => {
      pqLog('User confirmed recovered references.', 'sys');
      resolveWorkflowConfirm('refrecovery');
      const ov = $('#pq-modal-ref');
      if (ov) ov.style.display = 'none';
    });

    $('#pq-req-scroll').addEventListener('click', () => {
      $('#pq-workflow-block').open = true;
      $('#pq-workflow-block').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });

    $('#pq-run').addEventListener('click', () => runStandalonePracticeGeneration());
    $('#pq-stop').addEventListener('click', () => {
      abortFlag = true;
      pqLog('Stop requested', 'warn');
    });
    $('#pq-save').addEventListener('click', saveUiBlob);
    $('#pq-clear-log').addEventListener('click', () => {
      const ta = $('#pq-log');
      if (ta) ta.value = '';
    });

    const head = $('#pq-head');
    let drag = null;
    head.addEventListener('mousedown', (e) => {
      if (e.target.closest('button')) return;
      drag = { x: e.clientX, y: e.clientY, l: wrap.offsetLeft, t: wrap.offsetTop };
    });
    window.addEventListener('mousemove', (e) => {
      if (!drag) return;
      wrap.style.left = `${drag.l + (e.clientX - drag.x)}px`;
      wrap.style.top = `${drag.t + (e.clientY - drag.y)}px`;
      wrap.style.right = 'auto';
    });
    window.addEventListener('mouseup', () => {
      drag = null;
    });

    startPqMountGuard();
    } finally {
      _pqMountBusy = false;
    }
  }

  function boot() {
    mountPanel();
    ensurePqMounted();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
