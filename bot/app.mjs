import {accessText,applicationText,cabinetText,managerMenu,orderKeyboard,orderListKeyboard,orderText,shiftText,statsText,unverifiedWorkerMenu,userSettingsText,verificationText,withdrawalText,workerCreatorMenu,workerFunnelText,workerLogsText,workerMenu,workerProfileText,workerSettingsText} from './views.mjs';
import {REGIONS,regionKeyByCity,regionLabel} from './regions.mjs';
import {decimal,escapeHtml as e,inline,int,money,parseMoscowDate,removeKeyboard} from './utils.mjs';

const decisionKeyboard=(kind,id,yes='Одобрить',no='Отклонить')=>inline([[
  {text:`✅ ${yes}`,callback_data:`${kind}:${id}:approve`},
  {text:`❌ ${no}`,callback_data:`${kind}:${id}:decline`},
]]);

export class BotApp{
  constructor({db,telegram,addressProvider=null,logger=console,adminUsernames=[]}){
    this.db=db;this.tg=telegram;this.addressProvider=addressProvider;this.log=logger;
    this.adminUsernames=new Set(adminUsernames.map(value=>String(value).replace(/^@/,'').toLowerCase()).filter(Boolean));
  }

  async safeSend(chatId,text,options={}){try{return await this.tg.sendMessage(chatId,text,options);}catch(error){this.log.error?.(`Не удалось отправить сообщение ${chatId}:`,error.message);return null;}}
  async notifyManagers(text,options={}){for(const manager of this.db.listManagers())await this.safeSend(manager.telegram_id,text,options);}
  async broadcastWorkers(text,options={}){for(const worker of this.db.listActiveWorkers())await this.safeSend(worker.telegram_id,text,options);}
  async sendOrderToWorker(worker,order,{save=false,notification=true}={}){
    if(notification&&!this.canPush(worker,'new_order'))return null;
    const sent=await this.safeSend(worker.telegram_id,orderText(order,{worker}),{reply_markup:orderKeyboard(order)});
    if(save&&sent?.message_id)this.db.saveOrderMessage(order.id,worker.telegram_id,sent.message_id);
    return sent;
  }
  async broadcastRegionOrder(order,{save=false}={}){
    const workers=order.region?this.db.listActiveWorkersByRegion(order.region):this.db.listActiveWorkers();
    for(const worker of workers)await this.sendOrderToWorker(worker,order,{save});
  }
  async publishGeneratedOrder(order){
    if(order.target_user_id){
      const worker=this.db.getUser(order.target_user_id);
      if(worker&&worker.status==='active'&&worker.verified===1)return this.sendOrderToWorker(worker,order,{save:true,notification:true});
      return null;
    }
    return this.broadcastRegionOrder(order,{save:true});
  }
  async refreshOrderMessages(orderId){
    const order=this.db.getOrder(orderId);if(!order)return;
    for(const item of this.db.listOrderMessages(orderId)){
      const worker=this.db.getUser(item.user_id);if(!worker)continue;
      try{await this.tg.editMessage(item.user_id,item.message_id,orderText(order,{worker}),{reply_markup:orderKeyboard(order)});}catch(error){this.log.warn?.('Не удалось обновить сообщение заказа:',error.message);}
    }
  }

  isManager(user){return user?.role==='manager'&&user?.status==='active';}
  isWorker(user){return user?.role==='worker';}
  hasBotAccess(user){return user?.role==='worker'&&user?.status==='active';}
  isVerifiedWorker(user){return this.hasBotAccess(user)&&user?.verified===1&&Boolean(user?.region);}
  canCreateOrder(user){return this.isVerifiedWorker(user)&&user?.can_create_orders===1;}
  moscowMinutes(date=new Date()){
    const parts=new Intl.DateTimeFormat('en-GB',{hour:'2-digit',minute:'2-digit',hourCycle:'h23',timeZone:'Europe/Moscow'}).formatToParts(date);
    const hour=Number(parts.find(item=>item.type==='hour')?.value||0),minute=Number(parts.find(item=>item.type==='minute')?.value||0);
    return hour*60+minute;
  }
  timeToMinutes(value){const match=String(value||'').match(/^(\d{2}):(\d{2})$/);return match?Number(match[1])*60+Number(match[2]):0;}
  isDndActive(user,date=new Date()){
    if(user?.dnd_enabled!==1)return false;
    const current=this.moscowMinutes(date),start=this.timeToMinutes(user.dnd_start),end=this.timeToMinutes(user.dnd_end);
    if(start===end)return true;
    return start<end?(current>=start&&current<end):(current>=start||current<end);
  }
  canPush(user,kind){
    if(!user||user.maintenance_mode===1||this.isDndActive(user))return false;
    if(kind==='new_order')return user.notifications===1;
    if(kind==='rate')return user.rate_notifications===1;
    if(kind==='nudge')return user.order_nudges===1;
    if(kind==='shift_reminder')return user.shift_reminder_notifications===1;
    return true;
  }
  menuFor(user){return this.isManager(user)?managerMenu:(this.hasBotAccess(user)?(this.isVerifiedWorker(user)?(user?.can_create_orders===1?workerCreatorMenu:workerMenu):unverifiedWorkerMenu):removeKeyboard());}
  async menu(chatId,user,text='Выберите действие:'){return this.safeSend(chatId,text,{reply_markup:this.menuFor(user)});}

  async handleUpdate(update){
    if(update.message)return this.handleMessage(update.message);
    if(update.callback_query)return this.handleCallback(update.callback_query);
  }

  async handleMessage(message){
    if(message.chat?.type&&message.chat.type!=='private')return;
    let user=this.db.upsertUser(message.from);
    if(message.from?.username&&this.adminUsernames.has(message.from.username.toLowerCase())){
      this.db.ensureManager(user.telegram_id);
      user=this.db.getUser(user.telegram_id);
    }
    const chatId=message.chat.id;
    const text=String(message.text||'').trim();
    if(this.isWorker(user)){
      this.db.logWorkerAction(user.telegram_id,message.location?'location':'message',{text:message.location?'Отправил геопозицию':(text||'[без текста]')});
      if(user.maintenance_mode===1)return this.safeSend(chatId,'🛠 <b>Сейчас идут технические работы.</b>\nБот временно недоступен. Попробуйте позже.',{reply_markup:this.menuFor(user)});
    }
    if(message.location&&this.isWorker(user))return this.menu(chatId,user,'Геопозиция больше не требуется. Откройте активный заказ и нажмите «🗺 Посмотреть на карте».');
    if(text==='/cancel'||text==='Отмена'){this.db.clearSession(user.telegram_id);return this.menu(chatId,user,'Действие отменено.');}
    if(text.startsWith('/start'))return this.start(chatId,user);
    if(text==='/menu')return this.isManager(user)||this.hasBotAccess(user)?this.menu(chatId,user):this.start(chatId,user);
    if(text==='/help'||text==='🆘 Помощь')return this.isManager(user)||this.hasBotAccess(user)?this.help(chatId,user):this.start(chatId,user);
    if(text==='📍 Обновить геопозицию')return this.menu(chatId,user,'Геопозиция больше не требуется. Откройте активный заказ и нажмите «🗺 Посмотреть на карте».');
    const session=this.db.getSession(user.telegram_id);
    if(session)return this.handleSession(message,user,session);
    if(!this.isManager(user)&&!this.isWorker(user))return this.start(chatId,user);
    return this.routeMenu(chatId,user,text);
  }

