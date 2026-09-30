/**
 * Fixed Sendbar - extension SillyTavern
 * Garde la barre d'envoi (#form_sheld / #send_form) immobile pendant la saisie multi-lignes.
 *
 * Modes :
 *  - « fixed » (défaut) : #send_textarea garde une hauteur fixe (N lignes) et défile en interne (overflow-y:auto).
 *  - « grow » : la barre reste ancrée en bas et grandit vers le haut jusqu'à N lignes, puis défile en interne.
 *
 * Neutralise l'auto-ajustement du coeur de SillyTavern (autoFitSendTextArea pose style.height à chaque saisie) :
 *  - CSS très spécifique + !important, injecté dans <style id="fixed-sendbar-style"> (toujours en dernier dans <head>) ;
 *  - JS : à chaque saisie on repose style.height (important) ; un MutationObserver sur l'attribut style rétablit la
 *    hauteur juste après toute modification faite par ST (avant le prochain rendu).
 * iOS : --fs-vv-offset (visualViewport) + translateY sur #form_sheld si la barre est position:fixed (no-op si ~0).
 *
 * Vanilla ES module, aucune étape de build.
 * Chemin attendu : /scripts/extensions/third-party/fixed-sendbar/index.js
 */

import * as stScript from '../../../../script.js';
import * as stExtensions from '../../../extensions.js';

const MODULE_NAME = 'fixed-sendbar';
const LOG = '[Fixed Sendbar]';
const STYLE_ID = 'fixed-sendbar-style';
const CLS_ON = 'fs-on';
const CLS_GROW = 'fs-grow';
const CLS_GUARD = 'fs-guard';
const CLS_VV = 'fs-vv';
const VV_EPSILON = 1; // px : en dessous, décalage considéré nul
const SCROLL_GUARD_MS = 1500; // fenêtre après le focus pendant laquelle on surveille le scroll

const MODES = Object.freeze({ fixed: 'fixed', grow: 'grow' });

const defaultSettings = Object.freeze({
    enabled: true,
    mode: MODES.fixed, // 'fixed' | 'grow'
    visibleLines: 3, // hauteur fixe en lignes (mode fixed)
    heightPx: 0, // hauteur fixe en px (mode fixed) ; 0 = calculée à partir des lignes
    maxLines: 6, // hauteur max en lignes (mode grow)
    fixIosViewport: true, // « Corriger le décalage clavier iOS »
    guardScroll: true, // remettre window.scrollY à 0 si la page défile pendant la saisie
});

// ---------------------------------------------------------------------------
// Fonctions pures (testées sous Node)
// ---------------------------------------------------------------------------

function clampNumber(value, fallback, min, max) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, Math.round(n)));
}

/** Interprète line-height calculé (« 20px », « normal », « 1.4 »). */
function parseLineHeight(lineHeight, fontSize) {
    const fs = Number.isFinite(parseFloat(fontSize)) ? parseFloat(fontSize) : 16;
    const raw = String(lineHeight ?? '').trim();
    if (!raw || raw === 'normal') return fs * 1.2;
    const n = parseFloat(raw);
    if (!Number.isFinite(n) || n <= 0) return fs * 1.2;
    return raw.endsWith('px') ? n : n * fs; // nombre sans unité = multiple de font-size
}

/** Hauteur CSS (dans le modèle de boîte du champ) pour `lines` lignes. metrics : { lineHeight, paddingY, borderY, borderBox }. */
function heightForLines(lines, m) {
    const extra = m.borderBox ? (m.paddingY + m.borderY) : 0;
    return Math.round(lines * m.lineHeight + extra);
}

/** Mode fixed : hauteur imposée (heightPx > 0 prioritaire, sinon N lignes). */
function computeFixedHeight(s, m) {
    const px = clampNumber(s.heightPx, 0, 0, 600);
    if (px > 0) return px;
    return heightForLines(clampNumber(s.visibleLines, 3, 1, 12), m);
}

