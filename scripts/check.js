// Setup doctor: says exactly what is configured, what is missing, and what to
// do about it. Run with `npm run check` any time something is not working.

import 'dotenv/config';
import { getQuota, ensureFolder } from '../src/google.js';
import { dbEnabled, db } from '../src/db.js';

const env = process.env;
const ok = (m) => console.log(`  \x1b[32mOK\x1b[0m    ${m}`);
const bad = (m, fix) => { console.log(`  \x1b[31mMISS\x1b[0m  ${m}`); if (fix) console.log(`        -> ${fix}`); };
const warn = (m, fix) => { console.log(`  \x1b[33mOFF\x1b[0m   ${m}`); if (fix) console.log(`        -> ${fix}`); };
const human = (b) => {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let n = Number(b) || 0, i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(1)} ${u[i]}`;
};

let fatal = false;
console.log('\nGoogle Drive');

for (const key of ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET']) {
  if (env[key]) ok(key);
  else { bad(key, 'console.cloud.google.com -> Credentials -> OAuth client ID'); fatal = true; }
}

if (env.GOOGLE_REFRESH_TOKEN) {
  ok('GOOGLE_REFRESH_TOKEN');
  try {
    const q = await getQuota(env);
    const folder = await ensureFolder(env);
    ok(`Signed in as ${q.email}`);
    ok(`Destination folder ${folder}`);
    ok(q.limit === null
      ? `${human(q.usage)} used (unlimited)`
      : `${human(q.free)} free of ${human(q.limit)}`);
  } catch (err) {
    bad(`Google rejected the token: ${err.message.split('.')[0]}`, 'npm run auth');
    fatal = true;
  }
} else {
  bad('GOOGLE_REFRESH_TOKEN', 'npm run auth');
  fatal = true;
}

console.log('\nSupabase (optional — upload log and dashboard)');
if (!dbEnabled) {
  warn('Not configured', 'Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env');
} else {
  ok('SUPABASE_URL');
  const { error } = await db.from('uploads').select('id', { count: 'exact', head: true });
  if (error) bad(`Cannot reach the database: ${error.message}`, 'Check the service_role key');
  else {
    ok('Connected, uploads table reachable');
    const { count } = await db.from('uploads').select('id', { count: 'exact', head: true });
    ok(`${count ?? 0} upload(s) recorded`);
  }
}

console.log('\nTelegram bot (optional)');
if (!env.TELEGRAM_BOT_TOKEN) {
  warn('Not configured', 'Get a token from @BotFather, then: npm run bot');
} else {
  try {
    const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getMe`);
    const json = await res.json();
    if (json.ok) ok(`Bot @${json.result.username}`);
    else bad(`Telegram rejected the token: ${json.description}`, 'Re-check it with @BotFather');
  } catch (err) {
    bad(`Could not reach Telegram: ${err.message}`);
  }
}

console.log('\nGuard rails');
env.ACCESS_CODE ? ok('ACCESS_CODE set — uploads need the code')
  : warn('ACCESS_CODE blank — anyone with the link can upload',
         'Set it before putting this on the public internet');
env.OWNER_CODE ? ok('OWNER_CODE set — /dashboard.html available')
  : warn('OWNER_CODE blank — dashboard disabled', 'Set it to use /dashboard.html');
ok(`Max file size ${env.MAX_FILE_MB || 512} MB`);
ok(`Max ${env.MAX_UPLOADS_PER_HOUR || 30} uploads per hour per IP`);

console.log(fatal
  ? '\nNot ready yet — fix the MISS lines above.\n'
  : '\nReady. Start it with: npm start\n');
process.exit(fatal ? 1 : 0);