  async start(chatId,user){
    this.db.clearSession(user.telegram_id);
    if(this.isManager(user))return this.menu(chatId,user,'<b>Панель менеджера «Алёша Попович»</b>');
    if(this.isVerifiedWorker(user))return this.menu(chatId,user,`С возвращением, ${e(user.first_name||'коллега')}!`);
    if(this.hasBotAccess(user))return this.menu(chatId,user,[
      `С возвращением, ${e(user.first_name||'коллега')}!`,
      'Статус: <b>Не верифицирован</b>.',
      'Заказы доступны для просмотра. Чтобы откликаться и брать их, запросите верификацию у менеджера.',
    ].join('\n'));
    if(user.status==='pending')return this.safeSend(chatId,'<b>Заявка на доступ к боту уже у менеджера.</b>\nОжидайте решения.',{reply_markup:removeKeyboard()});
    return this.safeSend(chatId,[
      '<b>Работа грузчиком в «Алёша Попович»</b>',
      'Для начала нужно получить доступ к боту у менеджера.',
      '',`Ваш Telegram ID: <code>${e(user.telegram_id)}</code>`,
    ].join('\n'),{reply_markup:inline([[{text:'🔑 Запросить доступ',callback_data:'access_start'}]])});
  }

  async help(chatId,user){
    const text=this.isManager(user)
      ?'<b>Помощь менеджеру</b>\nСоздавайте заказы, рассматривайте отклики и заявки на доступ, подтверждайте смены и выплаты. Любой ввод можно остановить командой /cancel.'
      :'<b>Как пользоваться ботом</b>\n1. Откройте активные заказы и откликнитесь.\n2. После одобрения адрес появится в «Моих сменах».\n3. В день работы нажмите «Начать», после работы — «Завершить».\n4. Подтверждённая сумма попадёт в личный кабинет.\n\nПо организационным вопросам: @AleshaPopovichManager';
    return this.safeSend(chatId,text,{reply_markup:this.menuFor(user)});
  }

  async routeMenu(chatId,user,text){
    if(this.isManager(user)){
      if(text==='➕ Создать заказ')return this.beginOrder(chatId,user);
      if(text==='📋 Заказы')return this.showManagedOrders(chatId);
      if(text==='🔑 Доступы')return this.showAccess(chatId);
      if(text==='👷 Отклики')return this.showApplications(chatId);
      if(text==='✅ Подтвердить смены')return this.showShiftConfirmations(chatId);
      if(text==='💸 Выплаты')return this.showWithdrawals(chatId);
      if(text==='👥 Грузчики')return this.showWorkers(chatId);
      if(text==='📊 Статистика')return this.safeSend(chatId,statsText(this.db.stats()),{reply_markup:managerMenu});
    }else{
      if(!this.hasBotAccess(user))return this.start(chatId,user);
      if(text==='🔑 Запросить верификацию')return this.requestVerification(chatId,user);
      if(text==='➕ Создать заказ'){if(!this.canCreateOrder(user))return this.menu(chatId,user,'⛔ Создание заказов для вашего аккаунта отключено менеджером.');return this.beginOrder(chatId,user);}
      if(text==='💰 Личный кабинет'){const geo=this.db.getRegionGeo(user.region);return this.safeSend(chatId,cabinetText({...user,region:geo?.label||regionLabel(user.region)},this.db.getCabinet(user.telegram_id)),{reply_markup:this.menuFor(user)});}
      if(text==='📦 Активные заказы')return this.showOrders(chatId,user);
      if(text==='🗓 Мои смены'){if(!this.isVerifiedWorker(user))return this.menu(chatId,user,'⛔ Смены доступны после верификации у менеджера.');return this.showShifts(chatId,user,false);}
      if(text==='📜 История смен'){if(!this.isVerifiedWorker(user))return this.menu(chatId,user,'⛔ История смен доступна после верификации у менеджера.');return this.showShifts(chatId,user,true);}
      if(text==='💸 Запросить выплату'){if(!this.isVerifiedWorker(user))return this.menu(chatId,user,'⛔ Выплаты доступны после верификации у менеджера.');return this.beginWithdrawal(chatId,user);}
      if(text==='🔔 Уведомления'){if(!this.isVerifiedWorker(user))return this.menu(chatId,user,'⛔ Уведомления о заказах доступны после верификации.');const changed=this.db.toggleNotifications(user.telegram_id);return this.menu(chatId,changed,`Уведомления о новых заказах ${changed.notifications?'включены':'выключены'}.`);}
    }
    return this.menu(chatId,user,'Не понял команду. Выберите действие кнопкой.');
  }

