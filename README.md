# Horror Haven

A real-time chat community for horror movie and video game fans, with monetization
built in: a Premium membership tier, a gated VIP chat room, ad slots for free users,
and an affiliate recommendations page.

## Run it locally

```
npm install
cp .env.example .env   # then fill in DATABASE_URL and SESSION_SECRET
npm start
```

Then open http://localhost:3000

User accounts and chat history live in a Postgres database, connected via the
`DATABASE_URL` environment variable. Tables are created automatically on startup
if they don't exist yet (see `db.js`). For local development, point `DATABASE_URL`
at the same Render Postgres instance you use in production (its "External Database
URL," found on the database's Render dashboard page), or at a local Postgres install.

## How this makes money (and what to plug in for real)

Three monetization paths are wired into the app as working demos. Each one has a
clearly marked spot to swap in your real account/API keys.

### 1. Premium membership (recurring revenue)
Clicking "Go Premium" in the app calls `POST /api/create-checkout-session`
(`server.js`), which creates a real Stripe Checkout Session for the $4.99/mo
price and redirects the user there. Stripe collects the card, handles the
recurring billing, and — on success — calls back to `POST /webhook/stripe`,
which verifies the event signature and flips `is_premium` in Postgres
(`checkout.session.completed` to turn it on, `customer.subscription.deleted`/
`updated` to turn it off if they cancel or a payment fails).

Required environment variables (set locally in `.env` and on your host):
- `STRIPE_SECRET_KEY` — Developers → API keys in the Stripe dashboard.
- `STRIPE_PRICE_ID` — the Price ID of your "Horror Haven Premium" product.
- `STRIPE_WEBHOOK_SECRET` — created in the next step, once you have a live URL.

To wire up the webhook once deployed:
1. In the Stripe dashboard, go to Developers → Webhooks → Add endpoint.
2. Endpoint URL: `https://<your-domain>/webhook/stripe`.
3. Select the events `checkout.session.completed`, `customer.subscription.updated`,
   and `customer.subscription.deleted`.
4. Copy the endpoint's **Signing secret** (`whsec_...`) into `STRIPE_WEBHOOK_SECRET`
   on your host.
5. Use Stripe's "Send test webhook" button on that endpoint to confirm it
   returns `200 OK` without completing a real purchase.

You're currently using **live** Stripe keys, so any completed checkout charges
a real card. Test the actual purchase flow yourself with a real card (or a
small one-off charge you refund afterward) rather than asking an AI agent to
do it — that's a hard rule, not a preference.

A nice follow-up once this is working: add a "Manage subscription" link using
Stripe's Customer Portal (`stripe.billingPortal.sessions.create`) so members
can cancel or update their card without emailing you.

### 2. Ads (for free-tier users)
`public/app.html` has an `<div id="ad-slot">` that's hidden automatically for
Premium members. To run real ads:
1. Apply for [Google AdSense](https://adsense.google.com) (needs a live site with
   content and some traffic history first — this is usually the slowest piece).
2. Once approved, replace the ad-slot div's contents with your AdSense `<ins>` unit
   and add their script tag.
3. Google's ad script is allowed to load from Google's own CDN in most hosting
   setups; if you deploy behind a strict Content-Security-Policy, allowlist
   `pagead2.googlesyndication.com` and related AdSense domains.

### 3. Affiliate links (recommendations page)
`public/recommendations.html` lists horror movies and games, each linking to an
Amazon search result tagged with the Associates tracking ID `horrorhaven05-20`
(e.g. `https://www.amazon.com/s?k=<title>&tag=horrorhaven05-20`). Any purchase
made after a visitor clicks through earns a commission.
- To add more titles, copy a `.rec-card` block and point its link at
  `https://www.amazon.com/s?k=<search terms>&tag=horrorhaven05-20`.
- Search-result links work without knowing exact product IDs, but convert
  better if you swap in a specific product's URL (with `?tag=horrorhaven05-20`
  appended) once you know exactly which edition/platform to recommend.
- Consider adding a second affiliate program for movie streaming/rental links
  (e.g. a JustWatch partner account) alongside Amazon.

### Other easy add-ons
- A donate link (Ko-fi / Buy Me a Coffee / Patreon) is already on the homepage —
  just replace the placeholder URL in `public/index.html` with your real one.
- Sponsored "community spotlight" posts (a horror indie studio or streaming
  service pays for a pinned message) are a natural fit once you have an
  engaged user base.

## Deploying

This app needs a persistent Node.js process (not static hosting) because it uses
WebSockets (Socket.IO) for real-time chat. Good low-cost options:
- [Render](https://render.com) — free/low-cost Node web service, supports WebSockets.
- [Railway](https://railway.app)
- A small VPS (DigitalOcean, Linode) running the app behind nginx with PM2.

Steps are roughly the same everywhere:
1. Push this project to a GitHub repo.
2. Connect the repo to your host, set the start command to `npm start`.
3. Create a Postgres database on the same host (Render: New + → PostgreSQL, free
   tier) and set `DATABASE_URL` on the web service to its connection string
   (use the "Internal Database URL" when the web service and database are on
   the same host/region — it's faster and doesn't count against external
   bandwidth).
4. Set `SESSION_SECRET` (a long random string) and, once you add Stripe,
   `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET`.
5. Sessions are still stored as files in `data/sessions` on local disk, which
   resets on redeploy/restart — that just logs everyone out, it doesn't lose
   accounts or chat history (those are in Postgres now). Fine for now; move to
   a Redis-backed session store later if that becomes annoying at scale.

## Growing the community (this matters more than the code)

A chat app with nobody in it makes no money. Before/alongside deployment:
- Post in horror subreddits, Discord servers, and Facebook groups where sharing
  a new community is welcome (check each community's self-promotion rules first).
- Cross-post recommendations-page content (with a link back) to build SEO traffic,
  which is also what makes AdSense approval and affiliate clicks worthwhile.
- Seed the rooms yourself for the first week so new visitors don't land in a
  silent chat room.
