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
 * iOS (1.0) : --fs-vv-offset (visualViewport) + translateY sur #form_sheld si la barre est position:fixed (no-op si ~0).
 * iOS (1.1, « Mode compatibilité iOS renforcé ») : tant que le champ a le focus, la barre est ancrée au bas du
 *   visualViewport en coordonnées du layout viewport (top = offsetTop + height - hauteurBarre, bottom:auto, inline
 *   !important) ; boucle rAF (~60 fps) + événements ; la page est ramenée à scrollY = 0 ; retrait des overrides au blur.
 *
 * 1.2.0 : CAUSE RACINE iOS — le CSS du coeur de ST `html{transform:translateZ(0);perspective:1000;backface-visibility:hidden}` fait de <html>
 *   le bloc conteneur des position:fixed : avec un thème qui force #form_sheld{position:fixed}, la barre suit le défilement du document
 *   (que iOS déclenche à chaque saut de ligne). Quand la barre est fixed, on neutralise ces propriétés sur <html> ET sur tous les ancêtres de la barre (classe fs-fixed + inline !important).
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
const CLS_IOS = 'fs-ios';
const CLS_FIXED = 'fs-fixed'; // posée quand #form_sheld est position:fixed (thème) : neutralise le bloc conteneur créé par <html>
const LOOP_MIN_MS = 15; // plafond ~60 fps pour la boucle rAF
const DEBUG_ID = 'fs_debug';
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
    iosStrong: true, // « Mode compatibilité iOS renforcé » : ancrage visualViewport + contre-scroll (boucle rAF)
    blockScrollIntoView: true, // « Bloquer scrollIntoView du champ » (+ focus() avec preventScroll)
    debug: false, // « Afficher le debug » : petit overlay de diagnostic
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

/**
 * Position `top` (px, coordonnées du layout viewport) qui colle le bas de la barre au bas du visualViewport :
 * top = offsetTop + height - hauteurBarre. null si les entrées sont invalides.
 */
function computeAnchorTop(vvOffsetTop, vvHeight, barHeight) {
    const top = Number(vvOffsetTop) || 0;
    const h = Number(vvHeight);
    const b = Number(barHeight);
    if (!Number.isFinite(h) || !Number.isFinite(b) || b <= 0) return null;
    return Math.max(0, Math.round(top + h - b));
}

/**
 * Décision d'ancrage. m : { innerHeight, vvHeight, vvOffsetTop, vvScale, barHeight, position }.
 * No-op (apply:false) si réglages OFF, champ sans focus, barre non fixed, zoom pinch, ou écart (gap) ~0
 * (dans ce cas `bottom:0` du thème est déjà correct).
 */
function computeAnchor(s, focused, m) {
    const none = { apply: false, top: null, gap: 0 };
    if (!(s && s.enabled && s.iosStrong && focused && m && m.position === 'fixed')) return none;
    const gap = computeVvOffset(m.innerHeight, m.vvHeight, m.vvOffsetTop, m.vvScale);
    if (gap < VV_EPSILON) return { apply: false, top: null, gap };
    const top = computeAnchorTop(m.vvOffsetTop, m.vvHeight, m.barHeight);
    if (top === null) return { apply: false, top: null, gap };
    return { apply: true, top, gap };
}

/** Le contre-scroll renforcé est-il actif ? (mode renforcé + option de blocage du défilement) */
function shouldCounterScroll(s, focused, scrollY, docTop, bodyTop) {
    if (!(s && s.enabled && s.iosStrong && s.guardScroll && focused)) return false;
    return Number(scrollY) !== 0 || Number(docTop) > 0 || Number(bodyTop) > 0;
}

/** Après Entrée : le curseur est-il en fin de texte (=> faire défiler le champ lui-même vers le bas) ? */
function shouldStickBottom(selStart, selEnd, length) {
    return Number(selStart) === Number(length) && Number(selEnd) === Number(length);
}

/** Bloquer scrollIntoView()/focus() de la page sur le champ d'envoi ? */
function shouldBlockScroll(s, target, ta, focused, sinceFocusMs) {
    if (!(s && s.enabled && s.blockScrollIntoView) || !target || target !== ta) return false;
    return !!focused || Number(sinceFocusMs) < SCROLL_GUARD_MS;
}