  async beginAccess(chatId,user){
    if(user.status==='pending')return this.safeSend(chatId,'Заявка на доступ к боту уже отправлена менеджеру.',{reply_markup:removeKeyboard()});
    if(this.hasBotAccess(user))return this.menu(chatId,user,'Доступ к боту уже выдан.');
    const name=[user.first_name,user.last_name].filter(Boolean).join(' ')||user.username||user.telegram_id;
    const id=this.db.createAccessRequest(user.telegram_id,{name,city:'',experience:''});
    const item=this.db.getAccessRequest(id);
    await this.notifyManagers(accessText(item),{reply_markup:decisionKeyboard('access_decide',id)});
    return this.safeSend(chatId,'<b>Заявка на доступ к боту отправлена.</b>\nМенеджер рассмотрит её. После одобрения вы сможете смотреть активные заказы.',{reply_markup:removeKeyboard()});
  }
  async requestVerification(chatId,user){
    if(!this.hasBotAccess(user))return this.start(chatId,user);
    if(this.isVerifiedWorker(user))return this.menu(chatId,user,'Вы уже верифицированы.');
    const result=this.db.createVerificationRequest(user.telegram_id);
    if(result.error==='pending')return this.menu(chatId,user,'Заявка на верификацию уже отправлена менеджеру.');
    if(result.error)return this.menu(chatId,user,'Не удалось создать заявку на верификацию.');
    await this.notifyManagers(verificationText(result.request),{reply_markup:decisionKeyboard('verification_decide',result.request.id)});
    return this.menu(chatId,user,'<b>Заявка на верификацию отправлена.</b> Менеджер назначит тип занятости и регион.');
  }
  beginOrder(chatId,user){
    if(!this.isManager(user)&&!this.canCreateOrder(user))return this.menu(chatId,user,'⛔ Создание заказов для вашего аккаунта отключено менеджером.');
    this.db.setSession(user.telegram_id,'order','type',{});
    return this.safeSend(chatId,'Выберите тип заказа:',{reply_markup:inline([[
      {text:'Обычный',callback_data:'order_type:normal'},
      {text:'🔥 Срочный',callback_data:'order_type:urgent'},
    ],[{text:'Отмена',callback_data:'cancel'}]])});
  }
  beginWithdrawal(chatId,user){
    const cabinet=this.db.getCabinet(user.telegram_id);
    if(!cabinet.available)return this.menu(chatId,user,'Сейчас нет средств, доступных к выводу.');
    this.db.setSession(user.telegram_id,'withdrawal','amount',{});
    return this.safeSend(chatId,`Доступно: <b>${money(cabinet.available)}</b>. Введите сумму целым числом.`,{reply_markup:inline([[{text:`Вывести всё — ${money(cabinet.available)}`,callback_data:`withdraw_all:${cabinet.available}`}],[{text:'Отмена',callback_data:'cancel'}]])});
  }

  async handleSession(message,user,session){
    const text=String(message.text||'').trim();
    if(session.flow==='access')return this.accessSession(message,user,session,text);
    if(session.flow==='order'&&(this.isManager(user)||this.canCreateOrder(user)))return this.orderSession(message,user,session,text);
    if(session.flow==='worker_setting'&&this.isManager(user))return this.workerSettingSession(message,user,session,text);
    if(session.flow==='withdrawal'&&this.isWorker(user))return this.withdrawalSession(message,user,text);
    if(session.flow==='shift_edit'&&this.isManager(user))return this.shiftEditSession(message,user,session,text);
    if(session.flow==='worker_region'&&this.isManager(user))return this.workerRegionSession(message,user,session,text);
    if(session.flow==='access_verify_region'&&this.isManager(user))return this.accessVerifyRegionSession(message,user,session,text);
    this.db.clearSession(user.telegram_id);return this.start(message.chat.id,user);
  }

  async accessSession(message,user,session,text){
    const chatId=message.chat.id,data={...session.data};
    if(session.step==='name'){
      if(text.length<2)return this.safeSend(chatId,'Укажите имя и фамилию текстом.');
      data.name=text;this.db.setSession(user.telegram_id,'access','city',data);return this.safeSend(chatId,'В каком городе вы готовы работать?');
    }
    if(session.step==='city'){
      if(text.length<2)return this.safeSend(chatId,'Напишите название города.');
      data.city=text;this.db.setSession(user.telegram_id,'access','experience',data);return this.safeSend(chatId,'Коротко опишите опыт работы. Если опыта нет, напишите «нет».',{reply_markup:removeKeyboard()});
    }
    if(session.step==='experience'){
      data.experience=text||'нет';const id=this.db.createAccessRequest(user.telegram_id,data);this.db.clearSession(user.telegram_id);
      const item=this.db.getAccessRequest(id);await this.notifyManagers(accessText(item),{reply_markup:decisionKeyboard('access_decide',id)});
      return this.safeSend(chatId,'<b>Заявка на доступ к боту отправлена.</b>\nМенеджер рассмотрит её. После одобрения вы сможете смотреть активные заказы.');
    }
  }

  async orderSession(message,user,session,text){
    const chatId=message.chat.id,data={...session.data};
    const next=(step,prompt)=>{this.db.setSession(user.telegram_id,'order',step,data);return this.safeSend(chatId,prompt);};
    if(session.step==='title'){if(text.length<3)return this.safeSend(chatId,'Название слишком короткое.');data.title=text;return next('city','Город выполнения заказа?');}
    if(session.step==='city'){if(text.length<2)return this.safeSend(chatId,'Укажите город.');data.city=text;return next('address','Введите точный адрес. Он будет показан грузчикам в активном заказе.');}
    if(session.step==='address'){if(text.length<5)return this.safeSend(chatId,'Укажите адрес подробнее.');data.address=text;return next('startsAt','Дата и время по Москве в формате <b>ДД.ММ.ГГГГ ЧЧ:ММ</b>.');}
    if(session.step==='startsAt'){const value=parseMoscowDate(text);if(!value||new Date(value)<=new Date())return this.safeSend(chatId,'Нужны корректные будущие дата и время, например: 21.09.2026 09:30');data.startsAt=value;return next('duration','Ориентировочная длительность в часах?');}
    if(session.step==='duration'){const value=decimal(text,{min:.5,max:48});if(value==null)return this.safeSend(chatId,'Введите число от 0,5 до 48.');data.durationHours=value;return next('people','Сколько грузчиков нужно?');}
    if(session.step==='people'){const value=int(text,{min:1,max:100});if(value==null)return this.safeSend(chatId,'Введите целое число от 1 до 100.');data.peopleNeeded=value;data.selfEmployedRate=450;return next('ipRate','Ставка для ИП в час? Минимум <b>550 ₽/ч</b>. Для самозанятых ставка фиксирована: <b>450 ₽/ч</b>.');}
    if(session.step==='ipRate'){const value=int(text,{min:550,max:10_000});if(value==null)return this.safeSend(chatId,'Введите ставку ИП от 550 ₽/ч.');data.ipRate=value;data.amount=Math.round(450*Number(data.durationHours));return next('description','Добавьте описание работы, требования и что взять с собой. Если нечего добавить — отправьте «-».');}
    if(session.step==='description'){
      data.description=text==='-'?'':text;this.db.setSession(user.telegram_id,'order','confirm',data);
      const preview={id:'—',...data,starts_at:data.startsAt,duration_hours:data.durationHours,people_needed:data.peopleNeeded,amount:data.amount,assigned_count:0};
      return this.safeSend(chatId,`${orderText(preview,{manager:true})}\n\n<b>Опубликовать заказ?</b>`,{reply_markup:inline([[{text:'🚀 Опубликовать',callback_data:'order_publish'}],[{text:'Отмена',callback_data:'cancel'}]])});
    }
    return this.safeSend(chatId,'Подтвердите публикацию кнопкой ниже или отмените /cancel.');
  }

