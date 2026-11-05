# Entraîneur de visée CS2

Entraîneur de visée 3D en français, qui tourne dans le navigateur (Chrome en priorité, sous Windows et Ubuntu).
HTML + CSS + JavaScript, **sans étape de build**. Three.js (r147) est fourni dans `lib/`.

```
index.html   page unique (menu, historique, HUD, pause, fin de séance)
style.css    thème sombre
script.js    jeu, visée, cibles, recul, score, historique
lib/         three.min.js (+ licence)
```

## Lancer le projet

Aucune installation : ouvrez simplement `index.html` dans Chrome (double-clic), ou servez le dossier :

```bash
python3 -m http.server 8000
```

puis ouvrez <http://localhost:8000>. (`npx serve` fonctionne aussi.)

## Utilisation

- **Réglages** : mode, durée (minutes + secondes), vitesse 1-10, temps d'affichage des cibles (1,5 s par défaut), arme, DPI (800) et sensibilité CS2 (1,00). La distance pour un tour complet est calculée en direct : `360 / (0,022 × sens) / DPI × 2,54` → **≈ 52 cm** à 800 DPI et 1,00.
- **Commencer** verrouille la souris (compte à rebours de 3 s). **Échap** met en pause : *Reprendre* ou *Quitter* (quitter n'enregistre pas la séance). Si le navigateur refuse de reverrouiller la souris juste après Échap, attendez une seconde et recliquez.
- **Déplacement** : touches Z Q S D (touches physiques, donc WASD sur un clavier QWERTY). Le mur central a deux angles ; les cibles (fixes) apparaissent cachées derrière, à gauche ou à droite.
- **Déplacement + cibles mobiles** : même décor, mais les cibles se déplacent latéralement ; le curseur de vitesse règle leur vitesse.
- **Pistolet (coup par coup)** : un tir par clic, léger recul. L'arme s'affiche en bas à droite de l'écran.
- **Mitraillette (rafale)** : maintenez le clic (~600 tirs/min). La visée monte selon un schéma fixe (haut, puis écarts latéraux) ; tirez la souris vers le bas pour compenser. Le recul se réinitialise peu après le relâchement.

### Règles
| Événement | Points |
|---|---|
| Tir à la tête (élimine la cible) | 100 |
| Tir au corps (3 tirs pour éliminer) | 25 |
| Cible ratée (temps d'affichage écoulé) | 0 |

- Visée : 0,022° × sensibilité par unité de mouvement, identique sur les deux axes, sans accélération ni lissage. Le mode `unadjustedMovement` est tenté en premier, avec repli sur le mode normal (indiqué dans le menu pause).
- FOV vertical : 74°.
- Tirs visibles : chaque balle laisse une traînée de petits points lumineux depuis le canon jusqu'à l'impact, avec un point d'impact (rouge à la tête, blanc au corps, jaune sur un mur ou le sol) et un flash de bouche. C'est purement visuel : la balle part exactement dans l'axe de la visée.
- Son : seul le tir est sonorisé (bruit synthétisé avec Web Audio, aucun fichier audio).
- **% headshots** = tirs à la tête ÷ cibles éliminées. **Précision** = tirs touchés ÷ tirs effectués. **Temps moyen** = durée entre l'apparition et l'élimination.
- Réglages et historique (500 séances max.) sont stockés dans `localStorage` (clés `cs2aim.settings.v1` et `cs2aim.history.v1`).

## Publier sur GitHub Pages

1. Créez un dépôt GitHub et envoyez-y le contenu du dossier (`index.html` à la racine) :
   ```bash
   git init
   git add .
   git commit -m "Entraîneur de visée CS2"
   git branch -M main
   git remote add origin https://github.com/<utilisateur>/<depot>.git
   git push -u origin main
   ```
2. Sur GitHub : **Settings → Pages → Build and deployment** → *Source* : **Deploy from a branch**, branche `main`, dossier `/ (root)`.
3. Après une minute, le site est disponible sur `https://<utilisateur>.github.io/<depot>/`.

Tous les chemins sont relatifs, le projet fonctionne donc aussi dans un sous-dossier.

## Licence

Code du projet : libre d'usage. Three.js : licence MIT (`lib/LICENSE-three.txt`).
