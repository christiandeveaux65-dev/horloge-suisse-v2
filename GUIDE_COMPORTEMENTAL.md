# GUIDE COMPORTEMENTAL — Horloge Suisse v2

## Objectif

Bot de trading crypto **multi-stratégie 24/7** avec supervision automatisée, opéré principalement sur Arbitrum, pour un capital cible d’environ **7 800 USD**.

## Philosophie de gestion

1. **Protection du capital d’abord**, rendement ensuite.
2. Interdiction des comportements type **YOLO**.
3. Interdiction du **all-in** sur une seule stratégie/position.
4. Toute optimisation doit respecter le cadre de risque avant la performance brute.

## Stratégies actives

- **DCA (accumulation long-terme)**
- **Grid Trading** (bande ±3,5%, 15 niveaux)
- **Mean Reversion** (déclenchement principal RSI < 35)
- **Momentum** (trend-following)
- **GMX Perps** (levier contrôlé à 2x)

## Règles immuables

1. Le **Risk Manager** ne doit jamais être désactivé.
2. Le module **DCA** est intouchable : minimum **0,50 USD**, périodicité **3h**.
3. Aucune clé API/secret ne doit être exposé côté client (front-end).
4. **KuCoin** est utilisé pour les prix uniquement (pas pour la custody ni exécution custodiale).

## Module Aave

Le module Aave est **désactivé intentionnellement**.

Raison : rendement jugé insuffisant (ordre de grandeur ~**80 USD/an** pour ~**3 000 USD** immobilisés), avec complexité/risque d’opportunité non justifiés au regard des autres modules.

## Faiblesse connue (priorité #1)

Le système ne dispose pas encore d’un backtesting robuste.

- Les paramètres actuels sont cohérents sur le plan logique,
- mais **n’ont pas été validés historiquement** de façon systématique.

➡️ Priorité d’amélioration absolue : intégrer une chaîne de backtesting fiable et reproductible.

## Vision produit

Faire évoluer Horloge Suisse v2 vers un bot :

1. **Auto-adaptatif** (paramètres dynamiques selon régime de marché),
2. doté d’un **backtesting intégré**,
3. enrichi par du **ML** pour ajuster les seuils/tailles de position,
4. avec une **résilience totale** (tolérance aux pannes, reprise automatique, observabilité complète).

## Directives pour tout mainteneur (humain ou IA)

- Ne jamais contourner la couche risque pour « tester vite » en production.
- Toute nouvelle stratégie doit inclure :
  - limites d’exposition,
  - conditions d’arrêt,
  - plan de rollback,
  - métriques de suivi.
- Aucun secret dans le dépôt Git : uniquement variables d’environnement.
- Toute modification impactant l’exécution d’ordres doit être revue et testée avant déploiement.
