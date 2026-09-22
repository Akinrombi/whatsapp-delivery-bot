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

// 1. GET Webhook Verification (Required by Meta)
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

// 2. POST Webhook Listener (Handles incoming WhatsApp messages)
app.post('/webhook', async (req, res) => {
  // Always return 200 OK immediately so Meta doesn't retry or block your server
  res.sendStatus(200);

  try {
    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const message = changes?.value?.messages?.[0];

    if (!message) return;

    const from = message.from; // Customer phone number
    const interactive = message.interactive;
    const text = message.text?.body ? message.text.body.trim().toLowerCase() : '';

    console.log(`📩 Incoming message from ${from} | Text: "${text}" | Interactive ID: "${interactive?.button_reply?.id || interactive?.list_reply?.id}"`);

    // Check triggers for showing the restaurant list
    const isFoodTrigger = 
      text.includes('food') || 
      text.includes('order') || 
      text.includes('menu') || 
      text === 'hi' || 
      text === 'hello' ||
      interactive?.button_reply?.id === 'food_ordering' ||
      interactive?.list_reply?.id === 'food_ordering';

    if (isFoodTrigger) {
      await sendRestaurantList(from);
    } 
    // Check if customer selected a restaurant from the interactive list
    else if (interactive?.type === 'list_reply' && interactive.list_reply.id.startsWith('vendor_')) {
      const vendorId = interactive.list_reply.id.replace('vendor_', '');
      await sendVendorMenu(from, vendorId);
    } 
    else {
      // Default auto-reply for any unrecognized input
      await sendTextMessage(from, "Welcome! Type *Food* or tap *Food Ordering* to see our available restaurants.");
    }
  } catch (err) {
    console.error('❌ Webhook processing error:', err.message);
  }
});

// Send Interactive Restaurant List from Supabase
async function sendRestaurantList(toPhone) {
  let stores = [];

  try {
    // Fetch all vendors from Supabase
    const { data, error } = await supabase.from('vendors').select('*');
    if (!error && data && data.length > 0) {
      stores = data;
    } else {
      console.log('Supabase fetch notice:', error?.message || 'No rows found');
    }
  } catch (err) {
    console.error('Supabase connection error:', err.message);
  }

  // Fallback defaults if database is empty
  if (stores.length === 0) {
    stores = [
      { id: '1', store_name: 'Chicken Republic', description: 'Fried chicken & fast food' },
      { id: '2', store_name: 'Mega Chicken', description: 'Local & continental dishes' },
      { id: '3', store_name: 'Mama Cass', description: 'Traditional African meals' }
    ];
  }

  // Strict character truncating required by Meta API (Title <= 24 chars, Desc <= 72 chars)
  const rows = stores.map((s, index) => {
    let titleStr = String(s.store_name || s.name || `Store ${index + 1}`).trim();
    let descStr = String(s.description || s.address || 'Fresh & delicious meals').trim();

    if (titleStr.length > 24) titleStr = titleStr.substring(0, 21) + '...';
    if (descStr.length > 72) descStr = descStr.substring(0, 69) + '...';

    return {
      id: `vendor_${s.id || index}`,
      title: titleStr,
      description: descStr
    };
  });

  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: toPhone,
    type: 'interactive',
    interactive: {
      type: 'list',
      header: { type: 'text', text: 'Select Restaurant' },
      body: { text: 'Select a restaurant below to view their menu and order:' },
      footer: { text: 'Tap below to open menu' },
      action: {
        button: 'Select Restaurant',
        sections: [
          {
            title: 'Available Restaurants',
            rows: rows
          }
        ]
      }
    }
  };

  await sendWhatsAppApiRequest(payload);
}

// Send Restaurant Menu Items
async function sendVendorMenu(toPhone, vendorId) {
  let menu = [];

  try {
    const { data } = await supabase.from('vendor_menu').select('*').eq('vendor_id', vendorId);
    if (data) menu = data;
  } catch (err) {
    console.error('Menu fetch error:', err.message);
  }

  if (menu.length === 0) {
    await sendTextMessage(toPhone, 'This restaurant currently has no active items on their menu.');
    return;
  }

  let text = '🍽️ *AVAILABLE MENU*\n\n';
  menu.forEach((item, index) => {
    text += `${index + 1}. *${item.name}* - ₦${Number(item.price).toLocaleString()}\n`;
  });
  text += '\nReply with what you would like to order!';

  await sendTextMessage(toPhone, text);
}

// Helper: Text Message
async function sendTextMessage(toPhone, textMessage) {
  const payload = {
    messaging_product: 'whatsapp',
    to: toPhone,
    type: 'text',
    text: { body: textMessage }
  };
  await sendWhatsAppApiRequest(payload);
}

// Helper: Post Request to Meta WhatsApp Cloud API
async function sendWhatsAppApiRequest(payload) {
  try {
    const res = await axios.post(
      `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`,
      payload,
      {
        headers: {
          'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );
    console.log('✅ Message sent to WhatsApp:', res.data);
  } catch (err) {
    console.error('❌ Meta API Error:', err.response?.data || err.message);
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Bot server active on port ${PORT}`));