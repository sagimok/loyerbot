// ──────────────────────────────────────────────────────────────
//  restore.js — Bot açılırken GitHub'dan deathwish.db'yi geri yükler
// ──────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const DB_PATH = path.join(__dirname, 'deathwish.db');

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GITHUB_OWNER = process.env.GITHUB_OWNER || '';
const GITHUB_REPO = process.env.GITHUB_REPO || '';
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';
const GITHUB_FILE_PATH = 'deathwish.db';

/**
 * Eğer deathwish.db diskte yoksa GitHub reposundaki son yedeği indirir.
 * Diskte varsa hiçbir şey yapmaz. Hiçbir durumda TOKEN'i loglamaz.
 */
async function restoreDatabase() {
  if (fs.existsSync(DB_PATH)) {
    console.log('Database already exists.');
    return;
  }

  if (!GITHUB_TOKEN || !GITHUB_OWNER || !GITHUB_REPO) {
    console.error('[Restore] Download failed');
    return;
  }

  try {
    const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${GITHUB_FILE_PATH}?ref=${GITHUB_BRANCH}`;
    const res = await axios.get(url, {
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: 'application/vnd.github.v3+json',
      },
      validateStatus: () => true,
      timeout: 15000,
    });

    if (res.status === 404) {
      // Repoda henüz yedek yok — sıfırdan boş veritabanıyla başla.
      console.log('[Restore] GitHub deposunda henüz yedek yok, sıfırdan başlanıyor.');
      return;
    }

    if (res.status !== 200 || !res.data || !res.data.content) {
      console.error('[Restore] Download failed');
      return;
    }

    const buffer = Buffer.from(res.data.content, 'base64');
    fs.writeFileSync(DB_PATH, buffer);
    console.log('✅ Database restored from GitHub');
  } catch (err) {
    console.error('[Restore] Download failed');
  }
}

module.exports = { restoreDatabase, DB_PATH };
