const express = require('express');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());

const SUPABASE_URL = 'https://glkutdkwbrjpiuqcmgwe.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imdsa3V0ZGt3YnJqcGl1cWNtZ3dlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk5NzU3MTMsImV4cCI6MjEwNTU1MTcxM30.f2SgZJvP681imm0Qe1fKsATnCk_86z2guwvZWASXoZM';
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

const sessions = {};

function getSession(phone) {
  if (!sessions[phone]) {
    sessions[phone] = { cart: [], step: 'IDLE', vendorId: null };
  }
  return sessions[phone];
}

app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode && token === (process.env.VERIFY_TOKEN || 'my_verify_token')) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

async function sendWhatsAppMessage(to, payload) {
  try {
    await axios.post(
      `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`,
      payload,
      { headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    console.error('❌ Error sending WhatsApp message:', err.response?.data || err.message);
  }
}

async function sendButtonMessage(to, bodyText, buttons) {
  const payload = {
    messaging_product: 'whatsapp',
    to: to,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: bodyText },
      action: { buttons: buttons.map(b => ({ type: 'reply', reply: { id: b.id, title: b.title } })) }
    }
  };
  await sendWhatsAppMessage(to, payload);
}

// LISTEN FOR WEBHOOK EVENTS FROM WHATSAPP
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const message = changes?.value?.messages?.[0];
    if (!message) return;

    const from = message.from;
    const text = message.text?.body ? message.text.body.trim() : '';
    const textLower = text.toLowerCase();
    const selectedListId = message.interactive?.list_reply?.id;
    const selectedButtonId = message.interactive?.button_reply?.id;

    const session = getSession(from);

    // MAIN MENU ROUTE
    if (textLower === 'hi' || textLower === 'hello' || textLower === 'start' || textLower === 'menu' || selectedButtonId === 'btn_cancel') {
      session.cart = [];
      session.step = 'IDLE';
      session.vendorId = null;

      const mainPayload = {
        messaging_product: 'whatsapp',
        to: from,
        type: 'interactive',
        interactive: {
          type: 'list',
          header: { type: 'text', text: 'David Delivery Network' },
          body: { text: 'Welcome! How can we assist you today?' },
          action: {
            button: 'Select Service',
            sections: [{
              title: 'Available Services',
              rows: [
                { id: 'service_food', title: '🍔 Order Food', description: 'Order from local restaurants' },
                { id: 'service_ride', title: '🛺 Book a Ride', description: 'Request fast transport' },
                { id: 'service_package', title: '📦 Send a Package', description: 'Doorstep parcel delivery' }
              ]
            }]
          }
        }
      };
      await sendWhatsAppMessage(from, mainPayload);
      return;
    }

    // ORDER FOOD ROUTE
    if (selectedListId === 'service_food' || textLower.includes('food')) {
      const { data: stores } = await supabase.from('vendors').select('*').eq('is_open', true);

      if (stores && stores.length > 0) {
        const rows = stores.slice(0, 10).map((s, idx) => ({
          id: `vendor_${s.id}`,
          title: (s.name || s.store_name || `Store ${idx + 1}`).substring(0, 24),
          description: (s.description || 'View menu & order food').substring(0, 72)
        }));

        await sendWhatsAppMessage(from, {
          messaging_product: 'whatsapp',
          to: from,
          type: 'interactive',
          interactive: {
            type: 'list',
            header: { type: 'text', text: 'Select Restaurant' },
            body: { text: 'Choose an open restaurant:' },
            action: { button: 'View Restaurants', sections: [{ title: 'Open Stores', rows }] }
          }
        });
      } else {
        await sendWhatsAppMessage(from, { messaging_product: 'whatsapp', to: from, type: 'text', text: { body: 'No restaurants are currently open. Check back shortly!' } });
      }
      return;
    }

    // SELECT VENDOR
    if (selectedListId && selectedListId.startsWith('vendor_')) {
      const vendorId = selectedListId.replace('vendor_', '');
      session.vendorId = vendorId;

      const { data: menuItems } = await supabase.from('menu_items').select('*').eq('restaurant_id', vendorId);

      if (!menuItems || menuItems.length === 0) {
        await sendWhatsAppMessage(from, { messaging_product: 'whatsapp', to: from, type: 'text', text: { body: 'This store has no active menu items.' } });
        return;
      }

      const rows = menuItems.slice(0, 10).map((item, idx) => ({
        id: `item_${item.id}`,
        title: (item.title || item.name || `Item ${idx + 1}`).substring(0, 24),
        description: `Price: ₦${item.price || '0'}`
      }));

      await sendWhatsAppMessage(from, {
        messaging_product: 'whatsapp',
        to: from,
        type: 'interactive',
        interactive: {
          type: 'list',
          header: { type: 'text', text: 'Select Menu Items' },
          body: { text: 'Tap an item to add to your order cart:' },
          action: { button: 'Browse Menu', sections: [{ title: 'Food Items', rows }] }
        }
      });
      return;
    }

    // SELECT ITEM
    if (selectedListId && selectedListId.startsWith('item_')) {
      const itemId = selectedListId.replace('item_', '');
      const { data: item } = await supabase.from('menu_items').select('*').eq('id', itemId).single();

      if (item) {
        session.cart.push({ id: item.id, title: item.title || item.name, price: Number(item.price || 0) });
        const total = session.cart.reduce((sum, i) => sum + i.price, 0);
        const list = session.cart.map((i, idx) => `${idx + 1}. ${i.title} - ₦${i.price}`).join('\n');

        await sendButtonMessage(from, `🛒 *Item Added!*\n\n*Cart Contents:*\n${list}\n\n*Total:* ₦${total}`, [
          { id: 'btn_add_more', title: '➕ Add More' },
          { id: 'btn_checkout', title: '✅ Checkout' },
          { id: 'btn_cancel', title: '❌ Cancel' }
        ]);
      }
      return;
    }

    // CHECKOUT
    if (selectedButtonId === 'btn_checkout') {
      session.step = 'AWAITING_LOCATION';
      await sendWhatsAppMessage(from, {
        messaging_product: 'whatsapp',
        to: from,
        type: 'text',
        text: { body: '📍 *Enter Delivery Address*\n\nPlease reply with your full street address or nearby landmark.' }
      });
      return;
    }

    // SAVE ORDER & GENERATE PIN
    if (session.step === 'AWAITING_LOCATION' && text) {
      const pin = Math.floor(1000 + Math.random() * 9000).toString();
      const total = session.cart.reduce((sum, i) => sum + i.price, 0);

      await supabase.from('orders').insert([{
        customer_phone: from,
        vendor_id: session.vendorId,
        items: session.cart,
        total_amount: total,
        delivery_address: text,
        delivery_code: pin,
        status: 'pending'
      }]);

      await sendWhatsAppMessage(from, {
        messaging_product: 'whatsapp',
        to: from,
        type: 'text',
        text: { body: `🎉 *Order Received!*\n\nTotal: ₦${total}\nAddress: ${text}\n\n🔑 *YOUR DELIVERY PIN:* *${pin}*\nGive this code to your rider upon delivery!` }
      });

      session.cart = [];
      session.step = 'IDLE';
      session.vendorId = null;
      return;
    }

  } catch (err) {
    console.error('❌ Webhook error:', err.message);
  }
});

// REALTIME CUSTOMER NOTIFIER ON ORDER STATUS CHANGES
supabase.channel('public:orders_status')
  .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'orders' }, async payload => {
    const updatedOrder = payload.new;
    const phone = updatedOrder.customer_phone;
    const status = updatedOrder.status;

    let msg = '';
    if (status === 'preparing') msg = `🍳 *Kitchen Update:* The restaurant has accepted your order and is preparing your meal!`;
    if (status === 'ready') msg = `🛵 *Rider Alert:* Your food is ready! A rider is picking it up right now.`;
    if (status === 'delivered') msg = `✅ *Order Delivered:* Enjoy your meal! Thank you for ordering with us.`;

    if (msg && phone) {
      await sendWhatsAppMessage(phone, { messaging_product: 'whatsapp', to: phone, type: 'text', text: { body: msg } });
    }
  })
  .subscribe();

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server listening on port ${PORT}`));