/** Mode grow : hauteur pour un contenu de `scrollHeight`, bornée à [1 ligne, maxLines]. */
function computeGrowHeight(scrollHeight, s, m) {
    const min = heightForLines(1, m);
    const max = Math.max(min, heightForLines(clampNumber(s.maxLines, 6, 1, 30), m));
    // scrollHeight = contenu + padding (sans bordures)
    const wanted = m.borderBox ? scrollHeight + m.borderY : scrollHeight - m.paddingY;
    const height = Math.max(min, Math.min(max, Math.round(wanted)));
    return { height, min, max, overflowing: Math.round(wanted) > max };
}

/** Hauteur cible selon le mode (scrollHeight n'est utilisé qu'en mode grow). */
function computeTargetHeight(s, m, scrollHeight) {
    if (s.mode === MODES.grow) return computeGrowHeight(scrollHeight, s, m).height;
    return computeFixedHeight(s, m);
}

/**
 * Décalage du bas du visualViewport par rapport au bas de la fenêtre (px, entier >= 0).
 * 0 si l'API est absente, si le zoom (pinch) est actif (mesure peu fiable) ou si le décalage est < VV_EPSILON.
 */
function computeVvOffset(innerHeight, vvHeight, vvOffsetTop, vvScale) {
    const ih = Number(innerHeight);
    const h = Number(vvHeight);
    const top = Number(vvOffsetTop) || 0;
    if (!Number.isFinite(ih) || !Number.isFinite(h)) return 0;
    if (Number.isFinite(Number(vvScale)) && Number(vvScale) > 1.01) return 0;
    const off = ih - (h + top);
    if (!(off >= VV_EPSILON)) return 0;
    return Math.round(off);
}

/** Faut-il appliquer la translation ? Seulement si réglage ON, barre position:fixed et décalage > 0. */
function shouldApplyVv(s, position, offset) {
    return !!s.enabled && !!s.fixIosViewport && position === 'fixed' && offset >= VV_EPSILON;
}

/** Faut-il remettre le scroll de la fenêtre à 0 ? */
function shouldResetScroll(s, focused, scrollY) {
    return !!s.enabled && !!s.guardScroll && !!focused && Number(scrollY) > 0;
}

/** Règles CSS (spécificité gonflée par :not(#id) pour battre le thème « iMessage Dark »). */
function buildCss(s) {
    const spec = ':not(#fs_s1):not(#fs_s2)';
    const on = `html.${CLS_ON}`;
    const ta = `html.${CLS_ON} body #send_textarea${spec}`;
    const rules = [];
    const common = 'resize:none !important;overflow-y:auto !important;overflow-x:hidden !important;'
        + '-webkit-overflow-scrolling:touch;overscroll-behavior:contain;box-sizing:border-box !important;';
    if (s.mode === MODES.grow) {
        rules.push(`${ta} {min-height:var(--fs-min-h, 2em) !important;max-height:var(--fs-max-h, 9em) !important;${common}}`);
    } else {
        rules.push(`${ta} {height:var(--fs-h, 4.5em) !important;min-height:var(--fs-h, 4.5em) !important;`
            + `max-height:var(--fs-h, 4.5em) !important;${common}}`);
    }
    // La rangée reste alignée sur le bas : les boutons ne « descendent » / ne montent pas quand le champ change
    rules.push(`${on} body #nonQRFormItems${spec} {align-items:flex-end !important;}`);
    // Pas d'ancrage de défilement automatique du navigateur sur la barre
    rules.push(`${on} body #form_sheld${spec} {overflow-anchor:none;}`);
    rules.push(`html.${CLS_ON}.${CLS_GUARD}, html.${CLS_ON}.${CLS_GUARD} body {overscroll-behavior:none !important;}`);
    // Décalage clavier iOS : uniquement quand la classe fs-vv est posée par index.js (barre fixed + offset > 0)
    rules.push(`html.${CLS_ON}.${CLS_VV} body #form_sheld${spec} {transform:translateY(calc(-1 * var(--fs-vv-offset, 0px))) !important;}`);
    return rules.join('\n');
}

