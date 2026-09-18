export const REGIONS={
  moscow:{
    name:'Москва',
    streets:{
      warehouse:['ул. Складочная','ул. Южнопортовая','Варшавское шоссе','Рязанский проспект','Ленинградское шоссе'],
      apartment:['ул. Профсоюзная','ул. Люблинская','ул. Академика Янгеля','ул. Новочерёмушкинская','ул. Братиславская'],
      retail:['Каширское шоссе','Волгоградский проспект','проспект Мира','Дмитровское шоссе'],
    },
  },
  spb:{
    name:'Санкт-Петербург',
    streets:{
      warehouse:['Софийская улица','Кубинская улица','Московское шоссе','проспект Обуховской Обороны'],
      apartment:['Бухарестская улица','Ленинский проспект','проспект Ветеранов','Гражданский проспект'],
      retail:['Пулковское шоссе','Лиговский проспект','Московский проспект'],
    },
  },
  kazan:{
    name:'Казань',
    streets:{
      warehouse:['улица Тихорецкая','улица Родины','Горьковское шоссе','улица Аделя Кутуя'],
      apartment:['улица Чистопольская','проспект Победы','улица Юлиуса Фучика','улица Академика Парина'],
      retail:['Сибирский тракт','улица Декабристов','улица Павлюхина'],
    },
  },
  ekaterinburg:{
    name:'Екатеринбург',
    streets:{
      warehouse:['улица Монтажников','улица Черняховского','Сибирский тракт','улица Бахчиванджи'],
      apartment:['улица Белинского','улица Щорса','улица Викулова','улица Техническая'],
      retail:['улица Малышева','проспект Космонавтов','улица 8 Марта'],
    },
  },
};

const normalize=value=>String(value||'').trim().toLowerCase().replaceAll('ё','е');

export function regionKeyByCity(value){
  const city=normalize(value);
  for(const [key,region] of Object.entries(REGIONS)){
    const name=normalize(region.name);
    if(city===name||city.includes(name)||name.includes(city))return key;
  }
  if(city==='спб'||city.includes('петербург'))return 'spb';
  if(city.includes('екб')||city.includes('екатеринбург'))return 'ekaterinburg';
  return '';
}

export function regionLabel(key){
  return REGIONS[key]?.name||String(key||'Не назначен');
}

export function randomFrom(items){
  return items[Math.floor(Math.random()*items.length)];
}

export function randomInt(min,max){
  return Math.floor(Math.random()*(max-min+1))+min;
}

export function generateAddress(regionKey,locationType='warehouse'){
  const region=REGIONS[regionKey]||REGIONS.moscow;
  const streets=region.streets[locationType]||region.streets.warehouse;
  const street=randomFrom(streets);
  const house=randomInt(2,180);
  const building=Math.random()<0.18?`, стр. ${randomInt(1,5)}`:'';
  return `${street}, д. ${house}${building}`;
}
