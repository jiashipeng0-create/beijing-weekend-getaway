const AMAP_BASE = 'https://restapi.amap.com/v3';
const SITE_ORIGIN = 'https://jiashipeng0-create.github.io';
const CACHE_TTL_SECONDS = 60 * 60 * 12;

const json = (body, status = 200, extra = {}) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8', ...extra }
});

function cors(request) {
  const origin = request.headers.get('Origin');
  return {
    'Access-Control-Allow-Origin': origin === SITE_ORIGIN ? origin : SITE_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin'
  };
}

function withCors(response, request) {
  const headers = new Headers(response.headers);
  Object.entries(cors(request)).forEach(([key, value]) => headers.set(key, value));
  return new Response(response.body, { status: response.status, headers });
}

function haversineKm(lat1, lng1, lat2, lng2) {
  const toRad = value => value * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function parseNumber(value, label, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) throw new Error(`${label} 必须在 ${min}–${max} 之间`);
  return number;
}

async function amap(path, params, env) {
  if (!env.AMAP_WEB_SERVICE_KEY) throw new Error('Worker 尚未配置 AMAP_WEB_SERVICE_KEY');
  const url = new URL(`${AMAP_BASE}${path}`);
  Object.entries({ ...params, key: env.AMAP_WEB_SERVICE_KEY, output: 'JSON' }).forEach(([key, value]) => url.searchParams.set(key, value));
  const response = await fetch(url);
  if (!response.ok) throw new Error(`高德服务暂不可用（${response.status}）`);
  const data = await response.json();
  if (data.status !== '1') throw new Error(data.info || '高德查询失败');
  return data;
}

function flattenCities(country) {
  const provinces = country?.districts || [];
  return provinces.flatMap(province => {
    const children = province.districts || [];
    const cityRows = children.filter(item => item.level === 'city');
    const entries = cityRows.length ? cityRows : [province];
    return entries.map(city => {
      const [lng, lat] = String(city.center || '').split(',').map(Number);
      return { name: city.name, adcode: city.adcode, citycode: city.citycode || '', lat, lng, province: province.name };
    }).filter(city => Number.isFinite(city.lat) && Number.isFinite(city.lng));
  });
}

async function getNationalCities(request, env) {
  const cacheKey = new Request(new URL('/cache/china-cities-v1', request.url));
  const cached = await caches.default.match(cacheKey);
  if (cached) return cached.json();
  const data = await amap('/config/district', { keywords: '中国', subdistrict: '2', extensions: 'base', offset: '100' }, env);
  const cities = flattenCities(data.districts?.[0]).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  await caches.default.put(cacheKey, json(cities, 200, { 'Cache-Control': `max-age=${CACHE_TTL_SECONDS}` }));
  return cities;
}

function guideLinks(city) {
  const query = encodeURIComponent(city);
  return [
    { name: '马蜂窝攻略', url: `https://www.mafengwo.cn/search/q.php?q=${query}` },
    { name: '穷游攻略', url: `https://search.qyer.com/index?wd=${query}` },
    { name: '携程攻略', url: `https://you.ctrip.com/searchsite.html?query=${query}` },
    { name: '去哪儿攻略', url: `https://travel.qunar.com/search?q=${query}` }
  ];
}

async function cachedValue(request, path, load) {
  const cacheKey = new Request(new URL(path, request.url));
  const cached = await caches.default.match(cacheKey);
  if (cached) return cached.json();
  const value = await load();
  await caches.default.put(cacheKey, json(value, 200, { 'Cache-Control': `max-age=${CACHE_TTL_SECONDS}` }));
  return value;
}

function countyDistricts(district) {
  const children = district?.districts || [];
  const rows = children.length ? children : [district];
  return rows.map(item => ({
    name: item.name,
    adcode: item.adcode,
    level: item.level || 'district'
  })).filter(item => item.name && item.adcode);
}

