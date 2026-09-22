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

// GET Webhook Verification
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token === (process.env.VERIFY_TOKEN || 'my_verify_token')) {
    console.log('Webhook verified successfully!');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

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
    const interactive = message.interactive;

    console.log(`📩 Incoming message from ${from}: "${text}"`);

    // Fetch vendors from Supabase
    const { data: stores, error } = await supabase.from('vendors').select('*');

    if (error) {
      console.error('Supabase fetch error:', error.message);
    }

    const isFoodTrigger = text === 'hi' || text === 'hello' || text.includes('food') || text.includes('order');

    if (isFoodTrigger) {
      if (stores && stores.length > 0) {
        // Enforce Meta API Rules: Max 10 rows, Title <= 24 chars, Desc <= 72 chars
        const rows = stores.slice(0, 10).map((s, idx) => {
          let title = String(s.store_name || s.name || `Store ${idx + 1}`).trim();
          let description = String(s.description || 'View menu and order').trim();

          if (title.length > 24) title = title.substring(0, 21) + '...';
          if (description.length > 72) description = description.substring(0, 69) + '...';

          return {
            id: `vendor_${s.id || idx}`,
            title: title,
            description: description
          };
        });

        const payload = {
          messaging_product: 'whatsapp',
          to: from,
          type: 'interactive',
          interactive: {
            type: 'list',
            header: { type: 'text', text: 'Select Restaurant' },
            body: { text: 'Choose a vendor below to order food:' },
            action: {
              button: 'View Restaurants',
              sections: [{ title: 'Available Vendors', rows: rows }]
            }
          }
        };

        const response = await axios.post(
          `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`,
          payload,
          {
            headers: {
              'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
              'Content-Type': 'application/json'
            }
          }
        );
        console.log('✅ Response sent successfully to WhatsApp:', response.data);
      } else {
        // Plain text fallback if Supabase returns 0 stores
        await axios.post(
          `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`,
          {
            messaging_product: 'whatsapp',
            to: from,
            type: 'text',
            text: { body: 'Welcome to David Delivery! No restaurants available right now.' }
          },
          {
            headers: {
              'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
              'Content-Type': 'application/json'
            }
          }
        );
      }
    }
  } catch (err) {
    console.error('❌ Error sending message:', err.response?.data || err.message);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));