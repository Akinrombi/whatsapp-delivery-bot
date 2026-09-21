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

// Webhook Verification
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token === VERIFY_TOKEN) {
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

    const from = message.from;
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
    console.error('Webhook error:', error.message);
  }
});

// Bot Flow Logic
async function handleMessage(from, session, input) {
  const text = input ? input.toLowerCase() : '';

  // Reset/Start Command
  if (text === 'hi' || text === 'hello' || text === 'start' || text === '/menu' || !input) {
    userSessions[from] = { step: 'IDLE' };
    return await showMainMenu(from);
  }

  // --- ROUTING FROM MAIN MENU LIST ---
  if (input === 'svc_dispatch') {
    userSessions[from] = { step: 'SELECT_PACKAGE_TYPE', serviceCategory: 'Dispatch' };
    return await sendPackageTypeList(from);
  }

  if (input === 'svc_food') {
    userSessions[from] = { step: 'SELECT_FOOD_ITEM', serviceCategory: 'Food Order' };
    return await sendFoodMenu(from);
  }

  if (input === 'svc_ride') {
    userSessions[from] = { step: 'AWAITING_RIDE_PICKUP', serviceCategory: 'Ride Booking' };
    return await sendWhatsAppMessage(from, `🚕 *Ride Booking*\n\nPlease type your *Pickup Location*:`);
  }

  // --- DISPATCH FLOW ---
  if (session.step === 'SELECT_PACKAGE_TYPE' || input.startsWith('opt_pkg_')) {
    let pkgType = 'Standard Delivery';
    if (input === 'opt_pkg_express') pkgType = 'Express Delivery';

    userSessions[from] = { ...session, step: 'AWAITING_PKG_PICKUP', subType: pkgType };
    return await sendWhatsAppMessage(from, `Selected: *${pkgType}*\n\nPlease type the *Pickup Address*:`);
  }

  if (session.step === 'AWAITING_PKG_PICKUP') {
    session.pickup = input;
    session.step = 'AWAITING_PKG_DROPOFF';
    userSessions[from] = session;
    return await sendWhatsAppMessage(from, `Pickup saved: *${input}*\n\nNow enter the *Drop-off Address*:`);
  }

  if (session.step === 'AWAITING_PKG_DROPOFF') {
    session.dropoff = input;
    session.step = 'CONFIRM_ORDER';
    userSessions[from] = session;

    const summary = `📦 *Dispatch Summary*\n\n` +
      `• Type: ${session.subType}\n` +
      `• Pickup: ${session.pickup}\n` +
      `• Drop-off: ${session.dropoff}\n\n` +
      `Reply *YES* to confirm or *NO* to cancel.`;

    return await sendWhatsAppMessage(from, summary);
  }

  // --- FOOD FLOW ---
  if (session.step === 'SELECT_FOOD_ITEM' || input.startsWith('opt_food_')) {
    let meal = 'Meal Combo';
    if (input === 'opt_food_rice') meal = 'Jollof Rice & Chicken';
    if (input === 'opt_food_burger') meal = 'Burger & Fries';

    userSessions[from] = { ...session, step: 'AWAITING_FOOD_ADDRESS', item: meal };
    return await sendWhatsAppMessage(from, `Selected: *${meal}*\n\nPlease type your *Delivery Address*:`);
  }

  if (session.step === 'AWAITING_FOOD_ADDRESS') {
    session.dropoff = input;
    session.step = 'CONFIRM_ORDER';
    userSessions[from] = session;

    const summary = `🍔 *Food Order Summary*\n\n` +
      `• Item: ${session.item}\n` +
      `• Delivery Address: ${session.dropoff}\n\n` +
      `Reply *YES* to confirm or *NO* to cancel.`;

    return await sendWhatsAppMessage(from, summary);
  }

  // --- RIDE FLOW ---
  if (session.step === 'AWAITING_RIDE_PICKUP') {
    session.pickup = input;
    session.step = 'AWAITING_RIDE_DESTINATION';
    userSessions[from] = session;
    return await sendWhatsAppMessage(from, `Pickup saved: *${input}*\n\nWhere are you heading? (*Destination*):`);
  }

  if (session.step === 'AWAITING_RIDE_DESTINATION') {
    session.dropoff = input;
    session.step = 'CONFIRM_ORDER';
    userSessions[from] = session;

    const summary = `🚕 *Ride Request Summary*\n\n` +
      `• From: ${session.pickup}\n` +
      `• To: ${session.dropoff}\n\n` +
      `Reply *YES* to confirm your request or *NO* to cancel.`;

    return await sendWhatsAppMessage(from, summary);
  }

  // --- CONFIRMATION HANDLER ---
  if (session.step === 'CONFIRM_ORDER') {
    if (text === 'yes') {
      userSessions[from] = { step: 'IDLE' };
      return await sendWhatsAppMessage(
        from,
        `✅ *Order Confirmed!* We are processing your request now. Thank you!`
      );
    } else if (text === 'no') {
      userSessions[from] = { step: 'IDLE' };
      return await sendWhatsAppMessage(from, `❌ Request canceled. Type "Hi" to return to the main menu.`);
    }
  }

  return await showMainMenu(from);
}

