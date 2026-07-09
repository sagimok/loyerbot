// ──────────────────────────────────────────────────────────────
//  backup.js — deathwish.db'yi her 24 saatte bir GitHub'a yükler
// ──────────────────────────────────────────────────────────────
const fs = require('fs');
const axios = require('axios');
const { DB_PATH } = require('./restore');

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GITHUB_OWNER = process.env.GITHUB_OWNER || '';
const GITHUB_REPO = process.env.GITHUB_REPO || '';
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';
const GITHUB_FILE_PATH = 'deathwish.db';

const BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 saat

let backupInProgress = false;

/**
 * deathwish.db dosyasını GitHub reposuna yükler.
 * Dosya zaten varsa (sha bulunursa) günceller, yoksa oluşturur.
 * Aynı dosya path'i her zaman kullanılır — yeni dosya oluşturulmaz.
 */
async function uploadBackup() {
  if (backupInProgress) return;

  if (!GITHUB_TOKEN || !GITHUB_OWNER || !GITHUB_REPO) {
    console.error('[Backup] Upload failed');
    return;
  }
  if (!fs.existsSync(DB_PATH)) {
    console.error('[Backup] Upload failed');
    return;
  }

  backupInProgress = true;
  try {
    const apiUrl = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${GITHUB_FILE_PATH}`;
    const headers = {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: 'application/vnd.github.v3+json',
    };

    // Var olan dosyanın sha'sını al (varsa) — güncelleme için gerekli.
    let sha;
    const getRes = await axios.get(`${apiUrl}?ref=${GITHUB_BRANCH}`, {
      headers,
      validateStatus: () => true,
      timeout: 15000,
    });
    if (getRes.status === 200 && getRes.data && getRes.data.sha) {
      sha = getRes.data.sha;
    }

    const content = fs.readFileSync(DB_PATH);
    const base64Content = content.toString('base64');

    const putRes = await axios.put(
      apiUrl,
      {
        message: `Otomatik yedek - ${new Date().toISOString()}`,
        content: base64Content,
        branch: GITHUB_BRANCH,
        ...(sha ? { sha } : {}),
      },
      { headers, validateStatus: () => true, timeout: 30000 }
    );

    if (putRes.status !== 200 && putRes.status !== 201) {
      console.error('[Backup] Upload failed');
      return;
    }

    console.log('✅ Database uploaded to GitHub');
  } catch (err) {
    console.error('[Backup] Upload failed');
  } finally {
    backupInProgress = false;
  }
}

/**
 * 24 saatte bir otomatik yedekleme döngüsünü başlatır.
 * Bot login olduktan sonra bir kez çağrılmalı.
 */
async function startAutoBackup() {
  // Bot açılır açılmaz ilk yedeği al
  await uploadBackup();

  // Sonra her 24 saatte bir yedek al
  setInterval(async () => {
    try {
      await uploadBackup();
    } catch {
      console.error('[Backup] Upload failed');
    }
  }, BACKUP_INTERVAL_MS);
}

module.exports = { uploadBackup, startAutoBackup };
