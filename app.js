// app.js — DEMO ONLY
require('dotenv').config();
const express = require('express');
const app = express();

app.use(express.json());

// ===== DEMO 모드 플래그 & 지도 URL =====
const DEMO = process.env.DEMO_MODE === '1';         // 반드시 1로
const MAP_URL = process.env.MAP_URL || null;        // 직접 넣고 싶으면 여기 환경변수로
const mapUrlFor = (baseName) =>
  MAP_URL || `https://map.naver.com/v5/search/${encodeURIComponent(baseName + '역 가볼만한곳')}`;

// ===== 시드 랜덤 / 날짜→기상치 합성 =====
function seededRand(seed){ let x = Math.sin(seed) * 10000; return x - Math.floor(x); }
function seedFrom(str){ let h=0; for(let i=0;i<str.length;i++) h=(h*31+str.charCodeAt(i))>>>0; return h; }

function synthWeather(dateISO){
  const d = dateISO ? new Date(`${dateISO}T09:00:00+09:00`) : new Date();
  const m = d.getMonth() + 1;
  let base = { POP: 20, WSD: 2, TMN: 10, TMX: 18 };               // 봄/가을
  if (m>=6 && m<=8) base = { POP: 35, WSD: 3, TMN: 20, TMX: 30 }; // 여름
  else if (m>=12 || m<=2) base = { POP: 15, WSD: 2, TMN: -5, TMX: 5 }; // 겨울

  const s = seedFrom(d.toISOString().slice(0,10));
  const POP = Math.min(90, Math.max(0, Math.round(base.POP + seededRand(s+1)*30 - 15)));
  const WSD = Math.max(0, Math.round((base.WSD + seededRand(s+2)*2 - 1) * 10) / 10);
  const TMN = Math.round(base.TMN + seededRand(s+3)*4 - 2);
  const TMX = Math.round(base.TMX + seededRand(s+4)*4 - 2);
  return { POP, PTY: POP>=60 ? 1 : 0, WSD, TMN, TMX };
}

function decidePlan(w){
  if (w.POP>=40 || w.PTY>0) return 'indoor';
  if (w.TMX>=31 || w.TMN<=-3) return 'indoor';
  if (w.WSD>=7) return 'indoor';
  return 'outdoor';
}
function reasonText(w){
  if (w.POP>=60 || w.PTY>0) return '강수 가능성이 높아요 → 실내 추천';
  if (w.POP>=40) return '소나기 가능성이 있어요 → 실내가 안전';
  if (w.TMX>=31) return '더위가 강해요 → 실내 추천';
  if (w.TMN<=-3) return '추워요 → 실내 추천';
  if (w.WSD>=7) return '바람이 강해요 → 실내 추천';
  return '날씨가 무난해요 → 실외 추천';
}

