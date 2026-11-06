// Where a reply goes: one address per email, worked out here and nowhere else. The reply
// box (src/view.js), the IMAP/SMTP backend (src/mail.js) and the Outlook backend
// (src/microsoft.js) all use replyTarget(), so the address the user is shown is always
// the one the reply is sent to.

const EMAIL_RE = /^[^\s@]+@[^\s@]+$/;

/** True for something that looks like a real email address (name@host). */
const isEmail = (address) => typeof address === 'string' && EMAIL_RE.test(address.trim());

// One address from a backend ({ name, address }), tidied; null if it isn't a real address.
function tidy(a) {
  if (!a || typeof a !== 'object' || !isEmail(a.address)) return null;
  const address = a.address.trim().toLowerCase();
  return { name: String(a.name || '').trim() || address, address };
}

/**
 * The one address a reply to this email goes to: the first real Reply-To address, else
 * the From address if it is real, else null (the email can't be replied to).
 * @param {{ replyTo?: object|object[]|null, from?: object|null }} raw  a RawEmail (replyTo may
 *   also be a list)
 * @returns {{ name: string, address: string }|null}
 */
function replyTarget(raw) {
  for (const a of [...[].concat(raw?.replyTo || []), raw?.from]) {
    const found = tidy(a);
    if (found) return found;
  }
  return null;
}

const domainOf = (address) => address.slice(address.lastIndexOf('@') + 1);

/**
 * A short note for the reply box when the reply goes to a Reply-To address on another
 * domain than the one the email came from (a common trick in fake bank emails), else null.
 * @param {object} raw  a RawEmail
 * @returns {string|null}
 */
function replyNote(raw) {
  const target = replyTarget(raw);
  if (!target) return null;
  const from = tidy(raw?.from);
  if (from && (from.address === target.address || domainOf(from.address) === domainOf(target.address))) return null;
  return `Replies go to ${target.address}, not the address it came from.`;
}

module.exports = { EMAIL_RE, isEmail, replyTarget, replyNote };
