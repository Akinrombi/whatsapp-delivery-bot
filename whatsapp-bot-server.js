const express = require('express');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());

// Initialize Supabase
const SUPABASE_URL = 'https://glkutdkwbrjpiuqcmgwe.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imdsa3V0ZGt3YnJqcGl1cWNtZ3dlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk5NzU3MTMsImV4cCI6MjEwNTU1MTcxM30.f2SgZJvP681imm0Qe1fKsATnCk_86z2guwvZWASXoZM';
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

// Session store for multi-item cart management and step tracking
const sessions = {};

function getSession(phone) {
  if (!sessions[phone]) {
    sessions[phone] = {
      cart: [],
      step: 'IDLE',
      vendorId: null
    };
  }
  return sessions[phone];
}

// GET Webhook Verification for Meta
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token === (process.env.VERIFY_TOKEN || 'my_verify_token')) {
    console.log('✅ Webhook verified successfully!');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// Helper: Auto-register user in Supabase
async function autoRegisterUser(fromPhoneNumber, profileName) {
  try {
    await supabase.from('customers').upsert(
      { phone_number: fromPhoneNumber, name: profileName || 'WhatsApp User' },
      { onConflict: 'phone_number' }
    );
  } catch (err) {
    console.error('❌ User registration error:', err.message);
  }
}

// Helper: Fetch vendors from Supabase
async function getStores() {
  const { data, error } = await supabase.from('vendors').select('*');
  if (error) {
    console.error('❌ Supabase vendors fetch error:', error.message);
    return [];
  }
  return data || [];
}

// Helper: Send message to Meta WhatsApp API
async function sendWhatsAppMessage(to, payload) {
  try {
    await axios.post(
      `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`,
      payload,
      {
        headers: {
          'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );
    console.log('✅ Message sent successfully!');
  } catch (err) {
    console.error('❌ Error sending WhatsApp message:', err.response?.data || err.message);
  }
}

// Helper: Send interactive buttons (up to 3 options)
async function sendButtonMessage(to, bodyText, buttons) {
  const payload = {
    messaging_product: 'whatsapp',
    to: to,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: bodyText },
      action: {
        buttons: buttons.map(b => ({
          type: 'reply',
          reply: { id: b.id, title: b.title }
        }))
      }
    }
  };
  await sendWhatsAppMessage(to, payload);
}

// POST Webhook Listener
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);

  try {
    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const message = value?.messages?.[0];

    if (!message) return;

    const from = message.from;
    const profileName = value?.contacts?.[0]?.profile?.name;
    const text = message.text?.body ? message.text.body.trim() : '';
    const textLower = text.toLowerCase();
    const selectedListId = message.interactive?.list_reply?.id;
    const selectedButtonId = message.interactive?.button_reply?.id;

    // Auto-register customer details on every message
    await autoRegisterUser(from, profileName);

    const session = getSession(from);

    // 1. Initial Greeting or Reset
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
          header: { type: 'text', text: 'David Delivery Services' },
          body: { text: 'Welcome! What would you like to do today?' },
          action: {
            button: 'Select Service',
            sections: [
              {
                title: 'Our Services',
                rows: [
                  { id: 'service_food', title: '🍔 Order Food', description: 'Browse vendors and order meals' },
                  { id: 'service_ride', title: '🛺 Book a Ride', description: 'Request a quick pickup or transport' },
                  { id: 'service_package', title: '📦 Send a Package', description: 'Fast doorstep courier dispatch' }
                ]
              }
            ]
          }
        }
      };
      await sendWhatsAppMessage(from, mainPayload);
      return;
    }

    // 2. Clicked "Order Food" -> Fetch Vendors
    if (selectedListId === 'service_food' || textLower.includes('food')) {
      const stores = await getStores();

      if (stores && stores.length > 0) {
        const vendorRows = stores.slice(0, 10).map((s, idx) => {
          let title = String(s.name || s.store_name || `Store ${idx + 1}`).trim();
          let description = String(s.description || 'View menu and order food').trim();

          if (title.length > 24) title = title.substring(0, 21) + '...';
          if (description.length > 72) description = description.substring(0, 69) + '...';

          return {
            id: `vendor_${s.id}`,
            title: title,
            description: description
          };
        });

        const foodPayload = {
          messaging_product: 'whatsapp',
          to: from,
          type: 'interactive',
          interactive: {
            type: 'list',
            header: { type: 'text', text: 'Select Restaurant' },
            body: { text: 'Choose a vendor below to view their menu:' },
            action: {
              button: 'View Restaurants',
              sections: [{ title: 'Available Vendors', rows: vendorRows }]
            }
          }
        };
        await sendWhatsAppMessage(from, foodPayload);
      } else {
        await sendWhatsAppMessage(from, {
          messaging_product: 'whatsapp',
          to: from,
          type: 'text',
          text: { body: 'No restaurants are currently available. Please check back shortly.' }
        });
      }
      return;
    }

    // 3. Selected a Restaurant -> Fetch Menu Items using restaurant_id column
    if (selectedListId && selectedListId.startsWith('vendor_')) {
      const vendorId = selectedListId.replace('vendor_', '');
      session.vendorId = vendorId;

      const { data: menuItems, error } = await supabase
        .from('menu_items')
        .select('*')
        .eq('restaurant_id', vendorId);

      if (error || !menuItems || menuItems.length === 0) {
        await sendWhatsAppMessage(from, {
          messaging_product: 'whatsapp',
          to: from,
          type: 'text',
          text: { body: 'Sorry, this restaurant has not uploaded any menu items yet.' }
        });
        return;
      }

      const menuRows = menuItems.slice(0, 10).map((item, idx) => {
        let title = String(item.title || item.name || `Item ${idx + 1}`).trim();
        let description = String(`Price: ₦${item.price || '0'}`).trim();

        if (title.length > 24) title = title.substring(0, 21) + '...';
        if (description.length > 72) description = description.substring(0, 69) + '...';

        return {
          id: `item_${item.id}`,
          title: title,
          description: description
        };
      });

      const menuPayload = {
        messaging_product: 'whatsapp',
        to: from,
        type: 'interactive',
        interactive: {
          type: 'list',
          header: { type: 'text', text: 'Restaurant Menu' },
          body: { text: 'Select an item to add to your order cart:' },
          action: {
            button: 'View Menu',
            sections: [{ title: 'Available Food', rows: menuRows }]
          }
        }
      };
      await sendWhatsAppMessage(from, menuPayload);
      return;
    }

    // 4. Selected a Menu Item -> Add to Cart & Offer Options
    if (selectedListId && selectedListId.startsWith('item_')) {
      const itemId = selectedListId.replace('item_', '');

      const { data: item } = await supabase
        .from('menu_items')
        .select('*')
        .eq('id', itemId)
        .single();

      if (item) {
        session.cart.push({
          id: item.id,
          title: item.title || item.name || 'Food Item',
          price: Number(item.price || 0)
        });

        const totalCost = session.cart.reduce((sum, i) => sum + i.price, 0);
        const cartText = session.cart.map((i, idx) => `${idx + 1}. ${i.title} - ₦${i.price}`).join('\n');

        const bodyMsg = `🛒 *Item Added to Cart!*\n\n*Current Cart:*\n${cartText}\n\n*Total:* ₦${totalCost}\n\nWould you like to add more items or proceed to checkout?`;

        await sendButtonMessage(from, bodyMsg, [
          { id: 'btn_add_more', title: '➕ Add More Items' },
          { id: 'btn_checkout', title: '✅ Checkout Now' },
          { id: 'btn_cancel', title: '❌ Cancel Order' }
        ]);
      }
      return;
    }

    // 5. Clicked "Add More Items" -> Reload Restaurant Menu
    if (selectedButtonId === 'btn_add_more') {
      if (!session.vendorId) {
        await sendWhatsAppMessage(from, { messaging_product: 'whatsapp', to: from, type: 'text', text: { body: 'Please send "Hi" to start again.' } });
        return;
      }

      const { data: menuItems } = await supabase
        .from('menu_items')
        .select('*')
        .eq('restaurant_id', session.vendorId);

      if (menuItems) {
        const menuRows = menuItems.slice(0, 10).map((item, idx) => {
          let title = String(item.title || item.name || `Item ${idx + 1}`).trim();
          let description = String(`Price: ₦${item.price || '0'}`).trim();

          if (title.length > 24) title = title.substring(0, 21) + '...';
          if (description.length > 72) description = description.substring(0, 69) + '...';

          return {
            id: `item_${item.id}`,
            title: title,
            description: description
          };
        });

        const menuPayload = {
          messaging_product: 'whatsapp',
          to: from,
          type: 'interactive',
          interactive: {
            type: 'list',
            header: { type: 'text', text: 'Restaurant Menu' },
            body: { text: 'Select another item to add to your order:' },
            action: {
              button: 'View Menu',
              sections: [{ title: 'Available Food', rows: menuRows }]
            }
          }
        };
        await sendWhatsAppMessage(from, menuPayload);
      }
      return;
    }

    // 6. Clicked "Checkout Now" -> Ask for Drop-off Location
    if (selectedButtonId === 'btn_checkout') {
      if (session.cart.length === 0) {
        await sendWhatsAppMessage(from, { messaging_product: 'whatsapp', to: from, type: 'text', text: { body: 'Your cart is empty! Send "Hi" to start.' } });
        return;
      }

      session.step = 'AWAITING_LOCATION';

      await sendWhatsAppMessage(from, {
        messaging_product: 'whatsapp',
        to: from,
        type: 'text',
        text: { body: '📍 *Drop-off Location Required*\n\nPlease reply with your full delivery address or drop-off location.' }
      });
      return;
    }

    // 7. User Provided Drop-off Location -> Generate Delivery Code & Save Order
    if (session.step === 'AWAITING_LOCATION' && text) {
      const dropoffLocation = text;
      const deliveryCode = Math.floor(1000 + Math.random() * 9000).toString();
      const totalCost = session.cart.reduce((sum, i) => sum + i.price, 0);
      const cartSummary = session.cart.map(i => `- ${i.title} (₦${i.price})`).join('\n');

      try {
        await supabase.from('orders').insert([
          {
            customer_phone: from,
            vendor_id: session.vendorId,
            items: session.cart,
            total_amount: totalCost,
            delivery_address: dropoffLocation,
            delivery_code: deliveryCode,
            status: 'pending'
          }
        ]);
      } catch (err) {
        console.error('❌ Error saving order to Supabase:', err.message);
      }

      const confirmationMsg = `🎉 *Order Placed Successfully!*\n\n` +
        `📦 *Order Details:*\n${cartSummary}\n\n` +
        `💰 *Total Price:* ₦${totalCost}\n` +
        `📍 *Drop-off Address:* ${dropoffLocation}\n\n` +
        `🔑 *YOUR 4-DIGIT DELIVERY PIN:* *${deliveryCode}*\n\n` +
        `*Note:* Please give this 4-digit PIN to the delivery rider upon arrival to confirm your package receipt. Thank you for using David Delivery!`;

      await sendWhatsAppMessage(from, {
        messaging_product: 'whatsapp',
        to: from,
        type: 'text',
        text: { body: confirmationMsg }
      });

      session.cart = [];
      session.step = 'IDLE';
      session.vendorId = null;
      return;
    }

    // 8. Rides Option
    if (selectedListId === 'service_ride' || textLower.includes('ride')) {
      await sendWhatsAppMessage(from, {
        messaging_product: 'whatsapp',
        to: from,
        type: 'text',
        text: { body: '🛺 *Ride Booking*\nPlease reply with your pickup location and destination.' }
      });
      return;
    }

    // 9. Packages Option
    if (selectedListId === 'service_package' || textLower.includes('package')) {
      await sendWhatsAppMessage(from, {
        messaging_product: 'whatsapp',
        to: from,
        type: 'text',
        text: { body: '📦 *Package Courier*\nPlease reply with package details, pickup address, and receiver phone number.' }
      });
      return;
    }

  } catch (err) {
    console.error('❌ Error handling webhook:', err.message);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));