function braceBalance(css) {
    let d = 0;
    for (const c of css) {
        if (c === '{') d++;
        else if (c === '}') { d--; if (d < 0) return false; }
    }
    return d === 0;
}

// ---------------------------------------------------------------------------
// Réglages
// ---------------------------------------------------------------------------

function getSettings() {
    const store = stExtensions.extension_settings;
    if (!store[MODULE_NAME] || typeof store[MODULE_NAME] !== 'object') store[MODULE_NAME] = {};
    const s = store[MODULE_NAME];
    for (const [key, value] of Object.entries(defaultSettings)) {
        if (s[key] === undefined) s[key] = value; // fusion des valeurs par défaut
    }
    for (const k of ['enabled', 'fixIosViewport', 'guardScroll']) s[k] = !!s[k];
    if (s.mode !== MODES.fixed && s.mode !== MODES.grow) s.mode = MODES.fixed;
    s.visibleLines = clampNumber(s.visibleLines, defaultSettings.visibleLines, 1, 12);
    s.heightPx = clampNumber(s.heightPx, 0, 0, 600);
    s.maxLines = clampNumber(s.maxLines, defaultSettings.maxLines, 1, 30);
    return s;
}

function saveSettings() {
    try {
        stScript.saveSettingsDebounced();
    } catch (e) {
        console.warn(LOG, 'saveSettingsDebounced a échoué', e);
    }
}

// ---------------------------------------------------------------------------
// Logique DOM
// ---------------------------------------------------------------------------

const getTextarea = () => document.getElementById('send_textarea');
const getSheld = () => document.getElementById('form_sheld');
const root = () => document.documentElement;

let enforcing = false;
let observer = null;
let observedTa = null;
let listenersBound = false;
let focusedAt = 0;
let vvRaf = 0;

function readMetrics(ta) {
    const cs = getComputedStyle(ta);
    const px = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
    return {
        lineHeight: parseLineHeight(cs.lineHeight, cs.fontSize),
        paddingY: px(cs.paddingTop) + px(cs.paddingBottom),
        borderY: px(cs.borderTopWidth) + px(cs.borderBottomWidth),
        borderBox: cs.boxSizing !== 'content-box',
    };
}

function applyStyle() {
    try {
        const s = getSettings();
        let el = document.getElementById(STYLE_ID);
        if (!el) {
            el = document.createElement('style');
            el.id = STYLE_ID;
            document.head.appendChild(el);
        } else if (el !== document.head.lastElementChild) {
            document.head.appendChild(el); // toujours en dernier
        }
        el.textContent = buildCss(s);
        const r = root();
        r.classList.toggle(CLS_ON, !!s.enabled);
        r.classList.toggle(CLS_GROW, !!s.enabled && s.mode === MODES.grow);
        r.classList.toggle(CLS_GUARD, !!s.enabled && !!s.guardScroll);
    } catch (e) { console.error(LOG, e); }
}

function setHeight(ta, h) {
    const want = `${h}px`;
    if (ta.style.getPropertyValue('height') !== want || ta.style.getPropertyPriority('height') !== 'important') {
        ta.style.setProperty('height', want, 'important');
    }
}

