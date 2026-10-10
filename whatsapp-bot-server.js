const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = Buffer.from(buf); } }));

// ---------- CONFIG ----------
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://glkutdkwbrjpiuqcmgwe.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY; 
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'my_verify_token';
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');

// DELIVERY FEE CONSTANTS
const BASE_FEE = 1000;
const BASE_DISTANCE_KM = 3;
const EXTRA_PER_KM = 300;

const FLOW_ID = process.env.FLOW_ID || '';            
const FLOW_MODE = process.env.FLOW_MODE || 'published'; 

if (!SUPABASE_SERVICE_KEY) console.error('❌ SUPABASE_SERVICE_KEY is missing.');

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY || 'missing', {
  auth: { persistSession: false, autoRefreshToken: false }
});

// ---------- DELIVERY FEE HELPERS ----------
// Haversine formula to calculate distance between two points in km
function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371; // Earth's radius in km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c; 
}

function calculateDeliveryFee(distanceKm) {
  if (distanceKm <= BASE_DISTANCE_KM) return BASE_FEE;
  const extraKm = distanceKm - BASE_DISTANCE_KM;
  return Math.round(BASE_FEE + (extraKm * EXTRA_PER_KM));
}

// ---------- SESSIONS ----------
const sessions = {};
function getSession(phone) {
  if (!sessions[phone]) sessions[phone] = { cart: [], step: 'IDLE', vendorId: null, vendorName: '', address: '', note: '', activeItemId: null, menuPage: 0, flowItems: [], flowPage: 0, lastCategory: null, tempLastOrder: null, deliveryFee: BASE_FEE, distanceKm: 0 };
  return sessions[phone];
}
function resetSession(s) { 
  s.cart = []; s.step = 'IDLE'; s.vendorId = null; s.vendorName = ''; s.address = ''; s.note = ''; 
  s.activeItemId = null; s.menuPage = 0; s.flowItems = []; s.flowPage = 0; s.lastCategory = null; s.tempLastOrder = null; s.deliveryFee = BASE_FEE; s.distanceKm = 0;
}
const cartTotal = (cart) => cart.reduce((sum, i) => sum + i.price * i.qty, 0);
const naira = (n) => '₦' + Number(n).toLocaleString();

const seen = new Set();
function alreadySeen(id) {
  if (!id) return false;
  if (seen.has(id)) return true;
  seen.add(id);
  if (seen.size > 2000) seen.delete(seen.values().next().value);
  return false;
}


// ---------- PAYSTACK CHECKOUT ----------
async function paystackRequest(path, body) {
  if (!PAYSTACK_SECRET_KEY) throw new Error('PAYSTACK_SECRET_KEY is not configured');
  const response = await axios.post(`https://api.paystack.co/${path}`, body, {
    headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json' },
    timeout: 20000
  });
  if (!response.data?.status) throw new Error(response.data?.message || 'Paystack request failed');
  return response.data.data;
}