async function getCountyDistricts(city, adcode, request, env) {
  const key = encodeURIComponent(adcode || city);
  // Bump the cache namespace when administrative-level handling changes.
  return cachedValue(request, `/cache/city-counties-v2/${key}`, async () => {
    const data = await amap('/config/district', {
      keywords: adcode || city,
      // 直辖市会在省级节点下再嵌套一个“城区”城市层；需取到第三级才能展开区县。
      subdistrict: '3',
      extensions: 'base',
      offset: '100'
    }, env);
    const root = data.districts?.[0];
    const children = (root?.districts || []).flatMap(item => item.level === 'city' && item.districts?.length ? item.districts : [item]);
    const districts = countyDistricts({ districts: children });
    return districts.length ? districts : [{ name: city, adcode: adcode || city, level: 'city' }];
  });
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await mapper(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function handleCities(url, request, env) {
  const lat = parseNumber(url.searchParams.get('lat'), '纬度', -90, 90);
  const lng = parseNumber(url.searchParams.get('lng'), '经度', -180, 180);
  const radiusKm = parseNumber(url.searchParams.get('radiusKm') || '500', '半径', 1, 500);
  const cities = await getNationalCities(request, env);
  const nearby = cities.map(city => ({ ...city, distanceKm: Math.round(haversineKm(lat, lng, city.lat, city.lng)) }))
    .filter(city => city.distanceKm <= radiusKm)
    .sort((a, b) => a.distanceKm - b.distanceKm);
  return { origin: { lat, lng }, radiusKm, totalCities: nearby.length, cities: nearby };
}

async function handleGeocode(url, env) {
  const address = (url.searchParams.get('address') || '').trim();
  if (address.length < 2 || address.length > 80) throw new Error('请输入 2–80 个字符的城市或地点名称');
  const data = await amap('/geocode/geo', { address }, env);
  const geocode = data.geocodes?.[0];
  if (!geocode?.location) throw new Error('未找到该地点，请尝试填写城市名或更完整的地址');
  const [lng, lat] = geocode.location.split(',').map(Number);
  return { name: geocode.formatted_address || address, lat, lng, adcode: geocode.adcode || '' };
}

async function handleAttractions(url, request, env) {
  const city = (url.searchParams.get('city') || '').trim();
  const adcode = (url.searchParams.get('adcode') || '').trim();
  const page = Math.round(parseNumber(url.searchParams.get('page') || '1', '页码', 1, 10));
  if (!city && !adcode) throw new Error('请选择一座城市后再查询景点');
  const key = `${encodeURIComponent(adcode || city)}-${page}`;
  return cachedValue(request, `/cache/city-attractions-v2/${key}`, async () => {
    const districts = await getCountyDistricts(city, adcode, request, env);
    // 每个区县都查一页；10 条既能覆盖更多区县，也能避免一次响应过大。
    const districtResults = await mapWithConcurrency(districts, 3, async district => {
      const data = await amap('/place/text', {
        keywords: '旅游景点',
        city: district.adcode,
        citylimit: 'true',
        offset: '10',
        page,
        extensions: 'all'
      }, env);
      return { district, count: Number(data.count || 0), pois: data.pois || [] };
    });
    const seen = new Set();
    const attractions = districtResults.flatMap(({ district, pois }) => pois.map(poi => ({
      id: poi.id,
      name: poi.name,
      type: poi.type || '旅游景点',
      address: poi.address || `${poi.pname || ''}${poi.cityname || ''}${poi.adname || ''}`,
      location: poi.location || '',
      rating: poi.biz_ext?.rating || '',
      city: poi.cityname || city,
      district: poi.adname || district.name
    }))).filter(item => item.id && !seen.has(item.id) && Boolean(seen.add(item.id)));
    const count = districtResults.reduce((sum, result) => sum + result.count, 0);
    const hasMore = districtResults.some(result => result.count > page * 10);
    return {
      city,
      adcode,
      page,
      count,
      districtCount: districts.length,
      districts: districts.map(district => district.name),
      attractions,
      hasMore,
      nextPage: hasMore ? page + 1 : null,
      guides: guideLinks(city)
    };
  });
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors(request) });
    if (request.method !== 'GET') return withCors(json({ error: '仅支持 GET 请求' }, 405), request);
    const url = new URL(request.url);
    try {
      if (url.pathname === '/' || url.pathname === '/health') return withCors(json({ ok: true, service: 'nearby-attractions-api' }), request);
      if (url.pathname === '/v1/cities') return withCors(json(await handleCities(url, request, env)), request);
      if (url.pathname === '/v1/geocode') return withCors(json(await handleGeocode(url, env)), request);
      if (url.pathname === '/v1/attractions') return withCors(json(await handleAttractions(url, request, env)), request);
      return withCors(json({ error: '接口不存在' }, 404), request);
    } catch (error) {
      return withCors(json({ error: error instanceof Error ? error.message : '服务异常' }, 400), request);
    }
  }
};
