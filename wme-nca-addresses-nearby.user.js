// ==UserScript==
// @name            WME — NCA address layer
// @description     NCA address points on the map (zoom 18+): click adds residential POI, WME street link, and house number only when a suitable WME street is found; red dot + NCA street name to clipboard otherwise.
// @namespace       https://github.com/ixxvivxxi/wme-scripts
// @homepageURL     https://github.com/ixxvivxxi/waze-nca-scanner
// @updateURL       https://raw.githubusercontent.com/ixxvivxxi/waze-nca-scanner/main/wme-nca-addresses-nearby.user.js
// @downloadURL     https://raw.githubusercontent.com/ixxvivxxi/waze-nca-scanner/main/wme-nca-addresses-nearby.user.js
// @version         2026.07.30.001
// @match           https://www.waze.com/*/editor*
// @match           https://www.waze.com/editor*
// @match           https://beta.waze.com/*/editor*
// @match           https://beta.waze.com/editor*
// @exclude         https://www.waze.com/*user/*editor/*
// @grant           GM_xmlhttpRequest
// @grant           GM_setClipboard
// @inject-into     page
// @run-at          document-idle
// @connect         127.0.0.1
// @connect         localhost
// @connect         waze-nca-scanner.ster.by
// ==/UserScript==

// @connect must be hostname only (no https://). Add one line per API host.

/* global OpenLayers, GM_xmlhttpRequest, GM_setClipboard, unsafeWindow */
/* jshint esversion: 11 */