async function verifyPaystackReference(reference) {
  if (!PAYSTACK_SECRET_KEY) throw new Error('PAYSTACK_SECRET_KEY is not configured');
  const response = await axios.get(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
    headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` }, timeout: 20000
  });
  if (!response.data?.status) throw new Error(response.data?.message || 'Payment verification failed');
  return response.data.data;
}

async function completePaidOrder(reference, transaction) {
  if (!transaction || transaction.status !== 'success' || transaction.reference !== reference || transaction.currency !== 'NGN') {
    throw new Error('Paystack transaction details did not pass validation');
  }
  const { data: order, error: findError } = await supabase.from('orders')
    .select('id, order_number, total, delivery_fee, payment_status, payment_reference, customer_phone, delivery_code, delivery_address, notes')
    .eq('payment_reference', reference).maybeSingle();
  if (findError || !order) throw new Error('No order found for payment reference');
  const expectedKobo = Math.round((Number(order.total) + Number(order.delivery_fee || 0)) * 100);
  if (!Number.isSafeInteger(expectedKobo) || Number(transaction.amount) !== expectedKobo) {
    throw new Error('Paid amount does not match the order total');
  }
  if (order.payment_status === 'paid') return order;
  const { data: updated, error: updateError } = await supabase.from('orders')
    .update({ payment_status: 'paid', payment_paid_at: new Date().toISOString(), status: 'new', wa_pending: false })
    .eq('id', order.id).neq('payment_status', 'paid')
    .select('id, order_number, customer_phone, total, delivery_fee, delivery_address, notes').maybeSingle();
  if (updateError) throw updateError;
  if (updated?.customer_phone) {
    await sendText(updated.customer_phone, `✅ *Payment successful!* Order ${updated.order_number} is now confirmed.\n\nFood: ${naira(updated.total)}\nDelivery: ${naira(updated.delivery_fee)}\n*Total paid: ${naira(Number(updated.total) + Number(updated.delivery_fee || 0))}*\n📍 ${updated.delivery_address || ''}${updated.notes ? `\n📝 Note: ${updated.notes}` : ''}\n\nYour delivery PIN will be shared when your rider is on the way.`);
  }
  return updated || order;
}

app.get('/paystack/callback', async (req, res) => {
  const reference = typeof req.query.reference === 'string' ? req.query.reference : '';
  if (!reference) return res.status(400).send('Missing payment reference.');
  try {
    const transaction = await verifyPaystackReference(reference);
    await completePaidOrder(reference, transaction);
    return res.status(200).send('<h2>Payment verified</h2><p>Return to WhatsApp for your order update.</p>');
  } catch (error) {
    console.error('Paystack callback verification failed:', error.response?.data || error.message);
    return res.status(400).send('<h2>Payment not confirmed</h2><p>Return to WhatsApp or contact support before trying to pay again.</p>');
  }
});

app.post('/paystack/webhook', async (req, res) => {
  const signature = req.headers['x-paystack-signature'];
  if (!PAYSTACK_SECRET_KEY || !signature || !req.rawBody) return res.sendStatus(401);
  const expected = crypto.createHmac('sha512', PAYSTACK_SECRET_KEY).update(req.rawBody).digest('hex');
  const a = Buffer.from(String(signature));
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.sendStatus(401);
  res.sendStatus(200);
  try {
    if (req.body?.event === 'charge.success' && req.body.data?.reference) {
      const reference = req.body.data.reference;
      const transaction = await verifyPaystackReference(reference);
      await completePaidOrder(reference, transaction);
    }
  } catch (error) {
    console.error('Paystack webhook processing failed:', error.response?.data || error.message);
  }
});

// ---------- WHATSAPP HELPERS ----------
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode && token === VERIFY_TOKEN) res.status(200).send(challenge);
  else res.sendStatus(403);
});

async function sendWhatsAppMessage(to, payload) {
  try {
    await axios.post(
      `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`,
      payload,
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } }
    );
    return true;
  } catch (err) {
    console.error('❌ Error sending WhatsApp message:', err.response?.data || err.message);
    return false;
  }
}

function sendText(to, body) { return sendWhatsAppMessage(to, { messaging_product: 'whatsapp', to, type: 'text', text: { body } }); }
function sendButtonMessage(to, bodyText, buttons) {
  return sendWhatsAppMessage(to, { messaging_product: 'whatsapp', to, type: 'interactive', interactive: { type: 'button', body: { text: bodyText }, action: { buttons: buttons.map(b => ({ type: 'reply', reply: { id: b.id, title: b.title } })) } } });
}
function sendList(to, header, body, button, sectionTitle, rows) {
  return sendWhatsAppMessage(to, { messaging_product: 'whatsapp', to, type: 'interactive', interactive: { type: 'list', header: { type: 'text', text: header }, body: { text: body }, action: { button, sections: [{ title: sectionTitle, rows }] } } });
}

// ---------- BOT STEPS ----------
async function sendMainMenu(to) {
  await sendList(to, 'David Delivery Network', 'Welcome! How can we assist you today?', 'Select Service', 'Available Services', [
    { id: 'service_food', title: '🍔 Order Food', description: 'Order from local restaurants' },
    { id: 'service_search', title: '🔍 Search', description: 'Find restaurants or dishes' }, 
    { id: 'service_ride', title: '🛺 Book a Ride', description: 'Request fast transport' },
    { id: 'service_package', title: '📦 Send a Package', description: 'Doorstep parcel delivery' }
  ]);
}

async function sendVendorList(to, page = 0, note = '') {
  const PAGE_SIZE = 6; 
  const start = page * PAGE_SIZE;
  const { count: totalCount } = await supabase.from('vendors').select('*', { count: 'exact', head: true }).eq('is_open', true);
  const { data: stores, error } = await supabase.from('vendors').select('id, store_name, address').eq('is_open', true).order('store_name', { ascending: true }).range(start, start + PAGE_SIZE - 1);

  if (error) { console.error(error.message); await sendText(to, 'Sorry, something went wrong.'); return; }
  if (!stores || stores.length === 0) { await sendText(to, 'No restaurants are currently open.'); return; }

  const rows = stores.map((s, i) => ({ id: `vendor_${s.id}`, title: (s.store_name || `Store ${i + 1}`).substring(0, 24), description: (s.address || 'View menu').substring(0, 72) }));
  const totalPages = Math.ceil((totalCount || 0) / PAGE_SIZE);
  if (totalPages > 1) {
    if (page > 0) rows.push({ id: `vendor_prev_${page - 1}`, title: '◀ Previous', description: `Page ${page} of ${totalPages}` });
    if (page + 1 < totalPages) rows.push({ id: `vendor_next_${page + 1}`, title: 'More ▶', description: `Page ${page + 2} of ${totalPages}` });
  }
  await sendList(to, 'Select Restaurant', 'Choose an open restaurant:', 'View Restaurants', 'Open Stores', rows);
}

async function sendMenuList(to, vendorId, page = 0, note = '', category = null) {
  const session = getSession(to);
  let query = supabase.from('menu_items').select('id, name, price').eq('vendor_id', vendorId).eq('in_stock', true);
  if (category && category !== 'all') query = query.eq('category', category);
  const { data: all, error } = await query.order('created_at', { ascending: true }).limit(200);
  if (error || !all || all.length === 0) { await sendText(to, 'No available menu items.'); return; }

  const cartRowCount = session.cart.length ? 2 : 0;
  const paged = all.length > 10 - cartRowCount;
  const pageSize = 6;
  let items = all;
  if (paged) {
    const maxPage = Math.ceil(all.length / pageSize) - 1;
    page = Math.min(Math.max(page, 0), maxPage);
    session.menuPage = page;
    items = all.slice(page * pageSize, page * pageSize + pageSize);
  }

  const qtyInCart = (id) => (session.cart.find(c => c.id === id) || {}).qty || 0;
  const itemRows = items.map((it, i) => ({ id: `item_${it.id}`, title: (it.name || `Item ${i + 1}`).substring(0, 24), description: `${naira(it.price)} | In cart: ${qtyInCart(it.id)}`.substring(0, 72) }));
  const sections = [{ title: 'Food Items', rows: itemRows }];

  const navRows = [{ id: 'nav_search_menu', title: '🔍 Search in Menu', description: 'Find a specific dish' }];
  if (category) navRows.push({ id: 'nav_categories', title: '📁 View Categories', description: 'Go back to categories' });
  if (paged) {
    const catParam = category ? `|${category}` : '';
    if (page > 0) navRows.push({ id: `page_${page - 1}${catParam}`, title: '◀ Previous', description: `Page ${page} of ${Math.ceil(all.length / pageSize)}` });
    if ((page + 1) * pageSize < all.length) navRows.push({ id: `page_${page + 1}${catParam}`, title: 'More ▶', description: `Page ${page + 2} of ${Math.ceil(all.length / pageSize)}` });
  }
  if (navRows.length) sections.push({ title: 'More', rows: navRows });

  if (session.cart.length) {
    const count = session.cart.reduce((n, c) => n + c.qty, 0);
    sections.push({ title: 'Your Cart', rows: [
      { id: 'nav_cart', title: '🛒 View Cart / Checkout', description: `${count} item(s) | ${naira(cartTotal(session.cart))}` },
      { id: 'nav_remove', title: '➖ Remove an item', description: 'Take away 1 of an item' }
    ]});
  }

  let body = note ? `${note}\n\n` : 'Tap an item to add it (+1).';
  if (session.cart.length) body += `\n\n🛒 Cart: ${naira(cartTotal(session.cart))}`;

  await sendWhatsAppMessage(to, { messaging_product: 'whatsapp', to, type: 'interactive', interactive: { type: 'list', header: { type: 'text', text: (session.vendorName || 'Menu').substring(0, 60) + (category && category !== 'all' ? ` - ${category}` : '') }, body: { text: body.substring(0, 1000) }, action: { button: 'Browse Menu', sections } } });
}

async function sendMenuFlow(to, vendorId, page = 0, note = '', category = null) {
  const session = getSession(to);
  let query = supabase.from('menu_items').select('id, name, price').eq('vendor_id', vendorId).eq('in_stock', true);
  if (category && category !== 'all') query = query.eq('category', category);
  const { data: all, error } = await query.order('created_at', { ascending: true }).limit(200);
  if (error || !all || all.length === 0) { await sendText(to, 'No available items.'); return; }
  
  const PER_SCREEN = 10;
  const maxPage = Math.ceil(all.length / PER_SCREEN) - 1;
  if (page > maxPage || page < 0) page = 0;
  session.flowPage = page;
  const items = all.slice(page * PER_SCREEN, page * PER_SCREEN + PER_SCREEN);
  session.flowItems = items.map(i => ({ id: i.id, name: i.name, price: Number(i.price) }));

  const data = { title: (session.vendorName || 'Menu').substring(0, 60) + (category ? ` - ${category}` : '') };
  for (let n = 1; n <= PER_SCREEN; n++) {
    const it = items[n - 1];
    data[`i${n}_text`] = it ? `${it.name} - ${naira(it.price)}` : ' ';
    data[`i${n}_show`] = !!it;
  }

  let body = note ? `${note}\n\n` : 'Tap *Select Items*, choose quantities, then tap *Add to Cart*.';
  if (all.length > PER_SCREEN) body += `\n\n📄 Menu page ${page + 1} of ${maxPage + 1}`;
  if (session.cart.length) body += `\n🛒 Cart: ${naira(cartTotal(session.cart))}`;

  const ok = await sendWhatsAppMessage(to, { messaging_product: 'whatsapp', to, type: 'interactive', interactive: { type: 'flow', body: { text: body.substring(0, 1000) }, action: { name: 'flow', parameters: { flow_message_version: '3', flow_id: FLOW_ID, flow_cta: 'Select Items', mode: FLOW_MODE, flow_token: `${to}:${Date.now()}`, flow_action: 'navigate', flow_action_payload: { screen: 'MENU', data } } } } });
  if (!ok) { await sendMenuList(to, vendorId, 0, note, category); }
}

async function sendMenu(to, vendorId, page = 0, note = '', category = null) {
  if (FLOW_ID) return sendMenuFlow(to, vendorId, page, note, category);
  return sendMenuList(to, vendorId, page, note, category);
}

async function performGlobalSearch(to, query, session) {
  if (!query || query.trim().length < 2) { await sendText(to, 'Enter a longer search term.'); return; }
  const q = `%${query.trim()}%`;
  const [vRes, iRes] = await Promise.all([
    supabase.from('vendors').select('id, store_name, address').ilike('store_name', q).eq('is_open', true).limit(6),
    supabase.from('menu_items').select('id, name, price, vendor_id, vendors(store_name)').ilike('name', q).eq('in_stock', true).limit(6)
  ]);
  const vendors = vRes.data || []; const items = iRes.data || [];
  if (vendors.length === 0 && items.length === 0) { await sendText(to, `❌ No results for "*${query}*".`); return; }
  const rows = [];
  vendors.forEach(v => rows.push({ id: `vendor_${v.id}`, title: `🏪 ${v.store_name}`.substring(0, 24), description: (v.address || 'View menu').substring(0, 72) }));
  items.forEach(it => rows.push({ id: `item_${it.id}`, title: `🍽️ ${it.name} - ${naira(it.price)}`.substring(0, 24), description: `From: ${it.vendors ? it.vendors.store_name : 'Restaurant'}`.substring(0, 72) }));
  await sendList(to, 'Search Results', `🔍 *Results for "${query}"*`, 'View Results', 'Matches', rows.slice(0, 10));
}

function cartSummary(cart) { return cart.map((i, idx) => `${idx + 1}. ${i.qty}x ${i.name} - ${naira(i.price * i.qty)}`).join('\n'); }
function sendCartView(to, session, note = '') {
  return sendButtonMessage(to, `${note ? note + '\n\n' : ''}🛒 *Your Cart*\n\n${cartSummary(session.cart)}\n\n*Food total:* ${naira(cartTotal(session.cart))}\n\n_Send *menu* any time to start over._`,
    [{ id: 'btn_add_more', title: '➕ Add Items' }, { id: 'btn_editcart', title: '➖ Remove Items' }, { id: 'btn_checkout', title: '✅ Checkout' }]);
}
function sendEditCartList(to, session) {
  const rows = session.cart.slice(0, 9).map(i => ({ id: `cartrm_${i.id}`, title: `${i.qty}x ${i.name}`.substring(0, 24), description: `${naira(i.price * i.qty)} | tap to remove 1` }));
  rows.push({ id: 'cart_clear', title: '🗑 Clear cart', description: 'Remove everything' });
  return sendList(to, 'Remove Items', 'Tap an item to remove 1:', 'Remove Items', 'Your Items', rows);
}

// ---------- WEBHOOK ----------
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    const value = req.body.entry?.[0]?.changes?.[0]?.value;
    const message = value?.messages?.[0];
    if (!message || alreadySeen(message.id)) return;

    const from = message.from;
    const profileName = value?.contacts?.[0]?.profile?.name || 'Customer';
    const text = message.text?.body ? message.text.body.trim() : '';
    const textLower = text.toLowerCase();
    const listId = message.interactive?.list_reply?.id;
    const btnId = message.interactive?.button_reply?.id;
    const location = message.location;

    const session = getSession(from);

    // FLOW SUBMISSION
    if (message.interactive?.type === 'nfm_reply') {
      let answers = {}; try { answers = JSON.parse(message.interactive.nfm_reply.response_json || '{}'); } catch (e) {}
      if (!session.vendorId || !session.flowItems.length) { await sendText(from, 'Session expired. Send *menu*.'); return; }
      const ids = session.flowItems.map(i => i.id);
      const { data: fresh } = await supabase.from('menu_items').select('id, name, price, in_stock').in('id', ids);
      const freshById = {}; (fresh || []).forEach(f => { freshById[f.id] = f; });
      const added = [], skipped = [];
      session.flowItems.forEach((it, idx) => {
        const q = Math.min(parseInt(answers['q' + (idx + 1)], 10) || 0, 20);
        if (q <= 0) return;
        const f = freshById[it.id];
        if (!f || !f.in_stock) { skipped.push(it.name); return; }
        let entry = session.cart.find(c => c.id === f.id);
        if (entry) entry.qty = Math.min(entry.qty + q, 20);
        else session.cart.push({ id: f.id, name: f.name, price: Number(f.price), qty: q });
        added.push(`• ${q}x ${f.name}`);
      });
      if (!added.length) { await sendMenu(from, session.vendorId, session.flowPage, skipped.length ? `Sold out: ${skipped.join(', ')}.` : 'No dish chosen.', session.lastCategory); return; }
      let note = `✅ *Added to cart:*\n${added.join('\n')}`;
      if (skipped.length) note += `\n\n⚠️ Sold out: ${skipped.join(', ')}`;
      await sendCartView(from, session, note);
      return;
    }


    // PAYSTACK EMAIL STEP: process before menu shortcuts
    if (session.step === 'AWAITING_PAYMENT_EMAIL' && text && !listId && !btnId) {
      const email = text.trim().toLowerCase();
      if (!/^\S+@\S+\.\S+$/.test(email)) {
        await sendText(from, 'Please enter a valid email address, for example name@example.com.');
        return;
      }
      if (!PAYSTACK_SECRET_KEY || !PUBLIC_BASE_URL) {
        await sendText(from, 'Online payment is not configured yet. Your order has not been placed. Please contact support.');
        session.step = 'AWAITING_CONFIRM';
        return;
      }
      if (session.cart.length === 0 || !session.vendorId) {
        await sendText(from, 'Your checkout session has expired. Send *menu* to start again.');
        resetSession(session);
        return;
      }
      let orderId = null;
      try {
        const { data: vendor } = await supabase.from('vendors').select('id, is_open').eq('id', session.vendorId).maybeSingle();
        if (!vendor || !vendor.is_open) {
          await sendText(from, 'The restaurant is no longer open. Send *menu* to choose another restaurant.');
          resetSession(session);
          return;
        }
        const subtotal = cartTotal(session.cart);
        const fee = Number(session.deliveryFee) || 0;
        const amountKobo = Math.round((subtotal + fee) * 100);
        if (!Number.isSafeInteger(amountKobo) || amountKobo < 100) throw new Error('Invalid order amount');
        const pin = crypto.randomInt(1000, 10000).toString();
        const orderNumber = '#' + Date.now().toString().slice(-6);
        const reference = 'QE-' + crypto.randomUUID();
        const { data: order, error: insertError } = await supabase.from('orders').insert({
          order_number: orderNumber, vendor_id: session.vendorId, customer_name: profileName, customer_phone: from,
          delivery_address: session.address, notes: session.note || null,
          items: session.cart.map(i => ({ id: i.id, name: i.name, qty: i.qty, price: i.price })),
          total: subtotal, delivery_fee: fee, status: 'awaiting_payment', delivery_code: pin, source: 'whatsapp',
          payment_status: 'unpaid', payment_reference: reference, wa_pending: false
        }).select('id').single();
        if (insertError) throw insertError;
        orderId = order.id;
        const payment = await paystackRequest('transaction/initialize', {
          email, amount: amountKobo, currency: 'NGN', reference,
          callback_url: `${PUBLIC_BASE_URL}/paystack/callback`,
          metadata: { order_id: order.id, order_number: orderNumber, customer_phone: from }
        });
        session.step = 'AWAITING_PAYMENT';
        await sendText(from, `🧾 Order ${orderNumber} created.\nTotal: ${naira(subtotal + fee)}\n\nPay securely using this Paystack link:\n${payment.authorization_url}\n\nYour order will only be confirmed after payment is verified. Do not share your delivery PIN.`);
      } catch (error) {
        console.error('Paystack checkout failed:', error.response?.data || error.message);
        if (orderId) {
          await supabase.from('orders').update({ status: 'cancelled' }).eq('id', orderId).eq('payment_status', 'unpaid');
        }
        await sendText(from, 'Sorry, I could not start payment. No order has been confirmed. Please try again or contact support.');
        session.step = 'AWAITING_CONFIRM';
      }
      return;
    }

    // MAIN MENU / CANCEL
    if (['hi', 'hello', 'start', 'menu'].includes(textLower) || btnId === 'btn_cancel') {
      resetSession(session);
      const { data: lastOrder } = await supabase.from('orders').select('*').eq('customer_phone', from).order('created_at', { ascending: false }).limit(1).maybeSingle();
      if (lastOrder && lastOrder.items && lastOrder.items.length > 0) {
         session.tempLastOrder = lastOrder;
         await sendButtonMessage(from, 'Welcome back! Would you like to order your usual again?', [{ id: 'btn_reorder', title: '🔄 Order Again' }, { id: 'btn_browse', title: '📋 Browse Menu' }]);
      } else { await sendMainMenu(from); }
      return;
    }

    if (btnId === 'btn_browse') { await sendMainMenu(from); return; }
    if (btnId === 'btn_reorder') {
       const lastOrder = session.tempLastOrder;
       if (!lastOrder) { await sendMainMenu(from); return; }
       const { data: v } = await supabase.from('vendors').select('id, store_name, is_open').eq('id', lastOrder.vendor_id).maybeSingle();
       if (!v || !v.is_open) { await sendText(from, 'Restaurant closed. Send *menu*.'); return; }
       session.vendorId = v.id; session.vendorName = v.store_name;
       const itemIds = lastOrder.items.map(i => i.id).filter(id => id);
       if (itemIds.length > 0) {
          const { data: freshItems } = await supabase.from('menu_items').select('id, name, price, in_stock').in('id', itemIds);
          const freshMap = {}; (freshItems || []).forEach(f => { freshMap[f.id] = f; });
          session.cart = lastOrder.items.map(i => { const f = freshMap[i.id]; return (f && f.in_stock) ? { id: f.id, name: f.name, price: Number(f.price), qty: i.qty } : null; }).filter(i => i !== null);
       } else { session.cart = []; }
       if (session.cart.length === 0) { await sendText(from, 'Items unavailable. Browse menu.'); await sendMenu(from, v.id, 0); return; }
       await sendCartView(from, session, 'Here is your previous order:');
       return;
    }

    // LOCATION PIN HANDLING (WITH DYNAMIC FEE CALCULATION)
    if (session.step === 'AWAITING_LOCATION') {
      
      // Handle button clicks FIRST so the bot waits for the actual location
      if (btnId === 'btn_share_loc') {
         await sendText(from, '📍 *How to share your location:*\n\n1. Tap the paperclip icon (📎) at the bottom of your chat.\n2. Select *Location*.\n3. Send your *Current Location* (Not Live Location).\n\nThis allows us to calculate your exact delivery fee.');
         return; // <--- CRITICAL: Stop here and wait for the pin
      }
      if (btnId === 'btn_type_addr') {
         await sendText(from, 'Please reply with your full street address or landmark. (Note: Delivery fee will be calculated as base ₦1,000 without a pin).');
         return; // <--- CRITICAL: Stop here and wait for the address
      }

      let customerLat = null, customerLng = null;
      if (location) {
         customerLat = location.latitude; customerLng = location.longitude;
         session.address = `Lat: ${customerLat}, Long: ${customerLng}`;
      } else if (text && !listId && !btnId) {
         session.address = text;
      } else {
         return; // If no location or text yet, do nothing and wait
      }

      // Calculate fee if we have coordinates
      if (customerLat && customerLng) {
        const { data: v } = await supabase.from('vendors').select('latitude, longitude').eq('id', session.vendorId).maybeSingle();
        if (v && v.latitude && v.longitude) {
           const dist = calculateDistance(customerLat, customerLng, Number(v.latitude), Number(v.longitude));
           session.distanceKm = dist;
           session.deliveryFee = calculateDeliveryFee(dist);
           await sendText(from, `📍 Distance calculated: *${dist.toFixed(1)} km*\nDelivery fee: *${naira(session.deliveryFee)}*`);
        } else {
           session.distanceKm = 0; session.deliveryFee = BASE_FEE;
        }
      } else {
         session.distanceKm = 0; session.deliveryFee = BASE_FEE;
      }

      // Now that we have the location, move to the note step
      session.step = 'AWAITING_NOTE_PROMPT';
      await sendButtonMessage(from, 'Do you have any special instructions for the restaurant?', [{ id: 'btn_add_note', title: '📝 Add Note' }, { id: 'btn_skip_note', title: '⏭️ Skip' }]);
      return;
    }

    // NOTE HANDLING
    if (btnId === 'btn_add_note') { session.step = 'AWAITING_NOTE'; await sendText(from, 'Please type your special instructions:'); return; }
    if (btnId === 'btn_skip_note') {
       session.note = ''; session.step = 'AWAITING_CONFIRM';
       const sub = cartTotal(session.cart);
       const feeText = session.distanceKm > 0 ? ` (${session.distanceKm.toFixed(1)} km)` : '';
       await sendButtonMessage(from, `🧾 *Confirm Your Order*\n\n🏪 ${session.vendorName}\n${cartSummary(session.cart)}\n\nFood: ${naira(sub)}\nDelivery: ${naira(session.deliveryFee)}${feeText}\n*Total: ${naira(sub + session.deliveryFee)}*\n\n📍 ${session.address}\n\n🔒 Pay securely online with Paystack.`,
         [{ id: 'btn_confirm', title: '✅ Confirm Order' }, { id: 'btn_cancel', title: '❌ Cancel' }]);
       return;
    }
    if (session.step === 'AWAITING_NOTE' && text && !listId && !btnId) {
       session.note = text; session.step = 'AWAITING_CONFIRM';
       const sub = cartTotal(session.cart);
       const feeText = session.distanceKm > 0 ? ` (${session.distanceKm.toFixed(1)} km)` : '';
       await sendButtonMessage(from, `🧾 *Confirm Your Order*\n\n🏪 ${session.vendorName}\n${cartSummary(session.cart)}\n\nFood: ${naira(sub)}\nDelivery: ${naira(session.deliveryFee)}${feeText}\n*Total: ${naira(sub + session.deliveryFee)}*\n\n📍 ${session.address}\n📝 Note: ${text}\n\n💵 Pay cash or transfer on delivery.`,
         [{ id: 'btn_confirm', title: '✅ Confirm Order' }, { id: 'btn_cancel', title: '❌ Cancel' }]);
       return;
    }

    // SEARCH STEPS
    if (session.step === 'AWAITING_GLOBAL_SEARCH' && text && !listId && !btnId) { session.step = 'IDLE'; await performGlobalSearch(from, text, session); return; }
    if (session.step === 'AWAITING_MENU_SEARCH' && text && !listId && !btnId) {
      if (!session.vendorId) { await sendText(from, 'Session expired.'); return; }
      session.step = 'IDLE';
      const { data: items } = await supabase.from('menu_items').select('id, name, price').ilike('name', `%${text.trim()}%`).eq('vendor_id', session.vendorId).eq('in_stock', true).limit(10);
      if (!items || items.length === 0) { await sendText(from, `❌ No dishes found matching "*${text}*".`); return; }
      await sendList(from, 'Search Results', `Found ${items.length} match(es)`, 'View Items', 'Matches', items.map(it => ({ id: `item_${it.id}`, title: `${it.name} - ${naira(it.price)}`.substring(0, 24), description: 'Tap to add to cart' })));
      return;
    }

    // SERVICES
    if (listId === 'service_food' || textLower.includes('food')) { await sendVendorList(from, 0); return; }
    if (listId === 'service_search' || textLower.startsWith('search ') || textLower.startsWith('find ')) {
      if (listId === 'service_search') { session.step = 'AWAITING_GLOBAL_SEARCH'; await sendText(from, '🔍 *What are you looking for?*\n\nReply with a restaurant or dish name.'); return; }
      else { await performGlobalSearch(from, text.replace(/^(search|find)\s+/i, ''), session); return; }
    }
    if (listId === 'nav_search_menu') { session.step = 'AWAITING_MENU_SEARCH'; await sendText(from, '🔍 *Search this Menu*\n\nReply with the dish name:'); return; }
    if (listId === 'service_ride' || listId === 'service_package') { await sendText(from, 'Coming soon! Send *menu* to order food.'); return; }

    // VENDOR PAGINATION
    if (listId && listId.startsWith('vendor_next_')) { await sendVendorList(from, parseInt(listId.replace('vendor_next_', ''), 10)); return; }
    if (listId && listId.startsWith('vendor_prev_')) { await sendVendorList(from, parseInt(listId.replace('vendor_prev_', ''), 10)); return; }

    // SELECT VENDOR & CATEGORIES
    if (listId && listId.startsWith('vendor_')) {
      const vendorId = listId.replace('vendor_', '');
      const { data: v } = await supabase.from('vendors').select('id, store_name, is_open').eq('id', vendorId).maybeSingle();
      if (!v || !v.is_open) { await sendText(from, 'Restaurant closed.'); return; }
      session.vendorId = v.id; session.vendorName = v.store_name; session.cart = []; session.menuPage = 0; session.lastCategory = null;
      const { data: cats } = await supabase.from('menu_items').select('category').eq('vendor_id', vendorId).eq('in_stock', true).not('category', 'is', null);
      const uniqueCats = [...new Set((cats || []).map(c => c.category))].filter(c => c && c.trim() !== '');
      if (uniqueCats.length > 0) {
         const catRows = uniqueCats.map(c => ({ id: `cat_${c}`, title: c.substring(0, 24), description: `View ${c}` }));
         catRows.push({ id: 'cat_all', title: '📋 View All Items', description: 'See the entire menu' });
         await sendList(from, 'Menu Categories', 'Select a category:', 'View Categories', 'Categories', catRows);
      } else { await sendMenu(from, vendorId, 0); }
      return;
    }
    if (listId && listId.startsWith('cat_')) { session.lastCategory = listId.replace('cat_', ''); await sendMenu(from, session.vendorId, 0, '', session.lastCategory); return; }
    if (listId === 'nav_categories') {
       const { data: cats } = await supabase.from('menu_items').select('category').eq('vendor_id', session.vendorId).eq('in_stock', true).not('category', 'is', null);
       const uniqueCats = [...new Set((cats || []).map(c => c.category))].filter(c => c && c.trim() !== '');
       const catRows = uniqueCats.map(c => ({ id: `cat_${c}`, title: c.substring(0, 24), description: `View ${c}` }));
       catRows.push({ id: 'cat_all', title: '📋 View All Items', description: 'See the entire menu' });
       await sendList(from, 'Menu Categories', 'Select a category:', 'View Categories', 'Categories', catRows);
       return;
    }

    // MENU PAGINATION
    if (listId && listId.startsWith('page_')) {
      const parts = listId.replace('page_', '').split('|');
      await sendMenu(from, session.vendorId, parseInt(parts[0], 10) || 0, '', parts[1] || null);
      return;
    }

    // SELECT ITEM
    if (listId && listId.startsWith('item_')) {
      const itemId = listId.replace('item_', '');
      const { data: item } = await supabase.from('menu_items').select('id, name, price, in_stock, vendor_id').eq('id', itemId).maybeSingle();
      if (!item) { await sendText(from, 'Item not available.'); return; }
      if (!session.vendorId || session.vendorId !== item.vendor_id) {
        if (session.cart.length > 0) { session.cart = []; await sendText(from, '🔄 Previous cart cleared (different restaurant).'); }
        session.vendorId = item.vendor_id;
        const { data: v } = await supabase.from('vendors').select('store_name').eq('id', item.vendor_id).maybeSingle();
        session.vendorName = v ? v.store_name : 'Restaurant';
      }
      if (!item.in_stock) { await sendMenu(from, session.vendorId, session.menuPage, `Sorry, ${item.name} is sold out.`, session.lastCategory); return; }
      let entry = session.cart.find(c => c.id === item.id);
      if (entry) entry.qty = Math.min(entry.qty + 1, 20);
      else session.cart.push({ id: item.id, name: item.name, price: Number(item.price), qty: 1 });
      await sendMenu(from, session.vendorId, session.menuPage, `✅ Added *${item.name}* (x${entry ? entry.qty : 1})`, session.lastCategory);
      return;
    }

    // CART ROWS
    if (listId === 'nav_cart' || btnId === 'btn_cart') {
      if (session.cart.length === 0) { if (session.vendorId) await sendMenu(from, session.vendorId, session.menuPage, 'Cart empty.', session.lastCategory); return; }
      await sendCartView(from, session); return;
    }
    if (listId === 'nav_remove' || btnId === 'btn_editcart') {
      if (session.cart.length === 0) { if (session.vendorId) await sendMenu(from, session.vendorId, session.menuPage, 'Cart empty.', session.lastCategory); return; }
      await sendEditCartList(from, session); return;
    }
    if (listId && listId.startsWith('cartrm_')) {
      const entry = session.cart.find(c => c.id === listId.replace('cartrm_', ''));
      if (!entry) { await sendMenu(from, session.vendorId, session.menuPage); return; }
      entry.qty -= 1;
      if (entry.qty <= 0) session.cart = session.cart.filter(c => c.id !== entry.id);
      const rmNote = `➖ Removed 1 *${entry.name}*`;
      if (FLOW_ID && session.cart.length) await sendCartView(from, session, rmNote);
      else await sendMenu(from, session.vendorId, session.menuPage, rmNote, session.lastCategory);
      return;
    }
    if (listId === 'cart_clear') { session.cart = []; if (session.vendorId) await sendMenu(from, session.vendorId, 0, 'Cart cleared.', session.lastCategory); return; }

    // ADD MORE
    if (btnId === 'btn_add_more') {
      if (!session.vendorId) { await sendText(from, 'Start again. Send *menu*.'); return; }
      await sendMenu(from, session.vendorId, FLOW_ID ? session.flowPage + 1 : session.menuPage, '', session.lastCategory);
      return;
    }

    // CHECKOUT
    if (btnId === 'btn_checkout') {
      if (session.cart.length === 0) { await sendText(from, 'Cart empty. Send *menu*.'); return; }
      session.step = 'AWAITING_LOCATION';
      await sendButtonMessage(from, '📍 *Enter Delivery Address*\n\nPlease share your location pin (required for accurate delivery fee calculation) or type your address.', [
         { id: 'btn_share_loc', title: '📍 Share Location' }, { id: 'btn_type_addr', title: '⌨️ Type Address' }
      ]);
      return;
    }

    // CONFIRM ORDER: collect email before initializing Paystack
    if (btnId === 'btn_confirm') {
      if (session.step !== 'AWAITING_CONFIRM' || session.cart.length === 0) { await sendText(from, 'Nothing to confirm.'); return; }
      session.step = 'AWAITING_PAYMENT_EMAIL';
      await sendText(from, 'Please enter your email address for your Paystack payment receipt. Your order is only confirmed after payment is verified.');
      return;
    }

    await sendText(from, 'Send *menu* to start an order.');

  } catch (err) {
    console.error('❌ Webhook error:', err.message);
  }
});

// ---------- CUSTOMER STATUS UPDATES ----------
function statusMessage(o) {
  const name = o.riders?.profiles?.name; const rphone = o.riders?.profiles?.phone;
  switch (o.status) {
    case 'preparing': return `🍳 *${o.order_number}:* Restaurant is preparing your meal!`;
    case 'ready_for_rider': return `📦 *${o.order_number}:* Food is ready! Finding a rider.`;
    case 'accepted': return `🛵 *${o.order_number}:* ${name ? name : 'A rider'} accepted your order${rphone ? ` (${rphone})` : ''}.`;
    case 'picked_up': return `🚀 *${o.order_number}:* Food picked up!\n\n🔑 PIN: *${o.delivery_code}*`;
    case 'arrived_at_customer': return `📍 *${o.order_number}:* Rider arrived! Give PIN: *${o.delivery_code}*`;
    case 'delivered': return `✅ *${o.order_number}:* Delivered! Enjoy. Send *menu* to order again.`;
    case 'cancelled': return `❌ *${o.order_number}:* Cancelled.`;
    default: return '';
  }
}

let notifying = false;
async function notifyCustomers() {
  if (notifying) return; notifying = true;
  try {
    const { data: orders, error } = await supabase.from('orders')
      .select('id, order_number, status, customer_phone, delivery_code, cancel_reason, riders(profiles(name, phone))')
      .eq('source', 'whatsapp').eq('wa_pending', true).limit(20);
    if (error) return;
    for (const o of orders || []) {
      const msg = statusMessage(o);
      if (msg && o.customer_phone) await sendText(o.customer_phone, msg);
      await supabase.from('orders').update({ wa_pending: false }).eq('id', o.id);
    }
  } catch (e) { console.error(e.message); } finally { notifying = false; }
}
setInterval(notifyCustomers, 6000);

app.get('/', (req, res) => res.send('Bot running.'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server listening on port ${PORT}`));