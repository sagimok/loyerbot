// ╔══════════════════════════════════════════════════════════════╗
// ║      DeathWish Bot — ESKİ/SADELEŞTİRİLMİŞ VERSİYON        ║
// ║  • Ticket, Moderasyon, OwO filtre                           ║
// ║  • Kullanıcı bazlı /yetkiver sistemi (yeni)                 ║
// ║  • Ekonomi/Seviye/Ses/Sohbet/YazıOyunu KALDIRILDI           ║
// ║  • WatchDog v1 entegre                                      ║
// ╚══════════════════════════════════════════════════════════════╝

require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const { monitorEventLoopDelay } = require('perf_hooks');
const {
  Client, GatewayIntentBits, Collection, ActivityType, REST, Routes,
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, ChannelSelectMenuBuilder, RoleSelectMenuBuilder,
  UserSelectMenuBuilder,
  SlashCommandBuilder, PermissionFlagsBits, ComponentType, ChannelType,
  AuditLogEvent,
} = require('discord.js');
const Database = require('better-sqlite3');
const express  = require('express');
const { restoreDatabase, DB_PATH } = require('./restore');
const { startAutoBackup } = require('./backup');

// ──────────────────────────────────────────────────────────────
//  AYARLAR (.env'den okunur)
// ──────────────────────────────────────────────────────────────
const TOKEN         = process.env.DISCORD_TOKEN || '';
const OWNERS        = (process.env.OWNERS || '').split(',').map(s => s.trim()).filter(Boolean);
const OWNER_LABEL   = { [OWNERS[0]]: 'hayhay sagi bey', [OWNERS[1]]: 'hayhay lunar bey' };
const SETUP_CHANNEL = process.env.SETUP_CHANNEL || '';
const PORT          = process.env.PORT || 3000;

// Bu role sahip olan herkes, owner-only komutları da kullanabilir.
const OWNER_ROLE_ID = '1525831115972284587';
// Komutların çalışacağı kanal (ownerlar hariç her yerde bu kanal zorunlu)
const KOMUT_KANALI = '1524182887040159754';
function hasOwnerAccess(userId, member) {
  if (OWNERS.includes(userId)) return true;
  if (member && member.roles && member.roles.cache && member.roles.cache.has(OWNER_ROLE_ID)) return true;
  return false;
}

const ORIENTATION_PHOTO_URL = 'https://i.kym-cdn.com/photos/images/newsfeed/003/107/283/053.jpg';

if (!TOKEN) { console.error('⛔ DISCORD_TOKEN bulunamadı!'); process.exit(1); }

// ──────────────────────────────────────────────────────────────
//  WEB SUNUCUSU (Render keepalive)
// ──────────────────────────────────────────────────────────────
const app = express();
app.get('/', (_, res) => res.send('DeathWish Bot aktif! 🔥'));
app.listen(PORT, () => console.log(`🌐 Web sunucusu: ${PORT}`));

// ──────────────────────────────────────────────────────────────
//  VERİTABANI (SQLite)
// ──────────────────────────────────────────────────────────────
let db;

function initDatabase() {
  db = new Database(DB_PATH);
  db.exec(`
    CREATE TABLE IF NOT EXISTS guild_settings (guildId TEXT, key TEXT, value TEXT, PRIMARY KEY(guildId,key));
    CREATE TABLE IF NOT EXISTS warns (id INTEGER PRIMARY KEY AUTOINCREMENT, guildId TEXT, userId TEXT, moderatorId TEXT, reason TEXT, createdAt TEXT);
    CREATE TABLE IF NOT EXISTS tickets (id INTEGER PRIMARY KEY AUTOINCREMENT, guildId TEXT, userId TEXT, channelId TEXT, status TEXT DEFAULT 'open', createdAt TEXT);
    CREATE TABLE IF NOT EXISTS mod_actions (id INTEGER PRIMARY KEY AUTOINCREMENT, guildId TEXT, userId TEXT, moderatorId TEXT, type TEXT, channelId TEXT, minutes INTEGER DEFAULT 0, reason TEXT, createdAt TEXT);
    CREATE TABLE IF NOT EXISTS mod_permissions (guildId TEXT, userId TEXT, action TEXT, PRIMARY KEY(guildId,userId,action));
  `);
  console.log('✅ Veritabanı hazır.');
}

// ── DB yardımcıları ───────────────────────────────────────────
function getSetting(gid, key)        { const r = db.prepare('SELECT value FROM guild_settings WHERE guildId=? AND key=?').get(gid,key); return r?r.value:null; }
function setSetting(gid, key, value) { db.prepare('INSERT OR REPLACE INTO guild_settings (guildId,key,value) VALUES(?,?,?)').run(gid,key,value); }
function getAllSettings(gid)          { const rows = db.prepare('SELECT key,value FROM guild_settings WHERE guildId=?').all(gid); const o={}; for(const r of rows) o[r.key]=r.value; return o; }

function addWarn(gid,uid,modId,reason) { db.prepare('INSERT INTO warns(guildId,userId,moderatorId,reason,createdAt)VALUES(?,?,?,?,?)').run(gid,uid,modId,reason,nowTR()); }
function getWarns(gid,uid)             { return db.prepare('SELECT * FROM warns WHERE guildId=? AND userId=? ORDER BY createdAt DESC').all(gid,uid); }
function clearWarns(gid,uid)           { db.prepare('DELETE FROM warns WHERE guildId=? AND userId=?').run(gid,uid); }

// ── Moderasyon yetki + geçmiş sistemi ─────────────────────────
// Yetki sistemi: kullanıcı bazlı (mod_permissions) ÖNCE kontrol edilir,
// sonra setup'tan ayarlanan rol bazlı, son olarak genel yetkili rol.
const MOD_PERMISSION_ROLE_ID = '1524107651510702160';
const MOD_ACTION_SETTING_KEYS = {
  ban:    'ban_mod_role',
  mute:   'mute_mod_role',
  warn:   'warn_mod_role',
  unmute: 'mute_mod_role',
};

// Kullanıcı bazlı yetki yönetimi
function grantModPermission(gid, userId, action) {
  db.prepare('INSERT OR IGNORE INTO mod_permissions(guildId,userId,action)VALUES(?,?,?)').run(gid,userId,action);
}
function revokeModPermission(gid, userId, action) {
  db.prepare('DELETE FROM mod_permissions WHERE guildId=? AND userId=? AND action=?').run(gid,userId,action);
}
function hasModPermission(gid, userId, action) {
  return !!db.prepare('SELECT 1 FROM mod_permissions WHERE guildId=? AND userId=? AND action=?').get(gid,userId,action);
}
function getAllModPermissions(gid) {
  return db.prepare('SELECT userId, action FROM mod_permissions WHERE guildId=? ORDER BY userId').all(gid);
}

function canModerateAction(member, action) {
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  // 1) Kullanıcı bazlı doğrudan yetki
  if (hasModPermission(member.guild.id, member.id, action)) return true;
  if (hasModPermission(member.guild.id, member.id, 'hepsi')) return true;
  // 2) Rol bazlı (geriye dönük uyumluluk)
  const settingKey = MOD_ACTION_SETTING_KEYS[action];
  const specificRoleId = settingKey ? getSetting(member.guild.id, settingKey) : null;
  if (specificRoleId) return member.roles.cache.has(specificRoleId);
  return member.roles.cache.has(MOD_PERMISSION_ROLE_ID);
}
function canModerate(member) {
  if (!member) return false;
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  return member.roles.cache.has(MOD_PERMISSION_ROLE_ID);
}
function addModAction(gid,uid,modId,type,channelId,minutes,reason) {
  db.prepare('INSERT INTO mod_actions(guildId,userId,moderatorId,type,channelId,minutes,reason,createdAt)VALUES(?,?,?,?,?,?,?,?)').run(gid,uid,modId,type,channelId,minutes||0,reason,nowTR());
}
function getModHistory(gid,uid) { return db.prepare('SELECT * FROM mod_actions WHERE guildId=? AND userId=? ORDER BY createdAt DESC').all(gid,uid); }
function getModSummary(gid,uid) {
  const rows = getModHistory(gid,uid);
  const warnCount = rows.filter(r=>r.type==='warn').length;
  const muteCount = rows.filter(r=>r.type==='mute').length;
  const totalMuteMinutes = rows.filter(r=>r.type==='mute').reduce((a,r)=>a+(r.minutes||0),0);
  return { rows, warnCount, muteCount, totalMuteMinutes };
}

