const express = require('express');
const QRCode = require('qrcode');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── In-memory state ──────────────────────────────────────────────
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

// ── SSE (real-time push to koki dashboard) ───────────────────────
app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const client = { id: uuidv4(), res };
  sseClients.push(client);

  const keepAlive = setInterval(() => res.write(': ping\n\n'), 15000);

  req.on('close', () => {
    clearInterval(keepAlive);
    sseClients = sseClients.filter(c => c.id !== client.id);
  });
});

function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach(c => c.res.write(msg));
}

// ── Menu API ─────────────────────────────────────────────────────
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
  if (!item) return res.status(404).json({ error: 'Menu tidak ditemukan' });
  Object.assign(item, req.body);
  broadcast('menu-update', menuItems);
  res.json(item);
});

app.delete('/api/menu/:id', (req, res) => {
  menuItems = menuItems.filter(m => m.id !== req.params.id);
  broadcast('menu-update', menuItems);
  res.json({ ok: true });
});

// ── Orders API ───────────────────────────────────────────────────
app.get('/api/orders', (req, res) => res.json({ orders, doneCount }));

app.post('/api/orders', (req, res) => {
  const { tableNum, items, notes } = req.body;
  if (!tableNum || !items || items.length === 0)
    return res.status(400).json({ error: 'Data pesanan tidak lengkap' });

  const order = {
    id: 'ORD-' + Date.now(),
    table: 'Meja ' + tableNum,
    tableNum,
    time: new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }),
    items,
    notes: notes || '',
    status: 'antri',
    createdAt: Date.now(),
  };
  orders.unshift(order);
  broadcast('new-order', order);
  res.json(order);
});

app.patch('/api/orders/:id', (req, res) => {
  const order = orders.find(o => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: 'Pesanan tidak ditemukan' });
  const { status } = req.body;
  if (status === 'selesai') {
    orders = orders.filter(o => o.id !== req.params.id);
    doneCount++;
    broadcast('order-done', { id: req.params.id, doneCount });
  } else {
    order.status = status;
    broadcast('order-update', order);
  }
  res.json({ ok: true });
});

app.delete('/api/orders/:id', (req, res) => {
  orders = orders.filter(o => o.id !== req.params.id);
  broadcast('order-cancel', { id: req.params.id });
  res.json({ ok: true });
});

// ── Tables API ───────────────────────────────────────────────────
app.get('/api/tables', (req, res) => res.json(tables));

app.post('/api/tables', (req, res) => {
  const next = tables.length ? Math.max(...tables) + 1 : 1;
  tables.push(next);
  res.json(tables);
});

app.delete('/api/tables/last', (req, res) => {
  if (tables.length > 1) tables.pop();
  res.json(tables);
});

// ── QR Code API ──────────────────────────────────────────────────
app.get('/api/qr/:table', async (req, res) => {
  const tableNum = req.params.table;
  const host = req.headers.host || 'localhost:3000';
  const protocol = req.headers['x-forwarded-proto'] || 'http';
  const url = `${protocol}://${host}/menu.html?table=${tableNum}`;
  try {
    const qrDataUrl = await QRCode.toDataURL(url, {
      width: 300,
      margin: 2,
      color: { dark: '#3C3489', light: '#FFFFFF' }
    });
    res.json({ qr: qrDataUrl, url });
  } catch (e) {
    res.status(500).json({ error: 'Gagal generate QR' });
  }
});

// ── Stats ─────────────────────────────────────────────────────────
app.get('/api/stats', (req, res) => {
  const antri = orders.filter(o => o.status === 'antri').length;
  const masak = orders.filter(o => o.status === 'masak').length;
  res.json({ antri, masak, doneCount });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅  Server jalan di http://localhost:${PORT}`));
