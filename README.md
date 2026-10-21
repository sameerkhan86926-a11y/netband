# NETBAND

**Offline-first communication concept — web prototype v0.1**

NETBAND explores tools that remain useful when internet connectivity is unavailable.

## Current prototype features
- Responsive dark interface
- Browser online/offline indicator
- Local notes saved in browser `localStorage`
- Emergency information saved locally
- Service worker app-shell caching for repeat visits
- PWA manifest and install prompt support where available

## Important limitations
This repository is a web prototype, **not yet an offline phone-to-phone messaging app**. It does not discover nearby devices, send Bluetooth messages, transmit SOS alerts, or contact emergency services. A GitHub Pages website cannot provide universal cross-platform Bluetooth/mesh communication by itself.

Real device-to-device messaging requires a native implementation and protocol testing across Android and iOS. Android and Apple networking APIs are not automatically interoperable.

## Deploy with GitHub Pages
1. Open repository **Settings → Pages**.
2. Under **Build and deployment**, choose **Deploy from a branch**.
3. Select branch `main` and folder `/(root)`, then save.
4. Wait for the Pages deployment to finish. Your site will be available at `https://YOUR-USERNAME.github.io/netband/`.

## Test offline
1. Open the deployed site while online and let it finish loading.
2. Save a note and emergency kit.
3. Reopen the site once so the service worker can cache the app shell.
4. Turn on airplane mode and revisit the site. Browser behavior can vary; test on each device.
5. Notes are stored in that browser on that device. Clearing browser data can delete them.

## Privacy
Do not store highly sensitive information in this prototype. Local browser storage is not a secure vault and may be cleared by the browser.

## Planned roadmap
1. Validate offline-first PWA behavior.
2. Choose a native networking approach for Android and iOS.
3. Implement pairing, message framing, delivery acknowledgements, retries and encryption.
4. Test Android↔Android, iPhone↔iPhone and Android↔iPhone separately.
5. Evaluate store-and-forward relay only after direct messaging works reliably.