function getOpenTicket(gid,uid)    { return db.prepare("SELECT * FROM tickets WHERE guildId=? AND userId=? AND status='open'").get(gid,uid); }
function createTicket(gid,uid,cid) { db.prepare('INSERT INTO tickets(guildId,userId,channelId,status,createdAt)VALUES(?,?,?,?,?)').run(gid,uid,cid,'open',nowTR()); }
function closeTicket(cid)          { db.prepare("UPDATE tickets SET status='closed' WHERE channelId=?").run(cid); }

function todayTR() { return new Date().toLocaleDateString('tr-TR',{timeZone:'Europe/Istanbul'}).split('.').reverse().join('-'); }
function nowTR()   { return new Date().toLocaleString('tr-TR',{timeZone:'Europe/Istanbul'}); }
function pick(arr) { return arr[Math.floor(Math.random()*arr.length)]; }
function trL(s)    { return (s||'').toLocaleLowerCase('tr').trim(); }

// ──────────────────────────────────────────────────────────────
//  SOHBET VERİLERİ
// ──────────────────────────────────────────────────────────────


// ──────────────────────────────────────────────────────────────
//  SLASH KOMUT TANIMLARI
// ──────────────────────────────────────────────────────────────
const SLASH_COMMANDS = [
  new SlashCommandBuilder().setName('setup').setDescription('Bot ayar panelini aç').setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName('yardim').setDescription('Komut rehberi'),
  new SlashCommandBuilder().setName('mod').setDescription('Moderasyon')
    .addSubcommand(s=>s.setName('ban').setDescription('Ban').addUserOption(o=>o.setName('kullanici').setDescription('Kullanıcı').setRequired(true)).addStringOption(o=>o.setName('sebep').setDescription('Sebep')))
    .addSubcommand(s=>s.setName('kick').setDescription('Kick').addUserOption(o=>o.setName('kullanici').setDescription('Kullanıcı').setRequired(true)).addStringOption(o=>o.setName('sebep').setDescription('Sebep')))
    .addSubcommand(s=>s.setName('mute').setDescription('Sustur').addUserOption(o=>o.setName('kullanici').setDescription('Kullanıcı').setRequired(true)).addIntegerOption(o=>o.setName('dakika').setDescription('Dakika').setRequired(true).setMinValue(1).setMaxValue(43200)).addStringOption(o=>o.setName('sebep').setDescription('Sebep')))
    .addSubcommand(s=>s.setName('unmute').setDescription('Susturmayı kaldır').addUserOption(o=>o.setName('kullanici').setDescription('Kullanıcı').setRequired(true)))
    .addSubcommand(s=>s.setName('warn').setDescription('Uyar').addUserOption(o=>o.setName('kullanici').setDescription('Kullanıcı').setRequired(true)).addStringOption(o=>o.setName('sebep').setDescription('Sebep').setRequired(true)))
    .addSubcommand(s=>s.setName('gecmis').setDescription('Kullanıcının moderasyon geçmişini göster').addUserOption(o=>o.setName('kullanici').setDescription('Kullanıcı').setRequired(true)))
    .addSubcommand(s=>s.setName('uyarilar').setDescription('Uyarıları gör').addUserOption(o=>o.setName('kullanici').setDescription('Kullanıcı').setRequired(true)))
    .addSubcommand(s=>s.setName('uyari-sil').setDescription('Uyarıları temizle').addUserOption(o=>o.setName('kullanici').setDescription('Kullanıcı').setRequired(true)))
    .addSubcommand(s=>s.setName('temizle').setDescription('Mesaj sil').addIntegerOption(o=>o.setName('adet').setDescription('Adet (1-100)').setRequired(true).setMinValue(1).setMaxValue(100)))
    .addSubcommand(s=>s.setName('kilit').setDescription('Kanalı kilitle'))
    .addSubcommand(s=>s.setName('kilit-ac').setDescription('Kanal kilidini aç'))
    .addSubcommand(s=>s.setName('slowmode').setDescription('Yavaş mod').addIntegerOption(o=>o.setName('saniye').setDescription('Saniye (0=kapalı)').setRequired(true).setMinValue(0).setMaxValue(21600))),
  new SlashCommandBuilder().setName('info').setDescription('Bilgi komutları')
    .addSubcommand(s=>s.setName('sunucu').setDescription('Sunucu bilgisi'))
    .addSubcommand(s=>s.setName('kullanici').setDescription('Kullanıcı bilgisi').addUserOption(o=>o.setName('hedef').setDescription('Kullanıcı'))),
  new SlashCommandBuilder().setName('ticket').setDescription('Ticket sistemi')
    .addSubcommand(s=>s.setName('panel').setDescription('[ADMIN] Panel gönder').addChannelOption(o=>o.setName('kanal').setDescription('Kanal').addChannelTypes(ChannelType.GuildText)))
    .addSubcommand(s=>s.setName('kapat').setDescription('Ticket kapat')),
  // ── YETKİ KOMUTLARI ──────────────────────────────────────────
  new SlashCommandBuilder().setName('yetkiver')
    .setDescription('[OWNER/Admin] Belirtilen kullanıcıya moderasyon yetkisi ver')
    .addUserOption(o=>o.setName('kullanici').setDescription('Yetki verilecek kullanıcı').setRequired(true))
    .addStringOption(o=>o.setName('islem').setDescription('Hangi yetki?').setRequired(true)
      .addChoices(
        {name:'Ban',value:'ban'},
        {name:'Mute',value:'mute'},
        {name:'Warn',value:'warn'},
        {name:'Unmute',value:'unmute'},
        {name:'Hepsi',value:'hepsi'},
      )),
  new SlashCommandBuilder().setName('yetkial')
    .setDescription('[OWNER/Admin] Kullanıcıdan moderasyon yetkisini geri al')
    .addUserOption(o=>o.setName('kullanici').setDescription('Yetkisi alınacak kullanıcı').setRequired(true))
    .addStringOption(o=>o.setName('islem').setDescription('Hangi yetki?').setRequired(true)
      .addChoices(
        {name:'Ban',value:'ban'},
        {name:'Mute',value:'mute'},
        {name:'Warn',value:'warn'},
        {name:'Unmute',value:'unmute'},
        {name:'Hepsi',value:'hepsi'},
      )),
  new SlashCommandBuilder().setName('yetki-liste')
    .setDescription('Bu sunucuda kime hangi moderasyon yetkisi verildiğini gösterir'),
].map(c => c.toJSON());

// ──────────────────────────────────────────────────────────────
//  CLIENT
// ──────────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildModeration,
  ],
});

// ──────────────────────────────────────────────────────────────
//  🩺 DeathWish WatchDog v1 — Durum Değişkenleri
// ──────────────────────────────────────────────────────────────
const loop = monitorEventLoopDelay();
loop.enable();

