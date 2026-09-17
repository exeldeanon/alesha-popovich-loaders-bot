const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

export class TelegramClient {
  constructor(token,{timeoutMs=35000}={}){
    if(!token)throw new Error('TELEGRAM_BOT_TOKEN is required');
    this.base=`https://api.telegram.org/bot${token}`;
    this.timeoutMs=timeoutMs;
  }
  async call(method,payload={}){
    const response=await fetch(`${this.base}/${method}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(this.timeoutMs)});
    const data=await response.json().catch(()=>({ok:false,description:`HTTP ${response.status}`}));
    if(!response.ok||!data.ok){const error=new Error(data.description||`Telegram ${method} failed`);error.code=data.error_code;error.parameters=data.parameters;throw error;}
    return data.result;
  }
  sendMessage(chatId,text,options={}){return this.call('sendMessage',{chat_id:chatId,text,parse_mode:'HTML',link_preview_options:{is_disabled:true},...options});}
  editMessage(chatId,messageId,text,options={}){return this.call('editMessageText',{chat_id:chatId,message_id:messageId,text,parse_mode:'HTML',link_preview_options:{is_disabled:true},...options});}
  answerCallback(id,text='',showAlert=false){return this.call('answerCallbackQuery',{callback_query_id:id,text,show_alert:showAlert});}
  deleteMessage(chatId,messageId){return this.call('deleteMessage',{chat_id:chatId,message_id:messageId});}
  setCommands(commands){return this.call('setMyCommands',{commands});}
  async getUpdates(offset,signal){
    while(!signal.aborted){
      try{return await this.call('getUpdates',{offset,timeout:25,allowed_updates:['message','callback_query']});}
      catch(error){
        if(signal.aborted)return [];
        if(error.code===409)throw new Error('Другой экземпляр бота уже получает обновления (Telegram 409). Остановите дубликат.');
        if(error.code===401||error.code===404)throw error;
        await sleep(Math.max(1500,Number(error.parameters?.retry_after||0)*1000));
      }
    }
    return [];
  }
}

export class FakeTelegramClient {
  constructor(){this.messages=[];this.callbacks=[];this.edits=[];}
  async sendMessage(chatId,text,options={}){const item={message_id:this.messages.length+1,chat:{id:chatId},chatId:String(chatId),text,options};this.messages.push(item);return item;}
  async editMessage(chatId,messageId,text,options={}){this.edits.push({chatId:String(chatId),messageId,text,options});return true;}
  async answerCallback(id,text='',showAlert=false){this.callbacks.push({id,text,showAlert});return true;}
  async setCommands(){return true;}
}
