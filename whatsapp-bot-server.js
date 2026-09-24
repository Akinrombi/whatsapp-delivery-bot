const express = require('express');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());

// ---------- CONFIG (all secrets come from Render environment variables) ----------
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://glkutdkwbrjpiuqcmgwe.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY; // service_role key: server only, never in code
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'my_verify_token';
const DELIVERY_FEE = Number(process.env.DELIVERY_FEE || 1000);
const FLOW_ID = process.env.FLOW_ID || '';            // WhatsApp Flow with quantity dropdowns (optional)
const FLOW_MODE = process.env.FLOW_MODE || 'published'; // use 'draft' while testing an unpublished flow

if (!SUPABASE_SERVICE_KEY) console.error('❌ SUPABASE_SERVICE_KEY is missing. Add it in Render > Environment.');

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY || 'missing', {
  auth: { persistSession: false, autoRefreshToken: false }
});

// ---------- SESSIONS (in memory) ----------
const sessions = {};
function getSession(phone) {
  if (!sessions[phone]) sessions[phone] = { cart: [], step: 'IDLE', vendorId: null, vendorName: '', address: '', activeItemId: null, menuPage: 0, flowItems: [], flowPage: 0 };
  return sessions[phone];
}
function resetSession(s) { s.cart = []; s.step = 'IDLE'; s.vendorId = null; s.vendorName = ''; s.address = ''; s.activeItemId = null; s.menuPage = 0; s.flowItems = []; s.flowPage = 0; }
const cartTotal = (cart) => cart.reduce((sum, i) => sum + i.price * i.qty, 0);
const naira = (n) => '₦' + Number(n).toLocaleString();

// Ignore repeated webhook deliveries of the same message
const seen = new Set();
function alreadySeen(id) {
  if (!id) return false;
  if (seen.has(id)) return true;
  seen.add(id);
  if (seen.size > 2000) seen.delete(seen.values().next().value);
  return false;
}

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

function sendText(to, body) {
  return sendWhatsAppMessage(to, { messaging_product: 'whatsapp', to, type: 'text', text: { body } });
}

function sendButtonMessage(to, bodyText, buttons) {
  return sendWhatsAppMessage(to, {
    messaging_product: 'whatsapp', to, type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: bodyText },
      action: { buttons: buttons.map(b => ({ type: 'reply', reply: { id: b.id, title: b.title } })) }
    }
  });
}

function sendList(to, header, body, button, sectionTitle, rows) {
  return sendWhatsAppMessage(to, {
    messaging_product: 'whatsapp', to, type: 'interactive',
    interactive: {
      type: 'list',
      header: { type: 'text', text: header },
      body: { text: body },
      action: { button, sections: [{ title: sectionTitle, rows }] }
    }
  });
}

// ---------- BOT STEPS ----------
async function sendMainMenu(to) {
  await sendList(to, 'David Delivery Network', 'Welcome! How can we assist you today?', 'Select Service', 'Available Services', [
    { id: 'service_food', title: '🍔 Order Food', description: 'Order from local restaurants' },
    { id: 'service_ride', title: '🛺 Book a Ride', description: 'Request fast transport' },
    { id: 'service_package', title: '📦 Send a Package', description: 'Doorstep parcel delivery' }
  ]);
}

async function sendVendorList(to) {
  const { data: stores, error } = await supabase.from('vendors').select('id, store_name, address').eq('is_open', true).limit(10);
  if (error) { console.error(error.message); await sendText(to, 'Sorry, something went wrong. Please try again.'); return; }
  if (!stores || stores.length === 0) {
    await sendText(to, 'No restaurants are currently open. Check back shortly!');
    return;
  }
  const rows = stores.map((s, i) => ({
    id: `vendor_${s.id}`,
    title: (s.store_name || `Store ${i + 1}`).substring(0, 24),
    description: (s.address || 'View menu & order food').substring(0, 72)
  }));
  await sendList(to, 'Select Restaurant', 'Choose an open restaurant:', 'View Restaurants', 'Open Stores', rows);
}

