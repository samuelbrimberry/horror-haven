# Horror Haven

A real-time chat community for horror movie and video game fans, with monetization
built in: a Premium membership tier, a gated VIP chat room, ad slots for free users,
and an affiliate recommendations page.

## Run it locally

```
npm install
npm start
```

Then open http://localhost:3000

Data (user accounts, chat history) is stored in `data/db.json`, created automatically
on first run. Delete that file to reset everything.

## How this makes money (and what to plug in for real)

Three monetization paths are wired into the app as working demos. Each one has a
clearly marked spot to swap in your real account/API keys.

### 1. Premium membership (recurring revenue)
Right now, clicking "Go Premium" in the app instantly flips your account to premium
(`POST /api/upgrade` in `server.js`) so you can see the gated VIP room and ad-free
experience work. **This does not charge real money yet.**

To take real payments:
1. Create a [Stripe](https://stripe.com) account and get your API keys.
2. `npm install stripe`
3. Replace the `/api/upgrade` handler in `server.js` with one that creates a
   Stripe Checkout Session (`stripe.checkout.sessions.create`) for a $4.99/mo
   subscription price, and redirect the user there instead of upgrading directly.
4. Add a webhook endpoint (`/api/stripe-webhook`) that listens for
   `checkout.session.completed` / `customer.subscription.deleted` events and calls
   `db.setPremium(userId, true/false)` accordingly.

Stripe's docs for "Subscriptions with Checkout" walk through this exact flow.

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
`public/recommendations.html` lists horror movies and games with placeholder
"Watch it" / "Get it" buttons (`data-affiliate="..."` attributes).
1. Sign up for [Amazon Associates](https://affiliate-program.amazon.com) for games/
   merch, and/or a streaming affiliate program (e.g. JustWatch partner links) for
   movies.
2. Replace each button's `href="#"` with your real affiliate URL and remove the
   placeholder `alert()` script at the bottom of the file.
3. Add more titles over time — this page is the easiest one to expand for more
   affiliate revenue without touching the chat app at all.

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
3. Set environment variables: `SESSION_SECRET` (a long random string) and, once
   you add Stripe, `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET`.
4. Note: `data/db.json` is local disk storage — fine to start, but on most hosts
   the filesystem isn't persistent across deploys/restarts. Once you have real
   users, migrate `db.js` to a real database (Postgres via
   [Railway](https://railway.app)/[Supabase](https://supabase.com), or SQLite on
   a persistent volume) so accounts and chat history survive redeploys.

## Growing the community (this matters more than the code)

A chat app with nobody in it makes no money. Before/alongside deployment:
- Post in horror subreddits, Discord servers, and Facebook groups where sharing
  a new community is welcome (check each community's self-promotion rules first).
- Cross-post recommendations-page content (with a link back) to build SEO traffic,
  which is also what makes AdSense approval and affiliate clicks worthwhile.
- Seed the rooms yourself for the first week so new visitors don't land in a
  silent chat room.
