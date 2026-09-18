import {escapeHtml as e,formatDate,fullName,hours,inline,money,reply,short} from './utils.mjs';

export const workerMenu=reply([
  ['📦 Активные заказы','🗓 Мои смены'],
  ['💰 Личный кабинет','📜 История смен'],
  ['💸 Запросить выплату','🔔 Уведомления'],
  ['🆘 Помощь'],
]);

export const managerMenu=reply([
  ['➕ Создать заказ','📋 Заказы'],
  ['🔑 Доступы','👷 Отклики'],
  ['✅ Подтвердить смены','💸 Выплаты'],
  ['👥 Грузчики','📊 Статистика'],
  ['🆘 Помощь'],
]);

export function orderText(order,{manager=false,assigned=false,worker=null}={}){
  const real=Number(order.assigned_count||0),simulated=Number(order.simulated_assigned||0);
  const occupied=real+simulated;
  const places=Math.max(0,Number(order.people_needed)-occupied);
  const contractorType=worker?.contractor_type||'self_employed';
  const selfRate=Number(order.self_employed_rate)||450;
  const ipRate=Math.max(550,Number(order.ip_rate)||550);
  const workerRate=contractorType==='ip'?ipRate:selfRate;
  const workerTotal=Math.round(workerRate*Number(order.duration_hours||0));
  const ipBonus=Math.max(0,ipRate-selfRate);
  return [
    order.urgent?'<b>🔥 СРОЧНЫЙ ЗАКАЗ</b>':null,
    order.generated?'<i>🤖 Автосформированный заказ</i>':null,
    `<b>📦 Заказ №${order.id}: ${e(order.title)}</b>`,
    `📍 ${e(order.city)}`,
    assigned||manager?`🏠 ${e(order.address)}`:null,
    `🕒 ${formatDate(order.starts_at)}`,
    `⏱ Ориентир: ${hours(order.duration_hours)}`,
    manager?`💰 Самозанятые: ${money(selfRate)}/ч`:null,
    manager?`⭐ ИП: ${money(ipRate)}/ч`:null,
    worker?`${contractorType==='ip'?'⭐ ИП':'💰 Самозанятый'}: <b>${money(workerRate)}/ч</b> · ориентир ${money(workerTotal)}`:null,
    worker&&contractorType!=='ip'&&ipBonus>0?`💼 С ИП ставка на этом заказе выше на ${money(ipBonus)}/ч — ${money(ipRate)}/ч.`:null,
    !worker&&!manager?`💰 От ${money(selfRate)}/ч · для ИП ${money(ipRate)}/ч`:null,
    `👥 Свободно мест: ${places} из ${order.people_needed}`,
    manager&&simulated?`🧪 Демо-заполнение: ${simulated}; реальных назначено: ${real}`:null,
    order.description?`\n${e(short(order.description,500))}`:null,
    order.generated?'🗺 Геоданные: © OpenStreetMap contributors':null,
    !assigned&&!manager?'\nТочный адрес появится после назначения.':null,
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
  `💼 Статус: ${user.status==='active'?(user.contractor_type==='ip'?'ИП':'Самозанятый'):'Не верифицирован'},`
].filter(Boolean).join('\n');}

export function applicationText(item){return [
  `<b>👷 Отклик №${item.id}</b>`,
  `Заказ: ${e(item.title)} · ${e(item.city)}`,
  `Когда: ${formatDate(item.starts_at)}`,
  `Грузчик: ${e(fullName(item))}${item.username?` (@${e(item.username)})`:''}`,
  item.phone?`Телефон: ${e(item.phone)}`:null,
  `Оплата: ${money(item.amount)}`,
].filter(Boolean).join('\n');}

export function accessText(item){return [
  `<b>🔑 Запрос доступа №${item.id}</b>`,
  `Имя: ${e(item.name)}`,
  `Город: ${e(item.city)}`,
  `Телефон: ${e(item.phone)}`,
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
  `🪪 Статус: <b>${user.status==='active'?(user.contractor_type==='ip'?'ИП':'Самозанятый'):'Не верифицирован'}</b>`,
  user.region?`📍 Регион: ${e(user.region)}`:null,
  user.status!=='active'?'⚠️ Чтобы получить доступ к заказам, запросите верификацию у менеджера.':null,
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
  item.phone?`Телефон: ${e(item.phone)}`:null,
  `Сумма: <b>${money(item.amount)}</b>`,
].filter(Boolean).join('\n');}

export function statsText(stats){return [
  '<b>📊 Сводка</b>',
  `Активных грузчиков: ${stats.workers}`,
  `Активных заказов: ${stats.activeOrders}`,
  `Запросов доступа: ${stats.pendingAccess}`,
  `Новых откликов: ${stats.pendingApplications}`,
  `Смен на подтверждении: ${stats.pendingShifts}`,
  `Выплат на подтверждении: ${stats.pendingWithdrawals}`,
  `Всего выплачено: ${money(stats.paidTotal)}`,
].join('\n');}