// ===== 역별 데모 카드 DB (없으면 자동 생성) =====
const DEMO_PLACES = {
  '잠실': [
    { title: '석촌호수 산책',         cat: '공원/호수',  addr: '송파구 잠실동',            link: 'https://map.naver.com/v5/search/석촌호수' },
    { title: '롯데월드몰 아쿠아리움',  cat: '아쿠아리움',  addr: '송파구 올림픽로 300',      link: 'https://map.naver.com/v5/entry/place/11885223' },
    { title: '서울스카이 전망대',      cat: '전망대',      addr: '롯데월드타워 117~123F',    link: 'https://map.naver.com/v5/entry/place/37685259' },
    { title: '방이맛골',              cat: '먹거리골목',  addr: '송파구 방이동',            link: 'https://map.naver.com/v5/search/방이맛골' },
    { title: '롯데월드 아이스링크',    cat: '실내스포츠',  addr: '잠실동 40-1',             link: 'https://map.naver.com/v5/entry/place/11839421' },
    { title: '롯데시네마(월드타워)',   cat: '영화관',      addr: '송파구 올림픽로 300',      link: 'https://map.naver.com/v5/entry/place/37721657' }
  ],
  '홍대입구': [
    { title: '홍대 거리 버스킹',       cat: '스트리트',    addr: '마포구 홍익로 일대',        link: 'https://map.naver.com/v5/search/홍대%20버스킹' },
    { title: '연남동 경의선숲길',      cat: '산책',        addr: '마포구 연남동',            link: 'https://map.naver.com/v5/search/경의선숲길' },
    { title: '홍대 카페 골목',         cat: '카페',        addr: '마포구 서교동',            link: 'https://map.naver.com/v5/search/홍대%20카페' },
    { title: '홍대 놀이터',            cat: '공간',        addr: '서교동 361-10',            link: 'https://map.naver.com/v5/entry/place/11806559' },
    { title: 'KT&G 상상마당',          cat: '전시/공연',   addr: '마포구 와우산로 144',       link: 'https://map.naver.com/v5/entry/place/11586241' },
    { title: '카카오프렌즈 스토어',     cat: '스토어',      addr: '홍익로5길 29',            link: 'https://map.naver.com/v5/entry/place/37969913' }
  ],
  '강남': [
    { title: '강남역 카페 투어',       cat: '카페',        addr: '강남대로 일대',            link: 'https://map.naver.com/v5/search/강남역%20카페' },
    { title: '역삼 실내 볼링',         cat: '실내스포츠',  addr: '역삼동',                  link: 'https://map.naver.com/v5/search/역삼%20볼링' },
    { title: '코엑스 아쿠아리움',       cat: '아쿠아리움',  addr: '영동대로 513',            link: 'https://map.naver.com/v5/entry/place/11510549' },
    { title: '봉은사 산책',            cat: '사찰/산책',   addr: '삼성동',                  link: 'https://map.naver.com/v5/entry/place/11627959' },
    { title: '도곡동 스파',            cat: '스파/찜질',   addr: '강남구 도곡동',           link: 'https://map.naver.com/v5/search/강남%20스파' },
    { title: '메가박스 코엑스',        cat: '영화관',      addr: '삼성동',                  link: 'https://map.naver.com/v5/entry/place/11632063' }
  ]
};

function toCard(item, baseName){
  return {
    card: {
      title: item.title,
      subtitle: `${item.cat} | ${item.addr}`,
      buttons: [
        { text: '상세보기',   postback: item.link },
        { text: '지도 열기', postback: mapUrlFor(baseName) } // <- 네가 MAP_URL로 덮어쓸 수 있음
      ]
    }
  };
}

// ===== 라우트 =====
app.get('/', (_,res)=>res.send('DF webhook alive (demo)'));

app.post('/webhook', (req,res)=>{
  try{
    const q = req.body.queryResult || {};
    const p = q.parameters || {};
    const stationRaw = (p.station || '강남').toString();
    const stationBase = stationRaw.replace(/역$/, '');
    const stationName = stationRaw.endsWith('역') ? stationRaw : `${stationRaw}역`;

    // ISO / YYYY-MM-DD 둘 다 받음
    const dateParam = (p.date||'').toString();
    const dateISO = dateParam.includes('T') ? dateParam.slice(0,10) :
                    (/^\d{4}-\d{2}-\d{2}$/.test(dateParam) ? dateParam : null);

    // --- DEMO: 합성 날씨 + 계획/사유
    const w = synthWeather(dateISO);
    const plan = decidePlan(w);
    const reason = reasonText(w);

    // --- DEMO: 카드 6장 (사전 DB 없으면 자동 생성)
    const list = (DEMO_PLACES[stationBase] || Array.from({length:6}).map((_,i)=>({
      title: `${stationBase} 가볼만한 곳 #${i+1}`,
      cat:   i%2 ? '카페/식당' : '전시/활동',
      addr:  `서울 ${stationBase} 주변`,
      link:  mapUrlFor(stationBase)
    }))).slice(0,6);

    const cards = list.map(it => toCard(it, stationBase));

    const header =
      `${dateISO || '오늘'} ${stationName} 기준으로 ${plan==='indoor'?'실내':'실외'} 코스를 추천해요.\n` +
      `(${reason} | POP:${w.POP}% WSD:${w.WSD}m/s TMN:${w.TMN}°C TMX:${w.TMX}°C)`;

    return res.json({ fulfillmentMessages: [ { text:{ text:[header] } }, ...cards ] });
  }catch(e){
    console.error(e);
    return res.json({ fulfillmentText: '데모 서버 오류가 발생했어요.' });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, ()=>console.log('listening (demo) on', PORT));
