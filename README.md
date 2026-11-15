# PronoStats – backend complet
1. `npm install`
2. `cp .env.example .env` puis remplis les clés :
   - football-data.org : clé gratuite (Ligue 1 incluse)
   - Stripe : crée 2 produits d'abonnement (Pro 9,99 €, Élite 19,99 €) → copie les `price_...`
3. `stripe listen --forward-to localhost:3000/api/webhook` (copie le `whsec_...` dans .env)
4. `npm start` → http://localhost:3000
Déploiement : Render / Railway / Fly.io (variables d'env + volume pour data.db). Mets le webhook de prod dans le dashboard Stripe.
Légal : mentions 18+, pas de promesse de gain, vérifie les règles de ton pays (ANJ en France), CGV, RGPD.
