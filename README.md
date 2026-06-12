# @usepulseapp/sdk-web

Analytics-only web SDK for [Pulse](https://github.com/usepulseapp/sdk-web) —
subscription analytics for app developers. It captures product telemetry
(installs, sessions, screens, paywall interactions, custom events) and sends it
to your Pulse workspace. It never touches purchases or payment flows.

## Install

```sh
npm install @usepulseapp/sdk-web
```

## Quickstart

```ts
import * as Pulse from "@usepulseapp/sdk-web";

// Your app's publishable web SDK key (pk_…) from the Pulse dashboard.
Pulse.init("pk_your_key", {
  environment: "production", // or "test" during development
});

// Tie events to your own user id (call after login, with your user object).
Pulse.identify(currentUser.id);

// Track anything.
Pulse.track("feature_used", { feature: "export" });

// Built-in helpers for the funnel events Pulse charts natively.
Pulse.screenView("settings");
Pulse.paywallImpression({ placement: "settings_upsell" });
Pulse.paywallDismiss();
Pulse.cancelReason("too_expensive");

// On logout.
Pulse.reset();
```

`init` is all that's required — the SDK auto-captures `install`, `app_open`,
`session_start`, and `session_end` (disable with `autoCapture: false`).

## How it works

- Events are buffered (in memory + `localStorage`) and flushed in batches every
  10 seconds, on page hide, and on demand via `await Pulse.flush()`.
- Each event carries a stable anonymous `distinct_id`; `identify()` attaches
  your user id on top so identities unify server-side.
- Event properties are flat primitive bags (`string | number | boolean | null`);
  nested objects and arrays are dropped client-side.
- Delivery is at-least-once with client event ids, so the server deduplicates —
  retries never double-count.

## Options

All `init` options are optional:

| Option            | Default                       | Purpose                                      |
| ----------------- | ----------------------------- | -------------------------------------------- |
| `environment`     | `"production"`                | `"test"` keeps dev traffic out of prod stats |
| `apiHost`         | `https://api.usepulseapp.dev` | Override for tests or self-hosting           |
| `flushIntervalMs` | `10000`                       | Batch flush cadence                          |
| `sessionTimeoutMs`| `1800000`                     | Idle time before a new session (30 min)      |
| `autoCapture`     | `true`                        | Auto install/app_open/session events         |
| `disabled`        | `false`                       | Start opted-out (no network, no storage)     |
| `maxBufferEvents` | `500`                         | Ring-buffer cap                              |
| `debug`           | `false`                       | Console diagnostics                          |

Runtime opt-out: `Pulse.disable()` / `Pulse.enable()` / `Pulse.isEnabled()`.

## Privacy

The SDK stores only its own state in `localStorage` — anonymous id, session
and install state, your identified user id, the opt-out flag, and the event
buffer. It
sends data only to the configured `apiHost`, and collects nothing until `init`
is called. `disable()` stops collection and clears scheduled sends.

## Source & issues

Source lives at [github.com/usepulseapp/sdk-web](https://github.com/usepulseapp/sdk-web).
Bug reports and feature requests: [issues](https://github.com/usepulseapp/sdk-web/issues).

MIT © Pulse
