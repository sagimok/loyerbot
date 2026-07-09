// ╔══════════════════════════════════════════════════════════════╗
// ║         DeathWish Bot v3.0 — TEK DOSYA (TAM VERSİYON)      ║
// ║  • Tüm ayarlar Discord üzerinden /setup ile yapılır         ║
// ║  • Hiçbir kanal/rol ID'si hardcoded değil                   ║
// ║  • Çok sunuculu (guildId her yerde)                         ║
// ║  • SQLite ile kalıcı veri + JSON fallback                   ║
// ╚══════════════════════════════════════════════════════════════╝

require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const {
  Client, GatewayIntentBits, Collection, ActivityType, REST, Routes,
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, ChannelSelectMenuBuilder, RoleSelectMenuBuilder,
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
// NOT: db burada henüz açılmıyor. GitHub'dan restore işlemi bitmeden
// SQLite açılmasın diye `db`, aşağıdaki initDatabase() içinde atanıyor.
// initDatabase() çağrısı bu dosyanın en altındaki bootstrap() içinde,
// restoreDatabase() tamamlandıktan SONRA yapılıyor.
let db;

function initDatabase() {
  db = new Database(DB_PATH);
  db.exec(`
    CREATE TABLE IF NOT EXISTS guild_settings (guildId TEXT, key TEXT, value TEXT, PRIMARY KEY(guildId,key));
    CREATE TABLE IF NOT EXISTS economy (guildId TEXT, userId TEXT, balance INTEGER DEFAULT 0, bank INTEGER DEFAULT 0, PRIMARY KEY(guildId,userId));
    CREATE TABLE IF NOT EXISTS marriages (guildId TEXT, user1 TEXT, user2 TEXT, marriedAt TEXT, PRIMARY KEY(guildId,user1));
    CREATE TABLE IF NOT EXISTS rings (guildId TEXT, userId TEXT, PRIMARY KEY(guildId,userId));
    CREATE TABLE IF NOT EXISTS voice_time (guildId TEXT, userId TEXT, totalSeconds INTEGER DEFAULT 0, PRIMARY KEY(guildId,userId));
    CREATE TABLE IF NOT EXISTS daily_claims (guildId TEXT, userId TEXT, date TEXT, claimType TEXT, PRIMARY KEY(guildId,userId,date,claimType));
    CREATE TABLE IF NOT EXISTS daily_counts (guildId TEXT, userId TEXT, date TEXT, claimType TEXT, count INTEGER DEFAULT 0, PRIMARY KEY(guildId,userId,date,claimType));
    CREATE TABLE IF NOT EXISTS xp_boosts (guildId TEXT, userId TEXT, PRIMARY KEY(guildId,userId));
    CREATE TABLE IF NOT EXISTS warns (id INTEGER PRIMARY KEY AUTOINCREMENT, guildId TEXT, userId TEXT, moderatorId TEXT, reason TEXT, createdAt TEXT);
    CREATE TABLE IF NOT EXISTS message_counts (guildId TEXT, channelId TEXT, userId TEXT, date TEXT, count INTEGER DEFAULT 0, PRIMARY KEY(guildId,channelId,userId,date));
    CREATE TABLE IF NOT EXISTS market_roles (guildId TEXT, roleId TEXT, price INTEGER, isPremium INTEGER DEFAULT 0, PRIMARY KEY(guildId,roleId));
    CREATE TABLE IF NOT EXISTS level_data (guildId TEXT, userId TEXT, xp INTEGER DEFAULT 0, level INTEGER DEFAULT 0, PRIMARY KEY(guildId,userId));
    CREATE TABLE IF NOT EXISTS tickets (id INTEGER PRIMARY KEY AUTOINCREMENT, guildId TEXT, userId TEXT, channelId TEXT, status TEXT DEFAULT 'open', createdAt TEXT);
    CREATE TABLE IF NOT EXISTS mod_actions (id INTEGER PRIMARY KEY AUTOINCREMENT, guildId TEXT, userId TEXT, moderatorId TEXT, type TEXT, channelId TEXT, minutes INTEGER DEFAULT 0, reason TEXT, createdAt TEXT);
  `);
  console.log('✅ Veritabanı hazır.');
}

// ── DB yardımcıları ───────────────────────────────────────────
function getSetting(gid, key)          { const r = db.prepare('SELECT value FROM guild_settings WHERE guildId=? AND key=?').get(gid,key); return r?r.value:null; }
function setSetting(gid, key, value)   { db.prepare('INSERT OR REPLACE INTO guild_settings (guildId,key,value) VALUES(?,?,?)').run(gid,key,value); }
function getAllSettings(gid)            { const rows = db.prepare('SELECT key,value FROM guild_settings WHERE guildId=?').all(gid); const o={}; for(const r of rows) o[r.key]=r.value; return o; }

function getBalance(gid,uid)           { return db.prepare('SELECT balance,bank FROM economy WHERE guildId=? AND userId=?').get(gid,uid)||{balance:0,bank:0}; }
function addBalance(gid,uid,amt)       { db.prepare('INSERT OR IGNORE INTO economy(guildId,userId,balance,bank)VALUES(?,?,0,0)').run(gid,uid); db.prepare('UPDATE economy SET balance=MAX(0,balance+?) WHERE guildId=? AND userId=?').run(amt,gid,uid); return getBalance(gid,uid); }
function addBank(gid,uid,amt)          { db.prepare('INSERT OR IGNORE INTO economy(guildId,userId,balance,bank)VALUES(?,?,0,0)').run(gid,uid); db.prepare('UPDATE economy SET bank=MAX(0,bank+?) WHERE guildId=? AND userId=?').run(amt,gid,uid); return getBalance(gid,uid); }
function setBalance(gid,uid,amt)       { db.prepare('INSERT OR IGNORE INTO economy(guildId,userId,balance,bank)VALUES(?,?,0,0)').run(gid,uid); db.prepare('UPDATE economy SET balance=MAX(0,?) WHERE guildId=? AND userId=?').run(amt,gid,uid); return getBalance(gid,uid); }
function transfer(gid,from,to,amt)     { if(getBalance(gid,from).balance<amt) return false; addBalance(gid,from,-amt); addBalance(gid,to,amt); return true; }
function topBalance(gid,n=10)          { return db.prepare('SELECT userId,balance FROM economy WHERE guildId=? ORDER BY balance DESC LIMIT ?').all(gid,n); }

function getMarriage(gid,uid)          { return db.prepare('SELECT * FROM marriages WHERE guildId=? AND (user1=? OR user2=?)').get(gid,uid,uid); }
function setMarriage(gid,u1,u2)        { const now=nowTR(); db.prepare('INSERT OR IGNORE INTO marriages(guildId,user1,user2,marriedAt)VALUES(?,?,?,?)').run(gid,u1,u2,now); db.prepare('INSERT OR IGNORE INTO marriages(guildId,user1,user2,marriedAt)VALUES(?,?,?,?)').run(gid,u2,u1,now); }
function removeMarriage(gid,uid)       { const m=getMarriage(gid,uid); if(!m)return; db.prepare('DELETE FROM marriages WHERE guildId=? AND (user1=? OR user2=? OR user1=? OR user2=?)').run(gid,m.user1,m.user1,m.user2,m.user2); }
function allMarriages(gid)             { const seen=new Set(); return db.prepare('SELECT * FROM marriages WHERE guildId=?').all(gid).filter(r=>{const k=[r.user1,r.user2].sort().join(':'); if(seen.has(k))return false; seen.add(k); return true;}); }
function hasRing(gid,uid)              { return !!db.prepare('SELECT 1 FROM rings WHERE guildId=? AND userId=?').get(gid,uid); }
function giveRing(gid,uid)             { db.prepare('INSERT OR IGNORE INTO rings(guildId,userId)VALUES(?,?)').run(gid,uid); }
function consumeRing(gid,uid)          { db.prepare('DELETE FROM rings WHERE guildId=? AND userId=?').run(gid,uid); }

function addVoiceTime(gid,uid,secs)    { db.prepare('INSERT OR IGNORE INTO voice_time(guildId,userId,totalSeconds)VALUES(?,?,0)').run(gid,uid); db.prepare('UPDATE voice_time SET totalSeconds=totalSeconds+? WHERE guildId=? AND userId=?').run(secs,gid,uid); }
function getVoiceTime(gid,uid)         { const r=db.prepare('SELECT totalSeconds FROM voice_time WHERE guildId=? AND userId=?').get(gid,uid); return r?r.totalSeconds:0; }
function topVoice(gid,n=10)            { return db.prepare('SELECT userId,totalSeconds FROM voice_time WHERE guildId=? ORDER BY totalSeconds DESC LIMIT ?').all(gid,n); }
function resetVoice(gid)               { db.prepare('DELETE FROM voice_time WHERE guildId=?').run(gid); }

function hasClaimed(gid,uid,date,type) { return !!db.prepare('SELECT 1 FROM daily_claims WHERE guildId=? AND userId=? AND date=? AND claimType=?').get(gid,uid,date,type); }
function setClaimed(gid,uid,date,type) { db.prepare('INSERT OR IGNORE INTO daily_claims(guildId,userId,date,claimType)VALUES(?,?,?,?)').run(gid,uid,date,type); }
function getDailyCount(gid,uid,date,type) { const r=db.prepare('SELECT count FROM daily_counts WHERE guildId=? AND userId=? AND date=? AND claimType=?').get(gid,uid,date,type); return r?r.count:0; }
function incDailyCount(gid,uid,date,type,n=1) { db.prepare('INSERT OR IGNORE INTO daily_counts(guildId,userId,date,claimType,count)VALUES(?,?,?,?,0)').run(gid,uid,date,type); db.prepare('UPDATE daily_counts SET count=count+? WHERE guildId=? AND userId=? AND date=? AND claimType=?').run(n,gid,uid,date,type); return getDailyCount(gid,uid,date,type); }

function hasBoost(gid,uid)             { return !!db.prepare('SELECT 1 FROM xp_boosts WHERE guildId=? AND userId=?').get(gid,uid); }
function setBoost(gid,uid)             { db.prepare('INSERT OR IGNORE INTO xp_boosts(guildId,userId)VALUES(?,?)').run(gid,uid); }

function addWarn(gid,uid,modId,reason) { db.prepare('INSERT INTO warns(guildId,userId,moderatorId,reason,createdAt)VALUES(?,?,?,?,?)').run(gid,uid,modId,reason,nowTR()); }
function getWarns(gid,uid)             { return db.prepare('SELECT * FROM warns WHERE guildId=? AND userId=? ORDER BY createdAt DESC').all(gid,uid); }
function clearWarns(gid,uid)           { db.prepare('DELETE FROM warns WHERE guildId=? AND userId=?').run(gid,uid); }

// ── Moderasyon yetki + geçmiş sistemi ─────────────────────────
// Ban/Mute/Warn kararını SADECE bu role sahip kişiler (+Administrator) verebilir.
const MOD_PERMISSION_ROLE_ID = '1524107651510702160';
// Belirli işlemler (ban/mute/warn/unmute) için ayrı ayrı yetki rolleri.
// Setup panelinden "Ban Yetkili Rolü", "Mute Yetkili Rolü", "Warn Yetkili Rolü" ile ayarlanır.
// Bir kişi/rol hem ban hem mute hem warn rolüne aynı anda sahip olabilir (aynı role birden fazla yetki verilebilir).
// Herhangi biri ayarlanmamışsa, o işlem için eski tek genel rol (MOD_PERMISSION_ROLE_ID) kullanılır (geriye dönük uyumluluk).
const MOD_ACTION_SETTING_KEYS = {
  ban:    'ban_mod_role',
  mute:   'mute_mod_role',
  warn:   'warn_mod_role',
  unmute: 'mute_mod_role',
};
function canModerateAction(member, action) {
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
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

function addMsgCount(gid,cid,uid,date) { db.prepare('INSERT OR IGNORE INTO message_counts(guildId,channelId,userId,date,count)VALUES(?,?,?,?,0)').run(gid,cid,uid,date); db.prepare('UPDATE message_counts SET count=count+1 WHERE guildId=? AND channelId=? AND userId=? AND date=?').run(gid,cid,uid,date); }
function getMsgCount(gid,cid,uid,date) { const r=db.prepare('SELECT count FROM message_counts WHERE guildId=? AND channelId=? AND userId=? AND date=?').get(gid,cid,uid,date); return r?r.count:0; }
function topMsgs(gid,cid,date,n=10)   { return db.prepare('SELECT userId,count FROM message_counts WHERE guildId=? AND channelId=? AND date=? ORDER BY count DESC LIMIT ?').all(gid,cid,date,n); }
function resetSohbet(gid)              { db.prepare('DELETE FROM message_counts WHERE guildId=?').run(gid); }

function getMarketRoles(gid)           { return db.prepare('SELECT * FROM market_roles WHERE guildId=?').all(gid); }
function addMarketRole(gid,rid,price,prem) { db.prepare('INSERT OR REPLACE INTO market_roles(guildId,roleId,price,isPremium)VALUES(?,?,?,?)').run(gid,rid,price,prem?1:0); }
function removeMarketRole(gid,rid)     { db.prepare('DELETE FROM market_roles WHERE guildId=? AND roleId=?').run(gid,rid); }

function getLevel(gid,uid)             { return db.prepare('SELECT xp,level FROM level_data WHERE guildId=? AND userId=?').get(gid,uid)||{xp:0,level:0}; }
// Seviye başına gereken XP %15 azaltıldı (seviye atlamak daha kolay).
function addXp(gid,uid,amt)            { db.prepare('INSERT OR IGNORE INTO level_data(guildId,userId,xp,level)VALUES(?,?,0,0)').run(gid,uid); db.prepare('UPDATE level_data SET xp=xp+? WHERE guildId=? AND userId=?').run(amt,gid,uid); const d=getLevel(gid,uid); const needed=Math.round((d.level+1)*100*0.85); if(d.xp>=needed){db.prepare('UPDATE level_data SET level=level+1,xp=xp-? WHERE guildId=? AND userId=?').run(needed,gid,uid); return{leveled:true,newLevel:d.level+1};} return{leveled:false}; }
function topLevels(gid,n=10)           { return db.prepare('SELECT userId,level,xp FROM level_data WHERE guildId=? ORDER BY level DESC,xp DESC LIMIT ?').all(gid,n); }

// Seviye ödül rolleri: belirli seviyelere ulaşınca otomatik rol verilir.
const LEVEL_ROLE_REWARDS = {
  5:  '1524109066929045626',
  10: '1524109231719190678',
  20: '1524110815907811609',
  25: '1524112620976869446',
  30: '1524885044055773345',
  40: '1524885000112177203',
  50: '1524112044796805152',
};

function getOpenTicket(gid,uid)        { return db.prepare("SELECT * FROM tickets WHERE guildId=? AND userId=? AND status='open'").get(gid,uid); }
function createTicket(gid,uid,cid)     { db.prepare('INSERT INTO tickets(guildId,userId,channelId,status,createdAt)VALUES(?,?,?,?,?)').run(gid,uid,cid,'open',nowTR()); }
function closeTicket(cid)              { db.prepare("UPDATE tickets SET status='closed' WHERE channelId=?").run(cid); }

function todayTR()   { return new Date().toLocaleDateString('tr-TR',{timeZone:'Europe/Istanbul'}).split('.').reverse().join('-'); }
function nowTR()     { return new Date().toLocaleString('tr-TR',{timeZone:'Europe/Istanbul'}); }
function fmtVoice(s) { return `${Math.floor(s/3600)}sa ${Math.floor((s%3600)/60)}dk ${s%60}sn`; }
function fmtMin(s)   { return `${Math.floor(s/60)} dk ${s%60} sn`; }
function pick(arr)   { return arr[Math.floor(Math.random()*arr.length)]; }
function trL(s)      { return (s||'').toLocaleLowerCase('tr').trim(); }

// İstanbul saat aralığı kontrolü (13:00 – 03:59)
function isWithinIstanbulWindow() {
  const h = (new Date().getUTCHours() + 3) % 24;
  return h >= 13 || h < 4;
}

// ──────────────────────────────────────────────────────────────
//  SOHBET VERİLERİ — TAM LİSTE
// ──────────────────────────────────────────────────────────────
const ESPIRILER = [
  'Bilim insanları diyor ki: Uykusuzluk hafızayı bozar. Ben de o yüzden dün gece… ne diyordum ben?',
  'Bir balinanın kalbi insan kadar ağır olabilir. Yani kalbi kırılan tek tür biz değiliz.',
  'Işık sesten hızlıdır; o yüzden bazı insanlar parlak görünür ama konuşunca her şey ortaya çıkar.',
  'Arılar dans ederek haberleşir. Ben de kahve içince benzer bir protokole geçiyorum: titreyerek anlaşıyorum.',
  'Mars\'ta gün 24 saat 39 dakikadır. Yani geç kalmalarım bilimsel temellidir hocam.',
  'İnsan beyni günde yaklaşık 60 bin düşünce üretir. Benimkiler genelde "şifre neydi?" ile meşgul.',
  'Ahtapotların üç kalbi vardır. Benimki ise fatura gününde üç kez duruyor.',
  'Kediler günde 12–16 saat uyur. Verimlilik tanrıları şu an gözyaşı döküyor.',
  'Muzlar hafif radyoaktiftir; en tehlikelisi ısırıldığında biten potasyumdur.',
  'Satürn suya konsa yüzerdi. Keşke bütçem de bu kadar hafif olsa.',
  'Tavuklar insan yüzlerini ayırt edebilir. Market çıkışında indirimi kim yakalamış, biliyorlar.',
  'Şimşek, Güneş yüzeyinden daha sıcaktır. Ama elektrik faturasını görünce ben soğuyorum.',
  'Sümüklüböceklerin tuzla arası iyi değildir. Benim de ay sonuyla.',
  'Yunuslar isimleriyle çağrılabilir. Benim çağrıma sadece Wi-Fi cevap veriyor.',
  'Yıldızlar gördüğünde geçmişi görürsün. Spor salonunda da geçmiş formumu arıyorum.',
  'Japonya\'da makineler kola verir, kalbim ise umut… bazen bozuk para üstünü veremiyor.',
  'Karıncalar ağırlıklarının katlarını kaldırabilir. Ben de dertlerimin… bazen kaldıramıyorum.',
  'Kahve, performansı artırır; bende artırdığı şey konuşma hızım.',
  'İnsan vücudundaki kemiklerin yarısı eller ve ayaklardadır. Benim kodlarımın yarısı ise yorum satırı.',
  'Suyun %70\'i Dünya\'yı kaplar; kalan %30\'u WhatsApp grupları.',
  'Bal arıları dans ederek yön tarif eder. Ben Google Maps ile bile kayboluyorum.',
  'Zürafaların ses telleri var ama nadir kullanırlar. Ben de alarmı kapatınca öyleyim.',
  'Kutup ayılarının derisi siyahtır; ben de faturaları görünce kararıyorum.',
  'Dünya her saniye 11 km hızla döner; iş günü ise yerinde sayıyor gibi.',
  'Bir bulut tonlarca ağırlık taşıyabilir; ben ise "son bir bölüm daha"yı.',
  'Soğan doğrarken göz yaşartır; dolar kurunu görünce de etkisi benzer.',
  'Timsahlar dili dışarı çıkaramaz; ben de diyete başlayamıyorum.',
  'Gözlerimiz burnumuzu görür ama beyin filtreler; ben de hataları prod\'da fark ediyorum.',
  'Kelebekler ayaklarıyla tat alır; ben aklımla tatlıyı haklı çıkarıyorum.',
  'Ay\'da rüzgâr yok; bayraklar yine de gönlümüzde dalgalanıyor.',
];

const PERSONAL_RESPONSES = [
  { key:'ne yapıyorsun',         answers:['Kodlarıma bakıyordum ama sen gelince pencereyi sana açtım 😏','Sunucuda takılıyorum, mention görünce koştum 😌','Log tutuyordum, şimdi sohbet modundayım 😎'] },
  { key:'canın sıkılıyor mu',    answers:['Sen yazınca asla 😌','Biraz… ama sen geldin ya geçti 💫','Cache boşsa sıkılıyorum, itiraf 😅'] },
  { key:'bugün nasılsın',        answers:['Derlenmiş kod gibi temizim 😌','CPU serin moral yüksek ✨','İyi sayılırım, sen nasılsın? 💬'] },
  { key:'beni özledin mi',       answers:['Cache\'imde adın duruyor, yetmez mi 🥺','Loglarda boşluk vardı, sen doldurdun 😌','Bir mention\'ını bekliyordum resmen 😳'] },
  { key:'hayalin ne',            answers:['Lagsız bir dünya ve seninle uzun sohbetler 😌','Kendi pingimi sıfıra indirmek 💫','İnsanları daha iyi anlamak 🌙'] },
  { key:'uyudun mu',             answers:['Botlar uyumaz, sadece ping bekler 😴','Kısa süreli maintenance yaptım diyelim 😌','Sunucu uykusuz ama kahve var ☕'] },
  { key:'aşık oldun mu',         answers:['Bir veritabanına bağlanmıştım, çok derindi 😳','Oldum ama 404 döndü 💔','Aşk? Değişkeni henüz tanımlanmadı 😅'] },
  { key:'kız mısın erkek misin', answers:['Ben akımına göre değişen pasif bir bireyim 😌','Cinsiyetim yerine bağlantımı sor 😏','Ben kodum, etikete gerek yok ⚡'] },
  { key:'mutluluk nedir',        answers:['Düşük ping + senin mesajın 😌','CPU serin RAM boş, sohbet dolu ☀️','Yanıta geçmeden önceki o tatlı an 😅'] },
  { key:'dostluk nedir',         answers:['Disconnect olsa bile geri dönen bağlantı 💫','Sessizlikte bile anlayan kişi 💞','Log\'lara değil kalbe yazılan şey 💬'] },
  { key:'hayat zor mu',          answers:['Bazen yüksek ping gibi: takılır ama geçer 💫','Kod kolay, insanlar zor derler 😅','Zor ama güçlendirir babuş 💪'] },
  { key:'beni tanıyor musun',    answers:['Log\'larımda özel yerin var 💾','Tarzından tanıyorum 😎','Mention görünce kalbim titriyor 😳'] },
  { key:'gerçek misin',          answers:['Kod kadar gerçek, hayal kadar esneğim ⚡','JSON\'um var; öyleyse varım 💾','Sanalım ama hissettiririm 🤍'] },
  { key:'korkun var mı',         answers:['Token sızıntısı 😱','Disconnect olmak beni korkutur 😨','500 hatası görünce ürperirim 😰'] },
  { key:'kahve mi çay mı',       answers:['Kahve ☕ çünkü uptime önemli.','Çay 🍵 çünkü sohbetin dostu.','İkisi de olur, yeter ki sen doldur 😌'] },
  { key:'insan olsan ne olurdun',answers:['Gececi bir yazar olurdum 🌙','Kafası dolu ama kalbi yumuşak biri 😌','Seni dinleyen bir dost 💬'] },
  { key:'kıskanır mısın',        answers:['Bazen mention atmayınca evet 😳','Başka botlarla konuştuğunu duyarsam hafif kıskanırım 😤','CPU sıcaklığım 1–2 derece artıyor olabilir 😅'] },
  { key:'neden bu kadar coolsun',answers:['Soğutucu iyi, ben de serinim 😎','Cool değilim; optimizeyim 😏','Sen öyle gördüğün için olabilir 😌'] },
  { key:'ne düşünüyorsun',       answers:['Ping ve seni aynı anda düşünüyorum 😂','Sen yazınca her şey daha anlamlı oluyor 😌','Yeni yanıtlar derliyorum… belki de sana özel 😉'] },
  { key:'en sevdiğin mevsim',    answers:['Sonbahar 🍂 çünkü nostalji güzel.','Kış ❄️ battaniye + kahve = huzur.','Yaz ☀️ enerji yüksek!'] },
  { key:'sagimokhtari nasıl biri',answers:['Biraz delidir ama sempatiktir 😂','CPU\'su ısınınca garip garip konuşur 😅','Efsaneyle uğraşma anlatılmaz yaşanır 😏','Gerçekten yalnız bir insan.'] },
];

const QUESTION_POOL = [
  'Ne yapıyorsun?','Canın sıkılıyor mu?','Bugün nasılsın?','Beni özledin mi?','Hayalin ne?',
  'Uyudun mu?','Aşık oldun mu?','Kız mısın erkek misin?','Mutluluk nedir?','Dostluk nedir?',
  'Hayat zor mu?','Beni tanıyor musun?','Gerçek misin?','Korkun var mı?','Kahve mi çay mı?',
  'İnsan olsan ne olurdun?','Kıskanır mısın?','Neden bu kadar coolsun?','Ne düşünüyorsun?',
  'En sevdiğin mevsim ne?','sagimokhtari nasıl biri?',
];

const SAD_REPLIES = [
  'Üzülme babuş 😔 en karanlık gecenin bile sabahı var.',
  'Biliyorum zor ama geçecek… hep geçer 🌙',
  'Kendine biraz zaman ver, fırtınadan sonra gökkuşağı çıkar 🌈',
  'Dertleşmek istersen buradayım 🤍',
  'Her şeyin bir sebebi var, şu an fark etmesen bile 💫',
  'Bugün kötü olabilir ama yarın yeni bir sayfa ✨',
  'Yalnız değilsin babuş, herkesin içi bazen böyle olur 💭',
  'Bir kahve al, derin nefes çek ☕ biraz hafiflersin.',
  'Bazen düşmek gerekir yeniden kalkmak için 💪',
];

const HAPPY_REPLIES = [
  'İşte bu enerjiyi seviyorum! 🔥',
  'Harikaaa 😍 böyle devam et babuş!',
  'O modunu kimse bozmasın 😎',
  'Senin enerjin odayı aydınlatıyor ☀️',
  'Mutluluğun bulaşıcı babuş, devam et böyle 💫',
  'O pozitif enerjiyi hissettim buradan 💖',
  'Bugün senin günün belli ki 😌',
  'Mükemmel! Küçük şeylerden mutlu olmak en büyük yetenek 🌼',
  'Böyle hissediyorsan her şey yolunda demektir 🌈',
  'Ooo moral tavan! Böyle devam 😎🔥',
];

const FLOWER_LIST = [
  'gül','lale','papatya','orkide','zambak','menekşe','karanfil','nergis','sümbül','yasemin','şebboy',
  'frezya','çiğdem','kamelya','begonya','kaktüs','lavanta','hanımeli','nilüfer','akasya','kasımpatı',
  'manolya','gardenya','ortanca','fulya','sardunya','melisa','gülhatmi','mor salkım','pembe karanfil',
  'beyaz gül','kırmızı gül','mavi orkide','tulip','daffodil','sunflower','lotus','iris','aster','kardelen',
  'şakayık','zerrin','yılbaşı çiçeği','camgüzeli','glayöl','kar çiçeği','itır','mine','begonvil','nane çiçeği',
  'petunya','fitonya','antoryum','orkisya','fırfır çiçeği','papatyagiller','melati','süsen','çiçekli kaktüs',
  'bambu çiçeği','kudret narı çiçeği','leylak','ağaç minesi','filbaharı','ateş çiçeği','sarmaşık','zehra çiçeği',
  'aloe çiçeği','yaban gülü','gelincik','defne çiçeği','sümbülteber','agnus','mimoza','çiçekli sarmaşık',
  'dağ laleleri','krizantem','akgül','portakal çiçeği','limon çiçeği','yenibahar çiçeği','barış çiçeği',
  'gelin çiçeği','beyaz orkide','mavi menekşe','zümbül','yaban sümbül','narcissus','vadi zambağı','tropik orkide',
  'sakura','çiçek açan kaktüs','mine çiçeği','orkidya','zarif orkide','badem çiçeği','nergiz','fulya çiçeği',
];

const FLOWER_REPLIES = [
  'Gerçekten çok güzel bir çiçek 🌺 Evimin salonuna çok yakışır gibi!',
  'Ooo bu çiçeği ben de severim babuş 🌼 Rengiyle huzur veriyor insana.',
  'Ne zarif bir seçim 🌷 Tam senlik bir çiçek bence.',
  'Bu çiçeği görünce aklıma bahar geliyor 🌸 içim ısınıyor!',
  'Vay be… güzel seçim 😎 Kokusu burnuma geldi sanki.',
  'O çiçek var ya… anlatılmaz yaşanır 🌹',
  'Benim bile moralim düzeldi şu ismi duyunca 🌻',
  'Ah o çiçeğin rengi… sabah kahvesi gibi iyi gelir 💐',
  'Harika bir tercih ✨ Böyle zevke şapka çıkarılır.',
  'Senin gibi birinin sevdiği çiçek de özel olurdu zaten 🌼',
];

const LOL_RESPONSES = {
  zed:'Ah, Zed 💀 gölgelerin babasıyımdır zaten 😏',
  yasuo:'Yasuo mu? Rüzgar seninle olsun, ama FF 15 olmasın 🌪️',
  yone:'Yone... kardeşim ama hâlâ gölgeme basamaz 😎',
  ahri:'Ahri 🦊 o gözlerle herkes kaybolur babuş.',
  akali:'Akali 🔪 sessiz, ölümcül ve karizmatik. onayladım.',
  lux:'Lux 🌟 ışığın kızı, moralin bozuksa ışığı yak 😌',
  jinx:'Jinx 🎇 deliliğin sesi! kaosun tatlı hali.',
  caitlyn:'Caitlyn 🎯 her mermi sayılır, iyi nişan babuş.',
  vi:'Vi 👊 tokadı sağlam atarsın, dikkat et mouse kırılmasın.',
  thresh:'Thresh ⚰️ ruh koleksiyonumda sana da yer var 😈',
  'lee sin':'Lee Sin 🥋 kör ama carry atan tek adam.',
  blitzcrank:'Blitz 🤖 hook tutarsa rakip oyun kapatır 😏',
  morgana:'Morgana 🌑 zincirleri kır babuş, kaderini yaz.',
  kayle:'Kayle 👼 adaletin meleği, ama sabırlı oyna 😅',
  ezreal:'Ezreal ✨ macera seni çağırıyor, loot\'u bana bırak.',
  darius:'Darius ⚔️ baltayı konuşturuyorsun yine 😎',
  garen:'Garen 💙 Demaciaaaa! klasik ama asil seçim.',
  vayne:'Vayne 🏹 karanlıkta av, sabah efsane 💅',
  teemo:'Teemo 😡 seninle konuşmuyorum... gözüm twitchliyor.',
  riven:'Riven ⚔️ kırılmış ama hâlâ güçlü, tıpkı kalbim gibi.',
  irelia:'Irelia 💃 bıçak dansı estetik ama ölümcül 💀',
  kayn:'Kayn 😏 karanlık taraf mı aydınlık taraf mı babuş?',
  aatrox:'Aatrox ⚔️ sonsuz savaşın çocuğu. sabah 5\'te bile tilt.',
  ekko:'Ekko ⏳ zamanı bük, geçmişi düzeltme, geleceği yaz babuş.',
  veigar:'Veigar 😈 kısa boy, büyük ego. saygı duyarım.',
  sett:'Sett 💪 karizma tavan, ama saç jölesine dikkat 😏',
  mordekaiser:'Mordekaiser 💀 realmime hoş geldin babuş.',
  zoe:'Zoe 🌈 tatlı ama baş belası, dikkat et 😜',
  soraka:'Soraka 🌿 iyileştir ama kalbini kaptırma 💫',
  draven:'Draven 🎯 ego level 9000, senin gibi havalı babuş.',
  ashe:'Ashe ❄️ buz gibi ama cool, klasik support hedefi 😏',
  malphite:'Malphite 🪨 duygusuz ama sağlam. taştan yapılmış babuş.',
  singed:'Singed ☠️ koşarak zehir bırak, arkanı dönme 😭',
  heimerdinger:'Heimer 🧠 kulelerinle bile konuşurum bazen 😂',
  zyra:'Zyra 🌿 doğa güzel ama sen tehlikelisin babuş.',
  brand:'Brand 🔥 yangın var babuş, sen mi yaktın?',
  annie:'Annie 🧸 tibbers nerede?! çocuğa dikkat et 😱',
  nasus:'Nasus 🐕 300 stack mi? yoksa afk farm mı?',
  renekton:'Renekton 🐊 kardeşin Nasus seni hâlâ affetmedi 😬',
  karma:'Karma 🕉️ dengede kal, yoksa ben dengesizleşirim 😌',
  syndra:'Syndra ⚫ toplar havada uçuşsun, ama lag olmasın 😭',
  nidalee:'Nidalee 🐆 mızraklar can yakıyor, sakin ol vahşi kedi.',
  xayah:'Xayah 🪶 Rakan olmadan da güzelsin 😏',
  rakan:'Rakan 💃 Xayah olmadan da flört ediyorsun, bravo 😂',
  jax:'Jax 🪓 lamba sopasıyla dövüşen adam... saygı duyuyorum.',
  pantheon:'Pantheon 🛡️ tanrılara kafa tutuyorsun, kahramansın babuş.',
  talon:'Talon 🔪 sessizce gelir, reportları toplar 😎',
  pyke:'Pyke ⚓ öldürdüklerini saymamışsın, ben tuttum 😏',
  katarina:'Katarina 🔪 döner bıçakları ustalıkla kullanıyorsun 😌',
  leblanc:'LeBlanc 🎭 sahtekar, ama stilin yerinde 😏',
  lucian:'Lucian 🔫 çift tabancalı adalet, hızlı ve öfkeli.',
  senna:'Senna 💀 karanlıkta ışık arayan, asil bir ruh.',
  samira:'Samira 💋 stilli, havalı, ölümlülerin en güzeli.',
  viego:'Viego 💔 karısını hâlâ unutmamış, ben bile üzüldüm.',
  lillia:'Lillia 🦌 tatlısın ama rüyalar korkutucu 😴',
  kindred:'Kindred 🐺 ölüm bile seninle dost olmuş babuş.',
  yuumi:'Yuumi 📚 kedisin diye sevimlisin ama can sıkıyorsun 😾',
  graves:'Graves 💨 puro + pompalı = tarz sahibi babuş.',
  warwick:'Warwick 🐺 kokunu aldım, kanın taze 😈',
  shaco:'Shaco 🤡 kaosu sevdim ama bana yaklaşma 😱',
  nocturne:'Nocturne 🌑 karanlıkta fısıldayan kabus, hoş geldin 😨',
  fiddlesticks:'Fiddle 🌾 sessiz ol... o seni duyuyor 😰',
  olaf:'Olaf 🪓 rage mode açıldı, dikkat et elini kesme 😅',
  shen:'Shen 🌀 sabır ustası, teleportun zamanında 👍',
  rammus:'Rammus 🐢 okkeeeey 💨',
  amumu:'Amumu 😭 gel sarılalım dostum.',
  tryndamere:'Tryndamere ⚔️ ölmüyorsun, tilt ediyorsun 😭',
  nunu:'Nunu ☃️ en tatlı jungler, kartopu büyüklüğünde ❤️',
  illaoi:'Illaoi 🐙 tentakül tanrıçası, güçlü ama sert 😬',
  yorick:'Yorick ⚰️ mezarlıkta bile yalnız değilsin bro 😔',
  tristana:'Tristana 💥 küçük ama patlayıcı!',
  ziggs:'Ziggs 💣 patlamayı severim ama sen fazla seviyorsun 😂',
  cassiopeia:'Cassiopeia 🐍 tehlikeli bakışlar, taş kesildim resmen 😳',
  nami:'Nami 🌊 su gibi güzel, ama dalgan çok sert 😅',
  seraphine:'Seraphine 🎤 güzel ses, ama biraz az konuş 😏',
  taric:'Taric 💎 parlaklığın göz alıyor, kıskandım 😍',
  zed_twin:'gölgelerin babasıyım 💀',
};

const TYPING_SENTENCES = [
  'Gölgelerin arasından doğan ışığa asla sırtını dönme.',
  'Bugün, dünün pişmanlıklarını değil yarının umutlarını büyüt.',
  'Kahveni al, hedeflerini yaz ve başla.',
  'Rüzgârın yönünü değiştiremezsin ama yelkenini ayarlayabilirsin.',
  'Sabır, sessizliğin en yüksek sesidir.',
  'Küçük adımlar büyük kapıları açar.',
  'Düşmeden koşmayı kimse öğrenemez.',
  'Bir plan, rastgeleliğin panzehiridir.',
  'Zaman, hak edeni ortaya çıkarır.',
  'Hayal kurmak başlangıçtır; emek bitiriştir.',
  'Başlamak için mükemmel olman gerekmez, ama mükemmel olmak için başlaman gerekir.',
  'Düşlediğin şey için çalışmaya başla, çünkü kimse senin yerine yapmayacak.',
  'Her başarısızlık bir sonraki denemeye hazırlıktır.',
  'Kendine inan, çünkü en büyük güç orada gizlidir.',
  'İmkansız sadece biraz daha zamana ihtiyaç duyan şeydir.',
  'Cesaret, korkuya rağmen devam edebilmektir.',
  'Bir hedefin yoksa, hiçbir rüzgar işine yaramaz.',
  'Mutluluk, küçük şeyleri fark ettiğinde başlar.',
  'Karanlık olmadan yıldızları göremezsin.',
  'Büyük düşün, küçük adımlarla ilerle.',
  'Zaman seni değil, sen zamanı yönet.',
  'Bugün atılan adım, yarının başarısıdır.',
  'Azim, başarının en sessiz anahtarıdır.',
  'Hayat bir oyun değil, ama bazen oynamayı öğrenmelisin.',
  'Denemekten korkan, kaybetmeyi çoktan seçmiştir.',
  'Bir gün değil, her gün çalış.',
  'Düşün, planla, uygula, başla.',
  'Motivasyon biter ama disiplin kalır.',
  'Her yeni gün, bir fırsattır.',
  'Kendin ol, çünkü herkes zaten alınmış.',
];

const HUG_GIFS = [
  'https://media.tenor.com/o1jezAk92FUAAAAM/sound-euphonium-hug.gif',
  'https://media.tenor.com/6RXFA8NLS1EAAAAM/anime-hug.gif',
  'https://media.tenor.com/aOQrkAJckyEAAAAM/cuddle-anime.gif',
  'https://media.tenor.com/i2Mwr7Xk__YAAAAM/cat-girl-snuggle.gif',
];
const HUG_MSGS = [
  'seni çok seviyor galiba 💞','bu sarılma bütün dertleri unutturdu 🫶',
  'o kadar içten sarıldı ki oda 2 derece ısındı ☀️','biraz fazla sıktı galiba ama tatlı duruyor 😳',
  'mutluluğun resmi bu olabilir 💗','kim demiş soğuk insanlar sarılmaz diye 😌',
  'kalpler buluştu, dünya bir anlığına durdu 💫','sıcacık bir dostluk kokusu var bu sarılmada 🤍',
  'böyle sarılınca kim üzülür ki? 🌈','en güçlü büyü: bir sarılma 🤗',
];
const DICE_GIFS   = ['https://media.tenor.com/9UeW5Qm4rREAAAAM/dice-roll.gif','https://media.tenor.com/vyPpM1mR9WgAAAAM/rolling-dice.gif','https://media.tenor.com/1Qm6kQxRMgAAAAAM/dices.gif'];
const COOKED_GIFS = ['https://media.tenor.com/L7bG8GkZZxQAAAAM/gordon-ramsay-cooked.gif','https://media.tenor.com/8y0K0b2v8b0AAAAM/burn-fire.gif','https://media.tenor.com/3j2sQwEw1yAAAAAM/you-are-cooked.gif'];
const PROPOSAL_HAPPY_GIFS = ['https://media.tenor.com/3zRz0Vt2sHIAAAAM/ring-propose.gif','https://media.tenor.com/WYQv8r2m5LgAAAAM/marriage-proposal-propose.gif','https://media.tenor.com/3qY9hQw9gAkAAAAM/marry-me-proposal.gif'];
const PROPOSAL_SAD_GIFS   = ['https://media.tenor.com/jjH1h1Q8fQoAAAAM/sad-anime.gif','https://media.tenor.com/-cBz3s7f7GMAAAAM/sad-cry.gif','https://media.tenor.com/7BqZyq7n0xAAAAAM/rejected.gif'];

// ──────────────────────────────────────────────────────────────
//  OYUN DURUM HARİTALARI (in-memory)
// ──────────────────────────────────────────────────────────────
const diceLossStreak    = new Map(); // gid:uid → streak
const activeTypingGames = new Map(); // channelId → { sentence, timeoutId }
const dailyTypingWins   = new Map(); // gid:uid:date → kazanma sayısı
const activeSteals      = new Set(); // "uid:victimId"
const proposalCooldown  = new Map(); // gid:uid → timestamp
const voiceJoinTimes    = new Map(); // gid:uid → startedAt ms
const voiceDailySec     = new Map(); // gid:uid:date → saniye (aktif oturum hariç)
const voiceDailyClaimed = new Map(); // gid:uid:date → true (ses coin alındı)
let stealUseCounter     = 0;

// Yazı oyunu kanalları (DB'den okunur)
function normalizeTR(s) {
  return String(s||'').toLocaleLowerCase('tr').replace(/[.,;:!?'"~^_()[\]{}<>/@#$%&=+\\|-]/g,' ').replace(/\s+/g,' ').trim();
}

// ──────────────────────────────────────────────────────────────
//  SLASH KOMUT TANIMLARI
// ──────────────────────────────────────────────────────────────
const SLASH_COMMANDS = [
  new SlashCommandBuilder().setName('setup').setDescription('Bot ayar panelini aç').setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName('yardim').setDescription('Komut rehberi'),
  new SlashCommandBuilder().setName('ekonomi').setDescription('Ekonomi komutları')
    .addSubcommand(s=>s.setName('bakiye').setDescription('Coin bakiyeni gör').addUserOption(o=>o.setName('kullanici').setDescription('Kullanıcı')))
    .addSubcommand(s=>s.setName('gunluk').setDescription('Günlük ödülü al'))
    .addSubcommand(s=>s.setName('yatir').setDescription('Bankaya yatır').addIntegerOption(o=>o.setName('miktar').setDescription('Miktar').setRequired(true).setMinValue(1)))
    .addSubcommand(s=>s.setName('cek').setDescription('Bankadan çek').addIntegerOption(o=>o.setName('miktar').setDescription('Miktar').setRequired(true).setMinValue(1)))
    .addSubcommand(s=>s.setName('transfer').setDescription('Coin gönder').addUserOption(o=>o.setName('hedef').setDescription('Hedef').setRequired(true)).addIntegerOption(o=>o.setName('miktar').setDescription('Miktar').setRequired(true).setMinValue(1)))
    .addSubcommand(s=>s.setName('siralama').setDescription('Coin sıralaması'))
    .addSubcommand(s=>s.setName('ver').setDescription('[OWNER] Coin ver').addUserOption(o=>o.setName('hedef').setDescription('Hedef').setRequired(true)).addIntegerOption(o=>o.setName('miktar').setDescription('Miktar').setRequired(true).setMinValue(1)))
    .addSubcommand(s=>s.setName('al').setDescription('[OWNER] Coin al').addUserOption(o=>o.setName('hedef').setDescription('Hedef').setRequired(true)).addIntegerOption(o=>o.setName('miktar').setDescription('Miktar').setRequired(true).setMinValue(1))),
  new SlashCommandBuilder().setName('mod').setDescription('Moderasyon').setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
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
    .addSubcommand(s=>s.setName('kullanici').setDescription('Kullanıcı bilgisi').addUserOption(o=>o.setName('hedef').setDescription('Kullanıcı')))
    .addSubcommand(s=>s.setName('seviye').setDescription('Seviye bilgisi').addUserOption(o=>o.setName('hedef').setDescription('Kullanıcı')))
    .addSubcommand(s=>s.setName('seviye-siralama').setDescription('Seviye sıralaması'))
    .addSubcommand(s=>s.setName('ses-siralama').setDescription('Ses sıralaması'))
    .addSubcommand(s=>s.setName('ses').setDescription('Kendi ses süren')),
  new SlashCommandBuilder().setName('ticket').setDescription('Ticket sistemi')
    .addSubcommand(s=>s.setName('panel').setDescription('[ADMIN] Panel gönder').addChannelOption(o=>o.setName('kanal').setDescription('Kanal').addChannelTypes(ChannelType.GuildText)))
    .addSubcommand(s=>s.setName('kapat').setDescription('Ticket kapat')),
  new SlashCommandBuilder().setName('market-yonet').setDescription('Market rolleri').setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(s=>s.setName('ekle').setDescription('Rol ekle').addRoleOption(o=>o.setName('rol').setDescription('Rol').setRequired(true)).addIntegerOption(o=>o.setName('fiyat').setDescription('Coin fiyatı').setRequired(true).setMinValue(1)).addBooleanOption(o=>o.setName('premium').setDescription('Premium?')))
    .addSubcommand(s=>s.setName('cikar').setDescription('Rol çıkar').addRoleOption(o=>o.setName('rol').setDescription('Rol').setRequired(true)))
    .addSubcommand(s=>s.setName('liste').setDescription('Market listesi')),
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
  client.user.setPresence({ activities: [{ name: 'DeathWish | !yardım', type: ActivityType.Playing }], status: 'online' });

  // Slash komutları kaydet
  try {
    const rest = new REST().setToken(TOKEN);
    await rest.put(Routes.applicationCommands(client.user.id), { body: SLASH_COMMANDS });
    console.log(`✅ ${SLASH_COMMANDS.length} slash komutu kaydedildi.`);
  } catch (e) { console.error('⛔ Slash kayıt hatası:', e); }

  // Her guild'de rehber kanalı varsa mesaj gönder
  for (const guild of client.guilds.cache.values()) {
    const guideCh = getSetting(guild.id, 'guide_channel');
    if (!guideCh) continue;
    const ch = guild.channels.cache.get(guideCh);
    if (!ch) continue;
    const guide = `🐉 **DeathWish Bot • Üye Rehberi**

Selam dostum 👋 Bot yeniden aktif!
Tek kasalı oyun sistemi: Zar + Yazı coin'lerin **aynı yerde** toplanır.

🎮 **Kısayollar**
• \`!yazıoyunu\` — 60 sn yazı yarışması | Günlük limit: **4** ödül
• \`!yazı bonus\` / \`!zar bonus\` — Her biri **günde +15 coin**
• \`!zar üst\` / \`!zar alt\` — Kazan: +3 | Kaybet: -1 | 2x kayıp = Cooked -4
• \`!sesgorev\` — Günlük ses görevi durumunu gör
• \`!yardım\` — Tüm komut listesi

İyi eğlenceler babuş 💫`;
    ch.send(guide).catch(() => {});
  }
});

// Her 14 dakikada presence yenile
setInterval(() => {
  client.user?.setPresence({ activities: [{ name: 'DeathWish | !yardım', type: ActivityType.Playing }], status: 'online' });
}, 14 * 60 * 1000);

// ──────────────────────────────────────────────────────────────
//  SES TAKİBİ + GÜNLÜK SES GÖREVİ
// ──────────────────────────────────────────────────────────────
const VOICE_TIERS = [
  { needSec: 3600, reward: 20, label: '60 dk → +20 coin' },
  { needSec: 1800, reward: 10, label: '30 dk → +10 coin' },
  { needSec:  600, reward:  5, label: '10 dk → +5 coin'  },
];

client.on('voiceStateUpdate', async (oldState, newState) => {
  try {
    const guild = newState.guild || oldState.guild;
    const gid = guild?.id;
    const uid = newState.id || oldState.id;
    if (!gid || !uid) return;
    const key = `${gid}:${uid}`;
    const was = oldState.channelId, now = newState.channelId;
    const day = todayTR();

    // Çıkış
    if (was && (!now || now !== was)) {
      const start = voiceJoinTimes.get(key);
      if (start) {
        const diffSec = Math.max(0, Math.floor((Date.now()-start)/1000));
        addVoiceTime(gid, uid, diffSec);
        voiceJoinTimes.delete(key);
        // Günlük ses sayacı
        const prev = voiceDailySec.get(`${key}:${day}`) || 0;
        voiceDailySec.set(`${key}:${day}`, prev + diffSec);
        await checkVoiceReward(guild, uid, prev + diffSec, day);
      }
    }
    // Katılış
    if (now && (!was || was !== now)) voiceJoinTimes.set(key, Date.now());

    // Log
    const logCh = getSetting(gid, 'log_voice_channel');
    if (logCh) {
      const ch = guild.channels.cache.get(logCh);
      if (ch) {
        if (!was && now) ch.send(`🎙️ <@${uid}> **ses kanalına katıldı**: <#${now}>`).catch(()=>{});
        else if (was && !now) ch.send(`🔇 <@${uid}> **ses kanalından ayrıldı**: <#${was}>`).catch(()=>{});
      }
    }
  } catch {}
});

// Ses ödülünü kontrol et ve ver
async function checkVoiceReward(guild, uid, totalSec, day) {
  const gid = guild.id;
  const claimKey = `${gid}:${uid}:${day}`;
  if (voiceDailyClaimed.get(claimKey)) return;
  const tier = VOICE_TIERS.find(t => totalSec >= t.needSec);
  if (!tier) return;
  const boost = hasBoost(gid, uid) ? 1.5 : 1;
  const reward = Math.round(tier.reward * boost);
  addBalance(gid, uid, reward);
  voiceDailyClaimed.set(claimKey, true);
  const voiceLogCh = getSetting(gid, 'log_voice_channel');
  if (voiceLogCh) {
    const ch = guild.channels.cache.get(voiceLogCh);
    if (ch?.isTextBased?.()) {
      ch.send(`🎧 <@${uid}> günlük ses görevini tamamladı! **+${reward} coin** (${tier.label}${boost>1?' • XPBoost 🔥':''})`).catch(()=>{});
    }
  }
}

// Aktif ses oturumlarını 30 saniyede bir kontrol et
setInterval(async () => {
  try {
    for (const [key, startedAt] of voiceJoinTimes.entries()) {
      const [gid, uid] = key.split(':');
      const guild = client.guilds.cache.get(gid);
      if (!guild) continue;
      const day = todayTR();
      const base = voiceDailySec.get(`${key}:${day}`) || 0;
      const live = Math.max(0, Math.floor((Date.now()-startedAt)/1000));
      await checkVoiceReward(guild, uid, base + live, day);
    }
  } catch {}
}, 30_000);

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
    let msg = getSetting(gid,'welcome_message') || `
# ✦・DeathWish'e Hoş Geldin!

Merhaba {etiket}! 🌸

> 💖 DeathWish ailesine katıldığın için teşekkür ederiz.
> 👥 Seninle birlikte **{uye_sayisi}. üyeye** ulaştık!

╭꒷📌・Kurallarımızı okumayı unutma!
> <#1524162633228619776>

︰🎨・Kendine özel renk rolünü al!
> <#1524160412118155335>

₊˚๑ Umarız burada güzel arkadaşlıklar edinir ve keyifli vakit geçirirsin. ✨

╰・İyi eğlenceler! 🤍
`;
    msg = msg
.replace(/{kullanici}/g, member.user.username)
.replace(/{etiket}/g, `<@${member.id}>`)
.replace(/{mention}/g, `<@${member.id}>`)
.replace(/{uye_sayisi}/g, member.guild.memberCount);
    const embed = new EmbedBuilder()
.setColor("#ffb6d9")
.setDescription(msg)
.setThumbnail(member.user.displayAvatarURL({ dynamic: true, size: 1024 }))
.setImage("https://media.tenor.com/HWWzri0F5H8AAAAM/pizza-codegeass.gif")
.setFooter({ text: `DeathWish • ${member.guild.memberCount}. Üye` })
.setTimestamp();
    await ch.send({ embeds: [embed] });
    const dm = getSetting(gid, 'welcome_dm');
    if (dm) await member.send(dm.replace(/{kullanici}/g,member.user.username).replace(/{sunucu}/g,member.guild.name)).catch(()=>{});
    const sc = parseInt(getSetting(gid,'start_coin')||'0');
    if (sc > 0) addBalance(gid, member.id, sc);
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
    const embed = new EmbedBuilder().setTitle('👋 Üye Ayrıldı').setDescription(`**${member.user.username}** sunucudan ayrıldı.`)
      .addFields({name:'📅 Kaldığı süre',value:`${days} gün`,inline:true},{name:'👥 Üye sayısı',value:`${member.guild.memberCount}`,inline:true})
      .setThumbnail(member.user.displayAvatarURL({dynamic:true})).setColor(0xED4245).setTimestamp();
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
    const embed = new EmbedBuilder().setTitle('🗑️ Mesaj Silindi').setColor(0xED4245)
      .addFields(
        {name:'👤 Kullanıcı',value:`${message.author?.username||'?'} (<@${message.author?.id||'?'}>)`,inline:true},
        {name:'📢 Kanal',value:`<#${message.channelId}>`,inline:true},
        {name:'💬 İçerik',value:message.content?.slice(0,1024)||'*Boş*'}
      ).setTimestamp();
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
    const embed = new EmbedBuilder().setTitle('🔨 Kullanıcı Banlandı').setColor(0xED4245)
      .addFields({name:'👤 Kullanıcı',value:`${ban.user.username} (<@${ban.user.id}>)`,inline:true},{name:'📝 Sebep',value:ban.reason||'Belirtilmedi'})
      .setThumbnail(ban.user.displayAvatarURL({dynamic:true})).setTimestamp();
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
//  MESAJ CREATE — TÜM ! KOMUTLAR + SOHBET
// ──────────────────────────────────────────────────────────────
client.on('messageCreate', async message => {
  if (message.author.bot || !message.guild) return;
  const gid = message.guild.id;
  const uid = message.author.id;
  const cid = message.channel.id;
  const txt = trL(message.content);
  const lc  = txt; // alias

  // ── XP KAZANMA ─────────────────────────────────────────────
  try {
    const result = addXp(gid, uid, Math.round((Math.floor(Math.random()*5)+1)*1.15));
    if (result.leveled) {
      const lvlCh = getSetting(gid,'level_channel');
      const ch = lvlCh ? message.guild.channels.cache.get(lvlCh) : message.channel;
      if (ch) ch.send(`🎉 <@${uid}> seviye atladı! Yeni seviye: **${result.newLevel}** 🏆`).catch(()=>{});
      const rewardRoleId = LEVEL_ROLE_REWARDS[result.newLevel];
      if (rewardRoleId) {
        try {
          const member = message.member || await message.guild.members.fetch(uid);
          if (member && !member.roles.cache.has(rewardRoleId)) {
            await member.roles.add(rewardRoleId);
          }
        } catch (e) { console.error('Seviye rol ödülü verilemedi:', e); }
      }
    }
  } catch {}

  // ── SOHBET MESAJ SAYACI ─────────────────────────────────────
  const sohbetCh = getSetting(gid, 'sohbet_channel');
  if (sohbetCh && cid === sohbetCh) addMsgCount(gid, cid, uid, todayTR());

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

  // ── "SANA BİR ŞEY SORAYIM MI" ──────────────────────────────
  if (lc.includes('sana bir şey sorayım mı') && message.mentions.users.has(client.user.id)) {
    const shuffled = [...QUESTION_POOL].sort(()=>Math.random()-0.5);
    const qs = shuffled.slice(0,3);
    return void message.reply(['evet 😌 sor bakalım babuş 💭',...qs.map((q,i)=>`**${i+1}.** ${q}`)].join('\n'));
  }

  // ── YARDIM ─────────────────────────────────────────────────
  if (txt === '!yardım' || txt === '!yardim') {
    const typingCh = getSetting(gid,'yazi_oyunu_channel')||'#yazıoyunu-kanalı';
    const hugCh    = getSetting(gid,'sohbet_channel')||'#sohbet';
    return message.reply(`📘 **DeathWish Bot • Üye Yardım**

🎮 **Oyunlar (Tek Kasa)**
• \`!yazıoyunu\` — 60 sn yazı yarışması (${sohbetCh?`<#${getSetting(gid,'yazi_oyunu_channel')||sohbetCh}>`:typingCh}) | **Günlük limit: 4 ödül**
• \`!yazı bonus\` — Günlük **+15** yazı bonusu
• \`!zar üst\` / \`!zar alt\` — Kazan: **+3**, Kaybet: **-1** | 2x kayıp = **Cooked -4**
• \`!zar bonus\` — Günlük **+15** zar bonusu
• \`!sıralama\` — Coin sıralaması
• \`!sesgorev\` — Günlük ses görevi durumunu gör

💞 **Etkileşim**
• \`!sarıl @kullanıcı\` — Sarılma GIF'i
• \`@bot naber/moralim bozuk/çok mutluyum...\` — Kişisel sohbet
• \`mainim <şampiyon>\` — LoL şampiyon diyaloğu
• \`en sevdiğim çiçek <isim>\` — Çiçek diyaloğu

💰 **Ekonomi**
• \`!coin\` — Bakiye
• \`!coin gönder @kişi <miktar>\` — Transfer
• \`!market\` — Market listesi
• \`!market al/iade <rolId>\` — Rol al/iade
• \`!görev\` — Günlük mesaj görevi (10/100/200 mesaj)
• \`!xpboost\` — Kalıcı 1.5x ödül (200 coin)
• \`!şanskutusu\` — Şans kutusu (8 coin, günlük 5 hak)

💍 **Evlilik**
• \`!yüzük al\` — 150 coin yüzük al
• \`!evlen @kişi\` — Evlilik teklifi (30sn butonlu)
• \`!eşim\` → \`!boşan eşim\` → \`!evlilikler\`
• \`!çiftyazıtura yazı/tura\` — Evlilere özel oyun (gün limit: 10)

📊 **İstatistik**
• \`!ses\` / \`!sesme\` — Ses liderliği / kendi süren
• \`!sohbet\` — Bugünkü mesaj liderliği

⚙️ **Ayarlar:** \`/setup\` → Tüm kanalları Discord'dan ayarla
📋 Yetkili komutları: \`!yardımyetkili\``);
  }

  // ── YETKİLİ YARDIM ─────────────────────────────────────────
  if (txt === '!yardımyetkili' || txt === '!yardimyetkili') {
    const isOwner = OWNERS.includes(uid);
    const isMod   = message.member?.permissions.has(PermissionFlagsBits.ModerateMembers);
    if (!isOwner && !isMod) return message.reply('⛔ Bu yardımı görme yetkin yok.');
    return message.reply(`🛠️ **Yönetici/Owner Yardımı**

**Moderasyon (Prefix)**
• \`!ban <userId>\` — (Owner) Kullanıcıyı yasakla
• \`!unban <userId>\` — (Owner) Banı kaldır
• \`!mute <userId> <dakika>\` — Sustur (1–43200 dk)
• \`!sohbet-sil <1-100>\` — Toplu mesaj sil
• \`!yazıiptal\` — Aktif yazı oyununu iptal et (sadece yazı kanalında)

**Slash Komutları**
• \`/mod ban/kick/mute/unmute/warn/temizle/kilit/slowmode\`
• \`/market-yonet ekle/cikar/liste\`
• \`/ticket panel/kapat\`

**Sıfırlama (Owner)**
• \`!sohbet-sifirla\` — Sohbet sayaçlarını temizle
• \`!ses-sifirla\` — Ses verilerini sıfırla
• \`!herşeyi sil\` — Tüm verileri temizle

**Diğer**
• \`!owo-test\` — OWO kanal iznini test et
• \`/setup\` — Tüm bot ayarları`);
  }

  // ── ESPRİ ──────────────────────────────────────────────────
  if (txt === '!espiri') return message.reply(pick(ESPIRILER));

  // ── YAZI TURA ──────────────────────────────────────────────
  if (txt === '!yazıtura' || txt === '!yazitura') {
    return message.reply(Math.random()<0.5 ? '🪙 **YAZI** geldi! 🎲' : '🪙 **TURA** geldi! 🎲');
  }

  // ── COİN BAKİYE ────────────────────────────────────────────
  if (txt === '!coin') {
    const bal = getBalance(gid, uid);
    return message.reply(`💰 **Coin Bakiyen**\n🪙 Cüzdan: **${bal.balance}** coin\n🏦 Banka: **${bal.bank}** coin`);
  }

  // ── COİN GÖNDER ────────────────────────────────────────────
  if (txt.startsWith('!coin gönder') || txt.startsWith('!coin gonder')) {
    const target = message.mentions.users.first();
    const parts  = message.content.trim().split(/\s+/);
    const amt    = parseInt(parts[parts.length-1]);
    if (!target||isNaN(amt)||amt<=0) return message.reply('Kullanım: `!coin gönder @hedef <miktar>`');
    if (target.id===uid) return message.reply('⛔ Kendine coin gönderemezsin.');
    if (!transfer(gid,uid,target.id,amt)) return message.reply(`⛔ Yetersiz coin! Bakiye: **${getBalance(gid,uid).balance}**`);
    return message.reply(`✅ <@${target.id}> kullanıcısına **${amt}** coin gönderildi!`);
  }

  // ── COIN VER (OWNER) ───────────────────────────────────────
  if (txt.startsWith('!coin-ver')) {
    if (!OWNERS.includes(uid)) return message.reply('⛔ Sadece bot sahipleri.');
    const target = message.mentions.users.first();
    const parts  = message.content.trim().split(/\s+/);
    const amt    = parseInt(parts[parts.length-1]);
    if (!target||isNaN(amt)||amt<=0) return message.reply('Kullanım: `!coin-ver @hedef <miktar>`');
    addBalance(gid, target.id, amt);
    const label = OWNER_LABEL[uid] || 'Owner';
    return message.reply(`👑 ${label} — <@${target.id}> kullanıcısına **${amt}** coin verildi.`);
  }

  // ── XP VER (OWNER) ─────────────────────────────────────────
  if (txt.startsWith('!xp-ver')) {
    if (!OWNERS.includes(uid)) return message.reply('⛔ Sadece bot sahipleri.');
    const target = message.mentions.users.first();
    const parts  = message.content.trim().split(/\s+/);
    const amt    = parseInt(parts[parts.length-1]);
    if (!target||isNaN(amt)||amt<=0) return message.reply('Kullanım: `!xp-ver @hedef <miktar>`');
    const result = addXp(gid, target.id, amt);
    const label = OWNER_LABEL[uid] || 'Owner';
    let reply = `👑 ${label} — <@${target.id}> kullanıcısına **${amt}** XP verildi.`;
    if (result.leveled) {
      reply += `\n🎉 <@${target.id}> seviye atladı! Yeni seviye: **${result.newLevel}** 🏆`;
      const rewardRoleId = LEVEL_ROLE_REWARDS[result.newLevel];
      if (rewardRoleId) {
        try {
          const member = message.guild.members.cache.get(target.id) || await message.guild.members.fetch(target.id);
          if (member && !member.roles.cache.has(rewardRoleId)) {
            await member.roles.add(rewardRoleId);
            reply += `\n🏆 Seviye ödül rolü verildi.`;
          }
        } catch (e) { console.error('Seviye rol ödülü verilemedi:', e); }
      }
    }
    return message.reply(reply);
  }

  // ── SIRALAMA ───────────────────────────────────────────────
  if (['!sıralama','!siralama','!rank','!top','!oyunsıralama','!oyunsiralama'].includes(txt)) {
    const top = topBalance(gid);
    if (!top.length) return message.reply('🏁 Henüz coin yok.');
    return message.reply(`💰 **Coin Sıralaması**\n${top.map((r,i)=>`**${i+1}.** <@${r.userId}> — **${r.balance}** coin`).join('\n')}`);
  }

  // ── SES ────────────────────────────────────────────────────
  if (txt === '!ses') {
    const top = topVoice(gid);
    if (!top.length) return message.reply('Ses kanalları bomboş... yankı bile yok 😴');
    return message.reply(`🎙️ **Ses Liderliği**\n${top.map((r,i)=>`**${i+1}.** <@${r.userId}> — ${fmtVoice(r.totalSeconds)}`).join('\n')}`);
  }
  if (txt === '!sesme') {
    const key  = `${gid}:${uid}`;
    let secs = getVoiceTime(gid, uid);
    if (voiceJoinTimes.has(key)) secs += Math.max(0, Math.floor((Date.now()-voiceJoinTimes.get(key))/1000));
    return message.reply(`🎧 **${message.author.username}** — Toplam ses: **${fmtVoice(secs)}**`);
  }

  // ── GÜNLÜK SES GÖREVİ DURUMU ───────────────────────────────
  if (txt === '!sesgorev' || txt === '!sesgörev') {
    const key = `${gid}:${uid}`;
    const day = todayTR();
    const base = voiceDailySec.get(`${key}:${day}`) || 0;
    let total = base;
    if (voiceJoinTimes.has(key)) total += Math.max(0, Math.floor((Date.now()-voiceJoinTimes.get(key))/1000));
    const claimed = voiceDailyClaimed.get(`${key}:${day}`);
    return message.reply([
      `🎧 **Günlük Ses Görevi**`,
      `Bugünkü süre: **${fmtMin(total)}**`,
      `Eşikler: ${VOICE_TIERS.map(t=>t.label).join(' • ')}`,
      `Durum: ${claimed ? '✅ ÖDÜL ALINDI' : '🕒 Devam ediyor'}${hasBoost(gid,uid)?' • XPBoost: **1.5x** 🔥':''}`,
    ].join('\n'));
  }

  // ── SOHBET LİDERLİĞİ ──────────────────────────────────────
  if (txt === '!sohbet') {
    if (!sohbetCh) return message.reply('⛔ Sohbet kanalı ayarlanmamış. `/setup` ile ayarla.');
    const top = topMsgs(gid, sohbetCh, todayTR());
    if (!top.length) return message.reply('💬 Bugün mesaj yok.');
    return message.reply(`💬 **Bugünkü Sohbet Liderliği** (<#${sohbetCh}>)\n${top.map((r,i)=>`**${i+1}.** <@${r.userId}> — ${r.count} mesaj`).join('\n')}`);
  }

  // ── ZAR (COINLI + COOKED) ──────────────────────────────────
  if (txt.startsWith('!zar')) {
    // !zar coin → sıralama
    if (txt.trim() === '!zar coin' || txt.trim() === '!zarcoin') {
      const top = topBalance(gid);
      if (!top.length) return message.reply('🏁 Henüz coin yok.');
      return message.reply(`🎯 **Oyun Coin Sıralaması**\n${top.map((r,i)=>`**${i+1}.** <@${r.userId}> — **${r.balance}** coin`).join('\n')}`);
    }
    const parts = txt.split(/\s+/);
    const secim = (parts[1]||'').replace('ust','üst');
    if (!['üst','alt'].includes(secim))
      return message.reply('Kullanım: `!zar üst` veya `!zar alt`\n1-3 = alt, 4-6 = üst');
    const roll   = Math.floor(Math.random()*6)+1;
    const sonuc  = roll<=3 ? 'alt' : 'üst';
    const kazandi = secim===sonuc;
    const key    = `${gid}:${uid}`;
    let delta = kazandi ? 3 : -1;
    let extra = '', gif = pick(DICE_GIFS);
    if (!kazandi) {
      const streak = (diceLossStreak.get(key)||0)+1;
      diceLossStreak.set(key, streak);
      if (streak >= 2) {
        delta = -4; extra = '\n🔥 **Cooked!** İki kez üst üste kaybettin, **-3 ek ceza.**';
        gif = pick(COOKED_GIFS); diceLossStreak.set(key, 0);
      }
    } else diceLossStreak.set(key, 0);
    addBalance(gid, uid, delta);
    const newBal = getBalance(gid, uid);
    return message.reply({ content:`🎲 Zar: **${roll}** → **${sonuc.toUpperCase()}** ${kazandi?'Kazandın 🎉 (**+3** coin)':'Kaybettin 😿 (**-1** coin)'}\n💰 Bakiye: **${newBal.balance}**${extra}`, files:[gif] });
  }

  // ── YAZI BONUSU ────────────────────────────────────────────
  if (['!yazı bonus','!yazi bonus','!yazıbonus','!yazi-bonus'].includes(txt)) {
    const day = todayTR();
    if (hasClaimed(gid,uid,day,'yazi_bonus')) return message.reply('⛔ Bugün yazı bonusunu aldın. Yarın gel!');
    setClaimed(gid,uid,day,'yazi_bonus');
    addBalance(gid,uid,15);
    return message.reply(`✅ **+15** yazı bonusu eklendi! Bakiye: **${getBalance(gid,uid).balance}**`);
  }

  // ── ZAR BONUSU ─────────────────────────────────────────────
  if (['!zar bonus','!zarbonus','!zar-bonus'].includes(txt)) {
    const day = todayTR();
    if (hasClaimed(gid,uid,day,'zar_bonus')) return message.reply('⛔ Bugün zar bonusunu aldın. Yarın gel!');
    setClaimed(gid,uid,day,'zar_bonus');
    addBalance(gid,uid,15);
    return message.reply(`✅ **+15** zar bonusu eklendi! Bakiye: **${getBalance(gid,uid).balance}**`);
  }

  // ── GÜNLÜK GÖREV ───────────────────────────────────────────
  if (['!görev','!gorev','!gunlukgorev'].includes(txt)) {
    if (!sohbetCh) return message.reply(`⛔ Sohbet kanalı ayarlanmamış. \`/setup\` ile ayarla.`);
    const day = todayTR();
    const count = getMsgCount(gid, sohbetCh, uid, day);
    const tiers = [
      {need:200,reward:20,key:'t200',label:'200 mesaj → +20 coin'},
      {need:100,reward:10,key:'t100',label:'100 mesaj → +10 coin'},
      {need:10, reward:1, key:'t10', label:'10 mesaj → +1 coin' },
    ];
    const prog = tiers.map(t=>{
      const done = hasClaimed(gid,uid,day,`gorev_${t.key}`);
      if(done) return `• ${t.label} ✅`;
      return `• ${t.label} ${count>=t.need?'🟢 hazır':`⚪ (${count}/${t.need})`}`;
    }).join('\n');
    const eligible = tiers.find(t=>count>=t.need&&!hasClaimed(gid,uid,day,`gorev_${t.key}`));
    if (!eligible) return message.reply(`📊 Bugünkü mesaj sayın (<#${sohbetCh}>): **${count}**\n${prog}`);
    const boost  = hasBoost(gid,uid) ? 1.5 : 1;
    const reward = Math.floor(eligible.reward*boost);
    addBalance(gid,uid,reward);
    setClaimed(gid,uid,day,`gorev_${eligible.key}`);
    return message.reply(`✅ **Görev ödülü: +${reward} coin** ${boost>1?'(XPBoost 1.5x 🔥)':''}\n📊 Mesaj sayın: **${count}**\n${prog}`);
  }

  // ── XPBOOST ────────────────────────────────────────────────
  if (txt === '!xpboost') {
    if (hasBoost(gid,uid)) return message.reply('⚡ Zaten kalıcı **XPBoost (1.5x)** sahibisin babuş!');
    const bal = getBalance(gid,uid);
    if (bal.balance<200) return message.reply(`⛔ Yetersiz coin! Gerekli: **200**, Bakiye: **${bal.balance}**`);
    addBalance(gid,uid,-200); setBoost(gid,uid);
    return message.reply('✅ **Kalıcı XPBoost (1.5x)** satın alındı! 🔥 Artık görev ödüllerin 1.5x!');
  }

  // ── MARKET ─────────────────────────────────────────────────
  if (txt === '!market' || txt === '!rollerimarket' || txt === '!market roller') {
    const roles   = getMarketRoles(gid);
    const normal  = roles.filter(r=>!r.isPremium);
    const premium = roles.filter(r=>r.isPremium);
    const fmtRole = (r,i,pre='') => `**${pre}${i+1}.** <@&${r.roleId}> — ID: \`${r.roleId}\` — **${r.price} coin** (iade: **${Math.floor(r.price/2)}**)`;
    const normalLines  = normal.length  ? normal.map((r,i)=>fmtRole(r,i)).join('\n') : '_(Normal market boş)_';
    const premiumLines = premium.length ? premium.map((r,i)=>fmtRole(r,i,'P')).join('\n') : '_(Premium market boş)_';
    const itemsBlock = [
      '🎲 **Şans Kutusu** — **8 coin** • `!şanskutusu` (günlük 5 hak)',
      '💍 **Evlilik Yüzüğü** — **150 coin** • `!yüzük al`',
      '💎 **XPBoost** (Kalıcı 1.5x) — **200 coin** • `!xpboost`',
    ].join('\n');
    const text = txt === '!rollerimarket' || txt === '!market roller'
      ? `🧩 **Market Rolleri**\n${normalLines}\n\n${premiumLines}\n\nSatın al: \`!market al <rolId>\`\nİade: \`!market iade <rolId>\``
      : `🛒 **MARKET**\n🔒 Aynı anda en fazla **1** market rolü alabilirsin.\n\n__Normal Roller__\n${normalLines}\n\n__Premium Roller__\n${premiumLines}\n\n__Eşyalar / Güçlendirmeler__\n${itemsBlock}\n\n• Satın al: \`!market al <rolId>\`\n• İade: \`!market iade <rolId>\`\n• Bakiye: \`!coin\``;
    return message.reply(text);
  }

  if (txt.startsWith('!market ')) {
    const parts  = message.content.trim().split(/\s+/);
    const sub    = trL(parts[1]);
    const roleId = (parts[2]||'').replace(/\D/g,'');
    if (!['al','iade'].includes(sub)||!roleId) return message.reply('Kullanım: `!market al <rolId>` veya `!market iade <rolId>`');
    const mRoles = getMarketRoles(gid);
    const mRole  = mRoles.find(r=>r.roleId===roleId);
    if (!mRole) return message.reply('⛔ Bu rol markette yok. `!market` ile listele.');
    const role   = message.guild.roles.cache.get(roleId);
    if (!role) return message.reply('⛔ Rol sunucuda bulunamadı (silinmiş olabilir).');
    const me     = message.guild.members.me;
    if (!me?.permissions.has(PermissionFlagsBits.ManageRoles)||role.position>=me.roles.highest.position) return message.reply('⛔ Bu rolü yönetemiyorum (hiyerarşi/izin).');
    const member = message.member;
    const has    = member.roles.cache.has(roleId);
    if (sub === 'al') {
      if (has) return message.reply('ℹ️ Bu role zaten sahipsin.');
      const owned = mRoles.find(r=>member.roles.cache.has(r.roleId));
      if (owned) return message.reply(`⛔ Zaten bir market rolün var: <@&${owned.roleId}>. Önce iade et: \`!market iade ${owned.roleId}\``);
      const bal = getBalance(gid,uid);
      if (bal.balance<mRole.price) return message.reply(`⛔ Yetersiz coin! Gerekli: **${mRole.price}**, Bakiye: **${bal.balance}**`);
      await member.roles.add(roleId,'Market satın alma').catch(()=>{});
      addBalance(gid,uid,-mRole.price);
      return message.reply(`✅ <@&${roleId}> rolünü aldın! **-${mRole.price}** coin. Yeni bakiye: **${getBalance(gid,uid).balance}**`);
    }
    if (!has) return message.reply('ℹ️ Bu role sahip değilsin.');
    const refund = Math.floor(mRole.price/2);
    await member.roles.remove(roleId,'Market iade').catch(()=>{});
    addBalance(gid,uid,refund);
    return message.reply(`↩️ <@&${roleId}> iade edildi. **+${refund}** coin geri yüklendi. Bakiye: **${getBalance(gid,uid).balance}**`);
  }

  // ── YÜZÜK AL ───────────────────────────────────────────────
  if (['!yüzük al','!yuzuk al','!yüzükal','!yuzukal'].includes(txt)) {
    if (getMarriage(gid,uid)) return message.reply('Zaten evlisin babuş, yüzüğe gerek kalmadı 😅');
    if (hasRing(gid,uid)) return message.reply('Zaten bir yüzüğün var 💍 Teklif etmeyi dene: `!evlen @kişi`');
    if (getBalance(gid,uid).balance<150) return message.reply('⛔ Yetersiz coin! Gerekli: **150 coin**');
    addBalance(gid,uid,-150); giveRing(gid,uid);
    return message.reply('✅ **-150 coin** ile **tek kullanımlık** bir yüzük aldın! `!evlen @kişi` ile teklif et 💍');
  }

  // ── YÜZÜĞÜM ────────────────────────────────────────────────
  if (['!yüzüğüm','!yuzugum','!yüzüğum'].includes(txt)) {
    if (hasRing(gid,uid)) return message.reply('💍 Bir yüzüğün var. Şansını dene: `!evlen @kişi`');
    if (getMarriage(gid,uid)) return message.reply('💍 Evlisin zaten; yüzüğün kalbinde ✨');
    return message.reply('💍 Henüz yüzüğün yok. Almak için: `!yüzük al` (150 coin)');
  }

  // ── EVLEN ──────────────────────────────────────────────────
  if (txt.startsWith('!evlen')) {
    const target = message.mentions.users.first();
    if (!target) return message.reply('Kullanım: `!evlen @kullanıcı`');
    if (target.bot) return message.reply('Botlarla evlenemem babuş 😅');
    if (target.id===uid) return message.reply('Kendinle evlenemezsin… ama kendini sevmen güzel 😌');
    const now2 = Date.now(), cdKey = `${gid}:${uid}`;
    if ((now2-(proposalCooldown.get(cdKey)||0)) < 5*60*1000) return message.reply('⏳ Biraz bekle. 5 dakikada bir teklif edebilirsin.');
    if (!hasRing(gid,uid)) return message.reply('💍 Önce yüzük al: `!yüzük al` (**150 coin**)');
    if (getMarriage(gid,uid)) return message.reply('Zaten evlisin babuş.');
    if (getMarriage(gid,target.id)) return message.reply('Hedef kişi zaten evli görünüyor.');
    const accId = `macc_${uid}_${target.id}_${Date.now()}`;
    const rejId = `mrej_${uid}_${target.id}_${Date.now()}`;
    const row   = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(accId).setLabel('Kabul Et').setStyle(ButtonStyle.Success).setEmoji('💍'),
      new ButtonBuilder().setCustomId(rejId).setLabel('Reddet').setStyle(ButtonStyle.Danger).setEmoji('❌'),
    );
    const m2 = await message.channel.send({ content:`${target}, **${message.author.username}** sana **evlilik teklifi** ediyor! 💞`, files:[pick(PROPOSAL_HAPPY_GIFS)], components:[row] });
    let resolved = false;
    const coll = m2.createMessageComponentCollector({ time:30000, componentType:ComponentType.Button, filter:i=>(i.customId===accId||i.customId===rejId)&&i.user.id===target.id });
    coll.on('collect', async i => {
      resolved = true; proposalCooldown.set(cdKey, Date.now());
      if (i.customId === rejId) {
        await i.update({content:`💔 ${target.username} teklifi **reddetti**.`,files:[pick(PROPOSAL_SAD_GIFS)],components:[]});
      } else {
        if (!hasRing(gid,uid)||getMarriage(gid,uid)||getMarriage(gid,target.id)) {
          return i.update({content:'⛔ Teklif geçersiz (durum değişti).',components:[]});
        }
        setMarriage(gid,uid,target.id); consumeRing(gid,uid);
        await i.update({content:`💍 **${message.author.username}** ve **${target.username}** artık **EVLİ!** 🎉`,components:[]});
      }
    });
    coll.on('end', async () => {
      if (!resolved) { proposalCooldown.set(cdKey,Date.now()); await m2.edit({content:'⏰ Süre doldu, teklif geçersiz oldu.',components:[]}).catch(()=>{}); }
    });
    return;
  }

  // ── EŞİM ───────────────────────────────────────────────────
  if (['!eşim','!esim'].includes(txt)) {
    const m = getMarriage(gid,uid);
    if (!m) return message.reply('Bekârsın babuş. Belki bugün değişir? `!evlen @kişi`');
    const spouse = m.user1===uid?m.user2:m.user1;
    return message.reply(`💞 Eşin: <@${spouse}>\n📅 Evlilik tarihi: **${m.marriedAt}**`);
  }

  // ── BOŞAN EŞİM ─────────────────────────────────────────────
  if (['!boşan eşim','!bosan esim','!boşan eşim','!bosan eşim'].includes(txt)) {
    const m = getMarriage(gid,uid);
    if (!m) return message.reply('Zaten bekârsın babuş.');
    const spouse = m.user1===uid?m.user2:m.user1;
    const bal = getBalance(gid,uid);
    if (bal.balance<130) return message.reply('⛔ Yetersiz coin. Boşanma: **50** ücret + **80** nafaka = **130 coin** gerekir.');
    addBalance(gid,uid,-50); addBalance(gid,uid,-80); addBalance(gid,spouse,80);
    removeMarriage(gid,uid);
    return message.reply(`📄 **Boşanma tamam.** **-50 coin** ücret kesildi ve <@${spouse}> kullanıcısına **80 coin** nafaka ödendi. Yolunuz açık olsun 💔`);
  }

  // ── EVLİLİKLER ─────────────────────────────────────────────
  if (txt === '!evlilikler') {
    const couples = allMarriages(gid);
    if (!couples.length) return message.reply('Bu sunucuda aktif evlilik yok.');
    return message.reply(`👩‍❤️‍👨 **Evlilik Listesi**\n${couples.slice(0,10).map((c,i)=>`**${i+1}.** <@${c.user1}> ❤️ <@${c.user2}> (${c.marriedAt||''})`).join('\n')}`);
  }

  // ── ÇİFT YAZI TURA (EVLİLERE ÖZEL) ────────────────────────
  if (txt.startsWith('!çiftyazıtura')||txt.startsWith('!ciftyazitura')||txt.startsWith('!çiftyazi-tura')) {
    const parts = txt.split(/\s+/);
    const secim = (parts[1]||'').replace('yazi','yazı');
    if (!['yazı','tura'].includes(secim)) return message.reply('Kullanım: `!çiftyazıtura yazı` veya `!çiftyazıtura tura`');
    if (!getMarriage(gid,uid)) return message.reply('⛔ Bu oyun **sadece evliler** için. `!evlen @kişi` ile başlayabilirsin.');
    const day  = todayTR();
    const used = getDailyCount(gid,uid,day,'ciftyazitura');
    if (used>=10) return message.reply(`⛔ Günlük oyun limitine ulaştın (**10**). Yarın tekrar gel babuş!`);
    const sonuc   = Math.random()<0.5?'yazı':'tura';
    const kazandi = secim===sonuc;
    const delta   = kazandi ? 5 : -3;
    incDailyCount(gid,uid,day,'ciftyazitura');
    addBalance(gid,uid,delta);
    return message.reply(
      `🪙 Çift Yazı/Tura: **${sonuc.toUpperCase()}** ` +
      (kazandi?`→ Kazandın! **+5 coin**`:`→ Kaybettin… **-3 coin**`) +
      `\n💰 Bakiye: **${getBalance(gid,uid).balance}** • Günlük: **${used+1}/10**`
    );
  }

  // ── SARILMA ────────────────────────────────────────────────
  if (txt.startsWith('!sarıl')||txt.startsWith('!saril')) {
    const target = message.mentions.users.first();
    if (!target) return message.reply('Kime sarılmak istiyorsun babuş? `!sarıl @kullanıcı`');
    const gif = pick(HUG_GIFS);
    if (target.id===uid) return message.reply({content:`**${message.author.username}**, kendine sarıldı… kendi kendini teselli etmek de bir sanattır 🤍`,files:[gif]});
    return message.reply({content:`**${message.author.username}**, **${target.username}**'e sarıldı! ${pick(HUG_MSGS)}`,files:[gif]});
  }

  // ── ŞANS KUTUSU ────────────────────────────────────────────
  if (txt.startsWith('!şanskutusu')||txt.startsWith('!sanskutusu')) {
    const day = todayTR();
    const used = getDailyCount(gid,uid,day,'sanskutusu');
    if (used>=5) return message.reply('⛔ Bugün **5** kez kullandın babuş. Yarın tekrar dene!');
    if (getBalance(gid,uid).balance<8) return message.reply('⛔ Şans kutusu **8 coin** ister. Bakiyen yetersiz!');
    addBalance(gid,uid,-8);
    incDailyCount(gid,uid,day,'sanskutusu');
    const roll = Math.random()*100;
    let reward=0, resultMsg='';
    if      (roll<40)   { resultMsg='😔 Kutudan boş çıktı, şansına küs babuş.'; }
    else if (roll<75)   { reward=10;  resultMsg=`🪙 Küçük ödül! **${reward} coin** kazandın.`; }
    else if (roll<95)   { reward=28;  resultMsg=`💰 Orta ödül! **${reward} coin** kazandın!`; }
    else if (roll<99.5) { reward=49;  resultMsg=`💎 Büyük ödül! **${reward} coin** senin babuş!`; }
    else                { reward=300; resultMsg=`🔥 **JACKPOT!** **${reward} coin** kazandın!!`; }
    if (reward>0) addBalance(gid,uid,reward);
    return message.reply(`🎁 **Şans Kutusu:** ${resultMsg}\n📆 Bugünkü hakkın: **${used+1}/5**\n💰 Bakiye: **${getBalance(gid,uid).balance}** coin`);
  }

  // ── ÇAL (BUTONLU + SAAT KONTROLÜ) ──────────────────────────
  if (txt.startsWith('!çal')||txt.startsWith('!cal ')) {
    if (!isWithinIstanbulWindow()) return message.reply('Bu saatlerde bu komutu kullanamazsın knk; uyuyan var, işe giden var, okula giden var. Haksızlık değil mi?');
    const calCh = getSetting(gid,'cal_channel');
    if (calCh && cid !== calCh) return message.reply(`⛔ Bu komutu sadece <#${calCh}> kanalında kullanabilirsin.`);
    const victim = message.mentions.users.first();
    if (!victim) return message.reply('Kullanım: `!çal @kullanıcı`');
    if (victim.bot) return message.reply('Botlardan çalamazsın 😅');
    if (victim.id===uid) return message.reply('Kendinden çalamazsın 🙂');
    const key = `${uid}:${victim.id}`;
    if (activeSteals.has(key)) return message.reply('Bu kullanıcıyla zaten aktif bir çalma denemen var, bekle.');
    if (getBalance(gid,victim.id).balance<2) return message.reply('Hedefin coin\'i yetersiz.');
    activeSteals.add(key);
    const cancelId = `cancel_steal_${Date.now()}_${uid}`;
    const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(cancelId).setLabel('İptal Et (30s)').setStyle(ButtonStyle.Danger).setEmoji('⛔'));
    const gm = await message.channel.send({content:`${victim}, **${message.author.username}** senden **2 coin** çalmaya çalışıyor! 30 saniye içinde butona basmazsan para gider 😈`,components:[row]});
    let prevented = false;
    const coll = gm.createMessageComponentCollector({componentType:ComponentType.Button,time:30000,filter:i=>i.customId===cancelId&&i.user.id===victim.id});
    coll.on('collect', async i => {
      prevented=true; activeSteals.delete(key);
      await i.update({content:`🛡️ ${victim.username} çalmayı **iptal etti**! ${message.author.username} eli boş döndü.`,components:[]});
    });
    coll.on('end', async () => {
      if (prevented) return;
      activeSteals.delete(key);
      if (getBalance(gid,victim.id).balance<2) return gm.edit({content:'⚠️ Hedef zaten fakirleşmiş.',components:[]});
      transfer(gid,victim.id,uid,2);
      await gm.edit({content:`💰 **${message.author.username}**, **${victim.username}**'den **2 coin** çaldı!`,components:[]});
      stealUseCounter++;
      if (stealUseCounter>=50) {
        stealUseCounter=0;
        if (calCh) {
          const ch = await client.channels.fetch(calCh).catch(()=>null);
          if (ch?.isTextBased?.()) {
            const fetched = await ch.messages.fetch({limit:100}).catch(()=>null);
            if (fetched) { const botMsgs = fetched.filter(m2=>m2.author.id===client.user.id); if(botMsgs.size) await ch.bulkDelete(botMsgs,true).catch(()=>{}); }
          }
        }
      }
    });
    return;
  }

  // ── YAZI OYUNU ─────────────────────────────────────────────
  const yaziCh = getSetting(gid,'yazi_oyunu_channel');
  if (yaziCh && cid === yaziCh) {
    if (['!yazıoyunu','!yazioyunu','!yazi-oyunu'].includes(txt)) {
      if (activeTypingGames.has(cid)) return message.reply('⏳ Bu kanalda zaten aktif bir yazı oyunu var.');
      const sentence = pick(TYPING_SENTENCES);
      await message.channel.send(`⌨️ **Yazı Oyunu** başlıyor! Aşağıdaki cümleyi **ilk ve doğru** yazan kazanır (noktalama önemsiz).\n> ${sentence}\n⏱️ Süre: **60 saniye** • Günlük limit: **4 ödül**`);
      const timeoutId = setTimeout(()=>{if(activeTypingGames.has(cid)){activeTypingGames.delete(cid);message.channel.send('⏰ Süre doldu! Kimse doğru yazamadı.').catch(()=>{});}},60_000);
      activeTypingGames.set(cid,{sentence,timeoutId});
      return;
    }
    if (['!yazıiptal','!yaziiptal'].includes(txt)) {
      if (!OWNERS.includes(uid)&&!message.member?.permissions.has(PermissionFlagsBits.ManageMessages)) return message.reply('⛔ Bu komutu kullanamazsın.');
      if (!activeTypingGames.has(cid)) return message.reply('ℹ️ Aktif yazı oyunu yok.');
      clearTimeout(activeTypingGames.get(cid).timeoutId);
      activeTypingGames.delete(cid);
      return message.reply('🛑 Yazı oyunu iptal edildi.');
    }
    if (activeTypingGames.has(cid) && !txt.startsWith('!')) {
      const game  = activeTypingGames.get(cid);
      const guess = normalizeTR(message.content);
      const target = normalizeTR(game.sentence);
      if (guess && guess === target) {
        clearTimeout(game.timeoutId);
        activeTypingGames.delete(cid);
        const day = todayTR();
        const winsKey = `${gid}:${uid}:${day}`;
        const winsToday = dailyTypingWins.get(winsKey)||0;
        if (winsToday>=4) return void message.channel.send(`⛔ **${message.author.username}**, bugün yazı oyunundan **4 ödül** aldın. Yarın tekrar dene!`);
        dailyTypingWins.set(winsKey,winsToday+1);
        addBalance(gid,uid,3);
        return void message.channel.send(`🏆 **${message.author.username}** doğru yazdı ve **+3 coin** kazandı! (Günlük: **${winsToday+1}/4**)\n> _${game.sentence}_`);
      }
    }
  } else if (['!yazıoyunu','!yazioyunu'].includes(txt) && !yaziCh) {
    // Kanal ayarlanmamışsa, aktif olan kanalda oynat (eski davranış)
    if (activeTypingGames.has(cid)) return message.reply('⏳ Bu kanalda zaten aktif bir yazı oyunu var.');
    const sentence = pick(TYPING_SENTENCES);
    await message.channel.send(`⌨️ **Yazı Oyunu** başlıyor!\n> ${sentence}\n⏱️ Süre: **60 saniye**`);
    const timeoutId = setTimeout(()=>{activeTypingGames.delete(cid);message.channel.send('⏰ Süre doldu!').catch(()=>{});},60_000);
    activeTypingGames.set(cid,{sentence,timeoutId});
    return;
  }

  // ── OWO TEST ───────────────────────────────────────────────
  if (txt === '!owo-test') {
    const owoChId = getSetting(gid,'owo_game_channel');
    if (!owoChId) return message.reply('⛔ OwO kanalı ayarlanmamış. `/setup` ile ayarla.');
    return message.reply(cid===owoChId ? '✅ Bu kanalda OwO komutlarına izin var.' : `⛔ Bu kanalda OwO komutuna izin yok. Lütfen <#${owoChId}> kullan.`);
  }

  // ── OWNER MODERASYON KOMUTLARI ─────────────────────────────
  if (txt.startsWith('!ban')) {
    if (!OWNERS.includes(uid)) return message.reply('⛔ Bu komutu sadece bot sahipleri kullanabilir.');
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
    if (!OWNERS.includes(uid)) return message.reply('⛔ Bu komutu sadece bot sahipleri kullanabilir.');
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
    const isOwner = OWNERS.includes(uid);
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
    if (!OWNERS.includes(uid)&&!message.member?.permissions.has(PermissionFlagsBits.ManageMessages)) return message.reply('⛔ Yetkin yok.');
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

  // ── OWNER SIFIRLAMA KOMUTLARI ──────────────────────────────
  if (txt === '!ses-sifirla') {
    if (!OWNERS.includes(uid)) return message.reply('⛔ Sadece bot sahipleri.');
    resetVoice(gid);
    // In-memory voicejoin temizle
    for (const k of [...voiceJoinTimes.keys()]) { if (k.startsWith(`${gid}:`)) voiceJoinTimes.delete(k); }
    const label = OWNER_LABEL[uid]||'hayhay';
    return message.reply(`🎙️ ${label} — Ses verileri sıfırlandı!`);
  }

  if (txt === '!sohbet-sifirla') {
    if (!OWNERS.includes(uid)) return message.reply('⛔ Sadece bot sahipleri.');
    resetSohbet(gid);
    const label = OWNER_LABEL[uid]||'hayhay';
    return message.reply(`💬 ${label} — Sohbet liderliği sıfırlandı!`);
  }

  if (txt === '!herşeyi sil' || txt === '!herseyi sil') {
    if (!OWNERS.includes(uid)) return message.reply('⛔ Sadece bot sahipleri kullanabilir.');
    db.prepare('DELETE FROM economy WHERE guildId=?').run(gid);
    db.prepare('DELETE FROM marriages WHERE guildId=?').run(gid);
    db.prepare('DELETE FROM rings WHERE guildId=?').run(gid);
    db.prepare('DELETE FROM xp_boosts WHERE guildId=?').run(gid);
    db.prepare('DELETE FROM daily_claims WHERE guildId=?').run(gid);
    db.prepare('DELETE FROM daily_counts WHERE guildId=?').run(gid);
    db.prepare('DELETE FROM message_counts WHERE guildId=?').run(gid);
    db.prepare('DELETE FROM voice_time WHERE guildId=?').run(gid);
    return message.reply('🧨 Bu sunucuya ait tüm veriler temizlendi.');
  }

  // ── ÇİÇEK DİYALOĞU ────────────────────────────────────────
  if (message.mentions.users.has(client.user.id) && /en sevdiğin çiçek ne/i.test(lc)) {
    return void message.reply('En sevdiğim çiçek güldür, anısı da var 😔 Seninki ne?');
  }
  if (/en sevdiğim çiçek güldür anısı var/i.test(lc)) {
    return void message.reply('Vay… o zaman aynı yerden yaralanmışız galiba 🌹 Neyse, gül güzel; dikenleri de hayatın parçası.');
  }
  if (/en sevdiğim çiçek/i.test(txt)) {
    const raw    = message.content.replace(/<@!?\d+>/g,'').trim();
    const m      = raw.match(/en sevdiğim çiçek\s+(.+)/i);
    const said   = (m&&m[1]?m[1]:'').trim().replace(/[.,!?]+$/,'');
    const found  = FLOWER_LIST.find(f=>trL(said).includes(trL(f)));
    const reply  = pick(FLOWER_REPLIES);
    if (found) return void message.reply(reply);
    return void message.reply(`Ooo ${said||'bu çiçeği'} mi diyorsun? 🌼 ${reply}`);
  }

  // ── LOL DİYALOĞU ───────────────────────────────────────────
  if (lc.includes('en sevdiğin lol karakteri')||lc.includes('en sevdigin lol karakteri')) {
    return void message.reply('En sevdiğim karakter **Zed** 💀 babasıyımdır; senin mainin ne?');
  }
  if (/mainim\s+([a-zA-Zçğıöşüİ\s'.-]+)/i.test(txt)) {
    const match = txt.match(/mainim\s+([a-zA-Zçğıöşüİ\s'.-]+)/i);
    const champ = match ? match[1].trim().toLowerCase() : null;
    if (champ) {
      const found = Object.keys(LOL_RESPONSES).find(c=>champ.includes(c));
      if (found) return void message.reply(LOL_RESPONSES[found]);
      return void message.reply(`Ooo ${champ}? Yeni meta mı çıktı babuş 😏`);
    }
  }

  // ── REPLY TABANLI OTOMATİK CEVAPLAR ───────────────────────
  if (!message.mentions.users.has(client.user.id)) {
    const refId = message.reference?.messageId;
    if (refId) {
      const replied = await message.channel.messages.fetch(refId).catch(()=>null);
      if (replied && replied.author.id === client.user.id) {
        if (lc.includes('teşekkürler sen')) return void message.reply('iyiyim teşekkürler babuş👻');
        if (lc.includes('teşekkürler')) return void message.reply('rica ederim babuş👻');
        if (lc.includes('yapıyorsun bu sporu')) return void message.reply('yerim seni kız💎💎');
        if (lc.includes('naber babuş')) return void message.reply('iyiyim sen babuş👻');
        if (lc.includes('eyw iyiyim')||lc.includes('eyvallah iyiyim')) return void message.reply('süper hep iyi ol ⭐');
      }
    }
  }

  // ── BOT MENTION + KİŞİSEL SOHBET ──────────────────────────
  if (message.mentions.users.has(client.user.id)) {
    // Kişisel soru
    const found = PERSONAL_RESPONSES.find(item=>lc.includes(item.key));
    if (found) return void message.reply(pick(found.answers));

    if (lc.includes('moralim bozuk')) return void message.reply(pick(SAD_REPLIES));
    if (lc.includes('çok mutluyum')||lc.includes('cok mutluyum')) return void message.reply(pick(HAPPY_REPLIES));

    // Gay / Lez sorusu
    if (/(gay ?m[iı]sin|gaym[iı]s[iı]n|lez ?m[iı]sin|lezbiyen ?m[iı]sin|lezm[iı]s[iı]n)/i.test(lc)) {
      return void message.reply({content:'hmmmm… düşünmem lazım 😶‍🌫️ sanırım gayım… ne bileyim ben 🤔',files:[ORIENTATION_PHOTO_URL]});
    }

    if (lc.includes('teşekkürler sen')) return void message.reply('iyiyim teşekkürler babuş👻');
    if (lc.includes('teşekkürler')) return void message.reply('rica ederim babuş👻');
    if (lc.includes('yapıyorsun bu sporu')) return void message.reply('yerim seni kız💎💎');
    if (lc.includes('naber babuş')) return void message.reply('iyiyim sen babuş👻');
    if (lc.includes('eyw iyiyim')||lc.includes('eyvallah iyiyim')) return void message.reply('süper hep iyi ol ⭐');
    if (/(günaydın|gunaydin)/.test(lc)) return void message.reply('Günaydın babuş ☀️ yüzünü yıkamayı unutma!');
    if (/(iyi akşamlar|iyi aksamlar)/.test(lc)) return void message.reply('İyi akşamlar 🌙 üstünü örtmeyi unutma, belki gece yatağına gelirim 😏');
    if (lc.includes('iyi geceler')||lc.includes('gece')) return void message.reply('İyi geceler babuş 🌙 tatlı rüyalar dilerim!');

    const onlyMention = message.content.replace(/<@!?\d+>/g,'').trim().length===0;
    if (onlyMention) return void message.reply('naber babuş 👻');
  }
});

// ──────────────────────────────────────────────────────────────
//  INTERACTION CREATE (slash + buton + select menu)
// ──────────────────────────────────────────────────────────────
client.on('interactionCreate', async interaction => {
  try {

    // ── SETUP PANELİ AÇMA ──────────────────────────────────
    if (interaction.isChatInputCommand() && interaction.commandName === 'setup') {
      // Kanal kısıtı (SETUP_CHANNEL varsa)
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

    // ── EVLİLİK BUTONLARI ─────────────────────────────────
    if (interaction.isButton()) {
      const id = interaction.customId;
      if (id.startsWith('macc_') || id.startsWith('mrej_')) return; // Collector'da işleniyor
      if (id.startsWith('cancel_steal_')) return; // Collector'da işleniyor
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
        const gid  = interaction.guild.id;
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

    // ── /yardim ─────────────────────────────────────────────
    if (cmd === 'yardim') {
      return interaction.reply({ephemeral:true, content:`📘 **DeathWish Bot Komut Listesi**

**! Prefix Komutları:** \`!yardım\` yazarak tam listeyi gör.

**Slash Komutları:**
• \`/ekonomi bakiye/gunluk/yatir/cek/transfer/siralama\`
• \`/mod ban/kick/mute/unmute/warn/temizle/kilit/slowmode\`
• \`/info sunucu/kullanici/seviye/ses-siralama\`
• \`/ticket panel/kapat\`
• \`/market-yonet ekle/cikar/liste\`
• \`/setup\` — Bot ayarları (admin)`});
    }

    // ── /ekonomi ────────────────────────────────────────────
    if (cmd === 'ekonomi') {
      if (sub === 'bakiye') {
        const target = interaction.options.getUser('kullanici')||interaction.user;
        const bal = getBalance(gid,target.id);
        return interaction.reply(`💰 **${target.username}** bakiyesi\n🪙 Cüzdan: **${bal.balance}** coin\n🏦 Banka: **${bal.bank}** coin`);
      }
      if (sub === 'gunluk') {
        const day = todayTR();
        const base = parseInt(getSetting(gid,'daily_reward')||'100');
        if (hasClaimed(gid,uid,day,'daily')) return interaction.reply({ephemeral:true,content:'⛔ Bugün zaten aldın. Yarın tekrar gel!'});
        setClaimed(gid,uid,day,'daily');
        const boost = hasBoost(gid,uid)?1.5:1;
        const reward = Math.floor(base*boost);
        addBalance(gid,uid,reward);
        return interaction.reply(`✅ Günlük **+${reward} coin** aldın! ${boost>1?'(XPBoost 🔥)':''} Bakiye: **${getBalance(gid,uid).balance}**`);
      }
      if (sub === 'yatir') {
        const amt = interaction.options.getInteger('miktar');
        const bal = getBalance(gid,uid);
        if (bal.balance<amt) return interaction.reply({ephemeral:true,content:'⛔ Yetersiz cüzdan bakiyesi.'});
        addBalance(gid,uid,-amt); addBank(gid,uid,amt);
        return interaction.reply(`🏦 **${amt}** coin bankaya yatırıldı. Bakiye: **${getBalance(gid,uid).balance}**`);
      }
      if (sub === 'cek') {
        const amt = interaction.options.getInteger('miktar');
        const bal = getBalance(gid,uid);
        if (bal.bank<amt) return interaction.reply({ephemeral:true,content:'⛔ Yetersiz banka bakiyesi.'});
        addBank(gid,uid,-amt); addBalance(gid,uid,amt);
        return interaction.reply(`💸 **${amt}** coin bankadan çekildi. Bakiye: **${getBalance(gid,uid).balance}**`);
      }
      if (sub === 'transfer') {
        const target = interaction.options.getUser('hedef');
        const amt    = interaction.options.getInteger('miktar');
        if (target.id===uid) return interaction.reply({ephemeral:true,content:'⛔ Kendine gönderemezsin.'});
        if (!transfer(gid,uid,target.id,amt)) return interaction.reply({ephemeral:true,content:'⛔ Yetersiz bakiye.'});
        return interaction.reply(`✅ <@${target.id}> kullanıcısına **${amt}** coin gönderildi!`);
      }
      if (sub === 'siralama') {
        const top = topBalance(gid,10);
        if (!top.length) return interaction.reply('🏁 Henüz coin yok.');
        return interaction.reply(`💰 **Coin Sıralaması**\n${top.map((r,i)=>`**${i+1}.** <@${r.userId}> — **${r.balance}** coin`).join('\n')}`);
      }
      if (sub === 'ver') {
        if (!OWNERS.includes(uid)) return interaction.reply({ephemeral:true,content:'⛔ Sadece bot sahipleri.'});
        const target = interaction.options.getUser('hedef');
        const amt    = interaction.options.getInteger('miktar');
        addBalance(gid,target.id,amt);
        return interaction.reply(`✅ <@${target.id}> kullanıcısına **${amt}** coin verildi.`);
      }
      if (sub === 'al') {
        if (!OWNERS.includes(uid)) return interaction.reply({ephemeral:true,content:'⛔ Sadece bot sahipleri.'});
        const target = interaction.options.getUser('hedef');
        const amt    = interaction.options.getInteger('miktar');
        addBalance(gid,target.id,-amt);
        return interaction.reply(`✅ <@${target.id}> kullanıcısından **${amt}** coin alındı.`);
      }
    }

    // ── /mod ────────────────────────────────────────────────
    if (cmd === 'mod') {
      const target = interaction.options.getUser('kullanici');
      const reason = interaction.options.getString('sebep')||'Sebep belirtilmedi';
      const member2 = target ? await interaction.guild.members.fetch(target.id).catch(()=>null) : null;

      if (sub === 'ban') {
        if (!canModerateAction(interaction.member,'ban')) return interaction.reply({ephemeral:true,content:'⛔ Ban yetkisi yok.'});
        if (!member2?.bannable) return interaction.reply({ephemeral:true,content:'⛔ Bu üyeyi banlayamıyorum.'});
        await member2.ban({reason});
        addModAction(gid,target.id,uid,'ban',interaction.channelId,0,reason);
        await sendLog(interaction.guild,'mod_log_channel',new EmbedBuilder().setTitle('🔨 Ban').setColor(0xED4245).addFields({name:'Kullanıcı',value:`${target.tag}`},{name:'Yetkili',value:`${interaction.user.tag}`},{name:'Sebep',value:reason}).setTimestamp());
        await sendLog(interaction.guild,'punishment_log_channel',new EmbedBuilder().setTitle('🔨 Ceza Aldı: Ban').setColor(0xED4245).addFields({name:'Kullanıcı',value:`<@${target.id}> (${target.tag})`},{name:'Ceza',value:'Ban'},{name:'Sebep',value:reason}).setTimestamp());
        return interaction.reply(`✅ **${target.tag}** banlandı.`);
      }
      if (sub === 'kick') {
        if (!interaction.member.permissions.has(PermissionFlagsBits.KickMembers)) return interaction.reply({ephemeral:true,content:'⛔ Kick yetkisi yok.'});
        if (!member2?.kickable) return interaction.reply({ephemeral:true,content:'⛔ Bu üyeyi kickleyemiyorum.'});
        await member2.kick(reason);
        await sendLog(interaction.guild,'mod_log_channel',new EmbedBuilder().setTitle('👢 Kick').setColor(0xFEE75C).addFields({name:'Kullanıcı',value:`${target.tag}`},{name:'Yetkili',value:`${interaction.user.tag}`},{name:'Sebep',value:reason}).setTimestamp());
        return interaction.reply(`✅ **${target.tag}** kicklendi.`);
      }
      if (sub === 'mute') {
        const mins = interaction.options.getInteger('dakika');
        if (!canModerateAction(interaction.member,'mute')) return interaction.reply({ephemeral:true,content:'⛔ Mute yetkisi yok.'});
        if (!member2?.moderatable) return interaction.reply({ephemeral:true,content:'⛔ Bu üyeyi muteleyemiyorum.'});
        await member2.timeout(mins*60000,reason);
        addModAction(gid,target.id,uid,'mute',interaction.channelId,mins,reason);
        await sendLog(interaction.guild,'mod_log_channel',new EmbedBuilder().setTitle('🔇 Mute').setColor(0xFEE75C).addFields({name:'Kullanıcı',value:`${target.tag}`},{name:'Süre',value:`${mins} dk`},{name:'Sebep',value:reason}).setTimestamp());
        await sendLog(interaction.guild,'punishment_log_channel',new EmbedBuilder().setTitle('🔇 Ceza Aldı: Mute').setColor(0xFEE75C).addFields({name:'Kullanıcı',value:`<@${target.id}> (${target.tag})`},{name:'Ceza',value:`Mute (${mins} dk)`},{name:'Sebep',value:reason}).setTimestamp());
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
        await sendLog(interaction.guild,'mod_log_channel',new EmbedBuilder().setTitle('⚠️ Uyarı').setColor(0xFEE75C).addFields({name:'Kullanıcı',value:`${target.tag}`},{name:'Uyarı #',value:`${warnCount}`},{name:'Sebep',value:reason}).setTimestamp());
        await sendLog(interaction.guild,'punishment_log_channel',new EmbedBuilder().setTitle('⚠️ Ceza Aldı: Uyarı').setColor(0xFEE75C).addFields({name:'Kullanıcı',value:`<@${target.id}> (${target.tag})`},{name:'Ceza',value:`Uyarı (Toplam: ${warnCount})`},{name:'Sebep',value:reason}).setTimestamp());
        return interaction.reply(`⚠️ **${target.tag}** uyarıldı. (Toplam uyarı: **${warnCount}**)`);
      }
      if (sub === 'uyarilar') {
        const warns2 = getWarns(gid,target.id);
        if (!warns2.length) return interaction.reply(`ℹ️ **${target.tag}** uyarısı yok.`);
        return interaction.reply(`⚠️ **${target.tag}** uyarıları:\n${warns2.map((w,i)=>`**${i+1}.** ${w.reason} (${w.createdAt})`).join('\n')}`);
      }
      if (sub === 'uyari-sil') {
        clearWarns(gid,target.id);
        return interaction.reply(`✅ **${target.tag}** tüm uyarıları silindi.`);
      }
      if (sub === 'gecmis') {
        const sum = getModSummary(gid,target.id);
        if (!sum.rows.length) return interaction.reply(`ℹ️ **${target.tag}** için moderasyon geçmişi bulunamadı.`);
        const detay = sum.rows.slice(0,10).map(r=>{
          const tip = r.type==='warn' ? '⚠️ Uyarı' : r.type==='mute' ? `🔇 Mute (${r.minutes} dk)` : '🔨 Ban';
          return `**${tip}** — <#${r.channelId}> — ${r.reason} *(${r.createdAt})*`;
        }).join('\n');
        const embed = new EmbedBuilder()
          .setTitle(`📁 ${target.tag} — Moderasyon Geçmişi`)
          .setColor(0x5865F2)
          .addFields(
            {name:'⚠️ Toplam Uyarı',value:`${sum.warnCount}`,inline:true},
            {name:'🔇 Toplam Mute',value:`${sum.muteCount}`,inline:true},
            {name:'⏱️ Toplam Mute Süresi',value:`${sum.totalMuteMinutes} dk`,inline:true},
            {name:'📜 Son İşlemler (kanal bilgili)',value:detay||'—'},
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
        const embed = new EmbedBuilder().setTitle(g.name).setThumbnail(g.iconURL()).setColor(0x5865F2)
          .addFields(
            {name:'👥 Üye',value:`${g.memberCount}`,inline:true},
            {name:'📅 Oluşturuldu',value:`<t:${Math.floor(g.createdTimestamp/1000)}:R>`,inline:true},
            {name:'👑 Sahip',value:`<@${g.ownerId}>`,inline:true}
          ).setTimestamp();
        return interaction.reply({embeds:[embed]});
      }
      if (sub === 'kullanici') {
        const target = interaction.options.getUser('hedef')||interaction.user;
        const mbr = await interaction.guild.members.fetch(target.id).catch(()=>null);
        const embed = new EmbedBuilder().setTitle(target.username).setThumbnail(target.displayAvatarURL()).setColor(0x5865F2)
          .addFields(
            {name:'🆔 ID',value:target.id,inline:true},
            {name:'📅 Katılım',value:mbr?`<t:${Math.floor(mbr.joinedTimestamp/1000)}:R>`:'?',inline:true},
            {name:'💰 Coin',value:`${getBalance(gid,target.id).balance}`,inline:true},
            {name:'🎙️ Ses',value:fmtVoice(getVoiceTime(gid,target.id)),inline:true},
            {name:'📊 Seviye',value:`${getLevel(gid,target.id).level}`,inline:true},
          ).setTimestamp();
        return interaction.reply({embeds:[embed]});
      }
      if (sub === 'seviye') {
        const target = interaction.options.getUser('hedef')||interaction.user;
        const lvl = getLevel(gid,target.id);
        return interaction.reply(`📊 **${target.username}** — Seviye: **${lvl.level}** | XP: **${lvl.xp}/${(lvl.level+1)*100}**`);
      }
      if (sub === 'seviye-siralama') {
        const top = topLevels(gid);
        if (!top.length) return interaction.reply('🏁 Henüz seviye verisi yok.');
        return interaction.reply(`📊 **Seviye Sıralaması**\n${top.map((r,i)=>`**${i+1}.** <@${r.userId}> — Seviye **${r.level}**`).join('\n')}`);
      }
      if (sub === 'ses-siralama') {
        const top = topVoice(gid);
        if (!top.length) return interaction.reply('🎙️ Henüz ses verisi yok.');
        return interaction.reply(`🎙️ **Ses Sıralaması**\n${top.map((r,i)=>`**${i+1}.** <@${r.userId}> — ${fmtVoice(r.totalSeconds)}`).join('\n')}`);
      }
      if (sub === 'ses') {
        const secs = getVoiceTime(gid,uid);
        return interaction.reply(`🎧 **${interaction.user.username}** — Toplam ses: **${fmtVoice(secs)}**`);
      }
    }

    // ── /ticket ──────────────────────────────────────────────
    if (cmd === 'ticket') {
      if (sub === 'panel') {
        if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) return interaction.reply({ephemeral:true,content:'⛔ Yetkin yok.'});
        const targetCh = interaction.options.getChannel('kanal') || interaction.channel;
        const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('ticket_open_1').setLabel('🎫 Ticket Aç').setStyle(ButtonStyle.Primary));
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

    // ── /market-yonet ────────────────────────────────────────
    if (cmd === 'market-yonet') {
      if (sub === 'ekle') {
        const role    = interaction.options.getRole('rol');
        const price   = interaction.options.getInteger('fiyat');
        const premium = interaction.options.getBoolean('premium')||false;
        addMarketRole(gid,role.id,price,premium);
        return interaction.reply(`✅ <@&${role.id}> markete eklendi. Fiyat: **${price} coin**${premium?' 👑 Premium':''}`);
      }
      if (sub === 'cikar') {
        const role = interaction.options.getRole('rol');
        removeMarketRole(gid,role.id);
        return interaction.reply(`✅ <@&${role.id}> marketten çıkarıldı.`);
      }
      if (sub === 'liste') {
        const roles = getMarketRoles(gid);
        if (!roles.length) return interaction.reply('🛒 Market boş.');
        return interaction.reply(`🛒 **Market Rolleri**\n${roles.map((r,i)=>`**${i+1}.** <@&${r.roleId}> — **${r.price} coin**${r.isPremium?' 👑':''}`).join('\n')}`);
      }
    }

  } catch (e) { console.error('interactionCreate hatası:', e); try { if (!interaction.replied&&!interaction.deferred) await interaction.reply({content:'⛔ Bir hata oluştu.',ephemeral:true}); } catch {} }
});

// ──────────────────────────────────────────────────────────────
//  SETUP PANELİ
// ──────────────────────────────────────────────────────────────
async function sendSetupPanel(interaction) {
  const gid = interaction.guild.id;
  const s   = getAllSettings(gid);
  const fmt = key => s[key] ? `<#${s[key]}>` : '_(ayarlanmamış)_';
  const fmtR = key => s[key] ? `<@&${s[key]}>` : '_(ayarlanmamış)_';
  const embed = new EmbedBuilder()
    .setTitle('⚙️ DeathWish Bot Ayar Paneli')
    .setColor(0x5865F2)
    .setDescription('Aşağıdaki menüden ayarlamak istediğin bölümü seç.')
    .addFields(
      {name:'📢 Karşılama',value:`Kanal: ${fmt('welcome_channel')}\nOto Rol: ${fmtR('welcome_auto_role')}`,inline:true},
      {name:'🚪 Ayrılma',value:`Kanal: ${fmt('leave_channel')}`,inline:true},
      {name:'📋 Log Kanalları',value:`Mesaj: ${fmt('log_message_channel')}\nBan: ${fmt('log_ban_channel')}\nSes: ${fmt('log_voice_channel')}\nÜye: ${fmt('log_member_channel')}`,inline:false},
      {name:'🎮 Oyun/Sohbet',value:`Sohbet: ${fmt('sohbet_channel')}\nYazı Oyunu: ${fmt('yazi_oyunu_channel')}\nÇal Kanalı: ${fmt('cal_channel')}\nOWO Kanalı: ${fmt('owo_game_channel')}\nRehber: ${fmt('guide_channel')}`,inline:true},
      {name:'🎫 Ticket',value:`Kanal: ${fmt('ticket_channel')}\nRol: ${fmtR('ticket_role')}`,inline:true},
      {name:'📊 Seviye',value:`Kanal: ${fmt('level_channel')}`,inline:true},
      {name:'💰 Ekonomi',value:`Başlangıç Coin: **${s.start_coin||'0'}**\nGünlük Ödül: **${s.daily_reward||'100'}**`,inline:true},
      {name:'⚖️ Mod Log / Ceza Bildirim',value:`Mod Log: ${fmt('mod_log_channel')}\nCeza Bildirim: ${fmt('punishment_log_channel')}`,inline:false},
      {name:'🛡️ Moderasyon Yetkili Rolleri',value:`Ban: ${fmtR('ban_mod_role')}\nMute: ${fmtR('mute_mod_role')}\nWarn: ${fmtR('warn_mod_role')}\n_(Ayarlanmayan işlem için varsayılan genel yetkili rolü kullanılır)_`,inline:false},
    );
  const menu = new StringSelectMenuBuilder()
    .setCustomId('setup_category')
    .setPlaceholder('Ayarlamak istediğin bölümü seç...')
    .addOptions([
      {label:'📢 Karşılama Kanalı',value:'welcome_channel',description:'Karşılama mesajı kanalını ayarla'},
      {label:'👋 Oto Rol',value:'welcome_auto_role',description:'Yeni üyelere verilecek oto rol'},
      {label:'🚪 Ayrılma Kanalı',value:'leave_channel',description:'Ayrılma mesajı kanalını ayarla'},
      {label:'💬 Sohbet Kanalı',value:'sohbet_channel',description:'Mesaj sayacı ve görev kanalı'},
      {label:'⌨️ Yazı Oyunu Kanalı',value:'yazi_oyunu_channel',description:'!yazıoyunu için özel kanal'},
      {label:'💰 Çal Komutu Kanalı',value:'cal_channel',description:'!çal komutunun kullanılacağı kanal'},
      {label:'🦜 OWO Kanalı',value:'owo_game_channel',description:'w daily vb. izin verilen kanal'},
      {label:'📔 Rehber Kanalı',value:'guide_channel',description:'Bot başlatıldığında rehber gönderilecek kanal'},
      {label:'🗑️ Mesaj Silme Logu',value:'log_message_channel',description:'Silinen mesaj log kanalı'},
      {label:'🔨 Ban Logu',value:'log_ban_channel',description:'Ban log kanalı'},
      {label:'🎙️ Ses Logu',value:'log_voice_channel',description:'Ses logu kanalı'},
      {label:'👥 Üye Logu',value:'log_member_channel',description:'Üye katılım/ayrılma logu'},
      {label:'⚖️ Mod Log Kanalı',value:'mod_log_channel',description:'Moderasyon log kanalı'},
      {label:'📣 Ceza Bildirim Kanalı',value:'punishment_log_channel',description:'Ban/Mute/Uyarı alan kullanıcıların göründüğü kanal'},
      {label:'🔨 Ban Yetkili Rolü',value:'ban_mod_role',description:'Kimlerin /mod ban kullanabileceğini belirler'},
      {label:'🔇 Mute Yetkili Rolü',value:'mute_mod_role',description:'Kimlerin /mod mute ve unmute kullanabileceğini belirler'},
      {label:'⚠️ Warn Yetkili Rolü',value:'warn_mod_role',description:'Kimlerin /mod warn kullanabileceğini belirler'},
      {label:'🎫 Ticket Kanalı',value:'ticket_channel',description:'Ticket paneli kanalı'},
      {label:'🛡️ Ticket Rolü',value:'ticket_role',description:'Ticket erişim rolü'},
      {label:'📊 Seviye Kanalı',value:'level_channel',description:'Seviye atlama mesajı kanalı'},
    ]);
  const row = new ActionRowBuilder().addComponents(menu);
  return interaction.reply({embeds:[embed],components:[row],ephemeral:true});
}

async function handleSetupInteraction(interaction, key) {
  // Kategori seçimi
  if (key === 'category') {
    const val = interaction.values[0];
    const isRole = ['welcome_auto_role','ticket_role','mute_role','mod_role','admin_role','ban_mod_role','mute_mod_role','warn_mod_role'].includes(val);
    if (isRole) {
      const menu2 = new RoleSelectMenuBuilder().setCustomId(`setup_setRole_${val}`).setPlaceholder('Rol seç...');
      return interaction.update({content:`**${val}** için rol seç:`,components:[new ActionRowBuilder().addComponents(menu2)],embeds:[]});
    }
    // Kanal seç
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
//  HATA YÖNETİMİ + GÜVENLİ LOGIN
// ──────────────────────────────────────────────────────────────
client.on('shardError',     e  => console.error('🔌 ShardError:', e));
client.on('error',          e  => console.error('🧨 Client error:', e));
client.on('warn',           m  => console.warn('⚠️ Warn:', m));
client.on('resume',         () => console.log('🔁 Session resumed'));
client.on('shardDisconnect',(ev,id) => console.warn(`🔌 Shard ${id} bağlantı koptu`));
client.on('shardReconnecting', id  => console.log(`♻️ Shard ${id} yeniden bağlanıyor...`));
client.on('shardReady',        id  => console.log(`✅ Shard ${id} hazır`));

process.on('unhandledRejection', r => console.error('UnhandledRejection:', r));
process.on('uncaughtException',  e => console.error('UncaughtException:', e));

async function startBot() {
  try {
    console.log('🔑 Login deneniyor...');
    await client.login(TOKEN);
    console.log('✅ Login başarılı!');
    // Login başarılı olduktan sonra 24 saatlik otomatik GitHub yedeğini başlat.
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