  async workerSettingSession(message,user,session,text){
    const chatId=message.chat.id,workerId=session.data.workerId;
    if(session.step==='frequency'){
      const value=decimal(text,{min:0,max:60});if(value==null)return this.safeSend(chatId,'Введите число от 0 до 60 — сколько новых автозаказов в среднем показывать в час.');
      this.db.updateWorkerSettings(workerId,{autoOrdersPerHour:value});this.db.clearSession(user.telegram_id);
      return this.showWorkerSettings(chatId,workerId,'Частота автозаказов обновлена.');
    }
    if(session.step==='urgent'){
      const value=int(text,{min:0,max:90});if(value==null)return this.safeSend(chatId,'Введите целое число от 0 до 90 — шанс срочного заказа в процентах.');
      this.db.updateWorkerSettings(workerId,{urgentOrderChance:value/100});this.db.clearSession(user.telegram_id);
      return this.showWorkerSettings(chatId,workerId,'Шанс срочного заказа обновлён.');
    }
    this.db.clearSession(user.telegram_id);return this.menu(chatId,user,'Настройка отменена.');
  }

  async withdrawalSession(message,user,text){
    const amount=int(text,{min:1,max:10_000_000});if(amount==null)return this.safeSend(message.chat.id,'Введите сумму целым числом.');
    return this.createWithdrawal(message.chat.id,user,amount);
  }
  async workerRegionSession(message,user,session,text){
    const chatId=message.chat.id;
    if(text.length<2)return this.safeSend(chatId,'Введите город, область, край или республику России.');
    const geo=await this.addressProvider?.resolveRegion(text);
    if(!geo)return this.safeSend(chatId,'Не удалось найти такой регион или город в России. Проверьте написание и попробуйте ещё раз.');
    const worker=this.db.updateWorkerProfile(session.data.workerId,{region:geo.region_key});
    this.db.clearSession(user.telegram_id);
    const name=worker?.first_name||worker?.username||worker?.telegram_id||'Грузчик';
    if(worker)await this.safeSend(worker.telegram_id,`Менеджер назначил вам регион: <b>${e(geo.label)}</b>.`,{reply_markup:this.menuFor(worker)});
    return this.menu(chatId,user,worker?`Регион для ${e(name)}: <b>${e(geo.label)}</b>.`:'Грузчик не найден.');
  }

  async accessVerifyRegionSession(message,user,session,text){
    const chatId=message.chat.id;
    if(text.length<2)return this.safeSend(chatId,'Введите город, область, край или республику России.');
    const geo=await this.addressProvider?.resolveRegion(text);
    if(!geo)return this.safeSend(chatId,'Не удалось найти такой регион или город в России. Проверьте написание и попробуйте ещё раз.');
    const result=this.db.completeVerification(session.data.requestId,user.telegram_id,{region:geo.region_key,contractorType:session.data.contractorType});
    this.db.clearSession(user.telegram_id);
    if(!result)return this.menu(chatId,user,'Заявка уже обработана или данные устарели.');
    const worker=this.db.getUser(result.user_id);
    const typeLabel=worker.contractor_type==='ip'?'ИП':'Самозанятый';
    await this.safeSend(result.user_id,`<b>✅ Верификация пройдена.</b>\nСтатус: <b>${typeLabel}</b>\nРегион: <b>${e(geo.label)}</b>\nТеперь вы можете откликаться и брать заказы.`,{reply_markup:this.menuFor(worker)});
    return this.menu(chatId,user,`Грузчик верифицирован: <b>${typeLabel}</b>, регион — <b>${e(geo.label)}</b>.`);
  }

  async shiftEditSession(message,user,session,text){
    const chatId=message.chat.id,data={...session.data};
    if(session.step==='amount'){const value=int(text,{min:0,max:1_000_000});if(value==null)return this.safeSend(chatId,'Введите сумму целым числом.');data.amount=value;this.db.setSession(user.telegram_id,'shift_edit','hours',data);return this.safeSend(chatId,'Сколько часов отработано?');}
    if(session.step==='hours'){const value=decimal(text,{min:.1,max:72});if(value==null)return this.safeSend(chatId,'Введите число от 0,1 до 72.');data.hours=value;this.db.setSession(user.telegram_id,'shift_edit','notes',data);return this.safeSend(chatId,'Комментарий к смене или «-».');}
    if(session.step==='notes'){
      const shift=this.db.completeShift(data.shiftId,user.telegram_id,{amount:data.amount,hours:data.hours,notes:text==='-'?'':text});this.db.clearSession(user.telegram_id);
      if(!shift)return this.menu(chatId,user,'Смена уже обработана.');
      const recipient=this.db.getUser(shift.user_id);
      await this.safeSend(shift.user_id,`<b>Смена подтверждена.</b>\nНачислено: ${money(shift.amount)}. Средства доступны в личном кабинете.`,{reply_markup:this.menuFor(recipient)});
      return this.menu(chatId,user,'Смена подтверждена, начисление добавлено.');
    }
  }

  workerOrders(user){
    return this.isVerifiedWorker(user)
      ?this.db.listActiveOrders({region:user.region||'',city:user.region?'':user.city,userId:user.telegram_id,limit:100})
      :this.db.listActiveOrders({userId:user.telegram_id,limit:100});
  }

  async showOrders(chatId,user,{page=0,messageId=null}={}){
    const orders=this.workerOrders(user);
    if(!orders.length){
      const text='Сейчас активных заказов нет.';
      if(messageId){try{return await this.tg.editMessage(chatId,messageId,text,{reply_markup:this.menuFor(user)});}catch{}}
      return this.menu(chatId,user,text);
    }
    const totalPages=Math.max(1,Math.ceil(orders.length/5));
    const safePage=Math.min(totalPages-1,Math.max(0,Number(page)||0));
    const text=[
      `<b>📦 Активные заказы: ${orders.length}</b>`,
      'Выберите заказ. В каждой кнопке: адрес и ориентир выплаты.',
      '🔥 — срочный заказ.',
    ].join('\n');
    const options={reply_markup:orderListKeyboard(orders,user,{page:safePage,pageSize:5})};
    if(messageId){
      try{return await this.tg.editMessage(chatId,messageId,text,options);}
      catch(error){this.log.warn?.('Не удалось перелистнуть список заказов:',error.message);}
    }
    return this.safeSend(chatId,text,options);
  }

