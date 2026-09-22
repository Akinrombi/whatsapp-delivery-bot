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

// Helper: Fetch all vendors
async function getStores() {
  const { data, error } = await supabase.from('vendors').select('*');
  if (error) {
    console.error('❌ Supabase vendors fetch error:', error.message);
    return [];
  }
  return data || [];
}

// Helper: Send message to WhatsApp API
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
    const text = message.text?.body ? message.text.body.trim().toLowerCase() : '';
    const selectedListId = message.interactive?.list_reply?.id;

    // Auto-register customer details on every message
    await autoRegisterUser(from, profileName);

    // 1. Initial Main Menu (Greeting)
    if (text === 'hi' || text === 'hello' || text === 'start' || text === 'menu') {
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
    if (selectedListId === 'service_food' || text.includes('food')) {
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

    // 3. Selected a Restaurant -> Fetch Menu Items matching restaurant_id
    if (selectedListId && selectedListId.startsWith('vendor_')) {
      const vendorId = selectedListId.replace('vendor_', '');

      // Querying matching restaurant_id column from your database
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
        // Using title and price columns matching your database
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
          body: { text: 'Select an item to place your order:' },
          action: {
            button: 'View Menu',
            sections: [{ title: 'Available Food', rows: menuRows }]
          }
        }
      };
      await sendWhatsAppMessage(from, menuPayload);
      return;
    }

    // 4. Clicked "Book a Ride"
    if (selectedListId === 'service_ride' || text.includes('ride')) {
      await sendWhatsAppMessage(from, {
        messaging_product: 'whatsapp',
        to: from,
        type: 'text',
        text: { body: '🛺 *Ride Booking*\nPlease reply with your pickup location and destination.' }
      });
      return;
    }

    // 5. Clicked "Send a Package"
    if (selectedListId === 'service_package' || text.includes('package')) {
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