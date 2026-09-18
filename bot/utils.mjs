export const escapeHtml=value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
export const money=value=>`${new Intl.NumberFormat('ru-RU').format(Number(value)||0)} ₽`;
export const hours=value=>`${new Intl.NumberFormat('ru-RU',{maximumFractionDigits:1}).format(Number(value)||0)} ч`;

export function formatDate(value){
  const date=new Date(value);if(Number.isNaN(date.getTime()))return String(value);
  return new Intl.DateTimeFormat('ru-RU',{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit',timeZone:'Europe/Moscow'}).format(date).replace(',',' ·');
}

export function parseMoscowDate(value,nowDate=new Date()){
  const match=String(value).trim().match(/^(\d{1,2})\.(\d{1,2})(?:\.(\d{2}|\d{4}))?\s+(\d{1,2}):(\d{2})$/);
  if(!match)return null;
  const [,d,m,yRaw,h,min]=match;
  let year=yRaw?Number(yRaw):Number(new Intl.DateTimeFormat('en',{year:'numeric',timeZone:'Europe/Moscow'}).format(nowDate));
  if(year<100)year+=2000;
  const day=Number(d),month=Number(m),hour=Number(h),minute=Number(min);
  if(month<1||month>12||day<1||day>new Date(Date.UTC(year,month,0)).getUTCDate()||hour>23||minute>59)return null;
  const iso=`${String(year).padStart(4,'0')}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}T${String(h).padStart(2,'0')}:${min}:00+03:00`;
  const date=new Date(iso);
  if(Number.isNaN(date.getTime()))return null;
  return date.toISOString();
}

export const inline=rows=>({inline_keyboard:rows});
export const reply=rows=>({keyboard:rows.map(row=>row.map(button=>typeof button==='string'?{text:button}:button)),resize_keyboard:true,is_persistent:true,input_field_placeholder:'Выберите действие'});
export const contactKeyboard=()=>({keyboard:[[{text:'📱 Отправить мой номер',request_contact:true}],['Отмена']],resize_keyboard:true,one_time_keyboard:true});
export const removeKeyboard=()=>({remove_keyboard:true});

export function fullName(user){return [user.first_name,user.last_name].filter(Boolean).join(' ')||user.name||user.username||`ID ${user.telegram_id||user.user_id}`;}
export function short(value,max=220){const text=String(value??'').trim();return text.length>max?`${text.slice(0,max-1)}…`:text;}
export function int(value,{min=1,max=1_000_000}={}){const parsed=Number(String(value).replace(/\s/g,''));return Number.isInteger(parsed)&&parsed>=min&&parsed<=max?parsed:null;}
export function decimal(value,{min=.5,max=48}={}){const parsed=Number(String(value).replace(',','.'));return Number.isFinite(parsed)&&parsed>=min&&parsed<=max?parsed:null;}
