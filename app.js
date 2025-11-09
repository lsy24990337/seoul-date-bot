// app.js (robust date parsing fixed)
require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const bodyParser = require('body-parser');

const app = express();
app.use(bodyParser.json());

// ---------- utils ----------
function maxNum(a){ if(!a?.length) return NaN; return Math.max(...a.map(Number)); }
function minNum(a){ if(!a?.length) return NaN; return Math.min(...a.map(Number)); }
function avgNum(a){ if(!a?.length) return NaN; const s=a.map(Number).reduce((x,y)=>x+y,0); return s/a.length; }
function stripTags(s=''){ return s.replace(/<[^>]+>/g,''); }

// 날짜 문자열 표준화: 'YYYY-MM-DD' 또는 ISO('YYYY-MM-DDTHH:MM:SS+09:00') 모두 허용
function normalizeDateStr(input){
  if(!input) return null;
  const s = String(input);
  // ISO 형태면 앞 10자리(YYYY-MM-DD)만 사용
  if (s.includes('T')) return s.slice(0, 10);
  // 이미 YYYY-MM-DD 형태면 그대로
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  // YYYYMMDD 형태 등은 변환 시도
  const m = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return null; // 알 수 없는 형식
}

// ---------- stations cache ----------
let stationCache=null;
try { stationCache = require('./stations.json'); } catch(_) { stationCache=null; }

// ---------- 역이름 -> 위경도 ----------
async function getStationLatLng(stationName){
  const key=(stationName||'').replace(/역$/,'').trim();
  if(!key) return null;

  if(stationCache?.SubwayStationInfo?.row){
    const f=stationCache.SubwayStationInfo.row.find(s => (s.STATN_NM||'').trim()===key);
    if(f) return { lat:+f.YPOINT_WGS, lng:+f.XPOINT_WGS };
  }

  const apiKey = process.env.SEOUL_API_KEY;
  if(!apiKey) return null;
  try{
    const url = `http://openapi.seoul.go.kr:8088/${apiKey}/json/SubwayStationInfo/1/1000/`;
    const r = await fetch(url);
    const j = await r.json();
    const rows = j?.SubwayStationInfo?.row || [];
    const f = rows.find(s => (s.STATN_NM||'').trim()===key)
            || rows.find(s => (s.STATN_NM||'').includes(key)); // 부분일치 보조
    if(!f) return null;
    return { lat:+f.YPOINT_WGS, lng:+f.XPOINT_WGS };
  }catch(_){ return null; }
}

// ---------- 위경도 -> 기상청 격자 ----------
function latLngToKmaGrid(lat, lon){
  const RE=6371.00877, GRID=5.0, SLAT1=30.0, SLAT2=60.0, OLON=126.0, OLAT=38.0, XO=43, YO=136;
  const DEGRAD=Math.PI/180.0;
  let re=RE/GRID, sl1=SLAT1*DEGRAD, sl2=SLAT2*DEGRAD, olon=OLON*DEGRAD, olat=OLAT*DEGRAD;
  let sn=Math.tan(Math.PI*0.25+sl2*0.5)/Math.tan(Math.PI*0.25+sl1*0.5);
  sn=Math.log(Math.cos(sl1)/Math.cos(sl2))/Math.log(sn);
  let sf=Math.tan(Math.PI*0.25+sl1*0.5); sf=Math.pow(sf,sn)*Math.cos(sl1)/sn;
  let ro=Math.tan(Math.PI*0.25+olat*0.5); ro=re*sf/Math.pow(ro,sn);
  let ra=Math.tan(Math.PI*0.25+lat*DEGRAD*0.5); ra=re*sf/Math.pow(ra,sn);
  let th=lon*DEGRAD-olon; if(th>Math.PI) th-=2*Math.PI; if(th<-Math.PI) th+=2*Math.PI; th*=sn;
  const x=Math.floor(ra*Math.sin(th)+XO+0.5), y=Math.floor(ro-ra*Math.cos(th)+YO+0.5);
  return { nx:x, ny:y };
}

