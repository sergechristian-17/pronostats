require("dotenv").config();
const express = require("express"), jwt = require("jsonwebtoken"), bcrypt = require("bcryptjs");
const fs = require("fs"), path = require("path");
const Stripe = require("stripe");
const E = process.env, stripe = Stripe(E.STRIPE_SECRET_KEY);

// Simple JSON file store
const DB_FILE = path.join(__dirname, "data.json");
function loadDB() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, "utf8")); }
  catch { return { users: [], nextId: 1 }; }
}
function saveDB(db) { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); }
let db = loadDB();

const app = express(), RANK = { free: 0, pro: 1, elite: 2 };
const COMPETITIONS = ["FL1", "PL", "PD", "SA", "BL1", "CL"];
const COMP_NAMES = { FL1: "Ligue 1", PL: "Premier League", PD: "La Liga", SA: "Serie A", BL1: "Bundesliga", CL: "Champions League" };

// Stripe webhook
app.post("/api/webhook", express.raw({ type: "application/json" }), (req, res) => {
  let ev;
  try { ev = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], E.STRIPE_WEBHOOK_SECRET); }
  catch (e) { return res.status(400).send("bad signature"); }
  const o = ev.data.object;
  if (ev.type === "checkout.session.completed") {
    const u = db.users.find(x => x.id == o.client_reference_id);
    if (u) { u.plan = o.metadata.plan; u.customer = o.customer; saveDB(db); }
  }
  if (ev.type === "customer.subscription.deleted") {
    const u = db.users.find(x => x.customer === o.customer);
    if (u) { u.plan = "free"; saveDB(db); }
  }
  res.json({ ok: true });
});

app.use(express.json());
app.use(express.static(__dirname));
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));

// Comptes
const token = u => jwt.sign({ id: u.id }, E.JWT_SECRET, { expiresIn: "30d" });
const auth = (req, res, next) => {
  try {
    const { id } = jwt.verify((req.headers.authorization || "").slice(7), E.JWT_SECRET);
    req.user = db.users.find(x => x.id === id);
    if (!req.user) throw 0;
    next();
  } catch { res.status(401).json({ error: "Non connecté" }); }
};

app.post("/api/register", (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password || password.length < 8) return res.status(400).json({ error: "Email et mot de passe (8+ caractères) requis" });
  const emailL = email.toLowerCase();
  if (db.users.find(x => x.email === emailL)) return res.status(409).json({ error: "Email déjà utilisé" });
  const u = { id: db.nextId++, email: emailL, hash: bcrypt.hashSync(password, 10), plan: "free", customer: null };
  db.users.push(u);
  saveDB(db);
  res.json({ token: token(u), plan: "free" });
});

app.post("/api/login", (req, res) => {
  const { email, password } = req.body || {};
  const u = db.users.find(x => x.email === (email || "").toLowerCase());
  if (!u || !bcrypt.compareSync(password || "", u.hash)) return res.status(401).json({ error: "Identifiants invalides" });
  res.json({ token: token(u), plan: u.plan });
});

app.get("/api/me", auth, (req, res) => {
  res.json({ email: req.user.email, plan: req.user.plan });
});

// TEMPORAIRE - pour tester
app.post("/api/force-elite", (req, res) => {
  const { email, secret } = req.body || {};
  if (secret !== "pronostats-test-2026") return res.status(403).json({ error: "Interdit" });
  const u = db.users.find(x => x.email === (email || "").toLowerCase());
  if (!u) return res.status(404).json({ error: "Compte introuvable. Crée d'abord un compte." });
  u.plan = "elite";
  saveDB(db);
  res.json({ ok: true, email: u.email, plan: u.plan });
});

