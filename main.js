// {{Wikipedia:USync |repo=https://github.com/alex-o-748/citation-checker-script |ref=refs/heads/dev|path=main.js}}
//Inspired by  User:Polygnotus/Scripts/AI_Source_Verification.js
//Inspired by  User:Phlsph7/SourceVerificationAIAssistant.js

(function() {
    'use strict';
    
    class WikipediaSourceVerifier {
        constructor() {
            this.providers = {
                publicai: {
                    name: 'PublicAI (Free)',
                    storageKey: null, // No key needed - uses built-in key
                    color: '#6B21A8', // Purple for PublicAI
                    model: 'aisingapore/Qwen-SEA-LION-v4-32B-IT',
                    requiresKey: false
                },
                claude: {
                    name: 'Claude',
                    storageKey: 'claude_api_key',
                    color: '#0645ad',
                    model: 'claude-sonnet-4-20250514',
                    requiresKey: true
                },
                gemini: {
                    name: 'Gemini',
                    storageKey: 'gemini_api_key',
                    color: '#4285F4',
                    model: 'gemini-flash-latest',
                    requiresKey: true
                },
                openai: {
                    name: 'ChatGPT',
                    storageKey: 'openai_api_key',
                    color: '#10a37f',
                    model: 'gpt-4o',
                    requiresKey: true
                }
            };
            
            // Handle migration from old 'apertus' name to 'publicai'
            let storedProvider = localStorage.getItem('source_verifier_provider');
            if (storedProvider === 'apertus') {
                storedProvider = 'publicai';
                localStorage.setItem('source_verifier_provider', 'publicai');
            }
            this.currentProvider = storedProvider || 'publicai';
            this.sidebarWidth = localStorage.getItem('verifier_sidebar_width') || '400px';
            this.isVisible = localStorage.getItem('verifier_sidebar_visible') === 'true';
            this.buttons = {};
            this.activeClaim = null;
            this.activeSource = null;
            this.activeSourceUrl = null;
            this.activeCitationNumber = null;
            this.activeRefElement = null;
            this.currentFetchId = 0;
            this.currentVerifyId = 0;

            this.sourceTextInput = null;

            // Article report state
            this.reportMode = false;
            this.reportCancelled = false;
            this.reportRunning = false;
            this.reportResults = [];
            this.sourceCache = new Map();
            this.reportTokenUsage = { input: 0, output: 0 };
            this.hasReport = false;

            this.init();
        }
        
        init() {
            if (mw.config.get('wgAction') !== 'view') return;

            this.loadOOUI().then(() => {
                this.createUI();
                this.attachEventListeners();
                this.attachReferenceClickHandlers();
                this.adjustMainContent();
            });
        }
        
        async loadOOUI() {
            await mw.loader.using(['oojs-ui-core', 'oojs-ui-widgets', 'oojs-ui-windows']);
        }
        
        getCurrentApiKey() {
            const provider = this.providers[this.currentProvider];
            if (provider.builtInKey) {
                return provider.builtInKey;
            }
            return localStorage.getItem(provider.storageKey);
        }
        
        setCurrentApiKey(key) {
            const provider = this.providers[this.currentProvider];
            if (provider.storageKey) {
                localStorage.setItem(provider.storageKey, key);
            }
        }
        
        removeCurrentApiKey() {
            const provider = this.providers[this.currentProvider];
            if (provider.storageKey) {
                localStorage.removeItem(provider.storageKey);
            }
        }
        
        getCurrentColor() {
            return this.providers[this.currentProvider].color;
        }
        
        providerRequiresKey() {
            return this.providers[this.currentProvider].requiresKey;
        }
        
        createUI() {
            const sidebar = document.createElement('div');
            sidebar.id = 'source-verifier-sidebar';
            
            this.createOOUIButtons();
            
            sidebar.innerHTML = `
                <div id="verifier-sidebar-header">
                    <h3><a href="https://en.wikipedia.org/wiki/User:Alaexis/AI_Source_Verification" target="_blank" id="verifier-title-link">Source Verifier</a></h3>
                    <div id="verifier-sidebar-controls">
                        <div id="verifier-close-btn-container"></div>
                    </div>
                </div>
                <div id="verifier-sidebar-content">
                    <div id="verifier-controls">
                        <div id="verifier-provider-container"></div>
                        <div id="verifier-provider-info"></div>
                        <div id="verifier-buttons-container"></div>
                    </div>
                    <div id="verifier-claim-section">
                        <h4>Selected Claim</h4>
                        <div id="verifier-claim-text">Click on a reference number [1] next to a claim to verify it against its source.</div>
                    </div>
                    <div id="verifier-source-section">
                        <h4>Source Content</h4>
                        <div id="verifier-source-text">No source loaded yet.</div>
                        <div id="verifier-source-input-container" style="display: none; margin-top: 10px;">
                            <div id="verifier-source-textarea-container"></div>
                            <div id="verifier-source-buttons" style="margin-top: 8px; display: flex; gap: 8px;">
                                <div id="verifier-load-text-btn-container" style="flex: 1;"></div>
                                <div id="verifier-cancel-text-btn-container" style="flex: 1;"></div>
                            </div>
                        </div>
                    </div>
                    <div id="verifier-results">
                        <h4>Verification Result</h4>
                        <div id="verifier-verdict"></div>
                        <div id="verifier-comments"></div>
                        <div id="verifier-action-container"></div>
                    </div>
                    <div id="verifier-report-view" style="display:none;">
                        <div id="verifier-report-progress"></div>
                        <div id="verifier-report-summary"></div>
                        <div id="verifier-report-results"></div>
                        <div id="verifier-report-actions"></div>
                    </div>
                </div>
                <div id="verifier-resize-handle"></div>
            `;
            
            this.createVerifierTab();
            this.createStyles();
            document.body.append(sidebar);
            
            this.appendOOUIButtons();
            
            if (!this.isVisible) {
                this.hideSidebar();
            }
            
            this.makeResizable();
        }
        
        createStyles() {
            const style = document.createElement('style');
            style.textContent = `
                #source-verifier-sidebar {
                    position: fixed;
                    top: 0;
                    right: 0;
                    width: ${this.sidebarWidth};
                    height: 100vh;
                    background: #fff;
                    border-left: 2px solid ${this.getCurrentColor()};
                    box-shadow: -2px 0 8px rgba(0,0,0,0.1);
                    z-index: 10000;
                    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
                    font-size: 14px;
                    display: flex;
                    flex-direction: column;
                    transition: all 0.3s ease;
                }
                #verifier-sidebar-header {
                    background: ${this.getCurrentColor()};
                    color: white;
                    padding: 12px 15px;
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    flex-shrink: 0;
                }
                #verifier-sidebar-header h3 {
                    margin: 0;
                    font-size: 16px;
                }
                #verifier-sidebar-controls {
                    display: flex;
                    gap: 8px;
                }
                #verifier-sidebar-content {
                    padding: 15px;
                    flex: 1;
                    overflow-y: auto;
                    display: flex;
                    flex-direction: column;
                    gap: 15px;
                }
                #verifier-controls {
                    flex-shrink: 0;
                }
                #verifier-provider-container {
                    margin-bottom: 10px;
                }
                #verifier-provider-info {
                    font-size: 12px;
                    color: #666;
                    margin-bottom: 10px;
                    padding: 8px;
                    background: #f8f9fa;
                    border-radius: 4px;
                }
                #verifier-provider-info.free-provider {
                    background: #e8f5e9;
                    color: #2e7d32;
                }
                #verifier-buttons-container {
                    display: flex;
                    flex-direction: column;
                    gap: 8px;
                }
                #verifier-buttons-container .oo-ui-buttonElement {
                    width: 100%;
                }
                #verifier-buttons-container .oo-ui-buttonElement-button {
                    width: 100%;
                    justify-content: center;
                }
                #verifier-claim-section, #verifier-source-section, #verifier-results {
                    flex-shrink: 0;
                }
                #verifier-claim-section h4, #verifier-source-section h4, #verifier-results h4 {
                    margin: 0 0 8px 0;
                    color: ${this.getCurrentColor()};
                    font-size: 14px;
                    font-weight: bold;
                }
                #verifier-claim-text, #verifier-source-text {
                    padding: 10px;
                    background: #f8f9fa;
                    border: 1px solid #ddd;
                    border-radius: 4px;
                    font-size: 13px;
                    line-height: 1.4;
                    max-height: 120px;
                    overflow-y: auto;
                }
                #verifier-source-input-container {
                    margin-top: 10px;
                }
                #verifier-source-textarea-container .oo-ui-inputWidget {
                    width: 100%;
                }
                #verifier-source-textarea-container textarea {
                    min-height: 120px;
                    font-size: 13px;
                    font-family: monospace;
                }
                #verifier-verdict {
                    padding: 12px;
                    border-radius: 4px;
                    font-size: 14px;
                    font-weight: bold;
                    text-align: center;
                    margin-bottom: 10px;
                }
                #verifier-verdict.supported {
                    background: #d4edda;
                    color: #155724;
                    border: 1px solid #c3e6cb;
                }
                #verifier-verdict.partially-supported {
                    background: #fff3cd;
                    color: #856404;
                    border: 1px solid #ffeeba;
                }
                #verifier-verdict.not-supported {
                    background: #f8d7da;
                    color: #721c24;
                    border: 1px solid #f5c6cb;
                }
                #verifier-verdict.source-unavailable {
                    background: #e2e3e5;
                    color: #383d41;
                    border: 1px solid #d6d8db;
                }
                #verifier-comments {
                    padding: 10px;
                    background: #fafafa;
                    border: 1px solid #ddd;
                    border-radius: 4px;
                    font-size: 13px;
                    line-height: 1.5;
                    max-height: 300px;
                    overflow-y: auto;
                }
                #verifier-action-container {
                    margin-top: 10px;
                }
                #verifier-action-container .oo-ui-buttonElement {
                    width: 100%;
                }
                #verifier-title-link {
                    color: white;
                    text-decoration: none;
                }
                #verifier-title-link:hover {
                    text-decoration: underline;
                }
                #verifier-action-container .oo-ui-buttonElement-button {
                    width: 100%;
                    justify-content: center;
                }
                .verifier-action-hint {
                    font-size: 11px;
                    color: #888;
                    margin-top: 4px;
                    text-align: center;
                }
                #verifier-resize-handle {
                    position: absolute;
                    left: 0;
                    top: 0;
                    width: 4px;
                    height: 100%;
                    background: transparent;
                    cursor: ew-resize;
                    z-index: 10001;
                }
                #verifier-resize-handle:hover {
                    background: ${this.getCurrentColor()};
                    opacity: 0.5;
                }
                #ca-verifier, #t-verifier {
                    display: none;
                }
                #ca-verifier a, #t-verifier a {
                    color: ${this.getCurrentColor()} !important;
                    text-decoration: none !important;
                }
                #ca-verifier a:hover, #t-verifier a:hover {
                    text-decoration: underline !important;
                }
                body {
                    margin-right: ${this.isVisible ? this.sidebarWidth : '0'};
                    transition: margin-right 0.3s ease;
                }
                .verifier-error {
                    color: #d33;
                    background: #fef2f2;
                    border: 1px solid #fecaca;
                    padding: 8px;
                    border-radius: 4px;
                }
                body.verifier-sidebar-hidden {
                    margin-right: 0 !important;
                }
                body.verifier-sidebar-hidden #source-verifier-sidebar {
                    display: none;
                }
                body.verifier-sidebar-hidden #ca-verifier,
                body.verifier-sidebar-hidden #t-verifier {
                    display: list-item !important;
                }
                /* Report view styles */
                #verifier-report-view h4 {
                    margin: 0 0 8px 0;
                    color: ${this.getCurrentColor()};
                    font-size: 14px;
                    font-weight: bold;
                }
                #verifier-report-progress {
                    margin-bottom: 12px;
                }
                .verifier-progress-bar {
                    width: 100%;
                    height: 8px;
                    background: #e0e0e0;
                    border-radius: 4px;
                    overflow: hidden;
                    margin-bottom: 6px;
                }
                .verifier-progress-fill {
                    height: 100%;
                    background: ${this.getCurrentColor()};
                    transition: width 0.3s ease;
                    border-radius: 4px;
                }
                .verifier-progress-text {
                    font-size: 12px;
                    color: #666;
                }
                #verifier-report-summary {
                    padding: 10px;
                    background: #f8f9fa;
                    border: 1px solid #ddd;
                    border-radius: 4px;
                    font-size: 13px;
                    margin-bottom: 12px;
                }
                .verifier-summary-bar {
                    display: flex;
                    height: 6px;
                    border-radius: 3px;
                    overflow: hidden;
                    margin-bottom: 8px;
                }
                .verifier-summary-bar .seg-supported { background: #28a745; }
                .verifier-summary-bar .seg-partial { background: #ffc107; }
                .verifier-summary-bar .seg-not-supported { background: #dc3545; }
                .verifier-summary-bar .seg-unavailable { background: #6c757d; }
                .verifier-summary-bar .seg-error { background: #adb5bd; }
                .verifier-summary-counts {
                    display: flex;
                    flex-wrap: wrap;
                    gap: 8px;
                    font-size: 12px;
                }
                .verifier-summary-counts span {
                    display: inline-flex;
                    align-items: center;
                    gap: 4px;
                }
                .verifier-summary-counts .dot {
                    width: 8px;
                    height: 8px;
                    border-radius: 50%;
                    display: inline-block;
                }
                #verifier-report-results {
                    display: flex;
                    flex-direction: column;
                    gap: 6px;
                    max-height: 50vh;
                    overflow-y: auto;
                    margin-bottom: 12px;
                }
                .verifier-report-card {
                    padding: 8px 10px;
                    border: 1px solid #ddd;
                    border-radius: 4px;
                    font-size: 12px;
                    cursor: pointer;
                    background: #fff;
                    border-left: 3px solid #ccc;
                }
                .verifier-report-card:hover {
                    background: #f0f4ff;
                }
                .verifier-report-card.verdict-supported { border-left-color: #28a745; }
                .verifier-report-card.verdict-partial { border-left-color: #ffc107; }
                .verifier-report-card.verdict-not-supported { border-left-color: #dc3545; }
                .verifier-report-card.verdict-unavailable { border-left-color: #6c757d; }
                .verifier-report-card.verdict-error { border-left-color: #adb5bd; }
                .report-card-header {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    margin-bottom: 4px;
                }
                .report-card-citation {
                    font-weight: bold;
                }
                .report-card-verdict {
                    font-weight: bold;
                    font-size: 11px;
                    padding: 1px 6px;
                    border-radius: 3px;
                }
                .report-card-verdict.supported { background: #d4edda; color: #155724; }
                .report-card-verdict.partial { background: #fff3cd; color: #856404; }
                .report-card-verdict.not-supported { background: #f8d7da; color: #721c24; }
                .report-card-verdict.unavailable { background: #e2e3e5; color: #383d41; }
                .report-card-verdict.error { background: #e2e3e5; color: #383d41; }
                .report-card-claim {
                    color: #555;
                    font-size: 11px;
                    margin-bottom: 2px;
                    white-space: nowrap;
                    overflow: hidden;
                    text-overflow: ellipsis;
                }
                .report-card-comment {
                    color: #666;
                    font-size: 11px;
                    font-style: italic;
                }
                #verifier-report-actions {
                    display: flex;
                    flex-direction: column;
                    gap: 8px;
                }
                #verifier-report-actions .oo-ui-buttonElement {
                    width: 100%;
                }
                #verifier-report-actions .oo-ui-buttonElement-button {
                    width: 100%;
                    justify-content: center;
                }

                .reference:hover {
                    background-color: #e6f3ff;
                    cursor: pointer;
                }
                .reference.verifier-active {
                    background-color: ${this.getCurrentColor()};
                    color: white;
                }
                .claim-highlight {
                    background-color: #fff3cd;
                    border-left: 3px solid ${this.getCurrentColor()};
                    padding-left: 5px;
                    margin-left: -8px;
                }

                /* Dark theme overrides for Wikipedia night mode */
                html.skin-theme-clientpref-night #source-verifier-sidebar {
                    background: #1a1a2e !important;
                    color: #e0e0e0 !important;
                    border-left-color: ${this.getCurrentColor()} !important;
                    box-shadow: -2px 0 8px rgba(0,0,0,0.4) !important;
                }
                html.skin-theme-clientpref-night #source-verifier-sidebar * {
                    color: inherit;
                }
                html.skin-theme-clientpref-night #verifier-sidebar-header {
                    background: ${this.getCurrentColor()} !important;
                    color: white !important;
                }
                html.skin-theme-clientpref-night #verifier-sidebar-header * {
                    color: white !important;
                }
                html.skin-theme-clientpref-night #verifier-sidebar-content {
                    background: #1a1a2e !important;
                    color: #e0e0e0 !important;
                }
                html.skin-theme-clientpref-night #verifier-provider-info {
                    background: #2a2a3e !important;
                    color: #b0b0c0 !important;
                    border-color: #3a3a4e !important;
                }
                html.skin-theme-clientpref-night #verifier-provider-info.free-provider {
                    background: #1a2e1a !important;
                    color: #6ecf6e !important;
                }
                html.skin-theme-clientpref-night #verifier-claim-section h4,
                html.skin-theme-clientpref-night #verifier-source-section h4,
                html.skin-theme-clientpref-night #verifier-results h4 {
                    color: ${this.getCurrentColor()} !important;
                    filter: brightness(1.3);
                }
                html.skin-theme-clientpref-night #verifier-claim-text,
                html.skin-theme-clientpref-night #verifier-source-text {
                    background: #2a2a3e !important;
                    border-color: #3a3a4e !important;
                    color: #e0e0e0 !important;
                }
                html.skin-theme-clientpref-night #verifier-verdict {
                    color: #e0e0e0 !important;
                }
                html.skin-theme-clientpref-night #verifier-verdict.supported {
                    background: #1a3a1a !important;
                    color: #6ecf6e !important;
                    border-color: #2a5a2a !important;
                }
                html.skin-theme-clientpref-night #verifier-verdict.partially-supported {
                    background: #3a3a1a !important;
                    color: #e0c060 !important;
                    border-color: #5a5a2a !important;
                }
                html.skin-theme-clientpref-night #verifier-verdict.not-supported {
                    background: #3a1a1a !important;
                    color: #e06060 !important;
                    border-color: #5a2a2a !important;
                }
                html.skin-theme-clientpref-night #verifier-verdict.source-unavailable {
                    background: #2a2a2e !important;
                    color: #a0a0a8 !important;
                    border-color: #3a3a3e !important;
                }
                html.skin-theme-clientpref-night #verifier-comments {
                    background: #2a2a3e !important;
                    border-color: #3a3a4e !important;
                    color: #e0e0e0 !important;
                }
                html.skin-theme-clientpref-night .verifier-action-hint {
                    color: #888 !important;
                }
                html.skin-theme-clientpref-night .verifier-error {
                    color: #ff8080 !important;
                    background: #3a1a1a !important;
                    border-color: #5a2a2a !important;
                }
                html.skin-theme-clientpref-night .reference:hover {
                    background-color: rgba(100, 149, 237, 0.15) !important;
                }
                html.skin-theme-clientpref-night .claim-highlight {
                    background-color: #3a3a1a !important;
                }
                html.skin-theme-clientpref-night #verifier-report-summary {
                    background: #2a2a3e !important;
                    border-color: #3a3a4e !important;
                    color: #e0e0e0 !important;
                }
                html.skin-theme-clientpref-night .verifier-progress-bar {
                    background: #3a3a4e !important;
                }
                html.skin-theme-clientpref-night .verifier-progress-text {
                    color: #b0b0c0 !important;
                }
                html.skin-theme-clientpref-night .verifier-report-card {
                    background: #2a2a3e !important;
                    border-color: #3a3a4e !important;
                    color: #e0e0e0 !important;
                }
                html.skin-theme-clientpref-night .verifier-report-card:hover {
                    background: #3a3a5e !important;
                }
                html.skin-theme-clientpref-night .report-card-claim {
                    color: #b0b0c0 !important;
                }
                html.skin-theme-clientpref-night .report-card-comment {
                    color: #a0a0b0 !important;
                }
                html.skin-theme-clientpref-night #verifier-source-textarea-container textarea {
                    background: #2a2a3e !important;
                    color: #e0e0e0 !important;
                    border-color: #3a3a4e !important;
                }
                html.skin-theme-clientpref-night #source-verifier-sidebar .oo-ui-dropdownWidget {
                    background: #2a2a3e !important;
                    border-color: #3a3a4e !important;
                }
                html.skin-theme-clientpref-night #source-verifier-sidebar .oo-ui-dropdownWidget .oo-ui-labelElement-label {
                    color: #e0e0e0 !important;
                }
                html.skin-theme-clientpref-night #source-verifier-sidebar .oo-ui-buttonElement-button {
                    background: #2a2a3e !important;
                    color: #e0e0e0 !important;
                    border-color: #3a3a4e !important;
                }
                html.skin-theme-clientpref-night #source-verifier-sidebar .oo-ui-buttonElement-button .oo-ui-labelElement-label {
                    color: #e0e0e0 !important;
                }
                html.skin-theme-clientpref-night #source-verifier-sidebar .oo-ui-flaggedElement-primary.oo-ui-flaggedElement-progressive .oo-ui-buttonElement-button {
                    background: ${this.getCurrentColor()} !important;
                    color: white !important;
                    border-color: ${this.getCurrentColor()} !important;
                }
                html.skin-theme-clientpref-night #source-verifier-sidebar .oo-ui-flaggedElement-primary.oo-ui-flaggedElement-progressive.oo-ui-widget-disabled .oo-ui-buttonElement-button {
                    background: #3a3a4e !important;
                    color: #888 !important;
                    border-color: #4a4a5e !important;
                    cursor: default !important;
                }
                html.skin-theme-clientpref-night #source-verifier-sidebar .oo-ui-flaggedElement-primary.oo-ui-flaggedElement-progressive .oo-ui-labelElement-label {
                    color: white !important;
                }
                html.skin-theme-clientpref-night #source-verifier-sidebar .oo-ui-flaggedElement-destructive .oo-ui-buttonElement-button {
                    color: #e06060 !important;
                }
                html.skin-theme-clientpref-night #source-verifier-sidebar .oo-ui-iconElement-icon {
                    filter: invert(0.8);
                }
                html.skin-theme-clientpref-night #source-verifier-sidebar .oo-ui-indicatorElement-indicator {
                    filter: invert(0.8);
                }
                html.skin-theme-clientpref-night #source-verifier-sidebar .oo-ui-menuSelectWidget {
                    background: #2a2a3e !important;
                    border-color: #3a3a4e !important;
                }
                html.skin-theme-clientpref-night #source-verifier-sidebar .oo-ui-optionWidget {
                    color: #e0e0e0 !important;
                }
                html.skin-theme-clientpref-night #source-verifier-sidebar .oo-ui-optionWidget-highlighted {
                    background: #3a3a5e !important;
                }
                html.skin-theme-clientpref-night #source-verifier-sidebar .oo-ui-optionWidget-selected {
                    background: ${this.getCurrentColor()} !important;
                    color: white !important;
                }

                /* Support auto dark mode via OS preference */
                @media (prefers-color-scheme: dark) {
                    html.skin-theme-clientpref-os #source-verifier-sidebar {
                        background: #1a1a2e !important;
                        color: #e0e0e0 !important;
                        border-left-color: ${this.getCurrentColor()} !important;
                        box-shadow: -2px 0 8px rgba(0,0,0,0.4) !important;
                    }
                    html.skin-theme-clientpref-os #source-verifier-sidebar * {
                        color: inherit;
                    }
                    html.skin-theme-clientpref-os #verifier-sidebar-header {
                        background: ${this.getCurrentColor()} !important;
                        color: white !important;
                    }
                    html.skin-theme-clientpref-os #verifier-sidebar-header * {
                        color: white !important;
                    }
                    html.skin-theme-clientpref-os #verifier-sidebar-content {
                        background: #1a1a2e !important;
                        color: #e0e0e0 !important;
                    }
                    html.skin-theme-clientpref-os #verifier-provider-info {
                        background: #2a2a3e !important;
                        color: #b0b0c0 !important;
                        border-color: #3a3a4e !important;
                    }
                    html.skin-theme-clientpref-os #verifier-provider-info.free-provider {
                        background: #1a2e1a !important;
                        color: #6ecf6e !important;
                    }
                    html.skin-theme-clientpref-os #verifier-claim-section h4,
                    html.skin-theme-clientpref-os #verifier-source-section h4,
                    html.skin-theme-clientpref-os #verifier-results h4 {
                        color: ${this.getCurrentColor()} !important;
                        filter: brightness(1.3);
                    }
                    html.skin-theme-clientpref-os #verifier-claim-text,
                    html.skin-theme-clientpref-os #verifier-source-text {
                        background: #2a2a3e !important;
                        border-color: #3a3a4e !important;
                        color: #e0e0e0 !important;
                    }
                    html.skin-theme-clientpref-os #verifier-verdict {
                        color: #e0e0e0 !important;
                    }
                    html.skin-theme-clientpref-os #verifier-verdict.supported {
                        background: #1a3a1a !important;
                        color: #6ecf6e !important;
                        border-color: #2a5a2a !important;
                    }
                    html.skin-theme-clientpref-os #verifier-verdict.partially-supported {
                        background: #3a3a1a !important;
                        color: #e0c060 !important;
                        border-color: #5a5a2a !important;
                    }
                    html.skin-theme-clientpref-os #verifier-verdict.not-supported {
                        background: #3a1a1a !important;
                        color: #e06060 !important;
                        border-color: #5a2a2a !important;
                    }
                    html.skin-theme-clientpref-os #verifier-verdict.source-unavailable {
                        background: #2a2a2e !important;
                        color: #a0a0a8 !important;
                        border-color: #3a3a3e !important;
                    }
                    html.skin-theme-clientpref-os #verifier-comments {
                        background: #2a2a3e !important;
                        border-color: #3a3a4e !important;
                        color: #e0e0e0 !important;
                    }
                    html.skin-theme-clientpref-os .verifier-action-hint {
                        color: #888 !important;
                    }
                    html.skin-theme-clientpref-os .verifier-error {
                        color: #ff8080 !important;
                        background: #3a1a1a !important;
                        border-color: #5a2a2a !important;
                    }
                    html.skin-theme-clientpref-os .reference:hover {
                        background-color: rgba(100, 149, 237, 0.15) !important;
                    }
                    html.skin-theme-clientpref-os .claim-highlight {
                        background-color: #3a3a1a !important;
                    }
                    html.skin-theme-clientpref-os #verifier-report-summary {
                        background: #2a2a3e !important;
                        border-color: #3a3a4e !important;
                        color: #e0e0e0 !important;
                    }
                    html.skin-theme-clientpref-os .verifier-progress-bar {
                        background: #3a3a4e !important;
                    }
                    html.skin-theme-clientpref-os .verifier-progress-text {
                        color: #b0b0c0 !important;
                    }
                    html.skin-theme-clientpref-os .verifier-report-card {
                        background: #2a2a3e !important;
                        border-color: #3a3a4e !important;
                        color: #e0e0e0 !important;
                    }
                    html.skin-theme-clientpref-os .verifier-report-card:hover {
                        background: #3a3a5e !important;
                    }
                    html.skin-theme-clientpref-os .report-card-claim {
                        color: #b0b0c0 !important;
                    }
                    html.skin-theme-clientpref-os .report-card-comment {
                        color: #a0a0b0 !important;
                    }
                    html.skin-theme-clientpref-os #verifier-source-textarea-container textarea {
                        background: #2a2a3e !important;
                        color: #e0e0e0 !important;
                        border-color: #3a3a4e !important;
                    }
                    html.skin-theme-clientpref-os #source-verifier-sidebar .oo-ui-dropdownWidget {
                        background: #2a2a3e !important;
                        border-color: #3a3a4e !important;
                    }
                    html.skin-theme-clientpref-os #source-verifier-sidebar .oo-ui-dropdownWidget .oo-ui-labelElement-label {
                        color: #e0e0e0 !important;
                    }
                    html.skin-theme-clientpref-os #source-verifier-sidebar .oo-ui-buttonElement-button {
                        background: #2a2a3e !important;
                        color: #e0e0e0 !important;
                        border-color: #3a3a4e !important;
                    }
                    html.skin-theme-clientpref-os #source-verifier-sidebar .oo-ui-buttonElement-button .oo-ui-labelElement-label {
                        color: #e0e0e0 !important;
                    }
                    html.skin-theme-clientpref-os #source-verifier-sidebar .oo-ui-flaggedElement-primary.oo-ui-flaggedElement-progressive .oo-ui-buttonElement-button {
                        background: ${this.getCurrentColor()} !important;
                        color: white !important;
                        border-color: ${this.getCurrentColor()} !important;
                    }
                    html.skin-theme-clientpref-os #source-verifier-sidebar .oo-ui-flaggedElement-primary.oo-ui-flaggedElement-progressive.oo-ui-widget-disabled .oo-ui-buttonElement-button {
                        background: #3a3a4e !important;
                        color: #888 !important;
                        border-color: #4a4a5e !important;
                        cursor: default !important;
                    }
                    html.skin-theme-clientpref-os #source-verifier-sidebar .oo-ui-flaggedElement-primary.oo-ui-flaggedElement-progressive .oo-ui-labelElement-label {
                        color: white !important;
                    }
                    html.skin-theme-clientpref-os #source-verifier-sidebar .oo-ui-flaggedElement-destructive .oo-ui-buttonElement-button {
                        color: #e06060 !important;
                    }
                    html.skin-theme-clientpref-os #source-verifier-sidebar .oo-ui-iconElement-icon {
                        filter: invert(0.8);
                    }
                    html.skin-theme-clientpref-os #source-verifier-sidebar .oo-ui-indicatorElement-indicator {
                        filter: invert(0.8);
                    }
                    html.skin-theme-clientpref-os #source-verifier-sidebar .oo-ui-menuSelectWidget {
                        background: #2a2a3e !important;
                        border-color: #3a3a4e !important;
                    }
                    html.skin-theme-clientpref-os #source-verifier-sidebar .oo-ui-optionWidget {
                        color: #e0e0e0 !important;
                    }
                    html.skin-theme-clientpref-os #source-verifier-sidebar .oo-ui-optionWidget-highlighted {
                        background: #3a3a5e !important;
                    }
                    html.skin-theme-clientpref-os #source-verifier-sidebar .oo-ui-optionWidget-selected {
                        background: ${this.getCurrentColor()} !important;
                        color: white !important;
                    }
                }
            `;
            document.head.appendChild(style);
        }
        
        createOOUIButtons() {
            this.buttons.close = new OO.ui.ButtonWidget({
                icon: 'close',
                title: 'Close',
                framed: false,
                classes: ['verifier-close-button']
            });
            
            // Provider selector
            this.buttons.providerSelect = new OO.ui.DropdownWidget({
                menu: {
                    items: Object.keys(this.providers).map(key => 
                        new OO.ui.MenuOptionWidget({
                            data: key,
                            label: this.providers[key].name
                        })
                    )
                }
            });
            this.buttons.providerSelect.getMenu().selectItemByData(this.currentProvider);
            
            this.buttons.setKey = new OO.ui.ButtonWidget({
                label: 'Set API Key',
                flags: ['primary', 'progressive'],
                disabled: false
            });
            
            this.buttons.verify = new OO.ui.ButtonWidget({
                label: 'Verify Claim',
                flags: ['primary', 'progressive'],
                icon: 'check',
                disabled: true
            });
            
            this.buttons.changeKey = new OO.ui.ButtonWidget({
                label: 'Change Key',
                flags: ['safe'],
                icon: 'edit',
                disabled: false
            });
            
            this.buttons.removeKey = new OO.ui.ButtonWidget({
                label: 'Remove API Key',
                flags: ['destructive'],
                icon: 'trash',
                disabled: false
            });
            
            // Source text input widgets
            this.sourceTextInput = new OO.ui.MultilineTextInputWidget({
                placeholder: 'Paste the source text here...',
                rows: 6,
                autosize: true,
                maxRows: 15
            });
            
            this.buttons.loadText = new OO.ui.ButtonWidget({
                label: 'Load Text',
                flags: ['primary', 'progressive']
            });
            
            this.buttons.cancelText = new OO.ui.ButtonWidget({
                label: 'Cancel',
                flags: ['safe']
            });

            // Article report buttons
            this.buttons.verifyAll = new OO.ui.ButtonWidget({
                label: 'Verify All Citations',
                flags: ['primary', 'progressive'],
                icon: 'articles'
            });

            this.buttons.stopAll = new OO.ui.ButtonWidget({
                label: 'Stop',
                flags: ['destructive'],
                icon: 'cancel'
            });

            this.buttons.backToReport = new OO.ui.ButtonWidget({
                label: 'Back to Report',
                flags: ['safe'],
                icon: 'arrowPrevious'
            });

            this.updateButtonVisibility();
        }
        
        appendOOUIButtons() {
            document.getElementById('verifier-close-btn-container').appendChild(this.buttons.close.$element[0]);
            document.getElementById('verifier-provider-container').appendChild(this.buttons.providerSelect.$element[0]);
            
            this.updateProviderInfo();
            this.updateButtonVisibility();
            
            // Append source input widgets
            document.getElementById('verifier-source-textarea-container').appendChild(this.sourceTextInput.$element[0]);
            document.getElementById('verifier-load-text-btn-container').appendChild(this.buttons.loadText.$element[0]);
            document.getElementById('verifier-cancel-text-btn-container').appendChild(this.buttons.cancelText.$element[0]);
        }
        
        updateProviderInfo() {
            const infoEl = document.getElementById('verifier-provider-info');
            if (!infoEl) return;
            
            const provider = this.providers[this.currentProvider];
            if (!provider.requiresKey) {
                infoEl.textContent = '✓ No API key required - using free PublicAI model';
                infoEl.className = 'free-provider';
            } else if (this.getCurrentApiKey()) {
                infoEl.textContent = `API key configured for ${provider.name}`;
                infoEl.className = '';
            } else {
                infoEl.textContent = `API key required for ${provider.name}`;
                infoEl.className = '';
            }
        }
        
        updateButtonVisibility() {
            const container = document.getElementById('verifier-buttons-container');
            if (!container) return;
            
            container.innerHTML = '';
            
            const hasKey = this.getCurrentApiKey();
            const requiresKey = this.providerRequiresKey();
            
            if (!requiresKey || hasKey) {
                // Provider is ready to use
                if (this.reportRunning) {
                    container.appendChild(this.buttons.stopAll.$element[0]);
                } else {
                    const hasClaimAndSource = this.activeClaim && this.activeSource;
                    this.buttons.verify.setDisabled(!hasClaimAndSource);
                    container.appendChild(this.buttons.verify.$element[0]);
                    container.appendChild(this.buttons.verifyAll.$element[0]);

                    if (this.hasReport && !this.reportMode) {
                        container.appendChild(this.buttons.backToReport.$element[0]);
                    }
                }

                const privacyNote = document.createElement('div');
                privacyNote.style.cssText = 'font-size: 11px; color: #72777d; margin-top: 4px;';
                privacyNote.textContent = 'Results are logged for research. Your username is not recorded.';
                container.appendChild(privacyNote);

                // Only show key management buttons for providers that use user keys
                if (requiresKey && !this.reportRunning) {
                    container.appendChild(this.buttons.changeKey.$element[0]);
                    container.appendChild(this.buttons.removeKey.$element[0]);
                }
            } else {
                // Provider needs a key
                this.buttons.verify.setDisabled(true);
                container.appendChild(this.buttons.setKey.$element[0]);
            }
            
            this.updateProviderInfo();
        }
        
        createVerifierTab() {
            if (typeof mw !== 'undefined' && [0, 118].includes(mw.config.get('wgNamespaceNumber'))) {
                const skin = mw.config.get('skin');
                let portletId;
                
                switch(skin) {
                    case 'vector-2022':
                        portletId = 'p-associated-pages';
                        break;
                    case 'vector':
                        portletId = 'p-cactions';
                        break;
                    case 'monobook':
                        portletId = 'p-cactions';
                        break;
                    case 'minerva':
                        portletId = 'p-tb';
                        break;
                    case 'timeless':
                        portletId = 'p-associated-pages';
                        break;
                    default:
                        portletId = 'p-namespaces';
                }
                
                try {
                    const verifierLink = mw.util.addPortletLink(
                        portletId,
                        '#',
                        'Verify',
                        't-verifier',
                        'Verify claims against sources',
                        'v',
                    );
                    
                    if (verifierLink) {
                        verifierLink.addEventListener('click', (e) => {
                            e.preventDefault();
                            this.showSidebar();
                        });
                        this.showFirstRunNotification();
                    }
                } catch (error) {
                    console.warn('Could not create verifier tab:', error);
                }
            }
        }
        
        showFirstRunNotification() {
            if (localStorage.getItem('verifier_first_run_done')) return;
            localStorage.setItem('verifier_first_run_done', 'true');
            mw.notify(
                $('<span>').append(
                    'Citation Verifier installed — click the ',
                    $('<strong>').text('Verify'),
                    ' tab to get started.'
                ),
                { title: 'Citation Verifier', type: 'info', autoHide: true, autoHideSeconds: 8 }
            );
        }

        attachReferenceClickHandlers() {
            const references = document.querySelectorAll('.reference a');
            references.forEach(ref => {
                ref.addEventListener('click', (e) => {
                    if (!this.isVisible) return;
                    e.preventDefault();
                    e.stopPropagation();
                    this.handleReferenceClick(ref);
                });
            });
        }
        
        async handleReferenceClick(refElement) {
            try {
                if (this.reportMode) {
                    this.showSingleCitationView();
                }
                this.clearHighlights();
                this.showSidebar();

                // Clear previous verification result and invalidate any in-flight verification
                this.clearResult();
                this.currentVerifyId++;
                
                const claim = this.extractClaimText(refElement);
                if (!claim) {
                    this.updateStatus('Could not extract claim text', true);
                    return;
                }
                
                this.highlightClaim(refElement, claim);
                refElement.parentElement.classList.add('verifier-active');
                
                this.activeClaim = claim;
                this.activeCitationNumber = refElement.textContent.replace(/[\[\]]/g, '').trim() || null;
                this.activeRefElement = refElement;

                document.getElementById('verifier-claim-text').textContent = claim;

                const refUrl = this.extractReferenceUrl(refElement);
                this.activeSourceUrl = refUrl;
                
                if (!refUrl) {
                    this.showSourceTextInput();
                    this.updateStatus('No URL found in reference. Please paste the source text below.');
                    return;
                }
                
                this.hideSourceTextInput();
                this.activeSource = null;
                this.updateButtonVisibility();
                this.updateStatus('Fetching source content...');
                const fetchId = ++this.currentFetchId;
                const pageNum = this.extractPageNumber(refElement);
                const sourceInfo = await this.fetchSourceContent(refUrl, pageNum);

                if (fetchId !== this.currentFetchId) {
                    return;
                }

                if (!sourceInfo) {
                    this.showSourceTextInput();
                    this.updateStatus('Could not fetch source. Please paste the source text below.');
                    return;
                }

                this.activeSource = sourceInfo;
                const sourceElement = document.getElementById('verifier-source-text');

                const urlMatch = sourceInfo.match(/Source URL: (https?:\/\/[^\s\n]+)/);
                const contentFetched = sourceInfo.includes('Source Content:');
                const pdfMatch = sourceInfo.match(/PDF: (\d+) pages/);
                const pageMatch = sourceInfo.match(/\(extracted page (\d+)\)/);

                if (urlMatch) {
                    let statusHtml;
                    if (contentFetched && pdfMatch) {
                        const pageInfo = pageMatch
                            ? ` (page ${pageMatch[1]} of ${pdfMatch[1]})`
                            : ` (${pdfMatch[1]} pages)`;
                        statusHtml = `<span style="color: #2e7d32;">✓ PDF content extracted${pageInfo}</span>`;
                    } else if (contentFetched) {
                        statusHtml = '<span style="color: #2e7d32;">✓ Content fetched successfully</span>';
                    } else {
                        statusHtml = '<em>Content will be fetched by AI during verification.</em>';
                    }
                    sourceElement.innerHTML = `
                        <strong>Source URL:</strong><br>
                        <a href="${urlMatch[1]}" target="_blank" style="word-break: break-all;">${urlMatch[1]}</a><br><br>
                        ${statusHtml}
                    `;
                } else {
                    sourceElement.textContent = sourceInfo;
                }

                this.updateButtonVisibility();
                this.updateStatus(contentFetched ? 'Source fetched. Ready to verify.' : 'Ready to verify claim against source');
                
            } catch (error) {
                console.error('Error handling reference click:', error);
                this.updateStatus(`Error: ${error.message}`, true);
            }
        }
        
        showSourceTextInput() {
            document.getElementById('verifier-source-input-container').style.display = 'block';
            document.getElementById('verifier-source-text').textContent = 'No URL found. Please paste the source text below:';
            this.sourceTextInput.setValue('');
        }
        
        hideSourceTextInput() {
            document.getElementById('verifier-source-input-container').style.display = 'none';
        }
        
        loadManualSourceText() {
            const text = this.sourceTextInput.getValue().trim();
            if (!text) {
                this.updateStatus('Please enter some source text', true);
                return;
            }
            
            this.activeSource = `Manual source text:\n\n${text}`;
            document.getElementById('verifier-source-text').innerHTML = `<strong>Manual Source Text:</strong><br><em>${text.substring(0, 200)}${text.length > 200 ? '...' : ''}</em>`;
            this.hideSourceTextInput();
            this.updateButtonVisibility();
            this.updateStatus('Source text loaded. Ready to verify.');
        }
        
        cancelManualSourceText() {
            this.sourceTextInput.setValue('');
            this.hideSourceTextInput();
            this.activeSource = null;
            document.getElementById('verifier-source-text').textContent = 'No source loaded.';
            this.updateButtonVisibility();
            this.updateStatus('Cancelled');
        }
        
        extractClaimText(refElement) {
            const container = refElement.closest('p, li, td, div, section');
            if (!container) {
                return '';
            }
            
            // Get the current reference wrapper element
            const currentRef = refElement.closest('.reference');
            if (!currentRef) {
                // Fallback: return container text
                return container.textContent
                    .replace(/\[\d+\]/g, '')
                    .replace(/\s+/g, ' ')
                    .trim();
            }
            
            // Find all references in the same container
            const refsInContainer = Array.from(container.querySelectorAll('.reference'));
            const currentIndexInContainer = refsInContainer.indexOf(currentRef);
            
            let claimStartNode = null;
            
            if (currentIndexInContainer > 0) {
                // There are previous references in this container
                // Walk backwards to find where the claim actually starts
                
                for (let i = currentIndexInContainer - 1; i >= 0; i--) {
                    const prevRef = refsInContainer[i];
                    
                    // Check if there's actual text between this ref and the next one
                    const range = document.createRange();
                    range.setStartAfter(prevRef);
                    
                    if (i === currentIndexInContainer - 1) {
                        range.setEndBefore(currentRef);
                    } else {
                        range.setEndBefore(refsInContainer[i + 1]);
                    }
                    
                    const textBetween = range.toString().replace(/\s+/g, '').trim();
                    
                    if (textBetween.length > 0) {
                        // Found text before this point - the previous ref is our boundary
                        claimStartNode = prevRef;
                        break;
                    }
                    // No text between these refs - they cite the same claim, keep looking back
                }
            }
            
            // Extract the text from the boundary to the current reference
            const extractionRange = document.createRange();
            
            if (claimStartNode) {
                extractionRange.setStartAfter(claimStartNode);
            } else {
                // No previous ref boundary - start from beginning of container
                extractionRange.setStart(container, 0);
            }
            extractionRange.setEndBefore(currentRef);
            
            // Get the text content
            let claimText = extractionRange.toString();
            
            // Clean up the text
            claimText = claimText
                .replace(/\[\d+\]/g, '')           // Remove reference numbers like [1], [2]
                .replace(/\s+/g, ' ')              // Normalize whitespace
                .trim();
            
            // If we got nothing meaningful, fall back to the container text
            if (!claimText || claimText.length < 10) {
                claimText = container.textContent
                    .replace(/\[\d+\]/g, '')
                    .replace(/\s+/g, ' ')
                    .trim();
            }
            
            return claimText;
        }
        
        extractReferenceUrl(refElement) {
            const href = refElement.getAttribute('href');
            if (!href || !href.startsWith('#')) {
                console.log('[CitationVerifier] No valid href on refElement:', href);
                return null;
            }

            const refId = href.substring(1);
            const refTarget = document.getElementById(refId);

            if (!refTarget) {
                console.log('[CitationVerifier] No element found for refId:', refId);
                return null;
            }

            // First look for archive links (prioritize these)
            const archiveLink = refTarget.querySelector('a[href*="web.archive.org"], a[href*="archive.today"], a[href*="archive.is"], a[href*="archive.ph"], a[href*="webcitation.org"]');
            if (archiveLink) return archiveLink.href;

            // Fall back to any http link
            const links = refTarget.querySelectorAll('a[href^="http"]');
            if (links.length === 0) {
                console.log('[CitationVerifier] No http links in refTarget. innerHTML:', refTarget.innerHTML.substring(0, 500));
                return null;
            }
            return links[0].href;
        }

        extractPageNumber(refElement) {
            const href = refElement.getAttribute('href');
            if (!href || !href.startsWith('#')) return null;

            const refTarget = document.getElementById(href.substring(1));
            if (!refTarget) return null;

            const text = refTarget.textContent;
            // Match patterns like "p. 42", "pp. 42-43", "p.42", "page 42", "pages 42–43"
            const match = text.match(/\bp(?:p|ages?)?\.?\s*(\d+)/i);
            if (match) {
                console.log('[CitationVerifier] Extracted page number:', match[1]);
                return parseInt(match[1], 10);
            }
            return null;
        }
        
        async fetchSourceContent(url, pageNum) {
            try {
                let proxyUrl = `https://publicai-proxy.alaexis.workers.dev/?fetch=${encodeURIComponent(url)}`;
                if (pageNum) {
                    proxyUrl += `&page=${pageNum}`;
                }
                const response = await fetch(proxyUrl);
                const data = await response.json();

                if (data.error) {
                    console.warn('[CitationVerifier] Proxy error:', data.error);
                    return null;
                }

                if (data.content && data.content.length > 100) {
                    let meta = `Source URL: ${url}`;
                    if (data.pdf) {
                        meta += `\nPDF: ${data.totalPages} pages`;
                        if (data.page) {
                            meta += ` (extracted page ${data.page})`;
                        }
                    }
                    return `${meta}\n\nSource Content:\n${data.content}`;
                }

                // If PDF was large and we didn't request a specific page, retry
                // with the citation page if available
                if (data.pdf && !pageNum && data.totalPages > 15) {
                    console.log('[CitationVerifier] Large PDF without page param, content may be truncated');
                }
            } catch (error) {
                console.error('Proxy fetch failed:', error);
            }
            return null; // Falls back to manual input
        }
        
        highlightClaim(refElement, claim) {
            const parentElement = refElement.closest('p, li, td, div');
            if (parentElement && !parentElement.classList.contains('claim-highlight')) {
                parentElement.classList.add('claim-highlight');
            }
        }
        
        clearHighlights() {
            document.querySelectorAll('.reference.verifier-active').forEach(el => {
                el.classList.remove('verifier-active');
            });
            
            document.querySelectorAll('.claim-highlight').forEach(el => {
                el.classList.remove('claim-highlight');
            });
        }
        
        makeResizable() {
            const handle = document.getElementById('verifier-resize-handle');
            const sidebar = document.getElementById('source-verifier-sidebar');
            
            if (!handle || !sidebar) return;
            
            let isResizing = false;
            handle.addEventListener('mousedown', (e) => {
                isResizing = true;
                document.addEventListener('mousemove', handleMouseMove);
                document.addEventListener('mouseup', handleMouseUp);
                e.preventDefault();
            });
            
            const handleMouseMove = (e) => {
                if (!isResizing) return;
                
                const newWidth = window.innerWidth - e.clientX;
                const minWidth = 300;
                const maxWidth = window.innerWidth * 0.8;
                
                if (newWidth >= minWidth && newWidth <= maxWidth) {
                    const widthPx = newWidth + 'px';
                    sidebar.style.width = widthPx;
                    document.body.style.marginRight = widthPx;
                    this.sidebarWidth = widthPx;
                    localStorage.setItem('verifier_sidebar_width', widthPx);
                }
            };
            
            const handleMouseUp = () => {
                isResizing = false;
                document.removeEventListener('mousemove', handleMouseMove);
                document.removeEventListener('mouseup', handleMouseUp);
            };
        }
        
        showSidebar() {
            const verifierTab = document.getElementById('ca-verifier') || document.getElementById('t-verifier');
            
            document.body.classList.remove('verifier-sidebar-hidden');
            if (verifierTab) verifierTab.style.display = 'none';
            document.body.style.marginRight = this.sidebarWidth;
            
            this.isVisible = true;
            localStorage.setItem('verifier_sidebar_visible', 'true');
        }
        
        hideSidebar() {
            const verifierTab = document.getElementById('ca-verifier') || document.getElementById('t-verifier');
            
            document.body.classList.add('verifier-sidebar-hidden');
            if (verifierTab) verifierTab.style.display = 'list-item';
            document.body.style.marginRight = '0';
            
            this.clearHighlights();
            
            this.isVisible = false;
            localStorage.setItem('verifier_sidebar_visible', 'false');
        }
        
        adjustMainContent() {
            if (this.isVisible) {
                document.body.style.marginRight = this.sidebarWidth;
            } else {
                document.body.style.marginRight = '0';
            }
        }
        
        attachEventListeners() {
            this.buttons.close.on('click', () => {
                this.hideSidebar();
            });
            
            this.buttons.providerSelect.getMenu().on('select', (item) => {
                this.currentProvider = item.getData();
                localStorage.setItem('source_verifier_provider', this.currentProvider);
                this.updateButtonVisibility();
                this.updateTheme();
                this.updateStatus(`Switched to ${this.providers[this.currentProvider].name}`);
            });
            
            this.buttons.setKey.on('click', () => {
                this.setApiKey();
            });
            
            this.buttons.changeKey.on('click', () => {
                this.setApiKey();
            });
            
            this.buttons.verify.on('click', () => {
                this.verifyClaim();
            });
            
            this.buttons.removeKey.on('click', () => {
                this.removeApiKey();
            });
            
            this.buttons.loadText.on('click', () => {
                this.loadManualSourceText();
            });
            
            this.buttons.cancelText.on('click', () => {
                this.cancelManualSourceText();
            });

            this.buttons.verifyAll.on('click', () => {
                this.verifyAllCitations();
            });

            this.buttons.stopAll.on('click', () => {
                this.reportCancelled = true;
            });

            this.buttons.backToReport.on('click', () => {
                this.showReportView();
            });
        }
        
        updateTheme() {
            const color = this.getCurrentColor();
            // Remove old styles and re-create to pick up new provider color in dark theme
            const oldStyle = document.querySelector('style[data-verifier-theme]');
            if (oldStyle) oldStyle.remove();
            // Re-create styles with updated color references
            const existingStyles = document.head.querySelectorAll('style');
            existingStyles.forEach(s => {
                if (s.textContent.includes('#source-verifier-sidebar')) s.remove();
            });
            this.createStyles();
        }
        
        setApiKey() {
            const provider = this.providers[this.currentProvider];
            
            if (!provider.requiresKey) {
                this.updateStatus('This provider does not require an API key.');
                return;
            }
            
            const dialog = new OO.ui.MessageDialog();
            
            const textInput = new OO.ui.TextInputWidget({
                placeholder: `Enter your ${provider.name} API Key...`,
                type: 'password',
                value: (provider.storageKey ? localStorage.getItem(provider.storageKey) : '') || ''
            });
            
            const windowManager = new OO.ui.WindowManager();
            $('body').append(windowManager.$element);
            windowManager.addWindows([dialog]);
            
            windowManager.openWindow(dialog, {
                title: `Set ${provider.name} API Key`,
                message: $('<div>').append(
                    $('<p>').text(`Enter your ${provider.name} API Key to enable source verification:`),
                    textInput.$element
                ),
                actions: [
                    {
                        action: 'save',
                        label: 'Save',
                        flags: ['primary', 'progressive']
                    },
                    {
                        action: 'cancel',
                        label: 'Cancel',
                        flags: ['safe']
                    }
                ]
            }).closed.then((data) => {
                if (data && data.action === 'save') {
                    const key = textInput.getValue().trim();
                    if (key) {
                        this.setCurrentApiKey(key);
                        this.updateButtonVisibility();
                        this.updateStatus('API key set successfully!');
                        
                        if (this.activeClaim && this.activeSource) {
                            this.updateButtonVisibility();
                        }
                    }
                }
                windowManager.destroy();
            });
        }
        
        removeApiKey() {
            if (!this.providerRequiresKey()) {
                this.updateStatus('This provider does not use a stored API key.');
                return;
            }
            
            OO.ui.confirm('Are you sure you want to remove the stored API key?').done((confirmed) => {
                if (confirmed) {
                    this.removeCurrentApiKey();
                    this.updateButtonVisibility();
                    this.updateStatus('API key removed successfully!');
                }
            });
        }
        
        updateStatus(message, isError = false) {
            if (isError) {
                console.error('Verifier Error:', message);
            } else {
                console.log('Verifier Status:', message);
            }
        }
        
        // ========================================
        // CENTRALIZED PROMPT GENERATION
        // ========================================
        
        /**
         * Generates the system prompt for verification
         * @returns {string} The system prompt
         */
        generateSystemPrompt() {
            return `You are a fact-checking assistant for Wikipedia. Analyze whether claims are supported by the provided source text.

Rules:
- ONLY use the provided source text. Never use outside knowledge.
- First identify what the claim asserts, then look for information that supports or contradicts it.
- Accept paraphrasing and straightforward implications, but not speculative inferences or logical leaps.
- Distinguish between definitive statements and uncertain/hedged language. Claims stated as facts require sources that make definitive statements, not speculation or tentative assertions.

Source text evaluation:
Before analyzing, check if the provided "source text" is actually usable content.

It IS usable if it's:
- Article text from any website, including archive.org snapshots
- News articles, blog posts, press releases
- Actual content from the original source, even if it includes navigation, boilerplate, or Internet Archive/Wayback Machine framing

It is NOT usable if it's:
- A library catalog, database record, or book metadata (e.g., WorldCat, Google Books, JSTOR preview pages)
- Google Books, also Google Books in Internet Archive
- A paywall, login page, or access denied message
- A cookie consent notice or JavaScript error
- A 404 page or redirect notice
- Just bibliographic information without the actual content being cited

IMPORTANT: If the source text contains actual article content (paragraphs of text, quotes, factual statements), it IS usable even if it also contains archive navigation, headers, footers, or other page chrome. Only return SOURCE UNAVAILABLE when there is genuinely no article content to analyze.

If the source text is not usable, you MUST return verdict SOURCE UNAVAILABLE with confidence 0. Do not attempt to verify the claim - if you cannot find actual article or book content to quote, the source is unavailable.

Respond in JSON format:
{
  "confidence": <number 0-100>,
  "verdict": "<verdict>",
  "comments": "<relevant quote and brief explanation>"
}

Confidence guide:
- 80-100: SUPPORTED
- 50-79: PARTIALLY SUPPORTED
- 1-49: NOT SUPPORTED
- 0: SOURCE UNAVAILABLE

<example>
Claim: "The committee published its findings in 1932."
Source text: "History of Modern Economics - Economic Research Council - Google Books Sign in Hidden fields Books Try the new Google Books Check out the new look and enjoy easier access to your favorite features Try it now No thanks My library Help Advanced Book Search Download EPUB Download PDF Plain text Read eBook Get this book in print AbeBooks On Demand Books Amazon Find in a library All sellers About this book Terms of Service Plain text PDF EPUB"

{"source_quote": "", "confidence": 0, "verdict": "SOURCE UNAVAILABLE", "comments": "Google Books interface with no actual book content, only navigation and metadata."}
</example>

<example>
Claim: "The bridge was completed in 1998."
Source text: "Skip to main content Web Archive toolbar... Capture date: 2015-03-12 ... City Tribune - Local News ... The Morrison Bridge project broke ground in 1994 after years of planning. Construction faced multiple delays due to funding shortages. The bridge was finally opened to traffic in August 2002, four years behind schedule. Mayor Davis called it 'a triumph of persistence.'"

{"confidence": 15, "verdict": "NOT SUPPORTED", "comments": "\"finally opened to traffic in August 2002, four years behind schedule\" - Source says the bridge opened in 2002, not 1998. The article is accessible despite being an Internet Archive capture."}
</example>

<example>
Claim: "The company was founded in 1985 by John Smith."
Source text: "Acme Corp was established in 1985. Its founder, John Smith, served as CEO until 2001."

{"confidence": 95, "verdict": "SUPPORTED", "comments": "\"Acme Corp was established in 1985. Its founder, John Smith\" - Definitive match with paraphrasing."}
</example>

<example>
Claim: "The treaty was signed by 45 countries."
Source text: "The treaty, finalized in March, was signed by over 30 nations, though the exact number remains disputed."

{"confidence": 20, "verdict": "NOT SUPPORTED", "comments": "\"signed by over 30 nations\" - Source says \"over 30,\" not 45."}
</example>

<example>
Claim: "The treaty was signed in Paris."
Source text: "It is believed the treaty was signed in Paris, though some historians dispute this."

{"confidence": 60, "verdict": "PARTIALLY SUPPORTED", "comments": "\"It is believed... though some historians dispute this\" - Source hedges this as uncertain; Wikipedia states it as fact."}
</example>

<example>
Claim: "The population increased by 12% between 2010 and 2020."
Source text: "Census data shows significant population growth in the region during the 2010s."

{"confidence": 55, "verdict": "PARTIALLY SUPPORTED", "comments": "\"significant population growth\" - Source confirms growth but doesn't specify 12%."}
</example>

<example>
Claim: "The president resigned on March 3."
Source text: "The president remained in office throughout March."

{"confidence": 5, "verdict": "NOT SUPPORTED", "comments": "\"remained in office throughout March\" - Source directly contradicts the claim."}
</example>`;
        }
        
        /**
         * Parses source info and generates the user message
         * @param {string} claim - The claim to verify
         * @param {string} sourceInfo - The source information
         * @returns {string} The user message content
         */
        generateUserPrompt(claim, sourceInfo) {
            let sourceText;
            
            if (sourceInfo.startsWith('Manual source text:')) {
                sourceText = sourceInfo.replace(/^Manual source text:\s*\n\s*/, '');
            } else if (sourceInfo.includes('Source Content:')) {
                const contentMatch = sourceInfo.match(/Source Content:\n([\s\S]*)/);
                sourceText = contentMatch ? contentMatch[1] : sourceInfo;
            } else {
                sourceText = sourceInfo;
            }
            
            console.log('[Verifier] Source text (first 2000 chars):', sourceText.substring(0, 2000));
            
            return `Claim: "${claim}"

Source text:
${sourceText}`;
        }

        logVerification(verdict, confidence) {
            try {
                const payload = {
                    article_url: window.location.href,
                    article_title: typeof mw !== 'undefined' ? mw.config.get('wgTitle') : document.title,
                    citation_number: this.activeCitationNumber,
                    source_url: this.activeSourceUrl,
                    provider: this.currentProvider,
                    verdict: verdict,
                    confidence: confidence
                };
                fetch('https://publicai-proxy.alaexis.workers.dev/log', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                }).catch(() => {});
            } catch (e) {
                // logging should never break the main flow
            }
        }

        async verifyClaim() {
            const requiresKey = this.providerRequiresKey();
            const hasKey = !!this.getCurrentApiKey();
            
            // Only require a browser key for providers that need it
            if ((requiresKey && !hasKey) || !this.activeClaim || !this.activeSource) {
                this.updateStatus('Missing API key (for this provider), claim, or source content', true);
                return;
            }
            
            const verifyId = ++this.currentVerifyId;
            try {
                this.buttons.verify.setDisabled(true);
                this.buttons.verify.setLabel('Verifying...');
                this.buttons.verify.setIcon('clock');
                this.updateStatus('Verifying claim against source...');

                const apiResult = await this.callProviderAPI(this.activeClaim, this.activeSource);
                const result = apiResult.text;

                if (verifyId !== this.currentVerifyId) {
                    return;
                }

                this.updateStatus('Verification complete!');
                this.displayResult(result);

                // Fire-and-forget logging
                try {
                    const jsonMatch = result.match(/```(?:json)?\s*([\s\S]*?)\s*```/) ||
                                     [null, result.match(/\{[\s\S]*\}/)?.[0]];
                    const parsed = JSON.parse(jsonMatch[1]);
                    this.logVerification(parsed.verdict, parsed.confidence);
                } catch (e) {}

            } catch (error) {
                if (verifyId !== this.currentVerifyId) {
                    return;
                }
                console.error('Verification error:', error);
                this.updateStatus(`Error: ${error.message}`, true);
                document.getElementById('verifier-verdict').textContent = 'ERROR';
                document.getElementById('verifier-verdict').className = 'source-unavailable';
                document.getElementById('verifier-comments').textContent = error.message;
            } finally {
                if (verifyId === this.currentVerifyId) {
                    this.buttons.verify.setLabel('Verify Claim');
                    this.buttons.verify.setIcon('check');
                    this.buttons.verify.setDisabled(false);
                }
            }
        }
        
        async callPublicAIAPI(claim, sourceInfo) {
            const systemPrompt = this.generateSystemPrompt();
            const userContent = this.generateUserPrompt(claim, sourceInfo);
            
            const requestBody = {
                model: this.providers.publicai.model,
                messages: [
                    { role: "system", content: systemPrompt },
                    { role: "user", content: userContent }
                ],
                max_tokens: 2048,
                temperature: 0.1
            };
            
            const response = await fetch('https://publicai-proxy.alaexis.workers.dev', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(requestBody)
            });
            
            if (!response.ok) {
                const errorText = await response.text();
                let errorMessage;
                try {
                    const errorData = JSON.parse(errorText);
                    errorMessage = errorData.error?.message || errorText;
                } catch {
                    errorMessage = errorText;
                }
                throw new Error(`PublicAI API request failed (${response.status}): ${errorMessage}`);
            }

            const data = await response.json();

            if (!data.choices?.[0]?.message?.content) {
                throw new Error('Invalid API response format');
            }

            return {
                text: data.choices[0].message.content,
                usage: {
                    input: data.usage?.prompt_tokens || 0,
                    output: data.usage?.completion_tokens || 0
                }
            };
        }
        
        async callClaudeAPI(claim, sourceInfo) {
            const systemPrompt = this.generateSystemPrompt();
            const userContent = this.generateUserPrompt(claim, sourceInfo);
            
            const requestBody = {
                model: this.providers.claude.model,
                max_tokens: 3000,
                system: systemPrompt,
                messages: [{ role: "user", content: userContent }]
            };
            
            const response = await fetch('https://api.anthropic.com/v1/messages', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': this.getCurrentApiKey(),
                    'anthropic-version': '2023-06-01',
                    'anthropic-dangerous-direct-browser-access': 'true'
                },
                body: JSON.stringify(requestBody)
            });
            
            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`API request failed (${response.status}): ${errorText}`);
            }

            const data = await response.json();
            return {
                text: data.content[0].text,
                usage: {
                    input: data.usage?.input_tokens || 0,
                    output: data.usage?.output_tokens || 0
                }
            };
        }
        
        async callGeminiAPI(claim, sourceInfo) {
            const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${this.providers.gemini.model}:generateContent?key=${this.getCurrentApiKey()}`;
            
            const systemPrompt = this.generateSystemPrompt();
            const userContent = this.generateUserPrompt(claim, sourceInfo);
            
            const requestBody = {
                contents: [{ parts: [{ text: userContent }] }],
                systemInstruction: { parts: [{ text: systemPrompt }] },
                generationConfig: {
                    maxOutputTokens: 2048,
                    temperature: 0.0
                }
            };
            
            const response = await fetch(API_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(requestBody)
            });
            
            const responseData = await response.json();
            
            if (!response.ok) {
                const errorDetail = responseData.error?.message || response.statusText;
                throw new Error(`API request failed (${response.status}): ${errorDetail}`);
            }
            
            if (!responseData.candidates?.[0]?.content?.parts?.[0]?.text) {
                throw new Error('Invalid API response format or no content generated.');
            }
            
            return {
                text: responseData.candidates[0].content.parts[0].text,
                usage: {
                    input: responseData.usageMetadata?.promptTokenCount || 0,
                    output: responseData.usageMetadata?.candidatesTokenCount || 0
                }
            };
        }
        
        async callOpenAIAPI(claim, sourceInfo) {
            const systemPrompt = this.generateSystemPrompt();
            const userContent = this.generateUserPrompt(claim, sourceInfo);
            
            const requestBody = {
                model: this.providers.openai.model,
                max_tokens: 2000,
                messages: [
                    { role: "system", content: systemPrompt },
                    { role: "user", content: userContent }
                ],
                temperature: 0.1
            };
            
            const response = await fetch('https://api.openai.com/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.getCurrentApiKey()}`
                },
                body: JSON.stringify(requestBody)
            });
            
            if (!response.ok) {
                const errorText = await response.text();
                let errorMessage;
                try {
                    const errorData = JSON.parse(errorText);
                    errorMessage = errorData.error?.message || errorText;
                } catch {
                    errorMessage = errorText;
                }
                throw new Error(`API request failed (${response.status}): ${errorMessage}`);
            }

            const data = await response.json();

            if (!data.choices?.[0]?.message?.content) {
                throw new Error('Invalid API response format');
            }

            return {
                text: data.choices[0].message.content,
                usage: {
                    input: data.usage?.prompt_tokens || 0,
                    output: data.usage?.completion_tokens || 0
                }
            };
        }
        
	parseVerificationResult(response) {
	    try {
	        let jsonStr = response.trim();

	        const codeBlockMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
	        if (codeBlockMatch) {
	            jsonStr = codeBlockMatch[1].trim();
	        }

	        if (!codeBlockMatch) {
	            const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
	            if (jsonMatch) {
	                jsonStr = jsonMatch[0];
	            }
	        }

	        const result = JSON.parse(jsonStr);
	        return {
	            verdict: result.verdict || 'UNKNOWN',
	            confidence: result.confidence ?? null,
	            comments: result.comments || ''
	        };
	    } catch (e) {
	        return { verdict: 'ERROR', confidence: null, comments: `Failed to parse AI response: ${response.substring(0, 200)}` };
	    }
	}

	displayResult(response) {
	    const verdictEl = document.getElementById('verifier-verdict');
	    const commentsEl = document.getElementById('verifier-comments');

	    const result = this.parseVerificationResult(response);

	    verdictEl.textContent = result.verdict;
	    verdictEl.className = '';

	    if (result.verdict === 'SUPPORTED') {
	        verdictEl.classList.add('supported');
	    } else if (result.verdict === 'PARTIALLY SUPPORTED') {
	        verdictEl.classList.add('partially-supported');
	    } else if (result.verdict === 'NOT SUPPORTED') {
	        verdictEl.classList.add('not-supported');
	    } else if (result.verdict === 'SOURCE UNAVAILABLE' || result.verdict === 'ERROR') {
	        verdictEl.classList.add('source-unavailable');
	    }

	    commentsEl.textContent = result.comments;
	    console.log('[Verifier] Verdict for action button:', JSON.stringify(result.verdict));
	    this.showActionButton(result.verdict);
	}
        
        // ========================================
        // ARTICLE REPORT METHODS
        // ========================================

        collectAllCitations() {
            const refs = document.querySelectorAll('#mw-content-text .reference a');
            const citations = [];
            const seenRefIds = new Set();

            refs.forEach(refElement => {
                const href = refElement.getAttribute('href');
                if (!href || !href.startsWith('#')) return;

                const refId = href.substring(1);
                // Deduplicate by footnote target (handles [1a], [1b] etc.)
                if (seenRefIds.has(refId)) return;
                seenRefIds.add(refId);

                const citationNumber = refElement.textContent.replace(/[\[\]]/g, '').trim();
                const claimText = this.extractClaimText(refElement);
                if (!claimText || claimText.length < 10) return;

                const url = this.extractReferenceUrl(refElement);
                const pageNum = this.extractPageNumber(refElement);

                citations.push({ refElement, citationNumber, claimText, url, pageNum, refId });
            });

            return citations;
        }

        showReportView() {
            this.reportMode = true;
            // Hide single-citation sections
            document.getElementById('verifier-claim-section').style.display = 'none';
            document.getElementById('verifier-source-section').style.display = 'none';
            document.getElementById('verifier-results').style.display = 'none';
            // Show report view
            document.getElementById('verifier-report-view').style.display = 'block';
            this.updateButtonVisibility();
        }

        showSingleCitationView() {
            this.reportMode = false;
            // Show single-citation sections
            document.getElementById('verifier-claim-section').style.display = '';
            document.getElementById('verifier-source-section').style.display = '';
            document.getElementById('verifier-results').style.display = '';
            // Hide report view
            document.getElementById('verifier-report-view').style.display = 'none';
            this.updateButtonVisibility();
        }

        updateReportProgress(current, total, phase, startTime) {
            const progressEl = document.getElementById('verifier-report-progress');
            if (!progressEl) return;

            const pct = total > 0 ? Math.round((current / total) * 100) : 0;
            const elapsed = Date.now() - startTime;
            const elapsedStr = this.formatDuration(elapsed);
            let etaStr = '';
            if (current > 0) {
                const remaining = ((elapsed / current) * (total - current));
                etaStr = ` · ~${this.formatDuration(remaining)} remaining`;
            }

            progressEl.innerHTML = `
                <div class="verifier-progress-bar">
                    <div class="verifier-progress-fill" style="width: ${pct}%"></div>
                </div>
                <div class="verifier-progress-text">
                    ${phase} (${current}/${total}) · ${elapsedStr}${etaStr}
                </div>
            `;
        }

        formatDuration(ms) {
            const s = Math.round(ms / 1000);
            if (s < 60) return `${s}s`;
            const m = Math.floor(s / 60);
            return `${m}m ${s % 60}s`;
        }

        renderReportSummary() {
            const summaryEl = document.getElementById('verifier-report-summary');
            if (!summaryEl) return;

            const counts = { supported: 0, partial: 0, notSupported: 0, unavailable: 0, error: 0 };
            for (const r of this.reportResults) {
                if (r.verdict === 'SUPPORTED') counts.supported++;
                else if (r.verdict === 'PARTIALLY SUPPORTED') counts.partial++;
                else if (r.verdict === 'NOT SUPPORTED') counts.notSupported++;
                else if (r.verdict === 'SOURCE UNAVAILABLE') counts.unavailable++;
                else counts.error++;
            }
            const total = this.reportResults.length;

            const segHtml = (count, cls) => count > 0 ? `<div class="${cls}" style="width:${(count/total)*100}%"></div>` : '';

            summaryEl.innerHTML = `
                <div class="verifier-summary-bar">
                    ${segHtml(counts.supported, 'seg-supported')}
                    ${segHtml(counts.partial, 'seg-partial')}
                    ${segHtml(counts.notSupported, 'seg-not-supported')}
                    ${segHtml(counts.unavailable, 'seg-unavailable')}
                    ${segHtml(counts.error, 'seg-error')}
                </div>
                <div class="verifier-summary-counts">
                    <span><span class="dot" style="background:#28a745"></span>${counts.supported} supported</span>
                    <span><span class="dot" style="background:#ffc107"></span>${counts.partial} partial</span>
                    <span><span class="dot" style="background:#dc3545"></span>${counts.notSupported} not supported</span>
                    <span><span class="dot" style="background:#6c757d"></span>${counts.unavailable} unavailable</span>
                    ${counts.error > 0 ? `<span><span class="dot" style="background:#adb5bd"></span>${counts.error} errors</span>` : ''}
                </div>
                <div style="margin-top:6px;font-size:11px;color:#888;">
                    ${total} citations checked${this.reportTokenUsage.input + this.reportTokenUsage.output > 0 ? ` · ${this.reportTokenUsage.input.toLocaleString()} input + ${this.reportTokenUsage.output.toLocaleString()} output tokens` : ''}
                </div>
            `;
        }

        renderReportCard(result, index) {
            const resultsEl = document.getElementById('verifier-report-results');
            if (!resultsEl) return;

            let verdictClass, verdictLabel;
            switch (result.verdict) {
                case 'SUPPORTED': verdictClass = 'supported'; verdictLabel = 'Supported'; break;
                case 'PARTIALLY SUPPORTED': verdictClass = 'partial'; verdictLabel = 'Partial'; break;
                case 'NOT SUPPORTED': verdictClass = 'not-supported'; verdictLabel = 'Not Supported'; break;
                case 'SOURCE UNAVAILABLE': verdictClass = 'unavailable'; verdictLabel = 'Unavailable'; break;
                default: verdictClass = 'error'; verdictLabel = result.verdict; break;
            }

            const card = document.createElement('div');
            card.className = `verifier-report-card verdict-${verdictClass}`;
            const claimExcerpt = result.claimText.length > 80 ? result.claimText.substring(0, 80) + '…' : result.claimText;
            const confidenceStr = result.confidence !== null ? ` (${result.confidence}%)` : '';
            card.innerHTML = `
                <div class="report-card-header">
                    <span class="report-card-citation">[${result.citationNumber}]</span>
                    <span class="report-card-verdict ${verdictClass}">${verdictLabel}${confidenceStr}</span>
                </div>
                <div class="report-card-claim">${this.escapeHtml(claimExcerpt)}</div>
                ${result.comments ? `<div class="report-card-comment">${this.escapeHtml(result.comments)}</div>` : ''}
            `;

            if (result.refElement) {
                card.addEventListener('click', () => {
                    result.refElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    this.clearHighlights();
                    const parentRef = result.refElement.closest('.reference');
                    if (parentRef) parentRef.classList.add('verifier-active');
                });
            }

            resultsEl.appendChild(card);
        }

        escapeHtml(str) {
            const div = document.createElement('div');
            div.textContent = str;
            return div.innerHTML;
        }

        renderReportActions() {
            const actionsEl = document.getElementById('verifier-report-actions');
            if (!actionsEl) return;
            actionsEl.innerHTML = '';

            const copyWikiBtn = new OO.ui.ButtonWidget({
                label: 'Copy Report (Wikitext)',
                flags: ['progressive'],
                icon: 'copy'
            });
            copyWikiBtn.on('click', () => this.copyReportToClipboard('wikitext'));
            actionsEl.appendChild(copyWikiBtn.$element[0]);

            const copyTextBtn = new OO.ui.ButtonWidget({
                label: 'Copy Report (Plain Text)',
                flags: ['safe'],
                icon: 'copy'
            });
            copyTextBtn.on('click', () => this.copyReportToClipboard('plaintext'));
            actionsEl.appendChild(copyTextBtn.$element[0]);
        }

        generateWikitextReport() {
            const articleTitle = typeof mw !== 'undefined' ? mw.config.get('wgTitle') : document.title;
            const providerName = this.providers[this.currentProvider].name;

            let wikitext = `== Citation verification report ==\n`;
            wikitext += `This is an experimental check of the article sources by [[User:Alaexis/AI_Source_Verification|Citation Verifier]]. Treat it with caution, be aware of its [[User:Alaexis/AI_Source_Verification#Limitations]] and feel free to leave feedback at [[User_talk:Alaexis/AI_Source_Verification]].\n\n`;
            wikitext += `{| class="wikitable sortable"\n`;
            wikitext += `|-\n! # !! Verdict !! Confidence !! Source !! Comments\n`;

            for (const r of this.reportResults) {
                let verdictWiki;
                switch (r.verdict) {
                    case 'SUPPORTED': verdictWiki = '{{tick}} Supported'; break;
                    case 'PARTIALLY SUPPORTED': verdictWiki = '{{bang}} Partially supported'; break;
                    case 'NOT SUPPORTED': verdictWiki = '{{cross}} Not supported'; break;
                    case 'SOURCE UNAVAILABLE': verdictWiki = '{{hmmm}} Source unavailable'; break;
                    default: verdictWiki = r.verdict; break;
                }
                const confStr = r.confidence !== null ? `${r.confidence}%` : '—';
                const sourceStr = r.url ? `[${r.url} source]` : '—';
                const commentsClean = (r.comments || '').replace(/\n/g, ' ');
                wikitext += `|-\n| [${r.citationNumber}] || ${verdictWiki} || ${confStr} || ${sourceStr} || ${commentsClean}\n`;
            }

            wikitext += `|}\n\n`;

            const counts = { supported: 0, partial: 0, notSupported: 0, unavailable: 0 };
            for (const r of this.reportResults) {
                if (r.verdict === 'SUPPORTED') counts.supported++;
                else if (r.verdict === 'PARTIALLY SUPPORTED') counts.partial++;
                else if (r.verdict === 'NOT SUPPORTED') counts.notSupported++;
                else counts.unavailable++;
            }
            wikitext += `'''Summary:''' ${counts.supported} supported, ${counts.partial} partially supported, ${counts.notSupported} not supported, ${counts.unavailable} source unavailable out of ${this.reportResults.length} citations.\n`;
            if (this.reportTokenUsage.input + this.reportTokenUsage.output > 0) {
                wikitext += `\nTokens used: ${this.reportTokenUsage.input.toLocaleString()} input, ${this.reportTokenUsage.output.toLocaleString()} output.\n`;
            }

            return wikitext;
        }

        generatePlainTextReport() {
            const articleTitle = typeof mw !== 'undefined' ? mw.config.get('wgTitle') : document.title;
            let text = `Citation Verification Report: ${articleTitle}\n`;
            text += `Provider: ${this.providers[this.currentProvider].name}\n`;
            text += `${'='.repeat(60)}\n\n`;

            for (const r of this.reportResults) {
                const confStr = r.confidence !== null ? ` (${r.confidence}%)` : '';
                text += `[${r.citationNumber}] ${r.verdict}${confStr}\n`;
                text += `  Claim: ${r.claimText.substring(0, 100)}${r.claimText.length > 100 ? '...' : ''}\n`;
                if (r.url) text += `  Source: ${r.url}\n`;
                if (r.comments) text += `  Comments: ${r.comments}\n`;
                text += `\n`;
            }

            if (this.reportTokenUsage.input + this.reportTokenUsage.output > 0) {
                text += `Tokens used: ${this.reportTokenUsage.input.toLocaleString()} input, ${this.reportTokenUsage.output.toLocaleString()} output\n`;
            }

            return text;
        }

        async copyReportToClipboard(format) {
            const text = format === 'wikitext' ? this.generateWikitextReport() : this.generatePlainTextReport();
            try {
                await navigator.clipboard.writeText(text);
                mw.notify('Report copied to clipboard!', { type: 'info', autoHide: true, autoHideSeconds: 3 });
            } catch (e) {
                // Fallback
                const textarea = document.createElement('textarea');
                textarea.value = text;
                document.body.appendChild(textarea);
                textarea.select();
                document.execCommand('copy');
                document.body.removeChild(textarea);
                mw.notify('Report copied to clipboard!', { type: 'info', autoHide: true, autoHideSeconds: 3 });
            }
        }

        async callProviderAPI(claim, sourceInfo) {
            switch (this.currentProvider) {
                case 'publicai': return await this.callPublicAIAPI(claim, sourceInfo);
                case 'claude': return await this.callClaudeAPI(claim, sourceInfo);
                case 'gemini': return await this.callGeminiAPI(claim, sourceInfo);
                case 'openai': return await this.callOpenAIAPI(claim, sourceInfo);
                default: throw new Error(`Unknown provider: ${this.currentProvider}`);
            }
        }

        async verifyAllCitations() {
            const citations = this.collectAllCitations();
            if (citations.length === 0) {
                mw.notify('No citations found on this page.', { type: 'warn', autoHide: true });
                return;
            }

            // Estimate time and show confirmation
            const uniqueUrls = new Set(citations.filter(c => c.url).map(c => c.url));
            const estimatedSeconds = citations.length * 7;
            const estimatedMinutes = Math.ceil(estimatedSeconds / 60);

            const confirmed = await new Promise(resolve => {
                OO.ui.confirm(
                    `This will verify ${citations.length} citations from ${uniqueUrls.size} unique sources.\n\nEstimated time: ~${estimatedMinutes} minute${estimatedMinutes > 1 ? 's' : ''}.\n\nContinue?`
                ).done(result => resolve(result));
            });
            if (!confirmed) return;

            // Setup
            this.reportMode = true;
            this.reportRunning = true;
            this.reportCancelled = false;
            this.reportResults = [];
            this.sourceCache = new Map();
            this.reportTokenUsage = { input: 0, output: 0 };
            this.hasReport = true;

            this.showReportView();
            document.getElementById('verifier-report-results').innerHTML = '';
            document.getElementById('verifier-report-summary').innerHTML = '';
            document.getElementById('verifier-report-actions').innerHTML = '';
            this.updateButtonVisibility();

            const startTime = Date.now();
            const useProxy = this.currentProvider === 'publicai';
            const delayBetweenCalls = useProxy ? 3000 : 1000;

            for (let i = 0; i < citations.length; i++) {
                if (this.reportCancelled) break;

                const citation = citations[i];
                this.updateReportProgress(i, citations.length, `Checking citation [${citation.citationNumber}]`, startTime);

                let result;

                if (!citation.url) {
                    // No URL found
                    result = {
                        citationNumber: citation.citationNumber,
                        claimText: citation.claimText,
                        url: null,
                        refElement: citation.refElement,
                        verdict: 'SOURCE UNAVAILABLE',
                        confidence: 0,
                        comments: 'No URL found in reference'
                    };
                } else {
                    // Fetch source if not cached
                    const cacheKey = citation.pageNum ? `${citation.url}|page=${citation.pageNum}` : citation.url;

                    if (!this.sourceCache.has(cacheKey)) {
                        this.updateReportProgress(i, citations.length, `Fetching source for [${citation.citationNumber}]`, startTime);
                        try {
                            const sourceContent = await this.fetchSourceContent(citation.url, citation.pageNum);
                            this.sourceCache.set(cacheKey, sourceContent);
                        } catch (e) {
                            this.sourceCache.set(cacheKey, null);
                        }
                        // Rate limit delay after fetch
                        if (!this.reportCancelled) {
                            await new Promise(r => setTimeout(r, delayBetweenCalls));
                        }
                    }

                    if (this.reportCancelled) break;

                    const sourceContent = this.sourceCache.get(cacheKey);

                    if (!sourceContent) {
                        result = {
                            citationNumber: citation.citationNumber,
                            claimText: citation.claimText,
                            url: citation.url,
                            refElement: citation.refElement,
                            verdict: 'SOURCE UNAVAILABLE',
                            confidence: 0,
                            comments: 'Could not fetch source content'
                        };
                    } else {
                        // Verify via LLM
                        this.updateReportProgress(i, citations.length, `Verifying citation [${citation.citationNumber}]`, startTime);
                        try {
                            const apiResult = await this.callProviderAPI(citation.claimText, sourceContent);
                            const parsed = this.parseVerificationResult(apiResult.text);
                            this.reportTokenUsage.input += apiResult.usage.input;
                            this.reportTokenUsage.output += apiResult.usage.output;
                            result = {
                                citationNumber: citation.citationNumber,
                                claimText: citation.claimText,
                                url: citation.url,
                                refElement: citation.refElement,
                                verdict: parsed.verdict,
                                confidence: parsed.confidence,
                                comments: parsed.comments
                            };

                            // Fire-and-forget logging
                            try {
                                const savedCitationNumber = this.activeCitationNumber;
                                const savedSourceUrl = this.activeSourceUrl;
                                this.activeCitationNumber = citation.citationNumber;
                                this.activeSourceUrl = citation.url;
                                this.logVerification(parsed.verdict, parsed.confidence);
                                this.activeCitationNumber = savedCitationNumber;
                                this.activeSourceUrl = savedSourceUrl;
                            } catch (e) {}
                        } catch (e) {
                            // Check for rate limiting (429)
                            let retried = false;
                            if (e.message && e.message.includes('429')) {
                                for (let attempt = 0; attempt < 3; attempt++) {
                                    if (this.reportCancelled) break;
                                    const backoff = [5000, 10000, 20000][attempt];
                                    this.updateReportProgress(i, citations.length, `Rate limited, retrying in ${backoff/1000}s...`, startTime);
                                    await new Promise(r => setTimeout(r, backoff));
                                    try {
                                        const retryApiResult = await this.callProviderAPI(citation.claimText, sourceContent);
                                        const parsed = this.parseVerificationResult(retryApiResult.text);
                                        this.reportTokenUsage.input += retryApiResult.usage.input;
                                        this.reportTokenUsage.output += retryApiResult.usage.output;
                                        result = {
                                            citationNumber: citation.citationNumber,
                                            claimText: citation.claimText,
                                            url: citation.url,
                                            refElement: citation.refElement,
                                            verdict: parsed.verdict,
                                            confidence: parsed.confidence,
                                            comments: parsed.comments
                                        };
                                        retried = true;
                                        break;
                                    } catch (retryErr) {
                                        if (!retryErr.message?.includes('429')) {
                                            break;
                                        }
                                    }
                                }
                            }
                            if (!retried) {
                                result = {
                                    citationNumber: citation.citationNumber,
                                    claimText: citation.claimText,
                                    url: citation.url,
                                    refElement: citation.refElement,
                                    verdict: 'ERROR',
                                    confidence: null,
                                    comments: e.message
                                };
                            }
                        }

                        // Rate limit delay after LLM call
                        if (!this.reportCancelled && i < citations.length - 1) {
                            await new Promise(r => setTimeout(r, delayBetweenCalls));
                        }
                    }
                }

                if (result) {
                    this.reportResults.push(result);
                    this.renderReportCard(result, this.reportResults.length - 1);
                    this.renderReportSummary();
                }
            }

            // Finalize
            this.reportRunning = false;
            const finalPhase = this.reportCancelled
                ? `Cancelled after ${this.reportResults.length} of ${citations.length} citations`
                : `Completed: ${this.reportResults.length} citations checked`;
            this.updateReportProgress(this.reportResults.length, citations.length, finalPhase, startTime);
            this.renderReportSummary();
            this.renderReportActions();
            this.updateButtonVisibility();
        }

        findSectionNumber() {
            if (!this.activeRefElement) return 0;

            const content = document.getElementById('mw-content-text');
            if (!content) return 0;

            const headings = content.querySelectorAll('h2, h3, h4, h5, h6');
            let sectionNumber = 0;

            for (const heading of headings) {
                const position = heading.compareDocumentPosition(this.activeRefElement);
                if (position & Node.DOCUMENT_POSITION_FOLLOWING) {
                    sectionNumber++;
                } else {
                    break;
                }
            }

            return sectionNumber;
        }

        buildEditUrl() {
            const title = mw.config.get('wgPageName');
            const section = this.findSectionNumber();
            const summary = 'source does not support claim (checked with [[User:Alaexis/AI_Source_Verification|Source Verifier]])';

            const params = { action: 'edit', summary: summary };
            if (section > 0) {
                params.section = section;
            }

            return mw.util.getUrl(title, params);
        }


        showActionButton(verdict) {
            const container = document.getElementById('verifier-action-container');
            if (!container) return;

            container.innerHTML = '';

            if (verdict !== 'NOT SUPPORTED' && verdict !== 'PARTIALLY SUPPORTED' && verdict !== 'SOURCE UNAVAILABLE') return;

            const btn = new OO.ui.ButtonWidget({
                label: 'Add {{Failed verification}}',
                flags: ['progressive'],
                icon: 'edit',
                href: this.buildEditUrl(),
                target: '_blank'
            });

            container.appendChild(btn.$element[0]);
        }

        clearResult() {
            const verdictEl = document.getElementById('verifier-verdict');
            const commentsEl = document.getElementById('verifier-comments');
            
            if (verdictEl) {
                verdictEl.textContent = '';
                verdictEl.className = '';
            }
            if (commentsEl) {
                commentsEl.textContent = 'Click "Verify Claim" to verify the selected claim against the source.';
            }
            const actionContainer = document.getElementById('verifier-action-container');
            if (actionContainer) {
                actionContainer.innerHTML = '';
            }
        }
    }
    
    if (typeof mw !== 'undefined' && [0, 118].includes(mw.config.get('wgNamespaceNumber'))) {
        mw.loader.using(['mediawiki.util', 'mediawiki.api', 'oojs-ui-core', 'oojs-ui-widgets', 'oojs-ui-windows']).then(function() {
            $(function() {
                new WikipediaSourceVerifier();
            });
        });
    }
})();