// ---------- 단기예보 base ----------
function getBaseDateTime(targetDateKST=new Date()){
  const baseTimes=[2,5,8,11,14,17,20,23];
  const y=targetDateKST.getFullYear();
  const m=String(targetDateKST.getMonth()+1).padStart(2,'0');
  const d=String(targetDateKST.getDate()).padStart(2,'0');
  const hh=targetDateKST.getHours();
  let baseH=baseTimes[0]; for(const t of baseTimes) if(hh>=t) baseH=t;
  return { base_date:`${y}${m}${d}`, base_time:String(baseH).padStart(2,'0')+'00' };
}

// ---------- 기상청: 단기예보 (D+0~3) ----------
async function getShortTermForecast(lat,lng,dateStr){
  if(!process.env.KMA_API_KEY) return null;
  const norm = normalizeDateStr(dateStr);
  try{
    const {nx,ny}=latLngToKmaGrid(lat,lng);
    const target = norm ? new Date(`${norm}T09:00:00+09:00`) : new Date();
    const {base_date,base_time}=getBaseDateTime(target);
    const qs=new URLSearchParams({
      serviceKey:process.env.KMA_API_KEY, numOfRows:'500', pageNo:'1', dataType:'JSON',
      base_date, base_time, nx:String(nx), ny:String(ny)
    });
    const url=`https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0/getVilageFcst?${qs}`;
    const r=await fetch(url); const j=await r.json();
    const items=j?.response?.body?.items?.item||[];
    const ymd=`${target.getFullYear()}${String(target.getMonth()+1).padStart(2,'0')}${String(target.getDate()).padStart(2,'0')}`;
    const dayItems=items.filter(it=>it.fcstDate===ymd && +it.fcstTime>=900 && +it.fcstTime<=1800);
    const by={}; for(const it of dayItems){ (by[it.category]??=[]).push(it.fcstValue); }
    const pop=maxNum(by.POP), pty=maxNum(by.PTY), t3h=avgNum(by.T3H), wsd=avgNum(by.WSD);
    const tmx=maxNum(by.TMX), tmn=minNum(by.TMN);
    return {
      POP: isNaN(pop)?0:pop, PTY: isNaN(pty)?0:pty,
      T3H: isNaN(t3h)?null:t3h, WSD: isNaN(wsd)?0:wsd,
      TMX: isNaN(tmx)?(isNaN(t3h)?null:t3h+2):tmx,
      TMN: isNaN(tmn)?(isNaN(t3h)?null:t3h-2):tmn
    };
  }catch(_){ return null; }
}

// ---------- 기상청: 중기예보 (D+4~10) ----------
async function getMidTermForecast(dateStr){
  if(!process.env.KMA_API_KEY) return null;
  const norm = normalizeDateStr(dateStr);
  if (!norm) return null;
  try{
    const target=new Date(`${norm}T09:00:00+09:00`);
    const now=new Date();
    const diff=Math.floor((target - new Date(now.toDateString()))/(1000*60*60*24));
    const regId='11B00000'; // 수도권
    const baseTime=now.getHours()>=18?'1800':'0600';
    const ymd=now.toISOString().slice(0,10).replace(/-/g,'');
    const url=`https://apis.data.go.kr/1360000/MidFcstInfoService/getMidLandFcst?serviceKey=${process.env.KMA_API_KEY}&dataType=JSON&numOfRows=10&pageNo=1&regId=${regId}&tmFc=${ymd}${baseTime}`;
    const r=await fetch(url); const j=await r.json();
    const item=j?.response?.body?.items?.item?.[0]; if(!item) return null;
    const idx=Math.min(Math.max(diff,4),10);
    const popAm=item[`rnSt${idx}Am`], popPm=item[`rnSt${idx}Pm`];
    const tmin=item[`taMin${idx}`], tmax=item[`taMax${idx}`];
    return {
      POP: Math.max(Number(popAm||0), Number(popPm||0)),
      PTY: 0, TMN: Number(tmin||0), TMX: Number(tmax||0), WSD: 0
    };
  }catch(_){ return null; }
}

