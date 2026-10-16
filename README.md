# ClearMail

**Email that reads like WhatsApp.** A Mac desktop app that strips the waffle out of your emails and shows each one as a short chat message, with the parts you must not miss highlighted.

![ClearMail screenshot](docs/screenshot.png)

## What it does

- **Chats, not an inbox.** Emails are grouped by person, newest first, with unread badges. Open a person to see their emails as chat bubbles.
- **Waffle removed.** Strips greetings, "hope you're well", "don't hesitate to contact me", sign-offs, signatures, "Sent from my iPhone", quoted reply chains, legal disclaimers and unsubscribe footers. Each bubble shows how many words were cut.
- **Key info pulled out**, so nothing gets lost in a paragraph:
  - 📌 **You need to**: things you have to do, with deadlines
  - ❓ **They asked**: questions waiting for your answer
  - 📅 **Dates**, 💷 **money**, 📎 **attachments**, 🔗 **links** (long tracking links become short labels)
  - ⚠︎ **Time-sensitive** emails get a red edge
- **"Needs me" filter** and a banner showing how many conversations are waiting on you. **Updates** collects receipts, newsletters and automated mail so they don't bury real people.
- **Reply like a text.** Tap a suggested reply or type your own, press Enter, and it's sent as a proper email reply.
- **Read full email** on any bubble shows the original, uncleaned email (with a switch to the cleaned version), so nothing the cleaner removed is out of reach.
- **Mark done** clears an email's "needs me" flag once you've dealt with it.

### Two modes

| | Offline (default) | AI (add a Claude API key) |
|---|---|---|
| Removes waffle, signatures, quoted replies, footers | ✅ | ✅ |
| Highlights dates, money, links, attachments | ✅ | ✅ |
| One-line headline per email | first useful sentence | rewritten in plain English |
| To-do list and questions | pattern-based | understood and reworded |
| Suggested replies | generic | written for that email |

Offline mode runs entirely on your Mac. AI mode sends each email to Claude (Anthropic's API): the sender, subject, date and attachment names, the cleaned text, and the original text (up to 30,000 characters, including any quoted or forwarded messages), so nothing the cleaner dropped is missed. The result is cached, so each email is only summarised once.

## Getting started

You need [Node.js](https://nodejs.org) 22.12 or newer (the LTS download from nodejs.org is fine).

```bash
git clone https://github.com/willwright11/clearmail.git
cd clearmail
npm install
npm run demo     # try it with sample emails
npm start        # normal start (opens in demo mode until you connect an account)
```

Then press **⌘,** (or the ⚙︎ button) to connect your email:

1. Choose your provider (Gmail, iCloud, Yahoo, or a custom IMAP/SMTP server with SSL/TLS or STARTTLS).
2. Enter your email address and an **app password**. This is not your normal password:
   - **Gmail:** turn on 2-Step Verification, then create one at <https://myaccount.google.com/apppasswords>
   - **iCloud:** <https://account.apple.com> → Sign-In and Security → App-Specific Passwords
   - **Yahoo:** Account Security → Generate app password
   - **Outlook / Microsoft 365** isn't supported: Microsoft has switched off app-password access to IMAP and SMTP. Forward your mail to Gmail or iCloud instead.
   - **Custom server:** use your full email address as the user name, as it is also the From address of your replies.
3. Optional: paste a Claude API key from <https://console.anthropic.com> for AI summaries.
4. Untick **Demo mode** and save.

Your password and API key are encrypted with the macOS Keychain (Electron `safeStorage`) and stored only on your Mac.

### Build a proper .app

```bash
npm run dist     # creates a .dmg in dist/
```

The build isn't code-signed, so the first time you open it, right-click the app → **Open**.

## Keyboard shortcuts

| Key | Action |
|---|---|
| ↑ / ↓ | previous / next conversation |
| Enter | send reply (Shift+Enter for a new line) |
| ⌘R | refresh inbox |
| ⌘F | search |
| ⌘, | settings |

## How it works

```
main.js            Electron main process: window, IPC, wiring
preload.js         the safe bridge the UI uses (no Node access in the page)
src/cleaner.js     offline waffle remover + extraction of dates, money, asks, links
src/summarize.js   Claude summary (structured JSON) with offline fallback
src/mail.js        IMAP fetch (imapflow + mailparser), SMTP reply (nodemailer)
src/store.js       settings (Keychain-encrypted secrets) and summary cache
src/demo.js        sample inbox
renderer/          the chat UI (plain HTML/CSS/JS, light and dark mode)
test/              npm test
```

Privacy and safety:
- Email HTML is never rendered. It's converted to plain text, so tracking pixels and remote images never load.
- The page runs sandboxed with a strict Content Security Policy. Links open in your browser only after you confirm.
- ClearMail loads the newest 60 messages in your inbox (**Emails to load** in Settings, up to 500). Opening a conversation marks its emails as read on the server.
- Replies are sent over SMTP. For iCloud and custom servers a copy is also saved in your Sent mailbox (Gmail and Yahoo do this themselves).

## Ideas for next steps

- Gmail/Outlook sign-in with OAuth instead of app passwords
- Live updates with IMAP IDLE instead of manual refresh
- Thread whole conversations (both sides) from the Sent folder
- Snooze, archive and pin from the chat list
- Menu-bar badge and notifications for "needs me" emails