let lastHeartbeat = Date.now();
let lastError = 'Yok';

// ──────────────────────────────────────────────────────────────
//  LOG YARDIMCISI
// ──────────────────────────────────────────────────────────────
async function sendLog(guild, settingKey, embed) {
  const chId = getSetting(guild.id, settingKey);
  if (!chId) return;
  const ch = guild.channels.cache.get(chId);
  if (ch) ch.send({ embeds: [embed] }).catch(() => {});
}

// ──────────────────────────────────────────────────────────────
//  READY
// ──────────────────────────────────────────────────────────────
client.once('ready', async () => {
  console.log(`✅ Bot aktif: ${client.user.tag}`);
  console.log('🟢 WatchDog aktif.');
  client.user.setPresence({ activities: [{ name: 'DeathWish | /yardim', type: ActivityType.Playing }], status: 'online' });

  // Slash komutları kaydet
  try {
    const rest = new REST().setToken(TOKEN);
    await rest.put(Routes.applicationCommands(client.user.id), { body: SLASH_COMMANDS });
    console.log(`✅ ${SLASH_COMMANDS.length} slash komutu kaydedildi.`);
  } catch (e) { console.error('⛔ Slash kayıt hatası:', e); }
});

// Her 14 dakikada presence yenile
setInterval(() => {
  client.user?.setPresence({ activities: [{ name: 'DeathWish | /yardim', type: ActivityType.Playing }], status: 'online' });
}, 14 * 60 * 1000);

// ──────────────────────────────────────────────────────────────
//  ÜYE KATILDI
// ──────────────────────────────────────────────────────────────
client.on('guildMemberAdd', async member => {
  try {
    const gid = member.guild.id;
    const autoRole = getSetting(gid, 'welcome_auto_role');
    if (autoRole) { const role = member.guild.roles.cache.get(autoRole); if (role) await member.roles.add(role).catch(()=>{}); }
    const wCh = getSetting(gid, 'welcome_channel');
    if (!wCh) return;
    const ch = member.guild.channels.cache.get(wCh);
    if (!ch) return;
    const WELCOME_GIF        = 'https://media.tenor.com/fW0VI-KoR3QAAAAM/pizza-eating.gif';
    const WELCOME_RULES_CH   = '1524162633228619776';
    const WELCOME_COLOR_CH   = '1524160412118155335';

    let msg = getSetting(gid,'welcome_message') || `
# ✦・DeathWish'e Hoş Geldin!

Merhaba {etiket}! 🌸

> 💖 DeathWish ailesine katıldığın için teşekkür ederiz.
> 👥 Seninle birlikte **{uye_sayisi}. üyeye** ulaştık!

₊˚๑ Umarız burada güzel arkadaşlıklar edinir ve keyifli vakit geçirirsin. ✨

╭꒷・Kurallarımızı okumayı unutma! <#${WELCOME_RULES_CH}>
︰・Kendine özel renk rolünü al! <#${WELCOME_COLOR_CH}>

╰・İyi eğlenceler! 🤍
`;
    msg = msg
      .replace(/{kullanici}/g, member.user.username)
      .replace(/{etiket}/g, `<@${member.id}>`)
      .replace(/{mention}/g, `<@${member.id}>`)
      .replace(/{uye_sayisi}/g, member.guild.memberCount);
    const embed = new EmbedBuilder()
      .setColor('#ffb6d9')
      .setDescription(msg)
      .setThumbnail(member.user.displayAvatarURL({ size: 256 }))
      .setImage(WELCOME_GIF)
      .setFooter({ text: `DeathWish • ${member.guild.memberCount}. Üye` })
      .setTimestamp();
    await ch.send({ embeds: [embed] });
    const dm = getSetting(gid, 'welcome_dm');
    if (dm) await member.send(dm.replace(/{kullanici}/g,member.user.username).replace(/{sunucu}/g,member.guild.name)).catch(()=>{});
  } catch {}
});

// ──────────────────────────────────────────────────────────────
//  ÜYE AYRILDI
// ──────────────────────────────────────────────────────────────
client.on('guildMemberRemove', async member => {
  try {
    const gid = member.guild.id;
    const lCh = getSetting(gid, 'leave_channel');
    if (!lCh) return;
    const ch = member.guild.channels.cache.get(lCh);
    if (!ch) return;
    const days = member.joinedAt ? Math.floor((Date.now()-member.joinedAt.getTime())/86400000) : 0;
    const embed = new EmbedBuilder()
      .setTitle('👋 Üye Ayrıldı')
      .setDescription(`**${member.user.username}** sunucudan ayrıldı.`)
      .addFields(
        {name:'📅 Kaldığı süre', value:`${days} gün`},
        {name:'👥 Üye sayısı', value:`${member.guild.memberCount}`}
      )
      .setColor(0xED4245)
      .setTimestamp();
    await ch.send({ embeds: [embed] });
  } catch {}
});

// ──────────────────────────────────────────────────────────────
//  MESAJ SİLME LOGU
// ──────────────────────────────────────────────────────────────
client.on('messageDelete', async message => {
  try {
    if (message.author?.bot || !message.guild) return;
    const logCh = getSetting(message.guild.id, 'log_message_channel');
    if (!logCh || message.channelId === logCh) return;
    const ch = message.guild.channels.cache.get(logCh);
    if (!ch) return;
    const embed = new EmbedBuilder()
      .setTitle('🗑️ Mesaj Silindi')
      .setColor(0xED4245)
      .addFields(
        {name:'👤 Kullanıcı', value:`${message.author?.username||'?'} (<@${message.author?.id||'?'}>)`},
        {name:'📢 Kanal', value:`<#${message.channelId}>`},
        {name:'💬 İçerik', value:(message.content?.slice(0,1000)||'*Boş*')}
      )
      .setTimestamp();
    await ch.send({ embeds: [embed] });
  } catch {}
});

// ──────────────────────────────────────────────────────────────
//  BAN LOGU
// ──────────────────────────────────────────────────────────────
client.on('guildBanAdd', async ban => {
  try {
    const logCh = getSetting(ban.guild.id, 'log_ban_channel');
    if (!logCh) return;
    const ch = ban.guild.channels.cache.get(logCh);
    if (!ch) return;
    const embed = new EmbedBuilder()
      .setTitle('🔨 Kullanıcı Banlandı')
      .setColor(0xED4245)
      .addFields(
        {name:'👤 Kullanıcı', value:`${ban.user.username} (<@${ban.user.id}>)`},
        {name:'📝 Sebep', value:ban.reason||'Belirtilmedi'}
      )
      .setTimestamp();
    await ch.send({ embeds: [embed] });
  } catch {}
});

// ──────────────────────────────────────────────────────────────
//  KANAL KORUMA (sohbet kanalı silindi → silen kişiyi kick)
// ──────────────────────────────────────────────────────────────
client.on('channelDelete', async channel => {
  try {
    if (!channel.guild) return;
    const gid = channel.guild.id;
    const sohbetCh = getSetting(gid, 'sohbet_channel');
    if (!sohbetCh || channel.id !== sohbetCh) return;
    const guild = channel.guild;
    await new Promise(r => setTimeout(r, 1500));
    let executor = null;
    try {
      const logs = await guild.fetchAuditLogs({ type: AuditLogEvent.ChannelDelete, limit: 1 });
      const entry = logs.entries.first();
      if (entry && entry.target?.id === channel.id) executor = entry.executor || null;
    } catch {}
    let kickResult = 'Belirsiz';
    if (executor && !OWNERS.includes(executor.id)) {
      const member = await guild.members.fetch(executor.id).catch(()=>null);
      if (member?.kickable) {
        await member.kick('Koruma: sohbet kanalını izinsiz silme.').catch(()=>{});
        kickResult = 'Kick atıldı ✅';
      } else kickResult = 'Kick atılamadı ⛔';
    } else if (executor && OWNERS.includes(executor.id)) kickResult = 'Owner sildi, işlem yok';
    const info = `⚠️ **Kanal Koruma**\nSilinen: <#${channel.id}>\nSilen: ${executor ? (executor.tag||executor.id) : 'bilinmiyor'}\nİşlem: ${kickResult}`;
    for (const id of OWNERS) {
      try { const u = await client.users.fetch(id); await u.send(info); } catch {}
    }
  } catch (e) { console.error('channelDelete koruma hatası:', e); }
});