async function sendMenuList(to, vendorId, page = 0, note = '') {
  const session = getSession(to);
  const { data: all, error } = await supabase.from('menu_items').select('id, name, price')
    .eq('vendor_id', vendorId).eq('in_stock', true).order('created_at', { ascending: true }).limit(200);
  if (error) { console.error(error.message); await sendText(to, 'Sorry, could not load the menu.'); return; }
  if (!all || all.length === 0) {
    await sendText(to, 'This store has no available menu items right now. Send *menu* to pick another restaurant.');
    return;
  }

  // WhatsApp lists allow max 10 rows in total (items + navigation + cart rows)
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
  const itemRows = items.map((it, i) => {
    const q = qtyInCart(it.id);
    return {
      id: `item_${it.id}`,
      title: (it.name || `Item ${i + 1}`).substring(0, 24),
      description: (q ? `${naira(it.price)} | In cart: ${q} | tap to add +1` : `${naira(it.price)} | tap to add`).substring(0, 72)
    };
  });
  const sections = [{ title: 'Food Items', rows: itemRows }];

  if (paged) {
    const navRows = [];
    if (page > 0) navRows.push({ id: `page_${page - 1}`, title: '◀ Previous items', description: `Page ${page} of ${Math.ceil(all.length / pageSize)}` });
    if ((page + 1) * pageSize < all.length) navRows.push({ id: `page_${page + 1}`, title: 'More items ▶', description: `Page ${page + 2} of ${Math.ceil(all.length / pageSize)}` });
    if (navRows.length) sections.push({ title: 'More', rows: navRows });
  }

  if (session.cart.length) {
    const count = session.cart.reduce((n, c) => n + c.qty, 0);
    sections.push({ title: 'Your Cart', rows: [
      { id: 'nav_cart', title: '🛒 View Cart / Checkout', description: `${count} item(s) | ${naira(cartTotal(session.cart))}` },
      { id: 'nav_remove', title: '➖ Remove an item', description: 'Take away 1 of an item' }
    ]});
  }

  let body = note ? `${note}\n\n` : '';
  body += 'Tap an item to add it (+1). Tap it again for more.';
  if (session.cart.length) body += `\n\n🛒 Cart: ${naira(cartTotal(session.cart))}`;

  await sendWhatsAppMessage(to, {
    messaging_product: 'whatsapp', to, type: 'interactive',
    interactive: {
      type: 'list',
      header: { type: 'text', text: (session.vendorName || 'Menu').substring(0, 60) },
      body: { text: body.substring(0, 1000) },
      action: { button: 'Browse Menu', sections }
    }
  });
}

// ---- WhatsApp Flow menu: real multi-select with a quantity dropdown per dish ----
async function sendMenuFlow(to, vendorId, page = 0, note = '') {
  const session = getSession(to);
  const { data: all, error } = await supabase.from('menu_items').select('id, name, price')
    .eq('vendor_id', vendorId).eq('in_stock', true).order('created_at', { ascending: true }).limit(200);
  if (error) { console.error(error.message); await sendText(to, 'Sorry, could not load the menu.'); return; }
  if (!all || all.length === 0) {
    await sendText(to, 'This store has no available menu items right now. Send *menu* to pick another restaurant.');
    return;
  }
  const PER_SCREEN = 10;
  const maxPage = Math.ceil(all.length / PER_SCREEN) - 1;
  if (page > maxPage || page < 0) page = 0;
  session.flowPage = page;
  const items = all.slice(page * PER_SCREEN, page * PER_SCREEN + PER_SCREEN);
  session.flowItems = items.map(i => ({ id: i.id, name: i.name, price: Number(i.price) }));

  const data = { title: (session.vendorName || 'Menu').substring(0, 60) };
  for (let n = 1; n <= PER_SCREEN; n++) {
    const it = items[n - 1];
    data[`i${n}_text`] = it ? `${it.name} - ${naira(it.price)}` : ' ';
    data[`i${n}_show`] = !!it;
  }

  let body = note ? `${note}\n\n` : '';
  body += 'Tap *Select Items*, choose how many of each dish you want, then tap *Add to Cart*.';
  if (all.length > PER_SCREEN) body += `\n\n📄 Menu page ${page + 1} of ${maxPage + 1}`;
  if (session.cart.length) body += `\n🛒 Cart: ${naira(cartTotal(session.cart))}`;

  const ok = await sendWhatsAppMessage(to, {
    messaging_product: 'whatsapp', to, type: 'interactive',
    interactive: {
      type: 'flow',
      body: { text: body.substring(0, 1000) },
      action: {
        name: 'flow',
        parameters: {
          flow_message_version: '3',
          flow_id: FLOW_ID,
          flow_cta: 'Select Items',
          mode: FLOW_MODE,
          flow_token: `${to}:${Date.now()}`,
          flow_action: 'navigate',
          flow_action_payload: { screen: 'MENU', data }
        }
      }
    }
  });
  if (!ok) { console.error('Flow send failed, falling back to list menu'); await sendMenuList(to, vendorId, 0, note); }
}

