# WebRTC Call Center

Lightweight browser-to-browser call center. No PSTN. No paid services. Just Node.js + WebRTC.

## Setup

```bash
npm install
node server.js
```

## Access

| URL | Who |
|---|---|
| http://localhost:3000 | Customer calling page |
| http://localhost:3000/agent | Agent dashboard |

## How it works

1. Open `/agent` in up to 5 browser tabs — each agent enters their name and joins
2. Open `/` as a customer — enter name and click **Call Support**
3. If an agent is available, the call connects immediately
4. If all agents are busy, the customer is queued — agents can pick up from the queue panel
5. Either side can end the call

## Testing locally (two tabs)

- Tab 1: `http://localhost:3000/agent` → join as an agent
- Tab 2: `http://localhost:3000` → call as a customer

> **Note:** Chrome/Firefox will ask for microphone permission. Both sides need to allow it.

## Exposing publicly (optional)

Use [ngrok](https://ngrok.com) for a free public URL:

```bash
npx ngrok http 3000
```

Share the ngrok URL with your customer page testers. Agents use `<ngrok-url>/agent`.

> WebRTC requires HTTPS in production. ngrok handles this automatically on its free tier.

## Architecture

```
Customer Browser ──Socket.IO──► Node.js Signaling Server ◄──Socket.IO── Agent Browser
        │                                                                       │
        └──────────────── Direct WebRTC Audio (P2P) ───────────────────────────┘
```

The server never touches audio — it only exchanges WebRTC offer/answer/ICE signals.
Audio flows directly peer-to-peer between customer and agent browsers.

## Files

```
server.js                  # Signaling server + queue logic
public/
  customer/index.html      # Customer calling page
  agent/index.html         # Agent dashboard
package.json
```