/** Impose la hauteur du champ (selon le mode) et met à jour les variables CSS. */
function enforce() {
    if (enforcing) return;
    const ta = getTextarea();
    if (!ta) return;
    const s = getSettings();
    enforcing = true;
    try {
        if (!s.enabled) return;
        const m = readMetrics(ta);
        const r = root();
        const min = heightForLines(1, m);
        const max = Math.max(min, heightForLines(s.maxLines, m));
        const fixed = computeFixedHeight(s, m);
        r.style.setProperty('--fs-h', `${fixed}px`);
        r.style.setProperty('--fs-min-h', `${min}px`);
        r.style.setProperty('--fs-max-h', `${max}px`);
        if (s.mode === MODES.grow) {
            // Mesure : on ramène à 1 ligne puis on lit scrollHeight (pas de rendu entre les deux)
            ta.style.setProperty('height', `${min}px`, 'important');
            const g = computeGrowHeight(ta.scrollHeight, s, m);
            setHeight(ta, g.height);
        } else {
            setHeight(ta, fixed);
        }
    } catch (e) {
        console.error(LOG, 'enforce a échoué', e);
    } finally {
        enforcing = false;
        if (observer) observer.takeRecords(); // ignore nos propres mutations
    }
}

function releaseHeight() {
    const ta = getTextarea();
    if (ta) ta.style.removeProperty('height');
    const r = root();
    for (const v of ['--fs-h', '--fs-min-h', '--fs-max-h', '--fs-vv-offset']) r.style.removeProperty(v);
    r.classList.remove(CLS_VV);
}

function observeTextarea() {
    const ta = getTextarea();
    if (!ta || ta === observedTa || typeof MutationObserver === 'undefined') return;
    if (observer) observer.disconnect();
    observedTa = ta;
    // ST (autoFitSendTextArea) modifie style.height : on le rétablit aussitôt, avant le rendu.
    observer = new MutationObserver(() => { if (!enforcing && getSettings().enabled) enforce(); });
    observer.observe(ta, { attributes: true, attributeFilter: ['style', 'rows'] });
}

// --- iOS : visualViewport ---------------------------------------------------

function updateVv() {
    try {
        const s = getSettings();
        const r = root();
        const vv = globalThis.visualViewport;
        const sheld = getSheld();
        let offset = 0;
        let position = '';
        if (s.enabled && s.fixIosViewport && vv && sheld) {
            offset = computeVvOffset(globalThis.innerHeight, vv.height, vv.offsetTop, vv.scale);
            position = getComputedStyle(sheld).position;
        }
        if (shouldApplyVv(s, position, offset)) {
            r.style.setProperty('--fs-vv-offset', `${offset}px`);
            r.classList.add(CLS_VV);
        } else {
            r.classList.remove(CLS_VV);
            r.style.setProperty('--fs-vv-offset', '0px');
        }
    } catch (e) { console.error(LOG, 'updateVv a échoué', e); }
}

function scheduleVv() {
    if (vvRaf) return;
    const raf = globalThis.requestAnimationFrame || ((f) => setTimeout(f, 16));
    vvRaf = raf(() => { vvRaf = 0; updateVv(); });
}

// --- Écouteurs --------------------------------------------------------------

function refreshAll() {
    applyStyle();
    observeTextarea();
    enforce();
    scheduleVv();
}

function bindListeners() {
    if (listenersBound) return;
    listenersBound = true;
    const isTa = (t) => !!t && t.id === 'send_textarea';

    // Capture : notre passage a lieu avant les handlers de ST (phase cible) ; on repasse donc aussi juste après
    // (microtâche + setTimeout 0) et le MutationObserver rattrape toute modification de style.height par ST.
    const onInput = (e) => {
        if (!isTa(e.target)) return;
        enforce();
        Promise.resolve().then(enforce);
        setTimeout(enforce, 0);
    };
    for (const type of ['input', 'keyup', 'change', 'cut', 'paste', 'compositionend']) {
        document.addEventListener(type, onInput, true);
    }
    document.addEventListener('keydown', (e) => {
        if (isTa(e.target) && e.key === 'Enter') setTimeout(enforce, 0);
    }, true);
    document.addEventListener('click', (e) => {
        if (e.target && e.target.closest && e.target.closest('#send_but')) { setTimeout(enforce, 60); setTimeout(enforce, 300); }
    }, true);
    document.addEventListener('focusin', (e) => {
        if (!isTa(e.target)) return;
        focusedAt = Date.now();
        observeTextarea();
        enforce();
        scheduleVv();
    });
    document.addEventListener('focusout', (e) => {
        if (!isTa(e.target)) return;
        setTimeout(() => { enforce(); scheduleVv(); }, 100);
    });
    globalThis.addEventListener('resize', () => { enforce(); scheduleVv(); });
    globalThis.addEventListener('orientationchange', () => setTimeout(() => { enforce(); scheduleVv(); }, 250));
    // Garde-fou de défilement : si la page défile alors que le champ a le focus, on revient à 0.
    globalThis.addEventListener('scroll', () => {
        const ta = getTextarea();
        const focused = !!ta && document.activeElement === ta;
        if (shouldResetScroll(getSettings(), focused, globalThis.scrollY)) {
            globalThis.scrollTo(0, 0);
        }
        scheduleVv();
    }, { passive: true });
    if (globalThis.visualViewport) {
        globalThis.visualViewport.addEventListener('resize', () => { scheduleVv(); });
        globalThis.visualViewport.addEventListener('scroll', () => { scheduleVv(); });
    }
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => enforce()).catch(() => {});
}

