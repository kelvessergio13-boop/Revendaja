const express = require("express");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 3000;
const COMMISSION_RATE = 0.10;
const DEFAULT_LIMIT = 500;
const DEADLINE_DAYS = 7;
const MAX_STORES_PER_SELLER = 2;
const DEFAULT_CATEGORIES = ["Vestuário", "Eletrónica", "Casa & Decoração", "Beleza & Saúde", "Alimentos & Bebidas", "Acessórios", "Outros"];

// ---------- Ligação à base de dados (Postgres) ----------
if (!process.env.DATABASE_URL) {
  console.error("ERRO: a variável de ambiente DATABASE_URL não está definida. Configure uma base de dados Postgres (Render, Neon, Supabase, etc.).");
}
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes("localhost")
    ? false
    : { rejectUnauthorized: false },
});
const q = (text, params) => pool.query(text, params);

async function initSchema() {
  await q(`
    CREATE TABLE IF NOT EXISTS sellers(
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      phone TEXT UNIQUE NOT NULL,
      email TEXT,
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL DEFAULT '',
      balance INTEGER DEFAULT 0,
      commission_due INTEGER DEFAULT 0,
      commission_limit INTEGER DEFAULT 500,
      trust_level TEXT DEFAULT 'NOVO',
      approved_payments INTEGER DEFAULT 0,
      last_commission_at TIMESTAMPTZ,
      account_status TEXT DEFAULT 'ATIVO',
      terms_accepted BOOLEAN DEFAULT FALSE,
      terms_accepted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS stores(
      id SERIAL PRIMARY KEY,
      seller_id INTEGER NOT NULL REFERENCES sellers(id),
      category TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      image TEXT DEFAULT '',
      store_slug TEXT UNIQUE NOT NULL,
      status TEXT DEFAULT 'ATIVA',
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS products(
      id SERIAL PRIMARY KEY,
      store_id INTEGER NOT NULL REFERENCES stores(id),
      name TEXT NOT NULL,
      description TEXT,
      price INTEGER NOT NULL,
      image TEXT,
      stock INTEGER DEFAULT 1,
      active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS orders(
      id SERIAL PRIMARY KEY,
      product_id INTEGER NOT NULL REFERENCES products(id),
      store_id INTEGER NOT NULL REFERENCES stores(id),
      seller_id INTEGER NOT NULL REFERENCES sellers(id),
      customer_name TEXT NOT NULL,
      customer_phone TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      unit_price INTEGER NOT NULL,
      total INTEGER NOT NULL,
      commission INTEGER NOT NULL,
      seller_net INTEGER NOT NULL,
      payment_status TEXT DEFAULT 'PENDENTE',
      status TEXT DEFAULT 'NOVO',
      commission_status TEXT DEFAULT 'PENDENTE',
      commission_paid_amount INTEGER DEFAULT 0,
      commission_due_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS commission_payments(
      id SERIAL PRIMARY KEY,
      seller_id INTEGER NOT NULL REFERENCES sellers(id),
      amount INTEGER NOT NULL,
      method TEXT,
      reference TEXT,
      status TEXT DEFAULT 'PENDENTE',
      proof TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS transactions(
      id SERIAL PRIMARY KEY,
      seller_id INTEGER,
      order_id INTEGER,
      type TEXT,
      amount INTEGER,
      description TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS commission_allocations(
      id SERIAL PRIMARY KEY,
      payment_id INTEGER NOT NULL REFERENCES commission_payments(id),
      order_id INTEGER NOT NULL REFERENCES orders(id),
      amount INTEGER NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS support_tickets(
      id SERIAL PRIMARY KEY,
      seller_id INTEGER NOT NULL REFERENCES sellers(id),
      category TEXT NOT NULL,
      subject TEXT NOT NULL,
      message TEXT NOT NULL,
      status TEXT DEFAULT 'ABERTO',
      admin_reply TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    );
  `);
}