(function () {
  'use strict';

  const SCRIPT_ID = 'wme-nca-addresses-nearby';
  const SCRIPT_NAME = 'NCA addresses';
  const STORAGE_API_BASE = 'wmeNcaAddr_apiBase';
  const STORAGE_FOLLOW_MAP = 'wmeNcaAddr_followMap';
  /** When on, do not draw NCA dots that match an existing residential POI (same Hn, nearby). */
  const STORAGE_HIDE_RESIDENTIAL_OVERLAY_DUP = 'wmeNcaAddr_hideResidentialDupOverlay';
  const DEFAULT_API_BASE = 'https://waze-nca-scanner.ster.by';
  /** WME map zoom must be at least this level to request bbox addresses. */
  const MIN_ZOOM_FOR_BBOX = 18;
  /** Tight hover: nearest-address fallback only within this many px of the dot center. */
  const NCA_HOVER_NEAREST_MAX_PX = Math.round(22 * 0.9);
  /** OL6 hit-test margin around the drawn point (small = must aim at the marker). */
  const NCA_HOVER_HIT_TOLERANCE_PX = Math.round(10 * 0.9);
  /** Allow `getEventPixel` this many px outside the strict viewport rect. */
  const NCA_HOVER_VIEWPORT_PAD_PX = Math.max(1, Math.floor(2 * 0.9));
  /** If a residential POI has this house number within this distance (m), hide the NCA overlay dot (optional setting). */
  const NCA_OVERLAY_HIDE_NEAR_RESIDENTIAL_M = 22;
  /** Avoid expensive street-fit coloring for huge bbox responses (prevents UI stalls). */
  const NCA_STREET_COLOR_MAX_ADDRESSES = 420;
  /** Disable O(N) nearest-dot fallback on hover when there are too many dots. */
  const NCA_HOVER_NEAREST_SCAN_MAX_ADDRESSES = 650;
  /** Poll fallback cadence cap (ms): protects UI when moveend hooks are unreliable. */
  const NCA_VIEWPORT_POLL_MIN_INTERVAL_MS = 2200;
  /** Hard cap for rendered markers in one viewport (UI safety against map freezes). */
  const NCA_MAX_RENDERED_MARKERS = 900;
  /** Tight cap when zoom is near MIN_ZOOM_FOR_BBOX (wider bbox — fewer points to keep pan responsive). */
  const NCA_MAX_RENDERED_MARKERS_Z17 = 420;
  /** Disable hover hit-test when too many points are active on screen. */
  const NCA_DISABLE_HOVER_OVER_POINTS = 320;
  /** Quantization precision for viewport key (lower precision = fewer tiny-pan reloads). */
  const NCA_VIEWPORT_KEY_DECIMALS = 5;
  /** How many features to push to OpenLayers per animation frame. */
  const NCA_RENDER_CHUNK_SIZE = 180;

  let sdk = null;
  let statusEl = null;
  let apiInput = null;
  let followMapEl = null;
  let hideDupResidentialOverlayEl = null;
  let lastViewportKey = '';
  let mapViewportHooksRegistered = false;
  let viewportPollTimer = null;
  let viewportFetchInFlight = false;
  let viewportPollBboxInFlight = false;
  let viewportPollLastRunMs = 0;
  let layerRenderGeneration = 0;
  let addressOl2VectorLayer = null;
  let addressOl6VectorLayer = null;
  let addressOl6InteractionsInstalled = false;
  /** Cached `ol` from layer creation (WME often has no `window.ol`). */
  let cachedOl6Global = null;
  /** Reused OL6 marker styles (avoid allocating Style objects per feature render). */
  let ol6StyleBlue = null;
  let ol6StyleRed = null;
  let ncaDocumentHoverBound = false;
  let ncaDocumentClickBound = false;
  let ncaHoverLiteMode = false;
  /** Last bbox address rows (for hover when OL hit-test fails). */
  let lastOl6AddressesForHover = [];
  /** Same for OpenLayers 2 (WME production map). */
  let lastOl2AddressesForHover = [];
  let addressHoverEl = null;
  let addressHoverRaf = null;
  /** Prevents double addVenue/addHouseNumber for the same NCA row (double-click / slow SDK). */
  let ncaVenueCreateInflight = Object.create(null);

  function debounce(fn, ms) {
    let t = null;
    return function debounced() {
      const self = this;
      const args = arguments;
      if (t) clearTimeout(t);
      t = setTimeout(function () {
        t = null;
        fn.apply(self, args);
      }, ms);
    };
  }

  function maxRenderedMarkersForZoom(z) {
    const zz = Number(z);
    if (Number.isFinite(zz) && zz <= 18.2) return NCA_MAX_RENDERED_MARKERS_Z17;
    return NCA_MAX_RENDERED_MARKERS;
  }

  /** Page window (WME lives here; needed when @grant is not `none`). */
  function pageWin() {
    return typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  }

  function W() {
    return pageWin().W;
  }

  function segmentTypeLower(seg) {
    if (!seg) return '';
    const t = seg.type != null ? seg.type : seg.attributes && seg.attributes.type;
    return String(t || '').toLowerCase();
  }

  function isSegmentModel(seg) {
    if (!seg) return false;
    if (segmentTypeLower(seg) === 'segment') return true;
    if (seg.attributes && seg.attributes.roadType != null) return true;
    return false;
  }

  /** Segment model from various WME / SDK selection shapes. */
  function unwrapSegmentModel(item) {
    if (!item) return null;
    if (isSegmentModel(item)) return item;
    if (item._wmeObject && isSegmentModel(item._wmeObject)) return item._wmeObject;
    if (item.model && isSegmentModel(item.model)) return item.model;
    if (item.segment && isSegmentModel(item.segment)) return item.segment;
    return null;
  }

  /** Normalize Editing.getSelection() (may be a Promise in current WME SDK). */
  async function resolveEditingSelectionRaw(ws) {
    if (!ws || !ws.Editing || typeof ws.Editing.getSelection !== 'function') {
      return null;
    }
    try {
      const raw = ws.Editing.getSelection();
      const v = raw && typeof raw.then === 'function' ? await raw : raw;
      return v;
    } catch (e) {
      console.warn('[NCA addresses] Editing.getSelection:', e);
      return null;
    }
  }

  function selectionItemsFromResolved(raw) {
    if (raw == null) return [];
    if (Array.isArray(raw)) return raw;
    if (Array.isArray(raw.features)) return raw.features;
    if (Array.isArray(raw.selectedFeatures)) return raw.selectedFeatures;
    if (Array.isArray(raw.items)) return raw.items;
    if (Array.isArray(raw.models)) return raw.models;
    if (Array.isArray(raw.segments)) return raw.segments;
    return [];
  }

  function storageGet(key, fallback) {
    try {
      const v = sessionStorage.getItem(key);
      return v != null && String(v).trim() !== '' ? String(v).trim() : fallback;
    } catch (_) {
      return fallback;
    }
  }

  function storageSet(key, val) {
    try {
      sessionStorage.setItem(key, String(val));
    } catch (_) {}
  }

  async function getSelectedSegmentsAsync() {
    const out = [];
    const seenSegs = new WeakSet();
    function pushSeg(seg) {
      if (!isSegmentModel(seg) || seenSegs.has(seg)) return;
      seenSegs.add(seg);
      out.push(seg);
    }

    function segmentFromSdkItem(item) {
      const u = unwrapSegmentModel(item);
      if (u) return u;
      if (!item || !sdk || !sdk.DataModel || !sdk.DataModel.Segments) return null;
      const oid =
        String(item.objectType || item.type || '').toLowerCase() === 'segment';
      const sid = item.segmentId != null ? item.segmentId : item.id;
      if (oid && sid != null && typeof sdk.DataModel.Segments.getById === 'function') {
        try {
          const seg = sdk.DataModel.Segments.getById({ segmentId: sid });
          if (isSegmentModel(seg)) return seg;
        } catch (_) {}
      }
      return null;
    }

    if (sdk) {
      const raw = await resolveEditingSelectionRaw(sdk);
      const fromSdk = selectionItemsFromResolved(raw);
      for (let i = 0; i < fromSdk.length; i++) {
        const seg = segmentFromSdkItem(fromSdk[i]);
        if (seg) pushSeg(seg);
      }
      if (out.length > 0) return out;
    }

    const sm = W() && W().selectionManager;
    if (!sm) return out;
    let list = [];
    if (typeof sm.getSelectedWMEFeatures === 'function') {
      try {
        list = sm.getSelectedWMEFeatures() || [];
      } catch (e) {
        console.warn('[NCA addresses] getSelectedWMEFeatures:', e);
      }
    }
    if (list.length === 0 && Array.isArray(sm.selectedItems)) {
      try {
        list = sm.selectedItems || [];
      } catch (e2) {
        console.warn('[NCA addresses] selectionManager.selectedItems:', e2);
      }
    }
    for (let s = list.length - 1; s >= 0; s--) {
      const seg = unwrapSegmentModel(list[s]);
      if (seg) pushSeg(seg);
    }
    return out;
  }

  function releaseSegmentFromSelection(segment) {
    if (!isSegmentModel(segment)) return;
    try {
      if (typeof segment.getAddress === 'function' && W() && W().model) {
        segment.getAddress(W().model);
      }
    } catch (_) {}
    try {
      const wsdk =
        typeof pageWin().getWmeSdk === 'function'
          ? pageWin().getWmeSdk({ scriptId: SCRIPT_ID, scriptName: SCRIPT_NAME })
          : sdk;
      if (
        wsdk &&
        wsdk.Editing &&
        typeof wsdk.Editing.clearSelection === 'function'
      ) {
        wsdk.Editing.clearSelection();
      }
    } catch (_) {}
  }

  /** Cyrillic yo → e (WME street/venue strings often use е only). */
  function normalizeCyrillicYoToE(s) {
    return String(s || '')
      .replace(/\u0451/g, 'е')
      .replace(/\u0401/g, 'Е');
  }

  /** Ordinal street suffix normalization: `5-ая` / `5 - АЯ` -> `5-я`. */
  function normalizeStreetOrdinalSuffixes(s) {
    let t = String(s || '');
    if (typeof t.normalize === 'function') t = t.normalize('NFKC');
    t = t.replace(/[\u200B-\u200D\uFEFF]/g, '');
    /** Primary: any dash variant between number and suffix. */
    t = t.replace(/(\d+)\s*[-‐‑‒–—]\s*[аaАA]\s*[яЯ](?=$|[^\p{L}\p{N}_])/gu, '$1-я');
    /** Fallback: no dash (e.g. `4ая`) -> normalize to `4-я`. */
    t = t.replace(/(\d+)\s*[аaАA]\s*[яЯ](?=$|[^\p{L}\p{N}_])/gu, '$1-я');
    return t;
  }

  /** Street line: `element_type_name`.toLowerCase() + ' ' + `element_name` (trimmed). */
  function streetLineFromProps(props) {
    if (!props || typeof props !== 'object') return '';
    const type =
      props.element_type_name != null ? String(props.element_type_name).toLowerCase().trim() : '';
    const name = props.element_name != null ? String(props.element_name).trim() : '';
    return normalizeStreetOrdinalSuffixes(normalizeCyrillicYoToE((type + ' ' + name).trim()));
  }

  function ncaRegexEscape(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /** First non-empty string among common NCA settlement / ATE name fields (not for street matching). */
  function ncaSettlementLabelFromProps(props) {
    if (!props || typeof props !== 'object') return '';
    const keys = [
      'nm_ate',
      'nm_naspunkt',
      'naspunkt',
      'ate_name',
      'name_np',
      'nm_np',
      'np_name',
      'city',
      'locality',
      'settlement',
    ];
    for (let i = 0; i < keys.length; i++) {
      const v = props[keys[i]];
      if (v != null && String(v).trim()) return String(v).trim();
    }
    return '';
  }

  function stripSettlementPrefixFromName(name, settlement) {
    let t = String(name || '').trim();
    const s = String(settlement || '').trim();
    if (!t || !s) return t;
    const re = new RegExp('^\\s*' + ncaRegexEscape(s) + '\\s*,\\s*', 'i');
    if (re.test(t)) return t.replace(re, '').trim();
    const reDash = new RegExp('^\\s*' + ncaRegexEscape(s) + '\\s*-\\s*', 'i');
    if (reDash.test(t)) return t.replace(reDash, '').trim();
    return t;
  }

  /**
   * Strip leading "г. …, / район …," style clauses from element_name (admin path before the street).
   */
  function stripLeadingLocalityClausesFromElementName(name) {
    let t = String(name || '').trim();
    const localityFirst =
      /^(г\.|г\s|гор\.|город|аг\.|аг\s|дер\.|дер\s|поселок|пос\.|пос\s|село|с\.|к\.|х\.|аул|мкрн\.|мкр\.|р-н\.|рн\.|район)\b/i;
    for (let guard = 0; guard < 6 && t; guard++) {
      const idx = t.indexOf(',');
      if (idx < 0) break;
      const first = t.slice(0, idx).trim();
      if (!localityFirst.test(first)) break;
      t = t.slice(idx + 1).trim();
    }
    return t;
  }

  /**
   * Street label for clipboard only: current address element (type + element_name), no parent_ate chain,
   * no house/apt/inv. Settlement stripped using nm_ate-style fields and leading locality clauses in element_name.
   */
  function ncaStreetNameOnlyForClipboard(addr) {
    const p = addr && addr.properties;
    if (!p || typeof p !== 'object') return '';
    const settlement = ncaSettlementLabelFromProps(p);
    let rawName = p.element_name != null ? String(p.element_name).trim() : '';
    if (settlement) rawName = stripSettlementPrefixFromName(rawName, settlement);
    rawName = stripLeadingLocalityClausesFromElementName(rawName);
    const type =
      p.element_type_name != null ? String(p.element_type_name).toLowerCase().trim() : '';
    const line = (type + ' ' + rawName).trim();
    return normalizeStreetOrdinalSuffixes(normalizeCyrillicYoToE(line));
  }

  /** Multi-line label for hover tooltip. */
  function hoverLabelFromAddress(addr) {
    const p = addr && addr.properties;
    if (!p || typeof p !== 'object') return 'Address';
    const lines = [];
    const street = streetLineFromProps(p);
    if (street) lines.push(street);
    const num = houseNumberFromNcaAddress(addr);
    const apt = p.apartment_number != null ? String(p.apartment_number).trim() : '';
    if (num || apt) {
      const u = num + (apt ? (num ? ' apt ' : '') + apt : '');
      if (u) lines.push(u);
    }
    if (p.parent_ate) lines.push(String(p.parent_ate));
    if (p.inv_num) lines.push('inv ' + String(p.inv_num));
    if (addr.idAdr != null) lines.push('id ' + String(addr.idAdr));
    return normalizeCyrillicYoToE(lines.join('\n').trim() || 'Address');
  }

  /** Venue name for WME: street line + building / extras (capped). */
  function venueNameFromAddress(addr) {
    const p = addr && addr.properties;
    if (!p || typeof p !== 'object') return 'Address';
    const street = streetLineFromProps(p);
    const num = houseNumberFromNcaAddress(addr);
    const apt = p.apartment_number != null ? String(p.apartment_number).trim() : '';
    let line = street;
    if (num) line = line ? line + ' ' + num : num;
    if (apt) line = line ? line + ' apt ' + apt : 'apt ' + apt;
    if (p.parent_ate) line = line ? line + ' — ' + String(p.parent_ate) : String(p.parent_ate);
    if (p.inv_num) {
      line = line ? line + ' — inv ' + String(p.inv_num) : 'inv ' + String(p.inv_num);
    }
    const t = normalizeStreetOrdinalSuffixes(normalizeCyrillicYoToE(line.trim()));
    return t.length > 200 ? t.slice(0, 197) + '…' : t || 'Address';
  }

  async function copyTextToClipboard(text) {
    const t = String(text || '');
    if (!t) return false;
    try {
      if (typeof GM_setClipboard === 'function') {
        GM_setClipboard(t);
        return true;
      }
    } catch (_) {}
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(t);
        return true;
      }
    } catch (_) {}
    try {
      const ta = document.createElement('textarea');
      ta.value = t;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch (_) {}
    return false;
  }

  function ensureAddressHoverNode() {
    if (addressHoverEl) return;
    addressHoverEl = document.createElement('div');
    addressHoverEl.id = SCRIPT_ID + '-hover';
    addressHoverEl.style.cssText =
      'position:fixed;z-index:2147483000;pointer-events:none;display:none;visibility:hidden;opacity:0;max-width:300px;padding:7px 9px;background:rgba(18,18,22,.96);color:#f5f5f5;border-radius:5px;font-size:12px;line-height:1.35;white-space:pre-wrap;box-shadow:0 3px 14px rgba(0,0,0,.45)';
    document.body.appendChild(addressHoverEl);
  }

  function showAddressHover(clientX, clientY, text) {
    ensureAddressHoverNode();
    addressHoverEl.textContent = text;
    addressHoverEl.style.display = 'block';
    addressHoverEl.style.visibility = 'visible';
    addressHoverEl.style.opacity = '1';
    const pad = 14;
    const left = Math.min(window.innerWidth - 290, Math.max(4, clientX + pad));
    const top = Math.min(window.innerHeight - 120, Math.max(4, clientY + pad));
    addressHoverEl.style.left = left + 'px';
    addressHoverEl.style.top = top + 'px';
  }

  function hideAddressHover() {
    if (addressHoverEl) {
      addressHoverEl.style.display = 'none';
      addressHoverEl.style.visibility = 'hidden';
      addressHoverEl.style.opacity = '0';
    }
  }

  function nextLayerRenderGeneration() {
    layerRenderGeneration += 1;
    return layerRenderGeneration;
  }

  function isActiveLayerRenderGeneration(gen) {
    return gen === layerRenderGeneration;
  }

  function addOl6FeaturesChunked(src, feats, generation) {
    return new Promise(function (resolve) {
      if (!src || !feats || !feats.length) return resolve();
      const chunkSize = Math.max(40, NCA_RENDER_CHUNK_SIZE);
      let i = 0;
      function pushNext() {
        if (!isActiveLayerRenderGeneration(generation)) return resolve();
        const end = Math.min(i + chunkSize, feats.length);
        const chunk = [];
        for (let j = i; j < end; j++) chunk.push(feats[j]);
        src.addFeatures(chunk);
        i = end;
        if (i >= feats.length) return resolve();
        requestAnimationFrame(pushNext);
      }
      pushNext();
    });
  }

  function addOl2FeaturesChunked(layer, feats, generation) {
    return new Promise(function (resolve) {
      if (!layer || !feats || !feats.length || typeof layer.addFeatures !== 'function') return resolve();
      const chunkSize = Math.max(40, NCA_RENDER_CHUNK_SIZE);
      let i = 0;
      function pushNext() {
        if (!isActiveLayerRenderGeneration(generation)) return resolve();
        const end = Math.min(i + chunkSize, feats.length);
        const chunk = [];
        for (let j = i; j < end; j++) chunk.push(feats[j]);
        layer.addFeatures(chunk);
        i = end;
        if (i >= feats.length) return resolve();
        requestAnimationFrame(pushNext);
      }
      pushNext();
    });
  }

  function createVenueFromAddressClick(addr) {
    void (async function () {
      try {
        const segs = await getSelectedSegmentsAsync();
        const seg = segs[0];
        if (seg) releaseSegmentFromSelection(seg);
        const r = await addResidentialHomeVenueFromNca(addr);
        if (r.ok) {
          removeNcaAddressPointFromLayers(addr);
        }
        setStatus(
          r.noSuitableStreet
            ? (r.copied === false
                ? 'No suitable WME street — copy failed (see console / grant clipboard).'
                : 'No suitable WME street — NCA street name copied to clipboard.')
            : r.duplicate
              ? 'Skipped: duplicate POI nearby or same street + house already exists.'
              : r.ok
                ? r.linked
                  ? r.houseNumberAdded
                    ? 'POI + street + house number.'
                    : 'POI + street (house number not added — see console).'
                  : r.houseNumberAdded
                    ? 'POI + house number (venue street not linked).'
                    : 'POI only (no street / house number).'
                : 'addVenue failed (see console).',
        );
      } catch (e) {
        console.warn('[NCA addresses] create venue:', e);
        setStatus((e && e.message) || String(e));
      }
    })();
  }

  async function ensureSdkReady() {
    const pw = pageWin();
    if (pw.SDK_INITIALIZED && typeof pw.SDK_INITIALIZED.then === 'function') {
      await pw.SDK_INITIALIZED;
    }
  }

  function getMapZoomLevel() {
    const mapW = W();
    if (mapW && mapW.map && typeof mapW.map.getZoom === 'function') {
      const z = Number(mapW.map.getZoom());
      if (Number.isFinite(z)) return z;
    }
    return null;
  }

  function viewportBboxKey(z, bbox) {
    const d = NCA_VIEWPORT_KEY_DECIMALS;
    return (
      z.toFixed(3) +
      '|' +
      bbox.minLon.toFixed(d) +
      '|' +
      bbox.minLat.toFixed(d) +
      '|' +
      bbox.maxLon.toFixed(d) +
      '|' +
      bbox.maxLat.toFixed(d)
    );
  }

  function packViewportBBox(minLon, minLat, maxLon, maxLat) {
    const minX = Math.min(minLon, maxLon);
    const maxX = Math.max(minLon, maxLon);
    const minY = Math.min(minLat, maxLat);
    const maxY = Math.max(minLat, maxLat);
    if (![minX, minY, maxX, maxY].every(Number.isFinite)) return null;
    return { minLon: minX, minLat: minY, maxLon: maxX, maxLat: maxY };
  }

  /**
   * Visible map extent in WGS84 (minLon, minLat, maxLon, maxLat).
   * 1) WME SDK `Map.getMapExtent()` → [left, bottom, right, top] in WGS84.
   * 2) OpenLayers 6+ (`ol`) calculateExtent / pixel corners.
   * 3) OpenLayers 2 `map.getExtent()`.
   */
  async function getViewportBBoxLonLatAsync() {
    try {
      if (sdk && sdk.Map && typeof sdk.Map.getMapExtent === 'function') {
        const raw = sdk.Map.getMapExtent();
        const ext = raw && typeof raw.then === 'function' ? await raw : raw;
        if (ext && ext.length >= 4) {
          const b = packViewportBBox(
            Number(ext[0]),
            Number(ext[1]),
            Number(ext[2]),
            Number(ext[3]),
          );
          if (b) return b;
        }
      }
    } catch (e) {
      console.warn('[NCA addresses] sdk.Map.getMapExtent:', e);
    }

    const mapW = W();
    if (!mapW || !mapW.map || typeof mapW.map.getOLMap !== 'function') {
      return null;
    }
    const olm = mapW.map.getOLMap();
    if (!olm) return null;

    const olGlobal = pageWin().ol;
    if (olGlobal && olGlobal.proj && typeof olm.getView === 'function') {
      const view = olm.getView();
      let size = typeof olm.getSize === 'function' ? olm.getSize() : null;
      if ((!size || size[0] < 2 || size[1] < 2) && typeof olm.getTargetElement === 'function') {
        const el = olm.getTargetElement();
        if (el && el.clientWidth > 2 && el.clientHeight > 2) {
          size = [el.clientWidth, el.clientHeight];
        }
      }
      if (view && size && size[0] >= 2 && size[1] >= 2 && typeof view.calculateExtent === 'function') {
        try {
          const ext = view.calculateExtent(size);
          if (ext && ext.length >= 4) {
            const fromProj = view.getProjection();
            if (fromProj) {
              const sw = olGlobal.proj.transform([ext[0], ext[1]], fromProj, 'EPSG:4326');
              const ne = olGlobal.proj.transform([ext[2], ext[3]], fromProj, 'EPSG:4326');
              const b = packViewportBBox(sw[0], sw[1], ne[0], ne[1]);
              if (b) return b;
            }
          }
        } catch (_) {}
      }

      if (
        typeof olm.getCoordinateFromPixel === 'function' &&
        view &&
        view.getProjection &&
        size &&
        size[0] >= 2 &&
        size[1] >= 2
      ) {
        try {
          const proj = view.getProjection();
          if (!proj) return null;
          const w = size[0];
          const h = size[1];
          const corners = [
            [0, h],
            [w, 0],
            [w, h],
            [0, 0],
          ];
          let minLon = Infinity;
          let maxLon = -Infinity;
          let minLat = Infinity;
          let maxLat = -Infinity;
          for (let i = 0; i < corners.length; i++) {
            const coord = olm.getCoordinateFromPixel(corners[i]);
            if (!coord) continue;
            const ll = olGlobal.proj.transform(coord, proj, 'EPSG:4326');
            if (ll && Number.isFinite(ll[0]) && Number.isFinite(ll[1])) {
              minLon = Math.min(minLon, ll[0]);
              maxLon = Math.max(maxLon, ll[0]);
              minLat = Math.min(minLat, ll[1]);
              maxLat = Math.max(maxLat, ll[1]);
            }
          }
          if (Number.isFinite(minLon) && minLon !== Infinity) {
            const b = packViewportBBox(minLon, minLat, maxLon, maxLat);
            if (b) return b;
          }
        } catch (_) {}
      }
    }

    if (typeof OpenLayers !== 'undefined' && typeof olm.getExtent === 'function') {
      try {
        const ext = olm.getExtent();
        if (!ext || ext.length < 4) return null;
        const proj =
          typeof olm.getProjectionObject === 'function'
            ? olm.getProjectionObject()
            : olm.projection;
        if (!proj) return null;
        const wgs = new OpenLayers.Projection('EPSG:4326');
        const sw = new OpenLayers.LonLat(ext[0], ext[1]).transform(proj, wgs);
        const ne = new OpenLayers.LonLat(ext[2], ext[3]).transform(proj, wgs);
        return packViewportBBox(sw.lon, sw.lat, ne.lon, ne.lat);
      } catch (_) {}
    }

    return null;
  }

  function haversineMeters(lon1, lat1, lon2, lat2) {
    const R = 6371000;
    const toR = Math.PI / 180;
    const dLat = (lat2 - lat1) * toR;
    const dLon = (lon2 - lon1) * toR;
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * toR) * Math.cos(lat2 * toR) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
    return R * c;
  }

  /** Loose compare for NCA street line vs WME street name (Cyrillic / prefixes). */
  function normalizeStreetCompareLabel(s) {
    let t = normalizeStreetOrdinalSuffixes(normalizeCyrillicYoToE(String(s || '')))
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
    t = t.replace(
      /^(улица|ул\.?|ул\b|проспект|просп\.?|пр\.?|переулок|пер\.?|шоссе|ш\.?|площадь|пл\.?|street|st\.?|avenue|ave\.?|road|rd\.?)\b[.\s]*/gi,
      '',
    );
    return t.trim();
  }

  function streetLabelsMatch(ncaLine, wmeStreetName) {
    const a = normalizeStreetCompareLabel(ncaLine);
    const b = normalizeStreetCompareLabel(wmeStreetName);
    if (!a || !b) return false;
    if (a === b) return true;
    if (a.includes(b) || b.includes(a)) return true;
    return false;
  }

  /**
   * WME house number from NCA: `building_number` plus `building_index` when present
   * (numeric index → `12/2`; letter suffix → `12А`).
   */
  function houseNumberFromNcaAddress(addr) {
    const p = addr && addr.properties;
    if (!p) return '';
    const baseRaw = p.building_number;
    const base = baseRaw != null && String(baseRaw).trim() !== '' ? String(baseRaw).trim() : '';
    const idxRaw = p.building_index;
    const idx = idxRaw != null && String(idxRaw).trim() !== '' ? String(idxRaw).trim() : '';
    if (!base && !idx) return '';
    if (!idx) return normalizeCyrillicYoToE(base);
    if (!base) return normalizeCyrillicYoToE(idx);
    if (/^\d+$/.test(idx)) {
      return normalizeCyrillicYoToE(base + '/' + idx);
    }
    return normalizeCyrillicYoToE(base + idx);
  }

  function normalizeHouseNumberStr(s) {
    return String(s || '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, '');
  }

  /** Collapse common WME vs NCA variants (`12/2` vs `12к2`) for duplicate HN checks. */
  function normalizeHouseNumberKeyForDedupe(s) {
    let t = normalizeHouseNumberStr(s);
    t = t.replace(/\//g, 'к');
    t = t.replace(/к\./g, 'к');
    return t;
  }

  function houseNumbersMatchForDedup(existingRaw, candidateRaw) {
    if (!candidateRaw || String(candidateRaw).trim() === '') return false;
    const ex = String(existingRaw || '').trim();
    const cand = String(candidateRaw).trim();
    if (!ex) return false;
    if (normalizeHouseNumberStr(ex) === normalizeHouseNumberStr(cand)) return true;
    return normalizeHouseNumberKeyForDedupe(ex) === normalizeHouseNumberKeyForDedupe(cand);
  }

  function readGeometryLikeModel(obj) {
    if (!obj || typeof obj !== 'object') return null;
    if (typeof obj.get === 'function') {
      try {
        const g = obj.get('geometry');
        if (g) return g;
      } catch (_) {}
    }
    const a = obj.attributes;
    if (a && typeof a === 'object' && a.geometry) return a.geometry;
    return null;
  }

  function venueGeometryPointLonLat(venue) {
    if (!venue) return null;
    const g = readGeometryLikeModel(venue);
    if (!g) return null;
    if (g.type === 'Point' && g.coordinates && g.coordinates.length >= 2) {
      const lon = Number(g.coordinates[0]);
      const lat = Number(g.coordinates[1]);
      if (Number.isFinite(lon) && Number.isFinite(lat)) return { lon: lon, lat: lat };
    }
    return null;
  }

  function hasNearbyResidentialVenue(wsdk, lon, lat, radiusM) {
    const R = Number(radiusM) > 0 ? Number(radiusM) : 10;
    if (!wsdk || !wsdk.DataModel || !wsdk.DataModel.Venues || typeof wsdk.DataModel.Venues.getAll !== 'function') {
      return false;
    }
    try {
      const all = wsdk.DataModel.Venues.getAll();
      if (!all || !all.length) return false;
      for (let i = 0; i < all.length; i++) {
        const v = all[i];
        if (!v || !v.isResidential) continue;
        const ll = venueGeometryPointLonLat(v);
        if (!ll) continue;
        if (haversineMeters(lon, lat, ll.lon, ll.lat) <= R) return true;
      }
    } catch (_) {}
    return false;
  }

  function hasResidentialVenueWithStreetAndHouse(wsdk, streetId, hnCandidateRaw) {
    if (streetId == null || !hnCandidateRaw || !wsdk || !wsdk.DataModel || !wsdk.DataModel.Venues) {
      return false;
    }
    if (typeof wsdk.DataModel.Venues.getAll !== 'function') return false;
    try {
      const all = wsdk.DataModel.Venues.getAll();
      if (!all || !all.length) return false;
      const sid = Number(streetId);
      if (!Number.isFinite(sid)) return false;
      for (let i = 0; i < all.length; i++) {
        const v = all[i];
        if (!v || !v.isResidential) continue;
        const vid = v.id != null ? v.id : v.venueId;
        if (vid == null || typeof wsdk.DataModel.Venues.getAddress !== 'function') continue;
        try {
          const a = wsdk.DataModel.Venues.getAddress({ venueId: String(vid) });
          if (!a || !a.street || a.street.id == null) continue;
          if (Number(a.street.id) !== sid) continue;
          const h = a.houseNumber != null ? String(a.houseNumber) : '';
          if (h && houseNumbersMatchForDedup(h, hnCandidateRaw)) return true;
        } catch (_) {}
      }
    } catch (_) {}
    return false;
  }

  function houseNumberRawFromHnObject(hn) {
    if (!hn) return '';
    const a = hn.attributes && typeof hn.attributes === 'object' ? hn.attributes : null;
    const candidates = [
      hn.number,
      a && a.number,
      a && a.houseNumber,
      hn.houseNumber,
      a && a.label,
    ];
    for (let i = 0; i < candidates.length; i++) {
      if (candidates[i] != null && String(candidates[i]).trim() !== '') {
        return String(candidates[i]);
      }
    }
    return '';
  }

  function segmentIdFromHouseNumberObject(hn) {
    if (!hn || typeof hn !== 'object') return null;
    const a = hn.attributes && typeof hn.attributes === 'object' ? hn.attributes : hn;
    if (a.segmentId != null) return a.segmentId;
    if (a.segID != null) return a.segID;
    if (a.segmentID != null) return a.segmentID;
    return null;
  }

  function segmentsMatchForHouseNumber(segmentIdFromHn, targetSegId) {
    if (targetSegId == null || segmentIdFromHn == null) return false;
    const t = Number(targetSegId);
    const s = Number(segmentIdFromHn);
    if (Number.isFinite(t) && Number.isFinite(s) && t === s) return true;
    return String(segmentIdFromHn) === String(targetSegId);
  }

  /** Fallback when SDK list is empty: scan WME model house number collections on segment. */
  function segmentHasHouseNumberInModel(model, segmentId, hnCandidateRaw) {
    if (!model || segmentId == null || !hnCandidateRaw || String(hnCandidateRaw).trim() === '') {
      return false;
    }
    const segNum = Number(segmentId);
    if (!Number.isFinite(segNum)) return false;

    function tryHouseNumber(hn) {
      if (!hn) return false;
      const segRaw = segmentIdFromHouseNumberObject(hn);
      if (!segmentsMatchForHouseNumber(segRaw, segNum)) return false;
      return houseNumbersMatchForDedup(houseNumberRawFromHnObject(hn), hnCandidateRaw);
    }

    function visitRepo(repo) {
      if (!repo || typeof repo !== 'object') return false;
      const objs = repo.objects;
      if (objs && typeof objs === 'object') {
        for (const k in objs) {
          if (!Object.prototype.hasOwnProperty.call(objs, k)) continue;
          if (tryHouseNumber(objs[k])) return true;
        }
      }
      const models = repo.models;
      if (Array.isArray(models)) {
        for (let i = 0; i < models.length; i++) {
          if (tryHouseNumber(models[i])) return true;
        }
      }
      if (typeof repo.forEach === 'function') {
        try {
          let hit = false;
          repo.forEach(function (hn) {
            if (tryHouseNumber(hn)) hit = true;
          });
          if (hit) return true;
        } catch (_) {}
      }
      return false;
    }

    try {
      if (visitRepo(model.houseNumbers)) return true;
      if (model.liveHouseNumbers && visitRepo(model.liveHouseNumbers)) return true;
    } catch (_) {}
    return false;
  }

  async function segmentAlreadyHasHouseNumber(wsdk, model, segmentId, hnCandidateRaw) {
    if (segmentId == null || !hnCandidateRaw || String(hnCandidateRaw).trim() === '') {
      return false;
    }
    const segNum = Number(segmentId);
    if (!Number.isFinite(segNum)) return false;
    if (
      wsdk &&
      wsdk.DataModel &&
      wsdk.DataModel.HouseNumbers &&
      typeof wsdk.DataModel.HouseNumbers.fetchHouseNumbers === 'function'
    ) {
      try {
        let list = wsdk.DataModel.HouseNumbers.fetchHouseNumbers({ segmentIds: [segNum] });
        if (list && typeof list.then === 'function') list = await list;
        if (list && list.length) {
          for (let j = 0; j < list.length; j++) {
            if (houseNumbersMatchForDedup(houseNumberRawFromHnObject(list[j]), hnCandidateRaw)) {
              return true;
            }
          }
        }
      } catch (_) {}
    }
    return segmentHasHouseNumberInModel(model, segNum, hnCandidateRaw);
  }

  function forEachWmeSegment(model, fn) {
    const segs = model && model.segments;
    if (!segs || typeof fn !== 'function') return;
    if (typeof segs.forEach === 'function') {
      segs.forEach(function (seg) {
        if (fn(seg) === false) return;
      });
      return;
    }
    if (typeof segs.each === 'function') {
      segs.each(function (seg) {
        if (fn(seg) === false) return;
      });
      return;
    }
    const objs = segs.objects;
    if (objs && typeof objs === 'object') {
      for (const k in objs) {
        if (!Object.prototype.hasOwnProperty.call(objs, k)) continue;
        if (fn(objs[k]) === false) break;
      }
    }
  }

  function wmeSegmentGeometry(seg) {
    return readGeometryLikeModel(seg);
  }

  function wmeSegmentId(seg) {
    if (!seg || !seg.attributes) return null;
    if (seg.attributes.id != null) return seg.attributes.id;
    if (seg.attributes.ID != null) return seg.attributes.ID;
    if (seg.attributes.segID != null) return seg.attributes.segID;
    return null;
  }

  function wmeSegmentPrimaryStreetId(seg) {
    if (!seg || !seg.attributes) return null;
    const v = seg.attributes.primaryStreetID;
    return v != null ? Number(v) : null;
  }

  function wmeStreetNameById(model, streetId) {
    if (streetId == null || !model || !model.streets || typeof model.streets.getObjectById !== 'function') {
      return '';
    }
    try {
      const st = model.streets.getObjectById(streetId);
      return st && st.attributes && st.attributes.name != null ? String(st.attributes.name) : '';
    } catch (_) {
      return '';
    }
  }

  /** Min distance (m) from (lon,lat) to any vertex of the segment geometry (map projection). */
  function roughDistancePointToSegmentM(lon, lat, seg, mapProj) {
    const geom = wmeSegmentGeometry(seg);
    if (typeof OpenLayers === 'undefined' || !mapProj || !geom || typeof geom.getVertices !== 'function') {
      return Infinity;
    }
    const verts = geom.getVertices();
    if (!verts || !verts.length) return Infinity;
    const wgs = new OpenLayers.Projection('EPSG:4326');
    let md = Infinity;
    for (let i = 0; i < verts.length; i++) {
      try {
        const v = verts[i];
        const ll = new OpenLayers.LonLat(v.x, v.y).transform(mapProj, wgs);
        const d = haversineMeters(lon, lat, ll.lon, ll.lat);
        if (d < md) md = d;
      } catch (_) {}
    }
    return md;
  }

  function resolveStreetIdFromSegment(wsdk, seg) {
    const sid = wmeSegmentId(seg);
    const fallback = wmeSegmentPrimaryStreetId(seg);
    if (
      sid != null &&
      wsdk &&
      wsdk.DataModel &&
      wsdk.DataModel.Segments &&
      typeof wsdk.DataModel.Segments.getAddress === 'function'
    ) {
      try {
        const a = wsdk.DataModel.Segments.getAddress({ segmentId: sid });
        if (a && a.street && a.street.id != null) return Number(a.street.id);
      } catch (_) {}
    }
    return fallback;
  }

  /**
   * One segment scan: fill bestName / bestAny per entry (lon/lat + optional NCA street hint).
   * Used for map styling (batch) and for findStreetBindingForNca (single entry).
   */
  function accumulateStreetPicksForNcaEntries(entries, model, olm, wsdk) {
    if (!entries || !entries.length) return;
    if (!model || !model.segments || !model.streets || !olm || typeof OpenLayers === 'undefined') {
      return;
    }
    const mapProj =
      typeof olm.getProjectionObject === 'function'
        ? olm.getProjectionObject()
        : olm.projection;
    if (!mapProj) return;
    const MAX_SCAN = 80000;
    const MAX_DIST_M = 420;
    let scanned = 0;
    forEachWmeSegment(model, function (seg) {
      if (scanned++ > MAX_SCAN) return false;
      if (!seg || !wmeSegmentGeometry(seg)) return;
      const streetId = resolveStreetIdFromSegment(wsdk, seg);
      if (streetId == null || !Number.isFinite(streetId)) return;
      const segId = wmeSegmentId(seg);
      for (let ei = 0; ei < entries.length; ei++) {
        const e = entries[ei];
        if (!e || !Number.isFinite(e.lon) || !Number.isFinite(e.lat)) continue;
        const d = roughDistancePointToSegmentM(e.lon, e.lat, seg, mapProj);
        if (!Number.isFinite(d) || d > MAX_DIST_M) continue;
        if (!e.bestAny || d < e.bestAny.d) {
          e.bestAny = { d: d, streetId: streetId, segmentId: segId };
        }
        if (e.hintTrim) {
          const nm = wmeStreetNameById(model, streetId);
          if (streetLabelsMatch(e.hintRaw, nm) && (!e.bestName || d < e.bestName.d)) {
            e.bestName = { d: d, streetId: streetId, segmentId: segId };
          }
        }
      }
    });
  }

  /**
   * Suitable WME binding for venue.updateAddress: if NCA has a street line, require a name-matched
   * segment within range; otherwise use the nearest segment that has a street id.
   */
  function findStreetBindingForNca(addr, lon, lat, model, olm, wsdk) {
    if (!model || !model.segments || !model.streets || !olm || typeof OpenLayers === 'undefined') {
      return null;
    }
    const hintRaw = streetLineFromProps((addr && addr.properties) || {});
    const hintTrim = hintRaw.trim();
    const houseNumber = houseNumberFromNcaAddress(addr);
    const entries = [{ lon: lon, lat: lat, hintRaw: hintRaw, hintTrim: hintTrim, bestName: null, bestAny: null }];
    accumulateStreetPicksForNcaEntries(entries, model, olm, wsdk);
    const e = entries[0];
    const pick = e.hintTrim ? e.bestName : e.bestAny;
    if (!pick) return null;
    return { streetId: pick.streetId, houseNumber: houseNumber, segmentId: pick.segmentId };
  }

  function venueIdFromAddVenueResult(raw) {
    if (raw == null) return null;
    if (typeof raw === 'string' || typeof raw === 'number') return String(raw);
    if (typeof raw.toString === 'function') {
      const s = raw.toString();
      if (s && s !== '[object Object]') return s;
    }
    if (raw.id != null) return String(raw.id);
    if (raw.venueId != null) return String(raw.venueId);
    return null;
  }

  function venueCategoryValueForSdk(wsdk, categoryIdString) {
    if (!categoryIdString || !wsdk) return categoryIdString;
    const keys = ['VenueCategoryId', 'VenueCategories'];
    for (let k = 0; k < keys.length; k++) {
      const E = wsdk[keys[k]];
      if (
        E &&
        typeof E === 'object' &&
        Object.prototype.hasOwnProperty.call(E, categoryIdString)
      ) {
        const v = E[categoryIdString];
        if (v != null) return v;
      }
    }
    const nested = wsdk.enums;
    if (nested && typeof nested === 'object') {
      for (let k = 0; k < keys.length; k++) {
        const E = nested[keys[k]];
        if (
          E &&
          typeof E === 'object' &&
          Object.prototype.hasOwnProperty.call(E, categoryIdString)
        ) {
          const v = E[categoryIdString];
          if (v != null) return v;
        }
      }
    }
    return categoryIdString;
  }

  /**
   * Residential home point (RESIDENCE_HOME / RESIDENTIAL) + Venues.updateAddress when a WME street is found.
   */
  async function addResidentialHomeVenueFromNca(addr) {
    await ensureSdkReady();
    const wsdk =
      typeof pageWin().getWmeSdk === 'function'
        ? pageWin().getWmeSdk({ scriptId: SCRIPT_ID, scriptName: SCRIPT_NAME })
        : sdk;
    if (
      !wsdk ||
      !wsdk.DataModel ||
      !wsdk.DataModel.Venues ||
      typeof wsdk.DataModel.Venues.addVenue !== 'function'
    ) {
      return { ok: false, linked: false, houseNumberAdded: false };
    }
    const lon = Number(addr.lon);
    const lat = Number(addr.lat);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
      return { ok: false, linked: false, houseNumberAdded: false };
    }

    const mapW = W();
    const olm = mapW && mapW.map && mapW.map.getOLMap ? mapW.map.getOLMap() : null;
    const model = mapW && mapW.model;
    let binding = null;
    try {
      if (model && olm) {
        binding = findStreetBindingForNca(addr, lon, lat, model, olm, wsdk);
      }
    } catch (e) {
      console.warn('[NCA addresses] street binding:', e);
    }

    if (!binding) {
      const label = ncaStreetNameOnlyForClipboard(addr);
      const copied = await copyTextToClipboard(label);
      return {
        ok: false,
        linked: false,
        houseNumberAdded: false,
        noSuitableStreet: true,
        copied: copied,
      };
    }

    const inflightK = ncaAddressRowKey(addr);
    if (ncaVenueCreateInflight[inflightK]) {
      return { ok: false, linked: false, houseNumberAdded: false, duplicate: true };
    }
    ncaVenueCreateInflight[inflightK] = true;

    try {
      const n = venueNameFromAddress(addr);
      const nameStr = n && String(n).trim() ? String(n).trim() : ' ';
      const geo = { type: 'Point', coordinates: [lon, lat] };
      const add = wsdk.DataModel.Venues.addVenue.bind(wsdk.DataModel.Venues);

      const hnDigits = houseNumberFromNcaAddress(addr);

      if (hasNearbyResidentialVenue(wsdk, lon, lat, 10)) {
        return { ok: false, linked: false, houseNumberAdded: false, duplicate: true };
      }
      if (binding.streetId != null && hnDigits) {
        if (hasResidentialVenueWithStreetAndHouse(wsdk, binding.streetId, hnDigits)) {
          return { ok: false, linked: false, houseNumberAdded: false, duplicate: true };
        }
      }

      async function tryAdd(payload) {
        try {
          let r = add(payload);
          if (r && typeof r.then === 'function') r = await r;
          return r;
        } catch (_) {
          return null;
        }
      }

      const categoryStrings = ['RESIDENCE_HOME', 'RESIDENTIAL'];
      let rawResult = null;
      for (let i = 0; i < categoryStrings.length && !rawResult; i++) {
        const catVal = venueCategoryValueForSdk(wsdk, categoryStrings[i]);
        rawResult =
          (await tryAdd({ geometry: geo, categories: [catVal], name: nameStr })) ||
          (await tryAdd({ geometry: geo, category: catVal, name: nameStr }));
      }
      if (!rawResult) {
        rawResult = await tryAdd({ category: 'RESIDENCE_HOME', geometry: geo, name: nameStr });
      }
      if (!rawResult) {
        rawResult = await tryAdd({ category: 'RESIDENTIAL', geometry: geo, name: nameStr });
      }
      if (!rawResult) {
        rawResult = await tryAdd({ geometry: geo, name: nameStr });
      }
      const venueId = venueIdFromAddVenueResult(rawResult);
      if (!venueId) {
        console.warn('[NCA addresses] addVenue: no venue id from result', rawResult);
        return { ok: false, linked: false, houseNumberAdded: false };
      }

      let linked = false;
      if (
        binding &&
        binding.streetId != null &&
        wsdk.DataModel.Venues &&
        typeof wsdk.DataModel.Venues.updateAddress === 'function'
      ) {
        try {
          let u = wsdk.DataModel.Venues.updateAddress({
            venueId: venueId,
            streetId: binding.streetId,
            houseNumber: binding.houseNumber != null ? String(binding.houseNumber) : '',
          });
          if (u && typeof u.then === 'function') u = await u;
          linked = true;
        } catch (e) {
          console.warn('[NCA addresses] updateAddress:', e);
        }
      }

      /** WME SDK maps ADD_HOUSE_NUMBER — require segmentId so dedupe matches real segment state. */
      let houseNumberAdded = false;
      if (
        hnDigits &&
        wsdk.DataModel.HouseNumbers &&
        typeof wsdk.DataModel.HouseNumbers.addHouseNumber === 'function'
      ) {
        const segForHn = binding.segmentId != null ? binding.segmentId : null;
        const segIdNum = Number(segForHn);
        if (Number.isFinite(segIdNum)) {
          let skipHn = false;
          try {
            skipHn = await segmentAlreadyHasHouseNumber(wsdk, model, segIdNum, hnDigits);
          } catch (_) {
            skipHn = false;
          }
          if (!skipHn) {
            try {
              let hnRet = wsdk.DataModel.HouseNumbers.addHouseNumber({
                number: hnDigits,
                point: { type: 'Point', coordinates: [lon, lat] },
                segmentId: segIdNum,
              });
              if (hnRet && typeof hnRet.then === 'function') hnRet = await hnRet;
              houseNumberAdded = true;
            } catch (e2) {
              console.warn('[NCA addresses] addHouseNumber:', e2);
            }
          }
        }
      }

      return { ok: true, linked: linked, houseNumberAdded: houseNumberAdded };
    } finally {
      delete ncaVenueCreateInflight[inflightK];
    }
  }

  function setStatus(text) {
    if (statusEl) statusEl.textContent = text;
  }

  function httpGetJson(url) {
    return new Promise(function (resolve, reject) {
      if (typeof GM_xmlhttpRequest === 'function') {
        GM_xmlhttpRequest({
          method: 'GET',
          url: url,
          anonymous: true,
          headers: { Accept: 'application/json' },
          timeout: 90_000,
          onload: function (resp) {
            if (resp.status >= 200 && resp.status < 300) {
              try {
                resolve(JSON.parse(resp.responseText));
              } catch (e) {
                reject(new Error('Invalid JSON: ' + ((e && e.message) || String(e))));
              }
            } else {
              reject(
                new Error(
                  'HTTP ' +
                    resp.status +
                    ' ' +
                    String(resp.responseText || '').slice(0, 240),
                ),
              );
            }
          },
          onerror: function () {
            reject(new Error('Network error (GM_xmlhttpRequest)'));
          },
          ontimeout: function () {
            reject(new Error('Request timeout'));
          },
        });
        return;
      }
      fetch(url, { method: 'GET', credentials: 'omit' })
        .then(function (res) {
          if (!res.ok) {
            return res.text().then(function (t) {
              throw new Error(
                'HTTP ' + res.status + (t ? ': ' + t.slice(0, 200) : ''),
              );
            });
          }
          return res.json();
        })
        .then(resolve)
        .catch(reject);
    });
  }

  async function fetchAddressesInBbox(bbox) {
    const base = (apiInput && apiInput.value.trim()) || storageGet(STORAGE_API_BASE, DEFAULT_API_BASE);
    storageSet(STORAGE_API_BASE, base);
    const q =
      'minLon=' +
      encodeURIComponent(bbox.minLon) +
      '&minLat=' +
      encodeURIComponent(bbox.minLat) +
      '&maxLon=' +
      encodeURIComponent(bbox.maxLon) +
      '&maxLat=' +
      encodeURIComponent(bbox.maxLat);
    const url = base.replace(/\/$/, '') + '/api/addresses/bbox?' + q;
    return httpGetJson(url);
  }

  function clearAddressMapFeatures() {
    hideAddressHover();
    ncaHoverLiteMode = false;
    lastOl6AddressesForHover = [];
    lastOl2AddressesForHover = [];
    try {
      if (addressOl2VectorLayer && addressOl2VectorLayer.destroyFeatures) {
        addressOl2VectorLayer.destroyFeatures();
      }
    } catch (_) {}
    try {
      if (addressOl6VectorLayer && addressOl6VectorLayer.getSource) {
        addressOl6VectorLayer.getSource().clear();
      }
    } catch (_) {}
  }

  /** Same NCA bbox row (by idAdr or lon/lat). */
  function ncaAddressRowsEqual(a, b) {
    if (!a || !b) return false;
    const ida = a.idAdr != null ? String(a.idAdr) : '';
    const idb = b.idAdr != null ? String(b.idAdr) : '';
    if (ida && idb && ida === idb) return true;
    const la = Number(a.lon);
    const loa = Number(a.lat);
    const lb = Number(b.lon);
    const lob = Number(b.lat);
    if (!Number.isFinite(la) || !Number.isFinite(loa) || !Number.isFinite(lb) || !Number.isFinite(lob)) {
      return false;
    }
    const eps = 1e-7;
    return Math.abs(la - lb) < eps && Math.abs(loa - lob) < eps;
  }

  function ncaAddressRowKey(row) {
    if (row && row.idAdr != null) return 'id:' + String(row.idAdr);
    const lon = Number(row && row.lon);
    const lat = Number(row && row.lat);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return 'na';
    return 'll:' + lon.toFixed(7) + ':' + lat.toFixed(7);
  }

  /**
   * Drop NCA rows that likely duplicate an on-map residential place (same normalized house number,
   * POI point within NCA_OVERLAY_HIDE_NEAR_RESIDENTIAL_M). Street is not resolved per row (cost).
   */
  async function filterNcaAddressesOverlappingResidentialPoi(addresses) {
    if (!hideDupResidentialOverlayEl || !hideDupResidentialOverlayEl.checked || !addresses.length) {
      return addresses;
    }
    const wsdk =
      typeof pageWin().getWmeSdk === 'function'
        ? pageWin().getWmeSdk({ scriptId: SCRIPT_ID, scriptName: SCRIPT_NAME })
        : sdk;
    if (
      !wsdk ||
      !wsdk.DataModel ||
      !wsdk.DataModel.Venues ||
      typeof wsdk.DataModel.Venues.getAll !== 'function' ||
      typeof wsdk.DataModel.Venues.getAddress !== 'function'
    ) {
      return addresses;
    }
    let venues;
    try {
      venues = wsdk.DataModel.Venues.getAll();
    } catch (_) {
      return addresses;
    }
    if (!venues || !venues.length) return addresses;
    const hide = Object.create(null);
    const maxM = NCA_OVERLAY_HIDE_NEAR_RESIDENTIAL_M;
    for (let vi = 0; vi < venues.length; vi++) {
      const v = venues[vi];
      if (!v || !v.isResidential) continue;
      const vid = v.id != null ? v.id : v.venueId;
      if (vid == null) continue;
      let va;
      try {
        va = wsdk.DataModel.Venues.getAddress({ venueId: String(vid) });
      } catch (_) {
        continue;
      }
      const hnVenue =
        va && va.houseNumber != null ? normalizeHouseNumberStr(String(va.houseNumber)) : '';
      if (!hnVenue) continue;
      const llV = venueGeometryPointLonLat(v);
      if (!llV) continue;
      for (let ai = 0; ai < addresses.length; ai++) {
        const row = addresses[ai];
        const hnRow = normalizeHouseNumberStr(houseNumberFromNcaAddress(row));
        if (!hnRow || hnRow !== hnVenue) continue;
        const lon = Number(row.lon);
        const lat = Number(row.lat);
        if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
        if (haversineMeters(lon, lat, llV.lon, llV.lat) <= maxM) {
          hide[ncaAddressRowKey(row)] = true;
        }
      }
    }
    return addresses.filter(function (row) {
      return !hide[ncaAddressRowKey(row)];
    });
  }

  /** After a POI is created from this row, drop only that overlay point (keep other NCA markers). */
  function removeNcaAddressPointFromLayers(addr) {
    if (!addr) return;
    lastOl6AddressesForHover = lastOl6AddressesForHover.filter(function (row) {
      return !ncaAddressRowsEqual(row, addr);
    });
    lastOl2AddressesForHover = lastOl2AddressesForHover.filter(function (row) {
      return !ncaAddressRowsEqual(row, addr);
    });
    try {
      if (addressOl6VectorLayer && addressOl6VectorLayer.getSource) {
        const src = addressOl6VectorLayer.getSource();
        const rm = [];
        let feats = null;
        try {
          feats = typeof src.getFeatures === 'function' ? src.getFeatures() : null;
        } catch (_) {}
        if (feats && feats.length) {
          for (let i = 0; i < feats.length; i++) {
            const na = addressFromOl6Feature(feats[i]);
            if (na && ncaAddressRowsEqual(na, addr)) rm.push(feats[i]);
          }
          for (let j = 0; j < rm.length; j++) {
            if (typeof src.removeFeature === 'function') src.removeFeature(rm[j]);
          }
        }
      }
    } catch (e) {
      console.warn('[NCA addresses] remove OL6 feature:', e);
    }
    try {
      if (addressOl2VectorLayer) {
        const feats = addressOl2VectorLayer.features;
        const rm = [];
        if (feats && feats.length) {
          for (let i = 0; i < feats.length; i++) {
            const f = feats[i];
            const na = f && f.attributes && f.attributes.ncaAddr;
            if (na && ncaAddressRowsEqual(na, addr)) rm.push(f);
          }
        }
        if (rm.length) {
          if (typeof addressOl2VectorLayer.removeFeatures === 'function') {
            addressOl2VectorLayer.removeFeatures(rm);
          } else if (typeof addressOl2VectorLayer.destroyFeatures === 'function') {
            addressOl2VectorLayer.destroyFeatures(rm);
          }
        }
      }
    } catch (e2) {
      console.warn('[NCA addresses] remove OL2 feature:', e2);
    }
  }

  function pixelToXYPair(p) {
    if (p == null) return null;
    if (Array.isArray(p) && p.length >= 2 && Number.isFinite(Number(p[0])) && Number.isFinite(Number(p[1]))) {
      return [Number(p[0]), Number(p[1])];
    }
    if (typeof p[0] === 'number' && typeof p[1] === 'number') {
      return [p[0], p[1]];
    }
    if (p.x != null && p.y != null && Number.isFinite(Number(p.x)) && Number.isFinite(Number(p.y))) {
      return [Number(p.x), Number(p.y)];
    }
    return null;
  }

  function addressFromOl6Feature(f) {
    if (!f) return null;
    try {
      if (typeof f.get === 'function') {
        const a = f.get('ncaAddr');
        if (a && typeof a === 'object') return a;
      }
    } catch (_) {}
    try {
      const props = typeof f.getProperties === 'function' ? f.getProperties() : null;
      if (props && props.ncaAddr && typeof props.ncaAddr === 'object') return props.ncaAddr;
    } catch (_) {}
    return null;
  }

  function mouseEventToMapPixel(olm, domEv, vpEl) {
    const r = vpEl && vpEl.getBoundingClientRect ? vpEl.getBoundingClientRect() : null;
    let fromOl = null;
    try {
      if (typeof olm.getEventPixel === 'function') {
        fromOl = pixelToXYPair(olm.getEventPixel(domEv));
      }
    } catch (_) {}
    if (fromOl && r && r.width > 0 && r.height > 0) {
      const pad = NCA_HOVER_VIEWPORT_PAD_PX;
      if (
        fromOl[0] >= -pad &&
        fromOl[0] <= r.width + pad &&
        fromOl[1] >= -pad &&
        fromOl[1] <= r.height + pad
      ) {
        return fromOl;
      }
    }
    if (!vpEl || !domEv || domEv.clientX == null || !r || r.width <= 0) {
      return fromOl;
    }
    const x = domEv.clientX - r.left;
    const y = domEv.clientY - r.top;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return fromOl;
    return [x, y];
  }

  /** Web Mercator meters (EPSG:3857) from WGS84 lon/lat — used when `ol.proj` is unavailable. */
  function lonLatTo3857Approx(lon, lat) {
    const HALF = 20037508.34;
    const x = (lon * HALF) / 180;
    const y = (Math.log(Math.tan(((90 + lat) * Math.PI) / 360)) / (Math.PI / 180)) * (HALF / 180);
    return [x, y];
  }

  function resolveOl6Global(olGlobal) {
    return olGlobal || cachedOl6Global || pageWin().ol;
  }

  /** Map coordinate in the view projection for a WGS84 point. */
  function lonLatToMapCoordOl6(olm, olGlobal, lon, lat) {
    const view = typeof olm.getView === 'function' ? olm.getView() : null;
    const proj = view && view.getProjection ? view.getProjection() : null;
    if (!proj) return null;
    const og = resolveOl6Global(olGlobal);
    if (og && og.proj && typeof og.proj.fromLonLat === 'function') {
      try {
        const c = og.proj.fromLonLat([Number(lon), Number(lat)], proj);
        if (c && Number.isFinite(c[0]) && Number.isFinite(c[1])) return c;
      } catch (_) {}
    }
    const code = typeof proj.getCode === 'function' ? String(proj.getCode()) : '';
    if (code === 'EPSG:3857' || code === 'EPSG:900913') {
      const m = lonLatTo3857Approx(Number(lon), Number(lat));
      return m;
    }
    if (code === 'EPSG:4326') {
      return [Number(lon), Number(lat)];
    }
    return null;
  }

  function nearestAddressAtPixelOl6(olm, pixel, olGlobal) {
    const list = lastOl6AddressesForHover;
    if (!list.length || !olm || typeof olm.getPixelFromCoordinate !== 'function') {
      return null;
    }
    if (list.length > NCA_HOVER_NEAREST_SCAN_MAX_ADDRESSES) return null;
    const view = typeof olm.getView === 'function' ? olm.getView() : null;
    const proj = view && view.getProjection ? view.getProjection() : null;
    if (!proj) return null;
    const px = pixelToXYPair(pixel);
    if (!px) return null;
    const maxDist = NCA_HOVER_NEAREST_MAX_PX;
    let best = null;
    let bestD = maxDist + 1;
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      if (!a || !Number.isFinite(Number(a.lon)) || !Number.isFinite(Number(a.lat))) continue;
      const c = lonLatToMapCoordOl6(olm, olGlobal, a.lon, a.lat);
      if (!c) continue;
      let screenPx;
      try {
        screenPx = pixelToXYPair(olm.getPixelFromCoordinate(c));
      } catch (_) {
        continue;
      }
      if (!screenPx) continue;
      const dx = screenPx[0] - px[0];
      const dy = screenPx[1] - px[1];
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < bestD) {
        bestD = d;
        best = a;
      }
    }
    return bestD <= maxDist ? best : null;
  }

  function pickOl2NcaFeatureAtPixel(layer, pixelPair) {
    if (!layer || typeof layer.getFeatureFromEvent !== 'function') return null;
    const px = pixelToXYPair(pixelPair);
    if (!px || typeof OpenLayers === 'undefined' || !OpenLayers.Pixel) return null;
    try {
      const f = layer.getFeatureFromEvent({ xy: new OpenLayers.Pixel(px[0], px[1]) });
      if (f && f.attributes && f.attributes.ncaAddr) return f;
    } catch (_) {}
    return null;
  }

  function nearestAddressAtPixelOl2(olm, pixelPair, addresses) {
    if (!addresses || !addresses.length || !olm || typeof olm.getPixelFromLonLat !== 'function') {
      return null;
    }
    if (addresses.length > NCA_HOVER_NEAREST_SCAN_MAX_ADDRESSES) return null;
    if (typeof OpenLayers === 'undefined') return null;
    const px = pixelToXYPair(pixelPair);
    if (!px) return null;
    const proj =
      typeof olm.getProjectionObject === 'function'
        ? olm.getProjectionObject()
        : olm.projection;
    if (!proj) return null;
    const wgs = new OpenLayers.Projection('EPSG:4326');
    const maxDist = NCA_HOVER_NEAREST_MAX_PX;
    let best = null;
    let bestD = maxDist + 1;
    for (let i = 0; i < addresses.length; i++) {
      const a = addresses[i];
      if (!a || !Number.isFinite(Number(a.lon)) || !Number.isFinite(Number(a.lat))) continue;
      try {
        const pll = new OpenLayers.LonLat(Number(a.lon), Number(a.lat)).transform(wgs, proj);
        const pix = olm.getPixelFromLonLat(pll);
        if (!pix || pix.x == null || pix.y == null) continue;
        const dx = Number(pix.x) - px[0];
        const dy = Number(pix.y) - px[1];
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d < bestD) {
          bestD = d;
          best = a;
        }
      } catch (_) {
        continue;
      }
    }
    return bestD <= maxDist ? best : null;
  }

  function pickNcaFeatureAtPixelOl6(olm, pixel) {
    const opts = {
      layerFilter: function (ly) {
        return ly === addressOl6VectorLayer;
      },
      hitTolerance: NCA_HOVER_HIT_TOLERANCE_PX,
    };
    let hit = null;
    if (addressOl6VectorLayer && typeof olm.getFeaturesAtPixel === 'function') {
      try {
        const arr = olm.getFeaturesAtPixel(pixel, opts);
        if (arr && arr.length) {
          for (let i = 0; i < arr.length; i++) {
            const f = arr[i];
            if (addressFromOl6Feature(f)) {
              return f;
            }
          }
        }
      } catch (_) {}
    }
    if (addressOl6VectorLayer) {
      try {
        olm.forEachFeatureAtPixel(
          pixel,
          function (f) {
            if (addressFromOl6Feature(f)) {
              hit = f;
              return true;
            }
          },
          opts,
        );
      } catch (_) {}
    }
    return hit;
  }

  function getOl6MapViewportDom(olm) {
    try {
      if (sdk && sdk.Map && typeof sdk.Map.getMapViewportElement === 'function') {
        const el = sdk.Map.getMapViewportElement();
        if (el && el.nodeType === 1) return el;
      }
    } catch (_) {}
    if (olm && typeof olm.getViewport === 'function') {
      const v = olm.getViewport();
      if (v && v.nodeType === 1) return v;
    }
    if (olm && typeof olm.getTarget === 'function') {
      const t = olm.getTarget();
      if (t && t.nodeType === 1) return t;
    }
    const mw = W();
    if (mw && mw.map) {
      if (mw.map.div && mw.map.div.nodeType === 1) return mw.map.div;
      if (mw.map.mapDiv && mw.map.mapDiv.nodeType === 1) return mw.map.mapDiv;
    }
    return null;
  }

  /**
   * Hover: document-level mousemove (capture) + map viewport rect test — survives overlays
   * that swallow events on the OL viewport node. Supports both OL6 and OL2 (WME production).
   */
  function bindNcaDocumentViewportHover() {
    if (ncaDocumentHoverBound) return;
    ncaDocumentHoverBound = true;
    const win = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
    function onDocMove(domEv) {
      if (!lastOl6AddressesForHover.length && !lastOl2AddressesForHover.length) {
        hideAddressHover();
        return;
      }
      if (addressHoverRaf != null) cancelAnimationFrame(addressHoverRaf);
      addressHoverRaf = requestAnimationFrame(function () {
        addressHoverRaf = null;
        if (followMapEl && !followMapEl.checked) {
          hideAddressHover();
          return;
        }
        if (ncaHoverLiteMode) {
          hideAddressHover();
          return;
        }
        /** While dragging with mouse button pressed, skip hover hit-testing to keep panning smooth. */
        if (domEv && domEv.buttons && Number(domEv.buttons) !== 0) {
          hideAddressHover();
          return;
        }
        const mapW = W();
        if (!mapW || !mapW.map || typeof mapW.map.getOLMap !== 'function') {
          hideAddressHover();
          return;
        }
        const olm = mapW.map.getOLMap();
        if (!olm) {
          hideAddressHover();
          return;
        }

        const ol6Active =
          lastOl6AddressesForHover.length > 0 &&
          addressOl6VectorLayer &&
          typeof olm.getPixelFromCoordinate === 'function';
        const ol2Active =
          lastOl2AddressesForHover.length > 0 &&
          addressOl2VectorLayer &&
          typeof OpenLayers !== 'undefined' &&
          typeof olm.getPixelFromLonLat === 'function';

        if (!ol6Active && !ol2Active) {
          hideAddressHover();
          return;
        }

        const vp =
          ol2Active && olm.viewPortDiv && olm.viewPortDiv.nodeType === 1
            ? olm.viewPortDiv
            : getOl6MapViewportDom(olm);
        if (!vp || typeof vp.getBoundingClientRect !== 'function') {
          hideAddressHover();
          return;
        }
        const r = vp.getBoundingClientRect();
        const cx = domEv.clientX;
        const cy = domEv.clientY;
        if (cx == null || cy == null || r.width <= 0 || r.height <= 0) {
          hideAddressHover();
          return;
        }
        if (cx < r.left || cx > r.right || cy < r.top || cy > r.bottom) {
          hideAddressHover();
          return;
        }
        const pixel = mouseEventToMapPixel(olm, domEv, vp);
        if (!pixel) {
          hideAddressHover();
          return;
        }

        let addr = null;
        if (ol6Active) {
          const olGlobal = resolveOl6Global(null);
          const hit = pickNcaFeatureAtPixelOl6(olm, pixel);
          addr = addressFromOl6Feature(hit) || nearestAddressAtPixelOl6(olm, pixel, olGlobal);
        } else if (ol2Active) {
          const hit = pickOl2NcaFeatureAtPixel(addressOl2VectorLayer, pixel);
          addr = hit && hit.attributes ? hit.attributes.ncaAddr : null;
          if (!addr) {
            addr = nearestAddressAtPixelOl2(olm, pixel, lastOl2AddressesForHover);
          }
        }

        const x = domEv.clientX != null ? domEv.clientX : 0;
        const y = domEv.clientY != null ? domEv.clientY : 0;
        if (!addr) {
          hideAddressHover();
          return;
        }
        showAddressHover(x, y, hoverLabelFromAddress(addr));
      });
    }
    win.addEventListener('mousemove', onDocMove, { capture: true, passive: true });
    win.addEventListener('blur', hideAddressHover, true);
  }

  /**
   * OL2 maps have no `map.on('singleclick')`; `featureclick` on the vector layer often never fires in WME.
   * Use capture-phase window click + viewport hit-test (same pixels as hover).
   * OL6 keeps using `singleclick` only — this handler bails when an OL6 address layer is active.
   */
  function bindNcaDocumentMapClick() {
    if (ncaDocumentClickBound) return;
    ncaDocumentClickBound = true;
    const win = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
    win.addEventListener(
      'click',
      function (domEv) {
        if (domEv.button != null && domEv.button !== 0) return;
        try {
          if (domEv.target && typeof domEv.target.closest === 'function') {
            if (domEv.target.closest('#' + SCRIPT_ID + '-root')) return;
          }
        } catch (_) {}
        if (followMapEl && !followMapEl.checked) return;
        const mapW = W();
        if (!mapW || !mapW.map || typeof mapW.map.getOLMap !== 'function') return;
        const olm = mapW.map.getOLMap();
        if (!olm) return;

        const ol6Active =
          lastOl6AddressesForHover.length > 0 &&
          addressOl6VectorLayer &&
          typeof olm.getPixelFromCoordinate === 'function';
        if (ol6Active) return;

        const ol2Active =
          lastOl2AddressesForHover.length > 0 &&
          addressOl2VectorLayer &&
          typeof OpenLayers !== 'undefined' &&
          typeof olm.getPixelFromLonLat === 'function';
        if (!ol2Active) return;

        const vp =
          olm.viewPortDiv && olm.viewPortDiv.nodeType === 1 ? olm.viewPortDiv : getOl6MapViewportDom(olm);
        if (!vp || typeof vp.getBoundingClientRect !== 'function') return;
        const r = vp.getBoundingClientRect();
        const cx = domEv.clientX;
        const cy = domEv.clientY;
        if (cx == null || cy == null || r.width <= 0 || r.height <= 0) return;
        if (cx < r.left || cx > r.right || cy < r.top || cy > r.bottom) return;

        const pixel = mouseEventToMapPixel(olm, domEv, vp);
        if (!pixel) return;
        const hit = pickOl2NcaFeatureAtPixel(addressOl2VectorLayer, pixel);
        let addr = hit && hit.attributes ? hit.attributes.ncaAddr : null;
        if (!addr) {
          addr = nearestAddressAtPixelOl2(olm, pixel, lastOl2AddressesForHover);
        }
        if (!addr) return;
        hideAddressHover();
        try {
          domEv.stopPropagation();
          domEv.preventDefault();
        } catch (_) {}
        createVenueFromAddressClick(addr);
      },
      true,
    );
  }

  function installOl6AddressInteractions(olm) {
    if (addressOl6InteractionsInstalled || typeof olm.on !== 'function') return;
    addressOl6InteractionsInstalled = true;

    bindNcaDocumentViewportHover();

    olm.on('singleclick', function (evt) {
      const olGlobal = resolveOl6Global(null);
      const px = pixelToXYPair(evt.pixel);
      const hit = px ? pickNcaFeatureAtPixelOl6(olm, px) : null;
      let addr = addressFromOl6Feature(hit);
      if (!addr && px) {
        addr = nearestAddressAtPixelOl6(olm, px, olGlobal);
      }
      if (!addr) {
        hideAddressHover();
        return;
      }
      hideAddressHover();
      createVenueFromAddressClick(addr);
    });
  }

  function ensureOl6AddressLayer(olm, olGlobal) {
    if (addressOl6VectorLayer) return;
    try {
      const src = new olGlobal.source.Vector();
      if (!ol6StyleBlue) {
        ol6StyleBlue = new olGlobal.style.Style({
          image: new olGlobal.style.Circle({
            radius: 5,
            fill: new olGlobal.style.Fill({ color: 'rgba(33,150,243,0.92)' }),
            stroke: new olGlobal.style.Stroke({ color: '#ffffff', width: 1 }),
          }),
        });
      }
      if (!ol6StyleRed) {
        ol6StyleRed = new olGlobal.style.Style({
          image: new olGlobal.style.Circle({
            radius: 5,
            fill: new olGlobal.style.Fill({ color: 'rgba(244,67,54,0.92)' }),
            stroke: new olGlobal.style.Stroke({ color: '#ffffff', width: 1 }),
          }),
        });
      }
      addressOl6VectorLayer = new olGlobal.layer.Vector({
        source: src,
        zIndex: 999999,
        style: function (feature) {
          const ok = feature.get('ncaStreetOk');
          return ok === false ? ol6StyleRed : ol6StyleBlue;
        },
      });
      olm.addLayer(addressOl6VectorLayer);
      cachedOl6Global = olGlobal;
      installOl6AddressInteractions(olm);
    } catch (e) {
      console.warn('[NCA addresses] OL6 vector layer:', e);
      addressOl6VectorLayer = null;
    }
  }

  async function fillOl6AddressLayer(olm, olGlobal, addresses, model, wsdk, enableStreetColoring) {
    if (!addressOl6VectorLayer || !addressOl6VectorLayer.getSource || !olm) return;
    const src = addressOl6VectorLayer.getSource();
    const generation = nextLayerRenderGeneration();
    src.clear();
    const view = typeof olm.getView === 'function' ? olm.getView() : null;
    const mapProj = view && view.getProjection ? view.getProjection() : null;
    const entries = [];
    const feats = [];
    for (let i = 0; i < addresses.length; i++) {
      const a = addresses[i];
      if (!Number.isFinite(Number(a.lon)) || !Number.isFinite(Number(a.lat))) continue;
      let xy;
      try {
        xy = mapProj
          ? olGlobal.proj.fromLonLat([Number(a.lon), Number(a.lat)], mapProj)
          : olGlobal.proj.fromLonLat([Number(a.lon), Number(a.lat)]);
      } catch (_) {
        continue;
      }
      if (!xy || !Number.isFinite(xy[0]) || !Number.isFinite(xy[1])) continue;
      const lon = Number(a.lon);
      const lat = Number(a.lat);
      if (enableStreetColoring) {
        const hintRaw = streetLineFromProps((a && a.properties) || {});
        const hintTrim = hintRaw.trim();
        const e = { lon: lon, lat: lat, hintRaw: hintRaw, hintTrim: hintTrim, bestName: null, bestAny: null };
        entries.push(e);
      }
      feats.push(
        new olGlobal.Feature({
          geometry: new olGlobal.geom.Point(xy),
          ncaAddr: a,
          ncaStreetOk: true,
        }),
      );
    }
    if (enableStreetColoring && entries.length && model && olm) {
      accumulateStreetPicksForNcaEntries(entries, model, olm, wsdk);
      for (let j = 0; j < feats.length; j++) {
        const pick = entries[j].hintTrim ? entries[j].bestName : entries[j].bestAny;
        feats[j].set('ncaStreetOk', !!pick);
      }
    }
    await addOl6FeaturesChunked(src, feats, generation);
    if (!isActiveLayerRenderGeneration(generation)) return;
    lastOl6AddressesForHover = addresses.slice();
  }

  function ensureOl2AddressLayer(olm) {
    if (addressOl2VectorLayer || typeof OpenLayers === 'undefined') return;
    try {
      const defStyle = new OpenLayers.Style({
        pointRadius: 5,
        fillColor: '${markerFill}',
        fillOpacity: 0.9,
        strokeColor: '#ffffff',
        strokeWidth: 1,
      });
      const styleMap = new OpenLayers.StyleMap({
        default: defStyle,
      });
      addressOl2VectorLayer = new OpenLayers.Layer.Vector(SCRIPT_ID + '-layer', {
        styleMap: styleMap,
        /** Prefer Canvas for many points: lower DOM overhead than SVG during pan. */
        renderers: ['Canvas', 'SVG', 'VML'],
        displayInLayerSwitcher: false,
      });
      olm.addLayer(addressOl2VectorLayer);
      bindNcaDocumentViewportHover();
      bindNcaDocumentMapClick();
    } catch (e) {
      console.warn('[NCA addresses] OL2 vector layer:', e);
      addressOl2VectorLayer = null;
    }
  }

  function setAddressLayersVisible(visible) {
    const v = !!visible;
    try {
      if (addressOl6VectorLayer && typeof addressOl6VectorLayer.setVisible === 'function') {
        addressOl6VectorLayer.setVisible(v);
      }
    } catch (_) {}
    try {
      if (addressOl2VectorLayer && typeof addressOl2VectorLayer.setVisibility === 'function') {
        addressOl2VectorLayer.setVisibility(v);
      }
    } catch (_) {}
  }

  async function fillOl2AddressLayer(olm, addresses, model, wsdk, enableStreetColoring) {
    if (!addressOl2VectorLayer || !addressOl2VectorLayer.destroyFeatures) return;
    const generation = nextLayerRenderGeneration();
    addressOl2VectorLayer.destroyFeatures();
    lastOl2AddressesForHover = [];
    const proj =
      typeof olm.getProjectionObject === 'function'
        ? olm.getProjectionObject()
        : olm.projection;
    if (!proj) return;
    const wgs = new OpenLayers.Projection('EPSG:4326');
    const entries = [];
    const feats = [];
    for (let i = 0; i < addresses.length; i++) {
      const a = addresses[i];
      if (!Number.isFinite(Number(a.lon)) || !Number.isFinite(Number(a.lat))) continue;
      const lon = Number(a.lon);
      const lat = Number(a.lat);
      if (enableStreetColoring) {
        const hintRaw = streetLineFromProps((a && a.properties) || {});
        const hintTrim = hintRaw.trim();
        entries.push({ lon: lon, lat: lat, hintRaw: hintRaw, hintTrim: hintTrim, bestName: null, bestAny: null });
      }
      const ll = new OpenLayers.LonLat(Number(a.lon), Number(a.lat)).transform(wgs, proj);
      const geom = new OpenLayers.Geometry.Point(ll.lon, ll.lat);
      feats.push(new OpenLayers.Feature.Vector(geom, { ncaAddr: a, markerFill: '#2196F3' }));
    }
    if (enableStreetColoring && entries.length && model && olm) {
      accumulateStreetPicksForNcaEntries(entries, model, olm, wsdk);
      for (let j = 0; j < feats.length; j++) {
        const pick = entries[j].hintTrim ? entries[j].bestName : entries[j].bestAny;
        feats[j].attributes.markerFill = pick ? '#2196F3' : '#f44336';
      }
    }
    await addOl2FeaturesChunked(addressOl2VectorLayer, feats, generation);
    if (!isActiveLayerRenderGeneration(generation)) return;
    lastOl2AddressesForHover = addresses.slice();
  }

  async function applyAddressesToMapLayer(data) {
    try {
      let addresses = (data && data.addresses) || [];
      const totalAddresses = addresses.length;
      const zNow = getMapZoomLevel();
      const markerCap = maxRenderedMarkersForZoom(zNow);
      const capped = totalAddresses > markerCap;
      if (capped) {
        addresses = addresses.slice(0, markerCap);
      }
      ncaHoverLiteMode = addresses.length > NCA_DISABLE_HOVER_OVER_POINTS;
      const mapW = W();
      if (!mapW || !mapW.map || typeof mapW.map.getOLMap !== 'function') {
        setStatus('Map not ready.');
        return;
      }
      const olm = mapW.map.getOLMap();
      if (!olm) {
        setStatus('OpenLayers map unavailable.');
        return;
      }

      if (hideDupResidentialOverlayEl && hideDupResidentialOverlayEl.checked) {
        await ensureSdkReady();
        addresses = await filterNcaAddressesOverlappingResidentialPoi(addresses);
      }

      const olGlobal = pageWin().ol;
      const isOl6 =
        olGlobal &&
        typeof olm.getView === 'function' &&
        olGlobal.Feature &&
        olGlobal.geom &&
        olGlobal.geom.Point &&
        olGlobal.proj &&
        olGlobal.proj.fromLonLat;

      const enableStreetColoring = addresses.length <= NCA_STREET_COLOR_MAX_ADDRESSES;
      let wsdkForLayer = null;
      let modelForLayer = null;
      if (enableStreetColoring) {
        await ensureSdkReady();
        wsdkForLayer =
          typeof pageWin().getWmeSdk === 'function'
            ? pageWin().getWmeSdk({ scriptId: SCRIPT_ID, scriptName: SCRIPT_NAME })
            : sdk;
        modelForLayer = mapW && mapW.model;
      }

      if (isOl6) {
        ensureOl6AddressLayer(olm, olGlobal);
        if (addressOl6VectorLayer) {
          await fillOl6AddressLayer(
            olm,
            olGlobal,
            addresses,
            modelForLayer,
            wsdkForLayer,
            enableStreetColoring,
          );
          setStatus(
            addresses.length === 0
              ? 'No addresses in view.'
              : String(addresses.length) +
                  ' address(es) on map.' +
                  (capped ? ' Render cap: ' + markerCap + ' of ' + totalAddresses + '.' : '') +
                  (ncaHoverLiteMode ? ' Lite hover mode (tooltip hit-test reduced).' : '') +
                  (addresses.length > NCA_STREET_COLOR_MAX_ADDRESSES
                    ? ' Fast mode: no-street red coloring is limited for large sets.'
                    : ''),
          );
          return;
        }
      }

      ensureOl2AddressLayer(olm);
      if (addressOl2VectorLayer) {
        await fillOl2AddressLayer(olm, addresses, modelForLayer, wsdkForLayer, enableStreetColoring);
        setStatus(
          addresses.length === 0
            ? 'No addresses in view.'
            : String(addresses.length) +
                ' address(es) on map.' +
                (capped ? ' Render cap: ' + markerCap + ' of ' + totalAddresses + '.' : '') +
                (ncaHoverLiteMode ? ' Lite hover mode (tooltip hit-test reduced).' : '') +
                (addresses.length > NCA_STREET_COLOR_MAX_ADDRESSES
                  ? ' Fast mode: no-street red coloring is limited for large sets.'
                  : ''),
        );
        return;
      }

      setStatus('Could not create map layer (OpenLayers API mismatch).');
    } catch (err) {
      console.warn('[NCA addresses] apply layer:', err);
      setStatus((err && err.message) || String(err));
    }
  }

  const debouncedLoadFromViewport = debounce(function () {
    void (async function () {
      try {
        if (!followMapEl || !followMapEl.checked) {
          clearAddressMapFeatures();
          return;
        }
        const z = getMapZoomLevel();
        if (z == null || z < MIN_ZOOM_FOR_BBOX) {
          lastViewportKey = '';
          clearAddressMapFeatures();
          setStatus(
            z == null
              ? 'Map zoom unavailable — layer cleared.'
              : 'Zoom to level ' + MIN_ZOOM_FOR_BBOX + ' or higher to show addresses.',
          );
          return;
        }
        const bbox = await getViewportBBoxLonLatAsync();
        if (!bbox) {
          console.warn('[NCA addresses] No viewport bbox (SDK + OpenLayers fallbacks).');
          setStatus('Viewport bounds unavailable.');
          return;
        }
        const key = viewportBboxKey(z, bbox);
        if (key === lastViewportKey) return;
        if (viewportFetchInFlight) return;
        viewportFetchInFlight = true;
        setStatus('Loading map…');
        try {
          const data = await fetchAddressesInBbox(bbox);
          await applyAddressesToMapLayer(data);
          lastViewportKey = key;
        } catch (e) {
          console.warn('[NCA addresses] bbox:', e);
          lastViewportKey = '';
          clearAddressMapFeatures();
          setStatus((e && e.message) || String(e));
        } finally {
          viewportFetchInFlight = false;
        }
      } catch (outer) {
        console.warn('[NCA addresses] viewport load:', outer);
        viewportFetchInFlight = false;
      }
    })();
  }, 520);

  let mapWatchTries = 0;

  function startMapViewportWatch() {
    if (mapViewportHooksRegistered) return;
    const mapW = W();
    if (!mapW || !mapW.map || typeof mapW.map.getOLMap !== 'function') {
      return;
    }
    const olm = mapW.map.getOLMap();
    if (!olm) return;

    const schedule = function () {
      try {
        debouncedLoadFromViewport();
      } catch (err) {
        console.warn('[NCA addresses] viewport schedule:', err);
      }
    };
    const onMoveStart = function () {
      hideAddressHover();
      /** During drag, hide custom points to avoid expensive vector repaint on each frame. */
      setAddressLayersVisible(false);
    };
    const onMoveEnd = function () {
      setAddressLayersVisible(true);
      schedule();
    };

    /** OL6+: only `moveend` — avoid view `change:*` during WME init (can break map load). */
    try {
      if (typeof olm.on === 'function' && typeof olm.getView === 'function') {
        olm.on('movestart', onMoveStart);
        olm.on('moveend', onMoveEnd);
        mapViewportHooksRegistered = true;
      }
    } catch (e) {
      console.warn('[NCA addresses] OL6 map hooks:', e);
    }

    try {
      if (!mapViewportHooksRegistered && olm.events && typeof olm.events.register === 'function') {
        olm.events.register('movestart', olm, onMoveStart);
        olm.events.register('zoomstart', olm, onMoveStart);
        olm.events.register('moveend', olm, onMoveEnd);
        olm.events.register('zoomend', olm, onMoveEnd);
        mapViewportHooksRegistered = true;
      }
    } catch (e2) {
      console.warn('[NCA addresses] OL2 map hooks:', e2);
    }

    if (mapViewportHooksRegistered) {
      window.setTimeout(schedule, 400);
    }
  }

  function ensureMapViewportWatchLoop() {
    if (mapViewportHooksRegistered || mapWatchTries > 400) return;
    mapWatchTries++;
    startMapViewportWatch();
    if (!mapViewportHooksRegistered) {
      window.setTimeout(ensureMapViewportWatchLoop, 900);
    }
  }

  /** Detect pan/zoom even when OL `moveend` does not fire (poll vs debounced dedupe). */
  function startViewportChangePoll() {
    if (viewportPollTimer != null) return;
    viewportPollTimer = window.setInterval(function () {
      if (!followMapEl || !followMapEl.checked) return;
      if (document.hidden) return;
      if (viewportFetchInFlight || viewportPollBboxInFlight) return;
      const now = Date.now();
      if (now - viewportPollLastRunMs < NCA_VIEWPORT_POLL_MIN_INTERVAL_MS) return;
      const z = getMapZoomLevel();
      if (z == null || z < MIN_ZOOM_FOR_BBOX) return;
      viewportPollBboxInFlight = true;
      viewportPollLastRunMs = now;
      void (async function () {
        try {
          const bbox = await getViewportBBoxLonLatAsync();
          if (!bbox) return;
          const key = viewportBboxKey(z, bbox);
          if (key === lastViewportKey) return;
          debouncedLoadFromViewport();
        } finally {
          viewportPollBboxInFlight = false;
        }
      })();
    }, 1400);
  }

  function buildPanel(tabPane) {
    const root = document.createElement('div');
    root.id = SCRIPT_ID + '-root';

    const hint = document.createElement('div');
    hint.style.cssText = 'font-size:11px;opacity:.85;margin-bottom:8px';
    hint.textContent =
      'nca-scanner (PostGIS). Layer after map loads (zoom ≥ ' +
      MIN_ZOOM_FOR_BBOX +
      '). Hover = address; click = POI + street + house number (SDK) when possible. API: ' +
      DEFAULT_API_BASE;
    root.appendChild(hint);

    const rowApi = document.createElement('div');
    rowApi.className = 'row';
    const lblApi = document.createElement('wz-label');
    lblApi.textContent = 'API base URL';
    rowApi.appendChild(lblApi);
    apiInput = document.createElement('input');
    apiInput.type = 'text';
    apiInput.style.cssText = 'width:100%;box-sizing:border-box;margin:4px 0';
    apiInput.value = storageGet(STORAGE_API_BASE, DEFAULT_API_BASE);
    apiInput.addEventListener('change', function () {
      storageSet(STORAGE_API_BASE, apiInput.value);
    });
    root.appendChild(apiInput);

    const rowFollow = document.createElement('div');
    rowFollow.style.cssText = 'display:flex;align-items:center;gap:6px;margin:4px 0';
    followMapEl = document.createElement('input');
    followMapEl.type = 'checkbox';
    followMapEl.id = SCRIPT_ID + '-follow';
    followMapEl.checked = storageGet(STORAGE_FOLLOW_MAP, '0') === '1';
    followMapEl.addEventListener('change', function () {
      storageSet(STORAGE_FOLLOW_MAP, followMapEl.checked ? '1' : '0');
      if (followMapEl.checked) {
        debouncedLoadFromViewport();
      } else {
        lastViewportKey = '';
        clearAddressMapFeatures();
        setStatus('Layer hidden (follow map off).');
      }
    });
    const followLbl = document.createElement('label');
    followLbl.setAttribute('for', SCRIPT_ID + '-follow');
    followLbl.textContent =
      'Show address layer (viewport bbox; zoom ' + MIN_ZOOM_FOR_BBOX + '+)';
    rowFollow.appendChild(followMapEl);
    rowFollow.appendChild(followLbl);
    root.appendChild(rowFollow);

    const rowHideDup = document.createElement('div');
    rowHideDup.style.cssText = 'display:flex;align-items:flex-start;gap:6px;margin:6px 0';
    hideDupResidentialOverlayEl = document.createElement('input');
    hideDupResidentialOverlayEl.type = 'checkbox';
    hideDupResidentialOverlayEl.id = SCRIPT_ID + '-hideResDup';
    hideDupResidentialOverlayEl.checked =
      storageGet(STORAGE_HIDE_RESIDENTIAL_OVERLAY_DUP, '0') === '1';
    hideDupResidentialOverlayEl.addEventListener('change', function () {
      storageSet(STORAGE_HIDE_RESIDENTIAL_OVERLAY_DUP, hideDupResidentialOverlayEl.checked ? '1' : '0');
      if (followMapEl && followMapEl.checked) {
        lastViewportKey = '';
        debouncedLoadFromViewport();
      }
    });
    const hideDupLbl = document.createElement('label');
    hideDupLbl.setAttribute('for', SCRIPT_ID + '-hideResDup');
    hideDupLbl.style.cssText = 'font-size:12px;line-height:1.35';
    hideDupLbl.textContent =
      'Hide NCA dots when a residential POI has the same house number within ~' +
      NCA_OVERLAY_HIDE_NEAR_RESIDENTIAL_M +
      ' m (no per-street match; cheap check).';
    rowHideDup.appendChild(hideDupResidentialOverlayEl);
    rowHideDup.appendChild(hideDupLbl);
    root.appendChild(rowHideDup);

    statusEl = document.createElement('div');
    statusEl.style.cssText = 'margin-top:8px;font-size:12px';
    statusEl.textContent = '';
    root.appendChild(statusEl);

    tabPane.appendChild(root);
  }

  let initDone = false;

  async function runMain() {
    if (initDone) return;
    const win = pageWin();
    if (!win.SDK_INITIALIZED || typeof win.getWmeSdk !== 'function') return;
    try {
      await win.SDK_INITIALIZED;
      sdk = win.getWmeSdk({ scriptId: SCRIPT_ID, scriptName: SCRIPT_NAME });
      const { tabLabel, tabPane } = await sdk.Sidebar.registerScriptTab();
      tabLabel.textContent = 'NCA addr';
      buildPanel(tabPane);
      window.setTimeout(function () {
        try {
          ensureMapViewportWatchLoop();
          startViewportChangePoll();
        } catch (e) {
          console.warn('[NCA addresses] map watch start:', e);
        }
      }, 4000);
      window.setTimeout(function () {
        try {
          debouncedLoadFromViewport();
        } catch (e2) {
          console.warn('[NCA addresses] initial viewport:', e2);
        }
      }, 4500);
      initDone = true;
    } catch (e) {
      console.error('[NCA addresses] Init error:', e);
    }
  }

  function scheduleRun() {
    runMain().catch(function (e) {
      console.error(e);
    });
  }

  function onDomReady() {
    scheduleRun();
    document.addEventListener('wme-ready', scheduleRun, { once: true });
    window.setTimeout(scheduleRun, 2000);
    window.setTimeout(scheduleRun, 6000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', onDomReady);
  } else {
    onDomReady();
  }
})();
