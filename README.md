# fueldesk-push

Source for the `fueldesk` Cloudflare Worker — the FuelDesk diesel buy advisor
backend (FuelCloud tank + pump data, HO futures, supplier quotes, buy/hold
decision, Web Push alerts). The app itself is served by the separate
`fueldesk-app` Worker.

Cloudflare deploys this repo automatically on every push to `main`.
Secrets and variables live in Cloudflare (Settings → Variables and Secrets),
never in this repo. No KV bindings — state is in Firebase.

First automatic deploy: 2026-10-21.
