import fs from 'node:fs';
import process from 'node:process';
import {BotDatabase} from './db.mjs';
import {TelegramClient} from './telegram.mjs';
import {BotApp} from './app.mjs';
import {OrderGenerator} from './order-generator.mjs';
import {AddressProvider} from './address-provider.mjs';

function loadEnv(filename='.env'){
  if(!fs.existsSync(filename))return;
  for(const raw of fs.readFileSync(filename,'utf8').split(/\r?\n/)){
    const line=raw.trim();if(!line||line.startsWith('#'))continue;
    const index=line.indexOf('=');if(index<1)continue;
    const key=line.slice(0,index).trim();let value=line.slice(index+1).trim();
    if((value.startsWith('"')&&value.endsWith('"'))||(value.startsWith("'")&&value.endsWith("'")))value=value.slice(1,-1);
    if(process.env[key]===undefined)process.env[key]=value;
  }
}

loadEnv();
const token=process.env.TELEGRAM_BOT_TOKEN;
if(!token)throw new Error('Укажите TELEGRAM_BOT_TOKEN в .env или переменных окружения.');
const adminIds=String(process.env.BOT_ADMIN_IDS||'').split(',').map(value=>value.trim()).filter(Boolean);
const adminUsernames=String(process.env.BOT_ADMIN_USERNAMES||'AleshaPopovichManager').split(',').map(value=>value.trim()).filter(Boolean);
const db=new BotDatabase(process.env.BOT_DB_PATH||'data/bot.sqlite');
for(const id of adminIds)db.ensureManager(id);
const telegram=new TelegramClient(token);
const addressProvider=new AddressProvider({db});
const app=new BotApp({db,telegram,addressProvider,adminUsernames});
const controller=new AbortController();
const reminderMinutes=Number(process.env.BOT_REMINDER_MINUTES)||120;
const orderNudgeMinutes=Math.max(10,Number(process.env.BOT_ORDER_NUDGE_MINUTES)||45);
const generator=new OrderGenerator({db,app,addressProvider});
const siteLogUrl=String(process.env.SITE_LOG_PULL_URL||'').replace(/\/$/,'');
const siteLogSecret=process.env.SITE_LOG_RELAY_SECRET||'';
const siteLogChatIds=String(process.env.SITE_LOG_CHAT_IDS||process.env.BOT_ADMIN_IDS||'').split(',').map(value=>value.trim()).filter(Boolean);

try{
  await telegram.setCommands([
    {command:'start',description:'Открыть бот'},
    {command:'menu',description:'Главное меню'},
    {command:'cancel',description:'Отменить текущий ввод'},
    {command:'help',description:'Помощь'},
  ]);
}catch(error){
  console.warn('Telegram временно недоступен при настройке команд. Бот продолжит подключение:',error.message);
}

if(!adminIds.length)console.log(`Менеджер будет назначен по Telegram username: ${adminUsernames.map(value=>`@${value.replace(/^@/,'')}`).join(', ')}`);
console.log(`Бот запущен. Менеджеров по ID: ${adminIds.length}. База: ${db.filename}`);

const reminders=setInterval(()=>app.sendReminders(reminderMinutes).catch(error=>console.error('Ошибка напоминаний:',error)),5*60_000);
reminders.unref();
const autoOrders=setInterval(()=>generator.tick().catch(error=>console.error('Ошибка генератора заказов:',error)),60_000);
autoOrders.unref();
const orderNudges=setInterval(()=>app.sendOrderNudges(orderNudgeMinutes).catch(error=>console.error('Ошибка подгоняющей рассылки:',error)),5*60_000);
orderNudges.unref();
generator.tick().catch(error=>console.error('Ошибка первого запуска генератора:',error));

async function relaySiteLogs(){
  if(!siteLogUrl||!siteLogSecret||!siteLogChatIds.length)return;
  const headers={Authorization:`Bearer ${siteLogSecret}`};
  const response=await fetch(`${siteLogUrl}/api/log/pull`,{headers,signal:AbortSignal.timeout(15_000)});
  if(!response.ok)throw new Error(`получение событий: HTTP ${response.status}`);
  const payload=await response.json();
  const delivered=[];
  for(const event of payload.events||[]){
    await Promise.all(siteLogChatIds.map(chatId=>telegram.sendMessage(chatId,event.text)));
    delivered.push(event.id);
  }
  if(delivered.length){
    const ack=await fetch(`${siteLogUrl}/api/log/ack`,{
      method:'POST',headers:{...headers,'Content-Type':'application/json'},
      body:JSON.stringify({ids:delivered}),signal:AbortSignal.timeout(15_000),
    });
    if(!ack.ok)throw new Error(`подтверждение событий: HTTP ${ack.status}`);
  }
}

let relayBusy=false;
const siteLogRelay=setInterval(async()=>{
  if(relayBusy)return;relayBusy=true;
  try{await relaySiteLogs();}catch(error){console.error('Ошибка доставки логов сайта:',error.message);}finally{relayBusy=false;}
},5_000);
siteLogRelay.unref();
relaySiteLogs().catch(error=>console.error('Ошибка доставки логов сайта:',error.message));

for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>controller.abort());

let offset=Number(db.setting('telegram_offset','0'))||0;
while(!controller.signal.aborted){
  const updates=await telegram.getUpdates(offset,controller.signal);
  for(const update of updates){
    try{await app.handleUpdate(update);}catch(error){console.error(`Ошибка update ${update.update_id}:`,error);}
    offset=update.update_id+1;db.setSetting('telegram_offset',offset);
  }
}

clearInterval(reminders);clearInterval(autoOrders);clearInterval(orderNudges);clearInterval(siteLogRelay);db.close();console.log('Бот остановлен.');
