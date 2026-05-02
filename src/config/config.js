'use strict';
// ============================================================
//  SAHIL 804 BOT — Master Config (No Firebase Edition)
// ============================================================

require('dotenv').config();

// ─── STARTUP VALIDATION ──────────────────────────────────
const REQUIRED_ENV = ['SESSION_SECRET', 'ADMIN_PASSWORD'];
const missing = REQUIRED_ENV.filter(k => !process.env[k]);
if (missing.length > 0) {
  console.error('\n╔══════════════════════════════════════════╗');
  console.error('║   ❌  STARTUP FAILED — MISSING ENV VARS  ║');
  console.error('╚══════════════════════════════════════════╝\n');
  missing.forEach(k => console.error(`  ✗ ${k}`));
  console.error('\nFix: Copy .env.example → .env and fill values.\n');
  process.exit(1);
}

if (process.env.ADMIN_PASSWORD === 'admin123') {
  console.warn('[CONFIG WARN] ⚠️  Default admin password detected! Change ADMIN_PASSWORD now!');
}

const OPTIONAL_KEYS = [
  { key: 'RAPIDAPI_KEY',    commands: '.ytmp3 .ytmp4 .fb .ig .tiktok2 .weather2' },
  { key: 'OMDB_API_KEY',    commands: '.movie' },
  { key: 'OPENWEATHER_KEY', commands: '.weather2' },
];
OPTIONAL_KEYS.forEach(({ key, commands }) => {
  if (!process.env[key]) {
    console.warn(`[CONFIG WARN] ⚠️  ${key} not set — ${commands} will not work.`);
  }
});

const config = {
  env:  process.env.NODE_ENV || 'production',
  port: parseInt(process.env.PORT, 10) || 3000,

  sessionSecret: process.env.SESSION_SECRET,

  owner: {
    number:  process.env.OWNER_NUMBER  || '923496049312',
    backup:  process.env.OWNER_BACKUP  || '923711158307',
    name:    process.env.OWNER_NAME    || '𝑳𝒆𝒈𝒆𝒏𝒅 𝑺𝒂𝒉𝒊𝒍 𝑯𝒂𝒄𝒌𝒆𝒓 𝟖𝟎𝟒',
    email:   process.env.ADMIN_EMAIL   || 'sahilhackerx110@gmail.com',
    channel: 'https://whatsapp.com/channel/0029Vb7ufE7It5rzLqedDc3l',
    image:   'https://i.ibb.co/Vc2LHyqv/IMG-20260408-WA0014.jpg',
  },

  bot: {
    name:              process.env.BOT_NAME   || 'SAHIL 804 BOT',
    prefix:            process.env.BOT_PREFIX || '.',
    version:           '4.3.0-NoFirebase',
    sessionIdRegex:    /^SAHIL-[A-Z0-9]{8}$/,
    maxBotsPerUser:    { monthly: 10, yearly: 999, free: 0 },
    reconnectDelay:    5000,
    keepAliveInterval: 25000,
    connectTimeout:    60000,
  },

  apis: {
    rapidApiKey:      process.env.RAPIDAPI_KEY,
    youtubeMP3Host:   'youtube-mp3-audio-video-downloader.p.rapidapi.com',
    youtubeMP4Host:   'youtube-video-fast-downloader-24-7.p.rapidapi.com',
    facebookHost:     'facebook-media-downloader1.p.rapidapi.com',
    instagramHost:    'instagram-downloader-download-instagram-stories-videos4.p.rapidapi.com',
    tiktokPrimary:    'https://www.tikwm.com/api/',
    tiktok2Host:      'tiktok-api23.p.rapidapi.com',
    weather:          'https://wttr.in',
    weatherRapidHost: 'weatherbit-v1-mashape.p.rapidapi.com',
    openWeatherKey:   process.env.OPENWEATHER_KEY,
    omdbApiKey:       process.env.OMDB_API_KEY,
    hadith:           'https://api.hadith.gading.dev',
    quran:            'https://api.alquran.cloud/v1',
    prayer:           'https://api.aladhan.com/v1/timingsByCity',
    dua:              'https://raw.githubusercontent.com/nawajalqari/duaa-api/main/duaa.json',
    news:             'https://rss2json.com/api.json?rss_url=https://feeds.bbci.co.uk/news/rss.xml',
    translate:        'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=en&dt=t&q=',
    urlShorten:       'https://tinyurl.com/api-create.php?url=',
    crypto:           'https://api.coingecko.com/api/v3/simple/price',
    currency:         'https://api.exchangerate-api.com/v4/latest/',
    wikipedia:        'https://en.wikipedia.org/api/rest_v1/page/summary/',
    dictionary:       'https://api.dictionaryapi.dev/api/v2/entries/en/',
    simDb:            'https://ammar-sim-database-api-786.vercel.app/api/database?number=',
    tts:              'https://translate.google.com/translate_tts?ie=UTF-8&tl=en&client=tw-ob&q=',
    timeout:          15000,
  },

  reactEmojis: ['❤️','🔥','😍','👏','🎉','💯','⚡','🌟','💪','👌','😂','🥰','🤩','🙌','✨','💥','🎊','🏆','💎','🚀','😎','🤣','💀','👀','🫶','🥳','😘','🫡','🤙','💫'],

  reactKeywords: {
    sad:   { words: ['sad','cry','broken','crying'],                              emoji: '😢' },
    happy: { words: ['happy','congrats','birthday','celebrate','congratulation'], emoji: '🎉' },
    love:  { words: ['love','heart','lovely'],                                    emoji: '❤️' },
    funny: { words: ['lol','haha','funny','joke','laugh'],                        emoji: '😂' },
    angry: { words: ['angry','mad','furious'],                                    emoji: '😡' },
    wow:   { words: ['wow','amazing','incredible','unbelievable'],                emoji: '🤩' },
    food:  { words: ['food','pizza','hungry','eat','burger'],                     emoji: '😋' },
    fire:  { words: ['fire','lit','beast','hot'],                                 emoji: '🔥' },
    win:   { words: ['win','champ','legend','victory'],                           emoji: '🏆' },
  },

  admin: {
    email:    process.env.ADMIN_EMAIL    || 'sahilhackerx110@gmail.com',
    password: process.env.ADMIN_PASSWORD,
  },

  rateLimit: {
    general: { windowMs: 60 * 1000,      max: 30, message: { error: 'Too many requests. Slow down.' } },
    pairing: { windowMs: 10 * 60 * 1000, max: 5,  message: { error: 'Too many pairing attempts. Try again in 10 minutes.' } },
    auth:    { windowMs: 15 * 60 * 1000, max: 10, message: { error: 'Too many auth attempts. Try again later.' } },
  },

  session: {
    cookie: {
      secure:   process.env.NODE_ENV === 'production',
      httpOnly: true,
      maxAge:   24 * 60 * 60 * 1000,
      sameSite: 'lax',
    },
    resave:            false,
    saveUninitialized: false,
  },
};