// ---------------------------------------------------------------------------
// Panneau de réglages
// ---------------------------------------------------------------------------

function buildSettingsHtml() {
    return `
<div id="fixed_sendbar_settings" class="extension_container">
  <div class="inline-drawer">
    <div class="inline-drawer-toggle inline-drawer-header">
      <b>Fixed Sendbar</b>
      <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
    </div>
    <div class="inline-drawer-content">
      <div class="fs-block">
        <label class="checkbox_label"><input type="checkbox" id="fs_enabled"><span>Activer Fixed Sendbar</span></label>
        <div class="fs-hint">Empêche la barre d'envoi de bouger quand vous écrivez plusieurs lignes.</div>
      </div>
      <div class="fs-row">
        <label for="fs_mode">Mode</label>
        <select id="fs_mode" class="text_pole">
          <option value="fixed">Hauteur fixe (défilement interne)</option>
          <option value="grow">Grandit vers le haut jusqu'à N lignes</option>
        </select>
      </div>
      <div class="fs-row" id="fs_row_lines">
        <label for="fs_lines">Lignes visibles (hauteur fixe)</label>
        <input type="number" id="fs_lines" class="text_pole" min="1" max="12" step="1">
      </div>
      <div class="fs-row" id="fs_row_px">
        <label for="fs_px">Hauteur en px (0 = selon les lignes)</label>
        <input type="number" id="fs_px" class="text_pole" min="0" max="600" step="1">
      </div>
      <div class="fs-row" id="fs_row_max">
        <label for="fs_max">Lignes max (mode « grandit vers le haut »)</label>
        <input type="number" id="fs_max" class="text_pole" min="1" max="30" step="1">
      </div>
      <div class="fs-block">
        <label class="checkbox_label"><input type="checkbox" id="fs_vv"><span>Corriger le décalage clavier iOS</span></label>
        <div class="fs-hint">Ancre la barre au bas de la zone visible (visualViewport) quand le clavier s'ouvre. Sans effet si le décalage est nul ou si la barre n'est pas en position fixe.</div>
      </div>
      <div class="fs-block">
        <label class="checkbox_label"><input type="checkbox" id="fs_guard"><span>Bloquer le défilement de la page pendant la saisie</span></label>
        <div class="fs-hint">Remet la page à 0 si elle défile alors que le champ a le focus.</div>
      </div>
      <hr>
      <div class="menu_button" id="fs_reset">Réinitialiser les réglages</div>
    </div>
  </div>
</div>`;
}

function syncUi() {
    const $ = globalThis.jQuery;
    const s = getSettings();
    $('#fs_enabled').prop('checked', s.enabled);
    $('#fs_mode').val(s.mode);
    $('#fs_lines').val(s.visibleLines);
    $('#fs_px').val(s.heightPx);
    $('#fs_max').val(s.maxLines);
    $('#fs_vv').prop('checked', s.fixIosViewport);
    $('#fs_guard').prop('checked', s.guardScroll);
    const grow = s.mode === MODES.grow;
    $('#fs_row_lines, #fs_row_px').toggleClass('fs-off', grow);
    $('#fs_row_max').toggleClass('fs-off', !grow);
}

