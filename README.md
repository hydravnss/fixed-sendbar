# Fixed Sendbar

Extension SillyTavern : la barre d'envoi (`#form_sheld` / `#send_form`) **ne bouge plus** quand vous écrivez plusieurs lignes (Entrée). Conçue pour iPhone (Safari / PWA) avec un thème qui fixe la barre en bas (`position: fixed; bottom: 0`).

> ⚠️ **Non testée dans un vrai SillyTavern ni sur iOS** : seule la logique (calcul des hauteurs, décalage `visualViewport`, réglages) est testée sous Node + jsdom (`npm install jsdom@24 --no-save` puis `node test/fixed-sendbar.test.mjs`).

## Installation

SillyTavern > Extensions > **Install extension** > coller `https://github.com/hydravnss/fixed-sendbar`, puis recharger la page.
Réglages : Extensions > **Fixed Sendbar**.

## Réglages

- **Activer**.
- **Mode** :
  - *Hauteur fixe (défilement interne)* (défaut) : le champ garde une hauteur constante (3 lignes par défaut) et défile en interne.
  - *Grandit vers le haut jusqu'à N lignes* : le bas de la barre reste ancré, le champ grandit vers le haut jusqu'à N lignes (6 par défaut), puis défile.
- **Lignes visibles** (1-12, défaut 3) ou **hauteur en px** (0 = selon les lignes).
- **Lignes max** (mode « grandit vers le haut »).
- **Mode compatibilité iOS renforcé** (défaut : oui, v1.1.0) : tant que le champ a le focus (clavier ouvert), la barre `#form_sheld` est ancrée au bas de la zone visible. À chaque événement (`visualViewport` resize/scroll, `scroll`, `input`/`keydown`/`keyup`/`focus`, `selectionchange`) et dans une boucle `requestAnimationFrame` (~60 fps, arrêtée au blur), on calcule `top = visualViewport.offsetTop + visualViewport.height − hauteur de la barre` (coordonnées du layout viewport) et on pose en inline `top: <px> !important; bottom: auto !important`. Au blur, ces surcharges sont retirées et le `bottom: 0 !important` de votre CSS s'applique de nouveau. Si le décalage est ~0 (clavier fermé), rien n'est modifié. La page est aussi ramenée à `scrollY = 0` (window, `documentElement`, `body`), et `overscroll-behavior: none; height: 100%` est posé sur `html`/`body` (jamais `position: fixed` sur `body`).
- **Corriger le décalage clavier iOS (ancienne méthode)** (défaut : oui) : `visualViewport` → variable CSS `--fs-vv-offset` et `translateY` sur `#form_sheld`, utilisée **seulement si le mode renforcé est désactivé** (uniquement si la barre est `position: fixed` et si le décalage est > 0).
- **Bloquer le défilement de la page pendant la saisie** (défaut : oui) : `overscroll-behavior: none` et retour à `scrollY = 0` si la page défile pendant que le champ a le focus.
- **Bloquer scrollIntoView du champ** (défaut : oui) : les appels `scrollIntoView()` visant `#send_textarea` sont ignorés pendant la saisie, et `focus()` sur ce champ est appelé avec `{ preventScroll: true }` (les autres éléments ne sont pas affectés ; enveloppes protégées par `try/catch`). Après Entrée, si le curseur est en fin de texte, seul le champ défile (`scrollTop = scrollHeight`), pas la page.
- **Afficher le debug** (défaut : non) : petit overlay en haut à gauche avec `scrollY`, `visualViewport.offsetTop` / `height`, `top` / `bottom` de la barre, état de l'ancrage. À capturer en screenshot pour le diagnostic.

## Fonctionnement

SillyTavern redimensionne `#send_textarea` à chaque saisie (`autoFitSendTextArea`). L'extension neutralise cela : CSS `!important` (hauteur / min / max, `resize: none`, `overflow-y: auto`) injecté en dernier dans `<head>`, réaffirmation de `style.height` à chaque événement (phase de capture) et `MutationObserver` sur l'attribut `style`. La rangée `#nonQRFormItems` est alignée en bas (`align-items: flex-end`).

Compatible avec *Typing Expand* et *Sendbar Mover* : aucune de leurs classes n'est modifiée et rien n'est caché.

## CSS de secours (CSS personnalisé)

Si besoin, à coller dans *Custom CSS* de SillyTavern (repli sans JavaScript) :

```css
#form_sheld{position:fixed!important;bottom:0!important}
#send_textarea{height:84px!important;min-height:84px!important;max-height:84px!important;resize:none!important;overflow-y:auto!important}
```

## Dépannage iPhone

1. Mettre à jour vers 1.1.0 puis **recharger complètement** la PWA (la fermer dans le sélecteur d'apps et la rouvrir).
2. Vérifier que *Mode compatibilité iOS renforcé* et *Bloquer le défilement de la page* sont cochés.
3. Si la barre dérive encore : activer *Afficher le debug*, reproduire (Entrée plusieurs fois) et envoyer un screenshot.

## Licence

MIT

## Historique

- **1.2.0** : **cause racine iOS trouvée en vrai SillyTavern 1.19 (release)**. Le coeur de ST pose `html{transform:translateZ(0);perspective:1000;backface-visibility:hidden}` ; avec un thème qui force `#form_sheld{position:fixed}` (ex. « iMessage Dark »), `<html>` (et tout wrapper avec `transform`/`will-change`/`filter`, ex. `#tjxv3p{transform:translateY(-12px)}`) devient le bloc conteneur du `fixed` : la barre n'est plus collée au viewport mais suit le **défilement du document**, que iOS déclenche à chaque saut de ligne quand le clavier est ouvert. Correctif : quand la barre est `fixed`, neutralisation (inline `!important`) de transform / perspective / filter / backdrop-filter / will-change / contain sur tous les ancêtres, report du `translateY` d'origine sur la barre (`--fs-anc-ty`), `field-sizing: fixed !important` sur le champ, sélecteurs plus spécifiques, `MutationObserver` qui rétablit le `top` inline si un autre script l'efface (ex. Sendbar Mover sur `resize`). Les versions 1.0.0/1.1.0 se chargeaient sans erreur mais ne traitaient pas cette cause.
- **1.1.0** : mode iOS renforcé (ancrage visualViewport, contre-scroll, debug).
- **1.0.0** : version initiale.

## CSS de secours (à coller en DERNIER dans le CSS perso, sans l'extension)

```css
html,body,#sheld,#tjxv3p{transform:none!important;-webkit-transform:none!important;perspective:none!important;
  backface-visibility:visible!important;filter:none!important;backdrop-filter:none!important;will-change:auto!important;contain:none!important}
#form_sheld{position:fixed!important;bottom:0!important;left:0!important;right:0!important;transform:translateY(-12px)!important}
#send_textarea{field-sizing:fixed!important;height:72px!important;min-height:72px!important;max-height:72px!important;
  overflow-y:auto!important;resize:none!important}
```
