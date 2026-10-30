# QuickEats WhatsApp Ordering Bot

Customer ordering runs through WhatsApp. The bot connects to the shared Supabase project, matches requested foods against vendor menus, creates orders, starts Paystack checkout, verifies payment callbacks, and sends order-status updates to customers. Rider and Vendor operations are handled by their separate apps.

## Required Render environment variables

- `SUPABASE_URL` — QuickEats Supabase project URL.
- `SUPABASE_SERVICE_KEY` — Supabase service-role key. Keep this only in Render secrets; never put it in browser code or commit it.
- `WHATSAPP_TOKEN` — WhatsApp Cloud API access token.
- `PHONE_NUMBER_ID` — WhatsApp sender phone-number ID. The server also accepts the legacy `WHATSAPP_PHONE_ID` name.
- `WHATSAPP_GRAPH_API_VERSION` — Graph API version; default is `v26.0`.
- `VERIFY_TOKEN` — private string configured to match the Meta webhook verification setting.
- `PAYSTACK_SECRET_KEY` — Paystack secret key for checkout and webhook verification.
- `PUBLIC_BASE_URL` — public Render URL used for payment callbacks.
- `RIDER_APP_ORIGIN` — allowed Rider app origin for the authenticated delivery-code resend endpoint.
- `FLOW_ID` — optional WhatsApp Flow ID.
- `FLOW_MODE` — optional WhatsApp Flow mode; defaults to `published`.
- `PORT` — supplied by Render automatically.

Copy `.env.example` for local development, then fill in real values locally. Never commit `.env` or share service-role keys and access tokens.

## Local development

```bash
npm install
npm start
```

## Render deployment

Use the existing Render Web Service connected to this repository. Keep the existing start command and configure the environment variables above in the Render service settings. Deploy from the `main` branch.

## Meta webhook

Configure the WhatsApp webhook callback as:

```
https://YOUR_RENDER_SERVICE.onrender.com/webhook
```

Use the same `VERIFY_TOKEN` value in Meta and Render, and subscribe to the `messages` field.

## Important launch checks

- Verify that the WhatsApp number is a production business number and that the access token is a long-lived system-user token.
- Use a live Paystack key only when the business is ready to accept real payments; keep test credentials for controlled testing.
- Configure and test Meta webhook signature verification before public launch.
- Confirm that the Render service is on an always-on plan suitable for live order processing. The bot currently keeps conversational state in process memory, so restarts can interrupt unfinished conversations; durable session storage is still required before scaling to multiple instances.
- Test a complete WhatsApp order, Paystack verification, vendor acceptance, rider assignment, delivery PIN verification, and customer status notifications using controlled test accounts.

## Current implementation notes

The server contains menu matching for saved vendor items, custom-item quote handling, customer checkout breakdowns, Paystack payment verification, rider assignment integration, and customer status notifications. The README should be kept aligned with the deployed code whenever those flows change.