function bindUi() {
    const $ = globalThis.jQuery;
    const s = getSettings();
    const change = () => {
        saveSettings();
        if (!s.enabled) { applyStyle(); releaseHeight(); } else { refreshAll(); }
        syncUi();
    };
    $('#fs_enabled').on('change', function () { s.enabled = !!$(this).prop('checked'); change(); });
    $('#fs_mode').on('change', function () { s.mode = $(this).val() === MODES.grow ? MODES.grow : MODES.fixed; change(); });
    $('#fs_lines').on('input change', function () { s.visibleLines = clampNumber($(this).val(), defaultSettings.visibleLines, 1, 12); saveSettings(); refreshAll(); });
    $('#fs_px').on('input change', function () { s.heightPx = clampNumber($(this).val(), 0, 0, 600); saveSettings(); refreshAll(); });
    $('#fs_max').on('input change', function () { s.maxLines = clampNumber($(this).val(), defaultSettings.maxLines, 1, 30); saveSettings(); refreshAll(); });
    $('#fs_vv').on('change', function () { s.fixIosViewport = !!$(this).prop('checked'); saveSettings(); updateVv(); });
    $('#fs_guard').on('change', function () { s.guardScroll = !!$(this).prop('checked'); saveSettings(); applyStyle(); });
    $('#fs_reset').on('click', () => {
        try {
            stExtensions.extension_settings[MODULE_NAME] = {};
            getSettings();
            $('#fixed_sendbar_settings').remove();
            mountSettings();
            saveSettings();
            refreshAll();
        } catch (e) { console.error(LOG, e); }
    });
}

function mountSettings() {
    const $ = globalThis.jQuery;
    if (!$ || $('#fixed_sendbar_settings').length) return;
    const host = $('#extensions_settings2').length ? $('#extensions_settings2') : $('#extensions_settings');
    if (!host.length) {
        console.warn(LOG, 'Conteneur des réglages introuvable.');
        return;
    }
    host.append(buildSettingsHtml());
    syncUi();
    bindUi();
}

// ---------------------------------------------------------------------------
// Initialisation
// ---------------------------------------------------------------------------

function init() {
    try {
        getSettings(); // fusionne les valeurs par défaut
        applyStyle();
        mountSettings();
        bindListeners();
        observeTextarea();
        enforce();
        updateVv();
        // Un autre thème/extension peut injecter son CSS plus tard : on se remet en dernier dans <head>.
        setTimeout(refreshAll, 1500);
        setTimeout(refreshAll, 4000);

        const { eventSource, event_types } = stScript;
        if (eventSource && event_types) {
            const later = () => { try { setTimeout(refreshAll, 50); } catch (e) { console.error(LOG, e); } };
            for (const k of ['CHAT_CHANGED', 'MESSAGE_SENT', 'GENERATION_ENDED', 'SETTINGS_UPDATED']) {
                if (event_types[k]) eventSource.on(event_types[k], later);
            }
        }
        console.log(LOG, 'chargé');
    } catch (e) {
        console.error(LOG, 'Initialisation échouée (chat non affecté)', e);
    }
}

if (globalThis.jQuery) {
    globalThis.jQuery(() => init());
} else {
    init();
}

// Exposé uniquement pour les tests Node (sans effet dans SillyTavern)
export const __test = {
    MODES, defaultSettings, clampNumber, parseLineHeight, heightForLines, computeFixedHeight, computeGrowHeight,
    computeTargetHeight, computeVvOffset, shouldApplyVv, shouldResetScroll, buildCss, braceBalance,
    getSettings, applyStyle, enforce, updateVv, observeTextarea, releaseHeight,
};
