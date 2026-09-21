const express = require('express');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const WHATSAPP_PHONE_ID = process.env.WHATSAPP_PHONE_ID;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

// Supabase Initialization (Cleaned & Hardcoded URL to prevent string parsing errors)
const supabaseUrl = 'https://glkutdkwbrjpiuqcmgwe.supabase.co';
const supabaseKey = (process.env.SUPABASE_KEY || '').trim();
const supabase = createClient(supabaseUrl, supabaseKey);

const userSessions = {};

// Custom Menu Database
const RESTAURANT_MENUS = {
  rest_chicken: {
    name: 'Chicken Republic',
    items: [
      { id: 'item_cr_refuel', title: 'Refuel Max Combo', description: 'Jollof rice, fried chicken & drink' },
      { id: 'item_cr_citizen', title: 'Citizen Meal', description: 'Fried rice & 1pc fried chicken' },
      { id: 'item_cr_pie', title: 'Chicken Pie', description: 'Freshly baked meat pastry' }
    ]
  },
  rest_mega: {
    name: 'Mega Chicken',
    items: [
      { id: 'item_mc_friedrice', title: 'Special Fried Rice', description: 'Served with grilled chicken' },
      { id: 'item_mc_burger', title: 'Mega Beef Burger', description: 'Loaded double patty burger' },
      { id: 'item_mc_spag', title: 'Singaporian Noodles', description: 'Spicy pasta with prawns & chicken' }
    ]
  },
  rest_mama: {
    name: 'Mama Cass',
    items: [
      { id: 'item_mk_egusi', title: 'Pounded Yam & Egusi', description: 'Served with assorted meat' },
      { id: 'item_mk_ofada', title: 'Ofada Rice Special', description: 'Local rice with spicy ayamase sauce' },
      { id: 'item_mk_amala', title: 'Amala & Ewedu', description: 'Served with gbegiri and goat meat' }
    ]
  }
};

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

