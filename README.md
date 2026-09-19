# WhatsApp Delivery Bot

A WhatsApp ordering bot for a multi-service delivery platform (food, grocery, package, ride). Customers order entirely through WhatsApp; finished orders get pushed to your vendor/rider backend.

## 1. Get WhatsApp Cloud API access (free)

1. Create a Meta developer account at developers.facebook.com
2. Create a new App → add the "WhatsApp" product
3. In WhatsApp → API Setup, you'll get a temporary access token and a phone number ID (Meta gives you a free test number to start)
4. Note both values — you'll need them below

## 2. Set up locally (optional, to test before deploying)

```
npm install
cp .env.example .env
```

Fill in `.env` with your real values, then:

```
npm start
```

## 3. Push to GitHub

Upload all files in this folder to a new GitHub repository. `.gitignore` already excludes `node_modules/` and `.env`, so your secrets won't be committed.

## 4. Deploy (using Render.com as an example)

1. render.com → New → Web Service → connect your GitHub repo
2. Build command: `npm install`
3. Start command: `npm start`
4. Under Environment, add:
   - `WHATSAPP_TOKEN`
   - `WHATSAPP_PHONE_ID`
   - `VERIFY_TOKEN` (make up any string)
   - `ORDERS_API_URL` (your backend's order-creation endpoint)
5. Deploy — Render gives you a URL like `https://your-app.onrender.com`

## 5. Connect the webhook in Meta

In Meta's App Dashboard → WhatsApp → Configuration → Webhook:
- Callback URL: `https://your-app.onrender.com/webhook`
- Verify token: must match `VERIFY_TOKEN` from step 4
- Subscribe to the `messages` field

## 6. Test it

Message your WhatsApp test number from your phone. You should get the "What would you like to do today?" menu.

## Next steps not yet built

- Payment integration (Paystack/Flutterwave) — marked with a `TODO` in the code
- Nearest-rider matching logic — currently all orders land in one shared queue
- A real `ORDERS_API_URL` backend — right now this just needs to exist and accept a POST with the order JSON
