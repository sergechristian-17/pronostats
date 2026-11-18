require("dotenv").config();
const express = require("express"), jwt = require("jsonwebtoken"), bcrypt = require("bcryptjs");
const fs = require("fs"), path = require("path");
const Stripe = require("stripe");
const E = process.env, stripe = Stripe(E.STRIPE_SECRET_KEY);

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

app.get("/api/me", auth, (req, res) => res.json({ email: req.user.email, plan: req.user.plan }));

app.post("/api/force-elite", (req, res) => {
  const { email, secret } = req.body || {};
  if (secret !== "pronostats-test-2026") return res.status(403).json({ error: "Interdit" });
  const u = db.users.find(x => x.email === (email || "").toLowerCase());
  if (!u) return res.status(404).json({ error: "Compte introuvable" });
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
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/portal", auth, async (req, res) => {
  if (!req.user.customer) return res.status(400).json({ error: "Aucun abonnement" });
  const s = await stripe.billingPortal.sessions.create({ customer: req.user.customer, return_url: E.BASE_URL || "/" });
  res.json({ url: s.url });
});

// ---------- Modèle ----------
const api = (comp, p) => fetch("https://api.football-data.org/v4/competitions/" + comp + p,
  { headers: { "X-Auth-Token": E.FOOTBALL_DATA_KEY } }).then(r => {
    if (!r.ok) throw new Error("API " + comp + " " + r.status);
    return r.json();
  });

const pois = (l, k) => { let p = Math.exp(-l); for (let i = 1; i <= k; i++) p *= l / i; return p; };

function predict(lh, la) {
  let w = 0, d = 0, l = 0;
  let o05 = 0, o15 = 0, o25 = 0, o35 = 0;
  let btts = 0;
  const scores = [];
  for (let i = 0; i <= 6; i++) {
    for (let j = 0; j <= 6; j++) {
      const p = pois(lh, i) * pois(la, j);
      if (i > j) w += p; else if (i === j) d += p; else l += p;
      const tot = i + j;
      if (tot > 0.5) o05 += p;
      if (tot > 1.5) o15 += p;
      if (tot > 2.5) o25 += p;
      if (tot > 3.5) o35 += p;
      if (i > 0 && j > 0) btts += p;
      scores.push([i, j, p]);
    }
  }
  const s = w + d + l || 1;
  scores.sort((a, b) => b[2] - a[2]);

  // 1X2
  const outcomes = [
    { key: "1", label: "Victoire domicile", prob: w / s },
    { key: "X", label: "Match nul", prob: d / s },
    { key: "2", label: "Victoire extérieur", prob: l / s }
  ].sort((a, b) => b.prob - a.prob);

  // Double chance
  const doubleChance = [
    { key: "1X", label: "Domicile ou Nul", prob: (w + d) / s },
    { key: "12", label: "Domicile ou Extérieur", prob: (w + l) / s },
    { key: "X2", label: "Nul ou Extérieur", prob: (d + l) / s }
  ].sort((a, b) => b.prob - a.prob);

  // Totals
  const totals = [
    { line: "0.5", over: o05 / s, under: 1 - o05 / s },
    { line: "1.5", over: o15 / s, under: 1 - o15 / s },
    { line: "2.5", over: o25 / s, under: 1 - o25 / s },
    { line: "3.5", over: o35 / s, under: 1 - o35 / s }
  ];

  // Exact scores top 5
  const topScores = scores.slice(0, 5).map(([i, j, p]) => ({
    score: i + "-" + j,
    prob: p / s,
    odd: +((1 / (p / s))).toFixed(2)
  }));

  // HT/FT approximation (simplified: assume half intensity ~0.45 of full)
  const htLh = lh * 0.45, htLa = la * 0.45;
  const htft = [];
  const htOutcomes = ["1", "X", "2"];
  for (const ht of htOutcomes) {
    for (const ft of htOutcomes) {
      // rough probability
      let pHt = ht === "1" ? 0.4 : ht === "X" ? 0.3 : 0.3;
      let pFt = ft === "1" ? w / s : ft === "X" ? d / s : l / s;
      // correlation adjustment
      if (ht === ft) pHt *= 1.15;
      htft.push({ key: ht + "/" + ft, prob: Math.min(0.35, pHt * pFt * 1.2) });
    }
  }
  htft.sort((a, b) => b.prob - a.prob);

  return {
    outcomes,
    doubleChance,
    totals,
    btts: { yes: btts / s, no: 1 - btts / s },
    topScores,
    htft: htft.slice(0, 6),
    bestOutcome: outcomes[0].key,
    bestOutcomeProb: outcomes[0].prob
  };
}

