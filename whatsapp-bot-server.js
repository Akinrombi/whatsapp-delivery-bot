require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');

const app = express();
app.use(express.json());

const {
  WHATSAPP_TOKEN,
  WHATSAPP_PHONE_ID,
  VERIFY_TOKEN,
  ORDERS_API_URL
} = process.env;

const GRAPH_URL = `https://graph.facebook.com/v20.0/${WHATSAPP_PHONE_ID}/messages`;

// ---- In-memory conversation state ----
const sessions = new Map();

function getSession(phone) {
  if (!sessions.has(phone)) {
    sessions.set(phone, { step: 'menu', service: null, cart: [], address: null });
  }
  return sessions.get(phone);
}

function resetSession(phone) {
  sessions.set(phone, { step: 'menu', service: null, cart: [], address: null });
}

// ---- Package Catalog ----
const CATALOGS = {
  package: [
    { id: 'p1', name: 'Standard Local Express (0–3 km)', price: 700 },
    { id: 'p2', name: 'Extended Local Express (3–5 km)', price: 1200 }
  ]
};

// ---- WhatsApp Message Senders ----
async function sendText(to, body) {
  try {
    const res = await fetch(GRAPH_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to,
        type: 'text',
        text: { body }
      })
    });
    const data = await res.json();
    if (!res.ok) console.error('Error sending text:', data);
  } catch (err) {
    console.error('Network error in sendText:', err);
  }
}

async function sendButtons(to, bodyText, buttons) {
  try {
    const res = await fetch(GRAPH_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to,
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
      })
    });
    const data = await res.json();
    if (!res.ok) console.error('Error sending buttons:', data);
  } catch (err) {
    console.error('Network error in sendButtons:', err);
  }
}

async function sendList(to, bodyText, sectionTitle, rows) {
  try {
    const res = await fetch(GRAPH_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to,
        type: 'interactive',
        interactive: {
          type: 'list',
          body: { text: bodyText },
          action: {
            button: 'View Options',
            sections: [{ title: sectionTitle, rows }]
          }
        }
      })
    });
    const data = await res.json();
    if (!res.ok) console.error('Error sending list:', data);
  } catch (err) {
    console.error('Network error in sendList:', err);
  }
}

// ---- Order Handler ----
async function createOrder(phone, session) {
  const order = {
    id: 'ORD-' + Date.now(),
    customerPhone: phone,
    type: session.service,
    items: session.cart,
    address: session.address,
    source: 'whatsapp'
  };

  console.log('NEW ORDER CREATED:', order);

  // Safely attempt backend POST only if a real URL is provided
  if (ORDERS_API_URL && !ORDERS_API_URL.includes('example.com')) {
    try {
      await fetch(ORDERS_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(order)
      });
    } catch (err) {
      console.error('Failed to push order to external backend:', err.message);
    }
  }

  return order;
}

// ---- Webhook Verification (GET) ----
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('Webhook verified successfully!');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// ---- Incoming Messages (POST) ----
app.post('/webhook', async (req, res) => {
  res.sendStatus(200); // Always respond 200 OK immediately to Meta

  const entry = req.body.entry?.[0];
  const change = entry?.changes?.[0];
  const message = change?.value?.messages?.[0];
  if (!message) return;

  const from = message.from;
  const session = getSession(from);

  const text = message.text?.body?.trim().toLowerCase();
  const buttonId = message.interactive?.button_reply?.id || message.interactive?.list_reply?.id;
  const input = buttonId || text;

  try {
    await handleMessage(from, session, input);
  } catch (err) {
    console.error('Error handling message:', err);
    await sendText(from, "Something went wrong — let's restart.");
    resetSession(from);
  }
});

// ---- State Machine Logic ----
async function handleMessage(from, session, input) {
  if (input === 'restart' || input === 'menu' || input === 'hi' || input === 'hello') {
    resetSession(from);
    return showServiceMenu(from);
  }

  switch (session.step) {
    case 'menu':
      return showServiceMenu(from);

    case 'awaiting_service': {
      if (!CATALOGS[input]) {
        return sendText(from, "Please tap one of the option buttons above.");
      }
      session.service = input;
      session.step = 'awaiting_item';
      const rows = CATALOGS[input].map(item => ({
        id: item.id,
        title: item.name,
        description: `₦${item.price.toLocaleString()}`
      }));
      return sendList(from, "Select your parcel size/distance:", "Delivery Options", rows);
    }

    case 'awaiting_item': {
      const catalog = CATALOGS[session.service];
      const item = catalog.find(i => i.id === input);
      if (!item) return sendText(from, "Please select a valid option from the menu list.");
      session.cart.push(item);
      session.step = 'awaiting_address';
      return sendText(from, `Selected: *${item.name}*.\n\nPlease reply with your Pickup Location and Drop-off Address:`);
    }

    case 'awaiting_address': {
      session.address = input;
      session.step = 'confirm';
      const itemNames = session.cart.map(i => i.name).join(', ');
      const total = session.cart.reduce((sum, i) => sum + (i.price || 0), 0);
      return sendButtons(
        from,
        `Confirm your delivery booking:\n• Service: ${itemNames}\n• Locations: ${session.address}\n• Total: ₦${total.toLocaleString()}`,
        [{ id: 'confirm_yes', title: 'Confirm Order' }, { id: 'confirm_no', title: 'Cancel' }]
      );
    }

    case 'confirm': {
      if (input === 'confirm_yes') {
        const order = await createOrder(from, session);
        await sendText(
          from,
          `✅ Order Placed!\nRef Code: ${order.id}\n\nOur bicycle dispatch rider will contact you in a moment for pickup.`
        );
        resetSession(from);
      } else {
        await sendText(from, "Order cancelled. Send 'Hi' whenever you are ready to book again!");
        resetSession(from);
      }
      return;
    }

    default:
      resetSession(from);
      return showServiceMenu(from);
  }
}

async function showServiceMenu(from) {
  const session = getSession(from);
  session.step = 'awaiting_service';
  return sendButtons(from, "Welcome to Express Bike Dispatch! How can we help you today?", [
    { id: 'package', title: 'Send a Package' }
  ]);
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`WhatsApp bot listening on port ${PORT}`));          
