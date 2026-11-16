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

// Liste des compétitions (gratuite sur football-data.org)
const COMPETITIONS = ["FL1", "PL", "PD", "SA", "BL1", "CL"];

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

// ---------- Données multi-compétitions + modèle de Poisson ----------
const api = (comp, p) => fetch("https://api.football-data.org/v4/competitions/" + comp + p,
  { headers: { "X-Auth-Token": E.FOOTBALL_DATA_KEY } }).then(r => {
    if (!r.ok) throw new Error("API " + comp + " status " + r.status);
    return r.json();
  });

const pois = (l, k) => { let p = Math.exp(-l); for (let i = 1; i <= k; i++) p *= l / i; return p; };
function predict(lh, la) {
  let w = 0, d = 0, l = 0, o = 0, b = 0, best = [0, 0, 0];
  for (let i = 0; i <= 8; i++) for (let j = 0; j <= 8; j++) {
    const p = pois(lh, i) * pois(la, j);
    i > j ? w += p : i == j ? d += p : l += p;
    if (i + j > 2) o += p; if (i && j) b += p; if (p > best[2]) best = [i, j, p];
  }
  const s = w + d + l;
  return { w: w / s, d: d / s, l: l / s, o25: o / s, btts: b / s, score: best[0] + "-" + best[1] };
}

const COMP_NAMES = { FL1: "Ligue 1", PL: "Premier League", PD: "La Liga", SA: "Serie A", BL1: "Bundesliga", CL: "Champions League" };

let cache = { t: 0, list: [] };
async function matches() {
  if (Date.now() - cache.t < 1800e3 && cache.list.length) return cache.list; // cache 30 min
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
          .slice(0, 6)
          .map(m => {
            const h = S[m.homeTeam.id], a = S[m.awayTeam.id];
            return {
              home: m.homeTeam.name,
              away: m.awayTeam.name,
              date: m.utcDate,
              competition: COMP_NAMES[comp] || comp,
              ...predict(avg * 1.12 * h.att * a.def, avg * a.att * h.def)
            };
          });
        all.push(...list);
      } catch (e) {
        console.error("Erreur compétition", comp, e.message);
      }
    }
    // Trier par date
    all.sort((a, b) => new Date(a.date) - new Date(b.date));
    cache = { t: Date.now(), list: all.slice(0, 20) }; // max 20 matchs
    return cache.list;
  } catch (e) {
    console.error("Football data error:", e.message);
    return cache.list.length ? cache.list : [];
  }
}

// Filtrage par abonnement (logique inchangée)
app.get("/api/predictions", auth, async (req, res) => {
  try {
    const rk = RANK[req.user.plan] || 0;
    const odd = x => +(1 / x).toFixed(2);
    const list = await matches();
    res.json(list.map((m, i) => {
      if (rk === 0 && i > 1) return { home: m.home, away: m.away, date: m.date, competition: m.competition, locked: true };
      const o = { home: m.home, away: m.away, date: m.date, competition: m.competition, w: m.w, d: m.d, l: m.l };
      if (rk >= 1) { o.o25 = m.o25; o.btts = m.btts; }
      if (rk >= 2) { o.score = m.score; o.odds = [odd(m.w), odd(m.d), odd(m.l)]; }
      return o;
    }));
  } catch (e) {
    console.error(e);
    res.json([]);
  }
});

app.listen(E.PORT || 3000, () => console.log("PronoStats sur " + (E.BASE_URL || "http://localhost:3000")));
