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

// Webhook Verification
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

// Helper to fetch stores safely from Supabase
async function getStores() {
  const { data, error } = await supabase.from('vendors').select('*');
  if (error) {
    console.error('❌ Supabase fetch error:', error.message);
    return [];
  }
  return data || [];
}

// Helper to send WhatsApp messages
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
    const message = changes?.value?.messages?.[0];

    if (!message) return;

    const from = message.from;
    const text = message.text?.body ? message.text.body.trim().toLowerCase() : '';
    const selectedListId = message.interactive?.list_reply?.id;
    const selectedButtonId = message.interactive?.button_reply?.id;

    console.log(`📩 Incoming message from ${from}: "${text || selectedListId || selectedButtonId}"`);

    // 1. Initial Greeting -> Show Main Service Menu (Food, Rides, Packages)
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

    // 2. User Clicked "Order Food" -> Fetch Vendors Dynamically from Supabase
    if (selectedListId === 'service_food' || text.includes('food') || text.includes('order')) {
      const stores = await getStores();

      if (stores && stores.length > 0) {
        // Enforce Meta API Rules: Max 10 rows, Title <= 24 chars, Desc <= 72 chars
        const vendorRows = stores.slice(0, 10).map((s, idx) => {
          let rawName = s.store_name || s.name || `Store ${idx + 1}`;
          let rawDesc = s.description || 'View menu and order food';

          let title = String(rawName).trim();
          let description = String(rawDesc).trim();

          if (title.length > 24) title = title.substring(0, 21) + '...';
          if (description.length > 72) description = description.substring(0, 69) + '...';

          return {
            id: `vendor_${s.id || idx}`,
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
            body: { text: 'Choose a vendor below to view menu & order:' },
            action: {
              button: 'View Restaurants',
              sections: [{ title: 'Available Vendors', rows: vendorRows }]
            }
          }
        };
        await sendWhatsAppMessage(from, foodPayload);
      } else {
        // Fallback if zero stores found
        await sendWhatsAppMessage(from, {
          messaging_product: 'whatsapp',
          to: from,
          type: 'text',
          text: { body: 'Welcome to David Delivery! No restaurants are currently available. Please check back shortly.' }
        });
      }
      return;
    }

    // 3. User Clicked "Book a Ride"
    if (selectedListId === 'service_ride' || text.includes('ride')) {
      await sendWhatsAppMessage(from, {
        messaging_product: 'whatsapp',
        to: from,
        type: 'text',
        text: { body: '🛺 *Ride Booking*\nPlease reply with your pickup location and destination.' }
      });
      return;
    }

    // 4. User Clicked "Send a Package"
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