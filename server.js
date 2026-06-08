const express = require('express');
const QRCode = require('qrcode');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let menuItems = [
  { id: '1', name: 'Nasi Goreng Spesial', price: 25000, cat: 'Makanan', desc: 'Telur, ayam, acar segar', active: true },
  { id: '2', name: 'Mie Ayam Bakso', price: 22000, cat: 'Makanan', desc: 'Kuah kaldu sapi, porsi besar', active: true },
  { id: '3', name: 'Es Teh Manis', price: 8000, cat: 'Minuman', desc: 'Teh premium, es batu', active: true },
  { id: '4', name: 'Kopi Susu', price: 15000, cat: 'Minuman', desc: 'Arabika + susu segar', active: true },
  { id: '5', name: 'Pisang Goreng', price: 12000, cat: 'Snack', desc: '5 pcs, crispy golden', active: true },
];

let orders = [];
let tables = [1, 2, 3, 4, 5];
let doneCount = 0;
let sseClients = [];

// Simpan idempotency keys agar order yang sama tidak masuk 2x
// Key = string unik dari client, expired setelah 10 menit
const recentKeys = new Map();
function cleanOldKeys() {
  const now = Date.now();
  for (const [k, t] of recentKeys) {
    if (now - t > 10 * 60 * 1000) recentKeys.delete(k);
  }
}
setInterval(cleanOldKeys, 60000);

function getBaseUrl(req) {
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto.split(',')[0].trim()}://${host}`;
}

// ── SSE ───────────────────────────────────────────────────────────
app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  const client = { id: uuidv4(), res };
  sseClients.push(client);
  const keepAlive = setInterval(() => res.write(': ping\n\n'), 20000);
  req.on('close', () => {
    clearInterval(keepAlive);
    sseClients = sseClients.filter(c => c.id !== client.id);
  });
});

function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach(c => { try { c.res.write(msg); } catch(e){} });
}

// ── Menu ──────────────────────────────────────────────────────────
app.get('/api/menu', (req, res) => res.json(menuItems));

app.post('/api/menu', (req, res) => {
  const { name, price, cat, desc } = req.body;
  if (!name || !price) return res.status(400).json({ error: 'Nama dan harga wajib diisi' });
  const item = { id: uuidv4(), name, price: parseInt(price), cat: cat || 'Makanan', desc: desc || '', active: true };
  menuItems.push(item);
  broadcast('menu-update', menuItems);
  res.json(item);
});

app.patch('/api/menu/:id', (req, res) => {
  const item = menuItems.find(m => m.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'Tidak ditemukan' });
  Object.assign(item, req.body);
  broadcast('menu-update', menuItems);
  res.json(item);
});

app.delete('/api/menu/:id', (req, res) => {
  menuItems = menuItems.filter(m => m.id !== req.params.id);
  broadcast('menu-update', menuItems);
  res.json({ ok: true });
});

// ── Orders ────────────────────────────────────────────────────────
app.get('/api/orders', (req, res) => res.json({ orders, doneCount }));

app.post('/api/orders', (req, res) => {
  const { tableNum, items, notes, idempotencyKey } = req.body;

  if (!tableNum || !items || !items.length)
    return res.status(400).json({ error: 'Data tidak lengkap' });

  // Cek duplikat: kalau key yang sama sudah pernah masuk, kembalikan OK tanpa buat order baru
  if (idempotencyKey) {
    if (recentKeys.has(idempotencyKey)) {
      const existingOrder = orders.find(o => o.idempotencyKey === idempotencyKey);
      return res.json(existingOrder || { ok: true, duplicate: true });
    }
    recentKeys.set(idempotencyKey, Date.now());
  }

  // Cek duplikat tambahan: order dari meja yang sama dalam 10 detik terakhir dengan item yang sama
  const itemsStr = JSON.stringify(items.map(i => `${i.id}:${i.qty}`).sort());
  const recentDuplicate = orders.find(o => {
    const oItemsStr = JSON.stringify((o.items || []).map(i => `${i.id}:${i.qty}`).sort());
    return o.tableNum == tableNum &&
           oItemsStr === itemsStr &&
           (Date.now() - o.createdAt) < 10000; // 10 detik
  });

  if (recentDuplicate) {
    return res.json({ ok: true, duplicate: true, id: recentDuplicate.id });
  }

  const order = {
    id: 'ORD-' + Date.now(),
    table: 'Meja ' + tableNum,
    tableNum,
    time: new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }),
    items,
    notes: notes || '',
    status: 'antri',
    createdAt: Date.now(),
    idempotencyKey: idempotencyKey || null,
  };

  orders.unshift(order);
  broadcast('new-order', order);
  res.json(order);
});

app.patch('/api/orders/:id', (req, res) => {
  const order = orders.find(o => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: 'Tidak ditemukan' });
  if (req.body.status === 'selesai') {
    orders = orders.filter(o => o.id !== req.params.id);
    doneCount++;
    broadcast('order-done', { id: req.params.id, doneCount });
  } else {
    order.status = req.body.status;
    broadcast('order-update', order);
  }
  res.json({ ok: true });
});

app.delete('/api/orders/:id', (req, res) => {
  orders = orders.filter(o => o.id !== req.params.id);
  broadcast('order-cancel', { id: req.params.id });
  res.json({ ok: true });
});

// ── Tables ────────────────────────────────────────────────────────
app.get('/api/tables', (req, res) => res.json(tables));
app.post('/api/tables', (req, res) => {
  const next = tables.length ? Math.max(...tables) + 1 : 1;
  tables.push(next); res.json(tables);
});
app.delete('/api/tables/last', (req, res) => {
  if (tables.length > 1) tables.pop();
  res.json(tables);
});

// ── QR ────────────────────────────────────────────────────────────
app.get('/api/qr/:table', async (req, res) => {
  const tableNum = req.params.table;
  const base = getBaseUrl(req);
  const url = `${base}/menu.html?table=${tableNum}`;
  try {
    const qr = await QRCode.toDataURL(url, { width: 300, margin: 2, color: { dark: '#3C3489', light: '#FFFFFF' } });
    res.json({ qr, url });
  } catch (e) { res.status(500).json({ error: 'Gagal generate QR' }); }
});

// ── PWA Manifest ──────────────────────────────────────────────────
app.get('/manifest.json', (req, res) => {
  res.json({
    name: 'Kafe Nusantara — Dapur', short_name: 'Dapur',
    description: 'Dashboard koki Kafe Nusantara',
    start_url: '/', display: 'standalone',
    background_color: '#0F0E17', theme_color: '#D85A30',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png' }
    ]
  });
});

app.get('/icon-:size.png', (req, res) => {
  const size = parseInt(req.params.size) || 192;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><rect width="${size}" height="${size}" rx="${size*0.2}" fill="#D85A30"/><text x="50%" y="54%" font-size="${size*0.55}" text-anchor="middle" dominant-baseline="middle" font-family="serif">☕</text></svg>`;
  res.setHeader('Content-Type', 'image/svg+xml');
  res.send(svg);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅  Server jalan di http://localhost:${PORT}`));
