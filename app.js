// app.js
require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const bodyParser = require('body-parser');

const app = express();
app.use(bodyParser.json());

// ---------- 1) 역 이름 -> 위도/경도 ----------
let stationCache = null;
try { stationCache = require('./stations.json'); } catch (_) { stationCache = null; }

async function getStationLatLng(stationName) {
  const key = (stationName || '').replace(/역$/, '').trim();
  if (!key) return null;

  if (stationCache?.SubwayStationInfo?.row) {
    const found = stationCache.SubwayStationInfo.row.find(
      s => (s.STATN_NM || '').trim() === key
    );
    if (found) return { lat: +found.YPOINT_WGS, lng: +found.XPOINT_WGS };
  }

  const url = `https://openapi.seoul.go.kr:8088/${process.env.SEOUL_API_KEY}/json/SubwayStationInfo/1/1000/`;
  const r = await fetch(url);
  const j = await r.json();
  const rows = j?.SubwayStationInfo?.row || [];
  const found = rows.find(s => (s.STATN_NM || '').trim() === key);
  if (!found) return null;
  return { lat: +found.YPOINT_WGS, lng: +found.XPOINT_WGS };
}

// ---------- 2) 위/경도 -> 기상청 격자(nx, ny) ----------
function latLngToKmaGrid(lat, lon) {
  const RE = 6371.00877, GRID = 5.0, SLAT1 = 30.0, SLAT2 = 60.0, OLON = 126.0, OLAT = 38.0, XO = 43, YO = 136;
  const DEGRAD = Math.PI / 180.0;

  let re = RE / GRID;
  let slat1 = SLAT1 * DEGRAD, slat2 = SLAT2 * DEGRAD, olon = OLON * DEGRAD, olat = OLAT * DEGRAD;

  let sn = Math.tan(Math.PI * 0.25 + slat2 * 0.5) / Math.tan(Math.PI * 0.25 + slat1 * 0.5);
  sn = Math.log(Math.cos(slat1) / Math.cos(slat2)) / Math.log(sn);
  let sf = Math.tan(Math.PI * 0.25 + slat1 * 0.5);
  sf = Math.pow(sf, sn) * Math.cos(slat1) / sn;
  let ro = Math.tan(Math.PI * 0.25 + olat * 0.5);
  ro = re * sf / Math.pow(ro, sn);

  let ra = Math.tan(Math.PI * 0.25 + lat * DEGRAD * 0.5);
  ra = re * sf / Math.pow(ra, sn);
  let theta = lon * DEGRAD - olon;
  if (theta > Math.PI) theta -= 2.0 * Math.PI;
  if (theta < -Math.PI) theta += 2.0 * Math.PI;
  theta *= sn;

  const x = Math.floor(ra * Math.sin(theta) + XO + 0.5);
  const y = Math.floor(ro - ra * Math.cos(theta) + YO + 0.5);
  return { nx: x, ny: y };
}

// ---------- 3) 단기예보 base_date/base_time ----------
function getBaseDateTime(targetDateKST = new Date()) {
  const baseTimes = [2,5,8,11,14,17,20,23]; // 허용된 발표시각
  const y = targetDateKST.getFullYear();
  const m = String(targetDateKST.getMonth() + 1).padStart(2, '0');
  const d = String(targetDateKST.getDate()).padStart(2, '0');
  const hh = targetDateKST.getHours();

  let baseH = baseTimes[0];
  for (const t of baseTimes) if (hh >= t) baseH = t;

  return { base_date: `${y}${m}${d}`, base_time: String(baseH).padStart(2, '0') + '00' };
}

