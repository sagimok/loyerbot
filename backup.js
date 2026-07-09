// ──────────────────────────────────────────────────────────────
//  backup.js — deathwish.db'yi GitHub'a yedekler
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

async function uploadBackup() {
  if (backupInProgress) return;

  // Environment kontrolü
  if (!GITHUB_TOKEN || !GITHUB_OWNER || !GITHUB_REPO) {
    console.error('❌ Eksik GitHub ENV!');
    console.log({
      token: !!GITHUB_TOKEN,
      owner: GITHUB_OWNER,
      repo: GITHUB_REPO,
      branch: GITHUB_BRANCH
    });
    return;
  }

  // DB var mı?
  if (!fs.existsSync(DB_PATH)) {
    console.error('❌ Database bulunamadı:', DB_PATH);
    return;
  }

  backupInProgress = true;

  try {
    const apiUrl = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${GITHUB_FILE_PATH}`;

    const headers = {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
    };

    // SHA al (varsa)
    let sha;

    const getRes = await axios.get(`${apiUrl}?ref=${GITHUB_BRANCH}`, {
      headers,
      validateStatus: () => true,
      timeout: 15000,
    });

    if (getRes.status === 200) {
      sha = getRes.data.sha;
    } else if (getRes.status !== 404) {
      console.error("❌ GitHub GET Hatası");
      console.log(getRes.status);
      console.log(getRes.data);
      return;
    }

    const base64 = fs.readFileSync(DB_PATH).toString('base64');

    const putRes = await axios.put(
      apiUrl,
      {
        message: `Auto Backup ${new Date().toISOString()}`,
        content: base64,
        branch: GITHUB_BRANCH,
        ...(sha ? { sha } : {})
      },
      {
        headers,
        validateStatus: () => true,
        timeout: 30000
      }
    );

    if (putRes.status === 200 || putRes.status === 201) {
      console.log("✅ Database uploaded to GitHub");
    } else {
      console.error("❌ GitHub PUT Hatası");
      console.log(putRes.status);
      console.log(putRes.data);
    }

  } catch (err) {
    console.error("❌ Backup Exception");

    if (err.response) {
      console.log(err.response.status);
      console.log(err.response.data);
    } else {
      console.log(err.message);
    }

  } finally {
    backupInProgress = false;
  }
}

async function startAutoBackup() {

  console.log("📦 İlk GitHub yedeği alınıyor...");
  await uploadBackup();

  setInterval(async () => {

    console.log("📦 Otomatik GitHub yedeği alınıyor...");

    try {
      await uploadBackup();
    } catch (err) {
      console.error(err);
    }

  }, BACKUP_INTERVAL_MS);
}

module.exports = {
  uploadBackup,
  startAutoBackup
};