// Main Menu List
async function showMainMenu(to) {
  const payload = {
    messaging_product: 'whatsapp',
    to: to,
    type: 'interactive',
    interactive: {
      type: 'list',
      header: { type: 'text', text: 'Welcome to Express Services' },
      body: { text: 'How can we help you today? Please select an option:' },
      action: {
        button: 'Main Menu',
        sections: [
          {
            title: 'Our Services',
            rows: [
              { id: 'svc_dispatch', title: 'Package Dispatch', description: 'Send parcels via bike courier' },
              { id: 'svc_food', title: 'Food Ordering', description: 'Order meals from restaurants' },
              { id: 'svc_ride', title: 'Book a Ride', description: 'Request a bike or taxi ride' }
            ]
          }
        ]
      }
    }
  };

  return await callWhatsAppAPI(payload);
}

// Package Selection List
async function sendPackageTypeList(to) {
  const payload = {
    messaging_product: 'whatsapp',
    to: to,
    type: 'interactive',
    interactive: {
      type: 'list',
      header: { type: 'text', text: 'Dispatch Service' },
      body: { text: 'Select package speed:' },
      action: {
        button: 'Select Speed',
        sections: [
          {
            title: 'Options',
            rows: [
              { id: 'opt_pkg_standard', title: 'Standard Delivery', description: 'Delivered in 2-3 hours' },
              { id: 'opt_pkg_express', title: 'Express Delivery', description: 'Direct instant pickup' }
            ]
          }
        ]
      }
    }
  };

  return await callWhatsAppAPI(payload);
}

// Food Menu List
async function sendFoodMenu(to) {
  const payload = {
    messaging_product: 'whatsapp',
    to: to,
    type: 'interactive',
    interactive: {
      type: 'list',
      header: { type: 'text', text: 'Food Menu' },
      body: { text: 'Choose your meal:' },
      action: {
        button: 'View Menu',
        sections: [
          {
            title: 'Popular Items',
            rows: [
              { id: 'opt_food_rice', title: 'Jollof & Chicken', description: 'Tasty hot meal' },
              { id: 'opt_food_burger', title: 'Burger & Fries', description: 'Fast food combo' }
            ]
          }
        ]
      }
    }
  };

  return await callWhatsAppAPI(payload);
}

// Helper: Send Text
async function sendWhatsAppMessage(to, text) {
  const payload = {
    messaging_product: 'whatsapp',
    to: to,
    type: 'text',
    text: { body: text }
  };

  return await callWhatsAppAPI(payload);
}

// Helper: Post payload
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
  console.log(`WhatsApp multi-service bot listening on port ${PORT}`);
});