// ──────────────────────────────────────────────────────────────
//  MESAJ CREATE — ! KOMUTLAR + SOHBET
// ──────────────────────────────────────────────────────────────
client.on('messageCreate', async message => {
  if (message.author.bot || !message.guild) return;
  const gid = message.guild.id;
  const uid = message.author.id;
  const cid = message.channel.id;
  const txt = trL(message.content);
  const lc  = txt;

  // ── KANAL KISITLAMASI ───────────────────────────────────────
  // !sohbet-sil hariç tüm komutlar sadece KOMUT_KANALI'nda çalışır
  // Owner rolüne sahip olanlar her kanalda kullanabilir
  const isOwnerUser = hasOwnerAccess(uid, message.member);
  const isSohbetSil = txt.startsWith('!sohbet-sil');
  if (!isSohbetSil && !isOwnerUser && cid !== KOMUT_KANALI) return;

  // ── OWO FİLTRE ─────────────────────────────────────────────
  const owoGameCh = getSetting(gid, 'owo_game_channel');
  if ((lc.startsWith('w daily') || lc.startsWith('w cf')) && owoGameCh && cid !== owoGameCh) {
    await message.reply(`⛔ Bu komutu burada kullanamazsın. Lütfen <#${owoGameCh}> kanalına geç.`).catch(()=>{});
    const me = message.guild?.members?.me;
    if (me?.permissionsIn(message.channel).has(PermissionFlagsBits.ManageMessages)) {
      await message.delete().catch(()=>{});
    }
    return;
  }

  // ── YARDIM ─────────────────────────────────────────────────
  if (txt === '!yardım' || txt === '!yardim') {
    return message.reply(`📘 **DeathWish Bot • Komut Listesi**

⚙️ **Ayarlar:** \`/setup\` → Tüm kanalları Discord'dan ayarla
📋 Yetkili komutları: \`!yardımyetkili\``);
  }

  // ── YETKİLİ YARDIM ─────────────────────────────────────────
  if (txt === '!yardımyetkili' || txt === '!yardimyetkili') {
    const isOwner = hasOwnerAccess(uid, message.member);
    const isMod   = message.member?.permissions.has(PermissionFlagsBits.ModerateMembers);
    if (!isOwner && !isMod) return message.reply('⛔ Bu yardımı görme yetkin yok.');
    return message.reply(`🛠️ **Yönetici/Owner Yardımı**

**Moderasyon (Prefix)**
• \`!ban <userId>\` — (Owner) Kullanıcıyı yasakla
• \`!unban <userId>\` — (Owner) Banı kaldır
• \`!mute <userId> <dakika>\` — Sustur (1–43200 dk)
• \`!sohbet-sil <1-100>\` — Toplu mesaj sil

**Slash Komutları**
• \`/mod ban/kick/mute/unmute/warn/temizle/kilit/slowmode\`
• \`/ticket panel/kapat\`
• \`/yetkiver kullanici: islem:\` — Kullanıcıya mod yetkisi ver (Owner/Admin)
• \`/yetkial kullanici: islem:\` — Mod yetkisini geri al (Owner/Admin)
• \`/yetki-liste\` — Sunucudaki yetki listesini gör

**Not:** Ban/Mute/Warn için önerilen yöntem artık \`/yetkiver\` ile doğrudan kullanıcıya yetki vermektir.
Rol bazlı yetkilendirme \`/setup\` üzerinden hâlâ çalışır (geriye dönük uyumluluk).

**Diğer**
• \`!owo-test\` — OWO kanal iznini test et
• \`/setup\` — Tüm bot ayarları`);
  }

  // ── OWO TEST ───────────────────────────────────────────────
  if (txt === '!owo-test') {
    const owoChId = getSetting(gid,'owo_game_channel');
    if (!owoChId) return message.reply('⛔ OwO kanalı ayarlanmamış. `/setup` ile ayarla.');
    return message.reply(cid===owoChId ? '✅ Bu kanalda OwO komutlarına izin var.' : `⛔ Bu kanalda OwO komutuna izin yok. Lütfen <#${owoChId}> kullan.`);
  }

  // ── OWNER MODERASYON KOMUTLARI ─────────────────────────────
  if (txt.startsWith('!ban')) {
    if (!hasOwnerAccess(uid, message.member)) return message.reply('⛔ Bu komutu sadece bot sahipleri kullanabilir.');
    const match = message.content.match(/^!ban\s+(\d{17,20})$/i);
    if (!match) return message.reply('Kullanım: `!ban <kullanıcıId>`');
    try {
      const me = message.guild.members.me;
      if (!me.permissions.has(PermissionFlagsBits.BanMembers)) return message.reply('⛔ Gerekli yetki yok: Üyeleri Yasakla');
      if (OWNERS.includes(match[1])) return message.reply('⛔ Owner\'ları banlayamam.');
      const mbr = await message.guild.members.fetch(match[1]).catch(()=>null);
      if (mbr && !mbr.bannable) return message.reply('⛔ Bu üyeyi banlayamıyorum (hiyerarşi/izin).');
      await message.guild.members.ban(match[1],{reason:`Owner ban: ${message.author.tag}`});
      return message.reply(`✅ <@${match[1]}> banlandı.`);
    } catch(e) { return message.reply('⛔ Ban işlemi başarısız oldu.'); }
  }

  if (txt.startsWith('!unban')) {
    if (!hasOwnerAccess(uid, message.member)) return message.reply('⛔ Bu komutu sadece bot sahipleri kullanabilir.');
    const match = message.content.match(/^!unban\s+(\d{17,20})$/i);
    if (!match) return message.reply('Kullanım: `!unban <kullanıcıId>`');
    try {
      const banEntry = await message.guild.bans.fetch(match[1]).catch(()=>null);
      if (!banEntry) return message.reply('ℹ️ Bu kullanıcı banlı görünmüyor.');
      await message.guild.members.unban(match[1],`Owner unban: ${message.author.tag}`);
      return message.reply(`✅ <@${match[1]}> kullanıcısının banı kaldırıldı.`);
    } catch { return message.reply('⛔ Unban başarısız oldu.'); }
  }

  if (txt.startsWith('!mute')) {
    const isOwner = hasOwnerAccess(uid, message.member);
    const isMod   = message.member?.permissions.has(PermissionFlagsBits.ModerateMembers);
    if (!isOwner && !isMod) return message.reply('⛔ Bu komutu kullanamazsın.');
    const match = message.content.match(/^!mute\s+(\d{17,20})\s+(\d{1,5})$/i);
    if (!match) return message.reply('Kullanım: `!mute <kullanıcıId> <dakika>`');
    const mins = Math.max(1,Math.min(43200,parseInt(match[2])));
    try {
      const me = message.guild.members.me;
      if (!me.permissions.has(PermissionFlagsBits.ModerateMembers)) return message.reply('⛔ Gerekli yetki: Üyeleri Zaman Aşımına Uğrat');
      if (OWNERS.includes(match[1])) return message.reply('⛔ Owner\'ları muteleyemem.');
      const mbr = await message.guild.members.fetch(match[1]).catch(()=>null);
      if (!mbr) return message.reply('⛔ Kullanıcı bulunamadı.');
      if (!mbr.moderatable) return message.reply('⛔ Bu üyeyi muteleyemiyorum.');
      await mbr.timeout(mins*60*1000,`Mute by ${message.author.tag}`);
      return message.reply(`✅ <@${match[1]}> **${mins} dakika** susturuldu.`);
    } catch { return message.reply('⛔ Mute başarısız oldu.'); }
  }

  if (txt.startsWith('!sohbet-sil')) {
    if (!hasOwnerAccess(uid, message.member)&&!message.member?.permissions.has(PermissionFlagsBits.ManageMessages)) return message.reply('⛔ Yetkin yok.');
    const match = txt.match(/^!sohbet-sil\s+(\d{1,3})$/);
    if (!match) return message.reply('Kullanım: `!sohbet-sil <adet>` (1–100)');
    const adet = Math.max(1,Math.min(100,parseInt(match[1])));
    const me = message.guild?.members?.me;
    if (!me?.permissionsIn(message.channel).has(PermissionFlagsBits.ManageMessages)) return message.reply('⛔ Gerekli yetki: Mesajları Yönet');
    try {
      const deleted = await message.channel.bulkDelete(adet,true);
      const info = await message.channel.send(`🧹 ${deleted.size} mesaj silindi.`);
      setTimeout(()=>info.delete().catch(()=>{}),5000);
    } catch { return message.reply('⛔ Silme başarısız (14 günden eski veya kanal tipi uyumsuz).'); }
  }

});