/** Texte de l'overlay de debug. d : { scrollY, vvTop, vvHeight, innerHeight, barTop, barBottom, anchored, anchorTop, gap, focused }. */
function formatDebug(d) {
    const n = (v) => (Number.isFinite(Number(v)) ? String(Math.round(Number(v) * 10) / 10) : '?');
    return [
        `scrollY ${n(d.scrollY)}  inner ${n(d.innerHeight)}`,
        `vv.top ${n(d.vvTop)}  vv.h ${n(d.vvHeight)}`,
        `bar top ${n(d.barTop)}  bot ${n(d.barBottom)}`,
        `focus ${d.focused ? 1 : 0}  anchor ${d.anchored ? n(d.anchorTop) : '-'}  gap ${n(d.gap)}`,
    ].join('\n');
}

/** Règles CSS (spécificité gonflée par :not(#id) pour battre le thème « iMessage Dark »). */
function buildCss(s) {
    const spec = ':not(#fs_s1):not(#fs_s2)';
    const on = `html.${CLS_ON}`;
    const ta = `html.${CLS_ON} body #form_sheld #send_form #send_textarea${spec}, html.${CLS_ON} body #send_textarea${spec}`;
    const rules = [];
    const common = 'field-sizing:fixed !important;scroll-padding:0 !important;resize:none !important;overflow-y:auto !important;overflow-x:hidden !important;'
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
    // Mode iOS renforcé : pas de rebond / chaînage de scroll ; height:100% à spécificité 0 (:where) pour ne jamais écraser le thème / ST
    rules.push(`html.${CLS_ON}.${CLS_IOS}, html.${CLS_ON}.${CLS_IOS} body {overscroll-behavior:none !important;}`);
    rules.push(`:where(html.${CLS_ON}.${CLS_IOS}, html.${CLS_ON}.${CLS_IOS} body) {height:100%;}`);
    // 1.2.0 : cause racine. ST pose `html{transform:translateZ(0);perspective:1000;backface-visibility:hidden}` : <html> devient le
    // bloc conteneur des éléments position:fixed. Avec un thème qui force #form_sheld en fixed, la barre n'est donc PAS fixée au
    // viewport mais à <html> : elle défile avec le document, et iOS fait défiler le document à chaque saut de ligne (clavier).
    // On neutralise ces propriétés sur <html> (seulement si la barre est fixed) : fixed redevient vraiment relatif au viewport.
    rules.push(`html.${CLS_ON}.${CLS_FIXED}, html.${CLS_ON}.${CLS_FIXED}:not(#fs_s1):not(#fs_s2) {transform:none !important;`
        + '-webkit-transform:none !important;perspective:none !important;-webkit-perspective:none !important;'
        + 'backface-visibility:visible !important;-webkit-backface-visibility:visible !important;'
        + 'filter:none !important;will-change:auto !important;contain:none !important;}');
    // Le décalage vertical d'origine des ancêtres (ex. wrapper translateY(-12px)) est reporté sur la barre
    rules.push(`html.${CLS_ON}.${CLS_FIXED} body #form_sheld${spec} {transform:translateY(var(--fs-anc-ty, 0px)) !important;}`);
    // Décalage clavier iOS : uniquement quand la classe fs-vv est posée par index.js (barre fixed + offset > 0)
    rules.push(`html.${CLS_ON}.${CLS_VV} body #form_sheld${spec} {transform:translateY(calc(var(--fs-anc-ty, 0px) - var(--fs-vv-offset, 0px))) !important;}`);
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
    for (const k of ['enabled', 'fixIosViewport', 'guardScroll', 'iosStrong', 'blockScrollIntoView', 'debug']) s[k] = !!s[k];
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
let taFocused = false;
let anchored = false;
let anchorTop = null;
let lastGap = 0;
let savedInline = null;
let loopId = 0;
let lastTick = 0;

const isFocused = () => {
    if (taFocused) return true;
    const ta = getTextarea();
    return !!ta && document.activeElement === ta;
};

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
        r.classList.toggle(CLS_IOS, !!s.enabled && !!s.iosStrong);
        syncFixedClass();
    } catch (e) { console.error(LOG, e); }
}