// Uses the Flow when FLOW_ID is set, otherwise the plain list menu
async function sendMenu(to, vendorId, page = 0, note = '') {
  if (FLOW_ID) return sendMenuFlow(to, vendorId, page, note);
  return sendMenuList(to, vendorId, page, note);
}

function cartSummary(cart) {
  return cart.map((i, idx) => `${idx + 1}. ${i.qty}x ${i.name} - ${naira(i.price * i.qty)}`).join('\n');
}

function sendCartView(to, session, note = '') {
  return sendButtonMessage(to,
    `${note ? note + '\n\n' : ''}🛒 *Your Cart*\n\n${cartSummary(session.cart)}\n\n*Food total:* ${naira(cartTotal(session.cart))}\n\n_Send *menu* any time to start over._`,
    [{ id: 'btn_add_more', title: '➕ Add Items' }, { id: 'btn_editcart', title: '➖ Remove Items' }, { id: 'btn_checkout', title: '✅ Checkout' }]);
}

function sendEditCartList(to, session) {
  const rows = session.cart.slice(0, 9).map(i => ({
    id: `cartrm_${i.id}`,
    title: `${i.qty}x ${i.name}`.substring(0, 24),
    description: `${naira(i.price * i.qty)} | tap to remove 1`
  }));
  rows.push({ id: 'cart_clear', title: '🗑 Clear cart', description: 'Remove everything and start again' });
  return sendList(to, 'Remove Items', 'Tap an item to remove 1 from your cart:', 'Remove Items', 'Your Items', rows);
}

