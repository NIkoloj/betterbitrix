using System.Drawing;
using System.Runtime.InteropServices;
using Microsoft.Win32;
using Forms = System.Windows.Forms;

namespace BetterBitrix;

// Shell notifications with stable GUIDs preserve user-selected visibility across starts.
// No window is drawn over the taskbar and no Explorer internals are modified.
public sealed class TrayController : Forms.NativeWindow, IDisposable
{
    private const int Callback = 0x8001;
    private static readonly uint ExplorerStarted = RegisterWindowMessage("TaskbarCreated");
    private static readonly Guid[] Identities = [
        new("b927405d-2a6d-4c16-ae33-4b776144a010"), new("b927405d-2a6d-4c16-ae33-4b776144a011"),
        new("b927405d-2a6d-4c16-ae33-4b776144a012"), new("b927405d-2a6d-4c16-ae33-4b776144a013"),
        new("b927405d-2a6d-4c16-ae33-4b776144a014")
    ];
    private sealed class Entry { public Icon? Icon;public string Key="";public bool Added; }
    private readonly Entry[] entries = Enumerable.Range(0,5).Select(_=>new Entry()).ToArray();
    private readonly App app;
    private Forms.ContextMenuStrip? menu;
    private bool disposed;
    public int RegisteredIconCount => entries.Count(entry=>entry.Added);
    public TrayController(App app)
    {
        this.app=app;
        CreateHandle(new Forms.CreateParams { Caption="BetterBitrix.TrayEvents" });
        Update();
    }
    private static bool LightTheme()
    {
        using var key=Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize");
        return key?.GetValue("SystemUsesLightTheme") is int value && value!=0;
    }
    public void Update()
    {
        if(disposed) return;
        var state=app.Bridge.State;var online=app.Bridge.Online;var busy=app.Bridge.Busy;var light=LightTheme();
        foreach(var action in Enum.GetValues<TrayAction>())
        {
            var index=(int)action;var entry=entries[index];
            var visible=action==TrayAction.Timer || app.Settings.TrayButtons;
            if(!visible) {Remove(index);continue;}
            var tip=Tooltip(action,state,online,busy);
            var clock=state?.Timer?.Clock ?? "00:00:00";
            var key=$"{light}:{online}:{busy}:{state?.Timer?.Status}:{clock[..clock.LastIndexOf(':')]}:{state?.DayDone}:{state?.Pending}:{state?.MeetingsStatus}:{state?.Meetings.Count}:{state?.MeetingsCurrent}";
            if(entry.Icon is null || entry.Key!=key)
            {
                var icon=TrayArtwork.Create(action,state,online,busy,light);
                var previous=entry.Icon;entry.Icon=icon;entry.Key=key;
                Apply(index,tip);previous?.Dispose();
            }
            else Apply(index,tip);
        }
    }
    public static string Tooltip(TrayAction action, PortalState? state, bool online, bool busy) => action switch
    {
        TrayAction.Timer => $"BetterBitrix · {state?.Timer?.Clock ?? "00:00:00"}\n{(!online ? "Браузер закрыт · таймер сохранён" : state?.DayDone==true ? "Рабочий день записан" : "Часы сверху, минуты снизу · открыть таймер")}",
        TrayAction.Pause => !online ? "BetterBitrix · нет связи" : busy ? "BetterBitrix · выполняется команда" : state?.Timer?.Status=="running" ? "BetterBitrix · пауза" : state?.Timer?.Status=="paused" ? "BetterBitrix · продолжить" : "BetterBitrix · начать рабочий день",
        TrayAction.Calls => $"BetterBitrix · созвоны сегодня{((online || state?.MeetingsCurrent==true) && state?.MeetingsStatus=="ready" ? $": {state.Meetings.Count}" : "")}{(!online && state?.MeetingsCurrent==true ? " · сохранённый список" : "")}",
        TrayAction.Daily => "BetterBitrix · открыть дейлик",
        _ => "BetterBitrix · настройки"
    };
    private void Apply(int index,string tip)
    {
        var entry=entries[index];var data=Data(index);
        data.Flags=0x01|0x02|0x04|0x20|0x80;data.Icon=entry.Icon!.Handle;data.Tip=tip[..Math.Min(tip.Length,127)];
        if(entry.Added && ShellNotifyIcon(1,ref data)) return;
        entry.Added=ShellNotifyIcon(0,ref data);
        if(entry.Added) {data.Version=4;ShellNotifyIcon(4,ref data);}
    }
    private void Remove(int index)
    {
        var entry=entries[index];if(entry.Added){var data=Data(index);ShellNotifyIcon(2,ref data);entry.Added=false;}
        entry.Icon?.Dispose();entry.Icon=null;entry.Key="";
    }
    private NotifyData Data(int index) => new()
    {
        Size=(uint)Marshal.SizeOf<NotifyData>(),Window=Handle,Id=(uint)index+1,Flags=0x20,
        CallbackMessage=Callback,Identity=Identities[index],Tip="",Info="",InfoTitle=""
    };
    protected override void WndProc(ref Forms.Message message)
    {
        if(message.Msg==ExplorerStarted) {foreach(var entry in entries)entry.Added=false;Update();}
        if(message.Msg==Callback)
        {
            var packed=(long)message.LParam;var id=(int)((packed>>16)&0xffff)-1;var notification=(int)(packed&0xffff);
            if(id>=0 && id<entries.Length)
            {
                if(notification is 0x400 or 0x401) app.Dispatcher.InvokeAsync(()=>Activate((TrayAction)id));
                if(notification==0x7b) ShowMenu();
            }
        }
        base.WndProc(ref message);
    }
    private void Activate(TrayAction action)
    {
        switch(action)
        {
            case TrayAction.Timer:app.ShowPanel();break;
            case TrayAction.Pause:app.QuickTimerAction();break;
            case TrayAction.Calls:app.ShowMeetings();break;
            case TrayAction.Daily:app.OpenDaily();break;
            case TrayAction.Settings:app.ShowSettings();break;
        }
    }
    private void ShowMenu()
    {
        menu?.Dispose();menu=new Forms.ContextMenuStrip();
        menu.Items.Add("Рабочий день",null,(_,_)=>app.ShowPanel());
        menu.Items.Add("Созвоны сегодня",null,(_,_)=>app.ShowMeetings());
        menu.Items.Add("Дейлик",null,(_,_)=>app.OpenDaily());
        menu.Items.Add("Настройки",null,(_,_)=>app.ShowSettings());
        menu.Items.Add(new Forms.ToolStripSeparator());
        menu.Items.Add("Выход",null,(_,_)=>app.Shutdown());
        SetForegroundWindow(Handle);menu.Show(Forms.Cursor.Position);
        menu.Closed+=(_,_)=>{var data=Data(0);ShellNotifyIcon(3,ref data);};
    }
    public void Dispose()
    {
        disposed=true;for(var i=0;i<entries.Length;i++)Remove(i);menu?.Dispose();DestroyHandle();
    }
    [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)]
    private struct NotifyData
    {
        public uint Size;public IntPtr Window;public uint Id;public uint Flags;public uint CallbackMessage;public IntPtr Icon;
        [MarshalAs(UnmanagedType.ByValTStr,SizeConst=128)] public string Tip;
        public uint State;public uint StateMask;
        [MarshalAs(UnmanagedType.ByValTStr,SizeConst=256)] public string Info;
        public uint Version;
        [MarshalAs(UnmanagedType.ByValTStr,SizeConst=64)] public string InfoTitle;
        public uint InfoFlags;public Guid Identity;public IntPtr BalloonIcon;
    }
    [DllImport("shell32.dll",EntryPoint="Shell_NotifyIconW",CharSet=CharSet.Unicode)] private static extern bool ShellNotifyIcon(uint action,ref NotifyData data);
    [DllImport("user32.dll",CharSet=CharSet.Unicode)] private static extern uint RegisterWindowMessage(string message);
    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr window);
}