// ──────────────────────────────────────────────────────────────
//  INTERACTION CREATE (slash + buton + select menu)
// ──────────────────────────────────────────────────────────────
client.on('interactionCreate', async interaction => {
  try {

    // ── SETUP PANELİ AÇMA ──────────────────────────────────
    if (interaction.isChatInputCommand() && interaction.commandName === 'setup') {
      if (SETUP_CHANNEL && interaction.channelId !== SETUP_CHANNEL && !interaction.member?.permissions.has(PermissionFlagsBits.Administrator)) {
        return interaction.reply({content:`⛔ Setup sadece <#${SETUP_CHANNEL}> kanalında kullanılabilir.`,ephemeral:true});
      }
      return sendSetupPanel(interaction);
    }

    // ── SETUP BUTON / SELECT MENÜ ─────────────────────────
    if (interaction.isButton() || interaction.isAnySelectMenu()) {
      const [prefix, ...rest] = (interaction.customId||'').split('_');
      if (prefix === 'setup') return handleSetupInteraction(interaction, rest.join('_'));
    }

    // ── TICKET BUTONLARI ──────────────────────────────────
    if (interaction.isButton()) {
      const id = interaction.customId;
      if (id.startsWith('ticket_open_')) {
        const gid = interaction.guild.id;
        const uid = interaction.user.id;
        if (getOpenTicket(gid, uid)) return interaction.reply({content:'⛔ Zaten açık bir ticketın var.',ephemeral:true});
        const ticketRole = getSetting(gid,'ticket_role');
        const ticketCat  = getSetting(gid,'ticket_category');
        const ch = await interaction.guild.channels.create({
          name:`ticket-${interaction.user.username}`,
          type: ChannelType.GuildText,
          parent: ticketCat||undefined,
          permissionOverwrites:[
            {id:interaction.guild.roles.everyone,deny:[PermissionFlagsBits.ViewChannel]},
            {id:uid,allow:[PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages]},
            ...(ticketRole?[{id:ticketRole,allow:[PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages]}]:[]),
          ],
        });
        createTicket(gid,uid,ch.id);
        const closeRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`ticket_close_${ch.id}`).setLabel('Ticketı Kapat').setStyle(ButtonStyle.Danger).setEmoji('🔒')
        );
        await ch.send({content:`${interaction.user}, ticketın oluşturuldu! Bir yetkili yakında ilgilenecek.\n\nKapatmak için:`,components:[closeRow]});
        return interaction.reply({content:`✅ Ticket oluşturuldu: ${ch}`,ephemeral:true});
      }
      if (id.startsWith('ticket_close_')) {
        const chId = id.replace('ticket_close_','');
        closeTicket(chId);
        await interaction.reply({content:'🔒 Ticket kapatılıyor...'});
        setTimeout(()=>interaction.guild.channels.cache.get(chId)?.delete('Ticket kapatıldı').catch(()=>{}),3000);
        return;
      }
    }

    // ── SLASH KOMUTLARI ────────────────────────────────────
    if (!interaction.isChatInputCommand()) return;
    const gid = interaction.guild?.id;
    const uid = interaction.user.id;
    const cmd = interaction.commandName;
    const sub = interaction.options.getSubcommand?.(false)||null;

    // Kanal kısıtlaması — ownerlar hariç sadece KOMUT_KANALI
    if (!hasOwnerAccess(uid, interaction.member) && interaction.channelId !== KOMUT_KANALI) {
      return interaction.reply({ ephemeral: true, content: `⛔ Bu komutu sadece <#${KOMUT_KANALI}> kanalında kullanabilirsin.` });
    }

    // ── /yardim ─────────────────────────────────────────────
    if (cmd === 'yardim') {
      return interaction.reply({ephemeral:true, content:`📘 **DeathWish Bot Komut Listesi**

**Slash Komutları:**
• \`/mod ban/kick/mute/unmute/warn/gecmis/uyarilar/temizle/kilit/slowmode\`
• \`/info sunucu/kullanici\`
• \`/ticket panel/kapat\`
• \`/yetkiver kullanici: islem:\` — Kullanıcıya mod yetkisi ver
• \`/yetkial kullanici: islem:\` — Mod yetkisini geri al
• \`/yetki-liste\` — Sunucudaki yetki listesi
• \`/setup\` — Bot ayarları (admin)

**! Prefix Komutları:** \`!yardım\` yazarak tam listeyi gör.`});
    }

    // ── /mod ────────────────────────────────────────────────
    if (cmd === 'mod') {
      const target  = interaction.options.getUser('kullanici');
      const reason  = interaction.options.getString('sebep')||'Sebep belirtilmedi';
      const member2 = target ? await interaction.guild.members.fetch(target.id).catch(()=>null) : null;

      if (sub === 'ban') {
        if (!canModerateAction(interaction.member,'ban')) return interaction.reply({ephemeral:true,content:'⛔ Ban yetkisi yok.'});
        if (!member2?.bannable) return interaction.reply({ephemeral:true,content:'⛔ Bu üyeyi banlayamıyorum.'});
        await member2.ban({reason});
        addModAction(gid,target.id,uid,'ban',interaction.channelId,0,reason);
        const logEmbed = new EmbedBuilder().setTitle('🔨 Ban').setColor(0xED4245)
          .addFields(
            {name:'Kullanıcı',value:`${target.tag}`},
            {name:'Yetkili',value:`${interaction.user.tag}`},
            {name:'Sebep',value:reason}
          ).setTimestamp();
        await sendLog(interaction.guild,'mod_log_channel',logEmbed);
        const punishEmbed = new EmbedBuilder().setTitle('🔨 Ceza Aldı: Ban').setColor(0xED4245)
          .addFields(
            {name:'Kullanıcı',value:`<@${target.id}> (${target.tag})`},
            {name:'Ceza',value:'Ban'},
            {name:'Sebep',value:reason}
          ).setTimestamp();
        await sendLog(interaction.guild,'punishment_log_channel',punishEmbed);
        return interaction.reply(`✅ **${target.tag}** banlandı.`);
      }
      if (sub === 'kick') {
        if (!interaction.member.permissions.has(PermissionFlagsBits.KickMembers)) return interaction.reply({ephemeral:true,content:'⛔ Kick yetkisi yok.'});
        if (!member2?.kickable) return interaction.reply({ephemeral:true,content:'⛔ Bu üyeyi kickleyemiyorum.'});
        await member2.kick(reason);
        const logEmbed = new EmbedBuilder().setTitle('👢 Kick').setColor(0xFEE75C)
          .addFields(
            {name:'Kullanıcı',value:`${target.tag}`},
            {name:'Yetkili',value:`${interaction.user.tag}`},
            {name:'Sebep',value:reason}
          ).setTimestamp();
        await sendLog(interaction.guild,'mod_log_channel',logEmbed);
        return interaction.reply(`✅ **${target.tag}** kicklendi.`);
      }
      if (sub === 'mute') {
        const mins = interaction.options.getInteger('dakika');
        if (!canModerateAction(interaction.member,'mute')) return interaction.reply({ephemeral:true,content:'⛔ Mute yetkisi yok.'});
        if (!member2?.moderatable) return interaction.reply({ephemeral:true,content:'⛔ Bu üyeyi muteleyemiyorum.'});
        await member2.timeout(mins*60000,reason);
        addModAction(gid,target.id,uid,'mute',interaction.channelId,mins,reason);
        const logEmbed = new EmbedBuilder().setTitle('🔇 Mute').setColor(0xFEE75C)
          .addFields(
            {name:'Kullanıcı',value:`${target.tag}`},
            {name:'Süre',value:`${mins} dk`},
            {name:'Sebep',value:reason}
          ).setTimestamp();
        await sendLog(interaction.guild,'mod_log_channel',logEmbed);
        const punishEmbed = new EmbedBuilder().setTitle('🔇 Ceza Aldı: Mute').setColor(0xFEE75C)
          .addFields(
            {name:'Kullanıcı',value:`<@${target.id}> (${target.tag})`},
            {name:'Ceza',value:`Mute (${mins} dk)`},
            {name:'Sebep',value:reason}
          ).setTimestamp();
        await sendLog(interaction.guild,'punishment_log_channel',punishEmbed);
        return interaction.reply(`✅ **${target.tag}** **${mins} dk** susturuldu.`);
      }
      if (sub === 'unmute') {
        if (!canModerateAction(interaction.member,'unmute')) return interaction.reply({ephemeral:true,content:'⛔ Unmute yetkisi yok.'});
        if (!member2) return interaction.reply({ephemeral:true,content:'⛔ Kullanıcı bulunamadı.'});
        await member2.timeout(null);
        return interaction.reply(`✅ **${target.tag}** susturma kaldırıldı.`);
      }
      if (sub === 'warn') {
        if (!canModerateAction(interaction.member,'warn')) return interaction.reply({ephemeral:true,content:'⛔ Warn yetkisi yok.'});
        addWarn(gid,target.id,uid,reason);
        addModAction(gid,target.id,uid,'warn',interaction.channelId,0,reason);
        const warnCount = getWarns(gid,target.id).length;
        const logEmbed = new EmbedBuilder().setTitle('⚠️ Uyarı').setColor(0xFEE75C)
          .addFields(
            {name:'Kullanıcı',value:`${target.tag}`},
            {name:'Uyarı #',value:`${warnCount}`},
            {name:'Sebep',value:reason}
          ).setTimestamp();
        await sendLog(interaction.guild,'mod_log_channel',logEmbed);
        const punishEmbed = new EmbedBuilder().setTitle('⚠️ Ceza Aldı: Uyarı').setColor(0xFEE75C)
          .addFields(
            {name:'Kullanıcı',value:`<@${target.id}> (${target.tag})`},
            {name:'Ceza',value:`Uyarı (Toplam: ${warnCount})`},
            {name:'Sebep',value:reason}
          ).setTimestamp();
        await sendLog(interaction.guild,'punishment_log_channel',punishEmbed);
        return interaction.reply(`⚠️ **${target.tag}** uyarıldı. (Toplam uyarı: **${warnCount}**)`);
      }
      if (sub === 'uyarilar') {
        const warns2 = getWarns(gid,target.id);
        if (!warns2.length) return interaction.reply(`ℹ️ **${target.tag}** uyarısı yok.`);
        const list = warns2.slice(0,10).map((w,i)=>`**${i+1}.** ${w.reason} *(${w.createdAt})*`).join('\n');
        return interaction.reply({content:`⚠️ **${target.tag}** uyarıları:\n${list}`, ephemeral:true});
      }
      if (sub === 'uyari-sil') {
        clearWarns(gid,target.id);
        return interaction.reply(`✅ **${target.tag}** tüm uyarıları silindi.`);
      }
      if (sub === 'gecmis') {
        const sum = getModSummary(gid,target.id);
        if (!sum.rows.length) return interaction.reply({ephemeral:true,content:`ℹ️ **${target.tag}** için moderasyon geçmişi bulunamadı.`});
        const detay = sum.rows.slice(0,8).map(r=>{
          const tip = r.type==='warn' ? '⚠️ Uyarı' : r.type==='mute' ? `🔇 Mute (${r.minutes} dk)` : '🔨 Ban';
          return `**${tip}** — ${r.reason} *(${r.createdAt})*`;
        }).join('\n');
        const embed = new EmbedBuilder()
          .setTitle(`📁 ${target.tag} — Moderasyon Geçmişi`)
          .setColor(0x5865F2)
          .addFields(
            {name:'⚠️ Toplam Uyarı', value:`${sum.warnCount}`, inline:true},
            {name:'🔇 Toplam Mute', value:`${sum.muteCount}`, inline:true},
            {name:'⏱️ Toplam Mute Süresi', value:`${sum.totalMuteMinutes} dk`, inline:true},
            {name:'📜 Son İşlemler', value:detay||'—'}
          )
          .setTimestamp();
        return interaction.reply({embeds:[embed],ephemeral:true});
      }
      if (sub === 'temizle') {
        const adet = interaction.options.getInteger('adet');
        const deleted = await interaction.channel.bulkDelete(adet,true).catch(()=>({size:0}));
        return interaction.reply({ephemeral:true,content:`🧹 ${deleted.size} mesaj silindi.`});
      }
      if (sub === 'kilit') {
        await interaction.channel.permissionOverwrites.edit(interaction.guild.roles.everyone,{SendMessages:false});
        return interaction.reply('🔒 Kanal kilitlendi.');
      }
      if (sub === 'kilit-ac') {
        await interaction.channel.permissionOverwrites.edit(interaction.guild.roles.everyone,{SendMessages:null});
        return interaction.reply('🔓 Kanal kilidi açıldı.');
      }
      if (sub === 'slowmode') {
        const saniye = interaction.options.getInteger('saniye');
        await interaction.channel.setRateLimitPerUser(saniye);
        return interaction.reply(saniye===0?'✅ Yavaş mod kapatıldı.':`✅ Yavaş mod: **${saniye} saniye**`);
      }
    }

    // ── /info ────────────────────────────────────────────────
    if (cmd === 'info') {
      if (sub === 'sunucu') {
        const g = interaction.guild;
        const embed = new EmbedBuilder()
          .setTitle(g.name)
          .setThumbnail(g.iconURL())
          .setColor(0x5865F2)
          .addFields(
            {name:'👥 Üye', value:`${g.memberCount}`, inline:true},
            {name:'📅 Oluşturuldu', value:`<t:${Math.floor(g.createdTimestamp/1000)}:R>`, inline:true},
            {name:'👑 Sahip', value:`<@${g.ownerId}>`, inline:true}
          )
          .setTimestamp();
        return interaction.reply({embeds:[embed]});
      }
      if (sub === 'kullanici') {
        const target = interaction.options.getUser('hedef')||interaction.user;
        const mbr = await interaction.guild.members.fetch(target.id).catch(()=>null);
        const embed = new EmbedBuilder()
          .setTitle(target.username)
          .setThumbnail(target.displayAvatarURL({size:256}))
          .setColor(0x5865F2)
          .addFields(
            {name:'🆔 ID', value:target.id},
            {name:'📅 Katılım', value:mbr?`<t:${Math.floor(mbr.joinedTimestamp/1000)}:R>`:'?'}
          )
          .setTimestamp();
        return interaction.reply({embeds:[embed]});
      }
    }

    // ── /ticket ──────────────────────────────────────────────
    if (cmd === 'ticket') {
      if (sub === 'panel') {
        if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) return interaction.reply({ephemeral:true,content:'⛔ Yetkin yok.'});
        const targetCh = interaction.options.getChannel('kanal') || interaction.channel;
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('ticket_open_1').setLabel('🎫 Ticket Aç').setStyle(ButtonStyle.Primary)
        );
        await targetCh.send({content:'📩 **Destek Talebi**\nBir sorun mu var? Aşağıdaki butona basarak ticket açabilirsin.',components:[row]});
        return interaction.reply({ephemeral:true,content:`✅ Ticket paneli ${targetCh} kanalına gönderildi.`});
      }
      if (sub === 'kapat') {
        closeTicket(interaction.channelId);
        await interaction.reply({content:'🔒 Ticket kapatılıyor...'});
        setTimeout(()=>interaction.channel.delete('Ticket kapatıldı').catch(()=>{}),3000);
        return;
      }
    }

    // ── /yetkiver ────────────────────────────────────────────
    if (cmd === 'yetkiver') {
      if (!hasOwnerAccess(uid, interaction.member) && !interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
        return interaction.reply({ephemeral:true,content:'⛔ Bu komutu sadece Owner veya Administrator kullanabilir.'});
      }
      const target = interaction.options.getUser('kullanici');
      const action = interaction.options.getString('islem');
      if (action === 'hepsi') {
        for (const a of ['ban','mute','warn','unmute']) grantModPermission(gid,target.id,a);
        grantModPermission(gid,target.id,'hepsi');
      } else {
        grantModPermission(gid,target.id,action);
      }
      const embed = new EmbedBuilder()
        .setTitle('✅ Moderasyon Yetkisi Verildi')
        .setColor(0x57F287)
        .addFields(
          {name:'👤 Kullanıcı', value:`<@${target.id}> (${target.tag})`},
          {name:'🔑 Verilen Yetki', value:action === 'hepsi' ? 'Ban, Mute, Warn, Unmute (Hepsi)' : action}
        )
        .setFooter({text:`Yetkiyi veren: ${interaction.user.tag}`})
        .setTimestamp();
      return interaction.reply({embeds:[embed]});
    }

    // ── /yetkial ─────────────────────────────────────────────
    if (cmd === 'yetkial') {
      if (!hasOwnerAccess(uid, interaction.member) && !interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
        return interaction.reply({ephemeral:true,content:'⛔ Bu komutu sadece Owner veya Administrator kullanabilir.'});
      }
      const target = interaction.options.getUser('kullanici');
      const action = interaction.options.getString('islem');
      if (action === 'hepsi') {
        for (const a of ['ban','mute','warn','unmute','hepsi']) revokeModPermission(gid,target.id,a);
      } else {
        revokeModPermission(gid,target.id,action);
      }
      const embed = new EmbedBuilder()
        .setTitle('🗑️ Moderasyon Yetkisi Alındı')
        .setColor(0xED4245)
        .addFields(
          {name:'👤 Kullanıcı', value:`<@${target.id}> (${target.tag})`},
          {name:'🔑 Alınan Yetki', value:action === 'hepsi' ? 'Tüm yetkiler' : action}
        )
        .setFooter({text:`Yetkiyi alan: ${interaction.user.tag}`})
        .setTimestamp();
      return interaction.reply({embeds:[embed]});
    }

    // ── /yetki-liste ─────────────────────────────────────────
    if (cmd === 'yetki-liste') {
      const perms = getAllModPermissions(gid);
      if (!perms.length) return interaction.reply({ephemeral:true,content:'ℹ️ Bu sunucuda kullanıcı bazlı mod yetkisi bulunmuyor.'});
      // Kullanıcı bazında grupla
      const byUser = {};
      for (const p of perms) {
        if (!byUser[p.userId]) byUser[p.userId] = [];
        byUser[p.userId].push(p.action);
      }
      const lines = Object.entries(byUser).map(([userId, actions]) =>
        `<@${userId}> → **${actions.join(', ')}**`
      );
      const embed = new EmbedBuilder()
        .setTitle('🛡️ Kullanıcı Bazlı Moderasyon Yetkileri')
        .setColor(0x5865F2)
        .setDescription(lines.slice(0,20).join('\n'))
        .setFooter({text:`Toplam ${Object.keys(byUser).length} kullanıcı`})
        .setTimestamp();
      return interaction.reply({embeds:[embed], ephemeral:true});
    }

  } catch (e) {
    console.error('interactionCreate hatası:', e);
    try { if (!interaction.replied&&!interaction.deferred) await interaction.reply({content:'⛔ Bir hata oluştu.',ephemeral:true}); } catch {}
  }
});

