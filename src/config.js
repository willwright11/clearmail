// Settings baked in when the app is built. GitHub Actions writes build-config.json from a
// repository variable; a developer can set CLEARMAIL_MS_CLIENT_ID instead. Both are optional.

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'build-config.json');
// A Microsoft "Application (client) ID" is a GUID.
const CLIENT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function clientId(value) {
  const id = typeof value === 'string' ? value.trim() : '';
  if (id && !CLIENT_ID_RE.test(id)) {
    console.warn('Ignoring a Microsoft app ID that is not a GUID.');
    return '';
  }
  return id.toLowerCase();
}

// Never throws: a missing or damaged file just means "nothing built in".
function readConfig({ env = process.env, file = FILE } = {}) {
  let data = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) data = parsed;
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn('build-config.json could not be read:', err.message);
  }
  return { msClientId: clientId(env.CLEARMAIL_MS_CLIENT_ID) || clientId(data.msClientId) };
}

module.exports = { ...readConfig(), readConfig, CLIENT_ID_RE };
