const axios = require('axios');

let prices = {};
let currentMarket = null;

function parseMarketTimes(title) {
  try {
    const match = title.match(/(\w+)\s+(\d+),\s*(\d+):(\d+)(AM|PM)-(\d+):(\d+)(AM|PM)\s*ET/i);
    if (!match) return null;

    const [_, month, day, startH, startM, startAmPm, endH, endM, endAmPm] = match;

    const monthNames = ['january','february','march','april','may','june',
                        'july','august','september','october','november','december'];
    const monthIndex = monthNames.indexOf(month.toLowerCase());
    const year = 2026;

    const toUTC = (h, m, ampm) => {
      let hour = parseInt(h);
      if (ampm.toUpperCase() === 'PM' && hour !== 12) hour += 12;
      if (ampm.toUpperCase() === 'AM' && hour === 12) hour = 0;
      const dateStr = `${year}-${String(monthIndex + 1).padStart(2,'0')}-${String(parseInt(day)).padStart(2,'0')}T${String(hour).padStart(2,'0')}:${m}:00-04:00`;
      return new Date(dateStr);
    };

    const start = toUTC(startH, startM, startAmPm);
    const end   = toUTC(endH,   endM,   endAmPm);

    const durationMinutes = (end - start) / 60000;
    if (durationMinutes !== 5) return null;

    return { start, end };
  } catch (e) {
    console.error('❌ Parse error:', e.message, title);
    return null;
  }
}

async function findBitcoinMarket() {
  try {
    const now = new Date();

    // Fechas en ET para hoy y mañana
    const etNow      = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const etTomorrow = new Date(etNow);
    etTomorrow.setDate(etTomorrow.getDate() + 1);

    const getLabel = (d) => {
      const month = d.toLocaleString('en-US', { month: 'long' }).toLowerCase();
      return `${month} ${d.getDate()}`; // "april 27"
    };

    const todayET    = getLabel(etNow);
    const tomorrowET = getLabel(etTomorrow);

    console.log(`📅 Buscando: "${todayET}" y "${tomorrowET}"`);
    console.log(`🕐 UTC: ${now.toISOString()}`);
    console.log(`🕐 ET:  ${now.toLocaleString('en-US', { timeZone: 'America/New_York' })}`);

    const [activeRes, closedRes] = await Promise.all([
      axios.get('https://gamma-api.polymarket.com/events?active=true&closed=false&limit=100&order=startDate&ascending=false'),
      axios.get('https://gamma-api.polymarket.com/events?closed=true&limit=50&order=startDate&ascending=false'),
    ]);

    const allEvents = [
      ...(Array.isArray(activeRes.data) ? activeRes.data : []),
      ...(Array.isArray(closedRes.data) ? closedRes.data : []),
    ];

    // 🔥 Buscar mercados de hoy O mañana en ET
    const btcEvents = allEvents.filter(e => {
      const title = (e.title || '').toLowerCase();
      return (
        title.includes('bitcoin up or down') &&
        (title.includes(todayET) || title.includes(tomorrowET)) &&
        !title.includes('9pm et')
      );
    });

    console.log(`\n🔍 Mercados BTC encontrados: ${btcEvents.length}`);

    const candidates = btcEvents
      .map(e => {
        const times  = parseMarketTimes(e.title);
        const market = e.markets?.[0];
        return { event: e, market, times };
      })
      .filter(e => e.times && e.market)
      .sort((a, b) => a.times.start - b.times.start);

    candidates.forEach(c => {
      const minsToStart = Math.round((c.times.start - now) / 60000);
      const minsToEnd   = Math.round((c.times.end   - now) / 60000);
      const isActive    = now >= c.times.start && now <= c.times.end;
      console.log(`   ${c.event.title} | en ${minsToStart}..${minsToEnd}min | activo: ${isActive} | closed: ${c.market.closed}`);
    });

    const active   = candidates.find(c => now >= c.times.start && now <= c.times.end);
    const upcoming = candidates
      .filter(c => now < c.times.start && !c.market.closed)
      .sort((a, b) => a.times.start - b.times.start)[0];

    const best = active || upcoming;

    if (!best) {
      console.log('❌ Sin mercados válidos');
      return null;
    }

    const market   = best.market;
    const tokenIds = JSON.parse(market.clobTokenIds);
    market.upTokenId   = tokenIds[0];
    market.downTokenId = tokenIds[1];

    const label = active ? 'ACTIVO' : 'PRÓXIMO';
    console.log(`\n✅ [${label}] ${best.event.title}`);
    return market;

  } catch (err) {
    console.error('❌ Error:', err.message);
    return null;
  }
}

async function fetchBitcoinPrice(market) {
  if (!market) return;

  try {
    const res = await axios.get(
      `https://gamma-api.polymarket.com/markets/${market.id}`
    );

    const m              = res.data;
    const bestBid        = parseFloat(m.bestBid) || null;
    const bestAsk        = parseFloat(m.bestAsk) || null;
    const lastTradePrice = m.lastTradePrice != null ? parseFloat(m.lastTradePrice) : null;
    const outcomePrices  = JSON.parse(m.outcomePrices || '["0","0"]');
    const upPrice        = parseFloat(outcomePrices[0]);
    const downPrice      = parseFloat(outcomePrices[1]);
    const spread         = bestBid && bestAsk ? (bestAsk - bestBid) : null;

    prices = {
      question: market.question,
      up:   { price: upPrice,   impliedProb: `${(upPrice   * 100).toFixed(1)}%` },
      down: { price: downPrice, impliedProb: `${(downPrice * 100).toFixed(1)}%` },
      bestBid,
      bestAsk,
      spread,
      lastTradePrice,
      updatedAt: new Date().toISOString(),
    };

    console.log(`\n📊 ${market.question}`);
    console.log(`   UP: ${(upPrice * 100).toFixed(1)}% | DOWN: ${(downPrice * 100).toFixed(1)}%`);
    console.log(`   bid: ${bestBid} | ask: ${bestAsk} | spread: ${spread?.toFixed(2) ?? 'N/A'}`);
    console.log(`   lastTrade: ${lastTradePrice ?? 'sin datos'}`);

  } catch (err) {
    console.error('❌ Error precios:', err.message);
  }
}

async function start() {
  console.log('🟢 Buscando mercado Bitcoin 5 minutos activo...');

  currentMarket = await findBitcoinMarket();

  if (!currentMarket) {
    setTimeout(start, 30000);
    return;
  }

  fetchBitcoinPrice(currentMarket);
  setInterval(() => fetchBitcoinPrice(currentMarket), 5000);

  setInterval(async () => {
    console.log('🔄 Buscando nuevo mercado...');
    const newMarket = await findBitcoinMarket();
    if (newMarket && newMarket.question !== currentMarket.question) {
      console.log(`🆕 Cambiando a: ${newMarket.question}`);
      currentMarket = newMarket;
    }
  }, 4 * 60 * 1000);
}

function startWebSocket() {
  start();
  return prices;
}

module.exports = { startWebSocket, prices };