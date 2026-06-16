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

| Option             | Default                       | Purpose                                      |
| ------------------ | ----------------------------- | -------------------------------------------- |
| `environment`      | `"production"`                | `"test"` keeps dev traffic out of prod stats |
| `apiHost`          | `https://api.usepulseapp.dev` | Override for tests or self-hosting           |
| `flushIntervalMs`  | `10000`                       | Batch flush cadence                          |
| `sessionTimeoutMs` | `1800000`                     | Idle time before a new session (30 min)      |
| `autoCapture`      | `true`                        | Auto install/app_open/session events         |
| `disabled`         | `false`                       | Start opted-out (no network, no storage)     |
| `maxBufferEvents`  | `500`                         | Ring-buffer cap                              |
| `debug`            | `false`                       | Console diagnostics                          |

Runtime opt-out: `Pulse.disable()` / `Pulse.enable()` / `Pulse.isEnabled()`.

## Cancellation survey

`mountCancellationSurvey()` is a drop-in UI component that presents a reason
picker to users who are cancelling, and emits a `cancel_reason` analytics event
via the existing `cancelReason()` API. It never touches the purchase path.

> **Note:** like every Pulse API, the survey emits nothing until `Pulse.init()` has
> run — a submit before init is silently dropped (it fails closed: no event, no
> error, no crash). Mount it from inside your cancel flow, by which point `init()`
> has already run.

**Modal (appended to `document.body`):**

```ts
import { mountCancellationSurvey } from "@usepulseapp/sdk-web";

// Call this from inside your cancel flow — do NOT call it on page load.
const survey = mountCancellationSurvey({
  onSubmit(reason) {
    console.log("reason emitted:", reason);
    // Continue your cancel flow here.
  },
  onDismiss() {
    // User skipped — no event was emitted.
  },
});

// Programmatic teardown (e.g. if the parent view unmounts):
survey.destroy();
```

**Inline (rendered inside your own container):**

```ts
const container = document.getElementById("cancel-survey-slot")!;
mountCancellationSurvey({ container, onSubmit, onDismiss });
```

**Theming** — pass a `theme` object to override any of the CSS custom properties
(`--pulse-cs-accent`, `--pulse-cs-text`, `--pulse-cs-muted`, `--pulse-cs-bg`,
`--pulse-cs-border`, `--pulse-cs-font`, `--pulse-cs-radius`, `--pulse-cs-gap`):

```ts
mountCancellationSurvey({
  theme: {
    accent: "#7c3aed", // purple highlight
    bg: "#1e1e2e", // dark background
    text: "#cdd6f4",
    muted: "#6c7086",
    border: "#313244",
    radius: "6px",
  },
  texts: {
    title: "Before you go…",
    submitLabel: "Send feedback",
    dismissLabel: "No thanks",
  },
});
```

You can also override individual styles from your own CSS using the semantic
class names (`pulse-cs-panel`, `pulse-cs-option`, `pulse-cs-btn--submit`, etc.)
since they carry no specificity-inflating selectors.

The option list and their emitted reason codes are exported as
`CANCELLATION_SURVEY_OPTIONS` for building custom UIs against the same locked
vocabulary without drift.

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
