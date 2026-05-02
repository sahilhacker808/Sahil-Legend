// ============================================================
//  SAHIL 804 BOT — APIs / downloader.js (UPDATED v4.3.0)
//  New Functions Added:
//   1. downloadYouTubeMP4()    — YouTube video download
//   2. downloadFacebook()      — Facebook video download
//   3. downloadInstagram()     — Instagram photo/video
//   4. getWeatherRapid()       — Weather via RapidAPI Weatherbit
//   5. downloadTikTok2()       — TikTok backup via RapidAPI
//   6. getRandomHadith()       — Hadith (No Key — Free API)
//   7. getMovieInfo()          — OMDB Movie (Key Required)
// ============================================================

const axios  = require('axios');
const config = require('../config/config');
const { logger, isValidUrl, truncate } = require('../utils/helpers');

// ─── AXIOS INSTANCE ───────────────────────────────────────
const api = axios.create({ timeout: config.apis.timeout || 15000 });

// ─── RAPIDAPI HEADERS HELPER ──────────────────────────────
function rapidHeaders(host) {
  return {
    'Content-Type':    'application/json',
    'x-rapidapi-host': host,
    'x-rapidapi-key':  config.apis.rapidApiKey || '',
  };
}

// ════════════════════════════════════════════════════════
//  YOUTUBE MP3
// ════════════════════════════════════════════════════════
async function downloadYouTubeMP3(url) {
  try {
    if (!isValidUrl(url)) throw new Error('Invalid URL');
    const videoId = url.match(/(?:v=|youtu\.be\/)([^&\s]+)/)?.[1];
    if (!videoId) throw new Error('Invalid YouTube URL');
    if (!config.apis.rapidApiKey) throw new Error('RAPIDAPI_KEY not configured');
    const res = await api.get(
      `https://${config.apis.youtubeMP3Host}/get_mp3_download_link/${videoId}`,
      {
        params:  { quality: 'low', wait_until_the_file_is_ready: 'false' },
        headers: rapidHeaders(config.apis.youtubeMP3Host),
      }
    );
    return res.data;
  } catch (err) { logger.error('YT MP3 error:', err.message); return null; }
}

// ════════════════════════════════════════════════════════
//  YOUTUBE MP4 (NEW)
// ════════════════════════════════════════════════════════
async function downloadYouTubeMP4(url) {
  try {
    if (!isValidUrl(url)) throw new Error('Invalid URL');
    const videoId = url.match(/(?:v=|youtu\.be\/)([^&\s]+)/)?.[1];
    if (!videoId) throw new Error('Invalid YouTube URL');
    if (!config.apis.rapidApiKey) throw new Error('RAPIDAPI_KEY not configured');
    const res = await api.get(
      `https://${config.apis.youtubeMP4Host}/get-videos-info/${videoId}`,
      {
        params:  { response_mode: 'default' },
        headers: rapidHeaders(config.apis.youtubeMP4Host),
      }
    );
    const data = res.data;
    // Try to get best video URL from response
    if (!data) return null;
    // Response structure: data.videos or data.download_url or data[0]
    const videos = data.videos || data;
    if (Array.isArray(videos) && videos.length > 0) {
      const best = videos.find(v => v.quality === '720p') || videos[0];
      return {
        title:       data.title || 'YouTube Video',
        downloadUrl: best.url || best.download_url || null,
        quality:     best.quality || 'unknown',
        thumbnail:   data.thumbnail || '',
      };
    }
    if (data.download_url) {
      return {
        title:       data.title || 'YouTube Video',
        downloadUrl: data.download_url,
        quality:     data.quality || 'unknown',
        thumbnail:   data.thumbnail || '',
      };
    }
    return null;
  } catch (err) { logger.error('YT MP4 error:', err.message); return null; }
}

// ════════════════════════════════════════════════════════
//  YOUTUBE VIDEO INFO
// ════════════════════════════════════════════════════════
async function getYouTubeInfo(url) {
  try {
    if (!isValidUrl(url)) throw new Error('Invalid URL');
    const videoId = url.match(/(?:v=|youtu\.be\/)([^&\s]+)/)?.[1];
    if (!videoId) throw new Error('Invalid YouTube URL');
    const res = await api.get(
      `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`
    );
    return {
      title:     res.data.title || 'Unknown',
      author:    res.data.author_name || 'Unknown',
      thumbnail: res.data.thumbnail_url || '',
    };
  } catch (err) { logger.error('YT Info error:', err.message); return null; }
}