// ---------- 4) 기상청 단기예보(오늘~D+3) ----------
async function getShortTermForecast(lat, lng, dateStr /* 'YYYY-MM-DD' */) {
  const { nx, ny } = latLngToKmaGrid(lat, lng);
  const target = dateStr ? new Date(`${dateStr}T09:00:00+09:00`) : new Date();
  const { base_date, base_time } = getBaseDateTime(target);

  const qs = new URLSearchParams({
    serviceKey: process.env.KMA_API_KEY,
    numOfRows: '500',
    pageNo: '1',
    dataType: 'JSON',
    base_date, base_time, nx: String(nx), ny: String(ny),
  });
  const url = `https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0/getVilageFcst?${qs}`;
  const r = await fetch(url); const j = await r.json();
  const items = j?.response?.body?.items?.item || [];

  const ymd = `${target.getFullYear()}${String(target.getMonth()+1).padStart(2,'0')}${String(target.getDate()).padStart(2,'0')}`;
  const dayItems = items.filter(it => it.fcstDate === ymd && Number(it.fcstTime) >= 900 && Number(it.fcstTime) <= 1800);

  const byCat = {};
  for (const it of dayItems) {
    if (!byCat[it.category]) byCat[it.category] = [];
    byCat[it.category].push(it.fcstValue);
  }

  const pop = maxNum(byCat['POP']); // 강수확률 최대
  const pty = maxNum(byCat['PTY']); // 강수형태
  const t3hAvg = avgNum(byCat['T3H']); // 평균기온
  const wsdAvg = avgNum(byCat['WSD']); // 평균풍속
  const tmx = maxNum(byCat['TMX']); const tmn = minNum(byCat['TMN']);

  return {
    POP: isNaN(pop) ? 0 : pop,
    PTY: isNaN(pty) ? 0 : pty,
    T3H: isNaN(t3hAvg) ? null : t3hAvg,
    WSD: isNaN(wsdAvg) ? 0 : wsdAvg,
    TMX: isNaN(tmx) ? (isNaN(t3hAvg) ? null : t3hAvg + 2) : tmx,
    TMN: isNaN(tmn) ? (isNaN(t3hAvg) ? null : t3hAvg - 2) : tmn,
  };
}

function maxNum(arr){ if (!arr?.length) return NaN; return Math.max(...arr.map(Number)); }
function minNum(arr){ if (!arr?.length) return NaN; return Math.min(...arr.map(Number)); }
function avgNum(arr){ if (!arr?.length) return NaN; const s=arr.map(Number).reduce((a,b)=>a+b,0); return s/arr.length; }

// ---------- 5) 기상청 중기예보(D+4~D+10) ----------
async function getMidTermForecast(dateStr /* 'YYYY-MM-DD' */) {
  const target = new Date(`${dateStr}T09:00:00+09:00`);
  const now = new Date();
  const diff = Math.floor((target - now) / (1000 * 60 * 60 * 24));
  // 수도권 코드(서울·인천·경기)
  const regId = '11B00000';

  const baseTime = now.getHours() >= 18 ? '1800' : '0600';
  const ymd = now.toISOString().slice(0, 10).replace(/-/g, '');

  const url = `https://apis.data.go.kr/1360000/MidFcstInfoService/getMidLandFcst?serviceKey=${process.env.KMA_API_KEY}&dataType=JSON&numOfRows=10&pageNo=1&regId=${regId}&tmFc=${ymd}${baseTime}`;
  const r = await fetch(url); const j = await r.json();
  const item = j?.response?.body?.items?.item?.[0];
  if (!item) return null;

  const idx = Math.min(Math.max(diff, 4), 10); // D+4 ~ D+10
  const popAm = item[`rnSt${idx}Am`], popPm = item[`rnSt${idx}Pm`];
  const tmin = item[`taMin${idx}`], tmax = item[`taMax${idx}`];

  return {
    POP: Math.max(Number(popAm || 0), Number(popPm || 0)),
    PTY: 0,
    TMN: Number(tmin || 0),
    TMX: Number(tmax || 0),
    WSD: 0,
  };
}

