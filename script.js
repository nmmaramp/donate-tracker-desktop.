// ==UserScript==
// @name         Donate Tracker - PNP + FC Research (V6.4.8)
// @namespace    http://tampermonkey.net/
// @version      6.4.8
// @description  Strict filtering + Auto-summing + 250kg Max Shuttle Weight Safety Alert + Excel Total Row & Metadata.
// @author       nmmaramp
// @match        https://pnp-dub.aka.amazon.com/*
// @match        https://fcresearch-eu.aka.amazon.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// ==/UserScript==

(function () {
    'use strict';

    const IS_PNP = window.location.hostname.includes('pnp-dub');
    const IS_FCR = window.location.hostname.includes('fcresearch-eu');
    const MAX_SHUTTLE_WEIGHT = 250.0; // Limite di sicurezza in kg

    let carouselIndex = 0;
    let weightAlertTriggered = false; // Flag per evitare spam infinito del pop-up

    // DATABASE MANAGEMENT
    function loadDB()           { try { return JSON.parse(GM_getValue('donateDB', '{}')); }          catch { return {}; } }
    function saveDB(db)         { GM_setValue('donateDB', JSON.stringify(db)); }
    function loadSession()      { try { return consolidateSession(JSON.parse(GM_getValue('donateSession', '[]'))); } catch { return []; } }
    function saveSession(s)     { GM_setValue('donateSession', JSON.stringify(consolidateSession(s))); }
    function loadPending()      { try { return JSON.parse(GM_getValue('donatePending', '[]')); }     catch { return []; } }
    function savePending(p)     { GM_setValue('donatePending', JSON.stringify(p)); }
    function loadWeightQueue()  { try { return JSON.parse(GM_getValue('donateWeightQueue', '[]')); } catch { return []; } }
    function saveWeightQueue(q) { GM_setValue('donateWeightQueue', JSON.stringify(q)); }
    function loadRecentLots()   { try { return JSON.parse(GM_getValue('donateRecentLots', '[]')); }  catch { return []; } }
    function saveRecentLots(l)  { GM_setValue('donateRecentLots', JSON.stringify(l)); }

    // UTILITY: Consolidamento automatico per stesso fnSKU o ASIN
    function consolidateSession(session) {
        if (!Array.isArray(session)) return [];
        const map = [];
        session.forEach(function(item) {
            if (!item) return;
            const existing = map.find(function(entry) {
                const matchFnsku = item.fnsku && entry.fnsku && item.fnsku === entry.fnsku;
                const matchAsin  = item.asin && entry.asin && item.asin === entry.asin;
                return matchFnsku || matchAsin;
            });

            if (existing) {
                existing.qty = (parseInt(existing.qty) || 0) + (parseInt(item.qty) || 1);
                if (item.toteId && existing.toteId && !existing.toteId.includes(item.toteId)) {
                    existing.toteId += ', ' + item.toteId;
                }
                if (!existing.fnsku && item.fnsku) existing.fnsku = item.fnsku;
                if (!existing.asin && item.asin) existing.asin = item.asin;
                if (!existing.description && item.description) existing.description = item.description;
                if (item.type === 'BOO') existing.type = 'BOO';
                if (item.isFood === 'Y') existing.isFood = 'Y';
                if (item.expiryDate && item.expiryDate !== '-' && existing.expiryDate === '-') existing.expiryDate = item.expiryDate;
            } else {
                map.push(Object.assign({}, item));
            }
        });
        return map;
    }

    // Rilevamento FC e Operatore
    function getAutoFC() {
        if (IS_FCR) {
            const match = window.location.pathname.match(/^\/([A-Z0-9]+)\//i);
            if (match) return match[1].toUpperCase();
        }
        return GM_getValue('dt_current_fc', 'FCO1');
    }
    function getOperator() {
        return GM_getValue('dt_current_operator', 'Operatore');
    }

    // UTILITY: Descrizione estesa (mantiene l'intero testo senza tagli)
    function cleanAndTruncate(str) {
        if (!str) return '';
        let cleaned = str.replace(/^(title|titolo|product name|description|item name)\s*:\s*/i, '');
        return cleaned.replace(/\s+/g, ' ').trim();
    }

    // Check se la descrizione corrisponde ad Abbigliamento o Calzature
    function isApparelOrShoes(description) {
        if (!description) return false;
        const regex = /shoe|scarp|apparel|cloth|vestit|magli|pantal|stival|sneaker|t-shirt|shirt|jacket|giacca|calzatur|dress|skirt|coat|trouser|sock|underwear|jeans|hoodie|felpa/i;
        return regex.test(description);
    }

    // CLASSIFIER (fnSKU Priority)
    function classify(fnsku, asin) {
        const fn = (fnsku || '').toUpperCase();
        const as = (asin  || '').toUpperCase();
        if (fn.startsWith('X0')) return 'XOO';
        if (fn.startsWith('B0')) return 'BOO';
        if (as.startsWith('B0')) return 'BOO';
        return 'OTHER';
    }

    function validateLot(val) {
        const v = (val || '').toUpperCase().trim();
        if (v.length === 0) return { valid: false, msg: '' };
        const match = v.match(/^([A-Z])(\d+)$/);
        if (!match) return { valid: false, msg: 'Format must be: Letter + Number (e.g. E11)' };
        const num = parseInt(match[2]);
        if (num < 1 || num > 33) return { valid: false, msg: 'Number must be between 1 and 33' };
        return { valid: true, msg: 'Valid lot: ' + v, lot: v };
    }

    // ==========================================
    // PNP LOGIC
    // ==========================================
    function initPNP() {
        interceptXHR();
        interceptFetch();
        createPanel();
        setInterval(function() { renderSession(); checkFCRHeartbeat(); }, 2000);
        setupGlobalKeybinds();
    }

    function checkFCRHeartbeat() {
        const lastActive = GM_getValue('fcr_last_active', 0);
        const alertBanner = document.getElementById('dt-fcr-alert');
        const statusEl = document.getElementById('dt-status-indicator');

        if (Date.now() - lastActive < 7000) {
            if (alertBanner) alertBanner.style.display = 'none';
            if (statusEl) statusEl.innerHTML = '<span style="color:#00ff88;font-weight:bold;">● FCR ONLINE</span>';
        } else {
            if (alertBanner) alertBanner.style.display = 'block';
            if (statusEl) statusEl.innerHTML = '<span style="color:#ff7675;font-weight:bold;animation:dt-blink 1s infinite;">⚠️ FCR OFFLINE</span>';
        }
    }

    function interceptXHR() {
        const originalOpen = XMLHttpRequest.prototype.open;
        const originalSend = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.open = function (method, url) {
            this._url = url;
            return originalOpen.apply(this, arguments);
        };
        XMLHttpRequest.prototype.send = function (body) {
            const xhr = this;
            const url = this._url || '';
            if (url.includes('getOpenPallets')) {
                const orig = xhr.onreadystatechange;
                xhr.onreadystatechange = function () {
                    if (xhr.readyState === 4 && xhr.status === 200) {
                        const toteId = extractToteId(body);
                        if (toteId) {
                            if (toteId.toUpperCase().startsWith('SPRSMT')) return;
                            handleToteDetected(toteId);
                        }
                    }
                    if (orig) orig.apply(this, arguments);
                };
            }
            return originalSend.apply(this, arguments);
        };
    }

    function interceptFetch() {
        const originalFetch = window.fetch;
        window.fetch = function (input, init) {
            const url = typeof input === 'string' ? input : (input && input.url ? input.url : '');
            const promise = originalFetch.apply(this, arguments);
            if (url.includes('getOpenPallets')) {
                promise.then(function(response) {
                    if (response.ok) {
                        const toteId = extractToteId((init && init.body) ? init.body : '');
                        if (toteId) {
                            if (toteId.toUpperCase().startsWith('SPRSMT')) return;
                            handleToteDetected(toteId);
                        }
                    }
                }).catch(function() {});
            }
            return promise;
        };
    }

    function extractToteId(body) {
        if (!body) return null;
        try { const p = new URLSearchParams(body); if (p.get('toteScannableId')) return p.get('toteScannableId'); } catch(e) {}
        try { const j = JSON.parse(body); if (j.toteScannableId) return j.toteScannableId; } catch(e) {}
        return null;
    }

    function handleToteDetected(toteId) {
        if (!toteId) return;
        const pending = loadPending();
        if (!pending.includes(toteId)) {
            pending.push(toteId);
            savePending(pending);
        }
        const currentFC = GM_getValue('dt_current_fc', 'FCO1');
        showToast('Tote rilevato: ' + toteId + ' - Apertura FC Research...');
        setTimeout(function() {
            window.open('https://fcresearch-eu.aka.amazon.com/' + currentFC + '/results?s=' + toteId, '_blank');
        }, 800);
    }

    // ==========================================
    // FC RESEARCH LOGIC
    // ==========================================
    function initFCResearch() {
        GM_setValue('fcr_last_active', Date.now());
        setInterval(function() { GM_setValue('fcr_last_active', Date.now()); }, 2000);

        const detectedFC = getAutoFC();
        GM_setValue('dt_current_fc', detectedFC);

        const urlParams = new URLSearchParams(window.location.search);
        const searchId  = urlParams.get('s');
        if (!searchId) return;

        const weightQueue = loadWeightQueue();
        const isWeightItem = weightQueue.find(function(q) { return q.fnsku === searchId || q.asin === searchId; });
        if (isWeightItem) {
            waitForAsinPage(function() { processWeightPage(searchId, weightQueue); });
            return;
        }

        waitForPending(searchId, 0);
    }

    function waitForPending(toteId, attempt) {
        const pending = loadPending();
        if (pending.includes(toteId)) {
            waitForTotePage(function() { processTotePage(toteId, pending); });
            return;
        }
        if (attempt >= 10) {
            showToast('Tote non in coda pending - chiusura finestra.');
            setTimeout(function() { window.close(); }, 1500);
            return;
        }
        setTimeout(function() { waitForPending(toteId, attempt + 1); }, 1000);
    }

    function waitForTotePage(callback, attempt) {
        if (attempt === undefined) attempt = 0;
        const rows = document.querySelectorAll('tbody tr');
        if (rows.length > 0) { callback(); return; }
        if (attempt >= 15) {
            showToast('Timeout caricamento pagina Tote.');
            setTimeout(function() { window.close(); }, 1500);
            return;
        }
        setTimeout(function() { waitForTotePage(callback, attempt + 1); }, 1000);
    }

    function waitForAsinPage(callback, attempt) {
        if (attempt === undefined) attempt = 0;
        const text = document.body.innerText.toLowerCase();
        const isReady = text.includes('title') || text.includes('titolo') || text.includes('product name') || text.includes('weight') || text.includes('peso');
        if (isReady) {
            setTimeout(callback, 300);
            return;
        }
        if (attempt >= 20) {
            callback();
            return;
        }
        setTimeout(function() { waitForAsinPage(callback, attempt + 1); }, 1000);
    }

    function processTotePage(toteId, pending) {
        const items = parseInventoryPage(toteId);
        if (items.length === 0) {
            showToast('Nessun articolo valido trovato nel tote ' + toteId);
            savePending(pending.filter(function(p) { return p !== toteId; }));
            setTimeout(function() { window.close(); }, 1500);
            return;
        }

        let session = loadSession();
        const db = loadDB();
        const needDetails = [];

        items.forEach(function(item) {
            item.description = '';
            item.isFood = 'N';
            item.expiryDate = '-';
            session.push(item);
        });

        session = consolidateSession(session);

        session.forEach(function(item) {
            const hasWeight = db[item.fnsku] || db[item.asin];
            if (item.type === 'BOO' && !hasWeight) {
                if (!needDetails.find(function(n) { return (item.fnsku && n.fnsku === item.fnsku) || n.asin === item.asin; })) {
                    needDetails.push({ asin: item.asin, fnsku: item.fnsku });
                }
            } else if (item.type === 'XOO') {
                if (!needDetails.find(function(n) { return (item.fnsku && n.fnsku === item.fnsku) || n.asin === item.asin; })) {
                    needDetails.push({ asin: item.asin, fnsku: item.fnsku });
                }
            }
        });

        saveSession(session);
        savePending(pending.filter(function(p) { return p !== toteId; }));

        if (needDetails.length > 0) {
            saveWeightQueue(needDetails);
            const targetSearch = needDetails[0].fnsku || needDetails[0].asin;
            const currentFC = GM_getValue('dt_current_fc', 'FCO1');
            setTimeout(function() {
                window.location.href = 'https://fcresearch-eu.aka.amazon.com/' + currentFC + '/results?s=' + targetSearch;
            }, 1000);
        } else {
            showToast('Dati inventario completi! Chiusura...');
            setTimeout(function() { window.close(); }, 1500);
        }
    }

    function processWeightPage(searchId, weightQueue) {
        const weight = parseProductWeight();
        let description = parseProductDescription();
        if (!description || description.trim().length === 0) description = 'Item ' + searchId;
        description = cleanAndTruncate(description);
        const db = loadDB();
        const item = weightQueue.find(function(q) { return q.fnsku === searchId || q.asin === searchId; });
        const session = loadSession();

        if (weight !== null) {
            if (item && item.fnsku) db[item.fnsku] = weight;
            if (item && item.asin) db[item.asin] = weight;
            db[searchId] = weight;
            saveDB(db);
        }

        const isApparel = isApparelOrShoes(description);

        session.forEach(function(s) {
            if (s.fnsku === searchId || s.asin === searchId || (item && item.fnsku && s.fnsku === item.fnsku) || (item && item.asin && s.asin === item.asin)) {
                s.description = description;
                if (isApparel) {
                    s.type = 'BOO';
                }
            }
        });
        saveSession(session);

        const newQueue = weightQueue.filter(function(q) { return q.fnsku !== searchId && q.asin !== searchId; });
        saveWeightQueue(newQueue);
        if (newQueue.length > 0) {
            const nextTarget = newQueue[0].fnsku || newQueue[0].asin;
            const currentFC = GM_getValue('dt_current_fc', 'FCO1');
            setTimeout(function() {
                window.location.href = 'https://fcresearch-eu.aka.amazon.com/' + currentFC + '/results?s=' + nextTarget;
            }, 1000);
        } else {
            showToast('Tutti i dettagli salvati con successo!');
            setTimeout(function() { window.close(); }, 1200);
        }
    }

    // PARSER CRONOLOGIA INVENTARIO CON FILTRO RIGIDO A 3 CONDIZIONI + SOMMATORIA
    function parseInventoryPage(toteId) {
        const itemMap = {};
        const cleanToteId = (toteId || '').trim().toLowerCase();

        document.querySelectorAll('tbody tr').forEach(function(row) {
            const cells = Array.from(row.querySelectorAll('td'));
            if (cells.length === 0) return;

            const cellTexts = cells.map(function(c) { return c.textContent.trim(); });

            const removalsIdx = cellTexts.findIndex(function(txt) { return /^removals$/i.test(txt); });
            const hasRemovals = removalsIdx !== -1;
            const hasMatchingOldBin = cellTexts.some(function(txt) { return txt.toLowerCase() === cleanToteId; });
            const hasSpRNewBin = cellTexts.some(function(txt) { return /^spR/i.test(txt); });

            if (!hasRemovals || !hasMatchingOldBin || !hasSpRNewBin) return;

            let asin = '', fnsku = '';

            row.querySelectorAll('a').forEach(function(a) {
                const txt = a.textContent.trim();
                if (txt.toUpperCase().startsWith('X0') && !fnsku) fnsku = txt;
                else if (txt.toUpperCase().startsWith('B0')) {
                    if (!asin) asin = txt;
                    else if (!fnsku) fnsku = txt;
                }
            });

            if (!asin && !fnsku) {
                cellTexts.forEach(function(txt) {
                    if (/^B0[A-Z0-9]{8}$/i.test(txt)) {
                        if (!asin) asin = txt;
                        else if (!fnsku) fnsku = txt;
                    } else if (/^X0[A-Z0-9]{8}$/i.test(txt)) {
                        fnsku = txt;
                    }
                });
            }

            if (!fnsku && asin) fnsku = asin;
            if (!asin && fnsku) asin = fnsku;

            if (!asin && !fnsku) return;

            let qty = 1;
            if (removalsIdx > 0 && /^\d+$/.test(cellTexts[removalsIdx - 1])) {
                qty = parseInt(cellTexts[removalsIdx - 1], 10);
            } else {
                cellTexts.forEach(function(txt) {
                    if (/^\d+$/.test(txt)) {
                        const n = parseInt(txt, 10);
                        if (n > 0 && n < 500) qty = n;
                    }
                });
            }

            const type = classify(fnsku, asin);

            const existingKey = Object.keys(itemMap).find(function(k) {
                const it = itemMap[k];
                return (fnsku && it.fnsku === fnsku) || (asin && it.asin === asin);
            });

            if (existingKey) {
                itemMap[existingKey].qty += qty;
                if (!itemMap[existingKey].fnsku && fnsku) itemMap[existingKey].fnsku = fnsku;
                if (!itemMap[existingKey].asin && asin) itemMap[existingKey].asin = asin;
            } else {
                const primaryKey = fnsku || asin;
                itemMap[primaryKey] = {
                    asin: asin,
                    fnsku: fnsku,
                    qty: qty,
                    type: type,
                    toteId: toteId,
                    description: '',
                    isFood: 'N',
                    expiryDate: '-'
                };
            }
        });

        return Object.values(itemMap);
    }

    function parseProductDescription() {
        const rows = document.querySelectorAll('tr');
        for (const row of rows) {
            const cells = row.querySelectorAll('td, th');
            if (cells.length >= 2) {
                const label = cells[0].textContent.trim().toLowerCase();
                if (label.includes('title') || label.includes('titolo') || label.includes('product name') || label === 'name' || label.includes('item name')) {
                    const val = cells[1].textContent.trim();
                    if (val.length > 2) return val;
                }
            }
        }
        return '';
    }

    function parseProductWeight() {
        const tds = document.querySelectorAll('td, th');
        for (var i = 0; i < tds.length; i++) {
            const label = tds[i].textContent.trim().toLowerCase();
            if (label === 'weight' || label === 'peso') {
                const valueCell = tds[i + 1];
                if (valueCell) {
                    const match = valueCell.textContent.match(/(\d+(?:[.,]\d+)?)/);
                    if (match) return parseFloat(match[1].replace(',', '.'));
                }
            }
        }
        return null;
    }

    // ==========================================
    // UI PANEL & CAROUSEL (PNP SIDE)
    // ==========================================
    function createPanel() {
        if (document.getElementById('donate-tracker-panel')) return;
        const panel = document.createElement('div');
        panel.id = 'donate-tracker-panel';
        panel.innerHTML =
            '<div id="dt-fcr-alert">⚠️ ATTENZIONE: FC RESEARCH SCOLLEGATO O OFF! NON SVUOTARE IL TOTE COL TOOL 373!</div>' +
            '<div id="dt-weight-alert" style="display:none; background:#ff2e44; color:#fff; font-weight:bold; padding:8px; text-align:center; border-radius:4px; margin-bottom:4px; font-size:12px; animation:dt-blink 1s infinite;">' +
                '🛑 ATTENZIONE SICUREZZA: LIMITE PESO RAGGIUNTO (≥ 250 KG)! CHIUDERE LO SHUTTLE E PASSARE AL LOTTO SUCCESSIVO!' +
            '</div>' +
            '<div id="dt-header">' +
                '<span id="dt-title">DONATE TRACKER - PANNELLO DI CONTROLLO</span>' +
                '<div id="dt-header-stats">' +
                    '<div id="dt-status-indicator" style="margin-right:10px;"></div>' +
                    '<div class="dt-stat-box"><span class="dt-stat-label">FC</span><input id="dt-fc-input" type="text" style="width:50px; background:none; border:1px solid #555; color:#fff; text-align:center; font-weight:bold;" value="' + getAutoFC() + '"/></div>' +
                    '<div class="dt-stat-box"><span class="dt-stat-label">OPERATOR</span><input id="dt-operator-input" type="text" style="width:80px; background:none; border:1px solid #555; color:#fff; text-align:center;" value="' + getOperator() + '"/></div>' +
                    '<div class="dt-stat-box"><span class="dt-stat-label">Peso Totale Shuttle</span><span id="dt-total-weight" class="dt-stat-value green">0.00 kg</span></div>' +
                '</div>' +
                '<button id="dt-minimize">-</button>' +
            '</div>' +
            '<div id="dt-body">' +
                '<div id="dt-tote-scan-box" style="background: #1a1a2e; border: 1px solid #0f3460; padding: 8px 10px; margin-bottom: 8px; border-radius: 6px; display: flex; gap: 10px; align-items: center;">' +
                    '<span style="color: #00ff88; font-weight: bold; font-size: 11px; white-space: nowrap;">📦 SCANSIONE TOTE:</span>' +
                    '<input id="dt-tote-input" type="text" placeholder="Scansiona / Inserisci ID Tote (es. tsX18kv6fjj / SP...)..." style="background: #16213e; border: 1px solid #00ff88; color: #fff; padding: 4px 8px; border-radius: 4px; flex: 1; font-family: monospace; font-size: 12px;"/>' +
                    '<button id="dt-tote-btn" class="dt-btn green" style="padding: 4px 12px; margin: 0;">APRI TOTE</button>' +
                '</div>' +
                '<div id="dt-found-barcode-box" style="background: #1a1a2e; border: 1px solid #0f3460; padding: 8px 10px; margin-bottom: 10px; border-radius: 6px; display: flex; gap: 10px; align-items: center;">' +
                    '<span style="color: #00d4ff; font-weight: bold; font-size: 11px; white-space: nowrap;">🔍 ARTICOLO TROVATO FUORI TOTE:</span>' +
                    '<input id="dt-found-input" type="text" placeholder="Scansiona fnSKU / ASIN..." style="background: #16213e; border: 1px solid #00d4ff; color: #fff; padding: 4px 8px; border-radius: 4px; flex: 1; font-family: monospace; font-size: 12px;"/>' +
                    '<button id="dt-found-btn" class="dt-btn green" style="padding: 4px 12px; margin: 0;">AGGIUNGI</button>' +
                '</div>' +
                '<div id="dt-carousel-box">' +
                    '<div style="flex: 1;">' +
                        '<h4 style="margin:0 0 4px 0; color:#00d4ff; font-size:12px;">🖼️ Verifica Visiva Articoli Donabili (Manuale)</h4>' +
                        '<p id="dt-carousel-info" style="margin:0; font-size:11px; color:#ccc;">Caricamento sessione...</p>' +
                        '<div style="margin-top: 6px; display: flex; gap: 6px;">' +
                            '<button id="dt-prev-img" class="dt-btn purple" style="padding:4px 10px; font-size:11px;">◀ Prec</button>' +
                            '<button id="dt-next-img" class="dt-btn purple" style="padding:4px 10px; font-size:11px;">Succ ▶</button>' +
                            '<span style="font-size:10px; color:#ffd700; align-self:center; margin-left:10px;">💡 Premi [SPAZIO] o le frecce direzionali ◀ / ▶ per scorrere</span>' +
                        '</div>' +
                    '</div>' +
                    '<div id="dt-carousel-img-container">' +
                        '<img id="dt-carousel-img" src="" />' +
                        '<span id="dt-carousel-noimg">No Img</span>' +
                    '</div>' +
                '</div>' +
                '<div id="dt-controls">' +
                    '<button id="dt-reset-btn" class="dt-btn red">RESET SESSION</button>' +
                    '<button id="dt-clear-x00-btn" class="dt-btn red" style="background:#d63031;">❌ DELETE ALL X00</button>' +
                    '<button id="dt-export-btn" class="dt-btn green">EXPORT EXCEL</button>' +
                    '<button id="dt-copy-btn" class="dt-btn purple">COPY REPORT text</button>' +
                    '<button id="dt-backup-btn" class="dt-btn orange" style="background:#006266;">📋 COPY BACKUP JSON</button>' +
                    '<button id="dt-import-btn" class="dt-btn orange" style="background:#1289A7;">📥 IMPORT SESSION</button>' +
                '</div>' +
                '<table id="dt-table">' +
                    '<thead>' +
                        '<tr>' +
                            '<th>TOTE</th>' +
                            '<th>FOOD?</th>' +
                            '<th>SCADENZA</th>' +
                            '<th>fnSKU</th>' +
                            '<th style="width:45px; text-align:center;">SWITCH</th>' +
                            '<th>ASIN</th>' +
                            '<th>SHORT DESCRIPTION</th>' +
                            '<th>STATUS</th>' +
                            '<th>UNIT WEIGHT (kg)</th>' +
                            '<th>QTY</th>' +
                            '<th>PESO TOTALE</th>' +
                            '<th>DB</th>' +
                            '<th style="width:40px; text-align:center;">AZIONI</th>' +
                        '</tr>' +
                    '</thead>' +
                    '<tbody id="dt-table-body">' +
                        '<tr><td colspan="13" style="text-align:center;color:#888;padding:20px;">Waiting for tote scan...</td></tr>' +
                    '</tbody>' +
                '</table>' +
                '<div id="dt-footer-stats">' +
                    '<div class="dt-foot-box"><span class="dt-foot-label">Donatable B0</span><span id="dt-count-boo" class="dt-foot-value green">0</span></div>' +
                    '<div class="dt-foot-box"><span class="dt-foot-label">Remove X0</span><span id="dt-count-xoo" class="dt-foot-value red">0</span></div>' +
                    '<div class="dt-foot-box highlight"><span class="dt-foot-label">Pending details</span><span id="dt-count-pending" class="dt-foot-value yellow">0</span></div>' +
                    '<div class="dt-foot-box highlight"><span class="dt-foot-label">Peso Totale Shuttle</span><span id="dt-foot-total" class="dt-foot-value green">0.00 kg</span></div>' +
                '</div>' +
            '</div>';
        document.body.appendChild(panel);
        injectStyles();
        bindEvents(panel);
        renderSession();
        updateCarousel();
    }

    function updateCarousel() {
        const session = loadSession().filter(function(i) { return i.type === 'BOO'; });
        const imgEl = document.getElementById('dt-carousel-img');
        const noImgEl = document.getElementById('dt-carousel-noimg');
        const infoEl = document.getElementById('dt-carousel-info');
        if (!imgEl || !infoEl || !noImgEl) return;
        if (session.length === 0) {
            imgEl.style.display = 'none';
            noImgEl.style.display = 'block';
            infoEl.textContent = 'Nessun articolo BOO valido inserito in sessione per il controllo visivo.';
            return;
        }

        if (carouselIndex >= session.length) carouselIndex = 0;
        if (carouselIndex < 0) carouselIndex = session.length - 1;

        const item = session[carouselIndex];
        const displayKey = item.fnsku || item.asin;
        infoEl.innerHTML = '<strong>[' + (carouselIndex + 1) + '/' + session.length + '] Tote:</strong> ' + item.toteId + ' | <strong>ID:</strong> ' + displayKey + '<br><span style="color:#ffd700; font-size:12px;">' + escapeHtml(item.description || 'Estrazione descrizione in corso...') + '</span>';
        if (item.asin) {
            imgEl.src = 'https://images-na.ssl-images-amazon.com/images/P/' + item.asin + '.01.LZZZZZZZ.jpg';
            imgEl.style.display = 'block';
            noImgEl.style.display = 'none';
        } else {
            imgEl.style.display = 'none';
            noImgEl.style.display = 'block';
        }

        document.querySelectorAll('#dt-table-body tr').forEach(function(tr) {
            tr.style.outline = 'none';
            const rowKey = tr.dataset.fnsku || tr.dataset.asin;
            if (rowKey === displayKey && tr.dataset.tote === item.toteId) {
                tr.style.outline = '2px solid #00d4ff';
                tr.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
            }
        });
    }

    function setupGlobalKeybinds() {
        window.addEventListener('keydown', function(e) {
            const body = document.getElementById('dt-body');
            if (!body || body.style.display === 'none') return;
            if (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA') return;

            if (e.key === ' ' || e.key === 'Spacebar') {
                e.preventDefault();
                carouselIndex++;
                updateCarousel();
            } else if (e.key === 'ArrowRight') {
                carouselIndex++;
                updateCarousel();
            } else if (e.key === 'ArrowLeft') {
                carouselIndex--;
                updateCarousel();
            }
        });
    }

    function renderSession() {
        const session = loadSession();
        const db      = loadDB();
        const tbody   = document.getElementById('dt-table-body');
        if (!tbody) return;

        if (document.activeElement && tbody.contains(document.activeElement)) {
            return;
        }

        const filtered = session.filter(function(i) { return i.type === 'BOO' || i.type === 'XOO'; });
        if (filtered.length === 0) {
            tbody.innerHTML = '<tr><td colspan="13" style="text-align:center;color:#888;padding:20px;">Waiting for tote scan...</td></tr>';
            updateStats(session);
            return;
        }

        const currentHTMLStrings = [];
        filtered.forEach(function(item) {
            if (item.type === 'XOO' && isApparelOrShoes(item.description)) {
                item.type = 'BOO';
            }

            const savedWeight = db[item.fnsku] || db[item.asin] || null;
            const totalWeight = savedWeight !== null ? (savedWeight * item.qty).toFixed(2) : null;
            const isNew       = savedWeight === null;
            const sessionIdx  = session.indexOf(item);
            const shortDescription = item.description || '';

            let descriptionCell = '';
            if (item.toteId === 'FOUND' && (!shortDescription || shortDescription.includes('Extracting'))) {
                descriptionCell = '<input class="dt-manual-desc-input" type="text" placeholder="Nome/Descrizione art..." value="' + escapeHtml(shortDescription) + '" data-idx="' + sessionIdx + '" style="width:130px; background:#1a1a2e; color:#fff; border:1px solid #777; font-size:11px; padding:2px; border-radius:3px;"/>';
            } else {
                descriptionCell = shortDescription
                    ? '<span class="dt-desc" title="' + escapeHtml(shortDescription) + '">' + escapeHtml(shortDescription) + '</span>'
                    : '<span style="color:#ffd700; font-style:italic;">Extracting...</span>';
            }

            const badgeHTML = item.type === 'BOO'
                ? '<span class="dt-badge-boo">DONATE</span>'
                : '<span class="dt-badge-xoo">REMOVE</span>';

            let weightCell = '';
            if (item.type === 'BOO' || item.toteId === 'FOUND') {
                weightCell = '<input class="dt-weight-input ' + (isNew ? '' : 'dt-weight-saved') + '" type="number" step="0.01" min="0" value="' + (savedWeight !== null ? savedWeight : '') + '" placeholder="0.00" data-idx="' + sessionIdx + '" />';
            } else {
                weightCell = '<span style="color:#555">-</span>';
            }

            let totalCell = '';
            if (item.type === 'BOO' || item.toteId === 'FOUND') {
                totalCell = totalWeight !== null ? '<span style="color:#00ff88">' + totalWeight + ' kg</span>' : '<span style="color:#ffd700">...</span>';
            } else {
                totalCell = '<span style="color:#555">-</span>';
            }

            const dbCell = item.type === 'BOO'
                ? (isNew ? '<span class="dt-db-new">NEW</span>' : '<span class="dt-db-auto">AUTO</span>')
                : '<span style="color:#555">-</span>';

            const switchCell = item.type === 'XOO'
                ? '<td style="text-align:center; padding: 2px 4px;"><button class="dt-row-switch-btn" data-idx="' + sessionIdx + '" title="Forza mutazione X00 -> B00">🔄</button></td>'
                : '<td style="text-align:center; color:#444; font-size:11px;">⇄</td>';
            const actionCell = '<td style="text-align:center;"><button class="dt-row-del-btn" data-idx="' + sessionIdx + '">❌</button></td>';

            const foodColor = item.isFood === 'Y' ? '#ff4757' : '#2ed573';
            const foodCell = '<td style="text-align:center;"><button class="dt-food-toggle-btn" data-idx="' + sessionIdx + '" style="background:' + foodColor + '; color:white; border:none; padding:2px 6px; border-radius:4px; font-weight:bold; cursor:pointer;">' + item.isFood + '</button></td>';
            const expiryCell = '<td style="text-align:center;"><input class="dt-expiry-input" type="text" placeholder="GG/MM/AAAA" style="width:85px; background:#16213e; border:1px solid #555; color:#fff; text-align:center; font-size:11px; border-radius:4px;" value="' + (item.expiryDate || '-') + '" data-idx="' + sessionIdx + '" ' + (item.isFood === 'N' ? 'disabled' : '') + '/></td>';

            const trHTML = '<tr class="' + (item.type === 'BOO' ? 'dt-boo' : 'dt-xoo') + '" data-fnsku="' + (item.fnsku || '') + '" data-asin="' + (item.asin || '') + '" data-tote="' + item.toteId + '">' +
                '<td style="font-family:monospace;font-size:10px;color:#aaa">' + (item.toteId || '-') + '</td>' +
                foodCell +
                expiryCell +
                '<td style="font-family:monospace;font-size:11px;font-weight:bold;color:#00d4ff;">' + (item.fnsku || '-') + '</td>' +
                switchCell +
                '<td style="font-family:monospace;font-size:11px;color:#888;">' + (item.asin  || '-') + '</td>' +
                '<td>' + descriptionCell + '</td>' +
                '<td>' + badgeHTML + '</td>' +
                '<td>' + weightCell + '</td>' +
                '<td style="text-align:center;font-weight:bold;">' + item.qty + '</td>' +
                '<td>' + totalCell + '</td>' +
                '<td>' + dbCell + '</td>' +
                actionCell +
                '</tr>';
            currentHTMLStrings.push(trHTML);
        });

        tbody.innerHTML = currentHTMLStrings.join('');

        tbody.querySelectorAll('.dt-weight-input').forEach(function(input) {
            input.addEventListener('change', function () {
                const idx = parseInt(this.dataset.idx);
                const val = parseFloat(this.value);
                if (isNaN(val) || val <= 0) return;
                const db = loadDB();
                const currentS = loadSession();
                const item = currentS[idx];
                if(item) {
                    if (item.fnsku) db[item.fnsku] = val;
                    if (item.asin) db[item.asin] = val;
                    saveDB(db);
                    renderSession();
                }
            });
        });

        tbody.querySelectorAll('.dt-manual-desc-input').forEach(function(input) {
            input.addEventListener('change', function() {
                const idx = parseInt(this.dataset.idx);
                const currentSession = loadSession();
                if (currentSession[idx]) {
                    currentSession[idx].description = this.value.trim();
                    saveSession(currentSession);
                }
            });
        });

        tbody.querySelectorAll('.dt-food-toggle-btn').forEach(function(btn) {
            btn.addEventListener('click', function() {
                const idx = parseInt(this.dataset.idx);
                const currentSession = loadSession();
                if (currentSession[idx]) {
                    if (currentSession[idx].isFood === 'N') {
                        currentSession[idx].isFood = 'Y';
                        if (!currentSession[idx].expiryDate || currentSession[idx].expiryDate === '-') {
                            currentSession[idx].expiryDate = '';
                        }
                        saveSession(currentSession);
                        renderSession();

                        setTimeout(function() {
                            const targetInput = document.querySelector('.dt-expiry-input[data-idx="' + idx + '"]');
                            if (targetInput) {
                                targetInput.removeAttribute('disabled');
                                targetInput.focus();
                                targetInput.select();
                            }
                        }, 50);
                    } else {
                        currentSession[idx].isFood = 'N';
                        currentSession[idx].expiryDate = '-';
                        saveSession(currentSession);
                        renderSession();
                    }
                }
            });
        });

        tbody.querySelectorAll('.dt-expiry-input').forEach(function(input) {
            const updateExpiry = function() {
                const idx = parseInt(this.dataset.idx);
                const currentSession = loadSession();
                if (currentSession[idx]) {
                    currentSession[idx].expiryDate = this.value.trim();
                    saveSession(currentSession);
                }
            };
            input.addEventListener('input', updateExpiry);
            input.addEventListener('change', updateExpiry);
        });

        tbody.querySelectorAll('.dt-row-switch-btn').forEach(function(btn) {
            btn.addEventListener('click', function() {
                const idx = parseInt(this.dataset.idx);
                const currentSession = loadSession();
                const item = currentSession[idx];
                if (item && item.type === 'XOO') {
                    item.type = 'BOO';
                    const db = loadDB();
                    const hasWeight = db[item.fnsku] || db[item.asin];
                    if (!hasWeight) {
                        const pendingW = loadWeightQueue();
                        if (!pendingW.find(function(q){ return q.fnsku === item.fnsku || q.asin === item.asin; })) {
                            pendingW.push({ asin: item.asin, fnsku: item.fnsku });
                            saveWeightQueue(pendingW);
                        }
                        const currentFC = GM_getValue('dt_current_fc', 'FCO1');
                        window.open('https://fcresearch-eu.aka.amazon.com/' + currentFC + '/results?s=' + (item.fnsku || item.asin), '_blank');
                    }
                    saveSession(currentSession);
                    renderSession();
                    updateCarousel();
                    showToast('Articolo convertito in DONATE! Peso sbloccato.');
                }
            });
        });

        tbody.querySelectorAll('.dt-row-del-btn').forEach(function(btn) {
            btn.addEventListener('click', function() {
                const idx = parseInt(this.dataset.idx);
                const currentSession = loadSession();
                const itemToDelete = currentSession[idx];
                if (itemToDelete) {
                    if (confirm("Rimuovere l'articolo " + (itemToDelete.fnsku || itemToDelete.asin) + " dalla sessione corrente?")) {
                        currentSession.splice(idx, 1);
                        saveSession(currentSession);
                        renderSession();
                        updateCarousel();
                        showToast('Articolo eliminato.');
                    }
                }
            });
        });

        updateStats(session);
    }

    function updateStats(session) {
        const db = loadDB();
        var totalWeight = 0, countBOO = 0, countXOO = 0, countPending = 0;
        session.forEach(function(item) {
            if (item.type === 'BOO' || item.toteId === 'FOUND') {
                if(item.type === 'BOO') countBOO++; else countXOO++;
                const w = db[item.fnsku] || db[item.asin] || null;
                if (w !== null) totalWeight += w * item.qty;
                if (w === null || !item.description) countPending++;
            } else if (item.type === 'XOO') {
                countXOO++;
                if (!item.description) countPending++;
            }
        });
        const tw = totalWeight.toFixed(2) + ' kg';
        function el(id) { return document.getElementById(id); }

        const totalWeightEl = el('dt-total-weight');
        const footTotalEl  = el('dt-foot-total');
        const weightAlertEl = el('dt-weight-alert');

        if (totalWeightEl) totalWeightEl.textContent = tw;
        if (footTotalEl)  footTotalEl.textContent  = tw;
        if (el('dt-count-boo')) el('dt-count-boo').textContent = countBOO;
        if (el('dt-count-xoo')) el('dt-count-xoo').textContent = countXOO;
        if (el('dt-count-pending')) el('dt-count-pending').textContent = countPending;

        if (totalWeight >= MAX_SHUTTLE_WEIGHT) {
            if (totalWeightEl) { totalWeightEl.style.color = '#ff2e44'; totalWeightEl.style.fontWeight = 'bold'; }
            if (footTotalEl)  { footTotalEl.style.color  = '#ff2e44'; footTotalEl.style.fontWeight = 'bold'; }
            if (weightAlertEl) weightAlertEl.style.display = 'block';

            if (!weightAlertTriggered) {
                weightAlertTriggered = true;
                alert('🛑 ATTENZIONE SICUREZZA!\n\nIl peso totale dello Shuttle ha raggiunto ' + totalWeight.toFixed(2) + ' kg (Soglia max: 250 kg).\n\nPer favore CHIUDI LO SHUTTLE e passa al LOTTO SUCCESSIVO!');
            }
        } else {
            if (totalWeightEl) { totalWeightEl.style.color = '#00ff88'; }
            if (footTotalEl)  { footTotalEl.style.color  = '#00ff88'; }
            if (weightAlertEl) weightAlertEl.style.display = 'none';
            weightAlertTriggered = false;
        }
    }

    function handleManualToteScan() {
        const inputEl = document.getElementById('dt-tote-input');
        if (!inputEl) return;
        const toteId = inputEl.value.trim();
        if (!toteId) return;
        inputEl.value = '';
        handleToteDetected(toteId);
    }

    function handleFoundBarcode() {
        const inputEl = document.getElementById('dt-found-input');
        if (!inputEl) return;
        const barcode = inputEl.value.trim().toUpperCase();
        if (!barcode) return;

        let session = loadSession();
        const articoloEsistente = session.find(function(item) {
            return (item.fnsku && item.fnsku === barcode) || (item.asin && item.asin === barcode);
        });

        if (articoloEsistente) {
            articoloEsistente.qty += 1;
            saveSession(session);
            inputEl.value = '';
            showToast('Articolo già presente. Quantità incrementata a: ' + articoloEsistente.qty);
            renderSession();
            return;
        }

        const isAsin = barcode.startsWith('B0');
        const type = barcode.startsWith('X0') ? 'XOO' : 'BOO';
        const newItem = {
            asin: isAsin ? barcode : '',
            fnsku: !isAsin ? barcode : '',
            qty: 1,
            type: type,
            toteId: 'FOUND',
            description: '',
            isFood: 'N',
            expiryDate: '-'
        };

        session.push(newItem);
        saveSession(session);
        inputEl.value = '';

        const weightQueue = loadWeightQueue();
        if (!weightQueue.find(function(q) { return q.fnsku === barcode || q.asin === barcode; })) {
            weightQueue.push({ asin: newItem.asin, fnsku: newItem.fnsku });
            saveWeightQueue(weightQueue);
        }

        const currentFC = GM_getValue('dt_current_fc', 'FCO1');
        showToast('Articolo trovato inserito. Ricerca caratteristiche su FCR...');
        window.open('https://fcresearch-eu.aka.amazon.com/' + currentFC + '/results?s=' + barcode, '_blank');
        renderSession();
    }

    // EXPORT GENERATION CON METADATI (DATA E OPERATORE) E RIGA TOTALE SHUTTLE
    function generateXLSX(lot, session, db) {
        const fnskuMap = {};
        session.filter(function(i) { return i.type === 'BOO' || i.toteId === 'FOUND'; }).forEach(function(item) {
            const key = item.fnsku || item.asin;
            const toteString = item.toteId;
            if (fnskuMap[key]) {
                if (!fnskuMap[key].totes.includes(toteString)) {
                    fnskuMap[key].totes.push(toteString);
                }
                fnskuMap[key].qty += item.qty;
                if (!fnskuMap[key].description && item.description) {
                    fnskuMap[key].description = item.description;
                }
            } else {
                fnskuMap[key] = {
                    asin: item.asin,
                    fnsku: item.fnsku,
                    qty: item.qty,
                    weight: db[item.fnsku] || db[item.asin] || null,
                    totes: [toteString],
                    description: item.description || '',
                    isFood: item.isFood,
                    expiryDate: item.expiryDate
                };
            }
        });
        const rows = Object.values(fnskuMap);

        function td(content, bold, align, underline) {
            if (!bold) bold = false;
            if (!align) align = 'left';
            if (!underline) underline = false;
            return '<td style="background:#ffffff; padding:4px 8px; border:1px solid #d9d9d9; font-size:11px; font-family:Calibri,Arial,sans-serif; text-align:' + align + ';' + (bold ? 'font-weight:bold;' : '') + (underline ? 'text-decoration:underline; color:#000000;' : 'color:#000000;') + '">' + content + '</td>';
        }

        function th(content, align) {
            if (!align) align = 'left';
            return '<th style="background:#244062; color:#ffffff; font-weight:bold; font-size:11px; font-family:Calibri,Arial,sans-serif; padding:6px 8px; text-align:' + align + '; border:1px solid #244062;">' + content + '</th>';
        }

        var tableRows = '';
        var grandTotalWeight = 0;
        var grandTotalQty = 0;

        rows.forEach(function(row, idx) {
            const unitW = row.weight !== null ? row.weight : '';
            const itemTotalW = row.weight !== null ? (row.weight * row.qty) : 0;
            if (row.weight !== null) grandTotalWeight += itemTotalW;
            grandTotalQty += row.qty;

            const totalWStr = row.weight !== null ? itemTotalW.toFixed(2) : '';
            tableRows += '<tr>' +
                td(idx + 1, true, 'center') +
                td(row.isFood, false, 'center') +
                td(row.expiryDate !== '-' ? row.expiryDate : '', false, 'center') +
                td(escapeHtml(row.fnsku || ''), false, 'left') +
                td(escapeHtml(row.asin || ''), false, 'left', true) +
                td(escapeHtml(row.description || ''), false, 'left') +
                td(escapeHtml(row.totes.join(', ')), false, 'left') +
                td(row.qty, false, 'center') +
                td(unitW, false, 'right') +
                td(totalWStr, false, 'right') +
                '</tr>';
        });

        // Riga Totale Finale Shuttle
        tableRows += '<tr>' +
            '<td colspan="7" style="background:#d9d9d9; font-weight:bold; text-align:right; border:1px solid #bfbfbf; padding:6px; font-size:11px; font-family:Calibri,Arial,sans-serif;">PESO TOTALE SHUTTLE:</td>' +
            '<td style="background:#d9d9d9; font-weight:bold; text-align:center; border:1px solid #bfbfbf; padding:6px; font-size:11px; font-family:Calibri,Arial,sans-serif;">' + grandTotalQty + '</td>' +
            '<td style="background:#d9d9d9; border:1px solid #bfbfbf;"></td>' +
            '<td style="background:#244062; color:#ffffff; font-weight:bold; text-align:right; border:1px solid #244062; padding:6px; font-size:11px; font-family:Calibri,Arial,sans-serif;">' + grandTotalWeight.toFixed(2) + ' kg</td>' +
            '</tr>';

        const currentDate = new Date().toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric' });
        const operatorName = getOperator();

        const html = '<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40">' +
            '<head><meta charset="UTF-8"><style>body{font-family:Calibri,Arial,sans-serif;}table{border-collapse:collapse;}</style></head>' +
            '<body>' +
            '<table>' +
            '<tr><td colspan="10" style="background:#244062; color:#ffffff; font-size:12px; font-weight:bold; padding:6px; text-align:center; border:1px solid #244062;">DONATE TRACKER - LOT ' + lot + '</td></tr>' +
            '<tr>' +
            '<td style="background:#f2f2f2; font-weight:bold; text-align:right; border:1px solid #bfbfbf; font-size:11px;">Data:</td>' +
            '<td style="background:#f2f2f2; text-align:left; border:1px solid #bfbfbf; font-size:11px;">' + currentDate + '</td>' +
            '<td colspan="2" style="background:#f2f2f2; border:1px solid #bfbfbf;"></td>' +
            '<td style="background:#f2f2f2; font-weight:bold; text-align:right; border:1px solid #bfbfbf; font-size:11px;">Operatore:</td>' +
            '<td colspan="5" style="background:#f2f2f2; text-align:left; border:1px solid #bfbfbf; font-size:11px;">' + escapeHtml(operatorName) + '</td>' +
            '</tr>' +
            '<tr>' +
            th('#', 'center') +
            th('Food?', 'center') +
            th('Scadenza', 'center') +
            th('fnSKU', 'left') +
            th('ASIN', 'left') +
            th('Short Description', 'left') +
            th('Tote(s)', 'left') +
            th('Qty', 'center') +
            th('Unit Weight (kg)', 'right') +
            th('Total Weight (kg)', 'right') +
            '</tr>' + tableRows + '</table></body></html>';

        const blob = new Blob([html], { type: 'application/vnd.ms-excel' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'Donate_Tracker_Lot_' + lot + '_' + new Date().toISOString().slice(0,10) + '.xls';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    }

    function bindEvents(panel) {
        panel.querySelector('#dt-minimize').addEventListener('click', function() {
            const body = panel.querySelector('#dt-body');
            if(body.style.display === 'none') {
                body.style.display = 'block';
                this.textContent = '-';
            } else {
                body.style.display = 'none';
                this.textContent = '+';
            }
        });

        panel.querySelector('#dt-fc-input').addEventListener('change', function() {
            GM_setValue('dt_current_fc', this.value.trim().toUpperCase());
            showToast('FC Aggiornata con successo.');
        });

        panel.querySelector('#dt-operator-input').addEventListener('change', function() {
            GM_setValue('dt_current_operator', this.value.trim());
            showToast('Operatore salvato.');
        });

        panel.querySelector('#dt-tote-btn').addEventListener('click', handleManualToteScan);
        panel.querySelector('#dt-tote-input').addEventListener('keydown', function(e) {
            if(e.key === 'Enter') handleManualToteScan();
        });

        panel.querySelector('#dt-found-btn').addEventListener('click', handleFoundBarcode);
        panel.querySelector('#dt-found-input').addEventListener('keydown', function(e) {
            if(e.key === 'Enter') handleFoundBarcode();
        });

        panel.querySelector('#dt-prev-img').addEventListener('click', function() { carouselIndex--; updateCarousel(); });
        panel.querySelector('#dt-next-img').addEventListener('click', function() { carouselIndex++; updateCarousel(); });

        panel.querySelector('#dt-reset-btn').addEventListener('click', function() {
            if(confirm('Azzerare completamente la sessione corrente?')){
                saveSession([]);
                saveWeightQueue([]);
                savePending([]);
                carouselIndex = 0;
                weightAlertTriggered = false;
                renderSession();
                updateCarousel();
                showToast('Sessione resettata.');
            }
        });

        panel.querySelector('#dt-clear-x00-btn').addEventListener('click', function() {
            if(confirm('Rimuovere definitivamente tutti i record REMOVE (X00) della sessione?')){
                let s = loadSession().filter(function(i){return i.type !== 'XOO';});
                saveSession(s);
                renderSession();
                showToast('Tutti gli X00 rimossi.');
            }
        });

        panel.querySelector('#dt-export-btn').addEventListener('click', function() {
            var lot = prompt("Inserisci identificativo lotto (Lettera + Numero, es: E11):", GM_getValue('dt_last_lot', ''));
            if(lot === null) return;
            var res = validateLot(lot);
            if(!res.valid) { alert(res.msg); return; }
            GM_setValue('dt_last_lot', res.lot);
            generateXLSX(res.lot, loadSession(), loadDB());
        });

        panel.querySelector('#dt-copy-btn').addEventListener('click', function() {
            const session = loadSession().filter(function(i){return i.type==='BOO' || i.toteId==='FOUND';});
            const db = loadDB();
            let txt = "REPORT DONATE\n";
            session.forEach(function(item){
                const key = item.fnsku || item.asin;
                const w = db[key] || 0;
                txt += "Tote: " + item.toteId + " | ID: " + key + " | Qty: " + item.qty + " | Food: " + item.isFood + " | Scadenza: " + item.expiryDate + " | Peso: " + (w * item.qty).toFixed(2) + "kg\n";
            });
            navigator.clipboard.writeText(txt);
            showToast('Report copiato negli appunti!');
        });

        panel.querySelector('#dt-backup-btn').addEventListener('click', function() {
            navigator.clipboard.writeText(JSON.stringify(loadSession()));
            showToast('JSON Backup copiato!');
        });

        panel.querySelector('#dt-import-btn').addEventListener('click', function() {
            const data = prompt("Incolla qui la stringa JSON di backup:");
            if(!data) return;
            try {
                const parsed = JSON.parse(data);
                if(Array.isArray(parsed)) {
                    saveSession(parsed);
                    renderSession();
                    updateCarousel();
                    showToast('Sessione importata correttamente!');
                } else { alert('Formato non valido.'); }
            } catch(e) { alert('Errore nel parsing del JSON.'); }
        });
    }

    function injectStyles() {
        if(document.getElementById('dt-styles')) return;
        const s = document.createElement('style');
        s.id = 'dt-styles';
        s.innerHTML =
            '#donate-tracker-panel{position:fixed;bottom:10px;right:10px;width:1050px;max-height:580px;background:#1a1a2e;color:#fff;font-family:Arial,sans-serif;z-index:999999;border:2px solid #0f3460;border-radius:8px;box-shadow:0 4px 15px rgba(0,0,0,0.5);display:flex;flex-direction:column;font-size:12px;padding:6px;}' +
            '#dt-fcr-alert{background:#ff2e44;color:#fff;font-weight:bold;padding:5px;text-align:center;border-radius:4px;margin-bottom:4px;font-size:11px;display:none;animation:dt-blink 1s infinite;}' +
            '#dt-header{display:flex;justify-content:space-between;align-items:center;background:#16213e;padding:6px 10px;border-bottom:1px solid #0f3460;border-radius:6px 6px 0 0;}' +
            '#dt-title{font-weight:bold;color:#00d4ff;font-size:13px;}' +
            '#dt-header-stats{display:flex;gap:8px;align-items:center;}' +
            '.dt-stat-box{background:#1a1a2e;padding:4px 8px;border-radius:4px;border:1px solid #0f3460;display:flex;flex-direction:column;font-size:10px;}' +
            '.dt-stat-label{color:#888;text-transform:uppercase;font-size:8px;}' +
            '.dt-stat-value{font-weight:bold;font-size:12px;}' +
            '.dt-stat-value.green{color:#00ff88;}' +
            '.dt-stat-value.yellow{color:#ffd700;}' +
            '#dt-minimize{background:none;border:none;color:#fff;font-size:16px;cursor:pointer;padding:0 5px;}' +
            '#dt-body{display:block;overflow-y:auto;flex:1;padding-top:6px;}' +
            '#dt-carousel-box{display:flex;background:#16213e;border:1px solid #0f3460;border-radius:6px;padding:6px;margin-bottom:6px;gap:10px;}' +
            '#dt-carousel-img-container{width:110px;height:70px;background:#1a1a2e;border:1px solid #333;border-radius:4px;display:flex;align-items:center;justify-content:center;position:relative;overflow:hidden;}' +
            '#dt-carousel-img{max-width:100%;max-height:100%;object-fit:contain;display:none;}' +
            '#dt-carousel-noimg{font-size:10px;color:#555;font-weight:bold;}' +
            '#dt-controls{display:flex;gap:4px;margin-bottom:6px;flex-wrap:wrap;}' +
            '.dt-btn{background:#0f3460;color:#fff;border:none;padding:5px 8px;border-radius:4px;cursor:pointer;font-weight:bold;font-size:11px;transition:0.1s;}' +
            '.dt-btn:hover{filter:brightness(1.2);}' +
            '.dt-btn.red{background:#e84118;}' +
            '.dt-btn.green{background:#4cd137;color:#000;}' +
            '.dt-btn.purple{background:#8c7ae6;}' +
            '#dt-table{width:100%;border-collapse:collapse;margin-bottom:6px;background:#16213e;}' +
            '#dt-table th,#dt-table td{border:1px solid #0f3460;padding:4px 6px;text-align:left;font-size:11px;}' +
            '#dt-table th{background:#1f4068;color:#00d4ff;font-weight:bold;font-size:10px;text-transform:uppercase;}' +
            '.dt-boo{background:rgba(16,172,132,0.08);}' +
            '.dt-xoo{background:rgba(238,90,36,0.08);}' +
            '.dt-badge-boo{background:#10ac84;color:#fff;padding:1px 4px;border-radius:3px;font-size:9px;font-weight:bold;}' +
            '.dt-badge-xoo{background:#ee5a24;color:#fff;padding:1px 4px;border-radius:3px;font-size:9px;font-weight:bold;}' +
            '.dt-weight-input{width:55px;background:#1a1a2e;border:1px solid #555;color:#fff;padding:2px;border-radius:4px;text-align:center;font-size:11px;}' +
            '.dt-weight-saved{border-color:#00ff88;color:#00ff88;font-weight:bold;}' +
            '.dt-db-new{color:#ff9f43;font-weight:bold;font-size:9px;}' +
            '.dt-db-auto{color:#00ff88;font-weight:bold;font-size:9px;}' +
            '.dt-desc{display:inline-block;max-width:180px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;vertical-align:bottom;}' +
            '.dt-row-switch-btn{background:#e67e22;border:none;color:#fff;padding:3px 6px;border-radius:4px;cursor:pointer;font-size:11px;font-weight:bold;}' +
            '.dt-row-switch-btn:hover{background:#d35400;transform:scale(1.1);transition: 0.1s;}' +
            '.dt-row-del-btn{background:none;border:none;color:#ff7675;cursor:pointer;font-size:12px;padding:2px 5px;border-radius:4px;}' +
            '.dt-row-del-btn:hover{background:#78281f;color:#fff;}' +
            '#dt-footer-stats{display:flex;gap:10px;flex-wrap:wrap;margin-top:12px;}' +
            '.dt-foot-box{background:#16213e;border:1px solid #0f3460;border-radius:8px;padding:8px 12px;min-width:140px;display:flex;flex-direction:column;}' +
            '.dt-foot-box.highlight{background:#123524;border-color:#1e8449;}' +
            '.dt-foot-label{font-size:9px;color:#8fb6ff;text-transform:uppercase;}' +
            '.dt-foot-value{font-size:16px;font-weight:bold;}' +
            '.dt-foot-value.green{color:#00ff88;}' +
            '.dt-foot-value.red{color:#ff7675;}' +
            '.dt-foot-value.yellow{color:#ffd700;}' +
            '@keyframes dt-blink{0%{opacity:1;}50%{opacity:0.4;}100%{opacity:1;}}';
        document.body.appendChild(s);
    }

    function showToast(msg) {
        const t = document.createElement('div');
        t.style = 'position:fixed;top:20px;left:50%;transform:translateX(-50%);background:#00d4ff;color:#000;padding:8px 16px;border-radius:20px;font-weight:bold;z-index:9999999;box-shadow:0 4px 10px rgba(0,0,0,0.3);font-size:12px;';
        t.textContent = msg;
        document.body.appendChild(t);
        setTimeout(function() { t.remove(); }, 2500);
    }

    function escapeHtml(str) {
        if (!str) return '';
        return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
    }

    if (IS_PNP) initPNP();
    if (IS_FCR) initFCResearch();

})();