/** Vrai si #form_sheld est position:fixed (thème « iMessage Dark »...). */
function isSheldFixed() {
    try {
        const sheld = getSheld();
        return !!sheld && getComputedStyle(sheld).position === 'fixed';
    } catch (e) { return false; }
}

// Propriétés qui font d'un ancêtre le bloc conteneur des descendants position:fixed (le fixed ne suit alors plus le viewport).
const CB_NEUTRAL = Object.freeze({
    'transform': 'none', '-webkit-transform': 'none', 'perspective': 'none', '-webkit-perspective': 'none',
    'filter': 'none', '-webkit-filter': 'none', 'backdrop-filter': 'none', '-webkit-backdrop-filter': 'none',
    'will-change': 'auto', 'contain': 'none', 'container-type': 'normal',
});
const cbTouched = new Map(); // élément -> { saved: {prop: [valeur, priorité]}, ty: translateY d'origine }

/** translateY (px) d'une matrice calculée « matrix(a,b,c,d,e,f) » / « matrix3d(...) » ; 0 si aucune. */
function parseTranslateY(transform) {
    const t = String(transform || '');
    let m = /^matrix\(([^)]+)\)$/.exec(t);
    if (m) { const f = Number(m[1].split(',')[5]); return Number.isFinite(f) ? f : 0; }
    m = /^matrix3d\(([^)]+)\)$/.exec(t);
    if (m) { const f = Number(m[1].split(',')[13]); return Number.isFinite(f) ? f : 0; }
    return 0;
}

/** Cet ancêtre crée-t-il un bloc conteneur pour position:fixed ? (cs = getComputedStyle) */
function createsFixedContainingBlock(cs) {
    const no = (v) => !v || v === 'none' || v === 'auto' || v === 'normal';
    if (!no(cs.transform) || !no(cs.perspective) || !no(cs.filter) || !no(cs.backdropFilter || cs.webkitBackdropFilter)) return true;
    if (/(transform|perspective|filter)/.test(cs.willChange || '')) return true;
    if (/(paint|layout|strict|content)/.test(cs.contain || '')) return true;
    if (cs.containerType && cs.containerType !== 'normal' && /size|inline-size/.test(cs.containerType)) return true;
    return false;
}

function releaseAncestors() {
    for (const [el, info] of cbTouched) {
        for (const p of Object.keys(CB_NEUTRAL)) {
            const [val, prio] = info.saved[p] || ['', ''];
            if (val) el.style.setProperty(p, val, prio || ''); else el.style.removeProperty(p);
        }
    }
    cbTouched.clear();
    root().style.removeProperty('--fs-anc-ty');
}

/**
 * 1.2.0 (cause racine iOS) : quand #form_sheld est position:fixed (thème « iMessage Dark »), tout ancêtre (html, body, #sheld,
 * wrapper du thème...) qui a transform / perspective / filter / backdrop-filter / will-change / contain en devient le bloc
 * conteneur : la barre suit alors le DÉFILEMENT DU DOCUMENT (que iOS déclenche à chaque saut de ligne) au lieu du viewport.
 * On neutralise ces propriétés sur les ancêtres (inline !important, donc plus fort que n'importe quel thème) et on reporte le
 * translateY d'origine sur la barre elle-même (variable --fs-anc-ty) pour garder le décalage visuel voulu (ex. -12px).
 * Classe fs-fixed sur <html> tant que c'est actif. Retourne true si l'état a changé.
 */