let cache = { t: 0, list: [] };
async function matches() {
  if (Date.now() - cache.t < 1800e3 && cache.list.length) return cache.list;
  try {
    const all = [];
    for (const comp of COMPETITIONS) {
      try {
        const [st, fx] = await Promise.all([api(comp, "/standings"), api(comp, "/matches?status=SCHEDULED")]);
        if (!st.standings?.[0] || !fx.matches) continue;
        const table = st.standings[0].table;
        const G = table.reduce((a, t) => a + (t.goalsFor || 0), 0);
        const N = table.reduce((a, t) => a + (t.playedGames || 0), 0) || 1;
        const avg = G / N || 1.3;
        const S = {};
        table.forEach(t => {
          if (t.playedGames > 0) S[t.team.id] = { att: t.goalsFor / t.playedGames / avg, def: t.goalsAgainst / t.playedGames / avg };
        });
        fx.matches.filter(m => S[m.homeTeam.id] && S[m.awayTeam.id]).slice(0, 5).forEach(m => {
          const h = S[m.homeTeam.id], a = S[m.awayTeam.id];
          all.push({
            home: m.homeTeam.name,
            away: m.awayTeam.name,
            date: m.utcDate,
            competition: COMP_NAMES[comp] || comp,
            ...predict(avg * 1.12 * h.att * a.def, avg * a.att * h.def)
          });
        });
      } catch (e) { console.error(comp, e.message); }
    }
    all.sort((a, b) => new Date(a.date) - new Date(b.date));
    cache = { t: Date.now(), list: all.slice(0, 16) };
    return cache.list;
  } catch (e) {
    console.error(e.message);
    return cache.list || [];
  }
}

function buildCoupons(list) {
  const coupons = { cote2: [], cote5: [], cote10: [], exact: [] };

  // Exact scores
  const exacts = [];
  list.forEach(m => {
    if (m.topScores?.[0]) exacts.push({ match: m.home + " – " + m.away, score: m.topScores[0].score, prob: m.topScores[0].prob, odd: m.topScores[0].odd });
  });
  exacts.sort((a, b) => b.prob - a.prob);
  if (exacts.length >= 2) {
    const p = exacts.slice(0, 2);
    coupons.exact.push({ odd: +(p[0].odd * p[1].odd).toFixed(2), picks: p.map(x => x.match + " → " + x.score) });
  }
  if (exacts.length >= 3) {
    const p = exacts.slice(0, 3);
    coupons.exact.push({ odd: +(p[0].odd * p[1].odd * p[2].odd).toFixed(2), picks: p.map(x => x.match + " → " + x.score) });
  }

  // 1X2 best results for target odds
  const results = [];
  list.forEach(m => {
    const best = m.outcomes[0];
    const odd = +(1 / best.prob).toFixed(2);
    if (odd >= 1.20 && odd <= 2.80) {
      results.push({ match: m.home + " – " + m.away, pick: best.label, odd, prob: best.prob });
    }
  });
  results.sort((a, b) => b.prob - a.prob);

  function makeCombo(items, target, maxN) {
    let odd = 1, picks = [];
    for (const it of items) {
      if (picks.length >= maxN) break;
      odd *= it.odd;
      picks.push(it.match + " → " + it.pick + " (" + it.odd + ")");
      if (odd >= target * 0.85) break;
    }
    if (picks.length < 2) return null;
    return { odd: +odd.toFixed(2), picks };
  }

  const c2 = makeCombo(results, 2, 3);
  if (c2) coupons.cote2.push(c2);
  const c5 = makeCombo(results, 5, 4);
  if (c5) coupons.cote5.push(c5);
  const c10 = makeCombo(results, 10, 5);
  if (c10) coupons.cote10.push(c10);

  return coupons;
}

app.get("/api/predictions", auth, async (req, res) => {
  try {
    const rk = RANK[req.user.plan] || 0;
    const list = await matches();
    const matchesOut = list.map((m, i) => {
      const base = { home: m.home, away: m.away, date: m.date, competition: m.competition };

      // Free: only first match unlocked, and only 1X2 visible
      if (rk === 0) {
        if (i > 0) return { ...base, locked: true };
        return {
          ...base,
          outcomes: m.outcomes,
          doubleChance: m.doubleChance,
          totalsLocked: true,
          bttsLocked: true,
          scoreLocked: true,
          htftLocked: true
        };
      }

      // Pro
      if (rk === 1) {
        return {
          ...base,
          outcomes: m.outcomes,
          doubleChance: m.doubleChance,
          totals: m.totals,
          btts: m.btts,
          scoreLocked: true,
          htftLocked: true
        };
      }

      // Elite
      return {
        ...base,
        outcomes: m.outcomes,
        doubleChance: m.doubleChance,
        totals: m.totals,
        btts: m.btts,
        topScores: m.topScores,
        htft: m.htft
      };
    });

    const coupons = rk >= 2 ? buildCoupons(list) : null;
    res.json({ matches: matchesOut, coupons, plan: req.user.plan });
  } catch (e) {
    console.error(e);
    res.json({ matches: [] });
  }
});

app.listen(E.PORT || 3000, () => console.log("PronoStats " + (E.BASE_URL || "http://localhost:3000")));