config.botMode = 'public';

config.features = {
  autoReact:   process.env.AUTO_REACT    !== 'false',
  autoReply:   process.env.AUTO_REPLY    !== 'false',
  autoRead:    process.env.AUTO_READ     !== 'false',
  antiDelete:  process.env.ANTI_DELETE   !== 'false',
  welcomeMsg:  process.env.WELCOME_MSG   !== 'false',
  goodbyeMsg:  process.env.GOODBYE_MSG   !== 'false',
  antiSpam:    process.env.ANTI_SPAM     !== 'false',
  antiLink:    process.env.ANTI_LINK     === 'true',
  antiBot:     process.env.ANTI_BOT      !== 'false',
  antiBadWord: process.env.ANTI_BAD_WORD === 'true',
  autoStatus:  false,
  chatbot:     process.env.CHATBOT       === 'true',
  tts:         process.env.TTS           !== 'false',
  viewOnce:    process.env.VIEW_ONCE     !== 'false',
  antiDelete2: process.env.ANTI_DELETE2  !== 'false',
};

config.chatbotSessions = new Map();

config.chatbot = {
  enabled: false,
  smartReplies: {
    greetings: { words: ['hi','hello','hey','salam'],                reply: '👋 𝑯𝒆𝒍𝒍𝒐! 𝑯𝒐𝒘 𝒄𝒂𝒏 𝑰 𝒉𝒆𝒍𝒑? 😊' },
    howAreYou: { words: ['how are you','kya haal','kaisa'],         reply: '😊 𝑰 𝒂𝒎 𝒅𝒐𝒊𝒏𝒈 𝒈𝒓𝒆𝒂𝒕! 🌟' },
    thanks:    { words: ['thanks','thank you','shukriya'],           reply: '🙏 𝑾𝒆𝒍𝒄𝒐𝒎𝒆! ❤️' },
    bye:       { words: ['bye','goodbye','allah hafiz'],             reply: '👋 𝑮𝒐𝒐𝒅𝒃𝒚𝒆! 𝑻𝒂𝒌𝒆 𝒄𝒂𝒓𝒆 😊' },
  },
};

config.spam = { maxMessages: 10, timeWindow: 10000, warnBefore: 7 };

config.subscription = {
  monthly: { price: 500,  botsLimit: 10      },
  yearly:  { price: 1500, botsLimit: Infinity },
};

module.exports = config;
