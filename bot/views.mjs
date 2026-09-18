import {escapeHtml as e,formatDate,fullName,hours,inline,money,reply,short} from './utils.mjs';

export const workerMenu=reply([
  ['📦 Активные заказы','🗓 Мои смены'],
  ['💰 Личный кабинет','📜 История смен'],
  ['💸 Запросить выплату','🔔 Уведомления'],
  [{text:'📍 Обновить геопозицию',request_location:true}],
  ['🆘 Помощь'],
]);

export const workerCreatorMenu=reply([
  ['📦 Активные заказы','🗓 Мои смены'],
  ['➕ Создать заказ'],
  ['💰 Личный кабинет','📜 История смен'],
  ['💸 Запросить выплату','🔔 Уведомления'],
  [{text:'📍 Обновить геопозицию',request_location:true}],
  ['🆘 Помощь'],
]);

export const unverifiedWorkerMenu=reply([
  ['📦 Активные заказы'],
  ['💰 Личный кабинет'],
  ['🔑 Запросить верификацию'],
  ['🆘 Помощь'],
]);

const verificationStatus=user=>user?.status==='active'&&user?.verified===1
  ?(user.contractor_type==='ip'?'ИП':'Самозанятый')
  :'Не верифицирован';

export function verificationText(item){return [
  `<b>🪪 Запрос верификации №${item.id}</b>`,
  `Грузчик: ${e(fullName(item))}${item.username?` (@${e(item.username)})`:''}`,
  item.city?`Город из анкеты доступа: ${e(item.city)}`:null,
  `Telegram ID: <code>${e(item.user_id)}</code>`,
].filter(Boolean).join('\n');}

export const managerMenu=reply([
  ['➕ Создать заказ','📋 Заказы'],
  ['🔑 Доступы','👷 Отклики'],
  ['✅ Подтвердить смены','💸 Выплаты'],
  ['👥 Грузчики','📊 Статистика'],
  ['🆘 Помощь'],
]);

export function orderText(order,{manager=false,assigned=false,worker=null,distanceKm=null}={}){
  const real=Number(order.assigned_count||0),simulated=Number(order.simulated_assigned||0);
  const occupied=real+simulated;
  const places=Math.max(0,Number(order.people_needed)-occupied);
  const contractorType=worker?.contractor_type||'self_employed';
  const selfRate=Number(order.self_employed_rate)||450;
  const ipRate=Math.max(550,Number(order.ip_rate)||550);
  const duration=Number(order.duration_hours||0);
  const selfTotal=Math.round(selfRate*duration);
  const ipTotal=Math.round(ipRate*duration);
  const workerRate=contractorType==='ip'?ipRate:selfRate;
  const workerTotal=contractorType==='ip'?ipTotal:selfTotal;
  const distance=Number.isFinite(Number(distanceKm))?` · примерно ${new Intl.NumberFormat('ru-RU',{maximumFractionDigits:1}).format(Number(distanceKm))} км от вас`:'';
  const targetName=[order.target_first_name,order.target_last_name].filter(Boolean).join(' ')||order.target_username||order.target_user_id;
  return [
    order.urgent?'<b>🔥 СРОЧНЫЙ ЗАКАЗ</b>':null,
    `<b>📦 Заказ №${order.id}: ${e(order.title)}</b>`,
    manager&&order.target_user_id?`🎯 Персональный автозаказ для: ${e(targetName)}${order.target_username?` (@${e(order.target_username)})`:''}`:null,
    `📍 ${e(order.city)}`,
    order.address?`🏠 ${e(order.address)}${distance}`:null,
    `🕒 ${formatDate(order.starts_at)}`,
    `⏱ Ориентир: ${hours(order.duration_hours)}`,
    manager?`💰 Самозанятые: ${money(selfRate)}/ч · ориентир ${money(selfTotal)}`:null,
    manager?`⭐ ИП: ${money(ipRate)}/ч · ориентир ${money(ipTotal)}`:null,
    worker?.verified===1?`${contractorType==='ip'?'⭐ ИП':'💰 Самозанятый'}: <b>${money(workerRate)}/ч</b> · ориентир выплаты <b>${money(workerTotal)}</b>`:null,
    (!worker||worker?.verified!==1)&&!manager?`💰 Самозанятый: ${money(selfRate)}/ч · ориентир ${money(selfTotal)}\n⭐ ИП: ${money(ipRate)}/ч · ориентир ${money(ipTotal)}`:null,
    `👥 Свободно мест: ${places} из ${order.people_needed}`,
    manager&&simulated?`🧪 Демо-заполнение: ${simulated}; реальных назначено: ${real}`:null,
    order.description?`\n${e(short(order.description,500))}`:null,
  ].filter(Boolean).join('\n');
}

export function orderKeyboard(order,{manager=false,applied=false,applicationId=null}={}){
  if(manager)return inline([
    [{text:'📨 Отклики',callback_data:`order_apps:${order.id}`}],
    [{text:'✅ Закрыть',callback_data:`order_status:${order.id}:closed`},{text:'⛔ Отменить',callback_data:`order_status:${order.id}:cancelled`}],
  ]);
  if(applied)return inline([[{text:'Отозвать отклик',callback_data:`application_withdraw:${applicationId}`}]]);
  return inline([[{text:'Откликнуться',callback_data:`order_apply:${order.id}`}]]);
}

export function workerProfileText(user){return [
  `<b>👷 ${e(fullName(user))}</b>`,
  user.username?`@${e(user.username)}`:null,
  `📍 Регион: ${e(user.region||'не назначен')}`,
  `💼 Статус: ${verificationStatus(user)}`,
].filter(Boolean).join('\n');}

