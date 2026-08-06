// <agent-animation> Web Component
// Shadow DOM + internal iframe approach — animation code uses vh/vw extensively,
// so the iframe provides its own viewport context with zero animation code changes.

class AgentAnimation extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._iframe = null;
  }

  connectedCallback() {
    const style = document.createElement('style');
    style.textContent = `
      :host {
        display: block;
        width: 100%;
        height: 100%;
        overflow: hidden;
      }
      iframe {
        border: none;
        width: 100%;
        height: 100%;
        display: block;
        background: #050509;
      }
    `;

    const iframe = document.createElement('iframe');
    iframe.setAttribute('scrolling', 'no');
    iframe.setAttribute('allowtransparency', 'true');
    // srcdoc will be set by build.js which embeds the full HTML
    iframe.srcdoc = AgentAnimation._html || '';

    this._iframe = iframe;
    this.shadowRoot.appendChild(style);
    this.shadowRoot.appendChild(iframe);
  }

  disconnectedCallback() {
    this._iframe = null;
  }

  /** Trigger the animation to play */
  play() {
    if (this._iframe && this._iframe.contentWindow) {
      this._iframe.contentWindow.postMessage('play', '*');
    }
  }

  /** Restart the animation from scratch */
  replay() {
    if (this._iframe && this._iframe.contentWindow) {
      this._iframe.contentWindow.postMessage('replay', '*');
    }
  }

  /** Set animation speed multiplier */
  setSpeed(s) {
    if (this._iframe && this._iframe.contentWindow) {
      this._iframe.contentWindow.postMessage({ type: 'setSpeed', speed: s }, '*');
    }
  }
}