  async showOrderDetails(chatId,user,orderId,{page=0,messageId=null}={}){
    const orders=this.workerOrders(user);
    const order=orders.find(item=>Number(item.id)===Number(orderId));
    if(!order)return this.showOrders(chatId,user,{page,messageId});
    const apps=this.isVerifiedWorker(user)?new Map(this.db.listUserApplications(user.telegram_id,100).map(item=>[item.order_id,item])):new Map();
    const app=apps.get(order.id);
    const options={reply_markup:orderKeyboard(order,{
      applied:app?.status==='pending',
      applicationId:app?.id,
      canApply:this.isVerifiedWorker(user),
      backPage:page,
    })};
    if(messageId){
      try{return await this.tg.editMessage(chatId,messageId,orderText(order,{worker:user}),options);}
      catch(error){this.log.warn?.('Не удалось открыть заказ из списка:',error.message);}
    }
    return this.safeSend(chatId,orderText(order,{worker:user}),options);
  }
  async showManagedOrders(chatId){const list=this.db.listManagedOrders();if(!list.length)return this.safeSend(chatId,'Активных заказов нет.',{reply_markup:managerMenu});for(const item of list)await this.safeSend(chatId,orderText(item,{manager:true}),{reply_markup:orderKeyboard(item,{manager:true})});}
  async showWorkers(chatId){
    const list=this.db.listWorkers();if(!list.length)return this.safeSend(chatId,'Активных грузчиков нет.',{reply_markup:managerMenu});
    for(const worker of list){
      const geo=this.db.getRegionGeo(worker.region);
      const label=geo?.label||regionLabel(worker.region);
      const rows=[
        [
          {text:worker.verified!==1?'✅ Не верифицирован':'Не верифицирован',callback_data:`worker_status:${worker.telegram_id}:unverified`},
        ],
        [
          {text:worker.verified===1&&worker.contractor_type==='ip'?'✅ ИП':'ИП',callback_data:`worker_status:${worker.telegram_id}:ip`},
          {text:worker.verified===1&&worker.contractor_type==='self_employed'?'✅ Самозанятый':'Самозанятый',callback_data:`worker_status:${worker.telegram_id}:self_employed`},
        ],
        [{text:'📍 Изменить регион / город',callback_data:`worker_region_custom:${worker.telegram_id}`}],
        [{text:'⚙️ Персональные настройки',callback_data:`worker_settings:${worker.telegram_id}`}],
      ];
      await this.safeSend(chatId,workerProfileText({...worker,region:label}),{reply_markup:inline(rows)});
    }
  }
  async showWorkerSettings(chatId,workerId,notice=''){
    const worker=this.db.getUser(workerId);if(!worker)return this.safeSend(chatId,'Грузчик не найден.',{reply_markup:managerMenu});
    const rows=[
      [
        {text:'🕒 Изменить частоту',callback_data:`worker_setting_input:${worker.telegram_id}:frequency`},
        {text:'🔥 Изменить шанс',callback_data:`worker_setting_input:${worker.telegram_id}:urgent`},
      ],
      [{text:`➕ Создание заказов: ${worker.can_create_orders===1?'ВКЛ':'ВЫКЛ'}`,callback_data:`worker_setting_toggle:${worker.telegram_id}:create`}],
      [{text:`🛠 Техработы: ${worker.maintenance_mode===1?'ВКЛ':'ВЫКЛ'}`,callback_data:`worker_setting_toggle:${worker.telegram_id}:maintenance`}],
      [
        {text:`📝 Логирование: ${worker.action_logging===1?'ВКЛ':'ВЫКЛ'}`,callback_data:`worker_setting_toggle:${worker.telegram_id}:logging`},
        {text:'📋 Последние действия',callback_data:`worker_logs:${worker.telegram_id}`},
      ],
    ];
    return this.safeSend(chatId,`${notice?e(notice)+'\n\n':''}${workerSettingsText(worker)}`,{reply_markup:inline(rows)});
  }

  async showWorkerLogs(chatId,workerId){
    const worker=this.db.getUser(workerId);if(!worker)return this.safeSend(chatId,'Грузчик не найден.',{reply_markup:managerMenu});
    return this.safeSend(chatId,workerLogsText(worker,this.db.listWorkerActionLogs(workerId,25)),{reply_markup:inline([[{text:'⚙️ К настройкам',callback_data:`worker_settings:${worker.telegram_id}`}]])});
  }

  async showAccess(chatId){
    const access=this.db.listPendingAccess(),verification=this.db.listPendingVerifications();
    if(!access.length&&!verification.length)return this.safeSend(chatId,'Новых заявок на доступ и верификацию нет.',{reply_markup:managerMenu});
    for(const item of access)await this.safeSend(chatId,accessText(item),{reply_markup:decisionKeyboard('access_decide',item.id)});
    for(const item of verification)await this.safeSend(chatId,verificationText(item),{reply_markup:decisionKeyboard('verification_decide',item.id)});
  }
  async showApplications(chatId,orderId=null){const list=orderId?this.db.listOrderApplications(orderId):this.db.listPendingApplications();if(!list.length)return this.safeSend(chatId,'Новых откликов нет.',{reply_markup:managerMenu});for(const item of list)await this.safeSend(chatId,applicationText(item),{reply_markup:decisionKeyboard('application_decide',item.id,'Назначить')});}
  async showShiftConfirmations(chatId){const list=this.db.listPendingShiftConfirmations();if(!list.length)return this.safeSend(chatId,'Смен на подтверждении нет.',{reply_markup:managerMenu});for(const item of list)await this.safeSend(chatId,`${shiftText(item)}\n\nГрузчик: ${e([item.first_name,item.last_name].filter(Boolean).join(' ')||item.username||item.user_id)}`,{reply_markup:inline([[{text:'✅ По плану',callback_data:`shift_complete:${item.id}`},{text:'✏️ Изменить',callback_data:`shift_edit:${item.id}`} ]])});}
  async showWithdrawals(chatId){const list=this.db.listPendingWithdrawals();if(!list.length)return this.safeSend(chatId,'Заявок на выплату нет.',{reply_markup:managerMenu});for(const item of list)await this.safeSend(chatId,withdrawalText(item),{reply_markup:decisionKeyboard('withdrawal_decide',item.id,'Выплачено')});}
  async showShifts(chatId,user,history){const list=this.db.listUserShifts(user.telegram_id,{history});if(!list.length)return this.menu(chatId,user,history?'История смен пока пустая.':'Назначенных смен пока нет.');for(const shift of list){let buttons=[];if(shift.status==='assigned')buttons=[[{text:'▶️ Начать смену',callback_data:`shift_start:${shift.id}`}]];if(shift.status==='in_progress')buttons=[[{text:'🏁 Завершить смену',callback_data:`shift_finish:${shift.id}`}]];await this.safeSend(chatId,shiftText(shift,{history}),{reply_markup:buttons.length?inline(buttons):this.menuFor(user)});}}