// ──────────────────────────────────────────────────────────────
//  SETUP PANELİ
// ──────────────────────────────────────────────────────────────
async function sendSetupPanel(interaction) {
  const gid = interaction.guild.id;
  const s   = getAllSettings(gid);
  const fmt  = key => s[key] ? `<#${s[key]}>` : '_(ayarlanmamış)_';
  const fmtR = key => s[key] ? `<@&${s[key]}>` : '_(ayarlanmamış)_';
  const embed = new EmbedBuilder()
    .setTitle('⚙️ DeathWish Bot Ayar Paneli')
    .setColor(0x5865F2)
    .setDescription('Aşağıdaki menüden ayarlamak istediğin bölümü seç.\n\n**💡 Moderasyon Yetki Önerisi:**\nRol bazlı yetkilendirme yerine `/yetkiver` komutu ile doğrudan kullanıcıya yetki verin.')
    .addFields(
      {name:'📢 Karşılama', value:`Kanal: ${fmt('welcome_channel')}\nOto Rol: ${fmtR('welcome_auto_role')}`},
      {name:'🚪 Ayrılma', value:`Kanal: ${fmt('leave_channel')}`},
      {name:'📋 Log Kanalları', value:`Mesaj: ${fmt('log_message_channel')}\nBan: ${fmt('log_ban_channel')}\nSes: ${fmt('log_voice_channel')}\nÜye: ${fmt('log_member_channel')}`},
      {name:'🦜 OWO / Sohbet', value:`OWO Kanalı: ${fmt('owo_game_channel')}\nSohbet Koruma: ${fmt('sohbet_channel')}`},
      {name:'🎫 Ticket', value:`Kanal: ${fmt('ticket_channel')}\nRol: ${fmtR('ticket_role')}`},
      {name:'⚖️ Mod Log / Ceza Bildirim', value:`Mod Log: ${fmt('mod_log_channel')}\nCeza Bildirim: ${fmt('punishment_log_channel')}`},
      {name:'🛡️ Mod Yetkili Rolleri (eski)', value:`Ban: ${fmtR('ban_mod_role')}\nMute: ${fmtR('mute_mod_role')}\nWarn: ${fmtR('warn_mod_role')}\n_Öneri: \`/yetkiver\` kullanın_`}
    );
  const menu = new StringSelectMenuBuilder()
    .setCustomId('setup_category')
    .setPlaceholder('Ayarlamak istediğin bölümü seç...')
    .addOptions([
      {label:'📢 Karşılama Kanalı',       value:'welcome_channel',        description:'Karşılama mesajı kanalını ayarla'},
      {label:'👋 Oto Rol',                value:'welcome_auto_role',       description:'Yeni üyelere verilecek oto rol'},
      {label:'🚪 Ayrılma Kanalı',          value:'leave_channel',           description:'Ayrılma mesajı kanalını ayarla'},
      {label:'🦜 OWO Kanalı',             value:'owo_game_channel',         description:'w daily vb. izin verilen kanal'},
      {label:'🔒 Sohbet Koruma Kanalı',   value:'sohbet_channel',           description:'Silinirse koruma tetiklenen kanal'},
      {label:'🗑️ Mesaj Silme Logu',        value:'log_message_channel',     description:'Silinen mesaj log kanalı'},
      {label:'🔨 Ban Logu',                value:'log_ban_channel',          description:'Ban log kanalı'},
      {label:'🎙️ Ses Logu',               value:'log_voice_channel',        description:'Ses logu kanalı'},
      {label:'👥 Üye Logu',               value:'log_member_channel',       description:'Üye katılım/ayrılma logu'},
      {label:'⚖️ Mod Log Kanalı',          value:'mod_log_channel',          description:'Moderasyon log kanalı'},
      {label:'📣 Ceza Bildirim Kanalı',    value:'punishment_log_channel',   description:'Ban/Mute/Uyarı bildirim kanalı'},
      {label:'🔨 Ban Yetkili Rolü',        value:'ban_mod_role',             description:'(Eski) /mod ban için yetkili rol'},
      {label:'🔇 Mute Yetkili Rolü',       value:'mute_mod_role',            description:'(Eski) /mod mute için yetkili rol'},
      {label:'⚠️ Warn Yetkili Rolü',       value:'warn_mod_role',            description:'(Eski) /mod warn için yetkili rol'},
      {label:'🎫 Ticket Kanalı',           value:'ticket_channel',           description:'Ticket paneli kanalı'},
      {label:'🛡️ Ticket Rolü',            value:'ticket_role',              description:'Ticket erişim rolü'},
    ]);
  const row = new ActionRowBuilder().addComponents(menu);
  return interaction.reply({embeds:[embed],components:[row],ephemeral:true});
}