// ---------- 6) 실내/실외 판단 ----------
function decidePlan(w) {
  if (w.POP >= 40 || w.PTY > 0) return 'indoor';
  if ((w.TMX ?? 100) >= 31 || (w.TMN ?? -100) <= -3) return 'indoor';
  if (w.WSD >= 7) return 'indoor';
  return 'outdoor';
}
function reasonText(w, type){
  if (w.POP >= 40 || w.PTY > 0) return '강수 가능성이 높아요 → 실내 추천';
  if ((w.TMX ?? 100) >= 31) return '일 최고기온이 높아요 → 실내 추천';
  if ((w.TMN ?? -100) <= -3) return '일 최저기온이 낮아요 → 실내 추천';
  if (w.WSD >= 7) return '바람이 강해요 → 실내 추천';
  return '날씨가 무난해요 → 실외 추천';
}

// ---------- 7) 네이버 지역 검색 ----------
async function searchNaverLocal(query){
  const url = new URL('https://openapi.naver.com/v1/search/local.json');
  url.searchParams.set('query', query);
  url.searchParams.set('display', '10');
  url.searchParams.set('start', '1');
  const r = await fetch(url.toString(), {
    headers: {
      'X-Naver-Client-Id': process.env.NAVER_ID,
      'X-Naver-Client-Secret': process.env.NAVER_SECRET
    }
  });
  const j = await r.json();
  return j.items || [];
}

function toCard(item){
  const title = (item.title || '').replace(/<[^>]+>/g, '');
  return {
    card: {
      title,
      subtitle: `${item.category} | ${item.address}`,
      buttons: [{ text: '상세보기', postback: item.link }]
    }
  };
}

// ---------- 8) Dialogflow 웹훅 ----------
app.post('/webhook', async (req, res) => {
  try {
    const q = req.body.queryResult || {};
    const params = q.parameters || {};
    const stationRaw = params.station;
    const dateISO = params.date; // "YYYY-MM-DD"

    // 날짜 차이 계산
    const today = new Date();
    const target = dateISO ? new Date(`${dateISO}T09:00:00+09:00`) : today;
    const dDiff = Math.floor((target - new Date(today.toDateString())) / (1000 * 60 * 60 * 24));

    // 1) 역 좌표
    const station = stationRaw?.endsWith('역') ? stationRaw : `${stationRaw}역`;
    const coord = await getStationLatLng(station);
    if (!coord) return res.json({ fulfillmentText: `‘${stationRaw}’ 역을 찾지 못했어요. 정확한 역명을 알려주세요!` });

    // 2) 예보 선택
    let weather;
    if (dDiff <= 3) {
      weather = await getShortTermForecast(coord.lat, coord.lng, dateISO);
    } else if (dDiff <= 10) {
      weather = await getMidTermForecast(dateISO);
    } else {
      return res.json({ fulfillmentText: `${dateISO}은(는) 10일 이후예요. 10일 이내 날짜로 입력해주세요.` });
    }

    // 3) 판단
    const planType = decidePlan(weather);
    const reason = reasonText(weather, planType);

    // 4) 장소 추천
    const places = await searchNaverLocal(`${station} 가볼만한곳`);
    const cards = places.slice(0, 6).map(toCard);

    // 5) 응답
    const header = `${dateISO || '오늘'} ${station} 기준으로 ${planType==='indoor'?'실내':'실외'} 코스를 추천해요.\n(${reason} | POP:${weather.POP}%, WSD:${weather.WSD}m/s, TMN:${weather.TMN??'-'}°C, TMX:${weather.TMX??'-'}°C)`;

    return res.json({ fulfillmentMessages: [ { text: { text: [header] } }, ...cards ] });
  } catch (e) {
    console.error(e);
    return res.json({ fulfillmentText: '서버 오류가 발생했어요. 잠시 후 다시 시도해주세요.' });
  }
});

app.get('/', (_, res) => res.send('DF webhook alive'));
app.listen(process.env.PORT || 8080, () => console.log('listening...'));