  async createWithdrawal(chatId,user,amount){const result=this.db.createWithdrawal(user.telegram_id,amount);if(result.error)return this.safeSend(chatId,`Недоступная сумма. Сейчас можно вывести ${money(result.cabinet.available)}.`);this.db.clearSession(user.telegram_id);await this.notifyManagers(withdrawalText(result.withdrawal),{reply_markup:decisionKeyboard('withdrawal_decide',result.withdrawal.id,'Выплачено')});return this.menu(chatId,user,`Заявка на ${money(amount)} отправлена менеджеру.`);}

  async sendOrderNudges(intervalMinutes=45){
    const intervalMs=Math.max(10,Number(intervalMinutes)||45)*60_000;
    const messages=[
      count=>`Братан, не зевай 😄 Сейчас доступно <b>${count}</b> заказов. Глянь, может твой уже там.`,
      count=>`Давай-давай 🔥 В списке сейчас <b>${count}</b> заказов — адреса и оплата уже внутри.`,
      count=>`Есть движ 👀 Сейчас активно <b>${count}</b> заказов. Загляни в список и выбери нормальный вариант.`,
      count=>`Эй, работа сама себя не возьмёт 😄 Сейчас <b>${count}</b> заказов. Погнали смотреть.`,
    ];
    for(const worker of this.db.listAutoOrderWorkers()){
      if(worker.order_nudges!==1||worker.maintenance_mode===1)continue;
      const last=worker.last_order_nudge_at?new Date(worker.last_order_nudge_at).getTime():0;
      if(last&&Date.now()-last<intervalMs)continue;
      const orders=this.workerOrders(worker);
      if(!orders.length)continue;
      const text=messages[Math.floor(Math.random()*messages.length)](orders.length);
      const sent=await this.safeSend(worker.telegram_id,text,{reply_markup:inline([
        [{text:'📦 Посмотреть заказы',callback_data:'orders_page:0'}],
        [{text:'🔕 Отключить рассылку',callback_data:'order_nudges_off'}],
      ])});
      if(sent)this.db.markOrderNudgeSent(worker.telegram_id);
    }
  }

