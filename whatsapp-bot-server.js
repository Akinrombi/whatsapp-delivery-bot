const express = require('express');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());

// Initialize Supabase Client
const SUPABASE_URL = 'https://glkutdkwbrjpiuqcmgwe.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imdsa3V0ZGt3YnJqcGl1cWNtZ3dlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk5NzU3MTMsImV4cCI6MjEwNTU1MTcxM30.f2SgZJvP681imm0Qe1fKsATnCk_86z2guwvZWASXoZM';
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

// Meta Verification Endpoint
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

// WhatsApp Message Webhook
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);

  try {
    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const message = changes?.value?.messages?.[0];

    if (!message) return;

    const from = message.from;
    const interactive = message.interactive;
    const messageText = message.text?.body?.toLowerCase() || '';

    console.log('Incoming message from:', from, 'Text:', messageText, 'Interactive:', interactive);

    // If user clicks interactive button or types text
    if (
      interactive?.button_reply?.id === 'food_ordering' || 
      interactive?.list_reply?.id === 'food_ordering' ||
      messageText.includes('food') || 
      messageText.includes('order') ||
      messageText === 'hi' ||
      messageText === 'hello'
    ) {
      await sendRestaurantList(from);
    } 
    // If user selects a restaurant from the list
    else if (interactive?.type === 'list_reply' && interactive.list_reply.id.startsWith('vendor_')) {
      const vendorId = interactive.list_reply.id.replace('vendor_', '');
      await sendVendorMenu(from, vendorId);
    }
  } catch (err) {
    console.error('Error in webhook handling:', err);
  }
});

// Function to fetch open stores from Supabase and show them in WhatsApp list
async function sendRestaurantList(to) {
  let stores = [];

  try {
    const { data, error } = await supabase.from('vendors').select('*');
    if (!error && data && data.length > 0) {
      stores = data;
    }
  } catch (err) {
    console.error('Supabase query error:', err);
  }

  // Fallback defaults if table is empty
  if (stores.length === 0) {
    stores = [
      { id: '1', store_name: 'Chicken Republic', description: 'Fried chicken & fast food' },
      { id: '2', store_name: 'Mega Chicken', description: 'Local & continental dishes' },
      { id: '3', store_name: 'Mama Cass', description: 'Traditional African meals' }
    ];
  }

  // Format into Meta WhatsApp API rows
  const rows = stores.map((s, index) => {
    const titleText = String(s.store_name || s.name || `Store ${index + 1}`).trim();
    const descText = String(s.description || s.address || 'Local delicacies').trim();

    return {
      id: `vendor_${s.id || index}`,
      title: titleText.length > 24 ? titleText.substring(0, 21) + '...' : titleText,
      description: descText.length > 72 ? descText.substring(0, 69) + '...' : descText
    };
  });

  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: to,
    type: 'interactive',
    interactive: {
      type: 'list',
      header: { type: 'text', text: 'Select Restaurant' },
      body: { text: 'How can we help you today? Please select a restaurant to view their menu:' },
      footer: { text: 'Tap to select an item' },
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

  await sendWhatsAppRequest(payload);
}

// Send Menu for Selected Vendor
async function sendVendorMenu(to, vendorId) {
  let menu = [];

  try {
    const { data, error } = await supabase.from('vendor_menu').select('*').eq('vendor_id', vendorId);
    if (!error && data) menu = data;
  } catch (err) {
    console.error('Menu query error:', err);
  }

  if (menu.length === 0) {
    await sendTextMessage(to, 'This restaurant currently has no items in stock. Please try selecting another one!');
    return;
  }

  let text = '🍽️ *RESTAURANT MENU*\n\n';
  menu.forEach((item, index) => {
    text += `${index + 1}. *${item.name}* - ₦${Number(item.price).toLocaleString()}\n`;
  });
  text += '\nReply with the item name to place your order!';

  await sendTextMessage(to, text);
}

// Send simple text
async function sendTextMessage(to, message) {
  const payload = {
    messaging_product: 'whatsapp',
    to: to,
    type: 'text',
    text: { body: message }
  };
  await sendWhatsAppRequest(payload);
}

// Send payload to Meta API
async function sendWhatsAppRequest(payload) {
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
    console.log('WhatsApp response:', res.data);
  } catch (err) {
    console.error('Failed to send message:', err.response?.data || err.message);
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));