app.post("/api/checkout", auth, async (req, res) => {
  const plan = req.body.plan === "elite" ? "elite" : "pro";
  const price = plan === "elite" ? E.STRIPE_PRICE_ELITE : E.STRIPE_PRICE_PRO;
  try {
    const s = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer_email: req.user.email,
      client_reference_id: String(req.user.id),
      metadata: { plan },
      line_items: [{ price, quantity: 1 }],
      success_url: (E.BASE_URL || "") + "/?ok=1",
      cancel_url: (E.BASE_URL || "") + "/?cancel=1",
      managed_payments: { enabled: false }
    });
    res.json({ url: s.url });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/portal", auth, async (req, res) => {
  if (!req.user.customer) return res.status(400).json({ error: "Aucun abonnement" });
  const s = await stripe.billingPortal.sessions.create({ customer: req.user.customer, return_url: E.BASE_URL || "/" });
  res.json({ url: s.url });
});

// ---------- Modèle de Poisson enrichi ----------
const api = (comp, p) => fetch("https://api.football-data.org/v4/competitions/" + comp + p,
  { headers: { "X-Auth-Token": E.FOOTBALL_DATA_KEY } }).then(r => {
    if (!r.ok) throw new Error("API " + comp + " status " + r.status);
    return r.json();
  });

const pois = (l, k) => { let p = Math.exp(-l); for (let i = 1; i <= k; i++) p *= l / i; return p; };

function predict(lh, la) {
  let w = 0, d = 0, l = 0, o15 = 0, o25 = 0, o35 = 0, btts = 0;
  const scores = []; // [homeGoals, awayGoals, prob]
  for (let i = 0; i <= 7; i++) {
    for (let j = 0; j <= 7; j++) {
      const p = pois(lh, i) * pois(la, j);
      if (i > j) w += p; else if (i === j) d += p; else l += p;
      if (i + j > 1.5) o15 += p;
      if (i + j > 2.5) o25 += p;
      if (i + j > 3.5) o35 += p;
      if (i > 0 && j > 0) btts += p;
      scores.push([i, j, p]);
    }
  }
  const s = w + d + l;
  scores.sort((a, b) => b[2] - a[2]); // meilleurs scores en premier

  // Résultat le plus probable
  let bestOutcome = "1", bestOutcomeProb = w;
  if (d > bestOutcomeProb) { bestOutcome = "N"; bestOutcomeProb = d; }
  if (l > bestOutcomeProb) { bestOutcome = "2"; bestOutcomeProb = l; }

  // Total de buts le plus probable
  let totalGoals = 2;
  if (o35 > 0.45) totalGoals = 3;
  else if (o25 > 0.55) totalGoals = 2;
  else if (o15 > 0.6) totalGoals = 1;
  else totalGoals = 2;

  // BTTS recommandation
  const bttsYes = btts > 0.52;

  // Top 3 scores exacts
  const topScores = scores.slice(0, 5).map(sc => ({
    score: sc[0] + "-" + sc[1],
    prob: +(sc[2] / s).toFixed(3),
    odd: +((1 / (sc[2] / s))).toFixed(2)
  }));

  return {
    w: w / s, d: d / s, l: l / s,
    o25: o25 / s, btts: btts / s,
    bestOutcome, bestOutcomeProb: bestOutcomeProb / s,
    totalGoals,
    bttsYes,
    topScores,
    score: topScores[0].score
  };
}

let cache = { t: 0, list: [] };
async function matches() {
  if (Date.now() - cache.t < 1800e3 && cache.list.length) return cache.list;
  try {
    const all = [];
    for (const comp of COMPETITIONS) {
      try {
        const [st, fx] = await Promise.all([
          api(comp, "/standings"),
          api(comp, "/matches?status=SCHEDULED")
        ]);
        if (!st.standings || !st.standings[0] || !fx.matches) continue;
        const table = st.standings[0].table;
        const G = table.reduce((a, t) => a + (t.goalsFor || 0), 0);
        const N = table.reduce((a, t) => a + (t.playedGames || 0), 0) || 1;
        const avg = G / N || 1.3;
        const S = {};
        table.forEach(t => {
          if (t.playedGames > 0) {
            S[t.team.id] = {
              att: (t.goalsFor / t.playedGames) / avg,
              def: (t.goalsAgainst / t.playedGames) / avg
            };
          }
        });
        const list = fx.matches
          .filter(m => S[m.homeTeam.id] && S[m.awayTeam.id])
          .slice(0, 5)
          .map(m => {
            const h = S[m.homeTeam.id], a = S[m.awayTeam.id];
            const pred = predict(avg * 1.12 * h.att * a.def, avg * a.att * h.def);
            return {
              home: m.homeTeam.name,
              away: m.awayTeam.name,
              date: m.utcDate,
              competition: COMP_NAMES[comp] || comp,
              ...pred
            };
          });
        all.push(...list);
      } catch (e) {
        console.error("Erreur compétition", comp, e.message);
      }
    }
    all.sort((a, b) => new Date(a.date) - new Date(b.date));
    cache = { t: Date.now(), list: all.slice(0, 18) };
    return cache.list;
  } catch (e) {
    console.error("Football data error:", e.message);
    return cache.list.length ? cache.list : [];
  }
}