// ---------- WEBHOOK ----------
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    const value = req.body.entry?.[0]?.changes?.[0]?.value;
    const message = value?.messages?.[0];
    if (!message) return;
    if (alreadySeen(message.id)) return;

    const from = message.from;
    const profileName = value?.contacts?.[0]?.profile?.name || 'WhatsApp Customer';
    const text = message.text?.body ? message.text.body.trim() : '';
    const textLower = text.toLowerCase();
    const listId = message.interactive?.list_reply?.id;
    const btnId = message.interactive?.button_reply?.id;

    const session = getSession(from);

    // FLOW SUBMISSION (customer chose dishes + quantities in the Flow)
    if (message.interactive?.type === 'nfm_reply') {
      let answers = {};
      try { answers = JSON.parse(message.interactive.nfm_reply.response_json || '{}'); } catch (e) {}
      if (!session.vendorId || !session.flowItems.length) { await sendText(from, 'Your session expired. Send *menu* to start again.'); return; }

      const ids = session.flowItems.map(i => i.id);
      const { data: fresh } = await supabase.from('menu_items').select('id, name, price, in_stock').in('id', ids);
      const freshById = {};
      (fresh || []).forEach(f => { freshById[f.id] = f; });

      const added = [], skipped = [];
      session.flowItems.forEach((it, idx) => {
        const q = Math.min(parseInt(answers['q' + (idx + 1)], 10) || 0, 20);
        if (q <= 0) return;
        const f = freshById[it.id];
        if (!f || !f.in_stock) { skipped.push(it.name); return; }
        let entry = session.cart.find(c => c.id === f.id);
        if (entry) entry.qty = Math.min(entry.qty + q, 20);
        else { entry = { id: f.id, name: f.name, price: Number(f.price), qty: q }; session.cart.push(entry); }
        added.push(`• ${q}x ${f.name}`);
      });

      if (!added.length) {
        await sendMenu(from, session.vendorId, session.flowPage, skipped.length ? `Sorry, sold out: ${skipped.join(', ')}.` : 'You did not choose any dish.');
        return;
      }
      let note = `✅ *Added to cart:*\n${added.join('\n')}`;
      if (skipped.length) note += `\n\n⚠️ Sold out: ${skipped.join(', ')}`;
      await sendCartView(from, session, note);
      return;
    }

    // MAIN MENU / CANCEL
    if (['hi', 'hello', 'start', 'menu'].includes(textLower) || btnId === 'btn_cancel') {
      resetSession(session);
      await sendMainMenu(from);
      return;
    }

    // DELIVERY ADDRESS STEP (checked first so an address can't trigger other routes)
    if (session.step === 'AWAITING_LOCATION' && text && !listId && !btnId) {
      session.address = text;
      session.step = 'AWAITING_CONFIRM';
      const sub = cartTotal(session.cart);
      await sendButtonMessage(from,
        `🧾 *Confirm Your Order*\n\n🏪 ${session.vendorName}\n${cartSummary(session.cart)}\n\nFood: ${naira(sub)}\nDelivery: ${naira(DELIVERY_FEE)}\n*Total: ${naira(sub + DELIVERY_FEE)}*\n\n📍 ${text}\n\n💵 Pay cash or transfer to the rider on delivery.`,
        [{ id: 'btn_confirm', title: '✅ Confirm Order' }, { id: 'btn_cancel', title: '❌ Cancel' }]);
      return;
    }

    // SERVICES
    if (listId === 'service_food' || textLower.includes('food')) {
      await sendVendorList(from);
      return;
    }
    if (listId === 'service_ride' || listId === 'service_package') {
      await sendText(from, 'This service is coming soon! Send *menu* to order food in the meantime.');
      return;
    }

    // SELECT VENDOR
    if (listId && listId.startsWith('vendor_')) {
      const vendorId = listId.replace('vendor_', '');
      const { data: v } = await supabase.from('vendors').select('id, store_name, is_open').eq('id', vendorId).maybeSingle();
      if (!v || !v.is_open) { await sendText(from, 'Sorry, that restaurant is closed right now. Send *menu* to choose another.'); return; }
      session.vendorId = v.id;
      session.vendorName = v.store_name;
      session.cart = [];
      session.activeItemId = null;
      session.menuPage = 0;
      await sendMenu(from, v.id, 0);
      return;
    }

    // MENU PAGINATION
    if (listId && listId.startsWith('page_')) {
      if (!session.vendorId) { await sendText(from, 'Please start again. Send *menu*.'); return; }
      session.menuPage = parseInt(listId.replace('page_', ''), 10) || 0;
      await sendMenu(from, session.vendorId, session.menuPage);
      return;
    }

    // SELECT ITEM (+1 each tap, then the menu list comes back with updated quantities)
    if (listId && listId.startsWith('item_')) {
      if (!session.vendorId) { await sendText(from, 'Please start again. Send *menu*.'); return; }
      const itemId = listId.replace('item_', '');
      const { data: item } = await supabase.from('menu_items').select('id, name, price, in_stock, vendor_id').eq('id', itemId).maybeSingle();
      if (!item || item.vendor_id !== session.vendorId) { await sendText(from, 'That item is not available.'); return; }
      if (!item.in_stock) { await sendMenu(from, session.vendorId, session.menuPage, `Sorry, ${item.name} is sold out.`); return; }

      let entry = session.cart.find(c => c.id === item.id);
      if (entry) entry.qty = Math.min(entry.qty + 1, 20);
      else { entry = { id: item.id, name: item.name, price: Number(item.price), qty: 1 }; session.cart.push(entry); }
      await sendMenu(from, session.vendorId, session.menuPage, `✅ Added *${item.name}* (x${entry.qty})`);
      return;
    }

    // CART ROWS INSIDE THE MENU LIST
    if (listId === 'nav_cart' || btnId === 'btn_cart') {
      if (session.cart.length === 0) { if (session.vendorId) await sendMenu(from, session.vendorId, session.menuPage, 'Your cart is empty.'); return; }
      await sendCartView(from, session);
      return;
    }
    if (listId === 'nav_remove' || btnId === 'btn_editcart') {
      if (session.cart.length === 0) { if (session.vendorId) await sendMenu(from, session.vendorId, session.menuPage, 'Your cart is empty.'); return; }
      await sendEditCartList(from, session);
      return;
    }
    if (listId && listId.startsWith('cartrm_')) {
      const entry = session.cart.find(c => c.id === listId.replace('cartrm_', ''));
      if (!entry) { await sendMenu(from, session.vendorId, session.menuPage); return; }
      entry.qty -= 1;
      if (entry.qty <= 0) session.cart = session.cart.filter(c => c.id !== entry.id);
      const rmNote = `➖ Removed 1 *${entry.name}*${entry.qty > 0 ? ` (x${entry.qty} left)` : ' (removed from cart)'}`;
      if (FLOW_ID && session.cart.length) await sendCartView(from, session, rmNote);
      else await sendMenu(from, session.vendorId, session.menuPage, rmNote);
      return;
    }
    if (listId === 'cart_clear') {
      session.cart = [];
      if (session.vendorId) await sendMenu(from, session.vendorId, 0, 'Cart cleared.');
      return;
    }

    // ADD MORE
    if (btnId === 'btn_add_more') {
      if (!session.vendorId) { await sendText(from, 'Please start again. Send *menu*.'); return; }
      await sendMenu(from, session.vendorId, FLOW_ID ? session.flowPage + 1 : session.menuPage);
      return;
    }

    // CHECKOUT
    if (btnId === 'btn_checkout') {
      if (session.cart.length === 0) { await sendText(from, 'Your cart is empty. Send *menu* to start.'); return; }
      session.step = 'AWAITING_LOCATION';
      await sendText(from, '📍 *Enter Delivery Address*\n\nPlease reply with your full street address or nearby landmark.');
      return;
    }

    // CONFIRM + SAVE ORDER
    if (btnId === 'btn_confirm') {
      if (session.step !== 'AWAITING_CONFIRM' || session.cart.length === 0) { await sendText(from, 'Nothing to confirm. Send *menu* to start.'); return; }

      const { data: v } = await supabase.from('vendors').select('id, is_open').eq('id', session.vendorId).maybeSingle();
      if (!v || !v.is_open) { await sendText(from, 'Sorry, the restaurant just closed. Send *menu* to choose another.'); resetSession(session); return; }

      const pin = Math.floor(1000 + Math.random() * 9000).toString();
      const subtotal = cartTotal(session.cart);
      const orderNumber = '#' + Date.now().toString().slice(-6);

      const { error } = await supabase.from('orders').insert({
        order_number: orderNumber,
        vendor_id: session.vendorId,
        customer_name: profileName,
        customer_phone: from,
        delivery_address: session.address,
        items: session.cart.map(i => ({ name: i.name, qty: i.qty, price: i.price })),
        total: subtotal,
        delivery_fee: DELIVERY_FEE,
        status: 'new',
        delivery_code: pin,
        source: 'whatsapp'
      });

      if (error) {
        console.error('❌ Order insert failed:', error.message);
        await sendText(from, 'Sorry, we could not place your order. Please try again.');
        return;
      }

      await sendText(from,
        `🎉 *Order Received!* ${orderNumber}\n\n🏪 ${session.vendorName}\nFood: ${naira(subtotal)}\nDelivery: ${naira(DELIVERY_FEE)}\n*Total: ${naira(subtotal + DELIVERY_FEE)}*\n📍 ${session.address}\n\n🔑 *YOUR DELIVERY PIN:* *${pin}*\nGive this code to your rider when your food arrives. We'll message you with updates.`);
      resetSession(session);
      return;
    }

    // Anything else: guide the customer
    await sendText(from, 'Send *menu* to start an order.');

  } catch (err) {
    console.error('❌ Webhook error:', err.message);
  }
});

