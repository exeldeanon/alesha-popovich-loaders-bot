import process from 'node:process';

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const clamp=(value,min,max)=>Math.min(max,Math.max(min,value));

export class AddressProvider{
  constructor({db,logger=console}={}){
    this.db=db;this.log=logger;
    this.nominatimUrl=process.env.BOT_NOMINATIM_URL||'https://nominatim.openstreetmap.org';
    this.overpassUrl=process.env.BOT_OVERPASS_URL||'https://maps.mail.ru/osm/tools/overpass/api/interpreter';
    this.userAgent=process.env.BOT_OSM_USER_AGENT||'AleshaPopovichLoadersBot/1.0 (+https://github.com/exeldeanon/alesha-popovich-loaders-bot)';
    this.lastNominatimAt=0;
  }

  normalize(value){return String(value||'').trim().toLowerCase().replaceAll('ё','е').replace(/\s+/g,' ');}

  async requestJson(url,options={}){
    const response=await fetch(url,{...options,headers:{'User-Agent':this.userAgent,'Accept-Language':'ru',Accept:'application/json',...(options.headers||{})},signal:AbortSignal.timeout(25_000)});
    if(!response.ok)throw new Error(`HTTP ${response.status} ${response.statusText}`);
    return response.json();
  }

  async resolveRegion(query){
    const key=this.normalize(query);if(key.length<2)return null;
    const cached=this.db.getRegionGeo(key);if(cached)return cached;
    const wait=Math.max(0,1100-(Date.now()-this.lastNominatimAt));if(wait)await sleep(wait);
    const params=new URLSearchParams({format:'jsonv2',addressdetails:'1',countrycodes:'ru',limit:'5',q:`${query}, Россия`});
    let list;
    try{list=await this.requestJson(`${this.nominatimUrl}/search?${params}`);this.lastNominatimAt=Date.now();}
    catch(error){this.log.warn?.('Не удалось определить регион через Nominatim:',error.message);return null;}
    const item=(Array.isArray(list)?list:[]).find(row=>row?.boundingbox?.length===4&&row?.address?.country_code==='ru');
    if(!item)return null;
    const [south,north,west,east]=item.boundingbox.map(Number);
    if(![south,north,west,east].every(Number.isFinite))return null;
    const address=item.address||{};
    const label=address.city||address.town||address.municipality||address.county||address.state_district||address.state||String(query).trim();
    const value={region_key:key,label,south,west,north,east,osm_type:item.osm_type||'',osm_id:String(item.osm_id||''),updated_at:new Date().toISOString()};
    this.db.saveRegionGeo(value);
    return value;
  }

  subBox(geo,attempt){
    const latSpan=Math.max(.01,geo.north-geo.south),lonSpan=Math.max(.01,geo.east-geo.west);
    if(latSpan<=.16&&lonSpan<=.16)return [geo.south,geo.west,geo.north,geo.east];
    const boxLat=clamp(latSpan/(attempt+3),.035,.12),boxLon=clamp(lonSpan/(attempt+3),.035,.12);
    const south=geo.south+Math.random()*Math.max(.001,latSpan-boxLat);
    const west=geo.west+Math.random()*Math.max(.001,lonSpan-boxLon);
    return [south,west,Math.min(geo.north,south+boxLat),Math.min(geo.east,west+boxLon)];
  }

  formatAddress(tags){
    const street=tags['addr:street']||tags['addr:place'];
    const house=tags['addr:housenumber'];
    if(!street||!house)return null;
    const unit=tags['addr:unit']?`, пом. ${tags['addr:unit']}`:'';
    return `${street}, д. ${house}${unit}`;
  }

  async refill(regionQuery,minCount=30){
    const geo=await this.resolveRegion(regionQuery);if(!geo)return null;
    for(let attempt=0;attempt<5;attempt++){
      const [south,west,north,east]=this.subBox(geo,attempt);
      const q=`[out:json][timeout:20];nwr["addr:housenumber"]["addr:street"](${south},${west},${north},${east});out tags center 160;`;
      try{
        const data=await this.requestJson(this.overpassUrl,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({data:q}).toString()});
        const addresses=[];
        for(const element of data.elements||[]){
          const address=this.formatAddress(element.tags||{});if(address)addresses.push(address);
        }
        if(addresses.length){this.db.saveRegionAddresses(geo.region_key,geo.label,addresses);if(this.db.countRegionAddresses(geo.region_key)>=minCount)break;}
      }catch(error){this.log.warn?.(`Не удалось получить адреса для ${geo.label}:`,error.message);}
      await sleep(350);
    }
    return geo;
  }

  async getAddress(regionQuery){
    const key=this.normalize(regionQuery);if(!key)return null;
    let cached=this.db.randomRegionAddress(key);
    if(!cached||this.db.countRegionAddresses(key)<10){
      const geo=await this.refill(regionQuery);if(!geo)return cached;
      cached=this.db.randomRegionAddress(geo.region_key)||cached;
    }
    if(!cached)return null;
    this.db.markRegionAddressUsed(cached.id);
    return {address:cached.address,regionKey:cached.region_key,regionLabel:cached.region_label};
  }
}
