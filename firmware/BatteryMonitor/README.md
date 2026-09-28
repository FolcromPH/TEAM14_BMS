# ESP32 Cloud Setup

The ESP32 initiates all cloud requests. It posts telemetry to the Worker, polls for commands, applies them, and acknowledges them. It does not expose a port or accept requests from Cloudflare.

## Run locally on your Wi-Fi

1. Open `BatteryMonitor.ino` in Arduino IDE. Install the same ArduinoJson, Adafruit INA260, and DHT libraries used by the existing sketch.
2. Set `dev.ip` in `wrangler.jsonc` to `0.0.0.0`, then start `npm run dev:worker` in one terminal and `npm run dev` in another.
3. Find the laptop's Wi-Fi IPv4 address. Set `WORKER_BASE_URL` in the local `secrets.h` to `http://<LAPTOP_LAN_IP>:8787`, for example `http://192.168.1.16:8787` if that is still your laptop's address.
4. Set the same `DEVICE_TOKEN` in `.dev.vars` and `secrets.h`, and set the Wi-Fi name/password there. Do not commit `secrets.h`; it is ignored by Git. `secrets.example.h` is a template.
5. Allow Wrangler/Node through Windows Firewall on private networks, then upload the sketch. It sends readings every five seconds and checks the command queue every 1.5 seconds.

Local mode uses plain HTTP only on your trusted home LAN. The device token is visible to other devices on that LAN, so do not use this URL on public Wi-Fi.

## Deploy to Cloudflare

Change `WORKER_BASE_URL` to the HTTPS Worker URL and set `WORKER_ROOT_CA` in `secrets.h` to that host's trusted root certificate. The sketch uses `WiFiClientSecure::setCACert()` for HTTPS validation. Set the matching production token with `npx wrangler secret put DEVICE_TOKEN`; do not deploy the local example token. Protect the dashboard and `/api/control/*` with Cloudflare Access while leaving `/api/device/*` reachable for the token-authenticated ESP32.

The Wi-Fi password from the pasted sketch should be changed before continuing, since it was shared in chat. Put the new password only in the ignored `secrets.h` file. Local D1 and Cloudflare D1 are separate databases; apply migrations to the target database before using it.