// ---------- CUSTOMER STATUS UPDATES (checks the database every 6 seconds) ----------
function statusMessage(o) {
  const name = o.riders?.profiles?.name;
  const rphone = o.riders?.profiles?.phone;
  switch (o.status) {
    case 'preparing': return `🍳 *${o.order_number}:* The restaurant accepted your order and is preparing your meal!`;
    case 'ready_for_rider': return `📦 *${o.order_number}:* Your food is ready! We're finding a rider now.`;
    case 'accepted': return `🛵 *${o.order_number}:* ${name ? name : 'A rider'} accepted your order${rphone ? ` (${rphone})` : ''} and is heading to the restaurant.`;
    case 'picked_up': return `🚀 *${o.order_number}:* Your food has been picked up and is on the way!\n\n🔑 Your delivery PIN: *${o.delivery_code}*`;
    case 'arrived_at_customer': return `📍 *${o.order_number}:* Your rider has arrived! Give them your PIN: *${o.delivery_code}*`;
    case 'delivered': return `✅ *${o.order_number}:* Delivered! Enjoy your meal. Thank you for ordering with us. Send *menu* to order again.`;
    case 'cancelled': return `❌ *${o.order_number}:* Sorry, your order was cancelled${o.cancel_reason ? ` (${o.cancel_reason})` : ''}. Send *menu* to order from another restaurant.`;
    default: return '';
  }
}

let notifying = false;
async function notifyCustomers() {
  if (notifying) return;
  notifying = true;
  try {
    const { data: orders, error } = await supabase.from('orders')
      .select('id, order_number, status, customer_phone, delivery_code, cancel_reason, riders(profiles(name, phone))')
      .eq('source', 'whatsapp').eq('wa_pending', true).limit(20);
    if (error) { console.error('Notifier query error:', error.message); return; }

    for (const o of orders || []) {
      const msg = statusMessage(o);
      if (msg && o.customer_phone) await sendText(o.customer_phone, msg);
      await supabase.from('orders').update({ wa_pending: false }).eq('id', o.id);
    }
  } catch (e) {
    console.error('Notifier error:', e.message);
  } finally {
    notifying = false;
  }
}
setInterval(notifyCustomers, 6000);

app.get('/', (req, res) => res.send('WhatsApp delivery bot is running.'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server listening on port ${PORT}`));