// ---------- Senhas (hash com salt) ----------
function hashPassword(password, existingSalt) {
  const salt = existingSalt || crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return { hash, salt };
}
function verifyPassword(password, salt, expectedHash) {
  if (!salt) return false;
  const testHash = crypto.scryptSync(password, salt, 64).toString("hex");
  const a = Buffer.from(testHash, "hex");
  const b = Buffer.from(expectedHash, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function waNumber(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  if (digits.startsWith("258")) return digits;
  if (digits.length === 9) return "258" + digits;
  return digits;
}
function slugify(s) {
  return s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
function safeSeller(s) {
  return {
    id: s.id, name: s.name, phone: s.phone, email: s.email,
    balance: s.balance, commission_due: s.commission_due,
    commission_limit: s.commission_limit || DEFAULT_LIMIT,
    trust_level: s.trust_level || "NOVO",
    approved_payments: s.approved_payments || 0,
    last_commission_at: s.last_commission_at,
    account_status: s.account_status,
  };
}
function levelFor(n) {
  if (n >= 12) return { level: "VERIFICADO", limit: 5000 };
  if (n >= 6) return { level: "CONFIAVEL", limit: 3000 };
  if (n >= 3) return { level: "EM_CRESCIMENTO", limit: 1500 };
  return { level: "NOVO", limit: 500 };
}
async function refreshLevel(id) {
  const { rows } = await q("SELECT approved_payments FROM sellers WHERE id=$1", [id]);
  if (!rows[0]) return;
  const x = levelFor(rows[0].approved_payments || 0);
  await q("UPDATE sellers SET trust_level=$1, commission_limit=$2 WHERE id=$3", [x.level, x.limit, id]);
}

// ---------- Sessão de administrador ----------
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const ADMIN_SESSION_SECRET = process.env.ADMIN_SESSION_SECRET || crypto.randomBytes(32).toString("hex");
if (!process.env.ADMIN_SESSION_SECRET) {
  console.warn("Aviso: ADMIN_SESSION_SECRET não definida — a gerar uma temporária. Defina esta variável no Render.");
}
if (!ADMIN_PASSWORD) {
  console.warn("Aviso: ADMIN_PASSWORD não definida — o login de administrador vai recusar sempre. Defina esta variável no Render.");
}
const ADMIN_COOKIE = "revendeja_admin";
const ADMIN_SESSION_HOURS = 12;

function signAdminToken() {
  const exp = Date.now() + ADMIN_SESSION_HOURS * 3600 * 1000;
  const payload = Buffer.from(JSON.stringify({ exp })).toString("base64url");
  const sig = crypto.createHmac("sha256", ADMIN_SESSION_SECRET).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}
function verifyAdminToken(token) {
  if (!token || !token.includes(".")) return false;
  const [payload, sig] = token.split(".");
  const expected = crypto.createHmac("sha256", ADMIN_SESSION_SECRET).update(payload).digest("base64url");
  const a = Buffer.from(sig || "");
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  try {
    const { exp } = JSON.parse(Buffer.from(payload, "base64url").toString());
    return typeof exp === "number" && Date.now() < exp;
  } catch { return false; }
}
function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  header.split(";").forEach((part) => {
    const i = part.indexOf("=");
    if (i === -1) return;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}
function requireAdmin(req, res, next) {
  const cookies = parseCookies(req);
  if (verifyAdminToken(cookies[ADMIN_COOKIE])) return next();
  res.status(401).json({ error: "Sessão de administrador inválida ou expirada. Entre novamente." });
}

// ---------- Agregador de pagamentos — pronto a ligar, desligado até haver credenciais ----------
const PAYMENT_API_BASE = process.env.PAYMENT_API_BASE || "";
const PAYMENT_API_TOKEN = process.env.PAYMENT_API_TOKEN || "";
const PAYMENT_CALLBACK_SECRET = process.env.PAYMENT_CALLBACK_SECRET || "";
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || "";
function paymentGatewayConfigured() {
  return !!(PAYMENT_API_BASE && PAYMENT_API_TOKEN);
}
async function providerCreateCharge({ amount, phone, reference, description }) {
  const resp = await fetch(`${PAYMENT_API_BASE}/payments`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${PAYMENT_API_TOKEN}` },
    body: JSON.stringify({ amount, msisdn: phone, reference, description, callback_url: `${PUBLIC_BASE_URL}/api/payments/webhook` }),
  });
  if (!resp.ok) throw new Error("O agregador de pagamentos recusou o pedido.");
  return resp.json();
}
async function approveCommissionPayment(paymentId) {
  const { rows: prows } = await q("SELECT * FROM commission_payments WHERE id=$1 AND status='PENDENTE'", [paymentId]);
  const payment = prows[0];
  if (!payment) throw Object.assign(new Error("Pagamento pendente não encontrado."), { status: 404 });
  const { rows: srows } = await q("SELECT * FROM sellers WHERE id=$1", [payment.seller_id]);
  const seller = srows[0];
  if (!seller) throw Object.assign(new Error("Vendedor não encontrado."), { status: 404 });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("UPDATE commission_payments SET status='APROVADO' WHERE id=$1", [payment.id]);
    let remaining = payment.amount;
    const { rows: orders } = await client.query(
      "SELECT id, commission, commission_paid_amount FROM orders WHERE seller_id=$1 AND commission_status='PENDENTE' ORDER BY id ASC",
      [payment.seller_id]
    );
    for (const o of orders) {
      if (remaining <= 0) break;
      const open = o.commission - (o.commission_paid_amount || 0);
      const take = Math.min(open, remaining);
      if (take <= 0) continue;
      await client.query(
        `UPDATE orders SET commission_paid_amount=commission_paid_amount+$1,
         commission_status=CASE WHEN commission_paid_amount+$1 >= commission THEN 'PAGA' ELSE 'PENDENTE' END
         WHERE id=$2`,
        [take, o.id]
      );
      await client.query("INSERT INTO commission_allocations(payment_id, order_id, amount) VALUES($1,$2,$3)", [payment.id, o.id, take]);
      remaining -= take;
    }
    await client.query(
      "UPDATE sellers SET commission_due=GREATEST(0,commission_due-$1), approved_payments=approved_payments+1 WHERE id=$2",
      [payment.amount, payment.seller_id]
    );
    await client.query(
      "INSERT INTO transactions(seller_id, type, amount, description) VALUES($1,'COMISSAO_PAGA',$2,'Pagamento de comissão aprovado')",
      [payment.seller_id, payment.amount]
    );
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }

  await refreshLevel(payment.seller_id);
  const { rows: nrows } = await q("SELECT * FROM sellers WHERE id=$1", [payment.seller_id]);
  const updated = nrows[0];
  if (updated.commission_due < updated.commission_limit && updated.account_status === "BLOQUEADO") {
    await q("UPDATE sellers SET account_status='ATIVO' WHERE id=$1", [payment.seller_id]);
  }
  const { rows: final } = await q("SELECT * FROM sellers WHERE id=$1", [payment.seller_id]);
  return final[0];
}

// ---------- Middleware base ----------
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));
app.get("/health", (req, res) => res.json({ ok: true, service: "RevendeJá" }));
app.use(express.static(path.join(__dirname, "public")));

function asyncRoute(fn) {
  return (req, res) => fn(req, res).catch((e) => {
    console.error(e);
    res.status(e.status || 500).json({ error: e.exposedMessage || "Erro interno." });
  });
}

// ---------- Categorias (lista fixa; a categoria da loja define o que ela pode vender) ----------
app.get("/api/categories", (req, res) => res.json(DEFAULT_CATEGORIES));

// ---------- Vendedores ----------
app.post("/api/sellers/register", asyncRoute(async (req, res) => {
  const { name, phone, email, password, terms_accepted } = req.body;
  if (!name || !phone || !password) return res.status(400).json({ error: "Nome, telefone e palavra-passe são obrigatórios." });
  if (!terms_accepted) return res.status(400).json({ error: "É necessário aceitar os Termos do Vendedor." });
  const { rows: existing } = await q("SELECT id FROM sellers WHERE phone=$1", [phone]);
  if (existing[0]) return res.status(409).json({ error: "Telefone já registado." });
  const { hash, salt } = hashPassword(password);
  const { rows } = await q(
    `INSERT INTO sellers(name, phone, email, password_hash, password_salt, commission_limit, trust_level, terms_accepted, terms_accepted_at)
     VALUES($1,$2,$3,$4,$5,$6,'NOVO',TRUE,now()) RETURNING *`,
    [name.trim(), phone.trim(), email || "", hash, salt, DEFAULT_LIMIT]
  );
  res.json({ seller: safeSeller(rows[0]) });
}));
app.post("/api/sellers/login", asyncRoute(async (req, res) => {
  const { phone, password } = req.body;
  const { rows } = await q("SELECT * FROM sellers WHERE phone=$1", [phone]);
  const seller = rows[0];
  if (!seller || !verifyPassword(password || "", seller.password_salt, seller.password_hash)) {
    return res.status(401).json({ error: "Telefone ou palavra-passe incorretos." });
  }
  res.json({ seller: safeSeller(seller) });
}));

// ---------- Lojas (até 2 por vendedor; categoria da loja define o que pode vender) ----------
app.get("/api/sellers/:id/stores", asyncRoute(async (req, res) => {
  const { rows } = await q(
    `SELECT id, name, description, category, store_slug AS slug, status,
       (SELECT COUNT(*) FROM products p WHERE p.store_id=stores.id AND p.active=TRUE) product_count
     FROM stores WHERE seller_id=$1 ORDER BY id ASC`,
    [req.params.id]
  );
  res.json(rows);
}));
app.post("/api/stores", asyncRoute(async (req, res) => {
  const { seller_id, name, description, category, image } = req.body;
  if (!name || !category) return res.status(400).json({ error: "Nome e categoria da loja são obrigatórios." });
  if (!DEFAULT_CATEGORIES.includes(category)) return res.status(400).json({ error: "Categoria inválida." });
  const { rows: srows } = await q("SELECT account_status FROM sellers WHERE id=$1", [seller_id]);
  if (!srows[0]) return res.status(404).json({ error: "Vendedor não encontrado." });
  if (srows[0].account_status !== "ATIVO") return res.status(403).json({ error: "A sua conta não está autorizada a criar lojas." });
  const { rows: count } = await q("SELECT COUNT(*) n FROM stores WHERE seller_id=$1", [seller_id]);
  if (Number(count[0].n) >= MAX_STORES_PER_SELLER) {
    return res.status(403).json({ error: `Já tem o máximo de ${MAX_STORES_PER_SELLER} lojas permitidas por vendedor.` });
  }
  let slug = slugify(name) || "loja-" + Date.now();
  let n = 1;
  while ((await q("SELECT id FROM stores WHERE store_slug=$1", [slug])).rows[0]) slug = slugify(name) + "-" + n++;
  const { rows } = await q(
    "INSERT INTO stores(seller_id, category, name, description, image, store_slug) VALUES($1,$2,$3,$4,$5,$6) RETURNING id, name, description, category, store_slug AS slug, status",
    [seller_id, category, name.trim(), description || "", image || "", slug]
  );
  res.json({ store: rows[0] });
}));
app.get("/api/admin/stores", requireAdmin, asyncRoute(async (req, res) => {
  const { rows } = await q(
    `SELECT st.id, st.name, st.category, st.status, st.store_slug AS slug, se.name seller_name, se.id seller_id
     FROM stores st JOIN sellers se ON se.id=st.seller_id ORDER BY st.id DESC`
  );
  res.json(rows);
}));
app.patch("/api/admin/stores/:id/status", requireAdmin, asyncRoute(async (req, res) => {
  const s = req.body.status;
  if (!["ATIVA", "BLOQUEADA"].includes(s)) return res.status(400).json({ error: "Estado inválido." });
  await q("UPDATE stores SET status=$1 WHERE id=$2", [s, req.params.id]);
  res.json({ ok: true });
}));

// ---------- Produtos (CompreJá: catálogo público) ----------
app.get("/api/products", asyncRoute(async (req, res) => {
  const term = (req.query.q || "").toLowerCase();
  const category = req.query.category || "";
  const { rows } = await q(
    `SELECT p.*, st.name store_name, st.store_slug, st.category store_category, se.name seller_name
     FROM products p
     JOIN stores st ON st.id=p.store_id
     JOIN sellers se ON se.id=st.seller_id
     WHERE p.active=TRUE AND p.stock>0 AND st.status='ATIVA' AND se.account_status='ATIVO'
     ORDER BY p.id DESC`
  );
  const filtered = rows.filter((p) =>
    (!category || p.store_category === category) &&
    (p.name + " " + (p.description || "") + " " + p.store_name + " " + p.seller_name).toLowerCase().includes(term)
  );
  res.json(filtered);
}));
app.post("/api/products", asyncRoute(async (req, res) => {
  const { seller_id, store_id, name, description, price, image, stock } = req.body;
  if (!name || !price || !store_id) return res.status(400).json({ error: "Loja, nome e preço são obrigatórios." });
  const { rows } = await q(
    "SELECT st.status store_status, st.seller_id owner_id, se.account_status FROM stores st JOIN sellers se ON se.id=st.seller_id WHERE st.id=$1",
    [store_id]
  );
  const store = rows[0];
  if (!store) return res.status(404).json({ error: "Loja não encontrada." });
  if (store.owner_id !== Number(seller_id)) return res.status(403).json({ error: "Essa loja não pertence a este vendedor." });
  if (store.account_status !== "ATIVO" || store.store_status !== "ATIVA") return res.status(403).json({ error: "A loja ou a conta do vendedor não está autorizada a publicar." });
  const { rows: inserted } = await q(
    "INSERT INTO products(store_id, name, description, price, image, stock) VALUES($1,$2,$3,$4,$5,$6) RETURNING id",
    [store_id, name, description || "", Number(price), image || "", Number(stock || 1)]
  );
  res.json({ id: inserted[0].id });
}));
app.get("/api/store/:slug", asyncRoute(async (req, res) => {
  const { rows } = await q(
    `SELECT st.id, st.name, st.description, st.category, st.store_slug AS slug, st.status, se.account_status
     FROM stores st JOIN sellers se ON se.id=st.seller_id WHERE st.store_slug=$1`,
    [req.params.slug]
  );
  const store = rows[0];
  if (!store || store.status !== "ATIVA" || store.account_status !== "ATIVO") return res.status(404).json({ error: "Loja não encontrada." });
  const { rows: products } = await q(
    "SELECT id, name, description, price, image, stock FROM products WHERE store_id=$1 AND active=TRUE AND stock>0",
    [store.id]
  );
  store.products = products;
  res.json(store);
}));

// ---------- Suporte ----------
app.get("/api/support/seller/:id", asyncRoute(async (req, res) => {
  const { rows } = await q("SELECT * FROM support_tickets WHERE seller_id=$1 ORDER BY id DESC", [req.params.id]);
  res.json(rows);
}));
app.post("/api/support", asyncRoute(async (req, res) => {
  const { seller_id, category, subject, message } = req.body;
  const { rows } = await q("SELECT id FROM sellers WHERE id=$1", [seller_id]);
  if (!rows[0]) return res.status(404).json({ error: "Vendedor não encontrado." });
  if (!category || !subject || !message) return res.status(400).json({ error: "Categoria, assunto e mensagem são obrigatórios." });
  const { rows: inserted } = await q(
    "INSERT INTO support_tickets(seller_id, category, subject, message) VALUES($1,$2,$3,$4) RETURNING id",
    [seller_id, category, subject.trim(), message.trim()]
  );
  res.json({ ticket_id: inserted[0].id, status: "ABERTO", message: "Pedido de suporte enviado à RevendeJá." });
}));
app.post("/api/support/:id/reply", requireAdmin, asyncRoute(async (req, res) => {
  const { reply, status } = req.body;
  if (!reply) return res.status(400).json({ error: "A resposta é obrigatória." });
  const st = ["ABERTO", "EM_ATENDIMENTO", "RESOLVIDO"].includes(status) ? status : "EM_ATENDIMENTO";
  const { rowCount } = await q("UPDATE support_tickets SET admin_reply=$1, status=$2, updated_at=now() WHERE id=$3", [reply.trim(), st, req.params.id]);
  if (!rowCount) return res.status(404).json({ error: "Atendimento não encontrado." });
  res.json({ ok: true });
}));
app.patch("/api/support/:id/status", requireAdmin, asyncRoute(async (req, res) => {
  const st = req.body.status;
  if (!["ABERTO", "EM_ATENDIMENTO", "RESOLVIDO"].includes(st)) return res.status(400).json({ error: "Estado inválido." });
  const { rowCount } = await q("UPDATE support_tickets SET status=$1, updated_at=now() WHERE id=$2", [st, req.params.id]);
  if (!rowCount) return res.status(404).json({ error: "Atendimento não encontrado." });
  res.json({ ok: true });
}));
app.get("/api/admin/support", requireAdmin, asyncRoute(async (req, res) => {
  const { rows } = await q(
    `SELECT t.*, s.name seller_name, s.phone seller_phone FROM support_tickets t
     JOIN sellers s ON s.id=t.seller_id
     ORDER BY CASE t.status WHEN 'ABERTO' THEN 0 WHEN 'EM_ATENDIMENTO' THEN 1 ELSE 2 END, t.id DESC`
  );
  res.json(rows);
}));

// ---------- Painel do vendedor (RevendeJá) ----------
app.get("/api/sellers/:id/dashboard", asyncRoute(async (req, res) => {
  const { rows: srows } = await q("SELECT * FROM sellers WHERE id=$1", [req.params.id]);
  const seller = srows[0];
  if (!seller) return res.status(404).json({ error: "Vendedor não encontrado." });
  const { rows: stores } = await q(
    `SELECT id, name, description, category, store_slug AS slug, status
     FROM stores WHERE seller_id=$1 ORDER BY id ASC`,
    [seller.id]
  );
  const { rows: statsRows } = await q(
    "SELECT COUNT(*) orders, COALESCE(SUM(total),0) sales, COALESCE(SUM(commission),0) commissions FROM orders WHERE seller_id=$1 AND payment_status='ENTREGUE'",
    [seller.id]
  );
  const { rows: overdueRows } = await q(
    "SELECT COUNT(*) n, COALESCE(SUM(commission),0) amount FROM orders WHERE seller_id=$1 AND commission_status='PENDENTE' AND commission_due_at IS NOT NULL AND commission_due_at < now()",
    [seller.id]
  );
  const { rows: orders } = await q(
    `SELECT o.*, p.name product_name, st.name store_name FROM orders o
     JOIN products p ON p.id=o.product_id JOIN stores st ON st.id=o.store_id
     WHERE o.seller_id=$1 ORDER BY o.id DESC`,
    [seller.id]
  );
  const { rows: products } = await q(
    `SELECT p.*, st.name store_name FROM products p JOIN stores st ON st.id=p.store_id
     WHERE st.seller_id=$1 ORDER BY p.id DESC`,
    [seller.id]
  );
  const { rows: payments } = await q("SELECT * FROM commission_payments WHERE seller_id=$1 ORDER BY id DESC", [seller.id]);
  res.json({ seller: safeSeller(seller), stores, max_stores: MAX_STORES_PER_SELLER, stats: statsRows[0], overdue: overdueRows[0], orders, products, payments });
}));

// ---------- Pedidos ----------
app.post("/api/orders", asyncRoute(async (req, res) => {
  const { product_id, customer_name, customer_phone, quantity, payment_method } = req.body;
  const qty = Number(quantity || 1);
  const { rows } = await q(
    `SELECT p.*, st.id store_id, st.status store_status, se.id seller_id, se.name seller_name, se.phone seller_phone,
            se.account_status, se.commission_due, se.commission_limit
     FROM products p JOIN stores st ON st.id=p.store_id JOIN sellers se ON se.id=st.seller_id
     WHERE p.id=$1 AND p.active=TRUE`,
    [product_id]
  );
  const product = rows[0];
  if (!product) return res.status(404).json({ error: "Produto não encontrado." });
  if (product.account_status !== "ATIVO" || product.store_status !== "ATIVA") return res.status(403).json({ error: "Este vendedor está temporariamente bloqueado para novas vendas." });
  if (product.commission_due >= product.commission_limit) {
    return res.status(403).json({ error: `O vendedor atingiu o limite de comissão em dívida (${product.commission_limit} MT). Regularize a comissão para voltar a aceitar pedidos.` });
  }
  if (qty < 1 || qty > product.stock) return res.status(400).json({ error: "Stock insuficiente." });

  const total = product.price * qty;
  const commission = Math.round(total * COMMISSION_RATE);
  const net = total - commission;
  const dueAt = new Date(Date.now() + DEADLINE_DAYS * 86400000).toISOString();

  const client = await pool.connect();
  let orderId;
  try {
    await client.query("BEGIN");
    await client.query("UPDATE products SET stock=stock-$1 WHERE id=$2", [qty, product.id]);
    const { rows: orows } = await client.query(
      `INSERT INTO orders(product_id, store_id, seller_id, customer_name, customer_phone, quantity, unit_price, total,
         commission, seller_net, payment_status, status, commission_status, commission_due_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'PENDENTE','NOVO','PENDENTE',$11) RETURNING id`,
      [product.id, product.store_id, product.seller_id, customer_name, customer_phone, qty, product.price, total, commission, net, dueAt]
    );
    orderId = orows[0].id;
    await client.query("UPDATE sellers SET commission_due=commission_due+$1, last_commission_at=$2 WHERE id=$3", [commission, dueAt, product.seller_id]);
    await client.query(
      "INSERT INTO transactions(seller_id, order_id, type, amount, description) VALUES($1,$2,'COMISSAO_DEVIDA',$3,'Comissão gerada pela venda')",
      [product.seller_id, orderId, commission]
    );
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }

  const waText = `Olá ${product.seller_name}! Fiz um pedido na RevendeJá:\n#${orderId} - ${product.name} x${qty}\nTotal: ${total} MT\nMeu nome: ${customer_name}\nMeu contacto: ${customer_phone}`;
  const whatsapp_notify_url = `https://wa.me/${waNumber(product.seller_phone)}?text=${encodeURIComponent(waText)}`;

  res.json({
    order_id: orderId, total, commission, seller_net: net, payment_to_seller: true,
    payment_method: payment_method || "combinado", whatsapp_notify_url,
    message: "Pedido criado. O cliente paga ao vendedor. A comissão fica registada como dívida do vendedor à RevendeJá.",
  });
}));

app.patch("/api/orders/:id/status", asyncRoute(async (req, res) => {
  const { rows } = await q("SELECT * FROM orders WHERE id=$1", [req.params.id]);
  const order = rows[0];
  if (!order) return res.status(404).json({ error: "Pedido não encontrado." });
  const status = req.body.status;
  if (!["NOVO", "PAGO_AO_VENDEDOR", "EM_PREPARACAO", "ENVIADO", "ENTREGUE", "CANCELADO"].includes(status)) {
    return res.status(400).json({ error: "Estado inválido." });
  }
  if (status === "CANCELADO" && order.commission_status === "PENDENTE") {
    await q("UPDATE sellers SET commission_due=GREATEST(0,commission_due-$1) WHERE id=$2", [order.commission, order.seller_id]);
    await q("UPDATE products SET stock=stock+$1 WHERE id=$2", [order.quantity, order.product_id]);
    await q("UPDATE orders SET payment_status='CANCELADO', commission_status='CANCELADO', status='CANCELADO' WHERE id=$1", [order.id]);
  } else {
    await q("UPDATE orders SET status=$1, payment_status=$2 WHERE id=$3", [status, status === "PAGO_AO_VENDEDOR" ? "PAGO" : order.payment_status, order.id]);
  }
  res.json({ ok: true });
}));

// ---------- Comissão: pagamento manual ----------
app.post("/api/commission/pay", asyncRoute(async (req, res) => {
  const { seller_id, amount, method, reference, proof } = req.body;
  const { rows } = await q("SELECT * FROM sellers WHERE id=$1", [seller_id]);
  const seller = rows[0];
  const amt = Number(amount);
  if (!seller) return res.status(404).json({ error: "Vendedor não encontrado." });
  if (amt <= 0 || amt > seller.commission_due) return res.status(400).json({ error: "Valor de comissão inválido." });
  const { rows: inserted } = await q(
    "INSERT INTO commission_payments(seller_id, amount, method, reference, proof) VALUES($1,$2,$3,$4,$5) RETURNING id",
    [seller_id, amt, method || "", reference || "", proof || ""]
  );
  res.json({ payment_id: inserted[0].id, status: "PENDENTE", message: "Comprovativo enviado. A comissão só será baixada após validação da plataforma." });
}));

// ---------- Comissão: pagamento automático via agregador ----------
app.post("/api/commission/pay/auto", asyncRoute(async (req, res) => {
  if (!paymentGatewayConfigured()) {
    return res.status(400).json({ error: "O pagamento automático ainda não está configurado. Use 'Pagar comissão' (comprovativo manual) por agora." });
  }
  const { seller_id, amount, phone } = req.body;
  const { rows } = await q("SELECT * FROM sellers WHERE id=$1", [seller_id]);
  const seller = rows[0];
  const amt = Number(amount);
  if (!seller) return res.status(404).json({ error: "Vendedor não encontrado." });
  if (amt <= 0 || amt > seller.commission_due) return res.status(400).json({ error: "Valor de comissão inválido." });
  const { rows: inserted } = await q(
    "INSERT INTO commission_payments(seller_id, amount, method, reference, status) VALUES($1,$2,'GATEWAY','',DEFAULT) RETURNING id",
    [seller_id, amt]
  );
  const paymentId = inserted[0].id;
  const reference = `commission-${paymentId}`;
  await q("UPDATE commission_payments SET reference=$1 WHERE id=$2", [reference, paymentId]);
  const charge = await providerCreateCharge({ amount: amt, phone: phone || seller.phone, reference, description: `Comissão RevendeJá #${paymentId}` });
  res.json({ payment_id: paymentId, provider: charge, message: "Pedido de pagamento enviado ao seu telemóvel. Confirme no M-Pesa/e-Mola." });
}));
app.post("/api/payments/webhook", asyncRoute(async (req, res) => {
  const secretHeader = req.headers["x-callback-secret"];
  if (!PAYMENT_CALLBACK_SECRET || secretHeader !== PAYMENT_CALLBACK_SECRET) {
    return res.status(401).json({ error: "Assinatura de callback inválida." });
  }
  const { reference, status } = req.body;
  if (!reference) return res.status(400).json({ error: "reference em falta." });
  if (!["success", "paid", "APROVADO"].includes(status)) return res.json({ ok: true, ignored: true });
  const { rows } = await q("SELECT id FROM commission_payments WHERE reference=$1 AND status='PENDENTE'", [reference]);
  if (!rows[0]) return res.json({ ok: true, note: "Pagamento já processado ou não encontrado." });
  await approveCommissionPayment(rows[0].id);
  res.json({ ok: true });
}));

// ---------- Administração ----------
app.post("/api/admin/login", asyncRoute(async (req, res) => {
  const { password } = req.body;
  if (!ADMIN_PASSWORD) return res.status(500).json({ error: "ADMIN_PASSWORD não está configurada no servidor." });
  const a = Buffer.from(String(password || ""));
  const b = Buffer.from(ADMIN_PASSWORD);
  const match = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!match) return res.status(401).json({ error: "Palavra-passe incorreta." });
  const token = signAdminToken();
  const secure = (req.headers["x-forwarded-proto"] || req.protocol) === "https";
  res.setHeader("Set-Cookie", `${ADMIN_COOKIE}=${encodeURIComponent(token)}; HttpOnly; Path=/; Max-Age=${ADMIN_SESSION_HOURS * 3600}; SameSite=Lax${secure ? "; Secure" : ""}`);
  res.json({ ok: true });
}));
app.post("/api/admin/logout", (req, res) => {
  res.setHeader("Set-Cookie", `${ADMIN_COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`);
  res.json({ ok: true });
});

app.post("/api/admin/commission/approve", requireAdmin, asyncRoute(async (req, res) => {
  const seller = await approveCommissionPayment(req.body.payment_id);
  res.json({ ok: true, seller: safeSeller(seller) });
}));
app.get("/api/admin/commission/pending", requireAdmin, asyncRoute(async (req, res) => {
  const { rows } = await q(
    "SELECT cp.*, s.name seller_name FROM commission_payments cp JOIN sellers s ON s.id=cp.seller_id WHERE cp.status='PENDENTE' ORDER BY cp.id ASC"
  );
  res.json(rows);
}));
app.get("/api/admin/summary", requireAdmin, asyncRoute(async (req, res) => {
  const sellers = (await q("SELECT COUNT(*) n FROM sellers")).rows[0].n;
  const stores = (await q("SELECT COUNT(*) n FROM stores")).rows[0].n;
  const orders = (await q("SELECT COUNT(*) n FROM orders")).rows[0].n;
  const totals = (await q("SELECT COALESCE(SUM(total),0) sales, COALESCE(SUM(commission),0) commissions FROM orders WHERE status!='CANCELADO'")).rows[0];
  const due = (await q("SELECT COALESCE(SUM(commission_due),0) due FROM sellers")).rows[0].due;
  res.json({
    sellers: Number(sellers), stores: Number(stores), orders: Number(orders),
    sales: Number(totals.sales), commissions: Number(totals.commissions), commission_generated: Number(totals.commissions),
    commission_due: Number(due), rate: COMMISSION_RATE, default_limit: DEFAULT_LIMIT, deadline_days: DEADLINE_DAYS,
  });
}));
app.get("/api/admin/sellers", requireAdmin, asyncRoute(async (req, res) => {
  const { rows } = await q(
    `SELECT se.id, se.name, se.phone, se.account_status, se.balance, se.commission_due, se.commission_limit, se.trust_level, se.approved_payments,
       (SELECT COUNT(*) FROM stores st WHERE st.seller_id=se.id) stores
     FROM sellers se ORDER BY se.id DESC`
  );
  res.json(rows);
}));
app.patch("/api/admin/sellers/:id/status", requireAdmin, asyncRoute(async (req, res) => {
  const s = req.body.status;
  if (!["ATIVO", "BLOQUEADO", "SUSPENSO"].includes(s)) return res.status(400).json({ error: "Estado inválido." });
  await q("UPDATE sellers SET account_status=$1 WHERE id=$2", [s, req.params.id]);
  res.json({ ok: true });
}));
app.delete("/api/admin/sellers/:id", requireAdmin, asyncRoute(async (req, res) => {
  const sellerId = req.params.id;
  const { rows } = await q("SELECT id, name FROM sellers WHERE id=$1", [sellerId]);
  if (!rows[0]) return res.status(404).json({ error: "Vendedor não encontrado." });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "DELETE FROM commission_allocations WHERE order_id IN (SELECT id FROM orders WHERE seller_id=$1) OR payment_id IN (SELECT id FROM commission_payments WHERE seller_id=$1)",
      [sellerId]
    );
    await client.query("DELETE FROM orders WHERE seller_id=$1", [sellerId]);
    await client.query("DELETE FROM products WHERE store_id IN (SELECT id FROM stores WHERE seller_id=$1)", [sellerId]);
    await client.query("DELETE FROM stores WHERE seller_id=$1", [sellerId]);
    await client.query("DELETE FROM commission_payments WHERE seller_id=$1", [sellerId]);
    await client.query("DELETE FROM support_tickets WHERE seller_id=$1", [sellerId]);
    await client.query("DELETE FROM transactions WHERE seller_id=$1", [sellerId]);
    await client.query("DELETE FROM sellers WHERE id=$1", [sellerId]);
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
  res.json({ ok: true, deleted: rows[0].name });
}));

app.use((req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

initSchema()
  .then(() => app.listen(PORT, () => console.log(`RevendeJá V9 em http://localhost:${PORT}`)))
  .catch((e) => {
    console.error("Falha ao preparar a base de dados:", e);
    process.exit(1);
  });