// ---------- 판단 ----------
function decidePlan(w){
  if(!w) return 'indoor';
  if(w.POP>=40 || w.PTY>0) return 'indoor';
  if((w.TMX??100)>=31 || (w.TMN??-100)<=-3) return 'indoor';
  if(w.WSD>=7) return 'indoor';
  return 'outdoor';
}
function reasonText(w){
  if(!w) return '기본 안전 모드로 실내를 추천해요';
  if(w.POP>=40 || w.PTY>0) return '강수 가능성이 높아요 → 실내 추천';
  if((w.TMX??100)>=31) return '일 최고기온이 높아요 → 실내 추천';
  if((w.TMN??-100)<=-3) return '일 최저기온이 낮아요 → 실내 추천';
  if(w.WSD>=7) return '바람이 강해요 → 실내 추천';
  return '날씨가 무난해요 → 실외 추천';
}

// ---------- 네이버 지역검색 ----------
async function searchNaverLocal(query){
  const id=process.env.NAVER_ID, sc=process.env.NAVER_SECRET;
  if(!id || !sc) return [];
  try{
    const u=new URL('https://openapi.naver.com/v1/search/local.json');
    u.searchParams.set('query', query);
    u.searchParams.set('display','10');
    const r=await fetch(u.toString(),{
      headers:{ 'X-Naver-Client-Id':id, 'X-Naver-Client-Secret':sc }
    });
    const j=await r.json();
    return j.items || [];
  }catch(_){ return []; }
}
function toCard(item){
  const title=stripTags(item.title);
  return {
    card:{
      title,
      subtitle:`${item.category} | ${item.address}`,
      buttons:[{ text:'상세보기', postback:item.link }]
    }
  };
}

// ---------- webhook ----------
app.post('/webhook', async (req,res)=>{
  try{
    const q=req.body.queryResult||{};
    const p=q.parameters||{};
    const stationRaw=p.station;
    const dateParam=p.date; // can be 'YYYY-MM-DD' or ISO

    // 날짜 정규화
    const dateISO = normalizeDateStr(dateParam); // 'YYYY-MM-DD' or null
    const today = new Date();
    const tForDiff = dateISO ? new Date(`${dateISO}T09:00:00+09:00`) : today;
    const dDiff = Math.floor((tForDiff - new Date(today.toDateString()))/(1000*60*60*24));

    // 역 좌표
    const station = stationRaw?.endsWith('역') ? stationRaw : `${stationRaw}역`;
    const coord = await getStationLatLng(station);
    if(!coord){
      return res.json({ fulfillmentText:`‘${stationRaw}’ 역을 찾지 못했어요. 예: 강남역/홍대입구역 처럼 입력해 주세요!` });
    }

    // 예보 선택
    let weather=null;
    if(dDiff<=3) weather=await getShortTermForecast(coord.lat,coord.lng,dateISO);
    else if(dDiff<=10) weather=await getMidTermForecast(dateISO);
    else return res.json({ fulfillmentText:`${dateISO}은(는) 10일 이후예요. 10일 이내 날짜로 입력해주세요.` });

    const planType=decidePlan(weather);
    const reason=reasonText(weather);

    // 장소 추천 (실패해도 무시)
    let places=[]; try{ places = await searchNaverLocal(`${station} 가볼만한곳`); }catch(_){ places=[]; }
    const cards=places.slice(0,6).map(toCard);

    const header = `${dateISO || '오늘'} ${station} 기준으로 ${planType==='indoor'?'실내':'실외'} 코스를 추천해요.\n(${reason}` +
                   `${weather?` | POP:${weather.POP}% WSD:${weather.WSD}m/s TMN:${weather.TMN??'-'}°C TMX:${weather.TMX??'-'}°C`:''})`;

    return res.json({ fulfillmentMessages: [ { text:{ text:[header] } }, ...cards ] });
  }catch(e){
    console.error(e);
    return res.json({ fulfillmentText:'서버 오류가 발생했어요. 잠시 후 다시 시도해주세요.' });
  }
});

// ---------- health ----------
app.get('/', (_,res)=>res.send('DF webhook alive'));
app.listen(process.env.PORT || 8080, ()=>console.log('listening...'));