export function workerSettingsText(user){return [
  `<b>⚙️ Настройки грузчика: ${e(fullName(user))}</b>`,
  `🕒 Частота автозаказов: <b>${new Intl.NumberFormat('ru-RU',{maximumFractionDigits:1}).format(Number(user.auto_orders_per_hour)||0)}/ч</b>`,
  `🔥 Шанс срочного заказа: <b>${Math.round((Number(user.urgent_order_chance)||0)*100)}%</b>`,
  `➕ Создание заказов: <b>${user.can_create_orders===1?'разрешено':'запрещено'}</b>`,
  `🛠 Техработы: <b>${user.maintenance_mode===1?'включены':'выключены'}</b>`,
  `📝 Логирование действий: <b>${user.action_logging===1?'включено':'выключено'}</b>`,
].join('\n');}

export function workerLogsText(user,logs){
  const label=fullName(user);
  if(!logs.length)return `<b>📝 Логи: ${e(label)}</b>\nЗаписей пока нет.`;
  const lines=logs.map(item=>{
    let details={};try{details=JSON.parse(item.details||'{}');}catch{}
    const action=item.action?.replace(/^worker\.ui\./,'')||item.action;
    const value=details.text||details.data||details.kind||'';
    return `${formatDate(item.created_at)} · <code>${e(action)}</code>${value?` · ${e(short(value,80))}`:''}`;
  });
  return [`<b>📝 Последние действия: ${e(label)}</b>`,...lines].join('\n');
}

export function applicationText(item){
  const rate=item.contractor_type==='ip'?Math.max(550,Number(item.ip_rate)||550):(Number(item.self_employed_rate)||450);
  const total=Math.round(rate*Number(item.duration_hours||0))||Number(item.amount)||0;
  return [
    `<b>👷 Отклик №${item.id}</b>`,
    `Заказ: ${e(item.title)} · ${e(item.city)}`,
    `Когда: ${formatDate(item.starts_at)}`,
    `Грузчик: ${e(fullName(item))}${item.username?` (@${e(item.username)})`:''}`,
    `Статус: ${item.contractor_type==='ip'?'ИП':'Самозанятый'}`,
    `Ориентир выплаты: ${money(total)} (${money(rate)}/ч)`,
  ].filter(Boolean).join('\n');
}

export function accessText(item){return [
  `<b>🔑 Запрос доступа №${item.id}</b>`,
  `Имя: ${e(item.name)}`,
  item.city?`Город: ${e(item.city)}`:null,
  item.experience?`Опыт: ${e(short(item.experience,500))}`:null,
  item.username?`Telegram: @${e(item.username)}`:`Telegram ID: <code>${e(item.user_id)}</code>`,
].filter(Boolean).join('\n');}

export function shiftText(shift,{history=false}={}){return [
  `<b>${history?'📜':'🗓'} Смена №${shift.id}: ${e(shift.title)}</b>`,
  `📍 ${e(shift.city)}`,
  `🏠 ${e(shift.address)}`,
  `🕒 ${formatDate(shift.starts_at)}`,
  `Статус: ${shiftStatus(shift.status)}`,
  shift.hours!=null?`Часы: ${hours(shift.hours)}`:`Ориентир: ${hours(shift.duration_hours)}`,
  `Сумма: ${money(shift.amount??shift.planned_amount)}`,
  shift.notes?`Комментарий: ${e(shift.notes)}`:null,
].filter(Boolean).join('\n');}

export function shiftStatus(status){return ({assigned:'назначена',in_progress:'идёт сейчас',pending_confirmation:'ожидает подтверждения',completed:'завершена',cancelled:'отменена'})[status]||status;}

export function cabinetText(user,cabinet){return [
  `<b>💰 Личный кабинет</b>`,
  `${e(fullName(user))}${user.city?` · ${e(user.city)}`:''}`,
  `🪪 Статус: <b>${verificationStatus(user)}</b>`,
  user.region?`📍 Регион: ${e(user.region)}`:null,
  user.verified!==1?'⚠️ Заказы можно просматривать, но откликаться на них можно только после верификации у менеджера.':null,
  '',
  `✅ Выполнено смен: <b>${cabinet.shifts}</b>`,
  `⏱ Отработано: <b>${hours(cabinet.hours)}</b>`,
  `📈 Заработано: <b>${money(cabinet.earned)}</b>`,
  `💳 Выплачено: <b>${money(cabinet.paid)}</b>`,
  cabinet.pending?`🕓 Запрошено к выплате: <b>${money(cabinet.pending)}</b>`:null,
  `💸 Доступно к выводу: <b>${money(cabinet.available)}</b>`,
  cabinet.upcoming?`\n🗓 Предстоящих смен: ${cabinet.upcoming}`:null,
].filter(value=>value!==null).join('\n');}

export function withdrawalText(item){return [
  `<b>💸 Запрос выплаты №${item.id}</b>`,
  `Грузчик: ${e(fullName(item))}${item.username?` (@${e(item.username)})`:''}`,
  `Сумма: <b>${money(item.amount)}</b>`,
].filter(Boolean).join('\n');}

export function statsText(stats){return [
  '<b>📊 Сводка</b>',
  `Активных грузчиков: ${stats.workers}`,
  `Активных заказов: ${stats.activeOrders}`,
  `Запросов доступа: ${stats.pendingAccess}`,
  `Запросов верификации: ${stats.pendingVerification}`,
  `Новых откликов: ${stats.pendingApplications}`,
  `Смен на подтверждении: ${stats.pendingShifts}`,
  `Выплат на подтверждении: ${stats.pendingWithdrawals}`,
  `Всего выплачено: ${money(stats.paidTotal)}`,
].join('\n');}