// Placeholder — build.js replaces this with the actual HTML content
AgentAnimation._html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>49Agents</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700&family=Montserrat:wght@300;600&family=Syne:wght@800&display=swap" rel="stylesheet">
</head>
<body>
  <div id="stage"></div>

  <style>
    /* === Base CSS === */

    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      background: #050509;
      color: #e0e0e0;
      font-family: 'JetBrains Mono', monospace;
      overflow: hidden;
      width: 100vw;
      height: 100vh;
    }

    #stage {
      position: relative;
      width: 100%;
      height: 100%;
    }

    /* === Pane — Glass Morphism Container === */

    .pane {
      background: rgba(18, 18, 35, 0.97);
      border-radius: 12px;
      border: 1px solid rgba(255, 255, 255, 0.1);
      box-shadow: 0 0 20px rgba(255, 255, 255, 0.03), inset 0 0 20px rgba(255, 255, 255, 0.02);
      position: absolute;
      transition: left 1s cubic-bezier(0.4, 0, 0.2, 1), top 1s cubic-bezier(0.4, 0, 0.2, 1), width 1s cubic-bezier(0.4, 0, 0.2, 1), height 1s cubic-bezier(0.4, 0, 0.2, 1), opacity 1s cubic-bezier(0.4, 0, 0.2, 1), border-color 1s cubic-bezier(0.4, 0, 0.2, 1), transform 1s cubic-bezier(0.4, 0, 0.2, 1);
      overflow: hidden;
      display: flex;
      flex-direction: column;
    }
    .pane.pane-minimized {
      transform: translateY(80vh) scale(0.85);
      opacity: 0;
      transition: transform 0.3s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.25s ease;
    }
    .pane.pane-minimized-top {
      transform: translateY(-80vh) scale(0.85);
      opacity: 0;
      transition: transform 0.3s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.25s ease;
    }

    /* === Pane Header — 32px Tall Header Bar === */

    .pane-header {
      height: 32px;
      background: rgba(0, 0, 0, 0.3);
      border-bottom: 1px solid rgba(255, 255, 255, 0.05);
      display: flex;
      align-items: center;
      padding: 0 12px;
    }

    .dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      display: inline-block;
      margin-right: 6px;
    }

    .dot.red { background: #ff5f57; }
    .dot.yellow { background: #febc2e; }
    .dot.green { background: #28c840; }

    .pane-title {
      font-size: 12px;
      color: rgba(255, 255, 255, 0.5);
      margin-left: 6px;
    }

    /* === Pane Tabs === */

    .pane-tabs {
      display: flex;
      gap: 4px;
      padding: 4px 8px;
      background: rgba(0, 0, 0, 0.2);
      align-items: center;
    }

    .tab-plus {
      width: 20px;
      height: 20px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 14px;
      color: rgba(255, 255, 255, 0.25);
      cursor: pointer;
      margin-left: 2px;
      transition: background 0.2s, color 0.2s;
    }

    .tab-plus:hover {
      background: rgba(255, 255, 255, 0.08);
      color: rgba(255, 255, 255, 0.5);
    }

    .pane-tabs .tab {
      padding: 4px 10px;
      border-radius: 100px;
      font-size: 11px;
      color: rgba(255, 255, 255, 0.4);
      cursor: pointer;
    }

    .pane-tabs .tab.active {
      background: rgba(99, 102, 241, 0.2);
      color: rgba(255, 255, 255, 0.8);
    }

    /* === Pane Body === */

    .pane-body {
      padding: 8px 12px;
      font-size: 12px;
      line-height: 1.6;
      overflow: hidden;
      white-space: pre-wrap;
      color: rgba(255, 255, 255, 0.7);
      flex: 1;
      min-height: 0;
      width: 100%;
    }
    .dot-grid .pane-body {
      font-size: 14px;
    }

    /* === Dark Overlay === */

    .dark-overlay {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.75);
      z-index: 50;
      opacity: 0;
      transition: opacity 1.2s ease;
    }

    .dark-overlay.active {
      opacity: 1;
    }

    /* === Dot Grid (applied to #stage) === */

    .dot-grid {
      background-image: radial-gradient(circle, rgba(99, 102, 241, 0.08) 1px, transparent 1px);
      background-size: 24px 24px;
    }

    /* === Canvas Border (removed) === */

    /* === Notification Overlays === */

    .notif-overlay {
      position: absolute;
      inset: 0;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      z-index: 10;
      opacity: 0;
      transition: opacity 0.25s;
      border-radius: 12px;
      font-family: 'JetBrains Mono', monospace;
    }

    .notif-overlay.active {
      opacity: 1;
    }

    .notif-question {
      background: rgba(168, 130, 255, 0.15);
      backdrop-filter: blur(6px);
      border: 1px solid rgba(168, 130, 255, 0.3);
    }

    .notif-permission {
      background: rgba(185, 28, 28, 0.12);
      backdrop-filter: blur(6px);
      border: 1px solid rgba(185, 28, 28, 0.3);
    }

    .notif-done {
      background: rgba(16, 185, 129, 0.1);
      backdrop-filter: blur(6px);
      border: 1px solid rgba(16, 185, 129, 0.3);
    }

    .notif-content {
      font-size: 11px;
      line-height: 1.6;
      color: rgba(255, 255, 255, 0.7);
      text-align: center;
      padding: 8px 14px;
      max-width: 90%;
    }

    .notif-actions {
      display: flex;
      gap: 8px;
      margin-top: 8px;
    }

    .notif-btn {
      padding: 3px 12px;
      border-radius: 4px;
      font-size: 10px;
      font-family: 'JetBrains Mono', monospace;
      border: none;
      cursor: pointer;
    }

    .notif-btn-allow {
      background: rgba(99, 102, 241, 0.5);
      color: white;
    }

    .notif-btn-deny {
      background: rgba(255, 255, 255, 0.1);
      color: rgba(255, 255, 255, 0.5);
    }

    .notif-btn-yes {
      background: rgba(99, 102, 241, 0.5);
      color: white;
    }

    .notif-btn-no {
      background: rgba(255, 255, 255, 0.1);
      color: rgba(255, 255, 255, 0.5);
    }

    /* === Narration Text Overlay === */

    .narration-container {
      position: fixed;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      z-index: 300;
      pointer-events: none;
      transition: top 0.6s ease;
    }

    .narration-container.narr-above {
      top: calc(50% - 230px);
    }

    .narration-sentence {
      font-family: 'Montserrat', sans-serif;
      font-size: 27px;
      font-weight: 300;
      color: rgba(255, 255, 255, 0.9);
      text-align: center;
      max-width: 1000px;
      line-height: 1.5;
      padding: 120px 200px;
      opacity: 0;
      transition: opacity 0.5s ease;
      background: radial-gradient(ellipse at center, rgba(0,0,0,0.8) 0%, rgba(0,0,0,0.5) 25%, rgba(0,0,0,0) 55%);
    }

    .narration-sentence.active {
      opacity: 1;
    }

    /* === Fake Cursor === */

    .fake-cursor {
      width: 14px;
      height: 20px;
      position: absolute;
      z-index: 200;
      pointer-events: none;
      transition-property: left, top;
      transition-timing-function: cubic-bezier(0.4, 0, 0.2, 1);
      transition-duration: 0.4s;
    }

    .fake-cursor::before {
      content: '';
      display: block;
      width: 14px;
      height: 20px;
      background: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 14 20'%3E%3Cpath d='M0 0L0 17L4.5 12.5L7 20L9 19L6.5 11.5L12 11.5Z' fill='white' stroke='rgba(0,0,0,0.3)' stroke-width='0.5'/%3E%3C/svg%3E") no-repeat;
      background-size: contain;
      transition: transform 0.1s;
    }

    .fake-cursor.clicking::before {
      transform: scale(0.85);
    }

    /* === CTA Button === */

    .cta-button {
      background: linear-gradient(135deg, #6366f1, #8b5cf6);
      color: white;
      border: none;
      border-radius: 8px;
      padding: 14px 28px;
      font-size: 14px;
      font-weight: 600;
      font-family: 'Montserrat', sans-serif;
      cursor: pointer;
      transition: transform 0.2s, box-shadow 0.2s;
    }

    .cta-button:hover {
      transform: translateY(-2px);
      box-shadow: 0 8px 30px rgba(99, 102, 241, 0.3);
    }

    @keyframes btnPulse {
      0%, 100% {
        box-shadow: 0 0 0 rgba(99, 102, 241, 0);
      }
      50% {
        box-shadow: 0 0 20px rgba(99, 102, 241, 0.4);
      }
    }
    @keyframes orbDrift0 {
      0%, 100% { transform: translate(0, 0); }
      33% { transform: translate(60px, 40px); }
      66% { transform: translate(-30px, 80px); }
    }

    @keyframes orbDrift1 {
      0%, 100% { transform: translate(0, 0); }
      33% { transform: translate(-50px, 60px); }
      66% { transform: translate(40px, -30px); }
    }

    @keyframes orbDrift2 {
      0%, 100% { transform: translate(0, 0); }
      33% { transform: translate(30px, -50px); }
      66% { transform: translate(-60px, 20px); }
    }
    /* === Git Graph (matches app styling 1:1) === */

    .git-graph-container {
      display: flex;
      flex-direction: column;
      height: 100%;
      overflow: hidden;
    }

    .git-graph-header {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 6px 10px;
      border-bottom: 1px solid rgba(255,255,255,0.06);
      flex-shrink: 0;
      font-size: 12px;
    }

    .git-graph-branch-name {
      color: #4ec9b0;
      font-weight: bold;
      font-family: 'JetBrains Mono', monospace;
    }

    .git-graph-clean {
      color: #4ec9b0;
    }

    .git-graph-dirty {
      color: #f97583;
    }

    .git-graph-detail {
      font-size: 11px;
      margin-left: 6px;
      display: inline-flex;
      gap: 6px;
      align-items: center;
    }

    .git-detail-staged { color: #4ec9b0; }
    .git-detail-modified { color: #e5c07b; }
    .git-detail-new { color: #f97583; font-weight: bold; }

    .git-graph-push-btn {
      margin-left: auto;
      padding: 2px 10px;
      font-size: 13px;
      font-family: 'JetBrains Mono', monospace;
      background: rgba(99, 102, 241, 0.2);
      color: #a5b4fc;
      border: 1px solid rgba(99, 102, 241, 0.35);
      border-radius: 4px;
      cursor: pointer;
      white-space: nowrap;
    }

    .git-graph-output {
      flex: 1;
      overflow-y: auto;
      overflow-x: hidden;
      scrollbar-width: thin;
      scrollbar-color: rgba(255, 255, 255, 0.1) transparent;
      padding: 8px 10px;
      margin: 0;
      font-family: 'JetBrains Mono', monospace;
      font-size: 12px;
      line-height: 1.5;
      color: #d4d4d4;
      white-space: pre;
      tab-size: 4;
    }

    .git-graph-output::-webkit-scrollbar {
      width: 5px;
      height: 0;
    }

    .git-graph-output::-webkit-scrollbar-thumb {
      background: rgba(255, 255, 255, 0.1);
      border-radius: 3px;
    }

    .git-indicator {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 18px;
      font-size: 15px;
      flex-shrink: 0;
      vertical-align: middle;
    }

    .git-indicator svg { display: block; }

    .git-master { color: #ffea7f; }
    .git-remote { color: #79b8ff; }
    .git-synced { color: #85e89d; }

    .git-time {
      color: rgba(255,255,255,0.25);
      font-size: 0.9em;
      margin-right: 2px;
    }

    .git-branch-master { color: #85e89d; }
    .git-branch-other  { color: #79b8ff; }

    /* When pane-body contains the git graph, reset conflicting styles */
    .pane-body:has(.git-graph-container) {
      padding: 0;
      white-space: normal;
      overflow: hidden;
      display: flex;
      flex-direction: column;
    }

    /* === Add Pane Button & Placement Ghost === */

    .add-pane-btn {
      position: absolute;
      top: 0.5%;
      right: calc(-18% - 40px);
      width: 47px;
      height: 47px;
      border-radius: 50%;
      border: none;
      background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%);
      color: white;
      font-size: 28px;
      font-weight: 300;
      line-height: 1;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 100;
      box-shadow: 0 2px 12px rgba(99, 102, 241, 0.4);
      transition: opacity 0.4s, transform 0.2s;
      opacity: 0;
    }

    .placement-ghost {
      position: absolute;
      pointer-events: none;
      z-index: 99;
      border: 2px dashed rgba(99, 102, 241, 0.7);
      border-radius: 12px;
      background: rgba(99, 102, 241, 0.08);
      display: flex;
      align-items: center;
      justify-content: center;
      transition: left 0.5s cubic-bezier(0.4, 0, 0.2, 1),
                  top 0.5s cubic-bezier(0.4, 0, 0.2, 1),
                  width 0.5s cubic-bezier(0.4, 0, 0.2, 1),
                  height 0.5s cubic-bezier(0.4, 0, 0.2, 1),
                  opacity 0.25s;
      animation: placementPulse 1.5s ease-in-out infinite;
    }

    .placement-ghost-label {
      font-size: 11px;
      color: rgba(255, 255, 255, 0.5);
      font-weight: 500;
      letter-spacing: 0.5px;
      user-select: none;
    }

    @keyframes placementPulse {
      0%, 100% { border-color: rgba(99, 102, 241, 0.5); background: rgba(99, 102, 241, 0.06); }
      50% { border-color: rgba(99, 102, 241, 0.9); background: rgba(99, 102, 241, 0.12); }
    }

    /* === Beads Issues Pane (simplified, matches app) === */

    .beads-container {
      display: flex;
      flex-direction: column;
      height: 100%;
      overflow: hidden;
      font-size: 12px;
    }

    .beads-header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 10px;
      border-bottom: 1px solid rgba(255,255,255,0.06);
      flex-shrink: 0;
    }

    .beads-counts {
      display: flex;
      gap: 6px;
      flex-shrink: 0;
    }

    .beads-badge {
      padding: 1px 7px;
      border-radius: 10px;
      font-size: 11px;
      font-family: 'JetBrains Mono', monospace;
      font-weight: 600;
      letter-spacing: 0.02em;
    }

    .beads-badge-open {
      background: rgba(79, 209, 197, 0.15);
      color: #4ec9b0;
      border: 1px solid rgba(79, 209, 197, 0.25);
    }

    .beads-badge-progress {
      background: rgba(99, 102, 241, 0.15);
      color: #a5b4fc;
      border: 1px solid rgba(99, 102, 241, 0.25);
    }

    .beads-table-wrap {
      flex: 1;
      overflow-y: auto;
      overflow-x: hidden;
      scrollbar-width: thin;
      scrollbar-color: rgba(255, 255, 255, 0.1) transparent;
    }

    .beads-table-wrap::-webkit-scrollbar { width: 5px; }
    .beads-table-wrap::-webkit-scrollbar-thumb {
      background: rgba(255, 255, 255, 0.1);
      border-radius: 3px;
    }

    .beads-table {
      width: 100%;
      border-collapse: collapse;
      font-family: 'JetBrains Mono', monospace;
      table-layout: fixed;
    }

    .beads-table thead {
      position: sticky;
      top: 0;
      z-index: 1;
    }

    .beads-table th {
      background: rgba(15, 15, 35, 0.95);
      padding: 4px 6px;
      text-align: left;
      font-weight: 600;
      color: rgba(255, 255, 255, 0.4);
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      border-bottom: 1px solid rgba(255, 255, 255, 0.06);
    }

    .beads-table th:first-child { text-align: center; }

    .beads-row {
      transition: background 0.1s ease;
    }

    .beads-row:hover {
      background: rgba(255, 255, 255, 0.04);
    }

    .beads-table td {
      padding: 5px 6px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.03);
      color: #d4d4d4;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .beads-status-icon { font-size: 13px; }
    .beads-status-open { color: #4ec9b0; }
    .beads-status-progress { color: #a5b4fc; }
    .beads-status-closed { color: rgba(255, 255, 255, 0.3); }

    .beads-priority {
      font-size: 9px;
      font-weight: 700;
      padding: 1px 4px;
      border-radius: 3px;
    }

    .beads-p0 { color: #f87171; background: rgba(248, 113, 113, 0.15); }
    .beads-p1 { color: #fb923c; background: rgba(251, 146, 60, 0.15); }
    .beads-p2 { color: #fbbf24; background: rgba(251, 191, 36, 0.12); }
    .beads-p3 { color: rgba(255,255,255,0.45); background: rgba(255,255,255,0.06); }

    .beads-type {
      font-size: 9px;
      padding: 1px 5px;
      border-radius: 3px;
    }

    .beads-type-feature { color: #a5b4fc; background: rgba(99, 102, 241, 0.15); }
    .beads-type-bug { color: #f87171; background: rgba(239, 68, 68, 0.15); }
    .beads-type-task { color: #4ec9b0; background: rgba(78, 201, 176, 0.15); }

    .beads-id {
      color: rgba(255, 255, 255, 0.55);
      font-size: 11px;
      font-weight: 700;
    }

    .beads-title-text {
      color: #d4d4d4;
      font-size: 11px;
    }

    /* Beads pane when standalone */
    .beads-standalone {
      background: rgba(12, 12, 28, 0.95);
    }

    .beads-standalone > .pane-header {
      background: rgba(20, 20, 45, 0.9);
    }

    .beads-standalone > .pane-body {
      padding: 0;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    .pane-body:has(.beads-container) {
      padding: 0;
      white-space: normal;
      overflow: hidden;
      display: flex;
      flex-direction: column;
    }

    /* Git graph pane background (standalone) */
    #git-graph-pane {
      background: rgba(12, 12, 28, 0.95);
    }

    #git-graph-pane > .pane-header {
      background: rgba(20, 20, 45, 0.9);
    }

    #git-graph-pane > .pane-body {
      padding: 0;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
  </style>

  <script>
    const stage = document.getElementById('stage');
    let win1, win2, win3, win4, win5, win6, cursor;
    let tabHellPanes = [];
    let gitGraphPane, beadsPane;
    let terminal8, terminal9, terminal10, terminal11, terminal12;
    let terminal13, terminal14, terminal15;
    const allTerminals = [];

    // Uniform 20px gaps between all panes and edges.
    // Horizontal: 4 gaps (left edge, col1-col2, col2-col3, right edge) = 80px
    //   col1 = 30%, col2 = 24%, col3 = 46% of (100vw - 80px)
    // Vertical: 3 gaps for split columns (top, middle, bottom) = 60px
    //   Left split:  beads 28% / terminal1 72% of (100vh - 60px)
    //   Right split:  terminal2 52% / terminal3 48% of (100vh - 60px)
    //   Center (git graph): full height = 100vh - 40px (top + bottom gaps only)
    const CANVAS_LAYOUT = {
      gitGraph: {
        top:    '20px',
        left:   'calc(40px + (100vw - 80px) * 0.30)',
        width:  'calc((100vw - 80px) * 0.24)',
        height: 'calc(100vh - 40px)'
      },
      beads: {
        top:    '20px',
        left:   '20px',
        width:  'calc((100vw - 80px) * 0.30)',
        height: 'calc((100vh - 60px) * 0.28)'
      },
      terminal1: {
        top:    'calc(40px + (100vh - 60px) * 0.28)',
        left:   '20px',
        width:  'calc((100vw - 80px) * 0.30)',
        height: 'calc((100vh - 60px) * 0.72)'
      },
      terminal2: {
        top:    '20px',
        left:   'calc(60px + (100vw - 80px) * 0.54)',
        width:  'calc((100vw - 80px) * 0.46)',
        height: 'calc((100vh - 60px) * 0.52)'
      },
      terminal3: {
        top:    'calc(40px + (100vh - 60px) * 0.52)',
        left:   'calc(60px + (100vw - 80px) * 0.54)',
        width:  'calc((100vw - 80px) * 0.46)',
        height: 'calc((100vh - 60px) * 0.48)'
      },
    };

    const CANVAS_LAYOUT_ZOOMED = {
      // Existing elements keep SAME positions — CSS scale(0.65) shrinks them visually
      gitGraph:   CANVAS_LAYOUT.gitGraph,
      beads:      CANVAS_LAYOUT.beads,
      terminal1:  CANVAS_LAYOUT.terminal1,
      terminal2:  CANVAS_LAYOUT.terminal2,
      terminal3:  CANVAS_LAYOUT.terminal3,
      // Extended terminals — all 20px gaps from main canvas and each other.
      // Main canvas edges: left=20px, right=calc(100vw-20px), top=20px, bottom=calc(100vh-20px)
      // Left pair: right edge at 0px → 20px gap to col1 left (20px)
      terminal8:  { top: '20px',                                left: 'calc(-25vw)',          width: '25vw',                height: 'calc((100vh - 60px) * 0.50)' },
      terminal9:  { top: 'calc(40px + (100vh - 60px) * 0.50)', left: 'calc(-25vw)',          width: '25vw',                height: 'calc((100vh - 60px) * 0.50)' },
      // Right pair: left edge at 100vw → 20px gap to col3 right (100vw-20px)
      terminal10: { top: '20px',                                left: 'calc(100vw)',          width: '25vw',                height: 'calc((100vh - 60px) * 0.50)' },
      terminal11: { top: 'calc(40px + (100vh - 60px) * 0.50)', left: 'calc(100vw)',          width: '25vw',                height: 'calc((100vh - 60px) * 0.50)' },
      // Bottom row: top at 100vh → 20px gap below main canvas. Spans from -25vw to 125vw.
      // Each width = (150vw - 60px) / 4 = 37.5vw - 15px, with 20px gaps between.
      // Height fills to visible bottom: (100vh/0.65 - 100vh) = 700vh/13 ≈ 53.8vh, minus 20px pad.
      terminal12: { top: 'calc(100vh)',                         left: 'calc(-25vw)',          width: 'calc(37.5vw - 15px)', height: 'calc(700vh / 13 - 20px)' },
      terminal13: { top: 'calc(100vh)',                         left: 'calc(12.5vw + 5px)',   width: 'calc(37.5vw - 15px)', height: 'calc(700vh / 13 - 20px)' },
      terminal14: { top: 'calc(100vh)',                         left: 'calc(50vw + 10px)',    width: 'calc(37.5vw - 15px)', height: 'calc(700vh / 13 - 20px)' },
      terminal15: { top: 'calc(100vh)',                         left: 'calc(87.5vw + 15px)',  width: 'calc(37.5vw - 15px)', height: 'calc(700vh / 13 - 20px)' },
    };

    // Second zoom: scale(0.39) — visible area: ~-78vw..178vw horizontally, 0..256vh vertically
    // All 20px gaps are in px (not vw) relative to adjacent terminals.
    // Far-left col: right edge = -25vw - 20px, width = 25vw → left = calc(-50vw - 20px)
    // Far-right col: left edge = 125vw + 20px, width = 25vw
    // Bottom row 2: top = bottom of row 1 + 20px gap
    //   Spans full width from far-left col to far-right col.
    //   4 panes: width = (200vw + 40px - 60px) / 4 = calc(50vw - 5px)
    const CANVAS_LAYOUT_ZOOMED3 = {
      // Far-left pair — 20px gap to terminal8/9 (whose left edge is -25vw)
      terminal16: { top: '20px',                                left: 'calc(-50vw - 20px)',   width: '25vw',                height: 'calc((100vh - 60px) * 0.50)' },
      terminal17: { top: 'calc(40px + (100vh - 60px) * 0.50)', left: 'calc(-50vw - 20px)',   width: '25vw',                height: 'calc((100vh - 60px) * 0.50)' },
      // Far-right pair — 20px gap to terminal10/11 (whose right edge is 125vw)
      terminal18: { top: '20px',                                left: 'calc(125vw + 20px)',   width: '25vw',                height: 'calc((100vh - 60px) * 0.50)' },
      terminal19: { top: 'calc(40px + (100vh - 60px) * 0.50)', left: 'calc(125vw + 20px)',   width: '25vw',                height: 'calc((100vh - 60px) * 0.50)' },
      // Second bottom row — 20px below first bottom row (whose bottom = 100vh + 700vh/13 - 20px)
      terminal20: { top: 'calc(100vh + 700vh / 13)',            left: 'calc(-50vw - 20px)',   width: 'calc(50vw - 5px)',    height: 'calc(700vh / 13 - 20px)' },
      terminal21: { top: 'calc(100vh + 700vh / 13)',            left: '-5px',                 width: 'calc(50vw - 5px)',    height: 'calc(700vh / 13 - 20px)' },
      terminal22: { top: 'calc(100vh + 700vh / 13)',            left: 'calc(50vw + 10px)',    width: 'calc(50vw - 5px)',    height: 'calc(700vh / 13 - 20px)' },
      terminal23: { top: 'calc(100vh + 700vh / 13)',            left: 'calc(100vw + 25px)',   width: 'calc(50vw - 5px)',    height: 'calc(700vh / 13 - 20px)' },
    };

    const NEW_AGENT_NAMES = [
      'fix/auth-handler', 'feat/search-index', 'fix/memory-leak',
      'feat/webhook-delivery', 'fix/rate-limiter',
      'feat/dashboard-v2', 'fix/session-timeout', 'feat/export-csv'
    ];
    const WAVE2_AGENT_NAMES = [
      'feat/api-gateway', 'fix/cache-invalidation', 'feat/notifications',
      'fix/db-migration', 'feat/audit-log', 'fix/cors-policy',
      'feat/file-upload', 'feat/realtime-sync'
    ];
    const NEW_BEADS_ISSUES = [
      { id: 'g7n1', branch: 'search-index', text: 'feat: search indexing engine', color: '#a78bfa' },
      { id: 'h4p6', branch: 'memory-leak-fix', text: 'fix: memory leak on reconnect', color: '#f59e0b' },
      { id: 'j2r9', branch: 'webhook-delivery', text: 'feat: webhook delivery system', color: '#6366f1' },
    ];

    // --- Utilities ---

    let SPEED = 1; // global speed multiplier (set >1 to fast-forward)

    function setSpeed(s) {
      SPEED = s;
      if (cursor) {
        cursor.style.transition = 'left ' + (0.4 / s) + 's cubic-bezier(0.4,0,0.2,1), top ' + (0.4 / s) + 's cubic-bezier(0.4,0,0.2,1)';
      }
      // Speed up pane CSS transitions too
      document.querySelectorAll('.pane').forEach(p => {
        const dur = (1 / s) + 's';
          const ease = 'cubic-bezier(0.4, 0, 0.2, 1)';
          p.style.transition = 'left ' + dur + ' ' + ease + ', top ' + dur + ' ' + ease + ', width ' + dur + ' ' + ease + ', height ' + dur + ' ' + ease + ', opacity ' + dur + ' ' + ease + ', border-color ' + dur + ' ' + ease + ', transform ' + dur + ' ' + ease;
      });
    }

    // === GIT GRAPH ENGINE (multi-branch) ===
    const MAX_COLS = 6; // master + up to 5 branches
    const gitEngine = {
      branches: [{ name: 'master', color: '#85e89d', active: true }],
      output: null,
      _cs(c, ch) { return '<span style="color:' + c + ';font-size:14px">' + ch + '</span>'; },
      _hash() { return Math.random().toString(36).substring(2, 9); },

      attach(el) { this.output = el; },

      _renderCols(commitCol) {
        let html = '';
        for (let i = 0; i < MAX_COLS; i++) {
          const b = i < this.branches.length ? this.branches[i] : null;
          if (!b || !b.active) { html += '  '; continue; }
          if (i === commitCol) {
            html += this._cs(b.color, '\\u25CF') + ' ';
          } else {
            html += this._cs(b.color, '\\u2502') + ' ';
          }
        }
        return html;
      },

      _renderConnector(targetCol, type) {
        const endChar = type === 'merge' ? '\\u2510' : '\\u2518';
        const mColor = this.branches[0].color;
        const tColor = this.branches[targetCol].color;
        let html = '<span class="git-indicator"></span>';
        for (let i = 0; i < MAX_COLS; i++) {
          let main, filler;
          if (i === 0) {
            main = this._cs(mColor, '\\u251C');
            filler = this._cs(tColor, '\\u2500');
          } else if (i > 0 && i < targetCol) {
            const b = i < this.branches.length ? this.branches[i] : null;
            main = (b && b.active) ? this._cs(tColor, '\\u253C') : this._cs(tColor, '\\u2500');
            filler = this._cs(tColor, '\\u2500');
          } else if (i === targetCol) {
            main = this._cs(tColor, endChar);
            filler = ' ';
          } else {
            const b = i < this.branches.length ? this.branches[i] : null;
            main = (b && b.active) ? this._cs(b.color, '\\u2502') : ' ';
            filler = ' ';
          }
          html += main + filler;
        }
        return html;
      },

      _prepend(html) {
        if (!this.output) return;
        this.output.innerHTML = html + '\\n' + this.output.innerHTML;
        this.output.scrollTop = 0;
      },

      _moveMasterMarker() {
        if (!this.output) return;
        const old = this.output.querySelector('.git-master');
        if (old) {
          const spacer = document.createElement('span');
          spacer.className = 'git-indicator';
          old.replaceWith(spacer);
        }
      },

      commit(col, msg) {
        const b = this.branches[col];
        if (!b || !b.active) return;
        const hash = this._hash();
        const isMaster = col === 0;
        let indicator;
        if (isMaster) {
          this._moveMasterMarker();
          indicator = '<span class="git-indicator git-master" title="master"><svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor"><path d="M19.35 10.04A7.49 7.49 0 0 0 12 4C9.11 4 6.6 5.64 5.35 8.04A5.994 5.994 0 0 0 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96z"/></svg></span>';
        } else {
          indicator = '<span class="git-indicator"></span>';
        }
        let html = indicator + this._renderCols(col);
        html += this._cs(b.color, hash) + ' <span class="git-time">1m</span> ' + msg;
        this._prepend(html);
      },

      merge(col) {
        const b = this.branches[col];
        if (!b) return;
        const name = b.name;
        this.branches[col] = { name: name, color: b.color, active: false };
        // Connector line
        this._prepend(this._renderConnector(col, 'merge'));
        // Merge commit on master
        this._moveMasterMarker();
        const hash = this._hash();
        let html = '<span class="git-indicator git-master" title="master"><svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor"><path d="M19.35 10.04A7.49 7.49 0 0 0 12 4C9.11 4 6.6 5.64 5.35 8.04A5.994 5.994 0 0 0 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96z"/></svg></span>';
        html += this._renderCols(0);
        html += this._cs(this.branches[0].color, hash) + ' <span class="git-time">1m</span> Merge branch \\'' + name + '\\'';
        this._prepend(html);
      },

      newBranch(name, color) {
        let col = -1;
        for (let i = 1; i < this.branches.length; i++) {
          if (!this.branches[i] || !this.branches[i].active) { col = i; break; }
        }
        if (col === -1) { col = this.branches.length; }
        if (col >= MAX_COLS) return -1; // can't exceed max columns
        if (col >= this.branches.length) this.branches.length = col + 1;
        this.branches[col] = { name: name, color: color, active: true };
        this._prepend(this._renderConnector(col, 'branch'));
        return col;
      },

      getCol(name) {
        return this.branches.findIndex(function(b) { return b && b.name === name; });
      }
    };

    // Periodic git commits (pre-engine, used before branches exist)
    let gitCommitInterval = null;
    function startGitCommits(delay) {
      const msgs = ['fix: typo in config', 'chore: update deps', 'test: add coverage', 'refactor: extract utils', 'feat: add logging', 'fix: null check', 'docs: update API spec', 'chore: lint fixes'];
      gitCommitInterval = setInterval(() => {
        if (!gitEngine.output) return;
        const activeBranches = gitEngine.branches.filter(function(b, i) { return i > 0 && b && b.active; });
        if (activeBranches.length > 0) {
          // Commit on a random active branch
          const pick = activeBranches[Math.floor(Math.random() * activeBranches.length)];
          const col = gitEngine.getCol(pick.name);
          gitEngine.commit(col, msgs[Math.floor(Math.random() * msgs.length)]);
        } else {
          gitEngine.commit(0, msgs[Math.floor(Math.random() * msgs.length)]);
        }
      }, delay / SPEED);
    }
    function stopGitCommits() {
      if (gitCommitInterval) { clearInterval(gitCommitInterval); gitCommitInterval = null; }
    }

    // Rapid-fire git history (post-zoom)
    let rapidGitTimer = null;
    function startRapidGitHistory() {
      const branchPool = ['feat/cache-layer', 'fix/race-condition', 'feat/notifications', 'fix/timeout-bug', 'feat/batch-jobs', 'feat/audit-log', 'fix/deadlock', 'feat/export-pdf'];
      const colorPool = ['#79b8ff', '#a78bfa', '#f59e0b', '#10b981', '#ef4444'];
      const msgPool = ['fix: typo in config', 'feat: add endpoint', 'test: add unit tests', 'refactor: extract helper', 'fix: null check', 'chore: update deps', 'feat: add validation', 'fix: race condition', 'docs: update readme', 'test: integration suite', 'feat: add caching', 'fix: memory leak'];
      let branchIdx = 0;

      function tick() {
        if (!gitEngine.output) return;
        const active = gitEngine.branches.filter(function(b, i) { return i > 0 && b && b.active; });
        const r = Math.random();

        if (active.length < 2 || (active.length < (MAX_COLS - 1) && r < 0.2)) {
          // Create new branch
          const name = branchPool[branchIdx++ % branchPool.length];
          const color = colorPool[Math.floor(Math.random() * colorPool.length)];
          gitEngine.newBranch(name, color);
        } else if (r < 0.18 && active.length > 0) {
          // Merge random branch (only branches from pool, not terminal-assigned)
          const mergeable = active.filter(function(b) { return branchPool.indexOf(b.name) >= 0; });
          if (mergeable.length > 0) {
            const pick = mergeable[Math.floor(Math.random() * mergeable.length)];
            gitEngine.merge(gitEngine.getCol(pick.name));
          }
        } else if (r < 0.35) {
          // Commit on master
          gitEngine.commit(0, msgPool[Math.floor(Math.random() * msgPool.length)]);
        } else {
          // Commit on random branch
          const pick = active[Math.floor(Math.random() * active.length)];
          gitEngine.commit(gitEngine.getCol(pick.name), msgPool[Math.floor(Math.random() * msgPool.length)]);
        }

        const delay = 50 + Math.random() * 100;
        rapidGitTimer = setTimeout(tick, delay);
      }
      tick();
    }
    function stopRapidGitHistory() {
      if (rapidGitTimer) { clearTimeout(rapidGitTimer); rapidGitTimer = null; }
    }

    function wait(ms) {
      return new Promise(resolve => setTimeout(resolve, ms / SPEED));
    }

    function typeText(el, text, charDelay = 60) {
      return new Promise(resolve => {
        let i = 0;
        function next() {
          if (i < text.length) {
            el.textContent += text[i];
            i++;
            setTimeout(next, (charDelay + (Math.random() - 0.5) * 30) / SPEED);
          } else {
            resolve();
          }
        }
        next();
      });
    }

    function addLines(el, lines, lineDelay = 100) {
      return new Promise(resolve => {
        let i = 0;
        function next() {
          if (i < lines.length) {
            el.textContent += (el.textContent ? '\\n' : '') + lines[i];
            i++;
            setTimeout(next, lineDelay / SPEED);
          } else {
            resolve();
          }
        }
        next();
      });
    }

    function moveCursor(cursorEl, targetEl, duration = 400) {
      return new Promise(resolve => {
        const rect = targetEl.getBoundingClientRect();
        const ox = rect.width * (0.25 + Math.random() * 0.2);
        const oy = rect.height * (0.3 + Math.random() * 0.2);
        const d = duration / SPEED;
        cursorEl.style.transitionDuration = d + 'ms';
        cursorEl.style.left = (rect.left + ox) + 'px';
        cursorEl.style.top = (rect.top + oy) + 'px';
        setTimeout(resolve, d);
      });
    }

    // === NARRATION ENGINE — sentence-by-sentence, runs in parallel ===
    var _narrContainer = null;
    var _narrSentenceEl = null;
    var _narrTimer = null;

    function initNarration() {
      _narrContainer = document.createElement('div');
      _narrContainer.className = 'narration-container';
      _narrSentenceEl = document.createElement('div');
      _narrSentenceEl.className = 'narration-sentence';
      _narrContainer.appendChild(_narrSentenceEl);
      document.body.appendChild(_narrContainer);
    }

    function runNarration(sentences, durationMs, timings) {
      stopNarration();
      if (!sentences || sentences.length === 0) return;
      var defaultTime = durationMs / sentences.length;
      var idx = 0;
      function showNext() {
        if (idx >= sentences.length) return;
        _narrSentenceEl.classList.remove('active');
        setTimeout(function() {
          // Split sentence into words, preserving inline HTML (SVG, etc.) as single tokens
          var text = sentences[idx];
          var htmlChunks = [];
          // Replace HTML blocks with placeholders
          var stripped = text.replace(/<svg[\\s\\S]*?<\\/svg>|<[a-z][^>]*>[\\s\\S]*?<\\/[a-z]+>|<[a-z][^>]*\\/?>/gi, function(m) {
            htmlChunks.push(m);
            return '\\x00HTML' + (htmlChunks.length - 1) + '\\x00';
          });
          var words = stripped.split(/(\\s+)/);
          var html = '';
          words.forEach(function(w) {
            if (/^\\s+$/.test(w) || w === '') {
              html += w;
            } else {
              // Restore any HTML placeholders
              var restored = w.replace(/\\x00HTML(\\d+)\\x00/g, function(_, i) { return htmlChunks[+i]; });
              html += '<span class="narr-word" style="opacity:0;display:inline;transition:opacity 0.15s ease">' + restored + '</span>';
            }
          });
          _narrSentenceEl.innerHTML = html;
          _narrSentenceEl.offsetHeight;
          _narrSentenceEl.classList.add('active');

          // Reveal words one by one
          var wordEls = _narrSentenceEl.querySelectorAll('.narr-word');
          var dur = (timings && timings[idx] != null) ? timings[idx] : defaultTime;
          var wordCount = wordEls.length;
          // Use first 40% of duration for word reveal, rest for reading
          var revealTime = Math.min(dur * 0.4, wordCount * 120);
          var wordDelay = wordCount > 1 ? revealTime / (wordCount - 1) : 0;
          wordEls.forEach(function(el, i) {
            setTimeout(function() { el.style.opacity = '1'; }, i * wordDelay);
          });

          idx++;
          if (idx < sentences.length) {
            _narrTimer = setTimeout(showNext, dur);
          }
        }, 400);
      }
      showNext();
    }

    function stopNarration() {
      if (_narrTimer) { clearTimeout(_narrTimer); _narrTimer = null; }
      if (_narrSentenceEl) {
        _narrSentenceEl.classList.remove('active');
      }
    }

    function setNarrationPos(pos) {
      if (_narrContainer) {
        _narrContainer.className = 'narration-container' + (pos === 'above' ? ' narr-above' : '');
      }
    }

    // Creates a pane DOM element
    // config: { title, tabs: [{label, content, active?}], class?, id?, style? }
    function createPane(config) {
      const pane = document.createElement('div');
      pane.className = 'pane' + (config.class ? ' ' + config.class : '');
      if (config.id) pane.id = config.id;
      if (config.style) Object.assign(pane.style, config.style);

      // Header
      const header = document.createElement('div');
      header.className = 'pane-header';
      header.innerHTML = \`
        <span class="dot red"></span>
        <span class="dot yellow"></span>
        <span class="dot green"></span>
        <span class="pane-title">\${config.title || ''}</span>
      \`;
      pane.appendChild(header);

      // Tabs (if any)
      let tabBar = null;
      if (config.tabs && config.tabs.length > 0) {
        tabBar = document.createElement('div');
        tabBar.className = 'pane-tabs';
        config.tabs.forEach((tab, i) => {
          const tabEl = document.createElement('div');
          tabEl.className = 'tab' + (tab.active ? ' active' : '');
          tabEl.innerHTML = tab.label;
          tabEl.dataset.index = i;
          tabBar.appendChild(tabEl);
        });
        // Add "+" button at the end
        const plusBtn = document.createElement('div');
        plusBtn.className = 'tab-plus';
        plusBtn.textContent = '+';
        tabBar.appendChild(plusBtn);
        pane.appendChild(tabBar);
      }

      // Body
      const body = document.createElement('div');
      body.className = 'pane-body';
      const activeTab = config.tabs?.find(t => t.active) || config.tabs?.[0];
      if (activeTab?.content) {
        body.innerHTML = activeTab.content;
      }
      pane.appendChild(body);

      // Store tab contents for switching
      pane._tabs = config.tabs || [];
      pane._body = body;
      pane._tabBar = tabBar;

      return pane;
    }

    // Switch a pane to a different tab by index
    function switchTab(pane, tabIndex) {
      const tabs = pane._tabBar?.querySelectorAll('.tab');
      if (tabs) {
        tabs.forEach((t, i) => t.classList.toggle('active', i === tabIndex));
      }
      const tab = pane._tabs[tabIndex];
      if (tab && pane._body) {
        pane._body.innerHTML = tab.content || '';
      }
    }

    // Dynamically add a new tab to a pane and switch to it
    function addTab(pane, label, content) {
      const tabIndex = pane._tabs.length;
      pane._tabs.push({ label, content });
      if (pane._tabBar) {
        const tabEl = document.createElement('div');
        tabEl.className = 'tab';
        tabEl.innerHTML = label;
        tabEl.dataset.index = tabIndex;
        // Insert before the "+" button
        const plusBtn = pane._tabBar.querySelector('.tab-plus');
        if (plusBtn) {
          pane._tabBar.insertBefore(tabEl, plusBtn);
        } else {
          pane._tabBar.appendChild(tabEl);
        }
        // Animate tab appearance
        tabEl.style.opacity = '0';
        tabEl.style.transform = 'scale(0.8)';
        tabEl.style.transition = 'all 0.25s ease';
        requestAnimationFrame(() => {
          tabEl.style.opacity = '1';
          tabEl.style.transform = 'scale(1)';
        });
      }
      switchTab(pane, tabIndex);
      return tabIndex;
    }

    // --- Phase stubs (to be filled in subsequent tasks) ---

    // Claude Code live output simulator — streams lines into a pane body
    function startClaudeOutput(pane, lines, lineDelay) {
      let idx = 0;
      const delay = lineDelay || 600;
      const interval = setInterval(() => {
        if (!pane._body) { clearInterval(interval); return; }
        const line = lines[idx % lines.length];
        pane._body.innerHTML += (pane._body.innerHTML ? '<br>' : '') + line;
        // Keep only last ~40 lines
        const existing = pane._body.innerHTML.split('<br>');
        if (existing.length > 40) {
          pane._body.innerHTML = existing.slice(-40).join('<br>');
        }
        pane._body.scrollTop = pane._body.scrollHeight;
        idx++;
      }, delay + Math.random() * 200);
      pane._outputInterval = interval;
      return interval;
    }

    function stopClaudeOutput(pane) {
      if (pane._outputInterval) {
        clearInterval(pane._outputInterval);
        pane._outputInterval = null;
      }
    }

    // Claude Code output line pools for Phase 1 — realistic live output
    const CC_OUTPUTS = {
      fixAuth: [
        '<span style="color:#e87b35">\\u2733</span> <span style="color:rgba(255,255,255,0.5)">Reading src/middleware/auth.js...</span>',
        '<span style="color:#e87b35">\\u2736</span> <span style="color:rgba(255,255,255,0.5)">Analyzing token validation flow...</span>',
        '  <span style="color:rgba(255,255,255,0.35)">\\u23BF  Read</span> <span style="color:#79b8ff">src/middleware/auth.js</span>',
        '  <span style="color:rgba(255,255,255,0.35)">\\u23BF  Read</span> <span style="color:#79b8ff">src/routes/api.js</span>',
        '<span style="color:#e87b35">\\u2733</span> <span style="color:rgba(255,255,255,0.5)">Found missing expiry check...</span>',
        '  <span style="color:rgba(255,255,255,0.35)">\\u23BF  Edit</span> <span style="color:#79b8ff">src/middleware/auth.js</span>',
        '    <span style="color:#ff5f57;background:rgba(255,95,87,0.12)">- req.user = decoded;</span>',
        '    <span style="color:#28c840;background:rgba(40,200,64,0.12)">+ if (decoded.exp < Date.now() / 1000) {</span>',
        '    <span style="color:#28c840;background:rgba(40,200,64,0.12)">+   return res.status(401).json({ error: \\'Token expired\\' });</span>',
        '    <span style="color:#28c840;background:rgba(40,200,64,0.12)">+ }</span>',
        '<span style="color:#e87b35">\\u2736</span> <span style="color:rgba(255,255,255,0.5)">Running tests to verify fix...</span>',
        '  <span style="color:rgba(255,255,255,0.35)">\\u23BF  Bash</span> <span style="color:rgba(255,255,255,0.5)">npx jest auth.test.js</span>',
        '  <span style="color:#28c840">PASS</span>  src/middleware/auth.test.js (0.8s)',
      ],
      addTests: [
        '<span style="color:#e87b35">\\u2733</span> <span style="color:rgba(255,255,255,0.5)">Analyzing test coverage gaps...</span>',
        '  <span style="color:rgba(255,255,255,0.35)">\\u23BF  Read</span> <span style="color:#79b8ff">src/middleware/auth.js</span>',
        '<span style="color:#e87b35">\\u2736</span> <span style="color:rgba(255,255,255,0.5)">Writing test cases...</span>',
        '  <span style="color:rgba(255,255,255,0.35)">\\u23BF  Write</span> <span style="color:#79b8ff">src/middleware/auth.test.js</span>',
        '<span style="color:#e87b35">\\u2733</span> <span style="color:rgba(255,255,255,0.5)">Running test suite...</span>',
        '  <span style="color:rgba(255,255,255,0.35)">\\u23BF  Bash</span> <span style="color:rgba(255,255,255,0.5)">npx jest auth.test.js</span>',
        '    \\u2713 authenticates valid token (12ms)',
        '    \\u2713 rejects invalid token (3ms)',
        '    <span style="color:#28c840">\\u2713 rejects expired token (5ms)</span>',
        '    \\u2713 handles missing token (2ms)',
        '  Tests: <span style="color:#28c840">4 passed</span>, 4 total',
      ],
      refactor: [
        '<span style="color:#e87b35">\\u2736</span> <span style="color:rgba(255,255,255,0.5)">Scanning route files for callbacks...</span>',
        '  <span style="color:rgba(255,255,255,0.35)">\\u23BF  Read</span> <span style="color:#79b8ff">src/routes/users.js</span>',
        '  <span style="color:rgba(255,255,255,0.35)">\\u23BF  Read</span> <span style="color:#79b8ff">src/routes/posts.js</span>',
        '<span style="color:#e87b35">\\u2733</span> <span style="color:rgba(255,255,255,0.5)">Converting to async/await...</span>',
        '  <span style="color:rgba(255,255,255,0.35)">\\u23BF  Edit</span> <span style="color:#79b8ff">src/routes/users.js</span>',
        '    <span style="color:#ff5f57;background:rgba(255,95,87,0.12)">- router.get(\\'/\\', function(req, res) {</span>',
        '    <span style="color:#28c840;background:rgba(40,200,64,0.12)">+ router.get(\\'/\\', async (req, res) => {</span>',
        '<span style="color:#e87b35">\\u2736</span> <span style="color:rgba(255,255,255,0.5)">Verifying refactor...</span>',
        '  <span style="color:rgba(255,255,255,0.35)">\\u23BF  Bash</span> <span style="color:rgba(255,255,255,0.5)">npx jest --testPathPattern routes</span>',
        '  Tests: <span style="color:#28c840">8 passed</span>, 8 total',
      ],
      deploy: [
        '<span style="color:#e87b35">\\u2733</span> <span style="color:rgba(255,255,255,0.5)">Preparing deployment...</span>',
        '  <span style="color:rgba(255,255,255,0.35)">\\u23BF  Bash</span> <span style="color:rgba(255,255,255,0.5)">docker build -t app:latest .</span>',
        '  Step 1/6: FROM node:18-alpine',
        '  Step 2/6: WORKDIR /app',
        '  Step 3/6: COPY package*.json ./',
        '  Step 4/6: RUN npm ci --production',
        '<span style="color:#e87b35">\\u2736</span> <span style="color:rgba(255,255,255,0.5)">Pushing image to registry...</span>',
        '  <span style="color:#28c840">\\u2713</span> Built app:latest (128MB)',
        '  <span style="color:rgba(255,255,255,0.35)">\\u23BF  Bash</span> <span style="color:rgba(255,255,255,0.5)">kubectl rollout status deploy/app</span>',
        '  <span style="color:#febc2e">\\u280b</span> Waiting for rollout to finish...',
      ],
      migrateDb: [
        '<span style="color:#e87b35">\\u2736</span> <span style="color:rgba(255,255,255,0.5)">Analyzing database schema...</span>',
        '  <span style="color:rgba(255,255,255,0.35)">\\u23BF  Read</span> <span style="color:#79b8ff">migrations/</span>',
        '<span style="color:#e87b35">\\u2733</span> <span style="color:rgba(255,255,255,0.5)">Generating migration file...</span>',
        '  <span style="color:rgba(255,255,255,0.35)">\\u23BF  Write</span> <span style="color:#79b8ff">migrations/003_add_roles.sql</span>',
        '    <span style="color:#28c840;background:rgba(40,200,64,0.12)">+ ALTER TABLE users ADD COLUMN role VARCHAR(20);</span>',
        '    <span style="color:#28c840;background:rgba(40,200,64,0.12)">+ CREATE INDEX idx_users_role ON users(role);</span>',
        '  <span style="color:rgba(255,255,255,0.35)">\\u23BF  Bash</span> <span style="color:rgba(255,255,255,0.5)">psql -f migrations/003_add_roles.sql</span>',
        '  ALTER TABLE',
        '  CREATE INDEX',
        '  UPDATE 847',
        '<span style="color:#e87b35">\\u2736</span> <span style="color:rgba(255,255,255,0.5)">Migration applied successfully.</span>',
      ],
      security: [
        '<span style="color:#e87b35">\\u2733</span> <span style="color:rgba(255,255,255,0.5)">Scanning for vulnerabilities...</span>',
        '  <span style="color:rgba(255,255,255,0.35)">\\u23BF  Bash</span> <span style="color:rgba(255,255,255,0.5)">npm audit</span>',
        '  found <span style="color:#ff5f57">2 vulnerabilities</span> (1 moderate, 1 high)',
        '<span style="color:#e87b35">\\u2736</span> <span style="color:rgba(255,255,255,0.5)">Investigating upload handler...</span>',
        '  <span style="color:rgba(255,255,255,0.35)">\\u23BF  Read</span> <span style="color:#79b8ff">src/api/upload.js</span>',
        '<span style="color:#e87b35">\\u2733</span> <span style="color:rgba(255,255,255,0.5)">Found path traversal risk. Patching...</span>',
        '  <span style="color:rgba(255,255,255,0.35)">\\u23BF  Edit</span> <span style="color:#79b8ff">src/api/upload.js</span>',
        '    <span style="color:#ff5f57;background:rgba(255,95,87,0.12)">- const dest = path.join(uploadDir, filename);</span>',
        '    <span style="color:#28c840;background:rgba(40,200,64,0.12)">+ const safe = path.basename(filename);</span>',
        '    <span style="color:#28c840;background:rgba(40,200,64,0.12)">+ const dest = path.join(uploadDir, safe);</span>',
      ],
      docs: [
        '<span style="color:#e87b35">\\u2736</span> <span style="color:rgba(255,255,255,0.5)">Reading API route definitions...</span>',
        '  <span style="color:rgba(255,255,255,0.35)">\\u23BF  Read</span> <span style="color:#79b8ff">src/routes/users.js</span>',
        '  <span style="color:rgba(255,255,255,0.35)">\\u23BF  Read</span> <span style="color:#79b8ff">src/routes/posts.js</span>',
        '  <span style="color:rgba(255,255,255,0.35)">\\u23BF  Read</span> <span style="color:#79b8ff">src/routes/auth.js</span>',
        '<span style="color:#e87b35">\\u2733</span> <span style="color:rgba(255,255,255,0.5)">Generating documentation...</span>',
        '  <span style="color:rgba(255,255,255,0.35)">\\u23BF  Write</span> <span style="color:#79b8ff">docs/api.md</span>',
        '  Documenting GET /api/users...',
        '  Documenting POST /api/auth...',
        '  Coverage: <span style="color:#28c840">12/12 endpoints</span>',
      ],
      optimize: [
        '<span style="color:#e87b35">\\u2733</span> <span style="color:rgba(255,255,255,0.5)">Profiling database queries...</span>',
        '  <span style="color:rgba(255,255,255,0.35)">\\u23BF  Bash</span> <span style="color:rgba(255,255,255,0.5)">psql -c "EXPLAIN ANALYZE SELECT..."</span>',
        '  Seq Scan on users  (cost=0.00..18.50)',
        '  Execution Time: <span style="color:#ff5f57">245.3ms</span>',
        '<span style="color:#e87b35">\\u2736</span> <span style="color:rgba(255,255,255,0.5)">Adding missing indexes...</span>',
        '  <span style="color:rgba(255,255,255,0.35)">\\u23BF  Edit</span> <span style="color:#79b8ff">migrations/004_add_indexes.sql</span>',
        '    <span style="color:#28c840;background:rgba(40,200,64,0.12)">+ CREATE INDEX idx_users_created ON users(created_at);</span>',
        '  Execution Time: <span style="color:#28c840">2.1ms</span> (117x faster)',
      ],
      cicd: [
        '<span style="color:#e87b35">\\u2736</span> <span style="color:rgba(255,255,255,0.5)">Setting up CI/CD pipeline...</span>',
        '  <span style="color:rgba(255,255,255,0.35)">\\u23BF  Write</span> <span style="color:#79b8ff">.github/workflows/ci.yml</span>',
        '    <span style="color:#28c840;background:rgba(40,200,64,0.12)">+ name: CI</span>',
        '    <span style="color:#28c840;background:rgba(40,200,64,0.12)">+ on: [push, pull_request]</span>',
        '    <span style="color:#28c840;background:rgba(40,200,64,0.12)">+ jobs:</span>',
        '    <span style="color:#28c840;background:rgba(40,200,64,0.12)">+   test:</span>',
        '    <span style="color:#28c840;background:rgba(40,200,64,0.12)">+     runs-on: ubuntu-latest</span>',
        '<span style="color:#e87b35">\\u2733</span> <span style="color:rgba(255,255,255,0.5)">Committing workflow...</span>',
        '  <span style="color:rgba(255,255,255,0.35)">\\u23BF  Bash</span> <span style="color:rgba(255,255,255,0.5)">git add . && git commit</span>',
        '  <span style="color:#28c840">[main a91c4e2] ci: add pipeline</span>',
      ],
    };

    async function phase1Clutter() {
      // Claude Code tab label with actual Claude logo
      const claudeLogo = '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" fill="#e87b35" viewBox="0 0 16 16" style="vertical-align:-1px;margin-right:4px"><path d="m3.127 10.604 3.135-1.76.053-.153-.053-.085H6.11l-.525-.032-1.791-.048-1.554-.065-1.505-.08-.38-.081L0 7.832l.036-.234.32-.214.455.04 1.009.069 1.513.105 1.097.064 1.626.17h.259l.036-.105-.089-.065-.068-.064-1.566-1.062-1.695-1.121-.887-.646-.48-.327-.243-.306-.104-.67.435-.48.585.04.15.04.593.456 1.267.981 1.654 1.218.242.202.097-.068.012-.049-.109-.181-.9-1.626-.96-1.655-.428-.686-.113-.411a2 2 0 0 1-.068-.484l.496-.674L4.446 0l.662.089.279.242.411.94.666 1.48 1.033 2.014.302.597.162.553.06.17h.105v-.097l.085-1.134.157-1.392.154-1.792.052-.504.25-.605.497-.327.387.186.319.456-.045.294-.19 1.23-.37 1.93-.243 1.29h.142l.161-.16.654-.868 1.097-1.372.484-.545.565-.601.363-.287h.686l.505.751-.226.775-.707.895-.585.759-.839 1.13-.524.904.048.072.125-.012 1.897-.403 1.024-.186 1.223-.21.553.258.06.263-.218.536-1.307.323-1.533.307-2.284.54-.028.02.032.04 1.029.098.44.024h1.077l2.005.15.525.346.315.424-.053.323-.807.411-3.631-.863-.872-.218h-.12v.073l.726.71 1.331 1.202 1.667 1.55.084.383-.214.302-.226-.032-1.464-1.101-.565-.497-1.28-1.077h-.084v.113l.295.432 1.557 2.34.08.718-.112.234-.404.141-.444-.08-.911-1.28-.94-1.44-.759-1.291-.093.053-.448 4.821-.21.246-.484.186-.403-.307-.214-.496.214-.98.258-1.28.21-1.016.19-1.263.112-.42-.008-.028-.092.012-.953 1.307-1.448 1.957-1.146 1.227-.274.109-.477-.247.045-.44.266-.39 1.586-2.018.956-1.25.617-.723-.004-.105h-.036l-4.212 2.736-.75.096-.324-.302.04-.496.154-.162 1.267-.871z"/></svg>';
      const ccTab = () => claudeLogo + 'Claude Code';

      // Beads issues content — simplified table matching app structure
      const beadsContent = '<div class="beads-container">' +
        '<div class="beads-header">' +
          '<div class="beads-counts">' +
            '<span class="beads-badge beads-badge-open">open 3</span>' +
            '<span class="beads-badge beads-badge-progress">in progress 2</span>' +
          '</div>' +
        '</div>' +
        '<div class="beads-table-wrap">' +
          '<table class="beads-table">' +
            '<colgroup><col style="width:24px"><col style="width:42px"><col style="width:48px"><col></colgroup>' +
            '<thead><tr>' +
              '<th style="text-align:center"></th>' +
              '<th>P</th>' +
              '<th>Type</th>' +
              '<th>Title</th>' +
            '</tr></thead>' +
            '<tbody>' +
              '<tr class="beads-row" data-issue-idx="0"><td style="text-align:center"><span class="beads-status-icon beads-status-progress">\\u25D0</span></td><td><span class="beads-priority beads-p1">P1</span></td><td><span class="beads-type beads-type-feature">feature</span></td><td><span class="beads-title-text">add folder pane git tracking</span></td></tr>' +
              '<tr class="beads-row" data-issue-idx="1"><td style="text-align:center"><span class="beads-status-icon beads-status-progress">\\u25D0</span></td><td><span class="beads-priority beads-p0">P0</span></td><td><span class="beads-type beads-type-bug">bug</span></td><td><span class="beads-title-text">terminal reconnect blank screen</span></td></tr>' +
              '<tr class="beads-row" data-issue-idx="2"><td style="text-align:center"><span class="beads-status-icon beads-status-open">\\u25CB</span></td><td><span class="beads-priority beads-p2">P2</span></td><td><span class="beads-type beads-type-feature">feature</span></td><td><span class="beads-title-text">keyboard navigation for modals</span></td></tr>' +
              '<tr class="beads-row" data-issue-idx="3"><td style="text-align:center"><span class="beads-status-icon beads-status-open">\\u25CB</span></td><td><span class="beads-priority beads-p2">P2</span></td><td><span class="beads-type beads-type-feature">feature</span></td><td><span class="beads-title-text">move mode WASD navigation</span></td></tr>' +
              '<tr class="beads-row" data-issue-idx="4"><td style="text-align:center"><span class="beads-status-icon beads-status-open">\\u25CB</span></td><td><span class="beads-priority beads-p1">P1</span></td><td><span class="beads-type beads-type-bug">bug</span></td><td><span class="beads-title-text">clipboard paste not working</span></td></tr>' +
            '</tbody>' +
          '</table>' +
        '</div>' +
      '</div>';

      // Git graph content — engine will populate this dynamically
      const gitGraphContent = '<div id="git-graph" class="git-graph-container">' +
        '<div class="git-graph-header">' +
          '<span class="git-graph-branch"><span class="git-graph-branch-name">master</span></span>' +
          '<span class="git-graph-status"><span class="git-graph-clean">\\u25CF clean</span></span>' +
          '<button class="git-graph-push-btn">\\u2191 Push</button>' +
        '</div>' +
        '<pre class="git-graph-output"></pre>' +
      '</div>';

      // --- Create all panes (keep tab content for switchTab, clear body for reveal) ---

      // --- Window 1: Claude Code (2 tabs) — top left ---
      win1 = createPane({
        title: 'Claude Code',
        tabs: [
          { label: ccTab(), active: true, content: '<span style="color:#6366f1">\\u276f</span> <span style="color:rgba(255,255,255,0.9)">fix auth token expiry bug</span><br><br><span style="color:#e87b35">\\u2733</span> <span style="color:rgba(255,255,255,0.5)">Reading src/middleware/auth.js...</span><br>  <span style="color:rgba(255,255,255,0.35)">\\u23BF  Read</span> <span style="color:#79b8ff">src/middleware/auth.js</span><br>  <span style="color:rgba(255,255,255,0.35)">\\u23BF  Read</span> <span style="color:#79b8ff">src/routes/api.js</span><br><br><span style="color:#e87b35">\\u2736</span> <span style="color:rgba(255,255,255,0.5)">Found the issue. The token expiry isn\\'t being checked.</span><br><br>  <span style="color:rgba(255,255,255,0.35)">\\u23BF  Edit</span> <span style="color:#79b8ff">src/middleware/auth.js</span><br>    <span style="color:#ff5f57;background:rgba(255,95,87,0.12)">- const user = jwt.verify(token, SECRET);</span><br>    <span style="color:#28c840;background:rgba(40,200,64,0.12)">+ const user = jwt.verify(token, SECRET, { maxAge: \\'7d\\' });</span>' },
          { label: ccTab(), content: '<span style="color:#6366f1">\\u276f</span> <span style="color:rgba(255,255,255,0.9)">write tests for the auth middleware changes</span>' }
        ],
        style: {
          width: '44vw',
          height: '42vh',
          top: '2%',
          left: '2%',
          zIndex: 3
        }
      });

      // --- Window 2: Claude Code (2 tabs) — middle overlapping ---
      win2 = createPane({
        title: 'Claude Code',
        tabs: [
          { label: ccTab(), active: true, content: '<span style="color:#6366f1">\\u276f</span> <span style="color:rgba(255,255,255,0.9)">deploy latest to staging</span><br><br><span style="color:#e87b35">\\u2733</span> <span style="color:rgba(255,255,255,0.5)">Preparing deployment...</span><br>  <span style="color:rgba(255,255,255,0.35)">\\u23BF  Bash</span> <span style="color:rgba(255,255,255,0.5)">docker build -t app:latest .</span><br>  Step 1/6: FROM node:18-alpine<br>  Step 2/6: WORKDIR /app<br>  Step 3/6: COPY package*.json ./<br>  Step 4/6: RUN npm ci --production<br>  <span style="color:#28c840">\\u2713</span> Built app:latest (128MB)<br><br>  <span style="color:rgba(255,255,255,0.35)">\\u23BF  Bash</span> <span style="color:rgba(255,255,255,0.5)">kubectl rollout status deploy/app</span><br>  <span style="color:#febc2e">\\u280b</span> Waiting for rollout to finish...' },
          { label: ccTab(), content: '' }
        ],
        style: {
          width: '44vw',
          height: '42vh',
          top: '18%',
          left: '14%',
          zIndex: 2
        }
      });

      // --- Window 3: Claude Code (2 tabs) — bottom left ---
      win3 = createPane({
        title: 'Claude Code',
        tabs: [
          { label: ccTab(), active: true, content: '<span style="color:#6366f1">\\u276f</span> <span style="color:rgba(255,255,255,0.9)">run security audit on codebase</span><br><br><span style="color:#e87b35">\\u2736</span> <span style="color:rgba(255,255,255,0.5)">Scanning for vulnerabilities...</span><br>  <span style="color:rgba(255,255,255,0.35)">\\u23BF  Bash</span> <span style="color:rgba(255,255,255,0.5)">npm audit</span><br>  found <span style="color:#ff5f57">2 vulnerabilities</span> (1 moderate, 1 high)<br><br>  <span style="color:rgba(255,255,255,0.35)">\\u23BF  Read</span> <span style="color:#79b8ff">src/api/upload.js</span><br><span style="color:#e87b35">\\u2733</span> <span style="color:rgba(255,255,255,0.5)">Found path traversal risk in upload handler.</span><br><br>  <span style="color:rgba(255,255,255,0.35)">\\u23BF  Edit</span> <span style="color:#79b8ff">src/api/upload.js</span><br>    <span style="color:#ff5f57;background:rgba(255,95,87,0.12)">- const dest = path.join(uploadDir, filename);</span><br>    <span style="color:#28c840;background:rgba(40,200,64,0.12)">+ const safe = path.basename(filename);</span><br>    <span style="color:#28c840;background:rgba(40,200,64,0.12)">+ const dest = path.join(uploadDir, safe);</span>' },
          { label: ccTab(), content: '<span style="color:#6366f1">\\u276f</span> <span style="color:rgba(255,255,255,0.9)">generate API documentation from route files</span>' }
        ],
        style: {
          width: '42vw',
          height: '40vh',
          top: '36%',
          left: '6%',
          zIndex: 1
        }
      });

      // --- Window 4: Claude Code (2 tabs) — right side overlapping ---
      win4 = createPane({
        title: 'Claude Code',
        tabs: [
          { label: ccTab(), active: true, content: '<span style="color:#6366f1">\\u276f</span> <span style="color:rgba(255,255,255,0.9)">optimize slow dashboard queries</span><br><br><span style="color:#e87b35">\\u2733</span> <span style="color:rgba(255,255,255,0.5)">Profiling database queries...</span><br>  <span style="color:rgba(255,255,255,0.35)">\\u23BF  Bash</span> <span style="color:rgba(255,255,255,0.5)">psql -c "EXPLAIN ANALYZE SELECT..."</span><br>  Seq Scan on users  (cost=0.00..18.50)<br>  Planning Time: 0.1ms<br>  Execution Time: <span style="color:#ff5f57">245.3ms</span><br><br><span style="color:#e87b35">\\u2736</span> <span style="color:rgba(255,255,255,0.5)">Query is slow due to missing index. Adding one now.</span><br><br>  <span style="color:rgba(255,255,255,0.35)">\\u23BF  Edit</span> <span style="color:#79b8ff">migrations/004_add_indexes.sql</span><br>    <span style="color:#28c840;background:rgba(40,200,64,0.12)">+ CREATE INDEX idx_users_created ON users(created_at);</span><br>    <span style="color:#28c840;background:rgba(40,200,64,0.12)">+ CREATE INDEX idx_posts_author ON posts(author_id);</span>' },
          { label: ccTab(), content: '<span style="color:#6366f1">\\u276f</span> <span style="color:rgba(255,255,255,0.9)">set up CI/CD pipeline for the project</span>' }
        ],
        style: {
          width: '42vw',
          height: '42vh',
          top: '12%',
          left: '48%',
          zIndex: 4
        }
      });

      // --- Window 5: Project window (beads issues + git graph) — right side ---
      win5 = createPane({
        title: 'Project',
        tabs: [
          { label: 'issues', active: true, content: beadsContent },
          { label: 'git graph', content: gitGraphContent }
        ],
        style: {
          width: '40vw',
          height: '50vh',
          top: '30%',
          left: '52%',
          zIndex: 5
        }
      });

      // --- Window 6: Background diff pane (large, behind everything, no tabs) ---
      win6 = createPane({
        title: 'src/services/userService.ts',
        tabs: []
      });
      win6._body.style.fontSize = '10px';
      win6._body.style.lineHeight = '1.7';
      win6._body.innerHTML = '<span style="color:rgba(255,255,255,0.3)">import { db } from \\'../config/database\\';</span><br><span style="color:rgba(255,255,255,0.3)">import { hash, compare } from \\'bcrypt\\';</span><br><br><span style="color:rgba(255,255,255,0.3)">export class UserService {</span><br><span style="color:#ff5f57;background:rgba(255,95,87,0.12)">-   async createUser(email: string, password: string) {</span><br><span style="color:#ff5f57;background:rgba(255,95,87,0.12)">-     const user = await db.query(</span><br><span style="color:#ff5f57;background:rgba(255,95,87,0.12)">-       \\'INSERT INTO users (email, password) VALUES ($1, $2)\\',</span><br><span style="color:#ff5f57;background:rgba(255,95,87,0.12)">-       [email, password]</span><br><span style="color:#ff5f57;background:rgba(255,95,87,0.12)">-     );</span><br><span style="color:#ff5f57;background:rgba(255,95,87,0.12)">-     return user.rows[0];</span><br><span style="color:#28c840;background:rgba(40,200,64,0.12)">+   async createUser(email: string, password: string, role = \\'member\\') {</span><br><span style="color:#28c840;background:rgba(40,200,64,0.12)">+     const hashed = await hash(password, 12);</span><br><span style="color:#28c840;background:rgba(40,200,64,0.12)">+     const user = await db.query(</span><br><span style="color:#28c840;background:rgba(40,200,64,0.12)">+       \\'INSERT INTO users (email, password, role, created_at) VALUES ($1, $2, $3, NOW())\\',</span><br><span style="color:#28c840;background:rgba(40,200,64,0.12)">+       [email, hashed, role]</span><br><span style="color:#28c840;background:rgba(40,200,64,0.12)">+     );</span><br><span style="color:#28c840;background:rgba(40,200,64,0.12)">+     const { password: _, ...safe } = user.rows[0];</span><br><span style="color:#28c840;background:rgba(40,200,64,0.12)">+     return safe;</span><br><span style="color:rgba(255,255,255,0.3)">  }</span><br><br><span style="color:#ff5f57;background:rgba(255,95,87,0.12)">-   async login(email: string, password: string) {</span><br><span style="color:#ff5f57;background:rgba(255,95,87,0.12)">-     const user = await db.query(\\'SELECT * FROM users WHERE email = $1\\', [email]);</span><br><span style="color:#ff5f57;background:rgba(255,95,87,0.12)">-     if (!user.rows[0]) throw new Error(\\'Not found\\');</span><br><span style="color:#ff5f57;background:rgba(255,95,87,0.12)">-     return user.rows[0];</span><br><span style="color:#28c840;background:rgba(40,200,64,0.12)">+   async login(email: string, password: string) {</span><br><span style="color:#28c840;background:rgba(40,200,64,0.12)">+     const result = await db.query(\\'SELECT * FROM users WHERE email = $1\\', [email]);</span><br><span style="color:#28c840;background:rgba(40,200,64,0.12)">+     const user = result.rows[0];</span><br><span style="color:#28c840;background:rgba(40,200,64,0.12)">+     if (!user) throw new AuthError(\\'Invalid credentials\\');</span><br><span style="color:#28c840;background:rgba(40,200,64,0.12)">+     const valid = await compare(password, user.password);</span><br><span style="color:#28c840;background:rgba(40,200,64,0.12)">+     if (!valid) throw new AuthError(\\'Invalid credentials\\');</span><br><span style="color:#28c840;background:rgba(40,200,64,0.12)">+     return { id: user.id, email: user.email, role: user.role };</span><br><span style="color:rgba(255,255,255,0.3)">  }</span><br><br><span style="color:rgba(255,255,255,0.3)">  async findById(id: number) {</span><br><span style="color:#ff5f57;background:rgba(255,95,87,0.12)">-     return db.query(\\'SELECT * FROM users WHERE id = $1\\', [id]);</span><br><span style="color:#28c840;background:rgba(40,200,64,0.12)">+     const result = await db.query(</span><br><span style="color:#28c840;background:rgba(40,200,64,0.12)">+       \\'SELECT id, email, role, created_at FROM users WHERE id = $1\\',</span><br><span style="color:#28c840;background:rgba(40,200,64,0.12)">+       [id]</span><br><span style="color:#28c840;background:rgba(40,200,64,0.12)">+     );</span><br><span style="color:#28c840;background:rgba(40,200,64,0.12)">+     return result.rows[0] ?? null;</span><br><span style="color:rgba(255,255,255,0.3)">  }</span><br><span style="color:rgba(255,255,255,0.3)">}</span>';
      Object.assign(win6.style, {
        width: '58vw',
        height: '72vh',
        top: '14%',
        left: '22%',
        zIndex: 0,
        opacity: '0.6'
      });

      // Clear bodies for reveal animation (tab content preserved for switchTab)
      [win1, win2, win3, win4].forEach(function(w) {
        w._body.innerHTML = '';
      });

      // --- Start all panes minimized (off-screen) ---
      [win1, win2, win3, win4, win5, win6].forEach(function(w) {
        w.classList.add('pane-minimized');
      });

      // Add to stage (invisible until revealed)
      stage.appendChild(win6);
      stage.appendChild(win1);
      stage.appendChild(win2);
      stage.appendChild(win3);
      stage.appendChild(win4);
      stage.appendChild(win5);

      // Create fake cursor (hidden initially)
      cursor = document.createElement('div');
      cursor.className = 'fake-cursor';
      cursor.style.display = 'none';
      cursor.style.left = '50%';
      cursor.style.top = '50%';

      // --- Helper: type initial prompt into a pane body ---
      async function typePromptInto(pane, text) {
        var line = document.createElement('div');
        line.innerHTML = '<span style="color:#6366f1">\\u276f</span> <span style="color:rgba(255,255,255,0.9)"></span>';
        pane._body.appendChild(line);
        var textEl = line.querySelector('span:last-child');
        await typeText(textEl, text, 18);
      }

      // --- Reveal sequence: pull up panes one by one + type input (8s total) ---
      // 6 panes: win6 (background, just fades in) then win1–win5 with typed prompts
      // Timing: ~1.4s per main pane (450ms slide + ~550ms type + 400ms gap)

      initNarration();
      runNarration([
        'I start working on a project, run 8 agents at a time',
        'I like to have a live gitgraph, and keep active issues (Beads)'
      ], 6000, [2300, 3700]);

      // Fade in background diff pane
      win6.classList.remove('pane-minimized');

      var revealPanes = [
        { pane: win1, text: 'fix auth token expiry bug', output: CC_OUTPUTS.fixAuth, delay: 500 },
        { pane: win2, text: 'deploy latest to staging', output: CC_OUTPUTS.deploy, delay: 550 },
        { pane: win3, text: 'run security audit on codebase', output: CC_OUTPUTS.security, delay: 600 },
        { pane: win4, text: 'optimize slow dashboard queries', output: CC_OUTPUTS.optimize, delay: 520 },
        { pane: win5, text: null }
      ];

      var revealZ = 100;
      for (var ri = 0; ri < revealPanes.length; ri++) {
        var item = revealPanes[ri];
        // Newly revealed pane goes on top
        item.pane.style.zIndex = revealZ;
        item.pane.classList.remove('pane-minimized');
        await wait(300); // wait for slide-up transition
        if (item.text) {
          await typePromptInto(item.pane, item.text);
          // "Send" the prompt — start AI response immediately
          if (item.output) {
            startClaudeOutput(item.pane, item.output, item.delay);
          }
        }
        // Restore original z-index before next pane comes up
        item.pane.style.zIndex = '';
        if (ri < revealPanes.length - 1) await wait(150);
      }

      // Show cursor, move between windows
      cursor.style.display = '';
      stage.appendChild(cursor);
      let topZ = 10;
      const allWins = [win1, win2, win3, win4, win5, win6];

      function focusWindow(win) {
        topZ++;
        win.style.zIndex = topZ;
        win.style.borderColor = 'rgba(255, 255, 255, 0.2)';
        allWins.forEach(w => { if (w !== win) w.style.borderColor = ''; });
      }

      // === CURSOR SEQUENCE — 1.5x faster waits, 2.2x faster typing ===

      // 0. "Lost" — chaotically switching tabs trying to find the right one
      await wait(1000); // let second sentence linger
      runNarration([
        'Navigating tabs takes longer than typing queries\\u2026',
        'Unnoticed permission requests or questions halt parallel development\\u2026',
        'All this breaks your ability to concentrate on actual work'
      ], 12000, [3200, 3900, 3900]);

      // === Non-stop pane + tab flood — starts in background, accelerates over time ===
      // First pane appears ~2.5s after narration (between "Unnoticed..." and "All this breaks...")
      const hellPositions = [
        // Row 1 — spread across top
        { width: '34vw', height: '30vh', top: '3%',  left: '58%' },
        { width: '35vw', height: '32vh', top: '5%',  left: '8%' },
        { width: '33vw', height: '30vh', top: '8%',  left: '34%' },
        // Row 2 — middle band
        { width: '36vw', height: '32vh', top: '25%', left: '55%' },
        { width: '34vw', height: '30vh', top: '22%', left: '5%' },
        { width: '35vw', height: '32vh', top: '28%', left: '30%' },
        // Row 3 — lower area
        { width: '33vw', height: '28vh', top: '48%', left: '60%' },
        { width: '36vw', height: '30vh', top: '45%', left: '10%' },
        { width: '34vw', height: '30vh', top: '50%', left: '35%' },
        // Row 4 — late arrivals filling remaining gaps
        { width: '33vw', height: '28vh', top: '15%', left: '60%' },
        { width: '35vw', height: '30vh', top: '38%', left: '3%' },
        { width: '34vw', height: '28vh', top: '55%', left: '48%' },
        { width: '32vw', height: '30vh', top: '32%', left: '42%' },
        // Row 5 — final burst right before install
        { width: '34vw', height: '28vh', top: '12%', left: '18%' },
        { width: '33vw', height: '30vh', top: '42%', left: '58%' },
        { width: '35vw', height: '28vh', top: '58%', left: '8%' },
        { width: '32vw', height: '30vh', top: '20%', left: '48%' },
        { width: '34vw', height: '28vh', top: '52%', left: '28%' },
      ];
      const hellTasks = [
        'refactor callbacks to async/await',
        'add rate limiting middleware',
        'debug WebSocket memory leak',
        'migrate user table to v2 schema',
        'fix flaky integration tests',
        'add end-to-end test coverage',
        'setup Redis cache layer',
        'update OpenAPI spec from routes',
        'fix CORS preflight on /api/v2',
        'add Stripe webhook handler',
        'optimize image resize pipeline',
        'audit npm dependencies for CVEs',
        'setup GraphQL subscriptions',
        'fix session token rotation',
        'add prometheus metrics endpoint',
        'migrate to ESM modules',
        'implement request deduplication',
        'patch XSS in markdown renderer',
      ];
      const hellOutputs = [
        CC_OUTPUTS.refactor, CC_OUTPUTS.addTests, CC_OUTPUTS.migrateDb,
        CC_OUTPUTS.docs, CC_OUTPUTS.security, CC_OUTPUTS.optimize, CC_OUTPUTS.deploy,
        CC_OUTPUTS.fixAuth, CC_OUTPUTS.refactor, CC_OUTPUTS.addTests,
        CC_OUTPUTS.optimize, CC_OUTPUTS.security, CC_OUTPUTS.docs,
        CC_OUTPUTS.fixAuth, CC_OUTPUTS.migrateDb, CC_OUTPUTS.security,
        CC_OUTPUTS.addTests, CC_OUTPUTS.optimize
      ];
      const hellTabCounts = [2, 3, 4, 3, 2, 4, 3, 2, 3, 3, 2, 4, 3, 2, 3, 4, 2, 3];
      tabHellPanes = [];
      let _hellPaneIdx = 0;
      let _hellZIndex = 30;

      function spawnHellPane() {
        const hi = _hellPaneIdx++;
        if (hi >= hellPositions.length) return;
        _hellZIndex = Math.min(_hellZIndex + 1, 49);
        const fromTop = hi % 2 === 1;
        const tabCount = hellTabCounts[hi] || 3;
        const tabs = [];
        for (let ti = 0; ti < tabCount; ti++) {
          tabs.push({ label: ccTab(), active: ti === 0, content: '' });
        }
        const pos = hellPositions[hi];
        const hellWin = createPane({
          title: 'Claude Code',
          tabs: tabs
        });
        // Explicitly set position — don't rely on Object.assign in createPane
        hellWin.style.top = pos.top;
        hellWin.style.left = pos.left;
        hellWin.style.width = pos.width;
        hellWin.style.height = pos.height;
        // Start offscreen
        hellWin.style.opacity = '0';
        hellWin.style.transform = fromTop
          ? 'translateY(-100vh) scale(0.9)'
          : 'translateY(100vh) scale(0.9)';
        hellWin.style.transition = 'transform 0.5s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.3s ease';
        hellWin.style.zIndex = _hellZIndex;
        stage.appendChild(hellWin);
        tabHellPanes.push(hellWin);
        hellWin.offsetHeight; // force layout
        hellWin.style.opacity = '1';
        hellWin.style.transform = 'translateY(0) scale(1)';
        hellWin._body.innerHTML = '<span style="color:#6366f1">\\u276f</span> <span style="color:rgba(255,255,255,0.9)">' + hellTasks[hi] + '</span>';
        startClaudeOutput(hellWin, hellOutputs[hi], 250);
      }

      let _paneDelay = 1500;
      let _paneTimer = null;
      function schedulePaneSpawn() {
        if (_hellPaneIdx >= hellPositions.length) return;
        _paneTimer = setTimeout(() => {
          spawnHellPane();
          // Gentle acceleration so 13 panes span full duration until install:
          // 1500→1320→1162→1022→900→792→697→614→540→475→418→368→350 ≈ 10.7s
          _paneDelay = Math.max(350, _paneDelay * 0.88);
          schedulePaneSpawn();
        }, _paneDelay / SPEED);
      }

      const tabTargets = [win1, win3, win4, win2];
      let _tabDripIdx = 0;
      let _tabDelay = 900;
      let _tabTimer = null;
      function scheduleTabDrip() {
        _tabTimer = setTimeout(() => {
          addTab(tabTargets[_tabDripIdx % tabTargets.length], ccTab(), '');
          _tabDripIdx++;
          _tabDelay = Math.max(250, _tabDelay * 0.82);
          scheduleTabDrip();
        }, _tabDelay / SPEED);
      }

      // Fire both spawners immediately — they use setTimeout internally
      schedulePaneSpawn();
      scheduleTabDrip();

      await moveCursor(cursor, win1._tabBar.querySelectorAll('.tab')[0], 200);
      focusWindow(win1);
      await wait(180);
      // Switch to tab 2 on win1, pause, switch back
      switchTab(win1, 1);
      await wait(250);
      switchTab(win1, 0);
      await wait(120);

      // Jump to win4, check a tab there
      await moveCursor(cursor, win4._tabBar.querySelectorAll('.tab')[0], 170);
      focusWindow(win4);
      await wait(200);
      switchTab(win4, 1);
      await wait(180);
      switchTab(win4, 0);
      await wait(100);

      // Jump to win2, hover briefly, then go to win3
      await moveCursor(cursor, win2._tabBar.querySelectorAll('.tab')[0], 150);
      focusWindow(win2);
      await wait(130);
      await moveCursor(cursor, win3._tabBar.querySelectorAll('.tab')[0], 140);
      focusWindow(win3);
      await wait(100);
      // Back to win1 tab 2 again — second-guessing
      await moveCursor(cursor, win1._tabBar.querySelectorAll('.tab')[1], 150);
      focusWindow(win1);
      switchTab(win1, 1);
      await wait(200);
      switchTab(win1, 0);
      await wait(150);

      // 1. Click Win3 — type "merge to master", Claude responds
      await moveCursor(cursor, win3._body, 170);
      focusWindow(win3);
      await wait(130);
      stopClaudeOutput(win3);
      win3._body.innerHTML += '<br><br><span style="color:#6366f1">\\u276f</span> ';
      const w3prompt = document.createElement('span');
      w3prompt.style.color = 'rgba(255,255,255,0.9)';
      win3._body.appendChild(w3prompt);
      await typeText(w3prompt, 'merge to master', 20);
      await wait(130);
      win3._body.innerHTML += '<br><br><span style="color:#e87b35">\\u2733</span> <span style="color:rgba(255,255,255,0.5)">Alright, I\\'ll merge the current branch into master now.</span>';
      await wait(100);
      win3._body.innerHTML += '<br>  <span style="color:rgba(255,255,255,0.35)">\\u23BF  Bash</span> <span style="color:rgba(255,255,255,0.5)">git checkout master && git merge feat/auth-fix</span>';
      startClaudeOutput(win3, CC_OUTPUTS.security, 500);
      await wait(200);

      // 2. Click Win1 tab 2 — switch to test tab, output mid-stream
      const w1t1 = win1._tabBar.querySelectorAll('.tab')[1];
      await moveCursor(cursor, w1t1, 170);
      focusWindow(win1);
      await wait(53);
      stopClaudeOutput(win1);
      switchTab(win1, 1);
      win1._body.innerHTML = '  <span style="color:rgba(255,255,255,0.35)">\\u23BF  Read</span> <span style="color:#79b8ff">src/middleware/auth.js</span><br><span style="color:#e87b35">\\u2736</span> <span style="color:rgba(255,255,255,0.5)">Writing test cases...</span>';
      startClaudeOutput(win1, CC_OUTPUTS.addTests, 500);
      await wait(167);

      // 3. Click Win4 body — type "also fix the N+1 queries", Claude responds
      await moveCursor(cursor, win4._body, 170);
      focusWindow(win4);
      await wait(100);
      stopClaudeOutput(win4);
      win4._body.innerHTML += '<br><br><span style="color:#6366f1">\\u276f</span> ';
      const w4prompt = document.createElement('span');
      w4prompt.style.color = 'rgba(255,255,255,0.9)';
      win4._body.appendChild(w4prompt);
      await typeText(w4prompt, 'also fix the N+1 queries', 18);
      await wait(130);
      win4._body.innerHTML += '<br><br><span style="color:#e87b35">\\u2736</span> <span style="color:rgba(255,255,255,0.5)">On it. Let me find all the N+1 query patterns first.</span>';
      await wait(80);
      win4._body.innerHTML += '<br>  <span style="color:rgba(255,255,255,0.35)">\\u23BF  Read</span> <span style="color:#79b8ff">src/routes/users.js</span>';
      startClaudeOutput(win4, CC_OUTPUTS.optimize, 450);
      await wait(200);

      // 4. CONFUSION — go back to Win3, hesitate, then move to Win1
      await moveCursor(cursor, win3._body, 130);
      focusWindow(win3);
      await wait(130);
      await moveCursor(cursor, win1._tabBar.querySelectorAll('.tab')[0], 130);
      await wait(80);
      await moveCursor(cursor, win3._tabBar.querySelectorAll('.tab')[1], 130);
      focusWindow(win3);
      await wait(53);
      stopClaudeOutput(win3);
      switchTab(win3, 1);
      win3._body.innerHTML = '  <span style="color:rgba(255,255,255,0.35)">\\u23BF  Read</span> <span style="color:#79b8ff">src/routes/auth.js</span><br><span style="color:#e87b35">\\u2733</span> <span style="color:rgba(255,255,255,0.5)">Generating documentation...</span>';
      startClaudeOutput(win3, CC_OUTPUTS.docs, 600);
      await wait(167);

      // 5. Click Win4 tab 2 — show the larger diff
      const w4t1 = win4._tabBar.querySelectorAll('.tab')[1];
      await moveCursor(cursor, w4t1, 170);
      focusWindow(win4);
      await wait(53);
      stopClaudeOutput(win4);
      switchTab(win4, 1);
      win4._body.innerHTML = '<span style="color:#e87b35">\\u2736</span> <span style="color:rgba(255,255,255,0.5)">Optimizing connection pool and adding retry logic.</span><br><br>  <span style="color:rgba(255,255,255,0.35)">\\u23BF  Edit</span> <span style="color:#79b8ff">src/config/database.js</span><br>    <span style="color:rgba(255,255,255,0.4)">  pool: {</span><br>    <span style="color:rgba(255,255,255,0.4)">    max: 10,</span><br>    <span style="color:#ff5f57;background:rgba(255,95,87,0.12)">-     min: 0,</span><br>    <span style="color:#ff5f57;background:rgba(255,95,87,0.12)">-     idle: 10000</span><br>    <span style="color:#28c840;background:rgba(40,200,64,0.12)">+     min: 2,</span><br>    <span style="color:#28c840;background:rgba(40,200,64,0.12)">+     idle: 30000,</span><br>    <span style="color:#28c840;background:rgba(40,200,64,0.12)">+     acquire: 60000,</span><br>    <span style="color:#28c840;background:rgba(40,200,64,0.12)">+     evict: 1000</span><br>    <span style="color:rgba(255,255,255,0.4)">  },</span><br>    <span style="color:#ff5f57;background:rgba(255,95,87,0.12)">-   logging: false</span><br>    <span style="color:#28c840;background:rgba(40,200,64,0.12)">+   logging: process.env.NODE_ENV === \\'development\\',</span><br>    <span style="color:#28c840;background:rgba(40,200,64,0.12)">+   retry: {</span><br>    <span style="color:#28c840;background:rgba(40,200,64,0.12)">+     max: 3,</span><br>    <span style="color:#28c840;background:rgba(40,200,64,0.12)">+     backoffBase: 1000</span><br>    <span style="color:#28c840;background:rgba(40,200,64,0.12)">+   }</span><br>    <span style="color:rgba(255,255,255,0.4)">};</span>';
      await wait(200);

      // 7. Win2 — permission prompt, "yes", then new tab with "fix all bugs"
      await moveCursor(cursor, win2._body, 170);
      focusWindow(win2);
      await wait(100);
      stopClaudeOutput(win2);
      // Clear old content, show fresh permission prompt
      win2._body.innerHTML = '<span style="color:#e87b35">\\u2733</span> <span style="color:rgba(255,255,255,0.5)">I need to read files in ./ND-main to understand the project structure.</span><br><br>  <span style="color:rgba(255,255,255,0.35)">\\u23BF  Allow Read</span> <span style="color:#79b8ff">./ND-main/**</span>';
      await wait(400);
      win2._body.innerHTML += '<br><br><span style="color:rgba(168,130,255,0.8)">  Allow? (y/n):</span> ';
      await wait(270);
      await moveCursor(cursor, win2._body, 130);
      await wait(130);
      const yesSpan = document.createElement('span');
      yesSpan.style.color = 'rgba(255,255,255,0.9)';
      win2._body.appendChild(yesSpan);
      await typeText(yesSpan, 'yes', 36);
      await wait(200);
      // Claude responds — clear and show fresh response
      win2._body.innerHTML = '<span style="color:rgba(168,130,255,0.8)">  Allow? (y/n):</span> yes<br><br><span style="color:#e87b35">\\u2736</span> <span style="color:rgba(255,255,255,0.5)">Got it, reading the project files now.</span>';
      await wait(130);
      win2._body.innerHTML += '<br>  <span style="color:rgba(255,255,255,0.35)">\\u23BF  Read</span> <span style="color:#79b8ff">./ND-main/src/index.ts</span>';
      await wait(100);
      win2._body.innerHTML += '<br>  <span style="color:rgba(255,255,255,0.35)">\\u23BF  Read</span> <span style="color:#79b8ff">./ND-main/src/config.ts</span>';
      await wait(100);
      win2._body.innerHTML += '<br>  <span style="color:rgba(255,255,255,0.35)">\\u23BF  Read</span> <span style="color:#79b8ff">./ND-main/package.json</span>';
      await wait(270);

      // Click "+" on Win2 to create a new tab
      const win2Plus = win2._tabBar.querySelector('.tab-plus');
      await moveCursor(cursor, win2Plus, 170);
      await wait(67);
      cursor.classList.add('clicking');
      await wait(53);
      cursor.classList.remove('clicking');
      addTab(win2, ccTab(), '');
      await wait(130);
      await moveCursor(cursor, win2._body, 130);
      await wait(130);
      win2._body.innerHTML = '<span style="color:#6366f1">\\u276f</span> ';
      const promptSpan = document.createElement('span');
      promptSpan.style.color = 'rgba(255,255,255,0.9)';
      win2._body.appendChild(promptSpan);
      await typeText(promptSpan, 'fix all bugs, dont run out of context window please!', 20);
      await wait(200);
      // Claude responds
      win2._body.innerHTML += '<br><br><span style="color:#e87b35">\\u2736</span> <span style="color:rgba(255,255,255,0.5)">I\\'ll scan the codebase and fix all bugs I can find. Starting now.</span>';
      await wait(80);
      win2._body.innerHTML += '<br>  <span style="color:rgba(255,255,255,0.35)">\\u23BF  Read</span> <span style="color:#79b8ff">src/</span>';
      startClaudeOutput(win2, CC_OUTPUTS.migrateDb, 400);
      await wait(470);

      // 8. Win5 (Project) — click git graph tab
      const w5t1 = win5._tabBar.querySelectorAll('.tab')[1];
      await moveCursor(cursor, w5t1, 170);
      focusWindow(win5);
      await wait(53);
      switchTab(win5, 1);
      await wait(270);

      // Stop the background spawners
      if (_paneTimer) clearTimeout(_paneTimer);
      if (_tabTimer) clearTimeout(_tabTimer);

      // Stop all tab hell outputs
      tabHellPanes.forEach(p => stopClaudeOutput(p));

      // Phase 1 done. Stop all live outputs, hide cursor.
      stopClaudeOutput(win1);
      stopClaudeOutput(win2);
      stopClaudeOutput(win3);
      stopClaudeOutput(win4);
      cursor.style.display = 'none';
      stopNarration();

      // Start section 3 narration 0.6s before overlay (so it appears earlier)
      var _49logo = '<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 401.25 474.75" style="vertical-align:-4px;margin:0 1px" preserveAspectRatio="xMidYMid meet"><path stroke-linecap="round" transform="matrix(0,-0.7486,0.7486,0,195.64,231.21)" fill="none" stroke-linejoin="miter" d="M28.5 28.5L277.24 28.5" stroke="#fff" stroke-width="57" stroke-miterlimit="4"/><path stroke-linecap="round" transform="matrix(0,-0.7486,0.7486,0,357.32,219.46)" fill="none" stroke-linejoin="miter" d="M28.5 28.5L261.55 28.5" stroke="#fff" stroke-width="57" stroke-miterlimit="4"/><path stroke-linecap="round" transform="matrix(-0.7486,0,0,-0.7486,396.71,42.99)" fill="none" stroke-linejoin="miter" d="M28.5 28.5L238.5 28.5" stroke="#fff" stroke-width="57" stroke-miterlimit="4"/><path stroke-linecap="round" transform="matrix(-0.7486,0,0,-0.7486,390.07,233.08)" fill="none" stroke-linejoin="miter" d="M28.5 28.5L229.63 28.5" stroke="#fff" stroke-width="57" stroke-miterlimit="4"/><path stroke-linecap="round" transform="matrix(0,-0.7486,0.7486,0,357.32,416.93)" fill="none" stroke-linejoin="miter" d="M28.5 28.5L317.8 28.5" stroke="#fff" stroke-width="57" stroke-miterlimit="4"/><path stroke-linecap="round" transform="matrix(-0.7486,0.008,-0.008,-0.7486,400.35,422.8)" fill="none" stroke-linejoin="miter" d="M28.5 28.5L236.69 28.5" stroke="#fff" stroke-width="57" stroke-miterlimit="4"/><path stroke-linecap="round" transform="matrix(-0.3743,-0.6483,0.6483,-0.3743,237.68,474.13)" fill="none" stroke-linejoin="miter" d="M28.5 28.5L90.35 28.5" stroke="#fff" stroke-width="57" stroke-miterlimit="4"/><path stroke-linecap="round" transform="matrix(0,-0.7486,0.7486,0,-0.006,299.92)" fill="none" stroke-linejoin="miter" d="M28.5 28.5L369.03 28.5" stroke="#fff" stroke-width="57" stroke-miterlimit="4"/><path stroke-linecap="round" transform="matrix(-0.7486,0,0,-0.7486,211.66,303.83)" fill="none" stroke-linejoin="miter" d="M28.5 28.5L253.64 28.5" stroke="#fff" stroke-width="57" stroke-miterlimit="4"/><path stroke-linecap="round" transform="matrix(0,-0.7486,0.7486,0,124.95,420.72)" fill="none" stroke-linejoin="miter" d="M28.5 28.5L404.2 28.5" stroke="#fff" stroke-width="57" stroke-miterlimit="4"/><path stroke-linecap="round" transform="matrix(-0.3743,-0.6483,0.6483,-0.3743,135.95,142.76)" fill="none" stroke-linejoin="miter" d="M28.5 28.5L90.35 28.5" stroke="#fff" stroke-width="57" stroke-miterlimit="4"/><path stroke-linecap="round" transform="matrix(-0.3743,-0.6483,0.6483,-0.3743,165.05,474.13)" fill="none" stroke-linejoin="miter" d="M28.5 28.5L90.35 28.5" stroke="#fff" stroke-width="57" stroke-miterlimit="4"/></svg>';
      runNarration([
        'I use ' + _49logo + 'Agents to solve all this\\u2026',
        'Installation takes seconds',
        'Welcome to my workflow!'
      ], 8000);
      await wait(600);
    }
    async function phase2Install() {
      // 0.0s — Fade in dark overlay
      const overlay = document.createElement('div');
      overlay.className = 'dark-overlay';
      stage.appendChild(overlay);
      overlay.offsetHeight;
      overlay.classList.add('active');
      await wait(1000);

      // 1.0s — Create install terminal, slide up from below center
      const installTerm = createPane({
        title: 'Terminal',
        tabs: [],
        class: 'install-terminal'
      });
      installTerm.style.position = 'fixed';
      installTerm.style.left = '50%';
      installTerm.style.top = '50%';
      installTerm.style.transform = 'translate(-50%, calc(-50% + 60px)) scale(0.95)';
      installTerm.style.width = '540px';
      installTerm.style.height = '340px';
      installTerm.style.opacity = '0';
      installTerm.style.zIndex = '100';
      installTerm.style.transition = 'all 0.8s cubic-bezier(0.16, 1, 0.3, 1)';
      installTerm.style.borderColor = 'rgba(99, 102, 241, 0.3)';
      installTerm.style.boxShadow = '0 0 30px rgba(99, 102, 241, 0.15), 0 0 60px rgba(99, 102, 241, 0.05)';

      stage.appendChild(installTerm);

      installTerm.offsetHeight;
      installTerm.style.opacity = '1';
      installTerm.style.transform = 'translate(-50%, -50%)';
      setNarrationPos('above');
      await wait(600);

      const body = installTerm._body;
      body.innerHTML = '';
      body.style.fontSize = '13px';
      body.style.color = 'rgba(255, 255, 255, 0.8)';
      body.style.whiteSpace = 'normal';

      // Prompt line as a div
      const promptLine = document.createElement('div');
      promptLine.textContent = '$ ';
      body.appendChild(promptLine);

      // Brief cursor blink pause
      await wait(500);

      // Type: npm install 49agents (15% slower)
      await typeText(promptLine, 'npm install 49agents', 69);
      await wait(200);

      // npm progress bar animation (two phases, 6x faster)
      const barWidth = 20;

      // Phase 1: idealTree
      const progressLine1 = document.createElement('div');
      progressLine1.style.cssText = 'color:rgba(255,255,255,0.5);font-size:12px;';
      body.appendChild(progressLine1);
      for (let p = 0; p <= barWidth; p++) {
        const filled = '\\u2588'.repeat(p);
        const empty = '\\u2591'.repeat(barWidth - p);
        const pct = Math.round((p / barWidth) * 100);
        progressLine1.textContent = \`[\${filled}\${empty}] \${pct}% | idealTree: building dependencies\`;
        await wait(7 + Math.random() * 5);
      }

      // Phase 2: reify (separate element so both persist)
      const progressLine2 = document.createElement('div');
      progressLine2.style.cssText = 'color:rgba(255,255,255,0.5);font-size:12px;';
      body.appendChild(progressLine2);
      for (let p = 0; p <= barWidth; p++) {
        const filled = '\\u2588'.repeat(p);
        const empty = '\\u2591'.repeat(barWidth - p);
        const pct = Math.round((p / barWidth) * 100);
        progressLine2.textContent = \`[\${filled}\${empty}] \${pct}% | reify: installing to node_modules\`;
        await wait(7 + Math.random() * 5);
      }

      // Install output
      const installOutput = document.createElement('div');
      body.appendChild(installOutput);
      const installLines = [
        'added 12 packages in 1.2s',
        '',
        '\\u2714 49agents installed successfully',
        '  Run \`49agents start\` to begin'
      ];
      await addLines(installOutput, installLines, 150);
      await wait(600);

      // New prompt — user types 49agents start (15% slower)
      const promptLine2 = document.createElement('div');
      promptLine2.textContent = '$ ';
      body.appendChild(promptLine2);
      await wait(300);
      await typeText(promptLine2, '49agents start', 63);
      await wait(200);

      // Agent boot sequence — line by line
      const bootOutput = document.createElement('pre');
      bootOutput.style.cssText = 'margin:0;font:inherit;white-space:pre-wrap;';
      body.appendChild(bootOutput);
      const agentBootLines = [
        '[Agent] Starting 49Agents Agent v0.1.0',
        '[Agent] Connected to cloud relay',
      ];
      await addLines(bootOutput, agentBootLines, 300);
      await wait(800);

      // Auto-minimize: shrink terminal down and away (like minimizing to taskbar)
      installTerm.style.transition = 'all 0.7s cubic-bezier(0.4, 0, 0.2, 1)';
      installTerm.style.transform = 'translate(-50%, 100vh) scale(0.3)';
      installTerm.style.opacity = '0';
      setNarrationPos('center');

      await wait(600);
      installTerm.remove();

      // Fade out dark overlay (slower for smooth transition)
      overlay.style.transition = 'opacity 1.5s ease';
      overlay.classList.remove('active');
      await wait(1200);
      overlay.remove();
      stopNarration();
    }
    async function phase3Transform() {
      // === Step 1: Canvas Reveal (0-1.5s) ===

      // Add dot grid to stage
      await wait(300);
      stage.classList.add('dot-grid');

      // Add "49" watermark in corner
      const watermark = document.createElement('div');
      watermark.textContent = '49';
      watermark.style.cssText = 'position:absolute;bottom:12px;right:16px;font-family:Syne,sans-serif;font-weight:800;font-size:18px;color:rgba(99,102,241,0.15);z-index:1;';
      stage.appendChild(watermark);

      await wait(400);

      // === Step 2: Pane Reorganization (1.5-3.5s) ===

      // Fade out unused panes with smooth scale-down
      [win6, win4, win5].forEach(p => {
        p.style.transition = 'opacity 0.8s ease, transform 0.8s ease';
        p.style.opacity = '0';
        p.style.transform = 'scale(0.92)';
      });
      tabHellPanes.forEach((p, i) => {
        p.style.transition = 'opacity 0.6s ease ' + (i * 30) + 'ms, transform 0.6s ease ' + (i * 30) + 'ms';
        p.style.opacity = '0';
        p.style.transform = 'scale(0.9)';
      });
      setTimeout(() => {
        win6.remove(); win4.remove(); win5.remove();
        tabHellPanes.forEach(p => p.remove());
        tabHellPanes = [];
      }, 1200);

      // Extract the git graph from win5 (Project window) and create a standalone git graph pane
      const gitGraphEl = document.getElementById('git-graph');

      // Create the git graph pane as a new standalone pane
      gitGraphPane = createPane({
        title: '<svg viewBox="0 0 24 24" style="width:14px;height:14px;vertical-align:-2px;color:#a78bfa;margin-right:5px"><circle cx="7" cy="6" r="2.5" fill="currentColor"></circle><circle cx="17" cy="6" r="2.5" fill="currentColor"></circle><circle cx="7" cy="18" r="2.5" fill="currentColor"></circle><line x1="7" y1="8.5" x2="7" y2="15.5" stroke="currentColor" stroke-width="2"></line><path d="M17 8.5c0 4-10 4-10 7" stroke="currentColor" stroke-width="2" fill="none"></path></svg>Git Graph',
        tabs: [],
        id: 'git-graph-pane'
      });
      gitGraphPane.querySelectorAll('.dot').forEach(d => d.remove());

      // Move the git-graph div into the new pane's body
      if (gitGraphEl) {
        gitGraphPane._body.innerHTML = '';
        gitGraphPane._body.appendChild(gitGraphEl);
      }

      // Attach git engine to the <pre> element and seed initial master commits
      const gitOutputEl = gitGraphEl ? gitGraphEl.querySelector('.git-graph-output') : null;
      if (gitOutputEl) {
        gitEngine.attach(gitOutputEl);
        var seedMsgs = ['Merge branch \\'feature/folder-pane\\'', 'feat: exit move mode on conflicts', 'Merge branch \\'feat/move-mode-wasd\\'', 'feat: add mention shortcut', 'Merge branch \\'align-folder-pane\\'', 'feat: broadcast-style indicator bar'];
        seedMsgs.forEach(function(m) { gitEngine.commit(0, m); });
      }

      // Style pane-body for proper git graph display
      gitGraphPane._body.style.padding = '0';
      gitGraphPane._body.style.display = 'flex';
      gitGraphPane._body.style.flexDirection = 'column';
      gitGraphPane._body.style.overflow = 'hidden';
      gitGraphPane._body.style.flex = '1';

      // Position git graph pane at win5's CURRENT position first (so it can animate from there)
      const win5Rect = win5.getBoundingClientRect();
      const stageRect = stage.getBoundingClientRect();
      gitGraphPane.style.top = ((win5Rect.top - stageRect.top) / stageRect.height * 100) + '%';
      gitGraphPane.style.left = ((win5Rect.left - stageRect.left) / stageRect.width * 100) + '%';
      gitGraphPane.style.width = (win5Rect.width / stageRect.width * 100) + '%';
      gitGraphPane.style.height = (win5Rect.height / stageRect.height * 100) + '%';
      gitGraphPane.style.zIndex = '5';
      gitGraphPane.style.borderColor = 'rgba(99, 102, 241, 0.25)';

      stage.appendChild(gitGraphPane);

      // Create beads issues pane (starts invisible, will fade in)
      beadsPane = createPane({
        title: '<svg viewBox="0 0 24 24" style="width:14px;height:14px;vertical-align:-2px;color:#6366f1;margin-right:5px"><circle cx="6" cy="12" r="3" fill="currentColor" opacity="0.7"></circle><circle cx="12" cy="12" r="3" fill="currentColor"></circle><circle cx="18" cy="12" r="3" fill="currentColor" opacity="0.7"></circle><line x1="9" y1="12" x2="15" y2="12" stroke="currentColor" stroke-width="1.5"></line></svg>Issues',
        tabs: [],
        class: 'beads-standalone'
      });
      beadsPane.querySelectorAll('.dot').forEach(d => d.remove());
      beadsPane._body.innerHTML = '<div class="beads-container">' +
        '<div class="beads-header">' +
          '<div class="beads-counts">' +
            '<span class="beads-badge beads-badge-open">open 3</span>' +
            '<span class="beads-badge beads-badge-progress">in progress 2</span>' +
          '</div>' +
        '</div>' +
        '<div class="beads-table-wrap">' +
          '<table class="beads-table">' +
            '<colgroup><col style="width:24px"><col style="width:42px"><col style="width:48px"><col></colgroup>' +
            '<thead><tr>' +
              '<th style="text-align:center"></th>' +
              '<th>P</th>' +
              '<th>Type</th>' +
              '<th>Title</th>' +
            '</tr></thead>' +
            '<tbody>' +
              '<tr class="beads-row" data-issue-idx="0"><td style="text-align:center"><span class="beads-status-icon beads-status-progress">\\u25D0</span></td><td><span class="beads-priority beads-p1">P1</span></td><td><span class="beads-type beads-type-feature">feature</span></td><td><span class="beads-title-text">add folder pane git tracking</span></td></tr>' +
              '<tr class="beads-row" data-issue-idx="1"><td style="text-align:center"><span class="beads-status-icon beads-status-progress">\\u25D0</span></td><td><span class="beads-priority beads-p0">P0</span></td><td><span class="beads-type beads-type-bug">bug</span></td><td><span class="beads-title-text">terminal reconnect blank screen</span></td></tr>' +
              '<tr class="beads-row" data-issue-idx="2"><td style="text-align:center"><span class="beads-status-icon beads-status-open">\\u25CB</span></td><td><span class="beads-priority beads-p2">P2</span></td><td><span class="beads-type beads-type-feature">feature</span></td><td><span class="beads-title-text">keyboard navigation for modals</span></td></tr>' +
              '<tr class="beads-row" data-issue-idx="3"><td style="text-align:center"><span class="beads-status-icon beads-status-open">\\u25CB</span></td><td><span class="beads-priority beads-p2">P2</span></td><td><span class="beads-type beads-type-feature">feature</span></td><td><span class="beads-title-text">move mode WASD navigation</span></td></tr>' +
              '<tr class="beads-row" data-issue-idx="4"><td style="text-align:center"><span class="beads-status-icon beads-status-open">\\u25CB</span></td><td><span class="beads-priority beads-p1">P1</span></td><td><span class="beads-type beads-type-bug">bug</span></td><td><span class="beads-title-text">clipboard paste not working</span></td></tr>' +
            '</tbody>' +
          '</table>' +
        '</div>' +
      '</div>';
      beadsPane._body.style.padding = '0';
      beadsPane._body.style.display = 'flex';
      beadsPane._body.style.flexDirection = 'column';
      beadsPane._body.style.overflow = 'hidden';
      beadsPane.style.opacity = '0';
      beadsPane.style.top = CANVAS_LAYOUT.beads.top;
      beadsPane.style.left = CANVAS_LAYOUT.beads.left;
      beadsPane.style.width = CANVAS_LAYOUT.beads.width;
      beadsPane.style.height = CANVAS_LAYOUT.beads.height;
      beadsPane.style.background = 'rgba(12, 12, 28, 0.95)';
      stage.appendChild(beadsPane);

      // Claude logo for agent titles
      const agentLogo = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" fill="#e87b35" viewBox="0 0 16 16" style="vertical-align:-1px;margin-right:4px"><path d="m3.127 10.604 3.135-1.76.053-.153-.053-.085H6.11l-.525-.032-1.791-.048-1.554-.065-1.505-.08-.38-.081L0 7.832l.036-.234.32-.214.455.04 1.009.069 1.513.105 1.097.064 1.626.17h.259l.036-.105-.089-.065-.068-.064-1.566-1.062-1.695-1.121-.887-.646-.48-.327-.243-.306-.104-.67.435-.48.585.04.15.04.593.456 1.267.981 1.654 1.218.242.202.097-.068.012-.049-.109-.181-.9-1.626-.96-1.655-.428-.686-.113-.411a2 2 0 0 1-.068-.484l.496-.674L4.446 0l.662.089.279.242.411.94.666 1.48 1.033 2.014.302.597.162.553.06.17h.105v-.097l.085-1.134.157-1.392.154-1.792.052-.504.25-.605.497-.327.387.186.319.456-.045.294-.19 1.23-.37 1.93-.243 1.29h.142l.161-.16.654-.868 1.097-1.372.484-.545.565-.601.363-.287h.686l.505.751-.226.775-.707.895-.585.759-.839 1.13-.524.904.048.072.125-.012 1.897-.403 1.024-.186 1.223-.21.553.258.06.263-.218.536-1.307.323-1.533.307-2.284.54-.028.02.032.04 1.029.098.44.024h1.077l2.005.15.525.346.315.424-.053.323-.807.411-3.631-.863-.872-.218h-.12v.073l.726.71 1.331 1.202 1.667 1.55.084.383-.214.302-.226-.032-1.464-1.101-.565-.497-1.28-1.077h-.084v.113l.295.432 1.557 2.34.08.718-.112.234-.404.141-.444-.08-.911-1.28-.94-1.44-.759-1.291-.093.053-.448 4.821-.21.246-.484.186-.403-.307-.214-.496.214-.98.258-1.28.21-1.016.19-1.263.112-.42-.008-.028-.092.012-.953 1.307-1.448 1.957-1.146 1.227-.274.109-.477-.247.045-.44.266-.39 1.586-2.018.956-1.25.617-.723-.004-.105h-.036l-4.212 2.736-.75.096-.324-.302.04-.496.154-.162 1.267-.871z"/></svg>';

      // Branch-style names for the canvas pane headings
      const agentNames = [
        'feat/git-tracking', 'fix/terminal-reconnect', 'feat/keyboard-nav'
      ];
      const BEADS_ISSUES = [
        { id: 'a7f2', branch: 'folder-git-tracking' },
        { id: 'b3e1', branch: 'terminal-reconnect' },
        { id: 'c9d4', branch: 'keyboard-nav' },
      ];
      // Now animate everything to target positions
      await wait(100);

      // Helper to transform a window into a project terminal (preserves body content)
      const INITIAL_AGENT_CONTENT = [
        CC_OUTPUTS.fixAuth.slice(0, 6),
        CC_OUTPUTS.refactor.slice(0, 6),
        CC_OUTPUTS.security.slice(0, 6),
      ];
      function agentify(win, layout, name, idx) {
        if (win._tabBar) win._tabBar.remove();
        // Remove red/yellow/green dots from header
        win.querySelectorAll('.dot').forEach(d => d.remove());
        win.querySelector('.pane-title').innerHTML = agentLogo + ' ' + name;
        // Clear old phase1 content and pre-fill with agent output
        var lines = INITIAL_AGENT_CONTENT[idx] || INITIAL_AGENT_CONTENT[0];
        win._body.innerHTML = '<span style="color:#6366f1">❯</span> <span style="color:rgba(255,255,255,0.8)">' + name + '</span><br>' + lines.join('<br>');
        win._body.style.transition = 'font-size 0.8s ease';
        win._body.style.fontSize = '9px';
        Object.assign(win.style, layout);
        win.style.opacity = '1';
      }

      requestAnimationFrame(() => {
        // Move git graph pane to center
        Object.assign(gitGraphPane.style, CANVAS_LAYOUT.gitGraph);

        agentify(win1, CANVAS_LAYOUT.terminal1, agentNames[0], 0);
        agentify(win2, CANVAS_LAYOUT.terminal2, agentNames[1], 1);
        agentify(win3, CANVAS_LAYOUT.terminal3, agentNames[2], 2);

        // Fade in beads pane
        beadsPane.style.opacity = '1';

      });

      // Populate allTerminals array for Phase 3 Part 2 (3 terminals total)
      allTerminals.length = 0;
      allTerminals.push(win1, win2, win3);

      // Store issue data on terminals (first 3 map to beads issues)
      BEADS_ISSUES.forEach((issue, i) => {
        allTerminals[i]._issueId = issue.id;
        allTerminals[i]._issueIdx = i;
        allTerminals[i]._branchName = issue.branch;
      });

      await wait(2000); // let reorganization animations settle
      await phase3Activity();
    }

    // Phase 3 Part 2 — interactive issue closing with git graph updates
    async function phase3Activity() {
      // === AGENT OUTPUT POOLS ===
      const AGENT_OUTPUTS = {
        build: CC_OUTPUTS.deploy,
        test: CC_OUTPUTS.addTests,
        review: CC_OUTPUTS.security,
        refactor: CC_OUTPUTS.refactor,
        security: CC_OUTPUTS.fixAuth,
        docs: CC_OUTPUTS.docs,
        migrate: CC_OUTPUTS.migrateDb,
      };
      const poolKeys = ['build', 'test', 'review', 'refactor', 'security', 'docs', 'migrate'];

      // === NOTIFICATION CONTENT ===
      const PERMISSION_PROMPTS = [
        { path: './src/config/database.js', action: 'Edit' },
        { path: './migrations/003_add_roles.sql', action: 'Write' },
        { path: './src/middleware/auth.js', action: 'Edit' },
        { path: './.env.production', action: 'Read' },
        { path: './docker-compose.yml', action: 'Edit' },
        { path: './src/routes/webhooks.js', action: 'Edit' },
        { path: './tests/integration/auth.test.js', action: 'Write' },
        { path: './src/lib/search-engine.js', action: 'Edit' },
      ];
      const QUESTION_PROMPTS = [
        'Should I use TypeScript strict mode for the new files?',
        'The tests are failing on CI. Should I retry or investigate?',
        'Found 2 unused dependencies. Remove them?',
        'Database migration will alter 847 rows. Proceed?',
        'Merge conflict in auth.js — use our version or theirs?',
        'Found potential memory leak in event listeners. Auto-fix?',
        'Webhook retry queue has 12 pending items. Flush?',
      ];
      let permIdx = 0, questIdx = 0;

      // === USER TASK PROMPTS (typed after agent completes) ===
      const USER_TASK_PROMPTS = [
        'now fix the auth timeout in login handler',
        'investigate memory leak in reconnect flow',
        'add rate limiting to the API endpoints',
        'refactor the webhook retry logic',
        'run full integration test suite',
        'optimize the search indexer batch size',
        'fix the connection pool exhaustion bug',
        'update the OpenAPI spec for v2 routes',
      ];
      let userPromptIdx = 0;

      // === NOTIFICATION SYSTEM ===

      function showNotification(pane, type) {
        if (type === 'done' && pane._done) return; // already completed, no repeat
        stopClaudeOutput(pane);
        const existing = pane.querySelector('.notif-overlay');
        if (existing) existing.remove();

        const overlay = document.createElement('div');
        overlay.className = 'notif-overlay notif-' + type;
        overlay._type = type;

        const content = document.createElement('div');
        content.className = 'notif-content';

        if (type === 'permission') {
          const p = PERMISSION_PROMPTS[permIdx++ % PERMISSION_PROMPTS.length];
          content.innerHTML = '<span style="color:rgba(255,255,255,0.35)">\\u23BF  Allow ' + p.action + '</span> <span style="color:#79b8ff">' + p.path + '</span>';
          const actions = document.createElement('div');
          actions.className = 'notif-actions';
          actions.innerHTML = '<button class="notif-btn notif-btn-allow">Allow</button><button class="notif-btn notif-btn-deny">Deny</button>';
          overlay.appendChild(content);
          overlay.appendChild(actions);
        } else if (type === 'question') {
          const q = QUESTION_PROMPTS[questIdx++ % QUESTION_PROMPTS.length];
          content.innerHTML = '<span style="color:#e87b35">\\u2733</span> ' + q;
          const actions = document.createElement('div');
          actions.className = 'notif-actions';
          actions.innerHTML = '<button class="notif-btn notif-btn-yes">Yes</button><button class="notif-btn notif-btn-no">No</button>';
          overlay.appendChild(content);
          overlay.appendChild(actions);
        } else if (type === 'done') {
          const issueId = pane._issueId || '????';
          content.innerHTML = '<span style="color:#28c840">\\u2713</span> <span style="color:rgba(255,255,255,0.6)">Task completed</span><br><span style="color:rgba(255,255,255,0.4);font-size:10px">Close issue <span style="color:#6366f1">' + issueId + '</span>?</span>';
          const actions = document.createElement('div');
          actions.className = 'notif-actions';
          actions.innerHTML = '<button class="notif-btn notif-btn-yes">Yes</button><button class="notif-btn notif-btn-no">No</button>';
          overlay.appendChild(content);
          overlay.appendChild(actions);
        }

        pane.appendChild(overlay);
        overlay.offsetHeight;
        overlay.classList.add('active');
        return overlay;
      }

      function dismissNotification(pane) {
        const overlay = pane.querySelector('.notif-overlay');
        if (overlay) {
          overlay.classList.remove('active');
          setTimeout(() => overlay.remove(), 200);
        }
        const poolKey = poolKeys[allTerminals.indexOf(pane) % poolKeys.length];
        startClaudeOutput(pane, AGENT_OUTPUTS[poolKey], 450);
      }

      // === BEADS BADGE COUNT UPDATE ===
      function updateBeadsCounts() {
        if (!beadsPane) return;
        const openCount = beadsPane._body.querySelectorAll('.beads-status-open').length;
        const progressCount = beadsPane._body.querySelectorAll('.beads-status-progress').length;
        const openBadge = beadsPane._body.querySelector('.beads-badge-open');
        const progressBadge = beadsPane._body.querySelector('.beads-badge-progress');
        if (openBadge) openBadge.textContent = 'open ' + openCount;
        if (progressBadge) progressBadge.textContent = 'in progress ' + progressCount;
      }

      // === BEADS ISSUE CLOSE ===
      function closeBeadsIssue(index) {
        if (!beadsPane) return;
        const row = beadsPane._body.querySelector('tr[data-issue-idx="' + index + '"]');
        if (!row) return;

        // Change status icon to closed (filled circle, gray)
        const statusIcon = row.querySelector('.beads-status-icon');
        if (statusIcon) {
          statusIcon.className = 'beads-status-icon beads-status-closed';
          statusIcon.textContent = '\\u25CF';
        }

        // Strike through title
        const titleText = row.querySelector('.beads-title-text');
        if (titleText) titleText.style.textDecoration = 'line-through';

        // Flash green then slide out
        row.style.position = 'relative';
        Array.from(row.cells).forEach(td => {
          td.style.background = 'rgba(40,200,64,0.12)';
          td.style.transition = 'background 0.5s';
        });

        // Update counts immediately (status already changed to closed)
        updateBeadsCounts();

        setTimeout(() => {
          row.style.transition = 'all 0.6s ease';
          row.style.opacity = '0';
          row.style.transform = 'translateX(100%)';
          setTimeout(() => row.remove(), 700);
        }, 1000);
      }

      // === ADD BEADS ISSUE DYNAMICALLY ===
      function addBeadsIssue(text, color, issueIdx) {
        const tbody = beadsPane._body.querySelector('.beads-table tbody');
        if (!tbody) return;
        // Determine type from text prefix
        const isFeature = text.startsWith('feat:') || text.startsWith('feature:');
        const isBug = text.startsWith('fix:') || text.startsWith('bug:');
        const typeLabel = isBug ? 'bug' : isFeature ? 'feature' : 'task';
        const typeClass = 'beads-type-' + typeLabel;
        const priorities = ['P1', 'P2', 'P0', 'P2'];
        const pClasses = ['beads-p1', 'beads-p2', 'beads-p0', 'beads-p2'];
        const pi = issueIdx % priorities.length;
        const row = document.createElement('tr');
        row.className = 'beads-row';
        row.dataset.issueIdx = issueIdx;
        row.style.opacity = '0';
        row.style.transition = 'opacity 0.5s';
        row.innerHTML =
          '<td style="text-align:center"><span class="beads-status-icon beads-status-open">\\u25CB</span></td>' +
          '<td><span class="beads-priority ' + pClasses[pi] + '">' + priorities[pi] + '</span></td>' +
          '<td><span class="beads-type ' + typeClass + '">' + typeLabel + '</span></td>' +
          '<td><span class="beads-title-text">' + text + '</span></td>';
        tbody.appendChild(row);
        requestAnimationFrame(() => row.style.opacity = '1');
        updateBeadsCounts();
      }

      // === USER INPUT TYPING ===
      async function typeUserPrompt(term, text) {
        const line = document.createElement('div');
        line.style.marginTop = '4px';
        line.innerHTML = '<span style="color:#6366f1">\\u276F</span> <span style="color:rgba(255,255,255,0.8)"></span>';
        term._body.appendChild(line);
        const textEl = line.querySelector('span:last-child');
        await typeText(textEl, text, 30);
        await wait(300);
      }

      // === CLICK HELPERS ===
      async function clickBtn(btn) {
        if (!btn) return;
        await moveCursor(cursor, btn, 250);
        await wait(80);
        cursor.classList.add('clicking');
        await wait(100);
        cursor.classList.remove('clicking');
      }

      async function handleDone(termIdx) {
        const term = allTerminals[termIdx];
        term._done = true; // prevent future "done" on this terminal
        const yesBtn = term.querySelector('.notif-btn-yes');
        await clickBtn(yesBtn);
        // Dismiss overlay (don't restart output — user types first)
        const overlay = term.querySelector('.notif-overlay');
        if (overlay) {
          overlay.classList.remove('active');
          setTimeout(() => overlay.remove(), 200);
        }
        if (term._issueIdx !== undefined) {
          closeBeadsIssue(term._issueIdx);
          var mergeCol = gitEngine.getCol(term._branchName);
          if (mergeCol > 0) gitEngine.merge(mergeCol);
        }
        await wait(400);
        // User types a new task into this terminal
        const prompt = USER_TASK_PROMPTS[userPromptIdx++ % USER_TASK_PROMPTS.length];
        await typeUserPrompt(term, prompt);
        // Resume output (agent starts new task)
        const poolKey = poolKeys[allTerminals.indexOf(term) % poolKeys.length];
        startClaudeOutput(term, AGENT_OUTPUTS[poolKey], 450);
      }

      // === DRAG PANE WITH CURSOR ===
      async function dragPane(pane, newPos) {
        const header = pane.querySelector('.pane-header');
        await moveCursor(cursor, header, 300);
        await wait(80);
        cursor.classList.add('clicking');
        pane.style.zIndex = '50';
        pane.style.boxShadow = '0 0 30px rgba(99,102,241,0.25)';
        await wait(100);
        // Move pane (CSS transition on .pane handles animation)
        Object.assign(pane.style, newPos);
        // Track cursor to target header position
        const stageRect = stage.getBoundingClientRect();
        const tx = (parseFloat(newPos.left) / 100 * stageRect.width) + (parseFloat(newPos.width) / 100 * stageRect.width / 2);
        const ty = (parseFloat(newPos.top) / 100 * stageRect.height) + 16;
        const dur = 1 / SPEED;
        cursor.style.transition = 'left ' + dur + 's cubic-bezier(0.4,0,0.2,1), top ' + dur + 's cubic-bezier(0.4,0,0.2,1)';
        const cursorOnBody = cursor.parentNode === document.body;
        cursor.style.left = (cursorOnBody ? stageRect.left + tx : tx) + 'px';
        cursor.style.top = (cursorOnBody ? stageRect.top + ty : ty) + 'px';
        await wait(1050);
        cursor.classList.remove('clicking');
        // Restore speed-aware cursor transition
        cursor.style.transition = 'left ' + (0.4/SPEED) + 's cubic-bezier(0.4,0,0.2,1), top ' + (0.4/SPEED) + 's cubic-bezier(0.4,0,0.2,1)';
        pane.style.zIndex = '';
        pane.style.boxShadow = '';
      }

      // === ZOOM OUT ===
      async function zoomOut() {
        const agentLogo = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" fill="#e87b35" viewBox="0 0 16 16" style="vertical-align:-1px;margin-right:4px"><path d="m3.127 10.604 3.135-1.76.053-.153-.053-.085H6.11l-.525-.032-1.791-.048-1.554-.065-1.505-.08-.38-.081L0 7.832l.036-.234.32-.214.455.04 1.009.069 1.513.105 1.097.064 1.626.17h.259l.036-.105-.089-.065-.068-.064-1.566-1.062-1.695-1.121-.887-.646-.48-.327-.243-.306-.104-.67.435-.48.585.04.15.04.593.456 1.267.981 1.654 1.218.242.202.097-.068.012-.049-.109-.181-.9-1.626-.96-1.655-.428-.686-.113-.411a2 2 0 0 1-.068-.484l.496-.674L4.446 0l.662.089.279.242.411.94.666 1.48 1.033 2.014.302.597.162.553.06.17h.105v-.097l.085-1.134.157-1.392.154-1.792.052-.504.25-.605.497-.327.387.186.319.456-.045.294-.19 1.23-.37 1.93-.243 1.29h.142l.161-.16.654-.868 1.097-1.372.484-.545.565-.601.363-.287h.686l.505.751-.226.775-.707.895-.585.759-.839 1.13-.524.904.048.072.125-.012 1.897-.403 1.024-.186 1.223-.21.553.258.06.263-.218.536-1.307.323-1.533.307-2.284.54-.028.02.032.04 1.029.098.44.024h1.077l2.005.15.525.346.315.424-.053.323-.807.411-3.631-.863-.872-.218h-.12v.073l.726.71 1.331 1.202 1.667 1.55.084.383-.214.302-.226-.032-1.464-1.101-.565-.497-1.28-1.077h-.084v.113l.295.432 1.557 2.34.08.718-.112.234-.404.141-.444-.08-.911-1.28-.94-1.44-.759-1.291-.093.053-.448 4.821-.21.246-.484.186-.403-.307-.214-.496.214-.98.258-1.28.21-1.016.19-1.263.112-.42-.008-.028-.092.012-.953 1.307-1.448 1.957-1.146 1.227-.274.109-.477-.247.045-.44.266-.39 1.586-2.018.956-1.25.617-.723-.004-.105h-.036l-4.212 2.736-.75.096-.324-.302.04-.496.154-.162 1.267-.871z"/></svg>';
        const newTermKeys = [
          'terminal8', 'terminal9', 'terminal12', 'terminal13', 'terminal14',
          'terminal15', 'terminal11', 'terminal10'
        ];

        // Step 1: Move cursor to body so it isn't affected by stage transform
        if (cursor && cursor.parentNode === stage) {
          document.body.appendChild(cursor);
        }

        // Step 2: CSS zoom-out — scale the stage down, everything shrinks visually
        stage.style.transition = 'transform 1.5s cubic-bezier(0.4, 0, 0.2, 1)';
        stage.style.transformOrigin = 'top center';
        stage.style.transform = 'scale(0.65)';

        await wait(1600);

        // Step 3: Show + button and click it once
        const addBtn = document.createElement('button');
        addBtn.className = 'add-pane-btn';
        addBtn.textContent = '+';
        stage.appendChild(addBtn);
        requestAnimationFrame(() => addBtn.style.opacity = '1');
        await wait(400);

        await moveCursor(cursor, addBtn, 250);
        await wait(60);
        cursor.classList.add('clicking');
        await wait(80);
        cursor.classList.remove('clicking');

        // Create persistent ghost
        const ghost = document.createElement('div');
        ghost.className = 'placement-ghost';
        ghost.innerHTML = '<div class="placement-ghost-label">Terminal</div>';
        const firstLayout = CANVAS_LAYOUT_ZOOMED[newTermKeys[0]];
        ghost.style.width = firstLayout.width;
        ghost.style.height = firstLayout.height;
        ghost.style.top = '0.5%';
        ghost.style.left = '80%';
        ghost.style.opacity = '0';
        stage.appendChild(ghost);
        await wait(30);
        ghost.style.opacity = '1';

        // Step 4: Place 8 new terminals — ghost slides to each position
        const newTerminals = [];
        for (let i = 0; i < 8; i++) {
          const layout = CANVAS_LAYOUT_ZOOMED[newTermKeys[i]];

          // Resize ghost and slide to target — cursor moves in parallel
          ghost.style.width = layout.width;
          ghost.style.height = layout.height;
          requestAnimationFrame(() => {
            ghost.style.left = layout.left;
            ghost.style.top = layout.top;
          });

          // Move cursor to target center (compute from stage, not ghost's old position)
          var stageR = stage.getBoundingClientRect();
          var tLeft = parseFloat(layout.left) / 100 * stageR.width;
          var tTop = parseFloat(layout.top) / 100 * stageR.height;
          var tW = parseFloat(layout.width) / 100 * stageR.width;
          var tH = parseFloat(layout.height) / 100 * stageR.height;
          var d = 600 / SPEED;
          cursor.style.transitionDuration = d + 'ms';
          cursor.style.left = (stageR.left + tLeft + tW * 0.4) + 'px';
          cursor.style.top = (stageR.top + tTop + tH * 0.35) + 'px';
          await wait(700);

          // Brief hover before clicking
          await wait(150);

          // Click to place
          cursor.classList.add('clicking');
          await wait(100);
          cursor.classList.remove('clicking');

          // Real terminal appears under the ghost
          const t = createPane({ title: agentLogo + ' ' + NEW_AGENT_NAMES[i], tabs: [] });
          t.querySelectorAll('.dot').forEach(d => d.remove());
          t.style.opacity = '0';
          t._body.style.fontSize = '9px';
          Object.assign(t.style, layout);
          stage.appendChild(t);
          newTerminals.push(t);
          requestAnimationFrame(() => t.style.opacity = '1');
          const poolKey = poolKeys[(7 + i) % poolKeys.length];
          startClaudeOutput(t, AGENT_OUTPUTS[poolKey], 300 + i * 30);

          await wait(300);
        }

        // Remove ghost and + button
        ghost.style.opacity = '0';
        addBtn.style.opacity = '0';
        setTimeout(() => { ghost.remove(); addBtn.remove(); }, 400);
        terminal8 = newTerminals[0];
        terminal9 = newTerminals[1];
        terminal10 = newTerminals[2];
        terminal11 = newTerminals[3];
        terminal12 = newTerminals[4];
        terminal13 = newTerminals[5];
        terminal14 = newTerminals[6];
        terminal15 = newTerminals[7];

        // Step 4: Add all new terminals to allTerminals
        allTerminals.push(terminal8, terminal9, terminal10, terminal11, terminal12, terminal13, terminal14, terminal15);

        // Step 5: Assign beads issues to first 3 new terminals
        NEW_BEADS_ISSUES.forEach((issue, i) => {
          const t = newTerminals[i];
          t._issueId = issue.id;
          t._issueIdx = 3 + i;
          t._branchName = issue.branch;
          gitEngine.newBranch(issue.branch, issue.color);
        });

        // Step 6: Add 3 new beads issues to the pane (one by one)
        for (let i = 0; i < NEW_BEADS_ISSUES.length; i++) {
          addBeadsIssue(NEW_BEADS_ISSUES[i].text, NEW_BEADS_ISSUES[i].color, 3 + i);
          await wait(600);
        }
      }

      async function zoomOut2() {
        const agentLogo = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" fill="#e87b35" viewBox="0 0 16 16" style="vertical-align:-1px;margin-right:4px"><path d="m3.127 10.604 3.135-1.76.053-.153-.053-.085H6.11l-.525-.032-1.791-.048-1.554-.065-1.505-.08-.38-.081L0 7.832l.036-.234.32-.214.455.04 1.009.069 1.513.105 1.097.064 1.626.17h.259l.036-.105-.089-.065-.068-.064-1.566-1.062-1.695-1.121-.887-.646-.48-.327-.243-.306-.104-.67.435-.48.585.04.15.04.593.456 1.267.981 1.654 1.218.242.202.097-.068.012-.049-.109-.181-.9-1.626-.96-1.655-.428-.686-.113-.411a2 2 0 0 1-.068-.484l.496-.674L4.446 0l.662.089.279.242.411.94.666 1.48 1.033 2.014.302.597.162.553.06.17h.105v-.097l.085-1.134.157-1.392.154-1.792.052-.504.25-.605.497-.327.387.186.319.456-.045.294-.19 1.23-.37 1.93-.243 1.29h.142l.161-.16.654-.868 1.097-1.372.484-.545.565-.601.363-.287h.686l.505.751-.226.775-.707.895-.585.759-.839 1.13-.524.904.048.072.125-.012 1.897-.403 1.024-.186 1.223-.21.553.258.06.263-.218.536-1.307.323-1.533.307-2.284.54-.028.02.032.04 1.029.098.44.024h1.077l2.005.15.525.346.315.424-.053.323-.807.411-3.631-.863-.872-.218h-.12v.073l.726.71 1.331 1.202 1.667 1.55.084.383-.214.302-.226-.032-1.464-1.101-.565-.497-1.28-1.077h-.084v.113l.295.432 1.557 2.34.08.718-.112.234-.404.141-.444-.08-.911-1.28-.94-1.44-.759-1.291-.093.053-.448 4.821-.21.246-.484.186-.403-.307-.214-.496.214-.98.258-1.28.21-1.016.19-1.263.112-.42-.008-.028-.092.012-.953 1.307-1.448 1.957-1.146 1.227-.274.109-.477-.247.045-.44.266-.39 1.586-2.018.956-1.25.617-.723-.004-.105h-.036l-4.212 2.736-.75.096-.324-.302.04-.496.154-.162 1.267-.871z"/></svg>';
        const wave2Keys = [
          'terminal16', 'terminal17', 'terminal18', 'terminal19',
          'terminal20', 'terminal21', 'terminal22', 'terminal23'
        ];
        const DURATION = 3000;
        const t0 = Date.now();
        const baseSpeed = SPEED;

        // --- Ramp git speed linearly from 1x → 4x over 3s ---
        const rampInterval = setInterval(function() {
          var progress = Math.min((Date.now() - t0) / DURATION, 1);
          SPEED = baseSpeed * (1 + 3 * progress);
          if (progress >= 1) clearInterval(rampInterval);
        }, 50);

        // --- Zoom: 0.65 → 0.39 linearly over 3s ---
        stage.style.transition = 'transform ' + DURATION + 'ms linear';
        stage.style.transform = 'scale(0.39)';

        // --- Hide cursor ---
        cursor.style.display = 'none';

        // --- Place 8 terminals evenly over first 2.5s (wall-clock) ---
        var termSpacing = 2400 / 8; // ~300ms each
        for (var i = 0; i < 8; i++) {
          var layout = CANVAS_LAYOUT_ZOOMED3[wave2Keys[i]];
          var t = createPane({ title: agentLogo + ' ' + WAVE2_AGENT_NAMES[i], tabs: [] });
          t.querySelectorAll('.dot').forEach(function(d) { d.remove(); });
          t.style.opacity = '0';
          t._body.style.fontSize = '9px';
          Object.assign(t.style, layout);
          stage.appendChild(t);
          allTerminals.push(t);
          requestAnimationFrame(function(el) { return function() { el.style.opacity = '1'; }; }(t));
          var poolKey = poolKeys[(15 + i) % poolKeys.length];
          startClaudeOutput(t, AGENT_OUTPUTS[poolKey], 150 + i * 10);
          if (i < 7) await new Promise(function(r) { setTimeout(r, termSpacing); });
        }

        // --- Wait until t=2s mark, then start overlay ---
        var elapsed = Date.now() - t0;
        if (elapsed < 2000) {
          await new Promise(function(r) { setTimeout(r, 2000 - elapsed); });
        }

        // Dark overlay fades in over 1s on top of everything
        var overlay = document.createElement('div');
        overlay.id = 'zoom2-overlay';
        overlay.style.cssText = 'position:fixed;inset:0;background:rgb(13,13,24);z-index:9999;opacity:0;transition:opacity 1s ease;pointer-events:none;';
        document.body.appendChild(overlay);
        // Double rAF ensures browser paints opacity:0 before transitioning to 1
        await new Promise(function(r) {
          requestAnimationFrame(function() {
            requestAnimationFrame(function() {
              overlay.style.opacity = '1';
              r();
            });
          });
        });

        // Wait for the overlay fade-in to fully complete (1s)
        await new Promise(function(r) { setTimeout(r, 1000); });

        clearInterval(rampInterval);

        // --- Wind down (hidden behind overlay) ---
        stopGitCommits();
        stopRapidGitHistory();
        allTerminals.forEach(function(term) { stopClaudeOutput(term); });
        SPEED = 1;
      }

      // === SEQUENCE (~0.6s between each action) ===
      runNarration([
        'Get notified on input needed \\uD83D\\uDD11, \\u2705, \\u2754',
        'View git graph, changes, active issues (Beads)',
        'Edit files, save notes, paste images',
        'Multiple projects, repos, machines - single canvas',
        'That you can access from anywhere (YES, EVEN FROM MOBILE!!!)'
      ], 20000);
      setSpeed(2.4);

      // Create git branches for each agent's issue
      const branchColors = ['#79b8ff', '#a78bfa', '#f59e0b', '#10b981', '#ef4444'];
      allTerminals.forEach(function(term, i) {
        if (term._branchName) {
          gitEngine.newBranch(term._branchName, branchColors[i % branchColors.length]);
        }
      });

      // Start all 3 terminals outputting
      allTerminals.forEach((term, i) => {
        startClaudeOutput(term, AGENT_OUTPUTS[poolKeys[i]], 400 + i * 50);
      });
      startGitCommits(2000);

      await wait(1200);

      // Cursor appears
      cursor.style.display = '';
      cursor.style.left = '50%';
      cursor.style.top = '50%';

      // --- Wave 1: Notifications + interactions ---
      showNotification(allTerminals[0], 'permission');
      await wait(600);
      showNotification(allTerminals[2], 'question');
      await wait(600);

      await clickBtn(allTerminals[0].querySelector('.notif-btn-allow'));
      dismissNotification(allTerminals[0]);
      await wait(600);

      showNotification(allTerminals[1], 'done');
      await wait(600);

      await clickBtn(allTerminals[2].querySelector('.notif-btn-yes'));
      dismissNotification(allTerminals[2]);
      await wait(600);

      // Close #1 — terminal[1] (b3e1)
      await handleDone(1);
      await wait(600);

      // --- Resize demo: drag beads pane bottom edge down ---
      // Move cursor to bottom edge of beads pane
      (function() {
        var bRect = beadsPane.getBoundingClientRect();
        var cursorOnBody = cursor.parentNode === document.body;
        var baseX = cursorOnBody ? bRect.left : bRect.left - stage.getBoundingClientRect().left;
        var baseY = cursorOnBody ? bRect.bottom : bRect.bottom - stage.getBoundingClientRect().top;
        cursor.style.transitionDuration = (350 / SPEED) + 'ms';
        cursor.style.left = (baseX + bRect.width * 0.5) + 'px';
        cursor.style.top = (baseY - 2) + 'px';
      })();
      await wait(400);
      cursor.classList.add('clicking');
      await wait(100);

      // Animate beads pane growing + terminal1 shrinking
      beadsPane.style.transition = 'height 0.8s cubic-bezier(0.4, 0, 0.2, 1)';
      win1.style.transition = 'top 0.8s cubic-bezier(0.4, 0, 0.2, 1), height 0.8s cubic-bezier(0.4, 0, 0.2, 1)';
      beadsPane.style.height = 'calc((100vh - 60px) * 0.50)';
      win1.style.top = 'calc(40px + (100vh - 60px) * 0.50)';
      win1.style.height = 'calc((100vh - 60px) * 0.50)';

      // Drag cursor down with the edge
      (function() {
        var sRect = stage.getBoundingClientRect();
        var cursorOnBody = cursor.parentNode === document.body;
        var targetY = (0.50 * (sRect.height - 60) + 40);
        cursor.style.transitionDuration = (800 / SPEED) + 'ms';
        cursor.style.top = ((cursorOnBody ? sRect.top : 0) + targetY - 2) + 'px';
      })();
      await wait(900);
      cursor.classList.remove('clicking');
      await wait(400);

      // --- Wave 2 ---
      showNotification(allTerminals[2], 'permission');
      await wait(600);

      await clickBtn(allTerminals[2].querySelector('.notif-btn-allow'));
      dismissNotification(allTerminals[2]);
      await wait(600);

      // === ACCELERATE — 4.5x speed from here through end ===
      setSpeed(5.4);
      stopGitCommits();
      startGitCommits(800);

      // Close #2 — terminal[0] (a7f2) → triggers zoom
      showNotification(allTerminals[0], 'done');
      await wait(600);
      await handleDone(0);
      await wait(600);

      // === ZOOM OUT — 1 issue remains, scale up ===
      await zoomOut();

      // Switch to rapid-fire git history (independent of agent actions)
      stopGitCommits();
      startRapidGitHistory();

      // --- Post-zoom: cursor activity on new terminals ---
      showNotification(allTerminals[3], 'permission');
      await wait(600);
      await clickBtn(allTerminals[3].querySelector('.notif-btn-allow'));
      dismissNotification(allTerminals[3]);
      await wait(600);

      showNotification(allTerminals[4], 'permission');
      await wait(600);
      await clickBtn(allTerminals[4].querySelector('.notif-btn-allow'));
      dismissNotification(allTerminals[4]);
      await wait(600);

      // Close #3 — terminal[2] (c9d4) — last pre-zoom issue
      showNotification(allTerminals[2], 'done');
      await wait(600);
      await handleDone(2);
      await wait(600);

      showNotification(allTerminals[5], 'question');
      await wait(600);
      await clickBtn(allTerminals[5].querySelector('.notif-btn-yes'));
      dismissNotification(allTerminals[5]);
      await wait(600);

      showNotification(allTerminals[6], 'permission');
      await wait(600);
      await clickBtn(allTerminals[6].querySelector('.notif-btn-allow'));
      dismissNotification(allTerminals[6]);
      await wait(600);

      showNotification(allTerminals[7], 'question');
      await wait(600);
      await clickBtn(allTerminals[7].querySelector('.notif-btn-yes'));
      dismissNotification(allTerminals[7]);
      await wait(600);

      // --- Close new issues ---
      showNotification(allTerminals[3], 'done');
      await wait(600);
      await handleDone(3);
      await wait(600);

      showNotification(allTerminals[4], 'done');
      await wait(600);
      await handleDone(4);
      await wait(600);

      showNotification(allTerminals[5], 'done');
      await wait(600);
      await handleDone(5);
      await wait(600);

      await wait(2000);
      stopNarration();

      // === SECOND ZOOM OUT — 3s crescendo with overlay ===
      await zoomOut2();
    }
    async function phase4CTA() {
      // zoomOut2 already created an opaque overlay — clear stage behind it
      var overlay = document.getElementById('zoom2-overlay');
      stage.innerHTML = '';
      stage.style.transform = '';
      stage.style.transition = '';
      stage.classList.remove('dot-grid');

      // Add floating orbs (ambient background)
      const orbColors = [
        'rgba(99, 102, 241, 0.04)',   // indigo
        'rgba(139, 92, 246, 0.03)',   // violet
        'rgba(168, 130, 255, 0.03)',  // lavender
      ];

      for (let i = 0; i < 3; i++) {
        const orb = document.createElement('div');
        const size = 400 + Math.random() * 200; // 400-600px
        orb.style.cssText = \`
          position: absolute;
          width: \${size}px;
          height: \${size}px;
          border-radius: 50%;
          background: radial-gradient(circle, \${orbColors[i]}, transparent 70%);
          filter: blur(40px);
          pointer-events: none;
          animation: orbDrift\${i} \${15 + i * 5}s ease-in-out infinite;
        \`;
        // Random starting positions
        orb.style.left = (20 + i * 25) + '%';
        orb.style.top = (10 + i * 30) + '%';
        stage.appendChild(orb);
      }

      // Build CTA content
      const cta = document.createElement('div');
      cta.style.cssText = \`
        position: absolute;
        inset: 0;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 28px;
        z-index: 10;
      \`;

      // Logo
      const logoWrap = document.createElement('div');
      logoWrap.style.cssText = 'display:flex;align-items:center;gap:14px;opacity:0;transform:translateY(15px);transition:all 0.6s cubic-bezier(0.4,0,0.2,1);';

      const logoEl = document.createElement('div');
      logoEl.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="535" zoomAndPan="magnify" viewBox="0 0 401.25 474.749981" height="633" preserveAspectRatio="xMidYMid meet" version="1.0"><defs><clipPath id="d9bec29a80"><path d="M 196 0.316406 L 397 0.316406 L 397 43 L 196 43 Z M 196 0.316406 " clip-rule="nonzero"/></clipPath><clipPath id="f044737dff"><path d="M 0 160 L 400.5 160 L 400.5 474.183594 L 0 474.183594 Z M 0 160 " clip-rule="nonzero"/></clipPath><clipPath id="3557e725c5"><path d="M 0 163 L 400.5 163 L 400.5 474.183594 L 0 474.183594 Z M 0 163 " clip-rule="nonzero"/></clipPath><clipPath id="cb4f023696"><path d="M 0 0.316406 L 386 0.316406 L 386 355 L 0 355 Z M 0 0.316406 " clip-rule="nonzero"/></clipPath><clipPath id="746361bbce"><path d="M 0 163 L 400.5 163 L 400.5 474.183594 L 0 474.183594 Z M 0 163 " clip-rule="nonzero"/></clipPath></defs><path stroke-linecap="round" transform="matrix(0, -0.748601, 0.748601, 0, 195.64152, 231.206551)" fill="none" stroke-linejoin="miter" d="M 28.50045 28.499897 L 277.235351 28.499897 " stroke="#ffffff" stroke-width="57" stroke-opacity="1" stroke-miterlimit="4"/><path stroke-linecap="round" transform="matrix(0, -0.748601, 0.748601, 0, 357.320924, 219.462948)" fill="none" stroke-linejoin="miter" d="M 28.498559 28.500274 L 261.547946 28.500274 " stroke="#ffffff" stroke-width="57" stroke-opacity="1" stroke-miterlimit="4"/><g clip-path="url(#d9bec29a80)"><path stroke-linecap="round" transform="matrix(-0.748601, 0, 0, -0.748601, 396.706561, 42.988328)" fill="none" stroke-linejoin="miter" d="M 28.500464 28.501154 L 238.496423 28.501154 " stroke="#ffffff" stroke-width="57" stroke-opacity="1" stroke-miterlimit="4"/></g><path stroke-linecap="round" transform="matrix(-0.748601, 0, 0, -0.748601, 390.074426, 233.078491)" fill="none" stroke-linejoin="miter" d="M 28.501369 28.50158 L 229.626611 28.50158 " stroke="#ffffff" stroke-width="57" stroke-opacity="1" stroke-miterlimit="4"/><path stroke-linecap="round" transform="matrix(0, -0.748601, 0.748601, 0, 357.320896, 416.934388)" fill="none" stroke-linejoin="miter" d="M 28.502153 28.500313 L 317.797102 28.500313 " stroke="#ffffff" stroke-width="57" stroke-opacity="1" stroke-miterlimit="4"/><g clip-path="url(#f044737dff)"><path stroke-linecap="round" transform="matrix(-0.748557, 0.00806718, -0.00806718, -0.748557, 400.348359, 422.803921)" fill="none" stroke-linejoin="miter" d="M 28.499196 28.500973 L 236.691355 28.500754 " stroke="#ffffff" stroke-width="57" stroke-opacity="1" stroke-miterlimit="4"/></g><g clip-path="url(#3557e725c5)"><path stroke-linecap="round" transform="matrix(-0.3743, -0.648307, 0.648307, -0.3743, 237.676049, 474.134406)" fill="none" stroke-linejoin="miter" d="M 28.502673 28.500203 L 90.351143 28.502465 " stroke="#ffffff" stroke-width="57" stroke-opacity="1" stroke-miterlimit="4"/></g><path stroke-linecap="round" transform="matrix(0, -0.748601, 0.748601, 0, -0.00581417, 299.919264)" fill="none" stroke-linejoin="miter" d="M 28.497604 28.498422 L 369.028771 28.498422 " stroke="#ffffff" stroke-width="57" stroke-opacity="1" stroke-miterlimit="4"/><path stroke-linecap="round" transform="matrix(-0.748601, 0, 0, -0.748601, 211.660712, 303.834592)" fill="none" stroke-linejoin="miter" d="M 28.501835 28.499294 L 253.640629 28.499294 " stroke="#ffffff" stroke-width="57" stroke-opacity="1" stroke-miterlimit="4"/><path stroke-linecap="round" transform="matrix(0, -0.748601, 0.748601, 0, 124.947249, 420.723458)" fill="none" stroke-linejoin="miter" d="M 28.502162 28.498504 L 404.197894 28.498504 " stroke="#ffffff" stroke-width="57" stroke-opacity="1" stroke-miterlimit="4"/><g clip-path="url(#cb4f023696)"><path stroke-linecap="round" transform="matrix(-0.3743, -0.648307, 0.648307, -0.3743, 135.951622, 142.759668)" fill="none" stroke-linejoin="miter" d="M 28.497276 28.499817 L 90.352873 28.500169 " stroke="#ffffff" stroke-width="57" stroke-opacity="1" stroke-miterlimit="4"/></g><g clip-path="url(#746361bbce)"><path stroke-linecap="round" transform="matrix(-0.3743, -0.648307, 0.648307, -0.3743, 165.050317, 474.134406)" fill="none" stroke-linejoin="miter" d="M 28.502184 28.501049 L 90.353263 28.498793 " stroke="#ffffff" stroke-width="57" stroke-opacity="1" stroke-miterlimit="4"/></g></svg>';
      logoEl.style.cssText = 'height:144px;';
      logoEl.querySelector('svg').style.cssText = 'height:144px;width:auto;';

      logoWrap.appendChild(logoEl);
      cta.appendChild(logoWrap);

      // Tagline
      const tagline = document.createElement('p');
      tagline.textContent = 'All your work, Any device, One canvas';
      tagline.style.cssText = \`
        font-family: 'Montserrat', sans-serif;
        font-weight: 300;
        font-size: 22px;
        color: rgba(255, 255, 255, 0.7);
        text-align: center;
        max-width: 500px;
        opacity: 0;
        transform: translateY(15px);
        transition: all 0.6s cubic-bezier(0.4, 0, 0.2, 1);
      \`;
      cta.appendChild(tagline);

      stage.appendChild(cta);

      // Fade out the zoom2 overlay to reveal logo
      if (overlay) {
        overlay.style.transition = 'opacity 0.8s ease';
        overlay.style.opacity = '0';
        setTimeout(function() { overlay.remove(); }, 900);
      }

      // Staggered fade-in of each element
      await wait(200);
      logoWrap.style.opacity = '1';
      logoWrap.style.transform = 'translateY(0)';

      await wait(300);
      tagline.style.opacity = '1';
      tagline.style.transform = 'translateY(0)';
    }

    // --- Main ---

    // Quick setup — creates panes instantly for testing phase 3+
    async function quickSetup() {
      const claudeLogo = '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" fill="#e87b35" viewBox="0 0 16 16" style="vertical-align:-1px;margin-right:4px"><path d="m3.127 10.604 3.135-1.76.053-.153-.053-.085H6.11l-.525-.032-1.791-.048-1.554-.065-1.505-.08-.38-.081L0 7.832l.036-.234.32-.214.455.04 1.009.069 1.513.105 1.097.064 1.626.17h.259l.036-.105-.089-.065-.068-.064-1.566-1.062-1.695-1.121-.887-.646-.48-.327-.243-.306-.104-.67.435-.48.585.04.15.04.593.456 1.267.981 1.654 1.218.242.202.097-.068.012-.049-.109-.181-.9-1.626-.96-1.655-.428-.686-.113-.411a2 2 0 0 1-.068-.484l.496-.674L4.446 0l.662.089.279.242.411.94.666 1.48 1.033 2.014.302.597.162.553.06.17h.105v-.097l.085-1.134.157-1.392.154-1.792.052-.504.25-.605.497-.327.387.186.319.456-.045.294-.19 1.23-.37 1.93-.243 1.29h.142l.161-.16.654-.868 1.097-1.372.484-.545.565-.601.363-.287h.686l.505.751-.226.775-.707.895-.585.759-.839 1.13-.524.904.048.072.125-.012 1.897-.403 1.024-.186 1.223-.21.553.258.06.263-.218.536-1.307.323-1.533.307-2.284.54-.028.02.032.04 1.029.098.44.024h1.077l2.005.15.525.346.315.424-.053.323-.807.411-3.631-.863-.872-.218h-.12v.073l.726.71 1.331 1.202 1.667 1.55.084.383-.214.302-.226-.032-1.464-1.101-.565-.497-1.28-1.077h-.084v.113l.295.432 1.557 2.34.08.718-.112.234-.404.141-.444-.08-.911-1.28-.94-1.44-.759-1.291-.093.053-.448 4.821-.21.246-.484.186-.403-.307-.214-.496.214-.98.258-1.28.21-1.016.19-1.263.112-.42-.008-.028-.092.012-.953 1.307-1.448 1.957-1.146 1.227-.274.109-.477-.247.045-.44.266-.39 1.586-2.018.956-1.25.617-.723-.004-.105h-.036l-4.212 2.736-.75.096-.324-.302.04-.496.154-.162 1.267-.871z"/></svg>';
      const ccTab = () => claudeLogo + 'Claude Code';
      const qsGitGraph = '<div id="git-graph" class="git-graph-container">' +
        '<div class="git-graph-header">' +
          '<span class="git-graph-branch"><span class="git-graph-branch-name">master</span></span>' +
          '<span class="git-graph-status"><span class="git-graph-clean">\\u25CF clean</span></span>' +
          '<button class="git-graph-push-btn">\\u2191 Push</button>' +
        '</div>' +
        '<pre class="git-graph-output"></pre></div>';
      win1 = createPane({ title: 'Claude Code', tabs: [{ label: ccTab(), active: true, content: 'Reading src/middleware/auth.js...' }, { label: ccTab(), content: '' }], style: { width: '44vw', height: '42vh', top: '2%', left: '2%', zIndex: 3 } });
      win2 = createPane({ title: 'Claude Code', tabs: [{ label: ccTab(), active: true, content: 'Deploying to staging...' }, { label: ccTab(), content: '' }], style: { width: '44vw', height: '42vh', top: '18%', left: '14%', zIndex: 2 } });
      win3 = createPane({ title: 'Claude Code', tabs: [{ label: ccTab(), active: true, content: 'Scanning vulnerabilities...' }, { label: ccTab(), content: '' }], style: { width: '42vw', height: '40vh', top: '36%', left: '6%', zIndex: 1 } });
      win4 = createPane({ title: 'Claude Code', tabs: [{ label: ccTab(), active: true, content: 'Optimizing queries...' }, { label: ccTab(), content: '' }], style: { width: '42vw', height: '42vh', top: '12%', left: '48%', zIndex: 4 } });
      win5 = createPane({ title: 'Project', tabs: [{ label: 'issues', active: true, content: '' }, { label: 'git graph', content: qsGitGraph }], style: { width: '40vw', height: '50vh', top: '30%', left: '52%', zIndex: 5 } });
      win6 = createPane({ title: 'src/services/userService.ts', tabs: [] });
      Object.assign(win6.style, { width: '58vw', height: '72vh', top: '14%', left: '22%', zIndex: 0, opacity: '0.6' });
      stage.appendChild(win6); stage.appendChild(win1); stage.appendChild(win2); stage.appendChild(win3); stage.appendChild(win4); stage.appendChild(win5);
      cursor = document.createElement('div');
      cursor.className = 'fake-cursor';
      cursor.style.display = 'none';
      cursor.style.left = '50%';
      cursor.style.top = '50%';
    }

    async function runAnimation() {
      await wait(500);
      await phase1Clutter();
      await phase2Install();
      await phase3Transform();
      await phase4CTA();
    }

    // --- postMessage API for embedded usage ---
    window.addEventListener('message', (e) => {
      if (e.data === 'play') runAnimation();
      if (e.data === 'replay') {
        document.getElementById('stage').innerHTML = '';
        if (cursor && cursor.parentNode) cursor.parentNode.removeChild(cursor);
        cursor = null;
        initPanes();
        runAnimation();
      }
      if (e.data && e.data.type === 'setSpeed') setSpeed(e.data.speed);
    });

    window.addEventListener('load', () => {
      runAnimation();
    });
  </script>
</body>
</html>
`;

customElements.define('agent-animation', AgentAnimation);
