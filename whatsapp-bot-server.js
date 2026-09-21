const express = require('express');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const WHATSAPP_PHONE_ID = process.env.WHATSAPP_PHONE_ID;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

// Temporary in-memory user sessions
const userSessions = {};

// Webhook Verification (Meta setup)
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token === VERIFY_TOKEN) {
    console.log('Webhook verified successfully!');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// Incoming Message Webhook
app.post('/webhook', async (req, res) => {
  res.status(200).send('EVENT_RECEIVED');

  try {
    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const message = value?.messages?.[0];

    if (!message) return;

    const from = message.from; // Sender's WhatsApp ID
    const session = userSessions[from] || { step: 'IDLE' };

    let userText = '';

    if (message.type === 'text') {
      userText = message.text.body.trim();
    } else if (message.type === 'interactive') {
      if (message.interactive.type === 'button_reply') {
        userText = message.interactive.button_reply.id;
      } else if (message.interactive.type === 'list_reply') {
        userText = message.interactive.list_reply.id;
      }
    }

    await handleMessage(from, session, userText);
  } catch (error) {
    console.error('Error handling webhook payload:', error.message);
  }
});

// Main Bot Navigation & Flow Logic
async function handleMessage(from, session, input) {
  const text = input ? input.toLowerCase() : '';

  // Reset/Start Command
  if (text === 'hi' || text === 'hello' || text === 'start' || text === '/order' || !input) {
    userSessions[from] = { step: 'IDLE' };
    return await showServiceMenu(from);
  }

  // Step 1: User tapped "Send a Package" button
  if (input === 'btn_send_package' || text.includes('send a package')) {
    userSessions[from] = { step: 'SELECT_SERVICE' };
    return await sendDeliveryList(from);
  }

  // Step 2: User selected an option from the Interactive List
  if (session.step === 'SELECT_SERVICE' || input.startsWith('opt_')) {
    let serviceType = 'Standard Delivery';
    if (input === 'opt_express') serviceType = 'Express Delivery';
    if (input === 'opt_intercity') serviceType = 'Intercity Delivery';

    userSessions[from] = { step: 'AWAITING_PICKUP', service: serviceType };
    return await sendWhatsAppMessage(
      from,
      `You selected *${serviceType}*.\n\nPlease type the *Pickup Address*:`
    );
  }

  // Step 3: Collect Pickup Location
  if (session.step === 'AWAITING_PICKUP') {
    session.pickup = input;
    session.step = 'AWAITING_DROPOFF';
    userSessions[from] = session;
    return await sendWhatsAppMessage(
      from,
      `Pickup saved: *${input}*\n\nNow, please type the *Drop-off Address*:`
    );
  }

  // Step 4: Collect Drop-off Location & Show Order Confirmation
  if (session.step === 'AWAITING_DROPOFF') {
    session.dropoff = input;
    session.step = 'CONFIRM_ORDER';
    userSessions[from] = session;

    const summary = `📦 *Order Summary*\n\n` +
      `• *Service:* ${session.service}\n` +
      `• *Pickup:* ${session.pickup}\n` +
      `• *Drop-off:* ${session.dropoff}\n\n` +
      `Reply *YES* to confirm your dispatch request or *NO* to cancel.`;

    return await sendWhatsAppMessage(from, summary);
  }

  // Step 5: Final Order Confirmation
  if (session.step === 'CONFIRM_ORDER') {
    if (text === 'yes') {
      userSessions[from] = { step: 'IDLE' };
      return await sendWhatsAppMessage(
        from,
        `✅ *Order Received!* A rider will be assigned to pick up your package shortly. Thank you for choosing us!`
      );
    } else if (text === 'no') {
      userSessions[from] = { step: 'IDLE' };
      return await sendWhatsAppMessage(from, `❌ Order canceled. Type "Hi" anytime to start again.`);
    }
  }

  // Fallback for unhandled input
  return await showServiceMenu(from);
}

// 1. Send Interactive Welcome Button
async function showServiceMenu(to) {
  const payload = {
    messaging_product: 'whatsapp',
    to: to,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: 'Welcome to Express Bike Dispatch!\nHow can we help you today?' },
      action: {
        buttons: [
          {
            type: 'reply',
            reply: { id: 'btn_send_package', title: 'Send a Package' }
          }
        ]
      }
    }
  };

  return await callWhatsAppAPI(payload);
}

// 2. Send Interactive List (Titles strictly capped <= 24 chars to avoid Error 131009)
async function sendDeliveryList(to) {
  const payload = {
    messaging_product: 'whatsapp',
    to: to,
    type: 'interactive',
    interactive: {
      type: 'list',
      header: { type: 'text', text: 'Select Delivery Type' },
      body: { text: 'Choose the option that best fits your dispatch urgency:' },
      action: {
        button: 'View Options',
        sections: [
          {
            title: 'Available Services',
            rows: [
              {
                id: 'opt_standard',
                title: 'Standard Delivery', // 17 chars (Valid < 24)
                description: 'Delivered within 2-3 hours'
              },
              {
                id: 'opt_express',
                title: 'Express Delivery', // 16 chars (Valid < 24)
                description: 'Direct pickup & instant drop'
              },
              {
                id: 'opt_intercity',
                title: 'Intercity Dispatch', // 18 chars (Valid < 24)
                description: 'For deliveries outside town'
              }
            ]
          }
        ]
      }
    }
  };

  return await callWhatsAppAPI(payload);
}

// Helper: Send Plain Text Message
async function sendWhatsAppMessage(to, text) {
  const payload = {
    messaging_product: 'whatsapp',
    to: to,
    type: 'text',
    text: { body: text }
  };

  return await callWhatsAppAPI(payload);
}

// Helper: Post payload to Meta Cloud API
async function callWhatsAppAPI(payload) {
  try {
    const url = `https://graph.facebook.com/v20.0/${WHATSAPP_PHONE_ID}/messages`;
    await axios.post(url, payload, {
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });
  } catch (error) {
    console.error('Error sending WhatsApp message:', error.response?.data || error.message);
  }
}

app.listen(PORT, () => {
  console.log(`WhatsApp bot listening on port ${PORT}`);
});
