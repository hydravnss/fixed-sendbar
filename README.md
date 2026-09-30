# Fixed Sendbar

Extension SillyTavern : la barre d'envoi (`#form_sheld` / `#send_form`) **ne bouge plus** quand vous écrivez plusieurs lignes (Entrée). Conçue pour iPhone (Safari / PWA) avec un thème qui fixe la barre en bas (`position: fixed; bottom: 0`).

> ⚠️ **Non testée dans un vrai SillyTavern ni sur iOS** : seule la logique (calcul des hauteurs, décalage `visualViewport`, réglages) est testée sous Node + jsdom (`npm install jsdom@24` puis `node test/fixed-sendbar.test.mjs`).

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
- **Corriger le décalage clavier iOS** (défaut : oui) : `visualViewport` → variable CSS `--fs-vv-offset` et `translateY` sur `#form_sheld`, uniquement si la barre est `position: fixed` et si le décalage est > 0 (sinon aucun effet).
- **Bloquer le défilement de la page pendant la saisie** (défaut : oui) : `overscroll-behavior: none` et retour à `scrollY = 0` si la page défile pendant que le champ a le focus.

## Fonctionnement

SillyTavern redimensionne `#send_textarea` à chaque saisie (`autoFitSendTextArea`). L'extension neutralise cela : CSS `!important` (hauteur / min / max, `resize: none`, `overflow-y: auto`) injecté en dernier dans `<head>`, réaffirmation de `style.height` à chaque événement (phase de capture) et `MutationObserver` sur l'attribut `style`. La rangée `#nonQRFormItems` est alignée en bas (`align-items: flex-end`).

Compatible avec *Typing Expand* et *Sendbar Mover* : aucune de leurs classes n'est modifiée et rien n'est caché.

## Licence

MIT
