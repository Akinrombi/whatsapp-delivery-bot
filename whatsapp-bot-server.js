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

if (!SUPABASE_SERVICE_KEY) console.error('❌ SUPABASE_SERVICE_KEY is missing. Add it in Render > Environment.');

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY || 'missing', {
  auth: { persistSession: false, autoRefreshToken: false }
});

// ---------- SESSIONS (in memory) ----------
const sessions = {};
function getSession(phone) {
  if (!sessions[phone]) sessions[phone] = { cart: [], step: 'IDLE', vendorId: null, vendorName: '', address: '', activeItemId: null, menuPage: 0 };
  return sessions[phone];
}
function resetSession(s) { s.cart = []; s.step = 'IDLE'; s.vendorId = null; s.vendorName = ''; s.address = ''; s.activeItemId = null; s.menuPage = 0; }
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

async function sendMenu(to, vendorId, page = 0) {
  const { data: all, error } = await supabase.from('menu_items').select('id, name, price')
    .eq('vendor_id', vendorId).eq('in_stock', true).order('created_at', { ascending: true }).limit(200);
  if (error) { console.error(error.message); await sendText(to, 'Sorry, could not load the menu.'); return; }
  if (!all || all.length === 0) {
    await sendText(to, 'This store has no available menu items right now. Send *menu* to pick another restaurant.');
    return;
  }

  // WhatsApp lists allow max 10 rows. If more items, show 8 per page with Previous/Next rows.
  let items = all, rows = [];
  const paged = all.length > 10;
  const pageSize = 8;
  if (paged) {
    const maxPage = Math.ceil(all.length / pageSize) - 1;
    page = Math.min(Math.max(page, 0), maxPage);
    items = all.slice(page * pageSize, page * pageSize + pageSize);
  }
  rows = items.map((it, i) => ({
    id: `item_${it.id}`,
    title: (it.name || `Item ${i + 1}`).substring(0, 24),
    description: `Price: ${naira(it.price)}`
  }));
  if (paged) {
    if (page > 0) rows.push({ id: `page_${page - 1}`, title: '◀ Previous items', description: `Page ${page} of ${Math.ceil(all.length / pageSize)}` });
    if ((page + 1) * pageSize < all.length) rows.push({ id: `page_${page + 1}`, title: 'More items ▶', description: `Page ${page + 2} of ${Math.ceil(all.length / pageSize)}` });
  }
  await sendList(to, 'Select Menu Items', 'Tap an item to add it. You can add as many as you like and change quantities.', 'Browse Menu', 'Food Items', rows);
}

function cartSummary(cart) {
  return cart.map((i, idx) => `${idx + 1}. ${i.qty}x ${i.name} - ${naira(i.price * i.qty)}`).join('\n');
}

// Quantity stepper for one item: ➖ / ➕ buttons
function sendStepper(to, session, item) {
  return sendButtonMessage(to,
    `🍽 *${item.name}*\nQty: *${item.qty}*  •  ${naira(item.price * item.qty)}\n\n🛒 Cart total: *${naira(cartTotal(session.cart))}*`,
    [{ id: 'btn_minus', title: '➖ Remove 1' }, { id: 'btn_plus', title: '➕ Add 1' }, { id: 'btn_cart', title: '🛒 View Cart' }]);
}

function sendCartView(to, session) {
  return sendButtonMessage(to,
    `🛒 *Your Cart*\n\n${cartSummary(session.cart)}\n\n*Food total:* ${naira(cartTotal(session.cart))}\n\n_Send *menu* any time to start over._`,
    [{ id: 'btn_add_more', title: '➕ Add Items' }, { id: 'btn_editcart', title: '✏️ Edit Cart' }, { id: 'btn_checkout', title: '✅ Checkout' }]);
}

function sendEditCartList(to, session) {
  const rows = session.cart.slice(0, 9).map(i => ({
    id: `cartedit_${i.id}`,
    title: `${i.qty}x ${i.name}`.substring(0, 24),
    description: `${naira(i.price * i.qty)} - tap to change quantity`
  }));
  rows.push({ id: 'cart_clear', title: '🗑 Clear cart', description: 'Remove everything and start again' });
  return sendList(to, 'Edit Cart', 'Pick an item to change its quantity:', 'Edit Items', 'Your Items', rows);
}

async function afterQtyChange(to, session) {
  if (session.cart.length === 0) {
    session.activeItemId = null;
    await sendText(to, 'Your cart is empty. Pick an item to start again.');
    await sendMenu(to, session.vendorId, session.menuPage);
    return;
  }
  const active = session.cart.find(c => c.id === session.activeItemId);
  if (active) await sendStepper(to, session, active);
  else await sendCartView(to, session);
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

    // SELECT ITEM (adds 1 and opens the +/- stepper)
    if (listId && listId.startsWith('item_')) {
      if (!session.vendorId) { await sendText(from, 'Please start again. Send *menu*.'); return; }
      const itemId = listId.replace('item_', '');
      const { data: item } = await supabase.from('menu_items').select('id, name, price, in_stock, vendor_id').eq('id', itemId).maybeSingle();
      if (!item || item.vendor_id !== session.vendorId) { await sendText(from, 'That item is not available.'); return; }
      if (!item.in_stock) { await sendText(from, `Sorry, ${item.name} is sold out. Pick something else.`); await sendMenu(from, session.vendorId, session.menuPage); return; }

      let entry = session.cart.find(c => c.id === item.id);
      if (entry) entry.qty = Math.min(entry.qty + 1, 20);
      else { entry = { id: item.id, name: item.name, price: Number(item.price), qty: 1 }; session.cart.push(entry); }
      session.activeItemId = item.id;
      await sendStepper(from, session, entry);
      return;
    }

    // + / - BUTTONS
    if (btnId === 'btn_plus' || btnId === 'btn_minus') {
      const entry = session.cart.find(c => c.id === session.activeItemId);
      if (!entry) { await sendCartView(from, session); return; }
      if (btnId === 'btn_plus') entry.qty = Math.min(entry.qty + 1, 20);
      else {
        entry.qty -= 1;
        if (entry.qty <= 0) { session.cart = session.cart.filter(c => c.id !== entry.id); session.activeItemId = null; }
      }
      await afterQtyChange(from, session);
      return;
    }

    // VIEW / EDIT CART
    if (btnId === 'btn_cart') {
      if (session.cart.length === 0) { await sendText(from, 'Your cart is empty.'); if (session.vendorId) await sendMenu(from, session.vendorId, session.menuPage); return; }
      await sendCartView(from, session);
      return;
    }
    if (btnId === 'btn_editcart') {
      if (session.cart.length === 0) { await sendText(from, 'Your cart is empty.'); return; }
      await sendEditCartList(from, session);
      return;
    }
    if (listId && listId.startsWith('cartedit_')) {
      const entry = session.cart.find(c => c.id === listId.replace('cartedit_', ''));
      if (!entry) { await sendCartView(from, session); return; }
      session.activeItemId = entry.id;
      await sendStepper(from, session, entry);
      return;
    }
    if (listId === 'cart_clear') {
      session.cart = []; session.activeItemId = null;
      await sendText(from, 'Cart cleared.');
      if (session.vendorId) await sendMenu(from, session.vendorId, 0);
      return;
    }

    // ADD MORE
    if (btnId === 'btn_add_more') {
      if (!session.vendorId) { await sendText(from, 'Please start again. Send *menu*.'); return; }
      await sendMenu(from, session.vendorId, session.menuPage);
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
