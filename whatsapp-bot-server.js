/**
 * WhatsApp customer-ordering bot — Node.js / Express
 * Uses Meta's WhatsApp Cloud API (free tier works for this).
 *
 * WHAT THIS DOES
 * Customers message your WhatsApp Business number. This webhook:
 *   1. Verifies the webhook with Meta (GET)
 *   2. Receives incoming messages (POST)
 *   3. Walks the customer through a simple state machine:
 *        pick service -> browse/select -> confirm -> payment link -> order created
 *   4. On order creation, POSTs the finished order to YOUR backend,
 *      which is what feeds the vendor/rider dashboard.
 *
 * SETUP
 *   npm init -y
 *   npm install express dotenv node-fetch@2
 *   Create a .env file with:
 *     WHATSAPP_TOKEN=your_meta_access_token
 *     WHATSAPP_PHONE_ID=your_phone_number_id
 *     VERIFY_TOKEN=any_string_you_choose
 *     ORDERS_API_URL=https://your-backend.example.com/api/orders
 *   node server.js
 *
 * In Meta's App Dashboard (WhatsApp > Configuration), set the webhook
 * callback URL to https://your-domain.com/webhook and the verify token
 * to match VERIFY_TOKEN above.
 */

require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');

const app = express();
app.use(express.json());
app.get('/privacy', (req, res) => {
  res.send('Privacy Policy: We collect your WhatsApp number and order details solely to process your food, grocery, package, or ride orders. We do not sell or share your data with third parties. Contact us at your business email for any questions.');
});
const {
  WHATSAPP_TOKEN,
  WHATSAPP_PHONE_ID,
  VERIFY_TOKEN,
  ORDERS_API_URL
} = process.env;

const GRAPH_URL = `https://graph.facebook.com/v19.0/${WHATSAPP_PHONE_ID}/messages`;

// ---- In-memory conversation state (swap for Redis/DB in production) ----
const sessions = new Map(); // key: customer phone number, value: session object

function getSession(phone) {
  if (!sessions.has(phone)) {
    sessions.set(phone, { step: 'menu', service: null, cart: [], address: null });
  }
  return sessions.get(phone);
}
function resetSession(phone) {
  sessions.set(phone, { step: 'menu', service: null, cart: [], address: null });
}

// ---- Fake catalog — replace with real vendor data from your DB ----
const CATALOGS = {
  food: [
    { id: 'f1', name: 'Jollof rice + chicken', price: 3500 },
    { id: 'f2', name: 'Suya wrap', price: 2000 },
    { id: 'f3', name: 'Pounded yam + egusi', price: 4000 }
  ],
  grocery: [
    { id: 'g1', name: 'Weekly grocery bundle', price: 15000 },
    { id: 'g2', name: 'Rice + beans (5kg each)', price: 8000 }
  ],
  package: [
    { id: 'p1', name: 'Standard parcel (send/receive)', price: 1500 }
  ],
  ride: [
    { id: 'r1', name: 'Standard ride', price: 0 } // priced by distance at confirm step
  ]
};

// ---- WhatsApp message senders ----
async function sendText(to, body) {
  await fetch(GRAPH_URL, {
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
}

async function sendButtons(to, bodyText, buttons) {
  // buttons: [{ id: 'food', title: 'Food' }, ...]  max 3 per WhatsApp limits
  await fetch(GRAPH_URL, {
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
}

async function sendList(to, bodyText, sectionTitle, rows) {
  // rows: [{ id, title, description }]
  await fetch(GRAPH_URL, {
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
          button: 'View options',
          sections: [{ title: sectionTitle, rows }]
        }
      }
    })
  });
}

// ---- Order creation: hands the finished order to your main backend ----
async function createOrder(phone, session) {
  const order = {
    id: 'ORD-' + Date.now(),
    customerPhone: phone,
    type: session.service,
    items: session.cart,
    address: session.address,
    source: 'whatsapp'
  };

  try {
    await fetch(ORDERS_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(order)
    });
  } catch (err) {
    console.error('Failed to push order to backend:', err.message);
  }

  return order;
}

// ---- Webhook verification (Meta calls this once when you set up the webhook) ----
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// ---- Incoming message handler ----
app.post('/webhook', async (req, res) => {
  res.sendStatus(200); // acknowledge immediately, Meta requires a fast response

  const entry = req.body.entry?.[0];
  const change = entry?.changes?.[0];
  const message = change?.value?.messages?.[0];
  if (!message) return;

  const from = message.from; // customer's WhatsApp number
  const session = getSession(from);

  const text = message.text?.body?.trim().toLowerCase();
  const buttonId = message.interactive?.button_reply?.id || message.interactive?.list_reply?.id;
  const input = buttonId || text;

  try {
    await handleMessage(from, session, input);
  } catch (err) {
    console.error(err);
    await sendText(from, "Something went wrong on our end — let's start again.");
    resetSession(from);
  }
});

// ---- Conversation state machine ----
async function handleMessage(from, session, input) {
  if (input === 'restart' || input === 'menu') {
    resetSession(from);
    return showServiceMenu(from);
  }

  switch (session.step) {
    case 'menu':
      return showServiceMenu(from);

    case 'awaiting_service': {
      if (!CATALOGS[input]) {
        return sendText(from, "Please pick one of the options above.");
      }
      session.service = input;
      session.step = 'awaiting_item';
      const rows = CATALOGS[input].map(item => ({
        id: item.id,
        title: item.name,
        description: item.price ? `₦${item.price.toLocaleString()}` : 'Priced after pickup details'
      }));
      return sendList(from, `What would you like from ${input}?`, 'Available', rows);
    }

    case 'awaiting_item': {
      const catalog = CATALOGS[session.service];
      const item = catalog.find(i => i.id === input);
      if (!item) return sendText(from, "Please choose an item from the list.");
      session.cart.push(item);
      session.step = 'awaiting_address';
      return sendText(from, `Added *${item.name}*. What's the delivery address (or pickup location for a ride)?`);
    }

    case 'awaiting_address': {
      session.address = input;
      session.step = 'confirm';
      const itemNames = session.cart.map(i => i.name).join(', ');
      const total = session.cart.reduce((sum, i) => sum + (i.price || 0), 0);
      return sendButtons(
        from,
        `Confirm order:\n${itemNames}\nDeliver to: ${session.address}\nTotal: ₦${total.toLocaleString()}`,
        [{ id: 'confirm_yes', title: 'Confirm' }, { id: 'confirm_no', title: 'Cancel' }]
      );
    }

    case 'confirm': {
      if (input === 'confirm_yes') {
        const order = await createOrder(from, session);
        await sendText(
          from,
          `Order placed! Reference: ${order.id}\nA vendor/rider will confirm shortly. We'll message you a payment link next.`
        );
        // TODO: integrate Paystack/Flutterwave here and send the real payment link
        resetSession(from);
      } else {
        await sendText(from, "Order cancelled.");
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
  return sendButtons(from, "What would you like to do today?", [
    { id: 'food', title: 'Order food' },
    { id: 'grocery', title: 'Order groceries' },
    { id: 'ride', title: 'Book a ride' }
    // WhatsApp allows max 3 buttons — use sendList for more (e.g. add "package")
  ]);
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`WhatsApp bot listening on port ${PORT}`));