// Construction de coupons combinés (Élite)
function buildCoupons(list) {
  // On prend les scores exacts les plus fiables (probabilité élevée)
  const candidates = [];
  list.forEach(m => {
    if (m.topScores && m.topScores[0]) {
      candidates.push({
        match: m.home + " - " + m.away,
        score: m.topScores[0].score,
        prob: m.topScores[0].prob,
        odd: m.topScores[0].odd,
        competition: m.competition
      });
    }
  });
  // Trier par fiabilité (probabilité)
  candidates.sort((a, b) => b.prob - a.prob);
  const top = candidates.slice(0, 8);

  const coupons = [];

  // Fonction pour créer un combiné
  function makeCombo(items, targetOdd) {
    if (items.length < 2) return null;
    let odd = 1;
    const picks = [];
    for (const it of items) {
      if (odd * it.odd > targetOdd * 1.4) break;
      odd *= it.odd;
      picks.push(it);
      if (picks.length >= 3) break;
    }
    if (picks.length < 2) return null;
    return {
      target: targetOdd,
      odd: +odd.toFixed(2),
      picks: picks.map(p => p.match + " → " + p.score)
    };
  }

  // Cote ~2
  const c2 = makeCombo(top.slice(0, 4), 2);
  if (c2) coupons.push(c2);

  // Cote ~5
  const c5 = makeCombo(top.slice(0, 6), 5);
  if (c5) coupons.push(c5);

  // Cote ~10
  const c10 = makeCombo(top, 10);
  if (c10) coupons.push(c10);

  return coupons;
}

// Filtrage par abonnement
app.get("/api/predictions", auth, async (req, res) => {
  try {
    const rk = RANK[req.user.plan] || 0;
    const list = await matches();

    const result = list.map((m, i) => {
      // GRATUIT : seulement 2 matchs, une seule prédiction claire (pas de score exact)
      if (rk === 0) {
        if (i > 1) return { home: m.home, away: m.away, date: m.date, competition: m.competition, locked: true };
        const label = m.bestOutcome === "1" ? "Victoire domicile" : m.bestOutcome === "2" ? "Victoire extérieur" : "Match nul";
        return {
          home: m.home, away: m.away, date: m.date, competition: m.competition,
          prediction: label,
          confidence: Math.round(m.bestOutcomeProb * 100)
        };
      }

      // PRO et ELITE
      const o = {
        home: m.home, away: m.away, date: m.date, competition: m.competition,
        winner: m.bestOutcome === "1" ? m.home : m.bestOutcome === "2" ? m.away : "Match nul",
        winnerProb: Math.round(m.bestOutcomeProb * 100),
        totalGoals: m.totalGoals,
        btts: m.bttsYes ? "Oui" : "Non",
        bttsProb: Math.round(m.btts * 100)
      };

      // ELITE uniquement
      if (rk >= 2) {
        o.score = m.score;
        o.topScores = m.topScores.slice(0, 3);
      }

      return o;
    });

    // Ajouter les coupons combinés seulement pour Élite
    if (rk >= 2) {
      const coupons = buildCoupons(list);
      res.json({ matches: result, coupons });
    } else {
      res.json({ matches: result });
    }
  } catch (e) {
    console.error(e);
    res.json({ matches: [] });
  }
});

app.listen(E.PORT || 3000, () => console.log("PronoStats sur " + (E.BASE_URL || "http://localhost:3000")));
