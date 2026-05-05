// ==UserScript==
// @name         PracticeQ AutoPilot v3.2
// @namespace    https://examforge.pro
// @version      3.2.1
// @description  Automated Practice Question Generator — v3.2.1: Option-label-free explanations enforced
// @author       Sherii
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_listValues
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @grant        GM_setClipboard
// @connect      script.google.com
// @connect      script.googleusercontent.com
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  /* ════════════════════════════════════════════════════════════
     CONSTANTS
  ════════════════════════════════════════════════════════════ */
  const PREFIX  = 'PQA32_';
  const VERSION = '3.2.1';
  const BUILD   = '2025-04';

  const PHASE = {
    IDLE:0, INIT:1, UPLOAD_WAIT:2, DETECTING:3,
    BOOKS_WAIT:4, BOOKS_ACK:5, GENERATING:6, DONE:7
  };

  /* ════════════════════════════════════════════════════════════
     FIX #1 — SMART DEDUP
     Only last 20 stems sent to GPT (not all). Full registry kept
     in memory for local duplicate detection. This cuts prompt size
     and speeds up generation while still preventing repeats.
  ════════════════════════════════════════════════════════════ */
  const DEDUP_WINDOW = 20; // how many stems to send to GPT in prompt

  /* ════════════════════════════════════════════════════════════
     FIX #2 — BATCH ENFORCEMENT
     After every batch response we COUNT actual Q[N]. lines.
     If count < required, we PATCH (request the missing ones).
     Max 2 patch attempts per batch before marking failed.
  ════════════════════════════════════════════════════════════ */
  const MAX_PATCH_ATTEMPTS = 2;

  /* ════════════════════════════════════════════════════════════
     FIX #3 — RULE REINFORCEMENT
     After ANY error (invalid, refusal, wrong count) we resend
     a compact rule block before the next batch prompt. This
     prevents GPT from "forgetting" format after a bad response.
  ════════════════════════════════════════════════════════════ */
  let needsRuleReinforce = false; // set true after any error

  /* ════════════════════════════════════════════════════════════
     FIX #4 — MATH-SAFE GOOGLE DOCS
     All content is sent as plain text. Math expressions are
     wrapped in [MATH]...[/MATH] markers so Apps Script can
     detect and preserve them. Superscripts/subscripts are
     converted to readable ASCII (e.g. x^2, CO_2).
  ════════════════════════════════════════════════════════════ */
  function mathSafeText(text) {
    if (!text) return '';
    return text
      // Preserve common math symbols in ASCII-safe form
      .replace(/[²]/g, '^2')
      .replace(/[³]/g, '^3')
      .replace(/[¹]/g, '^1')
      .replace(/[⁴]/g, '^4')
      .replace(/[⁵]/g, '^5')
      .replace(/[⁰]/g, '^0')
      .replace(/[½]/g, '1/2')
      .replace(/[¼]/g, '1/4')
      .replace(/[¾]/g, '3/4')
      .replace(/[×]/g, 'x')
      .replace(/[÷]/g, '/')
      .replace(/[≈]/g, '~=')
      .replace(/[≠]/g, '!=')
      .replace(/[≤]/g, '<=')
      .replace(/[≥]/g, '>=')
      .replace(/[∑]/g, 'SUM')
      .replace(/[∏]/g, 'PROD')
      .replace(/[√]/g, 'sqrt')
      .replace(/[∞]/g, 'inf')
      .replace(/[π]/g, 'pi')
      .replace(/[μ]/g, 'mu')
      .replace(/[σ]/g, 'sigma')
      .replace(/[α]/g, 'alpha')
      .replace(/[β]/g, 'beta')
      .replace(/[θ]/g, 'theta')
      .replace(/[λ]/g, 'lambda')
      // Markdown math blocks: $$...$$ and $...$ → plain
      .replace(/\$\$([^$]+)\$\$/g, '[MATH] $1 [/MATH]')
      .replace(/\$([^$\n]+)\$/g, '[MATH] $1 [/MATH]')
      // LaTeX-style fractions: \frac{a}{b} → a/b
      .replace(/\\frac\{([^}]+)\}\{([^}]+)\}/g, '($1)/($2)')
      // LaTeX commands
      .replace(/\\sqrt\{([^}]+)\}/g, 'sqrt($1)')
      .replace(/\\times/g, 'x')
      .replace(/\\div/g, '/')
      .replace(/\\pm/g, '+/-')
      .replace(/\\cdot/g, '*')
      .replace(/\\left\(/g, '(').replace(/\\right\)/g, ')')
      .replace(/\\left\[/g, '[').replace(/\\right\]/g, ']')
      .replace(/\\_\{([^}]+)\}/g, '_$1')  // subscripts
      .replace(/\\\\?\^/g, '^')           // superscripts
      // Remove stray backslashes from LaTeX
      .replace(/\\([a-zA-Z]+)/g, '$1')
      // Clean up triple+ newlines
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  /* ════════════════════════════════════════════════════════════
     DEFAULT STATE
  ════════════════════════════════════════════════════════════ */
  function defaultState() {
    return {
      phase: PHASE.IDLE,
      running: false, paused: false,
      uploadOk: false, booksOk: false,
      domains: [],
      qtypes: {},
      detectedOptCount: 4,
      detectedOptLength: 'short',
      detectedStmtLength: 'standard',
      books: [],
      bookQuestionCounts: {},
      currentBookIndex: 0,
      batchPlan: [],
      totalBatches: 0,
      currentBatch: 0,
      currentQuestion: 0,
      totalQuestions: 0,
      completedBatches: [],
      failedBatches: [],
      globalErrors: 0,
      retries: 0,
      // FIX #1: Two-tier dedup — full Set (local) + rolling window (prompt)
      stemRegistry: new Set(),       // ALL stems (local duplicate check)
      stemHistory: [],               // ordered list for rolling window
      optionRegistry: new Set(),
      explanationRegistry: new Set(),
      answerHistory: [],
      startTime: null,
      watcherTimer: null,
      pauseResolver: null,
      logEntries: [],
      fullRulesSent: false,
      lastResponse: '',
    };
  }

  let S = defaultState();

  /* ════════════════════════════════════════════════════════════
     STORAGE
  ════════════════════════════════════════════════════════════ */
  const store = {
    get(k, d='') { try { return GM_getValue(PREFIX+k, d); } catch(e) { return d; } },
    set(k, v)    { try { GM_setValue(PREFIX+k, v); } catch(e) {} },
    del(k)       { try { GM_deleteValue(PREFIX+k); } catch(e) {} },
    clearAll() {
      try { GM_listValues().filter(k=>k.startsWith(PREFIX)).forEach(k=>GM_deleteValue(k)); } catch(e) {}
    },
    save() {
      this.set('state', JSON.stringify({
        phase: S.phase,
        domains: S.domains,
        qtypes: S.qtypes,
        detectedOptCount: S.detectedOptCount,
        detectedOptLength: S.detectedOptLength,
        detectedStmtLength: S.detectedStmtLength,
        books: S.books,
        bookQuestionCounts: S.bookQuestionCounts,
        currentBatch: S.currentBatch,
        totalBatches: S.totalBatches,
        currentQuestion: S.currentQuestion,
        totalQuestions: S.totalQuestions,
        completedBatches: S.completedBatches,
        failedBatches: S.failedBatches,
      }));
    },
    load() {
      try { return JSON.parse(this.get('state','') || 'null'); } catch(e) { return null; }
    },
  };

  /* ════════════════════════════════════════════════════════════
     STYLES
  ════════════════════════════════════════════════════════════ */
  GM_addStyle(`
    #pqa-wrap{
      position:fixed!important;top:52px!important;right:16px!important;
      width:440px!important;z-index:2147483647!important;
      font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif!important;
      font-size:13px!important;color:#e2e8f0!important;
      display:block!important;visibility:visible!important;opacity:1!important;pointer-events:auto!important;
    }
    #pqa-wrap *{box-sizing:border-box!important;}
    #pqa-wrap.hidden{display:none!important;}
    #pqa-panel{
      background:#07090f!important;border:1px solid #1e2d42!important;border-radius:14px!important;
      box-shadow:0 24px 64px rgba(0,0,0,.85),0 0 0 1px rgba(255,255,255,.03)!important;overflow:hidden!important;
    }
    #pqa-hdr{
      display:flex!important;align-items:center!important;justify-content:space-between!important;
      padding:9px 13px!important;background:linear-gradient(135deg,#0d1520,#111e2e)!important;
      border-bottom:1px solid #1e2d42!important;cursor:grab!important;user-select:none!important;
      position:relative!important;overflow:hidden!important;
    }
    #pqa-hdr::after{
      content:''!important;position:absolute!important;top:0!important;left:0!important;right:0!important;height:1px!important;
      background:linear-gradient(90deg,transparent,#10b981 40%,#06b6d4 70%,transparent)!important;opacity:.6!important;
    }
    #pqa-hdr:active{cursor:grabbing!important;}
    .h-brand{display:flex!important;align-items:center!important;gap:8px!important;}
    .h-logo{
      width:26px!important;height:26px!important;border-radius:7px!important;flex-shrink:0!important;
      background:linear-gradient(135deg,#10b981,#06b6d4)!important;
      display:flex!important;align-items:center!important;justify-content:center!important;
      font-size:13px!important;font-weight:900!important;color:#fff!important;
      box-shadow:0 0 12px rgba(16,185,129,.4)!important;
    }
    .h-title{font-size:13px!important;font-weight:700!important;color:#e2e8f0!important;}
    .h-sub{font-size:9px!important;color:#475569!important;font-family:monospace!important;}
    .h-badge{
      font-size:8.5px!important;font-weight:700!important;letter-spacing:.8px!important;text-transform:uppercase!important;
      padding:2px 6px!important;border-radius:3px!important;
      background:rgba(16,185,129,.12)!important;border:1px solid rgba(16,185,129,.25)!important;color:#10b981!important;
    }
    .h-btns{display:flex!important;gap:4px!important;}
    .h-btn{
      width:24px!important;height:24px!important;border:1px solid #28405c!important;border-radius:6px!important;
      background:#16202e!important;color:#94a3b8!important;cursor:pointer!important;
      display:flex!important;align-items:center!important;justify-content:center!important;
      font-size:11px!important;padding:0!important;line-height:1!important;transition:all .15s!important;
    }
    .h-btn:hover{background:#1c2a3a!important;color:#e2e8f0!important;}
    .h-btn.danger:hover{background:rgba(239,68,68,.15)!important;border-color:#ef4444!important;color:#ef4444!important;}
    #pqa-sbar{
      display:flex!important;align-items:center!important;justify-content:space-between!important;
      padding:5px 13px!important;background:#0c0f1a!important;border-bottom:1px solid #1e2d42!important;gap:8px!important;
    }
    #pqa-status{
      display:inline-flex!important;align-items:center!important;gap:5px!important;
      padding:3px 9px!important;border-radius:20px!important;
      font-size:9.5px!important;font-weight:700!important;letter-spacing:.5px!important;
      text-transform:uppercase!important;border:1px solid!important;transition:all .3s!important;flex-shrink:0!important;
    }
    .s-dot{width:5px!important;height:5px!important;border-radius:50%!important;}
    .s-dot.pulse{animation:pqaPulse 1.3s ease-in-out infinite!important;}
    @keyframes pqaPulse{0%,100%{opacity:1}50%{opacity:.15}}
    #pqa-status.idle{color:#475569!important;background:rgba(71,85,105,.08)!important;border-color:#1e2d42!important;}
    #pqa-status.idle .s-dot{background:#475569!important;}
    #pqa-status.running{color:#10b981!important;background:rgba(16,185,129,.1)!important;border-color:rgba(16,185,129,.3)!important;}
    #pqa-status.running .s-dot{background:#10b981!important;}
    #pqa-status.paused{color:#f59e0b!important;background:rgba(245,158,11,.08)!important;border-color:rgba(245,158,11,.3)!important;}
    #pqa-status.paused .s-dot{background:#f59e0b!important;}
    #pqa-status.error{color:#ef4444!important;background:rgba(239,68,68,.08)!important;border-color:rgba(239,68,68,.3)!important;}
    #pqa-status.error .s-dot{background:#ef4444!important;}
    #pqa-status.done{color:#10b981!important;background:rgba(16,185,129,.08)!important;border-color:rgba(16,185,129,.3)!important;}
    #pqa-status.done .s-dot{background:#10b981!important;animation:none!important;}
    .sb-r{display:flex!important;flex-direction:column!important;align-items:flex-end!important;gap:1px!important;flex:1!important;overflow:hidden!important;}
    #pqa-phase,#pqa-elapsed{font-size:9px!important;color:#475569!important;font-family:monospace!important;white-space:nowrap!important;overflow:hidden!important;text-overflow:ellipsis!important;}
    #pqa-body{
      padding:10px 12px!important;display:flex!important;flex-direction:column!important;gap:8px!important;
      max-height:83vh!important;overflow-y:auto!important;overflow-x:hidden!important;
    }
    #pqa-body::-webkit-scrollbar{width:3px!important;}
    #pqa-body::-webkit-scrollbar-thumb{background:#28405c!important;border-radius:3px!important;}
    #pqa-panel.min #pqa-body,#pqa-panel.min #pqa-sbar{display:none!important;}
    .card{background:#0c0f1a!important;border:1px solid #1e2d42!important;border-radius:10px!important;padding:10px 12px!important;}
    .card-hdr{display:flex!important;align-items:center!important;justify-content:space-between!important;margin-bottom:8px!important;}
    .card-title{
      font-size:9.5px!important;font-weight:700!important;text-transform:uppercase!important;letter-spacing:1.2px!important;
      color:#10b981!important;display:flex!important;align-items:center!important;gap:5px!important;
    }
    .card-title::before{content:''!important;width:2px!important;height:10px!important;background:currentColor!important;border-radius:2px!important;flex-shrink:0!important;}
    .ct-blu{color:#3b82f6!important;}.ct-prp{color:#8b5cf6!important;}.ct-org{color:#f97316!important;}
    .ct-cyn{color:#06b6d4!important;}.ct-red{color:#ef4444!important;}
    .badge{font-size:8px!important;font-weight:700!important;padding:2px 6px!important;border-radius:3px!important;text-transform:uppercase!important;letter-spacing:.5px!important;}
    .b-req{background:rgba(239,68,68,.1)!important;border:1px solid rgba(239,68,68,.2)!important;color:#ef4444!important;}
    .b-auto{background:rgba(16,185,129,.1)!important;border:1px solid rgba(16,185,129,.25)!important;color:#10b981!important;}
    .b-new{background:rgba(6,182,212,.1)!important;border:1px solid rgba(6,182,212,.25)!important;color:#06b6d4!important;}
    .b-on{background:rgba(139,92,246,.1)!important;border:1px solid rgba(139,92,246,.2)!important;color:#8b5cf6!important;}
    .fld{display:flex!important;flex-direction:column!important;gap:3px!important;margin-bottom:7px!important;}
    .fld:last-child{margin-bottom:0!important;}
    .fld label{font-size:10px!important;font-weight:600!important;color:#94a3b8!important;}
    .fld label .req{color:#ef4444!important;}
    .fld label .tip{font-size:9px!important;color:#475569!important;font-weight:400!important;}
    .inp{
      background:#07090f!important;border:1px solid #1e2d42!important;border-radius:6px!important;
      padding:6px 9px!important;color:#e2e8f0!important;font-size:11.5px!important;
      font-family:monospace!important;outline:none!important;width:100%!important;
      transition:border-color .2s,box-shadow .2s!important;
    }
    .inp:focus{border-color:#10b981!important;box-shadow:0 0 0 2px rgba(16,185,129,.1)!important;}
    .inp::placeholder{color:#475569!important;}
    .inp:disabled{opacity:.4!important;cursor:not-allowed!important;}
    .inp-wrap{position:relative!important;}
    .inp-wrap .inp{padding-right:30px!important;}
    .eye-btn{
      position:absolute!important;right:7px!important;top:50%!important;transform:translateY(-50%)!important;
      background:none!important;border:none!important;color:#475569!important;cursor:pointer!important;
      font-size:10px!important;padding:2px!important;
    }
    .eye-btn:hover{color:#10b981!important;}
    .frow{display:flex!important;gap:7px!important;}
    .frow .fld{flex:1!important;}
    .fhint{font-size:9px!important;color:#475569!important;font-family:monospace!important;margin-top:2px!important;}
    .btn{
      padding:6px 12px!important;border-radius:7px!important;border:1px solid #28405c!important;
      background:#16202e!important;color:#e2e8f0!important;
      font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif!important;
      font-size:11.5px!important;font-weight:600!important;cursor:pointer!important;transition:all .15s!important;
      display:inline-flex!important;align-items:center!important;justify-content:center!important;gap:5px!important;
      white-space:nowrap!important;-webkit-appearance:none!important;outline:none!important;
      min-height:30px!important;line-height:1!important;
    }
    .btn:hover:not(:disabled){background:#1c2a3a!important;}
    .btn:active:not(:disabled){transform:scale(.98)!important;}
    .btn:disabled{opacity:.35!important;cursor:not-allowed!important;pointer-events:none!important;}
    .btn.pri{background:linear-gradient(135deg,#10b981,#06b6d4)!important;border-color:transparent!important;color:#fff!important;box-shadow:0 3px 10px rgba(16,185,129,.3)!important;}
    .btn.pri:hover:not(:disabled){opacity:.88!important;}
    .btn.suc{background:rgba(16,185,129,.1)!important;border-color:rgba(16,185,129,.3)!important;color:#10b981!important;}
    .btn.dan{background:rgba(239,68,68,.1)!important;border-color:rgba(239,68,68,.25)!important;color:#ef4444!important;}
    .btn.dan:hover:not(:disabled){background:rgba(239,68,68,.18)!important;}
    .btn.wrn{background:rgba(245,158,11,.1)!important;border-color:rgba(245,158,11,.25)!important;color:#f59e0b!important;}
    .btn.inf{background:rgba(6,182,212,.08)!important;border-color:rgba(6,182,212,.2)!important;color:#06b6d4!important;}
    .btn.org{background:rgba(249,115,22,.1)!important;border-color:rgba(249,115,22,.25)!important;color:#f97316!important;}
    .btn.sm{padding:4px 9px!important;font-size:10.5px!important;min-height:26px!important;}
    .btn.lg{padding:8px 16px!important;font-size:12.5px!important;min-height:36px!important;}
    .btn.full{width:100%!important;}
    .btn.conf{background:rgba(16,185,129,.05)!important;border-color:rgba(16,185,129,.12)!important;color:rgba(16,185,129,.45)!important;cursor:default!important;pointer-events:none!important;}
    .brow{display:flex!important;gap:6px!important;flex-wrap:wrap!important;align-items:center!important;}
    .tog{width:32px!important;height:17px!important;border-radius:9px!important;background:#16202e!important;border:1px solid #28405c!important;cursor:pointer!important;position:relative!important;flex-shrink:0!important;transition:background .22s,border-color .22s!important;}
    .tog.on{background:#10b981!important;border-color:#10b981!important;}
    .tog::after{content:''!important;position:absolute!important;top:3px!important;left:3px!important;width:9px!important;height:9px!important;border-radius:50%!important;background:#475569!important;transition:transform .22s,background .22s!important;}
    .tog.on::after{transform:translateX(15px)!important;background:#fff!important;}
    .tog-row{display:flex!important;align-items:center!important;justify-content:space-between!important;padding:5px 0!important;}
    .tog-lbl{font-size:11px!important;color:#94a3b8!important;font-weight:500!important;}
    .tog-lbl span{font-size:9px!important;color:#475569!important;display:block!important;margin-top:1px!important;}
    .prog-outer{background:#07090f!important;border:1px solid #1e2d42!important;border-radius:5px!important;height:6px!important;overflow:hidden!important;}
    .prog-inner{height:100%!important;background:linear-gradient(90deg,#10b981,#06b6d4)!important;border-radius:5px!important;transition:width .5s ease!important;width:0%!important;}
    .prog-inner.full{background:linear-gradient(90deg,#10b981,#059669)!important;}
    .prog-nums{display:flex!important;justify-content:space-between!important;font-size:10px!important;color:#94a3b8!important;margin-top:4px!important;font-family:monospace!important;}
    .stats-row{display:flex!important;gap:5px!important;flex-wrap:wrap!important;margin-top:7px!important;}
    .chip{display:flex!important;align-items:center!important;gap:3px!important;padding:3px 7px!important;border-radius:4px!important;background:#111622!important;border:1px solid #1e2d42!important;font-size:9.5px!important;font-family:monospace!important;color:#475569!important;}
    .chip .v{font-weight:700!important;color:#94a3b8!important;}
    .chip.g .v{color:#10b981!important;}.chip.r .v{color:#ef4444!important;}
    .chip.y .v{color:#f59e0b!important;}.chip.c .v{color:#06b6d4!important;}
    .chip.o .v{color:#f97316!important;}
    .dom-grid{display:flex!important;flex-direction:column!important;gap:5px!important;margin-top:7px!important;}
    .dom-row{background:#111622!important;border:1px solid #1e2d42!important;border-radius:7px!important;overflow:hidden!important;}
    .dom-hdr{display:flex!important;align-items:center!important;gap:7px!important;padding:6px 9px!important;cursor:pointer!important;user-select:none!important;}
    .dom-hdr:hover{background:rgba(255,255,255,.015)!important;}
    .dom-name{flex:1!important;font-size:11px!important;font-weight:600!important;color:#e2e8f0!important;overflow:hidden!important;text-overflow:ellipsis!important;white-space:nowrap!important;}
    .dom-pct-inp{
      width:52px!important;background:#0c0f1a!important;border:1px solid #1e2d42!important;
      border-radius:4px!important;padding:2px 5px!important;color:#10b981!important;
      font-size:10.5px!important;font-family:monospace!important;text-align:center!important;outline:none!important;
    }
    .dom-pct-inp:focus{border-color:#10b981!important;}
    .dom-q{font-size:9.5px!important;color:#475569!important;font-family:monospace!important;min-width:28px!important;text-align:right!important;}
    .dom-arr{font-size:9px!important;color:#475569!important;transition:transform .2s!important;flex-shrink:0!important;}
    .dom-row.open .dom-arr{transform:rotate(180deg)!important;}
    .sub-list{display:none!important;padding:4px 9px 8px 20px!important;border-top:1px solid #1e2d42!important;background:#0c0f1a!important;}
    .dom-row.open .sub-list{display:block!important;}
    .sub-row{display:flex!important;align-items:center!important;gap:6px!important;margin-bottom:4px!important;}
    .sub-row:last-child{margin-bottom:0!important;}
    .sub-name{flex:1!important;font-size:10px!important;color:#94a3b8!important;}
    .sub-pct-inp{
      width:44px!important;background:#111622!important;border:1px solid #1e2d42!important;
      border-radius:3px!important;padding:2px 4px!important;color:#e2e8f0!important;
      font-size:10px!important;font-family:monospace!important;text-align:center!important;outline:none!important;
    }
    .sub-q{font-size:9px!important;color:#475569!important;font-family:monospace!important;min-width:24px!important;text-align:right!important;}
    .dom-total{
      display:flex!important;justify-content:space-between!important;align-items:center!important;
      padding:4px 8px!important;border-radius:5px!important;margin-top:7px!important;
      font-size:10px!important;font-family:monospace!important;font-weight:700!important;
    }
    .dom-total.ok{background:rgba(16,185,129,.08)!important;border:1px solid rgba(16,185,129,.2)!important;color:#10b981!important;}
    .dom-total.warn{background:rgba(245,158,11,.08)!important;border:1px solid rgba(245,158,11,.2)!important;color:#f59e0b!important;}
    .dom-total.err{background:rgba(239,68,68,.08)!important;border:1px solid rgba(239,68,68,.2)!important;color:#ef4444!important;}
    .qt-grid{display:grid!important;grid-template-columns:1fr 1fr!important;gap:5px!important;margin-top:7px!important;}
    .qt-chip{
      display:flex!important;align-items:center!important;justify-content:space-between!important;
      padding:5px 8px!important;border-radius:6px!important;background:#111622!important;border:1px solid #1e2d42!important;
    }
    .qt-label{font-size:10px!important;color:#94a3b8!important;overflow:hidden!important;text-overflow:ellipsis!important;white-space:nowrap!important;flex:1!important;}
    .qt-pct-inp{
      width:44px!important;background:#0c0f1a!important;border:1px solid #1e2d42!important;
      border-radius:3px!important;padding:2px 4px!important;color:#10b981!important;
      font-size:10px!important;font-family:monospace!important;text-align:center!important;outline:none!important;flex-shrink:0!important;
    }
    .qt-pct-inp:focus{border-color:#10b981!important;}
    .qt-q{font-size:9px!important;color:#475569!important;font-family:monospace!important;flex-shrink:0!important;margin-left:4px!important;}
    .det-grid{display:grid!important;grid-template-columns:repeat(3,1fr)!important;gap:5px!important;margin-top:7px!important;}
    .det-chip{background:#111622!important;border:1px solid #1e2d42!important;border-radius:6px!important;padding:7px 8px!important;text-align:center!important;}
    .det-val{font-size:15px!important;font-weight:800!important;color:#10b981!important;font-family:monospace!important;}
    .det-lbl{font-size:8.5px!important;color:#475569!important;text-transform:uppercase!important;letter-spacing:.5px!important;margin-top:2px!important;}
    .book-list{display:flex!important;flex-direction:column!important;gap:4px!important;margin-top:7px!important;}
    .book-item{
      display:flex!important;align-items:center!important;gap:7px!important;
      padding:5px 9px!important;border-radius:6px!important;
      background:#111622!important;border:1px solid #1e2d42!important;transition:all .2s!important;
    }
    .book-item.active{border-color:rgba(16,185,129,.35)!important;background:rgba(16,185,129,.04)!important;}
    .book-ico{font-size:12px!important;flex-shrink:0!important;}
    .book-name{flex:1!important;font-size:10.5px!important;color:#94a3b8!important;overflow:hidden!important;text-overflow:ellipsis!important;white-space:nowrap!important;}
    .book-item.active .book-name{color:#e2e8f0!important;}
    .book-qc{font-size:9px!important;color:#475569!important;font-family:monospace!important;flex-shrink:0!important;}
    .book-item.active .book-qc{color:#10b981!important;}
    .feed{display:flex!important;flex-direction:column!important;gap:2px!important;max-height:80px!important;overflow-y:auto!important;margin-top:7px!important;}
    .feed-item{display:flex!important;align-items:center!important;gap:5px!important;padding:3px 7px!important;border-radius:4px!important;background:#111622!important;border:1px solid #1e2d42!important;font-size:9.5px!important;font-family:monospace!important;}
    .feed-n{color:#475569!important;flex-shrink:0!important;}
    .feed-t{flex:1!important;color:#94a3b8!important;overflow:hidden!important;text-overflow:ellipsis!important;white-space:nowrap!important;}
    .feed-s{font-size:8.5px!important;padding:1px 4px!important;border-radius:3px!important;font-weight:700!important;flex-shrink:0!important;}
    .feed-item.ok .feed-s{background:rgba(16,185,129,.12)!important;color:#10b981!important;}
    .feed-item.fail .feed-s{background:rgba(239,68,68,.1)!important;color:#ef4444!important;}
    .feed-item.patch .feed-s{background:rgba(245,158,11,.12)!important;color:#f59e0b!important;}
    .feed-item.cur .feed-s{background:rgba(16,185,129,.15)!important;color:#10b981!important;animation:pqaPulse 1s infinite!important;}
    .step{
      display:flex!important;align-items:flex-start!important;gap:9px!important;
      padding:9px 10px!important;border-radius:8px!important;border:1px solid #1e2d42!important;
      background:#111622!important;transition:all .25s!important;margin-bottom:6px!important;
      position:relative!important;overflow:hidden!important;
    }
    .step:last-child{margin-bottom:0!important;}
    .step::before{content:''!important;position:absolute!important;top:0!important;left:0!important;width:2px!important;height:100%!important;background:#1e2d42!important;}
    .step.active{border-color:rgba(16,185,129,.35)!important;background:rgba(16,185,129,.04)!important;}
    .step.active::before{background:#10b981!important;}
    .step.done{border-color:rgba(6,182,212,.25)!important;background:rgba(6,182,212,.03)!important;}
    .step.done::before{background:#06b6d4!important;}
    .step-n{
      width:22px!important;height:22px!important;border-radius:50%!important;
      display:flex!important;align-items:center!important;justify-content:center!important;
      font-size:10.5px!important;font-weight:800!important;background:#16202e!important;
      border:1.5px solid #28405c!important;color:#475569!important;flex-shrink:0!important;margin-top:1px!important;
    }
    .step.active .step-n{background:rgba(16,185,129,.12)!important;border-color:#10b981!important;color:#10b981!important;}
    .step.done .step-n{background:rgba(6,182,212,.12)!important;border-color:#06b6d4!important;color:#06b6d4!important;}
    .step-title{font-size:11.5px!important;font-weight:700!important;color:#94a3b8!important;margin-bottom:2px!important;}
    .step.active .step-title{color:#e2e8f0!important;}
    .step.done .step-title{color:#06b6d4!important;}
    .step-desc{font-size:10.5px!important;color:#475569!important;line-height:1.4!important;margin-bottom:7px!important;}
    .step.active .step-desc{color:#94a3b8!important;}
    .step-acts{display:flex!important;gap:5px!important;flex-wrap:wrap!important;}
    .acc{border:1px solid #1e2d42!important;border-radius:8px!important;overflow:hidden!important;}
    .acc-hdr{display:flex!important;align-items:center!important;justify-content:space-between!important;padding:8px 11px!important;background:#111622!important;cursor:pointer!important;user-select:none!important;font-size:11px!important;font-weight:600!important;color:#94a3b8!important;}
    .acc-hdr:hover{background:#16202e!important;}
    .acc-arr{transition:transform .22s!important;font-size:9.5px!important;color:#475569!important;}
    .acc.open .acc-arr{transform:rotate(180deg)!important;}
    .acc-body{display:none!important;padding:9px 11px!important;background:#0c0f1a!important;border-top:1px solid #1e2d42!important;}
    .acc.open .acc-body{display:block!important;}
    .log-wrap{background:#07090f!important;border:1px solid #1e2d42!important;border-radius:7px!important;overflow:hidden!important;}
    .log-tb{display:flex!important;align-items:center!important;justify-content:space-between!important;padding:4px 9px!important;background:#111622!important;border-bottom:1px solid #1e2d42!important;}
    .log-title{font-size:8.5px!important;font-weight:700!important;text-transform:uppercase!important;letter-spacing:1px!important;color:#475569!important;display:flex!important;align-items:center!important;gap:5px!important;}
    .log-live{width:5px!important;height:5px!important;border-radius:50%!important;background:#10b981!important;animation:pqaPulse 2s infinite!important;}
    .log-btns{display:flex!important;gap:4px!important;}
    .log-btn{padding:2px 7px!important;border-radius:3px!important;border:1px solid #1e2d42!important;background:#16202e!important;color:#475569!important;font-size:9px!important;font-family:monospace!important;cursor:pointer!important;}
    .log-btn:hover{color:#94a3b8!important;background:#1c2a3a!important;}
    #pqa-log{padding:6px 9px!important;max-height:130px!important;min-height:40px!important;overflow-y:auto!important;font-family:monospace!important;font-size:10px!important;line-height:1.65!important;}
    #pqa-log::-webkit-scrollbar{width:2px!important;}
    #pqa-log::-webkit-scrollbar-thumb{background:#28405c!important;}
    .le{display:flex!important;gap:5px!important;align-items:flex-start!important;}
    .le-ts{color:#475569!important;flex-shrink:0!important;font-size:9px!important;padding-top:1px!important;}
    .le-lv{font-size:8px!important;font-weight:700!important;text-transform:uppercase!important;padding:1px 4px!important;border-radius:2px!important;flex-shrink:0!important;margin-top:1px!important;}
    .le-lv.info{background:rgba(16,185,129,.12)!important;color:#10b981!important;}
    .le-lv.ok{background:rgba(6,182,212,.12)!important;color:#06b6d4!important;}
    .le-lv.warn{background:rgba(245,158,11,.1)!important;color:#f59e0b!important;}
    .le-lv.error{background:rgba(239,68,68,.12)!important;color:#ef4444!important;}
    .le-lv.hi{background:rgba(16,185,129,.15)!important;color:#10b981!important;}
    .le-lv.debug{background:rgba(71,85,105,.1)!important;color:#475569!important;}
    .le-msg{color:#94a3b8!important;flex:1!important;word-break:break-word!important;}
    .le.ok .le-msg{color:rgba(6,182,212,.9)!important;}
    .le.error .le-msg{color:rgba(239,68,68,.9)!important;}
    .le.warn .le-msg{color:rgba(245,158,11,.9)!important;}
    .le.hi .le-msg{color:rgba(16,185,129,.9)!important;}
    .conn-r{display:flex!important;align-items:center!important;gap:5px!important;padding:4px 9px!important;border-radius:5px!important;font-size:10px!important;font-family:monospace!important;margin-top:6px!important;}
    .conn-r.hidden{display:none!important;}
    .conn-r.ok{background:rgba(16,185,129,.08)!important;border:1px solid rgba(16,185,129,.2)!important;color:#10b981!important;}
    .conn-r.err{background:rgba(239,68,68,.08)!important;border:1px solid rgba(239,68,68,.2)!important;color:#ef4444!important;}
    .conn-r.test{background:rgba(6,182,212,.08)!important;border:1px solid rgba(6,182,212,.2)!important;color:#06b6d4!important;}
    .info-box{font-size:10px!important;color:#475569!important;line-height:1.5!important;background:rgba(6,182,212,.04)!important;border:1px solid rgba(6,182,212,.12)!important;border-radius:6px!important;padding:7px 9px!important;margin-bottom:6px!important;}
    .info-box b{color:#06b6d4!important;}
    .ctrl-grid{display:grid!important;grid-template-columns:1fr 1fr!important;gap:6px!important;}
    .ctrl-grid .full-col{grid-column:1/-1!important;}
    .divider{height:1px!important;background:#1e2d42!important;margin:7px 0!important;}
    #pqa-toasts{position:fixed!important;top:14px!important;left:50%!important;transform:translateX(-50%)!important;z-index:2147483647!important;display:flex!important;flex-direction:column!important;gap:5px!important;pointer-events:none!important;min-width:200px!important;max-width:400px!important;}
    .toast{padding:9px 13px!important;border-radius:9px!important;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif!important;font-size:12px!important;font-weight:600!important;display:flex!important;align-items:center!important;gap:7px!important;box-shadow:0 8px 28px rgba(0,0,0,.5)!important;transform:translateY(-12px)!important;opacity:0!important;transition:transform .28s cubic-bezier(.34,1.56,.64,1),opacity .28s!important;pointer-events:all!important;border:1px solid!important;}
    .toast.show{transform:translateY(0)!important;opacity:1!important;}
    .toast.hide{transform:translateY(-8px)!important;opacity:0!important;}
    .toast.info{background:#16202e!important;border-color:rgba(16,185,129,.3)!important;color:#e2e8f0!important;}
    .toast.success{background:rgba(0,40,25,.95)!important;border-color:rgba(16,185,129,.4)!important;color:#10b981!important;}
    .toast.warning{background:rgba(40,30,0,.95)!important;border-color:rgba(245,158,11,.4)!important;color:#f59e0b!important;}
    .toast.error{background:rgba(40,0,5,.95)!important;border-color:rgba(239,68,68,.4)!important;color:#ef4444!important;}
    @media(max-width:500px){#pqa-wrap{width:calc(100vw - 16px)!important;right:8px!important;}}
  `);

  /* ════════════════════════════════════════════════════════════
     UI BUILD
  ════════════════════════════════════════════════════════════ */
  function buildUI() {
    document.getElementById('pqa-wrap')?.remove();
    document.getElementById('pqa-toasts')?.remove();

    const tc = document.createElement('div'); tc.id='pqa-toasts'; document.body.appendChild(tc);

    const wrap = document.createElement('div'); wrap.id='pqa-wrap';
    wrap.innerHTML=`
    <div id="pqa-panel">
      <div id="pqa-hdr">
        <div class="h-brand">
          <div class="h-logo">&#10067;</div>
          <div>
            <div class="h-title">PracticeQ AutoPilot</div>
            <div class="h-sub">v${VERSION} &middot; ${BUILD}</div>
          </div>
          <span class="h-badge">v3.2.1</span>
        </div>
        <div class="h-btns">
          <button class="h-btn" id="btn-export" title="Export Log">&#128203;</button>
          <button class="h-btn" id="btn-min" title="Minimize">&#8212;</button>
          <button class="h-btn danger" id="btn-close" title="Close">&#10005;</button>
        </div>
      </div>

      <div id="pqa-sbar">
        <div id="pqa-status" class="idle"><span class="s-dot pulse"></span><span id="status-txt">Idle</span></div>
        <div class="sb-r">
          <span id="pqa-phase">Fill config below to begin</span>
          <span id="pqa-elapsed">00:00:00</span>
        </div>
      </div>

      <div id="pqa-body">

        <div class="card">
          <div class="card-hdr">
            <div class="card-title ct-blu">&#128279; Google Docs</div>
            <span class="badge b-req">Required</span>
          </div>
          <div class="fld">
            <label>Apps Script URL <span class="req">*</span></label>
            <input id="f-url" class="inp" type="text" placeholder="https://script.google.com/macros/s/.../exec"/>
          </div>
          <div class="frow">
            <div class="fld">
              <label>Doc ID <span class="req">*</span></label>
              <input id="f-docid" class="inp" type="text" placeholder="1aBcDe..."/>
            </div>
            <div class="fld">
              <label>Secret Key <span class="req">*</span></label>
              <div class="inp-wrap">
                <input id="f-key" class="inp" type="password" placeholder="secret..."/>
                <button class="eye-btn" id="btn-eye">&#128065;</button>
              </div>
            </div>
          </div>
          <div class="brow">
            <button class="btn inf sm" id="btn-test">&#129514; Test Connection</button>
          </div>
          <div id="conn-result" class="conn-r hidden"><span id="conn-msg"></span></div>
        </div>

        <div class="card">
          <div class="card-hdr">
            <div class="card-title">&#128218; Exam Config</div>
            <span class="badge b-req">Required</span>
          </div>
          <div class="fld">
            <label>Exam Name <span class="req">*</span></label>
            <input id="f-exam" class="inp" type="text" placeholder="e.g. AWS Solutions Architect SAA-C03"/>
          </div>
          <div class="frow">
            <div class="fld">
              <label>Total Questions <span class="req">*</span></label>
              <input id="f-totalq" class="inp" type="number" placeholder="200" min="1" max="9999"/>
            </div>
            <div class="fld">
              <label>Batch Size</label>
              <input id="f-batch" class="inp" type="number" placeholder="15" min="1" max="50"/>
              <div class="fhint">Qs per GPT prompt</div>
            </div>
          </div>
          <div class="frow">
            <div class="fld">
              <label>Min Explanation Lines</label>
              <input id="f-minl" class="inp" type="number" placeholder="5" min="1" max="20"/>
            </div>
            <div class="fld">
              <label>Max Explanation Lines</label>
              <input id="f-maxl" class="inp" type="number" placeholder="7" min="1" max="30"/>
            </div>
          </div>
          <div class="frow">
            <div class="fld">
              <label>Start From Batch <span class="tip">(resume)</span></label>
              <input id="f-startbatch" class="inp" type="number" placeholder="1" min="1"/>
            </div>
            <div class="fld">
              <label>Max Retries / Batch</label>
              <input id="f-maxretry" class="inp" type="number" placeholder="5" value="5" min="1" max="20"/>
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card-hdr"><div class="card-title ct-cyn">&#128203; Workflow</div></div>
          <div class="step" id="step1">
            <div class="step-n" id="step1-n">1</div>
            <div style="flex:1;min-width:0">
              <div class="step-title">Upload Outline + Sample Questions</div>
              <div class="step-desc">Upload exam outline AND sample questions to GPT. v3.2 auto-detects: domains, subdomains, question types %, option count, option length, statement length.</div>
              <div class="step-acts">
                <button class="btn inf sm" id="btn-open-upload">&#128206; Open GPT Upload</button>
                <button class="btn suc sm" id="btn-upload-ok" disabled>&#10003; Confirm Upload</button>
              </div>
            </div>
          </div>
          <div class="step" id="step2">
            <div class="step-n" id="step2-n">2</div>
            <div style="flex:1;min-width:0">
              <div class="step-title">Upload Reference Books</div>
              <div class="step-desc">Upload ALL reference PDFs to GPT. v3.2 auto-detects book names and distributes questions proportionally across every book, rotating automatically.</div>
              <div class="step-acts">
                <button class="btn inf sm" id="btn-open-books">&#128218; Open GPT Upload</button>
                <button class="btn suc sm" id="btn-books-ok" disabled>&#10003; Confirm Books</button>
              </div>
            </div>
          </div>
          <div class="step" id="step3">
            <div class="step-n" id="step3-n">3</div>
            <div style="flex:1;min-width:0">
              <div class="step-title">Auto Generate — Zero Interruption</div>
              <div class="step-desc">v3.2 fixes: batch count enforcement (exact Qs generated), rule reinforcement after errors, math-safe Docs posting, and smart dedup (20-stem window).</div>
            </div>
          </div>
        </div>

        <div class="card" id="card-detected" style="display:none">
          <div class="card-hdr">
            <div class="card-title ct-cyn">&#128270; Detected Parameters</div>
            <span class="badge b-auto">Auto-Filled</span>
          </div>
          <div class="det-grid">
            <div class="det-chip"><div class="det-val" id="det-optcount">—</div><div class="det-lbl">Options/Q</div></div>
            <div class="det-chip"><div class="det-val" id="det-optlen">—</div><div class="det-lbl">Opt Length</div></div>
            <div class="det-chip"><div class="det-val" id="det-stmtlen">—</div><div class="det-lbl">Stmt Style</div></div>
          </div>
        </div>

        <div class="card" id="card-domains">
          <div class="card-hdr">
            <div class="card-title ct-org">&#127758; Domain Mapping</div>
            <span class="badge b-auto" id="domain-badge">Pending</span>
          </div>
          <div class="info-box" id="domain-hint">
            <b>Auto-detect:</b> Upload outline + sample questions. v3.2 detects all domains, subdomains and weights automatically.
          </div>
          <div class="dom-grid" id="dom-grid"></div>
          <div id="dom-total-bar" class="dom-total warn" style="display:none">
            <span>Total: <b id="dom-total-val">0</b>%</span>
            <span id="dom-total-status">—</span>
          </div>
        </div>

        <div class="card" id="card-qtypes">
          <div class="card-hdr">
            <div class="card-title ct-org">&#127381; Question Types</div>
            <span class="badge b-auto" id="qtype-badge">Pending</span>
          </div>
          <div class="info-box" id="qtype-hint">
            <b>Auto-detect:</b> Detected from sample questions. Batches are grouped by type.
          </div>
          <div class="qt-grid" id="qt-grid"></div>
          <div id="qt-total-bar" class="dom-total warn" style="display:none">
            <span>Total: <b id="qt-total-val">0</b>%</span>
            <span id="qt-total-status">—</span>
          </div>
        </div>

        <div class="card" id="card-books">
          <div class="card-hdr">
            <div class="card-title ct-prp">&#128218; Reference Books</div>
            <span class="badge b-auto" id="books-badge">Pending</span>
          </div>
          <div class="info-box" id="books-hint">
            <b>Auto-detect:</b> Book names detected from GPT response. Questions distributed proportionally.
          </div>
          <div class="book-list" id="book-list"></div>
        </div>

        <div class="card">
          <div class="card-hdr">
            <div class="card-title">&#128202; Progress</div>
            <span id="pg-pct" style="font-family:monospace;font-size:12px;font-weight:700;color:#10b981">0%</span>
          </div>
          <div class="prog-outer"><div class="prog-inner" id="prog-bar"></div></div>
          <div class="prog-nums">
            <span id="pg-phase-txt" style="color:#475569">Waiting...</span>
            <span id="pg-txt">0 / 0 questions</span>
          </div>
          <div class="stats-row">
            <div class="chip g"><span>&#10003;</span><span class="v" id="stat-done">0</span><span>done</span></div>
            <div class="chip r"><span>&#10007;</span><span class="v" id="stat-fail">0</span><span>fail</span></div>
            <div class="chip y"><span>&#8634;</span><span class="v" id="stat-retry">0</span><span>retry</span></div>
            <div class="chip c"><span>&#128220;</span><span class="v" id="stat-batch">0</span><span>batch</span></div>
            <div class="chip o"><span>&#128218;</span><span class="v" id="stat-book">—</span><span>book</span></div>
            <div class="chip"><span>&#128683;</span><span class="v" id="stat-dedup">0</span><span>dedup</span></div>
            <div class="chip y"><span>&#128247;</span><span class="v" id="stat-patch">0</span><span>patched</span></div>
          </div>
          <div style="display:flex;align-items:center;justify-content:space-between;margin-top:7px;margin-bottom:4px">
            <span style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#475569">Recent Batches</span>
            <button class="log-btn" id="btn-clear-feed">Clear</button>
          </div>
          <div class="feed" id="batch-feed"></div>
          <div id="fail-box" style="display:none;font-size:10px;font-family:monospace;color:#ef4444;padding:4px 8px;background:rgba(239,68,68,.05);border:1px solid rgba(239,68,68,.15);border-radius:5px;margin-top:6px;line-height:1.6">
            <b>Failed batches:</b> <span id="fail-list"></span>
          </div>
        </div>

        <div class="card">
          <div class="card-hdr"><div class="card-title">&#127917; Controls</div></div>
          <div class="ctrl-grid">
            <button class="btn pri lg full-col" id="btn-start">&#9654; Start Generation</button>
            <button class="btn wrn" id="btn-pause" disabled>&#9208; Pause</button>
            <button class="btn" id="btn-resume" disabled>&#9654; Resume</button>
            <button class="btn inf" id="btn-retry" disabled>&#8634; Retry Batch</button>
            <button class="btn sm" id="btn-skip" disabled>&#9197; Skip Batch</button>
            <button class="btn dan sm" id="btn-stop" disabled>&#9209; Stop</button>
          </div>
          <div class="divider"></div>
          <div class="brow">
            <button class="btn dan sm" id="btn-reset">&#128465; Reset All</button>
            <button class="btn org sm" id="btn-export-plan">&#128203; Export Plan</button>
          </div>
        </div>

        <div class="acc" id="acc-adv">
          <div class="acc-hdr" id="acc-adv-hdr"><span>&#9881; Advanced Settings</span><span class="acc-arr">&#9660;</span></div>
          <div class="acc-body">
            <div class="frow">
              <div class="fld"><label>Poll (ms)</label><input id="f-poll" class="inp" type="number" placeholder="800" value="800"/></div>
              <div class="fld"><label>Timeout (ms)</label><input id="f-timeout" class="inp" type="number" placeholder="300000"/></div>
            </div>
            <div class="frow">
              <div class="fld"><label>Batch Delay (ms)</label><input id="f-batchdelay" class="inp" type="number" placeholder="2500"/></div>
              <div class="fld"><label>Remind Every (batches)</label><input id="f-remind" class="inp" type="number" value="5" min="1"/></div>
            </div>
            <div class="frow">
              <div class="fld"><label>Min Valid Chars</label><input id="f-minresp" class="inp" type="number" placeholder="300" value="300"/></div>
              <div class="fld"><label>Max Option Words</label><input id="f-maxoptw" class="inp" type="number" placeholder="4" value="4" min="2" max="10"/></div>
            </div>
            <div class="tog-row">
              <div class="tog-lbl">Post generation plan to Docs</div>
              <div class="tog on" id="tog-postplan"></div>
            </div>
            <div class="tog-row">
              <div class="tog-lbl">Validate response quality</div>
              <div class="tog on" id="tog-validate"></div>
            </div>
            <div class="tog-row">
              <div class="tog-lbl">Force answer position rotation</div>
              <div class="tog on" id="tog-rotation"></div>
            </div>
            <div class="tog-row">
              <div class="tog-lbl">Math-safe Google Docs mode<span>Converts math symbols to ASCII-safe text</span></div>
              <div class="tog on" id="tog-mathsafe"></div>
            </div>
          </div>
        </div>

        <div class="card" style="padding:0">
          <div class="log-wrap">
            <div class="log-tb">
              <div class="log-title"><span class="log-live"></span>Console</div>
              <div class="log-btns">
                <button class="log-btn" id="btn-log-copy">Copy</button>
                <button class="log-btn" id="btn-log-clear">Clear</button>
              </div>
            </div>
            <div id="pqa-log"></div>
          </div>
        </div>
        <div style="height:4px"></div>
      </div>
    </div>`;
    document.body.appendChild(wrap);
    return wrap;
  }

  /* ════════════════════════════════════════════════════════════
     DRAG
  ════════════════════════════════════════════════════════════ */
  function initDrag(wrap) {
    const hdr=document.getElementById('pqa-hdr'); if(!hdr) return;
    let drag=false,sx,sy,ox,oy;
    hdr.addEventListener('mousedown',e=>{
      if(e.target.closest('button'))return;
      drag=true;sx=e.clientX;sy=e.clientY;
      const r=wrap.getBoundingClientRect();ox=r.left;oy=r.top;
      document.body.style.userSelect='none';
    });
    document.addEventListener('mousemove',e=>{
      if(!drag)return;
      wrap.style.left=Math.max(0,ox+e.clientX-sx)+'px';
      wrap.style.top=Math.max(0,oy+e.clientY-sy)+'px';
      wrap.style.right='auto';
    });
    document.addEventListener('mouseup',()=>{drag=false;document.body.style.userSelect='';});
  }

  /* ════════════════════════════════════════════════════════════
     LOG / TOAST / STATUS
  ════════════════════════════════════════════════════════════ */
  function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}

  function log(msg,level='info'){
    const el=document.getElementById('pqa-log'); if(!el) return;
    const ts=new Date().toLocaleTimeString('en-US',{hour12:false,hour:'2-digit',minute:'2-digit',second:'2-digit'});
    const lm={info:'INFO',ok:'OK',warn:'WARN',error:'ERR',debug:'DBG',hi:'SYS'};
    S.logEntries.push({ts,level,message:msg});
    const d=document.createElement('div'); d.className=`le ${level}`;
    d.innerHTML=`<span class="le-ts">${ts}</span><span class="le-lv ${level}">${lm[level]||'INFO'}</span><span class="le-msg">${esc(msg)}</span>`;
    el.appendChild(d);
    if(el.children.length>500)el.children[0].remove();
    el.scrollTop=el.scrollHeight;
    (level==='error'?console.error:level==='warn'?console.warn:console.log)('[PQA3.2]',msg);
  }

  function toast(msg,type='info',dur=4000){
    const c=document.getElementById('pqa-toasts'); if(!c) return;
    const icons={info:'i',success:'✓',warning:'!',error:'✕'};
    const t=document.createElement('div'); t.className=`toast ${type}`;
    t.innerHTML=`<span>${icons[type]||'i'}</span><span>${esc(msg)}</span><button style="margin-left:auto;background:none;border:none;color:inherit;opacity:.5;cursor:pointer;font-size:10px" onclick="this.parentElement.remove()">✕</button>`;
    c.appendChild(t);
    requestAnimationFrame(()=>requestAnimationFrame(()=>t.classList.add('show')));
    setTimeout(()=>{t.classList.remove('show');t.classList.add('hide');setTimeout(()=>t.remove(),400);},dur);
  }

  function setStatus(cls,txt){
    const b=document.getElementById('pqa-status'),t=document.getElementById('status-txt');
    if(b){b.className=cls;const d=b.querySelector('.s-dot');if(d)d.className='s-dot'+(['running','paused'].includes(cls)?' pulse':'');}
    if(t)t.textContent=txt;
  }
  function setPhase(txt){
    const a=document.getElementById('pqa-phase');if(a)a.textContent=txt;
    const b=document.getElementById('pg-phase-txt');if(b)b.textContent=txt;
  }
  function setProgress(done,total){
    S.currentQuestion=done; S.totalQuestions=total;
    const pct=total>0?Math.round(done/total*100):0;
    const bar=document.getElementById('prog-bar');
    if(bar){bar.style.width=pct+'%';if(pct>=100)bar.classList.add('full');}
    const pt=document.getElementById('pg-txt');if(pt)pt.textContent=`${done} / ${total} questions`;
    const pp=document.getElementById('pg-pct');if(pp)pp.textContent=pct+'%';
    const sd=document.getElementById('stat-done');if(sd)sd.textContent=S.completedBatches.length;
    const sb=document.getElementById('stat-batch');if(sb)sb.textContent=S.currentBatch;
    const sdd=document.getElementById('stat-dedup');if(sdd)sdd.textContent=S.stemRegistry.size;
    updateFailUI(); store.save();
  }
  function updateFailUI(){
    const sf=document.getElementById('stat-fail');if(sf)sf.textContent=S.failedBatches.length;
    const sr=document.getElementById('stat-retry');if(sr)sr.textContent=S.globalErrors;
    const fb=document.getElementById('fail-box'),fl=document.getElementById('fail-list');
    if(fb&&fl){fb.style.display=S.failedBatches.length>0?'block':'none';if(fl)fl.textContent=S.failedBatches.join(', ');}
  }
  function setStep(n,st){
    const el=document.getElementById(`step${n}`),nm=document.getElementById(`step${n}-n`);
    if(!el)return;
    el.className=`step${st?' '+st:''}`;
    if(nm)nm.textContent=st==='done'?'✓':st==='error'?'✗':n;
  }
  function setBtns(running){
    const g=id=>document.getElementById(id);
    if(g('btn-start'))g('btn-start').disabled=running;
    if(g('btn-pause'))g('btn-pause').disabled=!running;
    if(g('btn-resume'))g('btn-resume').disabled=true;
    if(g('btn-retry'))g('btn-retry').disabled=true;
    if(g('btn-skip'))g('btn-skip').disabled=!running;
    if(g('btn-stop'))g('btn-stop').disabled=!running;
  }
  function updateBookChip(){
    const sc=document.getElementById('stat-book');if(!sc)return;
    const b=S.books[S.currentBookIndex];
    sc.textContent=b?`${S.currentBookIndex+1}/${S.books.length}`:'—';
  }
  function updateActiveBook(idx){
    document.querySelectorAll('.book-item').forEach(el=>el.classList.remove('active'));
    document.getElementById(`book-item-${idx}`)?.classList.add('active');
    S.currentBookIndex=idx; updateBookChip();
  }
  function updateBookCount(idx,count){
    S.bookQuestionCounts[idx]=(S.bookQuestionCounts[idx]||0)+count;
    const el=document.getElementById(`book-qc-${idx}`);
    if(el)el.textContent=S.bookQuestionCounts[idx]+'q';
  }
  function addFeed(batchNum,status,label){
    const feed=document.getElementById('batch-feed');if(!feed)return;
    feed.querySelectorAll('.feed-item.cur').forEach(e=>e.classList.remove('cur'));
    const cls=status==='ok'?'ok':status==='fail'?'fail':status==='patch'?'patch':'cur';
    const badge=status==='ok'?'SAVED':status==='fail'?'FAILED':status==='patch'?'PATCHED':'GEN...';
    const e=document.createElement('div');
    e.className=`feed-item ${cls}`;e.id=`feed-${batchNum}`;
    e.innerHTML=`<span class="feed-n">B${batchNum}</span><span class="feed-t">${esc(label||'Batch '+batchNum)}</span><span class="feed-s">${badge}</span>`;
    feed.appendChild(e);feed.scrollTop=feed.scrollHeight;
  }
  function updateFeed(batchNum,status){
    document.getElementById(`feed-${batchNum}`)?.remove();
    const b=S.batchPlan.find(x=>x.batchNum===batchNum);
    addFeed(batchNum,status,b?`${b.domain}${b.subdomain?'›'+b.subdomain:''} [${b.qtype}] ${b.bookName.substring(0,18)}`:'');
  }
  function getTog(id){const el=document.getElementById(id);return el?el.classList.contains('on'):false;}

  /* ════════════════════════════════════════════════════════════
     TIMER
  ════════════════════════════════════════════════════════════ */
  let _tmr=null;
  function startTimer(){S.startTime=Date.now();clearInterval(_tmr);_tmr=setInterval(()=>{const el=document.getElementById('pqa-elapsed');if(!el||!S.startTime)return;const s=Math.floor((Date.now()-S.startTime)/1000);el.textContent=`${String(Math.floor(s/3600)).padStart(2,'0')}:${String(Math.floor((s%3600)/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`;},1000);}
  function stopTimer(){clearInterval(_tmr);_tmr=null;}

  /* ════════════════════════════════════════════════════════════
     DOMAIN GRID UI
  ════════════════════════════════════════════════════════════ */
  function buildDomainGrid(domains){
    const grid=document.getElementById('dom-grid');
    const hint=document.getElementById('domain-hint');
    const badge=document.getElementById('domain-badge');
    const totalBar=document.getElementById('dom-total-bar');
    if(!grid)return;
    if(hint)hint.style.display='none';
    if(badge){badge.textContent=`${domains.length} Domains`;badge.className='badge b-auto';}
    if(totalBar)totalBar.style.display='flex';
    grid.innerHTML='';

    domains.forEach((dom,di)=>{
      const hasSub=dom.subdomains&&dom.subdomains.length>0;
      const row=document.createElement('div');row.className='dom-row';row.id=`dom-row-${di}`;

      let subHtml='';
      if(hasSub){
        subHtml=`<div class="sub-list">${dom.subdomains.map((sub,si)=>`
          <div class="sub-row">
            <span class="sub-name">↳ ${esc(sub.name)}</span>
            <input class="sub-pct-inp" type="number" min="0" max="100" step="0.1"
              value="${(sub.weight||0).toFixed(1)}" data-di="${di}" data-si="${si}" id="sub-${di}-${si}"/>
            <span class="sub-q" id="subq-${di}-${si}">—</span>
          </div>`).join('')}</div>`;
      }

      row.innerHTML=`
        <div class="dom-hdr" data-di="${di}">
          <span class="dom-name">${esc(dom.name)}</span>
          <input class="dom-pct-inp" type="number" min="0" max="100" step="0.1"
            value="${(dom.weight||0).toFixed(1)}" data-di="${di}" id="dom-${di}"
            onclick="event.stopPropagation()"/>
          <span class="dom-q" id="domq-${di}">—</span>
          ${hasSub?'<span class="dom-arr">&#9660;</span>':''}
        </div>${subHtml}`;
      grid.appendChild(row);

      if(hasSub){
        row.querySelector('.dom-hdr').addEventListener('click',e=>{
          if(e.target.tagName==='INPUT')return;
          row.classList.toggle('open');
        });
      }
    });

    grid.querySelectorAll('.dom-pct-inp').forEach(inp=>{
      inp.addEventListener('input',()=>{
        const di=parseInt(inp.dataset.di);
        if(S.domains[di])S.domains[di].weight=parseFloat(inp.value)||0;
        updateDomainTotal();saveDomains();
      });
    });
    grid.querySelectorAll('.sub-pct-inp').forEach(inp=>{
      inp.addEventListener('input',()=>{
        const di=parseInt(inp.dataset.di),si=parseInt(inp.dataset.si);
        if(S.domains[di]?.subdomains?.[si])S.domains[di].subdomains[si].weight=parseFloat(inp.value)||0;
        updateDomainTotal();saveDomains();
      });
    });
    updateDomainTotal();
  }

  function updateDomainTotal(){
    const totalQ=parseInt(document.getElementById('f-totalq')?.value)||0;
    const total=S.domains.reduce((s,d)=>s+(d.weight||0),0);

    S.domains.forEach((d,di)=>{
      const qEl=document.getElementById(`domq-${di}`);
      if(qEl)qEl.textContent=(totalQ>0&&total>0)?Math.round(d.weight/total*totalQ)+'q':'—';
      if(d.subdomains){
        const subTotal=d.subdomains.reduce((s,sub)=>s+(sub.weight||0),0);
        d.subdomains.forEach((sub,si)=>{
          const sqEl=document.getElementById(`subq-${di}-${si}`);
          if(sqEl&&subTotal>0&&d.weight>0){
            const domQ=totalQ>0&&total>0?Math.round(d.weight/total*totalQ):0;
            sqEl.textContent=Math.round(sub.weight/subTotal*domQ)+'q';
          }else if(sqEl)sqEl.textContent='—';
        });
      }
    });

    const bar=document.getElementById('dom-total-bar');
    const val=document.getElementById('dom-total-val');
    const sts=document.getElementById('dom-total-status');
    if(!bar)return;
    bar.style.display='flex';
    if(val)val.textContent=total.toFixed(1);
    bar.className='dom-total';
    if(Math.abs(total-100)<0.5){bar.classList.add('ok');if(sts)sts.textContent='✓ Balanced';}
    else if(total>100){bar.classList.add('err');if(sts)sts.textContent=`Over ${(total-100).toFixed(1)}%`;}
    else{bar.classList.add('warn');if(sts)sts.textContent=`${(100-total).toFixed(1)}% remaining`;}
  }

  function saveDomains(){store.set('domains',JSON.stringify(S.domains));}

  /* ════════════════════════════════════════════════════════════
     QTYPE GRID UI
  ════════════════════════════════════════════════════════════ */
  const QTYPE_LABELS={
    Application:'Application',Definition:'Definition',Scenario:'Scenario',
    Recall:'Recall',FillBlank:'Fill Blank',Math:'Math/Calc'
  };

  function buildQTypeGrid(qtypes){
    const grid=document.getElementById('qt-grid');
    const hint=document.getElementById('qtype-hint');
    const badge=document.getElementById('qtype-badge');
    const totalBar=document.getElementById('qt-total-bar');
    if(!grid)return;
    if(hint)hint.style.display='none';
    const keys=Object.keys(qtypes).filter(k=>qtypes[k]>0);
    if(badge){badge.textContent=`${keys.length} Types`;badge.className='badge b-auto';}
    if(totalBar)totalBar.style.display='flex';
    grid.innerHTML='';

    const allTypes=['Application','Definition','Scenario','Recall','FillBlank','Math'];
    allTypes.forEach(k=>{if(!(k in qtypes))qtypes[k]=0;});

    Object.entries(QTYPE_LABELS).forEach(([key,label])=>{
      const chip=document.createElement('div');chip.className='qt-chip';chip.id=`qt-chip-${key}`;
      chip.innerHTML=`
        <span class="qt-label">${label}</span>
        <input class="qt-pct-inp" type="number" min="0" max="100" step="0.1"
          value="${(qtypes[key]||0).toFixed(1)}" data-key="${key}" id="qt-${key}"/>
        <span class="qt-q" id="qtq-${key}">—</span>`;
      grid.appendChild(chip);
      chip.querySelector(`#qt-${key}`).addEventListener('input',e=>{
        S.qtypes[key]=parseFloat(e.target.value)||0;
        updateQTypeTotal();store.set('qtypes',JSON.stringify(S.qtypes));
      });
    });
    S.qtypes={...qtypes};
    updateQTypeTotal();
  }

  function updateQTypeTotal(){
    const totalQ=parseInt(document.getElementById('f-totalq')?.value)||0;
    const total=Object.values(S.qtypes).reduce((s,v)=>s+v,0);

    Object.keys(S.qtypes).forEach(key=>{
      const qEl=document.getElementById(`qtq-${key}`);
      if(qEl)qEl.textContent=(totalQ>0&&total>0)?Math.round(S.qtypes[key]/total*totalQ)+'q':'—';
    });

    const bar=document.getElementById('qt-total-bar');
    const val=document.getElementById('qt-total-val');
    const sts=document.getElementById('qt-total-status');
    if(!bar)return;
    if(val)val.textContent=total.toFixed(1);
    bar.className='dom-total';
    if(Math.abs(total-100)<0.5){bar.classList.add('ok');if(sts)sts.textContent='✓ Balanced';}
    else if(total>100){bar.classList.add('err');if(sts)sts.textContent=`Over ${(total-100).toFixed(1)}%`;}
    else{bar.classList.add('warn');if(sts)sts.textContent=`${(100-total).toFixed(1)}% remaining`;}
  }

  /* ════════════════════════════════════════════════════════════
     BOOK LIST UI
  ════════════════════════════════════════════════════════════ */
  function buildBookList(books){
    const list=document.getElementById('book-list');
    const hint=document.getElementById('books-hint');
    const badge=document.getElementById('books-badge');
    if(!list)return;
    if(hint)hint.style.display='none';
    if(badge){badge.textContent=`${books.length} Book${books.length!==1?'s':''}`;badge.className='badge b-auto';}
    list.innerHTML='';
    books.forEach((book,i)=>{
      const item=document.createElement('div');item.className='book-item';item.id=`book-item-${i}`;
      const qc=S.bookQuestionCounts[i]||0;
      item.innerHTML=`<span class="book-ico">📗</span><span class="book-name">${esc(book.name)}</span><span class="book-qc" id="book-qc-${i}">${qc}q</span>`;
      list.appendChild(item);
    });
  }

  /* ════════════════════════════════════════════════════════════
     PARSERS
  ════════════════════════════════════════════════════════════ */
  function parseDomains(resp){
    const domains=[];
    const lines=resp.split('\n');
    let cur=null;
    let inSection=false;

    for(const raw of lines){
      const line=raw.trim();
      if(!line)continue;
      if(/^[-=]{2,}.*domain/i.test(line)||/^#+\s*domain/i.test(line)||line.toLowerCase().includes('--- domain')){
        inSection=true;continue;
      }
      if(inSection&&/^[-=]{2,}/.test(line)&&!/domain/i.test(line)){inSection=false;continue;}

      const pctM=line.match(/[≈~]?\(?(\d+(?:\.\d+)?)\s*%\)?/);
      if(!pctM)continue;
      const weight=parseFloat(pctM[1]);
      if(weight<=0||weight>100)continue;

      let name=line
        .substring(0,line.indexOf(pctM[0]))
        .replace(/^[\d]+[\.\)]\s*/,'')
        .replace(/^\*+|\*+$/g,'')
        .replace(/\s*[–—:\-]+\s*$/,'')
        .replace(/^[\-\*\•→↳▸◦▹]\s*/,'')
        .trim();

      if(!name||name.length<2)continue;
      if(/^(total|note|all domain|domain name|summary)/i.test(name))continue;

      const indented=/^[\s\t]{2,}/.test(raw)||/^[\-\*\•→↳▸]\s/.test(raw.trimStart());
      if(indented&&cur){
        cur.subdomains.push({name,weight});
      }else{
        cur={name,weight,subdomains:[]};
        domains.push(cur);
      }
    }

    if(domains.length>0){
      const total=domains.reduce((s,d)=>s+d.weight,0);
      if(total>0&&Math.abs(total-100)>2){
        domains.forEach(d=>{d.weight=parseFloat((d.weight/total*100).toFixed(1));});
      }
      domains.forEach(d=>{
        if(d.subdomains.length>0){
          const st=d.subdomains.reduce((s,sub)=>s+sub.weight,0);
          if(st>0&&Math.abs(st-100)>2){
            d.subdomains.forEach(sub=>{sub.weight=parseFloat((sub.weight/st*100).toFixed(1));});
          }
        }
      });
    }
    return domains;
  }

  function parseQTypes(resp){
    const qtypes={};
    const ordered=[
      {kws:['fill in','fill-in','blank','complete the'],     key:'FillBlank'},
      {kws:['math','calculation','numeric','formula'],       key:'Math'},
      {kws:['scenario','case study','situational','case-b'], key:'Scenario'},
      {kws:['application','applying','applied'],             key:'Application'},
      {kws:['definition','defining','terminology','term'],   key:'Definition'},
      {kws:['recall','factual','knowledge','which of'],      key:'Recall'},
    ];
    let inSection=false;
    for(const line of resp.split('\n')){
      const t=line.trim();if(!t)continue;
      if(/question type|type dist|qtype/i.test(t)&&(t.includes('---')||t.endsWith(':'))){inSection=true;continue;}
      if(inSection&&/^[-=]{3,}/.test(t)&&!/question type/i.test(t)){inSection=false;continue;}
      const pm=t.match(/(\d+(?:\.\d+)?)\s*%/);if(!pm)continue;
      const w=parseFloat(pm[1]);if(w<=0||w>100)continue;
      const lower=t.toLowerCase();
      for(const{kws,key}of ordered){
        if(!qtypes[key]&&kws.some(kw=>lower.includes(kw))){qtypes[key]=w;break;}
      }
    }
    if(Object.keys(qtypes).length===0){
      log('No qtypes detected — using default distribution','warn');
      return{Application:30,Definition:25,Scenario:25,Recall:20};
    }
    const total=Object.values(qtypes).reduce((s,v)=>s+v,0);
    if(total>0&&Math.abs(total-100)>2){
      for(const k in qtypes)qtypes[k]=Math.round(qtypes[k]/total*100);
    }
    return qtypes;
  }

  function parseBooks(resp){
    const books=[];
    for(const line of resp.split('\n')){
      const t=line.trim();if(!t)continue;
      let name=null;
      const m1=t.match(/^(?:\d+[\.\)]\s*|[\-\*\•▸]\s*)(.{4,120})/);
      if(m1)name=m1[1];
      if(!name){const m2=t.match(/[""](.{4,100})[""]/);if(m2)name=m2[1];}
      if(!name&&/\.pdf/i.test(t)){const m3=t.match(/([^\n\r]{4,120}\.pdf)/i);if(m3)name=m3[1];}
      if(!name)continue;
      name=name.replace(/^["']|["']$/g,'').replace(/\s*[✓✔]\s*$/,'').replace(/\s*\(confirmed\)/i,'').trim();
      if(name.length<4)continue;
      if(/^(total|note:|all books|book name|the following|books? uploaded|ready|confirmed|rules_|books_)/i.test(name))continue;
      if(!books.find(b=>b.name.toLowerCase()===name.toLowerCase())){
        books.push({name,index:books.length});
      }
    }
    return books;
  }

  function parseOptionParams(resp){
    const lower=resp.toLowerCase();
    let optCount=4;
    const cm=resp.match(/Count:\s*(\d)/i);
    if(cm)optCount=parseInt(cm[1])||4;
    else if(lower.includes('6 option')||lower.includes('option f'))optCount=6;
    else if(lower.includes('5 option')||lower.includes('option e'))optCount=5;

    let optLen='short';
    const lm=resp.match(/Length:\s*(\w+)/i);
    if(lm)optLen=lm[1].toLowerCase();

    let stmtLen='standard';
    if(lower.includes('scenario')||lower.includes('case study'))stmtLen='scenario-heavy';
    else if(lower.includes('long')||lower.includes('detailed'))stmtLen='detailed';
    const sm=resp.match(/Statement.*?:\s*(\w+)/i);
    if(sm)stmtLen=sm[1].toLowerCase();

    return{optCount,optLen,stmtLen};
  }

  /* ════════════════════════════════════════════════════════════
     FIX #2 — BATCH COUNT ENFORCER
     Count actual Q[N]. lines in response. Compare to required.
     If short, request missing questions via patch prompt.
  ════════════════════════════════════════════════════════════ */
  function countQuestionsInResponse(text) {
    // Match Q1. Q2. Q3. etc. — with optional space, then content
    const matches = text.match(/^Q\d+\.\s+.{5,}/gm);
    return matches ? matches.length : 0;
  }

  function extractQuestionsFromResponse(text) {
    // Split into individual question blocks
    const blocks = [];
    const lines = text.split('\n');
    let current = [];
    let inQ = false;

    for (const line of lines) {
      if (/^Q\d+\.\s+/.test(line.trim())) {
        if (inQ && current.length > 0) blocks.push(current.join('\n'));
        current = [line];
        inQ = true;
      } else if (inQ) {
        current.push(line);
      }
    }
    if (inQ && current.length > 0) blocks.push(current.join('\n'));
    return blocks;
  }

  /* ════════════════════════════════════════════════════════════
     BATCH PLAN
  ════════════════════════════════════════════════════════════ */
  function buildBatchPlan(cfg,domains,books,qtypes){
    if(!domains||domains.length===0||!books||books.length===0)return[];
    const totalQ=cfg.totalQ;
    const batchSize=cfg.batchSize;
    const domTotal=domains.reduce((s,d)=>s+(d.weight||0),0);
    if(domTotal===0)return[];

    const activeQt=Object.entries(qtypes).filter(([,w])=>w>0);
    const qtTotal=activeQt.reduce((s,[,w])=>s+w,0);
    if(qtTotal===0)return[];

    const segments=[];
    domains.forEach(dom=>{
      const domQ=Math.round((dom.weight||0)/domTotal*totalQ);
      if(domQ===0)return;
      const subs=dom.subdomains&&dom.subdomains.length>0?dom.subdomains:[{name:'',weight:100}];
      const subTotal=subs.reduce((s,sub)=>s+(sub.weight||0),0)||100;
      subs.forEach(sub=>{
        const subQ=Math.round((sub.weight||100)/subTotal*domQ);
        if(subQ===0)return;
        activeQt.forEach(([qtype,qw])=>{
          const qtQ=Math.round(qw/qtTotal*subQ);
          if(qtQ===0)return;
          segments.push({domain:dom.name,subdomain:sub.name||'',qtype,count:qtQ});
        });
      });
    });

    const segTotal=segments.reduce((s,seg)=>s+seg.count,0);
    const bookBudget=books.map(()=>Math.floor(segTotal/books.length));
    const rem=segTotal-bookBudget.reduce((s,v)=>s+v,0);
    for(let i=0;i<rem;i++)bookBudget[i]++;
    const bookRem=[...bookBudget];

    let bkPtr=0;
    function nextBook(){
      for(let a=0;a<books.length;a++){
        const idx=(bkPtr+a)%books.length;
        if(bookRem[idx]>0){bkPtr=(idx+1)%books.length;return idx;}
      }
      const idx=bkPtr%books.length;bkPtr=(bkPtr+1)%books.length;return idx;
    }

    const batches=[];let batchNum=1;
    segments.forEach(seg=>{
      let rem2=seg.count;
      while(rem2>0){
        const bq=Math.min(batchSize,rem2);rem2-=bq;
        const bIdx=nextBook();
        bookRem[bIdx]=Math.max(0,bookRem[bIdx]-bq);
        batches.push({
          batchNum:batchNum++,
          domain:seg.domain,
          subdomain:seg.subdomain,
          qtype:seg.qtype,
          questionsInBatch:bq,
          bookIndex:bIdx,
          bookName:books[bIdx].name,
        });
      }
    });

    const bd={};batches.forEach(b=>{bd[b.bookName]=(bd[b.bookName]||0)+b.questionsInBatch;});
    log(`Book distribution: ${Object.entries(bd).map(([n,c])=>`"${n.substring(0,18)}":${c}q`).join(' | ')}`,'ok');
    const qd={};batches.forEach(b=>{qd[b.qtype]=(qd[b.qtype]||0)+b.questionsInBatch;});
    log(`QType distribution: ${Object.entries(qd).map(([t,c])=>`${t}:${c}q`).join(' | ')}`,'ok');
    return batches;
  }

  /* ════════════════════════════════════════════════════════════
     ANSWER ROTATOR
  ════════════════════════════════════════════════════════════ */
  function genAnswerPositions(count,optCount){
    const labels=['A','B','C','D','E','F'].slice(0,optCount);
    const perL=Math.ceil(count/labels.length);
    let pool=[];
    for(let i=0;i<perL;i++)pool=[...pool,...labels];
    pool=pool.slice(0,count);
    for(let i=pool.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[pool[i],pool[j]]=[pool[j],pool[i]];}
    for(let i=1;i<pool.length;i++){
      if(pool[i]===pool[i-1]){
        for(let j=i+1;j<pool.length;j++){
          if(pool[j]!==pool[i-1]){[pool[i],pool[j]]=[pool[j],pool[i]];break;}
        }
      }
    }
    return pool;
  }

  /* ════════════════════════════════════════════════════════════
     FIX #1 — SMART DEDUP
     Full registry = local check (no prompt bloat)
     Rolling window = last N stems sent to GPT prompt
  ════════════════════════════════════════════════════════════ */
  function normText(t){
    return t.toLowerCase().replace(/[^a-z0-9 ]/g,' ').replace(/\s+/g,' ').trim().substring(0,120);
  }

  function registerBatch(resp){
    const lines=resp.split('\n');
    let stem='',opts=[];
    let newStems=0,newOpts=0;

    lines.forEach(raw=>{
      const line=raw.trim();
      if(/^Q\d+\.\s+.{15,}/.test(line)){
        const s=normText(line.replace(/^Q\d+\.\s*/,''));
        if(!S.stemRegistry.has(s)){
          S.stemRegistry.add(s);
          S.stemHistory.push(s); // ordered for window
          newStems++;
        }
        stem=s;opts=[];
      }
      else if(/^\([A-F]\)\s+.{2,}/.test(line)){
        const o=normText(line.replace(/^\([A-F]\)\s*/,''));
        if(!S.optionRegistry.has(o)){S.optionRegistry.add(o);newOpts++;}
        opts.push(o);
        const combo=normText(stem+' '+opts.join(' '));
        S.optionRegistry.add(combo);
      }
      else if(/^Explanation:/i.test(line)){
        const ex=normText(line.replace(/^Explanation:\s*/i,''));
        S.explanationRegistry.add(ex);
      }
    });
    log(`Registered: +${newStems} stems, +${newOpts} options. Total: ${S.stemRegistry.size} unique stems`,'debug');
  }

  function buildDedupBlock(){
    if(S.stemHistory.length===0)return'';
    // Only send last DEDUP_WINDOW stems — keeps prompt lean
    const window=S.stemHistory.slice(-DEDUP_WINDOW);
    return`\nDO NOT REPEAT THESE RECENT QUESTION PATTERNS:\n${window.map((s,i)=>`${i+1}. ${s.substring(0,70)}…`).join('\n')}\n`;
  }

  /* ════════════════════════════════════════════════════════════
     CONFIG
  ════════════════════════════════════════════════════════════ */
  function getCfg(){
    const g=id=>document.getElementById(id);
    return{
      exam:       (g('f-exam')?.value||'').trim(),
      totalQ:     parseInt(g('f-totalq')?.value)||0,
      batchSize:  parseInt(g('f-batch')?.value)||15,
      minL:       parseInt(g('f-minl')?.value)||5,
      maxL:       parseInt(g('f-maxl')?.value)||7,
      startBatch: parseInt(g('f-startbatch')?.value)||1,
      maxRetries: parseInt(g('f-maxretry')?.value)||5,
      remindEvery:parseInt(g('f-remind')?.value)||5,
      pollMs:     parseInt(g('f-poll')?.value)||800,
      timeoutMs:  parseInt(g('f-timeout')?.value)||300000,
      batchDelay: parseInt(g('f-batchdelay')?.value)||2500,
      minResp:    parseInt(g('f-minresp')?.value)||300,
      maxOptWords:parseInt(g('f-maxoptw')?.value)||4,
      url:        (g('f-url')?.value||'').trim(),
      docId:      (g('f-docid')?.value||'').trim(),
      secret:     (g('f-key')?.value||'').trim(),
      postPlan:   getTog('tog-postplan'),
      validate:   getTog('tog-validate'),
      rotation:   getTog('tog-rotation'),
      mathSafe:   getTog('tog-mathsafe'),
    };
  }

  function validateCfg(){
    const c=getCfg(),e=[];
    if(!c.exam)e.push('Exam Name required');
    if(c.totalQ<1)e.push('Total Questions >= 1');
    if(!c.url)e.push('Apps Script URL required');
    if(!c.docId)e.push('Doc ID required');
    if(!c.secret)e.push('Secret Key required');
    if(c.minL>=c.maxL)e.push('Min lines must be < Max lines');
    return e;
  }

  /* ════════════════════════════════════════════════════════════
     PROMPT SYSTEM
  ════════════════════════════════════════════════════════════ */
  const P={
    rules(cfg,optCount,optLabels){
      const maxW=cfg.maxOptWords;
      const L=`${cfg.minL}–${cfg.maxL}`;
      return `━━━ EXAM: "${cfg.exam}" | ${cfg.totalQ} TOTAL QUESTIONS ━━━

FORMAT — Every single question must follow this EXACT format, no exceptions:
Q[N]. [Question statement — complete sentence]
${optLabels.map(l=>`${l} [max ${maxW} words — noun phrase ONLY, never a sentence]`).join('\n')}
Answer: [Single letter — ${optLabels.map(l=>l.replace(/[()]/g,'')).join('/')}]
Explanation: [Exactly ${L} lines — see structure below]

━━━ OPTION RULES (ABSOLUTE — violations cause full batch rejection) ━━━
• Each option: MAX ${maxW} words. Noun phrases. Never sentences. Never clauses.
• All ${optCount} options must be present — no more, no less.
• All ${optCount} options must be plausible — no obviously wrong distractors.
• Balanced length: all options roughly same word count (1–${maxW} words each).
• CORRECT: "(A) Hash function output" | "(B) Public key certificate"
• WRONG: "(A) The process of hashing data before encryption" ← REJECTED — too long

━━━ BATCH COUNT RULE (CRITICAL — enforced strictly in v3.2) ━━━
• When prompt says "Generate EXACTLY N questions", you MUST produce EXACTLY N questions.
• Never produce fewer. Never produce more.
• If you run out of ideas, generate variation on similar concept — but hit the exact count.
• Missing even 1 question = batch rejection and re-request.

━━━ ANSWER POSITION RULE ━━━
• Each batch prompt specifies the exact answer position per question.
• Build the question so that the SPECIFIED position IS the correct answer.
• Follow mandatory positions exactly — do not reorder or rearrange.

━━━ EXPLANATION STRUCTURE (${L} lines EXACTLY) ━━━
⛔ ABSOLUTE RULE — OPTION LABELS BANNED FROM EXPLANATION:
   Never write: "Option A", "Choice B", "(A)", "(B)", "the correct option", "the wrong option", any letter label.
   Write ONLY concept names and technical reasoning. Treat explanation as a standalone teaching paragraph.

Line-by-line structure:
• Line 1: Name and define the EXACT concept, mechanism, or principle being tested in this question.
• Line 2: State WHY the correct answer is correct — use the concept name, not the option label.
• Lines 3–${cfg.maxL-1}: For each incorrect concept: name it directly, explain what it actually does, and state precisely why it does NOT apply here. Describe the concept — never the option letter.
• Final line: The precise rule, definition, or fact the student must memorize to answer this question type correctly.

CORRECT explanation (zero labels — full marks):
"This question tests the concept of asymmetric encryption. RSA uses a public-private key pair where data encrypted with the public key can only be decrypted with the private key. Symmetric encryption uses the same key for both operations, making it unsuitable when two parties have not pre-shared a key. Hashing is a one-way function that produces a fixed digest and cannot be reversed to recover original data. Digital signatures verify authenticity but do not encrypt the data content itself. The key rule: asymmetric encryption enables secure key exchange without requiring a pre-shared secret."

REJECTED explanation (option labels found — batch rejected):
"Option A is correct because RSA uses asymmetric keys. Option B is wrong because symmetric uses same key. Option C is incorrect as hashing is one-way. Option D does not apply."

• NEVER write: "Option A", "Choice B", "the correct option", "(A)", "(B)", any parenthesized letter referring to options
• NEVER mention company, brand, organization, book, or author names in explanation.

━━━ MATH FORMAT RULE ━━━
• Write all math in plain ASCII only. No Unicode symbols, no LaTeX, no markdown math.
• Use: x^2 for squares, sqrt(x) for roots, (a)/(b) for fractions, x*y for multiply.
• Numbers only in options for math questions (e.g. "(A) 42" not "(A) forty-two").

━━━ CONTENT RULES ━━━
R1. SOURCE: Extract CONCEPTS from uploaded reference books. Generate ORIGINAL questions.
R2. TOPIC NEUTRALITY: Never mention: company, brand, product, organization, board, author, book, student, teacher, audience type.
R3. ZERO DUPLICATION: Every stem unique. Every option unique. Every explanation unique.
R4. NO META TEXT: No text before Q[N]. No text after Explanation. Pure questions only.
R5. SOURCE LINE: Do NOT write "Source:" in any question or explanation. System adds it.
R6. DOMAIN RESTRICTION: Questions within specified domain/topic scope only.
R7. REFUSAL FORBIDDEN: If files are uploaded, generate from them. Never say you cannot access files.`;
    },

    init(cfg,optCount,optLabels){
      return`You are a practice exam question generator.

${this.rules(cfg,optCount,optLabels)}

MEMORIZE every rule above. You will be evaluated on EVERY rule for EVERY question.
Critical: BATCH COUNT RULE is new in v3.2 — you must produce EXACTLY the number requested.
Do NOT generate anything yet. Files are being uploaded.

Reply ONLY with: RULES_MEMORIZED`;
    },

    detect(){
      return`Files are uploaded and ready. Analyze them now.

Return ONLY the structured output below — no explanation, no extra text, nothing else:

--- DOMAINS ---
[List every exam domain/topic from the outline, with percentage weight]
[Format: "Domain Name – XX%" — one per line]
[If domain has subtopics, indent with "   - Subdomain – YY%"]
[All domain percentages must sum to 100%]

--- QUESTION TYPES ---
[Count ALL sample questions. Report distribution by type — total = 100%]
Application – XX%
Definition – XX%
Scenario – XX%
Recall – XX%
FillBlank – XX%
Math – XX%

--- OPTIONS ---
Count: [4 or 5 or 6]
Length: [short or medium or long]
Statement: [brief or standard or detailed or scenario-heavy]

Return ONLY the three sections above. Start with "--- DOMAINS ---" immediately.`;
    },

    booksAck(cfg,optCount,optLabels){
      return`Reference books are uploaded. List every uploaded book filename exactly as shown in your file list.

${this.rules(cfg,optCount,optLabels)}

Critical confirmation:
1. Options: MAX ${cfg.maxOptWords} words each — noun phrases only
2. Explanations: EXACTLY ${cfg.minL}–${cfg.maxL} lines — structured as memorized
3. Batch count: EXACTLY the number of questions requested — no more, no less
4. Answer positions: Follow mandatory per-question assignments
5. Math: ASCII only — no Unicode, no LaTeX, no markdown math symbols
6. Zero duplicates across all dimensions
7. No brand/company/source mentions anywhere
8. No "Source:" line — system adds it

List uploaded books then reply: BOOKS_CONFIRMED`;
    },

    /* FIX #3 — RULE REINFORCE: sent before next batch after any error */
    reinforce(cfg,optCount,optLabels){
      const maxW=cfg.maxOptWords;
      const L=`${cfg.minL}–${cfg.maxL}`;
      return`RULE REINFORCE — previous response had issues. Memorize these before next batch:

FORMAT (exact — no deviation):
Q[N]. [Question]
${optLabels.map(l=>`${l} [max ${maxW} words — noun phrase]`).join('\n')}
Answer: [letter]
Explanation: [${L} lines]

CRITICAL RULES:
1. Generate EXACTLY the number of questions requested — not 1 less, not 1 more
2. Options: MAX ${maxW} words each — noun phrases — all ${optCount} options plausible — balanced length
3. Explanation: EXACTLY ${L} lines — ZERO option labels — name concepts directly, never write (A)/(B)/(C)/(D) or 'Option X' — no brand/source names
4. Math: ASCII only (x^2, sqrt(x), a/b) — no Unicode math symbols, no LaTeX
5. No meta text before first Q or after last Explanation
6. No Source: line — no book/author names anywhere in questions
7. No refusals — generate from uploaded files regardless

Reply: REINFORCE_OK`;
    },

    batch(batchNum,cfg,optCount,optLabels,domain,subdomain,qtype,count,startQ,bookName,dedupBlock,answerPositions){
      const maxW=cfg.maxOptWords;
      const L=`${cfg.minL}–${cfg.maxL}`;
      const loc=subdomain&&subdomain!==domain?`${domain} › ${subdomain}`:domain;

      const typeGuide={
        Application:`Describe a real task or problem. Examinee must APPLY a concept to solve it. Do not just ask what something is — ask how or when to use it.`,
        Definition:`Ask for the exact meaning, definition, or description of a specific term, concept, or principle.`,
        Scenario:`MUST start with a 2–3 sentence scenario/situation. Then ask: what is the best action, approach, or decision?`,
        Recall:`Direct factual recall. Patterns: "Which of the following…", "What is the purpose of…", "Which statement correctly describes…"`,
        FillBlank:`A statement with ONE key term replaced by ______. Options complete the blank — keep all options ≤${maxW} words.`,
        Math:`Numeric computation required. Include specific numbers in stem. Options must be specific numeric values (ASCII: x^2, sqrt, a/b). No Unicode math.`,
      }[qtype]||'Standard multiple-choice questions based on reference material.';

      let posBlock='';
      if(answerPositions&&answerPositions.length>0){
        posBlock='\nMANDATORY ANSWER POSITIONS — build each question so the specified option IS correct:\n';
        for(let i=0;i<count;i++){
          posBlock+=`  Q${startQ+i}: correct answer = (${answerPositions[i]||'A'})\n`;
        }
      }

      return`BATCH ${batchNum} | DOMAIN: ${loc} | TYPE: ${qtype} | BOOK: "${bookName}"

Generate EXACTLY ${count} questions. Number Q${startQ} to Q${startQ+count-1}.
⚠ EXACTLY ${count} — this is enforced. Missing questions = batch rejection.

TYPE INSTRUCTION: ${typeGuide}

BOOK: Use "${bookName}" as the primary source. Extract concepts from this book only.
DOMAIN: All questions within "${loc}" scope only.
MATH: Write all math in plain ASCII — x^2, sqrt(x), (a)/(b), x*y — NO Unicode symbols.

FORMAT (memorized rules apply):
Q[N]. [Question]
${optLabels.map(l=>`${l} [max ${maxW} words — noun phrase]`).join('\n')}
Answer: [letter]
Explanation: [${L} lines — concept | why correct | why each wrong | key takeaway]
${posBlock}
RULES CHECKLIST (verify per question before output):
✓ Exactly ${count} questions — Q${startQ} through Q${startQ+count-1}
✓ Options: MAX ${maxW} words each — noun phrases — all ${optCount} options plausible
✓ Explanation: EXACTLY ${L} lines — ZERO option labels (A/B/C/D) banned — write concept names not option letters — no brand/source names
✓ Math: ASCII only (x^2, sqrt, a/b) — zero Unicode math characters
✓ Zero duplicates — every stem and option 100% unique
✓ No source/brand/company anywhere in question or explanation
✓ No meta text — pure Q format only — nothing before Q${startQ} or after last explanation
${dedupBlock}
Begin generation now:`;
    },

    reminder(cfg,optCount,maxW){
      const L=`${cfg.minL}–${cfg.maxL}`;
      return`QUALITY REMINDER — apply to next batch (memorized rules still in effect):
• EXACTLY the requested number of questions — no more, no less
• Options: MAX ${maxW} words each — noun phrases — all ${optCount} plausible
• Explanation: EXACTLY ${L} lines — ZERO option labels — never write (A)/(B)/(C)/(D) in explanation — name concepts directly — no brand names
• Math: ASCII only (x^2, sqrt, a/b) — no Unicode math symbols
• Answer positions: follow mandatory assignment
• Zero duplicates on stems, options, explanations
• No source/brand/company anywhere
• No meta text — pure Q format only
Reply: REMINDER_OK`;
    },

    /* FIX #2 — PATCH: request missing questions to complete a batch */
    patch(batchNum,cfg,optCount,optLabels,domain,qtype,startQ,missingCount,bookName,answerPositions){
      const maxW=cfg.maxOptWords;
      const L=`${cfg.minL}–${cfg.maxL}`;
      let posBlock='';
      if(answerPositions){
        posBlock='\nANSWER POSITIONS for missing questions:\n';
        answerPositions.forEach((p,i)=>posBlock+=`  Q${startQ+i}: (${p})\n`);
      }
      return`BATCH ${batchNum} INCOMPLETE — missing ${missingCount} questions. Generate EXACTLY the missing ones now.

Domain: ${domain} | Type: ${qtype} | Book: "${bookName}"
Generate ONLY Q${startQ} to Q${startQ+missingCount-1} — EXACTLY ${missingCount} questions.
Math: ASCII only (x^2, sqrt, a/b).
${posBlock}
FORMAT:
Q[N]. [Question]
${optLabels.map(l=>`${l} [max ${maxW} words]`).join('\n')}
Answer: [letter]
Explanation: [${L} lines]

Generate the ${missingCount} missing questions now:`;
    },

    retry(batchNum,cfg,optCount,optLabels,domain,qtype,count,startQ,bookName,answerPositions){
      const maxW=cfg.maxOptWords;
      const L=`${cfg.minL}–${cfg.maxL}`;
      let posBlock='';
      if(answerPositions){
        posBlock='\nANSWER POSITIONS (mandatory):\n';
        for(let i=0;i<count;i++)posBlock+=`  Q${startQ+i}: (${answerPositions[i]||'A'})\n`;
      }
      return`BATCH ${batchNum} RETRY — rewrite completely from scratch. EXACTLY ${count} questions.

Domain: ${domain} | Type: ${qtype} | Book: "${bookName}"
Generate Q${startQ}–Q${startQ+count-1}. EXACTLY ${count} questions — this is non-negotiable.
Math: ASCII only (x^2, sqrt, a/b). No Unicode math symbols.
${posBlock}
FORMAT:
Q[N]. [Question]
${optLabels.map(l=>`${l} [max ${maxW} words]`).join('\n')}
Answer: [letter]
Explanation: [${L} lines]

Rules: EXACTLY ${count} qs | max ${maxW} words/option | ${L} expl lines | ZERO option labels in expl (name concepts not letters) | no brands | no meta text
Generate now:`;
    },
  };

  /* ════════════════════════════════════════════════════════════
     GPT ENGINE
  ════════════════════════════════════════════════════════════ */
  const GPT={
    getInput(){
      return document.getElementById('prompt-textarea')
        ||document.querySelector('.ProseMirror[contenteditable="true"]')
        ||document.querySelector('[contenteditable="true"][role="textbox"]')
        ||null;
    },
    getSend(){return document.querySelector('[data-testid="send-button"]')||document.querySelector('button[aria-label*="Send" i]')||null;},
    getStop(){return document.querySelector('[data-testid="stop-button"]')||document.querySelector('button[aria-label*="Stop" i]')||null;},

    async injectText(text){
      let el=this.getInput();
      if(!el){await sleep(1500);el=this.getInput();}
      if(!el){log('Textarea not found','error');return false;}
      log(`Injecting ${text.length} chars`,'debug');
      try{el.focus();await sleep(80);el.innerHTML='';el.dispatchEvent(new Event('input',{bubbles:true}));await sleep(60);}catch(_){}
      // Method 1: execCommand
      try{
        el.focus();document.execCommand('selectAll',false,null);document.execCommand('delete',false,null);await sleep(30);
        document.execCommand('insertText',false,text);await sleep(150);
        if((el.textContent||el.value||'').trim().length>20){log('inject:execCommand ✓','debug');return true;}
      }catch(_){}
      // Method 2: native setter
      try{
        const ns=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value');
        if(ns&&el.tagName==='TEXTAREA'){
          ns.set.call(el,text);
          el.dispatchEvent(new Event('input',{bubbles:true}));
          el.dispatchEvent(new Event('change',{bubbles:true}));
          await sleep(150);
          if((el.value||'').trim().length>20){log('inject:nativeSetter ✓','debug');return true;}
        }
      }catch(_){}
      // Method 3: React fiber
      try{
        const fk=Object.keys(el).find(k=>k.startsWith('__reactFiber')||k.startsWith('__reactInternalInstance'));
        if(fk){
          let node=el[fk];
          while(node){if(node.memoizedProps?.onChange){node.memoizedProps.onChange({target:{value:text}});break;}node=node.return;}
          await sleep(200);
          if((el.textContent||el.value||'').trim().length>20){log('inject:reactFiber ✓','debug');return true;}
        }
      }catch(_){}
      // Method 4: clipboard paste
      try{
        const dt=new DataTransfer();dt.setData('text/plain',text);
        el.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:dt}));
        await sleep(250);
        if((el.textContent||el.value||'').trim().length>20){log('inject:clipboard ✓','debug');return true;}
      }catch(_){}
      // Method 5: textContent fallback
      try{
        el.focus();el.textContent=text;
        el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:text}));
        await sleep(300);log('inject:textContent ✓','debug');return true;
      }catch(e){log('All inject methods failed: '+e.message,'error');return false;}
    },

    async clickSend(){
      for(let i=0;i<30;i++){
        const btn=this.getSend();
        if(btn&&!btn.disabled){btn.click();log('Send ✓','debug');return true;}
        await sleep(100);
      }
      log('Send never enabled','error');return false;
    },

    async send(text){
      const el=this.getInput();
      if(el){try{el.innerHTML='';el.dispatchEvent(new Event('input',{bubbles:true}));}catch(_){}await sleep(80);}
      const ok=await this.injectText(text);
      if(!ok)throw new Error('Injection failed');
      await sleep(300);
      const sent=await this.clickSend();
      if(!sent)throw new Error('Send failed');
    },

    isStreaming(){return!!this.getStop()||!!document.querySelector('[class*="result-streaming"]');},
    countMsgs(){return document.querySelectorAll('[data-message-author-role="assistant"]').length;},
    getLatest(){
      const msgs=document.querySelectorAll('[data-message-author-role="assistant"]');
      if(!msgs.length)return'';
      const last=msgs[msgs.length-1];
      for(const sel of['.markdown.prose','.markdown','.prose','[class*="markdown"]','[class*="prose"]','.whitespace-pre-wrap']){
        const el=last.querySelector(sel);if(el&&el.textContent.trim().length>10)return el.textContent.trim();
      }
      return last.textContent.trim();
    },

    waitForDone(timeoutMs){
      const timeout=timeoutMs||S.timeoutMs||300000;
      return new Promise((resolve,reject)=>{
        const start=Date.now();
        const initCount=this.countMsgs();
        let lastLen=0,stable=0,started=false;
        const t=setInterval(()=>{
          if(S.paused)return;
          if(Date.now()-start>timeout){clearInterval(t);reject(new Error(`Timeout ${Math.round(timeout/1000)}s`));return;}
          const streaming=this.isStreaming();
          const count=this.countMsgs();
          const text=this.getLatest();
          if(!started&&(streaming||count>initCount)){started=true;log('GPT responding…','hi');}
          if(started&&!streaming&&count>initCount){
            const len=text.length;
            if(len===lastLen&&len>0){stable++;if(stable>=4){clearInterval(t);S.lastResponse=text;log(`Done: ${len} chars`,'ok');resolve(text);return;}}
            else{stable=0;lastLen=len;}
          }
          if(!started&&count>initCount&&!streaming){
            const len=text.length;
            if(len>0&&len===lastLen){stable++;if(stable>=3){clearInterval(t);S.lastResponse=text;resolve(text);return;}}
            lastLen=len;
          }
        },(S.pollMs||800));
        S.watcherTimer=t;
      });
    },

    triggerUpload(){
      const plus=document.querySelector('[data-testid="composer-plus-btn"]')
        ||document.querySelector('button[aria-label*="attach" i]')
        ||document.querySelector('button[aria-label*="upload" i]');
      if(plus){
        plus.click();log('+ clicked','ok');
        setTimeout(()=>{
          for(const el of document.querySelectorAll('[role="menuitem"],button,li')){
            const t=el.textContent.toLowerCase();
            if(t.includes('upload')||t.includes('computer')||t.includes('file')||t.includes('attach')){el.click();log('Upload option ✓','ok');return;}
          }
          const fi=document.querySelector('input[type="file"]');
          if(fi)fi.click();else log('No upload item found','warn');
        },500);
        return;
      }
      const fi=document.querySelector('input[type="file"]');
      if(fi)fi.click();
      else{log('No upload mechanism found','warn');toast('Click + in ChatGPT manually','warning');}
    },
  };

  // Keep alive
  function acquireLock(){
    if(typeof navigator.locks==='undefined')return;
    navigator.locks.request('pqa32_lock',{mode:'shared'},()=>new Promise(()=>{})).catch(()=>{});
    log('Background lock acquired ✓','ok');
  }
  acquireLock();
  document.addEventListener('visibilitychange',e=>{e.stopImmediatePropagation();},true);

  /* ════════════════════════════════════════════════════════════
     FIX #4 — MATH-SAFE GOOGLE DOCS POSTER
  ════════════════════════════════════════════════════════════ */
  const DOCS={
    async post(content,section,cfg){
      let text=String(content||'').trim();
      if(!text){log(`Empty content: "${section}" — skip`,'warn');return;}
      // Apply math-safe conversion before posting
      if(cfg.mathSafe){
        text=mathSafeText(text);
      }
      log(`Posting: "${section}" (${text.length} chars)`,'info');
      for(let a=1;a<=5;a++){
        try{await this._send(text,section,cfg);return;}
        catch(e){log(`Save attempt ${a}/5: ${e.message}`,'warn');if(a<5)await sleep(Math.min(3000*2**(a-1),30000));}
      }
      log(`FAILED to save: "${section}"`, 'error');
      toast(`Save failed: "${section}"`, 'error', 8000);
    },

    _send(content,section,cfg){
      const MAX=45000;
      if(content.length>MAX){
        const parts=content.split('\n\n');let chunk='',idx=1;
        const sends=[];
        for(const p of parts){
          if((chunk+p).length>MAX&&chunk){sends.push(this._chunk(chunk,`${section} (Part ${idx})`,cfg));chunk=p+'\n\n';idx++;}
          else chunk+=p+'\n\n';
        }
        if(chunk.trim())sends.push(this._chunk(chunk,`${section} (Part ${idx})`,cfg));
        return Promise.all(sends);
      }
      return this._chunk(content,section,cfg);
    },

    _chunk(content,section,cfg){
      return new Promise((resolve,reject)=>{
        const payload={
          secret:cfg.secret.trim(),docId:cfg.docId.trim(),
          action:'append',section:section.trim(),content:content.trim(),
        };
        GM_xmlhttpRequest({
          method:'POST',url:cfg.url,
          headers:{'Content-Type':'application/json; charset=UTF-8','Accept':'application/json, */*'},
          data:JSON.stringify(payload),timeout:60000,
          onload:r=>{
            if(r.status>=200&&r.status<400){
              try{const resp=JSON.parse(r.responseText||'{}');if(resp.status==='error'){reject(new Error('Docs: '+resp.message));return;}}catch(_){}
              log(`Saved: "${section}"`,'ok');resolve();
            }else reject(new Error(`HTTP ${r.status}: ${r.responseText?.substring(0,100)}`));
          },
          onerror:()=>reject(new Error('Network error')),
          ontimeout:()=>reject(new Error('Request timeout')),
        });
      });
    },

    async testConn(cfg){
      return new Promise((resolve,reject)=>{
        GM_xmlhttpRequest({
          method:'POST',url:cfg.url,
          headers:{'Content-Type':'application/json'},
          data:JSON.stringify({secret:cfg.secret.trim(),docId:cfg.docId.trim(),action:'ping'}),
          timeout:12000,
          onload:r=>{
            if(r.status>=200&&r.status<400){
              try{const resp=JSON.parse(r.responseText||'{}');if(resp.status==='error'){reject(new Error(resp.message));return;}}catch(_){}
              resolve();
            }else reject(new Error(`HTTP ${r.status}`));
          },
          onerror:()=>reject(new Error('Network unreachable')),
          ontimeout:()=>reject(new Error('Timed out')),
        });
      });
    },
  };

  /* ════════════════════════════════════════════════════════════
     UTILITIES
  ════════════════════════════════════════════════════════════ */
  function sleep(ms){return new Promise(r=>setTimeout(r,ms));}

  function checkPause(){
    return new Promise(resolve=>{
      if(!S.paused)return resolve();
      log('⏸ Paused — click Resume to continue','warn');
      setPhase('⏸ Paused');
      const t=setInterval(()=>{
        if(!S.paused||!S.running){clearInterval(t);if(S.running)log('Resumed ✓','ok');resolve();}
      },500);
      S.pauseResolver=()=>{clearInterval(t);resolve();};
    });
  }

  function waitForFlag(fn,label,ms=900000){
    return new Promise((resolve,reject)=>{
      const start=Date.now();
      const t=setInterval(()=>{
        if(!S.running){clearInterval(t);reject(new Error('Stopped by user'));return;}
        if(fn()){clearInterval(t);resolve();return;}
        if(Date.now()-start>ms){clearInterval(t);reject(new Error('Timeout: '+label));}
      },700);
    });
  }

  function validateResp(text,cfg){
    if(!text||text.trim().length<(cfg.minResp||300))
      return{ok:false,reason:`Too short (${text?.length||0} chars)`};
    const refusals=[
      /i (cannot|can't|am unable to|don't have access)/i,
      /no (files?|documents?|books?|pdf) (were|have been|was) (uploaded|attached|provided)/i,
      /please (re-?upload|attach|provide)/i,
      /i don't see any (file|attachment|upload)/i,
    ];
    for(const p of refusals)if(p.test(text))return{ok:false,reason:'Refusal: '+text.slice(0,100)};
    if(!/Q\d+\./i.test(text))return{ok:false,reason:'No Q[N]. format found'};
    if(!/Answer:\s*[A-F]/i.test(text))return{ok:false,reason:'No Answer: letter found'};
    if(!/Explanation:/i.test(text))return{ok:false,reason:'No Explanation: found'};

    // Check for option labels inside explanation blocks — v3.2 fix
    // Extract explanation lines and check for (A)/(B)/(C)/(D) patterns
    const explBlocks=text.match(/Explanation:[\s\S]*?(?=\nQ\d+\.|$)/gi)||[];
    let labelCount=0;
    for(const block of explBlocks){
      // Count how many times option labels appear in explanation text
      const matches=block.match(/\b(Option|Choice)\s*[A-F]\b|\([A-F]\)\s+(is|was|are|were|would|does|do|did|should|can|cannot|cannot|isn|doesn)/gi)||[];
      labelCount+=matches.length;
    }
    if(labelCount>=3){
      // 3+ option-label references in explanations = violation (allow 1-2 in case of edge cases)
      needsRuleReinforce=true;
      return{ok:false,reason:`Option labels found in explanations (${labelCount} times) — retrying`};
    }

    return{ok:true};
  }

  function cleanResponse(text){
    if(!text)return'';
    // Strip source lines
    text=text
      .replace(/^Source:.*$/gim,'')
      .replace(/^Reference:.*$/gim,'')
      .replace(/\n{3,}/g,'\n\n')
      .trim();
    // Safety net: strip option labels from explanation lines
    text=cleanExplanationLabels(text);
    return text;
  }

  // Remove option label references from explanation lines
  // e.g. "Option A is correct because..." becomes "is correct because..."
  function cleanExplanationLabels(text){
    if(!text)return text;
    const lines=text.split('\n');
    let inExpl=false;
    const out=[];
    for(const line of lines){
      const tr=line.trim();
      if(/^Explanation:/i.test(tr)) inExpl=true;
      else if(/^Q\d+\./i.test(tr)) inExpl=false;
      if(inExpl){
        let cl=line.replace(/\bOption\s+[A-F]\b\s*/gi,'')
                    .replace(/\bChoice\s+[A-F]\b\s*/gi,'')
                    .replace(/\([A-F]\)\s+(?=is\b|was\b|are\b|were\b|would\b|does\b|do\b|did\b|should\b|can\b|cannot\b|isn|doesn|refers|means)/gi,'')
                    .replace(/  +/g,' ');
        out.push(cl);
      }else{
        out.push(line);
      }
    }
    return out.join('\n');
  }

  /* ════════════════════════════════════════════════════════════
     MAIN WORKFLOW
  ════════════════════════════════════════════════════════════ */
  let totalPatchCount = 0; // track patches for stats

  async function runWorkflow(){
    const errs=validateCfg();
    if(errs.length){errs.forEach(e=>log(e,'error'));toast('Fix config errors first','error');return;}

    const cfg=getCfg();
    S.running=true; S.paused=false;
    S.retries=0; S.globalErrors=0;
    S.stemRegistry=new Set(); S.stemHistory=[];
    S.optionRegistry=new Set(); S.explanationRegistry=new Set();
    S.answerHistory=[];
    needsRuleReinforce=false;
    totalPatchCount=0;

    setStatus('running','Running'); setBtns(true); startTimer();
    log(`PracticeQ v${VERSION} — "${cfg.exam}" — ${cfg.totalQ} Qs`,'hi');
    log(`Fixes active: batch enforcement | rule reinforcement | math-safe | smart dedup (window:${DEDUP_WINDOW})`,'ok');

    try{
      // ─── INIT ───
      S.phase=PHASE.INIT; setPhase('Initializing...');
      setStep(1,''); setStep(2,''); setStep(3,'');

      let optCount=S.detectedOptCount||4;
      let optLabels=['(A)','(B)','(C)','(D)','(E)','(F)'].slice(0,optCount);

      log('Sending init prompt with full rules...','hi');
      await GPT.send(P.init(cfg,optCount,optLabels));
      const initResp=await GPT.waitForDone();
      S.fullRulesSent=true;
      if(initResp.includes('RULES_MEMORIZED'))log('GPT: Rules memorized ✓','ok');
      else log('Init response: '+initResp.substring(0,100),'warn');
      await checkPause();

      // ─── STEP 1: UPLOAD ───
      S.phase=PHASE.UPLOAD_WAIT; setPhase('Upload Outline + Samples');
      setStep(1,'active');
      const btnU=document.getElementById('btn-upload-ok');
      if(btnU)btnU.disabled=false;
      log('>>> Upload exam outline + sample questions to GPT, then click Confirm Upload','warn');
      toast('Upload outline + sample questions → click Confirm Upload','warning',15000);
      await waitForFlag(()=>S.uploadOk,'Upload confirmation');
      log('Upload confirmed ✓','ok'); setStep(1,'done');
      await checkPause(); if(!S.running)throw new Error('Stopped by user');

      // ─── DETECTION ───
      S.phase=PHASE.DETECTING; setPhase('Detecting domains + types...');
      log('Running auto-detection...','hi');

      let detectedDomains=[], detectedQTypes={};
      try{
        await GPT.send(P.detect());
        const detResp=await GPT.waitForDone();
        log('Detection response received','ok');

        detectedDomains=parseDomains(detResp);
        detectedQTypes=parseQTypes(detResp);
        const optParams=parseOptionParams(detResp);
        optCount=optParams.optCount;
        optLabels=['(A)','(B)','(C)','(D)','(E)','(F)'].slice(0,optCount);
        S.detectedOptCount=optCount;
        S.detectedOptLength=optParams.optLen;
        S.detectedStmtLength=optParams.stmtLen;

        const dp=document.getElementById('card-detected');if(dp)dp.style.display='block';
        const doc=document.getElementById('det-optcount');if(doc)doc.textContent=optCount;
        const dol=document.getElementById('det-optlen');if(dol)dol.textContent=optParams.optLen;
        const dsl=document.getElementById('det-stmtlen');if(dsl)dsl.textContent=optParams.stmtLen;

        log(`Detected: ${detectedDomains.length} domains, ${Object.keys(detectedQTypes).length} qtypes, ${optCount} options`,'ok');

        if(detectedDomains.length>0){
          S.domains=detectedDomains;
          buildDomainGrid(S.domains);
          saveDomains();
          toast(`${detectedDomains.length} domains detected ✓`,'success',5000);
        }
        buildQTypeGrid(detectedQTypes);

      }catch(e){log(`Detection error: ${e.message}`,'warn');}

      if(!S.domains||S.domains.length===0){
        log('No domains detected — pausing for manual entry','warn');
        toast('Domains not auto-detected. Add in Domain Mapping section, then Resume.','warning',15000);
        S.paused=true; setStatus('paused','Add Domains');
        document.getElementById('btn-resume').disabled=false;
        document.getElementById('btn-pause').disabled=true;
        await checkPause(); if(!S.running)throw new Error('Stopped by user');
        setStatus('running','Running');
      }

      const domTotal=S.domains.reduce((s,d)=>s+(d.weight||0),0);
      if(domTotal===0){
        log('No domain weights configured','error'); toast('Configure domain weights first','error');
        S.running=false; setBtns(false); stopTimer(); setStatus('error','No Domains'); return;
      }

      await checkPause();

      // ─── STEP 2: BOOKS UPLOAD ───
      S.phase=PHASE.BOOKS_WAIT; setPhase('Upload Reference Books');
      setStep(2,'active');
      const btnB=document.getElementById('btn-books-ok');
      if(btnB)btnB.disabled=false;
      log('>>> Upload ALL reference PDFs to GPT, then click Confirm Books','warn');
      toast('Upload ALL reference books → click Confirm Books','warning',15000);
      await waitForFlag(()=>S.booksOk,'Books confirmation');
      log('Books confirmed ✓','ok'); setStep(2,'done');
      await checkPause();

      // ─── BOOKS ACK ───
      S.phase=PHASE.BOOKS_ACK; setPhase('Confirming books...');
      log('Sending books acknowledgement...','hi');

      await GPT.send(P.booksAck(cfg,optCount,optLabels));
      const booksResp=await GPT.waitForDone();

      const detBooks=parseBooks(booksResp);
      if(detBooks.length>0){
        S.books=detBooks;
        log(`Detected ${detBooks.length} books ✓`,'ok');
        buildBookList(S.books);
        toast(`${detBooks.length} books confirmed!`,'success',5000);
      }else{
        log('Book names not parsed — using single generic book','warn');
        S.books=[{name:'Reference Material',index:0}];
        buildBookList(S.books);
      }

      if(booksResp.toLowerCase().includes('books_confirmed'))log('Books ack confirmed ✓','ok');
      else log('Books ack response: '+booksResp.substring(0,100),'warn');
      await checkPause();

      const qtTotal=Object.values(S.qtypes).reduce((s,v)=>s+v,0);
      if(qtTotal===0){
        S.qtypes={Application:30,Definition:25,Scenario:25,Recall:20};
        buildQTypeGrid(S.qtypes);
        log('Using default question type distribution','warn');
      }

      // ─── BUILD BATCH PLAN ───
      S.batchPlan=buildBatchPlan(cfg,S.domains,S.books,S.qtypes);
      S.totalBatches=S.batchPlan.length;
      if(S.batchPlan.length===0){
        log('FATAL: Batch plan is empty — check domain/qtype config','error');
        toast('Batch plan empty. Check domain weights.','error');
        S.running=false; setBtns(false); stopTimer(); setStatus('error','Empty Plan'); return;
      }
      log(`Batch plan: ${S.batchPlan.length} batches for ${cfg.totalQ} questions across ${S.books.length} books`,'hi');

      if(cfg.postPlan){
        const planText=[
          `Exam: ${cfg.exam}`,
          `Total: ${cfg.totalQ} questions | ${S.batchPlan.length} batches | ${S.books.length} books`,
          `Options: ${optCount}/question, max ${cfg.maxOptWords} words | Explanation: ${cfg.minL}–${cfg.maxL} lines`,
          `Math-safe mode: ${cfg.mathSafe?'ON':'OFF'}`,
          '',
          'DOMAINS:',
          ...S.domains.map(d=>`  ${d.name} – ${d.weight}%${d.subdomains?.length>0?'\n'+d.subdomains.map(s=>`    + ${s.name} – ${s.weight}%`).join('\n'):''}`),
          '','QUESTION TYPES:',
          ...Object.entries(S.qtypes).filter(([,v])=>v>0).map(([k,v])=>`  ${k} – ${v}%`),
          '','BOOKS:',
          ...S.books.map((b,i)=>`  ${i+1}. ${b.name}`),
          '',`FIRST 30 BATCHES:`,
          ...S.batchPlan.slice(0,30).map(b=>`  B${b.batchNum}: ${b.domain}${b.subdomain?'+'+b.subdomain:''} | ${b.qtype} | ${b.questionsInBatch}q | ${b.bookName.substring(0,30)}`),
          S.batchPlan.length>30?`  ...and ${S.batchPlan.length-30} more`:'',
        ].join('\n');
        await DOCS.post('GENERATION PLAN v3.2\n'+planText,'PLAN',cfg);
      }

      setProgress(0,cfg.totalQ);

      // ─── GENERATION ───
      S.phase=PHASE.GENERATING; setStep(3,'active');
      setPhase('Generating...'); S.currentBatch=0;
      log(`Starting generation — ${S.batchPlan.length} batches, zero interruption mode`,'hi');

      const startBatch=Math.max(1,cfg.startBatch||1);
      let globalQNum=1;

      for(const b of S.batchPlan){
        if(b.batchNum<startBatch)globalQNum+=b.questionsInBatch;
        else break;
      }

      for(let bi=0;bi<S.batchPlan.length;bi++){
        const batch=S.batchPlan[bi];
        if(!S.running){log('Stopped by user','warn');break;}
        if(batch.batchNum<startBatch)continue;

        await checkPause(); if(!S.running)break;

        S.currentBatch=batch.batchNum;
        updateActiveBook(batch.bookIndex);
        setPhase(`B${batch.batchNum}/${S.batchPlan.length} · ${batch.domain} · ${batch.qtype}`);
        addFeed(batch.batchNum,'cur',`${batch.domain}${batch.subdomain?'›'+batch.subdomain:''} [${batch.qtype}] ${batch.bookName.substring(0,20)}`);

        const ansPos=cfg.rotation?genAnswerPositions(batch.questionsInBatch,optCount):null;
        if(ansPos)S.answerHistory.push(...ansPos);

        /* ── FIX #3: Rule reinforcement after any error ── */
        if(needsRuleReinforce){
          log(`Sending rule reinforcement before batch ${batch.batchNum}...`,'warn');
          try{
            await GPT.send(P.reinforce(cfg,optCount,optLabels));
            const rr=await GPT.waitForDone(30000);
            if(rr.includes('REINFORCE_OK'))log('Reinforcement acknowledged ✓','ok');
            else log('Reinforce response: '+rr.substring(0,80),'debug');
            await sleep(800);
            needsRuleReinforce=false;
          }catch(e){log(`Reinforce failed: ${e.message} — continuing`,'warn');}
          await checkPause(); if(!S.running)break;
        }

        // Compact reminder every N batches (separate from reinforcement)
        if(batch.batchNum>startBatch&&(batch.batchNum-startBatch)%cfg.remindEvery===0&&!needsRuleReinforce){
          log(`Sending compact reminder at batch ${batch.batchNum}...`,'info');
          try{
            await GPT.send(P.reminder(cfg,optCount,cfg.maxOptWords));
            const remR=await GPT.waitForDone(30000);
            if(remR.includes('REMINDER_OK'))log('Reminder acknowledged ✓','ok');
            else log('Reminder response: '+remR.substring(0,80),'debug');
            await sleep(800);
          }catch(e){log(`Reminder failed: ${e.message} — continuing`,'warn');}
          await checkPause(); if(!S.running)break;
        }

        /* ── GENERATE BATCH WITH RETRY + PATCH LOGIC ── */
        let batchText='', batchOk=false, isRetry=false;
        let collectedBlocks=[]; // FIX #2: accumulate question blocks
        const maxAttempts=cfg.maxRetries+1;

        for(let attempt=1;attempt<=maxAttempts;attempt++){
          if(!S.running)break;
          try{
            const required=batch.questionsInBatch;
            log(`Batch ${batch.batchNum} [${batch.domain}·${batch.qtype}] attempt ${attempt}/${maxAttempts} | need ${required} Qs`,'info');
            const dedup=buildDedupBlock();

            const prompt=isRetry
              ?P.retry(batch.batchNum,cfg,optCount,optLabels,batch.domain,batch.qtype,required,globalQNum,batch.bookName,ansPos)
              :P.batch(batch.batchNum,cfg,optCount,optLabels,batch.domain,batch.subdomain,batch.qtype,required,globalQNum,batch.bookName,dedup,ansPos);

            await GPT.send(prompt);
            const resp=await GPT.waitForDone();

            if(cfg.validate){
              const v=validateResp(resp,cfg);
              if(!v.ok){
                log(`Batch ${batch.batchNum} invalid: ${v.reason}`,'warn');
                S.globalErrors++; needsRuleReinforce=true;
                if(attempt<maxAttempts){isRetry=true;await sleep(Math.min(attempt*2000,12000));continue;}
                throw new Error('Max retries: '+v.reason);
              }
            }

            /* ── FIX #2: COUNT ACTUAL QUESTIONS ── */
            const blocks=extractQuestionsFromResponse(resp);
            const gotCount=blocks.length;
            log(`Batch ${batch.batchNum}: GPT returned ${gotCount}/${required} questions`,'info');

            if(gotCount>=required){
              // We have enough — take exactly what we need
              collectedBlocks=blocks.slice(0,required);
              batchOk=true;
              break;
            }

            // Short batch — collect what we got, patch for the rest
            collectedBlocks=[...collectedBlocks,...blocks];
            // Deduplicate by Q number
            const seen=new Set();
            collectedBlocks=collectedBlocks.filter(b=>{
              const m=b.match(/^Q(\d+)\./);if(!m)return true;
              if(seen.has(m[1]))return false;seen.add(m[1]);return true;
            });

            const stillNeed=required-collectedBlocks.length;
            if(stillNeed<=0){
              batchOk=true;
              break;
            }

            // Patch
            if(attempt<=MAX_PATCH_ATTEMPTS){
              const nextQ=globalQNum+collectedBlocks.length;
              const patchAnsPos=ansPos?ansPos.slice(collectedBlocks.length):null;
              log(`Batch ${batch.batchNum}: patching ${stillNeed} missing questions (Q${nextQ}+)...`,'warn');
              needsRuleReinforce=true; // reinforce before patch

              // Reinforce before patch
              try{
                await GPT.send(P.reinforce(cfg,optCount,optLabels));
                await GPT.waitForDone(30000);
                needsRuleReinforce=false;
                await sleep(500);
              }catch(_){}

              await GPT.send(P.patch(batch.batchNum,cfg,optCount,optLabels,batch.domain,batch.qtype,nextQ,stillNeed,batch.bookName,patchAnsPos));
              const patchResp=await GPT.waitForDone();
              const patchBlocks=extractQuestionsFromResponse(patchResp);

              collectedBlocks=[...collectedBlocks,...patchBlocks];
              // Deduplicate again
              const seen2=new Set();
              collectedBlocks=collectedBlocks.filter(b=>{
                const m=b.match(/^Q(\d+)\./);if(!m)return true;
                if(seen2.has(m[1]))return false;seen2.add(m[1]);return true;
              });

              totalPatchCount++;
              const sp=document.getElementById('stat-patch');if(sp)sp.textContent=totalPatchCount;
              log(`After patch: ${collectedBlocks.length}/${required} questions`,'info');

              if(collectedBlocks.length>=required){
                batchOk=true;
                // Mark as patched in feed
                updateFeed(batch.batchNum,'patch');
                setTimeout(()=>updateFeed(batch.batchNum,'ok'),2000);
                break;
              }else{
                // Still short — treat remaining shortage as error and retry full batch
                log(`Patch insufficient (${collectedBlocks.length}/${required}) — retrying full batch`,'warn');
                S.globalErrors++; needsRuleReinforce=true; isRetry=true;
                collectedBlocks=[]; // reset, do full retry
                await sleep(Math.min(attempt*2000,12000));
                continue;
              }
            }else{
              // Max patch attempts reached — use what we have if reasonable (>=80%)
              const minAcceptable=Math.ceil(required*0.8);
              if(collectedBlocks.length>=minAcceptable){
                log(`Batch ${batch.batchNum}: accepting ${collectedBlocks.length}/${required} questions (>=80%)`, 'warn');
                batchOk=true;
                break;
              }
              log(`Batch ${batch.batchNum}: too few questions (${collectedBlocks.length}/${required}) — retrying`,'error');
              S.globalErrors++; needsRuleReinforce=true; isRetry=true;
              collectedBlocks=[];
              await sleep(Math.min(attempt*3000,20000));
            }

          }catch(e){
            log(`Batch ${batch.batchNum} attempt ${attempt} error: ${e.message}`,'error');
            S.globalErrors++; S.retries++; needsRuleReinforce=true;
            if(attempt<maxAttempts){
              isRetry=true; collectedBlocks=[];
              await sleep(Math.min(attempt*3000,20000));
            }else{
              log(`Batch ${batch.batchNum} FAILED after ${maxAttempts} attempts`,'error');
            }
          }
        }

        // Assemble final batch text from collected blocks
        if(batchOk&&collectedBlocks.length>0){
          batchText=cleanResponse(collectedBlocks.join('\n\n'));
        }

        // Save to Google Docs
        if(batchOk&&batchText){
          const heading=`BATCH ${batch.batchNum} | ${batch.domain}${batch.subdomain?' + '+batch.subdomain:''} | ${batch.qtype} | ${batch.questionsInBatch} Questions`;
          const sourceNote=`[Source: ${batch.bookName}]`;

          try{
            await DOCS.post(batchText,heading,cfg);
            await DOCS.post(sourceNote,`Batch ${batch.batchNum} Source`,cfg);
            S.completedBatches.push(batch.batchNum);
            updateBookCount(batch.bookIndex,collectedBlocks.length||batch.questionsInBatch);
            registerBatch(batchText); // register stems/opts for dedup
            S.globalErrors=Math.max(0,S.globalErrors-1);
            globalQNum+=collectedBlocks.length||batch.questionsInBatch;
            setProgress(globalQNum-1,cfg.totalQ);
            updateFeed(batch.batchNum,'ok');
            log(`Batch ${batch.batchNum} saved ✓ (${collectedBlocks.length} Qs, book: ${batch.bookName.substring(0,20)})`,'ok');
          }catch(e){
            log(`Batch ${batch.batchNum} generated OK but save failed: ${e.message}`,'error');
            S.completedBatches.push(batch.batchNum);
            registerBatch(batchText);
            globalQNum+=collectedBlocks.length||batch.questionsInBatch;
            setProgress(globalQNum-1,cfg.totalQ);
            updateFeed(batch.batchNum,'ok');
          }

        }else{
          S.failedBatches.push(batch.batchNum);
          updateFeed(batch.batchNum,'fail');
          updateFailUI();
          log(`Batch ${batch.batchNum} FAILED — skipping, continuing to next`,'error');
          globalQNum+=batch.questionsInBatch;
          setProgress(globalQNum-1,cfg.totalQ);
          needsRuleReinforce=true; // reinforce before next batch after failure

          if(S.globalErrors>=20){
            log('20+ errors — auto-pausing','error');
            toast('Many errors. Paused — check log then Resume.','error',12000);
            setStatus('error','Many Errors');
            S.paused=true;
            document.getElementById('btn-pause').disabled=true;
            document.getElementById('btn-resume').disabled=false;
            document.getElementById('btn-retry').disabled=false;
            await checkPause();
            setStatus('running','Running');
            document.getElementById('btn-pause').disabled=false;
            document.getElementById('btn-resume').disabled=true;
            document.getElementById('btn-retry').disabled=true;
            S.globalErrors=0;
          }
        }

        if(bi<S.batchPlan.length-1&&S.running)await sleep(cfg.batchDelay);
      }

      // ─── DONE ───
      S.phase=PHASE.DONE; setStep(3,'done'); stopTimer();
      setStatus('done','Complete!'); setPhase('Complete');
      document.getElementById('prog-bar')?.classList.add('full');

      if(S.answerHistory.length>0){
        const cnt={};S.answerHistory.forEach(p=>cnt[p]=(cnt[p]||0)+1);
        log(`Answer distribution: ${Object.entries(cnt).sort().map(([k,v])=>`${k}:${v}`).join(' ')}`,'ok');
      }
      log(`COMPLETE: ${S.completedBatches.length} batches done | ${S.failedBatches.length} failed | ${S.stemRegistry.size} unique Qs | ${totalPatchCount} patches`,'ok');

      if(S.failedBatches.length>0)toast(`Done! ${S.completedBatches.length} saved, ${S.failedBatches.length} failed. See log.`,'warning',12000);
      else toast(`All ${cfg.totalQ} questions generated and saved!`,'success',12000);
      store.del('state');

    }catch(err){
      log('FATAL: '+err.message,'error');
      if(err.message!=='Stopped by user'){
        setStatus('error','Error'); setPhase('Error: '+err.message.substring(0,40));
        toast('Fatal error: '+err.message,'error',10000);
      }else{
        setStatus('idle','Stopped'); setPhase('Stopped by user');
      }
    }

    S.running=false; setBtns(false);
    document.getElementById('btn-pause').disabled=true;
    document.getElementById('btn-resume').disabled=true;
  }

  /* ════════════════════════════════════════════════════════════
     EVENT BINDINGS
  ════════════════════════════════════════════════════════════ */
  function bindEvents(){
    const g=id=>document.getElementById(id);

    g('btn-min')?.addEventListener('click',()=>g('pqa-panel').classList.toggle('min'));
    g('btn-close')?.addEventListener('click',()=>g('pqa-wrap').classList.add('hidden'));
    g('btn-export')?.addEventListener('click',exportLog);

    g('btn-eye')?.addEventListener('click',()=>{const i=g('f-key');if(i)i.type=i.type==='password'?'text':'password';});

    g('btn-test')?.addEventListener('click',async()=>{
      const r=g('conn-result'); r.className='conn-r test'; g('conn-msg').textContent='Testing...';
      const cfg=getCfg();
      if(!cfg.url||!cfg.docId||!cfg.secret){r.className='conn-r err';g('conn-msg').textContent='Fill all 3 fields';return;}
      try{await DOCS.testConn(cfg);r.className='conn-r ok';g('conn-msg').textContent='Connection OK';log('Connection: OK','ok');}
      catch(e){r.className='conn-r err';g('conn-msg').textContent='Failed: '+e.message;log('Connection failed: '+e.message,'error');}
    });

    g('f-totalq')?.addEventListener('input',()=>{updateDomainTotal();updateQTypeTotal();});

    g('btn-open-upload')?.addEventListener('click',()=>{GPT.triggerUpload();log('Opening upload for outline + samples','info');});
    g('btn-open-books')?.addEventListener('click',()=>{GPT.triggerUpload();log('Opening upload for reference books','info');});

    g('btn-upload-ok')?.addEventListener('click',()=>{
      S.uploadOk=true;
      const btn=g('btn-upload-ok');btn.disabled=true;btn.className='btn suc sm conf';btn.textContent='Confirmed';
      log('Upload confirmed','ok');toast('Upload confirmed!','success');
    });

    g('btn-books-ok')?.addEventListener('click',()=>{
      S.booksOk=true;
      const btn=g('btn-books-ok');btn.disabled=true;btn.className='btn suc sm conf';btn.textContent='Confirmed';
      log('Books confirmed','ok');toast('Books confirmed!','success');
    });

    g('btn-start')?.addEventListener('click',()=>{
      S.uploadOk=false; S.booksOk=false;
      S.completedBatches=[]; S.failedBatches=[];
      S.currentBatch=0; S.globalErrors=0; S.retries=0;
      S.stemRegistry=new Set(); S.stemHistory=[];
      S.optionRegistry=new Set(); S.explanationRegistry=new Set();
      S.answerHistory=[]; S.batchPlan=[];
      S.bookQuestionCounts={};
      needsRuleReinforce=false; totalPatchCount=0;
      setStep(1,''); setStep(2,''); setStep(3,'');
      ['btn-upload-ok','btn-books-ok'].forEach(id=>{
        const btn=g(id);if(!btn)return;
        btn.disabled=true; btn.className='btn suc sm';
        btn.textContent=id.includes('upload')?'Confirm Upload':'Confirm Books';
      });
      const feed=g('batch-feed');if(feed)feed.innerHTML='';
      const sp=g('stat-patch');if(sp)sp.textContent='0';
      runWorkflow();
    });

    g('btn-pause')?.addEventListener('click',()=>{
      S.paused=true; g('btn-pause').disabled=true; g('btn-resume').disabled=false;
      setStatus('paused','Paused'); log('Paused','warn'); toast('Paused — click Resume','warning');
    });

    g('btn-resume')?.addEventListener('click',()=>{
      S.paused=false; g('btn-pause').disabled=false; g('btn-resume').disabled=true; g('btn-retry').disabled=true;
      setStatus('running','Running'); log('Resumed','ok');
      if(S.pauseResolver){S.pauseResolver();S.pauseResolver=null;}
    });

    g('btn-retry')?.addEventListener('click',()=>{
      S.retries=0; S.globalErrors=0; S.paused=false; needsRuleReinforce=false;
      g('btn-pause').disabled=false; g('btn-resume').disabled=true; g('btn-retry').disabled=true;
      setStatus('running','Running'); log('Retry initiated','info');
      if(S.pauseResolver){S.pauseResolver();S.pauseResolver=null;}
    });

    g('btn-skip')?.addEventListener('click',()=>{
      if(!S.running)return;
      log('Skip requested','warn'); toast('Skipping batch','warning');
      if(S.watcherTimer){clearInterval(S.watcherTimer);S.watcherTimer=null;}
    });

    g('btn-stop')?.addEventListener('click',()=>{
      S.running=false; S.paused=false;
      if(S.watcherTimer){clearInterval(S.watcherTimer);S.watcherTimer=null;}
      if(S.pauseResolver){S.pauseResolver();S.pauseResolver=null;}
      setStatus('idle','Stopped'); setPhase('Stopped by user');
      setBtns(false); stopTimer();
      log('Stopped by user','warn'); toast('Stopped','warning');
    });

    g('btn-reset')?.addEventListener('click',()=>{
      if(!confirm('Reset everything? All config and progress will be cleared.'))return;
      performReset();
    });

    g('btn-export-plan')?.addEventListener('click',()=>{
      if(S.batchPlan.length===0){toast('No batch plan yet','warning');return;}
      const txt=['PracticeQ v'+VERSION+' — Batch Plan',`Exam: ${getCfg().exam}`,`Batches: ${S.batchPlan.length}`,`Books: ${S.books.map(b=>b.name).join(', ')}`,'',
        ...S.batchPlan.map(b=>`B${b.batchNum}: ${b.domain}${b.subdomain?'+'+b.subdomain:''} | ${b.qtype} | ${b.questionsInBatch}q | ${b.bookName}`)
      ].join('\n');
      try{GM_setClipboard(txt);toast('Plan copied','success');}
      catch(_){const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([txt],{type:'text/plain'}));a.download=`pqa-plan-${Date.now()}.txt`;a.click();toast('Plan downloaded','success');}
    });

    g('btn-log-copy')?.addEventListener('click',()=>{
      const txt=S.logEntries.map(e=>`[${e.ts}][${e.level.toUpperCase()}] ${e.message}`).join('\n');
      try{GM_setClipboard(txt);toast('Log copied','success');}
      catch(_){navigator.clipboard?.writeText(txt).then(()=>toast('Log copied','success'));}
    });
    g('btn-log-clear')?.addEventListener('click',()=>{const el=g('pqa-log');if(el)el.innerHTML='';S.logEntries=[];});
    g('btn-clear-feed')?.addEventListener('click',()=>{const el=g('batch-feed');if(el)el.innerHTML='';});
    g('acc-adv-hdr')?.addEventListener('click',()=>g('acc-adv').classList.toggle('open'));

    document.querySelectorAll('#pqa-wrap .tog').forEach(t=>t.addEventListener('click',()=>t.classList.toggle('on')));

    const fields=['f-url','f-docid','f-key','f-exam','f-totalq','f-batch','f-minl','f-maxl',
      'f-startbatch','f-maxretry','f-remind','f-poll','f-timeout','f-batchdelay','f-minresp','f-maxoptw'];
    fields.forEach(id=>{
      const el=g(id);if(!el)return;
      const sv=store.get(id,'');if(sv)el.value=sv;
      el.addEventListener('change',()=>store.set(id,el.value));
      el.addEventListener('blur',()=>store.set(id,el.value));
    });
  }

  /* ════════════════════════════════════════════════════════════
     RESET
  ════════════════════════════════════════════════════════════ */
  function performReset(){
    S.running=false; S.paused=false;
    if(S.watcherTimer)clearInterval(S.watcherTimer);
    if(S.pauseResolver)S.pauseResolver();
    stopTimer(); S=defaultState(); store.clearAll();
    needsRuleReinforce=false; totalPatchCount=0;

    setStatus('idle','Idle'); setPhase('Fill config below to begin');
    setProgress(0,0); setBtns(false);
    setStep(1,''); setStep(2,''); setStep(3,'');
    const g=id=>document.getElementById(id);
    ['btn-upload-ok','btn-books-ok'].forEach(id=>{
      const btn=g(id);if(!btn)return;
      btn.disabled=true; btn.className='btn suc sm';
      btn.textContent=id.includes('upload')?'Confirm Upload':'Confirm Books';
    });
    ['f-url','f-docid','f-key','f-exam','f-totalq','f-batch','f-minl','f-maxl','f-startbatch']
      .forEach(id=>{const el=g(id);if(el)el.value='';});
    const logEl=g('pqa-log');if(logEl)logEl.innerHTML='';
    const feed=g('batch-feed');if(feed)feed.innerHTML='';
    ['stat-done','stat-fail','stat-retry','stat-batch','stat-dedup','stat-patch'].forEach(id=>{const el=g(id);if(el)el.textContent='0';});
    const sb=g('stat-book');if(sb)sb.textContent='—';
    const pt=g('pg-txt');if(pt)pt.textContent='0 / 0 questions';
    const pp=g('pg-pct');if(pp)pp.textContent='0%';
    const bar=g('prog-bar');if(bar){bar.style.width='0%';bar.classList.remove('full');}
    const el2=g('pqa-elapsed');if(el2)el2.textContent='00:00:00';
    const cr=g('conn-result');if(cr)cr.className='conn-r hidden';
    const fb=g('fail-box');if(fb)fb.style.display='none';
    const dg=g('dom-grid');if(dg)dg.innerHTML='';
    const qg=g('qt-grid');if(qg)qg.innerHTML='';
    const bl=g('book-list');if(bl)bl.innerHTML='';
    const cd=g('card-detected');if(cd)cd.style.display='none';
    const dh=g('domain-hint');if(dh)dh.style.display='block';
    const qh=g('qtype-hint');if(qh)qh.style.display='block';
    const bh=g('books-hint');if(bh)bh.style.display='block';
    const db=g('domain-badge');if(db){db.textContent='Pending';db.className='badge b-auto';}
    const qb=g('qtype-badge');if(qb){qb.textContent='Pending';qb.className='badge b-auto';}
    const bb=g('books-badge');if(bb){bb.textContent='Pending';bb.className='badge b-auto';}
    const dtb=g('dom-total-bar');if(dtb)dtb.style.display='none';
    const qtb=g('qt-total-bar');if(qtb)qtb.style.display='none';
    log('Reset complete','warn'); toast('Reset complete','warning');
  }

  /* ════════════════════════════════════════════════════════════
     LOG EXPORT
  ════════════════════════════════════════════════════════════ */
  function exportLog(){
    const cfg=getCfg();
    const adist=S.answerHistory.length>0?(()=>{const c={};S.answerHistory.forEach(p=>c[p]=(c[p]||0)+1);return Object.entries(c).sort().map(([k,v])=>`${k}:${v}`).join(' ');})():'N/A';
    const header=[
      `PracticeQ AutoPilot v${VERSION}`,
      `Exam: ${cfg.exam||'Not set'}`,
      `Progress: ${S.currentQuestion}/${S.totalQuestions} questions`,
      `Batches: ${S.completedBatches.length} done, ${S.failedBatches.length} failed`,
      `Patches applied: ${totalPatchCount}`,
      `Unique stems: ${S.stemRegistry.size}`,
      `Books: ${S.books.map(b=>b.name).join(', ')||'none'}`,
      `Answer dist: ${adist}`,
      `Date: ${new Date().toISOString()}`,
      '-'.repeat(60),'',
    ].join('\n');
    const lines=S.logEntries.map(e=>`[${e.ts}][${e.level.padEnd(5)}] ${e.message}`).join('\n');
    const full=header+lines;
    try{GM_setClipboard(full);toast('Log copied','success');}
    catch(_){
      const a=document.createElement('a');
      a.href=URL.createObjectURL(new Blob([full],{type:'text/plain'}));
      a.download=`pqa-v32-log-${Date.now()}.txt`; a.click();
      toast('Log downloaded','success');
    }
  }

  /* ════════════════════════════════════════════════════════════
     SESSION RECOVERY
  ════════════════════════════════════════════════════════════ */
  function checkRecovery(){
    const saved=store.load();
    if(!saved||saved.phase===PHASE.DONE||saved.phase===PHASE.IDLE)return;
    if(saved.phase===PHASE.GENERATING&&saved.currentBatch>0){
      log(`Saved session: batch ${saved.currentBatch}/${saved.totalBatches}`,'warn');
      if(saved.domains?.length>0){S.domains=saved.domains;buildDomainGrid(S.domains);}
      if(saved.qtypes&&Object.keys(saved.qtypes).length>0){S.qtypes=saved.qtypes;buildQTypeGrid(saved.qtypes);}
      if(saved.books?.length>0){S.books=saved.books;S.bookQuestionCounts=saved.bookQuestionCounts||{};buildBookList(S.books);}
      if(saved.detectedOptCount){S.detectedOptCount=saved.detectedOptCount;}
      const sp=document.getElementById('f-startbatch');
      if(sp){sp.value=saved.currentBatch+1;store.set('f-startbatch',sp.value);}
      toast(`Resume from batch ${saved.currentBatch+1}? Start batch set.`,'warning',12000);
    }
  }

  /* ════════════════════════════════════════════════════════════
     KEYBOARD SHORTCUTS
  ════════════════════════════════════════════════════════════ */
  document.addEventListener('keydown',e=>{
    if(e.altKey&&e.shiftKey&&e.key==='Q'){const w=document.getElementById('pqa-wrap');if(w)w.classList.toggle('hidden');}
    if(e.altKey&&e.shiftKey&&e.key==='P'){if(S.running){if(!S.paused)document.getElementById('btn-pause')?.click();else document.getElementById('btn-resume')?.click();}}
    if(e.altKey&&e.shiftKey&&e.key==='S')document.getElementById('btn-stop')?.click();
  });

  /* ════════════════════════════════════════════════════════════
     INIT
  ════════════════════════════════════════════════════════════ */
  function launch(){
    document.getElementById('pqa-wrap')?.remove();
    const wrap=buildUI();
    initDrag(wrap);
    try{const sd=JSON.parse(store.get('domains','')||'null');if(sd?.length>0){S.domains=sd;buildDomainGrid(S.domains);}}catch(_){}
    try{const sq=JSON.parse(store.get('qtypes','')||'null');if(sq&&Object.keys(sq).length>0){S.qtypes=sq;buildQTypeGrid(sq);}}catch(_){}
    bindEvents();
    log(`PracticeQ AutoPilot v${VERSION} ready`,'ok');
    log(`Fixes: (1) Smart dedup window:${DEDUP_WINDOW} | (2) Batch enforcement+patch | (3) Rule reinforce after errors | (4) Math-safe Docs`,'ok');
    checkRecovery();
    toast('PracticeQ AutoPilot v3.2 Ready','success',4000);
  }

  function init(){
    if(!document.body){document.addEventListener('DOMContentLoaded',init);return;}
    let tries=0;
    const poll=setInterval(()=>{
      tries++;
      const ready=document.getElementById('prompt-textarea')
        ||document.querySelector('[contenteditable="true"]')
        ||document.querySelector('main')
        ||tries>20;
      if(ready){clearInterval(poll);setTimeout(launch,500);}
    },600);
    setTimeout(()=>{clearInterval(poll);if(!document.getElementById('pqa-wrap'))setTimeout(launch,100);},15000);
  }

  init();

})();