// ════════════════════════════════════════════════════════
//  FACEBOOK DOWNLOADER (NEW)
// ════════════════════════════════════════════════════════
async function downloadFacebook(url) {
  try {
    if (!isValidUrl(url)) throw new Error('Invalid Facebook URL');
    if (!config.apis.rapidApiKey) throw new Error('RAPIDAPI_KEY not configured');
    const res = await api.post(
      `https://${config.apis.facebookHost}/get_media`,
      { url },
      { headers: rapidHeaders(config.apis.facebookHost) }
    );
    const data = res.data;
    if (!data) return null;
    // Response: { hd, sd, title, ... }
    return {
      hd:    data.hd    || data.HD    || null,
      sd:    data.sd    || data.SD    || null,
      title: data.title || 'Facebook Video',
    };
  } catch (err) { logger.error('Facebook error:', err.message); return null; }
}

// ════════════════════════════════════════════════════════
//  INSTAGRAM DOWNLOADER (NEW)
// ════════════════════════════════════════════════════════
async function downloadInstagram(url) {
  try {
    if (!isValidUrl(url)) throw new Error('Invalid Instagram URL');
    if (!config.apis.rapidApiKey) throw new Error('RAPIDAPI_KEY not configured');
    const res = await api.get(
      `https://${config.apis.instagramHost}/convert`,
      {
        params:  { url },
        headers: rapidHeaders(config.apis.instagramHost),
      }
    );
    const data = res.data;
    if (!data) return null;
    // Normalize response — different APIs return differently
    const mediaUrl = data.url || data.download_url || data.video_url || data.image_url
      || (Array.isArray(data.media) ? data.media[0]?.url : null)
      || (Array.isArray(data) ? data[0]?.url : null)
      || null;
    const mediaType = data.type || (mediaUrl?.includes('.mp4') ? 'video' : 'image');
    const title     = data.title || data.caption || '';
    return { url: mediaUrl, type: mediaType, title };
  } catch (err) { logger.error('Instagram error:', err.message); return null; }
}

