// {{Wikipedia:USync |repo=https://github.com/alex-o-748/citation-checker-script |ref=refs/heads/main|path=main.js}}
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
            this.isVisible = localStorage.getItem('verifier_sidebar_visible') !== 'false';
            this.buttons = {};
            this.activeClaim = null;
            this.activeSource = null;
            this.sourceTextInput = null;
            
            this.init();
        }
        
        init() {
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
                    <h3>Source Verifier</h3>
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
                    padding: 0.5em !important;
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
                .verifier-sidebar-hidden body {
                    margin-right: 0 !important;
                }
                .verifier-sidebar-hidden #source-verifier-sidebar {
                    display: none;
                }
                .verifier-sidebar-hidden #ca-verifier,
                .verifier-sidebar-hidden #t-verifier {
                    display: list-item !important;
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
                    background: #1a1a2e;
                    color: #e0e0e0;
                    border-left-color: ${this.getCurrentColor()};
                    box-shadow: -2px 0 8px rgba(0,0,0,0.4);
                }
                html.skin-theme-clientpref-night #verifier-sidebar-content {
                    background: #1a1a2e;
                    color: #e0e0e0;
                }
                html.skin-theme-clientpref-night #verifier-provider-info {
                    background: #2a2a3e;
                    color: #b0b0c0;
                    border-color: #3a3a4e;
                }
                html.skin-theme-clientpref-night #verifier-provider-info.free-provider {
                    background: #1a2e1a;
                    color: #6ecf6e;
                }
                html.skin-theme-clientpref-night #verifier-claim-section h4,
                html.skin-theme-clientpref-night #verifier-source-section h4,
                html.skin-theme-clientpref-night #verifier-results h4 {
                    color: ${this.getCurrentColor()};
                    filter: brightness(1.3);
                }
                html.skin-theme-clientpref-night #verifier-claim-text,
                html.skin-theme-clientpref-night #verifier-source-text {
                    background: #2a2a3e;
                    border-color: #3a3a4e;
                    color: #e0e0e0;
                }
                html.skin-theme-clientpref-night #verifier-verdict.supported {
                    background: #1a3a1a;
                    color: #6ecf6e;
                    border-color: #2a5a2a;
                }
                html.skin-theme-clientpref-night #verifier-verdict.partially-supported {
                    background: #3a3a1a;
                    color: #e0c060;
                    border-color: #5a5a2a;
                }
                html.skin-theme-clientpref-night #verifier-verdict.not-supported {
                    background: #3a1a1a;
                    color: #e06060;
                    border-color: #5a2a2a;
                }
                html.skin-theme-clientpref-night #verifier-verdict.source-unavailable {
                    background: #2a2a2e;
                    color: #a0a0a8;
                    border-color: #3a3a3e;
                }
                html.skin-theme-clientpref-night #verifier-comments {
                    background: #2a2a3e;
                    border-color: #3a3a4e;
                    color: #e0e0e0;
                }
                html.skin-theme-clientpref-night .verifier-error {
                    color: #ff8080;
                    background: #3a1a1a;
                    border-color: #5a2a2a;
                }
                html.skin-theme-clientpref-night .reference:hover {
                    background-color: rgba(100, 149, 237, 0.15);
                }
                html.skin-theme-clientpref-night .claim-highlight {
                    background-color: #3a3a1a;
                }
                html.skin-theme-clientpref-night #verifier-source-textarea-container textarea {
                    background: #2a2a3e;
                    color: #e0e0e0;
                    border-color: #3a3a4e;
                }

                /* Support auto dark mode via OS preference */
                @media (prefers-color-scheme: dark) {
                    html.skin-theme-clientpref--os #source-verifier-sidebar {
                        background: #1a1a2e;
                        color: #e0e0e0;
                        border-left-color: ${this.getCurrentColor()};
                        box-shadow: -2px 0 8px rgba(0,0,0,0.4);
                    }
                    html.skin-theme-clientpref--os #verifier-sidebar-content {
                        background: #1a1a2e;
                        color: #e0e0e0;
                    }
                    html.skin-theme-clientpref--os #verifier-provider-info {
                        background: #2a2a3e;
                        color: #b0b0c0;
                        border-color: #3a3a4e;
                    }
                    html.skin-theme-clientpref--os #verifier-provider-info.free-provider {
                        background: #1a2e1a;
                        color: #6ecf6e;
                    }
                    html.skin-theme-clientpref--os #verifier-claim-section h4,
                    html.skin-theme-clientpref--os #verifier-source-section h4,
                    html.skin-theme-clientpref--os #verifier-results h4 {
                        color: ${this.getCurrentColor()};
                        filter: brightness(1.3);
                    }
                    html.skin-theme-clientpref--os #verifier-claim-text,
                    html.skin-theme-clientpref--os #verifier-source-text {
                        background: #2a2a3e;
                        border-color: #3a3a4e;
                        color: #e0e0e0;
                    }
                    html.skin-theme-clientpref--os #verifier-verdict.supported {
                        background: #1a3a1a;
                        color: #6ecf6e;
                        border-color: #2a5a2a;
                    }
                    html.skin-theme-clientpref--os #verifier-verdict.partially-supported {
                        background: #3a3a1a;
                        color: #e0c060;
                        border-color: #5a5a2a;
                    }
                    html.skin-theme-clientpref--os #verifier-verdict.not-supported {
                        background: #3a1a1a;
                        color: #e06060;
                        border-color: #5a2a2a;
                    }
                    html.skin-theme-clientpref--os #verifier-verdict.source-unavailable {
                        background: #2a2a2e;
                        color: #a0a0a8;
                        border-color: #3a3a3e;
                    }
                    html.skin-theme-clientpref--os #verifier-comments {
                        background: #2a2a3e;
                        border-color: #3a3a4e;
                        color: #e0e0e0;
                    }
                    html.skin-theme-clientpref--os .verifier-error {
                        color: #ff8080;
                        background: #3a1a1a;
                        border-color: #5a2a2a;
                    }
                    html.skin-theme-clientpref--os .reference:hover {
                        background-color: rgba(100, 149, 237, 0.15);
                    }
                    html.skin-theme-clientpref--os .claim-highlight {
                        background-color: #3a3a1a;
                    }
                    html.skin-theme-clientpref--os #verifier-source-textarea-container textarea {
                        background: #2a2a3e;
                        color: #e0e0e0;
                        border-color: #3a3a4e;
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
                const hasClaimAndSource = this.activeClaim && this.activeSource;
                this.buttons.verify.setDisabled(!hasClaimAndSource);
                container.appendChild(this.buttons.verify.$element[0]);
                
                // Only show key management buttons for providers that use user keys
                if (requiresKey) {
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
                        portletId = 'p-namespaces';
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
                    }
                } catch (error) {
                    console.warn('Could not create verifier tab:', error);
                }
            }
        }
        
        attachReferenceClickHandlers() {
            const references = document.querySelectorAll('.reference a');
            references.forEach(ref => {
                ref.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    this.handleReferenceClick(ref);
                });
            });
        }
        
        async handleReferenceClick(refElement) {
            try {
                this.clearHighlights();
                this.showSidebar();
                
                // Clear previous verification result to avoid confusion
                this.clearResult();
                
                const claim = this.extractClaimText(refElement);
                if (!claim) {
                    this.updateStatus('Could not extract claim text', true);
                    return;
                }
                
                this.highlightClaim(refElement, claim);
                refElement.parentElement.classList.add('verifier-active');
                
                this.activeClaim = claim;
                document.getElementById('verifier-claim-text').textContent = claim;
                
                const refUrl = this.extractReferenceUrl(refElement);
                
                if (!refUrl) {
                    this.showSourceTextInput();
                    this.updateStatus('No URL found in reference. Please paste the source text below.');
                    return;
                }
                
                this.hideSourceTextInput();
                this.updateStatus('Fetching source content...');
                const sourceInfo = await this.fetchSourceContent(refUrl);
                
                if (!sourceInfo) {
                    this.showSourceTextInput();
                    this.updateStatus('Could not fetch source. Please paste the source text below.');
                    return;
                }
                
                this.activeSource = sourceInfo;
                const sourceElement = document.getElementById('verifier-source-text');
                
                const urlMatch = sourceInfo.match(/Source URL: (https?:\/\/[^\s\n]+)/);
                const contentFetched = sourceInfo.includes('Source Content:');
                
                if (urlMatch) {
                    sourceElement.innerHTML = `
                        <strong>Source URL:</strong><br>
                        <a href="${urlMatch[1]}" target="_blank" style="word-break: break-all;">${urlMatch[1]}</a><br><br>
                        ${contentFetched 
                            ? '<span style="color: #2e7d32;">✓ Content fetched successfully</span>' 
                            : '<em>Content will be fetched by AI during verification.</em>'}
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
                return null;
            }
            
            const refId = href.substring(1);
            const refTarget = document.getElementById(refId);
            
            if (!refTarget) {
                return null;
            }
            
            // First look for archive links (prioritize these)
            const archiveLink = refTarget.querySelector('a[href*="web.archive.org"], a[href*="archive.today"], a[href*="archive.is"], a[href*="archive.ph"], a[href*="webcitation.org"]');
            if (archiveLink) return archiveLink.href;
            
            // Fall back to any http link
            const links = refTarget.querySelectorAll('a[href^="http"]');
            if (links.length === 0) return null;
            return links[0].href;
        }
        
        async fetchSourceContent(url) {
            try {
                const proxyUrl = `https://publicai-proxy.alaexis.workers.dev/?fetch=${encodeURIComponent(url)}`;
                const response = await fetch(proxyUrl);
                const data = await response.json();
                
                if (data.content && data.content.length > 100) {
                    return `Source URL: ${url}\n\nSource Content:\n${data.content}`;
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
- Actual content from the original source, even if it includes some navigation or boilerplate

It is NOT usable if it's:
- A library catalog, database record, or book metadata (e.g., WorldCat, Google Books, JSTOR preview pages)
- Google Books, also Google Books in Internet Archive
- A paywall, login page, or access denied message
- A cookie consent notice or JavaScript error
- A 404 page or redirect notice
- Just bibliographic information without the actual content being cited

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
        
        async verifyClaim() {
            const requiresKey = this.providerRequiresKey();
            const hasKey = !!this.getCurrentApiKey();
            
            // Only require a browser key for providers that need it
            if ((requiresKey && !hasKey) || !this.activeClaim || !this.activeSource) {
                this.updateStatus('Missing API key (for this provider), claim, or source content', true);
                return;
            }
            
            try {
                this.buttons.verify.setDisabled(true);
                this.updateStatus('Verifying claim against source...');
                
                let result;
                
                switch (this.currentProvider) {
                    case 'publicai':
                        result = await this.callPublicAIAPI(this.activeClaim, this.activeSource);
                        break;
                    case 'claude':
                        result = await this.callClaudeAPI(this.activeClaim, this.activeSource);
                        break;
                    case 'gemini':
                        result = await this.callGeminiAPI(this.activeClaim, this.activeSource);
                        break;
                    case 'openai':
                        result = await this.callOpenAIAPI(this.activeClaim, this.activeSource);
                        break;
                }
                
                this.updateStatus('Verification complete!');
                this.displayResult(result);
                
            } catch (error) {
                console.error('Verification error:', error);
                this.updateStatus(`Error: ${error.message}`, true);
                document.getElementById('verifier-verdict').textContent = 'ERROR';
                document.getElementById('verifier-verdict').className = 'source-unavailable';
                document.getElementById('verifier-comments').textContent = error.message;
            } finally {
                this.buttons.verify.setDisabled(false);
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
            
            return data.choices[0].message.content;
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
            return data.content[0].text;
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
            
            return responseData.candidates[0].content.parts[0].text;
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
            
            return data.choices[0].message.content;
        }
        
	displayResult(response) {
	    const verdictEl = document.getElementById('verifier-verdict');
	    const commentsEl = document.getElementById('verifier-comments');
	    
	    try {
	        // Clean up the response text
	        let jsonStr = response.trim();
	        
	        // First, try to extract JSON from markdown code blocks
	        const codeBlockMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
	        if (codeBlockMatch) {
	            jsonStr = codeBlockMatch[1].trim();
	        }
	        
	        // If no code block, try to extract JSON object from text
	        // This handles cases where AI adds explanation before/after JSON
	        if (!codeBlockMatch) {
	            const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
	            if (jsonMatch) {
	                jsonStr = jsonMatch[0];
	            }
	        }
	        
	        // Try to parse the JSON
	        let result;
	        try {
	            result = JSON.parse(jsonStr);
	        } catch (parseError) {
	            console.error('JSON parsing failed:', parseError);
	            console.error('Attempted to parse:', jsonStr);
	            console.error('Original response:', response);
	            
	            // Show error in UI
	            verdictEl.textContent = 'ERROR';
	            verdictEl.className = 'source-unavailable';
	            commentsEl.innerHTML = `<strong>Failed to parse AI response.</strong><br><br>Raw response:<br><pre style="white-space: pre-wrap; font-size: 11px;">${response}</pre>`;
	            return;
	        }
	        
	        const verdict = result.verdict || 'UNKNOWN';
	        const comments = result.comments || '';
	        
	        // Set verdict text and styling
	        verdictEl.textContent = verdict;
	        verdictEl.className = '';
	        
	        if (verdict === 'SUPPORTED') {
	            verdictEl.classList.add('supported');
	        } else if (verdict === 'PARTIALLY SUPPORTED') {
	            verdictEl.classList.add('partially-supported');
	        } else if (verdict === 'NOT SUPPORTED') {
	            verdictEl.classList.add('not-supported');
	        } else if (verdict === 'SOURCE UNAVAILABLE') {
	            verdictEl.classList.add('source-unavailable');
	        }
	        
	        commentsEl.textContent = comments;
	        
	    } catch (e) {
	        // Catch-all fallback if something else goes wrong
	        console.error('Unexpected error in displayResult:', e);
	        verdictEl.textContent = 'ERROR';
	        verdictEl.className = 'source-unavailable';
	        commentsEl.innerHTML = `<strong>Unexpected error:</strong> ${e.message}<br><br>Raw response:<br><pre style="white-space: pre-wrap; font-size: 11px;">${response}</pre>`;
	    }
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
