# Horloge Suisse v2

Monorepo contenant :
- `bot/` : service **NestJS** du bot crypto multi-stratégie
- `dashboard/` : interface **Next.js** de supervision et de contrôle

> Objectif : exploitation 24/7 d’un bot de trading crypto sur Arbitrum avec garde-fous de risque stricts.

## Prérequis

- Node.js 20+
- npm 10+ (ou yarn/pnpm)
- PostgreSQL 14+
- Accès RPC Arbitrum (public ou provider privé)

## Structure du projet

```text
horloge-suisse-v2/
├── bot/                      # API + moteur des stratégies
├── dashboard/                # UI de monitoring / contrôle
├── GUIDE_COMPORTEMENTAL.md   # doctrine stratégique & règles immuables
├── .gitignore
├── LICENSE
└── README.md
```

## Installation

### 1) Cloner le dépôt

```bash
git clone https://github.com/christiandeveaux65-dev/horloge-suisse-v2.git
cd horloge-suisse-v2
```

### 2) Installer les dépendances

```bash
cd bot && npm install
cd ../dashboard && npm install
```

## Configuration des variables d’environnement

### Bot (`bot/.env`)

```bash
cd bot
cp .env.example .env
```

Variables importantes :
- `DATABASE_URL` : connexion PostgreSQL
- `WALLET_PRIVATE_KEY` : clé privée du wallet d’exécution (laisser vide pour dry-run)
- `ARBITRUM_RPC_URL` : endpoint RPC Arbitrum
- `API_KEY_HASH` : hash SHA-256 de la clé API du bot
- `CORS_ORIGIN` : origine(s) autorisée(s)
- `ABACUSAI_API_KEY` : active le module strategist LLM
- `NODE_ENV` : `production` ou `development`

### Dashboard (`dashboard/.env.local`)

```bash
cd dashboard
cp .env.example .env.local
```

Variables importantes :
- `DATABASE_URL` : même base PostgreSQL que le bot
- `BOT_API_URL` : URL du bot NestJS
- `BOT_API_KEY` : clé API (en clair) envoyée au bot en `x-api-key`
- `NEXTAUTH_SECRET` : secret de session
- `NEXTAUTH_URL` : URL publique du dashboard (en prod)
- `DASHBOARD_PIN` : code PIN d’accès initial

## Lancement local

Ouvrir 2 terminaux.

### Terminal 1 — Bot

```bash
cd bot
npm run start:dev
```

Bot API par défaut : `http://localhost:3001`

### Terminal 2 — Dashboard

```bash
cd dashboard
npm run dev
```

Dashboard par défaut : `http://localhost:3000`

## Déploiement

### Option A — Abacus.ai (recommandé)

1. Déployer `bot/` comme service Node (NestJS).
2. Déployer `dashboard/` comme app Next.js.
3. Configurer les variables d’environnement de chaque service.
4. Vérifier la connectivité `dashboard -> bot` via `BOT_API_URL` + `BOT_API_KEY`.

### Option B — Autre plateforme

Compatible avec Vercel, Railway, Render, Fly.io, Docker/Kubernetes, etc., à condition de :
- provisionner PostgreSQL,
- exposer le bot en HTTPS,
- injecter les variables d’environnement côté serveur,
- interdire toute exposition de secrets côté client.

## Sécurité

- Aucun secret ne doit être commit (clé privée, token API, secrets de session, PIN réel, etc.).
- Utiliser uniquement des variables d’environnement.
- Ne jamais exposer `BOT_API_KEY` côté navigateur (`NEXT_PUBLIC_*` interdit).
- Le module Risk Manager est critique : ne pas le désactiver.

## Commandes utiles

```bash
# Vérifier la qualité (selon scripts disponibles)
cd bot && npm run lint
cd dashboard && npm run lint

# Tests bot
cd bot && npm test
```

## Licence

Ce projet est distribué sous licence MIT. Voir `LICENSE`.