// ════════════════════════════════════════════════════════
//  TIKTOK PRIMARY (No Key — tikwm.com)
// ════════════════════════════════════════════════════════
async function downloadTikTok(url) {
  try {
    if (!isValidUrl(url)) throw new Error('Invalid TikTok URL');
    const res = await api.post(
      config.apis.tiktokPrimary,
      new URLSearchParams({ url, hd: '0' }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    const d = res.data?.data;
    if (!d) return null;
    return {
      videoUrl: d.play || d.wmplay,
      title:    d.title  || '',
      author:   d.author?.nickname || '',
      duration: d.duration || 0,
    };
  } catch (err) { logger.error('TikTok error:', err.message); return null; }
}

// ════════════════════════════════════════════════════════
//  TIKTOK2 BACKUP (RapidAPI — NEW)
// ════════════════════════════════════════════════════════
async function downloadTikTok2(url) {
  try {
    if (!isValidUrl(url)) throw new Error('Invalid TikTok URL');
    if (!config.apis.rapidApiKey) throw new Error('RAPIDAPI_KEY not configured');
    // Extract video ID or use URL directly
    const res = await api.post(
      `https://${config.apis.tiktok2Host}/api/download`,
      { url },
      { headers: rapidHeaders(config.apis.tiktok2Host) }
    );
    const data = res.data;
    if (!data) return null;
    const videoUrl = data.play || data.video || data.download_url
      || data.data?.play || data.data?.video || null;
    const title  = data.title || data.data?.title || '';
    const author = data.author?.nickname || data.data?.author?.nickname || '';
    return { videoUrl, title, author, duration: data.duration || 0 };
  } catch (err) { logger.error('TikTok2 error:', err.message); return null; }
}

// ════════════════════════════════════════════════════════
//  WEATHER PRIMARY (No Key — wttr.in)
// ════════════════════════════════════════════════════════
async function getWeather(city) {
  try {
    const res = await api.get(`${config.apis.weather}/${encodeURIComponent(city)}?format=j1`);
    const d   = res.data.current_condition[0];
    return {
      temp:       d.temp_C,
      feels:      d.FeelsLikeC,
      desc:       d.weatherDesc[0].value,
      humidity:   d.humidity,
      wind:       d.windspeedKmph,
      visibility: d.visibility,
      uvIndex:    d.uvIndex,
    };
  } catch (err) { logger.error('Weather error:', err.message); return null; }
}

// ════════════════════════════════════════════════════════
//  WEATHER2 — RapidAPI Weatherbit (NEW)
// ════════════════════════════════════════════════════════
async function getWeatherRapid(city) {
  try {
    if (!config.apis.rapidApiKey) throw new Error('RAPIDAPI_KEY not configured');
    // First get coordinates via wttr.in then use Weatherbit
    // Simpler: use Weatherbit city search directly
    const res = await api.get(
      `https://${config.apis.weatherRapidHost}/current`,
      {
        params:  { city, units: 'M', lang: 'en' },
        headers: rapidHeaders(config.apis.weatherRapidHost),
      }
    );
    const d = res.data?.data?.[0];
    if (!d) return null;
    return {
      city:        d.city_name,
      country:     d.country_code,
      temp:        d.temp,
      feels:       d.app_temp,
      desc:        d.weather?.description || '',
      humidity:    d.rh,
      wind:        d.wind_spd,
      visibility:  d.vis,
      uvIndex:     d.uv,
      pressure:    d.pres,
      clouds:      d.clouds,
      sunrise:     d.sunrise,
      sunset:      d.sunset,
    };
  } catch (err) { logger.error('WeatherRapid error:', err.message); return null; }
}

// ════════════════════════════════════════════════════════
//  HADITH (No Key — Free API)
// ════════════════════════════════════════════════════════
async function getRandomHadith() {
  try {
    const books   = ['bukhari', 'muslim', 'tirmidhi', 'abudawud', 'ibnmajah'];
    const book    = books[Math.floor(Math.random() * books.length)];
    // Each book has different number of hadiths
    const limits  = { bukhari: 7563, muslim: 5362, tirmidhi: 3891, abudawud: 5274, ibnmajah: 4341 };
    const maxNum  = limits[book] || 1000;
    const num     = Math.floor(Math.random() * Math.min(maxNum, 300)) + 1;
    const res     = await api.get(`${config.apis.hadith}/books/${book}/${num}`);
    const data    = res.data?.data;
    if (!data) return null;
    const arabic  = data.arab  || '';
    const english = data.id    || ''; // Note: this API returns Indonesian, use truncated
    const text    = data.arab  || data.id || '';
    return {
      book:   book.charAt(0).toUpperCase() + book.slice(1),
      number: num,
      arabic: arabic.slice(0, 500),
      text:   text.slice(0, 600),
    };
  } catch (err) { logger.error('Hadith error:', err.message); return null; }
}

// ════════════════════════════════════════════════════════
//  MOVIE INFO — OMDB (Key Required)
// ════════════════════════════════════════════════════════
async function getMovieInfo(title) {
  try {
    const omdbKey = config.apis.omdbApiKey || process.env.OMDB_API_KEY;
    if (!omdbKey) return null;
    const res = await api.get(
      `https://www.omdbapi.com/?t=${encodeURIComponent(title)}&apikey=${omdbKey}`
    );
    const d = res.data;
    if (d.Response === 'False') return null;
    return {
      title:    d.Title,
      year:     d.Year,
      genre:    d.Genre,
      director: d.Director,
      rating:   d.imdbRating,
      runtime:  d.Runtime,
      plot:     truncate(d.Plot, 200),
      actors:   d.Actors,
      language: d.Language,
      country:  d.Country,
      poster:   d.Poster !== 'N/A' ? d.Poster : null,
    };
  } catch (err) { logger.error('Movie error:', err.message); return null; }
}

// ════════════════════════════════════════════════════════
//  QURAN
// ════════════════════════════════════════════════════════
async function getQuran(surah, ayah) {
  try {
    const [arRes, enRes] = await Promise.all([
      api.get(`${config.apis.quran}/ayah/${surah}:${ayah}/ar`),
      api.get(`${config.apis.quran}/ayah/${surah}:${ayah}/en.asad`),
    ]);
    let urduText = '';
    try {
      const u = await api.get(`${config.apis.quran}/ayah/${surah}:${ayah}/ur.junagarhi`);
      urduText = u.data.data.text;
    } catch { urduText = '(Urdu unavailable)'; }
    return {
      arabic:    arRes.data.data.text,
      urdu:      urduText,
      english:   enRes.data.data.text,
      surahName: arRes.data.data.surah.englishName,
      number:    `${surah}:${ayah}`,
      juz:       arRes.data.data.juz,
    };
  } catch (err) { logger.error('Quran error:', err.message); return null; }
}

// ════════════════════════════════════════════════════════
//  QURAN SURAH INFO
// ════════════════════════════════════════════════════════
async function getQuranSurah(surahNum) {
  try {
    const res = await api.get(`${config.apis.quran}/surah/${surahNum}`);
    const d   = res.data.data;
    return {
      name:            d.englishName,
      arabicName:      d.name,
      meaning:         d.englishNameTranslation,
      ayahs:           d.numberOfAyahs,
      revelationType:  d.revelationType,
    };
  } catch (err) { logger.error('Surah error:', err.message); return null; }
}

// ════════════════════════════════════════════════════════
//  PRAYER TIMES
// ════════════════════════════════════════════════════════
async function getPrayerTimes(city, country = 'Pakistan') {
  try {
    const res = await api.get(
      `${config.apis.prayer}?city=${encodeURIComponent(city)}&country=${encodeURIComponent(country)}&method=1`
    );
    return res.data.data.timings;
  } catch (err) { logger.error('Prayer error:', err.message); return null; }
}

// ════════════════════════════════════════════════════════
//  DUA
// ════════════════════════════════════════════════════════
async function getRandomDua() {
  try {
    const res  = await api.get(config.apis.dua);
    const duas = res.data;
    if (!Array.isArray(duas) || !duas.length) return null;
    const dua = duas[Math.floor(Math.random() * duas.length)];
    if (typeof dua === 'string') return dua;
    return dua.dua || dua.text || dua.arabic || JSON.stringify(dua).slice(0, 400);
  } catch (err) { logger.error('Dua error:', err.message); return null; }
}

// ════════════════════════════════════════════════════════
//  TRANSLATE
// ════════════════════════════════════════════════════════
async function translateText(text, targetLang = 'en') {
  try {
    const url = `${config.apis.translate}${encodeURIComponent(text)}&tl=${targetLang}`;
    const res = await api.get(url);
    return res.data?.[0]?.map?.(s => s?.[0]).filter(Boolean).join('') || null;
  } catch (err) { logger.error('Translate error:', err.message); return null; }
}

// ════════════════════════════════════════════════════════
//  URL SHORTENER
// ════════════════════════════════════════════════════════
async function shortenUrl(url) {
  try {
    if (!isValidUrl(url)) return null;
    const res = await api.get(`${config.apis.urlShorten}${encodeURIComponent(url)}`);
    return typeof res.data === 'string' ? res.data.trim() : null;
  } catch (err) { logger.error('URL shorten error:', err.message); return null; }
}

// ════════════════════════════════════════════════════════
//  CRYPTO
// ════════════════════════════════════════════════════════
async function getCryptoPrice(coin) {
  try {
    const res  = await api.get(
      `${config.apis.crypto}?ids=${encodeURIComponent(coin)}&vs_currencies=usd,pkr&include_24hr_change=true`
    );
    const data = res.data[coin];
    if (!data) return null;
    return {
      usd:       data.usd,
      pkr:       data.pkr,
      change24h: (data.usd_24h_change || 0).toFixed(2),
    };
  } catch (err) { logger.error('Crypto error:', err.message); return null; }
}

async function getTopCryptos() {
  try {
    const res  = await api.get(
      'https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=10&page=1'
    );
    return res.data.map(c => ({
      name:   c.name,
      symbol: c.symbol.toUpperCase(),
      price:  c.current_price,
      change: (c.price_change_percentage_24h || 0).toFixed(2),
    }));
  } catch (err) { logger.error('Top Cryptos error:', err.message); return null; }
}

// ════════════════════════════════════════════════════════
//  CURRENCY
// ════════════════════════════════════════════════════════
async function getCurrencyRates(base) {
  try {
    const res = await api.get(`${config.apis.currency}${base}`);
    return res.data.rates || null;
  } catch (err) { logger.error('Currency error:', err.message); return null; }
}

// ════════════════════════════════════════════════════════
//  WIKIPEDIA
// ════════════════════════════════════════════════════════
async function getWikipedia(query) {
  try {
    const res = await api.get(`${config.apis.wikipedia}${encodeURIComponent(query)}`);
    const d   = res.data;
    if (d.type === 'disambiguation') return null;
    return {
      title:   d.title,
      summary: truncate(d.extract, 400),
      url:     d.content_urls?.desktop?.page || '',
    };
  } catch (err) { logger.error('Wikipedia error:', err.message); return null; }
}

// ════════════════════════════════════════════════════════
//  DICTIONARY
// ════════════════════════════════════════════════════════
async function getDictionary(word) {
  try {
    const res = await api.get(`${config.apis.dictionary}${encodeURIComponent(word)}`);
    const d   = res.data[0];
    if (!d) return null;
    const meaning = d.meanings[0];
    return {
      word:        d.word,
      phonetic:    d.phonetic || '',
      partOfSpeech: meaning.partOfSpeech || '',
      meaning:     meaning.definitions[0]?.definition || '',
      example:     meaning.definitions[0]?.example || '',
      synonyms:    meaning.definitions[0]?.synonyms?.slice(0, 5).join(', ') || 'None',
    };
  } catch (err) { logger.error('Dictionary error:', err.message); return null; }
}

// ════════════════════════════════════════════════════════
//  NEWS
// ════════════════════════════════════════════════════════
async function getNews() {
  try {
    const res = await api.get(config.apis.news);
    return (res.data.items || []).slice(0, 8).map(a => ({ title: a.title, link: a.link }));
  } catch (err) { logger.error('News error:', err.message); return []; }
}

// ════════════════════════════════════════════════════════
//  SIM INFO
// ════════════════════════════════════════════════════════
async function getSimInfo(number) {
  try {
    const clean = number.replace(/[^0-9]/g, '');
    const res   = await api.get(`${config.apis.simDb}${clean}`);
    return res.data || null;
  } catch (err) { logger.error('SIM error:', err.message); return null; }
}

// ════════════════════════════════════════════════════════
//  GITHUB USER
// ════════════════════════════════════════════════════════
async function getGithubUser(username) {
  try {
    const res = await api.get(`https://api.github.com/users/${encodeURIComponent(username)}`);
    const d   = res.data;
    return {
      name:      d.name || d.login,
      login:     d.login,
      bio:       d.bio || 'No bio',
      repos:     d.public_repos,
      followers: d.followers,
      location:  d.location || 'Unknown',
      url:       d.html_url,
    };
  } catch (err) { logger.error('GitHub error:', err.message); return null; }
}

// ════════════════════════════════════════════════════════
//  NPM PACKAGE
// ════════════════════════════════════════════════════════
async function getNpmPackage(name) {
  try {
    const res = await api.get(`https://registry.npmjs.org/${encodeURIComponent(name)}`);
    const d   = res.data;
    const ver = d['dist-tags']?.latest || '';
    return {
      name:        d.name,
      version:     ver,
      description: d.description || '',
      author:      d.author?.name || 'Unknown',
      license:     d.license || 'Unknown',
    };
  } catch (err) { logger.error('NPM error:', err.message); return null; }
}

// ════════════════════════════════════════════════════════
//  IP INFO
// ════════════════════════════════════════════════════════
async function getIpInfo(ip) {
  try {
    const res = await api.get(`https://ipapi.co/${encodeURIComponent(ip)}/json/`);
    const d   = res.data;
    if (d.error) return null;
    return {
      ip:       d.ip,
      city:     d.city,
      region:   d.region,
      country:  d.country_name,
      org:      d.org,
      timezone: d.timezone,
    };
  } catch (err) { logger.error('IP error:', err.message); return null; }
}

// ════════════════════════════════════════════════════════
//  COVID STATS
// ════════════════════════════════════════════════════════
async function getCovidStats(country) {
  try {
    const res = await api.get(`https://disease.sh/v3/covid-19/countries/${encodeURIComponent(country)}`);
    const d   = res.data;
    return {
      country:    d.country,
      cases:      d.cases?.toLocaleString(),
      deaths:     d.deaths?.toLocaleString(),
      recovered:  d.recovered?.toLocaleString(),
      active:     d.active?.toLocaleString(),
      todayCases: d.todayCases?.toLocaleString(),
    };
  } catch (err) { logger.error('COVID error:', err.message); return null; }
}

// ════════════════════════════════════════════════════════
//  ONLINE JOKE
// ════════════════════════════════════════════════════════
async function getOnlineJoke() {
  try {
    const res = await api.get('https://official-joke-api.appspot.com/random_joke');
    return `${res.data.setup}\n\n${res.data.punchline}`;
  } catch (err) { logger.error('Joke error:', err.message); return null; }
}

// ════════════════════════════════════════════════════════
//  ONLINE QUOTE
// ════════════════════════════════════════════════════════
async function getOnlineQuote() {
  try {
    const res = await api.get('https://api.quotable.io/random');
    return { text: res.data.content, author: res.data.author };
  } catch (err) { logger.error('Quote error:', err.message); return null; }
}

// ════════════════════════════════════════════════════════
//  ADVICE
// ════════════════════════════════════════════════════════
async function getAdvice() {
  try {
    const res = await api.get('https://api.adviceslip.com/advice');
    return res.data.slip?.advice || null;
  } catch (err) { logger.error('Advice error:', err.message); return null; }
}

// ════════════════════════════════════════════════════════
//  CAT FACT
// ════════════════════════════════════════════════════════
async function getCatFact() {
  try {
    const res = await api.get('https://catfact.ninja/fact');
    return res.data.fact || null;
  } catch (err) { logger.error('CatFact error:', err.message); return null; }
}

// ════════════════════════════════════════════════════════
//  DOG FACT
// ════════════════════════════════════════════════════════
async function getDogFact() {
  try {
    const res = await api.get('https://dogapi.dog/api/v2/facts');
    return res.data.data?.[0]?.attributes?.body || null;
  } catch (err) { logger.error('DogFact error:', err.message); return null; }
}

// ════════════════════════════════════════════════════════
//  COUNTRY INFO
// ════════════════════════════════════════════════════════
async function getCountryInfo(name) {
  try {
    const res = await api.get(`https://restcountries.com/v3.1/name/${encodeURIComponent(name)}?fullText=true`);
    const d   = res.data[0];
    return {
      name:       d.name.common,
      capital:    d.capital?.[0] || 'Unknown',
      population: d.population?.toLocaleString(),
      region:     d.region,
      currency:   Object.values(d.currencies || {})[0]?.name || 'Unknown',
      languages:  Object.values(d.languages || {}).join(', '),
      flag:       d.flag || '',
    };
  } catch (err) { logger.error('Country error:', err.message); return null; }
}

// ════════════════════════════════════════════════════════
//  PROGRAMMING JOKE
// ════════════════════════════════════════════════════════
async function getProgrammingJoke() {
  try {
    const res = await api.get('https://v2.jokeapi.dev/joke/Programming?type=twopart');
    if (res.data.type === 'twopart') return `${res.data.setup}\n\n${res.data.delivery}`;
    return res.data.joke || null;
  } catch (err) { logger.error('DevJoke error:', err.message); return null; }
}

// ════════════════════════════════════════════════════════
//  RANDOM WORD
// ════════════════════════════════════════════════════════
async function getRandomWord() {
  try {
    const res = await api.get('https://random-word-api.herokuapp.com/word');
    return res.data?.[0] || null;
  } catch (err) { logger.error('RandomWord error:', err.message); return null; }
}

// ════════════════════════════════════════════════════════
//  RIDDLE
// ════════════════════════════════════════════════════════
async function getRiddle() {
  try {
    const res = await api.get('https://riddles-api.vercel.app/random');
    return { question: res.data.riddle, answer: res.data.answer };
  } catch (err) { logger.error('Riddle error:', err.message); return null; }
}

// ════════════════════════════════════════════════════════
//  USELESS FACT
// ════════════════════════════════════════════════════════
async function getUselessFact() {
  try {
    const res = await api.get('https://uselessfacts.jsph.pl/api/v2/facts/random');
    return res.data.text || null;
  } catch (err) { logger.error('UselessFact error:', err.message); return null; }
}

// ════════════════════════════════════════════════════════
//  NUMBER FACT
// ════════════════════════════════════════════════════════
async function getNumberFact(num) {
  try {
    const res = await api.get(`http://numbersapi.com/${num}`);
    return typeof res.data === 'string' ? res.data : null;
  } catch (err) { logger.error('NumberFact error:', err.message); return null; }
}

// ════════════════════════════════════════════════════════
//  WORLD TIME
// ════════════════════════════════════════════════════════
async function getWorldTime(timezone) {
  try {
    const res = await api.get(`https://worldtimeapi.org/api/timezone/${encodeURIComponent(timezone)}`);
    const d   = res.data;
    return {
      timezone:  d.timezone,
      datetime:  d.datetime?.slice(0, 19).replace('T', ' '),
      utcOffset: d.utc_offset,
      dayOfWeek: d.day_of_week,
    };
  } catch (err) { logger.error('World time error:', err.message); return null; }
}

// ════════════════════════════════════════════════════════
//  LYRICS
// ════════════════════════════════════════════════════════
async function getLyrics(artist, title) {
  try {
    const res = await api.get(
      `https://api.lyrics.ovh/v1/${encodeURIComponent(artist)}/${encodeURIComponent(title)}`
    );
    return res.data?.lyrics ? truncate(res.data.lyrics, 800) : null;
  } catch (err) { logger.error('Lyrics error:', err.message); return null; }
}

// ════════════════════════════════════════════════════════
//  CALCULATE AGE
// ════════════════════════════════════════════════════════
function calculateAge(dateStr) {
  try {
    const birth = new Date(dateStr);
    if (isNaN(birth)) return null;
    const now   = new Date();
    let years   = now.getFullYear() - birth.getFullYear();
    let months  = now.getMonth()    - birth.getMonth();
    let days    = now.getDate()     - birth.getDate();
    if (days < 0)   { months--; days   += new Date(now.getFullYear(), now.getMonth(), 0).getDate(); }
    if (months < 0) { years--;  months += 12; }
    const totalDays = Math.floor((now - birth) / (1000 * 60 * 60 * 24));
    return { years, months, days, totalDays };
  } catch { return null; }
}

// ════════════════════════════════════════════════════════
//  CALCULATE BMI
// ════════════════════════════════════════════════════════
function calculateBMI(weight, height) {
  const h   = height / 100;
  const bmi = (weight / (h * h)).toFixed(1);
  let cat   = 'Normal';
  if (bmi < 18.5)      cat = 'Underweight';
  else if (bmi < 25)   cat = 'Normal';
  else if (bmi < 30)   cat = 'Overweight';
  else                 cat = 'Obese';
  return { bmi, category: cat };
}

// ════════════════════════════════════════════════════════
//  GENERATE PASSWORD
// ════════════════════════════════════════════════════════
function generatePassword(len = 12) {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*()_+';
  return Array.from({ length: len }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

// ════════════════════════════════════════════════════════
//  BASE64
// ════════════════════════════════════════════════════════
function encodeBase64(text)  { return Buffer.from(text).toString('base64'); }
function decodeBase64(text)  {
  try { return Buffer.from(text, 'base64').toString('utf-8'); } catch { return null; }
}

// ════════════════════════════════════════════════════════
//  BINARY
// ════════════════════════════════════════════════════════
function toBinary(text) {
  return text.split('').map(c => c.charCodeAt(0).toString(2).padStart(8, '0')).join(' ');
}
function fromBinary(bin) {
  try {
    return bin.trim().split(/\s+/).map(b => String.fromCharCode(parseInt(b, 2))).join('');
  } catch { return null; }
}

// ════════════════════════════════════════════════════════
//  MORSE CODE
// ════════════════════════════════════════════════════════
const MORSE_MAP = {
  A:'.-',B:'-...',C:'-.-.',D:'-..',E:'.',F:'..-.',G:'--.',H:'....',I:'..',J:'.---',
  K:'-.-',L:'.-..',M:'--',N:'-.',O:'---',P:'.--.',Q:'--.-',R:'.-.',S:'...',T:'-',
  U:'..-',V:'...-',W:'.--',X:'-..-',Y:'-.--',Z:'--..',
  '0':'-----','1':'.----','2':'..---','3':'...--','4':'....-','5':'.....',
  '6':'-....','7':'--...','8':'---..','9':'----.','.':'.-.-.-',',':'--..--',
  '?':'..--..','/':'-..-.','@':'.--.-.','&':'.-...','=':'-...-',
};
const MORSE_REV = Object.fromEntries(Object.entries(MORSE_MAP).map(([k, v]) => [v, k]));

function toMorse(text) {
  return text.toUpperCase().split('').map(c => MORSE_MAP[c] || (c === ' ' ? '/' : '?')).join(' ');
}
function fromMorse(morse) {
  return morse.trim().split(' / ').map(word =>
    word.trim().split(' ').map(code => MORSE_REV[code] || '?').join('')
  ).join(' ');
}

// ════════════════════════════════════════════════════════
//  COLOR INFO
// ════════════════════════════════════════════════════════
async function getColorInfo(hex) {
  try {
    const res = await api.get(`https://www.thecolorapi.com/id?hex=${hex}`);
    const d   = res.data;
    return {
      name: d.name?.value || 'Unknown',
      hex:  d.hex?.value  || `#${hex}`,
      rgb:  `rgb(${d.rgb?.r}, ${d.rgb?.g}, ${d.rgb?.b})`,
      hsl:  `hsl(${d.hsl?.h}, ${d.hsl?.s}%, ${d.hsl?.l}%)`,
    };
  } catch (err) { logger.error('Color error:', err.message); return null; }
}

// ════════════════════════════════════════════════════════
//  LOVE METER
// ════════════════════════════════════════════════════════
function getLoveMeter(name1, name2) {
  const combined = (name1 + name2).toLowerCase();
  let score = 0;
  for (const ch of combined) score += ch.charCodeAt(0);
  const percent = score % 101;
  let emoji = '💔';
  if (percent >= 90) emoji = '💑 Perfect Match!';
  else if (percent >= 70) emoji = '❤️ Great Love!';
  else if (percent >= 50) emoji = '💕 Good Match!';
  else if (percent >= 30) emoji = '💙 Friendship Zone';
  else emoji = '💔 Not a Match';
  return { percent, emoji };
}

// ════════════════════════════════════════════════════════
//  HOROSCOPE
// ════════════════════════════════════════════════════════
function getHoroscope(sign) {
  const readings = {
    aries:       { sign: '♈ Aries', reading: 'Bold moves bring success today. Trust your instincts!' },
    taurus:      { sign: '♉ Taurus', reading: 'Patience is your strength. Financial gains are near.' },
    gemini:      { sign: '♊ Gemini', reading: 'Communication is key today. Speak your heart!' },
    cancer:      { sign: '♋ Cancer', reading: 'Emotional healing is happening. Trust the process.' },
    leo:         { sign: '♌ Leo', reading: 'Your charisma shines bright today. Leadership awaits!' },
    virgo:       { sign: '♍ Virgo', reading: 'Attention to detail pays off. Organization brings rewards.' },
    libra:       { sign: '♎ Libra', reading: 'Balance in relationships brings harmony today.' },
    scorpio:     { sign: '♏ Scorpio', reading: 'Deep transformation is occurring. Embrace change!' },
    sagittarius: { sign: '♐ Sagittarius', reading: 'Adventure calls! Explore new horizons today.' },
    capricorn:   { sign: '♑ Capricorn', reading: 'Hard work is paying off. Success is within reach!' },
    aquarius:    { sign: '♒ Aquarius', reading: 'Innovation and creativity flow through you today.' },
    pisces:      { sign: '♓ Pisces', reading: 'Intuition is strong. Trust your inner voice.' },
  };
  return readings[sign.toLowerCase()] || null;
}

// ════════════════════════════════════════════════════════
//  ZODIAC SIGN
// ════════════════════════════════════════════════════════
function getZodiacSign(day, month) {
  const d = parseInt(day), m = parseInt(month);
  if ((m === 3 && d >= 21) || (m === 4 && d <= 19))  return '♈ Aries';
  if ((m === 4 && d >= 20) || (m === 5 && d <= 20))  return '♉ Taurus';
  if ((m === 5 && d >= 21) || (m === 6 && d <= 20))  return '♊ Gemini';
  if ((m === 6 && d >= 21) || (m === 7 && d <= 22))  return '♋ Cancer';
  if ((m === 7 && d >= 23) || (m === 8 && d <= 22))  return '♌ Leo';
  if ((m === 8 && d >= 23) || (m === 9 && d <= 22))  return '♍ Virgo';
  if ((m === 9 && d >= 23) || (m === 10 && d <= 22)) return '♎ Libra';
  if ((m === 10 && d >= 23) || (m === 11 && d <= 21)) return '♏ Scorpio';
  if ((m === 11 && d >= 22) || (m === 12 && d <= 21)) return '♐ Sagittarius';
  if ((m === 12 && d >= 22) || (m === 1 && d <= 19))  return '♑ Capricorn';
  if ((m === 1 && d >= 20) || (m === 2 && d <= 18))   return '♒ Aquarius';
  return '♓ Pisces';
}

// ════════════════════════════════════════════════════════
//  EXPORTS
// ════════════════════════════════════════════════════════
module.exports = {
  // Downloads
  downloadYouTubeMP3,
  downloadYouTubeMP4,
  downloadFacebook,
  downloadInstagram,
  downloadTikTok,
  downloadTikTok2,
  getYouTubeInfo,

  // Weather
  getWeather,
  getWeatherRapid,

  // Islamic
  getQuran,
  getQuranSurah,
  getPrayerTimes,
  getRandomDua,
  getRandomHadith,

  // Info
  getMovieInfo,
  getGithubUser,
  getNpmPackage,
  getIpInfo,
  getCovidStats,
  getCountryInfo,
  getSimInfo,
  getWikipedia,
  getDictionary,
  getNews,

  // Fun
  getOnlineJoke,
  getOnlineQuote,
  getAdvice,
  getCatFact,
  getDogFact,
  getProgrammingJoke,
  getRandomWord,
  getRiddle,
  getUselessFact,
  getNumberFact,
  getLyrics,
  getWorldTime,

  // Crypto & Finance
  getCryptoPrice,
  getTopCryptos,
  getCurrencyRates,

  // Utilities
  translateText,
  shortenUrl,
  getColorInfo,
  getLoveMeter,
  getHoroscope,
  getZodiacSign,
  calculateAge,
  calculateBMI,
  generatePassword,
  encodeBase64,
  decodeBase64,
  toBinary,
  fromBinary,
  toMorse,
  fromMorse,
};