async function handleSetupInteraction(interaction, key) {
  if (key === 'category') {
    const val = interaction.values[0];
    const isRole = ['welcome_auto_role','ticket_role','ban_mod_role','mute_mod_role','warn_mod_role'].includes(val);
    if (isRole) {
      const menu2 = new RoleSelectMenuBuilder().setCustomId(`setup_setRole_${val}`).setPlaceholder('Rol seç...');
      return interaction.update({content:`**${val}** için rol seç:`,components:[new ActionRowBuilder().addComponents(menu2)],embeds:[]});
    }
    const menu2 = new ChannelSelectMenuBuilder().setCustomId(`setup_setChannel_${val}`).setPlaceholder('Kanal seç...').addChannelTypes(ChannelType.GuildText);
    return interaction.update({content:`**${val}** için kanal seç:`,components:[new ActionRowBuilder().addComponents(menu2)],embeds:[]});
  }
  if (key.startsWith('setChannel_')) {
    const settingKey = key.replace('setChannel_','');
    const chId = interaction.values[0];
    setSetting(interaction.guild.id, settingKey, chId);
    return interaction.update({content:`✅ **${settingKey}** → <#${chId}> olarak ayarlandı.`,components:[],embeds:[]});
  }
  if (key.startsWith('setRole_')) {
    const settingKey = key.replace('setRole_','');
    const roleId = interaction.values[0];
    setSetting(interaction.guild.id, settingKey, roleId);
    return interaction.update({content:`✅ **${settingKey}** → <@&${roleId}> olarak ayarlandı.`,components:[],embeds:[]});
  }
}

