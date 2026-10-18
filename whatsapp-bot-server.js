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
  if (!sessions[phone]) sessions[phone] = { cart: [], step: 'IDLE', vendorId: null, vendorName: '', address: '', note: '', activeItemId: null, menuPage: 0, flowItems: [], flowPage: 0, lastCategory: null, tempLastOrder: null, deliveryFee: BASE_FEE, distanceKm: 0, paymentMethod: 'card', pendingNaturalOrder: null, matchCandidates: {}, customItems: [], pendingQuoteToken: null };
  return sessions[phone];
}
function resetSession(s) { 
  s.cart = []; s.step = 'IDLE'; s.vendorId = null; s.vendorName = ''; s.address = ''; s.note = ''; 
  s.activeItemId = null; s.menuPage = 0; s.flowItems = []; s.flowPage = 0; s.lastCategory = null; s.tempLastOrder = null; s.deliveryFee = BASE_FEE; s.distanceKm = 0; s.paymentMethod = 'card';
  s.pendingNaturalOrder = null; s.matchCandidates = {}; s.customItems = []; s.pendingQuoteToken = null;
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

async function verifyPaystackCharge(reference) {
  if (!PAYSTACK_SECRET_KEY) throw new Error('PAYSTACK_SECRET_KEY is not configured');
  const response = await axios.get(`https://api.paystack.co/charge/${encodeURIComponent(reference)}`, {
    headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` }, timeout: 20000
  });
  if (!response.data?.status) throw new Error(response.data?.message || 'Paystack charge verification failed');
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
      const transaction = req.body.data?.channel === 'bank_transfer'
        ? await verifyPaystackCharge(reference)
        : await verifyPaystackReference(reference);
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


/* ---------- AUTHENTICATED RIDER DELIVERY-CODE RESEND ---------- */
const RIDER_APP_ORIGIN = process.env.RIDER_APP_ORIGIN || 'https://partner-app-5l9f.onrender.com';

function setRiderApiCors(req, res) {
  const origin = req.headers.origin;
  if (origin === RIDER_APP_ORIGIN) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  }
}

app.options('/api/rider/resend-delivery-code', (req, res) => {
  setRiderApiCors(req, res);
  if (req.headers.origin && req.headers.origin !== RIDER_APP_ORIGIN) return res.sendStatus(403);
  return res.sendStatus(204);
});

app.post('/api/rider/resend-delivery-code', async (req, res) => {
  setRiderApiCors(req, res);
  if (req.headers.origin && req.headers.origin !== RIDER_APP_ORIGIN) {
    return res.status(403).json({ success: false, message: 'This app is not allowed to use this service.' });
  }

  try {
    const authHeader = String(req.headers.authorization || '');
    const accessToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
    if (!accessToken) return res.status(401).json({ success: false, message: 'Please sign in again.' });
    if (!WHATSAPP_TOKEN || !PHONE_NUMBER_ID || !SUPABASE_SERVICE_KEY) {
      console.error('Rider resend endpoint missing bot configuration.');
      return res.status(503).json({ success: false, message: 'WhatsApp delivery messaging is not configured yet.' });
    }

    const { data: authData, error: authError } = await supabase.auth.getUser(accessToken);
    if (authError || !authData?.user?.id) {
      return res.status(401).json({ success: false, message: 'Your session expired. Please sign in again.' });
    }

    const orderId = typeof req.body?.order_id === 'string' ? req.body.order_id : '';
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(orderId)) {
      return res.status(400).json({ success: false, message: 'Invalid delivery order.' });
    }

    const { data: rider, error: riderError } = await supabase
      .from('riders').select('id').eq('user_id', authData.user.id).maybeSingle();
    if (riderError || !rider) return res.status(403).json({ success: false, message: 'Rider account not found.' });

    const { data: order, error: orderError } = await supabase
      .from('orders')
      .select('id, order_number, rider_id, customer_phone, delivery_code, status')
      .eq('id', orderId).eq('rider_id', rider.id).maybeSingle();
    if (orderError || !order) return res.status(404).json({ success: false, message: 'This delivery is not assigned to your account.' });

    if (!['picked_up', 'arrived_at_customer', 'on_the_way'].includes(String(order.status || '').toLowerCase())) {
      return res.status(409).json({ success: false, message: 'You can resend the code only during the customer delivery stage.' });
    }
    if (!order.customer_phone || !order.delivery_code) {
      return res.status(409).json({ success: false, message: 'The customer phone number or delivery code is missing.' });
    }

    const { data: recent, error: recentError } = await supabase
      .from('delivery_code_resend_logs').select('created_at')
      .eq('order_id', order.id).order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (recentError) {
      console.error('Delivery resend cooldown lookup failed:', recentError.message);
      return res.status(500).json({ success: false, message: 'Could not check the resend limit. Please try again.' });
    }
    if (recent?.created_at && Date.now() - new Date(recent.created_at).getTime() < 60000) {
      return res.status(429).json({ success: false, message: 'Please wait 60 seconds before resending the code.' });
    }

    // Reserve the cooldown before sending so rapid repeat taps cannot spam the customer.
    const { data: logRow, error: logError } = await supabase
      .from('delivery_code_resend_logs')
      .insert({ order_id: order.id, rider_id: rider.id })
      .select('id').single();
    if (logError || !logRow) {
      console.error('Delivery resend log insert failed:', logError?.message || 'No log row returned');
      return res.status(500).json({ success: false, message: 'Could not start the resend. Please try again.' });
    }

    const customerPhone = String(order.customer_phone).replace(/[^0-9]/g, '');
    const message = `🔐 *QuickEats delivery verification code*\n\nYour code for order ${order.order_number} is: *${order.delivery_code}*\n\nPlease share this code only with your assigned QuickEats rider when your order arrives.`;
    const sent = await sendText(customerPhone, message);
    if (!sent) {
      await supabase.from('delivery_code_resend_logs').delete().eq('id', logRow.id);
      return res.status(502).json({ success: false, message: 'WhatsApp could not send the message. Please try again shortly.' });
    }

    // Never return the delivery code or provider response to the rider app.
    return res.status(200).json({ success: true, message: 'Delivery code message sent to the customer.' });
  } catch (error) {
    console.error('Rider delivery-code resend failed:', error.response?.data || error.message);
    return res.status(500).json({ success: false, message: 'Could not send the delivery code message.' });
  }
});

// ---------- BOT STEPS ----------
async function sendMainMenu(to) {
  await sendList(to, 'QuickEats 🍽️', 'Welcome! Ordering is easy. Tap Order Food to browse restaurants, or simply type what you want, for example: 2 jollof rice and 3 chicken. I will find restaurants and show you the prices before checkout.', 'Start Order', 'What would you like?', [
    { id: 'service_food', title: '🍔 Order Food', description: 'Browse open restaurants and menus' },
    { id: 'service_search', title: '🔍 Find Food', description: 'Search for a dish or restaurant' },
    { id: 'service_ride', title: '🛺 Book a Ride', description: 'Coming soon' },
    { id: 'service_package', title: '📦 Send a Package', description: 'Coming soon' }
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
  await sendList(to, 'Choose a Restaurant', 'Tap one restaurant below. You can also type the food you want and I will search menus for you.', 'Choose Restaurant', 'Open Restaurants', rows);
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

  let body = note ? `${note}\n\n` : 'Tap any food to add 1. Need more than 1? Tap it again, or use the quantity selector if shown.';
  if (session.cart.length) body += `\n\n🛒 Your cart: ${naira(cartTotal(session.cart))}\nTap “View Cart / Checkout” when you are ready.`;

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


// ---------- NATURAL-LANGUAGE ORDER DISCOVERY ----------
const NUMBER_WORDS = { one: 1, a: 1, an: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20 };

function normalizeFoodText(value) {
  return String(value || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function parseNaturalOrderText(rawText) {
  let text = String(rawText || '').toLowerCase().trim();
  text = text.replace(/^(?:hi|hello|please)\s*[,!:\-]?\s*/i, '');
  text = text.replace(/^(?:i would like|i'd like|i want|can i get|could i get|please get me|get me|i need|order|i'll have)\s+/i, '');
  const separators = /[,;]+|\s+\+\s+|\s+and\s+(?=(?:\d+|one|a|an|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\b)/i;
  const segments = text.split(separators).map(s => s.trim()).filter(Boolean);
  const items = [];
  for (const segment of segments) {
    let part = segment.replace(/^(?:please|also|and)\s+/i, '').trim();
    const qtyMatch = part.match(/^(\d+|one|a|an|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\b\s*(?:(pieces?|pcs?|plates?|portions?|servings?)\s+(?:of\s+)?)?/i);
    let qty = 1;
    let unit = null;
    if (qtyMatch) {
      qty = Number(qtyMatch[1]) || NUMBER_WORDS[qtyMatch[1]] || 1;
      if (qtyMatch[2]) unit = /^piece|^pc/i.test(qtyMatch[2]) ? 'piece' : 'plate';
      part = part.slice(qtyMatch[0].length).trim();
    }
    part = part.replace(/^(?:of|some)\s+/i, '').replace(/\b(?:please|thanks|thank you)\b/gi, '').trim();
    part = part.replace(/^(?:pieces?|pcs?|plates?|portions?|servings?)\s+of\s+/i, '').trim();
    if (!part || !/[a-z]/i.test(part)) continue;
    qty = Math.max(1, Math.min(50, Number(qty) || 1));
    const normalized = normalizeFoodText(part);
    const existing = items.find(i => normalizeFoodText(i.name) === normalized);
    if (existing) existing.qty = Math.min(50, existing.qty + qty);
    else items.push({ name: part, normalized, qty, unit });
  }
  return items;
}

function findMatchingMenuItem(requestName, menuItems) {
  const requested = normalizeFoodText(requestName);
  if (!requested) return null;
  const requestTokens = requested.split(' ').filter(Boolean);
  const allowedModifiers = new Set(['grilled', 'fried', 'roasted', 'boiled', 'smoked', 'spicy', 'peppered', 'assorted', 'fresh', 'bbq', 'barbecue', 'suya', 'cooked', 'steamed', 'hot', 'cold', 'special']);
  const candidates = (menuItems || []).map(item => {
    const normalized = normalizeFoodText(item.name);
    const itemTokens = normalized.split(' ').filter(Boolean);
    let score = 0;
    if (normalized === requested) score = 1000;
    else if (requestTokens.every(token => itemTokens.includes(token))) {
      const extras = itemTokens.filter(token => !requestTokens.includes(token));
      if (extras.length <= 2 && extras.every(token => allowedModifiers.has(token))) {
        score = 800 - extras.length;
      }
    }
    return { item, score, length: itemTokens.length };
  }).filter(c => c.score > 0).sort((a, b) => b.score - a.score || a.length - b.length);
  return candidates[0]?.item || null;
}

function normalizeWhatsAppPhone(value) {
  let digits = String(value || '').replace(/\D/g, '');
  if (digits.startsWith('0') && digits.length === 11) digits = '234' + digits.slice(1);
  else if (digits.length === 10) digits = '234' + digits;
  return digits;
}

async function searchRestaurantsForNaturalOrder(to, rawText, profileName, session) {
  const requestedItems = parseNaturalOrderText(rawText);
  if (!requestedItems.length) {
    await sendText(to, 'Please type your food and quantities, for example: *2 jollof rice, 3 chicken and 10 pieces of meat*. I will search restaurants for you.');
    return;
  }
  const { data: vendors, error: vendorError } = await supabase.from('vendors')
    .select('id, store_name, address, phone, latitude, longitude')
    .eq('is_open', true).order('store_name', { ascending: true }).limit(200);
  if (vendorError || !vendors?.length) {
    await sendText(to, 'Sorry, I could not find any open restaurants right now. Please try again shortly.');
    return;
  }
  const vendorIds = vendors.map(v => v.id);
  const { data: menuItems, error: menuError } = await supabase.from('menu_items')
    .select('id, name, price, vendor_id, in_stock, category')
    .in('vendor_id', vendorIds).eq('in_stock', true).limit(3000);
  if (menuError) {
    console.error('Natural order menu search failed:', menuError.message);
    await sendText(to, 'Sorry, I could not search restaurant menus right now. Please try again shortly.');
    return;
  }
  const grouped = new Map(vendors.map(v => [v.id, []]));
  for (const item of menuItems || []) if (grouped.has(item.vendor_id)) grouped.get(item.vendor_id).push(item);

  const candidates = [];
  for (const vendor of vendors) {
    const vendorMenu = grouped.get(vendor.id) || [];
    const cart = [];
    const customItems = [];
    const matchedRequests = [];
    for (const requested of requestedItems) {
      const match = findMatchingMenuItem(requested.name, vendorMenu);
      if (!match) {
        customItems.push({ name: requested.name, qty: requested.qty, unit: requested.unit });
        continue;
      }
      const existing = cart.find(c => c.id === match.id);
      if (existing) existing.qty = Math.min(50, existing.qty + requested.qty);
      else cart.push({ id: match.id, name: match.name, price: Number(match.price), qty: requested.qty });
      matchedRequests.push({ requestedName: requested.name, menuName: match.name, qty: requested.qty });
    }
    if (!matchedRequests.length) continue;
    if (customItems.length && !vendor.phone) continue;
    const subtotal = cart.reduce((sum, item) => sum + item.price * item.qty, 0);
    candidates.push({ vendor, cart, customItems, matchedRequests, subtotal, matchedCount: matchedRequests.length, requestedCount: requestedItems.length, fullMatch: customItems.length === 0 });
  }
  candidates.sort((a, b) => Number(b.fullMatch) - Number(a.fullMatch) || b.matchedCount - a.matchedCount || a.subtotal - b.subtotal || String(a.vendor.store_name).localeCompare(String(b.vendor.store_name)));

  if (!candidates.length) {
    await sendText(to, 'I could not find an open restaurant with any of those listed items. Please check the food names or send a simpler order, such as *2 jollof rice, 3 chicken*. Custom requests need a restaurant with a registered contact number so the vendor can confirm them.');
    return;
  }

  session.pendingNaturalOrder = { requestedItems, profileName: profileName || 'Customer', rawText };
  session.matchCandidates = {};
  candidates.slice(0, 10).forEach(candidate => { session.matchCandidates[candidate.vendor.id] = candidate; });
  session.step = 'AWAITING_MATCH_RESTAURANT';
  const rows = candidates.slice(0, 10).map((candidate, index) => ({
    id: 'match_vendor_' + candidate.vendor.id,
    title: String(candidate.vendor.store_name || ('Restaurant ' + (index + 1))).substring(0, 24),
    description: (candidate.matchedCount + '/' + candidate.requestedCount + ' items | Food ' + naira(candidate.subtotal) + (candidate.customItems.length ? ' | ' + candidate.customItems.length + ' for quote' : ' | All listed')).substring(0, 72)
  }));
  const fullCount = candidates.filter(c => c.fullMatch).length;
  const lead = fullCount
    ? 'I found ' + fullCount + ' restaurant(s) with every requested item listed. Full matches are shown first.'
    : 'I found restaurants with some of your items. Missing items need vendor availability and price confirmation.';
  await sendList(to, 'Restaurants for Your Order', lead + '\n\nChoose one restaurant. Each order comes from one restaurant.', 'Choose Restaurant', 'Matches', rows);
}

async function startVendorCustomQuote(to, profileName, session, candidate) {
  if (!candidate.vendor.phone) {
    await sendText(to, 'This restaurant has no vendor contact number for custom-item confirmation. Please choose a restaurant with all items listed or start a new search.');
    return;
  }
  const token = crypto.randomBytes(4).toString('hex').toUpperCase();
  const { data: quote, error } = await supabase.from('whatsapp_quote_requests').insert({
    token, vendor_id: candidate.vendor.id, customer_phone: to, customer_name: profileName || 'Customer',
    requested_items: session.pendingNaturalOrder.requestedItems,
    cart_items: candidate.cart, custom_items: candidate.customItems, status: 'pending',
    expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString()
  }).select('id, token').single();
  if (error || !quote) {
    console.error('Could not save custom quote request:', error?.message);
    await sendText(to, 'Sorry, I could not send the custom-item request. No order has been placed. Please try again.');
    return;
  }
  session.vendorId = candidate.vendor.id;
  session.vendorName = candidate.vendor.store_name;
  session.cart = candidate.cart.map(item => ({ ...item }));
  session.customItems = candidate.customItems;
  session.pendingQuoteToken = token;
  session.step = 'AWAITING_VENDOR_QUOTE';

  const customLines = candidate.customItems.map((item, index) => (index + 1) + '. ' + item.qty + ' ' + (item.unit === 'piece' ? 'piece(s) of ' : '') + item.name).join('\n');
  const vendorPhone = normalizeWhatsAppPhone(candidate.vendor.phone);
  const vendorMessage = 'QuickEats custom-item price request\nRestaurant: ' + candidate.vendor.store_name + '\nCustomer order request ' + token + ' (expires in 30 minutes):\n' + customLines + '\n\nReply with unit prices in naira, using this exact format:\nQUOTE ' + token + ' 1=1500 2=500\nThe numbers match the item list above. Do not use commas in prices. If you cannot supply the requested custom item(s), reply:\nNO ' + token;
  const sent = vendorPhone && await sendText(vendorPhone, vendorMessage);
  if (!sent) {
    await supabase.from('whatsapp_quote_requests').update({ status: 'expired', updated_at: new Date().toISOString() }).eq('id', quote.id);
    session.step = 'AWAITING_MATCH_RESTAURANT';
    session.pendingQuoteToken = null;
    await sendText(to, 'I could not contact this restaurant to confirm custom items. Please choose a restaurant with all items listed or try another restaurant.');
    return;
  }
  await sendText(to, 'I found *' + candidate.vendor.store_name + '* for your order. The vendor needs to confirm the price and availability of:\n' + customLines + '\n\nI have sent the request to the restaurant. I will ask you to review the final total after the vendor replies. No order or payment has been created yet.');
}

async function handleVendorQuoteReply(from, text) {
  const match = String(text || '').trim().match(/^(QUOTE|NO)\s+([A-Z0-9]+)(?:\s+([\s\S]+))?$/i);
  if (!match) return false;
  const token = match[2].toUpperCase();
  const { data: quote, error } = await supabase.from('whatsapp_quote_requests').select('*').eq('token', token).maybeSingle();
  if (error || !quote) return false;
  const { data: vendor } = await supabase.from('vendors').select('id, store_name, phone').eq('id', quote.vendor_id).maybeSingle();
  if (!vendor || normalizeWhatsAppPhone(vendor.phone) !== normalizeWhatsAppPhone(from)) {
    await sendText(from, 'Only the selected restaurant can reply to this custom quote request.');
    return true;
  }
  if (quote.status !== 'pending' || new Date(quote.expires_at).getTime() < Date.now()) {
    if (quote.status === 'pending') await supabase.from('whatsapp_quote_requests').update({ status: 'expired', updated_at: new Date().toISOString() }).eq('id', quote.id);
    await sendText(from, 'This QuickEats quote request has expired or has already been answered.');
    return true;
  }
  const customerPhone = quote.customer_phone;
  if (match[1].toUpperCase() === 'NO') {
    await supabase.from('whatsapp_quote_requests').update({ status: 'unavailable', updated_at: new Date().toISOString() }).eq('id', quote.id);
    const customerSession = getSession(customerPhone);
    if (customerSession.pendingQuoteToken === token) {
      customerSession.pendingQuoteToken = null;
      customerSession.pendingNaturalOrder = null;
      customerSession.matchCandidates = {};
      customerSession.customItems = [];
      customerSession.cart = [];
      customerSession.vendorId = null;
      customerSession.vendorName = '';
      customerSession.step = 'IDLE';
    }
    await sendText(customerPhone, vendor.store_name + ' cannot supply the custom item(s) in your request. No order or payment has been created. Reply with a revised food order to search again.');
    await sendText(from, 'Thanks. The customer has been told the custom request is unavailable.');
    return true;
  }

  const customItems = Array.isArray(quote.custom_items) ? quote.custom_items : [];
  const priceText = match[3] || '';
  const prices = {};
  let priceMatch;
  const priceRegex = /(\d+)\s*=\s*(\d+(?:\.\d{1,2})?)/g;
  while ((priceMatch = priceRegex.exec(priceText)) !== null) prices[Number(priceMatch[1])] = Number(priceMatch[2]);
  const quotedItems = [];
  for (let i = 0; i < customItems.length; i++) {
    const unitPrice = prices[i + 1];
    if (!Number.isFinite(unitPrice) || unitPrice <= 0) {
      await sendText(from, 'Please quote every item. Reply like: QUOTE ' + token + ' 1=1500 2=500. These are unit prices in naira, without commas.');
      return true;
    }
    quotedItems.push({ id: 'custom_' + token + '_' + (i + 1), name: customItems[i].name, qty: Number(customItems[i].qty) || 1, price: unitPrice, custom: true, unit: customItems[i].unit || null });
  }
  const { error: updateError } = await supabase.from('whatsapp_quote_requests').update({ status: 'quoted', quoted_items: quotedItems, updated_at: new Date().toISOString() }).eq('id', quote.id).eq('status', 'pending');
  if (updateError) {
    console.error('Could not save vendor quote:', updateError.message);
    await sendText(from, 'I could not save that quote. Please try replying again.');
    return true;
  }

  const session = getSession(customerPhone);
  session.vendorId = vendor.id;
  session.vendorName = vendor.store_name;
  session.cart = [...(Array.isArray(quote.cart_items) ? quote.cart_items : []), ...quotedItems].map(item => ({ id: item.id, name: item.name, price: Number(item.price), qty: Number(item.qty) || 1, custom: !!item.custom, unit: item.unit || null }));
  session.customItems = [];
  session.pendingQuoteToken = null;
  session.pendingNaturalOrder = null;
  session.matchCandidates = {};
  session.step = 'IDLE';
  await sendText(customerPhone, 'Good news! *' + vendor.store_name + '* confirmed the custom items and prices. Please review the updated order and total below. You can remove items or add more before checkout.');
  await sendCartView(customerPhone, session, 'Vendor-confirmed custom prices:');
  await sendText(from, 'Quote ' + token + ' saved. The customer has been sent the updated order for review.');
  return true;
}

function cartSummary(cart) { return cart.map((i, idx) => `${idx + 1}. ${i.qty}x ${i.name} - ${naira(i.price * i.qty)}`).join('\n'); }
function sendCartView(to, session, note = '') {
  return sendButtonMessage(to, `${note ? note + '\n\n' : ''}🛒 *Your Order So Far*\n\n${cartSummary(session.cart)}\n\n*Food total: ${naira(cartTotal(session.cart))}*\n\nChoose one option below. You can add more food, remove items, or continue to delivery details. Delivery fee and final total will be shown before you confirm.`,
    [{ id: 'btn_add_more', title: '➕ Add Food' }, { id: 'btn_editcart', title: '➖ Remove Food' }, { id: 'btn_checkout', title: '➡️ Continue' }]);
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


    // Vendor replies to a pending custom-item quote request
    if (text && /^(?:QUOTE|NO)\s+[A-Z0-9]+\b/i.test(text) && await handleVendorQuoteReply(from, text)) return;

    // Customer waiting for vendor quote: allow menu/start to cancel the pending request
    if (session.step === 'AWAITING_VENDOR_QUOTE' && text && !listId && !btnId) {
      if (['menu', 'start', 'hi', 'hello'].includes(textLower)) {
        if (session.pendingQuoteToken) await supabase.from('whatsapp_quote_requests').update({ status: 'expired', updated_at: new Date().toISOString() }).eq('token', session.pendingQuoteToken).eq('status', 'pending');
        resetSession(session);
      } else if (textLower === 'cancel') {
        if (session.pendingQuoteToken) await supabase.from('whatsapp_quote_requests').update({ status: 'expired', updated_at: new Date().toISOString() }).eq('token', session.pendingQuoteToken).eq('status', 'pending');
        resetSession(session);
        await sendText(from, 'Your pending custom quote has been cancelled. Send *menu* to start again.');
        return;
      } else {
        await sendText(from, 'I am still waiting for the restaurant to confirm the custom items and prices. Send *menu* if you want to cancel this request and start again.');
        return;
      }
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
        if (session.paymentMethod === 'bank_transfer') {
          const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
          const payment = await paystackRequest('charge', {
            email, amount: amountKobo, currency: 'NGN', reference,
            bank_transfer: { account_expires_at: expiresAt },
            metadata: { order_id: order.id, order_number: orderNumber, customer_phone: from }
          });
          if (payment.status !== 'pending_bank_transfer' || !payment.account_number || !payment.bank?.name) {
            throw new Error('Paystack did not return temporary bank transfer details');
          }
          session.step = 'AWAITING_PAYMENT';
          await sendText(from, `🧾 *QuickEats Order ${orderNumber}*\nTotal: *${naira(subtotal + fee)}*\n\n🏦 *Pay by bank transfer*\nBank: ${payment.bank.name}\nAccount name: ${payment.account_name || 'Paystack'}\nAccount number: ${payment.account_number}\n\n⏳ This account expires at ${new Date(payment.account_expires_at || expiresAt).toLocaleString('en-NG', { timeZone: 'Africa/Lagos' })}.\n\nTransfer the exact amount shown above. Your order will be confirmed automatically after Paystack verifies payment. Do not send a transfer receipt as proof, and never share your PIN or OTP.`);
        } else {
          const payment = await paystackRequest('transaction/initialize', {
            email, amount: amountKobo, currency: 'NGN', reference,
            callback_url: `${PUBLIC_BASE_URL}/paystack/callback`,
            metadata: { order_id: order.id, order_number: orderNumber, customer_phone: from }
          });
          session.step = 'AWAITING_PAYMENT';
          await sendText(from, `🧾 Order ${orderNumber} created.\nTotal: ${naira(subtotal + fee)}\n\nPay securely using this Paystack link:\n${payment.authorization_url}\n\nYour order will only be confirmed after payment is verified. Do not share your delivery PIN.`);
        }
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
      if (session.pendingQuoteToken) await supabase.from('whatsapp_quote_requests').update({ status: 'expired', updated_at: new Date().toISOString() }).eq('token', session.pendingQuoteToken).eq('status', 'pending');
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
    if (listId === 'service_food' || /^(?:order food|food)$/i.test(textLower)) { await sendVendorList(from, 0); return; }
    if (listId === 'service_search' || textLower.startsWith('search ') || textLower.startsWith('find ')) {
      if (listId === 'service_search') { session.step = 'AWAITING_GLOBAL_SEARCH'; await sendText(from, '🔍 *What are you looking for?*\n\nReply with a restaurant or dish name.'); return; }
      else { await performGlobalSearch(from, text.replace(/^(search|find)\\s+/i, ''), session); return; }
    }
    if (listId === 'nav_search_menu') { session.step = 'AWAITING_MENU_SEARCH'; await sendText(from, '🔍 *Search this Menu*\\n\\nReply with the dish name:'); return; }
    if (listId === 'service_ride' || listId === 'service_package') { await sendText(from, 'Coming soon! Send *menu* to order food.'); return; }

    // Natural-language food orders: search all open restaurants before asking the customer to choose
    if ((session.step === 'IDLE' || session.step === 'AWAITING_MATCH_RESTAURANT') && text && !listId && !btnId && !/^(?:hi|hello|start|menu|cancel)$/i.test(textLower)) {
      await searchRestaurantsForNaturalOrder(from, text, profileName, session);
      return;
    }

    // Select one of the restaurants found for the natural-language order
    if (listId && listId.startsWith('match_vendor_')) {
      const vendorId = listId.replace('match_vendor_', '');
      const pending = session.pendingNaturalOrder;
      const candidate = session.matchCandidates?.[vendorId];
      if (!pending || !candidate) {
        await sendText(from, 'That restaurant selection has expired. Please send your food order again so I can search fresh menus.');
        session.step = 'IDLE';
        return;
      }
      const { data: vendor } = await supabase.from('vendors').select('id, store_name, phone, is_open').eq('id', vendorId).maybeSingle();
      if (!vendor || !vendor.is_open) {
        await sendText(from, 'That restaurant is no longer open. Please send your order again to search other restaurants.');
        session.step = 'IDLE';
        return;
      }
      const { data: freshMenu, error: freshMenuError } = await supabase.from('menu_items').select('id, name, price, vendor_id, in_stock').eq('vendor_id', vendorId).eq('in_stock', true).limit(1000);
      if (freshMenuError) { await sendText(from, 'I could not refresh that restaurant menu. Please try again.'); return; }
      const cart = [];
      const customItems = [];
      for (const requested of pending.requestedItems) {
        const matchItem = findMatchingMenuItem(requested.name, freshMenu || []);
        if (!matchItem) customItems.push({ name: requested.name, qty: requested.qty, unit: requested.unit });
        else {
          const existing = cart.find(item => item.id === matchItem.id);
          if (existing) existing.qty = Math.min(50, existing.qty + requested.qty);
          else cart.push({ id: matchItem.id, name: matchItem.name, price: Number(matchItem.price), qty: requested.qty });
        }
      }
      if (!cart.length && !customItems.length) { await sendText(from, 'I could not match those items. Please send your order again with clearer food names.'); return; }
      if (customItems.length) {
        const candidateNow = { vendor, cart, customItems };
        await startVendorCustomQuote(from, pending.profileName || profileName, session, candidateNow);
        return;
      }
      session.vendorId = vendor.id;
      session.vendorName = vendor.store_name;
      session.cart = cart;
      session.customItems = [];
      session.pendingQuoteToken = null;
      session.pendingNaturalOrder = null;
      session.matchCandidates = {};
      session.step = 'IDLE';
      await sendCartView(from, session, 'Found *' + vendor.store_name + '* with all your requested items. Review the quantities and food total before checkout.');
      return;
    }

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

    // CONFIRM ORDER: choose payment method, then collect receipt email
    if (btnId === 'btn_confirm') {
      if (session.step !== 'AWAITING_CONFIRM' || session.cart.length === 0) { await sendText(from, 'Nothing to confirm.'); return; }
      session.step = 'AWAITING_PAYMENT_METHOD';
      await sendButtonMessage(from, '💳 *Choose how to pay*\n\nBank transfer can be completed from your banking app. Card payment uses secure Paystack checkout.', [
        { id: 'pay_bank_transfer', title: '🏦 Bank Transfer' },
        { id: 'pay_card', title: '💳 Card / Paystack' }
      ]);
      return;
    }

    if (btnId === 'pay_bank_transfer' || btnId === 'pay_card') {
      if (session.step !== 'AWAITING_PAYMENT_METHOD' || session.cart.length === 0) { await sendText(from, 'Your checkout session expired. Send *menu* to start again.'); return; }
      session.paymentMethod = btnId === 'pay_bank_transfer' ? 'bank_transfer' : 'card';
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