function syncFixedClass() {
    try {
        const s = getSettings();
        const r = root();
        const sheld = getSheld();
        const want = !!s.enabled && !!sheld && isSheldFixed();
        const had = r.classList.contains(CLS_FIXED);
        if (!want) {
            if (had) r.classList.remove(CLS_FIXED);
            if (cbTouched.size) releaseAncestors();
            return had !== want;
        }
        if (!had) r.classList.add(CLS_FIXED);
        for (let el = sheld.parentElement; el; el = el.parentElement) {
            let info = cbTouched.get(el);
            if (!info) {
                if (!createsFixedContainingBlock(getComputedStyle(el))) continue;
                info = { saved: {}, ty: parseTranslateY(getComputedStyle(el).transform) };
                for (const p of Object.keys(CB_NEUTRAL)) info.saved[p] = [el.style.getPropertyValue(p), el.style.getPropertyPriority(p)];
                cbTouched.set(el, info);
            }
            for (const [p, v] of Object.entries(CB_NEUTRAL)) {
                if (el.style.getPropertyValue(p) !== v || el.style.getPropertyPriority(p) !== 'important') el.style.setProperty(p, v, 'important');
            }
        }
        let ty = 0;
        for (const info of cbTouched.values()) ty += info.ty;
        const want_ty = `${Math.round(ty * 10) / 10}px`;
        if (r.style.getPropertyValue('--fs-anc-ty') !== want_ty) r.style.setProperty('--fs-anc-ty', want_ty);
        return had !== want;
    } catch (e) { console.error(LOG, 'syncFixedClass a échoué', e); return false; }
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
    r.classList.remove(CLS_IOS);
    syncFixedClass(); // enabled=false => retire fs-fixed et les overrides inline de <html>
    releaseAnchor();
    stopLoop();
    updateDebug();
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

// Un autre script (ex. sendbar-mover, sur 'resize') peut effacer notre top/bottom inline : on le rétablit avant le rendu
// (sinon la barre s'étire d'une image sur toute la hauteur : top fixé + bottom:0 du thème).
let sheldObserver = null;
let observedSheld = null;
function observeSheld() {
    const sheld = getSheld();
    if (!sheld || sheld === observedSheld || typeof MutationObserver === 'undefined') return;
    if (sheldObserver) sheldObserver.disconnect();
    observedSheld = sheld;
    sheldObserver = new MutationObserver(() => {
        if (anchored && isFocused()) {
            const want = `${anchorTop}px`;
            const st = sheld.style;
            if (st.getPropertyValue('top') !== want || st.getPropertyValue('bottom') !== 'auto') updateAnchor();
        }
    });
    sheldObserver.observe(sheld, { attributes: true, attributeFilter: ['style'] });
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
        // Mode renforcé : l'ancrage top/bottom remplace l'ancienne translation (sinon double décalage)
        if (s.enabled && s.fixIosViewport && !s.iosStrong && vv && sheld) {
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

// --- iOS renforcé : ancrage visualViewport + contre-scroll ---------------------

function getPageScrollY() {
    const y = Number(globalThis.scrollY ?? globalThis.pageYOffset);
    return Number.isFinite(y) ? y : 0;
}

/** Ramène la page à 0 (window + html + body) si elle a bougé. Retourne true si une correction a eu lieu. */
function resetPageScroll() {
    try {
        const de = document.documentElement;
        const b = document.body;
        const y = getPageScrollY();
        const dt = de ? de.scrollTop : 0;
        const bt = b ? b.scrollTop : 0;
        if (y === 0 && !(dt > 0) && !(bt > 0)) return false;
        if (typeof globalThis.scrollTo === 'function') globalThis.scrollTo(0, 0);
        if (de && de.scrollTop !== 0) de.scrollTop = 0;
        if (b && b.scrollTop !== 0) b.scrollTop = 0;
        return true;
    } catch (e) { return false; }
}

function applyAnchor(sheld, top) {
    const st = sheld.style;
    if (!anchored) {
        savedInline = {
            top: [st.getPropertyValue('top'), st.getPropertyPriority('top')],
            bottom: [st.getPropertyValue('bottom'), st.getPropertyPriority('bottom')],
        };
        anchored = true;
    }
    anchorTop = top;
    const want = `${top}px`;
    if (st.getPropertyValue('top') !== want || st.getPropertyPriority('top') !== 'important') st.setProperty('top', want, 'important');
    if (st.getPropertyValue('bottom') !== 'auto' || st.getPropertyPriority('bottom') !== 'important') st.setProperty('bottom', 'auto', 'important');
}

/** Retire l'override inline (le `bottom:0 !important` du thème s'applique de nouveau). */
function releaseAnchor() {
    if (!anchored) return;
    anchored = false;
    anchorTop = null;
    const sheld = getSheld();
    const saved = savedInline;
    savedInline = null;
    if (!sheld) return;
    for (const prop of ['top', 'bottom']) {
        const [val, prio] = (saved && saved[prop]) || ['', ''];
        if (val) sheld.style.setProperty(prop, val, prio || '');
        else sheld.style.removeProperty(prop);
    }
}

/** Calcule et applique (ou retire) l'ancrage. Appelée par les événements et par la boucle rAF. */
function updateAnchor() {
    try {
        const s = getSettings();
        const vv = globalThis.visualViewport;
        const sheld = getSheld();
        const focused = isFocused();
        syncFixedClass();
        if (!(s.enabled && s.iosStrong && focused && sheld && vv)) {
            releaseAnchor();
            lastGap = 0;
        } else {
            if (s.guardScroll) resetPageScroll();
            const m = {
                innerHeight: globalThis.innerHeight,
                vvHeight: vv.height,
                vvOffsetTop: vv.offsetTop,
                vvScale: vv.scale,
                barHeight: sheld.offsetHeight,
                position: getComputedStyle(sheld).position,
            };
            const a = computeAnchor(s, focused, m);
            lastGap = a.gap;
            if (a.apply) applyAnchor(sheld, a.top);
            else releaseAnchor();
        }
        updateDebug();
    } catch (e) { console.error(LOG, 'updateAnchor a échoué', e); }
}

function stopLoop() {
    if (!loopId) return;
    const caf = globalThis.cancelAnimationFrame || clearTimeout;
    try { caf(loopId); } catch (e) { /* ignore */ }
    loopId = 0;
}

/** Boucle rAF (plafonnée ~60 fps) tant que le champ a le focus ; s'arrête au blur. */
function startLoop() {
    if (loopId) return;
    const raf = globalThis.requestAnimationFrame || ((f) => setTimeout(() => f(Date.now()), 16));
    const step = (ts) => {
        loopId = 0;
        const s = getSettings();
        if (!(s.enabled && s.iosStrong && isFocused())) { updateAnchor(); return; }
        const now = Number.isFinite(ts) ? ts : Date.now();
        if (now - lastTick >= LOOP_MIN_MS || now < lastTick) {
            lastTick = now;
            updateAnchor();
        }
        loopId = raf(step);
    };
    loopId = raf(step);
}

/** Après Entrée (action par défaut faite) : garder le curseur visible en faisant défiler le champ seulement. */
function keepCaretVisible() {
    try {
        const s = getSettings();
        const ta = getTextarea();
        if (!s.enabled || !ta) return;
        if (shouldStickBottom(ta.selectionStart, ta.selectionEnd, ta.value.length)) ta.scrollTop = ta.scrollHeight;
        if (s.iosStrong && s.guardScroll) resetPageScroll();
        updateAnchor();
    } catch (e) { console.error(LOG, 'keepCaretVisible a échoué', e); }
}

/**
 * Enveloppes (une seule fois) de Element.prototype.scrollIntoView et HTMLElement.prototype.focus : uniquement pour
 * #send_textarea et seulement si le réglage est ON ; tout le reste passe par l'original. Tout est dans try/catch.
 */
function installScrollPatches() {
    try {
        const E = globalThis.Element;
        if (E && E.prototype && typeof E.prototype.scrollIntoView === 'function' && !E.prototype.scrollIntoView.__fsPatched) {
            const orig = E.prototype.scrollIntoView;
            const wrapped = function (...args) {
                try {
                    if (shouldBlockScroll(getSettings(), this, getTextarea(), isFocused(), Date.now() - focusedAt)) return undefined;
                } catch (e) { /* ignore : on retombe sur l'original */ }
                return orig.apply(this, args);
            };
            wrapped.__fsPatched = true;
            E.prototype.scrollIntoView = wrapped;
        }
    } catch (e) { console.warn(LOG, 'patch scrollIntoView impossible', e); }
    try {
        const H = globalThis.HTMLElement;
        if (H && H.prototype && typeof H.prototype.focus === 'function' && !H.prototype.focus.__fsPatched) {
            const origFocus = H.prototype.focus;
            const wrappedFocus = function (...args) {
                try {
                    const s = getSettings();
                    if (s.enabled && s.blockScrollIntoView && this === getTextarea()) {
                        args[0] = Object.assign({}, args[0], { preventScroll: true });
                    }
                } catch (e) { /* ignore */ }
                return origFocus.apply(this, args);
            };
            wrappedFocus.__fsPatched = true;
            H.prototype.focus = wrappedFocus;
        }
    } catch (e) { console.warn(LOG, 'patch focus impossible', e); }
}

// --- Debug ------------------------------------------------------------------

function updateDebug() {
    try {
        const s = getSettings();
        let el = document.getElementById(DEBUG_ID);
        if (!s.debug) {
            if (el) el.remove();
            return;
        }
        if (!el) {
            el = document.createElement('div');
            el.id = DEBUG_ID;
            el.style.cssText = 'position:fixed;top:2px;left:2px;z-index:2147483647;pointer-events:none;'
                + 'background:rgba(0,0,0,.75);color:#0f0;font:10px/1.3 monospace;padding:2px 4px;border-radius:3px;'
                + 'white-space:pre;transform:none;';
            (document.body || document.documentElement).appendChild(el);
        }
        const vv = globalThis.visualViewport;
        const sheld = getSheld();
        const rect = sheld ? sheld.getBoundingClientRect() : { top: NaN, bottom: NaN };
        el.textContent = formatDebug({
            scrollY: getPageScrollY(),
            vvTop: vv ? vv.offsetTop : NaN,
            vvHeight: vv ? vv.height : NaN,
            innerHeight: globalThis.innerHeight,
            barTop: rect.top,
            barBottom: rect.bottom,
            anchored,
            anchorTop,
            gap: lastGap,
            focused: isFocused(),
        });
    } catch (e) { /* le debug ne doit jamais gêner */ }
}

// --- Écouteurs --------------------------------------------------------------

function refreshAll() {
    applyStyle();
    observeTextarea();
    observeSheld();
    enforce();
    scheduleVv();
    installScrollPatches();
    updateAnchor();
    if (isFocused() && getSettings().iosStrong) startLoop();
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
        updateAnchor();
    };
    for (const type of ['input', 'keyup', 'change', 'cut', 'paste', 'compositionend']) {
        document.addEventListener(type, onInput, true);
    }
    document.addEventListener('keydown', (e) => {
        if (!isTa(e.target)) return;
        updateAnchor();
        if (e.key === 'Enter') {
            setTimeout(enforce, 0);
            // Après l'action par défaut (insertion du saut de ligne) : défiler le champ, pas la page
            setTimeout(keepCaretVisible, 0);
            const raf = globalThis.requestAnimationFrame;
            if (typeof raf === 'function') raf(() => keepCaretVisible());
        }
    }, true);
    document.addEventListener('selectionchange', () => { if (taFocused) updateAnchor(); });
    document.addEventListener('click', (e) => {
        if (e.target && e.target.closest && e.target.closest('#send_but')) { setTimeout(enforce, 60); setTimeout(enforce, 300); }
    }, true);
    document.addEventListener('focusin', (e) => {
        if (!isTa(e.target)) return;
        focusedAt = Date.now();
        taFocused = true;
        observeTextarea();
        enforce();
        scheduleVv();
        updateAnchor();
        if (getSettings().iosStrong) startLoop();
    });
    document.addEventListener('focusout', (e) => {
        if (!isTa(e.target)) return;
        taFocused = false;
        stopLoop();
        releaseAnchor(); // le `bottom:0 !important` du thème s'applique de nouveau
        updateDebug();
        setTimeout(() => { enforce(); scheduleVv(); }, 100);
    });
    globalThis.addEventListener('resize', () => { enforce(); scheduleVv(); });
    globalThis.addEventListener('orientationchange', () => setTimeout(() => { enforce(); scheduleVv(); }, 250));
    // Garde-fou de défilement : si la page défile alors que le champ a le focus, on revient à 0.
    globalThis.addEventListener('scroll', () => {
        const focused = isFocused();
        if (shouldResetScroll(getSettings(), focused, globalThis.scrollY)) {
            globalThis.scrollTo(0, 0);
        }
        updateAnchor();
        scheduleVv();
    }, { passive: true });
    if (globalThis.visualViewport) {
        globalThis.visualViewport.addEventListener('resize', () => { updateAnchor(); scheduleVv(); });
        globalThis.visualViewport.addEventListener('scroll', () => { updateAnchor(); scheduleVv(); });
    }
    taFocused = !!getTextarea() && document.activeElement === getTextarea();
    if (taFocused) startLoop();
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
        <label class="checkbox_label"><input type="checkbox" id="fs_ios"><span>Mode compatibilité iOS renforcé</span></label>
        <div class="fs-hint">Pendant la saisie (clavier ouvert), ancre la barre au bas de la zone visible (visualViewport : <code>top</code> calculé, <code>bottom:auto</code>) et ramène la page à 0, à chaque événement et à ~60 images/s. Au blur, le <code>bottom:0</code> de votre CSS s'applique de nouveau. Remplace l'ancienne translation ci-dessous.</div>
      </div>
      <div class="fs-block">
        <label class="checkbox_label"><input type="checkbox" id="fs_vv"><span>Corriger le décalage clavier iOS (ancienne méthode)</span></label>
        <div class="fs-hint">Translation de la barre selon visualViewport ; utilisée seulement si le mode renforcé est désactivé. Sans effet si le décalage est nul ou si la barre n'est pas en position fixe.</div>
      </div>
      <div class="fs-block">
        <label class="checkbox_label"><input type="checkbox" id="fs_guard"><span>Bloquer le défilement de la page pendant la saisie</span></label>
        <div class="fs-hint">Remet la page à 0 (window, html, body) si elle défile alors que le champ a le focus.</div>
      </div>
      <div class="fs-block">
        <label class="checkbox_label"><input type="checkbox" id="fs_sib"><span>Bloquer scrollIntoView du champ</span></label>
        <div class="fs-hint">Ignore les <code>scrollIntoView()</code> visant #send_textarea pendant la saisie et appelle <code>focus()</code> avec <code>preventScroll</code> sur ce champ uniquement.</div>
      </div>
      <div class="fs-block">
        <label class="checkbox_label"><input type="checkbox" id="fs_debug"><span>Afficher le debug</span></label>
        <div class="fs-hint">Petit overlay en haut à gauche (scrollY, visualViewport, position de la barre) à capturer en screenshot pour le diagnostic.</div>
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
    $('#fs_ios').prop('checked', s.iosStrong);
    $('#fs_sib').prop('checked', s.blockScrollIntoView);
    $('#fs_debug').prop('checked', s.debug);
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
    $('#fs_ios').on('change', function () {
        s.iosStrong = !!$(this).prop('checked'); saveSettings(); applyStyle();
        if (s.iosStrong) { if (isFocused()) startLoop(); } else { stopLoop(); releaseAnchor(); }
        updateAnchor(); updateVv();
    });
    $('#fs_sib').on('change', function () { s.blockScrollIntoView = !!$(this).prop('checked'); saveSettings(); });
    $('#fs_debug').on('change', function () { s.debug = !!$(this).prop('checked'); saveSettings(); updateDebug(); });
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
        observeSheld();
        enforce();
        updateVv();
        installScrollPatches();
        updateDebug();
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
    computeAnchorTop, computeAnchor, shouldCounterScroll, shouldStickBottom, shouldBlockScroll, formatDebug,
    getSettings, applyStyle, syncFixedClass, isSheldFixed, parseTranslateY, createsFixedContainingBlock, enforce, updateVv, observeTextarea, releaseHeight,
    updateAnchor, releaseAnchor, resetPageScroll, keepCaretVisible, installScrollPatches, updateDebug, startLoop, stopLoop,
};