// ──────────────────────────────────────────────────────────────
//  HATA YÖNETİMİ + WatchDog EVENT HANDLER'LARI (BİRLEŞTİRİLMİŞ)
// ──────────────────────────────────────────────────────────────
client.on('shardError',        e      => console.error('🔌 ShardError:', e));
client.on('error',             e      => { lastError = e.message; console.error('🧨 Client error:', e); });
client.on('warn',              m      => console.warn('⚠️ Warn:', m));
client.on('resume',            ()     => console.log('🔁 Session resumed'));
client.on('shardDisconnect',   (ev,id)=> { console.warn(`🔌 Shard ${id} bağlantı koptu`); console.log(ev); });
client.on('shardReconnecting', id     => console.log(`♻️ Shard ${id} yeniden bağlanıyor...`));
client.on('shardReady',        id     => { lastHeartbeat = Date.now(); console.log(`✅ Shard ${id} hazır`); });
client.on('shardResume',       ()     => { lastHeartbeat = Date.now(); console.log('🟢 Discord bağlantısı geri geldi.'); });

process.on('unhandledRejection', r => { lastError = r?.message || String(r); console.error('UnhandledRejection:', r); });
process.on('uncaughtException',  e => { lastError = e.message; console.error('UncaughtException:', e); });

// ──────────────────────────────────────────────────────────────
//  🩺 WatchDog v1 — 30 Saniyede Bir Durum Raporu
// ──────────────────────────────────────────────────────────────
setInterval(() => {

  const mem  = process.memoryUsage().rss / 1024 / 1024;
  const ping = client.ws.ping;

  console.clear();

  console.log('══════════════════════════════');
  console.log('🩺 DeathWish Doktor');
  console.log('══════════════════════════════');

  console.log('Bot:', client.isReady() ? '🟢 Online' : '🔴 Offline');

  console.log('Ping:', ping + ' ms');

  console.log('RAM:', mem.toFixed(1) + ' MB');

  console.log('Event Loop:',
      (loop.mean / 1e6).toFixed(2) + ' ms');

  console.log('Son Hata:', lastError);

  console.log('Guild:', client.guilds.cache.size);

  console.log('User:', client.users.cache.size);

  if (Date.now() - lastHeartbeat > 60000) {
    console.log('\n🚨 UYARI!');
    console.log('60 saniyedir Discord Heartbeat alınamıyor!');
    console.log('Bot kilitlenmiş veya Gateway bağlantısı kopmuş olabilir.');
  }

  if (mem > 450)
    console.log('⚠ RAM kritik seviyede.');

  if (ping > 250)
    console.log('⚠ Discord pingi yüksek.');

  if ((loop.mean / 1e6) > 100)
    console.log('⚠ Event Loop yavaşladı.');

  console.log('══════════════════════════════');

}, 30000);

// ──────────────────────────────────────────────────────────────
//  GÜVENLİ LOGIN
// ──────────────────────────────────────────────────────────────
async function startBot() {
  try {
    console.log('🔑 Login deneniyor...');
    await client.login(TOKEN);
    console.log('✅ Login başarılı!');
    startAutoBackup();
  } catch (err) {
    console.error('⛔ Login başarısız! 15 sn sonra tekrar denenecek.\nHata:', err?.message||err);
    setTimeout(startBot, 15_000);
  }
}

// ──────────────────────────────────────────────────────────────
//  BOOTSTRAP: önce GitHub'dan restore, sonra DB aç, sonra bota gir
// ──────────────────────────────────────────────────────────────
(async () => {
  await restoreDatabase();
  initDatabase();
  await startBot();
})();