async function handleMessage(from, session, input) {
  const text = input ? input.toLowerCase() : '';

  if (text === 'hi' || text === 'hello' || text === 'start' || text === '/menu' || !input) {
    userSessions[from] = { step: 'IDLE' };
    return await showMainMenu(from);
  }

  // MAIN MENU ROUTING
  if (input === 'svc_dispatch') {
    userSessions[from] = { step: 'SELECT_PACKAGE_TYPE', serviceCategory: 'Dispatch' };
    return await sendPackageTypeList(from);
  }

  if (input === 'svc_food') {
    userSessions[from] = { step: 'SELECT_RESTAURANT', serviceCategory: 'Food Order' };
    return await sendRestaurantList(from);
  }

  if (input === 'svc_ride') {
    userSessions[from] = { step: 'AWAITING_RIDE_PICKUP', serviceCategory: 'Ride Booking' };
    return await sendWhatsAppMessage(from, `🚕 *Ride Booking*\n\nPlease type your *Pickup Location*:`);
  }

  // DISPATCH FLOW
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

  // FOOD FLOW
  if (session.step === 'SELECT_RESTAURANT' || RESTAURANT_MENUS[input]) {
    const restaurantData = RESTAURANT_MENUS[input] || RESTAURANT_MENUS['rest_chicken'];

    userSessions[from] = { 
      ...session, 
      step: 'SELECT_FOOD_ITEM', 
      restaurantKey: input,
      restaurantName: restaurantData.name 
    };
    return await sendFoodMenu(from, input);
  }

  if (session.step === 'SELECT_FOOD_ITEM' || input.startsWith('item_')) {
    const restData = RESTAURANT_MENUS[session.restaurantKey] || RESTAURANT_MENUS['rest_chicken'];
    const selectedItemObj = restData.items.find(i => i.id === input);
    const itemName = selectedItemObj ? selectedItemObj.title : 'Food Combo';

    userSessions[from] = { ...session, step: 'AWAITING_FOOD_ADDRESS', item: itemName };
    return await sendWhatsAppMessage(
      from, 
      `Selected *${itemName}* from *${session.restaurantName}*.\n\nPlease type your *Delivery Address*:`
    );
  }

  if (session.step === 'AWAITING_FOOD_ADDRESS') {
    session.dropoff = input;
    session.step = 'CONFIRM_ORDER';
    userSessions[from] = session;

    const summary = `🍔 *Food Order Summary*\n\n` +
      `• Restaurant: ${session.restaurantName}\n` +
      `• Item: ${session.item}\n` +
      `• Delivery Address: ${session.dropoff}\n\n` +
      `Reply *YES* to confirm or *NO* to cancel.`;

    return await sendWhatsAppMessage(from, summary);
  }

  // RIDE FLOW
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

  // CONFIRMATION & SUPABASE DATABASE SAVE
  if (session.step === 'CONFIRM_ORDER') {
    if (text === 'yes') {
      try {
        if (session.serviceCategory === 'Ride Booking') {
          await supabase.from('ride_requests').insert([
            {
              customer_phone: from,
              pickup_address: session.pickup,
              destination_address: session.dropoff,
              status: 'SEARCHING'
            }
          ]);
        } else {
          await supabase.from('orders').insert([
            {
              customer_phone: from,
              order_type: session.serviceCategory === 'Food Order' ? 'FOOD' : 'DISPATCH',
              item_details: session.item || session.subType || 'Package',
              pickup_address: session.pickup || null,
              delivery_address: session.dropoff,
              status: 'PENDING'
            }
          ]);
        }
      } catch (err) {
        console.error('Error persisting to Supabase:', err.message);
      }

      userSessions[from] = { step: 'IDLE' };
      return await sendWhatsAppMessage(
        from,
        `✅ *Order Confirmed & Saved!* We are processing your request now. Thank you!`
      );
    } else if (text === 'no') {
      userSessions[from] = { step: 'IDLE' };
      return await sendWhatsAppMessage(from, `❌ Request canceled. Type "Hi" to return to the main menu.`);
    }
  }

  return await showMainMenu(from);
}

// WhatsApp Dynamic Menu Generators
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

async function sendRestaurantList(to) {
  const payload = {
    messaging_product: 'whatsapp',
    to: to,
    type: 'interactive',
    interactive: {
      type: 'list',
      header: { type: 'text', text: 'Select Restaurant' },
      body: { text: 'Choose where you would like to order from:' },
      action: {
        button: 'Select Restaurant',
        sections: [
          {
            title: 'Available Spots',
            rows: [
              { id: 'rest_chicken', title: 'Chicken Republic', description: 'Fried chicken & fast food' },
              { id: 'rest_mega', title: 'Mega Chicken', description: 'Local & continental dishes' },
              { id: 'rest_mama', title: 'Mama Cass', description: 'Traditional African meals' }
            ]
          }
        ]
      }
    }
  };
  return await callWhatsAppAPI(payload);
}

async function sendFoodMenu(to, restaurantKey) {
  const restaurant = RESTAURANT_MENUS[restaurantKey] || RESTAURANT_MENUS['rest_chicken'];
  const payload = {
    messaging_product: 'whatsapp',
    to: to,
    type: 'interactive',
    interactive: {
      type: 'list',
      header: { type: 'text', text: `${restaurant.name}` },
      body: { text: `Select your meal from ${restaurant.name}:` },
      action: {
        button: 'View Meals',
        sections: [{ title: 'Menu Items', rows: restaurant.items }]
      }
    }
  };
  return await callWhatsAppAPI(payload);
}

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

async function sendWhatsAppMessage(to, text) {
  const payload = {
    messaging_product: 'whatsapp',
    to: to,
    type: 'text',
    text: { body: text }
  };
  return await callWhatsAppAPI(payload);
}

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
  console.log(`WhatsApp bot running on port ${PORT}`);
}); 