  async handleCallback(query){
    const user=this.db.upsertUser(query.from),chatId=query.message?.chat?.id??query.from.id,data=query.data||'';
    await this.tg.answerCallback(query.id).catch(()=>{});
    if(this.isWorker(user)){
      this.db.logWorkerAction(user.telegram_id,'callback',{data});
      if(user.maintenance_mode===1)return this.safeSend(chatId,'🛠 <b>Сейчас идут технические работы.</b>\nБот временно недоступен. Попробуйте позже.',{reply_markup:this.menuFor(user)});
    }
    if(data==='cancel'){this.db.clearSession(user.telegram_id);return this.menu(chatId,user,'Действие отменено.');}
    if(data==='access_start')return this.beginAccess(chatId,user);
    if(data==='order_nudges_off'&&this.isWorker(user)){
      const updated=this.db.setOrderNudges(user.telegram_id,false);
      const text='🔕 Подгоняющую рассылку отключил. Уведомления о новых заказах остаются как были.';
      const options={reply_markup:inline([[{text:'🔔 Включить обратно',callback_data:'order_nudges_on'}]])};
      if(query.message?.message_id){try{return await this.tg.editMessage(chatId,query.message.message_id,text,options);}catch{}}
      return this.safeSend(chatId,text,options);
    }
    if(data==='order_nudges_on'&&this.isWorker(user)){
      this.db.setOrderNudges(user.telegram_id,true);
      const text='🔔 Подгоняющая рассылка снова включена.';
      const options={reply_markup:inline([[{text:'📦 Посмотреть заказы',callback_data:'orders_page:0'}],[{text:'🔕 Отключить рассылку',callback_data:'order_nudges_off'}]])};
      if(query.message?.message_id){try{return await this.tg.editMessage(chatId,query.message.message_id,text,options);}catch{}}
      return this.safeSend(chatId,text,options);
    }
    if(data==='orders_noop')return;
    let match=data.match(/^orders_page:(\d+)$/);if(match&&this.isWorker(user)){
      return this.showOrders(chatId,user,{page:Number(match[1]),messageId:query.message?.message_id||null});
    }
    match=data.match(/^order_view:(\d+):(\d+)$/);if(match&&this.isWorker(user)){
      return this.showOrderDetails(chatId,user,Number(match[1]),{page:Number(match[2]),messageId:query.message?.message_id||null});
    }
    match=data.match(/^order_type:(normal|urgent)$/);if(match&&(this.isManager(user)||this.canCreateOrder(user))){
      const session=this.db.getSession(user.telegram_id);if(!session||session.flow!=='order'||session.step!=='type')return this.menu(chatId,user,'Черновик не найден. Создайте заказ заново.');
      this.db.setSession(user.telegram_id,'order','title',{urgent:match[1]==='urgent'});
      return this.safeSend(chatId,`Тип: <b>${match[1]==='urgent'?'🔥 Срочный':'Обычный'}</b>.\nВведите короткое название заказа. Например: «Разгрузка фуры».`,{reply_markup:removeKeyboard()});
    }
    if(data==='order_publish'&&(this.isManager(user)||this.canCreateOrder(user))){
      const session=this.db.getSession(user.telegram_id);if(!session||session.flow!=='order'||session.step!=='confirm')return this.menu(chatId,user,'Черновик не найден. Создайте заказ заново.');
      let region=regionKeyByCity(session.data.city),label=session.data.city;if(this.addressProvider){const geo=await this.addressProvider.resolveRegion(session.data.city);if(geo){region=geo.region_key;label=geo.label;}}const payload={...session.data,region,city:label};let order=this.db.createOrder(payload,user.telegram_id);if(this.addressProvider){const point=await this.addressProvider.geocodeAddress(session.data.address,session.data.city);if(point)order=this.db.updateOrderLocation(order.id,point);}this.db.clearSession(user.telegram_id);await this.broadcastRegionOrder(order);return this.menu(chatId,user,`Заказ №${order.id} опубликован и разослан грузчикам ${order.region?'региона '+e(label):'по доступной базе'}.`);
    }
    match=data.match(/^access_decide:(\d+):(approve|decline)$/);if(match&&this.isManager(user)){
      const result=this.db.decideAccess(Number(match[1]),user.telegram_id,match[2]==='approve');if(!result)return this.safeSend(chatId,'Заявка уже обработана.');
      if(match[2]==='approve'){
        await this.safeSend(result.user_id,'<b>✅ Доступ к боту выдан.</b>\nТеперь вы можете смотреть активные заказы. Чтобы откликаться на них, запросите верификацию у менеджера.',{reply_markup:unverifiedWorkerMenu});
        return this.safeSend(chatId,`Заявка №${result.id}: доступ к боту выдан.`);
      }
      await this.safeSend(result.user_id,'Заявка на доступ к боту отклонена. Уточнить причину можно у @AleshaPopovichManager',{reply_markup:removeKeyboard()});
      return this.safeSend(chatId,`Заявка №${result.id}: отклонена.`);
    }
    match=data.match(/^verification_decide:(\d+):(approve|decline)$/);if(match&&this.isManager(user)){
      const request=this.db.getVerificationRequest(Number(match[1]));if(!request||request.status!=='pending')return this.safeSend(chatId,'Заявка уже обработана.');
      if(match[2]==='decline'){const result=this.db.declineVerification(request.id,user.telegram_id);if(!result)return this.safeSend(chatId,'Заявка уже обработана.');await this.safeSend(result.user_id,'Заявка на верификацию отклонена. Вы по-прежнему можете смотреть заказы.',{reply_markup:unverifiedWorkerMenu});return this.safeSend(chatId,`Верификация №${result.id}: отклонена.`);}
      return this.safeSend(chatId,'Выберите тип занятости грузчика:',{reply_markup:inline([[
        {text:'ИП',callback_data:`verification_type:${request.id}:ip`},
        {text:'Самозанятый',callback_data:`verification_type:${request.id}:self_employed`},
      ]])});
    }
    match=data.match(/^verification_type:(\d+):(ip|self_employed)$/);if(match&&this.isManager(user)){
      const request=this.db.getVerificationRequest(Number(match[1]));if(!request||request.status!=='pending')return this.safeSend(chatId,'Заявка уже обработана.');
      this.db.setSession(user.telegram_id,'access_verify_region','input',{requestId:request.id,contractorType:match[2]});
      return this.safeSend(chatId,`Тип занятости: <b>${match[2]==='ip'?'ИП':'Самозанятый'}</b>.\nТеперь введите регион или город, который нужно назначить грузчику. Например: «Самара», «Краснодарский край», «Республика Татарстан».`,{reply_markup:removeKeyboard()});
    }
    match=data.match(/^worker_settings:(\d+)$/);if(match&&this.isManager(user))return this.showWorkerSettings(chatId,match[1]);
    match=data.match(/^worker_setting_input:(\d+):(frequency|urgent)$/);if(match&&this.isManager(user)){
      const worker=this.db.getUser(match[1]);if(!worker)return this.safeSend(chatId,'Грузчик не найден.');
      this.db.setSession(user.telegram_id,'worker_setting',match[2],{workerId:worker.telegram_id});
      const prompt=match[2]==='frequency'
        ?'Введите частоту: сколько новых автозаказов в среднем показывать этому грузчику в час (0–60).'
        :'Введите шанс срочного заказа в процентах (0–90).';
      return this.safeSend(chatId,prompt,{reply_markup:removeKeyboard()});
    }
    match=data.match(/^worker_setting_toggle:(\d+):(create|maintenance|logging)$/);if(match&&this.isManager(user)){
      const worker=this.db.getUser(match[1]);if(!worker)return this.safeSend(chatId,'Грузчик не найден.');
      const kind=match[2],changes=kind==='create'?{canCreateOrders:worker.can_create_orders!==1}:kind==='maintenance'?{maintenanceMode:worker.maintenance_mode!==1}:{actionLogging:worker.action_logging!==1};
      const updated=this.db.updateWorkerSettings(worker.telegram_id,changes);
      if((kind==='maintenance'&&updated?.maintenance_mode===1)||(kind==='create'&&updated?.can_create_orders!==1))this.db.clearSession(worker.telegram_id);
      if(kind==='create')await this.safeSend(worker.telegram_id,updated.can_create_orders===1?'➕ Менеджер разрешил вам создавать заказы. Кнопка появилась в меню.':'➕ Менеджер отключил для вас создание заказов.',{reply_markup:this.menuFor(updated)});
      if(kind==='maintenance')await this.safeSend(worker.telegram_id,updated.maintenance_mode===1?'🛠 Для вашего аккаунта включён режим технических работ.':'✅ Технические работы завершены, бот снова доступен.',{reply_markup:this.menuFor(updated)});
      return this.showWorkerSettings(chatId,worker.telegram_id);
    }
    match=data.match(/^worker_logs:(\d+)$/);if(match&&this.isManager(user))return this.showWorkerLogs(chatId,match[1]);
    match=data.match(/^worker_region_custom:(\d+)$/);if(match&&this.isManager(user)){const worker=this.db.getUser(match[1]);if(!worker)return this.safeSend(chatId,'Грузчик не найден.');this.db.setSession(user.telegram_id,'worker_region','input',{workerId:worker.telegram_id});return this.safeSend(chatId,`Введите любой город, область, край или республику России для ${e(worker.first_name||worker.username||worker.telegram_id)}. Например: «Самара», «Краснодарский край», «Республика Татарстан».`,{reply_markup:removeKeyboard()});}
    match=data.match(/^worker_status:(\d+):(unverified|ip|self_employed)$/);if(match&&this.isManager(user)){
      const status=match[2];
      const worker=status==='unverified'
        ?this.db.updateWorkerProfile(match[1],{verified:false})
        :this.db.updateWorkerProfile(match[1],{contractorType:status,verified:true});
      if(!worker)return this.safeSend(chatId,'Грузчик не найден.');
      const label=status==='unverified'?'Не верифицирован':(status==='ip'?'ИП':'Самозанятый');
      await this.safeSend(worker.telegram_id,`Ваш статус изменён менеджером: <b>${label}</b>.`,{reply_markup:this.menuFor(worker)});
      return this.safeSend(chatId,`${worker.first_name||worker.username||worker.telegram_id}: статус — <b>${label}</b>.`);
    }
    match=data.match(/^worker_region:(\d+):([a-z_]+)$/);if(match&&this.isManager(user)){if(!REGIONS[match[2]])return this.safeSend(chatId,'Неизвестный регион.');const worker=this.db.updateWorkerProfile(match[1],{region:match[2]});return this.safeSend(chatId,worker?`${worker.first_name||worker.username||worker.telegram_id}: регион — ${regionLabel(worker.region)}.`:'Грузчик не найден.');}
    match=data.match(/^order_apply:(\d+)$/);if(match&&this.isWorker(user)){
      const result=this.db.applyToOrder(Number(match[1]),user.telegram_id);const messages={closed:'Заказ уже закрыт или набран.',access:'⛔ Откликаться на заказы можно только после верификации у менеджера.',duplicate:'Вы уже откликались на этот заказ.'};if(result.error)return this.safeSend(chatId,messages[result.error],{reply_markup:this.menuFor(user)});
      await this.notifyManagers(applicationText(result.application),{reply_markup:decisionKeyboard('application_decide',result.application.id,'Назначить')});return this.safeSend(chatId,'Отклик отправлен. После назначения точный адрес появится в ваших сменах.');
    }
    match=data.match(/^application_withdraw:(\d+)$/);if(match&&this.isWorker(user)){const result=this.db.withdrawApplication(Number(match[1]),user.telegram_id);return this.safeSend(chatId,result?'Отклик отозван.':'Отклик уже обработан.');}
    match=data.match(/^application_decide:(\d+):(approve|decline)$/);if(match&&this.isManager(user)){
      const result=this.db.decideApplication(Number(match[1]),user.telegram_id,match[2]==='approve');if(!result)return this.safeSend(chatId,'Отклик уже обработан.');if(result.error==='full')return this.safeSend(chatId,'Все места уже заняты или заказ закрыт.');if(result.error==='access')return this.safeSend(chatId,'Нельзя назначить грузчика: он не верифицирован или у него не назначен регион.');
      const targetWorker=this.db.getUser(result.user_id);
      if(match[2]==='approve'){await this.safeSend(result.user_id,`<b>Вы назначены на заказ!</b>\n${shiftText(result.shift)}`,{reply_markup:this.menuFor(targetWorker)});await this.refreshOrderMessages(result.order_id);}else await this.safeSend(result.user_id,`Отклик на «${e(result.title)}» отклонён. Посмотрите другие активные заказы.`,{reply_markup:this.menuFor(targetWorker)});return this.safeSend(chatId,`Отклик №${result.id} обработан.`);
    }
    match=data.match(/^order_apps:(\d+)$/);if(match&&this.isManager(user))return this.showApplications(chatId,Number(match[1]));
    match=data.match(/^order_status:(\d+):(closed|cancelled)$/);if(match&&this.isManager(user)){
      const orderId=Number(match[1]),assigned=match[2]==='cancelled'?this.db.listOrderShifts(orderId):[];const order=this.db.setOrderStatus(orderId,match[2],user.telegram_id);
      if(order&&match[2]==='cancelled')for(const shift of assigned){const targetWorker=this.db.getUser(shift.user_id);await this.safeSend(shift.user_id,`<b>Смена отменена менеджером</b>\n${shiftText({...shift,status:'cancelled'})}`,{reply_markup:this.menuFor(targetWorker)});}
      return this.safeSend(chatId,order?`Заказ №${order.id}: ${match[2]==='closed'?'закрыт':'отменён'}.`:'Заказ не найден.');
    }
    match=data.match(/^shift_start:(\d+)$/);if(match&&this.isWorker(user)){const shift=this.db.startShift(Number(match[1]),user.telegram_id);return this.safeSend(chatId,shift?'Смена начата. После работы нажмите «Завершить смену» в разделе «Мои смены».':'Не удалось начать смену. Проверьте её статус.');}
    match=data.match(/^shift_finish:(\d+)$/);if(match&&this.isWorker(user)){const shift=this.db.finishShift(Number(match[1]),user.telegram_id);if(!shift)return this.safeSend(chatId,'Не удалось завершить смену.');await this.notifyManagers(`<b>Смена ожидает подтверждения</b>\n${shiftText(shift)}`,{reply_markup:inline([[{text:'✅ По плану',callback_data:`shift_complete:${shift.id}`},{text:'✏️ Изменить',callback_data:`shift_edit:${shift.id}`} ]])});return this.safeSend(chatId,'Смена завершена и отправлена менеджеру на подтверждение.');}
    match=data.match(/^shift_complete:(\d+)$/);if(match&&this.isManager(user)){const before=this.db.getShift(Number(match[1]));if(!before)return this.safeSend(chatId,'Смена не найдена.');const shift=this.db.completeShift(before.id,user.telegram_id,{hours:before.duration_hours,amount:before.planned_amount,notes:''});if(!shift)return this.safeSend(chatId,'Смена уже обработана.');await this.safeSend(shift.user_id,`<b>Смена подтверждена.</b> Начислено ${money(shift.amount)}.`,{reply_markup:this.menuFor(this.db.getUser(shift.user_id))});return this.safeSend(chatId,'Смена подтверждена по плану.');}
    match=data.match(/^shift_edit:(\d+)$/);if(match&&this.isManager(user)){const shift=this.db.getShift(Number(match[1]));if(!shift||shift.status!=='pending_confirmation')return this.safeSend(chatId,'Смена уже обработана.');this.db.setSession(user.telegram_id,'shift_edit','amount',{shiftId:shift.id});return this.safeSend(chatId,`Введите итоговую сумму. План: ${money(shift.planned_amount)}.`,{reply_markup:removeKeyboard()});}
    match=data.match(/^withdraw_all:(\d+)$/);if(match&&this.isWorker(user))return this.createWithdrawal(chatId,user,Number(match[1]));
    match=data.match(/^withdrawal_decide:(\d+):(approve|decline)$/);if(match&&this.isManager(user)){const item=this.db.decideWithdrawal(Number(match[1]),user.telegram_id,match[2]==='approve');if(!item)return this.safeSend(chatId,'Заявка уже обработана.');await this.safeSend(item.user_id,match[2]==='approve'?`Выплата ${money(item.amount)} отмечена как выполненная.`:`Заявка на ${money(item.amount)} отклонена. Сумма снова доступна к выводу.`,{reply_markup:this.menuFor(this.db.getUser(item.user_id))});return this.safeSend(chatId,'Статус выплаты обновлён.');}
    return this.safeSend(chatId,'Кнопка устарела. Откройте нужный раздел ещё раз.');
  }

  async sendReminders(minutes=120){const before=new Date(Date.now()+minutes*60_000).toISOString();for(const item of this.db.remindersDue(before)){const sent=await this.safeSend(item.user_id,`<b>Смена скоро начнётся</b>\n${e(item.title)} · ${e(item.city)}\nАдрес: ${e(item.address)}\nВремя: ${new Intl.DateTimeFormat('ru-RU',{dateStyle:'short',timeStyle:'short',timeZone:'Europe/Moscow'}).format(new Date(item.starts_at))}`);if(sent)this.db.markNotification('shift_reminder',item.id,item.user_id);}}
}
