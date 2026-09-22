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

// WhatsApp Webhook Listener
app.post('/webhook', async (req, res) => {
  res.sendStatus(200); // Acknowledge WhatsApp instantly

  try {
    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const message = changes?.value?.messages?.[0];

    if (!message) return;

    const from = message.from; // Customer's phone number
    const text = message.text?.body?.toLowerCase();
    const interactive = message.interactive;

    // 1. When Customer chooses "Food Ordering" or types "Menu" / "Food"
    if (text === 'food ordering' || text === 'menu' || text === 'food') {
      await sendRestaurantList(from);
    } 
    // 2. When Customer selects a restaurant from the interactive list
    else if (interactive?.type === 'list_reply') {
      const selectedVendorId = interactive.list_reply.id.replace('vendor_', '');
      await sendVendorMenu(from, selectedVendorId);
    }
  } catch (error) {
    console.error('Error handling webhook:', error);
  }
});

// Function to fetch and send open restaurants dynamically
async function sendRestaurantList(toPhone) {
  // Fetch active/open vendors from Supabase
  const { data: vendors, error } = await supabase
    .from('vendors')
    .select('id, store_name, description')
    .eq('is_open', true);

  if (error || !vendors || vendors.length === 0) {
    await sendTextMessage(toPhone, "No restaurants are currently online. Please try again shortly!");
    return;
  }

  // Build the dynamic rows array from Supabase data
  const rows = vendors.map(v => ({
    id: `vendor_${v.id}`,
    title: (v.store_name || 'Restaurant').slice(0, 24), // Max 24 chars for title
    description: (v.description || 'Delicious fresh meals').slice(0, 72) // Max 72 chars
  }));

  // Construct WhatsApp Interactive List Message
  const payload = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: toPhone,
    type: "interactive",
    interactive: {
      type: "list",
      header: { type: "text", text: "Select Restaurant" },
      body: { text: "Choose a restaurant below to view their available menu:" },
      footer: { text: "Tap to select an item" },
      action: {
        button: "Select Restaurant",
        sections: [
          {
            title: "Available Restaurants",
            rows: rows
          }
        ]
      }
    }
  };

  await sendWhatsAppApiRequest(payload);
}

// Function to send menu items for selected restaurant
async function sendVendorMenu(toPhone, vendorId) {
  const { data: menuItems, error } = await supabase
    .from('vendor_menu')
    .select('*')
    .eq('vendor_id', vendorId)
    .eq('in_stock', true);

  if (error || !menuItems || menuItems.length === 0) {
    await sendTextMessage(toPhone, "This restaurant currently has no items in stock.");
    return;
  }

  let menuText = "🍽️ *AVAILABLE MENU*\n\n";
  menuItems.forEach((item, index) => {
    menuText += `${index + 1}. *${item.name}* - ₦${Number(item.price).toLocaleString()}\n`;
  });
  menuText += "\nReply with the item name or number to place your order!";

  await sendTextMessage(toPhone, menuText);
}

// Helper: Send Text Message
async function sendTextMessage(toPhone, textMessage) {
  const payload = {
    messaging_product: "whatsapp",
    to: toPhone,
    type: "text",
    text: { body: textMessage }
  };
  await sendWhatsAppApiRequest(payload);
}

// Helper: Send API Request to Meta WhatsApp Cloud API
async function sendWhatsAppApiRequest(payload) {
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
  } catch (err) {
    console.error('Error sending WhatsApp message:', err.response?.data || err.message);
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`WhatsApp Bot listening on port ${PORT}`));