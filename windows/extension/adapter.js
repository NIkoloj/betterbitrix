  // This runs in the portal page. Credentials and CSRF tokens never leave it.
  // No extra DOM panel is mounted and no browser release source is modified.
  function refresh() {}
  let desktopCalendarContext=null;
  function desktopState() {
    const uid=identity();
    if(!uid) return {protocol:1,uid:null,observedAt:Date.now(),status:'Войдите в Bitrix в браузере.'};
    const state=timerState(uid), task=selected(), profile=profileFor(uid);
    const unresolved=pending(uid), today=journal(uid)[workDay(new Date(),uid)];
    const arm=read('arm'), active=arm?.userId===uid && arm.until>Date.now();
    const submitting=['submitting','pending'].includes(state?.status);
    const blocked=busy || desktopBusy || !!unresolved || !!active || submitting;
    const learned=read('learnMessage');
    const calendarDate=desktopCalendarContext?.zone ? day(new Date(),desktopCalendarContext.zone) : desktopCalendarContext ? new Date(Date.now()+desktopCalendarContext.offsetSeconds*1000).toISOString().slice(0,10) : '';
    const calendarFresh=!!calendarDate && meetingsState.key?.startsWith(`${uid}:${calendarDate}:`);
    const safeTask=value=>value ? {id:Number(value.id),title:String(value.title || '').slice(0,180)} : null;
    return {
      protocol:1,uid,observedAt:Date.now(),
      timer:state ? {status:state.status,startedAt:state.startedAt,accumulatedMs:state.accumulatedMs,task:safeTask(state.task),date:state.date} : null,
      selected:safeTask(task),tasks:(read(keyFor('tasks',uid)) || []).slice(-300).map(safeTask),
      dailyUrl:safeCallUrl(read(keyFor('dailyUrl',uid)) || '') || '',
      timeZone:read(keyFor('timeZone',uid)) || 'auto',resolvedTimeZone:timeZoneFor(uid),
      showAllMeetings:showAllMeetings(uid),dayDone:today?.status==='done',pending:!!unresolved,
      canPrimary:!blocked && (!!state || (!!profile && !!task && today?.status!=='done')),
      canPause:!blocked && ['running','paused'].includes(state?.status),
      canQuickAdd:!blocked && !state && !!profile && !!task && today?.status!=='done',
      canConfigure:!blocked && !state && !!task && today?.status!=='done',
      canChangeTask:!blocked && !state,
      canChangeTimeZone:!blocked && !state && today?.status!=='done',
      configuring:!!active,canCancel:!!active && !arm.claimed,
      status:learned?.uid===uid ? learned.text : message || (unresolved ? 'Проверьте результат записи в задаче.' : active ? `Сохраните 8 часов через форму Bitrix с комментарием «${MARKER}».` : !profile ? 'Выберите задачу и настройте Bitrix.' : !task ? 'Выберите задачу.' : ''),
      meetings:calendarFresh ? meetingsState.items.filter(item=>item.url || showAllMeetings(uid)).map(item=>({title:item.name,time:item.time,url:item.url || '',provider:item.provider})) : [],
      meetingsDate:calendarFresh ? calendarDate : '',meetingsTimeZone:desktopCalendarContext?.zone || '',meetingsOffsetSeconds:desktopCalendarContext?.offsetSeconds ?? null,
      meetingsStatus:calendarFresh ? meetingsState.status : meetingsState.status==='error' ? 'error' : 'idle',meetingsError:meetingsState.error || ''
    };
  }
  let desktopBusy=false;
  async function desktopExecute(command,params={},expectedUid=null) {
    if(command==='state') return desktopState();
    const before=desktopState();
    if(!before.uid || expectedUid!==before.uid) throw Error('Пользователь Bitrix изменился. Обновите подключение.');
    if(desktopBusy) throw Error('Предыдущая команда ещё выполняется.');
    desktopBusy=true;
    try {
      const requireAllowed=flag=>{if(!before[flag]) throw Error('Действие сейчас недоступно. Обновите состояние.');};
      switch(command) {
        case 'start': requireAllowed('canPrimary');if(before.timer) throw Error('Таймер уже запущен.');await startWorkDay();break;
        case 'finish': requireAllowed('canPrimary');if(!before.timer) throw Error('Таймер не запущен.');await finishWorkDay();break;
        case 'pause': requireAllowed('canPause');await togglePause();break;
        case 'quickAdd': requireAllowed('canQuickAdd');await addDay(28800);break;
        case 'meetings': await loadMeetings(true);break;
        case 'discover': discover();break;
        case 'currentTask': {
          requireAllowed('canChangeTask');const task=currentTask();
          if(!task) throw Error('Откройте карточку задачи в подключённой вкладке Bitrix.');
          write(keyFor('selected'),task);discover();break;
        }
        case 'selectTask': {
          requireAllowed('canChangeTask');
          const task=(read(keyFor('tasks')) || []).find(item=>item.id===params.taskId);
          if(!task) throw Error('Задача не найдена. Обновите список из страницы Bitrix.');
          write(keyFor('selected'),task);break;
        }
        case 'settings': {
          const entered=String(params.dailyUrl || '').trim();
          const daily=entered ? safeCallUrl(entered) : '';
          if(entered && !daily) throw Error('Нужна HTTPS-ссылка Zoom или Teams.');
          const zone=String(params.timeZone || 'auto');
          if(zone!=='auto' && !validTimeZone(zone)) throw Error('Некорректный часовой пояс.');
          if(zone!==before.timeZone) requireAllowed('canChangeTimeZone');
          write(keyFor('dailyUrl'),daily);write(keyFor('showAllMeetings'),params.showAllMeetings===true);
          if(zone!==before.timeZone) write(keyFor('timeZone'),zone);
          note('Настройки сохранены.');break;
        }
        case 'configure': requireAllowed('canConfigure');await armLearning();break;
        case 'cancel': {
          requireAllowed('canCancel');const arm=read('arm');
          if(arm?.userId===identity() && !arm.claimed) remove('arm');break;
        }
        case 'resolve': {
          if(!before.pending || typeof params.exists!=='boolean' || params.verified!==true) throw Error('Сначала проверьте журнал времени в Bitrix.');
          // Confirmation is shown in the Windows window; no suppressed browser dialog.
          await exclusive(before.uid,async()=>{
            const item=pending(before.uid);if(!item) return;
            const records=journal(before.uid);
            if(params.exists) records[item[0]]={...item[1],status:'done',verifiedManually:true};
            else delete records[item[0]];
            write(keyFor('journal'),records);
            const state=timerState();
            if(state && state.date===item[0] && state.task?.id===item[1].taskId) {
              if(params.exists) remove(keyFor('workTimer'));
              else {state.status='paused';state.startedAt=null;write(keyFor('workTimer'),state);}
            }
            remove('learnMessage');note('Результат отмечен после ручной проверки.');
          });break;
        }
        default: throw Error('Неизвестная команда.');
      }
      return desktopState();
    } finally {desktopBusy=false;}
  }
  Object.defineProperty(window,'__betterBitrixDesktop',{value:Object.freeze({execute:desktopExecute}),configurable:false});
})();
